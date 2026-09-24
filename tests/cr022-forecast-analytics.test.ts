// CR-CRU-022 §S4 — forecast (release-level, Monte Carlo): GET
// …/analytics/forecast.
//
// Spec: docs/changes/CR-CRU-022-roadmap-analytics.md §S4 + its three ACs.
// Design: docs/research/DN-crucible-analytics.md §7 (forecast) + §8
// (schedule health).
//
// Baseline (measured 2026-09-24, re-confirmed): no `/analytics/*` route
// exists. Every assertion below is expected to FAIL.
//
// THE MONTE CARLO'S RNG IS NOT PINNED BY THIS FILE — READ THIS FIRST.
// The CR/DN require "N = 1000 draws... a test-only seed parameter makes the
// draws deterministic" but name no algorithm, and no algorithm is
// discoverable anywhere in this repo (grep-confirmed: no analytics code
// exists yet at all). A RED agent asserting an EXACT P50/P80 value for a
// fixture with real week-to-week VARIANCE would be asserting against ITS
// OWN guessed PRNG, not the spec — a correct, spec-compliant
// implementation using a DIFFERENT (equally valid) seeded PRNG could
// legitimately compute a different date and fail this file for no real
// defect. So every fixture below uses a ZERO-VARIANCE weekly-velocity
// history (every completed week merges the exact same number of points):
// sampling ANY value from a single-valued distribution returns that value
// on EVERY draw, for ANY correct Monte Carlo implementation regardless of
// its RNG — so P50 and P80 are exact, hand-computable, and
// algorithm-independent. remainingPoints is chosen as an EXACT multiple of
// that constant weekly velocity (30 = 3 × 10) so the zero-crossing lands
// ON a whole-week boundary too, removing any fractional-week
// interpolation question. Completion is therefore EXACTLY "today + 3
// calendar weeks" for any correct implementation, which this file pins as
// `todayMs + 21 days` (RED agent's documented choice, grounded in F14¾'s
// own caption: "From today, the band projects the remaining points
// forward").
//
// THE at-risk AC (`P50 <= target < P80`) — closed by a SEPARATE RED pass
// (agent CR-CRU-022-C1-RED2), not by this file's own zero-variance fixtures.
// "ahead" (target beyond completion) and "behind" (target before completion)
// both hold for ANY target outside the zero-variance completion instant, so
// both are exact-value tests below. "at-risk" is UNREACHABLE with P50 ===
// P80 (a zero-variance history), and reaching it needs genuine variance
// without reopening the unpinned-RNG problem above — solved with a BIMODAL
// history (three very-low weeks, one very-high week) whose Geometric-
// distributed completion time gives a wide, PROBABILISTICALLY bounded gap
// between P50 and P80 (no exact values asserted, only their ordering against
// a seeded target chosen deep inside that gap). See the last test in this
// file for the full margin derivation.
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

interface ForecastBody {
  ok?: boolean;
  release?: string;
  remainingPoints?: number;
  p50Ts?: number;
  p80Ts?: number;
  scheduleHealth?: string;
  sampleWeeks?: number;
  status?: string;
  [key: string]: unknown;
}

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;
const DAY_MS = 86_400_000;

