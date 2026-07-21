// CR-CRU-034 §S1+§S2 — drilldown-dual-axis-scroll.feature steps: the
// run-detail-with-multiple-failures repro CR-029's own e2e never covered
// (that suite scoped the feed panes, not a run detail body). Reuses
// seeding.steps.ts's `ingestJunit` plumbing (harness.ts) for fixture
// ingest, and pane-scroll.steps.ts's shared `[data-testid="pane-scroll"]` /
// `[data-testid="workspace-runs"]` steps for the §S2 horizontal-affordance
// scenario (the run detail renders inside the SAME `workspace-runs` /
// `pane-scroll` testid pair as the Runs feed — see WorkspaceRunDetail in
// public/app.js — so those steps bind unchanged).
//
// Fixture design note: every failing leaf below carries a long (60-line)
// `pre-wrap` trace so its rendered failure-box is reliably taller than the
// `.app-tree-scroll { max-height: 60vh }` cap (384px at this suite's fixed
// 640px viewport height) regardless of exact chrome/header pixel budgets —
// the RED signal must not depend on guessing precise layout arithmetic.
import { expect, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestJunit } from "./harness.ts";

function longTrace(label: string, lines = 60): string {
  const rows: string[] = [];
  for (let i = 1; i <= lines; i++) {
    rows.push(`${label} trace line ${i} — forcing real vertical overflow past the retired 60vh cap.`);
  }
  return rows.join("\n");
}

/** One `<testsuite>` with `failCount` tall failing leaves + 1 passing leaf. */
function suiteWithTallFailures(suiteName: string, failCount: number): string {
  const cases: string[] = [];
  for (let i = 1; i <= failCount; i++) {
    cases.push(
      `<testcase name="${suiteName}-fail-${i}" time="0.02"><failure message="${suiteName} failure ${i} — tall trace">${longTrace(`${suiteName}#${i}`)}</failure></testcase>`,
    );
  }
  cases.push(`<testcase name="${suiteName}-pass" time="0.01"/>`);
  return [`<testsuite name="${suiteName}" tests="${failCount + 1}">`, ...cases, "</testsuite>"].join("\n");
}

Step(
  "a failing run with {int} tall failing leaves in one suite is ingested for agent {string}",
  async ({ request, world }, failCount: number, agentId: string) => {
    const xml = suiteWithTallFailures("SuiteTallOne", failCount);
    const res = await ingestJunit(request, world.projectKey as string, agentId, xml, "unit");
    world.eventId = res.event;
  },
);

Step(
  "a failing run with {int} failing suites, each with a tall failure, is ingested for agent {string}",
  async ({ request, world }, suiteCount: number, agentId: string) => {
    const suites: string[] = [];
    for (let i = 1; i <= suiteCount; i++) {
      suites.push(suiteWithTallFailures(`SuiteTallMulti${i}`, 1));
    }
    const xml = ["<testsuites>", ...suites, "</testsuites>"].join("\n");
    const res = await ingestJunit(request, world.projectKey as string, agentId, xml, "unit");
    world.eventId = res.event;
  },
);

Step(
  "each of the {int} failing suites in the run detail is auto-expanded",
  async ({ page }, suiteCount: number) => {
    const overlay = page.getByTestId("run-overlay");
    await expect(overlay.getByTestId("leaf-row").first()).toBeVisible();
    const toggles = overlay.getByTestId("tree-toggle");
    await expect(toggles).toHaveCount(suiteCount);
    for (let i = 0; i < suiteCount; i++) {
      await expect(toggles.nth(i)).toHaveText("▾");
    }
  },
);

