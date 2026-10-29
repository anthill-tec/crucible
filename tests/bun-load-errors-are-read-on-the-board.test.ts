// bun's files that failed to load, read on the board — through the ingest route.
//
// bun counts a test file it could not load — one importing a missing module,
// one throwing at import, one rejecting at import or after its tests — on its
// console, under a `<path>:` header followed by one or more `# Unhandled error
// between tests` blocks; its JUnit report holds only the cases that ran. When
// a run's stack is `bun`, the board reads that console (the run's `raw`), in
// both wire forms, and stores one failing case per such file, by the rules the
// bun client applied before the board took that reading over:
//
//  - in the suite for that file when the report has one, else a new suite
//    named by the path, appended after the decoded suites;
//  - case `?`, status `fail`, message = the first block's `error:` line
//    without its label (`unhandled error between tests` when no block has
//    one), trace = every block for that file, joined; message cut at 1000
//    characters, trace at 8000; nothing stored escaped;
//  - a block printed before any file header is attributed to no file; a
//    flush-left line is a header only when it is a `<path>:` naming a JS/TS
//    module (a test's own `results:` console line never is);
//  - the stored `summary` and the response's `run` count the added cases, and
//    the response's `files` counts each file the reading added (an existing
//    suite's path adds none);
//  - the reading runs before the board's runner rule, so a `runnerExit` of 1
//    over a passing-only report plus a failed-to-load file stores the
//    load-error case and no `runner / exit 1` case beside it.
//
// Under any other stack — or none — the console is not read.
//
// Each case is driven through the real production HTTP surface (`startServer`,
// in-memory store): the JUnit bun wrote is posted to `POST /api/v2/runs` with
// the console text in `raw`, and the stored run is read back through
// `GET /api/v2/events/<id>`. The captures are REAL bun 1.4.2 runs over the
// scratch files the python client tests drive live, frozen in
// tests/fixtures/bun-load-error-captures.ts beside the client's own reading
// of each (CLIENT_LOAD_ERROR_READING), the oracle every stored case must equal.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { parseJunit } from "../src/codecs/junit.ts";
import type { RunSummary, SuiteNode, TestLeaf } from "../src/types.ts";
import {
  CLIENT_LOAD_ERROR_READING,
  CONSOLE_LINE,
  FOUR_FILES,
  LOAD_ERROR_WIRES,
  RAN_THEN_REJECTED,
  TWO_BLOCKS,
} from "./fixtures/bun-load-error-captures.ts";
import type { LoadErrorRun } from "./fixtures/bun-load-error-captures.ts";
import type { WireForm } from "./fixtures/bun-console-captures.ts";

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

interface StoredEvent {
  id: string;
  stack?: string;
  summary?: RunSummary;
  tree?: SuiteNode[];
}

