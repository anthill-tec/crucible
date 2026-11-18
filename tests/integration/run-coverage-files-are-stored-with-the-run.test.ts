// A green run's coverage files are stored with the run, in a table of their
// own:
//
//  - `run_coverage_files` holds one row per file of a run: the run's event
//    id, the file's position, its name, its lines total and covered, and its
//    functions total and covered — NULL for a file with no functions axis.
//    No percent is stored;
//  - a green run ingested with a coverage block stores its files, single-shot
//    and as the close of a streamed run; the run's `events.coverage` stays the
//    totals object, with no file in it;
//  - a run that keeps no coverage keeps no file: a failing run, a run whose
//    coverage is dropped as undecodable, and a run posted already decoded to
//    `/api/v2/runs/parsed`;
//  - the files are positioned once, at ingest: lowest rounded lines percent
//    first, then most uncovered lines, then name in code-unit order (`B.ts`
//    before `a.ts`); a file with no lines after every file that has lines.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store); the rows are read from the store's own connection. The table's columns are read by what
// they hold (`tests/helpers/coverage-files-harness.ts`), never by a name the
// board has not committed to; `event_id` is the column every run-detail table
// is deleted by.
import { afterEach, describe, expect, test } from "bun:test";
import { coveragePercent } from "../../src/codecs/coverage.ts";
import type { ServerHandle } from "../../src/server.ts";
import { bootOn, postJson, readyProject, type Answer } from "../helpers/run-stream-harness.ts";
import {
  closeStreamedRun,
  dbOf,
  eventIdOf,
  FAILING_REPORT,
  fileColumns,
  fileRowCount,
  fileRowTotal,
  fixtureText,
  inKeptOrder,
  ingestRun,
  lcovText,
  oracleFiles,
  PROBE_FILE,
  storedFileOf,
  storedFiles,
  type CoverageCodecName,
  type LcovRecord,
  type StoredFile,
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

/** Two files: `src/beta.ts` 1 of 40 lines and 0 of 1 functions, `src/alpha.ts` 30 of 40 lines and 2 of 3 functions. */
const TWO_FILES: LcovRecord[] = [
  { path: "src/alpha.ts", lf: 40, lh: 30, fnf: 3, fnh: 2 },
  { path: "src/beta.ts", lf: 40, lh: 1, fnf: 1, fnh: 0 },
];
const TWO_FILES_BLOCK = { codec: "lcov", data: lcovText(TWO_FILES) };

/** The two files' rows, least covered first. */
const TWO_FILES_ROWS: StoredFile[] = [
  { path: "src/beta.ts", linesTotal: 40, linesCovered: 1, functionsTotal: 1, functionsCovered: 0 },
  { path: "src/alpha.ts", linesTotal: 40, linesCovered: 30, functionsTotal: 3, functionsCovered: 2 },
];

const TWO_FILES_TOTALS = {
  lines: { total: 80, covered: 31, percent: 38.8 },
  functions: { total: 4, covered: 2, percent: 50 },
};

/** The run's `events.coverage` column, as the text the store holds. */
function storedCoverageText(handle: ServerHandle, eventId: string): string | null {
  const row = dbOf(handle.store)
    .query<{ coverage: string | null }, [string]>(`SELECT coverage FROM events WHERE id = ?`)
    .get(eventId);
  expect(row, `the store holds event ${eventId}`).not.toBeNull();
  return row?.coverage ?? null;
}

/** The rows a coverage block's files are stored as, in the kept order, read from the texts by the oracle. */
function expectedRows(codec: CoverageCodecName, texts: readonly string[]): StoredFile[] {
  return inKeptOrder(oracleFiles(codec, texts)).map(storedFileOf);
}

/** A green two-file run on the same board: the rows a file-bearing run stores, so "no row" is never "no table". */
async function expectAGreenRunStoresItsFiles(handle: ServerHandle, key: string, agentId: string): Promise<string> {
  const control = eventIdOf(await ingestRun(handle, key, agentId, TWO_FILES_BLOCK));
  expect(await storedFiles(dbOf(handle.store), control)).toEqual(TWO_FILES_ROWS);
  return control;
}

// ── The row ─────────────────────────────────────────────────────────────────

describe("a file row holds what the run needs to answer the file, and no percent", () => {
  test("the row is the run's event id, the file's position, its name and its four counters, each in a column of its own", async () => {
    const columns = await fileColumns();

    const named = [
      "event_id",
      columns.position,
      columns.path,
      columns.linesTotal,
      columns.linesCovered,
      columns.functionsTotal,
      columns.functionsCovered,
    ];
    // Seven distinct columns, and no eighth.
    expect(new Set(named).size).toBe(7);
    expect([...columns.all].sort()).toEqual([...named].sort());
  });

  test("no column holds a percent: neither the file's lines percent nor its functions percent is in the row", async () => {
    const columns = await fileColumns();

    const linesPercent = coveragePercent(PROBE_FILE.lh, PROBE_FILE.lf);
    const functionsPercent = coveragePercent(PROBE_FILE.fnh, PROBE_FILE.fnf);
    expect([linesPercent, functionsPercent]).toEqual([73.2, 71.4]);
    const values = Object.values(columns.probeRow);
    expect(values).not.toContain(linesPercent);
    expect(values).not.toContain(functionsPercent);
    expect(columns.all.filter((column) => /percent|pct/i.test(column))).toEqual([]);
    // Every counter is stored as the integer the report states.
    expect(values.filter((value) => typeof value === "number").every((value) => Number.isInteger(value))).toBe(true);
  });
});

// ── A green run keeps its files ─────────────────────────────────────────────

describe("a green run ingested with a coverage block stores one row per file", () => {
  test("a single-shot ingest stores its files' rows, and events.coverage stays the totals object with no file in it", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["single-shot"]);

    const eventId = eventIdOf(await ingestRun(handle, key, "single-shot", TWO_FILES_BLOCK));

    const db = dbOf(handle.store);
    expect(await storedFiles(db, eventId)).toEqual(TWO_FILES_ROWS);
    // Exactly the run's two rows, and no other row in the table.
    expect(fileRowCount(db, eventId)).toBe(2);
    expect(fileRowTotal(db)).toBe(2);

    const coverageText = storedCoverageText(handle, eventId);
    expect(JSON.parse(coverageText ?? "null")).toEqual(TWO_FILES_TOTALS);
    expect(Object.keys(JSON.parse(coverageText ?? "{}") as object).sort()).toEqual(["functions", "lines"]);
    expect(coverageText).not.toContain("src/alpha.ts");
    expect(coverageText).not.toContain("src/beta.ts");
  });

  test("the close of a streamed run stores its files' rows as a single-shot ingest does", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["streamer"]);

    const eventId = eventIdOf(await closeStreamedRun(handle, key, "streamer", TWO_FILES_BLOCK));

    const db = dbOf(handle.store);
    expect(await storedFiles(db, eventId)).toEqual(TWO_FILES_ROWS);
    expect(fileRowTotal(db)).toBe(2);
    expect(JSON.parse(storedCoverageText(handle, eventId) ?? "null")).toEqual(TWO_FILES_TOTALS);
  });

  test("several texts of one run are stored as one list of files, a name in two texts as one row", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["two-texts"]);
    const first = lcovText([
      { path: "src/shared.ts", lf: 10, lh: 4, fnf: 2, fnh: 1 },
      { path: "src/only-first.ts", lf: 3, lh: 3, fnf: 1, fnh: 1 },
    ]);
    const second = lcovText([{ path: "src/shared.ts", lf: 6, lh: 6 }]);

    const eventId = eventIdOf(await ingestRun(handle, key, "two-texts", { codec: "lcov", data: [first, second] }));

    expect(await storedFiles(dbOf(handle.store), eventId)).toEqual([
      { path: "src/shared.ts", linesTotal: 16, linesCovered: 10, functionsTotal: 2, functionsCovered: 1 },
      { path: "src/only-first.ts", linesTotal: 3, linesCovered: 3, functionsTotal: 1, functionsCovered: 1 },
    ]);
  });

  test("two runs each keep their own rows", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["two-runs"]);

    const first = eventIdOf(await ingestRun(handle, key, "two-runs", TWO_FILES_BLOCK));
    const second = eventIdOf(
      await ingestRun(handle, key, "two-runs", { codec: "lcov", data: lcovText([{ path: "src/gamma.ts", lf: 23, lh: 23, fnf: 2, fnh: 2 }]) }),
    );

    const db = dbOf(handle.store);
    expect(await storedFiles(db, first)).toEqual(TWO_FILES_ROWS);
    expect(await storedFiles(db, second)).toEqual([
      { path: "src/gamma.ts", linesTotal: 23, linesCovered: 23, functionsTotal: 2, functionsCovered: 2 },
    ]);
    expect(fileRowTotal(db)).toBe(3);
  });
});

