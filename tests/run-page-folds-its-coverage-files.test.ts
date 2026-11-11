// A run's own page folds the run's coverage files.
//
// A test run that kept coverage shows one line above its test tree: its lines
// percent, its functions percent when it has one, and how many files it has.
// The line is folded when the page opens and no file is read. A click reads
// the run's first 50 files and shows the same table the Coverage tab shows,
// beneath the line; a second click removes it; unfolding again reads nothing.
// A run that kept coverage and no file shows its percents and one line saying
// so, with nothing to unfold; a run with no coverage shows no line at all.
// While the files are read the table's place shows the page's own loading
// line; a read that fails says so, and the next unfold reads again.
//
// The page is drawn in two containers, the home pane and the workspace, and
// every behaviour here is checked in both.
//
// Every run is ingested over HTTP on a real board (`startServer`, port 0, an
// in-memory store), and the production page is mounted against that board.
import { afterEach, describe, expect, test } from "bun:test";
import {
  eventRead,
  fixtureText,
  TWELVE_FILES,
  TWELVE_RECORDS,
  TWELVE_ROOT,
} from "./helpers/coverage-files-harness.ts";
import {
  all,
  closeBoards,
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
  openPage,
  percentsIn,
  press,
  reading,
  reads,
  refuseFileReads,
  RUN_PAGE_CONTAINERS,
  runPage,
  shownRows,
  startBoard,
  totalsOnlyRun,
  workspaceRunPath,
} from "./helpers/coverage-files-view.ts";
import { gateFetch } from "./helpers/fetch-gate.ts";
import { settleServedApp } from "./helpers/served-app.ts";

afterEach(closeBoards);

const NO_FILES_LINE = "no per-file coverage for this run";
const FAILED_READ_LINE = "could not read this run's files";
/** The words of the run page's own loading line, beside its spinner. */
const LOADING_WORDS = "loading run detail…";

/** The run page's coverage line, which must be there. */
function coverageLine(): HTMLElement {
  const lines = all("run-coverage", runPage());
  expect(lines, "the run page's coverage line").toHaveLength(1);
  return lines[0]!;
}

/** The first row of the run's test tree, which must be there. */
function firstSuiteRow(): HTMLElement {
  const row = one("suite-row", runPage());
  expect(row, "the run's test tree is drawn").not.toBeNull();
  return row!;
}

/** The names the rows show, read off each row's title with `root` taken away. */
function shownNames(root: string): string[] {
  return shownRows(runPage()).map((row) => (row.title ?? "").slice(root.length));
}

describe("the run page's own loading line", () => {
  test("while a run's detail is read, its page shows the spinner beside loading run detail…, and neither once the detail is drawn", async () => {
    const board = await startBoard();
    await lcovRun(board, TWELVE_RECORDS);
    await openPage(board, "/");
    const gate = gateFetch((url) => url.includes("depth=suites"));

    one("event-card")?.click();
    await settleServedApp();

    expect(gate.held).toHaveLength(1);
    expect(all("spinner", runPage())).toHaveLength(1);
    expect(reading(runPage())).toContain(LOADING_WORDS);

    gate.passThrough();
    await settleServedApp();

    expect(all("spinner", runPage())).toHaveLength(0);
    expect(reading(runPage())).not.toContain(LOADING_WORDS);
    expect(all("suite-row", runPage()).length).toBeGreaterThanOrEqual(1);
  });
});

describe("a run's own page on a run whose report states no function counters", () => {
  test("its coverage line reads two percents: the lines percent, then the functions percent the board answers", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, [
      { path: "/srv/app/src/a.ts", lf: 10, lh: 4 },
      { path: "/srv/app/src/b.ts", lf: 10, lh: 5 },
    ]);
    const kept = (await eventRead(board.handle, eventId, "?depth=suites")).coverage as {
      lines: { total: number; covered: number; percent: number };
      functions?: { total: number; covered: number; percent: number };
    };
    expect(kept.lines, "the run's stored lines").toEqual({ total: 20, covered: 9, percent: 45 });
    expect(kept.functions, "the run's stored coverage carries functions").toBeDefined();
    expect([kept.functions!.total, kept.functions!.covered], "functions of 0 of 0").toEqual([0, 0]);

    await openPage(board, workspaceRunPath(board, eventId));

    const text = reading(coverageLine());
    expect(percentsIn(text), `the line reads "${text}"`).toEqual(["45%", `${String(kept.functions!.percent)}%`]);
    expect(text).toContain("2 files");
  });
});

