// CR-CRU-096 C3 (cycle 311) — THE WAVE STATES ITS MERGED WORK AS ONE LINE, and
// each shown row carries its ANNOTATION on the right.
//
// Spec: docs/changes/CR-CRU-096-zone-2-drifts-from-the-approved-design.md
//       §S3 (the merged roll-up: a count plus the release's gate state, as
//       wave CHROME and not a CR row), §S4 (the annotation slot: `next` on the
//       first actionable row in the published order, `deps <ids>` on a pending
//       row that has them, and no tooltip), §S8 (shape and colour grammar —
//       the roll-up is not a CR rectangle; the `next` marker is text, never
//       `▸` and never ember).
//       AC5, AC6, AC6a, AC7, AC12, AC12a, AC13, AC14, AC15 — plus AC3, AC9 and
//       AC16 asserted here ONLY as non-regressions of C1 and C2, and AC29 on
//       every fixture below.
//
// Approved design: `.lavish/crucible-workflow-flowchart.html` §1's `div.flow`
//       for the ACTIVE release. Its wave box is, in order:
//         <h4><span>Wave 5 · active</span><span>28</span></h4>
//         <div class="wsum">21 merged ✓ · awaiting the tag</div>   ← §S3
//         <div class="crs">
//           <div class="cr pend">CR-…-095 <span class="t"><b>next</b> · deps 091, 092</span></div>
//           <div class="cr pend">CR-…-096 <span class="t">deps 078</span></div>
//           …
//           <div class="more">+2 more — see the table below</div>
//         </div>
//       with `.cr { display:flex; justify-content:space-between }`, so the
//       annotation rides in the row's RIGHT-HAND slot beside the status, and
//       `.wsum` is a LINE — no border, no background, not a rectangle.
//       (The artifact defeats shell `grep`; its bytes were read in Python.)
//
// SCOPE — the roll-up and the annotation slot only. The horizontal axis (§S6,
// AC20) and the shipped path (§S7, AC21–AC24) are cycle 312; the real-engine
// visual suite (AC27) is 313. The chip→row rewrite and the trim are C2's and
// are asserted here only where this cycle could break them. Zones 1 and 3 are
// out of scope entirely (AC26).
//
// Harness: tests/roadmap-wave-rows.test.ts (C2, cycle 310), verbatim — which
// took it from tests/roadmap-wave-header.test.ts (C1, cycle 309) and that from
// tests/roadmap-release-focus.test.ts (CR-CRU-078 C3): the REAL public/app.js
// shell driving its own fetch chain and van.js's real reactive scheduler
// inside happy-dom, with the box model stubbed because happy-dom runs no
// layout, and a per-mount cache-busted dynamic import of public/app-logic.mjs.
//
// WHAT IS ASSERTED, AND WHY IT IS NEVER A FUNCTION NAME. Every assertion below
// reads RENDERED text, PUBLISHED attributes, and the ABSENCE of chrome. WHERE
// the count and the annotations are computed is GREEN's to choose: the house
// pattern puts decisions in public/app-logic.mjs (`focusedReleaseView` already
// stamps each box with `active`, `rows` and `hiddenCount` — C1 and C2 both
// added their fact there) and the rendering in public/app.js, but nothing here
// names a function, a class, or a module.
//
// AC29 — EVERY FIXTURE ID IS SYNTHETIC (`CR-R-nn`, `CR-N-n`, `CR-P-n`,
// `CR-H-n`, `CR-K-n`, `CR-G-n`, `CR-D-nn`, `CR-U-n`, `CR-S-A`). Crucible is
// project-INDEPENDENT: a criterion that only holds while our own backlog has a
// given shape is not a criterion. CR ids named in comments and `describe`
// titles are provenance, never fixture data.
//
// RED phase — expected to FAIL against current production, which renders a
// header, `box.rows.map(RoadmapFlowNode)` and the `+N more` pointer
// (public/app.js:2792-2853) and NOTHING ELSE: there is no roll-up element and
// no annotation slot anywhere in the wave box.
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
const STYLES_SRC = readFileSync(path.join(REPO_ROOT, "public/styles.css"), "utf8");

// ── Fixture types (the wire shapes, as tests/roadmap-wave-rows.test.ts
//    declares them) ───────────────────────────────────────────────────────────

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

interface PackageFixture {
  registry: string;
  name: string;
  version: string;
}

/** `src/v2.ts:1755-1763` (`releaseBrief`) — what `GET …/releases` publishes. */
interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  packages?: PackageFixture[];
  timestamp: number;
}

/** `src/v2.ts:2045-2057` (`proposalBrief`) — what `GET …/release-proposals`
 *  publishes. */
interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

/** `src/types.ts` (`QueueEntry.lifecycle`) — the DISPOSITION axis. */
interface LifecycleFixture {
  state: "SUPERSEDED" | "VOID";
  by?: string;
  reason?: string;
  at: number;
}

/** `src/types.ts:389-414` (`QueueEntry`) — what `GET …/queue` publishes, in the
 *  canonical order (CR-CRU-095 §S1: release → wave → seq). The ORDER OF THIS
 *  ARRAY is the server's published order and the only order zone 2 may use
 *  (CR-CRU-091 AC18 forbids re-deriving `seq`; CR-CRU-095 deleted the last
 *  client-side sorter). */
interface QueueFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  planId?: number;
  seq?: number;
  release?: string;
  track?: string;
  lifecycle?: LifecycleFixture;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// One board shape, reused (C2's): 0.1.0 shipped, 0.4.0 proposed (the DEFAULT
// FOCUS — `releaseStripFocusIndex`, public/app-logic.mjs:179, focuses the
// first proposed gate, and 0.4.0's timestamp precedes 0.5.0's), 0.5.0 proposed
// but not focused. Every test swaps only the FOCUSED release's wave-1
// membership — and, for AC5, only the focused PROPOSAL's declared target.

const SHIP_010 = 1787149125; // 2026-08-19, epoch SECONDS
const TARGET_040 = 1790000000;

const SHIPPED_010: ReleaseFixture = {
  version: "0.1.0",
  commit: "c07274c",
  releasedAt: SHIP_010,
  crs: ["CR-S-A", "CR-S-B"],
  packages: [],
  timestamp: SHIP_010 * 1000,
};

const PROPOSED_040: ProposalFixture = {
  label: "0.4.0",
  targetAt: TARGET_040,
  timestamp: 1787000000,
  waves: ["1"],
};

/** AC5's three GATE STATES, which is the only thing that varies between these
 *  three: `resolveGateDate` (public/app-logic.mjs:80) answers `dated` for a
 *  usable epoch, `absent` for a proposal that declares no target, and
 *  `unusable` for a field that is there but is not a usable epoch. The roll-up
 *  states a phrase derived from THAT — nothing here writes a second resolver
 *  (CR-CRU-078 AC30).
 *
 *  `absent` is the ARTIFACT's own case: its focused 0.2.0 gate reads
 *  `no target declared` and its roll-up reads `21 merged ✓ · awaiting the tag`. */
const PROPOSED_040_NO_TARGET: ProposalFixture = {
  label: "0.4.0",
  timestamp: 1787000000,
  waves: ["1"],
};
const PROPOSED_040_BAD_TARGET: ProposalFixture = {
  label: "0.4.0",
  // A data defect, not a plan: the field is there and is not an epoch. Typed
  // through `unknown` because the WIRE can carry this and the type cannot.
  targetAt: "soon" as unknown as number,
  timestamp: 1787000000,
  waves: ["1"],
};

const PROPOSED_050: ProposalFixture = {
  label: "0.5.0",
  timestamp: 1787000001,
  waves: ["3"],
};

