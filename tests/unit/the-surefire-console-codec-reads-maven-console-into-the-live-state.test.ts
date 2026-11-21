// The `surefire-console` view codec reads maven's surefire and failsafe console
// into an open run's live state, batch by batch. It is a VIEW codec only: the
// run's record stays its JUnit report.
//
// The rules held here, each proved on real `mvn -o -B` captures from surefire
// and failsafe 3.2.5 and 3.5.4 (tests/fixtures/surefire-console, README there):
//  - line filter: only lines starting `[INFO] `, `[ERROR] ` or `[WARNING] `,
//    read after stripping ANSI SGR (the `ansi` capture is maven's own colour);
//  - class counts: a line ending `-- in <class>` SETS that class's counts —
//    run, failed = failures + errors, pending = skipped, passed = the rest; a
//    later line for the same class REPLACES them (the rerun capture); a summary
//    line with no `-- in` is read as nothing;
//  - failures: a `<token> -- Time elapsed: … <<< FAILURE!` or `<<< ERROR!`
//    line is one failure, de-duplicated by suite and name; class and method
//    split at the last `.` before the first `(`; a token that is the class
//    itself is a class-level failure with name `""`; the message is the first
//    non-blank following line that does not start with `[`;
//  - current file: the last `Running` line not yet closed by its `-- in`
//    (forks, the `-T` reactor, a nested class, a forked JVM that dies);
//  - batches: resumed across every byte boundary — mid-line and mid-UTF-8 —
//    to the same live state, the decoded offset moving past whole lines only;
//  - reader state: the per-class counts held compactly, `class → [run,
//    failed, pending]`.
//
// THE HARNESS. `feed` drives the codec's `fill` exactly as the store's live
// fill does: it holds the stream's bytes, hands `fill` the held bytes from the
// decoded offset as UTF-8 text with the reader state the last batch left, and
// rebuilds the live state from what the store keeps between batches — the
// counts, the current file (absent when the codec leaves none) and the
// failures, of which only the ones APPENDED by a fill are kept (the store
// inserts new failure rows and never rewrites an earlier one). So a codec that
// changes a failure after the batch that added it loses the change here as it
// would on the board.
//
// WHAT IS NOT PINNED (the rules leave it open): a failure's `file` and the
// exact form of its `id` (only that ids are distinct), and the current file
// once every `Running` line is closed.
//
// VIEW vs RECORD (the record wins; checked against each capture's own JUnit):
//  - `basic`: a test printed `[INFO] Tests run: 9, … -- in fake.Spoof` to its
//    stdout; the line rule counts it, so the view holds 9 tests the record does
//    not. Without them the view's counts are the record's.
//  - `rerun`: the rerun's last `-- in` line replaces the class's counts, so the
//    view holds the last rerun's counts (run 1, failed 1) while the record
//    holds 3 tests; the failed count is the record's (1). The flake (`flips`)
//    is a failure in the view and a passing test in the record.
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { codecs, viewCodecs, type ViewCodec, type ViewLive } from "../../src/codecs/index.ts";
import type { RunLiveFailure, RunSummary } from "../../src/types.ts";

const VIEW_CODEC = "surefire-console";
const FIXTURES = `${import.meta.dir}/../fixtures/surefire-console`;
const VERSIONS = ["3.2.5", "3.5.4"] as const;
type Version = (typeof VERSIONS)[number];

function capture(version: Version, name: string): Buffer {
  return readFileSync(`${FIXTURES}/${version}/${name}.txt`);
}

function surefireConsole(): ViewCodec {
  const codec = viewCodecs.get(VIEW_CODEC);
  if (codec === undefined) throw new Error(`viewCodecs holds no ${VIEW_CODEC} view codec`);
  return codec;
}

// ── The harness: the store's live fill, batch by batch ──────────────────────

/** What the store keeps of an open run's live state between batches. */
interface Stored {
  completed: number;
  passed: number;
  failed: number;
  pending: number;
  currentFile: string | null;
  failures: RunLiveFailure[];
}

