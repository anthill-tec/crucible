// `POST /api/v2/runs` takes a run's whole report set:
//
//  - `data` is one report text or a non-empty list of them, decoded in list
//    order and merged into ONE run (counts summed, tree nodes in list order);
//  - a text that cannot be decoded is skipped and named in the response's
//    `warnings[]` as `{code: "report-skipped", detail}`, the detail naming its
//    list index and the decode error; when no text decodes the run is refused
//    with 400 and nothing is stored; `data: []` is refused with 400;
//  - `dataPath` (a directory of `TEST-*.xml`) is read by the same rules;
//  - `raw` is stored as the run's raw output: the body's `raw`, then each
//    report's `<testsuites>`- and `<testsuite>`-level `<system-out>` /
//    `<system-err>` text in report order (testcase-level output is not
//    collected); each part trimmed, empty parts dropped, joined by "\n";
//  - the run's effective stack (the ingest's, else its start's) is resolved
//    before the codec runs; a run with no stack, or an unknown one, decodes
//    with no stack-specific rule.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store); every stored outcome is read back through the board's own reads —
// the run detail `GET /api/v2/events/<id>` and the events list.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { parseJunit } from "../src/codecs/junit.ts";

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

interface StoredLeaf {
  name: string;
  status: string;
}

interface StoredSuite {
  name: string;
  children: StoredLeaf[];
}

interface StoredEvent {
  id: string;
  stack?: string;
  raw?: string;
  tree?: StoredSuite[];
  [key: string]: unknown;
}

async function storedEvent(handle: ServerHandle, eventId: string): Promise<StoredEvent> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  return body.event as StoredEvent;
}

async function eventIds(handle: ServerHandle, key: string): Promise<string[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return (body.events as { id: string }[]).map((e) => e.id);
}

async function openRunIds(handle: ServerHandle, key: string): Promise<string[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return (body.openRuns as { runId: string }[]).map((r) => r.runId);
}

/** Suite names and, under each, its case names — the stored tree's shape. */
function treeShape(event: StoredEvent): Array<[string, string[]]> {
  return (event.tree ?? []).map((s) => [s.name, s.children.map((c) => c.name)]);
}

function counts(run: unknown): Record<string, unknown> {
  const r = run as Record<string, unknown>;
  return { total: r.total, passed: r.passed, failed: r.failed, pending: r.pending };
}

/** The decode error the junit codec itself raises on a text. */
function decodeError(text: string): string {
  try {
    parseJunit(text);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error("expected the junit codec to refuse this text");
}

interface Warning {
  code: string;
  detail: string;
}

function warningsOf(body: Record<string, unknown>): Warning[] {
  expect(Array.isArray(body.warnings)).toBe(true);
  return body.warnings as Warning[];
}

function reportDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "run-ingest-report-list-"));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** 1 passed, 1 failed. */
const REPORT_ALPHA = [
  '<testsuite name="Alpha" tests="2">',
  '<testcase name="a1" time="0.01"/>',
  '<testcase name="a2" time="0.02"><failure message="boom">trace line</failure></testcase>',
  "</testsuite>",
].join("\n");

/** 1 passed, 1 pending. */
const REPORT_BETA = [
  '<testsuite name="Beta" tests="2">',
  '<testcase name="b1" time="0.01"/>',
  '<testcase name="b2" time="0"><skipped/></testcase>',
  "</testsuite>",
].join("\n");

