// CR-CRU-022 §S2 — velocity (project-level): GET …/analytics/velocity.
//
// Spec: docs/changes/CR-CRU-022-roadmap-analytics.md §S2 + its two ACs.
// Design: docs/research/DN-crucible-analytics.md §5 (velocity) + §3 (the
// two clocks / the 2026-09-24 "flow" amendment — BDD e2e runs count toward
// exec time).
//
// Baseline (measured 2026-09-24, re-confirmed at this RED pass): no
// `/analytics/*` route exists anywhere in src/v2.ts's dispatch (grep over
// the file for "analytics" returns zero route registrations), and no
// analytics code exists in src/ or public/. Every assertion below is
// expected to FAIL against an unknown-route response (404/undefined body),
// never the §S2 payload `{pointsPerWeek, weeks[], sampleWeeks, flow}`.
//
// FIXTURE DESIGN, so the RED signal cannot be second-guessed later:
//
//   * "calendar week" — the CR/DN never pin Mon-Sun vs Sun-Sat. Every
//     fixture instant below is placed exactly 7 (or 14, for the deliberate
//     gap) days apart, anchored on a Wednesday — a shift that lands in the
//     immediately-next 7-day bucket under EITHER convention, so this file's
//     week-boundary assertions hold regardless of which one GREEN picks
//     (RED agent's documented choice: date PLACEMENT is convention-proof
//     rather than committing to one convention's exact bucket labels).
//   * every fixture cycle carries the SAME exec/loop/gate shape (exec
//     1000ms, loop 3000ms, gate 2000ms) — deliberately, so `flow`'s mean is
//     the same number regardless of WHICH population of cycles an
//     implementation samples (last-3-weeks only vs. all project history):
//     the assertion is robust to that unstated choice, unlike
//     `pointsPerWeek`'s population, which the AC pins exactly ("last 3
//     completed weeks").
//   * CR-VEL-4's linked run is split into a 500ms "unit" event and a 500ms
//     "bdd" event. If BDD-tier runs were wrongly excluded from exec(c) (the
//     open question §3's 2026-09-24 amendment resolved to "yes, they
//     count"), that ONE cycle's exec would read 500ms instead of 1000ms and
//     the flow.execMsPerCycle MEAN below would read 875, not 1000 — so one
//     fixture proves both the mean's convention-robustness and the
//     BDD-inclusion rule in the same assertion.
//   * "today" is pinned by `setSystemTime` to a Wednesday inside week W5, so
//     W1-W4 are unambiguously its 4 preceding COMPLETED weeks, and W5 (which
//     carries no merge) never enters the series. W1 sits a full extra week
//     before W2 (a deliberate GAP with zero merges) so an implementation
//     that zero-fills empty weeks is caught by `weeks.length` alone.
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
  pointsPerWeek?: number;
  weeks?: Array<{ week: string; points: number }>;
  sampleWeeks?: number;
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

async function getVelocity(key: string): Promise<{ status: number; body: VelocityBody }> {
  const res = await fetch(`${base()}/api/v2/projects/${key}/analytics/velocity`);
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
  test("pointsPerWeek is the mean of the last 3 COMPLETED weeks; weeks lists every week with a pointed merge, gap weeks stay absent (never zero); a BDD-tier run counts toward exec time", async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000a01";
    handle!.store.addProject({ key, name: "vel", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    // W1 — Wed 2026-08-05 (a full week BEFORE the gap week 2026-08-12,
    // which carries no merge at all).
    mergeCr(key, {
      cr: "CR-VEL-1",
      points: 3,
      filedAt: "2026-08-01T09:00:00.000Z",
      activatedAt: "2026-08-05T09:00:00.000Z",
      eventAt: "2026-08-05T09:00:01.000Z",
      doneAt: "2026-08-05T09:00:03.000Z",
      mergedAt: "2026-08-05T10:00:00.000Z",
    });
    // W2 — Wed 2026-08-19
    mergeCr(key, {
      cr: "CR-VEL-2",
      points: 5,
      filedAt: "2026-08-15T09:00:00.000Z",
      activatedAt: "2026-08-19T09:00:00.000Z",
      eventAt: "2026-08-19T09:00:01.000Z",
      doneAt: "2026-08-19T09:00:03.000Z",
      mergedAt: "2026-08-19T10:00:00.000Z",
    });
    // W3 — Wed 2026-08-26
    mergeCr(key, {
      cr: "CR-VEL-3",
      points: 8,
      filedAt: "2026-08-22T09:00:00.000Z",
      activatedAt: "2026-08-26T09:00:00.000Z",
      eventAt: "2026-08-26T09:00:01.000Z",
      doneAt: "2026-08-26T09:00:03.000Z",
      mergedAt: "2026-08-26T10:00:00.000Z",
    });
    // W4 — Wed 2026-09-02, the split unit+bdd run
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

    // "today" — Wed 2026-09-09, inside W5 (open, no merge in it at all).
    setSystemTime(new Date("2026-09-09T12:00:00.000Z"));

    const { status, body } = await getVelocity(key);
    expect(status).toBe(200);
    expect(body.ok).not.toBe(false);

    // §S2/AC1 — the mean of the last 3 COMPLETED weeks: (5 + 8 + 2) / 3.
    expect(body.pointsPerWeek).toBe(5);
    expect(body.sampleWeeks).toBe(3);

    // Exactly the weeks that had pointed merges: W1 counts (it merged
    // points, even though it falls OUTSIDE the 3-week mean window), the
    // empty gap week between W1 and W2 is ABSENT (not a zero entry), and W5
    // (the still-open week) never appears.
    expect(Array.isArray(body.weeks)).toBe(true);
    expect(body.weeks!.length).toBe(4);
    expect(body.weeks!.map((w) => w.points)).toEqual([3, 5, 8, 2]);
    for (const w of body.weeks!) {
      expect(typeof w.week).toBe("string");
      expect(w.week.length).toBeGreaterThan(0);
    }

    // §S2/AC2 — flow: every fixture cycle carries exec 1000ms / loop 3000ms
    // / gate 2000ms, so the mean is 1000/2000 no matter which population of
    // cycles the implementation samples.
    expect(body.flow).toBeDefined();
    expect(body.flow!.execMsPerCycle).toBe(1000);
    expect(body.flow!.gateMsPerCycle).toBe(2000);
    expect(body.flow!.sampleCycles).toBeGreaterThanOrEqual(1);
  });

  test("with no pointed merges at all, weeks/sampleWeeks reflect an empty history, never a zero-filled one", async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000a02";
    handle!.store.addProject({ key, name: "vel-empty", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    setSystemTime(new Date("2026-09-09T12:00:00.000Z"));
    const { status, body } = await getVelocity(key);
    expect(status).toBe(200);
    expect(Array.isArray(body.weeks)).toBe(true);
    expect(body.weeks!.length).toBe(0);
    expect(body.sampleWeeks).toBe(0);
  });
});