/** The other releases' members. Two of them are MERGED in 0.1.0, which is what
 *  makes AC6's "never the project total" non-vacuous: the project holds more
 *  merged CRs than the focused wave does. */
const OTHER_MEMBERS: QueueFixture[] = [
  { cr: "CR-S-A", title: "CR-S-A — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 1, release: "0.1.0" },
  { cr: "CR-S-B", title: "CR-S-B — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 2, release: "0.1.0" },
  { cr: "CR-U-1", title: "CR-U-1 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 900, release: "0.5.0" },
  { cr: "CR-U-2", title: "CR-U-2 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 910, release: "0.5.0" },
];
const OTHER_MERGED = 2;

/** A member of the focused release's wave `1`. `seq` is the STORED position the
 *  server published; nothing here may sort on it. */
function member(cr: string, status: QueueStatus, seq: number): QueueFixture {
  return {
    cr,
    title: `${cr} — synthetic member`,
    wave: "1",
    dependsOn: [],
    status,
    seq,
    release: "0.4.0",
    ...(status === "IN_PROGRESS" ? { planId: 41 } : {}),
  } satisfies QueueFixture;
}

/** A PENDING member that DECLARES dependencies — AC13's subject. The ids it
 *  names need not be members of this wave: a dependency is a declaration, and
 *  §S4's slot states what was declared. */
function pending(cr: string, seq: number, dependsOn: string[]): QueueFixture {
  return { ...member(cr, "PENDING", seq), dependsOn };
}

/** The board, with the focused wave's membership supplied. */
const board = (waveOne: QueueFixture[]): QueueFixture[] => [...OTHER_MEMBERS, ...waveOne];

/** §S5's default, C2's constant: five rows. */
const DEFAULT_ROWS = 5;

// ── AC6's fixture: a wave of 29 with 22 MERGED ──────────────────────────────
//
// 29 members, 22 merged, 7 actionable → 5 rows and a `+2 more` pointer. The
// roll-up must state 22:
//   • not 0, which is how many merged CRs are among the SHOWN rows (AC9 keeps
//     every one of them out), nor 1, the number AC6 names;
//   • not 24, the project total (the two merged 0.1.0 members above);
//   • not 5, 7, 2 or 29 — the trim's own numbers and the header's.
// AC6a is exercised rather than assumed: ONE of the 22 is
// COMPLETED_UNTRACKED, so a roll-up counting only `COMPLETED` answers 21 and
// the untracked member is counted nowhere and drawn nowhere — the exact
// disappearance AC6a was ruled to prevent. It is deliberately NOT the first
// member: a count over the whole wave cannot depend on where it sits.
const R29_SIZE = 29;
const R29_MERGED = 22;
const R29_UNTRACKED_INDEX = 9; // CR-R-10
const R29: QueueFixture[] = Array.from({ length: R29_SIZE }, (_, i) =>
  member(
    `CR-R-${String(i + 1).padStart(2, "0")}`,
    i === R29_UNTRACKED_INDEX ? "COMPLETED_UNTRACKED" : i < R29_MERGED ? "COMPLETED" : "PENDING",
    (i + 1) * 10,
  ),
);
const R29_MERGED_IDS = R29.filter(
  (e) => e.status === "COMPLETED" || e.status === "COMPLETED_UNTRACKED",
).map((e) => e.cr);
const R29_COMPLETED_ONLY = R29.filter((e) => e.status === "COMPLETED").length; // 21
const R29_ACTIONABLE = R29_SIZE - R29_MERGED; // 7
const R29_PROJECT_MERGED = R29_MERGED + OTHER_MERGED; // 24

// ── AC12's fixture: the first actionable row in the PUBLISHED order ─────────
//
// Published order is deliberately NOT `seq` order, so "first actionable" has
// two demonstrably different answers and the test cannot pass by coincidence:
// published says CR-N-5, a `seq` re-sorter (CR-CRU-091 AC18's outlawed second
// oracle) says CR-N-3. Two merged members lead, so "first" is also not "first
// member of the wave". Four actionable → four rows, no pointer.
const NEXT_ORDER: QueueFixture[] = [
  member("CR-N-1", "COMPLETED", 10),
  member("CR-N-2", "COMPLETED_UNTRACKED", 20),
  member("CR-N-5", "PENDING", 50),
  member("CR-N-3", "PENDING", 30),
  member("CR-N-4", "PENDING", 40),
  member("CR-N-6", "PENDING", 60),
];
const NEXT_ORDER_ROWS = ["CR-N-5", "CR-N-3", "CR-N-4", "CR-N-6"];
const NEXT_ORDER_MARKED = "CR-N-5";
const NEXT_ORDER_SEQ_FIRST = "CR-N-3";

/** AC12 against a RUNNING member: IN_PROGRESS is not actionable (`PENDING`
 *  with no `lifecycle`, `clients/_crucible_axi.py:1301`), so the runner is a
 *  row (AC9's union) but never the marked one — and the marked row is the
 *  first PENDING member, which here is published after it. Both are on ONE
 *  render, which is what lets the marked row's styling be compared against the
 *  ember the runner really does earn. */
const NEXT_WITH_RUNNER: QueueFixture[] = [
  member("CR-P-1", "IN_PROGRESS", 10),
  member("CR-P-2", "PENDING", 20),
  member("CR-P-3", "PENDING", 30),
];
const RUNNER_MARKED = "CR-P-2";

/** AC12a — the fixture the AC itself states: the first actionable row has an
 *  UNSATISFIED dependency. `CR-H-2` depends on `CR-H-1`, which is IN_PROGRESS
 *  and therefore neither merged nor actionable, so:
 *    • the plan pointer's answer here is HOLD with `CR-H-1` as the trigger
 *      (`resolve_next`, `clients/_crucible_axi.py:1473`) — a state zone 2 does
 *      not represent at all;
 *    • a dependency walk that "skipped to the next satisfiable CR" would mark
 *      `CR-H-3`, which declares nothing.
 *  The marker states POSITION IN THE PUBLISHED ORDER, so it is on `CR-H-2`.
 *  That is what makes this fixture a discriminator rather than a restatement
 *  of AC12: three readings, three different answers. */
const HOLD_SHAPE: QueueFixture[] = [
  member("CR-H-1", "IN_PROGRESS", 10),
  pending("CR-H-2", 20, ["CR-H-1"]),
  pending("CR-H-3", 30, []),
  pending("CR-H-4", 40, ["CR-H-1", "CR-H-2"]),
];
const HOLD_MARKED = "CR-H-2";
const HOLD_SKIP_ANSWER = "CR-H-3";

/** AC13's fixture — a row declaring FOUR dependencies, which the AC names as
 *  the widest real case observed and the width budget's measure. The dep ids
 *  are synthetic and carry DISTINCT numeric tails, so the assertion holds
 *  whether the slot names the full id or (as the artifact's own
 *  `deps 091, 092` does) its tail. `CR-K-1` is also the first actionable row,
 *  so this fixture pins the artifact's COMBINED slot — `next · deps …` — and
 *  `CR-K-3` declares nothing, which is AC13's "no deps → no annotation". */
const FOUR_DEPS = ["CR-D-11", "CR-D-22", "CR-D-33", "CR-D-44"];
const ONE_DEP = ["CR-D-55"];
const DEPS_WAVE: QueueFixture[] = [
  pending("CR-K-1", 10, FOUR_DEPS),
  pending("CR-K-2", 20, ONE_DEP),
  pending("CR-K-3", 30, []),
];

/** AC15 — the drill regression. `roadmapDrillable` is `IN_PROGRESS ||
 *  COMPLETED` (public/app.js:2678) and merged CRs no longer render rows, so
 *  the ONE drillable row a wave box can hold is a running one. The PENDING row
 *  beside it is the marked one, and clicking THAT must still do what a row
 *  click has always done — select — with the annotation not swallowing it. */
const DRILL_WAVE: QueueFixture[] = [
  member("CR-G-1", "IN_PROGRESS", 10),
  member("CR-G-2", "PENDING", 20),
];

// ── Harness (tests/roadmap-wave-rows.test.ts, verbatim) ─────────────────────

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
  cycles: { id: number; label: string; status: string }[];
}

interface MountOpts {
  key?: string;
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  queue?: QueueFixture[];
  plans?: PlanFixture[];
}

/** happy-dom runs no layout engine, so the strip would measure a zero track
 *  and render a zero-gate window — and zone 2 reads its focus from the strip's
 *  own sequence. The box model is supplied exactly as the sibling suites
 *  supply it: wide enough that every fixture gate fits one window, so nothing
 *  here depends on paging. */
const TRACK_W = 800;
const PITCH = 100;

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

function installLayout(): void {
  const proto = globalThis.Element.prototype as unknown as {
    getBoundingClientRect: (this: Element) => DOMRect;
  };
  proto.getBoundingClientRect = function measured(this: Element): DOMRect {
    const testid = this.getAttribute("data-testid") ?? "";
    if (testid === "roadmap-strip-track") return rect(0, TRACK_W);
    if (testid === "roadmap-strip-ruler") return rect(0, PITCH);
    return rect(0, 0);
  };
}

let cacheBust = 0;

async function mountApp(opts: MountOpts = {}): Promise<void> {
  const key = opts.key ?? "wave-rollup-key";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    // Order matters: `/release-proposals` must not be swallowed by `/releases`.
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      const proposals = opts.proposals ?? [PROPOSED_040, PROPOSED_050];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [SHIPPED_010] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? board(R29) });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) {
      return okResponse({ ok: true, plans: opts.plans ?? [] });
    }
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) {
      return okResponse({
        ok: true,
        projects: [
          {
            key,
            name: key,
            type: "backend",
            agentsOnline: 0,
            agentsTotal: 0,
            active: true,
            lastActivity: Date.now(),
          },
        ],
      });
    }
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    throw new Error(`roadmap-wave-rollup.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapWaveRollup=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production shell driving its
 *  own fetch chain and van.js's real reactive scheduler. */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

const norm = (text: string | null): string => (text ?? "").replace(/\s+/g, " ").trim();

function flow(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="roadmap-flow"]');
  if (el === null) throw new Error('no [data-testid="roadmap-flow"] rendered');
  return el;
}

function zone2(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-zone="2"]');
  if (el === null) throw new Error('no [data-zone="2"] rendered');
  return el;
}

const waveEls = (): HTMLElement[] => all('[data-testid="roadmap-wave"]');
const waveNames = (): string[] => waveEls().map((w) => w.getAttribute("data-wave") ?? "");

function waveEl(wave: string): HTMLElement {
  const box = waveEls().find((w) => w.getAttribute("data-wave") === wave);
  if (box === undefined) {
    throw new Error(`no wave container rendered for wave ${wave} (have: ${waveNames().join(", ")})`);
  }
  return box;
}

/** The wave's ROWS, read through the node selector AC28 pins and scoped to the
 *  wave box exactly as the e2e step scopes it
 *  (`tests/e2e/steps/roadmap-graph.steps.ts:84`). */
const rowEls = (wave: string): HTMLElement[] =>
  Array.from(waveEl(wave).querySelectorAll<HTMLElement>('[data-testid="roadmap-node"]'));

const rowCrs = (wave: string): string[] =>
  rowEls(wave).map((row) => row.getAttribute("data-cr") ?? "");

const rowStatuses = (wave: string): string[] =>
  rowEls(wave).map((row) => row.getAttribute("data-status") ?? "");

function rowFor(wave: string, cr: string): HTMLElement {
  const row = rowEls(wave).find((el) => el.getAttribute("data-cr") === cr);
  if (row === undefined) {
    throw new Error(`wave ${wave} renders no row for ${cr} (rows: ${rowCrs(wave).join(", ")})`);
  }
  return row;
}

const moreEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-more"]');

function headerEl(wave: string): HTMLElement {
  const header = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-header"]');
  if (header === null) throw new Error(`wave ${wave} renders no [data-testid="roadmap-wave-header"]`);
  return header;
}

function countText(wave: string): string {
  const el = headerEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-count"]');
  if (el === null) throw new Error(`wave ${wave}'s header renders no [data-testid="roadmap-wave-count"]`);
  return norm(el.textContent);
}

