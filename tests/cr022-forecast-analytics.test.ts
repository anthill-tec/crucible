// CR-CRU-022 §S4 — forecast: GET …/analytics/forecast.
//
// RE-PINNED for CR-CRU-161 §S2 (2026-10-07 re-specification): the Monte
// Carlo now samples the FOCUSED RELEASE's own daily pointed throughput
// since ITS start (zero days real), not the project's weekly history —
// this file's ORIGINAL fixtures deliberately filed their `CR-FCST-HIST-*`/
// `CR-FCST-BIMODAL-*` history CRs into release "9.1.0" while the release
// under test was "9.7.0" (proving the OLD code's project-wide leak the CR's
// own Problem section names: "The forecast samples the project's
// history... not the release's own pace"). Every history fixture below now
// belongs to the SAME release the test queries, and the confidence gate is
// no longer "< 3 completed ISO calendar weeks" but "no pointed CR of the
// release has merged yet" — a release can be DATED off a single merge.
// `sampleWeeks` is replaced by `sampleDays` throughout (DN §9).
//
// Two tests (`insufficient_history`, `at-risk`) keep a THIRD, genuinely
// unrelated release (still called "9.1.0", the original fixture's own
// label) carrying real merged history — enough, under the OLD project-wide
// model, to satisfy its old 3-completed-week gate — specifically so the
// RED signal proves the release-scoping itself, not just the week→day unit
// change: the OLD code answers "ok" (wrongly, off release 9.1.0's history)
// where the release-so-far model must still refuse for 9.7.0.
//
// Spec: docs/changes/CR-CRU-161-velocity-and-the-forecast-follow-the-release-so-far.md
// §S2/AC2. Design: docs/research/DN-crucible-analytics.md §7 (amended
// 2026-10-07).
//
// THE MONTE CARLO'S RNG IS NOT PINNED BY THIS FILE (kept from the original
// pin — still true: no algorithm is named by the spec). Every
// "ok"/exact-value fixture below still uses a ZERO-VARIANCE daily-velocity
// history (every day in the window merges the exact same number of
// points, so sampling ANY value from a single-valued distribution returns
// that value on EVERY draw, for ANY correct Monte Carlo implementation
// regardless of its RNG) — the original pin's own reasoning, now applied
// per DAY instead of per WEEK. `remainingPoints` stays an exact multiple of
// that constant daily velocity so the zero-crossing lands on a whole-day
// boundary.
//
// "at-risk" keeps the original's BIMODAL, probabilistically-bounded
// construction (three very-low days, one very-high day) — the margin
// derivation is unchanged in substance, only "week" → "day" throughout (see
// that test's own comment).
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
  sampleDays?: number;
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

/** Merge one CR, into `release`, for `points` points, closing at `mergedAt`. */
function mergeCr(key: string, cr: string, release: string, points: number, mergedAt: string): void {
  fileWithPoints(key, cr, release, points, mergedAt);
  const plan = planned(
    handle!.store.filePlan(key, { cr, cycles: [{ label: "c1", kind: "red-green" }] }),
  );
  planned(handle!.store.transitionCycle(key, plan.planId, plan.cycles[0]!.id, "active"));
  planned(handle!.store.transitionCycle(key, plan.planId, plan.cycles[0]!.id, "done"));
  setSystemTime(new Date(mergedAt));
  planned(handle!.store.closePlan(key, plan.planId, { commit: `${cr.toLowerCase()}c0de` }));
}

/** 3 consecutive days of RELEASE's own history, each merging EXACTLY
 *  `dailyPoints` — zero variance, so completion is exact and
 *  algorithm-independent (see file header). Days 2026-09-07/08/09 (today). */
function threeConstantDays(key: string, release: string, dailyPoints: number): void {
  mergeCr(key, "CR-FCST-HIST-1", release, dailyPoints, "2026-09-07T10:00:00.000Z");
  mergeCr(key, "CR-FCST-HIST-2", release, dailyPoints, "2026-09-08T10:00:00.000Z");
  mergeCr(key, "CR-FCST-HIST-3", release, dailyPoints, "2026-09-09T10:00:00.000Z");
}

const TODAY_ISO = "2026-09-09T12:00:00.000Z";
const TODAY_MS = Date.parse(TODAY_ISO);

