// The landing-tab rule: opening a project lands on the Roadmap tab when the
// project has no open plan and no gate in flight, and on the Workflow tab
// when it has either. A URL that already names a tab (a Roadmap route, a run
// overlay, a `?release=` filter) keeps opening that tab regardless of the
// idle/busy state; leaving the Roadmap route's URL segment re-applies the
// SAME idle/busy rule rather than falling back to a hard-coded tab.
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/roadmap-first-tab.test.ts /
// tests/workflow-gate-widget.test.ts: real VanJS/VanX vendor bundles, real
// public/app-logic.mjs, real public/app.js; `fetch` is scripted so the
// project/plans/events/queue/releases reads this harness controls resolve
// before `mountApp` returns (see `settle()` below) — assertions below read
// the FINAL settled state, never a frame mid-fetch.
//
// RED: today `public/app.js`'s `state.workspaceTab` boots hard-coded to
// "Workflow" (module scope) and `navigate()`'s `!sameSurface` branch does the
// same on every surface change — neither reads `state.plans` or
// `state.events` at all, so every scenario below that expects the Roadmap
// pane for an idle project fails against current production.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { FakeEventSource } from "./helpers/stream-workspace-harness";

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

// ── Fixtures ─────────────────────────────────────────────────────────────

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
  status: string;
}

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
  wave?: string;
  cycles: CycleFixture[];
}

interface GateStepFixture {
  name: string;
  status: string;
}

interface GateEventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "gate";
  codec: "no-mistakes";
  timestamp: number;
  context?: { wave?: string };
  gate: {
    intent: string;
    outcome: "checks-passed" | "passed" | "failed" | "cancelled";
    steps: GateStepFixture[];
    inFlight?: boolean;
  };
}

interface RunBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
}

interface RunDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree?: Array<{
    name: string;
    status: "pass" | "fail" | "pending";
    children: Array<{ name: string; status: "pass" | "fail" | "pending"; duration_ms: number }>;
  }>;
}

type EventFixture = GateEventFixture | RunBriefFixture;

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

function openPlan(key: string, cr: string, planId: number): PlanFixture {
  return {
    planId,
    cr,
    projectKey: key,
    status: "open",
    cycles: [{ id: planId * 10, label: "C1", status: "active" }],
  };
}

function inFlightGate(key: string, id: string, timestamp: number): GateEventFixture {
  return {
    id,
    projectKey: key,
    agentId: "orchestrator-landing-1",
    kind: "gate",
    codec: "no-mistakes",
    timestamp,
    context: { wave: "1" },
    gate: {
      intent: "wave 1 no-mistakes gate (in flight)",
      outcome: "checks-passed",
      steps: [
        { name: "intent", status: "passed" },
        { name: "review", status: "running" },
      ],
      inFlight: true,
    },
  };
}

function runFixtures(eventId: string, projectKey: string, now: number): { detail: RunDetailFixture; brief: RunBriefFixture } {
  const detail: RunDetailFixture = {
    id: eventId,
    projectKey,
    agentId: "landing-agent",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
    tree: [{ name: "Suite", status: "pass", children: [{ name: "leaf", status: "pass", duration_ms: 5 }] }],
  };
  const brief: RunBriefFixture = {
    id: eventId,
    projectKey,
    agentId: "landing-agent",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    total: 1,
    passed: 1,
    failed: 0,
    pending: 0,
    duration_ms: 10,
    hasCoverage: false,
  };
  return { detail, brief };
}

interface MountOpts {
  pathname?: string;
  search?: string;
  projects: ProjectFixture[];
  plans?: PlanFixture[];
  events?: EventFixture[];
  eventDetails?: Record<string, RunDetailFixture>;
  /** Install a scriptable stream (happy-dom has no EventSource) so a test
   *  can drive the page's normal refresh path with a stream frame. The
   *  fixture lists above are read at fetch time, so a test reassigns them
   *  before dispatching the frame. */
  withStream?: boolean;
}

