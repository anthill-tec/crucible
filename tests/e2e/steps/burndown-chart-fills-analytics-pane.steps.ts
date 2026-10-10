// CR-CRU-160 §S1 — the Roadmap's burndown chart fills the analytics pane's
// content box at the desktop band and redraws when that pane resizes.
// Reuses seeding.steps.ts ("a project named … is registered" / "an online
// agent … is registered on that project"), roadmap.steps.ts ("a CR queue
// registering cr … is posted for that project"), navigation.steps.ts ("I
// open the workspace for that project"), workflow.steps.ts ("I click the
// {string} workspace tab"), pane-scroll.steps.ts ("the viewport is
// {int}x{int}") and mobile-viewport.steps.ts's "I tap the roadmap release
// band" to reach the Analytics pane — only the chart-geometry assertions
// below are new.
//
// "the analytics pane's content width/height" is read the same way every
// other geometry step in this suite reads a pane's content box:
// `mountedPaneScrollGeometry` (pane-mount.ts) against the `Analytics`
// identity (`[data-testid="pane-scroll"]` inside `analytics-pane`) —
// re-proven attached, the document's one live pane-scroll, and still the
// Analytics pane's own, in the SAME JS turn as the read, never a bare
// lookup that could resolve a detached node mid-swap.
//
// The chart's own canvas is the real `<canvas>` uPlot (public/vendor,
// DN-crucible-analytics §10 — the pinned 1.6.32 IIFE bundle, verified to
// render a `.u-under`/`.u-over` canvas pair via its own minified source)
// draws inside `[data-testid="burndown-chart"]` — never the
// `.app-burndown-canvas` host div, which today carries a FIXED 560px CSS
// width regardless of what uPlot itself is told to draw.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { mountedPaneScrollGeometry } from "./pane-mount.ts";

async function burndownCanvasBox(page: import("@playwright/test").Page) {
  const canvas = page.getByTestId("burndown-chart").locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  expect(box, "the burndown chart canvas has no bounding box").not.toBeNull();
  return box!;
}

Step(
  "the burndown chart canvas is at least {int}% of the analytics pane's content width",
  async ({ page }, minPercent: number) => {
    const canvasBox = await burndownCanvasBox(page);
    const { clientWidth } = await mountedPaneScrollGeometry(page, "Analytics");
    const percent = (canvasBox.width / clientWidth) * 100;
    expect(
      percent,
      `canvas width ${canvasBox.width}px is only ${percent.toFixed(1)}% of the analytics pane's ${clientWidth}px content width`,
    ).toBeGreaterThanOrEqual(minPercent);
  },
);

Step(
  "the burndown chart canvas is at least {int}% of the analytics pane's content height",
  async ({ page }, minPercent: number) => {
    const canvasBox = await burndownCanvasBox(page);
    const { clientHeight } = await mountedPaneScrollGeometry(page, "Analytics");
    const percent = (canvasBox.height / clientHeight) * 100;
    expect(
      percent,
      `canvas height ${canvasBox.height}px is only ${percent.toFixed(1)}% of the analytics pane's ${clientHeight}px content height`,
    ).toBeGreaterThanOrEqual(minPercent);
  },
);

Step(
  "the burndown caption and the forecast card are visible without scrolling the analytics pane",
  async ({ page }) => {
    const { scrollHeight, clientHeight } = await mountedPaneScrollGeometry(page, "Analytics");
    expect(
      scrollHeight,
      `the analytics pane's content overflows its own box (scrollHeight ${scrollHeight}px > clientHeight ${clientHeight}px) — the caption/forecast card need an internal scroll to reach`,
    ).toBeLessThanOrEqual(clientHeight);

    const caption = page.locator('[data-testid="analytics-pane"] .app-burndown-caption');
    await expect(caption).toBeVisible();
    const forecast = page.getByTestId("analytics-forecast");
    await expect(forecast).toBeVisible();

    const viewport = page.viewportSize();
    expect(viewport, "no viewport size is set").not.toBeNull();
    const captionBox = await caption.boundingBox();
    const forecastBox = await forecast.boundingBox();
    expect(captionBox, "the burndown caption has no bounding box").not.toBeNull();
    expect(forecastBox, "the forecast card has no bounding box").not.toBeNull();
    expect(
      captionBox!.y + captionBox!.height,
      `the burndown caption's bottom edge (${captionBox!.y + captionBox!.height}px) falls below the ${viewport!.height}px viewport`,
    ).toBeLessThanOrEqual(viewport!.height);
    expect(
      forecastBox!.y + forecastBox!.height,
      `the forecast card's bottom edge (${forecastBox!.y + forecastBox!.height}px) falls below the ${viewport!.height}px viewport`,
    ).toBeLessThanOrEqual(viewport!.height);
  },
);

Step("the burndown chart canvas width is noted", async ({ page, world }) => {
  const box = await burndownCanvasBox(page);
  world.notedBurndownCanvasWidth = box.width;
});

Step("the burndown chart canvas is narrower than the noted width", async ({ page, world }) => {
  const noted = world.notedBurndownCanvasWidth;
  expect(typeof noted, "no canvas width was noted before the resize").toBe("number");
  const box = await burndownCanvasBox(page);
  expect(
    box.width,
    `canvas width stayed ${box.width}px after the viewport shrank (was ${noted}px) — it never redrew to the analytics pane's new, narrower content width`,
  ).toBeLessThan(noted as number);
});
