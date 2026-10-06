// CR-CRU-158 §S2 — single-flight refresh: however many stream frames arrive
// while a refresh is in flight, the page runs at most one more refresh after
// it (never a pile-up).
//
// Spec: docs/changes/CR-CRU-158-a-runs-detail-stays-responsive-while-agents-run.md
//       §S2 ("Single-flight refresh"); Acceptance criteria ("However many
//       stream frames arrive while a refresh is in flight, a page runs at
//       most one more refresh after it, asserted on the requests made.")
//
// Current code fact (verified against public/app.js on this branch):
// `connectStream`'s `sse.onmessage` calls `refetch()` UNCONDITIONALLY on
// EVERY message (it never even reads `event.data`), and `refetch()` is not
// guarded against re-entry — nothing stops a second, third, … `refetch()`
// from starting while an earlier one is still awaiting its own `fetch`
// calls. `refetchCore` — the first slice `refetch` awaits — begins with
// `const projects = await getJson("/api/v2/projects")`, so every refresh
// cycle issues exactly one GET to that literal URL; this file gates that
// one call to hold a refresh "in flight" and counts attempts against it as
// the proxy for "how many refreshes ran".
//
// RED phase — expected to FAIL against current production: a burst of
// frames arriving while one refresh is already held in flight fires one
// further overlapping `refetch()` PER FRAME (6 total hits on
// `/api/v2/projects` for the in-flight one plus a 5-frame burst), not
// "at most one more".
//
// Harness: happy-dom + real public/app.js + public/app-logic.mjs, in the
// style of tests/runs-retention-window.test.ts. happy-dom has no
// EventSource (`typeof EventSource === "undefined"`), so a FAKE one is
// installed on `globalThis` BEFORE public/app.js evaluates — this makes
// `connectStream` (public/app.js) take its SSE branch instead of falling
// back to `startPolling`, so individual stream frames can be dispatched on
// demand. `tests/helpers/fetch-gate.ts`'s `gateFetch` holds a refresh's
// first request open — the "a refresh is in flight" window the AC names.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { gateFetch } from "./helpers/fetch-gate";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

/** The one proposed release, present so `refetchAnalytics`'s burndown/forecast
 *  calls (public/app.js) have a focused release to query — `releaseStripFocusIndex`
 *  (public/app-logic.mjs) auto-focuses the lone proposed gate when nothing
 *  shipped and the user picked none. */
const PROPOSAL = { label: "0.2.0", targetAt: 1790000000, timestamp: 1787000000, waves: ["1"] };

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** A minimal stand-in for the browser's EventSource: just the three handlers
 *  `connectStream` (public/app.js) wires, and a `dispatch` helper that fires
 *  `onmessage` the way the server's `data: {"type":…,"projectKey":…}` line
 *  would (`handleStream` in src/server.ts). */
class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
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
  dispatch(kind: string, projectKey: string): void {
    this.onmessage?.({ data: JSON.stringify({ type: kind, projectKey }) });
  }
}

let cacheBust = 0;
let liveSource: FakeEventSource | null = null;

async function mountApp(key: string): Promise<void> {
  liveSource = null;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
  ): Promise<Response> => {
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      return okResponse({ ok: true, proposals: [PROPOSAL], totalCount: 1 });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({ ok: true, plans: [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/analytics\/velocity/.test(url)) {
      return okResponse({ weeks: [], sampleWeeks: 0 });
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
        projects: [
          {
            key,
            name: key,
            type: "backend",
            agentsOnline: 0,
            agentsTotal: 0,
            active: true,
            lastActivity: Date.now(),
          },
        ],
      });
    }
    throw new Error(`refresh-single-flight-under-stream-burst.test.ts: unexpected fetch url ${url}`);
  }) as typeof fetch;

  (globalThis as unknown as { EventSource: unknown }).EventSource = class extends FakeEventSource {
    constructor(url: string) {
      super(url);
      liveSource = this;
    }
  };

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?refreshSingleFlight=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

describe("single-flight refresh under a stream-frame burst", () => {
  test("a burst of frames arriving while a refresh is in flight runs at most one more refresh after it", async () => {
    const key = "single-flight-burst";
    await mountApp(key);
    expect(liveSource).not.toBeNull(); // sanity — connectStream took the SSE branch, not startPolling

    // Gates the ONE request `refetchCore` (public/app.js) always makes
    // first — a hit here is a refresh cycle STARTING.
    const gate = gateFetch((url) => url === "/api/v2/projects");
    try {
      // Frame 1 starts a refresh; its first request is held, so this refresh
      // is now "in flight" for the rest of the test.
      liveSource!.dispatch("events", key);
      await settleDom({ ticks: 2 });
      expect(gate.fired).toBe(1);
      expect(gate.held.length).toBe(1);

      // The burst — 5 MORE frames arrive while that refresh is still in
      // flight, each of which (G3's measured lock) would independently fire
      // another full refetch() in current production.
      for (let i = 0; i < 5; i++) {
        liveSource!.dispatch("events", key);
        await settleDom({ ticks: 1 });
      }

      // Let the in-flight refresh's held request complete, then let a
      // (correctly-implemented) coalesced trailing refresh's own request
      // through too.
      gate.resolveAll();
      await settle();
      gate.resolveAll();
      await settle();

      // §S2 — "however many stream frames arrive while a refresh is in
      // flight, a page runs at most one more refresh after it": the
      // already-in-flight refresh plus exactly one coalesced trailing
      // refresh, never one refresh per frame.
      expect(gate.fired).toBe(2);
    } finally {
      gate.restore();
    }
  });
});
