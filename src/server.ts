// CR-CRU-001 §S6 — minimal production boot + GET /api/health.
// CR-CRU-008 §S4 — the CR-CRU-003 v1 shim routes are RETIRED (soak-gated):
// every legacy /api/* route now falls through to the generic 404 JSON.
// /api/health and /api/stream stay (pinned controls); the full v2 surface
// lives in src/v2.ts. The retired contract is archived in
// tests/archive/v1-contract.test.ts.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { handleV2 } from "./v2.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export interface StartServerOpts {
  port?: number;
  hostname?: string;
  dbPath?: string;
}

/** CR-CRU-043 §S1-§S3 — inputs to the DB path resolver (all defaulted). */
export interface ResolveDbPathOpts {
  /** Base directory for the rule-3 `./data/crucible.db` probe; defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment to read `CRUCIBLE_DB` / `XDG_DATA_HOME` / `HOME` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** An explicit path (including `":memory:"`), which outranks everything else. */
  dbPath?: string;
}

/**
 * CR-CRU-043 §S1-§S3 — resolve the store path, first match wins:
 *   1. explicit `opts.dbPath` (returned verbatim, `":memory:"` included);
 *   2. `CRUCIBLE_DB`;
 *   3. an ALREADY-EXISTING `<cwd>/data/crucible.db` — adopt only, never created here,
 *      which is what keeps the live dog-food instance in use from the repo root;
 *   4. `<XDG_DATA_HOME or <HOME>/.local/share>/crucible/crucible.db`.
 *
 * Pure: computes a string and never touches the filesystem beyond the rule-3
 * existence probe. The `HOME` fallback deliberately reads `env.HOME` rather than
 * `os.homedir()` — Bun caches `HOME` at process startup, so `os.homedir()` cannot
 * observe an injected env and the contract would be untestable.
 */
export function resolveDbPath(opts?: ResolveDbPathOpts): string {
  if (opts?.dbPath !== undefined) {
    return opts.dbPath;
  }
  const env = opts?.env ?? process.env;
  const fromEnv = env.CRUCIBLE_DB;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const cwd = opts?.cwd ?? process.cwd();
  const cwdDb = path.join(cwd, "data", "crucible.db");
  if (existsSync(cwdDb)) {
    return cwdDb;
  }
  const xdg = env.XDG_DATA_HOME;
  const dataHome =
    xdg !== undefined && xdg !== "" ? xdg : path.join(env.HOME ?? "", ".local", "share");
  return path.join(dataHome, "crucible", "crucible.db");
}

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  store: Store;
  stop(): void;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function err(status: number, error: string): Response {
  return json({ ok: false, error }, status);
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
  // CR-CRU-043 §S1-§S3 — no CWD-relative default: explicit opts, then CRUCIBLE_DB,
  // then an existing ./data/crucible.db, then the user data directory.
  const dbPath = resolveDbPath({ dbPath: opts?.dbPath });
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
      // CR-CRU-008 §S4 — the v1 shim is RETIRED: no legacy /api/* routes
      // remain except /api/health and /api/stream below; everything else
      // falls through to the generic 404 JSON catch-all.
      if (req.method === "GET" && url.pathname === "/api/health") {
        return Response.json(healthPayload());
      }
      // CR-CRU-004 §S3 — SSE change stream.
      if (req.method === "GET" && url.pathname === "/api/stream") {
        return handleStream(store, req);
      }
      // CR-CRU-004 §S1 — clean v2 surface, same store instance the retired
      // shim used.
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
  const handle = startServer();
  console.log(`[crucible] listening on http://localhost:${handle.server.port}`);
  // CR-CRU-024 §S5.2 — a graceful stop checkpoints EVERY active cycle's timer
  // (all plans, all projects) before exit, so an orderly shutdown never loses
  // in-flight epoch state; only a hard power cut falls back to the <=60s
  // read-cadence tolerance (CR-023 §S3). Wired ONLY on the real boot path
  // (import.meta.main), so test teardown — which calls handle.stop() directly,
  // never a signal — is never affected.
  const gracefulStop = (signal: string): void => {
    const checkpointed = handle.store.checkpointAllActive();
    console.log(`[crucible] ${signal}: checkpointed ${checkpointed} active cycle(s), stopping`);
    handle.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => gracefulStop("SIGTERM"));
  process.on("SIGINT", () => gracefulStop("SIGINT"));
}
