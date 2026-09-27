// CR-CRU-147 §S1 AC3 (cycle 525, C3) — the Wave Card drops a dead CR
// EVERYWHERE, and the browser mirror is held to the server rule.
//
// Spec: docs/changes/CR-CRU-147-a-voided-cr-is-not-queued-work.md
//       §S1 AC3 ("The zone-2 Wave Card does not render a dead CR anywhere
//       (ruling 2). Not in a waved box's rows, not in the loose (unwaved)
//       group. The wave header's count (`roadmap-wave-count`, `data-cr-count`)
//       excludes it, and so do `hiddenCount` (`+N more`) and the merged
//       roll-up. Asserted on a wave holding one dead member of each state
//       beside live ones.").
//       Gap-analysis box, Ruling 2: "A waved box's rows already exclude
//       them. Its header count (`box.entries.length`, CR-096's whole
//       membership) and the loose (unwaved) group still include them, and
//       both drop them. A count that includes rows the card never draws
//       would disagree with the 2026-09-23 ruling that the card does not
//       list a dead CR."
//
// SCOPE — PENDING-status dead members only (VOID and SUPERSEDED, the two
// states `isDeadCr` recognises), exactly as the dispatch's own fixture
// describes it. An IN_PROGRESS member that ALSO carries a disposition is
// CR-CRU-096 AC9c's own carve-out ("IN_PROGRESS ∈ the row union whatever the
// `lifecycle`"), pinned in tests/roadmap-wave-rows.test.ts,
// tests/roadmap-release-focus.test.ts and tests/roadmap-visual-grammar.test.ts;
// whether ruling 2 also retires THAT carve-out is not stated by this CR's own
// gap-analysis box the way rulings 1-3 are, so it is out of scope here and is
// flagged separately rather than guessed.
//
// BOUNDARY — `focusedReleaseView(...).members` also feeds the zone-3 roadmap
// TABLE (`RoadmapTableZone` in public/app.js), where a dead row must STAY
// visible (§S2). So
// nothing here requires a dead CR to be gone from `view.members` — one test
// below asserts the opposite, that `view.members` still names every one of
// them.
//
// Two harnesses, both following house pattern for this suite family
// (tests/roadmap-wave-header.test.ts, tests/roadmap-wave-rows.test.ts,
// tests/roadmap-wave-rollup.test.ts, tests/wave-loose-box-truthful.test.ts):
//   • a PURE section, calling `focusedReleaseView` directly (no DOM), for
//     exact array-level assertions on `entries`/`rows`/`soloRows`/`lanes`/
//     `hiddenCount`/`mergedCount`/`members` — the view's own PUBLISHED
//     surface (`public/app-logic.d.mts`);
//   • a RENDERED-DOM section, the real `public/app.js` shell driving its own
//     fetch chain and van.js's real reactive scheduler inside happy-dom, for
//     the header count text, the `+N more` pointer, the roll-up line and the
//     loose group's rendered nodes.
//
// RED phase — expected to FAIL against current production, which:
//   • renders both `data-cr-count` and the `roadmap-wave-count` header text
//     from `box.entries.length` (`RoadmapFlowWave` in public/app.js) with no
//     dead-CR
//     filter at all, so a wave carrying two dead PENDING members reads its
//     RAW membership count, dead CRs included;
//   • computes `box.mergedCount` as `box.entries.filter(roadmapMerged)`
//     (`focusedReleaseView` in public/app-logic.mjs) filtering on `status`
//     alone, so a dead CR
//     whose derived `status` is `COMPLETED`/`COMPLETED_UNTRACKED` is counted
//     in the roll-up;
//   • draws the `wave: null` loose group as `box.rows.map(RoadmapFlowNode)`
//     where `box.rows = box.entries.slice()` (`focusedReleaseView` in
//     public/app-logic.mjs)
//     with no filter at all, so a dead loose member is drawn as a node.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";
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

// ── Fixture types (the wire shapes, as tests/roadmap-wave-rollup.test.ts and
//    tests/wave-loose-box-truthful.test.ts declare them) ────────────────────

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

/** `src/types.ts` (`QueueEntry.lifecycle`) — the disposition axis, exactly as
 *  the wire publishes it. */
interface LifecycleFixture {
  state: "SUPERSEDED" | "VOID";
  by?: string;
  reason?: string;
  at: number;
}

interface PackageFixture {
  registry: string;
  name: string;
  version: string;
}

interface ReleaseFixture {
  version: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  packages?: PackageFixture[];
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
  status: QueueStatus;
  seq?: number;
  release?: string;
  track?: string;
  lifecycle?: LifecycleFixture;
}

// ── The one board this whole file reuses: wave "1" (dead members beside live
//    ones, big enough that the trim engages) and the loose (`wave: ""`)
//    group (a live member beside a dead one) ───────────────────────────────
//
// AC29 (CR-CRU-096 convention, carried by every sibling suite in this
// family) — every fixture id is synthetic (`CR-W-*`, `CR-M-*`, `CR-VOID-*`,
// `CR-SUP-*`, `CR-L-*`), so no assertion here depends on the shape of this
// project's own backlog.

