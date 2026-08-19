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
  /** CR-CRU-033 §S2 — date-keyed series: { day: "YYYY-MM-DD", percent }[],
   * oldest→newest. */
  coverageTrend?: { day: string; percent: number }[];
}

/** N consecutive distinct UTC-day strings starting at `start`, ascending —
 * pairs 1:1 with a percents array to build a CR-CRU-033 §S2 coverageTrend
 * fixture (same percents/order as before the shape change, now dated). */
function consecutiveDays(start: string, n: number): string[] {
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime();
  return Array.from({ length: n }, (_, i) =>
    new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
  );
}

function datedTrend(percents: number[], start = "2026-02-01"): { day: string; percent: number }[] {
  const days = consecutiveDays(start, percents.length);
  return percents.map((percent, i) => ({ day: days[i]!, percent }));
}

/** CR-CRU-028 §S1 — the "YYYY-MM-DD" day string `daysAgo` whole days before
 * `latestISO`. Same boundary-scheme helper as tests/coverage-trend-coarsening.test.ts
 * (day <7 / week [7,63) / month >=63, relative to the SERIES' OWN latest
 * point, never wall-clock "today") — used here to build fixtures that
 * deliberately land in a specific coarsening level for render-level (DOM)
 * assertions. */
function dayAt(latestISO: string, daysAgo: number): string {
  const latestMs = Date.parse(`${latestISO}T00:00:00.000Z`);
  return new Date(latestMs - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function pointAt(
  latestISO: string,
  daysAgo: number,
  percent: number,
): { day: string; percent: number } {
  return { day: dayAt(latestISO, daysAgo), percent };
}

const S1_LATEST = "2026-06-01";

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
  // CR-CRU-028 §S1 CONTRACT CHANGE (noted per RED dispatch instruction):
  // CR-027 pinned a single UNIFORM `.app-trend-bar { flex: 0 0 9px }` — every
  // bar in the flat sparkline was the same width. §S1 replaces the flat
  // sparkline with auto-coarsening bucket bars whose width hints the ZOOM
  // LEVEL and must STRICTLY INCREASE month < week < day (CR text, DN §3.1,
  // F8 mock lines 535-541: month bars 6px, week bars 9px, day bars 12px). A
  // single bare `.app-trend-bar` rule can no longer carry one fixed width
  // for every bar — the width moves to three level-specific modifier
  // classes. This test replaces (not extends) the old CR-027 uniform-9px
  // pin, which is no longer a valid contract once per-level widths exist.
  test("§S1 — .app-trend-bar-month / -week / -day each declare a FIXED, STRICTLY INCREASING width (6px < 9px < 12px, F8 mock lines 535-541) — replaces the CR-027 uniform-9px-for-every-bar contract", () => {
    const monthBody = ruleBody(".app-trend-bar-month");
    const weekBody = ruleBody(".app-trend-bar-week");
    const dayBody = ruleBody(".app-trend-bar-day");
    expect(monthBody).toBeDefined();
    expect(weekBody).toBeDefined();
    expect(dayBody).toBeDefined();
    // Positive: the exact mock-pinned per-level widths.
    expect(monthBody ?? "").toMatch(/flex:\s*0\s+0\s+6px/);
    expect(weekBody ?? "").toMatch(/flex:\s*0\s+0\s+9px/);
    expect(dayBody ?? "").toMatch(/flex:\s*0\s+0\s+12px/);
    // Negative/bound: none of the three levels stretch (CR-027's fixed-slice
    // discipline holds at every level, per the CR's non-goal text).
    for (const body of [monthBody, weekBody, dayBody]) {
      expect(body ?? "").not.toMatch(/flex:\s*1\s+1\s+0/);
    }
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
          coverageTrend: datedTrend([70, 80]),
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
          coverageTrend: datedTrend([55]),
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

// ── §S1 — CR-CRU-028 CONTRACT CHANGE (noted per RED dispatch instruction) ──
//
// The CR-027 "§S2 windowing" describe block that lived here asserted a flat
// one-bar-per-raw-point contract (a 20-point series renders the most recent
// 16 RAW points as 16 bars, non-latest bars all carrying `app-trend-bar-dim`).
// §S1 replaces bars with BUCKETS: older points COARSEN into week/month
// buckets instead of rendering one bar each, and the generic "-dim" class is
// retired entirely — every bar (latest or not) now carries a LEVEL color
// class instead. The old block's literal assertions (16 bars from a 20-point
// series; `-dim` present) are therefore FALSE under the new contract and are
// replaced below with the auto-coarsening equivalents (same underlying
// `datedTrend` 20-point fixture reused where it still demonstrates the
// point — the CR-027 fixture no longer produces 16 bars, it produces 9,
// which is itself the behavioural proof that coarsening replaced windowing).

describe("§S1 — coverage-trend rendering coarsens buckets instead of windowing raw points (replaces CR-027 §S2's flat last-16-raw-points contract)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("the SAME 20 consecutive-day, monotonically increasing points (values 10..29) that CR-027 windowed to 16 raw bars now coarsen to exactly 9 bucket bars (2 week + 7 day) — proof bars are buckets, not a raw-point window", async () => {
    const key = "trend-geom-20-coarsened";
    // Reuses the CR-027 fixture verbatim (20 consecutive days, values
    // 10..29) — under §S1's boundary scheme (relative to the series' own
    // latest day, 2026-02-20): indices 13..19 (daysAgo 0..6) stay DAY
    // buckets (values 23..29); indices 6..12 (daysAgo 7..13) collapse into
    // ONE week bucket valued by the most-recent point in range (index 12,
    // value 22); indices 0..5 (daysAgo 14..19) collapse into a second week
    // bucket valued by index 5 (value 15).
    const points = Array.from({ length: 20 }, (_, i) => 10 + i);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry Twenty-Point Coarsened Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 29, total: 100, percent: 29 } },
          coverageTrend: datedTrend(points),
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(9);

    const heights = bars.map(barHeight);
    // Positive: the coarsened bucket values, oldest -> newest.
    expect(heights).toEqual([15, 22, 23, 24, 25, 26, 27, 28, 29]);
    // Bound: the raw dropped/merged-away values (10..14, 16..21, except
    // where they coincide with a surviving day value) never appear as their
    // OWN bar — in particular the un-coarsened literal 16-bar window this
    // series used to produce is gone.
    expect(bars.length).not.toBe(16);
    expect(bars.length).not.toBe(20);

    // Every bar carries its level's width class (day for the recent 7,
    // week for the 2 coarsened buckets) — never the retired "-dim" class.
    const dayBars = bars.slice(-7);
    const weekBars = bars.slice(0, 2);
    for (const bar of dayBars) expect(bar.className).toMatch(/\bapp-trend-bar-day\b/);
    for (const bar of weekBars) expect(bar.className).toMatch(/\bapp-trend-bar-week\b/);
    for (const bar of bars) expect(bar.className).not.toMatch(/\bapp-trend-bar-dim\b/);
  });

  test("caption reads the coarsened FIRST BUCKET's value -> the LATEST bucket's value (15 -> 29), not the raw full-series points[0] (10) and not the old windowed points[4] (14)", async () => {
    const key = "trend-geom-20-coarsened-caption";
    const points = Array.from({ length: 20 }, (_, i) => 10 + i);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry Twenty-Point Coarsened Caption Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 29, total: 100, percent: 29 } },
          coverageTrend: datedTrend(points),
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("15 → 29% lines");
    expect(text).not.toContain("10 → 29% lines");
    expect(text).not.toContain("14 → 29% lines");
  });
});

