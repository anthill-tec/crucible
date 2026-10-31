// The `bun-console` view codec reads bun's console into an open run's live
// state, batch by batch (CR-CRU-201 §S3, AC3; P5):
//  - the forms: bun's coloured console (`✓ ✗ » ✎` in SGR runs), its plain
//    console (`(pass) (fail) (skip) (todo)`), and the plain console with CRLF
//    line ends — each read to the SAME live state, SGR escapes stripped;
//  - the batches split a line, split a detail block from its `(fail)` line,
//    split a load-error block, and (CRLF) split a `\r` from its `\n`;
//  - the live state: a pass is completed + passed, a fail completed + failed
//    and one failure, a skip or todo completed + pending, a `<file>:` header
//    sets currentFile; each failure is `{id, name, suite, file, message}`:
//      name     the result line's composed `suite > name`,
//      suite    everything before its last ` > `, else `?`,
//      file     the current file, else `?`,
//      message  the married block's `error:` text, first line (absent when
//               no block is married),
//      id       `<suite>::<name>#<n>`, `n` counting that `<suite>::<name>`
//               among the run's live failures from 1;
//  - a load-error block (`# Unhandled error between tests`) is failed + 1 and
//    one failure: name `?`, suite `?`, the file it names, its `error:` line;
//  - a block whose echo names another test marries no one;
//  - a long tail with no result line, over many batches: the decoded offset
//    moves past every whole line after every batch, no batch hands `fill` a
//    byte it already decoded, and `run_live.reader_state` stays within
//    TRACE_LIMIT (8000, src/codecs/bun-console.ts) plus a small fixed margin
//    for the pending block's `error:` line and echo name.
//
// The batches go through `Store#appendRunStream` with codec `bun-console`,
// the store path the stream route calls; the live state is read with
// `Store#runLive`, and the offset and reader state off `run_live`'s own
// columns (`decoded_offset`, `reader_state`, migration v22).
//
// The console text is captured from real bun runs
// (tests/fixtures/bun-console-live-captures.ts, and LEAK_MULTILINE from
// tests/fixtures/bun-console-captures.ts); the long tail alone is built, in
// the captured shape, because its point is its length. Each married message
// is also checked against the record's own reading of the same console
// (`parseBunConsoleFailures`), so the live view and the record agree.
//
// READINGS OF §S3 THIS FILE TAKES (for the orchestrator's ruling):
//  - `n` counts the `<suite>::<name>` among the run's live failures, as §S3
//    defines it. CR-CRU-200's own fallback id counts the test's ordinal among
//    the stream's tests instead, which §S3's "as CR-CRU-200's fallback id does"
//    does not match; this file follows §S3's explicit definition.
//  - a failure's `name` is the composed `suite > name` (so the id of
//    `math > divides` is `math::math > divides#1`), as §S3 states it.
//  - a load-error block does not count as `completed` (§S3 says failed + 1).
//
// INTERFACE CHOICE (named for the ruling): a view codec's `fill` is
//   fill(text: string, offset: number, readerState: string | null, live: ViewLive)
//     → { offset: number; readerState: string | null }
// where `text` is the held stream from the decoded offset `offset` (UTF-8
// bytes) to its end, `readerState` is `run_live.reader_state` as stored,
// `live` is `{completed, passed, failed, pending, currentFile, failures}` with
// the run's failures so far, mutated in place, and the answer is the new
// decoded offset and the reader state to store. `fillRunLive` looks the codec
// up in `viewCodecs` when it fills, so a test can wrap its `fill`. Only the
// first string argument (`text`) is read here.
//
// SAFETY: every Store is ":memory:".
import { describe, test, expect, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import * as codecIndex from "../src/codecs/index.ts";
import { parseBunConsoleFailures } from "../src/codecs/bun-console.ts";
import { resolveLimit } from "../src/limits.ts";
import { Store } from "../src/store.ts";
import type { RunLive, RunLiveFailure } from "../src/types.ts";
import { batchesOf, utf8 } from "./helpers/run-stream-harness.ts";
import { LEAK_MULTILINE } from "./fixtures/bun-console-captures.ts";
import { COLOURED_RUN, CRLF_RUN, PLAIN_RUN } from "./fixtures/bun-console-live-captures.ts";

const VIEW_CODEC = "bun-console";

/** TRACE_LIMIT in src/codecs/bun-console.ts: the cut a pending block's trace is held to. */
const TRACE_LIMIT = 8000;
/** Room in the stored reader state for the pending block's `error:` line, echo name and field names. */
const STATE_MARGIN = 1024;

const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.dispose();
});

