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
 *  production deriving it wrongly. */
const declaredTracks = (members: QueueFixture[]): string[] => {
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
  const tracks = declaredTracks(members);
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
 *  the same reason the sibling suite reads `· active` that way. */
const headerTrackCount = (wave: string): number | null => {
  const match = /·\s*(\d+)\s+tracks?\b/.exec(headerText(wave));
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

    const tracks = declaredTracks(TWO_TRACKS);
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

    const tracks = declaredTracks(THREE_TRACKS);
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
    expect(declaredTracks(ONE_TRACK)).toEqual(["track-1"]);
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

    expect(declaredTracks(NO_TRACKS)).toEqual([]);
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
    expect(fixtures.map((f) => declaredTracks(f.members).length)).toEqual([0, 1, 2, 3]);

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

    const tracks = declaredTracks(CAPPED);
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
    for (const track of declaredTracks(CAPPED)) {
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
});

// ── AC8 — the laned header's third segment, in words ───────────────────────

describe("CR-CRU-085 AC8 — a laned wave's header states its track count in WORDS, as the design's third segment", () => {
  test("the header reads `Wave <n> · active · <k> tracks`, and the k it states is the number of lanes drawn for that same fixture", async () => {
    await mountApp({ queue: queueOf(TWO_TRACKS) });
    expect(headerText(WAVE)).toContain(`wave ${WAVE} · active · ${declaredTracks(TWO_TRACKS).length} tracks`);
    expect(headerTrackCount(WAVE)).toBe(laneEls(WAVE).length);

    // The same header on a three-track fixture states three — one derivation,
    // read off the data, never a second one that could disagree with the
    // lanes it labels.
    await mountApp({ queue: queueOf(THREE_TRACKS) });
    expect(headerText(WAVE)).toContain(`wave ${WAVE} · active · ${declaredTracks(THREE_TRACKS).length} tracks`);
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
    expect(headerTrackCount(WAVE)).toBe(declaredTracks(TWO_TRACKS).length);
  });
});

// ── §S2's row-cap ruling — the lane count is the WHOLE membership's ─────────

describe("CR-CRU-085 §S2 — the lane count comes from the wave's WHOLE membership, not from the rows it draws", () => {
  test("a track whose every member is merged or beyond the row cap still draws its lane, with its label and no rows", async () => {
    await mountApp({ queue: queueOf(CAPPED) });

    const tracks = declaredTracks(CAPPED);
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
