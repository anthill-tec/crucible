// `POST /api/v2/runs` takes a run's coverage beside its reports:
//
//  - `coverage` is `{codec, data}`, `data` one coverage text or a non-empty
//    list of them, summed as one; an empty list is refused with 400 and
//    nothing is stored; an unknown coverage codec is refused with 400 and
//    nothing is stored;
//  - `lcov` sums `LF`/`LH` into lines and `FNF`/`FNH` into functions;
//    `jacoco` sums the CSV's `LINE_*`, `METHOD_*` and `BRANCH_*` columns
//    (missed + covered = total) into lines, functions and branches;
//  - each axis is `{total, covered, percent}`, the percent rounded as Python's
//    `round(covered / total * 100, 1)` and 0 when total is 0;
//  - a text the codec cannot decode (lcov: no `SF:` record; jacoco: no header
//    row with those columns) drops the coverage, stores the run and warns
//    `{code: "coverage-dropped", detail}`, the detail naming the codec;
//  - a failing run's coverage is discarded as on the parsed route, with the
//    same `coverageDropped` hint;
//  - the response's `run` block carries the kept coverage as
//    `coverage: {lines, functions, branches?}`.
//
// Every expected coverage object below is what the clients compute today on
// the same text: `_parse_lcov` (clients/bun-crucible.py) and `_collect_jacoco`
// (clients/mvn-crucible.py), run on these exact texts. Driven through the real
// production HTTP surface (`startServer`, in-memory store); every stored
// outcome is read back through the board's own reads — the run detail
// `GET /api/v2/events/<id>` and the events list.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { loadCoveragePercentOracle } from "./helpers/coverage-percent-oracle.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Posted> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A project with one registered (unbound) agent, ready to ingest. */
async function ready(handle: ServerHandle, agentId: string): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
  return key;
}

interface Axis {
  total: number;
  covered: number;
  percent: number;
}

interface CoverageObject {
  lines: Axis;
  functions?: Axis;
  branches?: Axis;
}

interface StoredEvent {
  id: string;
  summary?: { total: number; passed: number; failed: number; pending: number };
  coverage?: CoverageObject;
  [key: string]: unknown;
}

async function storedEvent(handle: ServerHandle, eventId: string): Promise<StoredEvent> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  return body.event as StoredEvent;
}

interface Brief {
  id: string;
  total: number;
  passed: number;
  failed: number;
  hasCoverage: boolean;
  coverageLines?: number;
}

async function briefs(handle: ServerHandle, key: string): Promise<Brief[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return body.events as Brief[];
}

function runBlock(body: Record<string, unknown>): Record<string, unknown> {
  expect(typeof body.run).toBe("object");
  return body.run as Record<string, unknown>;
}

interface Warning {
  code: string;
  detail: string;
}

// ── Test reports ────────────────────────────────────────────────────────────

/** 2 passed. */
const PASSING_REPORT = [
  '<testsuite name="Green" tests="2">',
  '<testcase name="g1" time="0.01"/>',
  '<testcase name="g2" time="0.02"/>',
  "</testsuite>",
].join("\n");

