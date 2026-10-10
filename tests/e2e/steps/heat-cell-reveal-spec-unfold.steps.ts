// CR-CRU-159 C2 — heat-strip reveal steps: the spec-run FEATURE UNFOLD
// (G5/AC3). Reuses tests/e2e/steps/heat-cell-reveal.steps.ts's existing
// click/assert steps verbatim (data-testid="heat-strip"/"suite-row"/
// "leaf-row" are the SAME regardless of plain vs spec run, G6 in the CR's
// own Gap analysis) and tests/e2e/steps/drillin.steps.ts's "I open the run
// overlay..."/"I expand the {string} suite row..."/"a failure box is
// visible and contains {string}" — only the spec-run ingest fixtures and the
// feature-fold/open steps are new here.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import {
  ingestPlaywright,
  playwrightFeaturesReport,
  playwrightFillerFeatures,
  type PwFeatureFixture,
} from "./harness.ts";

function overlayOf(page: Page): Locator {
  return page.getByTestId("run-overlay");
}

function featureGroupOf(page: Page, title: string): Locator {
  return overlayOf(page).locator(`[data-testid="feature-group"][data-feature-name="${title}"]`);
}

// ── Given — seed a spec (playwright-codec) run shaped for a C2 scenario ────

Step(
  "a spec run is ingested for agent {string} with a failing feature {string} kept open and a feature {string} refolded after load, holding a passing leaf {string} and a failing leaf {string}",
  async (
    { request, world },
    agentId: string,
    keptOpenFeature: string,
    refoldFeature: string,
    passingLeaf: string,
    failingLeaf: string,
  ) => {
    const features: PwFeatureFixture[] = [
      {
        title: keptOpenFeature,
        scenarios: [
          {
            title: `${keptOpenFeature} › its own failing scenario`,
            status: "failed",
            steps: [
              { title: `${keptOpenFeature}-anchor-given` },
              {
                title: `${keptOpenFeature}-anchor-then`,
                error: { message: `${keptOpenFeature}-anchor-failure` },
              },
            ],
          },
        ],
      },
      {
        title: refoldFeature,
        scenarios: [
          {
            title: "mixed outcome scenario",
            status: "failed",
            steps: [
              { title: passingLeaf },
              { title: failingLeaf, error: { message: `${failingLeaf}-failure` } },
            ],
          },
        ],
      },
    ];
    const xml = playwrightFeaturesReport(features);
    const res = await ingestPlaywright(request, world.projectKey as string, agentId, xml, "e2e");
    world.eventId = res.event;
  },
);

Step(
  "a spec run is ingested for agent {string} with a failing feature {string} kept open, {int} folded filler features, and an all-green feature {string} below the fold holding scenario {string}",
  async (
    { request, world },
    agentId: string,
    keptOpenFeature: string,
    fillerCount: number,
    targetFeature: string,
    targetScenario: string,
  ) => {
    const features: PwFeatureFixture[] = [
      {
        title: keptOpenFeature,
        scenarios: [
          {
            title: `${keptOpenFeature} › its own failing scenario`,
            status: "failed",
            steps: [
              { title: `${keptOpenFeature}-anchor-given` },
              {
                title: `${keptOpenFeature}-anchor-then`,
                error: { message: `${keptOpenFeature}-anchor-failure` },
              },
            ],
          },
        ],
      },
      ...playwrightFillerFeatures(`${targetFeature}-filler`, fillerCount),
      {
        title: targetFeature,
        scenarios: [
          {
            title: targetScenario,
            status: "passed",
            steps: [{ title: `${targetScenario}-given` }, { title: `${targetScenario}-then` }],
          },
        ],
      },
    ];
    const xml = playwrightFeaturesReport(features);
    const res = await ingestPlaywright(request, world.projectKey as string, agentId, xml, "e2e");
    world.eventId = res.event;
  },
);

// ── When — fold/unfold a feature by hand ────────────────────────────────────

Step("I fold the feature {string}", async ({ page }, title: string) => {
  const group = featureGroupOf(page, title);
  await expect(group).toBeVisible();
  await group.getByTestId("feature-heading").click();
});

// ── Then — a feature's own open/folded state ────────────────────────────────

Step("the feature {string} is open", async ({ page }, title: string) => {
  await expect(featureGroupOf(page, title).getByTestId("feature-toggle")).toHaveText("▾");
});

Step("the feature {string} is folded", async ({ page }, title: string) => {
  await expect(featureGroupOf(page, title).getByTestId("feature-toggle")).toHaveText("▸");
});

// ── Then — the target leaf row's own failure box ────────────────────────────
// A spec run shows every failing step's message box inside its own row, so
// another open failing feature's box may come first in the overlay: the
// assertion is scoped to the target leaf row.

Step(
  "the leaf row for {string} has a failure box containing {string}",
  async ({ page }, leafName: string, text: string) => {
    const row = overlayOf(page).getByTestId("leaf-row").filter({ hasText: leafName });
    const failureBox = row.getByTestId("failure-box");
    await expect(failureBox).toBeVisible();
    await expect(failureBox).toContainText(text);
  },
);
