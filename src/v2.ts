// CR-CRU-004 §S1+§S5 — clean v2 API surface: orientation, health parity,
// project rollups (PRD §4.2), agent lifecycle verbs (PRD §4.3). Every write
// response carries `changed: true|false` (§S5). Shares the ONE store instance
// with the v1 shim — src/server.ts wires handleV2 into its dispatcher.
import { Store, UUID_RE } from "./store.ts";
import type { TouchAgentOpts } from "./store.ts";
import type { AgentIdentity, Project } from "./types.ts";

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
  return null;
}