interface Mounted {
  /** Every URL the page fetched, in order. */
  readonly fetchLog: string[];
  /** The page's one live stream (only with `withStream`). */
  stream(): FakeEventSource;
}

let cacheBust = 0;
let installedEventSource = false;

async function mountApp(opts: MountOpts): Promise<Mounted> {
  const pathname = opts.pathname ?? "/";
  const search = opts.search ?? "";
  const fetchLog: string[] = [];
  let live: FakeEventSource | null = null;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}${search}` });
  document.body.innerHTML = '<div id="app"></div>';

  const globalWithFetch = globalThis as unknown as { fetch: typeof fetch };
  const scriptedFetch = (async (url: string) => {
    fetchLog.push(url);
    let body: unknown;
    const eventDetailMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isEventsListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventDetailMatch !== null && !isEventsListEndpoint) {
      const id = decodeURIComponent(eventDetailMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`project-landing-pane.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
      }
      body = { ok: true, event: detail };
    } else if (/\/api\/v2\/projects\/[^/]+\/queue/.test(url)) {
      body = { ok: true, entries: [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/release-proposals/.test(url)) {
      body = { ok: true, proposals: [], totalCount: 0 };
    } else if (/\/api\/v2\/projects\/[^/]+\/releases/.test(url)) {
      body = { ok: true, releases: [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans ?? [] };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`project-landing-pane.test.ts mountApp: unexpected fetch url ${url}`);
    }
    const response = { ok: true, status: 200, json: async () => body } as Response;
    return response;
  }) as typeof fetch;
  globalWithFetch.fetch = scriptedFetch;

  if (opts.withStream === true) {
    installedEventSource = true;
    (globalThis as unknown as { EventSource: unknown }).EventSource = class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        live = this;
      }
    };
  }

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?projectLandingPane=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();

  return {
    fetchLog,
    stream: () => {
      if (live === null) {
        throw new Error("project-landing-pane.test.ts mountApp: no stream — mount with `withStream: true`");
      }
      return live;
    },
  };
}

/** Real macrotask ticks — see tests/helpers/dom-settle.ts header for why a
 *  fixed sleep buys nothing a bare yield does not already give. By the time
 *  `mountApp` returns, every fetch this harness scripts (projects, plans,
 *  events, queue, releases) has resolved and VanJS has committed its
 *  reactive bindings, so every assertion below reads the pane the project's
 *  FINAL plan/gate state settles on, not a frame mid-boot. */
async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  if (installedEventSource) {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    installedEventSource = false;
  }
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").trim() === text,
  ) as HTMLElement | undefined;
}

function tabButton(name: string): HTMLElement | undefined {
  return findByText(document, '[data-testid="workspace-tab"]', name);
}

