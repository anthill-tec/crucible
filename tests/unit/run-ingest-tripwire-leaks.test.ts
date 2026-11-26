// Tripwire leak records on run ingest: a run whose isolated environment caught
// outbound connections carries `leaks` to the board, turning the run red.
//
// `POST /api/v2/runs` (both non-streamed and `crucible-events` streamed closes)
// and `POST /api/v2/runs/parsed` accept an optional `leaks` array of leak
// records (`{ endpoint, port, test?, pid?, cmd?, request? }`):
//
//  - when present, `leaks` must be an array of objects, each with a non-empty
//    string `endpoint`, an integer `port` in 1..65535, and optional string
//    fields (`test`, `pid`, `cmd`, `request`), else the ingest is refused with
//    HTTP 400 naming `leaks` and `run NOT stored`, storing nothing;
//  - when `leaks` is non-empty, the board stores `leaks` on the event payload,
//    echoes `leaks` on the ingest response, appends a failing suite named
//    `tripwire` with one failing case per leak (`<endpoint> — <test>` when
//    `test` is present, else `<endpoint>`, with a failure message naming the
//    endpoint, test or command, and request line), and adds `leaks.length` to
//    `summary.total` and `summary.failed` before `fileRunnerExit`, coverage
//    discard, verdict calculation, and `afterRed` hints;
//  - when `leaks` is empty (`[]`), the run stays green and `leaks` is omitted
//    from both the response and the stored event.
//
// Driven through the real production HTTP surface (`bootInProcess`, in-memory
// store, zero sockets, zero child processes); every stored outcome is read back
// through the board's own reads (`GET /api/v2/events/<id>`, `?depth=suites`,
// and `GET /api/v2/events?project=<key>`).
import { describe, test, expect, afterEach } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { parseJunit } from "../../src/codecs/junit.ts";
import { hints } from "../../src/hints.ts";
import type { Coverage, RunSummary, SuiteNode } from "../../src/types.ts";
import {
  bootInProcess,
  eventLine,
  openRun,
  send,
  sendBatch,
  STREAM_CODEC,
  utf8,
} from "../helpers/run-stream-harness.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): BoardHandle {
  const handle = bootInProcess();
  handles.push(handle);
  return handle;
}

interface LeakRecord {
  endpoint: string;
  port: number;
  test?: string;
  pid?: string;
  cmd?: string;
  request?: string;
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(handle: BoardHandle, route: string, body: unknown): Promise<Posted> {
  const res = await send(handle, route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson(handle: BoardHandle, route: string): Promise<Record<string, unknown>> {
  const res = await send(handle, route);
  expect(res.status, `GET ${route}`).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A project with one registered (unbound) agent, ready to ingest. */
async function ready(handle: BoardHandle, agentId: string): Promise<string> {
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
  leaks?: LeakRecord[];
  [key: string]: unknown;
}

interface SuiteSummaryNode {
  name: string;
  status: string;
  counts: { passed: number; failed: number; pending: number };
}

interface StoredEventSuites {
  id: string;
  tree?: SuiteSummaryNode[];
  leaks?: LeakRecord[];
  [key: string]: unknown;
}

async function storedEvent(handle: BoardHandle, eventId: string): Promise<StoredEvent> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  return body.event as StoredEvent;
}

async function storedEventSuites(handle: BoardHandle, eventId: string): Promise<StoredEventSuites> {
  const body = await getJson(handle, `/api/v2/events/${eventId}?depth=suites`);
  return body.event as StoredEventSuites;
}

interface Brief {
  id: string;
  total: number;
  passed: number;
  failed: number;
  hasCoverage: boolean;
}

async function briefs(handle: BoardHandle, key: string): Promise<Brief[]> {
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

function tripwireSuites(tree: SuiteNode[] | undefined): SuiteNode[] {
  return (tree ?? []).filter((suite) => suite.name === "tripwire");
}

function runnerSuites(tree: SuiteNode[] | undefined): SuiteNode[] {
  return (tree ?? []).filter((suite) => suite.name === "runner");
}

const COVERAGE_DROPPED_HINT = "coverage DISCARDED — coverage from a failing run is meaningless";

// ── reports and streams ─────────────────────────────────────────────────────

/** 2 passed. */
const PASSING_REPORT = [
  '<testsuite name="Green" tests="2">',
  '<testcase name="g1" time="0.01"/>',
  '<testcase name="g2" time="0.02"/>',
  "</testsuite>",
].join("\n");

/** 1 passed. */
const SINGLE_PASSING_REPORT = [
  '<testsuite name="Single" tests="1">',
  '<testcase name="s1" time="0.01"/>',
  "</testsuite>",
].join("\n");

/** One lcov record, every line and function hit. */
const LCOV_ALL_HIT = [
  "SF:src/gamma.ts",
  "FNF:2",
  "FNH:2",
  "LF:23",
  "LH:23",
  "end_of_record",
  "",
].join("\n");

/** A complete green stream with 1 passing test. */
const ONE_PASS_STREAM =
  eventLine({ event: "run-start", total: 1 }) +
  eventLine({
    event: "test-end",
    id: "t1",
    name: "adds",
    suite: "math",
    file: "src/math.ts",
    status: "pass",
    duration_ms: 3,
  }) +
  eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 3 });

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

async function ingestJunit(
  handle: BoardHandle,
  key: string,
  agentId: string,
  extra: Record<string, unknown>,
  report = PASSING_REPORT,
): Promise<Posted> {
  return postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId,
    codec: "junit",
    data: report,
    ...extra,
  });
}

