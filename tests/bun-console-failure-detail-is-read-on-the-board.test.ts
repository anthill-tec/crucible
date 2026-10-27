// bun's console failure detail, read on the board — through the ingest route.
//
// When a run's stack is `bun`, a failing case whose message is empty takes
// its message and trace from bun's console output in the run's `raw`, by the
// rules the bun client applies today; a case the console does not explain
// keeps its type-only failure; a case whose report already gives a message
// keeps it. Under any other stack — or none — the console is not read.
//
// Each case is driven through the real production HTTP surface
// (`startServer`, in-memory store): a bun JUnit report whose failures are
// bare `<failure type="…"/>` nodes is posted to `POST /api/v2/runs` with the
// console text in `raw`, and the stored leaves are read back through
// `GET /api/v2/events/<id>`. Because the report's failures are bare, a stored
// message can only have come off the console. The expected stored failure is
// the junit `type` plus the bun client's own reading of the console
// (CLIENT_READING in tests/fixtures/bun-console-captures.ts, the same
// captures the client's tests pinned).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import {
  AFTERMATH_BLEED,
  BARE_JUNIT_AFTERMATH_RUN,
  BARE_JUNIT_TIMEOUT_RUN,
  BOUNDARY_ENDS_BLOCK,
  CLIENT_READING,
  DETAIL_AFTER_FAIL_LINE,
  DETAIL_BEFORE_FAIL_LINE,
  EACH_IT,
  EACH_TEST,
  ECHOLESS_HELPER,
  ESCAPED_QUOTE,
  LEAK_MULTILINE,
  LEAK_NESTED,
  LEAK_ONELINER,
  LEGIT_CONSECUTIVE,
  LEGIT_NESTED,
  LONG_DETAIL,
  NESTED_RESULT_LINE,
  REAL_LEAKED_ASYNC_ERROR,
  SECOND_ERROR_ONE_WINDOW,
  SPLIT_DECL,
  TEMPLATE_NAME,
  TIMEOUT_DETAIL_AFTER_FAIL,
  TIMEOUT_DETAIL_BEFORE_FAIL,
  VARIABLE_NAME,
} from "./fixtures/bun-console-captures.ts";
import type { Capture, WireForm } from "./fixtures/bun-console-captures.ts";

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
  failure?: StoredFailure;
}

interface StoredEvent {
  stack?: string;
  tree?: Array<{ name: string; children: StoredLeaf[] }>;
}

async function storedEvent(handle: ServerHandle, eventId: string): Promise<StoredEvent> {
  const res = await fetch(`${base(handle)}/api/v2/events/${eventId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { event: StoredEvent }).event;
}

function leaves(event: StoredEvent): StoredLeaf[] {
  return (event.tree ?? []).flatMap((suite) => suite.children);
}

function leaf(event: StoredEvent, name: string): StoredLeaf {
  const found = leaves(event).filter((c) => c.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
}

/** Ingest one junit report with `raw` (both omitted when undefined) and read the stored run back. */
async function ingest(opts: {
  agentId: string;
  report: string;
  raw?: string;
  stack?: string;
}): Promise<StoredEvent> {
  const handle = boot();
  const key = await ready(handle, opts.agentId);
  const res = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId: opts.agentId,
    codec: "junit",
    data: opts.report,
    ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
    ...(opts.stack !== undefined ? { stack: opts.stack } : {}),
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return storedEvent(handle, res.body.event as string);
}

// ── bun-shaped JUnit reports with bare failures ─────────────────────────────

interface BareCase {
  name: string;
  /** The describe blocks the case sits in, outermost first. */
  describe?: string[];
  /** The bare failure's type; undefined is a passing case. */
  type?: string;
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A report as bun writes it: one suite per file, a nested suite per describe
 * block, and every failure a bare `<failure type="…"/>`.
 */
function bareJunit(file: string, cases: BareCase[]): string {
  const groups = new Map<string, BareCase[]>();
  for (const c of cases) {
    const path = (c.describe ?? []).join("\u0000");
    const group = groups.get(path);
    if (group === undefined) groups.set(path, [c]);
    else group.push(c);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="bun test" tests="${cases.length}">`,
    `<testsuite name="${xmlAttr(file)}" file="${xmlAttr(file)}" tests="${cases.length}">`,
  ];
  for (const [path, group] of groups) {
    const describes = path.length > 0 ? path.split("\u0000") : [];
    for (const d of describes) lines.push(`<testsuite name="${xmlAttr(d)}">`);
    for (const c of group) {
      const open = `<testcase name="${xmlAttr(c.name)}" classname="" time="0.0001" file="${xmlAttr(file)}"`;
      lines.push(c.type === undefined ? `${open} />` : `${open}><failure type="${xmlAttr(c.type)}" /></testcase>`);
    }
    for (let i = 0; i < describes.length; i += 1) lines.push("</testsuite>");
  }
  lines.push("</testsuite>", "</testsuites>");
  return lines.join("\n");
}

