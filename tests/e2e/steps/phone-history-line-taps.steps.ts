// Phone band — a history cycle line keeps every one of its taps. The line
// carries no `→ Runs` pill here (it would steal a nearby tap on WebKit, which
// moves a tap's click onto a clickable node close to the finger), so every
// point of the line — each empty gap between its children, its label, its
// timer — is the line's own toggle. The `→ Runs` affordance instead ends the
// expanded runs as a full-width row of its own, which navigates to the Runs
// tab. Collected by mobile-viewport-responsive.feature, so these steps run
// under every phone project (chromium-mobile, webkit-iphone) with a real
// touch tap.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";

function historyCycleRow(page: Page, cycleId: number): Locator {
  return page
    .getByTestId("workflow-history")
    .locator(`[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`);
}

function historyCycleLine(page: Page, cycleId: number): Locator {
  return historyCycleRow(page, cycleId).locator(".app-cycle-line");
}

function expandedRuns(page: Page, cycleId: number): Locator {
  return historyCycleRow(page, cycleId).getByTestId("cycle-span-closed");
}

function workspaceTab(page: Page, label: string): Locator {
  return page.getByTestId("workspace-tab").filter({ hasText: label });
}

// One horizontal run of the line's own box that no child of the line covers,
// named by the children on either side of it (or the line's own edge).
interface LineGap {
  leftKey: string;
  rightKey: string;
  start: number;
  end: number;
  x: number;
  y: number;
}

interface TapPoint {
  name: string;
  x: number;
  y: number;
}

