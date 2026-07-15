// CR-CRU-016 §S1/§S2 (C1+C2 merged batch) — in-pane drill-in: the run detail
// becomes a PANE STATE of whichever central pane is active (home timeline /
// workspace Runs / Compile / Coverage), instead of the CR-007 right-hand
// slide-over sheet. Drives the REAL production public/app.js shell inside a
// happy-dom window — same harness pattern as tests/drill-in.test.ts /
// tests/density.test.ts: real VanJS/VanX vendor bundles, real
// public/app-logic.mjs, real public/app.js; `fetch` is scripted.
//
// RED phase: expected to fail against the CURRENT public/app.js, whose
// `RunOverlay()` (public/app.js:965) renders as a GLOBAL sibling of
// Home()/Workspace() (a fixed-position scrim + right-hand slide-over sheet,
// public/app.js:1438-1483) rather than swapping the content of whichever
// central pane is active; whose scroll-restore mechanism saves/restores
// `window.scrollY` (public/app.js:28,37,45-50) instead of the pane's own
// scroller `scrollTop`; and whose `jumpToNextFailure` (public/app.js:1283)
// only calls `row.scrollIntoView()` without focus-opening the target leaf's
// failure box.
//
// Contract this file pins for GREEN (CR-CRU-016-inpane-drill-in.md ACs 1-5 +
// the ONE RULE + the §S2 focus-model seam):
//   AC1 — a run-card click swaps THAT PANE's own content to the detail; the
//     Project pane (workspace) / home chrome never remounts (marker
//     attribute + reference-equality check).
//   AC2 — '← timeline' / Escape restore the pane's own scroller's EXACT
//     prior scrollTop (not window.scrollY).
//   AC3 — cold-loading a run route renders the detail nested inside the
//     active pane, with the surrounding chrome (Project pane / home chrome)
//     present.
//   AC4 — no `run-overlay-scrim` / `app-slideover-right` element exists
//     anywhere for run detail (DOM + source-grep).
//   ONE RULE — a Compile-tab card, the Coverage tab's `coverage-view-run`,
//     and the Project pane's coverage-meter all swap THEIR OWN active pane;
//     none of them switches the active workspace tab.
//   AC5 (context rules in-pane) — unit tier renders no `drillin-mode`;
//     regression tier renders Density (status-chips + heat-strip) — both
//     asserted against the in-pane container.
//   §S2 focus-model seam — the failures-footer jump advances to the NEXT
//     failing leaf, focus-opening its failure box and scrolling it into the
//     pane's viewport, deterministically across repeated jumps.
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

interface FailureFixture {
  message?: string;
  type?: string;
  trace?: string;
}
interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: FailureFixture;
}
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
}
interface DiagnosticFixture {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: "error" | "warning";
}
interface CompileFixture {
  format: string;
  errorCount: number;
  warningCount: number;
  diagnostics: DiagnosticFixture[];
  raw: string;
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
  compile?: CompileFixture;
  raw?: string;
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
  errors?: number;
  warnings?: number;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  latestGreenCoverage?: unknown;
  latestCoverageEventId?: string;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  events?: EventBriefFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
}

let cacheBust = 0;
let fetchLog: string[] = [];

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
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

