// `GET /api/v2/events/<id>?depth=coverage` answers a run's files in the order
// their rows are stored in:
//
//  1. lowest lines percent first, the percent as it is rounded to one decimal;
//  2. then most uncovered lines first;
//  3. then by name, ascending in code-unit order, so `B.ts` comes before
//     `a.ts`.
//
// A file with no lines comes after every file that has lines, and several
// such files are ordered among themselves by name in code-unit order.
//
// Driven through the real production router (`bootInProcess`, in-memory
// store). The expected order is written out by hand, and checked against the
// stored rows.
import { afterEach, describe, expect, test } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, readyProject } from "../helpers/run-stream-harness.ts";
import {
  dbOf,
  eventIdOf,
  eventRead,
  inKeptOrder,
  ingestRun,
  lcovText,
  oracleFiles,
  storedFileOf,
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

const AGENT = "order-reader";

/**
 * Ten files, written in no order:
 *  - `least.ts`, 1 of 100 lines;
 *  - three at a rounded 50%: `rounds-to-fifty.ts` (2001 of 4000, 50.025%
 *    before rounding, 1999 uncovered), `big.ts` (50 of 100, 50 uncovered) and
 *    `small.ts` (5 of 10, 5 uncovered);
 *  - `B.ts` and `a.ts`, each 15 of 20: equal on percent and on uncovered;
 *  - `full.ts`, 3 of 3;
 *  - three with no lines: `Z-none.ts` and `a-none.ts` state no line counter,
 *    `B-none.ts` states 0 of 0.
 */
const RECORDS: LcovRecord[] = [
  { path: "src/a.ts", lf: 20, lh: 15 },
  { path: "src/Z-none.ts", fnf: 2, fnh: 1 },
  { path: "src/small.ts", lf: 10, lh: 5 },
  { path: "src/full.ts", lf: 3, lh: 3 },
  { path: "src/a-none.ts" },
  { path: "src/big.ts", lf: 100, lh: 50 },
  { path: "src/B.ts", lf: 20, lh: 15 },
  { path: "src/B-none.ts", lf: 0, lh: 0 },
  { path: "src/rounds-to-fifty.ts", lf: 4000, lh: 2001 },
  { path: "src/least.ts", lf: 100, lh: 1 },
];
const BLOCK = { codec: "lcov", data: lcovText(RECORDS) };

/** The ten in the stored order, written out by hand. */
const ORDERED: CoverageFile[] = [
  { path: "src/least.ts", lines: { total: 100, covered: 1, percent: 1 } },
  { path: "src/rounds-to-fifty.ts", lines: { total: 4000, covered: 2001, percent: 50 } },
  { path: "src/big.ts", lines: { total: 100, covered: 50, percent: 50 } },
  { path: "src/small.ts", lines: { total: 10, covered: 5, percent: 50 } },
  { path: "src/B.ts", lines: { total: 20, covered: 15, percent: 75 } },
  { path: "src/a.ts", lines: { total: 20, covered: 15, percent: 75 } },
  { path: "src/full.ts", lines: { total: 3, covered: 3, percent: 100 } },
  { path: "src/B-none.ts", lines: { total: 0, covered: 0, percent: 0 } },
  { path: "src/Z-none.ts", lines: { total: 0, covered: 0, percent: 0 }, functions: { total: 2, covered: 1, percent: 50 } },
  { path: "src/a-none.ts", lines: { total: 0, covered: 0, percent: 0 } },
];
const ORDERED_NAMES = ORDERED.map((file) => file.path);

/** A board holding the ten-file run, and the names `?depth=coverage<more>` answers for it. */
async function namesRead(more = ""): Promise<{ handle: BoardHandle; eventId: string; event: Record<string, unknown>; names: string[] }> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT]);
  const eventId = eventIdOf(await ingestRun(handle, key, AGENT, BLOCK));
  // The rows are stored in the hand-written order: the read is held to the same one.
  expect(await storedFiles(dbOf(handle.store), eventId)).toEqual(ORDERED.map(storedFileOf));
  const event = await eventRead(handle, eventId, `?depth=coverage${more}`);
  expect(Array.isArray(event.coverageFiles), "the read answers coverageFiles").toBe(true);
  const names = ((event.coverageFiles ?? []) as CoverageFile[]).map((file) => file.path);
  return { handle, eventId, event, names };
}

describe("a run's files are read in the order their rows are stored in", () => {
  test("the read answers the ten files in the stored order, each with its counters", async () => {
    // The hand-written order is the kept order of the files the text states.
    expect(inKeptOrder(oracleFiles("lcov", [BLOCK.data]))).toEqual(ORDERED);

    const { handle, eventId, event } = await namesRead();

    expect(event.coverageFiles).toEqual(ORDERED);
    expect(event.coverageFileCount).toBe(10);
    // Position by position, the answer is the stored rows.
    expect((event.coverageFiles as CoverageFile[]).map(storedFileOf)).toEqual(await storedFiles(dbOf(handle.store), eventId));
  });

  test("the lowest lines percent comes first and the highest last among the files that have lines", async () => {
    const { names } = await namesRead();

    expect(names[0]).toBe("src/least.ts");
    expect(names[6]).toBe("src/full.ts");
    expect(names.slice(0, 7)).toEqual(ORDERED_NAMES.slice(0, 7));
  });

  test("files with the same rounded lines percent are ordered by most uncovered lines: 1999, then 50, then 5", async () => {
    const { names } = await namesRead();

    // 50.025% rounds to 50: it ties with the two files at 50% and leads them on uncovered lines.
    expect(names.slice(1, 4)).toEqual(["src/rounds-to-fifty.ts", "src/big.ts", "src/small.ts"]);
  });

  test("files equal on percent and on uncovered lines are ordered by name in code-unit order: B.ts before a.ts", async () => {
    const { names } = await namesRead();

    expect(names.slice(4, 6)).toEqual(["src/B.ts", "src/a.ts"]);
  });

  test("the files with no lines come after every file that has lines, by name in code-unit order: B, Z, a", async () => {
    const { names, event } = await namesRead();

    expect(names.slice(7)).toEqual(["src/B-none.ts", "src/Z-none.ts", "src/a-none.ts"]);
    expect(names.length).toBe(10);
    // Each is answered with lines of 0 of 0, and its functions when it states any.
    expect((event.coverageFiles as CoverageFile[]).slice(7)).toEqual(ORDERED.slice(7));
  });

  test("files=4 answers the first four of that order, and files=8 reaches the first file with no lines", async () => {
    const four = await namesRead("&files=4");
    expect(four.names).toEqual(["src/least.ts", "src/rounds-to-fifty.ts", "src/big.ts", "src/small.ts"]);
    expect(four.event.coverageFileCount).toBe(10);

    const eight = await namesRead("&files=8");
    expect(eight.names).toEqual(ORDERED_NAMES.slice(0, 8));
    expect(eight.names[7]).toBe("src/B-none.ts");
  });
});
