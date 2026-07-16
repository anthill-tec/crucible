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
  // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now defaults
  // to the Workflow pane, not Runs (workspace default flips) — this test's
  // SUBJECT is Runs-pane behavior, so it now selects the Runs tab EXPLICITLY
  // after mount instead of relying on Runs being the cold-load default. Was:
  // asserted directly against the cold-load pane with no tab click.
  test("workspace Runs pane (Runs tab selected explicitly): the pane's own content swaps to the detail; the Project pane is the SAME DOM node throughout (marker attribute + reference equality)", async () => {
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

    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();
    expect(runsTab!.classList.contains("on")).toBe(true);

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
  // RE-TARGETED (§S1 tabs-hide + tab-in-header, CR's approved-modification
  // list): the workspace back chip's text is now tab-keyed (`← runs` on the
  // default Runs tab) instead of the retired constant `← timeline` — was
  // `findByText(document, "button, a", "← timeline")`. Home's chip stays
  // `← timeline` (see the AC2 Escape/home test below, unaffected).
  // SANCTIONED RE-TARGET (CR-CRU-021 §S1): cold `/p/<key>` now defaults to
  // Workflow, not Runs — this test's SUBJECT is the Runs pane's own scroller,
  // so it now selects the Runs tab EXPLICITLY after mount before touching
  // its scrollTop. Was: set scrollTop on workspace-runs immediately after
  // cold mount with no tab click.
  test("'← runs' restores the workspace Runs pane's scrollTop (not window.scrollY) — Runs tab selected explicitly", async () => {
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

    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();
    expect(runsTab!.classList.contains("on")).toBe(true);

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

    const back = findByText(document, "button, a", "← runs");
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

    // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
    // defaults to the Workflow pane, not Runs (workspace default flips) —
    // this test's SUBJECT is the retired-scrim contract from a Runs-pane
    // card click, so it now selects the Runs tab EXPLICITLY after mount
    // instead of relying on Runs being the cold-load default. Was: no tab
    // click, relied on cold load already showing the Runs pane's event-card.
    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();

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
// §S1 tabs-hide + tab-in-header (user decisions 2026-07-16, gate review):
// "the Runs/Coverage/Compile/BDD row is incongruent at the same level as
// the drill-down — the navigation conflicts" — while a detail is open,
// `data-testid="workspace-tabs"` is ABSENT from the DOM (for every entry:
// run card on any tab, coverage-meter, coverage-view-run, cold load) and
// the back chip's text names the ORIGIN tab (`← runs` / `← coverage` /
// `← compile`, lowercase); home's chip stays `← timeline`. Closing (chip,
// Escape, browser back) restores the tabs row with the previously-active
// tab still carrying the "on" class.
//
// RED phase: expected to fail against the CURRENT public/app.js, whose
// `WorkspaceTabs()` (public/app.js:649) is invoked unconditionally as a
// static child of `Workspace()` (:994-997) — never gated on
// `state.route.overlay` — and whose detail header (:1538-1540) hardcodes
// the back-chip text to the literal string "← timeline" regardless of
// `state.route.page`/`state.workspaceTab`.
// ────────────────────────────────────────────────────────────────────────

describe("§S1 tabs-hide + tab-in-header — workspace-tabs ABSENT while a detail is open; back chip names the origin tab", () => {
  // SANCTIONED RE-TARGET (CR-CRU-021 §S1): cold `/p/<key>` no longer defaults
  // to Runs (Workflow is now the default) — this test's SUBJECT is the
  // tabs-hide/back-chip behavior when Runs is the ORIGIN tab, so it now
  // selects the Runs tab EXPLICITLY after mount instead of relying on it
  // being the cold-load default. Was: "opening from the default Runs tab" —
  // renamed to "opening from the Runs tab (selected explicitly)".
  test("opening from the Runs tab (selected explicitly): workspace-tabs is ABSENT and the back chip reads '← runs'", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-runs-1";
    const projectKey = "proj-tabshide-runs-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Tabs-hide Runs Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    expect(document.querySelector('[data-testid="workspace-tabs"]')).not.toBeNull();

    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();
    expect(runsTab!.classList.contains("on")).toBe(true);

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← runs");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← runs");
    // Top bar + Project pane remain present throughout.
    expect(document.querySelector('[data-testid="workspace-header"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="project-pane"]')).not.toBeNull();
  });

  test("opening from the Compile tab: workspace-tabs is ABSENT and the back chip reads '← compile'", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-compile-1";
    const projectKey = "proj-tabshide-compile-1";
    const fx = compileFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Tabs-hide Compile Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const compileTab = findByText(document, '[data-testid="workspace-tab"]', "Compile");
    expect(compileTab).toBeDefined();
    compileTab!.click();
    await settle();

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← compile");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← compile");
  });

  test("opening via the Coverage tab's coverage-view-run: workspace-tabs is ABSENT and the back chip reads '← coverage'", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-coverage-1";
    const projectKey = "proj-tabshide-coverage-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        project({
          key: projectKey,
          name: "Tabs-hide Coverage Project",
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

    const viewRun = document.querySelector('[data-testid="coverage-view-run"]') as HTMLElement;
    expect(viewRun).not.toBeNull();
    viewRun.click();
    await settle();

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← coverage");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← coverage");
  });

  test("opening via the Project pane's coverage-meter while the Compile tab is active: workspace-tabs is ABSENT and the back chip reads '← compile' (ONE RULE — origin is the ACTIVE tab, not the click source)", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-meter-1";
    const projectKey = "proj-tabshide-meter-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        project({
          key: projectKey,
          name: "Tabs-hide Meter Project",
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

    const meter = document
      .querySelector('[data-testid="project-pane"]')!
      .querySelector('[data-testid="coverage-meter"]') as HTMLElement | null;
    expect(meter).not.toBeNull();
    meter!.click();
    await settle();

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← compile");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← compile");
  });

  // SANCTIONED RE-TARGET (CR-CRU-021 §S1): this test asserted that a cold
  // `/p/<key>/run/<id>` load DEFAULTS its close-target to Runs — that exact
  // "cold-load-close" contract is now AC3, fully re-pinned (against the new
  // Workflow default) by tests/workflow-primary-tab.test.ts ("§S1 AC3 —
  // cold /p/<key>/run/<id> load closes back to the Workflow pane"). Rather
  // than duplicate that coverage with a Workflow-flavored expectation here,
  // CONVERTED to the explicit-Runs-click form (rule 1): mounts the workspace
  // cold, selects the Runs tab EXPLICITLY, then navigates directly to the
  // run URL via history.pushState + a real popstate dispatch (the PRODUCTION
  // popstate listener — same technique as the "browser back" test below).
  // This keeps distinct coverage (a URL-driven navigation into a run route,
  // not a card click) while being origin-agnostic to whichever tab is the
  // cold-load DEFAULT. Was: "cold-loading a workspace run URL defaults to
  // Runs" (mounted the run URL cold with no explicit tab selection).
  test("navigating directly to a workspace run URL while the Runs tab is explicitly active: workspace-tabs is ABSENT and the back chip reads '← runs'", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-cold-1";
    const projectKey = "proj-tabshide-cold-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Tabs-hide Cold Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();
    expect(runsTab!.classList.contains("on")).toBe(true);

    history.pushState(null, "", `/p/${projectKey}/run/${eventId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← runs");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← runs");
  });

  // CR-CRU-016 §S1 AC (C5 red addendum, coordinator note 2026-07-16) — the
  // §S1 AC explicitly lists "transition marker" among the tabs-hide entry
  // points. On the WORKSPACE, clicking a marker must open the GREEN run's
  // detail IN-PANE ON THE WORKSPACE (route `/p/<key>/run/<greenId>`, tabs
  // ABSENT, chip `← runs`) — not bounce to the bare home-style `/run/<id>`
  // route. (Home markers keep their existing `/run/<id>` behavior — already
  // covered by tests/transition-markers.test.ts, not duplicated here.)
  //
  // RED phase: expected to fail on the route assertion — `TransitionMarkerRow`
  // (public/app.js ~529-538) calls `navigate(`/run/${greenEvent.id}`)`
  // directly, bypassing `openDrillin`'s workspace-prefix logic (public/app.js
  // ~455-462), so clicking a marker on the workspace ALWAYS lands on the
  // bare `/run/<id>` route (home surface) regardless of where it was
  // clicked from.
  // SANCTIONED RE-TARGET (CR-CRU-021 §S1): cold `/p/<key>` no longer defaults
  // to Runs — this test's SUBJECT is the Runs pane's transition-marker +
  // scroll-restore behavior, so it now selects the Runs tab EXPLICITLY after
  // mount before touching the Runs pane's scrollTop or asserting it's 'on'
  // after close. Was: set scrollTop on workspace-runs before any tab click.
  test("workspace (Runs tab selected explicitly): clicking a transition-marker row opens the GREEN run's detail IN-PANE ON THE WORKSPACE (route /p/<key>/run/<greenId>, tabs ABSENT, chip '← runs'); closing restores the Runs tab + feed", async () => {
    const now = Date.now();
    const projectKey = "proj-tabshide-marker-1";
    const redId = "evt-tabshide-marker-red-1";
    const greenId = "evt-tabshide-marker-green-1";

    const redBrief: EventBriefFixture = {
      id: redId,
      projectKey,
      agentId: "CR-TABSHIDE-1-RED",
      kind: "test",
      tier: "unit",
      timestamp: now - 45_000,
      total: 5,
      passed: 3,
      failed: 2,
      pending: 0,
      duration_ms: 1000,
      hasCoverage: false,
    };
    const greenBrief: EventBriefFixture = {
      id: greenId,
      projectKey,
      agentId: "CR-TABSHIDE-1-GREEN",
      kind: "test",
      tier: "unit",
      timestamp: now,
      total: 5,
      passed: 5,
      failed: 0,
      pending: 0,
      duration_ms: 1200,
      hasCoverage: false,
    };
    const greenDetail: EventDetailFixture = {
      id: greenId,
      projectKey,
      agentId: "CR-TABSHIDE-1-GREEN",
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 1200 },
      tree: [{ name: "SuiteOnly", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] }],
    };

    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Tabs-hide Marker Project" })],
      events: [redBrief, greenBrief],
      eventDetails: { [greenId]: greenDetail },
    });

    const runsTabBefore = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTabBefore).toBeDefined();
    runsTabBefore!.click();
    await settle();
    expect(runsTabBefore!.classList.contains("on")).toBe(true);

    const marker = document.querySelector('[data-testid="transition-marker"]') as HTMLElement | null;
    expect(marker).not.toBeNull();

    const runsPaneBefore = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
    runsPaneBefore.scrollTop = 90;

    marker!.click();
    await settle();

    // The bug this pins: today this lands on the bare `/run/<id>` route
    // (home surface), not the workspace-prefixed one.
    expect(location.pathname).toBe(`/p/${projectKey}/run/${greenId}`);
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← runs");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← runs");
    expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull();

    backChip!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}`);
    const tabsRow = document.querySelector('[data-testid="workspace-tabs"]');
    expect(tabsRow).not.toBeNull();
    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab).toBeDefined();
    expect(runsTab!.classList.contains("on")).toBe(true);
    const runsPaneAfter = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
    expect(runsPaneAfter.scrollTop).toBe(90);
  });

  test("home is unaffected: opening a detail on home keeps the back chip reading '← timeline' (workspace-tabs never exists on home)", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-home-1";
    const projectKey = "proj-tabshide-home-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: "/",
      projects: [project({ key: projectKey, name: "Tabs-hide Home Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← timeline");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← timeline");
  });
});

