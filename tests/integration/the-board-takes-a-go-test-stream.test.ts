// The board takes a `go test -json` stream as a record stream codec, on a real
// server (`startServer`, port 0, ":memory:"):
//  - a batch naming the `go-test` codec is accepted on an open run (200), and
//    the answer gives the bytes held, as for any stream;
//  - a run whose first batch fixed `go-test` refuses a `crucible-events` batch
//    (400), and holds nothing more;
//  - the closed run is stored decoded by `go-test`, the codec named on the
//    stored event, its cases and counts those the codec reads (a captured
//    stream, sent in batches cut mid-line);
//  - the open run's live state fills from each batch: completed, passed,
//    failed and pending as the cases land, each failure live with its
//    message's first line, in order — a parent's terminal event decided across a batch boundary.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import {
  afterLine,
  casesOf,
  closedGoTestRun,
  decodeGoTest,
  fixture,
  GO_TEST_CODEC,
  streamGoTest,
} from "../helpers/go-test-harness.ts";
import { bootOn, eventLine, getJson, openRun, readyProject, sendBatch, utf8 } from "../helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "go-test-streamer";
const PA = "example.com/mod/pa";

const RUN_SUB = fixture("run-sub.jsonl");
const FIRST = RUN_SUB.slice(0, afterLine(RUN_SUB, `"Test":"TestSubs/bad","Output":"=== RUN`));
const SECOND = RUN_SUB.slice(FIRST.length);

describe("a stream batch under the go-test codec is accepted on an open run", () => {
  test("the first batch naming go-test is a 200 answering the bytes held; the next one appends", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const runId = await openRun(handle, key, AGENT, { stack: "go", tier: "unit" });

    const first = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, codec: GO_TEST_CODEC, from: 0, data: FIRST });
    expect(first.status, String(first.body.error ?? "")).toBe(200);
    expect(first.body).toEqual({ ok: true, runId, held: utf8(FIRST) });

    const second = await sendBatch(handle, runId, {
      projectKey: key,
      agentId: AGENT,
      codec: GO_TEST_CODEC,
      from: utf8(FIRST),
      data: SECOND,
    });
    expect(second.status, String(second.body.error ?? "")).toBe(200);
    expect(second.body).toEqual({ ok: true, runId, held: utf8(FIRST + SECOND) });
    expect(handle.store.getRun(runId)?.state).toBe("open");
  });

  test("a run whose first batch fixed go-test refuses a crucible-events batch with a 400, holding nothing more", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const runId = await openRun(handle, key, AGENT, { stack: "go", tier: "unit" });
    const first = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, codec: GO_TEST_CODEC, from: 0, data: FIRST });
    expect(first.status, String(first.body.error ?? "")).toBe(200);

    const other = await sendBatch(handle, runId, {
      projectKey: key,
      agentId: AGENT,
      codec: "crucible-events",
      from: utf8(FIRST),
      data: eventLine({ event: "run-start", total: 1 }),
    });
    expect(other.status).toBe(400);
    expect(other.body.error as string).toContain("go-test");

    const next = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, codec: GO_TEST_CODEC, from: utf8(FIRST), data: SECOND });
    expect(next.status, String(next.body.error ?? "")).toBe(200);
    expect(next.body.held).toBe(utf8(FIRST + SECOND));
  });
});

