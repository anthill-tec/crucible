// CR-CRU-026 C2 — §S3.2/§S3.3/§S3.4/§S0 home plan availability + compound
// (projectKey, cycleId) matching + vestige cleanout, plus the sanctioned §S2
// strict-guard follow-up (undeclared projectKey plans render nothing).
//
// Spec: docs/changes/CR-CRU-026-patch-workspace-plan-scoping.md
//   §S3.2 — home gap-analysis decision: a single additive
//     `GET /api/v2/plans` (all non-archived projects' plans) feeds the home
//     timeline; `refetchPlans` becomes surface-aware (workspace: scoped
//     route; home: the new global route) instead of early-returning
//     off-workspace.
//   §S3.3 — with plans from MULTIPLE projects in client state, run<->cycle
//     matching keys on (projectKey, cycleId) — plan cycle ids are
//     PER-PROJECT and MUST NOT collide across projects on the home feed.
//   §S3.4 — vestige cleanout: a project that HAS plans gets its cycle
//     narration ONLY from declared data; the CR-007 heuristic is
//     structurally unreachable there in ANY data state (even for a stray
//     run with no cycleId — it renders as a plain card, never a phantom
//     pair). The heuristic stays byte-identical ONLY for planless projects.
//   §S0 — every render is a PURE FUNCTION of (route, server data): home
//     reached by cold load vs. by navigation must render the identical
//     marker/boundary set given unchanged server data.
//   §S2 (sanctioned follow-up) — the render guard goes STRICT: a plan with
//     NO projectKey field (undeclared) renders NOTHING, closing the
//     tolerance C1 kept for legacy fixtures.
//
// Current code facts (verified against public/app.js and public/app-
// logic.mjs on this branch):
//   - refetchPlans() (app.js ~L164) early-returns off-workspace — home NEVER
//     fetches plan data at all, from any code path (cold, poll, or nav).
//   - scopeChanged() (app.js ~L81) only fires refetchPlans()/refetchCore()
//     `if (state.route.page === "workspace")` — arriving at home via
//     navigation cannot repopulate state.plans even after this CR adds the
//     global route, unless that gate is widened.
//   - runFeed() (app.js ~L740) calls `L.timelineRows(events, state.plans)`
//     on BOTH home and workspace with the SAME state.plans, unfiltered by
//     project on home.
//   - planCycleIndex() (app-logic.mjs ~L275) keys SOLELY on the bare numeric
//     `cycle.id` — `index.set(cycle.id, {cycle, plan})` — across ALL plans
//     in the array with no projectKey component, so two projects sharing a
//     numeric cycle id COLLIDE (last-plan-in-array wins the Map slot).
//   - timelineRows()'s `isLinked` check therefore also collides: an event
//     linked by cycleId alone can resolve to ANOTHER project's cycle/plan.
//   - the CR-007 heuristic (pairTransitions) is applied to
//     `events.filter(e => !isLinked(e))` — a project's mere POSSESSION of a
//     plan does not exempt its OWN unlinked runs from the heuristic today;
//     only per-event cycleId linkage does (§S3.4's capability-conditional
//     rule does not exist yet).
//   - scopedPlans() (app.js ~L1833) treats `p.projectKey === undefined` as a
//     MATCH (tolerant, C1's sanctioned legacy-fixture allowance) — not the
//     strict "undeclared = excluded" rule this file pins.
// So every pin below is expected to FAIL against current production.
//
// Harness note: same mountApp/settle convention as tests/plan-scoping.test.ts
// (C1) — real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js; `fetch` is scripted. Extended here with a SINGLE source of
// truth (`opts.plans`, each item already carrying `projectKey` like the real
// server payload) that the mock fetch handler filters per-route: the scoped
// `GET /api/v2/projects/<key>/plans` returns only that key's plans; the NEW
// global `GET /api/v2/plans` returns the full set — mirroring how the real
// server derives both from the same store.
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

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface CycleFixture {
  id: number;
  label: string;
  kind?: "red-green" | "verify" | "fix";
  status: "pending" | "active" | "done" | "skipped" | "failed";
  activatedAt?: number;
  doneAt?: number;
}

// projectKey is OPTIONAL here (not the real server contract) precisely so
// the §S2 strict-guard test can construct a plan that omits it entirely —
// the "undeclared" case the strict guard must exclude.
interface PlanFixture {
  planId: number | string;
  projectKey?: string;
  cr: string;
  status: "open" | "closed";
  wave?: string;
  cycles: CycleFixture[];
}

