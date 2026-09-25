// CR-CRU-147 §S1 AC5 (cycle 525, C3) — ONE dead-CR rule, and the browser
// mirror held to it.
//
// Spec: docs/changes/CR-CRU-147-a-voided-cr-is-not-queued-work.md
//       §S1 AC5 — "`next` and every server reader judge deadness with
//       `isDeadCr` (`src/types.ts`) ... The browser module's mirror is
//       state-based, and a parity test runs the server rule and the mirror
//       over the same fixtures, including `lifecycle: null` and a lifecycle
//       with an unrecognised state, and requires the same answer on every
//       one."
//       Gap-analysis box, "Three dead-CR predicates, one rule": `isDeadCr`
//       (`src/types.ts`, state-based) reads `lifecycle.state ∈ {VOID,
//       SUPERSEDED}`. "The browser module cannot import `src/`, so it keeps
//       one state-based mirror, held to the server rule by a parity test."
//
// SCOPE — this file owns two things:
//   (1) that `public/app-logic.mjs` exports a function named `isDeadCr`, and
//       that it answers IDENTICALLY to `src/types.ts`'s `isDeadCr` over the
//       same fixtures (no lifecycle key, `lifecycle: undefined`,
//       `lifecycle: null`, `{state:"VOID"}`, `{state:"SUPERSEDED", by:…}`, and
//       an unrecognised `{state:"PARKED"}`);
//   (2) that the Wave Card's OWN reading of deadness is STATE-based, not
//       presence-based: a PENDING member carrying `lifecycle: null` or an
//       unrecognised `lifecycle.state` is LIVE work and must get a row in
//       `focusedReleaseView`'s waved box — the boundary case AC3's sibling
//       suite (tests/roadmap-wave-drops-dead-crs.test.ts) deliberately does
//       not cover, because it is about the MIRROR, not the drop.
//
// A `null`/`undefined` entry itself is NOT one of the parity fixtures: the
// server `isDeadCr` (`src/types.ts:488`) reads `entry.lifecycle` unguarded on
// `entry`, so a null/undefined *entry* throws a `TypeError` rather than
// answering `false` — the server does not accept that shape, so there is
// nothing here for a mirror to match.
//
// RED phase — expected to FAIL against current production, which:
//   • exports no `isDeadCr` from public/app-logic.mjs at all — every parity
//     test below fails on `typeof Logic.isDeadCr` before it ever compares an
//     answer;
//   • answers `roadmapActionable` (public/app-logic.mjs:1297) off
//     `!("lifecycle" in entry)`, so a PENDING member carrying
//     `lifecycle: null` or `{state:"PARKED"}` is excluded from
//     `box.rows`/`box.soloRows` even though it is live, undead work.
import { describe, test, expect } from "bun:test";
import { isDeadCr as isDeadCrServer } from "../src/types.ts";
import * as AppLogic from "../public/app-logic.mjs";

type QueueStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_UNTRACKED";

/** `src/types.ts` (`QueueLifecycle`) — the disposition axis, as the wire
 *  publishes it. `state` is typed as `string` here (not the narrow union) so
 *  the unrecognised-value fixture below can exist at all: the wire is not the
 *  type. */
interface LifecycleFixture {
  state: string;
  by?: string;
  reason?: string;
  at: number;
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
  lifecycle?: LifecycleFixture | null;
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
}

// The ambient tests/app-logic.d.ts predates `isDeadCr` and `focusedReleaseView`
// both, so the module is cast to the boundary under test ONCE — the same
// technique tests/wave-loose-box-truthful.test.ts already uses.
const Logic = AppLogic as unknown as {
  isDeadCr?: (entry: { lifecycle?: { state?: string } | null }) => boolean;
  focusedReleaseView: (
    gate: StripGateLike,
    releases: unknown[],
    entries: QueueFixture[],
  ) => { waves: WaveBoxLike[] };
};

// ── AC5's parity fixtures — named exactly as the AC states them ────────────

interface LifecycleCase {
  label: string;
  entry: { lifecycle?: LifecycleFixture | null };
  expectedDead: boolean;
}

const PARITY_CASES: LifecycleCase[] = [
  { label: "no lifecycle key at all", entry: {}, expectedDead: false },
  { label: "lifecycle: undefined", entry: { lifecycle: undefined }, expectedDead: false },
  { label: "lifecycle: null", entry: { lifecycle: null }, expectedDead: false },
  {
    label: "lifecycle.state VOID",
    entry: { lifecycle: { state: "VOID", reason: "duplicate of CR-B-9", at: 1700000000000 } },
    expectedDead: true,
  },
  {
    label: "lifecycle.state SUPERSEDED, carrying its successor",
    entry: { lifecycle: { state: "SUPERSEDED", by: "CR-SUCCESSOR-1", at: 1700000000000 } },
    expectedDead: true,
  },
  {
    label: "lifecycle.state an unrecognised value (PARKED)",
    entry: { lifecycle: { state: "PARKED", at: 1700000000000 } },
    expectedDead: false,
  },
];

