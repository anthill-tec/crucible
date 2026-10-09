// CR-CRU-025 C4 — cycle-run-navigation.feature steps: §S1 (cycle row → Runs
// boundary), §S2 (the inverse `⚑ Cycle` badge, with auto-expand of a
// collapsed History CR group), and §S2b (the Run Timeline accordion).
// Reuses seeding.steps.ts / workflow.steps.ts / navigation.steps.ts /
// drillin.steps.ts / cards.steps.ts wherever they already say exactly what's
// needed (project/plan/run seeding, tab clicks, "{string} tab is selected",
// event-card visibility) — only the navigation-badge/blink/accordion
// assertions are new here.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { closePlan, filePlan, ingestParsed, transitionCycle } from "./harness.ts";

function crGroup(page: Page, cr: string): Locator {
  return page
    .getByTestId("workflow-history")
    .locator(`[data-testid="cr-group"][data-cr="${cr}"]`);
}

function declaredMarker(page: Page, cycleId: number): Locator {
  return page
    .getByTestId("workspace-runs")
    .locator(`[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`);
}

// §S2 — the ACTIVE `cycle-row` OR the HISTORY `lens-cycle-row` for a
// cycleId (mirrors app.js's own `revealCycleRow` selector).
function historyCycleRow(page: Page, cycleId: number): Locator {
  return page.locator(
    `[data-testid="cycle-row"][data-cycle-id="${cycleId}"], ` +
      `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
  );
}

// CR-CRU-146 §S2 — the row's `.app-cycle-line`, in EITHER section, for a
// cycleId. Reuses `historyCycleRow`'s union selector so the same helper
// resolves whichever of the two mutually-exclusive sections currently
// renders that cycle (active-not-closed → the active `cycle-row`; done +
// closed → the history `lens-cycle-row`).
function cycleLine(page: Page, cycleId: number): Locator {
  return historyCycleRow(page, cycleId).locator(".app-cycle-line");
}

// CR-CRU-146 §S2 — the computed `cursor` at a REAL point inside the line's
// own box that sits in the WIDEST gap between its rendered children (glyph,
// label, timer, `→ Runs` badge, `▸ N runs` hint) — i.e. genuinely empty
// space, never a child's own hit area. Measured (not assumed): the timer
// slot carries `margin-left: auto` (`.app-cycle-timer-slot`, `public/
// styles.css`), which pushes the timer AND everything after it (the `→
// Runs` badge) flush to the line's right edge — so for a row with a timer,
// there is NO dead space past the badge at all; the real empty run sits
// in the MIDDLE of the line, right of the label, before the timer starts.
// Picking the single widest gap among the leading edge, every inter-child
// gap, and the trailing edge finds that real empty space regardless of
// which children a given row happens to render. `elementFromPoint` (not
// just `getComputedStyle` on the line node) proves the point really lands
// on the line itself and not a child that happens to reach that far.
async function measureEmptySpaceCursor(page: Page, cycleId: number): Promise<string | null> {
  const { x, y } = await findWidestGap(page, cycleId);
  return page.evaluate(
    (point: { x: number; y: number }) => {
      const target = document.elementFromPoint(point.x, point.y);
      return target ? getComputedStyle(target).cursor : null;
    },
    { x, y },
  );
}

// The ONE gap search both `measureEmptySpaceCursor` (above) and the pixel
// hit-test (below) aim at: the midpoint of the widest run of the cycle
// line's own box not covered by any rendered child — the leading edge,
// every inter-child gap, and the trailing edge are all candidates — at the
// line's vertical centre. Viewport coordinates, as `elementFromPoint` and
// `page.mouse`/`page.touchscreen` take them.
async function findWidestGap(page: Page, cycleId: number): Promise<{ x: number; y: number }> {
  const line = cycleLine(page, cycleId);
  await expect(line).toBeVisible();
  return line.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const children = Array.from(el.children) as HTMLElement[];
    const rects = children.map((c) => c.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    const gaps: Array<{ start: number; end: number }> = [];
    let occupiedUpTo = rect.left;
    for (const r of rects) {
      if (r.left > occupiedUpTo) gaps.push({ start: occupiedUpTo, end: r.left });
      occupiedUpTo = Math.max(occupiedUpTo, r.right);
    }
    if (rect.right > occupiedUpTo) gaps.push({ start: occupiedUpTo, end: rect.right });
    const widest = gaps.reduce(
      (best, g) => (g.end - g.start > best.end - best.start ? g : best),
      { start: rect.left, end: rect.left },
    );
    return { x: (widest.start + widest.end) / 2, y: rect.top + rect.height / 2 };
  });
}

// ── noise seeding — makes the Runs pane genuinely scrollable so §S1's
// `scrollIntoView` effect is a real, provable pane-scroll, not a no-op on an
// already-fully-visible feed (mirrors drillin.steps.ts's scrollTop precedent).
Step(
  "{int} filler passing runs are ingested on that project",
  async ({ request, world }, count: number) => {
    for (let i = 0; i < count; i++) {
      await ingestParsed(request, world.projectKey as string, `crb-filler-${i}`, {
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        duration_ms: 5,
      });
    }
  },
);

// ── §S1 — cycle row (History) → Runs boundary ───────────────────────────────

Step(
  "I click the cycle-to-runs badge for cycle {string} in the cr group for {string}",
  async ({ page }, label: string, cr: string) => {
    const row = crGroup(page, cr).getByTestId("lens-cycle-row").filter({ hasText: label });
    await expect(row).toBeVisible();
    const badge = row.getByTestId("cycle-to-runs");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("aria-disabled", "false");
    await badge.click();
  },
);

Step(
  "the declared marker for that cycle is scrolled into view within the Runs pane and blinking",
  async ({ page, world }) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).toBeVisible();
    await expect(marker).toHaveClass(/app-locate-blink/);
    // Real pane-scroll proof (not the page): the marker was seeded below the
    // fold by the filler runs above it in the newest-first feed, so a
    // non-zero scrollTop on the pane's OWN scroller after the click proves
    // `scrollIntoView` ran against the pane. CR-CRU-029 §S1 — that scroller is
    // now the bounded `[data-testid="pane-scroll"]` box (mechanism a), not the
    // outer `workspace-runs` `.app-center` (now `overflow:hidden`); the marker
    // card sits inside pane-scroll, so `scrollIntoView` scrolls pane-scroll.
    // Scoped under workspace-runs (unique to the mounted Runs pane) so the
    // handle resolves the Runs feed's pane-scroll, not another tab's.
    const scrollTop = await page
      .getByTestId("workspace-runs")
      .getByTestId("pane-scroll")
      .evaluate((el) => (el as HTMLElement).scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
  },
);

