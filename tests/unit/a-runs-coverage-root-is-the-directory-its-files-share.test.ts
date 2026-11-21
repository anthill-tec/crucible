// `GET /api/v2/events/<id>?depth=coverage` answers `event.coverageRoot`: the
// leading directories every file name of the run shares.
//
//  - it is the longest prefix common to all the run's names, cut back so that
//    it ends at a `/`;
//  - it is the empty string when the names share no directory, as Maven's
//    class names do, and when a name has no `/` at all;
//  - a run of one file answers that file's directory;
//  - it is the whole run's root however few files the read answers, and it is
//    read by aggregate: no statement hands back every file row to work it out.
//
// Driven through the real production router (`bootInProcess`, in-memory
// store), each run ingested with a coverage block of the names under test.
import { afterEach, describe, expect, test } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, readyProject } from "../helpers/run-stream-harness.ts";
import {
  byCodeUnit,
  dbOf,
  eventIdOf,
  eventRead,
  fileRowCount,
  filesTableUse,
  ingestRun,
  lcovText,
  recordQueries,
  storedFiles,
  TWELVE_BLOCK,
  TWELVE_FILES,
  type CoverageFile,
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

const AGENT = "root-reader";

const TWELVE_PATHS = TWELVE_FILES.map((file) => file.path);

/** An lcov block of the given names, each file 10 lines with a different number covered. */
function lcovBlockOf(names: readonly string[]): { codec: string; data: string } {
  return { codec: "lcov", data: lcovText(names.map((path, index) => ({ path, lf: 10, lh: index + 1 }))) };
}

const JACOCO_HEADER =
  "GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED,BRANCH_MISSED,BRANCH_COVERED,LINE_MISSED,LINE_COVERED,COMPLEXITY_MISSED,COMPLEXITY_COVERED,METHOD_MISSED,METHOD_COVERED";

/** A JaCoCo CSV block of two classes, `com.acme.shop.Basket` and `com.acme.shop.tax.Rate`. */
const MAVEN_BLOCK = {
  codec: "jacoco",
  data: [JACOCO_HEADER, "shop,com.acme.shop,Basket,12,48,2,6,3,17,3,9,1,7", "shop,com.acme.shop.tax,Rate,30,0,4,0,8,0,5,0,3,0", ""].join("\n"),
};

/**
 * The run's `?depth=coverage` event, after an ingest of `block` that stores
 * exactly `names` as the run's files.
 */
async function readAfterIngest(block: unknown, names: readonly string[], query = "?depth=coverage"): Promise<Record<string, unknown>> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT]);
  const eventId = eventIdOf(await ingestRun(handle, key, AGENT, block));
  const stored = (await storedFiles(dbOf(handle.store), eventId)).map((file) => file.path).sort(byCodeUnit);
  expect(stored, "the run stores the names under test, each whole").toEqual([...names].sort(byCodeUnit));
  return eventRead(handle, eventId, query);
}

/** The names a read answered, sorted by code unit. */
function namesOf(event: Record<string, unknown>): string[] | undefined {
  const files = event.coverageFiles;
  return Array.isArray(files) ? (files as CoverageFile[]).map((file) => file.path).sort(byCodeUnit) : undefined;
}

interface RootCase {
  what: string;
  names: string[];
  root: string;
}

const SHARED_DIRECTORY: RootCase[] = [
  {
    what: "two absolute names, one a directory deeper, answer the directory both are under",
    names: ["/home/dev/app/src/a.ts", "/home/dev/app/src/lib/b.ts"],
    root: "/home/dev/app/src/",
  },
  {
    what: "two names in one directory answer that directory",
    names: ["src/lib/a.ts", "src/lib/b.ts"],
    root: "src/lib/",
  },
  {
    what: "names that go on alike past their directory are cut back to the directory",
    names: ["src/app.ts", "src/app.test.ts"],
    root: "src/",
  },
  {
    what: "three names, the first two sharing more than the third, answer what all three share",
    names: ["/r/a/x.ts", "/r/a/y.ts", "/r/b/z.ts"],
    root: "/r/",
  },
  {
    what: "names that share only the leading slash answer the slash",
    names: ["/a.ts", "/b.ts"],
    root: "/",
  },
];

