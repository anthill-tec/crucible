// CR-CRU-008 C5 — §S2b in-run progress narration across stacks (RED).
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md §S2b — "While a runner
// executes, the wrapping script TAILS its output and posts throttled
// heartbeats (`message: "running 214/385 · <current file>"`) so the
// Project pane's agent row narrates live progress — no new API (the
// `message` field was built for narration)." Per-stack granularity: bun →
// per-test/file fine-grained counter; maven surefire → per-CLASS "Running
// …/Tests run:" lines → class-level counter. Throttle: update at most every
// 2s (or every 10 completions) so heartbeat traffic stays negligible. On
// completion the final ingest replaces the narration. AC (spec Acceptance
// criteria list): "during a wrapped `bun-crucible.py test` run of ≥20 tests,
// the agent's `message` (polled via GET agents) changes at least once to a
// `running N/M` narration before the final ingest, and updates are
// throttled (≤1 per 2s asserted from the poll log); `mvn-crucible.py`
// narrates at class granularity (fixture with ≥3 classes)."
//
// Ground truth read directly from src/v2.ts (NOT assumed) before writing
// these tests:
//   - `message` already exists on the wire today: handleAgentTouch (v2.ts:296)
//     accepts an arbitrary `message: string` on BOTH register and heartbeat
//     (same route, "/api/v2/agents/register" OR "/api/v2/agents/heartbeat" —
//     v2.ts:1059) and stores it via `store.touchAgent(...opts)`. So narration
//     needs NO new API — confirms the spec's "no new API" claim; these tests
//     exercise the CLIENT side only (clients/bun-crucible.py,
//     clients/mvn-crucible.py), never src/v2.ts.
//   - Lifecycle-event journaling ground truth (v2.ts:306-323): `const existed
//     = store.hasAgent(...)`; `if (!existed) store.recordLifecycleEvent(...,
//     "registered")`. A repeat register/heartbeat call against an ALREADY
//     existing agent id does NOT journal a lifecycle event today — this is
//     the correct, already-shipped behavior the narration mechanism must
//     keep riding (item 3 below pins it as a regression guard, not a
//     blocker: repeated calls already fail to journal).
//   - `GET /api/v2/events` (handleEventsList, v2.ts:931 → eventBrief,
//     v2.ts:891) returns EVERY event kind mixed together — `kind: "test" |
//     "compile" | "lifecycle"` sits right on the brief — so a test can
//     filter `events.filter(e => e.kind === "lifecycle")` without reading
//     any per-kind endpoint.
//
// RED phase: `clients/bun-crucible.py` and `clients/mvn-crucible.py` EXIST
// on this branch (C2/C3/C4 landed already) but carry NO narration mechanism
// at all — `cmd_test`'s `_run_logged` (bun-crucible.py) and
// `_run_surefire_tier`'s `_run_logged` (mvn-crucible.py) both either run the
// subprocess with inherited stdio (no capture) or capture the ENTIRE run's
// combined output only after the process exits; neither script explicitly
// registers the agent before the run nor posts any heartbeat DURING the
// run. So every test below polls the real agent state through a full run
// and observes zero "running N/M" messages ever — a genuine behavioral RED
// (the files exist; the described behavior does not), never a compile or
// import error.
//
// Contract PINNED here (not fully dictated by the spec prose — the RED
// phase designs the exact, testable form per the dispatch prompt):
//   - bun narration message form: `running <N>/<M>` (fine-grained,
//     completions-based), where M is the fixture's total test count.
//   - mvn narration message form: `running class <N>/<M>` (class-level),
//     where M is the fixture's total class count.
//   - throttle bound asserted from the poll log: for every pair of
//     ADJACENT DISTINCT narration values observed, either ≥ ~2s elapsed
//     between them, OR the completions counter advanced by ≥ 10 — the
//     literal "every 2s (or every 10 completions)" reading. A 1900ms floor
//     (not a strict 2000ms) tolerates minor scheduling jitter without
//     weakening the throttle's intent.
//   - "first throttle window" contract (item 4): a run that finishes before
//     BOTH bounds are ever crossed (under ~2s wall time AND under 10
//     completions) must show ZERO narration messages — narration doesn't
//     fire eagerly on test #1.
//
// Technique: reused from tests/clients-bun-crucible.test.ts /
// tests/clients-rust-mvn-crucible.test.ts — a real `startServer({port:0,
// dbPath:":memory:"})` + `Bun.spawn`, plus the CAPTURING PROXY for the one
// test that must pin the exact endpoint hit. NEW here: `spawnScript` does
// NOT await completion — it hands back the raw `Bun.Subprocess` so a
// concurrent poll loop can sample `GET /api/v2/agents` on an interval WHILE
// the wrapped runner subprocess is still executing.
//
// Toolchain-free fixture strategy for mvn (mirrors C3 exactly): a fake
// `mvnw` is a plain shell script (never touches the filesystem), so
// pre-placed surefire XML fixtures are exactly what a real `mvn clean test`
// would have produced. UNLIKE C3's `NOOP_SCRIPT` (instant no-op exit), this
// fixture's fake `mvnw` STREAMS "Running <class>" / "Tests run: ..." lines
// with real `sleep` calls between them — the narration wrapper has
// something to tail live, and the run spans long enough to cross the
// throttle's time bound at least once.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