interface EventFixture {
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
  duration_ms?: number;
  context?: { cycleId?: number; cycle?: string };
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
}

let cacheBust = 0;
let scopedPlanCalls: { key: string }[] = [];
let globalPlanCalls = 0;
let liveEvents: EventFixture[] = [];
let livePlans: PlanFixture[] = [];

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

function runEvent(overrides: Partial<EventFixture> & { id: string; projectKey: string; agentId: string; timestamp: number }): EventFixture {
  return {
    kind: "test",
    tier: "unit",
    codec: "junit",
    total: 5,
    passed: 5,
    failed: 0,
    duration_ms: 1000,
    ...overrides,
  };
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  scopedPlanCalls = [];
  globalPlanCalls = 0;
  liveEvents = opts.events.map((e) => ({ ...e }));
  livePlans = opts.plans.map((p) => ({ ...p }));

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    const scopedMatch = /\/api\/v2\/projects\/([^/?]+)\/plans(?:\?|$)/.exec(url);
    if (scopedMatch !== null) {
      const key = decodeURIComponent(scopedMatch[1]!);
      scopedPlanCalls.push({ key });
      // NOT filtered by key here (same convention as the legacy harnesses
      // this CR modernizes, e.g. tests/cycle-timers.test.ts's mountApp):
      // each test's `plans` fixture already IS the set relevant to that
      // mount, so the §S2 strict-guard test can put an undeclared-
      // projectKey plan on the wire and exercise the CLIENT's own render
      // guard rather than having a mock-level filter mask it.
      const body = { ok: true, plans: livePlans };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) {
      globalPlanCalls += 1;
      const body = { ok: true, plans: livePlans };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/projects")) {
      const body = { ok: true, projects: opts.projects };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/agents")) {
      const body = { ok: true, agents: [] };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/events")) {
      const body = { ok: true, events: liveEvents };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/health")) {
      const body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    throw new Error(`home-marker-parity.test.ts mountApp: unexpected fetch url ${url}`);
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?homeMarkerParity=${cacheBust}`);

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

function scopedCallCount(key: string): number {
  return scopedPlanCalls.filter((c) => c.key === key).length;
}

function badgeFor(name: string): HTMLElement {
  const badge = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="project-badge"]'),
  ).find((el) => (el.textContent ?? "").includes(name));
  if (badge === undefined) throw new Error(`project-badge not found for ${name}`);
  return badge;
}

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (el) => (el.textContent ?? "").trim() === text,
  );
}

function clickBackToProjects(): void {
  const chip = findByText(document, "button", "← projects");
  if (chip === undefined) throw new Error('"← projects" chip not found');
  chip.click();
}

async function openWorkflowTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Workflow");
  if (tab === undefined) throw new Error('"Workflow" workspace-tab not found');
  tab.click();
  await settle();
}

function renderedCrs(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-cr]")).map(
    (el) => el.getAttribute("data-cr") ?? "",
  );
}

/** Marker/boundary testid+text pairs, sorted — the §S0 equivalence fingerprint. */
function markerFingerprint(): string[] {
  const testids = ["cycle-span-open", "declared-marker", "transition-marker"];
  const out: string[] = [];
  for (const testid of testids) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`))) {
      out.push(`${testid}::${(el.textContent ?? "").replace(/\s+/g, " ").trim()}`);
    }
  }
  return out.sort();
}

// ── §3.2 — home fetches the GLOBAL read, workspace stays scoped ──────────

