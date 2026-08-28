// CR-CRU-014 §S3, as amended by CR-CRU-078 §S1/§S4 — roadmap-graph.feature
// steps: the roadmap's FLOWCHART zone, driven against the SPA over the real
// server. Reuses seeding.steps.ts (project/agent), navigation.steps.ts ("I open
// the workspace for that project") and workflow.steps.ts ("I click the {string}
// workspace tab", "a cycle plan is filed for cr … with a cycle labelled …") —
// only the release declaration, the flowchart assertions and the node click
// are new here.
//
// CR-CRU-078 §S1 RETIRED two steps with the exclusive toggle they drove:
// "I switch the roadmap view to graph" (it clicked `roadmap-view-graph`, a
// button that no longer exists) and "no roadmap table row is present" (the
// exclusion itself: AC1 renders the table BESIDE the flowchart).
//
// CR-CRU-078 §S4 then RETIRED the cytoscape seam these steps reached through.
// Zone 2 was a <canvas> with no per-node DOM element, so the count rode a
// `data-cr-node-count` attribute and both the status read and the tap went
// through `window.crucibleRoadmapCy`. The canvas is gone — the focused
// release's flowchart is plain DOM — so every step below addresses a real
// element by testid, and the published instance handle is retired with the
// instance. Nothing is asserted less: the node's derived status is now a real
// attribute, and the tap is a real click.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
// CR-CRU-091 §S8 — proposing a release is ORCHESTRATOR-only (`requireOrchestrator`,
// src/v2.ts:265), which is a role the shared seeding step deliberately does not
// hand out: it registers `role: "report"` so an e2e fixture can never look like
// a planning authority by accident. A scenario that needs one asks for it.
Step(
  "an orchestrator {string} is registered on that project",
  async ({ request, world }, agentId: string) => {
    const res = await request.post("/api/v2/agents/register", {
      data: {
        projectKey: world.projectKey as string,
        agentId,
        message: "CR-CRU-078 — e2e roadmap orchestrator",
        status: "online",
        role: "ORCHESTRATOR",
      },
    });
    expect(res.ok()).toBe(true);
    world.orchestratorId = agentId;
  },
);

// CR-CRU-091 §S8 — POST …/release-proposals. Zone 2 draws the FOCUSED release,
// and landing focuses the release in progress (§S5), so this is what puts a
// wave container on the surface at all.
Step(
  "a release {string} is proposed for that project",
  async ({ request, world }, label: string) => {
    const res = await request.post(
      `/api/v2/projects/${world.projectKey as string}/release-proposals`,
      { data: { label, agentId: world.orchestratorId as string } },
    );
    expect(res.ok()).toBe(true);
  },
);

// The queue full-replace POST with the CR DECLARED into a release (CR-CRU-091
// §S2's `release` field): membership of a proposed release is that declaration
// and nothing else, so the flowchart cannot draw the CR without it.
Step(
  "a CR queue registering cr {string} titled {string} in wave {string} for release {string} is posted for that project",
  async ({ request, world }, cr: string, title: string, wave: string, release: string) => {
    const res = await request.post(`/api/v2/projects/${world.projectKey as string}/queue`, {
      data: { entries: [{ cr, title, wave, dependsOn: [], release }] },
    });
    expect(res.ok()).toBe(true);
  },
);

// §S4/AC9 — the focused release's flowchart, its wave container, and how many
// CRs that container holds. All three are DOM now, so all three are addressed
// directly rather than through a count attribute standing in for a canvas.
Step(
  "the roadmap flowchart for release {string} renders wave {string} holding {int} CR nodes within {int} seconds",
  async ({ page }, version: string, wave: string, count: number, seconds: number) => {
    const timeout = seconds * 1_000;
    const flow = page.getByTestId("roadmap-flow");
    await expect(flow).toBeVisible({ timeout });
    await expect(flow).toHaveAttribute("data-version", version, { timeout });
    const box = flow.locator(`[data-testid="roadmap-wave"][data-wave="${wave}"]`);
    await expect(box).toBeVisible({ timeout });
    await expect(box.getByTestId("roadmap-node")).toHaveCount(count, { timeout });
  },
);

// CR-CRU-083 AC7 — the per-node derived status the click gate reads, observed
// live. It pins the SSE status seam (the roadmap body re-renders on every
// queue frame) and it makes the landable click below DETERMINISTIC: the plan
// POST's status flip reaches the SPA over SSE, so a bare click straight after
// filing would race the refetch and fire on a node still carrying PENDING.
Step(
  "the roadmap flowchart node for {string} carries status {string} within {int} seconds",
  async ({ page }, cr: string, status: string, seconds: number) => {
    const node = page.locator(`[data-testid="roadmap-node"][data-cr="${cr}"]`);
    await expect(node).toHaveAttribute("data-status", status, { timeout: seconds * 1_000 });
  },
);

Step("I click the roadmap flowchart node for {string}", async ({ page }, cr: string) => {
  await page.locator(`[data-testid="roadmap-node"][data-cr="${cr}"]`).click();
});

// The one-rule swap: the named workspace tab carries the active `on` class.
Step(
  "the {string} workspace tab becomes active within {int} seconds",
  async ({ page }, label: string, seconds: number) => {
    const tab = page.getByTestId("workspace-tab").filter({ hasText: label });
    await expect(tab).toHaveClass(/\bon\b/, { timeout: seconds * 1_000 });
  },
);

// CR-CRU-083 AC7 — the INERT half of the gate, asserted positively so it
// cannot pass vacuously. The click runs the app's handler synchronously
// in-page, so by the time the step returns the swap decision is already made;
// only VanJS's next-tick class commit is outstanding. Settling for the named
// window and then asserting the ORIGINAL tab still carries `on` is therefore a
// real negative: the tab class is `state.workspaceTab === name` (app.js
// WorkspaceTabs), so exactly one tab is `on` at a time and "Roadmap is still
// on" is precisely "the click did not swap to Workflow". A bare
// `not.toHaveClass` would have passed instantly and proved nothing.
Step(
  "the {string} workspace tab is still active {int} milliseconds later",
  async ({ page }, label: string, ms: number) => {
    await page.waitForTimeout(ms);
    const tab = page.getByTestId("workspace-tab").filter({ hasText: label });
    await expect(tab).toHaveClass(/\bon\b/);
  },
);
