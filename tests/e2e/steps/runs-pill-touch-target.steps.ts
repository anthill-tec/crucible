// The `→ Runs` pill is a touch target on touch media. Wherever the pill
// renders — History's cycle line on the tablet band, Now's cycle line on the
// phone and tablet bands — a `(pointer: coarse)` device gets a pill at least
// 44px TALL, the same height floor `button.app-chip` and the other touch
// floors carry (DN-crucible-responsive-model, decisions 4 and 11). The floor
// is a height, never "either dimension": the bare pill is already wider than
// 44px (its padding plus six mono glyphs), so a width-or-height measure would
// hold with no floor at all. Collected by mobile-viewport-responsive.feature
// (chromium-mobile, webkit-iphone) and tablet-viewport-responsive.feature
// (chromium-tablet), the touch-enabled projects.
//
// Every measurement is preceded by the coarse-pointer proof: the page itself
// must report `matchMedia("(pointer: coarse)")` true, so a profile that stops
// emulating a touch pointer fails loudly here instead of measuring a
// fine-pointer pill and passing or failing for the wrong reason.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";

const TOUCH_FLOOR_PX = 44;

function nowCycleRunsPill(page: Page, cycleId: number): Locator {
  return page
    .getByTestId("workflow-now")
    .locator(`[data-testid="cycle-row"][data-cycle-id="${cycleId}"]`)
    .getByTestId("cycle-to-runs");
}

function historyCycleRunsPill(page: Page, cr: string): Locator {
  return page
    .getByTestId("workflow-history")
    .locator(`[data-testid="cr-group"][data-cr="${cr}"]`)
    .locator('[data-testid="lens-cycle-row"]')
    .getByTestId("cycle-to-runs");
}

async function expectPillMeetsTouchFloor(pill: Locator, where: string): Promise<void> {
  await expect(pill, `${where}: exactly one → Runs pill must render`).toHaveCount(1);
  await expect(pill, `${where}: the → Runs pill must be visible`).toBeVisible();
  await expect(pill, `${where}: the pill must read → Runs`).toHaveText("→ Runs");
  const box = await pill.boundingBox();
  if (box === null) throw new Error(`${where}: the → Runs pill has no bounding box`);
  expect(
    box.height,
    `${where}: the → Runs pill must be at least ${TOUCH_FLOOR_PX}px tall on a coarse pointer; measured ${box.width}x${box.height}`,
  ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
}

Step("the page matches the coarse-pointer media query", async ({ page }) => {
  const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  expect(coarse, "this profile must emulate a coarse (touch) pointer for the touch floor to apply").toBe(true);
});

Step(
  "Now's → Runs pill for that cycle is at least 44px tall",
  async ({ page, world }) => {
    await expectPillMeetsTouchFloor(nowCycleRunsPill(page, world.cycleId as number), "Now's active cycle line");
  },
);

Step(
  "the history → Runs pill for cr {string} is at least 44px tall",
  async ({ page }, cr: string) => {
    await expectPillMeetsTouchFloor(historyCycleRunsPill(page, cr), `the history cycle line under ${cr}`);
  },
);
