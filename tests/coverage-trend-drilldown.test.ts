// CR-CRU-028 §S2 — coverage-trend drill-down hierarchy + per-run heat strip
// (DN-crucible-coverage-trend.md §3.3-§3.4, F8 mock lines 538-541). §S1
// (already shipped) renders auto-coarsening bucket bars from the CR-033
// date-keyed `{day,percent}[]` series (public/app-logic.mjs
// `coarsenCoverageTrend`, public/app.js `CoverageTrendCard`). §S2 layers a
// click-driven accordion ON TOP of those bars: month bar -> its weeks, week
// bar -> its days, day bar -> a per-run HEAT STRIP read from the
// already-loaded `state.events` feed (project-scoped, CR-CRU-032 §S4) —
// NEVER from the coverageTrend series itself (that series has no per-run
// identity, only one point per day). Clicking a heat slice opens the
// EXISTING run drill-in (`openDrillin`, public/app.js:640) as a pane state
// — the same `/run/<eventId>` contract tests/coverage-click.test.ts already
// pins for the coverage-meter click.
//
// TODAY (C1 shipped): CoverageTrendCard's bars carry no `onclick` at all —
// clicking is inert. Every test below is RED for that reason: no
// `coverage-drill-row`, no `coverage-heat-strip`/`coverage-heat-slice`, no
// navigation, ever appears.
//
// TESTIDS CHOSEN HERE (CR does not pin them — documented per dispatch
// instruction): `coverage-drill-row` (the single open accordion branch,
// AT MOST ONE per card at any time, per DN §3.3 "one branch open per
// card"); `coverage-heat-strip` (the day-level branch's slice container);
// `coverage-heat-slice` (one per coverage-bearing regression event, carries
// `data-event-id` so a click can be traced to the exact event it opens —
// mirrors the MOCK VERIFICATION discipline other suites in this repo use
// for click wiring, e.g. tests/coverage-click.test.ts's `latestCoverageEventId`
// pin). Level color on a heat slice reuses the orange/yellow/green ramp via
// a dedicated `app-heat-slice-<level>` class (kept distinct from the bar's
// `app-trend-bar-<level>` so the two element kinds never alias). A day bar
// whose UTC day has no matching WITHIN-RETENTION event in `state.events`
// (DN §3.4 retention honesty) carries `app-trend-bar-retention-dim` +
// `aria-disabled="true"` and must never produce a drill row of any kind.
//
// UNFOLD ALGORITHM PINNED HERE FOR month->week / week->day (RED agent's
// documented choice, same convention tests/coverage-trend-coarsening.test.ts
// used to pin `coarsenCoverageTrend` itself before it existed — "GREEN must
// implement exactly this; no other scheme satisfies these assertions" for
// the SPECIFIC fixtures below, chosen so the expected output is unambiguous
// regardless of exact chunking-window details):
//   - Unfolding a MONTH bar reveals the WEEK-level bars hidden inside it:
//     take every point whose top-level `coarsenCoverageTrend` bucketKey
//     equals the clicked month's bucketKey (the raw points collapsed into
//     that one representative bar), then group them by 7-day windows
//     counted from the SUBSET's own most-recent day (never the whole
//     series' latest day) — i.e. exactly the same day/week grouping
//     `coarsenCoverageTrend` already does, just re-anchored to the subset.
//     The fixture below places two of the month's hidden points 14 days
//     apart, which lands in two DIFFERENT 7-day windows under any
//     reasonable such scheme, so the expected 2-bar split does not depend
//     on window-boundary minutiae.
//   - Unfolding a WEEK bar reveals the DAY-level bars hidden inside it: one
//     bar per raw point whose top-level bucketKey equals the clicked week's
//     bucketKey. A week bucket's membership window is already <=7 raw days
//     by construction of the top-level algorithm, so "reveal its days" has
//     only one sane reading: show the raw points verbatim.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { coverageLevelClass } from "../public/app-logic.mjs";

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

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  latestGreenCoverage?: unknown;
  coverageTrend?: { day: string; percent: number }[];
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
  coverageLines?: number;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  events?: EventFixture[];
}

let cacheBust = 0;

