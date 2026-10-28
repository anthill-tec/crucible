// active-cycle-line-draws-only-runs.feature steps — the active cycle's line
// (`open-span` → `linked-run-row`) in the Workflow tab's Now pane, read against
// the REAL server.
//
// Reuses seeding.steps.ts (project + online agent), workflow.steps.ts (plan
// filing, cycle transitions, plan close, the workspace tab click),
// navigation.steps.ts ("I open the workspace for that project"),
// run-lifecycle.steps.ts (a run started on the active cycle),
// project-status-line.steps.ts (aborting that run) and
// cycle-run-navigation.steps.ts (the declared marker's body click and its
// collapsed cue). Everything new here delegates to harness.ts's helpers;
// nothing is stubbed into the page.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestCompile, ingestParsed, postMilestone, RUSTC_ERRORS } from "./harness.ts";

/** How long the milestone-only row is watched for an open span appearing. */
const SETTLE_WINDOW_MS = 2_000;
const SETTLE_SAMPLE_MS = 100;

/** The active section's row for the scenario's cycle, matched by its id. */
function activeCycleRow(page: Page, cycleId: number): Locator {
  return page
    .getByTestId("workflow-active")
    .locator(`[data-testid="cycle-row"][data-cycle-id="${cycleId}"]`);
}

// ── seeding: one of each kind of event, each stamped with the cycle ──────────

Step(
  "a pass\\(5\\/5\\) test run linked to that cycle is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestParsed(
      request,
      world.projectKey as string,
      agentId,
      { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 60 },
      { context: { cycleId: world.cycleId as number } },
    );
    world.testRunEventId = res.event;
  },
);

Step(
  "a {string} milestone linked to that cycle is posted by agent {string}",
  async ({ request, world }, type: string, agentId: string) => {
    const res = await postMilestone(request, world.projectKey as string, agentId, type, {
      label: world.cr as string,
      context: { cycleId: world.cycleId as number },
    });
    world.milestoneEventId = res.event;
  },
);

Step(
  "a rustc compile result linked to that cycle is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestCompile(
      request,
      world.projectKey as string,
      agentId,
      RUSTC_ERRORS,
      "rustc",
      { cycleId: world.cycleId as number },
    );
    expect(res.errors).toBe(1);
    world.compileEventId = res.event;
  },
);

// ── the active cycle's line ──────────────────────────────────────────────────

Step(
  "the active cycle's open span holds exactly one run chip, the test run's, reading {string}",
  async ({ page, world }, ratio: string) => {
    const row = activeCycleRow(page, world.cycleId as number);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "active");
    const span = row.getByTestId("open-span");
    const testRunId = world.testRunEventId as string;
    // The test run's chip is on the line first, so the feed has landed before
    // the count is read.
    await expect(span.locator(`[data-testid="linked-run-row"][data-run-id="${testRunId}"]`)).toBeVisible();
    const chips = span.getByTestId("linked-run-row");
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute("data-run-id", testRunId);
    await expect(chips.first()).toContainText(ratio);
  },
);

Step(
  "no run chip on the page carries the milestone's or the compile result's id",
  async ({ page, world }) => {
    const milestoneId = world.milestoneEventId as string;
    const compileId = world.compileEventId as string;
    expect(milestoneId).not.toBe(compileId);
    await expect(
      page.locator(`[data-testid="linked-run-row"][data-run-id="${milestoneId}"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="linked-run-row"][data-run-id="${compileId}"]`),
    ).toHaveCount(0);
  },
);

// The row can be on screen before the events feed lands, so a single "no open
// span" read could pass before the milestone ever reached the page. The row is
// watched over a window instead: the open span must stay absent throughout.
Step(
  "the active cycle's row draws no open span while its milestone is on the board",
  async ({ page, world }) => {
    const row = activeCycleRow(page, world.cycleId as number);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "active");
    const deadline = Date.now() + SETTLE_WINDOW_MS;
    while (Date.now() < deadline) {
      expect(await row.getByTestId("open-span").count()).toBe(0);
      await page.waitForTimeout(SETTLE_SAMPLE_MS);
    }
    await expect(row.getByTestId("open-span")).toHaveCount(0);
    await expect(row.getByTestId("linked-run-row")).toHaveCount(0);
  },
);

Step(
  "the active cycle's open span holds exactly one run chip, for agent {string}, reading {string}",
  async ({ page, world }, agentId: string, text: string) => {
    const row = activeCycleRow(page, world.cycleId as number);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "active");
    const span = row.getByTestId("open-span");
    const chips = span.getByTestId("linked-run-row");
    await expect(chips.filter({ hasText: agentId })).toBeVisible();
    await expect(chips).toHaveCount(1);
    // The whole chip: the agent, then the word — and no ratio beside it.
    await expect(chips.first()).toHaveText(text);
    await expect(chips.first()).not.toContainText("/");
    // Neither pass nor fail: the chip carries no verdict colour, on itself or
    // anywhere inside it.
    await expect(chips.first()).not.toHaveClass(/(^|\s)app-ratio-(pass|fail)(\s|$)/);
    await expect(chips.first().locator(".app-ratio-pass, .app-ratio-fail")).toHaveCount(0);
    // The run has settled: nothing on the line is still timing it.
    await expect(span.getByTestId("open-span-running-entry")).toHaveCount(0);
  },
);
