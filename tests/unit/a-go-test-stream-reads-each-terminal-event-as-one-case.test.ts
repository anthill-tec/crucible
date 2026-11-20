// How a `go test -json` stream's events read into cases under the `go-test`
// record stream codec, at codec level (the codec the registry holds), on
// captured real Go output in both forms it reaches the board in: Go 1.27's
// typed output (`OutputType`) and the text form an older toolchain writes.
//
//  - a case is each terminal `pass` / `fail` / `skip` event carrying a `Test`,
//    under its package (the suite is the `Package` import path, the case's name
//    the full `Test` value), less the parents the subtest rule drops; a skip is
//    stored as pending;
//  - subtests (`Test/sub`, nested `Test/a/b`) are counted, pass or fail; a
//    parent's `pass` is dropped once a subtest of it was recorded; a parent's
//    `fail` is its own case when it printed its own `error` output (or its own
//    panic output), or when none of its recorded subtests failed (`t.Fail()`
//    after passing subtests); otherwise it is dropped, its failing subtests
//    carrying the failure;
//  - a failing subtest fails its run.
//
// The text form's limit: without `OutputType` a `t.Log` line and a `t.Error`
// line have the same shape, so in the text form a parent with a failing
// subtest is dropped unless it panicked — its own `t.Error` beside a failing
// subtest is carried by the subtest's failure, never its own case. The typed
// form is exact (logs.jsonl, below).
//
// Each fixture's expected cases are computed from the fixture's own terminal
// events, and cross-checked against the `go test -v` run of the same tree.
import { describe, test, expect } from "bun:test";
import {
  byCodePoint,
  casesOf,
  decodeGoTest,
  fixture,
  FORMS,
  statusOf,
  terminalTestEvents,
  textFormOf,
  verboseResults,
  withoutTime,
} from "../helpers/go-test-harness.ts";

const PA = "example.com/mod/pa";
const PEX = "example.com/mod/pex";
const PSUBPANIC = "example.com/mod/psubpanic";
const PLOG = "example.com/mod/plog";

/** logs.jsonl's cases under the tests named `prefix` (the test and its subtests). */
function casesUnder(cases: readonly string[], prefix: string): string[] {
  return cases.filter((c) => c.startsWith(`${PLOG} :: ${prefix} `) || c.startsWith(`${PLOG} :: ${prefix}/`));
}

/** The cases a fixture's terminal events give, less the parents named in `dropped` (each `<suite> :: <name>`). */
function expectedCases(text: string, dropped: readonly string[]): string[] {
  const events = terminalTestEvents(text);
  for (const parent of dropped) {
    expect(events.some((e) => `${e.suite} :: ${e.name}` === parent), `${parent} is a terminal event of the fixture`).toBe(true);
  }
  return events
    .filter((e) => !dropped.includes(`${e.suite} :: ${e.name}`))
    .map((e) => `${e.suite} :: ${e.name} = ${statusOf(e.action)}`)
    .sort(byCodePoint);
}

/** The counts of `cases` (each `… = <status>`), as the run's summary states them. */
function countsOf(cases: readonly string[]): { total: number; passed: number; failed: number; pending: number } {
  const count = (status: string): number => cases.filter((c) => c.endsWith(`= ${status}`)).length;
  return { total: cases.length, passed: count("pass"), failed: count("fail"), pending: count("pending") };
}

/** pa.jsonl's parents the subtest rule drops: passes over recorded subtests, and fails over failing subtests with no output of their own. */
const PA_DROPPED = [
  `${PA} :: TestSubs`,
  `${PA} :: TestSubs/nest`,
  `${PA} :: TestParentAllPassSubs`,
  `${PA} :: TestParSubs`,
  `${PA} :: FuzzF`,
];

/** Asserts a fixture's terminal test events are the results its `go test -v` run reports, and answers their count. */
function agreesWithVerbose(jsonl: string, verbose: string): number {
  const names = terminalTestEvents(fixture(jsonl)).map((e) => e.name).sort(byCodePoint);
  expect(names, `${jsonl} against ${verbose}`).toEqual(verboseResults(fixture(verbose)));
  return names.length;
}