const ASSERTION = "AssertionError";

/** Every capture the bun client pinned, with the cases bun's report holds for it. */
const RUNS: Array<{ name: string; capture: Capture; about: string; file: string; cases: BareCase[] }> = [
  {
    name: "LEGIT_CONSECUTIVE",
    capture: LEGIT_CONSECUTIVE,
    about: "two consecutive failures each store their own console detail",
    file: "a.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: "beta throws its own boom", type: ASSERTION },
    ],
  },
  {
    name: "LEAK_MULTILINE",
    capture: LEAK_MULTILINE,
    about: "a leaked throw's aftermath reaches no later case: delta stays type-only",
    file: "b.test.ts",
    cases: [
      { name: "gamma leaks after failing", type: ASSERTION },
      { name: "delta fails later", type: ASSERTION },
    ],
  },
  {
    name: "LEAK_NESTED",
    capture: LEAK_NESTED,
    about: "under nested describes the aftermath reaches no later case: zeta stays type-only",
    file: "c.test.ts",
    cases: [
      { name: "epsilon leaks after failing", describe: ["outer", "inner"], type: ASSERTION },
      { name: "zeta fails later", describe: ["outer", "inner"], type: ASSERTION },
    ],
  },
  {
    name: "ECHOLESS_HELPER",
    capture: ECHOLESS_HELPER,
    about: "echoes naming no test marry by position, each case its own call site",
    file: "d.test.ts",
    cases: [
      { name: "eta fails inside a helper", type: "Error" },
      { name: "theta fails inside a helper", type: "Error" },
    ],
  },
  {
    name: "LEGIT_NESTED",
    capture: LEGIT_NESTED,
    about: "under nested describes each case stores its own detail, matched on the result line's last segment",
    file: "e.test.ts",
    cases: [
      { name: "iota asserts wrongly", describe: ["outer", "inner"], type: ASSERTION },
      { name: "kappa throws its own boom", describe: ["outer", "inner"], type: "Error" },
    ],
  },
  {
    name: "LEAK_ONELINER",
    capture: LEAK_ONELINER,
    about: "a one-line leak's aftermath reaches no later case: beta stays type-only",
    file: "f.test.ts",
    cases: [
      { name: "alpha fails and leaks", type: ASSERTION },
      { name: "beta fails", type: ASSERTION },
    ],
  },
  {
    name: "EACH_TEST",
    capture: EACH_TEST,
    about: "a test.each case stores its own detail, its predecessor its own",
    file: "g.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: "beta each 1", type: "Error" },
    ],
  },
  {
    name: "EACH_IT",
    capture: EACH_IT,
    about: "an it.each case stores its own detail, its predecessor its own",
    file: "h.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: "gamma each 2", type: "Error" },
    ],
  },
  {
    name: "VARIABLE_NAME",
    capture: VARIABLE_NAME,
    about: "a variable-named case stores its own detail, its predecessor its own",
    file: "i.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: "delta named by a variable", type: "Error" },
    ],
  },
  {
    name: "SPLIT_DECL",
    capture: SPLIT_DECL,
    about: "a case declared over several lines stores its own detail, its predecessor its own",
    file: "j.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: "epsilon split over lines", type: "Error" },
    ],
  },
  {
    name: "TEMPLATE_NAME",
    capture: TEMPLATE_NAME,
    about: "a template-literal-named case stores its own detail, its predecessor its own",
    file: "k.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: "zeta 3 interpolated", type: "Error" },
    ],
  },
  {
    name: "ESCAPED_QUOTE",
    capture: ESCAPED_QUOTE,
    about: "a case whose name holds an escaped quote stores its own detail, its predecessor its own",
    file: "l.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: 'lambda says "hi" loudly', type: "Error" },
    ],
  },
  {
    name: "REAL_LEAKED_ASYNC_ERROR",
    capture: REAL_LEAKED_ASYNC_ERROR,
    about: "the earlier real one-line leak: alpha stores its own detail, beta stays type-only",
    file: "unc.test.ts",
    cases: [
      { name: "alpha fails and leaks", type: ASSERTION },
      { name: "beta fails", type: ASSERTION },
    ],
  },
  {
    name: "DETAIL_BEFORE_FAIL_LINE",
    capture: DETAIL_BEFORE_FAIL_LINE,
    about: "each block before a result line is stored on that case",
    file: "sample.test.ts",
    cases: [
      { name: "alpha asserts wrongly", type: ASSERTION },
      { name: "beta throws with detail", type: "Error" },
    ],
  },
  {
    name: "NESTED_RESULT_LINE",
    capture: NESTED_RESULT_LINE,
    about: "a nested describe's case stores the block before its composed result line, free of SGR escapes",
    file: "sample.test.ts",
    cases: [{ name: "nested leaf", describe: ["suite"], type: "Error" }],
  },
  {
    name: "DETAIL_AFTER_FAIL_LINE",
    capture: DETAIL_AFTER_FAIL_LINE,
    about: "a timeout's detail after its own result line is not stored: the case stays type-only",
    file: "sample.test.ts",
    cases: [{ name: "alpha times out", type: "TimeoutError" }],
  },
  {
    name: "BOUNDARY_ENDS_BLOCK",
    capture: BOUNDARY_ENDS_BLOCK,
    about: "a block crossed by pass and skip result lines reaches no later case: every failure stays type-only",
    file: "sample.test.ts",
    cases: [
      { name: "alpha times out", type: "TimeoutError" },
      { name: "gamma passes" },
      { name: "beta asserts wrongly", type: ASSERTION },
    ],
  },
  {
    name: "SECOND_ERROR_ONE_WINDOW",
    capture: SECOND_ERROR_ONE_WINDOW,
    about: "a second error: under one echo window is stored, by position, on the next failing case",
    file: "m.test.ts",
    cases: [{ name: "beta follows", type: "Error" }],
  },
  {
    name: "LONG_DETAIL",
    capture: LONG_DETAIL,
    about: "a long detail is stored cut: message at 1000 characters, trace at 8000",
    file: "n.test.ts",
    cases: [{ name: "omega overflows", type: "Error" }],
  },
];

