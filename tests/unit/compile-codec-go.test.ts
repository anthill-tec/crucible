// The `go` compile format — `go build` diagnostics, and the test compile's
// (`go test -count=1 -vet=off -run '^$' -exec /bin/true ./...`), decoded by
// `parseCompile` and detected/selected by `detectFormat` (both in
// src/codecs/compile.ts).
//
// The inputs are the real Go 1.27.3 failures checked in under
// tests/fixtures/go-build/ (see its README): stdout and stderr in the order Go
// printed them, paths exactly as Go printed them.
//
// The rules under test:
//   - a diagnostic is `path:LINE:COL: message`, or `path:LINE: message` with no
//     column (a `go.mod` error); the path is kept as Go printed it;
//   - a tab-indented line after a diagnostic continues it and lands in its
//     message;
//   - package headers (`# pkg`, `# [pkg]`, `# pkg [pkg.test]`), `go:` lines,
//     the test compile's `ok`, `?` and `FAIL` lines and the `too many errors`
//     line Go prints after its tenth error are never records;
//   - every diagnostic is an `error`; Go prints no warnings; no package field;
//   - a report holding no positioned diagnostic (an import cycle, two packages
//     in one directory) is ONE message-only error, never a clean compile.
//
// How continuation lines and the lines of a message-only error are JOINED is
// not fixed by the format's rules, so those assertions compare the message
// with its whitespace runs collapsed to one space: the words and their order
// are pinned, the separator is not.
//
// Tests labelled "regression guard" pass today on purpose: they pin
// behaviour the new format must not move.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectFormat, parseCompile } from "../../src/codecs/compile.ts";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures", "go-build");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** A message with every whitespace run (newlines and tabs included) read as one space. */
function words(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

type Diagnostic = {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: "error" | "warning";
};

function goError(file: string, line: number, col: number, message: string): Diagnostic {
  return { file, line, col, message, level: "error" };
}

const MULTI = "build-multi-package-too-many-errors.txt";
const IFACE = "build-interface-mismatch.txt";
const MISSING = "build-missing-module.txt";
const GOMOD = "build-go-mod-error.txt";
const CYCLE = "build-import-cycle.txt";
const TWO_PACKAGES = "build-two-packages-one-directory.txt";
const TEST_CYCLE = "test-compile-import-cycle.txt";
const TEST_FILE = "test-compile-test-file-error.txt";
const GO_VERSION = "build-go-version-too-new.txt";
const MOD_UPDATES = "build-go-mod-updates-needed.txt";
const CYCLE_GO_WARNING = "build-import-cycle-with-go-warning.txt";

const STORE_UNDEFINED: Diagnostic[] = Array.from({ length: 10 }, (_, i) =>
  goError("store/store.go", 4 + i, 6, `undefined: a${i + 1}`),
);

/** The captures whose every diagnostic is a single line, in terminal order. */
const SINGLE_LINE_CAPTURES: Record<string, Diagnostic[]> = {
  [MULTI]: [
    goError("api/api.go", 4, 6, "declared and not used: code"),
    goError(
      "api/api.go",
      4,
      17,
      "cannot use path (variable of type string) as int value in variable declaration",
    ),
    goError("api/api.go", 5, 9, "undefined: status"),
    ...STORE_UNDEFINED,
    goError("./main.go", 6, 14, "undefined: total"),
  ],
  [GOMOD]: [{ file: "go.mod", line: 5, message: "unknown directive: bogus", level: "error" }],
  [TEST_FILE]: [
    goError(
      "ledger/ledger_test.go",
      6,
      19,
      "cannot use Balance() (value of type int) as string value in variable declaration",
    ),
  ],
};

const IFACE_HEAD =
  "cannot use Square{} (value of struct type Square) as Area value in variable declaration: " +
  "Square does not implement Area (wrong type for method Area)";
const MISSING_HEAD =
  "no required module provides package example.com/nowhere/widgets; to add it:";

const CYCLE_WORDS =
  "package example.com/cycle/billing " +
  "imports example.com/cycle/orders from billing.go " +
  "imports example.com/cycle/billing from orders.go: import cycle not allowed";

const ALL_CAPTURES = [
  MULTI,
  IFACE,
  MISSING,
  GOMOD,
  CYCLE,
  TWO_PACKAGES,
  TEST_CYCLE,
  TEST_FILE,
  GO_VERSION,
  MOD_UPDATES,
  CYCLE_GO_WARNING,
];

/** Lines Go prints that are never a diagnostic, by the shape of the line. */
const HEADER = /^# /;
const GO_LINE = /^go: /;
const TEST_STATUS = /^(ok|\?|FAIL)(\s|$)/;

describe("go compile format — the hint selects it", () => {
  test("the hint `go` selects the go format for a go build capture", () => {
    expect(detectFormat(fixture(MULTI), "go")).toBe("go");
  });

  test("the alias hint `golang` selects the go format and the stored format reads `go`", () => {
    expect(detectFormat(fixture(MULTI), "golang")).toBe("go");
    expect(parseCompile(fixture(MULTI), "golang").format).toBe("go");
  });

  test("the hint `go` selects the go format even when the report holds no positioned diagnostic", () => {
    expect(detectFormat(fixture(CYCLE), "go")).toBe("go");
    expect(parseCompile(fixture(CYCLE), "go").format).toBe("go");
  });
});

describe("go compile format — real captures decode to exactly their diagnostics", () => {
  for (const [name, expected] of Object.entries(SINGLE_LINE_CAPTURES)) {
    test(`${name} hinted go decodes to one error record per diagnostic in terminal order`, () => {
      const input = fixture(name);
      const report = parseCompile(input, "go");
      expect(report.format).toBe("go");
      // toStrictEqual: no package, code or (for go.mod) column key on a record.
      expect(report.diagnostics).toStrictEqual(expected);
      expect(report.errorCount).toBe(expected.length);
      expect(report.warningCount).toBe(0);
      expect(report.raw).toBe(input);
    });

    test(`${name} hinted golang decodes the same as hinted go`, () => {
      const report = parseCompile(fixture(name), "golang");
      expect(report.format).toBe("go");
      expect(report.diagnostics).toStrictEqual(expected);
      expect(report.errorCount).toBe(expected.length);
    });
  }

  test("a multi-package build with more than ten errors in one package gives fourteen records, the `too many errors` line not among them", () => {
    const report = parseCompile(fixture(MULTI), "go");
    expect(report.diagnostics).toHaveLength(14);
    expect(report.errorCount).toBe(14);
    // Go prints its eleventh line for `store` as `store/store.go:13:6: too many errors`:
    // positioned like a diagnostic, yet not one.
    expect(report.diagnostics.filter((d) => d.message.includes("too many errors"))).toEqual([]);
    expect(report.diagnostics.filter((d) => d.file === "store/store.go")).toHaveLength(10);
    // Errors from the second and third packages are kept too.
    expect(report.diagnostics.filter((d) => d.file === "api/api.go")).toHaveLength(3);
    expect(report.diagnostics.filter((d) => d.file === "./main.go")).toHaveLength(1);
  });

  test("a go.mod error is a diagnostic with a line and no column", () => {
    const report = parseCompile(fixture(GOMOD), "go");
    expect(report.diagnostics).toHaveLength(1);
    const [only] = report.diagnostics;
    expect(only?.file).toBe("go.mod");
    expect(only?.line).toBe(5);
    expect(only !== undefined && "col" in only).toBe(false);
    expect(only?.message).toBe("unknown directive: bogus");
    expect(report.errorCount).toBe(1);
  });

  test("a test-file error under a `# pkg [pkg.test]` header is one record, the `?`, `ok` and `FAIL` lines none", () => {
    const report = parseCompile(fixture(TEST_FILE), "go");
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]?.file).toBe("ledger/ledger_test.go");
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
  });
});

