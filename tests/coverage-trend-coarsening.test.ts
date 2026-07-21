// CR-CRU-028 §S1 — auto-coarsening level-colored coverage-trend bucket bars.
// Pure client transform of CR-CRU-033's date-keyed `{day, percent}[]` series
// into ≤16 bucket bars (DN-crucible-coverage-trend.md §3.1-§3.2, locked
// 2026-07-17, F8 mock lines 535-541). This file tests the PURE logic in
// public/app-logic.mjs — no DOM, no app.js — the render-level assertions
// (level color classes, per-level width classes, latest composition, ≤16
// bars end-to-end) live in tests/coverage-trend-geometry.test.ts, reusing
// its existing happy-dom mountApp harness.
//
// CONCRETE BOUNDARY SCHEME PINNED HERE (RED agent's documented choice — GREEN
// must implement exactly this; no other scheme satisfies these assertions):
//
//   Let `latestDay` = the MAX `day` across the input series (the series'
//   own most-recent point — NOT wall-clock "today", so the transform stays
//   pure and deterministic under test).
//   For each point, `daysAgo` = whole days between its `day` and `latestDay`.
//
//     daysAgo <  7                     -> DAY bucket   (bucketKey = the exact
//                                          "YYYY-MM-DD" day string; one
//                                          bucket per calendar day)
//     7 <= daysAgo < 63 (= 7 + 8*7)     -> WEEK bucket  (bucketKey =
//                                          `week-${floor((daysAgo-7)/7)}`,
//                                          i.e. 8 rolling 7-day buckets
//                                          immediately preceding the day
//                                          window)
//     daysAgo >= 63                    -> MONTH bucket (bucketKey =
//                                          `month-${day.slice(0,7)}`, i.e.
//                                          calendar YYYY-MM)
//
//   Bucket VALUE rule (pinned per dispatch's "choose and document" option):
//   a bucket's representative `percent`/`day` are those of the point with
//   the SMALLEST daysAgo inside the bucket (i.e. the LAST/most-recent day's
//   percent within that bucket) — never the first point, never an average.
//
//   Buckets are ordered oldest -> newest by their representative day, then
//   CAPPED to the most recent 16 (drop the oldest buckets first when the
//   raw grouping produces more than 16). `isLatest` is true for exactly the
//   final (most recent) bucket in the capped, ordered output.
import { describe, test, expect } from "bun:test";
import {
  COVERAGE_LEVEL_ORANGE_MAX,
  COVERAGE_LEVEL_YELLOW_MAX,
  coverageLevelClass,
  coarsenCoverageTrend,
} from "../public/app-logic.mjs";

/** Builds the "YYYY-MM-DD" day string `daysAgo` whole days before `latestISO`. */
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

/** The bucket shape `coarsenCoverageTrend` must return (pinned by this
 * file's assertions) — declared locally since public/app-logic.mjs has no
 * .d.ts of its own; typed here purely so tsc can check the test bodies
 * (`coarsenCoverageTrend` itself is untyped/`any` until GREEN adds the real
 * export, which is the expected RED signal). */
interface CoarsenedBucket {
  level: "day" | "week" | "month";
  bucketKey: string;
  day: string;
  percent: number;
  isLatest: boolean;
}

/** Typed call-site wrapper — casts the (currently unresolved / `any`)
 * import to the pinned CoarsenedBucket[] shape so callback parameters below
 * type-check under `noImplicitAny` without weakening the runtime RED
 * signal (the cast is compile-time only). */
function coarsen(points: { day: string; percent: number }[]): CoarsenedBucket[] {
  return coarsenCoverageTrend(points) as CoarsenedBucket[];
}

const LATEST = "2026-06-01";

// ── Named constants — the exact ramp thresholds pinned by the CR ──

describe("COVERAGE_LEVEL_ORANGE_MAX / COVERAGE_LEVEL_YELLOW_MAX — named constants (CR-CRU-028 §S1)", () => {
  test("COVERAGE_LEVEL_ORANGE_MAX is exactly 65", () => {
    expect(COVERAGE_LEVEL_ORANGE_MAX).toBe(65);
  });

  test("COVERAGE_LEVEL_YELLOW_MAX is exactly 80", () => {
    expect(COVERAGE_LEVEL_YELLOW_MAX).toBe(80);
  });
});

// ── coverageLevelClass — orange <65 · yellow [65,80) · green >=80 ──

