// CR-CRU-008 C2 — clients/bun-crucible.py v2 contract (RED).
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md — §S2 script fleet
// upgrade (v2 endpoints, tier, git/wave/orchestrator/cycle context) + the
// plan-verbs paragraph (plan-file/cycle-activate/cycle-done/cr-close,
// track from WORKFLOW_ROLE) + §S2c (failure-detail enrichment) + Risk
// section: "clients/ in-repo is the SOURCE OF TRUTH ... VERIFY tests run
// against clients/ copies." This cycle (C2) upgrades bun-crucible.py.
//
// RED phase: `clients/bun-crucible.py` does not exist AT ALL yet on this
// branch (only `~/.claude/scripts/bun-crucible.py`, the LIVE v1 script,
// exists — it is copied into `clients/` and upgraded there by GREEN).
// Every test below spawns `python3 clients/bun-crucible.py ...` against a
// REAL live test server and fails because the file is missing — `python3`
// exits 2 with "can't open file" on stderr. That is expected RED.
//
// Technique: reuses tests/cli-axi.test.ts's proven pattern — a real
// `startServer({port:0, dbPath:":memory:"})` instance + `Bun.spawn`
// against it. NEW here: a tiny CAPTURING PROXY (`startCapturingProxy`) —
// its own `Bun.serve` that records {method, path} for every request it
// receives, forwards it verbatim to the real server, and relays the real
// response back untouched — so tests can pin the EXACT URLs the spawned
// python script hit (v2-only, NEVER the v1 shim) without parsing the
// script's source. `CRUCIBLE_URL` is pointed at the proxy (or, where the
// proxy isn't needed, directly at the real server) instead of the
// hardcoded `http://localhost:3849` the current script uses — the C2
// upgrade must read this env var.
//
// §S2c ground truth (PROBED directly against the installed bun binary,
// 1.3.14-canary, not assumed from the spec prose): `bun test
// --reporter=junit` writes a BARE `<failure type="AssertionError"/>` (no
// message attribute, no element text) for every failure kind — assertion
// mismatch, thrown Error, AND timeout alike. Detail lives only in the
// console stream:
//   - assertion mismatch / thrown Error: an "error: <detail>" block
//     appears IMMEDIATELY BEFORE the "(fail) <name>" line, e.g.:
//       error: expect(received).toBe(expected)
//       ...
//       (fail) mismatched expectation [0.12ms]
//   - a TIMEOUT's detail line ("^ this test timed out after Nms.") is
//     printed AFTER the "(fail) <name>" line instead — structurally NOT a
//     "preceding block". A marrying parser built to the spec's described
//     mechanism ("the error:/assertion block preceding each (fail) <name>
//     line") cannot associate it with that leaf. That is the deliberate
//     "unmatched failing leaf" fixture case below (degrades to type-only).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

const SCRIPT_PATH = join(import.meta.dir, "..", "clients", "bun-crucible.py");

// ── spawn + capture helpers ──────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `python3 clients/bun-crucible.py <args>`. Strips any ambient
 * WORKFLOW_* env so each test controls it explicitly, and always injects
 * CRUCIBLE_URL — the contract under test (the v1 script hardcodes
 * `http://localhost:3849`; the C2 upgrade must honor this env var so tests
 * can point it at an ephemeral-port test server instead).
 */
