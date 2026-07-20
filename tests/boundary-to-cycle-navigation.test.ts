// CR-CRU-025 §S2 — Runs boundary → cycle row (inverse direction).
//
// RED phase: NONE of this exists yet against current production. Today
// `DeclaredMarkerRow` (public/app.js ~729, carries `data-cycle-id` since
// C1's §S1 GREEN) renders its WHOLE body as a single plain string join —
// no children, no trailing badge at all. This file pins the GREEN contract
// §S2 chooses (read off the CR text + the dispatch + existing
// testid/attribute conventions already used elsewhere in this file family):
//   - `[data-testid="boundary-to-cycle"]` — the NEW single trailing badge on
//     a DECLARED `Cycle done` boundary marker, exact label text "⚑ Cycle"
//     (init-caps, per the CR text). The earlier `⊙ Detail` badge
//     (`boundary-detail`) never ships on this marker — RETIRED by the
//     2026-07-17 user correction ("you dont need to have a detail badge on
//     it!") — this file asserts NO `boundary-detail` node ever appears.
//   - Clicking `boundary-to-cycle` (and ONLY it — the click must
//     `stopPropagation` so it never reaches a future §S2b accordion body
//     handler C3 adds on the marker):
//       1. Sets `state.workspaceTab = "Workflow"` (the SAME one-rule tab
//          swap C1 used, inverted).
//       2. Locates the exact cycle row by cycleId — this file's chosen
//          GREEN contract is `[data-testid="cycle-row"][data-cycle-id="
//          <id>"]` in the ACTIVE section, or `[data-testid="lens-cycle-
//          row"][data-cycle-id="<id>"]` in HISTORY (mirroring the
//          `data-cycle-id` convention C1 put on `declared-marker`) —
//          auto-expanding the containing COLLAPSED `cr-group` first when
//          the row lives in history.
//       3. `scrollIntoView()`s that exact row.
//       4. Blinks it via the SAME shared `locateBlink(el)` util C1 added —
//          a 10s JS-cleared marker class; re-triggering resets the clock
//          (single indicator, never two) — asserted by intercepting
//          `setTimeout`/`clearTimeout` calls at delay 10_000 (never a real
//          10s sleep).
//   - Badge-shape (CR-023 660px pane floor): the badge's own CSS class(es)
//     must declare `white-space: nowrap` + `flex-shrink: 0` in
//     public/styles.css (source-assertion — same technique
//     tests/cycle-run-navigation.test.ts's §S1 AC4 already established,
//     since happy-dom performs no real layout/cascade).
//
// Harness: near-verbatim copy of tests/cycle-run-navigation.test.ts's
// happy-dom + real public/app.js / public/app-logic.mjs mount pattern.
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
// §S2 badge-shape source-assertion — same technique
// tests/cycle-run-navigation.test.ts's §S1 AC4 (and tests/cycle-timers.test.ts
// §S6 item 2 before it) already established: happy-dom has no real CSS
// cascade, so a `getComputedStyle` assertion always reads empty. The
// sanctioned alternative is a regex read of the real stylesheet source.
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");
function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(STYLES_SRC);
  return match?.[1];
}

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

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`boundary-to-cycle-navigation.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?boundaryToCycleNav=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

function history(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(el).not.toBeNull();
  return el!;
}

function activeSection(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-active"]');
  expect(el).not.toBeNull();
  return el!;
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

// Shared assertion for the ACTIVE + HISTORY click contract — clicking the
// NEW `boundary-to-cycle` badge must (a) land on the Workflow tab (the
// one-rule `workspaceTab` swap, inverted from §S1's), (b) `scrollIntoView`
// the exact cycle row matched by `targetSelector`, and (c) apply the SAME
// shared blink marker class that a JS-scheduled 10s timer removes —
// verified by intercepting `setTimeout(fn, 10_000)` (never a real sleep).
async function clickBoundaryBadgeAndAssertNavigateThenBlink(
  badge: HTMLElement,
  targetSelector: string,
): Promise<void> {
  const scrollCalls: HTMLElement[] = [];
  const originalScrollIntoView = (
    HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }
  ).scrollIntoView;
  (HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void }).scrollIntoView =
    function (this: HTMLElement) {
      scrollCalls.push(this);
    };

  const originalSetTimeout = globalThis.setTimeout;
  const pendingBlinkClears: Array<() => void> = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 10_000) {
      pendingBlinkClears.push(() => fn(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(fn as TimerHandler, delay as number | undefined, ...args);
  }) as typeof setTimeout;

  try {
    expect(isActiveTab("Workflow")).toBe(false);
    badge.click();
    await settle();

    // (a) — the one-rule tab swap landed back on Workflow.
    expect(isActiveTab("Workflow")).toBe(true);
    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();

    const target = document.querySelector<HTMLElement>(targetSelector);
    expect(target).not.toBeNull();

    // (b) — scrolled into view.
    expect(scrollCalls).toContain(target!);

    // A 10s blink-clear timer must have been scheduled.
    expect(pendingBlinkClears.length).toBeGreaterThan(0);
    const blinkOnClasses = Array.from(target!.classList);

    // (c) — flush the 10s timer(s); the blink class(es) must be GONE
    // afterwards (re-query in case the reactive re-render swapped nodes).
    const toRun = pendingBlinkClears.splice(0, pendingBlinkClears.length);
    for (const cb of toRun) cb();
    await settle();

    const refreshed = document.querySelector<HTMLElement>(targetSelector);
    expect(refreshed).not.toBeNull();
    const blinkOffClasses = Array.from(refreshed!.classList);
    expect(blinkOffClasses.length).toBeLessThan(blinkOnClasses.length);
    for (const c of blinkOffClasses) expect(blinkOnClasses).toContain(c);
  } finally {
    (HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }).scrollIntoView =
      originalScrollIntoView;
    globalThis.setTimeout = originalSetTimeout;
  }
}

// ── badge presence + retirement of boundary-detail ─────────────────────────

describe("§S2 boundary-to-cycle — badge presence on the declared marker", () => {
  test('a declared Cycle-done boundary marker renders exactly ONE badge data-testid="boundary-to-cycle" with exact label "⚑ Cycle", and NO data-testid="boundary-detail" (retired 2026-07-17)', async () => {
    const key = "cr025-badge-presence-1";
    const now = Date.now();
    const cycleId = 8501;
    const linkedRun = runEvent({
      id: "evt-cr025-badge-presence-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9101,
      cr: "CR-025-BADGE-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Badge" })],
      events: [linkedRun],
      plans: [plan],
    });
    await clickTab("Runs");

    const marker = declaredMarker(cycleId);
    const badges = marker.querySelectorAll('[data-testid="boundary-to-cycle"]');
    expect(badges.length).toBe(1);
    expect((badges[0]!.textContent ?? "").trim()).toBe("⚑ Cycle");

    expect(marker.querySelector('[data-testid="boundary-detail"]')).toBeNull();
  });
});

// ── ACTIVE section click contract ───────────────────────────────────────────

describe("§S2 boundary-to-cycle — ACTIVE section click contract", () => {
  test("clicking boundary-to-cycle from an open (ACTIVE) plan's marker switches to the Workflow tab and scrolls+blinks the exact cycle row (matched by cycleId) for 10s (fake-timer flush)", async () => {
    const key = "cr025-active-inverse-1";
    const now = Date.now();
    const cycleId = 8502;
    const linkedRun = runEvent({
      id: "evt-cr025-active-inverse-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9102,
      cr: "CR-025-ACTIVE-INV-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Active Inverse" })],
      events: [linkedRun],
      plans: [plan],
    });
    await clickTab("Runs");

    const marker = declaredMarker(cycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    await clickBoundaryBadgeAndAssertNavigateThenBlink(
      badge!,
      `[data-testid="cycle-row"][data-cycle-id="${cycleId}"]`,
    );

    // The row really is the ACTIVE section's row, not a stray match.
    const row = activeSection().querySelector<HTMLElement>(
      `[data-testid="cycle-row"][data-cycle-id="${cycleId}"]`,
    );
    expect(row).not.toBeNull();
  });
});

// ── HISTORY click contract — collapsed CR group auto-expands ───────────────

describe("§S2 boundary-to-cycle — HISTORY click contract (collapsed CR group auto-expands)", () => {
  test("clicking boundary-to-cycle from a closed plan's marker auto-expands the containing COLLAPSED cr-group, switches to Workflow, and scrolls+blinks the exact lens-cycle-row (matched by cycleId)", async () => {
    const key = "cr025-history-inverse-1";
    const now = Date.now();
    const cycleId = 8601;
    const linkedRun = runEvent({
      id: "evt-cr025-history-inverse-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9103,
      cr: "CR-025-HISTORY-INV-1",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "cr025histinv1" },
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 History Inverse" })],
      events: [linkedRun],
      plans: [plan],
    });

    // Confirm the CR group starts COLLAPSED (lens groups collapse by
    // default — CR-CRU-020 §S1.2) before we ever click the badge.
    const crGroupBefore = Array.from(
      history().querySelectorAll<HTMLElement>('[data-testid="cr-group"]'),
    ).find((g) => g.getAttribute("data-cr") === "CR-025-HISTORY-INV-1");
    expect(crGroupBefore).toBeDefined();
    expect(
      crGroupBefore!.querySelector('[data-testid="lens-cycle-row"]'),
    ).toBeNull();

    await clickTab("Runs");

    const marker = declaredMarker(cycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    await clickBoundaryBadgeAndAssertNavigateThenBlink(
      badge!,
      `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
    );

    // The containing cr-group is now expanded — the row is really inside it.
    const crGroupAfter = Array.from(
      history().querySelectorAll<HTMLElement>('[data-testid="cr-group"]'),
    ).find((g) => g.getAttribute("data-cr") === "CR-025-HISTORY-INV-1");
    expect(crGroupAfter).toBeDefined();
    const row = crGroupAfter!.querySelector<HTMLElement>(
      `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
    );
    expect(row).not.toBeNull();
  });
});

// ── re-click resets the clock — single indicator, never two ────────────────

describe("§S2 boundary-to-cycle — re-click resets the blink clock (single indicator)", () => {
  test("re-clicking boundary-to-cycle within the 10s window clears the pending timer and schedules a fresh one — never two overlapping blink timers, never two blinking targets", async () => {
    const key = "cr025-reclick-1";
    const now = Date.now();
    const cycleId = 8701;
    const linkedRun = runEvent({
      id: "evt-cr025-reclick-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9104,
      cr: "CR-025-RECLICK-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Reclick" })],
      events: [linkedRun],
      plans: [plan],
    });
    await clickTab("Runs");

    const marker = declaredMarker(cycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nextHandle = 1;
    const scheduled = new Map<number, () => void>();
    const clearedHandles: number[] = [];

    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 10_000) {
        const handle = nextHandle++;
        scheduled.set(handle, () => fn(...args));
        return handle as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(fn as TimerHandler, delay as number | undefined, ...args);
    }) as typeof setTimeout;
    (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((
      handle: unknown,
    ) => {
      if (typeof handle === "number" && scheduled.has(handle)) {
        clearedHandles.push(handle);
        scheduled.delete(handle);
        return;
      }
      return originalClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout;

    try {
      const targetSelector = `[data-testid="cycle-row"][data-cycle-id="${cycleId}"]`;

      badge!.click();
      await settle();
      expect(scheduled.size).toBe(1);
      const firstHandle = [...scheduled.keys()][0]!;
      const target = document.querySelector<HTMLElement>(targetSelector);
      expect(target).not.toBeNull();
      const blinkOnClasses = Array.from(target!.classList);

      // Single indicator — exactly one element in the whole document carries
      // every one of the blink-added classes right now.
      const matchesAllBlinkClasses = (el: Element) =>
        blinkOnClasses.every((c) => el.classList.contains(c));
      expect(
        Array.from(document.querySelectorAll("*")).filter(matchesAllBlinkClasses).length,
      ).toBe(1);

      // Re-click the SAME badge before the first timer fires.
      badge!.click();
      await settle();

      // The clock reset: the old handle was cleared, and a NEW one is the
      // only thing still pending (never two live timers at once).
      expect(clearedHandles).toContain(firstHandle);
      expect(scheduled.size).toBe(1);
      expect(scheduled.has(firstHandle)).toBe(false);

      // Still a single indicator after the re-click — no doubling up.
      expect(
        Array.from(document.querySelectorAll("*")).filter(matchesAllBlinkClasses).length,
      ).toBe(1);

      // Flush the one remaining (second) timer — the blink class clears.
      const remaining = [...scheduled.values()];
      for (const cb of remaining) cb();
      await settle();

      const refreshed = document.querySelector<HTMLElement>(targetSelector);
      expect(refreshed).not.toBeNull();
      // The blink-added classes are gone — proves the (second) timer's
      // clear actually ran (mirrors the C1 diff-length technique).
      const blinkOffClasses = Array.from(refreshed!.classList);
      expect(blinkOffClasses.length).toBeLessThan(blinkOnClasses.length);
      expect(
        Array.from(document.querySelectorAll("*")).filter(matchesAllBlinkClasses).length,
      ).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

// ── stopPropagation — badge click never bubbles to the marker body ─────────

describe("§S2 boundary-to-cycle — stopPropagation (no accordion bubble)", () => {
  test("clicking boundary-to-cycle does NOT bubble a click event up to the declared-marker body (stopPropagation) — the future §S2b accordion body handler must never fire from this click", async () => {
    const key = "cr025-stoppropagation-1";
    const now = Date.now();
    const cycleId = 8801;
    const linkedRun = runEvent({
      id: "evt-cr025-stoppropagation-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9105,
      cr: "CR-025-STOPPROP-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 StopProp" })],
      events: [linkedRun],
      plans: [plan],
    });
    await clickTab("Runs");

    const marker = declaredMarker(cycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    let bodyBubbleCount = 0;
    // A bubble-phase listener attached directly to the marker (independent
    // of whatever onclick production wires there) — if the badge's handler
    // calls stopPropagation, this NEVER fires from a badge click.
    marker.addEventListener("click", () => {
      bodyBubbleCount += 1;
    });

    badge!.click();
    await settle();

    expect(bodyBubbleCount).toBe(0);
  });
});

// ── heuristic marker is untouched — no badge, body drill-in unchanged ──────

describe("§S2 boundary-to-cycle — heuristic RED➜GREEN marker unaffected", () => {
  test("a heuristic RED➜GREEN transition marker (planless project) carries NO boundary-to-cycle badge; its whole-body click still opens the GREEN run's drill-in exactly as before", async () => {
    const key = "cr025-heuristic-1";
    const t0 = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    const redId = "evt-cr025-heuristic-red";
    const greenId = "evt-cr025-heuristic-green";
    const redEvt = runEvent({
      id: redId,
      projectKey: key,
      agentId: "CR-025-HEUR-1-RED",
      timestamp: t0,
      total: 5,
      passed: 3,
      failed: 2,
    });
    const greenEvt = runEvent({
      id: greenId,
      projectKey: key,
      agentId: "CR-025-HEUR-1-GREEN",
      timestamp: t0 + 45_000,
      total: 5,
      passed: 5,
      failed: 0,
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Heuristic" })],
      events: [redEvt, greenEvt],
      // Deliberately NO plans — a planless project keeps the CR-007 §S2
      // streak heuristic byte-identical (CR-CRU-026 §S3.4); any plan at all
      // would suppress the heuristic entirely.
      plans: [],
    });
    await clickTab("Runs");

    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(1);
    const marker = markers[0] as HTMLElement;
    expect(marker.querySelector('[data-testid="boundary-to-cycle"]')).toBeNull();

    marker.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/${greenId}`);
  });
});

