// CR-CRU-200 §S2/§S4 — where an open run's test stream is held, and the live
// state each batch fills. The SQL lives here; `Store` (src/store.ts) owns the
// connection and the transactions, and calls these inside them.
//
// - `run_stream_batches`: one row per appended batch — the run, the UTF-8 byte
//   offset it starts at, its text — so an append never rewrites an earlier row.
// - `run_live`: one row per open run that has streamed — the counts, the
//   runner's total, the last file, the offset up to which lines are decoded,
//   the undecodable count, whether the stream was cut, and the stream codec
//   the run's first batch fixed.
// - `run_live_failures`: the run's failures so far, in order.
import type { Database } from "bun:sqlite";
import { leafNameOf, readStreamLine, suiteNameOf } from "./codecs/crucible-events.ts";
import { failureOf, nonBlank } from "./codecs/junit.ts";
import type { RunLive, RunLiveFailure } from "./types.ts";

/** The tables a run's stream and live state are held in. */
export const RUN_STREAM_TABLES = ["run_stream_batches", "run_live", "run_live_failures"] as const;

/** Create the stream and live-state tables in their current shape (migration v21 and the base pass). */
export function createRunStreamTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_stream_batches (
      run_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (run_id, start_offset)
    );

    CREATE TABLE IF NOT EXISTS run_live (
      run_id TEXT PRIMARY KEY,
      codec TEXT NOT NULL,
      completed INTEGER NOT NULL,
      total INTEGER,
      passed INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      pending INTEGER NOT NULL,
      current_file TEXT,
      decoded_offset INTEGER NOT NULL,
      undecodable INTEGER NOT NULL,
      cut INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_live_failures (
      run_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      suite TEXT NOT NULL,
      file TEXT NOT NULL,
      message TEXT,
      type TEXT,
      PRIMARY KEY (run_id, position)
    );
  `);
}

/** What a batch did, or why it was refused; `held` is the stream's UTF-8 length either way. */
export type StreamBatchOutcome =
  | { ok: true; held: number }
  | { ok: false; refused: "codec"; codec: string; held: number }
  | { ok: false; refused: "gap" | "overlap" | "size"; held: number };

/** One batch as the stream route states it, with the bound its total is held to. */
export interface StreamBatch {
  codec: string;
  from: number;
  data: string;
  limit: number;
}

interface LiveRow {
  run_id: string;
  codec: string;
  completed: number;
  total: number | null;
  passed: number;
  failed: number;
  pending: number;
  current_file: string | null;
  decoded_offset: number;
  undecodable: number;
  cut: number;
}

interface FailureRow {
  id: string;
  name: string;
  suite: string;
  file: string;
  message: string | null;
  type: string | null;
}

function liveRow(db: Database, runId: string): LiveRow | null {
  return db.query<LiveRow, [string]>(`SELECT * FROM run_live WHERE run_id = ?`).get(runId);
}

/** The UTF-8 length of the stream the run holds: the end of its last batch. */
function heldLength(db: Database, runId: string): number {
  const last = db
    .query<{ start_offset: number; text: string }, [string]>(
      `SELECT start_offset, text FROM run_stream_batches WHERE run_id = ? ORDER BY start_offset DESC LIMIT 1`,
    )
    .get(runId);
  return last === null ? 0 : last.start_offset + Buffer.byteLength(last.text, "utf8");
}

/** The held stream's bytes from `offset` to its end. */
function heldBytesFrom(db: Database, runId: string, offset: number): Buffer {
  const rows = db
    .query<{ start_offset: number; text: string }, [string, string, number]>(
      `SELECT start_offset, text FROM run_stream_batches
        WHERE run_id = ? AND start_offset >= COALESCE(
          (SELECT MAX(start_offset) FROM run_stream_batches WHERE run_id = ? AND start_offset <= ?), 0)
        ORDER BY start_offset`,
    )
    .all(runId, runId, offset);
  if (rows.length === 0) return Buffer.alloc(0);
  const bytes = Buffer.concat(rows.map((row) => Buffer.from(row.text, "utf8")));
  return bytes.subarray(offset - rows[0]!.start_offset);
}

/** The whole stream the run holds, as text; empty when it holds none. */
export function heldStream(db: Database, runId: string): string {
  return db
    .query<{ text: string }, [string]>(`SELECT text FROM run_stream_batches WHERE run_id = ? ORDER BY start_offset`)
    .all(runId)
    .map((row) => row.text)
    .join("");
}

function createLiveRow(db: Database, runId: string, codec: string): void {
  db.query(
    `INSERT OR IGNORE INTO run_live (run_id, codec, completed, total, passed, failed, pending,
       current_file, decoded_offset, undecodable, cut)
     VALUES (?, ?, 0, NULL, 0, 0, 0, NULL, 0, 0, 0)`,
  ).run(runId, codec);
}

/**
 * §S2 — one batch appended at the byte offset it states. Called inside the
 * batch's transaction, after the run's open state was re-read. A codec
 * differing from the one the run's first batch fixed, a gap, an overlap that
 * differs from the held bytes, or a total past `limit` appends nothing; a
 * total past `limit` records that the stream was cut. An accepted batch
 * appends only the bytes past those held, and fills the live state (§S4).
 */
export function appendRunStream(db: Database, runId: string, batch: StreamBatch): StreamBatchOutcome {
  const live = liveRow(db, runId);
  const held = heldLength(db, runId);
  if (live !== null && live.codec !== batch.codec) {
    return { ok: false, refused: "codec", codec: live.codec, held };
  }
  if (batch.from > held) return { ok: false, refused: "gap", held };
  const bytes = Buffer.from(batch.data, "utf8");
  const overlap = Math.min(held - batch.from, bytes.length);
  if (overlap > 0 && !heldBytesFrom(db, runId, batch.from).subarray(0, overlap).equals(bytes.subarray(0, overlap))) {
    return { ok: false, refused: "overlap", held };
  }
  if (batch.from + bytes.length > batch.limit) {
    createLiveRow(db, runId, batch.codec);
    db.query(`UPDATE run_live SET cut = 1 WHERE run_id = ?`).run(runId);
    return { ok: false, refused: "size", held };
  }
  const tail = bytes.subarray(overlap);
  if (tail.length === 0) return { ok: true, held };
  db.query(`INSERT INTO run_stream_batches (run_id, start_offset, text) VALUES (?, ?, ?)`).run(
    runId,
    held,
    tail.toString("utf8"),
  );
  createLiveRow(db, runId, batch.codec);
  fillRunLive(db, runId);
  return { ok: true, held: held + tail.length };
}

/**
 * §S4 — the live state filled from the lines the held stream completes past
 * its decoded offset. The partial line is never decoded: it stays in the
 * batch rows and is read back from that offset on the next batch.
 */
function fillRunLive(db: Database, runId: string): void {
  const live = liveRow(db, runId);
  if (live === null) return;
  const pending = heldBytesFrom(db, runId, live.decoded_offset);
  const end = pending.lastIndexOf(0x0a);
  if (end === -1) return;
  const state = { ...live };
  let position = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM run_live_failures WHERE run_id = ?`)
    .get(runId)!.n;
  const addFailure = db.query(
    `INSERT INTO run_live_failures (run_id, position, id, name, suite, file, message, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const line of pending.subarray(0, end).toString("utf8").split("\n")) {
    const read = readStreamLine(line);
    if (read.event === "undecodable") state.undecodable += 1;
    else if (read.event === "run-start") state.total = read.total !== undefined && read.total > 0 ? read.total : null;
    else if (read.event === "test-end") {
      state.completed += 1;
      if (read.status === "pass") state.passed += 1;
      else if (read.status === "fail") state.failed += 1;
      else state.pending += 1;
      const file = nonBlank(read.file);
      if (file !== undefined) state.current_file = file;
      if (read.status !== "fail") continue;
      const name = leafNameOf(read);
      const suite = suiteNameOf(read);
      const failure = failureOf(read.failure ?? {});
      addFailure.run(
        runId,
        position,
        nonBlank(read.id) ?? `${suite}::${name}#${state.completed}`,
        name,
        suite,
        file ?? "?",
        failure.message?.split("\n")[0] ?? null,
        failure.type ?? null,
      );
      position += 1;
    }
  }
  db.query(
    `UPDATE run_live SET completed = ?, total = ?, passed = ?, failed = ?, pending = ?, current_file = ?,
       decoded_offset = ?, undecodable = ? WHERE run_id = ?`,
  ).run(
    state.completed,
    state.total,
    state.passed,
    state.failed,
    state.pending,
    state.current_file,
    live.decoded_offset + end + 1,
    state.undecodable,
    runId,
  );
}

