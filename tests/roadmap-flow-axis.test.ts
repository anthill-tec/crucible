// CR-CRU-096 C4 (cycle 312) — ZONE 2 LAYS OUT ON THE DESIGN'S HORIZONTAL
// AXIS, and a SHIPPED release renders a DELIVERED SUMMARY rather than a wave
// reconstruction.
//
// Spec: docs/changes/CR-CRU-096-zone-2-drifts-from-the-approved-design.md
//       §S5's last paragraph (zone 2 draws EVERY wave of the focused release —
//       "one box per wave, not one box" — and "a multi-wave active release is
//       the case that WIDENS this zone, so §S6's budget is per wave box"),
//       §S6 (the flow axis and its connectors: `Start` stadium, wave, release
//       gate, `End` stadium, joined by connectors, matching zone 1's spine),
//       §S7 (the SHIPPED path: a delivered summary, its three deltas — the
//       axis, the wave-run compression, the gate label — and the package
//       VERSIONS live carries, which are extra truth and are KEPT),
//       §S8 (shape and colour grammar: no new shapes or colours; a connector
//       is not a CR rectangle and must not read as one).
//       AC19, AC20, AC21, AC22, AC23, AC24 — plus AC3, AC5a, AC12b and AC16
//       asserted here ONLY as non-regressions of C1, C2 and C3, and AC29 on
//       every fixture below.
//
// Approved design: `.lavish/crucible-workflow-flowchart.html`. Its `div.flow`
//       is a `display:flex` row (`align-items:center`, no `flex-direction`, so
//       the default `row`) whose children ALTERNATE stage and connector:
//         §1 ACTIVE  — term Start · arrow · div.wave · arrow · gatecol · arrow · term End
//         §2 SHIPPED — term Start · arrow · div.delivered · arrow · gatecol · arrow · term End
//       `.arrow{flex:0 0 24px;height:2px;background:var(--line)}` with a CSS
//       triangle in `::after` — a LINE, carrying no text and no identity.
//       §2's `div.delivered` reads `60 CRs` / `waves 1–4 · shipped 2026-08-19`
//       / the two packages, and §2's gate diamond reads `0.1.0` + `shipped`
//       INSIDE the rotated square. (The artifact defeats shell `grep`; its
//       bytes were read in Python.)
//
// SCOPE — the axis (§S6/AC19/AC20) and the shipped path (§S7/AC21–AC24) only.
// C1's header, C2's rows and trim and C3's roll-up and annotation slot are
// asserted here only where this cycle could break them. Zones 1 and 3 are out
// of scope entirely (AC26) — zone 1 is READ here, never asserted against, and
// only as the axis REFERENCE §S6 names ("matching zone 1's spine").
//
// WHICH HALF IS DEFERRED TO CYCLE 313's CHROMIUM SUITE (AC25/AC27), and why:
// happy-dom runs NO layout engine and NO cascade, so AC20's second clause —
// "the rendered width does not exceed the measured surface (1130px at a 1600px
// viewport)" — is UNMEASURABLE here. Every box in this harness measures 0×0
// (`installLayout` below hands out exactly two rects, for the strip's own
// track and ruler), so a width assertion in this file would be an assertion
// about the stub. §S6's 300 × 228 trimmed wave box, its 596px horizontal
// budget and its 1130px available surface are therefore 313's to measure in a
// real engine at a real viewport. What IS decidable without an engine, and is
// asserted below, is the STRUCTURE the width budget is a budget FOR: the
// stages the zone puts on one axis, their ORDER, their SIBLINGHOOD, the
// CONNECTORS joining them, and the axis DIRECTION the shipped stylesheet
// declares for the containers that really rendered (C1's `animatingSelectors`
// technique as C2/C3 generalised it into `declaredValue`). A horizontal axis
// that reads correctly in the DOM and overflows at 1600px is 313's failure to
// report; a vertical stack is this cycle's.
//
// WHAT IS ASSERTED, AND WHY IT IS NEVER A FUNCTION NAME. Every assertion below
// reads RENDERED text, PUBLISHED attributes, the DERIVED sibling axis, and the
// stylesheet's declaration for a real rendered element. The wave-run
// compression (AC22) is a pure string/array transform and WHERE it lives is
// GREEN's to choose — the house pattern would put it in public/app-logic.mjs
// beside `focusedReleaseView`, which already stamps `waves`, `rows`,
// `hiddenCount`, `mergedCount` and `nextCr`, and render it in public/app.js —
// but nothing here names a function, a class, or a module.
//
// AC29 — EVERY FIXTURE ID IS SYNTHETIC (`CR-A-nn`, `CR-B-nn`, `CR-C-nn`,
// `CR-Z-nn`, `CR-Y-n`, `CR-S-x`, `CR-U-n`), as are the release versions
// (`0.4.0`/`0.5.0`/`1.0.0`), the ledger's `crs`, its `packages` and its
// `releasedAt`. Crucible is project-INDEPENDENT: a criterion that only holds
// while our own backlog has a given shape is not a criterion. CR ids named in
// comments and `describe` titles are provenance, never fixture data.
//
// RED phase — expected to FAIL against current production, which renders
// `Start`, a `div.app-flow-waves` (or the delivered summary), the gate and
// `End` as four siblings of a `flex-direction: column` container
// (public/styles.css:1253-1258) with NO connector element of any kind
// (`roadmap-flow-connector` appears nowhere in public/app.js), enumerates the
// shipped wave list as `waves 1, 2, 3, 4` (public/app.js:2953 —
// `waves.join(", ")`), and draws only the version inside the shipped gate's
// diamond (public/app.js:3001).
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

// ── Fixture types (the wire shapes, as tests/roadmap-wave-rollup.test.ts
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

// ── Fixtures: the IN-FLIGHT board ───────────────────────────────────────────
//
// 0.1.0 shipped, 0.4.0 proposed (the DEFAULT FOCUS — `releaseStripFocusIndex`,
// public/app-logic.mjs:173, focuses the FIRST proposed gate and 0.4.0's
// timestamp precedes 0.5.0's), 0.5.0 proposed but not focused. Each AC19
// fixture swaps the focused release's membership and the wave set its proposal
// declares; nothing else varies.