/** The stored failure a case must carry: its junit type, plus the client's reading of the console for it. */
function expectedFailure(readingKey: string, c: BareCase): StoredFailure {
  const married = CLIENT_READING[readingKey]?.[c.name];
  return { type: c.type, ...(married !== undefined ? married : {}) };
}

// ── Every pinned capture, through the route ─────────────────────────────────

describe("a bun run's failing cases with no message store their console detail, as the bun client read it", () => {
  for (const run of RUNS) {
    for (const wire of ["plain", "ansi"] as WireForm[]) {
      const consoleText = run.capture[wire];
      if (consoleText === undefined) continue;
      test(`${run.name} (${wire}): ${run.about}`, async () => {
        const event = await ingest({
          agentId: `bun-console-${run.name.toLowerCase()}-${wire}`,
          report: bareJunit(run.file, run.cases),
          raw: consoleText,
          stack: "bun",
        });
        const readingKey = `${run.name}/${wire}`;
        expect(CLIENT_READING[readingKey]).toBeDefined();
        for (const c of run.cases) {
          const stored = leaf(event, c.name);
          if (c.type === undefined) {
            expect(stored.status).toBe("pass");
            expect(stored.failure).toBeUndefined();
          } else {
            expect(stored.status).toBe("fail");
            expect(stored.failure).toEqual(expectedFailure(readingKey, c));
          }
        }
        // Whatever the console holds, nothing is stored escaped.
        expect(JSON.stringify(leaves(event))).not.toContain("\\u001b");
      });
    }
  }

  // The spot checks below name the outcome each port turns on, so a wrong
  // oracle could not hide behind the table above.
  test("the one-line leak: alpha stores its own message, beta's stored failure is its type and nothing else", async () => {
    for (const wire of ["plain", "ansi"] as WireForm[]) {
      const event = await ingest({
        agentId: `bun-console-leak-spot-${wire}`,
        report: bareJunit("f.test.ts", [
          { name: "alpha fails and leaks", type: ASSERTION },
          { name: "beta fails", type: ASSERTION },
        ]),
        raw: LEAK_ONELINER[wire]!,
        stack: "bun",
      });
      expect(leaf(event, "alpha fails and leaks").failure?.message).toBe("expect(received).toBe(expected)");
      expect(leaf(event, "beta fails").failure).toEqual({ type: ASSERTION });
    }
  });

  test("a test.each case and its predecessor store distinct messages, each its own", async () => {
    for (const wire of ["plain", "ansi"] as WireForm[]) {
      const event = await ingest({
        agentId: `bun-console-each-spot-${wire}`,
        report: bareJunit("g.test.ts", [
          { name: "alpha asserts wrongly", type: ASSERTION },
          { name: "beta each 1", type: "Error" },
        ]),
        raw: EACH_TEST[wire]!,
        stack: "bun",
      });
      expect(leaf(event, "alpha asserts wrongly").failure?.message).toBe("expect(received).toBe(expected)");
      expect(leaf(event, "beta each 1").failure?.message).toBe("beta each boom");
    }
  });

  test("a long detail is stored as exactly 1000 message characters and 8000 trace characters", async () => {
    const event = await ingest({
      agentId: "bun-console-long-spot",
      report: bareJunit("n.test.ts", [{ name: "omega overflows", type: "Error" }]),
      raw: LONG_DETAIL.plain,
      stack: "bun",
    });
    const failure = leaf(event, "omega overflows").failure;
    expect(failure?.message).toBe("M".repeat(1000));
    expect(failure?.trace?.length).toBe(8000);
    expect(failure?.type).toBe("Error");
  });
});

