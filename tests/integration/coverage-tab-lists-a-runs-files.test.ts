// The project's Coverage tab lists the files of its latest green coverage run.
//
// Beneath the totals and `view run`, the tab shows one table of the run's
// files, least covered first as the board keeps them: a heading stating how
// many there are, one row per file with its name, its lines, a meter, the
// lines percent and its functions. A run of more than 50 files opens on its
// first 50 with one control that lists them all. A run that kept coverage and
// no file says so in one line. While the files are read the table's place
// shows the board's spinner; a read that fails says so and leaves the totals
// in place. The table follows the project's latest coverage run, and a
// refresh that leaves that run in place redraws nothing and reads nothing.
//
// Every run here is ingested over HTTP on a real board (`startServer`, port 0,
// an in-memory store), and the production page is mounted against that board.
import { afterEach, describe, expect, test } from "bun:test";
import { fixtureText, TWELVE_FILES, TWELVE_RECORDS, TWELVE_ROOT, type CoverageFile } from "../helpers/coverage-files-harness.ts";
import {
  all,
  boardFiles,
  closeBoards,
  coveragePane,
  eventsFrameArrives,
  EVERY_FILE,
  expectRowsShow,
  failingRun,
  fileReads,
  FIRST_FIFTY,
  follows,
  greenRun,
  isFileRead,
  lcovRun,
  numberedNames,
  NUMBERED_ROOT,
  numberedRecords,
  one,
  openCoverageTab,
  openPage,
  press,
  reading,
  reads,
  refuseFileReads,
  selectCoverageTab,
  shownRows,
  startBoard,
  totalsOnlyRun,
} from "../helpers/coverage-files-view.ts";
import { gateFetch } from "../helpers/fetch-gate.ts";
import { settleServedApp } from "../helpers/served-app.ts";

afterEach(closeBoards);

const NO_FILES_LINE = "no per-file coverage for this run";
const FAILED_READ_LINE = "could not read this run's files";

/** The names the rows show, read off each row's title with `root` taken away. */
function shownNames(root: string): string[] {
  return shownRows().map((row) => (row.title ?? "").slice(root.length));
}

/** The Coverage tab's panel text. */
function panelText(): string {
  return reading(one("coverage-panel"));
}

/** A multi-row JaCoCo report's classes as the board keeps them, written out by hand. */
const SHOP_CLASSES: CoverageFile[] = [
  {
    path: "com.acme.shop.tax.Rate",
    lines: { total: 8, covered: 0, percent: 0 },
    functions: { total: 3, covered: 0, percent: 0 },
  },
  { path: "com.acme.shop.Currency", lines: { total: 2, covered: 0, percent: 0 } },
  { path: "Launcher", lines: { total: 6, covered: 2, percent: 33.3 }, functions: { total: 2, covered: 1, percent: 50 } },
  {
    path: "com.acme.shop.Basket",
    lines: { total: 20, covered: 17, percent: 85 },
    functions: { total: 8, covered: 7, percent: 87.5 },
  },
  {
    path: "com.acme.shop.Basket.Line",
    lines: { total: 6, covered: 6, percent: 100 },
    functions: { total: 3, covered: 3, percent: 100 },
  },
];

/** A Go profile's files as the board keeps them, written out by hand. */
const SHOP_GO_ROOT = "example.com/shop/";
const SHOP_GO_FILES: CoverageFile[] = [
  { path: "example.com/shop/report/report.go", lines: { total: 3, covered: 0, percent: 0 } },
  { path: "example.com/shop/stock/stock.go", lines: { total: 5, covered: 1, percent: 20 } },
  { path: "example.com/shop/price/price.go", lines: { total: 10, covered: 3, percent: 30 } },
];

