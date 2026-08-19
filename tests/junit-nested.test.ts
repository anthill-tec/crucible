// CR-CRU-003 AC (dog-food finding 2026-07-15) — parseJunit must handle NESTED
// <testsuite> elements recursively (DN §3.4 parity: clients use `.//testsuite`;
// bun's `--reporter=junit` nests suites). Current codec only looks at direct
// <testsuite> children of the root and direct <testcase> children of each
// testsuite, so a bun-dialect file yields summary.total === 0.
import { describe, test, expect } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { parseJunit, parseJunitPath } from "../src/codecs/junit.ts";
import type { RunSchema } from "../src/types.ts";

// Bun dialect: <testsuites> wraps a top-level <testsuite> which itself nests
// another <testsuite> holding the actual <testcase> leaves.
const BUN_NESTED_XML = [
  "<testsuites>",
  '<testsuite name="outer">',
  '<testsuite name="inner">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"><failure message="x"/></testcase>',
  "</testsuite>",
  "</testsuite>",
  "</testsuites>",
].join("\n");

describe("parseJunit — recursive nested <testsuite> (bun dialect)", () => {
  test("2 leaves nested two levels deep → summary.total=2, failed=1, passed=1, no double-count", () => {
    const result: RunSchema = parseJunit(BUN_NESTED_XML);

    expect(result.summary.total).toBe(2);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.pending).toBe(0);

    expect(result.tree.length).toBeGreaterThan(0);

    // Recursive `.//testsuite` semantics: each leaf counted exactly once —
    // summing children across every suite node in the flattened tree must
    // equal summary.total (guards against the parent <testsuite name="outer">
    // being counted as an empty suite AND the nested leaves being dropped,
    // or leaves being double-counted at both nesting levels).
    const totalLeaves = result.tree.reduce((sum, suite) => sum + suite.children.length, 0);
    expect(totalLeaves).toBe(2);

    const failedLeaf = result.tree.flatMap((s) => s.children).find((c) => c.status === "fail");
    expect(failedLeaf).toBeDefined();
    expect(failedLeaf?.name).toBe("t2");
  });
});

describe("parseJunitPath — real bun-generated JUnit file (dog-food regression)", () => {
  test("a real `bun test --reporter=junit` file ingests with summary.total > 0", async () => {
    const outfile = "/tmp/bun-real-junit.xml";
    if (existsSync(outfile)) unlinkSync(outfile);

    Bun.spawnSync({
      cmd: [
        "bun",
        "test",
        "tests/codec-registry.test.ts",
        "--reporter=junit",
        `--reporter-outfile=${outfile}`,
      ],
      cwd: process.cwd(),
    });

    expect(existsSync(outfile)).toBe(true);

    const result: RunSchema = await parseJunitPath(outfile);
    expect(result.summary.total).toBeGreaterThan(0);
  });
});
