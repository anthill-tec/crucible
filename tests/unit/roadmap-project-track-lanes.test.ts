// A multi-track PROJECT lanes every wave of the focused release — the pure
// view half, `focusedReleaseView` (public/app-logic.mjs), with no DOM.
//
// THE RULE UNDER TEST. A project is MULTI-TRACK when the WHOLE queue it was
// read from (`focusedReleaseView`'s `entries`: every row, in every release,
// whatever its status or lifecycle) declares more than one track — the same
// count `declaredTracks` (src/store.ts) makes for `next`. In such a project:
//   • every wave box publishes one lane per track its OWN live members
//     declare, so a single-track wave publishes ONE lane holding all its
//     drawn rows and no solo rows;
//   • a wave whose live members declare no track publishes no lanes;
//   • the loose group (`wave: null`) is never laned;
//   • every drawn row that declares no track and is not merged is published
//     as an UNTRACKED row — the row the renderer flags `no track`.
// A project whose queue declares one track or none is unchanged: a wave lanes
// only when its own members declare more than one track, and no row is
// flagged.
//
// THE TWO FIELDS THIS FILE NAMES FOR GREEN (the view publishes neither yet):
//   • `projectTracks: string[]` on the view — the project's declared tracks
//     over the whole `entries` argument, the browser mirror of
//     `declaredTracks`. Compared here as a SET (sorted), because the server
//     publishes sorted and the browser's `distinctLabels` keeps
//     first-appearance order;
//   • `untrackedRows: Entry[]` on every wave box (the loose group included) —
//     the box's drawn `rows` that declare no track and are not merged
//     (`COMPLETED`/`COMPLETED_UNTRACKED`), in the published order; `[]` in a
//     solo project.
//
// Every fixture id is synthetic (`CR-P-*`, `CR-N-*`, `CR-Q-*`), and every
// track a fixture's own.

import { describe, test, expect } from "bun:test";
import * as AppLogic from "../../public/app-logic.mjs";

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

/** `QueueEntry.lifecycle` (src/types.ts) — the disposition axis. */
interface LifecycleFixture {
  state: "SUPERSEDED" | "VOID";
  at: number;
  reason?: string;
  by?: string;
}

/** `QueueEntry` (src/types.ts) — what `GET …/queue` publishes, in the
 *  server's canonical order. The order of each fixture array IS the published
 *  order. */
interface QueueFixture {
  cr: string;
  title: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  seq: number;
  release: string;
  track?: string;
  planId?: number;
  lifecycle?: LifecycleFixture;
}

interface LaneLike {
  track: string;
  rows: QueueFixture[];
}

interface WaveBoxLike {
  wave: string | null;
  entries: QueueFixture[];
  rows: QueueFixture[];
  lanes: LaneLike[];
  soloRows: QueueFixture[];
  /** Named for GREEN — not yet published. */
  untrackedRows?: QueueFixture[];
}

interface ViewLike {
  waves: WaveBoxLike[];
  tracks: string[];
  nextCr: string | null;
  /** Named for GREEN — not yet published. */
  projectTracks?: string[];
}

/** The boundary under test, cast ONCE: the two fields GREEN adds are not in
 *  `public/app-logic.d.mts` yet, so the declared type cannot name them. */
const Logic = AppLogic as unknown as {
  focusedReleaseView: (gate: unknown, releases: unknown[], entries: QueueFixture[]) => ViewLike;
};

const FOCUS = "0.4.0";
const GATE = { version: FOCUS, kind: "proposed", date: "", dateState: "absent" };

/** `wave: ""` is the wire's way of declaring NO wave; the view groups it
 *  under `wave: null`, the loose group. */
const LOOSE = "";

const RETIRED_AT = 1787200000000;

function row(
  cr: string,
  wave: string,
  status: QueueStatus,
  seq: number,
  extra: Partial<QueueFixture> = {},
): QueueFixture {
  return {
    cr,
    title: `${cr} — synthetic member`,
    wave,
    dependsOn: [],
    status,
    seq,
    release: FOCUS,
    ...extra,
  };
}

