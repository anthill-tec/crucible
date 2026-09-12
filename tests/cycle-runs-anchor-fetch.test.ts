// CR-CRU-032 §S2/§S3 — anchor-fetch the beyond-window boundary on `→ Runs`
// click, and stop lying about dim state.
//
// RED phase: NONE of this exists yet against current production.
// `revealDeclaredMarker` (public/app.js ~2032) retries the declared-marker
// query ~30x on a real 5ms setTimeout (a real, un-mocked timer — total
// retry budget ~150ms) and then SILENTLY gives up if the marker never
// mounts. `CycleToRunsBadge` (~2053) gates `live` purely on
// `linkedRunsFor(cycleId).length > 0` — i.e. whether a run event for this
// cycle is ALREADY present in the loaded `state.events` window. Per
// `app-logic.mjs#timelineRows` (confirmed by reading, not assumed): a
// `declared-marker` row for a `done` cycle is ONLY emitted when the loop
// over `events` encounters at least one event whose `context.cycleId`
// matches that cycle — so a beyond-window boundary (present server-side,
// just not in the loaded 50) renders identically to a genuinely pruned one
// today: no marker, `live=false`, dim badge, silent no-op on click. That
// conflation is exactly what CR-CRU-032 §S2/§S3 fixes.
//
// §S1 (already GREEN, `tests/events-anchored.test.ts`) added
// `GET /api/v2/events?project=<key>&cycleId=<id>` -> `{ok, events, cycle?}`.
// This file assumes the client wires §S2 on top of that: when the retry
// budget is exhausted without finding the marker, issue that anchored
// fetch, merge its `events` into the Runs feed (which, per the
// `timelineRows` read above, is sufficient on its own for the marker to
// mount — the cycle's own `done` status is already known from
// `state.plans`), then `scrollIntoView` + blink. An anchor response with
// an EMPTY `events` array and NO `cycle` field is the server's "truly
// unknown/pruned" signal (mirrors `tests/events-anchored.test.ts`'s
// "unknown cycleId" case) — §S3 requires that case to surface explicit
// feedback, never a silent no-op.
//
// PINNED CONTRACT (underspecified by the CR/dispatch — flagging per RED
// convention, confirm with GREEN before merge):
//   - ESCALATION: the CR text does not pin a `data-testid` for the §S3
//     "explicit feedback" element. This file pins
//     `[data-testid="anchor-fetch-feedback"]` — a DOM node that appears
//     after a click resolves to a genuinely-pruned anchor response, whose
//     text content mentions "pruned" (the accurate reason). Not a toast
//     library, not the pre-existing `title` attribute (that was the OLD,
//     inaccurate, easy-to-miss channel this CR replaces) — a real element
//     asserted to exist in the DOM after the click settles.
//   - ESCALATION: §S3's "beyond-window -> pill LIVE" requirement is a
//     STATIC render decision — the badge is drawn before any fetch has
//     told the client whether a `done` cycle's boundary is beyond-window
//     or pruned. The only coherent reading: the `live` gate can no longer
//     require `linkedRunsFor(cycleId).length > 0` (that IS today's
//     conflation). Any `done`/`skipped`/`failed` cycle renders LIVE by
//     default (reachable via §S2) regardless of whether its runs are
//     loaded; a cycle only earns the dim/pruned state AFTER a click's
//     anchor-fetch comes back empty (a `pruned` fact this file does not
//     prescribe the storage mechanism for — only the observable render).
//     NOTE: this supersedes `tests/cycle-run-navigation.test.ts`'s
//     "pruned boundary (past retention)" §S1 test, which asserts a `done`
//     cycle with zero loaded events renders DIM/disabled with no click
//     effect — under CR-CRU-032 that exact fixture (no prior failed
//     anchor-fetch) must render LIVE. That existing test will need
//     updating in GREEN; out of this RED file's scope to touch it.
//
// Harness: same happy-dom + real `public/app.js`/`public/app-logic.mjs`
// pattern as `tests/cycle-run-navigation.test.ts` (reused near-verbatim),
// with a controllable anchor-fetch stub layered on top of the shared
// fetch mock.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
// CR-CRU-120 Integration AC / §S4 shape pin — the repo's ONE source-scanning
// walk (tests/helpers/source-scan.ts), reused rather than re-derived: a second
// hand-rolled comment/string stripper is the CR-CRU-096 defect shape.
import { balancedEnd, jsLiveCode, unnestedEnd } from "./helpers/source-scan";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

interface EventFixture {
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
  duration_ms?: number;
  hasCoverage?: boolean;
  context?: { cycleId?: number; wave?: string; cycle?: string };
}

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

// The §S1 anchored route's response shape (`tests/events-anchored.test.ts`):
// `events` always present; `cycle` present ONLY when the boundary resolves
// server-side (absent = truly unknown/pruned).
interface AnchorResponse {
  events: EventFixture[];
  cycle?: {
    id: number;
    label: string;
    kind: string;
    status: string;
    activatedAt?: number;
    doneAt?: number;
  };
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
  anchorResponse?: AnchorResponse;
  // CR-CRU-120 §S4 — a per-cycleId override of `anchorResponse`, so ONE
  // mounted session can drive MORE THAN ONE anchor verdict (an `empty`
  // cycle and a `pruned` cycle), which is exactly what §S4's third AC
  // requires in order to see the feedback text CHANGE.
  anchorResponses?: Record<number, AnchorResponse>;
}

