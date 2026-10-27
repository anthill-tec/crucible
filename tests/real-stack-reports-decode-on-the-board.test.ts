// A real report from each stack's runner, decoded on the board.
//
// `tests/fixtures/reports/<stack>/` holds what each stack's runner wrote on a
// real run with passing, failing and skipped cases (see the README there), and
// beside it `expected.json`: that stack's client parse of the same files,
// frozen by `freeze-client-parse.py` calling the clients' own parsers.
//
// Each fixture is sent to `POST /api/v2/runs` as its client would send it —
// `codec: "junit"`, `data` the report texts in the order the client reads
// them, `coverage: {codec, data}`, bun's console as `raw`, `stack` the stack —
// and read back through the run detail read `GET /api/v2/events/<id>`:
//
//  - figures exact: the stored `total`, `passed`, `failed`, `pending` and every
//    case's status equal the client's; the coverage object equals the client's,
//    percents included (a failing run keeps none, as the clients publish none);
//  - the tree unified: the stored tree is the one JUnit reading for every stack,
//    computed here from the report itself by an independent reader — a node per
//    suite holding cases, empty suites absent, `?` for a missing or empty name,
//    the failure's own text cut as stated, durations rounded — and each
//    fixture's deliberate departure from its client's tree is asserted by name.
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "reports");

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

// ── The fixtures and their frozen client parse ──────────────────────────────

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

interface Failure {
  message?: string;
  type?: string;
  trace?: string;
}

interface Leaf {
  name: string;
  status: string;
  duration_ms: number;
  failure?: Failure;
}

interface Node {
  name: string;
  status: string;
  children: Leaf[];
}

interface Summary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

interface Expected {
  stack: string;
  reports: string[];
  coverage: { codec: string; reports: string[] };
  raw?: string;
  client: { summary: Summary; tree: Node[]; files: number; coverage: CoverageObject };
  clientAutoIngestTree?: Node[];
}

interface Fixture {
  label: string;
  dir: string;
  expected: Expected;
  reports: string[];
  coverage: string[];
  raw?: string;
}

function loadFixture(label: string, dir: string): Fixture {
  const root = join(FIXTURES, dir);
  const expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf-8")) as Expected;
  const read = (rel: string): string => readFileSync(join(root, rel), "utf-8");
  return {
    label,
    dir,
    expected,
    reports: expected.reports.map(read),
    coverage: expected.coverage.reports.map(read),
    ...(expected.raw !== undefined ? { raw: read(expected.raw) } : {}),
  };
}

const FIXTURE_SET: Fixture[] = [
  loadFixture("bun", "bun"),
  loadFixture("python (xmlrunner)", "python/xmlrunner"),
  loadFixture("python (pytest)", "python/pytest"),
  loadFixture("mvn (surefire and failsafe)", "mvn"),
  loadFixture("rust (nextest)", "rust"),
  loadFixture("arduino (native harness)", "arduino"),
];

function fixture(dir: string): Fixture {
  const found = FIXTURE_SET.find((f) => f.dir === dir);
  if (found === undefined) throw new Error(`no fixture ${dir}`);
  return found;
}

// ── Ingesting a fixture ─────────────────────────────────────────────────────

interface StoredEvent {
  id: string;
  summary?: Summary;
  tree?: Node[];
  coverage?: CoverageObject;
  [key: string]: unknown;
}

interface Ingested {
  res: Posted;
  run: Record<string, unknown>;
  event: StoredEvent;
}

async function ingest(agentId: string, body: Record<string, unknown>): Promise<Ingested> {
  const handle = boot();
  const key = await ready(handle, agentId);
  const res = await postJson(handle, "/api/v2/runs", { projectKey: key, agentId, ...body });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const detail = await getJson(handle, `/api/v2/events/${res.body.event as string}`);
  expect(typeof res.body.run).toBe("object");
  return { res, run: res.body.run as Record<string, unknown>, event: detail.event as StoredEvent };
}

/** The fixture sent as its client would send it: reports, coverage, console, stack. */
function ingestFixture(f: Fixture, agentId: string): Promise<Ingested> {
  return ingest(agentId, {
    codec: "junit",
    stack: f.expected.stack,
    data: f.reports,
    coverage: { codec: f.expected.coverage.codec, data: f.coverage },
    ...(f.raw !== undefined ? { raw: f.raw } : {}),
  });
}