// ── The real runs the bun client's own suite froze ──────────────────────────

describe("the real bun runs the bun client froze, ingested with bun's own bare report", () => {
  test("a timeout whose detail lands after its result line: the assertion and the throw store their detail, the timeout stays type-only, the passing case gains nothing", async () => {
    const event = await ingest({
      agentId: "bun-console-frozen-timeout-after",
      report: BARE_JUNIT_TIMEOUT_RUN,
      raw: TIMEOUT_DETAIL_AFTER_FAIL.plain,
      stack: "bun",
    });
    const mismatch = leaf(event, "mismatched expectation").failure;
    expect(mismatch?.message).toBe("expect(received).toBe(expected)");
    expect(mismatch?.trace).toContain("Expected: 3");
    expect(mismatch?.trace).toContain("Received: 2");
    expect(mismatch?.type).toBe("AssertionError");
    expect(leaf(event, "throws with detail").failure?.message).toBe("boom with detail");
    const timedOut = leaf(event, "times out unmatched");
    expect(timedOut.status).toBe("fail");
    expect(timedOut.failure).toEqual({ type: "TimeoutError" });
    expect(leaf(event, "adds numbers correctly").failure).toBeUndefined();
  });

  test("the same run with the timeout's detail before its result line stores it on the timeout — and only there", async () => {
    const event = await ingest({
      agentId: "bun-console-frozen-timeout-before",
      report: BARE_JUNIT_TIMEOUT_RUN,
      raw: TIMEOUT_DETAIL_BEFORE_FAIL.plain,
      stack: "bun",
    });
    expect(leaf(event, "times out unmatched").failure).toEqual({
      type: "TimeoutError",
      ...CLIENT_READING["TIMEOUT_DETAIL_BEFORE_FAIL/plain"]!["times out unmatched"],
    });
    expect(leaf(event, "times out unmatched").failure?.message).toBe("this test timed out after 50ms.");
    expect(leaf(event, "mismatched expectation").failure?.message).toBe("expect(received).toBe(expected)");
    expect(leaf(event, "throws with detail").failure?.message).toBe("boom with detail");
  });

  test("a leaked async throw: gamma stores its own message and trace, delta stores its type and no trace of 'leaked boom'", async () => {
    const event = await ingest({
      agentId: "bun-console-frozen-aftermath",
      report: BARE_JUNIT_AFTERMATH_RUN,
      raw: AFTERMATH_BLEED.plain,
      stack: "bun",
    });
    const gamma = leaf(event, "gamma leaks after failing").failure;
    expect(gamma?.message).toBe("expect(received).toBe(expected)");
    expect(gamma?.trace).toContain("Expected: 2");
    expect(gamma?.trace).toContain("Received: 1");
    expect(gamma?.message).not.toContain("leaked boom");
    const delta = leaf(event, "delta fails later");
    expect(delta.status).toBe("fail");
    expect(delta.failure).toEqual({ type: "AssertionError" });
  });
});

