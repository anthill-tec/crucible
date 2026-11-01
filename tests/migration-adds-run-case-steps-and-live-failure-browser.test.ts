// Migration v24 stores a test's steps and a live failure's browser:
//  - it creates `run_case_steps` (what `createRunDetailTables` creates for a
//    new store) and adds a nullable TEXT `browser` to `run_live_failures`;
//  - a brand-new store's columns of both tables equal a store migrated from
//    v23;
//  - a run stored before v24 reads unchanged (its tests answer no `steps`),
//    an open run's live failure stored before v24 reads unchanged (no
//    `browser`), and a run stored after the migration stores its steps;
//  - RUNBOOK's schema figures read v24.
//
// Interface choice (stated for the orchestrator's ruling): the step row's
// columns are `event_id`, `suite_position`, `case_position`, `position`,
// `name`, `status`, `duration_ms`, `has_failure`, `failure_message`,
// `failure_type`, `failure_trace` — `run_cases`' own, with the case's
// position beside its suite's.
//
// A store from this build is walked back to v23 (its step table dropped, the
// browser column dropped where present, `user_version` stamped 23), as the
// v23 migration's own tests walk a store back to v22.
//
// SAFETY: every migrated store is a file under a fresh OS tmpdir, removed
// after each test.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
import type { RunEvent, RunLive, SuiteNode } from "../src/types.ts";

const PRE_STEPS_VERSION = 23;
const STEPS_VERSION = 24;

const STEP_COLUMNS = [
  "case_position",
  "duration_ms",
  "event_id",
  "failure_message",
  "failure_trace",
  "failure_type",
  "has_failure",
  "name",
  "position",
  "status",
  "suite_position",
];

const scratchDirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) dbOf(stores.pop() as Store).close();
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

function scratchDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-run-case-steps-v24-"));
  scratchDirs.push(dir);
  return path.join(dir, "crucible.db");
}

function open(dbPath: string): Store {
  const store = Store.open(dbPath);
  stores.push(store);
  return store;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

const TABLE_INFO = {
  run_case_steps: "PRAGMA table_info(run_case_steps)",
  run_live_failures: "PRAGMA table_info(run_live_failures)",
} as const;

/** The table's columns, sorted by name — the comparison a new and a migrated store must agree on. */
function columnsOf(db: Database, table: keyof typeof TABLE_INFO): ColumnInfo[] {
  return db
    .query<ColumnInfo & { cid: number }, []>(TABLE_INFO[table])
    .all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tableExists(db: Database, table: string): boolean {
  return db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)?.n === 1;
}

function rawUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
}

interface V23Store {
  dbPath: string;
  key: string;
  eventId: string;
  openRunId: string;
  eventBefore: RunEvent | null;
  liveBefore: RunLive | null;
}

const PRE_TREE: SuiteNode[] = [
  {
    name: "Checkout › Pay by card",
    status: "fail",
    browser: "chromium",
    children: [
      { name: "Given a cart", status: "pass", duration_ms: 2 },
      { name: "When I pay", status: "fail", duration_ms: 3, failure: { message: "card declined", type: "AssertionError" } },
    ],
  },
];

/**
 * A store from this build walked back to v23, holding a closed run stored by
 * the playwright codec's shape (a scenario per suite, a step per test) and an
 * open streamed run with one live failure, both read before the walk-back.
 */
function makeV23Store(): V23Store {
  const dbPath = scratchDbPath();
  const store = Store.open(dbPath);
  const key = crypto.randomUUID();
  store.addProject({ key, name: "pre-steps", type: "backend", sutRoot: "/tmp/pre-steps" });
  const eventId = store.recordTestEvent(
    key,
    "pre-runner",
    { summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 5 }, tree: PRE_TREE },
    { tier: "e2e", stack: "bun", codec: "playwright" },
  ).id;
  const openRunId = store.startRun(key, "pre-runner", { tier: "unit", stack: "bun" }).runId;
  const data = `${JSON.stringify({
    event: "test-end",
    id: "t1",
    name: "adds",
    suite: "math",
    file: "src/math.ts",
    status: "fail",
    failure: { message: "1 + 1 is not 3" },
  })}\n`;
  expect(store.appendRunStream(openRunId, { codec: "crucible-events", from: 0, data, limit: 1 << 20 })).toEqual({
    ok: true,
    held: Buffer.byteLength(data, "utf8"),
  });
  const eventBefore = store.getEvent(eventId);
  const liveBefore = store.runLive(openRunId);
  dbOf(store).close();

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("DROP TABLE IF EXISTS run_case_steps");
    const liveColumns = db.query<{ name: string }, []>("PRAGMA table_info(run_live_failures)").all();
    if (liveColumns.some((c) => c.name === "browser")) db.exec("ALTER TABLE run_live_failures DROP COLUMN browser");
    db.exec(`PRAGMA user_version = ${PRE_STEPS_VERSION}`);
  } finally {
    db.close();
  }
  return { dbPath, key, eventId, openRunId, eventBefore, liveBefore };
}

