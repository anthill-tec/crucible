// The live state of an open nextest run, filled from its stream batch by
// batch — on a real server (`startServer`, port 0, ":memory:"), read through
// `Store#runLive` and `GET /api/v2/runs/<runId>/live`:
//  - each result counts as it lands: `ok` passed, `failed` failed, `ignored`
//    pending; `completed` all three;
//  - the current file is the latest result's suite (its test binary's id);
//  - each failure joins the live failures with its message, in order;
//  - the total is the run's listed total (its posted test list's matching
//    tests), else the run start's, plus the pending results seen — an ignored
//    test is outside the listed total; 0 is no total.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import type { RunLive } from "../../src/types.ts";
import {
  listOf,
  NEXTEST_CODEC,
  panicStdout,
  postList,
  streamNextest,
  suiteStarted,
  testFailed,
  testIgnored,
  testName,
  testOk,
  testStarted,
} from "../helpers/nextest-harness.ts";
import { bootOn, getJson, openRun, readyProject, sendBatch, utf8 } from "../helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "nextest-live";
const CRATE = "nxlive";

interface Subject {
  handle: ServerHandle;
  key: string;
  runId: string;
  held: string;
}

async function subject(opts: { list?: string; startTotal?: number } = {}): Promise<Subject> {
  const handle = bootOn();
  handles.push(handle);
  const key = await readyProject(handle, [AGENT], "nextest-live");
  const runId = await openRun(handle, key, AGENT, {
    stack: "rust",
    tier: "unit",
    ...(opts.startTotal !== undefined ? { total: opts.startTotal } : {}),
  });
  if (opts.list !== undefined) {
    const listed = await postList(handle, runId, key, AGENT, opts.list);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  }
  return { handle, key, runId, held: "" };
}