afterEach(() => {
  setSystemTime();
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function boot(): ServerHandle {
  const dir = mkdtempSync(join(tmpdir(), "cru022-fcst-"));
  scratchDirs.push(dir);
  handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function getForecast(
  key: string,
  release: string,
  seed = 42,
): Promise<{ status: number; body: ForecastBody }> {
  const res = await fetch(
    `${base()}/api/v2/projects/${key}/analytics/forecast` +
      `?release=${encodeURIComponent(release)}&seed=${seed}`,
  );
  let body: ForecastBody = {};
  try {
    body = (await res.json()) as ForecastBody;
  } catch {
    // Not-yet-existing route: no JSON body. Fail on the FIELDS below.
  }
  return { status: res.status, body };
}

function fileWithPoints(
  key: string,
  cr: string,
  release: string,
  points: number | undefined,
  filedAt: string,
): void {
  setSystemTime(new Date(filedAt));
  const input: QueuePlanInput & { points?: number } = {
    cr,
    release,
    wave: "1",
    title: cr,
    ...(points === undefined ? {} : { points }),
  };
  handle!.store.upsertQueueEntry(key, input);
}

/** Merge one CR for `points` points, closing at `mergedAt`. */
function mergeCr(key: string, cr: string, points: number, mergedAt: string): void {
  fileWithPoints(key, cr, "9.1.0", points, mergedAt);
  const plan = planned(
    handle!.store.filePlan(key, { cr, cycles: [{ label: "c1", kind: "red-green" }] }),
  );
  planned(handle!.store.transitionCycle(key, plan.planId, plan.cycles[0]!.id, "active"));
  planned(handle!.store.transitionCycle(key, plan.planId, plan.cycles[0]!.id, "done"));
  setSystemTime(new Date(mergedAt));
  planned(handle!.store.closePlan(key, plan.planId, { commit: `${cr.toLowerCase()}c0de` }));
}

/** 3 completed weeks, each merging EXACTLY `weeklyPoints` — zero variance,
 *  so completion is exact and algorithm-independent (see file header). */
function threeConstantWeeks(key: string, weeklyPoints: number): void {
  mergeCr(key, "CR-FCST-HIST-1", weeklyPoints, "2026-08-19T10:00:00.000Z");
  mergeCr(key, "CR-FCST-HIST-2", weeklyPoints, "2026-08-26T10:00:00.000Z");
  mergeCr(key, "CR-FCST-HIST-3", weeklyPoints, "2026-09-02T10:00:00.000Z");
}

const TODAY_ISO = "2026-09-09T12:00:00.000Z";
const TODAY_MS = Date.parse(TODAY_ISO);

describe("CR-CRU-022 §S4 — forecast: GET …/analytics/forecast", () => {
  test('status "ok" with a zero-variance 3-week velocity history: P50 === P80 === exactly 3 weeks from today (remainingPoints is an exact multiple of the constant weekly velocity)', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f01";
    handle!.store.addProject({ key, name: "fcst-ok", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    threeConstantWeeks(key, 10);

    // The release's one remaining CR: 30 points, unmerged, no declared
    // target — so scheduleHealth must stay absent even though status is ok.
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-01T00:00:00.000Z");

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.remainingPoints).toBe(30);
    expect(body.sampleWeeks).toBe(3);

    const expectedCompletion = TODAY_MS + 21 * DAY_MS;
    expect(body.p50Ts).toBe(expectedCompletion);
    expect(body.p80Ts).toBe(expectedCompletion);
    expect(body.p50Ts).toBeLessThanOrEqual(body.p80Ts!);
    expect(body.scheduleHealth).toBeUndefined();
  });

  test('fewer than 3 completed weeks of pointed velocity → status "insufficient_history", no band values', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f02";
    handle!.store.addProject({
      key,
      name: "fcst-insufficient",
      type: "backend",
      sutRoot: "/tmp",
      retention: 1_000_000,
    });
    // Only TWO completed weeks of pointed velocity.
    mergeCr(key, "CR-FCST-HIST-1", 10, "2026-08-26T10:00:00.000Z");
    mergeCr(key, "CR-FCST-HIST-2", 10, "2026-09-02T10:00:00.000Z");
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-01T00:00:00.000Z");

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("insufficient_history");
    expect(body.p50Ts).toBeUndefined();
    expect(body.p80Ts).toBeUndefined();
    expect(body.scheduleHealth).toBeUndefined();
  });

  test('a remaining CR with no points in the release → status "unpointed", naming it, no band values', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f03";
    handle!.store.addProject({
      key,
      name: "fcst-unpointed",
      type: "backend",
      sutRoot: "/tmp",
      retention: 1_000_000,
    });
    threeConstantWeeks(key, 10);
    // The release's remaining CR carries NO points.
    fileWithPoints(key, "CR-FCST-NOPOINTS", "9.7.0", undefined, "2026-09-01T00:00:00.000Z");

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("unpointed");
    expect(body.p50Ts).toBeUndefined();
    expect(body.p80Ts).toBeUndefined();
    expect(body.scheduleHealth).toBeUndefined();
    // "naming them" — the unpointed cr's id must appear SOMEWHERE in the
    // envelope (the CR's schema table names no dedicated field for this on
    // /forecast, unlike /burndown's `unpointed[]`, so this checks the
    // substance — the id is surfaced — without guessing a field name).
    expect(JSON.stringify(body)).toContain("CR-FCST-NOPOINTS");
  });

  test('scheduleHealth "ahead" — P80 <= the declared target', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f04";
    handle!.store.addProject({ key, name: "fcst-ahead", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    threeConstantWeeks(key, 10);
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-01T00:00:00.000Z");
    setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    // Completion is exactly today+21d; a target 30 days out is unambiguously
    // AFTER it for a zero-variance forecast, regardless of RNG.
    handle!.store.recordReleaseProposal(key, "orchestrator-1", {
      label: "9.7.0",
      targetAt: Math.floor((TODAY_MS + 30 * DAY_MS) / 1000),
    });

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.scheduleHealth).toBe("ahead");
  });

  test('scheduleHealth "behind" — P50 > the declared target', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f05";
    handle!.store.addProject({ key, name: "fcst-behind", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
    threeConstantWeeks(key, 10);
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-01T00:00:00.000Z");
    setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    // Completion is exactly today+21d; a target 10 days out is unambiguously
    // BEFORE it for a zero-variance forecast, regardless of RNG.
    handle!.store.recordReleaseProposal(key, "orchestrator-1", {
      label: "9.7.0",
      targetAt: Math.floor((TODAY_MS + 10 * DAY_MS) / 1000),
    });

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.scheduleHealth).toBe("behind");
  });

  test('scheduleHealth "at-risk" \u2014 a bimodal (very-low/very-high) weekly-velocity history separates P50 and P80 widely enough that a seeded target deep inside the gap is robust to ANY correct RNG', async () => {
    // STATISTICALLY ROBUST, not exact-value \u2014 per this file's header, no RNG
    // algorithm is pinned by the spec, so a fixture with genuine week-to-week
    // VARIANCE cannot assert an exact P50/P80 date. This fixture instead
    // makes the GAP between P50 and P80 wide, and places the seeded target
    // deep enough inside it, that no correct Monte Carlo implementation can
    // cross it \u2014 for ANY seeded PRNG that samples "the empirical distribution
    // of points per week" (DN-crucible-analytics.md \u00a77 step 1), by
    // construction:
    //
    //   History: 4 completed weeks, BIMODAL \u2014 three VERY LOW weeks (1 pt
    //   each) and one VERY HIGH week (104 pts, exactly `remainingPoints`
    //   below). Each simulated draw-week independently samples one of the 4
    //   historical weekly totals with equal probability, so P(draw = the
    //   high week) = p = 0.25, P(draw = a low week) = 0.75.
    //
    //   Because the high week's 104 points alone already meet
    //   `remainingPoints` (104), a draw's completion week T is EXACTLY the
    //   index of that draw's first high-week pick (low draws before it add
    //   only 1 point each \u2014 reaching 104 through low draws ALONE would need
    //   >100 consecutive low picks in a row, probability 0.75^100 \u2248 0, an
    //   astronomically negligible tail this margin analysis ignores). T is
    //   therefore (to that same negligible tail) a Geometric(p=0.25) random
    //   variable:
    //     P(T <= k) = 1 \u2212 0.75^k
    //     P(T <= 3) = 0.578,  P(T <= 4) = 0.684   \u2192  true P50 = 3 weeks
    //     P(T <= 5) = 0.763,  P(T <= 6) = 0.822   \u2192  true P80 = 6 weeks
    //
    //   TARGET is fixed at exactly 4 weeks (28 days) from today \u2014 inside the
    //   [3, 6]-week gap between the true P50 and P80. For N = 1000 draws,
    //   the two ways this fixture could fail are each many standard
    //   deviations from ever happening:
    //     P(empirical P50 > 4wk) = P(count(T<=4) < 500 of 1000): the true
    //       count(T<=4) has mean 684, sd \u2248 sqrt(1000\u00b70.684\u00b70.316) \u2248 14.7,
    //       so crossing 500 needs z \u2248 (500\u2212684)/14.7 \u2248 \u221212.5\u03c3.
    //     P(empirical P80 <= 4wk) = P(count(T<=4) >= 800 of 1000): same
    //       mean/sd, so crossing 800 needs z \u2248 (800\u2212684)/14.7 \u2248 +7.9\u03c3.
    //   Both are far beyond any plausible finite-sample noise from 1000
    //   draws, for any seeded PRNG that actually samples the distribution
    //   the DN describes \u2014 this is what makes the fixture ROBUST rather
    //   than a guess at one implementation's specific output.
    boot();
    const key = "00000000-0000-7000-8022-000000000f06";
    handle!.store.addProject({ key, name: "fcst-at-risk", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    // 3 very-low weeks (1 pt each).
    mergeCr(key, "CR-FCST-BIMODAL-LOW-1", 1, "2026-08-12T10:00:00.000Z");
    mergeCr(key, "CR-FCST-BIMODAL-LOW-2", 1, "2026-08-19T10:00:00.000Z");
    mergeCr(key, "CR-FCST-BIMODAL-LOW-3", 1, "2026-08-26T10:00:00.000Z");
    // 1 very-high week: exactly `remainingPoints` below (104).
    mergeCr(key, "CR-FCST-BIMODAL-HIGH-1", 104, "2026-09-02T10:00:00.000Z");

    // The release's one remaining CR: 104 points, unmerged \u2014 exactly the
    // high week's total (see the margin derivation above).
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 104, "2026-09-01T00:00:00.000Z");

    setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    // TARGET = exactly 4 weeks (28 days) from "today" (TODAY_ISO/TODAY_MS,
    // this file's own constants) \u2014 deep inside the theoretical [P50=3wk,
    // P80=6wk] gap, per the margin analysis above.
    const targetMs = TODAY_MS + 28 * DAY_MS;
    handle!.store.recordReleaseProposal(key, "orchestrator-1", {
      label: "9.7.0",
      targetAt: Math.floor(targetMs / 1000),
    });

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.remainingPoints).toBe(104);
    expect(body.p50Ts).toBeDefined();
    expect(body.p80Ts).toBeDefined();
    // The ordering "at-risk" itself is defined by (DN \u00a78) \u2014 no exact dates,
    // only the relationship, exactly as this gap asks for.
    expect(body.p50Ts!).toBeLessThanOrEqual(body.p80Ts!);
    expect(body.p50Ts!).toBeLessThanOrEqual(targetMs);
    expect(targetMs).toBeLessThan(body.p80Ts!);
    expect(body.scheduleHealth).toBe("at-risk");
  });
});