const BUN_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "bun-crucible.py");
const MVN_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "mvn-crucible.py");

// ── spawn / proxy / scratch plumbing (reused verbatim from C2/C3) ──────────

interface ProxyCall {
  method: string;
  path: string;
}

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

/**
 * Spawns `uv run <scriptPath> <args>` WITHOUT awaiting completion — hands
 * back the raw `Bun.Subprocess` so callers can poll live agent state
 * concurrently with the run. Strips ambient WORKFLOW_* env; always injects
 * CRUCIBLE_URL.
 */
function spawnScript(
  scriptPath: string,
  args: string[],
  opts: { cwd: string; crucibleUrl: string; env?: Record<string, string | undefined> },
) {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  return Bun.spawn({
    cmd: ["uv", "run", scriptPath, ...args],
    cwd: opts.cwd,
    env: { ...baseEnv, CRUCIBLE_URL: opts.crucibleUrl, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * CR-CRU-047 §S3 — identical to `spawnScript` except it explicitly DELETES
 * `CLAUDECODE` from the child's environment rather than merging an override
 * on top. `spawnScript`'s `env` option can only ADD/override keys with a
 * string value; it cannot remove a key the ambient session already set
 * (this session runs with `CLAUDECODE=1`). The two narration-under-both-
 * states tests need a genuine unset, not "unset unless already set".
 */
function spawnScriptWithClaudecodeUnset(
  scriptPath: string,
  args: string[],
  opts: { cwd: string; crucibleUrl: string },
) {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  delete baseEnv.CLAUDECODE;
  return Bun.spawn({
    cmd: ["uv", "run", scriptPath, ...args],
    cwd: opts.cwd,
    env: { ...baseEnv, CRUCIBLE_URL: opts.crucibleUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function makeScratchTracker(): { dir(prefix: string): string; cleanup(): void } {
  const dirs: string[] = [];
  return {
    dir(prefix: string): string {
      const d = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
    cleanup(): void {
      while (dirs.length > 0) {
        rmSync(dirs.pop()!, { recursive: true, force: true });
      }
    },
  };
}

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// ── server-facing helpers ──────────────────────────────────────────────────

async function createProject(baseUrl: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v2/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as { project: { key: string } };
  return body.project.key;
}

interface AgentWire {
  agentId: string;
  message?: string;
}

async function getAgents(baseUrl: string, key: string): Promise<AgentWire[]> {
  const res = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
  const body = (await res.json()) as { agents: AgentWire[] };
  return body.agents;
}

interface EventBrief {
  id: string;
  agentId: string;
  kind: string;
}

async function getEventsBrief(baseUrl: string, key: string): Promise<EventBrief[]> {
  const res = await fetch(`${baseUrl}/api/v2/events?project=${key}`);
  const body = (await res.json()) as { events: EventBrief[] };
  return body.events;
}

// ── poll harness: samples agent state on an interval WHILE the wrapped
// runner subprocess is still executing ─────────────────────────────────────

interface PollSample {
  t: number;
  message: string | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `GET /api/v2/agents` every `intervalMs` until `isDone()` flips true,
 * recording (timestamp, message) for `agentId` each time (message is
 * `undefined` when the agent is absent — e.g. after the gate-run's silent
 * cleanup). Takes one FINAL sample immediately after `isDone()` flips, to
 * capture the post-run state (narration replaced / agent removed).
 */
async function pollAgentUntil(
  baseUrl: string,
  key: string,
  agentId: string,
  isDone: () => boolean,
  intervalMs = 200,
): Promise<PollSample[]> {
  const log: PollSample[] = [];
  while (!isDone()) {
    const agents = await getAgents(baseUrl, key);
    log.push({ t: Date.now(), message: agents.find((a) => a.agentId === agentId)?.message });
    await sleep(intervalMs);
  }
  const agentsAfter = await getAgents(baseUrl, key);
  log.push({ t: Date.now(), message: agentsAfter.find((a) => a.agentId === agentId)?.message });
  return log;
}

// ── narration parsing + throttle assertion ─────────────────────────────────

const NARRATION_RE = /running (\d+)\/(\d+)/;
const CLASS_NARRATION_RE = /running class (\d+)\/(\d+)/;

interface NarrationPoint {
  t: number;
  n: number;
  m: number;
}

function extractNarration(log: PollSample[], re: RegExp): NarrationPoint[] {
  const out: NarrationPoint[] = [];
  for (const sample of log) {
    if (!sample.message) continue;
    const match = re.exec(sample.message);
    if (match) out.push({ t: sample.t, n: Number(match[1]), m: Number(match[2]) });
  }
  return out;
}

/** Collapses consecutive samples carrying the SAME `n` into one entry per
 * distinct narration value observed, keeping the first timestamp it was
 * seen at — this is what the throttle bound below is measured across. */
function distinctNarrationValues(matches: NarrationPoint[]): NarrationPoint[] {
  const distinct: NarrationPoint[] = [];
  for (const entry of matches) {
    const last = distinct[distinct.length - 1];
    if (last === undefined || last.n !== entry.n) distinct.push(entry);
  }
  return distinct;
}

/** Every pair of adjacent DISTINCT narration values must be ≥ minMs apart in
 * wall time OR ≥ minCompletions apart in the completions counter — the
 * "update at most every 2s (or every 10 completions)" throttle, read
 * literally. Vacuously true with 0 or 1 distinct values (nothing to space out). */
function assertThrottled(distinct: NarrationPoint[], minMs: number, minCompletions: number): void {
  for (let i = 1; i < distinct.length; i++) {
    const dt = distinct[i]!.t - distinct[i - 1]!.t;
    const dn = distinct[i]!.n - distinct[i - 1]!.n;
    expect(dt >= minMs || dn >= minCompletions).toBe(true);
  }
}

// ── bun fixture: N trivial tests, each optionally sleeping `sleepMs` ───────

function writeNarrationBunProject(dir: string, key: string, count: number, sleepMs: number): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "clients-narration-bun-fixture", version: "0.0.0", private: true }),
  );
  const body = Array.from({ length: count }, (_, i) => {
    const delay = sleepMs > 0 ? `  await sleep(${sleepMs});\n` : "";
    return `test("narration fixture test ${i + 1}", async () => {\n${delay}  expect(${i} + 1).toBe(${i + 1});\n});`;
  }).join("\n\n");
  writeFileSync(
    join(dir, "narration.test.ts"),
    `import { test, expect } from "bun:test";\n\n` +
      `function sleep(ms: number): Promise<void> {\n` +
      `  return new Promise((resolve) => setTimeout(resolve, ms));\n}\n\n${body}\n`,
  );
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
}

// ── mvn fixture: a streaming fake `mvnw` over ≥3 classes + pre-placed XML ──

const STREAMING_MVNW_SCRIPT = `#!/bin/sh
echo "Running com.acme.AlphaTest"
sleep 1.0
echo "Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.0 sec - in com.acme.AlphaTest"
sleep 0.3
echo "Running com.acme.BravoTest"
sleep 1.0
echo "Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.0 sec - in com.acme.BravoTest"
sleep 0.3
echo "Running com.acme.CharlieTest"
sleep 1.0
echo "Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.0 sec - in com.acme.CharlieTest"
exit 0
`;

function writeJunitXmlClass(path: string, className: string, passCount: number): void {
  const cases = Array.from({ length: passCount }, (_, i) => `<testcase name="test${i + 1}" time="0.01"/>`).join("");
  writeFileSync(
    path,
    `<?xml version="1.0"?><testsuite name="${className}" tests="${passCount}">${cases}</testsuite>`,
  );
}

function writeMvnNarrationFixture(dir: string, key: string): void {
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
  writeExecutable(join(dir, "mvnw"), STREAMING_MVNW_SCRIPT);
  const reportsDir = join(dir, "target", "surefire-reports");
  mkdirSync(reportsDir, { recursive: true });
  writeJunitXmlClass(join(reportsDir, "TEST-com.acme.AlphaTest.xml"), "com.acme.AlphaTest", 2);
  writeJunitXmlClass(join(reportsDir, "TEST-com.acme.BravoTest.xml"), "com.acme.BravoTest", 2);
  writeJunitXmlClass(join(reportsDir, "TEST-com.acme.CharlieTest.xml"), "com.acme.CharlieTest", 2);
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("§S2b in-run progress narration — clients/bun-crucible.py (fine-grained running N/M)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test(
    "a 24-test bun run (120ms sleeps, spans ~2.9s) narrates 'running N/M' heartbeats polled via GET /api/v2/agents BEFORE the final ingest, throttled (≥~2s or ≥10 completions apart)",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-bun-fine");
      const dir = scratch.dir("narration-bun-fine-");
      writeNarrationBunProject(dir, key, 24, 120);
      const agentId = "narration-bun-fine-agent";

      let done = false;
      const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done);
      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        ["test", "--agent", agentId, "--tests", "narration.test.ts", "--project-dir", dir, "--package-dir", dir],
        { cwd: dir, crucibleUrl: baseUrl },
      );
      const [, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      done = true;
      const log = await pollPromise;

      expect(code).toBe(0); // all 24 fixture tests pass

      const matches = extractNarration(log, NARRATION_RE);
      // The core AC: at least one polled message showed "running N/M" DURING
      // the run — narration observed strictly before the process (and thus
      // its final ingest) completed, since polling stops the instant the
      // process exits.
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.m).toBe(24);

      const distinct = distinctNarrationValues(matches);
      assertThrottled(distinct, 1900, 10);

      // After completion: either silently removed (gate-run cleanup) or, if
      // still present, no longer showing a "running N/M" narration — the
      // final ingest verdict has replaced it.
      const finalSample = log[log.length - 1]!;
      if (finalSample.message !== undefined) {
        expect(NARRATION_RE.test(finalSample.message)).toBe(false);
      }
    },
    20000,
  );

  test(
    "narration heartbeats never leak into the script's own stdout, and never journal MORE than the one 'registered' lifecycle event however many heartbeats fired",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-bun-purity");
      const dir = scratch.dir("narration-bun-purity-");
      writeNarrationBunProject(dir, key, 20, 130);
      const agentId = "narration-bun-purity-agent";
      const proxy = startCapturingProxy(baseUrl);

      try {
        let done = false;
        const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done);
        const proc = spawnScript(
          BUN_SCRIPT_PATH,
          ["test", "--agent", agentId, "--tests", "narration.test.ts", "--project-dir", dir, "--package-dir", dir],
          { cwd: dir, crucibleUrl: proxy.url },
        );
        const [stdout, , code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        done = true;
        const log = await pollPromise;

        expect(code).toBe(0);
        const matches = extractNarration(log, NARRATION_RE);
        // Non-vacuous precondition: narration DID occur, so the purity/event
        // invariants below are actually exercised, not trivially satisfied.
        expect(matches.length).toBeGreaterThan(0);

        // stdout purity: the narration text itself never appears in the
        // script's OWN captured stdout — heartbeats ride the HTTP POST body
        // only, never echoed to the data pipe.
        expect(NARRATION_RE.test(stdout)).toBe(false);

        // Evidence of periodic heartbeats hitting the v2 endpoint (no new
        // API — CR-CRU-008 §S2b) — more than the single initial touch.
        // CR-CRU-044 §S1(a) split the two verbs: a narration tick is a
        // liveness ping, so it rides the phase-optional
        // /api/v2/agents/heartbeat and can never re-declare (or blank) the
        // phase the agent registered with. Tightened, not relaxed: the
        // heartbeat traffic is still required to be plural, AND narration is
        // now required NOT to masquerade as a re-registration.
        const heartbeatCalls = proxy.calls.filter(
          (c) => c.method === "POST" && c.path === "/api/v2/agents/heartbeat",
        );
        expect(heartbeatCalls.length).toBeGreaterThan(1);
        const registerCalls = proxy.calls.filter(
          (c) => c.method === "POST" && c.path === "/api/v2/agents/register",
        );
        expect(registerCalls.length).toBeLessThanOrEqual(1);

        // Yet the events journal gains NO MORE than the one 'registered'
        // lifecycle event for this agent — heartbeats against an agent that
        // already exists must never journal (v2.ts handleAgentTouch: `if
        // (!existed) recordLifecycleEvent(...)`).
        const events = await getEventsBrief(baseUrl, key);
        const lifecycleForAgent = events.filter((e) => e.agentId === agentId && e.kind === "lifecycle");
        expect(lifecycleForAgent.length).toBeLessThanOrEqual(1);
      } finally {
        proxy.stop();
      }
    },
    20000,
  );

  test(
    "a 5-test near-instant fixture (finishes well under BOTH throttle bounds — 2s wall time and 10 completions) shows ZERO 'running N/M' narration messages",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-bun-silent");
      const dir = scratch.dir("narration-bun-silent-");
      writeNarrationBunProject(dir, key, 5, 0);
      const agentId = "narration-bun-silent-agent";

      let done = false;
      const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done, 100);
      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        ["test", "--agent", agentId, "--tests", "narration.test.ts", "--project-dir", dir, "--package-dir", dir],
        { cwd: dir, crucibleUrl: baseUrl },
      );
      const [, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      done = true;
      const log = await pollPromise;

      expect(code).toBe(0);
      expect(extractNarration(log, NARRATION_RE).length).toBe(0);
    },
    15000,
  );
});

