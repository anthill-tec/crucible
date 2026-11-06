// CR-CRU-200 §S2/§S4 — where an open run's test stream is held, and the live
// state each batch fills. The SQL lives here; `Store` (src/store.ts) owns the
// connection and the transactions, and calls these inside them.
//
// - `run_stream_batches`: one row per appended batch — the run, the UTF-8 byte
//   offset it starts at, its text — so an append never rewrites an earlier row.
// - `run_live`: one row per open run that has streamed — the counts, the
//   runner's total, the last file, the offset up to which lines are decoded,
//   the undecodable count, whether the stream was cut, the stream codec
//   the run's first batch fixed, and a codec's reader state between
//   batches (migration v22).
// - `runs.total` (migration v22): the run start's own total, the live read's
//   fallback when the stream states none.
// - `run_live_failures`: the run's failures so far, in order.
// - `run_test_lists`: an open run's test list, as the client posted it, and
//   its listed total — at most one per run.
import type { Database } from "bun:sqlite";
import { leafNameOf, suiteNameOf } from "./codecs/crucible-events.ts";
import { codecs, decodeHeldStream, isRecordStreamCodec, viewCodecs, type ViewFill, type ViewLive } from "./codecs/index.ts";
import { failureOf, nonBlank } from "./codecs/junit.ts";
import type { RunLive, RunLiveFailure, RunSchema } from "./types.ts";

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
      cut INTEGER NOT NULL,
      reader_state TEXT
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
      browser TEXT,
      PRIMARY KEY (run_id, position)
    );
  `);
}

/** A live failure's browser: added last, by the base pass's DDL and by the migration's ALTER alike. */
export const LIVE_FAILURE_BROWSER_DDL = "ALTER TABLE run_live_failures ADD COLUMN browser TEXT";

/**
 * The table an open run's test list is held in: created by the base pass in
 * its current shape, as every table a legacy store never had is.
 */
export function createRunTestListTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_test_lists (
      run_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL,
      text TEXT NOT NULL
    );
  `);
}

/** The run's test list and its listed total, or null when it was given none. */
function testListOf(db: Database, runId: string): { total: number; text: string } | null {
  return db
    .query<{ total: number; text: string }, [string]>(`SELECT total, text FROM run_test_lists WHERE run_id = ?`)
    .get(runId);
}

/**
 * An open run's test list stored with its listed total, once: false, storing
 * nothing, when the run holds one already. Called inside the list's
 * transaction, after the run's open state was re-read.
 */
export function storeRunTestList(db: Database, runId: string, text: string, total: number): boolean {
  if (testListOf(db, runId) !== null) return false;
  db.query(`INSERT INTO run_test_lists (run_id, total, text) VALUES (?, ?, ?)`).run(runId, total, text);
  return true;
}

/** The run start's own total, or null when it stated none. */
function startTotalOf(db: Database, runId: string): number | null {
  return db.query<{ total: number | null }, [string]>(`SELECT total FROM runs WHERE run_id = ?`).get(runId)?.total ?? null;
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
  reader_state: string | null;
}

