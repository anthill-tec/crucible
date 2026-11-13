// The lint decoders — ruff, cargo clippy, clang-tidy (through gcc) and go vet
// (through go) — decoded by `parseCompile` and selected by `detectFormat`
// (both in src/codecs/compile.ts).
//
// The inputs are real linter runs checked in under tests/fixtures/lint/ (see
// its README for each tool's version, command and scratch source). They are
// kept as the tools printed them; only absolute scratch paths were rewritten
// to relative ones.
//
// The rules under test:
//   - ruff's concise lines are `PATH:LINE:COL: CODE message`, every finding at
//     level `error`; the fix marker `[*]` is stripped from the message; a
//     syntax error is coded `invalid-syntax`; `E902` (a missing file) is an
//     ordinary finding; the summary lines (`Found N errors.`, `[*] N fixable …`,
//     `All checks passed!`) are never findings;
//   - clippy reads cargo clippy's human output as rustc does, except that a
//     clippy lint is coded `clippy::<name>` from its help URL (falling back to
//     the `#[warn(clippy::…)]` / `#[deny(…)]` / `-D clippy::…` note, kebab case
//     read as snake case), a quoted source line such as
//     `#![deny(clippy::all)]` is never a code, rustc's own lints are coded by
//     the name in their `#[warn(<name>)]` note or their `-D <name>` /
//     `-W <name>` note (kebab case read as snake case, the form `-D warnings`
//     prints), an `E####` keeps its code, and
//     cargo's `could not compile …` trailer is never a finding;
//   - gcc takes a trailing bracketed check as the code, the first
//     comma-separated item that is not a flag (`-warnings-as-errors` is
//     dropped);
//   - with the guard switches a linter that exited 0 is given, gcc's
//     "no error means raw" fallback is off, so a warnings-only clang-tidy run
//     keeps its findings; with the default switches it stands;
//   - the hints `ruff`, `clippy`, `go vet` (→ `go`) and `clang-tidy` (→ `gcc`)
//     select their decoders.
//
// Tests labelled "regression guard" pass today on purpose: they pin behaviour
// the new decoders must not move.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompileGuards, detectFormat, parseCompile } from "../src/codecs/compile.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "lint");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** The guard switches a lint post whose linter exited 0 hands the decoder. */
const LINTER_EXITED_ZERO: CompileGuards = { gccNoErrorToRaw: false, goMessageOnly: false };

type Diagnostic = {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: "error" | "warning";
};

function finding(
  file: string,
  line: number,
  col: number,
  code: string,
  level: "error" | "warning",
  message: string,
): Diagnostic {
  return { file, line, col, code, message, level };
}

/** Drops every line that names a clippy help URL, so only the notes can name a lint. */
function withoutHelpUrls(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes("rust-lang.github.io/rust-clippy/"))
    .join("\n");
}

// ── ruff ────────────────────────────────────────────────────────────────────

const RUFF_MIXED = "ruff-mixed.txt";
const RUFF_CLEAN = "ruff-clean.txt";

const RUFF_MIXED_FINDINGS: Diagnostic[] = [
  finding("a.py", 1, 8, "F401", "error", "`os` imported but unused"),
  finding("b.py", 2, 25, "F821", "error", "Undefined name `missing_offset`"),
  finding("c.py", 1, 12, "invalid-syntax", "error", "Expected a parameter or the end of the parameter list"),
  finding("c.py", 1, 13, "invalid-syntax", "error", "Expected `)`, found newline"),
  finding("missing.py", 1, 1, "E902", "error", "No such file or directory (os error 2)"),
];