const RELEASE = "0.4.0";

const entry = (
  cr: string,
  status: QueueStatus,
  seq: number,
  extra: Partial<QueueFixture> = {},
): QueueFixture => ({
  cr,
  title: `${cr} — synthetic member`,
  wave: "1",
  dependsOn: [],
  status,
  seq,
  release: RELEASE,
  ...extra,
});

/** Eight LIVE PENDING members, split evenly across two tracks so the box also
 *  publishes lanes (CR-CRU-085 §S2) — the surface AC3's "not in … lanes"
 *  clause names. Eight actionable, five scheduled (`ROADMAP_WAVE_ROWS` in
 *  public/app-logic.mjs), three hidden. */
const WAVE_ONE_LIVE_PENDING: QueueFixture[] = [
  entry("CR-W-1", "PENDING", 10, { track: "alpha" }),
  entry("CR-W-2", "PENDING", 20, { track: "beta" }),
  entry("CR-W-3", "PENDING", 30, { track: "alpha" }),
  entry("CR-W-4", "PENDING", 40, { track: "beta" }),
  entry("CR-W-5", "PENDING", 50, { track: "alpha" }),
  entry("CR-W-6", "PENDING", 60, { track: "beta" }),
  entry("CR-W-7", "PENDING", 70, { track: "alpha" }),
  entry("CR-W-8", "PENDING", 80, { track: "beta" }),
];
const WAVE_ONE_LIVE_ROWS = ["CR-W-1", "CR-W-2", "CR-W-3", "CR-W-4", "CR-W-5"];

/** Three LIVE merged members — the roll-up's own count, before any dead one
 *  is added beside it. */
const WAVE_ONE_MERGED: QueueFixture[] = [
  entry("CR-M-1", "COMPLETED", 90, { track: "alpha" }),
  entry("CR-M-2", "COMPLETED", 100, { track: "alpha" }),
  entry("CR-M-3", "COMPLETED_UNTRACKED", 110, { track: "alpha" }),
];

/** The three dead members the AC's own fixture calls for: one VOID and one
 *  SUPERSEDED (carrying `by`) beside the live PENDING members, plus a VOID
 *  member whose DERIVED status is COMPLETED — the case that makes the
 *  merged roll-up's exclusion non-vacuous, since `roadmapMerged`
 *  (public/app-logic.mjs) reads `status` alone and does not know about
 *  `lifecycle` at all. */
const WAVE_ONE_DEAD: QueueFixture[] = [
  entry("CR-VOID-1", "PENDING", 120, {
    track: "alpha",
    lifecycle: { state: "VOID", reason: "duplicate of CR-W-1", at: 1_700_000_000_000 },
  }),
  entry("CR-SUP-1", "PENDING", 130, {
    track: "beta",
    lifecycle: { state: "SUPERSEDED", by: "CR-SUCCESSOR-1", at: 1_700_000_000_000 },
  }),
  entry("CR-VOID-MERGED", "COMPLETED", 140, {
    track: "alpha",
    lifecycle: { state: "VOID", reason: "voided after it had already shipped", at: 1_700_000_000_000 },
  }),
];
const WAVE_ONE_DEAD_IDS = ["CR-VOID-1", "CR-SUP-1", "CR-VOID-MERGED"];

const WAVE_ONE: QueueFixture[] = [...WAVE_ONE_LIVE_PENDING, ...WAVE_ONE_MERGED, ...WAVE_ONE_DEAD];
const WAVE_ONE_LIVE_COUNT = WAVE_ONE_LIVE_PENDING.length + WAVE_ONE_MERGED.length; // 11
const WAVE_ONE_MERGED_COUNT = WAVE_ONE_MERGED.length; // 3
const WAVE_ONE_HIDDEN_COUNT = WAVE_ONE_LIVE_PENDING.length - WAVE_ONE_LIVE_ROWS.length; // 3

/** The loose (`wave: ""`) group: one live member, one dead one. `wave: ""` is
 *  the wire's own way of declaring none (the `wave` field of `QueueEntry` in
 *  `src/types.ts`); `declaredLabel` (public/app-logic.mjs) reads it as the
 *  `null` group. */
const LOOSE_LIVE: QueueFixture = { ...entry("CR-L-1", "PENDING", 200), wave: "" };
const LOOSE_DEAD: QueueFixture = {
  ...entry("CR-L-VOID", "PENDING", 210, {
    lifecycle: { state: "VOID", reason: "parked before it was ever taken up", at: 1_700_000_000_000 },
  }),
  wave: "",
};
const LOOSE_GROUP: QueueFixture[] = [LOOSE_LIVE, LOOSE_DEAD];

