// CR-CRU-078 §S1 + §S2 + §S3 / §S9 — ZONE 1: the paged release strip.
//
// Spec: docs/changes/CR-CRU-078-roadmap-graph-and-table-together.md
//       §S1 (remove the toggle), §S2 (paged, whole containers only),
//       §S3 (gates carry their dates), §S9 (the strip's two reads)
//       AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC28, AC29, AC30, AC33
// Data:  CR-CRU-091 §S1/§S8 — `listReleases` newest-first, `listReleaseProposals`
//        ascending by version, both epoch SECONDS.
//
// SCOPE — ZONE 1 ONLY. Zone 2's flowchart and zone 3's scoped table are C3;
// selection/highlight, focus durability and the AC19 empty state are C4; the
// visual grammar (AC21–AC26) is C5. What is pinned here is the toggle's
// removal, the MEASURED page window, the whole-container invariant, the two
// paging tags, the landing window, the gate dates, and the two reads'
// independence.
//
// ── Two harness honesty notes, because both are load-bearing ───────────────
//
// 1. GEOMETRY. happy-dom runs no layout engine, so every real
//    `getBoundingClientRect()` is a zero box and an unassisted AC3 assertion
//    would pass vacuously against ANY number of gates. So the harness SUPPLIES
//    the box model (`installLayout`) — and supplies it the way the shipped CSS
//    lays the strip out: a nowrap flex row of fixed-pitch cells inside a
//    clipped track. The app then measures its OWN two elements through the
//    real production path (`getBoundingClientRect` on the track and on the
//    CSS-owned pitch ruler), and every gate box is derived from the index the
//    APP gave it. So the model is not the assertion's answer: the number of
//    gates the app chose to render is, and one gate too many breaches the
//    track's right edge exactly as it would in Chrome. The CSS that makes the
//    model true (fixed flex basis, nowrap, clipped track) is asserted from
//    `public/styles.css` source, the technique tests/pane-scroll-floor.test.ts
//    established for precisely this happy-dom gap. Real-browser pixels are
//    AC25/C5's job.
//
// 2. MEASUREMENT. The window size must be MEASURED, never a constant that
//    happens to fit the fixtures (§S2 — it changes when the project rail
//    collapses, CR-093). The harness therefore drives the size from two
//    independently variable measurements (track width, ruler pitch) and pins
//    that BOTH move the answer, that the strip publishes what it measured, and
//    that a live width change re-measures inside ONE mount.
//
// RED phase — expected to FAIL against current production, which:
//   • still renders the `roadmap-view-table`/`roadmap-view-graph` toggle and
//     one exclusive body (`roadmapViewMode`, public/app.js:2554);
//   • renders no strip at all: `[data-testid="roadmap-strip"]` does not exist,
//     so every DOM query below is null;
//   • exports none of `releaseStripGates`/`stripWindowSize`/`releaseStripPage`/
//     `releaseStripFocusIndex` from public/app-logic.mjs, so each pure call is
//     "not a function".
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

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
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

// ── The pure boundary ──────────────────────────────────────────────────────
//
// The ambient tests/app-logic.d.ts predates these exports, so the module is
// cast to the boundary under test ONCE (the now-DELETED tests/roadmap-graph.test.ts and
// tests/roadmap-gate-date.test.ts pattern). Until GREEN adds them each call is
// "is not a function" — the intended missing-export RED signal.

interface StripGate {
  version: string;
  kind: "shipped" | "proposed";
  date: string;
  dateState: "dated" | "absent" | "unusable";
}

interface StripPage {
  /** How many gates the window actually shows — never a fraction of one. */
  size: number;
  /** The index of the window's first gate. */
  offset: number;
  /** Hidden behind the window on each side; 0 means "no tag at all" (AC4). */
  earlier: number;
  later: number;
}

const Logic = AppLogic as unknown as {
  formatReleaseDate: (epochSeconds: unknown) => string;
  releaseStripGates: (releases: unknown, proposals: unknown) => StripGate[];
  stripWindowSize: (availableWidth: unknown, gatePitch: unknown) => number;
  releaseStripPage: (input: {
    count: number;
    size: number;
    focusIndex?: number;
    offset?: number;
  }) => StripPage;
  releaseStripFocusIndex: (gates: StripGate[]) => number;
};

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
 *  publishes. `targetAt` is OPTIONAL and epoch SECONDS; there is no `status`
 *  (every returned proposal is live by construction). */
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
  /** CR-CRU-091 §S2 — the DECLARED target release. Zone 3 scopes on it
   *  (CR-CRU-078 §S5/AC10), so a queue with none is a queue no focused
   *  release claims. */
  release?: string;
}

/** The measured 0.1.0 ledger row tests/roadmap-gate-date.test.ts pins:
 *  `releasedAt` 1787149125 is 2026-08-19 in SECONDS and 1970-01-21 read as
 *  MILLISECONDS. The two files share the number on purpose (AC6). */
