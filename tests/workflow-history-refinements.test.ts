// CR-CRU-020 §S1 + §S2 — RED phase for the user's live-review history
// refinements: latest-first ordering, collapsed-by-default CR groups,
// executing-CR exclusion from history, ungrouped listing REMOVAL from the
// Workflow lens, and cycle drill-down (history + active parity) with
// state-preserving pane swap. Board fidelity: .lavish/crucible-v2-design.html
// F13 (refined 2026-07-16) + F13½ (drill-down navigation).
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/workflow-lens.test.ts / tests/workflow-
// tab.test.ts (workspace pathname, scripted `/api/v2/projects/<key>/plans`
// fetch).
//
// RED phase: expected to fail against CURRENT production, which (a) sorts
// waves oldest-first and never reorders CRs within a wave by close time
// (§S1.1), (b) renders CR groups always-expanded with no toggle at all
// (§S1.2), (c) renders an OPEN plan's CR group in history alongside closed
// ones (§S1.3), (d) auto-expands only the ACTIVE section's active cycle with
// no click-based toggle anywhere, history or active (§S2.1/§S2.2/§S2.3), and
// (e) STILL renders the C1-era `ungrouped-tail` count row in
// `workflow-history` instead of nothing at all (§S1.4 corrected — the C1
// count-row compromise was itself a mis-reading of the original ask, fixed
// at the 2026-07-16 gate review; see the §S1.4 (corrected) describe block
// below). The §S2 group-level negative bound below pins the user's SEPARATE
// gate-review defect (group expansion leaking run rows without any cycle
// toggle) as a regression, independent of whether it already happens to hold
// against the current C1 GREEN rendering.
//
// Testid/attribute contract this file introduces for GREEN (none of these
// exist yet — chosen to read naturally off the CR text and to reuse the
// EXISTING header lines rather than add new DOM structure):
//   - `[data-testid="cr-group-toggle"]` — the CR group's existing header line
//     (cr name, track badge, `cr-rollup`, `cr-merge-commit` — exactly the
//     "header row" §S1.2 keeps ALWAYS visible); click toggles the group's
//     `[data-testid="lens-cycle-row"]` children between absent and present.
//     Collapsed by default. Applies to declared AND inferred CR groups alike.
//   - `[data-testid="cycle-toggle"]` — inside EITHER a `[data-testid="cycle-
//     row"]` (the ACTIVE section) or a `[data-testid="lens-cycle-row"]`
//     (History); click toggles THAT ROW's OWN `[data-testid="linked-run-
//     row"]` descendants (and the `cycle-span-closed` wrapper for a done
//     cycle) between absent and present. Collapsed by default — identical
//     contract in both places (§S2.1/§S2.2 history, §S2.3 active parity).
//   - §S1.4 (corrected) — NO `ungrouped-tail`/`ungrouped-count`/
//     `ungrouped-toggle` element renders in `workflow-history` at all, in
//     any state. Unlinked runs remain visible on the Runs timeline
//     (`[data-testid="workspace-runs"]` → `[data-testid="event-card"]`)
//     instead — the never-hidden rule now lives there exclusively.
//   - §S1.1 ordering: waves render newest-first (wave label numeric
//     descending); within a wave, CR groups render by plan `closedAt`
//     descending. `closedAt` is a real field already returned by the server
//     (`Plan.closedAt`, src/types.ts:168) — this file's `PlanFixture` adds it
//     as an optional passthrough, not a new data-model concept.
//   - §S1.3 exclusion: a CR group whose plan `status` is "open" never
//     renders inside `[data-testid="workflow-history"]` — it renders solely
//     inside `[data-testid="workflow-active"]`. Wave-boundary-state
//     computation (existing §S3 behavior, tests/workflow-lens.test.ts) is
//     unaffected — it already infers from ALL declared plans regardless of
//     status.
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
  status: "open" | "closed";
  wave?: string;
  track?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
  // §S1.1 — real server field (Plan.closedAt), added here as a pure
  // passthrough so the ordering fixture can drive "closed later" vs "closed
  // earlier".
  closedAt?: number;
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
      throw new Error(`workflow-history-refinements.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowHistoryRefinements=${cacheBust}`);

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