async function runScript(
  args: string[],
  opts: { cwd: string; crucibleUrl: string; env?: Record<string, string | undefined> },
): Promise<RunResult> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  const proc = Bun.spawn({
    cmd: ["python3", SCRIPT_PATH, ...args],
    cwd: opts.cwd,
    env: { ...baseEnv, CRUCIBLE_URL: opts.crucibleUrl, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

interface ProxyCall {
  method: string;
  path: string;
}

/**
 * A tiny Bun.serve CAPTURING PROXY: records every {method, path} it
 * receives, forwards the request verbatim to `targetBaseUrl`, and relays
 * the real response back untouched. Lets tests pin the EXACT URLs a
 * spawned script hit (v2-only, never the v1 shim) without reading the
 * script's source.
 */
function startCapturingProxy(targetBaseUrl: string): {
  url: string;
  calls: ProxyCall[];
  stop(): void;
} {
  const calls: ProxyCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push({ method: req.method, path: url.pathname });
      const target = new URL(url.pathname + url.search, targetBaseUrl);
      const headers = new Headers(req.headers);
      headers.delete("host");
      const init: RequestInit = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = await req.arrayBuffer();
      }
      const upstream = await fetch(target, init);
      const body = await upstream.arrayBuffer();
      return new Response(body, { status: upstream.status, headers: upstream.headers });
    },
  });
  return { url: `http://localhost:${server.port}`, calls, stop: () => server.stop(true) };
}

// ── server-side read helpers (plain fetch — no proxy) ────────────────────

async function createProject(baseUrl: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v2/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as { project: { key: string } };
  return body.project.key;
}

async function getAgents(
  baseUrl: string,
  key: string,
): Promise<Array<{ agentId: string; message: string }>> {
  const res = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
  const body = (await res.json()) as { agents: Array<{ agentId: string; message: string }> };
  return body.agents;
}

async function getAgentIds(baseUrl: string, key: string): Promise<string[]> {
  return (await getAgents(baseUrl, key)).map((a) => a.agentId);
}

interface PlanCycleWire {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanWire {
  planId: number;
  cr: string;
  title?: string;
  track?: string;
  status: string;
  cycles: PlanCycleWire[];
  merge?: { commit: string };
}

async function getPlans(baseUrl: string, key: string): Promise<PlanWire[]> {
  const res = await fetch(`${baseUrl}/api/v2/projects/${key}/plans`);
  const body = (await res.json()) as { plans: PlanWire[] };
  return body.plans;
}

async function getEvents(baseUrl: string, key: string): Promise<Array<{ id: string }>> {
  const res = await fetch(`${baseUrl}/api/v2/events?project=${key}`);
  const body = (await res.json()) as { events: Array<{ id: string }> };
  return body.events;
}

/**
 * Files a real OPEN plan with two cycles (both start `pending`, neither
 * active). CR-CRU-036 §S1: the client auto-attaches ingests to the open
 * plan's single `status:"active"` cycle resolved FROM THE SERVER —
 * `WORKFLOW_CYCLE_ID` is removed and read by no client — so a filed-but-
 * unactivated plan is exactly the "open plan, no active cycle" fixture,
 * and `activateCycle` below is what actually makes one of its cycles the
 * auto-attach target.
 */
async function filePlan(baseUrl: string, key: string, cr: string): Promise<PlanWire> {
  const res = await fetch(`${baseUrl}/api/v2/projects/${key}/plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cr, cycles: [{ label: "A" }, { label: "B" }] }),
  });
  return (await res.json()) as PlanWire;
}

/**
 * CR-CRU-036 §S1 fixture primitive: PATCHes a plan's cycle to
 * `status:"active"` directly against the plans API (never through the
 * script's own `cycle-activate` verb, to keep the auto-attach fixtures
 * independent of the verb under test elsewhere in this file) — the
 * "seed an active cycle on the test server" step (project → plan-file →
 * cycle-activate) the CR calls for.
 */
async function activateCycle(baseUrl: string, key: string, planId: number, cycleId: number): Promise<void> {
  await fetch(`${baseUrl}/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
}

interface EventLeaf {
  name: string;
  status: string;
  failure?: { message?: string; trace?: string; type?: string };
}

interface EventSuite {
  name: string;
  status: string;
  children: EventLeaf[];
}

interface FullEvent {
  tier?: string;
  codec?: string;
  context?: {
    git?: { branch?: string; commit?: string };
    wave?: string;
    orchestrator?: string;
    cycle?: string;
    cycleId?: number;
  };
  summary?: { total: number; passed: number; failed: number; pending?: number };
  tree?: EventSuite[];
}

async function getFullEvent(baseUrl: string, id: string): Promise<FullEvent> {
  const res = await fetch(`${baseUrl}/api/v2/events/${id}`);
  const body = (await res.json()) as { event: FullEvent };
  return body.event;
}

// ── git + fixture-project helpers ────────────────────────────────────────

function runGit(args: string[], cwd: string): void {
  const res = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "clients-bun-crucible-test",
      GIT_AUTHOR_EMAIL: "clients-bun-crucible-test@example.com",
      GIT_COMMITTER_NAME: "clients-bun-crucible-test",
      GIT_COMMITTER_EMAIL: "clients-bun-crucible-test@example.com",
    },
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

// 1 passing + 3 failing (mismatch, thrown-with-detail, timeout) — see the
// file header for why the timeout case is the deliberate "unmatched" leaf.
const FIXTURE_TEST_SOURCE = `import { test, expect } from "bun:test";

test("adds numbers correctly", () => {
  expect(1 + 1).toBe(2);
});

test("mismatched expectation", () => {
  expect(1 + 1).toBe(3);
});

test("throws with detail", () => {
  throw new Error("boom with detail");
});

test("times out unmatched", async () => {
  await new Promise(() => {});
}, 50);
`;

function writeFixtureBunProject(dir: string, projectKey: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "clients-bun-crucible-fixture", version: "0.0.0", private: true }),
  );
  writeFileSync(join(dir, "sample.test.ts"), FIXTURE_TEST_SOURCE);
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
}