async function storedEvent(handle: ServerHandle, eventId: string): Promise<StoredEvent> {
  const res = await fetch(`${base(handle)}/api/v2/events/${eventId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { event: StoredEvent }).event;
}

/** The response's `run` block: the five counts the client envelopes read. */
interface RunBlock {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  files: number;
}

function runBlock(body: Record<string, unknown>): RunBlock {
  expect(typeof body.run).toBe("object");
  return body.run as RunBlock;
}

interface Ingested {
  res: Posted;
  run: RunBlock;
  event: StoredEvent;
}

/** Ingest one junit report with `raw` through the route and read the stored run back. */
async function ingest(opts: {
  agentId: string;
  report: string;
  raw?: string;
  stack?: string;
  runnerExit?: number;
}): Promise<Ingested> {
  const handle = boot();
  const key = await ready(handle, opts.agentId);
  const res = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId: opts.agentId,
    codec: "junit",
    data: opts.report,
    ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
    ...(opts.stack !== undefined ? { stack: opts.stack } : {}),
    ...(opts.runnerExit !== undefined ? { runnerExit: opts.runnerExit } : {}),
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return { res, run: runBlock(res.body), event: await storedEvent(handle, res.body.event as string) };
}

function suiteNames(event: StoredEvent): string[] {
  return (event.tree ?? []).map((suite) => suite.name);
}

/** The one suite of that name — exactly one, never two. */
function suite(event: StoredEvent, name: string): SuiteNode {
  const found = (event.tree ?? []).filter((s) => s.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
}

function namesAndStatuses(s: SuiteNode): Array<[string, string]> {
  return s.children.map((c) => [c.name, c.status]);
}

/** The one `?` case of a file's suite, checked for the shape every load-error case has. */
function loadErrorCase(event: StoredEvent, file: string): TestLeaf {
  const s = suite(event, file);
  expect(s.status).toBe("fail");
  const cases = s.children.filter((c) => c.name === "?");
  expect(cases.length).toBe(1);
  const c = cases[0]!;
  expect(c.status).toBe("fail");
  expect(c.duration_ms).toBe(0);
  expect(c.failure).toBeDefined();
  expect(c.failure?.message ?? "").not.toContain("\u001b");
  expect(c.failure?.trace ?? "").not.toContain("\u001b");
  return c;
}

function expectCounts(counts: RunSummary | RunBlock | undefined, total: number, passed: number, failed: number): void {
  expect(counts).toBeDefined();
  expect([counts!.total, counts!.passed, counts!.failed, counts!.pending]).toEqual([total, passed, failed, 0]);
}

function expectNoRunnerSuite(event: StoredEvent): void {
  expect(suiteNames(event).filter((n) => n === "runner")).toEqual([]);
}

/** The client's reading of a capture: `{path: {message, trace}}`, in the order bun named the files. */
function oracle(name: string, wire: WireForm): Record<string, { message: string; trace?: string }> {
  const reading = CLIENT_LOAD_ERROR_READING[`${name}/${wire}`];
  expect(reading).toBeDefined();
  return reading!;
}

// ── The real runs, capture for capture ──────────────────────────────────────

describe("a bun run's files that failed to load are stored as one failing case each, as the bun client filed them", () => {
  for (const wire of LOAD_ERROR_WIRES) {
    test(`a missing import, a throw at import and a rejection at import each store a ? case in a new suite named by the path, after the decoded suite (${wire})`, async () => {
      const { run, event } = await ingest({
        agentId: `bun-load-four-${wire}`,
        report: FOUR_FILES.junit,
        raw: FOUR_FILES[wire],
        stack: "bun",
      });
      const expected = oracle("FOUR_FILES", wire);
      expect(Object.keys(expected)).toEqual([
        "b_imports_a_missing_module.test.ts",
        "c_throws_at_import.test.ts",
        "d_rejects_at_import.test.ts",
      ]);
      // The decoded suite first, untouched; then one suite per unloaded file, in bun's order.
      expect(suiteNames(event)).toEqual(["a_passes.test.ts", ...Object.keys(expected)]);
      expect(namesAndStatuses(suite(event, "a_passes.test.ts"))).toEqual([["passes", "pass"]]);
      expect(suite(event, "a_passes.test.ts").status).toBe("pass");
      for (const [file, failure] of Object.entries(expected)) {
        const c = loadErrorCase(event, file);
        expect(c.failure).toEqual(failure);
        expect(suite(event, file).children.length).toBe(1);
      }
      // The messages are bun's error text without its `error:` label.
      expect(loadErrorCase(event, "b_imports_a_missing_module.test.ts").failure?.message).toBe(
        "Cannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'",
      );
      expect(loadErrorCase(event, "c_throws_at_import.test.ts").failure?.message).toBe("boom at import");
      expect(loadErrorCase(event, "d_rejects_at_import.test.ts").failure?.message).toBe("rejected at import");
      // A file's trace holds only its own block.
      expect(loadErrorCase(event, "c_throws_at_import.test.ts").failure?.trace).not.toContain("rejected at import");
      expect(loadErrorCase(event, "d_rejects_at_import.test.ts").failure?.trace).not.toContain("boom at import");
      // Nothing is stored escaped, whichever wire form came in.
      expect(JSON.stringify(event.tree)).not.toContain("\\u001b");

      // The recount: the stored summary and the answered run count the three cases;
      // files counts the report's one file plus the three the reading added.
      expectCounts(event.summary, 4, 1, 3);
      expectCounts(run, 4, 1, 3);
      expect(run.files).toBe(4);
      expectNoRunnerSuite(event);
    });

    test(`a file with two error blocks stores ONE case: the first block's error line as message, both blocks in its trace (${wire})`, async () => {
      const { run, event } = await ingest({
        agentId: `bun-load-two-blocks-${wire}`,
        report: TWO_BLOCKS.junit,
        raw: TWO_BLOCKS[wire],
        stack: "bun",
      });
      expect(suiteNames(event)).toEqual(["a_passes.test.ts", "e_two_error_blocks.test.ts"]);
      const s = suite(event, "e_two_error_blocks.test.ts");
      expect(s.children.length).toBe(1);
      const c = loadErrorCase(event, "e_two_error_blocks.test.ts");
      expect(c.failure).toEqual(oracle("TWO_BLOCKS", wire)["e_two_error_blocks.test.ts"]!);
      expect(c.failure?.message).toBe("first block");
      expect(c.failure?.trace).toContain("error: first block");
      expect(c.failure?.trace).toContain("error: second block");
      expect(c.failure?.trace?.indexOf("first block")).toBeLessThan(c.failure!.trace!.indexOf("second block"));
      expectCounts(event.summary, 2, 1, 1);
      expectCounts(run, 2, 1, 1);
      expect(run.files).toBe(2);
      expectNoRunnerSuite(event);
    });

    test(`a file whose test ran and then rejected gets its ? case in its EXISTING suite, beside the case that ran; files does not grow (${wire})`, async () => {
      const { run, event } = await ingest({
        agentId: `bun-load-ran-then-rejected-${wire}`,
        report: RAN_THEN_REJECTED.junit,
        raw: RAN_THEN_REJECTED[wire],
        stack: "bun",
      });
      // No second suite is made for the file the report already names.
      expect(suiteNames(event)).toEqual(["a_passes.test.ts", "f_ran_then_rejected.test.ts"]);
      const s = suite(event, "f_ran_then_rejected.test.ts");
      expect(namesAndStatuses(s)).toEqual([
        ["ran first", "pass"],
        ["?", "fail"],
      ]);
      expect(s.status).toBe("fail");
      const c = loadErrorCase(event, "f_ran_then_rejected.test.ts");
      expect(c.failure).toEqual(oracle("RAN_THEN_REJECTED", wire)["f_ran_then_rejected.test.ts"]!);
      expect(c.failure?.message).toBe("rejected after its test ran");
      expectCounts(event.summary, 3, 2, 1);
      expectCounts(run, 3, 2, 1);
      // The report named two files; the reading added no new one.
      expect(run.files).toBe(2);
      expectNoRunnerSuite(event);
    });

    test(`a test's own flush-left results: line is not a file header: no suite named results, each file keeps its own load error (${wire})`, async () => {
      // Fixture guard: the tests' own flush-left console line reached bun's console.
      expect(CONSOLE_LINE[wire].replace(/\u001b\[[0-9;]*m/g, "").split("\n")).toContain("results:");
      const { run, event } = await ingest({
        agentId: `bun-load-console-line-${wire}`,
        report: CONSOLE_LINE.junit,
        raw: CONSOLE_LINE[wire],
        stack: "bun",
      });
      expect(suiteNames(event)).toEqual([
        "a_passes.test.ts",
        "g_logs_then_rejected.test.ts",
        "h_logs_then_throws_at_import.test.ts",
      ]);
      expect(suiteNames(event)).not.toContain("results");
      expect(suiteNames(event)).not.toContain("results:");

      const g = suite(event, "g_logs_then_rejected.test.ts");
      expect(namesAndStatuses(g)).toEqual([
        ["logs then passes", "pass"],
        ["?", "fail"],
      ]);
      const expected = oracle("CONSOLE_LINE", wire);
      expect(loadErrorCase(event, "g_logs_then_rejected.test.ts").failure).toEqual(
        expected["g_logs_then_rejected.test.ts"]!,
      );
      expect(loadErrorCase(event, "g_logs_then_rejected.test.ts").failure?.message).toBe("rejected after the log");

      const h = loadErrorCase(event, "h_logs_then_throws_at_import.test.ts");
      expect(h.failure).toEqual(expected["h_logs_then_throws_at_import.test.ts"]!);
      expect(h.failure?.message).toBe("boom after a console line");
      expect(h.failure?.trace).not.toContain("rejected after the log");
      expect(suite(event, "h_logs_then_throws_at_import.test.ts").children.length).toBe(1);

      expectCounts(event.summary, 4, 2, 2);
      expectCounts(run, 4, 2, 2);
      // Two files in the report, one new file from the reading.
      expect(run.files).toBe(3);
      expectNoRunnerSuite(event);
    });
  }
});

