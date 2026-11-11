// `GET /api/v2/events/<id>?depth=coverage` reads a run's coverage files on
// their own:
//
//  - it answers the event without its tree and without its raw output, and
//    its `event` gains `coverageFileCount` (how many files the run has),
//    `coverageFiles` (the files in the stored order, each `{path, lines,
//    functions?}` with `{total, covered, percent}` axes) and `coverageRoot`
//    (the leading directories every file name shares);
//  - `&files=<n>` answers only the first `n` files, the count and the root
//    still the whole run's, and hands back no more file rows than it answers.
//    `n` is ASCII digits alone with a value of at least 1: anything else is
//    refused with 400, and an `n` above the run's count answers every file;
//  - an event that has no files, whatever its kind, answers the count 0, an
//    empty list and the empty root;
//  - an id the board does not hold answers 404, as the other reads do.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store). The statements a read runs are taken from the store's own
// connection, with the rows each hands back.
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import { bootOn, postJson, readyProject } from "./helpers/run-stream-harness.ts";
import {
  callsAnAggregate,
  closeStreamedRun,
  dbOf,
  eventIdOf,
  eventRead,
  FAILING_REPORT,
  fileReadKeysOf,
  fileRowCount,
  filesTableUse,
  fixtureText,
  getAnswer,
  inKeptOrder,
  ingestRun,
  lcovText,
  oracleFiles,
  PASSING_REPORT,
  recordQueries,
  storedFileOf,
  storedFiles,
  TWELVE_BLOCK,
  TWELVE_FILES,
  TWELVE_RECORDS,
  TWELVE_ROOT,
  TWELVE_TOTALS,
  without,
  type CoverageFile,
} from "./helpers/coverage-files-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "file-reader";

/** A board holding one green run of the twelve files. */
async function twelveFileRun(): Promise<{ handle: ServerHandle; key: string; eventId: string }> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT]);
  const eventId = eventIdOf(await ingestRun(handle, key, AGENT, TWELVE_BLOCK));
  return { handle, key, eventId };
}

function pathsOf(event: Record<string, unknown>): string[] | undefined {
  const files = event.coverageFiles;
  return Array.isArray(files) ? (files as CoverageFile[]).map((file) => file.path) : undefined;
}

const TWELVE_PATHS = TWELVE_FILES.map((file) => file.path);

// ── The read ────────────────────────────────────────────────────────────────

