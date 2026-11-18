// `POST /api/v2/runs` answers a run's least covered files in its `run` block:
//
//  - a run that kept files answers `coverageFileCount`, how many files it
//    has, and `coverageFiles`, the first 10 of them in the kept order, each
//    `{path, lines, functions?}` with `{total, covered, percent}` axes;
//  - the run's id stays at the answer's top-level `event`;
//  - a run of fewer than 10 files answers all of them;
//  - a run that kept no files answers neither key: one with no coverage
//    block, a failing run, and a run whose report decoded to coverage of no
//    file at all;
//  - the close of a streamed run answers as a single-shot ingest does.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store). Every expected file is read from the coverage text by the oracle in
// `tests/helpers/coverage-files-harness.ts`, and the least covered names are
// also written out here by hand.
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import { bootOn, getJson, readyProject, type Answer } from "../helpers/run-stream-harness.ts";
import {
  closeStreamedRun,
  dbOf,
  eventIdOf,
  FAILING_REPORT,
  fileRowCount,
  fixtureText,
  inKeptOrder,
  ingestRun,
  lcovText,
  oracleFiles,
  runBlockOf,
  type CoverageFile,
  type LcovRecord,
} from "../helpers/coverage-files-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

/** Twelve files of 100 lines each, written in no order; every second one states functions. */
const TWELVE: LcovRecord[] = [57, 3, 91, 22, 78, 40, 100, 0, 64, 15, 86, 33].map((hit, index) => ({
  path: `src/f${String(index).padStart(2, "0")}.ts`,
  lf: 100,
  lh: hit,
  ...(index % 2 === 0 ? { fnf: 4, fnh: index % 4 === 0 ? 4 : 1 } : {}),
}));
const TWELVE_TEXT = lcovText(TWELVE);
const TWELVE_BLOCK = { codec: "lcov", data: TWELVE_TEXT };

/** The twelve by lines percent, least covered first: 0, 3, 15, 22, 33, 40, 57, 64, 78, 86 — then 91 and 100, which an answer of ten leaves out. */
const TWELVE_LEAST_COVERED = [
  "src/f07.ts",
  "src/f01.ts",
  "src/f09.ts",
  "src/f03.ts",
  "src/f11.ts",
  "src/f05.ts",
  "src/f00.ts",
  "src/f08.ts",
  "src/f04.ts",
  "src/f10.ts",
];

const TWELVE_TOTALS = {
  lines: { total: 1200, covered: 589, percent: 49.1 },
  functions: { total: 24, covered: 15, percent: 62.5 },
};

const THREE: LcovRecord[] = [
  { path: "src/alpha.ts", lf: 40, lh: 30, fnf: 3, fnh: 2 },
  { path: "src/gamma.ts", lf: 23, lh: 23 },
  { path: "src/beta.ts", lf: 40, lh: 1, fnf: 1, fnh: 0 },
];
const THREE_BLOCK = { codec: "lcov", data: lcovText(THREE) };

const THREE_FILES: CoverageFile[] = [
  { path: "src/beta.ts", lines: { total: 40, covered: 1, percent: 2.5 }, functions: { total: 1, covered: 0, percent: 0 } },
  { path: "src/alpha.ts", lines: { total: 40, covered: 30, percent: 75 }, functions: { total: 3, covered: 2, percent: 66.7 } },
  { path: "src/gamma.ts", lines: { total: 23, covered: 23, percent: 100 } },
];

/** The two file keys an answer's `run` block carries, whichever of them it has. */
function fileKeysOf(answer: Answer): string[] {
  return Object.keys(runBlockOf(answer))
    .filter((key) => key.startsWith("coverageFile"))
    .sort();
}

/** A three-file green run on the same board answers its files: the control beside every "neither key" answer. */
async function expectAFileBearingRunAnswersItsFiles(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const control = await ingestRun(handle, key, agentId, THREE_BLOCK);
  expect(control.status, JSON.stringify(control.body)).toBe(200);
  expect(fileKeysOf(control)).toEqual(["coverageFileCount", "coverageFiles"]);
  expect(runBlockOf(control).coverageFileCount).toBe(3);
}

