// A rust run streamed through nextest is stored as the record its own JUnit
// report is stored as — for every run captured under
// `tests/fixtures/nextest/runs/` (see the README there).
//
// For each captured run, on a real board (`bootInProcess`, no socket, ":memory:"):
//  1. its `junit.xml` is posted to `POST /api/v2/runs` as a rust client files
//     it (`codec: "junit"`, `stack: "rust"`), and the stored run is read back
//     through `GET /api/v2/events/<id>`;
//  2. a run is opened with `POST /api/v2/runs/start`, takes its `list.json`
//     through `POST /api/v2/runs/<runId>/tests` (`codec: "nextest-list"`),
//     and takes its `stream.jsonl` in three batches through the stream route
//     under the `nextest` codec, two cuts falling mid-line;
//  3. the run is closed with `POST /api/v2/runs` `{runId, codec: "nextest"}`
//     and no report;
//  4. the stored record has the JUnit record's suites, test names, statuses,
//     passed and failed counts and failure messages, and each duration within
//     one millisecond of it. JUnit holds no ignored test: each test the stream
//     reports `ignored` is a pending leaf the JUnit record does not have, and
//     the record's total is the JUnit total plus those.
//
// Exempt, each in its own run's test:
//  - a timeout's failure message: JUnit's timeout failure states none;
//  - a test failing every retried attempt: the thread id inside its message
//    and its duration — JUnit keeps the first attempt, the stream the last.
//
// Each run's list matches its stream, so no stored record is flagged
// incomplete.
import { describe, test, expect, afterEach } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import {
  CAPTURED_RUNS,
  capturedRun,
  closeNextest,
  postList,
  streamNextest,
  type CapturedRun,
  type CapturedRunName,
} from "../helpers/nextest-harness.ts";
import { bootInProcess, openRun, postJson, readyProject, storedEvent } from "../helpers/run-stream-harness.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "nextest-recorder";

const byText = (a: string, b: string): number => a.localeCompare(b);

interface Failure {
  message?: string;
  type?: string;
  trace?: string;
}

interface Leaf {
  name: string;
  status: string;
  duration_ms: number;
  failure?: Failure;
}

interface Node {
  name: string;
  status: string;
  children: Leaf[];
}

interface Summary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
}

interface Stored {
  summary: Summary;
  tree: Node[];
  keys: string[];
}

/** One test as the comparison reads it: its suite, its name, its status, its message and its duration. */
interface Row {
  suite: string;
  name: string;
  status: string;
  message: string | undefined;
  duration_ms: number;
}

function rowsOf(tree: readonly Node[]): Row[] {
  return tree
    .flatMap((suite) =>
      suite.children.map((leaf) => ({
        suite: suite.name,
        name: leaf.name,
        status: leaf.status,
        message: leaf.failure?.message,
        duration_ms: leaf.duration_ms,
      })),
    )
    .sort((a, b) => `${a.suite}\u0000${a.name}`.localeCompare(`${b.suite}\u0000${b.name}`));
}

/** The names of the tests the stream reports `ignored`, as `<binary id>`-less paths. */
function ignoredPaths(stream: string): string[] {
  return stream
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type?: string; event?: string; name?: string })
    .filter((e) => e.type === "test" && e.event === "ignored")
    .map((e) => (e.name ?? "").split("$").slice(1).join("$"));
}

/** Two cuts, each in the middle of a line: one a third of the way in, one two thirds. */
function midLineCuts(text: string): number[] {
  const cuts: number[] = [];
  for (const fraction of [1 / 3, 2 / 3]) {
    let at = Math.floor(text.length * fraction);
    while (at < text.length - 1 && (text[at - 1] === "\n" || text[at] === "\n")) at += 1;
    if (cuts.length === 0 || at > (cuts[cuts.length - 1] ?? 0)) cuts.push(at);
  }
  return cuts;
}

interface Pair {
  junit: Stored;
  streamed: Stored;
}

