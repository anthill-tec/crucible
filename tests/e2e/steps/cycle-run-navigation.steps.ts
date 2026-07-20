// CR-CRU-025 C4 — cycle-run-navigation.feature steps: §S1 (cycle row → Runs
// boundary), §S2 (the inverse `⚑ Cycle` badge, with auto-expand of a
// collapsed History CR group), and §S2b (the Run Timeline accordion).
// Reuses seeding.steps.ts / workflow.steps.ts / navigation.steps.ts /
// drillin.steps.ts / cards.steps.ts wherever they already say exactly what's
// needed (project/plan/run seeding, tab clicks, "{string} tab is selected",
// event-card visibility) — only the navigation-badge/blink/accordion
// assertions are new here.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestParsed } from "./harness.ts";

function crGroup(page: Page, cr: string): Locator {
  return page
    .getByTestId("workflow-history")
    .locator(`[data-testid="cr-group"][data-cr="${cr}"]`);
}

function declaredMarker(page: Page, cycleId: number): Locator {
  return page
    .getByTestId("workspace-runs")
    .locator(`[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`);
}

// §S2 — the ACTIVE `cycle-row` OR the HISTORY `lens-cycle-row` for a
// cycleId (mirrors app.js's own `revealCycleRow` selector).
function historyCycleRow(page: Page, cycleId: number): Locator {
  return page.locator(
    `[data-testid="cycle-row"][data-cycle-id="${cycleId}"], ` +
      `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
  );
}

// ── noise seeding — makes the Runs pane genuinely scrollable so §S1's
// `scrollIntoView` effect is a real, provable pane-scroll, not a no-op on an
// already-fully-visible feed (mirrors drillin.steps.ts's scrollTop precedent).
Step(
  "{int} filler passing runs are ingested on that project",
  async ({ request, world }, count: number) => {
    for (let i = 0; i < count; i++) {
      await ingestParsed(request, world.projectKey as string, `crb-filler-${i}`, {
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        duration_ms: 5,
      });
    }
  },
);

// ── §S1 — cycle row (History) → Runs boundary ───────────────────────────────

Step(
  "I click the cycle-to-runs badge for cycle {string} in the cr group for {string}",
  async ({ page }, label: string, cr: string) => {
    const row = crGroup(page, cr).getByTestId("lens-cycle-row").filter({ hasText: label });
    await expect(row).toBeVisible();
    const badge = row.getByTestId("cycle-to-runs");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("aria-disabled", "false");
    await badge.click();
  },
);

Step(
  "the declared marker for that cycle is scrolled into view within the Runs pane and blinking",
  async ({ page, world }) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).toBeVisible();
    await expect(marker).toHaveClass(/app-locate-blink/);
    // Real pane-scroll proof (not the page): the marker was seeded below the
    // fold by the filler runs above it in the newest-first feed, so a
    // non-zero scrollTop on the pane's OWN scroller (workspace-runs, the
    // `overflow-y:auto` element) after the click proves `scrollIntoView` ran
    // against the pane, exactly as drillin.steps.ts pins for the run-detail
    // restore path.
    const scrollTop = await page
      .getByTestId("workspace-runs")
      .evaluate((el) => (el as HTMLElement).scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
  },
);

Step(
  "the declared marker for that cycle loses its blink class within {int} seconds",
  async ({ page, world }, seconds: number) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).not.toHaveClass(/app-locate-blink/, {
      timeout: seconds * 1000 + 1_000,
    });
  },
);

// ── §S2 — Runs boundary → cycle row (inverse) ───────────────────────────────

Step(
  "I click the {string} badge on the declared marker for that cycle",
  async ({ page, world }, label: string) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).toBeVisible();
    const badge = marker.getByTestId("boundary-to-cycle");
    await expect(badge).toHaveText(label);
    await badge.click();
  },
);

Step(
  "the cr group for {string} is auto-expanded showing its cycle rows",
  async ({ page }, cr: string) => {
    await expect(crGroup(page, cr).getByTestId("lens-cycle-row").first()).toBeVisible();
  },
);

Step(
  "the history cycle row for that cycle is scrolled into view and blinking",
  async ({ page, world }) => {
    const row = historyCycleRow(page, world.cycleId as number);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/app-locate-blink/);
  },
);

Step("exactly one element blinks across the workspace", async ({ page }) => {
  await expect(page.locator(".app-locate-blink")).toHaveCount(1);
});

// ── §S2b — Run Timeline accordion ───────────────────────────────────────────

Step("I click the body of the declared marker for that cycle", async ({ page, world }) => {
  const marker = declaredMarker(page, world.cycleId as number);
  await expect(marker).toBeVisible();
  // Click near the marker's top-left corner — the trailing `boundary-to-cycle`
  // badge and (when collapsed) the `accordion-collapsed-cue` both render at
  // the END of the row's text, so a click at the body's leading edge can
  // never land on either nested node (which stopPropagation their own click
  // and must NOT be what fires the accordion toggle).
  await marker.click({ position: { x: 5, y: 5 } });
});

Step(
  "the event card for {string} is not present in the workspace Runs pane",
  async ({ page }, agentId: string) => {
    await expect(
      page.getByTestId("workspace-runs").getByTestId("event-card").filter({ hasText: agentId }),
    ).toHaveCount(0);
  },
);

Step(
  "the declared marker for that cycle shows the collapsed cue {string}",
  async ({ page, world }, cue: string) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).toHaveClass(/app-accordion-collapsed/);
    await expect(marker.getByTestId("accordion-collapsed-cue")).toHaveText(cue);
  },
);

Step(
  "the declared marker for that cycle no longer shows a collapsed cue",
  async ({ page, world }) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).not.toHaveClass(/app-accordion-collapsed/);
    await expect(marker.getByTestId("accordion-collapsed-cue")).toHaveCount(0);
  },
);
