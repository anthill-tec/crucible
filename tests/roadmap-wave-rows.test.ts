// CR-CRU-096 C2 (cycle 310) — ZONE 2 STOPS BEING AN INVENTORY: one CR per
// full-width ROW, merged CRs rolled up out of the rows, and only the top of
// the scheduled queue shown.
//
// Spec: docs/changes/CR-CRU-096-zone-2-drifts-from-the-approved-design.md
//       §S5 ("one CR per row; merged rolled up; only the scheduled top
//       shown"), §S8 (shape and colour grammar — the `+N more` pointer is not
//       a node and must not read as one).
//       AC8, AC9, AC10, AC11, AC16, AC17, AC18, AC28 — plus AC3 asserted here
//       ONLY as a non-regression, and AC29 on every fixture below.
//
// Approved design: `.lavish/crucible-workflow-flowchart.html` §1's `div.flow`
//       for the ACTIVE release. Its wave holds `<h4>Wave 5 · active | 28</h4>`,
//       a roll-up, then a COLUMN of five rows and
//       `<div class="more">+2 more — see the table below</div>`:
//         .crs  { display:flex; flex-direction:column; gap:4px }
//         .cr   { display:flex; justify-content:space-between }   ← id | status
//         .more { color:var(--ink-dim); text-align:center }       ← no border,
//                                                                  no bg, not
//                                                                  a rectangle
//       28 members = 21 merged + 7 scheduled, 5 shown, remainder 2. That
//       arithmetic is where AC10's and AC16's fixtures come from.
//
// SCOPE — the chip→row rewrite and the TRIM only. The roll-up line (§S3,
// AC5–AC7) and the `next`/`deps` annotation slot (§S4, AC12–AC14) are cycle
// 311; the horizontal axis (§S6, AC20) is 312; the shipped path (§S7,
// AC21–AC24) is 312; the real-engine visual suite (AC27) is 313. None of them
// is asserted here. Zones 1 and 3 are out of scope entirely (AC26).
//
// Harness: tests/roadmap-wave-header.test.ts (C1, cycle 309), verbatim — which
// took it from tests/roadmap-release-focus.test.ts (CR-CRU-078 C3): the REAL
// public/app.js shell driving its own fetch chain and van.js's real reactive
// scheduler inside happy-dom, with the box model stubbed because happy-dom
// runs no layout, and a per-mount cache-busted dynamic import of
// public/app-logic.mjs.
//
// WHAT IS ASSERTED, AND WHY IT IS NEVER A FUNCTION NAME. Every assertion below
// reads RENDERED rows, PUBLISHED attributes, and the ABSENCE of paging chrome.
// "Which CRs does this wave show" is a decision, so this codebase's shape puts
// it in the pure module (`focusedReleaseView`, public/app-logic.mjs:1154,
// already stamps each box with `active`; the trimmed row list belongs beside
// it) and leaves the rendering in app.js. But GREEN may compute the trim
// anywhere: nothing here names a function, a class, or a module.
//
// AC29 — EVERY FIXTURE ID IS SYNTHETIC (`CR-Q-n`, `CR-C-nn`, `CR-E-n`,
// `CR-T-n`, `CR-M-n`, `CR-A`, `CR-D`, `CR-V`, `CR-U-n`, `CR-S-A`). Crucible is
// project-INDEPENDENT: a criterion that only holds while our own backlog has a
// given shape is not a criterion. CR ids named in comments are provenance,
// never fixture data.
//
// RED phase — expected to FAIL against current production, which renders
// `box.entries.map(RoadmapFlowNode)` into a `flex-wrap: wrap` body
// (public/app.js:2819, public/styles.css:1269-1276): ALL members as chips,
// merged included, no trim, and no `+N more` pointer.
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

// ── Fixture types (the wire shapes, as tests/roadmap-wave-header.test.ts
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

/** `src/types.ts` (`QueueEntry.lifecycle`) — the DISPOSITION axis, exactly as
 *  the wire publishes it and as tests/roadmap-visual-grammar.test.ts and
 *  tests/roadmap-release-focus.test.ts already author it. */
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
// One board shape, reused: 0.1.0 shipped, 0.4.0 proposed (the DEFAULT FOCUS —
// `releaseStripFocusIndex`, public/app-logic.mjs:179, focuses the first
// proposed gate, and 0.4.0's timestamp precedes 0.5.0's), 0.5.0 proposed but
// not focused. Every test swaps only the FOCUSED release's wave-1 membership,
// so each AC gets the membership it needs against a board whose focus is
// already proven by C1's suite.

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

const PROPOSED_050: ProposalFixture = {
  label: "0.5.0",
  timestamp: 1787000001,
  waves: ["3"],
};

/** The other releases' members: they exist so the trim is proven to act on the
 *  FOCUSED wave and to leak into no other. */
