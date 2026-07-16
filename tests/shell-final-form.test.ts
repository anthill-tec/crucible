// CR-CRU-007 §S5 — shell final form (board design iteration, round 6):
// projects row + collective home timeline, workspace Project pane (agents
// nested, ⌁-marked), Health Pill fidelity, workspace-header toggle.
//
// These ACs are real-DOM rendering behaviour of the VanJS shell
// (public/app.js + public/app-logic.mjs), which `bun:test` has no DOM for by
// default. This file drives the REAL production entry point — the actual
// public/app.js boot sequence (main() -> refetch() -> render), the actual
// vendored VanJS/VanX bundles, and the actual public/app-logic.mjs — inside
// a happy-dom window (registered fresh per test via GlobalRegistrator so
// each test gets a clean `window`/`document`/module-state). The only stand-in
// is the network layer: `fetch` is mocked to serve canned v2 API payloads,
// exactly the seam a frontend unit test is expected to substitute at (the
// SERVER's actual computation of the new `active`/`lastActivity` fields is
// separately covered end-to-end against the real HTTP server in
// tests/v2-projects-activity.test.ts).
//
// RED phase: expected to fail against the CURRENT public/app.js (still the
// CR-CRU-006 shape — TopBar renders project chips directly, no projects-row/
// project-badge/filter-pulldown/project-pane testids, workspace still has an
// "Agents" tab + separate AgentsRail/VitalsRail, health-pill shows
// "crucible <version> · N events" instead of the new fidelity text).
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

interface AgentFixture {
  agentId: string;
  projectKey: string;
  status?: "online" | "busy";
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
  message?: string;
  identity?: { displayName?: string };
}

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  hasCoverage: boolean;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  lastEvent?: unknown;
  latestGreenCoverage?: unknown;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  agents?: AgentFixture[];
  events?: EventFixture[];
  health?: unknown;
  /** When true, every fetch (including retries) rejects — simulates a fully unreachable backend. */
  backendDown?: boolean;
}

let cacheBust = 0;

