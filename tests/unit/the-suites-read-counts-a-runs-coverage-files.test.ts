// `GET /api/v2/events/<id>?depth=suites` says how many coverage files a run
// has, and every other read of a run stays as it is:
//
//  - `?depth=suites` carries `event.coverageFileCount` when the run has
//    files, on both of its answers: a run with a tree (its suites), and a run
//    without one. A run without files has no such key. The count is one
//    aggregate statement on `run_coverage_files`; no file row is read;
//  - the full read and the `?suite=` read answer a run with files as they
//    answer one without: no count, no file, no root;
//  - `?suite=` takes precedence over `depth=coverage`, as it does over
//    `depth=suites`;
//  - `files=` on a read other than `?depth=coverage` is ignored.
//
// Driven through the real production router (`bootInProcess`, in-memory
// store). A run with files and no tree is written by no ingest: its state is
// made here on the board's own connection, from a stored run of files.
import { afterEach, describe, expect, test } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, readyProject } from "../helpers/run-stream-harness.ts";
import {
  callsAnAggregate,
  dbOf,
  eventIdOf,
  eventRead,
  fileReadKeysOf,
  fileRowCount,
  filesTableUse,
  fixtureText,
  ingestRun,
  lcovText,
  recordQueries,
  TWELVE_BLOCK,
  TWELVE_FILES,
  TWELVE_TOTALS,
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

const AGENT = "suites-reader";

/** The passing report's one suite, as `?depth=suites` summarises it. */
const GREEN_SUITES = [{ name: "Green", status: "pass", counts: { passed: 2, failed: 0, pending: 0 } }];

/** A coverage block that decodes to coverage of no file. */
const NO_FILE_BLOCK = { codec: "jacoco", data: fixtureText("jacoco-csv", "header-only.csv") };

/** A board holding a green run of the twelve files and, beside it, a green run whose coverage states no file. */
async function aRunWithFilesAndOneWithout(): Promise<{ handle: BoardHandle; key: string; withFiles: string; without: string }> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT]);
  const withFiles = eventIdOf(await ingestRun(handle, key, AGENT, TWELVE_BLOCK));
  const without = eventIdOf(await ingestRun(handle, key, AGENT, NO_FILE_BLOCK));
  const db = dbOf(handle.store);
  expect([fileRowCount(db, withFiles), fileRowCount(db, without)]).toEqual([12, 0]);
  return { handle, key, withFiles, without };
}

/**
 * Leave a stored run with no tree: the state `?depth=suites` gives its other
 * answer for. The run's files are untouched.
 */
function dropTheTree(handle: BoardHandle, eventId: string): void {
  const db = dbOf(handle.store);
  db.query(`UPDATE run_details SET has_tree = 0 WHERE event_id = ?`).run(eventId);
  db.query(`DELETE FROM run_cases WHERE event_id = ?`).run(eventId);
  db.query(`DELETE FROM run_suites WHERE event_id = ?`).run(eventId);
}

