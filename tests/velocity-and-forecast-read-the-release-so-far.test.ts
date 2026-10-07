// CR-CRU-161 §S3/AC1/AC5 — the Velocity card, the phone foot strip, the
// release band and the forecast card all read the FOCUSED release's daily
// pace, not the project's weekly one.
//
// Spec: docs/changes/CR-CRU-161-velocity-and-the-forecast-follow-the-release-so-far.md
//       §S3 ("every surface reads the release's pace per day"); AC1 ("every
//       surface that shows it ... reads pts / day for the focused release");
//       AC5 ("the Velocity card matches storyboard F18 §1").
// Design: docs/research/DN-crucible-analytics.md §5 ("the per-day rate ...
//       with what it covers ... and the release's daily bars"), §7 ("once
//       dated, the answer says how many days it rests on"), §9 (the real
//       `GET …/analytics/velocity?release=<label>` payload shape:
//       `{release, startTs, pointsPerDay?, days:[{day, points}], sampleDays,
//       flow}`).
// Storyboard: F18 §1 (.lavish/crucible-v2-design.html,
//       `data-mock="project-velocity-per-day"`): `6.7 pts / day`,
//       `0.3.0 so far · 28 days · 188 pts`, the daily bars, the dashed rate
//       line. This file asserts the SPEC's locked text pieces (the pts/day
//       figure, the "<release> so far · N days · M pts" coverage line, one
//       bar per day); the storyboard's pixel-level fidelity is AC5's own
//       real-browser VERIFY check, not a happy-dom concern.
//
// Baseline (measured against this branch, after C1 1ba5507 changed the
// SERVER'S velocity/forecast shape but before public/app.js was touched):
// `refetchAnalytics` fetches `${base}/velocity` with NO `?release=` query,
// unconditionally — even with no focused release; `isVelocityBody` still
// requires the OLD `weeks`/`sampleWeeks` shape, so the real (new-shaped)
// server response never satisfies it; `velocityFigure`/`VelocityCard` read
// `pointsPerWeek`/`weeks`/`sampleWeeks`; the phone foot strip and the
// release band both print `pts / week`/`pts/wk`; `burndownCaption` says
// nothing about sample size; `AnalyticsForecast`'s dated line reads "1,000
// draws of WEEKLY velocity"; its refusal line still cites
// `FORECAST_SAMPLE_WEEKS` ("N of 3 weeks of velocity") rather than the
// spec's own wording ("no pointed CR of the release has merged yet",
// §S2). Every assertion below is expected to FAIL against that baseline.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

const KEY = "cru161-velocity-per-day-key";
const RELEASE = "0.6.0";
const TARGET_AT = 1_791_158_400; // 2026-10-04T00:00:00Z

const PROPOSED = { label: RELEASE, targetAt: TARGET_AT, timestamp: 1_787_000_000, waves: ["7"] };

/** `RoadmapPanel` (public/app.js) only renders `RoadmapProgressBand` once the
 *  queue holds at least one entry — an empty queue renders the empty-board
 *  skeleton instead (AC19), band included. One pointed CR of the release is
 *  enough to put the band on screen; it carries no other meaning here. */
const QUEUE = [
  { cr: "CR-V-1", title: "pointed cr", wave: "7", dependsOn: [], status: "IN_PROGRESS", seq: 10, release: RELEASE, points: 5 },
];

/** DN §5/§9 — the real `GET …/analytics/velocity?release=` shape (C1,
 * 1ba5507): `days` zero-filled since the release's start, `sampleDays` how
 * many it covers, `pointsPerDay` the mean (merged / sampleDays — 10 pts
 * over 4 days here, so 2.5, consistent with the fixture's own day points). */
const VELOCITY_BODY = {
  ok: true,
  release: RELEASE,
  startTs: 1_789_000_000_000,
  pointsPerDay: 2.5,
  days: [
    { day: "2026-10-01", points: 2 },
    { day: "2026-10-02", points: 0 },
    { day: "2026-10-03", points: 5 },
    { day: "2026-10-04", points: 3 },
  ],
  sampleDays: 4,
  flow: { execMsPerCycle: 1_000_000, gateMsPerCycle: 500_000, sampleCycles: 4 },
};