describe("an ingest's answer names the run's least covered files", () => {
  test("a run of 12 files answers the count 12 and the first 10 files in the kept order, its id at the top-level event", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["twelve"]);
    const kept = inKeptOrder(oracleFiles("lcov", [TWELVE_TEXT]));
    expect(kept.map((file) => file.path).slice(0, 10)).toEqual(TWELVE_LEAST_COVERED);
    expect(kept.length).toBe(12);

    const answer = await ingestRun(handle, key, "twelve", TWELVE_BLOCK);

    const run = runBlockOf(answer);
    expect(run.coverageFileCount).toBe(12);
    expect(run.coverageFiles).toEqual(kept.slice(0, 10));
    expect((run.coverageFiles as CoverageFile[]).map((file) => file.path)).toEqual(TWELVE_LEAST_COVERED);
    // The two most covered files are counted and not listed.
    expect(JSON.stringify(run.coverageFiles)).not.toContain("src/f02.ts");
    expect(JSON.stringify(run.coverageFiles)).not.toContain("src/f06.ts");

    // The run's id is the answer's top-level `event`, and the run block names no id of its own.
    const eventId = eventIdOf(answer);
    expect(Object.keys(run)).not.toContain("event");
    const detail = await getJson(handle, `/api/v2/events/${eventId}`);
    expect((detail.event as { id?: unknown }).id).toBe(eventId);
    // All twelve are stored under that id: the answer lists ten of them, the run keeps every one.
    expect(fileRowCount(dbOf(handle.store), eventId)).toBe(12);

    // The totals and the counts stay beside the files, as they are answered today.
    expect(run.coverage).toEqual(TWELVE_TOTALS);
    expect([run.total, run.passed, run.failed, run.pending]).toEqual([2, 2, 0, 0]);
  });

  test("each answered file is its name, its lines and, when it has functions, its functions", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["shapes"]);

    const answer = await ingestRun(handle, key, "shapes", TWELVE_BLOCK);

    const files = runBlockOf(answer).coverageFiles as CoverageFile[] | undefined;
    expect(Array.isArray(files), "the run block carries coverageFiles").toBe(true);
    const byName = new Map((files ?? []).map((file) => [file.path, file]));
    // f08 states functions (4 of 4); f07 states none.
    expect(byName.get("src/f08.ts")).toEqual({
      path: "src/f08.ts",
      lines: { total: 100, covered: 64, percent: 64 },
      functions: { total: 4, covered: 4, percent: 100 },
    });
    expect(byName.get("src/f07.ts")).toEqual({ path: "src/f07.ts", lines: { total: 100, covered: 0, percent: 0 } });
    expect(Object.keys(byName.get("src/f07.ts") ?? {}).sort()).toEqual(["lines", "path"]);
    expect(Object.keys(byName.get("src/f08.ts") ?? {}).sort()).toEqual(["functions", "lines", "path"]);
  });

  test("a run of 3 files answers the count 3 and all 3 in the kept order", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["three"]);
    expect(inKeptOrder(oracleFiles("lcov", [lcovText(THREE)]))).toEqual(THREE_FILES);

    const answer = await ingestRun(handle, key, "three", THREE_BLOCK);

    const run = runBlockOf(answer);
    expect(run.coverageFileCount).toBe(3);
    expect(run.coverageFiles).toEqual(THREE_FILES);
  });

  test("a run of exactly 10 files answers all 10, and a run of 11 answers 10 of its 11", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["ten-and-eleven"]);
    const ten = lcovText(TWELVE.slice(0, 10));
    const eleven = lcovText(TWELVE.slice(0, 11));

    const tenRun = runBlockOf(await ingestRun(handle, key, "ten-and-eleven", { codec: "lcov", data: ten }));
    const elevenRun = runBlockOf(await ingestRun(handle, key, "ten-and-eleven", { codec: "lcov", data: eleven }));

    expect(tenRun.coverageFileCount).toBe(10);
    expect(tenRun.coverageFiles).toEqual(inKeptOrder(oracleFiles("lcov", [ten])));
    expect(elevenRun.coverageFileCount).toBe(11);
    expect(elevenRun.coverageFiles).toEqual(inKeptOrder(oracleFiles("lcov", [eleven])).slice(0, 10));
    expect((elevenRun.coverageFiles as unknown[]).length).toBe(10);
  });
});

