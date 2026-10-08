// Steps for tests/e2e/features/workflow-now-pane.feature — CR-CRU-172
// §S2/AC3's three Now states. Only the in-flight-gate posting step, the
// gate-view content assertion, the "Nothing running" text assertion and its
// link click are new here; everything else is reused from seeding.steps.ts,
// navigation.steps.ts, drillin.steps.ts, project-landing-pane.steps.ts and
// workflow.steps.ts (see the feature file header).
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { postGate } from "./harness.ts";

// ── §S0/AC1 (already live) — an IN-FLIGHT snapshot naming its release and
// its run identity, exactly as the real clients post one (gate_from_axi):
// `run: {id, branch, head}` inside the gate payload, `version` as the
// POST's top-level sibling. ────────────────────────────────────────────
Step(
  "an in-flight no-mistakes gate is ingested via the API for release {string} with run id {string}",
  async ({ request, world }, release: string, runId: string) => {
    const res = await postGate(
      request,
      world.projectKey as string,
      "orchestrator-nowe2e-1",
      {
        intent: `release ${release} no-mistakes gate (in flight)`,
        outcome: "checks-passed",
        steps: [
          { name: "intent", status: "passed" },
          { name: "review", status: "running" },
        ],
        run: { id: runId, branch: `release/${release}`, head: "nowe2ehead" },
        inFlight: true,
      },
      undefined,
      release,
    );
    world.gateEventId = res.event;
  },
);

// ── §S2/AC3 — the exact empty-state line, full-text, never a substring
// match (a runaway suffix must fail this). ───────────────────────────────
Step("the Workflow tab reads exactly {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("workspace-body")).toHaveText(text);
});

// ── §S2/AC3 — the "→ Roadmap" link embedded in the empty-state line
// selects the Roadmap tab. ────────────────────────────────────────────────
Step("I click the {string} link in the Workflow tab", async ({ page }, text: string) => {
  const link = page.getByTestId("workspace-body").getByText(text, { exact: true });
  await expect(link).toBeVisible();
  await link.click();
});

// ── §S2/AC3 — F21's gate view: the header names the release, the run line
// names the run id. ───────────────────────────────────────────────────────
Step(
  "the Workflow tab's gate view names release {string} and run {string}",
  async ({ page }, release: string, runId: string) => {
    const header = page.getByTestId("gate-view-header");
    await expect(header).toContainText(`release ${release}`);
    const runLine = page.getByTestId("gate-run-line");
    await expect(runLine).toContainText(runId);
  },
);
