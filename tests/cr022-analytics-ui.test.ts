// CR-CRU-022 §S5 — UI: the hybrid (F16 + F14¾).
//
// Spec: docs/changes/CR-CRU-022-roadmap-analytics.md §S5 + its AC block.
// Design: docs/research/DN-crucible-analytics.md §10; storyboard frames F16
// and F14¾ (both in .lavish/crucible-v2-design.html).
//
// Baseline (measured 2026-09-24, re-confirmed): `grep -a` over `public/`
// for `roadmap-progress` / `analytics-pane` / `burndown-chart` returns ZERO
// hits (also grep-confirmed against the live source in this pass), and no
// `public/vendor/uplot*` file exists (`ls public/vendor` lists only
// daisyui/tailwind/van/van-x). Every assertion below is expected to FAIL.
//
// SCOPE OF THIS FILE, honestly bounded. The full §S5 AC list has five
// items; this file covers the first three (the Velocity card, the
// `roadmap-progress` band and its exact "N of M pts" text, and the
// tap-to-open/Esc-to-close pane swap) plus the fourth (no date text under
// insufficient_history/unpointed). The FIFTH — the phone-band ≥44px
// collapse (DN-crucible-responsive-model.md §13's two-engine WebKit
// harness) — needs infrastructure this pass does not build; it is a
// reported gap, not a silently skipped one (see this RED agent's report).
// The vendored uPlot LIBRARY FILE'S existence is asserted (the DN pins the
// exact version); the chart's internal draw DATA is not, since uPlot draws
// to canvas and happy-dom cannot see pixels — that half is Playwright's.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

interface QueueFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
  seq?: number;
  release?: string;
  points?: number;
}

const KEY = "cru022-ui-key";
const RELEASE = "0.3.0";
const TARGET_AT = 1_791_158_400; // 2026-10-04T00:00:00Z

const PROPOSED: ProposalFixture = { label: RELEASE, targetAt: TARGET_AT, timestamp: 1_789_000_000, waves: ["7"] };

const QUEUE: QueueFixture[] = [
  { cr: "CR-UI-1", title: "pointed cr", wave: "7", dependsOn: [], status: "IN_PROGRESS", seq: 10, release: RELEASE, points: 5 },
  { cr: "CR-UI-2", title: "unpointed cr", wave: "7", dependsOn: [], status: "PENDING", seq: 20, release: RELEASE },
];

/** §S2/AC1 — the Velocity card's own fixture. */
const VELOCITY_BODY = {
  ok: true,
  pointsPerWeek: 21,
  weeks: [
    { week: "2026-W34", points: 18 },
    { week: "2026-W35", points: 22 },
    { week: "2026-W36", points: 23 },
  ],
  sampleWeeks: 3,
  flow: { execMsPerCycle: 2_280_000, gateMsPerCycle: 1_320_000, sampleCycles: 6 },
};

/** §S3 — a normal (dated) burndown for the band's "remaining of committed". */
const BURNDOWN_BODY = {
  ok: true,
  release: RELEASE,
  committedPoints: 5,
  target: TARGET_AT,
  ideal: [
    { ts: 1_789_000_000_000, remaining: 5 },
    { ts: TARGET_AT * 1000, remaining: 0 },
  ],
  points: [],
  unpointed: ["CR-UI-2"],
};

/** §S4 — a normal (dated) forecast for the band's P50/P80 chip. */
const FORECAST_BODY = {
  ok: true,
  release: RELEASE,
  remainingPoints: 5,
  p50Ts: 1_790_000_000_000,
  p80Ts: 1_790_500_000_000,
  scheduleHealth: "at-risk",
  sampleWeeks: 3,
  status: "ok",
};

