// CR-CRU-007 §S4 items 1 & 3 (density set, release 0.1.0) — pure-logic
// helpers for Density-mode rendering decisions.
//
// `L.foldSuites(suites)` and `L.digestFailures(leaves)` do not exist yet on
// public/app-logic.mjs. Same convention as tests/drill-in-mode.test.ts: a
// namespace import (`import * as AppLogic`) stays loadable even for a
// not-yet-exported name, so calling `AppLogic.foldSuites(...)` /
// `AppLogic.digestFailures(...)` fails at CALL time ("... is not a
// function") — that TypeError IS the RED signal here (bun test has no
// static type-check gate on this import).
//
// Contract this file defines for GREEN:
//   - foldSuites(suites): suites is an array of `{name, status, ...}`
//     suite-summary objects (the shape returned by the server's
//     `?depth=suites` response — see tests/v2-stream-paging.test.ts).
//     Returns the array of suite NAMES (strings, in input order) whose
//     `status === "fail"` — i.e. the suites Density mode should
//     auto-expand ("failures float"). When no suite has status "fail"
//     (a 0-failure run), returns `[]` — every suite folds ("green folds").
//     `status === "pending"` is NOT "fail" — pending-only suites fold too.
//   - digestFailures(leaves): leaves is an array of leaf objects
//     (`{name, status, failure？: {message, ...}}`). Groups leaves that
//     share an IDENTICAL `failure.message` into one digest entry; leaves
//     with a unique message (or no failure at all — pass/pending leaves)
//     pass through individually. Returns an array of:
//       - `{kind: "leaf", leaf}` for a non-grouped leaf (pass, pending, or
//         a fail whose message is unique among its siblings), in input
//         order;
//       - `{kind: "group", message, leaves, extraCount}` for 2+ failed
//         leaves sharing the same message — `leaves` is the full list of
//         grouped leaf objects (input order), `extraCount = leaves.length
//         - 1` (the "+N identical" label count, e.g. 4 identical leaves ->
//         extraCount 3, rendered as "+3 identical").
//     Never mutates the input array.
import { describe, test, expect } from "bun:test";
import * as AppLogic from "../public/app-logic.mjs";

interface SuiteSummaryFixture {
  name: string;
  status: "pass" | "fail" | "pending";
}

interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  failure?: { message: string };
}

describe("app-logic — foldSuites (§S4 item 1, failures float / green folds, pure)", () => {
  test("returns the names of suites with status 'fail', in input order", () => {
    const suites: SuiteSummaryFixture[] = [
      { name: "SuiteA", status: "pass" },
      { name: "SuiteB", status: "fail" },
      { name: "SuiteC", status: "fail" },
      { name: "SuiteD", status: "pass" },
    ];
    expect(AppLogic.foldSuites(suites)).toEqual(["SuiteB", "SuiteC"]);
  });

  test("a 0-failure run (all suites pass) returns an empty array — every suite folds", () => {
    const suites: SuiteSummaryFixture[] = [
      { name: "SuiteX", status: "pass" },
      { name: "SuiteY", status: "pass" },
    ];
    expect(AppLogic.foldSuites(suites)).toEqual([]);
  });

  test("bound: a 'pending' suite (no failures, not yet all-pass) is NOT auto-expanded — only 'fail' status expands", () => {
    const suites: SuiteSummaryFixture[] = [
      { name: "SuitePending", status: "pending" },
      { name: "SuitePass", status: "pass" },
    ];
    expect(AppLogic.foldSuites(suites)).toEqual([]);
  });

  test("never mutates the input array", () => {
    const suites: SuiteSummaryFixture[] = [{ name: "SuiteA", status: "fail" }];
    const copy = suites.map((s) => ({ ...s }));
    AppLogic.foldSuites(suites);
    expect(suites).toEqual(copy);
  });
});

describe("app-logic — digestFailures (§S4 item 3, failure digest, pure)", () => {
  test("4 leaves sharing an identical failure.message group into 1 entry with extraCount 3", () => {
    const leaves: LeafFixture[] = [
      { name: "leafA", status: "fail", failure: { message: "same message" } },
      { name: "leafB", status: "fail", failure: { message: "same message" } },
      { name: "leafC", status: "fail", failure: { message: "same message" } },
      { name: "leafD", status: "fail", failure: { message: "same message" } },
    ];
    const result = AppLogic.digestFailures(leaves);
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe("group");
    expect(result[0].message).toBe("same message");
    expect(result[0].leaves.length).toBe(4);
    expect(result[0].extraCount).toBe(3);
    expect(result[0].leaves.map((l) => l.name)).toEqual(["leafA", "leafB", "leafC", "leafD"]);
  });

  test("leaves with DIFFERENT failure messages do NOT group — each stays its own 'leaf' entry", () => {
    const leaves: LeafFixture[] = [
      { name: "leafE", status: "fail", failure: { message: "message one" } },
      { name: "leafF", status: "fail", failure: { message: "message two" } },
    ];
    const result = AppLogic.digestFailures(leaves);
    expect(result.length).toBe(2);
    expect(result.every((r) => r.kind === "leaf")).toBe(true);
    expect(result.map((r) => (r.kind === "leaf" ? r.leaf.name : null))).toEqual(["leafE", "leafF"]);
  });

  test("passing and pending leaves are always individual 'leaf' entries, never grouped with each other", () => {
    const leaves: LeafFixture[] = [
      { name: "leafPass1", status: "pass" },
      { name: "leafPass2", status: "pass" },
      { name: "leafPending1", status: "pending" },
    ];
    const result = AppLogic.digestFailures(leaves);
    expect(result.length).toBe(3);
    expect(result.every((r) => r.kind === "leaf")).toBe(true);
  });

  test("a mixed suite: a 3-way identical-message group + one uniquely-failing leaf + one pass leaf", () => {
    const leaves: LeafFixture[] = [
      { name: "g1", status: "fail", failure: { message: "grouped" } },
      { name: "g2", status: "fail", failure: { message: "grouped" } },
      { name: "g3", status: "fail", failure: { message: "grouped" } },
      { name: "unique", status: "fail", failure: { message: "solo failure" } },
      { name: "ok", status: "pass" },
    ];
    const result = AppLogic.digestFailures(leaves);
    expect(result.length).toBe(3);
    const group = result.find((r) => r.kind === "group");
    expect(group).toBeDefined();
    expect(group!.leaves.length).toBe(3);
    expect(group!.extraCount).toBe(2);
    const soloEntry = result.find((r) => r.kind === "leaf" && r.leaf.name === "unique");
    expect(soloEntry).toBeDefined();
    const passEntry = result.find((r) => r.kind === "leaf" && r.leaf.name === "ok");
    expect(passEntry).toBeDefined();
  });

  test("never mutates the input array", () => {
    const leaves: LeafFixture[] = [
      { name: "leafA", status: "fail", failure: { message: "same" } },
      { name: "leafB", status: "fail", failure: { message: "same" } },
    ];
    const copy = leaves.map((l) => ({ ...l }));
    AppLogic.digestFailures(leaves);
    expect(leaves).toEqual(copy);
  });
});