async function ingestParsed(
  handle: BoardHandle,
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

// ── POST /api/v2/runs (non-streamed JUnit) ──────────────────────────────────

describe("POST /api/v2/runs — tripwire leaks turn a green JUnit report red", () => {
  test("a leak with test and request turns a passing JUnit run red, stores event.leaks, and appends the tripwire suite on detail and ?depth=suites", async () => {
    const handle = boot();
    const key = await ready(handle, "leak-full");
    const before = await briefs(handle, key);
    const leak: LeakRecord = {
      endpoint: "127.0.0.1:3849",
      port: 3849,
      test: "tests.test_net.TestNet.test_leak",
      pid: "4242",
      cmd: "python3 -m unittest",
      request: "GET /api/v2/health HTTP/1.1",
    };

    const res = await ingestJunit(handle, key, "leak-full", { leaks: [leak] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.verdict).toBe("RED — 1 failing of 3");

    const run = runBlock(res.body);
    expect(run.total).toBe(3);
    expect(run.passed).toBe(2);
    expect(run.failed).toBe(1);
    expect(res.body.leaks).toEqual([leak]);

    const help = helpOf(res.body);
    expect(help.length).toBeGreaterThan(0);
    for (const line of hints.afterRed!) {
      expect(help.filter((h) => h === line).length).toBe(1);
    }
    expect(help.includes(COVERAGE_DROPPED_HINT)).toBe(false);

    const eventId = res.body.event as string;
    const event = await storedEvent(handle, eventId);
    expect(event.leaks).toEqual([leak]);
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.passed).toBe(2);
    expect(event.summary?.failed).toBe(1);

    const decoded = parseJunit(PASSING_REPORT).tree;
    expect(event.tree?.length).toBe(decoded.length + 1);
    expect(event.tree?.slice(0, decoded.length)).toEqual(decoded);

    const suites = tripwireSuites(event.tree);
    expect(suites.length).toBe(1);
    const tripwire = suites[0]!;
    expect(tripwire.name).toBe("tripwire");
    expect(tripwire.status).toBe("fail");
    expect(tripwire.children.length).toBe(1);

    const child = tripwire.children[0]!;
    expect(child.status).toBe("fail");
    expect(child.name).toBe("127.0.0.1:3849 — tests.test_net.TestNet.test_leak");
    expect(child.name).toContain("127.0.0.1:3849");
    expect(child.name).toContain("tests.test_net.TestNet.test_leak");
    expect(child.failure?.message).toContain("127.0.0.1:3849");
    expect(child.failure?.message).toContain("tests.test_net.TestNet.test_leak");
    expect(child.failure?.message).toContain("GET /api/v2/health HTTP/1.1");

    // ?depth=suites surfaces event.leaks and the failing tripwire suite summary.
    const suitesView = await storedEventSuites(handle, eventId);
    expect(suitesView.leaks).toEqual([leak]);
    const tripwireSummary = (suitesView.tree ?? []).filter((s) => s.name === "tripwire");
    expect(tripwireSummary).toEqual([
      {
        name: "tripwire",
        status: "fail",
        counts: { passed: 0, failed: 1, pending: 0 },
      },
    ]);

    const added = (await briefs(handle, key)).filter((b) => !before.some((p) => p.id === b.id));
    expect(added.length).toBe(1);
    expect(added[0]!.id).toBe(eventId);
    expect(added[0]!.total).toBe(3);
    expect(added[0]!.passed).toBe(2);
    expect(added[0]!.failed).toBe(1);
  });

  test("a leak without test names the case by endpoint alone and falls back to cmd in the failure message", async () => {
    const handle = boot();
    const key = await ready(handle, "leak-cmd");
    const leak: LeakRecord = {
      endpoint: "127.0.0.1:3850",
      port: 3850,
      cmd: "bun test",
    };

    const res = await ingestJunit(handle, key, "leak-cmd", { leaks: [leak] });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("RED — 1 failing of 3");
    expect(res.body.leaks).toEqual([leak]);

    const event = await storedEvent(handle, res.body.event as string);
    const suites = tripwireSuites(event.tree);
    expect(suites.length).toBe(1);
    const child = suites[0]!.children[0]!;
    expect(child.status).toBe("fail");
    expect(child.name).toBe("127.0.0.1:3850");
    expect(child.failure?.message).toContain("127.0.0.1:3850");
    expect(child.failure?.message).toContain("bun test");
  });

  test("multiple leaks produce one failing case per leak and increment total and failed by leaks.length", async () => {
    const handle = boot();
    const key = await ready(handle, "leak-multi");
    const leaks: LeakRecord[] = [
      {
        endpoint: "127.0.0.1:3849",
        port: 3849,
        test: "tests.test_net.TestNet.test_first",
        request: "GET /api/v2/health HTTP/1.1",
      },
      {
        endpoint: "127.0.0.1:5432",
        port: 5432,
        cmd: "python3 -m unittest",
      },
    ];

    const res = await ingestJunit(
      handle,
      key,
      "leak-multi",
      { leaks },
      SINGLE_PASSING_REPORT,
    );
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("RED — 2 failing of 3");

    const run = runBlock(res.body);
    expect(run.total).toBe(3);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(2);
    expect(res.body.leaks).toEqual(leaks);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.failed).toBe(2);
    expect(event.leaks).toEqual(leaks);
    expect(event.leaks?.length).toBe(2);

    const suites = tripwireSuites(event.tree);
    expect(suites.length).toBe(1);
    const tripwire = suites[0]!;
    expect(tripwire.status).toBe("fail");
    expect(tripwire.children.length).toBe(2);

    expect(tripwire.children[0]!.status).toBe("fail");
    expect(tripwire.children[0]!.name).toBe("127.0.0.1:3849 — tests.test_net.TestNet.test_first");
    expect(tripwire.children[0]!.failure?.message).toContain("127.0.0.1:3849");
    expect(tripwire.children[0]!.failure?.message).toContain("tests.test_net.TestNet.test_first");
    expect(tripwire.children[0]!.failure?.message).toContain("GET /api/v2/health HTTP/1.1");

    expect(tripwire.children[1]!.status).toBe("fail");
    expect(tripwire.children[1]!.name).toBe("127.0.0.1:5432");
    expect(tripwire.children[1]!.failure?.message).toContain("127.0.0.1:5432");
    expect(tripwire.children[1]!.failure?.message).toContain("python3 -m unittest");
  });

  test("a leak combined with runnerExit 99 appends tripwire and does not add a redundant runner suite", async () => {
    const handle = boot();
    const key = await ready(handle, "leak-exit-99");
    const leak: LeakRecord = { endpoint: "127.0.0.1:3849", port: 3849 };

    const res = await ingestJunit(handle, key, "leak-exit-99", {
      leaks: [leak],
      runnerExit: 99,
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("RED — 1 failing of 3");

    const run = runBlock(res.body);
    expect(run.total).toBe(3);
    expect(run.passed).toBe(2);
    expect(run.failed).toBe(1);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.failed).toBe(1);
    expect(tripwireSuites(event.tree).length).toBe(1);
    expect(tripwireSuites(event.tree)[0]!.children.length).toBe(1);
    expect(runnerSuites(event.tree).length).toBe(0);
  });

  test("a tripwire leak over a passing report with lcov coverage discards coverage and emits the coverageDropped hint", async () => {
    const handle = boot();
    const key = await ready(handle, "leak-cov");
    const before = await briefs(handle, key);
    const leak: LeakRecord = { endpoint: "127.0.0.1:3849", port: 3849 };

    const res = await ingestJunit(handle, key, "leak-cov", {
      leaks: [leak],
      coverage: { codec: "lcov", data: LCOV_ALL_HIT },
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("RED — 1 failing of 3");
    expect(runBlock(res.body).coverage).toBeUndefined();

    const help = helpOf(res.body);
    expect(help.filter((h) => h === COVERAGE_DROPPED_HINT).length).toBe(1);
    for (const line of hints.afterRed!) {
      expect(help.filter((h) => h === line).length).toBe(1);
    }

    const eventId = res.body.event as string;
    const event = await storedEvent(handle, eventId);
    expect(event.coverage).toBeUndefined();
    expect(event.leaks).toEqual([leak]);

    const added = (await briefs(handle, key)).filter((b) => !before.some((p) => p.id === b.id));
    expect(added.length).toBe(1);
    expect(added[0]!.id).toBe(eventId);
    expect(added[0]!.hasCoverage).toBe(false);
  });

  test("empty leaks array leaves a passing report green, preserves coverage, and omits leaks from response and stored event", async () => {
    // Regression PIN: guards against storing `leaks: []` or appending an empty
    // `tripwire` suite when a client sends an empty leaks array.
    const handle = boot();
    const key = await ready(handle, "leak-empty");
    const res = await ingestJunit(handle, key, "leak-empty", {
      leaks: [],
      coverage: { codec: "lcov", data: LCOV_ALL_HIT },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.verdict).toBe("GREEN — 2/2 passed");
    expect(res.body.leaks).toBeUndefined();
    expect("leaks" in res.body).toBe(false);

    const run = runBlock(res.body);
    expect(run.total).toBe(2);
    expect(run.passed).toBe(2);
    expect(run.failed).toBe(0);
    expect(run.coverage).toBeDefined();

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.leaks).toBeUndefined();
    expect("leaks" in event).toBe(false);
    expect(event.summary?.failed).toBe(0);
    expect(event.coverage).toBeDefined();
    expect(event.tree).toEqual(parseJunit(PASSING_REPORT).tree);
    expect(tripwireSuites(event.tree).length).toBe(0);
  });
});

// ── POST /api/v2/runs (streamed close) ──────────────────────────────────────

describe("POST /api/v2/runs (crucible-events stream close) — tripwire leaks", () => {
  test("closing a green streamed run with leaks turns it red, stores event.leaks, and appends the failing tripwire suite", async () => {
    const handle = boot();
    const key = await ready(handle, "stream-leak");
    const runId = await openRun(handle, key, "stream-leak", { stack: "bun", tier: "unit" });

    const batchRes = await sendBatch(handle, runId, {
      projectKey: key,
      agentId: "stream-leak",
      from: 0,
      data: ONE_PASS_STREAM,
    });
    expect(batchRes.status).toBe(200);
    expect(batchRes.body.held).toBe(utf8(ONE_PASS_STREAM));

    const leak: LeakRecord = { endpoint: "127.0.0.1:3849", port: 3849, cmd: "bun test" };
    const closeRes = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "stream-leak",
      runId,
      codec: STREAM_CODEC,
      leaks: [leak],
    });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.ok).toBe(true);
    expect(closeRes.body.verdict).toBe("RED — 1 failing of 2");

    const run = runBlock(closeRes.body);
    expect(run.total).toBe(2);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    expect(closeRes.body.leaks).toEqual([leak]);

    const event = await storedEvent(handle, closeRes.body.event as string);
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.failed).toBe(1);
    expect(event.leaks).toEqual([leak]);

    const suites = tripwireSuites(event.tree);
    expect(suites.length).toBe(1);
    const child = suites[0]!.children[0]!;
    expect(child.status).toBe("fail");
    expect(child.name).toBe("127.0.0.1:3849");
    expect(child.failure?.message).toContain("127.0.0.1:3849");
    expect(child.failure?.message).toContain("bun test");
    expect(handle.store.getRun(runId)?.state).toBe("ended");
  });
});

