// A test run's tree, raw output and compile report must come off a
// schema-v15 store (no run_details/run_suites/run_cases/run_compiles/
// run_diagnostics tables — the shape every store had before the "run detail
// as native rows" migration (C1) ever ran) and land in those native tables,
// with the legacy events.tree / events.compile / payload.raw columns emptied
// and the file compacted. RED: the data-moving step does not exist yet, so a
// legacy store opened today only gains the (empty) tables C1 added — the
// legacy columns are never cleared and the progressive reads still leak
// `raw`.
//
// "Before" vs "after" is built the way tests/store-migration.test.ts builds
// a pre-upgrade fixture (see its `makePreCycleIdStore`): open a REAL Store to
// get the current production schema, then walk it back across exactly what
// the step under test adds — here, drop the five run-detail tables and their
// indexes and re-stamp user_version at 15. The "after" copy is opened with the
// real default chain, the one production code always uses. The "before"
// answers are the fixture's OWN data (`preMigrationAnswer`): each run's full
// event as it was written into the legacy columns, and the ?depth=suites /
// ?suite= shapes computed from that definition the way the handler shapes
// them — never read back through this build, which no longer reads the
// legacy columns at all.
//
// Route-level, through the real dispatcher (`handleV2`) — never a bespoke
// reimplementation of the reshaping it does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.ts";
import { handleV2 } from "../src/v2.ts";
import type { V2Deps } from "../src/v2.ts";
import type { SuiteNode, Tier } from "../src/types.ts";
import type { CompileReport } from "../src/codecs/compile.ts";

interface LegacyRunDef {
  id: string;
  kind: "test" | "compile";
  tier: Tier;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree?: SuiteNode[];
  compile?: CompileReport;
  raw?: string;
}

/** Builds a store SHAPED like one written before C1 ever ran: no detail
 *  tables, every run's tree/compile/raw in the legacy events.tree /
 *  events.compile / payload.raw columns, user_version stamped at 15. */
function buildLegacyStore(dbPath: string, runs: readonly LegacyRunDef[]): void {
  const boot = new Store(dbPath);
  const db = (boot as unknown as { db: Database }).db;
  db.exec("PRAGMA journal_mode = DELETE;"); // no -wal/-shm sidecar to copy
  db.exec(`
    DROP INDEX IF EXISTS idx_run_suites_name;
    DROP INDEX IF EXISTS idx_run_suites_feature;
    DROP TABLE IF EXISTS run_cases;
    DROP TABLE IF EXISTS run_suites;
    DROP TABLE IF EXISTS run_diagnostics;
    DROP TABLE IF EXISTS run_compiles;
    DROP TABLE IF EXISTS run_details;
  `);
  db.query(
    `INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run("legacy-proj", "Legacy", "backend", "/tmp/legacy", 1000);
  const insert = db.query(
    `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp,
       total, passed, failed, pending, duration_ms, tree, compile, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  runs.forEach((run, i) => {
    const payload = run.raw !== undefined ? JSON.stringify({ raw: run.raw }) : null;
    insert.run(
      run.id,
      "legacy-proj",
      "legacy-agent",
      run.kind,
      run.tier,
      1_000_000 + i,
      run.summary?.total ?? null,
      run.summary?.passed ?? null,
      run.summary?.failed ?? null,
      run.summary?.pending ?? null,
      run.summary?.duration_ms ?? null,
      run.tree !== undefined ? JSON.stringify(run.tree) : null,
      run.compile !== undefined ? JSON.stringify(run.compile) : null,
      payload,
    );
  });
  db.exec("PRAGMA user_version = 15;");
  db.close();
}

function userVersionOf(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
  } finally {
    db.close();
  }
}

function legacyColumnsOf(dbPath: string, id: string): { tree: string | null; compile: string | null; payload: string | null } {
  const db = new Database(dbPath);
  try {
    return (
      db
        .query<{ tree: string | null; compile: string | null; payload: string | null }, [string]>(
          `SELECT tree, compile, payload FROM events WHERE id = ?`,
        )
        .get(id) ?? { tree: null, compile: null, payload: null }
    );
  } finally {
    db.close();
  }
}

/** Every "<id>.<legacy column>" still holding a run's detail, anywhere in
 *  the store — the generic, whole-table version of the per-run check above. */