function findBackChip(): HTMLElement {
  const chip = Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(
    (el) => (el.textContent ?? "").trim() === "← workflow",
  );
  expect(chip).toBeDefined();
  return chip!;
}

function paneEl(): HTMLElement {
  const el = document.querySelector('[data-testid="workspace-body"]')!.firstElementChild as HTMLElement;
  expect(el).not.toBeNull();
  return el;
}

// ── §S1.1 — latest-first ordering ──────────────────────────────────────────

describe("§S1.1 history ordering — latest-first (waves, then CR groups within a wave)", () => {
  test("wave 4 renders above wave 3 (both closed); within wave 5, the CR closed later renders above the one closed earlier", async () => {
    const key = "hist-ord-1";
    const t0 = Date.now() - 60 * 60 * 1000;

    const planWave3: PlanFixture = {
      planId: 701,
      cr: "CR-ORD-3",
      status: "closed",
      wave: "3",
      closedAt: t0,
      merge: { commit: "w3commit" },
      cycles: [{ id: 1, label: "c", status: "done" }],
    };
    const planWave4: PlanFixture = {
      planId: 702,
      cr: "CR-ORD-4",
      status: "closed",
      wave: "4",
      closedAt: t0 + 1000,
      merge: { commit: "w4commit" },
      cycles: [{ id: 2, label: "c", status: "done" }],
    };
    // Input array order deliberately puts the EARLIER-closed CR first —
    // current production preserves plan input order (no time-based sort at
    // all), so this only passes once GREEN actually sorts by closedAt desc.
    const planWave5Early: PlanFixture = {
      planId: 703,
      cr: "CR-ORD-5A",
      status: "closed",
      wave: "5",
      closedAt: t0 + 2000,
      merge: { commit: "w5aCommit" },
      cycles: [{ id: 3, label: "c", status: "done" }],
    };
    const planWave5Late: PlanFixture = {
      planId: 704,
      cr: "CR-ORD-5B",
      status: "closed",
      wave: "5",
      closedAt: t0 + 5000,
      merge: { commit: "w5bCommit" },
      cycles: [{ id: 4, label: "c", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Ordering Project" })],
      events: [],
      plans: [planWave3, planWave4, planWave5Early, planWave5Late],
    });
    await openWorkflowTab();

    const hist = history();
    const waveGroups = Array.from(hist.querySelectorAll<HTMLElement>('[data-testid="wave-group"]'));
    expect(waveGroups.map((g) => g.getAttribute("data-wave"))).toEqual(["5", "4", "3"]);

    const wave5 = waveGroups.find((g) => g.getAttribute("data-wave") === "5")!;
    const crGroups = Array.from(wave5.querySelectorAll<HTMLElement>('[data-testid="cr-group"]'));
    expect(crGroups.map((g) => g.getAttribute("data-cr"))).toEqual(["CR-ORD-5B", "CR-ORD-5A"]);
  });
});

// ── §S1.2 — collapsed-by-default CR groups, toggle on click ───────────────

describe("§S1.2 history CR groups — collapsed by default, toggle on click", () => {
  test("a history CR group mounts with its cycle rows ABSENT; clicking the header row renders them; a second click removes them again — the header row (rollup, merge pill) stays visible throughout", async () => {
    const key = "hist-collapse-1";
    const plan: PlanFixture = {
      planId: 711,
      cr: "CR-COL-1",
      status: "closed",
      wave: "1",
      merge: { commit: "colCommit1" },
      cycles: [
        { id: 10, label: "c1", status: "done" },
        { id: 11, label: "c2", status: "done" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Collapse Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>('[data-testid="cr-group"][data-cr="CR-COL-1"]');
    expect(crGroup).not.toBeNull();

    // Header row content is visible immediately, with no click required.
    const rollup = crGroup!.querySelector('[data-testid="cr-rollup"]');
    expect(rollup).not.toBeNull();
    expect((rollup!.textContent ?? "")).toContain("2/2");
    const merge = crGroup!.querySelector('[data-testid="cr-merge-commit"]');
    expect(merge).not.toBeNull();
    expect((merge!.textContent ?? "")).toContain("colCommit1");

    // Collapsed by default — no cycle rows mounted at all.
    expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(0);

    const toggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(toggle).not.toBeNull();

    toggle!.click();
    await settle();
    expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(2);

    toggle!.click();
    await settle();
    expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(0);

    // Header row is unaffected by the toggle either way.
    expect((crGroup!.querySelector('[data-testid="cr-rollup"]')!.textContent ?? "")).toContain("2/2");
  });
});

// ── §S1.3 — executing CR excluded from history; PATCH-close moves it live ─

describe("§S1.3 executing-CR exclusion — open plan lives only in Active; closing moves it to History without reload", () => {
  test("with plan A open and plan B closed, history holds exactly one CR group (B); PATCHing A closed moves A's group into history on the next poll tick", async () => {
    const key = "hist-exclude-1";
    const planA: PlanFixture = {
      planId: 721,
      cr: "CR-EXC-A",
      status: "open",
      wave: "1",
      cycles: [{ id: 20, label: "c1", status: "active" }],
    };
    const planB: PlanFixture = {
      planId: 722,
      cr: "CR-EXC-B",
      status: "closed",
      wave: "1",
      merge: { commit: "excCommitB" },
      cycles: [{ id: 21, label: "c1", status: "done" }],
    };

    const opts: MountOpts = {
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Exclusion Project" })],
      events: [],
      plans: [planA, planB],
    };
    await mountApp(opts);
    await openWorkflowTab();

    const histBefore = history();
    const crGroupsBefore = histBefore.querySelectorAll<HTMLElement>('[data-testid="cr-group"]');
    expect(crGroupsBefore.length).toBe(1);
    expect(crGroupsBefore[0]!.getAttribute("data-cr")).toBe("CR-EXC-B");
    expect(histBefore.querySelector('[data-testid="cr-group"][data-cr="CR-EXC-A"]')).toBeNull();

    // The open CR shows up in Active instead.
    expect((active().textContent ?? "")).toContain("CR-EXC-A");

    // PATCH plan A closed — mutate the SAME fixture object the mocked fetch
    // reads live (same technique as tests/workflow-tab.test.ts poll-tick).
    planA.status = "closed";
    planA.merge = { commit: "excCommitA" };
    planA.cycles = [{ id: 20, label: "c1", status: "done" }];

    await waitForPollTick();

    const histAfter = history();
    const crGroupsAfter = Array.from(histAfter.querySelectorAll<HTMLElement>('[data-testid="cr-group"]'));
    expect(crGroupsAfter.map((g) => g.getAttribute("data-cr")).sort()).toEqual([
      "CR-EXC-A",
      "CR-EXC-B",
    ]);
    const crAAfter = crGroupsAfter.find((g) => g.getAttribute("data-cr") === "CR-EXC-A")!;
    expect(crAAfter.getAttribute("data-status")).toBe("closed");

    // Active no longer lists the now-closed CR.
    expect((active().textContent ?? "")).not.toContain("CR-EXC-A");
  }, POLL_TEST_TIMEOUT_MS);
});

// ── §S1.4 — ungrouped tail demoted to a count-only row ─────────────────────

// CR-CRU-020 §S1.4 CORRECTED (2026-07-16 gate-review defect, C3) — the
// count-row compromise below (`ungrouped-tail`/`ungrouped-count`/
// `ungrouped-toggle`) was a mis-reading of the original ask; the user
// corrected it at the gate: the Workflow view renders plan/cycle structure
// ONLY — no ungrouped run listing of ANY form, not even a collapsed count
// row. Unlinked runs remain fully visible on the Runs timeline instead (the
// never-hidden rule now lives there, not in the Workflow lens).
describe("§S1.4 (corrected) — ungrouped listing REMOVED from Workflow entirely; unlinked runs stay visible on the Runs timeline", () => {
  test("5 unlinked runs render NO ungrouped element (tail/count/toggle) and ZERO run entries anywhere in workflow-history; the same 5 runs render as event-cards on the Runs timeline", async () => {
    const key = "hist-ungrouped-removed-1";
    const t0 = Date.now() - 500_000;
    const runs: EventFixture[] = Array.from({ length: 5 }, (_, i) =>
      runEvent({
        id: `evt-ungrouped-removed-${i}`,
        projectKey: key,
        agentId: `solo-agent-${i}`,
        timestamp: t0 + i * 1000,
      }),
    );

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Ungrouped Removal Project" })],
      events: runs,
      plans: [],
    });

    // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
    // defaults to the Workflow pane, not Runs (workspace default flips) —
    // this test's SUBJECT is the Runs timeline's unlinked-run visibility, so
    // it now selects the Runs tab EXPLICITLY after mount before checking it.
    // Was: "Default tab is Runs — all 5 runs are cards there BEFORE ever
    // touching the Workflow tab."
    const runsTabInitial = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => (t.textContent ?? "").trim() === "Runs");
    expect(runsTabInitial).toBeDefined();
    runsTabInitial!.click();
    await settle();

    // Runs tab selected explicitly — all 5 runs are cards there BEFORE ever
    // touching the Workflow tab.
    const runsPaneBefore = document.querySelector<HTMLElement>('[data-testid="workspace-runs"]');
    expect(runsPaneBefore).not.toBeNull();
    for (const r of runs) {
      expect(runsPaneBefore!.querySelectorAll(`[data-run-id="${r.id}"]`).length).toBe(1);
    }

    await openWorkflowTab();

    const hist = history();
    // No ungrouped element of ANY form.
    expect(hist.querySelector('[data-testid="ungrouped-tail"]')).toBeNull();
    expect(hist.querySelector('[data-testid="ungrouped-count"]')).toBeNull();
    expect(hist.querySelector('[data-testid="ungrouped-toggle"]')).toBeNull();
    expect((hist.textContent ?? "").toLowerCase()).not.toContain("ungrouped");

    // Zero run entries anywhere in workflow-history — nothing to expand into,
    // since these runs have no plan/cycle linkage at all.
    expect(hist.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);
    expect(hist.querySelectorAll('[data-run-id]').length).toBe(0);

    // The 5 runs are STILL fully visible — just on the Runs timeline, never
    // dropped anywhere.
    const runsTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => (t.textContent ?? "").trim() === "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();

    const runsPaneAfter = document.querySelector<HTMLElement>('[data-testid="workspace-runs"]');
    expect(runsPaneAfter).not.toBeNull();
    expect(runsPaneAfter!.querySelectorAll('[data-testid="event-card"]').length).toBe(5);
    for (const r of runs) {
      expect(runsPaneAfter!.querySelectorAll(`[data-run-id="${r.id}"]`).length).toBe(1);
    }
  });
});

// CR-CRU-020 §S2 group-level negative bound (2026-07-16 gate-review defect,
// C3) — the user's live-review defect report: expanding a CR group showed
// raw run rows (agentIds CR-CRU-019-GREEN / CR-CRU-019-CLOSE) at GROUP level
// without any cycle toggle. Pinned here as a regression with the user's
// exact two-done-cycles-both-linked-with-runs shape: the group toggle alone
// must reveal cycle rows ONLY, never a single run-id-bearing row anywhere in
// the group, until the SPECIFIC cycle's own toggle is clicked.
describe("§S2 group-level negative bound — expanding a CR group alone renders cycle rows only; ZERO run entries anywhere in the group until a cycle's OWN toggle is clicked", () => {
  test("a closed CR group with two done cycles, both carrying linked runs: group-toggle-only expansion shows the two cycle rows and not a single run row anywhere in the group; clicking one cycle's own toggle reveals ONLY that cycle's run — the sibling cycle stays run-free", async () => {
    const key = "hist-group-leak-1";
    const now = Date.now();
    const greenRun = runEvent({
      id: "evt-CR-CRU-019-GREEN",
      projectKey: key,
      agentId: "CR-CRU-019-GREEN",
      timestamp: now - 20_000,
      context: { cycleId: 90 },
    });
    const closeRun = runEvent({
      id: "evt-CR-CRU-019-CLOSE",
      projectKey: key,
      agentId: "CR-CRU-019-CLOSE",
      timestamp: now,
      context: { cycleId: 91 },
    });
    const plan: PlanFixture = {
      planId: 751,
      cr: "CR-CRU-019",
      status: "closed",
      wave: "1",
      merge: { commit: "leakCommit19" },
      cycles: [
        { id: 90, label: "C1 green", status: "done" },
        { id: 91, label: "close", status: "done" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Group Leak Project" })],
      events: [greenRun, closeRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-CRU-019"]',
    );
    expect(crGroup).not.toBeNull();

    // Collapsed by default (§S1.2) — expand the GROUP ONLY, no cycle toggle.
    expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(0);
    const crToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(crToggle).not.toBeNull();
    crToggle!.click();
    await settle();

    const cycleRows = Array.from(
      crGroup!.querySelectorAll<HTMLElement>('[data-testid="lens-cycle-row"]'),
    );
    expect(cycleRows.length).toBe(2);

    // The user's exact defect: group-level expansion alone must NEVER
    // surface either linked run — not as `linked-run-row`, not as any
    // `[data-run-id]` element, anywhere under the group.
    expect(crGroup!.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);
    expect(crGroup!.querySelectorAll('[data-run-id]').length).toBe(0);
    expect(crGroup!.textContent ?? "").not.toContain("CR-CRU-019-GREEN");
    expect(crGroup!.textContent ?? "").not.toContain("CR-CRU-019-CLOSE");

    // Click ONE cycle's own toggle (cycle 90, "C1 green") — ONLY that
    // cycle's run appears; the sibling cycle (91, "close") stays run-free.
    const cycle90Row = cycleRows.find((r) => (r.textContent ?? "").includes("C1 green"));
    const cycle91Row = cycleRows.find((r) => (r.textContent ?? "").includes("close"));
    expect(cycle90Row).toBeDefined();
    expect(cycle91Row).toBeDefined();

    const cycle90Toggle = cycle90Row!.querySelector<HTMLElement>('[data-testid="cycle-toggle"]');
    expect(cycle90Toggle).not.toBeNull();
    cycle90Toggle!.click();
    await settle();

    const cycle90Runs = cycle90Row!.querySelectorAll<HTMLElement>('[data-testid="linked-run-row"]');
    expect(cycle90Runs.length).toBe(1);
    expect(cycle90Runs[0]!.getAttribute("data-run-id")).toBe("evt-CR-CRU-019-GREEN");

    // The sibling cycle is STILL untouched — zero runs, its own toggle not
    // yet clicked.
    expect(cycle91Row!.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);

    // Total run-id-bearing rows in the WHOLE group is exactly 1 — only the
    // toggled cycle's — never both.
    expect(crGroup!.querySelectorAll('[data-run-id]').length).toBe(1);
  });
});

// ── §S2.1/§S2.2 — history cycle row toggle + drill-in, state-preserving close

describe("§S2.1/§S2.2 history cycle drill-down — toggle linked runs, drill into the detail, close restores expanded state + scroll", () => {
  test("clicking a history cycle row expands its linked runs; clicking a run entry drills into the Workflow pane's detail state; closing restores the SAME expanded groups and the SAME scroll position", async () => {
    const key = "hist-drill-1";
    const now = Date.now();
    const linkedRun = runEvent({
      id: "evt-hist-drill-1",
      projectKey: key,
      agentId: "agent-drill",
      timestamp: now,
      context: { cycleId: 50 },
    });
    const plan: PlanFixture = {
      planId: 731,
      cr: "CR-DRILL-H",
      status: "closed",
      wave: "1",
      merge: { commit: "drillHCommit" },
      cycles: [{ id: 50, label: "c1", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "History Drill Project" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    // Expand the CR group (§S1.2) to reach the cycle row.
    const crGroup = history().querySelector<HTMLElement>('[data-testid="cr-group"][data-cr="CR-DRILL-H"]')!;
    const crToggle = crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!;
    crToggle.click();
    await settle();

    const cycleRow = crGroup.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    expect(cycleRow).not.toBeNull();

    // The cycle row itself starts collapsed — its own linked runs are hidden
    // even though the CR group is already expanded (§S2.1, a DISTINCT toggle
    // level from §S1.2's CR-group collapse).
    expect(cycleRow.querySelector('[data-testid="cycle-span-closed"]')).toBeNull();
    expect(cycleRow.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);

    const cycleToggle = cycleRow.querySelector<HTMLElement>('[data-testid="cycle-toggle"]')!;
    expect(cycleToggle).not.toBeNull();
    cycleToggle.click();
    await settle();

    const closedSpan = cycleRow.querySelector('[data-testid="cycle-span-closed"]');
    expect(closedSpan).not.toBeNull();
    const linkedRow = closedSpan!.querySelector<HTMLElement>('[data-testid="linked-run-row"]');
    expect(linkedRow).not.toBeNull();
    expect(linkedRow!.getAttribute("data-run-id")).toBe("evt-hist-drill-1");

    // Set a distinctive scroll position before drilling in.
    paneEl().scrollTop = 222;

    linkedRow!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/evt-hist-drill-1`);
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    findBackChip();

    findBackChip().click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    expect(document.querySelector('[data-testid="workspace-tabs"]')).not.toBeNull();

    // Risk clause — the CR group AND the cycle row are STILL expanded (state
    // survives the pane swap, not merely the route).
    const crGroupAfter = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-DRILL-H"]',
    )!;
    expect(crGroupAfter.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(1);
    const cycleRowAfter = crGroupAfter.querySelector<HTMLElement>('[data-testid="lens-cycle-row"]')!;
    expect(cycleRowAfter.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(1);

    // And the exact prior scroll position is intact (CR-016 one-rule).
    expect(paneEl().scrollTop).toBe(222);
  });
});

// ── §S2.3 — ACTIVE section parity ──────────────────────────────────────────

describe("§S2.3 active-cycle drill-down parity — same toggle + drill-down technique as history", () => {
  test("the ACTIVE section's active cycle row toggles its linked runs and drills into the detail identically to a history cycle row; closing preserves the expanded state", async () => {
    const key = "active-drill-1";
    const now = Date.now();
    const linkedRun = runEvent({
      id: "evt-active-drill-1",
      projectKey: key,
      agentId: "agent-active-drill",
      timestamp: now,
      context: { cycleId: 60 },
    });
    const plan: PlanFixture = {
      planId: 741,
      cr: "CR-DRILL-A",
      status: "open",
      cycles: [{ id: 60, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Active Drill Project" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const cycleRow = active().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="active"]',
    )!;
    expect(cycleRow).not.toBeNull();

    // Collapsed by default — parity with history (§S2.3), NOT the old
    // auto-expand-when-active behavior.
    expect(cycleRow.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);

    const cycleToggle = cycleRow.querySelector<HTMLElement>('[data-testid="cycle-toggle"]')!;
    expect(cycleToggle).not.toBeNull();
    cycleToggle.click();
    await settle();

    const linkedRow = cycleRow.querySelector<HTMLElement>('[data-testid="linked-run-row"]');
    expect(linkedRow).not.toBeNull();
    expect(linkedRow!.getAttribute("data-run-id")).toBe("evt-active-drill-1");

    linkedRow!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/evt-active-drill-1`);
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    findBackChip();

    findBackChip().click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    const cycleRowAfter = active().querySelector<HTMLElement>(
      '[data-testid="cycle-row"][data-status="active"]',
    )!;
    expect(cycleRowAfter.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(1);
  });
});
