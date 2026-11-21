// The test list route and the batches after it — on a real board
// (`bootInProcess`, no socket, ":memory:"):
//  - a run that is gone by the time its list is taken (its project deleted
//    after the route checked the run, before the store takes the list) is
//    refused as an unknown run: a 400 naming the run unknown, never the 409 a
//    settled run gets, and nothing is stored;
//  - the list is read once, when the run takes it: over several batches of a
//    run with a list, no batch reads the stored list's text again, and each
//    batch's results still land in the suites the list names.
//
// "Read" is observed at the one place the stored list's text can be read
// back from: `JSON.parse` called on that exact text. The spy calls through,
// so the board behaves as it would without it.
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import type { BoardHandle } from "../../src/server.ts";
import {
  closeNextest,
  listOf,
  postList,
  streamNextest,
  suiteResult,
  suiteStarted,
  testFailed,
  testName,
  testOk,
} from "../helpers/nextest-harness.ts";
import { bootInProcess, openRun, readyProject, storedEvent } from "../helpers/run-stream-harness.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): BoardHandle {
  const handle = bootInProcess();
  handles.push(handle);
  return handle;
}

const AGENT = "list-reader";
const CRATE = "nxonce";

function dbOf(handle: BoardHandle): Database {
  return (handle.store as unknown as { db: Database }).db;
}

function listRows(handle: BoardHandle, runId: string): number {
  return dbOf(handle)
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run_test_lists WHERE run_id = ?")
    .get(runId)!.n;
}

/** A crate whose lib, bin and integration test all share its name: only the list tells their results apart. */
const LIST = listOf([
  {
    crate: CRATE,
    binaryName: CRATE,
    kind: "lib",
    tests: [
      { path: "lib_tests::lib_ok", matches: true },
      { path: "lib_tests::lib_fails", matches: true },
    ],
  },
  { crate: CRATE, binaryName: CRATE, kind: "bin", tests: [{ path: "bin_tests::bin_fails", matches: true }] },
  { crate: CRATE, binaryName: CRATE, kind: "test", tests: [{ path: "integration_fails", matches: true }] },
]);

const name = (path: string): string => testName(CRATE, CRATE, path);
const failed = (path: string): string => testFailed(name(path), 0.002, { stdout: `\nthread '${path}' panicked\n` });

/** One binary per batch, each with a failure. */
const BATCH_LIB =
  suiteStarted(CRATE, CRATE, "lib", 2) +
  testOk(name("lib_tests::lib_ok"), 0.001) +
  failed("lib_tests::lib_fails") +
  suiteResult(CRATE, CRATE, "lib", "failed", { passed: 1, failed: 1, ignored: 0 });
const BATCH_BIN =
  suiteStarted(CRATE, CRATE, "bin", 1) +
  failed("bin_tests::bin_fails") +
  suiteResult(CRATE, CRATE, "bin", "failed", { passed: 0, failed: 1, ignored: 0 });
const BATCH_TEST =
  suiteStarted(CRATE, CRATE, "test", 1) +
  failed("integration_fails") +
  suiteResult(CRATE, CRATE, "test", "failed", { passed: 0, failed: 1, ignored: 0 });

const STREAM = BATCH_LIB + BATCH_BIN + BATCH_TEST;
const CUTS = [BATCH_LIB.length, BATCH_LIB.length + BATCH_BIN.length];

/** The suite each failure lands in: the binary id the list gives its binary. */
const LISTED_FAILURES = [
  { suite: CRATE, name: "lib_tests::lib_fails" },
  { suite: `${CRATE}::bin/${CRATE}`, name: "bin_tests::bin_fails" },
  { suite: `${CRATE}::${CRATE}`, name: "integration_fails" },
];

interface Subject {
  handle: BoardHandle;
  key: string;
  runId: string;
}

async function subject(handle: BoardHandle = boot()): Promise<Subject> {
  const key = await readyProject(handle, [AGENT], "list-once");
  const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });
  return { handle, key, runId };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a run gone before its list is taken is refused as an unknown run", () => {
  test("its project deleted after the route checked the run: a 400 naming the run unknown, not a settled run's 409, and nothing stored", async () => {
    const s = await subject();
    const store = s.handle.store;
    const take = store.takeRunTestList.bind(store);
    const taken = spyOn(store, "takeRunTestList").mockImplementation((runId, text, total) => {
      // The run disappears between the route's check and the store's take.
      store.deleteProjectCascade(s.key);
      return take(runId, text, total);
    });
    try {
      const res = await postList(s.handle, s.runId, s.key, AGENT, LIST);
      expect(taken).toHaveBeenCalledTimes(1);
      expect(store.getRun(s.runId)).toBeNull();
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.ok).not.toBe(true);
      const error = String(res.body.error);
      expect(error).toMatch(/unknown run/i);
      expect(error).toContain(s.runId);
      expect(error).not.toContain("already");
      expect(error).not.toContain("ended");
      expect(Object.keys(res.body)).not.toContain("state");
      expect(listRows(s.handle, s.runId)).toBe(0);
    } finally {
      taken.mockRestore();
    }
  });
});

describe("the list is read once, when the run takes it", () => {
  test("over three batches, no batch reads the stored list again, and each batch's failure lands in its listed suite", async () => {
    const s = await subject();
    const listed = await postList(s.handle, s.runId, s.key, AGENT, LIST);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.total).toBe(4);

    const parse = spyOn(JSON, "parse");
    let listReads: number;
    try {
      await streamNextest(s.handle, s.runId, s.key, AGENT, STREAM, CUTS);
      listReads = parse.mock.calls.filter((call) => call[0] === LIST).length;
    } finally {
      parse.mockRestore();
    }
    expect(listReads, "batches that read the stored list's text again").toBe(0);

    const live = s.handle.store.runLive(s.runId);
    expect(live).toMatchObject({ completed: 4, total: 4, passed: 1, failed: 3, pending: 0 });
    expect(live?.failures.map((f) => ({ suite: f.suite, name: f.name }))).toEqual(LISTED_FAILURES);
  });

  test("the run closes into the listed suites, unflagged, after batches that did not read the list again", async () => {
    const s = await subject();
    const listed = await postList(s.handle, s.runId, s.key, AGENT, LIST);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    await streamNextest(s.handle, s.runId, s.key, AGENT, STREAM, CUTS);
    const closed = await closeNextest(s.handle, s.key, AGENT, s.runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const event = await storedEvent(s.handle, closed.body.event);
    const tree = event.tree as Array<{ name: string; children: Array<{ name: string }> }>;
    expect(Object.fromEntries(tree.map((suite) => [suite.name, suite.children.map((leaf) => leaf.name)]))).toEqual({
      [CRATE]: ["lib_tests::lib_ok", "lib_tests::lib_fails"],
      [`${CRATE}::bin/${CRATE}`]: ["bin_tests::bin_fails"],
      [`${CRATE}::${CRATE}`]: ["integration_fails"],
    });
    expect(Object.keys(event)).not.toContain("incomplete");
  });
});
