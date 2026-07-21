// CR-CRU-008 C4 — clients/python-crucible.py + clients/arduino-crucible.py v2
// contract (RED) + the "no-XML fallback 400 bug" fix.
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md — §S2 script fleet
// upgrade (v2 endpoints, tier per subcommand, git/wave/orchestrator/cycle
// context, --phase optional) + Implementation Notes: "python-crucible.py
// no-XML fallback 400 bug: carried from the 2026-07-16 python-side cycle —
// fix during §S2." This cycle (C4) upgrades python-crucible.py and
// arduino-crucible.py.
//
// RED phase: neither `clients/python-crucible.py` nor
// `clients/arduino-crucible.py` exists yet on this branch (only the LIVE v1
// scripts at ~/.claude/scripts/*.py exist — copied into clients/ and
// upgraded there by GREEN). Every test spawns `python3 clients/<script>.py
// ...` against a REAL live test server and fails because the file is
// missing — python3 exits 2 with "can't open file" on stderr. Same RED
// shape as C2 (bun) / C3 (rust+mvn).
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
// assumed): `--phase` defaults to `"report"` and the register message is
// `f"Starting {phase} phase"`; `_run_context()` reads WORKFLOW_CYCLE_ID
// (int-coerced)/WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE, attaches
// `git: {branch, commit}` via a plain `git rev-parse` from CWD (tolerant of
// a non-repo cwd), and returns None (→ no `context` key at all) when NO
// WORKFLOW_* var is set.
//
// Scope note on arduino's `register --phase` (deliberate, NOT an oversight):
// arduino-crucible.py's `--phase` is ALREADY optional today (message
// defaults to "online", not a hard failure) — unlike python's, which
// currently `required=True`s it with an explicit choices list (the real
// ergonomics bug). We do not assert arduino's no-`--phase` message contains
// "report": the CR's ergonomics note is specifically about hard-requiring
// `--phase` (bun/python), and inventing a wording change for a script that
// was never broken here would be speculative scope-creep. We DO assert
// arduino's register (with `--phase` given, matching today's real call
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
 * Spawns `python3 <scriptPath> <args>`. Strips any ambient WORKFLOW_* env so
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
    cmd: ["python3", scriptPath, ...args],
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
  kind?: string;
  context?: {
    git?: { branch?: string; commit?: string };
    wave?: string;
    orchestrator?: string;
    cycle?: string;
    cycleId?: number;
  };
  summary?: { total: number; passed: number; failed: number };
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
 * parse (both use xml.etree.ElementTree over testsuite/testcase/failure). */
function junitXmlString(suiteName: string, cases: Array<{ name: string; fail?: boolean }>): string {
  const testcases = cases
    .map((c) =>
      c.fail
        ? `<testcase name="${c.name}" time="0.01"><failure message="boom">boom</failure></testcase>`
        : `<testcase name="${c.name}" time="0.01"/>`,
    )
    .join("");
  return `<?xml version="1.0"?><testsuite name="${suiteName}" tests="${cases.length}">${testcases}</testsuite>`;
}

