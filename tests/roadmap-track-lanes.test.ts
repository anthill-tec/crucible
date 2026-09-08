// CR-CRU-085 C1 (cycle 350) — TRACK SWIMLANES INSIDE A WAVE CONTAINER, and
// the laned wave header's third segment.
//
// Spec: docs/changes/CR-CRU-085-roadmap-multi-track-lanes.md
//       §S1 (the header's track-count segment), §S2 (the lane grammar, the
//       track source and the row-cap ruling), §S3 (degenerate cases render
//       nothing) — AC1–AC8.
// Approved design — THE AUTHORITY for this CR:
//       `.lavish/crucible-workflow-flowchart.html`
//       §4  the laned wave: `<h4><span>Wave 5 · active · 2 tracks</span>`
//           `<span>20</span></h4>` over a `div.lanes` grid of `label cell ·
//           row` PAIRS, one pair per track;
//       §5  the dashed divider is the track swimlane, multi-track only;
//       §7  "Track lanes + table column | drawn when | > 1 track reported".
//
// SCOPE — the LANES and the header segment they draw with. The wave
// container's own drawing rules are CR-CRU-078's and CR-CRU-096's and this CR
// changes none of them (AC4): they are asserted here only as the INVARIANT
// that lanes must not disturb, never re-specified.
//
// THE TEST IDS THIS FILE MINTS — the contract GREEN implements. They follow
// the shipped `roadmap-*` naming, and NONE of them is `roadmap-lane-badge`,
// which is CR-CRU-078's per-row `plan.track` badge (public/app.js:2495) and
// is a different fact on a different element:
//
//   roadmap-wave-lanes       the lane container — design §4's `div.lanes`,
//                            one per laned wave.
//   roadmap-wave-lane-label  a lane's LABEL CELL (design's `div.lbl`),
//                            carrying `data-track` and the declared track id
//                            as its text.
//   roadmap-wave-lane        a lane's ROW CELL — the element the track's CR
//                            nodes are drawn inside, carrying `data-track`.
//
// The label cell and the row cell are SIBLINGS under the container, in that
// order, because that is what the design's two-column grid is (AC5). A
// wrapper element around each pair would break the grid it specifies.
//
// The header's new segment is deliberately given NO id: the sibling suite
// (tests/roadmap-wave-header.test.ts) reads the `· active` marker out of the
// header's TEXT precisely because the header's internal structure is GREEN's
// to choose, and a second convention beside it would be the drift AC8 exists
// to prevent.
//
// EVERY FIXTURE ID IS SYNTHETIC (`CR-T-01`, `CR-P-03`, `CR-S-A`), and every
// track id is a fixture's own (`track-1`…): Crucible is single-track, so this
// CR is unobservable on its own board (spec Risk, second paragraph) and is
// proven against multi-track fixtures only. AC3 — no assertion below states a
// track count as a literal; every expectation is DERIVED from the fixture the
// test mounted, which is why the single-track case and the three-track case
// are the same assertion with different data.
//
// RED phase — expected to FAIL against current production, which renders no
// lane chrome at all (`RoadmapFlowWave`, public/app.js:2957-3059, draws
// `box.rows` straight into `div.app-flow-wave-body`) and a header of exactly
// two segments (`:2993-3003`). Each test below therefore carries a MULTI-TRACK
// arm: an absence-only assertion would pass vacuously against a production
// that never draws lanes for anything.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

// ── Fixture types (the wire shapes, as the sibling roadmap suites declare
//    them) ────────────────────────────────────────────────────────────────────

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

/** `src/types.ts:389-414` (`QueueEntry`) — what `GET …/queue` publishes, in the
 *  canonical order (CR-CRU-095 §S1: release → wave → seq). `track` is
 *  CR-CRU-091 §S2's wire field, and §S2 of this CR names it as the LANE
 *  source — the queue row's declared track, never the plan's. */
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
}

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  track?: string;
  cycles: { id: number; label: string; status: string }[];
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// One shipped tag (so the strip has a settled leg) and ONE live proposal,
// `0.4.0`, which `releaseStripFocusIndex` (public/app-logic.mjs:173-181)
// focuses by default as "the first live proposal". Zone 2 therefore draws
// exactly the proposal's wave `1`, and zone 3's columns are decided from that
// release's membership.

const SHIP_010 = 1787149125; // 2026-08-19, epoch SECONDS

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
  targetAt: 1790000000,
  timestamp: 1787000000,
  waves: ["1"],
};

