// A happy-dom workspace mount with a scriptable stream — the harness the
// page-refresh tests share: real public/app.js + public/app-logic.mjs + the
// VanJS/VanX vendor bundles, a scripted `fetch` that answers every read a
// workspace makes and logs each URL, and a FAKE EventSource (happy-dom has
// none) installed before public/app.js evaluates, so `connectStream` takes
// its stream branch and the test drives `onopen`, `onmessage` and `onerror`
// itself.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./dom-settle";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

const PROPOSAL = { label: "0.2.0", targetAt: 1790000000, timestamp: 1787000000, waves: ["1"] };

/** The stand-in stream: the three handlers `connectStream` wires, plus
 *  helpers that fire them the way a browser's EventSource would. */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** The connection opens (first open, or a reconnect after an error). */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  /** The connection drops and the browser is retrying it itself. */
  dropAndRetry(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }
  /** A `data: {"type":…,"projectKey":…}` frame, as the server's stream sends. */
  dispatch(kind: string, projectKey: string): void {
    this.onmessage?.({ data: JSON.stringify({ type: kind, projectKey }) });
  }
  /** A frame whose data is not a typed JSON frame. */
  dispatchRaw(data: string): void {
    this.onmessage?.({ data });
  }
}

// What `globalThis.EventSource` was before a fake replaced it, so the fake can
// be taken away again. `bun test` runs every file in ONE process, and
// `GlobalRegistrator.unregister()` restores only the globals happy-dom set.
// happy-dom has no EventSource, so a fake left behind makes every later
// mount take the stream branch on a source that never errors: that page never
// polls, and a change only the poll can deliver never lands.
let replacedEventSource: { present: boolean; value: unknown } | null = null;

/** Install a fake as `globalThis.EventSource`, remembering what it replaced
 *  (on the first install only, so a re-mount never remembers a fake). Pair
 *  with `restoreEventSource()` after each test. */
export function installEventSource(fake: unknown): void {
  const g = globalThis as { EventSource?: unknown };
  if (replacedEventSource === null) {
    replacedEventSource = { present: "EventSource" in g, value: g.EventSource };
  }
  g.EventSource = fake;
}

/** Put back whatever `installEventSource` replaced; a no-op when nothing was
 *  installed. */
export function restoreEventSource(): void {
  if (replacedEventSource === null) return;
  const g = globalThis as { EventSource?: unknown };
  if (replacedEventSource.present) g.EventSource = replacedEventSource.value;
  else delete g.EventSource;
  replacedEventSource = null;
}

export interface Mounted {
  /** Every URL the page fetched, in order. */
  readonly fetchLog: string[];
  /** The page's one live stream. */
  source(): FakeEventSource;
}

let cacheBust = 0;

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/**
 * Mounts the workspace of `keys[0]` (every key in `keys` is a known project).
 * Resolves once public/app.js has evaluated — the boot refresh is then IN
 * FLIGHT and the stream constructed but not yet open; call `settle()` to let
 * the boot refresh finish.
 */
export async function mountWorkspace(keys: string[]): Promise<Mounted> {
  const fetchLog: string[] = [];
  let live: FakeEventSource | null = null;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${keys[0]}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string): Promise<Response> => {
    fetchLog.push(url);
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      return okResponse({ ok: true, proposals: [PROPOSAL], totalCount: 1 });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) return okResponse({ ok: true, releases: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) return okResponse({ ok: true, entries: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) return okResponse({ ok: true, plans: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/analytics\/velocity/.test(url)) {
      return okResponse({ release: PROPOSAL.label, days: [], sampleDays: 0, flow: { sampleCycles: 0 } });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/analytics\/burndown/.test(url)) {
      return okResponse({ release: PROPOSAL.label, committedPoints: 0, points: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/analytics\/forecast/.test(url)) {
      return okResponse({ release: PROPOSAL.label, status: "on-track" });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    if (url === "/api/v2/projects") {
      return okResponse({
        ok: true,
        projects: keys.map((key) => ({
          key,
          name: key,
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: Date.now(),
          retention: 5000,
        })),
      });
    }
    throw new Error(`stream-workspace-harness: unexpected fetch url ${url}`);
  }) as typeof fetch;

  installEventSource(
    class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        live = this;
      }
    },
  );

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?streamWorkspaceHarness=${cacheBust}`);
  (0, eval)(APP_JS_SRC);

  return {
    fetchLog,
    source: () => {
      if (live === null) throw new Error("stream-workspace-harness: the page opened no stream");
      return live;
    },
  };
}

export async function settle(ticks = 10): Promise<void> {
  await settleDom({ ticks });
}

export async function unmount(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  restoreEventSource();
}

/** Every resource a workspace reads, by the URL shape that reads it. */
export const RESOURCES: Record<string, (url: string) => boolean> = {
  projects: (u) => u === "/api/v2/projects",
  agents: (u) => u.startsWith("/api/v2/agents"),
  health: (u) => u.startsWith("/api/v2/health"),
  // The plain list read — not the by-release read, which shares its route.
  "events list": (u) => u.startsWith("/api/v2/events?") && !/[?&]release=/.test(u),
  // The focused release's verified-runs count, read with the analytics.
  "verified runs": (u) => u.startsWith("/api/v2/events?") && /[?&]release=/.test(u),
  plans: (u) => /\/plans(?:\?|$)/.test(u),
  queue: (u) => /\/queue(?:\?|$)/.test(u),
  releases: (u) => /\/releases(?:\?|$)/.test(u),
  "release-proposals": (u) => /\/release-proposals/.test(u),
  velocity: (u) => /\/analytics\/velocity/.test(u),
  burndown: (u) => /\/analytics\/burndown/.test(u),
  forecast: (u) => /\/analytics\/forecast/.test(u),
};

/** The roadmap and analytics resources a workspace load reads once. */
export const ROADMAP_RESOURCES = [
  "velocity",
  "burndown",
  "forecast",
  "verified runs",
  "releases",
  "queue",
  "release-proposals",
];

/** How many times each resource was read in `urls`. */
export function countReads(urls: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, matches] of Object.entries(RESOURCES)) out[name] = urls.filter(matches).length;
  return out;
}
