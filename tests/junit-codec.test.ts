// CR-CRU-002 §S1 — JUnit codec (parseJunit / parseJunitPath) + RunSchema shape
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSchema } from "../src/types.ts";
import { parseJunit, parseJunitPath } from "../src/codecs/junit.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "codec-junit-"));
}

// AC1 — 3-case suite: 1 failure (message="boom" type="AssertionError" body "line1\nline2" time=0.5),
// 1 skipped (time=0), 1 pass (time=0.084) → summary {total:3, passed:1, failed:1, pending:1, duration_ms:584}
const XML_THREE_CASE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<testsuites>",
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="fails" time="0.5"><failure message="boom" type="AssertionError">line1\nline2</failure></testcase>',
  '<testcase name="skips" time="0"><skipped/></testcase>',
  '<testcase name="passes" time="0.084"/>',
  "</testsuite>",
  "</testsuites>",
].join("\n");

describe("parseJunit — summary + failed-leaf shape (AC1)", () => {
  test("3-case suite yields exact summary counts and duration_ms", () => {
    const result: RunSchema = parseJunit(XML_THREE_CASE);

    expect(result.summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1,
      duration_ms: 584,
    });
  });

  test("failed leaf carries the exact failure shape {message, type, trace}", () => {
    const result: RunSchema = parseJunit(XML_THREE_CASE);
    const suite = result.tree[0];
    expect(suite).toBeDefined();

    const failedLeaf = suite.children.find((c) => c.name === "fails");
    expect(failedLeaf?.status).toBe("fail");
    expect(failedLeaf?.duration_ms).toBe(500);
    expect(failedLeaf?.failure).toEqual({
      message: "boom",
      type: "AssertionError",
      trace: "line1\nline2",
    });
  });

  test("skipped case is 'pending' and plain case is 'pass', each with rounded duration_ms", () => {
    const result: RunSchema = parseJunit(XML_THREE_CASE);
    const suite = result.tree[0];

    const skipped = suite.children.find((c) => c.name === "skips");
    expect(skipped?.status).toBe("pending");
    expect(skipped?.duration_ms).toBe(0);

    const passed = suite.children.find((c) => c.name === "passes");
    expect(passed?.status).toBe("pass");
    expect(passed?.duration_ms).toBe(84);
  });
});

// AC2 — bare <testsuite> root (no <testsuites> wrapper)
describe("parseJunit — bare <testsuite> root (AC2)", () => {
  test("bare testsuite root yields exactly 1 suite node with correct counts", () => {
    const xml = [
      '<testsuite name="BareRoot" tests="1">',
      '<testcase name="t1" time="0.01"/>',
      "</testsuite>",
    ].join("\n");

    const result: RunSchema = parseJunit(xml);

    expect(result.tree.length).toBe(1);
    expect(result.tree[0].name).toBe("BareRoot");
    expect(result.summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      duration_ms: 10,
    });
  });
});

// AC3 — failure with no message attr falls back to first non-empty CDATA line;
// entity-encoded name attr decodes correctly.
describe("parseJunit — failure message fallback + entity decoding (AC3)", () => {
  test("failure with no message attr falls back to first non-empty CDATA text line", () => {
    const xml = [
      '<testsuite name="Suite3" tests="1">',
      '<testcase name="cdata-case" time="0.2">',
      '<failure type="Error"><![CDATA[',
      "",
      "first non-empty line",
      "second line",
      "]]></failure>",
      "</testcase>",
      "</testsuite>",
    ].join("\n");

    const result: RunSchema = parseJunit(xml);
    const leaf = result.tree[0].children[0];

    expect(leaf.status).toBe("fail");
    expect(leaf.failure?.message).toBe("first non-empty line");
    expect(leaf.failure?.type).toBe("Error");
  });

  test("entity-encoded testcase name attr (&lt;) decodes to '<'", () => {
    const xml = [
      '<testsuite name="Suite3b" tests="1">',
      '<testcase name="a &lt; b" time="0.05">',
      '<failure message="m">t</failure>',
      "</testcase>",
      "</testsuite>",
    ].join("\n");

    const result: RunSchema = parseJunit(xml);
    expect(result.tree[0].children[0].name).toBe("a < b");
  });

  test("&amp; &quot; and &#xA; entities decode inside text content", () => {
    const xml = [
      '<testsuite name="Suite3c" tests="1">',
      '<testcase name="entity-case" time="0.01">',
      '<failure message="m">A &amp; B &quot;quoted&quot; line1&#xA;line2</failure>',
      "</testcase>",
      "</testsuite>",
    ].join("\n");

    const result: RunSchema = parseJunit(xml);
    expect(result.tree[0].children[0].failure?.trace).toBe('A & B "quoted" line1\nline2');
  });

  test("failure with no message attr and no text falls back to 'test failed'", () => {
    const xml = [
      '<testsuite name="Suite3d" tests="1">',
      '<testcase name="no-message-case" time="0.01"><failure/></testcase>',
      "</testsuite>",
    ].join("\n");

    const result: RunSchema = parseJunit(xml);
    expect(result.tree[0].children[0].failure?.message).toBe("test failed");
  });
});

