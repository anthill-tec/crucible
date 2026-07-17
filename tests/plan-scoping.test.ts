// CR-CRU-026 C1 — §S1 scope-aware plans lifecycle (route-change clear +
// immediate scoped refetch) + §S2 render guard (plans filtered by routed
// project).
//
// Spec: docs/changes/CR-CRU-026-patch-workspace-plan-scoping.md
//   §S0 — every timeline/workflow render is a PURE FUNCTION of (current
//     route, server data); no code path may let stale cross-surface plan
//     data influence a paint.
//   §S1 — any scope-changing route transition (home→workspace,
//     workspace→workspace with a different projectKey, workspace→home, and
//     the popstate equivalents) synchronously CLEARS state.plans and, when
//     landing on a workspace, immediately invokes refetchPlans() for the
//     NEW projectKey (plus the core refetch() slice). SSE/poll stays the
//     steady-state refresh; navigation no longer depends on it.
//   §S2 — the Workflow lens renders ONLY plans whose projectKey equals
//     state.route.projectKey; a plan-less workspace shows the existing
//     CR-011 empty state ("no open plan — file one via POST …").
//
// Current code facts (verified against public/app.js on this branch):
//   - navigate() (~L49) sets state.route with NO clear, NO fetch.
//   - the popstate handler (~L84-86) is EVEN THINNER: `state.route =
//     L.routeParse(location.pathname)` — no clear, no fetch, no tab reset.
//   - refetchPlans() (~L134) early-returns off-workspace and is invoked
//     ONLY from refetch() (poll timer / would-be SSE onopen/onmessage).
//   - WorkflowActive() (~L1799-1800) does
//     `state.plans.filter((p) => p.status === "open")` — NO projectKey
//     check at all.
//   - WorkflowHistory() (~L2051-2055) passes `plans: state.plans` (ALL
//     plans, unfiltered) into L.workflowLens() — only `events` is filtered
//     by projectKey there.
// So every pin below is expected to FAIL against current production: a
// route change never clears/refetches plans, and even if it did, both
// render paths would happily paint another project's plan data.
//
// Harness note: `typeof EventSource === "undefined"` under happy-dom
// (confirmed elsewhere — tests/inpane-liveness.test.ts header), so
// connectStream() always falls back to startPolling(), a plain
// `setInterval(refetch, 5000)`. This means "silencing the stream" is
// simply never waiting past that 5s tick — every pin below except the
// explicit regression pin (§7) settles on short ticks well under 5000ms,
// so no poll-driven refetch can be responsible for a passing assertion.
//
// Same mountApp/settle harness convention as tests/workflow-tab.test.ts /
// tests/projects-manager.test.ts: real VanJS/VanX vendor bundles, real
// public/app-logic.mjs, real public/app.js; `fetch` is scripted. Extended
// here with (a) a per-projectKey plans store (b) a call-count tracker
// keyed on the requested projectKey so "exactly one GET .../plans" is
// assertable, and (c) a per-key GATE so a specific plans response can be
// held pending — the mechanism this file uses to prove the clear happens
// BEFORE the new project's fetch resolves, not merely after.
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

// The real poll interval is a hard-coded 5000ms (public/app.js ~L153-154).
// Every pin except the explicit regression pin settles on ticks far below
// this, so it can never be the poll fallback quietly doing the work.
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

// NOTE: this is the new-for-C1 contract — every plan carries `projectKey`
// verbatim (src/types.ts:164, already a real server field). Existing test
// files (workflow-tab.test.ts, timeline-plan-integration.test.ts) predate
// this CR and never scripted a per-key-scoped plans endpoint, so their
// PlanFixture omits it; this file's mock is the FIRST to actually key the
// plans response by the requested projectKey and to carry the field
// end-to-end, which is exactly what §S2's render guard needs to check.
interface PlanFixture {
  planId: number | string;
  projectKey: string;
  cr: string;
  status: "open" | "closed";
  wave?: string;
  closedAt?: number;
  cycles: CycleFixture[];
}

interface PendingGate {
  promise: Promise<void>;
  release: () => void;
}

let cacheBust = 0;
let projectsState: ProjectFixture[] = [];
let plansByKey: Record<string, PlanFixture[]> = {};
let planFetchCalls: { key: string }[] = [];
let plansGates: Map<string, PendingGate> = new Map();

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