/** Same mountApp harness convention as tests/coverage-trend.test.ts /
 * tests/coverage-trend-geometry.test.ts / tests/coverage-click.test.ts —
 * boots the REAL public/app.js shell inside happy-dom, only `fetch` is
 * scripted. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: opts.events ?? [] };
    else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`coverage-trend-drilldown.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?coverageTrendDrilldown=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function trendCard(): HTMLElement | null {
  return document.querySelector('[data-testid="coverage-trend-card"]');
}

/** Direct children of the coverage-trend-bars container ONLY — excludes any
 * `coverage-trend-bar` elements a drill row may itself contain (week/day
 * unfolds reuse the same testid one level down). */
function topBars(card: HTMLElement): HTMLElement[] {
  const container = card.querySelector('[data-testid="coverage-trend-bars"]');
  if (container === null) return [];
  return Array.from(container.children).filter(
    (el) => el.getAttribute("data-testid") === "coverage-trend-bar",
  ) as HTMLElement[];
}

function drillRows(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>('[data-testid="coverage-drill-row"]'));
}

function drillBars(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>('[data-testid="coverage-trend-bar"]'));
}

function heatSlices(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>('[data-testid="coverage-heat-slice"]'));
}

function barHeight(bar: HTMLElement): number {
  const style = bar.getAttribute("style") ?? "";
  const m = /(\d+(?:\.\d+)?)%/.exec(style);
  expect(m).not.toBeNull();
  return parseFloat(m![1]!);
}

/** Builds the "YYYY-MM-DD" day string `daysAgo` whole days before
 * `latestISO` — same helper convention as
 * tests/coverage-trend-coarsening.test.ts / tests/coverage-trend-geometry.test.ts. */
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

function eventAt(overrides: Partial<EventFixture> & Pick<EventFixture, "id" | "projectKey" | "timestamp">): EventFixture {
  return {
    agentId: "agent-drill",
    kind: "test",
    tier: "regression",
    total: 5,
    passed: 5,
    failed: 0,
    pending: 0,
    duration_ms: 30,
    hasCoverage: true,
    ...overrides,
  };
}

const LATEST = "2026-06-01";

// ── §S2 — accordion drill-down: month -> weeks, week -> days, one branch open per card ──

describe("§S2 — accordion drill-down (month bar unfolds hidden weeks; week bar unfolds hidden days; only one branch open at a time)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("month bar (2 hidden points 14 days apart) unfolds to exactly 2 week-level bars; clicking the week bar then CLOSES the month's row and opens a 1-bar day-level row — never 2 rows open simultaneously", async () => {
    const key = "drill-accordion-1";
    // Month bucket built from 2 points 14 days apart (2026-03-09 percent 20,
    // 2026-03-23 percent 30) — top level coarsens them to ONE month bar
    // (representative = the more recent, percent 30; verified against the
    // real coarsenCoverageTrend at RED-authoring time). Week bucket built
    // from a single point (2026-05-12 percent 55) so its unfold is
    // unambiguously 1 day bar. 3 day points round out the top-level bars
    // (unused by this test beyond proving they DON'T also get a drill row).
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Accordion Drilldown Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 80, total: 100, percent: 80 } },
          coverageTrend: [
            pointAt(LATEST, 84, 20),
            pointAt(LATEST, 70, 30),
            pointAt(LATEST, 20, 55),
            pointAt(LATEST, 2, 60),
            pointAt(LATEST, 1, 70),
            pointAt(LATEST, 0, 80),
          ],
        },
      ],
      events: [],
    });

    let card = trendCard();
    expect(card).not.toBeNull();
    let bars = topBars(card!);
    expect(bars.length).toBe(5);
    expect(bars.map(barHeight)).toEqual([30, 55, 60, 70, 80]);
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar-month\b/);
    expect(bars[1]!.className).toMatch(/\bapp-trend-bar-week\b/);

    // Nothing open yet.
    expect(drillRows(card!).length).toBe(0);

    // Click the MONTH bar.
    bars[0]!.click();
    await settle();
    card = trendCard();
    expect(card).not.toBeNull();
    expect(drillRows(card!).length).toBe(1);
    let row = drillRows(card!)[0]!;
    let unfolded = drillBars(row);
    // Positive: the 2 points HIDDEN inside the single month bar (20, 30),
    // oldest -> newest, both re-classed as week-level bars.
    expect(unfolded.length).toBe(2);
    expect(unfolded.map(barHeight)).toEqual([20, 30]);
    for (const bar of unfolded) {
      expect(bar.className).toMatch(/\bapp-trend-bar-week\b/);
      expect(bar.className).not.toMatch(/\bapp-trend-bar-month\b/);
      expect(bar.className).not.toMatch(/\bapp-trend-bar-day\b/);
    }

    // Click the WEEK bar (sibling of the month bar at the top level).
    bars = topBars(trendCard()!);
    bars[1]!.click();
    await settle();
    card = trendCard();
    expect(card).not.toBeNull();
    // Bound: STILL exactly one drill row in the whole card — the month's
    // row closed when the week's opened (accordion, not accumulation).
    expect(drillRows(card!).length).toBe(1);
    row = drillRows(card!)[0]!;
    unfolded = drillBars(row);
    // Positive: the week bar's single hidden point (55), re-classed day-level.
    expect(unfolded.length).toBe(1);
    expect(barHeight(unfolded[0]!)).toBe(55);
    expect(unfolded[0]!.className).toMatch(/\bapp-trend-bar-day\b/);
    expect(unfolded[0]!.className).not.toMatch(/\bapp-trend-bar-week\b/);
    // Bound: the month's earlier unfold content (values 20/30) is gone —
    // the only bar left in the row is the week's own 55.
    expect(unfolded.map(barHeight)).not.toContain(20);
    expect(unfolded.map(barHeight)).not.toContain(30);
  });
});

