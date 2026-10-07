// CR-CRU-160 §S2 — the burndown's F16 projection (today/P50/P80/target) and
// its refusal statement, as drawn by `burndownOptions`'s draw hook
// (public/app.js). Reuses seeding.steps.ts, roadmap.steps.ts's CR-queue
// registration, navigation.steps.ts, workflow.steps.ts, pane-scroll.steps.ts's
// "the viewport is {int}x{int}" and mobile-viewport.steps.ts's "I tap the
// roadmap release band" to reach the Analytics pane — only the mock-wiring
// and label-contract assertions below are new.
//
// THE OBSERVABLE CONTRACT THIS FILE REQUIRES GREEN TO EXPOSE (a canvas draws
// no DOM a test can read without asserting on pixels, which is forbidden):
//
//   `[data-testid="burndown-chart"]` (the existing host) carries
//   `data-burndown-forecast="dated"|"refused"`, reflecting `forecastDated(fc)`
//   for the render that produced the labels list below.
//
//   A sibling of the canvas, `[data-testid="burndown-chart-labels"]`,
//   rebuilt on every draw, holds one element per nameable thing the draw
//   hook decided about, each carrying:
//     - `data-label-kind`: "today" | "p50" | "p80" | "target" | "step" |
//        "more" | "refusal"
//     - `data-label-text`: the exact text (for "step", ALWAYS the step's
//        full label, `${sign}${points} · ${cr} ${event}`, regardless of
//        whether its own text was placed on the canvas this render)
//     - `data-label-drawn`: "true" when the canvas painted this label's own
//        text this render (today/p50/p80/target/more/refusal are "true"
//        whenever the item exists at all — §S3 says they are ALWAYS shown;
//        "step" is "true" only when not collision-skipped)
//
// AC4's plot-box/overlap/hover assertions (burndown-chart-labels-stay-
// inside-the-plot.steps.ts) add the position/hover half of this same
// contract; this file only needs the kind/text/drawn half.
import { expect, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import {
  mockDatedForecast,
  mockRefusedInsufficientHistory,
  mockRefusedUnpointed,
  type ProjectionLabelExpectations,
  type BurndownTraceExpectation,
  type RefusalExpectation,
} from "./burndown-analytics-mock.ts";

Step(
  "the release's burndown and forecast are mocked with a dated forecast",
  async ({ page, world }) => {
    const fixture = await mockDatedForecast(page, world.projectKey as string);
    world.expectedBurndownLabels = fixture;
    world.expectedBurndownTrace = fixture.trace;
  },
);

Step(
  "the release's burndown and forecast are mocked with a forecast refused for insufficient history",
  async ({ page, world }) => {
    world.expectedRefusal = await mockRefusedInsufficientHistory(page, world.projectKey as string);
  },
);

Step(
  "the release's burndown and forecast are mocked with a forecast refused for unpointed CRs",
  async ({ page, world }) => {
    world.expectedRefusal = await mockRefusedUnpointed(page, world.projectKey as string);
  },
);

Step("the burndown chart states its forecast as {string}", async ({ page }, state: string) => {
  const chart = page.getByTestId("burndown-chart");
  await expect(chart).toHaveAttribute("data-burndown-forecast", state);
});

function labelItems(page: import("@playwright/test").Page, kind: string) {
  return page.locator(
    `[data-testid="burndown-chart-labels"] [data-label-kind="${kind}"]`,
  );
}

Step("the burndown chart draws the expected today, P50, P80 and target labels", async ({ page, world }) => {
  const expected = world.expectedBurndownLabels as ProjectionLabelExpectations;
  expect(typeof expected, "no dated-forecast fixture was mocked before this step").toBe("object");
  for (const [kind, text] of [
    ["today", expected.today],
    ["p50", expected.p50],
    ["p80", expected.p80],
    ["target", expected.target],
  ] as const) {
    const item = labelItems(page, kind).first();
    await expect(item, `no "${kind}" label was drawn`).toHaveAttribute("data-label-drawn", "true");
    await expect(
      item,
      `the "${kind}" label's text did not match the fixture's dated forecast`,
    ).toHaveAttribute("data-label-text", text);
  }
});

Step("the burndown chart shows the P50 and P80 band", async ({ page }) => {
  await expect(page.getByTestId("burndown-chart")).toHaveAttribute("data-burndown-band", "shown");
});

Step("the burndown chart hides the P50 and P80 band", async ({ page }) => {
  await expect(page.getByTestId("burndown-chart")).toHaveAttribute("data-burndown-band", "hidden");
});

Step("the burndown chart draws no P50 or P80 label", async ({ page }) => {
  await expect(labelItems(page, "p50")).toHaveCount(0);
  await expect(labelItems(page, "p80")).toHaveCount(0);
});

// CR-CRU-161 §S4/AC4 — what uPlot actually DREW for each trace, read from
// the chart host's own `data-p50-line`/`data-p80-line` (CSS-px `x,y` vertex
// pairs, space-separated, drawing order — the SAME local space as the
// existing `data-actual-line`, CR-CRU-160's pattern this CR extends). A test
// cannot re-derive uPlot's internal scale/padding math, so it instead
// interpolates linearly between two points uPlot ALREADY placed on the same
// shared x (time) scale — the drawn actual line's first and last (today)
// vertices — using the real timestamps `mockDatedForecast` now also returns.
interface Vertex {
  x: number;
  y: number;
}

function parseVertices(raw: string): Vertex[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x: x as number, y: y as number };
    });
}

