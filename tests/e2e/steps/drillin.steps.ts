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

Step("the page scrollY is 0", async ({ page }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollY = await page.evaluate(() => (globalThis as any).scrollY as number);
  expect(scrollY).toBe(0);
});

Step("the overlay has no heat-strip", async ({ page }) => {
  await expect(overlayOf(page).getByTestId("heat-strip")).toHaveCount(0);
});

Step(
  "the drill-in mode switch is visible with data-mode {string}",
  async ({ page }, mode: string) => {
    const modeSwitch = overlayOf(page).getByTestId("drillin-mode");
    await expect(modeSwitch).toBeVisible();
    await expect(modeSwitch).toHaveAttribute("data-mode", mode);
  },
);

Step("I click the drill-in mode switch", async ({ page }) => {
  await overlayOf(page).getByTestId("drillin-mode").click();
});

Step("the drill-in mode switch has data-mode {string}", async ({ page }, mode: string) => {
  await expect(overlayOf(page).getByTestId("drillin-mode")).toHaveAttribute("data-mode", mode);
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