// ── §S2 — day bar -> per-run heat strip (state.events, day+project scoped) ──

describe("§S2 — day bar unfolds a per-run HEAT STRIP from state.events (project+day scoped, tier=regression + coverageLines required)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a day bar backed by 3 qualifying same-day regression coverage events reveals exactly 3 heat slices, chronologically ordered, each colored by its OWN percent's level — a different-day event, a non-regression-tier event, a no-coverage event, and a different-project event are all excluded", async () => {
    const key = "drill-heat-1";
    const otherKey = "drill-heat-other-project";
    const dayMs = Date.parse(`${LATEST}T00:00:00.000Z`);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Heat Strip Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 80, total: 100, percent: 80 } },
          coverageTrend: [pointAt(LATEST, 0, 80)],
        },
      ],
      events: [
        // Qualifying, in chronological (ascending timestamp) order.
        eventAt({
          id: "run-green",
          projectKey: key,
          timestamp: dayMs + 8 * 3_600_000,
          coverageLines: 82,
        }),
        eventAt({
          id: "run-yellow",
          projectKey: key,
          timestamp: dayMs + 10 * 3_600_000,
          coverageLines: 70,
        }),
        eventAt({
          id: "run-orange",
          projectKey: key,
          timestamp: dayMs + 14 * 3_600_000,
          coverageLines: 50,
        }),
        // Excluded: different UTC day.
        eventAt({
          id: "run-wrong-day",
          projectKey: key,
          timestamp: dayMs - 12 * 3_600_000,
          coverageLines: 90,
        }),
        // Excluded: wrong tier.
        eventAt({
          id: "run-wrong-tier",
          projectKey: key,
          timestamp: dayMs + 9 * 3_600_000,
          tier: "unit",
          coverageLines: 95,
        }),
        // Excluded: no coverage payload at all.
        eventAt({
          id: "run-no-coverage",
          projectKey: key,
          timestamp: dayMs + 11 * 3_600_000,
          hasCoverage: false,
          coverageLines: undefined,
        }),
        // Excluded: different project.
        eventAt({
          id: "run-other-project",
          projectKey: otherKey,
          timestamp: dayMs + 9 * 3_600_000,
          coverageLines: 99,
        }),
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = topBars(card!);
    expect(bars.length).toBe(1);
    expect(bars[0]!.className).not.toMatch(/\bapp-trend-bar-retention-dim\b/);

    bars[0]!.click();
    await settle();

    const rows = drillRows(trendCard()!);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    const strip = row.querySelector('[data-testid="coverage-heat-strip"]');
    expect(strip).not.toBeNull();

    const slices = heatSlices(row);
    // Positive + bound: EXACTLY the 3 qualifying events, never the 4
    // excluded ones (wrong day / wrong tier / no coverage / wrong project).
    expect(slices.length).toBe(3);

    const sliceIds = slices.map((s) => s.getAttribute("data-event-id"));
    expect(sliceIds).toEqual(["run-green", "run-yellow", "run-orange"]);
    for (const excludedId of [
      "run-wrong-day",
      "run-wrong-tier",
      "run-no-coverage",
      "run-other-project",
    ]) {
      expect(sliceIds).not.toContain(excludedId);
    }

    // Each slice is colored by its OWN percent's level (imported from the
    // same ramp §S1 already pins — never a shared/parent color).
    expect(slices[0]!.className).toMatch(
      new RegExp(`\\bapp-heat-slice-${coverageLevelClass(82)}\\b`),
    );
    expect(slices[1]!.className).toMatch(
      new RegExp(`\\bapp-heat-slice-${coverageLevelClass(70)}\\b`),
    );
    expect(slices[2]!.className).toMatch(
      new RegExp(`\\bapp-heat-slice-${coverageLevelClass(50)}\\b`),
    );
    // Bound: the green slice never also carries orange/yellow, etc.
    expect(slices[0]!.className).not.toMatch(/\bapp-heat-slice-orange\b/);
    expect(slices[0]!.className).not.toMatch(/\bapp-heat-slice-yellow\b/);
    expect(slices[2]!.className).not.toMatch(/\bapp-heat-slice-green\b/);
  });
});