// ── CR-CRU-047 §S3 — SECOND PASS. `--dots` is WITHDRAWN. ───────────────────
//
// ROOT CAUSE, corrected (2026-07-28, read this before the tests below).
// `clients/bun-crucible.py:712`/`:784` ALREADY `env.pop("CLAUDECODE", None)`
// before running the wrapped `bun test` — the client already defends itself
// against bun's agent-quieting. The remaining gap is narrower: only
// `CLAUDECODE` is popped, not `AGENT`/`REPL_ID` (also agent-quieting
// triggers). So the ONLY real defect is Fault 1 — `_COMPLETION_LINE`
// (`^\((?:pass|fail|skip|todo)\)`) matches bun's OLD parenthesized
// completion-line format; bun 1.3.14 emits `✓ <name>` / `✗ <name>` instead,
// and — the trap — ANSI-colourised even through a pipe:
//   \x1b[0m\x1b[32m\xe2\x9c\x93\x1b[0m \x1b[0m<name>
// An anchored `^✓` (no escape tolerance) is the SAME bug with new spelling —
// it matches zero real bun output. `--dots` is WITHDRAWN as the fix: it
// carries no newlines (forcing character-level reading, breaking §S2c's
// byte-identical stdout capture) and — measured — bun emits NO dot for a
// FAILING test, so a dot count silently under-reports on exactly the runs
// that matter. The fix is: make `_COMPLETION_LINE` ANSI-tolerant, and add
// `AGENT`/`REPL_ID` to the existing `env.pop` at both call sites.
//
// Technique, unchanged from the first pass: pin the contract from the
// client's OBSERVABLE behavior only — the stderr echo of the built
// invocation, the junit file actually on disk, and the narration signal
// itself — never by importing Python internals into a bun test (the SUT
// stays a subprocess wrapper here, same as the rest of this file). The
// anti-trap and env-strip tests below drive the REAL `clients/bun-crucible.py`
// against a FAKE `bun` binary (mirrors the fake `mvnw` technique already
// used in this file) so the fixture bytes are fully controlled while the
// client's own subprocess-wrapper contract stays real.

