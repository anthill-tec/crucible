// CR-CRU-078 §S7 + §S8 + AC19 — SELECTION across the zones, the DURABILITY of
// the focused release and the strip's page window, and the honest EMPTY board.
//
// Spec: docs/changes/CR-CRU-078-roadmap-graph-and-table-together.md
//       §S7 (selection and highlight)
//       §S8 (the focused release and the page window live OUTSIDE the render
//            tree — added by CR-CRU-079's gap analysis, which depends on it)
//       AC17, AC18, AC19, AC31, AC32
//
// WHY A SIBLING SUITE, not an extension of the two C2/C3 files. Every test
// below needs at least one capability neither of those harnesses has, and each
// capability is load-bearing for its AC rather than convenient:
//   • a MUTABLE fixture the scripted fetch reads LIVE, so a real poll tick can
//     replace `state.queue`/`state.plans`/`state.releases` the way the running
//     app replaces them (AC31 — the house technique of
//     tests/inpane-liveness.test.ts:387-399, which exists because happy-dom
//     has no EventSource, so `startPolling()`'s `setInterval(refetch, 5000)`
//     is the reachable half of the identical refetch path SSE's `onmessage`
//     calls);
//   • WORKSPACE TAB clicks, to leave the Roadmap pane and come back (AC32);
//   • the strip's measured box model AND zones 2/3 in one mount, because
//     selection crosses zones (AC17) and durability spans the strip and the
//     two zones that follow its focus.
// tests/roadmap-release-strip.test.ts (C2) has the box model but no tabs and a
// frozen fixture; tests/roadmap-release-focus.test.ts (C3) has zones 2/3 but a
// deliberately paging-free layout. Splitting these five ACs across both would
// have duplicated the other half of each harness into each file.
//
// RED phase — what FAILS against C3's production, and what is a REGRESSION
// LOCK that already holds. Stated per AC so the RED signal is not mistaken for
// a suite that fails everywhere:
//   • AC17 — FAILS. There is no selection state on the surface at all: neither
//     `[data-testid="roadmap-row"]` nor `[data-testid="roadmap-node"]`
//     publishes `data-selected`, and a click only ever runs `roadmapDrillIn`
//     (public/app.js:2629). Selecting a row highlights nothing, in either
//     direction.
//   • AC18 — FAILS. No row or node is MARKED as the drill-through source:
//     `data-drill-source` and `[data-testid="roadmap-drill-source"]` do not
//     exist, so an IN_PROGRESS row is indistinguishable from an inert PENDING
//     one until it is clicked.
//   • AC19 — FAILS on the state's IDENTITY, passes on chrome absence. C3's
//     deletion of `buildRoadmapGraph` already took the two orphan terminals
//     with it (probe re-run 2026-08-29 against this commit: an empty board
//     renders zero strip / flow / terminal / wave / gate / table nodes), so
//     the ABSENCE half of AC19 is a lock, not a new contract. What fails: the
//     one state rendered is the TABLE's queue-scoped message — it carries no
//     `data-scope`, so "one definitive empty state for the board" and "the
//     table's queue is empty while a release exists" are the same
//     indistinguishable node, and on a board where nothing at all is
//     registered it names only the queue verb while staying silent about the
//     release ledger the strip above it also has nothing to draw from.
//   • AC31, AC32 — REGRESSION LOCKS, expected to pass on arrival. C2 hoisted
//     the page window and C3 the focused release out of the render tree
//     (public/app.js:2811-2838) for exactly this reason, and §S8 was written
//     to make that a stated contract rather than an implementation habit
//     CR-CRU-079 AC5 would inherit by luck. Nothing here re-implements them;
//     these tests are what makes a later mount-local regression fail loudly,
//     and they are the ACs CR-CRU-079 will build on.
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

/** `src/v2.ts:1755-1763` (`releaseBrief`) — what `GET …/releases` publishes. */
interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  timestamp: number;
}