// CR-CRU-050 §S1/§S1b/§S2 — a `<skipped/>` testcase must be classified as
// pending, never folded into passed. Same source-file writer as
// writeFixtureBunProject but with a caller-supplied test source, so each
// CR-CRU-050 fixture below can pin its own exact pass/fail/skip shape.
function writeBunProjectWithSource(dir: string, projectKey: string, source: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "clients-bun-crucible-fixture", version: "0.0.0", private: true }),
  );
  writeFileSync(join(dir, "sample.test.ts"), source);
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
}

// CR-CRU-050 mixed fixture: 1 pass, 1 fail, 1 `test.skip`, 1 `test.todo`.
// Probed directly against the installed bun binary (1.3.14-canary): BOTH
// `test.skip` and `test.todo` emit a bare/`message="TODO"` `<skipped/>`
// child element in the JUnit XML — bun's own console summary for this
// fixture reads "1 pass / 2 skip / 1 fail". The defect under test folds
// both skipped cases into `passed` (reading `passed=3`) instead of leaving
// them out of `passed` and counting them as `pending=2`.
const FIXTURE_PENDING_MIXED_SOURCE = `import { test, expect } from "bun:test";

test("adds numbers correctly", () => {
  expect(1 + 1).toBe(2);
});

test("mismatched expectation", () => {
  expect(1 + 1).toBe(3);
});

test.skip("skipped via test.skip", () => {
  expect(1).toBe(1);
});

test.todo("skipped via test.todo");
`;

// CR-CRU-050 acceptance-criteria E2E reproduction, matching the spec's own
// table verbatim in shape: bun's own output reads "N pass / 1 skip / 0
// fail" and the ingest envelope must read passed=N pending=1 — never
// passed=N+1. N=2 here (2 passing tests, 1 `test.skip`, 0 failures).
const FIXTURE_PENDING_REPRO_SOURCE = `import { test, expect } from "bun:test";

test("first passing test", () => {
  expect(1 + 1).toBe(2);
});

test("second passing test", () => {
  expect("a" + "b").toBe("ab");
});

test.skip("the skipped corroboration case", () => {
  expect(true).toBe(true);
});
`;

/**
 * Extracts the 4-space-indented body of the TOON `  run:` block from a
 * bun-crucible.py stdout envelope (the §S2 printed run: block under
 * `axi:`), without depending on key ORDER inside it — the fix may insert
 * `pending` anywhere in the `run` dict. Returns the raw block text (each
 * line still carries its 4-space indent) or `undefined` if no `run:` key
 * is present at all.
 */
