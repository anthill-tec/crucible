// CR-CRU-008 C3 — clients/rust-crucible.py + clients/mvn-crucible.py v2 contract.
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md — §S2 script fleet
// upgrade (v2 endpoints, tier per subcommand, git/wave/orchestrator/cycle
// context) + the register-ergonomics Implementation Note (--phase optional,
// default "report") + Risk section: "clients/ in-repo is the SOURCE OF
// TRUTH ... VERIFY tests run against clients/ copies." This cycle (C3)
// upgrades rust-crucible.py and mvn-crucible.py.
//
// Current state: BOTH `clients/rust-crucible.py` and `clients/mvn-crucible.py`
// EXIST in-repo and are exactly what these tests drive — every test spawns
// `python3 clients/<script>.py ...` against a REAL live test server. The
// in-repo `clients/` copies are the SOURCE OF TRUTH. The old
// `~/.claude/scripts/*.py` mirror is RETIRED: do NOT run it, point tests at
// it, or treat it as the client source — running the mirror ORPHANS Crucible
// runs. (History, for context only: this file first landed as C3's RED, when
// neither client existed on the branch yet and every spawn failed with
// python3 exit 2 "can't open file" — mirroring C2's clients/bun-crucible.py
// RED file, tests/clients-bun-crucible.test.ts. GREEN created both clients
// under clients/. That is how the file began, not how it reads today.)
//
// Technique reused verbatim from C2: a real `startServer({port:0,
// dbPath:":memory:"})` instance + `Bun.spawn`, plus a tiny CAPTURING PROXY
// (`startCapturingProxy`) that records {method, path} for every request,
// forwards it to the real server, and relays the response back untouched —
// so tests pin the EXACT URLs the spawned python script hit (v2-only, NEVER
// the v1 shim) without reading the script's source.
//
// TOOLCHAIN-FREE FIXTURE STRATEGY (per dispatch scoping — do NOT require
// cargo/nextest or maven on this machine, do NOT run real cargo/mvn builds):
//   - rust: `auto-ingest` reads an EXISTING `target/nextest/ci/junit.xml`
//     file if present (no cargo invocation at all when it's there) — the
//     "junit ingest path". `regression-ingest` unconditionally shells out to
//     `cargo clean` / `cargo llvm-cov ... nextest ...` before reading
//     `target/nextest/ci/junit.xml` + `target/lcov.info` — so a fake `cargo`
//     executable (a no-op shell script) is prepended onto PATH; since it's a
//     no-op it never touches the filesystem, and the junit.xml + lcov.info
//     fixtures placed BEFORE invoking are exactly what the real llvm-cov run
//     would have produced. Zero real compilation ever happens — this is the
//     "parsed/junit ingest paths" the dispatch prompt names.
//   - mvn: `auto-ingest` reads EXISTING surefire/failsafe report dirs +
//     jacoco.csv WITHOUT ever invoking maven (confirmed by reading
//     cmd_auto_ingest — it only shells to `mvnw` in the no-reports compile
//     fallback, which pre-placed fixtures never hit). `unit`/`module`/`e2e`/
//     `regression` DO unconditionally invoke `_mvn_base(maven_dir)` (prefers
//     a project-relative `./mvnw` wrapper if present+executable) before
//     reading reports — so a fake `mvnw` (no-op shell script) is placed at
//     the fixture maven_dir root; since it's a no-op it never touches
//     target/, so pre-placed report/coverage fixtures are exactly what a
//     real `mvn clean test|verify` would have produced. Zero real maven
//     build ever happens — the "report-ingest paths reading surefire XML
//     dirs" the dispatch prompt names.
//
// v2 endpoint ground truth (read directly from src/v2.ts + src/codecs/,
// NOT assumed): `POST /api/v2/runs {projectKey, agentId, codec, dataPath|
// data, tier, context}` is the v2 equivalent of v1 `/api/ingest` (codec
// "junit" via `parseJunitPath` supports BOTH a single file AND a directory
// of `TEST-*.xml` — src/codecs/junit.ts:195-215); `POST /api/v2/runs/parsed`
// is the v2 equivalent of v1 `/api/ingest/parsed`; `POST /api/v2/runs/compile`
// is the v2 equivalent of v1 `/api/ingest/compile`. `runMeta()` (v2.ts:378)
// accepts `tier` only when it's a member of the server's TIERS set (`unit`,
// `module`, `integration`, `e2e`, `regression`, `bdd`) — all four values
// pinned below (unit/module/e2e/regression) are valid members.
//
// Surprise / scope note: unlike clients/bun-crucible.py (whose gated-run
// anti-ghost cleanup deliberately still rides the v1 `/api/agents/remove`
// shim until C7 — see that file's `_remove_agent_silent`), grepping both
// rust-crucible.py and mvn-crucible.py for "silent" found NOTHING — neither
// script has an equivalent silent-cleanup concept today. So there is no
// tolerated-shim carve-out here: every endpoint these two scripts touch
// (register, unregister, junit ingest, parsed ingest) must move to v2 with
// NO exception, and every test below pins v1 as NEVER hit.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

const RUST_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "rust-crucible.py");
const MVN_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "mvn-crucible.py");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `uv run <scriptPath> <args>`. Strips any ambient WORKFLOW_* env so
 * each test controls it explicitly, and always injects CRUCIBLE_URL — the
 * contract under test (both v1 scripts hardcode `http://localhost:3849`;
 * the C3 upgrade must honor this env var so tests can point it at an
 * ephemeral-port test server / capturing proxy instead).
 */
