// CR-CRU-007 C5b — projects-row badge + run event-card assertion steps.
// "that card's ..." steps operate on `world.card`, the Locator captured by
// the preceding "an event card for … becomes visible" step — mirrors how
// the pre-conversion tests chained `const card = …; await expect(card…)`.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step(
  "a projects-row badge for {string} is visible and contains {string}",
  async ({ page }, name: string, contains: string) => {
    const badge = page.getByTestId("project-badge").filter({ hasText: name });
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(contains);
  },
);

Step("home renders 0 agent rows anywhere", async ({ page }) => {
  await expect(page.getByTestId("agent-row")).toHaveCount(0);
});

Step(
  "a projects-row badge for {string} becomes visible within 2 seconds without reloading",
  async ({ page }, name: string) => {
    const badge = page.getByTestId("project-badge").filter({ hasText: name });
    await expect(badge).toBeVisible({ timeout: 2_000 });
  },
);

Step("a projects-row badge for {string} is visible", async ({ page }, name: string) => {
  const badge = page.getByTestId("project-badge").filter({ hasText: name });
  await expect(badge).toBeVisible();
});

Step(
  "a projects-row badge for {string} becomes visible within 2 seconds",
  async ({ page }, name: string) => {
    const badge = page.getByTestId("project-badge").filter({ hasText: name });
    await expect(badge).toBeVisible({ timeout: 2_000 });
  },
);

Step(
  "the {string} badge sorts before the {string} badge in the projects row",
  async ({ page }, first: string, second: string) => {
    const badgeTexts = await page.getByTestId("project-badge").allTextContents();
    const firstIndex = badgeTexts.findIndex((t) => t.includes(first));
    const secondIndex = badgeTexts.findIndex((t) => t.includes(second));
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeLessThan(secondIndex);
  },
);

Step(
  "an event card for {string} becomes visible within 2 seconds",
  async ({ page, world }, agentId: string) => {
    const card = page.getByTestId("event-card").filter({ hasText: agentId });
    await expect(card).toBeVisible({ timeout: 2_000 });
    world.card = card;
  },
);

Step("that card's icon reads {string}", async ({ world }, icon: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = world.card as any;
  await expect(card.getByTestId("card-icon")).toHaveText(icon);
});

Step("that card's tier badge reads {string}", async ({ world }, tier: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = world.card as any;
  await expect(card.getByTestId("tier-badge")).toHaveText(tier);
});

Step("that card's codec badge reads {string}", async ({ world }, codec: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = world.card as any;
  await expect(card.getByTestId("codec-badge")).toHaveText(codec);
});

Step(
  "that card's ratio pill contains {string} and {string}",
  async ({ world }, a: string, b: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const card = world.card as any;
    await expect(card.getByTestId("ratio-pill")).toContainText(a);
    await expect(card.getByTestId("ratio-pill")).toContainText(b);
  },
);

Step("that card's ratio pill contains {string}", async ({ world }, text: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = world.card as any;
  await expect(card.getByTestId("ratio-pill")).toContainText(text);
});

Step(
  "that card's diagnostics preview is visible and its first diagnostic line contains {string}",
  async ({ world }, text: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const card = world.card as any;
    const diagPreview = card.getByTestId("diag-preview");
    await expect(diagPreview).toBeVisible();
    await expect(diagPreview.getByTestId("diag-line").first()).toContainText(text);
  },
);

Step("that card's text never contains {string}", async ({ world }, text: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = world.card as any;
  const cardText = (await card.textContent()) ?? "";
  expect(cardText).not.toContain(text);
});

Step("I click the event card for {string}", async ({ page, world }, agentId: string) => {
  const card = page.getByTestId("event-card").filter({ hasText: agentId });
  await expect(card).toBeVisible();
  await card.click();
  world.card = card;
});

Step("I click the projects-row badge for {string}", async ({ page }, name: string) => {
  const badge = page.getByTestId("project-badge").filter({ hasText: name });
  await expect(badge).toBeVisible();
  await badge.click();
});

Step("the transition marker is visible and matches {string}", async ({ page }, pattern: string) => {
  const marker = page.getByTestId("transition-marker");
  await expect(marker).toBeVisible();
  await expect(marker).toContainText(new RegExp(pattern));
});
