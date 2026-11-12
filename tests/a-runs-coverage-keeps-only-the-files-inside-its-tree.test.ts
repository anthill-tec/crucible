// A run's coverage keeps only the files inside the run's tree:
//
//  - a file name is judged as text: split on `/` and `\`, empty and `.`
//    segments dropped, each `<name>/..` pair cancelled; a relative name whose
//    first segment is then `..` climbs out of the tree and is left out;
//  - a name that starts with `/`, or with a drive letter and `:`, is absolute
//    and is kept as the report writes it;
//  - the run's `lines` and `functions` totals are the sums the texts state
//    less the counters of every file left out, each percent
//    `coveragePercent` of what remains; an axis the texts state stays stated,
//    so a `functions` total of 0 is `{total: 0, covered: 0, percent: 0}`;
//  - a name stated in several texts of one block is judged once, as the
//    joined file, and every statement's counters leave the totals;
//  - a block whose every file climbs out keeps no coverage and no files, and
//    is dropped with one `coverage-dropped` warning that names the block and
//    says its files lie outside the run's tree;
//  - a block that keeps at least one file says nothing of the files it left
//    out, and a block that names no file at all decodes as it always has.
//
// The decoder is read through `decodeCoverageWithFiles`
// (`src/codecs/coverage.ts`), the one place a coverage block is decoded; the
// dropped block and its warning are read through `parseRunBody`
// (`src/codecs/index.ts`), the door an ingest's body goes through.
import { describe, expect, test } from "bun:test";
import { coverageCodecs, coveragePercent, decodeCoverageWithFiles } from "../src/codecs/coverage.ts";
import type { CoverageCodec } from "../src/codecs/coverage.ts";
import { codecs, parseRunBody } from "../src/codecs/index.ts";
import type { Codec, IngestWarning } from "../src/codecs/index.ts";
import type { Coverage, RunSchema } from "../src/types.ts";
import {
  byPath,
  coverageFile,
  fixtureText,
  lcovText,
  PASSING_REPORT,
  type CoverageCodecName,
  type CoverageFile,
  type LcovRecord,
} from "./helpers/coverage-files-harness.ts";

// ── The decoder ─────────────────────────────────────────────────────────────

function coverageCodec(name: CoverageCodecName): CoverageCodec {
  const codec = coverageCodecs.get(name);
  if (codec === undefined) throw new Error(`the coverage codec registry holds no ${name}`);
  return codec;
}

/** One block's texts, decoded as the board decodes them. */
function decode(name: CoverageCodecName, texts: string[]): { coverage: Coverage; files: CoverageFile[] } {
  return decodeCoverageWithFiles(coverageCodec(name), texts);
}

/** The lcov records as files, each with its own counters. */
function filesOf(records: readonly LcovRecord[]): CoverageFile[] {
  return records.map((record) =>
    coverageFile(
      record.path,
      { total: record.lf ?? 0, covered: record.lh ?? 0 },
      record.fnf !== undefined ? { total: record.fnf, covered: record.fnh ?? 0 } : undefined,
    ),
  );
}

/** The totals of the given lcov records alone: their counters added, each percent taken from the sums. */
function totalsOf(records: readonly LcovRecord[]): Coverage {
  const sum = (pick: (record: LcovRecord) => number | undefined): number =>
    records.reduce((total, record) => total + (pick(record) ?? 0), 0);
  const axis = (total: number, covered: number): { total: number; covered: number; percent: number } => ({
    total,
    covered,
    percent: coveragePercent(covered, total),
  });
  return {
    lines: axis(sum((record) => record.lf), sum((record) => record.lh)),
    functions: axis(sum((record) => record.fnf), sum((record) => record.fnh)),
  };
}

function pathsOf(files: readonly CoverageFile[]): string[] {
  return files.map((file) => file.path).sort();
}

// ── The run an ingest assembles ─────────────────────────────────────────────

