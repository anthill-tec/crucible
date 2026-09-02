// CR-CRU-096 cycle 314 FIX — `FocusedReleaseWave.rows`/`hiddenCount` state the
// TRUTH for the `wave: null` loose box.
//
// public/app-logic.d.mts documents `rows` as "the members this box DRAWS" and
// `hiddenCount` as "the SCHEDULED remainder `+N more` states". For every wave
// box with a header both are true. For the `wave: null` LOOSE group neither
// was: AC18a leaves that group UNTRIMMED, so the renderer drew `box.entries`
// and rendered no pointer at all, while the view still published the first
// five as `rows` and a non-zero `hiddenCount` — two published fields
// describing a render that never happened. VERIFY (cycle 314) measured it: a
// loose group of nine actionable members published `rows` = five while all
// nine were drawn, and `hiddenCount` = 4 while nothing was hidden.
//
// The contract this file pins:
//   • the loose box's `rows` are exactly the members it DRAWS — its whole
//     membership, untrimmed, in the server's published order (AC18a: the row
//     arrangement WITHOUT the trim; AC9b: which is why a merged or
//     dispositioned member is still drawn there, badge and all);
//   • its `hiddenCount` is `0`, because the group hides nothing and has no
//     anchor for a `+N more` pointer (AC18a);
//   • the TRIMMED path is untouched — same rows, same remainder (AC9/AC10/
//     AC11a), so making the loose group honest cannot silently loosen the
//     trim;
//   • and every box is SELF-DESCRIBING: `rows` is a WINDOW on `entries` and
//     `hiddenCount` is the scheduled remainder that window left out, so "what
//     does this box draw" is answered ONCE, in the view, instead of being
//     re-encoded at every reader (the three-places state VERIFY found). A box
//     may state a `+N more` remainder only when it has a HEADER to state it
//     on — which is exactly the loose group's disqualification.
//
// Everything here is asserted on the PUBLISHED view, never on production
// source text. The rendered side — that the loose group draws its whole
// membership untrimmed — is already pinned in a REAL browser by
// tests/roadmap-visual-grammar.test.ts (29 loose members, 29 nodes drawn), so
// nothing here needs to read `public/*` off disk to know what is on screen.
//
// AC29 — every fixture id is synthetic (`CR-L-*`, `CR-W-*`), so no assertion
// here depends on the shape of this project's own backlog.

import { describe, test, expect } from "bun:test";
import * as AppLogic from "../public/app-logic.mjs";

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

/** `src/types.ts` (`QueueEntry.lifecycle`) — the DISPOSITION axis, as the wire
 *  publishes it. */
interface LifecycleFixture {
  state: "SUPERSEDED" | "VOID";
  at: number;
}

/** `src/types.ts:389-414` (`QueueEntry`) — what `GET …/queue` publishes, in the
 *  server's canonical order (CR-CRU-095 §S1). The ORDER OF THIS ARRAY is the
 *  published order and the only order zone 2 may use. */
interface QueueFixture {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: QueueStatus;
  seq?: number;
  release?: string;
  lifecycle?: LifecycleFixture;
}

interface StripGateLike {
  version: string;
  kind: "shipped" | "proposed";
  date: string;
  dateState: "dated" | "absent" | "unusable";
}

interface WaveBoxLike {
  wave: string | null;
  entries: QueueFixture[];
  rows: QueueFixture[];
  hiddenCount: number;
  mergedCount: number;
}

// The ambient tests/app-logic.d.ts predates this export, so the module is cast
// to the boundary under test ONCE.
const Logic = AppLogic as unknown as {
  focusedReleaseView: (
    gate: StripGateLike,
    releases: unknown[],
    entries: QueueFixture[],
  ) => { waves: WaveBoxLike[]; nextCr: string | null };
};

const PROPOSED: StripGateLike = {
  version: "0.4.0",
  kind: "proposed",
  date: "",
  dateState: "absent",
};

/** `wave: ""` is the wire's own way of declaring NO wave
 *  (`src/types.ts:392`), and `declaredLabel` (public/app-logic.mjs:1082)
 *  reads it as the `null` group. */
const LOOSE = "";

const entry = (
  cr: string,
  wave: string,
  status: QueueStatus,
  seq: number,
  extra: Partial<QueueFixture> = {},
): QueueFixture => ({
  cr,
  title: `${cr} — synthetic member`,
  wave,
  dependsOn: [],
  status,
  seq,
  release: "0.4.0",
  ...extra,
});

const boxOf = (entries: QueueFixture[], wave: string | null): WaveBoxLike => {
  const view = Logic.focusedReleaseView(PROPOSED, [], entries);
  const box = view.waves.find((candidate) => candidate.wave === wave);
  if (box === undefined) throw new Error(`no wave box for ${String(wave)}`);
  return box;
};