/** 1 passed, under a `<testsuites>` wrapper. */
const REPORT_GAMMA = [
  "<testsuites>",
  '<testsuite name="Gamma" tests="1">',
  '<testcase name="c1" time="0.01"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

/** An unclosed testcase — the codec refuses it. */
const MALFORMED_UNCLOSED = '<testsuite name="Broken" tests="1">\n<testcase name="x">';
/** A root element that is no JUnit report — the codec refuses it. */
const MALFORMED_ROOT = "<report><item/></report>";

/** Wrapper-level and suite-level output; a whitespace-only suite stream. */
const RAW_REPORT_A = [
  "<testsuites>",
  "<system-out>  wrapper A  </system-out>",
  '<testsuite name="Alpha" tests="1">',
  '<testcase name="a1" time="0.01"/>',
  "<system-out>suite A out</system-out>",
  "<system-err>   </system-err>",
  "</testsuite>",
  "</testsuites>",
].join("\n");

/** Testcase-level output (never collected) and suite-level stderr. */
const RAW_REPORT_B = [
  '<testsuite name="Beta" tests="1">',
  '<testcase name="b1" time="0.01"><system-out>case-level output</system-out></testcase>',
  "<system-err>\n  suite B err\n</system-err>",
  "</testsuite>",
].join("\n");

// ── A list of reports decodes to one run ───────────────────────────────────

describe("POST /api/v2/runs decodes a list of report texts into one run", () => {
  test("three report texts decode to one stored run whose counts are summed and whose suites follow the list order", async () => {
    const handle = boot();
    const key = await ready(handle, "list-three");
    const before = await eventIds(handle, key);

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-three",
      codec: "junit",
      data: [REPORT_ALPHA, REPORT_BETA, REPORT_GAMMA],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(counts(res.body.run)).toEqual({ total: 5, passed: 3, failed: 1, pending: 1 });
    // A list that decoded cleanly warns of nothing.
    expect(res.body.warnings).toBeUndefined();

    // Exactly one run stored, not one per report.
    expect((await eventIds(handle, key)).filter((id) => !before.includes(id))).toEqual([
      res.body.event as string,
    ]);
    expect((await eventIds(handle, key)).length).toBe(before.length + 1);
    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event)).toEqual([
      ["Alpha", ["a1", "a2"]],
      ["Beta", ["b1", "b2"]],
      ["Gamma", ["c1"]],
    ]);
  });

  test("the same reports listed in reverse order are stored with their suites in that reversed order", async () => {
    const handle = boot();
    const key = await ready(handle, "list-reversed");

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-reversed",
      codec: "junit",
      data: [REPORT_GAMMA, REPORT_BETA, REPORT_ALPHA],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 5, passed: 3, failed: 1, pending: 1 });

    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event).map(([name]) => name)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  test("a list of one report text decodes exactly as that text sent alone", async () => {
    const handle = boot();
    const key = await ready(handle, "list-one");

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-one",
      codec: "junit",
      data: [REPORT_BETA],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 2, passed: 1, failed: 0, pending: 1 });
    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event)).toEqual([["Beta", ["b1", "b2"]]]);
  });

  test("a single report text (not a list) still decodes to one run as it always has", async () => {
    const handle = boot();
    const key = await ready(handle, "single-text");

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "single-text",
      codec: "junit",
      data: REPORT_ALPHA,
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 2, passed: 1, failed: 1, pending: 0 });
    expect(res.body.warnings).toBeUndefined();
    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event)).toEqual([["Alpha", ["a1", "a2"]]]);
  });
});

// ── A malformed report is skipped with a warning ───────────────────────────

describe("POST /api/v2/runs skips a malformed report in a list and warns of it", () => {
  test("one malformed text between two good ones is skipped: the run is stored from the rest and one report-skipped warning names index 1 and the decode error", async () => {
    const handle = boot();
    const key = await ready(handle, "list-one-bad");
    const before = await eventIds(handle, key);

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-one-bad",
      codec: "junit",
      data: [REPORT_ALPHA, MALFORMED_UNCLOSED, REPORT_BETA],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The good reports' counts only.
    expect(counts(res.body.run)).toEqual({ total: 4, passed: 2, failed: 1, pending: 1 });

    const warnings = warningsOf(res.body);
    expect(warnings.length).toBe(1);
    const [warning] = warnings;
    expect(Object.keys(warning!).sort()).toEqual(["code", "detail"]);
    expect(warning!.code).toBe("report-skipped");
    expect(warning!.detail).toContain(decodeError(MALFORMED_UNCLOSED));
    expect(warning!.detail).toMatch(/\b1\b/);

    expect((await eventIds(handle, key)).filter((id) => !before.includes(id))).toEqual([
      res.body.event as string,
    ]);
    expect((await eventIds(handle, key)).length).toBe(before.length + 1);
    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event)).toEqual([
      ["Alpha", ["a1", "a2"]],
      ["Beta", ["b1", "b2"]],
    ]);
  });

  test("two malformed texts around a good one give two report-skipped warnings in list order, each naming its own index and its own decode error", async () => {
    const handle = boot();
    const key = await ready(handle, "list-two-bad");

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-two-bad",
      codec: "junit",
      data: [MALFORMED_UNCLOSED, REPORT_GAMMA, MALFORMED_ROOT],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 1, passed: 1, failed: 0, pending: 0 });

    const warnings = warningsOf(res.body);
    expect(warnings.map((w) => w.code)).toEqual(["report-skipped", "report-skipped"]);
    expect(warnings[0]!.detail).toContain(decodeError(MALFORMED_UNCLOSED));
    expect(warnings[0]!.detail).toMatch(/\b0\b/);
    expect(warnings[0]!.detail).not.toContain(decodeError(MALFORMED_ROOT));
    expect(warnings[1]!.detail).toContain(decodeError(MALFORMED_ROOT));
    expect(warnings[1]!.detail).toMatch(/\b2\b/);
    expect(warnings[1]!.detail).not.toContain(decodeError(MALFORMED_UNCLOSED));

    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event)).toEqual([["Gamma", ["c1"]]]);
  });

  test("a list in which no text decodes is refused 400 and stores nothing", async () => {
    const handle = boot();
    const key = await ready(handle, "list-all-bad");
    const before = await eventIds(handle, key);

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-all-bad",
      codec: "junit",
      data: [MALFORMED_UNCLOSED, MALFORMED_ROOT],
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.event).toBeUndefined();
    expect(await eventIds(handle, key)).toEqual(before);
  });

  test("a list in which no text decodes, closing a started run, stores nothing and leaves the run open", async () => {
    const handle = boot();
    const key = await ready(handle, "list-all-bad-close");
    const before = await eventIds(handle, key);
    const start = await postJson(handle, "/api/v2/runs/start", {
      projectKey: key,
      agentId: "list-all-bad-close",
      stack: "bun",
    });
    expect(start.status).toBe(202);
    const runId = start.body.runId as string;

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-all-bad-close",
      codec: "junit",
      runId,
      data: [MALFORMED_ROOT],
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(await eventIds(handle, key)).toEqual(before);
    expect(await openRunIds(handle, key)).toEqual([runId]);
  });

  test("an empty data list is refused 400 and stores nothing", async () => {
    const handle = boot();
    const key = await ready(handle, "list-empty");
    const before = await eventIds(handle, key);

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "list-empty",
      codec: "junit",
      data: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.event).toBeUndefined();
    expect(await eventIds(handle, key)).toEqual(before);
  });
});