const SHIPPED_MEMBERS: QueueFixture[] = [
  { cr: "CR-S-A", title: "CR-S-A — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 1, release: "0.1.0" },
  { cr: "CR-S-B", title: "CR-S-B — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 2, release: "0.1.0" },
];

/** The one wave every fixture below builds — the focused proposal's. */
const WAVE = "1";

function member(
  cr: string,
  status: QueueStatus,
  track: string | undefined,
  seq: number,
): QueueFixture {
  const entry: QueueFixture = {
    cr,
    title: `${cr} — synthetic wave member`,
    wave: WAVE,
    dependsOn: [],
    status,
    seq,
    release: "0.4.0",
  };
  if (track !== undefined) entry.track = track;
  return entry;
}

/** The SAME membership with every declared track removed — §S3's "no track
 *  data" case, and AC5/AC6's "the same fixture with the tracks taken away". */
const untracked = (entries: QueueFixture[]): QueueFixture[] =>
  entries.map(({ track: _dropped, ...rest }) => ({ ...rest }) satisfies QueueFixture);

/** The same membership collapsed onto ONE declared track — AC2's first case
 *  and AC7's second arm. Membership, order and status are untouched, so the
 *  only thing that changes between this and `TWO_TRACKS` is the track data. */
const oneTrack = (entries: QueueFixture[]): QueueFixture[] =>
  entries.map((entry) => ({ ...entry, track: "track-1" }) satisfies QueueFixture);

/** Two tracks, INTERLEAVED in the authored order, so "each CR sits in the lane
 *  of its reported track" (AC1) cannot be satisfied by splitting the drawn
 *  rows into halves. Four actionable members — under CR-CRU-096's row cap, so
 *  every one of them is drawn and nothing is hidden. */
const TWO_TRACKS: QueueFixture[] = [
  member("CR-T-01", "PENDING", "track-1", 10),
  member("CR-T-02", "PENDING", "track-2", 20),
  member("CR-T-03", "PENDING", "track-1", 30),
  member("CR-T-04", "PENDING", "track-2", 40),
];

/** Three tracks, also interleaved and also inside the cap: N is genuinely read
 *  from the data, so the two-track and three-track cases differ only in what
 *  the fixture declares. */
const THREE_TRACKS: QueueFixture[] = [
  member("CR-U-01", "PENDING", "track-1", 10),
  member("CR-U-02", "PENDING", "track-2", 20),
  member("CR-U-03", "PENDING", "track-3", 30),
  member("CR-U-04", "PENDING", "track-2", 40),
  member("CR-U-05", "PENDING", "track-1", 50),
];

const ONE_TRACK: QueueFixture[] = oneTrack(TWO_TRACKS);
const NO_TRACKS: QueueFixture[] = untracked(TWO_TRACKS);

/** §S2's ROW-CAP ruling, and AC4's invariant, in one membership:
 *
 *   • three merged members (the roll-up's count, never rows);
 *   • six actionable `track-1` members, the first five of which are the only
 *     SCHEDULED rows the box draws;
 *   • two actionable `track-2` members, authored AFTER them, so every one of
 *     `track-2`'s members is either merged or beyond the cap — its lane must
 *     still be drawn, with its label and NO rows, because the lane count comes
 *     from the wave's WHOLE membership;
 *   • one running `track-3` member, which EXTENDS the drawn rows (CR-CRU-096
 *     AC11a) rather than displacing a scheduled one.
 */
const CAPPED: QueueFixture[] = [
  member("CR-M-01", "COMPLETED", "track-1", 10),
  member("CR-M-02", "COMPLETED", "track-1", 20),
  member("CR-M-03", "COMPLETED", "track-2", 30),
  member("CR-P-01", "PENDING", "track-1", 40),
  member("CR-P-02", "PENDING", "track-1", 50),
  member("CR-P-03", "PENDING", "track-1", 60),
  member("CR-P-04", "PENDING", "track-1", 70),
  member("CR-P-05", "PENDING", "track-1", 80),
  member("CR-P-06", "PENDING", "track-1", 90),
  member("CR-P-07", "PENDING", "track-2", 100),
  member("CR-P-08", "PENDING", "track-2", 110),
  { ...member("CR-R-01", "IN_PROGRESS", "track-3", 120), planId: 41 },
];

const CAPPED_UNTRACKED: QueueFixture[] = untracked(CAPPED);

/** AC7's real SCOPE. A release spanning TWO waves whose two declared tracks
 *  both sit in wave 1 — wave 2's members declare none. §S2 scopes the LANES to
 *  one wave's membership (`box.entries`) while the table's `track` column is
 *  `roadmapTableColumns` over the whole focused-release membership, so this is
 *  the membership on which the two scopes give different answers. */
const SECOND_WAVE = "2";

const TWO_WAVE_PROPOSAL: ProposalFixture = { ...PROPOSED_040, waves: [WAVE, SECOND_WAVE] };

const TRACKS_IN_ONE_WAVE: QueueFixture[] = [
  ...TWO_TRACKS,
  { ...member("CR-W2-01", "PENDING", undefined, 50), wave: SECOND_WAVE },
  { ...member("CR-W2-02", "PENDING", undefined, 60), wave: SECOND_WAVE },
];

/** CR-CRU-108 §S3/AC7 — declared tracks that are in the QUEUE but in NO
 *  focused-release wave: the two shipped `0.1.0` members, each given a lane id
 *  of its own. §S1 (68b5a0a) made the queue read publish the PROJECT's
 *  declared tracks over every entry it returns, so these rows are what makes
 *  the three scopes give three different answers over one mount —
 *  project: `track-1`, `track-7`, `track-9`; focused release: `track-1`;
 *  wave 1: `track-1`. Without them the project-level list and the release's
 *  coincide and no assertion can tell which one a renderer read. */
const FOREIGN_TRACK_MEMBERS: QueueFixture[] = SHIPPED_MEMBERS.map((entry, index) => ({
  ...entry,
  track: `track-${7 + index * 2}`,
}));

/** The focused two-wave proposal on ONE declared track: wave 1's members all
 *  report `track-1` and wave 2's report none. SINGLE-track to both of zone 2's
 *  scopes, MULTI-track to the project — which is the whole point. */
const ONE_TRACK_IN_ONE_WAVE: QueueFixture[] = [
  member("CR-T-01", "PENDING", "track-1", 10),
  member("CR-T-03", "PENDING", "track-1", 30),
  { ...member("CR-W2-01", "PENDING", undefined, 50), wave: SECOND_WAVE },
  { ...member("CR-W2-02", "PENDING", undefined, 60), wave: SECOND_WAVE },
];

/** `queueOf` with the shipped leg carrying tracks of its own. */
const queueWithForeignTracks = (members: QueueFixture[]): QueueFixture[] => [
  ...FOREIGN_TRACK_MEMBERS,
  ...members,
];

/** CR-CRU-096 §S5.2's shipped row cap — the container's rule, referenced here
 *  so the expectations below are derived from the fixture rather than copied
 *  off a render. */
const ROW_CAP = 5;

const queueOf = (members: QueueFixture[]): QueueFixture[] => [...SHIPPED_MEMBERS, ...members];

// ── Fixture-side derivations (AC3: the expectation is read from the DATA) ───

/** The distinct declared tracks of a membership, in FIRST-APPEARANCE order —
 *  the same rule `roadmapTableColumns` already applies to the table's `track`
 *  column (`distinctLabels`, public/app-logic.mjs:1152-1159), which §S2 names
 *  as the lanes' one derivation. Duplicated here on the FIXTURE side on
 *  purpose: a test that imported production's derivation could not catch
 *  production deriving it wrongly.
 *
 *  Named `fixtureTracks`, NOT `declaredTracks`: the server exports a
 *  `declaredTracks` (src/store.ts) that answers the PROJECT-level published
 *  list SORTED, and this is the browser-side, first-appearance-order copy over
 *  ONE membership. Sharing the name would read as the same fact twice. */
const fixtureTracks = (members: QueueFixture[]): string[] => {
  const seen = new Set<string>();
  for (const entry of members) {
    const raw = entry.track;
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (text !== "") seen.add(text);
  }
  return [...seen];
};

/** Design §7 — "Track lanes + table column | drawn when | > 1 track reported".
 *  One rule, applied to the fixture, so every lane-count expectation below is
 *  the same expression over different data. */
const expectedLaneCount = (members: QueueFixture[]): number => {
  const tracks = fixtureTracks(members);
  return tracks.length > 1 ? tracks.length : 0;
};

/** CR-CRU-096 §S5.2 — the members the box DRAWS as rows: the top of the
 *  actionable queue union every running member, in the published order. The
 *  lanes partition exactly this set and may not widen it (§S2's ruling). */
const drawnMembers = (members: QueueFixture[]): QueueFixture[] => {
  const actionable = members.filter((entry) => entry.status === "PENDING");
  const scheduled = new Set(actionable.slice(0, ROW_CAP));
  return members.filter((entry) => scheduled.has(entry) || entry.status === "IN_PROGRESS");
};

const hiddenCount = (members: QueueFixture[]): number =>
  Math.max(0, members.filter((entry) => entry.status === "PENDING").length - ROW_CAP);

const mergedCount = (members: QueueFixture[]): number =>
  members.filter(
    (entry) => entry.status === "COMPLETED" || entry.status === "COMPLETED_UNTRACKED",
  ).length;

// ── Harness (tests/roadmap-wave-header.test.ts, verbatim) ───────────────────

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
 *  supply it. */
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
  const key = opts.key ?? "track-lanes-key";
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
      const proposals = opts.proposals ?? [PROPOSED_040];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [SHIPPED_010] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? queueOf(TWO_TRACKS) });
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
    throw new Error(`roadmap-track-lanes.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapTrackLanes=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production shell driving its
 *  own fetch chain and van.js's real reactive scheduler. */
async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

// ── DOM readers ────────────────────────────────────────────────────────────
//
// The three ids this CR mints, named once.

const LANES_SEL = '[data-testid="roadmap-wave-lanes"]';
const LANE_SEL = '[data-testid="roadmap-wave-lane"]';
const LANE_LABEL_SEL = '[data-testid="roadmap-wave-lane-label"]';
const NODE_SEL = '[data-testid="roadmap-node"]';

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

function flow(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="roadmap-flow"]');
  if (el === null) throw new Error('no [data-testid="roadmap-flow"] rendered');
  return el;
}

const waveEls = (): HTMLElement[] => all('[data-testid="roadmap-wave"]');
const waveNames = (): string[] => waveEls().map((w) => w.getAttribute("data-wave") ?? "");

function waveEl(wave: string): HTMLElement {
  const box = waveEls().find((w) => w.getAttribute("data-wave") === wave);
  if (box === undefined) {
    throw new Error(
      `no wave container rendered for wave ${wave} (have: ${waveNames().join(", ")})`,
    );
  }
  return box;
}

const norm = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim();

function headerEl(wave: string): HTMLElement {
  const header = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-header"]');
  if (header === null) {
    throw new Error(`wave ${wave} renders no [data-testid="roadmap-wave-header"]`);
  }
  return header;
}

const headerText = (wave: string): string => norm(headerEl(wave).textContent).toLowerCase();

const boxText = (wave: string): string => norm(waveEl(wave).textContent).toLowerCase();

function countText(wave: string): string {
  const el = headerEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-count"]');
  if (el === null) {
    throw new Error(`wave ${wave}'s header renders no [data-testid="roadmap-wave-count"]`);
  }
  return norm(el.textContent);
}

