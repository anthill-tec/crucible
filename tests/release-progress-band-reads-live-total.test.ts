// CR-CRU-174 §S1 — the release band (`roadmap-progress-remaining`) reads
// `<release> · <remaining> of <total> pts left`, where `<total>` is the
// burndown's new `totalPoints` field (the release's LIVE total), not
// `committedPoints` (the start-anchored figure it reads today).
//
// Spec: docs/changes/CR-CRU-174-0.3.0s-fix-list-the-page.md §S1 + its first
// acceptance criterion ("the band reads `<remaining> of <total> pts left` —
// asserted on the server and on the page").
// Design: storyboard `.lavish/crucible-v2-design.html` frames F14¾ and F16
// (both reference the "the release band, whose remaining-of-total text
// issue 2 changes" entry in the CR's own Design section) — the band's text
// format itself (`<release> · <remaining> of <total> pts left`) is UNCHANGED
// by this CR; only which field supplies `<total>` changes.
//
// Baseline (measured against this checkout): `public/app.js`'s
// `RoadmapProgressBand` reads `` ` of ${fmtPoints(bd.committedPoints)} pts
// left` `` — `bd.totalPoints` is never read anywhere in the file (confirmed
// by `tests/cr022-analytics-ui.test.ts`'s own `BURNDOWN_BODY` fixture,
// which carries no `totalPoints` key and still exercises `committedPoints`
// as the "of N" figure, L~97/233). So the first test below — a burndown
// body carrying BOTH fields with DIFFERENT values — fails today because the
// rendered text names `committedPoints`'s value, never `totalPoints`'s.
//
// FALLBACK CHOICE (this RED agent's, stated per the spec's own instruction
// to "state your choice"): when a burndown body carries no `totalPoints` at
// all (an older, not-yet-upgraded board answering the same route), the band
// falls back to today's text — `committedPoints` — rather than rendering
// "of undefined pts left" or hiding the figure. The second test below pins
// that fallback; it is NOT new-field-shaped RED today (the current code
// already reads `committedPoints` unconditionally), so it is written as a
// companion assertion to the first, proving the fallback path specifically,
// not a bare duplicate of today's behaviour.
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

const KEY = "release-band-total-key";
const RELEASE = "4.2.0";
const TARGET_AT = 1_791_158_400; // 2026-10-04T00:00:00Z

const PROPOSED = { label: RELEASE, targetAt: TARGET_AT, timestamp: 1_789_000_000, waves: ["7"] };
const QUEUE = [
  { cr: "CR-BAND-1", title: "pointed cr", wave: "7", dependsOn: [], status: "IN_PROGRESS", seq: 10, release: RELEASE, points: 5 },
];

const VELOCITY_BODY = {
  ok: true,
  release: RELEASE,
  pointsPerDay: 10,
  days: [{ day: "2026-09-22", points: 10 }],
  sampleDays: 1,
  flow: { execMsPerCycle: 1_000_000, gateMsPerCycle: 500_000, sampleCycles: 2 },
};

const FORECAST_BODY = {
  ok: true,
  release: RELEASE,
  remainingPoints: 13,
  p50Ts: 1_790_000_000_000,
  p80Ts: 1_790_500_000_000,
  scheduleHealth: "on-track",
  sampleDays: 3,
  status: "ok",
};

/** Both fields present, DIFFERENT values: committedPoints (the start total,
 *  39) vs. totalPoints (the release's live total, 217) — the CR's own
 *  "Observed" example figures, so a test failure that reads 39 names
 *  exactly the defect the CR reports. */
const BURNDOWN_WITH_TOTAL = {
  ok: true,
  release: RELEASE,
  committedPoints: 39,
  totalPoints: 217,
  target: TARGET_AT,
  ideal: [
    { ts: 1_789_000_000_000, remaining: 39 },
    { ts: TARGET_AT * 1000, remaining: 0 },
  ],
  points: [],
  unpointed: [],
};

/** No `totalPoints` at all — an older board's answer to the same route. */
const BURNDOWN_NO_TOTAL = {
  ok: true,
  release: RELEASE,
  committedPoints: 39,
  target: TARGET_AT,
  ideal: [
    { ts: 1_789_000_000_000, remaining: 39 },
    { ts: TARGET_AT * 1000, remaining: 0 },
  ],
  points: [],
  unpointed: [],
};

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

let cacheBust = 0;

async function mountApp(burndownBody: unknown): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${KEY}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    if (/\/analytics\/velocity/.test(url)) return okResponse(VELOCITY_BODY);
    if (/\/analytics\/burndown/.test(url)) return okResponse(burndownBody);
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
    throw new Error(`release-progress-band-reads-live-total.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?releaseBandLiveTotal=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 10 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("CR-CRU-174 §S1 — the release band reads the release's LIVE total, not the start-committed one", () => {
  test("`roadmap-progress-remaining` reads `<release> · <remaining> of <totalPoints> pts left`, never committedPoints, when totalPoints is present", async () => {
    await mountApp(BURNDOWN_WITH_TOTAL);
    const remainingEl = document.querySelector<HTMLElement>('[data-testid="roadmap-progress-remaining"]');
    expect(remainingEl).not.toBeNull();

    const bandText = text(remainingEl);
    // POSITIVE — exact text, the live total (217), not the start total (39).
    expect(bandText).toBe(`${RELEASE} · 13 of 217 pts left`);
    // NEGATIVE — the start-committed figure must not appear as the "of N" total.
    expect(bandText).not.toContain("of 39 pts left");
  });

  test("falling back: a burndown body with NO totalPoints (an older board) renders committedPoints as the total, exactly as it does today", async () => {
    await mountApp(BURNDOWN_NO_TOTAL);
    const remainingEl = document.querySelector<HTMLElement>('[data-testid="roadmap-progress-remaining"]');
    expect(remainingEl).not.toBeNull();

    const bandText = text(remainingEl);
    expect(bandText).toBe(`${RELEASE} · 13 of 39 pts left`);
  });
});
