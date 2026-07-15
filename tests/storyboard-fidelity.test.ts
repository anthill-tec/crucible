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
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

/** Extracts a CSS rule's `{ ... }` body for an EXACT selector text (first
 * match) — same convention as tests/drill-in.test.ts's F4-anatomy CSS grep
 * tests. */
function ruleBodyFor(selector: string): string | undefined {
  const idx = STYLES_SRC.indexOf(selector);
  if (idx === -1) return undefined;
  const braceStart = STYLES_SRC.indexOf("{", idx);
  const braceEnd = STYLES_SRC.indexOf("}", braceStart);
  if (braceStart === -1 || braceEnd === -1) return undefined;
  return STYLES_SRC.slice(braceStart + 1, braceEnd);
}

function ruleBodyForClass(cls: string): string | undefined {
  return ruleBodyFor(`.${cls} {`) ?? ruleBodyFor(`.${cls}{`);
}

/** Finds the FIRST class on `el` whose styles.css rule body satisfies
 * `predicate` — used when the AC pins a visual property (e.g. "the ember
 * accent") without pinning the exact class name GREEN will choose. */
function matchingRuleBody(el: Element, predicate: (body: string) => boolean): string | undefined {
  const classes = (el.className || "").toString().split(/\s+/).filter(Boolean);
  for (const cls of classes) {
    const body = ruleBodyForClass(cls);
    if (body !== undefined && predicate(body)) return body;
  }
  return undefined;
}

/** Combines an element's inline style with its class rule bodies — used to
 * find "ember" vs "ember-dim" color evidence regardless of whether GREEN
 * encodes it via inline style or a CSS class. */
function colorEvidence(el: Element): string {
  const inline = el.getAttribute("style") ?? "";
  const classes = (el.className || "").toString().split(/\s+/).filter(Boolean);
  const bodies = classes.map((c) => ruleBodyForClass(c) ?? "").join(" ");
  return `${inline} ${bodies}`;
}

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
  /** §S5.2 F8 vitals anatomy (user defect 2026-07-15) — the coverage-trend
   * card's bars derive from this already-loaded field. */
  coverageLines?: number;
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
  /** §S5 Coverage tab (user defect 2026-07-15) — id of the event backing
   * `latestGreenCoverage`, same field asserted in tests/coverage-click.test.ts. */
  latestCoverageEventId?: string;
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

