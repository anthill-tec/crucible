// CR-CRU-022 §S2 — velocity: GET …/analytics/velocity.
//
// RE-PINNED for CR-CRU-161 §S1 (2026-10-07 re-specification): velocity is
// now the FOCUSED RELEASE's pace so far — points merged since the
// release's start (its earliest `filed_at`) divided by the days since,
// today included — not the project-wide mean of the last 3 completed ISO
// calendar weeks this file originally pinned. The route now REQUIRES
// `?release=` (400 without it, like `burndown`/`forecast`), and the
// payload's shape changed: `pointsPerWeek`/`weeks`/`sampleWeeks` are gone,
// replaced by `startTs`/`pointsPerDay`/`days`/`sampleDays`. The most
// consequential reversal: gap DAYS are now a real ZERO in `days` (the
// release's daily bars need a bar for every day), where gap WEEKS used to
// be ABSENT from `weeks` — the opposite convention.
//
// Spec: docs/changes/CR-CRU-161-velocity-and-the-forecast-follow-the-release-so-far.md
// §S1/AC1. Design: docs/research/DN-crucible-analytics.md §5 (amended
// 2026-10-07).
//
// Baseline (measured at this RED pass): `handleAnalyticsVelocity` still
// calls `requireHeldProject` only (no `requireReleaseParam`), and
// `velocity()` still answers the calendar-week shape — so `getVelocity`'s
// new `?release=` argument is accepted (ignored) by the current route, and
// every assertion on `startTs`/`pointsPerDay`/`days`/`sampleDays` below
// fails on an `undefined` field, never an exception.
//
// Flow (`exec`/`gate` per cycle) is UNCHANGED by CR-CRU-161 — project-level,
// §5's own words — so this file's flow fixture/assertions (same
// exec 1000ms / loop 3000ms / gate 2000ms shape, the BDD-tier split on
// CR-VEL-4) are KEPT VERBATIM from the original pin.
//
// Every server here is booted on an OS-assigned port against an
// mkdtempSync scratch db. The live data/crucible.db and port 3849 are never
// touched.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { QueuePlanInput } from "../src/store.ts";
import type { RunSchema } from "../src/types.ts";

function testRun(durationMs: number): RunSchema {
  return {
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: durationMs },
    tree: [
      { name: "suite", status: "pass", children: [{ name: "case", status: "pass", duration_ms: durationMs }] },
    ],
  };
}