describe("ruff decoder — a real ruff run decodes to exactly its findings", () => {
  test("ruff-mixed hinted ruff decodes to its five findings in terminal order, each with file, line, col, code and level error", () => {
    const input = fixture(RUFF_MIXED);
    const report = parseCompile(input, "ruff");
    expect(report.format).not.toBe("raw");
    // toStrictEqual: no finding carries a key beyond file, line, col, code, message and level.
    expect(report.diagnostics).toStrictEqual(RUFF_MIXED_FINDINGS);
    expect(report.errorCount).toBe(5);
    expect(report.warningCount).toBe(0);
    expect(report.raw).toBe(input);
  });

  test("ruff-mixed hinted ruff strips the fix marker `[*]` from the fixable finding's message", () => {
    const report = parseCompile(fixture(RUFF_MIXED), "ruff");
    const fixable = report.diagnostics.find((d) => d.code === "F401");
    expect(fixable?.message).toBe("`os` imported but unused");
    expect(report.diagnostics.some((d) => d.message.includes("[*]"))).toBe(false);
  });

  test("ruff-mixed hinted ruff decodes a syntax error as a finding coded invalid-syntax", () => {
    const report = parseCompile(fixture(RUFF_MIXED), "ruff");
    const syntax = report.diagnostics.filter((d) => d.code === "invalid-syntax");
    expect(syntax).toStrictEqual([RUFF_MIXED_FINDINGS[2], RUFF_MIXED_FINDINGS[3]]);
  });

  test("ruff-mixed hinted ruff never turns the `Found 5 errors.` or `[*] 1 fixable …` summary lines into findings", () => {
    const report = parseCompile(fixture(RUFF_MIXED), "ruff");
    expect(report.diagnostics).toHaveLength(5);
    expect(report.diagnostics.some((d) => d.message.startsWith("Found "))).toBe(false);
    expect(report.diagnostics.some((d) => d.message.includes("fixable with the `--fix` option"))).toBe(false);
    // Every finding names a file: a summary line has none to give.
    expect(report.diagnostics.every((d) => typeof d.file === "string" && d.file.endsWith(".py"))).toBe(true);
  });

  test("ruff-clean (`All checks passed!`) hinted ruff from a linter that exited 0 decodes to zero findings and no error", () => {
    const input = fixture(RUFF_CLEAN);
    const report = parseCompile(input, "ruff", LINTER_EXITED_ZERO);
    expect(report.format).not.toBe("raw");
    expect(report.diagnostics).toStrictEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.raw).toBe(input);
  });
});

// ── clippy ──────────────────────────────────────────────────────────────────

const CLIPPY_MIXED = "clippy-mixed.txt";
const CLIPPY_DENY_WARNINGS = "clippy-deny-warnings.txt";
const CLIPPY_CLEAN = "clippy-clean.txt";
const CLIPPY_DENY_WARNINGS_RUSTC_LINT = "clippy-deny-warnings-rustc-lint.txt";

const CLIPPY_MIXED_FINDINGS: Diagnostic[] = [
  finding("broken/src/lib.rs", 2, 22, "E0308", "error", "mismatched types"),
  finding("shop/src/main.rs", 14, 9, "unused_variables", "warning", "unused variable: `unused`"),
  finding("shop/src/main.rs", 5, 9, "clippy::needless_return", "error", "unneeded `return` statement"),
  finding(
    "shop/src/main.rs",
    9,
    13,
    "clippy::ptr_arg",
    "warning",
    "writing `&String` instead of `&str` involves a new object where a slice will do",
  ),
];

const CLIPPY_DENY_WARNINGS_FINDINGS: Diagnostic[] = [
  finding("src/main.rs", 2, 5, "clippy::needless_return", "error", "unneeded `return` statement"),
];