describe("migration v24 adds run_case_steps and run_live_failures.browser", () => {
  test("the schema version this build declares is 24", () => {
    expect(SCHEMA_VERSION).toBe(STEPS_VERSION);
  });

  test("a v23 store is migrated 23 → 24: run_case_steps is created with its columns, run_live_failures gains a nullable TEXT browser, and the store is stamped 24", () => {
    const v23 = makeV23Store();
    const before = new Database(v23.dbPath);
    try {
      // Preconditions, so the test can never pass by testing nothing.
      expect(rawUserVersion(before)).toBe(PRE_STEPS_VERSION);
      expect(tableExists(before, "run_case_steps")).toBe(false);
      expect(columnsOf(before, "run_live_failures").map((c) => c.name)).not.toContain("browser");
    } finally {
      before.close();
    }

    const store = open(v23.dbPath);
    expect(store.migration?.from).toBe(PRE_STEPS_VERSION);
    expect(store.migration?.to).toBe(STEPS_VERSION);
    expect(store.schemaVersion).toBe(STEPS_VERSION);
    const db = dbOf(store);
    expect(rawUserVersion(db)).toBe(STEPS_VERSION);
    expect(columnsOf(db, "run_case_steps").map((c) => c.name)).toEqual(STEP_COLUMNS);
    expect(columnsOf(db, "run_live_failures").find((c) => c.name === "browser")).toEqual({
      name: "browser",
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
      pk: 0,
    });
  });

  test("a brand-new store's run_case_steps and run_live_failures columns equal a store migrated from v23", () => {
    const freshDb = dbOf(open(scratchDbPath()));
    const migratedDb = dbOf(open(makeV23Store().dbPath));

    expect(columnsOf(freshDb, "run_case_steps").map((c) => c.name)).toEqual(STEP_COLUMNS);
    expect(columnsOf(freshDb, "run_live_failures").map((c) => c.name)).toContain("browser");
    expect(columnsOf(migratedDb, "run_case_steps")).toEqual(columnsOf(freshDb, "run_case_steps"));
    expect(columnsOf(migratedDb, "run_live_failures")).toEqual(columnsOf(freshDb, "run_live_failures"));
  });

  test("on the migrated store a run stored before v24 reads unchanged with no steps, and an open run's live failure reads unchanged with no browser", () => {
    const v23 = makeV23Store();
    expect(v23.eventBefore?.tree).toEqual(PRE_TREE);
    expect(v23.liveBefore?.failures).toHaveLength(1);

    const store = open(v23.dbPath);
    expect(store.migration?.to).toBe(STEPS_VERSION);

    const event = store.getEvent(v23.eventId);
    expect(event).toEqual(v23.eventBefore);
    for (const leaf of event?.tree?.flatMap((suite) => suite.children) ?? []) expect(leaf).not.toHaveProperty("steps");
    expect(dbOf(store).query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_case_steps").get()?.n).toBe(0);

    const live = store.runLive(v23.openRunId);
    expect(live).toEqual(v23.liveBefore);
    expect(live?.failures[0]).not.toHaveProperty("browser");
    expect(
      dbOf(store)
        .query<{ browser: string | null }, [string]>("SELECT browser FROM run_live_failures WHERE run_id = ?")
        .all(v23.openRunId),
    ).toEqual([{ browser: null }]);
  });

  test("on the migrated store a run stored after the migration stores its steps and reads them back", () => {
    const v23 = makeV23Store();
    const store = open(v23.dbPath);
    expect(store.migration?.to).toBe(STEPS_VERSION);
    const steps = [
      { name: "Given a cart", status: "pass", duration_ms: 1 },
      { name: "When I pay", status: "fail", duration_ms: 2, failure: { message: "card declined" } },
    ];
    const tree = [
      {
        name: "Checkout",
        status: "fail",
        browser: "chromium",
        children: [{ name: "Pay by card", status: "fail", duration_ms: 3, failure: { message: "card declined" }, steps }],
      },
    ] as unknown as SuiteNode[];

    const id = store.recordTestEvent(
      v23.key,
      "post-runner",
      { summary: { total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 3 }, tree },
      { tier: "bdd", stack: "bun", framework: "playwright-bdd", codec: "crucible-events" },
    ).id;

    expect(store.getEvent(id)?.tree as unknown).toEqual(tree);
    expect(dbOf(store).query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run_case_steps WHERE event_id = ?").get(id)?.n).toBe(2);
  });
});

describe("RUNBOOK's schema figures read v24", () => {
  test("docs/RUNBOOK.md states schema v24, the migration banner reaching v24 and the health figure schemaVersion 24, and names no v23 figure", () => {
    const runbook = fs.readFileSync(path.join(import.meta.dir, "..", "docs", "RUNBOOK.md"), "utf8");
    // Each figure read out of the runbook, so a failure names the figures it found rather than the whole file.
    const figures = (pattern: RegExp): string[] => runbook.match(pattern) ?? [];
    const banner = figures(/schema v\d+\)/g);
    const migrated = figures(/-> v\d+ \(/g);
    const health = figures(/"schemaVersion":\d+/g);
    expect(banner).toContain(`schema v${STEPS_VERSION})`);
    expect(migrated).toContain(`-> v${STEPS_VERSION} (`);
    expect(health).toContain(`"schemaVersion":${STEPS_VERSION}`);
    expect(banner).not.toContain(`schema v${PRE_STEPS_VERSION})`);
    expect(migrated).not.toContain(`-> v${PRE_STEPS_VERSION} (`);
    expect(health).not.toContain(`"schemaVersion":${PRE_STEPS_VERSION}`);
  });
});
