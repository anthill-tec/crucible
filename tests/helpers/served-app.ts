// The production SPA shell mounted in happy-dom against a REAL board: every
// read the shell makes (`fetch` with a path) is answered by a `startServer`
// handle bound to port 0, so what the view draws is what the server stored and
// serves — never a scripted reply shaped to the test.
//
// Real VanJS/VanX vendor bundles, the real public/app-logic.mjs and the real
// public/app.js, as every other run-detail DOM test mounts them. Each read is
// recorded in `servedFetchLog` (the path and query the shell asked for), and
// `settleServedApp` waits for every read in flight to answer before letting
// the render flush: a real server answers over a socket, so the fixed-yield
// `settleDom` alone would race it.
//
// The runtime's own fetch is captured before any happy-dom window is
// registered; seed a board before mounting, and put that fetch back with
// `restoreRealFetch` after each test.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerHandle } from "../../src/server.ts";
import { settleDom } from "./dom-settle";
import { base } from "./run-stream-harness.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

const REAL_FETCH: typeof fetch = globalThis.fetch;

// The board runs in this same process, so it builds its replies with whatever
// `Response` (and friends) the global scope holds. Registering a happy-dom
// window swaps them for happy-dom's own, which Bun's server refuses as a reply
// ("Expected a Response object"). These are put back to the runtime's own
// right after the window registers; the shell reads its replies through the
// proxy below and never constructs one itself.
const SERVER_GLOBALS = [
  "Response",
  "Request",
  "Headers",
  "URL",
  "URLSearchParams",
  "Blob",
  "FormData",
  "ReadableStream",
  "TextEncoder",
  "TextDecoder",
  "crypto",
] as const;
const NATIVE_GLOBALS = new Map<string, unknown>(
  SERVER_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

function keepNativeServerGlobals(): void {
  const scope = globalThis as Record<string, unknown>;
  for (const [name, native] of NATIVE_GLOBALS) {
    if (scope[name] !== native) scope[name] = native;
  }
}

/** Every read the mounted shell made, in order, as the path and query it asked for. */
export const servedFetchLog: string[] = [];

let inFlight = 0;
let cacheBust = 0;

/** The shell's own request, as a path and query on the served board. */
function requestedUrl(input: unknown): string {
  if (typeof input === "string") return input;
  const asUrl = (input as { url?: unknown; href?: unknown }) ?? {};
  if (typeof asUrl.url === "string") return asUrl.url;
  if (typeof asUrl.href === "string") return asUrl.href;
  return String(input);
}

function toServed(origin: string, url: string): string {
  if (url.startsWith("/")) return `${origin}${url}`;
  return url.replace(/^https?:\/\/localhost(?::\d+)?/, origin);
}

/** Put the runtime's own fetch back (happy-dom's window and the shell's proxy both replace it). */
export async function restoreRealFetch(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  globalThis.fetch = REAL_FETCH;
}

/** Mount the production shell at `pathname`, every read answered by `handle`. */
export async function mountServedApp(handle: ServerHandle, pathname: string): Promise<void> {
  await restoreRealFetch();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  keepNativeServerGlobals();
  document.body.innerHTML = '<div id="app"></div>';
  servedFetchLog.length = 0;
  inFlight = 0;
  const origin = base(handle);

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = requestedUrl(input);
    servedFetchLog.push(url.replace(/^https?:\/\/localhost(?::\d+)?/, ""));
    inFlight += 1;
    try {
      const res = await REAL_FETCH(toServed(origin, url), init);
      // The body is read here, inside the in-flight window, so a settle never
      // returns while a reply is still arriving.
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        json: async () => JSON.parse(text) as unknown,
        text: async () => text,
      } as unknown as Response;
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?servedApp=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  await settleServedApp();
}

/** Wait until no read is in flight across several consecutive yields, then flush the render. */
export async function settleServedApp(maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let quiet = 0;
  while (quiet < 4 && Date.now() < deadline) {
    await settleDom({ ticks: 1, stepMs: 5 });
    quiet = inFlight === 0 ? quiet + 1 : 0;
  }
  await settleDom({ ticks: 6 });
}
