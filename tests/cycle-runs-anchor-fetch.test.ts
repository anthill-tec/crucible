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
      body = {
        ok: true,
        events: anchorResponse.events,
        ...(anchorResponse.cycle !== undefined ? { cycle: anchorResponse.cycle } : {}),
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
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