async function runScript(
  scriptPath: string,
  args: string[],
  opts: { cwd: string; crucibleUrl: string; env?: Record<string, string | undefined> },
): Promise<RunResult> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  const proc = Bun.spawn({
    cmd: ["uv", "run", scriptPath, ...args],
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
 * receives, forwards it verbatim to `targetBaseUrl`, and relays the real
 * response back untouched. Lets tests pin the EXACT URLs a spawned script
 * hit (v2-only, never a v1 shim) without reading the script's source.
 * Reused verbatim from C2 (tests/clients-bun-crucible.test.ts).
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

async function getEvents(baseUrl: string, key: string): Promise<Array<{ id: string }>> {
  const res = await fetch(`${baseUrl}/api/v2/events?project=${key}`);
  const body = (await res.json()) as { events: Array<{ id: string }> };
  return body.events;
}

/**
 * Files a real OPEN plan with two `pending` cycles (neither active) — the
 * CR-CRU-036 §S1 fixture primitive: "open plan, no active cycle" until
 * `activateCycle` below promotes one of them.
 */
async function filePlan(baseUrl: string, key: string, cr: string): Promise<{ planId: number; cycles: Array<{ id: number }> }> {
  const res = await fetch(`${baseUrl}/api/v2/projects/${key}/plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cr, cycles: [{ label: "A" }, { label: "B" }] }),
  });
  return (await res.json()) as { planId: number; cycles: Array<{ id: number }> };
}

/**
 * CR-CRU-036 §S1: PATCHes a plan's cycle to `status:"active"` directly
 * against the plans API — the "seed an active cycle on the test server"
 * step (project → plan-file → cycle-activate) so the client's server-side
 * auto-attach resolver has a real target.
 */
async function activateCycle(baseUrl: string, key: string, planId: number, cycleId: number): Promise<void> {
  await fetch(`${baseUrl}/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
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
  tree?: Array<{ name: string; status: string; children: Array<{ name: string; status: string }> }>;
  coverage?: {
    lines?: { total: number; covered: number; percent: number };
    functions?: { total: number; covered: number; percent: number };
    branches?: { total: number; covered: number; percent: number };
  };
}

async function getFullEvent(baseUrl: string, id: string): Promise<FullEvent> {
  const res = await fetch(`${baseUrl}/api/v2/events/${id}`);
  const body = (await res.json()) as { event: FullEvent };
  return body.event;
}

function runGit(args: string[], cwd: string): void {
  const res = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "clients-rust-mvn-crucible-test",
      GIT_AUTHOR_EMAIL: "clients-rust-mvn-crucible-test@example.com",
      GIT_COMMITTER_NAME: "clients-rust-mvn-crucible-test",
      GIT_COMMITTER_EMAIL: "clients-rust-mvn-crucible-test@example.com",
    },
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/** A no-op stand-in for `cargo`/`mvnw` — never touches the filesystem, so
 * pre-placed report/coverage fixtures survive untouched and are exactly
 * what a real run would have produced. */
const NOOP_SCRIPT = "#!/bin/sh\nexit 0\n";

function writeEnvFile(dir: string, projectKey: string): void {
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
}

/** Minimal JUnit XML (`<testsuite><testcase>...`) — the shared format both
 * nextest (rust) and surefire/failsafe (maven) emit and Crucible's junit
 * codec parses identically (src/codecs/junit.ts). CR-CRU-050 §S1/§S1b —
 * `skip` emits a bare `<skipped/>` child (nextest's and surefire's real
 * shape for a skipped/ignored testcase), which the defective client-side
 * parsers fold into `passed` today via a bare `else:`. */
function writeJunitXml(
  path: string,
  suiteName: string,
  cases: Array<{ name: string; fail?: boolean; skip?: boolean }>,
): void {
  const testcases = cases
    .map((c) => {
      if (c.fail) return `<testcase name="${c.name}" time="0.01"><failure message="boom">boom</failure></testcase>`;
      if (c.skip) return `<testcase name="${c.name}" time="0.01"><skipped/></testcase>`;
      return `<testcase name="${c.name}" time="0.01"/>`;
    })
    .join("");
  writeFileSync(
    path,
    `<?xml version="1.0"?><testsuite name="${suiteName}" tests="${cases.length}">${testcases}</testsuite>`,
  );
}

/**
 * Extracts the 4-space-indented body of the TOON `  run:` block from a
 * client's stdout envelope (the §S2 printed run: block under `axi:`),
 * without depending on key ORDER — the fix may insert `pending` anywhere.
 * Mirrors tests/clients-bun-crucible.test.ts's helper of the same name.
 */
function extractRunBlock(stdout: string): string | undefined {
  const match = stdout.match(/ {2}run:\n((?: {4}.*\n)*)/);
  return match?.[1];
}

function writeLcovInfo(
  path: string,
  cov: { lf: number; lh: number; ff: number; fh: number },
): void {
  writeFileSync(
    path,
    `SF:src/lib.rs\nFNF:${cov.ff}\nFNH:${cov.fh}\nLF:${cov.lf}\nLH:${cov.lh}\nend_of_record\n`,
  );
}

function writeJacocoCsv(
  path: string,
  cov: {
    lineMissed: number;
    lineCovered: number;
    methodMissed: number;
    methodCovered: number;
    branchMissed: number;
    branchCovered: number;
  },
): void {
  const header =
    "GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,BRANCH_COVERED," +
    "LINE_MISSED,LINE_COVERED,COMPLEXITY_MISSED,COMPLEXITY_COVERED,METHOD_MISSED,METHOD_COVERED";
  const row =
    `Fixture,com.example,Foo,0,0,${cov.branchMissed},${cov.branchCovered},` +
    `${cov.lineMissed},${cov.lineCovered},0,0,${cov.methodMissed},${cov.methodCovered}`;
  writeFileSync(path, `${header}\n${row}\n`);
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

// ═══════════════════════════════════════════════════════════════════════
// clients/rust-crucible.py
// ═══════════════════════════════════════════════════════════════════════

describe("clients/rust-crucible.py — v2 endpoints + CRUCIBLE_URL + register ergonomics (CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("register hits POST /api/v2/agents/register (never v1 /api/agents/heartbeat) via CRUCIBLE_URL, not the hardcoded localhost:3849", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-register-v2");
    const dir = scratch.dir("rust-crucible-proj-");
    writeEnvFile(dir, key);
    // CR-CRU-056 §S2/§S3c — RED (a TDD phase) now REQUIRES an explicit
    // cycle binding; this test's subject (which endpoint/verb gets hit) is
    // unaffected, so a fixture plan+active-cycle is filed and reused (same
    // primitive as filePlan/activateCycle used elsewhere in this file).
    const plan = await filePlan(baseUrl, key, "CR-RC-register-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      RUST_SCRIPT_PATH,
      ["register", "--agent", "r1", "--phase", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).toContain("r1");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/register"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/heartbeat")).toBe(false);
  });

  test("unregister hits POST /api/v2/agents/unregister (never v1 /api/agents/remove); agent vanishes from GET /api/v2/agents", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-unregister-v2");
    const dir = scratch.dir("rust-crucible-proj-");
    writeEnvFile(dir, key);
    // CR-CRU-056 §S2/§S3c — same reused fixture: RED needs a bound cycle
    // before this test's actual subject (the unregister verb/path) runs.
    const plan = await filePlan(baseUrl, key, "CR-RC-unregister-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      RUST_SCRIPT_PATH,
      ["register", "--agent", "r2", "--phase", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );
    expect(await getAgentIds(baseUrl, key)).toContain("r2");

    const res = await runScript(RUST_SCRIPT_PATH, ["unregister", "--agent", "r2", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
    });

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).not.toContain("r2");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/unregister"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  });

  test("register --agent X --phase report succeeds and records the declared report phase", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-phase-optional");
    const dir = scratch.dir("rust-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(RUST_SCRIPT_PATH, ["register", "--agent", "r3", "--phase", "report", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    const agents = await getAgents(baseUrl, key);
    const agent = agents.find((a) => a.agentId === "r3");
    expect(agent).toBeDefined();
    expect(agent!.message.toLowerCase()).toContain("report");
  });

  // CR-CRU-056 §S2/§S3/§S3c — the CR-036 client-side auto-attach resolver
  // is DELETED; re-pointed from "warns+withholds" into the new unconditional
  // contract: a TDD-phase register with no explicit --cycle is REFUSED
  // (non-zero exit, structured ok:false envelope naming --cycle) regardless
  // of plan state — WORKFLOW_CYCLE_ID is read by nobody (confirmed live:
  // even a REAL, in-project, pending cycle id sitting in that env var
  // changes nothing).
  test("CR-CRU-056 §S2: register --phase RED with an OPEN plan but NO active cycle is REFUSED (non-zero exit, structured ok:false envelope naming --cycle), posts NO agent — a STALE WORKFLOW_CYCLE_ID pointing at a REAL cycle in this very plan changes NOTHING", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-RC-NO-ACTIVE-CYCLE");
    const dir = scratch.dir("rust-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(
      RUST_SCRIPT_PATH,
      ["register", "--agent", "r-no-cycle", "--phase", "RED", "--project-dir", dir],
      // The deleted resolver's exact mechanism: nobody reads this env var
      // any more, so it must not rescue the registration.
      { cwd: dir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("r-no-cycle");
  });

  test("CR-CRU-036 §S1: register with NO open plan at all is tolerant — proceeds with no warning and no withhold", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-tolerant-no-plan");
    const dir = scratch.dir("rust-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(RUST_SCRIPT_PATH, ["register", "--agent", "r-tolerant", "--phase", "report", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).toContain("r-tolerant");
  });
});

describe("clients/rust-crucible.py — auto-ingest: /api/v2/runs, tier:'unit', full context enrichment (CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();
  const branch = "cr-cru-008-c3-rust-fixture-branch";

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  function fixtureDir(key: string): string {
    const dir = scratch.dir("rust-crucible-auto-ingest-");
    writeEnvFile(dir, key);
    runGit(["init", "-q"], dir);
    runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    // A junit.xml at the profile-default nextest path — auto-ingest reads it
    // WITHOUT ever shelling to cargo when it's already present.
    writeFileSync(join(dir, ".gitkeep"), "");
    runGit(["add", "."], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);
    const junitDir = join(dir, "target", "nextest", "ci");
    Bun.spawnSync({ cmd: ["mkdir", "-p", junitDir] });
    writeJunitXml(join(junitDir, "junit.xml"), "auto_ingest_fixture", [
      { name: "one" },
      { name: "two" },
      { name: "three", fail: true },
    ]);
    return dir;
  }

  test("posts to /api/v2/runs (never v1 /api/ingest) with tier:'unit' and the parsed summary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-auto-ingest-unit");
    const dir = fixtureDir(key);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      RUST_SCRIPT_PATH,
      ["auto-ingest", "--agent", "rust-auto-ingest-agent", "--crate", "demo-crate", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).not.toBe(0); // 1 of 3 fixture tests fails
    expect(event.tier).toBe("unit");
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.passed).toBe(2);
    expect(event.summary?.failed).toBe(1);
    expect(proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs")).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest")).toBe(false);
  });

  test("with an ACTIVE cycle seeded server-side + WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE set, records full context: cycleId comes from the agent's REGISTERED BINDING (WORKFLOW_CYCLE_ID set to a DIFFERENT real cycle changes nothing), cycle, wave, orchestrator, auto-detected git branch/commit", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-auto-ingest-context");
    // CR-CRU-056 §S1/§S3: seed an ACTIVE cycle server-side; feed the OTHER
    // (real, but pending) cycle to WORKFLOW_CYCLE_ID to prove it's ignored
    // (nobody reads it any more — the client-side auto-attach resolver this
    // env var used to feed is deleted).
    const plan = await filePlan(baseUrl, key, "CR-RC-CONTEXT");
    const activeCycleId = plan.cycles[0]!.id;
    const otherCycleId = plan.cycles[1]!.id;
    await activateCycle(baseUrl, key, plan.planId, activeCycleId);
    const dir = fixtureDir(key);

    // CR-CRU-056 §S3 — auto-ingest itself never registers/binds an agent;
    // the server now stamps a run's context.cycleId ONLY from an
    // ALREADY-BOUND agent row. Explicitly pre-register the same agent id
    // bound to the real active cycle so the ingest below has a binding to
    // stamp from — this is what replaces the deleted server-side "active
    // cycle" GUESS this test used to exercise.
    await runScript(
      RUST_SCRIPT_PATH,
      ["register", "--agent", "rust-context-agent", "--phase", "RED", "--cycle", String(activeCycleId), "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    await runScript(
      RUST_SCRIPT_PATH,
      ["auto-ingest", "--agent", "rust-context-agent", "--crate", "demo-crate", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: {
          WORKFLOW_CYCLE_ID: String(otherCycleId),
          WORKFLOW_CYCLE: "rust-crucible + mvn-crucible v2 upgrade",
          WORKFLOW_WAVE: "wave-4",
          WORKFLOW_ROLE: "track-3",
        },
      },
    );

    // Two events now: the explicit pre-registration's lifecycle event, plus
    // the auto-ingest's test event — events are returned newest-first
    // (ORDER BY timestamp DESC), so events[0] is still the ingest event.
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(2);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context?.cycleId).toBe(activeCycleId);
    expect(event.context?.cycle).toBe("rust-crucible + mvn-crucible v2 upgrade");
    expect(event.context?.wave).toBe("wave-4");
    expect(event.context?.orchestrator).toBe("track-3");
    expect(event.context?.git?.branch).toBe(branch);
    expect(typeof event.context?.git?.commit).toBe("string");
    expect((event.context?.git?.commit ?? "").length).toBeGreaterThan(0);
  });

  test("with no WORKFLOW_* env set, the stored event has NO context key at all (graceful absence)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-auto-ingest-no-context");
    const dir = fixtureDir(key);

    await runScript(
      RUST_SCRIPT_PATH,
      ["auto-ingest", "--agent", "rust-no-context-agent", "--crate", "demo-crate", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context).toBeUndefined();
  });
});

