// CR-CRU-013 C6 — workflow-gates.feature steps: the AC150 e2e round trip.
// File a wave-scoped plan, post a gap-analysis milestone (§S4b), close the
// cycle + plan, ingest a passed gate (§S1) — then assert the workspace
// timeline's milestone entry + boundary gate card (§S2/§S4b), the home
// timeline's compact gate entry with zero milestones (§S4b surface
// scoping), the History lens's `gated` wave header (§S6), and the
// Workflow-tab's populated gate pane (§S4). Reuses seeding.steps.ts's
// project step, workflow.steps.ts's cycle-transition/close/tab steps, and
// navigation.steps.ts's "I open the home page" wherever they already say
// exactly what's needed; only the gate/milestone-specific actions and
// assertions are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { filePlan, postGate, postMilestone } from "./harness.ts";

// ── §S0/§S6 — a wave-scoped plan (existing "a cycle plan is filed for cr …
// with a cycle labelled …" step, in workflow.steps.ts, carries no wave —
// this is a distinct phrasing, not a regex overload of it). ────────────────
Step(
  "a cycle plan is filed for cr {string} with a cycle labelled {string} in wave {string}",
  async ({ request, world }, cr: string, label: string, wave: string) => {
    const res = await filePlan(request, world.projectKey as string, cr, [label], wave);
    world.planId = res.planId;
    world.cr = res.cr;
    world.cycleId = res.cycles[0]!.id;
  },
);

// ── §S4b — POST /api/v2/milestones {type:"gap-analysis", label, context:
// {cr, wave}} ────────────────────────────────────────────────────────────
Step(
  "a gap-analysis milestone {string} is posted for that cr in wave {string}",
  async ({ request, world }, label: string, wave: string) => {
    const res = await postMilestone(request, world.projectKey as string, "orchestrator-1", "gap-analysis", {
      label,
      context: { cr: world.cr as string, wave },
    });
    world.milestoneEventId = res.event;
  },
);

// ── §S1 — POST /api/v2/gates, full shape (intent/outcome/steps/push),
// `context.wave` matching the closed plan's declared wave (§S6 boundary
// condition). ───────────────────────────────────────────────────────────
Step(
  "a passed no-mistakes gate is ingested via the API for wave {string} with push commit {string}",
  async ({ request, world }, wave: string, commit: string) => {
    const res = await postGate(
      request,
      world.projectKey as string,
      "orchestrator-1",
      {
        intent: `wave ${wave} no-mistakes gate`,
        outcome: "passed",
        steps: [
          { name: "intent", status: "passed" },
          {
            name: "review",
            status: "passed",
            findings: { total: 2, autoFix: 1, askUser: 0, fixed: 2 },
          },
          { name: "test", status: "passed" },
          { name: "push", status: "passed", fixRounds: 0 },
        ],
        push: { commit, remote: "origin/main" },
      },
      { wave },
    );
    world.gateEventId = res.event;
  },
);

// ── §S4b — the WORKSPACE Runs pane shows the milestone slim row (◇ glyph,
// type, label, CR badge); home never renders this testid for a non-merge
// milestone (asserted separately below). ───────────────────────────────────
Step(
  "the workspace Runs pane shows a milestone entry with label {string} and CR badge {string}",
  async ({ page }, label: string, cr: string) => {
    const entry = page
      .getByTestId("workspace-runs")
      .getByTestId("milestone-entry")
      .filter({ hasText: label });
    await expect(entry).toBeVisible();
    await expect(entry.getByTestId("milestone-cr-badge")).toHaveText(cr);
  },
);

// ── §S2 — the WORKSPACE Runs pane shows the full-width boundary gate card
// (never the compact one-liner), outcome + pushed short-commit in the
// `gate-seal` child, and never the "0/" test-ratio leak (bound). ──────────
Step(
  "the workspace Runs pane shows a gate card with outcome {string} and pushed commit {string}",
  async ({ page }, outcome: string, commit: string) => {
    const shortCommit = commit.slice(0, 7);
    const card = page
      .getByTestId("workspace-runs")
      .getByTestId("gate-card")
      .filter({ hasText: shortCommit });
    await expect(card).toBeVisible();
    const seal = card.getByTestId("gate-seal");
    await expect(seal).toContainText(outcome);
    await expect(seal).toContainText(shortCommit);
    await expect(seal).not.toContainText("0/");
    await expect(page.getByTestId("workspace-runs").getByTestId("gate-card-compact")).toHaveCount(0);
  },
);

// ── §S6 — the History lens's wave-header gains `gated` once a
// passed/checks-passed gate exists for that wave; must NOT still read
// "awaiting review" once gated (bound). ─────────────────────────────────
Step("the wave header for wave {string} reads {string}", async ({ page }, wave: string, text: string) => {
  const group = page
    .getByTestId("workflow-history")
    .locator(`[data-testid="wave-group"][data-wave="${wave}"]`);
  await expect(group).toBeVisible();
  const header = group.getByTestId("wave-header");
  await expect(header).toContainText(text);
  await expect(header).not.toContainText("awaiting review");
});

// ── §S4 — the Workflow-tab's contextual gate widget replaces the CR-011
// static placeholder in place (same `gate-pane` testid) once the wave's
// plans are all closed and a gate event exists — populated with the SAME
// outcome-banner/step-row body the §S3 timeline drill-in uses. ──────────
Step(
  "the Workflow tab's gate pane is populated with the outcome banner and at least one step row",
  async ({ page }) => {
    const pane = page.getByTestId("gate-pane");
    await expect(pane).toBeVisible();
    await expect(pane).not.toContainText("gate reporting lands in CR-013");
    await expect(pane.getByTestId("gate-outcome-banner")).toBeVisible();
    await expect(pane.getByTestId("gate-step-row").first()).toBeVisible();
  },
);

// ── §S4b — the HOME timeline renders the gate compact one-liner (never the
// full-width card) and zero milestone entries anywhere on the page (home
// omits non-merge milestones entirely — a global count, since no feature in
// this suite ever posts a milestone that would render there). ────────────
Step(
  "the home timeline shows a compact gate entry with outcome {string} and pushed commit {string}",
  async ({ page }, outcome: string, commit: string) => {
    const shortCommit = commit.slice(0, 7);
    const compact = page
      .getByTestId("timeline")
      .getByTestId("gate-card-compact")
      .filter({ hasText: shortCommit });
    await expect(compact).toBeVisible();
    await expect(compact).toContainText(outcome);
    await expect(page.getByTestId("timeline").getByTestId("gate-card")).toHaveCount(0);
  },
);

Step("the home timeline shows zero milestone entries", async ({ page }) => {
  await expect(page.getByTestId("milestone-entry")).toHaveCount(0);
});