/** `src/v2.ts:2045-2057` (`proposalBrief`) — what `GET …/release-proposals`
 *  publishes. `targetAt` is OPTIONAL and epoch SECONDS. */
interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

/** `src/types.ts:389-414` (`QueueEntry`) — what `GET …/queue` publishes,
 *  `ORDER BY seq`. */
interface QueueFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";
  planId?: number;
  seq?: number;
  release?: string;
  track?: string;
}

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  cycles: { id: number; label: string; status: string }[];
}

/** The measured 0.1.0 ledger row the sibling suites pin: `releasedAt`
 *  1787149125 is 2026-08-19 in SECONDS and 1970-01-21 read as MILLISECONDS. */
const SHIP_010 = 1787149125;
const TARGET_020 = 1790000000; // 2026-09-21

const SHIPPED_010: ReleaseFixture = {
  version: "0.1.0",
  commit: "c07274c",
  releasedAt: SHIP_010,
  crs: [],
  timestamp: SHIP_010 * 1000,
};

/** The release IN FLIGHT — a live proposal, so zone 2 draws its wave container
 *  and every member has BOTH a node and a row for AC17 to cross. */
const PROPOSED_020: ProposalFixture = {
  label: "0.2.0",
  targetAt: TARGET_020,
  timestamp: 1787000000,
  waves: ["5"],
};

/**
 * One wave of 0.2.0 carrying one CR of each clickability class:
 *   • CR-SEL-P — PENDING, inert (CR-CRU-083 AC7: no plan to land on);
 *   • CR-SEL-D — IN_PROGRESS with a plan, AC18's drill-through source;
 *   • CR-SEL-U — COMPLETED_UNTRACKED, also inert, and a DIFFERENT inert
 *     status from PENDING so "inert" is not read off one status.
 * The two inert rows are what let AC17 assert selection in both directions
 * without the CR-CRU-083 tab swap unmounting the pane mid-assertion.
 */
const SELECT_QUEUE: QueueFixture[] = [
  { cr: "CR-SEL-P", title: "CR-SEL-P — planned, not started", wave: "5", dependsOn: [], status: "PENDING", seq: 10, release: "0.2.0" },
  { cr: "CR-SEL-D", title: "CR-SEL-D — in flight, has a plan", wave: "5", dependsOn: [], status: "IN_PROGRESS", planId: 14, seq: 20, release: "0.2.0" },
  { cr: "CR-SEL-U", title: "CR-SEL-U — completed, tracking absent", wave: "5", dependsOn: [], status: "COMPLETED_UNTRACKED", seq: 30, release: "0.2.0" },
];

const SELECT_PLANS: PlanFixture[] = [
  {
    planId: 14,
    cr: "CR-SEL-D",
    projectKey: "selection-key",
    status: "open",
    cycles: [{ id: 1, label: "c1", status: "active" }],
  },
];

// ── The AC31/AC32 board: 20 shipped tags + one proposal ────────────────────
//
// 21 gates at a window of 8 land on offset 16 (the page CONTAINING the
// in-flight proposal at index 20 — AC5), and the DEFAULT focus is that
// proposal. Both of those defaults are what the durability assertions are
// measured AGAINST: a holder that reset would show offset 16 and version
// 0.2.0, which is precisely the failure §S8 names.
const DURABLE_COUNT = 20;
/** A SHIPPED gate, deliberately neither the default focus nor in the landing
 *  window: `0.1.9` is index 10 of the sequence, visible only after paging. */
const DURABLE_FOCUS = "0.1.9";
const DURABLE_MEMBER_A = "CR-DUR-1";
const DURABLE_MEMBER_B = "CR-DUR-2";

/** `listReleases` publishes NEWEST FIRST (CR-CRU-091 §S1): index 0 is
 *  `0.1.19`, index 19 `0.1.0`. Only the focused tag claims CRs, so the table's
 *  row count is a direct read of the queue slice AC31 replaces. */
