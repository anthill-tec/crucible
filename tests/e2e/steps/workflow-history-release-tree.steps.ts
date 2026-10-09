// CR-CRU-173 §S1/AC1/AC2 (page half) — workflow-history-release-tree.feature
// steps: the ship-milestone seed and the release-tree assertions
// (`[data-testid="history-release"]`, the SAME RED-authored contract
// tests/workflow-history-release-tree.test.ts documents at its own header).
// Plan filing/transitions/close, gate ingest, release-proposal and cr-plan
// seeding all come from the EXISTING shared steps (gates.steps.ts,
// workflow.steps.ts, roadmap-graph.steps.ts) — this file adds only what
// those do not already say.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { postMilestone } from "./harness.ts";

Step(
  "release {string} is shipped with commit {string} naming cr {string}",
  async ({ request, world }, label: string, commit: string, cr: string) => {
    await postMilestone(request, world.projectKey as string, world.orchestratorId as string, "release", {
      label,
      commit,
      crs: [cr],
      releasedAt: Math.floor(Date.now() / 1000),
    });
  },
);

function releaseRow(page: Page, label: string): Locator {
  return page.getByTestId("history-release").filter({ hasText: label }).first();
}

function waveGroupIn(row: Locator, wave: string): Locator {
  return row.locator(`[data-testid="wave-group"][data-wave="${wave}"]`);
}

async function isOpen(row: Locator): Promise<boolean> {
  return (await row.getAttribute("data-open")) === "true";
}

Step(
  "the history release tree lists releases in order {string}",
  async ({ page }, label: string) => {
    const rows = page.getByTestId("history-release");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-release", label);
  },
);

Step(
  "the release {string} row is open and reads state {string}",
  async ({ page }, label: string, state: string) => {
    const row = releaseRow(page, label);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-open", "true");
    await expect(row).toContainText(state);
  },
);

Step(
  "the release {string} row shows exactly {int} gate run, the newest reading outcome {string}",
  async ({ page, world }, label: string, count: number, outcome: string) => {
    const row = releaseRow(page, label);
    const runs = row.getByTestId("history-gate-run");
    await expect(runs).toHaveCount(count);
    const newest = runs.first();
    await expect(newest).toHaveAttribute("data-outcome", outcome);
    world.gateRunEventId = await newest.getAttribute("data-event-id");
  },
);

Step(
  "the release {string} row's wave {string} holds cr {string}",
  async ({ page }, label: string, wave: string, cr: string) => {
    const row = releaseRow(page, label);
    const group = waveGroupIn(row, wave);
    await expect(group).toBeVisible();
    // History folds every wave but the open release's open one (F22, user
    // ruling 2026-10-09): open the wave this step reads when it is folded.
    if (!(await isOpen(group))) await group.getByTestId("wave-header").click();
    await expect(group.locator(`[data-testid="cr-group"][data-cr="${cr}"]`)).toBeVisible();
  },
);

Step("I click that gate run's {string} link", async ({ page }, text: string) => {
  const link = page.getByTestId("history-gate-run-link").filter({ hasText: text }).first();
  await expect(link).toBeVisible();
  await link.click();
});

Step("the run drill-in opens for that gate's event", async ({ page, world }) => {
  const overlay = page.getByTestId("run-overlay");
  await expect(overlay).toBeVisible();
  expect(decodeURIComponent(new URL(page.url()).pathname)).toContain(
    `/run/${world.gateRunEventId as string}`,
  );
});

Step(
  "the release {string} row is open and the release {string} row is folded",
  async ({ page }, openLabel: string, foldedLabel: string) => {
    const open = releaseRow(page, openLabel);
    const folded = releaseRow(page, foldedLabel);
    await expect(open).toHaveAttribute("data-open", "true");
    await expect(folded).toHaveAttribute("data-open", "false");
    await expect(folded.getByTestId("wave-group")).toHaveCount(0);
  },
);

Step("I tap the release {string} row's toggle", async ({ page }, label: string) => {
  const row = releaseRow(page, label);
  const toggle = row.getByTestId("history-release-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
});

Step("the release {string} row is open", async ({ page }, label: string) => {
  const row = releaseRow(page, label);
  await expect(row).toHaveAttribute("data-open", "true");
});

// CR-CRU-177 \u00a7S2 (page half, cycle 642) \u2014 RED's own call on the exact
// wording (not pinned verbatim by F22; tests/workflow-history-release-tree.test.ts
// documents the same choice at its own CR-CRU-177 describe block): the
// release row's text holds `<n> CRs completed \u00b7 <p> pending`.
Step(
  "the release {string} row reads {int} CRs completed and {int} pending",
  async ({ page }, label: string, completed: number, pending: number) => {
    const row = releaseRow(page, label);
    await expect(row).toContainText(`${completed} CRs completed \u00b7 ${pending} pending`);
  },
);

// A pending CR (CR-CRU-177 \u00a7S2: the wire's `crs` list never names it) gets
// no `[data-testid="cr-group"]` row anywhere \u2014 not even the old `source===
// "unplanned"` "no plan filed" row DRIFT-3 of the gap analysis flags for
// removal, which today's build still draws for a queued-only CR.
Step(
  "the release {string} row's wave {string} has no row at all for cr {string}",
  async ({ page }, label: string, wave: string, cr: string) => {
    const row = releaseRow(page, label);
    const group = waveGroupIn(row, wave);
    await expect(group).toBeVisible();
    if (!(await isOpen(group))) await group.getByTestId("wave-header").click();
    await expect(group.locator(`[data-testid="cr-group"][data-cr="${cr}"]`)).toHaveCount(0);
    await expect(group).not.toContainText("no plan filed");
  },
);
