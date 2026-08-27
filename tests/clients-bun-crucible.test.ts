// CR-CRU-008 C2 — clients/bun-crucible.py v2 contract (RED).
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md — §S2 script fleet
// upgrade (v2 endpoints, tier, git/wave/orchestrator/cycle context) + the
// plan-verbs paragraph (plan-file/cycle-activate/cycle-done/cr-close,
// track from WORKFLOW_ROLE) + §S2c (failure-detail enrichment) + Risk
// section: "clients/ in-repo is the SOURCE OF TRUTH ... VERIFY tests run
// against clients/ copies." This cycle (C2) upgrades bun-crucible.py.
//
// Current state: `clients/bun-crucible.py` EXISTS in-repo and is exactly
// what these tests drive — every test below spawns `python3
// clients/bun-crucible.py ...` against a REAL test server. The in-repo
// `clients/` copy is the SOURCE OF TRUTH. The old
// `~/.claude/scripts/bun-crucible.py` mirror is RETIRED: do NOT run it,
// point tests at it, or treat it as the client source — running the mirror
// ORPHANS Crucible runs. (History, for context only: this file first landed
// as C2's RED, when the client did not exist on the branch yet and every
// spawn failed with `python3` exit 2 "can't open file"; the v1 script was
// then copied into `clients/` and upgraded there by GREEN. That is how the
// file began, not how it reads today.)
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
// §S2c ground truth — PROBED directly against real bun binaries, 1.3.14 AND
// 1.4.0, never assumed from the spec prose. TWO channels carry failure
// detail, and they drifted apart across those versions:
//
//   CONSOLE STREAM — IDENTICAL on 1.3.14 and 1.4.0 (diffed line-for-line,
//   modulo the version banner and durations):
//     - assertion mismatch / thrown Error: an "error: <detail>" block
//       appears IMMEDIATELY BEFORE the "(fail) <name>" line, e.g.:
//         error: expect(received).toBe(expected)
//         ...
//         (fail) mismatched expectation [0.12ms]
//     - a TIMEOUT's detail line ("  ^ this test timed out after Nms.") is
//       printed AFTER the "(fail) <name>" line instead — structurally NOT a
//       "preceding block". A marrying parser built to the spec's described
//       mechanism ("the error:/assertion block preceding each (fail) <name>
//       line") cannot associate it with that leaf, so the leaf degrades to
//       type-only. STILL TRUE on 1.4.0: bun did not move this line.
//
//   JUNIT REPORTER — CHANGED at 1.4.0, and THIS is what broke CI (run
//   33045758701), not the console format:
//     - bun 1.3.14 writes a BARE `<failure type="AssertionError"/>` (no
//       message attribute, no element text) for EVERY failure kind —
//       assertion mismatch, thrown Error AND timeout alike — so the console
//       stream is the ONLY detail source and §S2c marrying is the only
//       thing that can fill a leaf's `failure.message` in.
//     - bun 1.4.0 writes `message="..."` PLUS element text on `<failure>`
//       for every kind, including `message="test timed out"` on a
//       TimeoutError. `_parse_junit_file` lifts that straight off the XML
//       (correctly — richer reporter detail wins) and `_marry_failures`
//       then SKIPS the leaf, because it already carries a message. So on
//       1.4.0 a live timeout leaf is not an unmatched leaf at all, and its
//       message never passed through the marrying parser.
//
// Consequence for this file: the §S2c marrying CONTRACT — a matched leaf
// carries its own detail; a leaf whose detail CANNOT be matched degrades to
// type-only and NEVER inherits a neighbour's message — is pinned against
// FROZEN bytes (a captured console stream + a captured bare-node JUnit XML,
// fed through the real client via its `--bun` seam; see the "§S2c ... on
// FROZEN bytes" describe block below). The live-bun fixture keeps covering
// only what is version-stable: which leaves FAIL, and that a failing leaf
// carries its own detail from whichever channel supplied it.
//
// ATTRIBUTION, the live-fixture rule (CR-CRU-087 §S2/AC2). Because WHICH
// channel supplies a timed-out leaf's message is the runner's bun talking,
// the live assertions for that leaf pin ATTRIBUTION — it is `fail`, and any
// message it carries is its OWN — never the ABSENCE of a message, which was
// only ever an artifact of one bun's line ordering. The version-sensitive
// both-orderings fixture coverage (§S3/AC3) lives in
// tests/client/test_cr087_console_failure_attribution.py, where the real
// parser is fed both orderings directly instead of whichever one the
// installed bun happens to print — and, since CR-CRU-090, in the
// frozen-bytes describe at the foot of THIS file, which drives the real
// client end to end over the same immovable input.
//
// CROSS-LEAF BLEED, all three halves guarded now. A `(pass)`/`(skip)`/
// `(todo)` result line ends a pending detail block, and a block trailing
// its own `(fail)` line never marries BACKWARDS onto that leaf — both
// pinned in tests/client/test_cr087_console_failure_attribution.py. The
// FORWARD case — a detail block printed after its own leaf's `(fail)`
// line and before the NEXT leaf's, which bun 1.3.14 emits for a leaked
// async throw — was the one defect CR-CRU-087 left open, deliberately
// out of its scope and only characterised at the time. CR-CRU-088 §S1
// FIXED it in `clients/bun-crucible.py::_parse_console_failures`: a
// block is attributed to the test its source echo NAMES, and falls back
// to the positional rule only when the echo names no resolvable test. It
// is a real assertion now rather than a deferred candidate —
// `ForwardMarryingGuardTest` in that same python module, the six
// declaration shapes in
// tests/client/test_cr088_failure_detail_names_its_leaf.py, and the AC4
// E2E describes at the foot of THIS file.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const SCRIPT_PATH = join(import.meta.dir, "..", "clients", "bun-crucible.py");

// ── spawn + capture helpers ──────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `uv run clients/bun-crucible.py <args>`. Strips any ambient
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
    cmd: ["uv", "run", SCRIPT_PATH, ...args],
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

// CR-CRU-056 §S2b fixture-repair (C3): filters out "lifecycle" events
// (CR-CRU-011 §S1) — registerAgent()/ensureRegistered() calls now journal a
// registration lifecycle event of their own, which this file's count/id
// assertions must not fold into the real run/ingest events they pin.
async function getEvents(baseUrl: string, key: string): Promise<Array<{ id: string; kind?: string }>> {
  const res = await fetch(`${baseUrl}/api/v2/events?project=${key}`);
  const body = (await res.json()) as { events: Array<{ id: string; kind?: string }> };
  return body.events.filter((e) => e.kind !== "lifecycle");
}

