// CR-CRU-176 §S2/AC2 — workflow-cycle-change-record-layout.feature steps:
// F23's real-browser pin (label width unshrunk, the record's box below the
// cycle line's box, the record wrapping rather than truncating). Reuses
// seeding.steps.ts (project), navigation.steps.ts ("I open the workspace
// for that project"), workflow.steps.ts ("I click the {string} workspace
// tab", "a cycle plan is filed for cr {string} with a cycle labelled
// {string}"), roadmap-graph.steps.ts ("an orchestrator {string} is
// registered on that project") and pane-scroll.steps.ts ("the viewport is
// {int}x{int}") wherever they already say exactly what's needed — only the
// cycle-add-with-record step and the width/position/wrap assertions below
// are new here.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { appendCycle } from "./harness.ts";

// CR-CRU-165 §S1's cycle-add verb, through the harness: appends a NON-FIX
// cycle to the already-filed open plan, carrying its recorded-change fields
// (`appendCycle`, harness.ts). The caller must already be an orchestrator —
// roadmap-graph.steps.ts's "an orchestrator {string} is registered on that
// project" step, run earlier in the scenario, is what makes
// `world.orchestratorId` usable here.
Step(
  "a cycle labelled {string} is added to that plan with reason {string} cause {string} and spec-ref {string}",
  async (
    { request, world },
    label: string,
    reason: string,
    cause: string,
    specRef: string,
  ) => {
    const result = await appendCycle(
      request,
      world.projectKey as string,
      world.planId as number,
      world.orchestratorId as string,
      { label, reason, cause: cause as "spec-design" | "gap-analysis", specRef },
    );
    world.changedCycleId = result.id;
  },
);

// §S2 — the ACTIVE `cycle-row` OR the HISTORY `lens-cycle-row` for a
// cycleId (mirrors app.js's own `revealCycleRow` selector and
// cycle-run-navigation.steps.ts's `historyCycleRow`).
function cycleRow(page: Page, cycleId: number): Locator {
  return page.locator(
    `[data-testid="cycle-row"][data-cycle-id="${cycleId}"], ` +
      `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
  );
}

function cycleLine(page: Page, cycleId: number): Locator {
  return cycleRow(page, cycleId).locator(".app-cycle-line");
}

// The ACTIVE row's whole label+badge node (`CycleRow`'s `.app-cycle-text` —
// there is no separate label-only node there, unlike History's
// `.app-cycle-label`). Both cycles in this feature's scenarios render the
// SAME label text at the SAME ordinal digit count (1 and 2 — a monospace
// font makes that single-digit swap pixel-identical), so comparing this
// node's own rendered width isolates whether the record crowds it.
function cycleText(page: Page, cycleId: number): Locator {
  return cycleLine(page, cycleId).locator(".app-cycle-text");
}

Step(
  "the changed cycle's label renders at the same width as the baseline cycle's label",
  async ({ page, world }) => {
    const baseline = cycleText(page, world.cycleId as number);
    const changed = cycleText(page, world.changedCycleId as number);
    await expect(baseline).toBeVisible();
    await expect(changed).toBeVisible();
    const baselineBox = await baseline.boundingBox();
    const changedBox = await changed.boundingBox();
    if (!baselineBox || !changedBox) {
      throw new Error("the baseline/changed cycle label bounding box is unavailable");
    }
    expect(baselineBox.width).toBeGreaterThan(0);
    // Not an exact-pixel pin (sub-pixel layout rounding is real): a label
    // the record has crowded into an ellipsis loses tens of pixels, not a
    // rounding error, so a generous 2px tolerance still catches the defect.
    expect(Math.abs(changedBox.width - baselineBox.width)).toBeLessThanOrEqual(2);
  },
);

Step(
  "the changed cycle's change-record box sits below its cycle line's box",
  async ({ page, world }) => {
    const cycleId = world.changedCycleId as number;
    const line = cycleLine(page, cycleId);
    const record = cycleRow(page, cycleId).getByTestId("cycle-change-record");
    await expect(line).toBeVisible();
    await expect(record).toBeVisible();
    const lineBox = await line.boundingBox();
    const recordBox = await record.boundingBox();
    if (!lineBox || !recordBox) {
      throw new Error("the cycle line/change-record bounding box is unavailable");
    }
    // "beneath" — the record's box starts at or after the line's own
    // bottom edge, never overlapping it (a record still sharing the
    // line's own row, as today, reports the SAME top as the line).
    expect(recordBox.y).toBeGreaterThanOrEqual(lineBox.y + lineBox.height - 1);
  },
);

Step(
  "the changed cycle's change-record wraps onto more than one line",
  async ({ page, world }) => {
    const cycleId = world.changedCycleId as number;
    const record = cycleRow(page, cycleId).getByTestId("cycle-change-record");
    await expect(record).toBeVisible();
    const metrics = await record.evaluate((el) => {
      const style = getComputedStyle(el);
      const parsedLineHeight = parseFloat(style.lineHeight);
      const lineHeight = Number.isNaN(parsedLineHeight)
        ? parseFloat(style.fontSize) * 1.2
        : parsedLineHeight;
      return { lineHeight, height: el.getBoundingClientRect().height };
    });
    expect(metrics.lineHeight).toBeGreaterThan(0);
    // A truncated/unwrapped single line measures ~1 line-height tall; a
    // wrapped record measures at least two — 1.5x is past the single-line
    // ceiling but short of demanding an exact line count.
    expect(metrics.height).toBeGreaterThan(metrics.lineHeight * 1.5);
  },
);
