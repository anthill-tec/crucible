// CR-CRU-008 C1 — §S1 `crucible-axi` CLI (new package under `cli/`).
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md §S1 + Acceptance criteria
// (first two bullets, this cycle's scope):
//   - "`npx crucible-axi` (built from `cli/`, run locally) with the server up
//     prints a TOON dashboard whose first line is `ok: true` and includes a
//     `help[` block; with the server down exits non-zero with a message
//     naming `/api/health`."
//   - "`crucible-axi ingest <fixture.xml> --project-key <k> --agent a1` inside
//     a git repo -> the recorded event's `context.git.branch` equals the
//     repo's current branch (auto-detect); the same command with `GIT_DIR`
//     unset/outside a repo records NO context (graceful)."
//
// RED phase: `cli/` does not exist AT ALL yet on this branch (confirmed via
// `ctx_tree` — no `cli/` directory in the repo). The CLI's entry module is
// referenced through a NON-LITERAL dynamic-import specifier
// (`import(CLI_MODULE_PATH)` where CLI_MODULE_PATH is a variable, not a
// string-literal AST node) so `bunx tsc --noEmit` stays clean: TypeScript
// only attempts static module resolution for dynamic `import()` when the
// argument IS a string literal in the source; a variable reference types as
// `Promise<any>` and is never resolved. Verified directly against this
// tsconfig (moduleResolution: "bundler"): a probe file doing exactly this
// against a genuinely nonexistent module produced ZERO tsc errors. At
// RUNTIME `import(CLI_MODULE_PATH)` throws (module not found), so every test
// below fails for that reason until GREEN creates `cli/crucible-axi.ts`.
//
// Architecture pinned for GREEN (mirrors src/server.ts's StartServerOpts /
// ServerHandle DI style):
//   export interface RunCliOpts {
//     argv: string[];               // e.g. ["ingest", path, "--project-key", key]
//     baseUrl: string;              // explicit — no env-var guessing in unit tests
//     cwd: string;                  // drives git auto-detect + .env discovery
//     env?: Record<string, string | undefined>;
//     stdout: { write(chunk: string): void };
//     stderr: { write(chunk: string): void };
//     stdin?: { text(): Promise<string> };   // for ingest-parsed
//     fetchImpl?: typeof fetch;     // DI seam so tests can capture argv/urls
//                                   // while still hitting the REAL test server
//   }
//   export function runCli(opts: RunCliOpts): Promise<number>;
//
// The real `npx crucible-axi` binary (no test harness) is expected to read
// its base URL from a `CRUCIBLE_URL` env var (analogous to server.ts's own
// `CRUCIBLE_PORT`/`CRUCIBLE_HOST`) — this is a RED-agent documented
// assumption (no AC pins the override mechanism) exercised only by the one
// true subprocess-spawn test below.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

// ── RED-phase module loading (see header comment) ──────────────────────────

const CLI_MODULE_PATH = "../cli/crucible-axi.ts";

interface RunCliOpts {
  argv: string[];
  baseUrl: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  stdin?: { text(): Promise<string> };
  fetchImpl?: typeof fetch;
}

type RunCliFn = (opts: RunCliOpts) => Promise<number>;

async function loadCli(): Promise<{ runCli: RunCliFn }> {
  return import(CLI_MODULE_PATH) as Promise<{ runCli: RunCliFn }>;
}

// ── Test fixtures ────────────────────────────────────────────────────────--

const JUNIT_FIXTURE = [
  '<testsuite name="CliAxiSuite" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"/>',
  "</testsuite>",
].join("\n");

// tsc dialect — matches src/codecs/compile.ts's TSC_LINE regex so
// detectFormat() picks "tsc" without an explicit --format hint.
const TSC_COMPILE_FIXTURE =
  "src/foo.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";

// ── Test-only helpers ────────────────────────────────────────────────────--

interface CapturedCall {
  url: string;
  method: string;
  body?: unknown;
}

function capturingFetch(): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function captureStream(): { write(chunk: string): void; text: string } {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
    },
  };
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

