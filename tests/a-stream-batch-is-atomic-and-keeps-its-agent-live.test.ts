// A stream batch is atomic, and it keeps its agent live (§S2, §S3, §S4):
//
//   - A batch racing a close, or an abort, is refused after it or lands before
//     it, and exactly ONE event is written for the run. So is the sweep against
//     a close. Each race is driven DETERMINISTICALLY: the racing settle is
//     injected at the exact seam the route crosses — after the route checked
//     the run open, before the store's transaction re-reads it — by wrapping
//     the server's own `Store` method so the real one still runs. No assertion
//     depends on real concurrency luck.
//   - An agent that only streams, for longer than its tombstone window, is not
//     swept: each accepted batch quietly moves the agent's `lastSeen`. Driven
//     through `Store#sweepOpenRuns(now)` with the system clock set by
//     `setSystemTime`; a sibling agent that streams nothing is swept as the
//     control, so the clock is proven to reach the sweep.
//   - A batch emits no `agents` change (the touch is quiet), read on
//     `Store#onChange`; and the agents read gains no field (§S4: the agent's
//     line is composed in the browser).
//
// These are REGRESSION PINS over the transactions and the quiet touch cycles
// 821 and 822 built. Each test names, in its own comment, the regression it
// fails against.
//
// "Exactly one event" counts the project's `test` events against those held
// BEFORE the race: a registration already writes a lifecycle event.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { resolveLimit } from "../src/limits.ts";
import type { ServerHandle } from "../src/server.ts";
import type { ChangeKind, Store } from "../src/store.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  getJson,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  storedEvent,
  STREAM_CODEC,
  utf8,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  setSystemTime();
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "racing-streamer";

const L_START = eventLine({ event: "run-start", total: 2 });
const L_ONE = eventLine({ event: "test-end", id: "r-1", name: "first", suite: "Race", file: "src/race.test.ts", status: "pass" });
const L_TWO = eventLine({
  event: "test-end",
  id: "r-2",
  name: "second",
  suite: "Race",
  file: "src/race.test.ts",
  status: "fail",
  failure: { message: "lost the race" },
});
const L_END = eventLine({ event: "run-end", total: 2, passed: 1, failed: 1, pending: 0 });

/** What the run held before the racing batch: the start and the first test. */
const HELD = L_START + L_ONE;

interface Racing {
  handle: ServerHandle;
  store: Store;
  key: string;
  runId: string;
}

/** A real server, a registered agent, an open run holding HELD. */
async function racingRun(): Promise<Racing> {
  const handle = bootOn();
  handles.push(handle);
  const key = await readyProject(handle, [AGENT], "stream-race");
  const runId = await openRun(handle, key, AGENT, { stack: "bun", tier: "unit" });
  const first = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: HELD });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  return { handle, store: handle.store, key, runId };
}

/** The project's run (`test`) events, newest first. */
function testEvents(r: Racing): Array<{ id: string; status?: string }> {
  return r.store
    .listEvents(r.key, 500)
    .filter((event) => event.kind === "test")
    .map((event) => ({ id: event.id, ...(event.status !== undefined ? { status: event.status } : {}) }));
}

/** The racing batch: the second test and the run-end, appended after HELD. */
function racingBatch(r: Racing) {
  return sendBatch(r.handle, r.runId, { projectKey: r.key, agentId: AGENT, from: utf8(HELD), data: L_TWO + L_END });
}

/** The same batch straight through the store, as a batch that won the race lands. */
function landRacingBatchInStore(r: Racing): void {
  const outcome = r.store.appendRunStream(r.runId, {
    codec: STREAM_CODEC,
    from: utf8(HELD),
    data: L_TWO + L_END,
    limit: resolveLimit("ingest_body_bytes"),
  });
  expect(outcome).toEqual({ ok: true, held: utf8(HELD + L_TWO + L_END) });
}