// ── NULL functions ──────────────────────────────────────────────────────────

describe("a file with no functions axis is stored with NULL functions counters", () => {
  const cases: Array<{ what: string; codec: CoverageCodecName; text: string; rows: StoredFile[] }> = [
    {
      what: "a JaCoCo row of 0 methods",
      codec: "jacoco",
      text: fixtureText("jacoco-csv", "multi-row.csv"),
      rows: [
        { path: "com.acme.shop.tax.Rate", linesTotal: 8, linesCovered: 0, functionsTotal: 3, functionsCovered: 0 },
        { path: "com.acme.shop.Currency", linesTotal: 2, linesCovered: 0, functionsTotal: null, functionsCovered: null },
        { path: "Launcher", linesTotal: 6, linesCovered: 2, functionsTotal: 2, functionsCovered: 1 },
        { path: "com.acme.shop.Basket", linesTotal: 20, linesCovered: 17, functionsTotal: 8, functionsCovered: 7 },
        { path: "com.acme.shop.Basket.Line", linesTotal: 6, linesCovered: 6, functionsTotal: 3, functionsCovered: 3 },
      ],
    },
    {
      what: "an lcov record that states no counters",
      codec: "lcov",
      text: fixtureText("reports", "python", "pytest", "lcov.info"),
      rows: [
        { path: "pkg/calc.py", linesTotal: 12, linesCovered: 11, functionsTotal: 4, functionsCovered: 3 },
        { path: "pkg/words.py", linesTotal: 4, linesCovered: 4, functionsTotal: 2, functionsCovered: 2 },
        { path: "pkg/__init__.py", linesTotal: 0, linesCovered: 0, functionsTotal: null, functionsCovered: null },
      ],
    },
    {
      what: "every file of a Go profile",
      codec: "go-coverprofile",
      text: fixtureText("go-coverprofile", "shop-coverpkg.coverprofile"),
      rows: [
        { path: "example.com/shop/report/report.go", linesTotal: 3, linesCovered: 0, functionsTotal: null, functionsCovered: null },
        { path: "example.com/shop/stock/stock.go", linesTotal: 5, linesCovered: 1, functionsTotal: null, functionsCovered: null },
        { path: "example.com/shop/price/price.go", linesTotal: 10, linesCovered: 7, functionsTotal: null, functionsCovered: null },
      ],
    },
  ];

  for (const { what, codec, text, rows } of cases) {
    test(`${what} is stored with both functions counters NULL, beside files that keep theirs`, async () => {
      const handle = boot();
      const key = await readyProject(handle, ["null-functions"]);
      // The rows written out above are the oracle's, in the kept order.
      expect(expectedRows(codec, [text])).toEqual(rows);

      const eventId = eventIdOf(await ingestRun(handle, key, "null-functions", { codec, data: text }));

      const stored = await storedFiles(dbOf(handle.store), eventId);
      expect(stored).toEqual(rows);
      // NULL, never 0: a file with no functions axis is told apart from one whose functions are all missed.
      for (const row of stored.filter((file) => file.functionsTotal === null)) {
        expect(row.functionsCovered, row.path).toBeNull();
      }
    });
  }
});