// ── Which cases, and which runs, read the console ───────────────────────────

describe("only a bun run's failing cases with no message read the console", () => {
  test("a case whose report gives its failure text keeps that text; a bare case beside it reads the console", async () => {
    const report = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="bun test" tests="2">',
      '<testsuite name="a.test.ts" file="a.test.ts" tests="2">',
      '<testcase name="alpha asserts wrongly" classname="" time="0.0001" file="a.test.ts">',
      '<failure type="AssertionError" message="the report&apos;s own message">report trace line</failure>',
      "</testcase>",
      '<testcase name="beta throws its own boom" classname="" time="0.0001" file="a.test.ts">',
      '<failure type="AssertionError" />',
      "</testcase>",
      "</testsuite>",
      "</testsuites>",
    ].join("\n");
    const event = await ingest({
      agentId: "bun-console-report-message-wins",
      report,
      raw: LEGIT_CONSECUTIVE.plain,
      stack: "bun",
    });
    expect(leaf(event, "alpha asserts wrongly").failure).toEqual({
      type: "AssertionError",
      message: "the report's own message",
      trace: "report trace line",
    });
    expect(leaf(event, "beta throws its own boom").failure?.message).toBe("beta boom");
  });

  test("a run started under bun whose ingest omits its stack reads the console", async () => {
    const handle = boot();
    const agentId = "bun-console-start-stack";
    const key = await ready(handle, agentId);
    const start = await postJson(handle, "/api/v2/runs/start", {
      projectKey: key,
      agentId,
      stack: "bun",
      tier: "unit",
    });
    expect(start.status).toBe(202);
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId,
      codec: "junit",
      runId: start.body.runId,
      data: BARE_JUNIT_TIMEOUT_RUN,
      raw: TIMEOUT_DETAIL_AFTER_FAIL.plain,
    });
    expect(res.status).toBe(200);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.stack).toBe("bun");
    expect(leaf(event, "mismatched expectation").failure?.message).toBe("expect(received).toBe(expected)");
    expect(leaf(event, "times out unmatched").failure).toEqual({ type: "TimeoutError" });
  });

  test("a bun run whose console arrives in the report's own captured output reads it there", async () => {
    const report = BARE_JUNIT_TIMEOUT_RUN.replace(
      "</testsuites>",
      `<system-err><![CDATA[${TIMEOUT_DETAIL_AFTER_FAIL.plain}]]></system-err>\n</testsuites>`,
    );
    const event = await ingest({ agentId: "bun-console-in-system-err", report, stack: "bun" });
    expect(leaf(event, "mismatched expectation").failure?.message).toBe("expect(received).toBe(expected)");
    expect(leaf(event, "throws with detail").failure?.message).toBe("boom with detail");
    expect(leaf(event, "times out unmatched").failure).toEqual({ type: "TimeoutError" });
  });

  const NOT_BUN: Array<[string, string | undefined]> = [
    ["stack python", "python"],
    ["no stack", undefined],
    ["an unknown stack", "nonesuch"],
  ];
  for (const [label, stack] of NOT_BUN) {
    test(`under ${label} the console is not read: every bare failure stays type-only`, async () => {
      const event = await ingest({
        agentId: `bun-console-not-read-${stack ?? "none"}`,
        report: BARE_JUNIT_TIMEOUT_RUN,
        raw: TIMEOUT_DETAIL_BEFORE_FAIL.plain,
        ...(stack !== undefined ? { stack } : {}),
      });
      expect(leaf(event, "mismatched expectation").failure).toEqual({ type: "AssertionError" });
      expect(leaf(event, "throws with detail").failure).toEqual({ type: "AssertionError" });
      expect(leaf(event, "times out unmatched").failure).toEqual({ type: "TimeoutError" });
      expect(leaf(event, "adds numbers correctly").failure).toBeUndefined();
    });
  }
});