function legacyDetailSurvivors(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    const rows = db
      .query<{ id: string; tree: string | null; compile: string | null; payload: string | null }, []>(
        `SELECT id, tree, compile, payload FROM events`,
      )
      .all();
    const hits: string[] = [];
    for (const row of rows) {
      if (row.tree !== null) hits.push(`${row.id}.tree`);
      if (row.compile !== null) hits.push(`${row.id}.compile`);
      if (row.payload !== null && "raw" in (JSON.parse(row.payload) as Record<string, unknown>)) {
        hits.push(`${row.id}.payload.raw`);
      }
    }
    return hits;
  } finally {
    db.close();
  }
}

const PRE_UPGRADE_RE = /\.pre-upgrade-\d+$/;

function preUpgradeSiblings(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => PRE_UPGRADE_RE.test(f));
}

const deps: V2Deps = { version: "test-rehearsal", healthPayload: () => ({}) };

interface GetV2Result {
  status: number;
  event: Record<string, unknown>;
}

/** Drives the REAL route dispatcher directly against an opened Store — no
 *  network, same production code `startServer` wires to Bun.serve. */
async function getV2(store: Store, pathAndQuery: string): Promise<GetV2Result> {
  const req = new Request(`http://localhost${pathAndQuery}`);
  const res = await handleV2(store, req, new URL(req.url), deps);
  if (res === null) {
    throw new Error(`no v2 route matched ${pathAndQuery}`);
  }
  const body = (await res.json()) as { ok: boolean; event?: Record<string, unknown>; error?: string };
  if (body.ok !== true || body.event === undefined) {
    throw new Error(`GET ${pathAndQuery} answered ${res.status}: ${JSON.stringify(body)}`);
  }
  return { status: res.status, event: body.event };
}

/** A pre-migration answer as a progressive read (?depth=suites / ?suite=)
 *  answers it after the migration: no `raw`, and `rawBytes` — the raw
 *  output's UTF-8 byte length — when the run has raw output. */
function asProgressiveRead(event: Record<string, unknown>): Record<string, unknown> {
  const { raw, ...rest } = event;
  return typeof raw === "string" ? { ...rest, rawBytes: Buffer.byteLength(raw, "utf8") } : rest;
}

// ── the six required shapes ─────────────────────────────────────────────

const JUNIT_TREE: SuiteNode[] = [
  {
    name: "SuiteA",
    status: "pass",
    children: [
      { name: "a1", status: "pass", duration_ms: 10 },
      { name: "a2", status: "pass", duration_ms: 12 },
    ],
  },
  {
    name: "SuiteB",
    status: "fail",
    children: [
      { name: "b1", status: "pass", duration_ms: 5 },
      {
        name: "b2",
        status: "fail",
        duration_ms: 7,
        failure: { message: "boom-b2", type: "AssertionError", trace: "at b2:1:1" },
      },
    ],
  },
];

const SCENARIO_NAME = "Checkout › completes purchase";
const PLAYWRIGHT_TREE: SuiteNode[] = [
  {
    name: SCENARIO_NAME,
    status: "pass",
    browser: "chromium",
    children: [{ name: "step", status: "pass", duration_ms: 20 }],
  },
  {
    name: SCENARIO_NAME,
    status: "fail",
    browser: "firefox",
    children: [
      { name: "step", status: "fail", duration_ms: 15, failure: { message: "timeout", type: "TimeoutError" } },
    ],
  },
];

const COMPILE_REPORT: CompileReport = {
  format: "rustc",
  errorCount: 1,
  warningCount: 1,
  diagnostics: [
    { file: "src/lib.rs", line: 12, col: 5, code: "E0308", message: "mismatched types", level: "error" },
    { file: "src/a.rs", line: 1, col: 1, message: "unused import", level: "warning" },
  ],
  raw: "error[E0308]: mismatched types\n --> src/lib.rs:12:5\nwarning: unused import\n --> src/a.rs:1:1",
};

const RAW_BEARING_TREE: SuiteNode[] = [
  { name: "Suite1", status: "pass", children: [{ name: "c1", status: "pass", duration_ms: 1 }] },
];
const RAW_BEARING_OUTPUT = "$ bun test\n3 pass, 0 fail\nraw runner output here";

const TYPE_ONLY_TREE: SuiteNode[] = [
  {
    name: "SuiteX",
    status: "fail",
    children: [{ name: "caseX", status: "fail", duration_ms: 3, failure: { type: "TimeoutError" } }],
  },
];

