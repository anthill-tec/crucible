// The tables an open run's stream and live state are held in (CR-CRU-200
// §S2, §S4) — `run_stream_batches`, `run_live` and `run_live_failures`:
//  - a project's cascade delete (`DELETE /api/v2/projects/<key>`, archived
//    and `userApproved: true`, as tests/project-teardown.test.ts drives it)
//    removes its runs' rows from all three, and leaves another project's
//    rows alone;
//  - the store migrates v20 → v21 by creating them: a store from this build
//    walked back to v20 (the three tables dropped, `user_version` stamped
//    20), as tests/store-migration.test.ts walks a store back for its own
//    retrofits, gains all three with their columns and is stamped 21.
//
// Rows are counted with a direct SQL count through the store's own
// connection, the way the cascade tests count their tables.
//
// SAFETY: every server binds port 0 on ":memory:"; the migrated store is a
// file under a fresh OS tmpdir, removed after each test.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUN_STREAM_TABLES } from "../src/run-stream.ts";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
import type { ServerHandle } from "../src/server.ts";
import {
  base,
  bootOn,
  eventLine,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  utf8,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];
const scratchDirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (stores.length > 0) dbOf(stores.pop() as Store).close();
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

/** One fixed count query per stream table — no table name is ever interpolated. */
const COUNT_ROWS: Record<(typeof RUN_STREAM_TABLES)[number], string> = {
  run_stream_batches: "SELECT COUNT(*) AS n FROM run_stream_batches WHERE run_id = ?",
  run_live: "SELECT COUNT(*) AS n FROM run_live WHERE run_id = ?",
  run_live_failures: "SELECT COUNT(*) AS n FROM run_live_failures WHERE run_id = ?",
};

function streamRows(handle: ServerHandle, runId: string): Record<string, number> {
  const db = dbOf(handle.store);
  const out: Record<string, number> = {};
  for (const table of RUN_STREAM_TABLES) {
    out[table] = db.query<{ n: number }, [string]>(COUNT_ROWS[table]).get(runId)?.n ?? -1;
  }
  return out;
}

const NO_ROWS = { run_stream_batches: 0, run_live: 0, run_live_failures: 0 };

// ── The cascade delete ──────────────────────────────────────────────────────

const L_START = eventLine({ event: "run-start", total: 2 });
const L_PASS = eventLine({ event: "test-end", id: "t1", name: "adds", suite: "math", file: "src/math.ts", status: "pass" });
const L_FAIL = eventLine({
  event: "test-end",
  id: "t2",
  name: "divides",
  suite: "math",
  file: "src/math.ts",
  status: "fail",
  failure: { message: "expected 1" },
});

/** A project with one open run that has streamed one pass and one failure, in two batches. */
async function streamingProject(handle: ServerHandle, name: string): Promise<{ key: string; runId: string }> {
  const agentId = `${name}-streamer`;
  const key = await readyProject(handle, [agentId], name);
  const runId = await openRun(handle, key, agentId, { stack: "bun", tier: "unit" });
  const first = L_START + L_PASS;
  for (const [from, data] of [
    [0, first],
    [utf8(first), L_FAIL],
  ] as const) {
    const res = await sendBatch(handle, runId, { projectKey: key, agentId, from, data });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { key, runId };
}

async function archive(handle: ServerHandle, key: string): Promise<void> {
  const res = await postJson(handle, `/api/v2/projects/${key}/archive`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function deleteProject(handle: ServerHandle, key: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base(handle)}/api/v2/projects/${key}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userApproved: true }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("a project's cascade delete removes its runs' held streams and live state", () => {
  test("DELETE /api/v2/projects/<key> leaves no row of its open streamed run in run_stream_batches, run_live or run_live_failures", async () => {
    const handle = bootOn();
    handles.push(handle);
    const { key, runId } = await streamingProject(handle, "cascade-stream");
    await archive(handle, key);
    // Every table holds the run's rows before the delete, so the cascade is never vacuous.
    expect(streamRows(handle, runId)).toEqual({ run_stream_batches: 2, run_live: 1, run_live_failures: 1 });

    const res = await deleteProject(handle, key);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(streamRows(handle, runId)).toEqual(NO_ROWS);
    expect(handle.store.getRun(runId)).toBeNull();
  });

  test("another project's streamed run keeps every row of its stream and live state", async () => {
    const handle = bootOn();
    handles.push(handle);
    const doomed = await streamingProject(handle, "cascade-doomed");
    const kept = await streamingProject(handle, "cascade-kept");
    await archive(handle, doomed.key);

    const res = await deleteProject(handle, doomed.key);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(streamRows(handle, doomed.runId)).toEqual(NO_ROWS);
    expect(streamRows(handle, kept.runId)).toEqual({ run_stream_batches: 2, run_live: 1, run_live_failures: 1 });
    expect(handle.store.getRun(kept.runId)?.state).toBe("open");
    expect(handle.store.runLive(kept.runId)?.completed).toBe(2);
  });
});

// ── The migration v20 → v21 ─────────────────────────────────────────────────

const PRE_STREAM_VERSION = 20;

/** The columns each table holds, as `createRunStreamTables` (src/run-stream.ts) creates them. */
const STREAM_COLUMNS: Record<(typeof RUN_STREAM_TABLES)[number], string[]> = {
  run_stream_batches: ["run_id", "start_offset", "text"],
  run_live: [
    "run_id",
    "codec",
    "completed",
    "total",
    "passed",
    "failed",
    "pending",
    "current_file",
    "decoded_offset",
    "undecodable",
    "cut",
    "reader_state",
  ],
  run_live_failures: ["run_id", "position", "id", "name", "suite", "file", "message", "type", "browser"],
};

function scratchDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-run-stream-v21-"));
  scratchDirs.push(dir);
  return path.join(dir, "crucible.db");
}

function rawUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
}