// ── The kept order ──────────────────────────────────────────────────────────

describe("a run's files are stored in the kept order", () => {
  // Written out of order, so the order read back is never the order sent.
  const SCRAMBLED: LcovRecord[] = [
    { path: "src/empty.ts" },
    { path: "a.ts", lf: 10, lh: 5 },
    { path: "src/full.ts", lf: 8, lh: 8 },
    { path: "src/thirds.ts", lf: 3, lh: 1 },
    { path: "B.ts", lf: 10, lh: 5 },
    { path: "src/zero.ts", lf: 4, lh: 0 },
    { path: "src/thousands.ts", lf: 2999, lh: 1000 },
  ];

  const KEPT_ORDER = ["src/zero.ts", "src/thousands.ts", "src/thirds.ts", "B.ts", "a.ts", "src/full.ts", "src/empty.ts"];

  test("lowest rounded percent, then most uncovered, then name by code unit, a file with no lines last", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["ordered"]);
    // The two that tie on the rounded percent: 1000 of 2999 is the HIGHER
    // exact ratio and has the more uncovered lines, so an order by the exact
    // ratio would put it second.
    expect(coveragePercent(1000, 2999)).toBe(33.3);
    expect(coveragePercent(1, 3)).toBe(33.3);
    expect(1000 / 2999).toBeGreaterThan(1 / 3);
    // The pair equal on both: the same percent and the same 5 uncovered lines.
    expect("B.ts" < "a.ts").toBe(true);
    expect("B.ts".localeCompare("a.ts", "en")).toBeGreaterThan(0);
    expect(inKeptOrder(oracleFiles("lcov", [lcovText(SCRAMBLED)])).map((file) => file.path)).toEqual(KEPT_ORDER);

    const eventId = eventIdOf(await ingestRun(handle, key, "ordered", { codec: "lcov", data: lcovText(SCRAMBLED) }));

    const stored = await storedFiles(dbOf(handle.store), eventId);
    expect(stored.map((file) => file.path)).toEqual(KEPT_ORDER);
    expect(stored).toEqual(expectedRows("lcov", [lcovText(SCRAMBLED)]));
  });

  test("the order does not depend on the order the report states its files in", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["reordered"]);
    const reversed = [...SCRAMBLED].reverse();

    const sent = eventIdOf(await ingestRun(handle, key, "reordered", { codec: "lcov", data: lcovText(SCRAMBLED) }));
    const sentReversed = eventIdOf(await ingestRun(handle, key, "reordered", { codec: "lcov", data: lcovText(reversed) }));

    const db = dbOf(handle.store);
    expect((await storedFiles(db, sent)).map((file) => file.path)).toEqual(KEPT_ORDER);
    expect((await storedFiles(db, sentReversed)).map((file) => file.path)).toEqual(KEPT_ORDER);
  });

  test("a file with lines and none covered is first, while a file with no lines is last", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["zero-and-empty"]);
    const text = lcovText([{ path: "src/empty.ts" }, { path: "src/half.ts", lf: 2, lh: 1 }, { path: "src/zero.ts", lf: 4, lh: 0 }]);

    const eventId = eventIdOf(await ingestRun(handle, key, "zero-and-empty", { codec: "lcov", data: text }));

    // Both `src/zero.ts` and `src/empty.ts` are at percent 0: only the one with lines leads.
    expect((await storedFiles(dbOf(handle.store), eventId)).map((file) => file.path)).toEqual([
      "src/zero.ts",
      "src/half.ts",
      "src/empty.ts",
    ]);
  });
});