describe("a run's own page while its show all read is in flight", () => {
  test("the 50 rows stay, one spinner stands beneath them in the control's place, one read is sent, and all 60 rows replace it when the read answers", async () => {
    const board = await startBoard();
    const eventId = await lcovRun(board, numberedRecords(60));
    await openPage(board, workspaceRunPath(board, eventId));
    await press(coverageLine(), "the coverage line");
    expect(all("coverage-file-row", runPage())).toHaveLength(50);
    expect(all("spinner", runPage())).toHaveLength(0);
    const gate = gateFetch((url) => isFileRead(url));

    one("coverage-files-show-all", runPage())?.click();
    await settleServedApp();

    expect(gate.held.map((request) => request.url), "the one read sent, with no limit").toEqual([
      `/api/v2/events/${encodeURIComponent(eventId)}?depth=coverage`,
    ]);
    expect(gate.fired).toBe(1);
    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60).slice(0, 50));
    expect(all("coverage-files-show-all"), "the control gives its place to the loading line").toHaveLength(0);
    const spinners = all("spinner", runPage());
    expect(spinners, "the spinner in the control's place").toHaveLength(1);
    expect(
      follows(spinners[0]!, all("coverage-file-row", runPage())[49]!),
      "the spinner stands beneath the last row",
    ).toBe(true);
    expect(follows(firstSuiteRow(), spinners[0]!), "the spinner stands above the test tree").toBe(true);
    expect(reads(FAILED_READ_LINE)).toHaveLength(0);

    expect(gate.resolveAll()).toBe(1);
    await settleServedApp();

    expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
    expect(all("spinner", runPage())).toHaveLength(0);
    expect(all("coverage-files-show-all")).toHaveLength(0);
    expect(gate.fired, "no second read was sent").toBe(1);
    expect(fileReads(eventId)).toEqual([FIRST_FIFTY, EVERY_FILE]);
  });
});

