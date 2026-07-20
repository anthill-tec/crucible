// CR-CRU-025 §S1 (+ the §S0 no-hijack rule) — Cycle row → Runs boundary.
//
// RED phase: NONE of this exists yet against current production. Today
// `CycleRow` (public/app.js ~1947, the ACTIVE-section per-cycle row) renders
// no click affordance at all; `LensCycleRow` (~2152, the HISTORY row) wires
// its OWN `[data-testid="cycle-toggle"]` glyph to the linked-runs drill-down
// and nothing else; `DeclaredMarkerRow` (~729, the Runs-timeline `Cycle
// done` boundary) carries no `data-cycle-id` and no blink machinery at all.
// This file pins the GREEN contract this RED chooses (naturally read off
// the CR text + existing testid/attribute conventions in this codebase):
//   - `[data-testid="cycle-to-runs"]` — the NEW trailing affordance on a
//     COMPLETED cycle row (active-section `cycle-row` AND history
//     `lens-cycle-row` alike). A SEPARATE element from any existing click
//     target (§S0 — never a rebinding).
//   - `[data-testid="declared-marker"][data-cycle-id="<id>"]` — the Runs
//     boundary now carries the cycle id it was declared for, so navigation
//     can match `by cycleId` (mirrors the existing `data-run-id`/`data-cr`
//     attribute convention already used elsewhere in this file family).
//   - Clicking `cycle-to-runs` sets the ONE-RULE workspace tab swap to
//     "Runs" (same mechanism the `workspace-tab` buttons already use —
//     `state.workspaceTab = "Runs"`, NOT a `navigate()` pathname change),
//     calls `scrollIntoView()` on the matching `declared-marker`, and adds
//     a blink marker CSS class to it that a JS timer removes after exactly
//     10s (per the CR text: "CSS animation with a JS-cleared marker class").
//     The blink timer is asserted by intercepting `setTimeout` calls
//     scheduled with delay `10_000` and manually flushing them — never a
//     real 10s sleep.
//   - A completed cycle whose declared boundary is pruned (no linked run
//     event survives on the retained timeline) renders `cycle-to-runs`
//     disabled/dim and inert on click.
//   - Badge-shape (CR-023 660px pane floor): the badge's own CSS
//     class(es) must declare `white-space: nowrap` + `flex-shrink: 0` in
//     public/styles.css (source-assertion technique — same one
//     tests/cycle-timers.test.ts's §S6 item-2 pin already established,
//     since happy-dom performs no real layout/cascade); the row LABEL
//     (`.app-cycle-text`) is the thing that gets `text-overflow: ellipsis`.
//
// Harness: same happy-dom + real `public/app.js`/`public/app-logic.mjs`
// pattern as tests/workflow-lens.test.ts and
// tests/timeline-plan-integration.test.ts (reused near-verbatim).
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
// §S4 badge-shape source-assertion — same technique tests/cycle-timers.test.ts
// (§S6 item 2) already established: happy-dom has no real CSS cascade, so a
// `getComputedStyle` assertion always reads empty
// (tests/coverage-trend-geometry.test.ts documents the same caveat). The
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
  context?: { cycleId?: number; wave?: string; cycle?: string };
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
      throw new Error(`cycle-run-navigation.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?cycleRunNav=${cacheBust}`);

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