describe("CR-CRU-022 §S4 — forecast: GET …/analytics/forecast", () => {
  test('status "ok" with a zero-variance 3-day daily-velocity history: P50 === P80 === exactly 3 days from today (remainingPoints is an exact multiple of the constant daily velocity)', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f01";
    handle!.store.addProject({ key, name: "fcst-ok", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    // The release's one remaining CR: 30 points, unmerged, no declared
    // target — so scheduleHealth must stay absent even though status is ok.
    // Filed BEFORE the first history merge, so it sets the release's start
    // at the window's own first day (2026-09-07) — no earlier filed_at
    // would pull the start back and introduce zero-value days that would
    // break the zero-variance history.
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-07T00:00:00.000Z");
    threeConstantDays(key, "9.7.0", 10);

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.remainingPoints).toBe(30);
    expect(body.sampleDays).toBe(3);

    const expectedCompletion = TODAY_MS + 3 * DAY_MS;
    expect(body.p50Ts).toBe(expectedCompletion);
    expect(body.p80Ts).toBe(expectedCompletion);
    expect(body.p50Ts).toBeLessThanOrEqual(body.p80Ts!);
    expect(body.scheduleHealth).toBeUndefined();
  });

  test('no pointed CR of the release has merged yet → status "insufficient_history", no band values — even while an UNRELATED release has three completed weeks of its own merged history', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f02";
    handle!.store.addProject({
      key,
      name: "fcst-insufficient",
      type: "backend",
      sutRoot: "/tmp",
      retention: 1_000_000,
    });
    // Release "9.1.0" (unrelated to 9.7.0, the release under test): THREE
    // completed weeks of pointed merges — enough, under the OLD
    // project-wide model, to satisfy its old 3-completed-week gate and
    // answer a dated "ok" for ANY release query, since the old code never
    // filtered `weeklyVelocity`'s history by `release` at all. The
    // release-so-far model must ignore it completely.
    mergeCr(key, "CR-FCST-NOISE-1", "9.1.0", 10, "2026-08-19T10:00:00.000Z");
    mergeCr(key, "CR-FCST-NOISE-2", "9.1.0", 10, "2026-08-26T10:00:00.000Z");
    mergeCr(key, "CR-FCST-NOISE-3", "9.1.0", 10, "2026-09-02T10:00:00.000Z");
    // 9.7.0 itself: a pointed, remaining CR — but NO CR of 9.7.0 has EVER
    // merged.
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-01T00:00:00.000Z");

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("insufficient_history");
    // 2026-09-01 .. 2026-09-09 inclusive = 9 days.
    expect(body.sampleDays).toBe(9);
    expect(body.p50Ts).toBeUndefined();
    expect(body.p80Ts).toBeUndefined();
    expect(body.scheduleHealth).toBeUndefined();
  });

  test('a remaining CR with no points in the release → status "unpointed", naming it, no band values — once a single pointed CR of the release has merged', async () => {
    boot();
    const key = "00000000-0000-7000-8022-000000000f03";
    handle!.store.addProject({
      key,
      name: "fcst-unpointed",
      type: "backend",
      sutRoot: "/tmp",
      retention: 1_000_000,
    });
    // ONE pointed merge of 9.7.0 is now enough to date it (no 3-day/3-week
    // threshold) — the confidence gate CR-CRU-161 §S2 simplifies.
    mergeCr(key, "CR-FCST-HIST-1", "9.7.0", 10, "2026-09-01T10:00:00.000Z");
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
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-07T00:00:00.000Z");
    threeConstantDays(key, "9.7.0", 10);
    setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    // Completion is exactly today+3d; a target 10 days out is unambiguously
    // AFTER it for a zero-variance forecast, regardless of RNG.
    handle!.store.recordReleaseProposal(key, "orchestrator-1", {
      label: "9.7.0",
      targetAt: Math.floor((TODAY_MS + 10 * DAY_MS) / 1000),
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
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 30, "2026-09-07T00:00:00.000Z");
    threeConstantDays(key, "9.7.0", 10);
    setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    // Completion is exactly today+3d; a target 1 day out is unambiguously
    // BEFORE it for a zero-variance forecast, regardless of RNG.
    handle!.store.recordReleaseProposal(key, "orchestrator-1", {
      label: "9.7.0",
      targetAt: Math.floor((TODAY_MS + 1 * DAY_MS) / 1000),
    });

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.scheduleHealth).toBe("behind");
  });

  test('scheduleHealth "at-risk" — a bimodal (very-low/very-high) DAILY-velocity history separates P50 and P80 widely enough that a seeded target deep inside the gap is robust to ANY correct RNG', async () => {
    // STATISTICALLY ROBUST, not exact-value — per this file's header, no RNG
    // algorithm is pinned by the spec, so a fixture with genuine day-to-day
    // VARIANCE cannot assert an exact P50/P80 date. This fixture instead
    // makes the GAP between P50 and P80 wide, and places the seeded target
    // deep enough inside it, that no correct Monte Carlo implementation can
    // cross it — for ANY seeded PRNG that samples "the empirical distribution
    // of points per DAY" (DN-crucible-analytics.md §7 step 1, amended
    // 2026-10-07), by construction:
    //
    //   History: 4 completed days of release 9.7.0 itself, BIMODAL — three
    //   VERY LOW days (1 pt each) and one VERY HIGH day (104 pts, exactly
    //   `remainingPoints` below). Each simulated draw-day independently
    //   samples one of the 4 historical daily totals with equal probability,
    //   so P(draw = the high day) = p = 0.25, P(draw = a low day) = 0.75.
    //
    //   Because the high day's 104 points alone already meet
    //   `remainingPoints` (104), a draw's completion day T is EXACTLY the
    //   index of that draw's first high-day pick (low draws before it add
    //   only 1 point each — reaching 104 through low draws ALONE would need
    //   >100 consecutive low picks in a row, probability 0.75^100 ≈ 0, an
    //   astronomically negligible tail this margin analysis ignores). T is
    //   therefore (to that same negligible tail) a Geometric(p=0.25) random
    //   variable:
    //     P(T <= k) = 1 − 0.75^k
    //     P(T <= 3) = 0.578,  P(T <= 4) = 0.684   →  true P50 = 3 days
    //     P(T <= 5) = 0.763,  P(T <= 6) = 0.822   →  true P80 = 6 days
    //
    //   TARGET is fixed at exactly 4 days from today — inside the [3, 6]-day
    //   gap between the true P50 and P80. For N = 1000 draws, the two ways
    //   this fixture could fail are each many standard deviations from ever
    //   happening (the counts/sds are identical to the original weekly
    //   version of this test — only the unit is days, not weeks):
    //     P(empirical P50 > 4d) = P(count(T<=4) < 500 of 1000): the true
    //       count(T<=4) has mean 684, sd ≈ sqrt(1000·0.684·0.316) ≈ 14.7,
    //       so crossing 500 needs z ≈ (500−684)/14.7 ≈ −12.5σ.
    //     P(empirical P80 <= 4d) = P(count(T<=4) >= 800 of 1000): same
    //       mean/sd, so crossing 800 needs z ≈ (800−684)/14.7 ≈ +7.9σ.
    //   Both are far beyond any plausible finite-sample noise from 1000
    //   draws, for any seeded PRNG that actually samples the distribution
    //   the DN describes — this is what makes the fixture ROBUST rather
    //   than a guess at one implementation's specific output.
    boot();
    const key = "00000000-0000-7000-8022-000000000f06";
    handle!.store.addProject({ key, name: "fcst-at-risk", type: "backend", sutRoot: "/tmp", retention: 1_000_000 });

    // The release's one remaining CR: 104 points, unmerged — exactly the
    // high day's total (see the margin derivation above). Filed BEFORE the
    // first bimodal merge, so it sets the release's start at the window's
    // own first day.
    fileWithPoints(key, "CR-FCST-REL-1", "9.7.0", 104, "2026-09-06T00:00:00.000Z");
    // 3 very-low days (1 pt each).
    mergeCr(key, "CR-FCST-BIMODAL-LOW-1", "9.7.0", 1, "2026-09-06T10:00:00.000Z");
    mergeCr(key, "CR-FCST-BIMODAL-LOW-2", "9.7.0", 1, "2026-09-07T10:00:00.000Z");
    mergeCr(key, "CR-FCST-BIMODAL-LOW-3", "9.7.0", 1, "2026-09-08T10:00:00.000Z");
    // 1 very-high day: exactly `remainingPoints` below (104), landing on
    // "today" itself.
    mergeCr(key, "CR-FCST-BIMODAL-HIGH-1", "9.7.0", 104, "2026-09-09T10:00:00.000Z");

    setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
    // TARGET = exactly 4 days from "today" (TODAY_ISO/TODAY_MS, this file's
    // own constants) — deep inside the theoretical [P50=3d, P80=6d] gap, per
    // the margin analysis above.
    const targetMs = TODAY_MS + 4 * DAY_MS;
    handle!.store.recordReleaseProposal(key, "orchestrator-1", {
      label: "9.7.0",
      targetAt: Math.floor(targetMs / 1000),
    });

    setSystemTime(new Date(TODAY_ISO));
    const { status, body } = await getForecast(key, "9.7.0");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.remainingPoints).toBe(104);
    expect(body.sampleDays).toBe(4);
    expect(body.p50Ts).toBeDefined();
    expect(body.p80Ts).toBeDefined();
    // The ordering "at-risk" itself is defined by (DN §8) — no exact dates,
    // only the relationship, exactly as this gap asks for.
    expect(body.p50Ts!).toBeLessThanOrEqual(body.p80Ts!);
    expect(body.p50Ts!).toBeLessThanOrEqual(targetMs);
    expect(targetMs).toBeLessThan(body.p80Ts!);
    expect(body.scheduleHealth).toBe("at-risk");
  });
});
