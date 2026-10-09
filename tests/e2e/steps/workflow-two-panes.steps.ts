// CR-CRU-172 §S1/AC2 — workflow-two-panes.feature steps: the bulk-fixture
// filing steps (many cycles for Now, many closed CR plans for History) and
// the Now-grows / History-scrolls / phone-sub-tab assertions. Plan
// filing, cycle transitions and plan close reuse the SAME harness verbs
// workflow.steps.ts and wave-backfill.steps.ts already drive (filePlan /
// transitionCycle / closePlan — the client-equivalent POST/PATCH round
// trip), never a bespoke seeding path.
import { expect, type Page } from "@playwright/test";
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

// ── CR-CRU-178 \u00a7S1 \u2014 "Now and History read as two panes" (F24, option B,
// APPROVED 2026-10-09). Reuses this file's own bulk-fixture steps
// ("a cycle plan is filed for cr {string} with {int} cycles", "{int} closed
// CR plans are filed and merged under wave {string} for a long History"),
// workflow.steps.ts's "a cycle plan is filed for cr {string} with a cycle
// labelled {string}" / "cycle 1 of that plan is activated" / "cycle 1 of
// that plan is marked done" / "the plan is closed with merge commit
// {string}", and workflow-now-pane.steps.ts's "an in-flight no-mistakes
// gate is ingested via the API for release {string} with run id {string}"
// \u2014 only the split-card / header-bar / dot / divider assertions below
// are new here.
//
// RED-agent-defined testids (the spec names the CONTENT and the frame names
// the COMPOSITION, neither names a testid beyond the two the gap analysis
// keeps \u2014 `workflow-now-title` / `workflow-history-title`, spec-given, and
// their siblings `workflow-now-subtitle` / `workflow-history-subtitle`, also
// spec-given \u2014 see workflow-now-pane.test.ts's matching happy-dom comment
// for the full rationale, repeated here only in brief):
//   `workflow-panes-card` (the one card), `workflow-now-band` (Now's raised
//   band, the element that actually carries `background:var(--bg-2)`, since
//   `background-color` is not an inherited CSS property \u2014 only the element
//   that declares it reads it back from `getComputedStyle`), `workflow-now-
//   header` / `workflow-history-header` (the header bar containers),
//   `workflow-now-dot` (the live dot, `data-live="true"|"false"`), and
//   `workflow-panes-divider` (the hatched divider).

// ── AC1 \u2014 the one split card, the header bars, the band background, the
// divider, and the pinned History header bar (desktop band) \u2500\u2500

Step("Now and History render inside one split card", async ({ page }) => {
  const card = page.getByTestId("workflow-panes-card");
  await expect(card).toBeVisible();
  const containment = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="workflow-panes-card"]');
    const now = document.querySelector('[data-testid="workflow-now"]');
    const history = document.querySelector('[data-testid="workflow-history"]');
    if (c === null || now === null || history === null) return null;
    return { containsNow: c.contains(now), containsHistory: c.contains(history) };
  });
  expect(containment).not.toBeNull();
  expect(containment!.containsNow, "workflow-panes-card does not contain workflow-now").toBe(
    true,
  );
  expect(
    containment!.containsHistory,
    "workflow-panes-card does not contain workflow-history",
  ).toBe(true);
});

Step(
  "the {string} header bar names {string} with the line {string}",
  async ({ page }, pane: string, name: string, line: string) => {
    const paneTestid = `workflow-${pane.toLowerCase()}`;
    const header = page.getByTestId(`${paneTestid}-header`);
    await expect(header).toBeVisible();

    const title = header.getByTestId(`${paneTestid}-title`);
    await expect(title).toHaveText(name);

    const subtitle = header.getByTestId(`${paneTestid}-subtitle`);
    // F24\u00b7B's literal wording (frame wins) \u2014 the middot is inside the
    // description's OWN text node (same decision as the happy-dom pin).
    await expect(subtitle).toHaveText(`\u00b7 ${line}`);
  },
);

Step("Now's band background differs from History's area background", async ({ page }) => {
  const colors = await page.evaluate(() => {
    const band = document.querySelector('[data-testid="workflow-now-band"]');
    const card = document.querySelector('[data-testid="workflow-panes-card"]');
    if (band === null || card === null) return null;
    return {
      band: getComputedStyle(band).backgroundColor,
      card: getComputedStyle(card).backgroundColor,
    };
  });
  expect(colors, "workflow-now-band or workflow-panes-card is missing").not.toBeNull();
  // Both painted \u2014 a difference against a transparent default would prove
  // nothing about the RAISED BAND the AC names.
  expect(colors!.band, "Now's band has no background color of its own").not.toBe(
    "rgba(0, 0, 0, 0)",
  );
  expect(colors!.card, "the split card has no background color of its own").not.toBe(
    "rgba(0, 0, 0, 0)",
  );
  expect(colors!.band, "Now's band reads the SAME background as the card's base").not.toBe(
    colors!.card,
  );
});

Step("a divider is visible between Now's box and History's header bar", async ({ page }) => {
  const divider = page.getByTestId("workflow-panes-divider");
  await expect(divider).toBeVisible();

  const nowBox = await page.getByTestId("workflow-now").boundingBox();
  const dividerBox = await divider.boundingBox();
  const historyHeaderBox = await page.getByTestId("workflow-history-header").boundingBox();
  expect(nowBox).not.toBeNull();
  expect(dividerBox).not.toBeNull();
  expect(historyHeaderBox).not.toBeNull();

  // BETWEEN \u2014 the divider's own band sits strictly beneath Now's box and
  // strictly above History's header bar (F24\u00b7B: "Now \u2026 a hatched divider
  // \u2026 History").
  expect(dividerBox!.y, "the divider does not sit below Now's box").toBeGreaterThanOrEqual(
    nowBox!.y + nowBox!.height,
  );
  expect(
    dividerBox!.y + dividerBox!.height,
    "the divider does not sit above History's header bar",
  ).toBeLessThanOrEqual(historyHeaderBox!.y + 1);
});