// ── dataPath reads by the same rules ───────────────────────────────────────

describe("POST /api/v2/runs reads a dataPath directory by the same list rules", () => {
  test("a directory with one malformed TEST-*.xml among good ones stores the run from the rest and warns report-skipped with the decode error", async () => {
    const handle = boot();
    const key = await ready(handle, "dir-one-bad");
    const dir = reportDir({
      "TEST-a.xml": REPORT_ALPHA,
      "TEST-b.xml": MALFORMED_UNCLOSED,
      "TEST-c.xml": REPORT_BETA,
    });

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "dir-one-bad",
      codec: "junit",
      dataPath: dir,
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 4, passed: 2, failed: 1, pending: 1 });

    const warnings = warningsOf(res.body);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.code).toBe("report-skipped");
    expect(warnings[0]!.detail).toContain(decodeError(MALFORMED_UNCLOSED));
    // The skipped report is named: by its place in the directory's read
    // order (index 1) or by its file.
    expect(warnings[0]!.detail).toMatch(/\b1\b|TEST-b\.xml/);

    const event = await storedEvent(handle, res.body.event as string);
    expect(treeShape(event)).toEqual([
      ["Alpha", ["a1", "a2"]],
      ["Beta", ["b1", "b2"]],
    ]);
  });

  test("a directory whose every TEST-*.xml is malformed is refused 400 and stores nothing", async () => {
    const handle = boot();
    const key = await ready(handle, "dir-all-bad");
    const dir = reportDir({
      "TEST-a.xml": MALFORMED_UNCLOSED,
      "TEST-b.xml": MALFORMED_ROOT,
    });
    const before = await eventIds(handle, key);

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "dir-all-bad",
      codec: "junit",
      dataPath: dir,
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.event).toBeUndefined();
    expect(await eventIds(handle, key)).toEqual(before);
  });

  test("a directory's reports' suite and wrapper output is stored as raw after the body's raw, in the directory's file order", async () => {
    const handle = boot();
    const key = await ready(handle, "dir-raw");
    const dir = reportDir({
      "TEST-a.xml": RAW_REPORT_A,
      "TEST-b.xml": RAW_REPORT_B,
    });

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "dir-raw",
      codec: "junit",
      dataPath: dir,
      raw: "  console says hi \n",
    });
    expect(res.status).toBe(200);
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.raw).toBe("console says hi\nwrapper A\nsuite A out\nsuite B err");
  });
});

// ── raw ─────────────────────────────────────────────────────────────────────