const rollupText = (wave: string): string | null => {
  const el = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-rollup"]');
  return el === null ? null : norm(el.textContent);
};

const moreText = (wave: string): string | null => {
  const el = waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-more"]');
  return el === null ? null : norm(el.textContent);
};

const moreEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-more"]');

const nodeEls = (wave: string): HTMLElement[] =>
  Array.from(waveEl(wave).querySelectorAll<HTMLElement>(NODE_SEL));

const nodeCrs = (wave: string): string[] =>
  nodeEls(wave).map((n) => n.getAttribute("data-cr") ?? "");

function nodeEl(wave: string, cr: string): HTMLElement {
  const node = nodeEls(wave).find((n) => n.getAttribute("data-cr") === cr);
  if (node === undefined) {
    throw new Error(`wave ${wave} renders no node for ${cr} (have: ${nodeCrs(wave).join(", ")})`);
  }
  return node;
}

// ── The lane chrome this CR mints ──────────────────────────────────────────

const lanesEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>(LANES_SEL);

function lanesElOrThrow(wave: string): HTMLElement {
  const el = lanesEl(wave);
  if (el === null) {
    throw new Error(
      `wave ${wave} renders no ${LANES_SEL} lane container (box text: ${boxText(wave)})`,
    );
  }
  return el;
}

const laneEls = (wave: string): HTMLElement[] =>
  Array.from(waveEl(wave).querySelectorAll<HTMLElement>(LANE_SEL));

const laneLabelEls = (wave: string): HTMLElement[] =>
  Array.from(waveEl(wave).querySelectorAll<HTMLElement>(LANE_LABEL_SEL));

const laneTracks = (wave: string): string[] =>
  laneEls(wave).map((lane) => lane.getAttribute("data-track") ?? "");

const laneLabelTracks = (wave: string): string[] =>
  laneLabelEls(wave).map((label) => label.getAttribute("data-track") ?? "");

const laneLabelTexts = (wave: string): string[] => laneLabelEls(wave).map((l) => norm(l.textContent));

/** The track a FIXTURE entry declares, narrowed to the `string` a lane's
 *  `data-track` is compared against. A fixture that declares none is a broken
 *  fixture, not a passing null branch: the entry is named and the test fails
 *  loudly rather than asserting that "no lane holds it" is correct. */
const declaredTrackOf = (entry: QueueFixture): string => {
  const track = entry.track;
  if (track === undefined) {
    throw new Error(
      `fixture ${entry.cr} declares no track — it cannot assert a lane's data-track`,
    );
  }
  return track;
};

/** AC5's partition, read the only way that can fail for the reason it claims:
 *  how many lanes CONTAIN this node. `0` is an unlaned node, `2` is a node
 *  drawn twice or drawn inside nested lanes; the criterion is exactly `1`. */
const lanesContaining = (wave: string, node: HTMLElement): HTMLElement[] =>
  laneEls(wave).filter((lane) => lane.contains(node));

const laneNodeCrs = (wave: string, track: string): string[] => {
  const lane = laneEls(wave).find((l) => l.getAttribute("data-track") === track);
  if (lane === undefined) {
    throw new Error(`wave ${wave} renders no lane for track ${track} (have: ${laneTracks(wave).join(", ")})`);
  }
  return Array.from(lane.querySelectorAll<HTMLElement>(NODE_SEL)).map(
    (n) => n.getAttribute("data-cr") ?? "",
  );
};

/** AC8 — the track count the HEADER states, in words, as the design's third
 *  segment. Read out of the header's text rather than off a nested tag, for
 *  the same reason the sibling suite reads `· active` that way. The segment is
 *  the last thing in the identity phrase and the membership count is the next
 *  SPAN, so the header's `textContent` runs the two together (`2 tracks20`) —
 *  the tail guard rejects a longer WORD (`trackside`) without demanding the
 *  whitespace no markup puts between two adjacent spans. */
const headerTrackCount = (wave: string): number | null => {
  const match = /·\s*(\d+)\s+tracks?(?![a-z])/.exec(headerText(wave));
  return match === null ? null : Number(match[1]);
};

/** AC7 — the table's `track` column, the one this CR must NOT add a second
 *  rule for (`roadmapTableColumns`, public/app-logic.mjs:1176-1182). */
const tableHasTrackColumn = (): boolean =>
  document.querySelector('[data-testid="roadmap-table-head"] [data-column="track"]') !== null;

// ── AC1 — N reported tracks draw N lanes, and every CR sits in its own ──────

describe("CR-CRU-085 AC1 — a wave draws one lane per REPORTED track, and each CR node sits in the lane of its own track", () => {
  test("two interleaved tracks draw the fixture's two lanes, each holding exactly its own track's nodes", async () => {
    await mountApp({ queue: queueOf(TWO_TRACKS) });

    // Non-vacuity: the focus really is the proposal whose wave this is.
    expect(flow().getAttribute("data-version")).toBe("0.4.0");
    expect(waveNames()).toEqual([WAVE]);

    const tracks = fixtureTracks(TWO_TRACKS);
    expect(laneTracks(WAVE)).toEqual(tracks);
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(TWO_TRACKS));

    // Every member is inside the cap here, so every one of them is drawn —
    // and each is inside the lane its OWN row declared, not the lane its
    // position would imply (the fixture interleaves the two tracks).
    for (const entry of TWO_TRACKS) {
      const holders = lanesContaining(WAVE, nodeEl(WAVE, entry.cr));
      expect(holders.map((lane) => lane.getAttribute("data-track"))).toEqual([
        declaredTrackOf(entry),
      ]);
    }

    for (const track of tracks) {
      expect(laneNodeCrs(WAVE, track)).toEqual(
        TWO_TRACKS.filter((entry) => entry.track === track).map((entry) => entry.cr),
      );
    }
  });

  test("three reported tracks draw three lanes, labelled with the declared track ids in the order they are first reported", async () => {
    await mountApp({ queue: queueOf(THREE_TRACKS) });

    const tracks = fixtureTracks(THREE_TRACKS);
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(THREE_TRACKS));
    expect(laneTracks(WAVE)).toEqual(tracks);

    // The lane says WHICH track it is in words — §S8's greyscale invariant:
    // position in the grid is never the only channel.
    expect(laneLabelTexts(WAVE)).toEqual(tracks);

    for (const entry of THREE_TRACKS) {
      const holders = lanesContaining(WAVE, nodeEl(WAVE, entry.cr));
      expect(holders.map((lane) => lane.getAttribute("data-track"))).toEqual([
        declaredTrackOf(entry),
      ]);
    }
  });
});

// ── AC2 / §S3 — one track, or none, renders NOTHING, and nothing is wrong ───

