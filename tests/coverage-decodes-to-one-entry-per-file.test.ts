// A run's coverage block decodes to the run's files beside its totals:
//
//  - `lcov`: one file per `SF:` record, named as the record writes it, with
//    that record's `LF`/`LH` and `FNF`/`FNH`; a record that states no counters
//    is a file of 0 of 0 lines;
//  - `jacoco`: one file per CSV row, named `PACKAGE.CLASS`, or `CLASS` alone
//    when `PACKAGE` is empty, with its lines and its methods as functions and
//    no branches;
//  - `go-coverprofile`: one file per distinct file of the profile's blocks,
//    lines only, a repeated block counted once in its file;
//  - a file whose functions total is 0, or unstated, has no `functions` key;
//  - a name stated more than once, in one text or in several, is ONE file
//    whose counters are added, so the files sum to the run's totals;
//  - each axis's percent is `coveragePercent` of its own counters;
//  - a profile of `mode:` alone, and a CSV of its header alone, decode to
//    coverage with no file;
//  - coverage that cannot be decoded has no files, and neither has coverage a
//    report's own decode states with no coverage block.
//
// Read through `parseRunBody` (`src/codecs/index.ts`), the door an ingest's
// body goes through, so the run's `coverage` and `coverageFiles` are read as
// an ingest gets them. The files of a decoded run are compared by name: their
// kept order is the store's, pinned where the store is.
//
// Every expected file is read from the report text by the oracle in
// `tests/helpers/coverage-files-harness.ts`, independently of the codecs, and
// the fixtures' figures are also written out here by hand.
import { describe, expect, test } from "bun:test";
import { coveragePercent } from "../src/codecs/coverage.ts";
import { codecs, parseRunBody } from "../src/codecs/index.ts";
import type { Codec, IngestWarning } from "../src/codecs/index.ts";
import type { Coverage, RunSchema } from "../src/types.ts";
import {
  byPath,
  coverageFile,
  fixtureText,
  lcovText,
  oracleFiles,
  PASSING_REPORT,
  type CoverageCodecName,
  type CoverageFile,
} from "./helpers/coverage-files-harness.ts";

/** A run as an ingest assembles it, with the files its coverage block decoded to. */
type RunWithFiles = RunSchema & { coverageFiles?: CoverageFile[] };

interface Assembled {
  run: RunWithFiles;
  warnings: IngestWarning[];
}

function junitCodec(): Codec {
  const codec = codecs.get("junit");
  expect(codec, "the codec registry must hold junit").toBeDefined();
  return codec as Codec;
}

/** The run `parseRunBody` assembles from `body` under `codec`. */
async function assemble(codec: Codec, body: Record<string, unknown>): Promise<Assembled> {
  const parsed = await parseRunBody(codec, body, "junit");
  if ("error" in parsed) throw new Error(`the body was refused: ${parsed.error}`);
  return { run: parsed.run as RunWithFiles, warnings: parsed.warnings };
}

/** A green junit report assembled with a coverage block of `texts`. */
function decoded(codec: CoverageCodecName, texts: string | string[]): Promise<Assembled> {
  return assemble(junitCodec(), { data: PASSING_REPORT, coverage: { codec, data: texts } });
}

function sum(files: readonly CoverageFile[], pick: (file: CoverageFile) => number): number {
  return files.reduce((total, file) => total + pick(file), 0);
}

/** The files' counters added up, on both axes. */
function summed(files: readonly CoverageFile[]): { lines: [number, number]; functions: [number, number] } {
  return {
    lines: [sum(files, (f) => f.lines.total), sum(files, (f) => f.lines.covered)],
    functions: [sum(files, (f) => f.functions?.total ?? 0), sum(files, (f) => f.functions?.covered ?? 0)],
  };
}

/** A run's totals as counters, an absent functions axis being 0 of 0. */
function totals(coverage: Coverage | undefined): { lines: [number, number]; functions: [number, number] } {
  expect(coverage, "the run must keep its coverage totals").toBeDefined();
  return {
    lines: [coverage?.lines.total ?? -1, coverage?.lines.covered ?? -1],
    functions: [coverage?.functions?.total ?? 0, coverage?.functions?.covered ?? 0],
  };
}

