// A run the retired `playwright` codec stored — one suite per scenario named
// "<Feature> › <Scenario>", its steps stored as the suite's cases, its counts
// over steps — is migrated at schema v25 into the scenario shape the stream
// stores for a `playwright-bdd` run, and recounted by scenario:
//  - every codec run (and its `runs` row, when it has one) reads framework
//    `playwright-bdd`, its codec still `playwright`;
//  - one suite per distinct (feature, browser), named by the feature, its
//    `feature` that name and its browser kept; one case per scenario with the
//    old suite's status, the sum of its steps' durations and its first
//    failing step's failure (an empty failure when a failing scenario has no
//    failing step); the old cases become each case's `run_case_steps` rows;
//  - its counts recounted over the scenarios, its `duration_ms` unchanged;
//  - a codec run with no suite gets the framework and nothing else;
//  - every suite of a run of another framework reads `feature` NULL, and
//    nothing else of any other run changes; the rollups stay as folded;
//  - the event, suite and case reads answer the migrated run as they answer
//    a `crucible-events` run of the same scenarios;
//  - a store with no codec run opens at v25 unchanged.
//
// The v24 store is built the way the precedent migration tests build an
// old-version store: open a REAL store from this build, file the runs through
// the store's own write path (`recordTestEvent`, `startRun`/`endRun`), then
// walk it back — every `feature` column set to what v24's ingest wrote for
// it (the name up to the first " › " for a codec or junit suite, the suite's
// whole name for a `playwright-bdd` suite) and `user_version` stamped 24.
// The v24 rows are snapshotted from the raw file before it is reopened.
//
// The `crucible-events` reference run is ingested through the real stream
// route (POST /api/v2/runs/start, /stream batches, the close through
// POST /api/v2/runs) into a fresh board, and both boards are read through
// GET /api/v2/events/<id>, ?depth=suites and ?suite=&browser=.
//
// SAFETY: every store is a file under a fresh OS tmpdir (or ":memory:"),
// removed after each test; every server binds port 0.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
import type { ServerHandle } from "../src/server.ts";
import type { SuiteNode } from "../src/types.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  getJson,
  openRun,
  readyProject,
  sendBatch,
} from "./helpers/run-stream-harness.ts";

const PRE_MIGRATION_VERSION = 24;
const SCENARIO_SHAPE_VERSION = 25;

const AGENT = "scenario-shape-runner";

const scratchDirs: string[] = [];
const stores: Store[] = [];
const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (stores.length > 0) dbOf(stores.pop() as Store).close();
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

function scratchDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-scenario-shape-v25-"));
  scratchDirs.push(dir);
  return path.join(dir, "crucible.db");
}

function open(dbPath: string): Store {
  const store = Store.open(dbPath);
  stores.push(store);
  return store;
}

function boot(dbPath: string): ServerHandle {
  const handle = bootOn(dbPath);
  handles.push(handle);
  return handle;
}

function rawUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
}

// ── the v24 runs ─────────────────────────────────────────────────────────

/** A codec run of two scenarios of one feature in one browser: one passing with two steps, one failing at its second of three. */
const TWO_SCENARIO_TREE: SuiteNode[] = [
  {
    name: "Checkout › Pay by card",
    status: "pass",
    browser: "chromium",
    children: [
      { name: "Given a cart", status: "pass", duration_ms: 3 },
      { name: "When I pay by card", status: "pass", duration_ms: 4 },
    ],
  },
  {
    name: "Checkout › Pay by voucher",
    status: "fail",
    browser: "chromium",
    children: [
      { name: "Given a voucher", status: "pass", duration_ms: 2 },
      {
        name: "When I redeem it",
        status: "fail",
        duration_ms: 6,
        failure: { message: "voucher expired", type: "AssertionError", trace: "at redeem (step 2)" },
      },
      { name: "Then I see the receipt", status: "pending", duration_ms: 0 },
    ],
  },
];
/** What the codec counted for it: over the five steps. */
const TWO_SCENARIO_SUMMARY = { total: 5, passed: 3, failed: 1, pending: 1, duration_ms: 20 };

