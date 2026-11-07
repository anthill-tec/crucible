// home-feed-keeps-its-scroll-across-a-detail.feature — steps. The home
// feed's own pane-scroll, found and measured through pane-mount.ts (the Home
// pane's identity: inside `timeline`, never inside a run detail). Reuses
// seeding.steps.ts, navigation.steps.ts and drillin.steps.ts.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { mountedPaneScroll, mountedPaneScrollGeometry } from "./pane-mount.ts";

Step("I scroll the home feed down by {int}px", async ({ page }, amount: number) => {
  const pane = await mountedPaneScroll(page, "Home");
  await expect(pane.getByTestId("event-card").first()).toBeVisible();
  await pane.evaluate((el, amt) => {
    (el as HTMLElement).scrollTop = amt;
  }, amount);
  const { scrollTop } = await mountedPaneScrollGeometry(page, "Home");
  expect(scrollTop, "the home feed scrolled as far as asked").toBe(amount);
});

Step("the home feed's scrollTop is {int}", async ({ page }, expected: number) => {
  await expect(async () => {
    const { scrollTop } = await mountedPaneScrollGeometry(page, "Home");
    expect(scrollTop).toBe(expected);
  }).toPass({ timeout: 2_000 });
});

// Home's detail draws its header in the visible band above the feed's pane,
// so the back chip is found on the page, among the visible buttons.
Step("I click the home detail's {string} back chip", async ({ page }, label: string) => {
  const chip = page.getByRole("button", { name: label }).filter({ visible: true });
  await expect(chip).toHaveCount(1);
  await chip.click();
});