/** The decoded files, which must be there: an absent list fails here, by name. */
function filesOf(run: RunWithFiles): CoverageFile[] {
  expect(run.coverageFiles, "a run whose coverage block decoded must carry coverageFiles").toBeDefined();
  return run.coverageFiles as CoverageFile[];
}

function expectEachPercentIsItsOwn(files: readonly CoverageFile[]): void {
  for (const file of files) {
    expect(file.lines.percent, `${file.path} lines percent`).toBe(coveragePercent(file.lines.covered, file.lines.total));
    if (file.functions !== undefined) {
      expect(file.functions.percent, `${file.path} functions percent`).toBe(
        coveragePercent(file.functions.covered, file.functions.total),
      );
    }
  }
}

// ── The fixtures, with their files written out by hand ──────────────────────

interface Fixture {
  label: string;
  codec: CoverageCodecName;
  text: string;
  /** The files the report states, by hand: name, lines `[total, covered]`, functions `[total, covered]` when it has any. */
  files: Array<{ path: string; lines: [number, number]; functions?: [number, number] }>;
}

function handFiles(fixture: Fixture): CoverageFile[] {
  return fixture.files.map((file) =>
    coverageFile(
      file.path,
      { total: file.lines[0], covered: file.lines[1] },
      file.functions !== undefined ? { total: file.functions[0], covered: file.functions[1] } : undefined,
    ),
  );
}

const PYTHON_FILES: Fixture["files"] = [
  { path: "pkg/__init__.py", lines: [0, 0] },
  { path: "pkg/calc.py", lines: [12, 11], functions: [4, 3] },
  { path: "pkg/words.py", lines: [4, 4], functions: [2, 2] },
];

const LCOV_FIXTURES: Fixture[] = [
  {
    label: "arduino",
    codec: "lcov",
    text: fixtureText("reports", "arduino", "lcov.info"),
    files: [
      { path: "/project/src/debounce.cpp", lines: [13, 13], functions: [2, 2] },
      { path: "/project/src/ring.cpp", lines: [19, 18], functions: [4, 4] },
    ],
  },
  {
    label: "bun",
    codec: "lcov",
    text: fixtureText("reports", "bun", "lcov.info"),
    files: [
      { path: "src/math.ts", lines: [12, 10], functions: [4, 3] },
      { path: "src/text.ts", lines: [3, 2], functions: [2, 1] },
    ],
  },
  { label: "python/pytest", codec: "lcov", text: fixtureText("reports", "python", "pytest", "lcov.info"), files: PYTHON_FILES },
  { label: "python/xmlrunner", codec: "lcov", text: fixtureText("reports", "python", "xmlrunner", "lcov.info"), files: PYTHON_FILES },
  {
    label: "rust",
    codec: "lcov",
    text: fixtureText("reports", "rust", "lcov.info"),
    files: [{ path: "/project/src/lib.rs", lines: [29, 21], functions: [8, 6] }],
  },
];

const JACOCO_MULTI_ROW = fixtureText("jacoco-csv", "multi-row.csv");
const JACOCO_HEADER_ONLY = fixtureText("jacoco-csv", "header-only.csv");

const JACOCO_FIXTURES: Fixture[] = [
  {
    label: "mvn/app",
    codec: "jacoco",
    text: fixtureText("reports", "mvn", "app", "target", "site", "jacoco", "jacoco.csv"),
    files: [{ path: "com.acme.app.Greeter", lines: [5, 5], functions: [3, 3] }],
  },
  {
    label: "mvn/core",
    codec: "jacoco",
    text: fixtureText("reports", "mvn", "core", "target", "site", "jacoco", "jacoco.csv"),
    files: [{ path: "com.acme.core.Calc", lines: [10, 6], functions: [4, 4] }],
  },
  {
    label: "the multi-row CSV",
    codec: "jacoco",
    text: JACOCO_MULTI_ROW,
    files: [
      { path: "com.acme.shop.Basket", lines: [20, 17], functions: [8, 7] },
      { path: "com.acme.shop.Basket.Line", lines: [6, 6], functions: [3, 3] },
      { path: "com.acme.shop.Currency", lines: [2, 0] },
      { path: "Launcher", lines: [6, 2], functions: [2, 1] },
      { path: "com.acme.shop.tax.Rate", lines: [8, 0], functions: [3, 0] },
    ],
  },
];

