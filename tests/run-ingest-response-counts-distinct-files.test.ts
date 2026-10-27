// The `POST /api/v2/runs` response's `run` block says what a client's
// envelope needs: `passed`, `failed`, `pending`, `total` and `files`.
//
// `files` is the run's count of distinct files: a case's non-empty `file`,
// else its non-empty `classname`, else its suite's name, with `\` read as
// `/`, counted once across the whole run (every report of it). It is
// computed per response and never stored. A `playwright` run's `files` is its
// count of distinct spec files.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store); what is stored is read back through the run detail read
// `GET /api/v2/events/<id>` and the events list.
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

/** The five counts a client's envelope reports, off the response's `run` block. */
function envelopeCounts(run: unknown): Record<string, unknown> {
  const r = run as Record<string, unknown>;
  return { passed: r.passed, failed: r.failed, pending: r.pending, total: r.total, files: r.files };
}

async function ingest(
  agentId: string,
  payload: Record<string, unknown>,
): Promise<{ handle: ServerHandle; key: string; res: Posted }> {
  const handle = boot();
  const key = await ready(handle, agentId);
  const res = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId,
    codec: "junit",
    ...payload,
  });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return { handle, key, res };
}

function reportDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "run-ingest-files-"));
  tmpDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function suite(name: string, cases: string[]): string {
  return [`<testsuite name="${name}" tests="${cases.length}">`, ...cases, "</testsuite>"].join("\n");
}

function wrap(...suites: string[]): string {
  return ["<testsuites>", ...suites, "</testsuites>"].join("\n");
}

// ── The run block's counts ───────────────────────────────────────────────────

describe("the /api/v2/runs response's run block carries the five envelope counts", () => {
  test("passed, failed, pending, total and files are each answered with their exact value", async () => {
    const report = wrap(
      suite("Mixed", [
        '<testcase name="p1" file="src/mixed.test.ts" time="0.01"/>',
        '<testcase name="f1" file="src/mixed.test.ts" time="0.01"><failure message="no"/></testcase>',
        '<testcase name="s1" file="src/other.test.ts" time="0"><skipped/></testcase>',
        '<testcase name="p2" file="src/other.test.ts" time="0.01"/>',
      ]),
    );
    const { res } = await ingest("counts-five", { data: report });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 2, failed: 1, pending: 1, total: 4, files: 2 });
  });
});

// ── files: the distinct-file chain ───────────────────────────────────────────

describe("the run block's files counts each case's file, else classname, else suite name, once", () => {
  test("cases carrying a file are counted by it, not by their classname or their suite", async () => {
    // By file: 1. By classname it would be 3, by suite 2.
    const report = wrap(
      suite("S1", [
        '<testcase name="a" classname="A" file="src/one.test.ts" time="0.01"/>',
        '<testcase name="b" classname="B" file="src/one.test.ts" time="0.01"/>',
      ]),
      suite("S2", ['<testcase name="c" classname="C" file="src/one.test.ts" time="0.01"/>']),
    );
    const { res } = await ingest("files-by-file", { data: report });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 3, failed: 0, pending: 0, total: 3, files: 1 });
  });

  test("cases carrying only a classname are counted by it, not by their suite", async () => {
    // By classname: 2. By suite it would be 1.
    const report = suite("OnlySuite", [
      '<testcase name="a1" classname="pkg.A" time="0.01"/>',
      '<testcase name="b1" classname="pkg.B" time="0.01"/>',
      '<testcase name="a2" classname="pkg.A" time="0.01"/>',
    ]);
    const { res } = await ingest("files-by-classname", { data: report });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 3, failed: 0, pending: 0, total: 3, files: 2 });
  });

  test("a case with an empty classname, or with neither file nor classname, is counted by its suite's name; an empty file falls to the classname", async () => {
    const report = wrap(
      suite("S1", [
        '<testcase name="e1" classname="" time="0.01"/>',
        '<testcase name="n1" time="0.01"/>',
      ]),
      suite("S2", [
        '<testcase name="e2" classname="" file="" time="0.01"/>',
        '<testcase name="c1" classname="pkg.C" file="" time="0.01"/>',
      ]),
    );
    // S1, S2 and pkg.C.
    const { res } = await ingest("files-by-suite", { data: report });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 4, failed: 0, pending: 0, total: 4, files: 3 });
  });

  test("a backslash in a file or classname is read as a slash, so the two spellings count once", async () => {
    const report = suite("Win", [
      '<testcase name="w1" file="src\\win\\a.test.ts" time="0.01"/>',
      '<testcase name="w2" file="src/win/a.test.ts" time="0.01"/>',
      '<testcase name="w3" classname="pkg\\B" time="0.01"/>',
      '<testcase name="w4" classname="pkg/B" time="0.01"/>',
    ]);
    const { res } = await ingest("files-backslash", { data: report });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 4, failed: 0, pending: 0, total: 4, files: 2 });
  });

  test("two reports sharing a file count it once across the run, and nothing named files is stored", async () => {
    const first = suite("First", [
      '<testcase name="x1" file="src/shared.test.ts" time="0.01"/>',
      '<testcase name="x2" file="src/first.test.ts" time="0.01"/>',
    ]);
    const second = suite("Second", [
      '<testcase name="y1" file="src/shared.test.ts" time="0.01"/>',
      '<testcase name="y2" file="src/second.test.ts" time="0.01"/>',
    ]);
    // Distinct across the run: 3. Summed per report it would be 4.
    const { handle, key, res } = await ingest("files-across-reports", { data: [first, second] });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 4, failed: 0, pending: 0, total: 4, files: 3 });

    const detail = await getJson(handle, `/api/v2/events/${res.body.event as string}`);
    expect(JSON.stringify(detail)).not.toContain('"files"');
    const list = await getJson(handle, `/api/v2/events?project=${key}`);
    expect(JSON.stringify(list)).not.toContain('"files"');
  });

  test("a dataPath directory's reports sharing a file count it once across the run", async () => {
    const dir = reportDir({
      "TEST-a.xml": suite("A", [
        '<testcase name="a1" file="src/shared.test.ts" time="0.01"/>',
        '<testcase name="a2" file="src/a.test.ts" time="0.01"/>',
      ]),
      "TEST-b.xml": suite("B", [
        '<testcase name="b1" file="src/shared.test.ts" time="0.01"/>',
        '<testcase name="b2" classname="pkg.B" time="0.01"/>',
      ]),
    });
    const { res } = await ingest("files-datapath", { dataPath: dir });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 4, failed: 0, pending: 0, total: 4, files: 3 });
  });
});

