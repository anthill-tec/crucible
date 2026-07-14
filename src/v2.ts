// CR-CRU-004 §S1+§S5 — clean v2 API surface: orientation, health parity,
// project rollups (PRD §4.2), agent lifecycle verbs (PRD §4.3). Every write
// response carries `changed: true|false` (§S5). Shares the ONE store instance
// with the v1 shim — src/server.ts wires handleV2 into its dispatcher.
import { codecs } from "./codecs/index.ts";
import { parseCompile } from "./codecs/compile.ts";
import { parseJunitPath } from "./codecs/junit.ts";
import { Store, UUID_RE } from "./store.ts";
import type { RecordEventMeta, TouchAgentOpts } from "./store.ts";
import type {
  AgentIdentity,
  Coverage,
  Project,
  RunContext,
  RunEvent,
  RunSchema,
  RunSummary,
  SuiteNode,
  Tier,
} from "./types.ts";

export interface V2Deps {
  version: string;
  /** Builds the exact same payload as GET /api/health (same store instance). */
  healthPayload: () => unknown;
}

interface V2Body {
  key?: unknown;
  name?: unknown;
  type?: unknown;
  sutRoot?: unknown;
  projectKey?: unknown;
  agentId?: unknown;
  status?: unknown;
  message?: unknown;
  identity?: unknown;
  // §S1 runs endpoints
  codec?: unknown;
  data?: unknown;
  dataPath?: unknown;
  summary?: unknown;
  tree?: unknown;
  coverage?: unknown;
  errors?: unknown;
  format?: unknown;
  // §S2 run context (graceful)
  tier?: unknown;
  stack?: unknown;
  context?: unknown;
}

// Next-step hints (plain JSON here; TOON polish is CR-CRU-005).
const ORIENTATION_HELP: string[] = [
  "POST /api/v2/projects {name, key?, type?, sutRoot?} — create a project (key auto-generated when omitted)",
  "GET /api/v2/projects — projects with rollups (agentsOnline, agentsTotal, lastEvent, latestGreenCoverage)",
  "POST /api/v2/agents/register {projectKey, agentId} — register an agent",
  "GET /api/v2/health — service health",
];

const AGENT_HELP: string[] = [
  "POST /api/v2/agents/heartbeat {projectKey, agentId, status?, message?} — keep the agent alive",
  "POST /api/v2/agents/unregister {projectKey, agentId} — remove the agent",
  "GET /api/v2/agents?project=<key> — list agents with computed liveness",
];

const UNKNOWN_PROJECT_HELP: string[] = [
  "GET /api/v2/projects — list registered projects and their keys",
  "POST /api/v2/projects {name} — register a new project (key auto-generated)",
];

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function fail(status: number, error: string, extra?: Record<string, unknown>): Response {
  return json({ ok: false, error, ...extra }, status);
}

async function readBody(req: Request): Promise<V2Body | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as V2Body;
  } catch {
    return null;
  }
}

/** §S1 — projectKey validation: UUID shape (400) then existence (404 + help). */
function requireProject(store: Store, key: unknown): { key: string } | { fail: Response } {
  if (typeof key !== "string" || !UUID_RE.test(key)) {
    return { fail: fail(400, "projectKey must be a UUID", { help: UNKNOWN_PROJECT_HELP }) };
  }
  if (store.getProject(key) === null) {
    return { fail: fail(404, `unknown project: ${key}`, { help: UNKNOWN_PROJECT_HELP }) };
  }
  return { key };
}

function handleOrientation(store: Store, deps: V2Deps): Response {
  return json({
    ok: true,
    service: "crucible",
    version: deps.version,
    projects: store.listProjects(),
    help: ORIENTATION_HELP,
  });
}

async function handleProjectCreate(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");

  let key: string;
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || !UUID_RE.test(body.key)) {
      return fail(400, "key must be a UUID");
    }
    key = body.key;
    const existing = store.getProject(key);
    if (existing !== null) {
      // §S1 — duplicate key → 200 {ok:true, changed:false} (NOT 400, unlike the shim).
      return json({ ok: true, changed: false, project: existing });
    }
  } else {
    key = Bun.randomUUIDv7();
  }

  if (typeof body.name !== "string" || body.name.length === 0) {
    return fail(400, "name is required");
  }
  const type: Project["type"] = body.type === "frontend" ? "frontend" : "backend";
  const sutRoot = typeof body.sutRoot === "string" ? body.sutRoot : "";
  const project = store.addProject({ key, name: body.name, type, sutRoot });
  return json({ ok: true, changed: true, project });
}