/** One passing case — the run a coverage report is kept on. */
const GREEN_REPORT = '<testsuite name="green" tests="1"><testcase name="passes" time="0"/></testsuite>';

const COVERAGE_DROPPED_HINT = "coverage DISCARDED — coverage from a failing run is meaningless";

// ── An independent reading of a JUnit report ────────────────────────────────
// Not the board's parser: a small reader of its own, so the stored tree is
// compared with what the report itself says under the unified rules.

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e] as string;
  });
}

function readXml(xml: string): El {
  const top: El = { name: "#document", attrs: {}, children: [], text: "" };
  const open: El[] = [top];
  const token =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(xml)) !== null) {
    const current = open[open.length - 1]!;
    if (m[1] !== undefined) current.text += m[1];
    else if (m[2] !== undefined) open.pop();
    else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[a[1]!] = unescapeXml(a[2] ?? a[3] ?? "");
      }
      const el: El = { name: m[3], attrs, children: [], text: "" };
      current.children.push(el);
      if (m[5] !== "/") open.push(el);
    } else if (m[6] !== undefined) current.text += unescapeXml(m[6]);
  }
  const root = top.children[0];
  if (root === undefined) throw new Error("no root element");
  return root;
}

const kids = (el: El, name: string): El[] => el.children.filter((c) => c.name === name);

const blankless = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim().length > 0 ? v : undefined;

const named = (el: El): string => blankless(el.attrs.name) ?? "?";

/** Every suite holding testcases directly, at any depth, in document order. */
function holders(suite: El, out: El[] = []): El[] {
  if (kids(suite, "testcase").length > 0) out.push(suite);
  for (const inner of kids(suite, "testsuite")) holders(inner, out);
  return out;
}

