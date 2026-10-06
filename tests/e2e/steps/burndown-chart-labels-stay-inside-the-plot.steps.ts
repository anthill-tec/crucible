// CR-CRU-160 §S3/AC4 — every label stays inside the plot, none overlap, the
// four projection labels always draw, the unlabelled-step count matches the
// "+ N more" note, and any step's full label shows on hover. Reuses
// seeding.steps.ts, roadmap.steps.ts's CR-queue registration,
// navigation.steps.ts, workflow.steps.ts, pane-scroll.steps.ts's "the
// viewport is {int}x{int}" and mobile-viewport.steps.ts's "I tap the
// roadmap release band"; burndown-chart-draws-projection-and-states-
// refusal.steps.ts already owns the kind/text/drawn half of the
// `[data-testid="burndown-chart-labels"]` contract this file assumes — see
// that file's header for the full contract text. This file adds and uses
// its position/hover half:
//
//   `[data-testid="burndown-chart"]` additionally carries
//   `data-plot-left`, `data-plot-top`, `data-plot-right`, `data-plot-bottom`
//   — the plot area's own box (CSS px, LOCAL to the canvas's own top-left
//   corner, devicePixelRatio already divided out — i.e. consistent with
//   `u.bbox` converted back to CSS px, never the raw device-pixel value the
//   draw hook already multiplies font sizes/offsets by by `px` for).
//
//   Each label item inside `[data-testid="burndown-chart-labels"]` that is
//   actually drawn (`data-label-drawn="true"`) additionally carries
//   `data-label-x`, `data-label-y`, `data-label-w`, `data-label-h` — the
//   exact box `drawLabel` placed it at (collision/containment already
//   computed by that function today for the `placed` array), in the SAME
//   local space as `data-plot-*` above, so containment/overlap are pure
//   arithmetic on these numbers — no pixel read, no DOM geometry call.
//
//   Every `data-label-kind="step"` item, drawn or not, is ALSO a real,
//   hoverable DOM element positioned over its step's own plotted point on
//   the canvas (small, invisible — e.g. `opacity:0` — but with real layout
//   geometry, so Playwright's `.hover()`/`.focus()` genuinely lands there).
//   Hovering OR focusing it shows `[data-testid="burndown-chart-tooltip"]`
//   (one reused tooltip element) with its text content set to that SAME
//   item's `data-label-text` — the step's FULL label, regardless of whether
//   the canvas painted its own copy this render.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import {
  mockManyStepsDatedForecast,
  type ProjectionLabelExpectations,
} from "./burndown-analytics-mock.ts";

Step(
  "the release's burndown and forecast are mocked with a 63-step history and a dated forecast",
  async ({ page, world }) => {
    const { labels, steps } = await mockManyStepsDatedForecast(page, world.projectKey as string);
    world.expectedBurndownLabels = labels;
    world.mockedStepCount = steps.length;
  },
);

interface PlotBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function plotBox(page: Page): Promise<PlotBox> {
  const chart = page.getByTestId("burndown-chart");
  const attrs = await chart.evaluate((el) => ({
    left: el.getAttribute("data-plot-left"),
    top: el.getAttribute("data-plot-top"),
    right: el.getAttribute("data-plot-right"),
    bottom: el.getAttribute("data-plot-bottom"),
  }));
  for (const [k, v] of Object.entries(attrs)) {
    expect(v, `the chart host carries no data-plot-${k} attribute`).not.toBeNull();
  }
  return {
    left: Number(attrs.left),
    top: Number(attrs.top),
    right: Number(attrs.right),
    bottom: Number(attrs.bottom),
  };
}

interface LabelBox {
  kind: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every DRAWN label's box (containment/overlap only ever apply to what was
 * actually painted — an undrawn "step" candidate has no box to check). */
async function drawnLabelBoxes(page: Page): Promise<LabelBox[]> {
  const list = page.locator('[data-testid="burndown-chart-labels"] [data-label-drawn="true"]');
  const count = await list.count();
  const boxes: LabelBox[] = [];
  for (let i = 0; i < count; i++) {
    const el = list.nth(i);
    const attrs = await el.evaluate((node) => ({
      kind: node.getAttribute("data-label-kind"),
      text: node.getAttribute("data-label-text"),
      x: node.getAttribute("data-label-x"),
      y: node.getAttribute("data-label-y"),
      w: node.getAttribute("data-label-w"),
      h: node.getAttribute("data-label-h"),
    }));
    boxes.push({
      kind: String(attrs.kind),
      text: String(attrs.text),
      x: Number(attrs.x),
      y: Number(attrs.y),
      w: Number(attrs.w),
      h: Number(attrs.h),
    });
  }
  return boxes;
}