function writeJunitXml(path: string, suiteName: string, cases: Array<{ name: string; fail?: boolean }>): void {
  writeFileSync(path, junitXmlString(suiteName, cases));
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
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p1", "--phase", "RED", "--project-dir", dir],
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
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p2", "--phase", "RED", "--project-dir", dir],
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

  test("register --agent X WITHOUT --phase succeeds (ergonomics fix: python's --phase is currently required=True — defaults to report phase instead)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-phase-optional");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(PYTHON_SCRIPT_PATH, ["register", "--agent", "p3", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
    });

    expect(res.code).toBe(0);
    const agents = await getAgents(baseUrl, key);
    const agent = agents.find((a) => a.agentId === "p3");
    expect(agent).toBeDefined();
    expect(agent!.message.toLowerCase()).toContain("report");
  });

  test("CR-CRU-036 §S1: register with an OPEN plan but NO active cycle warns[] 'no-active-cycle'/'activate a cycle first' + stderr, posts NO agent, exits non-zero — WORKFLOW_CYCLE_ID set is ignored", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-PC-NO-ACTIVE-CYCLE");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p-no-cycle", "--phase", "RED", "--project-dir", dir],
      // A stale WORKFLOW_CYCLE_ID pointing at a REAL (but pending) cycle in
      // this very plan must change NOTHING — §S1 removes the env var.
      { cwd: dir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("no-active-cycle");
    expect(res.stderr).toContain("activate a cycle first");
    expect(res.stdout).toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("p-no-cycle");
  });

  test("CR-CRU-036 §S1: register with NO open plan at all is tolerant — proceeds with no warning and no withhold", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-tolerant-no-plan");
    const dir = scratch.dir("python-crucible-proj-");
    writeEnvFile(dir, key);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["register", "--agent", "p-tolerant", "--phase", "RED", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).toContain("p-tolerant");
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

    const events = await getEvents(baseUrl, key);
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

  test("with an ACTIVE cycle seeded server-side + WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE set + a git repo, records full context: cycleId AUTO-ATTACHED from the server (WORKFLOW_CYCLE_ID set to a DIFFERENT real cycle changes nothing), cycle, wave, orchestrator, auto-detected git branch/commit", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-pc-test-context");
    // CR-CRU-036 §S1: seed an ACTIVE cycle server-side (plan-file + activate
    // cycles[0]). cycles[1] stays pending and is fed to WORKFLOW_CYCLE_ID —
    // a REAL, linkable, but NOT-active cycle — proving the env var is read
    // by nobody: if it still won, context.cycleId would be cycles[1]'s id.
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

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
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

    const events = await getEvents(baseUrl, key);
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

    const events = await getEvents(baseUrl, key);
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

    const events = await getEvents(baseUrl, key);
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
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(PYTHON_SCRIPT_PATH, ["test", "--agent", "python-no-xml-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      env: { PYTHONPATH: "" },
    });

    expect(res.code).not.toBe(0);
    const events = await getEvents(baseUrl, key);
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
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      PYTHON_SCRIPT_PATH,
      ["regression", "--agent", "python-no-xml-regression-agent", "--project-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url, env: { PYTHONPATH: "" } },
    );

    expect(res.code).not.toBe(0);
    const events = await getEvents(baseUrl, key);
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
      ["register", ["--agent", "--phase", "--display-name", "--source", "--message", "--project-dir"]],
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
        cmd: ["python3", PYTHON_SCRIPT_PATH, subcommand, "--help"],
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
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a1", "--phase", "RED", "--project-dir", dir],
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
    proxy = startCapturingProxy(baseUrl);

    await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a2", "--phase", "RED", "--project-dir", dir],
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

  test("CR-CRU-036 §S1: register with an OPEN plan but NO active cycle warns[] 'no-active-cycle'/'activate a cycle first' + stderr, posts NO agent, exits non-zero — WORKFLOW_CYCLE_ID set is ignored", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-no-active-cycle");
    // Files an open plan whose two cycles are both `pending` — never activated.
    const plan = await filePlan(baseUrl, key, "CR-AC-NO-ACTIVE-CYCLE");
    const dir = scratch.dir("arduino-crucible-proj-");
    writeArduinoEnvFile(dir, key, "clients-ac-no-active-cycle");

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a-no-cycle", "--phase", "RED", "--project-dir", dir],
      // A stale WORKFLOW_CYCLE_ID pointing at a REAL (but pending) cycle in
      // this very plan must change NOTHING — §S1 removes the env var.
      { cwd: dir, crucibleUrl: baseUrl, env: { WORKFLOW_CYCLE_ID: String(plan.cycles[0]!.id) } },
    );

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("no-active-cycle");
    expect(res.stderr).toContain("activate a cycle first");
    expect(res.stdout).toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).not.toContain("a-no-cycle");
  });

  test("CR-CRU-036 §S1: register with NO open plan at all is tolerant — proceeds with no warning and no withhold", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-tolerant-no-plan");
    const dir = scratch.dir("arduino-crucible-proj-");
    writeArduinoEnvFile(dir, key, "clients-ac-tolerant-no-plan");

    const res = await runScript(
      ARDUINO_SCRIPT_PATH,
      ["register", "--agent", "a-tolerant", "--phase", "RED", "--project-dir", dir],
      { cwd: dir, crucibleUrl: baseUrl },
    );

    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("no-active-cycle");
    expect(await getAgentIds(baseUrl, key)).toContain("a-tolerant");
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
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(ARDUINO_SCRIPT_PATH, ["unit", "--agent", "arduino-unit-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      env: { PATH: path },
    });

    const events = await getEvents(baseUrl, key);
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

  test("with an ACTIVE cycle seeded server-side + WORKFLOW_CYCLE/WORKFLOW_WAVE/WORKFLOW_ROLE set + a git repo, records full context: cycleId AUTO-ATTACHED from the server (WORKFLOW_CYCLE_ID set to a DIFFERENT real cycle changes nothing), cycle, wave, orchestrator, auto-detected git branch/commit", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "clients-ac-unit-context");
    // CR-CRU-036 §S1: seed an ACTIVE cycle server-side; feed the OTHER
    // (real, but pending) cycle to WORKFLOW_CYCLE_ID to prove it's ignored.
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

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
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

    await runScript(ARDUINO_SCRIPT_PATH, ["unit", "--agent", "arduino-no-context-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: baseUrl,
      env: { PATH: path },
    });

    const events = await getEvents(baseUrl, key);
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
    proxy = startCapturingProxy(baseUrl);

    const res = await runScript(ARDUINO_SCRIPT_PATH, ["compile", "--agent", "arduino-compile-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      env: { ARDUINO_CLI: fakeCliPath },
    });

    expect(res.code).not.toBe(0);
    const events = await getEvents(baseUrl, key);
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

describe("clients/arduino-crucible.py — byte-compatible CLI surface (existing flags unchanged post-upgrade)", () => {
  test("register/unregister/unit/compile --help still expose today's exact flag names", async () => {
    const cases: Array<[string, string[]]> = [
      ["register", ["--agent", "--project-dir", "--phase"]],
      ["unregister", ["--agent", "--project-dir"]],
      ["unit", ["--agent", "--project-dir", "--dir"]],
      ["compile", ["--agent", "--project-dir"]],
    ];
    for (const [subcommand, flags] of cases) {
      const proc = Bun.spawn({
        cmd: ["python3", ARDUINO_SCRIPT_PATH, subcommand, "--help"],
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