describe("the Coverage tab lists the files of the latest green coverage run", () => {
  test("beneath the totals and view run, the tab shows the files heading and one row per file in the board's order", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, TWELVE_RECORDS);
    const kept = await boardFiles(board, eventId);
    expect(kept, "the board keeps the twelve files this test expects").toEqual({
      count: 12,
      root: TWELVE_ROOT,
      files: TWELVE_FILES,
    });

    await openCoverageTab(board);

    // The totals and `view run`, as the tab shows them without the table.
    expect(panelText()).toContain("Coverage — latest green regression");
    expect(panelText()).toContain("lines 589/1200 · 49.1%");
    expect(panelText()).toContain("functions 15/24 · 62.5%");
    const viewRun = one("coverage-view-run");
    expect(viewRun).not.toBeNull();
    expect(reading(viewRun)).toBe("view run");

    // The table, after them.
    expect(all("coverage-files")).toHaveLength(1);
    const table = one("coverage-files")!;
    expect(follows(table, viewRun!), "the table comes after view run").toBe(true);
    expect(reads("Files · 12", table), "the table's heading").toHaveLength(1);
    expect(all("coverage-file-row", table)).toHaveLength(12);
    expect(all("coverage-file-row")).toHaveLength(12);
    expect(shownNames(TWELVE_ROOT)).toEqual([
      "lib/f07.ts",
      "lib/f01.ts",
      "lib/f09.ts",
      "lib/f03.ts",
      "lib/f11.ts",
      "lib/f05.ts",
      "f00.ts",
      "f08.ts",
      "f04.ts",
      "f10.ts",
      "f02.ts",
      "f06.ts",
    ]);
  });

  test("each row reads its name, its lines as covered/total, its lines percent and its functions as covered/total · percent, with a meter filled to the lines percent", async () => {
    const board = await startBoard();
    await lcovRun(board, TWELVE_RECORDS);

    await openCoverageTab(board);

    expectRowsShow(TWELVE_FILES, TWELVE_ROOT);
    const rows = shownRows();
    // A file with functions, read whole: nothing but its four figures.
    expect(rows[9]?.text.replace(/\s+/g, "")).toBe("f10.ts86/10086%1/4·25%".replace(/\s+/g, ""));
    expect(rows[9]?.widths).toContain("86%");
    // The least covered file: 0 of 100 lines, drawn as an empty meter.
    expect(rows[0]?.widths).toContain("0%");
    expect(rows[11]?.widths).toContain("100%");
  });

  test("the tab requests the run's first 50 files, once", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, TWELVE_RECORDS);

    await openPage(board, `/p/${board.key}`);
    await selectCoverageTab();

    expect(fileReads(eventId)).toEqual([FIRST_FIFTY]);
    expect(fileReads(), "no other run's files are read").toEqual([FIRST_FIFTY]);
  });

  test("the newest green coverage run is the one listed, not an older one", async () => {
    const board = await startBoard();
    const older = await lcovRun(board, TWELVE_RECORDS);
    const newer = await lcovRun(board, numberedRecords(3));

    await openCoverageTab(board);

    expect(reads("Files · 3", one("coverage-files") ?? document)).toHaveLength(1);
    expect(shownNames(NUMBERED_ROOT)).toEqual(["m00.ts", "m01.ts", "m02.ts"]);
    expect(fileReads(newer)).toEqual([FIRST_FIFTY]);
    expect(fileReads(older)).toEqual([]);
  });
});

