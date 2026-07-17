// CR-CRU-023 §S1 — viewport-pane-scroll-floor.feature steps: viewport
// resize and the pane-level horizontal-scroll-floor assertions (the shared
// `[data-testid="pane-scroll"]` handle C1 GREEN put on every central pane —
// see public/app.js/.app-pane-content and styles.css's 660px child
// min-width floor). Reuses seeding.steps.ts / workflow.steps.ts /
// navigation.steps.ts for project/plan/run seeding and navigation — only
// the viewport + scroll-geometry assertions are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step("the viewport is {int}x{int}", async ({ page }, width: number, height: number) => {
  await page.setViewportSize({ width, height });
});

// "the active pane's instance" — exactly one `[data-testid="pane-scroll"]`
// renders per route (one of the seven central-pane surfaces mounts at a
// time); its scrollWidth exceeding its clientWidth is the PANE-level
// horizontal scrollbar the §S1 AC requires below the supported floor.
Step("the active pane-scroll element scrolls horizontally", async ({ page }) => {
  const pane = page.getByTestId("pane-scroll");
  await expect(pane).toHaveCount(1);
  const { scrollWidth, clientWidth } = await pane.evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(scrollWidth).toBeGreaterThan(clientWidth);
});

Step("no pane scrolls horizontally", async ({ page }) => {
  const pane = page.getByTestId("pane-scroll");
  await expect(pane).toHaveCount(1);
  const { scrollWidth, clientWidth } = await pane.evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

// .app-cycle-timer-ember is `font: 600 8.5px/1.8 var(--mono)` (line-height
// ≈15.3px) + 1px vertical padding each side (≈17px rendered) and
// `white-space: nowrap` (styles.css). A badge that had wrapped onto a
// second line would roughly double that box height; 26px is a generous
// single-line ceiling that still catches a wrap. Belt-and-braces: also
// assert no embedded newline in its text (mirrors
// tests/cycle-timers.test.ts's "ONE unbroken text node" pin).
Step("the cycle-timer badge renders as a single unbroken line", async ({ page }) => {
  const badge = page.getByTestId("cycle-timer");
  await expect(badge).toBeVisible();
  const innerText = await badge.innerText();
  expect(innerText).not.toMatch(/[\n\r]/);
  const box = await badge.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(26);
});

Step("the page body does not scroll horizontally", async ({ page }) => {
  const { bodyScrollWidth, innerWidth } = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(bodyScrollWidth).toBeLessThanOrEqual(innerWidth);
});
