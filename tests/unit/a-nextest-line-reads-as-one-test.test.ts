// How a nextest stream's lines read into the stored record — on a real
// board (`bootInProcess`, no socket, ":memory:"), each stream closed under the
// `nextest` codec and read back through `GET /api/v2/events/<id>`.
//
// The lines are nextest's own `libtest-json-plus` shapes (message format 0.1),
// as the captured runs under `tests/fixtures/nextest/runs/` hold them:
//  - a test result (`ok`, `failed`, `ignored`) is one test: `ok` passes,
//    `failed` fails, `ignored` is pending;
//  - its name is the path after `$`, a retry suffix `#<n>` removed, and its
//    duration is `exec_time` in milliseconds;
//  - a timeout's failure message is its `reason`;
//  - a test whose `started` line has no result is not a test;
//  - a suite line's figures, repeated or miscounted, change nothing;
//  - a failure's message is the first found in its `stdout`: the test's own
//    thread's panic line (cut before its trailing colon), a `note: test did
//    not panic as expected` line, the first `thread '` line, the first
//    non-blank line. Its body is the `stdout`, and it carries no type.
import { describe, test, expect, afterEach } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import {
  closedNextestRun,
  listOf,
  panicStdout,
  suiteResult,
  suiteStarted,
  testFailed,
  testIgnored,
  testName,
  testOk,
  testStarted,
  type NextestRunPlan,
} from "../helpers/nextest-harness.ts";
import { bootInProcess, type StoredRun } from "../helpers/run-stream-harness.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

const AGENT = "nextest-reader";

async function record(plan: NextestRunPlan): Promise<StoredRun> {
  const handle = bootInProcess();
  handles.push(handle);
  return (await closedNextestRun(handle, AGENT, plan)).event;
}

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

function treeOf(event: StoredRun): Node[] {
  return event.tree as unknown as Node[];
}

function leafNamed(event: StoredRun, name: string): Leaf {
  const found = treeOf(event).flatMap((s) => s.children.filter((l) => l.name === name));
  expect(found.length, `exactly one leaf named ${name}`).toBe(1);
  return found[0]!;
}

const CRATE = "nxlines";

function lib(path: string): string {
  return testName(CRATE, CRATE, path);
}

const LIB_STARTED = suiteStarted(CRATE, CRATE, "lib", 3);

// ═══════════════════════════════════════════════════════════════════════════

describe("a nextest test result is one test", () => {
  test("ok passes, failed fails and ignored is pending; the leaf names the path after $, its duration exec_time in ms", async () => {
    const stream =
      LIB_STARTED +
      testStarted(lib("tests::adds")) +
      testStarted(lib("tests::breaks")) +
      testStarted(lib("tests::later")) +
      testOk(lib("tests::adds"), 0.012) +
      testFailed(lib("tests::breaks"), 0.034, { stdout: panicStdout("tests::breaks", 41, "src/lib.rs:9:5", "it broke") }) +
      testIgnored(lib("tests::later"));
    const event = await record({ stream });
    expect(treeOf(event).map((s) => s.name)).toEqual([CRATE]);
    expect(treeOf(event)[0]!.children.map((l) => [l.name, l.status])).toEqual([
      ["tests::adds", "pass"],
      ["tests::breaks", "fail"],
      ["tests::later", "pending"],
    ]);
    expect(leafNamed(event, "tests::adds").duration_ms).toBe(12);
    expect(leafNamed(event, "tests::breaks").duration_ms).toBe(34);
    expect(event.summary).toMatchObject({ total: 3, passed: 1, failed: 1, pending: 1 });
  });
});

describe("a retried test's #<n> suffix is gone from its name", () => {
  test("a flaky test's passing attempt #2 and an always-failing test's attempt #3 are stored as their paths, once each", async () => {
    const stream =
      LIB_STARTED +
      testStarted(lib("flaky::flips")) +
      testStarted(lib("flaky::always_fails")) +
      testOk(lib("flaky::flips#2"), 0.003) +
      testFailed(lib("flaky::always_fails#3"), 0.003, {
        stdout: panicStdout("flaky::always_fails", 77, "src/lib.rs:19:9", "every attempt fails"),
      });
    const event = await record({ stream });
    const names = treeOf(event).flatMap((s) => s.children.map((l) => l.name));
    expect(names).toEqual(["flaky::flips", "flaky::always_fails"]);
    expect(names.some((n) => n.includes("#"))).toBe(false);
    expect(leafNamed(event, "flaky::flips").status).toBe("pass");
    expect(leafNamed(event, "flaky::always_fails").status).toBe("fail");
  });
});

describe("a timeout's failure message is its reason", () => {
  test('a failed line with no stdout and reason "time limit exceeded" fails with that message and body, and no type', async () => {
    const stream =
      LIB_STARTED +
      testStarted(lib("waits::hangs")) +
      testFailed(lib("waits::hangs"), 2.002948251, { reason: "time limit exceeded" });
    const event = await record({ stream });
    const hangs = leafNamed(event, "waits::hangs");
    expect(hangs.status).toBe("fail");
    expect(hangs.duration_ms).toBe(2003);
    expect(hangs.failure?.message).toBe("time limit exceeded");
    expect(hangs.failure?.trace?.trim()).toBe("time limit exceeded");
    expect(hangs.failure?.type).toBeUndefined();
  });
});