const SHOP_PLAIN = fixtureText("go-coverprofile", "shop-plain.coverprofile");
const SHOP_COVERPKG = fixtureText("go-coverprofile", "shop-coverpkg.coverprofile");
const CONTRACTS_TYPES_ONLY = fixtureText("go-coverprofile", "contracts-types-only.coverprofile");
const LEDGER = fixtureText("go-coverprofile", "ledger.coverprofile");
const LEDGER_COUNT = fixtureText("go-coverprofile", "ledger-count.coverprofile");

const GO_FIXTURES: Fixture[] = [
  {
    label: "shop-plain",
    codec: "go-coverprofile",
    text: SHOP_PLAIN,
    files: [
      { path: "example.com/shop/stock/stock.go", lines: [5, 1] },
      { path: "example.com/shop/price/price.go", lines: [10, 3] },
      { path: "example.com/shop/report/report.go", lines: [3, 0] },
    ],
  },
  {
    label: "shop-coverpkg",
    codec: "go-coverprofile",
    text: SHOP_COVERPKG,
    files: [
      { path: "example.com/shop/price/price.go", lines: [10, 7] },
      { path: "example.com/shop/report/report.go", lines: [3, 0] },
      { path: "example.com/shop/stock/stock.go", lines: [5, 1] },
    ],
  },
  { label: "ledger", codec: "go-coverprofile", text: LEDGER, files: [{ path: "example.com/ledger/ledger.go", lines: [16, 12] }] },
  {
    label: "ledger-count",
    codec: "go-coverprofile",
    text: LEDGER_COUNT,
    files: [{ path: "example.com/ledger/ledger.go", lines: [16, 12] }],
  },
];

/** The reports that decode to coverage with no file at all. */
const NO_FILE_FIXTURES: Fixture[] = [
  { label: "the types-only Go profile", codec: "go-coverprofile", text: CONTRACTS_TYPES_ONLY, files: [] },
  { label: "the header-only JaCoCo CSV", codec: "jacoco", text: JACOCO_HEADER_ONLY, files: [] },
];

const EVERY_FIXTURE = [...LCOV_FIXTURES, ...JACOCO_FIXTURES, ...GO_FIXTURES, ...NO_FILE_FIXTURES];

// ── lcov ────────────────────────────────────────────────────────────────────

describe("an lcov report decodes to one file per SF: record", () => {
  for (const fixture of LCOV_FIXTURES) {
    test(`the ${fixture.label} report's records are its files, named as written, each with its own lines and functions`, async () => {
      const expected = handFiles(fixture);
      // The oracle reads the same figures from the text, one file per `SF:` line.
      expect(byPath(oracleFiles("lcov", [fixture.text]))).toEqual(byPath(expected));
      expect(fixture.text.split("\n").filter((line) => line.startsWith("SF:")).length).toBe(expected.length);

      const { run } = await decoded("lcov", fixture.text);

      expect(byPath(run.coverageFiles)).toEqual(byPath(expected));
    });
  }

  test("a record that states no counters is a file of 0 of 0 lines with no functions key", async () => {
    const text = fixtureText("reports", "python", "pytest", "lcov.info");
    // The record as the report writes it: its name, then its end.
    expect(text.startsWith("SF:pkg/__init__.py\nend_of_record\n")).toBe(true);

    const { run } = await decoded("lcov", text);

    const bare = filesOf(run).filter((file) => file.path === "pkg/__init__.py");
    expect(bare).toEqual([{ path: "pkg/__init__.py", lines: { total: 0, covered: 0, percent: 0 } }]);
    expect(Object.keys(bare[0] ?? {}).sort()).toEqual(["lines", "path"]);
  });

  test("an absolute name and a relative name are each kept as the report writes them", async () => {
    const text = lcovText([
      { path: "/home/dev/app/src/a.ts", lf: 4, lh: 2 },
      { path: "src/lib/b.ts", lf: 6, lh: 6 },
      { path: "./c.ts", lf: 1, lh: 0 },
    ]);

    const { run } = await decoded("lcov", text);

    expect(filesOf(run).map((file) => file.path).sort()).toEqual(["./c.ts", "/home/dev/app/src/a.ts", "src/lib/b.ts"]);
  });
});