Step(
  "the declared marker for that cycle loses its blink class within {int} seconds",
  async ({ page, world }, seconds: number) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).not.toHaveClass(/app-locate-blink/, {
      timeout: seconds * 1000 + 1_000,
    });
  },
);

// ── §S2 — Runs boundary → cycle row (inverse) ───────────────────────────────

Step(
  "I click the {string} badge on the declared marker for that cycle",
  async ({ page, world }, label: string) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).toBeVisible();
    const badge = marker.getByTestId("boundary-to-cycle");
    await expect(badge).toHaveText(label);
    await badge.click();
  },
);

Step(
  "the cr group for {string} is auto-expanded showing its cycle rows",
  async ({ page }, cr: string) => {
    await expect(crGroup(page, cr).getByTestId("lens-cycle-row").first()).toBeVisible();
  },
);

Step(
  "the history cycle row for that cycle is scrolled into view and blinking",
  async ({ page, world }) => {
    const row = historyCycleRow(page, world.cycleId as number);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/app-locate-blink/);
  },
);

Step("exactly one element blinks across the workspace", async ({ page }) => {
  await expect(page.locator(".app-locate-blink")).toHaveCount(1);
});

// ── the jump lands through folded History and from All Projects ─────────────
// A second CR worked to a close in a NEWER release, so the release holding
// "that cycle" is no longer the newest and History draws it (and its waves)
// folded. Deliberately leaves `world.planId`/`world.cycleId` pointing at the
// cycle the scenario jumps to.
Step(
  "a newer cr {string} is planned, worked and closed in wave {string} with merge commit {string}",
  async ({ request, world }, cr: string, wave: string, commit: string) => {
    const projectKey = world.projectKey as string;
    const plan = await filePlan(request, projectKey, cr, ["c1 newer"], wave);
    const cycleId = plan.cycles[0]!.id;
    await transitionCycle(request, projectKey, plan.planId, cycleId, "active");
    await transitionCycle(request, projectKey, plan.planId, cycleId, "done");
    await closePlan(request, projectKey, plan.planId, commit);
  },
);