/** Holds the NEXT `GET /api/v2/projects/<key>/plans` response for `key`
 * pending until `releasePlans(key)` is called — the mechanism used to
 * observe the DOM in the window between a route change and that route's
 * own scoped fetch resolving. */
function gatePlans(key: string): void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  plansGates.set(key, { promise, release });
}

function releasePlans(key: string): void {
  const gate = plansGates.get(key);
  if (gate !== undefined) {
    gate.release();
    plansGates.delete(key);
  }
}

function planCallCount(key: string): number {
  return planFetchCalls.filter((c) => c.key === key).length;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  plans: Record<string, PlanFixture[]>;
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  projectsState = opts.projects.map((p) => ({ ...p }));
  plansByKey = { ...opts.plans };
  planFetchCalls = [];
  plansGates = new Map();

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    const plansMatch = /\/api\/v2\/projects\/([^/?]+)\/plans/.exec(url);
    if (plansMatch !== null) {
      const key = decodeURIComponent(plansMatch[1]!);
      planFetchCalls.push({ key });
      const gate = plansGates.get(key);
      if (gate !== undefined) await gate.promise;
      const body = { ok: true, plans: plansByKey[key] ?? [] };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/projects")) {
      const body = { ok: true, projects: projectsState };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/agents")) {
      const body = { ok: true, agents: [] };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/events")) {
      const body = { ok: true, events: [] };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes("/api/v2/health")) {
      const body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    throw new Error(`plan-scoping.test.ts mountApp: unexpected fetch url ${url}`);
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?planScoping=${cacheBust}`);

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
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (el) => (el.textContent ?? "").trim() === text,
  );
}

function badgeFor(name: string): HTMLElement {
  const badge = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="project-badge"]'),
  ).find((el) => (el.textContent ?? "").includes(name));
  if (badge === undefined) throw new Error(`project-badge not found for ${name}`);
  return badge;
}

function clickBackToProjects(): void {
  const chip = findByText(document, "button", "← projects");
  if (chip === undefined) throw new Error('"← projects" chip not found');
  chip.click();
}

/** All `data-cr` values currently rendered anywhere in the document —
 * covers BOTH `workflow-cr-root` (Active section) and `cr-group` (History
 * section), the two render paths §S2 must guard. */
function renderedCrs(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-cr]")).map(
    (el) => el.getAttribute("data-cr") ?? "",
  );
}

function workflowActiveText(): string {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-active"]');
  return (el?.textContent ?? "").toLowerCase();
}

// ── 1. Workspace→workspace: synchronous clear + exactly-one scoped fetch,
//       no SSE frame needed ─────────────────────────────────────────────

describe("§S1 — workspace A → workspace B: synchronous clear + exactly one scoped fetch", () => {
  test("A's plan content never appears once B's workspace is reached — even DURING B's own scoped fetch — and exactly one GET fires for B, with no SSE/poll frame delivered", async () => {
    const keyA = "scope-nav-a";
    const keyB = "scope-nav-b";
    const planA: PlanFixture = {
      planId: 1,
      projectKey: keyA,
      cr: "CR-NAV-A",
      status: "open",
      cycles: [{ id: 1, label: "c1", status: "active" }],
    };
    const planB: PlanFixture = {
      planId: 2,
      projectKey: keyB,
      cr: "CR-NAV-B",
      status: "open",
      cycles: [{ id: 2, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${keyA}`,
      projects: [project({ key: keyA, name: "Nav A" }), project({ key: keyB, name: "Nav B" })],
      plans: { [keyA]: [planA], [keyB]: [planB] },
    });

    // Loaded: A's plan is visible before we do anything.
    expect(renderedCrs()).toContain("CR-NAV-A");
    expect(planCallCount(keyA)).toBe(1);
    expect(planCallCount(keyB)).toBe(0);

    // Gate B's scoped fetch BEFORE triggering the transition so we can
    // inspect the DOM in the window where B's fetch is in flight but
    // unresolved — the only way to prove the clear is NOT gated on the new
    // fetch completing.
    gatePlans(keyB);

    clickBackToProjects(); // workspace A → home
    await settle();
    badgeFor("Nav B").click(); // home → workspace B
    await settle(); // short ticks only — nowhere near the 5000ms poll tick

    // B's own fetch is still pending (gated) — yet A's content must
    // already be gone: the clear cannot be waiting on B's response.
    expect(planCallCount(keyB)).toBe(1);
    expect(renderedCrs()).not.toContain("CR-NAV-A");

    releasePlans(keyB);
    await settle();

    // B's data has now arrived; A never reappears; exactly one call was
    // made for B — no duplicate fetch, no SSE/poll frame involved.
    expect(renderedCrs()).toContain("CR-NAV-B");
    expect(renderedCrs()).not.toContain("CR-NAV-A");
    expect(planCallCount(keyB)).toBe(1);
  });
});