describe("the Coverage tab's file names and headings", () => {
  test("a row shows its name without the directory every file shares, and carries the whole name as its title", async () => {
    const board = await startBoard();
    await lcovRun(board, TWELVE_RECORDS);

    await openCoverageTab(board);

    const rows = shownRows();
    expect(rows).toHaveLength(12);
    expect(rows[0]?.title).toBe("/home/dev/app/src/lib/f07.ts");
    expect(rows[0]?.text.startsWith("lib/f07.ts"), `the first row reads "${rows[0]?.text}"`).toBe(true);
    expect(rows[6]?.title).toBe("/home/dev/app/src/f00.ts");
    expect(rows[6]?.text.startsWith("f00.ts"), `the seventh row reads "${rows[6]?.text}"`).toBe(true);
    for (const row of rows) {
      expect(row.text.includes("/home/dev"), `a row shows the shared directory: "${row.text}"`).toBe(false);
    }
  });

  test("a run whose files share no directory shows each name whole", async () => {
    const board = await startBoard();
    await lcovRun(board, [
      { path: "src/a.ts", lf: 10, lh: 1 },
      { path: "srcgen/b.ts", lf: 10, lh: 9 },
    ]);

    await openCoverageTab(board);

    const rows = shownRows();
    expect(rows.map((row) => row.title)).toEqual(["src/a.ts", "srcgen/b.ts"]);
    expect(rows[0]?.text.startsWith("src/a.ts")).toBe(true);
    expect(rows[1]?.text.startsWith("srcgen/b.ts")).toBe(true);
  });

  test("a run that is not a Maven run heads its name column file", async () => {
    const board = await startBoard();
    await lcovRun(board, TWELVE_RECORDS, { stack: "bun" });

    await openCoverageTab(board);

    const table = one("coverage-files");
    expect(table).not.toBeNull();
    expect(reads("file", table!), "the name column's heading").toHaveLength(1);
    expect(reads("class", table!)).toHaveLength(0);
  });

  test("a Maven run heads its name column class, names each class whole, and leaves the functions cell of a class with no methods empty", async () => {
    const board = await startBoard();
    const eventId = await greenRun(
      board,
      { codec: "jacoco", data: fixtureText("jacoco-csv", "multi-row.csv") },
      { stack: "mvn" },
    );
    const kept = await boardFiles(board, eventId);
    expect(kept, "the board keeps the five classes this test expects").toEqual({ count: 5, root: "", files: SHOP_CLASSES });

    await openCoverageTab(board);

    const table = one("coverage-files");
    expect(table).not.toBeNull();
    expect(reads("Files · 5", table!)).toHaveLength(1);
    expect(reads("class", table!), "the name column's heading").toHaveLength(1);
    expect(reads("file", table!)).toHaveLength(0);
    // Every row: its class whole (the run's classes share no directory), its
    // figures, and nothing else, so `Currency`, which has no methods, shows
    // no functions figure at all.
    expectRowsShow(SHOP_CLASSES, "");
    const currency = shownRows()[1];
    expect(currency?.text.replace(/\s+/g, "")).toBe("com.acme.shop.Currency0/20%");
  });

  test("a Go run's rows show lines only: every functions cell is empty", async () => {
    const board = await startBoard();
    const eventId = await greenRun(
      board,
      { codec: "go-coverprofile", data: fixtureText("go-coverprofile", "shop-plain.coverprofile") },
      { stack: "go" },
    );
    const kept = await boardFiles(board, eventId);
    expect(kept, "the board keeps the three files this test expects").toEqual({
      count: 3,
      root: SHOP_GO_ROOT,
      files: SHOP_GO_FILES,
    });

    await openCoverageTab(board);

    const table = one("coverage-files");
    expect(table).not.toBeNull();
    expect(reads("file", table!), "the name column's heading").toHaveLength(1);
    expect(reads("class", table!)).toHaveLength(0);
    expectRowsShow(SHOP_GO_FILES, SHOP_GO_ROOT);
    expect(shownRows().map((row) => row.text.replace(/\s+/g, ""))).toEqual([
      "report/report.go0/30%",
      "stock/stock.go1/520%",
      "price/price.go3/1030%",
    ]);
  });
});