interface Run {
  store: Store;
  db: Database;
  runId: string;
}

function openRun(): Run {
  const store = Store.open(":memory:");
  stores.push(store);
  const key = crypto.randomUUID();
  store.addProject({ key, name: "bun-console-view", type: "backend", sutRoot: "/tmp/bun-console-view" });
  const runId = store.startRun(key, "console-reader", { tier: "unit", stack: "bun" }).runId;
  return { store, db: (store as unknown as { db: Database }).db, runId };
}

/** Send `text` cut at `cuts` (character indices) as bun-console batches, each one accepted. */
function sendCut(run: Run, text: string, cuts: readonly number[]): void {
  const limit = resolveLimit("ingest_body_bytes");
  for (const batch of batchesOf(text, cuts)) {
    const outcome = run.store.appendRunStream(run.runId, { codec: VIEW_CODEC, from: batch.from, data: batch.data, limit });
    expect(outcome).toEqual({ ok: true, held: batch.heldAfter });
  }
}

function liveOf(run: Run): RunLive {
  const live = run.store.runLive(run.runId);
  expect(live, "the run holds a live state").not.toBeNull();
  return live as RunLive;
}

function liveColumns(run: Run): { decoded_offset: number; reader_state: string | null } {
  const row = run.db
    .query<{ decoded_offset: number; reader_state: string | null }, [string]>(
      "SELECT decoded_offset, reader_state FROM run_live WHERE run_id = ?",
    )
    .get(run.runId);
  if (row === null) throw new Error(`no run_live row for ${run.runId}`);
  return row;
}

// ── The capture's live state ────────────────────────────────────────────────

/** The married message both `math > divides` failures carry. */
const TO_BE = "expect(received).toBe(expected)";
const LOAD_ERROR = "Cannot find module './no-such-module.ts' from '/tmp/bun-fixture/broken.test.ts'";

/** The three failures the capture's result lines report, in order. */
const RESULT_FAILURES: RunLiveFailure[] = [
  { id: "math::math > divides#1", name: "math > divides", suite: "math", file: "math.test.ts", message: TO_BE },
  { id: "math::math > divides#2", name: "math > divides", suite: "math", file: "more-math.test.ts", message: TO_BE },
  { id: "?::breaks alone#1", name: "breaks alone", suite: "?", file: "top.test.ts", message: "alone boom" },
];

/** The whole capture: 2 passes, 3 fails, a skip, a todo, and the load error in broken.test.ts. */
function expectCaptureState(live: RunLive, text: string): void {
  expect({
    completed: live.completed,
    passed: live.passed,
    failed: live.failed,
    pending: live.pending,
    currentFile: live.currentFile,
  }).toEqual({ completed: 7, passed: 2, failed: 4, pending: 2, currentFile: "broken.test.ts" });
  expect(live).not.toHaveProperty("total");
  expect(live.failures).toHaveLength(4);
  expect(live.failures.slice(0, 3)).toEqual(RESULT_FAILURES);
  const loadError = live.failures[3];
  expect(loadError).toMatchObject({ name: "?", suite: "?", file: "broken.test.ts", message: LOAD_ERROR });
  expect(typeof loadError?.id).toBe("string");
  expect(new Set(live.failures.map((f) => f.id)).size).toBe(4);
  // Nothing kept carries an SGR escape.
  expect(JSON.stringify(live)).not.toContain("\u001b");
  // The live view marries as the record does.
  const record = parseBunConsoleFailures(text);
  expect(record["math > divides"]?.message).toBe(TO_BE);
  expect(record["breaks alone"]?.message).toBe("alone boom");
}

/** The first `(fail)`/`✗` line's start at or after `from`. */
function failLineStart(text: string, marker: string, from = 0): number {
  return text.lastIndexOf("\n", text.indexOf(marker, from)) + 1;
}

/**
 * Cuts that split the first result line, split each married block from its
 * fail line, split a block mid-line, and split the load-error block.
 */