const DUPLICATE_SUITE_TREE: SuiteNode[] = [
  { name: "Login", status: "pass", children: [{ name: "first", status: "pass", duration_ms: 2 }] },
  {
    name: "Login",
    status: "fail",
    children: [{ name: "second", status: "fail", duration_ms: 3, failure: { message: "dup-fail" } }],
  },
];

const LEGACY_RUNS: readonly LegacyRunDef[] = [
  {
    id: "legacy-junit",
    kind: "test",
    tier: "unit",
    summary: { total: 4, passed: 3, failed: 1, pending: 0, duration_ms: 34 },
    tree: JUNIT_TREE,
    raw: "junit run stdout\nOK (4 tests)",
  },
  {
    id: "legacy-playwright",
    kind: "test",
    tier: "e2e",
    summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 35 },
    tree: PLAYWRIGHT_TREE,
    raw: "playwright run log\n2 tests, 1 failed",
  },
  {
    id: "legacy-compile",
    kind: "compile",
    tier: "module",
    compile: COMPILE_REPORT,
  },
  {
    id: "legacy-raw-bearing",
    kind: "test",
    tier: "unit",
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
    tree: RAW_BEARING_TREE,
    raw: RAW_BEARING_OUTPUT,
  },
  {
    id: "legacy-type-only-failure",
    kind: "test",
    tier: "unit",
    summary: { total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 3 },
    tree: TYPE_ONLY_TREE,
    raw: "unit runner raw log — timeout",
  },
  {
    id: "legacy-duplicate-suite",
    kind: "test",
    tier: "unit",
    summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 5 },
    tree: DUPLICATE_SUITE_TREE,
    raw: "duplicate-suite raw log",
  },
];

/** The project, agent and timestamps `buildLegacyStore` writes every run under. */
const LEGACY_PROJECT_KEY = "legacy-proj";
const LEGACY_AGENT_ID = "legacy-agent";

/** The pre-migration answer to a read of run `id`, from the fixture's own
 *  definition: the full event as `buildLegacyStore` wrote it (tree, raw and
 *  compile included), `?depth=suites` as its suites with leaf counts, and
 *  `?suite=` as its first suite of that name (and browser), fully expanded. */
function preMigrationAnswer(
  id: string,
  query: { depth?: "suites"; suite?: string; browser?: string } = {},
): { event: Record<string, unknown> } {
  const index = LEGACY_RUNS.findIndex((r) => r.id === id);
  const run = LEGACY_RUNS[index];
  if (run === undefined) throw new Error(`no legacy run ${id}`);
  const event: Record<string, unknown> = {
    id: run.id,
    projectKey: LEGACY_PROJECT_KEY,
    agentId: LEGACY_AGENT_ID,
    kind: run.kind,
    tier: run.tier,
    timestamp: 1_000_000 + index,
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(run.raw !== undefined ? { raw: run.raw } : {}),
    ...(run.tree !== undefined ? { tree: run.tree } : {}),
    ...(run.compile !== undefined ? { compile: run.compile } : {}),
  };
  const tree = run.tree ?? [];
  if (query.suite !== undefined) {
    const match = tree.find(
      (node) => node.name === query.suite && (query.browser === undefined || node.browser === query.browser),
    );
    if (match === undefined) throw new Error(`no suite ${query.suite} in legacy run ${id}`);
    return { event: { ...event, tree: [match] } };
  }
  if (query.depth === "suites" && run.tree !== undefined) {
    const count = (node: SuiteNode, status: string): number =>
      node.children.filter((leaf) => leaf.status === status).length;
    return {
      event: {
        ...event,
        tree: run.tree.map((node) => ({
          name: node.name,
          status: node.status,
          counts: { passed: count(node, "pass"), failed: count(node, "fail"), pending: count(node, "pending") },
          ...(node.browser !== undefined ? { browser: node.browser } : {}),
        })),
      },
    };
  }
  return { event };
}

