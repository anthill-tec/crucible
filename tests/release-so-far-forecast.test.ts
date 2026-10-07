// CR-CRU-161 §S2 — forecast (release-scoped, daily Monte Carlo):
// `forecast()` in src/analytics.ts.
//
// Spec: docs/changes/CR-CRU-161-velocity-and-the-forecast-follow-the-release-so-far.md
// §S2/AC2. Design: docs/research/DN-crucible-analytics.md §7 (amended
// 2026-10-07).
//
// `ForecastInput` already carries `release` (it was release-scoped before
// this CR too, for `remainingPoints`) — this file calls `forecast()`
// unmodified, through its real exported type. What changes is what feeds
// the Monte Carlo: today, `weeklyVelocity()` builds `history` from EVERY
// pointed merge in the entries/plans arrays passed in, PROJECT-WIDE,
// ignoring `input.release` entirely (the CR's own Problem section: "The
// forecast samples the project's history... not the release's own pace"),
// and gates on "< 3 completed ISO calendar weeks". After this CR, history
// must be the FOCUSED RELEASE's own daily throughput since it started
// (zero days real), gated on "no pointed CR of the release has merged yet".
// Every fixture below is built so the two models give DIFFERENT answers —
// confirmed by hand below — so a RED run here can only be passing by
// accident if the current code happens to compute the release's own
// answer anyway, which it demonstrably does not (see each test's own
// comment for why the old model disagrees).
//
// `sampleDays` (replacing `sampleWeeks`) is read through a local output
// interface — the production `ForecastPayload` doesn't carry it yet.
//
// Pure-function tests over fixed fixtures, a fixed `now` and a fixed seed
// (`seededRandom`, already exported, unchanged by this CR) — no server, no
// store.
import { describe, test, expect } from "bun:test";
import { forecast, seededRandom, type ForecastInput } from "../src/analytics.ts";
import type { Plan, QueueEntry } from "../src/types.ts";

const DAY_MS = 86_400_000;

interface ReleaseForecastPayload {
  release: string;
  remainingPoints: number;
  p50Ts?: number;
  p80Ts?: number;
  scheduleHealth?: string;
  sampleDays?: number;
  status: string;
  unpointed?: string[];
  [key: string]: unknown;
}

function callForecast(input: ForecastInput): ReleaseForecastPayload {
  return forecast(input) as unknown as ReleaseForecastPayload;
}

let seq = 0;
function entry(cr: string, release: string, points?: number): QueueEntry {
  seq += 1;
  return {
    cr,
    wave: "1",
    dependsOn: [],
    status: points !== undefined ? "COMPLETED" : "PENDING",
    seq,
    release,
    ...(points !== undefined ? { points } : {}),
  };
}

let planId = 0;
function mergedPlan(cr: string, closedAt: number): Plan {
  planId += 1;
  return {
    planId,
    projectKey: "proj",
    cr,
    status: "closed",
    cycles: [],
    merge: { commit: `${cr.toLowerCase()}c0de` },
    closedAt,
  };
}

