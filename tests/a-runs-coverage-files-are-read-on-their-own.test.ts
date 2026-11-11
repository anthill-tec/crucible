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
import {
  bootOn,
  eventLine,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  STREAM_CODEC,
} from "./helpers/run-stream-harness.ts";
import {
  callsAnAggregate,
  closeStreamedRun,
  dbOf,
  eventIdOf,
  eventRead,
  FAILING_REPORT,
  FILE_READ_KEYS,
  fileReadKeysOf,
  fileRowCount,
  filesTableUse,
  fixtureText,
  getAnswer,
  handedText,
  inKeptOrder,
  ingestRun,
  lcovText,
  oracleFiles,
  PASSING_REPORT,
  recordQueries,
  rowsHandedFrom,
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

const RAW_OUTPUT = "$ runner\nraw-output-marker-41d9\n2 pass";

/** A board holding one green run of the twelve files that also has raw output. */
async function twelveFileRunWithRawOutput(): Promise<{ handle: ServerHandle; key: string; eventId: string; rawOutput: string }> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT]);
  const eventId = eventIdOf(
    await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: AGENT,
      codec: "junit",
      data: PASSING_REPORT,
      raw: RAW_OUTPUT,
      coverage: TWELVE_BLOCK,
    }),
  );
  return { handle, key, eventId, rawOutput: RAW_OUTPUT };
}

function keysOf(event: Record<string, unknown>): string[] {
  return Object.keys(event).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What the read answers for an event of any kind: every key the full read
 * answers but the tree and the raw output, each with the full read's value,
 * beside exactly the three file keys.
 */
function expectTheFullReadsKeysBesideTheFileKeys(event: Record<string, unknown>, full: Record<string, unknown>): void {
  const rest = without(full, ["tree", "raw"]);
  expect(without(event, FILE_READ_KEYS)).toEqual(rest);
  expect(keysOf(event)).toEqual(keysOf({ ...rest, coverageFileCount: 0, coverageFiles: [], coverageRoot: "" }));
}

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
    const { handle, eventId, rawOutput } = await twelveFileRunWithRawOutput();
    const full = await eventRead(handle, eventId);
    expect(full.coverage).toEqual(TWELVE_TOTALS);
    expect(full.raw).toBe(rawOutput);
    expect(Array.isArray(full.tree)).toBe(true);

    const event = await eventRead(handle, eventId, "?depth=coverage");

    expect(fileReadKeysOf(event)).toEqual(["coverageFileCount", "coverageFiles", "coverageRoot"]);
    // Exactly the three file keys are new: every other key is the full read's, with the full read's value.
    expectTheFullReadsKeysBesideTheFileKeys(event, full);
    // The run has raw output, and the read carries neither it nor its byte length.
    expect("rawBytes" in event).toBe(false);
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
  test("files= with an empty value is refused with 400 and answers no event", async () => {
    const { handle, eventId } = await twelveFileRun();
    await eventRead(handle, eventId, "?depth=coverage&files=3");

    const answer = await getAnswer(handle, `/api/v2/events/${eventId}?depth=coverage&files=`);

    expect(answer.status, JSON.stringify(answer.body).slice(0, 200)).toBe(400);
    expect(answer.body.ok).toBe(false);
    expect(typeof answer.body.error).toBe("string");
    expect("event" in answer.body).toBe(false);
  });

  test("files=3 before files=x answers 3 files: of a parameter given twice, the first value counts", async () => {
    const { handle, eventId } = await twelveFileRun();

    const event = await eventRead(handle, eventId, "?depth=coverage&files=3&files=x");

    expect(event.coverageFiles).toEqual(TWELVE_FILES.slice(0, 3));
    expect(event.coverageFileCount).toBe(12);
    expect(event.coverageRoot).toBe(TWELVE_ROOT);
  });

  test("files=3 before files=5 answers 3 files, not 5", async () => {
    const { handle, eventId } = await twelveFileRun();

    const event = await eventRead(handle, eventId, "?depth=coverage&files=3&files=5");

    expect(event.coverageFiles).toEqual(TWELVE_FILES.slice(0, 3));
  });

  test("files=x before files=3 is refused with 400: the first value counts", async () => {
    const { handle, eventId } = await twelveFileRun();
    await eventRead(handle, eventId, "?depth=coverage&files=3");

    const answer = await getAnswer(handle, `/api/v2/events/${eventId}?depth=coverage&files=x&files=3`);

    expect(answer.status, JSON.stringify(answer.body).slice(0, 200)).toBe(400);
    expect(answer.body.ok).toBe(false);
    expect("event" in answer.body).toBe(false);
  });
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

  const REFUSED_BEFORE_THE_ID: Array<{ query: string; what: string }> = [
    { query: "files=x", what: "files=x" },
    { query: "files=0", what: "files=0" },
    { query: "files=", what: "files= with an empty value" },
    { query: "files=x&files=3", what: "files=x before files=3" },
  ];
  for (const { query, what } of REFUSED_BEFORE_THE_ID) {
    test(`${what} on an id the board does not hold answers 400, not 404`, async () => {
      const { handle } = await twelveFileRun();
      const unknown = "evt-held-by-no-board";
      // The id is unknown: the same read with a number answers 404.
      expect((await getAnswer(handle, `/api/v2/events/${unknown}?depth=coverage&files=3`)).status).toBe(404);

      const answer = await getAnswer(handle, `/api/v2/events/${unknown}?depth=coverage&${query}`);

      expect(answer.status, JSON.stringify(answer.body).slice(0, 200)).toBe(400);
      expect(answer.body.ok).toBe(false);
      expect(answer.body.error).not.toBe(`event not found: ${unknown}`);
      expect("event" in answer.body).toBe(false);
    });
  }
});