// ── §S2 — heat slice click -> existing run drill-in (/run/<eventId> pane state) ──

describe("§S2 — clicking a heat slice opens the EXISTING run drill-in as a pane state (same /run/<eventId> contract as tests/coverage-click.test.ts's coverage-meter click)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("clicking the heat slice for a specific event navigates to /p/<key>/run/<eventId> and renders the real run-overlay for THAT event, not any other", async () => {
    const key = "drill-slice-nav";
    const dayMs = Date.parse(`${LATEST}T00:00:00.000Z`);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Slice Drill-in Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 80, total: 100, percent: 80 } },
          coverageTrend: [pointAt(LATEST, 0, 80)],
        },
      ],
      events: [
        eventAt({ id: "run-first", projectKey: key, timestamp: dayMs + 8 * 3_600_000, coverageLines: 82 }),
        eventAt({ id: "run-target", projectKey: key, timestamp: dayMs + 10 * 3_600_000, coverageLines: 70 }),
        eventAt({ id: "run-third", projectKey: key, timestamp: dayMs + 14 * 3_600_000, coverageLines: 50 }),
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    topBars(card!)[0]!.click();
    await settle();

    const row = drillRows(trendCard()!)[0]!;
    const slices = heatSlices(row);
    expect(slices.length).toBe(3);
    const target = slices.find((s) => s.getAttribute("data-event-id") === "run-target");
    expect(target).toBeDefined();

    target!.click();
    await settle();

    // Positive: navigated to the workspace run overlay for THIS event.
    expect(location.pathname).toBe(`/p/${key}/run/run-target`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent ?? "").toContain("run-target");
    // Bound: not the neighboring events' ids.
    expect(location.pathname).not.toContain("run-first");
    expect(location.pathname).not.toContain("run-third");
  });
});

// ── §S2 — retention honesty: rollup-only day keeps its bar, drill affordance dims, never a dead strip ──