/** A moment past every liveness and abandon window: the sweep aborts every open run. */
function farFuture(): number {
  return Date.now() + 365 * 24 * 60 * 60 * 1000;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a batch racing a close is refused after it, or lands before it — exactly one event either way", () => {
  // Pins: a batch appended to a run already closed (a second record, or a
  // live state re-created after the close deleted it).
  test("a batch after the close is a 409 carrying `ended` and the close's eventId; the close's event is the only one and holds no live state", async () => {
    const r = await racingRun();
    const before = testEvents(r);
    const closed = await closeStream(r.handle, r.key, AGENT, r.runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const late = await racingBatch(r);
    expect(late.status).toBe(409);
    expect(late.body.state).toBe("ended");
    expect(late.body.eventId).toBe(closed.body.event);
    expect(String(late.body.error)).toContain("nothing stored");

    const after = testEvents(r);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.id).toBe(closed.body.event as string);
    expect(r.store.runLive(r.runId)).toBeNull();
    expect(r.store.runStreamCodec(r.runId)).toBeNull();
    // The record is the stream held at the close: one test, not the late one.
    const event = await storedEvent(r.handle, closed.body.event);
    expect(event.summary?.total).toBe(1);
  });

  // Pins: the close decoding a stream read BEFORE its transaction, so a batch
  // landing between the close's checks and its transaction is lost.
  test("a batch landing between the close's checks and its transaction is in the close's record", async () => {
    const r = await racingRun();
    const before = testEvents(r);
    const close = r.store.closeStreamedRun.bind(r.store);
    let raced = 0;
    r.store.closeStreamedRun = ((runId: string, fn: Parameters<Store["closeStreamedRun"]>[1]) => {
      raced += 1;
      landRacingBatchInStore(r);
      return close(runId, fn);
    }) as Store["closeStreamedRun"];

    const closed = await closeStream(r.handle, r.key, AGENT, r.runId);
    expect(raced).toBe(1);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const event = await storedEvent(r.handle, closed.body.event);
    expect(event.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 0 });
    expect(event).not.toHaveProperty("incomplete");
    expect(testEvents(r)).toHaveLength(before.length + 1);
    expect(r.store.getRun(r.runId)?.state).toBe("ended");
  });
});

describe("a batch racing an abort is refused after it — exactly one event", () => {
  // Pins: the abort route leaving the stream open to a later batch.
  test("a batch after `POST /api/v2/runs/<runId>/abort` is a 409 carrying `aborted` and the abort's eventId", async () => {
    const r = await racingRun();
    const before = testEvents(r);
    const aborted = await postJson(r.handle, `/api/v2/runs/${r.runId}/abort`, {
      projectKey: r.key,
      agentId: AGENT,
      reason: "runner killed",
    });
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    const abortEventId = r.store.getRun(r.runId)?.eventId;
    expect(typeof abortEventId).toBe("string");

    const late = await racingBatch(r);
    expect(late.status).toBe(409);
    expect(late.body.state).toBe("aborted");
    expect(late.body.eventId).toBe(abortEventId);
    expect(testEvents(r)).toEqual([{ id: abortEventId as string, status: "aborted" }, ...before]);
    expect(r.store.runLive(r.runId)).toBeNull();
  });

  // Pins: the batch trusting the route's open check instead of re-reading the
  // run inside its own transaction (it would append to an aborted run).
  test("an abort landing between the route's open check and the batch's transaction: the batch is a 409 and appends nothing", async () => {
    const r = await racingRun();
    const before = testEvents(r);
    const append = r.store.appendRunStream.bind(r.store);
    r.store.appendRunStream = ((runId: string, batch: Parameters<Store["appendRunStream"]>[1]) => {
      expect(r.store.abortOpenRun(runId, "runner killed")).not.toBeNull();
      return append(runId, batch);
    }) as Store["appendRunStream"];

    const late = await racingBatch(r);
    expect(late.status).toBe(409);
    expect(late.body.state).toBe("aborted");
    const abortEventId = r.store.getRun(r.runId)?.eventId;
    expect(late.body.eventId).toBe(abortEventId);
    expect(testEvents(r)).toEqual([{ id: abortEventId as string, status: "aborted" }, ...before]);
    // The aborted record keeps what was held before the batch: one test, never the racing one.
    const event = await storedEvent(r.handle, abortEventId);
    expect(event.summary?.total).toBe(1);
    expect(r.store.runStreamCodec(r.runId)).toBeNull();
  });
});