describe("the Coverage tab on a run of more than 50 files", () => {
  test("a run of 60 files opens on its first 50 rows and one control reading show all 60", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(60));

    await openCoverageTab(board);

    const table = one("coverage-files");
    expect(table).not.toBeNull();
    expect(reads("Files · 60", table!), "the heading states the run's whole count").toHaveLength(1);
    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60).slice(0, 50));
    const control = all("coverage-files-show-all");
    expect(control).toHaveLength(1);
    expect(reading(control[0])).toBe("show all 60");
    expect(follows(control[0]!, all("coverage-file-row")[49]!), "the control sits beneath the rows").toBe(true);
    expect(fileReads(eventId)).toEqual([FIRST_FIFTY]);
  });

  test("show all requests the files with no limit, lists all 60 and removes the control", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(60));
    await openCoverageTab(board);

    await press(one("coverage-files-show-all"), "the show all control");

    expect(fileReads(eventId)).toEqual([FIRST_FIFTY, EVERY_FILE]);
    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(reads("Files · 60", one("coverage-files") ?? document)).toHaveLength(1);
    expect(all("coverage-files")).toHaveLength(1);
  });

  test("a run of exactly 50 files lists its 50 rows and shows no control", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(50));

    await openCoverageTab(board);

    expect(reads("Files · 50", one("coverage-files") ?? document)).toHaveLength(1);
    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(50));
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(fileReads(eventId)).toEqual([FIRST_FIFTY]);
  });

  test("a run of 51 files opens on 50 rows and a control reading show all 51", async () => {
    const board = await startBoard();
    await lcovRun(board, numberedRecords(51));

    await openCoverageTab(board);

    expect(all("coverage-file-row")).toHaveLength(50);
    expect(reading(one("coverage-files-show-all"))).toBe("show all 51");
  });

  test("a run of 3 files lists its 3 rows and shows no control", async () => {
    const board = await startBoard();
    await lcovRun(board, numberedRecords(3));

    await openCoverageTab(board);

    expect(reads("Files · 3", one("coverage-files") ?? document)).toHaveLength(1);
    expect(shownNames(NUMBERED_ROOT)).toEqual(["m00.ts", "m01.ts", "m02.ts"]);
    expect(all("coverage-files-show-all")).toHaveLength(0);
  });

  test("a run of one file heads its table Files · 1", async () => {
    const board = await startBoard();
    await lcovRun(board, [{ path: "/srv/app/src/only.ts", lf: 8, lh: 6 }]);

    await openCoverageTab(board);

    expect(reads("Files · 1", one("coverage-files") ?? document)).toHaveLength(1);
    const rows = shownRows();
    expect(rows.map((row) => row.title)).toEqual(["/srv/app/src/only.ts"]);
    expect(rows[0]?.text.replace(/\s+/g, "")).toBe("only.ts6/875%");
  });
});

describe("the Coverage tab on a run that kept coverage and no file", () => {
  test("a run filed with totals only shows its totals, view run and no per-file coverage for this run, with no table", async () => {
    const board = await startBoard();
    await totalsOnlyRun(board, {
      lines: { total: 200, covered: 150, percent: 75 },
      functions: { total: 20, covered: 11, percent: 55 },
    });

    await openCoverageTab(board);

    expect(panelText()).toContain("lines 150/200 · 75%");
    expect(panelText()).toContain("functions 11/20 · 55%");
    expect(reading(one("coverage-view-run"))).toBe("view run");
    expect(reads(NO_FILES_LINE, coveragePane()), "the line that says the run has no files").toHaveLength(1);
    expect(all("coverage-files")).toHaveLength(0);
    expect(all("coverage-file-row")).toHaveLength(0);
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(all("spinner", coveragePane())).toHaveLength(0);
  });

  test("a run whose report decoded to no file shows its totals and no per-file coverage for this run, with no table", async () => {
    const board = await startBoard();
    const eventId = await greenRun(
      board,
      { codec: "go-coverprofile", data: fixtureText("go-coverprofile", "contracts-types-only.coverprofile") },
      { stack: "go" },
    );
    const kept = await boardFiles(board, eventId);
    expect(kept, "the board keeps no file for a profile of its mode line alone").toEqual({ count: 0, root: "", files: [] });

    await openCoverageTab(board);

    expect(panelText()).toContain("lines 0/0 · ");
    expect(reading(one("coverage-view-run"))).toBe("view run");
    expect(reads(NO_FILES_LINE, coveragePane()), "the line that says the run has no files").toHaveLength(1);
    expect(all("coverage-files")).toHaveLength(0);
    expect(all("coverage-file-row")).toHaveLength(0);
  });

  test("a run with files does not say it has none", async () => {
    const board = await startBoard();
    await lcovRun(board, numberedRecords(3));

    await openCoverageTab(board);

    expect(all("coverage-file-row")).toHaveLength(3);
    expect(reads(NO_FILES_LINE)).toHaveLength(0);
    expect(reads(FAILED_READ_LINE)).toHaveLength(0);
  });
});

