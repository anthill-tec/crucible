// CR-CRU-008 C4 — clients/python-crucible.py + clients/arduino-crucible.py v2
// contract (RED) + the "no-XML fallback 400 bug" fix.
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md — §S2 script fleet
// upgrade (v2 endpoints, tier per subcommand, git/wave/orchestrator/cycle
// context, --role optional) + Implementation Notes: "python-crucible.py
// no-XML fallback 400 bug: carried from the 2026-07-16 python-side cycle —
// fix during §S2." This cycle (C4) upgrades python-crucible.py and
// arduino-crucible.py.
//
// Current state: BOTH `clients/python-crucible.py` and
// `clients/arduino-crucible.py` EXIST in-repo and are exactly what these
// tests drive — every test spawns `python3 clients/<script>.py ...` against
// a REAL test server. The in-repo `clients/` copies are the SOURCE OF
// TRUTH. The old `~/.claude/scripts/*.py` mirror is RETIRED: do NOT run it,
// point tests at it, or treat it as the client source — running the mirror
// ORPHANS Crucible runs. (History, for context only: this file first landed
// as C4's RED, when neither client existed on the branch yet and every
// spawn failed with python3 exit 2 "can't open file" — the same RED shape
// as C2 (bun) / C3 (rust+mvn); the v1 scripts were then copied into
// `clients/` and upgraded there by GREEN. That is how the file began, not
// how it reads today.)
//
// Technique reused verbatim from C2/C3: a real `startServer({port:0,
// dbPath:":memory:"})` instance + `Bun.spawn`, plus the CAPTURING PROXY
// (`startCapturingProxy`) that pins the EXACT URLs the spawned script hit
// (v2-only, NEVER the v1 shim) without reading the script's source.
//
// FIXTURE-ROUTE DECISION (read before touching this file — a real
// environmental finding, not a workaround of convenience):
//   `python3 -c "import xmlrunner"` FAILS on this machine (and presumably
//   in CI/GREEN's sandbox too) — `unittest-xml-reporting` is not installed
//   system-wide, and installing it is a network dependency we will NOT bake
//   into a committed test's runtime behavior. Two consequences:
//
//   1. For the SUCCESS paths (v2 endpoint pinning, tier map, context
//      enrichment, coverage passthrough) we cannot spawn a REAL xmlrunner/
//      coverage.py and get real JUnit XML out of it. So — mirroring C3's
//      "fake cargo"/"fake mvnw" NOOP_SCRIPT trick, adapted for tools
//      invoked via `python -m <module>` rather than a PATH executable — we
//      drop two tiny FAKE PYTHON PACKAGES (`xmlrunner`, `coverage`) on
//      PYTHONPATH ahead of the real ones. `xmlrunner/__main__.py` reads a
//      `-o <reports_dir>` flag (works for BOTH `discover -s .. -o dir` and
//      a targeted `tests.foo -o dir` invocation — the two shapes
//      python-crucible.py's `_xmlrunner_cmd` builds) and writes a
//      caller-scripted JUnit XML there (`$FAKE_XMLRUNNER_JUNIT_XML`,
//      `$FAKE_XMLRUNNER_EXIT_CODE`) — this is necessary (not just
//      convenient) because python-crucible's `cmd_test`/`cmd_regression`
//      unconditionally `_wipe()` the reports dir immediately before running,
//      so a pre-placed (not written-at-invocation-time) XML fixture would
//      be deleted before a no-op runner ever got to preserve it. The fake
//      `coverage/__main__.py` handles `run --source X -m xmlrunner ...` by
//      re-invoking `python -m xmlrunner ...` as a subprocess (inheriting
//      PYTHONPATH, so it hits the fake xmlrunner too) and `lcov -o <path>`
//      by writing a caller-scripted LCOV (`$FAKE_COVERAGE_LCOV`). Verified
//      empirically end-to-end before writing these tests (both invocation
//      shapes, both subcommands, real `coverage` package correctly shadowed
//      by the PYTHONPATH-first fake).
//   2. For the HEADLINE no-XML-fallback bug itself, we do NOT need any
//      fixture at all: the real, already-true absence of `xmlrunner` on
//      this interpreter IS the no-XML scenario — `python3 -m xmlrunner ...`
//      exits 1 with stderr `No module named xmlrunner` (a ModuleNotFoundError,
//      an ImportError subtype — "tests fail to collect" in the most literal
//      possible sense) and produces zero `TEST-*.xml` files, deterministically
//      and portably, with ZERO setup. This is arguably a MORE faithful
//      real-world reproduction of the bug in this repo's own dev/CI sandbox
//      than a synthetic fixture module would be. We assert the resulting
//      `/api/v2/runs/compile` event's `compile.raw` contains the real
//      captured "No module named" text (never the dead placeholder string
//      `xmlrunner produced no JUnit XML (import/syntax failure)`, and never
//      an empty string that the server would 400 on).
//
// arduino-crucible.py needs no such fixture gymnastics: `unit` shells to a
// real `make` binary (faked as a no-op PATH executable, exactly like C3's
// NOOP_SCRIPT — and arduino's `cmd_unit` does NOT wipe its reports dir
// first, so a pre-placed JUnit XML fixture survives untouched) and
// `compile` shells to `$ARDUINO_CLI` (faked as a small script that prints a
// deterministic error to stderr and exits 1 — already captured today via
// `capture_output=True`, so arduino has no no-XML/empty-errors bug at all;
// only the endpoint/tier/context migration applies to it).
//
// v2 endpoint ground truth (read directly from src/v2.ts, NOT assumed):
// `POST /api/v2/agents/register`, `POST /api/v2/agents/unregister`,
// `POST /api/v2/projects` ({key?, name} — key must be a UUID or omitted;
// a pre-existing key returns 200 {changed:false}, perfect for arduino's
// idempotent self-registration), `POST /api/v2/runs/parsed` (summary+tree,
// v2 equivalent of v1 `/api/ingest/parsed`), `POST /api/v2/runs/compile`
// (rejects an EMPTY `errors` string with 400 — src/v2.ts:473 — this is the
// exact 400 the CR's bug note is about), `GET /api/v2/events/<id>` returns
// `event.compile` = the full `CompileReport` {format, errorCount,
// warningCount, diagnostics, raw} for a compile-kind event (src/store.ts,
// src/codecs/compile.ts — `raw` always preserves the verbatim input text,
// even when format-specific parsing finds no diagnostics).
//
// register/context conventions mirrored verbatim from the ALREADY-upgraded
// clients/rust-crucible.py and clients/bun-crucible.py (read directly, not
// assumed): `--role` defaults to `"report"` and the register message is
// `f"Starting {role} phase"`; `_run_context()` reads WORKFLOW_CYCLE_ID
// (int-coerced)/WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE, attaches
// `git: {branch, commit}` via a plain `git rev-parse` from CWD (tolerant of
// a non-repo cwd), and returns None (→ no `context` key at all) when NO
// WORKFLOW_* var is set.
//
// Scope note on arduino's `register --role` (deliberate, NOT an oversight):
// arduino-crucible.py's `--role` is ALREADY optional today (message
// defaults to "online", not a hard failure) — unlike python's, which
// currently `required=True`s it with an explicit choices list (the real
// ergonomics bug). We do not assert arduino's no-`--role` message contains
// "report": the CR's ergonomics note is specifically about hard-requiring
// `--role` (bun/python), and inventing a wording change for a script that
// was never broken here would be speculative scope-creep. We DO assert
// arduino's register (with `--role` given, matching today's real call
// sites) hits the v2 endpoint.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

const PYTHON_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "python-crucible.py");
const ARDUINO_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "arduino-crucible.py");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns `uv run <scriptPath> <args>`. Strips any ambient WORKFLOW_* env so
 * each test controls it explicitly, and always injects CRUCIBLE_URL — the
 * contract under test (both v1 scripts hardcode a base URL; the C4 upgrade
 * must honor $CRUCIBLE_URL so tests can point it at an ephemeral-port test
 * server / capturing proxy instead).
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
 * response back untouched. Reused verbatim from C2/C3.
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
 * CR-CRU-056 §S2b fixture-repair (C3): GET .../events, filtering out the
 * "lifecycle" events an `ensureRegistered()` call journals (CR-CRU-011 §S1)
 * — the fixtures below that pre-register an agent so a spawned client's
 * ingest is no longer refused (409) must not fold that registration's own
 * event into the ingest count assertions they pin. Distinct from the plain
 * `getEvents` above, which some already-passing tests in this file rely on
 * to literally count lifecycle events too (e.g. the context-enrichment
 * tests pinning events.length===3) — never change those, add calls to this
 * filtered helper instead.
 */