describe("go compile format — tab-indented continuation lines join the diagnostic before them", () => {
  test("an interface mismatch's `have` and `want` lines land in its message, as one record", () => {
    const input = fixture(IFACE);
    const report = parseCompile(input, "go");
    expect(report.format).toBe("go");
    expect(report.diagnostics).toHaveLength(1);
    const [only] = report.diagnostics;
    expect(only?.file).toBe("shape/shape.go");
    expect(only?.line).toBe(11);
    expect(only?.col).toBe(14);
    expect(only?.level).toBe("error");
    expect(only?.message.startsWith(IFACE_HEAD)).toBe(true);
    expect(words(only?.message ?? "")).toBe(
      `${IFACE_HEAD} have Area() float64 want Area(int) float64`,
    );
    expect(only !== undefined && "code" in only).toBe(false);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.raw).toBe(input);
  });

  test("a missing module's `go get` hint lands in its message, as one record", () => {
    const report = parseCompile(fixture(MISSING), "go");
    expect(report.format).toBe("go");
    expect(report.diagnostics).toHaveLength(1);
    const [only] = report.diagnostics;
    expect(only?.file).toBe("main.go");
    expect(only?.line).toBe(3);
    expect(only?.col).toBe(8);
    expect(only?.level).toBe("error");
    expect(only?.message.startsWith(MISSING_HEAD)).toBe(true);
    expect(words(only?.message ?? "")).toBe(
      `${MISSING_HEAD} go get example.com/nowhere/widgets`,
    );
    expect(report.errorCount).toBe(1);
  });
});