/**
 * CR-CRU-056 §S2b fixture-repair (C3): /api/v2/runs/parsed (and every
 * ingesting verb) now refuses an unregistered agentId (409) — spawn the
 * script's own `register --role report` verb (needs no cycle binding) for
 * the SAME agentId a following `test`/`regression` runScript call will
 * ingest under, against the same fixture server.
 */
async function ensureRegistered(
  agentId: string,
  opts: { cwd: string; crucibleUrl: string; projectDir?: string },
): Promise<void> {
  await runScript(
    ["register", "--agent", agentId, "--role", "report", "--project-dir", opts.projectDir ?? opts.cwd],
    { cwd: opts.cwd, crucibleUrl: opts.crucibleUrl },
  );
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
// CR-CRU-056 §S2b fixture-repair (C3): plan-file/cycle-transition are
// mutating v2 workflow verbs and now refuse an unregistered caller (409) —
// register a fixture orchestrator for the project before either call.
async function ensureFixtureOrchestrator(baseUrl: string, key: string): Promise<void> {
  await fetch(`${baseUrl}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId: "fixture-orch", role: "ORCHESTRATOR" }),
  });
}

async function filePlan(baseUrl: string, key: string, cr: string): Promise<PlanWire> {
  await ensureFixtureOrchestrator(baseUrl, key);
  const res = await fetch(`${baseUrl}/api/v2/projects/${key}/plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cr, cycles: [{ label: "A" }, { label: "B" }], agentId: "fixture-orch" }),
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
  await ensureFixtureOrchestrator(baseUrl, key);
  await fetch(`${baseUrl}/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "active", agentId: "fixture-orch" }),
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

// 1 passing + 3 failing (mismatch, thrown-with-detail, timeout). The timeout
// leaf is NOT a stable "unmatched" case: bun ≤1.3.14 leaves its <failure>
// bare (detail unmatchable → type-only) while bun ≥1.4.0 stamps
// message="test timed out" on it (see the file header). On this LIVE fixture
// the leaf is therefore asserted by ATTRIBUTION rather than by absence of a
// message; the unmatched-leaf contract itself is pinned over FROZEN bytes in
// the frozen-stream describe below.
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

// CR-CRU-088 §S1/AC4 — the DEFECT shape, end to end. PROBED against the
// installed bun (1.3.14, 0d9b296a) rather than assumed: bun really does
// print the leaked throw's block BETWEEN the two `(fail)` lines, and its
// source echo names GAMMA, not delta:
//
//   3 | test("gamma leaks after failing", () => {
//   5 |   expect(1).toBe(2);
//   error: expect(received).toBe(expected)
//   (fail) gamma leaks after failing [0.12ms]
//   3 | test("gamma leaks after failing", () => {      ← names GAMMA
//   4 |   setTimeout(() => { throw new Error("leaked boom"); }, 5);
//   error: leaked boom
//   (fail) delta fails later [4.99ms]                  ← positionally married HERE
//
// The junit XML carries two bare `<failure type="AssertionError"/>` nodes,
// so BOTH leaves depend entirely on console marrying for their detail —
// which is why the defect reached the ingested tree.
//
// The real `setTimeout`/`await` below are the SUT's INPUT, not this suite's
// own timing: the defect only exists because a throw ESCAPES its test body
// into a later test's window, which is a property of the real event loop
// inside the spawned `bun test` child process. Fake timers cannot express
// it — there is no clock to advance from here, and a synchronous throw
// would simply be its own test's failure. The fixture is the §S1 reproducer
// verbatim, and the total delay is ~35ms inside one child process.
const FIXTURE_AFTERMATH_BLEED_SOURCE = `import { test, expect } from "bun:test";

test("gamma leaks after failing", () => {
  setTimeout(() => { throw new Error("leaked boom"); }, 5);
  expect(1).toBe(2);
});

test("delta fails later", async () => {
  await new Promise((r) => setTimeout(r, 30));
  expect(3).toBe(4);
});
`;

// CR-CRU-088 AC2/AC4 — the COMMON case, end to end: two consecutive
// failing leaves, each printing its OWN prelude block. The messages are
// deliberately DISTINCT strings (not two `expect(...).toBe(...)` blocks,
// whose first `error:` line is byte-identical) so a swap or a double-marry
// is visible in the stored tree instead of masked by equal text.
//
// PROBED on bun 1.3.14: zeta's own prelude echo WINDOW spans the test
// boundary and shows BOTH declarations —
//
//   3 | test("epsilon fails on its own", () => {
//   ...
//   7 | test("zeta fails on its own", () => {
//   8 |   throw new Error("zeta detail only");
//   error: zeta detail only
//   (fail) zeta fails on its own [0.04ms]
//
// — so this fixture is also the live guard for §S1 reading 1: taking the
// FIRST declaration in the window would read zeta's own prelude as
// epsilon's aftermath and blank zeta's message.
const FIXTURE_CONSECUTIVE_OWN_DETAIL_SOURCE = `import { test, expect } from "bun:test";

test("epsilon fails on its own", () => {
  throw new Error("epsilon detail only");
});

test("zeta fails on its own", () => {
  throw new Error("zeta detail only");
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

/**
 * Same extraction for the envelope's `  context:` block (CR-CRU-056 C5) —
 * key-order-independent, so an added `cycleId:` line is found wherever
 * `axi_context` places it.
 */
function extractContextBlock(stdout: string): string | undefined {
  const match = stdout.match(/ {2}context:\n((?: {4}.*\n)*)/);
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
    // CR-CRU-056 §S2/§S3c — RED (a TDD role) now REQUIRES an explicit
    // cycle binding; this test's subject (which endpoint/verb gets hit) is
    // unaffected, so a fixture plan+active-cycle is filed and reused (same
    // primitive as filePlan/activateCycle used elsewhere in this file).
    const plan = await filePlan(baseUrl, key, "CR-CRU-008-C2-register-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      [
        "register",
        "--agent",
        "a1",
        "--role",
        "RED",
        "--cycle",
        String(plan.cycles[0]!.id),
        "--project-dir",
        projectDir,
      ],
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
    // CR-CRU-056 §S2/§S3c — same reused fixture: RED needs a bound cycle
    // before this test's actual subject (the unregister verb/path) is
    // exercised.
    const plan = await filePlan(baseUrl, key, "CR-CRU-008-C2-unregister-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      [
        "register",
        "--agent",
        "a2",
        "--role",
        "RED",
        "--cycle",
        String(plan.cycles[0]!.id),
        "--project-dir",
        projectDir,
      ],
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

  test("register --agent X --role report succeeds and records the declared report role", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-role-optional");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(
      ["register", "--agent", "a3", "--role", "report", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    const agents = await getAgents(baseUrl, key);
    const agent = agents.find((a) => a.agentId === "a3");
    expect(agent).toBeDefined();
    // CR-CRU-044 §S3: `report` is the DECLARED role for a registration that
    // is not exercising a TDD role — it is no longer an implicit default
    // (--role is required), but it still round-trips the same way.
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

    // CR-CRU-056 §S3 — the `test` verb's own implicit agent-touch never
    // declares a role/cycle (it is a role-optional heartbeat, CR-CRU-044
    // §S1(a)); the server now stamps a run's context.cycleId ONLY from an
    // ALREADY-BOUND agent row (§S1/§S3). So the fixture agent is explicitly
    // pre-registered bound to the real active cycle before the wrapped `bun
    // test` run below — the auto-attach GUESS this describe block used to
    // rely on is gone; explicit binding is what makes context.cycleId
    // resolve to activeCycleId now.
    await runScript(
      [
        "register",
        "--agent",
        "cr-cru-008-c2-fixture-agent",
        "--role",
        "RED",
        "--cycle",
        String(activeCycleId),
        "--project-dir",
        dir,
      ],
      { cwd: dir, crucibleUrl: baseUrl },
    );

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

  test("CR-CRU-056 C5: the client's printed envelope context ECHOES the cycle the SERVER attached the run to — the agent learns where its evidence landed from the ingest output itself, with no follow-up GET /api/v2/events", () => {
    const context = extractContextBlock(runResult?.stdout ?? "");
    expect(context).toBeDefined();
    expect(context).toContain(`cycleId: ${activeCycleId}`);
    // The echo agrees with what the server actually stored...
    expect(event?.context?.cycleId).toBe(activeCycleId);
    // ...and it is an ECHO, never a client-side resolution: the client hit no
    // plans endpoint at all during this ingest (the deleted §S3 resolver's
    // only data source), so the id can only have come from the response.
    expect(proxy?.calls.some((c) => c.method === "GET" && c.path.includes("/plans"))).toBe(
      false,
    );
  });

  // Version-stable across BOTH probed bun versions, but via DIFFERENT
  // channels: on 1.3.14 these messages are §S2c console-married (the junit
  // <failure> nodes are bare), on 1.4.0 they are lifted from the reporter's
  // own `message=`. What is asserted here is the version-stable OUTCOME (a
  // failing leaf carries its own detail); the marrying MECHANISM is pinned
  // on frozen bytes in the block below.
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

  // The MESSAGE half of this leaf's original assertion is deliberately NOT
  // pinned on the live fixture: `failure.message` is absent on bun ≤1.3.14
  // (bare <failure>, detail unmatchable) and "test timed out" on bun ≥1.4.0
  // (reporter-supplied), so pinning either value pins a bun version — and an
  // `undefined`-OR-"test timed out" assertion would assert nothing while
  // hiding a real marrying regression. ATTRIBUTION is version-stable, so that
  // is what stays here; the unmatched-leaf MESSAGE contract is asserted over
  // frozen bytes in the "§S2c ... on FROZEN bytes" describe below.
  test("§S2c/AC2 (CR-CRU-087): the timed-out leaf is ATTRIBUTED, not asserted ABSENT — it is 'fail', and any message it carries is its OWN, never a neighbouring leaf's console detail", () => {
    const leaves = (event?.tree ?? []).flatMap((suite) => suite.children);
    const timedOut = leaves.find((l) => l.name === "times out unmatched");
    const mismatch = leaves.find((l) => l.name === "mismatched expectation");
    const thrown = leaves.find((l) => l.name === "throws with detail");
    expect(timedOut?.status).toBe("fail");

    // Whether the timeout's detail lands BEFORE or AFTER its own "(fail)"
    // line is the runner's bun talking (see the file header): 1.3.14 leaves
    // this leaf type-only, a newer bun hands it "test timed out". Both are
    // legal output, so the invariant pinned here is ATTRIBUTION — IF a
    // message is present it must be this leaf's own timeout detail, and in
    // particular must not be either neighbour's console block.
    const timeoutMessage = timedOut?.failure?.message;
    if (timeoutMessage !== undefined) {
      expect(timeoutMessage).toMatch(/tim(?:e|ed)\s*out/i);
      expect(timeoutMessage).not.toContain("expect(");
      expect(timeoutMessage).not.toContain("boom with detail");
      expect(timeoutMessage).not.toBe(mismatch?.failure?.message);
      expect(timeoutMessage).not.toBe(thrown?.failure?.message);
    }

    // The converse half of the same invariant — the half THIS bun does
    // exercise, since it is the timeout's detail that goes homeless here:
    // neither matched leaf absorbs it, and both keep exactly the messages
    // the preceding test asserts.
    expect(mismatch?.failure?.message ?? "").toContain("expect(");
    expect(mismatch?.failure?.message ?? "").not.toMatch(/tim(?:e|ed)\s*out/i);
    expect(thrown?.failure?.message ?? "").toContain("boom with detail");
    expect(thrown?.failure?.message ?? "").not.toMatch(/tim(?:e|ed)\s*out/i);
  });
});

// CR-CRU-088 AC4 — the fix holds END TO END. Every other assertion for this
// CR drives `_parse_console_failures` by direct import; these two describes
// run the REAL client over REAL `bun test` output, POST to
// /api/v2/runs/parsed, and read the STORED event back over HTTP, so what is
// asserted is what a reader of Crucible evidence actually sees.
//
// HONEST LABEL: this is a BACKFILL, not a RED — the production fix landed in
// C1, so these assertions passed on their first run. Their worth was proved
// by MUTATION instead: with the echo-name comparison dropped from
// `_parse_console_failures` (`if error_idx is not None and echo_name in
// (None, leaf):` → `if error_idx is not None:`, i.e. marrying positionally
// again), the run goes 29 pass / 1 fail — the AC4 assertion below failing on
// the `delta fails later` leaf with
//   error: expect(received).not.toContain(expected)   Received: "leaked boom"
// The file was then restored verbatim. RE-MEASURED after C3 restated that
// assertion as ATTRIBUTION rather than absence: same 29 pass / 1 fail, same
// leaf — the attribution form keeps the whole of the absence form's
// mutation-detecting power without pinning bun's line ordering.
describe("clients/bun-crucible.py — CR-CRU-088 AC4 (E2E): an aftermath block never reaches the NEXT leaf in the INGESTED tree", () => {
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
    const key = await createProject(baseUrl, "clients-bc-cr088-aftermath");
    const dir = scratchDir("bun-crucible-cr088-aftermath-");
    writeBunProjectWithSource(dir, key, FIXTURE_AFTERMATH_BLEED_SOURCE);
    await ensureRegistered("cr088-aftermath-agent", {
      cwd: dir,
      crucibleUrl: baseUrl,
      projectDir: dir,
    });

    runResult = await runScript(
      ["test", "--agent", "cr088-aftermath-agent", "--tests", "sample.test.ts", "--project-dir", dir, "--package-dir", dir],
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

  test("ground truth: the leaked throw's block and both '(fail)' lines are all present — and WHERE bun prints that block relative to them is OBSERVED and reported, never pinned", () => {
    const console_ = runResult?.stderr ?? "";
    const gammaFail = console_.indexOf("gamma leaks after failing [");
    const leaked = console_.indexOf("error: leaked boom");
    const deltaFail = console_.indexOf("delta fails later [");

    // Version-INDEPENDENT: both leaves fail and the leaked throw is reported
    // somewhere on the stream. Every bun that runs this fixture prints all
    // three.
    expect(gammaFail).toBeGreaterThan(-1);
    expect(leaked).toBeGreaterThan(-1);
    expect(deltaFail).toBeGreaterThan(-1);

    // Version-SENSITIVE, and so NOT asserted — the rule this file already
    // applies to the timed-out leaf above: WHICH ordering the runner's bun
    // prints is that bun's property, and CR-CRU-087 had to DELETE the one
    // assertion in this file that pinned bun's stream (it turned `test-bun`
    // red on a bun that reordered it and blocked every publish). The
    // defect's exact input shape is therefore observed and reported here,
    // and pinned fatally only over FROZEN BYTES — in
    // tests/client/test_cr088_failure_detail_names_its_leaf.py and
    // tests/client/test_cr087_console_failure_attribution.py, where no
    // installed bun can move it. The fix's own guarantee is asserted
    // version-independently in the next test.
    const orderingHolds = leaked > gammaFail && deltaFail > leaked;
    if (!orderingHolds) {
      console.log(
        "[CR-CRU-088 AC4] this bun does not print the aftermath shape " +
          `(gamma=${gammaFail}, leaked=${leaked}, delta=${deltaFail}); ` +
          "attribution below still holds, and the shape itself stays pinned " +
          "over frozen bytes in the two python modules.",
      );
    }
  });

  test("AC4: in the STORED tree the leaking leaf keeps its OWN message and gamma's aftermath reaches NOBODY — the following leaf carries no trace of 'leaked boom'", () => {
    expect(runResult?.code).not.toBe(0);
    expect(event?.summary?.total).toBe(2);
    expect(event?.summary?.failed).toBe(2);

    const leaves = (event?.tree ?? []).flatMap((suite) => suite.children);
    const gamma = leaves.find((l) => l.name === "gamma leaks after failing");
    const delta = leaves.find((l) => l.name === "delta fails later");

    // The producer keeps its own prelude detail.
    expect(gamma?.status).toBe("fail");
    expect(gamma?.failure?.message ?? "").toContain("expect(");
    expect(gamma?.failure?.message ?? "").not.toContain("leaked boom");

    // ATTRIBUTION, not ABSENCE (AC7, and the rule this file already applies
    // to the timed-out leaf above): gamma's aftermath must never reach
    // delta, but whether delta carries a message of its OWN is the runner's
    // bun talking — this bun prints no prelude block for delta, while a bun
    // that does would legitimately hand it delta's own `expect(3).toBe(4)`
    // detail. `toBeUndefined()` would pin that, and pinning bun's stream is
    // exactly what CR-CRU-087 had to delete. So: nothing of gamma's, and
    // anything present is delta's own.
    expect(delta?.status).toBe("fail");
    expect(delta?.failure?.message ?? "").not.toContain("leaked boom");
    expect(delta?.failure?.trace ?? "").not.toContain("leaked boom");
    const deltaMessage = delta?.failure?.message;
    if (deltaMessage !== undefined) {
      expect(deltaMessage).toContain("expect(");
      expect(deltaMessage).not.toContain("boom");
    }
  });
});

describe("clients/bun-crucible.py — CR-CRU-088 AC2/AC4 (E2E): two consecutive failing leaves each arrive with their OWN distinct message", () => {
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
    const key = await createProject(baseUrl, "clients-bc-cr088-consecutive");
    const dir = scratchDir("bun-crucible-cr088-consecutive-");
    writeBunProjectWithSource(dir, key, FIXTURE_CONSECUTIVE_OWN_DETAIL_SOURCE);
    await ensureRegistered("cr088-consecutive-agent", {
      cwd: dir,
      crucibleUrl: baseUrl,
      projectDir: dir,
    });

    runResult = await runScript(
      ["test", "--agent", "cr088-consecutive-agent", "--tests", "sample.test.ts", "--project-dir", dir, "--package-dir", dir],
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

  test("AC2/AC4: each leaf in the STORED tree carries its own detail — epsilon's is not zeta's, zeta's is not epsilon's, and neither is blank (the over-tightening regression the CR's Risk section names)", () => {
    expect(runResult?.code).not.toBe(0);
    expect(event?.summary?.total).toBe(2);
    expect(event?.summary?.failed).toBe(2);

    const leaves = (event?.tree ?? []).flatMap((suite) => suite.children);
    const epsilon = leaves.find((l) => l.name === "epsilon fails on its own");
    const zeta = leaves.find((l) => l.name === "zeta fails on its own");

    expect(epsilon?.status).toBe("fail");
    expect(zeta?.status).toBe("fail");

    // Present (not blanked by an over-tight "discard anything after a fail
    // line" rule)...
    expect(epsilon?.failure?.message).toBeDefined();
    expect(zeta?.failure?.message).toBeDefined();
    // ...each its OWN...
    expect(epsilon?.failure?.message ?? "").toContain("epsilon detail only");
    expect(zeta?.failure?.message ?? "").toContain("zeta detail only");
    // ...and not the other's, so neither a swap nor a double-marry hides
    // behind equal text.
    expect(epsilon?.failure?.message ?? "").not.toContain("zeta detail only");
    expect(zeta?.failure?.message ?? "").not.toContain("epsilon detail only");
    expect(epsilon?.failure?.message).not.toBe(zeta?.failure?.message);
  });
});

// ── §S2c on FROZEN bytes — the marrying parser, decoupled from bun ─────────
//
// CI run 33045758701 failed here because the unmatched-leaf assertion rode a
// LIVE bun run: bun 1.4.0's JUnit reporter started stamping
// `message="test timed out"` on TimeoutError nodes, so the leaf stopped
// being unmatched and the test's own premise evaporated (full two-version
// probe in the file header). Pinning CI's bun was tried and REVERTED
// (CR-CRU-087: a `packageManager` field routes npm through corepack, 958ms →
// 13082ms on the npm-pack test), so the fix is the other direction — stop
// asserting a PARSER contract on bytes a toolchain release owns.
//
// Seam (reused, not invented): the client's own `--bun` flag
// (`_resolve_bun`, clients/bun-crucible.py:120) driven by a FAKE bun binary —
// exactly the technique tests/clients-narration.test.ts already uses
// (`writeFakeAnsiTickBun` / `writeFakeEnvCaptureBun` + `--bun <script>`).
// The fake binary writes a frozen JUnit XML to whatever
// `--reporter-outfile=` the client passed and prints a frozen console
// stream, so the REAL client path runs end to end — `_run_logged` →
// `_parse_junit_file` → `_marry_failures` → POST /api/v2/runs/parsed — over
// bytes no bun release can move, and the assertions read the INGESTED tree,
// never a reimplementation of the parser. `--bun` beats $BUN_CRUCIBLE_BUN in
// `_resolve_bun`, so these runs are immune to that env var too.
//
// BOTH orderings are pinned, which is what CR-CRU-087's revert note asks
// for: a console-format FLIP must be caught by a failing assertion here
// instead of by pinning the toolchain.

// Captured VERBATIM (2026-08-27) from a real `bun test --reporter=junit` run
// of FIXTURE_TEST_SOURCE on bun 1.3.14 — BARE `<failure>` nodes, no message
// attribute and no element text, for all three failure kinds. This is the
// precondition of the §S2c contract: with this XML the console stream is the
// ONLY possible source of a leaf's failure.message, so a married message
// cannot be a reporter message in disguise. (bun 1.4.0 emits the same
// document with `message=` + element text added — the change under test.)
const FROZEN_BARE_JUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="2" failures="3" skipped="0" time="0.05815347">
  <testsuite name="sample.test.ts" file="sample.test.ts" tests="4" assertions="2" failures="3" skipped="0" time="0.05" hostname="AntoPC">
    <testcase name="adds numbers correctly" classname="" time="0.000058" file="sample.test.ts" line="3" assertions="1" />
    <testcase name="mismatched expectation" classname="" time="0.000081" file="sample.test.ts" line="7" assertions="1">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="throws with detail" classname="" time="0.000036" file="sample.test.ts" line="11" assertions="0">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="times out unmatched" classname="" time="0.050003" file="sample.test.ts" line="15" assertions="0">
      <failure type="TimeoutError" />
    </testcase>
  </testsuite>
</testsuites>
`;

// Captured VERBATIM (2026-08-27) alongside the XML above — the SAME run's
// combined stdout+stderr through a pipe, with CLAUDECODE/AGENT/REPL_ID/
// AI_AGENT unset exactly as `cmd_test` unsets them, so the `(pass)`/`(fail)`
// result-line family (the parser's block boundaries) is present. bun 1.4.0
// produces this document line-for-line, banner and durations aside — which
// is why freezing it costs no fidelity. Hand-typing was avoided on purpose:
// per CR-CRU-047 a hand-typed result line can validate a regex that matches
// ZERO real bun output.
//
// Ordering #1, the one bun actually emits: the timeout's detail line lands
// AFTER its `(fail)` line, so it is not a preceding block → UNMATCHED.
const FROZEN_STREAM_TIMEOUT_DETAIL_AFTER_FAIL = `bun test v1.3.14 (0d9b296a)

sample.test.ts:
(pass) adds numbers correctly [0.06ms]
3 | test("adds numbers correctly", () => {
4 |   expect(1 + 1).toBe(2);
5 | });
6 | 
7 | test("mismatched expectation", () => {
8 |   expect(1 + 1).toBe(3);
                    ^
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (/tmp/s2c-probe/sample.test.ts:8:17)
(fail) mismatched expectation [0.08ms]
 7 | test("mismatched expectation", () => {
 8 |   expect(1 + 1).toBe(3);
 9 | });
10 | 
11 | test("throws with detail", () => {
12 |   throw new Error("boom with detail");
                                         ^
error: boom with detail
      at <anonymous> (/tmp/s2c-probe/sample.test.ts:12:37)
(fail) throws with detail [0.04ms]
(fail) times out unmatched [50.00ms]
  ^ this test timed out after 50ms.

 1 pass
 3 fail
 2 expect() calls
Ran 4 tests across 1 file. [58.00ms]
`;

// Ordering #2 — the FLIP, and the only part of these fixtures that is not a
// verbatim capture: the captured stream above with the timeout's detail line
// RELOCATED into the preceding-`error:` position (the shape a future bun
// would emit if it moved that line, and the shape the parser's rule says
// MUST marry). Nothing else differs. If bun ever ships this ordering, the
// flip test below is what records the outcome — a failing assertion in this
// file, never a silently-changed message in the ingested tree.
const FROZEN_STREAM_TIMEOUT_DETAIL_BEFORE_FAIL = `bun test v1.3.14 (0d9b296a)

sample.test.ts:
(pass) adds numbers correctly [0.06ms]
3 | test("adds numbers correctly", () => {
4 |   expect(1 + 1).toBe(2);
5 | });
6 | 
7 | test("mismatched expectation", () => {
8 |   expect(1 + 1).toBe(3);
                    ^
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (/tmp/s2c-probe/sample.test.ts:8:17)
(fail) mismatched expectation [0.08ms]
 7 | test("mismatched expectation", () => {
 8 |   expect(1 + 1).toBe(3);
 9 | });
10 | 
11 | test("throws with detail", () => {
12 |   throw new Error("boom with detail");
                                         ^
error: boom with detail
      at <anonymous> (/tmp/s2c-probe/sample.test.ts:12:37)
(fail) throws with detail [0.04ms]
error: this test timed out after 50ms.
(fail) times out unmatched [50.00ms]

 1 pass
 3 fail
 2 expect() calls
Ran 4 tests across 1 file. [58.00ms]
`;

/**
 * A fake `bun` binary (same technique as clients-narration.test.ts's
 * `writeFakeAnsiTickBun`) that runs no tests at all: it writes
 * FROZEN_BARE_JUNIT_XML to whatever `--reporter-outfile=` the client passed
 * and prints `stream` verbatim, then exits 1 like a failing run. Everything
 * downstream of the subprocess — capture, junit parse, §S2c marrying,
 * ingest — is the real client.
 */
function writeFrozenStreamBun(path: string, stream: string): void {
  const lines = [
    "#!/bin/sh",
    'outfile=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --reporter-outfile=*) outfile="${arg#--reporter-outfile=}" ;;',
    "  esac",
    "done",
    "cat > \"$outfile\" <<'__FROZEN_JUNIT_XML__'",
    FROZEN_BARE_JUNIT_XML.trimEnd(),
    "__FROZEN_JUNIT_XML__",
    "cat <<'__FROZEN_CONSOLE_STREAM__'",
    stream.trimEnd(),
    "__FROZEN_CONSOLE_STREAM__",
    "exit 1",
    "",
  ];
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o755);
}

describe("clients/bun-crucible.py — §S2c failure-marrying contract on FROZEN bytes (no live bun in the assertion path)", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];
  let baseUrl = "";
  let detailAfterLeaves: EventLeaf[] = [];
  let detailBeforeLeaves: EventLeaf[] = [];

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  /** Drives one real `bun-crucible.py test` run whose ONLY input is frozen
   * bytes, and returns the leaves of the tree the server actually stored. */
  async function ingestFrozenStream(
    projectName: string,
    agentId: string,
    stream: string,
  ): Promise<EventLeaf[]> {
    const key = await createProject(baseUrl, projectName);
    const dir = scratchDir("bun-crucible-frozen-");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "clients-bun-crucible-frozen", version: "0.0.0", private: true }),
    );
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    // The client's own target resolution + `_prescan_test_total` read this
    // file; the fake bun never does — the frozen stream IS this run's output.
    writeFileSync(join(dir, "sample.test.ts"), FIXTURE_TEST_SOURCE);
    const fakeBun = join(dir, "frozen-stream-bun.sh");
    writeFrozenStreamBun(fakeBun, stream);
    await ensureRegistered(agentId, { cwd: dir, crucibleUrl: baseUrl, projectDir: dir });
    await runScript(
      [
        "test",
        "--agent",
        agentId,
        "--tests",
        "sample.test.ts",
        "--project-dir",
        dir,
        "--package-dir",
        dir,
        "--bun",
        fakeBun,
      ],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    const events = await getEvents(baseUrl, key);
    const event = events.length > 0 ? await getFullEvent(baseUrl, events[0]!.id) : undefined;
    return (event?.tree ?? []).flatMap((suite) => suite.children);
  }

  beforeAll(async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    baseUrl = `http://localhost:${handle.server.port}`;
    detailAfterLeaves = await ingestFrozenStream(
      "clients-bc-frozen-detail-after",
      "frozen-detail-after-agent",
      FROZEN_STREAM_TIMEOUT_DETAIL_AFTER_FAIL,
    );
    detailBeforeLeaves = await ingestFrozenStream(
      "clients-bc-frozen-detail-before",
      "frozen-detail-before-agent",
      FROZEN_STREAM_TIMEOUT_DETAIL_BEFORE_FAIL,
    );
  });

  afterAll(() => {
    handle?.stop();
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("MATCHED: a leaf whose `error:` block precedes its `(fail)` line carries that block's message AND its multi-line trace — which a bare-node junit XML could not have supplied", () => {
    const mismatch = detailAfterLeaves.find((l) => l.name === "mismatched expectation");
    const thrown = detailAfterLeaves.find((l) => l.name === "throws with detail");
    expect(mismatch?.status).toBe("fail");
    expect(mismatch?.failure?.message).toBe("expect(received).toBe(expected)");
    // Non-vacuity: the junit `<failure>` is bare, so a multi-line trace can
    // only have come off the console stream via §S2c marrying.
    expect(mismatch?.failure?.trace ?? "").toContain("Expected: 3");
    expect(mismatch?.failure?.trace ?? "").toContain("Received: 2");
    expect(thrown?.status).toBe("fail");
    expect(thrown?.failure?.message).toBe("boom with detail");
  });

  test("UNMATCHED: a leaf whose detail line falls AFTER its `(fail)` line degrades to type-only — no message at all, and NOTHING married off a neighbouring leaf", () => {
    const timedOut = detailAfterLeaves.find((l) => l.name === "times out unmatched");
    expect(timedOut?.status).toBe("fail");
    expect(timedOut?.failure?.message).toBeUndefined();
    // Type-only means the junit type SURVIVES — the leaf is not stripped of
    // its failure object, it simply gains no console detail.
    expect(timedOut?.failure?.type).toBe("TimeoutError");
    // The anti-smear half: the two leaves printed immediately before this one
    // both HAVE detail, and neither may bleed onto it through any field.
    const serialised = JSON.stringify(timedOut?.failure ?? {});
    expect(serialised).not.toContain("boom with detail");
    expect(serialised).not.toContain("expect(received)");
    expect(serialised).not.toContain("timed out");
  });

  test("ORDERING FLIP: with the SAME timeout leaf's detail relocated into a preceding `error:` block, it IS married — and only it (its neighbours keep their own messages)", () => {
    const timedOut = detailBeforeLeaves.find((l) => l.name === "times out unmatched");
    expect(timedOut?.status).toBe("fail");
    expect(timedOut?.failure?.message).toBe("this test timed out after 50ms.");
    const mismatch = detailBeforeLeaves.find((l) => l.name === "mismatched expectation");
    const thrown = detailBeforeLeaves.find((l) => l.name === "throws with detail");
    expect(mismatch?.failure?.message).toBe("expect(received).toBe(expected)");
    expect(thrown?.failure?.message).toBe("boom with detail");
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

  // CR-CRU-056 §S2b fixture-repair (C3): plan-file/cycle-activate/cycle-done/
  // cr-close each hard-stop client-side without a declared --agent, and the
  // server refuses an unregistered caller (409) — register a fixture
  // orchestrator identity first, then thread --agent <id> through every
  // verb invocation below.
  async function registerFixtureAgent(baseUrl: string, key: string, agentId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
    });
    expect(res.status).toBe(200);
  }

  test("plan-file creates an OPEN plan with the title, two cycles, and prints both numeric cycle ids on stdout", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-plan-file");
    const projectDir = fixtureProjectDir(key);
    await registerFixtureAgent(baseUrl, key, "plan-verb-agent");

    const res = await runScript(
      [
        "plan-file",
        "--cr",
        "CR-X-1",
        "--title",
        "Plan verbs C2",
        "--cycles",
        "cycle-a,cycle-b",
        "--agent",
        "plan-verb-agent",
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
    await registerFixtureAgent(baseUrl, key, "plan-verb-agent");

    const res = await runScript(
      ["plan-file", "--cr", "CR-X-2", "--cycles", "cycle-a,cycle-b", "--agent", "plan-verb-agent", "--project-dir", projectDir],
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
    await registerFixtureAgent(baseUrl, key, "plan-verb-agent");

    await runScript(
      ["plan-file", "--cr", "CR-X-3", "--cycles", "cycle-a,cycle-b", "--agent", "plan-verb-agent", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );
    const cycleId = (await getPlans(baseUrl, key))[0]!.cycles[0]!.id;

    const res = await runScript(
      ["cycle-activate", String(cycleId), "--agent", "plan-verb-agent", "--project-dir", projectDir],
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
    await registerFixtureAgent(baseUrl, key, "plan-verb-agent");

    await runScript(
      ["plan-file", "--cr", "CR-X-4", "--cycles", "cycle-a,cycle-b", "--agent", "plan-verb-agent", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );
    const cycleId = (await getPlans(baseUrl, key))[0]!.cycles[0]!.id;
    await runScript(["cycle-activate", String(cycleId), "--agent", "plan-verb-agent", "--project-dir", projectDir], {
      cwd: projectDir,
      crucibleUrl: baseUrl,
    });

    const res = await runScript(["cycle-done", String(cycleId), "--agent", "plan-verb-agent", "--project-dir", projectDir], {
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
    await registerFixtureAgent(baseUrl, key, "plan-verb-agent");
    await registerFixtureAgent(baseUrl, key, "test-agent");

    await runScript(
      ["plan-file", "--cr", "CR-X-5", "--cycles", "cycle-a,cycle-b", "--agent", "plan-verb-agent", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );
    const cycles = (await getPlans(baseUrl, key))[0]!.cycles;
    for (const cycle of cycles) {
      await runScript(["cycle-activate", String(cycle.id), "--agent", "plan-verb-agent", "--project-dir", projectDir], {
        cwd: projectDir,
        crucibleUrl: baseUrl,
      });
      await runScript(["cycle-done", String(cycle.id), "--agent", "plan-verb-agent", "--project-dir", projectDir], {
        cwd: projectDir,
        crucibleUrl: baseUrl,
      });
    }

    // CR-CRU-044 §S5 — cr-close POSTs a cr-merged milestone, so it needs a
    // DECLARED identity; there is no fabricated fallback any more.
    const res = await runScript(
      ["cr-close", "--commit", "abc1234", "--agent", "test-agent", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    const plans = await getPlans(baseUrl, key);
    expect(plans[0]!.status).toBe("closed");
    expect(plans[0]!.merge?.commit).toBe("abc1234");
  });
});

// ── CR-CRU-056 §S2/§S3/§S3c — the CR-036 client-side auto-attach resolver ──
// is DELETED; re-pointed from "no-active-cycle warns+withholds, no plan at
// all is tolerant" (the old client-side GUESS) into the new unconditional
// contract: a TDD-role (RED/GREEN/FIX/VERIFY) register with no explicit
// `--cycle` is REFUSED (409-style non-zero exit + structured `ok:false`
// envelope naming `--cycle`) regardless of whether a plan exists at all —
// there is no more "ambiguous" vs "tolerant" distinction because there is no
// more resolution attempt of any kind. `WORKFLOW_CYCLE_ID` is read by
// nobody (confirmed live: even a REAL, in-project, but pending cycle id
// sitting in that env var changes nothing) — the exact resolver mechanism
// this CR deletes.

describe("clients/bun-crucible.py — §S2 TDD-role register REQUIRES an explicit --cycle (supersedes the deleted CR-036 auto-attach resolver)", () => {
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

  test("register --role RED with an OPEN plan whose cycles are all PENDING (no active cycle) is REFUSED (non-zero exit, structured ok:false envelope naming --cycle), posts NO agent — a STALE WORKFLOW_CYCLE_ID pointing at a REAL cycle in this very plan changes NOTHING", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-CRU-036-NO-ACTIVE-CYCLE");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(
      ["register", "--agent", "bc-no-active-cycle-agent", "--role", "RED", "--project-dir", projectDir],
      // The deleted resolver's exact mechanism: a stale WORKFLOW_CYCLE_ID
      // pointing at a REAL (but pending) cycle in this very plan must not
      // rescue the registration — nobody reads this env var any more.
      { cwd: projectDir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    // POSITIVE — the structured envelope reports failure and names --cycle
    // as the fix (the server's 409 error passed through faithfully).
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("bc-no-active-cycle-agent");
  });

  test("register --role RED with NO open plan AT ALL is STILL refused the same way — the §S2 binding requirement is unconditional, not contingent on plan/cycle ambiguity (the old 'no plan, tolerant' escape hatch no longer exists)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-bc-tolerant-no-plan");
    const projectDir = fixtureProjectDir(key);

    const res = await runScript(
      ["register", "--agent", "bc-no-plan-agent", "--role", "RED", "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: baseUrl },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("bc-no-plan-agent");
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
    await ensureRegistered("regression-agent", { cwd: dir, crucibleUrl: baseUrl, projectDir: dir });

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
    // CR-CRU-056 (C5) RETARGET — this line previously asserted the OPPOSITE
    // (`.not.toContain`), pinning the anti-ghost cleanup's over-reach: the
    // agent here is pre-registered by `ensureRegistered` ABOVE, so deleting it
    // destroys a CALLER-owned registration (and, once §S1 put the cycle
    // binding on that row, the binding with it). The gated run now removes
    // only identities it created; a pre-registered caller survives.
    expect(await getAgentIds(baseUrl, key)).toContain("regression-agent");
  });
});

// ── CR-CRU-056 (C5) — the gated-run bracket must not destroy the CALLER's ──
// registration, because §S1 stores the cycle binding ON the agent row.
//
// Live failure this block is the regression test for (:3849, 2026-08-01):
//   register --agent vidushi --role ORCHESTRATOR --cycle 152   → bound to 152
//   python-crucible.py regression --agent vidushi               → stamped 152 ✓
//   bun-crucible.py    regression --agent vidushi               → NO cycle    ✗
// The first gated run's `finally` silently unregistered `vidushi`, taking the
// binding with it; the second run's identity was re-created unbound and its
// evidence landed off the cycle card — the exact failure this CR exists to
// prevent, reintroduced by the CR's own new surface.

describe("clients/bun-crucible.py — CR-CRU-056 (C5): a gated run removes only the identity it CREATED", () => {
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

  /** Seeds project → open plan → ACTIVE cycle, and a fixture bun package. */
  async function seedBoundFixture(name: string): Promise<{
    baseUrl: string;
    key: string;
    dir: string;
    cycleId: number;
  }> {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, name);
    const plan = await filePlan(baseUrl, key, `CR-CRU-056-${name}`);
    const cycleId = plan.cycles[0]!.id;
    await activateCycle(baseUrl, key, plan.planId, cycleId);
    const dir = scratchDir("bun-crucible-c5-");
    writeFixtureBunProject(dir, key);
    return { baseUrl, key, dir, cycleId };
  }

  /** Registers `agentId` BOUND to `cycleId` through the script's own verb. */
  async function registerBound(
    agentId: string,
    cycleId: number,
    opts: { cwd: string; crucibleUrl: string },
  ): Promise<void> {
    const res = await runScript(
      ["register", "--agent", agentId, "--role", "ORCHESTRATOR",
       "--cycle", String(cycleId), "--project-dir", opts.cwd],
      opts,
    );
    expect(res.code).toBe(0);
  }

  async function boundCycleOf(baseUrl: string, key: string, agentId: string): Promise<number | undefined> {
    const res = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
    const body = (await res.json()) as { agents: Array<{ agentId: string; boundCycleId?: number }> };
    return body.agents.find((a) => a.agentId === agentId)?.boundCycleId;
  }

  // (a) THE regression test for the live defect.
  test("a pre-registered BOUND agent survives a gated run with its binding intact, and a SECOND consecutive gated run still ingests stamped to that same cycle", async () => {
    const { baseUrl, key, dir, cycleId } = await seedBoundFixture("clients-bc-c5-consecutive");
    await registerBound("bc-c5-bound-agent", cycleId, { cwd: dir, crucibleUrl: baseUrl });
    expect(await boundCycleOf(baseUrl, key, "bc-c5-bound-agent")).toBe(cycleId);

    const first = await runScript(
      ["test", "--agent", "bc-c5-bound-agent", "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    // The fixture package fails 3 of 4 tests — the RUNNER verdict, not the
    // bracket's; what matters here is that the ingest landed and attached.
    expect(first.code).toBe(1);

    // The caller's registration AND its binding must still be standing.
    expect(await getAgentIds(baseUrl, key)).toContain("bc-c5-bound-agent");
    expect(await boundCycleOf(baseUrl, key, "bc-c5-bound-agent")).toBe(cycleId);

    const second = await runScript(
      ["test", "--agent", "bc-c5-bound-agent", "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    expect(second.code).toBe(1);

    // BOTH stored events carry the cycle — the second is the one that landed
    // cycle-less before this fix.
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(2);
    const stamped = await Promise.all(events.map((e) => getFullEvent(baseUrl, e.id)));
    expect(stamped.map((e) => e.context?.cycleId)).toEqual([cycleId, cycleId]);
  });

  // (b) The anti-ghost purpose (CR-CRU-021 §S5) is PRESERVED, not weakened.
  test("an identity the gated run itself created is still silently removed afterward (anti-ghost preserved)", async () => {
    const { baseUrl, key, dir, cycleId } = await seedBoundFixture("clients-bc-c5-antighost");

    const res = await runScript(
      ["test", "--agent", "bc-c5-run-created", "--cycle", String(cycleId),
       "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    expect(res.code).toBe(1);

    // The run brought this row into being, so the run takes it away — no
    // lingering online ghost on the agent rail.
    expect(await getAgentIds(baseUrl, key)).not.toContain("bc-c5-run-created");
    // ...and the removal stays SILENT: no 'unregistered' lifecycle event that
    // would bury the run just ingested (CR-CRU-011 §S1 / CR-CRU-008 §S4).
    const all = await fetch(`${baseUrl}/api/v2/events?project=${key}`);
    const allBody = (await all.json()) as { events: Array<{ kind?: string; agentId?: string }> };
    expect(
      allBody.events.filter((e) => e.kind === "lifecycle" && e.agentId === "bc-c5-run-created").length,
    ).toBe(1); // the creation only — never a matching 'unregistered'
  });

  // (c) `--cycle` passthrough — the register-inside-the-run case.
  test("--cycle on a gated verb BINDS a run-created registration, so its evidence attaches without a separate `register` call", async () => {
    const { baseUrl, key, dir, cycleId } = await seedBoundFixture("clients-bc-c5-passthrough");

    const res = await runScript(
      ["test", "--agent", "bc-c5-cycle-passthrough", "--cycle", String(cycleId),
       "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    expect(res.code).toBe(1);

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context?.cycleId).toBe(cycleId);
    // The envelope echoes the attachment the server applied (C5's echo).
    expect(extractContextBlock(res.stdout)).toContain(`cycleId: ${cycleId}`);
  });

  test("a gated run WITHOUT --cycle never invents one for a run-created identity — no client-side cycle resolution survives (§S3)", async () => {
    const { baseUrl, key, dir } = await seedBoundFixture("clients-bc-c5-no-invention");

    // An ACTIVE cycle exists on this project — the deleted resolver would
    // have silently picked it. An unbound run-created agent must attach to
    // NOTHING instead.
    const res = await runScript(
      ["test", "--agent", "bc-c5-unbound", "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    expect(res.code).toBe(1);

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context?.cycleId).toBeUndefined();
    expect(await getAgentIds(baseUrl, key)).not.toContain("bc-c5-unbound");
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
    await ensureRegistered("cr050-mixed-agent", { cwd: dir, crucibleUrl: baseUrl, projectDir: dir });

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

  // §S2 (extended after C1 GREEN) — the plain human-readable "ingest: ..."
  // stderr line (bun-crucible.py:721-726) prints passed/failed/total but NOT
  // pending. C1 GREEN correctly declined to touch this untested surface and
  // escalated it instead — this is that RED. Post-fix the line must read
  // "passed=1 failed=1 pending=2 total=4"; today it omits pending entirely,
  // so "passed=1 failed=1 total=4" no longer sums (2 tests unaccounted for),
  // which is the exact "worse than an under-report" artifact the CR warns
  // about.
  test("§S2 (extended): the plain 'ingest: ...' stderr line also carries pending=2, not just the TOON run: block", () => {
    expect(runResult?.stderr ?? "").toContain("ingest:");
    expect(runResult?.stderr ?? "").toContain("pending=2");
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
    await ensureRegistered("cr050-repro-agent", { cwd: dir, crucibleUrl: baseUrl, projectDir: dir });

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