const SHIP_010 = 1787149125; // 2026-08-19, epoch SECONDS
const TARGET_040 = 1790000000;

const SHIPPED_010: ReleaseFixture = {
  version: "0.1.0",
  commit: "5ynth01",
  releasedAt: SHIP_010,
  crs: ["CR-S-A", "CR-S-B"],
  packages: [],
  timestamp: SHIP_010 * 1000,
};

/** The focused proposal. Its declared `waves[]` is kept CONSISTENT with the
 *  queue membership in every fixture below, deliberately: the spec is SILENT
 *  on which of the two published answers is zone 2's oracle for "the waves of
 *  the focused release" — the proposal's own `waves[]` (`src/v2.ts:2053`) or
 *  the waves its queue members DECLARE — and no assertion here may rest on
 *  their disagreement. (Reported as a silence; today's implementation groups
 *  the members.) */
const proposed040 = (waves: string[]): ProposalFixture => ({
  label: "0.4.0",
  targetAt: TARGET_040,
  timestamp: 1787000000,
  waves,
});

const PROPOSED_050: ProposalFixture = {
  label: "0.5.0",
  timestamp: 1787000001,
  waves: ["3"],
};

/** The other releases' members — the SCOPING probe, in two halves.
 *
 *  Waves `9` and `3` are labels the focused release NEVER spans (AC19: "one
 *  box per wave OF THE FOCUSED RELEASE"), so no box may ever be drawn for
 *  them. Waves `1` and `2` are labels the focused release DOES span and
 *  another release ALSO uses, so those boxes must hold the focused release's
 *  members alone — the stronger half, which a filter on `wave` rather than on
 *  membership would fail while still drawing the right number of boxes. */