// CR-CRU-056 §S2b fixture-repair (C3): /api/v2/runs, /api/v2/runs/parsed,
// and /api/v2/runs/compile now refuse an unregistered agentId (409) — each
// distinct --agent value these CLI invocations ingest under must be live
// registered first (register/unregister/heartbeat aren't gated by
// requireRegisteredCaller, so those tests are unaffected).
async function registerAgent(baseUrl: string, key: string, agentId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
  });
  if (res.status !== 200) {
    throw new Error(`registerAgent fixture failed: ${res.status} ${await res.text()}`);
  }
}

async function getEvents(baseUrl: string, key: string): Promise<Array<{ id: string }>> {
  const res = await fetch(`${baseUrl}/api/v2/events?project=${key}`);
  const body = (await res.json()) as { events: Array<{ id: string; kind?: string }> };
  // CR-CRU-056 §S2b fixture-repair: registerAgent() journals its own
  // "lifecycle" event (CR-CRU-011 §S1) — not one of the ingest events these
  // tests actually assert on. Filter it out.
  return body.events.filter((e) => e.kind !== "lifecycle");
}

async function getFullEvent(
  baseUrl: string,
  id: string,
): Promise<{
  tier: string;
  codec?: string;
  context?: { git?: { branch?: string; commit?: string }; wave?: string; orchestrator?: string };
}> {
  const res = await fetch(`${baseUrl}/api/v2/events/${id}`);
  const body = (await res.json()) as { event: typeof res extends Response ? unknown : never } & {
    event: {
      tier: string;
      codec?: string;
      context?: { git?: { branch?: string; commit?: string }; wave?: string; orchestrator?: string };
    };
  };
  return body.event;
}

function runGit(args: string[], cwd: string): void {
  const res = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cli-axi-test",
      GIT_AUTHOR_EMAIL: "cli-axi-test@example.com",
      GIT_COMMITTER_NAME: "cli-axi-test",
      GIT_COMMITTER_EMAIL: "cli-axi-test@example.com",
    },
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