/** §S4 — the run's live state, or null when it holds none. */
export function runLiveOf(db: Database, runId: string): RunLive | null {
  const live = liveRow(db, runId);
  if (live === null) return null;
  const failures = db
    .query<FailureRow, [string]>(
      `SELECT id, name, suite, file, message, type FROM run_live_failures WHERE run_id = ? ORDER BY position`,
    )
    .all(runId)
    .map(
      (row): RunLiveFailure => ({
        id: row.id,
        name: row.name,
        suite: row.suite,
        file: row.file,
        ...(row.message !== null ? { message: row.message } : {}),
        ...(row.type !== null ? { type: row.type } : {}),
      }),
    );
  return {
    completed: live.completed,
    ...(live.total !== null ? { total: live.total } : {}),
    passed: live.passed,
    failed: live.failed,
    pending: live.pending,
    ...(live.current_file !== null ? { currentFile: live.current_file } : {}),
    failures,
  };
}

/** §S2 — a settled run's batches and live state, deleted. */
export function deleteRunStream(db: Database, runId: string): void {
  db.query(`DELETE FROM run_stream_batches WHERE run_id = ?`).run(runId);
  db.query(`DELETE FROM run_live WHERE run_id = ?`).run(runId);
  db.query(`DELETE FROM run_live_failures WHERE run_id = ?`).run(runId);
}

/** §S2 — a deleted project's runs' batches and live state, deleted while its runs remain. */
export function deleteProjectRunStreams(db: Database, projectKey: string): void {
  db.query(`DELETE FROM run_stream_batches WHERE run_id IN (SELECT run_id FROM runs WHERE project_key = ?)`).run(
    projectKey,
  );
  db.query(`DELETE FROM run_live WHERE run_id IN (SELECT run_id FROM runs WHERE project_key = ?)`).run(projectKey);
  db.query(`DELETE FROM run_live_failures WHERE run_id IN (SELECT run_id FROM runs WHERE project_key = ?)`).run(
    projectKey,
  );
}