// ─────────────────────────────────────────────────────────────────────────
// 8. §S5 Coverage tab (user defect 2026-07-15) — the CR-006 placeholder
//    `<tab> lands in CR-CRU-007` is still the only body behind the Coverage
//    tab today; this pins the real latest-green-coverage panel.
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 Coverage tab (user defect 2026-07-15)", () => {
  test("selecting the Coverage tab renders the coverage-panel with both lines and functions metrics, plus a coverage-view-run control that opens the drill-in", async () => {
    const key = "cov-tab-p1";
    const eventId = "evt-cov-tab-p1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "Cov Tab Project",
          latestGreenCoverage: {
            lines: { covered: 1736, total: 1849, percent: 93.9 },
            functions: { covered: 199, total: 208, percent: 95.7 },
          },
          latestCoverageEventId: eventId,
        }),
      ],
    });

    const coverageTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((el) => (el.textContent ?? "").includes("Coverage"));
    expect(coverageTab).toBeDefined();
    expect(coverageTab!.hasAttribute("disabled")).toBe(false);
    coverageTab!.click();
    await settle();

    const panel = document.querySelector('[data-testid="coverage-panel"]');
    expect(panel).not.toBeNull();
    const panelText = panel!.textContent ?? "";
    expect(panelText).toContain("93.9%");
    expect(panelText).toContain("1736/1849");
    expect(panelText).toContain("95.7%");
    expect(panelText).toContain("199/208");

    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
    const viewRun = panel!.querySelector('[data-testid="coverage-view-run"]') as HTMLElement | null;
    expect(viewRun).not.toBeNull();
    viewRun!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/${eventId}`);
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();
  });

  test("no tab ever renders the stale CR-CRU-007 placeholder text", async () => {
    const key = "cov-tab-p2";
    const eventId = "evt-cov-tab-p2";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "Placeholder Check Project",
          type: "frontend",
          latestGreenCoverage: { lines: { covered: 5, total: 10, percent: 50 } },
          latestCoverageEventId: eventId,
        }),
      ],
    });

    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'));
    expect(tabs.length).toBe(4);
    for (const tab of tabs) {
      if (tab.hasAttribute("disabled")) continue;
      tab.click();
      await settle();
      const body = document.querySelector('[data-testid="workspace-body"]');
      expect(body).not.toBeNull();
      expect(body!.textContent ?? "").not.toContain("lands in CR-CRU-007");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. §S5 Compile/BDD tab bodies (user defect 2026-07-15) — F5 COMPILE PANEL
//    + the BDD placeholder naming the real landing CR.
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 Compile/BDD tab bodies (user defect 2026-07-15)", () => {
  test("selecting the Compile tab renders exactly the compile-kind cards (same card anatomy/testids as Runs)", async () => {
    const key = "compile-tab-p1";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Compile Tab Project" })],
      events: [
        { id: "ct-t1", projectKey: key, agentId: "compile-tab-test-1", kind: "test", tier: "unit", timestamp: now, total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 50, hasCoverage: false },
        { id: "ct-t2", projectKey: key, agentId: "compile-tab-test-2", kind: "test", tier: "unit", timestamp: now + 100, total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 60, hasCoverage: false },
        { id: "ct-c1", projectKey: key, agentId: "compile-tab-compile-1", kind: "compile", tier: "unit", timestamp: now + 200, total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 70, hasCoverage: false },
        { id: "ct-c2", projectKey: key, agentId: "compile-tab-compile-2", kind: "compile", tier: "unit", timestamp: now + 300, total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 80, hasCoverage: false },
      ],
    });

    const compileTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((el) => (el.textContent ?? "").trim() === "Compile");
    expect(compileTab).toBeDefined();
    compileTab!.click();
    await settle();

    const body = document.querySelector('[data-testid="workspace-body"]')!;
    const cards = body.querySelectorAll('[data-testid="event-card"]');
    expect(cards.length).toBe(2);
    for (const card of Array.from(cards)) {
      const iconGlyph = card.querySelector('[data-testid="icon-glyph"]');
      expect(iconGlyph).not.toBeNull();
      expect(iconGlyph!.getAttribute("data-kind")).toBe("compile");
      expect(card.querySelector('[data-testid="ratio-pill"]')).not.toBeNull();
    }
  });

  test("Compile tab with 0 compile events renders 'no compile events yet'", async () => {
    const key = "compile-tab-p2";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Empty Compile Tab Project" })],
      events: [
        { id: "ect-t1", projectKey: key, agentId: "empty-compile-test-1", kind: "test", tier: "unit", timestamp: now, total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10, hasCoverage: false },
      ],
    });

    const compileTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((el) => (el.textContent ?? "").trim() === "Compile");
    expect(compileTab).toBeDefined();
    compileTab!.click();
    await settle();

    const body = document.querySelector('[data-testid="workspace-body"]')!;
    expect(body.querySelectorAll('[data-testid="event-card"]').length).toBe(0);
    expect(body.textContent ?? "").toContain("no compile events yet");
  });

  test("BDD tab body text names the real landing CR (CR-CRU-015) and never CR-CRU-007", async () => {
    const key = "bdd-tab-p1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "BDD Tab Project", type: "frontend" })],
    });

    const bddTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((el) => (el.textContent ?? "").trim() === "BDD");
    expect(bddTab).toBeDefined();
    expect(bddTab!.hasAttribute("disabled")).toBe(false);
    bddTab!.click();
    await settle();

    const body = document.querySelector('[data-testid="workspace-body"]')!;
    expect(body.textContent ?? "").toContain("CR-CRU-015");
    expect(body.textContent ?? "").not.toContain("CR-CRU-007");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. §S5.2 F7/F8 fidelity contract (user defect 2026-07-15, "coverage meter
//     too thin… doesn't look distinct… color scheme uninspiring") — pane
//     section titles, the F8 mock's ember `.meter`, the dual coverage
//     caption, vitals card anatomy, and the universal status palette.
// ─────────────────────────────────────────────────────────────────────────

describe("§S5 fidelity #5b — F7/F8 Project pane visual fidelity: section titles + ember coverage meter + dual caption", () => {
  test("renders exactly two pane-section-title elements ('Project' above the card, 'Vitals' above the vitals cards), each styled with the ember accent + wide letter-spacing", async () => {
    const key = "f7f8-p1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "F7F8 Project",
          latestGreenCoverage: {
            lines: { covered: 1736, total: 1849, percent: 93.9 },
            functions: { covered: 199, total: 208, percent: 95.7 },
          },
        }),
      ],
    });

    const pane = document.querySelector('[data-testid="project-pane"]');
    expect(pane).not.toBeNull();
    const titles = pane!.querySelectorAll('[data-testid="pane-section-title"]');
    expect(titles.length).toBe(2);
    const texts = Array.from(titles).map((t) => (t.textContent ?? "").trim());
    expect(texts).toContain("Project");
    expect(texts).toContain("Vitals");

    for (const title of Array.from(titles)) {
      const body = matchingRuleBody(title, (b) => /color:\s*var\(--ember\)/.test(b));
      expect(body).toBeDefined();
      const lsMatch = /letter-spacing:\s*([\d.]+)em/.exec(body ?? "");
      expect(lsMatch).not.toBeNull();
      expect(parseFloat(lsMatch![1]!)).toBeGreaterThanOrEqual(0.14);
    }

    const projectTitle = Array.from(titles).find((t) => (t.textContent ?? "").trim() === "Project")!;
    const vitalsTitle = Array.from(titles).find((t) => (t.textContent ?? "").trim() === "Vitals")!;
    const card = pane!.querySelector(".app-pane-card");
    expect(card).not.toBeNull();
    expect((projectTitle.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(
      true,
    );
    const cycleCard = document.querySelector('[data-testid="cycle-health-card"]');
    expect(cycleCard).not.toBeNull();
    expect(
      (vitalsTitle.compareDocumentPosition(cycleCard!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  test("coverage meter is 6px tall, fully rounded, borderless, with an ember-gradient fill; the project-card caption carries both metrics ('cov 93.9% lines · fn 95.7%')", async () => {
    const key = "f7f8-p2";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "F7F8 Meter Project",
          latestGreenCoverage: {
            lines: { covered: 1736, total: 1849, percent: 93.9 },
            functions: { covered: 199, total: 208, percent: 95.7 },
          },
        }),
      ],
    });

    const pane = document.querySelector('[data-testid="project-pane"]')!;
    const meter = pane.querySelector('[data-testid="coverage-meter"]') as HTMLElement | null;
    expect(meter).not.toBeNull();

    // Direct, spec-literal check against the KNOWN production class names
    // (`.app-meter` / `.app-meter-fill`) — the AC quotes these verbatim.
    const meterRule = ruleBodyFor(".app-meter {") ?? ruleBodyFor(".app-meter{");
    expect(meterRule).toBeDefined();
    expect(meterRule).toMatch(/height:\s*6px/);
    expect(meterRule).toMatch(/border-radius:\s*999px/);
    // NOTE (GREEN-escalated fix): `\bborder\b` self-contradicts against this
    // rule's OWN required `border-radius: 999px` above — "-" is a non-word
    // char so a boundary follows "border" there too. Match only a real
    // `border:` property declaration.
    expect(meterRule).not.toMatch(/\bborder\s*:/);

    const fillRule = ruleBodyFor(".app-meter-fill {") ?? ruleBodyFor(".app-meter-fill{");
    expect(fillRule).toBeDefined();
    expect(fillRule).toMatch(/linear-gradient\(90deg,\s*var\(--ember\),\s*var\(--pass\)\)/);

    const fill = meter!.querySelector(".app-meter-fill") as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.getAttribute("style") ?? "").toMatch(/width:\s*93\.9%/);

    const card = pane.querySelector(".app-pane-card")!;
    expect(card.textContent ?? "").toContain("cov 93.9% lines · fn 95.7%");
  });
});

describe("§S5 fidelity #5c — F8 Vitals card anatomy: coverage-trend bars + label-over-value hierarchy", () => {
  test("coverage-trend renders 'COVERAGE TREND (green regressions)' + one bar per green-coverage point (oldest→newest, latest bright ember, earlier ember-dim) + the first→latest caption", async () => {
    const key = "f8-vitals-p1";
    const t0 = Date.now() - 40_000;
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "F8 Vitals Trend Project",
          latestGreenCoverage: { lines: { covered: 873, total: 1000, percent: 87.3 } },
        }),
      ],
      events: [
        { id: "trend-1", projectKey: key, agentId: "trend-agent-1", kind: "test", tier: "regression", timestamp: t0, total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500, hasCoverage: true, coverageLines: 82.1 },
        { id: "trend-2", projectKey: key, agentId: "trend-agent-2", kind: "test", tier: "regression", timestamp: t0 + 1000, total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500, hasCoverage: true, coverageLines: 84.0 },
        { id: "trend-3", projectKey: key, agentId: "trend-agent-3", kind: "test", tier: "regression", timestamp: t0 + 2000, total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500, hasCoverage: true, coverageLines: 86.2 },
        { id: "trend-4", projectKey: key, agentId: "trend-agent-4", kind: "test", tier: "regression", timestamp: t0 + 3000, total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500, hasCoverage: true, coverageLines: 87.3 },
      ],
    });

    const trendCard = document.querySelector('[data-testid="coverage-trend-card"]');
    expect(trendCard).not.toBeNull();
    expect(trendCard!.textContent ?? "").toContain("COVERAGE TREND (green regressions)");

    const bars = trendCard!.querySelectorAll('[data-testid="coverage-trend-bar"]');
    expect(bars.length).toBe(4);

    const heights = Array.from(bars).map((b) => {
      const style = (b as HTMLElement).getAttribute("style") ?? "";
      const m = /(\d+(?:\.\d+)?)%/.exec(style);
      expect(m).not.toBeNull();
      return parseFloat(m![1]!);
    });
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1]!);
    }

    const lastBar = bars[bars.length - 1] as HTMLElement;
    const earlierBars = Array.from(bars).slice(0, -1) as HTMLElement[];
    const lastEvidence = colorEvidence(lastBar);
    expect(lastEvidence).toContain("var(--ember)");
    expect(lastEvidence).not.toContain("var(--ember-dim)");
    for (const bar of earlierBars) {
      expect(colorEvidence(bar)).toContain("var(--ember-dim)");
    }

    expect(trendCard!.textContent ?? "").toContain("82.1 → 87.3% lines");
  });

  test("coverage-trend caption falls back to 'latest green coverage <p>%' with exactly 1 point", async () => {
    const key = "f8-vitals-p2";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "F8 Vitals Single Point",
          latestGreenCoverage: { lines: { covered: 7, total: 10, percent: 70 } },
        }),
      ],
      events: [
        { id: "single-trend-1", projectKey: key, agentId: "single-trend-agent", kind: "test", tier: "regression", timestamp: now, total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 400, hasCoverage: true, coverageLines: 70 },
      ],
    });

    const trendCard = document.querySelector('[data-testid="coverage-trend-card"]');
    expect(trendCard).not.toBeNull();
    // The F8 dim-uppercase label is present regardless of point count — this
    // is the real RED signal (today's card just says "coverage trend").
    expect(trendCard!.textContent ?? "").toContain("COVERAGE TREND (green regressions)");
    expect(trendCard!.textContent ?? "").toContain("latest green coverage 70%");
    // Bound: with exactly 1 point, no bar chart renders — just the caption.
    expect(trendCard!.querySelectorAll('[data-testid="coverage-trend-bar"]').length).toBe(0);
  });

  test("label-over-value hierarchy on BOTH vitals cards: dim uppercase label ABOVE a bright/600 value line", async () => {
    const key = "f8-vitals-p3";
    const t0 = Date.now() - 10_000;
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        project({
          key,
          name: "F8 Label Over Value Project",
          latestGreenCoverage: { lines: { covered: 7, total: 10, percent: 70 } },
        }),
      ],
      events: [
        { id: "lov-red", projectKey: key, agentId: "LOV-STEM-RED", kind: "test", tier: "unit", timestamp: t0, total: 5, passed: 3, failed: 2, pending: 0, duration_ms: 40, hasCoverage: false },
        { id: "lov-green", projectKey: key, agentId: "LOV-STEM-GREEN", kind: "test", tier: "unit", timestamp: t0 + 1000, total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 60, hasCoverage: true, coverageLines: 70 },
      ],
    });

    for (const testid of ["cycle-health-card", "coverage-trend-card"]) {
      const card = document.querySelector(`[data-testid="${testid}"]`);
      expect(card).not.toBeNull();
      const label = card!.querySelector('[data-testid="vitals-card-label"]') as HTMLElement | null;
      const value = card!.querySelector('[data-testid="vitals-card-value"]') as HTMLElement | null;
      expect(label).not.toBeNull();
      expect(value).not.toBeNull();
      expect((label!.compareDocumentPosition(value!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(
        true,
      );
    }

    const cycleLabel = document.querySelector(
      '[data-testid="cycle-health-card"] [data-testid="vitals-card-label"]',
    );
    expect((cycleLabel!.textContent ?? "").trim()).toBe("CYCLE HEALTH (7d)");
    const cycleValue = document.querySelector(
      '[data-testid="cycle-health-card"] [data-testid="vitals-card-value"]',
    ) as HTMLElement;
    expect((cycleValue!.textContent ?? "")).toMatch(/^\d+ RED→GREEN · median .+$/);
    const valueWeightBody = matchingRuleBody(cycleValue, (b) => /font-weight:\s*600/.test(b));
    expect(valueWeightBody).toBeDefined();

    const trendLabel = document.querySelector(
      '[data-testid="coverage-trend-card"] [data-testid="vitals-card-label"]',
    );
    expect((trendLabel!.textContent ?? "").trim()).toBe("COVERAGE TREND (green regressions)");
  });
});

describe("§S5 fidelity #5d — F8 pane status palette (pass-green / fail-red, never neutral)", () => {
  test("the project card's latest-run status line carries the pass-green class when the latest run passes, and the fail-red class on a failing-latest fixture", async () => {
    const passKey = "palette-pass-1";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${passKey}`,
      projects: [
        project({
          key: passKey,
          name: "Palette Pass Project",
          lastEvent: { total: 446, passed: 446, failed: 0, timestamp: now },
        }),
      ],
    });
    const passLine = document.querySelector('[data-testid="project-status-line"]');
    expect(passLine).not.toBeNull();
    expect((passLine!.textContent ?? "")).toContain("✓ green · 446/446");
    expect(passLine!.className).toContain("app-ratio-pass");
    expect(passLine!.className).not.toContain("app-ratio-fail");

    const failKey = "palette-fail-1";
    await mountApp({
      pathname: `/p/${failKey}`,
      projects: [
        project({
          key: failKey,
          name: "Palette Fail Project",
          lastEvent: { total: 10, passed: 7, failed: 3, timestamp: now },
        }),
      ],
    });
    const failLine = document.querySelector('[data-testid="project-status-line"]');
    expect(failLine).not.toBeNull();
    expect((failLine!.textContent ?? "")).toContain("✗ 3 failed of 10");
    expect(failLine!.className).toContain("app-ratio-fail");
    expect(failLine!.className).not.toContain("app-ratio-pass");
  });

  test("cycle-health value's RED token carries the fail-red class and the GREEN token the pass-green class — the same status classes the timeline uses", async () => {
    const key = "palette-cycle-1";
    const t0 = Date.now() - 10_000;
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Palette Cycle Project", latestGreenCoverage: null })],
      events: [
        { id: "pc-red", projectKey: key, agentId: "PC-STEM-RED", kind: "test", tier: "unit", timestamp: t0, total: 5, passed: 3, failed: 2, pending: 0, duration_ms: 40, hasCoverage: false },
        { id: "pc-green", projectKey: key, agentId: "PC-STEM-GREEN", kind: "test", tier: "unit", timestamp: t0 + 1000, total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 60, hasCoverage: false },
      ],
    });

    const value = document.querySelector(
      '[data-testid="cycle-health-card"] [data-testid="vitals-card-value"]',
    );
    expect(value).not.toBeNull();
    const redToken = Array.from(value!.querySelectorAll("span")).find(
      (s) => (s.textContent ?? "").trim() === "RED",
    );
    const greenToken = Array.from(value!.querySelectorAll("span")).find(
      (s) => (s.textContent ?? "").trim() === "GREEN",
    );
    expect(redToken).toBeDefined();
    expect(greenToken).toBeDefined();
    expect(redToken!.className).toContain("app-ratio-fail");
    expect(greenToken!.className).toContain("app-ratio-pass");
  });
});
