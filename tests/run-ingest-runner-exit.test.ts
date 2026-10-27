// A run's ingest states the exit code of the runner that produced it, and a
// runner that failed is never filed as green.
//
// `POST /api/v2/runs` and `POST /api/v2/runs/parsed` accept an optional
// `runnerExit`:
//
//  - when present it must be an integer ≥ 0, else the ingest is refused with
//    400 `runnerExit must be a non-negative integer — run NOT stored` and
//    nothing is written;
//  - when it is non-zero and the run records no failure (`summary.failed` is
//    0 — on `/runs` after the codec has decoded), the board appends a failing
//    suite `runner` holding one failing case `exit <n>` whose message is
//    `the runner exited <n> but its report records no failure`, and adds 1 to
//    the run's `summary.total` and `summary.failed` — before the run is stored
//    and before its hints are computed, so the verdict, the stored counts, the
//    coverage discard (with the `coverageDropped` hint) and the `afterRed`
//    hint all follow, and the response's `run` counts include it;
//  - non-zero over a run that already records a failure, `runnerExit: 0`, and
//    no `runnerExit` at all leave the run exactly as posted.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store); every stored outcome is read back through the board's own reads —
// the run detail `GET /api/v2/events/<id>` and the events list.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { parseJunit } from "../src/codecs/junit.ts";
import { hints } from "../src/hints.ts";
import type { Coverage, RunSummary, SuiteNode } from "../src/types.ts";

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

interface StoredEvent {
  id: string;
  summary?: RunSummary;
  tree?: SuiteNode[];
  coverage?: Coverage;
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
}

async function briefs(handle: ServerHandle, key: string): Promise<Brief[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return body.events as Brief[];
}

function runBlock(body: Record<string, unknown>): Record<string, unknown> {
  expect(typeof body.run).toBe("object");
  return body.run as Record<string, unknown>;
}

function helpOf(body: Record<string, unknown>): string[] {
  expect(Array.isArray(body.help)).toBe(true);
  return body.help as string[];
}

/** Every suite in a stored tree named `runner`. */
function runnerSuites(tree: SuiteNode[] | undefined): SuiteNode[] {
  return (tree ?? []).filter((suite) => suite.name === "runner");
}

/** The one suite the board appends for a runner that exited `n` over a clean run. */
function expectRunnerSuite(suite: SuiteNode | undefined, n: number): void {
  expect(suite).toBeDefined();
  expect(suite!.name).toBe("runner");
  expect(suite!.status).toBe("fail");
  expect(suite!.children.length).toBe(1);
  const leaf = suite!.children[0]!;
  expect(leaf.name).toBe(`exit ${n}`);
  expect(leaf.status).toBe("fail");
  expect(leaf.failure?.message).toBe(`the runner exited ${n} but its report records no failure`);
}

const REFUSAL = "runnerExit must be a non-negative integer — run NOT stored";
const COVERAGE_DROPPED_HINT = "coverage DISCARDED — coverage from a failing run is meaningless";

// ── reports ─────────────────────────────────────────────────────────────────

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

/** One record, every line and function hit. */
const LCOV_ALL_HIT = ["SF:src/gamma.ts", "FNF:2", "FNH:2", "LF:23", "LH:23", "end_of_record", ""].join(
  "\n",
);

// ── parsed-route trees ──────────────────────────────────────────────────────

function cleanTree(): SuiteNode[] {
  return [
    {
      name: "Parsed",
      status: "pass",
      children: [
        { name: "p1", status: "pass", duration_ms: 10 },
        { name: "p2", status: "pass", duration_ms: 20 },
        { name: "p3", status: "pass", duration_ms: 30 },
      ],
    },
  ];
}

function cleanSummary(): RunSummary {
  return { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 60 };
}

function failingTree(): SuiteNode[] {
  return [
    {
      name: "Parsed",
      status: "fail",
      children: [
        { name: "p1", status: "pass", duration_ms: 10 },
        {
          name: "p2",
          status: "fail",
          duration_ms: 20,
          failure: { message: "expected 2 got 3", type: "AssertionError", trace: "at p2:1:1" },
        },
      ],
    },
  ];
}

function failingSummary(): RunSummary {
  return { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 30 };
}

const PARSED_COVERAGE: Coverage = {
  lines: { total: 50, covered: 40, percent: 80 },
  functions: { total: 10, covered: 9, percent: 90 },
};

