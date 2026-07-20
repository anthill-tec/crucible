// CR-CRU-032 §S4 — the workspace Runs window is governed by `retention`
// (the disconnect fix).
//
// Spec: docs/changes/CR-CRU-032-runs-boundary-anchor-fetch.md §S4
//
// Current code fact (verified against public/app.js on this branch):
//   `refetchCore` (app.js ~L156-173) fetches ONE all-projects
//   `/api/v2/events?limit=50` into `state.events`, unconditionally — the
//   SAME call regardless of `state.route.page`. The workspace Runs pane
//   (`visibleEvents()` / `WorkspaceRunsFeed`, app.js ~L283-289, ~L1548)
//   then FILTERS that shared slice client-side by `projectKey`, so a
//   project's Runs tab only ever sees its slice of the recent 50 events
//   ACROSS ALL PROJECTS — never its own `retention`-sized window. This is
//   the "so little" bug §S4 fixes.
//
// Fix under test (not yet implemented — every test below is RED against
// current production): mirror the existing `refetchPlans` surface-aware
// split (app.js ~L184-195, CR-CRU-026 §S3.2) — on a WORKSPACE route,
// `refetchCore`'s events call must become
//   `/api/v2/events?project=<key>&limit=<project.retention ?? MANAGER_RETENTION_DEFAULT>`
// (`MANAGER_RETENTION_DEFAULT = 100`, app.js ~L1078) so the Runs tab shows
// THAT project's own runs up to ITS retention. HOME must keep the
// unchanged collective `/api/v2/events?limit=50` call.
//
// Harness: same happy-dom + real public/app.js + public/app-logic.mjs
// pattern as tests/plan-scoping.test.ts / tests/cycle-runs-anchor-fetch.test.ts
// (VanJS/VanX vendor bundles evaluated verbatim; fetch scripted; every
// `/api/v2/events` call recorded in full so its URLSearchParams can be
// asserted precisely).
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

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  retention?: number;
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
  // §S4 regression pin — links this run to a declared plan cycle (see
  // PlanFixture below), the same shape app-logic.mjs#timelineRows reads.
  context?: { cycleId?: number };
}

// §S4 regression pin — CR-CRU-026 §S0 declared-marker fixtures (mirrors
// tests/home-marker-parity.test.ts's PlanFixture/CycleFixture shapes).
interface CycleFixture {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
  activatedAt?: number;
  doneAt?: number;
}

interface PlanFixture {
  planId: number | string;
  projectKey: string;
  cr: string;
  status: "open" | "closed";
  cycles: CycleFixture[];
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  // Per-key events served by the WORKSPACE-scoped ?project=<key> call.
  eventsByKey?: Record<string, EventFixture[]>;
  // Served by the bare HOME collective ?limit=50 call (no `project` param).
  homeEvents?: EventFixture[];
  // §S4 regression pin — plans fixtures for the home->workspace->home nav
  // test below (declared-marker rendering needs state.plans too). Optional
  // and unused by the pre-existing AC1-AC4 tests above (defaults to `[]`,
  // preserving their current empty-plans behavior byte-for-byte).
  plansByKey?: Record<string, PlanFixture[]>;
  homePlans?: PlanFixture[];
}

let cacheBust = 0;
let eventsCalls: string[] = [];

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