describe("clients/rust-crucible.py — regression-ingest: /api/v2/runs/parsed, tier:'regression', lcov coverage passthrough (fake cargo stub, CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  function fixtureDirWithFakeCargo(key: string): { dir: string; path: string } {
    const dir = scratch.dir("rust-crucible-regression-");
    writeEnvFile(dir, key);
    const junitDir = join(dir, "target", "nextest", "ci");
    Bun.spawnSync({ cmd: ["mkdir", "-p", junitDir] });
    writeJunitXml(join(junitDir, "junit.xml"), "regression_fixture", [
      { name: "alpha" },
      { name: "beta" },
    ]);
    writeLcovInfo(join(dir, "target", "lcov.info"), { lf: 10, lh: 8, ff: 5, fh: 4 });

    const binDir = scratch.dir("fake-cargo-bin-");
    writeExecutable(join(binDir, "cargo"), NOOP_SCRIPT);
    const path = `${binDir}:${process.env.PATH ?? ""}`;
    return { dir, path };
  }

  test("records tier:'regression' via POST /api/v2/runs/parsed only (never v1 /api/ingest/parsed)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-regression-ingest-tier");
    const { dir, path } = fixtureDirWithFakeCargo(key);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      RUST_SCRIPT_PATH,
      ["regression-ingest", "--agent", "rust-regression-agent", "--crates", "demo-crate", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url, env: { PATH: path } },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("regression");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(2);
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("lcov coverage passthrough: event.coverage carries the fixture's line/function totals", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-regression-ingest-coverage");
    const { dir, path } = fixtureDirWithFakeCargo(key);

    await runScript(
      RUST_SCRIPT_PATH,
      ["regression-ingest", "--agent", "rust-coverage-agent", "--crates", "demo-crate", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } },
    );

    const events = await getEvents(baseUrl, key);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.coverage?.lines?.total).toBe(10);
    expect(event.coverage?.lines?.covered).toBe(8);
    expect(event.coverage?.functions?.total).toBe(5);
    expect(event.coverage?.functions?.covered).toBe(4);
  });
});