const ALL_ENTRIES: QueueFixture[] = [...WAVE_ONE, ...LOOSE_GROUP];

// ── Ruling 4 (2026-09-25, at C3) — a RUNNING dead CR stays on the Wave Card
//    (a NEW user ruling, added to the gap-analysis box and \u00a7S1 AC3 after this
//    file's own RED pass) ───────────────────────────────────────────────────
//
// "Except a running member (ruling 4): an `IN_PROGRESS` member stays drawn,
// and counted in its wave's header, whatever its lifecycle (CR-CRU-096
// AC9c), because `next` holds its lane as in-flight. It drops like any dead
// CR once it is no longer running." (\u00a7S1 AC3's own carve-out; gap-analysis
// box, ruling 4.)
//
// A SEPARATE board from WAVE_ONE/LOOSE_GROUP above, deliberately: this
// ruling needs an IN_PROGRESS member for EACH dead state, and WAVE_ONE_DEAD /
// LOOSE_DEAD are all PENDING on purpose (the regression guard test below
// checks that fact holds), so reusing them would perturb every ruling-2
// count the tests above already pin.

const RULING4_WAVE = "ruling4";

const ruling4Entry = (
  cr: string,
  status: QueueStatus,
  seq: number,
  extra: Partial<QueueFixture> = {},
): QueueFixture => ({
  cr,
  title: `${cr} — ruling 4 fixture`,
  wave: RULING4_WAVE,
  dependsOn: [],
  status,
  seq,
  release: RELEASE,
  ...extra,
});

/** Two live PENDING members, so the box is not vacuous. */
const RULING4_LIVE: QueueFixture[] = [
  ruling4Entry("CR-R-1", "PENDING", 500),
  ruling4Entry("CR-R-2", "PENDING", 510),
];

/** The NON-running dead member — PENDING with a VOID lifecycle. Ruling 2's
 *  own case: it must still drop from rows, `entries.length` and
 *  `hiddenCount` alike, exactly as WAVE_ONE_DEAD does above. */
const RULING4_NON_RUNNING_VOID: QueueFixture = ruling4Entry("CR-R-VOID", "PENDING", 520, {
  lifecycle: { state: "VOID", reason: "abandoned before it was ever taken up", at: 1_700_000_000_000 },
});

/** The two RUNNING dead members ruling 4 names by name — IN_PROGRESS with a
 *  VOID lifecycle, and IN_PROGRESS with a SUPERSEDED one (carrying `by`, as
 *  every SUPERSEDED fixture in this file does). Both must stay drawn AND
 *  counted, unlike CR-R-VOID above. */
const RULING4_RUNNING_VOID: QueueFixture = ruling4Entry("CR-R-RUN-VOID", "IN_PROGRESS", 530, {
  lifecycle: { state: "VOID", reason: "voided after the plan was already opened", at: 1_700_000_000_000 },
});
const RULING4_RUNNING_SUPERSEDED: QueueFixture = ruling4Entry("CR-R-RUN-SUP", "IN_PROGRESS", 540, {
  lifecycle: { state: "SUPERSEDED", by: "CR-R-SUCCESSOR", at: 1_700_000_000_000 },
});

const RULING4_WAVE_ENTRIES: QueueFixture[] = [
  ...RULING4_LIVE,
  RULING4_NON_RUNNING_VOID,
  RULING4_RUNNING_VOID,
  RULING4_RUNNING_SUPERSEDED,
];
const RULING4_RUNNING_IDS = ["CR-R-RUN-VOID", "CR-R-RUN-SUP"];
// Live PENDING (2) + the two RUNNING dead members; the non-running VOID one
// is the ONE member this board expects excluded from the header count.
const RULING4_EXPECTED_COUNT = RULING4_LIVE.length + RULING4_RUNNING_IDS.length; // 4

/** The loose (`wave: ""`) half of ruling 4's own board: one running dead
 *  member (drawn) beside one non-running dead member (not drawn) — the same
 *  contrast \u00a7S1 AC3's carve-out draws for a waved box, read onto the
 *  wave-less group. */
const RULING4_LOOSE_RUNNING: QueueFixture = {
  ...ruling4Entry("CR-R-LOOSE-RUN", "IN_PROGRESS", 550, {
    lifecycle: { state: "VOID", reason: "voided mid-flight, loose group", at: 1_700_000_000_000 },
  }),
  wave: "",
};
const RULING4_LOOSE_NON_RUNNING: QueueFixture = {
  ...ruling4Entry("CR-R-LOOSE-VOID", "PENDING", 560, {
    lifecycle: { state: "VOID", reason: "parked, never taken up, loose group", at: 1_700_000_000_000 },
  }),
  wave: "",
};
const RULING4_LOOSE_ENTRIES: QueueFixture[] = [RULING4_LOOSE_RUNNING, RULING4_LOOSE_NON_RUNNING];