// Every horizontal gap wider than 0 px in the line that no child covers —
// the leading edge, every inter-child gap and the trailing edge — each with
// its midpoint at the line's vertical centre (viewport coordinates, as
// `elementFromPoint` and `page.touchscreen` take them). A child is named by
// its `data-testid`, else its most specific (last) class.
async function measureLineGaps(page: Page, cycleId: number): Promise<LineGap[]> {
  const line = historyCycleLine(page, cycleId);
  await expect(line).toBeVisible();
  return line.evaluate((el) => {
    const childKey = (c: Element): string =>
      c.getAttribute("data-testid") ??
      c.classList[c.classList.length - 1] ??
      c.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const children = Array.from(el.children)
      .map((c) => ({ key: childKey(c), r: c.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 || r.height > 0)
      .sort((a, b) => a.r.left - b.r.left);
    const gaps: Array<{ leftKey: string; rightKey: string; start: number; end: number; x: number; y: number }> = [];
    let occupiedUpTo = rect.left;
    let leftKey = "line start";
    for (const { key, r } of children) {
      if (r.left - occupiedUpTo > 0) {
        gaps.push({
          leftKey,
          rightKey: key,
          start: occupiedUpTo,
          end: r.left,
          x: (occupiedUpTo + r.left) / 2,
          y,
        });
      }
      if (r.right > occupiedUpTo) {
        occupiedUpTo = r.right;
        leftKey = key;
      }
    }
    if (rect.right - occupiedUpTo > 0) {
      gaps.push({
        leftKey,
        rightKey: "line end",
        start: occupiedUpTo,
        end: rect.right,
        x: (occupiedUpTo + rect.right) / 2,
        y,
      });
    }
    return gaps;
  });
}

function gapName(gap: LineGap): string {
  return `the gap between ${gap.leftKey} and ${gap.rightKey}`;
}

// The same gap after the line has changed (the `▸ N runs` hint leaves an open
// line): the gap with the same neighbours; else the one that still starts at
// the same left neighbour; else the one that still ends at the same right
// neighbour; else — the gap closed when its neighbour left — the re-measured
// gap nearest the original midpoint.
async function remeasureGap(page: Page, cycleId: number, original: LineGap): Promise<LineGap> {
  const gaps = await measureLineGaps(page, cycleId);
  expect(gaps.length, `re-measuring ${gapName(original)}: the line must still have a gap`).toBeGreaterThan(0);
  const same =
    gaps.find((g) => g.leftKey === original.leftKey && g.rightKey === original.rightKey) ??
    gaps.find((g) => g.leftKey === original.leftKey) ??
    gaps.find((g) => g.rightKey === original.rightKey);
  if (same) return same;
  return gaps.reduce((best, g) =>
    Math.abs(g.x - original.x) < Math.abs(best.x - original.x) ? g : best,
  );
}

// The centre of the line's child that `selector` names, at its own box.
async function childCentre(page: Page, cycleId: number, selector: string): Promise<{ x: number; y: number }> {
  const child = historyCycleLine(page, cycleId).locator(selector);
  await expect(child, `the line's ${selector} must render`).toBeVisible();
  const box = await child.boundingBox();
  if (!box) throw new Error(`the line's ${selector} has no bounding box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// `elementFromPoint` proof before a tap: the point lands on the line ITSELF
// (outside every child) for a gap, or inside the named child for the label
// and the timer — so a mis-aimed tap can never pass vacuously.
async function expectPointLandsOn(
  page: Page,
  cycleId: number,
  point: TapPoint,
  childSelector: string | null,
): Promise<void> {
  const landed = await historyCycleLine(page, cycleId).evaluate(
    (lineEl, args: { x: number; y: number; childSelector: string | null }) => {
      const target = document.elementFromPoint(args.x, args.y);
      if (target === null) return "nothing";
      if (args.childSelector === null) return target === lineEl ? "line" : "elsewhere";
      const child = lineEl.querySelector(args.childSelector);
      return child !== null && (target === child || child.contains(target)) ? "child" : "elsewhere";
    },
    { x: point.x, y: point.y, childSelector },
  );
  expect(
    landed,
    `${point.name}: point (${point.x}, ${point.y}) must land on ${
      childSelector === null ? "the line itself, outside every child" : `the line's ${childSelector}`
    }`,
  ).toBe(childSelector === null ? "line" : "child");
}

async function expectRunsOpenOnWorkflow(page: Page, cycleId: number, what: string): Promise<void> {
  const runs = expandedRuns(page, cycleId);
  await expect(runs, `${what} must show the expanded runs`).toBeVisible();
  await expect(
    runs.getByTestId("linked-run-row"),
    `${what}: the expanded runs must show exactly the two linked runs`,
  ).toHaveCount(2);
  await expect(
    runs.getByTestId("cycle-to-runs-row"),
    `${what}: the expanded runs must end with exactly one → Runs row`,
  ).toHaveCount(1);
  await expect(workspaceTab(page, "Workflow"), `${what} must stay on Workflow`).toHaveClass(/\bon\b/);
  await expect(workspaceTab(page, "Runs"), `${what} must not open the Runs tab`).not.toHaveClass(/\bon\b/);
}

async function expectRunsClosed(page: Page, cycleId: number, what: string): Promise<void> {
  await expect(expandedRuns(page, cycleId), `${what} must hide the expanded runs`).toHaveCount(0);
  await expect(
    historyCycleRow(page, cycleId).getByTestId("cycle-to-runs-row"),
    `${what}: no → Runs row may remain once the runs are hidden`,
  ).toHaveCount(0);
  await expect(workspaceTab(page, "Workflow"), `${what} must stay on Workflow`).toHaveClass(/\bon\b/);
}

async function expectNoRunsPillOnLine(page: Page, cycleId: number, when: string): Promise<void> {
  const line = historyCycleLine(page, cycleId);
  await expect(line.getByTestId("cycle-to-runs"), `${when}: the line must carry no → Runs pill`).toHaveCount(0);
  await expect(line, `${when}: the line must not read → Runs`).not.toContainText("→ Runs");
}

Step(
  "the history cycle line for that cycle wraps its label onto more than one line",
  async ({ page, world }) => {
    const cycleId = world.cycleId as number;
    const line = historyCycleLine(page, cycleId);
    await line.scrollIntoViewIfNeeded();
    const label = line.locator(".app-cycle-label");
    await expect(label).toBeVisible();
    const lineCount = await label.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set(
        Array.from(range.getClientRects())
          .filter((r) => r.width > 0)
          .map((r) => Math.round(r.top)),
      );
      return tops.size;
    });
    expect(
      lineCount,
      "the label must wrap under the phone width — this scenario proves nothing about a wrapped line otherwise",
    ).toBeGreaterThanOrEqual(2);
  },
);

Step(
  "the closed history cycle line for that cycle shows no → Runs",
  async ({ page, world }) => {
    const cycleId = world.cycleId as number;
    await expectRunsClosed(page, cycleId, "the closed line");
    await expectNoRunsPillOnLine(page, cycleId, "the closed line");
  },
);

Step(
  "tapping the history cycle line for that cycle in each of its gaps, on its label and on its timer opens its runs on Workflow and a second tap closes them",
  async ({ page, world }) => {
    const cycleId = world.cycleId as number;
    await historyCycleLine(page, cycleId).scrollIntoViewIfNeeded();
    await expectRunsClosed(page, cycleId, "before any tap");

    const gaps = await measureLineGaps(page, cycleId);
    expect(gaps.length, "the closed line must have at least one gap wider than 0 px").toBeGreaterThan(0);
    expect(
      gaps.some((g) => g.leftKey === "cycle-timer" && g.rightKey === "app-run-count-hint"),
      `the gaps must include the one between the timer and the ▸ N runs hint; measured: ${gaps
        .map(gapName)
        .join(", ")}`,
    ).toBe(true);

    for (const gap of gaps) {
      // Re-measured each round: a prior open/close may have re-laid the line.
      const opening = (await measureLineGaps(page, cycleId)).find(
        (g) => g.leftKey === gap.leftKey && g.rightKey === gap.rightKey,
      );
      expect(opening, `${gapName(gap)} must still be on the closed line`).toBeDefined();
      const openPoint: TapPoint = { name: gapName(gap), x: opening!.x, y: opening!.y };
      await expectPointLandsOn(page, cycleId, openPoint, null);
      await page.touchscreen.tap(openPoint.x, openPoint.y);
      await expectRunsOpenOnWorkflow(page, cycleId, `a tap in ${openPoint.name}`);
      await expectNoRunsPillOnLine(page, cycleId, `the open line after a tap in ${openPoint.name}`);

      const closing = await remeasureGap(page, cycleId, opening!);
      const closePoint: TapPoint = {
        name: `${gapName(closing)} (re-measured from ${openPoint.name})`,
        x: closing.x,
        y: closing.y,
      };
      await expectPointLandsOn(page, cycleId, closePoint, null);
      await page.touchscreen.tap(closePoint.x, closePoint.y);
      await expectRunsClosed(page, cycleId, `a second tap in ${closePoint.name}`);
    }

    for (const [name, selector] of [
      ["the label", ".app-cycle-label"],
      ["the timer", '[data-testid="cycle-timer"]'],
    ] as const) {
      const open = await childCentre(page, cycleId, selector);
      const openPoint: TapPoint = { name: `a tap on ${name}`, ...open };
      await expectPointLandsOn(page, cycleId, openPoint, selector);
      await page.touchscreen.tap(openPoint.x, openPoint.y);
      await expectRunsOpenOnWorkflow(page, cycleId, openPoint.name);

      const close = await childCentre(page, cycleId, selector);
      const closePoint: TapPoint = { name: `a second tap on ${name}`, ...close };
      await expectPointLandsOn(page, cycleId, closePoint, selector);
      await page.touchscreen.tap(closePoint.x, closePoint.y);
      await expectRunsClosed(page, cycleId, closePoint.name);
    }
  },
);

Step("I tap the label of the history cycle line for that cycle", async ({ page, world }) => {
  const cycleId = world.cycleId as number;
  await historyCycleLine(page, cycleId).scrollIntoViewIfNeeded();
  const point = await childCentre(page, cycleId, ".app-cycle-label");
  await expectPointLandsOn(page, cycleId, { name: "a tap on the label", ...point }, ".app-cycle-label");
  await page.touchscreen.tap(point.x, point.y);
});

Step("the expanded runs for that cycle end with the → Runs row", async ({ page, world }) => {
  const cycleId = world.cycleId as number;
  await expectRunsOpenOnWorkflow(page, cycleId, "the tap on the label");
  const lastChild = await expandedRuns(page, cycleId).evaluate(
    (el) => el.lastElementChild?.getAttribute("data-testid") ?? null,
  );
  expect(lastChild, "the → Runs row must be the expanded runs' last row").toBe("cycle-to-runs-row");
  await expect(expandedRuns(page, cycleId).getByTestId("cycle-to-runs-row")).toContainText("→ Runs");
  await expectNoRunsPillOnLine(page, cycleId, "the open line");
});

Step(
  "the → Runs row for that cycle measures at least 44px tall and the expanded runs' full width",
  async ({ page, world }) => {
    const cycleId = world.cycleId as number;
    const runs = expandedRuns(page, cycleId);
    const row = runs.getByTestId("cycle-to-runs-row");
    await expect(row).toBeVisible();
    const measured = await runs.evaluate((el) => {
      const rowEl = el.querySelector('[data-testid="cycle-to-runs-row"]');
      if (rowEl === null) return null;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const contentLeft = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const contentRight = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
      const r = rowEl.getBoundingClientRect();
      return { height: r.height, left: r.left, right: r.right, contentLeft, contentRight };
    });
    if (measured === null) throw new Error("the → Runs row is not inside the expanded runs");
    expect(measured.height, "the → Runs row must be at least 44px tall").toBeGreaterThanOrEqual(44);
    expect(
      Math.abs(measured.left - measured.contentLeft),
      `the → Runs row must start at the expanded runs' left edge (${measured.left} vs ${measured.contentLeft})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(measured.right - measured.contentRight),
      `the → Runs row must reach the expanded runs' right edge (${measured.right} vs ${measured.contentRight})`,
    ).toBeLessThanOrEqual(1);
    expect(measured.contentRight - measured.contentLeft).toBeGreaterThan(0);
  },
);

Step("I tap the → Runs row for that cycle", async ({ page, world }) => {
  const row = expandedRuns(page, world.cycleId as number).getByTestId("cycle-to-runs-row");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-disabled", "false");
  // A tap only reaches what is on screen: the row may sit below the fold.
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport({ ratio: 1 });
  const box = await row.boundingBox();
  if (!box) throw new Error("the → Runs row has no bounding box");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const landsOnRow = await row.evaluate(
    (rowEl, p: { x: number; y: number }) => {
      const target = document.elementFromPoint(p.x, p.y);
      return target !== null && (target === rowEl || rowEl.contains(target));
    },
    point,
  );
  expect(landsOnRow, `the tap point (${point.x}, ${point.y}) must land on the row`).toBe(true);
  await page.touchscreen.tap(point.x, point.y);
});

Step(
  "the declared marker for that cycle sits inside the viewport and blinks",
  async ({ page, world }) => {
    const marker = page
      .getByTestId("workspace-runs")
      .locator(`[data-testid="declared-marker"][data-cycle-id="${world.cycleId as number}"]`);
    await expect(marker).toHaveCount(1);
    await expect(marker).toBeInViewport();
    await expect(marker).toHaveClass(/app-locate-blink/);
  },
);
