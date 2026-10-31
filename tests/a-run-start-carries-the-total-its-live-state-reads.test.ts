// The run start carries the client's own count of the tests it is about to
// run, and the live read answers it (CR-CRU-201 §S2, AC2):
//  - the route: `POST /api/v2/runs/start` takes an optional `total`, an
//    integer ≥ 0, stored on the run in the nullable `runs.total` column; any
//    other value is a 400 that states nothing was started, and no run is
//    opened;
//  - the live read: `Store#runLive`, the open-run brief's `live`
//    (`openRuns[]` on `GET /api/v2/events`) and `GET /api/v2/runs/<runId>/live`
//    answer `total` by §S2's order — the stream's own `run-start` total first,
//    otherwise the start's total; with either, never below `completed`, and 0
//    read as no total;
//  - no batch yet: an open run with a start total and no batch has no live
//    state, and `/live` answers 404 as today — its first batch then reads the
//    start's total;
//  - the schema: migration v22 adds `runs.total` and `run_live.reader_state`,
//    a store walked back to v21 is migrated to v22, and RUNBOOK's schema
//    figures read v22.
//
// A reading this file takes of §S2 that the orchestrator rules on: a stream
// `run-start` stating total 0 "gives no total", so the start's total stands.
//
// The streams are `crucible-events` streams (the record codec the live state
// already reads), so each total rule is shown without a view codec.
//
// SAFETY: every server binds port 0 on ":memory:"; the migrated store is a
// file under a fresh OS tmpdir, removed after each test.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerHandle } from "../src/server.ts";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
import {
  bootOn,
  eventLine,
  getJson,
  postJson,
  readyProject,
  sendBatch,
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

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "totaller";

/** A run opened with whatever the start body states; answers the raw route answer. */
function start(handle: ServerHandle, key: string, extra: Record<string, unknown>) {
  return postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId: AGENT, stack: "bun", tier: "unit", ...extra });
}