const RULING4_ALL_ENTRIES: QueueFixture[] = [...RULING4_WAVE_ENTRIES, ...RULING4_LOOSE_ENTRIES];

// ── Ruling 5 (2026-09-25, at C3) — a wave with NO live work draws NO box ────
//
// "When every member of a wave is dead and none is running, the Wave Card
// draws no box for that wave (no header, no `0` count). Its CRs stay
// visible, struck through, in the zone-3 table." (gap-analysis box, ruling
// 5; §S1 AC3's own "A wave with no live work draws no box" clause.)
//
// Two SEPARATE waves, on their own board, deliberately: ruling 5 needs (a) a
// wave whose every member is dead and none running (no box at all, not an
// empty one), and (b) a wave holding exactly one RUNNING dead member and
// nothing else, so the empty-box rule must not also swallow the one ruling 4
// still requires drawn. Reusing WAVE_ONE or RULING4_WAVE would perturb every
// count those boards already pin.

const RULING5_ALL_DEAD_WAVE = "ruling5-all-dead";
const RULING5_RUNNING_ONLY_WAVE = "ruling5-running-only";

const ruling5Entry = (
  cr: string,
  wave: string,
  status: QueueStatus,
  seq: number,
  extra: Partial<QueueFixture> = {},
): QueueFixture => ({
  cr,
  title: `${cr} — ruling 5 fixture`,
  wave,
  dependsOn: [],
  status,
  seq,
  release: RELEASE,
  ...extra,
});

/** Every member of this wave is dead and NONE is running — one VOID, one
 *  SUPERSEDED, both PENDING. Ruling 5's own case: the wave must draw no box
 *  at all, not an empty one. */
const RULING5_ALL_DEAD_ENTRIES: QueueFixture[] = [
  ruling5Entry("CR-R5-VOID", RULING5_ALL_DEAD_WAVE, "PENDING", 600, {
    lifecycle: { state: "VOID", reason: "the whole wave was abandoned", at: 1_700_000_000_000 },
  }),
  ruling5Entry("CR-R5-SUP", RULING5_ALL_DEAD_WAVE, "PENDING", 610, {
    lifecycle: { state: "SUPERSEDED", by: "CR-R5-SUCCESSOR", at: 1_700_000_000_000 },
  }),
];
const RULING5_ALL_DEAD_IDS = ["CR-R5-VOID", "CR-R5-SUP"];

/** A wave with exactly ONE member — running and dead. Ruling 4 beats ruling
 *  5: it still draws its box, alone, even with no live member beside it. */
const RULING5_RUNNING_ONLY_ENTRIES: QueueFixture[] = [
  ruling5Entry("CR-R5-RUN", RULING5_RUNNING_ONLY_WAVE, "IN_PROGRESS", 620, {
    lifecycle: { state: "VOID", reason: "voided after the plan was already opened", at: 1_700_000_000_000 },
  }),
];

const RULING5_ALL_ENTRIES: QueueFixture[] = [
  ...RULING5_ALL_DEAD_ENTRIES,
  ...RULING5_RUNNING_ONLY_ENTRIES,
];

// ═════════════════════════════════════════════════════════════════════════
// PURE SECTION — `focusedReleaseView` called directly, no DOM.
// ═════════════════════════════════════════════════════════════════════════

interface WaveBoxLike {
  wave: string | null;
  entries: QueueFixture[];
  rows: QueueFixture[];
  hiddenCount: number;
  mergedCount: number;
  lanes: { track: string; rows: QueueFixture[] }[];
  soloRows: QueueFixture[];
}

interface StripGateLike {
  version: string;
  kind: "shipped" | "proposed";
  date: string;
  dateState: "dated" | "absent" | "unusable";
}

// The ambient tests/app-logic.d.ts predates this file's exports, so the
// module is cast to the boundary under test ONCE — the same technique
// tests/wave-loose-box-truthful.test.ts already uses.
const Logic = AppLogic as unknown as {
  focusedReleaseView: (
    gate: StripGateLike,
    releases: unknown[],
    entries: QueueFixture[],
  ) => { waves: WaveBoxLike[]; members: QueueFixture[] };
};

const PROPOSED: StripGateLike = {
  version: RELEASE,
  kind: "proposed",
  date: "",
  dateState: "absent",
};

function viewOfAll(): { waves: WaveBoxLike[]; members: QueueFixture[] } {
  return Logic.focusedReleaseView(PROPOSED, [], ALL_ENTRIES);
}

function waveBox(wave: string | null): WaveBoxLike {
  const box = viewOfAll().waves.find((candidate) => candidate.wave === wave);
  if (box === undefined) throw new Error(`fixture bug: no wave box for ${String(wave)}`);
  return box;
}

const ids = (rows: QueueFixture[]): string[] => rows.map((row) => row.cr);

