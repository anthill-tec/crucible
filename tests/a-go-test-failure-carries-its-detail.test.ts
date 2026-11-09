// What a go case carries beyond its status under the `go-test` codec, at codec
// level, on captured real Go output in both forms (Go 1.27's `OutputType`, and
// the text form without it):
//
//  - a failure's message is its first `error` line, stripped of its
//    `file.go:LINE: ` prefix, and the `error-continue` lines after it,
//    de-indented (the text form reads the indented `file.go:LINE:` line and its
//    continuation indent); a `t.Log` line is not part of it in the typed form,
//    but in the text form, where a log line and an error line have the same
//    shape, the message is every indented `file.go:LINE:` line of the test,
//    its log lines included (logs.jsonl); testify's
//    `Error Trace:` / `Error:` blocks are kept whole. With no `error` line, the
//    message is the test's own untyped output — a panic, a failing example;
//  - the failure's type is its `file:line`: the first `error` line's, else the
//    first stack frame naming a `_test.go`; the file is the package's import
//    path joined to the file's basename;
//  - the failure's trace is the test's non-frame output;
//  - a skip is pending and carries its reason as its message: the last
//    `file.go:LINE:` output line before its `--- SKIP` frame;
//  - a package-level failure with no failing test is one failing case under the
//    package, named for it (its import path): a build failure, its message the
//    `build-output` lines whose `ImportPath` is its `FailedBuild`; a `TestMain`
//    exit, its message the package's own output; `[setup failed]`;
//  - a package with no test files adds no case; benchmarks add no case.
import { describe, test, expect } from "bun:test";
import {
  buildOutputOf,
  casesOf,
  decodeGoTest,
  failedBuildOf,
  fixture,
  FORMS,
  leafOf,
  textFormOf,
} from "./helpers/go-test-harness.ts";

const PA = "example.com/mod/pa";
const PLOG = "example.com/mod/plog";
const TFY = "example.com/tfy";

/** Asserts each of `parts` appears in `text`, in order. */
function inOrder(text: string | undefined, parts: readonly string[]): void {
  expect(typeof text).toBe("string");
  let from = 0;
  for (const part of parts) {
    const at = (text as string).indexOf(part, from);
    expect(at, `"${part}" after offset ${from}`).toBeGreaterThanOrEqual(0);
    from = at + part.length;
  }
}

describe("a go failure's multi-line message beside a later t.Log line (pa.jsonl)", () => {
  test("typed (OutputType, Go 1.27): the message is its three lines, prefix stripped and de-indented, the t.Log line left out", () => {
    const leaf = leafOf(decodeGoTest(fixture("pa.jsonl")).tree, PA, "TestFailMulti");
    expect(leaf.status).toBe("fail");
    expect(leaf.failure?.message).toBe("first line\nsecond line\nthird line");
    expect(leaf.failure?.message).not.toContain("a log line");
    expect(leaf.failure?.message).not.toContain("a_test.go");
  });

  test("text form (no OutputType, Go 1.26): the message is every indented file.go:LINE: line of the test, its three lines and the t.Log line after them", () => {
    const leaf = leafOf(decodeGoTest(textFormOf(fixture("pa.jsonl"))).tree, PA, "TestFailMulti");
    expect(leaf.status).toBe("fail");
    inOrder(leaf.failure?.message, ["first line\nsecond line\nthird line", "a log line"]);
    expect(leaf.failure?.message).not.toContain("a_test.go");
  });
});