describe("?depth=coverage answers a run's files, their count and their root", () => {
  test("a run of 12 files answers all 12 in the stored order, the count 12 and the directory they share", async () => {
    const { handle, eventId } = await twelveFileRun();
    // The hand-written twelve are the files the coverage text states, in the kept order.
    expect(inKeptOrder(oracleFiles("lcov", [lcovText(TWELVE_RECORDS)]))).toEqual(TWELVE_FILES);
    // And they are the rows the run stores, position by position.
    expect(await storedFiles(dbOf(handle.store), eventId)).toEqual(TWELVE_FILES.map(storedFileOf));

    const event = await eventRead(handle, eventId, "?depth=coverage");

    expect(event.coverageFileCount).toBe(12);
    expect(event.coverageFiles).toEqual(TWELVE_FILES);
    expect(event.coverageRoot).toBe(TWELVE_ROOT);
    expect(event.id).toBe(eventId);
    // The order answered is the order the rows are stored in.
    expect((event.coverageFiles as CoverageFile[]).map(storedFileOf)).toEqual(await storedFiles(dbOf(handle.store), eventId));
  });

  test("the read answers neither the run's tree nor its raw output", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const rawOutput = "$ runner\nraw-output-marker-7c1f\n2 pass";
    const eventId = eventIdOf(
      await postJson(handle, "/api/v2/runs", {
        projectKey: key,
        agentId: AGENT,
        codec: "junit",
        data: PASSING_REPORT,
        raw: rawOutput,
        coverage: TWELVE_BLOCK,
      }),
    );
    // The run has both: the full read answers them.
    const full = await eventRead(handle, eventId);
    expect(full.raw).toBe(rawOutput);
    expect((full.tree as Array<{ name: string }>).map((suite) => suite.name)).toEqual(["Green"]);

    const event = await eventRead(handle, eventId, "?depth=coverage");

    expect(event.coverageFileCount).toBe(12);
    expect("tree" in event).toBe(false);
    expect("raw" in event).toBe(false);
    const text = JSON.stringify(event);
    expect(text).not.toContain("raw-output-marker-7c1f");
    // No suite and no test of the run's tree is in the answer.
    expect(text).not.toContain('"Green"');
    expect(text).not.toContain('"g1"');
  });

  test("the rest of the event is answered as the full read answers it: every key but the tree and the raw output, beside the three file keys", async () => {
    const { handle, eventId } = await twelveFileRun();
    const full = await eventRead(handle, eventId);
    expect(full.coverage).toEqual(TWELVE_TOTALS);

    const event = await eventRead(handle, eventId, "?depth=coverage");

    expect(fileReadKeysOf(event)).toEqual(["coverageFileCount", "coverageFiles", "coverageRoot"]);
    // The raw output's byte length is the one key left open here: a read may carry it or not.
    expect(without(event, ["coverageFileCount", "coverageFiles", "coverageRoot", "rawBytes"])).toEqual(
      without(full, ["tree", "raw"]),
    );
    // The run's totals stay the totals: the files are beside them, not in them.
    expect(event.coverage).toEqual(TWELVE_TOTALS);
  });

  test("each file is its name and its lines, with its functions only when it states any, each percent rounded as the run's totals are", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const eventId = eventIdOf(
      await ingestRun(handle, key, AGENT, {
        codec: "lcov",
        data: lcovText([
          { path: "src/zero-functions.ts", lf: 10, lh: 10, fnf: 0, fnh: 0 },
          { path: "src/rounded.ts", lf: 41, lh: 30, fnf: 7, fnh: 5 },
          { path: "src/no-functions.ts", lf: 8, lh: 2 },
        ]),
      }),
    );

    const event = await eventRead(handle, eventId, "?depth=coverage");

    expect(event.coverageFiles).toEqual([
      { path: "src/no-functions.ts", lines: { total: 8, covered: 2, percent: 25 } },
      {
        path: "src/rounded.ts",
        lines: { total: 41, covered: 30, percent: 73.2 },
        functions: { total: 7, covered: 5, percent: 71.4 },
      },
      { path: "src/zero-functions.ts", lines: { total: 10, covered: 10, percent: 100 } },
    ]);
    const files = event.coverageFiles as Array<Record<string, unknown>>;
    // A file with no functions axis has no `functions` key: not a null, and not an axis of 0.
    expect(files.map((file) => Object.keys(file).sort())).toEqual([
      ["lines", "path"],
      ["functions", "lines", "path"],
      ["lines", "path"],
    ]);
    expect(event.coverageFileCount).toBe(3);
    expect(event.coverageRoot).toBe("src/");
    // The run's own totals round the same way: 42 of 59 lines.
    expect((event.coverage as { lines: unknown }).lines).toEqual({ total: 59, covered: 42, percent: 71.2 });
  });

  test("the close of a streamed run is read as a single-shot ingest is", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const eventId = eventIdOf(await closeStreamedRun(handle, key, AGENT, TWELVE_BLOCK));

    const event = await eventRead(handle, eventId, "?depth=coverage");

    expect(event.coverageFileCount).toBe(12);
    expect(event.coverageFiles).toEqual(TWELVE_FILES);
    expect(event.coverageRoot).toBe(TWELVE_ROOT);
    expect("tree" in event).toBe(false);
  });

  test("two runs on one board are each read with their own files", async () => {
    const { handle, key, eventId } = await twelveFileRun();
    const other = eventIdOf(
      await ingestRun(handle, key, AGENT, {
        codec: "lcov",
        data: lcovText([
          { path: "pkg/one.ts", lf: 4, lh: 1 },
          { path: "pkg/two.ts", lf: 4, lh: 3 },
        ]),
      }),
    );

    const small = await eventRead(handle, other, "?depth=coverage");
    const twelve = await eventRead(handle, eventId, "?depth=coverage");

    expect(small.coverageFileCount).toBe(2);
    expect(pathsOf(small)).toEqual(["pkg/one.ts", "pkg/two.ts"]);
    expect(small.coverageRoot).toBe("pkg/");
    expect(twelve.coverageFileCount).toBe(12);
    expect(pathsOf(twelve)).toEqual(TWELVE_PATHS);
    expect(twelve.coverageRoot).toBe(TWELVE_ROOT);
  });

  test("the whole read hands back the run's 12 file rows and no other run's, beside at most the count and root aggregates", async () => {
    const { handle, key, eventId } = await twelveFileRun();
    eventIdOf(await ingestRun(handle, key, AGENT, { codec: "lcov", data: lcovText([{ path: "pkg/other.ts", lf: 100, lh: 9 }]) }));

    let event: Record<string, unknown> = {};
    const records = await recordQueries(handle.store, async () => {
      event = await eventRead(handle, eventId, "?depth=coverage");
    });

    expect(pathsOf(event)).toEqual(TWELVE_PATHS);
    const use = filesTableUse(records, TWELVE_FILES);
    expect(use.fileRows).toBe(12);
    expect(use.otherRows).toBeLessThanOrEqual(2);
    expect(JSON.stringify(use.statements.map((statement) => statement.handed))).not.toContain("pkg/other.ts");
  });
});