async function actualLineVertices(page: Page): Promise<Vertex[]> {
  const raw = await page.getByTestId("burndown-chart").getAttribute("data-actual-line");
  expect(raw, "the chart host carries no data-actual-line attribute").not.toBeNull();
  const vertices = parseVertices(raw as string);
  expect(vertices.length, "the drawn actual line has fewer than two vertices").toBeGreaterThan(1);
  return vertices;
}

async function plotBottom(page: Page): Promise<number> {
  const raw = await page.getByTestId("burndown-chart").getAttribute("data-plot-bottom");
  expect(raw, "the chart host carries no data-plot-bottom attribute").not.toBeNull();
  return Number(raw);
}

/** A trace's drawn vertices from `data-{kind}-line` — null when the
 *  attribute is absent entirely (a refused forecast must draw no trace at
 *  all, never an empty-but-present attribute). */
async function traceLine(page: Page, kind: "p50" | "p80"): Promise<Vertex[] | null> {
  const raw = await page.getByTestId("burndown-chart").getAttribute(`data-${kind}-line`);
  if (raw === null) return null;
  const vertices = parseVertices(raw);
  for (const v of vertices) {
    expect(
      Number.isFinite(v.x) && Number.isFinite(v.y),
      `data-${kind}-line holds a non-numeric vertex ("${raw}")`,
    ).toBe(true);
  }
  return vertices;
}

/** The expected CSS-px x for an arbitrary date, derived by linear
 *  interpolation between two REAL points already drawn on the same shared
 *  x (time) scale — never by replicating uPlot's own padding/scale math. */
function expectedXAt(line: Vertex[], fromTs: number, toTs: number, targetTs: number): number {
  const from = line[0] as Vertex;
  const to = line[line.length - 1] as Vertex;
  const rate = (to.x - from.x) / (toTs - fromTs);
  return from.x + rate * (targetTs - fromTs);
}

const TRACE_PX_TOLERANCE = 2;

