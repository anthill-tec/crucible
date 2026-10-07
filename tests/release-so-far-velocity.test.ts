// CR-CRU-161 §S1 — velocity (release-scoped, release-so-far pace):
// `velocity()` in src/analytics.ts.
//
// Spec: docs/changes/CR-CRU-161-velocity-and-the-forecast-follow-the-release-so-far.md
// §S1/AC1. Design: docs/research/DN-crucible-analytics.md §5 (amended
// 2026-10-07).
//
// Baseline (measured at this RED pass): `velocity()`'s own `VelocityInput`
// carries no `release`/`filedAt` field (src/analytics.ts's current
// `VelocityInput` interface) and its payload is still the calendar-week
// shape (`pointsPerWeek`/`weeks`/`sampleWeeks`) — none of `startTs`,
// `pointsPerDay`, `days` or `sampleDays` exist anywhere on it. This file
// calls `velocity()` with the release-so-far shape this CR adds, cast
// through the locally-declared interfaces below (`callVelocity`) so tsc's
// excess-property check does not fire on fields that do not exist until
// GREEN adds them — the defect this proves is BEHAVIOURAL, not a crash:
// the current implementation ignores `release`/`filedAt` entirely and
// answers its old project-wide weekly shape, so every assertion below
// fails on a VALUE (`undefined` where a number/array is expected), never
// on an exception.
//
// Pure-function test over a fixed fixture and a fixed `now` — no server,
// no store: `Plan`/`QueueEntry` fixtures are built directly, exactly
// matching the shapes `src/types.ts` declares.
import { describe, test, expect } from "bun:test";
import { velocity } from "../src/analytics.ts";
import type { Plan, QueueEntry } from "../src/types.ts";

interface ReleaseVelocityInput {
  release: string;
  entries: QueueEntry[];
  plans: Plan[];
  /** Release start = earliest `filed_at` among the release's CRs (§6). */
  filedAt: Map<string, number>;
  execByCycle: Map<number, number>;
  now: number;
}

interface ReleaseVelocityPayload {
  release?: string;
  startTs?: number;
  pointsPerDay?: number;
  days?: Array<{ day: string; points: number }>;
  sampleDays?: number;
  flow?: { execMsPerCycle?: number; gateMsPerCycle?: number; sampleCycles: number };
  [key: string]: unknown;
}

function callVelocity(input: ReleaseVelocityInput): ReleaseVelocityPayload {
  return velocity(input as unknown as Parameters<typeof velocity>[0]) as unknown as ReleaseVelocityPayload;
}

let seq = 0;
function entry(cr: string, release: string, points?: number): QueueEntry {
  seq += 1;
  return {
    cr,
    wave: "1",
    dependsOn: [],
    status: "COMPLETED",
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

describe("CR-CRU-161 §S1 — velocity: the release's pace so far", () => {
  test("pointsPerDay is the release's pointed points merged since its start ÷ the days since, today included; a first-day merge, a merge after idle days and a merge today all land in a zero-filled per-day series; unpointed CRs and another release's merges never count", () => {
    const RELEASE = "9.8.0";
    const start = Date.parse("2026-09-01T09:00:00.000Z");
    const now = Date.parse("2026-09-10T11:30:00.000Z");

    const entries: QueueEntry[] = [
      entry("CR-REL-1", RELEASE, 3),
      entry("CR-REL-2", RELEASE, 5),
      entry("CR-REL-3", RELEASE, 4),
      // Unpointed: merges on 2026-09-07 below, must never add points.
      entry("CR-REL-UNPOINTED", RELEASE),
      // Another release entirely: merges on 2026-09-06 below, must never count.
      entry("CR-OTHER", "9.9.0", 100),
    ];
    const filedAt = new Map<string, number>([
      ["CR-REL-1", start], // the earliest filed_at — the release's start
      ["CR-REL-2", Date.parse("2026-09-01T09:05:00.000Z")],
      ["CR-REL-3", Date.parse("2026-09-01T09:10:00.000Z")],
      ["CR-REL-UNPOINTED", Date.parse("2026-09-01T09:15:00.000Z")],
      ["CR-OTHER", Date.parse("2026-08-01T00:00:00.000Z")],
    ]);
    const plans: Plan[] = [
      mergedPlan("CR-REL-1", Date.parse("2026-09-01T15:00:00.000Z")), // the first day
      mergedPlan("CR-REL-2", Date.parse("2026-09-05T10:00:00.000Z")), // after 3 idle days
      mergedPlan("CR-REL-3", Date.parse("2026-09-10T11:00:00.000Z")), // today
      mergedPlan("CR-REL-UNPOINTED", Date.parse("2026-09-07T10:00:00.000Z")),
      mergedPlan("CR-OTHER", Date.parse("2026-09-06T10:00:00.000Z")),
    ];

    const body = callVelocity({ release: RELEASE, entries, plans, filedAt, execByCycle: new Map(), now });

    expect(body.release).toBe(RELEASE);
    // The release's start: CR-REL-1's filed_at, the earliest among 9.8.0's CRs.
    expect(body.startTs).toBe(start);
    // 2026-09-01 .. 2026-09-10 inclusive = 10 days.
    expect(body.sampleDays).toBe(10);
    // (3 + 5 + 4) pointed points / 10 days.
    expect(body.pointsPerDay).toBe(1.2);
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days!.length).toBe(10);
    // Ascending chronological order, one entry per day since start, EVERY
    // idle day a real zero (never absent) — the first day (3), three idle
    // days, the after-idle merge (5), another release's merge day (0, it
    // must never count), the unpointed merge's day (0, it must never
    // count), two more idle days, then today's merge (4).
    expect(body.days!.map((d) => d.points)).toEqual([3, 0, 0, 0, 5, 0, 0, 0, 0, 4]);
    for (const d of body.days!) {
      expect(typeof d.day).toBe("string");
      expect(d.day.length).toBeGreaterThan(0);
    }
  });
});
