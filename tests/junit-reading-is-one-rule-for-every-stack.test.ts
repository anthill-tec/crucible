// One JUnit reading for every stack, decoded on the board by `POST /api/v2/runs`:
//
//  - the tree: one node per `<testsuite>` that holds testcases directly, at
//    any depth; a suite holding none is not a node; a missing or empty suite
//    or case name is `?`;
//  - python / pytest: when the run's stack is `python` and a report's only
//    suite is named `pytest`, its cases are grouped into one node per
//    non-empty `classname` (a case with none joins the node `pytest`), in
//    first-seen order; under any other stack, and for an xmlrunner report,
//    the cases stay grouped by suite;
//  - failure text, every stack: `message` is the non-empty `message`
//    attribute, else the first non-empty line of the text; `trace` is the
//    text; `type` is the `type` attribute; each part present only when
//    non-empty; message cut at 1000 characters, trace at 8000; no
//    `"test failed"` default;
//  - durations: a case's `time` in milliseconds, `Math.round(seconds * 1000)`;
//  - the stack: the ingest's `stack`, else the stack its run's start stated;
//    with none, or an unknown one, no stack-specific rule applies.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store); every stored outcome is read back through the run detail read
// `GET /api/v2/events/<id>`.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const handles: ServerHandle[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
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

interface StoredFailure {
  message?: string;
  type?: string;
  trace?: string;
}

interface StoredLeaf {
  name: string;
  status: string;
  duration_ms: number;
  failure?: StoredFailure;
}

interface StoredSuite {
  name: string;
  children: StoredLeaf[];
}

interface StoredEvent {
  id: string;
  stack?: string;
  tree?: StoredSuite[];
  [key: string]: unknown;
}

async function storedEvent(handle: ServerHandle, eventId: string): Promise<StoredEvent> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  return body.event as StoredEvent;
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

function counts(run: unknown): Record<string, unknown> {
  const r = run as Record<string, unknown>;
  return { total: r.total, passed: r.passed, failed: r.failed, pending: r.pending };
}

/**
 * Ingest `data` (one text or a list) as one run under `stack` (omitted when
 * undefined) and read the stored run back.
 */
async function ingest(
  agentId: string,
  data: string | string[],
  stack: string | undefined,
): Promise<{ res: Posted; event: StoredEvent }> {
  const handle = boot();
  const key = await ready(handle, agentId);
  const res = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId,
    codec: "junit",
    ...(stack !== undefined ? { stack } : {}),
    data,
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const event = await storedEvent(handle, res.body.event as string);
  return { res, event };
}

function reportDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "junit-reading-every-stack-"));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** Every stack the tree, failure-text and duration rules hold for — none included. */
const EVERY_STACK: Array<string | undefined> = [undefined, "bun", "python", "mvn", "rust", "arduino"];