/** One more batch, sent from the bytes held so far. */
async function batch(s: Subject, text: string): Promise<void> {
  const res = await sendBatch(s.handle, s.runId, {
    projectKey: s.key,
    agentId: AGENT,
    codec: NEXTEST_CODEC,
    from: utf8(s.held),
    data: text,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  s.held += text;
  expect(res.body.held).toBe(utf8(s.held));
}

function live(s: Subject): RunLive | null {
  return s.handle.store.runLive(s.runId);
}

const lib = (path: string): string => testName(CRATE, CRATE, path);
const it = (path: string): string => testName(CRATE, "it", path);

/** The run's list: four lib tests and three integration tests, one of them ignored — a listed total of 6. */
const LIST = listOf([
  {
    crate: CRATE,
    binaryName: CRATE,
    kind: "lib",
    tests: ["tests::a", "tests::b", "tests::c", "tests::d"].map((path) => ({ path, matches: true })),
  },
  {
    crate: CRATE,
    binaryName: "it",
    kind: "test",
    tests: [
      { path: "integration_x", matches: true },
      { path: "integration_y", matches: true },
      { path: "integration_z", matches: false },
    ],
  },
]);

const B_STDOUT = panicStdout("tests::b", 501, "src/lib.rs:12:9", "b broke");
const Y_STDOUT = panicStdout("integration_y", 502, "tests/it.rs:7:5", "y broke");

/** Batch 1: the lib binary, three results — a pass, a failure, a pass. */
const BATCH_1 =
  suiteStarted(CRATE, CRATE, "lib", 4) +
  testStarted(lib("tests::a")) +
  testStarted(lib("tests::b")) +
  testStarted(lib("tests::c")) +
  testStarted(lib("tests::d")) +
  testOk(lib("tests::a"), 0.002) +
  testFailed(lib("tests::b"), 0.003, { stdout: B_STDOUT }) +
  testOk(lib("tests::c"), 0.002);

/** Batch 2: the lib's last result, then the integration binary's suite line, its tests and one ignored result. */
const BATCH_2 =
  testOk(lib("tests::d"), 0.002) +
  suiteStarted(CRATE, "it", "test", 3) +
  testStarted(it("integration_x")) +
  testStarted(it("integration_y")) +
  testStarted(it("integration_z")) +
  testOk(it("integration_x"), 0.004) +
  testIgnored(it("integration_z")) +
  testFailed(it("integration_y"), 0.005, { stdout: Y_STDOUT });

const B_FAILURE = {
  name: "tests::b",
  suite: CRATE,
  message: "thread 'tests::b' (501) panicked at src/lib.rs:12:9",
};
const Y_FAILURE = {
  name: "integration_y",
  suite: `${CRATE}::it`,
  message: "thread 'integration_y' (502) panicked at tests/it.rs:7:5",
};

// ═══════════════════════════════════════════════════════════════════════════

describe("an open nextest run's live state, batch by batch, with a listed total of 6", () => {
  test("after the first batch: 3 completed (2 passed, 1 failed), total 6, the lib's suite current, its failure live with its message", async () => {
    const s = await subject({ list: LIST });
    await batch(s, BATCH_1);
    const state = live(s);
    expect(state).toMatchObject({ completed: 3, total: 6, passed: 2, failed: 1, pending: 0, currentFile: CRATE });
    expect(state?.failures.length).toBe(1);
    expect(state?.failures[0]).toMatchObject(B_FAILURE);
  });

  test("after the second: 7 completed (4 passed, 2 failed, 1 pending), total 7 once the ignored result landed, the integration suite current, both failures in order", async () => {
    const s = await subject({ list: LIST });
    await batch(s, BATCH_1);
    await batch(s, BATCH_2);
    const state = live(s);
    expect(state).toMatchObject({
      completed: 7,
      total: 7,
      passed: 4,
      failed: 2,
      pending: 1,
      currentFile: `${CRATE}::it`,
    });
    expect(state?.failures.length).toBe(2);
    expect(state?.failures[0]).toMatchObject(B_FAILURE);
    expect(state?.failures[1]).toMatchObject(Y_FAILURE);
  });

  test("the live read route answers the same state: GET /api/v2/runs/<runId>/live after each batch", async () => {
    const s = await subject({ list: LIST });
    await batch(s, BATCH_1);
    const first = await getJson(s.handle, `/api/v2/runs/${s.runId}/live`);
    expect(first.state).toBe("open");
    expect(first.live).toMatchObject({ completed: 3, total: 6, passed: 2, failed: 1, pending: 0 });
    await batch(s, BATCH_2);
    const second = await getJson(s.handle, `/api/v2/runs/${s.runId}/live`);
    expect(second.live).toMatchObject({ completed: 7, total: 7, passed: 4, failed: 2, pending: 1 });
    expect((second.failures as Array<Record<string, unknown>>).map((f) => f.name)).toEqual(["tests::b", "integration_y"]);
  });

  test("a test whose started line has no result yet counts nothing: the first batch's started-only tests leave completed at 3", async () => {
    const s = await subject({ list: LIST });
    await batch(s, BATCH_1 + suiteStarted(CRATE, "it", "test", 3) + testStarted(it("integration_x")));
    expect(live(s)).toMatchObject({ completed: 3, passed: 2, failed: 1, pending: 0, currentFile: CRATE });
  });
});

describe("the live total is the listed total, else the start's, plus the pending results seen", () => {
  test("an ignored result landing first reads total 7 on a listed total of 6, with 1 completed", async () => {
    const s = await subject({ list: LIST });
    await batch(s, suiteStarted(CRATE, "it", "test", 3) + testStarted(it("integration_z")) + testIgnored(it("integration_z")));
    expect(live(s)).toMatchObject({ completed: 1, total: 7, passed: 0, failed: 0, pending: 1 });
  });

  test("with no list, the run start's total 3 plus one ignored result reads total 4", async () => {
    const s = await subject({ startTotal: 3 });
    await batch(
      s,
      suiteStarted(CRATE, CRATE, "lib", 2) +
        testStarted(lib("tests::a")) +
        testOk(lib("tests::a"), 0.001) +
        testIgnored(lib("tests::later")),
    );
    expect(live(s)).toMatchObject({ completed: 2, total: 4, passed: 1, failed: 0, pending: 1 });
  });

  test("the listed total replaces the run start's: a start total of 50 with a list of 6 reads 6", async () => {
    const s = await subject({ startTotal: 50, list: LIST });
    await batch(s, BATCH_1);
    expect(live(s)?.total).toBe(6);
  });

  test("a start total of 0 and no list is no total: the live state carries no total key", async () => {
    const s = await subject({ startTotal: 0 });
    await batch(s, suiteStarted(CRATE, CRATE, "lib", 1) + testOk(lib("tests::a"), 0.001));
    const state = live(s);
    expect(state).toMatchObject({ completed: 1, passed: 1 });
    expect(Object.keys(state ?? {})).not.toContain("total");
  });
});

describe("the whole stream in one go reads as the two batches did", () => {
  test("one batch holding both, cut nowhere, reads the second batch's state", async () => {
    const s = await subject({ list: LIST });
    await streamNextest(s.handle, s.runId, s.key, AGENT, BATCH_1 + BATCH_2);
    expect(live(s)).toMatchObject({ completed: 7, total: 7, passed: 4, failed: 2, pending: 1, currentFile: `${CRATE}::it` });
  });
});
