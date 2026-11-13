// The project card's status line takes its compile verdict (`✓ compiled` /
// `✗ N errors`) from the newest compile record that is NOT a lint record. A
// lint record is a compile-kind event carrying `lint: "<tool>"`; it never sets
// that verdict:
//  - a project whose newest compile-kind record is a lint record keeps the
//    verdict of its newest compile record;
//  - a project holding only lint records shows no compile verdict at all.
//
// Each case is driven through the real board: records are posted to a real
// server on the compile route (`startServer`, in-memory store), the project's
// rollup is read from `GET /api/v2/projects` exactly as the dashboard reads
// it, and that rollup is handed to `projectStatus` (public/app-logic.mjs) and
// to the mounted app, whose Project pane renders the status line
// (`[data-testid="project-status-line"]`) — the same line the status-line
// tests in tests/storyboard-fidelity.test.ts pin. How the rollup carries the
// newest compile record is left to the implementation; only what the line
// says is pinned.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { projectStatus } from "../public/app-logic.mjs";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

const handles: ServerHandle[] = [];

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  while (handles.length > 0) handles.pop()?.stop();
});

// ── The real board ──────────────────────────────────────────────────────────

const ORCHESTRATOR = "status-line-orch";

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await res.json()) as Record<string, unknown>;
  expect({ status: res.status, error: answer.error }).toEqual({ status: 200, error: undefined });
  return answer;
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A project with its orchestrator registered (an ingest needs a live caller). */
async function seedProject(handle: ServerHandle, name: string): Promise<string> {
  // The board is read with the runtime's own fetch, never a page's scripted one.
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name, type: "backend", sutRoot: "/tmp/p" });
  await postJson(handle, "/api/v2/agents/register", { projectKey: key, agentId: ORCHESTRATOR, role: "ORCHESTRATOR" });
  await Bun.sleep(5);
  return key;
}

/** One rustc error. */
const RUSTC_ONE_ERROR = ["error[E0308]: mismatched types", " --> src/lib.rs:12:5"].join("\n");

/** One rustc warning and no error: a clean build. */
const RUSTC_ONE_WARNING = ["warning: unused variable: `x`", " --> src/main.rs:2:9"].join("\n");

/** Two errors, as clippy prints them under `-D warnings`. */
const CLIPPY_TWO_ERRORS = [
  "error: unneeded `return` statement",
  " --> src/store.rs:91:9",
  "error: redundant clone",
  " --> src/checkpoint.rs:57:22",
].join("\n");

/** Posts a compile record and answers its event id. */
async function postCompile(handle: ServerHandle, key: string, errors: string): Promise<string> {
  const answer = await postJson(handle, "/api/v2/runs/compile", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    format: "rustc",
    errors,
  });
  await Bun.sleep(5);
  return answer.event as string;
}

/** Posts a failing clippy lint record (two errors, exit 101) and answers its event id. */
async function postFailingLint(handle: ServerHandle, key: string): Promise<string> {
  const answer = await postJson(handle, "/api/v2/runs/compile", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    format: "rustc",
    lint: "clippy",
    runnerExit: 101,
    errors: CLIPPY_TWO_ERRORS,
  });
  await Bun.sleep(5);
  return answer.event as string;
}

/** The rollup as the board answers it, typed as the shape `projectStatus` reads. */
type Rollup = Parameters<typeof projectStatus>[0] & { key: string };

/** The project's rollup exactly as `GET /api/v2/projects` answers it. */
async function rollupOf(handle: ServerHandle, key: string): Promise<Rollup> {
  const body = await getJson(handle, "/api/v2/projects");
  const hits = (body.projects as Rollup[]).filter((p) => p.key === key);
  expect(hits.length).toBe(1);
  return hits[0]!;
}