// ── jacoco ──────────────────────────────────────────────────────────────────

describe("a JaCoCo CSV decodes to one file per row", () => {
  for (const fixture of JACOCO_FIXTURES) {
    test(`${fixture.label}: each row is a file named PACKAGE.CLASS with its lines and its methods as functions`, async () => {
      const expected = handFiles(fixture);
      expect(byPath(oracleFiles("jacoco", [fixture.text]))).toEqual(byPath(expected));
      // One file per class row: every line of the CSV but its header.
      expect(fixture.text.split("\n").filter((row) => row.length > 0).length - 1).toBe(expected.length);

      const { run } = await decoded("jacoco", fixture.text);

      expect(byPath(run.coverageFiles)).toEqual(byPath(expected));
    });
  }

  test("a row whose PACKAGE is empty is named by its CLASS alone", async () => {
    expect(JACOCO_MULTI_ROW).toContain("\nscratch-shop,,Launcher,");

    const { run } = await decoded("jacoco", JACOCO_MULTI_ROW);

    const paths = filesOf(run).map((file) => file.path);
    expect(paths).toContain("Launcher");
    // Neither a leading dot nor a stand-in package name.
    expect(paths.filter((path) => path.endsWith("Launcher"))).toEqual(["Launcher"]);
  });

  test("a nested class is named as the CSV writes it, beside its outer class", async () => {
    const { run } = await decoded("jacoco", JACOCO_MULTI_ROW);

    const basket = filesOf(run).filter((file) => file.path.startsWith("com.acme.shop.Basket"));
    expect(byPath(basket)).toEqual([
      { path: "com.acme.shop.Basket", lines: { total: 20, covered: 17, percent: 85 }, functions: { total: 8, covered: 7, percent: 87.5 } },
      { path: "com.acme.shop.Basket.Line", lines: { total: 6, covered: 6, percent: 100 }, functions: { total: 3, covered: 3, percent: 100 } },
    ]);
  });

  test("a row of 0 methods has no functions key, and a row whose methods are all missed keeps its functions at 0 covered", async () => {
    const { run } = await decoded("jacoco", JACOCO_MULTI_ROW);

    const files = filesOf(run);
    const currency = files.filter((file) => file.path === "com.acme.shop.Currency");
    expect(currency).toEqual([{ path: "com.acme.shop.Currency", lines: { total: 2, covered: 0, percent: 0 } }]);
    expect(Object.keys(currency[0] ?? {}).sort()).toEqual(["lines", "path"]);
    const rate = files.filter((file) => file.path === "com.acme.shop.tax.Rate");
    expect(rate).toEqual([
      { path: "com.acme.shop.tax.Rate", lines: { total: 8, covered: 0, percent: 0 }, functions: { total: 3, covered: 0, percent: 0 } },
    ]);
  });

  test("no file carries branches, while the run's totals keep their branches axis", async () => {
    const { run } = await decoded("jacoco", JACOCO_MULTI_ROW);

    for (const file of filesOf(run)) {
      expect(Object.keys(file).filter((key) => key !== "functions").sort(), file.path).toEqual(["lines", "path"]);
    }
    // 9 of 16 is 56.25: a tie, rounded to the even tenth.
    expect(run.coverage?.branches).toEqual({ total: 16, covered: 9, percent: 56.2 });
  });
});

// ── go-coverprofile ─────────────────────────────────────────────────────────