const ids = (entries: readonly QueueFixture[]): string[] => entries.map((entry) => entry.cr);

const viewOf = (entries: QueueFixture[]): ViewLike => Logic.focusedReleaseView(GATE, [], entries);

function boxOf(view: ViewLike, wave: string | null): WaveBoxLike {
  const box = view.waves.find((candidate) => candidate.wave === wave);
  if (box === undefined) {
    throw new Error(
      `the view publishes no box for wave ${String(wave)} (have: ${view.waves
        .map((candidate) => String(candidate.wave))
        .join(", ")})`,
    );
  }
  return box;
}

/** A box's lanes as plain data: each lane's track and the ids of its rows. */
const lanesOf = (box: WaveBoxLike): { track: string; rows: string[] }[] =>
  box.lanes.map((lane) => ({ track: lane.track, rows: ids(lane.rows) }));

/** The box's published untracked rows by id — `undefined` while the view
 *  publishes no such list, so the assertion names the missing field. */
const untrackedIds = (box: WaveBoxLike): string[] | undefined =>
  box.untrackedRows === undefined ? undefined : ids(box.untrackedRows);

/** The view's project track list as a SET — `undefined` while the view
 *  publishes no such list. */
const projectTrackSet = (view: ViewLike): string[] | undefined =>
  view.projectTracks === undefined ? undefined : [...view.projectTracks].sort();

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Two tracks in the focused release, ONE PER WAVE: each wave is single-track
 *  on its own, the project is not. A merged member in wave 1 is counted and
 *  never drawn, so "all the wave's drawn rows" is not "all its members". */
const ONE_TRACK_PER_WAVE: QueueFixture[] = [
  row("CR-P-01", "1", "COMPLETED", 10, { track: "track-1" }),
  row("CR-P-02", "1", "PENDING", 20, { track: "track-1" }),
  row("CR-P-03", "1", "PENDING", 30, { track: "track-1" }),
  row("CR-P-04", "2", "PENDING", 40, { track: "track-2" }),
  row("CR-P-05", "2", "PENDING", 50, { track: "track-2" }),
];

/** One wave carrying both tracks, interleaved. */
const TWO_TRACKS_IN_ONE_WAVE: QueueFixture[] = [
  row("CR-P-11", "1", "PENDING", 10, { track: "track-1" }),
  row("CR-P-12", "1", "PENDING", 20, { track: "track-2" }),
  row("CR-P-13", "1", "PENDING", 30, { track: "track-1" }),
  row("CR-P-14", "1", "PENDING", 40, { track: "track-2" }),
];

/** The focused release on `track-1` alone — every second-track fixture below
 *  adds its second track somewhere OUTSIDE this wave's live membership. */
const FOCUS_ON_TRACK_1: QueueFixture[] = [
  row("CR-P-21", "1", "PENDING", 10, { track: "track-1" }),
  row("CR-P-22", "1", "PENDING", 20, { track: "track-1" }),
];

/** The marker's three homes, and the rows that must NOT be flagged:
 *   • wave 1 — laned (two tracks), with an untracked row in its solo rows;
 *   • wave 2 — no declared track at all, plus a merged untracked member that
 *     is counted and never drawn;
 *   • the loose group — never laned, and drawing its membership untrimmed, so
 *     a merged untracked row (both merged statuses), a tracked row and a
 *     RUNNING untracked row are all drawn there. */
const MARKED: QueueFixture[] = [
  row("CR-N-01", "1", "PENDING", 10, { dependsOn: ["CR-N-11"] }),
  row("CR-N-02", "1", "PENDING", 20, { track: "track-1" }),
  row("CR-N-03", "1", "PENDING", 30, { track: "track-2" }),
  row("CR-N-11", "2", "PENDING", 40),
  row("CR-N-12", "2", "PENDING", 50, { dependsOn: ["CR-N-11"] }),
  row("CR-N-13", "2", "COMPLETED", 60),
  row("CR-N-21", LOOSE, "PENDING", 70),
  row("CR-N-22", LOOSE, "COMPLETED", 80),
  row("CR-N-23", LOOSE, "PENDING", 90, { track: "track-1" }),
  row("CR-N-24", LOOSE, "IN_PROGRESS", 100, { planId: 61 }),
  row("CR-N-25", LOOSE, "COMPLETED_UNTRACKED", 110),
];

