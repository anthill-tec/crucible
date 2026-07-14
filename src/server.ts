// CR-CRU-001 §S6 — minimal production boot + GET /api/health.
// CR-CRU-003 extends this server with the shim routes.

import { mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Store } from "./store.ts";

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

export function startServer(opts?: StartServerOpts): ServerHandle {
  const dbPath = opts?.dbPath ?? "data/crucible.db";
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const store = Store.open(dbPath);
  const startedAt = Date.now();

  const server = Bun.serve({
    port: opts?.port ?? Number(process.env.CRUCIBLE_PORT ?? 3849),
    fetch(req: Request): Response {
      const url = new URL(req.url);
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
