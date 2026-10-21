// The `gcc` compile codec — GCC/g++ diagnostics as the arduino stack's
// `arduino-cli compile` gate reports them, decoded by `parseCompile` and
// detected/selected by `detectFormat` (both in src/codecs/compile.ts).
//
// The inputs are the real arduino-cli failures checked in under
// tests/fixtures/arduino-cli/ (see its README): terminal order, ANSI
// stripped, paths neutralised. On the wire the client sends stdout then
// stderr, so arduino-cli's `Used platform` table arrives FIRST — every
// fixture is decoded in both orders and must give the same result.
//
// Tests labelled "regression guard" pass today on purpose: they pin
// behaviour the new codec must not move.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectFormat, parseCompile } from "../src/codecs/compile.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "arduino-cli");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

// The client's wire order: arduino-cli's `Used platform` table (stdout) moved
// ahead of everything else (stderr), each part otherwise kept as it is.
const PLATFORM_ROW = /^\S+:\S+\s+\S+\s+\//;
function inWireOrder(text: string): string {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.startsWith("Used platform"));
  if (head < 0) throw new Error("fixture has no Used platform table to reorder");
  let end = head + 1;
  while (end < lines.length && PLATFORM_ROW.test(lines[end] ?? "")) end++;
  const table = lines.slice(head, end);
  const rest = [...lines.slice(0, head), ...lines.slice(end)];
  return [...table, ...rest].join("\n");
}

type Diagnostic = {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: "error" | "warning";
};

const HIGHT_ERROR: Diagnostic = {
  file: "/sketch/pump/valve.cpp",
  line: 5,
  col: 21,
  level: "error",
  message: "'HIGHT' was not declared in this scope",
};
const SENSR_ERROR: Diagnostic = {
  file: "/sketch/pump/pump.ino",
  line: 5,
  col: 10,
  level: "error",
  message: "'sensr' was not declared in this scope",
};
const UNUSED_WARNING: Diagnostic = {
  file: "/sketch/pump/pump.ino",
  line: 4,
  col: 7,
  level: "warning",
  message: "unused variable 'x'",
  code: "-Wunused-variable",
};
const PARENS_WARNING: Diagnostic = {
  file: "/sketch/pump/pump.ino",
  line: 15,
  col: 13,
  level: "warning",
  message: "suggest parentheses around assignment used as truth value",
  code: "-Wparentheses",
};

type Expected = { errorCount: number; warningCount: number; diagnostics: Diagnostic[] };

const DECODED_FIXTURES: Record<string, Expected> = {
  "avr-uno-warnings-all.txt": {
    errorCount: 2,
    warningCount: 2,
    diagnostics: [HIGHT_ERROR, SENSR_ERROR, UNUSED_WARNING, PARENS_WARNING],
  },
  "renesas-uno-minima-default.txt": {
    errorCount: 2,
    warningCount: 0,
    diagnostics: [HIGHT_ERROR, SENSR_ERROR],
  },
  "avr-uno-missing-header.txt": {
    errorCount: 1,
    warningCount: 0,
    diagnostics: [
      {
        file: "/sketch/hdr/hdr.ino",
        line: 1,
        col: 10,
        level: "error",
        message: "missing.h: No such file or directory",
      },
    ],
  },
  "avr-uno-undefined-reference.txt": {
    errorCount: 1,
    warningCount: 0,
    diagnostics: [
      {
        file: "/sketch/lnk/lnk.ino",
        line: 2,
        level: "error",
        message: "undefined reference to `pumpOn()'",
      },
    ],
  },
  "esp32-undefined-reference.txt": {
    errorCount: 1,
    warningCount: 0,
    diagnostics: [
      {
        file: "/sketch/lnk/lnk.ino",
        line: 2,
        level: "error",
        message: "undefined reference to `_Z6pumpOnv'",
      },
    ],
  },
};

const DECODED_NAMES = Object.keys(DECODED_FIXTURES);

function expectDecoded(input: string, hint: string | undefined, expected: Expected): void {
  const report = parseCompile(input, hint);
  expect(report.format).toBe("gcc");
  // toStrictEqual: a diagnostic with no code or column carries NO such key.
  expect(report.diagnostics).toStrictEqual(expected.diagnostics);
  expect(report.errorCount).toBe(expected.errorCount);
  expect(report.warningCount).toBe(expected.warningCount);
  expect(report.raw).toBe(input);
}