function tablesPresent(db: Database): string[] {
  return db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => row.name)
    .filter((name) => (RUN_STREAM_TABLES as readonly string[]).includes(name));
}

function columnsOf(db: Database, table: (typeof RUN_STREAM_TABLES)[number]): string[] {
  const sql = {
    run_stream_batches: "PRAGMA table_info(run_stream_batches)",
    run_live: "PRAGMA table_info(run_live)",
    run_live_failures: "PRAGMA table_info(run_live_failures)",
  }[table];
  return db
    .query<{ name: string }, []>(sql)
    .all()
    .map((c) => c.name);
}

/** A store from this build walked back to v20: the three stream tables dropped, `user_version` stamped 20. */
function makeV20Store(): string {
  const dbPath = scratchDbPath();
  dbOf(Store.open(dbPath)).close();
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("DROP TABLE IF EXISTS run_stream_batches");
    db.exec("DROP TABLE IF EXISTS run_live");
    db.exec("DROP TABLE IF EXISTS run_live_failures");
    db.exec(`PRAGMA user_version = ${PRE_STREAM_VERSION}`);
  } finally {
    db.close();
  }
  return dbPath;
}

describe("the store migrates v20 → v21 by creating the stream and live-state tables", () => {
  test("a v20 store gains run_stream_batches, run_live and run_live_failures with their columns, and is stamped the build's schema version", () => {
    const dbPath = makeV20Store();
    // Preconditions, so the test can never pass by testing nothing.
    const before = new Database(dbPath);
    try {
      expect(rawUserVersion(before)).toBe(PRE_STREAM_VERSION);
      expect(tablesPresent(before)).toEqual([]);
    } finally {
      before.close();
    }

    const store = Store.open(dbPath);
    stores.push(store);
    expect(store.migration?.from).toBe(PRE_STREAM_VERSION);
    expect(store.migration?.to).toBe(SCHEMA_VERSION);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);

    const db = dbOf(store);
    expect(rawUserVersion(db)).toBe(SCHEMA_VERSION);
    expect(tablesPresent(db)).toEqual(["run_live", "run_live_failures", "run_stream_batches"]);
    for (const table of RUN_STREAM_TABLES) {
      expect(columnsOf(db, table), table).toEqual(STREAM_COLUMNS[table]);
    }
  });

  test("the migrated tables take a stream: a run opened on the migrated store streams a batch into them", () => {
    const store = Store.open(makeV20Store());
    stores.push(store);
    const key = crypto.randomUUID();
    store.addProject({ key, name: "migrated-stream", type: "backend", sutRoot: "/tmp/migrated-stream" });
    const runId = store.startRun(key, "migrated-runner", { tier: "unit" }).runId;
    const data = L_START + L_FAIL;
    const outcome = store.appendRunStream(runId, { codec: "crucible-events", from: 0, data, limit: 1 << 20 });
    expect(outcome).toEqual({ ok: true, held: utf8(data) });
    expect(store.runLive(runId)?.failed).toBe(1);
  });
});
