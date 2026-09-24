// CR-CRU-145 §S2/§S4 (cycle 511, RED) — step definitions for the ADDED
// scenario in tests/e2e/features/bdd-gherkin-section.feature: "the BDD index
// lists a run and opens its Gherkin at the shared run detail route".
//
// Reuses navigation.steps.ts / workflow.steps.ts / seeding.steps.ts /
// bdd-gherkin-section.steps.ts's own project/agent/ingest steps wherever
// they already say exactly what is needed.
//
// DOES NOT reuse bdd-gherkin-section.steps.ts's "the BDD section shows the
// feature …" / "the steps of … read in order …" — CORRECTED against C2
// GREEN (a25ff4e, landed after this file's original draft): those assert
// `[data-testid="workspace-bdd"]` > `bdd-feature`/`bdd-scenario`/`bdd-step`,
// the RETIRED `BddFeed` component's own testids (§S4 AC1 — gone once GREEN
// lands). §S1's run detail (the ONE renderer this index hands off to) draws
// with the drill-in's OWN, pre-existing testids instead — `feature-group`,
// `suite-row`, `leaf-row` (public/app.js RunDetailBody/SpecFeatures/
// SuiteGroup) — so this file declares its OWN two run-detail-scoped steps
// below rather than reusing ones that assert a surface this CR deletes.
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

// §S1's run detail: a spec run's features render as `feature-group` nodes
// (public/app.js SpecFeatures), each carrying `data-feature-name`. This run
// carries exactly one feature.
Step("the run detail shows the feature {string}", async ({ page }, title: string) => {
  const overlay = page.getByTestId("run-overlay");
  const features = overlay.getByTestId("feature-group");
  await expect(features).toHaveCount(1);
  await expect(features).toHaveAttribute("data-feature-name", title);
});

// A scenario's steps render as `leaf-row` nodes inside its `suite-row`'s
// sibling leaf list (public/app.js SuiteGroup) — loaded with NO click for a
// scenario §S1's progressive-expansion rule opens on arrival (this run's
// only feature has just 2 scenarios, both within SPEC_FIRST_OPEN's window).
Step(
  "the steps of {string} read in order at the run detail {string}",
  async ({ page }, scenario: string, list: string) => {
    const expected = list.split("|").map((s) => s.trim());
    const overlay = page.getByTestId("run-overlay");
    const suiteRow = overlay.getByTestId("suite-row").filter({ hasText: scenario });
    await expect(suiteRow).toHaveCount(1);
    const group = suiteRow.locator("xpath=..");
    const leaves = group.getByTestId("leaf-row");
    await expect(leaves).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      await expect(leaves.nth(i)).toContainText(expected[i] as string);
    }
  },
);
