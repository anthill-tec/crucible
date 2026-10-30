// A streamed run that is aborted keeps what it streamed — on a real server
// (`startServer`, port 0, ":memory:").
//
// The abort is driven both ways the board settles a run it was not closed on:
//  - the client's own `POST /api/v2/runs/<runId>/abort`;
//  - the sweep, `Store#sweepOpenRuns` driven with a `now`, as the existing
//    sweep tests drive it: `agent died` (the agent tombstoned) and `abandoned`
//    (the run outlived `run_abandon_ms`).
//
// Each stores its aborted event with:
//  - the tree and counts decoded from the held stream — the same tree the
//    close stores from the same stream;
//  - `incomplete` stating why: the runner died before its `run-end`;
//  - `status: "aborted"` and `abortReason`, as today.
//
// Its batches and live state are deleted with it. A run that streamed nothing
// is aborted exactly as today: no tree, no counts and no `incomplete`.
import { describe, test, expect, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { shippedLimits } from "../src/limits.ts";
import { ABORTED_BEFORE_CLOSE, RUN_STREAM_TABLES } from "../src/run-stream.ts";
import type { ServerHandle } from "../src/server.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  getJson,
  openRun,
  postJson,
  register,
  sendBatch,
  storedEvent,
  utf8,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

// ── The stream: a runner that died before its run-end ───────────────────────

const L_START = eventLine({ event: "run-start", total: 3 });
const L_PASS = eventLine({
  event: "test-end",
  id: "t1",
  name: "adds",
  suite: "math",
  file: "src/math.ts",
  status: "pass",
  duration_ms: 3,
});
const L_FAIL = eventLine({
  event: "test-end",
  id: "t2",
  name: "divides",
  suite: "math",
  file: "src/math.ts",
  status: "fail",
  duration_ms: 4,
  failure: { message: "expected 1" },
});
const L_PENDING = eventLine({
  event: "test-end",
  id: "t3",
  name: "rounds",
  suite: "format",
  file: "src/format.ts",
  status: "pending",
  duration_ms: 0,
});

/** Three tests streamed, no run-end: the runner was cut off. */
const DIED_MID_RUN = L_START + L_PASS + L_FAIL + L_PENDING;
const DIED_SUMMARY = { total: 3, passed: 1, failed: 1, pending: 1, duration_ms: 7 };

// ── The subject ─────────────────────────────────────────────────────────────

interface Liveness {
  staleAfterMs: number;
  tombstoneAfterMs: number;
  pruneAfterMs: number;
}

interface Subject {
  handle: ServerHandle;
  key: string;
  agentId: string;
  runId: string;
}

async function subject(agentId: string, liveness?: Liveness): Promise<Subject> {
  const handle = boot();
  const key = crypto.randomUUID();
  handle.store.addProject({
    key,
    name: "aborted-stream",
    type: "backend",
    sutRoot: "/tmp/aborted-stream",
    ...(liveness !== undefined ? { liveness } : {}),
  });
  await register(handle, key, agentId);
  const runId = await openRun(handle, key, agentId, { stack: "bun", tier: "unit" });
  return { handle, key, agentId, runId };
}

async function stream(s: Subject, text: string): Promise<void> {
  const res = await sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: s.agentId, from: 0, data: text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.held).toBe(utf8(text));
}