function extractRunBlock(stdout: string): string | undefined {
  const match = stdout.match(/ {2}run:\n((?: {4}.*\n)*)/);
  return match?.[1];
}

// ── §S2 — v2-only endpoints + CRUCIBLE_URL + register ergonomics ─────────

describe("clients/bun-crucible.py — v2 endpoints + CRUCIBLE_URL honored (CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function fixtureProjectDir(key: string): string {
    const dir = scratchDir("bun-crucible-proj-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return dir;
  }

  test("register hits POST /api/v2/agents/register (never the v1 /api/agents/heartbeat shim) via CRUCIBLE_URL, not the hardcoded localhost:3849", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-register-v2");
    const projectDir = fixtureProjectDir(key);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      ["register", "--agent", "a1", "--phase", "RED", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: proxy.url },
    );

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).toContain("a1");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/register"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/heartbeat")).toBe(false);
    expect(proxy.calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  });

  test("unregister hits POST /api/v2/agents/unregister (never v1 /api/agents/remove); agent vanishes from GET /api/v2/agents", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-unregister-v2");
    const projectDir = fixtureProjectDir(key);
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      ["register", "--agent", "a2", "--phase", "RED", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: proxy.url },
    );
    expect(await getAgentIds(baseUrl, key)).toContain("a2");

    const res = await runScript(["unregister", "--agent", "a2", "--project-dir", projectDir], {
      cwd: projectDir,
      crucibleUrl: proxy.url,
    });

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).not.toContain("a2");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/unregister"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  });

  test("register --agent X WITHOUT --phase succeeds (ergonomics fix: defaults to report phase) instead of hard-failing", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-phase-optional");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(["register", "--agent", "a3", "--project-dir", projectDir], {
      cwd: projectDir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    const agents = await getAgents(baseUrl, key);
    const agent = agents.find((a) => a.agentId === "a3");
    expect(agent).toBeDefined();
    // Default phase is "report" (the pinned-away defect: --phase used to be
    // a hard requirement, forcing orchestrator-side implicit-heartbeat
    // workarounds — Implementation Notes, 2026-07-17).
    expect(agent!.message.toLowerCase()).toContain("report");
  });
});

// ── §S2 tier/context + §S2c failure marrying ──────────────────────────────