describe("§S2 — retention honesty: a day bar with NO matching within-retention event dims its drill affordance and never unfolds a dead heat strip (DN §3.4)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("2 day bars, one backed by a live event (drillable) and one backed ONLY by the coverageTrend rollup point (no matching event) — the rollup-only bar renders dimmed + aria-disabled and produces NO drill row on click; the live-backed bar is unaffected", async () => {
    const key = "drill-retention-1";
    const liveDay = dayAt(LATEST, 1); // 2026-05-31
    const rollupOnlyDay = dayAt(LATEST, 0); // 2026-06-01 (LATEST) — no event
    const liveDayMs = Date.parse(`${liveDay}T00:00:00.000Z`);

    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Retention Dim Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 75, total: 100, percent: 75 } },
          coverageTrend: [pointAt(LATEST, 1, 60), pointAt(LATEST, 0, 75)],
        },
      ],
      events: [
        eventAt({
          id: "run-live",
          projectKey: key,
          timestamp: liveDayMs + 9 * 3_600_000,
          coverageLines: 60,
        }),
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = topBars(card!);
    expect(bars.length).toBe(2);
    const [liveBar, rollupOnlyBar] = bars;

    // Positive: the rollup-only (aged-past-retention-equivalent) bar carries
    // the dim/disabled affordance markers; the live-backed bar does not.
    expect(rollupOnlyBar!.className).toMatch(/\bapp-trend-bar-retention-dim\b/);
    expect(rollupOnlyBar!.getAttribute("aria-disabled")).toBe("true");
    expect(liveBar!.className).not.toMatch(/\bapp-trend-bar-retention-dim\b/);
    expect(liveBar!.getAttribute("aria-disabled")).not.toBe("true");

    // The dimmed bar's bucket VALUE is still rendered intact (rollup value
    // survives — only the drill affordance is gone, per DN §3.4).
    expect(barHeight(rollupOnlyBar!)).toBe(75);

    // Negative/bound: clicking the dimmed bar creates NO drill row and NO
    // heat slices anywhere — never a dead click, never a dead strip.
    rollupOnlyBar!.click();
    await settle();
    expect(drillRows(trendCard()!).length).toBe(0);
    expect(document.querySelectorAll('[data-testid="coverage-heat-slice"]').length).toBe(0);

    // Contrast: the live-backed bar behaves normally — clicking it DOES
    // unfold exactly 1 heat slice for its 1 matching event.
    topBars(trendCard()!)[0]!.click();
    await settle();
    const rows = drillRows(trendCard()!);
    expect(rows.length).toBe(1);
    const slices = heatSlices(rows[0]!);
    expect(slices.length).toBe(1);
    expect(slices[0]!.getAttribute("data-event-id")).toBe("run-live");
  });
});

// ── CR-CRU-028 §S2 FIX (ee5cb44) — the cascade: a REVEALED bar drills deeper ──
// (state.coverageDrillPath + DrillNode + unfoldCoverageSubset/finerBarsOf
// `members`). Everything above this line locks ONE level of unfold (top bar
// -> its immediate children). The FIX let a revealed (non-top) bar ITSELF be
// clicked and drill one level finer again, cascading month -> week -> day ->
// heat strip, with a per-depth accordion (state.coverageDrillPath[d]) and
// retention-dim applying to a revealed day bar exactly as it does to a top
// one. Nothing above exercises drilling PAST the first revealed level — these
// tests do.