// ── The parameter is checked before the store is read ───────────────────────

describe("a refused files= is refused before the store is read", () => {
  /** Answering a request runs no statement by itself: a read refused for a missing parameter runs none. */
  async function expectARequestAloneRunsNoStatement(handle: ServerHandle): Promise<void> {
    let status = 0;
    const records = await recordQueries(handle.store, async () => {
      status = (await getAnswer(handle, "/api/v2/status")).status;
    });
    expect(status).toBe(400);
    expect(records.map((record) => record.sql)).toEqual([]);
  }

  test("on a run the board holds, the refused read runs no statement, where the answered read runs some", async () => {
    const { handle, eventId } = await twelveFileRun();
    await expectARequestAloneRunsNoStatement(handle);
    const answered = await recordQueries(handle.store, () => getAnswer(handle, `/api/v2/events/${eventId}?depth=coverage&files=3`));
    expect(answered.length).toBeGreaterThan(0);

    let status = 0;
    const refused = await recordQueries(handle.store, async () => {
      status = (await getAnswer(handle, `/api/v2/events/${eventId}?depth=coverage&files=x`)).status;
    });

    expect(status).toBe(400);
    expect(refused.map((record) => record.sql)).toEqual([]);
  });

  test("on an id the board does not hold, the refused read runs no statement, where the 404 read runs some", async () => {
    const { handle } = await twelveFileRun();
    const unknown = "evt-held-by-no-board";
    await expectARequestAloneRunsNoStatement(handle);
    const notFound = await recordQueries(handle.store, () => getAnswer(handle, `/api/v2/events/${unknown}?depth=coverage&files=3`));
    expect(notFound.length).toBeGreaterThan(0);

    let status = 0;
    const refused = await recordQueries(handle.store, async () => {
      status = (await getAnswer(handle, `/api/v2/events/${unknown}?depth=coverage&files=x`)).status;
    });

    expect(status).toBe(400);
    expect(refused.map((record) => record.sql)).toEqual([]);
  });
});