/** PRD §4.2 — project rollups. */
function handleProjectsList(store: Store): Response {
  const projects = store.listProjects().map((project) => {
    const agents = store.listAgents(project.key);
    const events = store.listEvents(project.key, Number.MAX_SAFE_INTEGER);
    const last = events[0];
    // §S4 (CR-CRU-001) discards coverage on failed runs, so any stored
    // coverage belongs to a green run — newest one wins.
    const greenCovered = events.find((e) => e.coverage !== undefined);
    return {
      ...project,
      agentsOnline: agents.filter((a) => a.liveness === "online").length,
      agentsTotal: agents.length,
      lastEvent:
        last !== undefined ? { id: last.id, agentId: last.agentId, timestamp: last.timestamp } : null,
      latestGreenCoverage: greenCovered?.coverage ?? null,
    };
  });
  return json({ ok: true, projects });
}

/** §S1 — register and heartbeat share these semantics (upsert via touchAgent). */
async function handleAgentTouch(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;
  const agentId = body.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return fail(400, "agentId is required");
  }

  const existed = store.listAgents(pk.key).some((a) => a.agentId === agentId);
  const opts: TouchAgentOpts = {};
  if (body.status === "busy" || body.status === "online") {
    opts.status = body.status;
  }
  if (typeof body.message === "string") {
    opts.message = body.message;
  }
  if (typeof body.identity === "object" && body.identity !== null) {
    opts.identity = body.identity as AgentIdentity;
  }
  store.touchAgent(pk.key, agentId, opts);
  return json({ ok: true, changed: !existed, help: AGENT_HELP });
}

async function handleAgentUnregister(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;
  const agentId = body.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return fail(400, "agentId is required");
  }
  const existed = store.listAgents(pk.key).some((a) => a.agentId === agentId);
  store.removeAgent(pk.key, agentId);
  return json({ ok: true, changed: existed });
}

/** §S1 — each agent carries computed liveness; `?project=` filters. */
function handleAgentsList(store: Store, url: URL): Response {
  const project = url.searchParams.get("project") ?? undefined;
  return json({ ok: true, agents: store.listAgents(project) });
}

// ── §S1+§S2 — runs: raw codec ingest, parsed ingest, compile ingest ─────────

const TIERS: ReadonlySet<string> = new Set<Tier>([
  "unit",
  "module",
  "integration",
  "e2e",
  "regression",
  "bdd",
]);

/** §S2 — pull the optional {tier, stack, context} trio verbatim, never fabricated. */
function runMeta(body: V2Body): Pick<RecordEventMeta, "tier" | "stack" | "context"> {
  return {
    ...(typeof body.tier === "string" && TIERS.has(body.tier) ? { tier: body.tier as Tier } : {}),
    ...(typeof body.stack === "string" ? { stack: body.stack } : {}),
    ...(typeof body.context === "object" && body.context !== null
      ? { context: body.context as RunContext }
      : {}),
  };
}

/** §S1 — one-line run verdict: RED when failed>0, GREEN otherwise. */
function runVerdict(summary: RunSummary): string {
  return summary.failed > 0
    ? `RED — ${summary.failed} failing of ${summary.total}`
    : `GREEN — ${summary.passed}/${summary.total} passed`;
}

function runResponse(eventId: string, summary: RunSummary, help?: string[]): Response {
  return json({
    ok: true,
    changed: true,
    event: eventId,
    run: summary,
    verdict: runVerdict(summary),
    ...(help !== undefined ? { help } : {}),
  });
}

async function handleRuns(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  const codecName = typeof body.codec === "string" ? body.codec : "junit";
  const codec = codecs.get(codecName);
  if (codec === undefined) return fail(400, `unknown codec: ${codecName}`);

  let run: RunSchema;
  if (typeof body.data === "string") {
    run = await codec.parse(body.data);
  } else if (typeof body.dataPath === "string") {
    run = await parseJunitPath(body.dataPath);
  } else {
    return fail(400, "either data or dataPath is required");
  }

  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: codecName,
    ...runMeta(body),
  });
  return runResponse(event.id, run.summary);
}

async function handleRunsParsed(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  if (typeof body.summary !== "object" || body.summary === null) {
    return fail(400, "summary is required");
  }
  if (!Array.isArray(body.tree)) {
    return fail(400, "tree is required");
  }

  const summary = body.summary as RunSummary;
  const hasCoverage = typeof body.coverage === "object" && body.coverage !== null;
  const run: RunSchema = {
    summary,
    tree: body.tree as SuiteNode[],
    // §S4 (CR-CRU-001) discard-on-fail is applied by the store; pass coverage through.
    ...(hasCoverage ? { coverage: body.coverage as Coverage } : {}),
  };

  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: "parsed",
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...runMeta(body),
  });
  // Coverage arrived but the store dropped it (failing run) — say so in help.
  const dropped = hasCoverage && event.coverage === undefined;
  return runResponse(
    event.id,
    summary,
    dropped ? ["coverage DISCARDED — coverage from a failing run is meaningless"] : undefined,
  );
}