describe("§S2 cascade — clicking a REVEALED bar drills one level deeper (DN §3.3 continuous drill)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a top-level WEEK bar unfolds to 2 revealed day bars; clicking the revealed day bar backed by 2 same-day events opens its heat strip with exactly 2 slices, chronologically ordered", async () => {
    const key = "drill-cascade-week";
    // Two points 8/10 days ago land in the SAME week-0 bucket (top level
    // coarsens them to one week bar, representative = the more recent, day8
    // percent 55); a third point at day0 is an unrelated top-level day bar.
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Cascade Week Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 80, total: 100, percent: 80 } },
          coverageTrend: [
            pointAt(LATEST, 10, 45),
            pointAt(LATEST, 8, 55),
            pointAt(LATEST, 0, 80),
          ],
        },
      ],
      events: [
        // Qualifying events on day8 (the day bar we'll drill into), ascending.
        eventAt({
          id: "week-cascade-a",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 8)}T00:00:00.000Z`) + 8 * 3_600_000,
          coverageLines: 90,
        }),
        eventAt({
          id: "week-cascade-b",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 8)}T00:00:00.000Z`) + 12 * 3_600_000,
          coverageLines: 60,
        }),
        // On the OTHER revealed day (day10) — must never leak into day8's strip.
        eventAt({
          id: "week-cascade-other-day",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 10)}T00:00:00.000Z`) + 9 * 3_600_000,
          coverageLines: 70,
        }),
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = topBars(card!);
    expect(bars.length).toBe(2);
    expect(bars.map(barHeight)).toEqual([55, 80]);
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar-week\b/);

    // Click the top-level WEEK bar — reveals its 2 hidden day bars.
    bars[0]!.click();
    await settle();

    let rows = drillRows(trendCard()!);
    expect(rows.length).toBe(1);
    let weekRow = rows[0]!;
    const dayBars = drillBars(weekRow);
    expect(dayBars.length).toBe(2);
    expect(dayBars.map(barHeight)).toEqual([45, 55]);
    for (const b of dayBars) {
      expect(b.className).toMatch(/\bapp-trend-bar-day\b/);
      expect(b.className).not.toMatch(/\bapp-trend-bar-week\b/);
    }
    // Neither revealed day bar is dimmed yet-checked here — the day8 one
    // (percent 55, index 1) has qualifying events so must NOT be dim.
    expect(dayBars[1]!.className).not.toMatch(/\bapp-trend-bar-retention-dim\b/);

    // Click the REVEALED day bar (percent 55 = day8) — this is the cascade:
    // a bar inside a drill row, itself clickable, drilling one level deeper.
    dayBars[1]!.click();
    await settle();

    // The week's row now contains a NESTED heat-strip row (cascade), not a
    // second top-level row. VanJS re-renders the subtree on state change, so
    // re-query fresh nodes rather than reuse the pre-click reference.
    rows = drillRows(trendCard()!);
    expect(rows.length).toBe(2);
    weekRow = rows[0]!;
    const slices = heatSlices(weekRow);
    // Positive + bound: exactly the 2 day8 events, never the day10 one.
    expect(slices.length).toBe(2);
    const sliceIds = slices.map((s) => s.getAttribute("data-event-id"));
    expect(sliceIds).toEqual(["week-cascade-a", "week-cascade-b"]);
    expect(sliceIds).not.toContain("week-cascade-other-day");
  });
});

describe("§S2 cascade — full month -> week -> day -> heat-strip chain (DN §3.3, each revealed bar drills deeper)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("clicking a month bar reveals weeks; clicking the 2-point week reveals days; clicking the day opens its heat strip — the complete 4-level cascade", async () => {
    const key = "drill-cascade-full-chain";
    // Month bucket built from 3 points (65/68/85 days ago — all >=63 so
    // top-level MONTH, all sharing the same YYYY-MM so they merge into ONE
    // top-level month bar, representative = 65-days-ago, percent 40). Inside
    // the month: 65 and 68 days ago land in the SAME 7-day window (3 days
    // apart, re-anchored to the subset's own latest day) -> one week bar
    // with 2 members that can itself be drilled to 2 day bars; 85 days ago
    // is a lone sibling week (1 member) proving the month has >1 week.
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Full Chain Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 80, total: 100, percent: 80 } },
          coverageTrend: [
            pointAt(LATEST, 85, 50),
            pointAt(LATEST, 68, 45),
            pointAt(LATEST, 65, 40),
            pointAt(LATEST, 0, 80),
          ],
        },
      ],
      events: [
        eventAt({
          id: "chain-run-a",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 65)}T00:00:00.000Z`) + 8 * 3_600_000,
          coverageLines: 90,
        }),
        eventAt({
          id: "chain-run-b",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 65)}T00:00:00.000Z`) + 12 * 3_600_000,
          coverageLines: 60,
        }),
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = topBars(card!);
    expect(bars.length).toBe(2);
    expect(bars.map(barHeight)).toEqual([40, 80]);
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar-month\b/);

    // Depth 0 -> 1: click the MONTH bar, reveals 2 WEEK bars.
    bars[0]!.click();
    await settle();
    let row0 = drillRows(trendCard()!)[0]!;
    let weekBars = drillBars(row0);
    expect(weekBars.length).toBe(2);
    expect(weekBars.map(barHeight)).toEqual([50, 40]);
    for (const b of weekBars) expect(b.className).toMatch(/\bapp-trend-bar-week\b/);

    // Depth 1 -> 2: click the 2-member week bar (percent 40) — the CASCADE —
    // reveals 2 DAY bars hidden inside it.
    weekBars[1]!.click();
    await settle();
    row0 = drillRows(trendCard()!)[0]!;
    const dayBars = drillBars(row0).filter(
      (b) => b.className.includes("app-trend-bar-day"),
    );
    expect(dayBars.length).toBe(2);
    expect(dayBars.map(barHeight)).toEqual([45, 40]);

    // Depth 2 -> 3: click the revealed day bar (percent 40) — the SECOND
    // cascade hop — opens its heat strip. Re-query fresh after the click —
    // VanJS replaces the subtree, so the pre-click `row0` reference is stale.
    dayBars[1]!.click();
    await settle();
    row0 = drillRows(trendCard()!)[0]!;

    const slices = heatSlices(row0);
    expect(slices.length).toBe(2);
    const sliceIds = slices.map((s) => s.getAttribute("data-event-id"));
    expect(sliceIds).toEqual(["chain-run-a", "chain-run-b"]);
    // Bound: the whole card now nests 3 drill rows (month's, week's, day's) —
    // never a flat/duplicated top-level accumulation.
    expect(drillRows(trendCard()!).length).toBe(3);
  });
});

describe("§S2 cascade — per-depth accordion (a sibling at any depth closes the other branch and drops everything deeper)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("after drilling month -> week -> day -> heat-strip, clicking the SIBLING week bar at depth 1 closes that whole branch — the day bars and heat slices it contained vanish, and the sibling's own single day bar is what's shown", async () => {
    const key = "drill-cascade-accordion-depth1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Depth Accordion Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 80, total: 100, percent: 80 } },
          coverageTrend: [
            pointAt(LATEST, 85, 50),
            pointAt(LATEST, 68, 45),
            pointAt(LATEST, 65, 40),
            pointAt(LATEST, 0, 80),
          ],
        },
      ],
      events: [
        eventAt({
          id: "accordion-run-a",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 65)}T00:00:00.000Z`) + 8 * 3_600_000,
          coverageLines: 90,
        }),
        eventAt({
          id: "accordion-run-b",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 65)}T00:00:00.000Z`) + 12 * 3_600_000,
          coverageLines: 60,
        }),
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = topBars(card!);
    expect(bars.length).toBe(2);

    // Drive the SAME 4-level chain as the previous describe block: month ->
    // 2-member week -> 2 day bars -> heat strip (2 slices).
    bars[0]!.click();
    await settle();
    let row0 = drillRows(trendCard()!)[0]!;
    let weekBars = drillBars(row0);
    expect(weekBars.length).toBe(2);
    weekBars[1]!.click(); // the 2-member week (percent 40)
    await settle();
    row0 = drillRows(trendCard()!)[0]!;
    let dayBars = drillBars(row0).filter((b) => b.className.includes("app-trend-bar-day"));
    expect(dayBars.length).toBe(2);
    dayBars[1]!.click(); // opens the heat strip
    await settle();
    row0 = drillRows(trendCard()!)[0]!; // re-query — VanJS replaced the subtree
    expect(heatSlices(row0).length).toBe(2);
    expect(drillRows(trendCard()!).length).toBe(3);

    // Now click the SIBLING week bar at depth 1 (percent 50, 1 member) — this
    // must close the percent-40 branch (its day bars AND its heat strip)
    // entirely, per-depth accordion. `row0`'s subtree now also nests the
    // already-revealed day bars, so filter to week-level bars specifically
    // (drillBars alone would return all 4: the 2 week bars PLUS the 2 nested
    // day bars).
    row0 = drillRows(trendCard()!)[0]!;
    weekBars = drillBars(row0).filter((b) => b.className.includes("app-trend-bar-week"));
    expect(weekBars.length).toBe(2);
    weekBars[0]!.click(); // sibling, percent 50
    await settle();

    // Bound: the old branch's content is completely gone — no heat slices
    // anywhere in the card, and neither old-branch event id survives.
    expect(document.querySelectorAll('[data-testid="coverage-heat-slice"]').length).toBe(0);
    expect(
      document.querySelectorAll('[data-event-id="accordion-run-a"]').length,
    ).toBe(0);
    expect(
      document.querySelectorAll('[data-event-id="accordion-run-b"]').length,
    ).toBe(0);

    // Positive: the sibling's own branch is what's now open — its single
    // member unfolds to exactly 1 day bar (percent 50), nothing deeper yet.
    row0 = drillRows(trendCard()!)[0]!;
    dayBars = drillBars(row0).filter((b) => b.className.includes("app-trend-bar-day"));
    expect(dayBars.length).toBe(1);
    expect(barHeight(dayBars[0]!)).toBe(50);
    // Only 2 rows now (month's + the sibling week's) — the day/heat-strip
    // rows that existed under the OLD sibling are gone, never accumulated.
    expect(drillRows(trendCard()!).length).toBe(2);
  });
});

describe("§S2 cascade — retention honesty applies to a REVEALED (non-top) day bar too (DN §3.4)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a week bar unfolds 2 day bars; the one with NO matching within-retention event is dimmed and produces no drill row on click, while its sibling with a matching event opens exactly 1 heat slice", async () => {
    const key = "drill-cascade-retention-depth1";
    // 9/11 days ago land in the same week-0 bucket (distinct from the other
    // cascade tests' 8/10 pair, so fixtures never alias). A day0 anchor point
    // is required so the series' OWN latest day is LATEST itself — without
    // it, day9 (the more recent of the pair) would BE the series latest and
    // both points would coarsen to DAY buckets instead of one WEEK bucket.
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Depth Retention Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 90, total: 100, percent: 90 } },
          coverageTrend: [pointAt(LATEST, 11, 58), pointAt(LATEST, 9, 42), pointAt(LATEST, 0, 85)],
        },
      ],
      events: [
        // Only day9 (the more recent of the pair) has a qualifying event.
        eventAt({
          id: "depth-retention-live",
          projectKey: key,
          timestamp: Date.parse(`${dayAt(LATEST, 9)}T00:00:00.000Z`) + 8 * 3_600_000,
          coverageLines: 88,
        }),
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = topBars(card!);
    // The 9/11-days-ago points fold into a single top-level WEEK bucket; the
    // day0 anchor is its own (unrelated) top-level DAY bucket.
    expect(bars.length).toBe(2);
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar-week\b/);
    expect(barHeight(bars[0]!)).toBe(42);

    bars[0]!.click();
    await settle();

    const row = drillRows(trendCard()!)[0]!;
    const dayBars = drillBars(row);
    expect(dayBars.length).toBe(2);
    // Oldest (day11, no event) first, then day9 (has the event).
    expect(dayBars.map(barHeight)).toEqual([58, 42]);

    const [dimBar, liveBar] = dayBars;
    // Positive: the event-less revealed day bar carries the dim/disabled
    // affordance markers.
    expect(dimBar!.className).toMatch(/\bapp-trend-bar-retention-dim\b/);
    expect(dimBar!.getAttribute("aria-disabled")).toBe("true");
    // Bound: its sibling (backed by a live event) carries neither.
    expect(liveBar!.className).not.toMatch(/\bapp-trend-bar-retention-dim\b/);
    expect(liveBar!.getAttribute("aria-disabled")).not.toBe("true");

    // Negative/bound: clicking the dimmed revealed bar produces NO new drill
    // row and NO heat slices anywhere — never a dead click at depth either.
    dimBar!.click();
    await settle();
    expect(drillRows(trendCard()!).length).toBe(1); // still only the week's row
    expect(document.querySelectorAll('[data-testid="coverage-heat-slice"]').length).toBe(0);

    // Contrast: the live revealed bar drills normally — exactly 1 heat slice
    // for its 1 matching event.
    liveBar!.click();
    await settle();
    const slices = heatSlices(drillRows(trendCard()!)[0]!);
    expect(slices.length).toBe(1);
    expect(slices[0]!.getAttribute("data-event-id")).toBe("depth-retention-live");
  });
});