describe("clippy decoder — a real cargo clippy run decodes to exact counts and codes", () => {
  test("clippy-mixed hinted clippy decodes to two errors and two warnings, in terminal order, with their codes", () => {
    const input = fixture(CLIPPY_MIXED);
    const report = parseCompile(input, "clippy");
    expect(report.format).not.toBe("raw");
    expect(report.diagnostics).toStrictEqual(CLIPPY_MIXED_FINDINGS);
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(2);
    expect(report.raw).toBe(input);
  });

  test("clippy-mixed hinted clippy codes the warn lint and the lint denied through `#![deny(clippy::all)]` as clippy::<name> from the help URL", () => {
    const report = parseCompile(fixture(CLIPPY_MIXED), "clippy");
    const clippyCodes = report.diagnostics.map((d) => d.code).filter((c) => c?.startsWith("clippy::"));
    expect(clippyCodes).toEqual(["clippy::needless_return", "clippy::ptr_arg"]);
  });

  test("clippy-mixed hinted clippy never codes a finding clippy::all, the group named only on the quoted source line", () => {
    const report = parseCompile(fixture(CLIPPY_MIXED), "clippy");
    expect(report.diagnostics.map((d) => d.code)).not.toContain("clippy::all");
    // The lint the deny group caught is still coded, by its own name.
    expect(report.diagnostics.find((d) => d.line === 5)?.code).toBe("clippy::needless_return");
  });

  test("clippy-mixed hinted clippy codes rustc's own unused-variable warning unused_variables and keeps the E0308 error's code", () => {
    const report = parseCompile(fixture(CLIPPY_MIXED), "clippy");
    expect(report.diagnostics.find((d) => d.message === "unused variable: `unused`")).toStrictEqual(
      CLIPPY_MIXED_FINDINGS[1],
    );
    expect(report.diagnostics.find((d) => d.message === "mismatched types")).toStrictEqual(CLIPPY_MIXED_FINDINGS[0]);
  });

  test("clippy-mixed hinted clippy never turns cargo's `could not compile …` trailers into findings", () => {
    const report = parseCompile(fixture(CLIPPY_MIXED), "clippy");
    expect(report.diagnostics.some((d) => d.message.startsWith("could not compile"))).toBe(false);
    // Every finding has a location; a trailer has none.
    expect(report.diagnostics.every((d) => d.file !== undefined)).toBe(true);
    expect(report.diagnostics).toHaveLength(4);
  });

  test("clippy-deny-warnings (a lint under `-D warnings`) hinted clippy decodes to one error coded clippy::needless_return, its trailer dropped", () => {
    const input = fixture(CLIPPY_DENY_WARNINGS);
    const report = parseCompile(input, "clippy");
    expect(report.format).not.toBe("raw");
    expect(report.diagnostics).toStrictEqual(CLIPPY_DENY_WARNINGS_FINDINGS);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
  });

  test("clippy-deny-warnings-rustc-lint (rustc's unused variable under `-D warnings`) hinted clippy decodes to one error coded unused_variables from the kebab-case `-D unused-variables` note, its trailer dropped", () => {
    const input = fixture(CLIPPY_DENY_WARNINGS_RUSTC_LINT);
    const report = parseCompile(input, "clippy");
    expect(report.format).not.toBe("raw");
    expect(report.diagnostics).toStrictEqual([
      finding("src/main.rs", 2, 9, "unused_variables", "error", "unused variable: `spare`"),
    ]);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.raw).toBe(input);
  });

  test("clippy-mixed with its help-URL lines removed hinted clippy still codes each lint from its #[warn]/#[deny] note, never clippy::all", () => {
    const report = parseCompile(withoutHelpUrls(fixture(CLIPPY_MIXED)), "clippy");
    expect(report.diagnostics).toStrictEqual(CLIPPY_MIXED_FINDINGS);
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(2);
  });

  test("clippy-deny-warnings with its help-URL line removed hinted clippy reads the kebab-case `-D clippy::needless-return` note as clippy::needless_return", () => {
    const report = parseCompile(withoutHelpUrls(fixture(CLIPPY_DENY_WARNINGS)), "clippy");
    expect(report.diagnostics).toStrictEqual(CLIPPY_DENY_WARNINGS_FINDINGS);
  });

  test("clippy-clean hinted clippy from a linter that exited 0 decodes to zero findings and no error", () => {
    const input = fixture(CLIPPY_CLEAN);
    const report = parseCompile(input, "clippy", LINTER_EXITED_ZERO);
    expect(report.format).not.toBe("raw");
    expect(report.diagnostics).toStrictEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.raw).toBe(input);
  });
});

// ── clang-tidy, through gcc ─────────────────────────────────────────────────

const CLANG_TIDY_WARNINGS = "clang-tidy-warnings.txt";
const CLANG_TIDY_AS_ERRORS = "clang-tidy-warnings-as-errors.txt";
const BRACES = "readability-braces-around-statements";
const BRACES_MESSAGE = "statement should be inside braces";