describe("gcc codec — real arduino-cli failures decode", () => {
  for (const name of DECODED_NAMES) {
    const expected = DECODED_FIXTURES[name] as Expected;

    test(`${name} hinted gcc decodes to exactly its compiler diagnostics in terminal order`, () => {
      expectDecoded(fixture(name), "gcc", expected);
    });

    test(`${name} hinted gcc decodes to the same diagnostics in the client's wire order (platform table first)`, () => {
      const wire = inWireOrder(fixture(name));
      expect(wire.startsWith("Used platform")).toBe(true);
      expectDecoded(wire, "gcc", expected);
    });
  }

  test("platform-not-installed.txt hinted gcc — no compiler ran — stays raw with word-scan counts", () => {
    const input = fixture("platform-not-installed.txt");
    const report = parseCompile(input, "gcc");
    expect(report.format).toBe("raw");
    expect(report.diagnostics).toEqual([]);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
    expect(report.raw).toBe(input);
  });

  test("a note line, its excerpt and its fix-it line are not diagnostics of their own", () => {
    const report = parseCompile(fixture("renesas-uno-minima-default.txt"), "gcc");
    expect(report.format).toBe("gcc");
    expect(report.diagnostics.some((d) => d.message.includes("suggested alternative"))).toBe(false);
    expect(report.diagnostics.length).toBe(2);
  });

  test("the collect2 trailer and arduino-cli's build-status line are not diagnostics", () => {
    const report = parseCompile(fixture("avr-uno-undefined-reference.txt"), "gcc");
    expect(report.format).toBe("gcc");
    expect(report.diagnostics.some((d) => d.message.includes("ld returned"))).toBe(false);
    expect(report.diagnostics.some((d) => d.message.includes("exit status"))).toBe(false);
    expect(report.diagnostics.length).toBe(1);
  });
});

describe("gcc codec — object-only link errors", () => {
  const ESP32_LINES = fixture("esp32-undefined-reference.txt").split("\n");
  const OBJECT_ONLY_LINES = ESP32_LINES.filter(
    (l) => l.includes("undefined reference to") && l.includes(".o:("),
  );
  const ESP32_SYMBOL = "undefined reference to `_Z6pumpOnv'";

  test("the esp32 fixture's object-only undefined-reference line alone decodes to one error with no file or line", () => {
    expect(OBJECT_ONLY_LINES.length).toBe(1);
    const input = OBJECT_ONLY_LINES.join("\n");
    const report = parseCompile(input, "gcc");
    expect(report.format).toBe("gcc");
    expect(report.diagnostics).toStrictEqual([{ level: "error", message: ESP32_SYMBOL }]);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
  });

  test("two object-only undefined-reference lines decode to one error per line, each with no file or line", () => {
    const input = [
      ...OBJECT_ONLY_LINES,
      "/usr/bin/ld: main.o:(.text+0x5): undefined reference to `foo'",
    ].join("\n");
    const report = parseCompile(input, "gcc");
    expect(report.format).toBe("gcc");
    expect(report.diagnostics).toStrictEqual([
      { level: "error", message: ESP32_SYMBOL },
      { level: "error", message: "undefined reference to `foo'" },
    ]);
    expect(report.errorCount).toBe(2);
    expect(report.warningCount).toBe(0);
  });

  test("the esp32 report with its sourced link line removed decodes to its one object-only error (in-function line is context)", () => {
    const input = ESP32_LINES.filter((l) => !l.startsWith("/sketch/lnk/lnk.ino:")).join("\n");
    const report = parseCompile(input, "gcc");
    expect(report.format).toBe("gcc");
    expect(report.diagnostics).toStrictEqual([{ level: "error", message: ESP32_SYMBOL }]);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
  });
});