describe("a closed go run is stored as go-test decodes it", () => {
  test("pa.jsonl sent in three batches cut mid-line: stored under go-test, 20 cases (12 passed, 6 failed, 2 pending), as the codec reads it", async () => {
    const stream = fixture("pa.jsonl");
    const cuts = [Math.floor(stream.length / 3) + 7, Math.floor((2 * stream.length) / 3) + 11];
    const run = await closedGoTestRun(boot(), AGENT, { stream, cuts, startTotal: 13 });
    expect(run.event.codec).toBe(GO_TEST_CODEC);
    expect(run.event.summary).toMatchObject({ total: 20, passed: 12, failed: 6, pending: 2 });
    const tree = run.event.tree as Parameters<typeof casesOf>[0];
    expect(casesOf(tree)).toEqual(casesOf(decodeGoTest(stream, { startTotal: 13 }).tree));
    expect(Object.keys(run.event)).not.toContain("incomplete");
  });

  test("a stored failure keeps its message and file:line; a stored skip its reason", async () => {
    const run = await closedGoTestRun(boot(), AGENT, { stream: fixture("pa.jsonl"), startTotal: 13 });
    const tree = run.event.tree as Parameters<typeof casesOf>[0];
    const pa = tree.find((s) => s.name === PA);
    const multi = pa?.children.find((leaf) => leaf.name === "TestFailMulti");
    expect(multi?.failure).toMatchObject({ message: "first line\nsecond line\nthird line", type: "example.com/mod/pa/a_test.go:10" });
    const skip = pa?.children.find((leaf) => leaf.name === "TestSkip");
    expect(skip?.status).toBe("pending");
    expect(skip?.failure?.message).toBe("not today");
  });

  test("a build failure closed over HTTP is a failing run, never a passing one", async () => {
    const run = await closedGoTestRun(boot(), AGENT, { stream: fixture("setup-failed.jsonl") });
    expect(run.event.codec).toBe(GO_TEST_CODEC);
    expect(run.event.summary).toMatchObject({ total: 1, passed: 0, failed: 1, pending: 0 });
  });
});

describe("an open go run's live state fills from each batch", () => {
  const PA_STREAM = fixture("pa.jsonl");
  // Cut after TestSubs/nest/deep_bad's fail and before TestSubs/nest's: the parents' fate is read in the next batch.
  const CUT = afterLine(PA_STREAM, `"Action":"fail","Package":"example.com/mod/pa","Test":"TestSubs/nest/deep_bad"`);

  async function liveAfter(batches: readonly string[]): Promise<Record<string, unknown>> {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "go-test-live");
    const runId = await openRun(handle, key, AGENT, { stack: "go", tier: "unit", total: 13 });
    const whole = batches.join("");
    const cuts: number[] = [];
    let at = 0;
    for (const data of batches.slice(0, -1)) {
      at += data.length;
      cuts.push(at);
    }
    await streamGoTest(handle, runId, key, AGENT, whole, cuts);
    return getJson(handle, `/api/v2/runs/${runId}/live`);
  }

  test("after a batch ending on a nested subtest's failure: the cases so far, no parent counted", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "go-test-live");
    const runId = await openRun(handle, key, AGENT, { stack: "go", tier: "unit", total: 13 });
    await streamGoTest(handle, runId, key, AGENT, PA_STREAM.slice(0, CUT));
    const state = handle.store.runLive(runId);
    // TestPass, TestFailMulti, TestSkip, TestSubs/ok, TestSubs/bad, TestSubs/skipped, TestSubs/nest/deep, TestSubs/nest/deep_bad, ExampleOnly (pex).
    expect(state).toMatchObject({ completed: 9, passed: 4, failed: 3, pending: 2 });
    expect(state?.failures.map((f) => f.name)).toEqual(["TestFailMulti", "TestSubs/bad", "TestSubs/nest/deep_bad"]);
    // The live state holds a failure's first line, as it does for every codec.
    expect(state?.failures[0]).toMatchObject({ name: "TestFailMulti", suite: PA, message: "first line" });
  });

  test("after the rest: 20 completed (12 passed, 6 failed, 2 pending), the dropped parents never counted, every failure in order", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "go-test-live");
    const runId = await openRun(handle, key, AGENT, { stack: "go", tier: "unit", total: 13 });
    await streamGoTest(handle, runId, key, AGENT, PA_STREAM, [CUT]);
    const state = handle.store.runLive(runId);
    expect(state).toMatchObject({ completed: 20, passed: 12, failed: 6, pending: 2 });
    expect(state?.failures.map((f) => f.name)).toEqual([
      "TestFailMulti",
      "TestSubs/bad",
      "TestSubs/nest/deep_bad",
      "TestParentFailsBeyond",
      "TestPar2",
      "ExampleBad",
    ]);
  });

  test("the live read route answers the same counts after the whole stream", async () => {
    const body = await liveAfter([PA_STREAM]);
    expect(body.state).toBe("open");
    expect(body.live).toMatchObject({ completed: 20, passed: 12, failed: 6, pending: 2 });
  });
});
