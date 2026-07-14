// CR-CRU-001 §S6 — minimal production boot + GET /api/health.
// CR-CRU-003 extends this server with the shim routes.

import { mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { codecs } from "./codecs/index.ts";
import { parseCompile } from "./codecs/compile.ts";
import { parseJunitPath } from "./codecs/junit.ts";
import { Store, UUID_RE } from "./store.ts";
import type { RunSchema } from "./types.ts";

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
      if (req.method === "POST" && url.pathname === "/api/ingest") {
        return handleIngest(store, req);
      }
      if (req.method === "POST" && url.pathname === "/api/ingest/compile") {
        return handleIngestCompile(store, req);
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