describe("clang-tidy through gcc — a bracketed check is the code", () => {
  for (const hint of ["clang-tidy", "gcc"]) {
    test(`clang-tidy-warnings hinted ${hint} from a linter that exited 0 decodes to its two warnings coded ${BRACES}, not raw`, () => {
      const input = fixture(CLANG_TIDY_WARNINGS);
      const report = parseCompile(input, hint, LINTER_EXITED_ZERO);
      expect(report.format).toBe("gcc");
      expect(report.diagnostics).toStrictEqual([
        finding("a.c", 2, 13, BRACES, "warning", BRACES_MESSAGE),
        finding("a.c", 4, 13, BRACES, "warning", BRACES_MESSAGE),
      ]);
      expect(report.errorCount).toBe(0);
      expect(report.warningCount).toBe(2);
      expect(report.raw).toBe(input);
    });
  }

  test("clang-tidy-warnings-as-errors hinted clang-tidy decodes each `[check,-warnings-as-errors]` line as an error coded by the check, the flag dropped", () => {
    const input = fixture(CLANG_TIDY_AS_ERRORS);
    const report = parseCompile(input, "clang-tidy");
    expect(report.format).toBe("gcc");
    expect(report.diagnostics).toStrictEqual([
      finding("a.c", 2, 13, BRACES, "error", BRACES_MESSAGE),
      finding("a.c", 4, 13, BRACES, "error", BRACES_MESSAGE),
    ]);
    expect(report.diagnostics.some((d) => d.code?.includes("warnings-as-errors"))).toBe(false);
    // `2 warnings treated as errors` and `2 warnings generated.` are never findings.
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(0);
  });

  for (const hint of [undefined, "gcc"]) {
    test(`regression guard: clang-tidy-warnings ${hint ? "hinted gcc" : "unhinted"} with the default guard switches holds no error, so it still falls back to raw`, () => {
      const input = fixture(CLANG_TIDY_WARNINGS);
      const report = parseCompile(input, hint);
      expect(report.format).toBe("raw");
      expect(report.diagnostics).toStrictEqual([]);
      expect(report.raw).toBe(input);
    });
  }
});

// ── the hint aliases, and go vet through go ─────────────────────────────────

const GO_VET = "go-vet.txt";

describe("lint hint aliases select their decoders", () => {
  const ALIASES: Array<[string, string]> = [
    ["ruff", "ruff"],
    ["clippy", "clippy"],
    ["go vet", "go"],
    ["clang-tidy", "gcc"],
  ];

  for (const [hint, format] of ALIASES) {
    test(`the hint '${hint}' selects the ${format} decoder regardless of content`, () => {
      expect(detectFormat("anything", hint)).toBe(format);
      expect(detectFormat("", hint)).toBe(format);
    });
  }

  test("the hint 'go vet' on empty output from a linter that exited 0 decodes through go to a clean report", () => {
    const report = parseCompile("", "go vet", LINTER_EXITED_ZERO);
    expect(report.format).toBe("go");
    expect(report.diagnostics).toStrictEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  test("the hint 'clang-tidy' on empty output from a linter that exited 0 decodes through gcc to a clean report", () => {
    const report = parseCompile("", "clang-tidy", LINTER_EXITED_ZERO);
    expect(report.format).toBe("gcc");
    expect(report.diagnostics).toStrictEqual([]);
    expect(report.errorCount).toBe(0);
  });

  test("regression guard: the go-vet capture hinted 'go vet' decodes through go to its two vet findings", () => {
    const input = fixture(GO_VET);
    const report = parseCompile(input, "go vet");
    expect(report.format).toBe("go");
    expect(report.diagnostics).toStrictEqual([
      { file: "report/report.go", line: 6, col: 22, level: "error", message: "fmt.Sprintf format %d has arg name of wrong type string" },
      { file: "report/report.go", line: 10, col: 20, level: "error", message: "fmt.Printf format %s has arg a + b of wrong type int" },
    ]);
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(0);
  });
});