/** The element the rows sit in, DERIVED from the rendered rows rather than
 *  named (C2's reader): the roll-up must be OUTSIDE it. */
function rowContainer(wave: string): HTMLElement {
  const rows = rowEls(wave);
  if (rows.length === 0) throw new Error(`wave ${wave} renders no rows to contain`);
  const parent = rows[0]!.parentElement;
  if (parent === null) throw new Error(`wave ${wave}'s rows have no parent element`);
  return parent;
}

// ── The two selectors this cycle INTRODUCES ────────────────────────────────
//
// `roadmap-wave-rollup` — §S3's line. Named rather than read out of the box's
// text because AC7 asserts what the element IS NOT (no CR identity, not
// selectable, not a rectangle), and those are statements about one element.
//
// `roadmap-node-annotation` — §S4's slot. Named because AC13's second half is
// an ABSENCE ("no deps → no annotation"), and "no element" is the only
// unambiguous way to state it.

const rollupEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-rollup"]');

function rollupElOrThrow(wave: string): HTMLElement {
  const el = rollupEl(wave);
  if (el === null) {
    throw new Error(
      `wave ${wave} renders no [data-testid="roadmap-wave-rollup"] line (box text: ${norm(waveEl(wave).textContent)})`,
    );
  }
  return el;
}

const rollupText = (wave: string): string => norm(rollupElOrThrow(wave).textContent);

/** The MERGED COUNT the roll-up states — the number it puts in front of the
 *  word. Read positionally rather than as "the one number in the line" because
 *  the gate phrase may legitimately carry a date, which has digits of its own. */
function rollupCount(wave: string): number {
  const text = rollupText(wave);
  const found = /(\d+)\s+merged\b/i.exec(text);
  if (found === null) {
    throw new Error(`wave ${wave}'s roll-up states no \`N merged\` count — it reads "${text}"`);
  }
  return Number(found[1]);
}

/** Everything the roll-up says AFTER `N merged` — AC5's gate-state phrase,
 *  with the artifact's own separators (`✓`, `·`) trimmed off the front so the
 *  assertion is on the PHRASE and not on the punctuation, which no AC states. */
function rollupPhrase(wave: string): string {
  const text = rollupText(wave);
  const at = text.toLowerCase().indexOf("merged");
  if (at < 0) throw new Error(`wave ${wave}'s roll-up says nothing about merged work: "${text}"`);
  return text
    .slice(at + "merged".length)
    .replace(/^[\s✓·—–-]+/u, "")
    .trim();
}

const annotationEl = (row: HTMLElement): HTMLElement | null =>
  row.querySelector<HTMLElement>('[data-testid="roadmap-node-annotation"]');

/** The annotation a row states, or `""` when it states none. AC13's absent
 *  half is satisfied either by no element or by an empty one — "no annotation"
 *  is about what a reader sees, so both answers are the same fact and neither
 *  is over-constrained here. */
const annotationText = (row: HTMLElement): string => norm(annotationEl(row)?.textContent ?? "");

const annotationOf = (wave: string, cr: string): string => annotationText(rowFor(wave, cr));

/** Which rows claim to be `next`. The marker is a WORD (AC12/§S8), so it is
 *  found as one — not as a class, an attribute, or a glyph. */
