// CR-CRU-011 C5 — workflow.feature steps: cycle-plan filing/transitions/close
// via the §S0 API (delegated to tests/e2e/steps/harness.ts's plan helpers,
// mirroring how seeding.steps.ts delegates run-ingest to the same file),
// the Workflow tab's ACTIVE todo view (§S3), its HISTORY lens (§S3, C4),
// and the §S0b Runs-timeline plan integration (suppression + declared
// markers/spans). Reuses seeding.steps.ts's project/agent/fail(2/5)/
// pass(5/5) steps and navigation.steps.ts's "I open the workspace for that
// project" wherever they already say exactly what's needed — see the
// feature file header for the AC this expresses.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { filePlan, transitionCycle, closePlan, ingestParsed } from "./harness.ts";

// ── §S0 — plan filing + cycle transitions + plan close ──────────────────────

Step(
  "a cycle plan is filed for cr {string} with a cycle labelled {string}",
  async ({ request, world }, cr: string, label: string) => {
    const res = await filePlan(request, world.projectKey as string, cr, [label]);
    world.planId = res.planId;
    world.cr = res.cr;
    world.cycleId = res.cycles[0]!.id;
  },
);

Step("cycle 1 of that plan is activated", async ({ request, world }) => {
  await transitionCycle(
    request,
    world.projectKey as string,
    world.planId as number,
    world.cycleId as number,
    "active",
  );
});

Step("cycle 1 of that plan is marked done", async ({ request, world }) => {
  await transitionCycle(
    request,
    world.projectKey as string,
    world.planId as number,
    world.cycleId as number,
    "done",
  );
});

Step(
  "the plan is closed with merge commit {string}",
  async ({ request, world }, commit: string) => {
    await closePlan(request, world.projectKey as string, world.planId as number, commit);
  },
);

// ── §S0/§S0b — runs linked to the active cycle via context.cycleId ─────────

Step(
  "a fail\\(2\\/5\\) run linked to that cycle is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    await ingestParsed(
      request,
      world.projectKey as string,
      agentId,
      { total: 5, passed: 3, failed: 2, pending: 0, duration_ms: 40 },
      { context: { cycleId: world.cycleId as number } },
    );
  },
);

Step(
  "a pass\\(5\\/5\\) run linked to that cycle is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    await ingestParsed(
      request,
      world.projectKey as string,
      agentId,
      { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 60 },
      { context: { cycleId: world.cycleId as number } },
    );
  },
);

// ── workspace tab navigation (new — no existing "click a tab" step) ────────

Step("I click the {string} workspace tab", async ({ page }, label: string) => {
  const tab = page.getByTestId("workspace-tab").filter({ hasText: label });
  await expect(tab).toBeVisible();
  await tab.click();
});

// ── §S3 history lens assertions ─────────────────────────────────────────────

function crGroup(page: import("@playwright/test").Page, cr: string) {
  return page
    .getByTestId("workflow-history")
    .locator(`[data-testid="cr-group"][data-cr="${cr}"]`);
}

Step(
  "the history lens shows a cr group for {string} with rollup {string}",
  async ({ page }, cr: string, rollup: string) => {
    const group = crGroup(page, cr);
    await expect(group).toBeVisible();
    await expect(group.getByTestId("cr-rollup")).toContainText(rollup);
  },
);

Step(
  "the cr group for {string} shows a merge-commit pill reading {string}",
  async ({ page }, cr: string, text: string) => {
    const pill = crGroup(page, cr).getByTestId("cr-merge-commit");
    await expect(pill).toContainText(text);
    // SANCTIONED RE-TARGET (CR-CRU-021 §S6.9): the `@` separator between
    // "merged" and the sha was removed — pin its absence explicitly, not
    // just the new substring, so a regression back to "merged @ <sha>"
    // still fails this assertion.
    await expect(pill).not.toContainText("@");
  },
);

