// CR-CRU-079 §S2 + §S3 — the TARGETED drill-through from a roadmap row into
// the Workflow view, and the `← roadmap` return.
//
// Spec: docs/changes/CR-CRU-079-roadmap-deep-link-and-drill-through.md
//       §S2 (targeted drill-through), §S3 (honest unreachable case),
//       AC3, AC4, AC5. Decision 7c of docs/research/DN-crucible-roadmap-view.md
//       is the governing contract: an IN_PROGRESS row "lands on that CR's
//       active cycles; `← roadmap` returns".
//
// WHY A SIBLING SUITE. tests/roadmap-pane.test.ts holds §S1 (both doors
// route) but has no strip box model, so it cannot page the release strip —
// and AC5 is asserted on a page window that is NEITHER the landing one NOR
// the focused release's own page.
// tests/roadmap-selection-durability.test.ts has the box model and the tab
// swap but no scroll interception and no Workflow-side readers. This file
// composes the two: the roadmap-pane mount, the durability harness's measured
// strip, and the `scrollIntoView` interception of
// tests/boundary-to-cycle-navigation.test.ts.
//
// RED phase — what FAILS against production at ea80678 (cycle 347):
//   `roadmapDrillIn(status)` is a bare `selectWorkspaceTab("Workflow")`
//   (public/app.js, the `roadmapDrillIn` const). It routes OUT correctly (§S1,
//   shipped) but targets NOTHING: `lensOpenKeys` is never added to, no element
//   is scrolled, no element is marked, and the Workflow pane renders no
//   `← roadmap` affordance. Every test below passes its route-out
//   preconditions and fails at its first landing/targeting assertion.
//
// TEST-ID CONTRACT this file introduces for GREEN (does not exist yet):
//   - `data-drill-target="true"` — on the ONE element the landing targeted:
//     the history `cr-group` of a COMPLETED CR, or the active section's
//     `workflow-cr-root` of an IN_PROGRESS CR. Mirrors the roadmap row's own
//     `data-drill-source="true"` (CR-CRU-078 AC18): source on one side, target
//     on the other, same vocabulary.
//   - `[data-testid="workflow-back-to-roadmap"]` — the `← roadmap` affordance
//     rendered in the Workflow pane after a drill-through landing; its text
//     is the DN's own `← roadmap`.
//
// WHY THE IN_PROGRESS TARGET IS NOT A `cr-group`. AC3 names the `cr-group`
// for both statuses, but the history lens is closed-plans-only (CR-CRU-020
// §S1.3, public/app-logic.mjs workflowLens: `wave.crs.filter((c) =>
// c.status !== "open")`) — an OPEN plan's CR renders SOLELY in the ACTIVE
// section as `workflow-cr-root` + `cycle-row`s. That IS "that CR's active
// cycles" (decision 7c), so the IN_PROGRESS landing is asserted there, and
// AC3's "no other group expanded" limb is asserted against the history
// groups beside it.
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

// ── Fixtures ───────────────────────────────────────────────────────────────

interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  timestamp: number;
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
  planId?: number;
  seq?: number;
  release?: string;
}