describe("the Coverage tab while its files are read, and when the read fails", () => {
  test("while the files are read the table's place shows the board's spinner, the totals and view run stay, and the rows replace it when the read answers", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(3));
    await openPage(board, `/p/${board.key}`);
    const gate = gateFetch((url) => isFileRead(url));

    await selectCoverageTab();

    expect(gate.held.map((request) => request.url)).toEqual([
      `/api/v2/events/${encodeURIComponent(eventId)}?depth=coverage&files=50`,
    ]);
    expect(all("spinner", coveragePane()), "the spinner in the table's place").toHaveLength(1);
    expect(all("coverage-file-row")).toHaveLength(0);
    expect(reads(NO_FILES_LINE)).toHaveLength(0);
    expect(reads(FAILED_READ_LINE)).toHaveLength(0);
    expect(panelText()).toContain("lines 3/300 · 1%");
    expect(panelText()).toContain("functions 6/12 · 50%");
    expect(reading(one("coverage-view-run"))).toBe("view run");

    expect(gate.resolveAll()).toBe(1);
    await settleServedApp();

    expect(all("spinner", coveragePane())).toHaveLength(0);
    expect(shownNames(NUMBERED_ROOT)).toEqual(["m00.ts", "m01.ts", "m02.ts"]);
    expect(gate.fired).toBe(1);
  });

  test("a read that never reaches the board shows could not read this run's files, and the totals and view run stay", async () => {
    const board = await startBoard();
    await lcovRun(board, numberedRecords(3));
    await openPage(board, `/p/${board.key}`);
    const gate = gateFetch((url) => isFileRead(url));
    await selectCoverageTab();
    expect(gate.held).toHaveLength(1);

    expect(gate.rejectAll(new Error("network down"))).toBe(1);
    await settleServedApp();

    expect(reads(FAILED_READ_LINE, coveragePane()), "the line that says the read failed").toHaveLength(1);
    expect(all("spinner", coveragePane())).toHaveLength(0);
    expect(all("coverage-file-row")).toHaveLength(0);
    expect(reads(NO_FILES_LINE)).toHaveLength(0);
    expect(panelText()).toContain("lines 3/300 · 1%");
    expect(panelText()).toContain("functions 6/12 · 50%");
    expect(reading(one("coverage-view-run"))).toBe("view run");
  });

  test("a read the board answers with an error shows could not read this run's files, and the totals and view run stay", async () => {
    const board = await startBoard();
    await lcovRun(board, numberedRecords(3));
    await openPage(board, `/p/${board.key}`);
    const refusal = refuseFileReads(500);

    await selectCoverageTab();

    expect(refusal.refused).toBe(1);
    expect(reads(FAILED_READ_LINE, coveragePane()), "the line that says the read failed").toHaveLength(1);
    expect(all("coverage-file-row")).toHaveLength(0);
    expect(reads(NO_FILES_LINE)).toHaveLength(0);
    expect(panelText()).toContain("lines 3/300 · 1%");
    expect(reading(one("coverage-view-run"))).toBe("view run");
  });

  test("while the show all read is in flight the 50 rows stay, one spinner stands beneath them in the control's place, one read is sent, and all 60 rows replace it when the read answers", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(60));
    await openCoverageTab(board);
    expect(all("coverage-file-row")).toHaveLength(50);
    expect(all("spinner", coveragePane())).toHaveLength(0);
    const gate = gateFetch((url) => isFileRead(url));

    one("coverage-files-show-all")?.click();
    await settleServedApp();

    expect(gate.held.map((request) => request.url), "the one read sent, with no limit").toEqual([
      `/api/v2/events/${encodeURIComponent(eventId)}?depth=coverage`,
    ]);
    expect(gate.fired).toBe(1);
    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60).slice(0, 50));
    expect(all("coverage-files-show-all"), "the control gives its place to the loading line").toHaveLength(0);
    const spinners = all("spinner", coveragePane());
    expect(spinners, "the spinner in the control's place").toHaveLength(1);
    expect(follows(spinners[0]!, all("coverage-file-row")[49]!), "the spinner stands beneath the last row").toBe(true);
    expect(reads(FAILED_READ_LINE)).toHaveLength(0);

    expect(gate.resolveAll()).toBe(1);
    await settleServedApp();

    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
    expect(all("spinner", coveragePane())).toHaveLength(0);
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(gate.fired, "no second read was sent").toBe(1);
    expect(fileReads(eventId)).toEqual([FIRST_FIFTY, EVERY_FILE]);
  });

  test("a failed show all read keeps the 50 rows with the failure line beneath them, and the next click reads again and lists all 60", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(60));
    await openCoverageTab(board);
    expect(all("coverage-file-row")).toHaveLength(50);
    const everyFile = `/api/v2/events/${encodeURIComponent(eventId)}?depth=coverage`;
    const gate = gateFetch((url) => isFileRead(url));

    one("coverage-files-show-all")?.click();
    await settleServedApp();
    expect(gate.held.map((request) => request.url)).toEqual([everyFile]);
    expect(gate.rejectAll(new Error("network down"))).toBe(1);
    await settleServedApp();

    // The 50 rows stay, the failure line is beneath them, the control is still there.
    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60).slice(0, 50));
    const failure = reads(FAILED_READ_LINE, coveragePane());
    expect(failure, "the line that says the read failed").toHaveLength(1);
    expect(follows(failure[0]!, all("coverage-file-row")[49]!), "the failure line sits beneath the rows").toBe(true);
    expect(reading(one("coverage-files-show-all"))).toBe("show all 60");

    // The next click reads again.
    one("coverage-files-show-all")?.click();
    await settleServedApp();
    expect(gate.fired).toBe(2);
    expect(gate.held.map((request) => request.url)).toEqual([everyFile]);
    gate.passThrough();
    await settleServedApp();

    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(reads(FAILED_READ_LINE)).toHaveLength(0);
  });
});