/** Initializes a throwaway git repo at `dir` on a KNOWN branch name, with one commit. */
function initGitRepo(dir: string, branch: string): void {
  runGit(["init", "-q"], dir);
  // Set the branch name BEFORE the first commit (works on git < 2.28, unlike
  // `git init -b`, which requires a newer git).
  runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
  writeFileSync(join(dir, "README.md"), "cli-axi test repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
}

describe("crucible-axi CLI (CR-CRU-008 §S1)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  // ── AC-1a — no-arg dashboard, server up ──────────────────────────────────

  test("no-arg dashboard against a live server: exit 0, stdout's FIRST line is 'ok: true', contains a help[ block", async () => {
    const { runCli } = await loadCli();
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [],
      baseUrl: `http://localhost:${handle.server.port}`,
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    // Would FAIL against a no-op stub (empty stdout) or a stub that only
    // prints SOME status without the exact TOON dashboard contract.
    const lines = stdout.text.split("\n");
    expect(lines[0]).toBe("ok: true");
    expect(stdout.text).toMatch(/help\[\d+\]:/);
    // The dashboard body is a pure TOON document — no progress noise may
    // precede/interleave with it on stdout (progress belongs on stderr per
    // §S1's "TOON to stdout, progress to stderr" house idiom).
    expect(stdout.text).not.toMatch(/fetching|connecting|contacting|querying/i);
  });

  // ── AC-1b — server down ──────────────────────────────────────────────────

  test("server down: exits non-zero, stderr message names /api/health", async () => {
    const { runCli } = await loadCli();
    // Start a real server, capture its port, then close it — guarantees the
    // port is unbound (nothing silently answers) without relying on a
    // hardcoded/privileged port.
    const probe = startServer({ port: 0, dbPath: ":memory:" });
    const deadPort = probe.server.port;
    probe.stop();

    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli({
      argv: [],
      baseUrl: `http://127.0.0.1:${deadPort}`,
      cwd: process.cwd(),
      stdout,
      stderr,
    });

    expect(code).not.toBe(0);
    expect(stderr.text).toContain("/api/health");
  });

  // ── AC — register/unregister round-trip, v2-only endpoints ───────────────

  test("register then unregister: agent appears then vanishes from GET /api/v2/agents; hits v2-only URLs (never the v1 shim)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-register-project");
    const { runCli } = await loadCli();
    const { calls, fetchImpl } = capturingFetch();

    const registerCode = await runCli({
      argv: ["register", "--project-key", key, "--agent", "cli-a1", "--role", "report"],
      baseUrl,
      cwd: process.cwd(),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });
    expect(registerCode).toBe(0);

    const afterRegisterRes = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
    const afterRegister = (await afterRegisterRes.json()) as { agents: Array<{ agentId: string }> };
    expect(afterRegister.agents.map((a) => a.agentId)).toContain("cli-a1");

    // v2-ONLY — the whole point of this CR. Never the v1 shim route.
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/v2/agents/register"))).toBe(
      true,
    );
    expect(calls.some((c) => /\/api\/agents\/(register|heartbeat)(?!\/v2)/.test(c.url))).toBe(false);
    expect(calls.every((c) => !c.url.includes("/api/agents/") || c.url.includes("/api/v2/agents/"))).toBe(
      true,
    );

    const unregisterCode = await runCli({
      argv: ["unregister", "--project-key", key, "--agent", "cli-a1"],
      baseUrl,
      cwd: process.cwd(),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });
    expect(unregisterCode).toBe(0);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/v2/agents/unregister"))).toBe(
      true,
    );

    const afterUnregisterRes = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
    const afterUnregister = (await afterUnregisterRes.json()) as { agents: Array<{ agentId: string }> };
    expect(afterUnregister.agents.map((a) => a.agentId)).not.toContain("cli-a1");
  });

  test("heartbeat hits POST /api/v2/agents/heartbeat and keeps the agent listed", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-heartbeat-project");
    const { runCli } = await loadCli();
    const { calls, fetchImpl } = capturingFetch();

    await runCli({
      argv: ["register", "--project-key", key, "--agent", "cli-hb-1", "--role", "report"],
      baseUrl,
      cwd: process.cwd(),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });
    const hbCode = await runCli({
      argv: ["heartbeat", "--project-key", key, "--agent", "cli-hb-1"],
      baseUrl,
      cwd: process.cwd(),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });

    expect(hbCode).toBe(0);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/api/v2/agents/heartbeat"))).toBe(
      true,
    );
    const afterHbRes = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
    const afterHb = (await afterHbRes.json()) as { agents: Array<{ agentId: string }> };
    expect(afterHb.agents.map((a) => a.agentId)).toContain("cli-hb-1");
  });

  // ── AC-2 — ingest: tier + git-context auto-detect ────────────────────────

  test("ingest <junit-path> --project-key --agent --tier e2e: records via POST /api/v2/runs (codec junit), tier passes through", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-ingest-tier");
    const dir = scratchDir("cli-axi-ingest-");
    const fixturePath = join(dir, "sample.junit.xml");
    writeFileSync(fixturePath, JUNIT_FIXTURE);
    const { runCli } = await loadCli();
    const { calls, fetchImpl } = capturingFetch();
    await registerAgent(baseUrl, key, "cli-ingest-agent");

    const code = await runCli({
      argv: ["ingest", fixturePath, "--project-key", key, "--agent", "cli-ingest-agent", "--tier", "e2e"],
      baseUrl,
      cwd: dir,
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });

    expect(code).toBe(0);
    const runsCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/v2/runs") && !c.url.includes("/runs/"));
    expect(runsCall).toBeDefined();
    expect((runsCall!.body as { codec?: string }).codec).toBe("junit");
    expect((runsCall!.body as { data?: string }).data).toContain("CliAxiSuite");
    expect((runsCall!.body as { tier?: string }).tier).toBe("e2e");

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.tier).toBe("e2e");
  });

  test("inside a git repo: the recorded event's context.git.branch equals the repo's current branch (auto-detect)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-ingest-git-repo");
    const repoDir = scratchDir("cli-axi-repo-");
    const branch = "cli-axi-feature-branch";
    initGitRepo(repoDir, branch);
    const fixturePath = join(repoDir, "sample.junit.xml");
    writeFileSync(fixturePath, JUNIT_FIXTURE);
    const { runCli } = await loadCli();
    await registerAgent(baseUrl, key, "cli-git-agent");

    const code = await runCli({
      argv: ["ingest", fixturePath, "--project-key", key, "--agent", "cli-git-agent"],
      baseUrl,
      cwd: repoDir,
      stdout: captureStream(),
      stderr: captureStream(),
    });

    expect(code).toBe(0);
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context?.git?.branch).toBe(branch);
    expect(typeof event.context?.git?.commit).toBe("string");
    expect((event.context?.git?.commit ?? "").length).toBeGreaterThan(0);
  });

  test("the SAME command outside a git repo (GIT_DIR unset, cwd has no .git) records NO context key at all (graceful)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-ingest-no-repo");
    const plainDir = scratchDir("cli-axi-norepo-");
    const fixturePath = join(plainDir, "sample.junit.xml");
    writeFileSync(fixturePath, JUNIT_FIXTURE);
    const { runCli } = await loadCli();
    const { GIT_DIR: _unused, ...envWithoutGitDir } = process.env;
    void _unused;
    await registerAgent(baseUrl, key, "cli-norepo-agent");

    const code = await runCli({
      argv: ["ingest", fixturePath, "--project-key", key, "--agent", "cli-norepo-agent"],
      baseUrl,
      cwd: plainDir,
      env: envWithoutGitDir,
      stdout: captureStream(),
      stderr: captureStream(),
    });

    expect(code).toBe(0);
    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    // Raw fetch (not getFullEvent's narrowed type) so we can assert the KEY
    // is absent, not merely undefined-valued (JSON serialization already
    // elides `undefined`, but this pins the contract explicitly).
    const rawRes = await fetch(`${baseUrl}/api/v2/events/${events[0]!.id}`);
    const rawBody = (await rawRes.json()) as { event: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(rawBody.event, "context")).toBe(false);
  });

  test("--branch/--commit/--wave/--orchestrator explicit flags override auto-detect and are recorded verbatim (no git repo needed)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-ingest-explicit-flags");
    const dir = scratchDir("cli-axi-explicit-"); // deliberately NOT a git repo
    const fixturePath = join(dir, "sample.junit.xml");
    writeFileSync(fixturePath, JUNIT_FIXTURE);
    const { runCli } = await loadCli();
    await registerAgent(baseUrl, key, "cli-explicit-agent");

    const code = await runCli({
      argv: [
        "ingest",
        fixturePath,
        "--project-key",
        key,
        "--agent",
        "cli-explicit-agent",
        "--branch",
        "manual-branch",
        "--commit",
        "deadbeef0",
        "--wave",
        "wave-3",
        "--orchestrator",
        "orch-mainline",
      ],
      baseUrl,
      cwd: dir,
      stdout: captureStream(),
      stderr: captureStream(),
    });

    expect(code).toBe(0);
    const events = await getEvents(baseUrl, key);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.context?.git?.branch).toBe("manual-branch");
    expect(event.context?.git?.commit).toBe("deadbeef0");
    expect(event.context?.wave).toBe("wave-3");
    expect(event.context?.orchestrator).toBe("orch-mainline");
  });

  // ── ingest-parsed / ingest-compile ────────────────────────────────────────

  test("ingest-parsed reads JSON from stdin and posts it to /api/v2/runs/parsed", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-ingest-parsed");
    const { runCli } = await loadCli();
    const { calls, fetchImpl } = capturingFetch();
    await registerAgent(baseUrl, key, "cli-parsed-agent");
    const parsedPayload = {
      summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 12 },
      tree: [
        {
          name: "suite",
          status: "pass",
          children: [
            { name: "t1", status: "pass", duration_ms: 5 },
            { name: "t2", status: "pass", duration_ms: 7 },
          ],
        },
      ],
    };

    const code = await runCli({
      argv: ["ingest-parsed", "--project-key", key, "--agent", "cli-parsed-agent"],
      baseUrl,
      cwd: process.cwd(),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
      stdin: { text: async () => JSON.stringify(parsedPayload) },
    });

    expect(code).toBe(0);
    const parsedCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/v2/runs/parsed"));
    expect(parsedCall).toBeDefined();
    expect((parsedCall!.body as { summary?: unknown }).summary).toEqual(parsedPayload.summary);

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
  });

  test("ingest-compile <file> posts the file's content to /api/v2/runs/compile (tsc format auto-detected, no --format hint)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-ingest-compile");
    const dir = scratchDir("cli-axi-compile-");
    const filePath = join(dir, "tsc-errors.txt");
    writeFileSync(filePath, TSC_COMPILE_FIXTURE);
    const { runCli } = await loadCli();
    const { calls, fetchImpl } = capturingFetch();
    await registerAgent(baseUrl, key, "cli-compile-agent");

    const code = await runCli({
      argv: ["ingest-compile", filePath, "--project-key", key, "--agent", "cli-compile-agent"],
      baseUrl,
      cwd: dir,
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });

    expect(code).toBe(0);
    const compileCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/v2/runs/compile"));
    expect(compileCall).toBeDefined();
    expect((compileCall!.body as { errors?: string }).errors).toContain("TS2322");

    const events = await getEvents(baseUrl, key);
    expect(events.length).toBe(1);
    const event = await getFullEvent(baseUrl, events[0]!.id);
    expect(event.codec).toBe("tsc");
  });

  // ── project add|list, events, status (TOON reads) ────────────────────────

  test("project add creates via POST /api/v2/projects; project list reads it back via GET /api/v2/projects (TOON: 'ok: true' first line)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const { runCli } = await loadCli();
    const { calls, fetchImpl } = capturingFetch();

    const addCode = await runCli({
      argv: ["project", "add", "--name", "cli-added-project"],
      baseUrl,
      cwd: process.cwd(),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });
    expect(addCode).toBe(0);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/v2/projects"))).toBe(true);
    const addCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/v2/projects"));
    expect((addCall!.body as { name?: string }).name).toBe("cli-added-project");

    const listStdout = captureStream();
    const listCode = await runCli({
      argv: ["project", "list"],
      baseUrl,
      cwd: process.cwd(),
      stdout: listStdout,
      stderr: captureStream(),
      fetchImpl,
    });
    expect(listCode).toBe(0);
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/api/v2/projects"))).toBe(true);
    expect(listStdout.text.split("\n")[0]).toBe("ok: true");
    expect(listStdout.text).toContain("cli-added-project");
  });

  test("events command renders TOON from GET /api/v2/events; status command renders TOON from GET /api/v2/status", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-events-status");
    await registerAgent(baseUrl, key, "seed-agent");
    await fetch(`${baseUrl}/api/v2/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId: "seed-agent", codec: "junit", data: JUNIT_FIXTURE }),
    });
    const { runCli } = await loadCli();

    const eventsStdout = captureStream();
    const eventsCode = await runCli({
      argv: ["events", "--project-key", key],
      baseUrl,
      cwd: process.cwd(),
      stdout: eventsStdout,
      stderr: captureStream(),
    });
    expect(eventsCode).toBe(0);
    expect(eventsStdout.text.split("\n")[0]).toBe("ok: true");
    expect(eventsStdout.text).toMatch(/events\[\d+\]/);

    const statusStdout = captureStream();
    const statusCode = await runCli({
      argv: ["status", "--project-key", key],
      baseUrl,
      cwd: process.cwd(),
      stdout: statusStdout,
      stderr: captureStream(),
    });
    expect(statusCode).toBe(0);
    expect(statusStdout.text.split("\n")[0]).toBe("ok: true");
    expect(statusStdout.text).toContain("status:");
    expect(statusStdout.text).toContain("hasData: true");
  });

  // ── .env CRUCIBLE_PROJECT_KEY discovery ──────────────────────────────────

  test(".env CRUCIBLE_PROJECT_KEY discovery: with a fixture .env in cwd and no --project-key flag, the key is picked up", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-dotenv-discovery");
    const dir = scratchDir("cli-axi-dotenv-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    const { runCli } = await loadCli();
    const { calls, fetchImpl } = capturingFetch();

    const code = await runCli({
      argv: ["status"],
      baseUrl,
      cwd: dir,
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(
      calls.some((c) => c.url.includes("/api/v2/status") && c.url.includes(`project=${key}`)),
    ).toBe(true);
  });

  test("without a .env and without --project-key, a project-scoped command fails gracefully (non-zero exit, no crash)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const dir = scratchDir("cli-axi-nodotenv-");
    const { runCli } = await loadCli();

    const code = await runCli({
      argv: ["status"],
      baseUrl,
      cwd: dir,
      stdout: captureStream(),
      stderr: captureStream(),
    });

    expect(code).not.toBe(0);
  });

  // ── One TRUE end-to-end subprocess spawn (Bun.spawn) ─────────────────────

  test("e2e: `bun cli/crucible-axi.ts` spawned as a real subprocess against a live server prints the TOON dashboard and exits 0", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const cliEntryAbs = join(import.meta.dir, "..", "cli", "crucible-axi.ts");

    const proc = Bun.spawn({
      cmd: ["bun", cliEntryAbs],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CRUCIBLE_URL: baseUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdoutText.split("\n")[0]).toBe("ok: true");
    expect(stdoutText).toMatch(/help\[\d+\]:/);
  });
});

// ---------------------------------------------------------------------------
// CR-CRU-066 §S4 / AC6 — the DOCUMENTED CLI surface covers every verb the
// shipped `crucible-axi` actually dispatches (RED).
//
// Spec: docs/changes/CR-CRU-066-install-provisions-not-runs-plus-serve.md
// §S4 + AC6; test-strategy line "Add the `serve` verb to
// `tests/cli-axi.test.ts`."
//
// 🚨 SCOPE READING, recorded because it deviates from the literal wording:
// this file's `describe` above exercises the BUN fleet CLI
// (`cli/crucible-axi.ts` — register/heartbeat/ingest/project/events/status).
// `install` and `serve` are verbs of the PYTHON console script
// (`[project.scripts] crucible-axi = "crucible_axi.cli:main"`), NOT of the bun
// fleet CLI, and C3 already shipped + unit-tested them Python-side. Making the
// bun CLI grow an `install`/`serve` verb would be a wrong-package code change
// that this CR's docs-only §S4 does not authorise. So what this block asserts
// is the thing §S4/AC6 actually owns and that is genuinely broken today: the
// DOCUMENTED command surface must cover every verb the shipped CLI dispatches
// — derived from the real `_COMMANDS` table in `crucible_axi/cli.py` rather
// than hardcoded, so the docs cannot drift from the code again (this CR's
// whole failure mode).
//
// RED phase: `_COMMANDS` is {"install", "serve"}; README documents
// `crucible-axi install` but NOT `crucible-axi serve` (it documents a bare
// `crucible-server`, which nothing installs), so the coverage assertion FAILS
// on the `serve` verb.
// ---------------------------------------------------------------------------

/**
 * The verbs the shipped `crucible-axi` console script really dispatches,
 * parsed out of `crucible_axi/cli.py`'s `_COMMANDS` table — the single source
 * of truth for the CLI's verb surface.
 */
function shippedCrucibleAxiVerbs(): string[] {
  const source = readFileSync(
    join(import.meta.dir, "..", "crucible_axi", "cli.py"),
    "utf8",
  );
  const table = source.match(/^_COMMANDS\s*=\s*\{([\s\S]*?)^\}/m);
  if (table === null) return [];
  return [...table[1].matchAll(/"([a-z][a-z0-9-]*)"\s*:/g)].map((m) => m[1]);
}

describe("CR-CRU-066 §S4/AC6 documented CLI surface vs the shipped verb table", () => {
  test("`crucible_axi/cli.py` dispatches both `install` and `serve` (guards the parse)", () => {
    const verbs = shippedCrucibleAxiVerbs();
    expect(verbs).toContain("install");
    expect(verbs).toContain("serve");
  });

  test("README documents `crucible-axi <verb>` for EVERY dispatched verb", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    const verbs = shippedCrucibleAxiVerbs();
    expect(verbs.length).toBeGreaterThan(0);

    const undocumented = verbs.filter((verb) => !readme.includes(`crucible-axi ${verb}`));
    expect(undocumented).toEqual([]);
  });

  test("docs/RUNBOOK.md documents the run verb (`serve`) it tells operators to use", () => {
    const runbook = readFileSync(
      join(import.meta.dir, "..", "docs", "RUNBOOK.md"),
      "utf8",
    );
    expect(shippedCrucibleAxiVerbs()).toContain("serve");
    expect(runbook).toContain("crucible-axi serve");
  });
});
