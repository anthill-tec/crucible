// CR-CRU-015 §S3 — step definitions for tests/e2e/features/
// bdd-gherkin-section.feature: the Chromium-tier proof that a run the SERVER
// decoded renders its Gherkin.
//
// MIGRATED (CR-CRU-145 §S4, orchestrator ruling at C3 GREEN): the BDD tab is
// now an index, and the Gherkin renders at the shared run detail the index
// hands off to. The assertions below keep their original strength and are
// scoped to that run detail's own testids:
//   run-overlay > feature-group > suite-row (+ its sibling leaf list)
//                                         > leaf-row.{pass|fail}
//                                                   > failure-box
// The index/route/feature steps live in bdd-index-navigation.steps.ts.
//
// Reuses navigation.steps.ts ("I open the workspace for that project"),
// workflow.steps.ts ("I click the {string} workspace tab") and
// seeding.steps.ts's agent step wherever they already say exactly what is
// needed. Every seeding/ingest call delegates to harness.ts, per that file's
// header rule.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestPlaywright, PLAYWRIGHT_BDD_REPORT, seedProject } from "./harness.ts";

/** The feature's `|`-separated lists — one Gherkin line cannot be split on a
 *  comma, because step text contains commas. */
const parts = (list: string): string[] => list.split("|").map((s) => s.trim());

const section = (page: Page): Locator => page.getByTestId("workspace-bdd");
const overlay = (page: Page): Locator => page.getByTestId("run-overlay");

/** A leaf row's outcome is a whole class token (`pass` / `fail` / `pending`). */
const outcomeClass = (outcome: string): RegExp => new RegExp(`(^|\\s)${outcome}(\\s|$)`);

/** The step rows of the ONE scenario titled `scenario`: its suite-row's
 *  sibling leaf list (public/app.js SuiteGroup). */
async function stepsOf(page: Page, scenario: string): Promise<Locator> {
  const row = overlay(page).getByTestId("suite-row").filter({ hasText: scenario });
  await expect(row).toHaveCount(1);
  return row.locator("xpath=..").getByTestId("leaf-row");
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

Step("the BDD section shows no run cards and no ratio pills", async ({ page }) => {
  // The index is not a second Runs timeline: it carries none of the
  // timeline's own card grammar.
  await expect(section(page).getByTestId("event-card")).toHaveCount(0);
  await expect(section(page).getByTestId("ratio-pill")).toHaveCount(0);
});

Step(
  "the run detail shows the scenarios in order {string}",
  async ({ page }, list: string) => {
    const expected = parts(list);
    const rows = overlay(page).getByTestId("suite-row");
    // The COUNT is asserted with the order, so an extra scenario fails too.
    await expect(rows).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const name = (await rows.nth(i).locator(".app-suite-name").innerText()).trim();
      const title = expected[i] as string;
      expect(name === title || name.endsWith(` › ${title}`), `scenario ${i}: "${name}"`).toBe(true);
    }
  },
);

Step(
  "every step of {string} reports outcome {string} at the run detail",
  async ({ page }, scenario: string, outcome: string) => {
    const steps = await stepsOf(page, scenario);
    const count = await steps.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(steps.nth(i)).toHaveClass(outcomeClass(outcome));
    }
  },
);

Step(
  "the steps of {string} report outcomes {string} at the run detail",
  async ({ page }, scenario: string, list: string) => {
    const expected = parts(list);
    const steps = await stepsOf(page, scenario);
    await expect(steps).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      await expect(steps.nth(i)).toHaveClass(outcomeClass(expected[i] as string));
    }
  },
);

Step(
  "the step {string} of {string} carries the failure message {string} at the run detail",
  async ({ page }, stepLine: string, scenario: string, message: string) => {
    const broken = (await stepsOf(page, scenario)).filter({ hasText: stepLine });
    await expect(broken).toHaveCount(1);
    // The failure renders AT the step that broke — which step of the
    // specification failed is what a Gherkin report is read for.
    await expect(broken.getByTestId("failure-box")).toContainText(message);
    await expect(broken).toHaveClass(outcomeClass("fail"));
  },
);

Step("no other step at the run detail carries a failure", async ({ page }) => {
  await expect(overlay(page).getByTestId("failure-box")).toHaveCount(1);
});