describe("a Go coverprofile decodes to one file per distinct block file", () => {
  for (const fixture of GO_FIXTURES) {
    test(`${fixture.label}: each file of the profile's blocks is a file with lines only`, async () => {
      const expected = handFiles(fixture);
      expect(byPath(oracleFiles("go-coverprofile", [fixture.text]))).toEqual(byPath(expected));

      const { run } = await decoded("go-coverprofile", fixture.text);

      expect(byPath(run.coverageFiles)).toEqual(byPath(expected));
      for (const file of filesOf(run)) expect(Object.keys(file).sort(), file.path).toEqual(["lines", "path"]);
    });
  }

  test("on the -coverpkg capture a block listed once per test package counts once in its file, covered when any copy ran", async () => {
    const listed = (file: string): number => SHOP_COVERPKG.split("\n").filter((row) => row.startsWith(`${file}:`)).length;
    // price.go's 8 blocks are listed twice and report.go's 3 blocks three times.
    expect(listed("example.com/shop/price/price.go")).toBe(16);
    expect(listed("example.com/shop/report/report.go")).toBe(9);

    const { run } = await decoded("go-coverprofile", SHOP_COVERPKG);

    const files = filesOf(run);
    const price = files.filter((file) => file.path === "example.com/shop/price/price.go");
    // 10 statements, not the 20 its listed copies hold; 7 covered: 3 in one copy, 4 more in the other.
    expect(price).toEqual([{ path: "example.com/shop/price/price.go", lines: { total: 10, covered: 7, percent: 70 } }]);
    const report = files.filter((file) => file.path === "example.com/shop/report/report.go");
    expect(report).toEqual([{ path: "example.com/shop/report/report.go", lines: { total: 3, covered: 0, percent: 0 } }]);
  });

  test("the file's name is the block's text before its line and column span", async () => {
    const { run } = await decoded("go-coverprofile", LEDGER);

    const paths = filesOf(run).map((file) => file.path);
    expect(paths).toEqual(["example.com/ledger/ledger.go"]);
    expect(paths.some((path) => /:\d/.test(path))).toBe(false);
  });
});

// ── Reports with no file ────────────────────────────────────────────────────

describe("a report can decode to coverage with no file", () => {
  test("a Go profile of its mode: line alone decodes to 0 of 0 lines and an empty file list", async () => {
    expect(CONTRACTS_TYPES_ONLY).toBe("mode: set\n");

    const { run, warnings } = await decoded("go-coverprofile", CONTRACTS_TYPES_ONLY);

    expect(run.coverage).toEqual({ lines: { total: 0, covered: 0, percent: 0 } });
    expect(run.coverageFiles).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a JaCoCo CSV of its header alone decodes to its zero totals and an empty file list", async () => {
    expect(JACOCO_HEADER_ONLY.split("\n").filter((row) => row.length > 0).length).toBe(1);

    const { run, warnings } = await decoded("jacoco", JACOCO_HEADER_ONLY);

    const zero = { total: 0, covered: 0, percent: 0 };
    expect(run.coverage).toEqual({ lines: zero, functions: zero, branches: zero });
    expect(run.coverageFiles).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a types-only module's profile beside another module's adds no file to that module's", async () => {
    const { run } = await decoded("go-coverprofile", [CONTRACTS_TYPES_ONLY, LEDGER]);

    expect(run.coverageFiles).toEqual([{ path: "example.com/ledger/ledger.go", lines: { total: 16, covered: 12, percent: 75 } }]);
  });
});

// ── No functions axis ───────────────────────────────────────────────────────

describe("a file whose functions total is 0 has no functions axis, on every codec", () => {
  const JACOCO_HEADER = JACOCO_HEADER_ONLY.trim();
  const cases: Array<{ codec: CoverageCodecName; what: string; text: string; path: string; lines: [number, number] }> = [
    {
      codec: "lcov",
      what: "an lcov record that states FNF:0",
      text: lcovText([{ path: "src/constants.ts", lf: 5, lh: 5, fnf: 0, fnh: 0 }]),
      path: "src/constants.ts",
      lines: [5, 5],
    },
    {
      codec: "lcov",
      what: "an lcov record that states no function counter",
      text: lcovText([{ path: "src/table.ts", lf: 8, lh: 3 }]),
      path: "src/table.ts",
      lines: [8, 3],
    },
    {
      codec: "jacoco",
      what: "a JaCoCo row of 0 methods",
      text: `${JACOCO_HEADER}\nscratch,com.acme,Flags,0,9,0,0,1,3,0,0,0,0\n`,
      path: "com.acme.Flags",
      lines: [4, 3],
    },
    {
      codec: "go-coverprofile",
      what: "a Go profile's file",
      text: "mode: set\nexample.com/m/a.go:3.2,4.10 2 1\nexample.com/m/a.go:6.2,6.9 1 0\n",
      path: "example.com/m/a.go",
      lines: [3, 2],
    },
  ];

  for (const { codec, what, text, path, lines } of cases) {
    test(`${what} is a file with its lines and no functions key`, async () => {
      const { run } = await decoded(codec, text);

      const expected = coverageFile(path, { total: lines[0], covered: lines[1] });
      expect(run.coverageFiles).toEqual([expected]);
      expect(Object.keys(filesOf(run)[0] ?? {}).sort()).toEqual(["lines", "path"]);
    });
  }
});

