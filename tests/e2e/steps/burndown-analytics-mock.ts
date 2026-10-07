// CR-CRU-160 §S2/§S3 — network-level test doubles for the two release
// analytics reads `refetchAnalytics` makes (public/app.js): GET
// …/analytics/burndown and …/analytics/forecast.
//
// WHY A MOCK, NOT THE REAL ROUTES (documented so a later reader does not
// "fix" this into a flaky real-time fixture): a DATED forecast needs >= 3
// REAL completed calendar weeks of pointed-merge history
// (`VELOCITY_WINDOW_WEEKS`, src/analytics.ts `weeklyVelocity`/`forecast`),
// and every merge's `closedAt` is stamped with the LIVE server's
// `Date.now()` at close time (`src/store.ts` `closePlan`, confirmed —
// `const closedAt = Date.now();` — no body field overrides it) and the
// forecast route itself reads `now: Date.now()` (`src/v2.ts`
// `handleAnalyticsForecast`, confirmed — only `seed` is test-only, no `now`
// override). No HTTP door can backdate a merge, so no sequence of real
// `queue/plan` + close posts inside one short-lived e2e scenario can ever
// produce `history.length >= 3`: that is three real weeks of wall-clock
// time, not three API calls. A dated-forecast / many-step fixture is
// therefore UNREACHABLE through the real routes in e2e test time — this is
// the one, deliberate seam where these scenarios intercept the two READ
// responses instead of trying to manufacture them live. Everything else
// (project, agent, release proposal, CR membership, navigation, the tab
// click, the pane open, uPlot, the draw hook, the DOM it produces) is the
// real, unmodified client/server code under test; only the JSON these two
// GETs would have answered is replaced, each still shaped exactly like the
// real `BurndownPayload`/`ForecastPayload` (src/analytics.ts) the real
// server returns, with the real request's own `release` query param echoed
// back — never hard-coded — so `isBurndownBody`/`isForecastBody`'s
// `body.release === release` check (public/app.js) still holds for
// whatever release the real CR-queue/release-proposal steps actually
// created.
import type { Page } from "@playwright/test";

export interface BurndownStepFixture {
  ts: number;
  remaining: number;
  event: string;
  cr: string;
  delta: number;
}

export interface BurndownFixture {
  committedPoints: number;
  target?: number;
  ideal?: Array<{ ts: number; remaining: number }>;
  points: BurndownStepFixture[];
  unpointed: string[];
}

export interface ForecastFixture {
  remainingPoints: number;
  p50Ts?: number;
  p80Ts?: number;
  scheduleHealth?: string;
  sampleDays: number;
  status: "ok" | "insufficient_history" | "unpointed";
  unpointed?: string[];
}

const DAY_MS = 86_400_000;

/**
 * Mirrors the ONE production formatter these scenarios' expectations must
 * match: `shortDay` (public/app.js) = `L.formatReleaseDate(ms / 1000).slice(5)`,
 * and `formatReleaseDate` is documented (public/app-logic.d.mts) as "epoch
 * SECONDS in, ISO `YYYY-MM-DD` out" — i.e. the plain UTC calendar day. `.slice(5)`
 * keeps `MM-DD`.
 */
export function shortDay(ms: number): string {
  return new Date(ms).toISOString().slice(5, 10);
}