// AC5 — suite node status: "fail" iff any child failed, else "pass"
describe("parseJunit — suite node status aggregation (AC5)", () => {
  test("suite with a failing child is status 'fail'", () => {
    const result: RunSchema = parseJunit(XML_THREE_CASE);
    expect(result.tree[0].status).toBe("fail");
  });

  test("suite with only pass/pending children (no failures) is status 'pass'", () => {
    const xml = [
      '<testsuite name="AllGood" tests="2">',
      '<testcase name="p1" time="0.01"/>',
      '<testcase name="p2" time="0"><skipped/></testcase>',
      "</testsuite>",
    ].join("\n");

    const result: RunSchema = parseJunit(xml);
    expect(result.tree[0].status).toBe("pass");
  });
});

// AC on parseJunitPath — single file, directory merge, empty-dir rejection, malformed-file skip
describe("parseJunitPath — single file and directory merge (AC on parseJunitPath)", () => {
  test("parses a single JUnit XML file from disk", async () => {
    const dir = freshDir();
    const file = join(dir, "single.xml");
    writeFileSync(file, XML_THREE_CASE);

    try {
      const result: RunSchema = await parseJunitPath(file);
      expect(result.summary).toEqual({
        total: 3,
        passed: 1,
        failed: 1,
        pending: 1,
        duration_ms: 584,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("merges all TEST-*.xml in a directory, sorted by filename, into one RunSchema", async () => {
    const dir = freshDir();
    const xmlA = [
      '<testsuite name="SuiteA" tests="2">',
      '<testcase name="a1" time="0.1"/>',
      '<testcase name="a2" time="0.1"/>',
      "</testsuite>",
    ].join("\n");
    const xmlB = [
      '<testsuite name="SuiteB" tests="1">',
      '<testcase name="b1" time="0.2"><failure message="bad">x</failure></testcase>',
      "</testsuite>",
    ].join("\n");
    writeFileSync(join(dir, "TEST-a.xml"), xmlA);
    writeFileSync(join(dir, "TEST-b.xml"), xmlB);

    try {
      const result: RunSchema = await parseJunitPath(dir);

      expect(result.summary.total).toBe(3);
      expect(result.summary.passed).toBe(2);
      expect(result.summary.failed).toBe(1);

      expect(result.tree.length).toBe(2);
      expect(result.tree[0].name).toBe("SuiteA");
      expect(result.tree[1].name).toBe("SuiteB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directory with no TEST-*.xml files rejects with the directory path in the error message", async () => {
    const dir = freshDir();

    try {
      await expect(parseJunitPath(dir)).rejects.toThrow(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directory with one malformed XML file skips it (warns) and parses the good file only", async () => {
    const dir = freshDir();
    const xmlGood = [
      '<testsuite name="GoodSuite" tests="2">',
      '<testcase name="g1" time="0.1"/>',
      '<testcase name="g2" time="0.1"/>',
      "</testsuite>",
    ].join("\n");
    const xmlBad = "<testsuite><testcase name=\"broken\"></testsuite>"; // unclosed <testcase>

    writeFileSync(join(dir, "TEST-good.xml"), xmlGood);
    writeFileSync(join(dir, "TEST-bad.xml"), xmlBad);

    try {
      const result: RunSchema = await parseJunitPath(dir);
      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(2);
      expect(result.tree.length).toBe(1);
      expect(result.tree[0].name).toBe("GoodSuite");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