describe("coverageLevelClass — orange/yellow/green ramp, boundary-pinned (DN §3.2)", () => {
  test("64 (just under COVERAGE_LEVEL_ORANGE_MAX) classifies orange", () => {
    expect(coverageLevelClass(64)).toBe("orange");
  });

  test("65 (== COVERAGE_LEVEL_ORANGE_MAX) classifies yellow, NOT orange", () => {
    expect(coverageLevelClass(65)).toBe("yellow");
    expect(coverageLevelClass(65)).not.toBe("orange");
  });

  test("79 (just under COVERAGE_LEVEL_YELLOW_MAX) classifies yellow, NOT green", () => {
    expect(coverageLevelClass(79)).toBe("yellow");
    expect(coverageLevelClass(79)).not.toBe("green");
  });

  test("80 (== COVERAGE_LEVEL_YELLOW_MAX) classifies green, NOT yellow", () => {
    expect(coverageLevelClass(80)).toBe("green");
    expect(coverageLevelClass(80)).not.toBe("yellow");
  });

  test("0 classifies orange; 100 classifies green (range extremes)", () => {
    expect(coverageLevelClass(0)).toBe("orange");
    expect(coverageLevelClass(100)).toBe("green");
  });
});

// ── coarsenCoverageTrend — day/week/month boundary classification ──

describe("coarsenCoverageTrend — day/week/month boundary classification (daysAgo relative to the series' own latest point)", () => {
  test("daysAgo=6 is still a DAY bucket; daysAgo=7 is a WEEK bucket (the 7-day day/week boundary)", () => {
    const points = [pointAt(LATEST, 0, 100), pointAt(LATEST, 6, 50), pointAt(LATEST, 7, 40)];
    const buckets = coarsen(points);
    expect(buckets.length).toBe(3);
    const byDaysAgo6 = buckets.find((b) => b.percent === 50);
    const byDaysAgo7 = buckets.find((b) => b.percent === 40);
    expect(byDaysAgo6).toBeDefined();
    expect(byDaysAgo7).toBeDefined();
    expect(byDaysAgo6!.level).toBe("day");
    expect(byDaysAgo7!.level).toBe("week");
  });

  test("daysAgo=62 is still a WEEK bucket; daysAgo=63 is a MONTH bucket (the 63-day week/month boundary)", () => {
    const points = [pointAt(LATEST, 0, 100), pointAt(LATEST, 62, 30), pointAt(LATEST, 63, 20)];
    const buckets = coarsen(points);
    expect(buckets.length).toBe(3);
    const byDaysAgo62 = buckets.find((b) => b.percent === 30);
    const byDaysAgo63 = buckets.find((b) => b.percent === 20);
    expect(byDaysAgo62).toBeDefined();
    expect(byDaysAgo63).toBeDefined();
    expect(byDaysAgo62!.level).toBe("week");
    expect(byDaysAgo63!.level).toBe("month");
  });

  test("the single latest point (daysAgo=0) is always a DAY bucket and carries isLatest=true", () => {
    const points = [pointAt(LATEST, 20, 40), pointAt(LATEST, 0, 90)];
    const buckets = coarsen(points);
    const latest = buckets[buckets.length - 1]!;
    expect(latest.level).toBe("day");
    expect(latest.percent).toBe(90);
    expect(latest.isLatest).toBe(true);
    // Negative bound: no other bucket is latest.
    for (const b of buckets.slice(0, -1)) expect(b.isLatest).toBe(false);
  });
});

// ── Bucket VALUE rule — last (most-recent) point in the group wins ──

describe("coarsenCoverageTrend — bucket value = the LAST (most-recent) day's percent within the bucket, never the first and never an average", () => {
  test("two points in the SAME week bucket: the more-recent point's percent wins, not the older one, not their average", () => {
    // daysAgo 8 and 10 both fall in weekIndex 0 ([7,13]) — same bucket.
    const points = [
      pointAt(LATEST, 0, 99), // keeps this a distinct, unambiguous "latest" point
      pointAt(LATEST, 10, 11), // older within the week bucket
      pointAt(LATEST, 8, 22), // more recent within the week bucket
    ];
    const buckets = coarsen(points);
    const weekBuckets = buckets.filter((b) => b.level === "week");
    expect(weekBuckets.length).toBe(1);
    expect(weekBuckets[0]!.percent).toBe(22);
    // Bound: neither the older value nor the average ever appears.
    expect(weekBuckets[0]!.percent).not.toBe(11);
    expect(weekBuckets[0]!.percent).not.toBe(16.5);
    expect(weekBuckets[0]!.day).toBe(dayAt(LATEST, 8));
  });

  test("two points in the SAME month bucket: the more-recent point's percent wins", () => {
    // daysAgo 70 and 90 both land within calendar month "2026-03" relative
    // to LATEST=2026-06-01 (2026-06-01 - 70d = 2026-03-23; -90d = 2026-03-03).
    const points = [pointAt(LATEST, 0, 99), pointAt(LATEST, 90, 5), pointAt(LATEST, 70, 9)];
    const buckets = coarsen(points);
    const monthBuckets = buckets.filter((b) => b.level === "month");
    expect(monthBuckets.length).toBe(1);
    expect(monthBuckets[0]!.percent).toBe(9);
    expect(monthBuckets[0]!.percent).not.toBe(5);
    expect(monthBuckets[0]!.percent).not.toBe(7);
    expect(monthBuckets[0]!.day).toBe(dayAt(LATEST, 70));
  });
});