const ids = (entries: QueueFixture[]): string[] => entries.map((member) => member.cr);

/** VERIFY's own fixture: nine actionable members, none declaring a wave. */
const NINE_LOOSE: QueueFixture[] = Array.from({ length: 9 }, (_, i) =>
  entry(`CR-L-${i + 1}`, LOOSE, "PENDING", (i + 1) * 10),
);

/** The loose group across all four derived statuses plus a dispositioned
 *  PENDING member — the AC9b path that keeps the node's lifecycle badge
 *  reachable, and the case a trim would silently delete. */
const MIXED_LOOSE: QueueFixture[] = [
  entry("CR-L-M1", LOOSE, "COMPLETED", 10),
  entry("CR-L-M2", LOOSE, "COMPLETED_UNTRACKED", 20),
  entry("CR-L-R1", LOOSE, "IN_PROGRESS", 30),
  entry("CR-L-V1", LOOSE, "PENDING", 40, { lifecycle: { state: "VOID", at: 1787000000 } }),
  entry("CR-L-P1", LOOSE, "PENDING", 50),
];

describe("CR-CRU-096 AC18a — the `wave: null` loose box publishes what it DRAWS", () => {
  test("nine actionable loose members publish all nine as `rows`, in the published order", () => {
    const box = boxOf(NINE_LOOSE, null);
    expect(ids(box.entries)).toEqual(ids(NINE_LOOSE));
    // The whole point: `rows` is the DRAWN set, and the loose group draws its
    // membership untrimmed — not the first five.
    expect(ids(box.rows)).toEqual(ids(NINE_LOOSE));
    expect(box.rows.length).toBe(9);
  });

  test("the loose box hides nothing, so `hiddenCount` is 0 — never a pointer with no anchor", () => {
    const box = boxOf(NINE_LOOSE, null);
    expect(box.hiddenCount).toBe(0);
  });

  test("`rows` is the loose box's WHOLE membership — merged, running and dispositioned alike", () => {
    const box = boxOf(MIXED_LOOSE, null);
    // AC18a takes the row ARRANGEMENT without the trim, which is exactly why
    // AC9b's badge stays reachable: a merged or VOID member is still drawn
    // here, so `rows` must name it.
    expect(ids(box.rows)).toEqual(ids(MIXED_LOOSE));
    expect(box.rows).toEqual(box.entries);
    expect(box.hiddenCount).toBe(0);
    // The roll-up count is a fact about membership and is unchanged by any of
    // this: two merged members, whether or not they are rows.
    expect(box.mergedCount).toBe(2);
  });

  test("a board carrying BOTH shapes trims the wave box and leaves the loose box whole", () => {
    const mixedBoard = [
      ...Array.from({ length: 9 }, (_, i) => entry(`CR-W-${i + 1}`, "1", "PENDING", (i + 1) * 10)),
      ...NINE_LOOSE.map((member) => ({ ...member, seq: (member.seq ?? 0) + 1000 })),
    ];
    const waveBox = boxOf(mixedBoard, "1");
    const looseBox = boxOf(mixedBoard, null);
    expect(waveBox.rows.length).toBe(5);
    expect(waveBox.hiddenCount).toBe(4);
    expect(looseBox.rows.length).toBe(9);
    expect(looseBox.hiddenCount).toBe(0);
  });
});

describe("CR-CRU-096 AC9/AC10/AC11a — the TRIMMED path is byte-for-byte what it was", () => {
  // AC10's own fixture: `CR-W-1 … CR-W-9` with the first two COMPLETED. Seven
  // scheduled, five shown, remainder two.
  const NINE_WAVE: QueueFixture[] = Array.from({ length: 9 }, (_, i) =>
    entry(`CR-W-${i + 1}`, "1", i < 2 ? "COMPLETED" : "PENDING", (i + 1) * 10),
  );

  test("a wave box still shows the top five scheduled and states the true remainder", () => {
    const box = boxOf(NINE_WAVE, "1");
    expect(ids(box.rows)).toEqual(["CR-W-3", "CR-W-4", "CR-W-5", "CR-W-6", "CR-W-7"]);
    expect(box.hiddenCount).toBe(2);
    expect(box.entries.length).toBe(9);
    expect(box.mergedCount).toBe(2);
  });

  test("an out-of-window runner still EXTENDS the wave's rows and never displaces one (AC11a)", () => {
    const withRunner = NINE_WAVE.map((member) =>
      member.cr === "CR-W-9" ? { ...member, status: "IN_PROGRESS" as QueueStatus } : member,
    );
    const box = boxOf(withRunner, "1");
    expect(ids(box.rows)).toEqual([
      "CR-W-3",
      "CR-W-4",
      "CR-W-5",
      "CR-W-6",
      "CR-W-7",
      "CR-W-9",
    ]);
    // Six actionable remain scheduled behind the five shown: 6 − 5 = 1. The
    // runner is not scheduled work, so it is in neither term.
    expect(box.hiddenCount).toBe(1);
  });

  test("a dispositioned PENDING member is still no row of a TRIMMED wave (AC9a)", () => {
    const withVoid = [
      ...NINE_WAVE,
      entry("CR-W-V", "1", "PENDING", 5, { lifecycle: { state: "SUPERSEDED", at: 1787000000 } }),
    ];
    const box = boxOf(withVoid, "1");
    expect(ids(box.rows)).not.toContain("CR-W-V");
    expect(box.entries.map((member) => member.cr)).toContain("CR-W-V");
  });
});