// ── The files sum to the totals ─────────────────────────────────────────────

describe("the files' counters sum to the run's totals", () => {
  for (const fixture of EVERY_FIXTURE) {
    test(`${fixture.codec} ${fixture.label}: lines and functions, total and covered, add up to the run's, and each percent is the file's own`, async () => {
      const { run } = await decoded(fixture.codec, fixture.text);

      const files = filesOf(run);
      expect(files.length).toBe(fixture.files.length);
      expect(summed(files)).toEqual(totals(run.coverage));
      // The totals themselves are the hand-written files' sums, not merely the codec agreeing with itself.
      expect(totals(run.coverage)).toEqual(summed(handFiles(fixture)));
      expectEachPercentIsItsOwn(files);
    });
  }

  test("two lcov texts naming one file in both are one run: that name is ONE file with its counters added", async () => {
    const first = lcovText([
      { path: "src/shared.ts", lf: 10, lh: 4, fnf: 2, fnh: 1 },
      { path: "src/only-first.ts", lf: 3, lh: 3, fnf: 1, fnh: 1 },
    ]);
    const second = lcovText([
      { path: "src/only-second.ts", lf: 7, lh: 0 },
      { path: "src/shared.ts", lf: 6, lh: 6 },
    ]);

    const { run } = await decoded("lcov", [first, second]);

    const files = filesOf(run);
    expect(files.filter((file) => file.path === "src/shared.ts")).toEqual([
      { path: "src/shared.ts", lines: { total: 16, covered: 10, percent: 62.5 }, functions: { total: 2, covered: 1, percent: 50 } },
    ]);
    expect(byPath(files)).toEqual(byPath(oracleFiles("lcov", [first, second])));
    expect(files.length).toBe(3);
    expect(run.coverage).toEqual({
      lines: { total: 26, covered: 13, percent: 50 },
      functions: { total: 3, covered: 2, percent: 66.7 },
    });
    expect(summed(files)).toEqual(totals(run.coverage));
    expectEachPercentIsItsOwn(files);
  });

  test("a name stated twice in ONE lcov text is one file with its counters added", async () => {
    const text = lcovText([
      { path: "src/twice.ts", lf: 9, lh: 2, fnf: 3, fnh: 0 },
      { path: "src/once.ts", lf: 1, lh: 1 },
      { path: "src/twice.ts", lf: 11, lh: 8, fnf: 1, fnh: 1 },
    ]);

    const { run } = await decoded("lcov", text);

    const files = filesOf(run);
    expect(byPath(files)).toEqual([
      { path: "src/once.ts", lines: { total: 1, covered: 1, percent: 100 } },
      { path: "src/twice.ts", lines: { total: 20, covered: 10, percent: 50 }, functions: { total: 4, covered: 1, percent: 25 } },
    ]);
    expect(summed(files)).toEqual(totals(run.coverage));
  });

  test("two JaCoCo CSVs naming one class in both are one run: that class is ONE file with its counters added", async () => {
    const app = fixtureText("reports", "mvn", "app", "target", "site", "jacoco", "jacoco.csv");
    const again = `${JACOCO_HEADER_ONLY.trim()}\nscratch-app-it,com.acme.app,Greeter,2,6,0,0,1,2,0,0,1,0\n`;

    const { run } = await decoded("jacoco", [app, JACOCO_MULTI_ROW, again]);

    const files = filesOf(run);
    expect(files.filter((file) => file.path === "com.acme.app.Greeter")).toEqual([
      { path: "com.acme.app.Greeter", lines: { total: 8, covered: 7, percent: 87.5 }, functions: { total: 4, covered: 3, percent: 75 } },
    ]);
    expect(files.length).toBe(6);
    expect(byPath(files)).toEqual(byPath(oracleFiles("jacoco", [app, JACOCO_MULTI_ROW, again])));
    expect(summed(files)).toEqual(totals(run.coverage));
    expect(totals(run.coverage)).toEqual({ lines: [50, 32], functions: [20, 14] });
    expectEachPercentIsItsOwn(files);
  });

  test("two Go profiles of one module are one run: each file is ONE file, each profile's own count of it added", async () => {
    const { run } = await decoded("go-coverprofile", [SHOP_PLAIN, SHOP_COVERPKG]);

    const files = filesOf(run);
    expect(byPath(files)).toEqual([
      { path: "example.com/shop/price/price.go", lines: { total: 20, covered: 10, percent: 50 } },
      { path: "example.com/shop/report/report.go", lines: { total: 6, covered: 0, percent: 0 } },
      { path: "example.com/shop/stock/stock.go", lines: { total: 10, covered: 2, percent: 20 } },
    ]);
    expect(run.coverage).toEqual({ lines: { total: 36, covered: 12, percent: 33.3 } });
    expect(summed(files)).toEqual(totals(run.coverage));
    expectEachPercentIsItsOwn(files);
  });
});