describe("clients/rust-crucible.py — byte-compatible CLI surface (existing flags unchanged post-upgrade)", () => {
  test("register/unregister/test/check/clippy/auto-ingest/regression-ingest --help still expose today's exact flag names", async () => {
    const cases: Array<[string, string[]]> = [
      ["register", ["--agent", "--phase", "--message", "--project-dir"]],
      ["unregister", ["--agent", "--project-dir"]],
      ["test", ["--crate", "--features", "--profile", "--test", "--filter", "--no-fail-fast", "--agent", "--project-dir", "--log"]],
      ["check", ["--crate", "--features", "--tests", "--agent", "--project-dir"]],
      ["clippy", ["--crate", "--features", "--tests", "--deny-warnings", "--agent", "--project-dir"]],
      ["auto-ingest", ["--agent", "--crate", "--features", "--project-dir"]],
      ["regression-ingest", ["--agent", "--crates", "--features", "--project-dir"]],
    ];
    for (const [subcommand, flags] of cases) {
      const proc = Bun.spawn({
        cmd: ["uv", "run", RUST_SCRIPT_PATH, subcommand, "--help"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      for (const flag of flags) {
        expect(stdout.includes(flag)).toBe(true);
      }
    }
  });
});

// CR-CRU-050 §S1/§S1b — rust has TWO client-side JUnit parse sites, both
// with the identical unguarded `status = "fail" if fail else "pass"` / bare
// `else: passed += 1` and a hardcoded `"pending": 0`:
//   site 1: `_regression_ingest_run` (rust-crucible.py:700-763), driving the
//           `regression-ingest` verb.
//   site 2: `_workspace_regression_run` (rust-crucible.py:1246-1307), driving
//           `workspace-regression` — the ORCHESTRATOR PRE-MERGE-GATE path.
// A fix touching only site 1 is the likely partial fix the CR calls out —
// both are covered here, each with its own fixture and its own assertions.
describe("clients/rust-crucible.py — CR-CRU-050 §S1/§S1b/§S2 site 1 (regression-ingest): <skipped/> counts as pending, never passed (fake cargo stub)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  function fixtureDirWithFakeCargoCr050(
    key: string,
    cases: Array<{ name: string; fail?: boolean; skip?: boolean }>,
  ): { dir: string; path: string } {
    const dir = scratch.dir("rust-crucible-cr050-regression-");
    writeEnvFile(dir, key);
    const junitDir = join(dir, "target", "nextest", "ci");
    Bun.spawnSync({ cmd: ["mkdir", "-p", junitDir] });
    writeJunitXml(join(junitDir, "junit.xml"), "cr050_regression_fixture", cases);
    const binDir = scratch.dir("fake-cargo-bin-cr050-");
    writeExecutable(join(binDir, "cargo"), NOOP_SCRIPT);
    const path = `${binDir}:${process.env.PATH ?? ""}`;
    return { dir, path };
  }

  test("§S1/§S1b: counts the skipped testcase as pending=1 (never folded into passed), the skipped leaf carries tree status 'pending' (not 'pass'), pass/fail leaves unaffected; §S2 (extended): the plain 'regression: ...' stdout line (rust-crucible.py:818) also carries pending=1", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-cr050-regression-ingest");
    const { dir, path } = fixtureDirWithFakeCargoCr050(key, [
      { name: "alpha" },
      { name: "beta", fail: true },
      { name: "gamma", skip: true },
    ]);

    const res = await runScript(
      RUST_SCRIPT_PATH,
      ["regression-ingest", "--agent", "rust-cr050-regression-agent", "--crates", "demo-crate", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    // §S1 — counts.
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.failed).toBe(1);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.passed).not.toBe(2); // the defect's fold-into-passed reading
    expect(event.summary?.pending).toBe(1);
    const s = event.summary!;
    expect((s.passed ?? 0) + (s.failed ?? 0) + (s.pending ?? 0)).toBe(s.total);

    // §S1b — leaf status, not just counts.
    const leaves = (event.tree ?? []).flatMap((suite) => suite.children);
    const skipLeaf = leaves.find((l) => l.name === "gamma");
    const passLeaf = leaves.find((l) => l.name === "alpha");
    const failLeaf = leaves.find((l) => l.name === "beta");
    expect(skipLeaf?.status).toBe("pending");
    expect(skipLeaf?.status).not.toBe("pass");
    expect(passLeaf?.status).toBe("pass");
    expect(failLeaf?.status).toBe("fail");

    // §S2 (extended) — the plain "regression: ..." stdout line (no TOON
    // envelope exists for this verb — it prints its own summary directly).
    expect(res.stdout).toContain("regression:");
    expect(res.stdout).toContain("pending=1");
  });
});