const markedRows = (wave: string): string[] =>
  rowEls(wave)
    .filter((row) => /\bnext\b/i.test(annotationText(row)))
    .map((row) => row.getAttribute("data-cr") ?? "");

// ── The CSS reader: what the SHIPPED stylesheet declares for a real element ──
//
// C1's `animatingSelectors` (tests/roadmap-wave-header.test.ts:409) as C2
// generalised it: every rule in public/styles.css that declares `prop` is
// collected, and the LAST one whose selector the given element MATCHES wins —
// source order, specificity ignored, which for this stylesheet's flat
// single-class rules is the same answer and is conservative where it is not.
// Comments are stripped first: a `/* … */` between one rule's `}` and the next
// selector is otherwise swallowed into that selector.
//
// WHICH HALF IS DEFERRED TO CYCLE 313's CHROMIUM SUITE (AC27), deliberately:
// happy-dom has no cascade and no layout, so the RENDERED colour of the `next`
// marker, the RENDERED absence of a border and background on the roll-up, and
// the annotation's measured width against §S6's four-dep budget cannot be
// measured here. What IS measured here is what the shipped stylesheet
// DECLARES for the real rendered elements — which is the half that can be
// checked without an engine, and it is checked against the ember values the
// running row really does earn on the SAME render rather than against a
// hardcoded token.

function declaredValue(css: string, el: Element, prop: string): string | null {
  const decommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = decommented.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const declaration = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i");
  let value: string | null = null;
  for (const match of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const found = declaration.exec(match[2] ?? "");
    if (found === null) continue;
    for (const selector of (match[1] ?? "").split(",")) {
      const trimmed = selector.trim();
      if (trimmed === "") continue;
      let hit = false;
      try {
        hit = el.matches(trimmed);
      } catch {
        hit = false;
      }
      if (hit) {
        value = (found[1] ?? "").trim().toLowerCase();
        break;
      }
    }
  }
  return value;
}

const declared = (el: Element, prop: string): string | null => declaredValue(STYLES_SRC, el, prop);

/** AC7's "not a CR rectangle", stated as what the stylesheet gives the element
 *  versus what it gives a REAL CR row on the same render: a rectangle is a
 *  border plus a fill, and a node also takes `cursor: pointer` because it is a
 *  control. An aggregate takes none of the three. */
function rectangleFaults(el: HTMLElement, node: HTMLElement, label: string): string[] {
  const faults: string[] = [];
  const bare = (value: string | null): boolean =>
    value === null || value === "none" || value === "0" || value === "0px" || value === "transparent";
  for (const prop of ["border", "border-width", "border-style", "background", "background-color"]) {
    const mine = declared(el, prop);
    const theirs = declared(node, prop);
    if (mine !== null && theirs !== null && mine === theirs) {
      faults.push(`${label} declares the CR rectangle's ${prop}: ${mine}`);
    } else if (prop === "border" && !bare(mine)) {
      faults.push(`${label} declares a border of its own: ${mine}`);
    } else if (prop === "background" && !bare(mine)) {
      faults.push(`${label} declares a fill of its own: ${mine}`);
    }
  }
  if (declared(el, "cursor") === "pointer") faults.push(`${label} declares cursor: pointer`);
  const inline = (el.getAttribute("style") ?? "").toLowerCase();
  if (/border|background/.test(inline)) faults.push(`${label} carries inline ${inline}`);
  return faults;
}

/** The board C1 proved focuses 0.4.0. Asserted, not assumed. */
function expectFocused040(): void {
  expect(flow().getAttribute("data-kind")).toBe("proposed");
  expect(flow().getAttribute("data-version")).toBe("0.4.0");
  expect(waveNames()).toEqual(["1"]);
}

/** The gate state the focused release actually resolved to, read off the
 *  render itself (`public/app.js:2910`). Every AC5 fixture asserts this before
 *  it asserts a phrase, so a phrase can never be attributed to the wrong
 *  state. */
function gateState(): string {
  const gate = document.querySelector<HTMLElement>('[data-testid="roadmap-flow-gate"]');
  if (gate === null) throw new Error('no [data-testid="roadmap-flow-gate"] rendered');
  return gate.getAttribute("data-date-state") ?? "";
}

// ── §S3/AC5 — the wave states its merged work as ONE LINE ──────────────────

describe("CR-CRU-096 §S3/AC5 — the wave renders the roll-up: `N merged` plus the release's gate-state phrase", () => {
  test("the roll-up is one line above the rows, inside the wave box, stating the merged count and a phrase derived from the gate's own resolved state", async () => {
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();

    // The artifact's own board: an in-flight release with NO declared target,
    // whose gate reads `no target declared` and whose roll-up reads
    // `21 merged ✓ · awaiting the tag`.
    expect(gateState()).toBe("absent");

    const rollup = rollupElOrThrow("1");
    const text = rollupText("1");

    // Both halves, in the design's own order: the count first, the gate phrase
    // after it.
    expect(text).toContain(`${R29_MERGED} merged`);
    expect(rollupCount("1")).toBe(R29_MERGED);
    // §S3's phrase for THIS state is the approved artifact's own words, which
    // the spec quotes: "the design states the merged CRs as one line —
    // `21 merged ✓ awaiting the tag` — a count plus the release's gate state".
    expect(rollupPhrase("1").toLowerCase()).toContain("awaiting the tag");
    // AC7/§S8 — it is a LINE of text, so its two facts survive greyscale.
    expect(text.toLowerCase()).toMatch(/\bmerged\b/);

    // WHERE it renders: AC5c rules the roll-up a SIBLING of the header `h4`,
    // inside the wave box, after the header and before every row. §S3's
    // "inside the wave header block" reads that way and only that way — a
    // `div` inside an `h4` is invalid HTML — so the approved artifact's
    // placement is the AC.
    expect(waveEl("1").contains(rollup)).toBe(true);
    expect(rowContainer("1").contains(rollup)).toBe(false);
    // The sibling ruling itself: the header really is the `h4`, it does NOT
    // contain the roll-up, and the two share one parent.
    expect(headerEl("1").tagName).toBe("H4");
    expect(headerEl("1").contains(rollup)).toBe(false);
    expect(rollup.parentElement).toBe(headerEl("1").parentElement);
    const order = Array.from(waveEl("1").querySelectorAll<HTMLElement>("*"));
    expect(order.indexOf(rollup)).toBeGreaterThan(order.indexOf(headerEl("1")));
    for (const row of rowEls("1")) {
      expect(order.indexOf(rollup)).toBeLessThan(order.indexOf(row));
    }
    // And it is one LINE, not a stack: no nested rows, no nested wave chrome.
    expect(rollup.querySelector('[data-testid="roadmap-node"]')).toBeNull();
    expect(rollup.querySelector('[data-testid="roadmap-wave-more"]')).toBeNull();
  });

  test("the phrase is a function of `resolveGateDate`'s state and of nothing else: it never invents a date the gate has not got, and two different waves at the same gate state read the same", async () => {
    // `absent` — no target declared.
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();
    expect(gateState()).toBe("absent");
    const absentPhrase = rollupPhrase("1");
    expect(absentPhrase).not.toBe("");
    // AC5's phrase comes from the gate STATE, so an absent target cannot
    // produce a day: `formatReleaseDate` answers `""` for one and
    // `resolveGateDate` reports `absent` precisely so the surface says why it
    // is empty rather than conjuring 1970 (public/app-logic.mjs:43-46).
    expect(absentPhrase).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    // The SAME state on a different wave: the phrase is a projection of the
    // gate, not of the membership, so it does not move when the members do.
    await mountApp({ queue: board(NEXT_ORDER), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();
    expect(gateState()).toBe("absent");
    expect(rollupPhrase("1")).toBe(absentPhrase);
    // Non-vacuity: the COUNT did move, so the two renders really are different.
    expect(rollupCount("1")).toBe(2);

    // `unusable` — the field is there and is not an epoch. A data defect must
    // not read as a plan nobody authored (public/app-logic.mjs:69-70), so this
    // state also states a phrase and also states no day.
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_BAD_TARGET, PROPOSED_050] });
    expectFocused040();
    expect(gateState()).toBe("unusable");
    expect(rollupPhrase("1")).not.toBe("");
    expect(rollupPhrase("1")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(rollupCount("1")).toBe(R29_MERGED);

    // `dated` — a declared target. The roll-up still states both halves.
    // SPEC SILENCE, deliberately not invented here: §S3 quotes the phrase for
    // exactly one state (`absent` → "awaiting the tag") and no AC gives the
    // wording for `dated` or `unusable`, nor says whether a dated proposal's
    // phrase names its target day. So the three phrases are asserted to EXIST
    // and to be state-derived; whether `dated` reads differently from
    // `absent` is GREEN's to choose and this suite does not pin it.
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040, PROPOSED_050] });
    expectFocused040();
    expect(gateState()).toBe("dated");
    expect(rollupCount("1")).toBe(R29_MERGED);
    expect(rollupPhrase("1")).not.toBe("");
  });
});