describe("clients/bun-crucible.py — test-run ingest: tier, full context, §S2c failure marrying", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratchDirs: string[] = [];
  let baseUrl = "";
  let projectKey = "";
  let runResult: RunResult | undefined;
  let event: FullEvent | undefined;
  let activeCycleId = 0;
  const branch = "cr-cru-008-c2-fixture-branch";

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    baseUrl = `http://localhost:${handle.server.port}`;
    projectKey = await createProject(baseUrl, "clients-bc-test-ingest");
    // CR-CRU-036 §S1: seed an ACTIVE cycle on the test server (plan-file +
    // activate cycles[0]) so the ingest auto-attaches to it FROM THE
    // SERVER. cycles[1] stays pending and is fed to WORKFLOW_CYCLE_ID below
    // — a REAL, linkable, but NOT-active cycle — proving the env var is
    // read by nobody: if it still won the attach, context.cycleId would
    // come back as cycles[1]'s id instead of the active cycles[0]'s.
    const plan = await filePlan(baseUrl, projectKey, "CR-CRU-008-C2-FIXTURE");
    activeCycleId = plan.cycles[0]!.id;
    const otherCycleId = plan.cycles[1]!.id;
    await activateCycle(baseUrl, projectKey, plan.planId, activeCycleId);
    const dir = scratchDir("bun-crucible-fixture-");
    writeFixtureBunProject(dir, projectKey);
    runGit(["init", "-q"], dir);
    runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    runGit(["add", "."], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);

    proxy = startCapturingProxy(baseUrl);
    runResult = await runScript(
      [
        "test",
        "--agent",
        "cr-cru-008-c2-fixture-agent",
        "--tests",
        "sample.test.ts",
        "--project-dir",
        dir,
        "--package-dir",
        dir,
      ],
      {
        cwd: dir,
        crucibleUrl: proxy.url,
        env: {
          WORKFLOW_CYCLE_ID: String(otherCycleId),
          WORKFLOW_CYCLE: "clients source of truth fixture",
          WORKFLOW_WAVE: "wave-9",
          WORKFLOW_ROLE: "track-2",
        },
      },
    );
    const events = await getEvents(baseUrl, projectKey);
    // A hard miss here (events.length === 0, e.g. because clients/ is
    // absent) leaves `event` undefined — the tests below still run and
    // fail loudly on the undefined field reads rather than passing quietly.
    event = events.length > 0 ? await getFullEvent(baseUrl, events[0]!.id) : undefined;
  });

  afterAll(() => {
    proxy?.stop();
    handle?.stop();
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("records tier:'unit' and posts to /api/v2/runs/parsed only (never v1 /api/ingest/parsed)", () => {
    expect(runResult?.code).not.toBe(0); // 3 of 4 fixture tests fail
    expect(event?.tier).toBe("unit");
    expect(event?.summary?.total).toBe(4);
    expect(event?.summary?.passed).toBe(1);
    expect(event?.summary?.failed).toBe(3);
    expect(
      proxy?.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed"),
    ).toBe(true);
    expect(proxy?.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("records full run context: cycleId AUTO-ATTACHED from the server's active cycle (WORKFLOW_CYCLE_ID set to a DIFFERENT real cycle changes nothing), cycle (WORKFLOW_CYCLE), wave (WORKFLOW_WAVE), orchestrator (WORKFLOW_ROLE), and auto-detected git branch/commit", () => {
    expect(event?.context?.cycleId).toBe(activeCycleId);
    expect(event?.context?.cycle).toBe("clients source of truth fixture");
    expect(event?.context?.wave).toBe("wave-9");
    expect(event?.context?.orchestrator).toBe("track-2");
    expect(event?.context?.git?.branch).toBe(branch);
    expect(typeof event?.context?.git?.commit).toBe("string");
    expect((event?.context?.git?.commit ?? "").length).toBeGreaterThan(0);
  });

  test("§S2c: matched failing leaves carry failure.message married from the console stream (expect(...) / thrown detail)", () => {
    const leaves = (event?.tree ?? []).flatMap((suite) => suite.children);
    const mismatch = leaves.find((l) => l.name === "mismatched expectation");
    const thrown = leaves.find((l) => l.name === "throws with detail");
    expect(mismatch?.status).toBe("fail");
    expect(mismatch?.failure?.message).toBeDefined();
    expect(mismatch?.failure?.message ?? "").toContain("expect(");
    expect(thrown?.status).toBe("fail");
    expect(thrown?.failure?.message).toBeDefined();
    expect(thrown?.failure?.message ?? "").toContain("boom with detail");
  });

  test("§S2c: an unmatched failing leaf (timeout — detail line falls AFTER '(fail)', not before) degrades to type-only, no message", () => {
    const leaves = (event?.tree ?? []).flatMap((suite) => suite.children);
    const timedOut = leaves.find((l) => l.name === "times out unmatched");
    expect(timedOut?.status).toBe("fail");
    expect(timedOut?.failure?.message).toBeUndefined();
  });
});

// ── plan verbs ─────────────────────────────────────────────────────────────

describe("clients/bun-crucible.py — plan verbs (plan-file, cycle-activate, cycle-done, cr-close)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function fixtureProjectDir(key: string): string {
    const dir = scratchDir("bun-crucible-plan-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return dir;
  }

  test("plan-file creates an OPEN plan with the title, two cycles, and prints both numeric cycle ids on stdout", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-plan-file");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(
      [
        "plan-file",
        "--cr",
        "CR-X-1",
        "--title",
        "Plan verbs C2",
        "--cycles",
        "cycle-a,cycle-b",
        "--project-dir",
        projectDir,
      ],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    const plans = await getPlans(baseUrl, key);
    expect(plans.length).toBe(1);
    expect(plans[0]!.cr).toBe("CR-X-1");
    expect(plans[0]!.title).toBe("Plan verbs C2");
    expect(plans[0]!.status).toBe("open");
    expect(plans[0]!.cycles.length).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(plans[0]!, "track")).toBe(false);

    for (const cycle of plans[0]!.cycles) {
      expect(new RegExp(`\\b${cycle.id}\\b`).test(res.stdout)).toBe(true);
    }
  });

  test("with WORKFLOW_ROLE=track-2 set, plan-file records track:'track-2'; unset (default), the plan has no track key", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-plan-track");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(
      ["plan-file", "--cr", "CR-X-2", "--cycles", "cycle-a,cycle-b", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl, env: { WORKFLOW_ROLE: "track-2" } },
    );

    expect(res.code).toBe(0);
    const plans = await getPlans(baseUrl, key);
    expect(plans[0]!.track).toBe("track-2");
  });

  test("cycle-activate <id> transitions the cycle to active", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-cycle-activate");
    const projectDir = fixtureProjectDir(key);

    await runScript(
      ["plan-file", "--cr", "CR-X-3", "--cycles", "cycle-a,cycle-b", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );
    const cycleId = (await getPlans(baseUrl, key))[0]!.cycles[0]!.id;

    const res = await runScript(
      ["cycle-activate", String(cycleId), "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    const plans = await getPlans(baseUrl, key);
    const cycle = plans[0]!.cycles.find((c) => c.id === cycleId);
    expect(cycle?.status).toBe("active");
  });

  test("cycle-done <id> transitions an ACTIVE cycle to done (the orchestrator's GREEN confirmation, closes the span)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-cycle-done");
    const projectDir = fixtureProjectDir(key);

    await runScript(
      ["plan-file", "--cr", "CR-X-4", "--cycles", "cycle-a,cycle-b", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );
    const cycleId = (await getPlans(baseUrl, key))[0]!.cycles[0]!.id;
    await runScript(["cycle-activate", String(cycleId), "--project-dir", projectDir], {
      cwd: projectDir,
      crucibleUrl: baseUrl,
    });

    const res = await runScript(["cycle-done", String(cycleId), "--project-dir", projectDir], {
      cwd: projectDir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    const plans = await getPlans(baseUrl, key);
    const cycle = plans[0]!.cycles.find((c) => c.id === cycleId);
    expect(cycle?.status).toBe("done");
  });

  test("cr-close --commit <sha> closes the plan (once every cycle is terminal), recording the commit", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-cr-close");
    const projectDir = fixtureProjectDir(key);

    await runScript(
      ["plan-file", "--cr", "CR-X-5", "--cycles", "cycle-a,cycle-b", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );
    const cycles = (await getPlans(baseUrl, key))[0]!.cycles;
    for (const cycle of cycles) {
      await runScript(["cycle-activate", String(cycle.id), "--project-dir", projectDir], {
        cwd: projectDir,
        crucibleUrl: baseUrl,
      });
      await runScript(["cycle-done", String(cycle.id), "--project-dir", projectDir], {
        cwd: projectDir,
        crucibleUrl: baseUrl,
      });
    }

    const res = await runScript(["cr-close", "--commit", "abc1234", "--project-dir", projectDir], {
      cwd: projectDir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    const plans = await getPlans(baseUrl, key);
    expect(plans[0]!.status).toBe("closed");
    expect(plans[0]!.merge?.commit).toBe("abc1234");
  });
});

// ── CR-CRU-036 §S1 — server-active-cycle auto-attach: warn+withhold vs tolerant ──

describe("clients/bun-crucible.py — §S1 auto-attach: no-active-cycle warns+withholds, no plan at all is tolerant", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function fixtureProjectDir(key: string): string {
    const dir = scratchDir("bun-crucible-cycle-guard-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return dir;
  }

  test("register: an OPEN plan with NO active cycle warns[] 'no-active-cycle'/'activate a cycle first' + stderr, posts NO agent, exits non-zero — WORKFLOW_CYCLE_ID set is ignored", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-CRU-036-NO-ACTIVE-CYCLE");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(
      ["register", "--agent", "bc-no-active-cycle-agent", "--phase", "RED", "--project-dir", projectDir],
      // A stale WORKFLOW_CYCLE_ID pointing at a REAL (but pending) cycle in
      // this very plan must change NOTHING — §S1 removes the env var
      // entirely, so it can't rescue the withheld run.
      { cwd: projectDir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("no-active-cycle");
    expect(res.stderr).toContain("activate a cycle first");
    expect(res.stdout).toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("bc-no-active-cycle-agent");
  });

  test("register: NO open plan at all is tolerant — proceeds with no warning and no withhold (the lightweight-project default)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-tolerant-no-plan");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(
      ["register", "--agent", "bc-tolerant-agent", "--phase", "RED", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).toContain("bc-tolerant-agent");
  });
});

// ── byte-compatible existing verbs (regression gate) ───────────────────────

describe("clients/bun-crucible.py — byte-compatible CLI surface (existing verbs unchanged post-upgrade)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  test("regression --agent A --coverage (unchanged flag surface) runs the full suite and ingests tier:'regression' via v2", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-regression-compat");
    const dir = scratchDir("bun-crucible-regression-");
    writeFixtureBunProject(dir, key);

    const res = await runScript(
      ["regression", "--agent", "regression-agent", "--coverage", "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    // 3 of 4 fixture tests fail — existing cmd_regression contract returns
    // non-zero whenever summary.failed > 0 (unchanged by this CR).
    expect(res.code).toBe(1);
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.tier).toBe("regression");
    expect(await getAgentIds(baseUrl, key)).not.toContain("regression-agent"); // unregistered after the gated run
  });
});