// ── badge shape at the CR-023 660px pane floor ─────────────────────────────

describe("§S2 boundary-to-cycle — badge shape (CR-023 660px pane floor)", () => {
  test("the boundary-to-cycle badge renders unwrapped/unclipped (white-space: nowrap, flex-shrink: 0) via CSS source-assertion — same technique as §S1's cycle-to-runs", async () => {
    const key = "cr025-badge-shape-inverse-1";
    const now = Date.now();
    const cycleId = 8901;
    const linkedRun = runEvent({
      id: "evt-cr025-badge-shape-inverse-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9106,
      cr: "CR-025-SHAPE-INV-1",
      projectKey: key,
      status: "open",
      cycles: [
        {
          id: cycleId,
          label:
            "an extremely long declared cycle label meant to force truncation of the marker text at the CR-023 660px pane floor",
          status: "done",
        },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Shape Inverse" })],
      events: [linkedRun],
      plans: [plan],
    });
    await clickTab("Runs");

    const marker = declaredMarker(cycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    const badgeRuleText = Array.from(badge!.classList)
      .map((c) => ruleBody(`.${c}`))
      .filter((r): r is string => r !== undefined)
      .join("\n");
    expect(badgeRuleText).toMatch(/white-space\s*:\s*nowrap/);
    expect(badgeRuleText).toMatch(/flex-shrink\s*:\s*0/);
  });
});