// ── §S3/AC6 + AC6a — the count is the WHOLE wave's merged work ──────────────

describe("CR-CRU-096 §S3/AC6/AC6a — the roll-up counts merged over the WHOLE wave, `COMPLETED` and `COMPLETED_UNTRACKED` alike", () => {
  test("a 29-member wave with 22 merged renders `22 merged` — not the shown rows, not the project total, and not the count of `COMPLETED` alone", async () => {
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();

    // Non-vacuity of the fixture itself, before anything is read off the DOM.
    expect(R29.length).toBe(R29_SIZE);
    expect(R29_MERGED_IDS.length).toBe(R29_MERGED);
    expect(R29_COMPLETED_ONLY).toBe(R29_MERGED - 1);
    expect(R29_PROJECT_MERGED).toBe(R29_MERGED + OTHER_MERGED);

    expect(rollupCount("1")).toBe(R29_MERGED);
    expect(rollupText("1")).toContain(`${R29_MERGED} merged`);

    // AC6's own prohibitions, each named as the number it must not be:
    //   • the merged CRs among the SHOWN rows — AC9 keeps every one of them
    //     out, so that number is 0, and AC6 names 1 as the wrong answer a
    //     trim-scoped count could produce;
    //   • the PROJECT total, which this board deliberately makes larger.
    const mergedShown = rowStatuses("1").filter(
      (status) => status === "COMPLETED" || status === "COMPLETED_UNTRACKED",
    ).length;
    expect(mergedShown).toBe(0);
    expect(rollupCount("1")).not.toBe(mergedShown);
    expect(rollupCount("1")).not.toBe(1);
    expect(rollupCount("1")).not.toBe(R29_PROJECT_MERGED);
    // Nor any of the numbers the trim and the header produce.
    expect(rollupCount("1")).not.toBe(R29_SIZE);
    expect(rollupCount("1")).not.toBe(DEFAULT_ROWS);
    expect(rollupCount("1")).not.toBe(R29_ACTIONABLE);
    // AC6a — counting `COMPLETED` alone answers 21, and the untracked member
    // would then be counted nowhere and drawn nowhere.
    expect(rollupCount("1")).not.toBe(R29_COMPLETED_ONLY);
  });

  test("the `COMPLETED_UNTRACKED` member is inside the count and outside the rows — one fact at two luminances, never a member that vanishes", async () => {
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();

    const untracked = R29.filter((e) => e.status === "COMPLETED_UNTRACKED");
    expect(untracked.map((e) => e.cr)).toEqual(["CR-R-10"]);

    // Rolled UP: the count includes it (22, not 21 — asserted above) and no
    // row draws it (AC9 through AC6a's set).
    expect(rowCrs("1")).not.toContain("CR-R-10");
    expect(rowStatuses("1")).not.toContain("COMPLETED_UNTRACKED");
    expect(rollupCount("1")).toBe(R29_MERGED);

    // And the whole merged set is out of the rows, not just that one.
    for (const merged of R29_MERGED_IDS) expect(rowCrs("1")).not.toContain(merged);

    // SPEC SILENCE, recorded and NOT pinned: no AC says what a wave with ZERO
    // merged members renders. `+N more` has an explicit absent clause (AC16)
    // and the roll-up has none, so both "no line" and "`0 merged` plus the
    // phrase" satisfy AC5 as written. Nothing in this file asserts either way,
    // and the fixtures that hold no merged member (`NEXT_WITH_RUNNER`,
    // `HOLD_SHAPE`, `DEPS_WAVE`, `DRILL_WAVE`) never read the roll-up.
    expect(R29_MERGED).toBeGreaterThan(0);
  });
});

// ── §S3/AC7 + §S8 — the roll-up is NOT a CR rectangle ──────────────────────

describe("CR-CRU-096 §S3/AC7 — the roll-up is wave chrome: no CR identity, not selectable, not drillable, not a rectangle", () => {
  test("it carries none of a row's identity attributes and none of a row's classes, and clicking it selects nothing and drills nowhere", async () => {
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();

    const rollup = rollupElOrThrow("1");
    const node = rowEls("1")[0]!;

    // §S8 — "shape encodes KIND and a rectangle means exactly one CR", so an
    // aggregate carries no CR identity: nothing selects it, nothing drills it,
    // and no `roadmap-node` consumer counts it.
    expect(rollup.getAttribute("data-testid")).not.toBe("roadmap-node");
    expect(rollup.getAttribute("data-cr")).toBeNull();
    expect(rollup.getAttribute("data-status")).toBeNull();
    expect(rollup.getAttribute("data-selected")).toBeNull();
    expect(rollup.getAttribute("data-drill-source")).toBeNull();
    expect(rollup.getAttribute("data-seq")).toBeNull();
    expect(rollup.getAttribute("data-lifecycle")).toBeNull();
    expect(rollup.querySelector('[data-testid="roadmap-node"]')).toBeNull();
    // The wave box still holds exactly its rows as nodes — the roll-up is not
    // one of them (the e2e step counts nodes inside the box).
    expect(waveEl("1").querySelectorAll('[data-testid="roadmap-node"]').length).toBe(DEFAULT_ROWS);

    // No CR-NODE CLASS: derived from a real rendered row rather than named, so
    // this holds whatever classes GREEN picks.
    const nodeClasses = Array.from(node.classList);
    expect(nodeClasses.length).toBeGreaterThan(0);
    for (const cls of Array.from(rollup.classList)) {
      expect(nodeClasses).not.toContain(cls);
    }

    // Not a control: van assigns `on*` props to the element, so an unhandled
    // element really does read `null` here.
    expect(rollup.onclick).toBeNull();
    expect(rollup.getAttribute("onclick")).toBeNull();

    // And behaviourally inert — the two things a CR rectangle's click does,
    // neither of which an aggregate may do.
    const selectedBefore = all('[data-selected="true"]').length;
    const tabsBefore = all('[data-testid="workspace-tab"].on').map((tab) => norm(tab.textContent));
    rollup.click();
    await settle();
    expect(all('[data-selected="true"]').length).toBe(selectedBefore);
    expect(all('[data-testid="workspace-tab"].on').map((tab) => norm(tab.textContent))).toEqual(
      tabsBefore,
    );
    expect(window.location.pathname).toContain("/roadmap");
    // Still says the same thing after the click: nothing about it is stateful.
    expect(rollupCount("1")).toBe(R29_MERGED);
  });

  test("the stylesheet gives it neither the CR rectangle's border and fill nor a pointer cursor", async () => {
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();

    const rollup = rollupElOrThrow("1");
    const node = rowEls("1")[0]!;

    // Non-vacuity: the CR row really IS a bordered, filled, clickable
    // rectangle in the shipped stylesheet (public/styles.css:1323-1335), so
    // "the aggregate declares none of that" is a real difference and not an
    // assertion about two elements that both declare nothing.
    expect(declared(node, "border")).not.toBeNull();
    expect(declared(node, "background")).not.toBeNull();
    expect(declared(node, "cursor")).toBe("pointer");

    // The DECLARED half. The RENDERED half — computed border, computed
    // background, the line's measured height — is cycle 313's Chromium suite
    // (AC27): happy-dom has no cascade to compute and no engine to measure.
    expect(rectangleFaults(rollup, node, "the roll-up")).toEqual([]);
  });
});