/** The run's JUnit record and its streamed record, each stored by a real board. */
async function bothRecords(run: CapturedRun): Promise<Pair> {
  const handle = bootInProcess();
  handles.push(handle);
  const key = await readyProject(handle, [AGENT], "nextest-record");

  const filed = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId: AGENT,
    codec: "junit",
    stack: "rust",
    data: [run.junit],
  });
  expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  const junitEvent = await storedEvent(handle, filed.body.event);

  const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });
  const listed = await postList(handle, runId, key, AGENT, run.list);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  await streamNextest(handle, runId, key, AGENT, run.stream, midLineCuts(run.stream));
  const closed = await closeNextest(handle, key, AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(closed.body.ok).toBe(true);
  const streamedEvent = await storedEvent(handle, closed.body.event);
  expect(handle.store.getRun(runId)?.state).toBe("ended");

  return {
    junit: {
      summary: junitEvent.summary as unknown as Summary,
      tree: junitEvent.tree as unknown as Node[],
      keys: Object.keys(junitEvent),
    },
    streamed: {
      summary: streamedEvent.summary as unknown as Summary,
      tree: streamedEvent.tree as unknown as Node[],
      keys: Object.keys(streamedEvent),
    },
  };
}

/**
 * What every run is held to: the same suites, the same tests by name and
 * status, the same passed and failed counts, the same messages (`exempt`
 * rewrites both sides' message for a test the run's test exempts), durations
 * within a millisecond (but for the tests in `noDuration`), and each ignored
 * test a pending leaf JUnit does not have.
 */
function expectSameRecord(
  run: CapturedRun,
  pair: Pair,
  exempt: { message?: (row: Row) => string | undefined; noDuration?: readonly string[] } = {},
): void {
  const { junit, streamed } = pair;
  const ignored = ignoredPaths(run.stream);

  // The pending leaves are exactly the ignored tests; JUnit has none of them.
  const pending = rowsOf(streamed.tree).filter((r) => r.status === "pending");
  expect(pending.map((r) => r.name).sort(byText)).toEqual([...ignored].sort(byText));
  expect(rowsOf(junit.tree).filter((r) => r.status === "pending")).toEqual([]);
  expect(streamed.summary.pending).toBe(ignored.length);
  expect(streamed.summary.total).toBe(junit.summary.total + ignored.length);

  expect(streamed.summary.passed).toBe(junit.summary.passed);
  expect(streamed.summary.failed).toBe(junit.summary.failed);
  expect(streamed.tree.map((s) => s.name).sort(byText)).toEqual(junit.tree.map((s) => s.name).sort(byText));

  const message = exempt.message ?? ((row: Row) => row.message);
  const noDuration = new Set(exempt.noDuration ?? []);
  const shape = (r: Row) => ({ suite: r.suite, name: r.name, status: r.status, message: message(r) });
  const results = rowsOf(streamed.tree).filter((r) => r.status !== "pending");
  const reported = rowsOf(junit.tree);
  expect(results.map(shape)).toEqual(reported.map(shape));
  for (const [i, row] of results.entries()) {
    const other = reported[i]!;
    if (noDuration.has(row.name)) continue;
    expect(
      Math.abs(row.duration_ms - other.duration_ms),
      `${row.suite} ${row.name}: streamed ${row.duration_ms} ms, JUnit ${other.duration_ms} ms`,
    ).toBeLessThanOrEqual(1);
  }

  // The list matched the stream: the record is not flagged.
  expect(streamed.keys).not.toContain("incomplete");
}

/** What each run must hold for its comparison to mean anything. */
const SHAPE: Record<CapturedRunName, { suites: number; passed: number; failed: number; pending: number }> = {
  "all-pass": { suites: 2, passed: 3, failed: 0, pending: 0 },
  "a-failure": { suites: 1, passed: 1, failed: 1, pending: 0 },
  "distinct-targets": { suites: 3, passed: 3, failed: 1, pending: 1 },
  "same-name": { suites: 3, passed: 3, failed: 1, pending: 0 },
  "spawned-thread-panic": { suites: 1, passed: 0, failed: 1, pending: 0 },
  "should-panic-without-a-panic": { suites: 1, passed: 0, failed: 1, pending: 0 },
  "err-return": { suites: 1, passed: 0, failed: 1, pending: 0 },
  "flaky-retries": { suites: 1, passed: 2, failed: 1, pending: 0 },
  timeout: { suites: 1, passed: 1, failed: 1, pending: 0 },
};

