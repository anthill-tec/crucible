// Heat-strip reveal steps: the specification run's FEATURE UNFOLD. Each run
// is a playwright-bdd run streamed to the board in the scenario shape (a
// feature is a suite, a scenario its leaf carrying its steps) through the
// harness's `streamPlaywrightBdd`. Reuses heat-cell-reveal-scenario-shape
// .steps.ts's scenario-cell clicks and scenario-row assertions,
// heat-cell-reveal.steps.ts's leaf-row assertions and drillin.steps.ts's
// "I open the run overlay..." — only the seeds and the feature-fold/open
// steps are here.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import {
  bddFailingStep,
  bddPassingStep,
  streamPlaywrightBdd,
  type BddScenarioFixture,
} from "./harness.ts";

function overlayOf(page: Page): Locator {
  return page.getByTestId("run-overlay");
}

function featureGroupOf(page: Page, title: string): Locator {
  return overlayOf(page).locator(`[data-testid="feature-group"][data-feature-name="${title}"]`);
}

/** A failing feature's one scenario, failing at its second step. */
function keptOpenScenario(feature: string): BddScenarioFixture {
  return {
    feature,
    name: `${feature} keeps its own failing scenario`,
    status: "fail",
    steps: [bddPassingStep(`${feature}-anchor-given`), bddFailingStep(`${feature}-anchor-then`, `${feature}-anchor-failure`)],
    failure: { message: `${feature}-anchor-failure` },
  };
}

function calmScenario(feature: string, name: string): BddScenarioFixture {
  return { feature, name, status: "pass", steps: [bddPassingStep(`${name}-given`), bddPassingStep(`${name}-then`)] };
}

// ── Given — seed a specification run shaped for each reveal ─────────────────

Step(
  "a spec run is streamed for agent {string} with a failing feature {string} kept open and a failing feature {string} holding a passing scenario {string} and a failing scenario {string} whose step {string} breaks",
  async (
    { request, world },
    agentId: string,
    keptOpenFeature: string,
    refoldFeature: string,
    passingScenario: string,
    failingScenario: string,
    brokenStep: string,
  ) => {
    const scenarios: BddScenarioFixture[] = [
      keptOpenScenario(keptOpenFeature),
      calmScenario(refoldFeature, passingScenario),
      {
        feature: refoldFeature,
        name: failingScenario,
        status: "fail",
        steps: [bddPassingStep(`${failingScenario}-given`), bddFailingStep(brokenStep, `${brokenStep}-failure`)],
        failure: { message: `${brokenStep}-failure` },
      },
    ];
    const res = await streamPlaywrightBdd(request, world.projectKey as string, agentId, scenarios, "e2e");
    world.eventId = res.event;
  },
);

Step(
  "a spec run is streamed for agent {string} with a failing feature {string} kept open, {int} folded filler features, and an all-green feature {string} below the fold holding scenarios {string} and {string}",
  async (
    { request, world },
    agentId: string,
    keptOpenFeature: string,
    fillerCount: number,
    targetFeature: string,
    firstScenario: string,
    secondScenario: string,
  ) => {
    const scenarios: BddScenarioFixture[] = [
      keptOpenScenario(keptOpenFeature),
      ...Array.from({ length: fillerCount }, (_, i) => calmScenario(`Filler Feature ${i + 1}`, `filler ${i + 1} stays calm`)),
      calmScenario(targetFeature, firstScenario),
      calmScenario(targetFeature, secondScenario),
    ];
    const res = await streamPlaywrightBdd(request, world.projectKey as string, agentId, scenarios, "e2e");
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

// ── Then — the target step row's own failure box ────────────────────────────
// A spec run shows every failing step's message box inside its own row, so
// another open failing feature's box may come first in the overlay: the
// assertion is scoped to the target step row.

Step(
  "the leaf row for {string} has a failure box containing {string}",
  async ({ page }, leafName: string, text: string) => {
    const row = overlayOf(page).getByTestId("leaf-row").filter({ hasText: leafName });
    const failureBox = row.getByTestId("failure-box");
    await expect(failureBox).toBeVisible();
    await expect(failureBox).toContainText(text);
  },
);