/**
 * Boots the REAL public/app.js shell inside a fresh happy-dom window: real
 * VanJS/VanX vendor bundles, real public/app-logic.mjs, real app.js — only
 * `fetch` is scripted. GlobalRegistrator gives each test an isolated
 * window/document (register in the test, unregister in afterEach) so no
 * state leaks across tests or into other test files in this same `bun test`
 * process.
 */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  // Idempotent register — a test that mounts twice (e.g. the AC7 both-
  // surfaces test remounting for / then /p/<key>) would otherwise hit
  // "Failed to register. Happy DOM has already been globally registered."
  // on the second call, before any production source even runs. The
  // existing afterEach still does the final unregister for the test.
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (opts.backendDown === true) throw new Error("simulated network failure");
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: opts.agents ?? [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: opts.events ?? [] };
    else if (url.includes("/api/v2/health")) {
      body = opts.health ?? { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`shell-final-form.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  // Vendor bundles are classic (nomodule) scripts that attach `van`/`vanX`
  // to the ambient global — `(0, eval)` runs them as an INDIRECT eval, i.e.
  // in global scope, same as a real <script> tag would.
  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // app-logic.mjs is a real ES module cached by resolved specifier — a
  // cache-busting query string forces a FRESH module instance per test so
  // its `window.CrucibleLogic = {...}` bridge attaches to THIS test's fresh
  // happy-dom window, not a stale one from an earlier test.
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?shellFinalForm=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Lets pending microtasks (Promise.all in refetch()) and VanJS's reactive re-render flush. */
async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await GlobalRegistrator.unregister();
});

describe("§S5 AC1 — workspace Project pane (agents nested, ⌁-marked)", () => {
  test("project-pane renders the project card (name + type + coverage) followed by exactly 3 ⌁-marked agent sub-rows, then the Vitals cards", async () => {
    const projectKey = "proj-pane-1";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        {
          key: projectKey,
          name: "Pane Project",
          type: "backend",
          agentsOnline: 2,
          agentsTotal: 3,
          active: true,
          lastActivity: now,
          lastEvent: null,
          latestGreenCoverage: { lines: { covered: 8, total: 10, percent: 80 } },
        },
      ],
      agents: [
        { agentId: "pane-a1", projectKey, status: "online", liveness: "online", lastSeen: now },
        { agentId: "pane-a2", projectKey, status: "online", liveness: "online", lastSeen: now },
        {
          agentId: "pane-a3",
          projectKey,
          status: "online",
          liveness: "tombstoned",
          lastSeen: now - 400_000,
        },
      ],
      events: [],
    });

    const pane = document.querySelector('[data-testid="project-pane"]');
    expect(pane).not.toBeNull();

    // Project card content: name + type badge + coverage meter (real data,
    // not a stub — the 80% figure only appears if latestGreenCoverage was
    // actually consumed).
    const paneText = pane!.textContent ?? "";
    expect(paneText).toContain("Pane Project");
    expect(paneText).toContain("backend");
    expect(paneText).toContain("80");

    // Exactly 3 ⌁-marked agent sub-rows (2 online + 1 tombstoned).
    const subRows = pane!.querySelectorAll('[data-testid="agent-row"]');
    expect(subRows.length).toBe(3);
    for (const row of Array.from(subRows)) {
      expect(row.textContent ?? "").toContain("⌁");
    }
    const subRowText = Array.from(subRows)
      .map((r) => r.textContent ?? "")
      .join(" | ");
    expect(subRowText).toContain("pane-a1");
    expect(subRowText).toContain("pane-a2");
    expect(subRowText).toContain("pane-a3");

    // Vitals cards beneath — reuse the existing vitals-rail testid, but it
    // must now live INSIDE (or immediately after) the project pane, AFTER
    // the agent sub-rows in DOM order.
    const vitals = pane!.querySelector('[data-testid="vitals-rail"]');
    const vitalsIsDescendant = vitals !== null;
    const vitalsAfterPane =
      !vitalsIsDescendant &&
      document.querySelector('[data-testid="vitals-rail"]') !== null &&
      (pane!.compareDocumentPosition(document.querySelector('[data-testid="vitals-rail"]')!) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0;
    expect(vitalsIsDescendant || vitalsAfterPane).toBe(true);

    const lastSubRow = subRows[subRows.length - 1]!;
    const vitalsEl = vitals ?? document.querySelector('[data-testid="vitals-rail"]')!;
    expect(vitalsEl).not.toBeNull();
    expect(
      (lastSubRow.compareDocumentPosition(vitalsEl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  test("home page (/) renders 0 agent rows anywhere, even with agents present in state", async () => {
    const projectKey = "proj-pane-2";
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: projectKey,
          name: "Home Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          active: true,
          lastActivity: now,
        },
      ],
      agents: [
        { agentId: "home-a1", projectKey, status: "online", liveness: "online", lastSeen: now },
      ],
      events: [],
    });

    expect(document.querySelectorAll('[data-testid="agent-row"]').length).toBe(0);
    expect(document.querySelector('[data-testid="project-pane"]')).toBeNull();
  });
});

describe("§S5 AC3 — home projects-row + project-badge + filter-pulldown", () => {
  test("projects-row renders one project-badge per project (name + type badge); title bar carries no project badges", async () => {
    const keyA = "row-proj-a";
    const keyB = "row-proj-b";
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: keyA,
          name: "Alpha",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
        {
          key: keyB,
          name: "Beta",
          type: "frontend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now - 1_000,
        },
      ],
    });

    const row = document.querySelector('[data-testid="projects-row"]');
    expect(row).not.toBeNull();

    const badges = row!.querySelectorAll('[data-testid="project-badge"]');
    expect(badges.length).toBe(2);
    expect(badges[0]!.textContent ?? "").toContain("Alpha");
    expect(badges[0]!.textContent ?? "").toContain("backend");
    expect(badges[1]!.textContent ?? "").toContain("Beta");
    expect(badges[1]!.textContent ?? "").toContain("frontend");

    // bound: the title bar itself carries NO project badges.
    const topbar = document.querySelector('[data-testid="app-topbar"]');
    expect(topbar).not.toBeNull();
    expect(topbar!.querySelector('[data-testid="project-badge"]')).toBeNull();
  });

  test("clicking a project-badge navigates to /p/<key> (drill-down, never filter)", async () => {
    const keyA = "row-nav-a";
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: keyA,
          name: "Nav Project",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
    });

    const badge = document.querySelector('[data-testid="project-badge"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    badge!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${keyA}`);
    expect(document.querySelector('[data-testid="workspace"]')).not.toBeNull();
  });

  test("filter-pulldown defaults to 'All projects' and filters the home timeline in place (route stays /)", async () => {
    const keyA = "filter-proj-a";
    const keyB = "filter-proj-b";
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: keyA,
          name: "Filter A",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
        {
          key: keyB,
          name: "Filter B",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now - 1_000,
        },
      ],
      events: [
        {
          id: "evt-filter-a",
          projectKey: keyA,
          agentId: "agent-filter-a",
          kind: "test",
          tier: "unit",
          timestamp: now,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 5,
          hasCoverage: false,
        },
        {
          id: "evt-filter-b",
          projectKey: keyB,
          agentId: "agent-filter-b",
          kind: "test",
          tier: "unit",
          timestamp: now - 500,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 5,
          hasCoverage: false,
        },
      ],
    });

    const timelinePane = document.querySelector('[data-testid="timeline"]');
    expect(timelinePane).not.toBeNull();

    const pulldown = timelinePane!.querySelector(
      '[data-testid="filter-pulldown"]',
    ) as HTMLSelectElement | null;
    expect(pulldown).not.toBeNull();
    expect(pulldown!.textContent ?? "").toContain("All projects");

    // Sanity: both projects' events visible before filtering.
    expect(timelinePane!.textContent ?? "").toContain("agent-filter-a");
    expect(timelinePane!.textContent ?? "").toContain("agent-filter-b");

    pulldown!.value = keyA;
    pulldown!.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    // route stays "/" — filtering happens in place, never a navigation.
    expect(location.pathname).toBe("/");
    expect(timelinePane!.textContent ?? "").toContain("agent-filter-a");
    expect(timelinePane!.textContent ?? "").not.toContain("agent-filter-b");
  });
});