let cacheBust = 0;
let anchorCalls: string[] = [];

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  anchorCalls = [];
  const anchorResponse: AnchorResponse = opts.anchorResponse ?? { events: [] };
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/events") && /[?&]cycleId=/.test(url)) {
      // §S2 — the anchored fetch under test. Recorded so tests can assert
      // exactly when/whether it fires and with what query params.
      anchorCalls.push(url);
      // CR-CRU-120 §S4 — resolve PER cycleId when the test named one, so a
      // session can answer cycle X "resolved but empty" and cycle Y "gone";
      // `anchorResponse` stays the default for every other cycle, leaving
      // every CR-CRU-032 fixture above byte-identical.
      const asked = Number(
        new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("cycleId"),
      );
      const resolved = opts.anchorResponses?.[asked] ?? anchorResponse;
      body = {
        ok: true,
        events: resolved.events,
        ...(resolved.cycle !== undefined ? { cycle: resolved.cycle } : {}),
      };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`cycle-runs-anchor-fetch.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?cycleRunsAnchorFetch=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

// `revealDeclaredMarker` retries on a REAL (un-mocked) 5ms setTimeout up to
// 30x (public/app.js ~2032-2044) — a total real-time budget of ~150ms —
// before today's silent give-up (which §S2 replaces with the anchor
// fetch). Real timers, generously padded; never faked here.
async function waitForRetryBudget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

function runEvent(
  overrides: Partial<EventFixture> & Pick<EventFixture, "id" | "projectKey" | "agentId" | "timestamp">,
): EventFixture {
  return {
    kind: "test",
    tier: "unit",
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
    ...overrides,
  };
}

async function clickTab(name: string): Promise<HTMLElement> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
  return tab!;
}

async function openWorkflowTab(): Promise<void> {
  await clickTab("Workflow");
}

function activeSection(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-active"]');
  expect(el).not.toBeNull();
  return el!;
}

function isActiveTab(name: string): boolean {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  return tab !== undefined && /\bon\b/.test(tab.className);
}

function patchScrollIntoView(): { calls: HTMLElement[]; restore: () => void } {
  const calls: HTMLElement[] = [];
  const original = (
    HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }
  ).scrollIntoView;
  (HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void }).scrollIntoView =
    function (this: HTMLElement) {
      calls.push(this);
    };
  return {
    calls,
    restore: () => {
      (HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void }).scrollIntoView =
        original;
    },
  };
}

function doneCycleRow(): HTMLElement {
  const row = activeSection().querySelector<HTMLElement>(
    '[data-testid="cycle-row"][data-status="done"]',
  );
  expect(row).not.toBeNull();
  return row!;
}

function findAnchorCall(key: string, cycleId: number): string | undefined {
  return anchorCalls.find((url) => {
    const qs = url.slice(url.indexOf("?") + 1);
    const params = new URLSearchParams(qs);
    return params.get("project") === key && params.get("cycleId") === String(cycleId);
  });
}

// Shared dim/disabled check (same channel AC3 already asserts against —
// `disabled` attribute, `aria-disabled="true"`, or a disabled/dim class).
// AC5 (§S3, VERIFY finding 1B) reuses this to assert the cycle-to-runs
// PILL ITSELF (not just the separate anchor-fetch-feedback text) flips
// dim after a confirmed-pruned anchor-fetch, and stays dim.
function isBadgeDisabled(badge: HTMLElement): boolean {
  return (
    badge.hasAttribute("disabled") ||
    badge.getAttribute("aria-disabled") === "true" ||
    /disabled|dim/i.test(badge.className)
  );
}

// ── AC1 (§S2) — beyond-window boundary: anchor-fetch, merge, mount, blink ──

describe("§S2 cycle-to-runs anchor-fetch — beyond-window boundary reached", () => {
  test("clicking cycle-to-runs for a cycle whose marker is NOT in the loaded feed anchor-fetches ?project=<key>&cycleId=<id>, merges the returned events so the declared-marker mounts, scrolls it into view, and blinks it — no silent give-up", async () => {
    const key = "cr032-anchor-merge-1";
    const cycleId = 8001;
    const now = Date.now();
    const boundaryRun = runEvent({
      id: "evt-anchor-merge-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9101,
      cr: "CR-032-ANCHOR-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "beyond-window cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR032 Anchor Merge" })],
      // The loaded feed is EMPTY — this cycle's boundary is NOT in the
      // window; only the anchor-fetch response supplies it.
      events: [],
      plans: [plan],
      anchorResponse: {
        events: [boundaryRun],
        cycle: {
          id: cycleId,
          label: "beyond-window cycle",
          kind: "red-green",
          status: "done",
          activatedAt: now - 1000,
          doneAt: now,
        },
      },
    });
    await openWorkflowTab();

    const row = doneCycleRow();
    const badge = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();

    // No marker anywhere before the click — proves the anchor-fetch (not a
    // pre-existing element) is what mounts it.
    expect(
      document.querySelector(`[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`),
    ).toBeNull();

    const scroll = patchScrollIntoView();
    try {
      badge!.click();
      await waitForRetryBudget();
      await settle();

      // The anchor-fetch fired with the exact §S1 contract params.
      const call = findAnchorCall(key, cycleId);
      expect(call).toBeDefined();

      // The returned events were merged so the marker now mounts.
      const marker = document.querySelector<HTMLElement>(
        `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
      );
      expect(marker).not.toBeNull();

      // scrollIntoView + locate-blink — no silent give-up.
      expect(scroll.calls).toContain(marker!);
      expect(marker!.classList.contains("app-locate-blink")).toBe(true);

      // Negative assertion (VERIFY finding 1B / §S3 guard): a SUCCESSFUL
      // anchor-fetch (boundary reached, marker mounted) must NEVER dim or
      // disable the cycle-to-runs pill — only a CONFIRMED-PRUNED
      // anchor-fetch may do that (see the new AC5 test below). Re-query the
      // badge from the DOM since it may have re-rendered after the fetch.
      const badgeAfterReach = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
      expect(badgeAfterReach).not.toBeNull();
      expect(isBadgeDisabled(badgeAfterReach!)).toBe(false);
    } finally {
      scroll.restore();
    }
  });
});

// ── AC2 (§S3) — genuinely pruned: explicit feedback, never a silent no-op ──

describe("§S3 cycle-to-runs anchor-fetch — genuinely pruned boundary", () => {
  test("clicking cycle-to-runs whose anchor-fetch resolves with an EMPTY events array and NO cycle field (server confirms the boundary is truly gone) shows explicit accurate feedback — never a bare tab-switch-and-nothing", async () => {
    const key = "cr032-anchor-pruned-1";
    const cycleId = 8002;
    const plan: PlanFixture = {
      planId: 9102,
      cr: "CR-032-ANCHOR-PRUNED-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "truly pruned cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR032 Anchor Pruned" })],
      events: [],
      plans: [plan],
      // Server's "truly unknown/pruned" signal (mirrors
      // tests/events-anchored.test.ts's "unknown cycleId" case): empty
      // events, no `cycle` field at all.
      anchorResponse: { events: [] },
    });
    await openWorkflowTab();

    const row = doneCycleRow();
    const badge = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();

    // No feedback element before the click.
    expect(document.querySelector('[data-testid="anchor-fetch-feedback"]')).toBeNull();

    badge!.click();
    await waitForRetryBudget();
    await settle();

    // The anchor-fetch fired (this is how the client LEARNS it's pruned —
    // it cannot know that upfront).
    expect(findAnchorCall(key, cycleId)).toBeDefined();

    // No marker was fabricated — there is nothing to scroll to.
    expect(
      document.querySelector(`[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`),
    ).toBeNull();

    // Explicit, accurate feedback — never a silent no-op.
    const feedback = document.querySelector<HTMLElement>('[data-testid="anchor-fetch-feedback"]');
    expect(feedback).not.toBeNull();
    expect((feedback!.textContent ?? "")).toMatch(/pruned/i);
  });
});

// ── AC3 (§S3) — beyond-window renders LIVE even though runs aren't loaded ──

