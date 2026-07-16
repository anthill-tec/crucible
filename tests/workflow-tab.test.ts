// CR-CRU-011 C3 — §S3 Workflow tab: the ACTIVE view (per-CR todo view over
// the open cycle plan), the gate-pane placeholder, and the CR-016 pane-state
// bindings (one-rule, tabs-hide, `← workflow` back chip). The HISTORY lens
// (Wave -> [Track] -> CR -> Cycle) is C4 — out of scope here.
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/inpane-drill-in.test.ts / tests/inpane-
// liveness.test.ts: real VanJS/VanX vendor bundles, real public/app-
// logic.mjs, real public/app.js; `fetch` is scripted, including the
// project-scoped plans endpoint (GET /api/v2/projects/<key>/plans) the C1
// server API already serves (src/v2.ts:638 handlePlansList).
//
// RED phase: expected to fail against CURRENT production, whose
// public/app-logic.mjs TAB_NAMES is `["Runs","Coverage","Compile","BDD"]`
// (no "Workflow" entry) and whose public/app.js WorkspaceBody() ternary has
// no "Workflow" branch — every test below that looks for a "Workflow" tab
// button fails at `expect(tab).toBeDefined()` for that single production
// reason.
//
// Cycle-status glyph note: the CR text ("cycles as todo rows with their
// statuses (pending / active ▶ / done ✓ / skipped / failed ✗)") gives
// explicit literal glyphs ONLY for active/done/failed. pending/skipped carry
// no mandated literal, so this file pins those two structurally — a
// `data-status`/`cycle-status-<status>` pair distinguishing them from each
// other and from the three literal glyphs — rather than inventing an
// unspecified character.
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

// The real poll interval is a hard-coded 5000ms (public/app.js:153). Wait
// comfortably past it before asserting on a poll-driven liveness update.
const POLL_INTERVAL_MS = 5000;
const POLL_WAIT_MS = POLL_INTERVAL_MS + 700;
const POLL_TEST_TIMEOUT_MS = 15_000;

interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: { message?: string };
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
  // CR-CRU-011 §S0 run linkage — verbatim passthrough per src/v2.ts:717.
  context?: { cycleId?: number };
}
interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  latestCoverageEventId?: string;
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
  status: "open" | "closed";
  track?: string;
  cycles: CycleFixture[];
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventBriefFixture[];
  eventDetails: Record<string, EventDetailFixture>;
  plans: PlanFixture[];
}

let cacheBust = 0;