async function openWorkflowTab(): Promise<void> {
  await clickTab("Workflow");
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

// Shared assertion for AC1 + AC2 — clicking the NEW `cycle-to-runs`
// affordance must (a) land on the Runs tab (the one-rule `workspaceTab`
// swap, not a `navigate()` pathname change), (b) `scrollIntoView` the
// matching `declared-marker` (matched by `data-cycle-id`), and (c) apply a
// blink marker CSS class that a JS-scheduled 10s timer removes — verified
// by intercepting `setTimeout(fn, 10_000)` calls and flushing them by hand
// (never a real 10s sleep, per the dispatch's explicit sanction).
async function clickBadgeAndAssertNavigateThenBlink(
  badge: HTMLElement,
  cycleId: number,
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
      // Never actually schedule the real 10s callback — it is flushed by
      // hand below once we've captured the "blink ON" state.
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(fn as TimerHandler, delay as number | undefined, ...args);
  }) as typeof setTimeout;

  try {
    expect(isActiveTab("Runs")).toBe(false);
    badge.click();
    await settle();

    // (a) — one-rule tab swap landed on Runs.
    expect(isActiveTab("Runs")).toBe(true);
    expect(document.querySelector('[data-testid="workspace-runs"]')).not.toBeNull();

    const marker = document.querySelector<HTMLElement>(
      `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
    );
    expect(marker).not.toBeNull();

    // (b) — scrolled into view.
    expect(scrollCalls).toContain(marker!);

    // A 10s blink-clear timer must have been scheduled.
    expect(pendingBlinkClears.length).toBeGreaterThan(0);
    const blinkOnClasses = Array.from(marker!.classList);

    // (c) — flush the 10s timer(s); the blink class(es) must be GONE
    // afterwards (re-query in case the reactive re-render swapped nodes).
    const toRun = pendingBlinkClears.splice(0, pendingBlinkClears.length);
    for (const cb of toRun) cb();
    await settle();

    const refreshedMarker = document.querySelector<HTMLElement>(
      `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
    );
    expect(refreshedMarker).not.toBeNull();
    const blinkOffClasses = Array.from(refreshedMarker!.classList);
    expect(blinkOffClasses.length).toBeLessThan(blinkOnClasses.length);
    for (const c of blinkOffClasses) expect(blinkOnClasses).toContain(c);
  } finally {
    (HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }).scrollIntoView =
      originalScrollIntoView;
    globalThis.setTimeout = originalSetTimeout;
  }
}

// ── AC1 — active-section done cycle row → Runs boundary ────────────────────

describe("§S1 cycle-to-runs — ACTIVE section", () => {
  test("a done cycle row in the ACTIVE section carries data-testid=\"cycle-to-runs\"; clicking it lands on the Runs tab with the matching Cycle-done boundary (by cycleId) scrolled into view and blinking for exactly 10s (fake-timer flush)", async () => {
    const key = "cr025-active-1";
    const now = Date.now();
    const cycleId = 501;
    const linkedRun = runEvent({
      id: "evt-cr025-active-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9001,
      cr: "CR-025-ACTIVE-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Active" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = activeSection().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="done"]',
    );
    expect(row).not.toBeNull();

    const badge = row!.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();

    await clickBadgeAndAssertNavigateThenBlink(badge!, cycleId);
  });
});

// ── AC2 — history done cycle row → Runs boundary, body click untouched ─────