// ── A playwright run ─────────────────────────────────────────────────────────

/** One playwright test entry (one project) whose last attempt ran `steps`. */
function pwTest(projectName: string, status: string, steps: unknown[]): Record<string, unknown> {
  return {
    projectName,
    projectId: projectName,
    results: [{ status, duration: 5, retry: 0, steps }],
    status: status === "passed" ? "expected" : "unexpected",
  };
}

const PASS_STEP = { title: "Given a thing", duration: 2 };
const FAIL_STEP = { title: "When it breaks", duration: 1, error: { message: "Error: boom", stack: "Error: boom\n    at breaks (steps.js)" } };

/** Two spec files: the first holds two scenarios (one under two projects), the second one. */
const PLAYWRIGHT_REPORT = JSON.stringify({
  config: { version: "1.61.1" },
  suites: [
    {
      title: "tests/e2e/features/login.feature.spec.js",
      file: "tests/e2e/features/login.feature.spec.js",
      specs: [],
      suites: [
        {
          title: "Login",
          file: "tests/e2e/features/login.feature.spec.js",
          specs: [
            {
              title: "Signs in",
              file: "tests/e2e/features/login.feature.spec.js",
              tests: [pwTest("chromium", "passed", [PASS_STEP]), pwTest("firefox", "passed", [PASS_STEP])],
            },
            {
              title: "Signs out",
              file: "tests/e2e/features/login.feature.spec.js",
              tests: [pwTest("chromium", "passed", [PASS_STEP])],
            },
          ],
        },
      ],
    },
    {
      title: "tests/e2e/features/cart.feature.spec.js",
      file: "tests/e2e/features/cart.feature.spec.js",
      specs: [],
      suites: [
        {
          title: "Cart",
          file: "tests/e2e/features/cart.feature.spec.js",
          specs: [
            {
              title: "Adds an item",
              file: "tests/e2e/features/cart.feature.spec.js",
              tests: [pwTest("chromium", "failed", [FAIL_STEP])],
            },
          ],
        },
      ],
    },
  ],
  errors: [],
  stats: { startTime: "2026-10-27T00:00:00.000Z", duration: 20, expected: 3, skipped: 0, unexpected: 1, flaky: 0 },
});

describe("a playwright run's files is its count of distinct spec files", () => {
  test("four scenario nodes across two spec files answer files 2", async () => {
    // Four scenario nodes (one spec under two projects); two spec files.
    const { res } = await ingest("files-playwright", { codec: "playwright", data: PLAYWRIGHT_REPORT });
    expect(envelopeCounts(res.body.run)).toEqual({ passed: 3, failed: 1, pending: 0, total: 4, files: 2 });
  });
});