const OTHER_MEMBERS: QueueFixture[] = [
  { cr: "CR-S-A", title: "CR-S-A — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 1, release: "0.1.0" },
  { cr: "CR-S-B", title: "CR-S-B — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 2, release: "0.1.0" },
  { cr: "CR-U-1", title: "CR-U-1 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 900, release: "0.5.0" },
  { cr: "CR-U-2", title: "CR-U-2 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 910, release: "0.5.0" },
];

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

/** The board, with the focused wave's membership supplied. */
const board = (waveOne: QueueFixture[]): QueueFixture[] => [...OTHER_MEMBERS, ...waveOne];

/** §S5's default: five rows. The artifact shows exactly five (`div.crs` holds
 *  5 `.cr` children plus the pointer) out of seven scheduled. */
const DEFAULT_ROWS = 5;

// AC10's fixture, stated by the AC itself: a wave authored `CR-Q-1 … CR-Q-9`
// with `CR-Q-1` and `CR-Q-2` COMPLETED. Seven scheduled, five shown,
// remainder two — the artifact's 21/7/5/2 arithmetic at fixture scale.
const NINE_IDS = Array.from({ length: 9 }, (_, i) => `CR-Q-${i + 1}`);
const NINE_MERGED = ["CR-Q-1", "CR-Q-2"];
const NINE: QueueFixture[] = NINE_IDS.map((cr, i) =>
  member(cr, NINE_MERGED.includes(cr) ? "COMPLETED" : "PENDING", (i + 1) * 10),
);
const NINE_EXPECTED_ROWS = ["CR-Q-3", "CR-Q-4", "CR-Q-5", "CR-Q-6", "CR-Q-7"];
const NINE_SCHEDULED = NINE_IDS.length - NINE_MERGED.length; // 7

/** AC10's second half — "in the order the server PUBLISHED … consumed
 *  verbatim, no client re-sort". The SAME nine members, published in an order
 *  that is deliberately NOT `seq` order, so a client that re-sorted on `seq`
 *  (CR-CRU-091 AC18's outlawed second oracle) renders a demonstrably different
 *  list. Published actionable order is Q-5, Q-3, Q-9, Q-7, Q-4, Q-8, Q-6; a
 *  seq-sorter would answer Q-3, Q-4, Q-5, Q-6, Q-7. */
const NINE_PUBLISHED_OUT_OF_SEQ: QueueFixture[] = [
  "CR-Q-5",
  "CR-Q-3",
  "CR-Q-9",
  "CR-Q-1",
  "CR-Q-7",
  "CR-Q-2",
  "CR-Q-4",
  "CR-Q-8",
  "CR-Q-6",
].map((cr) => {
  const found = NINE.find((entry) => entry.cr === cr);
  if (found === undefined) throw new Error(`fixture bug: ${cr} is not one of the nine`);
  return found;
});
const OUT_OF_SEQ_EXPECTED_ROWS = ["CR-Q-5", "CR-Q-3", "CR-Q-9", "CR-Q-7", "CR-Q-4"];
const SEQ_SORTED_ROWS = ["CR-Q-3", "CR-Q-4", "CR-Q-5", "CR-Q-6", "CR-Q-7"];

/** AC11 — the LAST scheduled CR is the running one, so the guarantee ("an
 *  ACTIVE CR is always shown, even when it falls outside those five") is the
 *  only thing that can put it on screen. */
const NINE_LAST_ACTIVE: QueueFixture[] = NINE.map((entry) =>
  entry.cr === "CR-Q-9" ? member("CR-Q-9", "IN_PROGRESS", 90) : entry,
);
const NINE_LAST_ACTIVE_ACTIONABLE = 6; // Q-3 … Q-8; Q-9 is running, not actionable

/** AC13b — `deps` renders on a PENDING row ONLY. One wave, two rows carrying
 *  the SAME declared dependencies, differing only in STATUS, so the absence on
 *  the running row is asserted against the presence on the pending one in the
 *  SAME render and cannot pass vacuously (a GREEN that dropped the annotation
 *  everywhere would fail the pending half). AC29 — the ids are synthetic. */
const DEPS_DECLARED = ["CR-X-1", "CR-X-2"];
const DEPS_BY_STATUS: QueueFixture[] = [
  { ...member("CR-N-1", "PENDING", 10), dependsOn: [...DEPS_DECLARED] },
  { ...member("CR-N-2", "IN_PROGRESS", 20), dependsOn: [...DEPS_DECLARED] },
];

/** AC3-under-trim + AC17 + AC18 — a wave far bigger than the trim: 29 members,
 *  20 merged, 9 scheduled. Membership 29, rows 5, remainder 4. */
const TWENTY_NINE_SIZE = 29;
const TWENTY_NINE_MERGED = 20;
const TWENTY_NINE: QueueFixture[] = Array.from({ length: TWENTY_NINE_SIZE }, (_, i) =>
  member(
    `CR-C-${String(i + 1).padStart(2, "0")}`,
    i < TWENTY_NINE_MERGED ? "COMPLETED" : "PENDING",
    (i + 1) * 10,
  ),
);
const TWENTY_NINE_SCHEDULED = TWENTY_NINE_SIZE - TWENTY_NINE_MERGED; // 9

/** AC16's absent case, at the BOUNDARY: exactly five scheduled and nothing
 *  merged, so every scheduled CR is shown and no remainder exists. */
const EXACTLY_FIVE: QueueFixture[] = Array.from({ length: 5 }, (_, i) =>
  member(`CR-E-${i + 1}`, "PENDING", (i + 1) * 10),
);

/** AC16's absent case UNDER the roll-up: five members, two merged, three
 *  scheduled. Fewer rows than the trim allows, and still no pointer. */
const THREE_SCHEDULED: QueueFixture[] = Array.from({ length: 5 }, (_, i) =>
  member(`CR-T-${i + 1}`, i < 2 ? "COMPLETED" : "PENDING", (i + 1) * 10),
);
const THREE_SCHEDULED_ROWS = ["CR-T-3", "CR-T-4", "CR-T-5"];

/** AC9 at its limit: a wave whose every member is merged renders NO rows —
 *  and its header still states its whole membership (AC3). */
const ALL_MERGED: QueueFixture[] = Array.from({ length: 4 }, (_, i) =>
  member(`CR-M-${i + 1}`, "COMPLETED", (i + 1) * 10),
);

/** AC28's e2e mirror — `tests/e2e/features/roadmap-graph.feature:41-46` drives
 *  a wave holding EXACTLY ONE CR node, PENDING then IN_PROGRESS, and clicks
 *  it. The steps at `tests/e2e/steps/roadmap-graph.steps.ts:84,96,102` locate
 *  it as `box.getByTestId("roadmap-node")` (count), then
 *  `[data-testid="roadmap-node"][data-cr=…]` with `data-status`. The trim must
 *  leave that shape intact: one actionable CR is one row, inside the box. */
const SINGLE_PENDING: QueueFixture[] = [member("CR-A", "PENDING", 10)];
const SINGLE_RUNNING: QueueFixture[] = [member("CR-A", "IN_PROGRESS", 10)];

/** CR-CRU-096 AC9b/AC9c — the two boards on which a DISPOSITIONED member is
 *  still DRAWN AS A NODE, and so must still state its disposition in words:
 *    • AC9c — a member that is IN_PROGRESS and carries a disposition. AC9's
 *      row union is on STATUS, so it is a row whatever its `lifecycle`;
 *    • AC9b/AC18a — the wave-less group (`wave: ""`, the wire's own way of
 *      declaring none), which takes the row arrangement but NOT the trim, so
 *      a dispositioned PENDING member is drawn there even though AC9a keeps
 *      it out of a TRIMMED wave box.
 *  Each board pairs the dispositioned member with an undispositioned one, so
 *  the badge's presence is asserted against its absence on the same render. */
const RETIRED_AT = 1787200000000; // a lifecycle `at` is epoch MILLISECONDS
const RUNNING_DISPOSITIONED: QueueFixture[] = [
  member("CR-A", "PENDING", 10),
  {
    ...member("CR-D", "IN_PROGRESS", 20),
    lifecycle: { state: "SUPERSEDED", by: "CR-A", at: RETIRED_AT },
  },
];
const LOOSE_DISPOSITIONED: QueueFixture[] = [
  { ...member("CR-A", "PENDING", 10), wave: "" },
  {
    ...member("CR-V", "PENDING", 20),
    wave: "",
    lifecycle: { state: "VOID", reason: "the surface it targeted was retired", at: RETIRED_AT },
  },
];

// ── Harness (tests/roadmap-wave-header.test.ts, verbatim) ───────────────────

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
  const key = opts.key ?? "wave-rows-key";
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
      return okResponse({ ok: true, entries: opts.queue ?? board(NINE) });
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
    throw new Error(`roadmap-wave-rows.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapWaveRows=${cacheBust}`);

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

/** AC18's scope: the zone, not the page. Zone 1's strip legitimately publishes
 *  `data-window-size` / `data-window-offset` and renders `◀ N earlier` /
 *  `N later ▶` (public/app.js:3055, :3116-3118) — that is its paging, and
 *  AC26 keeps it byte-identical. The prohibition is on zone 2 growing its own. */
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

/** The wave's ROWS. Deliberately read through the node selector AC28 pins and
 *  scoped to the wave box exactly as the e2e step scopes it
 *  (`tests/e2e/steps/roadmap-graph.steps.ts:84`), so a GREEN that moved the
 *  rows out of the box would fail here and there for the same reason. */
const rowEls = (wave: string): HTMLElement[] =>
  Array.from(waveEl(wave).querySelectorAll<HTMLElement>('[data-testid="roadmap-node"]'));

const rowCrs = (wave: string): string[] =>
  rowEls(wave).map((row) => row.getAttribute("data-cr") ?? "");

const rowStatuses = (wave: string): string[] =>
  rowEls(wave).map((row) => row.getAttribute("data-status") ?? "");

/** The one selector this cycle INTRODUCES: §S5.4's static pointer. It is named
 *  rather than read out of the box's text because AC16 asserts both its
 *  presence and its ABSENCE, and "no element" is the only unambiguous way to
 *  state the absent half. */
const moreEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-more"]');

function moreElOrThrow(wave: string): HTMLElement {
  const el = moreEl(wave);
  if (el === null) {
    throw new Error(
      `wave ${wave} renders no [data-testid="roadmap-wave-more"] pointer (box text: ${norm(waveEl(wave).textContent)})`,
    );
  }
  return el;
}

/** The remainder the pointer STATES, as a number. */
function moreCount(wave: string): number {
  const text = norm(moreElOrThrow(wave).textContent);
  const digits = text.match(/\d+/g) ?? [];
  if (digits.length !== 1) {
    throw new Error(`wave ${wave}'s pointer must state exactly one number, got "${text}"`);
  }
  return Number(digits[0]);
}

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

/** The element the rows actually sit in, DERIVED from the rendered rows rather
 *  than named: AC8 constrains the arrangement, not the class GREEN picks. */
function rowContainer(wave: string): HTMLElement {
  const rows = rowEls(wave);
  if (rows.length === 0) throw new Error(`wave ${wave} renders no rows to contain`);
  const parents = new Set(rows.map((row) => row.parentElement));
  if (parents.size !== 1) {
    throw new Error(
      `wave ${wave}'s rows are split across ${parents.size} containers — a single column is one container`,
    );
  }
  const parent = rows[0]!.parentElement;
  if (parent === null) throw new Error(`wave ${wave}'s rows have no parent element`);
  return parent;
}

// ── The CSS reader: what the SHIPPED stylesheet declares for a real element ──
//
// happy-dom has no cascade, so `getComputedStyle` cannot answer AC8's
// arrangement or AC17's overflow. This reader is C1's `animatingSelectors`
// (tests/roadmap-wave-header.test.ts:409) generalised from one property to
// any: every rule in public/styles.css that declares `prop` is collected, and
// the LAST one whose selector the given element MATCHES wins — source order,
// specificity ignored, which for this stylesheet's flat single-class rules is
// the same answer and is conservative where it is not. Comments are stripped
// first for exactly C1's reason: a `/* … */` between one rule's `}` and the
// next selector is swallowed into that selector otherwise, and the resulting
// string is not even a valid selector.
//
// The REAL-ENGINE half of both ACs — `getComputedStyle(...).overflow` and
// measured row widths and box heights — is the Chromium suite's (AC27, cycle
// 313), and is deferred there deliberately: this harness has no layout engine
// to measure, and a fabricated measurement would be worse than an honest gap.

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

/** AC17 — "no scroll container". An element scrolls or clips iff some overflow
 *  axis is `auto`, `scroll`, `hidden` or `clip`; `visible` and unset are the
 *  two allowed answers. Inline style is checked too: a scroller stapled on at
 *  render time is the same defect. */
function overflowFaults(el: HTMLElement, label: string): string[] {
  const faults: string[] = [];
  for (const prop of ["overflow", "overflow-x", "overflow-y"]) {
    const value = declared(el, prop);
    if (value !== null && value !== "visible") {
      faults.push(`${label} declares ${prop}: ${value}`);
    }
  }
  const inline = (el.getAttribute("style") ?? "").toLowerCase();
  if (/overflow/.test(inline)) faults.push(`${label} carries inline overflow: ${inline}`);
  return faults;
}

/** Every attribute name on every element of the zone, for AC18. */
function zoneAttrNames(): string[] {
  const out: string[] = [];
  const walk = (el: Element): void => {
    for (const attr of Array.from(el.attributes)) out.push(attr.name);
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(zone2());
  return out;
}

/** The board is the one C1 proved focuses 0.4.0. Asserted, not assumed: every
 *  fixture below is wave `1` OF THAT RELEASE, so a focus drift would make the
 *  whole file assert against the wrong box. */
function expectFocused040(): void {
  expect(flow().getAttribute("data-kind")).toBe("proposed");
  expect(flow().getAttribute("data-version")).toBe("0.4.0");
  expect(waveNames()).toEqual(["1"]);
}

// ── §S5/AC8 — one CR per FULL-WIDTH ROW; the wrapped chip grid is gone ──────

describe("CR-CRU-096 §S5/AC8 — each shown CR renders as ONE full-width row: id left, status right", () => {
  test("every rendered row states its id first and its status after it, and the rows are one column — not a wrapped chip grid", async () => {
    await mountApp({ queue: board(NINE) });
    expectFocused040();

    const rows = rowEls("1");
    expect(rows.length).toBeGreaterThan(0);

    // The row's own grammar: the identifier opens it, the status follows.
    // Read as TEXT so §S8's greyscale invariant is what is being pinned, and
    // so cycle 311's `next` / `deps` annotation can join the right-hand side
    // without touching this assertion. Every status the queue can publish is
    // listed, merged included: AC8 governs the ARRANGEMENT of whatever rows
    // render, and which rows render is AC9's and AC10's.
    const MARK: Record<string, string> = {
      PENDING: "pending",
      IN_PROGRESS: "▶ in progress",
      COMPLETED: "✓ merged",
      COMPLETED_UNTRACKED: "✓ untracked",
    };
    for (const row of rows) {
      const cr = row.getAttribute("data-cr") ?? "";
      const status = row.getAttribute("data-status") ?? "";
      const text = norm(row.textContent);
      const mark = MARK[status] ?? status;
      expect(text.startsWith(cr)).toBe(true);
      expect(text).toContain(mark);
      expect(text.indexOf(mark)).toBeGreaterThan(text.indexOf(cr));
    }

    // "No wrapped chip grid remains" — the arrangement itself. A wrapping
    // ROW-direction flex is precisely the chip grid: it packs as many CRs per
    // line as fit and wraps. One CR per full-width row is the opposite, and
    // the artifact draws it as `.crs { display:flex; flex-direction:column }`.
    // Today the container is `.app-flow-wave-body`, which declares
    // `flex-wrap: wrap` with no direction (public/styles.css:1269-1276) — the
    // grid, in one declaration.
    const container = rowContainer("1");
    const wrap = declared(container, "flex-wrap");
    const direction = declared(container, "flex-direction");
    const arrangement =
      wrap === "wrap" && direction !== "column"
        ? `a wrapped chip grid (flex-wrap: ${wrap}, flex-direction: ${direction ?? "unset — row"})`
        : "one CR per row";
    expect(arrangement).toBe("one CR per row");

    // A row is not a chip either: it must not itself wrap its id under its
    // status when the two do not fit.
    for (const row of rows) {
      expect(declared(row, "flex-wrap")).not.toBe("wrap");
    }
  });
});

// ── §S5/AC9 — merged CRs get NO rows ───────────────────────────────────────

describe("CR-CRU-096 §S5/AC9 — merged CRs render no rows; the wave's rows are the actionable ones", () => {
  test("a wave holding two merged CRs renders neither of them, and no rendered row carries COMPLETED", async () => {
    await mountApp({ queue: board(NINE) });
    expectFocused040();

    // Non-vacuity: the fixture really does publish merged members into this wave.
    expect(NINE.filter((e) => e.status === "COMPLETED").map((e) => e.cr)).toEqual(NINE_MERGED);

    for (const merged of NINE_MERGED) expect(rowCrs("1")).not.toContain(merged);
    expect(rowStatuses("1")).not.toContain("COMPLETED");
  });

  test("a wave whose EVERY member is merged renders no rows at all — and its header still states its whole membership", async () => {
    await mountApp({ queue: board(ALL_MERGED) });
    expectFocused040();

    // Counted and named, never `toEqual([])` on the element array: deep-equal
    // on a live DOM node walks its circular parent/child graph and never
    // returns.
    expect(rowEls("1").length).toBe(0);
    expect(rowCrs("1")).toEqual([]);
    // AC3 is untouched by the roll-up: membership is membership.
    expect(countText("1")).toBe(String(ALL_MERGED.length));
    expect(waveEl("1").getAttribute("data-cr-count")).toBe(String(ALL_MERGED.length));
    // Nothing remains unshown that a pointer could point at.
    expect(moreEl("1")).toBeNull();
  });
});

// ── §S5/AC10 — the top of the scheduled queue, in the PUBLISHED order ──────

describe("CR-CRU-096 §S5/AC10 — the rows are the top of the scheduled queue, five by default", () => {
  test("a wave authored CR-Q-1 … CR-Q-9 with CR-Q-1 and CR-Q-2 merged renders rows CR-Q-3 … CR-Q-7", async () => {
    await mountApp({ queue: board(NINE) });
    expectFocused040();

    expect(rowCrs("1")).toEqual(NINE_EXPECTED_ROWS);
    expect(rowEls("1").length).toBe(DEFAULT_ROWS);
    // The trim is a WINDOW on the queue, not a filter that happened to keep
    // five: the two behind it exist and are simply not drawn.
    expect(NINE_SCHEDULED).toBe(7);
    expect(rowCrs("1")).not.toContain("CR-Q-8");
    expect(rowCrs("1")).not.toContain("CR-Q-9");
  });

  test("the order is the server's PUBLISHED order consumed verbatim — a payload published out of `seq` order renders in the payload's order, never re-sorted", async () => {
    await mountApp({ queue: board(NINE_PUBLISHED_OUT_OF_SEQ) });
    expectFocused040();

    // Non-vacuity: the two answers really do differ, so this cannot pass by
    // coincidence. CR-CRU-091 AC18 forbids the client re-deriving `seq`;
    // CR-CRU-095 §S1 deleted the last client-side sorter.
    expect(OUT_OF_SEQ_EXPECTED_ROWS).not.toEqual(SEQ_SORTED_ROWS);

    expect(rowCrs("1")).toEqual(OUT_OF_SEQ_EXPECTED_ROWS);
    expect(rowCrs("1")).not.toEqual(SEQ_SORTED_ROWS);
  });
});

// ── §S5/AC11 — an ACTIVE CR is always shown ────────────────────────────────

describe("CR-CRU-096 §S5/AC11 — an IN_PROGRESS CR is present even when it falls outside the top five", () => {
  test("activating the LAST scheduled CR still renders it, with the ember class its status already earns", async () => {
    await mountApp({ queue: board(NINE_LAST_ACTIVE) });
    expectFocused040();

    // Non-vacuity: exactly one member runs, and it is the last of the nine —
    // so nothing but the guarantee can put it on screen.
    const running = NINE_LAST_ACTIVE.filter((e) => e.status === "IN_PROGRESS");
    expect(running.map((e) => e.cr)).toEqual(["CR-Q-9"]);
    expect(NINE_LAST_ACTIVE.at(-1)!.cr).toBe("CR-Q-9");

    const crs = rowCrs("1");
    expect(crs).toContain("CR-Q-9");

    // It is shown AS RUNNING: `data-status` and the class the stylesheet's
    // ember + `app-run-pulse` motion hangs off (public/styles.css:1351). The
    // rendered motion itself is Chromium's (AC27).
    const active = rowEls("1").find((row) => row.getAttribute("data-cr") === "CR-Q-9")!;
    expect(active.getAttribute("data-status")).toBe("IN_PROGRESS");
    expect(active.className).toContain("in_progress");

    // AC11a — the runner EXTENDS the list; it never DISPLACES a scheduled row
    // (ruled 2026-09-02: displacing would hide scheduled work to show running
    // work AND break the pointer's arithmetic, `actionable total − actionable
    // rows shown`, while extending keeps the published order strictly intact
    // and is bounded by the track count, a track running one CR at a time).
    // So the render is the five scheduled rows AC10 publishes PLUS the runner.
    // Asserted FIRST because it is the one thing today's untrimmed render
    // cannot satisfy: the guarantee above passes vacuously while all nine
    // members are drawn.
    expect(crs.length).toBe(DEFAULT_ROWS + 1);

    // NOT DISPLACED: every one of AC10's five scheduled rows is still drawn,
    // in the published order, with the runner the only addition.
    for (const cr of NINE_EXPECTED_ROWS) expect(crs).toContain(cr);
    expect(crs.filter((cr) => cr !== "CR-Q-9")).toEqual(NINE_EXPECTED_ROWS);
    // Merged stay rolled up, and nothing beyond the window sneaks in with it.
    expect(rowStatuses("1")).not.toContain("COMPLETED");
    expect(crs).not.toContain("CR-Q-1");

    // And the remainder is TRUE: the scheduled CRs not drawn.
    // Actionable = PENDING with no lifecycle (clients/_crucible_axi.py:1301);
    // no fixture here carries a lifecycle, so PENDING is actionable.
    const pendingShown = rowStatuses("1").filter((s) => s === "PENDING").length;
    expect(moreCount("1")).toBe(NINE_LAST_ACTIVE_ACTIONABLE - pendingShown);
  });
});

// ── §S4/AC13b — `deps` renders on a PENDING row ONLY ───────────────────────

describe("CR-CRU-096 §S4/AC13b — `deps` renders on a PENDING row only", () => {
  test("a running row declaring the SAME deps as a pending row renders no deps annotation, while the pending row does", async () => {
    await mountApp({ queue: board(DEPS_BY_STATUS) });
    expectFocused040();

    // Non-vacuity, in the fixture: the two rows differ in STATUS and in
    // nothing else — same wave, same declared dependencies.
    expect(DEPS_BY_STATUS.map((e) => e.dependsOn)).toEqual([DEPS_DECLARED, DEPS_DECLARED]);
    expect(DEPS_BY_STATUS.map((e) => e.status)).toEqual(["PENDING", "IN_PROGRESS"]);
    expect(rowCrs("1")).toEqual(["CR-N-1", "CR-N-2"]);

    const row = (cr: string): HTMLElement => {
      const el = rowEls("1").find((node) => node.getAttribute("data-cr") === cr);
      if (el === undefined) throw new Error(`wave 1 renders no row for ${cr}`);
      return el;
    };

    // The PENDING row DOES state them — AC13/AC13a, by full published id. This
    // is the counter-subject: a GREEN that simply never rendered `deps` would
    // fail here, so the absence below cannot pass vacuously.
    const pendingText = norm(row("CR-N-1").textContent);
    expect(pendingText).toContain(`deps ${DEPS_DECLARED.join(", ")}`);

    // The IN_PROGRESS row does NOT: its dependencies are not
    // decision-relevant, the work having already started (zone 3's table
    // carries the full dependency data for every row either way). No slot at
    // all, and no dependency id anywhere in the row's text.
    const running = row("CR-N-2");
    expect(running.getAttribute("data-status")).toBe("IN_PROGRESS");
    expect(
      running.querySelector('[data-testid="roadmap-node-annotation"]'),
      "a running row renders no annotation slot for its declared deps",
    ).toBeNull();
    const runningText = norm(running.textContent);
    expect(runningText).not.toContain("deps");
    for (const dep of DEPS_DECLARED) expect(runningText).not.toContain(dep);
  });
});

// ── §S5/AC16 — the `+N more` POINTER ───────────────────────────────────────

describe("CR-CRU-096 §S5/AC16 — `+N more` states the true remainder, and is absent when none remains", () => {
  test("seven scheduled and five shown renders `+2 more`, after the last row and inside the box", async () => {
    await mountApp({ queue: board(NINE) });
    expectFocused040();

    const pointer = moreElOrThrow("1");
    const text = norm(pointer.textContent);

    // The TRUE remainder — scheduled minus shown, not membership minus shown
    // (which would be 4 here, counting the two merged) and not a page size.
    expect(moreCount("1")).toBe(NINE_SCHEDULED - DEFAULT_ROWS);
    expect(moreCount("1")).toBe(2);
    expect(text).toMatch(/^\+\s*2\b/);
    expect(text.toLowerCase()).toContain("more");
    // §S5.4 — it points AT the detail surface: `+N more — see the table
    // below`, which is also the artifact's own string.
    expect(text.toLowerCase()).toContain("table");

    // It sits inside the wave box, after every row (the artifact draws it as
    // the last child of `div.crs`).
    expect(waveEl("1").contains(pointer)).toBe(true);
    const order = Array.from(waveEl("1").querySelectorAll<HTMLElement>("*"));
    const lastRow = rowEls("1").at(-1)!;
    expect(order.indexOf(pointer)).toBeGreaterThan(order.indexOf(lastRow));
  });

  test("no pointer renders when every scheduled CR is shown — under the roll-up, and at the five-row boundary", async () => {
    // Three scheduled behind two merged: fewer rows than the window, so
    // nothing is withheld and there is nothing to point at.
    await mountApp({ queue: board(THREE_SCHEDULED) });
    expectFocused040();
    expect(rowCrs("1")).toEqual(THREE_SCHEDULED_ROWS);
    expect(moreEl("1")).toBeNull();

    // The BOUNDARY: exactly five scheduled, exactly five shown, no remainder.
    // A pointer reading `+0 more` is the defect this half exists to forbid.
    await mountApp({ queue: board(EXACTLY_FIVE) });
    expectFocused040();
    expect(rowEls("1").length).toBe(DEFAULT_ROWS);
    expect(rowCrs("1")).toEqual(EXACTLY_FIVE.map((e) => e.cr));
    expect(moreEl("1")).toBeNull();
    expect(norm(waveEl("1").textContent)).not.toContain("more");
  });

  test("the pointer is not a control and not a node: no click handler, no CR identity, and clicking it selects nothing (§S8)", async () => {
    await mountApp({ queue: board(NINE) });
    expectFocused040();

    const pointer = moreElOrThrow("1");

    // §S8 — "the `+N more` pointer is not a node and must not read as one":
    // it carries neither the node's test id nor a CR, so it can be neither
    // selected nor drilled, and no node-count consumer counts it.
    expect(pointer.getAttribute("data-testid")).not.toBe("roadmap-node");
    expect(pointer.getAttribute("data-cr")).toBeNull();
    expect(pointer.getAttribute("data-status")).toBeNull();
    expect(pointer.getAttribute("data-drill-source")).toBeNull();
    expect(pointer.querySelector('[data-testid="roadmap-node"]')).toBeNull();

    // A POINTER, not a control: van assigns `on*` props to the element, so an
    // unhandled element really does read `null` here.
    expect(pointer.onclick).toBeNull();
    expect(pointer.getAttribute("onclick")).toBeNull();

    // And behaviourally inert: clicking it changes no selection and stays on
    // the roadmap.
    const before = all('[data-selected="true"]').length;
    pointer.click();
    await settle();
    expect(all('[data-selected="true"]').length).toBe(before);
    expect(window.location.pathname).toContain("/roadmap");
    expect(moreCount("1")).toBe(2);
  });
});

// ── §S5/AC17 — no scroll container; the box grows with the rows SHOWN ──────

describe("CR-CRU-096 §S5/AC17 — no scroll container inside the wave, and the rows shown do not track membership", () => {
  test("a 29-member wave draws five rows and a 3-scheduled wave draws three — and neither the box, the column, nor a row scrolls or clips", async () => {
    await mountApp({ queue: board(TWENTY_NINE) });
    expectFocused040();

    // NOT A SCROLLER — the wave, the row column, and every row. Asserted
    // FIRST so this reader is exercised against real rendered elements even
    // while the trim below is still red. The negative is VACUOUS against
    // today's production (nothing matching `.app-flow-wave` declares
    // overflow) and it is here beside the positive that makes it meaningful:
    // the trim is exactly the change that tempts a GREEN into `max-height` +
    // `overflow-y: auto`, and §S5 rules that out — "NO scroll container: a
    // partially drawn container is a defect".
    const faults = [
      ...overflowFaults(waveEl("1"), "the wave box"),
      ...overflowFaults(rowContainer("1"), "the row column"),
      ...rowEls("1").flatMap((row, i) => overflowFaults(row, `row ${i}`)),
    ];
    expect(faults).toEqual([]);

    // The HALF this harness can measure honestly: what the box CONTAINS.
    // happy-dom runs no layout, so "height grows with the rows shown, not with
    // membership" is asserted as the rendered ROW COUNT — the thing the height
    // is a function of. The measured height (300 × 228 in §S6's table) is the
    // Chromium suite's (AC27, cycle 313), where a real engine exists to
    // measure it; asserting a pixel here would be fabricating one.
    expect(waveEl("1").getAttribute("data-cr-count")).toBe(String(TWENTY_NINE_SIZE));
    expect(TWENTY_NINE_SCHEDULED).toBeGreaterThan(DEFAULT_ROWS);
    expect(rowEls("1").length).toBe(DEFAULT_ROWS);

    // The rows shown are a function of the QUEUE, not of membership: 29
    // members show five, five members with three scheduled show three.
    await mountApp({ queue: board(THREE_SCHEDULED) });
    expectFocused040();
    expect(waveEl("1").getAttribute("data-cr-count")).toBe(String(THREE_SCHEDULED.length));
    expect(overflowFaults(rowContainer("1"), "the row column")).toEqual([]);
    expect(rowEls("1").length).toBe(3);
  });
});

// ── §S5/AC18 — the trim arrives with NO paging machinery ───────────────────

describe("CR-CRU-096 §S5/AC18 — no `data-window-*` attribute and no `◀ earlier` / `later ▶` tag in zone 2", () => {
  test("a 29-member wave is trimmed to five rows and a static pointer — with no window attribute and no pager tag anywhere in the zone", async () => {
    await mountApp({ queue: board(TWENTY_NINE) });
    expectFocused040();

    // No window state, published or drawn — asserted FIRST so the reader runs
    // against a real render while the trim below is still red. Zone 1 keeps
    // its own (`data-window-size`, `data-window-offset`,
    // `data-hidden-earlier` — public/app.js:3116-3118); zone 2 grows none.
    const windowish = zoneAttrNames().filter((name) => /^data-(window|hidden|page)-/.test(name));
    expect(windowish).toEqual([]);

    // No pager tag. `▶` is deliberately NOT forbidden: it is IN_PROGRESS's own
    // status mark (`▶ in progress`, public/app-logic.mjs:1015). What is
    // forbidden is the DIRECTIONAL PAGER — `◀ N earlier` / `N later ▶`
    // (public/app.js:3055) — so the left glyph and both words are.
    const zoneText = norm(zone2().textContent).toLowerCase();
    expect(zoneText).not.toContain("◀");
    expect(zoneText).not.toMatch(/\bearlier\b/);
    expect(zoneText).not.toMatch(/\blater\b/);
    // And no clickable chrome beyond the rows themselves: the pointer is the
    // only thing the trim adds, and it is inert (asserted under AC16).
    expect(zone2().querySelectorAll("button").length).toBe(0);

    // The POSITIVE that makes every prohibition above non-vacuous: the trim is
    // real, so there IS a hidden remainder here — the exact situation zone 1
    // solved with a window and a pager, and the one §S5 forbids solving that
    // way ("Paging, not scrolling" governs the release STRIP; the wave's
    // remainder is summarised, and the table is its detail surface).
    expect(rowEls("1").length).toBe(DEFAULT_ROWS);
    expect(moreCount("1")).toBe(TWENTY_NINE_SCHEDULED - DEFAULT_ROWS);
  });
});

// ── AC28 — the row keeps the NODE's identity through the rewrite ────────────

describe("CR-CRU-096 AC28 — `roadmap-node`, `data-cr` and `data-status` survive the chip→row rewrite", () => {
  test("every trimmed row carries all three, inside the wave box — and a one-CR wave still holds exactly one node, PENDING then IN_PROGRESS", async () => {
    // The consumers this AC protects: tests/roadmap-visual-grammar.test.ts,
    // tests/roadmap-release-focus.test.ts,
    // tests/roadmap-selection-durability.test.ts, public/styles.css, and the
    // e2e pair tests/e2e/steps/roadmap-graph.steps.ts:84,96,102 driving
    // tests/e2e/features/roadmap-graph.feature:41-46.
    // roadmap-graph.feature's own shape FIRST, exactly as it drives it: ONE CR
    // in the wave, PENDING, then the same CR IN_PROGRESS after a plan is
    // filed. One actionable CR is one row, so the count the feature asserts
    // stays 1 through both — and this half already holds today, which is the
    // point: the rewrite must not move it.
    await mountApp({ queue: board(SINGLE_PENDING) });
    expectFocused040();
    expect(rowEls("1").length).toBe(1);
    expect(rowCrs("1")).toEqual(["CR-A"]);
    expect(rowStatuses("1")).toEqual(["PENDING"]);
    expect(moreEl("1")).toBeNull();

    await mountApp({ queue: board(SINGLE_RUNNING) });
    expectFocused040();
    expect(rowEls("1").length).toBe(1);
    expect(rowCrs("1")).toEqual(["CR-A"]);
    expect(rowStatuses("1")).toEqual(["IN_PROGRESS"]);
    expect(moreEl("1")).toBeNull();

    // And the same three attributes on every row of a TRIMMED wave.
    await mountApp({ queue: board(NINE) });
    expectFocused040();

    const rows = rowEls("1");
    for (const row of rows) {
      expect(row.getAttribute("data-testid")).toBe("roadmap-node");
      expect(row.getAttribute("data-cr")).toMatch(/^CR-Q-\d$/);
      expect(row.getAttribute("data-status")).toBe("PENDING");
      // The e2e step scopes its count to the wave box, so the rows must live
      // in it, not beside it.
      expect(waveEl("1").contains(row)).toBe(true);
    }
    expect(rows.length).toBe(DEFAULT_ROWS);
    // The pointer is not counted as a node by `box.getByTestId("roadmap-node")`.
    expect(waveEl("1").querySelectorAll('[data-testid="roadmap-node"]').length).toBe(DEFAULT_ROWS);
  });
});

// ── AC3, under the trim — the header count is WHOLE membership ─────────────
//
// C1 (cycle 309) made AC3 green against an UNTRIMMED wave. The trim is the
// change that could break it, so the non-regression is asserted here rather
// than trusted: the count is `box.entries.length` (public/app.js:2791) and the
// rows are a window on a subset of those entries. AC3's own two-wave fixture
// stays C1's; this is one wave, sized so the two facts cannot be confused.

describe("CR-CRU-096 AC3 (non-regression) — the trim does not change the count the header states", () => {
  test("a 29-member wave showing five rows still renders 29", async () => {
    await mountApp({ queue: board(TWENTY_NINE) });
    expectFocused040();

    expect(countText("1")).toBe("29");
    expect(waveEl("1").getAttribute("data-cr-count")).toBe("29");

    // Non-vacuity: the count is none of the numbers the trim produces.
    expect(rowEls("1").length).toBe(DEFAULT_ROWS);
    expect(countText("1")).not.toBe(String(DEFAULT_ROWS));
    expect(countText("1")).not.toBe(String(TWENTY_NINE_SCHEDULED));
    expect(countText("1")).not.toBe(String(TWENTY_NINE_MERGED));
    expect(norm(headerEl("1").textContent)).toContain("29");
  });
});

// ── AC9b/AC9c — a DRAWN node states its disposition in TEXT ────────────────
//
// The regression guard for this cycle's own mistake. AC9a's trim removes the
// dispositioned PENDING ROW from a wave box; it was read once as removing the
// node's lifecycle BADGE too, on the premise that no node could carry a
// disposition any more. That premise is false on two live paths (AC9b), and on
// both of them the removal left the disposition published as the
// `data-lifecycle` ATTRIBUTE with no rendered text — which §S8 forbids
// outright: "no element relies on colour alone; status is also written as
// text, so the view survives a colour-blind reader and a greyscale
// screenshot". An attribute is not text. So the assertion is on the TEXT.

describe("CR-CRU-096 AC9b/AC9c — wherever a node renders, its disposition is stated in WORDS and not as an attribute alone", () => {
  test("a running dispositioned CR keeps its row and its badge, and the untrimmed loose group states a VOID member's disposition in text", async () => {
    // AC9c — IN_PROGRESS ∈ the row union whatever the `lifecycle`.
    await mountApp({ queue: board(RUNNING_DISPOSITIONED) });
    expectFocused040();
    expect(rowCrs("1")).toEqual(["CR-A", "CR-D"]);

    const running = rowEls("1").find((row) => row.getAttribute("data-cr") === "CR-D");
    if (running === undefined) throw new Error("the running dispositioned CR renders no row");
    expect(running.getAttribute("data-status")).toBe("IN_PROGRESS");
    expect(running.getAttribute("data-lifecycle")).toBe("SUPERSEDED");
    const runningBadge = running.querySelector<HTMLElement>(
      '[data-testid="roadmap-node-lifecycle"]',
    );
    expect(runningBadge, "the drawn node publishes SUPERSEDED as an attribute only").not.toBeNull();
    expect(norm(runningBadge!.textContent).toLowerCase()).toContain("superseded");
    // The whole node reads it: the words are in the rendered text, which is
    // what a greyscale screenshot keeps and an attribute is not.
    expect(norm(running.textContent).toLowerCase()).toContain("superseded");
    // And the disposition rides BESIDE the status, never instead of it.
    expect(norm(running.textContent)).toContain("CR-D");
    expect(norm(running.textContent).toLowerCase()).toContain("in progress");

    // Non-vacuity, on the same render: an entry declaring no `lifecycle` gets
    // neither the attribute nor the badge — absent, never defaulted.
    const plain = rowEls("1").find((row) => row.getAttribute("data-cr") === "CR-A");
    if (plain === undefined) throw new Error("the undispositioned CR renders no row");
    expect(plain.hasAttribute("data-lifecycle")).toBe(false);
    expect(plain.querySelector('[data-testid="roadmap-node-lifecycle"]')).toBeNull();

    // AC9b/AC18a — the second path: a dispositioned PENDING member, which a
    // TRIMMED wave box would not draw, is drawn by the wave-less group.
    await mountApp({ queue: board(LOOSE_DISPOSITIONED) });
    expect(flow().getAttribute("data-version")).toBe("0.4.0");
    // Located by being OUTSIDE every wave box, so nothing here names the
    // group's class.
    const loose = all('[data-testid="roadmap-node"]').filter(
      (node) => node.closest('[data-testid="roadmap-wave"]') === null,
    );
    expect(loose.map((node) => node.getAttribute("data-cr"))).toEqual(["CR-A", "CR-V"]);

    const dead = loose.find((node) => node.getAttribute("data-cr") === "CR-V");
    if (dead === undefined) throw new Error("the loose group draws no node for the VOID member");
    expect(dead.getAttribute("data-status")).toBe("PENDING");
    expect(dead.getAttribute("data-lifecycle")).toBe("VOID");
    const deadBadge = dead.querySelector<HTMLElement>('[data-testid="roadmap-node-lifecycle"]');
    expect(deadBadge, "the loose group publishes VOID as an attribute only").not.toBeNull();
    expect(norm(deadBadge!.textContent).toLowerCase()).toContain("void");
    expect(norm(dead.textContent).toLowerCase()).toContain("void");
    // The two dispositions do not render as one word.
    expect(norm(deadBadge!.textContent)).not.toBe(norm(runningBadge!.textContent));
  });
});