interface Feed {
  held: Buffer;
  decoded: number;
  readerState: string | null;
  stored: Stored;
  /** Each fill whose answered offset was not the end of the held stream's last whole line. */
  offsetFaults: string[];
  fills: number;
}

function openFeed(): Feed {
  return {
    held: Buffer.alloc(0),
    decoded: 0,
    readerState: null,
    stored: { completed: 0, passed: 0, failed: 0, pending: 0, currentFile: null, failures: [] },
    offsetFaults: [],
    fills: 0,
  };
}

/** A failure as a store row reads it back: a null message or type is left out. */
function asStored(f: RunLiveFailure): RunLiveFailure {
  return {
    id: f.id,
    name: f.name,
    suite: f.suite,
    file: f.file,
    ...(f.message !== undefined && f.message !== null ? { message: f.message } : {}),
    ...(f.type !== undefined && f.type !== null ? { type: f.type } : {}),
  };
}

/** Append `bytes` to the held stream and fill from the decoded offset, as the store does on a batch. */
function append(codec: ViewCodec, feed: Feed, bytes: Buffer): void {
  feed.held = Buffer.concat([feed.held, bytes]);
  const pending = feed.held.subarray(feed.decoded);
  const live: ViewLive = {
    completed: feed.stored.completed,
    passed: feed.stored.passed,
    failed: feed.stored.failed,
    pending: feed.stored.pending,
    ...(feed.stored.currentFile !== null ? { currentFile: feed.stored.currentFile } : {}),
    failures: feed.stored.failures.map((f) => ({ ...f })),
  };
  const known = live.failures.length;
  const read = codec.fill(pending.toString("utf8"), feed.decoded, feed.readerState, live);
  feed.fills += 1;
  const lastLineEnd = pending.lastIndexOf(0x0a);
  const expected = lastLineEnd === -1 ? feed.decoded : feed.decoded + lastLineEnd + 1;
  if (read.offset !== expected && feed.offsetFaults.length < 5) {
    feed.offsetFaults.push(`held ${feed.held.length}: answered ${read.offset}, past the last whole line is ${expected}`);
  }
  feed.stored = {
    completed: live.completed,
    passed: live.passed,
    failed: live.failed,
    pending: live.pending,
    currentFile: live.currentFile ?? null,
    failures: [...feed.stored.failures, ...live.failures.slice(known).map(asStored)],
  };
  feed.decoded = read.offset;
  feed.readerState = read.readerState;
}

/** `bytes` sent as batches cut at the byte offsets `cuts` (ascending, inside the stream). */
function feedCut(codec: ViewCodec, bytes: Buffer, cuts: readonly number[]): Feed {
  const feed = openFeed();
  const points = [0, ...cuts, bytes.length];
  for (let i = 0; i + 1 < points.length; i += 1) append(codec, feed, bytes.subarray(points[i], points[i + 1]));
  return feed;
}

function feedWhole(codec: ViewCodec, bytes: Buffer): Feed {
  return feedCut(codec, bytes, []);
}

/** Every byte boundary of `bytes`: the stream sent one byte per batch. */
function everyByte(bytes: Buffer): number[] {
  return Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
}

/** The cuts that split a multibyte UTF-8 character of `bytes` (between its lead and continuation bytes). */
function midCharacterCuts(bytes: Buffer): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < bytes.length; i += 1) if (((bytes[i] ?? 0) & 0xc0) === 0x80) cuts.push(i);
  return cuts;
}

/** The byte offset just past the line holding the `occurrence`-th (from 1) match of `marker`. */
function pastLineOf(bytes: Buffer, marker: string, occurrence = 1): number {
  let at = -1;
  for (let n = 0; n < occurrence; n += 1) {
    at = bytes.indexOf(marker, at + 1, "utf8");
    if (at === -1) throw new Error(`the capture holds no occurrence ${occurrence} of ${JSON.stringify(marker)}`);
  }
  const end = bytes.indexOf(0x0a, at);
  return end === -1 ? bytes.length : end + 1;
}