// ── Full 3-month fixture — the §S1 AC's exact bucketing composition ──

describe("coarsenCoverageTrend — a series spanning 3 months renders month bars (old range) + week bars (mid range) + day bars (recent), <=16 total, oldest -> newest (CR-CRU-028 §S1 AC)", () => {
  test("90 consecutive daily points (daysAgo 0..89 relative to the latest point) coarsen to exactly 16 buckets: 1 month + 8 week + 7 day, in that oldest->newest order, each valued by its bucket's most-recent point", () => {
    // percent(i) = i (0..89) so each bucket's expected representative value
    // is exactly and unambiguously derivable (the point with the SMALLEST
    // daysAgo — i.e. LARGEST i — inside each bucketKey group).
    const points = Array.from({ length: 90 }, (_, i) => pointAt(LATEST, 89 - i, i));
    const buckets = coarsen(points);

    expect(buckets.length).toBe(16);
    expect(buckets.map((b) => b.level)).toEqual([
      "month",
      "week",
      "week",
      "week",
      "week",
      "week",
      "week",
      "week",
      "week",
      "day",
      "day",
      "day",
      "day",
      "day",
      "day",
      "day",
    ]);
    // Positive: exact representative values, oldest -> newest.
    expect(buckets.map((b) => b.percent)).toEqual([
      26, 33, 40, 47, 54, 61, 68, 75, 82, 83, 84, 85, 86, 87, 88, 89,
    ]);
    // isLatest is true for exactly the final bucket (percent 89, daysAgo=0).
    expect(buckets.map((b) => b.isLatest)).toEqual([
      false, false, false, false, false, false, false, false,
      false, false, false, false, false, false, false, true,
    ]);
    expect(buckets[buckets.length - 1]!.day).toBe(LATEST);
    // No coverage-transform detail leaks a percent outside the pinned set —
    // e.g. the raw (un-bucketed) value 0 (the oldest raw point) never
    // appears, proving buckets are truly aggregated, not a raw slice.
    expect(buckets.map((b) => b.percent)).not.toContain(0);
  });

  test("a series long enough to raw-group into MORE than 16 buckets (spanning 3 calendar months in its month range) is CAPPED to the most recent 16, dropping the OLDEST buckets first", () => {
    // 150 points -> 7 day + 8 week + 3 month buckets (Jan/Feb/Mar) = 18 raw
    // buckets, exceeding 16; the two oldest (Jan, Feb) must be dropped.
    const points = Array.from({ length: 150 }, (_, i) => pointAt(LATEST, 149 - i, i));
    const buckets = coarsen(points);

    expect(buckets.length).toBe(16);
    expect(buckets.map((b) => b.level)).toEqual([
      "month",
      "week", "week", "week", "week", "week", "week", "week", "week",
      "day", "day", "day", "day", "day", "day", "day",
    ]);
    // The surviving month bucket is the NEWEST of the 3 raw month buckets
    // (March, 2026-03) — January and February must have been dropped by
    // the cap, not silently merged or kept.
    expect(buckets[0]!.day.startsWith("2026-03")).toBe(true);
    expect(buckets.some((b) => b.day.startsWith("2026-01"))).toBe(false);
    expect(buckets.some((b) => b.day.startsWith("2026-02"))).toBe(false);
  });
});

// ── Composition — coarsening + level classification together, all-green case ──

describe("coarsenCoverageTrend + coverageLevelClass composed — a monotone-high series renders every bucket green (the user's screenshot case, DN §3.2)", () => {
  test("30 consecutive daily points all valued 90 (>= COVERAGE_LEVEL_YELLOW_MAX) coarsen to buckets that ALL classify green, none orange/yellow", () => {
    const points = Array.from({ length: 30 }, (_, i) => pointAt(LATEST, 29 - i, 90));
    const buckets = coarsen(points);
    expect(buckets.length).toBeGreaterThan(0);
    const levels = buckets.map((b) => coverageLevelClass(b.percent));
    expect(levels.every((l) => l === "green")).toBe(true);
    expect(levels).not.toContain("orange");
    expect(levels).not.toContain("yellow");
  });
});
