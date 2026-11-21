// The `go-coverprofile` coverage codec reads a Go coverprofile into the run's
// coverage total: statement coverage on the `lines` axis — covered statements
// over all statements, each block weighted by its statement count, a block the
// profile lists more than once (`-coverpkg`) counted once and covered if any
// copy has a count above 0. A coverprofile states no functions and no
// branches, so the decoded coverage has neither axis. A text with a `mode:`
// line and no block decodes to 0 of 0 statements; a text with no `mode:` line,
// or with a malformed block line, is undecodable and throws, as the other
// coverage codecs do.
//
// Every profile here is a real capture (`tests/fixtures/go-coverprofile/`,
// Go 1.27.3). Every expected figure is computed from the profile text by the
// independent oracle in `tests/helpers/go-coverprofile-oracle.ts`, and checked
// against Go's own `go tool cover -func` total where a capture carries one.
import { describe, test, expect } from "bun:test";
import { coverageCodecs, decodeCoverage } from "../../src/codecs/coverage.ts";
import type { CoverageCodec } from "../../src/codecs/coverage.ts";
import { coverFuncTotal, goCoverFixture, profileFigure } from "../helpers/go-coverprofile-oracle.ts";

const SHOP_PLAIN = goCoverFixture("shop-plain.coverprofile");
const SHOP_COVERPKG = goCoverFixture("shop-coverpkg.coverprofile");
const CONTRACTS_TYPES_ONLY = goCoverFixture("contracts-types-only.coverprofile");
const LEDGER = goCoverFixture("ledger.coverprofile");
const LEDGER_COUNT = goCoverFixture("ledger-count.coverprofile");

/** The registered codec; a board without it fails here, before any decode is tried. */
function goCodec(): CoverageCodec {
  const codec = coverageCodecs.get("go-coverprofile");
  expect(codec, "the coverage codec registry must hold go-coverprofile").toBeDefined();
  return codec as CoverageCodec;
}

/** A capture's `lines` axis as the oracle computes it, with Go's `cover -func` total as the percent. */
function goFigure(profile: string, coverFunc: string): { total: number; covered: number; percent: number } {
  const figure = profileFigure(profile);
  return { total: figure.total, covered: figure.covered, percent: coverFuncTotal(goCoverFixture(coverFunc)) };
}

describe("go-coverprofile — statements on the lines axis", () => {
  test("a plain multi-package profile decodes to its covered and all statements, weighted by each block's statement count", () => {
    const coverage = decodeCoverage(goCodec(), [SHOP_PLAIN]);
    const expected = goFigure(SHOP_PLAIN, "shop-plain.cover-func.txt");
    // The oracle's own reading of the capture: 15 blocks holding 18 statements, 4 of them covered.
    expect(profileFigure(SHOP_PLAIN)).toEqual({ blocks: 15, listed: 15, total: 18, covered: 4 });
    expect(expected).toEqual({ total: 18, covered: 4, percent: 22.2 });
    expect(coverage.lines).toEqual(expected);
    // Weighted by statements, never by block: 15 blocks, not 18 statements, is the wrong total.
    expect(coverage.lines.total).not.toBe(15);
  });

  test("a package with no test file counts its statements as uncovered, not as absent", () => {
    const coverage = decodeCoverage(goCodec(), [SHOP_PLAIN]);
    // `report` has no test: its 3 statements are listed at 0 and stay in the total.
    const withoutReport = SHOP_PLAIN.split("\n")
      .filter((line) => !line.includes("/report/"))
      .join("\n");
    expect(profileFigure(withoutReport).total).toBe(15);
    expect(coverage.lines.total).toBe(18);
    expect(coverage.lines.covered).toBe(4);
  });

  test("a -coverpkg profile counts each repeated block once, covered when any copy of it ran", () => {
    const coverage = decodeCoverage(goCodec(), [SHOP_COVERPKG]);
    const expected = goFigure(SHOP_COVERPKG, "shop-coverpkg.cover-func.txt");
    // 33 block lines, 15 distinct blocks, the same 18 statements as the plain run.
    expect(profileFigure(SHOP_COVERPKG)).toEqual({ blocks: 15, listed: 33, total: 18, covered: 8 });
    expect(expected).toEqual({ total: 18, covered: 8, percent: 44.4 });
    expect(coverage.lines).toEqual(expected);
    // Not the naive sum of every listed copy (18 + 18 + 3 = 39 statements), not the
    // first copy's verdict (3 covered: price's own test), not the last copy's (5: stock's).
    expect(coverage.lines.total).not.toBe(39);
    expect(coverage.lines.covered).not.toBe(3);
    expect(coverage.lines.covered).not.toBe(5);
  });

  test("the plain and the -coverpkg captures of one module hold the same statements, and each figure is Go's own", () => {
    const plain = decodeCoverage(goCodec(), [SHOP_PLAIN]);
    const coverpkg = decodeCoverage(goCodec(), [SHOP_COVERPKG]);
    // The same 18 statements either way; -coverpkg credits price.Round, run only from stock's test.
    expect(coverpkg.lines.total).toBe(plain.lines.total);
    expect(plain.lines.percent).toBe(coverFuncTotal(goCoverFixture("shop-plain.cover-func.txt")));
    expect(coverpkg.lines.percent).toBe(coverFuncTotal(goCoverFixture("shop-coverpkg.cover-func.txt")));
  });

  test("on a package with no package-level function literal the percent equals go tool cover -func's total", () => {
    const coverage = decodeCoverage(goCodec(), [LEDGER]);
    expect(coverage.lines).toEqual({ total: 16, covered: 12, percent: 75 });
    expect(coverage.lines.percent).toBe(coverFuncTotal(goCoverFixture("ledger.cover-func.txt")));
    expect(coverage.lines.total).toBe(profileFigure(LEDGER).total);
  });

  test("a mode: count profile counts a block's statements once whatever its hit count", () => {
    const counted = decodeCoverage(goCodec(), [LEDGER_COUNT]);
    expect(LEDGER_COUNT.startsWith("mode: count\n")).toBe(true);
    // The same blocks as the mode: set capture, hit up to 9 times: still 12 of 16 statements.
    expect(counted.lines).toEqual({ total: 16, covered: 12, percent: 75 });
    expect(counted.lines.percent).toBe(coverFuncTotal(goCoverFixture("ledger-count.cover-func.txt")));
    expect(counted.lines).toEqual(decodeCoverage(goCodec(), [LEDGER]).lines);
  });
});