function stackLabel(stack: string | undefined): string {
  return stack === undefined ? "no stack" : `stack ${stack}`;
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** Suites holding no testcase: empty, properties/output only, nested empty. */
const REPORT_EMPTY_SUITES = [
  "<testsuites>",
  '<testsuite name="Empty" tests="0"></testsuite>',
  '<testsuite name="SelfClosedEmpty" tests="0"/>',
  '<testsuite name="PropertiesOnly" tests="0">',
  '<properties><property name="k" value="v"/></properties>',
  "</testsuite>",
  '<testsuite name="Holder" tests="1">',
  '<testcase name="h1" time="0.01"/>',
  '<testsuite name="NestedEmpty" tests="0"/>',
  "</testsuite>",
  '<testsuite name="Last" tests="1">',
  '<testcase name="l1" time="0.01"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

/** Cases held three levels deep, behind wrappers that hold none. */
const REPORT_DEEP = [
  "<testsuites>",
  '<testsuite name="Outer" tests="2">',
  '<testcase name="o1" time="0.01"/>',
  '<testsuite name="Mid" tests="1">',
  '<testsuite name="Deep" tests="1">',
  '<testcase name="d1" time="0.01"/>',
  "</testsuite>",
  "</testsuite>",
  "</testsuite>",
  "</testsuites>",
].join("\n");

/** A nameless suite, an empty-named suite, a nameless case and an empty-named case. */
const REPORT_NAMELESS = [
  "<testsuites>",
  '<testsuite tests="1">',
  '<testcase name="in-nameless-suite" time="0.01"/>',
  "</testsuite>",
  '<testsuite name="" tests="1">',
  '<testcase name="in-empty-named-suite" time="0.01"/>',
  "</testsuite>",
  '<testsuite name="Cases" tests="3">',
  '<testcase time="0.01"/>',
  '<testcase name="" time="0.01"/>',
  '<testcase name="named" time="0.01"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

/** Failure text in every form the rule reads. */
const REPORT_FAILURES = [
  '<testsuite name="Failures" tests="8">',
  '<testcase name="attr-message" time="0.01"><failure message="expected 2" type="AssertionError">at line one\nat line two</failure></testcase>',
  '<testcase name="error-element" time="0.01"><error message="io broke" type="IOError">io stack</error></testcase>',
  '<testcase name="empty-message-attr" time="0.01"><failure message="" type="E">\n   \nfirst real line\nsecond line</failure></testcase>',
  '<testcase name="no-message-attr" time="0.01"><failure>only text line\nmore text</failure></testcase>',
  '<testcase name="type-only" time="0.01"><failure type="AssertionError"/></testcase>',
  '<testcase name="bare" time="0.01"><failure/></testcase>',
  '<testcase name="all-empty" time="0.01"><failure message="" type=""></failure></testcase>',
  '<testcase name="error-type-only" time="0.01"><error type="TimeoutError"></error></testcase>',
  "</testsuite>",
].join("\n");

/** A letters-only text of `length` characters, varied so a cut is checkable. */
function letters(length: number, offset = 0): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(97 + ((i + offset) % 26))).join("");
}

const LONG_MESSAGE_ATTR = letters(1500);
/** A 1200-character first line, then lines enough to make a 9000-character text. */
const LONG_FIRST_LINE = letters(1200, 3);
const LONG_TEXT = [LONG_FIRST_LINE, ...Array.from({ length: 40 }, (_, i) => letters(199, i))].join("\n");

const REPORT_LONG_FAILURES = [
  '<testsuite name="Long" tests="2">',
  `<testcase name="long-attr" time="0.01"><failure message="${LONG_MESSAGE_ATTR}" type="T">short trace</failure></testcase>`,
  `<testcase name="long-text" time="0.01"><failure>${LONG_TEXT}</failure></testcase>`,
  "</testsuite>",
].join("\n");

/** Times whose rounding differs from truncation. */
const REPORT_DURATIONS = [
  '<testsuite name="Timed" tests="4">',
  '<testcase name="t-1.6ms" time="0.0016"/>',
  '<testcase name="t-999.6ms" time="0.9996"/>',
  '<testcase name="t-0.4ms" time="0.0004"/>',
  '<testcase name="t-1234.5ms" time="1.2345"/>',
  "</testsuite>",
].join("\n");

/** pytest's report: one `pytest` suite, cases carrying their classname or none. */
const PYTEST_REPORT = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites name="pytest tests">',
  '<testsuite name="pytest" errors="0" failures="1" skipped="1" tests="6" time="0.021" hostname="h">',
  '<testcase classname="tests.test_beta.TestBeta" name="test_b1" time="0.010"/>',
  '<testcase classname="" name="test_loose_1" time="0.001"/>',
  '<testcase classname="tests.test_alpha" name="test_a1" time="0.002"><failure message="assert 1 == 2">def test_a1():\n&gt;   assert 1 == 2</failure></testcase>',
  '<testcase classname="tests.test_beta.TestBeta" name="test_b2" time="0.003"><skipped type="pytest.skip" message="later">skipped</skipped></testcase>',
  '<testcase name="test_loose_2" time="0.001"/>',
  '<testcase classname="tests.test_alpha" name="test_a2" time="0.004"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

const PYTEST_GROUPED: Array<[string, string[]]> = [
  ["tests.test_beta.TestBeta", ["test_b1", "test_b2"]],
  ["pytest", ["test_loose_1", "test_loose_2"]],
  ["tests.test_alpha", ["test_a1", "test_a2"]],
];

const PYTEST_BY_SUITE: Array<[string, string[]]> = [
  ["pytest", ["test_b1", "test_loose_1", "test_a1", "test_b2", "test_loose_2", "test_a2"]],
];

const PYTEST_COUNTS = { total: 6, passed: 4, failed: 1, pending: 1 };

/** pytest's report as a bare `<testsuite>` root. */
const PYTEST_BARE_ROOT = [
  '<testsuite name="pytest" tests="3">',
  '<testcase classname="tests.test_x" name="x1" time="0.001"/>',
  '<testcase classname="tests.test_y" name="y1" time="0.001"/>',
  '<testcase classname="tests.test_x" name="x2" time="0.001"/>',
  "</testsuite>",
].join("\n");

/** A `pytest` suite beside another: the report's only suite is not `pytest`. */
const PYTEST_BESIDE_ANOTHER = [
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

/** The subtest runner's xmlrunner reports: one suite per class, cases with classnames. */
const XMLRUNNER_A = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<testsuites>",
  '<testsuite name="tests.test_a.TestA-20261027120000" tests="2" file="tests/test_a.py" time="0.003">',
  '<testcase classname="tests.test_a.TestA" name="test_one" time="0.001" file="tests/test_a.py"/>',
  '<testcase classname="tests.test_a.TestA" name="test_two" time="0.002" file="tests/test_a.py"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

const XMLRUNNER_B = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<testsuites>",
  '<testsuite name="tests.test_b.TestB-20261027120000" tests="1" file="tests/test_b.py" time="0.001">',
  '<testcase classname="tests.test_b.TestB" name="test_three" time="0.001" file="tests/test_b.py"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

// ── The tree ─────────────────────────────────────────────────────────────────

describe("the stored tree has one node per suite that holds testcases, under every stack", () => {
  for (const stack of EVERY_STACK) {
    test(`a suite holding no testcase — empty, self-closed, properties only, or nested — is not a node (${stackLabel(stack)})`, async () => {
      const { res, event } = await ingest(`tree-empty-${stack ?? "none"}`, REPORT_EMPTY_SUITES, stack);
      expect(counts(res.body.run)).toEqual({ total: 2, passed: 2, failed: 0, pending: 0 });
      expect(treeShape(event)).toEqual([
        ["Holder", ["h1"]],
        ["Last", ["l1"]],
      ]);
    });

    test(`a suite holding cases three levels deep is a node and the wrappers holding none are not (${stackLabel(stack)})`, async () => {
      const { res, event } = await ingest(`tree-deep-${stack ?? "none"}`, REPORT_DEEP, stack);
      expect(counts(res.body.run)).toEqual({ total: 2, passed: 2, failed: 0, pending: 0 });
      expect(treeShape(event)).toEqual([
        ["Outer", ["o1"]],
        ["Deep", ["d1"]],
      ]);
    });

    test(`a missing or empty suite name and a missing or empty case name are each stored as "?" (${stackLabel(stack)})`, async () => {
      const { res, event } = await ingest(`tree-names-${stack ?? "none"}`, REPORT_NAMELESS, stack);
      expect(counts(res.body.run)).toEqual({ total: 5, passed: 5, failed: 0, pending: 0 });
      expect(treeShape(event)).toEqual([
        ["?", ["in-nameless-suite"]],
        ["?", ["in-empty-named-suite"]],
        ["Cases", ["?", "?", "named"]],
      ]);
      // No stack names a nameless suite after itself (`native`) or leaves it blank.
      expect(treeShape(event).map(([name]) => name)).not.toContain("native");
      expect(treeShape(event).map(([name]) => name)).not.toContain("");
    });
  }
});

// ── Failure text ─────────────────────────────────────────────────────────────

describe("a failure's message, type and trace are read by one rule under every stack", () => {
  for (const stack of EVERY_STACK) {
    test(`a non-empty message attribute is the message, the text the trace, the type attribute the type — for <failure> and <error> (${stackLabel(stack)})`, async () => {
      const { event } = await ingest(`fail-attr-${stack ?? "none"}`, REPORT_FAILURES, stack);
      expect(leaf(event, "attr-message").status).toBe("fail");
      expect(leaf(event, "attr-message").failure).toEqual({
        message: "expected 2",
        type: "AssertionError",
        trace: "at line one\nat line two",
      });
      expect(leaf(event, "error-element").status).toBe("fail");
      expect(leaf(event, "error-element").failure).toEqual({
        message: "io broke",
        type: "IOError",
        trace: "io stack",
      });
    });

    test(`an empty message attribute gives way to the first non-empty line of the text (${stackLabel(stack)})`, async () => {
      const { event } = await ingest(`fail-empty-attr-${stack ?? "none"}`, REPORT_FAILURES, stack);
      const failure = leaf(event, "empty-message-attr").failure!;
      expect(failure.message).toBe("first real line");
      expect(failure.type).toBe("E");
      // The trace is the failure's text (whether its blank leading lines are
      // trimmed is not what this case pins).
      expect(failure.trace?.trim()).toBe("first real line\nsecond line");
      expect(Object.keys(failure).sort()).toEqual(["message", "trace", "type"]);
    });

    test(`a failure with no message attribute takes the first non-empty line of its text and has no type (${stackLabel(stack)})`, async () => {
      const { event } = await ingest(`fail-no-attr-${stack ?? "none"}`, REPORT_FAILURES, stack);
      expect(leaf(event, "no-message-attr").failure).toEqual({
        message: "only text line",
        trace: "only text line\nmore text",
      });
    });

    test(`a failure carrying only its type stores only its type — no "test failed" message, no trace (${stackLabel(stack)})`, async () => {
      const { event } = await ingest(`fail-type-only-${stack ?? "none"}`, REPORT_FAILURES, stack);
      expect(leaf(event, "type-only").status).toBe("fail");
      expect(leaf(event, "type-only").failure).toEqual({ type: "AssertionError" });
      expect(leaf(event, "error-type-only").status).toBe("fail");
      expect(leaf(event, "error-type-only").failure).toEqual({ type: "TimeoutError" });
    });

    test(`a bare failure, and one whose message, type and text are all empty, is failed with no message, type or trace (${stackLabel(stack)})`, async () => {
      const { res, event } = await ingest(`fail-bare-${stack ?? "none"}`, REPORT_FAILURES, stack);
      expect(counts(res.body.run)).toEqual({ total: 8, passed: 0, failed: 8, pending: 0 });
      for (const name of ["bare", "all-empty"]) {
        const stored = leaf(event, name);
        expect(stored.status).toBe("fail");
        const failure = stored.failure ?? {};
        expect(failure).toEqual({});
        expect(failure.message).toBeUndefined();
        expect(JSON.stringify(stored)).not.toContain("test failed");
      }
    });

    test(`a message is cut at 1000 characters and a trace at 8000 (${stackLabel(stack)})`, async () => {
      const { event } = await ingest(`fail-cut-${stack ?? "none"}`, REPORT_LONG_FAILURES, stack);

      const fromAttr = leaf(event, "long-attr").failure!;
      expect(fromAttr.message).toBe(LONG_MESSAGE_ATTR.slice(0, 1000));
      expect(fromAttr.message?.length).toBe(1000);
      expect(fromAttr.type).toBe("T");
      expect(fromAttr.trace).toBe("short trace");

      const fromText = leaf(event, "long-text").failure!;
      expect(LONG_TEXT.length).toBeGreaterThan(8000);
      expect(fromText.message).toBe(LONG_FIRST_LINE.slice(0, 1000));
      expect(fromText.message?.length).toBe(1000);
      expect(fromText.trace).toBe(LONG_TEXT.slice(0, 8000));
      expect(fromText.trace?.length).toBe(8000);
      expect(fromText.type).toBeUndefined();
    });
  }
});

// ── Durations ────────────────────────────────────────────────────────────────

describe("a case's duration is its time in milliseconds, rounded, under every stack", () => {
  for (const stack of EVERY_STACK) {
    test(`time in seconds is stored as Math.round(seconds * 1000) milliseconds, not truncated and not zeroed (${stackLabel(stack)})`, async () => {
      const { event } = await ingest(`durations-${stack ?? "none"}`, REPORT_DURATIONS, stack);
      expect(leaf(event, "t-1.6ms").duration_ms).toBe(2);
      expect(leaf(event, "t-999.6ms").duration_ms).toBe(1000);
      expect(leaf(event, "t-0.4ms").duration_ms).toBe(0);
      expect(leaf(event, "t-1234.5ms").duration_ms).toBe(1235);
    });
  }
});

// ── pytest grouping ──────────────────────────────────────────────────────────

describe("a pytest report under stack python is grouped by classname", () => {
  test("its cases form one node per non-empty classname in first-seen order, cases with none or an empty one joining the node pytest", async () => {
    const { res, event } = await ingest("pytest-python", PYTEST_REPORT, "python");
    expect(counts(res.body.run)).toEqual(PYTEST_COUNTS);
    expect(treeShape(event)).toEqual(PYTEST_GROUPED);
    // The grouped run keeps every case's own reading.
    expect(leaf(event, "test_a1").status).toBe("fail");
    expect(leaf(event, "test_a1").failure?.message).toBe("assert 1 == 2");
    expect(leaf(event, "test_b2").status).toBe("pending");
    expect(leaf(event, "test_b1").duration_ms).toBe(10);
  });

  test("a pytest report whose suite is the bare root is grouped by classname too", async () => {
    const { event } = await ingest("pytest-bare-root", PYTEST_BARE_ROOT, "python");
    expect(treeShape(event)).toEqual([
      ["tests.test_x", ["x1", "x2"]],
      ["tests.test_y", ["y1"]],
    ]);
  });

  test("a report whose pytest suite is not its only suite stays grouped by suite", async () => {
    const { res, event } = await ingest("pytest-beside", PYTEST_BESIDE_ANOTHER, "python");
    expect(counts(res.body.run)).toEqual({ total: 3, passed: 3, failed: 0, pending: 0 });
    expect(treeShape(event)).toEqual([
      ["pytest", ["x1", "y1"]],
      ["other", ["z1"]],
    ]);
  });

  test("the subtest runner's xmlrunner reports under stack python stay grouped by suite, not by classname", async () => {
    const { res, event } = await ingest("xmlrunner-python", [XMLRUNNER_A, XMLRUNNER_B], "python");
    expect(counts(res.body.run)).toEqual({ total: 3, passed: 3, failed: 0, pending: 0 });
    expect(treeShape(event)).toEqual([
      ["tests.test_a.TestA-20261027120000", ["test_one", "test_two"]],
      ["tests.test_b.TestB-20261027120000", ["test_three"]],
    ]);
  });

  test("in a list under stack python, the pytest report is grouped by classname and the xmlrunner report beside it by suite", async () => {
    const { res, event } = await ingest("pytest-mixed-list", [PYTEST_REPORT, XMLRUNNER_B], "python");
    expect(counts(res.body.run)).toEqual({ total: 7, passed: 5, failed: 1, pending: 1 });
    expect(treeShape(event)).toEqual([
      ...PYTEST_GROUPED,
      ["tests.test_b.TestB-20261027120000", ["test_three"]],
    ]);
  });

  test("a pytest report read from a dataPath directory under stack python is grouped by classname", async () => {
    const handle = boot();
    const key = await ready(handle, "pytest-datapath");
    const dir = reportDir({ "TEST-pytest.xml": PYTEST_REPORT });
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "pytest-datapath",
      codec: "junit",
      stack: "python",
      dataPath: dir,
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual(PYTEST_COUNTS);
    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event)).toEqual(PYTEST_GROUPED);
  });

  for (const stack of [undefined, "bun", "mvn", "rust", "arduino", "cobol"]) {
    test(`the same pytest report under ${stackLabel(stack)} is not grouped: its one pytest suite is its one node`, async () => {
      const { res, event } = await ingest(`pytest-not-python-${stack ?? "none"}`, PYTEST_REPORT, stack);
      expect(counts(res.body.run)).toEqual(PYTEST_COUNTS);
      expect(treeShape(event)).toEqual(PYTEST_BY_SUITE);
    });
  }
});