/** Same mountApp harness pattern as tests/drill-in.test.ts. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';
  fetchLog = [];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    fetchLog.push(url);
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`inpane-drill-in.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
      }
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = (detail.tree ?? []).find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const tree = (detail.tree ?? []).map((n) => ({
          name: n.name,
          status: n.status,
          counts: suiteCounts(n.children),
        }));
        body = { ok: true, event: { ...detail, tree } };
      } else {
        body = { ok: true, event: detail };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects ?? [] };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`inpane-drill-in.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?inpaneDrillIn=${cacheBust}`);

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

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLElement | undefined;
}

function unitFixture(eventId: string, projectKey: string, now: number) {
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId: "inpane-agent",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 500 },
    tree: [
      {
        name: "SuiteOnly",
        status: "fail",
        children: [
          { name: "passLeaf", status: "pass", duration_ms: 5 },
          {
            name: "failLeaf",
            status: "fail",
            duration_ms: 6,
            failure: { message: "expected true to be false" },
          },
        ],
      },
    ],
  };
  const brief: EventBriefFixture = {
    id: eventId,
    projectKey,
    agentId: "inpane-agent",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    total: 2,
    passed: 1,
    failed: 1,
    pending: 0,
    duration_ms: 500,
    hasCoverage: false,
  };
  return { detail, brief };
}

function compileFixture(eventId: string, projectKey: string, now: number) {
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId: "inpane-compile-agent",
    kind: "compile",
    tier: "module",
    timestamp: now,
    compile: {
      format: "tsc",
      errorCount: 1,
      warningCount: 0,
      diagnostics: [{ file: "src/x.ts", line: 1, col: 1, message: "boom", level: "error" }],
      raw: "",
    },
  };
  const brief: EventBriefFixture = {
    id: eventId,
    projectKey,
    agentId: "inpane-compile-agent",
    kind: "compile",
    tier: "module",
    timestamp: now,
    errors: 1,
    warnings: 0,
  };
  return { detail, brief };
}

function regressionTwoFailuresFixture(eventId: string, projectKey: string, now: number) {
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId: "focus-agent",
    kind: "test",
    tier: "regression",
    codec: "junit",
    timestamp: now,
    summary: { total: 4, passed: 2, failed: 2, pending: 0, duration_ms: 900 },
    tree: [
      {
        name: "SuiteA",
        status: "fail",
        children: [
          { name: "aPass", status: "pass", duration_ms: 5 },
          { name: "aFail", status: "fail", duration_ms: 6, failure: { message: "A failed" } },
        ],
      },
      {
        name: "SuiteB",
        status: "fail",
        children: [
          { name: "bPass", status: "pass", duration_ms: 5 },
          { name: "bFail", status: "fail", duration_ms: 6, failure: { message: "B failed" } },
        ],
      },
    ],
  };
  const brief: EventBriefFixture = {
    id: eventId,
    projectKey,
    agentId: "focus-agent",
    kind: "test",
    tier: "regression",
    codec: "junit",
    timestamp: now,
    total: 4,
    passed: 2,
    failed: 2,
    pending: 0,
    duration_ms: 900,
    hasCoverage: false,
  };
  return { detail, brief };
}

// ────────────────────────────────────────────────────────────────────────
// AC1 — clicking a run card swaps THAT PANE's own content; the surrounding
// chrome (Project pane / home chrome) never remounts.
// ────────────────────────────────────────────────────────────────────────

describe("AC1 — a run-card click swaps the ACTIVE pane's own content to the detail (marker-attribute no-remount check)", () => {
  test("workspace Runs pane: the pane's own content swaps to the detail; the Project pane is the SAME DOM node throughout (marker attribute + reference equality)", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-ws-1";
    const projectKey = "proj-inpane-ws-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Inpane WS Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const projectPaneBefore = document.querySelector('[data-testid="project-pane"]') as HTMLElement | null;
    expect(projectPaneBefore).not.toBeNull();
    projectPaneBefore!.setAttribute("data-red-marker", "still-mounted");

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);

    // AC1 — the Runs pane's OWN content swapped: the feed card is gone,
    // replaced by the detail tree, as a DESCENDANT of the same pane (no
    // separate top-level overlay).
    const runsPane = document.querySelector('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(runsPane!.querySelector('[data-testid="event-card"]')).toBeNull();
    expect(runsPane!.querySelector('[data-testid="suite-row"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();

    // Marker-attribute technique (AC1) — the Project pane is the EXACT SAME
    // DOM node (never unmounted/remounted) while the central pane swapped.
    const projectPaneAfter = document.querySelector('[data-testid="project-pane"]') as HTMLElement | null;
    expect(projectPaneAfter).not.toBeNull();
    expect(projectPaneAfter).toBe(projectPaneBefore);
    expect(projectPaneAfter!.getAttribute("data-red-marker")).toBe("still-mounted");
    expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull();
  });

  test("home timeline pane behaves identically: the pane's own content swaps to the detail; home chrome (topbar + projects-row) never remounts", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-home-1";
    const projectKey = "proj-inpane-home-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: "/",
      projects: [project({ key: projectKey, name: "Inpane Home Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const topbarBefore = document.querySelector('[data-testid="app-topbar"]') as HTMLElement | null;
    expect(topbarBefore).not.toBeNull();
    topbarBefore!.setAttribute("data-red-marker", "home-still-mounted");

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();

    expect(location.pathname).toBe(`/run/${eventId}`);

    const timeline = document.querySelector('[data-testid="timeline"]');
    expect(timeline).not.toBeNull();
    expect(timeline!.querySelector('[data-testid="event-card"]')).toBeNull();
    expect(timeline!.querySelector('[data-testid="suite-row"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();

    const topbarAfter = document.querySelector('[data-testid="app-topbar"]') as HTMLElement | null;
    expect(topbarAfter).not.toBeNull();
    expect(topbarAfter).toBe(topbarBefore);
    expect(topbarAfter!.getAttribute("data-red-marker")).toBe("home-still-mounted");
    expect(document.querySelector('[data-testid="projects-row"]')).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// AC2 — '← timeline' / Escape restore the pane's OWN scroller's exact prior
// scrollTop (the gap-analysis trap: NOT window.scrollY).
// ────────────────────────────────────────────────────────────────────────

describe("AC2 — closing the detail restores the pane's own scroller's EXACT prior scrollTop", () => {
  test("'← timeline' restores the workspace Runs pane's scrollTop (not window.scrollY)", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-scroll-ws-1";
    const projectKey = "proj-inpane-scroll-ws-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Scroll WS Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const runsPaneBefore = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
    expect(runsPaneBefore).not.toBeNull();
    // The user scrolled the FEED itself (the pane's own scroller) — the
    // gap-analysis trap is a mechanism that instead tracks window.scrollY,
    // which this fixture never touches.
    runsPaneBefore.scrollTop = 240;

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();

    // Precondition: the pane's content actually swapped (guards this test
    // against trivially "passing" because nothing ever touched the pane).
    const runsPaneOpen = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
    expect(runsPaneOpen.querySelector('[data-testid="event-card"]')).toBeNull();

    const back = findByText(document, "button, a", "← timeline");
    expect(back).toBeDefined();
    back!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}`);
    const runsPaneAfter = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
    expect(runsPaneAfter.querySelector('[data-testid="event-card"]')).not.toBeNull();
    expect(runsPaneAfter.scrollTop).toBe(240);
  });

  test("Escape restores the home timeline pane's scrollTop with the exact same value", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-scroll-home-1";
    const projectKey = "proj-inpane-scroll-home-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: "/",
      projects: [project({ key: projectKey, name: "Scroll Home Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const timelineBefore = document.querySelector('[data-testid="timeline"]') as HTMLElement;
    expect(timelineBefore).not.toBeNull();
    timelineBefore.scrollTop = 180;

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();

    const timelineOpen = document.querySelector('[data-testid="timeline"]') as HTMLElement;
    expect(timelineOpen.querySelector('[data-testid="event-card"]')).toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();

    expect(location.pathname).toBe("/");
    const timelineAfter = document.querySelector('[data-testid="timeline"]') as HTMLElement;
    expect(timelineAfter.querySelector('[data-testid="event-card"]')).not.toBeNull();
    expect(timelineAfter.scrollTop).toBe(180);
  });
});

// ────────────────────────────────────────────────────────────────────────
// AC3 — cold-loading a run route renders the detail nested inside the
// active pane, with the surrounding chrome present.
// ────────────────────────────────────────────────────────────────────────

describe("AC3 — cold-loading a run route renders the in-pane detail with the surrounding chrome intact", () => {
  test("cold-loading /p/<key>/run/<id> renders the detail nested inside the workspace Runs pane, Project pane present", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-cold-ws-1";
    const projectKey = "proj-inpane-cold-ws-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [project({ key: projectKey, name: "Cold WS Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="project-pane"]')).not.toBeNull();
    const runsPane = document.querySelector('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(runsPane!.querySelector('[data-testid="suite-row"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();
  });

  test("cold-loading /run/<id> on home renders the detail nested inside the timeline pane, home chrome present", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-cold-home-1";
    const projectKey = "proj-inpane-cold-home-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/run/${eventId}`,
      projects: [project({ key: projectKey, name: "Cold Home Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    expect(document.querySelector('[data-testid="app-topbar"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="projects-row"]')).not.toBeNull();
    const timeline = document.querySelector('[data-testid="timeline"]');
    expect(timeline).not.toBeNull();
    expect(timeline!.querySelector('[data-testid="suite-row"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// AC4 — the slide-over/scrim contract is RETIRED for run detail.
// ────────────────────────────────────────────────────────────────────────

describe("AC4 — the slide-over/scrim contract is retired for run detail", () => {
  test("DOM: no run-overlay-scrim and no app-slideover-right element exists anywhere, whether opened from a card click or cold-loaded", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-retire-1";
    const projectKey = "proj-inpane-retire-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Retire Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();

    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();
    expect(document.querySelector(".app-slideover-right")).toBeNull();

    // cold-load case (separate mount).
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [project({ key: projectKey, name: "Retire Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();
    expect(document.querySelector(".app-slideover-right")).toBeNull();
  });

  test("source grep: public/app.js never references run-overlay-scrim or app-slideover-right", () => {
    const src = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
    expect(src).not.toContain("run-overlay-scrim");
    expect(src).not.toContain("app-slideover-right");
  });
});

// ────────────────────────────────────────────────────────────────────────
// ONE RULE (§S1, user-approved 2026-07-16) — a Compile-tab card, the
// Coverage tab's coverage-view-run, and the Project pane's coverage-meter
// all swap THEIR OWN active pane — none of them switches the active tab.
// ────────────────────────────────────────────────────────────────────────

describe("ONE RULE — a Compile/Coverage-tab card or the Project pane's coverage-meter swaps THAT pane, never switches the active tab", () => {
  test("from the workspace Compile tab, clicking a compile card swaps the COMPILE pane itself to the detail; the tab stays 'Compile' (no tab switch)", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-compile-1";
    const projectKey = "proj-inpane-compile-1";
    const fx = compileFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Compile Pane Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const compileTab = findByText(document, '[data-testid="workspace-tab"]', "Compile");
    expect(compileTab).toBeDefined();
    compileTab!.click();
    await settle();
    expect(compileTab!.classList.contains("on")).toBe(true);

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();

    // ONE RULE — no tab switch: "Compile" is STILL the active tab.
    const activeTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => t.classList.contains("on"));
    expect(activeTab?.textContent).toBe("Compile");

    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    const contentRegion = body!.firstElementChild;
    expect(contentRegion).not.toBeNull();
    expect(contentRegion!.querySelector('[data-testid="event-card"]')).toBeNull();
    expect(contentRegion!.querySelector('[data-testid="compile-status"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="project-pane"]')).not.toBeNull();
  });

  test("the Coverage tab's coverage-view-run swaps the COVERAGE pane itself; the tab stays 'Coverage' (no forced switch to Runs)", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-coverage-1";
    const projectKey = "proj-inpane-coverage-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        project({
          key: projectKey,
          name: "Coverage Pane Project",
          latestGreenCoverage: { lines: { covered: 8, total: 10, percent: 80 } },
          latestCoverageEventId: eventId,
        }),
      ],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const coverageTab = findByText(document, '[data-testid="workspace-tab"]', "Coverage");
    expect(coverageTab).toBeDefined();
    coverageTab!.click();
    await settle();
    expect(coverageTab!.classList.contains("on")).toBe(true);

    const viewRun = document.querySelector('[data-testid="coverage-view-run"]') as HTMLElement | null;
    expect(viewRun).not.toBeNull();
    viewRun!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);

    // ONE RULE — no forced switch to "Runs": "Coverage" is STILL the active
    // tab (today's public/app.js `navigate()` unconditionally resets
    // state.workspaceTab to "Runs" on every navigation — public/app.js:41).
    const activeTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => t.classList.contains("on"));
    expect(activeTab?.textContent).toBe("Coverage");

    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    const contentRegion = body!.firstElementChild;
    expect(contentRegion).not.toBeNull();
    expect(contentRegion!.querySelector('[data-testid="suite-row"]')).not.toBeNull();
  });

  test("the Project pane's coverage-meter click renders the detail in the ACTIVE central pane — clicking it while on the Compile tab does not switch to Runs", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-meter-1";
    const projectKey = "proj-inpane-meter-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        project({
          key: projectKey,
          name: "Meter Pane Project",
          latestGreenCoverage: { lines: { covered: 8, total: 10, percent: 80 } },
          latestCoverageEventId: eventId,
        }),
      ],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const compileTab = findByText(document, '[data-testid="workspace-tab"]', "Compile");
    expect(compileTab).toBeDefined();
    compileTab!.click();
    await settle();
    expect(compileTab!.classList.contains("on")).toBe(true);

    const meter = document
      .querySelector('[data-testid="project-pane"]')!
      .querySelector('[data-testid="coverage-meter"]') as HTMLElement | null;
    expect(meter).not.toBeNull();
    meter!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);

    // ONE RULE — the Project pane's coverage-meter click follows the SAME
    // rule as tab-owned cards: it renders in the ACTIVE central pane,
    // whichever tab that is — "Compile" stays active, not "Runs".
    const activeTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => t.classList.contains("on"));
    expect(activeTab?.textContent).toBe("Compile");

    expect(document.querySelector('[data-testid="run-overlay-scrim"]')).toBeNull();
    const body = document.querySelector('[data-testid="workspace-body"]');
    const contentRegion = body!.firstElementChild;
    expect(contentRegion!.querySelector('[data-testid="suite-row"]')).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// AC5 (context rules in-pane) — unit renders no drillin-mode; regression
// renders Density (chips + heat-strip) — both against the in-pane container.
// ────────────────────────────────────────────────────────────────────────

describe("AC5 context rules in-pane — unit renders no drillin-mode; regression renders Density, both against the in-pane container", () => {
  test("a unit-tier detail in-pane renders NO drillin-mode element anywhere", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-unit-ctx-1";
    const projectKey = "proj-inpane-unit-ctx-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [project({ key: projectKey, name: "Unit Ctx Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    // In-pane precondition — proves this is exercising the in-pane
    // container, not the retired global overlay.
    const runsPane = document.querySelector('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(runsPane!.querySelector('[data-testid="suite-row"]')).not.toBeNull();

    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
  });

  test("a regression-tier detail in-pane opens in Density — status-chips row + heat-strip render inside the in-pane container", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-regression-ctx-1";
    const projectKey = "proj-inpane-regression-ctx-1";
    const fx = regressionTwoFailuresFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [project({ key: projectKey, name: "Regression Ctx Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const runsPane = document.querySelector('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(runsPane!.querySelector('[data-testid="suite-row"]')).not.toBeNull();

    expect(runsPane!.querySelector('[data-testid="density-status-chips"]')).not.toBeNull();
    expect(runsPane!.querySelector('[data-testid="heat-strip"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// §S2 focus-model seam — the failures-footer jump advances to the NEXT
// failing leaf, focus-opening its failure box and scrolling it into the
// pane's viewport, deterministically across repeated jumps.
// ────────────────────────────────────────────────────────────────────────

describe("§S2 focus-model contract — failures-footer jump focus-opens each target's failure box and scrolls it into the pane's viewport", () => {
  test("two sequential jumps advance to two DIFFERENT failing leaves, each time opening exactly that leaf's failure box and calling scrollIntoView on its row", async () => {
    const now = Date.now();
    const eventId = "evt-inpane-focus-1";
    const projectKey = "proj-inpane-focus-1";
    const fx = regressionTwoFailuresFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}/run/${eventId}`,
      projects: [project({ key: projectKey, name: "Focus Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const pane = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement | null;
    expect(pane).not.toBeNull();
    // In-pane precondition — Density anatomy present inside the pane.
    expect(pane!.querySelector('[data-testid="density-status-chips"]')).not.toBeNull();

    const scrolled: HTMLElement[] = [];
    const HTMLElementCtor = (globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement;
    const originalScrollIntoView = HTMLElementCtor.prototype.scrollIntoView;
    HTMLElementCtor.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };

    try {
      const jumpBtn = pane!.querySelector('[data-testid="failure-jump"]') as HTMLElement | null;
      expect(jumpBtn).not.toBeNull();

      jumpBtn!.click();
      await settle();

      let boxes = Array.from(pane!.querySelectorAll('[data-testid="failure-box"]'));
      expect(boxes.length).toBe(1);
      const firstLeafRow = boxes[0]!.previousElementSibling as HTMLElement | null;
      expect(firstLeafRow?.getAttribute("data-testid")).toBe("leaf-row");
      const firstKey = firstLeafRow!.getAttribute("data-leaf-key");
      expect(firstKey).not.toBeNull();
      expect(scrolled.length).toBeGreaterThanOrEqual(1);
      expect(scrolled[scrolled.length - 1]!.getAttribute("data-leaf-key")).toBe(firstKey);

      jumpBtn!.click();
      await settle();

      boxes = Array.from(pane!.querySelectorAll('[data-testid="failure-box"]'));
      // The focus model shows exactly ONE open failure box at a time — the
      // second jump closes the first and opens the second, it does not
      // accumulate.
      expect(boxes.length).toBe(1);
      const secondLeafRow = boxes[0]!.previousElementSibling as HTMLElement | null;
      const secondKey = secondLeafRow!.getAttribute("data-leaf-key");
      expect(secondKey).not.toBeNull();
      expect(secondKey).not.toBe(firstKey);
      expect(scrolled[scrolled.length - 1]!.getAttribute("data-leaf-key")).toBe(secondKey);
    } finally {
      HTMLElementCtor.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
