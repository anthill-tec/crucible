// CR-CRU-026 C3 — workspace-plan-scoping.feature steps: pins for the
// already-shipped §S1/§S2 (C1, commit 2c169d7) and §S3.2/§S3.4 (C2, commit
// daf8505) behavior. Reuses seeding.steps.ts's project registration,
// workflow.steps.ts's plan-filing/cycle-transition/linked-run-ingest steps
// and its "declared marker … becomes visible" (workspace scope) /
// "workspace Runs pane shows no transition marker" steps, cards.steps.ts's
// "I click the projects-row badge for …", and navigation.steps.ts's
// "I open the home page" wherever they already say exactly what's needed.
// This file adds ONLY what none of those already express: the ← projects
// in-app-navigation chip, the Workflow tab's active-section cr-root/
// cycle-row assertions, the CR-011 empty-state + foreign-content-absence
// assertion, the HOME-scoped declared-marker visibility check (the
// existing one is workspace-scoped), and the cold-load-vs-round-trip
// marker-vocabulary count pins.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

// ── in-app navigation ────────────────────────────────────────────────────

Step("I navigate home via the ← projects chip", async ({ page }) => {
  const chip = page.getByTestId("workspace-header").getByRole("button", { name: "← projects" });
  await expect(chip).toBeVisible();
  await chip.click();
});

// ── Workflow tab active-section assertions (CR root + cycle rows) ───────

Step(
  "the Workflow tab shows the cr root for {string} within 2 seconds",
  async ({ page }, cr: string) => {
    const root = page
      .getByTestId("workflow-active")
      .locator(`[data-testid="workflow-cr-root"][data-cr="${cr}"]`);
    await expect(root).toBeVisible({ timeout: 2_000 });
  },
);

Step(
  "the Workflow tab shows a done cycle row for {string} within 2 seconds",
  async ({ page }, label: string) => {
    const row = page
      .getByTestId("workflow-active")
      .getByTestId("cycle-row")
      .filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 2_000 });
    await expect(row).toHaveAttribute("data-status", "done");
  },
);

// ── CR-011 empty state + foreign-content-absence (render guard, e2e) ────

Step(
  "the Workflow tab shows the CR-011 empty state with none of the previous project's plan content",
  async ({ page }) => {
    await expect(page.getByTestId("workflow-active")).toContainText(
      "no open plan — file one via POST /api/v2/projects/<key>/plans",
    );
    // Defense-in-depth sweep (AC: "the previous project's active-plan
    // section and history groups are absent") — zero CR roots in EITHER
    // the active section or the history lens.
    await expect(
      page.getByTestId("workflow-active").getByTestId("workflow-cr-root"),
    ).toHaveCount(0);
    await expect(page.getByTestId("workflow-history").getByTestId("cr-group")).toHaveCount(0);
  },
);

// ── §S0 equivalence — home-scoped marker vocabulary ──────────────────────
// workflow.steps.ts's "the declared marker for … on … becomes visible
// within 2 seconds" is workspace-Runs-pane-scoped; the home timeline
// shares the SAME testids (declared-marker/cycle-span-open/
// transition-marker — both surfaces render through app.js's runFeed()) but
// needs its own scope root since home has no "workspace-runs" container.

Step(
  "the declared marker for {string} on {string} is visible in the home timeline within 2 seconds",
  async ({ page }, label: string, cr: string) => {
    // Home renders declared markers for EVERY listed project (§S3 home
    // parity), so other seeded projects' "c1 red-green" cycles share the
    // same label — filter on BOTH the label and the cr to land on exactly
    // this project's marker (mirrors the compound (projectKey, cycleId)
    // matching discipline §S3.3 requires of the underlying data).
    const marker = page
      .getByTestId("timeline")
      .getByTestId("declared-marker")
      .filter({ hasText: label })
      .filter({ hasText: cr });
    await expect(marker).toBeVisible({ timeout: 2_000 });
  },
);

Step(
  "I record the home timeline's marker vocabulary counts as the cold-load baseline",
  async ({ page, world }) => {
    const timeline = page.getByTestId("timeline");
    world.coldLoadDeclaredMarkerCount = await timeline.getByTestId("declared-marker").count();
    world.coldLoadCycleSpanOpenCount = await timeline.getByTestId("cycle-span-open").count();
    world.coldLoadTransitionMarkerCount = await timeline.getByTestId("transition-marker").count();
  },
);

Step(
  "the home timeline's marker vocabulary counts match the recorded cold-load baseline within 2 seconds",
  async ({ page, world }) => {
    const timeline = page.getByTestId("timeline");
    // Bounded (≤2s) retrying assertions — the §S0 equivalence claim is that
    // navigation's synchronous clear + immediate scoped refetch reaches the
    // SAME steady state as cold load, not that it's instantaneous.
    await expect(timeline.getByTestId("declared-marker")).toHaveCount(
      world.coldLoadDeclaredMarkerCount as number,
      { timeout: 2_000 },
    );
    await expect(timeline.getByTestId("cycle-span-open")).toHaveCount(
      world.coldLoadCycleSpanOpenCount as number,
      { timeout: 2_000 },
    );
    await expect(timeline.getByTestId("transition-marker")).toHaveCount(
      world.coldLoadTransitionMarkerCount as number,
      { timeout: 2_000 },
    );
  },
);