/** Narrow a store op's `T | { error: string }` union, loudly. */
function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String((result as { error: string }).error)}`);
  return result as Exclude<T, { error: string }>;
}

interface VelocityBody {
  ok?: boolean;
  error?: string;
  release?: string;
  startTs?: number;
  pointsPerDay?: number;
  days?: Array<{ day: string; points: number }>;
  sampleDays?: number;
  flow?: { execMsPerCycle: number; gateMsPerCycle: number; sampleCycles: number };
  [key: string]: unknown;
}

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;

afterEach(() => {
  setSystemTime();
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function boot(): ServerHandle {
  const dir = mkdtempSync(join(tmpdir(), "cru022-vel-"));
  scratchDirs.push(dir);
  handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function getVelocity(key: string, release?: string): Promise<{ status: number; body: VelocityBody }> {
  const qs = release !== undefined ? `?release=${encodeURIComponent(release)}` : "";
  const res = await fetch(`${base()}/api/v2/projects/${key}/analytics/velocity${qs}`);
  let body: VelocityBody = {};
  try {
    body = (await res.json()) as VelocityBody;
  } catch {
    // A 404/plain-text fallthrough for the not-yet-existing route has no
    // JSON body; the empty object above is the RED-safe default so the
    // assertions below fail on the FIELDS, not on a JSON.parse throw.
  }
  return { status: res.status, body };
}

interface MergeFixture {
  cr: string;
  points: number;
  filedAt: string;
  activatedAt: string;
  eventAt: string;
  doneAt: string;
  mergedAt: string;
  splitBdd?: boolean;
}

function mergeCr(key: string, fx: MergeFixture): void {
  const store = handle!.store;
  setSystemTime(new Date(fx.filedAt));
  const input: QueuePlanInput & { points?: number } = {
    cr: fx.cr,
    release: "9.5.0",
    wave: "1",
    title: fx.cr,
    points: fx.points,
  };
  store.upsertQueueEntry(key, input);
  const plan = planned(store.filePlan(key, { cr: fx.cr, cycles: [{ label: "c1", kind: "red-green" }] }));
  const cycleId = plan.cycles[0]!.id;

  setSystemTime(new Date(fx.activatedAt));
  planned(store.transitionCycle(key, plan.planId, cycleId, "active"));

  setSystemTime(new Date(fx.eventAt));
  if (fx.splitBdd === true) {
    store.recordTestEvent(key, "fixture-agent", testRun(500), { tier: "unit", context: { cycleId } });
    store.recordTestEvent(key, "fixture-agent", testRun(500), { tier: "bdd", context: { cycleId } });
  } else {
    store.recordTestEvent(key, "fixture-agent", testRun(1000), { tier: "unit", context: { cycleId } });
  }

  setSystemTime(new Date(fx.doneAt));
  planned(store.transitionCycle(key, plan.planId, cycleId, "done"));

  setSystemTime(new Date(fx.mergedAt));
  planned(store.closePlan(key, plan.planId, { commit: `${fx.cr.toLowerCase()}c0de` }));
}

describe("CR-CRU-022 §S2 — velocity: GET …/analytics/velocity", () => {
  test("pointsPerDay is the release's pointed points merged since its start ÷ the days since, today included; days is a ZERO-FILLED per-day series (the idle gap between CR-VEL-1 and CR-VEL-2 reads 0, never absent); a BDD-tier run counts toward exec time", async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000a01";
    handle!.store.addProject({ key, name: "vel", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    // CR-VEL-1 — Wed 2026-08-05: merges THREE WEEKS after 9.5.0's own start
    // (its own filed_at, 2026-08-01, is the EARLIEST among 9.5.0's CRs — so
    // it sets the release's start even though it merges four days later).
    mergeCr(key, {
      cr: "CR-VEL-1",
      points: 3,
      filedAt: "2026-08-01T09:00:00.000Z",
      activatedAt: "2026-08-05T09:00:00.000Z",
      eventAt: "2026-08-05T09:00:01.000Z",
      doneAt: "2026-08-05T09:00:03.000Z",
      mergedAt: "2026-08-05T10:00:00.000Z",
    });
    // CR-VEL-2 — Wed 2026-08-19, after a 2-week idle gap with no merges at all.
    mergeCr(key, {
      cr: "CR-VEL-2",
      points: 5,
      filedAt: "2026-08-15T09:00:00.000Z",
      activatedAt: "2026-08-19T09:00:00.000Z",
      eventAt: "2026-08-19T09:00:01.000Z",
      doneAt: "2026-08-19T09:00:03.000Z",
      mergedAt: "2026-08-19T10:00:00.000Z",
    });
    // CR-VEL-3 — Wed 2026-08-26
    mergeCr(key, {
      cr: "CR-VEL-3",
      points: 8,
      filedAt: "2026-08-22T09:00:00.000Z",
      activatedAt: "2026-08-26T09:00:00.000Z",
      eventAt: "2026-08-26T09:00:01.000Z",
      doneAt: "2026-08-26T09:00:03.000Z",
      mergedAt: "2026-08-26T10:00:00.000Z",
    });
    // CR-VEL-4 — Wed 2026-09-02, the split unit+bdd run
    mergeCr(key, {
      cr: "CR-VEL-4",
      points: 2,
      filedAt: "2026-08-29T09:00:00.000Z",
      activatedAt: "2026-09-02T09:00:00.000Z",
      eventAt: "2026-09-02T09:00:01.000Z",
      doneAt: "2026-09-02T09:00:03.000Z",
      mergedAt: "2026-09-02T10:00:00.000Z",
      splitBdd: true,
    });

    // "today" — Wed 2026-09-09.
    setSystemTime(new Date("2026-09-09T12:00:00.000Z"));

    const { status, body } = await getVelocity(key, "9.5.0");
    expect(status).toBe(200);
    expect(body.ok).not.toBe(false);

    // §S1/AC1 — the release's start is CR-VEL-1's own filed_at, the
    // earliest among 9.5.0's CRs.
    expect(body.release).toBe("9.5.0");
    expect(body.startTs).toBe(Date.parse("2026-08-01T09:00:00.000Z"));
    // 2026-08-01 .. 2026-09-09 inclusive = 40 days (31 in August + 9 in September).
    expect(body.sampleDays).toBe(40);
    // (3 + 5 + 8 + 2) pointed points / 40 days.
    expect(body.pointsPerDay).toBe(0.45);

    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days!.length).toBe(40);
    const expectedDays = new Array(40).fill(0) as number[];
    expectedDays[4] = 3; // 2026-08-05 — CR-VEL-1
    expectedDays[18] = 5; // 2026-08-19 — CR-VEL-2 (the idle gap at indices 5-17 stays 0, never absent)
    expectedDays[25] = 8; // 2026-08-26 — CR-VEL-3
    expectedDays[32] = 2; // 2026-09-02 — CR-VEL-4
    expect(body.days!.map((d) => d.points)).toEqual(expectedDays);
    for (const d of body.days!) {
      expect(typeof d.day).toBe("string");
      expect(d.day.length).toBeGreaterThan(0);
    }

    // Flow: UNCHANGED by CR-CRU-161 — every fixture cycle carries exec
    // 1000ms / loop 3000ms / gate 2000ms, so the mean is 1000/2000 no
    // matter which population of cycles the implementation samples.
    expect(body.flow).toBeDefined();
    expect(body.flow!.execMsPerCycle).toBe(1000);
    expect(body.flow!.gateMsPerCycle).toBe(2000);
    expect(body.flow!.sampleCycles).toBeGreaterThanOrEqual(1);
  });

  test("a release with no CR ever planned into it 404s, like the other release-scoped analytics reads", async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000a02";
    handle!.store.addProject({ key, name: "vel-empty", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    setSystemTime(new Date("2026-09-09T12:00:00.000Z"));
    const { status, body } = await getVelocity(key, "9.5.0");
    expect(status).toBe(404);
    expect(typeof body.error).toBe("string");
  });
});

