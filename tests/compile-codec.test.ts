// CR-CRU-002 §S2 — Compile codecs (parseCompile / detectFormat)
import { describe, test, expect } from "bun:test";
import { parseCompile, detectFormat } from "../src/codecs/compile.ts";

// AC — rustc fixture: error[EXXXX] block with location, plus a plain warning block.
describe("parseCompile — rustc format (AC4)", () => {
  const RUSTC_FIXTURE = [
    "error[E0308]: mismatched types",
    " --> src/lib.rs:12:5",
    "warning: unused import",
    " --> src/a.rs:1:1",
  ].join("\n");

  test("counts one error and one warning, with exact first-diagnostic shape", () => {
    const report = parseCompile(RUSTC_FIXTURE);

    expect(report.format).toBe("rustc");
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(1);
    expect(report.diagnostics[0]).toEqual({
      file: "src/lib.rs",
      line: 12,
      col: 5,
      code: "E0308",
      level: "error",
      message: "mismatched types",
    });
  });

  test("second diagnostic is the warning block with its own location", () => {
    const report = parseCompile(RUSTC_FIXTURE);

    expect(report.diagnostics[1]).toMatchObject({
      file: "src/a.rs",
      line: 1,
      col: 1,
      level: "warning",
      message: "unused import",
    });
  });

  test("raw carries the exact original input text", () => {
    const report = parseCompile(RUSTC_FIXTURE);
    expect(report.raw).toBe(RUSTC_FIXTURE);
  });
});

// AC — javac fixture: [ERROR] /path/File.java:[line,col] message, auto-detected (no hint).
describe("parseCompile — javac format, auto-detected (AC5)", () => {
  const JAVAC_FIXTURE = "[ERROR] /x/Foo.java:[42,13] cannot find symbol";

  test("auto-detects javac format without a hint", () => {
    const report = parseCompile(JAVAC_FIXTURE);
    expect(report.format).toBe("javac");
  });

  test("produces exact diagnostic shape for the [ERROR] line", () => {
    const report = parseCompile(JAVAC_FIXTURE);

    expect(report.diagnostics[0]).toEqual({
      file: "/x/Foo.java",
      line: 42,
      col: 13,
      level: "error",
      message: "cannot find symbol",
    });
  });
});

// AC — python traceback: two "File ..., line N" frames, ending in an ImportError line.
describe("parseCompile — python traceback format (AC6)", () => {
  const PYTHON_FIXTURE = [
    "Traceback (most recent call last):",
    '  File "main.py", line 10, in <module>',
    "    import foo",
    '  File "foo.py", line 3, in <module>',
    "    import y",
    "ImportError: no module named y",
  ].join("\n");

  test("auto-detects python format without a hint", () => {
    const report = parseCompile(PYTHON_FIXTURE);
    expect(report.format).toBe("python");
  });

  test("yields exactly 1 error diagnostic whose message is the ImportError line", () => {
    const report = parseCompile(PYTHON_FIXTURE);

    const errorDiagnostics = report.diagnostics.filter((d: { level: string }) => d.level === "error");
    expect(errorDiagnostics.length).toBe(1);
    expect(errorDiagnostics[0].message).toBe("ImportError: no module named y");
  });

  test("file/line are taken from the LAST traceback frame, not the first", () => {
    const report = parseCompile(PYTHON_FIXTURE);

    expect(report.diagnostics[0].file).toBe("foo.py");
    expect(report.diagnostics[0].line).toBe(3);
  });
});

// AC — tsc fixture: file.ts(line,col): error TSnnnn: message
describe("parseCompile — tsc format (AC7)", () => {
  const TSC_FIXTURE = "src/x.ts(12,5): error TS2304: Cannot find name 'y'.";

  test("produces exact location + code fields for the tsc diagnostic", () => {
    const report = parseCompile(TSC_FIXTURE);

    expect(report.format).toBe("tsc");
    expect(report.diagnostics[0]).toMatchObject({
      file: "src/x.ts",
      line: 12,
      col: 5,
      code: "TS2304",
      level: "error",
    });
  });
});

// AC — detectFormat hint aliases (rust/java/maven/py/ts/typescript)
describe("detectFormat — hint aliases (AC8)", () => {
  test("'rust' hint aliases to 'rustc' regardless of content", () => {
    expect(detectFormat("anything", "rust")).toBe("rustc");
  });

  test("'java' hint aliases to 'javac'", () => {
    expect(detectFormat("x", "java")).toBe("javac");
  });

  test("'maven' hint aliases to 'javac'", () => {
    expect(detectFormat("x", "maven")).toBe("javac");
  });

  test("'py' hint aliases to 'python'", () => {
    expect(detectFormat("x", "py")).toBe("python");
  });

  test("'ts' hint aliases to 'tsc'", () => {
    expect(detectFormat("x", "ts")).toBe("tsc");
  });

  test("'typescript' hint aliases to 'tsc'", () => {
    expect(detectFormat("x", "typescript")).toBe("tsc");
  });
});

// AC — raw fallback never rejects on unrecognized input.
describe("parseCompile — raw fallback never rejects (AC9)", () => {
  test("unrecognized garbage input yields format 'raw' with no diagnostics, without throwing", () => {
    expect(() => parseCompile("total garbage ✈")).not.toThrow();

    const report = parseCompile("total garbage ✈");
    expect(report.format).toBe("raw");
    expect(report.diagnostics).toEqual([]);
  });

  test("errorCount and warningCount are non-negative numbers derived from conventional markers", () => {
    const report = parseCompile("total garbage ✈");

    expect(typeof report.errorCount).toBe("number");
    expect(typeof report.warningCount).toBe("number");
    expect(report.errorCount).toBeGreaterThanOrEqual(0);
    expect(report.warningCount).toBeGreaterThanOrEqual(0);
  });
});

// AC — rustc "error: " (no code) lines count as errors; a "generated N warnings" summary
// line does NOT produce its own diagnostic.
describe("parseCompile — rustc no-code errors + summary-line exclusion (AC10)", () => {
  const RUSTC_NO_CODE_FIXTURE = [
    "error: mismatched types",
    " --> src/main.rs:5:1",
    'warning: `mycrate` (bin "mycrate") generated 2 warnings',
  ].join("\n");

  test("'error: msg' (no [EXXXX] code) still counts as an error diagnostic", () => {
    const report = parseCompile(RUSTC_NO_CODE_FIXTURE);

    expect(report.errorCount).toBe(1);
    expect(report.diagnostics[0]).toMatchObject({
      file: "src/main.rs",
      line: 5,
      col: 1,
      level: "error",
      message: "mismatched types",
    });
    expect(report.diagnostics[0].code).toBeUndefined();
  });

  test("a 'generated N warnings' summary line does not add its own diagnostic", () => {
    const report = parseCompile(RUSTC_NO_CODE_FIXTURE);

    // Only the single "error: mismatched types" diagnostic should exist —
    // the trailing summary line must not become a second (warning) diagnostic.
    expect(report.diagnostics.length).toBe(1);
    expect(
      report.diagnostics.some(
        (d: { message: string }) => d.message.includes("generated") && d.message.includes("warnings"),
      ),
    ).toBe(false);
  });
});
