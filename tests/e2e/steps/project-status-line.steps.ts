// project-status-line.feature steps — the Project pane card's status line
// (`data-testid="project-status-line"`) read against the REAL server.
//
// Reuses seeding.steps.ts (project + online agent), workflow.steps.ts (plan
// filing, cycle transitions, the cycle-linked pass(5/5) run, plan close),
// run-lifecycle.steps.ts (a run started on the active cycle) and
// navigation.steps.ts ("I open the workspace for that project"). Everything new
// here delegates to harness.ts's helpers or calls the same route a client
// calls; nothing is stubbed into the page.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestCompile, postMilestone, registerAgent } from "./harness.ts";

/** One rustc error and no warning: the parser counts exactly one `error[…]` head. */
const RUSTC_ONE_ERROR = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
].join("\n");

/**
 * Warnings only, as non-empty text: the compile route refuses empty `errors`
 * text, so a clean build that still warns is how a client reports one.
 */
const RUSTC_WARNINGS_ONLY = [
  "warning: unused import: `std::fmt`",
  " --> src/lib.rs:1:5",
  "warning: unused variable: `x`",
  " --> src/lib.rs:3:9",
].join("\n");

/** The live line updates over the stream, so every read waits this long for it. */
const LIVE_UPDATE_MS = 5_000;

const statusLine = (page: Page) => page.getByTestId("project-status-line");

Step(
  "a {string} milestone for that cr is posted by agent {string}",
  async ({ request, world }, type: string, agentId: string) => {
    const res = await postMilestone(request, world.projectKey as string, agentId, type, {
      label: world.cr as string,
    });
    world.milestoneEventId = res.event;
  },
);

// FRESH, because a re-registration of a live id is a no-op touch that writes
// no lifecycle event — and that event is the thing that must not move the line.
Step(
  "a fresh agent {string} registers on that project",
  async ({ request, world }, agentId: string) => {
    const before = await request.get(`/api/v2/agents?project=${world.projectKey as string}`);
    expect(before.ok()).toBe(true);
    const listed = (await before.json()) as { agents?: Array<{ agentId?: string }> };
    expect((listed.agents ?? []).map((agent) => agent.agentId)).not.toContain(agentId);
    await registerAgent(request, world.projectKey as string, agentId, "fresh registration");
  },
);

Step(
  "a rustc compile result with exactly one error is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestCompile(request, world.projectKey as string, agentId, RUSTC_ONE_ERROR, "rustc");
    expect(res.errors).toBe(1);
    expect(res.warnings).toBe(0);
    world.eventId = res.event;
  },
);

Step(
  "a rustc compile result with warnings and no errors is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestCompile(
      request,
      world.projectKey as string,
      agentId,
      RUSTC_WARNINGS_ONLY,
      "rustc",
    );
    expect(res.errors).toBe(0);
    expect(res.warnings).toBe(2);
    world.eventId = res.event;
  },
);

// The run's own agent closes it through the abort route, the way a client
// that knows nothing will file the run ends it.
Step(
  "that run is aborted by agent {string} with reason {string}",
  async ({ request, world }, agentId: string, reason: string) => {
    const runId = world.runId as string;
    const res = await request.post(`/api/v2/runs/${encodeURIComponent(runId)}/abort`, {
      data: { projectKey: world.projectKey as string, agentId, reason },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status?: string; runId?: string };
    expect(body.status).toBe("aborted");
    expect(body.runId).toBe(runId);
  },
);

Step("the project status line reads {string}", async ({ page }, text: string) => {
  await expect(statusLine(page)).toHaveText(text, { timeout: LIVE_UPDATE_MS });
});

Step(
  "the project status line carries the {string} class and not the {string} class",
  async ({ page }, present: string, absent: string) => {
    const line = statusLine(page);
    await expect(line).toHaveClass(new RegExp(`\\b${present}\\b`), { timeout: LIVE_UPDATE_MS });
    await expect(line).not.toHaveClass(new RegExp(`\\b${absent}\\b`));
  },
);

Step(
  "the project status line carries neither the {string} nor the {string} class",
  async ({ page }, first: string, second: string) => {
    const line = statusLine(page);
    await expect(line).toBeVisible();
    // Still the status line itself, not an element stripped of its styling.
    await expect(line).toHaveClass(/\bapp-status-line\b/);
    await expect(line).not.toHaveClass(new RegExp(`\\b${first}\\b`));
    await expect(line).not.toHaveClass(new RegExp(`\\b${second}\\b`));
  },
);