const SHIP_010 = 1787149125;
const TARGET_020 = 1790000000; // 2026-09-21, AFTER 0.1.0 shipped
const TARGET_EARLY = 1780000000; // BEFORE 0.1.0 shipped — AC28's slipped plan

const SHIPPED_010: ReleaseFixture = {
  version: "0.1.0",
  commit: "c07274c",
  releasedAt: SHIP_010,
  crs: ["CR-A"],
  timestamp: SHIP_010 * 1000 + 874,
};

const SHIPPED_020: ReleaseFixture = {
  version: "0.2.0",
  commit: "d9d39a4",
  releasedAt: SHIP_010 + 86_400 * 30,
  crs: ["CR-B"],
  timestamp: (SHIP_010 + 86_400 * 30) * 1000,
};

const PROPOSED_020: ProposalFixture = {
  label: "0.2.0",
  targetAt: TARGET_020,
  timestamp: 1787000000,
  waves: ["7"],
};

/** A proposal with NO declared target. Its `timestamp` would itself format to
 *  a real day, so "the render reached for `timestamp`" is a mistake this
 *  fixture catches rather than hides (AC7). */
const PROPOSED_030_UNDATED: ProposalFixture = {
  label: "0.3.0",
  timestamp: TARGET_020,
  waves: [],
};

const QUEUE: QueueFixture[] = [
  { cr: "CR-A", title: "Alpha", wave: "5", dependsOn: [], status: "COMPLETED", seq: 10, release: "0.1.0" },
  { cr: "CR-B", title: "Beta", wave: "5", dependsOn: ["CR-A"], status: "IN_PROGRESS", seq: 20, release: "0.2.0" },
];

/**
 * `n` shipped releases in the order `listReleases` publishes them — NEWEST
 * FIRST (CR-CRU-091 §S1). Index 0 is the newest tag, so a render that reverses
 * or re-sorts the ledger is visible in the rendered version sequence.
 */
function shippedLedger(n: number): ReleaseFixture[] {
  return Array.from({ length: n }, (_unused, i) => {
    const age = n - 1 - i;
    const at = SHIP_010 + age * 86_400;
    return { version: `0.1.${age}`, releasedAt: at, timestamp: at * 1000 };
  });
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

interface MountOpts {
  key?: string;
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue?: QueueFixture[];
  /** Non-2xx for the proposals read — the AC33 degraded path through getJson. */
  proposalsStatus?: number;
  /** Transport failure for the proposals read — the other half of AC33. */
  proposalsThrows?: boolean;
  /** The harness box model for this mount (see the header note). */
  layout?: Partial<StripLayout>;
}

/** The two independently measured quantities the window size is derived from. */
interface StripLayout {
  /** The gate track's own box width — what the rail collapse (CR-093) changes. */
  track: number;
  /** The CSS-owned gate pitch, measured off the strip's hidden ruler. */
  pitch: number;
}

const DEFAULT_LAYOUT: StripLayout = { track: 800, pitch: 100 };
/** Reserved side slot for a paging tag, and the terminal's own width. Only the
 *  harness's box model needs the numbers; the app measures, never assumes. */
const TAG_SLOT = 90;
const TERMINAL_W = 60;
const TRACK_LEFT = TERMINAL_W + TAG_SLOT;

let layout: StripLayout = { ...DEFAULT_LAYOUT };
let cacheBust = 0;

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
  return box as unknown as DOMRect;
}

/**
 * The harness box model — see header note 1. Installed on the happy-dom
 * `Element` prototype for the mount, so the app's own `getBoundingClientRect`
 * measurement path is the one under test. A gate's box comes from the index
 * the APP placed it at, which is what makes AC3 a real assertion here.
 */
function installLayout(): void {
  // Unchecked cast, deliberate: happy-dom's `Element` really does carry
  // `getBoundingClientRect`, and its DOM types are not the lib.dom ones the
  // test program compiles against, so no runtime check could add information.
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    // Live, not captured: a resize changes `layout` under an installed stub.
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
  const key = opts.key ?? "strip-key";
  layout = { ...DEFAULT_LAYOUT, ...(opts.layout ?? {}) };
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    // Order matters: `/release-proposals`, `/releases`, `/queue` and `/plans`
    // all sit under `/api/v2/projects`, and `/releases` must not swallow
    // `/release-proposals`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      if (opts.proposalsThrows === true) throw new TypeError("Failed to fetch");
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
      return okResponse({ ok: true, entries: opts.queue ?? QUEUE });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) return okResponse({ ok: true, plans: [] });
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) {
      return okResponse({ ok: true, projects: [project({ key })] });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    throw new Error(`roadmap-release-strip.test.ts mountApp: unexpected fetch url ${url}`);
  };
  // happy-dom installs its own `fetch`; the app is driven entirely off this
  // script, so the global is replaced wholesale (house harness pattern).
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapReleaseStrip=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production `public/app.js`
 *  shell driving its own fetch chain and van.js's real reactive scheduler
 *  inside happy-dom. Faking the clock would freeze the very render pass under
 *  test (and the strip's own measure tick). */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  layout = { ...DEFAULT_LAYOUT };
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const stripEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="roadmap-strip"]');