// ── §S4/AC12 — `next` on the first actionable row in the PUBLISHED order ────

describe("CR-CRU-096 §S4/AC12 — the first actionable row in the published order is marked `next`, as text, exactly once", () => {
  test("a wave published out of `seq` order marks the row the SERVER put first, in the row's own annotation slot", async () => {
    await mountApp({ queue: board(NEXT_ORDER) });
    expectFocused040();

    // Non-vacuity: the published answer and a `seq` re-sorter's answer differ,
    // so the marker cannot land on the right row by coincidence. CR-CRU-091
    // AC18 forbids the client re-deriving `seq`; CR-CRU-095 §S1 deleted the
    // last client-side sorter.
    expect(NEXT_ORDER_MARKED).not.toBe(NEXT_ORDER_SEQ_FIRST);
    expect(rowCrs("1")).toEqual(NEXT_ORDER_ROWS);

    // EXACTLY ONE row marked, and it is the first actionable one published —
    // not the first MEMBER (two merged lead the wave) and not the `seq` head.
    expect(markedRows("1")).toEqual([NEXT_ORDER_MARKED]);
    expect(annotationOf("1", NEXT_ORDER_MARKED).toLowerCase()).toMatch(/\bnext\b/);
    expect(annotationOf("1", NEXT_ORDER_SEQ_FIRST).toLowerCase()).not.toMatch(/\bnext\b/);

    // The slot rides in the ROW's right-hand side, after the id — the
    // artifact's `.cr { justify-content: space-between }` with the id left and
    // `<span class="t">` right. Read as text so §S8's greyscale invariant is
    // what is pinned.
    const marked = rowFor("1", NEXT_ORDER_MARKED);
    const text = norm(marked.textContent);
    expect(text.startsWith(NEXT_ORDER_MARKED)).toBe(true);
    expect(text.toLowerCase().indexOf("next")).toBeGreaterThan(text.indexOf(NEXT_ORDER_MARKED));
    // It is an annotation, not a status: the row still states its status too.
    expect(text.toLowerCase()).toContain("pending");
    // And it lives inside the row, not beside it (a sibling would not survive
    // the row's own selection outline or its click).
    const slot = annotationEl(marked);
    expect(slot, `${NEXT_ORDER_MARKED} renders no annotation slot`).not.toBeNull();
    expect(marked.contains(slot)).toBe(true);
  });

  test("the marker is TEXT on a row that keeps PENDING styling — never `▸`, never ember, never motion", async () => {
    // One render holding BOTH a running row and the marked row, so the ember
    // the marker must not borrow is read off the element that really earns it.
    await mountApp({ queue: board(NEXT_WITH_RUNNER) });
    expectFocused040();

    expect(rowCrs("1")).toEqual(["CR-P-1", "CR-P-2", "CR-P-3"]);

    const runner = rowFor("1", "CR-P-1");
    const plain = rowFor("1", "CR-P-3");

    // The EMBER and the MOTION, read off the element that really earns them —
    // asserted FIRST so this reader is exercised against a real rendered row
    // while the marker below is still red, and so the comparison target is
    // the shipped grammar rather than a hardcoded token
    // (public/styles.css:1372-1377).
    expect(declared(runner, "animation")).not.toBeNull();
    const ember = declared(runner, "color");
    expect(ember).not.toBeNull();
    // `▶` is IN_PROGRESS's own status mark (`▶ in progress`,
    // public/app-logic.mjs:1015) and rides on the RUNNER's row, so it is the
    // MARKED row and the marker that may not wear it. `▸` is what §5 reserves
    // and live introduces none — the zone-wide prohibition holds today and
    // must survive this cycle.
    expect(norm(runner.textContent)).toContain("▶");
    expect(zone2().textContent ?? "").not.toContain("▸");

    // IN_PROGRESS is not actionable, so the runner is a row and never the
    // marked one; the marked row is the first PENDING member published.
    expect(markedRows("1")).toEqual([RUNNER_MARKED]);

    const marked = rowFor("1", RUNNER_MARKED);

    // PENDING STYLING KEPT: the published status is untouched and the row
    // carries the same status class an unmarked pending row carries.
    expect(marked.getAttribute("data-status")).toBe("PENDING");
    expect(marked.className).toContain("pending");
    expect(marked.className).not.toContain("in_progress");

    // NEITHER GLYPH on the marked row itself.
    expect(norm(marked.textContent)).not.toContain("▸");
    expect(norm(marked.textContent)).not.toContain("▶");

    // NEITHER EMBER NOR MOTION, in what the shipped stylesheet DECLARES for
    // the real elements.
    for (const [label, el] of [
      ["the marked row", marked],
      ["the marker", annotationEl(marked) ?? marked],
    ] as const) {
      expect(declared(el, "animation"), `${label} declares motion`).toBeNull();
      expect(declared(el, "color"), `${label} borrows the ember`).not.toBe(ember);
      expect(declared(el, "border-color"), `${label} borrows the ember border`).not.toBe(ember);
    }
    // The marked row is styled exactly as an unmarked pending row is: the
    // scheduling fact adds a word, not a state.
    expect(declared(marked, "color")).toBe(declared(plain, "color"));
    expect(declared(marked, "border-color")).toBe(declared(plain, "border-color"));
    // The RENDERED colour and the RENDERED motion are cycle 313's Chromium
    // suite (AC27); this harness has no cascade to compute either.
  });
});

// ── §S4/AC12a — position in the published order, NOT the plan pointer ───────