function keysOf(event: Record<string, unknown>): string[] {
  return Object.keys(event).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── The count ───────────────────────────────────────────────────────────────

describe("?depth=suites carries a run's coverage file count", () => {
  test("a run with a tree and 12 files carries coverageFileCount 12 beside its suites, and neither a file nor a root", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();

    const event = await eventRead(handle, withFiles, "?depth=suites");

    expect(event.coverageFileCount).toBe(12);
    expect(event.tree).toEqual(GREEN_SUITES);
    expect(fileReadKeysOf(event)).toEqual(["coverageFileCount"]);
    expect(JSON.stringify(event)).not.toContain("/home/dev/app/src/");
    expect(event.coverage).toEqual(TWELVE_TOTALS);
  });

  test("a run with 12 files and no tree carries coverageFileCount 12 on the read's other answer", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();
    dropTheTree(handle, withFiles);
    expect(fileRowCount(dbOf(handle.store), withFiles)).toBe(12);

    const event = await eventRead(handle, withFiles, "?depth=suites");

    // The answer for a run with no tree: no `tree` key at all.
    expect("tree" in event).toBe(false);
    expect(event.coverageFileCount).toBe(12);
    expect(fileReadKeysOf(event)).toEqual(["coverageFileCount"]);
    expect(event.coverage).toEqual(TWELVE_TOTALS);
  });

  test("a run without files has no coverageFileCount key, beside a run of 12 that has: no coverage block, and coverage of no file", async () => {
    const { handle, key, withFiles, without } = await aRunWithFilesAndOneWithout();
    const bare = eventIdOf(await ingestRun(handle, key, AGENT));

    const counted = await eventRead(handle, withFiles, "?depth=suites");
    const noFile = await eventRead(handle, without, "?depth=suites");
    const noCoverage = await eventRead(handle, bare, "?depth=suites");

    expect(counted.coverageFileCount).toBe(12);
    // No key at all: not a 0, and not a null.
    expect(fileReadKeysOf(noFile)).toEqual([]);
    expect(fileReadKeysOf(noCoverage)).toEqual([]);
    expect(noFile.tree).toEqual(GREEN_SUITES);
  });

  test("a run without files and without a tree has no coverageFileCount key either", async () => {
    const { handle, withFiles, without } = await aRunWithFilesAndOneWithout();
    dropTheTree(handle, withFiles);
    dropTheTree(handle, without);

    const counted = await eventRead(handle, withFiles, "?depth=suites");
    const noFile = await eventRead(handle, without, "?depth=suites");

    expect(counted.coverageFileCount).toBe(12);
    expect("tree" in noFile).toBe(false);
    expect(fileReadKeysOf(noFile)).toEqual([]);
  });

  test("each run carries its own count: 12 and 3 on one board", async () => {
    const { handle, key, withFiles } = await aRunWithFilesAndOneWithout();
    const three = eventIdOf(
      await ingestRun(handle, key, AGENT, {
        codec: "lcov",
        data: lcovText([
          { path: "pkg/a.ts", lf: 5, lh: 1 },
          { path: "pkg/b.ts", lf: 5, lh: 2 },
          { path: "pkg/c.ts", lf: 5, lh: 3 },
        ]),
      }),
    );

    expect((await eventRead(handle, three, "?depth=suites")).coverageFileCount).toBe(3);
    expect((await eventRead(handle, withFiles, "?depth=suites")).coverageFileCount).toBe(12);
  });

  test("the count is the read's only new key: a run of files is answered with the keys a run of no file is, and coverageFileCount", async () => {
    const { handle, withFiles, without } = await aRunWithFilesAndOneWithout();

    const counted = await eventRead(handle, withFiles, "?depth=suites");
    const noFile = await eventRead(handle, without, "?depth=suites");

    expect(keysOf(counted)).toEqual(keysOf({ ...noFile, coverageFileCount: 0 }));
  });
});

// ── The statements ──────────────────────────────────────────────────────────

describe("?depth=suites counts a run's files in one aggregate and reads no file row", () => {
  test("a run with a tree: one statement on the files table, an aggregate, handing back no file row", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();

    let event: Record<string, unknown> = {};
    const records = await recordQueries(handle.store, async () => {
      event = await eventRead(handle, withFiles, "?depth=suites");
    });

    expect(event.coverageFileCount).toBe(12);
    const use = filesTableUse(records, TWELVE_FILES);
    expect(use.statements.length).toBe(1);
    expect(callsAnAggregate(use.statements[0]?.sql ?? "")).toBe(true);
    expect(use.fileRows).toBe(0);
    // The aggregate's one row at most, and no file name in it.
    expect(use.otherRows).toBeLessThanOrEqual(1);
    expect(JSON.stringify(use.statements.map((statement) => statement.handed))).not.toContain("/home/dev/app/src/");
  });

  test("a run without a tree: one statement on the files table, an aggregate, handing back no file row", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();
    dropTheTree(handle, withFiles);

    let event: Record<string, unknown> = {};
    const records = await recordQueries(handle.store, async () => {
      event = await eventRead(handle, withFiles, "?depth=suites");
    });

    expect("tree" in event).toBe(false);
    expect(event.coverageFileCount).toBe(12);
    const use = filesTableUse(records, TWELVE_FILES);
    expect(use.statements.length).toBe(1);
    expect(callsAnAggregate(use.statements[0]?.sql ?? "")).toBe(true);
    expect(use.fileRows).toBe(0);
    expect(use.otherRows).toBeLessThanOrEqual(1);
    expect(JSON.stringify(use.statements.map((statement) => statement.handed))).not.toContain("/home/dev/app/src/");
  });
});