const OTHER_MEMBERS: QueueFixture[] = [
  { cr: "CR-S-A", title: "CR-S-A — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 1, release: "0.1.0" },
  { cr: "CR-S-B", title: "CR-S-B — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 2, release: "0.1.0" },
  { cr: "CR-U-1", title: "CR-U-1 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 900, release: "0.5.0" },
  { cr: "CR-U-2", title: "CR-U-2 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 910, release: "0.5.0" },
  { cr: "CR-U-3", title: "CR-U-3 — a later release's member, in a wave label 0.4.0 also uses", wave: "2", dependsOn: [], status: "PENDING", seq: 920, release: "0.5.0" },
  { cr: "CR-U-4", title: "CR-U-4 — a later release's member, in a wave label 0.4.0 also uses", wave: "1", dependsOn: [], status: "PENDING", seq: 930, release: "0.5.0" },
];

/** Wave labels present on the board that the focused release never spans. */
const UNSPANNED_WAVES = ["3", "9"];

/** A member of the focused release. `seq` is the STORED position the server
 *  published; nothing here may sort on it. */
function member(cr: string, wave: string, status: QueueStatus, seq: number): QueueFixture {
  return {
    cr,
    title: `${cr} — synthetic member`,
    wave,
    dependsOn: [],
    status,
    seq,
    release: "0.4.0",
    ...(status === "IN_PROGRESS" ? { planId: 41 } : {}),
  } satisfies QueueFixture;
}

/** The board, with the focused release's membership supplied. */
const board = (members: QueueFixture[]): QueueFixture[] => [...OTHER_MEMBERS, ...members];

/** §S5's default, C2's constant: five rows. */
const DEFAULT_ROWS = 5;

// ── AC19's ONE-WAVE fixture ─────────────────────────────────────────────────
//
// Nine members in wave `1`: three merged (one of them `COMPLETED_UNTRACKED`,
// AC6a) and six actionable, so the box trims to five rows and states `+1 more`
// — a box whose HEADER (9), ROLL-UP (3), ROW COUNT (5) and REMAINDER (1) are
// four different numbers, which is what makes the non-regression assertions
// below non-vacuous. One box, and the board's waves `2`, `3` and `9` are all
// absent from the zone.
const ONE_WAVE: QueueFixture[] = [
  member("CR-A-01", "1", "COMPLETED", 10),
  member("CR-A-02", "1", "COMPLETED_UNTRACKED", 20),
  member("CR-A-03", "1", "COMPLETED", 30),
  member("CR-A-04", "1", "PENDING", 40),
  member("CR-A-05", "1", "PENDING", 50),
  member("CR-A-06", "1", "PENDING", 60),
  member("CR-A-07", "1", "PENDING", 70),
  member("CR-A-08", "1", "PENDING", 80),
  member("CR-A-09", "1", "PENDING", 90),
];
const ONE_WAVE_SIZE = 9;
const ONE_WAVE_MERGED = 3;
const ONE_WAVE_ROWS = ["CR-A-04", "CR-A-05", "CR-A-06", "CR-A-07", "CR-A-08"];
const ONE_WAVE_HIDDEN = 1;
const ONE_WAVE_MARKED = "CR-A-04";

// ── AC19's TWO-WAVE fixture ─────────────────────────────────────────────────
//
// AC19's own sentence: "a two-wave release renders two". Wave `1` holds eight
// members (three merged, five actionable → five rows, no remainder); wave `2`
// holds four, none merged. So ONE render discriminates every fact this cycle
// could break:
//   • two boxes, in first-appearance order (AC19);
//   • each header states its OWN whole membership, 8 and 4 — never the zone's
//     12 and never the project's total (AC3, C1);
//   • the roll-up is PER WAVE and is ABSENT on the wave with nothing merged
//     (AC5a, C3);
//   • exactly ONE row in the whole zone says `next` (AC12b, C3) — a per-box
//     marker would also mark wave `2`'s own first actionable row.
// Wave `2`'s label is shared with a 0.5.0 member (`CR-U-3`), so a box built
// from the wave LABEL rather than from membership answers 5 for its header.
const TWO_WAVES: QueueFixture[] = [
  member("CR-B-01", "1", "COMPLETED", 10),
  member("CR-B-02", "1", "COMPLETED_UNTRACKED", 20),
  member("CR-B-03", "1", "COMPLETED", 30),
  member("CR-B-04", "1", "PENDING", 40),
  member("CR-B-05", "1", "PENDING", 50),
  member("CR-B-06", "1", "PENDING", 60),
  member("CR-B-07", "1", "PENDING", 70),
  member("CR-B-08", "1", "PENDING", 80),
  member("CR-B-11", "2", "PENDING", 110),
  member("CR-B-12", "2", "PENDING", 120),
  member("CR-B-13", "2", "PENDING", 130),
  member("CR-B-14", "2", "PENDING", 140),
];
const TWO_WAVES_SIZES: Record<string, number> = { "1": 8, "2": 4 };
const TWO_WAVES_MERGED = 3;
const TWO_WAVES_MARKED = "CR-B-04";
/** What a PER-BOX marker would mark as well — wave `2`'s own first actionable
 *  row, and the second `next` AC12b forbids. */
const TWO_WAVES_PER_BOX = "CR-B-11";

// ── AC19's THREE-WAVE fixture, with a NON-CONSECUTIVE label set ─────────────
//
// Waves `1`, `2` and `4`, authored INTERLEAVED, which is the case AC16 (C1)
// pinned: a wave revisited later opens exactly one box, and the box order is
// FIRST APPEARANCE — here `1`, `2`, `4`, which is deliberately NOT the order
// the labels are authored in and NOT numeric order of the authoring. Wave `2`
// holds the one running member, so this render also proves the axis carries a
// box with motion in it without changing the stage sequence.
const THREE_WAVES: QueueFixture[] = [
  member("CR-C-01", "1", "COMPLETED", 10),
  member("CR-C-11", "2", "PENDING", 110),
  member("CR-C-21", "4", "PENDING", 210),
  member("CR-C-02", "1", "PENDING", 20),
  member("CR-C-12", "2", "IN_PROGRESS", 120),
];
const THREE_WAVES_ORDER = ["1", "2", "4"];
const THREE_WAVES_SIZES: Record<string, number> = { "1": 2, "2": 2, "4": 1 };
const THREE_WAVES_MARKED = "CR-C-02";

// ── Fixtures: the SHIPPED board (§S7) ───────────────────────────────────────
//
// A shipped focus needs no click: with NOTHING proposed there is no release in
// flight, so `releaseStripFocusIndex` (public/app-logic.mjs:173) lands on the
// LAST gate — the newest shipped tag — which is the one ledger row below.
//
// The ledger record is authored synthetically end to end (AC29): a synthetic
// version, a synthetic `releasedAt`, eleven synthetic `crs` and two synthetic
// packages, each with a VERSION (§S7 — live carries package versions the
// design did not show, and they are extra truth that is KEPT, so AC21 asserts
// them).
//
// `crs.length` is ELEVEN and the queue lists eleven members of it, but the
// board also carries two entries that are NOT in `crs`: a shipped release's
// membership is the LEDGER's `crs`, not the queue's, so `CR-Y-1`/`CR-Y-2` and
// their wave `8` may appear nowhere in the summary.

const SHIP_100 = 1781308800; // 2026-06-13, epoch SECONDS
const SHIP_100_DAY = "2026-06-13";
const DELIVERED_CRS = [
  "CR-Z-01",
  "CR-Z-02",
  "CR-Z-03",
  "CR-Z-04",
  "CR-Z-05",
  "CR-Z-06",
  "CR-Z-07",
  "CR-Z-08",
  "CR-Z-09",
  "CR-Z-10",
  "CR-Z-11",
];
const DELIVERED_PACKAGES: PackageFixture[] = [
  { registry: "pypi", name: "synth-axi", version: "3.1.4" },
  { registry: "npm", name: "@synth/synth-server", version: "3.1.4" },
];
const DELIVERED_PACKAGE_TEXTS = [
  "pypi · synth-axi 3.1.4",
  "npm · @synth/synth-server 3.1.4",
];

const SHIPPED_100: ReleaseFixture = {
  version: "1.0.0",
  commit: "5ynth10",
  releasedAt: SHIP_100,
  crs: DELIVERED_CRS,
  packages: DELIVERED_PACKAGES,
  timestamp: SHIP_100 * 1000,
};

/** Board entries that are NOT in the ledger's `crs`, in a wave the release did
 *  not span. Nothing about them may reach the delivered summary. */
const NOT_DELIVERED: QueueFixture[] = [
  { cr: "CR-Y-1", title: "CR-Y-1 — a later release's member", wave: "8", dependsOn: [], status: "PENDING", seq: 810, release: "1.1.0" },
  { cr: "CR-Y-2", title: "CR-Y-2 — a later release's member", wave: "8", dependsOn: [], status: "COMPLETED", seq: 820, release: "1.1.0" },
];

/** The delivered members, dealt ROUND-ROBIN across the given wave labels so
 *  the authoring INTERLEAVES them: first appearance is exactly `waves` in the
 *  order given, and a wave revisited later still contributes to one group.
 *  Every member is `COMPLETED` — this release shipped. */
function delivered(waves: string[]): QueueFixture[] {
  return DELIVERED_CRS.map((cr, at) => ({
    cr,
    title: `${cr} — delivered`,
    wave: waves[at % waves.length] as string,
    dependsOn: [],
    status: "COMPLETED" as QueueStatus,
    seq: (at + 1) * 10,
    release: "1.0.0",
  }));
}

/** The shipped board: the one ledger row, nothing proposed, and the queue. */
const shippedBoard = (waves: string[]): MountOpts => ({
  releases: [SHIPPED_100],
  proposals: [],
  queue: [...NOT_DELIVERED, ...delivered(waves)],
});

// ── Harness (tests/roadmap-wave-rollup.test.ts, verbatim) ───────────────────

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
 *  here depends on paging. And it is supplied for the STRIP alone, which is
 *  why AC20's measured width budget is 313's and not this file's — every zone-2
 *  box measures 0×0 here. */
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
  const key = opts.key ?? "flow-axis-key";
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
      const proposals = opts.proposals ?? [proposed040(["1"]), PROPOSED_050];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [SHIPPED_010] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? board(ONE_WAVE) });
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
    throw new Error(`roadmap-flow-axis.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapFlowAxis=${cacheBust}`);

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

/** Zone 1, read ONLY as the axis REFERENCE §S6 names ("matching zone 1's
 *  spine"). Nothing in this file asserts anything ABOUT zone 1 — AC26 keeps its
 *  markup byte-identical — and no assertion below would change if zone 1's own
 *  declared axis changed, because the reference is compared, never assumed. */
function zone1(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-zone="1"]');
  if (el === null) throw new Error('no [data-zone="1"] rendered');
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

function headerEl(wave: string): HTMLElement {
  const header = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-header"]');
  if (header === null) {
    throw new Error(`wave ${wave} renders no [data-testid="roadmap-wave-header"]`);
  }
  return header;
}

function countText(wave: string): string {
  const el = headerEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-count"]');
  if (el === null) {
    throw new Error(`wave ${wave}'s header renders no [data-testid="roadmap-wave-count"]`);
  }
  return norm(el.textContent);
}

const moreEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-more"]');

const rollupEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-rollup"]');

/** The MERGED COUNT the roll-up states (C3's reader): the number it puts in
 *  front of the word, read positionally because the line may legitimately
 *  carry other digits. */
function rollupCount(wave: string): number {
  const el = rollupEl(wave);
  if (el === null) {
    throw new Error(
      `wave ${wave} renders no [data-testid="roadmap-wave-rollup"] line (box text: ${norm(waveEl(wave).textContent)})`,
    );
  }
  const text = norm(el.textContent);
  const found = /(\d+)\s+merged\b/i.exec(text);
  if (found === null) {
    throw new Error(`wave ${wave}'s roll-up states no \`N merged\` count — it reads "${text}"`);
  }
  return Number(found[1]);
}

const annotationEl = (row: HTMLElement): HTMLElement | null =>
  row.querySelector<HTMLElement>('[data-testid="roadmap-node-annotation"]');

const annotationText = (row: HTMLElement): string => norm(annotationEl(row)?.textContent ?? "");

/** Which rows of the WHOLE ZONE claim to be `next`, counted as ELEMENTS rather
 *  than as word matches over the zone's text: `textContent` concatenates a
 *  row's sibling spans with no separator, so the word never carries a `\b` on
 *  its left (C3 GREEN's `…pendingnext`). */
function markedCrs(): string[] {
  return all('[data-zone="2"] [data-testid="roadmap-node"]')
    .filter((row) => /\bnext\b/i.test(annotationText(row)))
    .map((row) => row.getAttribute("data-cr") ?? "");
}

// ── The SHIPPED summary's readers ──────────────────────────────────────────

const deliveredEl = (): HTMLElement | null =>
  zone2().querySelector<HTMLElement>('[data-testid="roadmap-delivered"]');

function deliveredPart(part: "crs" | "waves" | "date"): string {
  const el = zone2().querySelector<HTMLElement>(`[data-testid="roadmap-delivered-${part}"]`);
  if (el === null) {
    throw new Error(
      `the shipped summary renders no [data-testid="roadmap-delivered-${part}"] (zone text: ${norm(zone2().textContent)})`,
    );
  }
  return norm(el.textContent);
}

const packageTexts = (): string[] =>
  all('[data-zone="2"] [data-testid="roadmap-package"]').map((el) => norm(el.textContent));

function gateEl(): HTMLElement {
  const gate = document.querySelector<HTMLElement>('[data-testid="roadmap-flow-gate"]');
  if (gate === null) throw new Error('no [data-testid="roadmap-flow-gate"] rendered');
  return gate;
}

// ── The CSS reader: what the SHIPPED stylesheet declares for a real element ──
//
// C1's `animatingSelectors` (tests/roadmap-wave-header.test.ts:409) as C2 and
// C3 generalised it: every rule in public/styles.css that declares `prop` is
// collected, and the LAST one whose selector the given element MATCHES wins —
// source order, specificity ignored, which for this stylesheet's flat
// single-class rules is the same answer and is conservative where it is not.
// Comments are stripped first: a `/* … */` between one rule's `}` and the next
// selector is otherwise swallowed into that selector.

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

// ── The AXIS readers ───────────────────────────────────────────────────────
//
// The selector this cycle INTRODUCES: `roadmap-flow-connector`, §S6's own
// `div.arrow`. Named rather than inferred from the flow's child list because
// AC20's claim is about what JOINS the stages — "exactly one connector between
// each adjacent pair" is a statement about identifiable elements, and the
// alternative (treating every unclassified child as a connector) would let an
// unrelated wrapper satisfy the AC.

const CONNECTOR = '[data-testid="roadmap-flow-connector"]';

/** The role of each DIRECT CHILD of the flow, in document order — the zone's
 *  own axis, read off the render rather than assumed.
 *
 *  A child that IS or CONTAINS at least one wave box counts as the `wave`
 *  stage, deliberately: AC20 names four things on the axis and AC19 puts one
 *  box per wave, and the spec is SILENT on whether a multi-wave release's
 *  boxes are direct children of the flow or a single group child of it. Both
 *  readings satisfy AC20's sequence and both are accepted here, so GREEN keeps
 *  the choice. (Reported as a silence.) */
function axisRoles(): string[] {
  return Array.from(flow().children).map((child) => {
    if (child.matches(CONNECTOR)) return "connector";
    const testid = child.getAttribute("data-testid") ?? "";
    if (testid === "roadmap-flow-terminal") return child.getAttribute("data-terminal") ?? "terminal";
    if (testid === "roadmap-flow-gate") return "gate";
    if (testid === "roadmap-delivered") return "delivered";
    if (
      child.matches('[data-testid="roadmap-wave"]') ||
      child.querySelector('[data-testid="roadmap-wave"]') !== null
    ) {
      return "wave";
    }
    return `unclassified(${testid !== "" ? testid : child.className})`;
  });
}

/** The axis with the connectors removed — AC20's `Start`, wave(s), gate, `End`. */
const stageRoles = (): string[] => axisRoles().filter((role) => role !== "connector");

/** AC20's "JOINED BY connectors", stated as the invariant rather than as a
 *  count: every adjacent pair of stages has exactly one connector between
 *  them, the axis neither opens nor closes with one, and no two are adjacent.
 *  It therefore holds for a 4-stage axis (3 connectors) and for an N-wave axis
 *  that puts each box on the axis itself, without this file choosing between
 *  them. */
function joinFaults(): string[] {
  const roles = axisRoles();
  const faults: string[] = [];
  if (roles.length === 0) return ["the flow renders no children at all"];
  if (roles[0] === "connector") faults.push("the axis OPENS with a connector");
  if (roles[roles.length - 1] === "connector") faults.push("the axis ENDS with a connector");
  for (let at = 1; at < roles.length; at++) {
    const before = roles[at - 1] as string;
    const here = roles[at] as string;
    if (before !== "connector" && here !== "connector") {
      faults.push(`\`${before}\` and \`${here}\` are adjacent with no connector joining them`);
    }
    if (before === "connector" && here === "connector") {
      faults.push(`two connectors are adjacent at position ${at}`);
    }
  }
  return faults;
}

/** §S8 — a connector is a LINE, not a CR rectangle: it carries no CR
 *  identity, nothing selects or drills it, nothing counts it as a node, and it
 *  hides nothing behind a hover (AC14's grammar). §S6's own `.arrow` is
 *  `flex:0 0 24px; height:2px; background:var(--line)`. */
function connectorFaults(): string[] {
  const faults: string[] = [];
  for (const conn of all(`[data-zone="2"] ${CONNECTOR}`)) {
    for (const attr of ["data-cr", "data-status", "data-drill-source", "data-wave", "title"]) {
      if (conn.hasAttribute(attr)) faults.push(`a connector publishes \`${attr}\``);
    }
    if (conn.querySelector('[data-testid="roadmap-node"]') !== null) {
      faults.push("a connector contains a CR node");
    }
    if (conn.querySelector('[data-testid="roadmap-wave"]') !== null) {
      faults.push("a connector contains a wave box");
    }
    if (declared(conn, "cursor") === "pointer") faults.push("a connector declares `cursor: pointer`");
  }
  return faults;
}

/** The axis DIRECTION an element's own stylesheet declares. `flex-direction`
 *  is defaulted to `row` when no rule declares one — which is exactly what the
 *  approved artifact's `.flow{display:flex;align-items:center}` relies on — so
 *  GREEN may satisfy this by DELETING the `column` declaration as well as by
 *  writing `row`. */
function declaredAxis(el: Element): { display: string | null; direction: string } {
  return {
    display: declared(el, "display"),
    direction: declared(el, "flex-direction") ?? "row",
  };
}

/** The element the WAVE BOXES sit in, DERIVED from the rendered boxes rather
 *  than named (C2's `rowContainer` technique). */
function waveContainer(): HTMLElement {
  const boxes = waveEls();
  if (boxes.length === 0) throw new Error("no wave box rendered to contain");
  const parent = boxes[0]!.parentElement;
  if (parent === null) throw new Error("the wave boxes have no parent element");
  return parent;
}

// ── §S5/§S6/AC19 — one box PER WAVE of the focused release, all on one axis ──
//
// AC19's fact and AC20's axis are asserted on the SAME renders, deliberately:
// §S5's own last paragraph ties them — "a multi-wave active release is the case
// that WIDENS this zone, so §S6's budget is per wave box" — so the multi-wave
// board is precisely the board the axis has to carry, and a box count proved
// on a vertical stack proves nothing about the zone this CR is fixing. The
// C1–C3 non-regressions ride along on the same renders for the same reason:
// the axis rewrite is the change most likely to cost the header its count, the
// wave its roll-up, or the zone its single marker.

describe("CR-CRU-096 §S5/AC19 — zone 2 draws one box per wave OF THE FOCUSED RELEASE, and every one of them sits on the zone's single axis", () => {
  test("a one-wave release draws exactly one box, states its four different numbers, and stands on the axis `Start → wave → gate → End`", async () => {
    await mountApp({ queue: board(ONE_WAVE), proposals: [proposed040(["1"]), PROPOSED_050] });

    // The board really is focused on 0.4.0 (C1's assertion, never assumed).
    expect(flow().getAttribute("data-kind")).toBe("proposed");
    expect(flow().getAttribute("data-version")).toBe("0.4.0");

    // AC19 — ONE box, for the ONE wave the focused release spans. The board
    // carries waves `2`, `3` and `9` as well, and none of them is the focused
    // release's: a box drawn for a wave LABEL rather than for the focused
    // release's MEMBERSHIP draws four.
    expect(waveNames()).toEqual(["1"]);
    for (const unspanned of UNSPANNED_WAVES) {
      expect(waveNames()).not.toContain(unspanned);
    }
    expect(waveNames()).not.toContain("2");

    // Scoping's stronger half: wave `1`'s box holds the focused release's nine
    // members and NOT 0.5.0's `CR-U-4`, which declares the same wave label.
    expect(waveEl("1").getAttribute("data-cr-count")).toBe(String(ONE_WAVE_SIZE));
    expect(rowCrs("1")).not.toContain("CR-U-4");

    // C1/C2/C3 non-regression, on four numbers that are all different: the
    // header states WHOLE membership (AC3), the roll-up states the wave's
    // merged work (AC5/AC6), the body draws the trim (AC8/§S5.2) and the
    // pointer states the remainder (AC16).
    expect(countText("1")).toBe(String(ONE_WAVE_SIZE));
    expect(rollupCount("1")).toBe(ONE_WAVE_MERGED);
    expect(rowCrs("1")).toEqual(ONE_WAVE_ROWS);
    expect(rowCrs("1").length).toBe(DEFAULT_ROWS);
    expect(norm(moreEl("1")?.textContent ?? "")).toContain(`+${ONE_WAVE_HIDDEN} more`);
    expect(markedCrs()).toEqual([ONE_WAVE_MARKED]);

    // AC20 — and all four stages are SIBLINGS on one axis, in the design's
    // order, each adjacent pair joined by a connector.
    expect(stageRoles()).toEqual(["start", "wave", "gate", "end"]);
    expect(joinFaults()).toEqual([]);
  });

  test("a two-wave release draws TWO boxes, each stating its own membership, and both stand on the same axis between `Start` and the gate", async () => {
    await mountApp({
      queue: board(TWO_WAVES),
      proposals: [proposed040(["1", "2"]), PROPOSED_050],
    });
    expect(flow().getAttribute("data-kind")).toBe("proposed");
    expect(flow().getAttribute("data-version")).toBe("0.4.0");

    // AC19's own sentence: "a two-wave release renders two".
    expect(waveNames()).toEqual(["1", "2"]);
    for (const unspanned of UNSPANNED_WAVES) {
      expect(waveNames()).not.toContain(unspanned);
    }

    // AC3 (C1) non-regression — each header states its OWN whole membership, 8
    // and 4. Wave `2`'s label is shared with 0.5.0's `CR-U-3`, so a header
    // counting the wave LABEL answers 5; a header counting the ZONE answers
    // 12.
    expect(countText("1")).toBe(String(TWO_WAVES_SIZES["1"]));
    expect(countText("2")).toBe(String(TWO_WAVES_SIZES["2"]));
    expect(rowCrs("2")).not.toContain("CR-U-3");

    // AC5/AC5a (C3) non-regression — the roll-up is PER WAVE and follows the
    // merged work: wave `1` states 3, wave `2` has none merged and renders NO
    // line at all. Non-vacuity of the absence: wave `2` is a real, drawn box.
    expect(rollupCount("1")).toBe(TWO_WAVES_MERGED);
    expect(rollupEl("2")).toBeNull();
    expect(rowCrs("2")).toEqual(["CR-B-11", "CR-B-12", "CR-B-13", "CR-B-14"]);

    // AC12b (C3) non-regression — exactly ONE row in the WHOLE zone says
    // `next`, and it is wave `1`'s first actionable row. A per-box marker would
    // also mark `CR-B-11`.
    expect(TWO_WAVES_PER_BOX).not.toBe(TWO_WAVES_MARKED);
    expect(rowCrs("2")).toContain(TWO_WAVES_PER_BOX);
    expect(markedCrs()).toEqual([TWO_WAVES_MARKED]);

    // AC20 — two boxes, still ONE axis: `Start`, the waves, the gate, `End`,
    // joined by connectors. Whether the two boxes are two stages or one group
    // stage is GREEN's (a recorded silence); either way the sequence starts at
    // `Start`, ends at `End`, puts the gate after the last wave, and is joined
    // throughout.
    const stages = stageRoles();
    expect(stages[0]).toBe("start");
    expect(stages[stages.length - 1]).toBe("end");
    expect(stages.filter((role) => role === "wave").length).toBeGreaterThanOrEqual(1);
    expect(stages.indexOf("gate")).toBe(stages.length - 2);
    expect(stages.lastIndexOf("wave")).toBeLessThan(stages.indexOf("gate"));
    expect(stages.filter((role) => role.startsWith("unclassified"))).toEqual([]);
    expect(joinFaults()).toEqual([]);
  });

  test("a three-wave release with a NON-CONSECUTIVE label set draws three boxes in first-appearance order, on the axis", async () => {
    await mountApp({
      queue: board(THREE_WAVES),
      proposals: [proposed040(["1", "2", "4"]), PROPOSED_050],
    });
    expect(flow().getAttribute("data-kind")).toBe("proposed");

    // AC19 with AC16 (C1) riding along: waves `1` and `2` are each authored
    // twice, interleaved, and each opens exactly ONE box; the order is FIRST
    // APPEARANCE; the label set skips `3`, which belongs to 0.5.0 and must not
    // be filled in.
    expect(waveNames()).toEqual(THREE_WAVES_ORDER);
    expect(waveNames()).not.toContain("3");
    for (const [wave, size] of Object.entries(THREE_WAVES_SIZES)) {
      expect(countText(wave)).toBe(String(size));
    }

    // AC5a — only wave `1` has merged work, so only wave `1` states a line.
    expect(rollupCount("1")).toBe(1);
    expect(rollupEl("2")).toBeNull();
    expect(rollupEl("4")).toBeNull();

    // AC11a (C2) — the running member is drawn even though it is not
    // actionable, and AC12b's single marker is still the first ACTIONABLE row.
    expect(rowCrs("2")).toEqual(["CR-C-11", "CR-C-12"]);
    expect(markedCrs()).toEqual([THREE_WAVES_MARKED]);

    // AC20 — three boxes, one axis.
    const stages = stageRoles();
    expect(stages[0]).toBe("start");
    expect(stages[stages.length - 1]).toBe("end");
    expect(stages.indexOf("gate")).toBe(stages.length - 2);
    expect(stages.filter((role) => role.startsWith("unclassified"))).toEqual([]);
    expect(joinFaults()).toEqual([]);
  });
});

// ── §S6/AC20 — the axis itself: horizontal, and joined ─────────────────────

describe("CR-CRU-096 §S6/AC20 — zone 2 lays out HORIZONTALLY: `Start`, wave, gate, `End` as siblings on one axis, joined by connectors", () => {
  test("the four stages are SIBLINGS of one container, in the design's order, on a HORIZONTAL axis — the same one zone 1's spine declares — rather than a vertical stack", async () => {
    await mountApp();
    expect(waveNames()).toEqual(["1"]);

    // Half one, which ALREADY holds: the stages are children of ONE element —
    // the axis — rather than nested inside one another. `Start` is not inside
    // the wave group, the gate is not inside the waves, `End` is not inside
    // the gate, and nothing else is on the axis. Asserted rather than
    // trusted, because it is the half the axis rewrite could destroy while
    // fixing the other.
    const stages = stageRoles();
    expect(stages).toEqual(["start", "wave", "gate", "end"]);
    const terminals = all('[data-zone="2"] [data-testid="roadmap-flow-terminal"]');
    expect(terminals.map((el) => el.getAttribute("data-terminal"))).toEqual(["start", "end"]);
    for (const terminal of terminals) expect(terminal.parentElement).toBe(flow());
    expect(gateEl().parentElement).toBe(flow());

    // Half two, which is the DRIFT: four siblings of a `flex-direction:
    // column` container are a vertical STACK, not an axis. §S6 — "matching
    // zone 1's spine". The reference is READ off zone 1 rather than
    // hardcoded, so this states that the two zones AGREE rather than naming
    // a value; and it is decidable without an engine because it is what the
    // shipped stylesheet DECLARES for containers that really rendered. Zone 1
    // is not asserted about and is not modified (AC26).
    const spine = declaredAxis(zone1());
    const axis = declaredAxis(flow());
    expect(spine.direction).toBe("row");
    expect(axis.display).toBe(spine.display);
    expect(axis.direction).toBe(spine.direction);
    expect(axis.direction).toBe("row");
  });

  test("each adjacent pair of stages is joined by exactly one connector, and a connector is a line rather than a node", async () => {
    await mountApp();

    // AC20 — "with connectors". The design's `div.flow` alternates stage and
    // `div.arrow`, so a 4-stage axis carries 3 of them.
    const connectors = all(`[data-zone="2"] ${CONNECTOR}`);
    expect(connectors.length).toBe(stageRoles().length - 1);
    expect(joinFaults()).toEqual([]);

    // §S8 — and no connector reads as a CR: nothing about it publishes CR
    // identity, drills, selects or hides behind a hover.
    expect(connectorFaults()).toEqual([]);
    // It is not counted as a CR node anywhere: the zone's node total is still
    // exactly the rows the boxes drew.
    expect(all('[data-zone="2"] [data-testid="roadmap-node"]').length).toBe(DEFAULT_ROWS);
  });

  test("the multi-wave boxes lay out along the axis rather than stacking across it", async () => {
    // A RECORDED SILENCE, and the reason it is asserted anyway: no AC states
    // the direction of the container holding the wave boxes. §S5's last
    // paragraph does — "a multi-wave ACTIVE release is the case that WIDENS
    // this zone, so §S6's budget is per wave box" — and §S6's budget table is
    // per box. Widening is a HORIZONTAL claim, and a per-box budget is only a
    // budget if the boxes consume the same axis. This is the one test to
    // change if the ruling goes the other way, which is why it stands alone.
    await mountApp({
      queue: board(TWO_WAVES),
      proposals: [proposed040(["1", "2"]), PROPOSED_050],
    });
    expect(waveNames()).toEqual(["1", "2"]);

    const container = waveContainer();
    // Non-vacuity: the element read is really the one the two boxes sit in.
    expect(container.querySelectorAll('[data-testid="roadmap-wave"]').length).toBe(2);
    expect(declaredAxis(container).direction).toBe("row");
  });
});

// ── §S7/AC21 + AC24 — the SHIPPED path's delivered summary, on the same axis ─

describe("CR-CRU-096 §S7/AC21/AC24 — a shipped focus renders the delivered summary — no wave box, no CR node, the count, the ship date, every package with its version — on the same horizontal axis", () => {
  test("the shipped focus reconstructs no waves and states what the ledger recorded, and its axis is the in-flight path's", async () => {
    await mountApp(shippedBoard(["1", "2", "3", "4"]));

    // The board really is focused on the shipped tag: nothing is proposed, so
    // there is no release in flight and the strip lands on the newest ship.
    expect(flow().getAttribute("data-kind")).toBe("shipped");
    expect(flow().getAttribute("data-version")).toBe("1.0.0");

    // AC21 — 0 wave boxes and 0 CR nodes. The Workflow history view owns the
    // reconstruction; zone 2 states the delivery.
    expect(waveEls().length).toBe(0);
    expect(all('[data-zone="2"] [data-testid="roadmap-node"]').length).toBe(0);
    expect(deliveredEl()).not.toBeNull();

    // AC21 — the CR COUNT is the LEDGER's `crs.length` (11), the settled fact,
    // never how many of them the queue still lists and never the board's total
    // (13 entries here, two of them not in the release).
    expect(deliveredPart("crs")).toBe(`${DELIVERED_CRS.length} CRs`);

    // AC21 — the SHIP DATE, `resolveGateDate`'s one answer for `releasedAt`
    // (CR-078 AC30: no second date resolver).
    expect(deliveredPart("date")).toBe(`shipped ${SHIP_100_DAY}`);
    expect(gateEl().getAttribute("data-date-state")).toBe("dated");

    // AC21 + §S7 — EVERY package, WITH its version. The approved artifact
    // shows registry and name only; live carries the version too, and §S7 rules
    // that extra truth KEPT rather than trimmed to match the drawing.
    expect(packageTexts()).toEqual(DELIVERED_PACKAGE_TEXTS);
    for (const pkg of DELIVERED_PACKAGES) {
      expect(packageTexts().join(" | ")).toContain(pkg.version);
    }

    // Nothing outside the release reaches the summary.
    const summary = norm(zone2().textContent);
    expect(summary).not.toContain("CR-Y-1");
    expect(summary).not.toContain("CR-Y-2");
    expect(deliveredPart("waves")).not.toContain("8");

    // AC24 — the SAME axis as AC20, on the shipped path's own four stages.
    expect(stageRoles()).toEqual(["start", "delivered", "gate", "end"]);
    expect(joinFaults()).toEqual([]);
    expect(connectorFaults()).toEqual([]);
    const spine = declaredAxis(zone1());
    expect(declaredAxis(flow()).direction).toBe(spine.direction);
    expect(declaredAxis(flow()).direction).toBe("row");
  });
});

// ── §S7/AC22 — a contiguous wave RUN compresses ────────────────────────────
//
// The transform is a pure string/array one and where it belongs is GREEN's
// (see the header note). What is asserted is the RENDERED line only.
//
// The five cases are chosen so compression is proven to apply PER RUN and not
// merely to the whole set: a single wave (the no-op), a two-wave run, two
// waves that are NOT a run, the AC's own four-wave run, and a mixed set whose
// run stops short of its last member.

describe("CR-CRU-096 §S7/AC22 — the shipped summary compresses a contiguous wave run and lists a non-contiguous set", () => {
  test("waves 1,2,3,4 render `waves 1–4` — the AC's own case", async () => {
    await mountApp(shippedBoard(["1", "2", "3", "4"]));
    expect(flow().getAttribute("data-kind")).toBe("shipped");
    expect(deliveredPart("waves")).toBe("waves 1\u20134");
  });

  test("a single wave states `wave 5` — the compression's no-op, and the singular stays", async () => {
    await mountApp(shippedBoard(["5"]));
    expect(flow().getAttribute("data-kind")).toBe("shipped");
    // The no-op half: one wave is a run of one and renders as itself, with the
    // singular noun live already gets right.
    expect(deliveredPart("waves")).toBe("wave 5");
    expect(deliveredPart("waves")).not.toContain("\u2013");
    // …and the shipped path's axis, which is what this case fails on today.
    expect(stageRoles()).toEqual(["start", "delivered", "gate", "end"]);
    expect(joinFaults()).toEqual([]);
  });

  test("two CONTIGUOUS waves render `waves 1–2`", async () => {
    // A RECORDED SILENCE: AC22 states the rule on CONTIGUITY and says nothing
    // about a MINIMUM RUN LENGTH, and the approved artifact only ever draws a
    // run of four. Two adjacent waves ARE a contiguous run, so they compress —
    // a length threshold would be a second rule the spec does not state, and
    // `1–2` is no longer to read than `1, 2`. Reported; this is the one
    // assertion to change if the ruling goes the other way.
    await mountApp(shippedBoard(["1", "2"]));
    expect(flow().getAttribute("data-kind")).toBe("shipped");
    expect(deliveredPart("waves")).toBe("waves 1\u20132");
  });

  test("two NON-contiguous waves render the list, `waves 1, 3`, and never a range across the gap", async () => {
    await mountApp(shippedBoard(["1", "3"]));
    expect(flow().getAttribute("data-kind")).toBe("shipped");
    // AC22's second half. The over-application this guards is real: a
    // first-and-last reading of the same set answers `waves 1–3` and claims a
    // wave the release never spanned.
    expect(deliveredPart("waves")).toBe("waves 1, 3");
    expect(deliveredPart("waves")).not.toContain("\u2013");
    expect(deliveredPart("waves")).not.toContain("2");
    // …and the shipped path's axis, which is what this case fails on today.
    expect(stageRoles()).toEqual(["start", "delivered", "gate", "end"]);
    expect(joinFaults()).toEqual([]);
  });

  test("a MIXED set, 1,2,3,5, compresses its run and lists the rest — `waves 1–3, 5`", async () => {
    await mountApp(shippedBoard(["1", "2", "3", "5"]));
    expect(flow().getAttribute("data-kind")).toBe("shipped");
    // The per-RUN proof: a whole-set reading answers `waves 1–5` and claims
    // wave 4, which this release never spanned; a no-compression reading
    // answers `waves 1, 2, 3, 5`. The list separator is live's own `", "`
    // join, inherited rather than invented.
    expect(deliveredPart("waves")).toBe("waves 1\u20133, 5");
    expect(deliveredPart("waves")).not.toContain("4");
  });
});

// ── §S7/AC23 — the `shipped` word rides INSIDE the diamond ─────────────────

describe("CR-CRU-096 §S7/AC23 — the shipped gate renders the `shipped` label inside the diamond", () => {
  /** The DIAMOND, identified by §S8's shape grammar rather than by a class
   *  name: a diamond IS a square rotated 45°, so it is the one descendant of
   *  the gate the shipped stylesheet rotates by exactly that. This is what
   *  makes "INSIDE the diamond" assertable at all — the gate's date caption is
   *  a sibling of the shape, so a word rendered there would satisfy "somewhere
   *  in the gate" and fail the AC. */
  function gateDiamond(): HTMLElement {
    const gate = gateEl();
    const rotated = Array.from(gate.querySelectorAll<HTMLElement>("*")).filter(
      (el) => (declared(el, "transform") ?? "").replace(/\s+/g, "") === "rotate(45deg)",
    );
    if (rotated.length !== 1) {
      throw new Error(
        `the gate holds ${rotated.length} elements the stylesheet rotates by 45°, so the diamond is not identifiable (gate text: ${norm(gate.textContent)})`,
      );
    }
    return rotated[0]!;
  }

  test("the shipped diamond states the version AND the word `shipped`", async () => {
    await mountApp(shippedBoard(["1", "2", "3", "4"]));
    expect(flow().getAttribute("data-kind")).toBe("shipped");

    const diamond = gateDiamond();
    const inside = norm(diamond.textContent);
    // The version still rides inside it — the word is an ADDITION, not a
    // replacement (the artifact draws `0.1.0` and `shipped` in the same span).
    expect(inside).toContain("1.0.0");
    // AC23 itself. Read with `toContain` rather than a `\b` regex: sibling
    // spans concatenate with no separator, so the word may legitimately arrive
    // as `1.0.0shipped`.
    expect(inside.toLowerCase()).toContain("shipped");
    // And it is the DIAMOND that says it, not the caption beside it: the
    // gate's own text minus the diamond's still carries the date and not the
    // word.
    const outside = norm(gateEl().textContent).replace(inside, "");
    expect(outside).toContain(SHIP_100_DAY);
    expect(outside.toLowerCase()).not.toContain("shipped");
  });
});
