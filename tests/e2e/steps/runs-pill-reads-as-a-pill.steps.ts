// The `→ Runs` pill still reads as a pill on touch media. Raising it to the
// 44px touch floor on a `(pointer: coarse)` device must not turn it into a
// near-round blob: wherever the pill renders — History's cycle line on the
// tablet band, Now's cycle line on the phone and tablet bands — it is at least
// 44px tall AND its horizontal padding on each side is at least half that
// height (DN-crucible-responsive-model, decisions 4 and 11). Collected by
// mobile-viewport-responsive.feature (chromium-mobile, webkit-iphone) and
// tablet-viewport-responsive.feature (chromium-tablet), the touch-enabled
// projects.
//
// WHICH ELEMENT. The padding is read with `getComputedStyle` on the pill
// element itself — the `data-testid="cycle-to-runs"` span, which carries the
// `app-pill app-cycle-to-runs` classes and holds the `→ Runs` label as its
// own text, with no inner wrapper. The height is that same element's
// bounding box.
//
// The coarse-pointer proof ("the page matches the coarse-pointer media
// query") precedes every measurement in the scenarios, so the shape is
// measured where the touch floor applies.
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

async function expectPillReadsAsAPill(pill: Locator, where: string): Promise<void> {
  await expect(pill, `${where}: exactly one → Runs pill must render`).toHaveCount(1);
  await expect(pill, `${where}: the → Runs pill must be visible`).toBeVisible();
  await expect(pill, `${where}: the pill must read → Runs`).toHaveText("→ Runs");
  const box = await pill.boundingBox();
  if (box === null) throw new Error(`${where}: the → Runs pill has no bounding box`);
  const padding = await pill.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
  });
  const measured = `measured ${box.width}x${box.height}, padding-left ${padding.left}px, padding-right ${padding.right}px`;
  expect(
    box.height,
    `${where}: the → Runs pill must be at least ${TOUCH_FLOOR_PX}px tall on a coarse pointer; ${measured}`,
  ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
  const halfHeight = box.height / 2;
  expect(
    padding.left,
    `${where}: the → Runs pill's padding-left must be at least half its height (${halfHeight}px) on a coarse pointer; ${measured}`,
  ).toBeGreaterThanOrEqual(halfHeight);
  expect(
    padding.right,
    `${where}: the → Runs pill's padding-right must be at least half its height (${halfHeight}px) on a coarse pointer; ${measured}`,
  ).toBeGreaterThanOrEqual(halfHeight);
}

Step(
  "Now's → Runs pill for that cycle is at least 44px tall with horizontal padding on each side of at least half that height",
  async ({ page, world }) => {
    await expectPillReadsAsAPill(nowCycleRunsPill(page, world.cycleId as number), "Now's active cycle line");
  },
);

Step(
  "the history → Runs pill for cr {string} is at least 44px tall with horizontal padding on each side of at least half that height",
  async ({ page }, cr: string) => {
    await expectPillReadsAsAPill(historyCycleRunsPill(page, cr), `the history cycle line under ${cr}`);
  },
);
