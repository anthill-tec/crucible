// agent-card-follows-its-streaming-run.feature — steps. An agent's card
// follows its streaming run batch by batch, whichever comes first — the run's
// first batch or the page's first read of the open run — and after a reload
// mid-run; once the run closes it reads the agent's own line again.
//
// Nothing is doubled. The one step defined here reads the agents route the
// page itself reads and compares the card with the line the board serves for
// the agent: its idle line, else its message (the card's own line when no run
// streams). Every wait is on the page, bounded by a few frame cadences.
//
// Reuses seeding.steps.ts (project, agent, and the agent's registration again
// with a new message), run-lifecycle.steps.ts (run start, the no-reload
// witness), run-stream-live-page.steps.ts (the three stream batches, the
// close, the card's running line), navigation.steps.ts (opening the
// workspace), run-live-view.steps.ts (the reload) and
// agent-row-follows-its-runs-first-batch.steps.ts (the streaming mark).
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";

const secondsToMs = (seconds: number): number => seconds * 1_000;

const agentRow = (page: Page, agentId: string): Locator =>
  page.getByTestId("project-pane").getByTestId("agent-row").filter({ hasText: agentId });

interface ServedAgent {
  agentId: string;
  message?: string;
  idleLine?: string;
}

Step(
  "the agent row for {string} reads the agent's own line the board serves, unmarked, within {int} seconds",
  async ({ page, request, world }, agentId: string, seconds: number) => {
    const row = agentRow(page, agentId);
    await expect(row).toHaveCount(1);
    const message = row.locator(".app-agent-msg");
    await expect(message).not.toHaveText(/^running /, { timeout: secondsToMs(seconds) });
    await expect(row).not.toHaveClass(/(^|\s)app-agent-streaming(\s|$)/, { timeout: secondsToMs(seconds) });
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/v2/agents?project=${world.projectKey as string}`);
          expect(res.status()).toBe(200);
          const body = (await res.json()) as { agents?: ServedAgent[] };
          const served = (body.agents ?? []).filter((a) => a.agentId === agentId);
          if (served.length !== 1) return `the board serves ${String(served.length)} briefs for ${agentId}`;
          const own = served[0]?.idleLine ?? (served[0]?.message || "—");
          const shown = ((await message.textContent()) ?? "").replace(/\s+/g, " ").trim();
          return shown === own ? "the card reads the agent's own line" : `the card reads "${shown}"; the board serves "${own}"`;
        },
        { timeout: secondsToMs(seconds) },
      )
      .toBe("the card reads the agent's own line");
  },
);