describe("§S1 tabs-hide + tab-in-header — closing (chip / Escape / browser back) restores workspace-tabs with the previously-active tab still 'on'", () => {
  // SANCTIONED RE-TARGET (CR-CRU-021 §S1): cold `/p/<key>` no longer defaults
  // to Runs — this test's SUBJECT is the back-chip's restore-to-Runs
  // behavior, so it now selects the Runs tab EXPLICITLY after mount before
  // touching the Runs pane's scrollTop. Was: set scrollTop on
  // workspace-runs and asserted the Runs tab 'on' after close, both with no
  // prior tab click.
  test("closing via the back chip (Runs tab selected explicitly): workspace-tabs reappears with the Runs tab 'on' and the feed's exact prior scrollTop restored", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-close-chip-1";
    const projectKey = "proj-tabshide-close-chip-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Tabs-hide Close Chip Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const runsTabBefore = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTabBefore).toBeDefined();
    runsTabBefore!.click();
    await settle();
    expect(runsTabBefore!.classList.contains("on")).toBe(true);

    const runsPaneBefore = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
    runsPaneBefore.scrollTop = 150;

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();

    const backChip = findByText(document, "button, a", "← runs");
    expect(backChip).toBeDefined();
    backChip!.click();
    await settle();

    const tabsRow = document.querySelector('[data-testid="workspace-tabs"]');
    expect(tabsRow).not.toBeNull();
    const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
    expect(runsTab).toBeDefined();
    expect(runsTab!.classList.contains("on")).toBe(true);

    const runsPaneAfter = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement;
    expect(runsPaneAfter.scrollTop).toBe(150);
  });

  test("closing via Escape from the Compile tab: workspace-tabs reappears with the Compile tab still 'on'", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-close-esc-1";
    const projectKey = "proj-tabshide-close-esc-1";
    const fx = compileFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Tabs-hide Close Escape Project" })],
      events: [fx.brief],
      eventDetails: { [eventId]: fx.detail },
    });

    const compileTab = findByText(document, '[data-testid="workspace-tab"]', "Compile");
    expect(compileTab).toBeDefined();
    compileTab!.click();
    await settle();

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    card.click();
    await settle();
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();

    const tabsRow = document.querySelector('[data-testid="workspace-tabs"]');
    expect(tabsRow).not.toBeNull();
    const activeTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => t.classList.contains("on"));
    expect(activeTab?.textContent).toBe("Compile");
  });

  test("closing via browser back (popstate): workspace-tabs reappears with the Coverage tab still 'on'", async () => {
    const now = Date.now();
    const eventId = "evt-tabshide-close-back-1";
    const projectKey = "proj-tabshide-close-back-1";
    const fx = unitFixture(eventId, projectKey, now);
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        project({
          key: projectKey,
          name: "Tabs-hide Close Back Project",
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

    const viewRun = document.querySelector('[data-testid="coverage-view-run"]') as HTMLElement;
    viewRun.click();
    await settle();
    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();

    // Simulate a real "browser back": the address bar lands back on the
    // workspace path and a popstate event fires — exercising the
    // PRODUCTION popstate listener (public/app.js: `window.addEventListener
    // ("popstate", () => { state.route = L.routeParse(location.pathname);
    // })`), not a hand-rolled bypass of it.
    history.pushState(null, "", `/p/${projectKey}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}`);
    const tabsRow = document.querySelector('[data-testid="workspace-tabs"]');
    expect(tabsRow).not.toBeNull();
    const activeTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => t.classList.contains("on"));
    expect(activeTab?.textContent).toBe("Coverage");
  });
});