// ── Before the runner rule ──────────────────────────────────────────────────

describe("the load-error reading runs before the board's runner rule", () => {
  for (const wire of LOAD_ERROR_WIRES) {
    test(`runnerExit 1 over a passing-only report whose console names unloaded files stores their cases and NO runner / exit 1 case (${wire})`, async () => {
      const { res, run, event } = await ingest({
        agentId: `bun-load-runner-exit-${wire}`,
        report: FOUR_FILES.junit,
        raw: FOUR_FILES[wire],
        stack: "bun",
        runnerExit: 1,
      });
      expectNoRunnerSuite(event);
      expect(suiteNames(event)).toEqual([
        "a_passes.test.ts",
        "b_imports_a_missing_module.test.ts",
        "c_throws_at_import.test.ts",
        "d_rejects_at_import.test.ts",
      ]);
      // Exactly the three load-error cases: no fourth failure from the runner rule.
      expectCounts(event.summary, 4, 1, 3);
      expectCounts(run, 4, 1, 3);
      expect(run.files).toBe(4);
      expect(res.body.verdict).toBe("RED — 3 failing of 4");
      expect(JSON.stringify(event.tree)).not.toContain("the runner exited 1");
    });
  }

  test("the same console with a file the report already names: runnerExit 1 stores that file's ? case and no runner case", async () => {
    const { run, event } = await ingest({
      agentId: "bun-load-runner-exit-existing-suite",
      report: RAN_THEN_REJECTED.junit,
      raw: RAN_THEN_REJECTED.plain,
      stack: "bun",
      runnerExit: 1,
    });
    expectNoRunnerSuite(event);
    expect(suiteNames(event)).toEqual(["a_passes.test.ts", "f_ran_then_rejected.test.ts"]);
    expectCounts(event.summary, 3, 2, 1);
    expectCounts(run, 3, 2, 1);
    expect(run.files).toBe(2);
  });
});