/**
 * Same mountApp harness pattern as tests/inpane-liveness.test.ts (event
 * detail depth=suites/suite= progressive fetch, live `opts.*` reads so a
 * test can mutate `opts.events` in place after mount for the poll-tick
 * liveness technique), extended with the C1 project-scoped plans endpoint.
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
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails[id];
      if (detail === undefined) {
        throw new Error(`workflow-tab.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = (detail.tree ?? []).find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = (detail.tree ?? []).map((n) => ({ name: n.name, status: n.status }));
        body = { ok: true, event: { ...detail, tree } };
      } else {
        body = { ok: true, event: detail };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`workflow-tab.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowTab=${cacheBust}`);

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

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").trim() === text,
  ) as HTMLElement | undefined;
}

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

function runFixture(
  eventId: string,
  projectKey: string,
  agentId: string,
  now: number,
  cycleId?: number,
): { detail: EventDetailFixture; brief: EventBriefFixture } {
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId,
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    summary: { total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 50 },
    tree: [
      {
        name: "SuiteOnly",
        status: "pass",
        children: [
          { name: "a", status: "pass", duration_ms: 5 },
          { name: "b", status: "pass", duration_ms: 5 },
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
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 50,
    hasCoverage: false,
    ...(cycleId !== undefined ? { context: { cycleId } } : {}),
  };
  return { detail, brief };
}

async function openWorkflowTab(): Promise<HTMLElement> {
  const tab = findByText(document, '[data-testid="workspace-tab"]', "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
  expect(tab!.classList.contains("on")).toBe(true);
  return tab!;
}

// ── Wiring smoke test — the Workflow tab button exists and is clickable ────

describe("Workflow tab — DOM wiring", () => {
  test("a 'Workflow' workspace-tab button exists (position 2, after Runs) and becomes the active tab on click", async () => {
    const key = "wf-wiring-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Wiring Project" })],
      events: [],
      eventDetails: {},
      plans: [],
    });

    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      "Runs",
      "Workflow",
      "Coverage",
      "Compile",
      "BDD",
    ]);

    await openWorkflowTab();
  });
});

// ── Active workflow view — per-CR todo view over the open plan ────────────

describe("Workflow tab — ACTIVE view: per-CR todo view over the open plan", () => {
  test("renders one cycle-row per cycle with status glyphs (active ▶ / done ✓ / failed ✗ literal; pending/skipped structurally distinct), and expands ONLY the active cycle to show its context.cycleId-linked runs", async () => {
    const key = "wf-active-1";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 101,
      cr: "CR-X-1",
      status: "open",
      cycles: [
        { id: 1, label: "C1 red", status: "pending" },
        { id: 2, label: "C2 green", status: "active" },
        { id: 3, label: "C3 verify", status: "done" },
        { id: 4, label: "C4 fix", status: "skipped" },
        { id: 5, label: "C5 regression", status: "failed" },
      ],
    };
    // Two runs linked to the ACTIVE cycle (id 2); one linked to the DONE
    // cycle (id 3) — proves the expansion is active-only, not "any cycle
    // with linked runs".
    const activeRun1 = runFixture("evt-wf-active-1", key, "agent-a", now, 2);
    const activeRun2 = runFixture("evt-wf-active-2", key, "agent-b", now + 10, 2);
    const doneRun = runFixture("evt-wf-done-1", key, "agent-c", now + 20, 3);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Active View Project" })],
      events: [activeRun1.brief, activeRun2.brief, doneRun.brief],
      eventDetails: {
        [activeRun1.detail.id]: activeRun1.detail,
        [activeRun2.detail.id]: activeRun2.detail,
        [doneRun.detail.id]: doneRun.detail,
      },
      plans: [plan],
    });

    await openWorkflowTab();

    const active = document.querySelector('[data-testid="workflow-active"]');
    expect(active).not.toBeNull();

    const rows = Array.from(active!.querySelectorAll<HTMLElement>('[data-testid="cycle-row"]'));
    expect(rows.length).toBe(5);

    function rowFor(label: string): HTMLElement {
      const row = findByText(active!, '[data-testid="cycle-row"]', label) ?? rows.find(
        (r) => (r.textContent ?? "").includes(label),
      );
      expect(row).toBeDefined();
      return row!;
    }

    const pendingRow = rowFor("C1 red");
    const activeRow = rowFor("C2 green");
    const doneRow = rowFor("C3 verify");
    const skippedRow = rowFor("C4 fix");
    const failedRow = rowFor("C5 regression");

    expect(pendingRow.getAttribute("data-status")).toBe("pending");
    expect(activeRow.getAttribute("data-status")).toBe("active");
    expect(doneRow.getAttribute("data-status")).toBe("done");
    expect(skippedRow.getAttribute("data-status")).toBe("skipped");
    expect(failedRow.getAttribute("data-status")).toBe("failed");

    // bound: class carries the status too (per-status styling contract).
    expect(pendingRow.className).toContain("status-pending");
    expect(activeRow.className).toContain("status-active");
    expect(doneRow.className).toContain("status-done");
    expect(skippedRow.className).toContain("status-skipped");
    expect(failedRow.className).toContain("status-failed");

    function glyphOf(row: HTMLElement): string {
      const g = row.querySelector('[data-testid="cycle-glyph"]');
      expect(g).not.toBeNull();
      return (g!.textContent ?? "").trim();
    }

    // Literal glyphs given verbatim by the CR text.
    expect(glyphOf(activeRow)).toBe("▶");
    expect(glyphOf(doneRow)).toBe("✓");
    expect(glyphOf(failedRow)).toBe("✗");
    // pending/skipped: no literal specified — structurally distinct from
    // each other and from the three literal glyphs above (bound).
    const pendingGlyph = glyphOf(pendingRow);
    const skippedGlyph = glyphOf(skippedRow);
    expect(pendingGlyph.length).toBeGreaterThan(0);
    expect(skippedGlyph.length).toBeGreaterThan(0);
    expect(pendingGlyph).not.toBe(skippedGlyph);
    for (const g of [pendingGlyph, skippedGlyph]) {
      expect(["▶", "✓", "✗"]).not.toContain(g);
    }

    // ONLY the active cycle (id 2) is expanded: exactly 2 linked-run-rows,
    // both nested under the active row, with none under the done row (even
    // though the done row also has a linked run in this fixture).
    const allLinkedRows = active!.querySelectorAll('[data-testid="linked-run-row"]');
    expect(allLinkedRows.length).toBe(2);
    const linkedUnderActive = activeRow.querySelectorAll('[data-testid="linked-run-row"]');
    expect(linkedUnderActive.length).toBe(2);
    const linkedIds = Array.from(linkedUnderActive).map((el) => el.getAttribute("data-run-id"));
    expect(linkedIds.sort()).toEqual(["evt-wf-active-1", "evt-wf-active-2"].sort());
    expect(doneRow.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);
  });

  test(
    "a linked run ingested AFTER mount appears in the expanded active cycle without reload (poll-tick liveness)",
    async () => {
      const key = "wf-live-1";
      const now = Date.now();
      const plan: PlanFixture = {
        planId: 102,
        cr: "CR-X-2",
        status: "open",
        cycles: [{ id: 7, label: "C1 red-green", status: "active" }],
      };
      const firstRun = runFixture("evt-wf-live-1", key, "agent-a", now, 7);

      const opts: MountOpts = {
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Live Active View Project" })],
        events: [firstRun.brief],
        eventDetails: { [firstRun.detail.id]: firstRun.detail },
        plans: [plan],
      };
      await mountApp(opts);
      await openWorkflowTab();

      const active = document.querySelector('[data-testid="workflow-active"]')!;
      expect(active.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(1);

      // "ingest a new run" — mutate the SAME fixture object the mocked
      // fetch reads live (same technique as tests/inpane-liveness.test.ts).
      const secondRun = runFixture("evt-wf-live-2", key, "agent-b", now + 5000, 7);
      opts.events.push(secondRun.brief);
      opts.eventDetails[secondRun.detail.id] = secondRun.detail;

      await waitForPollTick();

      const activeAfter = document.querySelector('[data-testid="workflow-active"]')!;
      const linkedAfter = activeAfter.querySelectorAll('[data-testid="linked-run-row"]');
      expect(linkedAfter.length).toBe(2);
      const ids = Array.from(linkedAfter).map((el) => el.getAttribute("data-run-id"));
      expect(ids).toContain("evt-wf-live-2");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test("with NO open plan, the active section renders an empty-state naming the plan API", async () => {
    const key = "wf-empty-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "No Plan Project" })],
      events: [],
      eventDetails: {},
      plans: [],
    });

    await openWorkflowTab();

    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    expect((body!.textContent ?? "").toLowerCase()).toContain("no open plan");
    // bound: no cycle rows render when there is nothing to show.
    expect(document.querySelectorAll('[data-testid="cycle-row"]').length).toBe(0);
  });
});

// ── Gate pane placeholder (honest — names CR-013, never CR-CRU-007) ───────

describe("Workflow tab — gate-pane placeholder beside the active view", () => {
  test("a gate-pane element is present, names CR-013, and never the stale CR-CRU-007 placeholder", async () => {
    const key = "wf-gate-1";
    const plan: PlanFixture = {
      planId: 103,
      cr: "CR-X-3",
      status: "open",
      cycles: [{ id: 9, label: "C1", status: "active" }],
    };
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Pane Project" })],
      events: [],
      eventDetails: {},
      plans: [plan],
    });

    await openWorkflowTab();

    const gate = document.querySelector('[data-testid="gate-pane"]');
    expect(gate).not.toBeNull();
    const gateText = gate!.textContent ?? "";
    expect(gateText).toContain("CR-013");
    expect(gateText).not.toContain("CR-CRU-007");
  });

  test("the gate-pane renders even with no open plan (beside the empty-state active section)", async () => {
    const key = "wf-gate-2";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Pane No-Plan Project" })],
      events: [],
      eventDetails: {},
      plans: [],
    });

    await openWorkflowTab();

    const gate = document.querySelector('[data-testid="gate-pane"]');
    expect(gate).not.toBeNull();
    expect(gate!.textContent ?? "").toContain("CR-013");
  });
});

// ── CR-016 bindings — clicking a linked run swaps the WORKFLOW pane ───────

describe("Workflow tab — CR-016 bindings: clicking a linked run swaps the WORKFLOW pane to the run detail", () => {
  function fixtureWithOneActiveLinkedRun(key: string, now: number) {
    const plan: PlanFixture = {
      planId: 104,
      cr: "CR-X-4",
      status: "open",
      cycles: [{ id: 11, label: "C1", status: "active" }],
    };
    const run = runFixture("evt-wf-bind-1", key, "agent-a", now, 11);
    return { plan, run };
  }

  test("clicking the linked-run-row swaps the WORKFLOW pane to the detail: workspace-tabs absent, back chip '← workflow', no tab switch", async () => {
    const key = "wf-bind-1";
    const now = Date.now();
    const { plan, run } = fixtureWithOneActiveLinkedRun(key, now);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR-016 Binding Project" })],
      events: [run.brief],
      eventDetails: { [run.detail.id]: run.detail },
      plans: [plan],
    });

    await openWorkflowTab();

    expect(document.querySelector('[data-testid="workspace-tabs"]')).not.toBeNull();

    const linkedRow = document.querySelector('[data-testid="linked-run-row"]') as HTMLElement | null;
    expect(linkedRow).not.toBeNull();
    linkedRow!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/${run.detail.id}`);
    // ONE RULE — tabs row absent while the detail is open (same contract as
    // every other tab: CR-CRU-016 §S1 tabs-hide).
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();

    const backChip = findByText(document, "button, a", "← workflow");
    expect(backChip).toBeDefined();

    // The Workflow active view/gate-pane are replaced by the detail (no
    // forced switch to Runs, no double-render of the todo view).
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();
  });

  test("closing via the back chip restores the Workflow pane with its tab 'on' and the exact prior scroll position", async () => {
    const key = "wf-bind-2";
    const now = Date.now();
    const { plan, run } = fixtureWithOneActiveLinkedRun(key, now);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR-016 Binding Close-Chip Project" })],
      events: [run.brief],
      eventDetails: { [run.detail.id]: run.detail },
      plans: [plan],
    });

    await openWorkflowTab();

    const paneBefore = document.querySelector('[data-testid="workspace-body"]')!
      .firstElementChild as HTMLElement;
    expect(paneBefore).not.toBeNull();
    paneBefore.scrollTop = 175;

    const linkedRow = document.querySelector('[data-testid="linked-run-row"]') as HTMLElement;
    linkedRow.click();
    await settle();

    const backChip = findByText(document, "button, a", "← workflow");
    expect(backChip).toBeDefined();
    backChip!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    const tabsRow = document.querySelector('[data-testid="workspace-tabs"]');
    expect(tabsRow).not.toBeNull();
    const workflowTab = findByText(document, '[data-testid="workspace-tab"]', "Workflow");
    expect(workflowTab).toBeDefined();
    expect(workflowTab!.classList.contains("on")).toBe(true);

    const active = document.querySelector('[data-testid="workflow-active"]');
    expect(active).not.toBeNull();

    const paneAfter = document.querySelector('[data-testid="workspace-body"]')!
      .firstElementChild as HTMLElement;
    expect(paneAfter.scrollTop).toBe(175);
  });

  test("closing via Escape restores the Workflow pane with its tab 'on'", async () => {
    const key = "wf-bind-3";
    const now = Date.now();
    const { plan, run } = fixtureWithOneActiveLinkedRun(key, now);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR-016 Binding Escape Project" })],
      events: [run.brief],
      eventDetails: { [run.detail.id]: run.detail },
      plans: [plan],
    });

    await openWorkflowTab();

    const linkedRow = document.querySelector('[data-testid="linked-run-row"]') as HTMLElement;
    linkedRow.click();
    await settle();
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    const workflowTab = findByText(document, '[data-testid="workspace-tab"]', "Workflow");
    expect(workflowTab).toBeDefined();
    expect(workflowTab!.classList.contains("on")).toBe(true);
    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();
  });
});