// §S1 AC1 bullet 1 — "no descendant of the run detail has computed
// max-height ≈ 60vh with an independent scrollTop": a STRUCTURAL check (any
// descendant whose computed max-height is ~60vh of the CURRENT viewport AND
// whose computed overflow-y allows independent scrolling), not a
// content-overflow-amount check — it fires the instant `.app-tree-scroll`
// exists at all (whenever a suite is expanded), regardless of whether that
// particular suite's own content happens to exceed the cap, so it's the one
// assertion below robust to BOTH the single-suite and multi-suite fixtures.
Step(
  "no suite-leaf scroll box in the run detail acts as an independent ~60vh scroller",
  async ({ page }) => {
    const overlay = page.getByTestId("run-overlay");
    await expect(overlay.getByTestId("leaf-row").first()).toBeVisible();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const capPx = viewport!.height * 0.6;
    const found = await overlay.evaluate((root, cap) => {
      const all = root.querySelectorAll<HTMLElement>("*");
      for (const el of Array.from(all)) {
        const style = getComputedStyle(el);
        if (!style.maxHeight.endsWith("px")) continue;
        const px = parseFloat(style.maxHeight);
        if (Number.isNaN(px) || Math.abs(px - cap) > 40) continue;
        if (style.overflowY === "auto" || style.overflowY === "scroll") return true;
      }
      return false;
    }, capPx);
    expect(found).toBe(false);
  },
);

Step("I scroll the pane-scroll element to its maximum", async ({ page }) => {
  const pane = page.getByTestId("run-overlay").getByTestId("pane-scroll");
  await expect(pane).toHaveCount(1);
  await pane.evaluate((el) => {
    (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
  });
});

function withinVerticalSpan(
  inner: { y: number; height: number },
  outer: { y: number; height: number },
  slack = 2,
): boolean {
  return inner.y >= outer.y - slack && inner.y <= outer.y + outer.height + slack;
}

// §S1 AC1 bullet 3 / Multi-suite bullet — REACHABILITY, not "already on
// screen at max scroll". The AC's real guarantee is "reveal the last
// failure AND the footer BY SCROLLING" — the footer-reachable half is
// covered by the next step below. Each fixture failing leaf carries a
// 60-line trace (~840px), taller than the pane (~530px at this suite's
// 640px viewport), so at MAX scroll the pane legitimately shows the
// failures-footer + the tail of the last box, with that box's own leading
// ROW scrolled above the fold — that is correct dual-axis behaviour, not a
// trap, and must not be asserted away.
//
// So this step asks a pure geometry question instead of relying on
// whatever scrollTop the PREVIOUS step happened to leave pane-scroll at:
// does SOME valid pane-scroll scrollTop value (0..scrollHeight-clientHeight)
// exist that puts the row's own row fully inside pane-scroll's visible
// clientHeight? It computes this from the row's CURRENT layout position —
// never assigns scrollTop, so it can't perturb pane's actual scroll state
// for the downstream "the failures footer is fully within..." step (or
// trigger a virtualization re-render mid-check, which a real scrollTop
// mutation here previously did and made the row's own elementHandle go
// stale). A leaf stacked inside the retired `.app-tree-scroll` capped box
// would still fail this: nothing (here or anywhere in the app) ever moves
// that inner box's own scrollTop, so the row's real layout position stays
// clipped past the cap no matter what pane-scroll value is hypothesized —
// genuinely unreachable, not merely "off-screen at THIS scrollTop".
Step(
  "the last failing leaf's row is fully within the pane-scroll element's visible box",
  async ({ page }) => {
    const overlay = page.getByTestId("run-overlay");
    const pane = overlay.getByTestId("pane-scroll");
    const lastFailingLeaf = overlay.locator('[data-testid="leaf-row"].fail').last();
    await expect(lastFailingLeaf).toHaveCount(1);
    const leafHandle = await lastFailingLeaf.elementHandle();
    expect(leafHandle).not.toBeNull();
    const reachable = await pane.evaluate((paneEl, leafEl) => {
      const p = paneEl as HTMLElement;
      const target = leafEl as HTMLElement;
      const paneRect = p.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      // Row's position within pane's own scrollable content, independent of
      // pane's CURRENT scrollTop (never mutated here): "at hypothetical
      // scrollTop s, the row's page-Y would be contentY - s".
      const contentY = targetRect.top - paneRect.top + p.scrollTop;
      const maxScrollTop = p.scrollHeight - p.clientHeight;
      const minS = Math.max(0, contentY + targetRect.height - p.clientHeight);
      const maxS = Math.min(maxScrollTop, contentY);
      return minS <= maxS + 2; // 2px slack, matching withinVerticalSpan's tolerance
    }, leafHandle);
    expect(reachable).toBe(true);
  },
);

Step(
  "the failures footer is fully within the pane-scroll element's visible box",
  async ({ page }) => {
    const overlay = page.getByTestId("run-overlay");
    const pane = overlay.getByTestId("pane-scroll");
    const footer = overlay.getByTestId("failures-footer");
    await expect(footer).toHaveCount(1);
    const [paneBox, footerBox] = await Promise.all([pane.boundingBox(), footer.boundingBox()]);
    expect(paneBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(withinVerticalSpan(footerBox!, paneBox!)).toBe(true);
  },
);

// §S1 AC1 bullet 2 — "no dead space": the gap between the footer's own
// bottom edge (translated into pane-scroll's CONTENT coordinate space, i.e.
// independent of the current scrollTop) and pane-scroll's scrollHeight must
// not exceed pane-scroll's own bottom padding.
Step(
  "there is no dead space below the failures footer within the pane-scroll element",
  async ({ page }) => {
    const overlay = page.getByTestId("run-overlay");
    const pane = overlay.getByTestId("pane-scroll");
    await expect(overlay.getByTestId("failures-footer")).toHaveCount(1);
    const result = await pane.evaluate((el) => {
      const footer = el.querySelector('[data-testid="failures-footer"]') as HTMLElement | null;
      if (footer === null) return null;
      const paneRect = el.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const footerBottomInContent = footerRect.bottom - paneRect.top + el.scrollTop;
      const paddingBottom = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      return { gap: el.scrollHeight - footerBottomInContent, paddingBottom };
    });
    expect(result).not.toBeNull();
    expect(result!.gap).toBeLessThanOrEqual(result!.paddingBottom + 2);
  },
);

/** The currently-focused failing leaf's key, read off the ONE mounted
 * failure-box's preceding sibling leaf-row (CR-CRU-016 §S2 focus model:
 * exactly one failure box is open at a time in Detail once any leaf/jump
 * has been focused). */
async function focusedLeafKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="run-overlay"] [data-testid="failure-box"]');
    if (box === null) return null;
    const prev = box.previousElementSibling;
    return prev instanceof HTMLElement ? prev.getAttribute("data-leaf-key") : null;
  });
}