function durableLedger(): ReleaseFixture[] {
  return Array.from({ length: DURABLE_COUNT }, (_unused, i) => {
    const age = DURABLE_COUNT - 1 - i;
    const at = SHIP_010 + age * 86_400;
    const version = `0.1.${age}`;
    return {
      version,
      releasedAt: at,
      crs: version === DURABLE_FOCUS ? [DURABLE_MEMBER_A, DURABLE_MEMBER_B] : [],
      timestamp: at * 1000,
    };
  });
}

function durableQueue(): QueueFixture[] {
  return [
    { cr: DURABLE_MEMBER_A, title: "CR-DUR-1 — shipped in 0.1.9", wave: "3", dependsOn: [], status: "COMPLETED", seq: 10, release: DURABLE_FOCUS },
  ];
}

// ── Harness ────────────────────────────────────────────────────────────────

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

/** MUTABLE on purpose: the scripted fetch reads these fields on EVERY call, so
 *  a test mutates the fixture and the app's own poll tick is what replaces the
 *  state arrays (AC31). The house technique — tests/inpane-liveness.test.ts. */
interface MountOpts {
  key?: string;
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue?: QueueFixture[];
  plans?: PlanFixture[];
  /** Non-2xx for the proposals read — AC33's degraded strip, kept distinct
   *  from AC19's empty board. */
  proposalsStatus?: number;
  layout?: Partial<StripLayout>;
}

/** The two independently measured quantities the window size comes from. */
interface StripLayout {
  track: number;
  pitch: number;
}

const DEFAULT_LAYOUT: StripLayout = { track: 800, pitch: 100 };
const TAG_SLOT = 90;
const TERMINAL_W = 60;
const TRACK_LEFT = TERMINAL_W + TAG_SLOT;

let layout: StripLayout = { ...DEFAULT_LAYOUT };
let cacheBust = 0;
/** Every URL the app fetched since the mount — the AC31 proof that the poll
 *  tick really re-read all three slices rather than one. */
let fetched: string[] = [];

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
 *  tests/roadmap-release-strip.test.ts, so paging behaves identically. */
