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
import { singleReleaseHistoryStub } from "./helpers/history-stub";

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
    if (/\/api\/v2\/projects\/[^/]+\/history/.test(url)) {
      // CR-CRU-173 cycle 637 re-pin (user ruling 2026-10-09, approved): History
      // nests its waves under a release, read from GET …/history; this
      // fixture's plans fall in one release (tests/helpers/history-stub.ts).
      body = singleReleaseHistoryStub(opts.plans ?? []);
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
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

function active(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-active"]');
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

  // CR-CRU-146 AC1, by name: "Clicking the history cycle row — on its LABEL,
  // on its status glyph, on the `▸ N runs` hint, and on empty space in the
  // line — opens that cycle's linked runs. Asserted at several x-offsets
  // across the row". Each of those four named targets is clicked in turn, from
  // a CLOSED row, and each must open it. The status glyph (`.app-cycle-glyph`)
  // is NOT the `cycle-toggle` chevron the test above closes with; it is the
  // separate cycle-status symbol. "Empty space in the line" is a click
  // dispatched AT `.app-cycle-line` itself, so the event target is the line
  // and no child. HONEST LIMIT: happy-dom does no layout or hit-testing, so
  // this harness cannot aim a click at a pixel x-offset. The four targets ARE
  // the row's distinct horizontal positions (status glyph at the left, then
  // the label, the hint, and the line's own trailing space), and each is its
  // own DOM target. That proves one line-level handler owns the whole row, not
  // a narrow per-child hit area. A synthetic `clientX` would change nothing
  // here, so none is faked.
  test("CR-CRU-146 AC1 — clicking the row on its LABEL, its status glyph, its '▸ N runs' hint, and empty space in the line each opens the cycle's linked runs", async () => {
    const key = "row-toggle-targets-1";
    const linkedRun = runEvent({
      id: "evt-row-toggle-targets-1",
      projectKey: key,
      agentId: "agent-row-toggle-targets",
      timestamp: Date.now(),
      context: { cycleId: 904 },
    });
    const plan: PlanFixture = {
      planId: 9104,
      cr: "CR-ROWTOGGLE-5",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "rowToggleCommit5" },
      cycles: [{ id: 904, label: "row-toggle cycle 5", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Row Toggle Project 5" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-ROWTOGGLE-5"]',
    )!;
    expect(crGroup).not.toBeNull();
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const currentRow = (): HTMLElement => {
      const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]');
      expect(row).not.toBeNull();
      return row!;
    };
    const targets: Array<[string, (row: HTMLElement) => Element | null]> = [
      ["label (.app-cycle-label)", (row) => row.querySelector(".app-cycle-label")],
      ["status glyph (.app-cycle-glyph)", (row) => row.querySelector(".app-cycle-glyph")],
      ["'▸ N runs' hint (.app-run-count-hint)", (row) => row.querySelector(".app-run-count-hint")],
      ["empty space in the line (.app-cycle-line itself)", (row) => row.querySelector(".app-cycle-line")],
    ];

    for (const [name, find] of targets) {
      const row = currentRow();
      // Precondition for every "opens on click" claim: the row starts CLOSED.
      expect(row.querySelector('[data-testid="cycle-span-closed"]'), `${name}: row must start closed`).toBeNull();
      const target = find(row);
      expect(target, `${name}: target must render on the closed row`).not.toBeNull();
      clickAt(target!);
      await settle();

      const openSpan = currentRow().querySelector('[data-testid="cycle-span-closed"]');
      expect(openSpan, `clicking the ${name} must open the cycle's linked runs`).not.toBeNull();
      expect(
        openSpan!.querySelector('[data-testid="linked-run-row"]')?.getAttribute("data-run-id"),
      ).toBe("evt-row-toggle-targets-1");

      // Close again through the label (a proven toggle, above) so the NEXT
      // target also starts from a closed row.
      clickAt(currentRow().querySelector(".app-cycle-label")!);
      await settle();
      expect(currentRow().querySelector('[data-testid="cycle-span-closed"]')).toBeNull();
    }
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

// CR-CRU-146 §S2 — "the affordance is honest at a glance": a toggleable
// cycle line must carry `.app-lens-toggle`, the SAME class the CR-group
// row already uses for its own full-row toggle (`public/styles.css`'s
// `.app-lens-toggle { cursor: pointer; user-select: none; }`), and a line
// with no toggle must NOT carry it. Today `CycleLine` (public/app.js) never
// applies the class at all — `toggle === null ? { class: "app-cycle-line" }
// : { class: "app-cycle-line", onclick: toggle }` — so every assertion below
// that expects the class to be PRESENT is RED against current production;
// the assertions that expect it ABSENT already pass (there is nothing to
// regress there, which is the point: the class must track the handler, not
// the section).
describe("CR-CRU-146 §S2 — a toggleable cycle line carries .app-lens-toggle, a non-toggleable one does not", () => {
  test("an expandable HISTORY cycle row's .app-cycle-line carries app-lens-toggle", async () => {
    const key = "lens-toggle-class-history-1";
    const linkedRun = runEvent({
      id: "evt-lens-toggle-class-history-1",
      projectKey: key,
      agentId: "agent-lens-toggle-class-history",
      timestamp: Date.now(),
      context: { cycleId: 950 },
    });
    const plan: PlanFixture = {
      planId: 9500,
      cr: "CR-LENSTOGGLECLASS-1",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "lensToggleClassCommit1" },
      cycles: [{ id: 950, label: "toggle-class expandable cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Lens Toggle Class Project 1" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-LENSTOGGLECLASS-1"]',
    )!;
    expect(crGroup).not.toBeNull();
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    expect(row).not.toBeNull();
    // Sanity: this row IS the expandable one this test cares about — it has
    // its own drill-down glyph, so a false pass from a non-expandable row
    // slipping in unnoticed is ruled out.
    expect(row.querySelector('[data-testid="cycle-toggle"]')).not.toBeNull();

    const line = row.querySelector<HTMLElement>(".app-cycle-line")!;
    expect(line).not.toBeNull();
    expect(line.classList.contains("app-lens-toggle")).toBe(true);
  });

  test("the ACTIVE section's open cycle row (no toggle, ruling (a)) — its .app-cycle-line does NOT carry app-lens-toggle", async () => {
    const key = "lens-toggle-class-active-1";
    const plan: PlanFixture = {
      planId: 9501,
      cr: "CR-LENSTOGGLECLASS-2",
      projectKey: key,
      status: "open",
      wave: "1",
      cycles: [{ id: 951, label: "toggle-class active cycle", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Lens Toggle Class Project 2" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = active().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="active"]',
    )!;
    expect(row).not.toBeNull();

    const line = row.querySelector<HTMLElement>(".app-cycle-line")!;
    expect(line).not.toBeNull();
    expect(line.classList.contains("app-lens-toggle")).toBe(false);
  });

  test("a HISTORY cycle row that is NOT expandable (no toggle handler) — its .app-cycle-line does NOT carry app-lens-toggle either, so the class tracks the handler, not the section", async () => {
    const key = "lens-toggle-class-history-2";
    const plan: PlanFixture = {
      planId: 9502,
      cr: "CR-LENSTOGGLECLASS-3",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "lensToggleClassCommit3" },
      // "skipped" is neither "done" nor "active" — LensCycleRow's own
      // `expandable` predicate is false, so CycleLine is called with `null`
      // (no toggle, no linked runs to drill into).
      cycles: [{ id: 952, label: "toggle-class skipped cycle", status: "skipped" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Lens Toggle Class Project 3" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-LENSTOGGLECLASS-3"]',
    )!;
    expect(crGroup).not.toBeNull();
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    expect(row).not.toBeNull();
    // Confirms this row really has no toggle handler at all (the glyph
    // itself is absent) — so a class present here would be a class
    // completely detached from any handler, the exact drift the AC forbids.
    expect(row.querySelector('[data-testid="cycle-toggle"]')).toBeNull();

    const line = row.querySelector<HTMLElement>(".app-cycle-line")!;
    expect(line).not.toBeNull();
    expect(line.classList.contains("app-lens-toggle")).toBe(false);
  });

  test("the element carrying .app-lens-toggle is the SAME element that carries the click handler — clicking the line (by class) opens the cycle's linked runs", async () => {
    const key = "lens-toggle-class-history-3";
    const linkedRun = runEvent({
      id: "evt-lens-toggle-class-history-3",
      projectKey: key,
      agentId: "agent-lens-toggle-class-history-3",
      timestamp: Date.now(),
      context: { cycleId: 953 },
    });
    const plan: PlanFixture = {
      planId: 9503,
      cr: "CR-LENSTOGGLECLASS-4",
      projectKey: key,
      status: "closed",
      wave: "1",
      merge: { commit: "lensToggleClassCommit4" },
      cycles: [{ id: 953, label: "toggle-class handler-parity cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Lens Toggle Class Project 4" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-LENSTOGGLECLASS-4"]',
    )!;
    crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    const row = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    const line = row.querySelector<HTMLElement>(".app-cycle-line")!;
    expect(line).not.toBeNull();
    // Precondition: the class is on THIS node.
    expect(line.classList.contains("app-lens-toggle")).toBe(true);
    // Starts collapsed.
    expect(row.querySelector('[data-testid="cycle-span-closed"]')).toBeNull();

    // Click dispatched AT the exact node found BY the class, not at some
    // other descendant — if the handler ever lived on a different node than
    // the one carrying the class (a second hit-area mechanism), this click
    // would be a no-op and the span would never open.
    clickAt(line);
    await settle();

    const closedSpan = row.querySelector('[data-testid="cycle-span-closed"]');
    expect(closedSpan).not.toBeNull();
    expect(
      closedSpan!.querySelector('[data-testid="linked-run-row"]')?.getAttribute("data-run-id"),
    ).toBe("evt-lens-toggle-class-history-3");
  });
});