interface CycleFixture {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  cycles: CycleFixture[];
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

interface StripLayout {
  track: number;
  pitch: number;
}

interface MountOpts {
  key: string;
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue: QueueFixture[];
  plans: PlanFixture[];
}

const SHIP_010 = 1787149125;
const TARGET_020 = 1790000000;

/** The release IN FLIGHT — the default focus, and the container every
 *  drill-through fixture below declares its rows into. */
const PROPOSED_020: ProposalFixture = {
  label: "0.2.0",
  targetAt: TARGET_020,
  timestamp: 1787000000,
  waves: ["5"],
};

// ── The AC5 board: 20 shipped tags + one proposal (the durability shape) ────
//
// 21 gates at a window of 8 land on offset 16 with the 0.2.0 proposal focused.
// `0.1.9` is gate index 9 — one window BACK from the landing page — so
// focusing it requires paging first; the strip is then paged one window
// further, to offset 0, so the window the user leaves contains NEITHER the
// landing focus NOR the focused gate. That is what makes AC5's page-window
// limb failable: a return that reset the focus would show 0.2.0, and a return
// that dropped the offset would re-derive the page that CONTAINS the focus
// (index 9 → offset 8, the strip's own landing rule) — not the 0 the user
// left. Same shape as tests/roadmap-selection-durability.test.ts so the
// arithmetic is known.
const DURABLE_COUNT = 20;
const DURABLE_FOCUS = "0.1.9";
const BACK_MEMBER = "CR-DT-401";

function durableLedger(): ReleaseFixture[] {
  return Array.from({ length: DURABLE_COUNT }, (_unused, i) => {
    const age = DURABLE_COUNT - 1 - i;
    const at = SHIP_010 + age * 86_400;
    const version = `0.1.${age}`;
    return {
      version,
      releasedAt: at,
      crs: version === DURABLE_FOCUS ? [BACK_MEMBER] : [],
      timestamp: at * 1000,
    };
  });
}

// ── Harness ────────────────────────────────────────────────────────────────

const DEFAULT_LAYOUT: StripLayout = { track: 800, pitch: 100 };
const TAG_SLOT = 90;
const TERMINAL_W = 60;
const TRACK_LEFT = TERMINAL_W + TAG_SLOT;

let layout: StripLayout = { ...DEFAULT_LAYOUT };
let cacheBust = 0;
/** Every element the app asked the browser to scroll into view since the
 *  mount — the "scrolled into view" half of AC3, observable because happy-dom
 *  has no layout to scroll. */
let scrollCalls: HTMLElement[] = [];

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: Date.now(),
    ...overrides,
  };
}

function rect(left: number, width: number): DOMRect {
  const box = {
    x: left,
    y: 0,
    left,
    right: left + width,
    top: 0,
    bottom: 0,
    width,
    height: 0,
    toJSON: () => box,
  };
  // Unchecked cast, deliberate: happy-dom runs no layout engine, so the box
  // model IS the harness; DOMRect has no constructor worth honouring here.
  return box as unknown as DOMRect;
}

/** happy-dom has no layout engine, so the strip would measure a zero track and
 *  render a zero-gate window. Same box model as
 *  tests/roadmap-selection-durability.test.ts, so paging behaves identically. */
function installLayout(): void {
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    if (testid === "roadmap-strip") {
      return rect(0, TRACK_LEFT + layout.track + TAG_SLOT + TERMINAL_W);
    }
    if (testid === "roadmap-strip-track") return rect(TRACK_LEFT, layout.track);
    if (testid === "roadmap-strip-ruler") return rect(TRACK_LEFT, layout.pitch);
    if (testid === "roadmap-gate") {
      const parent = this.parentElement;
      const at = parent === null ? 0 : Array.prototype.indexOf.call(parent.children, this);
      return rect(TRACK_LEFT + at * layout.pitch, layout.pitch);
    }
    return rect(0, 0);
  };
}

/** Record, never scroll: the precedent of
 *  tests/boundary-to-cycle-navigation.test.ts. Installed per mount because
 *  each mount registers a fresh happy-dom window with its own prototype. */
function installScrollRecorder(): void {
  scrollCalls = [];
  (HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void }).scrollIntoView =
    function (this: HTMLElement) {
      scrollCalls.push(this);
    };
}