describe("clients/rust-crucible.py — CR-CRU-050 §S1/§S1b/§S2 site 2 (workspace-regression, the pre-merge-gate path): <skipped/> counts as pending, never passed (fake cargo stub)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("§S1/§S1b: counts the skipped testcase as pending=1 (never folded into passed), the skipped leaf carries tree status 'pending' (not 'pass'), pass/fail leaves unaffected; §S2 (extended): the plain 'workspace regression: ...' stdout line (rust-crucible.py:1352) also carries pending=1", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-cr050-workspace-regression");
    const dir = scratch.dir("rust-crucible-cr050-workspace-");
    writeEnvFile(dir, key);
    // `_acquire_gate_lock` resolves the lock path via `git rev-parse
    // --git-common-dir` — a real (even if empty) git repo is required.
    runGit(["init", "-q"], dir);
    writeFileSync(join(dir, ".gitkeep"), "");
    runGit(["add", "."], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);
    const junitDir = join(dir, "target", "nextest", "ci"); // default --profile
    Bun.spawnSync({ cmd: ["mkdir", "-p", junitDir] });
    writeJunitXml(join(junitDir, "junit.xml"), "cr050_workspace_fixture", [
      { name: "delta" },
      { name: "epsilon", fail: true },
      { name: "zeta", skip: true },
    ]);
    const binDir = scratch.dir("fake-cargo-bin-cr050-ws-");
    writeExecutable(join(binDir, "cargo"), NOOP_SCRIPT);
    const path = `${binDir}:${process.env.PATH ?? ""}`;

    const res = await runScript(
      RUST_SCRIPT_PATH,
      [
        "workspace-regression",
        "--agent", "rust-cr050-workspace-agent",
        "--project-dir", dir,
        "--min-free-g", "0", // bypass the real disk guard in this sandbox
        "--keep-target", // skip the post-run reclaim cargo clean (irrelevant with a fake cargo, kept minimal)
      ],
      { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    // §S1 — counts.
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.failed).toBe(1);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.passed).not.toBe(2); // the defect's fold-into-passed reading
    expect(event.summary?.pending).toBe(1);
    const s = event.summary!;
    expect((s.passed ?? 0) + (s.failed ?? 0) + (s.pending ?? 0)).toBe(s.total);

    // §S1b — leaf status, not just counts.
    const leaves = (event.tree ?? []).flatMap((suite) => suite.children);
    const skipLeaf = leaves.find((l) => l.name === "zeta");
    const passLeaf = leaves.find((l) => l.name === "delta");
    const failLeaf = leaves.find((l) => l.name === "epsilon");
    expect(skipLeaf?.status).toBe("pending");
    expect(skipLeaf?.status).not.toBe("pass");
    expect(passLeaf?.status).toBe("pass");
    expect(failLeaf?.status).toBe("fail");

    // §S2 (extended) — the plain "workspace regression: ..." stdout line.
    expect(res.stdout).toContain("workspace regression:");
    expect(res.stdout).toContain("pending=1");
  });
});

// CR-CRU-050 §S2 — the auto-ingest / test verbs' SINGLE-report-dir path
// (`_ingest_junit_axi`, rust-crucible.py:836-858) hands the junit XML to the
// SERVER's codec (POST /api/v2/runs) rather than the client's own
// `_parse_junit` — the server already classifies `<skipped/>` as pending
// correctly (§S4 — no server change in this CR's scope), so the counts here
// are a POSITIVE pin, never a RED. What this CR DID fix client-side is purely
// the PRINTING: the TOON `run:` block (`_emit_ingest_axi`,
// rust-crucible.py:362-377) and the plain "ingest junit: ..." stderr line
// (rust-crucible.py:852-855) both build from `resp.get("run")` — which the
// server response already carried `pending` on — yet dropped the key when
// printing. Both now carry it, which is what the test below pins.
describe("clients/rust-crucible.py — CR-CRU-050 §S2: auto-ingest's junit-dir path (server-parsed, correct counts) carries pending in the TOON run: block and the 'ingest junit:' print line", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();
  const branch = "cr-cru-050-rust-auto-ingest-fixture-branch";

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("event.summary.pending=1 is already correct (server-side junit codec, confirmed not assumed); the TOON run: block and the plain stderr print both carry pending=1 too", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-cr050-auto-ingest-pending");
    const dir = scratch.dir("rust-crucible-cr050-auto-ingest-");
    writeEnvFile(dir, key);
    runGit(["init", "-q"], dir);
    runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    writeFileSync(join(dir, ".gitkeep"), "");
    runGit(["add", "."], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);
    const junitDir = join(dir, "target", "nextest", "ci");
    Bun.spawnSync({ cmd: ["mkdir", "-p", junitDir] });
    writeJunitXml(join(junitDir, "junit.xml"), "cr050_auto_ingest_fixture", [
      { name: "one" },
      { name: "two", skip: true },
    ]);

    const res = await runScript(
      RUST_SCRIPT_PATH,
      ["auto-ingest", "--agent", "rust-cr050-auto-ingest-agent", "--crate", "demo-crate", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    // Positive pin — the server's junit codec already gets this right.
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.failed).toBe(0);
    expect(event.summary?.pending).toBe(1);
    expect(res.code).toBe(0); // no real failures — a pass and a skip only

    // §S2 — the TOON run: block.
    const block = extractRunBlock(res.stdout);
    expect(block).toBeDefined();
    expect(block).toContain("pending: 1");

    // §S2 (extended) — the plain "ingest junit: ..." stderr line.
    expect(res.stderr).toContain("ingest junit:");
    expect(res.stderr).toContain("pending=1");
  });
});

