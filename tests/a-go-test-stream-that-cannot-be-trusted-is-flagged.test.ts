// A go run's record is checked at its close. At codec level (the codec the
// registry holds, given the run start's total as the board gives it), and over
// real HTTP (`startServer`, port 0, ":memory:"), the run is flagged
// `incomplete`, each reason stated, when:
//  - a top-level test started (`run`) but never reached a terminal event, for
//    itself or a subtest: the reason names it;
//  - the run start's total (the listed top-level `Test*`, `Fuzz*` and
//    `Example*` names) is above the top-level names that reached a terminal
//    event, for themselves or a subtest: the reason states both figures;
//  - it holds an undecodable line;
//  - it was cut at `ingest_body_bytes`.
// A whole run is not flagged, even when its subtests outnumber its total, and a
// benchmark that reaches no terminal event is not a test that never reported.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import {
  beforeLine,
  byCodePoint,
  closedGoTestRun,
  decodeGoTest,
  fixture,
  FORMS,
  terminalTestEvents,
} from "./helpers/go-test-harness.ts";
import { bootOn } from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "go-test-checker";

/** The distinct top-level names that reached a terminal event, for themselves or a subtest, in `text`. */
function topLevelReached(text: string): string[] {
  return [...new Set(terminalTestEvents(text).map((e) => `${e.suite} ${e.name.split("/")[0]}`))].sort(byCodePoint);
}

const PA_TOP_LEVEL = 13;

for (const form of FORMS) {
  describe(`a whole go stream is not flagged — ${form.name}`, () => {
    test("pa.jsonl with its listed total of 13: 20 cases, more than the total, and no incomplete key", () => {
      expect(topLevelReached(fixture("pa.jsonl")).length).toBe(PA_TOP_LEVEL);
      const run = decodeGoTest(form.of(fixture("pa.jsonl")), { startTotal: PA_TOP_LEVEL });
      expect(run.summary.total).toBe(20);
      expect(Object.keys(run)).not.toContain("incomplete");
    });

    test("pa.jsonl with no start total: no incomplete key", () => {
      expect(Object.keys(decodeGoTest(form.of(fixture("pa.jsonl"))))).not.toContain("incomplete");
    });

    test("run-sub.jsonl with a total of 1: the top-level TestSubs reached through its subtest, no incomplete key", () => {
      const run = decodeGoTest(form.of(fixture("run-sub.jsonl")), { startTotal: 1 });
      expect(Object.keys(run)).not.toContain("incomplete");
    });

    test("nomatch.jsonl: a run of 0 cases, no incomplete key, nothing failed", () => {
      const run = decodeGoTest(form.of(fixture("nomatch.jsonl")), { startTotal: 0 });
      expect(run.summary).toMatchObject({ total: 0, passed: 0, failed: 0, pending: 0 });
      expect(run.tree).toEqual([]);
      expect(Object.keys(run)).not.toContain("incomplete");
    });

    test("bench.jsonl: benchmarks that started and reached no terminal event are not named", () => {
      const run = decodeGoTest(form.of(fixture("bench.jsonl")), { startTotal: 1 });
      expect(Object.keys(run)).not.toContain("incomplete");
    });
  });

  describe(`a go stream that cannot be trusted is flagged — ${form.name}`, () => {
    test("a top-level test that started and never ended is named: pa.jsonl cut before TestPar2's fail", () => {
      const text = beforeLine(fixture("pa.jsonl"), `"Action":"fail","Package":"example.com/mod/pa","Test":"TestPar2"`);
      const run = decodeGoTest(form.of(text));
      expect(typeof run.incomplete).toBe("string");
      expect(run.incomplete).toContain("TestPar2");
      // A test that reached its terminal event is not named.
      expect(run.incomplete).not.toContain("TestPar1");
      expect(run.incomplete).not.toContain("TestPass");
    });

    test("a listed total above the top-level names that reported: pa.jsonl with a total of 14 states 14 and 13", () => {
      const run = decodeGoTest(form.of(fixture("pa.jsonl")), { startTotal: PA_TOP_LEVEL + 1 });
      expect(typeof run.incomplete).toBe("string");
      expect(run.incomplete).toContain("14");
      expect(run.incomplete).toContain("13");
      // The cases are kept: the flag never drops what was decoded.
      expect(run.summary.total).toBe(20);
    });

    test("a panic that stops the package: subpanic.jsonl with a listed total of 3 reaches only TestOuter", () => {
      const run = decodeGoTest(form.of(fixture("subpanic.jsonl")), { startTotal: 3 });
      expect(typeof run.incomplete).toBe("string");
      expect(run.incomplete).toContain("3");
      expect(run.incomplete).not.toContain("TestOuter");
    });

    test("an undecodable line: the run states 1 undecodable line, its cases kept", () => {
      const run = decodeGoTest(form.of(fixture("run-sub.jsonl")) + "this is not json\n");
      expect(run.incomplete).toContain("1 undecodable line");
      expect(run.summary).toMatchObject({ total: 1, failed: 1 });
    });

    test("a stream cut at ingest_body_bytes says so", () => {
      const run = decodeGoTest(form.of(fixture("run-sub.jsonl")), { cut: true });
      expect(run.incomplete).toContain("cut at ingest_body_bytes");
    });
  });
}

describe("a go run closed over HTTP carries the codec's flag", () => {
  test("a whole pa.jsonl run with its total of 13: stored with no incomplete key", async () => {
    const run = await closedGoTestRun(boot(), AGENT, { stream: fixture("pa.jsonl"), startTotal: PA_TOP_LEVEL });
    expect(Object.keys(run.event)).not.toContain("incomplete");
  });

  test("a pa.jsonl run started with a total of 14: stored incomplete, stating 14 and 13", async () => {
    const run = await closedGoTestRun(boot(), AGENT, { stream: fixture("pa.jsonl"), startTotal: PA_TOP_LEVEL + 1 });
    expect(typeof run.event.incomplete).toBe("string");
    expect(run.event.incomplete as string).toContain("14");
    expect(run.event.incomplete as string).toContain("13");
    const warnings = (run.answer.body.warnings ?? []) as Array<{ code: string; detail: string }>;
    expect(warnings.filter((w) => w.code === "stream-incomplete").length).toBe(1);
  });
});