function expectShape(name: CapturedRunName, pair: Pair): void {
  const want = SHAPE[name];
  expect(pair.streamed.tree.length).toBe(want.suites);
  expect({
    passed: pair.streamed.summary.passed,
    failed: pair.streamed.summary.failed,
    pending: pair.streamed.summary.pending,
  }).toEqual({ passed: want.passed, failed: want.failed, pending: want.pending });
}

// ═══════════════════════════════════════════════════════════════════════════

describe("every captured nextest run is compared", () => {
  test("the fixture tree holds the nine captured runs, each with a stream, a list and a JUnit report", () => {
    for (const name of CAPTURED_RUNS) {
      const run = capturedRun(name);
      expect(run.stream.length, name).toBeGreaterThan(0);
      expect(run.list.length, name).toBeGreaterThan(0);
      expect(run.junit, name).toContain("<testsuites");
    }
    expect(CAPTURED_RUNS.length).toBe(9);
  });
});

describe("a nextest stream, with its list posted, is stored as the record nextest's JUnit report is stored as", () => {
  const plain: ReadonlyArray<[CapturedRunName, string]> = [
    ["all-pass", "a run whose every test passes"],
    ["a-failure", "a run with a failure whose test prints before a two-line panic"],
    ["distinct-targets", "a lib, a bin and an integration target with distinct names, a failure and an ignored test"],
    ["same-name", "a crate whose lib, bin and integration test share its name"],
    ["spawned-thread-panic", "a panic in a spawned thread before the test's own"],
    ["should-panic-without-a-panic", "a #[should_panic] test that does not panic"],
    ["err-return", "a test returning Err"],
  ];
  for (const [name, label] of plain) {
    test(`${label} (${name}): same suites, names, statuses, counts and messages, durations within 1 ms`, async () => {
      const run = capturedRun(name);
      const pair = await bothRecords(run);
      expectShape(name, pair);
      expectSameRecord(run, pair);
    });
  }

  test("the same-name crate's tests land in its three binaries' suites, as JUnit names them", async () => {
    const pair = await bothRecords(capturedRun("same-name"));
    expect(pair.streamed.tree.map((s) => s.name).sort(byText)).toEqual(["nxsame", "nxsame::bin/nxsame", "nxsame::nxsame"]);
  });

  test("the ignored test of the distinct-targets run is a pending leaf in its lib's suite, absent from JUnit", async () => {
    const pair = await bothRecords(capturedRun("distinct-targets"));
    const lib = pair.streamed.tree.find((s) => s.name === "nx-targets");
    expect(lib?.children.find((l) => l.name === "tests::waits_for_a_fix")?.status).toBe("pending");
    expect(rowsOf(pair.junit.tree).map((r) => r.name)).not.toContain("tests::waits_for_a_fix");
  });

  test("a flaky test under retries (flaky-retries): the same record — EXEMPT for the test failing every attempt: the thread id in its message and its duration", async () => {
    const run = capturedRun("flaky-retries");
    const pair = await bothRecords(run);
    expectShape("flaky-retries", pair);
    // JUnit keeps the first attempt of `flaky::always_fails`, the stream its last:
    // the two messages differ only in the attempt's thread id.
    const withoutThreadId = (row: Row) =>
      row.name === "flaky::always_fails" ? row.message?.replace(/\(\d+\)/, "(<tid>)") : row.message;
    expectSameRecord(run, pair, { message: withoutThreadId, noDuration: ["flaky::always_fails"] });
    const leaves = rowsOf(pair.streamed.tree);
    expect(leaves.find((r) => r.name === "flaky::flips")?.status).toBe("pass");
    expect(leaves.find((r) => r.name === "flaky::always_fails")?.message).toMatch(
      /^thread 'flaky::always_fails' \(\d+\) panicked at src\/lib\.rs:19:9$/,
    );
  });

  test("a test past its slow-timeout (timeout): the same record — EXEMPT: the timeout's message, which JUnit's timeout failure does not state", async () => {
    const run = capturedRun("timeout");
    const pair = await bothRecords(run);
    expectShape("timeout", pair);
    const noTimeoutMessage = (row: Row) => (row.name === "waits::hangs" ? undefined : row.message);
    expectSameRecord(run, pair, { message: noTimeoutMessage });
    const hangs = rowsOf(pair.streamed.tree).find((r) => r.name === "waits::hangs");
    expect(hangs?.status).toBe("fail");
    expect(hangs?.message).toBe("time limit exceeded");
  });
});
