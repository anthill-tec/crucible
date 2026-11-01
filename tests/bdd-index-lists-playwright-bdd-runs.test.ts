// The BDD tab's index lists a run whose framework is `playwright-bdd` — a run
// streamed in `crucible-events` — beside a run the `playwright` codec stored,
// and still no plain test run. The index keys on the run's FRAMEWORK for the
// new shape: a `crucible-events` run of another framework is no BDD run.
//
// Three proofs:
//   - `bddIndexRows` (public/app-logic.mjs) over event briefs, directly;
//   - the brief type `CrucibleEventBrief` carries `framework` in both
//     declaration mirrors (public/app-logic.d.mts and tests/app-logic.d.ts),
//     read as source — the mirrors carry no runtime;
//   - the BDD tab of the production shell, mounted against a real board
//     (tests/helpers/served-app.ts) holding the runs as each path stores them:
//     a streamed playwright-bdd run, a playwright-codec report, a JUnit run
//     and a streamed run of another framework.
//
// SAFETY: every server binds port 0 on ":memory:".
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerHandle } from "../src/server.ts";
import * as AppLogic from "../public/app-logic.mjs";
import {
  bootOn,
  closeStream,
  eventLine,
  openRun,
  postJson,
  register,
  sendBatch,
} from "./helpers/run-stream-harness.ts";
import { mountServedApp, restoreRealFetch, settleServedApp } from "./helpers/served-app.ts";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

interface IndexRow {
  id: string;
  timestamp: number;
  agentId: string;
  cycle: string | null;
  verdict: "pass" | "fail" | "pending";
  passed: number;
  failed: number;
  pending: number;
}

// `bddIndexRows` is exported by public/app-logic.mjs but not declared in its
// .d.mts; the cast states the shape this file reads.
const { bddIndexRows } = AppLogic as unknown as { bddIndexRows: (events: unknown[]) => IndexRow[] };

function brief(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    projectKey: "proj-bdd-index-framework",
    agentId: "index-runner",
    kind: "test",
    total: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    duration_ms: 10,
    hasCoverage: false,
    ...fields,
  };
}