for (const [container, pathOf] of RUN_PAGE_CONTAINERS) {
  describe(`a run's own page in ${container} shows its coverage folded`, () => {
    test("a test run with files shows one coverage line above its test tree, reading its lines percent, its functions percent and its file count, with no table and no read of its files", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, TWELVE_RECORDS);

      await openPage(board, pathOf(board, eventId));

      const line = coverageLine();
      expect(percentsIn(reading(line)), `the line reads "${reading(line)}"`).toEqual(["49.1%", "62.5%"]);
      expect(reading(line)).toContain("12 files");
      expect(follows(firstSuiteRow(), line), "the line is above the test tree").toBe(true);
      expect(all("coverage-files")).toHaveLength(0);
      expect(all("coverage-file-row")).toHaveLength(0);
      expect(all("coverage-files-show-all")).toHaveLength(0);
      expect(reads(NO_FILES_LINE)).toHaveLength(0);
      expect(fileReads(), "no file is read while the line is folded").toEqual([]);
    });

    test("a click shows the file table beneath the line and above the test tree, a second click removes it, and unfolding again reads nothing", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, TWELVE_RECORDS);
      await openPage(board, pathOf(board, eventId));

      await press(coverageLine(), "the coverage line");

      expect(all("coverage-files", runPage())).toHaveLength(1);
      const table = one("coverage-files", runPage())!;
      expect(follows(table, coverageLine()), "the table is beneath the line").toBe(true);
      expect(follows(firstSuiteRow(), table), "the table is above the test tree").toBe(true);
      expect(reads("Files · 12", table), "the table's heading").toHaveLength(1);
      expect(reads("file", table), "the name column's heading").toHaveLength(1);
      expectRowsShow(TWELVE_FILES, TWELVE_ROOT, runPage());
      expect(shownRows(runPage())[0]?.title).toBe("/home/dev/app/src/lib/f07.ts");
      expect(shownRows(runPage())[0]?.text.startsWith("lib/f07.ts")).toBe(true);
      expect(all("coverage-files-show-all")).toHaveLength(0);
      expect(fileReads(eventId)).toEqual([FIRST_FIFTY]);

      await press(coverageLine(), "the coverage line, a second time");

      expect(all("coverage-files")).toHaveLength(0);
      expect(all("coverage-file-row")).toHaveLength(0);
      expect(percentsIn(reading(coverageLine()))).toEqual(["49.1%", "62.5%"]);
      expect(fileReads(eventId)).toEqual([FIRST_FIFTY]);

      await press(coverageLine(), "the coverage line, a third time");

      expect(all("coverage-file-row", runPage())).toHaveLength(12);
      expect(fileReads(eventId), "the files are read on the first unfold only").toEqual([FIRST_FIFTY]);
      expect(fileReads()).toEqual([FIRST_FIFTY]);
    });

    test("a run whose coverage states no functions reads one percent on its coverage line", async () => {
      const board = await startBoard();
      const eventId = await greenRun(
        board,
        { codec: "go-coverprofile", data: fixtureText("go-coverprofile", "shop-plain.coverprofile") },
        { stack: "go" },
      );
      const kept = (await eventRead(board.handle, eventId, "?depth=suites")).coverage as Record<string, unknown>;
      expect(Object.keys(kept), "the run's coverage is its lines alone").toEqual(["lines"]);

      await openPage(board, pathOf(board, eventId));

      const line = coverageLine();
      expect(percentsIn(reading(line)), `the line reads "${reading(line)}"`).toEqual(["22.2%"]);
      expect(reading(line)).toContain("3 files");
    });

    test("a run of one file reads 1 file on its coverage line", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, [{ path: "/srv/app/src/only.ts", lf: 8, lh: 6, fnf: 4, fnh: 1 }]);

      await openPage(board, pathOf(board, eventId));

      const text = reading(coverageLine());
      expect(percentsIn(text), `the line reads "${text}"`).toEqual(["75%", "25%"]);
      expect(text).toMatch(/\b1 file\b/);
      expect(text).not.toContain("1 files");
    });

    test("a Maven run's table heads its name column class", async () => {
      const board = await startBoard();
      const eventId = await greenRun(
        board,
        { codec: "jacoco", data: fixtureText("jacoco-csv", "multi-row.csv") },
        { stack: "mvn" },
      );
      await openPage(board, pathOf(board, eventId));

      await press(coverageLine(), "the coverage line");

      const table = one("coverage-files", runPage());
      expect(table).not.toBeNull();
      expect(reads("Files · 5", table!)).toHaveLength(1);
      expect(reads("class", table!), "the name column's heading").toHaveLength(1);
      expect(reads("file", table!)).toHaveLength(0);
      expect(shownRows(runPage()).map((row) => row.title)).toEqual([
        "com.acme.shop.tax.Rate",
        "com.acme.shop.Currency",
        "Launcher",
        "com.acme.shop.Basket",
        "com.acme.shop.Basket.Line",
      ]);
      expect(shownRows(runPage())[1]?.text.replace(/\s+/g, "")).toBe("com.acme.shop.Currency0/20%");
    });

    test("a run of 60 files unfolds to its first 50 rows and show all 60, and the control lists all 60 and goes", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, numberedRecords(60));
      await openPage(board, pathOf(board, eventId));
      expect(reading(coverageLine())).toContain("60 files");

      await press(coverageLine(), "the coverage line");

      expect(reads("Files · 60", one("coverage-files", runPage()) ?? document)).toHaveLength(1);
      expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60).slice(0, 50));
      expect(reading(one("coverage-files-show-all", runPage()))).toBe("show all 60");
      expect(fileReads(eventId)).toEqual([FIRST_FIFTY]);

      await press(one("coverage-files-show-all", runPage()), "the show all control");

      expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
      expect(all("coverage-files-show-all")).toHaveLength(0);
      expect(fileReads(eventId)).toEqual([FIRST_FIFTY, EVERY_FILE]);
    });
  });

  describe(`a run's own page in ${container} on a run without files`, () => {
    test("a run filed with totals only shows its percents and no per-file coverage for this run, with no table and nothing to unfold", async () => {
      const board = await startBoard();
      const eventId = await totalsOnlyRun(board, {
        lines: { total: 200, covered: 150, percent: 75 },
        functions: { total: 20, covered: 11, percent: 55 },
      });

      await openPage(board, pathOf(board, eventId));

      const text = reading(coverageLine());
      expect(percentsIn(text), `the line reads "${text}"`).toEqual(["75%", "55%"]);
      expect(text).not.toMatch(/\d+ files?\b/);
      expect(reads(NO_FILES_LINE, runPage()), "the line that says the run has no files").toHaveLength(1);
      expect(all("coverage-files")).toHaveLength(0);

      await press(coverageLine(), "the coverage line");

      expect(all("coverage-files")).toHaveLength(0);
      expect(all("coverage-file-row")).toHaveLength(0);
      expect(all("spinner", runPage())).toHaveLength(0);
      expect(reads(NO_FILES_LINE, runPage())).toHaveLength(1);
      expect(reads(FAILED_READ_LINE)).toHaveLength(0);
      expect(fileReads(), "a run without files has nothing to read").toEqual([]);
    });

    test("a run whose report decoded to no file shows its percent and no per-file coverage for this run, with no table and nothing to unfold", async () => {
      const board = await startBoard();
      const eventId = await greenRun(
        board,
        { codec: "go-coverprofile", data: fixtureText("go-coverprofile", "contracts-types-only.coverprofile") },
        { stack: "go" },
      );
      const kept = (await eventRead(board.handle, eventId, "?depth=suites")).coverage as {
        lines: { total: number; percent: number };
      };
      expect(kept.lines.total, "the run kept coverage of no lines").toBe(0);

      await openPage(board, pathOf(board, eventId));

      const text = reading(coverageLine());
      expect(percentsIn(text), `the line reads "${text}"`).toEqual([`${String(kept.lines.percent)}%`]);
      expect(text).not.toMatch(/\d+ files?\b/);
      expect(reads(NO_FILES_LINE, runPage()), "the line that says the run has no files").toHaveLength(1);

      await press(coverageLine(), "the coverage line");

      expect(all("coverage-files")).toHaveLength(0);
      expect(reads(NO_FILES_LINE, runPage())).toHaveLength(1);
      expect(fileReads(), "a run without files has nothing to read").toEqual([]);
    });

    test("a green run filed with no coverage shows its test tree and no coverage line", async () => {
      const board = await startBoard();
      const eventId = await greenRun(board);

      await openPage(board, pathOf(board, eventId));

      firstSuiteRow();
      expect(all("run-coverage")).toHaveLength(0);
      expect(all("coverage-files")).toHaveLength(0);
      expect(reads(NO_FILES_LINE)).toHaveLength(0);
      expect(fileReads()).toEqual([]);
    });

    test("a failing run filed with a coverage report keeps no coverage and shows no coverage line", async () => {
      const board = await startBoard();
      const eventId = await failingRun(board, {
        codec: "lcov",
        data: "SF:/srv/app/src/red.ts\nLF:10\nLH:1\nend_of_record\n",
      });

      await openPage(board, pathOf(board, eventId));

      firstSuiteRow();
      expect(all("run-coverage")).toHaveLength(0);
      expect(all("coverage-files")).toHaveLength(0);
      expect(reads(NO_FILES_LINE)).toHaveLength(0);
      expect(fileReads()).toEqual([]);
    });
  });

  describe(`a run's own page in ${container} while its files are read, and when the read fails`, () => {
    test("while the files are read the table's place shows the page's loading line, the coverage line and the test tree stay, and the rows replace it when the read answers", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, TWELVE_RECORDS);
      await openPage(board, pathOf(board, eventId));
      expect(all("spinner", runPage())).toHaveLength(0);
      expect(reading(runPage())).not.toContain(LOADING_WORDS);
      const gate = gateFetch((url) => isFileRead(url));

      coverageLine().click();
      await settleServedApp();

      expect(gate.held.map((request) => request.url)).toEqual([
        `/api/v2/events/${encodeURIComponent(eventId)}?depth=coverage&files=50`,
      ]);
      expect(all("spinner", runPage()), "the spinner in the table's place").toHaveLength(1);
      expect(reading(runPage())).toContain(LOADING_WORDS);
      expect(follows(one("spinner", runPage())!, coverageLine()), "the loading line is beneath the coverage line").toBe(true);
      expect(follows(firstSuiteRow(), one("spinner", runPage())!), "the loading line is above the test tree").toBe(true);
      expect(all("coverage-file-row")).toHaveLength(0);
      expect(percentsIn(reading(coverageLine()))).toEqual(["49.1%", "62.5%"]);

      expect(gate.resolveAll()).toBe(1);
      await settleServedApp();

      expect(all("spinner", runPage())).toHaveLength(0);
      expect(reading(runPage())).not.toContain(LOADING_WORDS);
      expectRowsShow(TWELVE_FILES, TWELVE_ROOT, runPage());
      expect(gate.fired).toBe(1);
    });

    test("a read that never reaches the board shows could not read this run's files, the percents stay, and the next unfold reads again", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, TWELVE_RECORDS);
      await openPage(board, pathOf(board, eventId));
      const gate = gateFetch((url) => isFileRead(url));

      coverageLine().click();
      await settleServedApp();
      expect(gate.held).toHaveLength(1);
      expect(gate.rejectAll(new Error("network down"))).toBe(1);
      await settleServedApp();

      expect(reads(FAILED_READ_LINE, runPage()), "the line that says the read failed").toHaveLength(1);
      expect(all("spinner", runPage())).toHaveLength(0);
      expect(all("coverage-file-row")).toHaveLength(0);
      expect(percentsIn(reading(coverageLine()))).toEqual(["49.1%", "62.5%"]);
      expect(reading(coverageLine())).toContain("12 files");
      firstSuiteRow();

      // Fold: the failure line goes with the table's place, and nothing is read.
      coverageLine().click();
      await settleServedApp();
      expect(reads(FAILED_READ_LINE)).toHaveLength(0);
      expect(all("coverage-files")).toHaveLength(0);
      expect(gate.fired).toBe(1);

      // The next unfold reads again.
      coverageLine().click();
      await settleServedApp();
      expect(gate.fired).toBe(2);
      expect(gate.held.map((request) => request.url)).toEqual([
        `/api/v2/events/${encodeURIComponent(eventId)}?depth=coverage&files=50`,
      ]);
      gate.passThrough();
      await settleServedApp();

      expectRowsShow(TWELVE_FILES, TWELVE_ROOT, runPage());
      expect(reads(FAILED_READ_LINE)).toHaveLength(0);
    });

    test("a read the board answers with an error shows could not read this run's files, and the next unfold reads again", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, TWELVE_RECORDS);
      await openPage(board, pathOf(board, eventId));
      const refusal = refuseFileReads(500);

      await press(coverageLine(), "the coverage line");

      expect(refusal.refused).toBe(1);
      expect(reads(FAILED_READ_LINE, runPage()), "the line that says the read failed").toHaveLength(1);
      expect(all("coverage-file-row")).toHaveLength(0);
      expect(percentsIn(reading(coverageLine()))).toEqual(["49.1%", "62.5%"]);

      refusal.lift();
      await press(coverageLine(), "the coverage line, to fold it");
      await press(coverageLine(), "the coverage line, to unfold it");

      expectRowsShow(TWELVE_FILES, TWELVE_ROOT, runPage());
      expect(reads(FAILED_READ_LINE)).toHaveLength(0);
      expect(fileReads(eventId)).toEqual([FIRST_FIFTY]);
    });

    test("a failed show all read keeps the 50 rows with the failure line beneath them, and the next click reads again and lists all 60", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, numberedRecords(60));
      await openPage(board, pathOf(board, eventId));
      await press(coverageLine(), "the coverage line");
      expect(all("coverage-file-row", runPage())).toHaveLength(50);
      const everyFile = `/api/v2/events/${encodeURIComponent(eventId)}?depth=coverage`;
      const gate = gateFetch((url) => isFileRead(url));

      one("coverage-files-show-all", runPage())?.click();
      await settleServedApp();
      expect(gate.held.map((request) => request.url)).toEqual([everyFile]);
      expect(gate.rejectAll(new Error("network down"))).toBe(1);
      await settleServedApp();

      expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60).slice(0, 50));
      const failure = reads(FAILED_READ_LINE, runPage());
      expect(failure, "the line that says the read failed").toHaveLength(1);
      expect(follows(failure[0]!, all("coverage-file-row", runPage())[49]!), "the failure line sits beneath the rows").toBe(true);
      expect(reading(one("coverage-files-show-all", runPage()))).toBe("show all 60");

      one("coverage-files-show-all", runPage())?.click();
      await settleServedApp();
      expect(gate.fired).toBe(2);
      gate.passThrough();
      await settleServedApp();

      expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
      expect(all("coverage-files-show-all")).toHaveLength(0);
      expect(reads(FAILED_READ_LINE)).toHaveLength(0);
    });
  });

  describe(`a run's own page in ${container} across a refresh`, () => {
    test("an unfolded page showing all 60 files keeps its 60 rows and sends no request for the files when a frame arrives", async () => {
      const board = await startBoard();
      const eventId = await lcovRun(board, numberedRecords(60));
      await openPage(board, pathOf(board, eventId));
      await press(coverageLine(), "the coverage line");
      await press(one("coverage-files-show-all", runPage()), "the show all control");
      expect(all("coverage-file-row", runPage())).toHaveLength(60);
      expect(fileReads()).toEqual([FIRST_FIFTY, EVERY_FILE]);

      // A failing run keeps no coverage: the project's latest coverage run
      // stays the same one while its list of runs moves.
      await failingRun(board);
      await eventsFrameArrives(board);
      await eventsFrameArrives(board);

      expect(shownNames(NUMBERED_ROOT)).toEqual(numberedNames(60));
      expect(all("coverage-files-show-all")).toHaveLength(0);
      expect(all("spinner", runPage())).toHaveLength(0);
      expect(reading(coverageLine())).toContain("60 files");
      expect(fileReads(eventId)).toEqual([FIRST_FIFTY, EVERY_FILE]);
      expect(fileReads(), "no run's files were read again").toEqual([FIRST_FIFTY, EVERY_FILE]);
    });
  });
}
