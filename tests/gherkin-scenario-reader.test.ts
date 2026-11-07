// The Gherkin scenario reader the e2e drive check takes its expectation from,
// pinned on its own: no browser, no board, no drive.
//
// The fixture holds one Scenario Outline with two Examples rows between two
// plain scenarios. Each Examples row is a scenario of its own, stored under
// `<feature> › <outline title>` (the outline's unfilled title) and named by
// its filled-in title, with its step lines filled in from the row, in order.
// A plain scenario sits under its feature and holds only its own steps —
// never an outline's, whether the outline comes after it or before it.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFeatureFile, parseFeatureSource } from "./helpers/gherkin-scenarios.ts";
import type { DeclaredScenario } from "./helpers/gherkin-scenarios.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "gherkin", "an-outline-beside-plain-scenarios.feature");

const FEATURE = "A shelf of jars";
const OUTLINE_TITLE = "a shelf of <count> <colour> jars weighs <weight> grams";
const OUTLINE_SUITE = `${FEATURE} › ${OUTLINE_TITLE}`;

const EMPTY_SHELF: DeclaredScenario = {
  feature: FEATURE,
  suite: FEATURE,
  scenario: "an empty shelf holds no jars",
  steps: ["Given an empty shelf", "When I count the jars on it", "Then there are 0 jars"],
  node: `${FEATURE} › an empty shelf holds no jars`,
};

const RED_JARS: DeclaredScenario = {
  feature: FEATURE,
  suite: OUTLINE_SUITE,
  scenario: "a shelf of 2 red jars weighs 100 grams",
  steps: [
    "Given a shelf with 2 red jars",
    "And each jar weighs 50 grams",
    "When I weigh the shelf",
    "Then it weighs 100 grams",
    'And the label still reads "<label>"',
  ],
  node: `${OUTLINE_SUITE} › a shelf of 2 red jars weighs 100 grams`,
};

const BLUE_JARS: DeclaredScenario = {
  feature: FEATURE,
  suite: OUTLINE_SUITE,
  scenario: "a shelf of 3 blue jars weighs 120 grams",
  steps: [
    "Given a shelf with 3 blue jars",
    "And each jar weighs 40 grams",
    "When I weigh the shelf",
    "Then it weighs 120 grams",
    'And the label still reads "<label>"',
  ],
  node: `${OUTLINE_SUITE} › a shelf of 3 blue jars weighs 120 grams`,
};

const FULL_SHELF: DeclaredScenario = {
  feature: FEATURE,
  suite: FEATURE,
  scenario: "a full shelf takes no more jars",
  steps: ["Given a shelf with 12 jars", "When I add a jar", "Then the shelf refuses it"],
  node: `${FEATURE} › a full shelf takes no more jars`,
};

describe("the Gherkin scenario reader expands a Scenario Outline beside plain scenarios", () => {
  test("the fixture reads as four scenarios in file order: the plain one, the outline's two examples, the plain one", () => {
    expect(parseFeatureFile(FIXTURE)).toEqual([EMPTY_SHELF, RED_JARS, BLUE_JARS, FULL_SHELF]);
  });

  test("each Examples row is a scenario under the outline's unfilled title, named by its filled-in title", () => {
    const examples = parseFeatureFile(FIXTURE).filter((scenario) => scenario.suite !== FEATURE);
    expect(examples.map(({ suite, scenario, node }) => ({ suite, scenario, node }))).toEqual([
      { suite: OUTLINE_SUITE, scenario: RED_JARS.scenario, node: RED_JARS.node },
      { suite: OUTLINE_SUITE, scenario: BLUE_JARS.scenario, node: BLUE_JARS.node },
    ]);
    // NEGATIVE — the outline itself is no scenario: nothing is named by its
    // unfilled title.
    const names = parseFeatureFile(FIXTURE).map((scenario) => scenario.scenario);
    expect(names).not.toContain(OUTLINE_TITLE);
  });

  test("an example's steps are the outline's step lines in order, filled in from its own row, with cells trimmed", () => {
    const [, red, blue] = parseFeatureFile(FIXTURE);
    expect(red?.steps).toEqual(RED_JARS.steps);
    // The second row's cells are padded in the table; the filled-in steps
    // carry the values, never the padding.
    expect(blue?.steps).toEqual(BLUE_JARS.steps);
  });

  test("a placeholder naming no Examples column stays as written in the filled-in step", () => {
    const examples = parseFeatureFile(FIXTURE).filter((scenario) => scenario.suite === OUTLINE_SUITE);
    expect(examples.map((scenario) => scenario.steps.at(-1))).toEqual([
      'And the label still reads "<label>"',
      'And the label still reads "<label>"',
    ]);
  });

  test("the plain scenario before the outline holds only its own three steps, none of the outline's", () => {
    const before = parseFeatureFile(FIXTURE).find((scenario) => scenario.node === EMPTY_SHELF.node);
    expect(before).toEqual(EMPTY_SHELF);
    expect(before?.steps).toHaveLength(3);
  });

  test("the plain scenario after the outline sits under its feature and holds only its own three steps", () => {
    const after = parseFeatureFile(FIXTURE).find((scenario) => scenario.node === FULL_SHELF.node);
    expect(after).toEqual(FULL_SHELF);
    // NEGATIVE — no Examples row became a step or a scenario of its own
    // after the outline.
    expect(after?.steps.some((step) => step.includes("|"))).toBe(false);
  });

  test("a feature with plain scenarios only reads each under its feature with its own steps, as before", () => {
    const source = [
      "Feature: Plain only",
      "  Scenario: one",
      "    Given a",
      "    Then b",
      "  Scenario: two",
      "    When c",
    ].join("\n");
    expect(parseFeatureSource(source)).toEqual([
      { feature: "Plain only", suite: "Plain only", scenario: "one", steps: ["Given a", "Then b"], node: "Plain only › one" },
      { feature: "Plain only", suite: "Plain only", scenario: "two", steps: ["When c"], node: "Plain only › two" },
    ]);
  });
});
