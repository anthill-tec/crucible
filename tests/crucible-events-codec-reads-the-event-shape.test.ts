// The `crucible-events` codec reads one Crucible event shape — newline-
// delimited JSON, a `run-start`, a `test-end` per test and a `run-end` — into
// the canonical run, through JUnit's own reading rules.
//
// What is held here:
//  - registration: the codec is found in the `codecs` registry
//    (src/codecs/index.ts) as `crucible-events`, marked `stream: true`, and
//    its `parse` answers synchronously;
//  - the reading rules: one suite node per distinct suite in first-seen order
//    (blank → `?`), one leaf per `test-end` in stream order (a repeated id
//    counted each time), the last `run-start` / `run-end` wins, a test after
//    `run-end` is counted and flagged, unknown kinds and blank lines are
//    skipped, undecodable lines are counted, a final line with no newline is
//    read, and `files` follow JUnit's file rule;
//  - `incomplete`: the reasons the stream cannot be trusted, in §S1's order,
//    joined by "; ", and absent on a complete stream;
//  - the shared reading: `failureOf` and `suiteStatus` are exported from
//    src/codecs/junit.ts and give JUnit's cut, fallback and suite status; a
//    source check holds that JUnit's `toFailure` / `toNode` and the codec
//    module (src/codecs/crucible-events.ts) use them rather than copies, and
//    that check is proved on synthetic sources first.
//
// A reason's exact wording is the board's; each is matched here by the words
// §S1 gives it ("no run-end", "run-end" with both figures, "after run-end",
// "<N> undecodable").
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codecs } from "../src/codecs/index.ts";
import type { DecodedRun } from "../src/codecs/index.ts";
import * as junit from "../src/codecs/junit.ts";
import type { TestLeaf } from "../src/types.ts";
import { balancedEnd, jsLiveCode, jsUncommented, unnestedEnd } from "./helpers/source-scan.ts";

const CODEC = "crucible-events";
const REPO = join(import.meta.dir, "..");
const JUNIT_SOURCE = join(REPO, "src", "codecs", "junit.ts");
const CODEC_SOURCE = join(REPO, "src", "codecs", "crucible-events.ts");

/** A decoded stream: the run, plus the reasons it cannot be trusted. */
type StreamDecoded = DecodedRun & { incomplete?: string };

function decode(text: string): StreamDecoded {
  const codec = codecs.get(CODEC);
  if (codec === undefined) throw new Error(`no codec is registered as ${CODEC}`);
  const out = codec.parse(text);
  if (out instanceof Promise) throw new Error(`${CODEC} must decode synchronously (§S1); parse answered a Promise`);
  return out as StreamDecoded;
}

