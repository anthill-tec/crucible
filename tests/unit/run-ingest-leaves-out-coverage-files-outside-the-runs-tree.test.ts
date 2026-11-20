// `POST /api/v2/runs` keeps, of a run's coverage, only the files inside the
// run's tree:
//
//  - a green bun run whose lcov names two files under `src/` and one that
//    climbs out of the tree answers the totals of the two, the count 2 and the
//    two files, and no warning: nothing says a file was left out;
//  - the read of the run's files (`?depth=coverage`) answers the same count
//    and files, and the directory the two share as the run's root;
//  - the run stores a row for each kept file and none for the other;
//  - the close of a streamed run answers as the single-shot ingest does;
//  - a run whose every coverage file climbs out is stored with its test
//    results and without coverage, as a run whose coverage cannot be decoded
//    is, and answers exactly one `coverage-dropped` warning that names the
//    block and says its files lie outside the run's tree.
//
// Each expectation is stated once and held against two runs: the run under
// test, and a run that already answers so — a run of the two files alone, and
// a run whose coverage text cannot be decoded.
//
// Driven through the real production router (`bootInProcess`, in-memory
// store, no socket); every stored outcome is read back through the board's own
// reads.
import { afterEach, describe, expect, test } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, postJson, readyProject, type Answer } from "../helpers/run-stream-harness.ts";
import {
  closeStreamedRun,
  dbOf,
  eventIdOf,
  eventRead,
  fileRowCount,
  lcovText,
  PASSING_REPORT,
  runBlockOf,
  storedFiles,
  type CoverageFile,
  type LcovRecord,
} from "../helpers/coverage-files-harness.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): BoardHandle {
  const handle = bootInProcess();
  handles.push(handle);
  return handle;
}

const AGENT = "tree-keeper";

const INSIDE_A: LcovRecord = { path: "src/a.ts", lf: 40, lh: 30, fnf: 5, fnh: 4 };
const INSIDE_B: LcovRecord = { path: "src/lib/b.ts", lf: 23, lh: 7, fnf: 3, fnh: 1 };
/** A module a test wrote to the system's temporary directory, named as bun names it. */
const CLIMBING: LcovRecord = { path: "../../tmp/x/c.mjs", lf: 622, lh: 230, fnf: 31, fnh: 9 };

const THREE_NAMES = { codec: "lcov", data: lcovText([INSIDE_A, INSIDE_B, CLIMBING]) };
const KEPT_ALONE = { codec: "lcov", data: lcovText([INSIDE_A, INSIDE_B]) };

/** The two kept files' totals, by hand: 37 of 63 lines and 5 of 8 functions. */
const KEPT_TOTALS = {
  lines: { total: 63, covered: 37, percent: 58.7 },
  functions: { total: 8, covered: 5, percent: 62.5 },
};

/** The two kept files as a read answers them, least covered first, by hand. */
const KEPT_FILES: CoverageFile[] = [
  { path: "src/lib/b.ts", lines: { total: 23, covered: 7, percent: 30.4 }, functions: { total: 3, covered: 1, percent: 33.3 } },
  { path: "src/a.ts", lines: { total: 40, covered: 30, percent: 75 }, functions: { total: 5, covered: 4, percent: 80 } },
];

/** A single-shot green bun run of two tests, filed with `coverage`. */
function bunRun(handle: BoardHandle, projectKey: string, coverage: unknown): Promise<Answer> {
  return postJson(handle, "/api/v2/runs", {
    projectKey,
    agentId: AGENT,
    stack: "bun",
    codec: "junit",
    data: PASSING_REPORT,
    coverage,
  });
}

type Filing = (handle: BoardHandle, projectKey: string, coverage: unknown) => Promise<Answer>;

const singleShot: Filing = bunRun;
const streamedClose: Filing = (handle, projectKey, coverage) => closeStreamedRun(handle, projectKey, AGENT, coverage);