Step(
  "the burndown chart draws the P50 and P80 traces from today to their own zero dates",
  async ({ page, world }) => {
    const trace = world.expectedBurndownTrace as BurndownTraceExpectation | undefined;
    expect(typeof trace, "no dated-forecast fixture was mocked before this step").toBe("object");
    const t = trace as BurndownTraceExpectation;

    const actual = await actualLineVertices(page);
    const today = actual[actual.length - 1] as Vertex;
    const zeroY = await plotBottom(page);

    for (const [kind, dateTs] of [
      ["p50", t.p50Ts],
      ["p80", t.p80Ts],
    ] as const) {
      const line = await traceLine(page, kind);
      expect(line, `no data-${kind}-line attribute was drawn for the dated forecast`).not.toBeNull();
      const vertices = line as Vertex[];
      expect(vertices.length, `the drawn ${kind} trace has fewer than two vertices`).toBeGreaterThan(1);
      const start = vertices[0] as Vertex;
      const end = vertices[vertices.length - 1] as Vertex;
      expect(
        Math.abs(start.x - today.x),
        `the ${kind} trace starts at x=${start.x}, not at today's marker x=${today.x}`,
      ).toBeLessThanOrEqual(TRACE_PX_TOLERANCE);
      expect(
        Math.abs(start.y - today.y),
        `the ${kind} trace starts at y=${start.y}, not at today's marker y=${today.y}`,
      ).toBeLessThanOrEqual(TRACE_PX_TOLERANCE);
      const expectedEndX = expectedXAt(actual, t.firstPointTs, t.todayTs, dateTs);
      expect(
        Math.abs(end.x - expectedEndX),
        `the ${kind} trace ends at x=${end.x}, not at its own date's x=${expectedEndX.toFixed(1)}`,
      ).toBeLessThanOrEqual(TRACE_PX_TOLERANCE);
      expect(
        Math.abs(end.y - zeroY),
        `the ${kind} trace ends at y=${end.y}, not on the zero line y=${zeroY}`,
      ).toBeLessThanOrEqual(TRACE_PX_TOLERANCE);
    }
  },
);

Step("the P50 and P80 traces end at different dates", async ({ page }) => {
  const p50 = await traceLine(page, "p50");
  const p80 = await traceLine(page, "p80");
  expect(p50, "no data-p50-line attribute was drawn").not.toBeNull();
  expect(p80, "no data-p80-line attribute was drawn").not.toBeNull();
  const p50End = (p50 as Vertex[])[(p50 as Vertex[]).length - 1] as Vertex;
  const p80End = (p80 as Vertex[])[(p80 as Vertex[]).length - 1] as Vertex;
  expect(
    Math.abs(p50End.x - p80End.x),
    `P50 ends at x=${p50End.x} and P80 ends at x=${p80End.x} — the same date, not different ones`,
  ).toBeGreaterThan(TRACE_PX_TOLERANCE);
});

Step("the burndown chart draws no P50 or P80 trace", async ({ page }) => {
  const chart = page.getByTestId("burndown-chart");
  const p50 = await chart.getAttribute("data-p50-line");
  const p80 = await chart.getAttribute("data-p80-line");
  expect(p50, `the chart host carries data-p50-line ("${p50}") despite a refused forecast`).toBeNull();
  expect(p80, `the chart host carries data-p80-line ("${p80}") despite a refused forecast`).toBeNull();
});

// A no-op "refused" stub that always prints the SAME static sentence for
// EVERY refusal kind would still pass a bare "a refusal label exists" check
// — so this asserts the label actually reflects what the mocked forecast
// answered: the real sample-week figures for `insufficient_history`, every
// real unpointed CR name for `unpointed` (see burndown-analytics-mock.ts's
// `mustContain`).
Step("the burndown chart draws a refusal label naming the real refusal it was answered", async ({ page, world }) => {
  const expected = world.expectedRefusal as RefusalExpectation;
  expect(typeof expected, "no refused-forecast fixture was mocked before this step").toBe("object");
  const item = labelItems(page, "refusal").first();
  await expect(item, "no refusal label was drawn inside the plot").toHaveAttribute("data-label-drawn", "true");
  const text = await item.getAttribute("data-label-text");
  expect(text, "the refusal label carries no data-label-text").not.toBeNull();
  for (const fragment of expected.mustContain) {
    expect(
      text,
      `the refusal label ("${String(text)}") does not mention "${fragment}" — it reads like a generic ` +
        "placeholder rather than the real answered refusal",
    ).toContain(fragment);
  }
});
