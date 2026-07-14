// CR-CRU-001 §S6 — minimal production boot + GET /api/health.
// CR-CRU-003 extends this server with the shim routes.

import { mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { codecs } from "./codecs/index.ts";
import { parseCompile } from "./codecs/compile.ts";
import { parseJunitPath } from "./codecs/junit.ts";
import { Store, UUID_RE } from "./store.ts";
import type { TouchAgentOpts } from "./store.ts";
import type { AgentIdentity, Coverage, RunSchema, RunSummary, SuiteNode } from "./types.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export interface StartServerOpts {
  port?: number;
  dbPath?: string;
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  store: Store;
  stop(): void;
}

interface IngestBody {
  projectKey?: unknown;
  format?: unknown;
  data?: unknown;
  dataPath?: unknown;
  agentId?: unknown;
  errors?: unknown;
  // CR-CRU-003 §S1/§S2 shim fields
  key?: unknown;
  name?: unknown;
  sut_root?: unknown;
  status?: unknown;
  message?: unknown;
  identity?: unknown;
  summary?: unknown;
  tree?: unknown;
  coverage?: unknown;
  eventId?: unknown;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function err(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

async function readBody(req: Request): Promise<IngestBody | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as IngestBody;
  } catch {
    return null;
  }
}

/** CR-CRU-002 §S4 — shared projectKey validation: UUID shape then existence. */
function validateProjectKey(store: Store, body: IngestBody): { key: string } | { fail: Response } {
  const key = body.projectKey;
  if (typeof key !== "string" || !UUID_RE.test(key)) {
    return { fail: err(400, "projectKey must be a UUID") };
  }
  if (store.getProject(key) === null) {
    return { fail: err(404, `unknown project: ${key}`) };
  }
  return { key };
}

async function handleIngest(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const pk = validateProjectKey(store, body);
  if ("fail" in pk) return pk.fail;

  const format = typeof body.format === "string" ? body.format : "junit";
  const codec = codecs.get(format);
  if (codec === undefined) return err(400, `unsupported format: ${format}`);

  let run: RunSchema;
  if (typeof body.data === "string") {
    run = await codec.parse(body.data);
  } else if (typeof body.dataPath === "string") {
    run = await parseJunitPath(body.dataPath);
  } else {
    return err(400, "either data or dataPath is required");
  }

  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  store.recordTestEvent(pk.key, agentId, run, { codec: format });
  return json({ ok: true, summary: run.summary });
}

async function handleIngestCompile(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const pk = validateProjectKey(store, body);
  if ("fail" in pk) return pk.fail;

  if (typeof body.errors !== "string" || body.errors.length === 0) {
    return err(400, "errors must be a non-empty string");
  }

  const format = typeof body.format === "string" ? body.format : undefined;
  const report = parseCompile(body.errors, format);
  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  store.recordCompileEvent(pk.key, agentId, report, { codec: report.format });
  return json({
    ok: true,
    summary: { failed: report.errorCount, pending: report.warningCount },
  });
}

// ── CR-CRU-003 §S1+§S2 — v1 shim routes: ingest/parsed + events ────────────

async function handleIngestParsed(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const pk = validateProjectKey(store, body);
  if ("fail" in pk) return pk.fail;

  if (typeof body.summary !== "object" || body.summary === null) {
    return err(400, "summary is required");
  }
  if (!Array.isArray(body.tree)) {
    return err(400, "tree is required");
  }

  const summary = body.summary as RunSummary;
  const run: RunSchema = {
    summary,
    tree: body.tree as SuiteNode[],
    // §S4 discard-on-fail is applied by the store; pass coverage through.
    ...(typeof body.coverage === "object" && body.coverage !== null
      ? { coverage: body.coverage as Coverage }
      : {}),
  };

  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  store.recordTestEvent(pk.key, agentId, run, {
    codec: "parsed",
    ...(typeof body.name === "string" ? { name: body.name } : {}),
  });
  // §S1 — echoes the input summary verbatim.
  return json({ ok: true, summary });
}

async function handleIngestClear(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const pk = validateProjectKey(store, body);
  if ("fail" in pk) return pk.fail;

  return json({ ok: true, cleared: store.clearEvents(pk.key) });
}

/** PRD §4.9 — brief of an event for /api/ingest/status. */
function eventBrief(event: { id: string; agentId: string; timestamp: number }) {
  return { id: event.id, agentId: event.agentId, timestamp: event.timestamp };
}