/** A codec run whose one scenario failed with no step (a hook failed). */
const NO_STEP_TREE: SuiteNode[] = [{ name: "Login › Sign in", status: "fail", browser: "firefox", children: [] }];
/** What the codec counted for it: no step, so nothing. */
const NO_STEP_SUMMARY = { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 9 };

const NO_SUITE_SUMMARY = { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 4 };

const JUNIT_TREE: SuiteNode[] = [
  {
    name: "A › B",
    status: "fail",
    children: [
      { name: "adds", status: "pass", duration_ms: 5 },
      { name: "subtracts", status: "fail", duration_ms: 2, failure: { message: "2 - 1 is not 0", type: "AssertionError" } },
    ],
  },
];
const JUNIT_SUMMARY = { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 7 };

const STREAM_TREE = [
  {
    name: "Search",
    status: "pass",
    browser: "webkit",
    children: [
      {
        name: "Find a book",
        status: "pass",
        duration_ms: 5,
        steps: [
          { name: "Given the catalogue", status: "pass", duration_ms: 1 },
          { name: "When I search for Dune", status: "pass", duration_ms: 4 },
        ],
      },
    ],
  },
] as unknown as SuiteNode[];
const STREAM_SUMMARY = { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 };

const ROLLUP_BUCKET = "2026-01-01";

type Row = Record<string, unknown>;

/** Every stored row of one run, in key order: what "unchanged" is measured on. */
interface RunRows {
  event: Row | null;
  runs: Row[];
  details: Row[];
  suites: Row[];
  cases: Row[];
  steps: Row[];
}

function rowsOfRun(db: Database, eventId: string): RunRows {
  return {
    event: db.query<Row, [string]>("SELECT * FROM events WHERE id = ?").get(eventId),
    runs: db.query<Row, [string]>("SELECT * FROM runs WHERE event_id = ? ORDER BY run_id").all(eventId),
    details: db.query<Row, [string]>("SELECT * FROM run_details WHERE event_id = ?").all(eventId),
    suites: db.query<Row, [string]>("SELECT * FROM run_suites WHERE event_id = ? ORDER BY position").all(eventId),
    cases: db
      .query<Row, [string]>("SELECT * FROM run_cases WHERE event_id = ? ORDER BY suite_position, position")
      .all(eventId),
    steps: db
      .query<Row, [string]>(
        "SELECT * FROM run_case_steps WHERE event_id = ? ORDER BY suite_position, case_position, position",
      )
      .all(eventId),
  };
}

function rollupsOf(db: Database): Row[] {
  return db.query<Row, []>("SELECT * FROM rollups ORDER BY project_key, bucket").all();
}

/** Every row of every run table and the rollups: the whole store "unchanged" is measured on. */
function wholeStoreRows(db: Database): Record<string, Row[]> {
  const all = (sql: string): Row[] => db.query<Row, []>(sql).all();
  return {
    events: all("SELECT * FROM events ORDER BY id"),
    runs: all("SELECT * FROM runs ORDER BY run_id"),
    run_details: all("SELECT * FROM run_details ORDER BY event_id"),
    run_suites: all("SELECT * FROM run_suites ORDER BY event_id, position"),
    run_cases: all("SELECT * FROM run_cases ORDER BY event_id, suite_position, position"),
    run_case_steps: all("SELECT * FROM run_case_steps ORDER BY event_id, suite_position, case_position, position"),
    rollups: all("SELECT * FROM rollups ORDER BY project_key, bucket"),
  };
}

interface V24Ids {
  twoScenario: string;
  twoScenarioRunId: string;
  noStep: string;
  noSuite: string;
  junit: string;
  stream: string;
}

interface V24Store {
  dbPath: string;
  key: string;
  ids: V24Ids;
  /** Each run's rows as the v24 file holds them, read before it is reopened. */
  before: Record<keyof Omit<V24Ids, "twoScenarioRunId">, RunRows>;
  rollupsBefore: Row[];
}

/** The `feature` each suite of `eventId` held at v24, by position. */
function stampV24Features(db: Database, eventId: string, features: readonly string[]): void {
  const set = db.query("UPDATE run_suites SET feature = ? WHERE event_id = ? AND position = ?");
  features.forEach((feature, position) => set.run(feature, eventId, position));
}