describe("CR-CRU-085 AC2/§S3 — a single track and no track data are not error states: they draw no lane chrome at all", () => {
  test("a wave whose members all declare the SAME track draws no lane container, no lane and no lane label — while the same membership on two tracks draws both lanes", async () => {
    await mountApp({ queue: queueOf(ONE_TRACK) });

    // Non-vacuity: the members ARE reporting a track, and the wave IS drawn
    // with all of them — so the absence below is the CONDITION's answer, not
    // an empty render.
    expect(fixtureTracks(ONE_TRACK)).toEqual(["track-1"]);
    expect(nodeCrs(WAVE)).toEqual(ONE_TRACK.map((entry) => entry.cr));

    expect(lanesEl(WAVE)).toBeNull();
    expect(laneEls(WAVE)).toEqual([]);
    expect(laneLabelEls(WAVE)).toEqual([]);
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(ONE_TRACK));

    // The SAME assertion, the same membership, one datum changed: two declared
    // tracks. Without this arm the absence above passes against a production
    // that can never draw a lane for anything.
    await mountApp({ queue: queueOf(TWO_TRACKS) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(TWO_TRACKS));
    expect(lanesEl(WAVE)).not.toBeNull();
  });

  test("a wave whose members declare NO track draws no lanes and states no error, warning or empty state anywhere in the box", async () => {
    await mountApp({ queue: queueOf(NO_TRACKS) });

    expect(fixtureTracks(NO_TRACKS)).toEqual([]);
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(NO_TRACKS));
    expect(lanesEl(WAVE)).toBeNull();

    // The box draws its work as usual — the trackless case is the NORMAL case.
    expect(nodeCrs(WAVE)).toEqual(NO_TRACKS.map((entry) => entry.cr));

    // §S3 — no message stands in for the missing chrome, in the box or under
    // it: no empty state, no error node, and no word saying something is
    // wrong or absent.
    expect(waveEl(WAVE).querySelector('[data-testid="roadmap-empty"]')).toBeNull();
    expect(waveEl(WAVE).querySelector('[class*="error"], [class*="warn"]')).toBeNull();
    expect(boxText(WAVE)).not.toMatch(/error|warning|invalid|unknown|not declared|no track/);

    // Non-vacuity arm — the same fixture with tracks declared draws lanes,
    // and still says nothing is wrong.
    await mountApp({ queue: queueOf(TWO_TRACKS) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(TWO_TRACKS));
    expect(boxText(WAVE)).not.toMatch(/error|warning|invalid|unknown|not declared|no track/);
  });
});

// ── AC3 — the lane count is READ FROM THE DATA, never asserted as a literal ─

describe("CR-CRU-085 AC3 — the lane count is derived from the fixture, so the single-track case and the multi-track case are one assertion", () => {
  test("zero, one, two and three declared tracks each render exactly `> 1 ? distinct tracks : 0` lanes, under the identical assertion", async () => {
    const fixtures: { what: string; members: QueueFixture[] }[] = [
      { what: "no track data", members: NO_TRACKS },
      { what: "one declared track", members: ONE_TRACK },
      { what: "two declared tracks", members: TWO_TRACKS },
      { what: "three declared tracks", members: THREE_TRACKS },
    ];

    // The fixtures really do span the four cases — otherwise the loop below
    // could assert the same thing four times.
    expect(fixtures.map((f) => fixtureTracks(f.members).length)).toEqual([0, 1, 2, 3]);

    for (const { what, members } of fixtures) {
      await mountApp({ queue: queueOf(members) });
      const expected = expectedLaneCount(members);
      expect({ what, lanes: laneTracks(WAVE).length }).toEqual({ what, lanes: expected });
      expect(laneLabelEls(WAVE).length).toBe(expected);
      expect(lanesEl(WAVE) === null).toBe(expected === 0);
    }
  });
});

// ── AC4 — the CONTAINER's drawing rules are CR-078's and CR-096's, untouched ─

describe("CR-CRU-085 AC4 — lanes change none of the container's drawing rules: the whole-membership count, the roll-up, the row cap and the single `+N more` are what they were", () => {
  test("a laned wave states its whole membership, rolls up its merged work once, draws the capped rows and one wave-level `+N more` — the same values the same fixture renders with no track data", async () => {
    await mountApp({ queue: queueOf(CAPPED_UNTRACKED) });

    // What CR-078/CR-096 draw for this membership, measured rather than
    // assumed — the baseline the laned render must reproduce.
    const baseline = {
      count: countText(WAVE),
      rollup: rollupText(WAVE),
      more: moreText(WAVE),
      nodes: nodeCrs(WAVE),
    };
    expect(baseline.count).toBe(String(CAPPED.length));
    expect(baseline.rollup).toBe(`${mergedCount(CAPPED)} merged ✓ · awaiting the tag`);
    expect(baseline.more).toBe(`+${hiddenCount(CAPPED)} more — see the table below`);
    expect(baseline.nodes).toEqual(drawnMembers(CAPPED).map((entry) => entry.cr));
    expect(laneEls(WAVE)).toEqual([]);

    await mountApp({ queue: queueOf(CAPPED) });

    // Lanes really are drawn for this fixture — so what follows is the laned
    // box's answer, not the unlaned one measured twice.
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(CAPPED));

    // AC4 — every drawing rule, unchanged. The count is the WHOLE membership
    // (not the drawn rows, not the actionable remainder); the roll-up is
    // stated ONCE; the cap still admits exactly the scheduled top plus every
    // running member; and there is exactly ONE `+N more`, at wave level —
    // never one per lane.
    expect(countText(WAVE)).toBe(baseline.count);
    expect(rollupText(WAVE)).toBe(baseline.rollup);
    expect(waveEl(WAVE).querySelectorAll('[data-testid="roadmap-wave-rollup"]').length).toBe(1);
    expect(moreText(WAVE)).toBe(baseline.more);
    expect(waveEl(WAVE).querySelectorAll('[data-testid="roadmap-wave-more"]').length).toBe(1);
    expect(nodeCrs(WAVE).slice().sort()).toEqual(baseline.nodes.slice().sort());

    // …and no `+N more` hid inside a lane, which is how a per-lane pointer
    // would smuggle a second remainder in.
    for (const lane of laneEls(WAVE)) {
      expect(lane.querySelector('[data-testid="roadmap-wave-more"]')).toBeNull();
      expect(lane.querySelector('[data-testid="roadmap-wave-rollup"]')).toBeNull();
    }
  });
});

// ── AC5 — laning is a PARTITION, in the design's grid form ──────────────────