// ── POST /api/v2/runs/parsed ────────────────────────────────────────────────

describe("POST /api/v2/runs/parsed — tripwire leaks", () => {
  test("a green parsed run with leaks turns red, stores event.leaks, and appends the failing tripwire suite", async () => {
    const handle = boot();
    const key = await ready(handle, "parsed-leak");
    const leak: LeakRecord = { endpoint: "127.0.0.1:3849", port: 3849 };

    const res = await ingestParsed(handle, key, "parsed-leak", { leaks: [leak] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.verdict).toBe("RED — 1 failing of 4");

    const run = runBlock(res.body);
    expect(run.total).toBe(4);
    expect(run.passed).toBe(3);
    expect(run.failed).toBe(1);
    expect(res.body.leaks).toEqual([leak]);

    const event = await storedEvent(handle, res.body.event as string);
    expect(event.summary?.total).toBe(4);
    expect(event.summary?.passed).toBe(3);
    expect(event.summary?.failed).toBe(1);
    expect(event.leaks).toEqual([leak]);

    const suites = tripwireSuites(event.tree);
    expect(suites.length).toBe(1);
    expect(suites[0]!.status).toBe("fail");
    expect(suites[0]!.children.length).toBe(1);
    expect(suites[0]!.children[0]!.status).toBe("fail");
    expect(suites[0]!.children[0]!.name).toBe("127.0.0.1:3849");
  });
});

// ── Validation refusals ─────────────────────────────────────────────────────

const BAD_LEAKS: Array<[string, unknown]> = [
  ['non-array string ("bad")', "bad"],
  ["non-array number (123)", 123],
  ["non-array object ({})", {}],
  ["non-object item (null)", [null]],
  ['non-object item ("127.0.0.1:3849")', ["127.0.0.1:3849"]],
  ["missing endpoint", [{ port: 3849 }]],
  ["empty endpoint", [{ endpoint: "", port: 3849 }]],
  ["missing port", [{ endpoint: "127.0.0.1:3849" }]],
  ["zero port", [{ endpoint: "127.0.0.1:0", port: 0 }]],
  ["out-of-range port (70000)", [{ endpoint: "127.0.0.1:70000", port: 70000 }]],
  ["fractional port (3849.5)", [{ endpoint: "127.0.0.1:3849", port: 3849.5 }]],
  ['string port ("3849")', [{ endpoint: "127.0.0.1:3849", port: "3849" }]],
  ["non-string optional field test (42)", [{ endpoint: "127.0.0.1:3849", port: 3849, test: 42 }]],
  ["non-string optional field cmd ([])", [{ endpoint: "127.0.0.1:3849", port: 3849, cmd: [] }]],
];

describe("POST /api/v2/runs — malformed leaks is refused with 400 and nothing is stored", () => {
  for (const [label, value] of BAD_LEAKS) {
    test(`refuses ${label} with HTTP 400 naming leaks and leaves stored events unchanged`, async () => {
      const handle = boot();
      const key = await ready(handle, "bad-leaks");
      const before = await briefs(handle, key);

      const res = await ingestJunit(handle, key, "bad-leaks", { leaks: value });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(String(res.body.error)).toContain("leaks");
      expect(String(res.body.error)).toContain("run NOT stored");
      expect(res.body.event).toBeUndefined();
      expect(await briefs(handle, key)).toEqual(before);
    });
  }

  test("refuses malformed leaks on a streamed run close with HTTP 400, stores nothing, and leaves the run open", async () => {
    const handle = boot();
    const key = await ready(handle, "bad-stream-leaks");
    const runId = await openRun(handle, key, "bad-stream-leaks", { stack: "bun", tier: "unit" });
    const batchRes = await sendBatch(handle, runId, {
      projectKey: key,
      agentId: "bad-stream-leaks",
      from: 0,
      data: ONE_PASS_STREAM,
    });
    expect(batchRes.status).toBe(200);
    const before = await briefs(handle, key);

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "bad-stream-leaks",
      runId,
      codec: STREAM_CODEC,
      leaks: [{ endpoint: "", port: 3849 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toContain("leaks");
    expect(String(res.body.error)).toContain("run NOT stored");
    expect(res.body.event).toBeUndefined();
    expect(await briefs(handle, key)).toEqual(before);
    expect(handle.store.getRun(runId)?.state).toBe("open");
  });
});

describe("POST /api/v2/runs/parsed — malformed leaks is refused with 400 and nothing is stored", () => {
  const PARSED_BAD: Array<[string, unknown]> = [
    ['non-array string ("bad")', "bad"],
    ["zero port", [{ endpoint: "127.0.0.1:0", port: 0 }]],
    ["non-string optional field test (42)", [{ endpoint: "127.0.0.1:3849", port: 3849, test: 42 }]],
  ];

  for (const [label, value] of PARSED_BAD) {
    test(`refuses ${label} with HTTP 400 naming leaks and leaves stored events unchanged`, async () => {
      const handle = boot();
      const key = await ready(handle, "bad-parsed-leaks");
      const before = await briefs(handle, key);

      const res = await ingestParsed(handle, key, "bad-parsed-leaks", { leaks: value });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(String(res.body.error)).toContain("leaks");
      expect(String(res.body.error)).toContain("run NOT stored");
      expect(res.body.event).toBeUndefined();
      expect(await briefs(handle, key)).toEqual(before);
    });
  }
});