describe("bddIndexRows lists playwright-bdd runs beside playwright-codec runs", () => {
  test("a crucible-events run of framework playwright-bdd and a playwright-codec run are listed newest first; a junit run and a crucible-events run of another framework are not", () => {
    const rows = bddIndexRows([
      brief({ id: "evt-codec-playwright", codec: "playwright", timestamp: 2_000 }),
      brief({ id: "evt-junit", codec: "junit", framework: "bun-test", tier: "unit", timestamp: 4_000 }),
      brief({
        id: "evt-stream-bdd",
        codec: "crucible-events",
        framework: "playwright-bdd",
        tier: "e2e",
        timestamp: 3_000,
        total: 7,
        passed: 5,
        failed: 2,
        context: { cycleId: 77, cycle: "checkout" },
      }),
      brief({ id: "evt-stream-vitest", codec: "crucible-events", framework: "vitest", timestamp: 5_000 }),
    ]);

    expect(rows.map((r) => r.id)).toEqual(["evt-stream-bdd", "evt-codec-playwright"]);
    expect(rows[0]).toEqual({
      id: "evt-stream-bdd",
      timestamp: 3_000,
      agentId: "index-runner",
      cycle: "cycle 77 · checkout",
      verdict: "fail",
      passed: 5,
      failed: 2,
      pending: 0,
    });
  });

  test("a playwright-bdd run that is not a test run is not listed", () => {
    const rows = bddIndexRows([
      brief({ id: "evt-bdd-compile", kind: "compile", codec: "crucible-events", framework: "playwright-bdd", timestamp: 1_000 }),
      brief({ id: "evt-bdd-test", codec: "crucible-events", framework: "playwright-bdd", timestamp: 900 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["evt-bdd-test"]);
  });
});

/** The body of `interface CrucibleEventBrief { … }` in a declaration file. */
function briefInterfaceOf(relPath: string): string {
  const src = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  const match = /interface CrucibleEventBrief \{([\s\S]*?)\n\s*\}/.exec(src);
  if (match === null) throw new Error(`${relPath} declares no CrucibleEventBrief interface`);
  return match[1]!;
}

describe("CrucibleEventBrief carries the run's framework in both declaration mirrors", () => {
  test("public/app-logic.d.mts declares an optional string framework on the brief", () => {
    expect(briefInterfaceOf("public/app-logic.d.mts")).toMatch(/^\s*framework\?:\s*string;/m);
  });

  test("tests/app-logic.d.ts mirrors the same optional string framework", () => {
    expect(briefInterfaceOf("tests/app-logic.d.ts")).toMatch(/^\s*framework\?:\s*string;/m);
  });
});

// ── The BDD tab on a real board ───────────────────────────────────────────

const handles: ServerHandle[] = [];

afterEach(async () => {
  await restoreRealFetch();
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "index-board-runner";

async function streamRun(handle: ServerHandle, key: string, framework: string, text: string): Promise<string> {
  const runId = await openRun(handle, key, AGENT, { tier: "e2e", stack: "bun", framework });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const closed = await closeStream(handle, key, AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return closed.body.event as string;
}

const ONE_SCENARIO_STREAM =
  eventLine({ event: "run-start", total: 1 }) +
  eventLine({
    event: "test-end",
    id: "pay-chromium",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 12,
    steps: [{ name: "Given a cart holding one book", status: "pass", duration_ms: 12 }],
  }) +
  eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 12 });

const ONE_VITEST_STREAM =
  eventLine({ event: "run-start", total: 1 }) +
  eventLine({ event: "test-end", id: "adds", name: "adds", suite: "math", file: "math.test.ts", status: "pass", duration_ms: 1 }) +
  eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 });

const PLAYWRIGHT_REPORT = {
  config: { version: "1.61.1" },
  suites: [
    {
      title: "tests/e2e/features/library.feature.spec.js",
      file: "tests/e2e/features/library.feature.spec.js",
      column: 0,
      line: 0,
      specs: [],
      suites: [
        {
          title: "Library",
          file: "tests/e2e/features/library.feature.spec.js",
          line: 3,
          column: 6,
          specs: [
            {
              title: "Borrow a book",
              ok: true,
              tags: [],
              tests: [
                {
                  timeout: 30000,
                  annotations: [],
                  expectedStatus: "passed",
                  projectId: "chromium",
                  projectName: "chromium",
                  results: [
                    {
                      workerIndex: 0,
                      parallelIndex: 0,
                      status: "passed",
                      duration: 2,
                      retry: 0,
                      steps: [{ title: "Given a library card", duration: 2 }],
                      startTime: "2026-11-01T00:00:00.000Z",
                      annotations: [],
                      attachments: [],
                    },
                  ],
                  status: "expected",
                },
              ],
              id: "spec-borrow",
              file: "tests/e2e/features/library.feature.spec.js",
              line: 6,
              column: 3,
            },
          ],
        },
      ],
    },
  ],
  errors: [],
  stats: { startTime: "2026-11-01T00:00:00.000Z", duration: 2, expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
};

const JUNIT_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<testsuites tests="1" failures="0"><testsuite name="math" tests="1" failures="0">' +
  '<testcase name="adds" classname="math" time="0.001"/></testsuite></testsuites>\n';

async function ingest(handle: ServerHandle, body: Record<string, unknown>): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs", { agentId: AGENT, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.event as string;
}

describe("the BDD tab lists a playwright-bdd run beside a playwright-codec run", () => {
  test("on a real board: the streamed playwright-bdd run and the playwright-codec run are listed newest first; the junit run and the vitest stream are not", async () => {
    const handle = bootOn();
    handles.push(handle);
    const key = crypto.randomUUID();
    handle.store.addProject({ key, name: "bdd-index-board", type: "frontend", sutRoot: "/tmp/bdd-index-board" });
    await register(handle, key, AGENT);

    const codecId = await ingest(handle, { projectKey: key, codec: "playwright", data: JSON.stringify(PLAYWRIGHT_REPORT), tier: "e2e" });
    await Bun.sleep(5);
    const junitId = await ingest(handle, { projectKey: key, codec: "junit", data: JUNIT_XML, tier: "unit", stack: "bun", framework: "bun-test" });
    await Bun.sleep(5);
    const vitestId = await streamRun(handle, key, "vitest", ONE_VITEST_STREAM);
    await Bun.sleep(5);
    const bddId = await streamRun(handle, key, "playwright-bdd", ONE_SCENARIO_STREAM);

    await mountServedApp(handle, `/p/${key}`);
    const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).find(
      (t) => (t.textContent ?? "").trim() === "BDD",
    );
    expect(tab).toBeDefined();
    tab!.click();
    await settleServedApp();

    const pane = document.querySelector<HTMLElement>('[data-testid="workspace-bdd"]');
    expect(pane).not.toBeNull();
    const ids = Array.from(pane!.querySelectorAll<HTMLElement>('[data-testid="bdd-index-row"]')).map(
      (r) => r.getAttribute("data-run-id") ?? "",
    );
    expect(ids).toEqual([bddId, codecId]);
    expect(ids).not.toContain(junitId);
    expect(ids).not.toContain(vitestId);
  });
});