/** §S4/AC2 — below the confidence gate: no date text anywhere. */
const FORECAST_INSUFFICIENT = {
  ok: true,
  release: RELEASE,
  remainingPoints: 5,
  sampleWeeks: 1,
  status: "insufficient_history",
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

interface MountOpts {
  forecast?: unknown;
}

async function mountApp(opts: MountOpts = {}): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${KEY}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    if (/\/analytics\/velocity/.test(url)) return okResponse(VELOCITY_BODY);
    if (/\/analytics\/burndown/.test(url)) return okResponse(BURNDOWN_BODY);
    if (/\/analytics\/forecast/.test(url)) return okResponse(opts.forecast ?? FORECAST_BODY);
    if (/\/release-proposals/.test(url)) return okResponse({ ok: true, proposals: [PROPOSED], totalCount: 1 });
    if (/\/releases/.test(url)) return okResponse({ ok: true, releases: [] });
    if (/\/queue/.test(url)) return okResponse({ ok: true, entries: QUEUE });
    if (/\/plans/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) {
      return okResponse({
        ok: true,
        projects: [
          { key: KEY, name: KEY, type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: Date.now() } satisfies ProjectFixture,
        ],
      });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    throw new Error(`cr022-analytics-ui.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?cr022AnalyticsUi=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 10 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("CR-CRU-022 §S5 — the hybrid UI: Velocity card, roadmap-progress band, analytics pane", () => {
  test("uPlot 1.6.32 is vendored beside VanJS, zero-build (DN §10's picked chart library)", () => {
    // A structural AC (the DN names the exact version and the drop path),
    // deliberately paired with the behavioural ones below rather than left
    // standing alone.
    const found = existsSync(path.join(REPO_ROOT, "public/vendor/uplot-1.6.32.iife.min.js")) ||
      existsSync(path.join(REPO_ROOT, "public/vendor/uPlot-1.6.32.iife.min.js"));
    expect(found).toBe(true);
  });

  test("the Project band's Velocity card renders the exact pts/week figure and the flow split, on the Roadmap tab", async () => {
    await mountApp();
    const projectPane = document.querySelector('[data-testid="project-pane"], [data-testid="project-band-foot"]');
    expect(projectPane).not.toBeNull();
    const body = text(document.body);
    expect(body).toContain("21");
    expect(body).toContain("pts / week");
  });

  test("`roadmap-progress` renders in zone 3's header, above the release-scoped table, names the remaining/committed points and the unpointed CR", async () => {
    await mountApp();
    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();

    const table = document.querySelector<HTMLElement>('[data-testid="roadmap-table"], [data-testid="roadmap-cards"]');
    expect(table).not.toBeNull();
    // "above" — the band precedes the table in DOCUMENT ORDER.
    const position = band!.compareDocumentPosition(table!);
    // eslint-disable-next-line no-bitwise
    expect((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);

    const bandText = text(band);
    expect(bandText).toContain("5"); // committedPoints
    expect(bandText).toContain("CR-UI-2"); // the unpointed CR, named on the band
  });

  test("tapping the band swaps the pane to `analytics-pane` with `burndown-chart`; Esc restores the roadmap table", async () => {
    await mountApp();
    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    expect(document.querySelector('[data-testid="analytics-pane"]')).toBeNull();

    band!.click();
    await settleDom({ ticks: 6 });

    const pane = document.querySelector<HTMLElement>('[data-testid="analytics-pane"]');
    expect(pane).not.toBeNull();
    expect(pane!.querySelector('[data-testid="burndown-chart"]')).not.toBeNull();
    // Velocity is not duplicated into the pane.
    expect(text(pane).toLowerCase()).not.toContain("pts / week");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settleDom({ ticks: 6 });

    expect(document.querySelector('[data-testid="analytics-pane"]')).toBeNull();
    expect(document.querySelector('[data-testid="roadmap-table"], [data-testid="roadmap-cards"]')).not.toBeNull();
  });

  test("under insufficient_history no date text renders anywhere on the band or the pane", async () => {
    await mountApp({ forecast: FORECAST_INSUFFICIENT });
    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    const bandText = text(band);
    // No ISO-ish date, and no P50/P80 chip text — the presence of digits
    // for the points figures is fine; the DATE forms are what must be gone.
    expect(/\bp50\b/i.test(bandText)).toBe(false);
    expect(/\bp80\b/i.test(bandText)).toBe(false);
    expect(/\d{4}-\d{2}-\d{2}/.test(bandText)).toBe(false);

    band!.click();
    await settleDom({ ticks: 6 });
    const pane = document.querySelector<HTMLElement>('[data-testid="analytics-pane"]');
    const paneText = text(pane);
    expect(/\bp50\b/i.test(paneText)).toBe(false);
    expect(/\bp80\b/i.test(paneText)).toBe(false);
    expect(/\d{4}-\d{2}-\d{2}/.test(paneText)).toBe(false);
  });
});
