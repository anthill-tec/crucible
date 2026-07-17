// CR-CRU-027 — F8 vitals sparkline mock fidelity (§S1 bar geometry + §S2
// last-16 series windowing). User-flagged repeat drift (2026-07-17, "second
// time with maximum displeasure"): CR-023 §S2 fixed the coverage-trend
// bars' RENDER GATE (bars now appear at >=1 point) but shipped the wrong
// GEOMETRY. The F8 mock draws a compact left-aligned sparkline — fixed
// `width:9px` bars (`flex: 0 0 9px`), `gap:3px`, cluster `height:26px`,
// `align-items:flex-end`, no stretching at ANY point count. The shipped
// `.app-trend-bar` uses `flex: 1 1 0` in a 36px container
// (public/styles.css:321-334) — bars STRETCH to fill the card (Chrome-
// measured 2026-07-17: 2 bars x 131px wide x 34px tall vs the mock's 9px x
// <=26px left-aligned cluster). §S2 additionally caps the rendered series
// at the MOST RECENT 16 points (chronological, latest last), with the
// caption's `<first>` value being the first RENDERED (windowed) point, not
// points[0] of the full series — public/app.js CoverageTrendCard
// (~L1402-1435) today renders ALL points with no cap and captions from
// points[0].
//
// CSS PIN ROUTE (documented per dispatch instruction — verify before
// relying on getComputedStyle in this harness):
//
// A standalone probe against @happy-dom/global-registrator confirmed that
// an element carrying ONLY an inline style (no stylesheet loaded into the
// document) reports `getComputedStyle(el).width === ""` and
// `getComputedStyle(el).flex === ""` — happy-dom has no CSS cascade/layout
// engine, so a `<link>`-free document cannot resolve widths/flex-basis from
// class-selector rules at all (it DOES correctly reflect literal INLINE
// styles, e.g. `style="height:50%"` shows up in computed `height`). The
// `mountApp()` harness below — identical convention to
// tests/coverage-trend.test.ts's (B) CLIENT block and confirmed explicitly
// unavailable at tests/drill-in.test.ts:1575 ("mountApp harness never loads
// public/styles.css") — never attaches public/styles.css as a real
// stylesheet. So a `getComputedStyle` assertion on `.app-trend-bar` width
// would silently read "" in BOTH the broken-today and fixed-future world —
// not a real RED/GREEN signal.
//
// Route taken: the CSS geometry contract (fixed 9px bar width/no-grow,
// 26px cluster height, left-aligned/no-stretch) is pinned via the
// SOURCE-ASSERTION technique already established in this suite
// (tests/f13-fidelity.test.ts's `ruleBody()`, reused verbatim by
// tests/pane-scroll-floor.test.ts and tests/cycle-timers.test.ts) — parsing
// the loaded public/styles.css TEXT for the `.app-trend-bars` /
// `.app-trend-bar` rule bodies and asserting the declarations directly.
// Bar COUNT, CLASS, and inline `height:<percent>%` (windowing + coloring)
// remain DOM-side pins against the REAL rendered elements, matching
// tests/coverage-trend.test.ts's existing `barHeight()` convention.
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
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

/** Same single-match technique as tests/f13-fidelity.test.ts's `ruleBody()`
 * (reused by tests/pane-scroll-floor.test.ts / tests/cycle-timers.test.ts):
 * the FIRST rule in styles.css whose selector is the exact literal text
 * given, returning its declaration body. `.app-trend-bars` /
 * `.app-trend-bar` are unambiguous bare class selectors in the source
 * (public/styles.css:321, :328), so the single-match form suffices. */
