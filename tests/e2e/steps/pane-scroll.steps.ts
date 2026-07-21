// CR-CRU-023 §S1 — viewport-pane-scroll-floor.feature steps: viewport
// resize and the pane-level horizontal-scroll-floor assertions (the shared
// `[data-testid="pane-scroll"]` handle C1 GREEN put on every central pane —
// see public/app.js/.app-pane-content and styles.css's 660px child
// min-width floor). Reuses seeding.steps.ts / workflow.steps.ts /
// navigation.steps.ts for project/plan/run seeding and navigation — only
// the viewport + scroll-geometry assertions are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

Step("the viewport is {int}x{int}", async ({ page }, width: number, height: number) => {
  await page.setViewportSize({ width, height });
});

// "the active pane's instance" — exactly one `[data-testid="pane-scroll"]`
// renders per route (one of the seven central-pane surfaces mounts at a
// time); its scrollWidth exceeding its clientWidth is the PANE-level
// horizontal scrollbar the §S1 AC requires below the supported floor.
Step("the active pane-scroll element scrolls horizontally", async ({ page }) => {
  const pane = page.getByTestId("pane-scroll");
  await expect(pane).toHaveCount(1);
  const { scrollWidth, clientWidth } = await pane.evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(scrollWidth).toBeGreaterThan(clientWidth);
});

Step("no pane scrolls horizontally", async ({ page }) => {
  const pane = page.getByTestId("pane-scroll");
  await expect(pane).toHaveCount(1);
  const { scrollWidth, clientWidth } = await pane.evaluate((el) => ({
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

// .app-cycle-timer-ember is `font: 600 8.5px/1.8 var(--mono)` (line-height
// ≈15.3px) + 1px vertical padding each side (≈17px rendered) and
// `white-space: nowrap` (styles.css). A badge that had wrapped onto a
// second line would roughly double that box height; 26px is a generous
// single-line ceiling that still catches a wrap. Belt-and-braces: also
// assert no embedded newline in its text (mirrors
// tests/cycle-timers.test.ts's "ONE unbroken text node" pin).
Step("the cycle-timer badge renders as a single unbroken line", async ({ page }) => {
  const badge = page.getByTestId("cycle-timer");
  await expect(badge).toBeVisible();
  const innerText = await badge.innerText();
  expect(innerText).not.toMatch(/[\n\r]/);
  const box = await badge.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(26);
});

Step("the page body does not scroll horizontally", async ({ page }) => {
  const { bodyScrollWidth, innerWidth } = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(bodyScrollWidth).toBeLessThanOrEqual(innerWidth);
});

// CR-CRU-029 — a tab click (workflow.steps.ts's "I click the {string}
// workspace tab") flips `state.workspaceTab` synchronously, but VanJS's
// reactive class/child bindings commit on the NEXT tick, not within the
// click's own event-handler turn. A bare `.evaluate()`/`.boundingBox()` read
// right after the click can therefore observe the PREVIOUS tab's still-
// mounted `pane-scroll` (same testid, wrong content) before the swap lands —
// `toHaveCount(1)` alone doesn't catch this since count stays 1 across the
// swap. `workspace-runs` only exists in the DOM once the Runs pane (or its
// run-detail) is the mounted tab, so waiting on it with an auto-retrying
// `expect` absorbs that one tick reliably before any of the steps below read
// pane-scroll's content.
async function waitForRunsPaneMounted(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("workspace-runs")).toBeVisible();
}

// CR-CRU-029 §S1 — drives the vertical scroll to a named position (top /
// middle / bottom) WITHOUT hardcoding which element is the real vertical
// scroller: today it's the OUTER `workspace-runs` (`.app-center`,
// `overflow-y: auto`), while the §S1 fix's preferred mechanism (a) turns
// `pane-scroll` itself into the bounded dual-axis box. Trying both and
// no-opping on whichever has no scroll range (`max <= 0`) keeps this step
// valid on either side of the fix, so it measures the OBSERVABLE bug
// (reachability), not a particular implementation.
Step(
  "the pane-scroll element's bounding box stays within the viewport when the workspace Runs pane is scrolled to the {word}",
  async ({ page }, position: string) => {
    await waitForRunsPaneMounted(page);
    await page.evaluate((pos) => {
      function setScroll(el: HTMLElement, p: string): boolean {
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) return false;
        el.scrollTop = p === "top" ? 0 : p === "bottom" ? max : Math.round(max / 2);
        return true;
      }
      const inner = document.querySelector('[data-testid="pane-scroll"]');
      const outer = document.querySelector('[data-testid="workspace-runs"]');
      if (inner instanceof HTMLElement) setScroll(inner, pos);
      if (outer instanceof HTMLElement) setScroll(outer, pos);
    }, position);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const box = await page.getByTestId("pane-scroll").boundingBox();
    expect(box).not.toBeNull();
    // The horizontal scroll affordance renders at pane-scroll's own bottom
    // edge (CR-CRU-023 §S1's overflow-x owner) — it is only reachable while
    // that edge sits inside the viewport's vertical bounds.
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  },
);

// CR-CRU-029 §S1 — the SECOND half of "both axes operable at once": after
// driving a vertical scroll (previous step), the horizontal axis must still
// respond to a scroll input on the SAME pane-scroll box.
Step(
  "driving a horizontal scroll on the pane-scroll element after that still moves its scrollLeft",
  async ({ page }) => {
    await waitForRunsPaneMounted(page);
    const pane = page.getByTestId("pane-scroll");
    const before = await pane.evaluate((el) => (el as HTMLElement).scrollLeft);
    await pane.evaluate((el) => {
      (el as HTMLElement).scrollLeft = 50;
    });
    const after = await pane.evaluate((el) => (el as HTMLElement).scrollLeft);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(0);
  },
);

// CR-CRU-029 §S2 — CR-CRU-016 regression, asserted directly on the
// pane-scroll box (see the feature file's scenario comment for why this
// targets `pane-scroll` rather than the current `workspace-runs` restore
// target).
Step("I scroll the pane-scroll element down by {int}px", async ({ page }, amount: number) => {
  await waitForRunsPaneMounted(page);
  await page.getByTestId("pane-scroll").evaluate((el, amt) => {
    (el as HTMLElement).scrollTop = amt;
  }, amount);
});

Step("the pane-scroll element's scrollTop is {int}", async ({ page }, expected: number) => {
  const scrollTop = await page
    .getByTestId("pane-scroll")
    .evaluate((el) => (el as HTMLElement).scrollTop);
  expect(scrollTop).toBe(expected);
});

// CR-CRU-029 §S2 preserved-invariant guard — the CR-CRU-023 §S1 660px child
// min-width floor (styles.css `.app-pane-content > * { min-width: 660px }`)
// stays in effect unchanged; this patch only fixes reachability, not the
// floor value.
Step(
  "the workspace Runs pane's content child carries the 660px min-width floor",
  async ({ page }) => {
    await waitForRunsPaneMounted(page);
    const pane = page.getByTestId("pane-scroll");
    await expect(pane).toHaveCount(1);
    const minWidth = await pane.evaluate((el) => {
      const child = (el as HTMLElement).firstElementChild as HTMLElement | null;
      return child === null ? null : getComputedStyle(child).minWidth;
    });
    expect(minWidth).toBe("660px");
  },
);