// ── The first n ─────────────────────────────────────────────────────────────

describe("&files=<n> answers the first n files beside the whole run's count and root", () => {
  test("files=3 answers the 3 least covered files, the count 12 and the root of all 12", async () => {
    const { handle, eventId } = await twelveFileRun();

    const event = await eventRead(handle, eventId, "?depth=coverage&files=3");

    expect(event.coverageFiles).toEqual(TWELVE_FILES.slice(0, 3));
    expect(pathsOf(event)).toEqual([
      "/home/dev/app/src/lib/f07.ts",
      "/home/dev/app/src/lib/f01.ts",
      "/home/dev/app/src/lib/f09.ts",
    ]);
    expect(event.coverageFileCount).toBe(12);
    // The three answered files share `lib/`; the root is the directory all twelve share.
    expect(event.coverageRoot).toBe("/home/dev/app/src/");
    expect("tree" in event).toBe(false);
  });

  test("files=3 hands back exactly 3 file rows, beside at most the count and root aggregates", async () => {
    const { handle, eventId } = await twelveFileRun();
    expect(fileRowCount(dbOf(handle.store), eventId)).toBe(12);

    let event: Record<string, unknown> = {};
    const records = await recordQueries(handle.store, async () => {
      event = await eventRead(handle, eventId, "?depth=coverage&files=3");
    });

    expect(pathsOf(event)).toEqual(TWELVE_PATHS.slice(0, 3));
    const use = filesTableUse(records, TWELVE_FILES);
    // Exactly the three rows answered: never the run's twelve, cut down afterwards.
    expect(use.fileRows).toBe(3);
    // Beside them, at most a count and a root: each an aggregate, each one row at most.
    expect(use.otherRows).toBeLessThanOrEqual(2);
    expect(use.rowless.length).toBeLessThanOrEqual(2);
    expect(use.rowless.map((statement) => callsAnAggregate(statement.sql))).toEqual(use.rowless.map(() => true));
    expect(use.statements.length).toBeLessThanOrEqual(3);
  });

  test("files=1 answers the least covered file alone", async () => {
    const { handle, eventId } = await twelveFileRun();

    const event = await eventRead(handle, eventId, "?depth=coverage&files=1");

    expect(event.coverageFiles).toEqual([{ path: "/home/dev/app/src/lib/f07.ts", lines: { total: 100, covered: 0, percent: 0 } }]);
    expect(event.coverageFileCount).toBe(12);
  });

  test("files=7 answers the first seven, the seventh with its functions", async () => {
    const { handle, eventId } = await twelveFileRun();

    const event = await eventRead(handle, eventId, "?depth=coverage&files=7");

    expect(event.coverageFiles).toEqual(TWELVE_FILES.slice(0, 7));
    expect((event.coverageFiles as CoverageFile[])[6]).toEqual({
      path: "/home/dev/app/src/f00.ts",
      lines: { total: 100, covered: 57, percent: 57 },
      functions: { total: 4, covered: 4, percent: 100 },
    });
    expect(event.coverageFileCount).toBe(12);
  });

  const ANSWERS_EVERY_FILE: Array<{ n: string; what: string }> = [
    { n: "12", what: "the run's own count" },
    { n: "500", what: "an n above the run's count" },
    { n: "99999999999999999999", what: "an n of twenty digits" },
  ];
  for (const { n, what } of ANSWERS_EVERY_FILE) {
    test(`files=${n}, ${what}, answers all 12 files of a run of 12`, async () => {
      expect(/^\d+$/.test(n)).toBe(true);
      const { handle, eventId } = await twelveFileRun();

      const event = await eventRead(handle, eventId, `?depth=coverage&files=${n}`);

      expect(event.coverageFiles).toEqual(TWELVE_FILES);
      expect(event.coverageFileCount).toBe(12);
      expect(event.coverageRoot).toBe(TWELVE_ROOT);
    });
  }

  test("files=03, digits alone with the value 3, answers 3 files", async () => {
    const { handle, eventId } = await twelveFileRun();

    const event = await eventRead(handle, eventId, "?depth=coverage&files=03");

    expect(event.coverageFiles).toEqual(TWELVE_FILES.slice(0, 3));
    expect(event.coverageFileCount).toBe(12);
  });

  const REFUSED: Array<{ sent: string; what: string }> = [
    { sent: "0", what: "0, a value below 1" },
    { sent: "-1", what: "-1, a sign" },
    { sent: "x", what: "x, no digit" },
    { sent: "%2B3", what: "+3, a sign" },
    { sent: "+3", what: "+3 written into the address as it is" },
    { sent: "00", what: "00, digits with the value 0" },
    { sent: "3.0", what: "3.0, a fraction" },
    { sent: "1e1", what: "1e1, an exponent" },
    { sent: "3x", what: "3x, a digit and a letter" },
    { sent: "%D9%A3", what: "a digit that is not ASCII" },
  ];
  for (const { sent, what } of REFUSED) {
    test(`files=${what}, is refused with 400 and answers no event`, async () => {
      const { handle, eventId } = await twelveFileRun();
      // The same read with a number is answered.
      await eventRead(handle, eventId, "?depth=coverage&files=3");

      const answer = await getAnswer(handle, `/api/v2/events/${eventId}?depth=coverage&files=${sent}`);

      expect(answer.status, JSON.stringify(answer.body).slice(0, 200)).toBe(400);
      expect(answer.body.ok).toBe(false);
      expect(typeof answer.body.error).toBe("string");
      expect("event" in answer.body).toBe(false);
    });
  }
});