/** `MARKED` collapsed onto ONE declared track: the solo twin. */
const MARKED_ONE: QueueFixture[] = MARKED.map((entry) =>
  entry.track === undefined ? entry : { ...entry, track: "track-1" },
);

/** `MARKED` with every track removed: the no-track twin. */
const MARKED_NONE: QueueFixture[] = MARKED.map(({ track: _dropped, ...rest }) => rest);

// ── S1 — a multi-track project lanes every wave ───────────────────────────

describe("a multi-track project lanes every wave, single-track waves included", () => {
  test("a wave whose live members all declare one track publishes exactly that one lane, holding every drawn row, and no solo rows", () => {
    const view = viewOf(ONE_TRACK_PER_WAVE);
    const first = boxOf(view, "1");
    const second = boxOf(view, "2");

    // Premise: the merged member is counted but not drawn, so the lane's rows
    // are the drawn rows, not the membership.
    expect(ids(first.entries)).toEqual(["CR-P-01", "CR-P-02", "CR-P-03"]);
    expect(ids(first.rows)).toEqual(["CR-P-02", "CR-P-03"]);

    expect(lanesOf(first)).toEqual([{ track: "track-1", rows: ids(first.rows) }]);
    expect(lanesOf(first)).toEqual([{ track: "track-1", rows: ["CR-P-02", "CR-P-03"] }]);
    expect(ids(first.soloRows)).toEqual([]);

    expect(lanesOf(second)).toEqual([{ track: "track-2", rows: ["CR-P-04", "CR-P-05"] }]);
    expect(ids(second.soloRows)).toEqual([]);
  });

  test("a wave whose members declare two tracks publishes two lanes in first-appearance order, partitioning its drawn rows", () => {
    const box = boxOf(viewOf(TWO_TRACKS_IN_ONE_WAVE), "1");

    expect(lanesOf(box)).toEqual([
      { track: "track-1", rows: ["CR-P-11", "CR-P-13"] },
      { track: "track-2", rows: ["CR-P-12", "CR-P-14"] },
    ]);
    expect(ids(box.soloRows)).toEqual([]);
  });

  test("a second track declared only by a member of ANOTHER release makes the project multi-track, so the focused single-track wave publishes its one lane", () => {
    const queue: QueueFixture[] = [
      row("CR-Q-01", "9", "PENDING", 5, { release: "0.3.0", track: "track-2" }),
      ...FOCUS_ON_TRACK_1,
    ];
    const view = viewOf(queue);

    // The focused release itself still reports one track: the second lives
    // only in the other release.
    expect(view.tracks).toEqual(["track-1"]);
    expect(lanesOf(boxOf(view, "1"))).toEqual([
      { track: "track-1", rows: ["CR-P-21", "CR-P-22"] },
    ]);
    expect(ids(boxOf(view, "1").soloRows)).toEqual([]);
    expect(projectTrackSet(view)).toEqual(["track-1", "track-2"]);
  });

  test("a second track declared only on a COMPLETED row still counts, so the single-track wave publishes its one lane", () => {
    const queue: QueueFixture[] = [
      ...FOCUS_ON_TRACK_1,
      row("CR-Q-11", "2", "COMPLETED", 30, { track: "track-2" }),
    ];
    const view = viewOf(queue);

    expect(lanesOf(boxOf(view, "1"))).toEqual([
      { track: "track-1", rows: ["CR-P-21", "CR-P-22"] },
    ]);
    expect(projectTrackSet(view)).toEqual(["track-1", "track-2"]);
  });

  test("a second track declared only on a VOID or a SUPERSEDED row still counts, though the dead row draws nowhere and gets no lane", () => {
    for (const lifecycle of [
      { state: "VOID", reason: "retired", at: RETIRED_AT },
      { state: "SUPERSEDED", by: "CR-P-21", at: RETIRED_AT },
    ] satisfies LifecycleFixture[]) {
      const queue: QueueFixture[] = [
        ...FOCUS_ON_TRACK_1,
        row("CR-Q-21", "1", "PENDING", 30, { track: "track-2", lifecycle }),
      ];
      const view = viewOf(queue);
      const box = boxOf(view, "1");

      // Premise: the dead row is outside the wave's live membership.
      expect({ state: lifecycle.state, entries: ids(box.entries) }).toEqual({
        state: lifecycle.state,
        entries: ["CR-P-21", "CR-P-22"],
      });
      // One lane — the live members' own track — and none for the dead row's.
      expect({ state: lifecycle.state, lanes: lanesOf(box) }).toEqual({
        state: lifecycle.state,
        lanes: [{ track: "track-1", rows: ["CR-P-21", "CR-P-22"] }],
      });
      expect({ state: lifecycle.state, projectTracks: projectTrackSet(view) }).toEqual({
        state: lifecycle.state,
        projectTracks: ["track-1", "track-2"],
      });
    }
  });

  test("a wave whose live members declare no track publishes no lanes, draws every row as a solo row, and flags every drawn row untracked", () => {
    const box = boxOf(viewOf(MARKED), "2");

    expect(ids(box.rows)).toEqual(["CR-N-11", "CR-N-12"]);
    expect(box.lanes).toEqual([]);
    expect(ids(box.soloRows)).toEqual(["CR-N-11", "CR-N-12"]);
    expect(untrackedIds(box)).toEqual(["CR-N-11", "CR-N-12"]);
  });

  test("the loose group stays unlaned in a multi-track project, whatever its members declare", () => {
    const loose = boxOf(viewOf(MARKED), null);

    expect(ids(loose.rows)).toEqual(["CR-N-21", "CR-N-22", "CR-N-23", "CR-N-24", "CR-N-25"]);
    expect(loose.lanes).toEqual([]);
    expect(ids(loose.soloRows)).toEqual(ids(loose.rows));
  });
});