// Captured VERBATIM (2026-07-28) from a real `bun test` v1.3.14 run with
// CLAUDECODE/AGENT/REPL_ID unset, redirected to a file, on a throwaway
// 2-test fixture (one passing, one failing) — NOT hand-typed. This is
// exactly the trap CR-CRU-047 documents: a hand-typed bare `✓`/`✗` would
// falsely validate a regex that matches ZERO real bun output.
const REAL_BUN_PASS_LINE =
  "\x1b[0m\x1b[32m✓\x1b[0m\x1b[0m\x1b[1m a passing sample test\x1b[0m \x1b[0m\x1b[2m[0.06ms\x1b[0m\x1b[2m]\x1b[0m";
const REAL_BUN_FAIL_LINE =
  "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m a failing sample test\x1b[0m \x1b[0m\x1b[2m[0.12ms\x1b[0m\x1b[2m]\x1b[0m";

/**
 * A fake `bun` binary (same technique as `STREAMING_MVNW_SCRIPT` above) that
 * never runs real tests — it streams the REAL captured ANSI tick lines
 * above (2× pass, 2× fail) with real `sleep` gaps so the client's 2s
 * throttle fires twice, and writes a matching junit XML to whatever
 * `--reporter-outfile=` the client passed. This isolates the
 * completion-line MATCHING contract from bun's own live behavior
 * (version/terminal-detection drift) while still driving the real
 * `clients/bun-crucible.py` subprocess wrapper end-to-end.
 */