function tabIsOn(name: string): boolean {
  const tab = tabButton(name);
  return tab !== undefined && tab.classList.contains("on");
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────
// Cold `/p/<key>` load and badge entry — the idle-project pin
// ─────────────────────────────────────────────────────────────────────────

describe("opening an idle project", () => {
  test("a cold direct URL load with no open plan and no gate in flight lands on the Roadmap pane, Workflow off, pathname unchanged", async () => {
    const key = "landing-idle-cold-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Idle Cold Project" })],
    });

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).not.toBeNull();
    // NEGATIVE: the Workflow pane did not mount on arrival.
    expect(document.querySelector('[data-testid="workflow-active"]')).toBeNull();
    // The landing is a STATE swap, not a route — the address bar stays bare
    // (mirrors how the pre-existing Workflow default never appended a
    // segment either).
    expect(window.location.pathname).toBe(`/p/${key}`);
  });

  test("picking an idle project from the projects list (the top-bar badge) lands the workspace on the Roadmap pane, not Workflow", async () => {
    const key = "landing-idle-badge-1";
    await mountApp({
      pathname: "/",
      projects: [project({ key, name: "Idle Badge Project" })],
    });

    const badge = document.querySelector('[data-testid="project-badge"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    badge!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workflow-active"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Busy projects still land on Workflow — each paired with the idle pin so
// the companion ("this keeps working") half cannot pass vacuously: it is
// asserted in the SAME test as the genuinely new behaviour, so the test can
// only pass once BOTH halves hold.
// ─────────────────────────────────────────────────────────────────────────

describe("opening a busy project", () => {
  test("a project with an open plan still lands on the Workflow pane with that plan's CR shown, even though an otherwise-identical idle project lands on Roadmap", async () => {
    const busyKey = "landing-busy-openplan-1";
    await mountApp({
      pathname: `/p/${busyKey}`,
      projects: [project({ key: busyKey, name: "Busy Open Plan Project" })],
      plans: [openPlan(busyKey, "LAND-PLAN-1", 501)],
    });
    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);
    const header = document.querySelector('[data-testid="workflow-active-header"]');
    expect(textOf(header)).toBe("Active workflow — LAND-PLAN-1");
    expect(document.querySelector('[data-testid="roadmap-empty"]')).toBeNull();

    // The pin: an idle twin of the same fixture lands on Roadmap instead.
    const idleKey = "landing-idle-openplan-twin-1";
    await mountApp({
      pathname: `/p/${idleKey}`,
      projects: [project({ key: idleKey, name: "Idle Twin Project" })],
    });
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
  });

  test("a project with no open plan but a gate in flight still lands on the Workflow pane, even though an otherwise-identical idle project lands on Roadmap", async () => {
    const busyKey = "landing-busy-gateinflight-1";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${busyKey}`,
      projects: [project({ key: busyKey, name: "Busy Gate In Flight Project" })],
      events: [inFlightGate(busyKey, "evt-landing-gate-1", now)],
    });
    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).toBeNull();
    // §S2/AC3 migration — a gate in flight is something REAL running, so
    // Now shows its F21 gate view, never the retired "no open plan" filler
    // and never the "nothing running" line (something genuinely is).
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(document.querySelector('[data-testid="gate-pane"]')).not.toBeNull();
    expect(textOf(body).toLowerCase()).not.toContain("no open plan");
    expect(textOf(body)).not.toBe("Nothing running \u2192 Roadmap");

    // The pin: an idle twin (no plan, no gate at all) lands on Roadmap.
    const idleKey = "landing-idle-gateinflight-twin-1";
    await mountApp({
      pathname: `/p/${idleKey}`,
      projects: [project({ key: idleKey, name: "Idle Twin Project 2" })],
    });
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A URL naming a tab keeps opening that tab regardless of idle/busy state —
// each paired with a pin so the "unaffected" half cannot pass vacuously.
// ─────────────────────────────────────────────────────────────────────────

describe("a URL that already names a tab", () => {
  test("a direct Roadmap-route load opens Roadmap on both an idle and a busy project, and leaving that URL segment on an idle project returns to Roadmap rather than falling back to Workflow", async () => {
    const busyKey = "landing-route-roadmap-busy-1";
    await mountApp({
      pathname: `/p/${busyKey}/roadmap`,
      projects: [project({ key: busyKey, name: "Busy Roadmap Route Project" })],
      plans: [openPlan(busyKey, "LAND-PLAN-2", 502)],
    });
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(location.pathname).toBe(`/p/${busyKey}/roadmap`);

    const idleKey = "landing-route-roadmap-idle-1";
    await mountApp({
      pathname: `/p/${idleKey}`,
      projects: [project({ key: idleKey, name: "Idle Roadmap Route Project" })],
    });
    // The named route wins even though the state-only default (just pinned
    // above) already agrees for this idle project.
    tabButton("Roadmap")!.click();
    await settle();
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(location.pathname).toBe(`/p/${idleKey}/roadmap`);

    // THE PIN — leave the segment via a real browser Back (popstate), the
    // one path `roadmapTabFollows` governs with no explicit tab chosen
    // afterward. Today it hard-codes "Workflow"; the idle/busy rule says an
    // idle project returns to Roadmap instead.
    history.back();
    await settle();
    expect(location.pathname).toBe(`/p/${idleKey}`);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).not.toBeNull();
  });

  test("a cold run-overlay deep link opens the overlay with the tab strip parked on an idle project exactly as on a busy one, and its back chip already names Roadmap — not Workflow — before anything is closed", async () => {
    const now = Date.now();

    const busyKey = "landing-rundeeplink-busy-1";
    const busyFx = runFixtures("evt-landing-busy-1", busyKey, now);
    await mountApp({
      pathname: `/p/${busyKey}/run/${busyFx.detail.id}`,
      projects: [project({ key: busyKey, name: "Busy Run Deep Link Project" })],
      plans: [openPlan(busyKey, "LAND-PLAN-3", 503)],
      events: [busyFx.brief],
      eventDetails: { [busyFx.detail.id]: busyFx.detail },
    });
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();
    expect(textOf(findByText(document, "button, a", "← workflow") ?? null)).toBe("← workflow");

    const idleKey = "landing-rundeeplink-idle-1";
    const idleFx = runFixtures("evt-landing-idle-1", idleKey, now);
    await mountApp({
      pathname: `/p/${idleKey}/run/${idleFx.detail.id}`,
      projects: [project({ key: idleKey, name: "Idle Run Deep Link Project" })],
      events: [idleFx.brief],
      eventDetails: { [idleFx.detail.id]: idleFx.detail },
    });
    // The overlay opens regardless of idle/busy state — unaffected.
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();

    // THE PIN — the underlying tab beneath the overlay was already computed
    // from the idle project's plan/gate state at boot, not left at the
    // hard-coded "Workflow" the chip reads today.
    const backChip = findByText(document, "button, a", "← roadmap");
    expect(backChip).toBeDefined();
    expect(textOf(backChip ?? null)).toBe("← roadmap");

    backChip!.click();
    await settle();
    expect(location.pathname).toBe(`/p/${idleKey}`);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workflow-active"]')).toBeNull();
  });

  test("a `?release=` deep link lands on the Runs tab on an idle project exactly as on a busy one, even though the same idle project with no query lands on Roadmap", async () => {
    const key = "landing-release-query-1";
    await mountApp({
      pathname: `/p/${key}`,
      search: "?release=0.1.0",
      projects: [project({ key, name: "Idle Release Query Project" })],
    });
    expect(tabIsOn("Runs")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);
    expect(tabIsOn("Workflow")).toBe(false);

    // THE PIN — the bare URL (no `?release=`) on the SAME idle shape lands
    // on Roadmap instead of the `?release=` twin's Runs or the hard-coded
    // Workflow.
    const bareKey = "landing-release-query-bare-1";
    await mountApp({
      pathname: `/p/${bareKey}`,
      projects: [project({ key: bareKey, name: "Idle No Query Project" })],
    });
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Runs")).toBe(false);
    expect(tabIsOn("Workflow")).toBe(false);
  });
});

// "Busy" here means the project has an open plan or a gate in flight.
// "Idle" means it has neither. The landing rule picks a tab only on the way
// in. Once a project is open, turning busy or idle never moves the user's
// tab. Each test drives the page's normal refresh path: a stream "events"
// frame triggers a re-read of the events list and plans. A fetch-log check
// first confirms that the re-read actually happened, so the "tab stayed
// put" assertion cannot pass just because nothing was refreshed.
// ─────────────────────────────────────────────────────────────────────────

function readsOf(fetchLog: readonly string[], pattern: RegExp): number {
  return fetchLog.filter((url) => pattern.test(url)).length;
}

const PLANS_READ = /\/api\/v2\/projects\/[^/?]+\/plans/;
const EVENTS_LIST_READ = /\/api\/v2\/events(\?|$)/;

describe("a project that turns busy or idle while it is open", () => {
  test("an idle project opened on the Roadmap keeps the Roadmap tab when an open plan arrives through a refresh", async () => {
    const key = "landing-turns-busy-plan-1";
    const opts: MountOpts = {
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Turns Busy Plan Project" })],
      withStream: true,
    };
    const mounted = await mountApp(opts);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);

    const plansReadsBefore = readsOf(mounted.fetchLog, PLANS_READ);
    opts.plans = [openPlan(key, "LAND-PLAN-ARRIVES", 601)];
    mounted.stream().open();
    mounted.stream().dispatch("events", key);
    await settle();

    // The refresh re-read the plans and saw the open plan.
    expect(readsOf(mounted.fetchLog, PLANS_READ)).toBeGreaterThan(plansReadsBefore);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(location.pathname).toBe(`/p/${key}`);

    // The new plan is on the page: opening Workflow by hand shows it.
    tabButton("Workflow")!.click();
    await settle();
    expect(textOf(document.querySelector('[data-testid="workflow-active-header"]'))).toBe(
      "Active workflow \u2014 LAND-PLAN-ARRIVES",
    );
  });

  test("a busy project opened on Workflow keeps the Workflow tab when its plan closes through a refresh", async () => {
    const key = "landing-turns-idle-plan-1";
    const opts: MountOpts = {
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Turns Idle Plan Project" })],
      plans: [openPlan(key, "LAND-PLAN-CLOSES", 602)],
      withStream: true,
    };
    const mounted = await mountApp(opts);
    expect(tabIsOn("Workflow")).toBe(true);
    expect(textOf(document.querySelector('[data-testid="workflow-active-header"]'))).toBe(
      "Active workflow \u2014 LAND-PLAN-CLOSES",
    );

    const plansReadsBefore = readsOf(mounted.fetchLog, PLANS_READ);
    opts.plans = [{ ...openPlan(key, "LAND-PLAN-CLOSES", 602), status: "closed" }];
    mounted.stream().open();
    mounted.stream().dispatch("events", key);
    await settle();

    expect(readsOf(mounted.fetchLog, PLANS_READ)).toBeGreaterThan(plansReadsBefore);
    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);
    // The plan's closing is on the page: the Workflow pane now shows its
    // empty state, not the old plan's header.
    expect(document.querySelector('[data-testid="workflow-active-header"]')).toBeNull();
    // §S2/AC3 2026-10-08 re-pin (approved) — nothing is running at all (no open
    // plan, no gate event whatsoever), so Now reads the exact AC3 empty-state
    // line, never the retired "no open plan" filler. Read on Now's own
    // container (orchestrator-approved 2026-10-08) — `workspace-body` also
    // holds History and the Project pane.
    expect(textOf(document.querySelector('[data-testid="workflow-now"]'))).toBe(
      "Nothing running \u2192 Roadmap",
    );
    expect(document.querySelector('[data-testid="roadmap-empty"]')).toBeNull();
  });

  test("an idle project opened on the Roadmap keeps the Roadmap tab when a gate in flight appears through a refresh", async () => {
    const key = "landing-turns-busy-gate-1";
    const opts: MountOpts = {
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Turns Busy Gate Project" })],
      withStream: true,
    };
    const mounted = await mountApp(opts);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);

    const eventsReadsBefore = readsOf(mounted.fetchLog, EVENTS_LIST_READ);
    opts.events = [inFlightGate(key, "evt-landing-gate-arrives-1", Date.now())];
    mounted.stream().open();
    mounted.stream().dispatch("events", key);
    await settle();

    // The refresh re-read the events list, which now holds a gate in flight.
    expect(readsOf(mounted.fetchLog, EVENTS_LIST_READ)).toBeGreaterThan(eventsReadsBefore);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).not.toBeNull();
    expect(location.pathname).toBe(`/p/${key}`);
  });
});
