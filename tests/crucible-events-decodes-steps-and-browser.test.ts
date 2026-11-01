// The `crucible-events` codec reads a scenario's steps and its browser:
//  - `test-end` takes two optional keys: `browser`, a non-empty string, and
//    `steps`, an array of `{name, status, duration_ms?, failure?}`;
//  - the decoder groups test-ends into suites by (`suite`, `browser`), in
//    first-seen order; `SuiteNode.browser` is set from the event, and a
//    test's steps become `TestLeaf.steps`;
//  - each step follows the rules a `test-end` does: its `failure` is kept only
//    when its status is `fail`, read through `failureOf` as `toLeaf` reads a
//    test's; its duration is rounded and defaults to 0;
//  - an ill-formed `steps` (not an array, an element not an object, a bad
//    name, status, duration or failure) or `browser` (empty, or not a string)
//    makes the line undecodable, so it is counted and stored as no test;
//  - the summary counts tests, never steps.
//
// Interface choice (stated for the orchestrator's ruling): `TestLeaf.steps`
// is `TestStep[]`, a step being `{name: string, status: "pass" | "fail" |
// "pending", duration_ms: number, failure?: {message?, type?, trace?}}` — the
// leaf's own shape without steps. A test-end with no `steps` key decodes to a
// leaf with no `steps` key, and one with no `browser` key to a suite with no
// `browser` key. The tests read `steps` through a local type, so the file
// typechecks before the field exists.
import { describe, expect, test } from "bun:test";
import { parseCrucibleEvents, readStreamLine } from "../src/codecs/crucible-events.ts";

/** One stream line: the event as one JSON object, newline-terminated. */
function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

interface StepView {
  name: string;
  status: string;
  duration_ms: number;
  failure?: Record<string, unknown>;
}

interface LeafView {
  name: string;
  steps?: StepView[];
  [key: string]: unknown;
}

/** The decoded tree's test at (suite, test), read through the local type; a missing one fails loudly. */
function leafAt(tree: ReadonlyArray<{ children: readonly unknown[] }>, suite: number, index: number): LeafView {
  const leaf = tree[suite]?.children[index];
  if (leaf === undefined) throw new Error(`the decoded tree holds no test ${index} in suite ${suite}`);
  return leaf as LeafView;
}

const CARD_STEPS = [
  { name: "Given a cart holding one book", status: "pass", duration_ms: 10 },
  { name: "When I pay by card", status: "pass", duration_ms: 15 },
  { name: "Then I see a receipt", status: "pass", duration_ms: 5 },
];

const CARD_FAILING_STEPS = [
  { name: "Given a cart holding one book", status: "pass", duration_ms: 10 },
  { name: "When I pay by card", status: "pass", duration_ms: 20 },
  {
    name: "Then I see a receipt",
    status: "fail",
    duration_ms: 10,
    failure: { message: "receipt missing", type: "AssertionError" },
  },
];

const VOUCHER_STEPS = [
  { name: "Given a voucher worth ten", status: "pass", duration_ms: 4 },
  { name: "When I redeem it", status: "pass", duration_ms: 6 },
];

/** Two scenarios of one feature, one of them run under two browsers, the firefox run failing at its last step. */
const TWO_BROWSER_STREAM =
  line({ event: "run-start", total: 3 }) +
  line({
    event: "test-end",
    id: "card-chromium",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 30,
    steps: CARD_STEPS,
  }) +
  line({
    event: "test-end",
    id: "card-firefox",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "firefox",
    status: "fail",
    duration_ms: 40,
    failure: { message: "receipt missing" },
    steps: CARD_FAILING_STEPS,
  }) +
  line({
    event: "test-end",
    id: "voucher-chromium",
    name: "Pay by voucher",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 10,
    steps: VOUCHER_STEPS,
  }) +
  line({ event: "run-end", total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 100 });

