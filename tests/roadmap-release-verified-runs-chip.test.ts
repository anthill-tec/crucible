// CR-CRU-164 §S2 (UI half) / AC4 (UI half) — the roadmap's release band
// carries a "verified · N runs ↗" chip when the FOCUSED release has any
// runs filed under it (N = the count `GET /api/v2/events?project=<key>
// &release=<label>` answers — the §S2 by-release read, already built and
// server-GREEN: `src/v2.ts` `handleEvents`' `release` branch, confirmed by
// reading); none when N is 0; clicking it opens the Runs tab filtered to
// that release.
//
// Spec: docs/changes/CR-CRU-164-a-releases-verification-runs-are-filed-under-it.md
//       §S2 ("The roadmap's release band ... carries a `verified · N runs
//       ↗` chip when the focused release has any, which opens the Runs tab
//       filtered to that release (`?release=`, read through the route
//       above, the way the `cycleId` anchor is) ... a release with no runs
//       shows no chip.") and AC4's UI half ("the release band shows
//       `verified · N runs ↗` with the right N for the focused release,
//       none when N is 0, and opens the Runs tab showing exactly those
//       runs").
//
// Baseline (measured against this branch): `grep` over `public/app.js` for
// "verified" and for an events fetch carrying both "project=" and
// "release=" returns ZERO hits — `refetchAnalytics` fetches velocity,
// burndown and forecast for the focused release but never the by-release
// events count, `RoadmapProgressBand` renders no verified chip at all, and
// the Runs tab (`WorkspaceRuns`/`WorkspaceRunsFeed`) has no release-filtered
// mode or `?release=` query handling anywhere (`public/app-logic.mjs`'s
// `routeParse` parses pathname segments only — no query string is read
// anywhere in the client). Every assertion below is expected to FAIL
// against that baseline.
//
// ESCALATION (ungoverned by the CR text, pinned here per RED convention —
// confirm with GREEN before merge, mirrors `tests/cycle-runs-anchor-fetch
// .test.ts`'s own documented precedent for an unpinned contract):
//   - testid `roadmap-verified-chip` for the band's own chip (siblings:
//     `roadmap-forecast-chip`, `roadmap-health-chip`, `roadmap-unpointed`).
//   - testid `runs-release-filter` for the Runs tab's "filtered to release
//     X" banner, and `runs-release-filter-clear` for its back-to-unfiltered
//     control (mirrors the app's own "← " back-chip convention: `← roadmap`,
//     `← runs`, `← timeline`).
//   - the opened URL carries exactly one `release` query parameter whose
//     value is the release label, read via `new URL(location.href)
//     .searchParams`; this file does not pin which route segment carries it
//     beyond that it is readable as `?release=<label>` the way the CR text
//     itself states.
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

const KEY = "cru164-verified-chip-key";
const RELEASE = "0.4.0";
const TARGET_AT = 1_791_158_400; // 2026-10-04T00:00:00Z

const PROPOSED = { label: RELEASE, targetAt: TARGET_AT, timestamp: 1_787_000_000, waves: ["7"] };

/** `RoadmapPanel` only renders `RoadmapProgressBand` once the queue holds at
 *  least one entry (AC19's empty-board skeleton otherwise) — one pointed CR
 *  is enough to put the band on screen; it carries no other meaning here. */
const QUEUE = [
  { cr: "CR-VR-1", title: "pointed cr", wave: "7", dependsOn: [], status: "IN_PROGRESS", seq: 10, release: RELEASE, points: 5 },
];

const VELOCITY_BODY = {
  ok: true,
  release: RELEASE,
  pointsPerDay: 3,
  days: [{ day: "2026-10-01", points: 3 }],
  sampleDays: 1,
  flow: { execMsPerCycle: 1000, gateMsPerCycle: 500, sampleCycles: 1 },
};

const BURNDOWN_BODY = {
  ok: true,
  release: RELEASE,
  committedPoints: 5,
  target: TARGET_AT,
  points: [],
  unpointed: [],
};

const FORECAST_BODY = {
  ok: true,
  release: RELEASE,
  remainingPoints: 5,
  sampleDays: 0,
  status: "insufficient_history",
};

interface RunEventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  release?: string;
}

function runEvent(id: string, agentId: string, timestamp: number, release?: string): RunEventFixture {
  return {
    id,
    projectKey: KEY,
    agentId,
    kind: "test",
    tier: "unit",
    timestamp,
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    ...(release !== undefined ? { release } : {}),
  };
}