describe("the Coverage tab follows the project's latest coverage run", () => {
  /** Three files of a later run, in another directory, with totals unlike the 60-file run's. */
  const NEXT_ROOT = "/srv/next/src/";
  const NEXT_RECORDS = [
    { path: `${NEXT_ROOT}n0.ts`, lf: 100, lh: 10, fnf: 5, fnh: 1 },
    { path: `${NEXT_ROOT}n1.ts`, lf: 100, lh: 20, fnf: 5, fnh: 1 },
    { path: `${NEXT_ROOT}n2.ts`, lf: 100, lh: 30, fnf: 5, fnh: 1 },
  ];

  test("a newer green coverage run arriving on a frame moves the tab's totals to that run's", async () => {
    const board = await startBoard();
    await lcovRun(board, numberedRecords(60));
    await openCoverageTab(board);
    expect(panelText()).toContain("lines 1770/6000 · 29.5%");
    expect(panelText()).toContain("functions 120/240 · 50%");

    await lcovRun(board, NEXT_RECORDS);
    await eventsFrameArrives(board);

    expect(panelText()).toContain("lines 60/300 · 20%");
    expect(panelText()).toContain("functions 3/15 · 20%");
    expect(panelText()).not.toContain("1770/6000");
    expect(panelText()).not.toContain("120/240");
    expect(reading(one("coverage-view-run"))).toBe("view run");
  });

  test("with all 60 files shown, a newer green coverage run of 3 files arriving shows that run's 3 files, its totals and no control", async () => {
    const board = await startBoard();
    await lcovRun(board, numberedRecords(60));
    await openCoverageTab(board);
    await press(one("coverage-files-show-all"), "the show all control");
    expect(all("coverage-file-row")).toHaveLength(60);
    expect(panelText()).toContain("lines 1770/6000 · 29.5%");

    const newer = await lcovRun(board, NEXT_RECORDS);
    await eventsFrameArrives(board);

    expect(panelText()).toContain("lines 60/300 · 20%");
    expect(panelText()).toContain("functions 3/15 · 20%");
    expect(panelText()).not.toContain("1770/6000");
    expect(panelText()).not.toContain("120/240");
    expect(all("coverage-files")).toHaveLength(1);
    expect(reads("Files · 3", one("coverage-files")!)).toHaveLength(1);
    expect(shownNames(NEXT_ROOT)).toEqual(["n0.ts", "n1.ts", "n2.ts"]);
    expect(shownRows().map((row) => row.title)).toEqual([
      "/srv/next/src/n0.ts",
      "/srv/next/src/n1.ts",
      "/srv/next/src/n2.ts",
    ]);
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(fileReads(newer)).toEqual([FIRST_FIFTY]);
  });

  test("a read for the older run that answers after the newer run arrived does not replace the newer run's files", async () => {
    const board = await startBoard();
    const older = await lcovRun(board, numberedRecords(60));
    await openCoverageTab(board);
    expect(all("coverage-file-row")).toHaveLength(50);
    const gate = gateFetch((url) => isFileRead(url));

    // The older run's show all read is sent and held.
    one("coverage-files-show-all")?.click();
    await settleServedApp();
    expect(gate.held.map((request) => request.url)).toEqual([
      `/api/v2/events/${encodeURIComponent(older)}?depth=coverage`,
    ]);

    // The newer run arrives; its read answers first.
    const newer = await lcovRun(board, NEXT_RECORDS);
    await eventsFrameArrives(board);
    expect(gate.resolveWhere((url) => isFileRead(url, newer))).toBe(1);
    await settleServedApp();
    expect(shownNames(NEXT_ROOT)).toEqual(["n0.ts", "n1.ts", "n2.ts"]);

    // The older run's read answers late.
    expect(gate.resolveWhere((url) => isFileRead(url, older))).toBe(1);
    await settleServedApp();

    expect(shownRows().map((row) => row.title)).toEqual([
      "/srv/next/src/n0.ts",
      "/srv/next/src/n1.ts",
      "/srv/next/src/n2.ts",
    ]);
    expect(reads("Files · 3", one("coverage-files") ?? document)).toHaveLength(1);
    expect(reads("Files · 60")).toHaveLength(0);
    expect(all("coverage-files-show-all")).toHaveLength(0);

    expect(panelText()).toContain("lines 60/300 · 20%");
  });

  test("with all 60 files shown, a frame that leaves the latest coverage run unchanged keeps the 60 rows and sends no request for the files", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(60));
    await openCoverageTab(board);
    await press(one("coverage-files-show-all"), "the show all control");
    expect(all("coverage-file-row")).toHaveLength(60);
    expect(fileReads()).toEqual([FIRST_FIFTY, EVERY_FILE]);

    // A failing run keeps no coverage, so the project's latest coverage run
    // stays the same one while its list of runs moves.
    await failingRun(board, { codec: "lcov", data: "SF:/srv/app/src/red.ts\nLF:10\nLH:1\nend_of_record\n" });
    await eventsFrameArrives(board);
    await eventsFrameArrives(board);

    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(all("spinner", coveragePane())).toHaveLength(0);
    expect(fileReads(eventId)).toEqual([FIRST_FIFTY, EVERY_FILE]);
    expect(fileReads(), "no run's files were read again").toEqual([FIRST_FIFTY, EVERY_FILE]);
  });
});
