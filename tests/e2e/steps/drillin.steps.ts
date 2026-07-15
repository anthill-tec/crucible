// CR-CRU-007 C5b — run-overlay / drill-in steps: suite/leaf rows, Density
// mode + heat-strip, failure boxes, and Esc/URL/scroll restore. Mirrors the
// pre-conversion tests' `overlay = page.getByTestId("run-overlay")` scoping.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";

function overlayOf(page: Page): Locator {
  return page.getByTestId("run-overlay");
}

Step(
  "I open the run overlay directly at its cold URL under the workspace",
  async ({ page, world }) => {
    await page.goto(`/p/${world.projectKey}/run/${world.eventId}`);
  },
);

Step("I open the run overlay directly at its cold URL", async ({ page, world }) => {
  await page.goto(`/run/${world.eventId}`);
});

Step("the run overlay is visible and contains the event id", async ({ page, world }) => {
  const overlay = overlayOf(page);
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(world.eventId as string);
});

Step("the run overlay is visible", async ({ page }) => {
  await expect(overlayOf(page)).toBeVisible();
});

Step("I expand the {string} suite row in the overlay", async ({ page }, suiteName: string) => {
  const overlay = overlayOf(page);
  const suiteRow = overlay.getByTestId("suite-row").filter({ hasText: suiteName });
  await expect(suiteRow).toBeVisible();
  await suiteRow.click();
});

Step("the overlay shows exactly {int} leaf rows", async ({ page }, count: number) => {
  const overlay = overlayOf(page);
  await expect(overlay.getByTestId("leaf-row")).toHaveCount(count);
});

Step("I click the single failing leaf row", async ({ page }) => {
  const overlay = overlayOf(page);
  const failingLeaf = overlay.locator('[data-testid="leaf-row"].fail');
  await expect(failingLeaf).toHaveCount(1);
  await failingLeaf.click();
});

Step("the failure box is visible and contains {string}", async ({ page }, text: string) => {
  const overlay = overlayOf(page);
  const failureBox = overlay.getByTestId("failure-box");
  await expect(failureBox).toBeVisible();
  await expect(failureBox).toContainText(text);
});

Step("a failure box is visible and contains {string}", async ({ page }, text: string) => {
  const overlay = overlayOf(page);
  const failureBox = overlay.getByTestId("failure-box").first();
  await expect(failureBox).toBeVisible();
  await expect(failureBox).toContainText(text);
});

Step("I press Escape", async ({ page }) => {
  await page.keyboard.press("Escape");
});

Step("the run overlay and its scrim are gone", async ({ page }) => {
  await expect(overlayOf(page)).toHaveCount(0);
  await expect(page.getByTestId("run-overlay-scrim")).toHaveCount(0);
});

Step("the URL path is the workspace path with no run-overlay suffix", async ({ page, world }) => {
  expect(new URL(page.url()).pathname).toBe(`/p/${world.projectKey as string}`);
});

Step("the workspace is visible", async ({ page }) => {
  await expect(page.getByTestId("workspace")).toBeVisible();
});

// CR-CRU-016 §S1/AC2 re-target (RED report approved-modification list) —
// the CR-007 mechanism tracked `window.scrollY` (there was never a
// dedicated pane scroller since the overlay sat on a page-covering scrim).
// In-pane, the feed's OWN scroller is the workspace Runs pane
// ([data-testid="workspace-runs"]) — AC2 demands the EXACT PRIOR scrollTop
// of THAT element is restored, not the window's. Replaces the deleted
// "the page scrollY is 0" step, which no longer applies — see
// docs/changes/CR-CRU-016-inpane-drill-in.md Gap analysis ("Scroll
// restore").
Step("I scroll the workspace Runs pane down by {int}px", async ({ page }, amount: number) => {
  await page.getByTestId("workspace-runs").evaluate((el, amt) => {
    (el as HTMLElement).scrollTop = amt;
  }, amount);
});

Step("the workspace Runs pane's scrollTop is {int}", async ({ page }, expected: number) => {
  const scrollTop = await page
    .getByTestId("workspace-runs")
    .evaluate((el) => (el as HTMLElement).scrollTop);
  expect(scrollTop).toBe(expected);
});

// CR-CRU-016 §S1/AC2 fixture repair (RED escalation — Playwright
// actionability auto-scroll defeats the pane-scroll-restore assertion): a
// REAL user click on an already-rendered card does not reposition the
// page/pane — it's Playwright's synthetic-mouse actionability check
// (element-must-be-fully-in-view before dispatch) that nudges the pane's
// scrollTop before the click event ever fires, which is unrelated to the
// production scroll-restore contract this scenario pins. Dispatching a
// native DOM click (still routes through the SAME onclick handler VanJS
// attached — a real "click" event, not a bypass) opens the detail with the
// pane's scrollTop exactly as the user left it.
Step(
  "I click the event card for {string} without letting Playwright re-scroll the pane",
  async ({ page }, agentId: string) => {
    const card = page.getByTestId("event-card").filter({ hasText: agentId });
    await expect(card).toHaveCount(1);
    await card.evaluate((el) => (el as HTMLElement).click());
  },
);

Step("the overlay has no heat-strip", async ({ page }) => {
  await expect(overlayOf(page).getByTestId("heat-strip")).toHaveCount(0);
});

// CR-CRU-007 §S4.0 FINAL re-baseline (2026-07-15): the mode badge/switch is
// removed entirely — presentation is purely tier-contextual (regression/e2e
// render Density, everything else renders Detail). Replaces the deleted
// "the drill-in mode switch ..." steps (data-mode click/assert), which no
// longer apply — see docs/changes/CR-CRU-007-timeline-drill-in.md §S4.0.
Step("there is no drillin-mode element anywhere in the overlay", async ({ page }) => {
  await expect(page.getByTestId("drillin-mode")).toHaveCount(0);
});

Step("the status-chips row is visible", async ({ page }) => {
  await expect(overlayOf(page).getByTestId("density-status-chips")).toBeVisible();
});

Step(
  "the heat-strip is visible with exactly {int} heat cells",
  async ({ page }, count: number) => {
    const heatStrip = overlayOf(page).getByTestId("heat-strip");
    await expect(heatStrip).toBeVisible();
    await expect(heatStrip.getByTestId("heat-cell")).toHaveCount(count);
  },
);

Step("I click the first failing heat cell", async ({ page }) => {
  const heatStrip = overlayOf(page).getByTestId("heat-strip");
  const firstFailCell = heatStrip.locator(".app-heat-fail").first();
  await expect(firstFailCell).toBeVisible();
  await firstFailCell.click();
});