Step(
  "I click the {string} badge on the All Projects timeline's declared marker for that cycle",
  async ({ page, world }, label: string) => {
    const marker = page
      .getByTestId("timeline")
      .locator(`[data-testid="declared-marker"][data-cycle-id="${world.cycleId as number}"]`);
    await expect(marker).toBeVisible();
    const badge = marker.getByTestId("boundary-to-cycle");
    await expect(badge).toHaveText(label);
    await badge.click();
  },
);

Step(
  "the release {string} row's wave {string} is open",
  async ({ page }, release: string, wave: string) => {
    const group = page
      .locator(`[data-testid="history-release"][data-release="${release}"]`)
      .locator(`[data-testid="wave-group"][data-wave="${wave}"]`);
    await expect(group).toHaveAttribute("data-open", "true");
  },
);

Step("the history cycle row for that cycle sits inside the viewport", async ({ page, world }) => {
  await expect(historyCycleRow(page, world.cycleId as number)).toBeInViewport();
});

// ── §S2b — Run Timeline accordion ───────────────────────────────────────────

Step("I click the body of the declared marker for that cycle", async ({ page, world }) => {
  const marker = declaredMarker(page, world.cycleId as number);
  await expect(marker).toBeVisible();
  // Click near the marker's top-left corner — the trailing `boundary-to-cycle`
  // badge and (when collapsed) the `accordion-collapsed-cue` both render at
  // the END of the row's text, so a click at the body's leading edge can
  // never land on either nested node (which stopPropagation their own click
  // and must NOT be what fires the accordion toggle).
  await marker.click({ position: { x: 5, y: 5 } });
});

Step(
  "the event card for {string} is not present in the workspace Runs pane",
  async ({ page }, agentId: string) => {
    await expect(
      page.getByTestId("workspace-runs").getByTestId("event-card").filter({ hasText: agentId }),
    ).toHaveCount(0);
  },
);

Step(
  "the declared marker for that cycle shows the collapsed cue {string}",
  async ({ page, world }, cue: string) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).toHaveClass(/app-accordion-collapsed/);
    await expect(marker.getByTestId("accordion-collapsed-cue")).toHaveText(cue);
  },
);

Step(
  "the declared marker for that cycle no longer shows a collapsed cue",
  async ({ page, world }) => {
    const marker = declaredMarker(page, world.cycleId as number);
    await expect(marker).not.toHaveClass(/app-accordion-collapsed/);
    await expect(marker.getByTestId("accordion-collapsed-cue")).toHaveCount(0);
  },
);

// ── CR-CRU-146 §S2 — the affordance is honest at a glance ───────────────────
// A toggleable cycle line's `cursor: pointer` must be readable ANYWHERE on
// the line, not just on the 13px glyph — the SAME `.app-lens-toggle` class
// the CR-group row already wears. A line with no toggle (the active
// section's open span, ruling (a)) must show the browser default instead.

Step(
  "the active-section cycle line for that cycle shows the default cursor over its empty space, not pointer",
  async ({ page, world }) => {
    const cursor = await measureEmptySpaceCursor(page, world.cycleId as number);
    expect(cursor).not.toBe("pointer");
  },
);

Step(
  "the history cycle line for that cycle shows the pointer cursor over its empty space",
  async ({ page, world }) => {
    const cursor = await measureEmptySpaceCursor(page, world.cycleId as number);
    expect(cursor).toBe("pointer");
  },
);

// ── CR-CRU-146 — pixel hit-test (real browser) + "the handler spans the row" ─
// AC1/AC6 (docs/changes/CR-CRU-146-\u2026): the history cycle LINE (not the 13px
// drill-down glyph) is the hit area, proven at the four REAL pixel x-offsets
// the AC names — each derived from a measured child rect (the status glyph,
// the label, the widest inter-child gap, and the gap between the element
// immediately before the `→ Runs` badge and the badge itself), never a
// hard-coded pixel, using the same `findWidestGap` search `measureEmptySpaceCursor` above
// already uses. `document.elementFromPoint` proves each point BEFORE it is
// clicked (never merely assumed from the rect math), so a mis-aimed click
// cannot pass vacuously; the widest-gap offset additionally proves the point
// resolves to the LINE ITSELF, not a child — the behavioural proof that the
// toggle handler sits on the line (a DOM listener cannot be read directly) —
// so a refactor that re-narrows the handler to a child node reds that check
// even before the open/close assertion does.

interface HitOffset {
  name: string;
  x: number;
  y: number;
  excludeBadge: boolean;
  mustBeLineItself: boolean;
}