for (const form of FORMS) {
  describe(`a go-test stream's cases — ${form.name}`, () => {
    test("pa.jsonl: every terminal event with a Test is a case under its package, less the 5 dropped parents (20 cases)", () => {
      expect(agreesWithVerbose("pa.jsonl", "pa.verbose")).toBe(25);
      const text = form.of(fixture("pa.jsonl"));
      const expected = expectedCases(fixture("pa.jsonl"), PA_DROPPED);
      expect(expected.length).toBe(20);
      const run = decodeGoTest(text);
      expect(casesOf(run.tree)).toEqual(expected);
      expect(run.summary).toMatchObject(countsOf(expected));
      expect(run.summary).toMatchObject({ total: 20, passed: 12, failed: 6, pending: 2 });
    });

    test("pa.jsonl: one suite per package, named by its import path; pa fails, pex passes", () => {
      const run = decodeGoTest(form.of(fixture("pa.jsonl")));
      const suites = [...run.tree].sort((x, y) => byCodePoint(x.name, y.name)).map((s) => [s.name, s.status]);
      expect(suites).toEqual([
        [PA, "fail"],
        [PEX, "pass"],
      ]);
    });

    test("pa.jsonl: a skip is stored as pending — TestSkip and TestSubs/skipped", () => {
      const cases = casesOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree);
      expect(cases.filter((c) => c.endsWith("= pending"))).toEqual([
        `${PA} :: TestSkip = pending`,
        `${PA} :: TestSubs/skipped = pending`,
      ]);
    });

    test("pa.jsonl: nested subtests are counted by their full name, pass or fail; their parents are not cases", () => {
      const cases = casesOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree);
      expect(cases).toContain(`${PA} :: TestSubs/nest/deep = pass`);
      expect(cases).toContain(`${PA} :: TestSubs/nest/deep_bad = fail`);
      expect(cases).toContain(`${PA} :: TestSubs/bad = fail`);
      expect(cases).toContain(`${PA} :: TestSubs/ok = pass`);
      const names = cases.map((c) => c.split(" = ")[0]);
      expect(names).not.toContain(`${PA} :: TestSubs`);
      expect(names).not.toContain(`${PA} :: TestSubs/nest`);
    });

    test("pa.jsonl: a parent's pass is dropped once a subtest was recorded (TestParentAllPassSubs, TestParSubs, FuzzF), its subtests kept", () => {
      const cases = casesOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree);
      const names = cases.map((c) => c.split(" = ")[0]);
      for (const parent of ["TestParentAllPassSubs", "TestParSubs", "FuzzF"]) expect(names).not.toContain(`${PA} :: ${parent}`);
      expect(cases).toContain(`${PA} :: TestParentAllPassSubs/x = pass`);
      expect(cases).toContain(`${PA} :: TestParentAllPassSubs/y = pass`);
      expect(cases).toContain(`${PA} :: TestParSubs/s0 = pass`);
      expect(cases).toContain(`${PA} :: TestParSubs/s1 = pass`);
      expect(cases).toContain(`${PA} :: FuzzF/seed#0 = pass`);
    });

    test("pa.jsonl: a parent that printed its own error after a passing subtest is its own failing case", () => {
      const cases = casesOf(decodeGoTest(form.of(fixture("pa.jsonl"))).tree);
      expect(cases).toContain(`${PA} :: TestParentFailsBeyond = fail`);
      expect(cases).toContain(`${PA} :: TestParentFailsBeyond/ok = pass`);
    });

    test("failnomsg.jsonl: a parent's t.Fail() with no message after a passing subtest is its own failure, never a green run", () => {
      const text = fixture("failnomsg.jsonl");
      const run = decodeGoTest(form.of(text));
      expect(casesOf(run.tree)).toEqual(expectedCases(text, []));
      expect(casesOf(run.tree)).toEqual([`${PSUBPANIC} :: TestFailNoMsg = fail`, `${PSUBPANIC} :: TestFailNoMsg/a = pass`]);
      expect(run.summary).toMatchObject({ total: 2, passed: 1, failed: 1, pending: 0 });
    });

    test("run-sub.jsonl: a failing subtest fails its run, its parent dropped (1 case, failed)", () => {
      const text = fixture("run-sub.jsonl");
      const run = decodeGoTest(form.of(text));
      expect(casesOf(run.tree)).toEqual(expectedCases(text, [`${PA} :: TestSubs`]));
      expect(casesOf(run.tree)).toEqual([`${PA} :: TestSubs/bad = fail`]);
      expect(run.summary).toMatchObject({ total: 1, passed: 0, failed: 1, pending: 0 });
      expect(run.tree.map((s) => [s.name, s.status])).toEqual([[PA, "fail"]]);
    });

    test("subpanic.jsonl: a parent that printed its own panic output is kept beside its failing subtest (1 pass, 2 fail)", () => {
      const text = fixture("subpanic.jsonl");
      const run = decodeGoTest(form.of(text));
      expect(casesOf(run.tree)).toEqual(expectedCases(text, []));
      expect(casesOf(run.tree)).toEqual([
        `${PSUBPANIC} :: TestOuter = fail`,
        `${PSUBPANIC} :: TestOuter/boom = fail`,
        `${PSUBPANIC} :: TestOuter/ok = pass`,
      ]);
      expect(run.summary).toMatchObject({ total: 3, passed: 1, failed: 2, pending: 0 });
    });

    test("buildfail-mixed.jsonl: its 5 terminal test events plus one failing case for each failed package with no failing test (9 cases)", () => {
      expect(agreesWithVerbose("buildfail-mixed.jsonl", "all.verbose")).toBe(5);
      const text = fixture("buildfail-mixed.jsonl");
      const packageFailures = ["example.com/mod/pa", "example.com/mod/pbuild", "example.com/mod/pex", "example.com/mod/pmain"].map(
        (pkg) => `${pkg} :: ${pkg} = fail`,
      );
      const expected = [...expectedCases(text, []), ...packageFailures].sort(byCodePoint);
      const run = decodeGoTest(form.of(text));
      expect(casesOf(run.tree)).toEqual(expected);
      expect(run.summary).toMatchObject({ total: 9, passed: 4, failed: 5, pending: 0 });
    });

    test("cached.jsonl: two cached runs of pb, every result a passing case (4)", () => {
      const text = fixture("cached.jsonl");
      const run = decodeGoTest(form.of(text));
      expect(casesOf(run.tree)).toEqual(expectedCases(text, []));
      expect(run.summary).toMatchObject({ total: 4, passed: 4, failed: 0, pending: 0 });
    });

    test("Time is never required: pa.jsonl with no Time on any line reads the same 20 cases", () => {
      const run = decodeGoTest(withoutTime(form.of(fixture("pa.jsonl"))));
      expect(casesOf(run.tree)).toEqual(expectedCases(fixture("pa.jsonl"), PA_DROPPED));
      expect(Object.keys(run)).not.toContain("incomplete");
    });

    test("logs.jsonl: a parent that logs and then has a failing subtest is dropped, its subtest carrying the failure — the same cases in both forms", () => {
      const cases = casesOf(decodeGoTest(form.of(fixture("logs.jsonl"))).tree);
      expect(casesUnder(cases, "TestLogsThenFailingSub")).toEqual([`${PLOG} :: TestLogsThenFailingSub/bad = fail`]);
    });

    test("logs.jsonl: a test that logs and then errors is one failing case", () => {
      const cases = casesOf(decodeGoTest(form.of(fixture("logs.jsonl"))).tree);
      expect(casesUnder(cases, "TestLogThenError")).toEqual([`${PLOG} :: TestLogThenError = fail`]);
    });
  });
}

