// A nextest run's record is checked at its close — on a real server
// (`startServer`, port 0, ":memory:", or the operator `crucible.toml` for the
// size bound). The run is stored flagged `incomplete`, each reason stated,
// when:
//  - its passed and failed tests differ from its total (the listed total,
//    else the run start's) when that total is above 0: "the run listed N
//    tests, the stream holds M" — a total of 0, or none, is not checked;
//  - a result's binary cannot be resolved to one test binary, naming it;
//  - it holds an undecodable line;
//  - it was cut at `ingest_body_bytes`.
// A run that matches is not flagged. An aborted nextest run keeps its decoded
// record, flagged.
//
// The flag is read where the stream suites read it: the stored event's
// `incomplete`, and the close's `stream-incomplete` warning.
import { describe, test, expect, afterEach } from "bun:test";
import { shippedLimits } from "../../src/limits.ts";
import type { ServerHandle } from "../../src/server.ts";
import {
  closedNextestRun,
  closeNextest,
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
  type ClosedNextestRun,
  type NextestRunPlan,
} from "../helpers/nextest-harness.ts";
import {
  bootOn,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  storedEvent,
  utf8,
  type Answer,
} from "../helpers/run-stream-harness.ts";
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

const AGENT = "nextest-checker";
const CRATE = "nxcheck";

const lib = (path: string): string => testName(CRATE, CRATE, path);

const LIB = suiteStarted(CRATE, CRATE, "lib", 3);
const PASS_A = testStarted(lib("tests::a")) + testOk(lib("tests::a"), 0.002);
const FAIL_B =
  testStarted(lib("tests::b")) +
  testFailed(lib("tests::b"), 0.003, { stdout: panicStdout("tests::b", 7, "src/lib.rs:5:9", "b broke") });
const IGNORED_C = testStarted(lib("tests::c")) + testIgnored(lib("tests::c"));

/** A list of the lib's `paths`, each matched by the run's filter. */
function listed(paths: readonly string[]): string {
  return listOf([{ crate: CRATE, binaryName: CRATE, kind: "lib", tests: paths.map((path) => ({ path, matches: true })) }]);
}

async function close(plan: NextestRunPlan): Promise<ClosedNextestRun> {
  return closedNextestRun(boot(), AGENT, plan);
}

function incompleteWarnings(answer: Answer): Array<{ code: string; detail: string }> {
  const warnings = (answer.body.warnings ?? []) as Array<{ code: string; detail: string }>;
  return warnings.filter((w) => w.code === "stream-incomplete");
}

function expectUnflagged(run: ClosedNextestRun): void {
  expect(Object.keys(run.event)).not.toContain("incomplete");
  expect(incompleteWarnings(run.answer)).toEqual([]);
}