// ── CR-CRU-050 §S1/§S1b/§S2 — <skipped/> testcases fold into `pending`, ───
// never `passed` ────────────────────────────────────────────────────────────
//
// `_parse_junit_file` (clients/bun-crucible.py:506) today checks only
// `tc.find("failure")`/`tc.find("error")`; a bare `else: passed += 1` folds
// every `<skipped/>` testcase (bun's real shape for BOTH `test.skip` and
// `test.todo` — probed above) into `passed`, and the summary hardcodes
// `"pending": 0`. `mvn-crucible.py:641` is the correct precedent this fixes
// toward: `<skipped>` → `status="pending"`, `pending` incremented, `passed`
// left untouched.

describe("clients/bun-crucible.py — CR-CRU-050 §S1/§S1b: <skipped/> (test.skip AND test.todo) count as pending, never passed", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];
  let runResult: RunResult | undefined;
  let event: FullEvent | undefined;

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-cr050-mixed");
    const dir = scratchDir("bun-crucible-cr050-mixed-");
    writeBunProjectWithSource(dir, key, FIXTURE_PENDING_MIXED_SOURCE);

    runResult = await runScript(
      ["test", "--agent", "cr050-mixed-agent", "--tests", "sample.test.ts", "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    const events = await getEvents(baseUrl, key);
    event = events.length > 0 ? await getFullEvent(baseUrl, events[0]!.id) : undefined;
  });

  afterAll(() => {
    handle?.stop();
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("§S1: ingested summary counts the 2 skipped/todo testcases as pending=2 (never folded into passed=3), and passed+failed+pending==total holds", () => {
    expect(event?.summary?.total).toBe(4);
    expect(event?.summary?.failed).toBe(1);
    // The defect: a bare `else: passed += 1` reads this as passed=3. The
    // fix must leave the two skipped/todo cases OUT of passed.
    expect(event?.summary?.passed).toBe(1);
    expect(event?.summary?.passed).not.toBe(3);
    expect(event?.summary?.pending).toBe(2);
    const s = event!.summary!;
    expect((s.passed ?? 0) + (s.failed ?? 0) + (s.pending ?? 0)).toBe(s.total);
  });

  test("§S1b: the test.skip leaf AND the test.todo leaf both carry tree status 'pending' (not 'pass'); the real pass/fail leaves are unaffected", () => {
    const leaves = (event?.tree ?? []).flatMap((suite) => suite.children);
    const skipLeaf = leaves.find((l) => l.name === "skipped via test.skip");
    const todoLeaf = leaves.find((l) => l.name === "skipped via test.todo");
    const passLeaf = leaves.find((l) => l.name === "adds numbers correctly");
    const failLeaf = leaves.find((l) => l.name === "mismatched expectation");

    expect(skipLeaf?.status).toBe("pending");
    expect(skipLeaf?.status).not.toBe("pass");
    expect(todoLeaf?.status).toBe("pending");
    expect(todoLeaf?.status).not.toBe("pass");
    // A count-only assertion would pass while the drill-in stayed green —
    // pin the unaffected leaves too, as a negative bound on this fix.
    expect(passLeaf?.status).toBe("pass");
    expect(failLeaf?.status).toBe("fail");
  });

  test("§S2: the printed run: envelope block carries pending:2 alongside passed:1/failed:1/total:4", () => {
    expect(runResult?.code).not.toBe(0); // 1 real failure among the 4 fixture tests
    const block = extractRunBlock(runResult?.stdout ?? "");
    expect(block).toBeDefined();
    expect(block).toContain("passed: 1");
    expect(block).toContain("failed: 1");
    expect(block).toContain("total: 4");
    expect(block).toContain("pending: 2");
  });
});

