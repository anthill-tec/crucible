// CR-CRU-001 §S6 — minimal production boot + GET /api/health.
// CR-CRU-003 extends this server with the shim routes.

import { mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codecs, parseRunBody } from "./codecs/index.ts";
import { parseCompile } from "./codecs/compile.ts";
import { Store, UUID_RE } from "./store.ts";
import type { TouchAgentOpts } from "./store.ts";
import { handleV2 } from "./v2.ts";
import type { AgentIdentity, Coverage, RunSchema, RunSummary, SuiteNode } from "./types.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export interface StartServerOpts {
  port?: number;
  hostname?: string;
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

  const parsed = await parseRunBody(codec, body);
  if ("error" in parsed) return err(400, parsed.error);
  const { run } = parsed;

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

/** CR-CRU-004 §S3 — SSE stream: hello frame, store-change frames, keep-alives. */
function handleStream(store: Store, req: Request): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const cleanup = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (keepAlive !== undefined) {
      clearInterval(keepAlive);
      keepAlive = undefined;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Client is gone (enqueue after close/error) — tear everything down.
          cleanup();
        }
      };
      send(`data: ${JSON.stringify({ type: "hello", version: pkg.version })}\n\n`);
      unsubscribe = store.onChange((kind, projectKey) => {
        send(`data: ${JSON.stringify({ type: kind, projectKey })}\n\n`);
      });
      keepAlive = setInterval(() => {
        send(`: keep-alive ${Date.now()}\n\n`);
      }, 15_000);
      // reader.cancel() from a fetch client surfaces as request abort here.
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed/errored — nothing left to release.
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

// ── CR-CRU-006 §S1/§S2 — static SPA serving from public/ ───────────────────

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL("../public", import.meta.url)));

/** Extensions the static handler serves directly; anything else falls to the SPA. */
const STATIC_TYPES = new Map<string, string>([
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
]);

/**
 * §S1 path safety + §S2 SPA fallback:
 * - percent-decoded traversal escaping public/ → 404;
 * - known-extension file present → served with its content-type;
 * - known-extension file MISSING → 404 (never the SPA shell as .js/.css);
 * - everything else (no extension, unknown extension) → index.html.
 */
async function handleStatic(url: URL): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  // Dotfile segments (".env", ".git", residual "..") are never served and
  // never fall back to the SPA — WHATWG URL normalization already collapses
  // %2e%2e dot-segments, so what remains here is a hidden-file probe.
  if (pathname.split("/").some((seg) => seg.startsWith("."))) {
    return new Response("Not Found", { status: 404 });
  }

  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return new Response("Not Found", { status: 404 });
  }

  const type = STATIC_TYPES.get(path.extname(resolved).toLowerCase());
  if (type !== undefined) {
    const file = Bun.file(resolved);
    if (await file.exists()) {
      return new Response(file, { headers: { "content-type": type } });
    }
    return new Response("Not Found", { status: 404 });
  }

  // §S2 — deep links (/, /p/<key>, overlay suffixes, extension-less paths)
  // all serve the shell; the client router takes it from there.
  const index = Bun.file(path.join(PUBLIC_DIR, "index.html"));
  return new Response(index, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function startServer(opts?: StartServerOpts): ServerHandle {
  const dbPath = opts?.dbPath ?? "data/crucible.db";
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const store = Store.open(dbPath);
  const startedAt = Date.now();

  // Shared by GET /api/health and GET /api/v2/health (§S1 health parity).
  const healthPayload = () => ({
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

  const server = Bun.serve({
    port: opts?.port ?? Number(process.env.CRUCIBLE_PORT ?? 3849),
    // The API is unauthenticated and dataPath ingest reads server-side files,
    // so stay loopback-only unless CRUCIBLE_HOST opts into wider exposure.
    hostname: opts?.hostname ?? process.env.CRUCIBLE_HOST ?? "127.0.0.1",
    // §S3 — SSE connections are long-lived and quiet between 15s keep-alives;
    // Bun's default 10s idleTimeout would reset them mid-stream.
    idleTimeout: 0,
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
        return Response.json(healthPayload());
      }
      // CR-CRU-004 §S3 — SSE change stream.
      if (req.method === "GET" && url.pathname === "/api/stream") {
        return handleStream(store, req);
      }
      // CR-CRU-004 §S1 — clean v2 surface, same store instance as the shim.
      if (url.pathname === "/api/v2" || url.pathname.startsWith("/api/v2/")) {
        const v2 = handleV2(store, req, url, { version: pkg.version, healthPayload });
        if (v2 !== null) {
          return v2;
        }
      }
      // §S2 — API error paths are always JSON {ok:false, error}.
      if (url.pathname.startsWith("/api/")) {
        return err(404, `unknown route: ${req.method} ${url.pathname}`);
      }
      // CR-CRU-006 §S1/§S2 — static SPA shell for every non-API GET.
      if (req.method === "GET") {
        return handleStatic(url);
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