function writeFakeAnsiTickBun(path: string): void {
  const junitXml =
    '<?xml version="1.0"?><testsuite name="narration.test.ts" tests="4">' +
    '<testcase name="pass one" time="0.01"/>' +
    '<testcase name="pass two" time="0.01"/>' +
    '<testcase name="fail one" time="0.01"><failure message="expected 2 to be 3">AssertionError</failure></testcase>' +
    '<testcase name="fail two" time="0.01"><failure message="expected 2 to be 3">AssertionError</failure></testcase>' +
    "</testsuite>";
  const lines = [
    "#!/bin/sh",
    'outfile=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --reporter-outfile=*) outfile="${arg#--reporter-outfile=}" ;;',
    "  esac",
    "done",
    "cat > \"$outfile\" <<'JUNITXML'",
    junitXml,
    "JUNITXML",
    `printf '%s\\n' '${REAL_BUN_PASS_LINE}'`,
    "sleep 2.2",
    `printf '%s\\n' '${REAL_BUN_PASS_LINE}'`,
    `printf '%s\\n' '${REAL_BUN_FAIL_LINE}'`,
    "sleep 2.2",
    `printf '%s\\n' '${REAL_BUN_FAIL_LINE}'`,
    "sleep 2.5",
    "exit 1",
    "",
  ];
  writeExecutable(path, lines.join("\n"));
}