// ── 2. Zero-plan workspace: CR-011 empty state, previous project's
//       active section AND history groups both absent ───────────────────

describe("§S1+§S2 — navigating to a plan-less workspace clears the previous project's Active AND History content", () => {
  test("project A's open plan (Active) and closed plan (History) are both gone once B (zero plans) is reached; B shows the CR-011 empty state", async () => {
    const keyA = "scope-empty-a";
    const keyB = "scope-empty-b";
    const t0 = Date.now() - 60_000;
    const planAOpen: PlanFixture = {
      planId: 3,
      projectKey: keyA,
      cr: "CR-EMPTY-A-OPEN",
      status: "open",
      cycles: [{ id: 3, label: "c1", status: "active" }],
    };
    const planAClosed: PlanFixture = {
      planId: 4,
      projectKey: keyA,
      cr: "CR-EMPTY-A-CLOSED",
      status: "closed",
      closedAt: t0 + 1000,
      cycles: [{ id: 4, label: "c1", status: "done", activatedAt: t0, doneAt: t0 + 1000 }],
    };

    await mountApp({
      pathname: `/p/${keyA}`,
      projects: [project({ key: keyA, name: "Empty A" }), project({ key: keyB, name: "Empty B" })],
      plans: { [keyA]: [planAOpen, planAClosed], [keyB]: [] },
    });

    // Both sections populated on A before navigating away.
    expect(renderedCrs()).toContain("CR-EMPTY-A-OPEN");
    expect(renderedCrs()).toContain("CR-EMPTY-A-CLOSED");
    expect(document.querySelectorAll('[data-testid="wave-group"]').length).toBeGreaterThan(0);

    clickBackToProjects();
    await settle();
    badgeFor("Empty B").click();
    await settle();

    expect(planCallCount(keyB)).toBe(1);
    // CR-011 empty state, testid sweep — neither of A's sections survive.
    expect(workflowActiveText()).toContain("no open plan");
    expect(renderedCrs()).not.toContain("CR-EMPTY-A-OPEN");
    expect(renderedCrs()).not.toContain("CR-EMPTY-A-CLOSED");
    expect(document.querySelectorAll('[data-testid="wave-group"]').length).toBe(0);
    expect(document.querySelectorAll('[data-testid="cr-group"]').length).toBe(0);
    expect(document.querySelectorAll('[data-testid="workflow-cr-root"]').length).toBe(0);
  });
});

// ── 3. Blank-view face: home → OWN workspace, empty state.plans, stream
//       silenced — the navigation fetch alone must suffice ───────────────

