// CR-CRU-160 §S2 — the burndown's F16 projection (today/P50/P80/target) and
// its refusal statement, as drawn by `burndownOptions`'s draw hook
// (public/app.js). Reuses seeding.steps.ts, roadmap.steps.ts's CR-queue
// registration, navigation.steps.ts, workflow.steps.ts, pane-scroll.steps.ts's
// "the viewport is {int}x{int}" and mobile-viewport.steps.ts's "I tap the
// roadmap release band" to reach the Analytics pane — only the mock-wiring
// and label-contract assertions below are new.
//
// THE OBSERVABLE CONTRACT THIS FILE REQUIRES GREEN TO EXPOSE (a canvas draws
// no DOM a test can read without asserting on pixels, which is forbidden):
//
//   `[data-testid="burndown-chart"]` (the existing host) carries
//   `data-burndown-forecast="dated"|"refused"`, reflecting `forecastDated(fc)`
//   for the render that produced the labels list below.
//
//   A sibling of the canvas, `[data-testid="burndown-chart-labels"]`,
//   rebuilt on every draw, holds one element per nameable thing the draw
//   hook decided about, each carrying:
//     - `data-label-kind`: "today" | "p50" | "p80" | "target" | "step" |
//        "more" | "refusal"
//     - `data-label-text`: the exact text (for "step", ALWAYS the step's
//        full label, `${sign}${points} · ${cr} ${event}`, regardless of
//        whether its own text was placed on the canvas this render)
//     - `data-label-drawn`: "true" when the canvas painted this label's own
//        text this render (today/p50/p80/target/more/refusal are "true"
//        whenever the item exists at all — §S3 says they are ALWAYS shown;
//        "step" is "true" only when not collision-skipped)
//
// AC4's plot-box/overlap/hover assertions (burndown-chart-labels-stay-
// inside-the-plot.steps.ts) add the position/hover half of this same
// contract; this file only needs the kind/text/drawn half.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import {
  mockDatedForecast,
  mockRefusedInsufficientHistory,
  mockRefusedUnpointed,
  type ProjectionLabelExpectations,
  type RefusalExpectation,
} from "./burndown-analytics-mock.ts";

Step(
  "the release's burndown and forecast are mocked with a dated forecast",
  async ({ page, world }) => {
    const labels = await mockDatedForecast(page, world.projectKey as string);
    world.expectedBurndownLabels = labels;
  },
);

Step(
  "the release's burndown and forecast are mocked with a forecast refused for insufficient history",
  async ({ page, world }) => {
    world.expectedRefusal = await mockRefusedInsufficientHistory(page, world.projectKey as string);
  },
);

Step(
  "the release's burndown and forecast are mocked with a forecast refused for unpointed CRs",
  async ({ page, world }) => {
    world.expectedRefusal = await mockRefusedUnpointed(page, world.projectKey as string);
  },
);

Step("the burndown chart states its forecast as {string}", async ({ page }, state: string) => {
  const chart = page.getByTestId("burndown-chart");
  await expect(chart).toHaveAttribute("data-burndown-forecast", state);
});

function labelItems(page: import("@playwright/test").Page, kind: string) {
  return page.locator(
    `[data-testid="burndown-chart-labels"] [data-label-kind="${kind}"]`,
  );
}

Step("the burndown chart draws the expected today, P50, P80 and target labels", async ({ page, world }) => {
  const expected = world.expectedBurndownLabels as ProjectionLabelExpectations;
  expect(typeof expected, "no dated-forecast fixture was mocked before this step").toBe("object");
  for (const [kind, text] of [
    ["today", expected.today],
    ["p50", expected.p50],
    ["p80", expected.p80],
    ["target", expected.target],
  ] as const) {
    const item = labelItems(page, kind).first();
    await expect(item, `no "${kind}" label was drawn`).toHaveAttribute("data-label-drawn", "true");
    await expect(
      item,
      `the "${kind}" label's text did not match the fixture's dated forecast`,
    ).toHaveAttribute("data-label-text", text);
  }
});

Step("the burndown chart shows the P50 and P80 band", async ({ page }) => {
  await expect(page.getByTestId("burndown-chart")).toHaveAttribute("data-burndown-band", "shown");
});

Step("the burndown chart hides the P50 and P80 band", async ({ page }) => {
  await expect(page.getByTestId("burndown-chart")).toHaveAttribute("data-burndown-band", "hidden");
});

Step("the burndown chart draws no P50 or P80 label", async ({ page }) => {
  await expect(labelItems(page, "p50")).toHaveCount(0);
  await expect(labelItems(page, "p80")).toHaveCount(0);
});

// A no-op "refused" stub that always prints the SAME static sentence for
// EVERY refusal kind would still pass a bare "a refusal label exists" check
// — so this asserts the label actually reflects what the mocked forecast
// answered: the real sample-week figures for `insufficient_history`, every
// real unpointed CR name for `unpointed` (see burndown-analytics-mock.ts's
// `mustContain`).
Step("the burndown chart draws a refusal label naming the real refusal it was answered", async ({ page, world }) => {
  const expected = world.expectedRefusal as RefusalExpectation;
  expect(typeof expected, "no refused-forecast fixture was mocked before this step").toBe("object");
  const item = labelItems(page, "refusal").first();
  await expect(item, "no refusal label was drawn inside the plot").toHaveAttribute("data-label-drawn", "true");
  const text = await item.getAttribute("data-label-text");
  expect(text, "the refusal label carries no data-label-text").not.toBeNull();
  for (const fragment of expected.mustContain) {
    expect(
      text,
      `the refusal label ("${String(text)}") does not mention "${fragment}" — it reads like a generic ` +
        "placeholder rather than the real answered refusal",
    ).toContain(fragment);
  }
});
