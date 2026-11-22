// The Gherkin on disk, read as the expectation of a real e2e drive.
//
// A `.feature` file's scenarios as the board stores them once the suite has
// run: under which suite each one sits, by what name, and with which step
// lines in order. Pinned by tests/unit/gherkin-scenario-reader.test.ts.
//
// WHERE A SCENARIO SITS. The shipped Playwright reporter names a test's suite
// by its whole describe chain. A plain `Scenario:` is a test directly under
// its feature, so its suite is the `Feature:` title. A `Scenario Outline:` is
// a describe of its own holding one test per Examples row, so each example
// sits under `<feature> › <outline title>` — the outline's own title, its
// `<name>` placeholders left unfilled — and is named by its filled-in title.
// Measured on a real drive: the suite
//   "An agent's card keeps a long running file inside it › at the <band> band
//    a card whose message is one long token keeps it inside the card"
// holds the test
//   "at the phone band a card whose message is one long token keeps it inside
//    the card".
//
// HOW A ROW IS FILLED IN. Each `<name>` whose name is an Examples column is
// replaced by that row's cell; a `<name>` naming no column stays as written.
// That is how playwright-bdd fills an example's title and how Gherkin fills
// its step lines.
//
// WHAT THIS READER DOES NOT KNOW. The suite declares no `Background`, no
// step data table or doc string, no named or tagged Examples block, no
// `# title-format:` comment and no outline whose title names no column
// (playwright-bdd would name its examples `Example #<n>`). A feature that
// adds one of those needs this reader taught it first; the drive check reds
// until it is.
import { readFileSync } from "node:fs";

export interface DeclaredScenario {
  /** The `Feature:` title the scenario lives under. */
  feature: string;
  /** The suite the board stores it under: the feature for a plain scenario,
   *  `<feature> › <outline title>` for an outline's example. */
  suite: string;
  /** The test's name: the `Scenario:` title, or an outline's title with the
   *  row's values filled in. */
  scenario: string;
  /** Its step lines, verbatim and in order — `Given …`, `And …`, `Then …`,
   *  an outline's filled in with the row's values. playwright-bdd carries the
   *  keyword through into the step title, so this is the exact step name the
   *  stream carries. */
  steps: string[];
  /** `<suite> › <scenario>` — how a placed test is named. */
  node: string;
}

const STEP_LINE = /^(Given|When|Then|And|But)\s+\S/;
const PLACEHOLDER = /<(.+?)>/g;

/** The cells of one `| a | b |` table row, trimmed. */
function cellsOf(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** A template with every `<column>` replaced by that column's value; a
 *  placeholder naming no column stays as written. */
function fill(template: string, values: Map<string, string>): string {
  return template.replace(PLACEHOLDER, (match, name: string) => values.get(name) ?? match);
}

/** One Examples row of an outline, as the scenario it becomes. */
function exampleOf(outline: Outline, header: string[], cells: string[]): DeclaredScenario {
  const values = new Map(header.map((name, index) => [name, cells[index] ?? ""]));
  const suite = `${outline.feature} › ${outline.title}`;
  const scenario = fill(outline.title, values);
  return {
    feature: outline.feature,
    suite,
    scenario,
    steps: outline.steps.map((step) => fill(step, values)),
    node: `${suite} › ${scenario}`,
  };
}

interface Outline {
  feature: string;
  title: string;
  steps: string[];
  /** The current Examples block's column names, once its header is read. */
  header: string[] | undefined;
  /** Whether the lines being read are an Examples table. */
  inExamples: boolean;
}

/** One feature's scenarios, read from its Gherkin source. `#` comments and the
 *  feature's free-form description are not steps. */
export function parseFeatureSource(source: string): DeclaredScenario[] {
  const scenarios: DeclaredScenario[] = [];
  let feature = "";
  let plain: DeclaredScenario | undefined;
  let outline: Outline | undefined;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("Feature:")) {
      feature = line.slice("Feature:".length).trim();
      plain = undefined;
      outline = undefined;
      continue;
    }
    if (line.startsWith("Scenario:")) {
      const scenario = line.slice("Scenario:".length).trim();
      plain = { feature, suite: feature, scenario, steps: [], node: `${feature} › ${scenario}` };
      outline = undefined;
      scenarios.push(plain);
      continue;
    }
    if (line.startsWith("Scenario Outline:")) {
      const title = line.slice("Scenario Outline:".length).trim();
      outline = { feature, title, steps: [], header: undefined, inExamples: false };
      plain = undefined;
      continue;
    }
    if (outline !== undefined && line.startsWith("Examples:")) {
      outline.inExamples = true;
      outline.header = undefined;
      continue;
    }
    if (outline?.inExamples === true && line.startsWith("|")) {
      const cells = cellsOf(line);
      if (outline.header === undefined) {
        outline.header = cells;
        continue;
      }
      scenarios.push(exampleOf(outline, outline.header, cells));
      continue;
    }
    if (!STEP_LINE.test(line)) continue;
    if (outline !== undefined && !outline.inExamples) outline.steps.push(line);
    else if (plain !== undefined) plain.steps.push(line);
  }
  return scenarios;
}

/** One `.feature` file's scenarios. */
export function parseFeatureFile(path: string): DeclaredScenario[] {
  return parseFeatureSource(readFileSync(path, "utf8"));
}
