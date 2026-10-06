// `Store.listEvents`, `Store.listEventsForCycle`, `Store.newestEvent` and
// `GET /api/v2/status` (which drives `listEvents` under the hood) answer every
// caller with `eventBrief`s — summary counts, coverage, a compile report's
// counts and its first two diagnostics, the gate/milestone/lifecycle fields —
// and NEVER a run's suite/case tree or its raw output (`eventBrief`, src/v2.ts,
// carries neither key). Today every one of those four reads still goes
// through `Store.toEvents` -> `Store.loadRunDetails(ids)` with the tree+raw
// switch left ON (the default), so each one pulls every row of `run_suites`,
// `run_cases` and `run_details` for every test/compile run on the page before
// throwing the detail away — exactly the cost `loadRunDetails`'s own
// `treeAndRaw` parameter exists to let a caller skip (`getEvent`'s progressive
// branch already asks for `treeAndRaw = false`).
//
// RED: each test below seeds ONE test run (a tree of 2 suites x 3 cases, plus
// raw output) and ONE compile run (3 diagnostics), both bound to the same
// cycle, then drives the REAL route dispatcher and counts the rows SQLite
// hands back per table while it answers (never timing — the <100ms AC is
// measured separately, at VERIFY, on a dev-store copy). `run_suites`,
// `run_cases` and `run_details` must each be EXACTLY 0; `run_compiles` and
// `run_diagnostics` must stay > 0, and the answer must still carry the
// compile report's exact counts and its first two diagnostics — so a fix that
// simply stops reading everything, compile included, is caught too.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Statement } from "bun:sqlite";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import type { SuiteNode } from "../src/types.ts";
import type { CompileReport } from "../src/codecs/compile.ts";

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

function boot(): ServerHandle {
  handle = startServer({ port: 0, dbPath: ":memory:" });
  return handle;
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${handle!.server.port}${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** 2 suites of 3 cases each — big enough that a wrong implementation reading
 *  it shows up as nonzero rows, never zero by accident. */
function sizedTree(): SuiteNode[] {
  return [1, 2].map((s) => ({
    name: `Suite${s}`,
    status: "pass" as const,
    children: [1, 2, 3].map((c) => ({
      name: `case-${s}-${c}`,
      status: "pass" as const,
      duration_ms: 1,
    })),
  }));
}

const THREE_DIAGNOSTICS_REPORT: CompileReport = {
  format: "tsc",
  errorCount: 2,
  warningCount: 1,
  diagnostics: [
    { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
    { file: "src/b.ts", line: 2, col: 5, code: "TS2304", message: "Cannot find name 'y'.", level: "error" },
    {
      file: "src/c.ts",
      line: 3,
      col: 9,
      code: "TS6133",
      message: "'z' is declared but never used.",
      level: "warning",
    },
  ],
  raw: "tsc raw tail — never read by a brief",
};

const CYCLE_ID = 4242;

/** One project: a tree+raw test run and a 3-diagnostic compile run, both
 *  bound to the SAME cycle, so the recent feed, the cycle read, `/status` and
 *  the projects list's newest-event read each have a tree/raw/diagnostic-
 *  bearing run to (not) hydrate. */
function seed(): { key: string } {
  const store = handle!.store;
  const key = crypto.randomUUID();
  store.addProject({ key, name: "rows-bounded", type: "backend", sutRoot: "/tmp/p" });
  store.recordTestEvent(
    key,
    "test-agent",
    {
      summary: { total: 6, passed: 6, failed: 0, pending: 0, duration_ms: 42 },
      tree: sizedTree(),
      raw: "the full captured run output — never read by a brief",
    },
    { context: { cycleId: CYCLE_ID } },
  );
  store.recordCompileEvent(key, "compile-agent", THREE_DIAGNOSTICS_REPORT, {
    context: { cycleId: CYCLE_ID },
  });
  return { key };
}

interface QueryRecord {
  sql: string;
  rows: number;
}

/** Every query the store's OWN connection issues while `body` runs, with the
 *  row count `.all()`/`.get()` actually handed back — never timing. Same
 *  instrumentation as
 *  tests/run-detail-progressive-reads-stay-bounded-and-omit-raw.test.ts and
 *  tests/projects-list-bounded-reads.test.ts. */
async function recordQueries(body: () => Promise<unknown>): Promise<QueryRecord[]> {
  const db = (handle!.store as unknown as { db: Database }).db;
  const query = db.query.bind(db);
  const records: QueryRecord[] = [];
  const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
    const stmt = query(sql) as Statement;
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "all" || prop === "values") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown[]).apply(target, args);
            records.push({ sql, rows: out.length });
            return out;
          };
        }
        if (prop === "get") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            records.push({ sql, rows: out !== null && out !== undefined ? 1 : 0 });
            return out;
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }) as typeof db.query);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return records;
}

