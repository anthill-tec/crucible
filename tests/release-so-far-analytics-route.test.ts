// CR-CRU-161 §S1/§S2 — the real dispatcher: GET …/analytics/velocity now
// requires `?release=` and answers the release-so-far payload.
//
// Spec: docs/changes/CR-CRU-161-velocity-and-the-forecast-follow-the-release-so-far.md
// §S1 ("`GET …/analytics/velocity` takes the release (`?release=`)...").
//
// Baseline (measured at this RED pass): `handleAnalyticsVelocity` in
// src/v2.ts calls `requireHeldProject` only — no `requireReleaseParam`, the
// same validator `handleAnalyticsBurndown`/`handleAnalyticsForecast` already
// use — so a GET with no `?release=` answers 200 today, not 400. And the
// JSON body it answers is still the old calendar-week shape
// (`pointsPerWeek`/`weeks`/`sampleWeeks`), carrying none of
// `startTs`/`pointsPerDay`/`days`/`sampleDays`. Routed through the REAL
// store + dispatcher (not the pure function) to prove the WIRING, not just
// `velocity()`'s own logic (covered by tests/release-so-far-velocity.test.ts).
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { QueuePlanInput } from "../src/store.ts";

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
  flow?: unknown;
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
  const dir = mkdtempSync(join(tmpdir(), "cru161-vel-route-"));
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
    // Nothing JSON-shaped; the empty default fails the assertions on FIELDS.
  }
  return { status: res.status, body };
}

function mergeCr(
  key: string,
  cr: string,
  release: string,
  points: number,
  filedAt: string,
  mergedAt: string,
): void {
  const store = handle!.store;
  setSystemTime(new Date(filedAt));
  const input: QueuePlanInput = { cr, release, wave: "1", title: cr, points };
  store.upsertQueueEntry(key, input);
  const plan = planned(store.filePlan(key, { cr, cycles: [{ label: "c1", kind: "red-green" }] }));
  const cycleId = plan.cycles[0]!.id;
  setSystemTime(new Date(filedAt));
  planned(store.transitionCycle(key, plan.planId, cycleId, "active"));
  planned(store.transitionCycle(key, plan.planId, cycleId, "done"));
  setSystemTime(new Date(mergedAt));
  planned(store.closePlan(key, plan.planId, { commit: `${cr.toLowerCase()}c0de` }));
}

describe("CR-CRU-161 §S1 — GET …/analytics/velocity: real dispatcher", () => {
  test("missing `?release=` answers 400, like the other release-scoped analytics reads", async () => {
    boot();
    const key = "00000000-0000-7000-8161-000000000b01";
    handle!.store.addProject({ key, name: "vel-route", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    const { status, body } = await getVelocity(key);

    expect(status).toBe(400);
    expect(body.error).toBe("`release` is required — the release label to analyse, e.g. ?release=0.3.0");
  });

  test("with `?release=`, the body carries the release's start, a zero-filled per-day series, the day count and the rate — through the real store", async () => {
    boot();
    const key = "00000000-0000-7000-8161-000000000b02";
    handle!.store.addProject({ key, name: "vel-route-2", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    const RELEASE = "9.9.9";
    mergeCr(key, "CR-ROUTE-1", RELEASE, 3, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z");
    mergeCr(key, "CR-ROUTE-2", RELEASE, 5, "2026-09-01T09:05:00.000Z", "2026-09-04T10:00:00.000Z");
    setSystemTime(new Date("2026-09-04T12:00:00.000Z"));

    const { status, body } = await getVelocity(key, RELEASE);

    expect(status).toBe(200);
    expect(body.ok).not.toBe(false);
    expect(body.release).toBe(RELEASE);
    expect(body.startTs).toBe(Date.parse("2026-09-01T09:00:00.000Z"));
    // 2026-09-01..2026-09-04 inclusive = 4 days.
    expect(body.sampleDays).toBe(4);
    expect(body.pointsPerDay).toBe(2);
    expect(Array.isArray(body.days)).toBe(true);
    expect(body.days!.map((d) => d.points)).toEqual([3, 0, 0, 5]);
    // The flow line is still present — project-level, unchanged by this CR.
    expect(body.flow).toBeDefined();
  });
});