function ruleBody(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(STYLES_SRC);
  return match?.[1];
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  latestGreenCoverage?: unknown;
  coverageTrend?: number[];
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/coverage-trend.test.ts /
 * tests/coverage-click.test.ts / tests/storyboard-fidelity.test.ts. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: [] };
    else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`coverage-trend-geometry.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?coverageTrendGeom=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function trendCard(): Element | null {
  return document.querySelector('[data-testid="coverage-trend-card"]');
}

function trendBars(card: Element): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>('[data-testid="coverage-trend-bar"]'));
}

function barHeight(bar: HTMLElement): number {
  const style = bar.getAttribute("style") ?? "";
  const m = /(\d+(?:\.\d+)?)%/.exec(style);
  expect(m).not.toBeNull();
  return parseFloat(m![1]!);
}

// ── §S1 — bar geometry: fixed 9px width, no stretch, 26px cluster ──

describe("§S1 — .app-trend-bar / .app-trend-bars geometry (styles.css source-assertion, F8 mock fidelity)", () => {
  test(".app-trend-bar declares a FIXED width via `flex: 0 0 9px` (no grow/shrink) — NOT the shipped `flex: 1 1 0` stretch defect", () => {
    const body = ruleBody(".app-trend-bar");
    expect(body).toBeDefined();
    // Positive: the mock-exact fixed-width contract.
    expect(body ?? "").toMatch(/flex:\s*0\s+0\s+9px/);
    // Negative/bound: the shipped stretch declaration must be GONE.
    expect(body ?? "").not.toMatch(/flex:\s*1\s+1\s+0/);
  });

  test(".app-trend-bars cluster height is 26px — NOT the shipped 36px container", () => {
    const body = ruleBody(".app-trend-bars");
    expect(body).toBeDefined();
    expect(body ?? "").toMatch(/height:\s*26px/);
    expect(body ?? "").not.toMatch(/height:\s*36px/);
  });

  test(".app-trend-bars keeps align-items: flex-end and gap: 3px (unchanged from the mock) and does NOT force space-between/stretch distribution (left-aligned cluster)", () => {
    const body = ruleBody(".app-trend-bars");
    expect(body).toBeDefined();
    expect(body ?? "").toMatch(/align-items:\s*flex-end/);
    expect(body ?? "").toMatch(/gap:\s*3px/);
    // Bound: no explicit distribution rule that would spread bars across
    // the full card width — the left-aligned silhouette relies on the
    // bars themselves NOT growing (flex: 0 0 9px), not on justify-content.
    expect(body ?? "").not.toMatch(/justify-content:\s*(space-between|space-around|center)/);
  });
});

describe("§S1 — rendered bar count at low point counts (CR-023's >=1-point render gate stays unbroken under the new geometry)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("2-point series renders exactly 2 coverage-trend-bar elements, left-aligned cluster (no stretch) per the mock-exact CSS contract", async () => {
    const key = "trend-geom-2";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry Two-Point Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 80, total: 100, percent: 80 } },
          coverageTrend: [70, 80],
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(2);
    // Every rendered bar carries the fixed-width class — the width VALUE
    // itself is pinned via the styles.css source-assertion above (this
    // harness cannot resolve computed widths without a loaded stylesheet;
    // see the CSS PIN ROUTE note at the top of this file).
    for (const bar of bars) {
      expect(bar.className).toMatch(/\bapp-trend-bar\b/);
    }
    expect(bars.map(barHeight)).toEqual([70, 80]);
  });

  test("1-point series still renders exactly 1 bar (CR-023's >=1-point render pin) carrying the fixed-width class", async () => {
    const key = "trend-geom-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry One-Point Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 55, total: 100, percent: 55 } },
          coverageTrend: [55],
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(1);
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar\b/);
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar-latest\b/);
    expect(barHeight(bars[0]!)).toBe(55);
  });
});

// ── §S2 — last-16 windowing + window-consistent caption ──

describe("§S2 — coverage-trend series windowing: renders only the MOST RECENT 16 points", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("20-point series renders exactly 16 bars (the most recent 16, chronological, latest-last), NOT all 20", async () => {
    const key = "trend-geom-20";
    // 20 distinct, monotonically increasing points (indices 0..19, values
    // 10..29) so window membership is unambiguous: the most-recent-16
    // window is indices 4..19 (values 14..29); indices 0..3 (values
    // 10..13) must be DROPPED.
    const points = Array.from({ length: 20 }, (_, i) => 10 + i);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry Twenty-Point Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 29, total: 100, percent: 29 } },
          coverageTrend: points,
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(16);

    const heights = bars.map(barHeight);
    // Positive: exactly the windowed slice, in chronological order.
    expect(heights).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    // Bound: the 4 oldest (dropped) points never appear among rendered bars.
    for (const dropped of [10, 11, 12, 13]) {
      expect(heights).not.toContain(dropped);
    }
  });

  test("20-point series: latest (last-rendered) bar carries app-trend-bar-latest, the other 15 windowed bars carry app-trend-bar-dim", async () => {
    const key = "trend-geom-20-classes";
    const points = Array.from({ length: 20 }, (_, i) => 10 + i);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry Twenty-Point Classes Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 29, total: 100, percent: 29 } },
          coverageTrend: points,
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(16);

    const lastBar = bars[bars.length - 1]!;
    expect(lastBar.className).toMatch(/\bapp-trend-bar-latest\b/);
    expect(lastBar.className).not.toMatch(/\bapp-trend-bar-dim\b/);

    const earlierBars = bars.slice(0, -1);
    expect(earlierBars.length).toBe(15);
    for (const bar of earlierBars) {
      expect(bar.className).toMatch(/\bapp-trend-bar-dim\b/);
      expect(bar.className).not.toMatch(/\bapp-trend-bar-latest\b/);
    }
  });

  test("20-point series caption reads the WINDOW-CONSISTENT first value (points[4] -> points[19]), NOT the full-series points[0]", async () => {
    const key = "trend-geom-20-caption";
    const points = Array.from({ length: 20 }, (_, i) => 10 + i);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry Twenty-Point Caption Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 29, total: 100, percent: 29 } },
          coverageTrend: points,
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    // Positive: first RENDERED point (index 4, value 14) -> last point
    // (index 19, value 29) — window-consistent, matching what the bars show.
    expect(text).toContain("14 → 29% lines");
    // Bound: never the un-windowed full-series first value (points[0] = 10).
    expect(text).not.toContain("10 → 29% lines");
  });
});

// ── Regression guard — CR-023 §S2 fixtures unchanged under the new geometry/windowing ──

describe("Regression guard — CR-023 §S2 pins (4-point fixture: bar count, monotone heights, latest-last) unbroken by §S1/§S2 changes", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("4-point project.coverageTrend still renders 4 bars, monotone heights, latest carries app-trend-bar-latest (identical fixture to tests/coverage-trend.test.ts)", async () => {
    const key = "trend-geom-regression-4";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Regression Guard Four-Point Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 95, total: 100, percent: 95 } },
          coverageTrend: [61, 74, 88, 95],
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(4);

    const heights = bars.map(barHeight);
    expect(heights).toEqual([61, 74, 88, 95]);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1]!);
    }

    const lastBar = bars[bars.length - 1]!;
    expect(lastBar.className).toMatch(/\bapp-trend-bar-latest\b/);
    for (const bar of bars.slice(0, -1)) {
      expect(bar.className).not.toMatch(/\bapp-trend-bar-latest\b/);
    }

    expect(card!.textContent ?? "").toContain("61 → 95% lines");
  });
});