describe("gcc codec — never clean when the build failed", () => {
  // Only the two warning diagnostics of the warnings-all fixture, with their excerpts.
  const WARNINGS_ONLY = [
    "/sketch/pump/pump.ino:4:7: warning: unused variable 'x' [-Wunused-variable]",
    "   int x = 3;",
    "       ^",
    "/sketch/pump/pump.ino:15:13: warning: suggest parentheses around assignment used as truth value [-Wparentheses]",
    "   if (level = 4) {",
    "       ~~~~~~^~~",
  ].join("\n");

  for (const hint of ["gcc", undefined]) {
    test(`a warnings-only gcc report ${hint ? "hinted gcc" : "unhinted"} falls back to raw with word-scan counts`, () => {
      const report = parseCompile(WARNINGS_ONLY, hint);
      expect(report.format).toBe("raw");
      expect(report.diagnostics).toEqual([]);
      expect(report.errorCount).toBe(0);
      expect(report.warningCount).toBe(2);
      expect(report.raw).toBe(WARNINGS_ONLY);
    });
  }

  test("the same two warnings beside one error decode as gcc — the fallback is driven by the missing error", () => {
    const input = [
      "/sketch/pump/pump.ino:5:10: error: 'sensr' was not declared in this scope",
      WARNINGS_ONLY,
    ].join("\n");
    const report = parseCompile(input, "gcc");
    expect(report.format).toBe("gcc");
    expect(report.diagnostics).toStrictEqual([SENSR_ERROR, UNUSED_WARNING, PARENS_WARNING]);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(2);
  });

  test("platform-not-installed.txt unhinted — nothing recognised — is raw with word-scan counts", () => {
    const input = fixture("platform-not-installed.txt");
    expect(detectFormat(input)).toBe("raw");
    const report = parseCompile(input);
    expect(report.format).toBe("raw");
    expect(report.diagnostics).toEqual([]);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(0);
  });
});

describe("gcc codec — detected and hinted", () => {
  for (const name of DECODED_NAMES) {
    test(`${name} is detected as gcc with no hint`, () => {
      expect(detectFormat(fixture(name))).toBe("gcc");
      expect(parseCompile(fixture(name)).format).toBe("gcc");
    });

    test(`${name} in wire order is detected as gcc with no hint`, () => {
      expect(detectFormat(inWireOrder(fixture(name)))).toBe("gcc");
    });

    for (const hint of ["gcc", "g++", "arduino"]) {
      test(`${name} is selected as gcc by the hint '${hint}'`, () => {
        expect(detectFormat(fixture(name), hint)).toBe("gcc");
      });
    }
  }

  for (const hint of ["gcc", "g++", "arduino"]) {
    test(`the hint '${hint}' selects gcc regardless of content, as the existing aliases do`, () => {
      expect(detectFormat("anything", hint)).toBe("gcc");
    });
  }

  for (const hint of ["GCC", "G++", "Arduino", "ARDUINO"]) {
    test(`the hint '${hint}' selects gcc case-insensitively`, () => {
      expect(detectFormat("anything", hint)).toBe("gcc");
      expectDecoded(fixture("renesas-uno-minima-default.txt"), hint, DECODED_FIXTURES[
        "renesas-uno-minima-default.txt"
      ] as Expected);
    });
  }

  test("an unhinted diagnostic whose file path contains spaces decodes with the full path", () => {
    const input = "/home/user/My Documents/Arduino/pump/pump.ino:5:10: error: 'sensr' was not declared in this scope";
    const expected: Diagnostic = {
      file: "/home/user/My Documents/Arduino/pump/pump.ino",
      line: 5,
      col: 10,
      level: "error",
      message: "'sensr' was not declared in this scope",
    };
    expect(detectFormat(input)).toBe("gcc");
    expect(parseCompile(input).diagnostics).toStrictEqual([expected]);
    expect(parseCompile(input, "gcc").diagnostics).toStrictEqual([expected]);
  });
});

