// Velocity card reads a per-day OR a per-week pace, with a day/week switch
// on the card, and the choice is remembered in this browser.
//
// Spec: docs/changes/CR-CRU-174-0.3.0s-fix-list-the-page.md §S2 ("the
// Velocity card reads per day or per week, and only its switch is
// clickable") — "Per week = the release's points merged since it started ÷
// the weeks since (days ÷ 7), one bar per week, weeks counted from the
// release's first day (not the calendar), the last partial week drawn
// hollow; the caption `<release> so far · <n> weeks · <points> pts`. The
// choice is remembered in this browser and changes the card only — the
// phone foot strip, the release band and the forecast stay per day."
// Storyboard: F18 "1b · per day or per week" (.lavish/crucible-v2-design.html,
// APPROVED 2026-10-08, `data-mock="project-velocity-day-week-day"` /
// `…-week`), card a ("a day | week switch on the card... one bar per
// week"), card b ("the choice is remembered in this browser. It changes
// the card only: the phone foot strip, the release band and the forecast
// stay per day").
//
// THIS FILE PINS THE DOM CONTRACT GREEN MUST BUILD (none of it exists on
// this branch yet — every assertion below is new behaviour, not a
// re-pin):
//   - `[data-testid="velocity-view-toggle"]` wraps two buttons,
//     `[data-testid="velocity-view-day"]` ("day") and
//     `[data-testid="velocity-view-week"]` ("week"), each carrying
//     `aria-pressed` for the current selection; `day` is selected with no
//     stored preference.
//   - the per-week figure is `<rate>` formatted to EXACTLY one decimal
//     (never `fmtPoints`'s variable integer-vs-decimal form) — `rate =
//     merged / (sampleDays / 7)`.
//   - the caption is `<release> so far · <weeks> weeks · <merged> pts`,
//     `<weeks>` = `sampleDays / 7` rounded to one decimal, `<merged>` the
//     SAME total the per-day caption already shows.
//   - one bar per 7-day block counted from `days[0]` (NOT a calendar-week
//     boundary); the LAST block, when it holds fewer than 7 days, carries
//     `data-hollow-week="true"` on its bar — no earlier bar does.
//   - the bars container's `aria-label` is `story points of <release>
//     merged per week since it started` (F18 1b's own SVG `aria-label`,
//     "day" swapped for "week").
//   - the foot line reads `wk 1 from <firstDayLabel> … wk <n> so far (<k>
//     day(s)) · dashed = the rate` — never "today counts" (that phrase is
//     per-day only).
//   - the choice persists to `localStorage` under
//     `"crucible.velocity.view"` (`"day"` | `"week"`) and is honored as
//     the default view on the next mount — same idiom as
//     `"crucible.density.mode"` / `"crucible.rail.collapsed"`.
//   - toggling the card's view never touches `project-band-velocity`,
//     `roadmap-progress`'s rate text or the forecast card: all three keep
//     reading `pts / day`.
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

const KEY = "cadence-reading-project-key";
const RELEASE = "4.2.0";
const TARGET_AT = 1_775_000_000; // an arbitrary future epoch second — never asserted on
const VELOCITY_VIEW_STORAGE_KEY = "crucible.velocity.view";

const PROPOSED = { label: RELEASE, targetAt: TARGET_AT, timestamp: 1_770_000_000, waves: ["1"] };

/** One pointed CR of the release is enough to put the band on screen
 *  (`RoadmapPanel` skips `RoadmapProgressBand` on an empty queue). */
const QUEUE = [
  { cr: "CR-CADENCE-001", title: "cadence fixture", wave: "1", dependsOn: [], status: "IN_PROGRESS", seq: 10, release: RELEASE, points: 5 },
];

/** A FIXED, hand-computed 15-day velocity series: three 7-day blocks from
 *  the release's first day (02/02), the third holding a single day —
 *  2026-02-02 is a Monday, deliberately NOT aligned on a Sunday/Monday
 *  calendar-week boundary near the end, so a bug that buckets by the
 *  CALENDAR week (not the release's own start) would draw different
 *  bars than this fixture expects.
 *    week 1 (02/02 … 02/08): 3+1+2+4+0+2+2 = 14
 *    week 2 (02/09 … 02/15): 2+3+1+0+4+2+2 = 14
 *    week 3 (02/16, partial — 1 day):        2
 *  merged = 30 pts over 15 days -> pointsPerDay = 2 (clean, matches the
 *  per-day figure the series already carries).
 *  weeksSince = 15 / 7 = 2.142857… -> "2.1" (one decimal).
 *  pointsPerWeek = 30 / (15/7) = 14 exactly -> "14.0" (STILL one decimal —
 *  the per-week figure is never shown as a bare integer). */