function expectFlaggedWith(run: ClosedNextestRun, ...parts: string[]): string {
  const reason = run.event.incomplete;
  expect(typeof reason, "the stored event states why it is incomplete").toBe("string");
  for (const part of parts) expect(reason as string).toContain(part);
  const warnings = incompleteWarnings(run.answer);
  expect(warnings.length, JSON.stringify(run.answer.body.warnings)).toBe(1);
  for (const part of parts) expect(warnings[0]!.detail).toContain(part);
  return reason as string;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a nextest run whose passed and failed tests differ from its total is flagged, naming both figures", () => {
  test('a listed total of 3 and a stream holding a pass, a failure and an ignored test: "the run listed 3 tests, the stream holds 2"', async () => {
    const run = await close({ stream: LIB + PASS_A + FAIL_B + IGNORED_C, list: listed(["tests::a", "tests::b", "tests::d"]) });
    expect(expectFlaggedWith(run, "the run listed 3 tests, the stream holds 2")).toBe(
      "the run listed 3 tests, the stream holds 2",
    );
    // The record is still the stream's tests.
    expect(run.event.summary).toMatchObject({ total: 3, passed: 1, failed: 1, pending: 1 });
  });

  test('with no list, the run start\'s total of 4 and two results: "the run listed 4 tests, the stream holds 2"', async () => {
    const run = await close({ stream: LIB + PASS_A + FAIL_B, startTotal: 4 });
    expect(expectFlaggedWith(run, "the run listed 4 tests, the stream holds 2")).toBe(
      "the run listed 4 tests, the stream holds 2",
    );
  });

  test("more results than listed is flagged too: a listed total of 2 and three results", async () => {
    const twoOfThree = listOf([
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
    const passC = testStarted(lib("tests::c")) + testOk(lib("tests::c"), 0.001);
    const run = await close({ stream: LIB + PASS_A + FAIL_B + passC, list: twoOfThree });
    expectFlaggedWith(run, "the run listed 2 tests, the stream holds 3");
  });
});

describe("a nextest run that matches its total, or has none to match, is not flagged", () => {
  test("a listed total of 2 and a pass, a failure and an ignored test: no incomplete key, no stream-incomplete warning", async () => {
    expectUnflagged(await close({ stream: LIB + PASS_A + FAIL_B + IGNORED_C, list: listed(["tests::a", "tests::b"]) }));
  });

  test("a run start total of 0 and no list is not checked: two results close unflagged", async () => {
    expectUnflagged(await close({ stream: LIB + PASS_A + FAIL_B, startTotal: 0 }));
  });

  test("no total at all is not checked: two results close unflagged", async () => {
    expectUnflagged(await close({ stream: LIB + PASS_A + FAIL_B }));
  });

  test("a list matching no test is a total of 0, not checked: a result closes unflagged", async () => {
    const none = listOf([
      { crate: CRATE, binaryName: CRATE, kind: "lib", tests: [{ path: "tests::a", matches: false }] },
    ]);
    expectUnflagged(await close({ stream: LIB + PASS_A, list: none }));
  });
});

describe("a result whose binary cannot be resolved flags the run, naming it", () => {
  test("no list, and suite lines giving <crate>::<binary> two kinds: the suite is that key, and the reason names it", async () => {
    const stream =
      suiteStarted("nxdup", "nxdup", "bin", 1) +
      suiteStarted("nxdup", "nxdup", "lib", 1) +
      testStarted(testName("nxdup", "nxdup", "t::one")) +
      testOk(testName("nxdup", "nxdup", "t::one"), 0.001);
    const run = await close({ stream });
    expect((run.event.tree as Array<{ name: string }>).map((s) => s.name)).toEqual(["nxdup::nxdup"]);
    expectFlaggedWith(run, "nxdup::nxdup");
  });

  test("no list, and no suite line for the result's binary: the suite is <crate>::<binary>, and the reason names it", async () => {
    const stream = testStarted(testName("nxlost", "probe", "t::one")) + testOk(testName("nxlost", "probe", "t::one"), 0.001);
    const run = await close({ stream });
    expect((run.event.tree as Array<{ name: string }>).map((s) => s.name)).toEqual(["nxlost::probe"]);
    expectFlaggedWith(run, "nxlost::probe");
  });
});

describe("an undecodable line flags the run", () => {
  test("a line that is not JSON and a JSON line of no known shape: flagged as undecodable, the tests still recorded", async () => {
    const stream = LIB + PASS_A + "this is not json\n" + '{"type":"bench","event":"measured","name":"x"}\n' + FAIL_B;
    const run = await close({ stream, list: listed(["tests::a", "tests::b"]) });
    expectFlaggedWith(run, "undecodable");
    expect(run.event.summary).toMatchObject({ total: 2, passed: 1, failed: 1, pending: 0 });
  });

  test("each reason is stated: a short stream holding an undecodable line names its figures and the undecodable line", async () => {
    const stream = LIB + PASS_A + "{not json\n";
    const run = await close({ stream, list: listed(["tests::a", "tests::b"]) });
    expectFlaggedWith(run, "the run listed 2 tests, the stream holds 1", "undecodable");
  });
});

describe("a nextest stream cut at ingest_body_bytes flags the run", () => {
  test(
    'a held stream whose next batch was refused at the size bound closes flagged "cut at ingest_body_bytes"',
    async () => {
      const shipped = shippedLimits().ingest_body_bytes;
      expect(shipped, "src/crucible.toml declares no [limits.ingest_body_bytes] table").toBeDefined();
      if (shipped === undefined) return;
      const limit = shipped.min;
      writeConfig(serverConfigDir(), { ingest_body_bytes: declare(shipped, limit) });
      const handle = bootWithOperatorFile();
      const key = await readyProject(handle, [AGENT]);
      const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });
      const listedTwo = await postList(handle, runId, key, AGENT, listed(["tests::a", "tests::b"]));
      expect(listedTwo.status, JSON.stringify(listedTwo.body)).toBe(200);

      const whole = LIB + PASS_A + FAIL_B;
      await streamNextest(handle, runId, key, AGENT, whole);
      // A line no codec reads fills the stream to the limit… (a padded `started` line: not a test)
      const head = '{"type":"test","event":"started","name":"';
      const tail = '"}\n';
      const pad = `${head}${"a".repeat(limit - utf8(whole) - head.length - tail.length)}${tail}`;
      const filled = await sendBatch(handle, runId, {
        projectKey: key,
        agentId: AGENT,
        codec: NEXTEST_CODEC,
        from: utf8(whole),
        data: pad,
      });
      expect(filled.status, JSON.stringify(filled.body)).toBe(200);
      expect(filled.body.held).toBe(limit);
      // …and the batch past it is refused, which cuts the stream.
      const past = await sendBatch(handle, runId, {
        projectKey: key,
        agentId: AGENT,
        codec: NEXTEST_CODEC,
        from: limit,
        data: IGNORED_C,
      });
      expect(past.status, JSON.stringify(past.body)).toBe(413);

      const answer = await closeNextest(handle, key, AGENT, runId);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const event = await storedEvent(handle, answer.body.event);
      expect(event.summary).toMatchObject({ total: 2, passed: 1, failed: 1, pending: 0 });
      expectFlaggedWith({ key, runId, answer, event }, "cut at ingest_body_bytes");
    },
    30_000,
  );
});