// ── The effective stack ──────────────────────────────────────────────────────

describe("a run's reports are decoded under its effective stack", () => {
  /** Start a run under `startStack`, then close it with an ingest that omits its stack. */
  async function startThenIngest(
    agentId: string,
    startStack: string,
  ): Promise<{ event: StoredEvent; openRuns: string[] }> {
    const handle = boot();
    const key = await ready(handle, agentId);
    const start = await postJson(handle, "/api/v2/runs/start", {
      projectKey: key,
      agentId,
      stack: startStack,
      tier: "unit",
    });
    expect(start.status).toBe(202);
    const runId = start.body.runId as string;
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId,
      codec: "junit",
      runId,
      data: [PYTEST_REPORT],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual(PYTEST_COUNTS);
    const event = await storedEvent(handle, res.body.event as string);
    const list = await getJson(handle, `/api/v2/events?project=${key}`);
    return { event, openRuns: (list.openRuns as { runId: string }[]).map((r) => r.runId) };
  }

  test("an ingest that omits its stack, closing a run started under python, groups its pytest report by classname", async () => {
    const { event, openRuns } = await startThenIngest("stack-start-python", "python");
    expect(event.stack).toBe("python");
    expect(treeShape(event)).toEqual(PYTEST_GROUPED);
    expect(openRuns).toEqual([]);
  });

  test("an ingest that omits its stack, closing a run started under bun, leaves its pytest report grouped by suite", async () => {
    const { event, openRuns } = await startThenIngest("stack-start-bun", "bun");
    expect(event.stack).toBe("bun");
    expect(treeShape(event)).toEqual(PYTEST_BY_SUITE);
    expect(openRuns).toEqual([]);
  });
});