type RunWithFiles = RunSchema & { coverageFiles?: CoverageFile[] };

interface Assembled {
  run: RunWithFiles;
  warnings: IngestWarning[];
}

/** A green junit report assembled with a coverage block of `texts`. */
async function assembled(codec: CoverageCodecName, texts: string | string[]): Promise<Assembled> {
  const junit = codecs.get("junit");
  if (junit === undefined) throw new Error("the codec registry holds no junit");
  const parsed = await parseRunBody(junit as Codec, { data: PASSING_REPORT, coverage: { codec, data: texts } }, "junit");
  if ("error" in parsed) throw new Error(`the body was refused: ${parsed.error}`);
  return { run: parsed.run as RunWithFiles, warnings: parsed.warnings };
}

// ── The three files ─────────────────────────────────────────────────────────

const INSIDE_A: LcovRecord = { path: "src/a.ts", lf: 40, lh: 30, fnf: 5, fnh: 4 };
const INSIDE_B: LcovRecord = { path: "lib/b.ts", lf: 23, lh: 7, fnf: 3, fnh: 1 };
/** A module a test wrote to the system's temporary directory, named as the runner names it. */
const CLIMBING: LcovRecord = { path: "../../tmp/x/c.mjs", lf: 622, lh: 230, fnf: 31, fnh: 9 };