function handleIngestStatus(store: Store, url: URL): Response {
  const projectKey = url.searchParams.get("projectKey");
  if (projectKey === null) {
    return err(400, "projectKey query parameter is required");
  }

  const events = store.listEvents(projectKey, Number.MAX_SAFE_INTEGER);
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

function handleEventsList(store: Store, url: URL): Response {
  const projectKey = url.searchParams.get("projectKey") ?? undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
  return json({ ok: true, events: store.listEvents(projectKey, limit) });
}

async function handleEventsDelete(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const eventId = body.eventId;
  if (typeof eventId !== "string" || eventId.length === 0) {
    return err(400, "eventId is required");
  }
  const pk = validateProjectKey(store, body);
  if ("fail" in pk) return pk.fail;

  // §S2 — wrong projectKey (event not in that project) → HTTP 200 {ok:false}.
  return json({ ok: store.deleteEvent(eventId, pk.key) });
}

async function handleEventsClear(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const pk = validateProjectKey(store, body);
  if ("fail" in pk) return pk.fail;

  return json({ ok: true, cleared: store.clearEvents(pk.key) });
}

// ── CR-CRU-003 §S1+§S2 — v1 shim routes: projects + agents ─────────────────

async function handleProjectAdd(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const key = body.key;
  if (typeof key !== "string" || !UUID_RE.test(key)) {
    return err(400, "key must be a UUID");
  }
  // §S2 v1 quirk — duplicate key → 400 {ok:false}.
  if (store.getProject(key) !== null) {
    return err(400, `project already registered: ${key}`);
  }

  const name = typeof body.name === "string" ? body.name : "";
  // §S2 — sut_root stays snake_case on this path only; stored as sutRoot.
  const sutRoot = typeof body.sut_root === "string" ? body.sut_root : "";
  const project = store.addProject({ key, name, type: "backend", sutRoot });
  return json({ ok: true, project });
}

function handleProjectsList(store: Store, url: URL): Response {
  const name = url.searchParams.get("name");
  let projects = store.listProjects();
  if (name !== null) {
    const needle = name.toLowerCase();
    projects = projects.filter((p) => p.name.toLowerCase().includes(needle));
  }
  return json({ ok: true, projects });
}

async function handleAgentHeartbeat(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const pk = validateProjectKey(store, body);
  if ("fail" in pk) return pk.fail;

  const agentId = body.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return err(400, "agentId is required");
  }

  // §S2 — top-level displayName/source are accepted but IGNORED; only the
  // identity object is honored (Store.touchAgent merge-preserves it).
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
  return json({ ok: true });
}

async function handleAgentRemove(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return err(400, "malformed JSON body");

  const agentId = body.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return err(400, "agentId is required");
  }

  // DN §3.3 — projectKey omitted removes the agent across ALL projects.
  const projectKey = typeof body.projectKey === "string" ? body.projectKey : undefined;
  store.removeAgent(projectKey, agentId);
  return json({ ok: true });
}

function handleAgentsList(store: Store, url: URL): Response {
  const projectKey = url.searchParams.get("projectKey") ?? undefined;
  return json({ ok: true, agents: store.listAgents(projectKey) });
}

export function startServer(opts?: StartServerOpts): ServerHandle {
  const dbPath = opts?.dbPath ?? "data/crucible.db";
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const store = Store.open(dbPath);
  const startedAt = Date.now();

  const server = Bun.serve({
    port: opts?.port ?? Number(process.env.CRUCIBLE_PORT ?? 3849),
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/projects/add") {
        return handleProjectAdd(store, req);
      }
      if (req.method === "GET" && url.pathname === "/api/projects") {
        return handleProjectsList(store, url);
      }
      if (req.method === "POST" && url.pathname === "/api/agents/heartbeat") {
        return handleAgentHeartbeat(store, req);
      }
      if (req.method === "POST" && url.pathname === "/api/agents/remove") {
        return handleAgentRemove(store, req);
      }
      if (req.method === "GET" && url.pathname === "/api/agents") {
        return handleAgentsList(store, url);
      }
      if (req.method === "POST" && url.pathname === "/api/ingest") {
        return handleIngest(store, req);
      }
      if (req.method === "POST" && url.pathname === "/api/ingest/compile") {
        return handleIngestCompile(store, req);
      }
      if (req.method === "POST" && url.pathname === "/api/ingest/parsed") {
        return handleIngestParsed(store, req);
      }
      if (req.method === "POST" && url.pathname === "/api/ingest/clear") {
        return handleIngestClear(store, req);
      }
      if (req.method === "GET" && url.pathname === "/api/ingest/status") {
        return handleIngestStatus(store, url);
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        return handleEventsList(store, url);
      }
      if (req.method === "POST" && url.pathname === "/api/events/delete") {
        return handleEventsDelete(store, req);
      }
      if (req.method === "POST" && url.pathname === "/api/events/clear") {
        return handleEventsClear(store, req);
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        return Response.json({
          ok: true,
          status: "healthy",
          version: pkg.version,
          uptime_s: (Date.now() - startedAt) / 1000,
          counts: {
            projects: store.listProjects().length,
            agents: store.listAgents().length,
            events: store.countEvents(),
          },
        });
      }
      // §S2 — API error paths are always JSON {ok:false, error}.
      if (url.pathname.startsWith("/api/")) {
        return err(404, `unknown route: ${req.method} ${url.pathname}`);
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    server,
    store,
    stop: () => {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const { server } = startServer();
  console.log(`[crucible] listening on http://localhost:${server.port}`);
}