describe("an aborted nextest run keeps its decoded record, flagged", () => {
  async function abortedAfter(stream: string, list: string): Promise<{ aborted: Record<string, unknown>; closed: ClosedNextestRun }> {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });
    const posted = await postList(handle, runId, key, AGENT, list);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    await streamNextest(handle, runId, key, AGENT, stream);
    const res = await postJson(handle, `/api/v2/runs/${runId}/abort`, { projectKey: key, agentId: AGENT, reason: "runner killed" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const run = handle.store.getRun(runId);
    expect(run?.state).toBe("aborted");
    const aborted = await storedEvent(handle, run?.eventId);
    // The oracle: what the close stores from the same list and stream.
    const closed = await closedNextestRun(boot(), AGENT, { stream, list });
    return { aborted, closed };
  }

  test("a run aborted after two of its three listed results keeps their tree and counts, flagged with the figures", async () => {
    const { aborted, closed } = await abortedAfter(LIB + PASS_A + FAIL_B, listed(["tests::a", "tests::b", "tests::c"]));
    expect(aborted.status).toBe("aborted");
    expect(aborted.abortReason).toBe("runner killed");
    expect(aborted.summary).toMatchObject({ total: 2, passed: 1, failed: 1, pending: 0 });
    expect(aborted.tree).toEqual(closed.event.tree);
    expect(aborted.incomplete as string).toContain("the run listed 3 tests, the stream holds 2");
  });

  test("a run aborted with its whole stream held keeps its record, still flagged incomplete", async () => {
    const { aborted, closed } = await abortedAfter(LIB + PASS_A + FAIL_B, listed(["tests::a", "tests::b"]));
    expect(aborted.summary).toMatchObject({ total: 2, passed: 1, failed: 1, pending: 0 });
    expect(aborted.tree).toEqual(closed.event.tree);
    expect(typeof aborted.incomplete).toBe("string");
    expect((aborted.incomplete as string).length).toBeGreaterThan(0);
  });
});