describe("CR-CRU-085 AC5 — every node in a laned wave belongs to exactly one lane, and the lanes are the container's `label cell · row` sibling pairs", () => {
  test("each rendered node is a descendant of exactly ONE lane, and the container's children are one label cell followed by one row cell per track", async () => {
    await mountApp({ queue: queueOf(CAPPED) });

    const tracks = fixtureTracks(CAPPED);
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(CAPPED));

    // The partition: exactly one, never zero (a node drawn outside the lanes)
    // and never two (nested lanes, or a node drawn twice).
    const nodes = nodeEls(WAVE);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(lanesContaining(WAVE, node).length).toBe(1);
    }

    // Design §4's grid: `div.lbl` and the row cell are SIBLINGS under
    // `div.lanes`, label first, one pair per track — a wrapper per lane would
    // not be the two-column grid the design specifies.
    const children = Array.from(lanesElOrThrow(WAVE).children) as HTMLElement[];
    expect(children.map((child) => child.getAttribute("data-testid"))).toEqual(
      tracks.flatMap(() => ["roadmap-wave-lane-label", "roadmap-wave-lane"]),
    );
    expect(children.map((child) => child.getAttribute("data-track"))).toEqual(
      tracks.flatMap((track) => [track, track]),
    );
    expect(laneLabelTracks(WAVE)).toEqual(tracks);
    expect(laneLabelTexts(WAVE)).toEqual(tracks);
  });

  test("the wave's node count and its `+N more` are identical with and without track data, and each lane holds its own track's drawn rows in the published order", async () => {
    await mountApp({ queue: queueOf(CAPPED_UNTRACKED) });
    const unlanedNodes = nodeCrs(WAVE);
    const unlanedMore = moreText(WAVE);

    await mountApp({ queue: queueOf(CAPPED) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(CAPPED));

    // The lanes PARTITION the rows the box already showed: they never widen
    // the drawn set, and never re-derive the remainder.
    expect(nodeCrs(WAVE).length).toBe(unlanedNodes.length);
    expect(nodeCrs(WAVE).slice().sort()).toEqual(unlanedNodes.slice().sort());
    expect(moreText(WAVE)).toBe(unlanedMore);

    // Every drawn row appears in exactly one lane, and the lanes' contents
    // union back to the whole drawn set in the queue's published order.
    const drawn = new Set(unlanedNodes);
    for (const track of fixtureTracks(CAPPED)) {
      expect(laneNodeCrs(WAVE, track)).toEqual(
        CAPPED.filter((entry) => entry.track === track && drawn.has(entry.cr)).map(
          (entry) => entry.cr,
        ),
      );
    }
  });
});

// ── AC6 — with the chrome absent, CR-078's render is reproduced exactly ─────

describe("CR-CRU-085 AC6 — removing the track data reproduces the pre-lane render exactly", () => {
  test("the untracked fixture draws the same nodes, in the published order, as siblings of the `+N more` pointer under one parent and with no lane chrome — while the tracked fixture draws the same node set inside lanes", async () => {
    await mountApp({ queue: queueOf(CAPPED_UNTRACKED) });

    // CR-078/CR-096's structure: the rows and the pointer are siblings in the
    // wave's body, and nothing stands between a node and that body.
    const nodes = nodeEls(WAVE);
    expect(nodeCrs(WAVE)).toEqual(drawnMembers(CAPPED).map((entry) => entry.cr));
    const parents = new Set(nodes.map((node) => node.parentElement));
    expect(parents.size).toBe(1);
    const body = [...parents][0];
    expect(body).not.toBeNull();
    const pointer = moreEl(WAVE);
    expect(pointer).not.toBeNull();
    expect(pointer?.parentElement).toBe(body as HTMLElement);

    // …and no lane chrome exists to be reproduced.
    expect(lanesEl(WAVE)).toBeNull();
    expect(laneEls(WAVE)).toEqual([]);
    expect(laneLabelEls(WAVE)).toEqual([]);
    expect(headerText(WAVE)).toBe(`wave ${WAVE} · active${countText(WAVE)}`);

    // Non-vacuity — the ONLY difference is the track data: the same
    // membership with tracks declared draws lanes and the same node set.
    await mountApp({ queue: queueOf(CAPPED) });
    expect(lanesEl(WAVE)).not.toBeNull();
    expect(nodeCrs(WAVE).slice().sort()).toEqual(
      drawnMembers(CAPPED).map((entry) => entry.cr).sort(),
    );
  });
});

// ── AC7 — lanes and the table's `track` column are ONE condition ────────────