for (const form of FORMS) {
  describe(`a go failure's message, file:line and trace — ${form.name}`, () => {

    test("a multi-line t.Errorf: file:line is the error line's, the file the package path joined to its basename", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree, PA, "TestFailMulti");
      expect(leaf.failure?.type).toBe("example.com/mod/pa/a_test.go:10");
    });

    test("a multi-line t.Errorf: the trace is the test's non-frame output, its t.Log line included, no frame line", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree, PA, "TestFailMulti");
      inOrder(leaf.failure?.trace, ["first line", "second line", "third line", "a log line"]);
      expect(leaf.failure?.trace).not.toContain("--- FAIL");
      expect(leaf.failure?.trace).not.toContain("=== RUN");
    });

    test("a failing subtest's t.Fatal and a nested subtest's t.Error each carry their own message and file:line", () => {
      const tree = decodeGoTest(form.of(fixture("pa.jsonl"))).tree;
      expect(leafOf(tree, PA, "TestSubs/bad").failure).toMatchObject({
        message: "sub failed",
        type: "example.com/mod/pa/a_test.go:16",
      });
      expect(leafOf(tree, PA, "TestSubs/nest/deep_bad").failure).toMatchObject({
        message: "deep failed",
        type: "example.com/mod/pa/a_test.go:20",
      });
    });

    test("a parent failing on its own carries its own error, a parallel test's error its own", () => {
      const tree = decodeGoTest(form.of(fixture("pa.jsonl"))).tree;
      expect(leafOf(tree, PA, "TestParentFailsBeyond").failure).toMatchObject({
        message: "parent body failure",
        type: "example.com/mod/pa/a_test.go:25",
      });
      expect(leafOf(tree, PA, "TestPar2").failure).toMatchObject({
        message: "p2 fails",
        type: "example.com/mod/pa/a_test.go:32",
      });
    });

    test("a failing example: its message is its untyped got/want output, after the --- FAIL frame", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree, PA, "ExampleBad");
      expect(leaf.status).toBe("fail");
      expect(leaf.failure?.message).toBe("got:\nnope\nwant:\nhello");
    });

    test("testify's assert block is kept whole: Error Trace, Error, expected/actual, Test and Messages, in order", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("testify.jsonl"))).tree, TFY, "TestAssert");
      inOrder(leaf.failure?.message, [
        "Error Trace:",
        "/tmp/cr195-review/tfy/t_test.go:10",
        "Error:",
        "Not equal:",
        "expected: 1",
        "actual  : 2",
        "Test:",
        "TestAssert",
        "Messages:",
        "numbers differ",
      ]);
      expect(leaf.failure?.message?.startsWith("t_test.go")).toBe(false);
      expect(leaf.failure?.message).not.toContain("--- FAIL");
      expect(leaf.failure?.type).toBe("example.com/tfy/t_test.go:10");
    });

    test("testify's require block is kept whole: the error it received and the test it failed", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("testify.jsonl"))).tree, TFY, "TestRequire");
      inOrder(leaf.failure?.message, ["Error Trace:", "Error:", "Received unexpected error:", "foo broke", "Test:", "TestRequire"]);
      expect(leaf.failure?.type).toBe("example.com/tfy/t_test.go:11");
    });

    test("testify.jsonl: two failing cases, nothing else, its package failure carried by them", () => {
      const run = decodeGoTest(form.of(fixture("testify.jsonl")));
      expect(casesOf(run.tree)).toEqual([`${TFY} :: TestAssert = fail`, `${TFY} :: TestRequire = fail`]);
    });
  });

  describe(`a go skip's reason — ${form.name}`, () => {
    test("TestSkip is pending, its reason the t.Skip text before its --- SKIP frame", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree, PA, "TestSkip");
      expect(leaf.status).toBe("pending");
      expect(leaf.failure?.message).toBe("not today");
    });

    test("a skipped subtest carries its own reason", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree, PA, "TestSubs/skipped");
      expect(leaf.status).toBe("pending");
      expect(leaf.failure?.message).toBe("sub skip reason");
    });
  });

  describe(`a go panic's message — ${form.name}`, () => {
    test("a panic in a top-level test: its message opens with the panic line, file:line the first _test.go frame", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("buildfail-mixed.jsonl"))).tree, "example.com/mod/ppanic", "TestPanics");
      expect(leaf.status).toBe("fail");
      expect(leaf.failure?.message?.split("\n")[0]).toBe("panic: assignment to entry in nil map [recovered, repanicked]");
      expect(leaf.failure?.type).toBe("example.com/mod/ppanic/p_test.go:6");
    });

    test("a panic in a subtest: the parent carrying the panic output is a failing case with the panic's message and frame", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("subpanic.jsonl"))).tree, "example.com/mod/psubpanic", "TestOuter");
      expect(leaf.status).toBe("fail");
      expect(leaf.failure?.message?.split("\n")[0]).toBe("panic: kaboom [recovered, repanicked]");
      expect(leaf.failure?.type).toBe("example.com/mod/psubpanic/s_test.go:7");
    });

    test("a panic in a subtest: no case is a passing run of the package, and no package-named case is added", () => {
      const run = decodeGoTest(form.of(fixture("subpanic.jsonl")));
      const names = casesOf(run.tree).map((c) => c.split(" = ")[0]);
      expect(names).not.toContain("example.com/mod/psubpanic :: example.com/mod/psubpanic");
      expect(run.tree.map((s) => [s.name, s.status])).toEqual([["example.com/mod/psubpanic", "fail"]]);
    });
  });

  describe(`a go package failure is one failing case named for its package — ${form.name}`, () => {
    for (const pkg of ["example.com/mod/pa", "example.com/mod/pbuild", "example.com/mod/pex"]) {
      test(`a build failure (${pkg}): its message is the build-output lines of its FailedBuild, and no other package's`, () => {
        const text = fixture("buildfail-mixed.jsonl");
        const failedBuild = failedBuildOf(text, pkg);
        expect(failedBuild).toBe(`${pkg} [${pkg}.test]`);
        const leaf = leafOf(decodeGoTest(form.of(text)).tree, pkg, pkg);
        expect(leaf.status).toBe("fail");
        expect(leaf.failure?.message).toBe(buildOutputOf(text, failedBuild as string).trim());
        for (const other of ["example.com/mod/pa", "example.com/mod/pbuild", "example.com/mod/pex"].filter((p) => p !== pkg)) {
          expect(leaf.failure?.message).not.toContain(`# ${other}\n`);
        }
      });
    }

    test("pbuild's build failure names both of its compile errors", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("buildfail-mixed.jsonl"))).tree, "example.com/mod/pbuild", "example.com/mod/pbuild");
      inOrder(leaf.failure?.message, [
        "pbuild/b_test.go:5:37: declared and not used: x",
        'pbuild/b_test.go:5:45: cannot use "s" (untyped string constant) as int value in variable declaration',
      ]);
    });

    test("a TestMain exit after a passing test: a failing case named for pmain, its message the package's own output", () => {
      const tree = decodeGoTest(form.of(fixture("buildfail-mixed.jsonl"))).tree;
      const leaf = leafOf(tree, "example.com/mod/pmain", "example.com/mod/pmain");
      expect(leaf.status).toBe("fail");
      expect(leaf.failure?.message).toContain("FAIL\texample.com/mod/pmain\t0.003s");
      expect(leafOf(tree, "example.com/mod/pmain", "TestOk").status).toBe("pass");
      expect(tree.find((s) => s.name === "example.com/mod/pmain")?.status).toBe("fail");
    });

    test("a package whose failure a failing test carries (ppanic) adds no package-named case", () => {
      const tree = decodeGoTest(form.of(fixture("buildfail-mixed.jsonl"))).tree;
      const names = casesOf(tree).filter((c) => c.startsWith("example.com/mod/ppanic ::"));
      expect(names).toEqual(["example.com/mod/ppanic :: TestBefore = pass", "example.com/mod/ppanic :: TestPanics = fail"]);
    });

    test("[setup failed]: one failing case named ./..., its message the build-output lines of its FailedBuild — never a passing run", () => {
      const text = fixture("setup-failed.jsonl");
      const run = decodeGoTest(form.of(text));
      expect(casesOf(run.tree)).toEqual(["./... :: ./... = fail"]);
      expect(run.summary).toMatchObject({ total: 1, passed: 0, failed: 1, pending: 0 });
      expect(leafOf(run.tree, "./...", "./...").failure?.message).toBe(
        "# ./...\npattern ./...: directory prefix . does not contain main module or its selected dependencies",
      );
    });

    test("a package with no test files adds no case and no suite (pnotest)", () => {
      const run = decodeGoTest(form.of(fixture("buildfail-mixed.jsonl")));
      expect(run.tree.map((s) => s.name)).not.toContain("example.com/mod/pnotest");
      expect(casesOf(run.tree).some((c) => c.includes("pnotest"))).toBe(false);
    });

    test("a passing package (pb) adds no package-named case: its two tests only", () => {
      const tree = decodeGoTest(form.of(fixture("buildfail-mixed.jsonl"))).tree;
      expect(casesOf(tree).filter((c) => c.startsWith("example.com/mod/pb ::"))).toEqual([
        "example.com/mod/pb :: TestB1 = pass",
        "example.com/mod/pb :: TestB2 = pass",
      ]);
    });
  });

  describe(`benchmarks add no case — ${form.name}`, () => {
    test("bench.jsonl: two benchmarks run beside TestPass; only TestPass is a case, the run whole", () => {
      const run = decodeGoTest(form.of(fixture("bench.jsonl")), { startTotal: 1 });
      expect(casesOf(run.tree)).toEqual(["example.com/mod/pbench :: TestPass = pass"]);
      expect(run.summary).toMatchObject({ total: 1, passed: 1, failed: 0, pending: 0 });
      expect(Object.keys(run)).not.toContain("incomplete");
    });

    test("bench-action.jsonl: a bench action and its log lines add no case and fail nothing", () => {
      const run = decodeGoTest(form.of(fixture("bench-action.jsonl")));
      expect(casesOf(run.tree)).toEqual([]);
      expect(run.summary).toMatchObject({ total: 0, passed: 0, failed: 0, pending: 0 });
      expect(Object.keys(run)).not.toContain("incomplete");
    });

    test("logs.jsonl: a failing subtest under a logging parent carries its own message and file:line", () => {
      const leaf = leafOf(decodeGoTest(form.of(fixture("logs.jsonl"))).tree, PLOG, "TestLogsThenFailingSub/bad");
      expect(leaf.failure).toMatchObject({ message: "sub failed", type: "example.com/mod/plog/l_test.go:7" });
    });
  });
}