describe("clients/rust-crucible.py — CR-CRU-050 §S2 (extended): smoke-test's inline 'smoke-test: ...' stdout print line (rust-crucible.py:1199-1202) also carries pending", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("with a real skipped testcase pre-placed at target/nextest/ci/junit.xml and a fake no-op cargo, 'smoke-test' (--clean/--all-features/--with-docker all default-off) ingests via the server's junit codec (event.summary.pending=1 confirmed) and its own print line carries pending=1", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-rc-cr050-smoke-test");
    const dir = scratch.dir("rust-crucible-cr050-smoke-");
    writeEnvFile(dir, key);
    runGit(["init", "-q"], dir); // required for the gate-lock path resolution
    writeFileSync(join(dir, ".gitkeep"), "");
    runGit(["add", "."], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);
    const junitDir = join(dir, "target", "nextest", "ci"); // default --profile
    Bun.spawnSync({ cmd: ["mkdir", "-p", junitDir] });
    writeJunitXml(join(junitDir, "junit.xml"), "cr050_smoke_fixture", [
      { name: "smoke-one" },
      { name: "smoke-two", skip: true },
    ]);
    const binDir = scratch.dir("fake-cargo-bin-cr050-smoke-");
    writeExecutable(join(binDir, "cargo"), NOOP_SCRIPT);
    const path = `${binDir}:${process.env.PATH ?? ""}`;

    const res = await runScript(
      RUST_SCRIPT_PATH,
      ["smoke-test", "--agent", "rust-cr050-smoke-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.pending).toBe(1);
    expect(res.code).toBe(0);

    expect(res.stdout).toContain("smoke-test:");
    expect(res.stdout).toContain("pending=1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// clients/mvn-crucible.py
// ═══════════════════════════════════════════════════════════════════════

describe("clients/mvn-crucible.py — v2 endpoints + CRUCIBLE_URL + register ergonomics (CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("register hits POST /api/v2/agents/register (never v1 /api/agents/heartbeat) via CRUCIBLE_URL, not the hardcoded localhost:3849", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-register-v2");
    const dir = scratch.dir("mvn-crucible-proj-");
    writeEnvFile(dir, key);
    // CR-CRU-056 §S2/§S3c — RED (a TDD phase) now REQUIRES an explicit
    // cycle binding; this test's subject (which endpoint/verb gets hit) is
    // unaffected, so a fixture plan+active-cycle is filed and reused (same
    // primitive as filePlan/activateCycle used elsewhere in this file).
    const plan = await filePlan(baseUrl, key, "CR-MC-register-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      MVN_SCRIPT_PATH,
      ["register", "--agent", "m1", "--phase", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).toContain("m1");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/register"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/heartbeat")).toBe(false);
  });

  test("unregister hits POST /api/v2/agents/unregister (never v1 /api/agents/remove); agent vanishes from GET /api/v2/agents", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-unregister-v2");
    const dir = scratch.dir("mvn-crucible-proj-");
    writeEnvFile(dir, key);
    // CR-CRU-056 §S2/§S3c — same reused fixture: RED needs a bound cycle
    // before this test's actual subject (the unregister verb/path) runs.
    const plan = await filePlan(baseUrl, key, "CR-MC-unregister-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      MVN_SCRIPT_PATH,
      ["register", "--agent", "m2", "--phase", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );
    expect(await getAgentIds(baseUrl, key)).toContain("m2");

    const res = await runScript(MVN_SCRIPT_PATH, ["unregister", "--agent", "m2", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
    });

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).not.toContain("m2");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/unregister"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  });

  test("register --agent X --phase report succeeds and records the declared report phase", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-phase-optional");
    const dir = scratch.dir("mvn-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(MVN_SCRIPT_PATH, ["register", "--agent", "m3", "--phase", "report", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    const agents = await getAgents(baseUrl, key);
    const agent = agents.find((a) => a.agentId === "m3");
    expect(agent).toBeDefined();
    expect(agent!.message.toLowerCase()).toContain("report");
  });

  // CR-CRU-056 §S2/§S3/§S3c — the CR-036 client-side auto-attach resolver
  // is DELETED; re-pointed into the new unconditional contract: a TDD-phase
  // register with no explicit --cycle is REFUSED (non-zero exit, structured
  // ok:false envelope naming --cycle) regardless of plan state —
  // WORKFLOW_CYCLE_ID is read by nobody (confirmed live: even a REAL,
  // in-project, pending cycle id sitting in that env var changes nothing).
  test("CR-CRU-056 §S2: register --phase RED with an OPEN plan but NO active cycle is REFUSED (non-zero exit, structured ok:false envelope naming --cycle), posts NO agent — a STALE WORKFLOW_CYCLE_ID pointing at a REAL cycle in this very plan changes NOTHING", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-MC-NO-ACTIVE-CYCLE");
    const dir = scratch.dir("mvn-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(
      MVN_SCRIPT_PATH,
      ["register", "--agent", "m-no-cycle", "--phase", "RED", "--project-dir", dir],
      // The deleted resolver's exact mechanism: nobody reads this env var
      // any more, so it must not rescue the registration.
      { cwd: dir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("m-no-cycle");
  });

  test("CR-CRU-036 §S1: register with NO open plan at all is tolerant — proceeds with no warning and no withhold", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-tolerant-no-plan");
    const dir = scratch.dir("mvn-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(MVN_SCRIPT_PATH, ["register", "--agent", "m-tolerant", "--phase", "report", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).toContain("m-tolerant");
  });
});

describe("clients/mvn-crucible.py — tier map per subcommand: unit/module/e2e/regression (fake mvnw stub, CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  function fixtureDir(key: string): string {
    const dir = scratch.dir("mvn-crucible-tier-");
    writeEnvFile(dir, key);
    writeExecutable(join(dir, "mvnw"), NOOP_SCRIPT);
    return dir;
  }

  test("'unit' tier: single surefire-reports dir → POST /api/v2/runs (never v1 /api/ingest), tier:'unit'", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-unit-tier");
    const dir = fixtureDir(key);
    const reportsDir = join(dir, "target", "surefire-reports");
    Bun.spawnSync({ cmd: ["mkdir", "-p", reportsDir] });
    writeJunitXml(join(reportsDir, "TEST-FooTest.xml"), "FooTest", [
      { name: "testOne" },
      { name: "testTwo", fail: true },
    ]);
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      MVN_SCRIPT_PATH,
      ["unit", "--test", "FooTest", "--agent", "mvn-unit-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.tier).toBe("unit");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.failed).toBe(1);
    expect(proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs")).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest")).toBe(false);
  });

  test("'module' tier: TWO reactor surefire-reports dirs → POST /api/v2/runs/parsed (never v1), tier:'module'", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-module-tier");
    const dir = fixtureDir(key);
    const dirA = join(dir, "moduleA", "target", "surefire-reports");
    const dirB = join(dir, "moduleB", "target", "surefire-reports");
    Bun.spawnSync({ cmd: ["mkdir", "-p", dirA] });
    Bun.spawnSync({ cmd: ["mkdir", "-p", dirB] });
    writeJunitXml(join(dirA, "TEST-ModuleA.xml"), "ModuleA", [{ name: "a1" }]);
    writeJunitXml(join(dirB, "TEST-ModuleB.xml"), "ModuleB", [{ name: "b1" }]);
    proxy = startCapturingProxy(baseUrl);

    await runScript(MVN_SCRIPT_PATH, ["module", "--agent", "mvn-module-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
    });

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.tier).toBe("module");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(2);
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("'e2e' tier: surefire + failsafe dirs → POST /api/v2/runs/parsed, tier:'e2e'", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-e2e-tier");
    const dir = fixtureDir(key);
    const surefireDir = join(dir, "target", "surefire-reports");
    const failsafeDir = join(dir, "target", "failsafe-reports");
    Bun.spawnSync({ cmd: ["mkdir", "-p", surefireDir] });
    Bun.spawnSync({ cmd: ["mkdir", "-p", failsafeDir] });
    writeJunitXml(join(surefireDir, "TEST-Unit.xml"), "Unit", [{ name: "u1" }]);
    writeJunitXml(join(failsafeDir, "TEST-Foo.xml"), "FooIT", [{ name: "it1", fail: true }]);
    proxy = startCapturingProxy(baseUrl);

    await runScript(MVN_SCRIPT_PATH, ["e2e", "--agent", "mvn-e2e-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
    });

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.tier).toBe("e2e");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.failed).toBe(1);
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("'regression' tier: surefire + failsafe (all-green) + jacoco.csv → POST /api/v2/runs/parsed, tier:'regression', coverage attached", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-regression-tier");
    const dir = fixtureDir(key);
    const surefireDir = join(dir, "target", "surefire-reports");
    const failsafeDir = join(dir, "target", "failsafe-reports");
    const jacocoDir = join(dir, "target", "jacoco-report");
    Bun.spawnSync({ cmd: ["mkdir", "-p", surefireDir] });
    Bun.spawnSync({ cmd: ["mkdir", "-p", failsafeDir] });
    Bun.spawnSync({ cmd: ["mkdir", "-p", jacocoDir] });
    // Coverage is only ever published when the reactor is all-green.
    writeJunitXml(join(surefireDir, "TEST-Unit.xml"), "Unit", [{ name: "u1" }, { name: "u2" }]);
    writeJunitXml(join(failsafeDir, "TEST-Foo.xml"), "FooIT", [{ name: "it1" }]);
    writeJacocoCsv(join(jacocoDir, "jacoco.csv"), {
      lineMissed: 2,
      lineCovered: 8,
      methodMissed: 1,
      methodCovered: 4,
      branchMissed: 4,
      branchCovered: 6,
    });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      MVN_SCRIPT_PATH,
      ["regression", "--agent", "mvn-regression-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("regression");
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.failed).toBe(0);
    expect(event.coverage?.lines?.total).toBe(10);
    expect(event.coverage?.lines?.covered).toBe(8);
    expect(event.coverage?.functions?.total).toBe(5);
    expect(event.coverage?.functions?.covered).toBe(4);
    expect(event.coverage?.branches?.total).toBe(10);
    expect(event.coverage?.branches?.covered).toBe(6);
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("with an ACTIVE cycle seeded server-side + WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE set, the 'unit' tier ingest records full context: cycleId comes from the agent's REGISTERED BINDING (WORKFLOW_CYCLE_ID set to a DIFFERENT real cycle changes nothing)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-unit-context");
    // CR-CRU-056 §S1/§S3: seed an ACTIVE cycle server-side; feed the OTHER
    // (real, but pending) cycle to WORKFLOW_CYCLE_ID to prove it's ignored
    // (nobody reads it any more — the client-side auto-attach resolver this
    // env var used to feed is deleted).
    const plan = await filePlan(baseUrl, key, "CR-MC-CONTEXT");
    const activeCycleId = plan.cycles[0]!.id;
    const otherCycleId = plan.cycles[1]!.id;
    await activateCycle(baseUrl, key, plan.planId, activeCycleId);
    const dir = fixtureDir(key);
    const reportsDir = join(dir, "target", "surefire-reports");
    Bun.spawnSync({ cmd: ["mkdir", "-p", reportsDir] });
    writeJunitXml(join(reportsDir, "TEST-FooTest.xml"), "FooTest", [{ name: "testOne" }]);
    runGit(["init", "-q"], dir);
    runGit(["symbolic-ref", "HEAD", "refs/heads/cr-cru-008-c3-mvn-fixture-branch"], dir);
    writeFileSync(join(dir, ".gitkeep"), "");
    runGit(["add", "."], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);

    // CR-CRU-056 §S3 — the 'unit' tier verb itself never registers/binds an
    // agent; the server now stamps a run's context.cycleId ONLY from an
    // ALREADY-BOUND agent row. Explicitly pre-register the same agent id
    // bound to the real active cycle so the ingest below has a binding to
    // stamp from — this replaces the deleted server-side "active cycle"
    // GUESS this test used to exercise.
    await runScript(
      MVN_SCRIPT_PATH,
      ["register", "--agent", "mvn-context-agent", "--phase", "RED", "--cycle", String(activeCycleId), "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    await runScript(
      MVN_SCRIPT_PATH,
      ["unit", "--test", "FooTest", "--agent", "mvn-context-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: {
          WORKFLOW_CYCLE_ID: String(otherCycleId),
          WORKFLOW_CYCLE: "rust-crucible + mvn-crucible v2 upgrade",
          WORKFLOW_WAVE: "wave-4",
          WORKFLOW_ROLE: "track-3",
        },
      },
    );

    // Two events now: the explicit pre-registration's lifecycle event, plus
    // the 'unit' tier's test event — events are returned newest-first
    // (ORDER BY timestamp DESC), so events[0] is still the ingest event.
    const eventsWithContext = await getEvents(baseUrl, key);
    expect(eventsWithContext.length).toBe(2);
    const eventWithContext = await getFullEvent(baseUrl, eventsWithContext[0]!.id);
    expect(eventWithContext.context?.cycleId).toBe(activeCycleId);
    expect(eventWithContext.context?.cycle).toBe("rust-crucible + mvn-crucible v2 upgrade");
    expect(eventWithContext.context?.wave).toBe("wave-4");
    expect(eventWithContext.context?.orchestrator).toBe("track-3");
    expect(eventWithContext.context?.git?.branch).toBe("cr-cru-008-c3-mvn-fixture-branch");
    expect(typeof eventWithContext.context?.git?.commit).toBe("string");
  });

  test("CR-CRU-036 §S1 tolerant path: NO open plan at all + no WORKFLOW_* env — the 'unit' tier ingest proceeds and the event has no context key", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-unit-no-context");
    const dir = fixtureDir(key);
    const reportsDir = join(dir, "target", "surefire-reports");
    Bun.spawnSync({ cmd: ["mkdir", "-p", reportsDir] });
    writeJunitXml(join(reportsDir, "TEST-FooTest.xml"), "FooTest", [{ name: "testOne" }]);

    await runScript(
      MVN_SCRIPT_PATH,
      ["unit", "--test", "FooTest", "--agent", "mvn-no-context-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context).toBeUndefined();
  });
});