// The real empty-space point inside a cycle line — the widest inter-child
// gap — is `findWidestGap` above, shared with `measureEmptySpaceCursor`.

// The four AC-named x-offsets, each derived from a real rendered child rect:
// the status glyph (near the left edge — dead space before CR-146, per the
// CR's own Problem-table measurement: only the SEPARATE `cycle-toggle`
// drill-down chevron was ever clickable, never `.app-cycle-glyph`), the
// label, the widest gap (via `findWidestGap`), and the gap between the
// element immediately before the `→ Runs` badge (the sealed/ember timer) and
// the badge itself (near the right edge, short of it).
async function hitOffsets(page: Page, cycleId: number): Promise<HitOffset[]> {
  const line = cycleLine(page, cycleId);
  await expect(line).toBeVisible();
  const gap = await findWidestGap(page, cycleId);
  const measured = await line.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const children = Array.from(el.children) as HTMLElement[];
    const glyph = el.querySelector<HTMLElement>(".app-cycle-glyph");
    const label = el.querySelector<HTMLElement>(".app-cycle-label");
    const badge = el.querySelector<HTMLElement>('[data-testid="cycle-to-runs"]');
    if (!glyph || !label || !badge) {
      throw new Error(
        "hitOffsets: expected the status glyph, label and → Runs badge to all render",
      );
    }
    const glyphRect = glyph.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const badgeIndex = children.indexOf(badge);
    const beforeBadge = badgeIndex > 0 ? children[badgeIndex - 1] : null;
    if (!beforeBadge) {
      throw new Error(
        "hitOffsets: expected a rendered element immediately before the → Runs badge",
      );
    }
    const beforeBadgeRect = beforeBadge.getBoundingClientRect();
    return {
      y,
      glyphX: (glyphRect.left + glyphRect.right) / 2,
      labelX: (labelRect.left + labelRect.right) / 2,
      rightEdgeX: (beforeBadgeRect.right + badgeRect.left) / 2,
    };
  });

  return [
    {
      name: "near the left edge (status glyph)",
      x: measured.glyphX,
      y: measured.y,
      excludeBadge: false,
      mustBeLineItself: false,
    },
    {
      name: "over the label",
      x: measured.labelX,
      y: measured.y,
      excludeBadge: false,
      mustBeLineItself: false,
    },
    {
      name: "the empty space right of the label",
      x: gap.x,
      y: gap.y,
      excludeBadge: false,
      mustBeLineItself: true,
    },
    {
      name: "near the right edge, short of the → Runs badge",
      x: measured.rightEdgeX,
      y: measured.y,
      excludeBadge: true,
      mustBeLineItself: false,
    },
  ];
}

// `document.elementFromPoint` proof, run BEFORE every click: the point must
// land inside the cycle line (on the line itself or a descendant it owns);
// the "short of the badge" point must additionally NOT land inside the
// badge; the widest-gap point must resolve to the LINE ITSELF (no child
// covers it) — the behavioural proof that the toggle handler sits on the
// line, since a DOM listener cannot be read directly.
async function assertPointOnLine(page: Page, cycleId: number, offset: HitOffset): Promise<void> {
  const line = cycleLine(page, cycleId);
  const result = await line.evaluate(
    (lineEl, args: { x: number; y: number }) => {
      const target = document.elementFromPoint(args.x, args.y);
      const badge = lineEl.querySelector('[data-testid="cycle-to-runs"]');
      return {
        insideLine: target !== null && (target === lineEl || lineEl.contains(target)),
        isLineItself: target === lineEl,
        insideBadge:
          target !== null && badge !== null && (target === badge || badge.contains(target)),
      };
    },
    { x: offset.x, y: offset.y },
  );
  expect(
    result.insideLine,
    `${offset.name}: point (${offset.x}, ${offset.y}) must land inside the cycle line`,
  ).toBe(true);
  if (offset.excludeBadge) {
    expect(
      result.insideBadge,
      `${offset.name}: point (${offset.x}, ${offset.y}) must NOT land inside the → Runs badge`,
    ).toBe(false);
  }
  if (offset.mustBeLineItself) {
    expect(
      result.isLineItself,
      `${offset.name}: point (${offset.x}, ${offset.y}) must resolve to the line itself, ` +
        "outside every child — the behavioural proof the handler sits on the line",
    ).toBe(true);
  }
}