// ── S3 — the untracked rows, as data ───────────────────────────────────────

describe("a multi-track project publishes each box's untracked, non-merged drawn rows", () => {
  test("a laned wave's untracked solo row, a no-track wave's rows and the loose group's untracked live rows are each published, and nothing else", () => {
    const view = viewOf(MARKED);
    const laned = boxOf(view, "1");
    const noTrack = boxOf(view, "2");
    const loose = boxOf(view, null);

    // Premise: wave 1 is laned and its untracked row sits in its solo rows.
    expect(lanesOf(laned)).toEqual([
      { track: "track-1", rows: ["CR-N-02"] },
      { track: "track-2", rows: ["CR-N-03"] },
    ]);
    expect(ids(laned.soloRows)).toEqual(["CR-N-01"]);

    expect(untrackedIds(laned)).toEqual(["CR-N-01"]);
    expect(untrackedIds(noTrack)).toEqual(["CR-N-11", "CR-N-12"]);
    // The running untracked row is flagged; the merged ones (both merged
    // statuses) and the tracked row are not.
    expect(untrackedIds(loose)).toEqual(["CR-N-21", "CR-N-24"]);
  });

  test("a tracked row is never published as untracked, and neither is a merged untracked row", () => {
    const view = viewOf(MARKED);
    const flagged = view.waves.flatMap((box) => untrackedIds(box) ?? ["<no untrackedRows>"]);

    expect(flagged).toEqual(["CR-N-01", "CR-N-11", "CR-N-12", "CR-N-21", "CR-N-24"]);
    for (const tracked of ["CR-N-02", "CR-N-03", "CR-N-23"]) {
      expect(flagged).not.toContain(tracked);
    }
    for (const merged of ["CR-N-13", "CR-N-22", "CR-N-25"]) {
      expect(flagged).not.toContain(merged);
    }
  });
});

// ── S2 — a solo project is unchanged ───────────────────────────────────────