// ── A run that keeps no coverage keeps no files ─────────────────────────────

describe("a run that keeps no coverage stores no file row", () => {
  test("a failing run's coverage block stores no row, where a green run on the same board stores its files", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["red-runner"]);

    const failing = await ingestRun(handle, key, "red-runner", TWO_FILES_BLOCK, FAILING_REPORT);
    const failingId = eventIdOf(failing);
    // The run is stored, and its coverage is not.
    expect(storedCoverageText(handle, failingId)).toBeNull();

    const control = await expectAGreenRunStoresItsFiles(handle, key, "red-runner");
    const db = dbOf(handle.store);
    expect(fileRowCount(db, failingId)).toBe(0);
    expect(fileRowCount(db, control)).toBe(2);
    expect(fileRowTotal(db)).toBe(2);
  });

  test("coverage dropped as undecodable stores no row, where a green run on the same board stores its files", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["undecodable"]);
    // One good text and one with line counters but no `SF:` record: the whole block is dropped.
    const dropped = await ingestRun(handle, key, "undecodable", {
      codec: "lcov",
      data: [lcovText(TWO_FILES), "TN:\nLF:10\nLH:5\nend_of_record\n"],
    });
    const droppedId = eventIdOf(dropped);
    expect((dropped.body.warnings as Array<{ code: string }> | undefined)?.map((warning) => warning.code)).toEqual(["coverage-dropped"]);
    expect(storedCoverageText(handle, droppedId)).toBeNull();

    const control = await expectAGreenRunStoresItsFiles(handle, key, "undecodable");
    const db = dbOf(handle.store);
    expect(fileRowCount(db, droppedId)).toBe(0);
    expect(fileRowCount(db, control)).toBe(2);
    expect(fileRowTotal(db)).toBe(2);
  });

  test("a run posted already decoded to /api/v2/runs/parsed keeps its coverage totals and stores no row", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["parsed-poster"]);

    const parsed: Answer = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "parsed-poster",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 3 },
      tree: [{ name: "Suite", status: "pass", children: [{ name: "passes", status: "pass", duration_ms: 3 }] }],
      coverage: TWO_FILES_TOTALS,
    });
    const parsedId = eventIdOf(parsed);
    // Its coverage is kept as posted: totals only.
    expect(JSON.parse(storedCoverageText(handle, parsedId) ?? "null")).toEqual(TWO_FILES_TOTALS);

    const control = await expectAGreenRunStoresItsFiles(handle, key, "parsed-poster");
    const db = dbOf(handle.store);
    expect(fileRowCount(db, parsedId)).toBe(0);
    expect(fileRowCount(db, control)).toBe(2);
    expect(fileRowTotal(db)).toBe(2);
  });

  test("a green run with no coverage block, and one whose report decodes to no file, store no row", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["no-files"]);

    const bare = eventIdOf(await ingestRun(handle, key, "no-files"));
    const typesOnly = eventIdOf(
      await ingestRun(handle, key, "no-files", {
        codec: "go-coverprofile",
        data: fixtureText("go-coverprofile", "contracts-types-only.coverprofile"),
      }),
    );
    const headerOnly = eventIdOf(
      await ingestRun(handle, key, "no-files", { codec: "jacoco", data: fixtureText("jacoco-csv", "header-only.csv") }),
    );
    // A report of no file still keeps its coverage totals.
    expect(JSON.parse(storedCoverageText(handle, typesOnly) ?? "null")).toEqual({ lines: { total: 0, covered: 0, percent: 0 } });
    expect(storedCoverageText(handle, bare)).toBeNull();

    const control = await expectAGreenRunStoresItsFiles(handle, key, "no-files");
    const db = dbOf(handle.store);
    expect([fileRowCount(db, bare), fileRowCount(db, typesOnly), fileRowCount(db, headerOnly)]).toEqual([0, 0, 0]);
    expect(fileRowCount(db, control)).toBe(2);
    expect(fileRowTotal(db)).toBe(2);
  });
});