describe("a file whose name climbs out of the run's tree is left out of the run's coverage", () => {
  test("an lcov text of src/a.ts, lib/b.ts and ../../tmp/x/c.mjs decodes to the two files inside the tree", () => {
    const { files } = decode("lcov", [lcovText([INSIDE_A, INSIDE_B, CLIMBING])]);

    expect(pathsOf(files)).toEqual(["lib/b.ts", "src/a.ts"]);
    expect(byPath(files)).toEqual(byPath(filesOf([INSIDE_A, INSIDE_B])));
    // The same two, written out by hand.
    expect(byPath(files)).toEqual([
      { path: "lib/b.ts", lines: { total: 23, covered: 7, percent: 30.4 }, functions: { total: 3, covered: 1, percent: 33.3 } },
      { path: "src/a.ts", lines: { total: 40, covered: 30, percent: 75 }, functions: { total: 5, covered: 4, percent: 80 } },
    ]);
  });

  test("its totals are the kept records' sums, each percent taken from what remains", () => {
    const { coverage } = decode("lcov", [lcovText([INSIDE_A, INSIDE_B, CLIMBING])]);

    expect(coverage).toEqual(totalsOf([INSIDE_A, INSIDE_B]));
    // 37 of 63 lines and 5 of 8 functions, by hand: the three records' 267 of 685 and 14 of 39, less the climbing file's.
    expect(coverage).toEqual({
      lines: { total: 63, covered: 37, percent: 58.7 },
      functions: { total: 8, covered: 5, percent: 62.5 },
    });
  });

  test("the totals are the same wherever the climbing record stands in the text", () => {
    const first = decode("lcov", [lcovText([CLIMBING, INSIDE_A, INSIDE_B])]);
    const between = decode("lcov", [lcovText([INSIDE_A, CLIMBING, INSIDE_B])]);

    for (const { coverage, files } of [first, between]) {
      expect(pathsOf(files)).toEqual(["lib/b.ts", "src/a.ts"]);
      expect(coverage).toEqual(totalsOf([INSIDE_A, INSIDE_B]));
    }
  });

  test("a text whose only functions lie in the climbing file keeps a functions axis of total 0, covered 0 and percent 0", () => {
    const text = lcovText([
      { path: "src/a.ts", lf: 10, lh: 5 },
      { path: "../../tmp/x/c.mjs", lf: 4, lh: 4, fnf: 3, fnh: 2 },
    ]);

    const { coverage, files } = decode("lcov", [text]);

    expect(coverage).toEqual({
      lines: { total: 10, covered: 5, percent: 50 },
      functions: { total: 0, covered: 0, percent: 0 },
    });
    // The axis is stated, not dropped.
    expect(Object.keys(coverage).sort()).toEqual(["functions", "lines"]);
    expect(files).toEqual([{ path: "src/a.ts", lines: { total: 10, covered: 5, percent: 50 } }]);
  });

  test("a climbing name stated in two texts of one block is absent, and the totals equal the kept files' sums", () => {
    const first = lcovText([
      { path: "src/a.ts", lf: 10, lh: 4, fnf: 2, fnh: 1 },
      { path: "../shared/gen.ts", lf: 8, lh: 8, fnf: 4, fnh: 4 },
    ]);
    const second = lcovText([
      { path: "lib/b.ts", lf: 7, lh: 0 },
      { path: "../shared/gen.ts", lf: 5, lh: 1, fnf: 1, fnh: 0 },
      { path: "src/a.ts", lf: 6, lh: 6 },
    ]);

    const { coverage, files } = decode("lcov", [first, second]);

    expect(pathsOf(files)).toEqual(["lib/b.ts", "src/a.ts"]);
    // A kept name stated in both texts is still one file with its counters added.
    expect(byPath(files)).toEqual([
      { path: "lib/b.ts", lines: { total: 7, covered: 0, percent: 0 } },
      { path: "src/a.ts", lines: { total: 16, covered: 10, percent: 62.5 }, functions: { total: 2, covered: 1, percent: 50 } },
    ]);
    // Both statements of the climbing name leave the totals: 13 of its lines and 5 of its functions in all.
    expect(coverage).toEqual({
      lines: { total: 23, covered: 10, percent: 43.5 },
      functions: { total: 2, covered: 1, percent: 50 },
    });
    const sum = (pick: (file: CoverageFile) => number): number => files.reduce((total, file) => total + pick(file), 0);
    expect([coverage.lines.total, coverage.lines.covered]).toEqual([sum((f) => f.lines.total), sum((f) => f.lines.covered)]);
    expect([coverage.functions?.total, coverage.functions?.covered]).toEqual([
      sum((f) => f.functions?.total ?? 0),
      sum((f) => f.functions?.covered ?? 0),
    ]);
  });

  test("a Go profile's block file that climbs out is left out, and its statements leave the lines total", () => {
    const profile = [
      "mode: set",
      "example.com/m/a.go:3.2,4.10 2 1",
      "example.com/m/a.go:6.2,6.9 1 0",
      "../gen/b.go:1.1,9.2 5 5",
      "",
    ].join("\n");

    const { coverage, files } = decode("go-coverprofile", [profile]);

    expect(files).toEqual([{ path: "example.com/m/a.go", lines: { total: 3, covered: 2, percent: 66.7 } }]);
    // A profile states no functions, and none are stated for it.
    expect(coverage).toEqual({ lines: { total: 3, covered: 2, percent: 66.7 } });
  });
});

// ── The rule, name by name ──────────────────────────────────────────────────

/** The file every name under test stands beside, so that the block always keeps a file. */
const BESIDE: LcovRecord = { path: "src/kept.ts", lf: 10, lh: 6, fnf: 2, fnh: 1 };

/** The counters the name under test is given. */
const UNDER_TEST = { lf: 7, lh: 3, fnf: 3, fnh: 2 };

const CLIMBS_OUT = ["..", "../x.ts", "./../x.ts", "src/../../x.ts", "a/b/../../../x.ts", "a//../../x.ts", "..\\x.ts"];

const STAYS_INSIDE = ["src/../lib/a.ts", "./src/a.ts", "/abs/path/a.ts", "C:\\work\\a.ts", "..x/a.ts"];

function decodeBeside(name: string): { coverage: Coverage; files: CoverageFile[] } {
  return decode("lcov", [lcovText([BESIDE, { path: name, ...UNDER_TEST }])]);
}