describe("a project declaring one track or none is unchanged", () => {
  test("one declared track, with untracked members beside it, publishes no lanes in any box and draws every row as a solo row", () => {
    const view = viewOf(MARKED_ONE);

    expect(view.waves.map((box) => box.wave)).toEqual(["1", "2", null]);
    for (const box of view.waves) {
      expect({ wave: box.wave, lanes: box.lanes }).toEqual({ wave: box.wave, lanes: [] });
      expect({ wave: box.wave, solo: ids(box.soloRows) }).toEqual({
        wave: box.wave,
        solo: ids(box.rows),
      });
    }
  });

  test("one declared track on every member publishes no lanes, even across two waves", () => {
    const view = viewOf(FOCUS_ON_TRACK_1.concat(row("CR-Q-31", "2", "PENDING", 30, { track: "track-1" })));

    for (const box of view.waves) {
      expect({ wave: box.wave, lanes: box.lanes }).toEqual({ wave: box.wave, lanes: [] });
    }
  });

  test("no declared track anywhere publishes no lanes in any box", () => {
    const view = viewOf(MARKED_NONE);

    expect(view.waves.map((box) => box.wave)).toEqual(["1", "2", null]);
    for (const box of view.waves) {
      expect({ wave: box.wave, lanes: box.lanes }).toEqual({ wave: box.wave, lanes: [] });
      expect({ wave: box.wave, solo: ids(box.soloRows) }).toEqual({
        wave: box.wave,
        solo: ids(box.rows),
      });
    }
  });

  test("a solo project publishes its one track, or none, as the project list, and flags no row untracked", () => {
    const one = viewOf(MARKED_ONE);
    const none = viewOf(MARKED_NONE);

    expect(projectTrackSet(one)).toEqual(["track-1"]);
    expect(projectTrackSet(none)).toEqual([]);
    for (const view of [one, none]) {
      for (const box of view.waves) {
        expect({ wave: box.wave, untracked: untrackedIds(box) }).toEqual({
          wave: box.wave,
          untracked: [],
        });
      }
    }
  });
});

// ── Track names — counted as written, trimmed, blanks dropped ──────────────

describe("the project's tracks are counted as stored: trimmed, blanks dropped, never folded", () => {
  /** A padded spelling beside the canonical one, and two blanks. */
  const PADDED: QueueFixture[] = [
    row("CR-Q-41", "1", "PENDING", 10, { track: "track-2" }),
    row("CR-Q-42", "1", "PENDING", 20, { track: " track-2 " }),
    row("CR-Q-43", "2", "PENDING", 30, { track: "" }),
    row("CR-Q-44", "2", "PENDING", 40, { track: "   " }),
  ];

  test("a padded spelling of one track and two blanks are ONE track, so no wave is laned", () => {
    const view = viewOf(PADDED);

    for (const box of view.waves) {
      expect({ wave: box.wave, lanes: box.lanes }).toEqual({ wave: box.wave, lanes: [] });
    }
  });

  test("a padded spelling of one track and two blanks publish that one track once as the project list, and flag no row", () => {
    const view = viewOf(PADDED);

    expect(projectTrackSet(view)).toEqual(["track-2"]);
    for (const box of view.waves) {
      expect({ wave: box.wave, untracked: untrackedIds(box) }).toEqual({
        wave: box.wave,
        untracked: [],
      });
    }
  });

  test("a legacy un-normalised `2` beside `track-2` counts as written — two tracks — so each single-track wave publishes its own lane", () => {
    const view = viewOf([
      row("CR-Q-51", "1", "PENDING", 10, { track: "2" }),
      row("CR-Q-52", "1", "PENDING", 20, { track: "2" }),
      row("CR-Q-53", "2", "PENDING", 30, { track: "track-2" }),
    ]);

    expect(projectTrackSet(view)).toEqual(["2", "track-2"]);
    expect(lanesOf(boxOf(view, "1"))).toEqual([{ track: "2", rows: ["CR-Q-51", "CR-Q-52"] }]);
    expect(lanesOf(boxOf(view, "2"))).toEqual([{ track: "track-2", rows: ["CR-Q-53"] }]);
  });
});