describe("dead-CR rule parity — src/types.ts isDeadCr vs public/app-logic.mjs isDeadCr (CR-CRU-147 §S1 AC5)", () => {
  test("public/app-logic.mjs exports a function named isDeadCr", () => {
    expect(
      typeof Logic.isDeadCr,
      "public/app-logic.mjs exports no isDeadCr — AC5's state-based browser mirror does not exist yet",
    ).toBe("function");
  });

  for (const { label, entry, expectedDead } of PARITY_CASES) {
    test(`server and browser isDeadCr agree on ${label} (both should answer ${expectedDead})`, () => {
      // The `state` field is deliberately widened to `string` on the fixture
      // (`LifecycleFixture`) so the unrecognised-value case can exist at all;
      // the wire is not the narrow union `src/types.ts`'s `isDeadCr` types
      // itself against, so the fixture is cast at the call boundary, not
      // narrowed to only the values the union names.
      const serverAnswer = isDeadCrServer(entry as { lifecycle?: { state: "SUPERSEDED" | "VOID" } | null });
      expect(serverAnswer, `src/types.ts isDeadCr(${label}) should answer ${expectedDead}`).toBe(
        expectedDead,
      );

      expect(
        typeof Logic.isDeadCr,
        `public/app-logic.mjs exports no isDeadCr — cannot compare it against the server for ${label}`,
      ).toBe("function");
      const browserAnswer = (Logic.isDeadCr as (e: typeof entry) => boolean)(entry);
      expect(
        browserAnswer,
        `public/app-logic.mjs isDeadCr(${label}) should answer ${expectedDead}`,
      ).toBe(expectedDead);
      expect(
        browserAnswer,
        `public/app-logic.mjs and src/types.ts isDeadCr disagree on ${label}: ` +
          `browser=${browserAnswer} server=${serverAnswer}`,
      ).toBe(serverAnswer);
    });
  }
});

// ── The Wave Card's OWN half of the same rule ───────────────────────────────

describe("the Wave Card judges deadness the same way as isDeadCr, not by lifecycle-key presence (CR-CRU-147 §S1 AC5)", () => {
  const PROPOSED: StripGateLike = {
    version: "0.4.0",
    kind: "proposed",
    date: "",
    dateState: "absent",
  };

  const entry = (
    cr: string,
    status: QueueStatus,
    extra: Partial<QueueFixture> = {},
  ): QueueFixture => ({
    cr,
    title: `${cr} — synthetic member`,
    wave: "1",
    dependsOn: [],
    status,
    seq: 10,
    release: "0.4.0",
    ...extra,
  });

  function waveOneRowIds(entries: QueueFixture[]): string[] {
    const view = Logic.focusedReleaseView(PROPOSED, [], entries);
    const box = view.waves.find((w) => w.wave === "1");
    if (box === undefined) throw new Error("fixture bug: no wave box for wave 1");
    return box.rows.map((row) => row.cr);
  }

  test("a PENDING member carrying lifecycle: null is LIVE and gets a wave-box row", () => {
    const LIVE_NULL_LIFECYCLE = entry("CR-B-1", "PENDING", { lifecycle: null });
    expect(
      waveOneRowIds([LIVE_NULL_LIFECYCLE]),
      "lifecycle: null is not a disposition — a PENDING member carrying it is live work and must draw a row",
    ).toEqual(["CR-B-1"]);
  });

  test("a PENDING member carrying an unrecognised lifecycle.state (PARKED) is LIVE and gets a wave-box row", () => {
    const LIVE_UNRECOGNISED_STATE = entry("CR-B-2", "PENDING", {
      lifecycle: { state: "PARKED", at: 1700000000000 },
    });
    expect(
      waveOneRowIds([LIVE_UNRECOGNISED_STATE]),
      "an unrecognised lifecycle.state is not VOID/SUPERSEDED — a PENDING member carrying it is live work and must draw a row",
    ).toEqual(["CR-B-2"]);
  });

  test("a PENDING member whose lifecycle.state is VOID still gets NO row (the drop itself is unaffected by this rewrite)", () => {
    // A LIVE sibling in the same wave, deliberately: under CR-CRU-147 ruling 5
    // ("a wave with no live work draws no box") a wave holding ONLY this dead
    // member would draw no box at all, and `waveOneRowIds` would throw
    // "fixture bug: no wave box for wave 1" instead of exercising ruling 2's
    // row-drop this test actually pins. The live sibling keeps the box drawn
    // so the two rulings do not entangle.
    const LIVE_SIBLING = entry("CR-B-LIVE", "PENDING");
    const DEAD_VOID = entry("CR-B-3", "PENDING", {
      lifecycle: { state: "VOID", reason: "duplicate", at: 1700000000000 },
    });
    expect(
      waveOneRowIds([LIVE_SIBLING, DEAD_VOID]),
      "a VOID member is dead work under isDeadCr and must draw no row \u2014 only its live sibling should",
    ).toEqual(["CR-B-LIVE"]);
  });
});
