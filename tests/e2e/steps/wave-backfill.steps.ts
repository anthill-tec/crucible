// CR-CRU-031 §S4 — wave-backfill.feature steps: the AC4 e2e round trip.
// Two plans are in play SIMULTANEOUSLY on the same project (a wave-less
// one + a wave-42 one), but every existing generic plan step in
// workflow.steps.ts/gates.steps.ts (activate/done/close) reads and writes
// the SINGLE current-plan slot world.planId/world.cycleId — a second
// filePlan call would silently clobber the first plan's identity there.
// So the wave-less plan gets its OWN explicitly-named steps here (storing
// world.wavelessPlanId/world.wavelessCycleId), while the wave-42 plan
// reuses the existing generic steps unchanged (gates.steps.ts's
// "…in wave {string}" filing step + workflow.steps.ts's
// activate/done/close steps, which is fine since the wave-less plan's own
// lifecycle is already fully driven through before the wave-42 plan is
// filed and claims the singular world.planId/world.cycleId slot).
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { filePlan, transitionCycle, closePlan, backfillPlanWave } from "./harness.ts";

Step(
  "a cycle plan with no wave is filed for cr {string} with a cycle labelled {string}",
  async ({ request, world }, cr: string, label: string) => {
    const res = await filePlan(request, world.projectKey as string, cr, [label]);
    world.wavelessPlanId = res.planId;
    world.wavelessCr = res.cr;
    world.wavelessCycleId = res.cycles[0]!.id;
  },
);

Step("the wave-less plan's cycle 1 is activated", async ({ request, world }) => {
  await transitionCycle(
    request,
    world.projectKey as string,
    world.wavelessPlanId as number,
    world.wavelessCycleId as number,
    "active",
  );
});

Step("the wave-less plan's cycle 1 is marked done", async ({ request, world }) => {
  await transitionCycle(
    request,
    world.projectKey as string,
    world.wavelessPlanId as number,
    world.wavelessCycleId as number,
    "done",
  );
});

Step(
  "the wave-less plan is closed with merge commit {string}",
  async ({ request, world }, commit: string) => {
    await closePlan(request, world.projectKey as string, world.wavelessPlanId as number, commit);
  },
);

// ── §S1 — PATCH …/plans/<planId> {wave} (no status), the CR-CRU-031
// remediation lever this scenario exercises against the wave-less plan
// specifically (never the wave-42 plan, which already carries a wave). ──
Step(
  "the wave-less plan's wave is backfilled to {string} via the plans PATCH endpoint",
  async ({ request, world }, wave: string) => {
    const res = await backfillPlanWave(
      request,
      world.projectKey as string,
      world.wavelessPlanId as number,
      wave,
    );
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.plan.wave).toBe(wave);
  },
);

// ── History lens assertions — wave bands are the `[data-testid="wave-group"]`
// divs keyed by `data-wave` (public/app.js's WaveGroup); a wave-less plan
// groups under the empty-string label (public/app-logic.mjs's
// `waveNode(plan.wave ?? "")`) — the "phantom unnumbered" band the CR
// describes. `[data-testid="cr-group"][data-cr="<cr>"]` (app.js's
// LensCrGroup) identifies a CR's node regardless of collapse state (the
// header line carrying the CR name always renders). ─────────────────────
function waveGroup(page: Page, wave: string): Locator {
  return page
    .getByTestId("workflow-history")
    .locator(`[data-testid="wave-group"][data-wave="${wave}"]`);
}

function crGroupIn(group: Locator, cr: string): Locator {
  return group.locator(`[data-testid="cr-group"][data-cr="${cr}"]`);
}

Step(
  "the history lens shows a phantom unnumbered wave band holding {string}, separate from the wave {string} band holding {string}",
  async ({ page }, wavelessCr: string, wave: string, waveNCr: string) => {
    const phantom = waveGroup(page, "");
    await expect(phantom).toBeVisible();
    await expect(crGroupIn(phantom, wavelessCr)).toBeVisible();
    // the wave-less band must NOT also hold the wave-N plan's CR node.
    await expect(crGroupIn(phantom, waveNCr)).toHaveCount(0);

    const waveNBand = waveGroup(page, wave);
    await expect(waveNBand).toBeVisible();
    await expect(crGroupIn(waveNBand, waveNCr)).toBeVisible();
    // the wave-N band must NOT (yet) hold the wave-less plan's CR node —
    // the two bands are genuinely separate at this point in the scenario.
    await expect(crGroupIn(waveNBand, wavelessCr)).toHaveCount(0);

    // exactly two bands exist for this project — the phantom one and the
    // real wave-N one, never a single merged band this early.
    await expect(page.getByTestId("workflow-history").getByTestId("wave-group")).toHaveCount(2);
  },
);

Step(
  "the history lens shows a single wave {string} band holding both {string} and {string}",
  async ({ page }, wave: string, crA: string, crB: string) => {
    const band = waveGroup(page, wave);
    await expect(band).toBeVisible();
    await expect(crGroupIn(band, crA)).toBeVisible();
    await expect(crGroupIn(band, crB)).toBeVisible();
    // exactly one band now — the fold produced a single group, not two
    // bands that both happen to satisfy the individual visibility checks.
    await expect(page.getByTestId("workflow-history").getByTestId("wave-group")).toHaveCount(1);
  },
);

Step("the history lens shows no phantom unnumbered wave band", async ({ page }) => {
  await expect(waveGroup(page, "")).toHaveCount(0);
});