function installLayout(): void {
  // Unchecked cast, deliberate: happy-dom's `Element` really does carry
  // `getBoundingClientRect`, and its DOM types are not the lib.dom ones this
  // program compiles against, so no runtime check could add information.
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

async function mountApp(opts: MountOpts): Promise<void> {
  const key = opts.key ?? "selection-key";
  layout = { ...DEFAULT_LAYOUT, ...(opts.layout ?? {}) };
  fetched = [];
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    // Unchecked cast, deliberate: the app consumes exactly `.ok`/`.status`/
    // `.json()`, and a full Response would add no checking.
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    fetched.push(url);
    // Order matters: `/release-proposals`, `/releases`, `/queue` and `/plans`
    // all sit under `/api/v2/projects`, and `/releases` must not swallow
    // `/release-proposals`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      const status = opts.proposalsStatus ?? 200;
      const proposals = opts.proposals ?? [];
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ ok: true, proposals, totalCount: proposals.length }),
      } as unknown as Response;
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? [] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({ ok: true, plans: opts.plans ?? [] });
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
    throw new Error(`roadmap-selection-durability.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern, shared with the two
  // sibling roadmap suites).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapSelectionDurability=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately (the rule's stated exception): the SUBJECT is the
 *  production `public/app.js` shell driving its own fetch chain, van.js's real
 *  reactive scheduler and the strip's own `setTimeout(remeasure, 0)` measure
 *  tick inside happy-dom. Faking the clock would freeze the render pass under
 *  test, and AC31's channel IS the app's real `setInterval(refetch, 5000)`. */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

/** public/app.js:373 — `startPolling()` is `setInterval(refetch, 5000)`, and
 *  happy-dom has no EventSource, so this is the reachable half of the very
 *  refetch path an SSE `onmessage` frame calls. */
const POLL_INTERVAL_MS = 5000;
const POLL_WAIT_MS = POLL_INTERVAL_MS + 700;
const POLL_TEST_TIMEOUT_MS = 20_000;

async function waitForPollTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, POLL_WAIT_MS);
  await promise;
  await settle();
}

afterEach(async () => {
  layout = { ...DEFAULT_LAYOUT };
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

const count = (testid: string): number => all(`[data-testid="${testid}"]`).length;

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

const rowEls = (): HTMLElement[] => all('[data-testid="roadmap-row"]');
const rowCrs = (): string[] => rowEls().map((r) => r.getAttribute("data-cr") ?? "");
function rowFor(cr: string): HTMLElement {
  const row = rowEls().find((r) => r.getAttribute("data-cr") === cr);
  if (row === undefined) throw new Error(`no table row rendered for ${cr}`);
  return row;
}

const nodeEls = (): HTMLElement[] => all('[data-testid="roadmap-node"]');
function nodeFor(cr: string): HTMLElement {
  const node = nodeEls().find((n) => n.getAttribute("data-cr") === cr);
  if (node === undefined) throw new Error(`no flowchart node rendered for ${cr}`);
  return node;
}

/** AC17 — the highlight, read the same way on both renderings of one entry. */
const isSelected = (el: HTMLElement): boolean => el.getAttribute("data-selected") === "true";
/** The CRs whose ROW is highlighted, and whose NODE is — never more than one
 *  of each, and always the same one. */
const selectedRows = (): string[] =>
  rowEls().filter(isSelected).map((r) => r.getAttribute("data-cr") ?? "");
const selectedNodes = (): string[] =>
  nodeEls().filter(isSelected).map((n) => n.getAttribute("data-cr") ?? "");

/** AC18 — the CRs whose row is MARKED as the drill-through source. */
const drillSourceRows = (): string[] =>
  rowEls()
    .filter((r) => r.getAttribute("data-drill-source") === "true")
    .map((r) => r.getAttribute("data-cr") ?? "");

function tabButton(name: string): HTMLElement {
  const tab = all('[data-testid="workspace-tab"]').find(
    (t) => (t.textContent ?? "").trim() === name,
  );
  if (tab === undefined) throw new Error(`no workspace tab button for ${name}`);
  return tab;
}

const tabIsOn = (name: string): boolean => tabButton(name).classList.contains("on");

async function clickTab(name: string): Promise<void> {
  tabButton(name).click();
  await settle();
}

const emptyEls = (): HTMLElement[] => all('[data-testid="roadmap-empty"]');

// ── §S7/AC17 — selecting on either side highlights the other ───────────────

describe("CR-CRU-078 §S7/AC17 — one selection, two renderings: row ⇄ node", () => {
  test("clicking a ROW highlights its flowchart NODE (and the row), and no other entry is highlighted", async () => {
    await mountApp({
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: SELECT_QUEUE,
      plans: SELECT_PLANS,
    });

    // Landing state: the in-flight release is focused, so every member has
    // both a node and a row — and nothing is selected yet.
    expect(focusedVersion()).toBe("0.2.0");
    expect(rowCrs()).toEqual(["CR-SEL-P", "CR-SEL-D", "CR-SEL-U"]);
    expect(nodeEls().length).toBe(3);
    expect(selectedRows()).toEqual([]);
    expect(selectedNodes()).toEqual([]);

    // The PENDING row: inert for the CR-CRU-083 tab swap, so the pane stays
    // mounted and the highlight is observable on both sides of one click.
    rowFor("CR-SEL-P").click();
    await settle();

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(isSelected(nodeFor("CR-SEL-P"))).toBe(true);
    expect(isSelected(rowFor("CR-SEL-P"))).toBe(true);
    // ONE selection, not a per-zone one: the other entries stay dark.
    expect(selectedNodes()).toEqual(["CR-SEL-P"]);
    expect(selectedRows()).toEqual(["CR-SEL-P"]);
    // A class hook exists for C5's visual grammar to style, so the highlight
    // is not attribute-only.
    expect(Array.from(nodeFor("CR-SEL-P").classList)).toContain("selected");
    expect(Array.from(rowFor("CR-SEL-P").classList)).toContain("selected");
  });

  test("and VICE VERSA — clicking a NODE highlights its table ROW; a one-way selection fails this AC", async () => {
    await mountApp({
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: SELECT_QUEUE,
      plans: SELECT_PLANS,
    });

    nodeFor("CR-SEL-U").click();
    await settle();

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(isSelected(rowFor("CR-SEL-U"))).toBe(true);
    expect(selectedRows()).toEqual(["CR-SEL-U"]);
    expect(selectedNodes()).toEqual(["CR-SEL-U"]);
  });

  test("the selection MOVES rather than accumulating: selecting a second entry releases the first, on both sides at once", async () => {
    await mountApp({
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: SELECT_QUEUE,
      plans: SELECT_PLANS,
    });

    rowFor("CR-SEL-P").click();
    await settle();
    expect(selectedNodes()).toEqual(["CR-SEL-P"]);

    nodeFor("CR-SEL-U").click();
    await settle();

    expect(selectedRows()).toEqual(["CR-SEL-U"]);
    expect(selectedNodes()).toEqual(["CR-SEL-U"]);
    expect(isSelected(rowFor("CR-SEL-P"))).toBe(false);
    expect(isSelected(nodeFor("CR-SEL-P"))).toBe(false);
  });

  test("a poll tick that replaces the queue leaves the highlight where the user put it — the selection is not render-tree state either", async () => {
    const opts: MountOpts = {
      key: "selection-poll-key",
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: SELECT_QUEUE.map((entry) => ({ ...entry })),
      plans: SELECT_PLANS,
    };
    await mountApp(opts);

    rowFor("CR-SEL-P").click();
    await settle();
    expect(selectedNodes()).toEqual(["CR-SEL-P"]);

    // A frame the user did not cause: a new member arrives in the same wave.
    opts.queue!.push({
      cr: "CR-SEL-N",
      title: "CR-SEL-N — arrived on a later frame",
      wave: "5",
      dependsOn: [],
      status: "PENDING",
      seq: 40,
      release: "0.2.0",
    });
    await waitForPollTick();

    // The frame really landed…
    expect(rowCrs()).toContain("CR-SEL-N");
    // …and the highlight survived it on both sides.
    expect(selectedRows()).toEqual(["CR-SEL-P"]);
    expect(selectedNodes()).toEqual(["CR-SEL-P"]);
  }, POLL_TEST_TIMEOUT_MS);
});

// ── §S7/AC18 — the IN_PROGRESS row is the drill-through SOURCE ─────────────

describe("CR-CRU-078 §S7/AC18 — an IN_PROGRESS row is clickable and MARKED as the drill-through source", () => {
  test("the IN_PROGRESS row carries the source mark and a visible affordance; the two inert rows carry neither", async () => {
    await mountApp({
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: SELECT_QUEUE,
      plans: SELECT_PLANS,
    });

    // The mark is on the row that HAS somewhere to go, and only there.
    expect(drillSourceRows()).toEqual(["CR-SEL-D"]);
    expect(rowFor("CR-SEL-P").hasAttribute("data-drill-source")).toBe(false);
    expect(rowFor("CR-SEL-U").hasAttribute("data-drill-source")).toBe(false);

    // "Marked" means visible, not merely an attribute a test can read.
    const mark = rowFor("CR-SEL-D").querySelector<HTMLElement>(
      '[data-testid="roadmap-drill-source"]',
    );
    expect(mark).not.toBeNull();
    expect((mark!.textContent ?? "").trim().length).toBeGreaterThan(0);
    expect(rowFor("CR-SEL-P").querySelector('[data-testid="roadmap-drill-source"]')).toBeNull();
    expect(rowFor("CR-SEL-U").querySelector('[data-testid="roadmap-drill-source"]')).toBeNull();
  });

  test("the node and its row never disagree about being a source — one predicate, two renderings (CR-CRU-083 AC7's rule)", async () => {
    await mountApp({
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: SELECT_QUEUE,
      plans: SELECT_PLANS,
    });

    expect(nodeFor("CR-SEL-D").getAttribute("data-drill-source")).toBe("true");
    expect(nodeFor("CR-SEL-P").hasAttribute("data-drill-source")).toBe(false);
    expect(nodeFor("CR-SEL-U").hasAttribute("data-drill-source")).toBe(false);
  });

  test("clicking the source SELECTS it and lands on Workflow (the CR-CRU-083 one-rule swap); the jump to that CR's cycles is CR-CRU-079's AC, and returning finds it still selected", async () => {
    await mountApp({
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: SELECT_QUEUE,
      plans: SELECT_PLANS,
    });

    expect(tabIsOn("Workflow")).toBe(false);
    rowFor("CR-SEL-D").click();
    await settle();

    // The existing swap stands — this CR marks the source, it does not
    // re-implement (or remove) the navigation.
    expect(tabIsOn("Workflow")).toBe(true);
    expect(stripEl()).toBeNull();

    // The same click's SELECTION outlived the pane it unmounted, which is what
    // makes AC17's highlight readable for the rows a user cares about most.
    await clickTab("Roadmap");
    expect(selectedRows()).toEqual(["CR-SEL-D"]);
    expect(selectedNodes()).toEqual(["CR-SEL-D"]);
  });
});

// ── §S8/AC31 — a poll tick or SSE frame resets NEITHER ─────────────────────

describe("CR-CRU-078 §S8/AC31 — the focused release and the page window survive a frame the user did not cause", () => {
  test(
    "with 0.1.9 focused and the strip paged off its landing window, a poll tick that replaces state.queue, state.plans AND state.releases leaves both exactly as the user left them",
    async () => {
      const opts: MountOpts = {
        key: "durable-poll-key",
        releases: durableLedger(),
        proposals: [PROPOSED_020],
        queue: durableQueue(),
        plans: [],
      };
      await mountApp(opts);

      // The DEFAULTS this test is measured against (AC5): the landing window
      // is the page containing the in-flight proposal, and that proposal is
      // the focus nobody chose.
      expect(attrNumber("data-window-size")).toBe(8);
      expect(attrNumber("data-window-offset")).toBe(16);
      expect(focusedVersion()).toBe("0.2.0");

      // The user moves BOTH: pages back a whole window, then focuses a
      // shipped gate that the landing window never showed.
      await clickTag("earlier");
      expect(attrNumber("data-window-offset")).toBe(8);
      const windowGates = gateVersions();
      expect(windowGates).toContain(DURABLE_FOCUS);
      await clickGate(DURABLE_FOCUS);
      expect(focusedVersion()).toBe(DURABLE_FOCUS);
      expect(rowCrs()).toEqual([DURABLE_MEMBER_A]);
      const gatesBefore = attrNumber("data-gate-count");
      expect(gatesBefore).toBe(DURABLE_COUNT + 1);

      // A frame the user did not cause, on all three slices at once — the
      // ledger gains its OLDEST tag (so the paged window's own gates are
      // untouched and the assertion is about the HOLDER, not about indices
      // shifting), the queue gains the focused release's second member, and a
      // plan appears.
      opts.releases!.push({
        version: "0.0.9",
        releasedAt: SHIP_010 - 86_400 * 5,
        crs: [],
        timestamp: (SHIP_010 - 86_400 * 5) * 1000,
      });
      opts.queue!.push({
        cr: DURABLE_MEMBER_B,
        title: "CR-DUR-2 — arrived on a later frame",
        wave: "3",
        dependsOn: [],
        status: "COMPLETED",
        seq: 20,
        release: DURABLE_FOCUS,
      });
      opts.plans!.push({
        planId: 99,
        cr: DURABLE_MEMBER_B,
        projectKey: "durable-poll-key",
        status: "closed",
        cycles: [{ id: 1, label: "c1", status: "done" }],
      });

      const fetchesBefore = fetched.length;
      await waitForPollTick();

      // The frame REALLY landed — otherwise this test would pass on a surface
      // that simply never re-rendered.
      expect(attrNumber("data-gate-count")).toBe(DURABLE_COUNT + 2);
      expect(rowCrs()).toEqual([DURABLE_MEMBER_A, DURABLE_MEMBER_B]);
      const sinceTick = fetched.slice(fetchesBefore);
      expect(sinceTick.some((url) => url.includes("/queue"))).toBe(true);
      expect(sinceTick.some((url) => url.includes("/plans"))).toBe(true);
      expect(sinceTick.some((url) => /\/releases(?:\?|$)/.test(url))).toBe(true);

      // …and neither piece of view state moved.
      expect(focusedVersion()).toBe(DURABLE_FOCUS);
      expect(attrNumber("data-window-offset")).toBe(8);
      expect(gateVersions()).toEqual(windowGates);
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── §S8/AC32 — and they survive a tab swap and return ─────────────────────

describe("CR-CRU-078 §S8/AC32 — leaving the Roadmap tab and coming back finds the same release focused and the same window shown", () => {
  test("focus a non-default release, page the strip, switch to Workflow, switch back: identical focus, identical window (a workspace-level holder, not a mount-local one)", async () => {
    await mountApp({
      key: "durable-tab-key",
      releases: durableLedger(),
      proposals: [PROPOSED_020],
      queue: durableQueue(),
      plans: [],
    });

    await clickTag("earlier");
    await clickGate(DURABLE_FOCUS);
    const offsetBefore = attrNumber("data-window-offset");
    const windowBefore = gateVersions();
    expect(offsetBefore).toBe(8);
    expect(focusedVersion()).toBe(DURABLE_FOCUS);

    // A real tab swap: the Roadmap pane is unmounted, not hidden.
    await clickTab("Workflow");
    expect(tabIsOn("Workflow")).toBe(true);
    expect(stripEl()).toBeNull();
    expect(nodeEls().length).toBe(0);

    await clickTab("Roadmap");

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(stripEl()).not.toBeNull();
    // The two failures §S8 names, asserted as NEGATIVES: the focus did not
    // reset to the in-flight default, and the window did not reset to the
    // landing page. Either one would make CR-CRU-079 AC5 unimplementable.
    expect(focusedVersion()).toBe(DURABLE_FOCUS);
    expect(focusedVersion()).not.toBe("0.2.0");
    expect(attrNumber("data-window-offset")).toBe(offsetBefore);
    expect(attrNumber("data-window-offset")).not.toBe(16);
    expect(gateVersions()).toEqual(windowBefore);
    // Zone 3 came back following the SAME release, not the project total.
    expect(rowCrs()).toEqual([DURABLE_MEMBER_A]);
  });

  test("a project switch is NOT a re-render: the holder is keyed by project, so another project's board lands on its own default", async () => {
    await mountApp({
      key: "durable-key-one",
      releases: durableLedger(),
      proposals: [PROPOSED_020],
      queue: durableQueue(),
      plans: [],
    });
    await clickTag("earlier");
    await clickGate(DURABLE_FOCUS);
    expect(focusedVersion()).toBe(DURABLE_FOCUS);

    // A different project, freshly mounted: the previous project's choice must
    // not surface here (the reason the holders are keyed at all).
    await mountApp({
      key: "durable-key-two",
      releases: durableLedger(),
      proposals: [PROPOSED_020],
      queue: durableQueue(),
      plans: [],
    });
    expect(focusedVersion()).toBe("0.2.0");
    expect(attrNumber("data-window-offset")).toBe(16);
  });
});

// ── AC19 — the honest empty board ─────────────────────────────────────────

describe("CR-CRU-078/AC19 — nothing registered is ONE definitive empty state and no chrome", () => {
  test("no queue and no releases: every zone's chrome is ABSENT — no strip, no terminals, no wave box, no table", async () => {
    await mountApp({ key: "empty-board-key", releases: [], proposals: [], queue: [] });

    // The zones container itself still exists (it is the pane's own box); what
    // must not exist is anything that DRAWS. The two orphan terminals the old
    // graph rendered over an empty board are the named failure.
    expect(count("roadmap-zones")).toBe(1);
    for (const testid of [
      "roadmap-strip",
      "roadmap-strip-terminal",
      "roadmap-strip-track",
      "roadmap-strip-earlier",
      "roadmap-strip-later",
      "roadmap-gate",
      "roadmap-flow",
      "roadmap-flow-terminal",
      "roadmap-flow-gate",
      "roadmap-wave",
      "roadmap-node",
      "roadmap-delivered",
      "roadmap-table",
      "roadmap-table-head",
      "roadmap-row",
      "roadmap-wave-divider",
    ]) {
      expect(count(testid), `${testid} is skeleton chrome on an empty board`).toBe(0);
    }
  });

  test("…and exactly ONE empty state, scoped to the BOARD, naming the registration verb for BOTH things that are missing", async () => {
    await mountApp({ key: "empty-board-verb-key", releases: [], proposals: [], queue: [] });

    const empties = emptyEls();
    expect(empties.length).toBe(1);
    const empty = empties[0]!;
    // The board-scoped state is a DIFFERENT fact from "the queue is empty
    // while a release exists", and says so, so neither can be mistaken for
    // the other.
    expect(empty.getAttribute("data-scope")).toBe("board");
    const text = empty.textContent ?? "";
    // §S3's literal `<key>` placeholder — the orchestrator's own copy.
    expect(text).toContain("POST /projects/<key>/queue");
    // The strip has nothing to draw either, and the verb that fixes that is
    // CR-CRU-091 §S3's `release-propose`.
    expect(text).toContain("POST /projects/<key>/release-proposals");
    expect(text).toContain("release-propose");
  });

  test("…and NO error: an empty board is a registration state, not a failure", async () => {
    await mountApp({ key: "empty-board-error-key", releases: [], proposals: [], queue: [] });

    expect(all('[data-testid*="error"]').length).toBe(0);
    expect(all('[class*="error"]').length).toBe(0);
    const text = (emptyEls()[0]!.textContent ?? "").toLowerCase();
    expect(text).not.toContain("error");
    expect(text).not.toContain("failed");
    expect(text).not.toContain("unavailable");
  });

  test("a registered QUEUE with no release is NOT the empty board: the table stands, and its own queue-scoped state is what appears when only the queue is empty", async () => {
    // Queue registered, nothing released: rows stand (there is no release to
    // scope by), and no empty state at all.
    await mountApp({
      key: "empty-half-one",
      releases: [],
      proposals: [],
      queue: SELECT_QUEUE,
    });
    expect(rowCrs().length).toBe(3);
    expect(emptyEls().length).toBe(0);

    // A release registered, the queue empty: the QUEUE-scoped message, beside
    // real strip chrome — never the board state.
    await mountApp({
      key: "empty-half-two",
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      queue: [],
    });
    expect(stripEl()).not.toBeNull();
    const empties = emptyEls();
    expect(empties.length).toBe(1);
    expect(empties[0]!.getAttribute("data-scope")).toBe("queue");
    expect(empties[0]!.textContent ?? "").toContain("POST /projects/<key>/queue");
  });

  test("AC33's distinction holds: a FAILED proposals read with shipped releases is a degraded strip, never this empty state", async () => {
    await mountApp({
      key: "empty-vs-degraded",
      releases: [SHIPPED_010],
      proposals: [PROPOSED_020],
      proposalsStatus: 500,
      queue: [],
    });

    // The shipped gate still renders — the two reads fail independently.
    expect(gateVersions()).toEqual(["0.1.0"]);
    const empties = emptyEls();
    expect(empties.length).toBe(1);
    expect(empties[0]!.getAttribute("data-scope")).toBe("queue");
    expect(empties[0]!.getAttribute("data-scope")).not.toBe("board");
  });
});