function rowsFromTable(records: QueryRecord[], table: string): number {
  const re = new RegExp(`\\bFROM\\s+${table}\\b`, "i");
  return records.filter((r) => re.test(r.sql)).reduce((sum, r) => sum + r.rows, 0);
}

/** NEGATIVE/bound — exactly zero rows from the tree/case/raw tables, not
 *  "fewer than before"; POSITIVE — the compile tables stay readable, which is
 *  how the fix is kept honest (it may not just stop reading everything). */
function expectDetailTablesUntouched(records: QueryRecord[]): void {
  expect(rowsFromTable(records, "run_suites")).toBe(0);
  expect(rowsFromTable(records, "run_cases")).toBe(0);
  expect(rowsFromTable(records, "run_details")).toBe(0);
  expect(rowsFromTable(records, "run_compiles")).toBeGreaterThan(0);
  expect(rowsFromTable(records, "run_diagnostics")).toBeGreaterThan(0);
}

function expectCompileBriefIntact(brief: Record<string, unknown>): void {
  expect(brief.errors).toBe(2);
  expect(brief.warnings).toBe(1);
  expect(brief.diagnostics).toEqual([
    { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
    { file: "src/b.ts", line: 2, col: 5, code: "TS2304", message: "Cannot find name 'y'.", level: "error" },
  ]);
}

describe("event briefs are read with no run_suites, run_cases or run_details row", () => {
  test("the recent feed (GET /api/v2/events?project=) reads zero suite/case/detail rows", async () => {
    boot();
    const { key } = seed();

    let body!: Record<string, unknown>;
    const records = await recordQueries(async () => {
      body = await getJson(`/api/v2/events?project=${key}&limit=10`);
    });

    expectDetailTablesUntouched(records);
    const events = body.events as Array<Record<string, unknown>>;
    expect(events.length).toBe(2);
    const compileBrief = events.find((e) => e.kind === "compile")!;
    expectCompileBriefIntact(compileBrief);
  });

  test("a cycle's runs (GET /api/v2/events?project=&cycleId=) reads zero suite/case/detail rows", async () => {
    boot();
    const { key } = seed();

    let body!: Record<string, unknown>;
    const records = await recordQueries(async () => {
      body = await getJson(`/api/v2/events?project=${key}&cycleId=${CYCLE_ID}`);
    });

    expectDetailTablesUntouched(records);
    const events = body.events as Array<Record<string, unknown>>;
    expect(events.length).toBe(2);
    const compileBrief = events.find((e) => e.kind === "compile")!;
    expectCompileBriefIntact(compileBrief);
  });

  test("GET /api/v2/status reads zero suite/case/detail rows", async () => {
    boot();
    const { key } = seed();

    let body!: Record<string, unknown>;
    const records = await recordQueries(async () => {
      body = await getJson(`/api/v2/status?project=${key}`);
    });

    expectDetailTablesUntouched(records);
    const status = body.status as {
      hasData: boolean;
      lastTest: Record<string, unknown>;
      lastCompile: Record<string, unknown>;
    };
    expect(status.hasData).toBe(true);
    expect(status.lastTest.total).toBe(6);
    expect(status.lastTest.passed).toBe(6);
    expectCompileBriefIntact(status.lastCompile);
  });

  test("the projects list's newest-event read (GET /api/v2/projects) reads zero suite/case/detail rows", async () => {
    boot();
    const store = handle!.store;
    // TWO projects, so ONE `GET /api/v2/projects` exercises `newestEvent`
    // against BOTH kinds it must hydrate: project A's newest event is the
    // tree+raw TEST run (the case that must read zero suite/case/detail
    // rows); project B's newest event is the compile run (the case whose
    // counts and diagnostics must still come through).
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    store.addProject({ key: keyA, name: "rows-bounded-test-newest", type: "backend", sutRoot: "/tmp/pa" });
    store.addProject({ key: keyB, name: "rows-bounded-compile-newest", type: "backend", sutRoot: "/tmp/pb" });
    store.recordTestEvent(
      keyA,
      "test-agent",
      {
        summary: { total: 6, passed: 6, failed: 0, pending: 0, duration_ms: 42 },
        tree: sizedTree(),
        raw: "the full captured run output — never read by a brief",
      },
      {},
    );
    store.recordCompileEvent(keyB, "compile-agent", THREE_DIAGNOSTICS_REPORT, {});

    let body!: Record<string, unknown>;
    const records = await recordQueries(async () => {
      body = await getJson(`/api/v2/projects`);
    });

    expectDetailTablesUntouched(records);
    const projects = body.projects as Array<Record<string, unknown>>;
    const projectA = projects.find((p) => p.key === keyA)!;
    const projectB = projects.find((p) => p.key === keyB)!;
    const testBrief = projectA.lastEvent as Record<string, unknown>;
    expect(testBrief.total).toBe(6);
    expect(testBrief.passed).toBe(6);
    expectCompileBriefIntact(projectB.lastEvent as Record<string, unknown>);
  });
});