describe("CR-CRU-085 AC7 — the lanes and the table's `track` column appear and disappear together, from the one derivation", () => {
  test("multi-track data draws both the lanes and the table's `track` column; the same membership on one track draws neither", async () => {
    await mountApp({ queue: queueOf(TWO_TRACKS) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(TWO_TRACKS));
    expect(tableHasTrackColumn()).toBe(true);

    await mountApp({ queue: queueOf(ONE_TRACK) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(ONE_TRACK));
    expect(tableHasTrackColumn()).toBe(false);

    await mountApp({ queue: queueOf(NO_TRACKS) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(NO_TRACKS));
    expect(tableHasTrackColumn()).toBe(false);
  });

  // §S2 is why "together" is a statement about the DERIVATION and not about
  // every box on the page: the lanes are scoped to ONE wave's membership
  // (`box.entries`) and the table's `track` column to the whole focused
  // release's (`roadmapTableColumns`). Both read the same declared `track`
  // through the same rule, so neither can report a track the other does not
  // know — but a release whose tracks all sit in one wave draws the column
  // once and the lanes in that wave only, and the wave beside it stays
  // CR-CRU-078's flat list. Nothing pinned that, and AC7's wording ("appear
  // and disappear together") reads stricter than the behaviour §S2 mandates.
  test("a release whose two tracks both sit in ONE wave shows the table's `track` column, lanes that wave, and leaves the other wave unlaned (§S2's per-wave scope)", async () => {
    await mountApp({ proposals: [TWO_WAVE_PROPOSAL], queue: queueOf(TRACKS_IN_ONE_WAVE) });

    // Non-vacuity: the focus is the two-wave proposal and BOTH its waves draw.
    expect(flow().getAttribute("data-version")).toBe("0.4.0");
    expect(waveNames()).toEqual([WAVE, SECOND_WAVE]);

    // The whole release reports two tracks, so the table states the column.
    expect(tableHasTrackColumn()).toBe(true);

    // Wave 1 holds both of them and draws both lanes; wave 2 reports none and
    // draws no lane, no label and no track segment in its header.
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(TWO_TRACKS));
    expect(laneEls(SECOND_WAVE).length).toBe(0);
    expect(laneLabelEls(SECOND_WAVE)).toEqual([]);
    expect(headerTrackCount(SECOND_WAVE)).toBeNull();

    // And wave 2 still DREW its members — the absence above is the track
    // scope's answer, not an empty box.
    expect(nodeCrs(SECOND_WAVE)).toEqual(["CR-W2-01", "CR-W2-02"]);
  });
});

// ── CR-CRU-108 §S3/AC7 — the two scopes survive the published-list cutover ──
//
// STATUS — declared PASS-ON-ARRIVAL guard. CR-CRU-085 shipped both scopes and
// the test above pins the multi-wave/one-wave shape; what NOTHING pinned is
// which SET each scope reads. §S1 (68b5a0a) published a PROJECT-level `tracks`
// list on the queue read and §S2 (c555faa) made the fleet consume it, so there
// is now a third, WIDER answer sitting in the very payload zone 2 renders
// from — and the CR's own non-goals forbid either of zone 2's derivations from
// being replaced by it ("the scopes are deliberate").
//
// WHY IT IS NOT A TAUTOLOGY: in every fixture above, the project's declared
// tracks and the focused release's are the SAME list, so a renderer swapped
// onto the project-level list would keep them all green. This mount breaks
// that tie — the shipped `0.1.0` leg declares `track-7` and `track-9`, which
// are in the queue read and in no wave of the focused proposal. It therefore
// FAILS the moment the table's column stops being `roadmapTableColumns` over
// the focused RELEASE's membership (CR-CRU-078 AC12), or a wave's lanes stop
// being `distinctLabels` over THAT WAVE's membership (CR-CRU-085 §S2), and
// starts being the published project list instead.
describe("CR-CRU-108 §S3/AC7 — the table's column and the wave's lanes keep their scopes against the project-level published list", () => {
  test("a release whose members declare ONE track shows NO column and NO lanes, even though the QUEUE it was read from declares three", async () => {
    const queue = queueWithForeignTracks(ONE_TRACK_IN_ONE_WAVE);

    // Non-vacuity, stated as data: over the WHOLE read the fixture declares
    // three lanes; the focused release declares exactly one. Unsorted because
    // `fixtureTracks` is the FIRST-APPEARANCE-order copy above — not the
    // server's sorted published list.
    expect(fixtureTracks(queue)).toEqual(["track-7", "track-9", "track-1"]);
    expect(fixtureTracks(ONE_TRACK_IN_ONE_WAVE)).toEqual(["track-1"]);

    await mountApp({ proposals: [TWO_WAVE_PROPOSAL], queue });

    // The focused release is the two-wave proposal and BOTH waves drew.
    expect(flow().getAttribute("data-version")).toBe("0.4.0");
    expect(waveNames()).toEqual([WAVE, SECOND_WAVE]);

    // The table's column is the RELEASE's answer (one track → no column), not
    // the project's (three → column).
    expect(tableHasTrackColumn()).toBe(false);

    // …and each wave's lanes are that WAVE's answer: neither is laned, and
    // `track-7`/`track-9` appear nowhere in zone 2's chrome.
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(ONE_TRACK_IN_ONE_WAVE));
    expect(lanesEl(WAVE)).toBeNull();
    expect(lanesEl(SECOND_WAVE)).toBeNull();
    expect(laneLabelTexts(WAVE)).toEqual([]);
    expect(headerTrackCount(WAVE)).toBeNull();
    expect(headerTrackCount(SECOND_WAVE)).toBeNull();
    expect(boxText(WAVE)).not.toContain("track-7");
    expect(boxText(SECOND_WAVE)).not.toContain("track-9");

    // The absence is the scope's answer, not an empty zone: every member still
    // drew, in its own wave.
    expect(nodeCrs(WAVE)).toEqual(["CR-T-01", "CR-T-03"]);
    expect(nodeCrs(SECOND_WAVE)).toEqual(["CR-W2-01", "CR-W2-02"]);
  });

  test("the SAME foreign-track queue with TWO release tracks in wave 1 draws the column and exactly wave 1's two lanes — never the queue's other two", async () => {
    const queue = queueWithForeignTracks(TRACKS_IN_ONE_WAVE);

    // Four declared lanes in the read; two of them belong to the release.
    expect(fixtureTracks(queue)).toHaveLength(4);
    expect(fixtureTracks(TRACKS_IN_ONE_WAVE)).toEqual(fixtureTracks(TWO_TRACKS));

    await mountApp({ proposals: [TWO_WAVE_PROPOSAL], queue });

    // The release reports two tracks, so the column is stated — the same
    // fixture as the arm above differing ONLY in the members' track data,
    // which is what makes that arm's `false` a measurement.
    expect(tableHasTrackColumn()).toBe(true);

    // Wave 1 draws exactly ITS two lanes: not one per project track, and not
    // one per release track spread across the waves.
    expect(laneTracks(WAVE)).toEqual(fixtureTracks(TWO_TRACKS));
    expect(laneTracks(WAVE)).not.toContain("track-7");
    expect(laneTracks(WAVE)).not.toContain("track-9");
    expect(headerTrackCount(WAVE)).toBe(fixtureTracks(TWO_TRACKS).length);

    // Wave 2 declares none and stays unlaned, whatever the project publishes.
    expect(laneEls(SECOND_WAVE)).toEqual([]);
    expect(headerTrackCount(SECOND_WAVE)).toBeNull();
    expect(nodeCrs(SECOND_WAVE)).toEqual(["CR-W2-01", "CR-W2-02"]);
  });
});

// ── AC8 — the laned header's third segment, in words ───────────────────────

describe("CR-CRU-085 AC8 — a laned wave's header states its track count in WORDS, as the design's third segment", () => {
  test("the header reads `Wave <n> · active · <k> tracks`, and the k it states is the number of lanes drawn for that same fixture", async () => {
    await mountApp({ queue: queueOf(TWO_TRACKS) });
    expect(headerText(WAVE)).toContain(`wave ${WAVE} · active · ${fixtureTracks(TWO_TRACKS).length} tracks`);
    expect(headerTrackCount(WAVE)).toBe(laneEls(WAVE).length);

    // The same header on a three-track fixture states three — one derivation,
    // read off the data, never a second one that could disagree with the
    // lanes it labels.
    await mountApp({ queue: queueOf(THREE_TRACKS) });
    expect(headerText(WAVE)).toContain(`wave ${WAVE} · active · ${fixtureTracks(THREE_TRACKS).length} tracks`);
    expect(headerTrackCount(WAVE)).toBe(laneEls(WAVE).length);
    expect(headerTrackCount(WAVE)).toBe(expectedLaneCount(THREE_TRACKS));

    // AC4 — the header's other facts are untouched: identity, the active
    // marker, and the WHOLE membership count.
    expect(countText(WAVE)).toBe(String(THREE_TRACKS.length));
    expect(waveEl(WAVE).getAttribute("data-cr-count")).toBe(String(THREE_TRACKS.length));
    expect(headerText(WAVE)).toContain("· active");
  });

  test("a wave that draws no lanes carries no track segment at all, on one track or none — and still states its identity, its active marker and its count", async () => {
    for (const members of [ONE_TRACK, NO_TRACKS]) {
      await mountApp({ queue: queueOf(members) });
      expect(laneEls(WAVE).length).toBe(expectedLaneCount(members));
      expect(headerTrackCount(WAVE)).toBeNull();
      expect(headerText(WAVE)).not.toMatch(/\btracks?\b/);
      expect(headerText(WAVE)).toContain(`wave ${WAVE} · active`);
      expect(countText(WAVE)).toBe(String(members.length));
    }

    // Non-vacuity — the segment DOES appear when lanes are drawn, so the
    // absence above is the condition's answer and not a header that never
    // states tracks at all.
    await mountApp({ queue: queueOf(TWO_TRACKS) });
    expect(headerTrackCount(WAVE)).toBe(fixtureTracks(TWO_TRACKS).length);
  });
});

// ── §S2's row-cap ruling — the lane count is the WHOLE membership's ─────────

describe("CR-CRU-085 §S2 — the lane count comes from the wave's WHOLE membership, not from the rows it draws", () => {
  test("a track whose every member is merged or beyond the row cap still draws its lane, with its label and no rows", async () => {
    await mountApp({ queue: queueOf(CAPPED) });

    const tracks = fixtureTracks(CAPPED);
    expect(laneTracks(WAVE)).toEqual(tracks);

    // The fixture's premise: `track-2` has members, and NOT ONE of them is
    // drawn — one is merged (rolled up, never a row) and the other two are
    // behind the `+N more`.
    const drawn = new Set(drawnMembers(CAPPED).map((entry) => entry.cr));
    const hiddenTrack = "track-2";
    const hiddenMembers = CAPPED.filter((entry) => entry.track === hiddenTrack);
    expect(hiddenMembers.length).toBeGreaterThan(0);
    expect(hiddenMembers.filter((entry) => drawn.has(entry.cr))).toEqual([]);

    // Its lane is drawn all the same — labelled, and empty.
    expect(laneTracks(WAVE)).toContain(hiddenTrack);
    expect(laneLabelTexts(WAVE)).toContain(hiddenTrack);
    expect(laneNodeCrs(WAVE, hiddenTrack)).toEqual([]);

    // And the count the header states counts it too — the lane count is a
    // fact about membership, so the header and the lanes agree.
    expect(headerTrackCount(WAVE)).toBe(tracks.length);

    // The other tracks are unaffected: the cap still decides what is DRAWN.
    expect(laneNodeCrs(WAVE, "track-1")).toEqual(
      CAPPED.filter((entry) => entry.track === "track-1" && drawn.has(entry.cr)).map(
        (entry) => entry.cr,
      ),
    );
    expect(laneNodeCrs(WAVE, "track-3")).toEqual(["CR-R-01"]);
  });
});

// ── AC9 / §S3 — a member declaring NO track is the IMPLICIT SOLO LANE ──────
//
// `docs/research/DN-model-b-language.md` (LOCKED): "`track` absent = implicit
// solo lane (no UI noise, byte-identical lens output)". So in a MIXED wave —
// some members declaring a track, others declaring none — an untracked member
// is neither homeless nor a residual lane: its node is drawn in the wave BODY,
// OUTSIDE the lane grid, with no lane, no label and no divider, byte-identical
// to the arrangement CR-078 gives it. The box therefore draws every node it
// counts, and the implicit lane is NOT a track: the header's count (AC8) and
// the table's `track` column stay the count of DECLARED tracks.
//
// RED — production publishes `box.lanes` from the declared tracks and, whenever
// it has any, draws the lane GRID INSTEAD of `box.rows`
// (public/app.js:3084-3101), so an untracked member's node is currently drawn
// NOWHERE: the box's count, its `+N more` and its visible nodes disagree.

/** A MIXED membership: three DECLARED tracks plus three members declaring
 *  none, INTERLEAVED so the untracked members are neither a prefix nor a
 *  suffix of the published order, one merged member so the roll-up is real,
 *  one running member, and a remainder past the cap so the wave's `+N more`
 *  is a number rather than an absence. */
const MIXED: QueueFixture[] = [
  member("CR-X-M1", "COMPLETED", "track-1", 10),
  member("CR-X-01", "PENDING", "track-1", 20),
  member("CR-X-02", "PENDING", undefined, 30),
  member("CR-X-03", "PENDING", "track-2", 40),
  member("CR-X-04", "PENDING", undefined, 50),
  member("CR-X-05", "PENDING", "track-1", 60),
  member("CR-X-06", "PENDING", "track-2", 70),
  member("CR-X-07", "PENDING", undefined, 80),
  { ...member("CR-X-R1", "IN_PROGRESS", "track-3", 90), planId: 51 },
];

/** The SAME membership with every declared track removed — the un-laned
 *  render AC9 calls "byte-identical": same members, same order, no lanes. */
const MIXED_UNTRACKED: QueueFixture[] = untracked(MIXED);

/** The same wave with its UNTRACKED members DELETED — AC9's "the same number
 *  of tracks it would state with the untracked members removed". */
const MIXED_DECLARED_ONLY: QueueFixture[] = MIXED.filter((entry) => entry.track !== undefined);

/** A laned fixture whose FIRST actionable row — the one the view names
 *  (`nextCr`, public/app-logic.mjs:1457-1464) — declares no track. */
const NEXT_UNTRACKED: QueueFixture[] = [
  member("CR-Y-01", "PENDING", undefined, 10),
  member("CR-Y-02", "PENDING", "track-1", 20),
  member("CR-Y-03", "PENDING", "track-2", 30),
];

/** The members of a fixture that declare NO track — the implicit solo lane's
 *  membership, derived from the data like every other expectation (AC3). */
const untrackedOf = (members: QueueFixture[]): QueueFixture[] =>
  members.filter((entry) => entry.track === undefined);

/** …and the ones the box actually DRAWS, which is what must appear as nodes. */
const drawnUntracked = (members: QueueFixture[]): QueueFixture[] =>
  untrackedOf(drawnMembers(members));

/** The row `nextCr` names: the first actionable member among the DRAWN rows,
 *  in the published order (`focusedReleaseView`). A fixture with no actionable
 *  member cannot state a marker, so it fails loudly rather than asserting an
 *  empty marker set is correct. */
function firstActionable(members: QueueFixture[]): QueueFixture {
  const first = drawnMembers(members).find((entry) => entry.status === "PENDING");
  if (first === undefined) {
    throw new Error("fixture declares no actionable drawn member — it cannot name a next row");
  }
  return first;
}

/** The wave BODY — the one element CR-078/CR-096 draw the rows and the
 *  `+N more` into. Read off the pointer, exactly as the AC6 test above reads
 *  it, rather than by class name. */
function waveBodyEl(wave: string): HTMLElement {
  const pointer = moreEl(wave);
  if (pointer === null) {
    throw new Error(`wave ${wave} renders no \`+N more\` to anchor its body on`);
  }
  const body = pointer.parentElement;
  if (body === null) throw new Error(`wave ${wave}'s \`+N more\` has no parent element`);
  return body;
}

/** The nodes drawn as DIRECT children of the wave body — i.e. outside the lane
 *  grid — in document order. */
const bodyNodeCrs = (wave: string): string[] =>
  Array.from(waveBodyEl(wave).children)
    .filter((child) => child.getAttribute("data-testid") === "roadmap-node")
    .map((child) => child.getAttribute("data-cr") ?? "");

/** The `next` marker, read the way the sibling suites read it
 *  (`.app-flow-node-next`, tests/roadmap-visual-grammar.test.ts:3688). */
const markedCrs = (wave: string): string[] =>
  nodeEls(wave)
    .filter((node) => node.querySelector(".app-flow-node-next") !== null)
    .map((node) => node.getAttribute("data-cr") ?? "");

describe("CR-CRU-085 AC9/§S3 — in a laned wave, a member declaring NO track is the implicit solo lane: drawn in the body, outside the grid, with no chrome", () => {
  test("a mixed wave draws a node for EVERY member it draws, the untracked ones included, and draws none of them twice", async () => {
    await mountApp({ queue: queueOf(MIXED) });

    // The fixture really is the mixed case: more than one DECLARED track (so
    // the wave is laned at all) and members declaring none (so the implicit
    // lane has something in it).
    expect(fixtureTracks(MIXED).length).toBeGreaterThan(1);
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(MIXED));
    expect(drawnUntracked(MIXED).map((entry) => entry.cr)).toEqual(["CR-X-02", "CR-X-04"]);

    // The drawn set BY ID — never a bare count, which a node drawn twice would
    // satisfy exactly as well as a node drawn nowhere would break.
    const drawn = drawnMembers(MIXED).map((entry) => entry.cr);
    expect(nodeCrs(WAVE).slice().sort()).toEqual(drawn.slice().sort());
    expect(nodeCrs(WAVE).length).toBe(drawn.length);
    for (const entry of drawnUntracked(MIXED)) {
      expect(nodeCrs(WAVE)).toContain(entry.cr);
    }
  });

  test("the untracked member's node carries NO lane chrome: it is inside no lane, no label names it, and no extra lane pair is minted for it", async () => {
    await mountApp({ queue: queueOf(MIXED) });

    const tracks = fixtureTracks(MIXED);
    const grid = lanesElOrThrow(WAVE);

    for (const entry of drawnUntracked(MIXED)) {
      const node = nodeEl(WAVE, entry.cr);
      expect(lanesContaining(WAVE, node)).toEqual([]);
      expect(grid.contains(node)).toBe(false);
    }

    // The grid is still the DECLARED tracks' own `label cell · row` pairs, in
    // first-appearance order — no lane, no label and no divider was added for
    // the members that declare nothing.
    expect(laneTracks(WAVE)).toEqual(tracks);
    expect(laneLabelTracks(WAVE)).toEqual(tracks);
    expect(laneLabelTexts(WAVE)).toEqual(tracks);
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(MIXED));
    expect(laneLabelEls(WAVE).length).toBe(expectedLaneCount(MIXED));
    expect(Array.from(grid.children).map((child) => child.getAttribute("data-testid"))).toEqual(
      tracks.flatMap(() => ["roadmap-wave-lane-label", "roadmap-wave-lane"]),
    );

    // …and no lane vocabulary was minted for the ABSENCE of a track: nothing in
    // the box carries an empty `data-track`, and no label states one of the
    // untracked members.
    expect(waveEl(WAVE).querySelectorAll('[data-track=""]').length).toBe(0);
    for (const entry of untrackedOf(MIXED)) {
      expect(laneLabelTexts(WAVE)).not.toContain(entry.cr);
    }
  });

  test("laning partitions the DECLARED-track members only: each of their nodes is inside exactly ONE lane, and each untracked node is inside NONE", async () => {
    await mountApp({ queue: queueOf(MIXED) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(MIXED));

    for (const entry of drawnMembers(MIXED)) {
      const holders = lanesContaining(WAVE, nodeEl(WAVE, entry.cr)).map((lane) =>
        lane.getAttribute("data-track"),
      );
      expect({ cr: entry.cr, holders }).toEqual({
        cr: entry.cr,
        holders: entry.track === undefined ? [] : [declaredTrackOf(entry)],
      });
    }

    // Each lane still holds exactly its own track's drawn rows, in the
    // published order — no untracked member leaked into one.
    const drawn = new Set(drawnMembers(MIXED).map((entry) => entry.cr));
    for (const track of fixtureTracks(MIXED)) {
      expect(laneNodeCrs(WAVE, track)).toEqual(
        MIXED.filter((entry) => entry.track === track && drawn.has(entry.cr)).map(
          (entry) => entry.cr,
        ),
      );
    }
  });

  test("the untracked node sits in the wave body in the published order, byte-identical to the same fixture with its track data stripped", async () => {
    await mountApp({ queue: queueOf(MIXED_UNTRACKED) });

    // CR-078's arrangement for this membership, MEASURED rather than assumed —
    // the render the laned box must reproduce for these members.
    expect(lanesEl(WAVE)).toBeNull();
    expect(bodyNodeCrs(WAVE)).toEqual(drawnMembers(MIXED_UNTRACKED).map((entry) => entry.cr));
    const unlanedHtml = new Map(
      drawnUntracked(MIXED).map((entry) => [entry.cr, nodeEl(WAVE, entry.cr).outerHTML]),
    );

    await mountApp({ queue: queueOf(MIXED) });
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(MIXED));

    // The body's own node children are EXACTLY the untracked members, in the
    // box's published order; the lane grid holds every other drawn row.
    expect(bodyNodeCrs(WAVE)).toEqual(drawnUntracked(MIXED).map((entry) => entry.cr));

    const body = waveBodyEl(WAVE);
    expect(lanesElOrThrow(WAVE).parentElement).toBe(body);
    for (const entry of drawnUntracked(MIXED)) {
      const node = nodeEl(WAVE, entry.cr);
      expect(node.parentElement).toBe(body);
      // Byte-identical: the same element, drawn the same way, as the render
      // that never saw a track.
      const unlaned = unlanedHtml.get(entry.cr);
      if (unlaned === undefined) {
        throw new Error(`the un-laned render drew no node for ${entry.cr} to compare against`);
      }
      expect(node.outerHTML).toBe(unlaned);
    }

    // …and the `+N more` pointer is still the body's LAST child, where CR-078
    // leaves it.
    const children = Array.from(body.children);
    expect(children[children.length - 1]?.getAttribute("data-testid")).toBe("roadmap-wave-more");
  });

  test("the wave's node total, its `+N more` and its whole-membership count are the un-laned render's, mixed track data or not", async () => {
    await mountApp({ queue: queueOf(MIXED_UNTRACKED) });

    const baseline = {
      nodes: nodeCrs(WAVE).slice().sort(),
      total: nodeCrs(WAVE).length,
      more: moreText(WAVE),
      count: countText(WAVE),
    };
    expect(baseline.total).toBe(drawnMembers(MIXED).length);
    expect(baseline.more).toBe(`+${hiddenCount(MIXED)} more — see the table below`);
    expect(baseline.count).toBe(String(MIXED.length));
    expect(laneEls(WAVE)).toEqual([]);

    await mountApp({ queue: queueOf(MIXED) });

    // Lanes really are drawn here — so what follows is the LANED box's answer,
    // not the un-laned one measured twice.
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(MIXED));
    expect(nodeCrs(WAVE).length).toBe(baseline.total);
    expect(nodeCrs(WAVE).slice().sort()).toEqual(baseline.nodes);
    expect(moreText(WAVE)).toBe(baseline.more);
    expect(waveEl(WAVE).querySelectorAll('[data-testid="roadmap-wave-more"]').length).toBe(1);
    expect(countText(WAVE)).toBe(baseline.count);
    expect(waveEl(WAVE).getAttribute("data-cr-count")).toBe(String(MIXED.length));
  });

  test("the header states the count of DECLARED tracks — the same k as the fixture with its untracked members deleted — and the table's `track` column is unaffected", async () => {
    await mountApp({ queue: queueOf(MIXED_DECLARED_ONLY) });

    const declaredOnly = {
      k: headerTrackCount(WAVE),
      lanes: laneEls(WAVE).length,
      tracks: laneTracks(WAVE),
      column: tableHasTrackColumn(),
    };
    expect(declaredOnly.k).toBe(fixtureTracks(MIXED_DECLARED_ONLY).length);
    expect(declaredOnly.column).toBe(true);

    await mountApp({ queue: queueOf(MIXED) });

    // AC9's premise, asserted before the header is read: this box DRAWS every
    // member it counts. A header stating k while one of its members is drawn
    // nowhere is not the implicit solo lane — it is the defect AC9 names.
    expect(nodeCrs(WAVE).slice().sort()).toEqual(
      drawnMembers(MIXED)
        .map((entry) => entry.cr)
        .sort(),
    );

    // The implicit lane is NOT a track: adding untracked members changes
    // neither the stated count, nor the lanes, nor the table's column.
    expect(headerTrackCount(WAVE)).toBe(declaredOnly.k);
    expect(laneEls(WAVE).length).toBe(declaredOnly.lanes);
    expect(laneTracks(WAVE)).toEqual(declaredOnly.tracks);
    expect(tableHasTrackColumn()).toBe(declaredOnly.column);
    expect(headerText(WAVE)).toContain(`· ${fixtureTracks(MIXED).length} tracks`);
  });

  test("a `nextCr` naming an untracked member still marks that node, and marks only it", async () => {
    await mountApp({ queue: queueOf(NEXT_UNTRACKED) });

    // The fixture's premise: the wave IS laned, and the row the view names
    // next — the first actionable drawn member — declares no track.
    expect(laneEls(WAVE).length).toBe(expectedLaneCount(NEXT_UNTRACKED));
    const next = firstActionable(NEXT_UNTRACKED);
    expect(next.track).toBeUndefined();

    // The marker survives the implicit lane: one marked row in the box, and it
    // is that member's node — drawn outside every lane, marked all the same.
    expect(markedCrs(WAVE)).toEqual([next.cr]);
    expect(norm(nodeEl(WAVE, next.cr).querySelector(".app-flow-node-next")?.textContent)).toBe(
      "next",
    );
    expect(lanesContaining(WAVE, nodeEl(WAVE, next.cr))).toEqual([]);
  });
});