describe("a run that kept no files answers neither file key", () => {
  test("a green run with no coverage block answers neither, where a file-bearing run on the same board answers both", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["no-coverage"]);

    const answer = await ingestRun(handle, key, "no-coverage");

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(fileKeysOf(answer)).toEqual([]);
    expect(runBlockOf(answer).coverage).toBeUndefined();
    await expectAFileBearingRunAnswersItsFiles(handle, key, "no-coverage");
  });

  test("a failing run with a coverage block answers neither, where a file-bearing run on the same board answers both", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["red-with-coverage"]);

    const answer = await ingestRun(handle, key, "red-with-coverage", THREE_BLOCK, FAILING_REPORT);

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(fileKeysOf(answer)).toEqual([]);
    expect(runBlockOf(answer).coverage).toBeUndefined();
    await expectAFileBearingRunAnswersItsFiles(handle, key, "red-with-coverage");
  });

  test("coverage dropped as undecodable answers neither, where a file-bearing run on the same board answers both", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["dropped"]);

    const answer = await ingestRun(handle, key, "dropped", { codec: "lcov", data: "TN:\nLF:10\nLH:5\nend_of_record\n" });

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(fileKeysOf(answer)).toEqual([]);
    expect(runBlockOf(answer).coverage).toBeUndefined();
    await expectAFileBearingRunAnswersItsFiles(handle, key, "dropped");
  });

  const NO_FILE_REPORTS = [
    {
      what: "a Go profile of its mode: line alone",
      block: { codec: "go-coverprofile", data: fixtureText("go-coverprofile", "contracts-types-only.coverprofile") },
      coverage: { lines: { total: 0, covered: 0, percent: 0 } },
    },
    {
      what: "a JaCoCo CSV of its header alone",
      block: { codec: "jacoco", data: fixtureText("jacoco-csv", "header-only.csv") },
      coverage: {
        lines: { total: 0, covered: 0, percent: 0 },
        functions: { total: 0, covered: 0, percent: 0 },
        branches: { total: 0, covered: 0, percent: 0 },
      },
    },
  ];

  for (const { what, block, coverage } of NO_FILE_REPORTS) {
    test(`${what} keeps coverage of no file: its totals are answered and neither file key is`, async () => {
      const handle = boot();
      const key = await readyProject(handle, ["no-file"]);

      const answer = await ingestRun(handle, key, "no-file", block);

      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(runBlockOf(answer).coverage).toEqual(coverage);
      expect(fileKeysOf(answer)).toEqual([]);
      await expectAFileBearingRunAnswersItsFiles(handle, key, "no-file");
    });
  }
});

describe("the close of a streamed run answers its files as a single-shot ingest does", () => {
  test("a streamed run closed with the 12-file block answers the same count and the same ten files", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["closer", "single"]);

    const closed = await closeStreamedRun(handle, key, "closer", TWELVE_BLOCK);
    const single = await ingestRun(handle, key, "single", TWELVE_BLOCK);

    const closedRun = runBlockOf(closed);
    expect(closedRun.coverageFileCount).toBe(12);
    expect(closedRun.coverageFiles).toEqual(inKeptOrder(oracleFiles("lcov", [TWELVE_TEXT])).slice(0, 10));
    expect((closedRun.coverageFiles as CoverageFile[]).map((file) => file.path)).toEqual(TWELVE_LEAST_COVERED);
    expect(closedRun.coverage).toEqual(TWELVE_TOTALS);
    // The same block, the same answer: the two are one route.
    const singleRun = runBlockOf(single);
    expect(closedRun.coverageFileCount).toBe(singleRun.coverageFileCount as number);
    expect(closedRun.coverageFiles).toEqual(singleRun.coverageFiles as CoverageFile[]);
    // Each run's id is its own answer's top-level `event`.
    expect(eventIdOf(closed)).not.toBe(eventIdOf(single));
    expect(fileRowCount(dbOf(handle.store), eventIdOf(closed))).toBe(12);
  });

  test("a streamed run closed with no coverage block answers neither file key, where one closed with files answers both", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["bare-closer", "file-closer"]);

    const bare = await closeStreamedRun(handle, key, "bare-closer");

    expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    expect(fileKeysOf(bare)).toEqual([]);

    const withFiles = await closeStreamedRun(handle, key, "file-closer", THREE_BLOCK);
    expect(fileKeysOf(withFiles)).toEqual(["coverageFileCount", "coverageFiles"]);
    expect(runBlockOf(withFiles).coverageFiles).toEqual(THREE_FILES);
  });
});