/** The failures as the rules state them: suite, name and message (absent when none). */
function failuresOf(stored: Stored): Array<{ suite: string; name: string; message?: string }> {
  return stored.failures.map((f) => ({
    suite: f.suite,
    name: f.name,
    ...(f.message !== undefined ? { message: f.message } : {}),
  }));
}

function countsOf(stored: Stored): { completed: number; passed: number; failed: number; pending: number } {
  return { completed: stored.completed, passed: stored.passed, failed: stored.failed, pending: stored.pending };
}

/** The `[run, failed, pending]` held for `cls` anywhere in the parsed reader state, else undefined. */
function heldCounts(state: unknown, cls: string): unknown {
  if (state === null || typeof state !== "object") return undefined;
  if (!Array.isArray(state)) {
    const record = state as Record<string, unknown>;
    if (Object.hasOwn(record, cls)) return record[cls];
  }
  for (const value of Object.values(state as Record<string, unknown>)) {
    const found = heldCounts(value, cls);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parsedState(feed: Feed): unknown {
  expect(typeof feed.readerState, "the reader state is held as text").toBe("string");
  try {
    return JSON.parse(feed.readerState ?? "");
  } catch {
    throw new Error(`the reader state is not JSON (${(feed.readerState ?? "").length} chars)`);
  }
}

// ── What each capture reads to, by the rules ────────────────────────────────

const AF = "org.opentest4j.AssertionFailedError: ";

interface Expected {
  counts: { completed: number; passed: number; failed: number; pending: number };
  classes: Record<string, [number, number, number]>;
  failures: Array<{ suite: string; name: string; message?: string }>;
}

function basicExpected(version: Version): Expected {
  return {
    // fake.Spoof 9 + SpoofTest 1 + ParamTest 4 + InitTest 1 + CalcTest$Rounding 6 + CalcTest 0.
    counts: { completed: 21, passed: 14, failed: 6, pending: 1 },
    classes: {
      "fake.Spoof": [9, 0, 0],
      "basic.SpoofTest": [1, 0, 0],
      "basic.ParamTest": [4, 2, 0],
      "basic.InitTest": [1, 1, 0],
      "basic.CalcTest$Rounding": [6, 3, 1],
      "basic.CalcTest": [0, 0, 0],
    },
    failures: [
      { suite: "basic.ParamTest", name: "named(String)[2]", message: `${AF}length of c(d) ==> expected: <3> but was: <4>` },
      { suite: "basic.ParamTest", name: "small(double)[2]", message: `${AF}too big: 2.5 ==> expected: <true> but was: <false>` },
      { suite: "basic.InitTest", name: "", message: "java.lang.IllegalStateException: no database" },
      {
        suite: "basic.CalcTest",
        name: "subtracts",
        message: `${AF}subtraction is off: \u00bd \u2260 1 ==> expected: <1> but was: <2>`,
      },
      { suite: "basic.CalcTest", name: "divides", message: "java.lang.IllegalStateException: divide by zero" },
      // 3.5.4 names the nested class's test by its outer class; 3.2.5 by the nested class.
      {
        suite: version === "3.5.4" ? "basic.CalcTest" : "basic.CalcTest$Rounding",
        name: "roundsUp",
        message: `${AF}rounding is off ==> expected: <4> but was: <3>`,
      },
    ],
  };
}

const RERUN: Expected = {
  counts: { completed: 1, passed: 0, failed: 1, pending: 0 },
  classes: { "rerun.FlakyTest": [1, 1, 0] },
  failures: [
    { suite: "rerun.FlakyTest", name: "broken", message: `${AF}always broken` },
    { suite: "rerun.FlakyTest", name: "flips", message: `${AF}first call fails ==> expected: <true> but was: <false>` },
  ],
};

const FAILSAFE: Expected = {
  counts: { completed: 4, passed: 2, failed: 1, pending: 1 },
  classes: { "it.UnitTest": [1, 0, 0], "it.WidgetIT": [3, 1, 1] },
  failures: [{ suite: "it.WidgetIT", name: "breaks", message: `${AF}widget broke` }],
};

function forkFailure(c: string): { suite: string; name: string; message: string } {
  return { suite: `forks.${c}Test`, name: "fails", message: `${AF}${c} failed` };
}

const FORK_CLASSES: Record<string, [number, number, number]> = {
  "forks.AlphaTest": [2, 1, 0],
  "forks.BetaTest": [2, 1, 0],
  "forks.GammaTest": [2, 1, 0],
  "forks.DeltaTest": [2, 1, 0],
};

/** The order the capture's fork failure lines arrive in. */
const FORKS_ORDER: Record<Version, string[]> = {
  "3.2.5": ["Delta", "Gamma", "Beta", "Alpha"],
  "3.5.4": ["Gamma", "Delta", "Alpha", "Beta"],
};
const REACTOR_ORDER: Record<Version, string[]> = {
  "3.2.5": ["Gamma", "Delta", "Beta", "Alpha"],
  "3.5.4": ["Delta", "Gamma", "Beta", "Alpha"],
};

function forksExpected(version: Version): Expected {
  return {
    counts: { completed: 8, passed: 4, failed: 4, pending: 0 },
    classes: FORK_CLASSES,
    failures: FORKS_ORDER[version].map(forkFailure),
  };
}

function reactorExpected(version: Version): Expected {
  return {
    counts: { completed: 12, passed: 6, failed: 5, pending: 1 },
    classes: { ...FORK_CLASSES, "it.UnitTest": [1, 0, 0], "it.WidgetIT": [3, 1, 1] },
    failures: [...FAILSAFE.failures, ...REACTOR_ORDER[version].map(forkFailure)],
  };
}

const CRASH: Expected = { counts: { completed: 0, passed: 0, failed: 0, pending: 0 }, classes: {}, failures: [] };

function expectedOf(version: Version, name: string): Expected {
  switch (name) {
    case "basic":
    case "ansi":
      return basicExpected(version);
    case "rerun":
      return RERUN;
    case "failsafe":
      return FAILSAFE;
    case "forks":
      return forksExpected(version);
    case "reactor":
      return reactorExpected(version);
    case "crash":
      return CRASH;
    default:
      throw new Error(`no expectation for ${name}`);
  }
}

const CAPTURES = ["basic", "ansi", "rerun", "failsafe", "forks", "reactor", "crash"] as const;

/** A point in a capture — just past the line holding `marker` — and the live state there. */
interface Checkpoint {
  marker: string;
  occurrence?: number;
  currentFile: string;
  completed: number;
  failed: number;
}

const CHECKPOINTS: Record<Version, Record<string, Checkpoint[]>> = {
  "3.2.5": {
    basic: [
      { marker: "Running basic.ParamTest", currentFile: "basic.ParamTest", completed: 10, failed: 0 },
      { marker: "Running basic.CalcTest$Rounding", currentFile: "basic.CalcTest$Rounding", completed: 15, failed: 3 },
      // The nested class closes; its outer class's `Running` is still open.
      { marker: "-- in basic.CalcTest$Rounding", currentFile: "basic.CalcTest", completed: 21, failed: 6 },
    ],
    forks: [
      { marker: "Running forks.DeltaTest", currentFile: "forks.DeltaTest", completed: 0, failed: 0 },
      { marker: "-- in forks.GammaTest", currentFile: "forks.DeltaTest", completed: 2, failed: 1 },
      { marker: "Running forks.AlphaTest", currentFile: "forks.AlphaTest", completed: 4, failed: 2 },
      { marker: "-- in forks.BetaTest", currentFile: "forks.AlphaTest", completed: 6, failed: 3 },
    ],
    reactor: [
      { marker: "Running it.WidgetIT", currentFile: "it.WidgetIT", completed: 1, failed: 0 },
      { marker: "-- in it.WidgetIT", currentFile: "forks.DeltaTest", completed: 4, failed: 1 },
      { marker: "-- in forks.GammaTest", currentFile: "forks.DeltaTest", completed: 6, failed: 2 },
      { marker: "Running forks.AlphaTest", currentFile: "forks.AlphaTest", completed: 8, failed: 3 },
    ],
    rerun: [{ marker: "Running rerun.FlakyTest", occurrence: 2, currentFile: "rerun.FlakyTest", completed: 3, failed: 2 }],
    failsafe: [{ marker: "Running it.WidgetIT", currentFile: "it.WidgetIT", completed: 1, failed: 0 }],
  },
  "3.5.4": {
    basic: [
      { marker: "Running basic.ParamTest", currentFile: "basic.ParamTest", completed: 10, failed: 0 },
      { marker: "Running basic.CalcTest$Rounding", currentFile: "basic.CalcTest$Rounding", completed: 15, failed: 3 },
      { marker: "-- in basic.CalcTest$Rounding", currentFile: "basic.CalcTest", completed: 21, failed: 6 },
    ],
    forks: [
      { marker: "Running forks.GammaTest", currentFile: "forks.GammaTest", completed: 0, failed: 0 },
      { marker: "-- in forks.DeltaTest", currentFile: "forks.GammaTest", completed: 2, failed: 1 },
      { marker: "Running forks.AlphaTest", currentFile: "forks.AlphaTest", completed: 4, failed: 2 },
      { marker: "-- in forks.AlphaTest", currentFile: "forks.BetaTest", completed: 6, failed: 3 },
    ],
    reactor: [
      { marker: "Running it.WidgetIT", currentFile: "it.WidgetIT", completed: 1, failed: 0 },
      { marker: "-- in it.WidgetIT", currentFile: "forks.DeltaTest", completed: 4, failed: 1 },
      { marker: "-- in forks.DeltaTest", currentFile: "forks.GammaTest", completed: 6, failed: 2 },
      { marker: "Running forks.AlphaTest", currentFile: "forks.AlphaTest", completed: 8, failed: 3 },
    ],
    rerun: [{ marker: "Running rerun.FlakyTest", occurrence: 2, currentFile: "rerun.FlakyTest", completed: 3, failed: 2 }],
    failsafe: [{ marker: "Running it.WidgetIT", currentFile: "it.WidgetIT", completed: 1, failed: 0 }],
  },
};

// ═══════════════════════════════════════════════════════════════════════════

describe("each real capture reads to the live state its lines state", () => {
  for (const version of VERSIONS) {
    for (const name of CAPTURES) {
      test(`surefire ${version} ${name}: the counts, the failures with their messages, and each class's counts held as [run, failed, pending]`, () => {
        const codec = surefireConsole();
        const expected = expectedOf(version, name);
        const feed = feedWhole(codec, capture(version, name));
        expect(feed.offsetFaults).toEqual([]);
        expect(countsOf(feed.stored)).toEqual(expected.counts);
        expect(failuresOf(feed.stored)).toEqual(expected.failures);
        const ids = feed.stored.failures.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        const state = parsedState(feed);
        for (const [cls, counts] of Object.entries(expected.classes)) {
          expect(heldCounts(state, cls), `the reader state holds ${cls}`).toEqual(counts);
        }
      });
    }
  }
});

describe("the current file is the last Running line not yet closed by its -- in", () => {
  for (const version of VERSIONS) {
    for (const [name, points] of Object.entries(CHECKPOINTS[version])) {
      test(`surefire ${version} ${name}: at each point the current file and the counts of the classes closed so far`, () => {
        const codec = surefireConsole();
        const bytes = capture(version, name as (typeof CAPTURES)[number]);
        const seen = points.map((p) => {
          const stored = feedWhole(codec, bytes.subarray(0, pastLineOf(bytes, p.marker, p.occurrence))).stored;
          return { at: p.marker, currentFile: stored.currentFile, completed: stored.completed, failed: stored.failed };
        });
        expect(seen).toEqual(
          points.map((p) => ({ at: p.marker, currentFile: p.currentFile, completed: p.completed, failed: p.failed })),
        );
      });
    }

    test(`surefire ${version} crash: the forked JVM dies, so its class stays the current file and is never counted`, () => {
      const feed = feedWhole(surefireConsole(), capture(version, "crash"));
      expect(feed.stored.currentFile).toBe("crash.ExitTest");
      expect(countsOf(feed.stored)).toEqual(CRASH.counts);
      expect(feed.stored.failures).toEqual([]);
    });
  }
});

describe("a later -- in line for a class replaces its counts", () => {
  for (const version of VERSIONS) {
    test(`surefire ${version} rerun: three -- in lines for rerun.FlakyTest (3/2, 2/1, 1/1) leave its last counts, and each repeated failure line is one failure`, () => {
      const codec = surefireConsole();
      const bytes = capture(version, "rerun");
      const first = feedWhole(codec, bytes.subarray(0, pastLineOf(bytes, "-- in rerun.FlakyTest", 1))).stored;
      const second = feedWhole(codec, bytes.subarray(0, pastLineOf(bytes, "-- in rerun.FlakyTest", 2))).stored;
      const whole = feedWhole(codec, bytes).stored;
      expect([countsOf(first), countsOf(second), countsOf(whole)]).toEqual([
        { completed: 3, passed: 1, failed: 2, pending: 0 },
        { completed: 2, passed: 1, failed: 1, pending: 0 },
        { completed: 1, passed: 0, failed: 1, pending: 0 },
      ]);
      expect(whole.failures.filter((f) => f.name === "broken")).toHaveLength(1);
      expect(whole.failures).toHaveLength(2);
    });
  }
});

describe("the view against the capture's own JUnit record", () => {
  async function recordOf(version: Version, files: string[]): Promise<RunSummary> {
    const junit = codecs.get("junit");
    if (junit === undefined) throw new Error("the report registry holds no junit codec");
    const sum: RunSummary = { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 0 };
    for (const file of files) {
      const run = await junit.parse(readFileSync(`${FIXTURES}/${version}/${file}`, "utf8"));
      sum.total += run.summary.total;
      sum.passed += run.summary.passed;
      sum.failed += run.summary.failed;
      sum.pending += run.summary.pending;
    }
    return sum;
  }

  for (const version of VERSIONS) {
    test(`surefire ${version} basic: without the 9 tests a test's stdout spoofed under fake.Spoof, the view's counts are the record's`, async () => {
      // 3.2.5 writes the nested class its own report (`basic.CalcTest$Rounding`); 3.5.4 folds it into its outer class's.
      const reports = readdirSync(`${FIXTURES}/${version}`).filter((f) => f.startsWith("basic.") && f.endsWith(".junit.xml"));
      expect(reports.length).toBe(version === "3.2.5" ? 5 : 4);
      const record = await recordOf(version, reports);
      expect({ total: record.total, passed: record.passed, failed: record.failed, pending: record.pending }).toEqual({
        total: 12,
        passed: 5,
        failed: 6,
        pending: 1,
      });
      const view = feedWhole(surefireConsole(), capture(version, "basic")).stored;
      const spoofed = 9;
      expect({
        total: view.completed - spoofed,
        passed: view.passed - spoofed,
        failed: view.failed,
        pending: view.pending,
      }).toEqual({ total: record.total, passed: record.passed, failed: record.failed, pending: record.pending });
    });

    test(`surefire ${version} rerun: the view's failed count is the record's; its run count is the last rerun's, not the record's 3 tests`, async () => {
      const record = await recordOf(version, ["rerun.junit.xml"]);
      expect({ total: record.total, failed: record.failed }).toEqual({ total: 3, failed: 1 });
      const view = feedWhole(surefireConsole(), capture(version, "rerun")).stored;
      expect(view.failed).toBe(record.failed);
      expect(view.completed).toBe(1);
      expect(view.completed).not.toBe(record.total);
    });
  }
});

describe("the ANSI SGR maven colours its lines with is stripped before the line filter", () => {
  for (const version of VERSIONS) {
    test(`surefire ${version}: the coloured capture holds SGR on its prefixes and reads to the same live state as the plain one`, () => {
      const coloured = capture(version, "ansi");
      expect(coloured.includes("[\u001b[1;34mINFO\u001b[m] Running basic.\u001b[1mSpoofTest\u001b[m", 0, "utf8")).toBe(true);
      const codec = surefireConsole();
      const fromColour = feedWhole(codec, coloured).stored;
      const fromPlain = feedWhole(codec, capture(version, "basic")).stored;
      expect(countsOf(fromColour)).toEqual(basicExpected(version).counts);
      expect(failuresOf(fromColour)).toEqual(failuresOf(fromPlain));
    });
  }
});

describe("the line filter, the split and the de-duplication on lines in the captured shape", () => {
  // Lines in the shape the captures hold, for the cases no capture shows: a
  // counted line without a level prefix, with another prefix, without the
  // space, indented; a skipped-only class surefire states under [WARNING]; a
  // method whose parameter type is dotted; a failure line repeated.
  const LINES = [
    "WARNING: A terminally deprecated method in sun.misc.Unsafe has been called",
    "Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in plain.Bare",
    "[DEBUG] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in debug.Bare",
    "[INFO]Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in nospace.Bare",
    "  [INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.1 s -- in indented.Bare",
    "[ERROR] plain.Bare.hidden -- Time elapsed: 0.001 s <<< FAILURE! (not a failure line: it does not end the line)",
    "[INFO] Running warn.Skipped",
    "[WARNING] Tests run: 2, Failures: 0, Errors: 0, Skipped: 2, Time elapsed: 0.1 s -- in warn.Skipped",
    "[INFO] Running pkg.Calc",
    "[ERROR] Tests run: 3, Failures: 1, Errors: 1, Skipped: 0, Time elapsed: 0.1 s <<< FAILURE! -- in pkg.Calc",
    "[ERROR] pkg.Calc.m(java.lang.String)[1] -- Time elapsed: 0.001 s <<< FAILURE!",
    "",
    `${AF}dotted param`,
    "\tat pkg.Calc.m(Calc.java:3)",
    "",
    "[ERROR] pkg.Calc.n -- Time elapsed: 0.001 s <<< ERROR!",
    "java.lang.RuntimeException: boom",
    "\tat pkg.Calc.n(Calc.java:4)",
    "",
    "[ERROR] pkg.Calc.m(java.lang.String)[1] -- Time elapsed: 0.001 s <<< FAILURE!",
    `${AF}dotted param`,
    "\tat pkg.Calc.m(Calc.java:3)",
    "",
    "[INFO] Tests run: 5, Failures: 1, Errors: 1, Skipped: 2",
    "[INFO] ",
  ];

  test("only [INFO] , [ERROR] and [WARNING] lines count; a dotted parameter type splits at the first (; a repeated failure is one failure", () => {
    const feed = feedWhole(surefireConsole(), Buffer.from(`${LINES.join("\n")}\n`, "utf8"));
    expect(countsOf(feed.stored)).toEqual({ completed: 5, passed: 1, failed: 2, pending: 2 });
    expect(failuresOf(feed.stored)).toEqual([
      { suite: "pkg.Calc", name: "m(java.lang.String)[1]", message: `${AF}dotted param` },
      { suite: "pkg.Calc", name: "n", message: "java.lang.RuntimeException: boom" },
    ]);
    const state = parsedState(feed);
    expect(heldCounts(state, "warn.Skipped")).toEqual([2, 0, 2]);
    expect(heldCounts(state, "pkg.Calc")).toEqual([3, 2, 0]);
    for (const bare of ["plain.Bare", "debug.Bare", "nospace.Bare", "indented.Bare"]) {
      expect(heldCounts(state, bare), `${bare} is not counted`).toBeUndefined();
    }
  });
});

describe("the codec resumes across batch boundaries to the same live state", () => {
  for (const version of VERSIONS) {
    for (const name of CAPTURES) {
      test(`surefire ${version} ${name}: sent one byte per batch, it reads to the whole capture's live state, the offset passing whole lines only`, () => {
        const codec = surefireConsole();
        const bytes = capture(version, name);
        const whole = feedWhole(codec, bytes);
        const byByte = feedCut(codec, bytes, everyByte(bytes));
        expect(byByte.fills).toBe(bytes.length);
        expect(byByte.offsetFaults).toEqual([]);
        expect(byByte.decoded).toBe(bytes.lastIndexOf(0x0a) + 1);
        expect(byByte.stored).toEqual(whole.stored);
        expect(countsOf(byByte.stored)).toEqual(expectedOf(version, name).counts);
      });
    }

    test(`surefire ${version} basic: cut in two at every split of a multibyte character and around every failure line, it reads to the whole capture's live state`, () => {
      const codec = surefireConsole();
      const bytes = capture(version, "basic");
      const whole = feedWhole(codec, bytes).stored;
      const mid = midCharacterCuts(bytes);
      expect(mid.length).toBeGreaterThanOrEqual(2);
      const around: number[] = [];
      for (let at = bytes.indexOf("<<< "); at !== -1; at = bytes.indexOf("<<< ", at + 1)) {
        const start = bytes.lastIndexOf(0x0a, at) + 1;
        const end = bytes.indexOf(0x0a, at) + 1;
        for (const p of [start - 1, start, start + 1, at, end - 1, end, end + 1, end + 2]) around.push(p);
      }
      const cuts = [...new Set([...mid, ...around])].filter((c) => c > 0 && c < bytes.length);
      const differing: number[] = [];
      for (const cut of cuts) {
        const feed = feedCut(codec, bytes, [cut]);
        if (feed.offsetFaults.length > 0 || !Bun.deepEquals(feed.stored, whole)) differing.push(cut);
      }
      expect(cuts.length).toBeGreaterThan(40);
      expect(differing.slice(0, 5)).toEqual([]);
    });
  }
});

describe("the reader state stays compact as the classes grow", () => {
  test("3000 closed classes: the reader state holds each class's counts in no more than its name and 16 characters", () => {
    const names = Array.from({ length: 3000 }, (_, i) => `com.example.module${i % 7}.Class${i}Test`);
    const text = names
      .map((n, i) => {
        const failed = i % 5 === 0 ? 1 : 0;
        return `[INFO] Running ${n}\n[INFO] Tests run: 4, Failures: ${failed}, Errors: 0, Skipped: 1, Time elapsed: 0.01 s -- in ${n}\n`;
      })
      .join("");
    const feed = feedCut(surefireConsole(), Buffer.from(text, "utf8"), [Math.floor(text.length / 3), Math.floor((2 * text.length) / 3)]);
    expect(countsOf(feed.stored)).toEqual({ completed: 12000, passed: 8400, failed: 600, pending: 3000 });
    const budget = names.reduce((sum, n) => sum + n.length + 16, 0) + 1024;
    expect((feed.readerState ?? "").length).toBeLessThanOrEqual(budget);
    const state = parsedState(feed);
    expect(heldCounts(state, names[0] ?? "")).toEqual([4, 1, 1]);
    expect(heldCounts(state, names[2999] ?? "")).toEqual([4, 0, 1]);
  });
});