// ────────────────────────────────────────────────────────────────────────
// §S1 header-always-visible (user note 2026-07-16 board round): "when there
// are so many items in the drill down, this bar will scroll out of view
// now. Navigation elements should always be visible!" — the detail header
// (back chip · RUN DETAIL · density chip) must NOT be a descendant of the
// drill-down's scroll container: on the workspace it renders in the band
// the hidden tabs row vacates; on home it's pinned above the pane's
// scroller. With a 10 000-leaf fixture scrolled to a large scrollTop, the
// SAME header node stays mounted, unaffected by the scroller's scrollTop.
//
// RED phase: expected to fail against the CURRENT public/app.js RunDetail()
// (~public/app.js:1531-1560), which returns ONE div — `app-drillin-head`
// header then body — mounted directly as the pane's own child
// (`WorkspaceRuns`/`Timeline` render `paneSwap(...)`'s return value, i.e.
// the WHOLE run-overlay div incl. its header, straight inside
// `workspace-runs`/`timeline`, public/app.js:624,703-707). The header is
// today a plain descendant of that same scrolling pane element, so it
// scrolls away with a long tree exactly as the user reported.
// ────────────────────────────────────────────────────────────────────────

function manyLeavesFixture(eventId: string, projectKey: string, tier: string, now: number) {
  const BIG_SIZE = 300;
  const OTHER_SIZE = 200;
  const TOTAL = 10_000;

  const bigLeaves: LeafFixture[] = [];
  for (let i = 0; i < BIG_SIZE; i++) bigLeaves.push({ name: `big-${i}`, status: "pass", duration_ms: 5 });
  const suites: SuiteFixture[] = [{ name: "SuiteBig", status: "pass", children: bigLeaves }];

  let remaining = TOTAL - BIG_SIZE;
  let suiteIdx = 0;
  while (remaining > 0) {
    const size = Math.min(OTHER_SIZE, remaining);
    const leaves: LeafFixture[] = [];
    for (let i = 0; i < size; i++) leaves.push({ name: `o${suiteIdx}-${i}`, status: "pass", duration_ms: 5 });
    suites.push({ name: `SuiteOther${suiteIdx}`, status: "pass", children: leaves });
    remaining -= size;
    suiteIdx += 1;
  }

  const total = suites.reduce((sum, s) => sum + s.children.length, 0);
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId: "many-leaves-agent",
    kind: "test",
    tier,
    codec: "junit",
    timestamp: now,
    summary: { total, passed: total, failed: 0, pending: 0, duration_ms: 5000 },
    tree: suites,
  };
  const brief: EventBriefFixture = {
    id: eventId,
    projectKey,
    agentId: "many-leaves-agent",
    kind: "test",
    tier,
    codec: "junit",
    timestamp: now,
    total,
    passed: total,
    failed: 0,
    pending: 0,
    duration_ms: 5000,
    hasCoverage: false,
  };
  return { detail, brief, total };
}

