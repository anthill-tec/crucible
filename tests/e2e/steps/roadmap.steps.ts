// CR-CRU-014 §S3 — roadmap.feature steps: registering a CR queue through the
// real POST /api/v2/projects/<key>/queue route (§S1), and asserting the
// workspace Roadmap tab's derived status badge against the SPA's DOM as a plan
// is filed and closed. Reuses seeding.steps.ts (project/agent), navigation.
// steps.ts ("I open the workspace for that project"), and workflow.steps.ts
// ("I click the {string} workspace tab", "a cycle plan is filed …", "the plan
// is closed with merge commit …") wherever they already say what is needed —
// only the queue-registration and roadmap-row assertion steps are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

// The queue full-replace POST (§S1). Posted straight through the `request`
// fixture at the harness-owned ephemeral port — the same primitive the
// harness helpers use, so the ephemeral-target discipline still holds.
Step(
  "a CR queue registering cr {string} titled {string} in wave {string} is posted for that project",
  async ({ request, world }, cr: string, title: string, wave: string) => {
    const res = await request.post(
      `/api/v2/projects/${world.projectKey as string}/queue`,
      { data: { entries: [{ cr, title, wave, dependsOn: [] }] } },
    );
    expect(res.ok()).toBe(true);
  },
);

// The roadmap row's derived status badge, asserted live: the row is keyed by
// its CR id, and the status badge inside it must reach the expected value
// within the SSE-refetch window (no reload).
Step(
  "the roadmap row for {string} shows status {string} within {int} seconds",
  async ({ page }, cr: string, status: string, seconds: number) => {
    const badge = page.locator(
      `[data-testid="roadmap-row"][data-cr="${cr}"] [data-testid="roadmap-status-badge"]`,
    );
    await expect(badge).toHaveText(status, { timeout: seconds * 1_000 });
  },
);