describe("§S5 AC4 — projects-row ordering: most-recently-active first, inactive last", () => {
  test("badges render in order A (active, 5s), C (active, 10min), B (inactive, 2h) given a shuffled API response", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      // Deliberately shuffled server response order — proves the CLIENT
      // re-orders rather than trusting API ordering.
      projects: [
        {
          key: "order-B",
          name: "Project B",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: false,
          lastActivity: now - 7_200_000,
        },
        {
          key: "order-A",
          name: "Project A",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          active: true,
          lastActivity: now - 5_000,
        },
        {
          key: "order-C",
          name: "Project C",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now - 600_000,
        },
      ],
    });

    const badges = document.querySelectorAll(
      '[data-testid="projects-row"] [data-testid="project-badge"]',
    );
    expect(badges.length).toBe(3);
    const order = Array.from(badges).map((b) => b.textContent ?? "");
    expect(order[0]).toContain("Project A");
    expect(order[1]).toContain("Project C");
    expect(order[2]).toContain("Project B");
  });
});

describe("§S5 AC5 — collective timeline interleave + agent sub-row filter (no route change)", () => {
  test("home timeline interleaves both projects' cards newest-first (not grouped by project)", async () => {
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "interleave-p1",
          name: "P1",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
        {
          key: "interleave-p2",
          name: "P2",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
      events: [
        {
          id: "e-newest",
          projectKey: "interleave-p2",
          agentId: "agent-p2-newest",
          kind: "test",
          tier: "unit",
          timestamp: now,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 1,
          hasCoverage: false,
        },
        {
          id: "e-mid",
          projectKey: "interleave-p1",
          agentId: "agent-p1-mid",
          kind: "test",
          tier: "unit",
          timestamp: now - 1_000,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 1,
          hasCoverage: false,
        },
        {
          id: "e-old",
          projectKey: "interleave-p2",
          agentId: "agent-p2-oldest",
          kind: "test",
          tier: "unit",
          timestamp: now - 2_000,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 1,
          hasCoverage: false,
        },
      ],
    });

    const text = document.querySelector('[data-testid="timeline"]')!.textContent ?? "";
    const iNewest = text.indexOf("agent-p2-newest");
    const iMid = text.indexOf("agent-p1-mid");
    const iOldest = text.indexOf("agent-p2-oldest");

    expect(iNewest).toBeGreaterThanOrEqual(0);
    expect(iMid).toBeGreaterThan(iNewest);
    expect(iOldest).toBeGreaterThan(iMid);
  });

  test("clicking an agent sub-row in the workspace filters the timeline to that agent, WITHOUT changing the route", async () => {
    const projectKey = "workspace-filter-p1";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        {
          key: projectKey,
          name: "Filter Workspace",
          type: "backend",
          agentsOnline: 2,
          agentsTotal: 2,
          active: true,
          lastActivity: now,
        },
      ],
      agents: [
        {
          agentId: "workspace-agent-x",
          projectKey,
          status: "online",
          liveness: "online",
          lastSeen: now,
        },
        {
          agentId: "workspace-agent-y",
          projectKey,
          status: "online",
          liveness: "online",
          lastSeen: now,
        },
      ],
      events: [
        {
          id: "e-x",
          projectKey,
          agentId: "workspace-agent-x",
          kind: "test",
          tier: "unit",
          timestamp: now,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 1,
          hasCoverage: false,
        },
        {
          id: "e-y",
          projectKey,
          agentId: "workspace-agent-y",
          kind: "test",
          tier: "unit",
          timestamp: now - 500,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 1,
          hasCoverage: false,
        },
      ],
    });

    // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
    // defaults to the Workflow pane, not Runs (workspace default flips) —
    // this test's SUBJECT is the workspace Runs pane's agent-filter, so it
    // now selects the Runs tab EXPLICITLY after mount instead of relying on
    // Runs being the cold-load default. Was: no tab click, relied on cold
    // load already showing the Runs pane.
    const runsTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => (t.textContent ?? "").trim() === "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();

    const pathBefore = location.pathname;
    const subRow = Array.from(
      document.querySelectorAll('[data-testid="project-pane"] [data-testid="agent-row"]'),
    ).find((r) => (r.textContent ?? "").includes("workspace-agent-x")) as HTMLElement | undefined;
    expect(subRow).toBeDefined();

    subRow!.click();
    await settle();

    expect(location.pathname).toBe(pathBefore);

    const runsPane = document.querySelector('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(runsPane!.textContent ?? "").toContain("workspace-agent-x");
    expect(runsPane!.textContent ?? "").not.toContain("workspace-agent-y");
  });
});

