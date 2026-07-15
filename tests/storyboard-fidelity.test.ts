// CR-CRU-007 §S5 — storyboard-fidelity defects (user + orchestrator live-UI
// review in Chrome, 2026-07-15, against the F8/F11 mocks). Six defects,
// each its own describe block:
//
//  1. WORKSPACE MENU (top priority) — the tabs row must be a FULL-WIDTH
//     horizontal strip rendered directly beneath the top bar, and the
//     workspace must have NO left rail/pane at all. Today `Workspace()`
//     wraps `WorkspaceTabs()` inside `div({class: greyed("app-rail")}, ...)`
//     (public/app.js ~L653-659) — a left-column wrapper, exactly what the
//     mock forbids.
//  2. Drill-in presentation — the overlay must be a RIGHT-HAND SLIDE-OVER
//     sheet, not the current centered box (`run-overlay-scrim` centers its
//     child via `align-items:center;justify-content:center`, public/app.js
//     ~L1006-1012; the panel itself carries only `class: "app-rail
//     app-drillin"`, no right-anchoring).
//  3. Title bar purity (round-7 lock) — home's `app-topbar` renders ONLY
//     logo + slogan + Health Pill; today it also renders `DensityToggle()`
//     (public/app.js ~L276). The density toggle instead belongs in the
//     timeline pane header (next to the filter pulldown), the workspace
//     Runs pane header, and the drill-in header — none of which render it
//     today.
//  4. Pane header labels — home's timeline header today just says
//     "timeline" (public/app.js ~L527); the workspace Runs header just says
//     "runs" (~L582). Both need the "Run timeline — <scope>" contract.
//  5. Vitals — `VitalsRail()` today is a static stub ("vitals land with the
//     drill-in cycles", public/app.js ~L592-597); it needs a real Cycle
//     Health card (from `L.pairTransitions` alone, independent of
//     coverage) and a coverage-trend card gated on coverage actually being
//     present.
//  6. Workspace top bar composition (addendum) — `WorkspaceHeader()` today
//     is missing the app logo entirely and still carries `DensityToggle()`
//     (public/app.js ~L541-555); the locked order is logo, ← projects chip,
//     project chip, Health Pill — nothing else.
//  7. Streak-based transition markers (§S2 re-baseline, second addendum) —
//     the pairing rule changes from per-fail→pass adjacency to ONE marker
//     per MAXIMAL failing streak: same projectKey + stem, timestamp-ordered;
//     a maximal sequence of consecutive failing runs closed by its FIRST
//     subsequent passing run (within 24h of the streak's FIRST fail) yields
//     exactly one marker whose RED counts come from the streak's FIRST
//     failing run; intermediate failing runs are absorbed (never paired
//     separately); pass-after-pass never creates a marker.
//     tests/transition-markers.test.ts (C2's committed file) was checked for
//     contradictions FIRST (see the RED agent's report) — none found, so it
//     is untouched; every existing assertion there is a streak of length 1,
//     a degenerate case the new rule still satisfies identically.
//
// Boots the REAL public/app.js shell inside happy-dom — same harness
// convention as tests/shell-final-form.test.ts / tests/coverage-click.test.ts
// (real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js; only `fetch` is scripted).
//
// RED phase: every assertion below is expected to fail against the CURRENT
// public/app.js for the reasons cited per block — EXCEPT §7's items (a)/(b),
// which (per empirical check against the CURRENT `pairTransitions`) already
// pass with the coordinator's exact fixtures: a single trailing pass only
// ever has one candidate RED to greedily match, so the current "nearest
// unpaired GREEN" algorithm accidentally agrees with the new streak rule for
// those two specific fixtures. The genuine RED signal for item 7 is the
// ADDITIONAL fixture below (fail, fail, pass, pass — two consecutive
// passes available after a 2-run streak): the current greedy algorithm
// wrongly pairs the SECOND failing run with the SECOND pass (2 markers),
// while the streak rule says the streak closes at the FIRST pass and the
// trailing pass-after-pass gets no marker (1 marker) — this is a real,
// currently-failing assertion. (a)/(b) are kept verbatim as specified —
// they're still valid contract/regression coverage of the target rule, just
// not the item that exposes the gap.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

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
}

let cacheBust = 0;

