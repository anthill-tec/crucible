// The live state of an open run, filled from its test stream batch by batch
// (§S4): `Store#runLive` answers the counts, the runner's `total` (absent for
// none and for 0), the last non-blank `currentFile` and every failure in
// stream order, each with §S4's fields:
//   - `id`: the test's own non-blank `id`, else `<suite>::<name>#<n>`, `n`
//     being the test's 1-based ordinal among the stream's tests;
//   - `suite` and `file`: `?` when blank (the leaf `name` too, as JUnit names it);
//   - `message`: the first line of `failureOf`'s message (which falls back to
//     the trace's first non-blank line), and `type` the failure's type, each
//     present only when non-empty.
// A test line cut across two batches is counted once, when the batch that
// completes it lands; a matching resend of bytes already held counts nothing.
// CR-CRU-223's readers serve the state unchanged: `GET /api/v2/runs/<runId>/live`
// and the open-run brief's `live` on the events feed. A run that has not
// streamed answers `null` and 404, as CR-CRU-223 left it.
//
// These are REGRESSION PINS over the fill cycle 821 built (`fillRunLive`,
// `runLiveOf` in src/run-stream.ts). Each test names, in its own comment, the
// regression it fails against.
//
// Every batch, read and close goes through the real HTTP routes on a real
// server (port 0, ":memory:"); the run is opened with `POST /api/v2/runs/start`.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import type { RunLive } from "../src/types.ts";
import {
  base,
  batchesOf,
  bootOn,
  eventLine,
  getJson,
  openRun,
  readyProject,
  sendAll,
  sendBatch,
  utf8,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "live-fill-streamer";

interface Streamed {
  handle: ServerHandle;
  key: string;
  runId: string;
}

/** A real server, a project with the streaming agent registered, and an open run. */
async function openStreamingRun(): Promise<Streamed> {
  const handle = bootOn();
  handles.push(handle);
  const key = await readyProject(handle, [AGENT], "live-fill");
  const runId = await openRun(handle, key, AGENT, { stack: "bun", tier: "unit" });
  return { handle, key, runId };
}

/** `text` sent as the batches `cuts` makes of it, each answered 200 with the bytes held. */
async function streamed(text: string, cuts: readonly number[] = []): Promise<Streamed> {
  const s = await openStreamingRun();
  await sendAll(s.handle, s.runId, s.key, AGENT, batchesOf(text, cuts));
  return s;
}

// ── The stream every field case is read from ───────────────────────────────

const L_START = eventLine({ event: "run-start", total: 5 });
const L_PASS = eventLine({
  event: "test-end",
  id: "t-1",
  name: "parses",
  suite: "Parser",
  file: "src/a.test.ts",
  status: "pass",
  duration_ms: 3,
});
/** A failure with its own id, a two-line message and a type. */
const L_FAIL_OWN_ID = eventLine({
  event: "test-end",
  id: "t-2",
  name: "rejects",
  suite: "Parser",
  file: "src/b.test.ts",
  status: "fail",
  duration_ms: 4,
  failure: { message: "expected 1\nreceived 2", type: "AssertionError", trace: "expected 1\n  at Parser.rejects" },
});
/** A failure with a blank id, a blank suite and file, and only a trace: its message is the trace's first non-blank line. */
const L_FAIL_BLANKS = eventLine({
  event: "test-end",
  id: "   ",
  name: "retries",
  suite: "  ",
  file: "",
  status: "fail",
  duration_ms: 5,
  failure: { trace: "\n   \n  boom at the relay\n  at Relay.retries" },
});
const L_PENDING = eventLine({
  event: "test-end",
  id: "t-4",
  name: "later",
  suite: "Lexer",
  file: "src/c.test.ts",
  status: "pending",
});
/** A failure with no id, a blank name, and a blank message and type: no `message` and no `type` key. */
const L_FAIL_BARE = eventLine({
  event: "test-end",
  name: " ",
  suite: "Lexer",
  file: "src/d.test.ts",
  status: "fail",
  failure: { message: "   ", type: "  " },
});
/** A pass with a blank file: `currentFile` stays the last non-blank one. */
const L_PASS_NO_FILE = eventLine({ event: "test-end", id: "t-6", name: "tail", suite: "Lexer", file: "  ", status: "pass" });

const FIELD_STREAM = L_START + L_PASS + L_FAIL_OWN_ID + L_FAIL_BLANKS + L_PENDING + L_FAIL_BARE + L_PASS_NO_FILE;

/** §S4's live state for FIELD_STREAM, field by field. */
const FIELD_LIVE: RunLive = {
  completed: 6,
  total: 6,
  passed: 2,
  failed: 3,
  pending: 1,
  currentFile: "src/d.test.ts",
  failures: [
    { id: "t-2", name: "rejects", suite: "Parser", file: "src/b.test.ts", message: "expected 1", type: "AssertionError" },
    { id: "?::retries#3", name: "retries", suite: "?", file: "?", message: "boom at the relay" },
    { id: "Lexer::?#5", name: "?", suite: "Lexer", file: "src/d.test.ts" },
  ],
};

/** The six counts CR-CRU-223's readers serve as `live` — never the failures. */
const FIELD_COUNTS = {
  completed: 6,
  total: 6,
  passed: 2,
  failed: 3,
  pending: 1,
  currentFile: "src/d.test.ts",
};

/** The open-run brief of `runId` on the events feed. */
async function openRunBrief(s: Streamed): Promise<Record<string, unknown> | undefined> {
  const feed = await getJson(s.handle, `/api/v2/events?project=${s.key}`);
  const openRuns = feed.openRuns as Array<Record<string, unknown>>;
  return openRuns.find((run) => run.runId === s.runId);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("Store#runLive — the counts, total, currentFile and every failure, in stream order, with §S4's fields", () => {
  // Pins: a failure keyed by its suite alone (no `#<n>`), an ordinal counted
  // among failures instead of tests, a blank suite or file stored blank, the
  // whole multi-line message stored, a trace-only failure left with no
  // message, or `currentFile` cleared by a blank file — each makes this
  // `toEqual` fail.
  test("a stream of six tests — own ids, blank ids, blank suite and file, trace-only and bare failures — reads exactly §S4's live state", async () => {
    const s = await streamed(FIELD_STREAM, [L_START.length + L_PASS.length + 9]);
    expect(s.handle.store.runLive(s.runId)).toEqual(FIELD_LIVE);
  });

  // Pins: a `run-start` total of 0 stored as 0, or a missing one stored as 0.
  test("`total` is absent when the run-start carries none, and when it carries 0", async () => {
    const test1 = eventLine({ event: "test-end", name: "only", suite: "S", file: "src/only.test.ts", status: "pass" });
    for (const start of [eventLine({ event: "run-start" }), eventLine({ event: "run-start", total: 0 })]) {
      const s = await streamed(start + test1);
      const live = s.handle.store.runLive(s.runId);
      expect(live).toEqual({
        completed: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        currentFile: "src/only.test.ts",
        failures: [],
      });
      expect(live).not.toHaveProperty("total");
    }
  });

  // Pins: the FIRST run-start kept instead of the last.
  test("the last run-start sets the total, in whichever batch it arrives", async () => {
    const first = eventLine({ event: "run-start", total: 3 });
    const test1 = eventLine({ event: "test-end", name: "a", suite: "S", file: "src/a.test.ts", status: "pass" });
    const second = eventLine({ event: "run-start", total: 7 });
    const s = await streamed(first + test1 + second, [first.length + test1.length]);
    expect(s.handle.store.runLive(s.runId)?.total).toBe(7);
    expect(s.handle.store.runLive(s.runId)?.completed).toBe(1);
  });

  // Pins: `currentFile` taken from the first test instead of the latest.
  test("`currentFile` follows the latest test's file across batches", async () => {
    const a = eventLine({ event: "test-end", name: "a", suite: "S", file: "src/first.test.ts", status: "pass" });
    const b = eventLine({ event: "test-end", name: "b", suite: "S", file: "src/second.test.ts", status: "pass" });
    const s = await openStreamingRun();
    await sendAll(s.handle, s.runId, s.key, AGENT, batchesOf(a, []));
    expect(s.handle.store.runLive(s.runId)?.currentFile).toBe("src/first.test.ts");
    const more = await sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: AGENT, from: utf8(a), data: b });
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(s.handle.store.runLive(s.runId)?.currentFile).toBe("src/second.test.ts");
  });
});