/** The keys of an answer's `run` block that speak of coverage, sorted. */
function coverageKeysOf(answer: Answer): string[] {
  return Object.keys(runBlockOf(answer))
    .filter((key) => /coverage/i.test(key))
    .sort();
}

// ── What a run of the two kept files answers ────────────────────────────────

/** The answer names the two kept files' totals, the count 2 and the two files, and warns of nothing. */
function expectTheKeptCoverageAnswered(answer: Answer): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  const run = runBlockOf(answer);
  expect(run.coverage).toEqual(KEPT_TOTALS);
  expect(run.coverageFileCount).toBe(2);
  expect(run.coverageFiles).toEqual(KEPT_FILES);
  expect(coverageKeysOf(answer)).toEqual(["coverage", "coverageFileCount", "coverageFiles"]);
  // The test results stay beside it.
  expect(run.total).toBe(2);
  expect(run.passed).toBe(2);
  // Nothing says a file was left out.
  expect(answer.body.warnings).toBeUndefined();
  expect(JSON.stringify(answer.body)).not.toContain("c.mjs");
}

/** The read of the run's files answers the same count and files, and `src/` as their root. */
async function expectTheKeptCoverageReadBack(handle: BoardHandle, eventId: string): Promise<void> {
  const event = await eventRead(handle, eventId, "?depth=coverage");
  expect(event.coverageFileCount).toBe(2);
  expect(event.coverageFiles).toEqual(KEPT_FILES);
  expect(event.coverageRoot).toBe("src/");
  expect(event.coverage).toEqual(KEPT_TOTALS);
  expect(event.stack).toBe("bun");
}

/** The store holds a row for each of the two kept files, in the kept order, and no other. */
async function expectTheKeptRowsStored(handle: BoardHandle, eventId: string): Promise<void> {
  expect(fileRowCount(dbOf(handle.store), eventId)).toBe(2);
  const stored = await storedFiles(dbOf(handle.store), eventId);
  expect(stored.map((file) => file.path)).toEqual(["src/lib/b.ts", "src/a.ts"]);
  expect(stored.map((file) => [file.linesTotal, file.linesCovered, file.functionsTotal, file.functionsCovered])).toEqual([
    [23, 7, 3, 1],
    [40, 30, 5, 4],
  ]);
}

describe("a green bun run whose lcov names src/a.ts, src/lib/b.ts and ../../tmp/x/c.mjs", () => {
  test("answers the totals of the two files inside the tree, the count 2 and those two files, and no warning", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    expectTheKeptCoverageAnswered(await singleShot(handle, key, THREE_NAMES));
  });

  test("answers nothing that says a file was left out: its answer has the keys and the coverage of a run of the two files alone", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    const answer = await singleShot(handle, key, THREE_NAMES);
    const control = await singleShot(handle, key, KEPT_ALONE);

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(control.status, JSON.stringify(control.body)).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(Object.keys(control.body).sort());
    expect(Object.keys(runBlockOf(answer)).sort()).toEqual(Object.keys(runBlockOf(control)).sort());
    expect(runBlockOf(answer).coverage).toEqual(runBlockOf(control).coverage as object);
    expect(runBlockOf(answer).coverageFileCount).toBe(runBlockOf(control).coverageFileCount as number);
    expect(runBlockOf(answer).coverageFiles).toEqual(runBlockOf(control).coverageFiles as object);
  });

  test("is read back with the same count and files, and src/ as the root the kept files share", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    await expectTheKeptCoverageReadBack(handle, eventIdOf(await singleShot(handle, key, THREE_NAMES)));
  });

  test("stores a row for each of the two kept files and none for the third", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    await expectTheKeptRowsStored(handle, eventIdOf(await singleShot(handle, key, THREE_NAMES)));
  });

  test("closed as a streamed run, answers, is read back and is stored as the single-shot run is", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    const answer = await streamedClose(handle, key, THREE_NAMES);

    expectTheKeptCoverageAnswered(answer);
    await expectTheKeptCoverageReadBack(handle, eventIdOf(answer));
    await expectTheKeptRowsStored(handle, eventIdOf(answer));
  });
});