async function openWith(handle: ServerHandle, key: string, extra: Record<string, unknown>): Promise<string> {
  const res = await start(handle, key, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  expect(typeof res.body.runId).toBe("string");
  return res.body.runId as string;
}

/** The run's `runs.total` column, read off the store's own connection. */
function storedTotal(handle: ServerHandle, runId: string): number | null | undefined {
  return dbOf(handle.store)
    .query<{ total: number | null }, [string]>("SELECT total FROM runs WHERE run_id = ?")
    .get(runId)?.total;
}

const PASS = (n: number): string =>
  eventLine({ event: "test-end", id: `t${n}`, name: `case ${n}`, suite: "Totals", file: "src/totals.test.ts", status: "pass" });

async function stream(handle: ServerHandle, key: string, runId: string, text: string): Promise<void> {
  const res = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** The total each live surface answers for the run: runLive, the open-run brief, and the /live route. */
async function totalsOf(handle: ServerHandle, key: string, runId: string): Promise<Array<number | undefined>> {
  const fromStore = handle.store.runLive(runId)?.total;
  const events = await getJson(handle, `/api/v2/events?project=${key}`);
  const brief = (events.openRuns as Array<{ runId: string; live?: { total?: number } }>).find((r) => r.runId === runId);
  expect(brief?.live, "the open-run brief carries live").toBeDefined();
  const route = await getJson(handle, `/api/v2/runs/${runId}/live`);
  expect(route.state).toBe("open");
  return [fromStore, brief?.live?.total, (route.live as { total?: number }).total];
}

// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v2/runs/start takes an optional total, an integer of 0 or more", () => {
  test("a total of 1280 opens the run (202) and is stored in runs.total; 0 is stored as 0; no total stores NULL", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "start-total");
    const counted = await openWith(handle, key, { total: 1280 });
    const zero = await openWith(handle, key, { total: 0 });
    const none = await openWith(handle, key, {});
    expect(storedTotal(handle, counted)).toBe(1280);
    expect(storedTotal(handle, zero)).toBe(0);
    expect(storedTotal(handle, none)).toBeNull();
  });

  test("a total that is negative, fractional, a string, a boolean, a list or an object is a 400 stating nothing was started, and no run is opened", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "start-total-refused");
    for (const total of [-1, 1.5, "12", true, [3], { n: 3 }]) {
      const res = await start(handle, key, { total });
      expect(res.status, `total ${JSON.stringify(total)}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(String(res.body.error)).toMatch(/\bnot started\b|\bnothing (?:was )?started\b/i);
      expect(res.body.runId).toBeUndefined();
    }
    expect(handle.store.listOpenRuns(key)).toEqual([]);
  });
});

describe("the live read answers total by the stream's run-start first, then the start's total", () => {
  test("a stream stating run-start total 5 answers 5 over a start total of 9; a stream with no run-start answers the start's 9 — on runLive, the brief and /live alike", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "total-order");
    const own = await openWith(handle, key, { total: 9 });
    await stream(handle, key, own, eventLine({ event: "run-start", total: 5 }) + PASS(1) + PASS(2));
    const borrowed = await openWith(handle, key, { total: 9 });
    await stream(handle, key, borrowed, PASS(1) + PASS(2));

    expect(await totalsOf(handle, key, own)).toEqual([5, 5, 5]);
    expect(await totalsOf(handle, key, borrowed)).toEqual([9, 9, 9]);
    expect(handle.store.runLive(borrowed)?.completed).toBe(2);
  });

  test("never below completed: three tests done against a stated total of 2 — the stream's or the start's — answer 3", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "total-capped");
    const byStream = await openWith(handle, key, {});
    await stream(handle, key, byStream, eventLine({ event: "run-start", total: 2 }) + PASS(1) + PASS(2) + PASS(3));
    const byStart = await openWith(handle, key, { total: 2 });
    await stream(handle, key, byStart, PASS(1) + PASS(2) + PASS(3));

    expect(await totalsOf(handle, key, byStream)).toEqual([3, 3, 3]);
    expect(await totalsOf(handle, key, byStart)).toEqual([3, 3, 3]);
  });

  test("0 is read as no total: a start total of 0 answers none, and a stream run-start of 0 leaves the start's total of 7 standing", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "total-zero");
    const zeroStart = await openWith(handle, key, { total: 0 });
    await stream(handle, key, zeroStart, PASS(1) + PASS(2));
    const zeroStream = await openWith(handle, key, { total: 7 });
    await stream(handle, key, zeroStream, eventLine({ event: "run-start", total: 0 }) + PASS(1));

    expect(await totalsOf(handle, key, zeroStart)).toEqual([undefined, undefined, undefined]);
    expect(handle.store.runLive(zeroStart)).not.toHaveProperty("total");
    expect(await totalsOf(handle, key, zeroStream)).toEqual([7, 7, 7]);
  });
});

describe("an open run with a start total and no batch has no live state", () => {
  test("/live answers 404 and runLive null while nothing is streamed; the first batch then reads the start's total of 1280", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "total-no-batch");
    const runId = await openWith(handle, key, { total: 1280 });
    expect(storedTotal(handle, runId)).toBe(1280);

    expect(handle.store.runLive(runId)).toBeNull();
    const before = await fetch(`http://127.0.0.1:${handle.server.port}/api/v2/runs/${runId}/live`);
    expect(before.status).toBe(404);
    const events = await getJson(handle, `/api/v2/events?project=${key}`);
    const brief = (events.openRuns as Array<{ runId: string }>).find((r) => r.runId === runId);
    expect(brief).toBeDefined();
    expect(brief).not.toHaveProperty("live");

    await stream(handle, key, runId, PASS(1));
    expect(await totalsOf(handle, key, runId)).toEqual([1280, 1280, 1280]);
  });
});

// ── Migration v22 ───────────────────────────────────────────────────────────

const PRE_TOTAL_VERSION = 21;
const TOTAL_VERSION = 22;

function scratchDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-run-total-v22-"));
  scratchDirs.push(dir);
  return path.join(dir, "crucible.db");
}

interface ColumnInfo {
  name: string;
  notnull: number;
}

function columnsOf(db: Database, table: "runs" | "run_live"): ColumnInfo[] {
  const sql = table === "runs" ? "PRAGMA table_info(runs)" : "PRAGMA table_info(run_live)";
  return db.query<ColumnInfo, []>(sql).all();
}

function rawUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
}

/** A store from this build walked back to v21: `runs.total` and `run_live.reader_state` dropped, `user_version` stamped 21. */
function makeV21Store(): string {
  const dbPath = scratchDbPath();
  dbOf(Store.open(dbPath)).close();
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    if (columnsOf(db, "runs").some((c) => c.name === "total")) db.exec("ALTER TABLE runs DROP COLUMN total");
    if (columnsOf(db, "run_live").some((c) => c.name === "reader_state")) {
      db.exec("ALTER TABLE run_live DROP COLUMN reader_state");
    }
    db.exec(`PRAGMA user_version = ${PRE_TOTAL_VERSION}`);
  } finally {
    db.close();
  }
  return dbPath;
}

describe("migration v22 adds runs.total and run_live.reader_state", () => {
  test("the schema version this build declares is 22", () => {
    expect(SCHEMA_VERSION).toBe(TOTAL_VERSION);
  });

  test("a v21 store is migrated 21 → 22: it gains runs.total and run_live.reader_state, both nullable, and is stamped 22", () => {
    const dbPath = makeV21Store();
    const before = new Database(dbPath);
    try {
      expect(rawUserVersion(before)).toBe(PRE_TOTAL_VERSION);
      expect(columnsOf(before, "runs").map((c) => c.name)).not.toContain("total");
      expect(columnsOf(before, "run_live").map((c) => c.name)).not.toContain("reader_state");
    } finally {
      before.close();
    }

    const store = Store.open(dbPath);
    stores.push(store);
    expect(store.migration?.from).toBe(PRE_TOTAL_VERSION);
    expect(store.migration?.to).toBe(TOTAL_VERSION);
    expect(store.schemaVersion).toBe(TOTAL_VERSION);
    const db = dbOf(store);
    expect(rawUserVersion(db)).toBe(TOTAL_VERSION);
    expect(columnsOf(db, "runs").find((c) => c.name === "total")).toEqual(expect.objectContaining({ notnull: 0 }));
    expect(columnsOf(db, "run_live").find((c) => c.name === "reader_state")).toEqual(
      expect.objectContaining({ notnull: 0 }),
    );
  });

  test("on the migrated store a run opened with no total holds NULL, and its stream fills a live row that carries the reader_state column", () => {
    const store = Store.open(makeV21Store());
    stores.push(store);
    const key = crypto.randomUUID();
    store.addProject({ key, name: "migrated-total", type: "backend", sutRoot: "/tmp/migrated-total" });
    const runId = store.startRun(key, "migrated-runner", { tier: "unit" }).runId;
    const db = dbOf(store);
    expect(db.query<{ total: number | null }, [string]>("SELECT total FROM runs WHERE run_id = ?").get(runId)?.total).toBeNull();
    const data = PASS(1);
    expect(store.appendRunStream(runId, { codec: "crucible-events", from: 0, data, limit: 1 << 20 }).ok).toBe(true);
    expect(store.runLive(runId)?.completed).toBe(1);
    const row = db
      .query<Record<string, unknown>, [string]>("SELECT * FROM run_live WHERE run_id = ?")
      .get(runId);
    expect(row).not.toBeNull();
    expect(Object.keys(row ?? {})).toContain("reader_state");
  });
});

describe("RUNBOOK's schema figures read v22", () => {
  test("docs/RUNBOOK.md states schema v22, the migration banner reaching v22 and the health figure schemaVersion 22, and names no v21 figure", () => {
    const runbook = fs.readFileSync(path.join(import.meta.dir, "..", "docs", "RUNBOOK.md"), "utf8");
    expect(runbook).toContain(`schema v${TOTAL_VERSION})`);
    expect(runbook).toContain(`-> v${TOTAL_VERSION} (`);
    expect(runbook).toContain(`"schemaVersion":${TOTAL_VERSION}`);
    expect(runbook).not.toContain(`schema v${PRE_TOTAL_VERSION})`);
    expect(runbook).not.toContain(`"schemaVersion":${PRE_TOTAL_VERSION}`);
  });
});