// ── Shapes the real runs do not show, in both wire forms ────────────────────

/** The `<header>:` line of a file in a capture, and the text that follows it up to the next header. */
function fileBlock(capture: LoadErrorRun, wire: WireForm, file: string, nextFile: string): string {
  const text = capture[wire];
  const start = text.indexOf(`\n${file}:\n`);
  const end = text.indexOf(`\n${nextFile}:\n`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + `\n${file}:\n`.length, end);
}

/** The first line of a capture (bun's banner) plus a blank line. */
function banner(capture: LoadErrorRun, wire: WireForm): string {
  return `${capture[wire].split("\n")[0]}\n\n`;
}

/** bun's `# Unhandled error between tests` marker and its rule, in each wire form (copied from the real ANSI capture). */
const MARKER: Record<WireForm, string> = {
  plain: "# Unhandled error between tests",
  ansi: "\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m",
};
const RULE: Record<WireForm, string> = {
  plain: "-------------------------------",
  ansi: "\u001b[2m-------------------------------\u001b[0m",
};
const ERROR_LABEL: Record<WireForm, string> = {
  plain: "error: ",
  ansi: "\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1m",
};

function block(wire: WireForm, lines: string[]): string {
  return [MARKER[wire], RULE[wire], ...lines, RULE[wire], "", ""].join("\n");
}

function errorLine(wire: WireForm, text: string): string {
  return wire === "ansi" ? `${ERROR_LABEL.ansi}${text}\u001b[0m` : `${ERROR_LABEL.plain}${text}`;
}

/** 1 passed in one file. */
const ONE_PASSING_REPORT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites name="bun test" tests="1" failures="0" skipped="0">',
  '<testsuite name="a_passes.test.ts" file="a_passes.test.ts" tests="1" failures="0" skipped="0">',
  '<testcase name="passes" classname="" time="0.00002" file="a_passes.test.ts" />',
  "</testsuite>",
  "</testsuites>",
].join("\n");