describe("gcc codec — nothing else moves (regression guard: passes today)", () => {
  // The inputs the existing compile-codec tests use, copied verbatim.
  const EXISTING: Array<[string, string, string]> = [
    [
      "rustc",
      "rustc",
      ["error[E0308]: mismatched types", " --> src/lib.rs:12:5", "warning: unused import", " --> src/a.rs:1:1"].join(
        "\n",
      ),
    ],
    [
      "rustc no-code",
      "rustc",
      [
        "error: mismatched types",
        " --> src/main.rs:5:1",
        'warning: `mycrate` (bin "mycrate") generated 2 warnings',
      ].join("\n"),
    ],
    ["javac", "javac", "[ERROR] /x/Foo.java:[42,13] cannot find symbol"],
    [
      "python",
      "python",
      [
        "Traceback (most recent call last):",
        '  File "main.py", line 10, in <module>',
        "    import foo",
        '  File "foo.py", line 3, in <module>',
        "    import y",
        "ImportError: no module named y",
      ].join("\n"),
    ],
    ["tsc", "tsc", "src/x.ts(12,5): error TS2304: Cannot find name 'y'."],
  ];

  for (const [label, format, input] of EXISTING) {
    test(`regression guard: the existing ${label} input keeps format ${format} with no hint`, () => {
      expect(detectFormat(input)).toBe(format);
      expect(parseCompile(input).format).toBe(format);
    });
  }

  const STAY_RAW: Array<[string, string]> = [
    ["tsc --pretty output", "src/a.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'."],
    [
      "an unhinted rustc link failure",
      "  = note: /usr/bin/ld: main.o: in function `main':\n          main.c:(.text+0x5): undefined reference to `foo'",
    ],
    ["a maven-prefixed scala error", "[ERROR] /p/A.scala:10:5: error: not found: value x"],
    [
      "a cargo build-script warning",
      "warning: x@0.1.0: src/c/a.c:1:1: warning: unused variable 'y' [-Wunused-variable]",
    ],
  ];

  for (const [label, input] of STAY_RAW) {
    test(`regression guard: ${label} stays raw with no hint`, () => {
      expect(detectFormat(input)).toBe("raw");
      const report = parseCompile(input);
      expect(report.format).toBe("raw");
      expect(report.diagnostics).toEqual([]);
    });
  }
});

describe("gcc codec — raw stays raw (regression guard: passes today)", () => {
  for (const hint of [undefined, "gcc"]) {
    test(`regression guard: unrecognised input ${hint ? "hinted gcc" : "unhinted"} falls back to raw without throwing`, () => {
      expect(() => parseCompile("total garbage ✈", hint)).not.toThrow();
      const report = parseCompile("total garbage ✈", hint);
      expect(report.format).toBe("raw");
      expect(report.diagnostics).toEqual([]);
      expect(report.errorCount).toBe(0);
      expect(report.warningCount).toBe(0);
      expect(report.raw).toBe("total garbage ✈");
    });
  }

  test("regression guard: empty input hinted gcc falls back to raw without throwing", () => {
    expect(() => parseCompile("", "gcc")).not.toThrow();
    expect(parseCompile("", "gcc").format).toBe("raw");
  });
});

describe("gcc codec — the record names it", () => {
  const GCC = /\bgcc\b/;

  test("the compile codec module's header comment names gcc", () => {
    const source = readFileSync(join(REPO_ROOT, "src", "codecs", "compile.ts"), "utf8");
    const header: string[] = [];
    for (const line of source.split("\n")) {
      if (!line.startsWith("//")) break;
      header.push(line);
    }
    expect(header.length).toBeGreaterThan(0);
    expect(header.join("\n")).toMatch(GCC);
  });

  const PRD = readFileSync(join(REPO_ROOT, "docs", "research", "PRD-crucible-v2.md"), "utf8");

  function section(startHeading: string, nextHeading: string): string {
    const start = PRD.indexOf(startHeading);
    expect(start).toBeGreaterThan(-1);
    const end = PRD.indexOf(nextHeading, start + startHeading.length);
    expect(end).toBeGreaterThan(start);
    return PRD.slice(start, end);
  }

  test("the PRD's event `codec` values name gcc", () => {
    const rows = PRD.split("\n").filter((l) => l.startsWith("| `codec` |"));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatch(GCC);
  });

  test("the PRD's /api/ingest/compile format list names gcc", () => {
    const anchor = "- `/api/ingest/compile` `format` is optional";
    const start = PRD.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const after = PRD.slice(start + anchor.length);
    const endRel = after.search(/\n(?:- |\n|#)/);
    const bullet = anchor + (endRel < 0 ? after : after.slice(0, endRel));
    expect(bullet).toMatch(GCC);
  });

  test("the PRD's test-ingest codec section names gcc", () => {
    expect(section("### 4.4 ", "### 4.5 ")).toMatch(GCC);
  });

  test("the PRD's compile-ingest section names gcc among its structured parsers", () => {
    expect(section("### 4.5 ", "### 4.6 ")).toMatch(GCC);
  });
});