describe("focusedReleaseView drops dead CRs from the Wave Card (CR-CRU-147 §S1 AC3, pure view)", () => {
  test("the waved box's whole-membership count (`entries.length`) excludes VOID/SUPERSEDED members", () => {
    const box = waveBox("1");
    expect(
      box.entries.length,
      `expected ${WAVE_ONE_LIVE_COUNT} live entries (${WAVE_ONE.length} total minus the ` +
        `${WAVE_ONE_DEAD_IDS.length} dead ones), got ${box.entries.length}: ` +
        `${JSON.stringify(ids(box.entries))}`,
    ).toBe(WAVE_ONE_LIVE_COUNT);
    for (const dead of WAVE_ONE_DEAD_IDS) {
      expect(ids(box.entries)).not.toContain(dead);
    }
  });

  test("the waved box's merged roll-up excludes a dead CR even when its derived status is COMPLETED", () => {
    const box = waveBox("1");
    expect(
      box.mergedCount,
      `expected mergedCount ${WAVE_ONE_MERGED_COUNT} (the three live COMPLETED/COMPLETED_UNTRACKED ` +
        `members) — got ${box.mergedCount}, which counts CR-VOID-MERGED if it is 4`,
    ).toBe(WAVE_ONE_MERGED_COUNT);
  });

  test("the waved box's hidden remainder (`+N more`) counts only live actionable members", () => {
    const box = waveBox("1");
    expect(box.hiddenCount).toBe(WAVE_ONE_HIDDEN_COUNT);
  });

  test("the waved box's rows, soloRows and lanes never draw a VOID or SUPERSEDED member", () => {
    const box = waveBox("1");
    const rowIds = ids(box.rows);
    const soloIds = ids(box.soloRows);
    const laneIds = box.lanes.flatMap((lane) => ids(lane.rows));
    for (const dead of WAVE_ONE_DEAD_IDS) {
      expect(rowIds, `box.rows must not draw ${dead}`).not.toContain(dead);
      expect(soloIds, `box.soloRows must not draw ${dead}`).not.toContain(dead);
      expect(laneIds, `no lane may draw ${dead}`).not.toContain(dead);
    }
    // The positive half: the five live PENDING members the trim schedules,
    // in the published order — never a smaller or reshuffled set.
    expect(rowIds).toEqual(WAVE_ONE_LIVE_ROWS);
    // Two lanes (alpha/beta), since the live rows declare both tracks.
    expect(box.lanes.map((lane) => lane.track).sort()).toEqual(["alpha", "beta"]);
    expect(soloIds).toEqual([]);
  });

  test("the loose (`wave: null`) group draws no dead CR — its live member only", () => {
    const loose = waveBox(null);
    expect(
      ids(loose.rows),
      `the loose group's rows must be exactly ["CR-L-1"] — CR-L-VOID is dead and must not draw`,
    ).toEqual(["CR-L-1"]);
    expect(ids(loose.entries)).not.toContain("CR-L-VOID");
    expect(loose.hiddenCount).toBe(0);
  });

  test("boundary — `view.members` still names every dead CR (zone-3's table needs them, §S2)", () => {
    const view = viewOfAll();
    const memberIds = ids(view.members);
    for (const dead of [...WAVE_ONE_DEAD_IDS, "CR-L-VOID"]) {
      expect(memberIds, `view.members must still contain ${dead} for zone 3's table`).toContain(dead);
    }
  });
});

function ruling4View(): { waves: WaveBoxLike[]; members: QueueFixture[] } {
  return Logic.focusedReleaseView(PROPOSED, [], RULING4_ALL_ENTRIES);
}

function ruling4Box(wave: string | null): WaveBoxLike {
  const box = ruling4View().waves.find((candidate) => candidate.wave === wave);
  if (box === undefined) throw new Error(`ruling-4 fixture bug: no wave box for ${String(wave)}`);
  return box;
}