describe("CR-CRU-096 §S4/AC12a — the marker states position in the published order and nothing else", () => {
  test("a first actionable row with an UNSATISFIED dependency is still the marked one, and no NEXT/HOLD/DRAINED vocabulary enters the zone", async () => {
    await mountApp({ queue: board(HOLD_SHAPE) });
    expectFocused040();

    // The fixture's three competing answers, asserted as a fixture fact so the
    // discrimination is visible without reading the production code:
    //   • published order      → CR-H-2 (marked);
    //   • the plan pointer     → HOLD, trigger CR-H-1 (unmerged, in flight);
    //   • a dependency walk    → skip to CR-H-3, which declares nothing.
    expect(rowCrs("1")).toEqual(["CR-H-1", "CR-H-2", "CR-H-3", "CR-H-4"]);
    const trigger = HOLD_SHAPE.find((e) => e.cr === "CR-H-1")!;
    expect(trigger.status).toBe("IN_PROGRESS");
    expect(HOLD_SHAPE.find((e) => e.cr === HOLD_MARKED)!.dependsOn).toEqual(["CR-H-1"]);
    expect(HOLD_SHAPE.find((e) => e.cr === HOLD_SKIP_ANSWER)!.dependsOn).toEqual([]);

    // NO PLAN-POINTER VOCABULARY anywhere in the zone: zone 2 renders no HOLD
    // and no DRAINED state, and names no trigger. Rendering them would mean
    // reimplementing `resolve_next` in JS — a second oracle in a second
    // language, which CR-091 AC18 outlawed and CR-095 §S1 spent five cycles
    // deleting. The published reading is CR-CRU-098's.
    const zoneText = norm(zone2().textContent).toLowerCase();
    expect(zoneText).not.toMatch(/\bhold\b/);
    expect(zoneText).not.toMatch(/\bdrained\b/);
    expect(zoneText).not.toMatch(/\btrigger\b/);
    expect(zoneText).not.toMatch(/\bblocked\b/);
    expect(zoneText).not.toMatch(/\bwaiting on\b/);

    // THE MARKER, on the row the published order puts first — asserted after
    // the prohibition above so that reader runs against a real render.
    expect(markedRows("1")).toEqual([HOLD_MARKED]);
    expect(annotationOf("1", HOLD_SKIP_ANSWER).toLowerCase()).not.toMatch(/\bnext\b/);

    // NO DEPENDENCY WALK, stated as the behaviour that proves its absence: the
    // marker does not move when the dependency graph changes underneath it.
    // The SAME published order with every dependency satisfied marks the SAME
    // row — so nothing in the render is reading the graph to decide.
    const satisfied = HOLD_SHAPE.map((entry) =>
      entry.cr === HOLD_MARKED ? pending(HOLD_MARKED, 20, []) : entry,
    );
    await mountApp({ queue: board(satisfied) });
    expectFocused040();
    expect(markedRows("1")).toEqual([HOLD_MARKED]);
  });
});

// ── §S4/AC13 — `deps <ids>` names ALL of them ──────────────────────────────

describe("CR-CRU-096 §S4/AC13 — a pending row with dependencies names every one of them; no deps, no annotation", () => {
  test("a row declaring FOUR deps names four, the combined slot carries `next` beside them, and a row declaring none renders no annotation", async () => {
    await mountApp({ queue: board(DEPS_WAVE) });
    expectFocused040();

    expect(rowCrs("1")).toEqual(["CR-K-1", "CR-K-2", "CR-K-3"]);
    expect(FOUR_DEPS.length).toBe(4);

    // FOUR, all of them. Each dep is accepted either as its full id or as its
    // distinguishing tail: the approved artifact abbreviates
    // (`deps 091, 092`), and no AC rules on the form — only on completeness.
    // The synthetic ids carry distinct tails so both readings are decidable.
    const four = annotationOf("1", "CR-K-1");
    expect(four.toLowerCase()).toContain("deps");
    for (const dep of FOUR_DEPS) {
      const tail = dep.split("-").at(-1)!;
      const named = four.includes(dep) || new RegExp(`\\b${tail}\\b`).test(four);
      expect(named, `the four-dep slot does not name ${dep} — it reads "${four}"`).toBe(true);
    }
    // ALL of them means all: the slot does not truncate to three, nor to an
    // "and 1 more".
    expect(four.toLowerCase()).not.toMatch(/\bmore\b/);
    expect(four).not.toContain("…");
    expect(four).not.toContain("...");

    // The COMBINED slot — `CR-K-1` is also the first actionable row, which is
    // the artifact's own row: `<b>next</b> · deps 091, 092`. Both facts, one
    // slot, `next` first.
    expect(markedRows("1")).toEqual(["CR-K-1"]);
    expect(four.toLowerCase().indexOf("next")).toBeLessThan(four.toLowerCase().indexOf("deps"));

    // One dep, named — and NOT marked `next`, because it is not first.
    const one = annotationOf("1", "CR-K-2");
    expect(one.toLowerCase()).toContain("deps");
    expect(one.includes(ONE_DEP[0]!) || /\b55\b/.test(one)).toBe(true);
    expect(one.toLowerCase()).not.toMatch(/\bnext\b/);

    // NO DEPS → NO ANNOTATION. `CR-K-3` declares none and is not first, so its
    // slot states nothing at all — an empty `deps` is the defect this forbids.
    expect(annotationOf("1", "CR-K-3")).toBe("");
    expect(norm(rowFor("1", "CR-K-3").textContent).toLowerCase()).not.toContain("deps");

    // §S6's width budget is measured against four deps in cycle 313's Chromium
    // suite (AC27) — the annotation's rendered width needs a layout engine,
    // and happy-dom has none. What is pinned here is that all four are IN the
    // slot, which is the fact the budget is measured against.
  });
});

// ── §S4/AC14 — no tooltip, and no `title` attribute ────────────────────────

describe("CR-CRU-096 §S4/AC14 — the annotation is visible, not hidden behind a hover", () => {
  test("no wave row and nothing inside one carries `title`, and no hover-description machinery is introduced", async () => {
    await mountApp({ queue: board(DEPS_WAVE) });
    expectFocused040();

    // The PROHIBITION first, so its reader is exercised against a real render
    // while the slot below is still red — and so the negative is never the
    // only thing this test says.

    const faults: string[] = [];
    for (const row of rowEls("1")) {
      const cr = row.getAttribute("data-cr") ?? "?";
      for (const el of [row, ...Array.from(row.querySelectorAll<HTMLElement>("*"))]) {
        for (const attr of ["title", "aria-describedby", "aria-description", "data-tooltip", "data-title"]) {
          if (el.hasAttribute(attr)) {
            faults.push(`${cr} carries ${attr}="${el.getAttribute(attr)}"`);
          }
        }
      }
    }
    expect(faults).toEqual([]);
    // And the whole zone grows no tooltip element either — the row removed the
    // need for `aria-describedby`, focus parity and the click guarantee alike.
    expect(zone2().querySelectorAll("[role='tooltip']").length).toBe(0);
    expect(zone2().querySelectorAll("[title]").length).toBe(0);

    // NON-VACUITY, and the reason the prohibition is not a tautology: these
    // rows really do carry the information an earlier draft wanted to hide
    // behind a hover, and it is rendered as visible text instead.
    expect(annotationOf("1", "CR-K-1").toLowerCase()).toContain("deps");
    expect(annotationOf("1", "CR-K-2").toLowerCase()).toContain("deps");
  });
});

// ── §S4/AC15 — the row's click still drills through ────────────────────────

describe("CR-CRU-096 §S4/AC15 — the annotation does not cost the row its click (CR-CRU-078 C4 `data-drill-source`)", () => {
  test("a running row still publishes `data-drill-source` and still lands on Workflow — and clicking the marked row's own annotation still selects it", async () => {
    await mountApp({ queue: board(DRILL_WAVE) });
    expectFocused040();

    const tabIsOn = (label: string): boolean =>
      all('[data-testid="workspace-tab"]').some(
        (tab) => (tab.textContent ?? "").includes(label) && tab.classList.contains("on"),
      );

    expect(rowCrs("1")).toEqual(["CR-G-1", "CR-G-2"]);

    // `roadmapDrillable` is IN_PROGRESS || COMPLETED (public/app.js:2678) and
    // merged CRs render no rows, so the running row is the drillable one and
    // it still says so before it is clicked.
    const runner = rowFor("1", "CR-G-1");
    expect(runner.getAttribute("data-drill-source")).toBe("true");
    expect(tabIsOn("Workflow")).toBe(false);
    runner.click();
    await settle();
    expect(tabIsOn("Workflow")).toBe(true);

    // The other half — the annotation is an inner span, so a click that lands
    // ON it must still reach the row. Clicking the marked row's marker selects
    // that row exactly as clicking the row does; a slot that swallowed the
    // event would leave nothing selected. That the drill above is exercised
    // FIRST is deliberate: it holds today, and this cycle must not cost it.
    await mountApp({ queue: board(DRILL_WAVE) });
    expectFocused040();
    // The marker landed, which is what makes the click below a REGRESSION
    // test of C4's affordance rather than a restatement of it.
    expect(markedRows("1")).toEqual(["CR-G-2"]);
    const marked = rowFor("1", "CR-G-2");
    const slot = annotationEl(marked);
    expect(slot, "the marked row renders no annotation slot to click").not.toBeNull();
    expect(marked.getAttribute("data-selected")).toBe("false");
    slot!.click();
    await settle();
    expect(rowFor("1", "CR-G-2").getAttribute("data-selected")).toBe("true");
    // PENDING is inert for the drill, exactly as it was before this cycle
    // (CR-CRU-083 AC7): the annotation adds no navigation of its own.
    expect(tabIsOn("Workflow")).toBe(false);
  });
});