describe("§S1 — blank-view face: home → a project's OWN workspace renders its plan without any SSE/poll frame", () => {
  test("cold at home (no plans fetched at all), clicking the project's badge renders its plan content from the navigation-triggered fetch alone", async () => {
    const key = "scope-blank-a";
    const plan: PlanFixture = {
      planId: 5,
      projectKey: key,
      cr: "CR-BLANK-A",
      status: "open",
      cycles: [{ id: 5, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: "/",
      projects: [project({ key, name: "Blank A" })],
      plans: { [key]: [plan] },
    });

    // On home, refetchPlans() early-returns (not a workspace) — zero plan
    // calls have happened yet, for anyone.
    expect(planCallCount(key)).toBe(0);

    badgeFor("Blank A").click(); // home → /p/<key>
    await settle(); // short ticks — well under the 5000ms poll interval

    // The navigation fetch alone rendered the plan; no SSE/poll frame was
    // ever given the chance to run.
    expect(planCallCount(key)).toBe(1);
    expect(renderedCrs()).toContain("CR-BLANK-A");
  });
});

// ── 4. popstate parity: back/forward across two workspaces re-scopes
//       IDENTICALLY to a click-driven transition ─────────────────────────

describe("§S1 — popstate parity: browser back/forward across two workspaces clears + scopes-fetches per transition", () => {
  test("dispatching popstate to workspace B then back to workspace A each clear the OTHER project's content and fire exactly one NEW scoped fetch", async () => {
    const keyA = "scope-pop-a";
    const keyB = "scope-pop-b";
    const planA: PlanFixture = {
      planId: 6,
      projectKey: keyA,
      cr: "CR-POP-A",
      status: "open",
      cycles: [{ id: 6, label: "c1", status: "active" }],
    };
    const planB: PlanFixture = {
      planId: 7,
      projectKey: keyB,
      cr: "CR-POP-B",
      status: "open",
      cycles: [{ id: 7, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${keyA}`,
      projects: [project({ key: keyA, name: "Pop A" }), project({ key: keyB, name: "Pop B" })],
      plans: { [keyA]: [planA], [keyB]: [planB] },
    });

    expect(renderedCrs()).toContain("CR-POP-A");
    const aCallsAtStart = planCallCount(keyA);
    const bCallsAtStart = planCallCount(keyB);

    // Simulate the browser navigating forward to B's workspace URL (address
    // bar edit / forward button) — the popstate path, NOT navigate().
    history.pushState(null, "", `/p/${keyB}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();

    expect(planCallCount(keyB)).toBe(bCallsAtStart + 1);
    expect(renderedCrs()).not.toContain("CR-POP-A");
    expect(renderedCrs()).toContain("CR-POP-B");

    // Simulate back to A.
    history.pushState(null, "", `/p/${keyA}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();

    expect(planCallCount(keyA)).toBe(aCallsAtStart + 1);
    expect(renderedCrs()).not.toContain("CR-POP-B");
    expect(renderedCrs()).toContain("CR-POP-A");
  });
});

// ── 5. Render guard: a plan whose projectKey ≠ routed key renders NOTHING,
//       even when correctly-scoped plans are present alongside it ────────

describe("§S2 — render guard: a foreign-projectKey plan never paints, in either section", () => {
  test("Active: a plan tagged for another project renders nothing while the routed project's OWN plan still renders", async () => {
    const routedKey = "scope-guard-b";
    const foreignKey = "scope-guard-a";
    const ownPlan: PlanFixture = {
      planId: 8,
      projectKey: routedKey,
      cr: "CR-GUARD-OWN",
      status: "open",
      cycles: [{ id: 8, label: "c1", status: "active" }],
    };
    // Defense-in-depth scenario per §S2: this plan carries a projectKey
    // that does NOT match the routed project, e.g. surviving a race —
    // fetched from the routed project's OWN scoped endpoint, but tagged
    // for a different project than the one the URL requested.
    const foreignPlan: PlanFixture = {
      planId: 9,
      projectKey: foreignKey,
      cr: "CR-GUARD-FOREIGN",
      status: "open",
      cycles: [{ id: 9, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${routedKey}`,
      projects: [project({ key: routedKey, name: "Guard B" })],
      plans: { [routedKey]: [ownPlan, foreignPlan] },
    });

    expect(renderedCrs()).toContain("CR-GUARD-OWN");
    expect(renderedCrs()).not.toContain("CR-GUARD-FOREIGN");
    // bound: no cycle-row leaks from the foreign plan either.
    const foreignRoot = document.querySelector('[data-testid="workflow-cr-root"][data-cr="CR-GUARD-FOREIGN"]');
    expect(foreignRoot).toBeNull();
    // it must not have silently fallen into the empty state either — the
    // routed project's own plan is present, so the empty state must NOT
    // show.
    expect(workflowActiveText()).not.toContain("no open plan");
  });

  test("History: a CLOSED plan tagged for another project renders no wave/CR group, while the routed project's own closed plan still does", async () => {
    const routedKey = "scope-guard-hist-b";
    const foreignKey = "scope-guard-hist-a";
    const t0 = Date.now() - 60_000;
    const ownClosed: PlanFixture = {
      planId: 10,
      projectKey: routedKey,
      cr: "CR-GUARD-HIST-OWN",
      status: "closed",
      closedAt: t0 + 1000,
      cycles: [{ id: 10, label: "c1", status: "done", activatedAt: t0, doneAt: t0 + 1000 }],
    };
    const foreignClosed: PlanFixture = {
      planId: 11,
      projectKey: foreignKey,
      cr: "CR-GUARD-HIST-FOREIGN",
      status: "closed",
      closedAt: t0 + 1000,
      cycles: [{ id: 11, label: "c1", status: "done", activatedAt: t0, doneAt: t0 + 1000 }],
    };

    await mountApp({
      pathname: `/p/${routedKey}`,
      projects: [project({ key: routedKey, name: "Guard Hist B" })],
      plans: { [routedKey]: [ownClosed, foreignClosed] },
    });

    expect(renderedCrs()).toContain("CR-GUARD-HIST-OWN");
    expect(renderedCrs()).not.toContain("CR-GUARD-HIST-FOREIGN");
    expect(
      document.querySelector('[data-testid="cr-group"][data-cr="CR-GUARD-HIST-FOREIGN"]'),
    ).toBeNull();
  });
});

// ── 6. Scope-change to HOME clears stale workspace plans (isolated from
//       the §S2 render guard — same project revisited) ───────────────────

describe("§S1 — workspace → home clears stale plans (isolated from the render-guard backstop)", () => {
  test("revisiting the SAME workspace after a home stopover shows nothing stale while its fresh fetch is pending — proving the plans were cleared on the way through home, not merely re-guarded on arrival", async () => {
    const key = "scope-home-a";
    const plan: PlanFixture = {
      planId: 12,
      projectKey: key,
      cr: "CR-HOME-A",
      status: "open",
      cycles: [{ id: 12, label: "c1", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Home A" })],
      plans: { [key]: [plan] },
    });

    expect(renderedCrs()).toContain("CR-HOME-A");
    expect(planCallCount(key)).toBe(1);

    clickBackToProjects(); // workspace → home
    await settle();

    // Gate the SAME project's re-fetch before revisiting it: since the
    // projectKey is IDENTICAL on the way back in, the §S2 render guard
    // (projectKey match) cannot be the thing hiding stale content here —
    // only an actual clear-on-navigate can. If state.plans were never
    // cleared while on home, the stale (matching-key) plan would render
    // immediately, before this second fetch ever resolves.
    gatePlans(key);
    badgeFor("Home A").click(); // home → /p/<key> (same project, again)
    await settle();

    expect(planCallCount(key)).toBe(2); // a FRESH fetch fired, not a cache hit
    expect(renderedCrs()).not.toContain("CR-HOME-A"); // nothing stale in the interim
    expect(workflowActiveText()).toContain("no open plan");

    releasePlans(key);
    await settle();

    expect(renderedCrs()).toContain("CR-HOME-A"); // the fresh fetch's data now renders
  });
});

// ── 7. Regression: SSE/poll cadence still refetches the CURRENT route's
//       plans (unrelated to the S1 navigation fix) ───────────────────────

describe("Regression — the steady-state poll/SSE cadence still refetches the CURRENT workspace's plans", () => {
  test(
    "a change delivered via the poll fallback (the only reachable liveness channel under happy-dom) still refreshes the routed project's plan data",
    async () => {
      const key = "scope-regress-a";
      const planV1: PlanFixture = {
        planId: 13,
        projectKey: key,
        cr: "CR-REGRESS-A",
        status: "open",
        cycles: [{ id: 13, label: "c1", status: "active" }],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Regress A" })],
        plans: { [key]: [planV1] },
      });

      expect(renderedCrs()).toContain("CR-REGRESS-A");
      const cyclePendingBefore = document.querySelector(
        '[data-testid="cycle-row"][data-status="active"]',
      );
      expect(cyclePendingBefore).not.toBeNull();

      // Mutate the SAME fixture object the mocked fetch reads live — the
      // identical live-mutation technique tests/inpane-liveness.test.ts and
      // tests/workflow-tab.test.ts already use for their own poll-tick
      // liveness pins.
      plansByKey[key] = [
        {
          ...planV1,
          cycles: [{ id: 13, label: "c1", status: "done", activatedAt: Date.now() - 1000, doneAt: Date.now() }],
        },
      ];

      await waitForPollTick();

      expect(planCallCount(key)).toBeGreaterThanOrEqual(2);
      expect(document.querySelector('[data-testid="cycle-row"][data-status="done"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="cycle-row"][data-status="active"]')).toBeNull();
    },
    POLL_TEST_TIMEOUT_MS,
  );
});