// ── What the read touches ───────────────────────────────────────────────────

const STEPPED_STREAM =
  eventLine({ event: "run-start", total: 2 }) +
  eventLine({
    event: "test-end",
    id: "card",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 30,
    steps: [
      { name: "Given a cart holding one book", status: "pass", duration_ms: 10 },
      { name: "When I pay by card", status: "pass", duration_ms: 20 },
    ],
  }) +
  eventLine({
    event: "test-end",
    id: "voucher",
    name: "Pay by voucher",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 10,
    steps: [{ name: "Given a voucher worth ten", status: "pass", duration_ms: 10 }],
  }) +
  eventLine({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 40 });

/** A board holding a green streamed run of the twelve files that has a tree, steps under its tests, and raw output. */
async function twelveFileRunWithStepsAndRawOutput(): Promise<{ handle: ServerHandle; eventId: string }> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT]);
  const runId = await openRun(handle, key, AGENT, { stack: "bun", framework: "playwright-bdd" });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: STEPPED_STREAM });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const eventId = eventIdOf(
    await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: AGENT,
      runId,
      codec: STREAM_CODEC,
      raw: RAW_OUTPUT,
      coverage: TWELVE_BLOCK,
    }),
  );
  return { handle, eventId };
}

describe("?depth=coverage reads none of the run's tree and none of its raw output", () => {
  test("it hands back no suite row, no test row, no step row and no raw text, where the full read hands back each", async () => {
    const { handle, eventId } = await twelveFileRunWithStepsAndRawOutput();
    // The run has all four, and the log sees the full read hand each back.
    const whole = await recordQueries(handle.store, () => eventRead(handle, eventId));
    expect(rowsHandedFrom(whole, "run_suites")).toBe(1);
    expect(rowsHandedFrom(whole, "run_cases")).toBe(2);
    expect(rowsHandedFrom(whole, "run_case_steps")).toBe(3);
    expect(handedText(whole)).toContain("raw-output-marker-41d9");

    let event: Record<string, unknown> = {};
    const records = await recordQueries(handle.store, async () => {
      event = await eventRead(handle, eventId, "?depth=coverage");
    });

    expect(rowsHandedFrom(records, "run_suites")).toBe(0);
    expect(rowsHandedFrom(records, "run_cases")).toBe(0);
    expect(rowsHandedFrom(records, "run_case_steps")).toBe(0);
    expect(handedText(records)).not.toContain("raw-output-marker-41d9");
    // It is still the read of the run's files.
    expect(event.coverageFileCount).toBe(12);
    expect(pathsOf(event)).toEqual(TWELVE_PATHS);
  });

  test("with files=3 it hands back none of them either", async () => {
    const { handle, eventId } = await twelveFileRunWithStepsAndRawOutput();

    let event: Record<string, unknown> = {};
    const records = await recordQueries(handle.store, async () => {
      event = await eventRead(handle, eventId, "?depth=coverage&files=3");
    });

    expect(rowsHandedFrom(records, "run_suites")).toBe(0);
    expect(rowsHandedFrom(records, "run_cases")).toBe(0);
    expect(rowsHandedFrom(records, "run_case_steps")).toBe(0);
    expect(handedText(records)).not.toContain("raw-output-marker-41d9");
    expect(pathsOf(event)).toEqual(TWELVE_PATHS.slice(0, 3));
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

// ── An event of any kind ────────────────────────────────────────────────────

/** The id of the event a route that answers 201 stored. */
function createdIdOf(answer: { status: number; body: Record<string, unknown> }): string {
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(201);
  expect(typeof answer.body.event, "the route answers the event it stored").toBe("string");
  return answer.body.event as string;
}

function postGate(handle: ServerHandle, key: string, gateRunId?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson(handle, "/api/v2/gates", {
    projectKey: key,
    agentId: AGENT,
    gate: {
      intent: "a gate beside the runs",
      outcome: "passed",
      steps: [{ name: "review", status: "passed" }],
      ...(gateRunId !== undefined ? { run: { id: gateRunId } } : {}),
    },
  });
}

interface OtherKind {
  what: string;
  /** Stores the event on `handle`'s board and answers its id. */
  store: (handle: ServerHandle, key: string) => Promise<string>;
  /** What the full read of the event must show, so the event is the kind it is named. */
  isTheKind: (full: Record<string, unknown>) => void;
}

const OTHER_KINDS: OtherKind[] = [
  {
    what: "a gate event",
    store: async (handle, key) => createdIdOf(await postGate(handle, key)),
    isTheKind: (full) => {
      expect(full.kind).toBe("gate");
      expect("decisions" in full).toBe(false);
    },
  },
  {
    what: "a gate event whose run has a recorded decision, its decisions included",
    store: async (handle, key) => {
      const gate = createdIdOf(await postGate(handle, key, "gate-run-with-a-decision"));
      const decision = await postJson(handle, "/api/v2/gate-decisions", {
        projectKey: key,
        agentId: AGENT,
        decision: { runId: "gate-run-with-a-decision", action: "approve", step: "review" },
      });
      expect(decision.status, JSON.stringify(decision.body).slice(0, 300)).toBe(201);
      return gate;
    },
    isTheKind: (full) => {
      expect(full.kind).toBe("gate");
      expect((full.decisions as Array<{ runId: string; action: string }>).map((decision) => [decision.runId, decision.action])).toEqual([
        ["gate-run-with-a-decision", "approve"],
      ]);
    },
  },
  {
    what: "a milestone event",
    store: async (handle, key) =>
      createdIdOf(
        await postJson(handle, "/api/v2/milestones", {
          projectKey: key,
          agentId: AGENT,
          type: "gap-analysis",
          label: "a milestone beside the runs",
        }),
      ),
    isTheKind: (full) => {
      expect(full.kind).toBe("milestone");
    },
  },
  {
    what: "a compile run, its report included",
    store: async (handle, key) =>
      eventIdOf(
        await postJson(handle, "/api/v2/runs/compile", {
          projectKey: key,
          agentId: AGENT,
          errors: "src/thing.ts(1,1): error TS1234: something is wrong",
          format: "tsc",
        }),
      ),
    isTheKind: (full) => {
      expect(full.kind).toBe("compile");
      expect((full.compile as { errorCount: number }).errorCount).toBe(1);
    },
  },
  {
    what: "a failing run that has a tree and raw output",
    store: async (handle, key) =>
      eventIdOf(
        await postJson(handle, "/api/v2/runs", {
          projectKey: key,
          agentId: AGENT,
          codec: "junit",
          data: FAILING_REPORT,
          raw: RAW_OUTPUT,
          coverage: TWO_FILE_BLOCK,
        }),
      ),
    isTheKind: (full) => {
      expect(full.kind).toBe("test");
      expect((full.summary as { failed: number }).failed).toBe(1);
      expect(full.raw).toBe(RAW_OUTPUT);
      expect(Array.isArray(full.tree)).toBe(true);
    },
  },
];

describe("?depth=coverage on an event of any kind answers the full read's keys but the tree and the raw output, beside a count of 0, an empty list and the empty root", () => {
  for (const { what, store, isTheKind } of OTHER_KINDS) {
    test(`${what}`, async () => {
      const { handle, key } = await twelveFileRun();
      const eventId = await store(handle, key);
      const full = await eventRead(handle, eventId);
      isTheKind(full);

      const event = await eventRead(handle, eventId, "?depth=coverage");

      expect(event.coverageFileCount).toBe(0);
      expect(event.coverageFiles).toEqual([]);
      expect(event.coverageRoot).toBe("");
      expectTheFullReadsKeysBesideTheFileKeys(event, full);
      expect("rawBytes" in event).toBe(false);
    });
  }
});
