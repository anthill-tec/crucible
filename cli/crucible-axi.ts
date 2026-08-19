// CR-CRU-008 §S1 — `crucible-axi`: the fleet CLI for the Crucible server.
//
// A thin, ZERO-dependency client (bun builtins + fetch only). TOON output is
// the SERVER's own negotiation (Accept: text/toon) piped straight through —
// nothing is re-rendered client-side. House idiom: data to stdout, progress/
// errors to stderr. DI mirrors src/server.ts's StartServerOpts style so unit
// tests inject argv/baseUrl/cwd/streams/fetch; the `import.meta.main` binary
// path reads CRUCIBLE_URL (analogous to CRUCIBLE_PORT/CRUCIBLE_HOST).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunCliOpts {
  argv: string[];
  baseUrl: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  stdin?: { text(): Promise<string> };
  fetchImpl?: typeof fetch;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

interface GitContext {
  branch?: string;
  commit?: string;
}

interface RunContext {
  git?: GitContext;
  wave?: string;
  orchestrator?: string;
}

// ── argv parsing ────────────────────────────────────────────────────────────

/** Every crucible-axi flag takes exactly one value: `--flag value`. */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined) {
        flags[name] = "";
      } else {
        flags[name] = value;
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

// ── project-key resolution (.env CRUCIBLE_PROJECT_KEY discovery) ────────────

function resolveProjectKey(flags: Record<string, string>, cwd: string): string | null {
  const explicit = flags["project-key"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    const text = readFileSync(join(cwd, ".env"), "utf8");
    const match = text.match(/^\s*CRUCIBLE_PROJECT_KEY\s*=\s*(\S+)\s*$/m);
    if (match !== null) return match[1]!;
  } catch {
    // No .env in cwd — graceful: fall through to null (caller reports).
  }
  return null;
}

// ── git context auto-detect ─────────────────────────────────────────────────

function gitOutput(args: string[], cwd: string, env: Record<string, string | undefined>): string | null {
  try {
    const res = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) return null;
    const out = res.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Auto-detects {branch, commit} from cwd; null outside a repo (graceful). */
function detectGit(cwd: string, env: Record<string, string | undefined>): GitContext | null {
  const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd, env);
  const commit = gitOutput(["rev-parse", "HEAD"], cwd, env);
  if (branch === null || commit === null) return null;
  return { branch, commit };
}

/**
 * Builds the run context: explicit --branch/--commit override auto-detect
 * entirely; --wave/--orchestrator are recorded verbatim. Returns undefined
 * when there is nothing to record — the `context` key is then OMITTED.
 */
function buildContext(
  flags: Record<string, string>,
  cwd: string,
  env: Record<string, string | undefined>,
): RunContext | undefined {
  const explicitGit = flags["branch"] !== undefined || flags["commit"] !== undefined;
  const git: GitContext | null = explicitGit
    ? {
        ...(flags["branch"] !== undefined ? { branch: flags["branch"] } : {}),
        ...(flags["commit"] !== undefined ? { commit: flags["commit"] } : {}),
      }
    : detectGit(cwd, env);
  const context: RunContext = {
    ...(git !== null ? { git } : {}),
    ...(flags["wave"] !== undefined ? { wave: flags["wave"] } : {}),
    ...(flags["orchestrator"] !== undefined ? { orchestrator: flags["orchestrator"] } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  opts: RunCliOpts,
): Promise<number> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    opts.stderr.write(`error: ${res.status} from ${url}: ${text}\n`);
    return 1;
  }
  opts.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

/** GET with server-side TOON negotiation (Accept header — clean URLs). */
async function getToon(fetchImpl: typeof fetch, url: string, opts: RunCliOpts): Promise<number> {
  const res = await fetchImpl(url, { headers: { accept: "text/toon" } });
  const text = await res.text();
  if (!res.ok) {
    opts.stderr.write(`error: ${res.status} from ${url}: ${text}\n`);
    return 1;
  }
  opts.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

// ── commands ────────────────────────────────────────────────────────────────

/**
 * CR-CRU-044 §S3 — the role enumeration, identical to the five Python
 * clients' argparse `choices`. `register` requires one of these.
 */
const ROLE_ENUM: string[] = ["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"];

/** No-arg dashboard: health probe (stderr on failure), then GET /api/v2 TOON. */
async function commandDashboard(fetchImpl: typeof fetch, opts: RunCliOpts): Promise<number> {
  try {
    const health = await fetchImpl(`${opts.baseUrl}/api/health`);
    if (!health.ok) {
      opts.stderr.write(`error: ${opts.baseUrl}/api/health answered ${health.status} — is the Crucible server up?\n`);
      return 1;
    }
    await health.text();
  } catch {
    opts.stderr.write(`error: cannot reach ${opts.baseUrl}/api/health — is the Crucible server up?\n`);
    return 1;
  }
  return getToon(fetchImpl, `${opts.baseUrl}/api/v2`, opts);
}

async function commandAgentVerb(
  verb: "register" | "heartbeat" | "unregister",
  fetchImpl: typeof fetch,
  parsed: ParsedArgs,
  opts: RunCliOpts,
): Promise<number> {
  const projectKey = resolveProjectKey(parsed.flags, opts.cwd);
  if (projectKey === null) {
    opts.stderr.write("error: no project key — pass --project-key or set CRUCIBLE_PROJECT_KEY in ./.env\n");
    return 1;
  }
  const agentId = parsed.flags["agent"];
  if (agentId === undefined || agentId.length === 0) {
    opts.stderr.write(`error: ${verb} requires --agent <id>\n`);
    return 1;
  }
  // CR-CRU-044 §S3 — a registration must DECLARE its role, and the value is
  // validated CLIENT-SIDE (no network round-trip for a bad one), matching the
  // argparse-level enum the five Python clients enforce. The agentId itself is
  // a free-form identifier — role is never inferred from its shape.
  // heartbeat/unregister never re-declare the role.
  let body: Record<string, string>;
  if (verb === "register") {
    const role = parsed.flags["role"];
    if (role === undefined || !ROLE_ENUM.includes(role)) {
      const what = role === undefined ? "requires --role <role>" : `rejects --role ${role}`;
      opts.stderr.write(
        `error: register ${what} — accepted values: ${ROLE_ENUM.join(", ")}\n`,
      );
      return 2;
    }
    body = { projectKey, agentId, role };
  } else {
    body = { projectKey, agentId };
  }
  return postJson(fetchImpl, `${opts.baseUrl}/api/v2/agents/${verb}`, body, opts);
}

async function commandIngest(
  fetchImpl: typeof fetch,
  parsed: ParsedArgs,
  env: Record<string, string | undefined>,
  opts: RunCliOpts,
): Promise<number> {
  const path = parsed.positional[1];
  if (path === undefined) {
    opts.stderr.write("error: ingest requires a report path: crucible-axi ingest <junit.xml>\n");
    return 1;
  }
  const projectKey = resolveProjectKey(parsed.flags, opts.cwd);
  if (projectKey === null) {
    opts.stderr.write("error: no project key — pass --project-key or set CRUCIBLE_PROJECT_KEY in ./.env\n");
    return 1;
  }
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch (err) {
    opts.stderr.write(`error: cannot read ${path}: ${String(err)}\n`);
    return 1;
  }
  const context = buildContext(parsed.flags, opts.cwd, env);
  return postJson(
    fetchImpl,
    `${opts.baseUrl}/api/v2/runs`,
    {
      projectKey,
      codec: parsed.flags["codec"] ?? "junit",
      data,
      ...(parsed.flags["agent"] !== undefined ? { agentId: parsed.flags["agent"] } : {}),
      ...(parsed.flags["tier"] !== undefined ? { tier: parsed.flags["tier"] } : {}),
      ...(context !== undefined ? { context } : {}),
    },
    opts,
  );
}

async function commandIngestParsed(
  fetchImpl: typeof fetch,
  parsed: ParsedArgs,
  env: Record<string, string | undefined>,
  opts: RunCliOpts,
): Promise<number> {
  const projectKey = resolveProjectKey(parsed.flags, opts.cwd);
  if (projectKey === null) {
    opts.stderr.write("error: no project key — pass --project-key or set CRUCIBLE_PROJECT_KEY in ./.env\n");
    return 1;
  }
  if (opts.stdin === undefined) {
    opts.stderr.write("error: ingest-parsed reads its JSON payload from stdin\n");
    return 1;
  }
  let payload: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(await opts.stdin.text());
    if (typeof raw !== "object" || raw === null) throw new Error("payload must be a JSON object");
    payload = raw as Record<string, unknown>;
  } catch (err) {
    opts.stderr.write(`error: malformed JSON on stdin: ${String(err)}\n`);
    return 1;
  }
  const context = buildContext(parsed.flags, opts.cwd, env);
  return postJson(
    fetchImpl,
    `${opts.baseUrl}/api/v2/runs/parsed`,
    {
      ...payload,
      projectKey,
      ...(parsed.flags["agent"] !== undefined ? { agentId: parsed.flags["agent"] } : {}),
      ...(parsed.flags["tier"] !== undefined ? { tier: parsed.flags["tier"] } : {}),
      ...(context !== undefined ? { context } : {}),
    },
    opts,
  );
}

async function commandIngestCompile(
  fetchImpl: typeof fetch,
  parsed: ParsedArgs,
  env: Record<string, string | undefined>,
  opts: RunCliOpts,
): Promise<number> {
  const path = parsed.positional[1];
  if (path === undefined) {
    opts.stderr.write("error: ingest-compile requires a file path: crucible-axi ingest-compile <errors.txt>\n");
    return 1;
  }
  const projectKey = resolveProjectKey(parsed.flags, opts.cwd);
  if (projectKey === null) {
    opts.stderr.write("error: no project key — pass --project-key or set CRUCIBLE_PROJECT_KEY in ./.env\n");
    return 1;
  }
  let errors: string;
  try {
    errors = readFileSync(path, "utf8");
  } catch (err) {
    opts.stderr.write(`error: cannot read ${path}: ${String(err)}\n`);
    return 1;
  }
  const context = buildContext(parsed.flags, opts.cwd, env);
  return postJson(
    fetchImpl,
    `${opts.baseUrl}/api/v2/runs/compile`,
    {
      projectKey,
      errors,
      ...(parsed.flags["agent"] !== undefined ? { agentId: parsed.flags["agent"] } : {}),
      ...(parsed.flags["format"] !== undefined ? { format: parsed.flags["format"] } : {}),
      ...(context !== undefined ? { context } : {}),
    },
    opts,
  );
}

async function commandProject(fetchImpl: typeof fetch, parsed: ParsedArgs, opts: RunCliOpts): Promise<number> {
  const sub = parsed.positional[1];
  if (sub === "add") {
    const name = parsed.flags["name"];
    if (name === undefined || name.length === 0) {
      opts.stderr.write("error: project add requires --name <name>\n");
      return 1;
    }
    return postJson(fetchImpl, `${opts.baseUrl}/api/v2/projects`, { name }, opts);
  }
  if (sub === "list") {
    return getToon(fetchImpl, `${opts.baseUrl}/api/v2/projects`, opts);
  }
  opts.stderr.write("error: unknown project subcommand — use `project add --name <n>` or `project list`\n");
  return 2;
}

async function commandScopedRead(
  route: "events" | "status",
  fetchImpl: typeof fetch,
  parsed: ParsedArgs,
  opts: RunCliOpts,
): Promise<number> {
  const projectKey = resolveProjectKey(parsed.flags, opts.cwd);
  if (projectKey === null) {
    opts.stderr.write("error: no project key — pass --project-key or set CRUCIBLE_PROJECT_KEY in ./.env\n");
    return 1;
  }
  const query = new URLSearchParams({ project: projectKey });
  return getToon(fetchImpl, `${opts.baseUrl}/api/v2/${route}?${query.toString()}`, opts);
}

// ── entry ───────────────────────────────────────────────────────────────────

export async function runCli(opts: RunCliOpts): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const parsed = parseArgs(opts.argv);
  const command = parsed.positional[0];

  try {
    switch (command) {
      case undefined:
        return await commandDashboard(fetchImpl, opts);
      case "register":
      case "heartbeat":
      case "unregister":
        return await commandAgentVerb(command, fetchImpl, parsed, opts);
      case "ingest":
        return await commandIngest(fetchImpl, parsed, env, opts);
      case "ingest-parsed":
        return await commandIngestParsed(fetchImpl, parsed, env, opts);
      case "ingest-compile":
        return await commandIngestCompile(fetchImpl, parsed, env, opts);
      case "project":
        return await commandProject(fetchImpl, parsed, opts);
      case "events":
      case "status":
        return await commandScopedRead(command, fetchImpl, parsed, opts);
      default:
        opts.stderr.write(`error: unknown command: ${command}\n`);
        return 2;
    }
  } catch (err) {
    opts.stderr.write(`error: ${String(err)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli({
    argv: process.argv.slice(2),
    baseUrl: process.env.CRUCIBLE_URL ?? "http://127.0.0.1:3849",
    cwd: process.cwd(),
    env: process.env,
    stdout: { write: (chunk: string) => void process.stdout.write(chunk) },
    stderr: { write: (chunk: string) => void process.stderr.write(chunk) },
    stdin: { text: () => Bun.stdin.text() },
  });
  process.exit(code);
}
