// An open run takes nextest's own test list — on a real server
// (`startServer`, port 0, ":memory:", or the operator `crucible.toml` for the
// size bound):
//  - `POST /api/v2/runs/<runId>/tests {projectKey, agentId, codec:
//    "nextest-list", data}` gives an open run the list, as
//    `cargo nextest list --message-format json` wrote it, once (200);
//  - the run's listed total is the list's tests whose `filter-match` is
//    `matches`, and it replaces the run start's total;
//  - a second list is a 409, a settled run's a 409, a body past
//    `ingest_body_bytes` a 413, `data` that is not a nextest list a 400, an
//    unknown run or another agent's a 400 — each storing nothing;
//  - with a list, a crate whose lib, bin and integration test share its name
//    has its results land in its three binaries' suites; without one they
//    land in one suite `<crate>::<name>` and the run is flagged naming it.
//
// "Stores nothing" is read the one way the board shows it: a valid list sent
// after the refusal is still taken (200), and its total is the one the live
// state reads.
import { describe, test, expect, afterEach } from "bun:test";
import { shippedLimits } from "../../src/limits.ts";
import type { ServerHandle } from "../../src/server.ts";
import {
  capturedRun,
  closedNextestRun,
  closeNextest,
  LIST_CODEC,
  listOf,
  postList,
  streamNextest,
  suiteStarted,
  testName,
  testOk,
  testsRoute,
} from "../helpers/nextest-harness.ts";
import { bootOn, openRun, postJson, readyProject, storedEvent } from "../helpers/run-stream-harness.ts";
import {
  boot as bootWithOperatorFile,
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
} from "../helpers/server-limits-fixture.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  restoreServerLimitsFixture();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "nextest-lister";
const OTHER = "another-agent";
const CRATE = "nxlist";

const lib = (path: string): string => testName(CRATE, CRATE, path);

/** A list of three lib tests, two matched by the run's filter: a listed total of 2. */
const LIST_OF_TWO = listOf([
  {
    crate: CRATE,
    binaryName: CRATE,
    kind: "lib",
    tests: [
      { path: "tests::a", matches: true },
      { path: "tests::b", matches: true },
      { path: "tests::c", matches: false },
    ],
  },
]);

/** A list of five matched tests: a listed total of 5. */
const LIST_OF_FIVE = listOf([
  {
    crate: CRATE,
    binaryName: CRATE,
    kind: "lib",
    tests: ["t1", "t2", "t3", "t4", "t5"].map((path) => ({ path, matches: true })),
  },
]);

/** The first batch every total is read after: one pass. */
const ONE_PASS = suiteStarted(CRATE, CRATE, "lib", 3) + testOk(lib("tests::a"), 0.001);

interface Subject {
  handle: ServerHandle;
  key: string;
  runId: string;
}

async function subject(handle: ServerHandle = boot(), startTotal?: number): Promise<Subject> {
  const key = await readyProject(handle, [AGENT, OTHER], "nextest-list");
  const runId = await openRun(handle, key, AGENT, {
    stack: "rust",
    tier: "unit",
    ...(startTotal !== undefined ? { total: startTotal } : {}),
  });
  return { handle, key, runId };
}

/** The total the run's live state reads after its first batch. */
async function liveTotalAfterABatch(s: Subject): Promise<number | undefined> {
  await streamNextest(s.handle, s.runId, s.key, AGENT, ONE_PASS);
  return s.handle.store.runLive(s.runId)?.total;
}

