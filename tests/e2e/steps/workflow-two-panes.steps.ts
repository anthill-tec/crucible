// CR-CRU-172 §S1/AC2 — workflow-two-panes.feature steps: the bulk-fixture
// filing steps (many cycles for Now, many closed CR plans for History) and
// the Now-grows / History-scrolls / phone-sub-tab assertions. Plan
// filing, cycle transitions and plan close reuse the SAME harness verbs
// workflow.steps.ts and wave-backfill.steps.ts already drive (filePlan /
// transitionCycle / closePlan — the client-equivalent POST/PATCH round
// trip), never a bespoke seeding path.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { filePlan, transitionCycle, closePlan } from "./harness.ts";

// ── fixture filing ──────────────────────────────────────────────────────

Step(
  "a cycle plan is filed for cr {string} with {int} cycles",
  async ({ request, world }, cr: string, count: number) => {
    const labels = Array.from({ length: count }, (_, i) => `c${i + 1}`);
    const res = await filePlan(request, world.projectKey as string, cr, labels);
    world.planId = res.planId;
    world.cr = res.cr;
    world.cycleId = res.cycles[0]!.id;
  },
);

// History (public/app-logic.mjs workflowLens) renders CLOSED plans only —
// an open plan's CR node is filtered OUT of every wave (§S1.3) — so a "long
// History" needs N separately closed plans, not N cycles inside one plan
// (a collapsed CR group renders ONE row regardless of its cycle count).
Step(
  "{int} closed CR plans are filed and merged under wave {string} for a long History",
  async ({ request, world }, count: number, wave: string) => {
    for (let i = 1; i <= count; i++) {
      const cr = `CR-W2P-H${i}`;
      const res = await filePlan(request, world.projectKey as string, cr, ["c1"], wave);
      const cycleId = res.cycles[0]!.id;
      await transitionCycle(request, world.projectKey as string, res.planId, cycleId, "active");
      await transitionCycle(request, world.projectKey as string, res.planId, cycleId, "done");
      await closePlan(
        request,
        world.projectKey as string,
        res.planId,
        `w2p${String(i).padStart(4, "0")}`,
      );
    }
  },
);

// ── desktop — document order, Now grows, History scrolls ────────────────

Step("Now sits above History in document order", async ({ page }) => {
  const order = await page.evaluate(() => {
    const now = document.querySelector('[data-testid="workflow-now"]');
    const history = document.querySelector('[data-testid="workflow-history"]');
    if (now === null || history === null) return null;
    return Boolean(now.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

// Re-pin (approved by the orchestrator — user ruling 2026-10-08): the
// half-pane cap on Now is withdrawn. Now grows with its content and has no
// scroll of its own — nothing in it is clipped and it is not an overflow
// box — while History takes the height Now leaves and scrolls on its own.
Step("Now grows with its content and never scrolls", async ({ page }) => {
  const now = page.getByTestId("workflow-now");
  await expect(now).toBeVisible();
  const box = await now.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  // Nothing clipped: the box is exactly as tall as its content.
  expect(box.scrollHeight, "Now's box clips its own content").toBe(box.clientHeight);
  // ...and it is not a scroll box at all.
  expect(["auto", "scroll"]).not.toContain(box.overflowY);
});

Step("History scrolls on its own", async ({ page }) => {
  const history = page.getByTestId("workflow-history");
  await expect(history).toBeVisible();
  const box = await history.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(["auto", "scroll"]).toContain(box.overflowY);
  expect(
    box.scrollHeight,
    "History's own box has no scroll range of its own",
  ).toBeGreaterThan(box.clientHeight);

  // Scrolling History moves History's own content, not Now.
  const nowTopBefore = (await page.getByTestId("workflow-now").boundingBox())!.y;
  await history.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await history.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await page.getByTestId("workflow-now").boundingBox())!.y).toBe(nowTopBefore);
});

// ── phone — the sub-tab row toggle (F15d) ───────────────────────────────

Step(
  "the Workflow tab shows Now and History as two full-width toggle sub-tabs",
  async ({ page }) => {
    const subtabs = page.getByTestId("workflow-subtab");
    await expect(subtabs).toHaveCount(2);
    const now = subtabs.filter({ hasText: "Now" });
    const history = subtabs.filter({ hasText: "History" });
    await expect(now).toBeVisible();
    await expect(history).toBeVisible();

    const container = page.getByTestId("workflow-subtabs");
    const containerBox = await container.boundingBox();
    expect(containerBox).not.toBeNull();
    for (const row of [now, history]) {
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      // F15d's own hit-area rule: the ROW is the toggle (not a small glyph
      // inside it) — spans nearly the whole container width, and clears the
      // same 44px touch floor DN decision 4 sets for every interactive
      // control on the phone band.
      expect(box!.width).toBeGreaterThanOrEqual(containerBox!.width * 0.9);
      expect(Math.max(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
    }
  },
);

Step("I select the {string} sub-tab", async ({ page }, name: string) => {
  await page.getByTestId("workflow-subtab").filter({ hasText: name }).click();
});

Step("the {string} sub-tab is selected", async ({ page }, name: string) => {
  const tab = page.getByTestId("workflow-subtab").filter({ hasText: name });
  await expect(tab).toHaveAttribute("aria-selected", "true");
});

Step("the Now pane is visible", async ({ page }) => {
  await expect(page.getByTestId("workflow-now")).toBeVisible();
});

Step("the Now pane is not visible", async ({ page }) => {
  await expect(page.getByTestId("workflow-now")).not.toBeVisible();
});

Step("the History pane is visible", async ({ page }) => {
  await expect(page.getByTestId("workflow-history")).toBeVisible();
});

Step("the History pane is not visible", async ({ page }) => {
  await expect(page.getByTestId("workflow-history")).not.toBeVisible();
});

// §S1/AC2 — the desktop title, outside its own box: RED-agent-defined
// testids `workflow-now-title` / `workflow-history-title` (same decision as
// workflow-now-pane.test.ts's happy-dom desktop assertion) — distinct from
// the existing `workflow-now` / `workflow-history` box testids, because the
// AC requires the title to sit OUTSIDE the box it names.
Step(
  "a title reading {string} renders above and outside {string} pane",
  async ({ page }, text: string, pane: string) => {
    const paneTestid = `workflow-${pane.toLowerCase()}`;
    const titleTestid = `${paneTestid}-title`;

    const title = page.getByTestId(titleTestid);
    await expect(title).toBeVisible();
    await expect(title).toHaveText(text);

    const box = page.getByTestId(paneTestid);
    await expect(box).toBeVisible();

    const relation = await page.evaluate(
      ({ titleSel, boxSel }) => {
        const t = document.querySelector(titleSel);
        const b = document.querySelector(boxSel);
        if (t === null || b === null) return null;
        return {
          // OUTSIDE — the title is not a descendant of its own box.
          contained: b.contains(t),
          // ABOVE — the title precedes its own box in document order.
          titleBeforeBox: Boolean(t.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      },
      { titleSel: `[data-testid="${titleTestid}"]`, boxSel: `[data-testid="${paneTestid}"]` },
    );
    expect(relation).not.toBeNull();
    expect(relation!.contained).toBe(false);
    expect(relation!.titleBeforeBox).toBe(true);
  },
);

// §S1/AC2 — on the phone band the sub-tab rows ARE the titles, so no
// separate title element renders above either pane.
Step("the Workflow tab shows no title above either pane", async ({ page }) => {
  await expect(page.getByTestId("workflow-now-title")).toHaveCount(0);
  await expect(page.getByTestId("workflow-history-title")).toHaveCount(0);
});
