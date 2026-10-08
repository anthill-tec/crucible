// Steps for tests/e2e/features/project-landing-pane.feature — the landing
// pane's own identity markers. "I open the workspace for that project" and
// "the {string} tab is selected" are reused from navigation.steps.ts /
// drillin.steps.ts; only the pane-visibility assertions are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step("the roadmap pane is visible", async ({ page }) => {
  await expect(page.getByTestId("roadmap-zones")).toBeVisible();
});

Step("the roadmap pane is not visible", async ({ page }) => {
  await expect(page.getByTestId("roadmap-zones")).toHaveCount(0);
});

Step("the workflow pane is visible", async ({ page }) => {
  await expect(page.getByTestId("workflow-active")).toBeVisible();
});

Step("the workflow pane is not visible", async ({ page }) => {
  await expect(page.getByTestId("workflow-active")).toHaveCount(0);
});