async function mountApp(opts: MountOpts): Promise<void> {
  const key = opts.key;
  layout = { ...DEFAULT_LAYOUT };
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();
  installScrollRecorder();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    // Order matters: `/release-proposals`, `/releases`, `/queue` and `/plans`
    // all sit under `/api/v2/projects`, and `/releases` must not swallow
    // `/release-proposals`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      const proposals = opts.proposals ?? [];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({ ok: true, plans: opts.plans });
    }
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) {
      return okResponse({ ok: true, projects: [project({ key })] });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    throw new Error(`roadmap-drill-through.test.ts mountApp: unexpected fetch url ${url}`);
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern of the roadmap suites).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapDrillThrough=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the SUBJECT is the production shell driving its
 *  own fetch chain, van.js's real scheduler, the strip's `setTimeout(remeasure,
 *  0)` measure tick, and whatever retry the landing uses to wait for the
 *  Workflow pane to mount its target (the `revealCycleRow` precedent). */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  layout = { ...DEFAULT_LAYOUT };
  scrollCalls = [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

function tabButton(name: string): HTMLElement {
  const tab = all('[data-testid="workspace-tab"]').find(
    (t) => (t.textContent ?? "").trim() === name,
  );
  if (tab === undefined) throw new Error(`no workspace tab button for ${name}`);
  return tab;
}

const tabIsOn = (name: string): boolean => tabButton(name).classList.contains("on");

// Roadmap side.
const rowEls = (): HTMLElement[] => all('[data-testid="roadmap-row"]');
const rowCrs = (): string[] => rowEls().map((r) => r.getAttribute("data-cr") ?? "");
function rowFor(cr: string): HTMLElement {
  const row = rowEls().find((r) => r.getAttribute("data-cr") === cr);
  if (row === undefined) throw new Error(`no table row rendered for ${cr}`);
  return row;
}

const stripEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="roadmap-strip"]');

function strip(): HTMLElement {
  const el = stripEl();
  if (el === null) throw new Error('no [data-testid="roadmap-strip"] rendered');
  return el;
}

const attrNumber = (name: string): number => Number(strip().getAttribute(name));
const gateEls = (): HTMLElement[] => all('[data-testid="roadmap-gate"]');
const gateVersions = (): string[] => gateEls().map((g) => g.getAttribute("data-version") ?? "");

/** The version zones 2 and 3 are following, read off the strip's own mark. */
function focusedVersion(): string | null {
  const on = gateEls().filter((g) => g.getAttribute("data-focused") === "true");
  if (on.length > 1) throw new Error(`${on.length} gates claim focus at once`);
  return on.length === 0 ? null : (on[0]!.getAttribute("data-version") ?? null);
}

/** The version zone 2 is following, read off its own mark. Unlike
 *  `focusedVersion()` this survives paging the focused gate OUT of the
 *  window, which AC5 below does on purpose. */
function flowVersion(): string | null {
  const el = document.querySelector<HTMLElement>('[data-testid="roadmap-flow"]');
  if (el === null) throw new Error('no [data-testid="roadmap-flow"] rendered');
  return el.getAttribute("data-version");
}

async function clickGate(version: string): Promise<void> {
  const gate = gateEls().find((g) => g.getAttribute("data-version") === version);
  if (gate === undefined) throw new Error(`no gate rendered for ${version}`);
  gate.click();
  await settle();
}

async function clickTag(side: "earlier" | "later"): Promise<void> {
  const el = document.querySelector<HTMLElement>(`[data-testid="roadmap-strip-${side}"]`);
  if (el === null) throw new Error(`no ${side} paging tag rendered`);
  el.click();
  await settle();
}

// Workflow side.
const crGroupEls = (): HTMLElement[] => all('[data-testid="cr-group"]');
const crGroupCrs = (): string[] =>
  crGroupEls()
    .map((g) => g.getAttribute("data-cr") ?? "")
    .sort();
function crGroupFor(cr: string): HTMLElement {
  const group = crGroupEls().find((g) => g.getAttribute("data-cr") === cr);
  if (group === undefined) throw new Error(`no cr-group rendered for ${cr}`);
  return group;
}
/** A group is EXPANDED when its cycle list is on screen (CR-CRU-020 §S1.2:
 *  only the cycle list collapses beneath the header). */
const groupCycleIds = (group: HTMLElement): string[] =>
  Array.from(group.querySelectorAll<HTMLElement>('[data-testid="lens-cycle-row"]')).map(
    (r) => r.getAttribute("data-cycle-id") ?? "",
  );
const isDrillTarget = (el: HTMLElement): boolean => el.getAttribute("data-drill-target") === "true";
const drillTargetEls = (): HTMLElement[] => all('[data-drill-target="true"]');