describe("a name that climbs out of the tree is left out", () => {
  for (const name of CLIMBS_OUT) {
    test(`the name ${name} is left out, and the file beside it is the run's only file`, () => {
      const { coverage, files } = decodeBeside(name);

      expect(files).toEqual(filesOf([BESIDE]));
      expect(files.map((file) => file.path)).toEqual(["src/kept.ts"]);
      // The totals are the kept file's own: 6 of 10 lines and 1 of 2 functions.
      expect(coverage).toEqual({
        lines: { total: 10, covered: 6, percent: 60 },
        functions: { total: 2, covered: 1, percent: 50 },
      });
    });
  }
});

describe("a name that stays inside the tree, and an absolute name, is kept as the report writes it", () => {
  for (const name of STAYS_INSIDE) {
    test(`the name ${name} is kept as written, beside the other file`, () => {
      const { coverage, files } = decodeBeside(name);

      expect(pathsOf(files)).toEqual(["src/kept.ts", name].sort());
      expect(byPath(files)).toEqual(byPath(filesOf([BESIDE, { path: name, ...UNDER_TEST }])));
      // Both files' counters are in the totals: 9 of 17 lines and 3 of 5 functions.
      expect(coverage).toEqual({
        lines: { total: 17, covered: 9, percent: 52.9 },
        functions: { total: 5, covered: 3, percent: 60 },
      });
    });
  }

  test("an absolute name is kept as written even where it holds a .. segment: the board does not know the project's root", () => {
    const records: LcovRecord[] = [
      { path: "/abs/../../x.ts", lf: 4, lh: 2 },
      { path: "C:\\..\\x.ts", lf: 6, lh: 6 },
    ];

    const { coverage, files } = decode("lcov", [lcovText(records)]);

    expect(pathsOf(files)).toEqual(["/abs/../../x.ts", "C:\\..\\x.ts"]);
    expect(coverage.lines).toEqual({ total: 10, covered: 8, percent: 80 });
  });

  test("a block of absolute names alone keeps every one of them and its totals", async () => {
    const records: LcovRecord[] = [
      { path: "/home/dev/app/src/a.ts", lf: 4, lh: 2, fnf: 1, fnh: 1 },
      { path: "C:\\Users\\dev\\app\\b.ts", lf: 6, lh: 6 },
    ];

    const { run, warnings } = await assembled("lcov", lcovText(records));

    expect(byPath(run.coverageFiles)).toEqual(byPath(filesOf(records)));
    expect(run.coverage).toEqual({
      lines: { total: 10, covered: 8, percent: 80 },
      functions: { total: 1, covered: 1, percent: 100 },
    });
    expect(warnings).toEqual([]);
  });
});

// ── The names the rule settles at its edges ─────────────────────────────────

/** A leading `\` is not absolute: the name is judged by its segments, and its first is `..`. */
const EDGE_CLIMBS_OUT = ["\\..\\x.ts"];

/** A drive letter of either case and `:` is absolute, with or without a separator after it. */
const EDGE_STAYS_INSIDE = ["c:/x.ts", "C:..\\x.ts"];

describe("a name at the rule's edge is judged as the rule says", () => {
  for (const name of EDGE_CLIMBS_OUT) {
    test(`the name ${name}, led by a backslash that is not absolute, is left out beside the kept file`, () => {
      const { coverage, files } = decodeBeside(name);

      expect(files).toEqual(filesOf([BESIDE]));
      expect(files.map((file) => file.path)).toEqual(["src/kept.ts"]);
      // The totals are the kept file's own: 6 of 10 lines and 1 of 2 functions.
      expect(coverage).toEqual({
        lines: { total: 10, covered: 6, percent: 60 },
        functions: { total: 2, covered: 1, percent: 50 },
      });
    });
  }

  for (const name of EDGE_STAYS_INSIDE) {
    test(`the name ${name}, led by a drive letter and a colon, is kept as written beside the other file`, () => {
      const { coverage, files } = decodeBeside(name);

      expect(pathsOf(files)).toEqual(["src/kept.ts", name].sort());
      expect(byPath(files)).toEqual(byPath(filesOf([BESIDE, { path: name, ...UNDER_TEST }])));
      // Both files' counters are in the totals: 9 of 17 lines and 3 of 5 functions.
      expect(coverage).toEqual({
        lines: { total: 17, covered: 9, percent: 52.9 },
        functions: { total: 5, covered: 3, percent: 60 },
      });
    });
  }
});