function strip(): HTMLElement {
  const el = stripEl();
  if (el === null) throw new Error("no [data-testid=\"roadmap-strip\"] rendered");
  return el;
}

const gateEls = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="roadmap-gate"]'));

const gateVersions = (): string[] =>
  gateEls().map((g) => g.getAttribute("data-version") ?? "");

const gateKinds = (): string[] => gateEls().map((g) => g.getAttribute("data-kind") ?? "");

const gateDateText = (version: string): string => {
  const gate = gateEls().find((g) => g.getAttribute("data-version") === version);
  if (gate === undefined) throw new Error(`no gate rendered for ${version}`);
  const date = gate.querySelector('[data-testid="roadmap-gate-date"]');
  return (date?.textContent ?? "").trim();
};

const tag = (side: "earlier" | "later"): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="roadmap-strip-${side}"]`);

const attrNumber = (name: string): number => Number(strip().getAttribute(name));

async function clickTag(side: "earlier" | "later"): Promise<void> {
  const el = tag(side);
  if (el === null) throw new Error(`no ${side} paging tag rendered`);
  el.click();
  await settle();
}

/** Shrink/grow the strip's available width the way a rail collapse does, then
 *  let the app re-measure through its own resize path. */
async function resizeTrackTo(width: number): Promise<void> {
  layout = { ...layout, track: width };
  window.dispatchEvent(new Event("resize"));
  await settle();
}

/**
 * AC3 — every rendered gate whose box is NOT wholly inside the strip's box.
 * Checked against the TRACK's box too, which is the tighter of the two and the
 * one the measurement is taken from.
 */
interface Breach {
  version: string;
  left: number;
  right: number;
  trackLeft: number;
  trackRight: number;
}

function gatesOutsideTheStrip(): Breach[] {
  const el = strip();
  const stripBox = el.getBoundingClientRect();
  const trackEl = el.querySelector('[data-testid="roadmap-strip-track"]');
  if (trackEl === null) throw new Error("the strip rendered no gate track to measure");
  const track = trackEl.getBoundingClientRect();
  const breaches: Breach[] = [];
  for (const gate of gateEls()) {
    const box = gate.getBoundingClientRect();
    const inside =
      box.left >= track.left - 0.5 &&
      box.right <= track.right + 0.5 &&
      box.left >= stripBox.left - 0.5 &&
      box.right <= stripBox.right + 0.5;
    if (!inside) {
      breaches.push({
        version: gate.getAttribute("data-version") ?? "",
        left: box.left,
        right: box.right,
        trackLeft: track.left,
        trackRight: track.right,
      });
    }
  }
  return breaches;
}

/** The window is MAXIMAL as well as whole: one more gate would breach the
 *  track. Without this an "everything fits" render would satisfy AC3 by
 *  drawing one gate and hiding the rest. */
function oneMoreGateWouldBreach(): boolean {
  const trackWidth = strip()
    .querySelector('[data-testid="roadmap-strip-track"]')!
    .getBoundingClientRect().width;
  const pitch = strip()
    .querySelector('[data-testid="roadmap-strip-ruler"]')!
    .getBoundingClientRect().width;
  return (gateEls().length + 1) * pitch > trackWidth;
}

/** Collects EVERY styles.css rule body whose selector list carries `.<cls>` as
 *  a standalone class token — the tests/pane-scroll-floor.test.ts technique,
 *  so GREEN is free to choose its selector shape. */
function allRuleBodiesForClass(cls: string): string {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`([^{}]*(?:^|[\\s,>+~])\\.${escaped}(?![\\w-])[^{}]*)\\{([^}]*)\\}`, "gs");
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(STYLES_SRC)) !== null) bodies.push(m[2] ?? "");
  return bodies.join("\n");
}

// ── §S2 — the PURE page computation ────────────────────────────────────────

describe("CR-CRU-078 §S2 — the window holds WHOLE gates, measured, never a fraction", () => {
  test("the window size is floor(available width / gate pitch) — a fractional remainder is never a gate", () => {
    expect(Logic.stripWindowSize(800, 100)).toBe(8);
    // 8.5 gates fit: the half is a REMAINDER, not a ninth gate.
    expect(Logic.stripWindowSize(850, 100)).toBe(8);
    expect(Logic.stripWindowSize(99, 100)).toBe(0);
    expect(Logic.stripWindowSize(100, 100)).toBe(1);
  });

  test("an UNMEASURABLE strip yields no window rather than a fallback constant — the fallback IS the hardcoding §S2 forbids", () => {
    expect(Logic.stripWindowSize(0, 100)).toBe(0);
    expect(Logic.stripWindowSize(800, 0)).toBe(0);
    expect(Logic.stripWindowSize(Number.NaN, 100)).toBe(0);
    expect(Logic.stripWindowSize(800, Number.NaN)).toBe(0);
    expect(Logic.stripWindowSize(undefined, undefined)).toBe(0);
  });

  test("the landing window CONTAINS the focused gate, and a click pages by a WHOLE window in both directions", () => {
    const landing = Logic.releaseStripPage({ count: 20, size: 8, focusIndex: 19 });
    expect(landing.offset).toBe(16);
    expect(landing.size).toBe(4);
    expect(landing.earlier).toBe(16);
    expect(landing.later).toBe(0);

    // One window earlier is exactly one window: 16 → 8.
    const back = Logic.releaseStripPage({ count: 20, size: 8, focusIndex: 19, offset: 8 });
    expect(back.offset).toBe(8);
    expect(back.size).toBe(8);
    expect(back.earlier).toBe(8);
    expect(back.later).toBe(4);
  });

  test("a requested offset is snapped to the page grid and clamped to the ends — no window ever starts mid-gate or past the last page", () => {
    expect(Logic.releaseStripPage({ count: 20, size: 8, offset: -40 }).offset).toBe(0);
    expect(Logic.releaseStripPage({ count: 20, size: 8, offset: 999 }).offset).toBe(16);
    // Snapped, not truncated: an off-grid 11 belongs to the window starting 8.
    expect(Logic.releaseStripPage({ count: 20, size: 8, offset: 11 }).offset).toBe(8);
  });

  test("with everything fitting, both hidden counts are ZERO — which is what makes the tags absent rather than disabled (AC4)", () => {
    const page = Logic.releaseStripPage({ count: 3, size: 8, focusIndex: 0 });
    expect(page).toEqual({ size: 3, offset: 0, earlier: 0, later: 0 });
  });

  test("an unmeasured strip (size 0) shows nothing and claims nothing hidden — no tag can promise a window that cannot exist", () => {
    expect(Logic.releaseStripPage({ count: 20, size: 0, focusIndex: 4 })).toEqual({
      size: 0,
      offset: 0,
      earlier: 0,
      later: 0,
    });
  });
});

// ── §S3/§S9 — the sequence the strip is made of ────────────────────────────

describe("CR-CRU-078 §S9/AC28 — one sequence: shipped as published, then proposals, with NO reversal", () => {
  test("the two reads are concatenated VERBATIM — proposals last, and neither published order is re-sorted", () => {
    const shipped = shippedLedger(3); // 0.1.2, 0.1.1, 0.1.0 — newest-first
    const proposals: ProposalFixture[] = [
      { label: "0.4.0", timestamp: 1, waves: [] },
      { label: "0.5.0", timestamp: 2, waves: [] },
    ];
    const gates = Logic.releaseStripGates(shipped, proposals);
    expect(gates.map((g) => g.version)).toEqual(["0.1.2", "0.1.1", "0.1.0", "0.4.0", "0.5.0"]);
    expect(gates.map((g) => g.kind)).toEqual([
      "shipped",
      "shipped",
      "shipped",
      "proposed",
      "proposed",
    ]);
  });

  test("a proposal whose declared target PREDATES a shipped release still renders last — a target is a plan, version orders the strip", () => {
    const gates = Logic.releaseStripGates([SHIPPED_010], [
      { label: "0.2.0", targetAt: TARGET_EARLY, timestamp: 1787000000, waves: [] },
    ]);
    expect(gates.map((g) => g.version)).toEqual(["0.1.0", "0.2.0"]);
    // Fixture guard: the target really is EARLIER than the ship date, so
    // "ordered by date" would have swapped them.
    expect(TARGET_EARLY).toBeLessThan(SHIP_010);
    expect(gates[1]!.date).toBe(Logic.formatReleaseDate(TARGET_EARLY));
  });

  test("either read being empty is an ordinary sequence, not a special case", () => {
    expect(Logic.releaseStripGates([], []).length).toBe(0);
    expect(Logic.releaseStripGates([SHIPPED_010], []).map((g) => g.kind)).toEqual(["shipped"]);
    expect(Logic.releaseStripGates([], [PROPOSED_020]).map((g) => g.kind)).toEqual(["proposed"]);
  });

  test("the in-flight release is the FIRST live proposal — the next release to ship — and the newest shipped tag when none is proposed", () => {
    const withPlan = Logic.releaseStripGates(shippedLedger(3), [PROPOSED_020]);
    expect(Logic.releaseStripFocusIndex(withPlan)).toBe(3);
    const shippedOnly = Logic.releaseStripGates(shippedLedger(3), []);
    // `listReleases` is newest-first, so index 0 IS the newest tag.
    expect(Logic.releaseStripFocusIndex(shippedOnly)).toBe(0);
    expect(Logic.releaseStripFocusIndex([])).toBe(-1);
  });
});

describe("CR-CRU-078 §S3/AC30 — every gate date comes from the ONE formatter", () => {
  test("a shipped gate carries its ship date and a proposed gate its declared target — both epoch SECONDS", () => {
    const gates = Logic.releaseStripGates([SHIPPED_010], [PROPOSED_020]);
    expect(gates[0]!.date).toBe(Logic.formatReleaseDate(SHIP_010));
    expect(gates[0]!.date).toBe("2026-08-19");
    expect(gates[1]!.date).toBe(Logic.formatReleaseDate(TARGET_020));
    expect(gates[0]!.dateState).toBe("dated");
    expect(gates[1]!.dateState).toBe("dated");
    // The milliseconds reading is a live trap, not a hypothetical one.
    expect(new Date(SHIP_010).toISOString().slice(0, 10)).toBe("1970-01-21");
    expect(gates[0]!.date).not.toStartWith("1970");
  });

  test("AC7 — an undeclared target yields NO date, and never the proposal's own `timestamp`", () => {
    const gates = Logic.releaseStripGates([], [PROPOSED_030_UNDATED]);
    expect(gates[0]!.dateState).toBe("absent");
    expect(gates[0]!.date).toBe("");
    // Fixture guard: `timestamp` really would have formatted to a real day.
    expect(Logic.formatReleaseDate(PROPOSED_030_UNDATED.timestamp)).not.toBe("");
  });

  test("a field that is PRESENT but unusable is a data defect, not a plan nobody authored", () => {
    const gates = Logic.releaseStripGates([], [
      { label: "0.9.0", targetAt: Number.NaN, timestamp: 1, waves: [] },
    ]);
    expect(gates[0]!.dateState).toBe("unusable");
    expect(gates[0]!.date).toBe("");
  });
});

// ── §S1/AC1 — the toggle is gone ───────────────────────────────────────────

describe("CR-CRU-078 §S1/AC1 — no exclusive toggle: every zone renders unconditionally", () => {
  test("a cold /p/<key>/roadmap load renders the strip, the flowchart AND the focused release's table rows at once", async () => {
    await mountApp({ releases: [SHIPPED_010], proposals: [PROPOSED_020] });
    expect(stripEl()).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="roadmap-flow"]').length).toBe(1);
    // C3 scoped zone 3 to the FOCUSED release (§S5/AC10), so the row count is
    // that release's membership rather than the whole queue: landing focuses
    // the in-flight 0.2.0, and CR-B is the entry declared into it.
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="roadmap-row"]')).map((r) =>
        r.getAttribute("data-cr"),
      ),
    ).toEqual(["CR-B"]);
  });

  test("neither toggle button exists in the DOM", async () => {
    await mountApp({ releases: [SHIPPED_010] });
    expect(document.querySelector('[data-testid="roadmap-view-table"]')).toBeNull();
    expect(document.querySelector('[data-testid="roadmap-view-graph"]')).toBeNull();
    expect(document.querySelector('[data-testid="roadmap-view-toggle"]')).toBeNull();
  });

  test("nor in the SOURCE — the exclusive view state goes with the buttons", () => {
    expect(APP_JS_SRC).not.toContain("roadmap-view-table");
    expect(APP_JS_SRC).not.toContain("roadmap-view-graph");
    expect(APP_JS_SRC).not.toContain("roadmapViewMode");
    expect(STYLES_SRC).not.toContain("app-roadmap-viewtoggle");
  });

  test("AC2 — the three zones share one scrolling pane, in order: strip, then flowchart, then table", async () => {
    await mountApp({ releases: [SHIPPED_010] });
    // ONE pane per tab: two pane-scroll boxes would give the tab two
    // independent scrollers (and break Playwright's strict single match).
    const panes = document.querySelectorAll('[data-testid="pane-scroll"]');
    expect(panes.length).toBe(1);
    const zones = document.querySelector('[data-testid="roadmap-zones"]');
    expect(zones).not.toBeNull();
    const order = ["roadmap-strip", "roadmap-flow", "roadmap-row"].map((id) =>
      Array.from(zones!.querySelectorAll<HTMLElement>("*")).findIndex(
        (el) => el.getAttribute("data-testid") === id,
      ),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
    // …and the container really stacks them vertically, so document order IS
    // visual order (happy-dom paints nothing; the CSS is the evidence).
    expect(allRuleBodiesForClass("app-roadmap-zones")).toMatch(/flex-direction:\s*column/);
  });
});

// ── §S2/AC3 — no gate is ever drawn partially ──────────────────────────────

describe("CR-CRU-078 §S2/AC3 — every rendered gate lies WHOLLY inside the strip", () => {
  test("on landing, after paging LATER and after paging back EARLIER — and the window is maximal, so it is not passing by drawing one gate", async () => {
    await mountApp({ releases: shippedLedger(20), layout: { track: 800, pitch: 100 } });
    expect(gateEls().length).toBe(8);
    expect(gatesOutsideTheStrip()).toEqual([]);
    expect(oneMoreGateWouldBreach()).toBe(true);

    await clickTag("later");
    expect(gateEls().length).toBe(8);
    expect(gatesOutsideTheStrip()).toEqual([]);

    await clickTag("earlier");
    expect(gateEls().length).toBe(8);
    expect(gatesOutsideTheStrip()).toEqual([]);
    expect(attrNumber("data-window-offset")).toBe(0);
  });

  test("a track that fits 8.5 gates renders EIGHT — the half gate is a remainder, and a ninth would breach the track", async () => {
    await mountApp({ releases: shippedLedger(20), layout: { track: 850, pitch: 100 } });
    expect(gateEls().length).toBe(8);
    expect(gatesOutsideTheStrip()).toEqual([]);
    expect(attrNumber("data-window-size")).toBe(8);
    // The ninth gate would run 800→900 inside an 850-wide track: over the edge.
    expect(9 * 100).toBeGreaterThan(850);
  });

  test("the CSS makes a partial gate impossible in a real browser too: a fixed-pitch, nowrap row inside a clipped track", () => {
    const gate = allRuleBodiesForClass("app-strip-gate");
    // A fixed flex BASIS — a gate that grew or shrank would break the pitch
    // the window size was computed from.
    expect(gate).toMatch(/flex:\s*0\s+0\s+var\(--app-strip-gate-pitch\)/);
    expect(gate).toMatch(/box-sizing:\s*border-box/);
    const row = allRuleBodiesForClass("app-strip-gates");
    expect(row).toMatch(/flex-wrap:\s*nowrap/);
    const track = allRuleBodiesForClass("app-strip-track");
    expect(track).toMatch(/overflow:\s*hidden/);
    // The pitch is declared in CSS — the stylesheet owns it, not app.js.
    expect(STYLES_SRC).toMatch(/--app-strip-gate-pitch:\s*\d/);
    expect(allRuleBodiesForClass("app-strip-ruler")).toMatch(
      /width:\s*var\(--app-strip-gate-pitch\)/,
    );
  });
});

// ── §S2/AC4 — the hidden count IS the affordance ───────────────────────────

describe("CR-CRU-078 §S2/AC4 — the remainder is a clickable tag on each side, absent when empty", () => {
  test("with 20 releases and room for 8, the landing window hides 12 later and nothing earlier — so ONLY the later tag exists", async () => {
    await mountApp({ releases: shippedLedger(20), layout: { track: 800, pitch: 100 } });
    expect(attrNumber("data-window-offset")).toBe(0);
    expect(tag("earlier")).toBeNull();
    const later = tag("later");
    expect(later).not.toBeNull();
    expect(later!.textContent ?? "").toContain("12");
    expect(later!.textContent ?? "").toContain("later");
    expect(later!.tagName.toLowerCase()).toBe("button");
  });

  test("one click pages a WHOLE window and both counts update; the second click reaches the last page, where the later tag disappears", async () => {
    await mountApp({ releases: shippedLedger(20), layout: { track: 800, pitch: 100 } });
    await clickTag("later");
    expect(attrNumber("data-window-offset")).toBe(8);
    expect(attrNumber("data-hidden-earlier")).toBe(8);
    expect(attrNumber("data-hidden-later")).toBe(4);
    expect(tag("earlier")).not.toBeNull();
    expect((tag("earlier")!.textContent ?? "").includes("8")).toBe(true);
    expect(gateVersions()).toEqual(["0.1.11", "0.1.10", "0.1.9", "0.1.8", "0.1.7", "0.1.6", "0.1.5", "0.1.4"]);

    await clickTag("later");
    expect(attrNumber("data-window-offset")).toBe(16);
    expect(attrNumber("data-hidden-later")).toBe(0);
    // ABSENT from the DOM, not rendered disabled. Scoped to the strip: other
    // surfaces legitimately carry disabled controls.
    expect(tag("later")).toBeNull();
    expect(strip().querySelectorAll("[disabled]").length).toBe(0);
    expect(strip().querySelectorAll("button").length).toBe(1);
    expect(gateEls().length).toBe(4);

    await clickTag("earlier");
    expect(attrNumber("data-window-offset")).toBe(8);
    expect(tag("later")).not.toBeNull();
  });

  test("with everything fitting, NEITHER tag is in the DOM", async () => {
    await mountApp({ releases: shippedLedger(3), layout: { track: 800, pitch: 100 } });
    expect(gateEls().length).toBe(3);
    expect(tag("earlier")).toBeNull();
    expect(tag("later")).toBeNull();
  });
});

// ── §S2/AC5 — the landing window contains the release in progress ──────────

describe("CR-CRU-078 §S2/AC5 — landing shows the release in PROGRESS, never offset 0 by default", () => {
  test("20 releases whose in-flight (proposed) release is LAST land on the window that contains it", async () => {
    const shipped = shippedLedger(19);
    await mountApp({
      releases: shipped,
      proposals: [PROPOSED_020],
      layout: { track: 800, pitch: 100 },
    });
    // Fixture guard: 20 gates, the in-flight one last, and the window is 8 —
    // so "contains the focus" and "offset 0" are genuinely different answers.
    expect(attrNumber("data-gate-count")).toBe(20);
    expect(attrNumber("data-window-size")).toBe(8);
    expect(attrNumber("data-window-offset")).toBe(16);
    expect(attrNumber("data-window-offset")).toBeGreaterThan(0);
    expect(gateVersions()).toContain("0.2.0");
    expect(gateKinds()).toContain("proposed");
    expect(gatesOutsideTheStrip()).toEqual([]);
    // Everything before the window is reachable and counted.
    expect(attrNumber("data-hidden-earlier")).toBe(16);
    expect(attrNumber("data-hidden-later")).toBe(0);
  });
});

// ── §S2 — the window is MEASURED ───────────────────────────────────────────

describe("CR-CRU-078 §S2 — the window size is MEASURED from layout, not hardcoded", () => {
  test("the strip publishes the two numbers it measured, so the derivation is observable rather than asserted", async () => {
    // Deliberately odd values no constant would coincide with.
    await mountApp({ releases: shippedLedger(20), layout: { track: 731, pitch: 137 } });
    expect(attrNumber("data-track-width")).toBe(731);
    expect(attrNumber("data-gate-pitch")).toBe(137);
    expect(attrNumber("data-window-size")).toBe(Math.floor(731 / 137));
    expect(gateEls().length).toBe(Math.floor(731 / 137));
  });

  test("the SAME fixture yields a different window at a different WIDTH — the rail-collapse case (CR-093)", async () => {
    await mountApp({ releases: shippedLedger(20), layout: { track: 400, pitch: 100 } });
    expect(gateEls().length).toBe(4);
    expect(attrNumber("data-hidden-later")).toBe(16);

    await mountApp({ releases: shippedLedger(20), layout: { track: 1200, pitch: 100 } });
    expect(gateEls().length).toBe(12);
    expect(attrNumber("data-hidden-later")).toBe(8);
  });

  test("…and a different PITCH moves it the other way, so neither input is a constant in disguise", async () => {
    await mountApp({ releases: shippedLedger(20), layout: { track: 800, pitch: 200 } });
    expect(attrNumber("data-gate-pitch")).toBe(200);
    expect(gateEls().length).toBe(4);
  });

  test("a live width change RE-MEASURES inside one mount: the window grows and the hidden count shrinks with no remount", async () => {
    await mountApp({ releases: shippedLedger(20), layout: { track: 400, pitch: 100 } });
    const before = strip();
    expect(gateEls().length).toBe(4);
    expect(attrNumber("data-hidden-later")).toBe(16);

    await resizeTrackTo(1000);
    // The SAME element, re-measured in place — not a fresh mount.
    expect(strip()).toBe(before);
    expect(attrNumber("data-track-width")).toBe(1000);
    expect(gateEls().length).toBe(10);
    expect(attrNumber("data-hidden-later")).toBe(10);
    expect(gatesOutsideTheStrip()).toEqual([]);
  });

  test("no window size is written into app.js — the size only ever comes from the two measurements", () => {
    expect(APP_JS_SRC).not.toMatch(/stripWindowSize\(\s*\d/);
    expect(APP_JS_SRC).toContain("getBoundingClientRect");
    // AC30's other half: nothing on this surface constructs a date itself.
    expect(APP_JS_SRC).not.toContain("new Date(");
    expect(APP_JS_SRC).not.toContain("toISOString");
    expect(APP_JS_SRC).toContain("resolveGateDate");
  });
});

// ── §S3/AC6/AC7/AC30 — the rendered dates ──────────────────────────────────

describe("CR-CRU-078 §S3/AC6/AC7/AC30 — each gate renders its own date, or says it has none", () => {
  test("a shipped gate renders its ship date; a 1970 date fails (seconds-vs-milliseconds)", async () => {
    await mountApp({ releases: [SHIPPED_010], proposals: [PROPOSED_020] });
    expect(gateDateText("0.1.0")).toBe(Logic.formatReleaseDate(SHIP_010));
    expect(gateDateText("0.1.0")).toBe("2026-08-19");
    expect(strip().textContent ?? "").not.toContain("1970");
  });

  test("a proposed gate renders its DECLARED target", async () => {
    await mountApp({ releases: [SHIPPED_010], proposals: [PROPOSED_020] });
    expect(gateDateText("0.2.0")).toBe(Logic.formatReleaseDate(TARGET_020));
    const gate = gateEls().find((g) => g.getAttribute("data-version") === "0.2.0");
    expect(gate!.getAttribute("data-kind")).toBe("proposed");
    expect(gate!.getAttribute("data-date-state")).toBe("dated");
  });

  test("AC6/AC7 — an undeclared target renders the explicit empty state and NO date of any kind", async () => {
    await mountApp({ releases: [SHIPPED_010], proposals: [PROPOSED_030_UNDATED] });
    const text = gateDateText("0.3.0");
    expect(text).toBe("no target declared");
    const gate = gateEls().find((g) => g.getAttribute("data-version") === "0.3.0");
    expect(gate!.getAttribute("data-date-state")).toBe("absent");
    // No forecast, no interpolation, no placeholder day anywhere on the gate —
    // and in particular not the proposal's own `timestamp` (which WOULD format
    // to a real day, see the fixture).
    expect(gate!.textContent ?? "").not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(strip().textContent ?? "").not.toContain(
      Logic.formatReleaseDate(PROPOSED_030_UNDATED.timestamp),
    );
  });

  test("an undated SHIPPED tag says so as well — a legacy row is not a proposal with no plan", async () => {
    await mountApp({ releases: [{ version: "0.0.9", timestamp: 1 }] });
    expect(gateEls().length).toBe(1);
    expect(gateDateText("0.0.9")).toBe("no ship date recorded");
    expect(gateEls()[0]!.getAttribute("data-date-state")).toBe("absent");
    expect(gateEls()[0]!.textContent ?? "").not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// ── AC29 — a consumed proposal renders no second gate ──────────────────────

describe("CR-CRU-078/AC29 — a consumed proposal leaves exactly ONE gate for its version", () => {
  test("before it ships, 0.2.0 is one PROPOSED gate", async () => {
    await mountApp({ releases: [SHIPPED_010], proposals: [PROPOSED_020] });
    const two = gateEls().filter((g) => g.getAttribute("data-version") === "0.2.0");
    expect(two.length).toBe(1);
    expect(two[0]!.getAttribute("data-kind")).toBe("proposed");
  });

  test("after it ships — CR-091 retires the proposal in the release's own transaction — 0.2.0 is one SHIPPED gate carrying its ship date, never a pair", async () => {
    await mountApp({ releases: [SHIPPED_020, SHIPPED_010], proposals: [] });
    const two = gateEls().filter((g) => g.getAttribute("data-version") === "0.2.0");
    expect(two.length).toBe(1);
    expect(two[0]!.getAttribute("data-kind")).toBe("shipped");
    expect(gateDateText("0.2.0")).toBe(Logic.formatReleaseDate(SHIPPED_020.releasedAt));
    expect(gateVersions()).toEqual(["0.2.0", "0.1.0"]);
  });
});

// ── §S9/AC33 — the two reads fail INDEPENDENTLY ────────────────────────────

describe("CR-CRU-078 §S9/AC33 — a failed proposals read leaves the shipped gates rendered", () => {
  test("a non-2xx proposals read degrades the strip, it does not blank it — no error banner over working data", async () => {
    await mountApp({ releases: shippedLedger(3), proposalsStatus: 500 });
    expect(gateVersions()).toEqual(["0.1.2", "0.1.1", "0.1.0"]);
    expect(gateKinds()).toEqual(["shipped", "shipped", "shipped"]);
    expect(strip().querySelector('[data-testid="roadmap-strip-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="roadmap-empty"]')).toBeNull();
  });

  test("a transport failure on the proposals read is the same degraded strip", async () => {
    await mountApp({ releases: shippedLedger(3), proposalsThrows: true });
    expect(gateVersions()).toEqual(["0.1.2", "0.1.1", "0.1.0"]);
  });

  test("proposals ALONE render too — the strip does not wait on the ledger to have shipped something", async () => {
    await mountApp({ releases: [], proposals: [PROPOSED_020, PROPOSED_030_UNDATED] });
    expect(gateVersions()).toEqual(["0.2.0", "0.3.0"]);
    expect(gateKinds()).toEqual(["proposed", "proposed"]);
  });

  test("with NOTHING registered the strip renders no chrome at all — no gates, no terminals, no tags (so C4's AC19 empty state stays reachable)", async () => {
    await mountApp({ releases: [], proposals: [], queue: [] });
    expect(stripEl()).toBeNull();
    expect(gateEls().length).toBe(0);
    expect(document.querySelectorAll('[data-testid="roadmap-strip-terminal"]').length).toBe(0);
    expect(tag("earlier")).toBeNull();
    expect(tag("later")).toBeNull();
  });
});

// ── §S2 — the strip's own structure ────────────────────────────────────────

describe("CR-CRU-078 §S2 — the strip is the release SEQUENCE, bracketed by its terminals", () => {
  test("one Start and one End terminal bracket the gates, and the gates carry their version as text", async () => {
    await mountApp({ releases: shippedLedger(2), proposals: [PROPOSED_020] });
    const terminals = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="roadmap-strip-terminal"]'),
    );
    expect(terminals.map((t) => t.getAttribute("data-terminal"))).toEqual(["start", "end"]);
    for (const version of ["0.1.1", "0.1.0", "0.2.0"]) {
      const gate = gateEls().find((g) => g.getAttribute("data-version") === version);
      expect(gate).toBeDefined();
      expect(gate!.textContent ?? "").toContain(version);
    }
  });
});