// ── An id the board does not hold ───────────────────────────────────────────

describe("?depth=coverage on an id the board does not hold", () => {
  test("answers 404, the answer the full read and the suites read give for that id", async () => {
    const { handle } = await twelveFileRun();
    const unknown = "evt-held-by-no-board";

    const coverage = await getAnswer(handle, `/api/v2/events/${unknown}?depth=coverage`);
    const firstThree = await getAnswer(handle, `/api/v2/events/${unknown}?depth=coverage&files=3`);

    expect(coverage.status).toBe(404);
    expect(coverage.body).toEqual({ ok: false, error: `event not found: ${unknown}` });
    expect(firstThree.status).toBe(404);
    expect(firstThree.body).toEqual(coverage.body);
    expect((await getAnswer(handle, `/api/v2/events/${unknown}`)).body).toEqual(coverage.body);
    expect((await getAnswer(handle, `/api/v2/events/${unknown}?depth=suites`)).body).toEqual(coverage.body);
  });
});

// ── An event without files ──────────────────────────────────────────────────

const TWO_FILE_BLOCK = {
  codec: "lcov",
  data: lcovText([
    { path: "src/alpha.ts", lf: 40, lh: 30, fnf: 3, fnh: 2 },
    { path: "src/beta.ts", lf: 40, lh: 1, fnf: 1, fnh: 0 },
  ]),
};