describe("§S1 — a fixture spanning 3 months renders <=16 mixed-level bucket bars, oldest -> newest, each carrying its level's width class (CR-CRU-028 §S1 bucketing AC)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("90 consecutive daily points (spanning ~3 calendar months) render exactly 16 coverage-trend-bar elements: 1 month bar + 8 week bars + 7 day bars, in that oldest -> newest order", async () => {
    const key = "trend-geom-90-buckets";
    // Identical fixture/derivation to
    // tests/coverage-trend-coarsening.test.ts's pure-logic pin: percent(i) =
    // i for i in 0..89, daysAgo = 89-i, so the bucket composition and exact
    // representative values are the same 16 numbers pinned there.
    const points = Array.from({ length: 90 }, (_, i) => pointAt(S1_LATEST, 89 - i, i));
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Geometry Ninety-Point Bucket Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 89, total: 100, percent: 89 } },
          coverageTrend: points,
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(16);
    // Bound: never one bar per raw point (90), never the pre-cap raw count.
    expect(bars.length).not.toBe(90);

    const heights = bars.map(barHeight);
    expect(heights).toEqual([26, 33, 40, 47, 54, 61, 68, 75, 82, 83, 84, 85, 86, 87, 88, 89]);

    // Positive: per-level width class, in the pinned oldest->newest order —
    // 1 month, then 8 week, then 7 day.
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar-month\b/);
    for (const bar of bars.slice(1, 9)) {
      expect(bar.className).toMatch(/\bapp-trend-bar-week\b/);
    }
    for (const bar of bars.slice(9)) {
      expect(bar.className).toMatch(/\bapp-trend-bar-day\b/);
    }
    // Bound: no bar carries more than one level-width class.
    for (const bar of bars) {
      const levelClasses = ["month", "week", "day"].filter((lvl) =>
        new RegExp(`\\bapp-trend-bar-${lvl}\\b`).test(bar.className),
      );
      expect(levelClasses.length).toBe(1);
    }
  });
});

