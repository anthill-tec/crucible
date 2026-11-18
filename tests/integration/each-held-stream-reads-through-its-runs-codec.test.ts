// A held stream is read through its own run's codec, never a named one — on
// a real server (`startServer`, port 0, ":memory:"). Each of the three
// readers of a held stream is driven with a `nextest` run and with a
// `crucible-events` run carrying the same three tests (a pass, a failure, a
// pending test):
//  - the live fill, as each batch lands (`Store#runLive`);
//  - an aborted run's record (`POST /api/v2/runs/<runId>/abort`);
//  - the close (`POST /api/v2/runs` naming the run's codec, no report).
// Each reader answers the same counts and the same tree for both codecs, and
// a crucible-events run reads exactly as it did before nextest.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import {
  NEXTEST_CODEC,
  panicStdout,
  suiteStarted,
  testFailed,
  testIgnored,
  testName,
  testOk,
  testStarted,
} from "../helpers/nextest-harness.ts";
import {
  bootOn,
  eventLine,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  storedEvent,
  utf8,
} from "../helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "codec-reader";
const SUITE = "nxread";

const lib = (path: string): string => testName(SUITE, SUITE, path);

/** The three tests as nextest streams them. */
const NEXTEST_STREAM =
  suiteStarted(SUITE, SUITE, "lib", 3) +
  testStarted(lib("tests::adds")) +
  testStarted(lib("tests::breaks")) +
  testStarted(lib("tests::later")) +
  testOk(lib("tests::adds"), 0.003) +
  testFailed(lib("tests::breaks"), 0.004, { stdout: panicStdout("tests::breaks", 31, "src/lib.rs:9:5", "it broke") }) +
  testIgnored(lib("tests::later"));

/** The same three tests as a crucible-events stream (no run-end: the runner is still going). */
const EVENTS_STREAM =
  eventLine({ event: "run-start", total: 3 }) +
  eventLine({ event: "test-end", id: "t1", name: "tests::adds", suite: SUITE, file: SUITE, status: "pass", duration_ms: 3 }) +
  eventLine({
    event: "test-end",
    id: "t2",
    name: "tests::breaks",
    suite: SUITE,
    file: SUITE,
    status: "fail",
    duration_ms: 4,
    failure: { message: "thread 'tests::breaks' (31) panicked at src/lib.rs:9:5" },
  }) +
  eventLine({ event: "test-end", id: "t3", name: "tests::later", suite: SUITE, file: SUITE, status: "pending", duration_ms: 0 });

const CODECS: ReadonlyArray<{ codec: string; stream: string }> = [
  { codec: NEXTEST_CODEC, stream: NEXTEST_STREAM },
  { codec: "crucible-events", stream: EVENTS_STREAM },
];

interface Subject {
  handle: ServerHandle;
  key: string;
  runId: string;
}

async function streamed(codec: string, stream: string): Promise<Subject> {
  const handle = bootOn();
  handles.push(handle);
  const key = await readyProject(handle, [AGENT], "codec-reader");
  const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });
  const res = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, codec, from: 0, data: stream });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.held).toBe(utf8(stream));
  return { handle, key, runId };
}

interface Leaf {
  name: string;
  status: string;
  failure?: { message?: string };
}

type TreeShape = Array<{ suite: string; leaves: Array<[string, string, string | undefined]> }>;

/** The tree as both codecs must agree on it: the suites, each leaf's name, status and message. */
function shapeOf(tree: unknown): TreeShape {
  return (tree as Array<{ name: string; children: Leaf[] }>).map((s) => ({
    suite: s.name,
    leaves: s.children.map((l) => [l.name, l.status, l.failure?.message]),
  }));
}

const EXPECTED_TREE: TreeShape = [
  {
    suite: SUITE,
    leaves: [
      ["tests::adds", "pass", undefined],
      ["tests::breaks", "fail", "thread 'tests::breaks' (31) panicked at src/lib.rs:9:5"],
      ["tests::later", "pending", undefined],
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════

for (const { codec, stream } of CODECS) {
  describe(`a ${codec} run's held stream is read through its own codec`, () => {
    test(`the live fill (${codec}): 3 completed — 1 passed, 1 failed, 1 pending — the failure live with its message`, async () => {
      const s = await streamed(codec, stream);
      const live = s.handle.store.runLive(s.runId);
      expect(live).toMatchObject({ completed: 3, passed: 1, failed: 1, pending: 1, currentFile: SUITE });
      expect(live?.failures.map((f) => [f.name, f.suite, f.message])).toEqual([
        ["tests::breaks", SUITE, "thread 'tests::breaks' (31) panicked at src/lib.rs:9:5"],
      ]);
    });

    test(`an aborted run's record (${codec}): the three tests kept, flagged incomplete`, async () => {
      const s = await streamed(codec, stream);
      const res = await postJson(s.handle, `/api/v2/runs/${s.runId}/abort`, {
        projectKey: s.key,
        agentId: AGENT,
        reason: "runner killed",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const run = s.handle.store.getRun(s.runId);
      expect(run?.state).toBe("aborted");
      const event = await storedEvent(s.handle, run?.eventId);
      expect(event.summary).toMatchObject({ total: 3, passed: 1, failed: 1, pending: 1 });
      expect(shapeOf(event.tree)).toEqual(EXPECTED_TREE);
      expect(typeof event.incomplete).toBe("string");
    });

    test(`the close (${codec}): the record holds the three tests`, async () => {
      const s = await streamed(codec, stream);
      const res = await postJson(s.handle, "/api/v2/runs", { projectKey: s.key, agentId: AGENT, runId: s.runId, codec });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const event = await storedEvent(s.handle, res.body.event);
      expect(event.summary).toMatchObject({ total: 3, passed: 1, failed: 1, pending: 1 });
      expect(shapeOf(event.tree)).toEqual(EXPECTED_TREE);
      expect(s.handle.store.getRun(s.runId)?.state).toBe("ended");
    });
  });
}

describe("a nextest run is closed under its own codec", () => {
  test("closing a nextest run naming crucible-events is refused (400), the run left open", async () => {
    const s = await streamed(NEXTEST_CODEC, NEXTEST_STREAM);
    const res = await postJson(s.handle, "/api/v2/runs", {
      projectKey: s.key,
      agentId: AGENT,
      runId: s.runId,
      codec: "crucible-events",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error as string).toContain("nextest");
    expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
  });
});