// ── Non-regression — what C1 and C2 landed stays landed ────────────────────
//
// The roll-up and the annotation are additions to the same box C1 gave a
// header and C2 gave rows, so the three facts most easily broken by them are
// asserted here rather than trusted: the header count is WHOLE membership
// (AC3), merged CRs render NO rows (AC9), and `+N more` states actionable
// total minus actionable shown (AC16).

describe("CR-CRU-096 AC3/AC9/AC16 (non-regression) — the roll-up and the annotations leave C1's count and C2's trim intact", () => {
  test("a 29-member wave with 22 merged still renders `29` in its header, five actionable rows, and `+2 more`", async () => {
    await mountApp({ queue: board(R29), proposals: [PROPOSED_040_NO_TARGET, PROPOSED_050] });
    expectFocused040();

    // AC3 — whole membership, unaffected by the trim AND by the roll-up: the
    // count and the merged total are two different facts about one wave, and
    // the header states the first.
    expect(countText("1")).toBe(String(R29_SIZE));
    expect(waveEl("1").getAttribute("data-cr-count")).toBe(String(R29_SIZE));
    expect(countText("1")).not.toBe(String(R29_MERGED));

    // AC9 — merged CRs render no rows, and every drawn row is actionable here.
    expect(rowEls("1").length).toBe(DEFAULT_ROWS);
    expect(rowStatuses("1")).toEqual(Array.from({ length: DEFAULT_ROWS }, () => "PENDING"));

    // AC16 — actionable total minus actionable shown, never membership minus
    // shown (which would be 24 here) and never the merged count.
    const pointer = moreEl("1");
    expect(pointer, "the trimmed wave renders no `+N more` pointer").not.toBeNull();
    const remainder = R29_ACTIONABLE - DEFAULT_ROWS;
    expect(remainder).toBe(2);
    expect(norm(pointer!.textContent)).toMatch(/^\+\s*2\b/);
    expect(norm(pointer!.textContent).toLowerCase()).toContain("more");
    // The pointer states the remainder; the roll-up states the merged work.
    // Two numbers, two facts, and neither is the other.
    expect(rollupCount("1")).toBe(R29_MERGED);
    expect(rollupCount("1")).not.toBe(remainder);
  });
});

// ── §S4/AC12b + §S3/AC5a — ONE marker in the whole ZONE, and no roll-up on a
//    wave with nothing merged ────────────────────────────────────────────────
//
// ADDED IN GREEN, and the reason is stated rather than assumed: the rulings
// this cycle's RED provoked (2026-09-02) turned two of its recorded SILENCES
// into ACs, and every fixture above is SINGLE-WAVE and merged-bearing, so
// neither new AC has a discriminator up there.
//   • AC12b — "exactly one row in the whole ZONE is marked, not one per wave
//     box", which makes `nextCr` a VIEW-level fact. A per-box marker passes
//     every single-wave fixture above and fails here.
//   • AC5a — "the roll-up is ABSENT when the wave has zero merged members",
//     which the AC6a test above explicitly recorded as an unpinned silence.
// Both are read off ONE render of a two-wave board, so the per-box reading and
// the view-level reading give demonstrably different answers.

const waveTwo = (cr: string, status: QueueStatus, seq: number): QueueFixture => ({
  ...member(cr, status, seq),
  wave: "2",
});

/** Wave `1`: one merged member and two actionable rows. Wave `2`: two
 *  actionable rows and nothing merged. So the zone draws TWO first-actionable
 *  rows and exactly one of them may carry the marker. */
const TWO_WAVES: QueueFixture[] = [
  member("CR-W-1", "COMPLETED", 10),
  member("CR-W-2", "PENDING", 20),
  member("CR-W-3", "PENDING", 30),
  waveTwo("CR-W-4", "PENDING", 40),
  waveTwo("CR-W-5", "PENDING", 50),
];
const TWO_WAVES_MARKED = "CR-W-2";
/** What a PER-BOX marker would mark as well — the second box's own first
 *  actionable row, and the second `next` AC12b forbids. */
const TWO_WAVES_PER_BOX = "CR-W-4";
const PROPOSED_040_TWO_WAVES: ProposalFixture = {
  ...PROPOSED_040_NO_TARGET,
  waves: ["1", "2"],
};

describe("CR-CRU-096 §S4/AC12b + §S3/AC5a — across TWO waves the zone marks exactly one row, and a wave with nothing merged renders no roll-up", () => {
  test("both waves draw a first actionable row, only the earlier one is marked, and only the wave holding merged work states a roll-up", async () => {
    await mountApp({
      queue: board(TWO_WAVES),
      proposals: [PROPOSED_040_TWO_WAVES, PROPOSED_050],
    });
    expect(flow().getAttribute("data-kind")).toBe("proposed");
    expect(flow().getAttribute("data-version")).toBe("0.4.0");

    // The board really is two boxes, each really does draw the row a per-box
    // reading would mark: without this the "one marker" claim is vacuous.
    expect(waveNames()).toEqual(["1", "2"]);
    expect(rowCrs("1")).toEqual(["CR-W-2", "CR-W-3"]);
    expect(rowCrs("2")).toEqual([TWO_WAVES_PER_BOX, "CR-W-5"]);
    expect(TWO_WAVES_PER_BOX).not.toBe(TWO_WAVES_MARKED);

    // ONE marker in the whole zone: on the first actionable row of the FIRST
    // box in the published order, and on nothing in the second.
    expect(markedRows("1")).toEqual([TWO_WAVES_MARKED]);
    expect(markedRows("2")).toEqual([]);
    expect([...markedRows("1"), ...markedRows("2")]).toEqual([TWO_WAVES_MARKED]);
    // And ONE element in the WHOLE zone says it — counted over every
    // annotation slot the zone renders, wave boxes and loose group alike, so
    // this holds no matter which container a second marker appeared in. (The
    // zone's raw `textContent` cannot answer this: it concatenates the row's
    // spans with no separator, so the word never carries a `\b` on its left.)
    const slotsSayingNext = all('[data-zone="2"] [data-testid="roadmap-node-annotation"]').filter(
      (slot) => /\bnext\b/i.test(norm(slot.textContent)),
    );
    expect(slotsSayingNext.map((slot) => norm(slot.textContent))).toEqual(["next"]);

    // AC5a — the roll-up follows the merged work: wave `1` has one merged
    // member and states it; wave `2` has none and renders NO line, exactly as
    // `+N more` is absent with no remainder.
    expect(rollupCount("1")).toBe(1);
    expect(rollupText("1").toLowerCase()).toContain("awaiting the tag");
    expect(rollupEl("2")).toBeNull();
    // Non-vacuity of the absence: wave `2` is a real, drawn box with rows.
    expect(rowEls("2").length).toBe(2);
  });
});
