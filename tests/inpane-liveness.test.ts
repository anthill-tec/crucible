// CR-CRU-016 C3 — SSE liveness beside the open in-pane detail (final AC of
// the CR's Acceptance criteria list, verbatim):
//   "SSE liveness: with the detail open, a new run ingested for the project
//   updates the Project pane's agent row (visible beside the detail) without
//   closing the detail."
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/inpane-drill-in.test.ts / tests/shell-final-
// form.test.ts: real VanJS/VanX vendor bundles, real public/app-logic.mjs,
// real public/app.js; `fetch` is scripted.
//
// SSE simulation technique: confirmed (tests/shell-final-form.test.ts:707-
// 714, re-verified live against this harness) that `typeof EventSource` is
// `undefined` under happy-dom, so `connectStream()` (public/app.js:125-149)
// always falls back to `startPolling()` (public/app.js:151-154), a plain
// `setInterval(refetch, 5000)`. Both the real SSE `onmessage` handler and
// the poll fallback call the IDENTICAL `refetch()` (public/app.js:96-113),
// which re-fetches /api/v2/projects, /api/v2/agents, /api/v2/events and
// replaces state via `vanX.replace`. This file drives that shared refetch
// path — the only one reachable in this DOM-less-EventSource harness — by
// mutating the SAME fixture object the mocked `fetch` reads live (`opts.*`)
// and waiting past a real 5s poll tick, exactly as tests/shell-final-
// form.test.ts's AC7 down-state test already waits real wall-clock time
// (26s under a 35s test timeout) for its own timer-driven assertion.
//
// Honesty note (per dispatch): CR-CRU-016 C1/C2 already landed surface-keyed
// bindings (public/app.js:1567-1595 `surfaceKeyOf`/chromeKey/surfaceKey
// memoization + the `paneSwap` closure at :574-598 which only calls
// `RunDetail(state.route.overlay)` when the reactive scope watching
// `state.route.overlay` re-runs). Because the agents/projects/events state
// lives in DIFFERENT reactive scopes than the pane-swap branch that holds
// the open detail, these tests may already PASS against current
// production — that is reported honestly per test, not forced RED.
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

// The real poll interval is a hard-coded 5000ms (public/app.js:153). Wait
// comfortably past it before asserting on a poll-driven update.
const POLL_INTERVAL_MS = 5000;
const POLL_WAIT_MS = POLL_INTERVAL_MS + 700;
const POLL_TEST_TIMEOUT_MS = 15_000;

interface FailureFixture {
  message?: string;
}
interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: FailureFixture;
}
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
}
interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree?: SuiteFixture[];
}
interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
}
interface AgentFixture {
  agentId: string;
  projectKey: string;
  status?: "online" | "busy";
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
  message?: string;
  identity?: { displayName?: string };
}
interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

/** CR-CRU-017 §S3's open-run brief, as the events feed serves it beside
 *  `events` in ONE response — the slice CR-CRU-123 §S1 joins against
 *  `state.agents` on `agentId`. Shape read off `RunningCard`/`runningRunsFor`
 *  in public/app.js (runId, projectKey, agentId, startedAt, optional tier and
 *  `context.cycleId`), not invented here. */
interface OpenRunFixture {
  runId: string;
  projectKey: string;
  agentId: string;
  startedAt: number;
  tier?: string;
  context?: { cycleId?: number };
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  agents: AgentFixture[];
  events: EventBriefFixture[];
  eventDetails: Record<string, EventDetailFixture>;
  /** Served on the events response, where production reads it
   *  (`vanX.replace(state.openRuns, () => events.openRuns ?? [])`). Omitted =
   *  `[]`, which is what a server without the field degrades to, so every
   *  pre-existing test in this file is unaffected. */
  openRuns?: OpenRunFixture[];
}

let cacheBust = 0;

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/**
 * Same mountApp harness pattern as tests/inpane-drill-in.test.ts (event
 * detail depth=suites/suite= progressive fetch) merged with tests/shell-
 * final-form.test.ts's live `agents` fixture support. Crucially, every
 * fetch reads `opts.*` LIVE (property access at call time, not a snapshot),
 * so a test can mutate `opts.agents`/`opts.events` IN PLACE after mount and
 * the next poll tick's refetch will observe the mutation — this is the
 * "SSE-simulated" liveness update.
 */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails[id];
      if (detail === undefined) {
        throw new Error(`inpane-liveness.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = (detail.tree ?? []).find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = (detail.tree ?? []).map((n) => ({
          name: n.name,
          status: n.status,
          counts: suiteCounts(n.children),
        }));
        body = { ok: true, event: { ...detail, tree } };
      } else {
        body = { ok: true, event: detail };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: opts.agents };
    } else if (url.includes("/api/v2/events")) {
      // CR-CRU-017 §S3 — ONE response carries the settled events AND the open
      // runs, so a fixture can move a run across the boundary in a single
      // tick exactly as the server does (CR-CRU-123 §S1/AC4).
      body = { ok: true, events: opts.events, openRuns: opts.openRuns ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`inpane-liveness.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?inpaneLiveness=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

/** Waits past one real poll tick (POLL_INTERVAL_MS), then settles VanJS. */
async function waitForPollTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS));
  await settle();
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLElement | undefined;
}