describe("clients/mvn-crucible.py — auto-ingest: JaCoCo coverage passthrough with NO maven invocation at all (CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("auto-ingest --coverage on an all-green surefire dir + jacoco.csv → POST /api/v2/runs/parsed (never v1 /api/ingest/parsed) with coverage attached; NO mvnw present anywhere in the fixture", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-auto-ingest-coverage");
    const dir = scratch.dir("mvn-crucible-auto-ingest-");
    writeEnvFile(dir, key);
    // Deliberately NO mvnw executable anywhere — auto-ingest must never shell
    // out to maven when pre-existing reports satisfy the ingest.
    const reportsDir = join(dir, "target", "surefire-reports");
    const jacocoDir = join(dir, "target", "jacoco-report");
    Bun.spawnSync({ cmd: ["mkdir", "-p", reportsDir] });
    Bun.spawnSync({ cmd: ["mkdir", "-p", jacocoDir] });
    writeJunitXml(join(reportsDir, "TEST-FooTest.xml"), "FooTest", [{ name: "testOne" }, { name: "testTwo" }]);
    writeJacocoCsv(join(jacocoDir, "jacoco.csv"), {
      lineMissed: 2,
      lineCovered: 8,
      methodMissed: 1,
      methodCovered: 4,
      branchMissed: 4,
      branchCovered: 6,
    });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      MVN_SCRIPT_PATH,
      ["auto-ingest", "--agent", "mvn-auto-ingest-agent", "--coverage", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.failed).toBe(0);
    expect(event.coverage?.lines?.total).toBe(10);
    expect(event.coverage?.lines?.covered).toBe(8);
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });
});