// ── The assembled run ───────────────────────────────────────────────────────

describe("a run carries files only for coverage decoded from its coverage block", () => {
  const BUN_LCOV = fixtureText("reports", "bun", "lcov.info");

  test("a decoded coverage block sets the run's coverage and its files together", async () => {
    const { run, warnings } = await decoded("lcov", BUN_LCOV);

    expect(run.coverage).toEqual({
      lines: { total: 15, covered: 12, percent: 80 },
      functions: { total: 6, covered: 4, percent: 66.7 },
    });
    expect(byPath(run.coverageFiles)).toEqual([
      { path: "src/math.ts", lines: { total: 12, covered: 10, percent: 83.3 }, functions: { total: 4, covered: 3, percent: 75 } },
      { path: "src/text.ts", lines: { total: 3, covered: 2, percent: 66.7 }, functions: { total: 2, covered: 1, percent: 50 } },
    ]);
    // The totals object is the one it is today: the files are beside it, never inside it.
    expect(Object.keys(run.coverage ?? {}).sort()).toEqual(["functions", "lines"]);
    expect(warnings).toEqual([]);
  });

  test("coverage dropped as undecodable leaves the run with neither coverage nor files, where the good text alone has both", async () => {
    const undecodable = "TN:\nLF:10\nLH:5\nend_of_record\n";

    const dropped = await decoded("lcov", [BUN_LCOV, undecodable]);

    expect(dropped.run.coverage).toBeUndefined();
    expect(dropped.run.coverageFiles).toBeUndefined();
    expect(dropped.warnings.map((warning) => warning.code)).toEqual(["coverage-dropped"]);

    // The same good text without the undecodable one keeps both.
    const kept = await decoded("lcov", [BUN_LCOV]);
    expect(kept.run.coverage).toBeDefined();
    expect(filesOf(kept.run).length).toBe(2);
  });

  test("coverage a report's own decode states, with no coverage block, has no files, where a block on the same report has them", async () => {
    const stated: Coverage = { lines: { total: 50, covered: 40, percent: 80 } };
    const statesCoverage: Codec = {
      parse: () => ({
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: [{ name: "s", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 1 }] }],
        coverage: stated,
      }),
    };

    const own = await assemble(statesCoverage, { data: "anything" });

    expect(own.run.coverage).toEqual(stated);
    expect(own.run.coverageFiles).toBeUndefined();

    // A coverage block on the same report is decoded in its place, and brings its files.
    const withBlock = await assemble(statesCoverage, { data: "anything", coverage: { codec: "lcov", data: BUN_LCOV } });
    expect(withBlock.run.coverage?.lines).toEqual({ total: 15, covered: 12, percent: 80 });
    expect(filesOf(withBlock.run).map((file) => file.path).sort()).toEqual(["src/math.ts", "src/text.ts"]);
  });
});
