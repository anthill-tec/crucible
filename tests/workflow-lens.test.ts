// CR-CRU-011 C4 — §S3 history lens: Wave → [Track] → CR → Cycle hierarchy,
// declared-plan first with inferred fallback, wave-boundary states, and the
// ungrouped tail. The ACTIVE view (per-CR todo + gate pane) is C3 — out of
// scope here (see tests/workflow-tab.test.ts).
//
// RED phase: expected to fail against CURRENT production, whose
// `[data-testid="workflow-history"]` element (public/app.js ~1206) renders
// ONLY a static placeholder div — "history lens lands in C4 of this CR" —
// with no wave/track/CR/cycle grouping elements at all.
//
// Drives the REAL production public/app.js shell inside a happy-dom window
// — same harness pattern as tests/workflow-tab.test.ts (workspace pathname,
// scripted `/api/v2/projects/<key>/plans` fetch), extended with an `agents`
// fixture (same shape as tests/agent-runtime-pane.test.ts) for the rollup
// assertions.
//
// Testid/attribute contract this file introduces for GREEN (none of these
// exist yet — this is the RED-authored contract, chosen to read naturally
// off the CR text):
//   - `[data-testid="wave-group"]` (`data-wave`, `data-source="declared"|
//     "inferred"`) — one per wave.
//   - `[data-testid="wave-header"]` — the wave group's header text, carrying
//     the wave-boundary state text/lane chips.
//   - `[data-testid="lane-chip"]` — one per track, inside the wave header,
//     while the wave is open with tracks.
//   - `[data-testid="track-group"]` (`data-track`) — ONLY when a wave holds
//     plans from >1 distinct track; absent entirely otherwise.
//   - `[data-testid="track-badge"]` — on a CR group, whenever its plan
//     carries a `track`.
//   - `[data-testid="cr-group"]` (`data-cr`, `data-status`) — one per CR.
//   - `[data-testid="cr-merge-commit"]` — on a closed CR group.
//   - `[data-testid="cr-rollup"]` — cycles done/total.
//   - `[data-testid="cr-agent-runtime"]` — one per participating agent.
//   - `[data-testid="lens-cycle-row"]` (`data-status`) — a cycle sub-item
//     under a CR group (declared OR inferred).
//   - `[data-testid="cycle-span-closed"]` — a done cycle's closed span,
//     wrapping its `[data-testid="linked-run-row"]` children.
//   - `[data-testid="ungrouped-tail"]` / `[data-testid="ungrouped-count"]` —
//     CR-CRU-020 retarget (§S1.4 corrected, gate-review defect 2026-07-16):
//     these elements are REMOVED from the Workflow lens entirely; the
//     ungrouped-runs assertion below now confirms their ABSENCE and checks
//     the Runs timeline for visibility instead (never-hidden rule moved).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

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
const V2_SRC = readFileSync(path.join(REPO_ROOT, "src/v2.ts"), "utf8");
const SERVER_SRC = readFileSync(path.join(REPO_ROOT, "src/server.ts"), "utf8");
const STORE_SRC = readFileSync(path.join(REPO_ROOT, "src/store.ts"), "utf8");

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

