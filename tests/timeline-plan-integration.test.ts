// CR-CRU-011 §S0b — timeline plan integration (gap-analysis DRIFT-1): the
// Runs timeline consumes declared cycle plans directly.
//   1. Marker suppression — runs linked via context.cycleId NEVER produce an
//      inferred (streak-heuristic) transition marker; the declared plan is
//      the boundary authority.
//   2. Declared markers inline — an ACTIVE cycle renders an open-span header
//      above its linked runs; a cycle transitioning to `done` renders a
//      declared marker row `<glyph> Cycle done · <label> · <cr> · closed in
//      <duration>` (duration = active→done span).
//   3. Unlinked runs keep the CR-CRU-007 §S2 streak-heuristic unchanged
//      (fallback intact) — regression pin.
//   4. Planless projects: timeline output byte-identical to pre-CR-011
//      (regression-guarded).
//
// RED phase: expected to fail against CURRENT production, whose
// public/app.js `runFeed()` (~line 606) calls `L.pairTransitions(events)`
// unconditionally — it has no awareness of `state.plans` or
// `context.cycleId` at all, so a cycleId-linked fail→pass pair still
// produces a heuristic `transition-marker`, and no `cycle-span-open` /
// `declared-marker` element exists anywhere in the shell.
//
// Drives the REAL production public/app.js shell inside a happy-dom window
// — same harness pattern as tests/workflow-tab.test.ts (workspace pathname,
// scripted `/api/v2/projects/<key>/plans` fetch) merged with the
// transition-marker assertions from tests/transition-markers.test.ts.
//
// PlanCycle timestamp fields (`activatedAt`/`doneAt`) are a NEW additive
// contract this file introduces for GREEN — no such fields exist on the
// server's PlanCycle today (src/types.ts:131-137 only carries
// id/label/kind/status). The precedent is `Plan.closedAt`
// (src/types.ts:162), which the server already stamps at close time; mirroring
// that same pattern onto the cycle's active→done transition is the natural
// implementation choice for computing "closed in <duration>" here.
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
  // New additive contract this file pins — see file header.
  activatedAt?: number;
  doneAt?: number;
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  status: "open" | "closed";
  cycles: CycleFixture[];
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
      throw new Error(`timeline-plan-integration.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?timelinePlanIntegration=${cacheBust}`);

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

/** Same RED/GREEN pair shape as tests/transition-markers.test.ts §S2 AC2. */
function failThenPassPair(
  key: string,
  stem: string,
  t0: number,
  cycleId: number | undefined,
): EventFixture[] {
  const redEvt: EventFixture = {
    id: `evt-${stem}-red`,
    projectKey: key,
    agentId: `${stem}-RED`,
    kind: "test",
    tier: "unit",
    timestamp: t0,
    total: 5,
    passed: 3,
    failed: 2,
    pending: 0,
    duration_ms: 1000,
    hasCoverage: false,
    ...(cycleId !== undefined ? { context: { cycleId } } : {}),
  };
  const greenEvt: EventFixture = {
    id: `evt-${stem}-green`,
    projectKey: key,
    agentId: `${stem}-GREEN`,
    kind: "test",
    tier: "unit",
    timestamp: t0 + 45_000,
    total: 5,
    passed: 5,
    failed: 0,
    pending: 0,
    duration_ms: 1200,
    hasCoverage: false,
    ...(cycleId !== undefined ? { context: { cycleId } } : {}),
  };
  return [redEvt, greenEvt];
}

// ── 1+2. Marker suppression + open-span header for the ACTIVE cycle ────────

