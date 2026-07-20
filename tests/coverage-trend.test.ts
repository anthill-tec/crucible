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
// Shape decision (RED finding, recorded per dispatch instruction): originally
// plain `coverageTrend: number[]` — the green-regression coverage LINES
// percent per surviving rollup bucket, oldest→newest, present only when >=1
// rollup carries `lastCoverage` (key ABSENT — not null/empty — otherwise,
// mirroring the existing `latestCoverageEventId` absent-not-null convention
// pinned in tests/coverage-click.test.ts).
//
// SUPERSEDED by CR-CRU-033 §S2 (DN-crucible-coverage-trend.md §6): §S1 made
// rollup buckets UTC-day-keyed (dropping the `context.wave ??` prefix), so a
// per-point date IS now available. `coverageTrend` becomes a date-keyed
// series `{ day: string, percent: number }[]` (`day` = "YYYY-MM-DD"),
// oldest→newest, built by MERGING per UTC day: old day-rollups whose
// `lastCoverage` is set, PLUS within-retention coverage-bearing events
// grouped by their UTC day (last-of-day wins). A day in both halves yields
// ONE point (live/last-of-day wins over the rollup's older value). Legacy
// wave-keyed rollup buckets (non-`YYYY-MM-DD` bucket strings) contribute
// nothing. Absent-not-null convention is unchanged.
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
  // CR-CRU-033 §S2 — coverageTrend is now a date-keyed series, not a flat
  // number[]: { day: "YYYY-MM-DD", percent } per point, oldest→newest,
  // merged from durable day-rollups (old days) + within-retention
  // coverage-bearing events (recent days, last-of-day wins on overlap).
  coverageTrend?: { day: string; percent: number }[];
  [key: string]: unknown;
}

interface ProjectsListResponse {
  ok: true;
  projects: ProjectPayload[];
}

interface QueryHandle {
  run(...args: unknown[]): void;
}
interface RawDb {
  query(sql: string): QueryHandle;
}

/**
 * CR-CRU-033 §S2 legacy-exclusion AC — seed a pre-§S1-style wave-keyed
 * rollup bucket directly. §S1 (already committed) made `foldIntoRollup`
 * bucket EVERY fold by UTC day, so a wave-keyed bucket can no longer be
 * produced through the public Store API — the only way left to exercise the
 * "legacy bucket contributes nothing" AC is to reach past `Store`'s
 * `private readonly db` (TypeScript `private` is compile-time only) and
 * insert the row directly, same technique as
 * tests/v2-projects-activity.test.ts's backdateEventTimestamp.
 */
function seedLegacyWaveRollup(store: Store, projectKey: string, bucket: string, percent: number): void {
  (store as unknown as { db: RawDb }).db
    .query(
      `INSERT INTO rollups (project_key, bucket, runs, passed, failed, duration_ms, last_coverage)
       VALUES (?, ?, 1, 1, 0, 10, ?)`,
    )
    .run(
      projectKey,
      bucket,
      JSON.stringify({ lines: { total: 100, covered: percent, percent } }),
    );
}