describe("go-coverprofile — no functions axis, no branches axis", () => {
  test("a decoded profile carries the lines axis only", () => {
    const coverage = decodeCoverage(goCodec(), [SHOP_PLAIN]);
    expect(Object.keys(coverage).sort()).toEqual(["lines"]);
    expect(coverage.functions).toBeUndefined();
    expect(coverage.branches).toBeUndefined();
  });

  test("several profiles summed carry the lines axis only", () => {
    const coverage = decodeCoverage(goCodec(), [SHOP_COVERPKG, LEDGER, CONTRACTS_TYPES_ONLY]);
    expect(Object.keys(coverage).sort()).toEqual(["lines"]);
    // 18 + 16 + 0 statements, 8 + 12 + 0 covered: 20 / 34 = 58.82…
    expect(coverage.lines).toEqual({ total: 34, covered: 20, percent: 58.8 });
  });
});

describe("go-coverprofile — a module with no statements", () => {
  test("a mode: line with no block decodes to 0 of 0 statements, percent 0", () => {
    expect(CONTRACTS_TYPES_ONLY).toBe("mode: set\n");
    const coverage = decodeCoverage(goCodec(), [CONTRACTS_TYPES_ONLY]);
    expect(coverage.lines).toEqual({ total: 0, covered: 0, percent: 0 });
    expect(Object.keys(coverage).sort()).toEqual(["lines"]);
  });

  test("summed with another module's profile, the types-only module leaves that module's figure intact", () => {
    const ledgerAlone = decodeCoverage(goCodec(), [LEDGER]);
    const before = decodeCoverage(goCodec(), [CONTRACTS_TYPES_ONLY, LEDGER]);
    const after = decodeCoverage(goCodec(), [LEDGER, CONTRACTS_TYPES_ONLY]);
    expect(before.lines).toEqual({ total: 16, covered: 12, percent: 75 });
    expect(after.lines).toEqual({ total: 16, covered: 12, percent: 75 });
    expect(before.lines).toEqual(ledgerAlone.lines);
  });
});

describe("go-coverprofile — an undecodable text throws", () => {
  test("a profile with no mode: line is undecodable", () => {
    const codec = goCodec();
    const noMode = LEDGER.split("\n").slice(1).join("\n");
    expect(noMode.includes("mode:")).toBe(false);
    expect(() => codec.read(noMode)).toThrow();
    expect(() => decodeCoverage(codec, [noMode])).toThrow();
  });

  test("an empty text is undecodable", () => {
    const codec = goCodec();
    expect(() => codec.read("")).toThrow();
  });

  test("a block line missing its count is undecodable", () => {
    const codec = goCodec();
    const malformed = LEDGER.replace("example.com/ledger/ledger.go:11.2,12.28 2 1", "example.com/ledger/ledger.go:11.2,12.28 2");
    expect(malformed).not.toBe(LEDGER);
    expect(() => codec.read(malformed)).toThrow();
  });

  test("a line that is not a block at all is undecodable", () => {
    const codec = goCodec();
    const malformed = `${LEDGER}ok  \texample.com/ledger\t0.002s\tcoverage: 75.0% of statements\n`;
    expect(() => codec.read(malformed)).toThrow();
  });

  test("a block whose statement count is not a number is undecodable", () => {
    const codec = goCodec();
    const malformed = LEDGER.replace("example.com/ledger/ledger.go:13.3,13.27 1 1", "example.com/ledger/ledger.go:13.3,13.27 one 1");
    expect(malformed).not.toBe(LEDGER);
    expect(() => codec.read(malformed)).toThrow();
  });

  test("one undecodable text among good ones makes the whole sum undecodable", () => {
    const codec = goCodec();
    const noMode = SHOP_PLAIN.split("\n").slice(1).join("\n");
    expect(() => decodeCoverage(codec, [LEDGER, noMode])).toThrow();
  });
});