async function eventsOf(handle: ServerHandle, key: string): Promise<unknown[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}&limit=100`);
  return body.events as unknown[];
}

// ── The mounted status line ─────────────────────────────────────────────────

let cacheBust = 0;

/** Mounts the project's workspace on the board's own answers; returns the status line. */
async function mountStatusLine(rollup: Rollup, events: unknown[]): Promise<Element> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${rollup.key}` });
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: [rollup] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events };
    else if (url.includes("/api/v2/health")) body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    else throw new Error(`project-status-line-reads-compile-records-only.test.ts: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?statusLineCompileOnly=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 6 });
  const line = document.querySelector('[data-testid="project-status-line"]');
  expect(line).not.toBeNull();
  return line!;
}

function lineText(line: Element): string {
  return (line.textContent ?? "").trim();
}

/** Any compile verdict: `✓ compiled`, or `✗ N error(s)` (a lint wording such as `✗ 2 lint errors` is not one). */
const COMPILE_VERDICT = /✓ compiled|✗ \d+ errors?\b/;

// ── The cases ───────────────────────────────────────────────────────────────

describe("the project status line takes its compile verdict from compile records only", () => {
  test("a clean build followed by a failing lint run keeps the line at '✓ compiled' in the pass tone", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-clean-then-lint");
    await postCompile(handle, key, RUSTC_ONE_WARNING);
    await postFailingLint(handle, key);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup)).toEqual({ text: "✓ compiled · just now", tone: "pass" });

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).toBe("✓ compiled · just now");
    expect(line.className).toContain("app-ratio-pass");
    expect(line.className).not.toContain("app-ratio-fail");
  });

  test("a build with one error followed by a lint run with two errors keeps the line at '✗ 1 error', never the lint run's count", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-error-then-lint");
    await postCompile(handle, key, RUSTC_ONE_ERROR);
    await postFailingLint(handle, key);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup)).toEqual({ text: "✗ 1 error · just now", tone: "fail" });

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).toBe("✗ 1 error · just now");
    expect(lineText(line)).not.toContain("2 errors");
  });

  test("a project holding only a failing lint record shows no compile verdict on its status line", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-only-lint");
    await postFailingLint(handle, key);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup).text).not.toMatch(COMPILE_VERDICT);

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).not.toMatch(COMPILE_VERDICT);
  });

  // GUARD — passes today: a compile record NEWER than a lint record still
  // sets the line. It fails if compile-kind records are dropped wholesale
  // instead of only the lint ones.
  test("a build with one error posted after a lint run sets the line to '✗ 1 error' in the fail tone", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-lint-then-error");
    await postFailingLint(handle, key);
    await postCompile(handle, key, RUSTC_ONE_ERROR);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup)).toEqual({ text: "✗ 1 error · just now", tone: "fail" });

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).toBe("✗ 1 error · just now");
    expect(line.className).toContain("app-ratio-fail");
  });
});

describe("projectStatus never words a lint brief as a compile verdict", () => {
  // The seeded form the status-line tests in tests/storyboard-fidelity.test.ts
  // use: a project whose `lastEvent` is a lint record's brief, and nothing else.
  const lintBrief = {
    kind: "compile",
    lint: "clippy",
    total: 0,
    passed: 0,
    failed: 0,
    errors: 2,
    warnings: 0,
    timestamp: Date.now(),
  };

  test("a failing lint brief as the project's last event gives neither '✓ compiled' nor '✗ 2 errors'", () => {
    const status = projectStatus({ lastEvent: { ...lintBrief, timestamp: Date.now() } });
    expect(status.text).not.toMatch(COMPILE_VERDICT);
  });

  test("a clean lint brief as the project's last event gives no '✓ compiled'", () => {
    const status = projectStatus({ lastEvent: { ...lintBrief, errors: 0, timestamp: Date.now() } });
    expect(status.text).not.toMatch(COMPILE_VERDICT);
  });
});

// ── A lint-only project reads its newest lint record's own words ──────────────

/** Posts a clippy lint record over `errors` with the linter's `runnerExit`; answers its event id. */
async function postLint(handle: ServerHandle, key: string, errors: string, runnerExit: number): Promise<string> {
  const answer = await postJson(handle, "/api/v2/runs/compile", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    format: "rustc",
    lint: "clippy",
    runnerExit,
    errors,
  });
  await Bun.sleep(5);
  return answer.event as string;
}

/** Three passing junit cases. */
const JUNIT_THREE_PASS = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"/>',
  "</testsuite>",
].join("\n");

/** Posts a green test run of three passing cases on `/api/v2/runs`; answers its event id. */
async function postGreenTestRun(handle: ServerHandle, key: string): Promise<string> {
  const answer = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    codec: "junit",
    data: JUNIT_THREE_PASS,
  });
  await Bun.sleep(5);
  return answer.event as string;
}

describe("a project whose runs are all lint records reads its newest lint record's own words", () => {
  test("a lint-only project with two lint errors reads exactly '✗ 2 lint errors · just now' in the fail tone, from projectStatus and on the mounted line", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-lint-only-two");
    await postLint(handle, key, CLIPPY_TWO_ERRORS, 101);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup)).toEqual({ text: "✗ 2 lint errors · just now", tone: "fail" });

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).toBe("✗ 2 lint errors · just now");
    expect(line.className).toContain("app-ratio-fail");
    expect(line.className).not.toContain("app-ratio-pass");
  });

  test("a lint-only project whose lint run is clean reads exactly 'lint clean · just now' in the pass tone, from projectStatus and on the mounted line", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-lint-only-clean");
    await postLint(handle, key, RUSTC_ONE_WARNING, 0);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup)).toEqual({ text: "lint clean · just now", tone: "pass" });

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).toBe("lint clean · just now");
    expect(line.className).toContain("app-ratio-pass");
    expect(line.className).not.toContain("app-ratio-fail");
  });

  test("a lint-only project with one lint error reads exactly '✗ 1 lint error · just now' (singular) in the fail tone, from projectStatus and on the mounted line", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-lint-only-one");
    await postLint(handle, key, RUSTC_ONE_ERROR, 1);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup)).toEqual({ text: "✗ 1 lint error · just now", tone: "fail" });

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).toBe("✗ 1 lint error · just now");
    expect(line.className).toContain("app-ratio-fail");
  });
});

describe("a lint record after a test run leaves the line on the test run", () => {
  test("compile, then a green test run, then a failing lint run reads the test ratio '✓ green · 3/3 · just now' in the pass tone, from projectStatus and on the mounted line", async () => {
    const handle = boot();
    const key = await seedProject(handle, "status-compile-test-lint");
    await postCompile(handle, key, RUSTC_ONE_ERROR);
    await postGreenTestRun(handle, key);
    await postLint(handle, key, CLIPPY_TWO_ERRORS, 101);
    const rollup = await rollupOf(handle, key);
    const events = await eventsOf(handle, key);

    expect(projectStatus(rollup)).toEqual({ text: "✓ green · 3/3 · just now", tone: "pass" });

    const line = await mountStatusLine(rollup, events);
    expect(lineText(line)).toBe("✓ green · 3/3 · just now");
    expect(line.className).toContain("app-ratio-pass");
    expect(lineText(line)).not.toContain("lint");
  });
});