describe("clients/bun-crucible.py — CR-CRU-050 E2E repro: 'N pass / 1 skip / 0 fail' produces passed=N pending=1, not passed=N+1", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];
  let runResult: RunResult | undefined;
  let event: FullEvent | undefined;

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-cr050-repro");
    const dir = scratchDir("bun-crucible-cr050-repro-");
    writeBunProjectWithSource(dir, key, FIXTURE_PENDING_REPRO_SOURCE);

    runResult = await runScript(
      ["test", "--agent", "cr050-repro-agent", "--tests", "sample.test.ts", "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    const events = await getEvents(baseUrl, key);
    event = events.length > 0 ? await getFullEvent(baseUrl, events[0]!.id) : undefined;
  });

  afterAll(() => {
    handle?.stop();
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("ground truth: bun's own console summary for this fixture reads exactly '2 pass' / '1 skip' / '0 fail'", () => {
    expect(runResult?.stderr).toContain("2 pass");
    expect(runResult?.stderr).toContain("1 skip");
    expect(runResult?.stderr).toContain("0 fail");
  });

  test("the ingest envelope reads passed=2 pending=1 failed=0 total=3 — the skipped corroboration case is NOT folded into passed as N+1", () => {
    expect(runResult?.code).toBe(0); // 0 real failures — the run itself is green
    expect(event?.summary?.total).toBe(3);
    expect(event?.summary?.failed).toBe(0);
    expect(event?.summary?.pending).toBe(1);
    expect(event?.summary?.passed).toBe(2);
    expect(event?.summary?.passed).not.toBe(3); // the defect's N+1 reading
  });

  test("§S2: the printed run: envelope block for the repro carries pending:1 alongside passed:2/failed:0/total:3", () => {
    const block = extractRunBlock(runResult?.stdout ?? "");
    expect(block).toBeDefined();
    expect(block).toContain("passed: 2");
    expect(block).toContain("failed: 0");
    expect(block).toContain("total: 3");
    expect(block).toContain("pending: 1");
  });
});
