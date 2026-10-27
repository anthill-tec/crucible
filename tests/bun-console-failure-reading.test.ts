// bun's console failure detail, read on the board — the reading itself.
//
// bun's JUnit reporter writes a bare `<failure type="…"/>` for every failure
// kind; the human detail exists only on its console stream, as an `error:`
// block under a source echo of the code that raised. The board reads that
// stream in its own module, `src/codecs/bun-console.ts`, by the rules the bun
// client applies today (`_parse_console_failures` in clients/bun-crucible.py):
//
//  - a block marries the result line that follows it, and only when the
//    echo's last test declaration at or above the caret names that line's
//    last " > " segment — or the echo names no test it can read (no
//    declaration, `test.each`, a variable, a split declaration, an
//    interpolated template, an escaped quote), when position decides;
//  - a block whose echo names another test is that test's aftermath and
//    marries no one;
//  - a pass, skip or todo result line ends a pending block, and detail printed
//    after its own result line (a timeout's) stays unmatched;
//  - a second `error:` under one echo window marries positionally;
//  - both wire forms (plain `(fail)` and ANSI `✗`) are read, everything kept
//    is stripped of SGR escapes, and each married block is indexed under the
//    composed result-line name and its last segment;
//  - message is the `error:` line's text cut at 1000 characters, trace the
//    block's lines joined by "\n", trailing whitespace dropped, cut at 8000.
//
// EXPORT ASSUMED: `parseBunConsoleFailures(consoleText: string)` returning a
// plain object keyed by result-line name, each value `{message, trace?}` —
// the shape `_parse_console_failures` returns. Every capture and the client's
// own reading of it come from tests/fixtures/bun-console-captures.ts.
import { describe, test, expect } from "bun:test";
import { parseBunConsoleFailures } from "../src/codecs/bun-console.ts";
import {
  AFTERMATH_BLEED,
  BOUNDARY_ENDS_BLOCK,
  CLIENT_READING,
  DETAIL_AFTER_FAIL_LINE,
  DETAIL_BEFORE_FAIL_LINE,
  EACH_IT,
  EACH_TEST,
  ECHOLESS_HELPER,
  ESCAPED_QUOTE,
  LEAK_MULTILINE,
  LEAK_NESTED,
  LEAK_ONELINER,
  LEGIT_CONSECUTIVE,
  LEGIT_NESTED,
  LONG_DETAIL,
  NESTED_RESULT_LINE,
  REAL_LEAKED_ASYNC_ERROR,
  SECOND_ERROR_ONE_WINDOW,
  SPLIT_DECL,
  TEMPLATE_NAME,
  TIMEOUT_DETAIL_AFTER_FAIL,
  TIMEOUT_DETAIL_BEFORE_FAIL,
  VARIABLE_NAME,
} from "./fixtures/bun-console-captures.ts";
import type { Capture, ConsoleDetail, WireForm } from "./fixtures/bun-console-captures.ts";
import * as captures from "./fixtures/bun-console-captures.ts";

const WIRES: WireForm[] = ["plain", "ansi"];

function read(capture: Capture, wire: WireForm): Record<string, ConsoleDetail> {
  const text = capture[wire];
  if (text === undefined) throw new Error(`no ${wire} form of this capture`);
  return parseBunConsoleFailures(text) as Record<string, ConsoleDetail>;
}

function messageOf(details: Record<string, ConsoleDetail>, name: string): string | undefined {
  return details[name]?.message;
}

// ── The client's reading, capture for capture ───────────────────────────────

describe("the board reads every pinned bun console capture exactly as the bun client reads it", () => {
  for (const [key, expected] of Object.entries(CLIENT_READING)) {
    const [name, wire] = key.split("/") as [string, WireForm];
    test(`${name} in its ${wire} wire form`, () => {
      const capture = (captures as unknown as Record<string, Capture>)[name]!;
      expect(read(capture, wire)).toEqual(expected);
    });
  }
});

// ── A detail block before its result line ───────────────────────────────────