describe("a go failure's message beside a t.Log line (logs.jsonl) — typed (OutputType, Go 1.27)", () => {
  test("t.Log then t.Error: the message is the error alone, the log line left out", () => {
    const leaf = leafOf(decodeGoTest(fixture("logs.jsonl")).tree, PLOG, "TestLogThenError");
    expect(leaf.status).toBe("fail");
    expect(leaf.failure?.message).toBe("boom");
    expect(leaf.failure?.type).toBe("example.com/mod/plog/l_test.go:11");
  });

  test("a parent's own t.Error beside a failing subtest is its own failure, carrying its own message", () => {
    const tree = decodeGoTest(fixture("logs.jsonl")).tree;
    expect(leafOf(tree, PLOG, "TestOwnErrorAndFailingSub").failure).toMatchObject({
      message: "own failure",
      type: "example.com/mod/plog/l_test.go:15",
    });
    expect(leafOf(tree, PLOG, "TestOwnErrorAndFailingSub/bad").failure).toMatchObject({
      message: "sub failed",
      type: "example.com/mod/plog/l_test.go:14",
    });
  });
});

describe("a go failure's message beside a t.Log line (logs.jsonl) — text form (no OutputType, Go 1.26)", () => {
  test("t.Log then t.Error: the message is every indented file.go:LINE: line of the test, the log line included", () => {
    const leaf = leafOf(decodeGoTest(textFormOf(fixture("logs.jsonl"))).tree, PLOG, "TestLogThenError");
    expect(leaf.status).toBe("fail");
    inOrder(leaf.failure?.message, ["step one", "boom"]);
    expect(leaf.failure?.message).not.toContain("l_test.go");
    expect(leaf.failure?.message).not.toContain("--- FAIL");
    expect(leaf.failure?.message).not.toContain("=== RUN");
  });
});