describe("migrating a schema-v15 store into native run-detail rows", () => {
  const dirs: string[] = [];
  let baseDbPath: string;
  let afterDir: string;
  let afterDbPath: string;
  let afterStore: Store;

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-detail-migration-"));
    dirs.push(root);
    const baseDir = path.join(root, "base");
    afterDir = path.join(root, "after");
    fs.mkdirSync(baseDir);
    fs.mkdirSync(afterDir);

    baseDbPath = path.join(baseDir, "crucible.db");
    buildLegacyStore(baseDbPath, LEGACY_RUNS);

    afterDbPath = path.join(afterDir, "crucible.db");
    fs.copyFileSync(baseDbPath, afterDbPath);

    afterStore = Store.open(afterDbPath);
  });

  afterAll(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  test("precondition: the base fixture really is a schema-v15 store with every run's detail still in its legacy columns", () => {
    expect(userVersionOf(baseDbPath)).toBe(15);
    for (const run of LEGACY_RUNS) {
      const cols = legacyColumnsOf(baseDbPath, run.id);
      if (run.tree !== undefined) expect(cols.tree).not.toBeNull();
      if (run.compile !== undefined) expect(cols.compile).not.toBeNull();
      if (run.raw !== undefined) {
        expect(cols.payload).not.toBeNull();
        expect("raw" in (JSON.parse(cols.payload as string) as Record<string, unknown>)).toBe(true);
      }
    }
  });

  test("a junit-shaped run's full, depth=suites and every suite read match the pre-migration answers (minus raw on the progressive reads), and its legacy columns are emptied", async () => {
    const id = "legacy-junit";

    const beforeFull = preMigrationAnswer(id);
    const afterFull = await getV2(afterStore, `/api/v2/events/${id}`);
    expect(afterFull.event).toEqual(beforeFull.event);
    expect(afterFull.event.tree).toEqual(JUNIT_TREE);
    expect(afterFull.event.raw).toBe("junit run stdout\nOK (4 tests)");

    const beforeSuites = preMigrationAnswer(id, { depth: "suites" });
    const afterSuites = await getV2(afterStore, `/api/v2/events/${id}?depth=suites`);
    expect("raw" in afterSuites.event).toBe(false);
    expect(afterSuites.event).toEqual(asProgressiveRead(beforeSuites.event));
    expect(afterSuites.event.tree).toEqual([
      { name: "SuiteA", status: "pass", counts: { passed: 2, failed: 0, pending: 0 } },
      { name: "SuiteB", status: "fail", counts: { passed: 1, failed: 1, pending: 0 } },
    ]);

    for (const name of ["SuiteA", "SuiteB"]) {
      const beforeSuite = preMigrationAnswer(id, { suite: name });
      const afterSuite = await getV2(afterStore, `/api/v2/events/${id}?suite=${name}`);
      expect("raw" in afterSuite.event).toBe(false);
      expect(afterSuite.event).toEqual(asProgressiveRead(beforeSuite.event));
    }
    const suiteBAfter = await getV2(afterStore, `/api/v2/events/${id}?suite=SuiteB`);
    const b2 = (suiteBAfter.event.tree as Array<{ children: Array<{ name: string; failure?: unknown }> }>)[0]!
      .children.find((c) => c.name === "b2")!;
    expect(b2.failure).toEqual({ message: "boom-b2", type: "AssertionError", trace: "at b2:1:1" });

    const cols = legacyColumnsOf(afterDbPath, id);
    expect(cols.tree).toBeNull();
    expect(cols.payload === null || !("raw" in (JSON.parse(cols.payload) as Record<string, unknown>))).toBe(
      true,
    );
  });

  test("a playwright-shaped run's browser-qualified names and per-browser suite reads match the pre-migration answers, and its legacy tree column is emptied", async () => {
    const id = "legacy-playwright";
    const encoded = encodeURIComponent(SCENARIO_NAME);

    const beforeSuites = preMigrationAnswer(id, { depth: "suites" });
    const afterSuites = await getV2(afterStore, `/api/v2/events/${id}?depth=suites`);
    expect("raw" in afterSuites.event).toBe(false);
    expect(afterSuites.event).toEqual(asProgressiveRead(beforeSuites.event));
    const tree = afterSuites.event.tree as Array<{ name: string; browser?: string; status: string }>;
    const byBrowser = Object.fromEntries(tree.map((n) => [n.browser, n]));
    expect(byBrowser.chromium?.name).toBe(SCENARIO_NAME);
    expect(byBrowser.chromium?.status).toBe("pass");
    expect(byBrowser.firefox?.status).toBe("fail");

    for (const browser of ["chromium", "firefox"]) {
      const beforeSuite = preMigrationAnswer(id, { suite: SCENARIO_NAME, browser });
      const afterSuite = await getV2(afterStore, `/api/v2/events/${id}?suite=${encoded}&browser=${browser}`);
      expect("raw" in afterSuite.event).toBe(false);
      expect(afterSuite.event).toEqual(asProgressiveRead(beforeSuite.event));
    }
    const firefoxSuite = await getV2(afterStore, `/api/v2/events/${id}?suite=${encoded}&browser=firefox`);
    const firefoxTree = firefoxSuite.event.tree as Array<{ browser?: string; children: Array<{ failure?: { message: string } }> }>;
    expect(firefoxTree[0]?.browser).toBe("firefox");
    expect(firefoxTree[0]?.children[0]?.failure?.message).toBe("timeout");

    expect(legacyColumnsOf(afterDbPath, id).tree).toBeNull();
  });

  test("a compile report's full read matches the pre-migration answer, and its legacy JSON compile column is emptied", async () => {
    const id = "legacy-compile";

    const beforeFull = preMigrationAnswer(id);
    const afterFull = await getV2(afterStore, `/api/v2/events/${id}`);
    expect(afterFull.event).toEqual(beforeFull.event);
    expect(afterFull.event.compile).toEqual(COMPILE_REPORT);

    expect(legacyColumnsOf(afterDbPath, id).compile).toBeNull();
  });

  test("a run's raw output is preserved by the full read after migration, but absent from its depth=suites and suite reads — unlike the pre-migration answers, which still carried it", async () => {
    const id = "legacy-raw-bearing";

    const afterFull = await getV2(afterStore, `/api/v2/events/${id}`);
    expect(afterFull.event.raw).toBe(RAW_BEARING_OUTPUT);

    const afterSuites = await getV2(afterStore, `/api/v2/events/${id}?depth=suites`);
    expect("raw" in afterSuites.event).toBe(false);

    const afterSuite = await getV2(afterStore, `/api/v2/events/${id}?suite=Suite1`);
    expect("raw" in afterSuite.event).toBe(false);

    const cols = legacyColumnsOf(afterDbPath, id);
    expect(cols.payload === null || !("raw" in (JSON.parse(cols.payload) as Record<string, unknown>))).toBe(
      true,
    );
  });

  test("a failure stored with only its type (no message, no trace) migrates and reads back unchanged, and its legacy tree column is emptied", async () => {
    const id = "legacy-type-only-failure";

    const beforeSuite = preMigrationAnswer(id, { suite: "SuiteX" });
    const afterSuite = await getV2(afterStore, `/api/v2/events/${id}?suite=SuiteX`);
    expect("raw" in afterSuite.event).toBe(false);
    expect(afterSuite.event).toEqual(asProgressiveRead(beforeSuite.event));
    const caseX = (afterSuite.event.tree as Array<{ children: Array<{ name: string; failure?: unknown }> }>)[0]!
      .children.find((c) => c.name === "caseX")!;
    expect(caseX.failure).toEqual({ type: "TimeoutError" });
    expect("message" in (caseX.failure as object)).toBe(false);
    expect("trace" in (caseX.failure as object)).toBe(false);

    expect(legacyColumnsOf(afterDbPath, id).tree).toBeNull();
  });

  test("two suites sharing the same name keep their posted order after migration, and suite= still answers the first — unchanged from the pre-migration answer", async () => {
    const id = "legacy-duplicate-suite";

    const beforeSuite = preMigrationAnswer(id, { suite: "Login" });
    const afterSuite = await getV2(afterStore, `/api/v2/events/${id}?suite=Login`);
    expect("raw" in afterSuite.event).toBe(false);
    expect(afterSuite.event).toEqual(asProgressiveRead(beforeSuite.event));
    const tree = afterSuite.event.tree as Array<{ status: string; children: Array<{ name: string }> }>;
    expect(tree.length).toBe(1);
    expect(tree[0]?.status).toBe("pass");
    expect(tree[0]?.children[0]?.name).toBe("first");

    const afterFull = await getV2(afterStore, `/api/v2/events/${id}`);
    expect((afterFull.event.tree as unknown[]).length).toBe(2);

    expect(legacyColumnsOf(afterDbPath, id).tree).toBeNull();
  });

  test("after migration no legacy JSON column holds any run's tree, compile report or raw output, anywhere in the store, and the pre-upgrade backup exists", () => {
    expect(legacyDetailSurvivors(afterDbPath)).toEqual([]);

    const backups = preUpgradeSiblings(afterDir);
    expect(backups.length).toBe(1);
    expect(backups[0]).toMatch(/^crucible\.db\.pre-upgrade-\d+$/);
  });
});
