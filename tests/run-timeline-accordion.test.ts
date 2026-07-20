// CR-CRU-025 §S2b — Run Timeline accordion on the declared `Cycle done`
// boundary marker.
//
// RED phase: NONE of this exists yet against current production.
// `DeclaredMarkerRow` (public/app.js ~729) renders its whole body as a plain
// string join plus the C2 `BoundaryToCycleBadge` trailing node — it carries
// NO click handler of its own at all, so nothing can toggle, nothing hides
// linked run cards, and no collapsed cue exists. This file pins the GREEN
// contract §S2b chooses (read off the CR text + existing conventions
// already established in this file family):
//
//   - The marker's OWN `onclick` (the whole `[data-testid="declared-marker"]`
//     div, separate from the nested `boundary-to-cycle` badge which already
//     `stopPropagation`s per C2) toggles a per-cycleId collapse flag.
//   - COLLAPSED: every `[data-testid="event-card"][data-run-id="<id>"]`
//     whose event is linked to THIS cycle (`context.cycleId` resolving to
//     this declared cycle, the same linkage `app-logic.mjs#timelineRows`
//     already computes) is REMOVED from the DOM entirely (mirrors the
//     existing "no container renders at all" convention `OpenSpan` already
//     uses for its own zero-runs case) — never merely CSS-hidden, since
//     happy-dom performs no real cascade.
//   - COLLAPSED also renders a NEW child
//     `[data-testid="accordion-collapsed-cue"]` inside the marker, exact text
//     `▸ <N> runs` where N is the cycle's current linked-run count.
//   - EXPANDED (default, and after a second body click): the cue is gone and
//     every linked card renders normally again.
//   - Each cycle's collapse flag is independent (a Map/Set keyed by cycleId,
//     never a single global toggle) and SURVIVES a feed re-render (the same
//     `vanX.replace(state.events, …)` cycle the real SSE/poll refresh drives)
//     within the pane session — never reset by a re-render on its own.
//   - `CycleSpanOpenRow` (the ACTIVE cycle's open-span header) gets NO
//     accordion at all — no click handler, no cue, and its own linked run
//     cards are never touched by any OTHER cycle's collapse state.
//   - The heuristic RED➜GREEN `transition-marker` carries no `data-cycle-id`
//     and no accordion — its whole-body click keeps opening the GREEN run's
//     drill-in exactly as before (CR-CRU-007 §S2), untouched by this CR.
//   - `BoundaryToCycleBadge`'s existing `stopPropagation` (C2, already
//     shipped) means clicking it must NEVER flip this marker's collapse flag.
//
// Harness: near-verbatim copy of tests/cycle-run-navigation.test.ts's
// happy-dom + real public/app.js / public/app-logic.mjs mount pattern,
// extended with tests/plan-scoping.test.ts's live-mutable-events-store +
// real-poll-tick technique (§7 there) to simulate an actual SSE/poll-driven
// feed re-render without stubbing `vanX.replace` or `refetch` directly.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

// The real poll interval is a hard-coded 5000ms (public/app.js ~L223,
// `setInterval(refetch, 5000)` — `typeof EventSource === "undefined"` under
// happy-dom so `connectStream()` always falls back to `startPolling()`, per
// tests/plan-scoping.test.ts's harness note and tests/inpane-liveness.test.ts).
// Every test here except the explicit re-render pin settles on short ticks
// far below this, so no poll-driven refetch can be responsible for a passing
// assertion in those.
const POLL_INTERVAL_MS = 5000;
const POLL_WAIT_MS = POLL_INTERVAL_MS + 700;
const POLL_TEST_TIMEOUT_MS = 15_000;

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  context?: { cycleId?: number; cycle?: string };
}

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
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

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
}

let cacheBust = 0;
// Live-mutable store the mocked fetch reads on EVERY call (not just at mount
// time) — the same technique tests/plan-scoping.test.ts §7 uses for its own
// poll-tick regression pin. Mutating this between the initial mount and a
// `waitForPollTick()` call is how this file simulates an actual SSE/poll
// re-render of the Runs timeline.
let eventsStore: EventFixture[] = [];
let plansStore: PlanFixture[] = [];

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  eventsStore = opts.events;
  plansStore = opts.plans;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: plansStore };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: eventsStore };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`run-timeline-accordion.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?runTimelineAccordion=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForPollTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS));
  await settle();
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

function runEvent(
  overrides: Partial<EventFixture> & Pick<EventFixture, "id" | "projectKey" | "agentId" | "timestamp">,
): EventFixture {
  return {
    kind: "test",
    tier: "unit",
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
    ...overrides,
  };
}

async function clickTab(name: string): Promise<HTMLElement> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
  return tab!;
}

function isActiveTab(name: string): boolean {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  return tab !== undefined && /\bon\b/.test(tab.className);
}

function declaredMarker(cycleId: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

function eventCard(runId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="event-card"][data-run-id="${runId}"]`,
  );
}