describe("a green bun run whose lcov names src/a.ts and src/lib/b.ts alone answers what the run above is held to", () => {
  for (const [how, file] of [
    ["filed single-shot", singleShot],
    ["closed as a streamed run", streamedClose],
  ] as Array<[string, Filing]>) {
    test(`${how}, it answers the two files' totals, the count 2 and the two files, is read back with src/ as its root and stores two rows`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT]);

      const answer = await file(handle, key, KEPT_ALONE);

      expectTheKeptCoverageAnswered(answer);
      await expectTheKeptCoverageReadBack(handle, eventIdOf(answer));
      await expectTheKeptRowsStored(handle, eventIdOf(answer));
    });
  }
});

// ── No file left ────────────────────────────────────────────────────────────

/** The run is stored with its test results and without coverage or files, and the answer warns once that the named block's coverage was dropped. */
async function expectStoredWithItsCoverageDropped(handle: BoardHandle, answer: Answer, block: string): Promise<string> {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.body.ok).toBe(true);
  const warnings = answer.body.warnings as Array<{ code: string; detail: string }> | undefined;
  expect(warnings?.map((warning) => warning.code)).toEqual(["coverage-dropped"]);
  const detail = warnings?.[0]?.detail ?? "";
  expect(detail).toContain(block);

  expect(coverageKeysOf(answer)).toEqual([]);
  expect(runBlockOf(answer).total).toBe(2);
  expect(runBlockOf(answer).passed).toBe(2);
  const eventId = eventIdOf(answer);
  const event = await eventRead(handle, eventId, "?depth=coverage");
  expect(event.coverage).toBeUndefined();
  expect(event.coverageFileCount).toBe(0);
  expect(event.coverageFiles).toEqual([]);
  expect(fileRowCount(dbOf(handle.store), eventId)).toBe(0);
  return detail;
}

describe("a green run whose every coverage file climbs out of the tree", () => {
  const EVERY_FILE_OUT = { codec: "lcov", data: lcovText([CLIMBING, { path: "../d.ts", lf: 3, lh: 1 }]) };

  test("is stored with its test results and no coverage or file, and answers exactly one coverage-dropped warning that names the block and says its files lie outside the run's tree", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    const detail = await expectStoredWithItsCoverageDropped(handle, await singleShot(handle, key, EVERY_FILE_OUT), "lcov");

    expect(detail).toContain("outside the run's tree");
  });

  test("closed as a streamed run, is stored and warned of the same way", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);

    const detail = await expectStoredWithItsCoverageDropped(handle, await streamedClose(handle, key, EVERY_FILE_OUT), "lcov");

    expect(detail).toContain("outside the run's tree");
  });

  test("leaves the board keeping the coverage of the next run that has files inside the tree", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const dropped = await singleShot(handle, key, EVERY_FILE_OUT);
    expect(coverageKeysOf(dropped)).toEqual([]);

    expectTheKeptCoverageAnswered(await singleShot(handle, key, THREE_NAMES));
  });
});

describe("a green run whose coverage text cannot be decoded is stored as the run above is held to", () => {
  /** Line counters and no `SF:` record. */
  const UNDECODABLE = { codec: "lcov", data: "TN:\nLF:10\nLH:5\nend_of_record\n" };

  for (const [how, file] of [
    ["filed single-shot", singleShot],
    ["closed as a streamed run", streamedClose],
  ] as Array<[string, Filing]>) {
    test(`${how}, it is stored with its test results and no coverage or file, and answers one coverage-dropped warning naming the block`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT]);

      const detail = await expectStoredWithItsCoverageDropped(handle, await file(handle, key, UNDECODABLE), "lcov");

      // An undecodable text is not a block of files outside the tree, and is not said to be.
      expect(detail).not.toContain("outside the run's tree");
    });
  }
});
