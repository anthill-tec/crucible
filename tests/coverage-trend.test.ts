// CR-CRU-023 §S2 — Vitals COVERAGE TREND bar-chart regression (user
// 2026-07-17: "Fix this in the next patch CR!"). Root cause (orchestrator
// gap analysis, pinned here): public/app.js coverageTrendPoints() derives
// the trend from the TRANSIENT client event feed (state.events filtered for
// coverageLines) — event retention/rollup pruning collapses the surviving
// slice below 2 points, and CoverageTrendCard only renders bars at
// points.length >= 2 (text-only fallback otherwise). The fix is a DURABLE,
// server-side source: store.listRollups() survives retention (events fold
// into per-bucket rollups carrying `lastCoverage` BEFORE the raw row is
// deleted — see src/store.ts enforceRetention/foldIntoRollup), so the
// project payload (GET /api/v2/projects, src/v2.ts handleProjectsList) must
// grow an additive `coverageTrend` field built from that rollup series, and
// the client must render bars from THAT field instead of state.events.
//
// Shape decision (RED finding, recorded per dispatch instruction): plain
// `coverageTrend: number[]` — the green-regression coverage LINES percent
// per surviving rollup bucket, oldest→newest, present only when >=1 rollup
// carries `lastCoverage` (key ABSENT — not null/empty — otherwise, mirroring
// the existing `latestCoverageEventId` absent-not-null convention pinned in
// tests/coverage-click.test.ts). This is the SAME shape
// coverageTrendPoints() already produces client-side today (an ordered
// array of percent numbers) — moving the computation server-side, onto the
// durable rollup series, without inventing a new per-point shape (rollups
// have no per-point timestamp column; `bucket` is a wave id or a UTC-day
// string, not a numeric ts, so a `{ts, lines}` shape would need an
// unrequested schema addition — out of scope for this AC, which only pins
// point COUNT, VALUE, and oldest→newest ORDER).
//
// (A) SERVER — GET /api/v2/projects carries coverageTrend, sourced from
// store.listRollups() (durable), NOT store.listEvents() (transient/pruned).
// Forced via the existing retention-override test technique (see
// tests/events.test.ts "Store — per-project retention override (§S4)"):
// addProject({ retention: 0 }) makes EVERY insertEvent immediately overflow
// (count 1 > cap 0) and fold+delete, so raw events never survive — proving
// the trend cannot be reading state.events/listEvents.
//
// (B) CLIENT — CoverageTrendCard (public/app.js) renders coverage-trend-bar
// elements from project.coverageTrend (not state.events): 4 points -> 4
// bars, monotone heights, latest-last, latest carries app-trend-bar-latest;
// 1 point -> 1 bar (the points.length >= 2 gate is the defect — no
// text-only fallback at 1 point); 0 points -> no bars container, existing
// latest-coverage caption text still renders (graceful).
//
// Boots the REAL public/app.js shell inside happy-dom — same harness
// convention as tests/coverage-click.test.ts / tests/storyboard-fidelity.test.ts
// (real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js; only `fetch` is scripted).
import { describe, test, expect, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";

// ── (S1) STORE — rollup buckets keyed by UTC day, never by wave (CR-CRU-033 §S1) ──
//
// Store.foldIntoRollup currently buckets `context.wave ?? UTC-day` — a
// coverage event carrying context.wave folds into a WAVE-keyed bucket (e.g.
// "4") with no date. §S1 drops the `context.wave ??` prefix so EVERY fold
// buckets by the event's UTC day, always. Driven the same way the (A) SERVER
// tests below force a fold: addProject({ retention: 0 }) makes every
// insertEvent immediately overflow (count 1 > cap 0) and fold+delete, so the
// bucket key is observable via store.listRollups() without waiting on real
// wall-clock retention. bun:test's setSystemTime() pins Date.now() (and thus
// the event's timestamp) to a known UTC day before each recordTestEvent call
// — same clock-injection technique as tests/cycle-epochs.test.ts /
// tests/checkpoint-stop.test.ts.

function coverageSummary(overrides?: Partial<RunSummary>): RunSummary {
  return { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 20, ...overrides };
}

const s1EmptyTree: SuiteNode[] = [];

describe("Store#foldIntoRollup — bucket key is always UTC day (CR-CRU-033 §S1)", () => {
  afterEach(() => {
    setSystemTime(); // reset the injected clock so it never leaks to other files
  });

  test("a wave-tagged coverage event folds into its UTC-day bucket, never the wave id; two same-day events (one wave-tagged, one not) fold into ONE bucket with runs=2", () => {
    const store = new Store(":memory:");
    const key = crypto.randomUUID();
    // retention: 0 forces every insertEvent to immediately overflow (count
    // 1 > cap 0) and fold into a rollup — same technique as the (A) SERVER
    // describe block above.
    store.addProject({ key, name: "s1-wave-day", type: "backend", sutRoot: "/tmp/s1-wave-day", retention: 0 });

    // Event A: carries context.wave="4", timestamp pinned to 2026-07-14.
    setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
    store.recordTestEvent(
      key,
      "agent-s1-a",
      {
        summary: coverageSummary(),
        tree: s1EmptyTree,
        coverage: { lines: { total: 100, covered: 70, percent: 70 } },
      },
      { tier: "regression", context: { wave: "4" } },
    );

    // §S1 AC: the wave-tagged event's persisted bucket is its UTC day
    // ("2026-07-14"), NEVER the wave id ("4"). Every bucket in the table
    // must be a UTC-day string.
    const afterFirstFold = store.listRollups(key);
    for (const rollup of afterFirstFold) {
      expect(rollup.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const waveBucket = afterFirstFold.find((r) => r.bucket === "4");
    expect(waveBucket).toBeUndefined();
    const dayBucketAfterA = afterFirstFold.find((r) => r.bucket === "2026-07-14");
    expect(dayBucketAfterA).toBeDefined();
    expect(dayBucketAfterA!.runs).toBe(1);

    // Event B: SAME UTC day (2026-07-14), no wave context at all.
    setSystemTime(new Date("2026-07-14T18:00:00.000Z"));
    store.recordTestEvent(
      key,
      "agent-s1-b",
      {
        summary: coverageSummary(),
        tree: s1EmptyTree,
        coverage: { lines: { total: 100, covered: 90, percent: 90 } },
      },
      { tier: "regression" },
    );

    // §S1 AC: A and B fold into the SAME "YYYY-MM-DD" bucket — exactly one
    // rollup row for that day, with runs=2 (not split into a "4" bucket +
    // a date bucket).
    const afterSecondFold = store.listRollups(key);
    expect(afterSecondFold.length).toBe(1);
    const combined = afterSecondFold[0]!;
    expect(combined.bucket).toBe("2026-07-14");
    expect(combined.runs).toBe(2);
    // Negative bound: no leftover wave-keyed bucket anywhere.
    expect(afterSecondFold.some((r) => r.bucket === "4")).toBe(false);
  });
});

// ── (A) SERVER — coverageTrend sourced from the durable rollup series ──

interface ProjectPayload {
  key: string;
  coverageTrend?: number[];
  [key: string]: unknown;
}

interface ProjectsListResponse {
  ok: true;
  projects: ProjectPayload[];
}

describe("GET /api/v2/projects — coverageTrend (durable rollup series, CR-CRU-023 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function projectsList(): Promise<ProjectPayload[]> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/projects`);
    const body = (await res.json()) as ProjectsListResponse;
    return body.projects;
  }

  test("4 coverage-bearing green-regression runs, all pruned past retention: coverageTrend still returns all 4 points, oldest→newest", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    // retention: 0 forces every insertEvent to immediately overflow (count
    // 1 > cap 0) and fold into a rollup + delete the raw row — the trend
    // can only survive if it reads the durable rollup series.
    store.addProject({ key, name: "trend-4", type: "backend", sutRoot: "/tmp/trend-4", retention: 0 });

    const percents = [61, 74, 88, 95];
    for (let i = 0; i < percents.length; i++) {
      store.recordTestEvent(
        key,
        `agent-trend-${i}`,
        {
          summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 50 },
          tree: [],
          coverage: { lines: { total: 100, covered: percents[i]!, percent: percents[i]! } },
        },
        // Distinct buckets (wave ids) so each fold lands in its OWN rollup
        // row — rollups are keyed (project_key, bucket), so same-bucket
        // folds would collapse to a single lastCoverage, not 4 points.
        { tier: "regression", context: { wave: `w${i + 1}` } },
      );
    }

    // Sanity: retention: 0 really did prune every raw event away.
    expect(store.listEvents(key, 1000).length).toBe(0);
    expect(store.listRollups(key).length).toBe(4);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.coverageTrend).toEqual(percents);
  });

  test("1 coverage-bearing green-regression run, pruned past retention: coverageTrend returns exactly 1 point", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "trend-1", type: "backend", sutRoot: "/tmp/trend-1", retention: 0 });

    store.recordTestEvent(
      key,
      "agent-trend-single",
      {
        summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 30 },
        tree: [],
        coverage: { lines: { total: 100, covered: 55, percent: 55 } },
      },
      { tier: "regression", context: { wave: "w-single" } },
    );

    expect(store.listEvents(key, 1000).length).toBe(0);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.coverageTrend).toEqual([55]);
  });

  test("fresh project with no coverage-bearing rollup: coverageTrend is ABSENT from the payload (not merely empty/null)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "trend-0", type: "backend", sutRoot: "/tmp/trend-0" });

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(project, "coverageTrend")).toBe(false);
  });

  test("a FAILING run carrying a coverage payload never contributes a coverageTrend point (§S4 discard-on-fail), even when pruned", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "trend-fail", type: "backend", sutRoot: "/tmp/trend-fail", retention: 0 });

    store.recordTestEvent(
      key,
      "agent-trend-fail",
      {
        summary: { total: 5, passed: 3, failed: 2, pending: 0, duration_ms: 40 },
        tree: [],
        coverage: { lines: { total: 100, covered: 80, percent: 80 } },
      },
      { tier: "regression", context: { wave: "w-fail" } },
    );

    expect(store.listEvents(key, 1000).length).toBe(0);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(project, "coverageTrend")).toBe(false);
  });
});