describe("a detail block immediately before a result line marries that line", () => {
  for (const wire of WIRES) {
    test(`each of two consecutive blocks marries its own following result line (${wire})`, () => {
      const details = read(DETAIL_BEFORE_FAIL_LINE, wire);
      expect(messageOf(details, "alpha asserts wrongly")).toBe("expect(received).toBe(expected)");
      expect(messageOf(details, "beta throws with detail")).toBe("boom with detail");
      expect(Object.keys(details).sort()).toEqual(["alpha asserts wrongly", "beta throws with detail"]);
    });

    test(`keys, message and trace carry no SGR escape, and a nested result line is also indexed by its last segment (${wire})`, () => {
      const details = read(NESTED_RESULT_LINE, wire);
      for (const [key, married] of Object.entries(details)) {
        expect(key).not.toContain("\x1b");
        expect(married.message).not.toContain("\x1b");
        expect(married.trace ?? "").not.toContain("\x1b");
      }
      expect(messageOf(details, "suite > nested leaf")).toBe("boom with detail");
      expect(messageOf(details, "nested leaf")).toBe("boom with detail");
    });
  }

  test("the trace is the block from its error: line to the result line, stripped, joined by newlines, trailing whitespace dropped", () => {
    for (const wire of WIRES) {
      const details = read(LEGIT_CONSECUTIVE, wire);
      expect(details["alpha asserts wrongly"]).toEqual({
        message: "expect(received).toBe(expected)",
        trace:
          "error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1\n\n" +
          "      at <anonymous> (/tmp/bun-fixture/a.test.ts:4:13)",
      });
    }
  });

  test("a console with no result line reads as nothing", () => {
    expect(parseBunConsoleFailures("")).toEqual({});
    expect(parseBunConsoleFailures("error: orphaned\n      at x (/tmp/y.ts:1:1)")).toEqual({});
  });
});

// ── Detail printed after its own result line, and result-line boundaries ────

describe("detail printed after its own result line stays unmatched", () => {
  for (const wire of WIRES) {
    test(`a timeout's detail after its result line does not marry backwards (${wire})`, () => {
      const details = read(DETAIL_AFTER_FAIL_LINE, wire);
      expect(details["alpha times out"]).toBeUndefined();
      expect(details).toEqual({});
    });

    test(`a pass and a skip result line end a pending block, so it reaches no later failing line (${wire})`, () => {
      expect(read(BOUNDARY_ENDS_BLOCK, wire)).toEqual({});
    });
  }

  test("a real run: matched leaves carry their own message and multi-line trace, the timed-out leaf is unmatched", () => {
    const details = read(TIMEOUT_DETAIL_AFTER_FAIL, "plain");
    expect(messageOf(details, "mismatched expectation")).toBe("expect(received).toBe(expected)");
    expect(details["mismatched expectation"]?.trace).toContain("Expected: 3");
    expect(details["mismatched expectation"]?.trace).toContain("Received: 2");
    expect(messageOf(details, "throws with detail")).toBe("boom with detail");
    expect(details["times out unmatched"]).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain("timed out");
  });

  test("the same run with the timeout's detail moved before its result line marries it — and only it", () => {
    const details = read(TIMEOUT_DETAIL_BEFORE_FAIL, "plain");
    expect(messageOf(details, "times out unmatched")).toBe("this test timed out after 50ms.");
    expect(messageOf(details, "mismatched expectation")).toBe("expect(received).toBe(expected)");
    expect(messageOf(details, "throws with detail")).toBe("boom with detail");
  });
});

// ── An echo naming another test: the aftermath marries no one ───────────────

describe("a block whose echo names another test is that test's aftermath and marries no one", () => {
  for (const wire of WIRES) {
    test(`one-line leak: the producer keeps its own message, the next failing leaf gets nothing (${wire})`, () => {
      const details = read(LEAK_ONELINER, wire);
      expect(messageOf(details, "alpha fails and leaks")).toBe("expect(received).toBe(expected)");
      expect(details["beta fails"]).toBeUndefined();
    });

    test(`multi-line leak: gamma keeps its own message, delta gets nothing (${wire})`, () => {
      const details = read(LEAK_MULTILINE, wire);
      expect(messageOf(details, "gamma leaks after failing")).toBe("expect(received).toBe(expected)");
      expect(details["delta fails later"]).toBeUndefined();
    });

    test(`nested leak: the aftermath reaches neither the composed nor the bare key of the next nested leaf (${wire})`, () => {
      const details = read(LEAK_NESTED, wire);
      expect(messageOf(details, "outer > inner > epsilon leaks after failing")).toBe(
        "expect(received).toBe(expected)",
      );
      expect(messageOf(details, "epsilon leaks after failing")).toBe("expect(received).toBe(expected)");
      expect(details["outer > inner > zeta fails later"]).toBeUndefined();
      expect(details["zeta fails later"]).toBeUndefined();
    });
  }

  test("the earlier real capture of the one-line leak: alpha keeps its own message, beta gets nothing", () => {
    const details = read(REAL_LEAKED_ASYNC_ERROR, "plain");
    expect(messageOf(details, "alpha fails and leaks")).toBe("expect(received).toBe(expected)");
    expect(details["beta fails"]).toBeUndefined();
  });

  test("a real run's leaked throw: gamma keeps its own message and trace, delta carries no trace of 'leaked boom'", () => {
    const details = read(AFTERMATH_BLEED, "plain");
    expect(messageOf(details, "gamma leaks after failing")).toBe("expect(received).toBe(expected)");
    expect(details["gamma leaks after failing"]?.trace).toContain("Expected: 2");
    expect(details["gamma leaks after failing"]?.trace).toContain("Received: 1");
    expect(details["gamma leaks after failing"]?.message).not.toContain("leaked boom");
    expect(details["delta fails later"]).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain("leaked boom");
  });
});

