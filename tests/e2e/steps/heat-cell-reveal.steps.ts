// CR-CRU-159 C1 — heat-strip reveal steps (plain/non-spec runs, Density
// presentation). Mirrors drillin.steps.ts's `overlayOf` scoping (the run
// detail mounts identically in both the home `RunDetail` and the workspace
// `WorkspaceRunDetail` — `run-overlay` wraps `pane-scroll` in both) and
// reuses its existing "I open the run overlay..."/"I expand the {string}
// suite row..."/"a failure box is visible and contains {string}" steps —
// only the heat-cell click + reveal assertions are new here.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import {
  ingestJunit,
  junitDigestWindowSuite,
  junitSmallSuite,
  junitSynthSuites,
  junitTargetedSuite,
} from "./harness.ts";

function overlayOf(page: Page): Locator {
  return page.getByTestId("run-overlay");
}

// ── Given — seed a Density run shaped for one of this cycle's scenarios ────

Step(
  "a Density run is ingested for agent {string} with suite {string} holding {int} leaves, a passing leaf {string} at position {int} and a failing leaf {string} at position {int}",
  async (
    { request, world },
    agentId: string,
    suiteName: string,
    total: number,
    greenName: string,
    greenPosition: number,
    redName: string,
    redPosition: number,
  ) => {
    const xml = junitTargetedSuite(
      suiteName,
      total,
      { name: greenName, position: greenPosition },
      { name: redName, position: redPosition },
    );
    const res = await ingestJunit(request, world.projectKey as string, agentId, xml, "regression");
    world.eventId = res.event;
  },
);

Step(
  "a Density run is ingested for agent {string} with a collapsed all-pass suite {string} and a collapsed suite {string} with a failing leaf {string}",
  async (
    { request, world },
    agentId: string,
    greenSuite: string,
    redSuite: string,
    redFailingLeaf: string,
  ) => {
    const xml = junitSynthSuites(greenSuite, redSuite, redFailingLeaf);
    const res = await ingestJunit(request, world.projectKey as string, agentId, xml, "regression");
    world.eventId = res.event;
  },
);

Step(
  "a Density run is ingested for agent {string} with suite {string} holding a {int}-leaf digest group before target leaf {string}, followed by {int} more leaves",
  async (
    { request, world },
    agentId: string,
    suiteName: string,
    groupSize: number,
    targetName: string,
    trailing: number,
  ) => {
    const xml = junitDigestWindowSuite(suiteName, groupSize, targetName, trailing);
    const res = await ingestJunit(request, world.projectKey as string, agentId, xml, "regression");
    world.eventId = res.event;
  },
);

Step(
  "a Density run is ingested for agent {string} with a fully-visible 2-leaf suite {string} and leaf {string}",
  async ({ request, world }, agentId: string, suiteName: string, leafName: string) => {
    const xml = junitSmallSuite(suiteName, leafName);
    const res = await ingestJunit(request, world.projectKey as string, agentId, xml, "regression");
    world.eventId = res.event;
  },
);

// ── When — click a heat cell, loaded or synthetic ───────────────────────────

Step("I click the heat cell titled {string}", async ({ page }, title: string) => {
  const cell = overlayOf(page).getByTestId("heat-strip").locator(`[title="${title}"]`);
  await expect(cell).toBeVisible();
  await cell.click();
});

Step(
  "I click the passing synthetic heat cell for suite {string}",
  async ({ page }, suiteName: string) => {
    const cell = overlayOf(page)
      .getByTestId("heat-strip")
      .locator(`.app-heat-pass[title="${suiteName}"]`)
      .first();
    await expect(cell).toBeVisible();
    await cell.click();
  },
);

Step(
  "I click the failing synthetic heat cell for suite {string}",
  async ({ page }, suiteName: string) => {
    const cell = overlayOf(page)
      .getByTestId("heat-strip")
      .locator(`.app-heat-fail[title="${suiteName}"]`)
      .first();
    await expect(cell).toBeVisible();
    await cell.click();
  },
);

// ── Then — the reveal: scrolled within the pane, blinking, mounted ─────────

Step(
  "the leaf row for {string} is scrolled within the pane-scroll's visible area",
  async ({ page }, leafName: string) => {
    const overlay = overlayOf(page);
    const pane = overlay.getByTestId("pane-scroll");
    const row = overlay.getByTestId("leaf-row").filter({ hasText: leafName });
    await expect(row).toHaveCount(1);
    const paneBox = await pane.boundingBox();
    const rowBox = await row.boundingBox();
    if (paneBox === null || rowBox === null) {
      throw new Error(
        `heat-cell-reveal: could not measure the pane-scroll/leaf-row geometry for "${leafName}"`,
      );
    }
    // §S1 — "the target's top sits just below the pinned header": the row's
    // own box must land INSIDE the pane's visible viewport, not merely
    // exist somewhere in the (possibly much taller) scrolled content.
    expect(rowBox.y).toBeGreaterThanOrEqual(paneBox.y - 1);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1);
  },
);

Step("the leaf row for {string} is mounted in the overlay", async ({ page }, leafName: string) => {
  await expect(overlayOf(page).getByTestId("leaf-row").filter({ hasText: leafName })).toHaveCount(1);
});

Step("the leaf row for {string} carries the locate-blink class", async ({ page }, leafName: string) => {
  const row = overlayOf(page).getByTestId("leaf-row").filter({ hasText: leafName });
  await expect(row).toHaveClass(/app-locate-blink/);
});

Step(
  "the suite row for {string} is expanded and carries the locate-blink class",
  async ({ page }, suiteName: string) => {
    const row = overlayOf(page).getByTestId("suite-row").filter({ hasText: suiteName });
    await expect(row).toHaveClass(/app-locate-blink/);
    await expect(row.getByTestId("tree-toggle")).toHaveText("▾");
  },
);

Step(
  "the suite row for {string} carries a data-suite-key attribute",
  async ({ page }, suiteName: string) => {
    const row = overlayOf(page).getByTestId("suite-row").filter({ hasText: suiteName });
    await expect(row).toHaveAttribute("data-suite-key", suiteName);
  },
);

// ── §S2/AC7 — the header pinned, the document's own scroll untouched ───────

Step("I note the header's position and the document's scroll", async ({ page, world }) => {
  const header = page.locator(".app-drillin-head").first();
  const box = await header.boundingBox();
  world.notedHeaderTop = box?.y ?? null;
  world.notedDocScroll = await page.evaluate(() => window.scrollY);
});

Step(
  "the run-detail header's position and the document's scroll are unchanged",
  async ({ page, world }) => {
    const header = page.locator(".app-drillin-head").first();
    const box = await header.boundingBox();
    expect(box?.y ?? null).toBe(world.notedHeaderTop);
    const docScroll = await page.evaluate(() => window.scrollY);
    expect(docScroll).toBe(world.notedDocScroll);
  },
);

// ── §S1 AC6 — already-visible target: the pane must not move at all ────────

Step("I note the pane-scroll's scrollTop", async ({ page, world }) => {
  world.notedScrollTop = await overlayOf(page)
    .getByTestId("pane-scroll")
    .evaluate((el) => (el as HTMLElement).scrollTop);
});

Step("the pane-scroll's scrollTop is unchanged from when it was noted", async ({ page, world }) => {
  const now = await overlayOf(page)
    .getByTestId("pane-scroll")
    .evaluate((el) => (el as HTMLElement).scrollTop);
  expect(now).toBe(world.notedScrollTop);
});