describe("§S1/§S0 cycle-to-runs — HISTORY section (existing drill-down survives)", () => {
  test("same from a HISTORY cycle row (inside an expanded group); clicking the row's existing cycle-toggle still toggles its linked-runs drill-down exactly as before — no rebinding", async () => {
    const key = "cr025-history-1";
    const now = Date.now();
    const cycleId = 601;
    const linkedRun = runEvent({
      id: "evt-cr025-history-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9002,
      cr: "CR-025-HISTORY-1",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "cr025hist1" },
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 History" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const hist = history();
    const crGroup = Array.from(
      hist.querySelectorAll<HTMLElement>('[data-testid="cr-group"]'),
    ).find((g) => g.getAttribute("data-cr") === "CR-025-HISTORY-1");
    expect(crGroup).toBeDefined();
    const crToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(crToggle).not.toBeNull();
    crToggle!.click();
    await settle();

    const row = crGroup!.querySelector<HTMLElement>(
      '[data-testid="lens-cycle-row"][data-status="done"]',
    );
    expect(row).not.toBeNull();

    // §S0 — the NEW affordance is a SEPARATE element from the row's
    // existing `cycle-toggle` drill-down glyph.
    const cycleToggle = row!.querySelector<HTMLElement>('[data-testid="cycle-toggle"]');
    expect(cycleToggle).not.toBeNull();
    const badge = row!.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();
    expect(badge).not.toBe(cycleToggle);

    // The row's EXISTING body click (the cycle-toggle) still opens the
    // linked-runs drill-down exactly as before (CR-020 §S2) — untouched by
    // this CR's navigation feature.
    expect(row!.querySelector('[data-testid="cycle-span-closed"]')).toBeNull();
    cycleToggle!.click();
    await settle();
    const closedSpan = row!.querySelector('[data-testid="cycle-span-closed"]');
    expect(closedSpan).not.toBeNull();
    const linkedRow = closedSpan!.querySelector('[data-testid="linked-run-row"]');
    expect(linkedRow).not.toBeNull();
    expect(linkedRow!.getAttribute("data-run-id")).toBe("evt-cr025-history-run-1");

    // Now drive the NEW badge — separately, and it must still navigate
    // (proving it is not merely a second handle on the SAME toggle).
    await clickBadgeAndAssertNavigateThenBlink(badge!, cycleId);
  });
});

// ── AC3 — pruned boundary: dim/disabled, never a dead click ────────────────

describe("§S1 cycle-to-runs — pruned boundary (past retention)", () => {
  test("a completed cycle whose boundary is pruned (no declared marker survives on the retained timeline) renders cycle-to-runs disabled/dim; clicking it does nothing", async () => {
    const key = "cr025-pruned-1";
    const cycleId = 777;
    const plan: PlanFixture = {
      planId: 9003,
      cr: "CR-025-PRUNED-1",
      projectKey: key,
      status: "open",
      // Deliberately NO event anywhere references context.cycleId === 777 —
      // simulates its declared marker having aged out of the retained
      // Runs timeline.
      cycles: [{ id: cycleId, label: "pruned cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Pruned" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = activeSection().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="done"]',
    );
    expect(row).not.toBeNull();
    const badge = row!.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();

    const isDisabled =
      badge!.hasAttribute("disabled") ||
      badge!.getAttribute("aria-disabled") === "true" ||
      /disabled|dim/i.test(badge!.className);
    expect(isDisabled).toBe(true);

    // Never a dead click — no tab switch, no Runs pane, nothing scrolled.
    expect(isActiveTab("Runs")).toBe(false);
    const scrollCalls: HTMLElement[] = [];
    const originalScrollIntoView = (
      HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }
    ).scrollIntoView;
    (HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void }).scrollIntoView =
      function (this: HTMLElement) {
        scrollCalls.push(this);
      };
    try {
      badge!.click();
      await settle();
      expect(isActiveTab("Runs")).toBe(false);
      expect(document.querySelector('[data-testid="workspace-runs"]')).toBeNull();
      expect(scrollCalls.length).toBe(0);
    } finally {
      (HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }).scrollIntoView =
        originalScrollIntoView;
    }
  });
});

// ── AC4 — badge shape at the CR-023 660px pane floor ───────────────────────

describe("§S1 cycle-to-runs — badge shape (CR-023 660px pane floor)", () => {
  test("the cycle-to-runs affordance renders unwrapped/unclipped (white-space: nowrap, no flex-shrink) — the row LABEL truncates (ellipsis), never the badge (styles.css source-assertion technique)", async () => {
    const key = "cr025-badge-shape-1";
    const plan: PlanFixture = {
      planId: 9004,
      cr: "CR-025-SHAPE-1",
      projectKey: key,
      status: "open",
      cycles: [
        {
          id: 55,
          label:
            "an extremely long cycle label meant to force truncation of the row text at the CR-023 660px pane floor",
          status: "done",
        },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR025 Shape" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = activeSection().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="done"]',
    );
    expect(row).not.toBeNull();

    const badge = row!.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();

    const badgeRuleText = Array.from(badge!.classList)
      .map((c) => ruleBody(`.${c}`))
      .filter((r): r is string => r !== undefined)
      .join("\n");
    expect(badgeRuleText).toMatch(/white-space\s*:\s*nowrap/);
    expect(badgeRuleText).toMatch(/flex-shrink\s*:\s*0/);

    // The row LABEL — not the badge — is what truncates.
    const label = row!.querySelector<HTMLElement>(".app-cycle-text");
    expect(label).not.toBeNull();
    const labelRule = ruleBody(".app-cycle-text");
    expect(labelRule ?? "").toMatch(/text-overflow\s*:\s*ellipsis/);
  });
});
