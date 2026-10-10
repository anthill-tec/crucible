// CR-CRU-158 §S3 — a page load reads each resource once: one workspace load
// issues each of `velocity`, `burndown`, `forecast`, `releases`, `queue` and
// `release-proposals` once.
//
// Spec: docs/changes/CR-CRU-158-a-runs-detail-stays-responsive-while-agents-run.md
//       §S3 ("a page load reads each resource once"); Gap analysis G5 ("§S3's
//       duplicate reads are the same defect seen at rest… for the same
//       reason: overlapping refreshes"); Acceptance criteria ("One workspace
//       load issues each of velocity, burndown, forecast, releases, queue
//       and release-proposals once.")
//
// WHY A HEARTBEAT BURST IS THE RIGHT "ONE LOAD" PROBE (not a race against
// an in-flight refresh — that is C1's single-flight AC, which only
// guarantees "AT MOST one more" on top of whatever is already running, i.e.
// up to two reads, not one). A real workspace load is never perfectly
// quiet: `connectStream` (public/app.js) opens its stream at boot, and
// G3/the Problem section measured the board emitting frames "every few
// seconds (narration heartbeats, the open run, ingests)" through any such
// window. Per this cycle's analytics/roadmap-gating fix (see
// tests/analytics-reads-gated-to-change-bearing-frames.test.ts and this
// spec's §S2), a heartbeat ("agents"-kind) frame can NEVER qualify to
// trigger a roadmap/analytics read — so a load plus any number of
// heartbeats arriving around it is the one scenario where "once" (not
// "at most twice") is the correct, achievable outcome: the load's own
// single read, and ZERO more from the heartbeat noise.
//
// Current code fact (verified against public/app.js on this branch):
// `connectStream`'s `sse.onmessage` never reads `event.data` — EVERY
// message, heartbeat included, calls `refetch()`, which unconditionally
// re-reads `releases`/`queue`/`release-proposals`/`velocity`/`burndown`/
// `forecast` via `refetchRoadmap` → `refetchAnalytics`.
//
// RED phase — expected to FAIL against current production: a handful of
// heartbeat frames arriving after the load re-fetch every one of the six
// resources again, so each is read more than once.
//
// Harness: happy-dom + real public/app.js + public/app-logic.mjs, in the
// style of tests/runs-retention-window.test.ts, with a FAKE EventSource
// (happy-dom has none) — mirrors
// tests/refresh-single-flight-under-stream-burst.test.ts's harness.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { installEventSource, restoreEventSource } from "./helpers/stream-workspace-harness";

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
    throw new Error(`workspace-load-reads-roadmap-resources-once.test.ts: unexpected fetch url ${url}`);
  }) as typeof fetch;

  installEventSource(
    class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        liveSource = this;
      }
    },
  );

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workspaceLoadOnce=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  restoreEventSource();
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

describe("one workspace load reads each roadmap/analytics resource once", () => {
  test("velocity, burndown, forecast, releases, queue and release-proposals are each fetched exactly once across a load plus ambient heartbeat noise", async () => {
    const key = "once-per-load";
    await mountApp(key);

    // Ambient heartbeat noise around the load — G3's measured "every few
    // seconds" cadence, none of which announces a merge/plan/queue change.
    for (let i = 0; i < 6; i++) {
      liveSource!.dispatch("agents", key);
      await settleDom({ ticks: 1 });
    }
    await settle();

    const counts = countsByResource();
    for (const [name, count] of Object.entries(counts)) {
      expect(count, `${name} was fetched ${count} times for one workspace load (expected exactly once)`).toBe(
        1,
      );
    }
  });
});
