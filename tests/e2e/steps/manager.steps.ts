// CR-CRU-012 cycle 28 — workspace-manager.feature steps: the manage chip →
// /manage slide-over, driving the manager's add/edit/archive/unarchive UI
// through real DOM interactions (never seeding via the API — the whole
// point of this feature is the manager's OWN forms), plus the live home
// projects-row badge assertions the archive/unarchive round-trip drives.
// Reuses cards.steps.ts's existing "a projects-row badge for … is
// visible" / "… becomes visible within 2 seconds without reloading" steps
// wherever they already say exactly what's needed.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step("I click the manage chip", async ({ page }) => {
  const chip = page.getByTestId("manage-chip");
  await expect(chip).toBeVisible();
  await chip.click();
});

Step("the projects manager is visible", async ({ page }) => {
  await expect(page.getByTestId("projects-manager")).toBeVisible();
});

Step(
  "I add a project named {string} of type {string} with sutRoot {string} via the manager",
  async ({ page, world }, name: string, type: string, sutRoot: string) => {
    await page.getByTestId("manager-add-name").fill(name);
    await page.getByTestId("manager-add-type").selectOption(type);
    await page.getByTestId("manager-add-sutroot").fill(sutRoot);
    await page.getByTestId("manager-add-submit").click();

    const row = page.getByTestId("manager-project-row").filter({ hasText: name });
    await expect(row).toBeVisible();
    world.projectKey = (await row.getAttribute("data-project-key")) ?? undefined;
  },
);

Step("the manager lists a project row for {string}", async ({ page }, name: string) => {
  const row = page.getByTestId("manager-project-row").filter({ hasText: name });
  await expect(row).toBeVisible();
});

Step(
  "the manager no longer lists a project row for {string}",
  async ({ page }, name: string) => {
    const row = page.getByTestId("manager-project-row").filter({ hasText: name });
    await expect(row).toHaveCount(0, { timeout: 2_000 });
  },
);

function managerRowByKey(page: import("@playwright/test").Page, key: string) {
  return page.locator(`[data-testid="manager-project-row"][data-project-key="${key}"]`);
}

Step(
  "I edit that project's name to {string} via the manager",
  async ({ page, world }, newName: string) => {
    const row = managerRowByKey(page, world.projectKey as string);
    await row.getByText(/edit/i).click();
    const nameInput = row.getByTestId("manager-edit-name");
    await expect(nameInput).toBeVisible();
    await nameInput.fill(newName);
    await row.getByTestId("manager-edit-save").click();
  },
);

Step("I archive that project via the manager", async ({ page, world }) => {
  const row = managerRowByKey(page, world.projectKey as string);
  await row.getByTestId("manager-archive").click();
  await row.getByTestId("manager-archive-confirm").click();
});

Step(
  "the badge for {string} disappears from the home projects row within 2 seconds",
  async ({ page }, name: string) => {
    const badge = page.getByTestId("project-badge").filter({ hasText: name });
    await expect(badge).toHaveCount(0, { timeout: 2_000 });
  },
);

Step("I expand the archived fold", async ({ page }) => {
  const fold = page.getByTestId("manager-archived-fold");
  await expect(fold).toBeVisible();
  await fold.click();
});

Step("the archived fold header reads {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("manager-archived-fold")).toContainText(text);
});

Step("I unarchive that project via the manager", async ({ page, world }) => {
  const row = page.locator(
    `[data-testid="manager-archived-row"][data-project-key="${world.projectKey as string}"]`,
  );
  await expect(row).toBeVisible();
  await row.getByTestId("manager-unarchive").click();
});