Step("History's header bar stays visible while its list scrolls", async ({ page }) => {
  const header = page.getByTestId("workflow-history-header");
  await expect(header).toBeVisible();
  const before = await header.boundingBox();
  expect(before).not.toBeNull();

  const history = page.getByTestId("workflow-history");
  await expect(history).toBeVisible();
  await history.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await history.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  await expect(header).toBeVisible();
  const after = await header.boundingBox();
  expect(after).not.toBeNull();
  // PINNED \u2014 the header bar does not move with History's own scroll (it
  // sits OUTSIDE History's scroll box, same discipline as the existing
  // title).
  expect(after!.y).toBe(before!.y);
});

// ── the live dot (settled ruling) \u2500\u2500

Step("the live dot in Now's header bar is lit", async ({ page }) => {
  const dot = page.getByTestId("workflow-now-dot");
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute("data-live", "true");
  const boxShadow = await dot.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(boxShadow, "the lit dot carries no glow (box-shadow) of its own").not.toBe("none");
});

Step("the live dot in Now's header bar is dim", async ({ page }) => {
  const dot = page.getByTestId("workflow-now-dot");
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute("data-live", "false");
  const boxShadow = await dot.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(boxShadow, "the dim dot still carries a glow (box-shadow)").toBe("none");
});

// ── AC2 \u2014 the phone band: neither a header bar nor a divider renders \u2500\u2500

Step("the Workflow tab shows no header bar above either pane", async ({ page }) => {
  await expect(page.getByTestId("workflow-now-header")).toHaveCount(0);
  await expect(page.getByTestId("workflow-history-header")).toHaveCount(0);
});

Step("no divider renders between Now and History", async ({ page }) => {
  await expect(page.getByTestId("workflow-panes-divider")).toHaveCount(0);
});

// AC2 — on the phone band the selected pane shows in the card's styling,
// the desktop card's contrast carried over: Now on the raised band
// (`--bg-2`), History on the card's base (`--bg-1`), each framed by the
// card's border (`--line`) and rounded corner. The card is the pane's box or
// its nearest framed ancestor inside the Workflow pane; the expected colours
// are resolved by the browser from the page's own tokens (a probe element),
// so the assertion compares the same computed form `getComputedStyle` returns.
const selectedPaneCard = async (page: Page, paneTestid: string, backgroundToken: string) =>
  page.evaluate(
    ({ paneSel, token }) => {
      const pane = document.querySelector(paneSel);
      const scroll = document.querySelector('[data-testid="pane-scroll"]');
      if (pane === null || scroll === null) return null;
      let card: Element | null = pane;
      // A framed box is one whose border is DRAWN: a declared style with a 0px
      // width frames nothing.
      while (card !== null && card !== scroll && parseFloat(getComputedStyle(card).borderTopWidth) === 0) {
        card = card.parentElement;
      }
      const probe = document.createElement("div");
      probe.style.backgroundColor = `var(${token})`;
      probe.style.borderTopColor = "var(--line)";
      document.body.appendChild(probe);
      const expected = {
        background: getComputedStyle(probe).backgroundColor,
        border: getComputedStyle(probe).borderTopColor,
      };
      probe.remove();
      if (card === null || card === scroll) return { framed: false, expected };
      const style = getComputedStyle(card);
      return {
        framed: true,
        expected,
        found: `${card.tagName.toLowerCase()}.${card.className} ${style.borderTopStyle} ${style.borderTopWidth}`,
        background: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: parseFloat(style.borderTopWidth),
        radius: parseFloat(style.borderTopLeftRadius),
      };
    },
    { paneSel: `[data-testid="${paneTestid}"]`, token: backgroundToken },
  );

const expectSelectedPaneCard = async (
  page: Page,
  pane: string,
  backgroundToken: string,
  surface: string,
) => {
  const paneTestid = `workflow-${pane.toLowerCase()}`;
  await expect(page.getByTestId("workflow-subtab").filter({ hasText: pane })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId(paneTestid)).toBeVisible();
  const card = await selectedPaneCard(page, paneTestid, backgroundToken);
  expect(card, `the ${pane} pane or the Workflow pane is missing`).not.toBeNull();
  expect(card!.framed, `the selected ${pane} pane is framed by no card border`).toBe(true);
  expect(card!.borderWidth, `the ${pane} card's border is not drawn: ${card!.found}`).toBeGreaterThanOrEqual(1);
  expect(card!.borderColor, `the ${pane} card's border is not the card's line`).toBe(
    card!.expected.border,
  );
  expect(card!.radius, `the ${pane} card has no rounded corner`).toBeGreaterThan(0);
  expect(card!.background, `the selected ${pane} pane is not on ${surface}`).toBe(
    card!.expected.background,
  );
};

Step("the selected Now pane shows as a card on the raised band", async ({ page }) => {
  await expectSelectedPaneCard(page, "Now", "--bg-2", "the raised band");
});

Step("the selected History pane shows as a card on the card's base", async ({ page }) => {
  await expectSelectedPaneCard(page, "History", "--bg-1", "the card's base");
});