Step("every label the burndown chart drew sits inside the plot area", async ({ page }) => {
  const plot = await plotBox(page);
  const boxes = await drawnLabelBoxes(page);
  expect(boxes.length, "no label was drawn at all — nothing to check containment against").toBeGreaterThan(0);
  for (const box of boxes) {
    expect(
      box.x,
      `"${box.text}" (${box.kind}) starts at x=${box.x}, left of the plot's left edge ${plot.left}`,
    ).toBeGreaterThanOrEqual(plot.left);
    expect(
      box.y,
      `"${box.text}" (${box.kind}) starts at y=${box.y}, above the plot's top edge ${plot.top}`,
    ).toBeGreaterThanOrEqual(plot.top);
    expect(
      box.x + box.w,
      `"${box.text}" (${box.kind}) ends at x=${box.x + box.w}, right of the plot's right edge ${plot.right}`,
    ).toBeLessThanOrEqual(plot.right);
    expect(
      box.y + box.h,
      `"${box.text}" (${box.kind}) ends at y=${box.y + box.h}, BELOW the plot's bottom edge ${plot.bottom} — ` +
        "exactly the defect this CR fixes (labels spilling past the plot)",
    ).toBeLessThanOrEqual(plot.bottom);
  }
});

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

Step("no two labels the burndown chart drew overlap", async ({ page }) => {
  const boxes = await drawnLabelBoxes(page);
  expect(boxes.length, "no label was drawn at all — nothing to check overlap against").toBeGreaterThan(0);
  const offenders: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i] as LabelBox, boxes[j] as LabelBox)) {
        offenders.push(`"${(boxes[i] as LabelBox).text}" overlaps "${(boxes[j] as LabelBox).text}"`);
      }
    }
  }
  expect(offenders, `overlapping drawn labels:\n${offenders.join("\n")}`).toEqual([]);
});

Step("the number of unlabelled steps equals the burndown chart's \"+ N more\" note", async ({ page, world }) => {
  const expectedStepCount = world.mockedStepCount as number;
  expect(typeof expectedStepCount, "no 63-step fixture was mocked before this step").toBe("number");

  const stepItems = page.locator('[data-testid="burndown-chart-labels"] [data-label-kind="step"]');
  await expect(stepItems).toHaveCount(expectedStepCount);

  const undrawn = page.locator(
    '[data-testid="burndown-chart-labels"] [data-label-kind="step"][data-label-drawn="false"]',
  );
  const undrawnCount = await undrawn.count();

  const more = page.locator('[data-testid="burndown-chart-labels"] [data-label-kind="more"]').first();
  await expect(more, 'no "+ N more" note was drawn despite unlabelled steps').toHaveAttribute(
    "data-label-drawn",
    "true",
  );
  const moreText = (await more.getAttribute("data-label-text")) ?? "";
  const match = /\+\s*(\d+)\s*more/i.exec(moreText);
  expect(match, `the "+ N more" note's text ("${moreText}") carries no parseable "+ N more" count`).not.toBeNull();
  const notedCount = Number((match as RegExpExecArray)[1]);

  expect(
    undrawnCount,
    `${undrawnCount} steps got no label of their own, but the "+ N more" note says ${notedCount}`,
  ).toBe(notedCount);
  expect(undrawnCount, "every one of the 63 steps was drawn its own label — nothing exercises the \"+ N more\" note").toBeGreaterThan(0);
});

Step("resting the pointer on an unlabelled step shows its full label", async ({ page }) => {
  const undrawn = page.locator(
    '[data-testid="burndown-chart-labels"] [data-label-kind="step"][data-label-drawn="false"]',
  );
  const target = undrawn.first();
  await expect(target, "no unlabelled step is present to hover").toHaveCount(1);
  const fullText = await target.getAttribute("data-label-text");
  expect(fullText, "the unlabelled step carries no data-label-text to show on hover").not.toBeNull();

  await (target as Locator).hover();
  const tooltip = page.getByTestId("burndown-chart-tooltip");
  await expect(tooltip, "no tooltip appeared when the pointer rested on an unlabelled step").toBeVisible();
  await expect(tooltip).toHaveText(fullText as string);
});

// Re-asserted here (not only in the sibling feature) because THIS fixture is
// the high-collision one AC4 is really about: the four projection labels
// must survive 63 competing step candidates, never themselves fall victim
// to the same collision logic that skips steps into "+ N more".
Step("the burndown chart draws the expected today, P50, P80 and target labels despite 63 competing step candidates", async ({ page, world }) => {
  const expected = world.expectedBurndownLabels as ProjectionLabelExpectations;
  expect(typeof expected, "no dated-forecast fixture was mocked before this step").toBe("object");
  for (const [kind, text] of [
    ["today", expected.today],
    ["p50", expected.p50],
    ["p80", expected.p80],
    ["target", expected.target],
  ] as const) {
    const item = page
      .locator(`[data-testid="burndown-chart-labels"] [data-label-kind="${kind}"]`)
      .first();
    await expect(item, `no "${kind}" label was drawn despite 63 competing step candidates`).toHaveAttribute(
      "data-label-drawn",
      "true",
    );
    await expect(item, `the "${kind}" label's text did not match the fixture`).toHaveAttribute(
      "data-label-text",
      text,
    );
  }
});
