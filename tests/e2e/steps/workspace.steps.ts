// CR-CRU-007 C5b — workspace Project-pane steps: liveness dots, tombstone
// rendering, coverage meter text, and the ← projects / ⌁ agent-row nav
// contract.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step("the project pane is visible", async ({ page }) => {
  await expect(page.getByTestId("project-pane")).toBeVisible();
});

Step(
  "the agent sub-row for {string} is visible with exactly one liveness dot classed g, y, or r",
  async ({ page }, agentId: string) => {
    const pane = page.getByTestId("project-pane");
    const agentRow = pane.getByTestId("agent-row").filter({ hasText: agentId });
    await expect(agentRow).toBeVisible();
    await expect(agentRow.locator(".app-dot")).toHaveCount(1);
    await expect(agentRow.locator(".app-dot")).toHaveClass(/\b[gyr]\b/);
  },
);

Step(
  'any tombstoned agent sub-row shows the "⚰" glyph, "died" text, and opacity 0.45',
  async ({ page }) => {
    const pane = page.getByTestId("project-pane");
    const tombstoned = pane.locator('[data-testid="agent-row"].tombstoned');
    const tombstonedCount = await tombstoned.count();
    if (tombstonedCount > 0) {
      const row = tombstoned.first();
      await expect(row).toContainText("⚰");
      await expect(row).toContainText("died");
      await expect(row).toHaveCSS("opacity", "0.45");
    }
    // else: no tombstoned agent reachable via HTTP seeding — tolerated, see
    // the original F9 test's LIMITATION note (tombstone path stays covered
    // by tests/liveness.test.ts + the livenessGlyph unit tests).
  },
);

Step("the project pane contains {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("project-pane")).toContainText(text);
});

Step("the project pane contains {string} within 2 seconds", async ({ page }, text: string) => {
  await expect(page.getByTestId("project-pane")).toContainText(text, { timeout: 2_000 });
});

Step("the project pane no longer contains {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("project-pane")).not.toContainText(text);
});

Step(
  "the workspace header is visible and contains {string}",
  async ({ page }, text: string) => {
    const header = page.getByTestId("workspace-header");
    await expect(header).toBeVisible();
    await expect(header).toContainText(text);
  },
);

Step(
  "the project pane's agent sub-row for {string} is visible and contains {string}",
  async ({ page }, agentId: string, text: string) => {
    const pane = page.getByTestId("project-pane");
    const agentRow = pane.getByTestId("agent-row").filter({ hasText: agentId });
    await expect(agentRow).toBeVisible();
    await expect(agentRow).toContainText(text);
  },
);