// ── Counters stated outside any file ────────────────────────────────────────

describe("counters an lcov report states outside any file", () => {
  test("counters a report states outside any file stay in the totals, while a climbing file's counters leave them", () => {
    // LF/LH before any SF:, then a climbing record of 10 lines with 3 hit, then a kept record of 4 with 4 hit.
    const text = [
      "LF:5",
      "LH:2",
      "SF:../x.ts",
      "LF:10",
      "LH:3",
      "end_of_record",
      "SF:src/a.ts",
      "LF:4",
      "LH:4",
      "end_of_record",
      "",
    ].join("\n");

    const { coverage, files } = decode("lcov", [text]);

    expect(files).toEqual([{ path: "src/a.ts", lines: { total: 4, covered: 4, percent: 100 } }]);
    // The report states 19 lines with 9 hit; less the climbing file's 10 and 3, that is 9 lines with 6 covered.
    expect(coverage.lines).toEqual({ total: 9, covered: 6, percent: 66.7 });
  });
});

// ── No file left ────────────────────────────────────────────────────────────

describe("a block whose every file climbs out of the tree keeps no coverage", () => {
  const EVERY_FILE_OUT = lcovText([CLIMBING, { path: "../d.ts", lf: 3, lh: 1 }]);

  test("the run has neither coverage nor files, where the same block with one file inside the tree has both", async () => {
    const dropped = await assembled("lcov", EVERY_FILE_OUT);

    expect(dropped.run.coverage).toBeUndefined();
    expect(dropped.run.coverageFiles).toBeUndefined();

    const kept = await assembled("lcov", [EVERY_FILE_OUT, lcovText([INSIDE_A])]);
    expect(kept.run.coverage).toEqual(totalsOf([INSIDE_A]));
    expect(kept.run.coverageFiles).toEqual(filesOf([INSIDE_A]));
  });

  test("it is dropped with exactly one coverage-dropped warning that names the block and says its files lie outside the run's tree", async () => {
    const { warnings } = await assembled("lcov", EVERY_FILE_OUT);

    expect(warnings.map((warning) => warning.code)).toEqual(["coverage-dropped"]);
    expect(warnings[0]?.detail).toContain("outside the run's tree");
    expect(warnings[0]?.detail).toContain("lcov");
  });

  test("several texts that each name only climbing files are still one dropped block with one warning", async () => {
    const { run, warnings } = await assembled("lcov", [lcovText([CLIMBING]), lcovText([{ path: "..\\e.ts", lf: 2, lh: 2 }])]);

    expect(run.coverage).toBeUndefined();
    expect(run.coverageFiles).toBeUndefined();
    expect(warnings.map((warning) => warning.code)).toEqual(["coverage-dropped"]);
    expect(warnings[0]?.detail).toContain("outside the run's tree");
  });

  test("a Go profile whose every block file climbs out is dropped the same way, its warning naming go-coverprofile", async () => {
    const { run, warnings } = await assembled("go-coverprofile", "mode: set\n../gen/b.go:1.1,9.2 5 5\n");

    expect(run.coverage).toBeUndefined();
    expect(run.coverageFiles).toBeUndefined();
    expect(warnings.map((warning) => warning.code)).toEqual(["coverage-dropped"]);
    expect(warnings[0]?.detail).toContain("outside the run's tree");
    expect(warnings[0]?.detail).toContain("go-coverprofile");
  });
});

// ── Silence ─────────────────────────────────────────────────────────────────