/** See tests/shell-final-form.test.ts for the full harness rationale. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: opts.agents ?? [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: opts.events ?? [] };
    else if (url.includes("/api/v2/health")) {
      body = opts.health ?? { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`storyboard-fidelity.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?storyboardFidelity=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  // Guarded: the §7 pure-logic tests ((c)/(d)) never call mountApp/register
  // happy-dom, so an unconditional unregister() would throw for those and
  // mask their real pass/fail result behind a spurious "Happy DOM has not
  // previously been globally registered" error (same fix as
  // tests/transition-markers.test.ts).
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
    lastEvent: null,
    latestGreenCoverage: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. WORKSPACE MENU — full-width tabs row, no left rail, 2-column body
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 fidelity #1 — workspace tabs row is full-width, NOT inside a rail; body is exactly [content | Project pane]", () => {
  test("workspace-tabs is a DIRECT child of the workspace root (not wrapped in any rail/left-column element)", async () => {
    const key = "fid1-p1";
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fid1 Project" })] });

    const workspace = document.querySelector('[data-testid="workspace"]');
    expect(workspace).not.toBeNull();
    const tabsRow = document.querySelector('[data-testid="workspace-tabs"]');
    expect(tabsRow).not.toBeNull();

    // No ancestor of the tabs row, up to (not including) the workspace
    // root, may carry a "rail" (or left-column) class.
    let node: Element | null = tabsRow!.parentElement;
    let insideRail = false;
    while (node !== null && node !== workspace) {
      if (/rail|left-col/i.test(node.className)) insideRail = true;
      node = node.parentElement;
    }
    expect(insideRail).toBe(false);
    // The tabs row itself must not BE a rail element either.
    expect(/rail/i.test(tabsRow!.className)).toBe(false);
  });

  test("workspace body renders exactly two columns: main content + Project pane, with no left rail anywhere in the workspace", async () => {
    const key = "fid1-p2";
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fid1 Project 2" })] });

    const workspace = document.querySelector('[data-testid="workspace"]')!;
    expect(workspace.querySelectorAll(".app-rail").length).toBe(0);

    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(body).not.toBeNull();
    expect(body!.children.length).toBe(2);
    const pane = document.querySelector('[data-testid="project-pane"]');
    expect(pane).not.toBeNull();
    expect(body!.contains(pane)).toBe(true);
    // The other column is the tab's own content pane (Runs by default).
    const runsPane = document.querySelector('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(body!.contains(runsPane)).toBe(true);
  });

  test("every workspace tab (Runs/Coverage/Compile/BDD) keeps the same full-width, no-rail treatment", async () => {
    const key = "fid1-p3";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Fid1 Project 3", type: "frontend" })],
    });

    const tabButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    );
    expect(tabButtons.length).toBe(4);

    for (const button of tabButtons) {
      button.click();
      await settle();

      const workspace = document.querySelector('[data-testid="workspace"]')!;
      expect(workspace.querySelectorAll(".app-rail").length).toBe(0);

      const tabsRow = document.querySelector('[data-testid="workspace-tabs"]')!;
      let node: Element | null = tabsRow.parentElement;
      let insideRail = false;
      while (node !== null && node !== workspace) {
        if (/rail|left-col/i.test(node.className)) insideRail = true;
        node = node.parentElement;
      }
      expect(insideRail).toBe(false);

      const body = document.querySelector('[data-testid="workspace-body"]');
      expect(body).not.toBeNull();
      expect(body!.children.length).toBe(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Drill-in presentation — right-hand slide-over, not a centered box
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 fidelity #2 — drill-in overlay is a right-hand slide-over sheet", () => {
  test("run-overlay carries the slide-over structural contract: app-slideover-right class, right-anchored + full-height inline/class styling", async () => {
    const key = "fid2-p1";
    const eventId = "evt-fid2-1";
    await mountApp({
      pathname: `/run/${eventId}`,
      projects: [project({ key, name: "Fid2 Project" })],
    });

    const overlay = document.querySelector('[data-testid="run-overlay"]') as HTMLElement | null;
    expect(overlay).not.toBeNull();

    expect(overlay!.classList.contains("app-slideover-right")).toBe(true);

    const style = overlay!.getAttribute("style") ?? "";
    // Anchored to the right edge...
    expect(style).toMatch(/right\s*:\s*0/);
    // ...and full viewport height (either an explicit height or a
    // top:0 + bottom:0 pin — whichever GREEN chooses, testable as raw
    // style-attribute text under happy-dom).
    const fullHeight =
      /height\s*:\s*100(vh|%)/.test(style) || (/top\s*:\s*0/.test(style) && /bottom\s*:\s*0/.test(style));
    expect(fullHeight).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Title bar purity — density toggle lives in pane headers, not the
//    top bar(s)
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 fidelity #3 — title bar purity: density toggle out of both top bars, into the timeline/Runs/drill-in pane headers", () => {
  test("home app-topbar contains ONLY logo + slogan + Health Pill — no density-toggle", async () => {
    await mountApp({ pathname: "/", projects: [] });

    const topbar = document.querySelector('[data-testid="app-topbar"]');
    expect(topbar).not.toBeNull();
    expect(topbar!.querySelector('[data-testid="density-toggle"]')).toBeNull();
    expect(topbar!.querySelector('[data-testid="health-pill"]')).not.toBeNull();
    expect(topbar!.querySelector(".app-logo")).not.toBeNull();
  });

  test("home timeline pane header renders the density toggle next to the filter pulldown", async () => {
    await mountApp({ pathname: "/", projects: [] });

    const timeline = document.querySelector('[data-testid="timeline"]');
    expect(timeline).not.toBeNull();
    expect(timeline!.querySelector('[data-testid="density-toggle"]')).not.toBeNull();
    expect(timeline!.querySelector('[data-testid="filter-pulldown"]')).not.toBeNull();
  });

  test("workspace Runs pane header renders the density toggle", async () => {
    const key = "fid3-p1";
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fid3 Project" })] });

    const runsPane = document.querySelector('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    expect(runsPane!.querySelector('[data-testid="density-toggle"]')).not.toBeNull();
  });

  test("drill-in header renders the density toggle (distinct from the Detail/Density drillin-mode switch)", async () => {
    const key = "fid3-p2";
    const eventId = "evt-fid3-1";
    await mountApp({
      pathname: `/run/${eventId}`,
      projects: [project({ key, name: "Fid3 Project 2" })],
    });

    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    const densityToggle = overlay!.querySelector('[data-testid="density-toggle"]');
    expect(densityToggle).not.toBeNull();
    // Distinct element from drillin-mode (test events only; here there's no
    // detail loaded yet so drillin-mode may be absent — the density toggle
    // must render regardless).
    const drillinMode = overlay!.querySelector('[data-testid="drillin-mode"]');
    if (drillinMode !== null) expect(drillinMode).not.toBe(densityToggle);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Pane header labels — "Run timeline — <scope>"
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 fidelity #4 — pane header labels: 'Run timeline — <scope>'", () => {
  test('home timeline header defaults to "Run timeline — all projects"', async () => {
    await mountApp({ pathname: "/", projects: [] });

    const heading = document.querySelector('[data-testid="timeline"] [data-testid="pane-heading"]');
    expect(heading).not.toBeNull();
    expect((heading!.textContent ?? "").trim()).toBe("Run timeline — all projects");
  });

  test('home timeline header switches to "Run timeline — <project name>" when the filter pulldown selects a project', async () => {
    const keyA = "fid4-p1";
    await mountApp({
      pathname: "/",
      projects: [project({ key: keyA, name: "Fid4 Alpha" })],
    });

    const pulldown = document.querySelector(
      '[data-testid="timeline"] [data-testid="filter-pulldown"]',
    ) as HTMLSelectElement | null;
    expect(pulldown).not.toBeNull();
    pulldown!.value = keyA;
    pulldown!.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    const heading = document.querySelector('[data-testid="timeline"] [data-testid="pane-heading"]');
    expect(heading).not.toBeNull();
    expect((heading!.textContent ?? "").trim()).toBe("Run timeline — Fid4 Alpha");
  });

  test('workspace Runs pane header reads "Run timeline — <project name>"', async () => {
    const key = "fid4-p2";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Fid4 Workspace Project" })],
    });

    const heading = document.querySelector(
      '[data-testid="workspace-runs"] [data-testid="pane-heading"]',
    );
    expect(heading).not.toBeNull();
    expect((heading!.textContent ?? "").trim()).toBe("Run timeline — Fid4 Workspace Project");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Vitals — Cycle Health card (transition pairs alone) + gated
//    coverage-trend card
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 fidelity #5 — Vitals: Cycle Health card from transition pairs alone; coverage-trend gated on coverage existing", () => {
  function transitionPair(
    projectKey: string,
    stem: string,
    baseTs: number,
    closedInMs: number,
  ): EventFixture[] {
    return [
      {
        id: `evt-${stem}-red`,
        projectKey,
        agentId: `${stem}-RED`,
        kind: "test",
        tier: "unit",
        timestamp: baseTs,
        total: 5,
        passed: 2,
        failed: 3,
        pending: 0,
        duration_ms: 40,
        hasCoverage: false,
      },
      {
        id: `evt-${stem}-green`,
        projectKey,
        agentId: `${stem}-GREEN`,
        kind: "test",
        tier: "unit",
        timestamp: baseTs + closedInMs,
        total: 5,
        passed: 5,
        failed: 0,
        pending: 0,
        duration_ms: 60,
        hasCoverage: false,
      },
    ];
  }

  test('Cycle Health card renders "N RED→GREEN · median <duration>" from transition pairs alone, even with NO coverage', async () => {
    const key = "fid5-p1";
    const now = Date.now();
    const events = [
      ...transitionPair(key, "fid5-a", now - 10_000, 100),
      ...transitionPair(key, "fid5-b", now - 8_000, 150),
      ...transitionPair(key, "fid5-c", now - 6_000, 200),
    ];
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({ key, name: "Fid5 No Coverage Project", latestGreenCoverage: null }),
      ],
      events,
    });

    const vitals = document.querySelector('[data-testid="vitals-rail"]');
    expect(vitals).not.toBeNull();
    const card = vitals!.querySelector('[data-testid="cycle-health-card"]');
    expect(card).not.toBeNull();
    // 3 pairs, closed-in durations [100, 150, 200]ms -> median 150ms.
    expect((card!.textContent ?? "")).toContain("3 RED→GREEN");
    expect((card!.textContent ?? "")).toContain("median 150ms");

    // No coverage anywhere for this project — the coverage-trend card must
    // NOT render.
    expect(vitals!.querySelector('[data-testid="coverage-trend-card"]')).toBeNull();
  });

  test("coverage-trend card renders when coverage data exists (alongside Cycle Health)", async () => {
    const key = "fid5-p2";
    const now = Date.now();
    const events = transitionPair(key, "fid5-d", now - 5_000, 120);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "Fid5 Coverage Project",
          latestGreenCoverage: { lines: { total: 10, covered: 7, percent: 70 } },
        }),
      ],
      events,
    });

    const vitals = document.querySelector('[data-testid="vitals-rail"]');
    expect(vitals).not.toBeNull();
    expect(vitals!.querySelector('[data-testid="cycle-health-card"]')).not.toBeNull();
    const trendCard = vitals!.querySelector('[data-testid="coverage-trend-card"]');
    expect(trendCard).not.toBeNull();
    expect((trendCard!.textContent ?? "")).toContain("70");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Workspace top bar composition (addendum) — logo, ← projects, project
//    chip, Health Pill; nothing else
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 fidelity #6 — workspace top bar composition: logo, ← projects, project chip, Health Pill; no density chip", () => {
  test("workspace-header's first element is the app logo — same class + text as the home top bar's logo", async () => {
    const key = "fid6-p1";

    // Capture the home top bar's logo first (the reference element).
    await mountApp({ pathname: "/", projects: [] });
    const homeLogo = document.querySelector('[data-testid="app-topbar"] .app-logo') as
      | HTMLElement
      | null;
    expect(homeLogo).not.toBeNull();
    const homeLogoText = (homeLogo!.textContent ?? "").trim();
    const homeLogoClass = homeLogo!.className;

    // Then the workspace header.
    await mountApp({ pathname: `/p/${key}`, projects: [project({ key, name: "Fid6 Project" })] });
    const header = document.querySelector('[data-testid="workspace-header"]');
    expect(header).not.toBeNull();

    const firstElementChild = header!.children[0] as HTMLElement | undefined;
    expect(firstElementChild).toBeDefined();
    expect(firstElementChild!.classList.contains("app-logo")).toBe(true);
    expect((firstElementChild!.textContent ?? "").trim()).toBe(homeLogoText);
    expect(firstElementChild!.className).toBe(homeLogoClass);
  });

  test("workspace-header order: logo, then ← projects chip, then the project chip, then the Health Pill — no density-toggle anywhere inside it", async () => {
    const key = "fid6-p2";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Fid6 Ordered Project" })],
    });

    const header = document.querySelector('[data-testid="workspace-header"]') as HTMLElement;
    expect(header).not.toBeNull();

    const children = Array.from(header.children) as HTMLElement[];
    const logoIndex = children.findIndex((c) => c.classList.contains("app-logo"));
    const backChipIndex = children.findIndex((c) => (c.textContent ?? "").includes("← projects"));
    const projectChipIndex = children.findIndex((c) =>
      (c.textContent ?? "").includes("Fid6 Ordered Project"),
    );
    const healthPillIndex = children.findIndex(
      (c) => c.getAttribute("data-testid") === "health-pill",
    );

    expect(logoIndex).toBeGreaterThanOrEqual(0);
    expect(backChipIndex).toBeGreaterThan(logoIndex);
    expect(projectChipIndex).toBeGreaterThan(backChipIndex);
    expect(healthPillIndex).toBeGreaterThan(projectChipIndex);

    // No density chip anywhere inside the workspace header.
    expect(header.querySelector('[data-testid="density-toggle"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Streak-based transition markers (§S2 re-baseline, second addendum)
// ─────────────────────────────────────────────────────────────────────────

function testEvent(overrides: {
  id: string;
  agentId: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  projectKey?: string;
}) {
  return {
    projectKey: "streak-proj",
    kind: "test" as const,
    pending: 0,
    ...overrides,
  };
}

describe("§S2 fidelity #7 — streak-based transition markers", () => {
  test("(a) fail(9/9), fail(11/16), fail(10/10), pass(385/385) same stem → exactly ONE marker, text contains RED 9/9 ➜ GREEN 385/385", async () => {
    const t0 = Date.now() - 60_000;
    await mountApp({
      pathname: "/",
      projects: [project({ key: "streak-proj", name: "Streak Project A" })],
      events: [
        {
          id: "streak-a-r1",
          projectKey: "streak-proj",
          agentId: "CR-STREAK-A-RED",
          kind: "test",
          tier: "unit",
          timestamp: t0,
          total: 9,
          passed: 0,
          failed: 9,
          pending: 0,
          duration_ms: 500,
          hasCoverage: false,
        },
        {
          id: "streak-a-r2",
          projectKey: "streak-proj",
          agentId: "CR-STREAK-A-RED",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 1_000,
          total: 16,
          passed: 5,
          failed: 11,
          pending: 0,
          duration_ms: 600,
          hasCoverage: false,
        },
        {
          id: "streak-a-r3",
          projectKey: "streak-proj",
          agentId: "CR-STREAK-A-RED",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 2_000,
          total: 10,
          passed: 0,
          failed: 10,
          pending: 0,
          duration_ms: 550,
          hasCoverage: false,
        },
        {
          id: "streak-a-r4",
          projectKey: "streak-proj",
          agentId: "CR-STREAK-A-GREEN",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 3_000,
          total: 385,
          passed: 385,
          failed: 0,
          pending: 0,
          duration_ms: 4000,
          hasCoverage: false,
        },
      ],
    });

    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(1);
    expect(markers[0]!.textContent ?? "").toContain("RED 9/9 ➜ GREEN 385/385");
  });

  test("(b) fail, pass, fail, pass same stem → exactly TWO markers", async () => {
    const t0 = Date.now() - 60_000;
    await mountApp({
      pathname: "/",
      projects: [project({ key: "streak-proj-b", name: "Streak Project B" })],
      events: [
        {
          id: "streak-b-1",
          projectKey: "streak-proj-b",
          agentId: "CR-STREAK-B-RED",
          kind: "test",
          tier: "unit",
          timestamp: t0,
          total: 5,
          passed: 3,
          failed: 2,
          pending: 0,
          duration_ms: 100,
          hasCoverage: false,
        },
        {
          id: "streak-b-2",
          projectKey: "streak-proj-b",
          agentId: "CR-STREAK-B-GREEN",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 1_000,
          total: 5,
          passed: 5,
          failed: 0,
          pending: 0,
          duration_ms: 100,
          hasCoverage: false,
        },
        {
          id: "streak-b-3",
          projectKey: "streak-proj-b",
          agentId: "CR-STREAK-B-RED",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 2_000,
          total: 3,
          passed: 2,
          failed: 1,
          pending: 0,
          duration_ms: 100,
          hasCoverage: false,
        },
        {
          id: "streak-b-4",
          projectKey: "streak-proj-b",
          agentId: "CR-STREAK-B-GREEN",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 3_000,
          total: 3,
          passed: 3,
          failed: 0,
          pending: 0,
          duration_ms: 100,
          hasCoverage: false,
        },
      ],
    });

    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(2);
  });

  test("(c) the pure pairTransitions export reflects the streak rule: fixture (a) collapses to ONE marker keyed on the streak's FIRST failing run and the closing pass", () => {
    const t0 = Date.now();
    const events = [
      testEvent({ id: "pure-r1", agentId: "CR-STREAK-C-RED", timestamp: t0, total: 9, passed: 0, failed: 9 }),
      testEvent({
        id: "pure-r2",
        agentId: "CR-STREAK-C-RED",
        timestamp: t0 + 1_000,
        total: 16,
        passed: 5,
        failed: 11,
      }),
      testEvent({
        id: "pure-r3",
        agentId: "CR-STREAK-C-RED",
        timestamp: t0 + 2_000,
        total: 10,
        passed: 0,
        failed: 10,
      }),
      testEvent({
        id: "pure-r4",
        agentId: "CR-STREAK-C-GREEN",
        timestamp: t0 + 3_000,
        total: 385,
        passed: 385,
        failed: 0,
      }),
    ];

    const markers = (
      AppLogic as unknown as {
        pairTransitions: (evs: unknown[]) => Array<{
          redEvent: { id: string };
          greenEvent: { id: string };
        }>;
      }
    ).pairTransitions(events);

    expect(markers.length).toBe(1);
    // RED counts must come from the streak's FIRST failing run (pure-r1),
    // never an intermediate one (pure-r2/pure-r3).
    expect(markers[0]!.redEvent.id).toBe("pure-r1");
    expect(markers[0]!.greenEvent.id).toBe("pure-r4");
  });

  // ADDITIONAL fixture beyond the coordinator's exact (a)/(b) — see the
  // file-header note: (a)/(b) each have only ONE pass available, so the
  // CURRENT "nearest unpaired GREEN" pairTransitions already agrees with
  // the streak rule by accident. This fixture (2-run streak, THEN two
  // consecutive passes) is what actually distinguishes streak-grouping
  // from the current greedy pairing: the streak closes at the FIRST pass;
  // the trailing pass-after-pass must get NO marker of its own.
  test("(d) fail, fail, pass, pass same stem → exactly ONE marker (streak closes at the FIRST pass; trailing pass-after-pass gets none) — genuine RED for the streak rule", () => {
    const t0 = Date.now();
    const events = [
      testEvent({ id: "edge-r1", agentId: "CR-STREAK-D-RED", timestamp: t0, total: 5, passed: 3, failed: 2 }),
      testEvent({
        id: "edge-r2",
        agentId: "CR-STREAK-D-RED",
        timestamp: t0 + 1_000,
        total: 5,
        passed: 2,
        failed: 3,
      }),
      testEvent({
        id: "edge-r3",
        agentId: "CR-STREAK-D-GREEN",
        timestamp: t0 + 2_000,
        total: 5,
        passed: 5,
        failed: 0,
      }),
      testEvent({
        id: "edge-r4",
        agentId: "CR-STREAK-D-GREEN",
        timestamp: t0 + 3_000,
        total: 5,
        passed: 5,
        failed: 0,
      }),
    ];

    const markers = (
      AppLogic as unknown as {
        pairTransitions: (evs: unknown[]) => Array<{
          redEvent: { id: string };
          greenEvent: { id: string };
        }>;
      }
    ).pairTransitions(events);

    expect(markers.length).toBe(1);
    expect(markers[0]!.redEvent.id).toBe("edge-r1");
    expect(markers[0]!.greenEvent.id).toBe("edge-r3");
  });
});