async function ingestJunit(
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

async function ingestParsed(
  handle: ServerHandle,
  key: string,
  agentId: string,
  extra: Record<string, unknown>,
): Promise<Posted> {
  return postJson(handle, "/api/v2/runs/parsed", {
    projectKey: key,
    agentId,
    summary: cleanSummary(),
    tree: cleanTree(),
    ...extra,
  });
}

// ── POST /api/v2/runs ───────────────────────────────────────────────────────

describe("POST /api/v2/runs — a runner that exited non-zero over a clean report", () => {
  test("runnerExit 1 over a passing report stores the run with the runner / exit 1 case appended after the decoded suites", async () => {
    const handle = boot();
    const key = await ready(handle, "runs-exit-1");
    const res = await ingestJunit(handle, key, "runs-exit-1", { runnerExit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const event = await storedEvent(handle, res.body.event as string);
    const decoded = parseJunit(PASSING_REPORT).tree;
    expect(event.tree?.length).toBe(decoded.length + 1);
    // The decoded suites are kept exactly, in order, ahead of the runner suite.
    expect(event.tree?.slice(0, decoded.length)).toEqual(decoded);
    expect(runnerSuites(event.tree).length).toBe(1);
    expectRunnerSuite(event.tree?.[decoded.length], 1);
  });

  test("runnerExit 1 over a passing report counts the case: total and failed one higher in the answer, the stored run and the events list", async () => {
    const handle = boot();
    const key = await ready(handle, "runs-counts");
    const before = await briefs(handle, key);
    const res = await ingestJunit(handle, key, "runs-counts", { runnerExit: 1 });
    expect(res.status).toBe(200);

    const run = runBlock(res.body);
    expect(run.total).toBe(3);
    expect(run.passed).toBe(2);
    expect(run.failed).toBe(1);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.passed).toBe(2);
    expect(event.summary?.failed).toBe(1);

    const added = (await briefs(handle, key)).filter((b) => !before.some((p) => p.id === b.id));
    expect(added.length).toBe(1);
    expect(added[0]!.id).toBe(res.body.event as string);
    expect(added[0]!.total).toBe(3);
    expect(added[0]!.passed).toBe(2);
    expect(added[0]!.failed).toBe(1);
  });

  test("runnerExit 1 over a passing report answers the RED verdict and the afterRed hint", async () => {
    const handle = boot();
    const key = await ready(handle, "runs-verdict");
    const res = await ingestJunit(handle, key, "runs-verdict", { runnerExit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("RED — 1 failing of 3");
    const help = helpOf(res.body);
    for (const line of hints.afterRed!) {
      expect(help.filter((h) => h === line).length).toBe(1);
    }
    // No coverage was sent, so none was discarded.
    expect(help.includes(COVERAGE_DROPPED_HINT)).toBe(false);
  });

  test("runnerExit 1 over a passing report with lcov coverage discards the coverage and carries the coverageDropped hint", async () => {
    const handle = boot();
    const key = await ready(handle, "runs-cov");
    const before = await briefs(handle, key);
    const res = await ingestJunit(handle, key, "runs-cov", {
      runnerExit: 1,
      coverage: { codec: "lcov", data: LCOV_ALL_HIT },
    });
    expect(res.status).toBe(200);
    expect(runBlock(res.body).coverage).toBeUndefined();
    expect(helpOf(res.body).filter((h) => h === COVERAGE_DROPPED_HINT).length).toBe(1);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toBeUndefined();
    const added = (await briefs(handle, key)).filter((b) => !before.some((p) => p.id === b.id));
    expect(added.length).toBe(1);
    expect(added[0]!.id).toBe(res.body.event as string);
    expect(added[0]!.hasCoverage).toBe(false);
  });

  test("runnerExit 137 (a SIGKILLed runner) names its own code in the case and its message", async () => {
    const handle = boot();
    const key = await ready(handle, "runs-137");
    const res = await ingestJunit(handle, key, "runs-137", { runnerExit: 137 });
    expect(res.status).toBe(200);
    const event = await storedEvent(handle, res.body.event as string);
    const runner = runnerSuites(event.tree);
    expect(runner.length).toBe(1);
    expectRunnerSuite(runner[0], 137);
    expect(runner[0]!.children[0]!.name).not.toBe("exit 1");
  });
});

describe("POST /api/v2/runs — runnerExit that leaves the run unchanged", () => {
  test("runnerExit 1 over a report that already records a failure adds no case and keeps the decoded counts", async () => {
    // BACKFILL: holds today — the board ignores runnerExit; pins that the
    // rule never doubles a failure the report already carries.
    const handle = boot();
    const key = await ready(handle, "runs-red-exit");
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "runs-red-exit",
      codec: "junit",
      data: FAILING_REPORT,
      runnerExit: 1,
    });
    expect(res.status).toBe(200);
    const run = runBlock(res.body);
    expect(run.total).toBe(2);
    expect(run.failed).toBe(1);
    expect(res.body.verdict).toBe("RED — 1 failing of 2");

    const expected = parseJunit(FAILING_REPORT);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.tree).toEqual(expected.tree);
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.failed).toBe(1);
    expect(runnerSuites(event.tree).length).toBe(0);
  });

  test("runnerExit 0 over a passing report stores the run as decoded, GREEN, with its coverage kept", async () => {
    // BACKFILL: holds today — exit 0 must stay a clean ingest.
    const handle = boot();
    const key = await ready(handle, "runs-exit-0");
    const res = await ingestJunit(handle, key, "runs-exit-0", {
      runnerExit: 0,
      coverage: { codec: "lcov", data: LCOV_ALL_HIT },
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("GREEN — 2/2 passed");
    const run = runBlock(res.body);
    expect(run.total).toBe(2);
    expect(run.failed).toBe(0);
    expect(run.coverage).toBeDefined();
    const help = helpOf(res.body);
    expect(help.includes(COVERAGE_DROPPED_HINT)).toBe(false);
    for (const line of hints.afterRed!) expect(help.includes(line)).toBe(false);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.tree).toEqual(parseJunit(PASSING_REPORT).tree);
    expect(event.summary?.failed).toBe(0);
    expect(event.coverage).toBeDefined();
  });

  test("no runnerExit over a passing report stores the run as decoded, GREEN", async () => {
    // BACKFILL: holds today — an older client sends no runnerExit.
    const handle = boot();
    const key = await ready(handle, "runs-absent");
    const res = await ingestJunit(handle, key, "runs-absent", {});
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("GREEN — 2/2 passed");
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.tree).toEqual(parseJunit(PASSING_REPORT).tree);
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.failed).toBe(0);
    expect(runnerSuites(event.tree).length).toBe(0);
  });
});