function unitFixture(eventId: string, projectKey: string, agentId: string, now: number) {
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId,
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 500 },
    tree: [
      {
        name: "SuiteOnly",
        status: "fail",
        children: [
          { name: "passLeaf", status: "pass", duration_ms: 5 },
          { name: "failLeaf", status: "fail", duration_ms: 6, failure: { message: "expected true to be false" } },
        ],
      },
    ],
  };
  const brief: EventBriefFixture = {
    id: eventId,
    projectKey,
    agentId,
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    total: 2,
    passed: 1,
    failed: 1,
    pending: 0,
    duration_ms: 500,
    hasCoverage: false,
  };
  return { detail, brief };
}

// Two-suite fixture (both start collapsed — CR-CRU-038 §S1 minimized
// default — and are expanded manually in the test) for the negative-bound
// §S2-internal-state test.
function twoSuiteFixture(eventId: string, projectKey: string, agentId: string, now: number) {
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId,
    kind: "test",
    tier: "module",
    codec: "junit",
    timestamp: now,
    summary: { total: 4, passed: 3, failed: 1, pending: 0, duration_ms: 700 },
    tree: [
      {
        name: "SuiteFail",
        status: "fail",
        children: [
          { name: "aPass", status: "pass", duration_ms: 5 },
          { name: "aFail", status: "fail", duration_ms: 6, failure: { message: "A failed" } },
        ],
      },
      {
        name: "SuitePass",
        status: "pass",
        children: [
          { name: "bPass1", status: "pass", duration_ms: 5 },
          { name: "bPass2", status: "pass", duration_ms: 5 },
        ],
      },
    ],
  };
  const brief: EventBriefFixture = {
    id: eventId,
    projectKey,
    agentId,
    kind: "test",
    tier: "module",
    codec: "junit",
    timestamp: now,
    total: 4,
    passed: 3,
    failed: 1,
    pending: 0,
    duration_ms: 700,
    hasCoverage: false,
  };
  return { detail, brief };
}

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 1,
    agentsTotal: 1,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentFixture> & { agentId: string; projectKey: string }): AgentFixture {
  return {
    liveness: "online",
    lastSeen: Date.now(),
    message: "idle",
    ...overrides,
  };
}

// ── AC — SSE liveness beside the open detail (verbatim CR-CRU-016 AC) ─────