describe("go compile format — headers, go:, ok, ?, FAIL and too-many-errors lines are never records", () => {
  for (const name of [MULTI, IFACE, MISSING, GOMOD, TEST_FILE]) {
    test(`${name}: no record is built from a header, go:, ok, ? or FAIL line`, () => {
      const report = parseCompile(fixture(name), "go");
      expect(report.format).toBe("go");
      for (const d of report.diagnostics) {
        expect(d.message).not.toMatch(HEADER);
        expect(d.message).not.toMatch(GO_LINE);
        expect(d.message).not.toMatch(TEST_STATUS);
        expect(d.file ?? "").not.toMatch(/^(#|go:|ok|\?|FAIL)/);
        expect(d.message).not.toContain("too many errors");
        expect(d.message).not.toContain("[build failed]");
      }
      // Every record is positioned: the header and status lines added none.
      expect(report.diagnostics.every((d) => typeof d.line === "number")).toBe(true);
      expect(report.errorCount).toBe(report.diagnostics.length);
    });
  }

  test("a `# [pkg]` header ahead of a diagnostic is not a record", () => {
    // Go prints the bracketed header for a package's test variant; the lines
    // below are the test-compile capture's diagnostic under both header shapes.
    const input = [
      "# example.com/books/ledger",
      "# [example.com/books/ledger]",
      "ledger/ledger_test.go:6:19: cannot use Balance() (value of type int) as string value in variable declaration",
      "",
    ].join("\n");
    const report = parseCompile(input, "go");
    expect(report.format).toBe("go");
    expect(report.diagnostics).toStrictEqual([
      goError(
        "ledger/ledger_test.go",
        6,
        19,
        "cannot use Balance() (value of type int) as string value in variable declaration",
      ),
    ]);
    expect(report.errorCount).toBe(1);
  });
});

describe("go compile format — a failure with no positioned diagnostic is one message-only error", () => {
  test("an import cycle from go build is ONE message-only error holding the cycle's lines, never clean", () => {
    const input = fixture(CYCLE);
    const report = parseCompile(input, "go");
    expect(report.format).toBe("go");
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.diagnostics).toHaveLength(1);
    const [only] = report.diagnostics;
    expect(only?.level).toBe("error");
    // Message-only: no position to point at.
    expect(only !== undefined && "file" in only).toBe(false);
    expect(only !== undefined && "line" in only).toBe(false);
    expect(only !== undefined && "col" in only).toBe(false);
    expect(words(only?.message ?? "")).toBe(CYCLE_WORDS);
    expect(report.raw).toBe(input);
  });

  test("an import cycle from the test compile keeps its non-header, non-FAIL lines and drops the headers and FAIL lines", () => {
    const report = parseCompile(fixture(TEST_CYCLE), "go");
    expect(report.format).toBe("go");
    expect(report.errorCount).toBe(1);
    expect(report.diagnostics).toHaveLength(1);
    const message = report.diagnostics[0]?.message ?? "";
    // Go reports the cycle once per package; both reports are lines of the
    // capture that are neither headers nor FAIL lines, so both stay.
    expect(words(message)).toBe(`${CYCLE_WORDS} ${CYCLE_WORDS}`);
    expect(message).not.toContain("# example.com");
    expect(message).not.toContain("FAIL");
    expect(message).not.toContain("[setup failed]");
  });

  test("two packages in one directory is ONE message-only error naming the directory, never clean", () => {
    const report = parseCompile(fixture(TWO_PACKAGES), "go");
    expect(report.format).toBe("go");
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.diagnostics).toHaveLength(1);
    const [only] = report.diagnostics;
    expect(only?.level).toBe("error");
    expect(only !== undefined && "file" in only).toBe(false);
    expect(words(only?.message ?? "")).toBe(
      "found packages inv (x.go) and stock (y.go) in /work/twopkg/inv",
    );
  });
});