describe("§S3.2 — home fetches GET /api/v2/plans (global); a workspace stays on the C1 scoped route", () => {
  test("cold mount at home fires exactly one GET /api/v2/plans and zero project-scoped GET .../plans calls", async () => {
    const keyA = "home-cold-a";
    const plan: PlanFixture = {
      planId: 1,
      projectKey: keyA,
      cr: "CR-HOME-COLD-1",
      status: "open",
      cycles: [{ id: 1, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: "/",
      projects: [project({ key: keyA, name: "Cold A" })],
      events: [],
      plans: [plan],
    });

    expect(globalPlanCalls).toBe(1);
    expect(scopedPlanCalls.length).toBe(0);
  });

  test("on a workspace, only the project-scoped route fires; the global route is never called (C1 behavior intact)", async () => {
    const key = "home-ws-scoped-1";
    const plan: PlanFixture = {
      planId: 2,
      projectKey: key,
      cr: "CR-HOME-WS-1",
      status: "open",
      cycles: [{ id: 2, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Scoped Workspace" })],
      events: [],
      plans: [plan],
    });

    expect(scopedCallCount(key)).toBe(1);
    expect(globalPlanCalls).toBe(0);
  });

  test(
    "each steady-state poll tick while at home re-fires the global route; the scoped route is never touched",
    async () => {
      const keyA = "home-poll-a";
      const plan: PlanFixture = {
        planId: 3,
        projectKey: keyA,
        cr: "CR-HOME-POLL-1",
        status: "open",
        cycles: [{ id: 3, label: "c1", status: "active" }],
      };

      await mountApp({
        pathname: "/",
        projects: [project({ key: keyA, name: "Poll A" })],
        events: [],
        plans: [plan],
      });

      expect(globalPlanCalls).toBe(1);

      // Mutate the same live fixture the mock reads, exactly like the C1
      // regression pin's live-mutation technique.
      livePlans[0] = { ...plan, cycles: [{ id: 3, label: "c1", status: "done", activatedAt: Date.now() - 1000, doneAt: Date.now() }] };

      await waitForPollTick();

      expect(globalPlanCalls).toBeGreaterThanOrEqual(2);
      expect(scopedPlanCalls.length).toBe(0);
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── §S3.2 — home renders declared vocabulary once it has plan data ───────

describe("§S3.2 — home renders DECLARED boundaries (never the heuristic) for plan-linked runs", () => {
  test("two projects — one active cycle + linked runs, one done cycle + linked runs — render cycle-span-open / declared-marker, zero transition-marker for those runs", async () => {
    const keyActive = "home-decl-active";
    const keyDone = "home-decl-done";
    const now = Date.now();
    const t0 = now - 500_000;

    const activePlan: PlanFixture = {
      planId: 10,
      projectKey: keyActive,
      cr: "CR-HOME-DECL-ACTIVE",
      status: "open",
      cycles: [{ id: 101, label: "active cycle", status: "active", activatedAt: t0 }],
    };
    const donePlan: PlanFixture = {
      planId: 11,
      projectKey: keyDone,
      cr: "CR-HOME-DECL-DONE",
      status: "open",
      cycles: [{ id: 102, label: "done cycle", status: "done", activatedAt: t0, doneAt: t0 + 200_000 }],
    };

    const activeRun = runEvent({
      id: "evt-home-decl-active-1",
      projectKey: keyActive,
      agentId: "agent-active-1",
      timestamp: now,
      context: { cycleId: 101 },
    });
    const doneRun = runEvent({
      id: "evt-home-decl-done-1",
      projectKey: keyDone,
      agentId: "agent-done-1",
      timestamp: now,
      context: { cycleId: 102 },
    });

    await mountApp({
      pathname: "/",
      projects: [
        project({ key: keyActive, name: "Decl Active" }),
        project({ key: keyDone, name: "Decl Done" }),
      ],
      events: [activeRun, doneRun],
      plans: [activePlan, donePlan],
    });

    const openRows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="cycle-span-open"]'));
    expect(openRows.some((r) => (r.textContent ?? "").includes("active cycle"))).toBe(true);
    expect(openRows.some((r) => (r.textContent ?? "").includes("CR-HOME-DECL-ACTIVE"))).toBe(true);

    const doneRows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="declared-marker"]'));
    expect(doneRows.some((r) => (r.textContent ?? "").includes("done cycle"))).toBe(true);
    expect(doneRows.some((r) => (r.textContent ?? "").includes("CR-HOME-DECL-DONE"))).toBe(true);

    // Bound — neither linked run produced a heuristic marker.
    expect(document.querySelectorAll('[data-testid="transition-marker"]').length).toBe(0);
  });
});

// ── §S3.3 — compound (projectKey, cycleId) matching ───────────────────────

describe("§S3.3 — compound (projectKey, cycleId) matching: numerically identical cycle ids across projects never collide", () => {
  test("project A's active cycle 7 and project B's done cycle 7 each render under THEIR OWN project's cr/label — never the other's", async () => {
    const keyA = "home-compound-a";
    const keyB = "home-compound-b";
    const now = Date.now();
    const t0 = now - 500_000;

    // Deliberately identical numeric cycle id (7) across two DIFFERENT
    // projects — the exact collision scenario §S3.3 forbids.
    const planA: PlanFixture = {
      planId: 20,
      projectKey: keyA,
      cr: "CR-COMPOUND-A",
      status: "open",
      cycles: [{ id: 7, label: "collide-a-cycle", status: "active", activatedAt: t0 }],
    };
    const planB: PlanFixture = {
      planId: 21,
      projectKey: keyB,
      cr: "CR-COMPOUND-B",
      status: "open",
      cycles: [{ id: 7, label: "collide-b-cycle", status: "done", activatedAt: t0, doneAt: t0 + 200_000 }],
    };

    const runA = runEvent({
      id: "evt-compound-a-1",
      projectKey: keyA,
      agentId: "agent-compound-a",
      timestamp: now,
      context: { cycleId: 7 },
    });
    const runB = runEvent({
      id: "evt-compound-b-1",
      projectKey: keyB,
      agentId: "agent-compound-b",
      timestamp: now + 10,
      context: { cycleId: 7 },
    });

    await mountApp({
      pathname: "/",
      projects: [
        project({ key: keyA, name: "Compound A" }),
        project({ key: keyB, name: "Compound B" }),
      ],
      events: [runA, runB],
      plans: [planA, planB],
    });

    const openRowForA = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="cycle-span-open"]'),
    ).find((r) => (r.textContent ?? "").includes("collide-a-cycle"));
    expect(openRowForA).toBeDefined();
    expect(openRowForA!.textContent ?? "").toContain("CR-COMPOUND-A");
    expect(openRowForA!.textContent ?? "").not.toContain("CR-COMPOUND-B");

    const doneRowForB = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="declared-marker"]'),
    ).find((r) => (r.textContent ?? "").includes("collide-b-cycle"));
    expect(doneRowForB).toBeDefined();
    expect(doneRowForB!.textContent ?? "").toContain("CR-COMPOUND-B");
    expect(doneRowForB!.textContent ?? "").not.toContain("CR-COMPOUND-A");
  });
});