Step(
  "the history cycle line for that cycle measures at least 90% of its row's width",
  async ({ page, world }) => {
    const cycleId = world.cycleId as number;
    const row = historyCycleRow(page, cycleId);
    const line = cycleLine(page, cycleId);
    await expect(line).toBeVisible();
    const rowBox = await row.boundingBox();
    const lineBox = await line.boundingBox();
    if (!rowBox || !lineBox) {
      throw new Error("the history cycle row/line bounding box is unavailable");
    }
    expect(rowBox.width).toBeGreaterThan(0);
    expect(lineBox.width).toBeGreaterThanOrEqual(0.9 * rowBox.width);
  },
);

Step(
  "clicking the history cycle line for that cycle at each measured x-offset opens then closes its linked runs",
  async ({ page, world }) => {
    const cycleId = world.cycleId as number;
    const offsets = await hitOffsets(page, cycleId);
    expect(offsets.length).toBeGreaterThanOrEqual(4);

    const row = historyCycleRow(page, cycleId);
    const workflowTab = page.getByTestId("workspace-tab").filter({ hasText: "Workflow" });

    for (const offset of offsets) {
      await assertPointOnLine(page, cycleId, offset);
      await expect(
        row.getByTestId("cycle-span-closed"),
        `${offset.name}: the row must start closed`,
      ).toHaveCount(0);

      await page.mouse.click(offset.x, offset.y);

      const openSpan = row.getByTestId("cycle-span-closed");
      await expect(openSpan, `clicking ${offset.name} must open the cycle's linked runs`).toBeVisible();
      await expect(
        openSpan.getByTestId("linked-run-row"),
        `${offset.name}: the opened span must show exactly the two linked runs`,
      ).toHaveCount(2);
      // Negative bound: the click did not navigate away from Workflow.
      await expect(workflowTab).toHaveClass(/\bon\b/);

      await assertPointOnLine(page, cycleId, offset);
      await page.mouse.click(offset.x, offset.y);

      await expect(
        row.getByTestId("cycle-span-closed"),
        `clicking ${offset.name} again must close the cycle's linked runs`,
      ).toHaveCount(0);
    }
  },
);

Step("I click the history cycle line for that cycle in its empty space", async ({ page, world }) => {
  const { x, y } = await findWidestGap(page, world.cycleId as number);
  await page.mouse.click(x, y);
});

// CR-CRU-146 — the SAME hit-area proof at the PHONE band (DN-crucible-
// responsive-model.md decision 11 is per-band: "cycle rows go full-width and
// the row is the toggle"). Collected by mobile-viewport-responsive.feature,
// so it runs under every phone project (chromium-mobile, webkit-iphone) with
// a real TOUCH input, not a desktop mouse. The point is the widest gap
// (`findWidestGap`), proven by `elementFromPoint` to resolve to the LINE
// ITSELF — outside every child — before each tap, so a handler re-narrowed
// to a child (the glyph, the label) reds here at phone width too.
Step(
  "tapping the history cycle line for that cycle in its empty space opens then closes its linked runs",
  async ({ page, world }) => {
    const cycleId = world.cycleId as number;
    const row = historyCycleRow(page, cycleId);
    await cycleLine(page, cycleId).scrollIntoViewIfNeeded();
    await expect(row.getByTestId("cycle-span-closed"), "the row must start closed").toHaveCount(0);

    const opening = await findWidestGap(page, cycleId);
    const gapOffset = (point: { x: number; y: number }): HitOffset => ({
      name: "the empty space inside the line (phone band)",
      x: point.x,
      y: point.y,
      excludeBadge: true,
      mustBeLineItself: true,
    });
    await assertPointOnLine(page, cycleId, gapOffset(opening));
    await page.touchscreen.tap(opening.x, opening.y);

    const openSpan = row.getByTestId("cycle-span-closed");
    await expect(openSpan, "tapping the line's empty space must open the cycle's linked runs").toBeVisible();
    await expect(
      openSpan.getByTestId("linked-run-row"),
      "the opened span must show exactly the two linked runs",
    ).toHaveCount(2);
    await expect(page.getByTestId("workspace-tab").filter({ hasText: "Workflow" })).toHaveClass(
      /\bon\b/,
    );

    const closing = await findWidestGap(page, cycleId);
    await assertPointOnLine(page, cycleId, gapOffset(closing));
    await page.touchscreen.tap(closing.x, closing.y);

    await expect(
      row.getByTestId("cycle-span-closed"),
      "tapping the line's empty space again must close the cycle's linked runs",
    ).toHaveCount(0);
  },
);