describe("go compile format — a failure Go reports only on go: lines keeps those lines as its message", () => {
  test("a go.mod needing a newer Go is ONE message-only error whose message is its go: line, never empty", () => {
    const input = fixture(GO_VERSION);
    const report = parseCompile(input, "go");
    expect(report.format).toBe("go");
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.diagnostics).toHaveLength(1);
    const [only] = report.diagnostics;
    expect(only?.level).toBe("error");
    expect(only !== undefined && "file" in only).toBe(false);
    expect(only !== undefined && "line" in only).toBe(false);
    expect(only !== undefined && "col" in only).toBe(false);
    expect(words(only?.message ?? "")).not.toBe("");
    expect(words(only?.message ?? "")).toBe(
      "go: go.mod requires go >= 1.99 (running go 1.27.3; GOTOOLCHAIN=local)",
    );
    expect(report.raw).toBe(input);
  });

  test("a go.mod needing updates is ONE message-only error whose message holds the `go: updates to go.mod needed` line", () => {
    const report = parseCompile(fixture(MOD_UPDATES), "go");
    expect(report.format).toBe("go");
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.diagnostics).toHaveLength(1);
    const [only] = report.diagnostics;
    expect(only?.level).toBe("error");
    expect(only !== undefined && "file" in only).toBe(false);
    // The go: line leads the message; its tab-indented `go mod tidy` hint may follow it.
    expect(words(only?.message ?? "")).toMatch(
      /^go: updates to go\.mod needed; to update it:( go mod tidy)?$/,
    );
  });

  test("regression guard: an import cycle beside a go: warning line keeps only the cycle's lines as its message", () => {
    const report = parseCompile(fixture(CYCLE_GO_WARNING), "go");
    expect(report.format).toBe("go");
    expect(report.errorCount).toBe(1);
    expect(report.diagnostics).toHaveLength(1);
    const message = report.diagnostics[0]?.message ?? "";
    expect(words(message)).toBe(CYCLE_WORDS);
    expect(message).not.toContain("go: warning");
    expect(message).not.toContain("matched no packages");
  });
});

describe("go compile format — detection without a hint", () => {
  test("the multi-package build capture with no hint is detected as go", () => {
    expect(detectFormat(fixture(MULTI))).toBe("go");
    const report = parseCompile(fixture(MULTI));
    expect(report.format).toBe("go");
    expect(report.diagnostics).toStrictEqual(SINGLE_LINE_CAPTURES[MULTI]);
  });

  test("the interface-mismatch, missing-module and test-compile captures with no hint are detected as go", () => {
    expect(detectFormat(fixture(IFACE))).toBe("go");
    expect(detectFormat(fixture(MISSING))).toBe("go");
    expect(detectFormat(fixture(TEST_FILE))).toBe("go");
  });

  test("regression guard: a report with no `<file>.go:LINE:COL: ` line is not detected as go without a hint", () => {
    for (const name of [GOMOD, CYCLE, TWO_PACKAGES, TEST_CYCLE]) {
      expect(detectFormat(fixture(name))).not.toBe("go");
    }
  });

  test("regression guard: a gcc diagnostic on a `.go` path is still gcc — go is tried only after every existing format", () => {
    const gccShaped = "cgo/bridge.go:4:2: error: unknown type name 'size_t'\n";
    expect(detectFormat(gccShaped)).toBe("gcc");
    expect(parseCompile(gccShaped).format).toBe("gcc");
  });

  test("regression guard: a tsc, javac and rustc report keep their own format", () => {
    expect(detectFormat("src/a.ts(1,1): error TS2304: Cannot find name 'x'.")).toBe("tsc");
    expect(detectFormat("[ERROR] /p/A.java:[3,5] cannot find symbol")).toBe("javac");
    expect(
      detectFormat("error[E0425]: cannot find value `x` in this scope\n  --> src/main.rs:2:5\n"),
    ).toBe("rustc");
  });
});

describe("go compile format — Go prints no warnings", () => {
  for (const name of ALL_CAPTURES) {
    test(`${name} hinted go has warningCount 0, every record an error, and errorCount equal to its records`, () => {
      const report = parseCompile(fixture(name), "go");
      expect(report.format).toBe("go");
      expect(report.warningCount).toBe(0);
      expect(report.diagnostics.length).toBeGreaterThan(0);
      expect(report.diagnostics.every((d) => d.level === "error")).toBe(true);
      expect(report.errorCount).toBe(report.diagnostics.length);
    });
  }
});