// ── §S3.4 — vestige cleanout: capability-conditional heuristic ───────────

describe("§S3.4 — vestige cleanout: a project WITH plans never emits the CR-007 heuristic, in any data state", () => {
  test("a run with NO cycleId on a project that HAS a plan renders a PLAIN CARD — zero transition-marker, even though its stem forms a valid RED/GREEN pair", async () => {
    const key = "home-vestige-haseplan";
    const now = Date.now();

    // The project owns a plan — but this cycle is UNRELATED to the pair
    // below (no run ever links to it); it exists purely to establish
    // "this project HAS plans" (the §S3.4 capability trigger).
    const plan: PlanFixture = {
      planId: 30,
      projectKey: key,
      cr: "CR-VESTIGE-UNRELATED",
      status: "open",
      cycles: [{ id: 900, label: "unrelated cycle", status: "pending" }],
    };

    const redEvent = runEvent({
      id: "evt-vestige-red-1",
      projectKey: key,
      agentId: "CR-VESTIGE-1-RED",
      timestamp: now,
      total: 5,
      passed: 3,
      failed: 2,
      // No context.cycleId — a genuinely unlinked run.
    });
    const greenEvent = runEvent({
      id: "evt-vestige-green-1",
      projectKey: key,
      agentId: "CR-VESTIGE-1-GREEN",
      timestamp: now + 459_000,
      total: 5,
      passed: 5,
      failed: 0,
    });

    await mountApp({
      pathname: "/",
      projects: [project({ key, name: "Vestige Has-Plan" })],
      events: [redEvent, greenEvent],
      plans: [plan],
    });

    // Zero heuristic pairing anywhere — the capability-conditional rule
    // makes the heuristic structurally unreachable for this project.
    expect(document.querySelectorAll('[data-testid="transition-marker"]').length).toBe(0);

    // Both runs render as plain cards, addressable by their own run id.
    expect(
      document.querySelector('[data-testid="event-card"][data-run-id="evt-vestige-red-1"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="event-card"][data-run-id="evt-vestige-green-1"]'),
    ).not.toBeNull();
  });

  test("a planless project's RED/GREEN pair still renders the CR-007 heuristic marker BYTE-IDENTICAL (`RED f/t ➜ GREEN t/t · …`)", async () => {
    const key = "home-vestige-planless";
    const now = Date.now();

    const redEvent = runEvent({
      id: "evt-planless-red-1",
      projectKey: key,
      agentId: "CR-PLANLESS-1-RED",
      timestamp: now,
      total: 5,
      passed: 3,
      failed: 2,
    });
    const greenEvent = runEvent({
      id: "evt-planless-green-1",
      projectKey: key,
      agentId: "CR-PLANLESS-1-GREEN",
      timestamp: now + 459_000, // 7m 39s later.
      total: 5,
      passed: 5,
      failed: 0,
    });

    await mountApp({
      pathname: "/",
      projects: [project({ key, name: "Vestige Planless" })],
      events: [redEvent, greenEvent],
      plans: [], // no plan anywhere for this project — the CR-011 §S0b fallback.
    });

    const marker = document.querySelector<HTMLElement>('[data-testid="transition-marker"]');
    expect(marker).not.toBeNull();
    expect((marker!.textContent ?? "").trim()).toBe(
      "RED 2/5 ➜ GREEN 5/5 · CR-PLANLESS-1 · unit · closed in 7m 39s",
    );
  });
});

