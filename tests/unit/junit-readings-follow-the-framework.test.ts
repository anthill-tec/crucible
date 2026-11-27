// The two `junit` readings follow the framework a run states, never its stack.
//
//  - pytest's classname grouping applies to a run of framework `pytest` whose
//    report holds exactly one suite, named `pytest`; under any other
//    framework, or none, the cases stay grouped by suite, whatever the stack;
//  - bun's console reading (a failing case with no message takes bun's
//    console message; a file bun could not load gets its `?` case) applies to
//    a run of framework `bun-test`; under any other framework, or none, the
//    console is not read, whatever the stack;
//  - the framework a run decodes under is the one its ingest states, else the
//    one the run it closes was started with;
//  - nothing under src/codecs/ reads the run's stack for a test run: the
//    codec registry's `junit` entry reads `DecodeOptions.framework`, and a
//    `stack` handed to it changes nothing.
//
// The route tests drive the real production HTTP surface (`bootInProcess`,
// in-memory store) through `POST /api/v2/runs` with codec `junit`, and read
// every stored outcome back through `GET /api/v2/events/<id>`.
import { describe, test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardHandle } from "../../src/server.ts";
import { codecs } from "../../src/codecs/index.ts";
import type { DecodeOptions } from "../../src/codecs/index.ts";
import type { SuiteNode } from "../../src/types.ts";
import { jsUncommented } from "../helpers/source-scan.ts";
import {
  BARE_JUNIT_TIMEOUT_RUN,
  CLIENT_READING,
  TIMEOUT_DETAIL_AFTER_FAIL,
} from "../fixtures/bun-console-captures.ts";
import { CLIENT_LOAD_ERROR_READING, FOUR_FILES } from "../fixtures/bun-load-error-captures.ts";
import { bootInProcess, send } from "../helpers/run-stream-harness.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): BoardHandle {
  const handle = bootInProcess();
  handles.push(handle);
  return handle;
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(handle: BoardHandle, route: string, body: unknown): Promise<Posted> {
  const res = await send(handle, `${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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

interface StoredFailure {
  message?: string;
  type?: string;
  trace?: string;
}

interface StoredLeaf {
  name: string;
  status: string;
  failure?: StoredFailure;
}

interface StoredEvent {
  id: string;
  stack?: string;
  framework?: string;
  summary?: { total: number; passed: number; failed: number; pending: number };
  tree?: Array<{ name: string; children: StoredLeaf[] }>;
}

async function storedEvent(handle: BoardHandle, eventId: string): Promise<StoredEvent> {
  const res = await send(handle, `/api/v2/events/${eventId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { event: StoredEvent }).event;
}

/** Suite names and, under each, its case names — the stored tree's shape. */
function treeShape(event: StoredEvent): Array<[string, string[]]> {
  return (event.tree ?? []).map((s) => [s.name, s.children.map((c) => c.name)]);
}

function leaf(event: StoredEvent, name: string): StoredLeaf {
  const found = (event.tree ?? []).flatMap((s) => s.children).filter((c) => c.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
}

/** The run's meta as an ingest or a start states it: each part only when given. */
interface Meta {
  stack?: string;
  framework?: string;
}

function metaOf(meta: Meta): Meta {
  return {
    ...(meta.stack !== undefined ? { stack: meta.stack } : {}),
    ...(meta.framework !== undefined ? { framework: meta.framework } : {}),
  };
}

/** One junit run ingested under `meta`, with `raw` when given, read back. */
async function ingest(
  agentId: string,
  meta: Meta,
  data: string | string[],
  raw?: string,
): Promise<{ res: Posted; event: StoredEvent }> {
  const handle = boot();
  const key = await ready(handle, agentId);
  const res = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId,
    codec: "junit",
    ...metaOf(meta),
    data,
    ...(raw !== undefined ? { raw } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok).toBe(true);
  return { res, event: await storedEvent(handle, res.body.event as string) };
}

/** A run started under `start`, closed by an ingest that states `close` (the junit report and `raw`). */
async function startThenClose(
  agentId: string,
  start: Meta,
  close: Meta,
  data: string | string[],
  raw?: string,
): Promise<{ event: StoredEvent; openRuns: string[] }> {
  const handle = boot();
  const key = await ready(handle, agentId);
  const started = await postJson(handle, "/api/v2/runs/start", {
    projectKey: key,
    agentId,
    tier: "unit",
    ...metaOf(start),
  });
  expect(started.status).toBe(202);
  const runId = started.body.runId as string;
  const res = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId,
    codec: "junit",
    runId,
    ...metaOf(close),
    data,
    ...(raw !== undefined ? { raw } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const event = await storedEvent(handle, res.body.event as string);
  const listRes = await send(handle, `/api/v2/events?project=${key}`);
  const list = (await listRes.json()) as { openRuns: Array<{ runId: string }> };
  return { event, openRuns: list.openRuns.map((r) => r.runId) };
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** pytest's report: one suite named `pytest`, its cases carrying classnames (one with none). */
const PYTEST_REPORT = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites name="pytest tests">',
  '<testsuite name="pytest" tests="4">',
  '<testcase classname="tests.test_beta.TestBeta" name="test_b1" time="0.001"/>',
  '<testcase classname="tests.test_alpha" name="test_a1" time="0.001"><failure message="assert 1 == 2">assert 1 == 2</failure></testcase>',
  '<testcase name="test_loose" time="0.001"/>',
  '<testcase classname="tests.test_beta.TestBeta" name="test_b2" time="0.001"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

const PYTEST_GROUPED: Array<[string, string[]]> = [
  ["tests.test_beta.TestBeta", ["test_b1", "test_b2"]],
  ["tests.test_alpha", ["test_a1"]],
  ["pytest", ["test_loose"]],
];

const PYTEST_BY_SUITE: Array<[string, string[]]> = [["pytest", ["test_b1", "test_a1", "test_loose", "test_b2"]]];

/** Two suites, the first named `pytest`: not a report whose only suite is `pytest`. */
const TWO_SUITES = [
  "<testsuites>",
  '<testsuite name="pytest" tests="2">',
  '<testcase classname="tests.test_x" name="x1" time="0.001"/>',
  '<testcase classname="tests.test_y" name="y1" time="0.001"/>',
  "</testsuite>",
  '<testsuite name="other" tests="1">',
  '<testcase classname="tests.test_z" name="z1" time="0.001"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

/** One suite, named other than `pytest`, its cases carrying classnames. */
const ONE_SUITE_NAMED_OTHERWISE = [
  "<testsuites>",
  '<testsuite name="tests" tests="3">',
  '<testcase classname="tests.test_x" name="x1" time="0.001"/>',
  '<testcase classname="tests.test_y" name="y1" time="0.001"/>',
  '<testcase classname="tests.test_x" name="x2" time="0.001"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

/** bun's console reading of the bare-failure run, as the bun client read it. */
const CONSOLE_READ = CLIENT_READING["TIMEOUT_DETAIL_AFTER_FAIL/plain"]!;
const CONSOLE = TIMEOUT_DETAIL_AFTER_FAIL.plain;

function expectConsoleRead(event: StoredEvent): void {
  expect(leaf(event, "mismatched expectation").failure).toEqual({
    type: "AssertionError",
    ...CONSOLE_READ["mismatched expectation"],
  });
  expect(leaf(event, "mismatched expectation").failure?.message).toBe("expect(received).toBe(expected)");
  expect(leaf(event, "throws with detail").failure).toEqual({
    type: "AssertionError",
    ...CONSOLE_READ["throws with detail"],
  });
  // A case the console does not explain keeps its type-only failure.
  expect(leaf(event, "times out unmatched").failure).toEqual({ type: "TimeoutError" });
}

function expectConsoleNotRead(event: StoredEvent): void {
  expect(leaf(event, "mismatched expectation").failure).toEqual({ type: "AssertionError" });
  expect(leaf(event, "throws with detail").failure).toEqual({ type: "AssertionError" });
  expect(leaf(event, "times out unmatched").failure).toEqual({ type: "TimeoutError" });
  expect(leaf(event, "adds numbers correctly").failure).toBeUndefined();
}

// ── pytest's grouping ────────────────────────────────────────────────────────

describe("pytest's classname grouping follows the framework, not the stack", () => {
  test("a one-suite pytest report whose cases carry classnames is grouped by classname for framework pytest under stack bun", async () => {
    const { res, event } = await ingest("group-pytest-on-bun", { stack: "bun", framework: "pytest" }, PYTEST_REPORT);
    expect(treeShape(event)).toEqual(PYTEST_GROUPED);
    expect(event.stack).toBe("bun");
    expect(event.framework).toBe("pytest");
    // The grouped run keeps every case's own reading and count.
    expect(leaf(event, "test_a1").failure?.message).toBe("assert 1 == 2");
    const run = res.body.run as Record<string, unknown>;
    expect([run.total, run.passed, run.failed, run.pending]).toEqual([4, 3, 1, 0]);
  });

  test("the same report is not grouped for framework unittest under stack python: its one pytest suite is its one node", async () => {
    const { event } = await ingest("group-unittest-on-python", { stack: "python", framework: "unittest" }, PYTEST_REPORT);
    expect(treeShape(event)).toEqual(PYTEST_BY_SUITE);
    expect(event.framework).toBe("unittest");
  });

  test("the same report is not grouped when the run states no framework, under stack python", async () => {
    const { event } = await ingest("group-none-on-python", { stack: "python" }, PYTEST_REPORT);
    expect(treeShape(event)).toEqual(PYTEST_BY_SUITE);
    expect(event.stack).toBe("python");
    expect(event.framework).toBeUndefined();
  });

  test("under framework pytest, a report of two suites is not grouped: each suite is its own node", async () => {
    const { event } = await ingest("group-pytest-two-suites", { stack: "python", framework: "pytest" }, TWO_SUITES);
    expect(treeShape(event)).toEqual([
      ["pytest", ["x1", "y1"]],
      ["other", ["z1"]],
    ]);
  });

  test("under framework pytest, a report of one suite named other than pytest is not grouped", async () => {
    const { event } = await ingest(
      "group-pytest-named-otherwise",
      { stack: "python", framework: "pytest" },
      ONE_SUITE_NAMED_OTHERWISE,
    );
    expect(treeShape(event)).toEqual([["tests", ["x1", "y1", "x2"]]]);
  });
});

// ── bun's console reading ────────────────────────────────────────────────────

describe("bun's console reading follows the framework, not the stack", () => {
  test("a failing case with no message takes bun's console message for framework bun-test under stack python", async () => {
    const { event } = await ingest(
      "console-bun-test-on-python",
      { stack: "python", framework: "bun-test" },
      BARE_JUNIT_TIMEOUT_RUN,
      CONSOLE,
    );
    expectConsoleRead(event);
    expect(event.stack).toBe("python");
    expect(event.framework).toBe("bun-test");
  });

  test("a failing case with no message keeps its type-only failure for framework vitest under stack bun", async () => {
    const { event } = await ingest(
      "console-vitest-on-bun",
      { stack: "bun", framework: "vitest" },
      BARE_JUNIT_TIMEOUT_RUN,
      CONSOLE,
    );
    expectConsoleNotRead(event);
  });

  test("a failing case with no message keeps its type-only failure when the run states no framework, under stack bun", async () => {
    const { event } = await ingest("console-none-on-bun", { stack: "bun" }, BARE_JUNIT_TIMEOUT_RUN, CONSOLE);
    expectConsoleNotRead(event);
    expect(event.framework).toBeUndefined();
  });

  test("a file bun could not load is stored as its failing ? case for framework bun-test under stack python", async () => {
    const { res, event } = await ingest(
      "load-errors-bun-test-on-python",
      { stack: "python", framework: "bun-test" },
      FOUR_FILES.junit,
      FOUR_FILES.plain,
    );
    const expected = CLIENT_LOAD_ERROR_READING["FOUR_FILES/plain"]!;
    expect(treeShape(event)).toEqual([
      ["a_passes.test.ts", ["passes"]],
      ...Object.keys(expected).map((file): [string, string[]] => [file, ["?"]]),
    ]);
    const run = res.body.run as Record<string, unknown>;
    expect([run.total, run.passed, run.failed]).toEqual([4, 1, 3]);
  });

  test("no ? case is stored for a file bun could not load for framework vitest under stack bun", async () => {
    const { res, event } = await ingest(
      "load-errors-vitest-on-bun",
      { stack: "bun", framework: "vitest" },
      FOUR_FILES.junit,
      FOUR_FILES.plain,
    );
    expect(treeShape(event)).toEqual([["a_passes.test.ts", ["passes"]]]);
    const run = res.body.run as Record<string, unknown>;
    expect([run.total, run.passed, run.failed]).toEqual([1, 1, 0]);
  });
});

// ── The effective framework ──────────────────────────────────────────────────

describe("a close stating no framework reads under the framework its run was started with", () => {
  test("a run started under framework pytest (stack bun) whose close states none groups its pytest report by classname", async () => {
    const { event, openRuns } = await startThenClose(
      "close-start-pytest",
      { stack: "bun", framework: "pytest" },
      {},
      [PYTEST_REPORT],
    );
    expect(treeShape(event)).toEqual(PYTEST_GROUPED);
    expect(event.framework).toBe("pytest");
    expect(openRuns).toEqual([]);
  });

  test("a run started under framework bun-test (stack python) whose close states none reads bun's console", async () => {
    const { event, openRuns } = await startThenClose(
      "close-start-bun-test",
      { stack: "python", framework: "bun-test" },
      {},
      BARE_JUNIT_TIMEOUT_RUN,
      CONSOLE,
    );
    expectConsoleRead(event);
    expect(event.framework).toBe("bun-test");
    expect(openRuns).toEqual([]);
  });

  test("a run started under stack python with no framework, closed stating none, leaves its pytest report grouped by suite", async () => {
    const { event } = await startThenClose("close-start-python-none", { stack: "python" }, {}, [PYTEST_REPORT]);
    expect(treeShape(event)).toEqual(PYTEST_BY_SUITE);
    expect(event.stack).toBe("python");
  });

  test("a run started under framework vitest (stack bun), closed stating none, does not read bun's console", async () => {
    const { event } = await startThenClose(
      "close-start-vitest",
      { stack: "bun", framework: "vitest" },
      {},
      BARE_JUNIT_TIMEOUT_RUN,
      CONSOLE,
    );
    expectConsoleNotRead(event);
  });

  test("a close that states framework pytest, on a run started under stack bun with none, reads under the framework it states", async () => {
    const { event } = await startThenClose(
      "close-states-pytest",
      { stack: "bun" },
      { framework: "pytest" },
      [PYTEST_REPORT],
    );
    expect(treeShape(event)).toEqual(PYTEST_GROUPED);
    expect(event.framework).toBe("pytest");
  });
});

// ── The codec reads the framework ────────────────────────────────────────────

/** Shape of a decoded tree, as `treeShape` reads a stored one. */
function decodedShape(tree: SuiteNode[]): Array<[string, string[]]> {
  return tree.map((s) => [s.name, s.children.map((c) => c.name)]);
}

/** Decode options as a caller states them, typed through the registry's own options. */
function options(stated: Record<string, string>): DecodeOptions {
  return stated as unknown as DecodeOptions;
}

describe("the junit codec decodes by the framework it is told, never by a stack", () => {
  const junit = codecs.get("junit")!;

  test("the registry's junit parse groups a pytest report for framework pytest, and not for stack python", async () => {
    const byFramework = await junit.parse(PYTEST_REPORT, options({ framework: "pytest" }));
    expect(decodedShape(byFramework.tree)).toEqual(PYTEST_GROUPED);
    const byStack = await junit.parse(PYTEST_REPORT, options({ stack: "python" }));
    expect(decodedShape(byStack.tree)).toEqual(PYTEST_BY_SUITE);
  });

  test("the registry's junit raw reading reads bun's console for framework bun-test, and not for stack bun", async () => {
    const forFramework = (await junit.parse(BARE_JUNIT_TIMEOUT_RUN)).tree;
    const files = junit.readRaw!(forFramework, CONSOLE, options({ framework: "bun-test" }));
    expect(files).toEqual([]);
    const read = forFramework.flatMap((s) => s.children).find((c) => c.name === "mismatched expectation");
    expect(read?.failure).toEqual({ type: "AssertionError", ...CONSOLE_READ["mismatched expectation"] });

    const forStack = (await junit.parse(BARE_JUNIT_TIMEOUT_RUN)).tree;
    junit.readRaw!(forStack, CONSOLE, options({ stack: "bun" }));
    const unread = forStack.flatMap((s) => s.children).find((c) => c.name === "mismatched expectation");
    expect(unread?.failure).toEqual({ type: "AssertionError" });
  });

  test("the registry's junit raw reading names the files bun could not load for framework bun-test, and none for stack bun", async () => {
    const tree = (await junit.parse(FOUR_FILES.junit)).tree;
    expect(junit.readRaw!(tree, FOUR_FILES.plain, options({ framework: "bun-test" }))).toEqual(
      Object.keys(CLIENT_LOAD_ERROR_READING["FOUR_FILES/plain"]!),
    );
    const untouched = (await junit.parse(FOUR_FILES.junit)).tree;
    expect(junit.readRaw!(untouched, FOUR_FILES.plain, options({ stack: "bun" }))).toEqual([]);
    expect(decodedShape(untouched)).toEqual([["a_passes.test.ts", ["passes"]]]);
  });
});

// ── An eda-pytest run reads as a pytest run ──────────────────────────────────

/** An eda project's pytest report: one suite named `pytest`, its cases in two classes. */
const EDA_TWO_CLASSES = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites name="pytest tests">',
  '<testsuite name="pytest" errors="0" failures="1" skipped="1" tests="4" time="0.040" hostname="h">',
  '<testcase classname="tests.unit.test_netlist.TestNetlist" name="test_nets_resolve" time="0.010"/>',
  '<testcase classname="tests.unit.test_perf.TestPerf" name="test_timing_closes" time="0.020"><failure message="assert 12.5 &lt;= 10.0">def test_timing_closes():\n&gt;   assert 12.5 &lt;= 10.0</failure></testcase>',
  '<testcase classname="tests.unit.test_netlist.TestNetlist" name="test_no_floating_pins" time="0.005"/>',
  '<testcase classname="tests.unit.test_perf.TestPerf" name="test_on_board" time="0.005"><skipped type="pytest.skip" message="board not attached">skipped</skipped></testcase>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

const EDA_TWO_CLASSES_GROUPED: Array<[string, string[]]> = [
  ["tests.unit.test_netlist.TestNetlist", ["test_nets_resolve", "test_no_floating_pins"]],
  ["tests.unit.test_perf.TestPerf", ["test_timing_closes", "test_on_board"]],
];

const EDA_TWO_CLASSES_BY_SUITE: Array<[string, string[]]> = [
  ["pytest", ["test_nets_resolve", "test_timing_closes", "test_no_floating_pins", "test_on_board"]],
];

const EDA_TWO_CLASSES_SUMMARY = { total: 4, passed: 2, failed: 1, pending: 1, duration_ms: 40 };

/**
 * An eda project's pytest report holding a module-level collection error: pytest
 * reports the module that failed to import as one erroring case with an empty
 * classname, beside the cases of a module that collected.
 */
const EDA_COLLECTION_ERROR = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites name="pytest tests">',
  '<testsuite name="pytest" errors="1" failures="0" skipped="0" tests="2" time="0.030" hostname="h">',
  '<testcase classname="" name="tests.unit.test_broken" time="0.000"><error message="collection failure">ImportError while importing test module tests/unit/test_broken.py</error></testcase>',
  '<testcase classname="tests.unit.test_netlist.TestNetlist" name="test_nets_resolve" time="0.010"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

const EDA_COLLECTION_ERROR_GROUPED: Array<[string, string[]]> = [
  ["pytest", ["tests.unit.test_broken"]],
  ["tests.unit.test_netlist.TestNetlist", ["test_nets_resolve"]],
];

describe("the junit codec groups an eda-pytest run by class, as it does a pytest run", () => {
  const junit = codecs.get("junit")!;

  test("an eda-pytest report whose one suite is pytest, its cases in two classes, decodes into the two class groups", async () => {
    const decoded = await junit.parse(EDA_TWO_CLASSES, options({ framework: "eda-pytest" }));
    expect(decodedShape(decoded.tree)).toEqual(EDA_TWO_CLASSES_GROUPED);
    expect(decoded.tree.map((s) => s.status)).toEqual(["pass", "fail"]);
    expect(decoded.summary).toEqual(EDA_TWO_CLASSES_SUMMARY);
  });

  test("an eda-pytest report decodes into the very tree, summary and files the same report gives under pytest", async () => {
    const asEda = await junit.parse(EDA_TWO_CLASSES, options({ framework: "eda-pytest" }));
    const asPytest = await junit.parse(EDA_TWO_CLASSES, options({ framework: "pytest" }));
    expect(decodedShape(asPytest.tree)).toEqual(EDA_TWO_CLASSES_GROUPED);
    expect(asEda).toEqual(asPytest);
  });

  test("an eda-pytest report's failing case keeps its failure message and trace inside its class group", async () => {
    const decoded = await junit.parse(EDA_TWO_CLASSES, options({ framework: "eda-pytest" }));
    const perf = decoded.tree.find((s) => s.name === "tests.unit.test_perf.TestPerf");
    expect(perf?.children.map((c) => [c.name, c.status])).toEqual([
      ["test_timing_closes", "fail"],
      ["test_on_board", "pending"],
    ]);
    expect(perf?.children[0]?.failure?.message).toBe("assert 12.5 <= 10.0");
    expect(perf?.children[0]?.failure?.trace).toBe("def test_timing_closes():\n>   assert 12.5 <= 10.0");
  });

  test("an eda-pytest report's module-level collection error, its classname empty, joins the node pytest as it does under pytest", async () => {
    const asEda = await junit.parse(EDA_COLLECTION_ERROR, options({ framework: "eda-pytest" }));
    expect(decodedShape(asEda.tree)).toEqual(EDA_COLLECTION_ERROR_GROUPED);
    expect(asEda.tree.map((s) => s.status)).toEqual(["fail", "pass"]);
    expect(asEda.tree[0]?.children[0]?.failure?.message).toBe("collection failure");
    expect(asEda.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 10 });
    const asPytest = await junit.parse(EDA_COLLECTION_ERROR, options({ framework: "pytest" }));
    expect(asEda).toEqual(asPytest);
  });

  test("an eda-pytest report whose pytest suite is not its only suite stays grouped by suite, as under pytest", async () => {
    const asEda = await junit.parse(TWO_SUITES, options({ framework: "eda-pytest" }));
    const asPytest = await junit.parse(TWO_SUITES, options({ framework: "pytest" }));
    expect(decodedShape(asEda.tree)).toEqual([
      ["pytest", ["x1", "y1"]],
      ["other", ["z1"]],
    ]);
    expect(asEda).toEqual(asPytest);
  });

  /** Every framework other than pytest and eda-pytest, and none: the report keeps its one-suite tree. */
  const NOT_GROUPED: Array<[string, Record<string, string>]> = [
    ["no framework", {}],
    ["framework vitest", { framework: "vitest" }],
    ["framework junit", { framework: "junit" }],
    ["framework unittest", { framework: "unittest" }],
    ["framework bun-test", { framework: "bun-test" }],
    ["stack eda and no framework", { stack: "eda" }],
  ];
  for (const [label, stated] of NOT_GROUPED) {
    test(`the same eda report under ${label} is not grouped: its one pytest suite is its one node`, async () => {
      const decoded = await junit.parse(EDA_TWO_CLASSES, options(stated));
      expect(decodedShape(decoded.tree)).toEqual(EDA_TWO_CLASSES_BY_SUITE);
      expect(decoded.summary).toEqual(EDA_TWO_CLASSES_SUMMARY);
    });
  }
});

// ── Nothing under src/codecs/ reads the stack ───────────────────────────────

/**
 * Every way a codec source reads a run's stack, comments aside (strings
 * kept, so a comparison with a literal is seen): a `stack` property read
 * (`options.stack`, `options?.stack`, `run.stack`), a `stack` declared as a
 * string (a parameter or an options field), a `stack` compared with a string
 * literal, and a `stack` key shorthand in an object literal or a
 * destructuring. A local of another type that happens to be named `stack`
 * (the XML parser's element stack) is none of these.
 */
const STACK_READS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "a stack property read", pattern: /(?:\?\.|\.)\s*stack\b/ },
  { what: "a stack declared as a string", pattern: /\bstack\s*\??\s*:\s*string\b/ },
  {
    what: "a stack compared with a string literal",
    pattern: /\bstack\s*[!=]==?\s*["'`]|["'`]\s*[!=]==?\s*stack\b/,
  },
  { what: "a stack key shorthand", pattern: /[{,]\s*stack\s*[,}]/ },
];

function stackReads(label: string, source: string): string[] {
  const code = jsUncommented(source);
  return STACK_READS.filter(({ pattern }) => pattern.test(code)).map(({ what }) => `${label}: ${what}`);
}

const SYNTHETIC_CLEAN = `
// A comment naming options.stack, a stack: string and stack === "python" never counts.
interface XmlElement { name: string }
export interface DecodeOptions {
  framework?: string;
  onSkip?: (report: string, error: string) => void;
}
function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "" };
  const stack: XmlElement[] = [root];
  const current = stack[stack.length - 1];
  stack.push(current);
  const open = stack.pop();
  if (stack.length !== 1) throw new Error("unclosed <" + stack[stack.length - 1].name + ">");
  return open ?? root;
}
export function parseJunit(xml: string, framework?: string) {
  const isPytest = framework === "pytest";
  return { isPytest, root: parseXml(xml) };
}
export const entry = { parse: (data: string, options?: DecodeOptions) => parseJunit(data, options?.framework) };
`;

const SYNTHETIC_VIOLATIONS: ReadonlyArray<{ what: string; source: string }> = [
  { what: "a stack property read", source: "const f = (o) => parseJunit(data, o?.stack);" },
  { what: "a stack property read", source: "const f = (o) => o.stack;" },
  { what: "a stack declared as a string", source: "export interface DecodeOptions { stack?: string; }" },
  { what: "a stack declared as a string", source: "export function parseJunit(xml: string, stack?: string) {}" },
  { what: "a stack compared with a string literal", source: 'const isPytest = s === 1 && stack === "python";' },
  { what: "a stack compared with a string literal", source: 'if ("bun" !== stack) return [];' },
  { what: "a stack key shorthand", source: "const options = { ...(x ? { stack } : {}), onSkip };" },
  { what: "a stack key shorthand", source: "const { stack, onSkip } = options;" },
];

function codecSources(): Array<{ label: string; source: string }> {
  const dir = join(import.meta.dir, "../..", "src", "codecs");
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => ({ label: `src/codecs/${name}`, source: readFileSync(join(dir, name), "utf-8") }));
}

describe("nothing under src/codecs/ reads the run's stack", () => {
  test("proved on a synthetic clean source: an element stack local, a framework option and comments naming the stack are no read", () => {
    expect(stackReads("synthetic", SYNTHETIC_CLEAN)).toEqual([]);
  });

  for (const { what, source } of SYNTHETIC_VIOLATIONS) {
    test(`proved on a synthetic source holding ${what}: ${source}`, () => {
      expect(stackReads("synthetic", source)).toContain(`synthetic: ${what}`);
    });
  }

  test("the codec sources are found: index.ts and junit.ts among them, so an empty read cannot pass", () => {
    const labels = codecSources().map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["src/codecs/index.ts", "src/codecs/junit.ts"]));
  });

  test("no source under src/codecs/ reads the run's stack", () => {
    const found = codecSources().flatMap(({ label, source }) => stackReads(label, source));
    expect(found).toEqual([]);
  });
});