// CR-CRU-020 §S1.2/§S2.1 — a history CR group is collapsed by default (its
// `lens-cycle-row` children are absent) and a cycle row's OWN linked runs are
// a further, distinct toggle level (collapsed even once the CR group is
// expanded). These two explicit action steps make that honest in Gherkin —
// the closed-span assertion below no longer holds "for free" on mount.
Step("I expand the cr group for {string}", async ({ page }, cr: string) => {
  const toggle = crGroup(page, cr).getByTestId("cr-group-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
});

Step(
  "I expand cycle {string} in the cr group for {string}",
  async ({ page }, label: string, cr: string) => {
    const cycleRow = crGroup(page, cr).getByTestId("lens-cycle-row").filter({ hasText: label });
    await expect(cycleRow).toBeVisible();
    const toggle = cycleRow.getByTestId("cycle-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
  },
);

Step(
  "the cr group for {string} shows cycle {string} as a closed span containing the linked run for agent {string}",
  async ({ page }, cr: string, label: string, agentId: string) => {
    const group = crGroup(page, cr);
    const cycleRow = group.getByTestId("lens-cycle-row").filter({ hasText: label });
    await expect(cycleRow).toBeVisible();
    await expect(cycleRow).toHaveAttribute("data-status", "done");
    const closedSpan = cycleRow.getByTestId("cycle-span-closed");
    await expect(closedSpan).toBeVisible();
    await expect(
      closedSpan.getByTestId("linked-run-row").filter({ hasText: agentId }).first(),
    ).toBeVisible();
  },
);

Step(
  "the cr group for {string} shows the runtime for agent {string}",
  async ({ page }, cr: string, agentId: string) => {
    const runtime = crGroup(page, cr).getByTestId("cr-agent-runtime").filter({ hasText: agentId });
    await expect(runtime).toBeVisible();
    // §S2 — pin presence of a runtime figure, not its exact ms value (same
    // discipline as tests/workflow-lens.test.ts's group-rollup assertion).
    await expect(runtime).toContainText(/\d/);
  },
);

// ── §S3 active-view assertions ───────────────────────────────────────────────

// SANCTIONED RE-TARGET (CR-CRU-021 §S6 ruling (a) — e2e sweep): the
// CR-CRU-020 click-based toggle on the ACTIVE cycle row no longer exists —
// CR-021 made the active span ALWAYS inline (toggles narrowed to History
// rows only). The old "I expand the active cycle row for …" action step is
// removed (it clicked a `cycle-toggle` that no longer renders); the
// assertion below now pins BOTH the inline linked run AND the absence of
// any toggle, inverting the prior "click reveals" contract.
Step(
  "the workflow active section shows a cycle row for {string} with the linked run for agent {string} rendered inline with no cycle-toggle",
  async ({ page }, label: string, agentId: string) => {
    const row = page
      .getByTestId("workflow-active")
      .getByTestId("cycle-row")
      .filter({ hasText: label });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "active");
    await expect(row.getByTestId("cycle-toggle")).toHaveCount(0);
    await expect(
      row.getByTestId("linked-run-row").filter({ hasText: agentId }).first(),
    ).toBeVisible();
  },
);

// ── §S0b timeline plan integration assertions ───────────────────────────────

Step("the workspace Runs pane shows no transition marker", async ({ page }) => {
  await expect(page.getByTestId("workspace-runs").getByTestId("transition-marker")).toHaveCount(
    0,
  );
});

Step(
  "the workspace Runs pane shows the active cycle span for {string} on {string}",
  async ({ page }, label: string, cr: string) => {
    const span = page.getByTestId("workspace-runs").getByTestId("cycle-span-open");
    await expect(span).toBeVisible();
    await expect(span).toContainText(label);
    await expect(span).toContainText(cr);
    await expect(span).toContainText("active");
  },
);

Step(
  "exactly one transition marker becomes visible within 2 seconds in the workspace Runs pane",
  async ({ page }) => {
    await expect(
      page.getByTestId("workspace-runs").getByTestId("transition-marker"),
    ).toHaveCount(1, { timeout: 2_000 });
  },
);

Step(
  "the declared marker for {string} on {string} becomes visible within 2 seconds",
  async ({ page }, label: string, cr: string) => {
    const marker = page.getByTestId("workspace-runs").getByTestId("declared-marker");
    await expect(marker).toBeVisible({ timeout: 2_000 });
    await expect(marker).toContainText(label);
    await expect(marker).toContainText(cr);
    await expect(marker).toContainText(/closed in/);
  },
);

Step("the workspace Runs pane shows no cycle-span-open element", async ({ page }) => {
  await expect(page.getByTestId("workspace-runs").getByTestId("cycle-span-open")).toHaveCount(0);
});