describe("a crucible-events stream with browser and steps decodes to suites keyed by (suite, browser), tests carrying their steps", () => {
  test("one feature run under two browsers is two suites in first-seen order, each naming its browser, each test carrying its steps in order", () => {
    const run = parseCrucibleEvents(TWO_BROWSER_STREAM);

    expect(run.tree as unknown).toEqual([
      {
        name: "Checkout",
        status: "pass",
        browser: "chromium",
        children: [
          { name: "Pay by card", status: "pass", duration_ms: 30, steps: CARD_STEPS },
          { name: "Pay by voucher", status: "pass", duration_ms: 10, steps: VOUCHER_STEPS },
        ],
      },
      {
        name: "Checkout",
        status: "fail",
        browser: "firefox",
        children: [
          {
            name: "Pay by card",
            status: "fail",
            duration_ms: 40,
            failure: { message: "receipt missing" },
            steps: CARD_FAILING_STEPS,
          },
        ],
      },
    ]);
    // NEGATIVE/bound — exactly two suites: the browser splits the feature, nothing else does.
    expect(run.tree).toHaveLength(2);
    expect(run.incomplete).toBeUndefined();
  });

  test("the same suite with and without a browser is two suites, the one without carrying no browser key and its test no steps key", () => {
    const run = parseCrucibleEvents(
      line({ event: "test-end", name: "adds", suite: "math", status: "pass", duration_ms: 1 }) +
        line({
          event: "test-end",
          name: "adds",
          suite: "math",
          browser: "webkit",
          status: "pass",
          duration_ms: 2,
          steps: [{ name: "Given two numbers", status: "pass", duration_ms: 2 }],
        }) +
        line({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0 }),
    );

    expect(run.tree.map((suite) => [suite.name, suite.browser ?? null])).toEqual([
      ["math", null],
      ["math", "webkit"],
    ]);
    expect(run.tree[0]).not.toHaveProperty("browser");
    expect(leafAt(run.tree, 0, 0)).not.toHaveProperty("steps");
    expect(leafAt(run.tree, 1, 0).steps).toEqual([
      { name: "Given two numbers", status: "pass", duration_ms: 2 },
    ]);
  });

  test("a step's duration is rounded and defaults to 0 when the step states none, as a test's does", () => {
    const run = parseCrucibleEvents(
      line({
        event: "test-end",
        name: "Pay by card",
        suite: "Checkout",
        browser: "chromium",
        status: "pass",
        duration_ms: 9,
        steps: [
          { name: "Given a cart", status: "pass", duration_ms: 3.6 },
          { name: "When I pay", status: "pass" },
        ],
      }),
    );

    expect(leafAt(run.tree, 0, 0).steps).toEqual([
      { name: "Given a cart", status: "pass", duration_ms: 4 },
      { name: "When I pay", status: "pass", duration_ms: 0 },
    ]);
  });
});

describe("a step's failure is kept only on a failing step", () => {
  test("a passing and a pending step drop the failure they state; a failing step keeps it, read as toLeaf reads a test's", () => {
    const run = parseCrucibleEvents(
      line({
        event: "test-end",
        name: "Pay by card",
        suite: "Checkout",
        browser: "chromium",
        status: "fail",
        duration_ms: 30,
        failure: { message: "boom" },
        steps: [
          { name: "Given a cart", status: "pass", duration_ms: 1, failure: { message: "stale note" } },
          { name: "When I pay", status: "fail", duration_ms: 2, failure: { trace: "  Error: boom\n    at pay (pay.ts:3:1)  " } },
          { name: "Then I see a receipt", status: "pending", duration_ms: 0, failure: { type: "Skipped" } },
        ],
      }),
    );

    const steps = leafAt(run.tree, 0, 0).steps;
    expect(steps).toEqual([
      { name: "Given a cart", status: "pass", duration_ms: 1 },
      {
        name: "When I pay",
        status: "fail",
        duration_ms: 2,
        failure: { message: "Error: boom", trace: "Error: boom\n    at pay (pay.ts:3:1)" },
      },
      { name: "Then I see a receipt", status: "pending", duration_ms: 0 },
    ]);
    expect(steps?.[0]).not.toHaveProperty("failure");
    expect(steps?.[2]).not.toHaveProperty("failure");
  });

  test("a failing step stating no failure carries an empty failure, as a failing test stating none does", () => {
    const run = parseCrucibleEvents(
      line({
        event: "test-end",
        name: "Pay by card",
        suite: "Checkout",
        browser: "chromium",
        status: "fail",
        steps: [{ name: "When I pay", status: "fail", duration_ms: 2 }],
      }),
    );

    const leaf = leafAt(run.tree, 0, 0);
    expect(leaf.failure).toEqual({});
    expect(leaf.steps).toEqual([{ name: "When I pay", status: "fail", duration_ms: 2, failure: {} }]);
  });
});