describe("only a result is a test", () => {
  test("a test whose started line has no result is not a test: no leaf, and no count", async () => {
    const stream =
      LIB_STARTED +
      testStarted(lib("tests::adds")) +
      testStarted(lib("tests::never_finished")) +
      testOk(lib("tests::adds"), 0.002);
    const event = await record({ stream });
    expect(treeOf(event).flatMap((s) => s.children.map((l) => l.name))).toEqual(["tests::adds"]);
    expect(event.summary).toMatchObject({ total: 1, passed: 1, failed: 0, pending: 0 });
  });

  test("a suite line's repeated and miscounted figures change nothing: the record is the one the same results make without them", async () => {
    const results =
      testStarted(lib("tests::adds")) +
      testStarted(lib("tests::breaks")) +
      testOk(lib("tests::adds"), 0.002) +
      testFailed(lib("tests::breaks"), 0.003, { stdout: panicStdout("tests::breaks", 9, "src/lib.rs:4:1", "no") });
    // As a real run reported one binary: `failed` 1/1, then re-opened, then `ok` 1/0 — and a figure no test makes.
    const noisy =
      LIB_STARTED +
      results +
      suiteResult(CRATE, CRATE, "lib", "failed", { passed: 1, failed: 1, ignored: 0 }) +
      LIB_STARTED +
      suiteResult(CRATE, CRATE, "lib", "ok", { passed: 1, failed: 0, ignored: 0 }) +
      suiteResult(CRATE, CRATE, "lib", "failed", { passed: 40, failed: 9, ignored: 3 });
    const quiet = LIB_STARTED + results;

    const withFigures = await record({ stream: noisy });
    const without = await record({ stream: quiet });
    expect(withFigures.summary).toEqual(without.summary);
    expect(withFigures.tree).toEqual(without.tree);
    expect(withFigures.summary).toMatchObject({ total: 2, passed: 1, failed: 1, pending: 0 });
    expect(Object.keys(withFigures)).not.toContain("incomplete");
  });
});

describe("a failure's message is the first rule its stdout meets", () => {
  async function messageOf(path: string, stdout: string): Promise<Failure | undefined> {
    const stream = LIB_STARTED + testStarted(lib(path)) + testFailed(lib(path), 0.003, { stdout });
    return leafNamed(await record({ stream }), path).failure;
  }

  test("the test's own thread's panic line, cut before its colon — over an earlier spawned thread's and printed output", async () => {
    const stdout =
      "printed first\n\nthread '<unnamed>' (11) panicked at src/lib.rs:6:27:\nthe spawned thread panics\n" +
      "\nthread 'tests::child_panic' (10) panicked at src/lib.rs:8:10:\ncalled `Result::unwrap()` on an `Err` value\n";
    const failure = await messageOf("tests::child_panic", stdout);
    expect(failure?.message).toBe("thread 'tests::child_panic' (10) panicked at src/lib.rs:8:10");
    expect(failure?.trace?.trim()).toBe(stdout.trim());
    expect(failure?.type).toBeUndefined();
  });

  test("a should_panic test that did not panic: the line starting `note: test did not panic as expected`", async () => {
    const stdout =
      "test tests::never_panics - should panic ... FAILED\n\nfailures:\n\n---- tests::never_panics stdout ----\n" +
      "note: test did not panic as expected at src/lib.rs:13:4\n\nfailures:\n    tests::never_panics\n";
    const failure = await messageOf("tests::never_panics", stdout);
    expect(failure?.message).toBe("note: test did not panic as expected at src/lib.rs:13:4");
    expect(failure?.type).toBeUndefined();
  });

  test("with no line of the test's own thread: the first line starting `thread '`, cut the same way", async () => {
    const stdout = "\nthread 'worker-1' (12) panicked at src/pool.rs:3:9:\nworker died\n";
    const failure = await messageOf("tests::pool", stdout);
    expect(failure?.message).toBe("thread 'worker-1' (12) panicked at src/pool.rs:3:9");
  });

  test("with no thread line at all (a test returning Err): the first non-blank line", async () => {
    const stdout = '\n  \nError: "the result is an error"\nmore\n';
    const failure = await messageOf("tests::returns_err", stdout);
    expect(failure?.message).toBe('Error: "the result is an error"');
    expect(failure?.type).toBeUndefined();
  });
});

describe("a listed run reads the same lines the same way", () => {
  test("the results resolve to the listed binary, and the record matches the list's total, unflagged", async () => {
    const stream =
      LIB_STARTED + testStarted(lib("tests::adds")) + testOk(lib("tests::adds#2"), 0.001) + testStarted(lib("tests::stuck"));
    const list = listOf([{ crate: CRATE, binaryName: CRATE, kind: "lib", tests: [{ path: "tests::adds", matches: true }] }]);
    const event = await record({ stream, list });
    expect(treeOf(event).map((s) => [s.name, s.children.map((l) => l.name)])).toEqual([[CRATE, ["tests::adds"]]]);
    expect(Object.keys(event)).not.toContain("incomplete");
  });
});