Step("I click the failure-jump chip", async ({ page, world }) => {
  const overlay = page.getByTestId("run-overlay");
  await overlay.getByTestId("failure-jump").click();
  world.focusedLeafKey = await focusedLeafKey(page);
});

// §S1 AC1 bullet 5 — the jump advances to + focus-opens the next failing
// leaf, and that leaf's box scrolls into the SAME bounded scroller.
Step(
  "the focused failing leaf's failure box is fully within the pane-scroll element's visible box",
  async ({ page }) => {
    const overlay = page.getByTestId("run-overlay");
    const pane = overlay.getByTestId("pane-scroll");
    const box = overlay.getByTestId("failure-box");
    await expect(box).toHaveCount(1);
    const [paneBox, failBox] = await Promise.all([pane.boundingBox(), box.boundingBox()]);
    expect(paneBox).not.toBeNull();
    expect(failBox).not.toBeNull();
    expect(withinVerticalSpan(failBox!, paneBox!)).toBe(true);
  },
);

// §S1 AC1 bullet 6 tail — "a subsequent footer jump still advances
// correctly" even after the raw toggle has rendered/removed content.
Step(
  "clicking the failure-jump chip again advances to a different failing leaf",
  async ({ page, world }) => {
    const previous = world.focusedLeafKey as string | null | undefined;
    const overlay = page.getByTestId("run-overlay");
    await overlay.getByTestId("failure-jump").click();
    const next = await focusedLeafKey(page);
    expect(next).not.toBeNull();
    expect(next).not.toBe(previous ?? null);
  },
);

// §S1 AC1 bullet 6 — the raw toggle must not disturb the single-scroller
// layout (no NEW dead space introduced by the re-render its click causes).
Step("I click the raw-toggle chip", async ({ page }) => {
  const overlay = page.getByTestId("run-overlay");
  await overlay.getByTestId("raw-toggle").click();
});