describe("SSE liveness — with the detail open, a new run ingested for the project updates the Project pane's agent row without closing the detail", () => {
  test(
    "a poll-tick refetch (the only reachable liveness channel — EventSource is undefined here, onmessage and the poll fallback share the identical refetch()) surfaces the ingesting agent's row in the Project pane while the SAME run-overlay DOM node stays mounted and the route is unchanged",
    async () => {
      const now = Date.now();
      const eventId = "evt-live-ws-1";
      const projectKey = "proj-live-ws-1";
      const existingAgentId = "existing-agent";
      const fx = unitFixture(eventId, projectKey, existingAgentId, now);

      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Live WS Project", agentsTotal: 1 })],
        agents: [agent({ agentId: existingAgentId, projectKey, message: "idle" })],
        events: [fx.brief],
        eventDetails: { [eventId]: fx.detail },
      };
      await mountApp(opts);

      // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
      // defaults to the Workflow pane, not Runs (workspace default flips) —
      // this test's SUBJECT is SSE liveness behind the workspace Runs pane,
      // so it now selects the Runs tab EXPLICITLY after mount instead of
      // relying on Runs being the cold-load default. Was: no tab click,
      // relied on cold load already showing the Runs pane's event-card.
      const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
      expect(runsTab).toBeDefined();
      runsTab!.click();
      await settle();

      const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
      expect(card).not.toBeNull();
      card!.click();
      await settle();

      expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);

      // Marker-attribute technique (same as C1's AC1 no-remount check): the
      // in-pane detail container `[data-testid="run-overlay"]` (public/
      // app.js:1531) is the same DOM node that must survive the update.
      const overlayBefore = document.querySelector('[data-testid="run-overlay"]') as HTMLElement | null;
      expect(overlayBefore).not.toBeNull();
      overlayBefore!.setAttribute("data-red-marker", "still-open-during-sse");

      // Baseline: the ingesting agent's row does not exist yet.
      const projectPane = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      expect(projectPane).not.toBeNull();
      expect(findByText(projectPane, '[data-testid="agent-row"]', "ingesting-agent")).toBeUndefined();

      // "a new run ingested for the project" — mutate the SAME fixture
      // object the mocked fetch reads live: a new agent row appears (the
      // agent that just ingested the new run) with a distinct message.
      opts.agents.push(
        agent({
          agentId: "ingesting-agent",
          projectKey,
          message: "just ingested evt-live-ws-2",
          liveness: "online",
        }),
      );

      await waitForPollTick();

      // Route + overlay node identity unchanged — the detail never closed.
      expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
      const overlayAfter = document.querySelector('[data-testid="run-overlay"]') as HTMLElement | null;
      expect(overlayAfter).not.toBeNull();
      expect(overlayAfter).toBe(overlayBefore);
      expect(overlayAfter!.getAttribute("data-red-marker")).toBe("still-open-during-sse");

      // Project pane's agent row for the ingesting agent appears, visible
      // beside the still-open detail.
      const projectPaneAfter = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      expect(projectPaneAfter).not.toBeNull();
      const newRow = findByText(projectPaneAfter, '[data-testid="agent-row"]', "ingesting-agent");
      expect(newRow).toBeDefined();
      expect(newRow!.textContent ?? "").toContain("just ingested evt-live-ws-2");

      // Bound: the existing agent's row is still present too (a real
      // liveness refresh, not a swap that dropped prior agents).
      expect(findByText(projectPaneAfter, '[data-testid="agent-row"]', existingAgentId)).toBeDefined();
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "an existing agent's row updates its message/liveness glyph in place across the poll-tick refetch, with the detail still open",
    async () => {
      const now = Date.now();
      const eventId = "evt-live-ws-glyph-1";
      const projectKey = "proj-live-ws-glyph-1";
      const agentId = "glyph-agent";
      const fx = unitFixture(eventId, projectKey, agentId, now);

      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Glyph Project" })],
        agents: [agent({ agentId, projectKey, message: "booting", liveness: "stale" })],
        events: [fx.brief],
        eventDetails: { [eventId]: fx.detail },
      };
      await mountApp(opts);

      // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
      // defaults to the Workflow pane, not Runs (workspace default flips) —
      // this test's SUBJECT is glyph-update behind the workspace Runs pane,
      // so it now selects the Runs tab EXPLICITLY after mount instead of
      // relying on Runs being the cold-load default. Was: no tab click,
      // relied on cold load already showing the Runs pane's event-card.
      const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
      expect(runsTab).toBeDefined();
      runsTab!.click();
      await settle();

      const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
      card.click();
      await settle();
      expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);

      const projectPaneBefore = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      const rowBefore = findByText(projectPaneBefore, '[data-testid="agent-row"]', agentId);
      expect(rowBefore).toBeDefined();
      expect(rowBefore!.textContent ?? "").toContain("booting");
      const dotBefore = rowBefore!.querySelector(".app-dot");
      expect(dotBefore).not.toBeNull();
      expect(dotBefore!.className).toContain(" y"); // stale glyph class

      // "a new run ingested for the project" — the SAME agent's row updates
      // in place (new message, liveness flips online) rather than a new
      // agent appearing.
      const target = opts.agents.find((a) => a.agentId === agentId)!;
      target.message = "running evt-live-ws-glyph-2";
      target.liveness = "online";

      await waitForPollTick();

      expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
      const overlay = document.querySelector('[data-testid="run-overlay"]');
      expect(overlay).not.toBeNull();

      const projectPaneAfter = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      const rowAfter = findByText(projectPaneAfter, '[data-testid="agent-row"]', agentId);
      expect(rowAfter).toBeDefined();
      expect(rowAfter!.textContent ?? "").toContain("running evt-live-ws-glyph-2");
      expect(rowAfter!.textContent ?? "").not.toContain("booting");
      const dotAfter = rowAfter!.querySelector(".app-dot");
      expect(dotAfter).not.toBeNull();
      expect(dotAfter!.className).toContain(" g"); // online glyph class
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── Feed absorbs the new event while backgrounded behind the open detail ──

describe("the feed behind the open detail also absorbs the new run — closing the detail (Escape) shows the new run's card without a manual reload", () => {
  test(
    "a run ingested while the detail is open is present in the workspace Runs feed immediately after Escape closes the detail, with no re-mount / manual refetch call",
    async () => {
      const now = Date.now();
      const eventId = "evt-feed-ws-1";
      const projectKey = "proj-feed-ws-1";
      const fx = unitFixture(eventId, projectKey, "feed-agent-1", now);
      const newEventId = "evt-feed-ws-2";

      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Feed WS Project" })],
        agents: [agent({ agentId: "feed-agent-1", projectKey })],
        events: [fx.brief],
        eventDetails: { [eventId]: fx.detail },
      };
      await mountApp(opts);

      // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
      // defaults to the Workflow pane, not Runs (workspace default flips) —
      // this test's SUBJECT is the workspace Runs feed's absorb-behind-open-
      // detail behavior, so it now selects the Runs tab EXPLICITLY after
      // mount instead of relying on Runs being the cold-load default. Was:
      // no tab click, relied on cold load already showing the Runs pane's
      // event-card.
      const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
      expect(runsTab).toBeDefined();
      runsTab!.click();
      await settle();

      const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
      card.click();
      await settle();
      expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);

      // Precondition: the feed is not currently rendering any event-card
      // (the pane is showing the detail, not the feed).
      const runsPaneOpen = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
      expect(runsPaneOpen.querySelector('[data-testid="event-card"]')).toBeNull();

      // "a new run ingested for the project" — a second run's brief appears
      // in the events list (the ingest is a real backend event; the feed
      // just hasn't been asked to render it yet because the detail is
      // showing).
      const newFx = unitFixture(newEventId, projectKey, "feed-agent-2", now + 1000);
      opts.events.push(newFx.brief);
      opts.eventDetails[newEventId] = newFx.detail;

      await waitForPollTick();

      // Still open — the poll-driven refetch must not have closed the
      // detail as a side effect.
      expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);

      // Escape closes the detail back to the feed.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await settle();

      expect(location.pathname).toBe(`/p/${projectKey}`);
      const runsPaneClosed = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
      expect(runsPaneClosed).not.toBeNull();

      // The new run's card is present WITHOUT any manual reload — no
      // further mountApp/fetch call happens between the poll tick above and
      // this assertion, only the Escape close.
      const newCard = findByText(runsPaneClosed, '[data-testid="event-card"]', "feed-agent-2");
      expect(newCard).toBeDefined();
      // Bound: the original run's card is also still present (a real merge,
      // not a replace that dropped the previously-open run).
      expect(findByText(runsPaneClosed, '[data-testid="event-card"]', "feed-agent-1")).toBeDefined();
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── Negative bound: the SSE/poll update must NOT reset the detail's own
// internal state (an expanded failing/passing suite must stay expanded) ──

describe("negative bound — the SSE-driven poll refetch does not reset the open detail's own internal expand/collapse state", () => {
  // CR-CRU-038 §S1 RETARGET (2026-07-22): was "a suite the user manually
  // expanded (not auto-expanded — an all-passing suite) stays expanded" —
  // auto-expand-on-open is retired, so BOTH SuiteFail and SuitePass now
  // start collapsed; the test manually expands BOTH (not just the
  // all-pass one) to keep exercising the same "manual expand survives an
  // unrelated poll-tick refetch" contract.
  test(
    "suites the user manually expands (both start collapsed now — neither auto-expands) stay expanded across a poll-tick refetch triggered while the detail is open",
    async () => {
      const now = Date.now();
      const eventId = "evt-focus-persist-1";
      const projectKey = "proj-focus-persist-1";
      const fx = twoSuiteFixture(eventId, projectKey, "persist-agent", now);

      const opts: MountOpts = {
        pathname: `/p/${projectKey}/run/${eventId}`,
        projects: [project({ key: projectKey, name: "Persist Project" })],
        agents: [agent({ agentId: "persist-agent", projectKey })],
        events: [fx.brief],
        eventDetails: { [eventId]: fx.detail },
      };
      await mountApp(opts);

      const pane = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
      expect(pane).not.toBeNull();

      const suiteRows = Array.from(pane.querySelectorAll<HTMLElement>('[data-testid="suite-row"]'));
      expect(suiteRows.length).toBe(2);
      const suiteFailRow = suiteRows.find((r) => (r.textContent ?? "").includes("SuiteFail"))!;
      const suitePassRow = suiteRows.find((r) => (r.textContent ?? "").includes("SuitePass"))!;
      expect(suiteFailRow).toBeDefined();
      expect(suitePassRow).toBeDefined();

      // CR-CRU-038 §S1 — precondition: BOTH suites start collapsed (▸);
      // neither auto-expands on open, error run or not (public/app.js no
      // longer auto-fetches any suite from `?depth=suites`'s response).
      expect(suiteFailRow.querySelector('[data-testid="tree-toggle"]')!.textContent).toBe("▸");
      expect(suitePassRow.querySelector('[data-testid="tree-toggle"]')!.textContent).toBe("▸");
      expect(pane.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);

      // User manually expands BOTH suites.
      suiteFailRow.click();
      await settle();
      const suiteFailRowAfterClick = Array.from(pane.querySelectorAll('[data-testid="suite-row"]')).find((r) =>
        (r.textContent ?? "").includes("SuiteFail"),
      )!;
      expect(suiteFailRowAfterClick.querySelector('[data-testid="tree-toggle"]')!.textContent).toBe("▾");
      expect(pane.querySelectorAll('[data-testid="leaf-row"]').length).toBe(2); // only SuiteFail's 2 leaves

      const suitePassRowToClick = Array.from(pane.querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).find(
        (r) => (r.textContent ?? "").includes("SuitePass"),
      )!;
      suitePassRowToClick.click();
      await settle();

      const suitePassRowAfterClick = Array.from(pane.querySelectorAll('[data-testid="suite-row"]')).find((r) =>
        (r.textContent ?? "").includes("SuitePass"),
      )!;
      expect(suitePassRowAfterClick.querySelector('[data-testid="tree-toggle"]')!.textContent).toBe("▾");
      expect(pane.querySelectorAll('[data-testid="leaf-row"]').length).toBe(4); // both suites' leaves now

      // "a new run ingested for the project" — an unrelated agent-liveness
      // update arrives via the poll-tick refetch while the detail stays
      // open; this must not reset RunDetail's own suiteLeaves/openGroups
      // state (a naive implementation that re-creates RunDetail on every
      // state change would collapse SuitePass back to folded here).
      opts.agents.push(
        agent({ agentId: "unrelated-new-agent", projectKey, message: "unrelated ingest" }),
      );

      await waitForPollTick();

      expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
      const paneAfter = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
      expect(paneAfter).not.toBeNull();

      const rowsAfter = Array.from(paneAfter.querySelectorAll('[data-testid="suite-row"]'));
      expect(rowsAfter.length).toBe(2);
      const suiteFailRowAfter = rowsAfter.find((r) => (r.textContent ?? "").includes("SuiteFail"))!;
      const suitePassRowAfter = rowsAfter.find((r) => (r.textContent ?? "").includes("SuitePass"))!;

      // Both suites are STILL expanded — the manual toggle survived.
      expect(suiteFailRowAfter.querySelector('[data-testid="tree-toggle"]')!.textContent).toBe("▾");
      expect(suitePassRowAfter.querySelector('[data-testid="tree-toggle"]')!.textContent).toBe("▾");
      expect(paneAfter.querySelectorAll('[data-testid="leaf-row"]').length).toBe(4);
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── CR-CRU-037 §S1 characterization — per-agent dim rule is ALREADY correct ──
// The per-agent dim rule (store.livenessOf on that agent's OWN lastSeen
// silence, independent of siblings) is locked here as a regression guard —
// these are expected to PASS against CURRENT production. Only the
// agentsOnline COUNT (tests/v2-core.test.ts) is the in-scope defect for this
// CR; if any of the following unexpectedly fails, that is a real bug, not
// something to paper over.
describe("CR-CRU-037 §S1 characterization — per-agent liveness dimming has no sibling coupling", () => {
  test("two concurrently-registered alive agents (one online, one stale) BOTH render highlighted — neither gets the 'tombstoned' dim treatment", async () => {
    const projectKey = "proj-s1-both-alive";
    const opts: MountOpts = {
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Both Alive Project", agentsOnline: 2, agentsTotal: 2 })],
      agents: [
        agent({ agentId: "online-agent", projectKey, liveness: "online", message: "busy" }),
        agent({ agentId: "stale-agent", projectKey, liveness: "stale", message: "quiet" }),
      ],
      events: [],
      eventDetails: {},
    };
    await mountApp(opts);

    const pane = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
    expect(pane).not.toBeNull();

    const onlineRow = findByText(pane, '[data-testid="agent-row"]', "online-agent");
    const staleRow = findByText(pane, '[data-testid="agent-row"]', "stale-agent");
    expect(onlineRow).toBeDefined();
    expect(staleRow).toBeDefined();

    expect(onlineRow!.className).not.toContain("tombstoned");
    expect(staleRow!.className).not.toContain("tombstoned");

    const onlineDot = onlineRow!.querySelector(".app-dot");
    expect(onlineDot).not.toBeNull();
    expect(onlineDot!.className).toContain(" g");

    const staleDot = staleRow!.querySelector(".app-dot");
    expect(staleDot).not.toBeNull();
    expect(staleDot!.className).toContain(" y");
  });

  test("a registered agent that has reported zero runs (no runtime_ms) but is alive still renders highlighted, not dimmed", async () => {
    const projectKey = "proj-s1-zero-runs";
    const opts: MountOpts = {
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Zero Runs Project", agentsOnline: 1, agentsTotal: 1 })],
      agents: [
        agent({ agentId: "fresh-agent", projectKey, liveness: "online", message: "idle" }),
      ],
      events: [],
      eventDetails: {},
    };
    await mountApp(opts);

    const pane = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
    expect(pane).not.toBeNull();
    const row = findByText(pane, '[data-testid="agent-row"]', "fresh-agent");
    expect(row).toBeDefined();
    expect(row!.className).not.toContain("tombstoned");
    const dot = row!.querySelector(".app-dot");
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain(" g");
  });

  test("only a tombstoned agent gets the dim/tombstoned treatment — that entry ONLY; a concurrently-alive sibling is unaffected (no sibling coupling)", async () => {
    const projectKey = "proj-s1-mixed-tomb";
    const now = Date.now();
    const opts: MountOpts = {
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Mixed Tombstone Project", agentsOnline: 1, agentsTotal: 2 })],
      agents: [
        agent({
          agentId: "dead-agent",
          projectKey,
          liveness: "tombstoned",
          lastSeen: now - 7_200_000,
          message: "died mid-run",
        }),
        agent({ agentId: "alive-sibling", projectKey, liveness: "online", message: "still going" }),
      ],
      events: [],
      eventDetails: {},
    };
    await mountApp(opts);

    const pane = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
    expect(pane).not.toBeNull();

    const deadRow = findByText(pane, '[data-testid="agent-row"]', "dead-agent");
    const aliveRow = findByText(pane, '[data-testid="agent-row"]', "alive-sibling");
    expect(deadRow).toBeDefined();
    expect(aliveRow).toBeDefined();

    // Only the tombstoned entry dims — the class carries "tombstoned" and
    // its glyph renders the died-ago marker instead of a live dot.
    expect(deadRow!.className).toContain("tombstoned");
    expect(deadRow!.textContent ?? "").toContain("died 2h ago");
    expect(deadRow!.querySelector(".app-dot")).toBeNull();

    // Bound: the live sibling is completely unaffected — no "tombstoned"
    // class, and it still carries a live dot (not the tombstone glyph).
    expect(aliveRow!.className).not.toContain("tombstoned");
    const aliveDot = aliveRow!.querySelector(".app-dot");
    expect(aliveDot).not.toBeNull();
    expect(aliveDot!.className).toContain(" g");
  });
});

// ── CR-CRU-123 §S1 — a run in flight ANIMATES on its Project-pane row ──────
//
// WHY THIS SUITE. §S1 adds a live signal to the Project pane's agent row, and
// this file is the one that already drives exactly that: the real production
// shell on `/p/<key>`, the agent row under measurement, a fixture the mocked
// `fetch` reads LIVE so a payload can change under a running app, and a real
// poll tick to observe it through. AC4's subject — the row reacting when a run
// leaves `state.openRuns` in the same response its event enters `state.events`
// — is that machinery applied to one more slice; rebuilding it beside
// `shell-final-form` (shape/placement) or `agent-runtime-pane` (runtime_ms
// rendering) would mean a third copy of this harness for one feature.
//
// RED phase (2026-09-12): production computes `busy` and renders a STATIC dot;
// nothing on the row reads `state.openRuns` at all. Every test below fails at
// the point it asks for the class a streaming row carries and an idle one does
// not — there is none, so the derived token set is empty.
//
// THE CLASS NAME IS DERIVED, NEVER HARDCODED. §S1 fixes the CONTRACT (its own
// semantic class, its own `@keyframes`, none of the three the stylesheet
// already declares) and leaves the NAME to the implementation — so these tests
// read the token off the rendered DOM (the one class a streaming row has that
// an otherwise-identical idle row lacks) and then hold the stylesheet to that
// token. A hardcoded guess would have failed for the wrong reason.

const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");
/** Comments stripped once: a provenance comment naming a class must never be
 *  read as a rule, and a commented-out `@keyframes` must never count as
 *  declared (the CR-CRU-096 defect shape). */
const STYLES_RULES = STYLES_SRC.replace(/\/\*[\s\S]*?\*\//g, "");

function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter((t) => t.length > 0);
}

function projectPane(): HTMLElement {
  const pane = document.querySelector('[data-testid="project-pane"]') as HTMLElement | null;
  expect(pane).not.toBeNull();
  return pane!;
}

function agentRows(): HTMLElement[] {
  return Array.from(projectPane().querySelectorAll('[data-testid="agent-row"]')) as HTMLElement[];
}

function rowFor(agentId: string): HTMLElement {
  const row = findByText(projectPane(), '[data-testid="agent-row"]', agentId);
  expect(row).toBeDefined();
  return row!;
}

/** The ONE class token a streaming row carries that an otherwise-identical
 *  idle row does not. Fails loudly (length 0) while §S1 is unimplemented, and
 *  fails just as loudly at length 2+ — "its own semantic class" is singular. */
function activityClassFrom(streaming: HTMLElement, idle: HTMLElement): string {
  const base = new Set(classTokens(idle));
  const added = classTokens(streaming).filter((t) => !base.has(t));
  expect(added).toHaveLength(1);
  return added[0]!;
}

/** Every `@keyframes` NAME `public/styles.css` declares. */
function declaredKeyframes(): string[] {
  return Array.from(STYLES_RULES.matchAll(/@keyframes\s+([A-Za-z][\w-]*)/g)).map((m) => m[1]!);
}

/** Every rule body whose selector list names `.<cls>` as a standalone class
 *  token — the `allRuleBodiesForClass` technique from
 *  tests/pane-scroll-floor.test.ts, for the same reason it exists there: the
 *  assertion is about the CLASS, not about one selector shape GREEN must
 *  guess (`.x {}`, `.app-agent-row.x {}` and `.x .app-agent-glyph {}` are all
 *  legitimate homes for the animation). */
function ruleBodiesForClass(cls: string): string {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`([^{}]*(?:^|[\\s,>+~])\\.${escaped}(?![\\w-])[^{}]*)\\{([^}]*)\\}`, "gs");
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(STYLES_RULES)) !== null) bodies.push(m[2] ?? "");
  return bodies.join("\n");
}

/** The declared keyframes names referenced by `animation`/`animation-name` in
 *  `body`. Intersecting against the DECLARED set is what makes this safe to
 *  run over a shorthand: `1.6s`, `ease-in-out` and `infinite` are not
 *  keyframes, and a reference to an UNDECLARED name yields nothing — which is
 *  the correct, loud outcome for a typo'd animation. */
function animationsIn(body: string, declared: string[]): string[] {
  const names: string[] = [];
  for (const decl of body.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    for (const word of (decl[1] ?? "").matchAll(/[A-Za-z][\w-]*/g)) {
      if (declared.includes(word[0]) && !names.includes(word[0])) names.push(word[0]);
    }
  }
  return names;
}

function openRun(
  overrides: Partial<OpenRunFixture> & { runId: string; projectKey: string; agentId: string },
): OpenRunFixture {
  return { startedAt: Date.now() - 4_000, ...overrides };
}

/** The three animations that already exist, BY NAME. §S1's whole point is that
 *  a fourth signal does not collapse into any of them. */
const EXISTING_ANIMATIONS = ["app-spin", "app-run-pulse", "app-locate-blink"] as const;

describe("CR-CRU-123 §S1 — an agent with a run in flight animates on its Project-pane row", () => {
  test("the row of the agent an open run NAMES carries exactly one class its otherwise-identical sibling does not — and with two agents and one open run, exactly ONE of the two rows carries it", async () => {
    const projectKey = "proj-stream-one";
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Streaming Project", agentsTotal: 2 })],
      agents: [
        agent({ agentId: "alpha-agent", projectKey, message: "working" }),
        agent({ agentId: "bravo-agent", projectKey, message: "working" }),
      ],
      events: [],
      eventDetails: {},
      openRuns: [
        openRun({ runId: "run-alpha-1", projectKey, agentId: "alpha-agent", tier: "unit" }),
      ],
    });

    const rows = agentRows();
    expect(rows.length).toBe(2);

    const activity = activityClassFrom(rowFor("alpha-agent"), rowFor("bravo-agent"));
    expect(classTokens(rowFor("alpha-agent"))).toContain(activity);
    expect(classTokens(rowFor("bravo-agent"))).not.toContain(activity);
    // COUNTED, per AC3: a fix that animates the whole list (or the pane) fails
    // here instead of looking right on a one-agent fixture.
    expect(rows.filter((r) => classTokens(r).includes(activity)).length).toBe(1);
  });

  test("with `state.openRuns` EMPTY the identical fixture animates nothing — the signal is the open-run join, not a property of being registered", async () => {
    const projectKey = "proj-stream-empty";
    const fixtures = {
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Empty Slice Project", agentsTotal: 2 })],
      agents: [
        agent({ agentId: "alpha-agent", projectKey, message: "working" }),
        agent({ agentId: "bravo-agent", projectKey, message: "working" }),
      ],
      events: [],
      eventDetails: {},
    };

    await mountApp({
      ...fixtures,
      openRuns: [openRun({ runId: "run-alpha-2", projectKey, agentId: "alpha-agent" })],
    });
    const activity = activityClassFrom(rowFor("alpha-agent"), rowFor("bravo-agent"));

    await mountApp({ ...fixtures, openRuns: [] });
    const rows = agentRows();
    // Non-vacuity: the rows are on screen, so "no row animates" is a fact
    // about the rows and not about an empty pane. Asserted as COUNTS — a
    // matcher handed a happy-dom element serialises the node's whole cyclic
    // document graph to build its failure diff and never returns.
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => classTokens(r).includes(activity)).length).toBe(0);
  });

  test("the activity class drives its OWN `@keyframes` in public/styles.css — not app-spin, not app-run-pulse, not app-locate-blink, each ruled out by name", async () => {
    const projectKey = "proj-stream-css";
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Animation Identity Project", agentsTotal: 2 })],
      agents: [
        agent({ agentId: "alpha-agent", projectKey, message: "working" }),
        agent({ agentId: "bravo-agent", projectKey, message: "working" }),
      ],
      events: [],
      eventDetails: {},
      openRuns: [openRun({ runId: "run-alpha-3", projectKey, agentId: "alpha-agent" })],
    });

    const declared = declaredKeyframes();
    // The three that already exist are still declared — a "fourth signal" that
    // arrived by renaming one of them is not a fourth signal.
    for (const existing of EXISTING_ANIMATIONS) expect(declared).toContain(existing);

    // The stylesheet is held to the class the DOM actually carries, so the
    // signal and its motion cannot be wired to two different names.
    const activity = activityClassFrom(rowFor("alpha-agent"), rowFor("bravo-agent"));
    const body = ruleBodiesForClass(activity);
    expect(body.length).toBeGreaterThan(0);

    const used = animationsIn(body, declared);
    expect(used).toHaveLength(1);
    const animation = used[0]!;
    expect(declared).toContain(animation);
    expect(animation).not.toBe("app-spin");
    expect(animation).not.toBe("app-run-pulse");
    expect(animation).not.toBe("app-locate-blink");
  });

  test(
    "when the open run SETTLES — the same response drops it from `state.openRuns` and carries its event into `state.events` — the row stops animating, driven by the production refetch and by no timer",
    async () => {
      const now = Date.now();
      const projectKey = "proj-stream-settle";
      const eventId = "evt-stream-settle-1";
      const fx = unitFixture(eventId, projectKey, "alpha-agent", now);
      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Settling Project", agentsTotal: 2 })],
        agents: [
          agent({ agentId: "alpha-agent", projectKey, message: "working" }),
          agent({ agentId: "bravo-agent", projectKey, message: "working" }),
        ],
        events: [],
        eventDetails: {},
        openRuns: [
          openRun({ runId: "run-alpha-settle", projectKey, agentId: "alpha-agent", tier: "unit" }),
        ],
      };
      await mountApp(opts);

      const whileStreaming = classTokens(rowFor("alpha-agent"));

      // The open run is live on the FEED too — same slice, same tick — so what
      // follows is the real lifecycle transition observed from both sides, not
      // a fixture nudge only the rail can see.
      const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
      expect(runsTab).toBeDefined();
      runsTab!.click();
      await settle();
      expect(document.querySelectorAll('[data-testid="running-card"]').length).toBe(1);

      // THE TRANSITION (CR-CRU-017 §S3): one response, the run out of
      // `openRuns` and its settled event into `events`. Nothing here touches a
      // class or a timeout — the production poll refetch re-renders the row.
      opts.openRuns!.length = 0;
      opts.events.unshift(fx.brief);
      opts.eventDetails[eventId] = fx.detail;

      await waitForPollTick();

      // Both halves of the transition landed…
      expect(document.querySelectorAll('[data-testid="running-card"]').length).toBe(0);
      expect(document.querySelector('[data-testid="event-card"]')).not.toBeNull();

      // …and the row shed exactly the one class it was animating with. Taken
      // as a DIFF across the same row, so the assertion is "the signal
      // stopped" and not "the row happens to have no classes".
      const afterSettle = new Set(classTokens(rowFor("alpha-agent")));
      const dropped = whileStreaming.filter((t) => !afterSettle.has(t));
      expect(dropped).toHaveLength(1);
      // Bound: settling may not ADD row state either (no leftover marker
      // class), and the row is still on the pane — the signal stopped, the
      // row did not disappear with it.
      const streamingSet = new Set(whileStreaming);
      expect([...afterSettle].filter((t) => !streamingSet.has(t))).toEqual([]);
      expect(rowFor("alpha-agent").textContent ?? "").toContain("alpha-agent");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test("the static busy dot and the activity signal are INDEPENDENT — a busy streaming row carries both, a busy idle row keeps the red dot alone, and a streaming non-busy row animates with its plain online dot", async () => {
    const projectKey = "proj-stream-busy";
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Busy Independence Project", agentsTotal: 3 })],
      agents: [
        agent({ agentId: "alpha-agent", projectKey, status: "busy", liveness: "online", message: "working" }),
        agent({ agentId: "bravo-agent", projectKey, status: "busy", liveness: "online", message: "working" }),
        agent({ agentId: "delta-agent", projectKey, status: "online", liveness: "online", message: "working" }),
      ],
      events: [],
      eventDetails: {},
      openRuns: [
        openRun({ runId: "run-alpha-4", projectKey, agentId: "alpha-agent" }),
        openRun({ runId: "run-delta-1", projectKey, agentId: "delta-agent" }),
      ],
    });

    const dotClass = (agentId: string): string => {
      const dot = rowFor(agentId).querySelector(".app-dot");
      expect(dot).not.toBeNull();
      return dot!.className;
    };

    // The §S1 regression pin, asserted first because it is the half that must
    // NOT change: `status === "busy"` still paints the red dot, streaming or
    // not, and streaming does not repaint a non-busy agent's dot.
    expect(dotClass("alpha-agent")).toContain(" r");
    expect(dotClass("bravo-agent")).toContain(" r");
    expect(dotClass("delta-agent")).toContain(" g");

    const activity = activityClassFrom(rowFor("alpha-agent"), rowFor("bravo-agent"));
    expect(classTokens(rowFor("alpha-agent"))).toContain(activity);
    expect(classTokens(rowFor("bravo-agent"))).not.toContain(activity);
    // The other direction of independence: animating without being busy.
    expect(classTokens(rowFor("delta-agent"))).toContain(activity);
  });

  test("a TOMBSTONED agent never animates even when a stale open run still names it — while a live streaming sibling in the same render does", async () => {
    const now = Date.now();
    const projectKey = "proj-stream-tomb";
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Stale Run Project", agentsOnline: 2, agentsTotal: 3 })],
      agents: [
        agent({ agentId: "alpha-agent", projectKey, message: "working" }),
        agent({ agentId: "bravo-agent", projectKey, message: "working" }),
        agent({
          agentId: "buried-agent",
          projectKey,
          liveness: "tombstoned",
          lastSeen: now - 7_200_000,
          message: "died mid-run",
        }),
      ],
      events: [],
      eventDetails: {},
      openRuns: [
        openRun({ runId: "run-alpha-5", projectKey, agentId: "alpha-agent" }),
        // The stale one `sweepOpenRuns` has not settled yet — it still names a
        // dead agent, and a dead agent has nothing in flight.
        openRun({ runId: "run-buried-1", projectKey, agentId: "buried-agent", startedAt: now - 7_100_000 }),
      ],
    });

    const buried = rowFor("buried-agent");
    expect(buried.className).toContain("tombstoned");

    const activity = activityClassFrom(rowFor("alpha-agent"), rowFor("bravo-agent"));
    expect(classTokens(buried)).not.toContain(activity);
    // Counted across the whole pane: the live streaming row is the only one.
    expect(agentRows().filter((r) => classTokens(r).includes(activity)).length).toBe(1);
  });

  test("AC7 — the streaming row gains NO new child element: its child count equals the idle sibling's, and the row is still the PRD's locked sub-row (dot + display name, message, last-seen)", async () => {
    const projectKey = "proj-stream-shape";
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Locked Shape Project", agentsTotal: 2 })],
      agents: [
        agent({ agentId: "alpha-agent", projectKey, message: "working" }),
        agent({ agentId: "bravo-agent", projectKey, message: "working" }),
      ],
      events: [],
      eventDetails: {},
      openRuns: [openRun({ runId: "run-alpha-6", projectKey, agentId: "alpha-agent" })],
    });

    const streaming = rowFor("alpha-agent");
    const idle = rowFor("bravo-agent");

    // The lock, asserted BEFORE the signal it constrains: equality alone would
    // still pass if a fifth child were appended to EVERY row, so the absolute
    // count is pinned too. Three element children on this fixture — the
    // `app-agent-id` span (liveness dot + display name), `app-agent-msg`, and
    // the `seen …` card-meta; `agent-runtime` renders only with a runtime_ms,
    // which this fixture deliberately omits. PRD §4.11's agent sub-row
    // enumeration is a locked final form ("round 6, 2026-07-15"), so §S1's
    // signal must ride an existing node or the row's own box.
    expect(streaming.children.length).toBe(idle.children.length);
    expect(streaming.children.length).toBe(3);
    expect(streaming.querySelector(".app-agent-id")).not.toBeNull();
    expect(streaming.querySelector(".app-agent-msg")).not.toBeNull();
    expect(streaming.textContent ?? "").toContain("seen ");

    // …and it IS the streaming row whose shape was just measured.
    const activity = activityClassFrom(streaming, idle);
    expect(classTokens(streaming)).toContain(activity);
  });

  test("AC8 — an open run belonging to ANOTHER project never animates a row in THIS project's pane, even though both projects hold an agent with the SAME agentId", async () => {
    const projectKeyA = "proj-stream-scope-a";
    const projectKeyB = "proj-stream-scope-b";
    // `vidushi` is the orchestrator id in EVERY project on this board, so the
    // id collision this predicate has to survive is the real one and not a
    // contrived fixture.
    const fixtures = {
      pathname: `/p/${projectKeyA}`,
      projects: [
        project({ key: projectKeyA, name: "Scoped Project A", agentsTotal: 2 }),
        project({ key: projectKeyB, name: "Other Project B", agentsTotal: 1 }),
      ],
      agents: [
        agent({ agentId: "vidushi", projectKey: projectKeyA, message: "working" }),
        agent({ agentId: "bravo-agent", projectKey: projectKeyA, message: "working" }),
        // The same id registered in the OTHER project. `visibleAgents()` keeps
        // it off this pane, which is precisely why only the RUN's own
        // projectKey can tell the two `vidushi`s apart.
        agent({ agentId: "vidushi", projectKey: projectKeyB, message: "working" }),
      ],
      events: [],
      eventDetails: {},
    };

    // NON-VACUITY PRELUDE, asserted first: the identical fixture with the run
    // in THIS project DOES animate the row. Without it, a predicate that
    // animates nothing at all would satisfy AC8 for free.
    await mountApp({
      ...fixtures,
      openRuns: [
        openRun({ runId: "run-vidushi-scope", projectKey: projectKeyA, agentId: "vidushi" }),
      ],
    });
    const activity = activityClassFrom(rowFor("vidushi"), rowFor("bravo-agent"));
    expect(classTokens(rowFor("vidushi"))).toContain(activity);

    // AC8 — the ONLY difference is the run's projectKey.
    await mountApp({
      ...fixtures,
      openRuns: [
        openRun({ runId: "run-vidushi-scope", projectKey: projectKeyB, agentId: "vidushi" }),
      ],
    });
    const rows = agentRows();
    // Counted, and with the rows proven on screen: "nothing animates" is a
    // fact about these two rows, not about an empty pane.
    expect(rows.length).toBe(2);
    expect(classTokens(rowFor("vidushi"))).not.toContain(activity);
    expect(rows.filter((r) => classTokens(r).includes(activity)).length).toBe(0);
  });
});