/** A velocity body only a BUG would ever surface: the page should never
 * fetch velocity (let alone render it) when there is no focused release. */
const STALE_VELOCITY_BODY = {
  ok: true,
  release: "unexpected-release",
  startTs: 1,
  pointsPerDay: 42,
  days: [{ day: "2020-01-01", points: 42 }],
  sampleDays: 1,
  flow: {},
};

const BURNDOWN_BODY = {
  ok: true,
  release: RELEASE,
  committedPoints: 15,
  target: TARGET_AT,
  ideal: [
    { ts: 1_789_000_000_000, remaining: 15 },
    { ts: TARGET_AT * 1000, remaining: 0 },
  ],
  points: [],
  unpointed: [],
};

/** A dated forecast — picked so NONE of its ISO dates contain "12" (the
 * `sampleDays` figure under test), so a `toContain("12")` assertion can only
 * be satisfied by the sample-size text itself, never a date coincidence
 * (confirmed: 2026-09-10 / 2026-09-21 / 2026-09-27 / 2026-10-05). */
const FORECAST_BODY = {
  ok: true,
  release: RELEASE,
  remainingPoints: 5,
  p50Ts: 1_790_000_000_000,
  p80Ts: 1_790_500_000_000,
  scheduleHealth: "at-risk",
  sampleDays: 12,
  status: "ok",
};

/** §S2's own confidence gate (amended 2026-10-07): refuses until one pointed
 * CR of the release has merged — a BINARY gate, not a "N of 3 weeks" count. */
const FORECAST_REFUSED = {
  ok: true,
  release: RELEASE,
  remainingPoints: 5,
  sampleDays: 0,
  status: "insufficient_history",
};

let cacheBust = 0;
let fetchLog: string[] = [];

function installLayout(): void {
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    const box = (left: number, width: number): DOMRect =>
      ({ x: left, y: 0, left, right: left + width, top: 0, bottom: 0, width, height: 0, toJSON: () => box }) as
        unknown as DOMRect;
    if (testid === "roadmap-strip-track") return box(0, 800);
    if (testid === "roadmap-strip-ruler") return box(0, 100);
    return box(0, 0);
  };
}

interface MountOpts {
  /** false simulates nothing shipped/proposed — `focusedReleaseLabel()`
   *  resolves to `undefined`, the way CR-CRU-078's strip-focus rule does for
   *  an empty gate sequence. */
  focused?: boolean;
  forecast?: unknown;
}