async function handleRunsCompile(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  if (typeof body.errors !== "string" || body.errors.length === 0) {
    return fail(400, "errors must be a non-empty string");
  }

  const format = typeof body.format === "string" ? body.format : undefined;
  const report = parseCompile(body.errors, format);
  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  const event = store.recordCompileEvent(pk.key, agentId, report, {
    codec: report.format,
    ...runMeta(body),
  });
  const verdict =
    report.errorCount > 0
      ? `COMPILE FAILED — ${report.errorCount} errors, ${report.warningCount} warnings`
      : `COMPILE OK — ${report.warningCount} warnings`;
  return json({
    ok: true,
    changed: true,
    event: event.id,
    errors: report.errorCount,
    warnings: report.warningCount,
    verdict,
  });
}

// ── §S1 — events list/get/delete + status ───────────────────────────────────

/** Brief of an event for lists and status (full detail via /events/:id). */
function eventBrief(event: RunEvent) {
  return {
    id: event.id,
    agentId: event.agentId,
    kind: event.kind,
    tier: event.tier,
    timestamp: event.timestamp,
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
  };
}

function handleEventsList(store: Store, url: URL): Response {
  const project = url.searchParams.get("project") ?? undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
  // store.listEvents is newest-first already.
  return json({ ok: true, events: store.listEvents(project, limit).map(eventBrief) });
}

/** §S1 — event-specific 404 (distinct from the server's route catch-all). */
function handleEventGet(store: Store, id: string): Response {
  const event = store.getEvent(id);
  if (event === null) {
    return fail(404, `event not found: ${id}`);
  }
  return json({ ok: true, event });
}

function handleEventDelete(store: Store, id: string, url: URL): Response {
  const pk = requireProject(store, url.searchParams.get("project") ?? undefined);
  if ("fail" in pk) return pk.fail;
  if (!store.deleteEvent(id, pk.key)) {
    // §S1 — repeat delete / wrong project → 404, event-specific message.
    return fail(404, `event not found in project: ${id}`);
  }
  return json({ ok: true, changed: true });
}

function handleStatus(store: Store, url: URL): Response {
  const project = url.searchParams.get("project");
  if (project === null) {
    return fail(400, "project query parameter is required");
  }
  const events = store.listEvents(project, Number.MAX_SAFE_INTEGER);
  const lastTest = events.find((e) => e.kind === "test");
  const lastCompile = events.find((e) => e.kind === "compile");
  return json({
    ok: true,
    status: {
      hasData: events.length > 0,
      lastTest: lastTest !== undefined ? eventBrief(lastTest) : null,
      lastCompile: lastCompile !== undefined ? eventBrief(lastCompile) : null,
    },
  });
}

/**
 * Dispatch a /api/v2/* request. Returns null when the path/method is not a
 * v2 route handled here (the caller falls through to its catch-all).
 */
export function handleV2(
  store: Store,
  req: Request,
  url: URL,
  deps: V2Deps,
): Promise<Response> | Response | null {
  const { pathname } = url;
  if (req.method === "GET" && pathname === "/api/v2") {
    return handleOrientation(store, deps);
  }
  if (req.method === "GET" && pathname === "/api/v2/health") {
    return json(deps.healthPayload());
  }
  if (req.method === "POST" && pathname === "/api/v2/projects") {
    return handleProjectCreate(store, req);
  }
  if (req.method === "GET" && pathname === "/api/v2/projects") {
    return handleProjectsList(store);
  }
  if (
    req.method === "POST" &&
    (pathname === "/api/v2/agents/register" || pathname === "/api/v2/agents/heartbeat")
  ) {
    return handleAgentTouch(store, req);
  }
  if (req.method === "POST" && pathname === "/api/v2/agents/unregister") {
    return handleAgentUnregister(store, req);
  }
  if (req.method === "GET" && pathname === "/api/v2/agents") {
    return handleAgentsList(store, url);
  }
  if (req.method === "POST" && pathname === "/api/v2/runs") {
    return handleRuns(store, req);
  }
  if (req.method === "POST" && pathname === "/api/v2/runs/parsed") {
    return handleRunsParsed(store, req);
  }
  if (req.method === "POST" && pathname === "/api/v2/runs/compile") {
    return handleRunsCompile(store, req);
  }
  if (req.method === "GET" && pathname === "/api/v2/events") {
    return handleEventsList(store, url);
  }
  if (pathname.startsWith("/api/v2/events/")) {
    const id = pathname.slice("/api/v2/events/".length);
    if (id.length > 0 && !id.includes("/")) {
      if (req.method === "GET") {
        return handleEventGet(store, id);
      }
      if (req.method === "DELETE") {
        return handleEventDelete(store, id, url);
      }
    }
  }
  if (req.method === "GET" && pathname === "/api/v2/status") {
    return handleStatus(store, url);
  }
  return null;
}