describe("§S3 cycle-to-runs render — beyond-window stays LIVE (honest dim state)", () => {
  test("a completed cycle whose runs are NOT in the loaded feed renders cycle-to-runs LIVE/clickable (not the disabled/dim class) — reachability, not local-window presence, decides live vs dim", async () => {
    const key = "cr032-render-live-1";
    const cycleId = 8003;
    const plan: PlanFixture = {
      planId: 9103,
      cr: "CR-032-RENDER-LIVE-1",
      projectKey: key,
      status: "open",
      // Deliberately NO event anywhere references context.cycleId === 8003
      // — the SAME fixture shape as the OLD (now-superseded) CR-025 "pruned
      // boundary" test. Under CR-CRU-032, without a prior FAILED
      // anchor-fetch telling the client this boundary is truly gone, the
      // cycle must render LIVE — it may simply be beyond the loaded window.
      cycles: [{ id: cycleId, label: "reachable cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR032 Render Live" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = doneCycleRow();
    const badge = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();

    const isDisabled =
      badge!.hasAttribute("disabled") ||
      badge!.getAttribute("aria-disabled") === "true" ||
      /disabled|dim/i.test(badge!.className);
    expect(isDisabled).toBe(false);

    // The accurate-reason requirement: no premature "pruned" wording before
    // the client has ever confirmed pruning via an anchor-fetch.
    expect(badge!.getAttribute("title") ?? "").not.toMatch(/pruned/i);
  });
});

// ── AC4 (CR-025 regression) — in-window happy path fires NO extra fetch ────

describe("§S2 cycle-to-runs anchor-fetch — in-window happy path unchanged", () => {
  test("when the declared marker IS already in the loaded feed, clicking cycle-to-runs does NOT fire the §S1 anchor-fetch (byte-unchanged CR-025 behavior)", async () => {
    const key = "cr032-anchor-inwindow-1";
    const cycleId = 8004;
    const now = Date.now();
    const linkedRun = runEvent({
      id: "evt-anchor-inwindow-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9104,
      cr: "CR-032-ANCHOR-INWINDOW-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "already-loaded cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR032 Anchor In-window" })],
      // The linked run IS already in the loaded feed — the marker mounts
      // at initial render, no anchor-fetch should ever be needed.
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const row = doneCycleRow();
    const badge = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badge).not.toBeNull();

    const scroll = patchScrollIntoView();
    try {
      badge!.click();
      await settle();

      // Landed on Runs, found the marker, scrolled + blinked — the CR-025
      // baseline, unchanged.
      expect(isActiveTab("Runs")).toBe(true);
      const marker = document.querySelector<HTMLElement>(
        `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`,
      );
      expect(marker).not.toBeNull();
      expect(scroll.calls).toContain(marker!);

      // The critical negative assertion: the §S2 anchor-fetch was NEVER
      // called — the in-window path has no reason to reach the network.
      expect(anchorCalls.length).toBe(0);
    } finally {
      scroll.restore();
    }
  });
});

// ── AC5 (§S3) — genuinely-pruned pill DIMS after the confirming anchor-fetch ──
//
// VERIFY (ruling 1B): §S3's literal requirement is *"server confirms
// [boundary] gone → dim, accurate 'pruned' reason"* for the pill itself
// (CR-CRU-032-runs-boundary-anchor-fetch.md §S3 lines 36-37, AC line 61).
// AC2 already covers the SEPARATE `anchor-fetch-feedback` text node. This
// test is about the `cycle-to-runs` PILL'S OWN live/dim state, which
// `CycleToRunsBadge` (public/app.js:2172) currently ignores entirely — it
// hardcodes `live = cycleId !== undefined && cycleId !== null` and never
// reads `state.anchorFeedback` (set at app.js:2157 on a confirmed-pruned
// anchor response). Today this pill NEVER dims after the click, no matter
// how many times a confirmed-pruned anchor-fetch resolves — this test
// pins the FIX contract that it must.
describe("§S3 cycle-to-runs pill — genuinely-pruned pill DIMS after the confirming anchor-fetch", () => {
  test("a confirmed-pruned anchor-fetch (empty events, no cycle field) dims the SAME cycle-to-runs pill with an accurate 'pruned' reason, and the dim state persists across a later render", async () => {
    const key = "cr032-pill-dims-1";
    const cycleId = 8005;
    const plan: PlanFixture = {
      planId: 9105,
      cr: "CR-032-PILL-DIMS-1",
      projectKey: key,
      status: "open",
      // Same key/cycle pattern as AC2's "genuinely pruned" fixture — a
      // `done` cycle whose boundary is truly gone server-side.
      cycles: [{ id: cycleId, label: "genuinely pruned cycle", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR032 Pill Dims" })],
      events: [],
      plans: [plan],
      // Server's "truly unknown/pruned" signal (mirrors AC2 and
      // tests/events-anchored.test.ts's "unknown cycleId" case): empty
      // events, no `cycle` field at all.
      anchorResponse: { events: [] },
    });
    await openWorkflowTab();

    const row = doneCycleRow();
    const badgeBefore = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badgeBefore).not.toBeNull();

    // 1. BEFORE the click: pruning cannot be known upfront (mirrors AC3) —
    // the pill is LIVE, not dim. The FIX must not dim everything by
    // default; only a CONFIRMED-pruned click may earn the dim state.
    expect(isBadgeDisabled(badgeBefore!)).toBe(false);

    badgeBefore!.click();
    await waitForRetryBudget();
    await settle();

    // The anchor-fetch fired and confirmed pruning (same trigger as AC2).
    expect(findAnchorCall(key, cycleId)).toBeDefined();

    // 2. AFTER the confirming anchor-fetch: the SAME pill (re-queried from
    // the DOM — VanJS may have re-rendered it) now renders DIM/disabled,
    // via aria-disabled="true" or a dim/pruned class (the same channel
    // AC3's isDisabled check accepts), with an accurate accessible
    // "pruned" reason surfaced on its title or aria-label.
    const badgeAfter = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badgeAfter).not.toBeNull();
    expect(isBadgeDisabled(badgeAfter!)).toBe(true);
    const accessibleReason =
      (badgeAfter!.getAttribute("title") ?? "") + " " + (badgeAfter!.getAttribute("aria-label") ?? "");
    expect(accessibleReason).toMatch(/pruned/i);

    // 3. PERSISTENCE: after another settle (a later render pass), the SAME
    // pill (re-queried again) is STILL dim — proving a stored per-cycle
    // verdict, not a one-frame flash tied to transient click-handler state.
    await settle();
    const badgeStill = row.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badgeStill).not.toBeNull();
    expect(isBadgeDisabled(badgeStill!)).toBe(true);
  });
});

// ── AC6 (§S3, verify-fix round 1B) — the DURABLE `state.prunedCycles` store
// dims a FRESHLY-RENDERED pill, not just the exact node the user clicked ──
//
// §S3's dim has TWO mechanisms in production (public/app.js):
//   (a) `reflectPrunedPill(pillEl)` (~2121) — imperative, mutates the EXACT
//       node passed through from the click handler (`ev.currentTarget`),
//       even after the tab swap has detached it from the live tree.
//   (b) the durable reactive store `state.prunedCycles` (~2193-2194,
//       `vanX.replace`) — read fresh inside `CycleToRunsBadge` (~2229) every
//       time that function is INVOKED, i.e. every fresh render/re-mount of
//       the Workflow pane.
//
// AC5 above asserts on `row.querySelector(...)` re-queried from a `row`
// captured BEFORE the click, but it never leaves the Runs tab afterward — so
// the Workflow pane (and its `cycle-to-runs` pill) is never torn down and
// re-mounted during that test. AC5 never forces a NEW render of the pill
// through a full tab-away-and-back cycle, so it cannot distinguish "(a)
// alone" from "(a) and/or (b)". If (b) were silently broken (e.g. the
// `vanX.replace(state.prunedCycles, ...)` call were missing or
// `CycleToRunsBadge` never read `state.prunedCycles`), AC5 could still pass
// via (a) alone while real UX — leave the Workflow tab, come back, the pill
// should still show pruned — would be broken. This test forces exactly that
// round-trip and asserts on a NEW node VanJS mounts, never the one captured
// pre-click.
describe("§S3 cycle-to-runs pill — durable prunedCycles store dims a freshly re-rendered pill (not just the clicked node)", () => {
  test("after a confirmed-pruned anchor-fetch, leaving and returning to the Workflow tab re-mounts a BRAND-NEW cycle-to-runs pill that is ALSO dim with an accurate 'pruned' reason — proving the durable state.prunedCycles store, not merely the imperative reflect on the originally-clicked node", async () => {
    const key = "cr032-pill-dims-durable-1";
    const cycleId = 8006;
    const plan: PlanFixture = {
      planId: 9106,
      cr: "CR-032-PILL-DIMS-DURABLE-1",
      projectKey: key,
      status: "open",
      // Same "genuinely pruned" fixture shape as AC2/AC5: a `done` cycle
      // whose boundary is truly gone server-side.
      cycles: [{ id: cycleId, label: "genuinely pruned cycle (durable)", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR032 Pill Dims Durable" })],
      events: [],
      plans: [plan],
      // Server's "truly unknown/pruned" signal: empty events, no `cycle`
      // field at all (mirrors AC2/AC5 and tests/events-anchored.test.ts's
      // "unknown cycleId" case).
      anchorResponse: { events: [] },
    });
    await openWorkflowTab();

    const rowBefore = doneCycleRow();
    const badgeBefore = rowBefore.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badgeBefore).not.toBeNull();

    // Before the click: pruning cannot be known upfront — LIVE, not dim.
    expect(isBadgeDisabled(badgeBefore!)).toBe(false);

    // Click -> anchor-fetch confirms pruned -> the one-rule tab swap to Runs
    // fires (app.js ~2247). The Workflow pane's `() => WorkspaceBody()`
    // reactive child (app.js ~2812) now renders `WorkspaceRuns()` instead —
    // `badgeBefore`'s node is detached from the live document tree.
    badgeBefore!.click();
    await waitForRetryBudget();
    await settle();

    // Sanity: the anchor-fetch genuinely fired and confirmed pruned, and we
    // did land on Runs (mirrors AC2/AC5's setup).
    expect(findAnchorCall(key, cycleId)).toBeDefined();
    expect(isActiveTab("Runs")).toBe(true);
    expect(document.body.contains(badgeBefore!)).toBe(false);

    // Force a FRESH render of the pill: click the Workflow tab again. This
    // re-mounts the Workflow pane from scratch, re-invoking
    // `CycleToRunsBadge(cycleId)` and producing a BRAND-NEW `span` node —
    // `reflectPrunedPill` NEVER touched this node; it only ever mutated
    // `badgeBefore`, which is now unreachable from the document.
    await openWorkflowTab();

    const rowAfter = doneCycleRow();
    const badgeAfter = rowAfter.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    expect(badgeAfter).not.toBeNull();

    // Proves this is genuinely a NEW node, not the one the reflect touched —
    // the dim below can ONLY be explained by the durable
    // `state.prunedCycles` store being read at render time.
    expect(badgeAfter).not.toBe(badgeBefore);
    expect(document.body.contains(badgeAfter!)).toBe(true);

    expect(isBadgeDisabled(badgeAfter!)).toBe(true);
    const accessibleReason =
      (badgeAfter!.getAttribute("title") ?? "") + " " + (badgeAfter!.getAttribute("aria-label") ?? "");
    expect(accessibleReason).toMatch(/pruned/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// CR-CRU-120 — an ACTIVE cycle's runs are not reachable
//
// The SAME machinery CR-CRU-032 proved above, widened to the one cycle status
// it was never asked to cover. Nothing new is invented: §S2 widens which
// cycles are OFFERED the `→ Runs` affordance, §S1 makes the active cycle's own
// boundary row (`cycle-span-open`, public/app.js:1064 — emitted by
// `timelineRows` for `cycle.status === "active"` exactly as `declared-marker`
// is for `done`) queryable by cycle id, §S3 teaches the reveal to accept that
// second boundary kind, and §S4 stops the "cycle resolves server-side but has
// genuinely zero runs" anchor response from being a silent no-op — a branch
// §S2 turns from rare into routine, since a cycle that just activated has zero
// runs by construction.
//
// RED against today's production (read, not assumed, 2026-09-12):
//   - `CycleSpanOpenRow` (app.js:1064-1068) renders NO `data-cycle-id`.
//   - `CycleToRunsBadge` renders only where `cycleIsCompleted(cycle)`
//     (app.js:4134-4135) holds — app.js:4185 (`CycleRow`, the Active-workflow
//     panel) and app.js:4411 (`LensCycleRow`, Workflow History) — so an ACTIVE
//     cycle carries no affordance at all.
//   - `revealDeclaredMarker` (app.js:3939-3958) queries ONLY
//     `[data-testid="declared-marker"][data-cycle-id]`.
//   - `anchorFetchRuns` (app.js:3966-4003) writes a BARE cycleId into
//     `state.anchorFeedback`, and falls through in silence when the fetch
//     resolves the cycle (`body.cycle` present) but returns zero events.
//
// PINNED CONTRACT (spec-underspecified — flagged per this file's own RED
// convention; confirm with GREEN before merge):
//   - ESCALATION: §S1's AC says "asserted against a real cycle activated via
//     `cycle-activate`". A DOM-level test has no board behind it; the fixture's
//     `status: "active"` cycle IS the shape the plans route returns after
//     `cycle-activate`, and the REAL transition verb is driven by this CR's §S5
//     test in tests/events-anchored.test.ts. Flagging the substitution rather
//     than making it silently.
//   - ESCALATION: §S4 does not pin the `empty` message's wording. Pinned here
//     as its observable discriminators ONLY: it names that no runs have been
//     recorded (/no runs/i), it NEVER says "pruned", and it differs from the
//     verbatim pruned sentence. Any wording meeting that passes.
//   - ESCALATION: §S4's `state.anchorFeedback` shape (`{cycleId, kind}`) is
//     CLOSURE-PRIVATE — public/app.js is an IIFE that exports nothing and
//     installs no test hook (verified: it carries no `window.`/`globalThis.`
//     assignment at all), so no DOM test can read that slot directly. It is
//     pinned BEHAVIOURALLY (both kinds driven in ONE session; the rendered text
//     must differ) and STRUCTURALLY over `jsLiveCode(public/app.js)`, the
//     repo's existing source-scan guard convention. If GREEN names the
//     discriminator something other than `kind`, the structural pin moves with
//     it — the behavioural tests do not.
//   - ESCALATION: the Integration AC asks for "a single exported/shared boolean
//     function". public/app.js is EVAL'd, not imported: it exports nothing and
//     cannot without restructuring the whole file (an explicit CR non-goal).
//     Pinned as the achievable equivalent of the SAME anti-drift property: ONE
//     named predicate, defined exactly once, called IDENTICALLY at both
//     `CycleToRunsBadge` call sites, with neither site inlining a status
//     comparison of its own.
//   - ESCALATION: §S2's AC assumes ONE plan can be asserted at BOTH call sites.
//     It cannot — see the note on `activePendingPlan` below, where the reading
//     this file adopts is spelled out against the code that forces it.
//   - NOTED, not asserted (no AC covers it, so no test here invents one): the
//     History tree also renders INFERRED cycles, which carry NO id, and
//     `workflowLens` gives an inferred cycle the status `active` whenever its
//     latest run failed (public/app-logic.mjs:903). Widening the predicate to
//     `active` therefore hands `CycleToRunsBadge(undefined)` a second class of
//     id-less rows, which render a pill whose own `live` gate is false — a
//     pill that does nothing. This is PRE-EXISTING, not introduced here (an
//     inferred `done` cycle already reaches the same dead pill under CR-CRU-025),
//     but §S2 doubles the surface it shows on. Worth a GREEN decision.

// The CR-CRU-032 §S3 pruned sentence, verbatim (public/app.js:2033) — §S4's
// second AC is a regression pin on this exact wording.
const PRUNED_FEEDBACK_TEXT =
  "This cycle's Runs boundary has been pruned from the retained timeline — nothing to jump to.";

function activeCycleRow(): HTMLElement {
  const row = activeSection().querySelector<HTMLElement>(
    '[data-testid="cycle-row"][data-status="active"]',
  );
  expect(row).not.toBeNull();
  return row!;
}

function badgeIn(scope: HTMLElement): HTMLElement | null {
  return scope.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
}

function badgeCount(scope: HTMLElement): number {
  return scope.querySelectorAll('[data-testid="cycle-to-runs"]').length;
}

function rowByCycleId(scope: HTMLElement, testid: string, cycleId: number): HTMLElement {
  const row = scope.querySelector<HTMLElement>(
    `[data-testid="${testid}"][data-cycle-id="${cycleId}"]`,
  );
  expect(row).not.toBeNull();
  return row!;
}

// The History tree's CR groups are collapsed by default (CR-CRU-020 §S1.2) —
// expand the one under test, exactly as tests/cycle-run-navigation.test.ts's
// own history case does.
async function expandedCrGroup(cr: string): Promise<HTMLElement> {
  const hist = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(hist).not.toBeNull();
  const group = Array.from(
    hist!.querySelectorAll<HTMLElement>('[data-testid="cr-group"]'),
  ).find((g) => g.getAttribute("data-cr") === cr);
  expect(group).toBeDefined();
  const toggle = group!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
  expect(toggle).not.toBeNull();
  toggle!.click();
  await settle();
  return group!;
}

function spanOpenFor(cycleId: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="cycle-span-open"][data-cycle-id="${cycleId}"]`,
  );
}

function anchorFeedbackText(): string | null {
  const fb = document.querySelector<HTMLElement>('[data-testid="anchor-fetch-feedback"]');
  return fb === null ? null : (fb.textContent ?? "").trim();
}

// One plan, one ACTIVE cycle and one PENDING cycle — the §S2 fixture, shared by
// both call-site tests so the two surfaces are driven from identical CYCLE
// data and only the PLAN's own status differs between them.
//
// ESCALATION (found by running, not by reading): §S2's AC asks for ONE plan
// whose active cycle's row is asserted "both in `CycleRow`/Active-workflow
// panel and `LensCycleRow`/Workflow History". No single plan can satisfy that.
// `workflowLens` (public/app-logic.mjs:930-933, CR-CRU-020 §S1.3) filters
// `c.status !== "open"` — "the history lens is closed-plans-only: an OPEN
// plan's CR node renders solely in the ACTIVE view" — while the Active panel
// renders ONLY open plans (public/app.js:4218). So an open plan reaches the
// first call site and never the second, and a closed plan the reverse. The
// two call sites are therefore driven here by the same cycles under the two
// plan statuses that can actually reach them: the ACTIVE panel with the plan
// OPEN, and History with the plan CLOSED (a plan closed while one of its
// cycles is still `active` — the case `LensCycleRow`'s own `expandable`
// predicate, public/app.js:4375, already contemplates). Confirm with GREEN;
// this substitution is the only reading under which BOTH surfaces can be
// asserted at all, and it does not weaken the AC: both `CycleToRunsBadge`
// call sites are still driven, each through the surface that reaches it.
function activePendingPlan(
  key: string,
  activeId: number,
  pendingId: number,
  status: "open" | "closed",
): PlanFixture {
  return {
    planId: 9202,
    cr: "CR-120-BADGE-SITES",
    projectKey: key,
    status,
    wave: "6",
    ...(status === "closed" ? { merge: { commit: "cr120bad" } } : {}),
    cycles: [
      { id: activeId, label: "the active cycle", kind: "red-green", status: "active" },
      { id: pendingId, label: "the pending cycle", kind: "verify", status: "pending" },
    ],
  };
}

// ── §S1 — the ACTIVE cycle's boundary row is queryable by cycle id ─────────

describe("CR-CRU-120 §S1 — an ACTIVE cycle's Runs-timeline boundary carries its cycle id", () => {
  test("the cycle-span-open row rendered for an ACTIVE cycle carries data-cycle-id equal to that cycle's numeric id, and its rendered text is unchanged (purely additive, mirroring declared-marker)", async () => {
    const key = "cr120-span-open-attr";
    const cycleId = 8101;
    const now = Date.now();
    const linkedRun = runEvent({
      id: "evt-cr120-span-open-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9201,
      cr: "CR-120-SPAN-OPEN",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "the active cycle", kind: "red-green", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Span Open" })],
      // The linked run IS loaded, so `timelineRows` emits the open-span row
      // on the first render — this test is about the row's ATTRIBUTE, not
      // about how it comes to mount (that is §S3's subject).
      events: [linkedRun],
      plans: [plan],
    });
    await clickTab("Runs");

    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="cycle-span-open"]'),
    );
    // Exactly ONE open-span row — a bound, so a fix that made the row render
    // unconditionally (CR-CRU-011 §S6 #3's no-container-when-empty rule is an
    // explicit non-goal of this CR) fails here rather than passing bigger.
    expect(rows.length).toBe(1);
    expect(rows[0]!.getAttribute("data-cycle-id")).toBe(String(cycleId));
    // Purely additive: the row's rendered content is byte-unchanged.
    expect((rows[0]!.textContent ?? "").trim()).toBe(
      "⟲ Cycle · the active cycle · CR-120-SPAN-OPEN · active",
    );
  });
});

// ── §S2 — the recovery badge covers an ACTIVE cycle at BOTH call sites ─────

describe("CR-CRU-120 §S2 — the → Runs badge covers an ACTIVE cycle at both call sites", () => {
  test("the Active-workflow panel (CycleRow) renders cycle-to-runs on the ACTIVE cycle's row and NONE on the pending cycle's row", async () => {
    const key = "cr120-badge-active-panel";
    const activeId = 8201;
    const pendingId = 8202;

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Badge Active Panel" })],
      events: [],
      plans: [activePendingPlan(key, activeId, pendingId, "open")],
    });
    await openWorkflowTab();

    const panel = activeSection();
    const active = activeCycleRow();
    expect(active.getAttribute("data-cycle-id")).toBe(String(activeId));
    const pending = rowByCycleId(panel, "cycle-row", pendingId);
    expect(pending.getAttribute("data-status")).toBe("pending");

    expect(badgeIn(active)).not.toBeNull();
    // A `pending` cycle was never activated and so has zero runs BY
    // CONSTRUCTION: the affordance exists only where runs could plausibly be.
    expect(badgeIn(pending)).toBeNull();
    // …and nowhere else in the panel: exactly ONE badge across the two rows,
    // so a fix that simply rendered the badge for every status fails.
    expect(badgeCount(panel)).toBe(1);
  });

  test("the Workflow History tree (LensCycleRow) renders cycle-to-runs on an ACTIVE cycle's row and NONE on the pending one — the SAME cycles, through the second call site", async () => {
    const key = "cr120-badge-history";
    const activeId = 8211;
    const pendingId = 8212;

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Badge History" })],
      events: [],
      // CLOSED — the only plan status whose cycles reach `LensCycleRow` at
      // all (see the ESCALATION on `activePendingPlan` above).
      plans: [activePendingPlan(key, activeId, pendingId, "closed")],
    });
    await openWorkflowTab();

    const group = await expandedCrGroup("CR-120-BADGE-SITES");
    // Non-vacuity: BOTH cycles really rendered in the history tree, so the
    // "pending has no badge" claim below is about a row that exists.
    expect(group.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(2);

    const active = rowByCycleId(group, "lens-cycle-row", activeId);
    const pending = rowByCycleId(group, "lens-cycle-row", pendingId);
    expect(active.getAttribute("data-status")).toBe("active");
    expect(pending.getAttribute("data-status")).toBe("pending");

    expect(badgeIn(active)).not.toBeNull();
    expect(badgeIn(pending)).toBeNull();
    expect(badgeCount(group)).toBe(1);

    // §S0 (CR-CRU-025) — the badge stays a SEPARATE node from the row's own
    // drill-down toggle; widening the predicate never rebinds that glyph.
    const toggle = active.querySelector<HTMLElement>('[data-testid="cycle-toggle"]');
    expect(toggle).not.toBeNull();
    expect(badgeIn(active)).not.toBe(toggle);
  });
});

describe("CR-CRU-120 §S2 — completed cycles keep their badge (regression pin on the cycleIsCompleted branch)", () => {
  test("done, skipped and failed cycle rows each STILL render cycle-to-runs, and the pending row still renders none — the widening is additive, not a replacement", async () => {
    const key = "cr120-completed-pin";
    const plan: PlanFixture = {
      planId: 9203,
      cr: "CR-120-COMPLETED-PIN",
      projectKey: key,
      status: "open",
      wave: "6",
      cycles: [
        { id: 8301, label: "done cycle", kind: "red-green", status: "done" },
        { id: 8302, label: "skipped cycle", kind: "verify", status: "skipped" },
        { id: 8303, label: "failed cycle", kind: "fix", status: "failed" },
        { id: 8304, label: "pending cycle", kind: "red-green", status: "pending" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Completed Pin" })],
      events: [],
      plans: [plan],
    });
    await openWorkflowTab();

    const panel = activeSection();
    for (const id of [8301, 8302, 8303]) {
      expect(badgeIn(rowByCycleId(panel, "cycle-row", id))).not.toBeNull();
    }
    expect(badgeIn(rowByCycleId(panel, "cycle-row", 8304))).toBeNull();
    expect(badgeCount(panel)).toBe(3);
  });
});

// ── §S3 — the reveal recognises the ACTIVE cycle's own boundary ────────────

describe("CR-CRU-120 §S3 — clicking an ACTIVE cycle's badge reaches its beyond-window boundary", () => {
  test("an ACTIVE cycle whose linked run is NOT in the loaded feed: clicking cycle-to-runs anchor-fetches ONCE, merges the returned run so cycle-span-open mounts, scrolls it into view and blinks it — the identical CR-CRU-032 path, driven through the real click handler", async () => {
    const key = "cr120-active-beyond-window";
    const cycleId = 8401;
    const now = Date.now();
    const boundaryRun = runEvent({
      id: "evt-cr120-beyond-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9204,
      cr: "CR-120-BEYOND-WINDOW",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "the active cycle", kind: "red-green", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Beyond Window" })],
      // The loaded feed is EMPTY — this active cycle's run is outside the
      // retention window (or the 5s poll simply has not caught up). Only the
      // anchor-fetch can supply it.
      events: [],
      plans: [plan],
      anchorResponse: {
        events: [boundaryRun],
        cycle: {
          id: cycleId,
          label: "the active cycle",
          kind: "red-green",
          status: "active",
          activatedAt: now - 5000,
        },
      },
    });
    await openWorkflowTab();

    const badge = badgeIn(activeCycleRow());
    expect(badge).not.toBeNull();

    // Nothing to jump to before the click — proves the anchor-fetch, not a
    // pre-existing element, is what mounts the boundary.
    expect(spanOpenFor(cycleId)).toBeNull();

    const scroll = patchScrollIntoView();
    try {
      badge!.click();
      await waitForRetryBudget();
      await settle();

      expect(findAnchorCall(key, cycleId)).toBeDefined();
      // The single-anchor-fetch guard behaves exactly as on the completed
      // path: at most ONE fetch per click, never a retry loop.
      expect(anchorCalls.length).toBe(1);
      expect(isActiveTab("Runs")).toBe(true);

      const span = spanOpenFor(cycleId);
      expect(span).not.toBeNull();
      expect(scroll.calls).toContain(span!);
      expect(span!.classList.contains("app-locate-blink")).toBe(true);

      // Negative: an ACTIVE cycle's boundary IS the open span — no "Cycle
      // done" marker may be fabricated for a cycle that has not closed.
      expect(
        document.querySelector(`[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`),
      ).toBeNull();
      // Negative: a boundary that was REACHED is neither pruned nor empty —
      // no feedback of any kind is surfaced.
      expect(anchorFeedbackText()).toBeNull();
    } finally {
      scroll.restore();
    }
  });

  test("when the ACTIVE cycle's run is ALREADY loaded, clicking cycle-to-runs reveals the open span with ZERO anchor fetches — still zero after the whole retry budget has elapsed", async () => {
    const key = "cr120-active-in-window";
    const cycleId = 8501;
    const now = Date.now();
    const linkedRun = runEvent({
      id: "evt-cr120-in-window-1",
      projectKey: key,
      agentId: "agent-a",
      timestamp: now,
      context: { cycleId },
    });
    const plan: PlanFixture = {
      planId: 9205,
      cr: "CR-120-IN-WINDOW",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "the active cycle", kind: "red-green", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 In Window" })],
      events: [linkedRun],
      plans: [plan],
    });
    await openWorkflowTab();

    const badge = badgeIn(activeCycleRow());
    expect(badge).not.toBeNull();

    const scroll = patchScrollIntoView();
    try {
      badge!.click();
      await settle();
      // Wait out the FULL retry budget so "no fetch" is a real claim rather
      // than a race the assertion happened to win.
      await waitForRetryBudget();
      await settle();

      expect(isActiveTab("Runs")).toBe(true);
      const span = spanOpenFor(cycleId);
      expect(span).not.toBeNull();
      expect(scroll.calls).toContain(span!);
      expect(span!.classList.contains("app-locate-blink")).toBe(true);

      // The in-window path has no reason to reach the network at all.
      expect(anchorCalls.length).toBe(0);
      expect(anchorFeedbackText()).toBeNull();
    } finally {
      scroll.restore();
    }
  });
});

// ── §S4 — an honestly empty cycle is not a pruned one ──────────────────────

describe("CR-CRU-120 §S4 — a cycle that genuinely has zero runs gets honest feedback, not silence", () => {
  test("an ACTIVE cycle the server RESOLVES but which has ingested no runs yet: the click surfaces feedback naming that no runs are recorded, never the pruned wording, and the pill does NOT earn the pruned dim", async () => {
    const key = "cr120-empty-feedback";
    const cycleId = 8601;
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 9206,
      cr: "CR-120-EMPTY",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "the active cycle", kind: "red-green", status: "active" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Empty" })],
      events: [],
      plans: [plan],
      // The cycle RESOLVES server-side (`cycle` present) and has zero runs —
      // the genuinely-empty signal, NOT the pruned one.
      anchorResponse: {
        events: [],
        cycle: {
          id: cycleId,
          label: "the active cycle",
          kind: "red-green",
          status: "active",
          activatedAt: now - 5000,
        },
      },
    });
    await openWorkflowTab();

    const badge = badgeIn(activeCycleRow());
    expect(badge).not.toBeNull();
    expect(anchorFeedbackText()).toBeNull();

    badge!.click();
    await waitForRetryBudget();
    await settle();

    expect(findAnchorCall(key, cycleId)).toBeDefined();

    const text = anchorFeedbackText();
    expect(text).not.toBeNull();
    expect(text!).toMatch(/no runs/i);
    expect(text!).not.toMatch(/pruned/i);
    expect(text!).not.toBe(PRUNED_FEEDBACK_TEXT);

    // Nothing was fabricated to jump to.
    expect(spanOpenFor(cycleId)).toBeNull();

    // An EMPTY cycle is not a PRUNED one: neither the clicked (now
    // tab-detached) pill nor a freshly re-rendered one earns CR-CRU-032's
    // permanent dim verdict.
    expect(isBadgeDisabled(badge!)).toBe(false);
    await openWorkflowTab();
    const fresh = badgeIn(activeCycleRow());
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(badge);
    expect(isBadgeDisabled(fresh!)).toBe(false);
  });

  test("a genuinely pruned cycle (no `cycle` field in the anchor response) still renders the CR-CRU-032 §S3 message VERBATIM", async () => {
    const key = "cr120-pruned-pin";
    const cycleId = 8701;
    const plan: PlanFixture = {
      planId: 9207,
      cr: "CR-120-PRUNED-PIN",
      projectKey: key,
      status: "open",
      cycles: [{ id: cycleId, label: "truly pruned cycle", kind: "red-green", status: "done" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Pruned Pin" })],
      events: [],
      plans: [plan],
      anchorResponse: { events: [] },
    });
    await openWorkflowTab();

    const badge = badgeIn(doneCycleRow());
    expect(badge).not.toBeNull();

    badge!.click();
    await waitForRetryBudget();
    await settle();

    expect(findAnchorCall(key, cycleId)).toBeDefined();
    expect(anchorFeedbackText()).toBe(PRUNED_FEEDBACK_TEXT);
  });

  test("both verdicts in ONE session: the empty cycle's message and the pruned cycle's message come out of the SAME binding and DIFFER — the feedback is keyed off the cycle AND its kind", async () => {
    const key = "cr120-both-kinds";
    const activeId = 8801;
    const doneId = 8802;
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 9208,
      cr: "CR-120-BOTH-KINDS",
      projectKey: key,
      status: "open",
      cycles: [
        { id: doneId, label: "pruned done cycle", kind: "red-green", status: "done" },
        { id: activeId, label: "the active cycle", kind: "verify", status: "active" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "CR120 Both Kinds" })],
      events: [],
      plans: [plan],
      anchorResponses: {
        // resolved server-side, zero runs -> `empty`
        [activeId]: {
          events: [],
          cycle: {
            id: activeId,
            label: "the active cycle",
            kind: "verify",
            status: "active",
            activatedAt: now - 5000,
          },
        },
        // no `cycle` field at all -> `pruned`
        [doneId]: { events: [] },
      },
    });
    await openWorkflowTab();

    const activeBadge = badgeIn(activeCycleRow());
    expect(activeBadge).not.toBeNull();
    activeBadge!.click();
    await waitForRetryBudget();
    await settle();

    const emptyText = anchorFeedbackText();
    expect(emptyText).not.toBeNull();
    expect(emptyText!).toMatch(/no runs/i);
    expect(emptyText!).not.toBe(PRUNED_FEEDBACK_TEXT);

    // Back to Workflow, and drive the OTHER verdict through the same binding.
    await openWorkflowTab();
    const doneBadge = badgeIn(doneCycleRow());
    expect(doneBadge).not.toBeNull();
    doneBadge!.click();
    await waitForRetryBudget();
    await settle();

    const prunedText = anchorFeedbackText();
    expect(prunedText).toBe(PRUNED_FEEDBACK_TEXT);
    // The whole point: the rendered text CHANGED when the kind changed. A
    // binding reading only `cycleId` (or only a single hard-coded message)
    // cannot satisfy both halves of this test.
    expect(prunedText).not.toBe(emptyText);

    expect(findAnchorCall(key, activeId)).toBeDefined();
    expect(findAnchorCall(key, doneId)).toBeDefined();
    expect(anchorCalls.length).toBe(2);
  });
});

// ── STRUCTURAL PINS over public/app.js's LIVE code ────────────────────────
//
// Two ACs of this CR are about the SHAPE of the fix, not only its rendered
// output, and neither is reachable from the DOM: the Integration AC forbids
// the two badge call sites drifting to independently-edited conditionals
// (rendered output is identical either way on the day it ships — the drift
// arrives later), and §S4's shape AC names a slot the IIFE never exposes.
// Both are asserted over `jsLiveCode(public/app.js)` — the repo's existing
// source-scan convention (tests/project-namespace-tripwire.test.ts,
// tests/queue-accepted-field-guard.test.ts), which blanks comment runs and
// string prose so app.js's 197 lines of provenance narration can never be
// mistaken for code.

const APP_JS_LIVE = jsLiveCode(APP_JS_SRC);

// A `...(<guard> ? [… CycleToRunsBadge(…) …] : [])` render site, read off the
// live layer: the spread's own parens are walked to their balanced closer, and
// the guard is everything before the conditional's `?` at depth 0.
interface BadgeRenderSite {
  guard: string;
  at: number;
}

function badgeRenderSites(live: string): BadgeRenderSite[] {
  const sites: BadgeRenderSite[] = [];
  for (const m of live.matchAll(/\.\.\.\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const inner = live.slice(open + 1, balancedEnd(live, open) - 1);
    if (!inner.includes("CycleToRunsBadge(")) continue;
    sites.push({ guard: inner.slice(0, unnestedEnd(inner, 0, "?")).trim(), at: open });
  }
  return sites;
}

// ONE named predicate call over the row's cycle, and nothing else: no `||`,
// no inlined status comparison, no second condition to edit independently.
const SHARED_PREDICATE_CALL = /^[A-Za-z_$][\w$]*\(\s*cycle\s*\)$/;

describe("CR-CRU-120 Integration — both CycleToRunsBadge call sites are driven by ONE shared predicate", () => {
  test("the two render sites carry the IDENTICAL single named predicate call, defined exactly once — neither site inlines a condition of its own", () => {
    const sites = badgeRenderSites(APP_JS_LIVE);
    // Exactly the two documented sites (CycleRow, LensCycleRow) — bounded, so
    // a third, independently-guarded site fails here rather than hiding.
    expect(sites.length).toBe(2);
    for (const site of sites) {
      expect(site.guard).toMatch(SHARED_PREDICATE_CALL);
    }
    expect(sites[0]!.guard).toBe(sites[1]!.guard);
    // The sites really are distinct places in the file, not one match counted
    // twice by a runaway walk.
    expect(sites[0]!.at).not.toBe(sites[1]!.at);

    const name = sites[0]!.guard.slice(0, sites[0]!.guard.indexOf("("));
    const defs = APP_JS_LIVE.match(new RegExp(`const\\s+${name}\\s*=`, "g")) ?? [];
    expect(defs.length).toBe(1);
  });

  test("the scan DECIDES: two independently-edited conditionals are reported as drift, and the shared-predicate shape is not", () => {
    const drifted = badgeRenderSites(
      jsLiveCode(
        [
          '...(cycleIsCompleted(cycle) || cycle.status === "active" ? [" ", CycleToRunsBadge(cycle.id)] : []),',
          '...(cycleIsCompleted(cycle) ? [" ", CycleToRunsBadge(cycle.id)] : []),',
        ].join("\n"),
      ),
    );
    expect(drifted.length).toBe(2);
    expect(drifted[0]!.guard).not.toBe(drifted[1]!.guard);
    expect(drifted[0]!.guard).not.toMatch(SHARED_PREDICATE_CALL);

    const shared = badgeRenderSites(
      jsLiveCode(
        [
          '...(cycleHasRunsBoundary(cycle) ? [" ", CycleToRunsBadge(cycle.id)] : []),',
          '...(cycleHasRunsBoundary(cycle) ? [" ", CycleToRunsBadge(cycle.id)] : []),',
        ].join("\n"),
      ),
    );
    expect(shared.map((s) => s.guard)).toEqual([
      "cycleHasRunsBoundary(cycle)",
      "cycleHasRunsBoundary(cycle)",
    ]);
  });
});

describe("CR-CRU-120 §S4 — state.anchorFeedback carries a kind discriminator, and the feedback binding reads it", () => {
  test("every non-null write to state.anchorFeedback is an object literal carrying `kind`, and AnchorFetchFeedback's own body reads BOTH the slot and its kind", () => {
    // `=(?!=)` so an equality TEST is never mistaken for an assignment.
    const writes: string[] = [];
    for (const m of APP_JS_LIVE.matchAll(/state\.anchorFeedback\s*=(?!=)\s*/g)) {
      const from = (m.index ?? 0) + m[0].length;
      writes.push(APP_JS_LIVE.slice(from, unnestedEnd(APP_JS_LIVE, from, ";")).trim());
    }
    // Non-vacuity: the CR's own risk note counts these writes — the verdict
    // written by `anchorFetchRuns` and the clear-on-click in the badge.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const value of writes) {
      if (value === "null") continue;
      expect(value.startsWith("{")).toBe(true);
      expect(value).toMatch(/\bkind\b/);
    }

    const defAt = APP_JS_LIVE.indexOf("const AnchorFetchFeedback");
    expect(defAt).toBeGreaterThan(-1);
    const bodyAt = APP_JS_LIVE.indexOf("{", APP_JS_LIVE.indexOf("=>", defAt));
    const body = APP_JS_LIVE.slice(bodyAt, balancedEnd(APP_JS_LIVE, bodyAt));
    // Non-vacuity: a real function body, not a one-character slice that would
    // make the two claims below vacuously unfalsifiable.
    expect(body.length).toBeGreaterThan(80);
    expect(body).toContain("state.anchorFeedback");
    expect(body).toMatch(/\bkind\b/);
  });
});