function splittingCuts(text: string, failMarker: string): number[] {
  const moreMath = text.indexOf("more-math.test.ts:");
  const midSecondBlock = text.indexOf("Received", moreMath) + 4;
  const cuts = [
    text.indexOf("adds") + 2,
    failLineStart(text, failMarker),
    midSecondBlock,
    failLineStart(text, failMarker, midSecondBlock),
    text.indexOf("Cannot find module") + 6,
  ];
  for (const cut of cuts) expect(cut).toBeGreaterThan(0);
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/** Cuts every `step` characters. */
function everyCut(text: string, step: number): number[] {
  const cuts: number[] = [];
  for (let at = step; at < text.length; at += step) cuts.push(at);
  return cuts;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("bun-console reads both of bun's console forms, and CRLF, into the same live state", () => {
  test("the plain form, (pass) (fail) (skip) (todo), in batches that split a line and split each block from its (fail) line", () => {
    const run = openRun();
    sendCut(run, PLAIN_RUN, splittingCuts(PLAIN_RUN, "(fail)"));
    expectCaptureState(liveOf(run), PLAIN_RUN);
  });

  test("the coloured form, ✓ ✗ » ✎ in SGR runs, in batches that split a line and split each block from its ✗ line", () => {
    const run = openRun();
    sendCut(run, COLOURED_RUN, splittingCuts(COLOURED_RUN, "\u2717"));
    expectCaptureState(liveOf(run), COLOURED_RUN);
  });

  test("the CRLF capture, in batches that split a line, split each block from its (fail) line, and split a \\r from its \\n", () => {
    const run = openRun();
    const betweenCrAndLf = CRLF_RUN.indexOf("\r\n", CRLF_RUN.indexOf("top.test.ts:")) + 1;
    const cuts = [...new Set([...splittingCuts(CRLF_RUN, "(fail)"), betweenCrAndLf])].sort((a, b) => a - b);
    sendCut(run, CRLF_RUN, cuts);
    expectCaptureState(liveOf(run), CRLF_RUN);
  });

  test("the plain and coloured forms cut every 23 characters read to the same state as one whole batch", () => {
    for (const text of [PLAIN_RUN, COLOURED_RUN]) {
      const whole = openRun();
      sendCut(whole, text, []);
      const chopped = openRun();
      sendCut(chopped, text, everyCut(text, 23));
      expectCaptureState(liveOf(whole), text);
      expect(liveOf(chopped)).toEqual(liveOf(whole));
    }
  });
});

describe("each line moves the live state as §S3 states", () => {
  test("a <file>: header sets currentFile before any result in that file, and the counts so far are the lines read so far", () => {
    const run = openRun();
    const upToTop = PLAIN_RUN.slice(0, PLAIN_RUN.indexOf("top.test.ts:\n") + "top.test.ts:\n".length);
    sendCut(run, upToTop, [upToTop.indexOf("(skip)") + 3]);
    const live = liveOf(run);
    expect(live.currentFile).toBe("top.test.ts");
    expect({ completed: live.completed, passed: live.passed, failed: live.failed, pending: live.pending }).toEqual({
      completed: 5,
      passed: 1,
      failed: 2,
      pending: 2,
    });
    expect(live.failures).toEqual(RESULT_FAILURES.slice(0, 2));
  });

  test("a load-error block alone is one failure with its file and its error line, failed + 1 and nothing completed", () => {
    const run = openRun();
    const from = PLAIN_RUN.indexOf("broken.test.ts:");
    const block = PLAIN_RUN.slice(from, PLAIN_RUN.indexOf("\n 2 pass"));
    sendCut(run, block, [block.indexOf("# Unhandled") + 5, block.indexOf("Cannot find") + 3]);
    const live = liveOf(run);
    expect({ completed: live.completed, passed: live.passed, failed: live.failed, pending: live.pending }).toEqual({
      completed: 0,
      passed: 0,
      failed: 1,
      pending: 0,
    });
    expect(live.failures).toHaveLength(1);
    expect(live.failures[0]).toMatchObject({ name: "?", suite: "?", file: "broken.test.ts", message: LOAD_ERROR });
  });
});

describe("a block whose echo names another test marries no one", () => {
  for (const form of ["plain", "ansi"] as const) {
    test(`${form}: gamma's own block marries gamma; the leaked block echoing gamma, split from delta's fail line, leaves delta with no message`, () => {
      const text = LEAK_MULTILINE[form];
      if (text === undefined) throw new Error(`LEAK_MULTILINE has no ${form} form`);
      const marker = form === "plain" ? "(fail)" : "\u2717";
      const secondFail = failLineStart(text, marker, text.indexOf(marker) + 1);
      const run = openRun();
      sendCut(run, text, [secondFail]);
      const live = liveOf(run);
      expect({ completed: live.completed, failed: live.failed, passed: live.passed, currentFile: live.currentFile }).toEqual({
        completed: 2,
        failed: 2,
        passed: 0,
        currentFile: "b.test.ts",
      });
      expect(live.failures).toEqual([
        {
          id: "?::gamma leaks after failing#1",
          name: "gamma leaks after failing",
          suite: "?",
          file: "b.test.ts",
          message: TO_BE,
        },
        { id: "?::delta fails later#1", name: "delta fails later", suite: "?", file: "b.test.ts" },
      ]);
      expect(live.failures[1]).not.toHaveProperty("message");
    });
  }
});

// ── The long tail ───────────────────────────────────────────────────────────

/** `viewCodecs` off the module namespace — undefined while it is not exported. */
function bunConsoleCodec(): { fill: (...args: unknown[]) => unknown } | undefined {
  const registry = (codecIndex as unknown as { viewCodecs?: Map<string, { fill: (...args: unknown[]) => unknown }> })
    .viewCodecs;
  return registry?.get(VIEW_CODEC);
}

/** A failing test's block whose trace runs to `lines` lines before its `(fail)` line, which ends the stream. */
function longTail(lines: number): string {
  const frames: string[] = [];
  for (let i = 1; i <= lines; i += 1) frames.push(`      at frame${i} (/tmp/bun-fixture/tail.test.ts:${i}:1)\n`);
  return `tail.test.ts:\nerror: long tail boom\n${frames.join("")}(fail) runs long [1.00ms]\n`;
}

describe("a long tail with no result line never re-reads a decoded byte", () => {
  test("over 60+ batches cut mid-line: the decoded offset passes every whole line, fill is handed only bytes past it, the reader state stays within TRACE_LIMIT, and the block still marries its (fail) line", () => {
    const codec = bunConsoleCodec();
    expect(typeof codec?.fill, "viewCodecs holds bun-console with a fill method").toBe("function");
    if (codec === undefined) return;
    const text = longTail(2500);
    expect(utf8(text)).toBeGreaterThan(TRACE_LIMIT * 10);
    const cuts = everyCut(text, 2000);
    expect(cuts.length).toBeGreaterThanOrEqual(60);

    const run = openRun();
    let held = 0;
    const handed: Array<{ bytes: number; held: number; decodedBefore: number }> = [];
    const original = codec.fill;
    codec.fill = function (this: unknown, ...args: unknown[]): unknown {
      const textArg = args.find((arg): arg is string => typeof arg === "string") ?? "";
      handed.push({ bytes: utf8(textArg), held, decodedBefore: liveColumns(run).decoded_offset });
      return original.apply(this, args);
    };
    try {
      const limit = resolveLimit("ingest_body_bytes");
      for (const batch of batchesOf(text, cuts)) {
        held = batch.heldAfter;
        const outcome = run.store.appendRunStream(run.runId, { codec: VIEW_CODEC, from: batch.from, data: batch.data, limit });
        expect(outcome).toEqual({ ok: true, held: batch.heldAfter });
        const sentText = Buffer.from(text, "utf8").subarray(0, batch.heldAfter).toString("utf8");
        const columns = liveColumns(run);
        expect(columns.decoded_offset).toBe(utf8(sentText.slice(0, sentText.lastIndexOf("\n") + 1)));
        expect((columns.reader_state ?? "").length).toBeLessThanOrEqual(TRACE_LIMIT + STATE_MARGIN);
      }
    } finally {
      codec.fill = original;
    }

    expect(handed.length).toBeGreaterThanOrEqual(cuts.length);
    for (const call of handed) expect(call.bytes).toBe(call.held - call.decodedBefore);
    const live = liveOf(run);
    expect({ completed: live.completed, failed: live.failed, currentFile: live.currentFile }).toEqual({
      completed: 1,
      failed: 1,
      currentFile: "tail.test.ts",
    });
    expect(live.failures).toEqual([
      { id: "?::runs long#1", name: "runs long", suite: "?", file: "tail.test.ts", message: "long tail boom" },
    ]);
  });
});
