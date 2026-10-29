// bun's files that failed to load, read on the board — the reading itself.
//
// bun names a test file it could not load on its console only: a `<path>:`
// header, flush left, followed by one or more `# Unhandled error between
// tests` blocks, each the lines between two rules of dashes. The board reads
// that stream in its own module, `src/codecs/bun-console.ts` — the module
// that already reads bun's failure detail — by the rules the bun client
// applied to its console before the board took that reading over:
//
//  - a file header is a flush-left `<path>:` whose path ends in a JS/TS module
//    extension (.js .mjs .cjs .ts .mts .cts .jsx .tsx); any other flush-left
//    line (a test's own `results:`) is not one, and an `error:` line never is;
//  - every block under a header belongs to that file; a block before any
//    header belongs to no file and is dropped;
//  - one case per file: message = the first block's `error:` line without its
//    label (`unhandled error between tests` when no block has one), cut at
//    1000; trace = every block for that file, each block's lines joined by
//    "\n" and the blocks by "\n\n", trimmed, cut at 8000;
//  - both wire forms are read, and everything kept is stripped of SGR escapes.
//
// EXPORT ASSUMED: `parseBunLoadErrors(consoleText: string)` returning a plain
// object keyed by file path, in the order bun named the files, each value
// `{message, trace?}` — the failure of the one `?` case the client files for
// that path (the shape CLIENT_LOAD_ERROR_READING freezes). The junit codec's
// `readRaw` path is what turns that reading into stored cases; the route test
// (tests/bun-load-errors-are-read-on-the-board.test.ts) pins that.
import { describe, test, expect } from "bun:test";
import { parseBunLoadErrors } from "../src/codecs/bun-console.ts";
import {
  CLIENT_LOAD_ERROR_READING,
  CONSOLE_LINE,
  FOUR_FILES,
  LOAD_ERROR_WIRES,
  RAN_THEN_REJECTED,
  TWO_BLOCKS,
} from "./fixtures/bun-load-error-captures.ts";
import type { LoadErrorCase, LoadErrorRun } from "./fixtures/bun-load-error-captures.ts";
import type { WireForm } from "./fixtures/bun-console-captures.ts";
import * as captures from "./fixtures/bun-load-error-captures.ts";

function read(text: string): Record<string, LoadErrorCase> {
  return parseBunLoadErrors(text) as Record<string, LoadErrorCase>;
}

// ── The client's reading, capture for capture ───────────────────────────────