describe("GET /api/v2/projects — coverageTrend (date-keyed {day,percent}[] series, CR-CRU-033 §S2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    // Safety net: reset any clock injected by the §S1 distinct-UTC-day test
    // below even if it threw before reaching its own inline reset.
    setSystemTime();
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
    // Distinct buckets (distinct UTC days) so each fold lands in its OWN
    // rollup row — rollups are keyed (project_key, bucket), so same-bucket
    // folds would collapse to a single lastCoverage, not 4 points.
    //
    // CR-CRU-033 §S1: the bucket key is always the event's UTC day, so DAY
    // (not wave id) is what must differentiate these 4 folds now — stamped
    // via setSystemTime(), the same clock-injection technique the §S1
    // Store#foldIntoRollup test above uses. Every event below shares the
    // SAME wave id ("trend-4") deliberately: that proves the wave tag no
    // longer splits the bucket (§S1 drops `context.wave ??` from the fold
    // key). Pre-§S1 this is exactly the failure this test is meant to
    // catch — a shared wave id still collapses all 4 folds into ONE
    // wave-keyed rollup (a count mismatch: listRollups(key).length === 1,
    // not 4), which is why this test currently fails RED against the
    // wave-keyed production code. Once §S1 lands, the wave id is ignored
    // and the 4 distinct UTC days correctly yield 4 points.
    const days = ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"];
    for (let i = 0; i < percents.length; i++) {
      setSystemTime(new Date(`${days[i]}T12:00:00.000Z`));
      store.recordTestEvent(
        key,
        `agent-trend-${i}`,
        {
          summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 50 },
          tree: [],
          coverage: { lines: { total: 100, covered: percents[i]!, percent: percents[i]! } },
        },
        { tier: "regression", context: { wave: "trend-4" } },
      );
    }
    setSystemTime(); // reset the injected clock so it never leaks to other tests

    // Sanity: retention: 0 really did prune every raw event away.
    expect(store.listEvents(key, 1000).length).toBe(0);
    expect(store.listRollups(key).length).toBe(4);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    // §S2 shape + order AC: {day, percent}[], day = YYYY-MM-DD, oldest→newest.
    const expectedPoints = days.map((day, i) => ({ day, percent: percents[i]! }));
    expect(project!.coverageTrend).toEqual(expectedPoints);
    for (const point of project!.coverageTrend ?? []) {
      expect(point.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const returnedDays = (project!.coverageTrend ?? []).map((p) => p.day);
    expect(returnedDays).toEqual([...returnedDays].sort());
  });

  test("1 coverage-bearing green-regression run, pruned past retention: coverageTrend returns exactly 1 point keyed to its UTC day", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "trend-1", type: "backend", sutRoot: "/tmp/trend-1", retention: 0 });

    setSystemTime(new Date("2026-07-05T10:00:00.000Z"));
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
    setSystemTime();

    expect(store.listEvents(key, 1000).length).toBe(0);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.coverageTrend).toEqual([{ day: "2026-07-05", percent: 55 }]);
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

  test("§S2 merge: 2 pruned day-rollups (07-15=90, 07-16=91) + within-retention live events (07-17=93, 07-18=94) yield exactly 4 points, oldest→newest", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    // retention: 2 keeps at most 2 raw events; inserting a 3rd/4th event
    // overflows and prunes the OLDEST raw row into a rollup each time — so
    // after 4 sequential inserts on 4 distinct UTC days, days 1-2 (07-15,
    // 07-16) are folded/pruned rollups and days 3-4 (07-17, 07-18) remain
    // live raw events, exactly matching the CR-CRU-033 §S2 merge AC fixture.
    store.addProject({ key, name: "trend-merge", type: "backend", sutRoot: "/tmp/trend-merge", retention: 2 });

    const fixture: { day: string; percent: number }[] = [
      { day: "2026-07-15", percent: 90 },
      { day: "2026-07-16", percent: 91 },
      { day: "2026-07-17", percent: 93 },
      { day: "2026-07-18", percent: 94 },
    ];
    for (let i = 0; i < fixture.length; i++) {
      setSystemTime(new Date(`${fixture[i]!.day}T12:00:00.000Z`));
      store.recordTestEvent(
        key,
        `agent-merge-${i}`,
        {
          summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 50 },
          tree: [],
          coverage: { lines: { total: 100, covered: fixture[i]!.percent, percent: fixture[i]!.percent } },
        },
        { tier: "regression" },
      );
    }
    setSystemTime();

    // Sanity on the fixture setup itself: exactly 2 pruned rollups (the old
    // half) and exactly 2 live raw events (the recent half) survive.
    expect(store.listRollups(key).length).toBe(2);
    expect(store.listEvents(key, 1000).length).toBe(2);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.coverageTrend).toEqual(fixture);
  });

  test("§S2 same-day dedup: a day with BOTH a pruned rollup (percent 80) AND a within-retention live event (percent 88) yields ONE point with the live value winning", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    // retention: 1 keeps at most 1 raw event: each new insert immediately
    // prunes the previous one into the rollup. All 3 events below share the
    // SAME UTC day, so: event1 (70) folds first, then event2 (80) folds
    // into the SAME rollup bucket (COALESCE keeps the newest lastCoverage,
    // 80) and is deleted, leaving event3 (88) as the sole live raw row for
    // that day — a pruned rollup (80) coexisting with a live event (88) on
    // the exact same UTC day.
    store.addProject({ key, name: "trend-dedup", type: "backend", sutRoot: "/tmp/trend-dedup", retention: 1 });

    setSystemTime(new Date("2026-07-20T06:00:00.000Z"));
    store.recordTestEvent(
      key,
      "agent-dedup-1",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 50 },
        tree: [],
        coverage: { lines: { total: 100, covered: 70, percent: 70 } },
      },
      { tier: "regression" },
    );
    setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    store.recordTestEvent(
      key,
      "agent-dedup-2",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 50 },
        tree: [],
        coverage: { lines: { total: 100, covered: 80, percent: 80 } },
      },
      { tier: "regression" },
    );
    setSystemTime(new Date("2026-07-20T18:00:00.000Z"));
    store.recordTestEvent(
      key,
      "agent-dedup-3",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 50 },
        tree: [],
        coverage: { lines: { total: 100, covered: 88, percent: 88 } },
      },
      { tier: "regression" },
    );
    setSystemTime();

    // Sanity: exactly 1 rollup bucket for the day (lastCoverage 80, from the
    // fold of event2) and exactly 1 live raw event left (event3, 88).
    const rollups = store.listRollups(key);
    expect(rollups.length).toBe(1);
    expect(rollups[0]!.bucket).toBe("2026-07-20");
    expect(rollups[0]!.lastCoverage?.lines.percent).toBe(80);
    expect(store.listEvents(key, 1000).length).toBe(1);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    // Exactly ONE point for 2026-07-20, live value (88) wins over the
    // rollup's older value (80) — never both, never the stale 80.
    expect(project!.coverageTrend).toEqual([{ day: "2026-07-20", percent: 88 }]);
  });

  test("§S2 legacy exclusion: a wave-keyed rollup bucket (\"4\", non-date string) contributes NO point alongside a valid dated point", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "trend-legacy", type: "backend", sutRoot: "/tmp/trend-legacy", retention: 0 });

    // A legacy pre-§S1 wave-keyed rollup bucket. §S1 (already committed)
    // means the public Store API can no longer PRODUCE one — this seeds a
    // row directly to prove the merge still EXCLUDES any bucket that isn't
    // a "YYYY-MM-DD" string, per the §S2 legacy-exclusion AC.
    seedLegacyWaveRollup(store, key, "4", 99);

    setSystemTime(new Date("2026-07-19T09:00:00.000Z"));
    store.recordTestEvent(
      key,
      "agent-legacy-valid",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 50 },
        tree: [],
        coverage: { lines: { total: 100, covered: 85, percent: 85 } },
      },
      { tier: "regression" },
    );
    setSystemTime();

    // Sanity: the rollups table really does contain both the legacy
    // wave-keyed bucket AND the properly-folded date bucket.
    const rollups = store.listRollups(key);
    expect(rollups.length).toBe(2);
    expect(rollups.some((r) => r.bucket === "4")).toBe(true);
    expect(rollups.some((r) => r.bucket === "2026-07-19")).toBe(true);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    // Positive: only the dated bucket contributes.
    expect(project!.coverageTrend).toEqual([{ day: "2026-07-19", percent: 85 }]);
    // Negative/bound: no point carries the legacy bucket's percent (99) or
    // a "day" of "4".
    expect((project!.coverageTrend ?? []).some((p) => p.percent === 99)).toBe(false);
    expect((project!.coverageTrend ?? []).some((p) => p.day === "4")).toBe(false);
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
  /** CR-CRU-033 §S2 — the durable, date-keyed trend series (see (A) above):
   * { day: "YYYY-MM-DD", percent }[], oldest→newest. */
  coverageTrend?: { day: string; percent: number }[];
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
          coverageTrend: [
            { day: "2026-01-01", percent: 61 },
            { day: "2026-01-02", percent: 74 },
            { day: "2026-01-03", percent: 88 },
            { day: "2026-01-04", percent: 95 },
          ],
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
          coverageTrend: [
            { day: "2026-01-01", percent: 10 },
            { day: "2026-01-02", percent: 20 },
            { day: "2026-01-03", percent: 30 },
            { day: "2026-01-04", percent: 40 },
          ],
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
          coverageTrend: [{ day: "2026-01-01", percent: 55 }],
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