describe("the shapes the reading covers beyond the real runs", () => {
  for (const wire of LOAD_ERROR_WIRES) {
    test(`a block printed before any file header is attributed to no file: only the file under a header gets a case (${wire})`, async () => {
      // The real throw-at-import block, once before any header and once under its header.
      const throwBlock = fileBlock(FOUR_FILES, wire, "c_throws_at_import.test.ts", "d_rejects_at_import.test.ts");
      const raw = `${banner(FOUR_FILES, wire)}${throwBlock}\nc_throws_at_import.test.ts:\n${throwBlock}`;
      const { run, event } = await ingest({
        agentId: `bun-load-orphan-block-${wire}`,
        report: ONE_PASSING_REPORT,
        raw,
        stack: "bun",
      });
      expect(suiteNames(event)).toEqual(["a_passes.test.ts", "c_throws_at_import.test.ts"]);
      const c = loadErrorCase(event, "c_throws_at_import.test.ts");
      expect(c.failure?.message).toBe("boom at import");
      // The orphan block is not folded into the file's trace either: one block, one `error:` line.
      expect(c.failure?.trace?.split("error: boom at import").length).toBe(2);
      expect(suite(event, "c_throws_at_import.test.ts").children.length).toBe(1);
      expectCounts(event.summary, 2, 1, 1);
      expectCounts(run, 2, 1, 1);
      expect(run.files).toBe(2);
    });

    test(`a block with no error: line stores the fallback message "unhandled error between tests" and the block as trace (${wire})`, async () => {
      const raw =
        `${banner(FOUR_FILES, wire)}x_no_error_line.test.ts:\n\n` +
        block(wire, ["1 | something went wrong", "              ^", "      at /tmp/bun-fixture/x_no_error_line.test.ts:1:1"]);
      const { run, event } = await ingest({
        agentId: `bun-load-no-error-line-${wire}`,
        report: ONE_PASSING_REPORT,
        raw,
        stack: "bun",
      });
      const c = loadErrorCase(event, "x_no_error_line.test.ts");
      expect(c.failure).toEqual({
        message: "unhandled error between tests",
        trace: "1 | something went wrong\n              ^\n      at /tmp/bun-fixture/x_no_error_line.test.ts:1:1",
      });
      expectCounts(event.summary, 2, 1, 1);
      expectCounts(run, 2, 1, 1);
      expect(run.files).toBe(2);
    });

    test(`a long error line and a long block are stored cut: message at exactly 1000 characters, trace at 8000 (${wire})`, async () => {
      const long = "M".repeat(1500);
      const filler = Array.from({ length: 200 }, (_, i) => `      at frame${i} (/tmp/bun-fixture/y_long.test.ts:${i}:1)`);
      const raw = `${banner(FOUR_FILES, wire)}y_long.test.ts:\n\n${block(wire, [errorLine(wire, long), ...filler])}`;
      const { event } = await ingest({
        agentId: `bun-load-long-${wire}`,
        report: ONE_PASSING_REPORT,
        raw,
        stack: "bun",
      });
      const c = loadErrorCase(event, "y_long.test.ts");
      expect(c.failure?.message).toBe("M".repeat(1000));
      expect(c.failure?.trace?.length).toBe(8000);
      expect(c.failure?.trace?.startsWith(`error: ${long}\n      at frame0`)).toBe(true);
    });

    test(`every JS/TS module extension is a file header; a flush-left line ending in another word or extension is not (${wire})`, async () => {
      const modules = ["m1.js", "m2.mjs", "m3.cjs", "m4.ts", "m5.mts", "m6.cts", "m7.jsx", "m8.tsx"];
      const notHeaders = ["results:", "notes.md:", "data.json:", "Ran 1 test across 1 file:"];
      let raw = banner(FOUR_FILES, wire);
      for (const m of modules) {
        raw += `${m}:\n\n${block(wire, [errorLine(wire, `boom in ${m}`)])}`;
      }
      // Under the last module's header, each non-header line then its own block:
      // the block belongs to m8.tsx, never to a suite named by the line.
      for (const line of notHeaders) {
        raw += `${line}\n\n${block(wire, [errorLine(wire, `boom under ${line}`)])}`;
      }
      const { run, event } = await ingest({
        agentId: `bun-load-headers-${wire}`,
        report: ONE_PASSING_REPORT,
        raw,
        stack: "bun",
      });
      expect(suiteNames(event)).toEqual(["a_passes.test.ts", ...modules]);
      for (const m of modules.slice(0, -1)) {
        const c = loadErrorCase(event, m);
        expect(c.failure?.message).toBe(`boom in ${m}`);
        expect(c.failure?.trace).toBe(`error: boom in ${m}`);
      }
      const last = loadErrorCase(event, "m8.tsx");
      expect(last.failure?.message).toBe("boom in m8.tsx");
      // The four blocks under non-header lines joined m8.tsx's trace, in order.
      expect(last.failure?.trace).toBe(
        [
          "error: boom in m8.tsx",
          ...notHeaders.map((line) => `error: boom under ${line}`),
        ].join("\n\n"),
      );
      expectCounts(event.summary, 9, 1, 8);
      expectCounts(run, 9, 1, 8);
      expect(run.files).toBe(9);
    });
  }
});

