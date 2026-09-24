// CR-CRU-145 §S2/§S4 (cycle 511, RED) — step definitions for the ADDED
// scenario in tests/e2e/features/bdd-gherkin-section.feature: "the BDD index
// lists a run and opens its Gherkin at the shared run detail route".
//
// Reuses navigation.steps.ts / workflow.steps.ts / seeding.steps.ts / this
// feature's own bdd-gherkin-section.steps.ts ("the BDD section shows the
// feature …", "the steps of … read in order …") wherever they already say
// exactly what is needed — only the INDEX-specific steps are new here.
//
// TESTIDS ASSERTED (declared in tests/bdd-index.test.ts and this file
// together, since the AC names none): `[data-testid="bdd-index-row"]`
// (one per BDD-bearing run, `data-run-id` carries the event id), a click
// navigates via the SAME `/p/<key>/run/<id>` route CR-CRU-016 §S3 already
// defines for the Runs pane and the Workflow chain.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step("the BDD index shows exactly one row for that run", async ({ page, world }) => {
  const rows = page.getByTestId("bdd-index-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-run-id", world.eventId as string);
});

Step("I open that run from the BDD index", async ({ page }) => {
  await page.getByTestId("bdd-index-row").first().click();
});

Step("the address bar shows that run's own route", async ({ page, world }) => {
  const expected = `/p/${world.projectKey as string}/run/${world.eventId as string}`;
  await expect(page).toHaveURL(new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByTestId("run-overlay")).toBeVisible();
});