describe("CR-CRU-096 §S5 — every box answers 'what do I draw' ONCE, and answers it truthfully", () => {
  /** `rows` is a WINDOW on `entries`: the same member objects, in the same
   *  published order, never a re-ordering and never a member the membership
   *  does not hold. */
  const isWindowOn = (window: QueueFixture[], whole: QueueFixture[]): boolean => {
    let at = 0;
    for (const member of window) {
      const found = whole.indexOf(member, at);
      if (found === -1) return false;
      at = found + 1;
    }
    return true;
  };

  /** One board carrying BOTH shapes, so the invariants below are asserted
   *  over a trimmed box and the loose box in the SAME view. */
  const BOTH_SHAPES: QueueFixture[] = [
    ...Array.from({ length: 9 }, (_, i) => entry(`CR-W-${i + 1}`, "1", "PENDING", (i + 1) * 10)),
    ...NINE_LOOSE.map((member) => ({ ...member, seq: (member.seq ?? 0) + 1000 })),
  ];

  test("`rows` is a window on `entries` for every box, and the remainder fits inside it", () => {
    const view = Logic.focusedReleaseView(PROPOSED, [], BOTH_SHAPES);
    expect(view.waves.length).toBe(2);
    for (const box of view.waves) {
      expect(isWindowOn(box.rows, box.entries)).toBe(true);
      // Drawn + hidden can never claim more than the box holds. Today the
      // loose box claims 5 + 4 against 9 and squeaks past this; it is the
      // NEXT assertion that names what is wrong with those two numbers.
      expect(box.rows.length + box.hiddenCount).toBeLessThanOrEqual(box.entries.length);
    }
  });

  test("a box states a `+N more` remainder ONLY when it has a header to state it on", () => {
    // AC18a — the loose group renders no header, so it has nowhere to state
    // whole membership and no anchor for the pointer. A non-zero
    // `hiddenCount` there is a pointer nothing can draw, and the members it
    // claims are hidden are on screen anyway.
    const view = Logic.focusedReleaseView(PROPOSED, [], BOTH_SHAPES);
    for (const box of view.waves) {
      if (box.wave === null) {
        expect(box.hiddenCount).toBe(0);
        // …and with nothing hidden, the window IS the whole membership: one
        // field answers "what does this box draw" for every reader.
        expect(ids(box.rows)).toEqual(ids(box.entries));
      } else {
        expect(box.hiddenCount).toBeGreaterThan(0);
        expect(box.rows.length).toBeLessThan(box.entries.length);
      }
    }
  });

  // A REGRESSION PIN, not a RED: `nextCr` reads the same drawn set whether it
  // is spelled `box.rows` or re-derived per box, so making the derivation
  // uniform has no observable signature of its own. What IS observable — and
  // what must survive the change — is that the marker names a row the zone
  // actually draws, the loose group included (AC12c).
  test("`nextCr` names a row the zone DRAWS, and the loose group is eligible (AC12c)", () => {
    const view = Logic.focusedReleaseView(PROPOSED, [], MIXED_LOOSE);
    // M1/M2 are merged, R1 is running (not scheduled work) and V1 is
    // dispositioned, so the first thing to take up is P1.
    const marked = view.nextCr;
    expect(marked).toBe("CR-L-P1");
    // `null` is a REAL state here — a release with nothing to take up marks
    // no row (AC12b) — so the marker is proven to be an id before it is
    // looked for, rather than asserted away with a `!`.
    if (typeof marked !== "string") throw new Error("nextCr is null: no row is marked");
    expect(view.waves.flatMap((box) => ids(box.rows))).toContain(marked);
  });
});
