// run-view-suite-load-row-identity.feature — steps. Seeds a many-suite plain
// run (junitManySuites), tags every suite-row and heat-cell element with a
// marker VanJS itself never writes, triggers one suite's load through the
// SAME suiteLeaves-write path a suite-row click, a synthetic heat-cell
// click, and a scroll-triggered fetch all share (loadSuite), and asserts
// every element outside that suite still carries its marker in the real
// rendered DOM.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestJunit, junitManySuites } from "./harness.ts";

const SUITE_COUNT = 70;
const LEAVES_PER_SUITE = 11; // 70 x 11 = 770 tests — at least 734, many suites.

function overlayOf(page: Page): Locator {
  return page.getByTestId("run-overlay");
}

Step(
  "an e2e run of at least 734 tests across many suites is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const xml = junitManySuites(SUITE_COUNT, LEAVES_PER_SUITE);
    const res = await ingestJunit(request, world.projectKey as string, agentId, xml, "e2e");
    world.eventId = res.event;
    world.leavesPerSuite = LEAVES_PER_SUITE;
  },
);

Step("I tag every suite row and heat cell with a unique identity marker", async ({ page }) => {
  const tagged = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    if (overlay === null) {
      throw new Error("run-view-suite-load-row-identity: no run-overlay in the DOM to tag");
    }
    let i = 0;
    for (const el of overlay.querySelectorAll('[data-testid="suite-row"], [data-testid="heat-cell"]')) {
      el.setAttribute("data-identity-probe", `probe-${i}`);
      i += 1;
    }
    return i;
  });
  expect(tagged, "no suite-row/heat-cell elements to tag — the run view did not render").toBeGreaterThan(0);
});

Step(
  "every suite row other than {string} still has its identity marker",
  async ({ page }, loadedSuite: string) => {
    const result = await page.evaluate((suiteKey) => {
      const overlay = document.querySelector('[data-testid="run-overlay"]');
      const rows = Array.from(overlay?.querySelectorAll('[data-testid="suite-row"]') ?? []);
      const other = rows.filter((el) => el.getAttribute("data-suite-key") !== suiteKey);
      const lost = other.filter((el) => el.getAttribute("data-identity-probe") === null);
      return {
        otherCount: other.length,
        lostKeys: lost.map((el) => el.getAttribute("data-suite-key")),
      };
    }, loadedSuite);
    expect(
      result.lostKeys,
      `suite rows rebuilt (lost their identity marker): ${JSON.stringify(result.lostKeys)}`,
    ).toEqual([]);
    expect(result.otherCount).toBe(SUITE_COUNT - 1);
  },
);

Step(
  "every heat cell outside the {string} suite still has its identity marker",
  async ({ page }, loadedSuite: string) => {
    const result = await page.evaluate((suiteKey) => {
      const belongsToSuite = (title: string, key: string): boolean =>
        title === key || title.startsWith(`${key} › `);
      const overlay = document.querySelector('[data-testid="run-overlay"]');
      const cells = Array.from(overlay?.querySelectorAll('[data-testid="heat-cell"]') ?? []);
      const other = cells.filter((el) => !belongsToSuite(el.getAttribute("title") ?? "", suiteKey));
      const lost = other.filter((el) => el.getAttribute("data-identity-probe") === null);
      return {
        otherCount: other.length,
        lostTitles: lost.slice(0, 10).map((el) => el.getAttribute("title")),
      };
    }, loadedSuite);
    expect(
      result.lostTitles,
      `heat cells rebuilt (lost their identity marker): ${JSON.stringify(result.lostTitles)}`,
    ).toEqual([]);
    expect(result.otherCount).toBe((SUITE_COUNT - 1) * LEAVES_PER_SUITE);
  },
);

Step(
  "the {string} suite's own heat cells have been replaced with real per-leaf cells",
  async ({ page, world }, suiteKey: string) => {
    const leavesPerSuite = world.leavesPerSuite as number;
    const result = await page.evaluate((key) => {
      const overlay = document.querySelector('[data-testid="run-overlay"]');
      const cells = Array.from(overlay?.querySelectorAll('[data-testid="heat-cell"]') ?? []);
      const real = cells.filter((el) => (el.getAttribute("title") ?? "").startsWith(`${key} › `));
      const stillSynthetic = cells.filter((el) => el.getAttribute("title") === key);
      return { realCount: real.length, syntheticCount: stillSynthetic.length };
    }, suiteKey);
    expect(result.syntheticCount, `"${suiteKey}" still has synthetic (un-expanded) heat cells`).toBe(0);
    expect(result.realCount).toBe(leavesPerSuite);
  },
);
