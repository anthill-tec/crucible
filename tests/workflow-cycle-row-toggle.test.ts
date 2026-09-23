// CR-CRU-018 §S1 (Workflow, DN decision 11) — the history cycle row is
// implemented ONCE. This is the SAME hit area CR-CRU-146 fixes
// (docs/changes/CR-CRU-146-the-cycle-row-is-not-clickable-but-looks-it.md);
// measured 2026-09-23, CR-CRU-146 has NOT landed — `grep onclick public/app.js`
// around `LensCycleRow` shows exactly one handler, on the 13x20px
// `[data-testid="cycle-toggle"]` glyph (`.app-cycle-toggle`), and NONE on the
// row's own line (`.app-cycle-line`) or its label (`.app-cycle-label`).
//
// This file asserts the CR's own wording: "a test proves a single handler
// owns the row" — written so that EITHER CR (whichever lands first) is
// proven by it, and a SECOND handler coexisting with the glyph's (the
// "two independent collapse implementations on one region" defect CR-018's
// own §S1 text names for the pane-collapse case, and CR-146's Problem section
// names for this exact row) reds it too: clicking the LABEL must open the
// span, and once open, clicking the GLYPH must be the SAME toggle (closes
// it) — two independent per-target toggle states would leave one of those
// two clicks a no-op instead of a state flip.
//
// Harness: the SAME happy-dom + real public/app.js/public/app-logic.mjs
// mounting pattern as tests/workflow-history-refinements.test.ts and
// tests/cycle-run-navigation.test.ts (reused near-verbatim) — `cycle.runs`
// is populated by the shell itself from the `events` fixture's
// `context.cycleId`, never embedded on the plan fixture directly.
//
// RED phase — expected to fail against current production: `.app-cycle-
// label` and `.app-cycle-line` carry no `onclick` at all, so a click
// dispatched directly at them does nothing and the span never opens.
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
  status: "open" | "closed" | "aborted";
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
      throw new Error(`workflow-cycle-row-toggle.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowCycleRowToggle=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
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

async function openWorkflowTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function history(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(el).not.toBeNull();
  return el!;
}

// Dispatches a REAL click event AT the given element specifically — a
// `.click()` call synthesizes the click ON that node (it does not simulate
// hitting a descendant), so a listener bound only to a different node (the
// glyph, today) never fires from this. That is the whole test: production's
// only handler sits on the glyph, so a click dispatched at the LABEL proves
// nothing moved unless the handler now lives somewhere the label's click
// bubbles through.
function clickAt(el: Element): void {
  (el as HTMLElement).click();
}

describe("CR-CRU-018 §S1 / CR-CRU-146 — the history cycle row's hit area is owned by exactly ONE handler", () => {
  test("clicking the row's LABEL (not the 13px toggle glyph) opens the cycle's linked runs — the row's line is the toggle", async () => {
    const key = "row-toggle-label-1";
    const linkedRun = runEvent({
      id: "evt-row-toggle-label-1",
      projectKey: key,
      agentId: "agent-row-toggle",
      timestamp: Date.now(),
      context: { cycleId: 900 },
    });
    const plan: PlanFixture = {
      planId: 9100,
      cr: "CR-ROWTOGGLE-1",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "rowToggleCommit1" },
      cycles: [{ id: 900, label: "row-toggle cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Row Toggle Project" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-ROWTOGGLE-1"]',
    )!;
    expect(crGroup).not.toBeNull();
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    expect(row).not.toBeNull();
    // Starts collapsed — the precondition every "opens on click" claim needs.
    expect(row.querySelector('[data-testid="cycle-span-closed"]')).toBeNull();

    const label = row.querySelector<HTMLElement>(".app-cycle-label")!;
    expect(label).not.toBeNull();
    clickAt(label);
    await settle();

    const closedSpan = row.querySelector('[data-testid="cycle-span-closed"]');
    expect(closedSpan).not.toBeNull();
    expect(
      closedSpan!.querySelector('[data-testid="linked-run-row"]')?.getAttribute("data-run-id"),
    ).toBe("evt-row-toggle-label-1");
  });

  test("clicking the row's label again closes it — the label click is a real toggle, not a one-way open", async () => {
    const key = "row-toggle-label-2";
    const linkedRun = runEvent({
      id: "evt-row-toggle-label-2",
      projectKey: key,
      agentId: "agent-row-toggle-2",
      timestamp: Date.now(),
      context: { cycleId: 901 },
    });
    const plan: PlanFixture = {
      planId: 9101,
      cr: "CR-ROWTOGGLE-2",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "rowToggleCommit2" },
      cycles: [{ id: 901, label: "row-toggle cycle 2", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Row Toggle Project 2" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-ROWTOGGLE-2"]',
    )!;
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    const label = row.querySelector<HTMLElement>(".app-cycle-label")!;

    clickAt(label);
    await settle();
    expect(row.querySelector('[data-testid="cycle-span-closed"]')).not.toBeNull();

    clickAt(label);
    await settle();
    expect(row.querySelector('[data-testid="cycle-span-closed"]')).toBeNull();
  });

  test("ONE shared toggle state owns the row: opening via the label and closing via the glyph agree — two independent handlers would leave one of these clicks a no-op", async () => {
    const key = "row-toggle-cross-1";
    const linkedRun = runEvent({
      id: "evt-row-toggle-cross-1",
      projectKey: key,
      agentId: "agent-row-toggle-cross",
      timestamp: Date.now(),
      context: { cycleId: 902 },
    });
    const plan: PlanFixture = {
      planId: 9102,
      cr: "CR-ROWTOGGLE-3",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "rowToggleCommit3" },
      cycles: [{ id: 902, label: "row-toggle cycle 3", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Row Toggle Project 3" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-ROWTOGGLE-3"]',
    )!;
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    const label = row.querySelector<HTMLElement>(".app-cycle-label")!;

    // Open via the LABEL (the new contract).
    clickAt(label);
    await settle();
    expect(row.querySelector('[data-testid="cycle-span-closed"]')).not.toBeNull();

    // Close via the GLYPH (today's only handler). If a naive fix left the
    // OLD glyph handler wired to its OWN, separate open/close flag instead
    // of retargeting it to the SAME row-level state, this click would either
    // do nothing (two states, glyph's own already "closed") or double-toggle
    // back to open — either way the row stays open here, not closed.
    const glyph = row.querySelector<HTMLElement>('[data-testid="cycle-toggle"]')!;
    expect(glyph).not.toBeNull();
    clickAt(glyph);
    await settle();
    expect(row.querySelector('[data-testid="cycle-span-closed"]')).toBeNull();
  });

  test("the → Runs badge inside the row still performs its own navigation and does NOT toggle the row (stopPropagation carve-out, non-regression)", async () => {
    const key = "row-toggle-badge-1";
    const linkedRun = runEvent({
      id: "evt-row-toggle-badge-1",
      projectKey: key,
      agentId: "agent-row-toggle-badge",
      timestamp: Date.now(),
      context: { cycleId: 903 },
    });
    const plan: PlanFixture = {
      planId: 9103,
      cr: "CR-ROWTOGGLE-4",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "rowToggleCommit4" },
      cycles: [{ id: 903, label: "row-toggle cycle 4", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Row Toggle Project 4" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-ROWTOGGLE-4"]',
    )!;
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    const badge = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]')!;
    expect(badge).not.toBeNull();

    badge.click();
    await settle();

    // The badge's OWN job (jump to Runs) fired instead of the row toggle —
    // asserted via the one-rule workspace tab swap it uses.
    const runsTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => (t.textContent ?? "").trim() === "Runs");
    expect(runsTab?.className).toMatch(/\bon\b/);
    // …and the row itself did NOT open as a side effect of that click.
    expect(row.querySelector('[data-testid="cycle-span-closed"]')).toBeNull();
  });
});