interface AgentFixture {
  agentId: string;
  projectKey: string;
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
  runtime_ms?: number;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
  agents?: AgentFixture[];
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
      body = { ok: true, agents: opts.agents ?? [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`workflow-lens.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowLens=${cacheBust}`);

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

// ── LENS HIERARCHY — declared-first: the tree IS the plan ─────────────────

describe("§S3 history lens — hierarchy (Wave → CR → Cycle, declared-first)", () => {
  // CR-CRU-020 retarget (§S1.2/§S1.3): both plans are now CLOSED — an open
  // plan's CR group no longer renders in history at all (§S1.3 exclusion is
  // pinned separately in tests/workflow-history-refinements.test.ts), and
  // reading a CR group's cycle rows now requires expanding it first
  // (collapsed-by-default, §S1.2), then expanding the specific cycle row to
  // reach its linked runs (§S2.1 — a distinct toggle level).
  test("renders Wave → CR → Cycle groups from a pair of CLOSED plans in the same wave; a done cycle (once expanded) renders as a closed span with its linked runs; each closed plan's merge seals its CR group with the merge commit", async () => {
    const key = "lens-hier-1";
    const now = Date.now();
    const linkedRun = runEvent({
      id: "evt-hier-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId: 1 },
    });
    const planA: PlanFixture = {
      planId: 601,
      cr: "CR-A-1",
      projectKey: "lens-hier-1",
      status: "closed",
      wave: "1",
      merge: { commit: "aaa9999" },
      cycles: [
        { id: 1, label: "c1 red-green", status: "done" },
        { id: 2, label: "c2 verify", status: "done" },
      ],
    };
    const planClosed: PlanFixture = {
      planId: 602,
      cr: "CR-B-1",
      projectKey: "lens-hier-1",
      status: "closed",
      wave: "1",
      merge: { commit: "abc1234" },
      cycles: [{ id: 3, label: "c1", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Hierarchy Project" })],
      events: [linkedRun],
      plans: [planA, planClosed],
    });
    await openWorkflowTab();

    const hist = history();
    expect(hist.textContent ?? "").not.toContain("lands in C4");

    const waveGroups = hist.querySelectorAll<HTMLElement>('[data-testid="wave-group"]');
    expect(waveGroups.length).toBe(1);
    const wave1 = waveGroups[0]!;
    expect(wave1.getAttribute("data-wave")).toBe("1");

    // single-track wave — no Track level at all.
    expect(wave1.querySelectorAll('[data-testid="track-group"]').length).toBe(0);

    const crGroups = wave1.querySelectorAll<HTMLElement>('[data-testid="cr-group"]');
    expect(crGroups.length).toBe(2);
    const crIds = Array.from(crGroups).map((g) => g.getAttribute("data-cr")).sort();
    expect(crIds).toEqual(["CR-A-1", "CR-B-1"]);

    const crA = Array.from(crGroups).find((g) => g.getAttribute("data-cr") === "CR-A-1")!;
    // §S1.2 — expand the CR group to reach its cycle rows.
    const crAToggle = crA.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(crAToggle).not.toBeNull();
    crAToggle!.click();
    await settle();

    const cycleRows = crA.querySelectorAll<HTMLElement>('[data-testid="lens-cycle-row"]');
    expect(cycleRows.length).toBe(2);
    const doneRow = Array.from(cycleRows).find((r) => r.getAttribute("data-status") === "done")!;
    expect(doneRow).toBeDefined();
    // §S2.1 — a history cycle row's OWN linked runs are a further, distinct
    // toggle level from the CR group's expand/collapse above.
    const doneRowToggle = doneRow.querySelector<HTMLElement>('[data-testid="cycle-toggle"]');
    expect(doneRowToggle).not.toBeNull();
    doneRowToggle!.click();
    await settle();

    const closedSpan = doneRow.querySelector('[data-testid="cycle-span-closed"]');
    expect(closedSpan).not.toBeNull();
    const linkedRow = closedSpan!.querySelector('[data-testid="linked-run-row"]');
    expect(linkedRow).not.toBeNull();
    expect(linkedRow!.getAttribute("data-run-id")).toBe("evt-hier-run-1");

    const crB = Array.from(crGroups).find((g) => g.getAttribute("data-cr") === "CR-B-1")!;
    expect(crB.getAttribute("data-status")).toBe("closed");
    const mergeEl = crB.querySelector('[data-testid="cr-merge-commit"]');
    expect(mergeEl).not.toBeNull();
    expect((mergeEl!.textContent ?? "")).toContain("abc1234");
  });
});

// ── TRACKS — the Track level renders ONLY for multi-track waves ──────────

describe("§S3/§S0 history lens — tracks", () => {
  // CR-CRU-020 retarget (§S1.3): plans are now CLOSED — an open plan's CR
  // group would no longer render in history at all, which would collapse
  // this test's track-level assertions to nothing. Track-level rendering
  // itself is unaffected by open/closed status, so closing the fixtures
  // (with a merge commit) keeps testing the SAME track behavior post-GREEN.
  test("two closed plans in the same wave with track:\"track-1\"/track:\"track-2\" render a Track level between Wave and CR (both groups present, CR groups badged)", async () => {
    const key = "lens-tracks-1";
    const planA: PlanFixture = {
      planId: 611,
      cr: "CR-T-1",
      projectKey: "lens-tracks-1",
      status: "closed",
      wave: "2",
      track: "track-1",
      merge: { commit: "trackACommit" },
      cycles: [{ id: 10, label: "c", status: "done" }],
    };
    const planB: PlanFixture = {
      planId: 612,
      cr: "CR-T-2",
      projectKey: "lens-tracks-1",
      status: "closed",
      wave: "2",
      track: "track-2",
      merge: { commit: "trackBCommit" },
      cycles: [{ id: 11, label: "c", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Tracks Project" })],
      events: [],
      plans: [planA, planB],
    });
    await openWorkflowTab();

    const wave2 = history().querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="2"]');
    expect(wave2).not.toBeNull();

    const trackGroups = wave2!.querySelectorAll<HTMLElement>('[data-testid="track-group"]');
    expect(trackGroups.length).toBe(2);
    const trackIds = Array.from(trackGroups).map((g) => g.getAttribute("data-track"));
    expect(trackIds.sort()).toEqual(["track-1", "track-2"]);

    for (const trackGroup of Array.from(trackGroups)) {
      const crGroup = trackGroup.querySelector('[data-testid="cr-group"]');
      expect(crGroup).not.toBeNull();
      const badge = crGroup!.querySelector('[data-testid="track-badge"]');
      expect(badge).not.toBeNull();
      expect((badge!.textContent ?? "")).toContain(trackGroup.getAttribute("data-track")!);
    }
  });

  test("a wave whose plans all lack track renders NO track level — CR groups sit directly under the wave (single-orchestrator seamlessness)", async () => {
    const key = "lens-tracks-2";
    const plan: PlanFixture = {
      planId: 613,
      cr: "CR-NT-1",
      projectKey: "lens-tracks-2",
      status: "closed",
      wave: "3",
      merge: { commit: "noTrackCommit" },
      cycles: [{ id: 12, label: "c", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "No Track Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const wave3 = history().querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="3"]');
    expect(wave3).not.toBeNull();
    expect(wave3!.querySelectorAll('[data-testid="track-group"]').length).toBe(0);

    const crGroup = wave3!.querySelector<HTMLElement>('[data-testid="cr-group"]');
    expect(crGroup).not.toBeNull();
    expect(crGroup!.querySelector('[data-testid="track-badge"]')).toBeNull();
    // bound: the CR group's nearest track-group ancestor is null — it hangs
    // directly off the wave, not a track level.
    expect(crGroup!.closest('[data-testid="track-group"]')).toBeNull();
  });

  test("track groups sort numerically, not lexicographically (track-2 before track-10)", async () => {
    const key = "lens-tracks-3";
    const planA: PlanFixture = {
      planId: 614,
      cr: "CR-T-10",
      projectKey: "lens-tracks-3",
      status: "closed",
      wave: "4",
      track: "track-10",
      merge: { commit: "track10Commit" },
      cycles: [{ id: 20, label: "c", status: "done" }],
    };
    const planB: PlanFixture = {
      planId: 615,
      cr: "CR-T-2",
      projectKey: "lens-tracks-3",
      status: "closed",
      wave: "4",
      track: "track-2",
      merge: { commit: "track2Commit" },
      cycles: [{ id: 21, label: "c", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Numeric Sort Project" })],
      events: [],
      plans: [planA, planB],
    });
    await openWorkflowTab();

    const wave4 = history().querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="4"]');
    const trackGroups = Array.from(
      wave4!.querySelectorAll<HTMLElement>('[data-testid="track-group"]'),
    );
    expect(trackGroups.map((g) => g.getAttribute("data-track"))).toEqual([
      "track-2",
      "track-10",
    ]);
  });
});

// ── WAVE STATES — inferred from plan states, no dedicated wave API ───────

describe("§S3 history lens — wave boundary states", () => {
  test("wave-1 plans all closed + no wave-2 plans → wave-1 header shows 'lanes complete · awaiting review'", async () => {
    const key = "lens-wave-1";
    const plan: PlanFixture = {
      planId: 621,
      cr: "CR-W-1",
      projectKey: "lens-wave-1",
      status: "closed",
      wave: "1",
      merge: { commit: "aaa1111" },
      cycles: [{ id: 30, label: "c", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Wave Boundary Project" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const wave1 = history().querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="1"]');
    expect(wave1).not.toBeNull();
    const header = wave1!.querySelector('[data-testid="wave-header"]');
    expect(header).not.toBeNull();
    expect((header!.textContent ?? "")).toContain("lanes complete · awaiting review");
  });

  // SANCTIONED RE-TARGET (CR-CRU-021 §S6 Chrome-gate GAP 2) — this test's
  // ORIGINAL assertion required wave 2's group to render (`wave2` not null)
  // even though wave 2 holds ONLY an open plan (CR-W-3) — exactly the shape
  // GAP 2 forbids (a wave whose only material is an open plan, its CR
  // stripped by §S1.3, must render NO wave-group at all — no ghost header).
  // Re-targeted: the SUBJECT survives (wave 1's boundary state flips to
  // "superseded" purely because a NEWER wave now holds a declared plan —
  // superseded detection reads `declaredWaveLabels` off the raw plans list,
  // independent of whether wave 2's own group renders), strengthened to a
  // POSITIVE assertion ("superseded", not just "not the old text"); wave 2
  // itself is now asserted ABSENT, which strengthens GAP 2 coverage instead
  // of duplicating tests/workflow-lens.test.ts's own dedicated GAP 2 block.
  test("filing a wave-2 plan (open-only, no visible CR) flips wave 1's boundary state to superseded — wave 2 itself renders NO group at all", async () => {
    const key = "lens-wave-2";
    const plan1: PlanFixture = {
      planId: 622,
      cr: "CR-W-2",
      projectKey: "lens-wave-2",
      status: "closed",
      wave: "1",
      merge: { commit: "bbb2222" },
      cycles: [{ id: 31, label: "c", status: "done" }],
    };
    const plan2: PlanFixture = {
      planId: 623,
      cr: "CR-W-3",
      projectKey: "lens-wave-2",
      status: "open",
      wave: "2",
      cycles: [{ id: 32, label: "c", status: "pending" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Wave Supersede Project" })],
      events: [],
      plans: [plan1, plan2],
    });
    await openWorkflowTab();

    const hist = history();
    const wave1 = hist.querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="1"]')!;
    expect(wave1).not.toBeNull();
    const header1 = wave1.querySelector('[data-testid="wave-header"]')!;
    // no longer the boundary-pause text — the newer wave superseded it.
    expect((header1.textContent ?? "")).not.toContain("lanes complete · awaiting review");
    // POSITIVE: wave 1's state now reads "superseded" (declaredWaveLabels
    // sees wave 2's plan regardless of whether wave 2's OWN group renders).
    expect((header1.textContent ?? "")).toContain("superseded");

    // GAP 2 — wave 2 holds ONLY an open plan (its CR stripped by §S1.3), so
    // it renders NO wave-group/header at all (no ghost).
    expect(hist.querySelector('[data-testid="wave-group"][data-wave="2"]')).toBeNull();
  });

  test("while any wave-1 plan is open with tracks → per-lane completion chips (track-1 closed, track-2 1-of-2 → 'track-1 ✓ · track-2 1/2')", async () => {
    const key = "lens-wave-3";
    const planClosed: PlanFixture = {
      planId: 624,
      cr: "CR-L-1",
      projectKey: "lens-wave-3",
      status: "closed",
      wave: "1",
      track: "track-1",
      merge: { commit: "ccc3333" },
      cycles: [{ id: 33, label: "c", status: "done" }],
    };
    const planOpen: PlanFixture = {
      planId: 625,
      cr: "CR-L-2",
      projectKey: "lens-wave-3",
      status: "open",
      wave: "1",
      track: "track-2",
      cycles: [
        { id: 34, label: "c1", status: "done" },
        { id: 35, label: "c2", status: "pending" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Lane Chips Project" })],
      events: [],
      plans: [planClosed, planOpen],
    });
    await openWorkflowTab();

    const wave1 = history().querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="1"]')!;
    const header = wave1.querySelector('[data-testid="wave-header"]')!;
    expect((header.textContent ?? "")).toContain("track-1 ✓ · track-2 1/2");
  });

  test("no dedicated wave API route exists in src/ — wave state is inferred from plans only", () => {
    for (const src of [V2_SRC, SERVER_SRC, STORE_SRC]) {
      expect(src).not.toMatch(/["'`]\/api\/v2\/[^"'`]*waves[^"'`]*["'`]/i);
      expect(src).not.toContain("/waves");
    }
  });
});

// ── INFERRED FALLBACK — no plan: Wave/CR/Cycle from context + agent stem ──

describe("§S3 history lens — inferred fallback (no plan)", () => {
  test("without any plan, a fixture with 2 waves × 2 CRs × 2 cycles (context.wave + agent stems + context.cycle labels) renders the inferred tree; runs lacking linkage land in an ungrouped tail with its count asserted", async () => {
    const key = "lens-fallback-1";
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    let idc = 0;
    function pair(wave: string, cr: string, cycleLabel: string): EventFixture[] {
      idc += 1;
      const ts = t0 + idc * 1000;
      const red = runEvent({
        id: `evt-fb-${idc}-red`,
        projectKey: key,
        agentId: `${cr}-RED`,
        timestamp: ts,
        total: 4,
        passed: 2,
        failed: 2,
        context: { wave, cycle: cycleLabel },
      });
      const green = runEvent({
        id: `evt-fb-${idc}-green`,
        projectKey: key,
        agentId: `${cr}-GREEN`,
        timestamp: ts + 30_000,
        total: 4,
        passed: 4,
        failed: 0,
        context: { wave, cycle: cycleLabel },
      });
      return [red, green];
    }

    const events: EventFixture[] = [
      ...pair("1", "CR-F-1", "cycle-a"),
      ...pair("1", "CR-F-1", "cycle-b"),
      ...pair("1", "CR-F-2", "cycle-a"),
      ...pair("1", "CR-F-2", "cycle-b"),
      ...pair("2", "CR-G-1", "cycle-a"),
      ...pair("2", "CR-G-1", "cycle-b"),
      ...pair("2", "CR-G-2", "cycle-a"),
      ...pair("2", "CR-G-2", "cycle-b"),
    ];
    // Ungrouped tail: runs lacking any wave/cr/cycle linkage — never dropped.
    const ungrouped1 = runEvent({
      id: "evt-ungrouped-1",
      projectKey: key,
      agentId: "solo-agent-1",
      timestamp: t0 + 500_000,
      total: 1,
      passed: 1,
    });
    const ungrouped2 = runEvent({
      id: "evt-ungrouped-2",
      projectKey: key,
      agentId: "solo-agent-2",
      timestamp: t0 + 600_000,
      total: 1,
      passed: 1,
    });
    events.push(ungrouped1, ungrouped2);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Fallback Project" })],
      events,
      plans: [],
    });
    await openWorkflowTab();

    const hist = history();
    const waveGroups = hist.querySelectorAll<HTMLElement>(
      '[data-testid="wave-group"][data-source="inferred"]',
    );
    expect(waveGroups.length).toBe(2);
    const waveIds = Array.from(waveGroups).map((g) => g.getAttribute("data-wave")).sort();
    expect(waveIds).toEqual(["1", "2"]);

    const wave1 = Array.from(waveGroups).find((g) => g.getAttribute("data-wave") === "1")!;
    const crGroups = wave1.querySelectorAll<HTMLElement>('[data-testid="cr-group"]');
    expect(crGroups.length).toBe(2);
    const crIds = Array.from(crGroups).map((g) => g.getAttribute("data-cr")).sort();
    expect(crIds).toEqual(["CR-F-1", "CR-F-2"]);

    const crF1 = Array.from(crGroups).find((g) => g.getAttribute("data-cr") === "CR-F-1")!;
    // CR-CRU-020 retarget (§S1.2) — CR groups collapse by default, declared
    // AND inferred alike; expand before reading cycle rows.
    const crF1Toggle = crF1.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(crF1Toggle).not.toBeNull();
    crF1Toggle!.click();
    await settle();
    const cycleRows = crF1.querySelectorAll('[data-testid="lens-cycle-row"]');
    expect(cycleRows.length).toBe(2);
    const cycleLabels = Array.from(cycleRows).map((r) => (r.textContent ?? "")).join(" ");
    expect(cycleLabels).toContain("cycle-a");
    expect(cycleLabels).toContain("cycle-b");

    // CR-CRU-020 retarget (§S1.4 corrected 2026-07-16 gate-review defect) —
    // this CR-011 AC ("ungrouped tail never dropped") is superseded FOR THE
    // WORKFLOW LENS by the corrected §S1.4: the ungrouped listing is REMOVED
    // from `workflow-history` entirely (no tail, no count, no toggle); the
    // never-hidden guarantee for these 2 unlinked runs is honored by the
    // Runs timeline instead, asserted there.
    expect(hist.querySelector('[data-testid="ungrouped-tail"]')).toBeNull();
    expect(hist.querySelector('[data-testid="ungrouped-count"]')).toBeNull();
    expect(hist.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);

    // bound: the ungrouped runs are never absorbed into a CR group.
    expect(hist.textContent ?? "").not.toContain("no wave/cr grouping is dropped");
    const allCrGroups = hist.querySelectorAll<HTMLElement>('[data-testid="cr-group"]');
    for (const g of Array.from(allCrGroups)) {
      expect(g.querySelector('[data-run-id="evt-ungrouped-1"]')).toBeNull();
      expect(g.querySelector('[data-run-id="evt-ungrouped-2"]')).toBeNull();
    }

    // The never-hidden rule now lives on the Runs timeline: both unlinked
    // runs are still fully visible there.
    const runsTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => (t.textContent ?? "").trim() === "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();
    const runsPane = document.querySelector<HTMLElement>('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(runsPane!.querySelectorAll('[data-run-id="evt-ungrouped-1"]').length).toBe(1);
    expect(runsPane!.querySelectorAll('[data-run-id="evt-ungrouped-2"]').length).toBe(1);
  });
});

// ── GROUP ROLLUPS — cycles done/total + participating agents + runtimes ──

describe("§S3 history lens — group rollups", () => {
  // CR-CRU-020 retarget (§S1.3) — an open plan's CR group no longer renders
  // in history at all; close the plan (with a merge commit) so the rollup /
  // agent-runtime assertions keep exercising the same rendering. The rollup
  // itself stays part of the ALWAYS-visible header (§S1.2).
  //
  // SANCTIONED RE-TARGET (CR-CRU-021 §S4, 2026-07-16) — group headers now
  // carry NO per-agent rows while collapsed; `cr-agent-runtime` renders only
  // behind the group's own expansion (the aggregate `N agents` pill takes
  // its place at header level while collapsed — see tests/aggregate-
  // headers.test.ts). This test's SUBJECT is the rollup figure + a
  // participating agent's runtime surfacing at all, not collapse timing, so
  // it now expands the group via `cr-group-toggle` before reading
  // `cr-agent-runtime` — same click-before-read pattern already used at
  // lines 648/650 and 280 in this file. Was: read `cr-agent-runtime`
  // directly off the collapsed header with no toggle click.
  test("a CR group row shows cycles done/total, and participating agents with runtimes (runtime_ms surfaces — pin presence, not exact ms)", async () => {
    const key = "lens-rollup-1";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 631,
      cr: "CR-R-1",
      projectKey: "lens-rollup-1",
      status: "closed",
      wave: "1",
      merge: { commit: "rollupCommit1" },
      cycles: [
        { id: 40, label: "c1", status: "done" },
        { id: 41, label: "c2", status: "done" },
        { id: 42, label: "c3", status: "pending" },
      ],
    };
    const linkedRun = runEvent({
      id: "evt-rollup-run-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId: 40 },
    });
    const agentFixture: AgentFixture = {
      agentId: "agent-a",
      projectKey: key,
      liveness: "online",
      lastSeen: now,
      runtime_ms: 12_345,
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Rollup Project" })],
      events: [linkedRun],
      plans: [plan],
      agents: [agentFixture],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-R-1"]',
    );
    expect(crGroup).not.toBeNull();

    // SANCTIONED RE-TARGET (CR-CRU-023 §S4 #2) — the frozen CR-020 rollup
    // assertion moves off the hidden `.app-hidden-data` compatibility span
    // (`[data-testid="cr-rollup"]`, retired by this CR) onto the VISIBLE
    // rollup form rendered inline in the group header ("<done>/<total>
    // cycles" while not all done, "<total> cycles ✓" once all done — see
    // app.js LensCrGroup). This fixture is 2 done of 3 total (not all
    // done), so the visible form matches the frozen "2/3" figure. Behavior
    // is pinned, not a specific testid's survival — GREEN may drop
    // `cr-rollup` outright or keep it as an alias on the visible form;
    // either passes this pin.
    const groupToggle = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(groupToggle).not.toBeNull();
    expect((groupToggle!.textContent ?? "")).toContain("2/3 cycles");
    // negative pin — the hidden CR-020 compatibility span is retired.
    expect(crGroup!.querySelectorAll(".app-hidden-data").length).toBe(0);

    // SANCTIONED RE-TARGET (CR-CRU-021 §S4) — per-agent runtime rows now
    // render only once the group's own header toggle is expanded.
    groupToggle!.click();
    await settle();

    const agentRuntime = crGroup!.querySelector('[data-testid="cr-agent-runtime"]');
    expect(agentRuntime).not.toBeNull();
    const runtimeText = agentRuntime!.textContent ?? "";
    expect(runtimeText).toContain("agent-a");
    // pin presence of a runtime figure, not its exact ms value.
    expect(runtimeText).toMatch(/\d/);
  });
});

// ── CR-CRU-023 §S4 #2 — retire the hidden legacy rollup span ──────────────
// The `.app-hidden-data` class (styles.css ~750-758) was a visually-hidden
// clip-rect wrapper existing ONLY to keep the CR-020 `[data-testid="cr-
// rollup"]` done/total span addressable after §S6 #9 replaced it with the
// inline dim-text rollup form. This CR retires the compatibility span
// outright — the AC requires NO `.app-hidden-data` element anywhere in the
// workflow pane DOM, whether or not `cr-rollup` itself survives as an alias
// on the visible form.
describe("§S4 #2 — no hidden `.app-hidden-data` compatibility span in the workflow pane DOM", () => {
  test("a mixed history fixture (a fully-done CR group + a partially-done CR group, both expanded) renders zero `.app-hidden-data` elements anywhere under the workflow pane", async () => {
    const key = "hidden-data-retire-1";
    const now = Date.now();
    const planAllDone: PlanFixture = {
      planId: 741,
      cr: "CR-HD-ALL-DONE",
      projectKey: "hidden-data-retire-1",
      status: "closed",
      wave: "1",
      merge: { commit: "hdAllDone1" },
      cycles: [
        { id: 60, label: "c1", status: "done" },
        { id: 61, label: "c2", status: "done" },
      ],
    };
    const planPartial: PlanFixture = {
      planId: 742,
      cr: "CR-HD-PARTIAL",
      projectKey: "hidden-data-retire-1",
      status: "closed",
      wave: "1",
      merge: { commit: "hdPartial1" },
      cycles: [
        { id: 62, label: "c1", status: "done" },
        { id: 63, label: "c2", status: "pending" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Hidden Data Retire Project" })],
      events: [],
      plans: [planAllDone, planPartial],
    });
    await openWorkflowTab();

    const allDoneGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-HD-ALL-DONE"]',
    );
    const partialGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-HD-PARTIAL"]',
    );
    expect(allDoneGroup).not.toBeNull();
    expect(partialGroup).not.toBeNull();

    // Expand both groups — the (now-retired) hidden span, when it existed,
    // rendered inside the ALWAYS-visible header row regardless of expansion,
    // so check both collapsed and expanded states.
    expect(document.querySelectorAll(".app-hidden-data").length).toBe(0);

    allDoneGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    partialGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.click();
    await settle();

    expect(document.querySelectorAll(".app-hidden-data").length).toBe(0);

    // The visible figures stay assertable, whatever GREEN does with the
    // `cr-rollup` testid itself: all-done renders "N cycles ✓", partial
    // renders "<done>/<total> cycles".
    expect((allDoneGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.textContent ?? ""))
      .toContain("2 cycles ✓");
    expect((partialGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!.textContent ?? ""))
      .toContain("1/2 cycles");
  });
});

// ── RED ADDENDUM (cycle 13, gap 2) — ghost wave-header suppression ────────
// Chrome side-by-side against F13 found a ghost `HISTORY — WAVE · running`
// header (blank label, no rows) above WAVE 4 in the live app: an open
// plan's wave group SURVIVES `workflowLens`'s output as a header-only entry
// once §S1.3 strips its (open) CR node from `wave.crs`, because the
// per-wave state computation (`declared.length > 0`) still fires on the
// PRE-strip `declared` list even though `wave.crs` itself is left empty.
// A history wave group with ZERO visible CRs must render NOTHING — no
// `wave-group` element, no header — at either layer: the pure
// `workflowLens({ plans, events })` data AND the DOM it drives.
describe("§S6 RED addendum (cycle 13, gap 2) — ghost history wave-header suppression (wave whose only material is an OPEN plan)", () => {
  test("pure workflowLens: a wave whose ONLY plan is OPEN (crs emptied by the §S1.3 strip) is ABSENT from `waves` — no header-only ghost entry", () => {
    const openOnlyWavePlan = {
      planId: 9701,
      cr: "CR-GHOST-OPEN",
      status: "open" as const,
      wave: "9",
      cycles: [{ id: 97001, label: "c1", status: "pending" as const }],
    };
    const closedWavePlan = {
      planId: 9702,
      cr: "CR-GHOST-CLOSED",
      status: "closed" as const,
      wave: "8",
      merge: { commit: "8888888" },
      cycles: [{ id: 97002, label: "c1", status: "done" as const }],
    };

    const result = AppLogic.workflowLens({
      plans: [openOnlyWavePlan, closedWavePlan],
      events: [],
    });
    const waves = result.waves as Array<{ wave: string; crs: unknown[] }>;

    expect(waves.find((w) => w.wave === "9")).toBeUndefined();
    const wave8 = waves.find((w) => w.wave === "8");
    expect(wave8).toBeDefined();
    expect(waves.length).toBe(1);
    for (const w of waves) {
      expect(w.wave === "" || w.wave === undefined || w.wave === null).toBe(false);
    }
  });

  test("DOM: the history section renders EXACTLY ONE wave-group (Wave 8) — no wave-group/header for the open-only wave 9, and every rendered header has a non-empty label", async () => {
    const key = "ghost-wave-1";
    const openPlan: PlanFixture = {
      planId: 9703,
      cr: "CR-GHOST-OPEN-2",
      projectKey: "ghost-wave-1",
      status: "open",
      wave: "9",
      cycles: [{ id: 97003, label: "c1", status: "pending" }],
    };
    const closedPlan: PlanFixture = {
      planId: 9704,
      cr: "CR-GHOST-CLOSED-2",
      projectKey: "ghost-wave-1",
      status: "closed",
      wave: "8",
      merge: { commit: "8888888" },
      cycles: [{ id: 97004, label: "c1", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Ghost Wave Project" })],
      events: [],
      plans: [openPlan, closedPlan],
    });
    await openWorkflowTab();

    const hist = history();
    const waveGroups = Array.from(hist.querySelectorAll<HTMLElement>('[data-testid="wave-group"]'));
    expect(waveGroups.length).toBe(1);
    expect(waveGroups[0]!.getAttribute("data-wave")).toBe("8");

    expect(hist.querySelector('[data-testid="wave-group"][data-wave="9"]')).toBeNull();

    const headers = Array.from(hist.querySelectorAll<HTMLElement>('[data-testid="wave-header"]'));
    expect(headers.length).toBe(1);
    for (const h of headers) {
      expect((h.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});