/** 1 passed, 1 failed. */
const FAILING_REPORT = [
  '<testsuite name="Red" tests="2">',
  '<testcase name="r1" time="0.01"/>',
  '<testcase name="r2" time="0.02"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

// ── lcov texts ──────────────────────────────────────────────────────────────

/**
 * Two `SF:` records in one text: lines 40+40 total, 30+1 hit; functions 3+1
 * total, 2+0 hit. Branch records (`BRF`/`BRH`) are present and NOT summed.
 * Client: lines {80, 31, 38.8}, functions {4, 2, 50}.
 */
const LCOV_TWO_RECORDS = [
  "TN:",
  "SF:src/alpha.ts",
  "FN:1,alpha",
  "FNDA:1,alpha",
  "FNF:3",
  "FNH:2",
  "DA:1,1",
  "LF:40",
  "LH:30",
  "BRF:4",
  "BRH:1",
  "end_of_record",
  "SF:src/beta.ts",
  "FNF:1",
  "FNH:0",
  "LF:40",
  "LH:1",
  "BRF:2",
  "BRH:2",
  "end_of_record",
  "",
].join("\n");

/** One record, every line and function hit. Client: lines {23, 23, 100}, functions {2, 2, 100}. */
const LCOV_ALL_HIT = [
  "SF:src/gamma.ts",
  "FNF:2",
  "FNH:2",
  "LF:23",
  "LH:23",
  "end_of_record",
  "",
].join("\n");

/**
 * One record with no function records at all, 1 line hit of 80 — Python's
 * tie to even. Client: lines {80, 1, 1.2}, functions {0, 0, 0}.
 */
const LCOV_ONE_OF_EIGHTY = ["SF:src/delta.ts", "DA:1,1", "LF:80", "LH:1", "end_of_record", ""].join(
  "\n",
);

/** Line counters but no `SF:` record — undecodable. */
const LCOV_NO_SOURCE_FILE = ["TN:", "LF:10", "LH:5", "end_of_record", ""].join("\n");

// ── JaCoCo CSV texts ────────────────────────────────────────────────────────

const JACOCO_HEADER =
  "GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,BRANCH_COVERED," +
  "LINE_MISSED,LINE_COVERED,COMPLEXITY_MISSED,COMPLEXITY_COVERED,METHOD_MISSED,METHOD_COVERED";

/**
 * Two classes. LINE missed 4+1, covered 36+19; METHOD missed 1+0, covered
 * 9+4; BRANCH missed 3+0, covered 5+0. INSTRUCTION and COMPLEXITY are not
 * summed. Client: lines {60, 55, 91.7}, functions {14, 13, 92.9},
 * branches {8, 5, 62.5}.
 */
const JACOCO_APP = [
  JACOCO_HEADER,
  "app,com.acme,Foo,10,90,3,5,4,36,2,8,1,9",
  "app,com.acme,Bar,7,50,0,0,1,19,0,4,0,4",
  "",
].join("\n");

/**
 * One class, nothing covered: LINE 20 missed, METHOD 1 missed, BRANCH 2
 * missed. Summed with JACOCO_APP the client gives lines {80, 55, 68.8},
 * functions {15, 13, 86.7}, branches {10, 5, 50}.
 */
const JACOCO_UTIL = [JACOCO_HEADER, "lib,com.acme.util,Baz,12,0,2,0,20,0,3,0,1,0", ""].join("\n");

/** A CSV whose header row carries none of JaCoCo's columns — undecodable. */
const JACOCO_FOREIGN_CSV = ["name,score,rank", "alpha,10,1", "beta,7,2", ""].join("\n");

/** One class whose LINE axis is (covered, total) and no methods or branches. */
function jacocoLines(covered: number, total: number): string {
  return [JACOCO_HEADER, `app,com.acme,Probe,0,0,0,0,${total - covered},${covered},0,0,0,0`, ""].join(
    "\n",
  );
}

/** One class whose LINE, METHOD and BRANCH axes are the three given pairs. */
function jacocoAxes(pairs: Array<[number, number]>): string {
  const [[lc, lt], [mc, mt], [bc, bt]] = pairs as [[number, number], [number, number], [number, number]];
  return [
    JACOCO_HEADER,
    `app,com.acme,Probe,0,0,${bt - bc},${bc},${lt - lc},${lc},0,0,${mt - mc},${mc}`,
    "",
  ].join("\n");
}

const COVERAGE_DROPPED_HINT = "coverage DISCARDED — coverage from a failing run is meaningless";

async function ingest(
  handle: ServerHandle,
  key: string,
  agentId: string,
  extra: Record<string, unknown>,
): Promise<Posted> {
  return postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId,
    codec: "junit",
    data: PASSING_REPORT,
    ...extra,
  });
}

// ── lcov ────────────────────────────────────────────────────────────────────

