// CR-CRU-179 §S1 — "the cycle jump always lands". Spec: docs/changes/
// CR-CRU-179-the-cycle-jump-lands-and-history-drops-the-stale-agents-block.md.
//
// RED phase: both scenarios below are REPRODUCED DEFECTS against CURRENT
// production (public/app.js, this branch), confirmed in a real browser by
// this CR's gap analysis (2026-10-09):
//   1. `BoundaryToCycleBadge` (~app.js 6130) only ever opens the CR's own
//      lens key (`lensOpenOn(lensKey("cr", plan.cr))`) before calling
//      `revealCycleRow`. Since CR-CRU-173 History nests a closed CR's row
//      under a RELEASE row and a WAVE row that each start FOLDED unless
//      they are the newest — opening only the CR key never mounts a row
//      whose release or wave is folded, and `revealCycleRow`'s 30×5ms
//      retry budget gives up having never found it (gap analysis: "the
//      OLDEST badge on the timeline … does not [land] — its release and
//      wave are folded, the badge opens only the CR key").
//   2. On the All Projects view (`/`, `state.route.page === "home"`) the
//      badge sets `state.workspaceTab = "Workflow"` — a flag the home
//      surface never reads at all — and never calls `navigate()` to route
//      to the run's own project first. Clicking it today changes NOTHING:
//      the URL stays `/`, no workspace tab exists, no row (gap analysis:
//      "clicking one … changes nothing — the URL stays `/` … The badge
//      never routes to the run's project").
//
// This file is new-file-only RED: it does not touch
// tests/boundary-to-cycle-navigation.test.ts (CR-CRU-025's own file, which
// only ever exercises a SINGLE always-open release/wave via
// tests/helpers/history-stub.ts's `singleReleaseHistoryStub` and so never
// reaches either defect above — it stays a valid, UNCHANGED regression
// pin for the §S2 "⚑ Cycle" badge/reveal/blink contract this CR leaves
// intact for the open-release/open-wave/open-plan cases).
//
// RED-authored contract this file pins (reading the CR text + existing
// conventions `tests/workflow-history-release-tree.test.ts` and
// `tests/boundary-to-cycle-navigation.test.ts` already established):
//   - A closed CR's row lives under `[data-testid="history-release"]`
//     (`data-release`, `data-open`) > `[data-testid="wave-group"]`
//     (`data-wave`, `data-open`) > `[data-testid="cr-group"]`
//     (`data-cr`) > `[data-testid="lens-cycle-row"]`
//     (`data-cycle-id`) — the badge must drive EVERY containing level's
//     `data-open` to `"true"` (release, then wave; the CR group has no
//     `data-open` attribute of its own — its EXPANSION is instead proven
//     by its `lens-cycle-row` children actually existing in the DOM, the
//     same proof `tests/workflow-history-release-tree.test.ts` and
//     `tests/aggregate-headers.test.ts` already use for this element),
//     before scrolling + 10s-blinking the exact row (the SAME shared
//     `locateBlink` mechanism CR-CRU-025 §S2 already pins, verified here by
//     intercepting `setTimeout(fn, 10_000)` exactly as
//     tests/boundary-to-cycle-navigation.test.ts does — never a real sleep).
//   - On the home ("All Projects") surface, clicking the badge routes
//     (`navigate`, i.e. `history.pushState` + `state.route` update — proven
//     here by `location.pathname`) to `/p/<the run's own projectKey>`
//     BEFORE landing on the Workflow tab and revealing the row, exactly as
//     it already does when clicked from that project's own Runs tab.
//
// Harness: near-verbatim copy of tests/boundary-to-cycle-navigation.test.ts's
// happy-dom + real public/app.js / public/app-logic.mjs mount pattern,
// extended with (a) a per-project `/history` stub (so a fixture can declare
// MORE than one release/wave, unlike the shared single-release helper) and
// (b) the global `/api/v2/plans` route the home surface reads
// (CR-CRU-026 §S3.2) alongside the per-project one.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import type { HistoryStubResponse } from "./helpers/history-stub";

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

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
  historyByProject?: Record<string, HistoryStubResponse>;
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const historyMatch = /\/api\/v2\/projects\/([^/]+)\/history/.exec(url);
    const projectPlansMatch = /\/api\/v2\/projects\/([^/]+)\/plans/.exec(url);
    if (historyMatch) {
      const key = decodeURIComponent(historyMatch[1]!);
      body = opts.historyByProject?.[key] ?? { ok: true, releases: [] };
    } else if (projectPlansMatch) {
      const key = decodeURIComponent(projectPlansMatch[1]!);
      body = { ok: true, plans: opts.plans.filter((p) => p.projectKey === key) };
    } else if (/\/api\/v2\/plans(\?|$)/.test(url)) {
      // CR-CRU-026 §S3.2 — the home surface's GLOBAL plans read (every
      // non-archived project's plans), distinct from the project-scoped
      // route matched above.
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
      throw new Error(
        `boundary-to-cycle-across-folded-history-and-home.test.ts mountApp: unexpected fetch url ${url}`,
      );
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?boundaryToCycleHome=${cacheBust}`);

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

async function clickTab(name: string): Promise<HTMLElement> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
  return tab!;
}

function isActiveTab(name: string): boolean {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  return tab !== undefined && /\bon\b/.test(tab.className);
}

function declaredMarker(cycleId: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

/** Deadline-polls `predicate` instead of a fixed sleep (same convention as
 *  tests/v2-stream-paging.test.ts's `pollUntil`) — the landing this file
 *  pins crosses a project navigation, an async `/history` fetch and a
 *  nested release/wave/cr-group expansion, none of which is a single fixed
 *  retry budget this file should hardcode against GREEN's own internals. */
async function pollUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await settle(1);
    await Bun.sleep(intervalMs);
  }
}

/** Shared landing assertion — SAME scroll+10s-blink proof as
 *  tests/boundary-to-cycle-navigation.test.ts's
 *  `clickBoundaryBadgeAndAssertNavigateThenBlink`, generalised to poll
 *  (rather than a single `settle()`) for the target to mount, since this
 *  file's targets sit behind MORE async work (project routing, a `/history`
 *  fetch) than that file's always-open-release fixtures ever needed. */
async function clickBadgeAndAssertLanding(
  badge: HTMLElement,
  targetSelector: string,
): Promise<HTMLElement> {
  const scrollCalls: HTMLElement[] = [];
  const originalScrollIntoView = (
    HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }
  ).scrollIntoView;
  (HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void }).scrollIntoView =
    function (this: HTMLElement) {
      scrollCalls.push(this);
    };

  const originalSetTimeout = globalThis.setTimeout;
  const pendingBlinkClears: Array<() => void> = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 10_000) {
      pendingBlinkClears.push(() => fn(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(fn as TimerHandler, delay as number | undefined, ...args);
  }) as typeof setTimeout;

  try {
    badge.click();
    await settle();

    await pollUntil(() => isActiveTab("Workflow"));
    await pollUntil(() => document.querySelector(targetSelector) !== null);

    const target = document.querySelector<HTMLElement>(targetSelector);
    expect(target).not.toBeNull();

    // scrolled into view.
    expect(scrollCalls).toContain(target!);

    // a 10s blink-clear timer was scheduled.
    expect(pendingBlinkClears.length).toBeGreaterThan(0);
    const blinkOnClasses = Array.from(target!.classList);

    const toRun = pendingBlinkClears.splice(0, pendingBlinkClears.length);
    for (const cb of toRun) cb();
    await settle();

    const refreshed = document.querySelector<HTMLElement>(targetSelector);
    expect(refreshed).not.toBeNull();
    const blinkOffClasses = Array.from(refreshed!.classList);
    expect(blinkOffClasses.length).toBeLessThan(blinkOnClasses.length);
    for (const c of blinkOffClasses) expect(blinkOnClasses).toContain(c);

    return refreshed!;
  } finally {
    (HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }).scrollIntoView =
      originalScrollIntoView;
    globalThis.setTimeout = originalSetTimeout;
  }
}

// ── §S1 — a FOLDED (non-newest) release + wave, from the project's own Runs tab ──

describe("§S1 cycle jump — a closed CR's row under a FOLDED release and wave (project Runs tab)", () => {
  test("clicking ⚑ Cycle on the OLDEST declared marker opens its release, its wave AND its cr-group (none of them newest, none open by default), then scrolls+blinks the exact lens-cycle-row", async () => {
    const key = "cr179-folded-runs-1";
    const now = Date.now();
    const oldCycleId = 305001;
    const newCycleId = 305002;

    const oldRun = runEvent({
      id: "evt-cr179-folded-old-run",
      projectKey: key,
      agentId: "agent-old",
      timestamp: now - 3_600_000,
      context: { cycleId: oldCycleId },
    });
    const newRun = runEvent({
      id: "evt-cr179-folded-new-run",
      projectKey: key,
      agentId: "agent-new",
      timestamp: now,
      context: { cycleId: newCycleId },
    });

    const oldPlan: PlanFixture = {
      planId: 30501,
      cr: "CR-179-OLD-1",
      projectKey: key,
      status: "closed",
      wave: "5",
      merge: { commit: "cr179oldsha" },
      cycles: [{ id: oldCycleId, label: "c1 red-green", status: "done" }],
    };
    const newPlan: PlanFixture = {
      planId: 30502,
      cr: "CR-179-NEW-1",
      projectKey: key,
      status: "closed",
      wave: "9",
      merge: { commit: "cr179newsha" },
      cycles: [{ id: newCycleId, label: "c1 red-green", status: "done" }],
    };

    // Two releases: 0.2.0 (newest — starts OPEN) wraps the NEW cr/wave; 0.1.0
    // (older — starts FOLDED) wraps the OLD cr/wave the badge targets. The
    // server answers newest-first (array order), per CR-CRU-173's own
    // convention (tests/workflow-history-release-tree.test.ts).
    const history: HistoryStubResponse = {
      ok: true,
      releases: [
        {
          labels: ["0.2.0"],
          state: "in progress",
          crCount: 1,
          waves: [{ wave: "9", crs: ["CR-179-NEW-1"] }],
          workflows: [{ label: "0.2.0", gateRuns: [], verificationRuns: 0 }],
        },
        {
          labels: ["0.1.0"],
          state: "shipped",
          crCount: 1,
          waves: [{ wave: "5", crs: ["CR-179-OLD-1"] }],
          workflows: [{ label: "0.1.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR179 Folded Runs" })],
      events: [oldRun, newRun],
      plans: [oldPlan, newPlan],
      historyByProject: { [key]: history },
    });
    await clickTab("Runs");

    const marker = declaredMarker(oldCycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    const row = await clickBadgeAndAssertLanding(
      badge!,
      `[data-testid="lens-cycle-row"][data-cycle-id="${oldCycleId}"]`,
    );

    // The OLD release (not newest) is open.
    const releaseRow = document.querySelector<HTMLElement>(
      '[data-testid="history-release"][data-release="0.1.0"]',
    );
    expect(releaseRow).not.toBeNull();
    expect(releaseRow!.getAttribute("data-open")).toBe("true");

    // The NEWEST release (0.2.0) is UNAFFECTED — still its own default-open
    // self, not forced closed by this badge's own opening of the other one.
    const newestReleaseRow = document.querySelector<HTMLElement>(
      '[data-testid="history-release"][data-release="0.2.0"]',
    );
    expect(newestReleaseRow).not.toBeNull();
    expect(newestReleaseRow!.getAttribute("data-open")).toBe("true");

    // The OLD wave (5, not index 0 within its release — "9" outranks "5"
    // numerically) is open, nested under the OLD release.
    const waveRow = releaseRow!.querySelector<HTMLElement>(
      '[data-testid="wave-group"][data-wave="5"]',
    );
    expect(waveRow).not.toBeNull();
    expect(waveRow!.getAttribute("data-open")).toBe("true");

    // The cr-group is expanded — proven the same way
    // tests/aggregate-headers.test.ts / tests/workflow-history-release-tree.
    // test.ts already prove a lens group's expansion: its cycle row child
    // actually exists in the DOM (a collapsed `cr-group` renders zero
    // `lens-cycle-row` children, CR-CRU-020 §S1.2).
    const crGroup = waveRow!.querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-179-OLD-1"]',
    );
    expect(crGroup).not.toBeNull();
    expect(crGroup!.contains(row)).toBe(true);
    expect(row.getAttribute("data-cycle-id")).toBe(String(oldCycleId));
  });
});

// ── §S1 — the All Projects view routes to the run's project first ──────────

describe("§S1 cycle jump — the All Projects Run Timeline routes to the run's OWN project before landing", () => {
  test("clicking ⚑ Cycle on a declared marker in the All Projects timeline navigates from `/` to `/p/<the run's projectKey>`, lands on Workflow, and scrolls+blinks the exact lens-cycle-row — today the badge changes nothing at all (gap analysis, 2026-10-09)", async () => {
    const keyA = "cr179-home-route-a";
    const keyB = "cr179-home-route-b";
    const now = Date.now();
    const cycleId = 400001;

    const linkedRun = runEvent({
      id: "evt-cr179-home-route-run",
      projectKey: keyA,
      agentId: "agent-home",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 40001,
      cr: "CR-179-HOME-1",
      projectKey: keyA,
      status: "closed",
      wave: "3",
      merge: { commit: "cr179homesha" },
      cycles: [{ id: cycleId, label: "c1 red-green", status: "done" }],
    };
    // A single release/wave — "newest", starts OPEN — isolates the ROUTING
    // defect (gap analysis's literal repro: "clicking one (cycle 651)
    // changes nothing" happened even though that cycle's own release/wave
    // were already open; this test reproduces exactly that case).
    const history: HistoryStubResponse = {
      ok: true,
      releases: [
        {
          labels: ["0.5.0"],
          state: "in progress",
          crCount: 1,
          waves: [{ wave: "3", crs: ["CR-179-HOME-1"] }],
          workflows: [{ label: "0.5.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    };

    await mountApp({
      pathname: "/",
      projects: [
        project({ key: keyA, name: "CR179 Home Route A" }),
        project({ key: keyB, name: "CR179 Home Route B" }),
      ],
      events: [linkedRun],
      plans: [plan],
      historyByProject: { [keyA]: history },
    });

    // Home has no workspace tabs at all — the never-routed starting point.
    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="workspace-tab"]')).toBeNull();

    const marker = declaredMarker(cycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    const row = await clickBadgeAndAssertLanding(
      badge!,
      `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
    );

    // Routed to the RUN's OWN project — never project B, never left on `/`.
    expect(location.pathname).toBe(`/p/${keyA}`);
    expect(row.getAttribute("data-cycle-id")).toBe(String(cycleId));
  });
});

// ── §S1 — All Projects AND a folded release/wave, combined ─────────────────

describe("§S1 cycle jump — the All Projects view onto a FOLDED release/wave (both defects at once)", () => {
  test("clicking ⚑ Cycle from `/` for a cycle whose release and wave are BOTH folded routes to its project, opens the release and the wave, then scrolls+blinks its exact row", async () => {
    const key = "cr179-home-folded-1";
    const now = Date.now();
    const oldCycleId = 500001;
    const newCycleId = 500002;

    const oldRun = runEvent({
      id: "evt-cr179-home-folded-old-run",
      projectKey: key,
      agentId: "agent-old",
      timestamp: now - 3_600_000,
      context: { cycleId: oldCycleId },
    });
    const newRun = runEvent({
      id: "evt-cr179-home-folded-new-run",
      projectKey: key,
      agentId: "agent-new",
      timestamp: now,
      context: { cycleId: newCycleId },
    });
    const oldPlan: PlanFixture = {
      planId: 50001,
      cr: "CR-179-HFOLD-OLD-1",
      projectKey: key,
      status: "closed",
      wave: "2",
      merge: { commit: "cr179hfoldoldsha" },
      cycles: [{ id: oldCycleId, label: "c1 red-green", status: "done" }],
    };
    const newPlan: PlanFixture = {
      planId: 50002,
      cr: "CR-179-HFOLD-NEW-1",
      projectKey: key,
      status: "closed",
      wave: "7",
      merge: { commit: "cr179hfoldnewsha" },
      cycles: [{ id: newCycleId, label: "c1 red-green", status: "done" }],
    };
    const history: HistoryStubResponse = {
      ok: true,
      releases: [
        {
          labels: ["0.4.0"],
          state: "in progress",
          crCount: 1,
          waves: [{ wave: "7", crs: ["CR-179-HFOLD-NEW-1"] }],
          workflows: [{ label: "0.4.0", gateRuns: [], verificationRuns: 0 }],
        },
        {
          labels: ["0.3.0"],
          state: "shipped",
          crCount: 1,
          waves: [{ wave: "2", crs: ["CR-179-HFOLD-OLD-1"] }],
          workflows: [{ label: "0.3.0", gateRuns: [], verificationRuns: 0 }],
        },
      ],
    };

    await mountApp({
      pathname: "/",
      projects: [project({ key, name: "CR179 Home Folded" })],
      events: [oldRun, newRun],
      plans: [oldPlan, newPlan],
      historyByProject: { [key]: history },
    });

    const marker = declaredMarker(oldCycleId);
    const badge = marker.querySelector<HTMLElement>('[data-testid="boundary-to-cycle"]');
    expect(badge).not.toBeNull();

    const row = await clickBadgeAndAssertLanding(
      badge!,
      `[data-testid="lens-cycle-row"][data-cycle-id="${oldCycleId}"]`,
    );

    expect(location.pathname).toBe(`/p/${key}`);

    const releaseRow = document.querySelector<HTMLElement>(
      '[data-testid="history-release"][data-release="0.3.0"]',
    );
    expect(releaseRow).not.toBeNull();
    expect(releaseRow!.getAttribute("data-open")).toBe("true");

    const waveRow = releaseRow!.querySelector<HTMLElement>(
      '[data-testid="wave-group"][data-wave="2"]',
    );
    expect(waveRow).not.toBeNull();
    expect(waveRow!.getAttribute("data-open")).toBe("true");

    const crGroup = waveRow!.querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-179-HFOLD-OLD-1"]',
    );
    expect(crGroup).not.toBeNull();
    expect(crGroup!.contains(row)).toBe(true);
  });
});