describe("POST /api/v2/runs stores the run's raw output from the body and its reports", () => {
  async function ingestRaw(
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; raw: string | undefined }> {
    const handle = boot();
    const key = await ready(handle, agentId);
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId,
      codec: "junit",
      ...payload,
    });
    expect(res.status).toBe(200);
    const event = await storedEvent(handle, res.body.event as string);
    return { status: res.status, raw: event.raw };
  }

  test("the body's raw comes first, then each report's wrapper- and suite-level output in report order, trimmed, empty parts dropped, testcase output left out", async () => {
    const { raw } = await ingestRaw("raw-full", {
      data: [RAW_REPORT_A, RAW_REPORT_B],
      raw: "\n  runner said hi  \n",
    });
    expect(raw).toBe("runner said hi\nwrapper A\nsuite A out\nsuite B err");
    expect(raw).not.toContain("case-level output");
  });

  test("the reports' output follows the list order, not a fixed one", async () => {
    const { raw } = await ingestRaw("raw-reversed", {
      data: [RAW_REPORT_B, RAW_REPORT_A],
      raw: "runner said hi",
    });
    expect(raw).toBe("runner said hi\nsuite B err\nwrapper A\nsuite A out");
  });

  test("an absent body raw adds no separator: the stored raw starts at the first report's output", async () => {
    const { raw } = await ingestRaw("raw-absent", { data: [RAW_REPORT_A, RAW_REPORT_B] });
    expect(raw).toBe("wrapper A\nsuite A out\nsuite B err");
  });

  test("an empty body raw adds no separator", async () => {
    const { raw } = await ingestRaw("raw-empty", { data: [RAW_REPORT_A, RAW_REPORT_B], raw: "" });
    expect(raw).toBe("wrapper A\nsuite A out\nsuite B err");
  });

  test("a whitespace-only body raw trims to empty and is dropped, adding no separator", async () => {
    const { raw } = await ingestRaw("raw-blank", {
      data: [RAW_REPORT_A, RAW_REPORT_B],
      raw: "  \n\t ",
    });
    expect(raw).toBe("wrapper A\nsuite A out\nsuite B err");
  });

  test("a single report text with a body raw stores the body's raw then the report's suite output", async () => {
    const { raw } = await ingestRaw("raw-single", { data: RAW_REPORT_B, raw: "  before the suite  " });
    expect(raw).toBe("before the suite\nsuite B err");
  });

  test("a body raw with reports that carry no output is stored as the trimmed body raw alone", async () => {
    const { raw } = await ingestRaw("raw-body-only", {
      data: [REPORT_ALPHA, REPORT_BETA],
      raw: "\n$ bun test\n2 pass\n",
    });
    expect(raw).toBe("$ bun test\n2 pass");
  });

  test("no body raw and no report output stores no raw output at all", async () => {
    const { raw } = await ingestRaw("raw-none", { data: [REPORT_ALPHA, REPORT_BETA] });
    expect(raw).toBeUndefined();
  });
});

// ── The effective stack ────────────────────────────────────────────────────

describe("POST /api/v2/runs decodes a report list under the run's effective stack", () => {
  test("a run with no stack decodes its report list with no stack-specific rule and no error", async () => {
    const handle = boot();
    const key = await ready(handle, "stack-none");

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "stack-none",
      codec: "junit",
      data: [REPORT_ALPHA, REPORT_GAMMA],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 3, passed: 2, failed: 1, pending: 0 });
    expect(res.body.warnings).toBeUndefined();
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.stack).toBeUndefined();
    expect(treeShape(event)).toEqual([
      ["Alpha", ["a1", "a2"]],
      ["Gamma", ["c1"]],
    ]);
  });

  test("a run with an unknown stack decodes its report list with no stack-specific rule and no error", async () => {
    const handle = boot();
    const key = await ready(handle, "stack-unknown");

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "stack-unknown",
      codec: "junit",
      stack: "cobol",
      data: [REPORT_ALPHA, REPORT_GAMMA],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 3, passed: 2, failed: 1, pending: 0 });
    expect(res.body.warnings).toBeUndefined();
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.stack).toBe("cobol");
    expect(treeShape(event)).toEqual([
      ["Alpha", ["a1", "a2"]],
      ["Gamma", ["c1"]],
    ]);
  });

  test("an ingest that omits its stack, closing a run started with one, decodes its report list under the start's stack and closes the run", async () => {
    const handle = boot();
    const key = await ready(handle, "stack-from-start");
    const start = await postJson(handle, "/api/v2/runs/start", {
      projectKey: key,
      agentId: "stack-from-start",
      stack: "bun",
      tier: "unit",
    });
    expect(start.status).toBe(202);
    const runId = start.body.runId as string;

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "stack-from-start",
      codec: "junit",
      runId,
      data: [REPORT_BETA, REPORT_GAMMA],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body.run)).toEqual({ total: 3, passed: 2, failed: 0, pending: 1 });
    const event = await storedEvent(handle, res.body.event as string);
    expect(event.stack).toBe("bun");
    expect(treeShape(event)).toEqual([
      ["Beta", ["b1", "b2"]],
      ["Gamma", ["c1"]],
    ]);
    expect(await openRunIds(handle, key)).toEqual([]);
  });
});