// ── §S0 — home is a pure function of (route, data): cold load vs nav ─────

describe("§S0 — home's rendered marker/boundary set is IDENTICAL between cold load and arrival via navigation", () => {
  test("home → a workspace → home renders the SAME marker/boundary testid+text set as the original cold load, given unchanged server data", async () => {
    const keyActive = "home-eq-active";
    const keyDone = "home-eq-done";
    const now = Date.now();
    const t0 = now - 500_000;

    const activePlan: PlanFixture = {
      planId: 40,
      projectKey: keyActive,
      cr: "CR-EQ-ACTIVE",
      status: "open",
      cycles: [{ id: 401, label: "eq active cycle", status: "active", activatedAt: t0 }],
    };
    const donePlan: PlanFixture = {
      planId: 41,
      projectKey: keyDone,
      cr: "CR-EQ-DONE",
      status: "open",
      cycles: [{ id: 402, label: "eq done cycle", status: "done", activatedAt: t0, doneAt: t0 + 200_000 }],
    };

    const activeRun = runEvent({
      id: "evt-eq-active-1",
      projectKey: keyActive,
      agentId: "agent-eq-active",
      timestamp: now,
      context: { cycleId: 401 },
    });
    const doneRun = runEvent({
      id: "evt-eq-done-1",
      projectKey: keyDone,
      agentId: "agent-eq-done",
      timestamp: now,
      context: { cycleId: 402 },
    });

    await mountApp({
      pathname: "/",
      projects: [
        project({ key: keyActive, name: "Eq Active" }),
        project({ key: keyDone, name: "Eq Done" }),
      ],
      events: [activeRun, doneRun],
      plans: [activePlan, donePlan],
    });

    const coldFingerprint = markerFingerprint();
    // Sanity — the cold load actually produced declared rows (otherwise the
    // equivalence check below would trivially "pass" on two empty sets).
    expect(coldFingerprint.length).toBeGreaterThan(0);

    badgeFor("Eq Active").click(); // home -> workspace
    await settle();
    clickBackToProjects(); // workspace -> home
    await settle();

    const navFingerprint = markerFingerprint();
    expect(navFingerprint).toEqual(coldFingerprint);
  });
});

// ── §S2 (sanctioned strict-guard follow-up) — undeclared projectKey ──────

describe("§S2 strict guard — a plan with NO projectKey field renders NOTHING (undeclared = excluded, not tolerated)", () => {
  test("workspace: an undeclared-projectKey plan's cr never renders anywhere; the routed project's own tagged plan still does", async () => {
    const routedKey = "home-strict-guard-1";

    const ownPlan: PlanFixture = {
      planId: 50,
      projectKey: routedKey,
      cr: "CR-STRICT-OWN",
      status: "open",
      cycles: [{ id: 501, label: "c1", status: "active" }],
    };
    // No `projectKey` field at all — the undeclared case C1 tolerated
    // (rendered because `p.projectKey === undefined` matched everything).
    const undeclaredPlan: PlanFixture = {
      planId: 51,
      cr: "CR-STRICT-UNDECLARED",
      status: "open",
      cycles: [{ id: 502, label: "c2", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${routedKey}`,
      projects: [project({ key: routedKey, name: "Strict Guard Project" })],
      events: [],
      plans: [ownPlan, undeclaredPlan],
    });

    await openWorkflowTab();

    expect(renderedCrs()).toContain("CR-STRICT-OWN");
    expect(renderedCrs()).not.toContain("CR-STRICT-UNDECLARED");
    expect(document.body.textContent ?? "").not.toContain("CR-STRICT-UNDECLARED");
  });
});