interface FailureRow {
  id: string;
  name: string;
  suite: string;
  file: string;
  message: string | null;
  type: string | null;
  browser: string | null;
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

/**
 * A run's held stream: the stream codec its first batch fixed, the whole text
 * held, whether a batch was refused at `ingest_body_bytes` (the stream was
 * cut), and the run's test list and start total, each only when held.
 */
export interface HeldStream {
  codec: string;
  text: string;
  cut: boolean;
  list?: string;
  startTotal?: number;
}

/** The stream the run holds, or null when it has streamed nothing. */
export function heldStreamOf(db: Database, runId: string): HeldStream | null {
  const live = liveRow(db, runId);
  if (live === null) return null;
  const text = db
    .query<{ text: string }, [string]>(`SELECT text FROM run_stream_batches WHERE run_id = ? ORDER BY start_offset`)
    .all(runId)
    .map((row) => row.text)
    .join("");
  const list = testListOf(db, runId);
  const startTotal = startTotalOf(db, runId);
  return {
    codec: live.codec,
    text,
    cut: live.cut === 1,
    ...(list !== null ? { list: list.text } : {}),
    ...(startTotal !== null ? { startTotal } : {}),
  };
}

/** Why an aborted run's stream is not trusted when the codec states no reason of its own. */
export const ABORTED_BEFORE_CLOSE = "aborted before its close";

/**
 * What an aborted streamed run keeps: its held stream decoded by its
 * run's record stream codec — the tree and counts — and why it cannot be
 * trusted. An aborted streamed run is always incomplete: when the stream is
 * otherwise whole, the reason is that it was aborted before its close; when
 * the codec cannot decode it, the reason is why.
 *
 * Only a RECORD stream is decoded: a view stream is not the run's record, so
 * its run keeps nothing of it and is aborted as a run with no stream (null).
 */
export function abortedStreamRecord(
  held: HeldStream,
): (Pick<RunSchema, "summary" | "tree"> & { incomplete: string }) | null {
  const codec = codecs.get(held.codec);
  if (codec === undefined || !isRecordStreamCodec(held.codec)) return null;
  const decoded = decodeHeldStream(codec, held, held.codec);
  if ("error" in decoded) {
    return { summary: { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 0 }, tree: [], incomplete: decoded.error };
  }
  return { summary: decoded.summary, tree: decoded.tree, incomplete: decoded.incomplete ?? ABORTED_BEFORE_CLOSE };
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

/** The run's live failures so far, in order. */
function liveFailures(db: Database, runId: string): RunLiveFailure[] {
  return db
    .query<FailureRow, [string]>(
      `SELECT id, name, suite, file, message, type, browser FROM run_live_failures WHERE run_id = ? ORDER BY position`,
    )
    .all(runId)
    .map(
      (row): RunLiveFailure => ({
        id: row.id,
        name: row.name,
        suite: row.suite,
        file: row.file,
        ...(row.browser !== null ? { browser: row.browser } : {}),
        ...(row.message !== null ? { message: row.message } : {}),
        ...(row.type !== null ? { type: row.type } : {}),
      }),
    );
}

/** A view codec's fill stored: the counts, the current file, the new failures, the offset and the reader state. */
function storeViewFill(db: Database, runId: string, live: ViewLive, known: number, read: ViewFill): void {
  const addFailure = db.query(
    `INSERT INTO run_live_failures (run_id, position, id, name, suite, file, message, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let position = known; position < live.failures.length; position += 1) {
    const failure = live.failures[position]!;
    addFailure.run(
      runId,
      position,
      failure.id,
      failure.name,
      failure.suite,
      failure.file,
      failure.message ?? null,
      failure.type ?? null,
    );
  }
  db.query(
    `UPDATE run_live SET completed = ?, passed = ?, failed = ?, pending = ?, current_file = ?,
       decoded_offset = ?, reader_state = ? WHERE run_id = ?`,
  ).run(
    live.completed,
    live.passed,
    live.failed,
    live.pending,
    live.currentFile ?? null,
    read.offset,
    read.readerState,
    runId,
  );
}

/**
 * §S4 — the live state filled from the lines the held stream completes past
 * its decoded offset. The partial line is never decoded: it stays in the
 * batch rows and is read back from that offset on the next batch.
 *
 * The one caller of a view codec's `fill`: a view stream is handed, from its
 * decoded offset, to its codec (looked up in `viewCodecs` as it fills), which
 * answers the new offset and the reader state to hold. A record stream is
 * read line by line by its codec's line reader, opened on the run's test list
 * and the reader state the last batch left, into the one test-end shape.
 */
function fillRunLive(db: Database, runId: string): void {
  const live = liveRow(db, runId);
  if (live === null) return;
  const pending = heldBytesFrom(db, runId, live.decoded_offset);
  const view = viewCodecs.get(live.codec);
  if (view !== undefined) {
    const failures = liveFailures(db, runId);
    const known = failures.length;
    const state: ViewLive = {
      completed: live.completed,
      passed: live.passed,
      failed: live.failed,
      pending: live.pending,
      ...(live.current_file !== null ? { currentFile: live.current_file } : {}),
      failures,
    };
    const read = view.fill(pending.toString("utf8"), live.decoded_offset, live.reader_state, state);
    storeViewFill(db, runId, state, known, read);
    return;
  }
  const end = pending.lastIndexOf(0x0a);
  if (end === -1) return;
  const lineReader = codecs.get(live.codec)?.lineReader;
  if (lineReader === undefined) return;
  const list = testListOf(db, runId);
  const reader = lineReader({ ...(list !== null ? { list: list.text } : {}), state: live.reader_state });
  const state = { ...live };
  let position = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM run_live_failures WHERE run_id = ?`)
    .get(runId)!.n;
  const addFailure = db.query(
    `INSERT INTO run_live_failures (run_id, position, id, name, suite, file, message, type, browser)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A test's steps are never read here: the live state counts tests (its steps are in the stored run).
  for (const line of pending.subarray(0, end).toString("utf8").split("\n")) {
    const read = reader.read(line);
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
        read.browser ?? null,
      );
      position += 1;
    }
  }
  db.query(
    `UPDATE run_live SET completed = ?, total = ?, passed = ?, failed = ?, pending = ?, current_file = ?,
       decoded_offset = ?, undecodable = ?, reader_state = ? WHERE run_id = ?`,
  ).run(
    state.completed,
    state.total,
    state.passed,
    state.failed,
    state.pending,
    state.current_file,
    live.decoded_offset + end + 1,
    state.undecodable,
    reader.state(),
    runId,
  );
}

/**
 * §S4 — a token of what the run's live state shows: its counts, total and
 * current file, and how many failures it holds (failures are only appended).
 * Two equal tokens show the same live state; null when the run holds none.
 */
export function liveStateToken(db: Database, runId: string): string | null {
  const live = liveRow(db, runId);
  if (live === null) return null;
  const failures = db
    .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM run_live_failures WHERE run_id = ?`)
    .get(runId)!.n;
  return JSON.stringify([
    live.completed,
    liveTotal(db, runId, live),
    live.passed,
    live.failed,
    live.pending,
    live.current_file,
    failures,
  ]);
}

/** §S4 — whether any OPEN run of the project still holds a stream. */
export function projectHasStreamingRun(db: Database, projectKey: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT 1 AS n FROM run_live JOIN runs ON runs.run_id = run_live.run_id
        WHERE runs.project_key = ? AND runs.run_state = 'open' LIMIT 1`,
    )
    .get(projectKey);
  return row !== null;
}

/**
 * The total the live read answers: the stream's own `run-start` total when
 * it states one, otherwise the run's listed total when it was given a test
 * list, otherwise the run start's total; 0 read as no total. A codec whose
 * pending results lie outside the run's total adds the pending results seen.
 * Never below `completed`. Null when there is none.
 */
function liveTotal(db: Database, runId: string, live: LiveRow): number | null {
  const stated = live.total ?? testListOf(db, runId)?.total ?? startTotalOf(db, runId);
  if (stated === null || stated <= 0) return null;
  const outside = codecs.get(live.codec)?.pendingOutsideTotal === true ? live.pending : 0;
  return Math.max(stated + outside, live.completed);
}

/** §S4 — the run's live state, or null when it holds none. */
export function runLiveOf(db: Database, runId: string): RunLive | null {
  const live = liveRow(db, runId);
  if (live === null) return null;
  const failures = liveFailures(db, runId);
  const total = liveTotal(db, runId, live);
  return {
    completed: live.completed,
    ...(total !== null ? { total } : {}),
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
  db.query(`DELETE FROM run_test_lists WHERE run_id = ?`).run(runId);
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
  db.query(`DELETE FROM run_test_lists WHERE run_id IN (SELECT run_id FROM runs WHERE project_key = ?)`).run(
    projectKey,
  );
}