/** Mirrors `fmtPoints` (public/app.js): whole numbers print whole. */
export function fmtPoints(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Mirrors the EXACT text `drawLabel` builds for one burndown step
 * (public/app.js, inside `burndownOptions`'s draw hook):
 * `` `${sign}${fmtPoints(Math.abs(delta))} · ${cr} ${event}` `` — the sign is
 * U+2212 MINUS SIGN for a negative delta (never the ASCII hyphen), matching
 * §S3's own example verbatim: "shows its full label (`−8 · CR-CRU-015
 * merged`)".
 */
export function stepLabelText(step: BurndownStepFixture): string {
  const sign = step.delta > 0 ? "+" : "\u2212";
  return `${sign}${fmtPoints(Math.abs(step.delta))} · ${step.cr} ${step.event}`;
}

/** Installs the two read-response doubles for `projectKey`, scoped to it so
 * concurrent/other scenarios' projects are never touched. */
async function routeAnalytics(
  page: Page,
  projectKey: string,
  burndown: BurndownFixture,
  forecast: ForecastFixture,
): Promise<void> {
  await page.route(
    `**/api/v2/projects/${projectKey}/analytics/burndown*`,
    async (route) => {
      const url = new URL(route.request().url());
      const release = url.searchParams.get("release") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, release, ...burndown }),
      });
    },
  );
  await page.route(
    `**/api/v2/projects/${projectKey}/analytics/forecast*`,
    async (route) => {
      const url = new URL(route.request().url());
      const release = url.searchParams.get("release") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, release, ...forecast }),
      });
    },
  );
}

export interface ProjectionLabelExpectations {
  today: string;
  p50: string;
  p80: string;
  target: string;
}

/** A small dated-forecast fixture: one merge step, a future P50/P80/target. */
export async function mockDatedForecast(
  page: Page,
  projectKey: string,
): Promise<ProjectionLabelExpectations> {
  const now = Date.now();
  const remaining = 30;
  const burndown: BurndownFixture = {
    committedPoints: 48,
    target: Math.floor((now + 15 * DAY_MS) / 1000),
    points: [
      { ts: now - 10 * DAY_MS, remaining: 48, event: "start", cr: "CR-FIX-000", delta: 0 },
      { ts: now - 4 * DAY_MS, remaining, event: "merged", cr: "CR-FIX-001", delta: -18 },
    ],
    unpointed: [],
  };
  const p50Ts = now + 7 * DAY_MS;
  const p80Ts = now + 14 * DAY_MS;
  const forecast: ForecastFixture = {
    remainingPoints: remaining,
    p50Ts,
    p80Ts,
    sampleDays: 3,
    status: "ok",
  };
  await routeAnalytics(page, projectKey, burndown, forecast);
  return {
    today: `← today · ${fmtPoints(remaining)} pts`,
    p50: `P50 ${shortDay(p50Ts)}`,
    p80: `P80 ${shortDay(p80Ts)}`,
    target: `target ${shortDay((burndown.target as number) * 1000)}`,
  };
}

export interface RefusalExpectation {
  mustContain: string[];
}

/** A forecast that refuses with `insufficient_history` — CR-CRU-161 §S2's
 * confidence gate (amended 2026-10-07): no pointed CR of the release has
 * merged yet. A BINARY gate, not the old "N of 3 weeks" sample-count one. */
export async function mockRefusedInsufficientHistory(
  page: Page,
  projectKey: string,
): Promise<RefusalExpectation> {
  const now = Date.now();
  const burndown: BurndownFixture = {
    committedPoints: 10,
    points: [{ ts: now - 2 * DAY_MS, remaining: 10, event: "start", cr: "CR-FIX-000", delta: 0 }],
    unpointed: [],
  };
  const forecast: ForecastFixture = {
    remainingPoints: 10,
    sampleDays: 0,
    status: "insufficient_history",
  };
  await routeAnalytics(page, projectKey, burndown, forecast);
  // Specific to THIS refusal: the spec's own wording for the gate (§S2 —
  // "saying no pointed CR of the release has merged yet"), never a generic
  // "no forecast" string a no-op stub could print for either refusal kind.
  return { mustContain: ["no pointed CR of the release has merged yet"] };
}

/** A forecast that refuses with `unpointed` — naming the unpointed CRs. */
export async function mockRefusedUnpointed(
  page: Page,
  projectKey: string,
): Promise<RefusalExpectation> {
  const now = Date.now();
  const unpointed = ["CR-FIX-009", "CR-FIX-010"];
  const burndown: BurndownFixture = {
    committedPoints: 10,
    points: [{ ts: now - 2 * DAY_MS, remaining: 10, event: "start", cr: "CR-FIX-000", delta: 0 }],
    unpointed,
  };
  const forecast: ForecastFixture = {
    remainingPoints: 10,
    sampleDays: 3,
    status: "unpointed",
    unpointed,
  };
  await routeAnalytics(page, projectKey, burndown, forecast);
  // Specific to THIS refusal: every unpointed CR actually answered, never a
  // generic "no forecast" string a no-op stub could print for either
  // refusal kind.
  return { mustContain: unpointed };
}

export interface ManyStepsFixtureResult {
  labels: ProjectionLabelExpectations;
  steps: BurndownStepFixture[];
}

/** A 63-step history (AC4) — every point a labelable merge/scope step (no
 * `start`/zero-delta point consumes one of the 63), spread across ~70 days
 * so the chart MUST decide, for each, whether it fits. */
export async function mockManyStepsDatedForecast(
  page: Page,
  projectKey: string,
): Promise<ManyStepsFixtureResult> {
  const now = Date.now();
  const start = now - 70 * DAY_MS;
  let remaining = 150;
  const points: BurndownStepFixture[] = [];
  for (let i = 0; i < 63; i++) {
    const ts = start + i * DAY_MS + (i % 5) * 3_600_000;
    const isScope = i % 11 === 0;
    const delta = isScope ? 3 + (i % 5) : -(2 + (i % 4));
    remaining = Math.max(2, remaining + delta);
    points.push({
      ts,
      remaining,
      event: isScope ? "scope added" : "merged",
      cr: `CR-FIX-${String(i + 1).padStart(3, "0")}`,
      delta,
    });
  }
  const burndown: BurndownFixture = {
    committedPoints: 150,
    target: Math.floor((now + 10 * DAY_MS) / 1000),
    points,
    unpointed: [],
  };
  const p50Ts = now + 6 * DAY_MS;
  const p80Ts = now + 12 * DAY_MS;
  const forecast: ForecastFixture = {
    remainingPoints: remaining,
    p50Ts,
    p80Ts,
    sampleDays: 3,
    status: "ok",
  };
  await routeAnalytics(page, projectKey, burndown, forecast);
  return {
    labels: {
      today: `← today · ${fmtPoints(remaining)} pts`,
      p50: `P50 ${shortDay(p50Ts)}`,
      p80: `P80 ${shortDay(p80Ts)}`,
      target: `target ${shortDay((burndown.target as number) * 1000)}`,
    },
    steps: points,
  };
}