describe("§S1 — level color classes (orange/yellow/green ramp, boundary-pinned; DN §3.2, named constants COVERAGE_LEVEL_ORANGE_MAX=65/COVERAGE_LEVEL_YELLOW_MAX=80)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  async function mountSinglePointCard(key: string, percent: number): Promise<Element> {
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: `Level Color ${percent} Project`,
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: percent, total: 100, percent } },
          coverageTrend: datedTrend([percent]),
        },
      ],
    });
    const card = trendCard();
    expect(card).not.toBeNull();
    return card!;
  }

  test("a bucket valued 64 (< COVERAGE_LEVEL_ORANGE_MAX) carries app-trend-bar-orange, never -yellow/-green", async () => {
    const card = await mountSinglePointCard("trend-geom-level-64", 64);
    const bar = trendBars(card)[0]!;
    expect(bar.className).toMatch(/\bapp-trend-bar-orange\b/);
    expect(bar.className).not.toMatch(/\bapp-trend-bar-yellow\b/);
    expect(bar.className).not.toMatch(/\bapp-trend-bar-green\b/);
  });

  test("a bucket valued 65 (== COVERAGE_LEVEL_ORANGE_MAX, boundary) carries app-trend-bar-yellow, never -orange", async () => {
    const card = await mountSinglePointCard("trend-geom-level-65", 65);
    const bar = trendBars(card)[0]!;
    expect(bar.className).toMatch(/\bapp-trend-bar-yellow\b/);
    expect(bar.className).not.toMatch(/\bapp-trend-bar-orange\b/);
  });

  test("a bucket valued 79 (upper edge of [65,80)) still carries app-trend-bar-yellow, never -green", async () => {
    const card = await mountSinglePointCard("trend-geom-level-79", 79);
    const bar = trendBars(card)[0]!;
    expect(bar.className).toMatch(/\bapp-trend-bar-yellow\b/);
    expect(bar.className).not.toMatch(/\bapp-trend-bar-green\b/);
  });

  test("a bucket valued 80 (== COVERAGE_LEVEL_YELLOW_MAX) carries app-trend-bar-green, never -yellow", async () => {
    const card = await mountSinglePointCard("trend-geom-level-80", 80);
    const bar = trendBars(card)[0]!;
    expect(bar.className).toMatch(/\bapp-trend-bar-green\b/);
    expect(bar.className).not.toMatch(/\bapp-trend-bar-yellow\b/);
  });

  test("a monotone-high series (5 points, all >=80) renders EVERY bar app-trend-bar-green (the user's screenshot case) — none orange/yellow", async () => {
    const key = "trend-geom-monotone-high";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Monotone High Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 95, total: 100, percent: 95 } },
          coverageTrend: datedTrend([85, 88, 90, 92, 95]),
        },
      ],
    });
    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(5);
    for (const bar of bars) {
      expect(bar.className).toMatch(/\bapp-trend-bar-green\b/);
      expect(bar.className).not.toMatch(/\bapp-trend-bar-orange\b/);
      expect(bar.className).not.toMatch(/\bapp-trend-bar-yellow\b/);
    }
  });
});

describe("§S1 — the latest bucket composes emphasis with its level color (both classes present, not one replacing the other); the retired app-trend-bar-dim class never appears", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a 2-point series (orange then green) renders the latest bar with BOTH app-trend-bar-latest AND app-trend-bar-green; the earlier bar carries app-trend-bar-orange and NEVER app-trend-bar-latest", async () => {
    const key = "trend-geom-latest-composition";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Latest Composition Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 90, total: 100, percent: 90 } },
          coverageTrend: datedTrend([50, 90]),
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(2);

    const earlier = bars[0]!;
    const latest = bars[1]!;

    // Positive: latest bar composes BOTH classes together.
    expect(latest.className).toMatch(/\bapp-trend-bar-latest\b/);
    expect(latest.className).toMatch(/\bapp-trend-bar-green\b/);
    // Positive: earlier bar carries its own level color.
    expect(earlier.className).toMatch(/\bapp-trend-bar-orange\b/);
    // Negative/bound: emphasis never appears on the earlier bar; the level
    // color is never REPLACED by the emphasis marker on the latest bar.
    expect(earlier.className).not.toMatch(/\bapp-trend-bar-latest\b/);
    expect(latest.className).not.toMatch(/\bapp-trend-bar-orange\b/);
    // Bound: the retired CR-023-era "-dim" class appears on NEITHER bar
    // under the §S1 contract (color now conveys level, not recency).
    expect(earlier.className).not.toMatch(/\bapp-trend-bar-dim\b/);
    expect(latest.className).not.toMatch(/\bapp-trend-bar-dim\b/);
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
          coverageTrend: datedTrend([61, 74, 88, 95]),
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
