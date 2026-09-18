// CR-CRU-015 §S2's last acceptance criterion — "A failure in the suite's main
// body skips NOTHING. No Playwright project may depend on the main body,
// because a dependency-project failure makes Playwright skip every dependent
// and those scenarios then reach the board as nodes with no steps and no
// verdict — indistinguishable from a specification that ran and asserted
// nothing. The only permitted dependency is the single `@empty-db`-tagged
// ordering precondition. Asserted on the config's own dependency graph, so a
// later author cannot re-widen it back to `dependencies: ["chromium"]` and
// silently reintroduce childless nodes."
//
// A RAIL, AND BORN GREEN. C1 already narrowed the edge (see
// playwright.config.ts's `projects` stanza and its ORDERING comment), so every
// assertion below passes on this branch as it stands. It is written anyway,
// and declared as such, on the precedent tests/ci-toolchain-provisioning
// .test.ts states in its own header: the defect this guards against is not a
// missing feature but a REGRESSION that is invisible in test output — a
// skipped scenario ingests as a node with no steps, which reads exactly like a
// specification that asserted nothing. Nothing else in the suite would go red
// if the dependency were widened again.
//
// THE INVARIANT IS ASSERTED, NEVER A LIST OF NAMES: the subject is "nothing
// depends on the body", derived from the real config object and the real
// feature files, so adding a project or renaming one cannot false-fail this,
// and only re-widening a dependency can.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import playwrightConfig from "../playwright.config.ts";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FEATURES_DIR = path.join(REPO_ROOT, "tests/e2e/features");

/** The ONE ordering constraint this suite really has: shell-storyboard's F1
 *  asserts a database nothing has seeded, and states that precondition as a
 *  tag on the scenario that holds it. */
const ORDERING_TAG = "@empty-db";

/** Is this line a TAG LINE carrying the ordering tag? A Gherkin tag line is a
 *  whitespace-separated list of `@`-tokens, so the tag is matched as a TOKEN:
 *  a header sentence that merely NAMES the tag is not a tag (and documenting
 *  the mechanism must never red the rail that guards it), while a scenario
 *  that legitimately carries a second tag (`@empty-db @slow`) still is one. */
const isOrderingTagLine = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith("@") && trimmed.split(/\s+/).includes(ORDERING_TAG);
};

/** Titles Playwright would match `grep`/`grepInvert` against — one carrying
 *  the ordering tag, one an ordinary main-body scenario. */
const TAGGED_TITLE = `CR-CRU-006 shell — storyboard frames › F1 fresh forge — empty state ${ORDERING_TAG}`;
const UNTAGGED_TITLE = "CR-CRU-006 shell — storyboard frames › F2 a registered project lights its badge";

interface ProjectLike {
  name?: string;
  dependencies?: string[];
  grep?: RegExp | RegExp[];
  grepInvert?: RegExp | RegExp[];
  testMatch?: unknown;
  testIgnore?: unknown;
}

const projects = (playwrightConfig.projects ?? []) as ProjectLike[];

const asRegExps = (value: RegExp | RegExp[] | undefined): RegExp[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const matches = (value: RegExp | RegExp[] | undefined, title: string): boolean =>
  asRegExps(value).some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(title));

/** A project SELECTS the ordering precondition when its grep matches the
 *  tagged title and does not sweep up untagged ones with it. */
const selectsOrderingTag = (p: ProjectLike): boolean =>
  matches(p.grep, TAGGED_TITLE) && !matches(p.grep, UNTAGGED_TITLE);

/** Every `dependencies` entry in the whole config, de-duplicated. */
const dependencyTargets = (): string[] => [
  ...new Set(projects.flatMap((p) => p.dependencies ?? [])),
];

describe("CR-CRU-015 §S2 — nothing in the e2e suite depends on the main body (RAIL, born green)", () => {
  test("the ONE dependency target is the single @empty-db ordering precondition, and it depends on nothing itself", () => {
    // Non-vacuity: a config with one project, or none declaring a dependency,
    // would satisfy "no project depends on the body" by having no graph at all.
    expect(projects.length).toBeGreaterThan(1);
    const declaringProjects = projects.filter((p) => (p.dependencies ?? []).length > 0);
    expect(declaringProjects.length).toBeGreaterThan(0);

    // Exactly ONE project may be depended upon, and it is the tag-selecting
    // one. If a later author re-pins a feature with `dependencies:
    // ["chromium"]`, this set grows to two and this line fails.
    const targets = dependencyTargets();
    expect(targets.length).toBe(1);

    const targetName = targets[0] as string;
    const target = projects.find((p) => p.name === targetName);
    expect(target).toBeDefined();
    expect(selectsOrderingTag(target!)).toBe(true);

    // No chains: the precondition itself waits for nothing, so its own phase
    // is the first and a body failure cannot reach it either.
    expect(target!.dependencies ?? []).toEqual([]);

    // And every declared dependency really is that one project — asserted per
    // project so the message names the offender rather than a set size.
    for (const p of declaringProjects) {
      expect(p.dependencies).toEqual([targetName]);
    }
  });

  test("the ordering precondition is exactly one tagged scenario, and no other project can run it twice", () => {
    // The tag lives on ONE scenario in ONE feature file — "the single
    // `@empty-db`-tagged ordering precondition" is a fact about the features,
    // not only about the config.
    const featureFiles = readdirSync(FEATURES_DIR).filter((f) => f.endsWith(".feature"));
    expect(featureFiles.length).toBeGreaterThan(0);
    const tagged = featureFiles.filter((f) =>
      readFileSync(path.join(FEATURES_DIR, f), "utf8").split("\n").some(isOrderingTagLine),
    );
    expect(tagged.length).toBe(1);
    const taggedFile = tagged[0] as string;
    const occurrences = readFileSync(path.join(FEATURES_DIR, taggedFile), "utf8")
      .split("\n")
      .filter(isOrderingTagLine);
    expect(occurrences.length).toBe(1);

    // Exactly one project selects it, so the precondition is not executed by
    // two projects (which would seed the "empty" database before its own
    // second run).
    expect(projects.filter(selectsOrderingTag).length).toBe(1);

    // Every OTHER project must be unable to pick that scenario up: either it
    // inverts the tag, or its `testMatch` cannot match the spec file
    // playwright-bdd generates from the tagged feature.
    const generatedSpec = `${taggedFile}.spec.js`;
    for (const p of projects.filter((x) => !selectsOrderingTag(x))) {
      const invertsTag = matches(p.grepInvert, TAGGED_TITLE);
      const cannotMatchFile =
        p.testMatch instanceof RegExp && !p.testMatch.test(generatedSpec);
      expect(
        invertsTag || cannotMatchFile,
        `project "${p.name}" neither inverts ${ORDERING_TAG} nor excludes ${generatedSpec}, ` +
          "so it would run the ordering precondition a second time",
      ).toBe(true);
    }
  });
});