async function abortByClient(s: Subject, reason: string): Promise<void> {
  const res = await postJson(s.handle, `/api/v2/runs/${s.runId}/abort`, {
    projectKey: s.key,
    agentId: s.agentId,
    reason,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** One fixed count query per stream table — no table name is ever interpolated. */
const COUNT_ROWS: Record<(typeof RUN_STREAM_TABLES)[number], string> = {
  run_stream_batches: "SELECT COUNT(*) AS n FROM run_stream_batches WHERE run_id = ?",
  run_live: "SELECT COUNT(*) AS n FROM run_live WHERE run_id = ?",
  run_live_failures: "SELECT COUNT(*) AS n FROM run_live_failures WHERE run_id = ?",
};

function streamRows(s: Subject): Record<string, number> {
  const db = (s.handle.store as unknown as { db: Database }).db;
  const out: Record<string, number> = {};
  for (const table of RUN_STREAM_TABLES) {
    out[table] = db.query<{ n: number }, [string]>(COUNT_ROWS[table]).get(s.runId)!.n;
  }
  return out;
}

const NO_ROWS = Object.fromEntries(RUN_STREAM_TABLES.map((table) => [table, 0]));

/** The tree the close stores from `text`: the oracle for what an abort must keep. */
async function closedTreeOf(text: string): Promise<unknown[]> {
  const s = await subject("oracle");
  await stream(s, text);
  const res = await closeStream(s.handle, s.key, s.agentId, s.runId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const event = await storedEvent(s.handle, res.body.event);
  expect(event.summary).toEqual(DIED_SUMMARY);
  return event.tree as unknown[];
}

/** The one aborted event the run settled on, read back through the run detail read. */
async function abortedEvent(s: Subject): Promise<Record<string, unknown>> {
  const run = s.handle.store.getRun(s.runId);
  expect(run?.state).toBe("aborted");
  expect(typeof run?.eventId).toBe("string");
  return storedEvent(s.handle, run?.eventId);
}

async function briefOf(s: Subject, eventId: unknown): Promise<Record<string, unknown>> {
  const list = await getJson(s.handle, `/api/v2/events?project=${s.key}`);
  const found = (list.events as Array<Record<string, unknown>>).filter((e) => e.id === eventId);
  expect(found.length).toBe(1);
  return found[0]!;
}

/** What every aborted streamed run keeps: its tests, flagged, with its reason. */
async function expectKeptItsTests(s: Subject, reason: string): Promise<void> {
  const event = await abortedEvent(s);
  expect(event.status).toBe("aborted");
  expect(event.abortReason).toBe(reason);
  expect(event.summary).toEqual(DIED_SUMMARY);
  expect(event.tree).toEqual(await closedTreeOf(DIED_MID_RUN));
  expect(event.incomplete).toBe("no run-end");
  const brief = await briefOf(s, event.id);
  expect(brief).toMatchObject({ status: "aborted", abortReason: reason, total: 3, passed: 1, failed: 1, pending: 1 });
  expect(brief.incomplete).toBe("no run-end");
  expect(streamRows(s)).toEqual(NO_ROWS);
  expect(s.handle.store.runLive(s.runId)).toBeNull();
}

const ABANDON_MS = shippedLimits().run_abandon_ms?.recommended ?? 3_600_000;

/** Liveness windows far past the abandon deadline: the sweep can only find the run abandoned. */
const NEVER_TOMBSTONED: Liveness = {
  staleAfterMs: ABANDON_MS * 10,
  tombstoneAfterMs: ABANDON_MS * 20,
  pruneAfterMs: ABANDON_MS * 40,
};

/** A short tombstone window and a far prune: the sweep finds the agent dead, its row still there. */
const TOMBSTONES_FAST: Liveness = { staleAfterMs: 1_000, tombstoneAfterMs: 2_000, pruneAfterMs: ABANDON_MS * 40 };

// ═══════════════════════════════════════════════════════════════════════════

describe("a streamed run aborted by its client keeps the tests it streamed", () => {
  test("POST /api/v2/runs/<runId>/abort stores the aborted event with the decoded tree and counts, incomplete, status and abortReason", async () => {
    const s = await subject("aborter");
    await stream(s, DIED_MID_RUN);
    const before = s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).length;
    await abortByClient(s, "runner crashed");
    expect(s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).length).toBe(before + 1);
    await expectKeptItsTests(s, "runner crashed");
  });

  test("the live read answers the aborted state and its event once the stream is gone", async () => {
    const s = await subject("aborter");
    await stream(s, DIED_MID_RUN);
    await abortByClient(s, "runner crashed");
    const event = await abortedEvent(s);
    expect(event.incomplete).toBe("no run-end");
    expect(await getJson(s.handle, `/api/v2/runs/${s.runId}/live`)).toEqual({
      ok: true,
      state: "aborted",
      eventId: event.id,
    });
  });
});

describe("a streamed run aborted by the sweep keeps the tests it streamed", () => {
  test("an agent that tombstoned: the sweep's `agent died` event carries the decoded tree and counts, incomplete, status and abortReason", async () => {
    const s = await subject("dier", TOMBSTONES_FAST);
    await stream(s, DIED_MID_RUN);
    const aborted = s.handle.store.sweepOpenRuns(Date.now() + TOMBSTONES_FAST.tombstoneAfterMs * 5);
    expect(aborted.map((e) => e.abortReason)).toEqual(["agent died"]);
    expect(aborted[0]!.summary).toEqual(DIED_SUMMARY);
    await expectKeptItsTests(s, "agent died");
  });

  test("a run that outlived run_abandon_ms: the sweep's `abandoned` event carries the decoded tree and counts, incomplete, status and abortReason", async () => {
    const s = await subject("loser", NEVER_TOMBSTONED);
    await stream(s, DIED_MID_RUN);
    const startedAt = s.handle.store.getRun(s.runId)?.startedAt;
    expect(typeof startedAt).toBe("number");
    const aborted = s.handle.store.sweepOpenRuns((startedAt as number) + ABANDON_MS);
    expect(aborted.map((e) => e.abortReason)).toEqual(["abandoned"]);
    expect(aborted[0]!.summary).toEqual(DIED_SUMMARY);
    await expectKeptItsTests(s, "abandoned");
  });
});

// "Aborted before its close" is the reason `abortedStreamRecord`
// (src/run-stream.ts) gives a stream whose codec states none of its own; it
// is read off the constant the module exports, and pinned to its text once.

/** The whole stream: the three tests and a run-end that agrees with them. */
const WHOLE_STREAM =
  DIED_MID_RUN + eventLine({ event: "run-end", total: 3, passed: 1, failed: 1, pending: 1, duration_ms: 7 });

/** An aborted run whose held stream is whole keeps its tests, flagged aborted before its close. */
async function expectAbortedBeforeItsClose(s: Subject, reason: string): Promise<void> {
  const event = await abortedEvent(s);
  expect(event.status).toBe("aborted");
  expect(event.abortReason).toBe(reason);
  expect(event.summary).toEqual(DIED_SUMMARY);
  expect(event.tree).toEqual(await closedTreeOf(WHOLE_STREAM));
  expect(event.incomplete).toBe(ABORTED_BEFORE_CLOSE);
  const brief = await briefOf(s, event.id);
  expect(brief.incomplete).toBe(ABORTED_BEFORE_CLOSE);
  expect(streamRows(s)).toEqual(NO_ROWS);
}

describe("a streamed run aborted after its matching run-end is flagged incomplete: aborted before its close", () => {
  test("the reason is the text `aborted before its close`", () => {
    expect(ABORTED_BEFORE_CLOSE).toBe("aborted before its close");
  });

  test("by its client: POST /api/v2/runs/<runId>/abort stores incomplete exactly `aborted before its close`", async () => {
    const s = await subject("whole-aborter");
    await stream(s, WHOLE_STREAM);
    await abortByClient(s, "runner crashed");
    await expectAbortedBeforeItsClose(s, "runner crashed");
  });

  test("by the sweep, abandoned: the `abandoned` event's incomplete is exactly `aborted before its close`", async () => {
    const s = await subject("whole-loser", NEVER_TOMBSTONED);
    await stream(s, WHOLE_STREAM);
    const startedAt = s.handle.store.getRun(s.runId)?.startedAt as number;
    const aborted = s.handle.store.sweepOpenRuns(startedAt + ABANDON_MS);
    expect(aborted.map((e) => e.abortReason)).toEqual(["abandoned"]);
    await expectAbortedBeforeItsClose(s, "abandoned");
  });

  test("by the sweep, agent died: the `agent died` event's incomplete is exactly `aborted before its close`", async () => {
    const s = await subject("whole-dier", TOMBSTONES_FAST);
    await stream(s, WHOLE_STREAM);
    const aborted = s.handle.store.sweepOpenRuns(Date.now() + TOMBSTONES_FAST.tombstoneAfterMs * 5);
    expect(aborted.map((e) => e.abortReason)).toEqual(["agent died"]);
    await expectAbortedBeforeItsClose(s, "agent died");
  });
});

describe("a run that streamed nothing is aborted exactly as today", () => {
  test("by its client: no counts, no tree and no incomplete key on the aborted event", async () => {
    const s = await subject("quiet");
    await abortByClient(s, "runner crashed");
    const event = await abortedEvent(s);
    expect(event.status).toBe("aborted");
    expect(event.abortReason).toBe("runner crashed");
    expect(event.summary).toBeUndefined();
    expect((event.tree as unknown[] | undefined) ?? []).toEqual([]);
    expect(Object.keys(event)).not.toContain("incomplete");
    const brief = await briefOf(s, event.id);
    expect(brief).toMatchObject({ total: 0, passed: 0, failed: 0, pending: 0 });
    expect(Object.keys(brief)).not.toContain("incomplete");
  });

  test("by the sweep: no counts, no tree and no incomplete key on the abandoned event", async () => {
    const s = await subject("quiet-sweep", NEVER_TOMBSTONED);
    const startedAt = s.handle.store.getRun(s.runId)?.startedAt as number;
    const aborted = s.handle.store.sweepOpenRuns(startedAt + ABANDON_MS);
    expect(aborted.map((e) => e.abortReason)).toEqual(["abandoned"]);
    expect(aborted[0]!.summary).toBeUndefined();
    expect(Object.keys(aborted[0]!)).not.toContain("incomplete");
    const event = await abortedEvent(s);
    expect((event.tree as unknown[] | undefined) ?? []).toEqual([]);
  });
});