describe("ruling 4 — a RUNNING dead CR stays drawn and counted; a non-running one still drops (CR-CRU-147 §S1 AC3's carve-out, pure view)", () => {
  test("both running dead members (VOID and SUPERSEDED-by) are drawn as rows", () => {
    const box = ruling4Box(RULING4_WAVE);
    const rowIds = ids(box.rows);
    const soloIds = ids(box.soloRows);
    const laneIds = box.lanes.flatMap((lane) => ids(lane.rows));
    const drawnAnywhere = new Set([...rowIds, ...soloIds, ...laneIds]);
    for (const running of RULING4_RUNNING_IDS) {
      expect(
        drawnAnywhere.has(running),
        `${running} is IN_PROGRESS with a lifecycle — ruling 4 keeps it drawn ` +
          `(rows: ${JSON.stringify(rowIds)}, soloRows: ${JSON.stringify(soloIds)}, lanes: ${JSON.stringify(laneIds)})`,
      ).toBe(true);
    }
  });

  test("the header count (`entries.length`) counts both running dead members and excludes the PENDING VOID one", () => {
    const box = ruling4Box(RULING4_WAVE);
    expect(
      box.entries.length,
      `expected ${RULING4_EXPECTED_COUNT} (2 live PENDING + 2 running dead), got ` +
        `${box.entries.length}: ${JSON.stringify(ids(box.entries))}`,
    ).toBe(RULING4_EXPECTED_COUNT);
    for (const running of RULING4_RUNNING_IDS) {
      expect(ids(box.entries), `entries must still count ${running} — it is running`).toContain(running);
    }
    expect(
      ids(box.entries),
      "CR-R-VOID is PENDING with a VOID lifecycle (not running) — ruling 2 drops it",
    ).not.toContain("CR-R-VOID");
  });

  test("the loose group draws and counts a running dead member, but drops a non-running one", () => {
    const loose = ruling4Box(null);
    expect(
      ids(loose.rows),
      "CR-R-LOOSE-RUN is IN_PROGRESS — ruling 4 keeps it drawn in the loose group too",
    ).toContain("CR-R-LOOSE-RUN");
    expect(
      ids(loose.rows),
      "CR-R-LOOSE-VOID is PENDING and non-running — it must not be drawn",
    ).not.toContain("CR-R-LOOSE-VOID");
    expect(
      ids(loose.entries),
      "CR-R-LOOSE-RUN must still be counted in the loose group's own membership",
    ).toContain("CR-R-LOOSE-RUN");
    expect(ids(loose.entries)).not.toContain("CR-R-LOOSE-VOID");
  });

  test("regression guard — none of this file's OTHER dead fixtures is itself running (so ruling 4 never silently overlaps ruling 2's own pins)", () => {
    const otherDead = [...WAVE_ONE_DEAD, LOOSE_DEAD];
    for (const dead of otherDead) {
      expect(
        dead.status,
        `${dead.cr} is used by this file's ruling-2 pins as a dead member; ` +
          `if it were IN_PROGRESS, ruling 4 would keep it drawn and those pins ` +
          `would be asserting the wrong thing`,
      ).not.toBe("IN_PROGRESS");
    }
  });
});

function ruling5View(): { waves: WaveBoxLike[]; members: QueueFixture[] } {
  return Logic.focusedReleaseView(PROPOSED, [], RULING5_ALL_ENTRIES);
}