describe("the sweep against a close — whichever settles first, the other writes nothing", () => {
  // Pins: the close filing a second event for a run the sweep aborted.
  test("the sweep settling the run between the close's checks and its transaction: the close is a 409 carrying `aborted` and the sweep's eventId", async () => {
    const r = await racingRun();
    const before = testEvents(r);
    const close = r.store.closeStreamedRun.bind(r.store);
    r.store.closeStreamedRun = ((runId: string, fn: Parameters<Store["closeStreamedRun"]>[1]) => {
      expect(r.store.sweepOpenRuns(farFuture()).map((event) => event.status)).toEqual(["aborted"]);
      return close(runId, fn);
    }) as Store["closeStreamedRun"];

    const closed = await closeStream(r.handle, r.key, AGENT, r.runId);
    expect(closed.status).toBe(409);
    const sweptEventId = r.store.getRun(r.runId)?.eventId;
    expect(closed.body.state).toBe("aborted");
    expect(closed.body.eventId).toBe(sweptEventId);
    expect(testEvents(r)).toEqual([{ id: sweptEventId as string, status: "aborted" }, ...before]);
  });

  // Pins: the sweep aborting a run the close already ended.
  test("the close first: the sweep afterwards aborts nothing, and the close's event stays the only one", async () => {
    const r = await racingRun();
    const before = testEvents(r);
    const closed = await closeStream(r.handle, r.key, AGENT, r.runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    expect(r.store.sweepOpenRuns(farFuture())).toEqual([]);
    expect(r.store.getRun(r.runId)?.state).toBe("ended");
    expect(testEvents(r)).toEqual([{ id: closed.body.event as string }, ...before]);
  });
});

describe("an agent that only streams stays live", () => {
  // Pins: a batch that does not touch the agent's `lastSeen` — the streaming
  // agent would tombstone and its run be aborted `agent died` mid-stream.
  test("streaming for twice its tombstone window, the agent's run is never swept, while a sibling that streams nothing is swept `agent died`", () => {
    const store = (() => {
      const handle = bootOn();
      handles.push(handle);
      return handle.store;
    })();
    const key = crypto.randomUUID();
    store.addProject({ key, name: "stream-liveness", type: "backend", sutRoot: "/tmp/stream-liveness" });
    const t0 = Date.now();
    setSystemTime(t0);
    const streaming = store.startRun(key, "only-streams", { tier: "unit" }).runId;
    const silent = store.startRun(key, "streams-nothing", { tier: "unit" }).runId;
    const { tombstoneAfterMs } = store.livenessConfig(key);
    const step = Math.floor(tombstoneAfterMs / 2);
    // The span stays inside the abandon limit, so only liveness can sweep a run.
    expect(4 * step).toBeLessThan(resolveLimit("run_abandon_ms"));

    let held = 0;
    for (let k = 1; k <= 4; k += 1) {
      const now = t0 + k * step;
      setSystemTime(now);
      const line = eventLine({ event: "test-end", name: `t${k}`, suite: "Live", file: "src/live.test.ts", status: "pass" });
      const outcome = store.appendRunStream(streaming, {
        codec: STREAM_CODEC,
        from: held,
        data: line,
        limit: resolveLimit("ingest_body_bytes"),
      });
      held += utf8(line);
      expect(outcome).toEqual({ ok: true, held });
      const lastSeen = store.getAgent(key, "only-streams", now)?.lastSeen ?? Number.NaN;
      expect(lastSeen).toBeGreaterThanOrEqual(now);
      expect(lastSeen).toBeLessThan(now + 1_000);
      // The silent sibling is due exactly once: on the first sweep past its tombstone window.
      const siblingDue = now - t0 >= tombstoneAfterMs && store.getRun(silent)?.state === "open";
      const swept = store.sweepOpenRuns(now);
      expect(swept.map((event) => event.agentId)).toEqual(siblingDue ? ["streams-nothing"] : []);
      expect(store.getRun(streaming)?.state).toBe("open");
    }
    expect(store.getRun(silent)?.state).toBe("aborted");
    expect(store.getRun(silent)?.abortReason).toBe("agent died");
    expect(store.runLive(streaming)?.completed).toBe(4);
  });
});

describe("a batch moves no agents slice", () => {
  // Pins: the quiet touch done through `touchAgent`, which emits `agents`.
  test("a batch over the route emits no `agents` change, yet moves the agent's lastSeen", async () => {
    const handle = bootOn();
    handles.push(handle);
    const key = await readyProject(handle, [AGENT], "stream-quiet");
    const runId = await openRun(handle, key, AGENT, { tier: "unit" });
    const seenBefore = handle.store.getAgent(key, AGENT)?.lastSeen ?? Number.NaN;
    const later = seenBefore + 60_000;
    setSystemTime(later);
    const heard: Array<{ kind: ChangeKind; projectKey?: string }> = [];
    const off = handle.store.onChange((kind, projectKey) => {
      heard.push({ kind, ...(projectKey !== undefined ? { projectKey } : {}) });
    });
    const res = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: HELD });
    off();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(heard.filter((change) => change.kind === "agents")).toEqual([]);
    const seenAfter = handle.store.getAgent(key, AGENT, later)?.lastSeen ?? Number.NaN;
    expect(seenAfter).toBeGreaterThanOrEqual(later);
    expect(seenAfter).toBeLessThan(later + 5_000);
  });

  // Pins: a server-side running line (a `live` or `running` key) added to the
  // agents read — §S4 composes the agent's line in the browser.
  test("GET /api/v2/agents serves a streaming agent with exactly the keys it served before the stream", async () => {
    const handle = bootOn();
    handles.push(handle);
    const key = await readyProject(handle, [AGENT], "stream-agents-read");
    const runId = await openRun(handle, key, AGENT, { tier: "unit" });
    const agentOf = async (): Promise<Record<string, unknown>> => {
      const read = await getJson(handle, `/api/v2/agents?project=${key}`);
      const agent = (read.agents as Array<Record<string, unknown>>).find((a) => a.agentId === AGENT);
      expect(agent, `agent ${AGENT} on the agents read`).toBeDefined();
      return agent ?? {};
    };
    const before = await agentOf();
    const res = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: HELD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await agentOf();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after.message).toBe(before.message);
    expect(after).not.toHaveProperty("live");
  });
});