const DAY_POINTS = [3, 1, 2, 4, 0, 2, 2, 2, 3, 1, 0, 4, 2, 2, 2];
const VELOCITY_DAYS = DAY_POINTS.map((points, i) => ({
  day: `2026-02-${String(2 + i).padStart(2, "0")}`,
  points,
}));
const VELOCITY_MERGED = DAY_POINTS.reduce((sum, n) => sum + n, 0); // 30
const VELOCITY_BODY = {
  ok: true,
  release: RELEASE,
  startTs: 1_770_000_000_000,
  pointsPerDay: 2,
  days: VELOCITY_DAYS,
  sampleDays: VELOCITY_DAYS.length, // 15
  flow: { execMsPerCycle: 1_000_000, gateMsPerCycle: 500_000, sampleCycles: 15 },
};

const BURNDOWN_BODY = {
  ok: true,
  release: RELEASE,
  committedPoints: 40,
  target: TARGET_AT,
  ideal: [
    { ts: 1_770_000_000_000, remaining: 40 },
    { ts: TARGET_AT * 1000, remaining: 0 },
  ],
  points: [],
  unpointed: [],
};

const FORECAST_BODY = {
  ok: true,
  release: RELEASE,
  remainingPoints: 10,
  p50Ts: 1_772_000_000_000,
  p80Ts: 1_772_500_000_000,
  scheduleHealth: "on-track",
  sampleDays: 15,
  status: "ok",
};

let cacheBust = 0;

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
  /** Seeds `localStorage` BEFORE `app.js` boots — simulates "remembered
   *  from a previous session", since happy-dom hands each
   *  `GlobalRegistrator.register()` call a FRESH Storage (same idiom as
   *  tests/density.test.ts / tests/drill-in.test.ts). */
  localStorageSeed?: Record<string, string>;
}

