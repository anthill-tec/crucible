// CR-CRU-015 §S3 — step definitions for tests/e2e/features/
// bdd-gherkin-section.feature: the Chromium-tier proof that the BDD tab
// renders the Gherkin of a run the SERVER decoded.
//
// Reuses navigation.steps.ts ("I open the workspace for that project"),
// workflow.steps.ts ("I click the {string} workspace tab") and
// seeding.steps.ts's agent step wherever they already say exactly what is
// needed — only the frontend-typed project, the raw-playwright ingest and the
// Gherkin assertions are new here. Every seeding/ingest call delegates to
// harness.ts, per that file's header rule.
//
// The rendered contract is the one tests/bdd-section.test.ts defines:
//   workspace-bdd > bdd-feature > bdd-feature-title
//                              > bdd-scenario > bdd-scenario-title
//                                            > bdd-step[data-bdd-status]
//                                                     > bdd-step-failure
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestPlaywright, PLAYWRIGHT_BDD_REPORT, seedProject } from "./harness.ts";

/** The feature's `|`-separated lists — one Gherkin line cannot be split on a
 *  comma, because step text contains commas. */
const parts = (list: string): string[] => list.split("|").map((s) => s.trim());

const section = (page: Page): Locator => page.getByTestId("workspace-bdd");

async function scenarioTitles(page: Page): Promise<string[]> {
  const scenarios = section(page).getByTestId("bdd-scenario");
  await expect(scenarios.first()).toBeVisible();
  const count = await scenarios.count();
  const titles: string[] = [];
  for (let i = 0; i < count; i++) {
    titles.push((await scenarios.nth(i).getByTestId("bdd-scenario-title").innerText()).trim());
  }
  return titles;
}

async function scenarioBlock(page: Page, title: string): Promise<Locator> {
  const scenarios = section(page).getByTestId("bdd-scenario");
  const titles = await scenarioTitles(page);
  const index = titles.indexOf(title);
  if (index < 0) {
    throw new Error(
      `the BDD section renders no scenario titled "${title}"; it renders ${JSON.stringify(titles)}`,
    );
  }
  return scenarios.nth(index);
}

Step("a frontend project named {string} is registered", async ({ request, world }, name: string) => {
  world.projectKey = await seedProject(request, name, "frontend");
});

Step(
  "a playwright BDD run is ingested for agent {string} on that project",
  async ({ request, world }, agentId: string) => {
    const res = await ingestPlaywright(
      request,
      world.projectKey as string,
      agentId,
      PLAYWRIGHT_BDD_REPORT,
    );
    world.eventId = res.event;
  },
);

Step("the BDD section shows the feature {string}", async ({ page }, title: string) => {
  const features = section(page).getByTestId("bdd-feature");
  // Exactly one: the run carries one feature, and the feature is named ONCE
  // (the codec's "<Feature> › <Scenario>" node name is split, not repeated).
  await expect(features).toHaveCount(1);
  await expect(features.getByTestId("bdd-feature-title")).toHaveText(title);
});

Step(
  "the BDD section shows the scenarios in order {string}",
  async ({ page }, list: string) => {
    expect(await scenarioTitles(page)).toEqual(parts(list));
  },
);

Step(
  "the steps of {string} read in order {string}",
  async ({ page }, scenario: string, list: string) => {
    const expected = parts(list);
    const steps = (await scenarioBlock(page, scenario)).getByTestId("bdd-step");
    // The COUNT is asserted with the order: a section that rendered the right
    // lines plus an invented one (a step after the break, say) would otherwise
    // still pass the per-index reads.
    await expect(steps).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      await expect(steps.nth(i)).toContainText(expected[i] as string);
    }
  },
);

Step(
  "every step of {string} reports outcome {string}",
  async ({ page }, scenario: string, outcome: string) => {
    const steps = (await scenarioBlock(page, scenario)).getByTestId("bdd-step");
    const count = await steps.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(steps.nth(i)).toHaveAttribute("data-bdd-status", outcome);
    }
  },
);

Step(
  "the steps of {string} report outcomes {string}",
  async ({ page }, scenario: string, list: string) => {
    const expected = parts(list);
    const steps = (await scenarioBlock(page, scenario)).getByTestId("bdd-step");
    await expect(steps).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      await expect(steps.nth(i)).toHaveAttribute("data-bdd-status", expected[i] as string);
    }
  },
);

Step(
  "the step {string} of {string} carries the failure message {string}",
  async ({ page }, stepLine: string, scenario: string, message: string) => {
    const steps = (await scenarioBlock(page, scenario)).getByTestId("bdd-step");
    const broken = steps.filter({ hasText: stepLine });
    await expect(broken).toHaveCount(1);
    // The failure renders AT the step that broke — which step of the
    // specification failed is what a Gherkin report is read for.
    await expect(broken.getByTestId("bdd-step-failure")).toContainText(message);
    await expect(broken).toHaveAttribute("data-bdd-status", "fail");
  },
);

Step("no other step in the BDD section carries a failure", async ({ page }) => {
  await expect(section(page).getByTestId("bdd-step-failure")).toHaveCount(1);
});

Step("the BDD section shows no run cards and no ratio pills", async ({ page }) => {
  // The tab renders the SPECIFICATION, not a second Runs timeline and not a
  // tally of verdicts.
  await expect(section(page).getByTestId("event-card")).toHaveCount(0);
  await expect(section(page).getByTestId("ratio-pill")).toHaveCount(0);
});