// ── The other reads ─────────────────────────────────────────────────────────

describe("the reads other than the suites read and the coverage read answer a run with files as they answer one without", () => {
  test("the full read carries no count, no file and no root, and the keys a run of no file is answered with", async () => {
    const { handle, withFiles, without } = await aRunWithFilesAndOneWithout();

    const full = await eventRead(handle, withFiles);
    const noFile = await eventRead(handle, without);

    expect(fileReadKeysOf(full)).toEqual([]);
    expect(keysOf(full)).toEqual(keysOf(noFile));
    expect(JSON.stringify(full)).not.toContain("/home/dev/app/src/");
    // It is still the whole run: the tree with its tests, and the totals.
    expect((full.tree as Array<{ name: string; children: unknown[] }>).map((suite) => [suite.name, suite.children.length])).toEqual([["Green", 2]]);
    expect(full.coverage).toEqual(TWELVE_TOTALS);
  });

  test("the full read ignores files=: files=x, files=0 and files=3 answer what the read answers without it", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();
    const full = await eventRead(handle, withFiles);
    expect((full.tree as unknown[]).length).toBe(1);

    for (const sent of ["x", "0", "3"]) {
      expect(await eventRead(handle, withFiles, `?files=${sent}`), `files=${sent}`).toEqual(full);
    }
  });

  test("the ?suite= read carries no count, no file and no root, and the keys a run of no file is answered with", async () => {
    const { handle, withFiles, without } = await aRunWithFilesAndOneWithout();

    const suite = await eventRead(handle, withFiles, "?suite=Green");
    const noFile = await eventRead(handle, without, "?suite=Green");

    expect(fileReadKeysOf(suite)).toEqual([]);
    expect(keysOf(suite)).toEqual(keysOf(noFile));
    expect(JSON.stringify(suite)).not.toContain("/home/dev/app/src/");
    expect((suite.tree as Array<{ name: string; children: Array<{ name: string }> }>).map((node) => [node.name, node.children.map((leaf) => leaf.name)])).toEqual([
      ["Green", ["g1", "g2"]],
    ]);
  });

  test("?suite= with depth=coverage is the suite read: the suite and its tests, and no file key", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();
    const suite = await eventRead(handle, withFiles, "?suite=Green");
    expect((suite.tree as Array<{ children: unknown[] }>)[0]?.children.length).toBe(2);

    expect(await eventRead(handle, withFiles, "?suite=Green&depth=coverage")).toEqual(suite);
    expect(await eventRead(handle, withFiles, "?depth=coverage&suite=Green")).toEqual(suite);
  });

  test("?suite= with depth=coverage and a files= the coverage read would refuse is still the suite read: answered 200, files= ignored", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();
    const suite = await eventRead(handle, withFiles, "?suite=Green");
    expect((suite.tree as Array<{ name: string; children: unknown[] }>).map((node) => [node.name, node.children.length])).toEqual([["Green", 2]]);

    for (const sent of ["x", "0", "", "3"]) {
      expect(await eventRead(handle, withFiles, `?suite=Green&depth=coverage&files=${sent}`), `files=${sent}`).toEqual(suite);
    }
    expect(await eventRead(handle, withFiles, "?files=x&depth=coverage&suite=Green")).toEqual(suite);
  });

  test("?depth=suites with files=x is the suites read: answered 200, the count 12 and no file", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();
    const suites = await eventRead(handle, withFiles, "?depth=suites");

    const event = await eventRead(handle, withFiles, "?depth=suites&files=x");

    expect(event.coverageFileCount).toBe(12);
    expect(event).toEqual(suites);
    expect(fileReadKeysOf(event)).toEqual(["coverageFileCount"]);
    expect(event.tree).toEqual(GREEN_SUITES);
  });

  test("?depth=suites with files=3 is the suites read too: the count 12 and no file", async () => {
    const { handle, withFiles } = await aRunWithFilesAndOneWithout();

    const event = await eventRead(handle, withFiles, "?depth=suites&files=3");

    expect(event.coverageFileCount).toBe(12);
    expect(fileReadKeysOf(event)).toEqual(["coverageFileCount"]);
    expect(event.tree).toEqual(GREEN_SUITES);
  });
});