describe("a parent's own t.Error beside a failing subtest (logs.jsonl) — typed (OutputType, Go 1.27)", () => {
  test("the parent is its own failing case beside its failing subtest: 4 cases, all failed", () => {
    const text = fixture("logs.jsonl");
    const run = decodeGoTest(text);
    const cases = casesOf(run.tree);
    expect(casesUnder(cases, "TestOwnErrorAndFailingSub")).toEqual([
      `${PLOG} :: TestOwnErrorAndFailingSub = fail`,
      `${PLOG} :: TestOwnErrorAndFailingSub/bad = fail`,
    ]);
    expect(cases).toEqual(expectedCases(text, [`${PLOG} :: TestLogsThenFailingSub`]));
    expect(run.summary).toMatchObject({ total: 4, passed: 0, failed: 4, pending: 0 });
  });
});

describe("a parent's own t.Error beside a failing subtest (logs.jsonl) — text form (no OutputType, Go 1.26)", () => {
  test("the parent is dropped, its own error carried by the failing subtest: 3 cases, all failed", () => {
    const text = fixture("logs.jsonl");
    const run = decodeGoTest(textFormOf(text));
    const cases = casesOf(run.tree);
    expect(casesUnder(cases, "TestOwnErrorAndFailingSub")).toEqual([`${PLOG} :: TestOwnErrorAndFailingSub/bad = fail`]);
    expect(cases).toEqual(
      expectedCases(text, [`${PLOG} :: TestLogsThenFailingSub`, `${PLOG} :: TestOwnErrorAndFailingSub`]),
    );
    expect(run.summary).toMatchObject({ total: 3, passed: 0, failed: 3, pending: 0 });
    expect(run.tree.map((s) => [s.name, s.status])).toEqual([[PLOG, "fail"]]);
  });
});