// ── (B) CLIENT — Vitals COVERAGE TREND bars render from the SERVER series ──

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
  /** CR-CRU-023 §S2 — the durable rollup-backed trend series (see (A) above). */
  coverageTrend?: number[];
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  events?: EventFixture[];
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/coverage-click.test.ts. */
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
    } else throw new Error(`coverage-trend.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?coverageTrend=${cacheBust}`);

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

describe("workspace Vitals COVERAGE TREND bars — driven by the SERVER coverageTrend series (CR-CRU-023 §S2)", () => {
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("4-point project.coverageTrend renders 4 bars even with an EMPTY client event feed (the durability fix — bars no longer depend on state.events)", async () => {
    const key = "trend-durable-4";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Durable Trend Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 95, total: 100, percent: 95 } },
          coverageTrend: [61, 74, 88, 95],
        },
      ],
      // Client event feed is EMPTY — simulating full retention pruning.
      // Bars must still render because they come from the server field.
      events: [],
    });

    const card = trendCard();
    expect(card).not.toBeNull();

    const barsContainer = card!.querySelector('[data-testid="coverage-trend-bars"]');
    expect(barsContainer).not.toBeNull();

    const bars = trendBars(card!);
    expect(bars.length).toBe(4);

    const heights = bars.map(barHeight);
    expect(heights).toEqual([61, 74, 88, 95]);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1]!);
    }

    // Latest (last, highest coverage) bar carries app-trend-bar-latest;
    // no earlier bar does.
    const lastBar = bars[bars.length - 1]!;
    expect(lastBar.className).toMatch(/\bapp-trend-bar-latest\b/);
    for (const bar of bars.slice(0, -1)) {
      expect(bar.className).not.toMatch(/\bapp-trend-bar-latest\b/);
    }

    expect(card!.textContent ?? "").toContain("61 → 95% lines");
  });

  test("bars mirror project.coverageTrend, NOT a differing client event feed (proves the SERVER series is the source, not state.events)", async () => {
    const key = "trend-not-events";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Not-Events Trend Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 40, total: 100, percent: 40 } },
          coverageTrend: [10, 20, 30, 40],
        },
      ],
      // A DIFFERENT, stale client-side event feed — if bars were still
      // reading state.events (the root-cause defect), they'd show these 2
      // values instead of the server's 4.
      events: [
        {
          id: "stale-1",
          projectKey: key,
          agentId: "stale-agent-1",
          kind: "test",
          tier: "regression",
          timestamp: now,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 10,
          hasCoverage: true,
          coverageLines: 1,
        },
        {
          id: "stale-2",
          projectKey: key,
          agentId: "stale-agent-2",
          kind: "test",
          tier: "regression",
          timestamp: now + 1000,
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          duration_ms: 10,
          hasCoverage: true,
          coverageLines: 2,
        },
      ],
    });

    const card = trendCard();
    expect(card).not.toBeNull();
    const bars = trendBars(card!);
    expect(bars.length).toBe(4);
    expect(bars.map(barHeight)).toEqual([10, 20, 30, 40]);
    // Bound: neither stale event value appears among the bar heights.
    expect(bars.map(barHeight)).not.toContain(1);
    expect(bars.map(barHeight)).not.toContain(2);
  });

  test("1-point project.coverageTrend renders 1 bar (the points.length >= 2 gate was the defect — no text-only fallback)", async () => {
    const key = "trend-single";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Single Point Trend Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 55, total: 100, percent: 55 } },
          coverageTrend: [55],
        },
      ],
      events: [],
    });

    const card = trendCard();
    expect(card).not.toBeNull();

    // The real RED signal: today's card renders NO bars container at all
    // below 2 points (points.length >= 2 gate) — this must now exist.
    const barsContainer = card!.querySelector('[data-testid="coverage-trend-bars"]');
    expect(barsContainer).not.toBeNull();

    const bars = trendBars(card!);
    expect(bars.length).toBe(1);
    expect(barHeight(bars[0]!)).toBe(55);
    // Sole bar is simultaneously first and latest.
    expect(bars[0]!.className).toMatch(/\bapp-trend-bar-latest\b/);

    expect(card!.textContent ?? "").toContain("COVERAGE TREND (green regressions)");
  });

  test("empty project.coverageTrend: no bars container renders, but the existing latest-coverage caption text remains (graceful regression guard)", async () => {
    const key = "trend-empty";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [
        {
          key,
          name: "Empty Trend Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          latestGreenCoverage: { lines: { covered: 931, total: 1000, percent: 93.1 } },
          // coverageTrend intentionally absent — mirrors the server
          // contract pinned in describe block (A) above (absent, not []).
        },
      ],
      events: [],
    });

    const card = trendCard();
    expect(card).not.toBeNull();

    const barsContainer = card!.querySelector('[data-testid="coverage-trend-bars"]');
    expect(barsContainer).toBeNull();
    expect(trendBars(card!).length).toBe(0);

    expect(card!.textContent ?? "").toContain("COVERAGE TREND (green regressions)");
    expect(card!.textContent ?? "").toContain("latest green coverage 93.1%");
  });
});