describe("the board reads every frozen bun load-error capture exactly as the bun client read it", () => {
  for (const [key, expected] of Object.entries(CLIENT_LOAD_ERROR_READING)) {
    const [name, wire] = key.split("/") as [string, WireForm];
    test(`${name} in its ${wire} wire form`, () => {
      const capture = (captures as unknown as Record<string, LoadErrorRun>)[name]!;
      const reading = read(capture[wire]);
      expect(reading).toEqual(expected);
      // The files in bun's order, and nothing kept escaped.
      expect(Object.keys(reading)).toEqual(Object.keys(expected));
      expect(JSON.stringify(reading)).not.toContain("\\u001b");
    });
  }

  for (const wire of LOAD_ERROR_WIRES) {
    test(`a missing import, a throw at import and a rejection at import are three files, each its own message without the error: label (${wire})`, () => {
      const reading = read(FOUR_FILES[wire]);
      expect(Object.keys(reading)).toEqual([
        "b_imports_a_missing_module.test.ts",
        "c_throws_at_import.test.ts",
        "d_rejects_at_import.test.ts",
      ]);
      expect(reading["b_imports_a_missing_module.test.ts"]?.message).toBe(
        "Cannot find module './does-not-exist' from '/tmp/bun-fixture/b_imports_a_missing_module.test.ts'",
      );
      expect(reading["c_throws_at_import.test.ts"]?.message).toBe("boom at import");
      expect(reading["d_rejects_at_import.test.ts"]?.message).toBe("rejected at import");
      expect(reading["c_throws_at_import.test.ts"]?.trace).not.toContain("rejected at import");
      expect(reading["d_rejects_at_import.test.ts"]?.trace).not.toContain("boom at import");
      // The passing file, which printed no block, is not read.
      expect(reading["a_passes.test.ts"]).toBeUndefined();
    });

    test(`two blocks under one header are one entry: the first block's error line, both blocks in the trace joined by a blank line (${wire})`, () => {
      const reading = read(TWO_BLOCKS[wire]);
      expect(Object.keys(reading)).toEqual(["e_two_error_blocks.test.ts"]);
      const entry = reading["e_two_error_blocks.test.ts"]!;
      expect(entry.message).toBe("first block");
      const [first, second, ...rest] = entry.trace!.split("\n\n");
      expect(rest).toEqual([]);
      expect(first!.endsWith("error: first block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:2:20")).toBe(true);
      expect(second!.endsWith("error: second block\n      at /tmp/bun-fixture/e_two_error_blocks.test.ts:3:20")).toBe(true);
    });

    test(`a file whose test ran before it rejected is read under its own header, the passing result line notwithstanding (${wire})`, () => {
      const reading = read(RAN_THEN_REJECTED[wire]);
      expect(Object.keys(reading)).toEqual(["f_ran_then_rejected.test.ts"]);
      expect(reading["f_ran_then_rejected.test.ts"]?.message).toBe("rejected after its test ran");
    });

    test(`a test's own flush-left results: line is not a file header: the block after it stays with the file under whose header it printed (${wire})`, () => {
      expect(CONSOLE_LINE[wire].replace(/\u001b\[[0-9;]*m/g, "").split("\n")).toContain("results:");
      const reading = read(CONSOLE_LINE[wire]);
      expect(Object.keys(reading)).toEqual(["g_logs_then_rejected.test.ts", "h_logs_then_throws_at_import.test.ts"]);
      expect(reading["results"]).toBeUndefined();
      expect(reading["results:"]).toBeUndefined();
      expect(reading["g_logs_then_rejected.test.ts"]?.message).toBe("rejected after the log");
      expect(reading["h_logs_then_throws_at_import.test.ts"]?.message).toBe("boom after a console line");
      expect(reading["h_logs_then_throws_at_import.test.ts"]?.trace).not.toContain("rejected after the log");
    });
  }
});

// ── Shapes the real runs do not show ────────────────────────────────────────

const MARKER: Record<WireForm, string> = {
  plain: "# Unhandled error between tests",
  ansi: "\u001b[1m\u001b[2m#\u001b[0m \u001b[31m\u001b[1mUnhandled error\u001b[0m\u001b[2m between tests\u001b[0m",
};
const RULE: Record<WireForm, string> = {
  plain: "-------------------------------",
  ansi: "\u001b[2m-------------------------------\u001b[0m",
};

function errorLine(wire: WireForm, text: string): string {
  return wire === "ansi" ? `\u001b[31merror\u001b[0m\u001b[2m:\u001b[0m \u001b[1m${text}\u001b[0m` : `error: ${text}`;
}

function block(wire: WireForm, lines: string[]): string {
  return [MARKER[wire], RULE[wire], ...lines, RULE[wire], "", ""].join("\n");
}

function banner(wire: WireForm): string {
  return `${FOUR_FILES[wire].split("\n")[0]}\n\n`;
}

describe("the reading's rules on shapes the real runs do not show", () => {
  for (const wire of LOAD_ERROR_WIRES) {
    test(`a block before any file header is attributed to no file (${wire})`, () => {
      const text = `${banner(wire)}${block(wire, [errorLine(wire, "orphan boom")])}z.test.ts:\n\n${block(wire, [errorLine(wire, "zed boom")])}`;
      const reading = read(text);
      expect(reading).toEqual({ "z.test.ts": { message: "zed boom", trace: "error: zed boom" } });
    });

    test(`a console with no unhandled-error block reads as no file at all, whatever headers it shows (${wire})`, () => {
      const text = `${banner(wire)}a.test.ts:\n(pass) passes [0.02ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [2.00ms]\n`;
      expect(read(text)).toEqual({});
    });

    test(`a block with no error: line takes the fallback message and keeps the block as its trace (${wire})`, () => {
      const text = `${banner(wire)}x.test.ts:\n\n${block(wire, ["1 | something went wrong", "              ^"])}`;
      expect(read(text)).toEqual({
        "x.test.ts": { message: "unhandled error between tests", trace: "1 | something went wrong\n              ^" },
      });
    });

    test(`the message is cut at 1000 characters and the trace at 8000 (${wire})`, () => {
      const long = "M".repeat(1500);
      const filler = Array.from({ length: 200 }, (_, i) => `      at frame${i} (/tmp/bun-fixture/y.test.ts:${i}:1)`);
      const text = `${banner(wire)}y.test.ts:\n\n${block(wire, [errorLine(wire, long), ...filler])}`;
      const entry = read(text)["y.test.ts"]!;
      expect(entry.message).toBe("M".repeat(1000));
      expect(entry.trace?.length).toBe(8000);
      expect(entry.trace?.startsWith(`error: ${long}\n      at frame0`)).toBe(true);
    });

    test(`every JS/TS module extension makes a header; other flush-left lines, and an error: line, never do (${wire})`, () => {
      const modules = ["m1.js", "m2.mjs", "m3.cjs", "m4.ts", "m5.mts", "m6.cts", "m7.jsx", "m8.tsx", "sub/dir/m9.test.ts"];
      let text = banner(wire);
      for (const m of modules) text += `${m}:\n\n${block(wire, [errorLine(wire, `boom in ${m}`)])}`;
      const notHeaders = ["results:", "notes.md:", "data.json:", "error: looks.like.a.path.ts:"];
      for (const line of notHeaders) text += `${line}\n\n${block(wire, [errorLine(wire, `boom under ${line}`)])}`;
      const reading = read(text);
      expect(Object.keys(reading)).toEqual(modules);
      for (const m of modules.slice(0, -1)) {
        expect(reading[m]).toEqual({ message: `boom in ${m}`, trace: `error: boom in ${m}` });
      }
      expect(reading["sub/dir/m9.test.ts"]).toEqual({
        message: "boom in sub/dir/m9.test.ts",
        trace: ["error: boom in sub/dir/m9.test.ts", ...notHeaders.map((line) => `error: boom under ${line}`)].join("\n\n"),
      });
    });

    test(`a second header for a file already read appends its blocks to that file's one entry (${wire})`, () => {
      const text =
        `${banner(wire)}r.test.ts:\n\n${block(wire, [errorLine(wire, "first visit")])}` +
        `s.test.ts:\n\n${block(wire, [errorLine(wire, "s boom")])}` +
        `r.test.ts:\n\n${block(wire, [errorLine(wire, "second visit")])}`;
      const reading = read(text);
      expect(Object.keys(reading)).toEqual(["r.test.ts", "s.test.ts"]);
      expect(reading["r.test.ts"]).toEqual({
        message: "first visit",
        trace: "error: first visit\n\nerror: second visit",
      });
    });
  }

  test("an empty console reads as no file", () => {
    expect(read("")).toEqual({});
  });
});