describe("a block that keeps at least one file says nothing of the files it left out", () => {
  test("the assembled run carries the kept files and totals, no warning, and no key a run of the kept files alone lacks", async () => {
    const withClimbing = await assembled("lcov", lcovText([INSIDE_A, INSIDE_B, CLIMBING]));
    const keptAlone = await assembled("lcov", lcovText([INSIDE_A, INSIDE_B]));

    expect(withClimbing.warnings).toEqual([]);
    expect(byPath(withClimbing.run.coverageFiles)).toEqual(byPath(filesOf([INSIDE_A, INSIDE_B])));
    expect(withClimbing.run.coverage).toEqual(totalsOf([INSIDE_A, INSIDE_B]));
    // Neither a count nor a list of what was left out: the run is the run of the kept files alone.
    expect(Object.keys(withClimbing.run).sort()).toEqual(Object.keys(keptAlone.run).sort());
    expect(withClimbing.run.coverage).toEqual(keptAlone.run.coverage as Coverage);
    expect(JSON.stringify(withClimbing.run)).not.toContain("c.mjs");
  });
});

// ── What stays as it is ─────────────────────────────────────────────────────

interface KeptFixture {
  label: string;
  codec: CoverageCodecName;
  text: string;
  /** The totals the report decodes to, by hand. */
  coverage: Coverage;
  /** The files the report states, by hand: name, lines `[total, covered]`, functions `[total, covered]` when it has any. */
  files: Array<{ path: string; lines: [number, number]; functions?: [number, number] }>;
}

const JACOCO_HEADER_ONLY = fixtureText("jacoco-csv", "header-only.csv");
const GO_TYPES_ONLY = fixtureText("go-coverprofile", "contracts-types-only.coverprofile");

const OTHER_CODEC_FIXTURES: KeptFixture[] = [
  {
    label: "the Maven app module's CSV",
    codec: "jacoco",
    text: fixtureText("reports", "mvn", "app", "target", "site", "jacoco", "jacoco.csv"),
    coverage: {
      lines: { total: 5, covered: 5, percent: 100 },
      functions: { total: 3, covered: 3, percent: 100 },
      branches: { total: 4, covered: 3, percent: 75 },
    },
    files: [{ path: "com.acme.app.Greeter", lines: [5, 5], functions: [3, 3] }],
  },
  {
    label: "the Maven core module's CSV",
    codec: "jacoco",
    text: fixtureText("reports", "mvn", "core", "target", "site", "jacoco", "jacoco.csv"),
    coverage: {
      lines: { total: 10, covered: 6, percent: 60 },
      functions: { total: 4, covered: 4, percent: 100 },
      branches: { total: 8, covered: 4, percent: 50 },
    },
    files: [{ path: "com.acme.core.Calc", lines: [10, 6], functions: [4, 4] }],
  },
  {
    label: "the multi-row CSV",
    codec: "jacoco",
    text: fixtureText("jacoco-csv", "multi-row.csv"),
    coverage: {
      lines: { total: 42, covered: 25, percent: 59.5 },
      functions: { total: 16, covered: 11, percent: 68.8 },
      branches: { total: 16, covered: 9, percent: 56.2 },
    },
    files: [
      { path: "com.acme.shop.Basket", lines: [20, 17], functions: [8, 7] },
      { path: "com.acme.shop.Basket.Line", lines: [6, 6], functions: [3, 3] },
      { path: "com.acme.shop.Currency", lines: [2, 0] },
      { path: "Launcher", lines: [6, 2], functions: [2, 1] },
      { path: "com.acme.shop.tax.Rate", lines: [8, 0], functions: [3, 0] },
    ],
  },
  {
    label: "the plain shop profile",
    codec: "go-coverprofile",
    text: fixtureText("go-coverprofile", "shop-plain.coverprofile"),
    coverage: { lines: { total: 18, covered: 4, percent: 22.2 } },
    files: [
      { path: "example.com/shop/stock/stock.go", lines: [5, 1] },
      { path: "example.com/shop/price/price.go", lines: [10, 3] },
      { path: "example.com/shop/report/report.go", lines: [3, 0] },
    ],
  },
  {
    label: "the shop profile taken across packages",
    codec: "go-coverprofile",
    text: fixtureText("go-coverprofile", "shop-coverpkg.coverprofile"),
    coverage: { lines: { total: 18, covered: 8, percent: 44.4 } },
    files: [
      { path: "example.com/shop/price/price.go", lines: [10, 7] },
      { path: "example.com/shop/report/report.go", lines: [3, 0] },
      { path: "example.com/shop/stock/stock.go", lines: [5, 1] },
    ],
  },
  {
    label: "the ledger profile",
    codec: "go-coverprofile",
    text: fixtureText("go-coverprofile", "ledger.coverprofile"),
    coverage: { lines: { total: 16, covered: 12, percent: 75 } },
    files: [{ path: "example.com/ledger/ledger.go", lines: [16, 12] }],
  },
  {
    label: "the ledger profile in count mode",
    codec: "go-coverprofile",
    text: fixtureText("go-coverprofile", "ledger-count.coverprofile"),
    coverage: { lines: { total: 16, covered: 12, percent: 75 } },
    files: [{ path: "example.com/ledger/ledger.go", lines: [16, 12] }],
  },
];