const NOW = Date.now();
// §S2's by-release read — exactly the runs filed under RELEASE.
const THREE_RELEASE_RUNS: RunEventFixture[] = [
  runEvent("vr-run-1", "verify-agent-1", NOW - 3000, RELEASE),
  runEvent("vr-run-2", "verify-agent-2", NOW - 2000, RELEASE),
  runEvent("vr-run-3", "verify-agent-3", NOW - 1000, RELEASE),
];
// The project's WHOLE retained feed (the plain `/api/v2/events?project=…`
// read `refetchEvents` already makes): the three release runs ABOVE plus one
// run that carries no release at all — present so a filtered Runs view that
// merely echoed the full feed (rather than truly filtering) is caught.
const GENERAL_EVENTS: RunEventFixture[] = [
  ...THREE_RELEASE_RUNS,
  runEvent("vr-other-1", "verify-agent-4", NOW - 500),
];

/** A minimal stand-in for the browser's EventSource (happy-dom has none):
 *  just the handlers `connectStream` (public/app.js) wires, plus a
 *  `dispatch` that fires `onmessage` the way the server's stream does. */
class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  dispatch(kind: string): void {
    this.onmessage?.({ data: JSON.stringify({ type: kind, projectKey: KEY }) });
  }
}

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
let fetchLog: string[] = [];
let liveStream: FakeEventSource | null = null;

interface MountOpts {
  /** false simulates nothing shipped/proposed — `focusedReleaseLabel()`
   *  resolves to `undefined`, the same empty-gate-sequence fallback
   *  `tests/velocity-and-forecast-read-the-release-so-far.test.ts` drives. */
  focused?: boolean;
  /** The by-release read's answer — defaults to the 3-run fixture. */
  releaseRuns?: RunEventFixture[];
}

async function mountApp(opts: MountOpts = {}): Promise<void> {
  const focused = opts.focused !== false;
  const releaseRuns = opts.releaseRuns ?? THREE_RELEASE_RUNS;
  fetchLog = [];
  liveStream = null;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${KEY}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    fetchLog.push(url);
    if (/\/analytics\/velocity/.test(url)) return okResponse(VELOCITY_BODY);
    if (/\/analytics\/burndown/.test(url)) return okResponse(BURNDOWN_BODY);
    if (/\/analytics\/forecast/.test(url)) return okResponse(FORECAST_BODY);
    if (/\/release-proposals/.test(url)) {
      return focused
        ? okResponse({ ok: true, proposals: [PROPOSED], totalCount: 1 })
        : okResponse({ ok: true, proposals: [], totalCount: 0 });
    }
    if (/\/releases/.test(url)) return okResponse({ ok: true, releases: [] });
    if (/\/queue/.test(url)) return okResponse({ ok: true, entries: focused ? QUEUE : [] });
    if (/\/plans/.test(url)) return okResponse({ ok: true, plans: [] });
    // §S2's by-release anchor: `/api/v2/events?project=<key>&release=<label>`.
    // Checked BEFORE the plain events branch below, which would otherwise
    // also match (both paths start `/api/v2/events`).
    if (/\/api\/v2\/events/.test(url) && /[?&]release=/.test(url)) {
      return okResponse({ ok: true, events: releaseRuns });
    }
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: GENERAL_EVENTS });
    if (url.includes("/api/v2/projects")) {
      return okResponse({
        ok: true,
        projects: [
          { key: KEY, name: KEY, type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: Date.now() },
        ],
      });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/health")) return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    throw new Error(`roadmap-release-verified-runs-chip.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch; EventSource: unknown };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;
  scriptedGlobals.EventSource = class extends FakeEventSource {
    constructor() {
      super();
      liveStream = this;
    }
  };

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapVerifiedChip=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 10 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function releaseEventsCalls(log: string[]): string[] {
  return log.filter((u) => u.includes("/api/v2/events") && /[?&]release=/.test(u));
}

function chip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="roadmap-verified-chip"]');
}

function isActiveTab(name: string): boolean {
  const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).find(
    (t) => (t.textContent ?? "").trim() === name,
  );
  return tab !== undefined && /\bon\b/.test(tab.className);
}

async function clickBandChip(): Promise<void> {
  const el = chip();
  expect(el).not.toBeNull();
  el!.click();
  await settleDom({ ticks: 10 });
}

