// agent-row-follows-its-runs-first-batch.feature — steps. A page that was
// open before a run started follows that run's live counts from its first
// stream batch: the agent row in the Project pane and the Runs tab's running
// card, without a reload or a tab switch.
//
// Nothing is doubled: the run opens through POST /api/v2/runs/start
// (run-lifecycle.steps.ts's "a run is started for agent …"), its first batch
// goes to POST /api/v2/runs/<runId>/stream, and the page moves on the board's
// own throttled `events` frames. The board serves the open run WITHOUT `live`
// until that batch lands, so each scenario first waits until the page shows
// it holds the open run (the row's streaming mark, or the plain running
// card) before posting the batch — that is the transition under test. Every
// wait is on the page, bounded by a few frame cadences; never a sleep.
//
// Reuses seeding.steps.ts (project, agent), workflow.steps.ts (the tab
// click), run-lifecycle.steps.ts (run start, the no-reload witness) and
// run-stream-live-page.steps.ts / run-live-view.steps.ts (the agent row's
// text, the live drill-in's URL).
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";

const STREAM_CODEC = "crucible-events";

const secondsToMs = (seconds: number): number => seconds * 1_000;

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

/**
 * A run's first stream batch: the run-start stating `total`, then `done`
 * passing tests, the last of them in `lastFile` (the live state's current
 * file) and the ones before it in files of their own.
 */
function firstBatch(runId: string, done: number, total: number, lastFile: string): string {
  let text = line({ event: "run-start", total });
  for (let i = 1; i <= done; i += 1) {
    const file = i === done ? lastFile : `src/${runId}-earlier-${String(i)}.test.ts`;
    text += line({
      event: "test-end",
      id: `${runId}-t${String(i)}`,
      name: `finishes step ${String(i)}`,
      suite: "FirstBatch",
      file,
      status: "pass",
      duration_ms: 3,
    });
  }
  return text;
}

const agentRow = (page: Page, agentId: string): Locator =>
  page.getByTestId("project-pane").getByTestId("agent-row").filter({ hasText: agentId });

/** The running card of the run the scenario started last, by its run id. */
function thatRunsCard(page: Page, runId: string): Locator {
  return page.locator(`[data-testid="running-card"][data-run-id="${runId}"]`);
}

Step("I open that project's board on the Roadmap tab", async ({ page, world }) => {
  await page.goto(`/p/${world.projectKey as string}/roadmap`);
  const roadmap = page.getByTestId("workspace-tab").filter({ hasText: "Roadmap" });
  await expect(roadmap).toHaveClass(/(^|\s)on(\s|$)/);
  await expect(page.getByTestId("project-pane")).toBeVisible();
  world.activeTab = "Roadmap";
});

Step(
  "the agent row for {string} shows the agent streaming and reads {string} within {int} seconds",
  async ({ page }, agentId: string, message: string, seconds: number) => {
    const row = agentRow(page, agentId);
    await expect(row).toHaveCount(1);
    // The streaming mark is the page's own evidence it holds the open run —
    // still without `live`, since no batch has been posted yet.
    await expect(row).toHaveClass(/(^|\s)app-agent-streaming(\s|$)/, { timeout: secondsToMs(seconds) });
    await expect(row.locator(".app-agent-msg")).toHaveText(message);
  },
);

Step(
  "that run's first stream batch lands for agent {string} with {int} of {int} tests done, the last in {string}",
  async ({ request, world }, agentId: string, done: number, total: number, lastFile: string) => {
    const runId = world.runId as string;
    const data = firstBatch(runId, done, total, lastFile);
    const res = await request.post(`/api/v2/runs/${runId}/stream`, {
      data: { projectKey: world.projectKey as string, agentId, codec: STREAM_CODEC, from: 0, data },
    });
    const body = (await res.json()) as { ok?: boolean; held?: number };
    expect(res.status(), JSON.stringify(body)).toBe(200);
    expect(body.held).toBe(Buffer.byteLength(data, "utf8"));
  },
);

Step("the Roadmap tab is still the one on screen", async ({ page, world }) => {
  const roadmap = page.getByTestId("workspace-tab").filter({ hasText: "Roadmap" });
  await expect(roadmap).toHaveClass(/(^|\s)on(\s|$)/);
  expect(new URL(page.url()).pathname).toBe(`/p/${world.projectKey as string}/roadmap`);
});

Step("that run's running card is plain within {int} seconds", async ({ page, world }, seconds: number) => {
  const card = thatRunsCard(page, world.runId as string);
  await expect(card).toBeVisible({ timeout: secondsToMs(seconds) });
  await expect(card).not.toHaveClass(/(^|\s)app-evt-running-live(\s|$)/);
  await expect(card.getByTestId("running-label")).toHaveText("running…");
  await expect(card.getByTestId("running-count")).toHaveCount(0);
  await expect(card.getByTestId("running-progress")).toHaveCount(0);
  world.runningCard = card;
});

Step(
  "that run's running card is live and reads {string} in {string} within {int} seconds",
  async ({ page, world }, count: string, file: string, seconds: number) => {
    const card = thatRunsCard(page, world.runId as string);
    await expect(card).toHaveClass(/(^|\s)app-evt-running-live(\s|$)/, { timeout: secondsToMs(seconds) });
    await expect(card.getByTestId("running-count")).toHaveText(count);
    await expect(card.getByTestId("running-file")).toHaveText(file);
    await expect(card.getByTestId("running-progress")).toHaveCount(1);
    await expect(card.getByTestId("running-open-hint")).toHaveText("› open");
    await expect(card.getByTestId("running-label")).toHaveCount(0);
    world.runningCard = card;
  },
);
