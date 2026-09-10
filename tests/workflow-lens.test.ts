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
import type { LensRunLike } from "../public/app-logic.mjs";
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

// ── CR-CRU-117 §S1 — an in-flight gate is not a verdict ──────────────────
// Spec: docs/changes/CR-CRU-117-an-in-flight-gate-is-not-a-seal.md, the
// "§S1 — an in-flight gate is not a verdict" acceptance criteria. The mark's
// SHAPE was settled 2026-09-10, before any RED, in
// docs/research/DN-crucible-wave-track-release.md (drift section D3): it
// rides as a key INSIDE the `gate` object the client already builds
// (`gate.inFlight`), NOT as a top-level field beside `version` and NOT as a
// fifth outcome-vocabulary member — because `Store.recordGateEvent(gate:
// unknown, …)` (src/store.ts ~L2049) stores the gate object VERBATIM and
// `handleGates` (src/v2.ts ~L1179) validates only `intent`, `outcome` and
// steps-is-an-array, so an in-gate key reaches both readers with zero
// server change.
//
// Current-code facts verified on this branch (release/0.2.0, 2026-09-10):
//   - `workflowLens`'s `gatedWaveLabels` (public/app-logic.mjs ~L794) is
//     built from EVERY `kind:"gate"` event whose `gate.outcome` is `passed`
//     or `checks-passed`, keyed by `context.wave`. It reads nothing else off
//     the gate — no in-flight mark exists anywhere in the codebase yet — so
//     an interim `checks-passed` ladder gates its wave about two seconds
//     into a run, and the Set is never subtracted from (~L977 is its only
//     consumer, turning membership into `{ label: "gated" }`).
// Every assertion below pinning an in-flight gate as NON-gating is therefore
// genuine RED. The true-positive bounds beside them hold against current
// production and are asserted anyway — they are the anti-vacuity twins the
// criteria explicitly demand, and they are placed FIRST so the assertion
// that actually throws is the new pin (same convention as the §S6
// outcome-vocabulary test in tests/workflow-gate-widget.test.ts).
//
// The nine-row ladder below is the REAL shape, captured from `no-mistakes`
// v1.70.1 on this machine 2026-09-10 — the same capture
// tests/client/test_a_run_still_going_is_never_sealed.py drives. The tool
// version is NAMED because the coupling is load-bearing (§S3's second
// criterion): if the tool gains or loses a pipeline step, a nine-row
// assertion goes red for a tool-version reason with no defect behind it.
describe("CR-CRU-117 §S1 — an in-flight gate is not a verdict (pure workflowLens)", () => {
  // The mark's key, named once. Assertions below test it BY KEY
  // (`hasOwnProperty`), never by inference from step count or `push`.
  const IN_FLIGHT_KEY = "inFlight";
  // The label a wave carries when nothing has sealed it: all lanes closed,
  // no later wave open, no qualifying gate (public/app-logic.mjs ~L979).
  const UNGATED_LABEL = "lanes complete · awaiting review";
  // `no-mistakes` v1.70.1's pipeline, in order — the nine rows `axi status`
  // always emits, unrun ones included.
  const NINE_STEP_NAMES = [
    "intent",
    "rebase",
    "review",
    "test",
    "document",
    "lint",
    "push",
    "pr",
    "ci",
  ];

  interface LensGateStep {
    name: string;
    status: string;
  }
  interface LensGateEventFixture {
    id: string;
    projectKey: string;
    agentId: string;
    kind: "gate";
    codec: "no-mistakes";
    timestamp: number;
    version?: string;
    context: { wave: string };
    gate: {
      intent: string;
      outcome: "checks-passed" | "passed" | "failed" | "cancelled";
      steps: LensGateStep[];
      push?: { commit: string; remote: string };
      inFlight?: boolean;
    };
  }

  // Mid-run: two steps done, `review` still running, the remaining six
  // `pending` — nine rows, exactly what the tool emits while a run is going.
  function inFlightLadder(): LensGateStep[] {
    return NINE_STEP_NAMES.map((name, i) => ({
      name,
      status: i < 2 ? "passed" : i === 2 ? "running" : "pending",
    }));
  }
  function sealedLadder(): LensGateStep[] {
    return NINE_STEP_NAMES.map((name) => ({ name, status: "passed" }));
  }

  function gateEvent(o: {
    id: string;
    wave: string;
    timestamp: number;
    outcome: LensGateEventFixture["gate"]["outcome"];
    steps: LensGateStep[];
    inFlight?: boolean;
    push?: { commit: string; remote: string };
    version?: string;
  }): LensGateEventFixture {
    return {
      id: o.id,
      projectKey: "cru117-lens",
      agentId: "orchestrator-mainline",
      kind: "gate",
      codec: "no-mistakes",
      timestamp: o.timestamp,
      // The CLIENT stamps the wave; the server never does. A wave-less
      // fixture would prove nothing about this exclusion, because the label
      // would be missing from the gated set for an unrelated reason.
      context: { wave: o.wave },
      ...(o.version !== undefined ? { version: o.version } : {}),
      gate: {
        intent: `wave ${o.wave} no-mistakes gate`,
        outcome: o.outcome,
        steps: o.steps,
        ...(o.push !== undefined ? { push: o.push } : {}),
        ...(o.inFlight !== undefined ? { [IN_FLIGHT_KEY]: o.inFlight } : {}),
      },
    };
  }

  function closedPlanForWave(wave: string) {
    const planId = 117_000 + Number(wave);
    return {
      planId,
      cr: `CR-117-W${wave}`,
      status: "closed" as const,
      wave,
      merge: { commit: "a5ad013" },
      cycles: [{ id: planId * 10, label: "c1", status: "done" as const }],
    };
  }

  // `gatedWaveLabels` is module-internal; its ONLY observable form is the
  // wave-boundary label the lens publishes, so membership is read here as
  // `state.label === "gated"`. One wave per call — a second declared wave
  // would trip the (unrelated) superseded detection at ~L961.
  function waveLabel(wave: string, events: LensGateEventFixture[]): string {
    const result = AppLogic.workflowLens({
      plans: [closedPlanForWave(wave)],
      // `LensRunLike` requires `failed`, a test COUNT — the shape of an
      // INGEST run. A gate event carries no counts at all; its verdict is
      // `gate.outcome`, which is why the fixture above declares none and why
      // widening it with a `failed: 0` would put a lie about the wire shape
      // into the fixture this suite reasons from. Loosening `LensRunLike`
      // instead would weaken the type for every other caller of the lens, so
      // the mismatch is absorbed HERE, at the one boundary that has it — the
      // same move `result.waves` makes on the line below.
      events: events as unknown as LensRunLike[],
    });
    const waves = result.waves as Array<{ wave: string; state: { label: string } }>;
    const node = waves.find((w) => w.wave === wave);
    expect(node).toBeDefined();
    return node!.state.label;
  }

  // AC1 — the mark is EXPLICIT DATA on the event, asserted by key; the
  // exclusion must not be a heuristic, because both candidate heuristics are
  // ones this defect already proved unreliable (the tool always emits nine
  // rows, and `push` is absent from plenty of legitimate seals).
  test("the exclusion keys on the in-flight MARK, never on a heuristic: a nine-row marked ladder that even carries a `push` block does NOT gate its wave, while an unmarked two-row seal with no `push` does", () => {
    const marked = gateEvent({
      id: "evt-117-marked-nine-row",
      wave: "6",
      timestamp: 1_757_500_000_000,
      outcome: "checks-passed",
      steps: inFlightLadder(),
      inFlight: true,
      push: { commit: "a5ad013", remote: "origin/release/0.2.0" },
    });

    // The mark is present BY KEY on the gate object the client posts.
    expect(Object.prototype.hasOwnProperty.call(marked.gate, IN_FLIGHT_KEY)).toBe(true);
    expect(marked.gate.inFlight).toBe(true);
    // Both heuristics say "sealed" about this event: nine rows, and a push.
    expect(marked.gate.steps.length).toBe(9);
    expect(marked.gate.push).toBeDefined();
    // It must still not gate — only the mark decides.
    expect(waveLabel("6", [marked])).toBe(UNGATED_LABEL);

    // The converse bound: a REAL seal that both heuristics would misread as
    // interim — two rows, no `push` — still gates.
    const shortSeal = gateEvent({
      id: "evt-117-seal-two-row",
      wave: "6",
      timestamp: 1_757_500_600_000,
      outcome: "passed",
      steps: [
        { name: "intent", status: "passed" },
        { name: "review", status: "passed" },
      ],
    });
    expect(Object.prototype.hasOwnProperty.call(shortSeal.gate, IN_FLIGHT_KEY)).toBe(false);
    expect(shortSeal.gate.push).toBeUndefined();
    expect(waveLabel("6", [shortSeal])).toBe("gated");
  });

  // AC2 — the twin, on ONE wave label: the seal is what gates it, and the
  // in-flight gate contributes nothing in either direction.
  test("two gates on the SAME `context.wave` — one in-flight, one sealed `passed`: the wave is gated by the seal alone and stays gated with both on the board, but is NOT gated when only the in-flight gate is posted", () => {
    const inFlight = gateEvent({
      id: "evt-117-twin-inflight",
      wave: "6",
      timestamp: 1_757_501_000_000,
      outcome: "checks-passed",
      steps: inFlightLadder(),
      inFlight: true,
    });
    const seal = gateEvent({
      id: "evt-117-twin-seal",
      wave: "6",
      timestamp: 1_757_502_400_000,
      outcome: "passed",
      steps: sealedLadder(),
      push: { commit: "a5ad013", remote: "origin/release/0.2.0" },
    });

    // Same wave, stamped explicitly on BOTH — the mark is the only
    // difference between them.
    expect(inFlight.context.wave).toBe("6");
    expect(seal.context.wave).toBe(inFlight.context.wave);

    // Anti-vacuity twin: the seal alone gates the label.
    expect(waveLabel("6", [seal])).toBe("gated");
    // Both on the board: still gated — the seal did it, the interim neither
    // caused nor undid it.
    expect(waveLabel("6", [inFlight, seal])).toBe("gated");
    // The pin: the in-flight gate alone leaves the wave un-gated.
    expect(waveLabel("6", [inFlight])).toBe(UNGATED_LABEL);
  });

  // AC3 — the narrowing loses no true positive. Old gate events carry no
  // mark and must keep reading exactly as they do today (Risk section:
  // "they are seals, correctly").
  test("a wave gated by a REAL seal is still gated: unmarked `passed` and `checks-passed` gates both gate it, while the IDENTICAL `checks-passed` nine-row ladder carrying the mark does not", () => {
    const passedSeal = gateEvent({
      id: "evt-117-truepos-passed",
      wave: "6",
      timestamp: 1_757_503_000_000,
      outcome: "passed",
      steps: sealedLadder(),
      push: { commit: "a5ad013", remote: "origin/release/0.2.0" },
    });
    expect(waveLabel("6", [passedSeal])).toBe("gated");

    // A legacy pre-CR-117 gate: `checks-passed`, no mark at all — a seal.
    const checksPassedSeal = gateEvent({
      id: "evt-117-truepos-checks",
      wave: "6",
      timestamp: 1_757_503_100_000,
      outcome: "checks-passed",
      steps: sealedLadder(),
    });
    expect(
      Object.prototype.hasOwnProperty.call(checksPassedSeal.gate, IN_FLIGHT_KEY),
    ).toBe(false);
    expect(waveLabel("6", [checksPassedSeal])).toBe("gated");

    // The discriminator: same outcome, same nine-row ladder, mark added.
    const markedTwin = gateEvent({
      id: "evt-117-truepos-marked-twin",
      wave: "6",
      timestamp: 1_757_503_200_000,
      outcome: "checks-passed",
      steps: sealedLadder(),
      inFlight: true,
    });
    expect(waveLabel("6", [markedTwin])).toBe(UNGATED_LABEL);
  });

  // AC6 — an in-flight gate carries NO `version`. A version-stamped gate is
  // retention-protected (`LIVE_GATE`, src/store.ts ~L2969, keyed on
  // `json_extract(payload,'$.version') IS NOT NULL`), so stamping every
  // interim snapshot would leave a run's worth of unprunable gates behind
  // for one release — and the seal restates the release anyway.
  test("an in-flight gate carries no `version` key at all while the same run's SEAL carries it — and version-absence is NOT the mark: an unmarked, version-less seal still gates, the version-less in-flight gate does not", () => {
    const interim = gateEvent({
      id: "evt-117-version-interim",
      wave: "6",
      timestamp: 1_757_504_000_000,
      outcome: "checks-passed",
      steps: inFlightLadder(),
      inFlight: true,
    });
    const seal = gateEvent({
      id: "evt-117-version-seal",
      wave: "6",
      timestamp: 1_757_505_400_000,
      outcome: "passed",
      steps: sealedLadder(),
      push: { commit: "a5ad013", remote: "origin/release/0.2.0" },
      version: "0.2.0",
    });

    // Key ABSENCE, not null and not empty — `version` is a top-level sibling
    // of `gate` (src/v2.ts ~L1216), so neither place may carry one.
    expect(Object.prototype.hasOwnProperty.call(interim, "version")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(interim.gate, "version")).toBe(false);
    // The same run's seal DOES state it.
    expect(Object.prototype.hasOwnProperty.call(seal, "version")).toBe(true);
    expect(seal.version).toBe("0.2.0");

    // Bound: version-absence is not what makes a gate interim — a seal that
    // stamps no release still gates its wave.
    const versionlessSeal = gateEvent({
      id: "evt-117-version-less-seal",
      wave: "6",
      timestamp: 1_757_505_500_000,
      outcome: "passed",
      steps: sealedLadder(),
    });
    expect(Object.prototype.hasOwnProperty.call(versionlessSeal, "version")).toBe(false);
    expect(waveLabel("6", [versionlessSeal])).toBe("gated");

    // The pin: the version-less INTERIM gate does not gate...
    expect(waveLabel("6", [interim])).toBe(UNGATED_LABEL);
    // ...and its run's own seal, arriving after it, does.
    expect(waveLabel("6", [interim, seal])).toBe("gated");
  });
});