function manyEvents(key: string, count: number): EventFixture[] {
  const base = Date.now() - count * 1000;
  return Array.from({ length: count }, (_, i) =>
    runEvent({
      id: `${key}-run-${i}`,
      projectKey: key,
      agentId: `agent-${i}`,
      timestamp: base + i * 1000,
    }),
  );
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  eventsCalls = [];
  const eventsByKey = opts.eventsByKey ?? {};
  const homeEvents = opts.homeEvents ?? [];
  const plansByKey = opts.plansByKey ?? {};
  const homePlans = opts.homePlans ?? [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (url.includes("/api/v2/events")) {
      eventsCalls.push(url);
      const parsed = new URL(url, "http://localhost");
      const projectParam = parsed.searchParams.get("project");
      const body =
        projectParam !== null
          ? { ok: true, events: eventsByKey[projectParam] ?? [] }
          : { ok: true, events: homeEvents };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    const scopedPlansMatch = /\/api\/v2\/projects\/([^/?]+)\/plans/.exec(url);
    if (scopedPlansMatch !== null) {
      const key = decodeURIComponent(scopedPlansMatch[1]!);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, plans: plansByKey[key] ?? [] }),
      } as Response;
    }
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ ok: true, plans: homePlans }) } as Response;
    }
    if (url.includes("/api/v2/projects")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, projects: opts.projects }) } as Response;
    }
    if (url.includes("/api/v2/agents")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, agents: [] }) } as Response;
    }
    if (url.includes("/api/v2/health")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, version: "2.0.0-test", counts: { events: 0 } }),
      } as Response;
    }
    throw new Error(`runs-retention-window.test.ts mountApp: unexpected fetch url ${url}`);
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?runsRetentionWindow=${cacheBust}`);

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

function paramsOf(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

/** The scoped `?project=<key>&limit=...` call, if any was made for `key`. */
function scopedEventsCall(key: string): string | undefined {
  return eventsCalls.find((u) => paramsOf(u).get("project") === key);
}

/** Any `/api/v2/events` call carrying NO `project` param — the old/HOME
 * collective shape. */
function bareCalls(): string[] {
  return eventsCalls.filter((u) => paramsOf(u).get("project") === null);
}

async function clickTab(name: string): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function renderedRunCardIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="event-card"]')).map(
    (el) => el.getAttribute("data-run-id") ?? "",
  );
}

// §S4 regression pin — home->workspace->home navigation helpers (mirrors
// tests/home-marker-parity.test.ts's badgeFor/clickBackToProjects
// convention, using the app-logo click instead of the "← projects" chip so
// the SAME element/onclick (`navigate("/")`, app.js ~L389-401) is exercised
// on both surfaces).
function badgeFor(name: string): HTMLElement {
  const badge = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="project-badge"]'),
  ).find((el) => (el.textContent ?? "").includes(name));
  if (badge === undefined) throw new Error(`project-badge not found for ${name}`);
  return badge;
}

function clickHomeLogo(): void {
  const logo = document.querySelector<HTMLElement>(".app-logo");
  if (logo === null) throw new Error(".app-logo not found");
  logo.click();
}

/** Declared-marker count (app-logic.mjs#timelineRows "declared-marker" rows,
 * app.js DeclaredMarkerRow) — requires BOTH a state.plans cycle AND a
 * linked state.events entry, so it directly exposes a state.events scope
 * regression even when state.plans is fully repopulated. */
function declaredMarkerCount(): number {
  return document.querySelectorAll('[data-testid="declared-marker"]').length;
}

// ── AC1 — the workspace events fetch is scoped + retention-limited ──────

describe("§S4 AC1 — workspace events fetch requests ?project=<key>&limit=<retention>", () => {
  test("a workspace project with retention:150 has its events call carry project=<key> AND limit=150 — never the bare ?limit=50", async () => {
    const key = "retain-150";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Retain 150", retention: 150 })],
      eventsByKey: { [key]: [] },
    });

    const call = scopedEventsCall(key);
    expect(call).toBeDefined();
    const params = paramsOf(call!);
    expect(params.get("project")).toBe(key);
    expect(params.get("limit")).toBe("150");

    // NEGATIVE — the old hardcoded all-projects call must never fire while
    // routed to a workspace.
    expect(bareCalls().length).toBe(0);
  });
});

// ── AC2 — retention actually governs the rendered Runs-tab count ────────

describe("§S4 AC2 — the Runs tab renders up to the project's OWN retention, not a slice of the old 50", () => {
  test("a workspace project with retention:150 and 120 of its own runs renders all 120 run cards — not capped at 50", async () => {
    const key = "retain-150-render";
    const runs = manyEvents(key, 120);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Retain 150 Render", retention: 150 })],
      eventsByKey: { [key]: runs },
    });

    await clickTab("Runs");

    const rendered = renderedRunCardIds();
    expect(rendered.length).toBe(120);
    // bound: every one of the 120 fixtures actually rendered (no silent
    // truncation to the old 50), and nothing foreign leaked in.
    for (const run of runs) {
      expect(rendered).toContain(run.id);
    }
  });
});

// ── AC3 — no retention set falls back to MANAGER_RETENTION_DEFAULT (100) ─

describe("§S4 AC3 — a project with no retention set falls back to the default (100)", () => {
  test("a workspace project with retention UNSET requests limit=100 in its events fetch", async () => {
    const key = "retain-default";
    await mountApp({
      pathname: `/p/${key}`,
      // No `retention` field at all — the fixture omits it entirely.
      projects: [project({ key, name: "Retain Default" })],
      eventsByKey: { [key]: [] },
    });

    const call = scopedEventsCall(key);
    expect(call).toBeDefined();
    const params = paramsOf(call!);
    expect(params.get("project")).toBe(key);
    expect(params.get("limit")).toBe("100");
  });
});

// ── AC4 — HOME keeps the unchanged collective ?limit=50 call ────────────

describe("§S4 AC4 — HOME still fetches the recent-N collective ?limit=50 (unchanged)", () => {
  test("on HOME (not a workspace route), the events fetch is byte-identical to the old collective call — no project param, limit=50", async () => {
    const key = "home-unaffected";
    await mountApp({
      pathname: "/",
      projects: [project({ key, name: "Home Unaffected", retention: 200 })],
      homeEvents: [],
    });

    // Byte-identical to today's hardcoded literal (app.js ~L161) — no
    // `project` param sneaks in on home, and the query string is untouched.
    expect(eventsCalls).toContain("/api/v2/events?limit=50");

    // NEGATIVE — no scoped/project-qualified events call was made for any
    // project while routed to home.
    expect(scopedEventsCall(key)).toBeUndefined();
    const bare = bareCalls();
    expect(bare.length).toBe(1);
    expect(bare[0]).toBe("/api/v2/events?limit=50");
  });
});

// ── §S4 regression (gate-caught) — CR-026 §S0 equivalence breaks ────────
//
// Root cause (confirmed in code, public/app.js): §S4 made `refetchCore`
// (app.js ~L164) surface-aware — a WORKSPACE landing replaces the SHARED
// `state.events` with that project's own scoped set. But `scopeChanged()`
// (app.js ~L101-111) only calls `refetchCore()` `if (state.route.page ===
// "workspace")` — NOT on a home landing. So a workspace->home navigation
// restores global PLANS (refetchPlans is unconditional) but leaves
// `state.events` scoped to the last-visited workspace's project. Home's
// declared-markers come from `state.events` (app-logic.mjs#timelineRows),
// not plans, so every OTHER project's declared-marker silently disappears
// after the round trip — the exact break the e2e CR-CRU-026 §S0 equivalence
// gate caught (home drops from 4 declared-markers to 1).
describe("§S4 regression — navigating workspace→home restores the GLOBAL events feed (CR-026 §S0 equivalence)", () => {
  test("home → workspace → home renders the SAME declared-marker count as the cold-load baseline", async () => {
    const keyA = "s4nav-a";
    const keyB = "s4nav-b";
    const now = Date.now();
    const t0 = now - 500_000;

    const planA: PlanFixture = {
      planId: 1,
      projectKey: keyA,
      cr: "CR-S4NAV-A",
      status: "open",
      cycles: [{ id: 901, label: "s4nav a cycle", status: "done", activatedAt: t0, doneAt: t0 + 200_000 }],
    };
    const planB: PlanFixture = {
      planId: 2,
      projectKey: keyB,
      cr: "CR-S4NAV-B",
      status: "open",
      cycles: [{ id: 902, label: "s4nav b cycle", status: "done", activatedAt: t0, doneAt: t0 + 200_000 }],
    };

    const eventA = runEvent({
      id: "evt-s4nav-a-1",
      projectKey: keyA,
      agentId: "agent-s4nav-a",
      timestamp: now,
      context: { cycleId: 901 },
    });
    const eventB = runEvent({
      id: "evt-s4nav-b-1",
      projectKey: keyB,
      agentId: "agent-s4nav-b",
      timestamp: now + 10,
      context: { cycleId: 902 },
    });

    await mountApp({
      pathname: "/",
      projects: [project({ key: keyA, name: "S4Nav A" }), project({ key: keyB, name: "S4Nav B" })],
      // Cold-load HOME (the bare ?limit=50 call) sees BOTH projects.
      homeEvents: [eventA, eventB],
      // A workspace visit sees ONLY that project's own ?project=<key>
      // scoped events — the §S4 fix this file otherwise pins.
      eventsByKey: { [keyA]: [eventA], [keyB]: [eventB] },
      homePlans: [planA, planB],
      plansByKey: { [keyA]: [planA], [keyB]: [planB] },
    });

    const coldCount = declaredMarkerCount();
    // Sanity — the cold load actually produced declared markers for BOTH
    // projects (otherwise the equivalence check below would trivially
    // "pass" on two degenerate/empty counts).
    expect(coldCount).toBe(2);

    badgeFor("S4Nav A").click(); // home -> A's workspace (scopes state.events to A only)
    await settle();
    clickHomeLogo(); // A's workspace -> home (same Logo element/onclick both surfaces share)
    await settle();

    // §S4 regression pin — the home timeline must render the SAME
    // declared-marker count as the cold-load baseline (CR-026 §S0
    // equivalence). Against current production this FAILS: scopeChanged()
    // never re-fires refetchCore() for a home landing, so state.events
    // stays scoped to project A from the workspace visit and project B's
    // declared-marker vanishes (count drops to 1, not 2).
    expect(declaredMarkerCount()).toBe(coldCount);

    // Bound — pin the fetch-level root cause too: a home landing must
    // re-fire the global bare ?limit=50 events call (cold load + the
    // home-landing re-fetch), not rely on stale scoped data.
    expect(bareCalls().length).toBeGreaterThanOrEqual(2);
  });
});