const NO_SHARED_DIRECTORY: RootCase[] = [
  {
    what: "directories that begin alike and are not the same directory share none",
    names: ["src/a.ts", "srcgen/b.ts"],
    root: "",
  },
  {
    what: "names under different top directories share none",
    names: ["lib/a.ts", "src/b.ts"],
    root: "",
  },
  {
    what: "directories that differ only by case share none: aB/ sorts before ab/ in code-unit order",
    names: ["ab/one.ts", "aB/two.ts", "ab/three.ts"],
    root: "",
  },
  {
    what: "a name with no slash beside a name in a directory shares none",
    names: ["main.ts", "src/b.ts"],
    root: "",
  },
];

const ONE_FILE: RootCase[] = [
  { what: "an absolute name answers its directory", names: ["/home/dev/app/src/a.ts"], root: "/home/dev/app/src/" },
  { what: "a relative name answers its directory", names: ["src/lib/only.ts"], root: "src/lib/" },
  { what: "a name with no slash answers the empty string", names: ["main.ts"], root: "" },
];

function rootCases(cases: readonly RootCase[]): void {
  for (const { what, names, root } of cases) {
    test(`${what}: ${JSON.stringify(root)}`, async () => {
      const event = await readAfterIngest(lcovBlockOf(names), names);

      expect(event.coverageRoot).toBe(root);
      // The run holds exactly the names under test, each whole.
      expect(namesOf(event)).toEqual([...names].sort(byCodeUnit));
      expect(event.coverageFileCount).toBe(names.length);
    });
  }
}

describe("a run's coverage root is the directory every one of its file names is under", () => {
  rootCases(SHARED_DIRECTORY);
});

describe("a run whose file names share no directory answers the empty root", () => {
  rootCases(NO_SHARED_DIRECTORY);

  test("two Maven class names share a package prefix and no directory: \"\"", async () => {
    const event = await readAfterIngest(MAVEN_BLOCK, ["com.acme.shop.Basket", "com.acme.shop.tax.Rate"]);

    expect(event.coverageRoot).toBe("");
    expect(namesOf(event)).toEqual(["com.acme.shop.Basket", "com.acme.shop.tax.Rate"]);
    expect(event.coverageFileCount).toBe(2);
  });
});

describe("a run of one file answers that file's directory as its root", () => {
  rootCases(ONE_FILE);
});

describe("the root is the whole run's, read by aggregate", () => {
  test("files=1 answers one file and the root of all 12: the answered file's own directory is deeper", async () => {
    const event = await readAfterIngest(TWELVE_BLOCK, TWELVE_PATHS, "?depth=coverage&files=1");

    expect(namesOf(event)).toEqual(["/home/dev/app/src/lib/f07.ts"]);
    expect(event.coverageRoot).toBe("/home/dev/app/src/");
    expect(event.coverageFileCount).toBe(12);
  });

  test("files=6 answers six files that all sit in lib/, and still the root of all 12", async () => {
    const event = await readAfterIngest(TWELVE_BLOCK, TWELVE_PATHS, "?depth=coverage&files=6");

    expect(namesOf(event)?.every((name) => name.startsWith("/home/dev/app/src/lib/"))).toBe(true);
    expect(namesOf(event)?.length).toBe(6);
    expect(event.coverageRoot).toBe("/home/dev/app/src/");
  });

  test("a files=1 read hands back one file row: the root is worked out without the run's other eleven", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const eventId = eventIdOf(await ingestRun(handle, key, AGENT, TWELVE_BLOCK));
    expect(fileRowCount(dbOf(handle.store), eventId)).toBe(12);

    let event: Record<string, unknown> = {};
    const records = await recordQueries(handle.store, async () => {
      event = await eventRead(handle, eventId, "?depth=coverage&files=1");
    });

    expect(event.coverageRoot).toBe("/home/dev/app/src/");
    const use = filesTableUse(records, TWELVE_FILES);
    expect(use.fileRows).toBe(1);
    // Beside that row: the count and the root, each one aggregate row at most.
    expect(use.otherRows).toBeLessThanOrEqual(2);
  });

  test("the root is the run's own: another run's names on the same board do not shorten it", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const first = eventIdOf(await ingestRun(handle, key, AGENT, lcovBlockOf(["/srv/one/a.ts", "/srv/one/b.ts"])));
    const second = eventIdOf(await ingestRun(handle, key, AGENT, lcovBlockOf(["lib/c.ts", "lib/sub/d.ts"])));

    expect((await eventRead(handle, first, "?depth=coverage")).coverageRoot).toBe("/srv/one/");
    expect((await eventRead(handle, second, "?depth=coverage")).coverageRoot).toBe("lib/");
  });
});