// ── The echo names the producer: the common case ────────────────────────────

describe("a block whose echo names the following result line's test marries it", () => {
  for (const wire of WIRES) {
    test(`two consecutive failures each keep their own message though the second's echo also shows the first's declaration (${wire})`, () => {
      const details = read(LEGIT_CONSECUTIVE, wire);
      expect(messageOf(details, "alpha asserts wrongly")).toBe("expect(received).toBe(expected)");
      expect(messageOf(details, "beta throws its own boom")).toBe("beta boom");
      expect(messageOf(details, "alpha asserts wrongly")).not.toBe(
        messageOf(details, "beta throws its own boom"),
      );
    });

    test(`nested: the echo's bare name is compared with the result line's last segment, and both keys marry (${wire})`, () => {
      const details = read(LEGIT_NESTED, wire);
      expect(messageOf(details, "outer > inner > iota asserts wrongly")).toBe(
        "expect(received).toBe(expected)",
      );
      expect(messageOf(details, "iota asserts wrongly")).toBe("expect(received).toBe(expected)");
      expect(messageOf(details, "outer > inner > kappa throws its own boom")).toBe("kappa boom");
      expect(messageOf(details, "kappa throws its own boom")).toBe("kappa boom");
    });
  }
});

// ── No resolvable echo: position decides ────────────────────────────────────

describe("a block whose echo names no test it can read marries positionally", () => {
  for (const wire of WIRES) {
    test(`an echo showing only a shared helper: each block marries the result line after it, with its own call site (${wire})`, () => {
      const details = read(ECHOLESS_HELPER, wire);
      expect(messageOf(details, "eta fails inside a helper")).toBe("helper boom for 5");
      expect(messageOf(details, "theta fails inside a helper")).toBe("helper boom for 10");
      expect(details["eta fails inside a helper"]?.trace).toContain("d.test.ts:11:3");
      expect(details["eta fails inside a helper"]?.trace).not.toContain("d.test.ts:15:3");
      expect(details["theta fails inside a helper"]?.trace).toContain("d.test.ts:15:3");
      expect(details["theta fails inside a helper"]?.trace).not.toContain("d.test.ts:11:3");
    });
  }

  const SHAPES: Array<[string, Capture, string, string]> = [
    ["test.each([1])(\"beta each %i\", …)", EACH_TEST, "beta each 1", "beta each boom"],
    ["it.each([2])(\"gamma each %i\", …)", EACH_IT, "gamma each 2", "gamma each boom"],
    ["a variable name, test(NAME, …)", VARIABLE_NAME, "delta named by a variable", "delta boom"],
    ["a declaration split over lines", SPLIT_DECL, "epsilon split over lines", "epsilon boom"],
    ["an interpolated template-literal name", TEMPLATE_NAME, "zeta 3 interpolated", "zeta boom"],
    ["a name holding an escaped quote", ESCAPED_QUOTE, 'lambda says "hi" loudly', "lambda boom"],
  ];
  for (const [shape, capture, leafName, message] of SHAPES) {
    for (const wire of WIRES) {
      test(`${shape}: the leaf keeps its own message and its plainly-declared predecessor keeps its own (${wire})`, () => {
        const details = read(capture, wire);
        expect(messageOf(details, leafName)).toBe(message);
        expect(messageOf(details, "alpha asserts wrongly")).toBe("expect(received).toBe(expected)");
        expect(messageOf(details, leafName)).not.toBe(messageOf(details, "alpha asserts wrongly"));
      });
    }
  }

  for (const wire of WIRES) {
    test(`a second error: under one echo window marries the next result line by position, from that second error: on (${wire})`, () => {
      const details = read(SECOND_ERROR_ONE_WINDOW, wire);
      expect(Object.keys(details)).toEqual(["beta follows"]);
      expect(details["beta follows"]?.message).toBe("second detail");
      expect(details["beta follows"]?.trace).toBe(
        "error: second detail\n      at <anonymous> (/tmp/bun-fixture/m.test.ts:4:9)",
      );
      expect(details["alpha throws twice"]).toBeUndefined();
    });
  }
});

// ── The cuts ────────────────────────────────────────────────────────────────

describe("a married detail is cut: message at 1000 characters, trace at 8000", () => {
  for (const wire of WIRES) {
    test(`a 1500-character message and a longer trace are cut to exactly 1000 and 8000 (${wire})`, () => {
      const married = read(LONG_DETAIL, wire)["omega overflows"];
      expect(married?.message).toBe("M".repeat(1000));
      expect(married?.trace?.length).toBe(8000);
      expect(married?.trace?.startsWith(`error: ${"M".repeat(1500)}\n      at <anonymous>`)).toBe(true);
    });
  }
});