describe("a test line cut across two batches is counted once, when it completes", () => {
  // Pins: a partial line decoded early (counted, then counted again when it
  // completes), or a matching resend decoded a second time.
  test("the first half counts nothing, the batch that completes it counts it once, and a matching resend counts nothing more", async () => {
    const s = await openStreamingRun();
    // The cut falls inside the failing test's line, just after its multibyte "é".
    const text = L_PASS + eventLine({ ...JSON.parse(L_FAIL_OWN_ID), name: "rejects café" });
    const cut = L_PASS.length + text.slice(L_PASS.length).indexOf("é") + 1;
    const batches = batchesOf(text, [cut]);
    await sendAll(s.handle, s.runId, s.key, AGENT, batches.slice(0, 1));
    const afterHead = s.handle.store.runLive(s.runId);
    expect(afterHead?.completed).toBe(1);
    expect(afterHead?.failed).toBe(0);
    expect(afterHead?.failures).toEqual([]);

    await sendAll(s.handle, s.runId, s.key, AGENT, batches.slice(1));
    const afterTail = s.handle.store.runLive(s.runId);
    expect(afterTail?.completed).toBe(2);
    expect(afterTail?.failed).toBe(1);
    expect(afterTail?.failures.map((f) => f.name)).toEqual(["rejects café"]);

    // A resend of the whole stream from 0 matches every byte held: nothing is appended or counted.
    const resend = await sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: AGENT, from: 0, data: text });
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    expect(resend.body.held).toBe(utf8(text));
    expect(s.handle.store.runLive(s.runId)).toEqual(afterTail);
  });
});