async function mountApp(opts: MountOpts = {}): Promise<void> {
  const focused = opts.focused !== false;
  fetchLog = [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${KEY}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    fetchLog.push(url);
    if (/\/analytics\/velocity/.test(url)) {
      return okResponse(focused ? VELOCITY_BODY : STALE_VELOCITY_BODY);
    }
    if (/\/analytics\/burndown/.test(url)) return okResponse(BURNDOWN_BODY);
    if (/\/analytics\/forecast/.test(url)) return okResponse(opts.forecast ?? FORECAST_BODY);
    if (/\/release-proposals/.test(url)) {
      return focused
        ? okResponse({ ok: true, proposals: [PROPOSED], totalCount: 1 })
        : okResponse({ ok: true, proposals: [], totalCount: 0 });
    }
    if (/\/releases/.test(url)) return okResponse({ ok: true, releases: [] });
    if (/\/queue/.test(url)) return okResponse({ ok: true, entries: focused ? QUEUE : [] });
    if (/\/plans/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) {
      return okResponse({
        ok: true,
        projects: [
          { key: KEY, name: KEY, type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: Date.now() },
        ],
      });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    throw new Error(`velocity-and-forecast-read-the-release-so-far.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?velocityReleaseSoFar=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 10 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("CR-CRU-161 §S3/AC1 — velocity and the forecast follow the release so far", () => {
  test("the velocity read carries the focused release's ?release= query, exactly once", async () => {
    await mountApp();
    const velocityCalls = fetchLog.filter((u) => u.includes("/analytics/velocity"));
    expect(velocityCalls.length).toBe(1);
    expect(velocityCalls[0]).toContain(`release=${encodeURIComponent(RELEASE)}`);
  });

  test("the Velocity card shows the release's exact per-day rate, in pts / day, never pts / week", async () => {
    await mountApp();
    const card = document.querySelector('[data-testid="project-velocity"]');
    expect(card).not.toBeNull();
    const cardText = text(card);
    expect(cardText).toContain("2.5");
    expect(cardText).toContain("pts / day");
    expect(cardText).not.toContain("pts / week");
  });

  test("the Velocity card states what it covers: the release, the days since its start, and the points merged", async () => {
    await mountApp();
    const card = document.querySelector('[data-testid="project-velocity"]');
    const cardText = text(card);
    expect(cardText).toContain(`${RELEASE} so far`);
    expect(cardText).toContain("4 days");
    expect(cardText).toContain("10 pts"); // 2 + 0 + 5 + 3 merged across the series
  });

  test("the Velocity card draws exactly one bar per day in the release's series", async () => {
    await mountApp();
    const bars = document.querySelectorAll('[data-testid="velocity-bars"] .app-velocity-bar');
    expect(bars.length).toBe(4);
  });

  test("the release band's rate reads pts / day, never pts/wk", async () => {
    await mountApp();
    const band = document.querySelector('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    const bandText = text(band);
    expect(bandText).toContain("2.5");
    expect(bandText).toContain("pts / day");
    expect(bandText).not.toContain("pts/wk");
  });

  test("with no focused release, the Velocity card neither fetches velocity nor shows a stale figure", async () => {
    await mountApp({ focused: false });
    const velocityCalls = fetchLog.filter((u) => u.includes("/analytics/velocity"));
    expect(velocityCalls.length).toBe(0);
    const card = document.querySelector('[data-testid="project-velocity"]');
    expect(card).not.toBeNull();
    const cardText = text(card);
    expect(cardText.length).toBeGreaterThan(0);
    expect(cardText).not.toContain("42"); // STALE_VELOCITY_BODY's figure, never leaked
    expect(/\d[\d.]*\s*pts\s*\/\s*day/.test(cardText)).toBe(false);
  });

  test("the burndown caption and the dated forecast card say how many days the forecast rests on, never 'week'", async () => {
    await mountApp();
    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    band!.click();
    await settleDom({ ticks: 6 });

    const pane = document.querySelector('[data-testid="analytics-pane"]');
    expect(pane).not.toBeNull();

    const caption = pane!.querySelector(".app-burndown-caption");
    expect(caption).not.toBeNull();
    const captionText = text(caption);
    expect(captionText.toLowerCase()).not.toContain("week");
    expect(/\bdays\b/i.test(captionText)).toBe(true);
    expect(captionText).toContain("12"); // FORECAST_BODY.sampleDays

    const forecastCard = pane!.querySelector('[data-testid="analytics-forecast"]');
    expect(forecastCard).not.toBeNull();
    const forecastText = text(forecastCard);
    expect(forecastText.toLowerCase()).not.toContain("weekly");
    expect(/\bdays\b/i.test(forecastText)).toBe(true);
    expect(forecastText).toContain("12"); // FORECAST_BODY.sampleDays
  });

  test("the forecast card's refusal names the real gate (no pointed CR of the release has merged yet), not a weekly sample count", async () => {
    await mountApp({ forecast: FORECAST_REFUSED });
    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    band!.click();
    await settleDom({ ticks: 6 });

    const pane = document.querySelector('[data-testid="analytics-pane"]');
    const forecastCard = pane!.querySelector('[data-testid="analytics-forecast"]');
    expect(forecastCard).not.toBeNull();
    const forecastText = text(forecastCard).toLowerCase();
    expect(forecastText).toContain("no pointed cr of the release has merged yet");
    expect(forecastText).not.toContain("week");
  });
});