describe("§S5 AC6 — workspace-header toggle + ← projects navigation", () => {
  test("workspace-header exists on /p/<key> and its ← projects control navigates to /", async () => {
    const projectKey = "header-toggle-p1";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        {
          key: projectKey,
          name: "Header Project",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
        },
      ],
    });

    const header = document.querySelector('[data-testid="workspace-header"]');
    expect(header).not.toBeNull();

    const backChip = Array.from(header!.querySelectorAll("button, a")).find((el) =>
      (el.textContent ?? "").includes("← projects"),
    ) as HTMLElement | undefined;
    expect(backChip).toBeDefined();

    backChip!.click();
    await settle();

    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="workspace-header"]')).toBeNull();
  });

  test("home (/) never renders a workspace-header", async () => {
    await mountApp({ pathname: "/", projects: [] });

    expect(document.querySelector('[data-testid="workspace-header"]')).toBeNull();
  });
});

describe("§S5 AC7 — Health Pill fidelity", () => {
  test("renders on BOTH / and /p/<key>, with text matching /^server healthy · (live|up .+)$/ when up; workspace top bar has no agent-count chip", async () => {
    const projectKey = "pill-p1";
    const now = Date.now();

    await mountApp({ pathname: "/", projects: [] });
    const homePill = document.querySelector('[data-testid="health-pill"]');
    expect(homePill).not.toBeNull();
    const homeText = (homePill!.textContent ?? "").trim();
    expect(homeText).toMatch(/^server healthy · (live|up .+)$/);
    // bound: no version/event-count text leaking into the pill.
    expect(homeText).not.toMatch(/\d+\.\d+\.\d+/); // no semver-shaped version string
    expect(homeText).not.toContain("events");

    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        {
          key: projectKey,
          name: "Pill Project",
          type: "backend",
          agentsOnline: 3,
          agentsTotal: 5,
          active: true,
          lastActivity: now,
        },
      ],
    });
    const workspacePill = document.querySelector('[data-testid="health-pill"]');
    expect(workspacePill).not.toBeNull();
    const workspaceText = (workspacePill!.textContent ?? "").trim();
    expect(workspaceText).toMatch(/^server healthy · (live|up .+)$/);

    // bound: the workspace top bar carries the pill instead of an
    // agent-count chip — no "N/M agents online"-shaped text anywhere in it.
    const header = document.querySelector('[data-testid="workspace-header"]');
    expect(header).not.toBeNull();
    expect(header!.textContent ?? "").not.toMatch(/\d+\s*\/\s*\d+\s*agents/i);
  });

  test(
    "shows exactly 'server unreachable · retrying…' once the backend goes unreachable (no version/event-count text)",
    async () => {
      await mountApp({ pathname: "/", projects: [], backendDown: true });

      // The current shell's watchdog only flips reachability after a
      // silence window (>20s) checked on a 5s tick, and EventSource is
      // undefined under happy-dom (confirmed: app.js falls back to
      // startPolling()), so lastFrameAt never advances after boot — the
      // silence clock starts at mount and the flip is a REAL passage of
      // wall-clock time in this harness. Budgeted like the existing
      // Playwright F10 down-state test (tests/e2e/shell.e2e.ts), which
      // allows up to 28s for the same reason.
      await new Promise((resolve) => setTimeout(resolve, 26_000));

      const pill = document.querySelector('[data-testid="health-pill"]');
      expect(pill).not.toBeNull();
      const text = (pill!.textContent ?? "").trim();
      expect(text).toBe("server unreachable · retrying…");
    },
    35_000,
  );
});