async function nonLifecycleEvents(baseUrl: string, key: string): Promise<Array<{ id: string }>> {
  const res = await fetch(`${baseUrl}/api/v2/events?project=${key}`);
  const body = (await res.json()) as { events: Array<{ id: string; kind?: string }> };
  return body.events.filter((e) => e.kind !== "lifecycle");
}

/**
 * CR-CRU-056 §S2b fixture-repair (C3): every ingesting verb now refuses an
 * unregistered agentId (409) — spawn the given client's own
 * `register --role report` verb (needs no cycle binding) for the SAME
 * agentId a following runScript call will ingest under, against the same
 * fixture server.
 */
async function ensureRegistered(
  scriptPath: string,
  agentId: string,
  opts: { cwd: string; crucibleUrl: string; projectDir?: string; env?: Record<string, string | undefined> },
): Promise<void> {
  await runScript(
    scriptPath,
    ["register", "--agent", agentId, "--role", "report", "--project-dir", opts.projectDir ?? opts.cwd],
    { cwd: opts.cwd, crucibleUrl: opts.crucibleUrl, env: opts.env },
  );
}

// CR-CRU-056 §S2b fixture-repair: plan-file/cycle-transition are mutating v2
// workflow verbs and now refuse an unregistered caller (409) — register a
// fixture orchestrator for the project before either call.
async function ensureFixtureOrchestrator(baseUrl: string, key: string): Promise<void> {
  await fetch(`${baseUrl}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId: "fixture-orch", role: "ORCHESTRATOR" }),
  });
}

/**
 * Files a real OPEN plan with two `pending` cycles (neither active) — the
 * CR-CRU-036 §S1 fixture primitive: "open plan, no active cycle" until
 * `activateCycle` below promotes one of them.
 */
async function filePlan(baseUrl: string, key: string, cr: string): Promise<{ planId: number; cycles: Array<{ id: number }> }> {
  await ensureFixtureOrchestrator(baseUrl, key);
  const res = await fetch(`${baseUrl}/api/v2/projects/${key}/plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cr, cycles: [{ label: "A" }, { label: "B" }], agentId: "fixture-orch" }),
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
  await ensureFixtureOrchestrator(baseUrl, key);
  await fetch(`${baseUrl}/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "active", agentId: "fixture-orch" }),
  });
}

interface FullEvent {
  tier?: string;
  codec?: string;
  kind?: string;
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
  };
  compile?: {
    raw?: string;
    errorCount?: number;
    warningCount?: number;
    format?: string;
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
      GIT_AUTHOR_NAME: "clients-python-arduino-crucible-test",
      GIT_AUTHOR_EMAIL: "clients-python-arduino-crucible-test@example.com",
      GIT_COMMITTER_NAME: "clients-python-arduino-crucible-test",
      GIT_COMMITTER_EMAIL: "clients-python-arduino-crucible-test@example.com",
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

/** A no-op stand-in for `make`/`arduino-cli` — never touches the filesystem
 * (except the fake ARDUINO_CLI, which deliberately writes to stderr), so
 * pre-placed report fixtures survive untouched. Mirrors C3's NOOP_SCRIPT. */
const NOOP_SCRIPT = "#!/bin/sh\nexit 0\n";

function writeEnvFile(dir: string, projectKey: string): void {
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
}

function writeArduinoEnvFile(dir: string, projectKey: string, projectName: string): void {
  writeFileSync(
    join(dir, ".env"),
    `CRUCIBLE_PROJECT_KEY=${projectKey}\nCRUCIBLE_PROJECT_NAME=${projectName}\n`,
  );
}

/** Minimal JUnit XML (`<testsuite><testcase>...`) — the shape both
 * python-crucible's `_parse_junit_dir` and arduino-crucible's `_parse_junit`
 * parse (both use xml.etree.ElementTree over testsuite/testcase/failure).
 * CR-CRU-050 §S1/§S1b — `skip` emits a bare `<skipped/>` child (xmlrunner's
 * and the native-harness's real shape for a skipped testcase), which the
 * defective parsers fold into `passed` today via a bare `else:`. */
function junitXmlString(
  suiteName: string,
  cases: Array<{ name: string; fail?: boolean; skip?: boolean }>,
): string {
  const testcases = cases
    .map((c) => {
      if (c.fail) return `<testcase name="${c.name}" time="0.01"><failure message="boom">boom</failure></testcase>`;
      if (c.skip) return `<testcase name="${c.name}" time="0.01"><skipped/></testcase>`;
      return `<testcase name="${c.name}" time="0.01"/>`;
    })
    .join("");
  return `<?xml version="1.0"?><testsuite name="${suiteName}" tests="${cases.length}">${testcases}</testsuite>`;
}

function writeJunitXml(
  path: string,
  suiteName: string,
  cases: Array<{ name: string; fail?: boolean; skip?: boolean }>,
): void {
  writeFileSync(path, junitXmlString(suiteName, cases));
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

/**
 * Two FAKE python packages (`xmlrunner`, `coverage`) dropped into their own
 * directory so a caller can prepend it onto PYTHONPATH ahead of the real
 * (here: absent for xmlrunner, present for coverage) packages. See the
 * file-header FIXTURE-ROUTE DECISION for why this exists and was verified.
 *
 * `xmlrunner/__main__.py`: finds the trailing `-o <reports_dir>` flag
 * (present in BOTH the `discover -s .. -p .. -o dir` and the targeted
 * `tests.foo -o dir` invocation python-crucible.py's `_xmlrunner_cmd`
 * builds), writes `$FAKE_XMLRUNNER_JUNIT_XML` there as `TEST-fake_fixture.xml`
 * when set, and exits with `$FAKE_XMLRUNNER_EXIT_CODE` (default 0).
 *
 * `coverage/__main__.py`: `run --source X -m xmlrunner ...` re-invokes
 * `python -m xmlrunner ...` as a real subprocess (inherits PYTHONPATH, so it
 * hits the fake xmlrunner above); `lcov -o <path>` writes
 * `$FAKE_COVERAGE_LCOV` (or a small default) to `<path>`.
 */
function writeFakePyModules(rootDir: string): string {
  const xmlrunnerDir = join(rootDir, "xmlrunner");
  const coverageDir = join(rootDir, "coverage");
  mkdirSync(xmlrunnerDir, { recursive: true });
  mkdirSync(coverageDir, { recursive: true });
  writeFileSync(join(xmlrunnerDir, "__init__.py"), "");
  writeFileSync(
    join(xmlrunnerDir, "__main__.py"),
    `import os, sys
reports_dir = None
argv = sys.argv[1:]
for i, a in enumerate(argv):
    if a == "-o" and i + 1 < len(argv):
        reports_dir = argv[i + 1]
if reports_dir:
    os.makedirs(reports_dir, exist_ok=True)
    content = os.environ.get("FAKE_XMLRUNNER_JUNIT_XML")
    if content:
        with open(os.path.join(reports_dir, "TEST-fake_fixture.xml"), "w") as f:
            f.write(content)
sys.exit(int(os.environ.get("FAKE_XMLRUNNER_EXIT_CODE", "0")))
`,
  );
  writeFileSync(join(coverageDir, "__init__.py"), "");
  writeFileSync(
    join(coverageDir, "__main__.py"),
    `import os, sys, subprocess

def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(0)
    sub = args[0]
    if sub == "lcov":
        out = None
        for i, a in enumerate(args):
            if a == "-o" and i + 1 < len(args):
                out = args[i + 1]
        if out:
            content = os.environ.get(
                "FAKE_COVERAGE_LCOV",
                "SF:app/lib.py\\nFNF:5\\nFNH:4\\nLF:10\\nLH:8\\nend_of_record\\n",
            )
            with open(out, "w") as f:
                f.write(content)
        sys.exit(0)
    if sub == "run":
        try:
            m_idx = args.index("-m")
        except ValueError:
            sys.exit(0)
        module_and_rest = args[m_idx + 1:]
        r = subprocess.run([sys.executable, "-m", *module_and_rest])
        sys.exit(r.returncode)
    sys.exit(0)

main()
`,
  );
  return rootDir;
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
// clients/python-crucible.py
// ═══════════════════════════════════════════════════════════════════════

describe("clients/python-crucible.py — v2 endpoints + CRUCIBLE_URL + register ergonomics (CR-CRU-008 §S2)", () => {
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
    const key = await createProject(baseUrl, "clients-pc-register-v2");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);
    // CR-CRU-056 §S2/§S3c — RED (a TDD role) now REQUIRES an explicit
    // cycle binding; this test's subject (which endpoint/verb gets hit) is
    // unaffected, so a fixture plan+active-cycle is filed and reused (same
    // primitive as filePlan/activateCycle used elsewhere in this file).
    const plan = await filePlan(baseUrl, key, "CR-PC-register-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p1", "--role", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).toContain("p1");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/register"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/heartbeat")).toBe(false);
  });

  test("unregister hits POST /api/v2/agents/unregister (never v1 /api/agents/remove); agent vanishes from GET /api/v2/agents", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-unregister-v2");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);
    // CR-CRU-056 §S2/§S3c — same reused fixture: RED needs a bound cycle
    // before this test's actual subject (the unregister verb/path) runs.
    const plan = await filePlan(baseUrl, key, "CR-PC-unregister-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p2", "--role", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );
    expect(await getAgentIds(baseUrl, key)).toContain("p2");

    const res = await runScript(PYTHON_SCRIPT_PATH, ["unregister", "--agent", "p2", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
    });

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).not.toContain("p2");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/unregister"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  });

  test("register --agent X --role report succeeds and records the declared report role", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-role-optional");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p3", "--role", "report", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    const agents = await getAgents(baseUrl, key);
    const agent = agents.find((a) => a.agentId === "p3");
    expect(agent).toBeDefined();
    expect(agent!.message.toLowerCase()).toContain("report");
  });

  // CR-CRU-056 §S2/§S3/§S3c — the CR-036 client-side auto-attach resolver
  // is DELETED; re-pointed into the new unconditional contract: a TDD-role
  // register with no explicit --cycle is REFUSED (non-zero exit, structured
  // ok:false envelope naming --cycle) regardless of plan state —
  // WORKFLOW_CYCLE_ID is read by nobody (confirmed live: even a REAL,
  // in-project, pending cycle id sitting in that env var changes nothing).
  test("CR-CRU-056 §S2: register --role RED with an OPEN plan but NO active cycle is REFUSED (non-zero exit, structured ok:false envelope naming --cycle), posts NO agent — a STALE WORKFLOW_CYCLE_ID pointing at a REAL cycle in this very plan changes NOTHING", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-PC-NO-ACTIVE-CYCLE");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p-no-cycle", "--role", "RED", "--project-dir", dir],
      // The deleted resolver's exact mechanism: nobody reads this env var
      // any more, so it must not rescue the registration.
      { cwd: dir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("p-no-cycle");
  });

  test("CR-CRU-056 §S2: register --role RED with NO open plan AT ALL is STILL refused the same way — the binding requirement is unconditional, not contingent on plan/cycle ambiguity (the old 'no plan, tolerant' escape hatch no longer exists)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-tolerant-no-plan");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p-no-plan", "--role", "RED", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("p-no-plan");
  });
});

describe("clients/python-crucible.py — test subcommand: v2-only ingest, tier:'unit', context enrichment (fake xmlrunner, CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();
  const branch = "cr-cru-008-c4-python-fixture-branch";

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  function fixtureDir(key: string): { dir: string; pythonPath: string } {
    const dir = scratch.dir("python-crucible-test-");
    writeEnvFile(dir, key);
    const pythonPath = writeFakePyModules(scratch.dir("python-crucible-fakepy-"));
    return { dir, pythonPath };
  }

  test("posts to /api/v2/runs/parsed (never v1 /api/ingest/parsed) with tier:'unit' and the parsed summary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-test-unit-tier");
    const { dir, pythonPath } = fixtureDir(key);
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-test-agent", { cwd: dir, crucibleUrl: baseUrl });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["test", "--agent", "python-test-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: proxy.url,
        env: {
          PYTHONPATH: pythonPath,
          FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("fixture", [
            { name: "one" },
            { name: "two" },
            { name: "three", fail: true },
          ]),
          FAKE_XMLRUNNER_EXIT_CODE: "1",
        },
      },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).not.toBe(0); // 1 of 3 fixture tests fails
    expect(event.tier).toBe("unit");
    expect(event.summary?.total).toBe(3);
    expect(event.summary?.passed).toBe(2);
    expect(event.summary?.failed).toBe(1);
    expect(proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed")).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("with an ACTIVE cycle seeded server-side + WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE set + a git repo, records full context: cycleId comes from the agent's REGISTERED BINDING (WORKFLOW_CYCLE_ID set to a DIFFERENT real cycle changes nothing), cycle, wave, orchestrator, auto-detected git branch/commit", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-test-context");
    // CR-CRU-056 §S1/§S3: seed an ACTIVE cycle server-side (plan-file +
    // activate cycles[0]). cycles[1] stays pending and is fed to
    // WORKFLOW_CYCLE_ID — a REAL, linkable, but NOT-active cycle — proving
    // the env var is read by nobody (the client-side auto-attach resolver
    // it used to feed is deleted).
    const plan = await filePlan(baseUrl, key, "CR-PC-CONTEXT");
    const activeCycleId = plan.cycles[0]!.id;
    const otherCycleId = plan.cycles[1]!.id;
    await activateCycle(baseUrl, key, plan.planId, activeCycleId);
    const { dir, pythonPath } = fixtureDir(key);
    runGit(["init", "-q"], dir);
    runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    writeFileSync(join(dir, ".gitkeep"), "");
    runGit(["add", "."], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);

    // CR-CRU-056 §S3 — the 'test' subcommand's own implicit agent-touch
    // never declares a role/cycle; the server now stamps a run's
    // context.cycleId ONLY from an ALREADY-BOUND agent row. Explicitly
    // pre-register the same agent id bound to the real active cycle so the
    // ingest below has a binding to stamp from.
    await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "python-context-agent", "--role", "RED", "--cycle", String(activeCycleId), "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    await runScript(
      PYTHON_SCRIPT_PATH,
      ["test", "--agent", "python-context-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: {
          PYTHONPATH: pythonPath,
          FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("fixture", [{ name: "one" }]),
          FAKE_XMLRUNNER_EXIT_CODE: "0",
          WORKFLOW_CYCLE_ID: String(otherCycleId),
          WORKFLOW_CYCLE: "python-crucible + arduino-crucible v2 upgrade + no-XML 400 fix",
          WORKFLOW_WAVE: "wave-4",
          WORKFLOW_ROLE: "track-4",
        },
      },
    );

    // Three events now: the fixture-orch registration filePlan()/activateCycle()
    // now require (CR-CRU-056 §S2b fixture-repair), the explicit
    // pre-registration's own lifecycle event, plus the 'test' subcommand's
    // test event — events are returned newest-first (ORDER BY timestamp
    // DESC), so events[0] is still the ingest event.
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(3);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context?.cycleId).toBe(activeCycleId);
    expect(event.context?.cycle).toBe("python-crucible + arduino-crucible v2 upgrade + no-XML 400 fix");
    expect(event.context?.wave).toBe("wave-4");
    expect(event.context?.orchestrator).toBe("track-4");
    expect(event.context?.git?.branch).toBe(branch);
    expect(typeof event.context?.git?.commit).toBe("string");
    expect((event.context?.git?.commit ?? "").length).toBeGreaterThan(0);
  });

  test("with no WORKFLOW_* env set, the stored event has NO context key at all (graceful absence)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-test-no-context");
    const { dir, pythonPath } = fixtureDir(key);
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-no-context-agent", { cwd: dir, crucibleUrl: baseUrl });

    await runScript(
      PYTHON_SCRIPT_PATH,
      ["test", "--agent", "python-no-context-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: {
          PYTHONPATH: pythonPath,
          FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("fixture", [{ name: "one" }]),
          FAKE_XMLRUNNER_EXIT_CODE: "0",
        },
      },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context).toBeUndefined();
  });
});

describe("clients/python-crucible.py — regression subcommand: tier:'regression', coverage.py passthrough (fake xmlrunner+coverage, CR-CRU-008 §S2)", () => {
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

  function fixtureDir(key: string): { dir: string; pythonPath: string } {
    const dir = scratch.dir("python-crucible-regression-");
    writeEnvFile(dir, key);
    const pythonPath = writeFakePyModules(scratch.dir("python-crucible-fakepy-"));
    return { dir, pythonPath };
  }

  test("'regression' (no --coverage) posts to /api/v2/runs/parsed (never v1 /api/ingest/parsed) with tier:'regression'", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-regression-tier");
    const { dir, pythonPath } = fixtureDir(key);
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-regression-agent", { cwd: dir, crucibleUrl: baseUrl });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["regression", "--agent", "python-regression-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: proxy.url,
        env: {
          PYTHONPATH: pythonPath,
          FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("regression_fixture", [
            { name: "alpha" },
            { name: "beta" },
          ]),
          FAKE_XMLRUNNER_EXIT_CODE: "0",
        },
      },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("regression");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(2);
    expect(proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed")).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("'regression --coverage' attaches event.coverage lines/functions from the fixture's fake coverage.py lcov output", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-regression-coverage");
    const { dir, pythonPath } = fixtureDir(key);
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-coverage-agent", { cwd: dir, crucibleUrl: baseUrl });

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["regression", "--coverage", "--agent", "python-coverage-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: {
          PYTHONPATH: pythonPath,
          FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("regression_fixture", [{ name: "alpha" }]),
          FAKE_XMLRUNNER_EXIT_CODE: "0",
          FAKE_COVERAGE_LCOV: "SF:app/lib.py\nFNF:6\nFNH:5\nLF:20\nLH:17\nend_of_record\n",
        },
      },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("regression");
    expect(event.coverage?.lines?.total).toBe(20);
    expect(event.coverage?.lines?.covered).toBe(17);
    expect(event.coverage?.functions?.total).toBe(6);
    expect(event.coverage?.functions?.covered).toBe(5);
  });

  // CR-CRU-036 C4 contract, re-scoped by CR-CRU-045 (gap-analysis disproved
  // the original C4 FIX-round reading): `_collect_coverage` runs
  // `python -m coverage lcov -o <path>` with `cwd=project_dir`
  // (clients/python-crucible.py:583). For a `-m` invocation Python prepends
  // the CURRENT WORKING DIRECTORY to sys.path AHEAD of PYTHONPATH, so a
  // `coverage/` subdirectory sitting directly in project_dir is on the
  // interpreter's path. The REAL hazard (this is bun's own lcov output
  // directory — it holds `lcov.info` plus temp files and carries NO
  // `__init__.py`) is a bare directory, i.e. a namespace package. A
  // namespace package loses to a regular package regardless of sys.path
  // order, so the real installed `coverage.py` (or, here, the fixture's
  // PYTHONPATH-supplied fake `coverage/__main__.py`, itself a regular
  // package) wins and collection proceeds normally — event.coverage still
  // reflects the real lcov figures. Empirically confirmed against the
  // project interpreter before re-pointing this test (see CR-CRU-045
  // Context table). This is CR-036's actual, currently-held guarantee.
  //
  // OUT OF SCOPE (CR-CRU-045 §S2 — do NOT "restore" this): a `coverage/`
  // directory that carries an `__init__.py` is a REGULAR package, not a
  // namespace package, and WILL shadow the real module while cwd is on
  // sys.path — that is inherent to running `python -m coverage` from any
  // project whose tree contains a `coverage` package, is not specific to
  // this client, and would cost a 3.11 floor (`python -P`) to defend
  // against a scenario `pyproject.toml`'s `requires-python = ">=3.10"`
  // does not support today. Deliberately left unguarded.
  test("CR-CRU-036 C4: a bare `coverage/` directory (no `__init__.py`, bun's real lcov output shape) present in project_dir does NOT shadow coverage.py collection — event.coverage reflects the real lcov output", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-regression-coverage-dir-shadow");
    const { dir, pythonPath } = fixtureDir(key);
    // The real hazard, not the over-specified one: a BARE `coverage/`
    // subdirectory (bun's actual lcov output shape — an lcov file, no
    // `__init__.py`) living directly in project_dir (project_dir IS the
    // subprocess cwd). No `__init__.py` here means this is a namespace
    // package, which loses to the regular `coverage` package found later
    // on sys.path (the fixture's fake, or a real install) — see CR-CRU-045.
    const shadowDir = join(dir, "coverage");
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, "lcov.info"), "SF:app/other.ts\nLF:3\nLH:2\nend_of_record\n");
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-coverage-shadow-agent", { cwd: dir, crucibleUrl: baseUrl });

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["regression", "--coverage", "--agent", "python-coverage-shadow-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: {
          PYTHONPATH: pythonPath,
          FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("regression_fixture", [{ name: "alpha" }]),
          FAKE_XMLRUNNER_EXIT_CODE: "0",
          FAKE_COVERAGE_LCOV: "SF:app/lib.py\nFNF:6\nFNH:5\nLF:20\nLH:17\nend_of_record\n",
        },
      },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("regression");
    expect(event.coverage?.lines?.total).toBe(20);
    expect(event.coverage?.lines?.covered).toBe(17);
    expect(event.coverage?.functions?.total).toBe(6);
    expect(event.coverage?.functions?.covered).toBe(5);
  });
});

describe("clients/python-crucible.py — the no-XML fallback fix (headline bug, CR-CRU-008 Implementation Notes): test AND regression carry REAL captured runner output, never the dead empty-string 400", () => {
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

  test("'test' with no XML produced (xmlrunner genuinely absent on this interpreter) → POST /api/v2/runs/compile with NON-EMPTY errors carrying the real captured ModuleNotFoundError text; server accepts (no 400, an event exists); exits non-zero", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-test-no-xml-fallback");
    const dir = scratch.dir("python-crucible-no-xml-");
    writeEnvFile(dir, key);
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-no-xml-agent", { cwd: dir, crucibleUrl: baseUrl });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(PYTHON_SCRIPT_PATH, ["test", "--agent", "python-no-xml-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      env: { PYTHONPATH: "", PYTHONNOUSERSITE: "1" },
    });

    expect(res.code).not.toBe(0);
    const events = await nonLifecycleEvents(baseUrl, key);
    // An event exists at all → the server accepted the ingest (never a 400
    // from an empty `errors` string, which would leave zero events stored).
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.compile?.raw).toBeDefined();
    expect((event.compile?.raw ?? "").length).toBeGreaterThan(0);
    expect(event.compile?.raw).toContain("No module named");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/compile"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/compile")).toBe(false);
  });

  test("'regression' with no XML produced NOW posts the same compile fallback (an event exists) instead of silently returning 1 with no ingest at all", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-regression-no-xml-fallback");
    const dir = scratch.dir("python-crucible-no-xml-regression-");
    writeEnvFile(dir, key);
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-no-xml-regression-agent", { cwd: dir, crucibleUrl: baseUrl });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["regression", "--agent", "python-no-xml-regression-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url, env: { PYTHONPATH: "", PYTHONNOUSERSITE: "1" } },
    );

    expect(res.code).not.toBe(0);
    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.compile?.raw).toBeDefined();
    expect((event.compile?.raw ?? "").length).toBeGreaterThan(0);
    expect(event.compile?.raw).toContain("No module named");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/compile"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/compile")).toBe(false);
  });
});

describe("clients/python-crucible.py — byte-compatible CLI surface (existing flags unchanged post-upgrade)", () => {
  test("register/unregister/test/regression/auto-ingest/check/pre-merge-gate --help still expose today's exact flag names", async () => {
    const cases: Array<[string, string[]]> = [
      ["register", ["--agent", "--role", "--display-name", "--source", "--message", "--project-dir"]],
      ["unregister", ["--agent", "--project-dir"]],
      ["test", ["--tests", "--agent", "--start-dir", "--pattern", "--reports", "--python", "--project-dir", "--log"]],
      [
        "regression",
        ["--agent", "--coverage", "--cov-source", "--start-dir", "--pattern", "--reports", "--python", "--project-dir", "--log"],
      ],
      ["auto-ingest", ["--agent", "--reports", "--project-dir"]],
      ["check", ["--paths", "--agent", "--python", "--project-dir"]],
      [
        "pre-merge-gate",
        ["--agent", "--cov-source", "--skip-check", "--start-dir", "--pattern", "--reports", "--python", "--project-dir", "--log"],
      ],
    ];
    for (const [subcommand, flags] of cases) {
      const proc = Bun.spawn({
        cmd: ["uv", "run", PYTHON_SCRIPT_PATH, subcommand, "--help"],
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

// CR-CRU-050 §S1/§S1b/§S2 — `_parse_junit_dir` (python-crucible.py:484-520)
// today checks only `tc.find("failure")`/`tc.find("error")`; a bare
// `else: passed += 1` folds every `<skipped/>` testcase into `passed`, and
// the summary hardcodes `"pending": 0`. mvn-crucible.py:641 is the correct
// precedent this fixes toward. `_emit_ingest_axi` (python-crucible.py:389-
// 404) also drops `pending` from the printed `run:` TOON block, and
// `_ingest_parsed`'s plain "ingest parsed: ..." stderr line (python-
// crucible.py:578-583) drops it too — both are §S2 surfaces.
describe("clients/python-crucible.py — CR-CRU-050 §S1/§S1b/§S2: <skipped/> testcases count as pending, never passed (fake xmlrunner)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();
  let runResult: RunResult | undefined;
  let event: FullEvent | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  function fixtureDir(key: string): { dir: string; pythonPath: string } {
    const dir = scratch.dir("python-crucible-cr050-");
    writeEnvFile(dir, key);
    const pythonPath = writeFakePyModules(scratch.dir("python-crucible-cr050-fakepy-"));
    return { dir, pythonPath };
  }

  test("§S1/§S1b/§S2: ingested summary counts the skipped testcase as pending=1 (never folded into passed), the skipped leaf carries tree status 'pending' (not 'pass'), the real pass/fail leaves are unaffected, and BOTH the TOON run: block and the plain 'ingest parsed: ...' stderr line carry pending=1", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-cr050-pending");
    const { dir, pythonPath } = fixtureDir(key);
    await ensureRegistered(PYTHON_SCRIPT_PATH, "python-cr050-agent", { cwd: dir, crucibleUrl: baseUrl });

    runResult = await runScript(
      PYTHON_SCRIPT_PATH,
      ["test", "--agent", "python-cr050-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: {
          PYTHONPATH: pythonPath,
          FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("cr050_fixture", [
            { name: "passes" },
            { name: "fails", fail: true },
            { name: "skipped_case", skip: true },
          ]),
          FAKE_XMLRUNNER_EXIT_CODE: "1",
        },
      },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    event = await getFullEvent(baseUrl, events[0]!.id);

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
    const skipLeaf = leaves.find((l) => l.name === "skipped_case");
    const passLeaf = leaves.find((l) => l.name === "passes");
    const failLeaf = leaves.find((l) => l.name === "fails");
    expect(skipLeaf?.status).toBe("pending");
    expect(skipLeaf?.status).not.toBe("pass");
    expect(passLeaf?.status).toBe("pass");
    expect(failLeaf?.status).toBe("fail");

    // §S2 — the TOON run: block carries pending.
    const block = extractRunBlock(runResult.stdout);
    expect(block).toBeDefined();
    expect(block).toContain("passed: 1");
    expect(block).toContain("failed: 1");
    expect(block).toContain("total: 3");
    expect(block).toContain("pending: 1");

    // §S2 (extended) — the plain "ingest parsed: ..." stderr line too.
    expect(runResult.stderr).toContain("ingest parsed:");
    expect(runResult.stderr).toContain("pending=1");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// clients/arduino-crucible.py
// ═══════════════════════════════════════════════════════════════════════

describe("clients/arduino-crucible.py — v2 endpoints + CRUCIBLE_URL (project self-registration, agent lifecycle) (CR-CRU-008 §S2)", () => {
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

  test("register hits BOTH POST /api/v2/projects (self-registration, never v1 /api/projects/add) AND POST /api/v2/agents/register (never v1 /api/agents/heartbeat) via CRUCIBLE_URL", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-register-v2");
    const dir = scratch.dir("arduino-crucible-proj-");
    writeArduinoEnvFile(dir, key, "clients-ac-register-v2");
    // CR-CRU-056 §S2/§S3c — RED (a TDD role) now REQUIRES an explicit
    // cycle binding; this test's subject (self-registration + which
    // endpoint/verb gets hit) is unaffected, so a fixture plan+active-cycle
    // is filed and reused (same primitive as filePlan/activateCycle used
    // elsewhere in this file).
    const plan = await filePlan(baseUrl, key, "CR-AC-register-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a1", "--role", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).toContain("a1");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/projects"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/projects/add")).toBe(false);
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/register"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/heartbeat")).toBe(false);
  });

  test("unregister hits POST /api/v2/agents/unregister (never v1 /api/agents/remove); agent vanishes from GET /api/v2/agents", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-unregister-v2");
    const dir = scratch.dir("arduino-crucible-proj-");
    writeArduinoEnvFile(dir, key, "clients-ac-unregister-v2");
    // CR-CRU-056 §S2/§S3c — same reused fixture: RED needs a bound cycle
    // before this test's actual subject (the unregister verb/path) runs.
    const plan = await filePlan(baseUrl, key, "CR-AC-unregister-v2");
    await activateCycle(baseUrl, key, plan.planId, plan.cycles[0]!.id);
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a2", "--role", "RED", "--cycle", String(plan.cycles[0]!.id), "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );
    expect(await getAgentIds(baseUrl, key)).toContain("a2");

    const res = await runScript(ARDUINO_SCRIPT_PATH, ["unregister", "--agent", "a2", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
    });

    expect(res.code).toBe(0);
    expect(await getAgentIds(baseUrl, key)).not.toContain("a2");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/agents/unregister"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  });

  // CR-CRU-056 §S2/§S3/§S3c — the CR-036 client-side auto-attach resolver
  // is DELETED; re-pointed into the new unconditional contract: a TDD-role
  // register with no explicit --cycle is REFUSED (non-zero exit, structured
  // ok:false envelope naming --cycle) regardless of plan state —
  // WORKFLOW_CYCLE_ID is read by nobody (confirmed live: even a REAL,
  // in-project, pending cycle id sitting in that env var changes nothing).
  test("CR-CRU-056 §S2: register --role RED with an OPEN plan but NO active cycle is REFUSED (non-zero exit, structured ok:false envelope naming --cycle), posts NO agent — a STALE WORKFLOW_CYCLE_ID pointing at a REAL cycle in this very plan changes NOTHING", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-AC-NO-ACTIVE-CYCLE");
    const dir = scratch.dir("arduino-crucible-proj-");
    writeArduinoEnvFile(dir, key, "clients-ac-no-active-cycle");

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a-no-cycle", "--role", "RED", "--project-dir", dir],
      // The deleted resolver's exact mechanism: nobody reads this env var
      // any more, so it must not rescue the registration.
      { cwd: dir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("a-no-cycle");
  });

  test("CR-CRU-056 §S2: register --role RED with NO open plan AT ALL is STILL refused the same way — the binding requirement is unconditional, not contingent on plan/cycle ambiguity (the old 'no plan, tolerant' escape hatch no longer exists)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-tolerant-no-plan");
    const dir = scratch.dir("arduino-crucible-proj-");
    writeArduinoEnvFile(dir, key, "clients-ac-tolerant-no-plan");

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a-no-plan", "--role", "RED", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("ok: false");
    expect(res.stdout).toContain("--cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("a-no-plan");
  });
});

describe("clients/arduino-crucible.py — unit subcommand: v2-only ingest, tier:'unit', context enrichment (fake no-op make, CR-CRU-008 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratch = makeScratchTracker();
  const branch = "cr-cru-008-c4-arduino-fixture-branch";

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  /** arduino-crucible's cmd_unit does NOT wipe its reports dir before
   * running `make junit` — unlike python-crucible's `test`/`regression` —
   * so a pre-placed JUnit XML fixture survives a no-op `make`, exactly
   * mirroring C3's fake cargo/mvnw NOOP_SCRIPT trick. */
  function fixtureDirWithFakeMake(
    key: string,
    name: string,
    cases: Array<{ name: string; fail?: boolean }>,
  ): { dir: string; path: string } {
    const dir = scratch.dir("arduino-crucible-unit-");
    writeArduinoEnvFile(dir, key, name);
    const reportsDir = join(dir, "tests", "native", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeJunitXml(join(reportsDir, "TEST-native_fixture.xml"), "native_fixture", cases);

    const binDir = scratch.dir("fake-make-bin-");
    writeExecutable(join(binDir, "make"), NOOP_SCRIPT);
    const path = `${binDir}:${process.env.PATH ?? ""}`;
    return { dir, path };
  }

  test("posts to /api/v2/runs/parsed (never v1 /api/ingest/parsed) with tier:'unit' and the parsed summary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-unit-tier");
    const { dir, path } = fixtureDirWithFakeMake(key, "clients-ac-unit-tier", [
      { name: "led_on" },
      { name: "led_off", fail: true },
    ]);
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-unit-agent", { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(ARDUINO_SCRIPT_PATH, ["unit", "--agent", "arduino-unit-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      env: { PATH: path },
    });

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).not.toBe(0); // one fixture test fails
    expect(event.tier).toBe("unit");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.failed).toBe(1);
    expect(proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed")).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("with an ACTIVE cycle seeded server-side + WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE set + a git repo, records full context: cycleId comes from the agent's REGISTERED BINDING (WORKFLOW_CYCLE_ID set to a DIFFERENT real cycle changes nothing), cycle, wave, orchestrator, auto-detected git branch/commit", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-unit-context");
    // CR-CRU-056 §S1/§S3: seed an ACTIVE cycle server-side; feed the OTHER
    // (real, but pending) cycle to WORKFLOW_CYCLE_ID to prove it's ignored
    // (nobody reads it any more — the client-side auto-attach resolver this
    // env var used to feed is deleted).
    const plan = await filePlan(baseUrl, key, "CR-AC-CONTEXT");
    const activeCycleId = plan.cycles[0]!.id;
    const otherCycleId = plan.cycles[1]!.id;
    await activateCycle(baseUrl, key, plan.planId, activeCycleId);
    const { dir, path } = fixtureDirWithFakeMake(key, "clients-ac-unit-context", [{ name: "led_on" }]);
    runGit(["init", "-q"], dir);
    runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
    // Don't commit the reports/ fixture — just an unrelated tracked file, so
    // the pre-placed JUnit fixture the test asserts on isn't disturbed.
    writeFileSync(join(dir, ".gitkeep"), "");
    runGit(["add", ".gitkeep"], dir);
    runGit(["commit", "-q", "-m", "initial"], dir);

    // CR-CRU-056 §S3 — the 'unit' subcommand's own implicit agent-touch
    // never declares a role/cycle; the server now stamps a run's
    // context.cycleId ONLY from an ALREADY-BOUND agent row. Explicitly
    // pre-register the same agent id bound to the real active cycle so the
    // ingest below has a binding to stamp from.
    await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "arduino-context-agent", "--role", "RED", "--cycle", String(activeCycleId), "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } },
    );

    await runScript(ARDUINO_SCRIPT_PATH, ["unit", "--agent", "arduino-context-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
      env: {
        PATH: path,
        WORKFLOW_CYCLE_ID: String(otherCycleId),
        WORKFLOW_CYCLE: "python-crucible + arduino-crucible v2 upgrade + no-XML 400 fix",
        WORKFLOW_WAVE: "wave-4",
        WORKFLOW_ROLE: "track-4",
      },
    });

    // Three events now: the fixture-orch registration filePlan()/activateCycle()
    // now require (CR-CRU-056 §S2b fixture-repair), the explicit
    // pre-registration's own lifecycle event, plus the 'unit' subcommand's
    // test event — events are returned newest-first (ORDER BY timestamp
    // DESC), so events[0] is still the ingest event.
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(3);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context?.cycleId).toBe(activeCycleId);
    expect(event.context?.cycle).toBe("python-crucible + arduino-crucible v2 upgrade + no-XML 400 fix");
    expect(event.context?.wave).toBe("wave-4");
    expect(event.context?.orchestrator).toBe("track-4");
    expect(event.context?.git?.branch).toBe(branch);
    expect(typeof event.context?.git?.commit).toBe("string");
    expect((event.context?.git?.commit ?? "").length).toBeGreaterThan(0);
  });

  test("with no WORKFLOW_* env set, the stored event has NO context key at all (graceful absence)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-unit-no-context");
    const { dir, path } = fixtureDirWithFakeMake(key, "clients-ac-unit-no-context", [{ name: "led_on" }]);
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-no-context-agent", { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } });

    await runScript(ARDUINO_SCRIPT_PATH, ["unit", "--agent", "arduino-no-context-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
      env: { PATH: path },
    });

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context).toBeUndefined();
  });
});

describe("clients/arduino-crucible.py — compile subcommand: v2-only ingest on failure (fake ARDUINO_CLI, CR-CRU-008 §S2)", () => {
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

  test("a failing fake ARDUINO_CLI → POST /api/v2/runs/compile (never v1 /api/ingest/compile) carrying the fake compiler's captured stderr text; exits non-zero", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-compile-fail");
    const dir = scratch.dir("arduino-crucible-compile-");
    writeArduinoEnvFile(dir, key, "clients-ac-compile-fail");
    const fakeCliDir = scratch.dir("fake-arduino-cli-");
    const fakeCliPath = join(fakeCliDir, "fake-arduino-cli");
    writeExecutable(
      fakeCliPath,
      '#!/bin/sh\necho "FakeCompileError: undefined reference to foo" 1>&2\nexit 1\n',
    );
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-compile-agent", { cwd: dir, crucibleUrl: baseUrl });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(ARDUINO_SCRIPT_PATH, ["compile", "--agent", "arduino-compile-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      env: { ARDUINO_CLI: fakeCliPath },
    });

    expect(res.code).not.toBe(0);
    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.compile?.raw).toBeDefined();
    expect(event.compile?.raw).toContain("FakeCompileError");
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/compile"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/compile")).toBe(false);
  });
});

// CR-CRU-036 §S3 — fleet coverage-uniformity: arduino-crucible.py currently
// has NEITHER `regression` nor `pre-merge-gate` at all (only
// register/unregister/test/check/plan-verbs exist today — confirmed by
// reading `main()`'s `sub.add_parser(...)` calls directly), while
// bun/python/mvn/rust all expose both. These describe blocks assert the
// SAME complete AXI endpoint surface for arduino: `regression`
// (+ `--coverage`) and `pre-merge-gate`, returning the shared §S1 TOON-AXI
// envelope — mirroring the fixture technique already proven for `unit`
// (fake no-op `make` on PATH so a pre-placed JUnit/lcov fixture survives
// untouched, exactly like C3's fake cargo/mvnw and C4's fake xmlrunner).
describe("clients/arduino-crucible.py — regression subcommand: tier:'regression', lcov coverage passthrough (fake no-op make, CR-CRU-036 §S3)", () => {
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

  /** Mirrors `fixtureDirWithFakeMake` (the `unit` subcommand's fixture,
   * above): a no-op `make` on PATH so a pre-placed JUnit XML — and, for the
   * coverage variant, a pre-placed `tests/native/coverage/lcov.info` — both
   * survive untouched. `cmd_regression` must not wipe those dirs before
   * shelling to `make`, exactly like `cmd_unit` today. */
  function fixtureDirWithFakeMakeAndLcov(
    key: string,
    name: string,
    cases: Array<{ name: string; fail?: boolean }>,
    lcov?: { lf: number; lh: number; ff: number; fh: number },
  ): { dir: string; path: string } {
    const dir = scratch.dir("arduino-crucible-regression-");
    writeArduinoEnvFile(dir, key, name);
    const reportsDir = join(dir, "tests", "native", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeJunitXml(join(reportsDir, "TEST-native_fixture.xml"), "native_fixture", cases);
    if (lcov) {
      const coverageDir = join(dir, "tests", "native", "coverage");
      mkdirSync(coverageDir, { recursive: true });
      writeFileSync(
        join(coverageDir, "lcov.info"),
        `SF:src/blink.cpp\nFNF:${lcov.ff}\nFNH:${lcov.fh}\nLF:${lcov.lf}\nLH:${lcov.lh}\nend_of_record\n`,
      );
    }

    const binDir = scratch.dir("fake-make-bin-");
    writeExecutable(join(binDir, "make"), NOOP_SCRIPT);
    const path = `${binDir}:${process.env.PATH ?? ""}`;
    return { dir, path };
  }

  test("'regression' (no --coverage) posts to /api/v2/runs/parsed (never v1 /api/ingest/parsed) with tier:'regression'", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-regression-tier");
    const { dir, path } = fixtureDirWithFakeMakeAndLcov(key, "clients-ac-regression-tier", [
      { name: "alpha" },
      { name: "beta" },
    ]);
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-regression-agent", { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } });
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["regression", "--agent", "arduino-regression-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url, env: { PATH: path } },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("regression");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(2);
    expect(event.summary?.failed).toBe(0);
    expect(event.coverage).toBeUndefined();
    expect(
      proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed"),
    ).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });

  test("'regression --coverage' attaches event.coverage lines/functions from the fixture's fake lcov.info", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-regression-coverage");
    const { dir, path } = fixtureDirWithFakeMakeAndLcov(
      key,
      "clients-ac-regression-coverage",
      [{ name: "alpha" }],
      { lf: 20, lh: 17, ff: 6, fh: 5 },
    );
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-coverage-agent", { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } });

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["regression", "--coverage", "--agent", "arduino-coverage-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("regression");
    expect(event.coverage?.lines?.total).toBe(20);
    expect(event.coverage?.lines?.covered).toBe(17);
    expect(event.coverage?.functions?.total).toBe(6);
    expect(event.coverage?.functions?.covered).toBe(5);
  });
});

describe("clients/arduino-crucible.py — pre-merge-gate: check (arduino-cli compile) fail-fast → regression --coverage, TOON-AXI envelope (fake ARDUINO_CLI + fake no-op make, CR-CRU-036 §S3)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  test("a PASSING fake ARDUINO_CLI compile + fake no-op make regression run → posts tier:'regression' to /api/v2/runs/parsed with coverage attached, stdout carries the ok:true TOON-AXI envelope, exits 0", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-pre-merge-gate-pass");
    const dir = scratch.dir("arduino-crucible-pmg-pass-");
    writeArduinoEnvFile(dir, key, "clients-ac-pre-merge-gate-pass");
    const reportsDir = join(dir, "tests", "native", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeJunitXml(join(reportsDir, "TEST-native_fixture.xml"), "native_fixture", [{ name: "alpha" }]);
    const coverageDir = join(dir, "tests", "native", "coverage");
    mkdirSync(coverageDir, { recursive: true });
    writeFileSync(
      join(coverageDir, "lcov.info"),
      "SF:src/blink.cpp\nFNF:6\nFNH:5\nLF:20\nLH:17\nend_of_record\n",
    );

    const binDir = scratch.dir("fake-make-bin-");
    writeExecutable(join(binDir, "make"), NOOP_SCRIPT);
    const fakeCliPath = join(binDir, "fake-arduino-cli-ok");
    writeExecutable(fakeCliPath, NOOP_SCRIPT);
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-pmg-agent", {
      cwd: dir,
      crucibleUrl: baseUrl,
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["pre-merge-gate", "--agent", "arduino-pmg-agent", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: baseUrl,
        env: { PATH: `${binDir}:${process.env.PATH ?? ""}`, ARDUINO_CLI: fakeCliPath },
      },
    );

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("ok: true");
    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.tier).toBe("regression");
    expect(event.coverage?.lines?.total).toBe(20);
    expect(event.coverage?.lines?.covered).toBe(17);
  });

  test("a FAILING fake ARDUINO_CLI compile step aborts BEFORE the regression run — no tier:'regression' event ever posted, non-zero exit", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-pre-merge-gate-fail");
    const dir = scratch.dir("arduino-crucible-pmg-fail-");
    writeArduinoEnvFile(dir, key, "clients-ac-pre-merge-gate-fail");
    // Deliberately NO tests/native/reports fixture and NO fake `make` on
    // PATH at all — the gate must never reach the regression step, so it
    // must fail even if a real `make` invocation would blow up.
    const fakeCliDir = scratch.dir("fake-arduino-cli-fail-");
    const fakeCliPath = join(fakeCliDir, "fake-arduino-cli-fail");
    writeExecutable(
      fakeCliPath,
      '#!/bin/sh\necho "FakeCompileError: undefined reference to foo" 1>&2\nexit 1\n',
    );
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-pmg-fail-agent", { cwd: dir, crucibleUrl: baseUrl });

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["pre-merge-gate", "--agent", "arduino-pmg-fail-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl, env: { ARDUINO_CLI: fakeCliPath } },
    );

    expect(res.code).not.toBe(0);
    const events = await nonLifecycleEvents(baseUrl, key);
    // Positive: the check step DID run and ingest its failure (proves the
    // gate actually executed the compile step, not a no-op stub that just
    // exits non-zero without touching either sub-step). Bound: exactly one
    // event, and it is never a 'regression'-tier row.
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.tier).not.toBe("regression");
    expect(event.compile?.raw).toBeDefined();
    expect(event.compile?.raw).toContain("FakeCompileError");
  });
});

// CR-CRU-036 C4 FIX round — VERIFY finding: `auto-ingest` (clients/arduino-crucible.py:571-609)
// was wired but only `--help`-tested; no real-server behavioral coverage
// existed for it. This is a CHARACTERIZATION test — it drives the real
// no-toolchain ingest path end to end and is expected to PASS on today's
// code (a real bug here would be a genuine regression to report, not paper
// over).
describe("clients/arduino-crucible.py — auto-ingest subcommand: behavioral, no-toolchain ingest of a PRE-EXISTING native reports dir, tier:'unit', cycle auto-attach (CR-CRU-036 C4 FIX round)", () => {
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

  test("ingests a PRE-EXISTING tests/native/reports JUnit fixture with NO toolchain invoked (no fake make/arduino-cli on PATH) → posts to /api/v2/runs/parsed (never v1 /api/ingest/parsed) with tier:'unit'; with an active cycle seeded server-side (plan-file → cycle-activate), context.cycleId AUTO-ATTACHES", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-auto-ingest-behavioral");
    // CR-CRU-036 §S9 fixture primitive: file a real OPEN plan, activate one
    // of its two cycles, so the server has an active cycle to auto-attach.
    const plan = await filePlan(baseUrl, key, "CR-AC-AUTO-INGEST");
    const activeCycleId = plan.cycles[0]!.id;
    await activateCycle(baseUrl, key, plan.planId, activeCycleId);

    const dir = scratch.dir("arduino-crucible-auto-ingest-");
    writeArduinoEnvFile(dir, key, "clients-ac-auto-ingest-behavioral");
    // The arduino native reports convention (mirrors fixtureDirWithFakeMake
    // above): <project_dir>/tests/native/reports/TEST-*.xml. Pre-placed and
    // never touched — auto-ingest shells to NO toolchain at all.
    const reportsDir = join(dir, "tests", "native", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeJunitXml(join(reportsDir, "TEST-native_fixture.xml"), "native_fixture", [
      { name: "led_on" },
      { name: "led_off" },
    ]);

    // CR-CRU-056 §S3 — the 'auto-ingest' subcommand's own implicit
    // agent-touch never declares a role/cycle; the server now stamps a
    // run's context.cycleId ONLY from an ALREADY-BOUND agent row.
    // Explicitly pre-register the same agent id bound to the real active
    // cycle so the ingest below has a binding to stamp from — this replaces
    // the deleted server-side "active cycle" GUESS this test used to
    // exercise (title retained: cycle attach still happens, now via
    // explicit binding instead of auto-attach).
    await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "arduino-auto-ingest-agent", "--role", "RED", "--cycle", String(activeCycleId), "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["auto-ingest", "--agent", "arduino-auto-ingest-agent", "--project-dir", dir],
      // Deliberately NO PATH override — no fake `make`/`arduino-cli` is
      // needed (or wanted): a bug that shelled to a real toolchain here
      // would be exactly the regression this test guards against.
      { cwd: dir, crucibleUrl: proxy.url },
    );

    // Three events now: the fixture-orch registration filePlan()/activateCycle()
    // now require (CR-CRU-056 §S2b fixture-repair), the explicit
    // pre-registration's own lifecycle event, plus the auto-ingest's test
    // event — events are returned newest-first (ORDER BY timestamp DESC), so
    // events[0] is still the ingest event.
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(3);
    const event = await getFullEvent(baseUrl, events[0]!.id);

    expect(res.code).toBe(0);
    expect(event.tier).toBe("unit");
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(2);
    expect(event.summary?.failed).toBe(0);
    expect(event.context?.cycleId).toBe(activeCycleId);
    expect(proxy.calls.some((c) => c.method === "POST" && c.path === "/api/v2/runs/parsed")).toBe(true);
    expect(proxy.calls.some((c) => c.path === "/api/ingest/parsed")).toBe(false);
  });
});

describe("clients/arduino-crucible.py — byte-compatible CLI surface (existing flags unchanged post-upgrade)", () => {
  test("register/unregister/unit/compile/regression/auto-ingest/check/pre-merge-gate --help still expose today's exact flag names", async () => {
    const cases: Array<[string, string[]]> = [
      ["register", ["--agent", "--project-dir", "--role"]],
      ["unregister", ["--agent", "--project-dir"]],
      ["unit", ["--agent", "--project-dir", "--dir"]],
      ["compile", ["--agent", "--project-dir"]],
      ["regression", ["--agent", "--project-dir", "--coverage"]],
      ["auto-ingest", ["--agent", "--project-dir", "--reports"]],
      ["check", ["--agent", "--project-dir"]],
      ["pre-merge-gate", ["--agent", "--project-dir", "--skip-check"]],
    ];
    for (const [subcommand, flags] of cases) {
      const proc = Bun.spawn({
        cmd: ["uv", "run", ARDUINO_SCRIPT_PATH, subcommand, "--help"],
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

// CR-CRU-050 §S1/§S1b/§S2 — `_parse_junit` (arduino-crucible.py:335-357)
// today checks only `tc.find("failure")`/`tc.find("error")`; a bare
// `else: passed += 1` folds every `<skipped/>` testcase into `passed`, and
// the summary hardcodes `"pending": 0`. `_emit_ingest_summary_axi`
// (arduino-crucible.py:300-314) also drops `pending` from the printed
// `run:` TOON block, and the plain "[crucible] <verb> -> '<name>': N/M
// passed, F failed" stderr lines (arduino-crucible.py:514, 537, 638) drop
// it too — three separate print call sites (the no-`--agent` report path,
// the `--agent` ingest path, and `auto-ingest`), all §S2 surfaces.
describe("clients/arduino-crucible.py — CR-CRU-050 §S1/§S1b/§S2: <skipped/> testcases count as pending, never passed (fake no-op make)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratch = makeScratchTracker();

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    scratch.cleanup();
  });

  /** Mirrors `fixtureDirWithFakeMake` above — a no-op `make` on PATH so a
   * pre-placed JUnit XML fixture (here carrying a `<skipped/>` testcase)
   * survives `cmd_unit`'s (and `auto-ingest`'s) reports-dir read untouched. */
  function fixtureDirCr050(
    key: string,
    name: string,
    cases: Array<{ name: string; fail?: boolean; skip?: boolean }>,
  ): { dir: string; path: string } {
    const dir = scratch.dir("arduino-crucible-cr050-");
    writeArduinoEnvFile(dir, key, name);
    const reportsDir = join(dir, "tests", "native", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeJunitXml(join(reportsDir, "TEST-native_fixture.xml"), "native_fixture", cases);
    const binDir = scratch.dir("fake-make-bin-cr050-");
    writeExecutable(join(binDir, "make"), NOOP_SCRIPT);
    const path = `${binDir}:${process.env.PATH ?? ""}`;
    return { dir, path };
  }

  test("§S1/§S1b/§S2: with --agent, 'unit' counts the skipped testcase as pending=1 (never folded into passed), the skipped leaf carries tree status 'pending' (not 'pass'), the real pass/fail leaves are unaffected, and BOTH the TOON run: block and the plain '[crucible] unit -> ...' stderr line (arduino-crucible.py:537) carry pending=1", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-cr050-pending");
    const { dir, path } = fixtureDirCr050(key, "clients-ac-cr050-pending", [
      { name: "led_on" },
      { name: "led_off", fail: true },
      { name: "led_blink", skip: true },
    ]);
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-cr050-agent", { cwd: dir, crucibleUrl: baseUrl, env: { PATH: path } });

    const res = await runScript(ARDUINO_SCRIPT_PATH, ["unit", "--agent", "arduino-cr050-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
      env: { PATH: path },
    });

    const events = await nonLifecycleEvents(baseUrl, key);
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
    const skipLeaf = leaves.find((l) => l.name === "led_blink");
    const passLeaf = leaves.find((l) => l.name === "led_on");
    const failLeaf = leaves.find((l) => l.name === "led_off");
    expect(skipLeaf?.status).toBe("pending");
    expect(skipLeaf?.status).not.toBe("pass");
    expect(passLeaf?.status).toBe("pass");
    expect(failLeaf?.status).toBe("fail");

    // §S2 — the TOON run: block carries pending.
    const block = extractRunBlock(res.stdout);
    expect(block).toBeDefined();
    expect(block).toContain("passed: 1");
    expect(block).toContain("failed: 1");
    expect(block).toContain("total: 3");
    expect(block).toContain("pending: 1");

    // §S2 (extended) — arduino-crucible.py:537's plain stderr line too. That
    // line's own sentence style is "X/Y passed, Z failed" (not key=value),
    // so the natural parallel extension is "W pending", matching "Z failed".
    expect(res.stderr).toContain("passed,");
    expect(res.stderr).toContain("1 pending");
  });

  test("§S2 (extended): WITHOUT --agent, the no-ingest report line (arduino-crucible.py:514) also carries 1 pending", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-cr050-no-agent-report");
    const { dir, path } = fixtureDirCr050(key, "clients-ac-cr050-no-agent-report", [
      { name: "led_on" },
      { name: "led_blink", skip: true },
    ]);

    const res = await runScript(ARDUINO_SCRIPT_PATH, ["unit", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
      env: { PATH: path },
    });

    expect(res.code).toBe(0); // no real failures — only a pass and a skip
    expect(res.stderr).toContain("passed,");
    expect(res.stderr).toContain("1 pending");
  });

  test("§S2 (extended): 'auto-ingest' (arduino-crucible.py:638) also carries 1 pending in its stderr line, alongside pending=1 in the ingested summary", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-cr050-auto-ingest");
    const dir = scratch.dir("arduino-crucible-cr050-auto-");
    writeArduinoEnvFile(dir, key, "clients-ac-cr050-auto-ingest");
    const reportsDir = join(dir, "tests", "native", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeJunitXml(join(reportsDir, "TEST-native_fixture.xml"), "native_fixture", [
      { name: "led_on" },
      { name: "led_blink", skip: true },
    ]);
    await ensureRegistered(ARDUINO_SCRIPT_PATH, "arduino-cr050-auto-agent", { cwd: dir, crucibleUrl: baseUrl });

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["auto-ingest", "--agent", "arduino-cr050-auto-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    const events = await nonLifecycleEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.summary?.total).toBe(2);
    expect(event.summary?.passed).toBe(1);
    expect(event.summary?.pending).toBe(1);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("passed,");
    expect(res.stderr).toContain("1 pending");
  });
});
