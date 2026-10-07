// CR-CRU-158 §S2 — analytics only when they can have changed: a heartbeat-
// only stream frame triggers no analytics (or roadmap) read; a frame
// announcing a merge, plan or queue change does.
//
// Spec: docs/changes/CR-CRU-158-a-runs-detail-stays-responsive-while-agents-run.md
//       §S2 ("Analytics only when they can have changed"); Acceptance
//       criteria ("A heartbeat-only stream frame triggers no analytics
//       read; a frame announcing a merge, plan or queue change does,
//       asserted on the requests made.")
//
// THE FRAME-KIND RULE (derived from `store.ts`'s `emit` call sites, src/
// server.ts's `handleStream`): the stream carries exactly three CHANGE
// kinds — "projects", "agents", "events" — plus the connection's own
// "hello". `touchAgent` (store.ts, heartbeats/registration) emits ONLY
// "agents"; every merge (`deliverRelease`), plan change (`addCycle`,
// cycle skip/rename/close/abort/orchestrator/wave) and queue mutation
// (`declareWave`, reorder, dependency edits, …) emits "events" — there is
// no separate "queue"/"plan"/"merge" kind on the wire, so "events" is the
// ONLY kind that can ever carry one of those changes. The frame vocabulary
// therefore cannot distinguish "a run started" from "a merge/plan/queue
// change" within "events" — this file tests the NARROWEST rule the wire
// format supports: gate analytics/roadmap reads on `frame.type === "events"`,
// which is both necessary (nothing else ever carries the qualifying change)
// and sufficient to stop "agents" heartbeats triggering them.
//
// Current code fact (verified against public/app.js on this branch):
// `connectStream`'s `sse.onmessage` never reads `event.data` at all — EVERY
// message, heartbeat or not, calls `refetch()`, which unconditionally
// awaits `refetchRoadmap` (queue/releases/release-proposals, then
// `refetchAnalytics`: velocity/burndown/forecast).
//
// RED phase — expected to FAIL against current production: a burst of
// "agents"-kind frames (heartbeat-only) each re-fetch every roadmap/
// analytics resource, when none should.
//
// Harness: happy-dom + real public/app.js + public/app-logic.mjs, in the
// style of tests/runs-retention-window.test.ts, with a FAKE EventSource
// (happy-dom has none) installed on `globalThis` before public/app.js
// evaluates, so individual `{type, projectKey}` frames can be dispatched on
// demand — mirrors tests/refresh-single-flight-under-stream-burst.test.ts's
// harness.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

const PROPOSAL = { label: "0.2.0", targetAt: 1790000000, timestamp: 1787000000, waves: ["1"] };

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

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
let fetchLog: string[] = [];

async function mountApp(key: string): Promise<void> {
  liveSource = null;
  fetchLog = [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
  ): Promise<Response> => {
    fetchLog.push(url);
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
    throw new Error(`analytics-reads-gated-to-change-bearing-frames.test.ts: unexpected fetch url ${url}`);
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
  await import(`${APP_LOGIC_PATH}?analyticsFrameGating=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const RESOURCE_PATTERNS: Record<string, RegExp> = {
  velocity: /\/analytics\/velocity/,
  burndown: /\/analytics\/burndown/,
  forecast: /\/analytics\/forecast/,
  queue: /\/queue(?:\?|$)/,
  releases: /\/releases(?:\?|$)/,
  "release-proposals": /\/release-proposals/,
};

function countsByResource(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, pattern] of Object.entries(RESOURCE_PATTERNS)) {
    out[name] = fetchLog.filter((u) => pattern.test(u)).length;
  }
  return out;
}

describe("analytics and roadmap reads gated to change-bearing stream frames", () => {
  test("a heartbeat-only (agents) frame triggers no analytics or roadmap read", async () => {
    const key = "heartbeat-gating";
    await mountApp(key);
    const baseline = countsByResource();
    // The load itself must actually have read each resource once — otherwise
    // "no NEW read" below would vacuously pass against a stub that never
    // fetches these at all.
    for (const [name, count] of Object.entries(baseline)) {
      expect(count, `${name} was not fetched by the initial workspace load`).toBeGreaterThan(0);
    }

    for (let i = 0; i < 4; i++) {
      liveSource!.dispatch("agents", key);
      await settleDom({ ticks: 1 });
    }
    await settle();

    const afterHeartbeats = countsByResource();
    for (const name of Object.keys(RESOURCE_PATTERNS)) {
      expect(afterHeartbeats[name], `${name} re-fetched by a heartbeat-only frame`).toBe(
        baseline[name],
      );
    }
  });

  test("a frame announcing a merge/plan/queue change (events) triggers a fresh analytics and roadmap read", async () => {
    const key = "qualifying-frame-gating";
    await mountApp(key);
    const baseline = countsByResource();

    liveSource!.dispatch("events", key);
    await settle();

    const afterChange = countsByResource();
    for (const name of Object.keys(RESOURCE_PATTERNS)) {
      expect(afterChange[name], `${name} was not re-read after a qualifying "events" frame`).toBe(
        baseline[name] + 1,
      );
    }
  });
});
