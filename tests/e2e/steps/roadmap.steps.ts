// CR-CRU-014 §S3, as amended by CR-CRU-118 §S2 — roadmap.feature steps:
// registering a CR through the real per-CR membership route (POST
// /api/v2/projects/<key>/queue/plan, CR-CRU-105 §S1 — the bulk door this step
// used to post through is the migration door, and §S3 deprecates it), and
// asserting the workspace Roadmap tab's derived status badge against the SPA's
// DOM as a plan is filed and closed.
// Reuses seeding.steps.ts (project/agent), navigation.
// steps.ts ("I open the workspace for that project"), and workflow.steps.ts
// ("I click the {string} workspace tab", "a cycle plan is filed …", "the plan
// is closed with merge commit …") wherever they already say what is needed —
// only the queue-registration and roadmap-row assertion steps are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

// CR-CRU-118 §S2 — this step used to register the CR through the bulk
// full-replace POST …/queue with no release at all. That door now refuses an
// INSERT it would have to invent membership for, and rightly: a row nobody
// declared into a release is a row no roadmap can place. §S3 deprecates the
// door outright, and roadmap-graph.feature already says in prose what our own
// scenarios do instead — propose the release, then declare the CR into it
// through `cr-plan` (POST …/queue/plan, CR-CRU-105 §S1). This step follows
// that idiom rather than inventing a second one.
//
// Membership is SCAFFOLDING here: this scenario's subject is the roadmap row's
// DERIVED status badge, and nothing it asserts reads the release or the
// orchestrator. So the Gherkin phrase keeps naming exactly what the scenario
// is about (cr, title, wave) and the step supplies the rest itself — the
// precedent roadmap-graph.steps.ts set for the mandatory `targetAt` (§S4a),
// which no scenario there draws either. A PROPOSED release is not a SHIPPED
// one, so `shipped` (store.ts's `crs`-of-a-recorded-release set) still does
// not name this CR and the row's first reading is PENDING exactly as before.
//
// Both posts still go straight through the `request` fixture at the
// harness-owned ephemeral port — the same primitive the harness helpers use,
// so the ephemeral-target discipline still holds.
Step(
  "a CR queue registering cr {string} titled {string} in wave {string} is posted for that project",
  async ({ request, world }, cr: string, title: string, wave: string) => {
    const projectKey = world.projectKey as string;
    // Declaring membership is ORCHESTRATOR work (`requireOrchestrator`), a role
    // the shared seeding step deliberately never hands out (`role: "report"`),
    // so the scaffolding registers its own.
    const orchestratorId = "rm-lifecycle-orch";
    const orchestrator = await request.post("/api/v2/agents/register", {
      data: {
        projectKey,
        agentId: orchestratorId,
        message: "CR-CRU-118 — e2e roadmap-row orchestrator",
        status: "online",
        role: "ORCHESTRATOR",
      },
    });
    expect(orchestrator.ok()).toBe(true);
    world.orchestratorId = orchestratorId;
    // A declared label must hold a LIVE proposal (CR-CRU-104 §S1), and a
    // proposal must name a target date (CR-CRU-118 §S4a).
    const release = "0.2.0";
    const proposal = await request.post(
      `/api/v2/projects/${projectKey}/release-proposals`,
      {
        data: {
          label: release,
          agentId: orchestratorId,
          targetAt: 1_788_220_800, // 2026-09-01T00:00:00Z
        },
      },
    );
    expect(proposal.ok()).toBe(true);
    world.release = release;
    const res = await request.post(`/api/v2/projects/${projectKey}/queue/plan`, {
      data: { agentId: orchestratorId, cr, title, release, wave },
    });
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