describe("§S1 header-always-visible — the detail header is NOT a descendant of the drill-down's scroll container; stays mounted through a big scroll", () => {
  test(
    "workspace: the header is not a descendant of the workspace Runs pane's scroller; with a 10 000-leaf run scrolled to a large scrollTop, the SAME header node stays mounted",
    async () => {
      const now = Date.now();
      const eventId = "evt-header-visible-ws-1";
      const projectKey = "proj-header-visible-ws-1";
      const { detail, brief, total } = manyLeavesFixture(eventId, projectKey, "unit", now);
      expect(total).toBe(10_000);
      await mountApp({
        pathname: `/p/${projectKey}/run/${eventId}`,
        projects: [project({ key: projectKey, name: "Header Visible WS Project" })],
        events: [brief],
        eventDetails: { [eventId]: detail },
      });

      const scroller = document.querySelector('[data-testid="workspace-runs"]') as HTMLElement | null;
      expect(scroller).not.toBeNull();

      const header = document.querySelector(".app-drillin-head") as HTMLElement | null;
      expect(header).not.toBeNull();
      expect(scroller!.contains(header)).toBe(false);

      header!.setAttribute("data-red-marker", "header-still-mounted");

      // Scroll the pane's own scroller to a large offset — the gap this AC
      // closes: today the header is a normal descendant of this same
      // element, so scrolling it moves the header along with the tree.
      scroller!.scrollTop = total * 28;
      scroller!.dispatchEvent(new Event("scroll"));
      await settle();

      const headerAfter = document.querySelector(".app-drillin-head") as HTMLElement | null;
      expect(headerAfter).not.toBeNull();
      expect(headerAfter).toBe(header);
      expect(headerAfter!.getAttribute("data-red-marker")).toBe("header-still-mounted");
      expect(scroller!.contains(headerAfter)).toBe(false);
    },
    20_000,
  );

  test(
    "home: the header is not a descendant of the timeline pane's scroller; with a 10 000-leaf run scrolled to a large scrollTop, the SAME header node stays mounted",
    async () => {
      const now = Date.now();
      const eventId = "evt-header-visible-home-1";
      const projectKey = "proj-header-visible-home-1";
      const { detail, brief, total } = manyLeavesFixture(eventId, projectKey, "unit", now);
      expect(total).toBe(10_000);
      await mountApp({
        pathname: `/run/${eventId}`,
        projects: [project({ key: projectKey, name: "Header Visible Home Project" })],
        events: [brief],
        eventDetails: { [eventId]: detail },
      });

      const scroller = document.querySelector('[data-testid="timeline"]') as HTMLElement | null;
      expect(scroller).not.toBeNull();

      const header = document.querySelector(".app-drillin-head") as HTMLElement | null;
      expect(header).not.toBeNull();
      expect(scroller!.contains(header)).toBe(false);

      header!.setAttribute("data-red-marker", "home-header-still-mounted");

      scroller!.scrollTop = total * 28;
      scroller!.dispatchEvent(new Event("scroll"));
      await settle();

      const headerAfter = document.querySelector(".app-drillin-head") as HTMLElement | null;
      expect(headerAfter).not.toBeNull();
      expect(headerAfter).toBe(header);
      expect(headerAfter!.getAttribute("data-red-marker")).toBe("home-header-still-mounted");
      expect(scroller!.contains(headerAfter)).toBe(false);
    },
    20_000,
  );
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