describe("CR-CRU-161 §S2 — forecast: the release's daily pace, so far", () => {
  test('a release with no pointed CR merged yet refuses with "insufficient_history", even while ANOTHER release has plenty of merged history (the project-wide leak this CR removes)', () => {
    // Release 9.4.0 (under test): CR-A is pointed and still unmerged — no
    // pointed CR of 9.4.0 has EVER merged.
    const RELEASE = "9.4.0";
    const start = Date.parse("2026-09-01T09:00:00.000Z");
    const now = Date.parse("2026-09-03T12:00:00.000Z");

    // Release 9.9.0 (noise): three pointed merges across three DISTINCT,
    // already-completed ISO weeks (2026-08-05/12/19, all well before the
    // "now" below) — under the OLD project-wide weekly model this alone
    // satisfies "3 completed weeks of history" and the old code would
    // answer "ok" for ANY release query, because `weeklyVelocity()` never
    // filters by `release`. The new model must ignore it completely:
    // 9.4.0's own history is empty, so it must refuse.
    const entries: QueueEntry[] = [
      entry("CR-NOISE-1", "9.9.0", 10),
      entry("CR-NOISE-2", "9.9.0", 10),
      entry("CR-NOISE-3", "9.9.0", 10),
      entry("CR-A", RELEASE, 10),
    ];
    const plans: Plan[] = [
      mergedPlan("CR-NOISE-1", Date.parse("2026-08-05T10:00:00.000Z")),
      mergedPlan("CR-NOISE-2", Date.parse("2026-08-12T10:00:00.000Z")),
      mergedPlan("CR-NOISE-3", Date.parse("2026-08-19T10:00:00.000Z")),
      // CR-A carries no plan at all: still unmerged.
    ];

    const body = callForecast({
      release: RELEASE,
      entries,
      plans,
      // The release's start: CR-A filed at 2026-09-01T09:00Z.
      filedAt: new Map([["CR-A", start]]),
      now,
      random: seededRandom(42),
    });

    expect(body.status).toBe("insufficient_history");
    expect(body.remainingPoints).toBe(10);
    expect(body.p50Ts).toBeUndefined();
    expect(body.p80Ts).toBeUndefined();
    expect(body.scheduleHealth).toBeUndefined();
    // "how many days it rests on" — 2026-09-01..2026-09-03 inclusive.
    expect(body.sampleDays).toBe(3);
    void start; // documents the release's own start; not separately asserted here
  });

  test('status "ok" the instant one pointed CR of the release has merged: a zero-variance 3-day daily history makes P50 === P80 === exactly 4 whole days from today', () => {
    // Release 9.5.0: every day since its start merges EXACTLY 2 points
    // (day 0 — the start day itself — through day 2, "today"), so sampling
    // ANY value from this single-valued distribution returns 2 on every
    // draw, for ANY correct Monte Carlo implementation regardless of its
    // PRNG. remainingPoints (8) is an exact multiple of 2, so completion is
    // EXACTLY "today + 4 days" — algorithm-independent.
    //
    // Under the OLD project-wide weekly model: 2026-09-01/02/03 all fall in
    // the SAME still-open ISO week as "now" (2026-09-03), so
    // `weeklyVelocity` excludes every one of them ("the open week is not
    // completed") and `history` is EMPTY — the old code answers
    // "insufficient_history" here, not "ok". That is the defect this test
    // names.
    const RELEASE = "9.5.0";
    const start = Date.parse("2026-09-01T09:00:00.000Z");
    const now = Date.parse("2026-09-03T12:00:00.000Z");

    const entries: QueueEntry[] = [
      entry("CR-D1", RELEASE, 2),
      entry("CR-D2", RELEASE, 2),
      entry("CR-D3", RELEASE, 2),
      entry("CR-REM", RELEASE, 8), // the release's one remaining CR
    ];
    const plans: Plan[] = [
      mergedPlan("CR-D1", Date.parse("2026-09-01T15:00:00.000Z")), // start day
      mergedPlan("CR-D2", Date.parse("2026-09-02T10:00:00.000Z")),
      mergedPlan("CR-D3", Date.parse("2026-09-03T10:00:00.000Z")), // today
    ];

    const body = callForecast({
      release: RELEASE,
      entries,
      plans,
      // Every 9.5.0 CR filed at the release's start, 2026-09-01T09:00Z.
      filedAt: new Map(entries.map((e) => [e.cr, start])),
      now,
      random: seededRandom(42),
    });

    expect(body.status).toBe("ok");
    expect(body.remainingPoints).toBe(8);
    expect(body.sampleDays).toBe(3);
    const expectedCompletion = now + 4 * DAY_MS;
    expect(body.p50Ts).toBe(expectedCompletion);
    expect(body.p80Ts).toBe(expectedCompletion);
    expect(body.scheduleHealth).toBeUndefined();
    void start;
  });

  test("a fixture with varied daily throughput puts P50 and P80 on different whole days", () => {
    // Release 9.6.0: 3 very-low days (1 pt each) then 1 very-high day (104
    // pts, exactly `remainingPoints`) — a BIMODAL daily history. Each
    // simulated draw-day independently samples one of the 4 historical
    // daily totals with equal probability (p = 0.25 of drawing the high
    // day); the high day alone already meets `remainingPoints`, so a
    // draw's completion day is (to an astronomically negligible tail, see
    // the original week-grained version of this argument in
    // tests/cr022-forecast-analytics.test.ts) a Geometric(p=0.25) random
    // variable: true P50 = 3 days, true P80 = 6 days. For N = 1000 draws
    // this is robust for ANY correct seeded PRNG — no exact date is
    // asserted, only that P50 and P80 land on DIFFERENT whole days.
    //
    // Under the OLD project-wide weekly model, all four merges
    // (2026-09-01..04) fall in the SAME still-open ISO week as "now"
    // (2026-09-04) and are excluded — `history` is empty and the old code
    // answers "insufficient_history", never a dated band at all.
    const RELEASE = "9.6.0";
    const now = Date.parse("2026-09-04T12:00:00.000Z");

    const entries: QueueEntry[] = [
      entry("CR-LOW-1", RELEASE, 1),
      entry("CR-LOW-2", RELEASE, 1),
      entry("CR-LOW-3", RELEASE, 1),
      entry("CR-HIGH", RELEASE, 104),
      entry("CR-REM", RELEASE, 104),
    ];
    const plans: Plan[] = [
      mergedPlan("CR-LOW-1", Date.parse("2026-09-01T10:00:00.000Z")),
      mergedPlan("CR-LOW-2", Date.parse("2026-09-02T10:00:00.000Z")),
      mergedPlan("CR-LOW-3", Date.parse("2026-09-03T10:00:00.000Z")),
      mergedPlan("CR-HIGH", Date.parse("2026-09-04T10:00:00.000Z")),
    ];

    const body = callForecast({
      release: RELEASE,
      entries,
      plans,
      // Every 9.6.0 CR filed at the release's start, 2026-09-01T09:00Z.
      filedAt: new Map(entries.map((e) => [e.cr, Date.parse("2026-09-01T09:00:00.000Z")])),
      now,
      random: seededRandom(42),
    });

    expect(body.status).toBe("ok");
    expect(body.remainingPoints).toBe(104);
    expect(body.sampleDays).toBe(4);
    expect(body.p50Ts).toBeDefined();
    expect(body.p80Ts).toBeDefined();
    // "on whole days" — every completion is `now + k * DAY_MS` for an
    // integer k.
    expect((body.p50Ts! - now) % DAY_MS).toBe(0);
    expect((body.p80Ts! - now) % DAY_MS).toBe(0);
    // Different whole days — at least 24h apart, never collapsed onto one.
    expect(body.p80Ts! - body.p50Ts!).toBeGreaterThanOrEqual(DAY_MS);
  });
});