// ── Which runs read the console ─────────────────────────────────────────────

describe("only a bun run reads its console for files that failed to load", () => {
  test("a run started under bun whose ingest omits its stack reads the console", async () => {
    const handle = boot();
    const agentId = "bun-load-start-stack";
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
      data: TWO_BLOCKS.junit,
      raw: TWO_BLOCKS.plain,
    });
    expect(res.status).toBe(200);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.stack).toBe("bun");
    expect(suiteNames(event)).toEqual(["a_passes.test.ts", "e_two_error_blocks.test.ts"]);
    expect(loadErrorCase(event, "e_two_error_blocks.test.ts").failure?.message).toBe("first block");
    expectCounts(event.summary, 2, 1, 1);
    expectCounts(runBlock(res.body), 2, 1, 1);
    expect(runBlock(res.body).files).toBe(2);
  });

  test("a bun run whose console arrives in the report's own captured output reads it there", async () => {
    const report = TWO_BLOCKS.junit.replace(
      "</testsuites>",
      `<system-err><![CDATA[${TWO_BLOCKS.plain}]]></system-err>\n</testsuites>`,
    );
    const { run, event } = await ingest({ agentId: "bun-load-in-system-err", report, stack: "bun" });
    expect(suiteNames(event)).toEqual(["a_passes.test.ts", "e_two_error_blocks.test.ts"]);
    expect(loadErrorCase(event, "e_two_error_blocks.test.ts").failure?.message).toBe("first block");
    expectCounts(event.summary, 2, 1, 1);
    expectCounts(run, 2, 1, 1);
    expect(run.files).toBe(2);
  });

  const NOT_BUN: Array<[string, string | undefined]> = [
    ["stack python", "python"],
    ["no stack", undefined],
    ["an unknown stack", "nonesuch"],
  ];
  for (const [label, stack] of NOT_BUN) {
    test(`under ${label} the same console adds nothing: the stored run is the decoded report alone`, async () => {
      const { run, event } = await ingest({
        agentId: `bun-load-not-read-${stack ?? "none"}`,
        report: FOUR_FILES.junit,
        raw: FOUR_FILES.plain,
        ...(stack !== undefined ? { stack } : {}),
      });
      expect(event.tree).toEqual(parseJunit(FOUR_FILES.junit, stack).tree);
      expect(suiteNames(event)).toEqual(["a_passes.test.ts"]);
      expectCounts(event.summary, 1, 1, 0);
      expectCounts(run, 1, 1, 0);
      expect(run.files).toBe(1);
    });

    test(`under ${label} with runnerExit 1 the runner rule still fires: the runner / exit 1 case, not a load-error case`, async () => {
      const { run, event } = await ingest({
        agentId: `bun-load-not-read-exit-${stack ?? "none"}`,
        report: FOUR_FILES.junit,
        raw: FOUR_FILES.plain,
        runnerExit: 1,
        ...(stack !== undefined ? { stack } : {}),
      });
      expect(suiteNames(event)).toEqual(["a_passes.test.ts", "runner"]);
      expect(namesAndStatuses(suite(event, "runner"))).toEqual([["exit 1", "fail"]]);
      expectCounts(event.summary, 2, 1, 1);
      expectCounts(run, 2, 1, 1);
      expect(run.files).toBe(1);
    });
  }
});