/** Nothing was stored: the valid list is still taken, and the total is its own. */
async function expectStillTakesAList(s: Subject): Promise<void> {
  const res = await postList(s.handle, s.runId, s.key, AGENT, LIST_OF_TWO);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(await liveTotalAfterABatch(s)).toBe(2);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("an open run takes one test list", () => {
  test("the first list is a 200, and the run's total is the list's tests whose filter-match is matches", async () => {
    const s = await subject();
    const res = await postList(s.handle, s.runId, s.key, AGENT, LIST_OF_TWO);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await liveTotalAfterABatch(s)).toBe(2);
  });

  test("a captured list from a filtered run: of its five tests, the one its filter matches is the total the close checks", async () => {
    const s = await subject();
    const res = await postList(s.handle, s.runId, s.key, AGENT, capturedRun("err-return").list);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The captured err-return stream, plus a second result: two results against a listed total of 1 (not test-count's 5).
    await streamNextest(
      s.handle,
      s.runId,
      s.key,
      AGENT,
      capturedRun("err-return").stream + testOk(testName("nxshapes", "shapes", "passes"), 0.001),
    );
    const closed = await closeNextest(s.handle, s.key, AGENT, s.runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const event = await storedEvent(s.handle, closed.body.event);
    expect(event.incomplete).toBe("the run listed 1 tests, the stream holds 2");
  });

  test("the listed total replaces the run start's: a start total of 40 reads the list's 2", async () => {
    const s = await subject(boot(), 40);
    const res = await postList(s.handle, s.runId, s.key, AGENT, LIST_OF_TWO);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await liveTotalAfterABatch(s)).toBe(2);
  });

  test("a second list is a 409, and the first list's total stands", async () => {
    const s = await subject();
    expect((await postList(s.handle, s.runId, s.key, AGENT, LIST_OF_TWO)).status).toBe(200);
    const second = await postList(s.handle, s.runId, s.key, AGENT, LIST_OF_FIVE);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(await liveTotalAfterABatch(s)).toBe(2);
  });

  test("a settled run's list is a 409, and the stored run is unchanged", async () => {
    const s = await subject();
    await streamNextest(s.handle, s.runId, s.key, AGENT, ONE_PASS);
    const closed = await closeNextest(s.handle, s.key, AGENT, s.runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const before = await storedEvent(s.handle, closed.body.event);
    const res = await postList(s.handle, s.runId, s.key, AGENT, LIST_OF_TWO);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(s.handle.store.getRun(s.runId)?.state).toBe("ended");
    expect(await storedEvent(s.handle, closed.body.event)).toEqual(before);
  });
});

describe("a list the route refuses stores nothing", () => {
  const NOT_A_LIST: ReadonlyArray<[string, unknown]> = [
    ["text that is not JSON", "running 3 tests\ntest a ... ok\n"],
    ["JSON that is not a nextest list", '{"tests":["a","b"]}'],
    ["a nextest stream line", `${JSON.stringify({ type: "suite", event: "started", test_count: 1 })}\n`],
    ["a JUnit report", capturedRun("all-pass").junit],
    ["no data at all", undefined],
  ];
  for (const [label, data] of NOT_A_LIST) {
    test(`data that is ${label} is a 400; a valid list is still taken after it`, async () => {
      const s = await subject();
      const res = await postList(s.handle, s.runId, s.key, AGENT, data);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      await expectStillTakesAList(s);
    });
  }

  test("an unknown run is a 400", async () => {
    const s = await subject();
    const res = await postList(s.handle, "run-never-issued", s.key, AGENT, LIST_OF_TWO);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    await expectStillTakesAList(s);
  });

  test("another agent's run is a 400, and its owner can still give it a list", async () => {
    const s = await subject();
    const res = await postList(s.handle, s.runId, s.key, OTHER, LIST_OF_FIVE);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    await expectStillTakesAList(s);
  });

  test("a body past ingest_body_bytes is a 413 naming the limit; a valid list is still taken after it", async () => {
    const shipped = shippedLimits().ingest_body_bytes;
    expect(shipped, "src/crucible.toml declares no [limits.ingest_body_bytes] table").toBeDefined();
    if (shipped === undefined) return;
    const limit = shipped.min;
    writeConfig(serverConfigDir(), { ingest_body_bytes: declare(shipped, limit) });
    const s = await subject(bootWithOperatorFile());
    const valid = JSON.stringify({ projectKey: s.key, agentId: AGENT, codec: LIST_CODEC, data: LIST_OF_FIVE });
    const res = await postJson(s.handle, testsRoute(s.runId), valid + " ".repeat(limit + 4096 - valid.length));
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body.error as string).toContain("ingest_body_bytes");
    await expectStillTakesAList(s);
  }, 30_000);

  test("a codec other than nextest-list is a 400; a valid list is still taken after it", async () => {
    const s = await subject();
    const res = await postList(s.handle, s.runId, s.key, AGENT, LIST_OF_FIVE, "junit");
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    await expectStillTakesAList(s);
  });
});

describe("the list names the binaries a crate's same-named targets share", () => {
  test("with the captured list, the same-name crate's results land in its three suites, unflagged", async () => {
    const run = capturedRun("same-name");
    const closed = await closedNextestRun(boot(), AGENT, { stream: run.stream, list: run.list });
    const tree = closed.event.tree as Array<{ name: string; children: Array<{ name: string }> }>;
    const bySuite = Object.fromEntries(tree.map((s) => [s.name, s.children.map((l) => l.name).sort((a, b) => a.localeCompare(b))]));
    expect(bySuite).toEqual({
      "nxsame::bin/nxsame": ["bin_tests::bin_fails", "bin_tests::bin_ok"],
      nxsame: ["lib_tests::lib_ok"],
      "nxsame::nxsame": ["integration_ok"],
    });
    expect(Object.keys(closed.event)).not.toContain("incomplete");
  });

  test("without a list, they land in one suite nxsame::nxsame, and the run is flagged naming it", async () => {
    const run = capturedRun("same-name");
    const closed = await closedNextestRun(boot(), AGENT, { stream: run.stream });
    const tree = closed.event.tree as Array<{ name: string; children: Array<{ name: string }> }>;
    expect(tree.map((s) => s.name)).toEqual(["nxsame::nxsame"]);
    expect(tree[0]!.children.length).toBe(4);
    expect(typeof closed.event.incomplete).toBe("string");
    expect(closed.event.incomplete as string).toContain("nxsame::nxsame");
  });

  test("without a list, distinct-named targets resolve from the stream's suite lines: three suites, unflagged", async () => {
    const run = capturedRun("distinct-targets");
    const closed = await closedNextestRun(boot(), AGENT, { stream: run.stream });
    const names = (closed.event.tree as Array<{ name: string }>).map((s) => s.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(["nx-targets", "nx-targets::bin/tool", "nx-targets::it"]);
    expect(Object.keys(closed.event)).not.toContain("incomplete");
  });
});

describe("the route's caller rules are the stream route's", () => {
  test("an unregistered caller is refused and stores nothing", async () => {
    const s = await subject();
    const res = await postList(s.handle, s.runId, s.key, "never-registered", LIST_OF_FIVE);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    await expectStillTakesAList(s);
  });
});