describe("CR-CRU-164 §S2/AC4 — the roadmap release band's verified-runs chip", () => {
  test("the band shows the exact verified-runs chip text for the focused release's run count", async () => {
    await mountApp({ releaseRuns: THREE_RELEASE_RUNS });
    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    const el = chip();
    expect(el).not.toBeNull();
    expect(text(el)).toBe("verified · 3 runs ↗");
  });

  test("the by-release read carries ?release= exactly once per load, the same single-flight the other analytics reads ride", async () => {
    await mountApp({ releaseRuns: THREE_RELEASE_RUNS });
    const calls = releaseEventsCalls(fetchLog);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(`project=${encodeURIComponent(KEY)}`);
    expect(calls[0]).toContain(`release=${encodeURIComponent(RELEASE)}`);
  });

  test("with zero runs filed under the focused release, the band reads the count but shows no verified chip", async () => {
    await mountApp({ releaseRuns: [] });
    const band = document.querySelector<HTMLElement>('[data-testid="roadmap-progress"]');
    expect(band).not.toBeNull();
    // The count is still answered (0 is a real, read answer, not an
    // unreachable route) — only the chip itself is withheld.
    expect(releaseEventsCalls(fetchLog).length).toBe(1);
    expect(chip()).toBeNull();
    expect(text(band).toLowerCase()).not.toContain("verified");
  });

  test("an events stream frame re-reads the verified-runs count, gated through the same refresh the other analytics reads ride", async () => {
    await mountApp({ releaseRuns: THREE_RELEASE_RUNS });
    expect(releaseEventsCalls(fetchLog).length).toBe(1);
    expect(liveStream).not.toBeNull();

    liveStream!.dispatch("events");
    await settleDom({ ticks: 12 });

    // Exactly one MORE read — never a burst, and never zero (a frame that
    // changed nothing observable about the count must still re-ask, the
    // same way CR-CRU-160's velocity/burndown/forecast reads do).
    expect(releaseEventsCalls(fetchLog).length).toBe(2);
  });

  test("clicking the chip stops the band's own click (never also opens the analytics pane), navigates to the Runs tab with ?release=<label>, and the Runs tab shows exactly that release's runs with a way back to the unfiltered list", async () => {
    await mountApp({ releaseRuns: THREE_RELEASE_RUNS });
    const callsBeforeClick = releaseEventsCalls(fetchLog).length;

    await clickBandChip();

    // The band's OWN onclick (openAnalytics) must not also have fired.
    expect(document.querySelector('[data-testid="analytics-pane"]')).toBeNull();
    expect(isActiveTab("Runs")).toBe(true);

    // Exactly one `release` query param, naming the exact label.
    const url = new URL(location.href);
    expect(url.searchParams.getAll("release")).toEqual([RELEASE]);

    // The Runs tab's own read fired (not merely a reuse of the band's
    // earlier answer) — the call count grew past what the initial load made.
    expect(releaseEventsCalls(fetchLog).length).toBeGreaterThan(callsBeforeClick);

    // Exactly the release's 3 runs render, never the 4th (unrelated) one
    // that the project's general feed also carries.
    const runsPane = document.querySelector<HTMLElement>('[data-testid="workspace-runs"]');
    expect(runsPane).not.toBeNull();
    const cardIds = Array.from(runsPane!.querySelectorAll<HTMLElement>('[data-testid="event-card"]')).map((el) =>
      el.getAttribute("data-run-id"),
    );
    expect(cardIds.sort()).toEqual(["vr-run-1", "vr-run-2", "vr-run-3"]);
    expect(cardIds).not.toContain("vr-other-1");

    // It says which release it is filtered to.
    const banner = runsPane!.querySelector<HTMLElement>('[data-testid="runs-release-filter"]');
    expect(banner).not.toBeNull();
    expect(text(banner).toLowerCase()).toContain("filtered");
    expect(text(banner)).toContain(RELEASE);

    // ...and a way back to the unfiltered list, which actually restores it.
    const clear = runsPane!.querySelector<HTMLElement>('[data-testid="runs-release-filter-clear"]');
    expect(clear).not.toBeNull();
    clear!.click();
    await settleDom({ ticks: 10 });

    expect(new URL(location.href).searchParams.has("release")).toBe(false);
    expect(document.querySelector('[data-testid="runs-release-filter"]')).toBeNull();
    const restoredIds = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-runs"] [data-testid="event-card"]'),
    ).map((el) => el.getAttribute("data-run-id"));
    expect(restoredIds.sort()).toEqual(["vr-other-1", "vr-run-1", "vr-run-2", "vr-run-3"]);
  });
});