function collapsedCue(marker: HTMLElement): HTMLElement | null {
  return marker.querySelector<HTMLElement>('[data-testid="accordion-collapsed-cue"]');
}

// A body click on a declared marker must NEVER be routed through the
// stopPropagation-guarded `boundary-to-cycle` badge — click the marker
// element itself (not a descendant) so this always exercises the marker's
// OWN handler regardless of where GREEN places the badge in the tree.
function clickMarkerBody(marker: HTMLElement): void {
  marker.click();
}

// ── AC1 — body click hides ONLY that cycle's linked run cards ─────────────

describe("§S2b run-timeline accordion — body click toggles ONLY that cycle's linked run cards", () => {
  test('first body click on a declared "Cycle done" marker removes ONLY that cycle\'s linked event-cards, adds a "▸ N runs" collapsed cue, and leaves other cycles\' + unlinked cards untouched; a second click restores everything', async () => {
    const key = "cr025-accordion-toggle-1";
    const now = Date.now();
    const cycleA = 3001;
    const cycleB = 3002;

    const runA1 = runEvent({
      id: "evt-accordion-a1",
      projectKey: key,
      agentId: "agent-a1",
      timestamp: now,
      context: { cycleId: cycleA },
    });
    const runA2 = runEvent({
      id: "evt-accordion-a2",
      projectKey: key,
      agentId: "agent-a2",
      timestamp: now + 1000,
      context: { cycleId: cycleA },
    });
    const runB1 = runEvent({
      id: "evt-accordion-b1",
      projectKey: key,
      agentId: "agent-b1",
      timestamp: now + 2000,
      context: { cycleId: cycleB },
    });
    const runUnlinked = runEvent({
      id: "evt-accordion-unlinked",
      projectKey: key,
      agentId: "agent-u",
      timestamp: now + 3000,
      // No context.cycleId at all — an ordinary unlinked run.
    });

    const plan: PlanFixture = {
      planId: 30001,
      cr: "CR-025-ACCORDION-1",
      projectKey: key,
      status: "open",
      cycles: [
        { id: cycleA, label: "cycle A", status: "done" },
        { id: cycleB, label: "cycle B", status: "done" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Accordion Toggle" })],
      events: [runA1, runA2, runB1, runUnlinked],
      plans: [plan],
    });
    await clickTab("Runs");

    // Default EXPANDED — every linked + unlinked card renders, no cue.
    expect(eventCard("evt-accordion-a1")).not.toBeNull();
    expect(eventCard("evt-accordion-a2")).not.toBeNull();
    expect(eventCard("evt-accordion-b1")).not.toBeNull();
    expect(eventCard("evt-accordion-unlinked")).not.toBeNull();

    const markerA = declaredMarker(cycleA);
    const markerB = declaredMarker(cycleB);
    expect(collapsedCue(markerA) === null).toBe(true);
    expect(collapsedCue(markerB) === null).toBe(true);

    // First body click on cycle A's marker collapses ONLY cycle A.
    clickMarkerBody(markerA);
    await settle();

    expect(eventCard("evt-accordion-a1") === null).toBe(true);
    expect(eventCard("evt-accordion-a2") === null).toBe(true);
    // Cycle B's linked card and the unlinked card are UNTOUCHED.
    expect(eventCard("evt-accordion-b1")).not.toBeNull();
    expect(eventCard("evt-accordion-unlinked")).not.toBeNull();

    const markerAAfterCollapse = declaredMarker(cycleA);
    const cueA = collapsedCue(markerAAfterCollapse);
    expect(cueA).not.toBeNull();
    expect((cueA!.textContent ?? "").trim()).toBe("▸ 2 runs");
    // Cycle B stays expanded — its own marker carries no cue.
    expect(collapsedCue(declaredMarker(cycleB)) === null).toBe(true);

    // Second click on the SAME marker restores everything.
    clickMarkerBody(declaredMarker(cycleA));
    await settle();

    expect(eventCard("evt-accordion-a1")).not.toBeNull();
    expect(eventCard("evt-accordion-a2")).not.toBeNull();
    expect(eventCard("evt-accordion-b1")).not.toBeNull();
    expect(eventCard("evt-accordion-unlinked")).not.toBeNull();
    expect(collapsedCue(declaredMarker(cycleA)) === null).toBe(true);
    expect(collapsedCue(declaredMarker(cycleB)) === null).toBe(true);
  });
});

// ── AC2 — default expanded + survives a real feed re-render, per cycle ────

describe("§S2b run-timeline accordion — default expanded, survives a poll-driven feed re-render, independent per cycle", () => {
  test(
    "a cold load renders every cycle expanded; collapsing ONE cycle and then letting a real SSE/poll re-render land (new unlinked event arrives) keeps EXACTLY that cycle collapsed while every other cycle stays expanded",
    async () => {
      const key = "cr025-accordion-persist-1";
      const now = Date.now();
      const cycleA = 3101;
      const cycleB = 3102;

      const runA1 = runEvent({
        id: "evt-persist-a1",
        projectKey: key,
        agentId: "agent-a1",
        timestamp: now,
        context: { cycleId: cycleA },
      });
      const runB1 = runEvent({
        id: "evt-persist-b1",
        projectKey: key,
        agentId: "agent-b1",
        timestamp: now + 1000,
        context: { cycleId: cycleB },
      });

      const plan: PlanFixture = {
        planId: 30101,
        cr: "CR-025-ACCORDION-PERSIST-1",
        projectKey: key,
        status: "open",
        cycles: [
          { id: cycleA, label: "cycle A", status: "done" },
          { id: cycleB, label: "cycle B", status: "done" },
        ],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "CR025 Accordion Persist" })],
        events: [runA1, runB1],
        plans: [plan],
      });
      await clickTab("Runs");

      // Cold load — everything expanded, no cue anywhere.
      expect(eventCard("evt-persist-a1")).not.toBeNull();
      expect(eventCard("evt-persist-b1")).not.toBeNull();
      expect(collapsedCue(declaredMarker(cycleA)) === null).toBe(true);
      expect(collapsedCue(declaredMarker(cycleB)) === null).toBe(true);

      // Collapse cycle A only.
      clickMarkerBody(declaredMarker(cycleA));
      await settle();
      expect(eventCard("evt-persist-a1") === null).toBe(true);
      expect(eventCard("evt-persist-b1")).not.toBeNull();
      expect((collapsedCue(declaredMarker(cycleA))!.textContent ?? "").trim()).toBe(
        "▸ 1 runs",
      );

      // A genuine feed re-render arrives (a NEW unlinked run, delivered the
      // same way the real poll fallback delivers one) — this must NOT reset
      // any cycle's collapse flag on its own (§S2b AC2 — "a fresh
      // load/poll/SSE re-render never hides runs on its own" also implies it
      // never un-hides a user-collapsed cycle either).
      eventsStore = [
        ...eventsStore,
        runEvent({
          id: "evt-persist-new-unlinked",
          projectKey: key,
          agentId: "agent-new",
          timestamp: now + 5000,
        }),
      ];

      await waitForPollTick();

      // The new unlinked card arrived — proves the re-render really happened.
      expect(eventCard("evt-persist-new-unlinked")).not.toBeNull();

      // Cycle A is STILL collapsed; cycle B is STILL expanded.
      expect(eventCard("evt-persist-a1") === null).toBe(true);
      expect(eventCard("evt-persist-b1")).not.toBeNull();
      const cueAAfterPoll = collapsedCue(declaredMarker(cycleA));
      expect(cueAAfterPoll).not.toBeNull();
      expect((cueAAfterPoll!.textContent ?? "").trim()).toBe("▸ 1 runs");
      expect(collapsedCue(declaredMarker(cycleB)) === null).toBe(true);
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── AC3 — boundaries: ACTIVE open span always inline; heuristic untouched ──

describe("§S2b run-timeline accordion — boundaries", () => {
  test("the ACTIVE cycle's open-span header carries no accordion at all — clicking it does nothing, and its linked run cards stay visible regardless of another (done) cycle's collapse state", async () => {
    const key = "cr025-accordion-active-boundary-1";
    const now = Date.now();
    const activeCycle = 3201;
    const doneCycle = 3202;

    const activeRun = runEvent({
      id: "evt-active-boundary-open",
      projectKey: key,
      agentId: "agent-active",
      timestamp: now,
      context: { cycleId: activeCycle },
    });
    const doneRun = runEvent({
      id: "evt-active-boundary-done",
      projectKey: key,
      agentId: "agent-done",
      timestamp: now + 1000,
      context: { cycleId: doneCycle },
    });

    const plan: PlanFixture = {
      planId: 30201,
      cr: "CR-025-ACCORDION-ACTIVE-BOUNDARY-1",
      projectKey: key,
      status: "open",
      cycles: [
        { id: activeCycle, label: "active cycle", status: "active" },
        { id: doneCycle, label: "done cycle", status: "done" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Active Boundary" })],
      events: [activeRun, doneRun],
      plans: [plan],
    });
    await clickTab("Runs");

    const openSpanHeader = document.querySelector<HTMLElement>(
      '[data-testid="cycle-span-open"]',
    );
    expect(openSpanHeader).not.toBeNull();
    expect(collapsedCue(openSpanHeader!) === null).toBe(true);
    expect(eventCard("evt-active-boundary-open")).not.toBeNull();

    // Clicking the open-span header must be a complete no-op — no cue, no
    // hidden cards, nothing.
    openSpanHeader!.click();
    await settle();
    expect(collapsedCue(openSpanHeader!) === null).toBe(true);
    expect(eventCard("evt-active-boundary-open")).not.toBeNull();
    expect(eventCard("evt-active-boundary-done")).not.toBeNull();

    // Now collapse the DONE cycle's own marker — the active cycle's run
    // stays visible throughout, untouched by a different cycle's toggle.
    clickMarkerBody(declaredMarker(doneCycle));
    await settle();
    expect(eventCard("evt-active-boundary-done") === null).toBe(true);
    expect(eventCard("evt-active-boundary-open")).not.toBeNull();
    expect(collapsedCue(openSpanHeader!) === null).toBe(true);
  });

  test("a heuristic RED➜GREEN transition marker (planless project) carries no data-cycle-id and no accordion — its whole-body click still opens the GREEN run's drill-in exactly as before, never a collapse toggle", async () => {
    const key = "cr025-accordion-heuristic-1";
    const t0 = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    const redId = "evt-accordion-heuristic-red";
    const greenId = "evt-accordion-heuristic-green";
    const redEvt = runEvent({
      id: redId,
      projectKey: key,
      agentId: "CR-025-ACC-HEUR-1-RED",
      timestamp: t0,
      total: 5,
      passed: 3,
      failed: 2,
    });
    const greenEvt = runEvent({
      id: greenId,
      projectKey: key,
      agentId: "CR-025-ACC-HEUR-1-GREEN",
      timestamp: t0 + 45_000,
      total: 5,
      passed: 5,
      failed: 0,
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Accordion Heuristic" })],
      events: [redEvt, greenEvt],
      // Deliberately NO plans — keeps the CR-007 §S2 streak heuristic
      // byte-identical (CR-CRU-026 §S3.4); a plan at all would suppress it.
      plans: [],
    });
    await clickTab("Runs");

    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(1);
    const marker = markers[0] as HTMLElement;
    expect(marker.hasAttribute("data-cycle-id")).toBe(false);
    expect(collapsedCue(marker) === null).toBe(true);

    marker.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/${greenId}`);
    // Still no accordion machinery on it after the click.
    const markerAfter = document.querySelector('[data-testid="transition-marker"]') as HTMLElement | null;
    if (markerAfter !== null) expect(collapsedCue(markerAfter) === null).toBe(true);
  });
});

// ── AC4 — boundary-to-cycle badge click never toggles the accordion ───────

describe("§S2b run-timeline accordion — boundary-to-cycle badge click never toggles the accordion (stopPropagation)", () => {
  test("clicking the boundary-to-cycle badge (which navigates away to Workflow) never collapses its own marker's linked run cards — returning to Runs shows the cycle still fully expanded", async () => {
    const key = "cr025-accordion-badge-stopprop-1";
    const now = Date.now();
    const cycleId = 3301;

    const run1 = runEvent({
      id: "evt-badge-stopprop-1",
      projectKey: key,
      agentId: "agent-1",
      timestamp: now,
      context: { cycleId },
    });
    const run2 = runEvent({
      id: "evt-badge-stopprop-2",
      projectKey: key,
      agentId: "agent-2",
      timestamp: now + 1000,
      context: { cycleId },
    });

    const plan: PlanFixture = {
      planId: 30301,
      cr: "CR-025-ACCORDION-BADGE-STOPPROP-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Badge StopProp" })],
      events: [run1, run2],
      plans: [plan],
    });
    await clickTab("Runs");

    const marker = declaredMarker(cycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();
    expect(collapsedCue(marker) === null).toBe(true);

    // Neutralize the 10s locate-blink timer this badge schedules (C2) so the
    // test never waits on a real 10s timeout — irrelevant to this pin.
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 10_000) return 0 as unknown as ReturnType<typeof setTimeout>;
      return originalSetTimeout(fn as TimerHandler, delay as number | undefined, ...args);
    }) as typeof setTimeout;

    try {
      badge!.click();
      await settle();

      // The badge's own contract fired (navigated away to Workflow) — proves
      // this really was a badge click, not a no-op.
      expect(isActiveTab("Workflow")).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // Return to Runs — the accordion state must show fully EXPANDED: the
    // badge click never toggled this marker's own collapse flag.
    await clickTab("Runs");
    expect(eventCard("evt-badge-stopprop-1")).not.toBeNull();
    expect(eventCard("evt-badge-stopprop-2")).not.toBeNull();
    expect(collapsedCue(declaredMarker(cycleId)) === null).toBe(true);
  });
});