function failureOf(el: El): Failure {
  const text = el.text;
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const message = blankless(el.attrs.message) ?? firstLine;
  const type = blankless(el.attrs.type);
  const trace = blankless(text);
  return {
    ...(message !== undefined ? { message: message.slice(0, 1000) } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(trace !== undefined ? { trace: trace.slice(0, 8000) } : {}),
  };
}

function leafOf(tc: El, stack: string): Leaf {
  const bad = tc.children.find((c) => c.name === "failure" || c.name === "error");
  const skipped = kids(tc, "skipped").length > 0;
  const seconds = Number.parseFloat(tc.attrs.time ?? "0");
  const leaf: Leaf = {
    name: named(tc),
    status: bad !== undefined ? "fail" : skipped ? "pending" : "pass",
    duration_ms: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
  };
  if (bad !== undefined) {
    leaf.failure = failureOf(bad);
    if (stack === "bun" && leaf.failure.message === undefined) {
      // This reader does not read bun's console; no fixture needs it to.
      throw new Error(`bare bun failure in the fixture: ${leaf.name}`);
    }
  }
  return leaf;
}

function nodeOf(name: string, cases: El[], stack: string): Node {
  const children = cases.map((tc) => leafOf(tc, stack));
  return { name, status: children.some((c) => c.status === "fail") ? "fail" : "pass", children };
}

/** The unified reading of a run's reports: its tree and its distinct files. */
function unifiedReading(texts: string[], stack: string): { tree: Node[]; files: Set<string> } {
  const tree: Node[] = [];
  const files = new Set<string>();
  for (const text of texts) {
    const root = readXml(text);
    const suites = root.name === "testsuites" ? kids(root, "testsuite") : [root];
    const held = suites.flatMap((s) => holders(s));
    for (const suite of held) {
      for (const tc of kids(suite, "testcase")) {
        const file = blankless(tc.attrs.file) ?? blankless(tc.attrs.classname) ?? named(suite);
        files.add(file.replace(/\\/g, "/"));
      }
    }
    const pytest = stack === "python" && suites.length === 1 && suites[0]!.attrs.name === "pytest";
    if (pytest) {
      const groups = new Map<string, El[]>();
      for (const tc of held.flatMap((s) => kids(s, "testcase"))) {
        const key = blankless(tc.attrs.classname) ?? "pytest";
        groups.set(key, [...(groups.get(key) ?? []), tc]);
      }
      for (const [name, cases] of groups) tree.push(nodeOf(name, cases, stack));
    } else {
      for (const suite of held) tree.push(nodeOf(named(suite), kids(suite, "testcase"), stack));
    }
  }
  return { tree, files };
}

/**
 * A tree in comparable form: suite name, status and leaves; each failure's
 * parts compared by content (surrounding whitespace aside), and only the parts
 * present.
 */
function comparable(tree: Node[]): unknown {
  return tree.map((s) => ({
    name: s.name,
    status: s.status,
    children: s.children.map((c) => ({
      name: c.name,
      status: c.status,
      duration_ms: c.duration_ms,
      ...(c.failure !== undefined
        ? {
            failure: Object.fromEntries(
              Object.entries(c.failure)
                .filter(([k]) => k === "message" || k === "type" || k === "trace")
                .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
            ),
          }
        : {}),
    })),
  }));
}

const leaves = (tree: Node[]): Leaf[] => tree.flatMap((s) => s.children);

function storedLeaf(event: StoredEvent, name: string): Leaf {
  const found = leaves(event.tree ?? []).filter((c) => c.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
}

function clientLeaf(f: Fixture, name: string): Leaf {
  const found = leaves(f.expected.client.tree).filter((c) => c.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
}

// ── Figures exact, tree unified: every fixture ──────────────────────────────

for (const f of FIXTURE_SET) {
  const agent = `real-${f.dir.replace("/", "-")}`;

  describe(`a real ${f.label} report decoded on the board`, () => {
    test(`stores the client's total, passed, failed and pending, in the response and on the run (${f.label})`, async () => {
      const { run, event } = await ingestFixture(f, `${agent}-counts`);
      const want = f.expected.client.summary;
      const counts = (s: Record<string, unknown> | Summary | undefined) => ({
        total: s?.total,
        passed: s?.passed,
        failed: s?.failed,
        pending: s?.pending,
      });
      expect(counts(event.summary)).toEqual(counts(want));
      expect(counts(run)).toEqual(counts(want));
      // Every fixture is a real mixed run: something passed, failed and was skipped.
      expect(want.passed).toBeGreaterThan(0);
      expect(want.failed).toBeGreaterThan(0);
    });

    test(`stores every case with the client's status, case for case, in the client's order (${f.label})`, async () => {
      const { event } = await ingestFixture(f, `${agent}-statuses`);
      const stored = leaves(event.tree ?? []).map((c) => [c.name, c.status]);
      const client = leaves(f.expected.client.tree).map((c) => [c.name, c.status]);
      expect(stored).toEqual(client);
      expect(stored.length).toBe(f.expected.client.summary.total);
    });

    test(`keeps no coverage from the failing run and says so, as the client publishes none (${f.label})`, async () => {
      const { res, run, event } = await ingestFixture(f, `${agent}-cov-red`);
      expect(event.coverage).toBeUndefined();
      expect(run.coverage).toBeUndefined();
      const help = res.body.help as string[];
      expect(help.filter((line) => line === COVERAGE_DROPPED_HINT).length).toBe(1);
      expect(res.body.warnings).toBeUndefined();
    });

    test(`decodes the real ${f.expected.coverage.codec} report to the client's coverage object, percents included (${f.label})`, async () => {
      const { res, run, event } = await ingest(`${agent}-cov-green`, {
        codec: "junit",
        stack: f.expected.stack,
        data: GREEN_REPORT,
        coverage: { codec: f.expected.coverage.codec, data: f.coverage },
      });
      const want = f.expected.client.coverage;
      expect(want.lines.total).toBeGreaterThan(0);
      expect(event.coverage).toEqual(want);
      expect(run.coverage).toEqual(want);
      expect(res.body.warnings).toBeUndefined();
    });

    test(`stores the unified reading of the report as its tree (${f.label})`, async () => {
      const { event } = await ingestFixture(f, `${agent}-tree`);
      const { tree } = unifiedReading(f.reports, f.expected.stack);
      expect(tree.length).toBeGreaterThan(0);
      expect(comparable(event.tree ?? [])).toEqual(comparable(tree));
      // No node without cases, no blank name, no message past its cut.
      for (const suite of event.tree ?? []) {
        expect(suite.children.length).toBeGreaterThan(0);
        expect(suite.name.trim().length).toBeGreaterThan(0);
        for (const c of suite.children) {
          expect(c.name.trim().length).toBeGreaterThan(0);
          expect((c.failure?.message ?? "").length).toBeLessThanOrEqual(1000);
          expect((c.failure?.trace ?? "").length).toBeLessThanOrEqual(8000);
        }
      }
    });

    test(`answers the run's distinct-file count, read across every report (${f.label})`, async () => {
      const { run } = await ingestFixture(f, `${agent}-files`);
      const { files } = unifiedReading(f.reports, f.expected.stack);
      expect(run.files).toBe(files.size);
    });
  });
}

// ── Each fixture's deliberate departure from its client's tree ──────────────

describe("the unified reading departs from each client's tree where the design says", () => {
  test("bun: a case's duration is rounded, not truncated — 'whispers after a busy pause' (0.002768 s) is 3 ms, where the client sent 2", async () => {
    const f = fixture("bun");
    const { event } = await ingestFixture(f, "deliberate-bun-duration");
    expect(storedLeaf(event, "whispers after a busy pause").duration_ms).toBe(3);
    expect(clientLeaf(f, "whispers after a busy pause").duration_ms).toBe(2);
  });

  test("bun: a failure with no message attribute takes the first line of its text — 'throws a plain object' is 'error', type 'Error'", async () => {
    const f = fixture("bun");
    const { event } = await ingestFixture(f, "deliberate-bun-text");
    const failure = storedLeaf(event, "throws a plain object").failure;
    expect(failure?.message).toBe("error");
    expect(failure?.type).toBe("Error");
    expect(failure?.trace?.trim()).toBe("error\n      at tests/math.test.ts:32:12");
  });

  test("python (xmlrunner): a failure keeps its text — 'test_adds_with_a_wrong_expectation' stores '4 != 5', where the client kept no failure", async () => {
    const f = fixture("python/xmlrunner");
    const { event } = await ingestFixture(f, "deliberate-xmlrunner-text");
    const failure = storedLeaf(event, "test_adds_with_a_wrong_expectation").failure;
    expect(failure?.message).toBe("4 != 5");
    expect(failure?.type).toBe("AssertionError");
    expect(failure?.trace).toContain("AssertionError: 4 != 5");
    expect(clientLeaf(f, "test_adds_with_a_wrong_expectation").failure).toBeUndefined();
  });

  test("python (xmlrunner): an <error> is a failure with its own text — 'test_divides_by_zero_and_errors' stores 'division by zero', type ZeroDivisionError", async () => {
    const f = fixture("python/xmlrunner");
    const { event } = await ingestFixture(f, "deliberate-xmlrunner-error");
    const leaf = storedLeaf(event, "test_divides_by_zero_and_errors");
    expect(leaf.status).toBe("fail");
    expect(leaf.failure?.message).toBe("division by zero");
    expect(leaf.failure?.type).toBe("ZeroDivisionError");
  });

  test("python (pytest): the one 'pytest' suite is grouped by classname in first-seen order, where the client's auto-ingest kept one 'pytest' node", async () => {
    const f = fixture("python/pytest");
    const { event } = await ingestFixture(f, "deliberate-pytest-grouping");
    expect((event.tree ?? []).map((s) => s.name)).toEqual([
      "ptests.test_numbers",
      "ptests.test_numbers.TestDivide",
      "ptests.test_text",
      "ptests.test_text.TestShout",
    ]);
    expect((f.expected.clientAutoIngestTree ?? []).map((s) => s.name)).toEqual(["pytest"]);
  });

  test("python (pytest): a failure with no type attribute keeps its message and trace and stores no type", async () => {
    const f = fixture("python/pytest");
    const { event } = await ingestFixture(f, "deliberate-pytest-text");
    const failure = storedLeaf(event, "test_adds_with_a_wrong_expectation").failure;
    expect(failure?.message).toBe("assert 4 == 5\n +  where 4 = add(2, 2)");
    expect(failure?.type).toBeUndefined();
    expect(failure?.trace).toContain("E       assert 4 == 5");
    expect(clientLeaf(f, "test_adds_with_a_wrong_expectation").failure).toBeUndefined();
  });

  test("mvn: a surefire report with no testcases is no node — 'com.acme.core.GeneratedTest' is absent, where the client kept it empty", async () => {
    const f = fixture("mvn");
    const { event } = await ingestFixture(f, "deliberate-mvn-empty");
    const names = (event.tree ?? []).map((s) => s.name);
    expect(names).not.toContain("com.acme.core.GeneratedTest");
    expect(names).toEqual([
      "com.acme.app.GreeterTest",
      "com.acme.core.CalcTest",
      "com.acme.core.ParityTest",
      "com.acme.app.GreeterIT",
    ]);
    const kept = f.expected.client.tree.filter((s) => s.name === "com.acme.core.GeneratedTest");
    expect(kept.length).toBe(1);
    expect(kept[0]!.children.length).toBe(0);
  });

  test("mvn: surefire and failsafe failures keep their text — 'saysFarewellPolitely' and 'dividesByZeroAndErrors', where the client kept none", async () => {
    const f = fixture("mvn");
    const { event } = await ingestFixture(f, "deliberate-mvn-text");
    const it = storedLeaf(event, "saysFarewellPolitely").failure;
    expect(it?.message).toBe("expected: <Goodbye, Ada> but was: <Bye, Ada>");
    expect(it?.type).toBe("org.opentest4j.AssertionFailedError");
    const error = storedLeaf(event, "dividesByZeroAndErrors").failure;
    expect(error?.message).toBe("division by zero");
    expect(error?.type).toBe("java.lang.ArithmeticException");
    expect(error?.trace).toContain("at com.acme.core.Calc.divide(Calc.java:12)");
    expect(clientLeaf(f, "saysFarewellPolitely").failure).toBeUndefined();
    expect(clientLeaf(f, "dividesByZeroAndErrors").failure).toBeUndefined();
  });

  test("rust: a nextest failure keeps its text — 'tests::adds_with_a_wrong_expectation' stores the panic line, where the client kept none", async () => {
    const f = fixture("rust");
    const { event } = await ingestFixture(f, "deliberate-rust-text");
    const failure = storedLeaf(event, "tests::adds_with_a_wrong_expectation").failure;
    expect(failure?.message).toBe(
      "thread 'tests::adds_with_a_wrong_expectation' (626759) panicked at src/lib.rs:35:9",
    );
    expect(failure?.type).toBe("test failure with exit code 101");
    expect(failure?.trace).toContain("assertion `left == right` failed: two and two");
    expect(clientLeaf(f, "tests::adds_with_a_wrong_expectation").failure).toBeUndefined();
  });

  test("arduino: durations are the report's, rounded — 'test_bounces_for_a_while' (0.002700 s) is 3 ms, where the client sent 0", async () => {
    const f = fixture("arduino");
    const { event } = await ingestFixture(f, "deliberate-arduino-duration");
    expect(storedLeaf(event, "test_bounces_for_a_while").duration_ms).toBe(3);
    expect(clientLeaf(f, "test_bounces_for_a_while").duration_ms).toBe(0);
  });

  test("arduino: a source two binaries share is one file across the run — 2 files, where the client summed 3 per report", async () => {
    const f = fixture("arduino");
    const { run } = await ingestFixture(f, "deliberate-arduino-files");
    expect(run.files).toBe(2);
    expect(f.expected.client.files).toBe(3);
  });

  test("arduino: a failure keeps its text — 'test_rejects_a_short_glitch' stores 'Expected 0 Was 1', where the client kept none", async () => {
    const f = fixture("arduino");
    const { event } = await ingestFixture(f, "deliberate-arduino-text");
    const failure = storedLeaf(event, "test_rejects_a_short_glitch").failure;
    expect(failure?.message).toBe("Expected 0 Was 1");
    expect(failure?.type).toBe("assertion");
    expect(failure?.trace).toContain("ASSERT_EQ_INT(0, debounce_update(&d, true, 40))");
    expect(clientLeaf(f, "test_rejects_a_short_glitch").failure).toBeUndefined();
  });
});