/** The stream of `lines`, each newline-terminated. */
function stream(...lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

const runStart = (total?: number): string =>
  JSON.stringify({ event: "run-start", ...(total !== undefined ? { total } : {}) });

const testEnd = (fields: Record<string, unknown>): string => JSON.stringify({ event: "test-end", ...fields });

const runEnd = (total: number, passed: number, failed: number, pending: number, durationMs?: number): string =>
  JSON.stringify({
    event: "run-end",
    total,
    passed,
    failed,
    pending,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
  });

/** The `incomplete` reasons, in order; [] when the key is absent. */
function reasons(out: StreamDecoded): string[] {
  return out.incomplete === undefined ? [] : out.incomplete.split("; ");
}

// ── Registration ────────────────────────────────────────────────────────────

describe("crucible-events is registered as a stream codec", () => {
  test("codecs.get('crucible-events') is a codec marked stream: true, and junit and playwright are not stream codecs", () => {
    const codec = codecs.get(CODEC);
    expect(codec).toBeDefined();
    expect(codec?.stream).toBe(true);
    expect(codecs.get("junit")?.stream).not.toBe(true);
    expect(codecs.get("playwright")?.stream).not.toBe(true);
  });

  test("its parse answers synchronously — the decoded run, never a Promise", () => {
    const codec = codecs.get(CODEC);
    expect(codec).toBeDefined();
    const out = codec?.parse(stream(runStart(1), testEnd({ name: "only", status: "pass", duration_ms: 4 }), runEnd(1, 1, 0, 0, 4)));
    expect(out instanceof Promise).toBe(false);
    expect((out as StreamDecoded).summary).toEqual({ total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 4 });
  });
});

// ── Suites and leaves ───────────────────────────────────────────────────────

describe("crucible-events builds one suite node per distinct suite and one leaf per test-end", () => {
  test("suites are kept in first-seen order, a suite seen again joins its first node, and a blank or missing suite joins '?'", () => {
    const out = decode(
      stream(
        runStart(5),
        testEnd({ name: "b1", suite: "beta", status: "pass", duration_ms: 1 }),
        testEnd({ name: "a1", suite: "alpha", status: "fail", duration_ms: 2, failure: { message: "boom", type: "E" } }),
        testEnd({ name: "b2", suite: "beta", status: "pending", duration_ms: 3 }),
        testEnd({ name: "n1", suite: "  ", status: "pass", duration_ms: 4 }),
        testEnd({ name: "n2", status: "pass", duration_ms: 5 }),
        runEnd(5, 3, 1, 1, 15),
      ),
    );
    expect(out.tree).toEqual([
      {
        name: "beta",
        status: "pass",
        children: [
          { name: "b1", status: "pass", duration_ms: 1 },
          { name: "b2", status: "pending", duration_ms: 3 },
        ],
      },
      {
        name: "alpha",
        status: "fail",
        children: [{ name: "a1", status: "fail", duration_ms: 2, failure: { message: "boom", type: "E" } }],
      },
      {
        name: "?",
        status: "pass",
        children: [
          { name: "n1", status: "pass", duration_ms: 4 },
          { name: "n2", status: "pass", duration_ms: 5 },
        ],
      },
    ]);
    expect(out.summary).toEqual({ total: 5, passed: 3, failed: 1, pending: 1, duration_ms: 15 });
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("each test-end is one leaf in stream order — a repeated id is counted each time, as a retrying runner emits it", () => {
    const out = decode(
      stream(
        runStart(2),
        testEnd({ id: "x", name: "flaky", suite: "s", status: "fail", duration_ms: 1, failure: { message: "first try" } }),
        testEnd({ id: "x", name: "flaky", suite: "s", status: "pass", duration_ms: 2 }),
        runEnd(2, 1, 1, 0, 3),
      ),
    );
    expect(out.tree).toEqual([
      {
        name: "s",
        status: "fail",
        children: [
          { name: "flaky", status: "fail", duration_ms: 1, failure: { message: "first try" } },
          { name: "flaky", status: "pass", duration_ms: 2 },
        ],
      },
    ]);
    expect(out.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 3 });
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("a blank test name is the leaf '?', the name JUnit gives a blank case", () => {
    const out = decode(stream(testEnd({ name: "   ", suite: "s", status: "pass", duration_ms: 0 }), runEnd(1, 1, 0, 0, 0)));
    expect(out.tree.map((s) => s.children.map((c) => c.name))).toEqual([["?"]]);
  });

  test("a leaf's duration is rounded as JUnit rounds it — 2.4 ms is 2, 7.6 ms is 8", () => {
    const out = decode(
      stream(
        testEnd({ name: "short", suite: "s", status: "pass", duration_ms: 2.4 }),
        testEnd({ name: "long", suite: "s", status: "pass", duration_ms: 7.6 }),
        runEnd(2, 2, 0, 0, 10),
      ),
    );
    expect(out.tree[0]?.children.map((c) => c.duration_ms)).toEqual([2, 8]);
  });

  test("a failing leaf's failure is failureOf's reading — its message cut to 1000 characters", () => {
    const out = decode(
      stream(
        testEnd({ name: "f", suite: "s", status: "fail", duration_ms: 1, failure: { message: "m".repeat(1200), type: "T", trace: "t1\nt2" } }),
        runEnd(1, 0, 1, 0, 1),
      ),
    );
    expect(out.tree[0]?.children[0]?.failure).toEqual({ message: "m".repeat(1000), type: "T", trace: "t1\nt2" });
  });
});

// ── run-start and run-end ───────────────────────────────────────────────────

describe("crucible-events takes the last run-start and the last run-end", () => {
  test("the last run-end gives the totals and the duration — an earlier one that disagreed is no mismatch", () => {
    const out = decode(
      stream(
        testEnd({ name: "t1", suite: "s", status: "pass", duration_ms: 1 }),
        testEnd({ name: "t2", suite: "s", status: "pass", duration_ms: 1 }),
        runEnd(1, 1, 0, 0, 5),
        runEnd(2, 2, 0, 0, 42),
      ),
    );
    expect(out.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 42 });
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("an earlier run-end that agreed does not hide a last one that disagrees", () => {
    const out = decode(
      stream(
        testEnd({ name: "t1", suite: "s", status: "pass", duration_ms: 1 }),
        testEnd({ name: "t2", suite: "s", status: "pass", duration_ms: 1 }),
        runEnd(2, 2, 0, 0, 10),
        runEnd(3, 3, 0, 0, 11),
      ),
    );
    expect(out.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 11 });
    const why = reasons(out);
    expect(why.length).toBe(1);
    expect(why[0]).toMatch(/run-end/);
    expect(why[0]).toContain("3");
  });

  test("several run-starts are no leaves and no reason — the stream decodes from its test-ends alone", () => {
    const out = decode(
      stream(
        runStart(9),
        testEnd({ name: "t1", suite: "s", status: "pass", duration_ms: 1 }),
        runStart(2),
        testEnd({ name: "t2", suite: "s", status: "pass", duration_ms: 1 }),
        runEnd(2, 2, 0, 0, 2),
      ),
    );
    expect(out.tree).toEqual([
      {
        name: "s",
        status: "pass",
        children: [
          { name: "t1", status: "pass", duration_ms: 1 },
          { name: "t2", status: "pass", duration_ms: 1 },
        ],
      },
    ]);
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("with no run-end, the duration is the leaves' sum", () => {
    const out = decode(
      stream(
        testEnd({ name: "a", suite: "s", status: "pass", duration_ms: 2.4 }),
        testEnd({ name: "b", suite: "s", status: "fail", duration_ms: 7.6, failure: { message: "x" } }),
      ),
    );
    expect(out.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 10 });
  });

  test("a test-end after run-end is counted, and flags the stream as having a test after run-end", () => {
    const out = decode(
      stream(
        testEnd({ name: "t1", suite: "s", status: "pass", duration_ms: 1 }),
        runEnd(2, 2, 0, 0, 3),
        testEnd({ name: "late", suite: "s", status: "pass", duration_ms: 2 }),
      ),
    );
    expect(out.tree[0]?.children.map((c) => c.name)).toEqual(["t1", "late"]);
    expect(out.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 3 });
    const why = reasons(out);
    expect(why.length).toBe(1);
    expect(why[0]).toMatch(/after run-end/);
  });
});

// ── Line handling ───────────────────────────────────────────────────────────

describe("crucible-events skips what it does not know and counts what it cannot read", () => {
  test("a line whose event names no known kind is skipped silently — no leaf, no reason", () => {
    const out = decode(
      stream(
        runStart(1),
        JSON.stringify({ event: "step-end", title: "a step" }),
        JSON.stringify({ event: "suite-start", name: "s" }),
        testEnd({ name: "t", suite: "s", status: "pass", duration_ms: 1 }),
        runEnd(1, 1, 0, 0, 1),
      ),
    );
    expect(out.summary.total).toBe(1);
    expect(out.tree[0]?.children.map((c) => c.name)).toEqual(["t"]);
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("blank lines, empty or whitespace, are ignored — not counted as undecodable", () => {
    const text = `\n\n${runStart(1)}\n   \n${testEnd({ name: "t", suite: "s", status: "pass", duration_ms: 1 })}\n\n${runEnd(1, 1, 0, 0, 1)}\n\n`;
    const out = decode(text);
    expect(out.summary).toEqual({ total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 });
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("a line that is not JSON, a known event missing a required key, and a key of the wrong type are each skipped and counted", () => {
    const out = decode(
      stream(
        runStart(1),
        "this is not json {",
        JSON.stringify({ event: "test-end", status: "pass" }),
        JSON.stringify({ event: "test-end", name: "n", status: "pass", duration_ms: "3" }),
        JSON.stringify({ event: "run-end", total: 1, passed: 1, failed: 0 }),
        JSON.stringify({ event: "run-start", total: "many" }),
        testEnd({ name: "kept", suite: "s", status: "pass", duration_ms: 1 }),
        runEnd(1, 1, 0, 0, 1),
      ),
    );
    expect(out.tree).toEqual([{ name: "s", status: "pass", children: [{ name: "kept", status: "pass", duration_ms: 1 }] }]);
    const why = reasons(out);
    expect(why.length).toBe(1);
    expect(why[0]).toMatch(/\b5 undecodable\b/);
  });

  test("the last line of a stream with no trailing newline is read as a complete line", () => {
    const text = `${stream(testEnd({ name: "t1", suite: "s", status: "pass", duration_ms: 1 }))}${runEnd(1, 1, 0, 0, 1)}`;
    const out = decode(text);
    expect(out.summary).toEqual({ total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 });
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("a last test-end with no trailing newline is a leaf", () => {
    const text = `${stream(testEnd({ name: "t1", suite: "s", status: "pass", duration_ms: 1 }), runEnd(2, 1, 1, 0, 3))}${testEnd({ name: "t2", suite: "s", status: "fail", duration_ms: 2, failure: { message: "no" } })}`;
    const out = decode(text);
    expect(out.tree[0]?.children.map((c) => c.name)).toEqual(["t1", "t2"]);
    expect(out.summary.total).toBe(2);
  });
});

// ── Files ───────────────────────────────────────────────────────────────────

describe("crucible-events counts files by JUnit's file rule", () => {
  test("files are the distinct non-blank file values with '\\' read as '/', else the suite name ('?' for none)", () => {
    const out = decode(
      stream(
        testEnd({ name: "a", suite: "S1", file: "src\\a.test.ts", status: "pass", duration_ms: 1 }),
        testEnd({ name: "b", suite: "S1", file: "src/a.test.ts", status: "pass", duration_ms: 1 }),
        testEnd({ name: "c", suite: "S2", file: "  ", status: "pass", duration_ms: 1 }),
        testEnd({ name: "d", status: "pass", duration_ms: 1 }),
        testEnd({ name: "e", suite: "S2", file: "b.ts", status: "pass", duration_ms: 1 }),
        runEnd(5, 5, 0, 0, 5),
      ),
    );
    expect([...(out.files ?? [])].sort()).toEqual(["?", "S2", "b.ts", "src/a.test.ts"]);
  });
});

// ── incomplete ──────────────────────────────────────────────────────────────

describe("crucible-events states why a stream cannot be trusted, in §S1's order", () => {
  test("a complete stream carries no incomplete key", () => {
    const out = decode(stream(runStart(1), testEnd({ name: "t", suite: "s", status: "pass", duration_ms: 1 }), runEnd(1, 1, 0, 0, 1)));
    expect(Object.hasOwn(out, "incomplete")).toBe(false);
  });

  test("a stream with no run-end is incomplete for that one reason", () => {
    const out = decode(stream(runStart(1), testEnd({ name: "t", suite: "s", status: "pass", duration_ms: 1 })));
    const why = reasons(out);
    expect(why.length).toBe(1);
    expect(why[0]).toMatch(/no run-end/);
    expect(out.summary.total).toBe(1);
  });

  test("run-end totals that differ from the tests' counts are a reason stating both figures", () => {
    const out = decode(
      stream(
        testEnd({ name: "p", suite: "s", status: "pass", duration_ms: 1 }),
        testEnd({ name: "f", suite: "s", status: "fail", duration_ms: 1, failure: { message: "x" } }),
        runEnd(7, 7, 0, 0, 2),
      ),
    );
    const why = reasons(out);
    expect(why.length).toBe(1);
    expect(why[0]).toMatch(/run-end/);
    expect(why[0]).toContain("7");
    expect(why[0]).toContain("2");
    expect(out.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 2 });
  });

  test("a run-end whose total agrees but whose passed and failed differ is a mismatch too", () => {
    const out = decode(
      stream(
        testEnd({ name: "p", suite: "s", status: "pass", duration_ms: 1 }),
        testEnd({ name: "f", suite: "s", status: "fail", duration_ms: 1, failure: { message: "x" } }),
        runEnd(2, 2, 0, 0, 2),
      ),
    );
    const why = reasons(out);
    expect(why.length).toBe(1);
    expect(why[0]).toMatch(/run-end/);
  });

  test("no run-end comes before N undecodable lines, joined by '; '", () => {
    const out = decode(
      stream(testEnd({ name: "t", suite: "s", status: "pass", duration_ms: 1 }), "garbage one", "garbage two"),
    );
    const why = reasons(out);
    expect(why.length).toBe(2);
    expect(why[0]).toMatch(/no run-end/);
    expect(why[1]).toMatch(/\b2 undecodable\b/);
  });

  test("a totals mismatch, then a test after run-end, then N undecodable lines, in that order", () => {
    const out = decode(
      stream(
        testEnd({ name: "t1", suite: "s", status: "pass", duration_ms: 1 }),
        runEnd(5, 5, 0, 0, 9),
        testEnd({ name: "t2", suite: "s", status: "pass", duration_ms: 1 }),
        "not json",
      ),
    );
    const why = reasons(out);
    expect(why.length).toBe(3);
    expect(why[0]).toMatch(/run-end/);
    expect(why[0]).toContain("5");
    expect(why[0]).toContain("2");
    expect(why[1]).toMatch(/after run-end/);
    expect(why[2]).toMatch(/\b1 undecodable\b/);
  });
});

// ── The shared reading ──────────────────────────────────────────────────────

describe("failureOf and suiteStatus, exported from src/codecs/junit.ts, are JUnit's reading", () => {
  test("failureOf cuts the message to 1000 characters and the trace to 8000, and keeps the type", () => {
    expect(junit.failureOf({ message: "m".repeat(1500), type: "E", trace: "t".repeat(9000) })).toEqual({
      message: "m".repeat(1000),
      type: "E",
      trace: "t".repeat(8000),
    });
  });

  test("failureOf falls back to the trace's first non-blank line when the message is absent or blank", () => {
    const absent = junit.failureOf({ trace: "\n\nfirst line\nsecond" });
    expect(absent.message).toBe("first line");
    expect(absent.trace?.trim()).toBe("first line\nsecond");
    const blank = junit.failureOf({ message: "   ", trace: "real cause\nat x" });
    expect(blank.message).toBe("real cause");
  });

  test("failureOf keeps only the parts present — nothing given is an empty failure", () => {
    expect(junit.failureOf({})).toEqual({});
    expect(junit.failureOf({ type: "E" })).toEqual({ type: "E" });
  });

  test("failureOf gives what JUnit stores for the same failure in a report", () => {
    const long = "x".repeat(1100);
    const withMessage = junit.parseJunit(
      `<testsuite name="s"><testcase name="t"><failure message="${long}" type="T">trace line\nmore</failure></testcase></testsuite>`,
    );
    expect(withMessage.tree[0]?.children[0]?.failure).toEqual(
      junit.failureOf({ message: long, type: "T", trace: "trace line\nmore" }),
    );
    const noMessage = junit.parseJunit(
      `<testsuite name="s"><testcase name="t"><failure type="T">first\n  second</failure></testcase></testsuite>`,
    );
    expect(noMessage.tree[0]?.children[0]?.failure).toEqual(junit.failureOf({ type: "T", trace: "first\n  second" }));
    expect(noMessage.tree[0]?.children[0]?.failure?.message).toBe("first");
  });

  test("suiteStatus is fail when a child failed, else pass", () => {
    const leaf = (status: TestLeaf["status"]): TestLeaf => ({ name: status, status, duration_ms: 0 });
    expect(junit.suiteStatus([leaf("pass"), leaf("fail")])).toBe("fail");
    expect(junit.suiteStatus([leaf("pass"), leaf("pending")])).toBe("pass");
    expect(junit.suiteStatus([leaf("pending")])).toBe("pass");
    expect(junit.suiteStatus([])).toBe("pass");
  });
});

// ── The source check: the shared reading is called, never copied ────────────

const SHARED = ["failureOf", "suiteStatus"] as const;

/** The body of `function <name>` (or the initialiser of `const <name> =`) in live code. */
function bodyOf(live: string, name: string): string | undefined {
  const declared = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(live);
  if (declared !== null) {
    const paramsEnd = balancedEnd(live, declared.index + declared[0].length - 1);
    const open = live.indexOf("{", paramsEnd);
    return open === -1 ? undefined : live.slice(open, balancedEnd(live, open));
  }
  const bound = new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=]*=`).exec(live);
  if (bound === null) return undefined;
  const start = bound.index + bound[0].length;
  return live.slice(start, unnestedEnd(live, start, ";"));
}

function exports(live: string, name: string): boolean {
  return (
    new RegExp(`\\bexport\\s+(?:function|const|let)\\s+${name}\\b`).test(live) ||
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(live)
  );
}

/** Value imports from "./junit.ts": imported name → local name. */
function junitImports(source: string): Map<string, string> {
  const text = jsUncommented(source);
  const found = new Map<string, string>();
  for (const m of text.matchAll(/\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*(["'])\.\/junit(?:\.ts)?\3/g)) {
    if (m[1] !== undefined) continue;
    for (const part of (m[2] ?? "").split(",")) {
      const spec = part.trim();
      if (spec.length === 0 || spec.startsWith("type ")) continue;
      const [imported, local] = spec.split(/\s+as\s+/);
      if (imported !== undefined) found.set(imported.trim(), (local ?? imported).trim());
    }
  }
  return found;
}

/**
 * What a junit.ts / crucible-events pair breaks of §S1's shared reading:
 * junit.ts exports both helpers and its `toFailure` / `toNode` use them; the
 * codec imports both from ./junit.ts as values and uses them outside the
 * import. Comments and string literals never count.
 */
function sharedReadingViolations(junitSource: string, codecSource: string): string[] {
  const violations: string[] = [];
  const junitLive = jsLiveCode(junitSource);
  for (const name of SHARED) {
    if (!exports(junitLive, name)) violations.push(`junit.ts does not export ${name}`);
  }
  for (const [fn, helper] of [
    ["toFailure", "failureOf"],
    ["toNode", "suiteStatus"],
  ] as const) {
    const body = bodyOf(junitLive, fn);
    if (body === undefined) violations.push(`junit.ts declares no ${fn}`);
    else if (!new RegExp(`\\b${helper}\\b`).test(body)) violations.push(`${fn} does not call ${helper}`);
  }
  const imported = junitImports(codecSource);
  const codecLive = jsLiveCode(codecSource).replace(/\bimport\b[^;]*;/g, "");
  for (const name of SHARED) {
    const local = imported.get(name);
    if (local === undefined) violations.push(`crucible-events does not import ${name} from ./junit.ts`);
    else if (!new RegExp(`\\b${local}\\b`).test(codecLive)) violations.push(`crucible-events does not call ${name}`);
  }
  return violations;
}

const SYNTHETIC_JUNIT_SHARED = `
export function failureOf(parts) { return { ...parts }; }
export function suiteStatus(children) { return children.some((c) => c.status === "fail") ? "fail" : "pass"; }
function toFailure(failureEl): NonNullable<TestLeaf["failure"]> {
  return failureOf({ message: failureEl.attrs["message"], type: failureEl.attrs["type"], trace: failureEl.text });
}
function toNode(name: string, cases: XmlElement[]): SuiteNode {
  const children = cases.map(toLeaf);
  return { name, status: suiteStatus(children), children };
}
`;

const SYNTHETIC_CODEC_SHARED = `
import type { DecodedRun } from "./index.ts";
import { failureOf, suiteStatus as statusOf } from "./junit.ts";
export function parseCrucibleEvents(text: string): DecodedRun {
  const leaf = { failure: failureOf({ message: "m" }) };
  return { tree: [{ name: "s", status: statusOf([leaf]), children: [leaf] }] };
}
`;

const SYNTHETIC_JUNIT_COPIED = `
export function failureOf(parts) { return { ...parts }; }
export function suiteStatus(children) { return children.some((c) => c.status === "fail") ? "fail" : "pass"; }
function toFailure(failureEl) {
  return failureOf({ message: failureEl.attrs["message"], trace: failureEl.text });
}
function toNode(name: string, cases: XmlElement[]): SuiteNode {
  // suiteStatus(children) is what this should call
  const children = cases.map(toLeaf);
  return { name, status: children.some((c) => c.status === "fail") ? "fail" : "pass", children };
}
`;

const SYNTHETIC_CODEC_COPIED = `
import { suiteStatus } from "./junit.ts";
function failureOf(parts) { return { message: String(parts.message).slice(0, 1000) }; }
const note = "failureOf( is not a call";
export function parseCrucibleEvents(text: string) {
  const leaf = { failure: failureOf({ message: text }) };
  return { tree: [{ name: "s", status: suiteStatus([leaf]), children: [leaf] }] };
}
`;

describe("a source check holds that JUnit and crucible-events share failureOf and suiteStatus", () => {
  test("proved on a synthetic pair that shares them: no violation, an aliased import included", () => {
    expect(sharedReadingViolations(SYNTHETIC_JUNIT_SHARED, SYNTHETIC_CODEC_SHARED)).toEqual([]);
  });

  test("proved on a synthetic pair that copies them: a toNode inlining the status and a codec with its own failureOf are both caught, a comment and a string not counting", () => {
    expect(sharedReadingViolations(SYNTHETIC_JUNIT_COPIED, SYNTHETIC_CODEC_COPIED)).toEqual([
      "toNode does not call suiteStatus",
      "crucible-events does not import failureOf from ./junit.ts",
    ]);
  });

  test("proved on a synthetic codec importing them as types only: neither counts as imported", () => {
    const typeOnly = `import type { failureOf, suiteStatus } from "./junit.ts";\nexport const x = 1;\n`;
    expect(sharedReadingViolations(SYNTHETIC_JUNIT_SHARED, typeOnly)).toEqual([
      "crucible-events does not import failureOf from ./junit.ts",
      "crucible-events does not import suiteStatus from ./junit.ts",
    ]);
  });

  test("src/codecs/junit.ts's toFailure and toNode call them, and src/codecs/crucible-events.ts imports and calls them", () => {
    expect(existsSync(CODEC_SOURCE), `${CODEC_SOURCE} — the crucible-events codec module`).toBe(true);
    const violations = sharedReadingViolations(
      readFileSync(JUNIT_SOURCE, "utf-8"),
      existsSync(CODEC_SOURCE) ? readFileSync(CODEC_SOURCE, "utf-8") : "",
    );
    expect(violations).toEqual([]);
  });
});