describe("POST /api/v2/runs — a runnerExit that is not a non-negative integer is refused", () => {
  const BAD: Array<[string, unknown]> = [
    ['the string "1"', "1"],
    ["the fraction 1.5", 1.5],
    ["the boolean true", true],
    ["null", null],
    ["the negative -1", -1],
  ];
  for (const [label, value] of BAD) {
    test(`runnerExit ${label} is refused with 400 naming runnerExit and nothing is stored`, async () => {
      const handle = boot();
      const key = await ready(handle, "runs-bad");
      const before = await briefs(handle, key);
      const res = await ingestJunit(handle, key, "runs-bad", { runnerExit: value });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe(REFUSAL);
      expect(res.body.event).toBeUndefined();
      expect(await briefs(handle, key)).toEqual(before);
    });
  }
});

// ── POST /api/v2/runs/parsed ────────────────────────────────────────────────

describe("POST /api/v2/runs/parsed — a runner that exited non-zero over a clean run", () => {
  test("runnerExit 1 over a clean tree stores the run with the runner / exit 1 case appended after the posted suites", async () => {
    const handle = boot();
    const key = await ready(handle, "parsed-exit-1");
    const res = await ingestParsed(handle, key, "parsed-exit-1", { runnerExit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const event = await storedEvent(handle, res.body.event as string);
    const posted = cleanTree();
    expect(event.tree?.length).toBe(posted.length + 1);
    expect(event.tree?.slice(0, posted.length)).toEqual(posted);
    expect(runnerSuites(event.tree).length).toBe(1);
    expectRunnerSuite(event.tree?.[posted.length], 1);
  });

  test("runnerExit 1 over a clean summary counts the case: total and failed one higher in the answer, the stored run and the events list", async () => {
    const handle = boot();
    const key = await ready(handle, "parsed-counts");
    const before = await briefs(handle, key);
    const res = await ingestParsed(handle, key, "parsed-counts", { runnerExit: 1 });
    expect(res.status).toBe(200);

    const run = runBlock(res.body);
    expect(run.total).toBe(4);
    expect(run.passed).toBe(3);
    expect(run.failed).toBe(1);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.total).toBe(4);
    expect(event.summary?.passed).toBe(3);
    expect(event.summary?.failed).toBe(1);

    const added = (await briefs(handle, key)).filter((b) => !before.some((p) => p.id === b.id));
    expect(added.length).toBe(1);
    expect(added[0]!.id).toBe(res.body.event as string);
    expect(added[0]!.total).toBe(4);
    expect(added[0]!.failed).toBe(1);
  });

  test("runnerExit 1 over a clean summary answers the RED verdict and the afterRed hint", async () => {
    const handle = boot();
    const key = await ready(handle, "parsed-verdict");
    const res = await ingestParsed(handle, key, "parsed-verdict", { runnerExit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("RED — 1 failing of 4");
    const help = helpOf(res.body);
    for (const line of hints.afterRed!) {
      expect(help.filter((h) => h === line).length).toBe(1);
    }
    expect(help.includes(COVERAGE_DROPPED_HINT)).toBe(false);
  });

  test("runnerExit 1 over a clean summary with coverage discards the coverage and carries the coverageDropped hint", async () => {
    const handle = boot();
    const key = await ready(handle, "parsed-cov");
    const before = await briefs(handle, key);
    const res = await ingestParsed(handle, key, "parsed-cov", {
      runnerExit: 1,
      coverage: PARSED_COVERAGE,
    });
    expect(res.status).toBe(200);
    expect(helpOf(res.body).filter((h) => h === COVERAGE_DROPPED_HINT).length).toBe(1);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.coverage).toBeUndefined();
    const added = (await briefs(handle, key)).filter((b) => !before.some((p) => p.id === b.id));
    expect(added.length).toBe(1);
    expect(added[0]!.id).toBe(res.body.event as string);
    expect(added[0]!.hasCoverage).toBe(false);
  });

  test("runnerExit 2 names its own code in the case and its message", async () => {
    const handle = boot();
    const key = await ready(handle, "parsed-2");
    const res = await ingestParsed(handle, key, "parsed-2", { runnerExit: 2 });
    expect(res.status).toBe(200);
    const event = await storedEvent(handle, res.body.event as string);
    const runner = runnerSuites(event.tree);
    expect(runner.length).toBe(1);
    expectRunnerSuite(runner[0], 2);
  });
});

describe("POST /api/v2/runs/parsed — runnerExit that leaves the run unchanged", () => {
  test("runnerExit 1 over a run that already records a failure adds no case and keeps the posted counts", async () => {
    // BACKFILL: holds today — the board ignores runnerExit.
    const handle = boot();
    const key = await ready(handle, "parsed-red-exit");
    const res = await ingestParsed(handle, key, "parsed-red-exit", {
      summary: failingSummary(),
      tree: failingTree(),
      runnerExit: 1,
    });
    expect(res.status).toBe(200);
    expect(runBlock(res.body)).toEqual(failingSummary() as unknown as Record<string, unknown>);
    expect(res.body.verdict).toBe("RED — 1 failing of 2");

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.tree).toEqual(failingTree());
    expect(event.summary).toEqual(failingSummary());
    expect(runnerSuites(event.tree).length).toBe(0);
  });

  test("runnerExit 0 over a clean run stores it as posted, GREEN, with its coverage kept", async () => {
    // BACKFILL: holds today.
    const handle = boot();
    const key = await ready(handle, "parsed-exit-0");
    const res = await ingestParsed(handle, key, "parsed-exit-0", {
      runnerExit: 0,
      coverage: PARSED_COVERAGE,
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("GREEN — 3/3 passed");
    expect(runBlock(res.body)).toEqual(cleanSummary() as unknown as Record<string, unknown>);
    const help = helpOf(res.body);
    expect(help.includes(COVERAGE_DROPPED_HINT)).toBe(false);
    for (const line of hints.afterRed!) expect(help.includes(line)).toBe(false);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.tree).toEqual(cleanTree());
    expect(event.summary).toEqual(cleanSummary());
    expect(event.coverage).toEqual(PARSED_COVERAGE);
  });

  test("no runnerExit over a clean run stores it as posted, GREEN", async () => {
    // BACKFILL: holds today — an older client sends no runnerExit.
    const handle = boot();
    const key = await ready(handle, "parsed-absent");
    const res = await ingestParsed(handle, key, "parsed-absent", {});
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("GREEN — 3/3 passed");
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.tree).toEqual(cleanTree());
    expect(event.summary).toEqual(cleanSummary());
  });
});

describe("POST /api/v2/runs/parsed — a runnerExit that is not a non-negative integer is refused", () => {
  const BAD: Array<[string, unknown]> = [
    ['the string "1"', "1"],
    ["the fraction 1.5", 1.5],
    ["the boolean true", true],
    ["null", null],
    ["the negative -1", -1],
  ];
  for (const [label, value] of BAD) {
    test(`runnerExit ${label} is refused with 400 naming runnerExit and nothing is stored`, async () => {
      const handle = boot();
      const key = await ready(handle, "parsed-bad");
      const before = await briefs(handle, key);
      const res = await ingestParsed(handle, key, "parsed-bad", { runnerExit: value });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe(REFUSAL);
      expect(res.body.event).toBeUndefined();
      expect(await briefs(handle, key)).toEqual(before);
    });
  }
});