describe("clients/mvn-crucible.py — byte-compatible CLI surface (existing flags unchanged post-upgrade)", () => {
  test("register/unregister/unit/module/e2e/regression/auto-ingest --help still expose today's exact flag names", async () => {
    const cases: Array<[string, string[]]> = [
      ["register", ["--agent", "--phase", "--message", "--project-dir", "--maven-dir"]],
      ["unregister", ["--agent", "--project-dir", "--maven-dir"]],
      ["unit", ["--test", "--agent", "--module", "--also-make", "--native", "--profile", "--system-prop", "--project-dir", "--log"]],
      ["module", ["--agent", "--module", "--also-make", "--project-dir"]],
      ["e2e", ["--agent", "--failsafe-only", "--with-docker", "--compose-file", "--no-wait", "--project-dir"]],
      ["regression", ["--agent", "--goal", "--coverage-profile", "--project-dir"]],
      ["auto-ingest", ["--agent", "--coverage", "--module", "--project-dir"]],
    ];
    for (const [subcommand, flags] of cases) {
      const proc = Bun.spawn({
        cmd: ["uv", "run", MVN_SCRIPT_PATH, subcommand, "--help"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      for (const flag of flags) {
        expect(stdout.includes(flag)).toBe(true);
      }
    }
  });
});

// CR-CRU-050 §S1/§S1b/§S3/§S2 — mvn-crucible.py:641 (`_parse_junit`) is the
// REFERENCE implementation this whole CR fixed the other four clients
// toward, and MUST NOT CHANGE. `regression` (cmd_regression → _regression_run)
// ALWAYS routes through `_parse_junit` regardless of report-dir count, so it
// is the deterministic way to pin that reference behaviour directly. mvn's
// COUNTING was therefore already correct before this CR; what this CR DID
// change on mvn, per the dispatch's Part C, is purely its PRINT surfaces: the
// TOON `run:` block (`_emit_ingest_summary_axi`, mvn-crucible.py:377-392)
// dropped `pending` from the printed envelope even though the summary it's
// built from already carried the real count, and — separately — the
// single-report-dir path's OWN TOON block (`_emit_ingest_axi_resp`,
// mvn-crucible.py:361-374) and its "ingest junit: ..." stderr line
// (mvn-crucible.py:720-722) did the same for the SERVER-parsed junit-dir path.
// All three now carry `pending`, which is what the tests below pin.
describe("clients/mvn-crucible.py — CR-CRU-050: _parse_junit (mvn-crucible.py:641) is CONFIRMED correct (counts AND leaf status) — pinned, not assumed; its TOON run: block carries pending (fake mvnw)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  function fixtureDirCr050(key: string): string {
    const dir = scratch.dir("mvn-crucible-cr050-regression-");
    writeEnvFile(dir, key);
    writeExecutable(join(dir, "mvnw"), NOOP_SCRIPT);
    return dir;
  }

  test("'regression' (client-side _parse_junit, the reference impl): a skipped surefire testcase is CONFIRMED pending=1 (never folded into passed), and its leaf CONFIRMED status 'pending' (not 'pass') — mvn's counting was already correct and is UNCHANGED, not assumed; the TOON run: block (§S2) now carries pending too", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-cr050-regression-reference");
    const dir = fixtureDirCr050(key);
    const reportsDir = join(dir, "target", "surefire-reports");
    Bun.spawnSync({ cmd: ["mkdir", "-p", reportsDir] });
    writeJunitXml(join(reportsDir, "TEST-CR050Test.xml"), "CR050Test", [
      { name: "testAlpha" },
      { name: "testBeta", fail: true },
      { name: "testGamma", skip: true },
    ]);

    const res = await runScript(
      MVN_SCRIPT_PATH,
      ["regression", "--agent", "mvn-cr050-regression-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    // CONFIRMATION (not a RED) — mvn-crucible.py:641 already gets this right.
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.failed).toBe(1);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.pending).toBe(1);
    const s = event.summary!;
    expect((s.passed ?? 0) + (s.failed ?? 0) + (s.pending ?? 0)).toBe(s.total);
    const leaves = (event.tree ?? []).flatMap((suite) => suite.children);
    const skipLeaf = leaves.find((l) => l.name === "testGamma");
    expect(skipLeaf?.status).toBe("pending");
    expect(skipLeaf?.status).not.toBe("pass");

    // §S2 — the TOON run: block (_emit_ingest_summary_axi) now carries pending.
    const block = extractRunBlock(res.stdout);
    expect(block).toBeDefined();
    expect(block).toContain("pending: 1");

    // CONFIRMATION — mvn's OWN "ingest parsed: ..." stderr line (mvn:752-754)
    // already prints pending — it was never broken, unlike the other clients'
    // equivalent lines.
    expect(res.stderr).toContain("ingest parsed:");
    expect(res.stderr).toContain("pending=1");
  });
});

describe("clients/mvn-crucible.py — CR-CRU-050 §S2: the single-surefire-dir path ('test', server-parsed via the junit codec) carries pending in its TOON run: block and its 'ingest junit: ...' print line (fake mvnw)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("event.summary.pending=1 is already correct (server-side junit codec, confirmed not assumed); the TOON run: block and the plain 'ingest junit: ...' stderr line both carry pending=1 too", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-mc-cr050-unit-junit-dir");
    const dir = scratch.dir("mvn-crucible-cr050-unit-");
    writeEnvFile(dir, key);
    writeExecutable(join(dir, "mvnw"), NOOP_SCRIPT);
    const reportsDir = join(dir, "target", "surefire-reports");
    Bun.spawnSync({ cmd: ["mkdir", "-p", reportsDir] });
    writeJunitXml(join(reportsDir, "TEST-CR050UnitTest.xml"), "CR050UnitTest", [
      { name: "testOne" },
      { name: "testTwo", skip: true },
    ]);

    const res = await runScript(
      MVN_SCRIPT_PATH,
      ["test", "--agent", "mvn-cr050-unit-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    // Positive pin — the server's junit codec already gets this right.
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.failed).toBe(0);
    expect(event.summary?.pending).toBe(1);
    expect(res.code).toBe(0);

    // §S2 — the TOON run: block (_emit_ingest_axi_resp).
    const block = extractRunBlock(res.stdout);
    expect(block).toBeDefined();
    expect(block).toContain("pending: 1");

    // §S2 (extended) — the plain "ingest junit: ..." stderr line
    // (mvn-crucible.py:720-722).
    expect(res.stderr).toContain("ingest junit:");
    expect(res.stderr).toContain("pending=1");
  });
});