describe("CR-CRU-223's readers serve the filled state unchanged", () => {
  // Pins: the route or the brief reading something other than `Store#runLive`
  // (a stale cache, the failures leaking onto the brief).
  test("GET /api/v2/runs/<runId>/live answers the counts and the failures from `from`; the open-run brief carries the counts alone", async () => {
    const s = await streamed(FIELD_STREAM);
    const live = await getJson(s.handle, `/api/v2/runs/${s.runId}/live`);
    expect(live).toEqual({ ok: true, state: "open", live: FIELD_COUNTS, failures: FIELD_LIVE.failures, failuresFrom: 0 });

    const fromTwo = await getJson(s.handle, `/api/v2/runs/${s.runId}/live?from=2`);
    expect(fromTwo.failures).toEqual(FIELD_LIVE.failures.slice(2));
    expect(fromTwo.failuresFrom).toBe(2);

    const brief = await openRunBrief(s);
    expect(brief?.live).toEqual(FIELD_COUNTS);
    expect(brief?.live as Record<string, unknown>).not.toHaveProperty("failures");
  });

  // Pins: a live row created for a run whose only batch was refused.
  test("a run that has not streamed — none sent, or only a refused gap — answers null, a 404, and a brief with no `live`", async () => {
    const s = await openStreamingRun();
    const gap = await sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: AGENT, from: 9, data: L_PASS });
    expect(gap.status).toBe(409);
    expect(gap.body.held).toBe(0);

    expect(s.handle.store.runLive(s.runId)).toBeNull();
    const res = await fetch(`${base(s.handle)}/api/v2/runs/${s.runId}/live`);
    expect(res.status).toBe(404);
    const brief = await openRunBrief(s);
    expect(brief?.runId).toBe(s.runId);
    expect(brief).not.toHaveProperty("live");
  });
});
