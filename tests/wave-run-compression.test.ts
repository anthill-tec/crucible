// CR-CRU-096 §S7/AC22/AC22a/AC22b — `compressWaveRuns`, the delivered
// summary's wave-label reading, tested DIRECTLY.
//
// Spec: docs/changes/CR-CRU-096-zone-2-drifts-from-the-approved-design.md
//       §S7, AC22 (a contiguous run compresses), AC22a (a run of TWO
//       compresses), AC22b (the labels are a SET, rendered in ascending
//       numeric order, and a label with no numeric reading joins no run and
//       follows in first-appearance order).
//
// WHY THIS FILE EXISTS. Every rendered fixture that reaches this function
// (tests/roadmap-flow-axis.test.ts) declares waves that are ALREADY ascending
// and ALREADY numeric, so the DOM only ever exercises the contiguity half of
// the rule. AC22b's two other clauses — the ascending re-ordering of a set
// that arrives out of order, and the no-numeric-reading label — are reachable
// in production (`wave` is a free string and the boxes are in first-appearance
// order) but unreachable from any board fixture, which is exactly the shape of
// input a direct unit test states best.
//
// SCOPE — this ONE export. The zone-2 render that consumes it
// (`focusedReleaseView().waveRuns`, the `waves N–M` summary line) is
// tests/roadmap-flow-axis.test.ts's; the roll-up header is
// tests/roadmap-wave-rollup.test.ts's. AC29 — every label here is synthetic.
import { describe, test, expect } from "bun:test";
import * as AppLogic from "../public/app-logic.mjs";

/** The ambient tests/app-logic.d.ts predates this export, so the module is
 *  cast to the one boundary under test (the house pattern, shared with
 *  tests/roadmap-release-focus.test.ts:153). */
const Logic = AppLogic as unknown as {
  compressWaveRuns: (labels: unknown) => string[];
};

/** The artifact's own glyph (`.lavish/crucible-workflow-flowchart.html` §2):
 *  an EN DASH, spelled by codepoint so a hyphen can never masquerade as one in
 *  this file's source. */
const EN = "\u2013";

describe("CR-CRU-096 §S7/AC22/AC22a — a contiguous run compresses; a gap renders the list", () => {
  test("four consecutive waves render as ONE run, endpoint to endpoint", () => {
    expect(Logic.compressWaveRuns(["1", "2", "3", "4"])).toEqual([`1${EN}4`]);
  });

  test("AC22a — a run of TWO compresses, because AC22 states the rule on contiguity alone", () => {
    expect(Logic.compressWaveRuns(["1", "2"])).toEqual([`1${EN}2`]);
  });

  test("a gap breaks the run into the MAXIMAL runs either side of it", () => {
    // 1,2 is one run and 4,5,6,7 is another — so the answer states two spans
    // and never a single `1–7` the release did not span. A run is maximal, so
    // 4 is not left standing beside 5–7.
    expect(Logic.compressWaveRuns(["1", "2", "4", "5", "6", "7"])).toEqual([
      `1${EN}2`,
      `4${EN}7`,
    ]);
    // A wave isolated by gaps on BOTH sides renders alone, between the spans.
    expect(Logic.compressWaveRuns(["1", "2", "4", "6", "7"])).toEqual([
      `1${EN}2`,
      "4",
      `6${EN}7`,
    ]);
  });

  test("a lone wave renders as ITSELF, with no dash and no invented endpoint", () => {
    expect(Logic.compressWaveRuns(["7"])).toEqual(["7"]);
    expect(Logic.compressWaveRuns([])).toEqual([]);
  });
});

describe("CR-CRU-096 §S7/AC22b — the labels are a SET in ASCENDING numeric order", () => {
  test("labels arriving out of order are read ascending, so first-appearance order does not decide the span", () => {
    // The input's first-appearance order is 3,1,2 — the order a board whose
    // wave boxes appear in authored order really can publish. Read as a set in
    // ascending order these are one contiguous run; read in arrival order they
    // are three items, and `3–3`/`1–2` is what a naive pass would answer.
    expect(Logic.compressWaveRuns(["3", "1", "2"])).toEqual([`1${EN}3`]);
  });

  test("the reading is the label's INTEGER, not its first character: 9 precedes 10 and the two are a run", () => {
    // A lexicographic pass puts "10" before "9" and finds no run at all.
    expect(Logic.compressWaveRuns(["10", "9"])).toEqual([`9${EN}10`]);
    expect(Logic.compressWaveRuns(["11", "2", "10", "3"])).toEqual([`2${EN}3`, `10${EN}11`]);
  });

  test("the run's endpoints are the declared LABELS, never a re-spelling of their readings", () => {
    // `Wave 2` … `Wave 4` read 2,3,4 — one run — and the rendered span must
    // quote the release's own spelling of its endpoints.
    expect(Logic.compressWaveRuns(["Wave 3", "Wave 2", "Wave 4"])).toEqual([
      `Wave 2${EN}Wave 4`,
    ]);
  });

  test("duplicates COLLAPSE — a release spanned a wave or it did not, and cannot have spanned it twice", () => {
    expect(Logic.compressWaveRuns(["2", "2", "1", "1", "2"])).toEqual([`1${EN}2`]);
    // Collapsing is what makes the run contiguous rather than a repeated
    // reading opening a second run beside the first.
    expect(Logic.compressWaveRuns(["5", "5", "5"])).toEqual(["5"]);
  });

  test("a label with NO numeric reading joins no run and FOLLOWS the numbered ones in first-appearance order", () => {
    expect(Logic.compressWaveRuns(["alpha", "1", "2"])).toEqual([`1${EN}2`, "alpha"]);
    // Two of them keep their own arrival order relative to each other — a set
    // with no numeric reading has no other order to present it in.
    expect(Logic.compressWaveRuns(["beta", "3", "alpha", "1", "2"])).toEqual([
      `1${EN}3`,
      "beta",
      "alpha",
    ]);
    // …and on their own they are simply the list, unchanged.
    expect(Logic.compressWaveRuns(["beta", "alpha"])).toEqual(["beta", "alpha"]);
  });

  test("an unusable label is no wave at all: the empty string and every non-string are dropped, and a non-array reads as none", () => {
    // `wave` is a free string on the wire (`src/types.ts:392`), and the empty
    // string is how the wire declares NO wave — a summary that rendered it
    // would state a wave the release never spanned.
    expect(Logic.compressWaveRuns(["1", "", "2"])).toEqual([`1${EN}2`]);
    // A DROPPED label does not bridge a run: the numeric `2` is not a string
    // label, so the surviving 1 and 3 are two spans and not `1–3`.
    expect(Logic.compressWaveRuns(["1", null, undefined, 2, {}, "3"])).toEqual(["1", "3"]);
    expect(Logic.compressWaveRuns(undefined)).toEqual([]);
    expect(Logic.compressWaveRuns(null)).toEqual([]);
    expect(Logic.compressWaveRuns("1,2")).toEqual([]);
  });
});