/** A well-formed scenario line, with one key replaced (or removed when `undefined`). */
function scenarioWith(overrides: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    event: "test-end",
    id: "card-chromium",
    name: "Pay by card",
    suite: "Checkout",
    file: "features/checkout.feature",
    browser: "chromium",
    status: "pass",
    duration_ms: 30,
    steps: [{ name: "Given a cart", status: "pass", duration_ms: 3 }],
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) if (value === undefined) delete fields[key];
  return fields;
}

const ILL_FORMED: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["steps is a string", { steps: "Given a cart" }],
  ["steps is an object, not an array", { steps: { name: "Given a cart", status: "pass" } }],
  ["steps is null", { steps: null }],
  ["a step is a string, not an object", { steps: ["Given a cart"] }],
  ["a step's name is not a string", { steps: [{ name: 7, status: "pass" }] }],
  ["a step's status is outside pass, fail, pending", { steps: [{ name: "Given a cart", status: "skipped" }] }],
  ["a step's duration is negative", { steps: [{ name: "Given a cart", status: "pass", duration_ms: -1 }] }],
  ["a step's duration is a string", { steps: [{ name: "Given a cart", status: "pass", duration_ms: "3" }] }],
  ["a step's failure is a string", { steps: [{ name: "When I pay", status: "fail", failure: "boom" }] }],
  ["a step's failure part is not a string", { steps: [{ name: "When I pay", status: "fail", failure: { message: 3 } }] }],
  ["a later step is ill-formed", { steps: [{ name: "Given a cart", status: "pass" }, { name: "When I pay", status: "ok" }] }],
  ["browser is empty", { browser: "" }],
  ["browser is a number", { browser: 7 }],
  ["browser is null", { browser: null }],
];

describe("an ill-formed steps or browser makes its line undecodable", () => {
  test("a well-formed line with browser and steps reads as a test-end naming its browser and steps", () => {
    const read = readStreamLine(JSON.stringify(scenarioWith({})));
    expect(read).toMatchObject({
      event: "test-end",
      name: "Pay by card",
      browser: "chromium",
      steps: [{ name: "Given a cart", status: "pass" }],
    });
  });

  for (const [why, override] of ILL_FORMED) {
    test(`undecodable when ${why}`, () => {
      expect(readStreamLine(JSON.stringify(scenarioWith(override)))).toEqual({ event: "undecodable" });
    });
  }

  test("a stream holding an ill-formed line stores it as no test and states it as one undecodable line", () => {
    const run = parseCrucibleEvents(
      line(scenarioWith({ id: "good", name: "Pay by voucher" })) +
        line(scenarioWith({ id: "bad", browser: "" })) +
        line({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0 }),
    );

    expect(run.tree.flatMap((suite) => suite.children.map((leaf) => leaf.name))).toEqual(["Pay by voucher"]);
    expect(run.summary.total).toBe(1);
    expect(run.incomplete).toBe("1 undecodable line");
  });
});

describe("the summary counts tests, not steps", () => {
  test("three scenarios of eight steps are counted as three tests, agreeing with a run-end stating three", () => {
    const run = parseCrucibleEvents(TWO_BROWSER_STREAM);

    expect(run.summary).toEqual({ total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 100 });
    // The steps are there to be miscounted: eight of them, under three tests.
    const steps = run.tree.flatMap((suite) => suite.children.flatMap((leaf) => (leaf as unknown as LeafView).steps ?? []));
    expect(steps).toHaveLength(8);
    expect(run.incomplete).toBeUndefined();
  });

  test("a run-end stating the step count instead of the test count is flagged as differing from the tests", () => {
    const text = TWO_BROWSER_STREAM.replace(
      line({ event: "run-end", total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 100 }),
      line({ event: "run-end", total: 8, passed: 7, failed: 1, pending: 0, duration_ms: 100 }),
    );
    const run = parseCrucibleEvents(text);

    expect(run.summary.total).toBe(3);
    expect(run.incomplete).toBe(
      "run-end states total 8, passed 7, failed 1, pending 0, the tests count total 3, passed 2, failed 1, pending 0",
    );
    expect(run.tree.flatMap((suite) => suite.children).every((leaf) => (leaf as unknown as LeafView).steps !== undefined)).toBe(true);
  });
});