describe("POST /api/v2/runs — lcov coverage", () => {
  test("one lcov text's records are summed into lines and functions, stored on the run and answered in the run block", async () => {
    const handle = boot();
    const key = await ready(handle, "lcov-agent");
    const res = await ingest(handle, key, "lcov-agent", {
      coverage: { codec: "lcov", data: LCOV_TWO_RECORDS },
    });
    expect(res.status).toBe(200);

    const expected: CoverageObject = {
      lines: { total: 80, covered: 31, percent: 38.8 },
      functions: { total: 4, covered: 2, percent: 50 },
    };
    const run = runBlock(res.body);
    expect(run.coverage).toEqual(expected);
    // The counts stay beside it.
    expect(run.total).toBe(2);
    expect(run.passed).toBe(2);
    expect(run.failed).toBe(0);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toEqual(expected);
    // A clean decode warns of nothing.
    expect(res.body.warnings).toBeUndefined();
  });

  test("lcov's branch records are not summed — the lcov coverage object has no branches axis", async () => {
    const handle = boot();
    const key = await ready(handle, "lcov-branches");
    const res = await ingest(handle, key, "lcov-branches", {
      coverage: { codec: "lcov", data: LCOV_TWO_RECORDS },
    });
    expect(res.status).toBe(200);
    const run = runBlock(res.body);
    expect(typeof run.coverage).toBe("object");
    expect(Object.keys(run.coverage as object).sort()).toEqual(["functions", "lines"]);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toBeDefined();
    expect(Object.keys(event.coverage as object).sort()).toEqual(["functions", "lines"]);
  });

  test("two lcov texts sum into ONE coverage object", async () => {
    const handle = boot();
    const key = await ready(handle, "lcov-two");
    const res = await ingest(handle, key, "lcov-two", {
      coverage: { codec: "lcov", data: [LCOV_TWO_RECORDS, LCOV_ALL_HIT] },
    });
    expect(res.status).toBe(200);
    // 80+23 lines, 31+23 hit; 4+2 functions, 2+2 hit.
    const expected: CoverageObject = {
      lines: { total: 103, covered: 54, percent: 52.4 },
      functions: { total: 6, covered: 4, percent: 66.7 },
    };
    expect(runBlock(res.body).coverage).toEqual(expected);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toEqual(expected);
    // NOT the first text alone, NOT the second alone.
    expect(event.coverage?.lines.total).not.toBe(80);
    expect(event.coverage?.lines.total).not.toBe(23);
  });

  test("1 line hit of 80 is 1.2, and an axis with a total of 0 is percent 0", async () => {
    const handle = boot();
    const key = await ready(handle, "lcov-tie");
    const res = await ingest(handle, key, "lcov-tie", {
      coverage: { codec: "lcov", data: LCOV_ONE_OF_EIGHTY },
    });
    expect(res.status).toBe(200);
    const expected: CoverageObject = {
      lines: { total: 80, covered: 1, percent: 1.2 },
      functions: { total: 0, covered: 0, percent: 0 },
    };
    expect(runBlock(res.body).coverage).toEqual(expected);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toEqual(expected);
    expect(event.coverage?.lines.percent).not.toBe(1.3);
  });

  test("the stored coverage reaches the events list: hasCoverage and the lines percent", async () => {
    const handle = boot();
    const key = await ready(handle, "lcov-list");
    const res = await ingest(handle, key, "lcov-list", {
      coverage: { codec: "lcov", data: LCOV_TWO_RECORDS },
    });
    expect(res.status).toBe(200);
    const list = await briefs(handle, key);
    const mine = list.filter((b) => b.id === res.body.event);
    expect(mine.length).toBe(1);
    expect(mine[0]!.hasCoverage).toBe(true);
    expect(mine[0]!.coverageLines).toBe(38.8);
  });

  test("an lcov text with no SF: record stores the run without coverage and warns coverage-dropped naming lcov", async () => {
    const handle = boot();
    const key = await ready(handle, "lcov-undecodable");
    const before = (await briefs(handle, key)).map((b) => b.id);
    const res = await ingest(handle, key, "lcov-undecodable", {
      coverage: { codec: "lcov", data: LCOV_NO_SOURCE_FILE },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const warnings = res.body.warnings as Warning[];
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.code).toBe("coverage-dropped");
    expect(warnings[0]!.detail).toContain("lcov");
    // The detail names the error too, not the codec alone.
    expect(warnings[0]!.detail.trim()).not.toBe("lcov");

    // The run is stored, with its test results and without coverage — never
    // the old 0/0 coverage object.
    const run = runBlock(res.body);
    expect(run.coverage).toBeUndefined();
    expect(run.total).toBe(2);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(2);
    expect(event.coverage).toBeUndefined();
    const list = await briefs(handle, key);
    expect(list.map((b) => b.id).filter((id) => !before.includes(id))).toEqual([
      res.body.event as string,
    ]);
    expect(list.length).toBe(before.length + 1);
    expect(list[0]!.hasCoverage).toBe(false);
  });
});

// ── jacoco ──────────────────────────────────────────────────────────────────

describe("POST /api/v2/runs — jacoco coverage", () => {
  test("a JaCoCo CSV's LINE, METHOD and BRANCH columns are summed into lines, functions and branches", async () => {
    const handle = boot();
    const key = await ready(handle, "jacoco-agent");
    const res = await ingest(handle, key, "jacoco-agent", {
      coverage: { codec: "jacoco", data: JACOCO_APP },
    });
    expect(res.status).toBe(200);
    const expected: CoverageObject = {
      lines: { total: 60, covered: 55, percent: 91.7 },
      functions: { total: 14, covered: 13, percent: 92.9 },
      branches: { total: 8, covered: 5, percent: 62.5 },
    };
    expect(runBlock(res.body).coverage).toEqual(expected);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toEqual(expected);
    // INSTRUCTION (157 total) and COMPLEXITY (14 total) are never read as an axis.
    expect(event.coverage?.lines.total).not.toBe(157);
    expect(res.body.warnings).toBeUndefined();
  });

  test("two JaCoCo CSVs sum into ONE coverage object", async () => {
    const handle = boot();
    const key = await ready(handle, "jacoco-two");
    const res = await ingest(handle, key, "jacoco-two", {
      coverage: { codec: "jacoco", data: [JACOCO_APP, JACOCO_UTIL] },
    });
    expect(res.status).toBe(200);
    const expected: CoverageObject = {
      lines: { total: 80, covered: 55, percent: 68.8 },
      functions: { total: 15, covered: 13, percent: 86.7 },
      branches: { total: 10, covered: 5, percent: 50 },
    };
    expect(runBlock(res.body).coverage).toEqual(expected);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toEqual(expected);
  });

  test("a JaCoCo axis with nothing in it is {0, 0, 0}", async () => {
    const handle = boot();
    const key = await ready(handle, "jacoco-empty-axis");
    const res = await ingest(handle, key, "jacoco-empty-axis", {
      coverage: { codec: "jacoco", data: jacocoLines(1, 80) },
    });
    expect(res.status).toBe(200);
    const expected: CoverageObject = {
      lines: { total: 80, covered: 1, percent: 1.2 },
      functions: { total: 0, covered: 0, percent: 0 },
      branches: { total: 0, covered: 0, percent: 0 },
    };
    expect(runBlock(res.body).coverage).toEqual(expected);
    expect((await storedEvent(handle, res.body.event as string)).coverage).toEqual(expected);
  });

  test("a CSV with no header row of JaCoCo's columns stores the run without coverage and warns coverage-dropped naming jacoco", async () => {
    const handle = boot();
    const key = await ready(handle, "jacoco-undecodable");
    const res = await ingest(handle, key, "jacoco-undecodable", {
      coverage: { codec: "jacoco", data: JACOCO_FOREIGN_CSV },
    });
    expect(res.status).toBe(200);
    const warnings = res.body.warnings as Warning[];
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.code).toBe("coverage-dropped");
    expect(warnings[0]!.detail).toContain("jacoco");
    expect(warnings[0]!.detail.trim()).not.toBe("jacoco");

    expect(runBlock(res.body).coverage).toBeUndefined();
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.total).toBe(2);
    expect(event.coverage).toBeUndefined();
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

describe("POST /api/v2/runs — a refused coverage block stores nothing", () => {
  test("an unknown coverage codec is refused with 400 and no run is stored", async () => {
    const handle = boot();
    const key = await ready(handle, "cov-unknown");
    const before = await briefs(handle, key);
    const res = await ingest(handle, key, "cov-unknown", {
      coverage: { codec: "cobertura", data: LCOV_TWO_RECORDS },
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(await briefs(handle, key)).toEqual(before);
  });

  test("a test codec's name is not a coverage codec — junit as coverage is refused with 400, nothing stored", async () => {
    const handle = boot();
    const key = await ready(handle, "cov-junit");
    const before = await briefs(handle, key);
    const res = await ingest(handle, key, "cov-junit", {
      coverage: { codec: "junit", data: PASSING_REPORT },
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(await briefs(handle, key)).toEqual(before);
  });

  test("an empty coverage list is refused with 400 and no run is stored", async () => {
    const handle = boot();
    const key = await ready(handle, "cov-empty");
    const before = await briefs(handle, key);
    const res = await ingest(handle, key, "cov-empty", {
      coverage: { codec: "lcov", data: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(await briefs(handle, key)).toEqual(before);
  });
});

// ── a failing run ───────────────────────────────────────────────────────────

describe("POST /api/v2/runs — a failing run's coverage is discarded", () => {
  test("a failing run with lcov coverage stores none, answers none and carries the coverageDropped hint", async () => {
    const handle = boot();
    const key = await ready(handle, "cov-red");
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "cov-red",
      codec: "junit",
      data: FAILING_REPORT,
      coverage: { codec: "lcov", data: LCOV_TWO_RECORDS },
    });
    expect(res.status).toBe(200);
    const help = res.body.help as string[];
    expect(Array.isArray(help)).toBe(true);
    expect(help.filter((line) => line === COVERAGE_DROPPED_HINT).length).toBe(1);

    const run = runBlock(res.body);
    expect(run.failed).toBe(1);
    expect(run.coverage).toBeUndefined();
    // A discard is no decode failure: no coverage-dropped warning.
    expect(res.body.warnings).toBeUndefined();

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.failed).toBe(1);
    expect(event.coverage).toBeUndefined();
  });

  test("a passing run with coverage carries no coverageDropped hint", async () => {
    const handle = boot();
    const key = await ready(handle, "cov-green");
    const res = await ingest(handle, key, "cov-green", {
      coverage: { codec: "jacoco", data: JACOCO_APP },
    });
    expect(res.status).toBe(200);
    expect(runBlock(res.body).coverage).toBeDefined();
    expect((res.body.help as string[]).includes(COVERAGE_DROPPED_HINT)).toBe(false);
  });

  test("a run with no coverage block answers no coverage and no hint", async () => {
    // BACKFILL: holds today — the run block grows coverage only when kept.
    const handle = boot();
    const key = await ready(handle, "cov-none");
    const res = await ingest(handle, key, "cov-none", {});
    expect(res.status).toBe(200);
    expect(runBlock(res.body).coverage).toBeUndefined();
    expect((res.body.help as string[]).includes(COVERAGE_DROPPED_HINT)).toBe(false);
    expect((await storedEvent(handle, res.body.event as string)).coverage).toBeUndefined();
  });
});

// ── the rounding, through the route ─────────────────────────────────────────

describe("POST /api/v2/runs — the stored percent is Python's round", () => {
  test("pairs where a naive JavaScript rounding disagrees with Python store Python's answer", async () => {
    const oracle = loadCoveragePercentOracle();
    // Deterministic picks from the oracle: the first pairs (by total, then
    // covered) where `Math.round(x * 10) / 10` disagrees with Python, and the
    // first where `Number(x.toFixed(1))` does — a board using either fails.
    const naiveMathRound: Array<[number, number]> = [];
    const naiveToFixed: Array<[number, number]> = [];
    for (let total = 1; total < oracle.totalBelow; total++) {
      for (let covered = 0; covered <= total; covered++) {
        const x = (covered / total) * 100;
        const python = oracle.percent(covered, total);
        if (naiveMathRound.length < 6 && Math.round(x * 10) / 10 !== python) {
          naiveMathRound.push([covered, total]);
        }
        if (naiveToFixed.length < 6 && Number(x.toFixed(1)) !== python) {
          naiveToFixed.push([covered, total]);
        }
      }
    }
    // The picks exist (the oracle genuinely separates the roundings), and
    // 1 of 80 is among them.
    expect(naiveMathRound.length).toBe(6);
    expect(naiveToFixed.length).toBe(6);
    const picks = [[1, 80] as [number, number], ...naiveMathRound, ...naiveToFixed];
    while (picks.length % 3 !== 0) picks.push([0, 0]);

    const handle = boot();
    const key = await ready(handle, "cov-rounding");
    for (let i = 0; i < picks.length; i += 3) {
      const triple = picks.slice(i, i + 3);
      const res = await ingest(handle, key, "cov-rounding", {
        coverage: { codec: "jacoco", data: jacocoAxes(triple) },
      });
      expect(res.status).toBe(200);
      const event = await storedEvent(handle, res.body.event as string);
      const axes = [event.coverage?.lines, event.coverage?.functions, event.coverage?.branches];
      const got = triple.map(([covered, total], j) => ({
        pair: `${covered}/${total}`,
        total: axes[j]?.total,
        covered: axes[j]?.covered,
        percent: axes[j]?.percent,
      }));
      const want = triple.map(([covered, total]) => ({
        pair: `${covered}/${total}`,
        total,
        covered,
        percent: oracle.percent(covered, total),
      }));
      expect(got).toEqual(want);
      // The answered run block carries the same object the store kept.
      expect(runBlock(res.body).coverage).toEqual(event.coverage);
    }
  });
});
