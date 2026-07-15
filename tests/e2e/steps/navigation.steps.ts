// CR-CRU-007 C5b — page-level navigation, shell layout, and rail steps.
// Reuses the SAME selectors the pre-conversion tests used (`.app-main`,
// `.app-rail`, `.app-rail-title`, health-pill / timeline / workspace
// testids) — no new testids invented here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step("a fresh, empty Crucible database", async () => {
  // No-op: playwright.config.ts's webServer already boots against a fresh,
  // throwaway scratch database per E2E run (see that file's header comment).
});

Step("I open the home page", async ({ page }) => {
  await page.goto("/");
});

Step("I have opened the home page", async ({ page }) => {
  await page.goto("/");
});

Step("I have opened the home page with the health pill visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("health-pill")).toBeVisible();
});

Step("the health pill is visible and shows a live-green dot", async ({ page }) => {
  const pill = page.getByTestId("health-pill");
  await expect(pill).toBeVisible();
  await expect(pill).not.toHaveClass(/down/);
  await expect(pill.locator(".app-dot")).toHaveClass(/\bg\b/);
});

Step("the timeline shows the empty-state text {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("timeline").locator(".app-empty")).toContainText(text);
});

Step('there is no ".app-rail" element anywhere on the page', async ({ page }) => {
  await expect(page.locator(".app-rail")).toHaveCount(0);
});

Step("the timeline spans more than 90% of the main content width", async ({ page }) => {
  const timeline = page.getByTestId("timeline");
  await expect(timeline).toBeVisible();
  const mainBox = await page.locator(".app-main").boundingBox();
  const timelineBox = await timeline.boundingBox();
  expect(mainBox).not.toBeNull();
  expect(timelineBox).not.toBeNull();
  expect(timelineBox!.width).toBeGreaterThan(mainBox!.width * 0.9);
});

Step("I open the workspace for that project", async ({ page, world }) => {
  await page.goto(`/p/${world.projectKey}`);
});

Step("the workspace header is visible", async ({ page }) => {
  await expect(page.getByTestId("workspace-header")).toBeVisible();
});

Step("the workspace tabs row is visible and is not nested inside a rail", async ({ page }) => {
  const tabsRow = page.getByTestId("workspace-tabs");
  await expect(tabsRow).toBeVisible();
  const tabsParentClass = await tabsRow.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (el: any) => (el.parentElement?.className as string) ?? "",
  );
  expect(tabsParentClass).not.toMatch(/rail/);
});

Step("the tabs row sits directly beneath the workspace header", async ({ page }) => {
  const header = page.getByTestId("workspace-header");
  const tabsRow = page.getByTestId("workspace-tabs");
  const headerBox = await header.boundingBox();
  const tabsBox = await tabsRow.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(tabsBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
});

Step("the tabs row spans more than 90% of the workspace width", async ({ page }) => {
  const tabsRow = page.getByTestId("workspace-tabs");
  const workspaceBox = await page.getByTestId("workspace").boundingBox();
  const tabsBox = await tabsRow.boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(tabsBox!.width).toBeGreaterThan(workspaceBox!.width * 0.9);
});

Step('there is no ".app-rail" element anywhere inside the workspace', async ({ page }) => {
  await expect(page.locator('[data-testid="workspace"] .app-rail')).toHaveCount(0);
});

Step(
  "the Project pane sits to the right of the main content column with no left rail",
  async ({ page }) => {
    const runsBox = await page.getByTestId("workspace-runs").boundingBox();
    const paneBox = await page.getByTestId("project-pane").boundingBox();
    expect(runsBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    expect(paneBox!.x).toBeGreaterThan(runsBox!.x);
  },
);

Step("the URL path ends with that project's workspace path", async ({ page, world }) => {
  await expect(page).toHaveURL(new RegExp(`/p/${world.projectKey}$`));
});

Step("no workspace tab is labelled {string}", async ({ page }, label: string) => {
  const tabTexts = await page.getByTestId("workspace-tab").allTextContents();
  expect(tabTexts).not.toContain(label);
  expect(tabTexts.some((t) => t.includes(label))).toBe(false);
});