/**
 * A fake `bun` binary for the env-strip assertions (§S3 item C): it never
 * runs real tests either — it just dumps the AGENT/REPL_ID/CLAUDECODE
 * values it actually SEES into `env-capture.txt` (relative to its cwd,
 * which is the client's `--package-dir`) and writes a trivially-passing
 * junit file so the wrapping run completes cleanly.
 */
function writeFakeEnvCaptureBun(path: string): void {
  const junitXml =
    '<?xml version="1.0"?><testsuite name="narration.test.ts" tests="1">' +
    '<testcase name="ok" time="0.01"/></testsuite>';
  const lines = [
    "#!/bin/sh",
    'outfile=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --reporter-outfile=*) outfile="${arg#--reporter-outfile=}" ;;',
    "  esac",
    "done",
    "cat > \"$outfile\" <<'JUNITXML'",
    junitXml,
    "JUNITXML",
    "{",
    '  echo "AGENT=${AGENT:-<unset>}"',
    '  echo "REPL_ID=${REPL_ID:-<unset>}"',
    '  echo "CLAUDECODE=${CLAUDECODE:-<unset>}"',
    "} > env-capture.txt",
    "exit 0",
    "",
  ];
  writeExecutable(path, lines.join("\n"));
}

function readEnvCapture(dir: string): Record<string, string> {
  const text = readFileSync(join(dir, "env-capture.txt"), "utf-8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

describe("§S3 (CR-CRU-047) — bun narration survives bun's real ANSI tick lines; env-quieting strip covers AGENT/REPL_ID too", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test(
    "the bun invocation still carries the junit reporter flags and the junit XML is still written correctly (ingest unaffected) — --dots is WITHDRAWN, not part of this contract — no --agent/server needed, the '[crucible] running:' echo and the junit write both happen unconditionally",
    async () => {
      const dir = scratch.dir("narration-argv-junit-");
      writeNarrationBunProject(dir, "unused-project-key", 3, 0);
      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        ["test", "--tests", "narration.test.ts", "--project-dir", dir, "--package-dir", dir],
        { cwd: dir, crucibleUrl: "http://localhost:1" },
      );
      const [, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0); // all 3 fixture tests pass

      const runningLine = stderr.split("\n").find((l) => l.startsWith("[crucible] running:"));
      expect(runningLine).toBeDefined();
      // POSITIVE: the existing junit reporter flags are present in the built argv.
      expect(runningLine).toContain("--reporter=junit");
      expect(runningLine).toMatch(/--reporter-outfile=\S*junit\.xml/);
      // NEGATIVE — the withdrawn --dots contract must not silently reappear
      // (it was ruled out: it strips newlines, breaking §S2c's byte-identical
      // stdout capture, and bun emits no dot for a failing test).
      expect(runningLine).not.toMatch(/(^|\s)--dots(\s|$)|--reporter=dots\b/);

      // The junit XML must actually land on disk — ingest must not regress.
      const junitPath = join(dir, "test-reports", "junit.xml");
      expect(existsSync(junitPath)).toBe(true);
      const xml = readFileSync(junitPath, "utf-8");
      const caseCount = (xml.match(/<testcase\b/g) ?? []).length;
      expect(caseCount).toBe(3);
    },
    15000,
  );

  test("_COMPLETION_LINE (the completion-line matcher symbol) SURVIVES in clients/bun-crucible.py — the fix changes what it MATCHES, not whether the mechanism exists", () => {
    const source = readFileSync(BUN_SCRIPT_PATH, "utf-8");
    // POSITIVE: the symbol survives — GREEN must repair its regex in place,
    // never delete the console-scraping mechanism outright (that would be
    // console-scraping REMOVED, not FIXED, and would silently kill narration).
    expect(source).toContain("_COMPLETION_LINE");
    // NEGATIVE: the stale, non-ANSI-tolerant pattern — bun's OLD
    // `(pass)/(fail)/(skip)/(todo)` format, which bun 1.3.14 never emits —
    // must be gone. A survival check on the symbol NAME alone would pass an
    // untouched regex; this pins that the literal old pattern text changed.
    expect(source).not.toContain(String.raw`^\((?:pass|fail|skip|todo)\)`);
  });

  test(
    "the completion pattern matches REAL captured ANSI-colourised bun tick lines — a passing (✓, green) line AND a failing (✗, red) line both register as completions (the anti-trap test: a hand-typed bare glyph would NOT reproduce bun's real, escape-wrapped bytes)",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-ansi-anti-trap");
      const dir = scratch.dir("narration-ansi-fake-bun-");
      writeNarrationBunProject(dir, key, 4, 0); // 4 real `test(` decls → prescan total_hint = 4
      const fakeBunPath = join(dir, "fake-bun-ansi.sh");
      writeFakeAnsiTickBun(fakeBunPath);
      const agentId = "narration-ansi-anti-trap-agent";

      let done = false;
      const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done, 150);
      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        [
          "test",
          "--agent", agentId,
          "--tests", "narration.test.ts",
          "--project-dir", dir,
          "--package-dir", dir,
          "--bun", fakeBunPath,
        ],
        { cwd: dir, crucibleUrl: baseUrl },
      );
      const [, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      done = true;
      const log = await pollPromise;

      expect(code).toBe(1); // 2 of the fixture's 4 synthetic testcases are failing

      const matches = extractNarration(log, NARRATION_RE);
      // Non-vacuous precondition, same discipline as every other narration
      // test in this file: narration must actually be OBSERVED.
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.m).toBe(4);

      const distinct = distinctNarrationValues(matches);
      // The FIRST throttled post can only reach n=2 if BOTH real captured ✓
      // lines were recognized as completions (the throttle posts using the
      // count AT THE MOMENT it crosses the 2s bound — the 2nd ✓ completion).
      expect(distinct.some((p) => p.n === 2)).toBe(true);
      // The SECOND throttled post can only reach n=4 if BOTH real captured ✗
      // lines were ALSO recognized — proving the pattern matches the
      // failing (red, ✗) variant independently of the passing (green, ✓) one.
      expect(distinct.some((p) => p.n === 4)).toBe(true);
    },
    20000,
  );

  test(
    "`test` strips AGENT and REPL_ID (alongside CLAUDECODE) from the wrapped bun runner's environment — the env.pop at clients/bun-crucible.py:712 extends beyond CLAUDECODE",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-env-strip-test");
      const dir = scratch.dir("narration-env-strip-test-");
      writeNarrationBunProject(dir, key, 1, 0);
      const fakeBunPath = join(dir, "fake-bun-envcapture.sh");
      writeFakeEnvCaptureBun(fakeBunPath);
      const agentId = "narration-env-strip-test-agent";

      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        [
          "test",
          "--agent", agentId,
          "--tests", "narration.test.ts",
          "--project-dir", dir,
          "--package-dir", dir,
          "--bun", fakeBunPath,
        ],
        {
          cwd: dir,
          crucibleUrl: baseUrl,
          env: { AGENT: "codex-cli", REPL_ID: "codex-repl-42", CLAUDECODE: "1" },
        },
      );
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

      const captured = readEnvCapture(dir);
      // POSITIVE (parent process truly had them set) + NEGATIVE (the
      // wrapped runner must NEVER see them) in one assertion each.
      expect(captured.AGENT).toBe("<unset>");
      expect(captured.REPL_ID).toBe("<unset>");
      expect(captured.CLAUDECODE).toBe("<unset>");
    },
    15000,
  );

  test(
    "`regression` strips AGENT and REPL_ID (alongside CLAUDECODE) from the wrapped bun runner's environment — the env.pop at clients/bun-crucible.py:784 extends beyond CLAUDECODE",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-env-strip-regression");
      const dir = scratch.dir("narration-env-strip-regression-");
      writeNarrationBunProject(dir, key, 1, 0);
      const fakeBunPath = join(dir, "fake-bun-envcapture-regression.sh");
      writeFakeEnvCaptureBun(fakeBunPath);
      const agentId = "narration-env-strip-regression-agent";

      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        ["regression", "--agent", agentId, "--project-dir", dir, "--package-dir", dir, "--bun", fakeBunPath],
        {
          cwd: dir,
          crucibleUrl: baseUrl,
          env: { AGENT: "codex-cli", REPL_ID: "codex-repl-42", CLAUDECODE: "1" },
        },
      );
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

      const captured = readEnvCapture(dir);
      expect(captured.AGENT).toBe("<unset>");
      expect(captured.REPL_ID).toBe("<unset>");
      expect(captured.CLAUDECODE).toBe("<unset>");
    },
    15000,
  );

  test(
    "narration still posts 'running N/M' when CLAUDECODE=1 is explicitly SET in the runner's environment (Fault 2 regression guard — every agent-run gate sets this var)",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-bun-cc-set");
      const dir = scratch.dir("narration-bun-cc-set-");
      writeNarrationBunProject(dir, key, 24, 120);
      const agentId = "narration-bun-cc-set-agent";

      let done = false;
      const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done);
      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        ["test", "--agent", agentId, "--tests", "narration.test.ts", "--project-dir", dir, "--package-dir", dir],
        { cwd: dir, crucibleUrl: baseUrl, env: { CLAUDECODE: "1" } },
      );
      const [, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      done = true;
      const log = await pollPromise;

      expect(code).toBe(0); // all 24 fixture tests pass

      const matches = extractNarration(log, NARRATION_RE);
      // Non-vacuous precondition, same discipline as the §S2b tests above:
      // narration must actually be OBSERVED, not merely asserted away.
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.m).toBe(24);
    },
    20000,
  );

  test(
    "narration still posts 'running N/M' when AI_AGENT=1 is explicitly SET in the runner's environment (CR-CRU-055 — the quieting list must strip it)",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-bun-ai-agent-set");
      const dir = scratch.dir("narration-bun-ai-agent-set-");
      writeNarrationBunProject(dir, key, 24, 120);
      const agentId = "narration-bun-ai-agent-set-agent";

      let done = false;
      const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done);
      const proc = spawnScript(
        BUN_SCRIPT_PATH,
        ["test", "--agent", agentId, "--tests", "narration.test.ts", "--project-dir", dir, "--package-dir", dir],
        { cwd: dir, crucibleUrl: baseUrl, env: { AI_AGENT: "1" } },
      );
      const [, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      done = true;
      const log = await pollPromise;

      expect(code).toBe(0); // all 24 fixture tests pass

      const matches = extractNarration(log, NARRATION_RE);
      // Non-vacuous precondition, same discipline as the §S2b tests above:
      // narration must actually be OBSERVED, not merely asserted away.
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.m).toBe(24);
    },
    20000,
  );

  test(
    "narration still posts 'running N/M' when CLAUDECODE is explicitly UNSET in the runner's environment",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-bun-cc-unset");
      const dir = scratch.dir("narration-bun-cc-unset-");
      writeNarrationBunProject(dir, key, 24, 120);
      const agentId = "narration-bun-cc-unset-agent";

      let done = false;
      const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done);
      const proc = spawnScriptWithClaudecodeUnset(
        BUN_SCRIPT_PATH,
        ["test", "--agent", agentId, "--tests", "narration.test.ts", "--project-dir", dir, "--package-dir", dir],
        { cwd: dir, crucibleUrl: baseUrl },
      );
      const [, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      done = true;
      const log = await pollPromise;

      expect(code).toBe(0);

      const matches = extractNarration(log, NARRATION_RE);
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.m).toBe(24);
    },
    20000,
  );
});