describe("a JaCoCo report and a Go profile keep the files and totals they always kept: none of their names climbs", () => {
  for (const fixture of OTHER_CODEC_FIXTURES) {
    test(`${fixture.codec}, ${fixture.label}: every file and every axis of the totals`, () => {
      const { coverage, files } = decode(fixture.codec, [fixture.text]);

      expect(coverage).toEqual(fixture.coverage);
      expect(byPath(files)).toEqual(
        byPath(
          fixture.files.map((file) =>
            coverageFile(
              file.path,
              { total: file.lines[0], covered: file.lines[1] },
              file.functions !== undefined ? { total: file.functions[0], covered: file.functions[1] } : undefined,
            ),
          ),
        ),
      );
    });
  }
});

describe("a block that names no file at all decodes as it always has", () => {
  test("a JaCoCo CSV of its header alone decodes to its zero totals and no file, with no warning", async () => {
    const zero = { total: 0, covered: 0, percent: 0 };

    expect(decode("jacoco", [JACOCO_HEADER_ONLY])).toEqual({
      coverage: { lines: zero, functions: zero, branches: zero },
      files: [],
    });

    const { run, warnings } = await assembled("jacoco", JACOCO_HEADER_ONLY);
    expect(run.coverage).toEqual({ lines: zero, functions: zero, branches: zero });
    expect(run.coverageFiles).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a Go profile of its mode line alone decodes to 0 of 0 lines and no file, with no warning", async () => {
    expect(GO_TYPES_ONLY).toBe("mode: set\n");

    expect(decode("go-coverprofile", [GO_TYPES_ONLY])).toEqual({
      coverage: { lines: { total: 0, covered: 0, percent: 0 } },
      files: [],
    });

    const { run, warnings } = await assembled("go-coverprofile", GO_TYPES_ONLY);
    expect(run.coverage).toEqual({ lines: { total: 0, covered: 0, percent: 0 } });
    expect(run.coverageFiles).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("an lcov text with no function records keeps its functions axis", () => {
  test("a text of one file with lines alone decodes to a functions axis of total 0, covered 0 and percent 0", () => {
    const { coverage, files } = decode("lcov", [lcovText([{ path: "src/delta.ts", lf: 80, lh: 1 }])]);

    expect(coverage).toEqual({
      lines: { total: 80, covered: 1, percent: 1.2 },
      functions: { total: 0, covered: 0, percent: 0 },
    });
    expect(files).toEqual([{ path: "src/delta.ts", lines: { total: 80, covered: 1, percent: 1.2 } }]);
  });
});