interface Fileless {
  what: string;
  /** Stores the event on `handle`'s board and answers its id. */
  store: (handle: ServerHandle, key: string) => Promise<string>;
}

const FILELESS: Fileless[] = [
  {
    what: "a green run sent with no coverage block",
    store: async (handle, key) => eventIdOf(await ingestRun(handle, key, AGENT)),
  },
  {
    what: "a green run whose coverage block states no file",
    store: async (handle, key) =>
      eventIdOf(await ingestRun(handle, key, AGENT, { codec: "jacoco", data: fixtureText("jacoco-csv", "header-only.csv") })),
  },
  {
    what: "a failing run sent with a coverage block of two files",
    store: async (handle, key) => eventIdOf(await ingestRun(handle, key, AGENT, TWO_FILE_BLOCK, FAILING_REPORT)),
  },
  {
    what: "a compile run",
    store: async (handle, key) =>
      eventIdOf(
        await postJson(handle, "/api/v2/runs/compile", {
          projectKey: key,
          agentId: AGENT,
          errors: "src/thing.ts(1,1): error TS1234: something is wrong",
          format: "tsc",
        }),
      ),
  },
  {
    what: "a run posted already decoded, its body naming files",
    store: async (handle, key) =>
      eventIdOf(
        await postJson(handle, "/api/v2/runs/parsed", {
          projectKey: key,
          agentId: AGENT,
          summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
          tree: [{ name: "Decoded", status: "pass", children: [{ name: "d1", status: "pass", duration_ms: 1 }] }],
          coverage: { lines: { total: 40, covered: 30, percent: 75 } },
          coverageFiles: [{ path: "src/posted.ts", lines: { total: 40, covered: 30, percent: 75 } }],
        }),
      ),
  },
];

describe("?depth=coverage on an event that has no files answers the count 0, an empty list and the empty root", () => {
  for (const { what, store } of FILELESS) {
    test(`${what}`, async () => {
      // A run of twelve files on the same board is answered with its twelve.
      const { handle, key, eventId: fileBearing } = await twelveFileRun();
      const eventId = await store(handle, key);
      expect(fileRowCount(dbOf(handle.store), eventId)).toBe(0);

      const event = await eventRead(handle, eventId, "?depth=coverage");

      expect(event.coverageFileCount).toBe(0);
      expect(event.coverageFiles).toEqual([]);
      expect(event.coverageRoot).toBe("");
      expect(event.id).toBe(eventId);
      expect("tree" in event).toBe(false);
      expect("raw" in event).toBe(false);
      expect((await eventRead(handle, fileBearing, "?depth=coverage")).coverageFileCount).toBe(12);
    });
  }

  test("files=3 on a run of no files answers the same three values", async () => {
    const { handle, key } = await twelveFileRun();
    const eventId = eventIdOf(await ingestRun(handle, key, AGENT));

    const event = await eventRead(handle, eventId, "?depth=coverage&files=3");

    expect(event.coverageFileCount).toBe(0);
    expect(event.coverageFiles).toEqual([]);
    expect(event.coverageRoot).toBe("");
  });
});