describe("§S2b in-run progress narration — clients/mvn-crucible.py (class-granularity running class N/M)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test(
    "an mvn 'module' run (fake-mvnw streaming 3 surefire class blocks over ~3.6s) narrates 'running class N/M · <class>' heartbeats polled via GET /api/v2/agents, throttled (≥~2s or ≥10 completions apart)",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const baseUrl = `http://localhost:${handle.server.port}`;
      const key = await createProject(baseUrl, "clients-narration-mvn-class");
      const dir = scratch.dir("narration-mvn-class-");
      writeMvnNarrationFixture(dir, key);
      const agentId = "narration-mvn-class-agent";

      let done = false;
      const pollPromise = pollAgentUntil(baseUrl, key, agentId, () => done);
      const proc = spawnScript(MVN_SCRIPT_PATH, ["module", "--agent", agentId, "--project-dir", dir], {
        cwd: dir,
        crucibleUrl: baseUrl,
      });
      const [, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      done = true;
      const log = await pollPromise;

      expect(code).toBe(0); // all 3 fixture classes pass

      const matches = extractNarration(log, CLASS_NARRATION_RE);
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) expect(m.m).toBe(3);

      const distinct = distinctNarrationValues(matches);
      assertThrottled(distinct, 1900, 10);

      const finalSample = log[log.length - 1]!;
      if (finalSample.message !== undefined) {
        expect(CLASS_NARRATION_RE.test(finalSample.message)).toBe(false);
      }
    },
    20000,
  );
});