describe("ruling 5 — a wave with no live work draws no box; ruling 4 still draws one for a running-only wave (pure view)", () => {
  test("a wave whose every member is dead and none running has NO box in view.waves", () => {
    const view = ruling5View();
    const waveLabels = view.waves.map((box) => box.wave);
    expect(
      waveLabels,
      `view.waves must not contain a box for "${RULING5_ALL_DEAD_WAVE}" — every member is dead ` +
        `and none is running, so ruling 5 draws no box at all (got: ${JSON.stringify(waveLabels)})`,
    ).not.toContain(RULING5_ALL_DEAD_WAVE);
  });

  test("the all-dead wave's members still appear in view.members for zone 3's table", () => {
    const view = ruling5View();
    const memberIds = view.members.map((member) => member.cr);
    for (const dead of RULING5_ALL_DEAD_IDS) {
      expect(
        memberIds,
        `view.members must still name ${dead} — ruling 5 removes the BOX, never the record`,
      ).toContain(dead);
    }
  });

  test("a wave holding ONE running dead member and nothing else still draws its box (ruling 4 beats ruling 5)", () => {
    const view = ruling5View();
    const box = view.waves.find((candidate) => candidate.wave === RULING5_RUNNING_ONLY_WAVE);
    expect(
      box,
      `expected a box for "${RULING5_RUNNING_ONLY_WAVE}" — its one member is IN_PROGRESS, and ` +
        `ruling 4 keeps a running dead member's wave drawn even with no live member beside it`,
    ).not.toBeUndefined();
    expect(box?.entries.map((entry) => entry.cr)).toEqual(["CR-R5-RUN"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// RENDERED-DOM SECTION — the real public/app.js shell, van.js's real
// scheduler, inside happy-dom (house harness of tests/roadmap-wave-header.
// test.ts / tests/roadmap-wave-rollup.test.ts, verbatim).
// ═════════════════════════════════════════════════════════════════════════

const SHIP_010 = 1_787_149_125; // 2026-08-19, epoch SECONDS
const TARGET_040 = 1_790_000_000;

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
  timestamp: 1_787_000_000,
  waves: ["1"],
};

const PROPOSED_050: ProposalFixture = {
  label: "0.5.0",
  timestamp: 1_787_000_001,
  waves: ["3"],
};

/** The other releases' members — present so the fixture proves the drop acts
 *  on the FOCUSED release's own wave and leaks into no other. */
const OTHER_MEMBERS: QueueFixture[] = [
  { cr: "CR-S-A", title: "CR-S-A — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 1, release: "0.1.0" },
  { cr: "CR-S-B", title: "CR-S-B — delivered", wave: "9", dependsOn: [], status: "COMPLETED", seq: 2, release: "0.1.0" },
  { cr: "CR-U-1", title: "CR-U-1 — a later release's member", wave: "3", dependsOn: [], status: "PENDING", seq: 900, release: "0.5.0" },
];

const QUEUE: QueueFixture[] = [...OTHER_MEMBERS, ...ALL_ENTRIES];

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
 *  and render a zero-gate window. The box model is supplied exactly as the
 *  sibling suites supply it: wide enough that every fixture gate fits one
 *  window, so nothing here depends on paging. */
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
  const key = opts.key ?? "wave-drops-dead-key";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}/roadmap` });
  document.body.innerHTML = '<div id="app"></div>';
  installLayout();

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) as
      unknown as Response;

  const scriptedFetch = async (url: string): Promise<Response> => {
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      const proposals = opts.proposals ?? [PROPOSED_040, PROPOSED_050];
      return okResponse({ ok: true, proposals, totalCount: proposals.length });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) {
      return okResponse({ ok: true, releases: opts.releases ?? [SHIPPED_010] });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) {
      return okResponse({ ok: true, entries: opts.queue ?? QUEUE });
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
    throw new Error(`roadmap-wave-drops-dead-crs.test.ts mountApp: unexpected fetch url ${url}`);
  };
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import is REQUIRED, not a style choice: the specifier carries a
  // per-mount cache-bust query so each test re-evaluates app-logic.mjs into a
  // fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapWaveDropsDeadCrs=${cacheBust}`);

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

// ── DOM readers (tests/roadmap-wave-rollup.test.ts, verbatim) ──────────────

const all = (selector: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(selector));

const norm = (text: string | null): string => (text ?? "").replace(/\s+/g, " ").trim();

const waveEls = (): HTMLElement[] => all('[data-testid="roadmap-wave"]');
const waveNames = (): string[] => waveEls().map((w) => w.getAttribute("data-wave") ?? "");

function waveEl(wave: string): HTMLElement {
  const box = waveEls().find((w) => w.getAttribute("data-wave") === wave);
  if (box === undefined) {
    throw new Error(`no wave container rendered for wave ${wave} (have: ${waveNames().join(", ")})`);
  }
  return box;
}

const rowEls = (wave: string): HTMLElement[] =>
  Array.from(waveEl(wave).querySelectorAll<HTMLElement>('[data-testid="roadmap-node"]'));

const rowCrs = (wave: string): string[] =>
  rowEls(wave).map((row) => row.getAttribute("data-cr") ?? "");

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

const moreEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-more"]');

const rollupEl = (wave: string): HTMLElement | null =>
  waveEl(wave).querySelector<HTMLElement>('[data-testid="roadmap-wave-rollup"]');

function rollupCount(wave: string): number {
  const el = rollupEl(wave);
  if (el === null) {
    throw new Error(
      `wave ${wave} renders no [data-testid="roadmap-wave-rollup"] line (box text: ${norm(waveEl(wave).textContent)})`,
    );
  }
  const text = norm(el.textContent);
  const found = /(\d+)\s+merged\b/i.exec(text);
  if (found === null) throw new Error(`wave ${wave}'s roll-up states no \`N merged\` count — it reads "${text}"`);
  return Number(found[1]);
}

/** The loose group renders no `data-testid="roadmap-wave"` box at all
 *  (`RoadmapFlowWave` in `public/app.js`, `class: "app-flow-loose"`) —
 *  tests/roadmap-visual-grammar.test.ts (its "the same 29 members drawn
 *  UNTRIMMED…" test) already uses this same class selector to find it. */
function looseEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".app-flow-loose");
  if (el === null) throw new Error("no .app-flow-loose (the wave: null loose group) rendered");
  return el;
}

const looseCrs = (): string[] =>
  Array.from(looseEl().querySelectorAll<HTMLElement>('[data-testid="roadmap-node"]')).map(
    (row) => row.getAttribute("data-cr") ?? "",
  );

describe("the rendered Wave Card drops dead CRs everywhere (CR-CRU-147 §S1 AC3, real DOM)", () => {
  test("the wave's rendered header count excludes VOID/SUPERSEDED members, in both published attributes", async () => {
    await mountApp({ key: "wave-drops-dead-header" });
    expect(
      waveEl("1").getAttribute("data-cr-count"),
      `data-cr-count should read the ${WAVE_ONE_LIVE_COUNT} live members, not the ${WAVE_ONE.length} raw total`,
    ).toBe(String(WAVE_ONE_LIVE_COUNT));
    expect(countText("1")).toBe(String(WAVE_ONE_LIVE_COUNT));
  });

  test("the wave's rendered merged roll-up excludes a dead CR whose derived status is COMPLETED", async () => {
    await mountApp({ key: "wave-drops-dead-rollup" });
    expect(rollupCount("1")).toBe(WAVE_ONE_MERGED_COUNT);
  });

  test("the wave's rendered `+N more` pointer, and its rendered rows, name no dead CR", async () => {
    await mountApp({ key: "wave-drops-dead-rows" });
    const pointer = moreEl("1");
    if (pointer === null) {
      throw new Error(`wave 1 renders no [data-testid="roadmap-wave-more"] (rows: ${rowCrs("1").join(", ")})`);
    }
    expect(norm(pointer.textContent)).toBe(`+${WAVE_ONE_HIDDEN_COUNT} more — see the table below`);
    // The wave's rows are laned (CR-CRU-085 \u00a7S2), so the rendered DOM order
    // interleaves the alpha/beta lanes rather than following `box.rows`' flat
    // published order (the pure section above already pins that exact order);
    // sorted-set equality is what this AC cares about \u2014 which five are drawn.
    expect([...rowCrs("1")].sort()).toEqual([...WAVE_ONE_LIVE_ROWS].sort());
    for (const dead of WAVE_ONE_DEAD_IDS) {
      expect(rowCrs("1")).not.toContain(dead);
    }
  });

  test("the rendered loose group draws no dead CR — its live member only", async () => {
    await mountApp({ key: "wave-drops-dead-loose" });
    expect(looseCrs()).toEqual(["CR-L-1"]);
    expect(looseCrs()).not.toContain("CR-L-VOID");
  });
});

describe("ruling 4 — the rendered Wave Card keeps a running dead CR drawn and counted (CR-CRU-147 §S1 AC3's carve-out, real DOM)", () => {
  test("the wave's rendered header count includes both running dead members and excludes the non-running one", async () => {
    await mountApp({
      key: "wave-ruling4-header",
      releases: [],
      proposals: [
        { label: RELEASE, targetAt: TARGET_040, timestamp: 1_787_000_000, waves: [RULING4_WAVE] },
      ],
      queue: RULING4_ALL_ENTRIES,
    });
    expect(
      waveEl(RULING4_WAVE).getAttribute("data-cr-count"),
      `data-cr-count should read ${RULING4_EXPECTED_COUNT} (2 live + 2 running dead), not the raw ` +
        `${RULING4_WAVE_ENTRIES.length}`,
    ).toBe(String(RULING4_EXPECTED_COUNT));
    expect(countText(RULING4_WAVE)).toBe(String(RULING4_EXPECTED_COUNT));
    const rowCrsRuling4 = rowCrs(RULING4_WAVE);
    for (const running of RULING4_RUNNING_IDS) {
      expect(rowCrsRuling4, `${running} must be drawn as a row — it is IN_PROGRESS`).toContain(running);
    }
    expect(
      rowCrsRuling4,
      "CR-R-VOID is PENDING and non-running — it must not be drawn",
    ).not.toContain("CR-R-VOID");
  });
});

describe("ruling 5 — the rendered Wave Card draws no box for an all-dead wave; ruling 4 still draws one for a running-only wave (real DOM)", () => {
  test("the all-dead wave renders no [data-testid=\"roadmap-wave\"] element at all — no header, no `0` count", async () => {
    await mountApp({
      key: "wave-ruling5-no-box",
      releases: [],
      proposals: [
        {
          label: RELEASE,
          targetAt: TARGET_040,
          timestamp: 1_787_000_000,
          waves: [RULING5_ALL_DEAD_WAVE, RULING5_RUNNING_ONLY_WAVE],
        },
      ],
      queue: RULING5_ALL_ENTRIES,
    });
    expect(
      waveNames(),
      `no [data-testid="roadmap-wave"] element may carry data-wave="${RULING5_ALL_DEAD_WAVE}" — every ` +
        `member is dead and none is running (rendered waves: ${JSON.stringify(waveNames())})`,
    ).not.toContain(RULING5_ALL_DEAD_WAVE);
  });

  test("a wave with ONE running dead member and nothing else still renders its own box (ruling 4 beats ruling 5)", async () => {
    await mountApp({
      key: "wave-ruling5-running-only",
      releases: [],
      proposals: [
        {
          label: RELEASE,
          targetAt: TARGET_040,
          timestamp: 1_787_000_000,
          waves: [RULING5_ALL_DEAD_WAVE, RULING5_RUNNING_ONLY_WAVE],
        },
      ],
      queue: RULING5_ALL_ENTRIES,
    });
    expect(
      waveEl(RULING5_RUNNING_ONLY_WAVE).getAttribute("data-cr-count"),
      "the running-only wave's box holds one member (its running dead one) — data-cr-count must read 1",
    ).toBe("1");
    expect(
      rowCrs(RULING5_RUNNING_ONLY_WAVE),
      "CR-R5-RUN is IN_PROGRESS — ruling 4 keeps it drawn as the box's own row",
    ).toContain("CR-R5-RUN");
  });
});