const activeRootFor = (cr: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="workflow-cr-root"][data-cr="${cr}"]`);
const activeCycleEls = (): HTMLElement[] => all('[data-testid="cycle-row"]');

const backEls = (): HTMLElement[] => all('[data-testid="workflow-back-to-roadmap"]');

/** Whether the landing scrolled INTO `container` — the element itself or
 *  anything inside it (a landing may scroll the group or its first cycle
 *  row; either is "that CR", neither is another one). */
const scrolledInto = (container: HTMLElement): boolean =>
  scrollCalls.some((el) => el === container || container.contains(el));

// ── §S2/AC3 — a COMPLETED row lands on ITS cr-group, and only it ───────────

describe("CR-CRU-079 §S2/AC3 — a COMPLETED row's drill-through lands on that CR's cr-group in Workflow", () => {
  const KEY = "drill-completed-1";
  const QUEUE: QueueFixture[] = [
    { cr: "CR-DT-201", title: "CR-DT-201 — shipped first", wave: "5", dependsOn: [], status: "COMPLETED", planId: 201, seq: 10, release: "0.2.0" },
    { cr: "CR-DT-202", title: "CR-DT-202 — shipped second", wave: "5", dependsOn: [], status: "COMPLETED", planId: 202, seq: 20, release: "0.2.0" },
    { cr: "CR-DT-203", title: "CR-DT-203 — shipped third", wave: "5", dependsOn: [], status: "COMPLETED", planId: 203, seq: 30, release: "0.2.0" },
  ];
  const PLANS: PlanFixture[] = [
    { planId: 201, cr: "CR-DT-201", projectKey: KEY, status: "closed", wave: "5", cycles: [{ id: 2011, label: "c1", status: "done" }] },
    { planId: 202, cr: "CR-DT-202", projectKey: KEY, status: "closed", wave: "5", cycles: [{ id: 2021, label: "c1", status: "done" }, { id: 2022, label: "c2", status: "done" }] },
    { planId: 203, cr: "CR-DT-203", projectKey: KEY, status: "closed", wave: "5", cycles: [{ id: 2031, label: "c1", status: "done" }] },
  ];

  test("on a three-group board, clicking CR-DT-202's row expands, scrolls to and marks ONLY CR-DT-202's cr-group — the other two stay collapsed and unmarked", async () => {
    await mountApp({ key: KEY, proposals: [PROPOSED_020], queue: QUEUE, plans: PLANS });

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(location.pathname).toBe(`/p/${KEY}/roadmap`);
    expect(rowCrs()).toEqual(["CR-DT-201", "CR-DT-202", "CR-DT-203"]);
    expect(rowFor("CR-DT-202").getAttribute("data-drill-source")).toBe("true");

    rowFor("CR-DT-202").click();
    await settle();

    // §S1 (shipped, cycle 347) — the drill is a route-out. Preconditions, not
    // the subject: they pass today.
    expect(location.pathname).toBe(`/p/${KEY}`);
    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);

    // A board holding SEVERAL groups — the landing had to choose.
    expect(crGroupCrs()).toEqual(["CR-DT-201", "CR-DT-202", "CR-DT-203"]);

    // The target: expanded (its cycle rows are on screen, all of them and
    // no others), marked as the drill-through target, scrolled into view.
    const target = crGroupFor("CR-DT-202");
    expect(groupCycleIds(target)).toEqual(["2021", "2022"]);
    expect(isDrillTarget(target)).toBe(true);
    expect(scrolledInto(target)).toBe(true);

    // And ONLY the target: today's failure leaves every group collapsed; an
    // "expand all" would fail here just as loudly.
    for (const other of ["CR-DT-201", "CR-DT-203"]) {
      const group = crGroupFor(other);
      expect(groupCycleIds(group)).toEqual([]);
      expect(isDrillTarget(group)).toBe(false);
      expect(scrolledInto(group)).toBe(false);
    }
    expect(drillTargetEls().length).toBe(1);
  });
});

// ── §S2/AC3+AC4 — an IN_PROGRESS row lands on its ACTIVE cycles ────────────

describe("CR-CRU-079 §S2/AC3+AC4 — an IN_PROGRESS row's drill-through lands on that CR's active cycles", () => {
  const KEY = "drill-active-1";
  const QUEUE: QueueFixture[] = [
    { cr: "CR-DT-301", title: "CR-DT-301 — in flight", wave: "5", dependsOn: [], status: "IN_PROGRESS", planId: 301, seq: 10, release: "0.2.0" },
    { cr: "CR-DT-302", title: "CR-DT-302 — shipped", wave: "5", dependsOn: [], status: "COMPLETED", planId: 302, seq: 20, release: "0.2.0" },
    { cr: "CR-DT-303", title: "CR-DT-303 — shipped", wave: "5", dependsOn: [], status: "COMPLETED", planId: 303, seq: 30, release: "0.2.0" },
  ];
  const PLANS: PlanFixture[] = [
    {
      planId: 301,
      cr: "CR-DT-301",
      projectKey: KEY,
      status: "open",
      wave: "5",
      cycles: [
        { id: 3011, label: "C1", status: "done" },
        { id: 3012, label: "C2", status: "active" },
        { id: 3013, label: "C3", status: "pending" },
      ],
    },
    { planId: 302, cr: "CR-DT-302", projectKey: KEY, status: "closed", wave: "5", cycles: [{ id: 3021, label: "c1", status: "done" }] },
    { planId: 303, cr: "CR-DT-303", projectKey: KEY, status: "closed", wave: "5", cycles: [{ id: 3031, label: "c1", status: "done" }] },
  ];

  test("clicking CR-DT-301's row marks and scrolls to its active CR root with every cycle of its plan on screen (the active one included), while the two history cr-groups stay collapsed and unmarked", async () => {
    await mountApp({ key: KEY, proposals: [PROPOSED_020], queue: QUEUE, plans: PLANS });

    expect(rowCrs()).toEqual(["CR-DT-301", "CR-DT-302", "CR-DT-303"]);
    expect(rowFor("CR-DT-301").getAttribute("data-active")).toBe("true");

    rowFor("CR-DT-301").click();
    await settle();

    // Route-out precondition (§S1, shipped).
    expect(location.pathname).toBe(`/p/${KEY}`);
    expect(tabIsOn("Workflow")).toBe(true);

    // Decision 7c — "that CR's active cycles": the open plan's root in the
    // ACTIVE section is the target, marked as such.
    const root = activeRootFor("CR-DT-301");
    expect(root).not.toBeNull();
    expect(isDrillTarget(root!)).toBe(true);

    // AC4 — the cycles, not merely the header: every cycle of plan 301, in
    // plan order, with the ACTIVE one among them.
    const cycleIds = activeCycleEls().map((r) => r.getAttribute("data-cycle-id") ?? "");
    expect(cycleIds).toEqual(["3011", "3012", "3013"]);
    const active = activeCycleEls().filter((r) => r.getAttribute("data-status") === "active");
    expect(active.map((r) => r.getAttribute("data-cycle-id"))).toEqual(["3012"]);

    // Scrolled INTO the plan's own block — the root or one of its cycle
    // rows — and into nothing else.
    const planBlock = new Set<HTMLElement>([root!, ...activeCycleEls()]);
    const landedOnPlan = scrollCalls.some((el) =>
      Array.from(planBlock).some((owned) => owned === el || owned.contains(el)),
    );
    expect(landedOnPlan).toBe(true);

    // AC3's "no other group expanded": the history groups beside the active
    // section stay exactly as a cold Workflow load leaves them.
    expect(crGroupCrs()).toEqual(["CR-DT-302", "CR-DT-303"]);
    for (const other of ["CR-DT-302", "CR-DT-303"]) {
      const group = crGroupFor(other);
      expect(groupCycleIds(group)).toEqual([]);
      expect(isDrillTarget(group)).toBe(false);
      expect(scrolledInto(group)).toBe(false);
    }
    expect(drillTargetEls().length).toBe(1);
  });
});

// ── §S2/AC5 — `← roadmap` returns with focus and window intact ──────────────

describe("CR-CRU-079 §S2/AC5 — the `← roadmap` affordance returns to the roadmap the user left", () => {
  const KEY = "drill-back-1";
  const QUEUE: QueueFixture[] = [
    { cr: BACK_MEMBER, title: "CR-DT-401 — shipped in 0.1.9", wave: "3", dependsOn: [], status: "COMPLETED", planId: 401, seq: 10, release: DURABLE_FOCUS },
  ];
  const PLANS: PlanFixture[] = [
    { planId: 401, cr: BACK_MEMBER, projectKey: KEY, status: "closed", wave: "3", cycles: [{ id: 4011, label: "c1", status: "done" }] },
  ];

  test("after paging back, focusing 0.1.9 and paging back again to offset 0, drilling into CR-DT-401 and clicking `← roadmap` lands on /p/<key>/roadmap with 0.1.9 still focused (not the 0.2.0 default) and offset 0 still shown (neither the landing 16 nor 0.1.9's own page 8)", async () => {
    await mountApp({
      key: KEY,
      releases: durableLedger(),
      proposals: [PROPOSED_020],
      queue: QUEUE,
      plans: PLANS,
    });

    // Landing defaults — what a reset would fall back to.
    expect(focusedVersion()).toBe("0.2.0");
    expect(flowVersion()).toBe("0.2.0");
    expect(attrNumber("data-window-size")).toBe(8);
    expect(attrNumber("data-window-offset")).toBe(16);

    // The user moves BOTH holders away from their defaults…
    await clickTag("earlier");
    await clickGate(DURABLE_FOCUS);
    expect(attrNumber("data-window-offset")).toBe(8);
    expect(focusedVersion()).toBe(DURABLE_FOCUS);
    // …and then pages the window AWAY from the focus. Offset 8 is the page
    // that CONTAINS 0.1.9 — exactly what the strip re-derives when it holds
    // no offset — so asserting it on return could never tell a kept offset
    // from a dropped one. Offset 0 can: it is neither the landing 16 nor the
    // focus's own 8.
    await clickTag("earlier");
    const offsetBefore = attrNumber("data-window-offset");
    const windowBefore = gateVersions();
    expect(offsetBefore).toBe(0);
    expect(windowBefore).not.toContain(DURABLE_FOCUS);
    // The focused gate is off-window, so zone 2 is the focus's witness now.
    expect(focusedVersion()).toBeNull();
    expect(flowVersion()).toBe(DURABLE_FOCUS);
    expect(rowCrs()).toEqual([BACK_MEMBER]);

    // Drill through — the Roadmap pane is unmounted, Workflow lands on the CR.
    rowFor(BACK_MEMBER).click();
    await settle();
    expect(location.pathname).toBe(`/p/${KEY}`);
    expect(tabIsOn("Workflow")).toBe(true);
    expect(stripEl()).toBeNull();
    expect(groupCycleIds(crGroupFor(BACK_MEMBER))).toEqual(["4011"]);

    // The back affordance: exactly one, reading the DN's own words.
    const back = backEls();
    expect(back.length).toBe(1);
    expect((back[0]!.textContent ?? "").trim()).toBe("← roadmap");

    back[0]!.click();
    await settle();

    // Back on the roadmap — by ROUTE, since every roadmap move is one (§S1).
    expect(location.pathname).toBe(`/p/${KEY}/roadmap`);
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(stripEl()).not.toBeNull();

    // AC5 — the PRIOR focused release and page window: not the defaults, and
    // not the page the focus alone would re-derive.
    expect(flowVersion()).toBe(DURABLE_FOCUS);
    expect(attrNumber("data-window-offset")).toBe(offsetBefore);
    expect(gateVersions()).toEqual(windowBefore);
    expect(focusedVersion()).toBeNull();
    // Zone 3 follows the same release it followed before the drill.
    expect(rowCrs()).toEqual([BACK_MEMBER]);
  });
});