async function mountApp(opts: MountOpts = {}): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${KEY}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  if (opts.localStorageSeed !== undefined) {
    for (const [key, value] of Object.entries(opts.localStorageSeed)) {
      window.localStorage.setItem(key, value);
    }
  }

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    if (/\/analytics\/velocity/.test(url)) return okResponse(VELOCITY_BODY);
    if (/\/analytics\/burndown/.test(url)) return okResponse(BURNDOWN_BODY);
    if (/\/analytics\/forecast/.test(url)) return okResponse(FORECAST_BODY);
    if (/\/release-proposals/.test(url)) return okResponse({ ok: true, proposals: [PROPOSED], totalCount: 1 });
    if (/\/releases/.test(url)) return okResponse({ ok: true, releases: [] });
    if (/\/queue/.test(url)) return okResponse({ ok: true, entries: QUEUE });
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
    throw new Error(`velocity-card-day-or-week-reading.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?velocityDayOrWeek=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 10 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function velocityCard(): Element {
  const card = document.querySelector('[data-testid="project-velocity"]');
  expect(card).not.toBeNull();
  return card!;
}

function dayToggle(): HTMLElement {
  const el = document.querySelector('[data-testid="velocity-view-day"]');
  expect(el, "no [data-testid=\"velocity-view-day\"] switch option on the card").not.toBeNull();
  return el as HTMLElement;
}

function weekToggle(): HTMLElement {
  const el = document.querySelector('[data-testid="velocity-view-week"]');
  expect(el, "no [data-testid=\"velocity-view-week\"] switch option on the card").not.toBeNull();
  return el as HTMLElement;
}

describe("CR-CRU-174 §S2 — the Velocity card reads per day or per week", () => {
  test("the switch exists on the card with day selected by default", async () => {
    await mountApp();
    const card = velocityCard();
    const toggle = card.querySelector('[data-testid="velocity-view-toggle"]');
    expect(toggle, "no [data-testid=\"velocity-view-toggle\"] inside the Velocity card").not.toBeNull();

    const day = dayToggle();
    const week = weekToggle();
    expect(text(day)).toBe("day");
    expect(text(week)).toBe("week");
    // Both switch options live ON the card (never floated outside it).
    expect(card.contains(day)).toBe(true);
    expect(card.contains(week)).toBe(true);

    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(week.getAttribute("aria-pressed")).toBe("false");

    const cardText = text(card);
    expect(cardText).toContain("2 pts / day");
    expect(cardText).not.toContain("pts / week");
  });

  test("choosing week shows the exact per-week figure, caption, one bar per 7-day block from the release's first day, and marks the trailing partial block hollow", async () => {
    await mountApp();
    const week = weekToggle();
    week.click();
    await settleDom({ ticks: 4 });

    const card = velocityCard();
    const cardText = text(card);

    // The figure: rate = 30 / (15/7) = 14 exactly, shown at a FIXED one
    // decimal ("14.0"), never fmtPoints' bare "14".
    expect(cardText).toContain("14.0 pts / week");
    expect(cardText).not.toContain("14.0 pts / day");
    expect(cardText).not.toContain("2 pts / day");

    // The caption: "<release> so far · <weeks> weeks · <merged> pts".
    expect(cardText).toContain(`${RELEASE} so far · 2.1 weeks · ${VELOCITY_MERGED} pts`);

    // One bar per 7-day block from days[0] (NOT the calendar week): three
    // blocks (14, 14, 2 over 15 days), never 15 daily bars.
    const bars = card.querySelectorAll('[data-testid="velocity-bars"] .app-velocity-bar');
    expect(bars.length).toBe(3);

    // The trailing partial block (1 of 7 days) is the ONLY hollow bar.
    const hollowFlags = [...bars].map((b) => b.getAttribute("data-hollow-week"));
    expect(hollowFlags[0]).not.toBe("true");
    expect(hollowFlags[1]).not.toBe("true");
    expect(hollowFlags[2]).toBe("true");

    const barsContainer = card.querySelector('[data-testid="velocity-bars"]');
    expect(barsContainer?.getAttribute("aria-label")).toBe(
      `story points of ${RELEASE} merged per week since it started`,
    );

    // The foot line: "wk 1 from <firstDayLabel> … wk <n> so far (<k>
    // day(s)) · dashed = the rate" — never the per-day "today counts".
    expect(cardText).toContain("wk 1 from 2/02 … wk 3 so far (1 day) · dashed = the rate");
    expect(cardText).not.toContain("today counts");

    expect(week.getAttribute("aria-pressed")).toBe("true");
    expect(dayToggle().getAttribute("aria-pressed")).toBe("false");
  });

  test("switching back to day restores the exact per-day figure, caption and one bar per day", async () => {
    await mountApp();
    weekToggle().click();
    await settleDom({ ticks: 4 });
    dayToggle().click();
    await settleDom({ ticks: 4 });

    const card = velocityCard();
    const cardText = text(card);
    expect(cardText).toContain("2 pts / day");
    expect(cardText).toContain(`${RELEASE} so far · 15 days · ${VELOCITY_MERGED} pts`);
    expect(cardText).not.toContain("pts / week");

    const bars = card.querySelectorAll('[data-testid="velocity-bars"] .app-velocity-bar');
    expect(bars.length).toBe(VELOCITY_DAYS.length);

    expect(dayToggle().getAttribute("aria-pressed")).toBe("true");
    expect(weekToggle().getAttribute("aria-pressed")).toBe("false");
  });

  test("the week choice is written to localStorage under crucible.velocity.view and survives a remount", async () => {
    await mountApp();
    expect(window.localStorage.getItem(VELOCITY_VIEW_STORAGE_KEY)).not.toBe("week");
    weekToggle().click();
    await settleDom({ ticks: 4 });
    expect(window.localStorage.getItem(VELOCITY_VIEW_STORAGE_KEY)).toBe("week");

    // Simulate reload: fresh mount (fresh Storage per GlobalRegistrator.register)
    // seeded with the persisted value — never a click to re-derive it.
    await mountApp({ localStorageSeed: { [VELOCITY_VIEW_STORAGE_KEY]: "week" } });
    const card = velocityCard();
    const cardText = text(card);
    expect(cardText).toContain("14.0 pts / week");
    expect(dayToggle().getAttribute("aria-pressed")).toBe("false");
    expect(weekToggle().getAttribute("aria-pressed")).toBe("true");
  });

  test("choosing week on the card leaves the release band and the forecast reading pts per day", async () => {
    await mountApp();
    weekToggle().click();
    await settleDom({ ticks: 4 });
    // The card itself really did flip to week — the guard this test needs
    // to mean anything.
    expect(text(velocityCard())).toContain("14.0 pts / week");

    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    const bandText = text(band);
    expect(bandText).toContain("2 pts / day");
    expect(bandText).not.toContain("pts / week");

    band!.click();
    await settleDom({ ticks: 6 });
    const pane = document.querySelector('[data-testid="analytics-pane"]');
    expect(pane).not.toBeNull();
    const forecastCard = pane!.querySelector('[data-testid="analytics-forecast"]');
    expect(forecastCard).not.toBeNull();
    const forecastText = text(forecastCard).toLowerCase();
    expect(forecastText).not.toContain("per week");
    expect(forecastText).not.toContain("pts / week");
  });
});