describe("§S0b — marker suppression + open-span header (cycleId-linked runs)", () => {
  test("an open plan with an ACTIVE cycle: fail(2/5) then pass(5/5) runs linked via context.cycleId render ZERO inferred transition markers and an open-span header above the linked runs, carrying the cycle label", async () => {
    const key = "s0b-active-1";
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    const plan: PlanFixture = {
      planId: 501,
      cr: "CR-S0B-1",
      status: "open",
      cycles: [{ id: 5, label: "c1 checkpoint", status: "active" }],
    };
    const [redEvt, greenEvt] = failThenPassPair(key, "CR-S0B-1", t0, 5);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "S0B Active" })],
      events: [redEvt, greenEvt],
      plans: [plan],
    });

    // The suppression assertion: this SAME fail/pass pair, same stem, within
    // 24h, would ordinarily pair via L.pairTransitions into exactly one
    // marker (see tests/transition-markers.test.ts) — but linkage via
    // context.cycleId must suppress it entirely.
    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(0);

    const span = document.querySelector('[data-testid="cycle-span-open"]');
    expect(span).not.toBeNull();
    expect((span!.textContent ?? "")).toContain("c1 checkpoint");

    // bound: the open-span header renders ABOVE (precedes in document order)
    // the linked runs it collects.
    const firstRunCard = document.querySelector(
      `[data-testid="event-card"][data-run-id="${redEvt.id}"], [data-testid="event-card"]`,
    );
    expect(firstRunCard).not.toBeNull();
    // eslint-disable-next-line no-bitwise
    expect(
      (span!.compareDocumentPosition(firstRunCard!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  test("PATCHing the cycle to done renders a declared marker row containing the cycle label, the cr, and the active→done duration", async () => {
    const key = "s0b-done-1";
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    const activatedAt = t0;
    const doneAt = t0 + 50_000; // 50s active→done span
    const plan: PlanFixture = {
      planId: 502,
      cr: "CR-S0B-2",
      status: "open",
      cycles: [
        { id: 6, label: "c1 checkpoint", status: "done", activatedAt, doneAt },
      ],
    };
    const [redEvt, greenEvt] = failThenPassPair(key, "CR-S0B-2", t0, 6);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "S0B Done" })],
      events: [redEvt, greenEvt],
      plans: [plan],
    });

    // still suppressed — the declared marker replaces the heuristic one.
    expect(document.querySelectorAll('[data-testid="transition-marker"]').length).toBe(0);
    // no longer an OPEN span — the cycle is done, not active.
    expect(document.querySelector('[data-testid="cycle-span-open"]')).toBeNull();

    const declared = document.querySelector('[data-testid="declared-marker"]');
    expect(declared).not.toBeNull();
    const text = declared!.textContent ?? "";
    expect(text).toContain("Cycle done");
    expect(text).toContain("c1 checkpoint");
    expect(text).toContain("CR-S0B-2");
    expect(text).toMatch(/closed in \d+s/);
  });
});

// ── 3. Fallback intact — unlinked runs keep the streak heuristic ──────────

describe("§S0b — fallback intact (no cycleId)", () => {
  test("the same fail/pass pair WITHOUT cycleId still yields exactly ONE heuristic marker, even with an open plan present on the project", async () => {
    const key = "s0b-fallback-1";
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    const plan: PlanFixture = {
      planId: 503,
      cr: "CR-S0B-3",
      status: "open",
      cycles: [{ id: 7, label: "unrelated cycle", status: "active" }],
    };
    // NOTE: no cycleId on these events — deliberately unlinked.
    const [redEvt, greenEvt] = failThenPassPair(key, "CR-S0B-3", t0, undefined);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "S0B Fallback" })],
      events: [redEvt, greenEvt],
      plans: [plan],
    });

    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(1);
    expect(document.querySelector('[data-testid="declared-marker"]')).toBeNull();
  });
});

// ── 4. Planless projects — byte-identical timeline (regression guard) ─────

describe("§S0b — planless projects unchanged", () => {
  test("a planless project's timeline shows exactly one heuristic marker and no declared/open-span lens elements at all", async () => {
    const key = "s0b-planless-1";
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    const [redEvt, greenEvt] = failThenPassPair(key, "CR-S0B-4", t0, undefined);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "S0B Planless" })],
      events: [redEvt, greenEvt],
      plans: [],
    });

    expect(document.querySelectorAll('[data-testid="transition-marker"]').length).toBe(1);
    expect(document.querySelector('[data-testid="cycle-span-open"]')).toBeNull();
    expect(document.querySelector('[data-testid="declared-marker"]')).toBeNull();
  });
});