/** Walk a store from this build back to v24: the v24 `feature` values, then the version stamp. */
function walkBackToV24(dbPath: string, features: ReadonlyArray<{ eventId: string; features: readonly string[] }>): void {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    for (const run of features) stampV24Features(db, run.eventId, run.features);
    db.exec(`PRAGMA user_version = ${PRE_MIGRATION_VERSION}`);
  } finally {
    db.close();
  }
}

/**
 * A v24 store holding the five runs AC names: the two-scenario codec run
 * (closed through a started run, so it has a `runs` row), the no-step codec
 * run, the no-suite codec run, a junit run with a suite named `A › B`, and a
 * `crucible-events` run — plus one rollup row.
 */
function makeV24Store(): V24Store {
  const dbPath = scratchDbPath();
  const store = Store.open(dbPath);
  const key = crypto.randomUUID();
  store.addProject({ key, name: "scenario-shape", type: "frontend", sutRoot: "/tmp/scenario-shape" });

  const runId = store.startRun(key, AGENT, { tier: "e2e", stack: "bun" }).runId;
  const twoScenario = store.recordTestEvent(
    key,
    AGENT,
    { summary: TWO_SCENARIO_SUMMARY, tree: TWO_SCENARIO_TREE },
    { tier: "e2e", stack: "bun", codec: "playwright" },
  ).id;
  expect(store.endRun(runId, twoScenario, Date.now())).toBe(true);

  const noStep = store.recordTestEvent(
    key,
    AGENT,
    { summary: NO_STEP_SUMMARY, tree: NO_STEP_TREE },
    { tier: "e2e", stack: "bun", codec: "playwright" },
  ).id;
  const noSuite = store.recordTestEvent(
    key,
    AGENT,
    { summary: NO_SUITE_SUMMARY, tree: [] },
    { tier: "e2e", stack: "bun", codec: "playwright" },
  ).id;
  const junit = store.recordTestEvent(
    key,
    AGENT,
    { summary: JUNIT_SUMMARY, tree: JUNIT_TREE },
    { tier: "unit", stack: "bun", codec: "junit" },
  ).id;
  const stream = store.recordTestEvent(
    key,
    AGENT,
    { summary: STREAM_SUMMARY, tree: STREAM_TREE },
    { tier: "bdd", stack: "bun", framework: "playwright-bdd", codec: "crucible-events" },
  ).id;
  dbOf(store)
    .query(
      `INSERT INTO rollups (project_key, bucket, runs, passed, failed, duration_ms, last_coverage)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(key, ROLLUP_BUCKET, 3, 11, 1, 40, null);
  dbOf(store).close();

  walkBackToV24(dbPath, [
    { eventId: twoScenario, features: ["Checkout", "Checkout"] },
    { eventId: noStep, features: ["Login"] },
    { eventId: junit, features: ["A"] },
    { eventId: stream, features: ["Search"] },
  ]);

  const raw = new Database(dbPath, { readonly: true });
  try {
    expect(rawUserVersion(raw)).toBe(PRE_MIGRATION_VERSION);
    return {
      dbPath,
      key,
      ids: { twoScenario, twoScenarioRunId: runId, noStep, noSuite, junit, stream },
      before: {
        twoScenario: rowsOfRun(raw, twoScenario),
        noStep: rowsOfRun(raw, noStep),
        noSuite: rowsOfRun(raw, noSuite),
        junit: rowsOfRun(raw, junit),
        stream: rowsOfRun(raw, stream),
      },
      rollupsBefore: rollupsOf(raw),
    };
  } finally {
    raw.close();
  }
}

// ── the reference: the same scenarios streamed ───────────────────────────

function testEnd(fields: Record<string, unknown>): string {
  return eventLine({ event: "test-end", ...fields });
}

/** The two-scenario run as the stream states it. */
const TWO_SCENARIO_STREAM =
  eventLine({ event: "run-start", total: 2 }) +
  testEnd({
    id: "s1",
    suite: "Checkout",
    name: "Pay by card",
    browser: "chromium",
    status: "pass",
    duration_ms: 7,
    steps: [
      { name: "Given a cart", status: "pass", duration_ms: 3 },
      { name: "When I pay by card", status: "pass", duration_ms: 4 },
    ],
  }) +
  testEnd({
    id: "s2",
    suite: "Checkout",
    name: "Pay by voucher",
    browser: "chromium",
    status: "fail",
    duration_ms: 8,
    failure: { message: "voucher expired", type: "AssertionError", trace: "at redeem (step 2)" },
    steps: [
      { name: "Given a voucher", status: "pass", duration_ms: 2 },
      {
        name: "When I redeem it",
        status: "fail",
        duration_ms: 6,
        failure: { message: "voucher expired", type: "AssertionError", trace: "at redeem (step 2)" },
      },
      { name: "Then I see the receipt", status: "pending", duration_ms: 0 },
    ],
  }) +
  eventLine({ event: "run-end", total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 20 });

/** The no-step run as the stream states it: a failing scenario with no step and no failure parts. */
const NO_STEP_STREAM =
  eventLine({ event: "run-start", total: 1 }) +
  testEnd({ id: "s1", suite: "Login", name: "Sign in", browser: "firefox", status: "fail", duration_ms: 0 }) +
  eventLine({ event: "run-end", total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 9 });

/** Stream `text` into a fresh run of framework `playwright-bdd` on `handle`, closed; answers its event id. */
async function streamRun(handle: ServerHandle, key: string, text: string): Promise<string> {
  const runId = await openRun(handle, key, AGENT, { tier: "e2e", stack: "bun", framework: "playwright-bdd" });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const closed = await closeStream(handle, key, AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  // The close answers the stored event's id as `event`.
  const eventId = closed.body.event;
  expect(typeof eventId, JSON.stringify(closed.body)).toBe("string");
  return eventId as string;
}

/** What the event, suite and case reads answer for a run: its scenario content, not its identity. */
async function readsOf(
  handle: ServerHandle,
  eventId: string,
  suite: { name: string; browser: string },
): Promise<Record<string, unknown>> {
  const pick = (event: Record<string, unknown>): Record<string, unknown> => ({
    kind: event.kind,
    tier: event.tier,
    stack: event.stack,
    framework: event.framework,
    summary: event.summary,
    tree: event.tree,
  });
  const full = (await getJson(handle, `/api/v2/events/${eventId}`)).event as Record<string, unknown>;
  const suites = (await getJson(handle, `/api/v2/events/${eventId}?depth=suites`)).event as Record<string, unknown>;
  const one = (
    await getJson(
      handle,
      `/api/v2/events/${eventId}?suite=${encodeURIComponent(suite.name)}&browser=${encodeURIComponent(suite.browser)}`,
    )
  ).event as Record<string, unknown>;
  return { full: pick(full), suites: pick(suites), suite: pick(one) };
}

// ── the tests ────────────────────────────────────────────────────────────

describe("a v24 store's playwright-codec runs migrate to the playwright-bdd scenario shape at v25", () => {
  test("the schema version this build declares is 25", () => {
    expect(SCHEMA_VERSION).toBe(SCENARIO_SHAPE_VERSION);
  });

  test("a v24 store holding codec runs is migrated 24 → 25 and stamped 25", () => {
    const v24 = makeV24Store();
    const store = open(v24.dbPath);
    expect(store.migration?.from).toBe(PRE_MIGRATION_VERSION);
    expect(store.migration?.to).toBe(SCENARIO_SHAPE_VERSION);
    expect(store.schemaVersion).toBe(SCENARIO_SHAPE_VERSION);
    expect(rawUserVersion(dbOf(store))).toBe(SCENARIO_SHAPE_VERSION);
  });

  test("every codec run, and the two-scenario run's runs row, reads framework playwright-bdd with its codec still playwright", () => {
    const v24 = makeV24Store();
    // Preconditions, so the test can never pass by testing nothing.
    for (const run of [v24.before.twoScenario, v24.before.noStep, v24.before.noSuite]) {
      expect(run.event?.framework).toBeNull();
      expect(run.event?.codec).toBe("playwright");
    }
    expect(v24.before.twoScenario.runs).toHaveLength(1);
    expect(v24.before.twoScenario.runs[0]?.framework).toBeNull();

    const db = dbOf(open(v24.dbPath));
    const frameworkAndCodec = (id: string): Row | null =>
      db.query<Row, [string]>("SELECT framework, codec FROM events WHERE id = ?").get(id);
    expect(frameworkAndCodec(v24.ids.twoScenario)).toEqual({ framework: "playwright-bdd", codec: "playwright" });
    expect(frameworkAndCodec(v24.ids.noStep)).toEqual({ framework: "playwright-bdd", codec: "playwright" });
    expect(frameworkAndCodec(v24.ids.noSuite)).toEqual({ framework: "playwright-bdd", codec: "playwright" });
    expect(
      db.query<Row, [string]>("SELECT run_id, framework FROM runs WHERE event_id = ?").all(v24.ids.twoScenario),
    ).toEqual([{ run_id: v24.ids.twoScenarioRunId, framework: "playwright-bdd" }]);
  });

  test("the two-scenario codec run becomes one suite named by its feature, its feature that name and its browser kept, with one case per scenario: its status, its steps' summed duration and its first failing step's failure", () => {
    const v24 = makeV24Store();
    const id = v24.ids.twoScenario;
    const after = rowsOfRun(dbOf(open(v24.dbPath)), id);

    expect(after.suites).toEqual([
      {
        event_id: id,
        position: 0,
        name: "Checkout",
        status: "fail",
        browser: "chromium",
        feature: "Checkout",
        total: 2,
        passed: 1,
        failed: 1,
        pending: 0,
      },
    ]);
    expect(after.cases).toEqual([
      {
        event_id: id,
        suite_position: 0,
        position: 0,
        name: "Pay by card",
        status: "pass",
        duration_ms: 7,
        has_failure: 0,
        failure_message: null,
        failure_type: null,
        failure_trace: null,
      },
      {
        event_id: id,
        suite_position: 0,
        position: 1,
        name: "Pay by voucher",
        status: "fail",
        duration_ms: 8,
        has_failure: 1,
        failure_message: "voucher expired",
        failure_type: "AssertionError",
        failure_trace: "at redeem (step 2)",
      },
    ]);
    expect(after.details).toEqual(v24.before.twoScenario.details);
  });

  test("the two-scenario codec run's old cases become its scenarios' 2 and 3 run_case_steps rows, in order, with their status, duration and failure, and none is left as a case", () => {
    const v24 = makeV24Store();
    const id = v24.ids.twoScenario;
    expect(v24.before.twoScenario.cases.map((c) => c.name)).toEqual([
      "Given a cart",
      "When I pay by card",
      "Given a voucher",
      "When I redeem it",
      "Then I see the receipt",
    ]);
    expect(v24.before.twoScenario.steps).toEqual([]);

    const after = rowsOfRun(dbOf(open(v24.dbPath)), id);
    const step = (
      casePosition: number,
      position: number,
      name: string,
      status: string,
      duration: number,
      failure: { message: string; type: string; trace: string } | null = null,
    ): Row => ({
      event_id: id,
      suite_position: 0,
      case_position: casePosition,
      position,
      name,
      status,
      duration_ms: duration,
      has_failure: failure === null ? 0 : 1,
      failure_message: failure?.message ?? null,
      failure_type: failure?.type ?? null,
      failure_trace: failure?.trace ?? null,
    });
    expect(after.steps).toEqual([
      step(0, 0, "Given a cart", "pass", 3),
      step(0, 1, "When I pay by card", "pass", 4),
      step(1, 0, "Given a voucher", "pass", 2),
      step(1, 1, "When I redeem it", "fail", 6, {
        message: "voucher expired",
        type: "AssertionError",
        trace: "at redeem (step 2)",
      }),
      step(1, 2, "Then I see the receipt", "pending", 0),
    ]);
    const stepNames = new Set(after.steps.map((s) => s.name));
    expect(after.cases.filter((c) => stepNames.has(c.name))).toEqual([]);
    expect(after.cases).toHaveLength(2);
  });

  test("the two-scenario codec run is recounted over its scenarios at total 2, passed 1, failed 1, pending 0, its duration_ms unchanged and nothing else of its event changed", () => {
    const v24 = makeV24Store();
    expect(v24.before.twoScenario.event).toMatchObject({ total: 5, passed: 3, failed: 1, pending: 1, duration_ms: 20 });

    const after = rowsOfRun(dbOf(open(v24.dbPath)), v24.ids.twoScenario);
    expect(after.event).toEqual({
      ...v24.before.twoScenario.event,
      framework: "playwright-bdd",
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
      duration_ms: 20,
    });
    expect(after.runs).toEqual(v24.before.twoScenario.runs.map((run) => ({ ...run, framework: "playwright-bdd" })));
  });

  test("the codec run whose one scenario failed with no step becomes one failing case carrying an empty failure, every part NULL, counted total 1, failed 1", () => {
    const v24 = makeV24Store();
    const id = v24.ids.noStep;
    expect(v24.before.noStep.cases).toEqual([]);

    const after = rowsOfRun(dbOf(open(v24.dbPath)), id);
    expect(after.suites).toEqual([
      {
        event_id: id,
        position: 0,
        name: "Login",
        status: "fail",
        browser: "firefox",
        feature: "Login",
        total: 1,
        passed: 0,
        failed: 1,
        pending: 0,
      },
    ]);
    expect(after.cases).toEqual([
      {
        event_id: id,
        suite_position: 0,
        position: 0,
        name: "Sign in",
        status: "fail",
        duration_ms: 0,
        has_failure: 1,
        failure_message: null,
        failure_type: null,
        failure_trace: null,
      },
    ]);
    expect(after.steps).toEqual([]);
    expect(after.event).toEqual({
      ...v24.before.noStep.event,
      framework: "playwright-bdd",
      total: 1,
      passed: 0,
      failed: 1,
      pending: 0,
      duration_ms: 9,
    });
  });

  test("the codec run with no suite gains framework playwright-bdd and nothing else", () => {
    const v24 = makeV24Store();
    expect(v24.before.noSuite.details).toHaveLength(1);
    expect(v24.before.noSuite.suites).toEqual([]);

    const after = rowsOfRun(dbOf(open(v24.dbPath)), v24.ids.noSuite);
    expect(after).toEqual({
      ...v24.before.noSuite,
      event: { ...v24.before.noSuite.event, framework: "playwright-bdd" },
    });
  });

  test("the junit run's suite named `A › B` reads feature NULL and the run is otherwise unchanged", () => {
    const v24 = makeV24Store();
    expect(v24.before.junit.suites.map((s) => s.feature)).toEqual(["A"]);

    const after = rowsOfRun(dbOf(open(v24.dbPath)), v24.ids.junit);
    expect(after.suites.map((s) => s.feature)).toEqual([null]);
    expect(after).toEqual({
      ...v24.before.junit,
      suites: v24.before.junit.suites.map((suite) => ({ ...suite, feature: null })),
    });
  });

  test("the crucible-events run is unchanged, its suite's feature still its name", () => {
    const v24 = makeV24Store();
    expect(v24.before.stream.suites.map((s) => s.feature)).toEqual(["Search"]);
    expect(v24.before.stream.steps).toHaveLength(2);

    const store = open(v24.dbPath);
    expect(store.migration?.to).toBe(SCENARIO_SHAPE_VERSION);
    expect(rowsOfRun(dbOf(store), v24.ids.stream)).toEqual(v24.before.stream);
  });

  test("the rollups rows are left as they were folded", () => {
    const v24 = makeV24Store();
    expect(v24.rollupsBefore).toEqual([
      { project_key: v24.key, bucket: ROLLUP_BUCKET, runs: 3, passed: 11, failed: 1, duration_ms: 40, last_coverage: null },
    ]);

    const store = open(v24.dbPath);
    expect(store.migration?.to).toBe(SCENARIO_SHAPE_VERSION);
    expect(rollupsOf(dbOf(store))).toEqual(v24.rollupsBefore);
  });

  test("GET /api/v2/events/<id>, ?depth=suites and ?suite= answer the migrated two-scenario run as they answer a crucible-events run of the same scenarios streamed through the run routes", async () => {
    const reference = boot(":memory:");
    const referenceKey = await readyProject(reference, [AGENT]);
    const referenceId = await streamRun(reference, referenceKey, TWO_SCENARIO_STREAM);
    const expected = await readsOf(reference, referenceId, { name: "Checkout", browser: "chromium" });
    // The reference is the scenario shape, so the comparison is never empty.
    expect((expected.full as { summary: unknown }).summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
      duration_ms: 20,
    });

    const v24 = makeV24Store();
    const migrated = boot(v24.dbPath);
    expect(migrated.store.migration?.to).toBe(SCENARIO_SHAPE_VERSION);
    expect(await readsOf(migrated, v24.ids.twoScenario, { name: "Checkout", browser: "chromium" })).toEqual(expected);
  });

  test("GET /api/v2/events/<id>, ?depth=suites and ?suite= answer the migrated no-step run as they answer a crucible-events run of the same failing scenario with no step", async () => {
    const reference = boot(":memory:");
    const referenceKey = await readyProject(reference, [AGENT]);
    const referenceId = await streamRun(reference, referenceKey, NO_STEP_STREAM);
    const expected = await readsOf(reference, referenceId, { name: "Login", browser: "firefox" });
    expect((expected.full as { tree: unknown }).tree).toEqual([
      {
        name: "Login",
        status: "fail",
        browser: "firefox",
        children: [{ name: "Sign in", status: "fail", duration_ms: 0, failure: {} }],
      },
    ]);

    const v24 = makeV24Store();
    const migrated = boot(v24.dbPath);
    expect(migrated.store.migration?.to).toBe(SCENARIO_SHAPE_VERSION);
    expect(await readsOf(migrated, v24.ids.noStep, { name: "Login", browser: "firefox" })).toEqual(expected);
  });
});

describe("a v24 store with no playwright-codec run", () => {
  test("opens at v25 with every run, its detail rows and the rollups unchanged", () => {
    const dbPath = scratchDbPath();
    const store = Store.open(dbPath);
    const key = crypto.randomUUID();
    store.addProject({ key, name: "no-codec", type: "backend", sutRoot: "/tmp/no-codec" });
    const junit = store.recordTestEvent(
      key,
      AGENT,
      {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 3 },
        tree: [{ name: "math", status: "pass", children: [{ name: "adds", status: "pass", duration_ms: 3 }] }],
      },
      { tier: "unit", stack: "bun", framework: "bun-test", codec: "junit" },
    ).id;
    const stream = store.recordTestEvent(
      key,
      AGENT,
      { summary: STREAM_SUMMARY, tree: STREAM_TREE },
      { tier: "bdd", stack: "bun", framework: "playwright-bdd", codec: "crucible-events" },
    ).id;
    dbOf(store)
      .query(
        `INSERT INTO rollups (project_key, bucket, runs, passed, failed, duration_ms, last_coverage)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, ROLLUP_BUCKET, 2, 4, 0, 12, null);
    dbOf(store).close();
    // At v24 a junit suite with no " › " held no feature; a playwright-bdd suite held its own name.
    const raw = new Database(dbPath);
    try {
      raw.exec("PRAGMA journal_mode = DELETE;");
      raw.query("UPDATE run_suites SET feature = NULL WHERE event_id = ?").run(junit);
      stampV24Features(raw, stream, ["Search"]);
      raw.exec(`PRAGMA user_version = ${PRE_MIGRATION_VERSION}`);
    } finally {
      raw.close();
    }
    const snapshot = new Database(dbPath, { readonly: true });
    let before: Record<string, Row[]>;
    try {
      expect(rawUserVersion(snapshot)).toBe(PRE_MIGRATION_VERSION);
      before = wholeStoreRows(snapshot);
    } finally {
      snapshot.close();
    }
    expect(before.events).toHaveLength(2);
    expect(before.run_case_steps).toHaveLength(2);

    const migrated = open(dbPath);
    expect(migrated.migration?.from).toBe(PRE_MIGRATION_VERSION);
    expect(migrated.migration?.to).toBe(SCENARIO_SHAPE_VERSION);
    expect(rawUserVersion(dbOf(migrated))).toBe(SCENARIO_SHAPE_VERSION);
    expect(wholeStoreRows(dbOf(migrated))).toEqual(before);
  });
});
