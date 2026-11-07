// run-card-keeps-a-long-agent-id-inside-it.feature — steps. A run card whose
// agent id is far wider than the card, with no break opportunity in it, cuts
// the id with an ellipsis inside the card, stays no wider than the pane that
// holds it, and keeps its ratio pill in view at its right edge without the
// feed being scrolled sideways.
//
// The card is the one the page draws for the run this scenario ingested (its
// `data-run-id`), found inside the pane the test opened (pane-mount.ts's
// `mountedPaneScroll`, by the tab navigation recorded in `world`). The card is
// brought into view by moving the pane VERTICALLY only: nothing here ever
// scrolls a box sideways, so every reading is the one a user sees on arrival.
// Every measurement is read in one browser turn and returned as numbers and
// short strings only: a failure names the figures, never a node.
//
// Reuses pane-scroll.steps.ts (the viewport, "no pane scrolls horizontally"),
// seeding.steps.ts (the project), navigation.steps.ts and workflow.steps.ts
// (opening home, the workspace and its Runs tab) and harness.ts's parsed-run
// ingest.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step, type World } from "./world.ts";
import { ingestParsed } from "./harness.ts";
import { mountedPaneScroll, recordedPaneTab } from "./pane-mount.ts";

/** Sub-pixel slack only. */
const TOL = 0.5;

/**
 * An agent id of exactly `length` characters made of letters and digits only
 * (no space, hyphen or slash: no break opportunity anywhere in it), unique to
 * the scenario's project (by its key) so no two scenarios share an agent.
 */
function unbreakableAgentId(projectKey: string, length: number): string {
  const slug = projectKey.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `widerunagentid${slug}`.padEnd(length, "x").slice(0, length);
}

Step(
  "a passing run whose agent id is a {int}-character word with no break in it is ingested on that project",
  async ({ request, world }, length: number) => {
    const projectKey = world.projectKey;
    if (typeof projectKey !== "string") throw new Error("no project was registered in this scenario");
    const agentId = unbreakableAgentId(projectKey, length);
    expect(agentId.length, "the agent id has the length the scenario names").toBe(length);
    const res = await ingestParsed(request, projectKey, agentId, {
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      duration_ms: 5,
    });
    world.eventId = res.event;
    world.wideAgentId = agentId;
  },
);

/**
 * The run card this scenario ingested, inside the pane the test opened,
 * brought into the pane's view by a vertical scroll only.
 */
async function runCard(page: Page, world: World): Promise<{ pane: Locator; card: Locator }> {
  const eventId = world.eventId;
  if (typeof eventId !== "string") throw new Error("no run was ingested in this scenario");
  const pane = await mountedPaneScroll(page, recordedPaneTab(world));
  const card = pane.locator(`[data-testid="event-card"][data-run-id="${eventId}"]`);
  await expect(card, "the pane draws the ingested run card once").toHaveCount(1, { timeout: 10_000 });
  await card.evaluate((el) => {
    const scroller = el.closest('[data-testid="pane-scroll"]');
    if (!(scroller instanceof HTMLElement)) throw new Error("the run card is not inside a pane-scroll box");
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += top - 16;
  });
  // A row skips its layout while off screen: let the browser lay it out in
  // view before anything inside it is measured.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(card.getByTestId("ratio-pill")).toBeVisible();
  return { pane, card };
}

interface CardReading {
  idText: string;
  idWhiteSpace: string;
  idOverflowX: string;
  idTextOverflow: string;
  idScrollWidth: number;
  idClientWidth: number;
  idLeft: number;
  idRight: number;
  pillLeft: number;
  pillRight: number;
  pillTop: number;
  pillBottom: number;
  cardLeft: number;
  cardRight: number;
  cardWidth: number;
  paneWidth: number;
  paneLeft: number;
  paneVisibleRight: number;
  paneTop: number;
  paneVisibleBottom: number;
  paneScrollLeft: number;
  pageScrollX: number;
  viewportWidth: number;
  viewportHeight: number;
}

async function readCard(card: Locator): Promise<CardReading> {
  return card.evaluate((cardEl) => {
    const id = cardEl.querySelector(".app-agent-id");
    const pill = cardEl.querySelector('[data-testid="ratio-pill"]');
    const pane = cardEl.closest('[data-testid="pane-scroll"]');
    if (!(id instanceof HTMLElement)) throw new Error("the run card draws no agent id");
    if (!(pill instanceof HTMLElement)) throw new Error("the run card draws no ratio pill");
    if (!(pane instanceof HTMLElement)) throw new Error("the run card is not inside a pane-scroll box");
    const cs = getComputedStyle(id);
    const idRect = id.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const cardLeft = cardRect.left + cardEl.clientLeft;
    const paneLeft = paneRect.left + pane.clientLeft;
    const paneTop = paneRect.top + pane.clientTop;
    return {
      idText: id.textContent ?? "",
      idWhiteSpace: cs.whiteSpace,
      idOverflowX: cs.overflowX,
      idTextOverflow: cs.textOverflow,
      idScrollWidth: id.scrollWidth,
      idClientWidth: id.clientWidth,
      idLeft: idRect.left,
      idRight: idRect.right,
      pillLeft: pillRect.left,
      pillRight: pillRect.right,
      pillTop: pillRect.top,
      pillBottom: pillRect.bottom,
      cardLeft,
      cardRight: cardLeft + cardEl.clientWidth,
      cardWidth: cardRect.width,
      paneWidth: pane.clientWidth,
      paneLeft,
      paneVisibleRight: paneLeft + pane.clientWidth,
      paneTop,
      paneVisibleBottom: paneTop + pane.clientHeight,
      paneScrollLeft: pane.scrollLeft,
      pageScrollX: window.scrollX,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
}

Step("that run card is no wider than its pane", async ({ page, world }) => {
  const { card } = await runCard(page, world);
  const r = await readCard(card);
  expect(r.paneWidth, "the pane has a width").toBeGreaterThan(0);
  expect(
    r.cardWidth,
    `the run card (${String(r.cardWidth)}px) is no wider than its pane (${String(r.paneWidth)}px)`,
  ).toBeLessThanOrEqual(r.paneWidth + TOL);
});

Step("that run card's agent id ends in an ellipsis inside the card", async ({ page, world }) => {
  const { card } = await runCard(page, world);
  const agentId = world.wideAgentId;
  if (typeof agentId !== "string") throw new Error("no agent id was recorded in this scenario");
  const r = await readCard(card);
  expect(r.idText, "the card's text still holds the whole agent id").toBe(agentId);
  expect(r.idTextOverflow, "the agent id's text-overflow").toBe("ellipsis");
  expect(r.idWhiteSpace, "the agent id's white-space").toBe("nowrap");
  expect(r.idOverflowX, "the agent id clips what overflows it").not.toBe("visible");
  expect(
    r.idScrollWidth,
    `the id must overflow its box for its ellipsis to be drawn, but the box grew to hold it (scrollWidth ${String(r.idScrollWidth)}, clientWidth ${String(r.idClientWidth)})`,
  ).toBeGreaterThan(r.idClientWidth);
  expect(r.idLeft, "the agent id starts inside the card").toBeGreaterThanOrEqual(r.cardLeft - TOL);
  expect(
    r.idRight,
    `the agent id (right edge ${String(r.idRight)}px) ends inside the card (right edge ${String(r.cardRight)}px)`,
  ).toBeLessThanOrEqual(r.cardRight + TOL);
  expect(
    r.idRight,
    `the agent id (right edge ${String(r.idRight)}px) ends before the ratio pill starts (${String(r.pillLeft)}px)`,
  ).toBeLessThanOrEqual(r.pillLeft + TOL);
});

Step(
  "that run card's ratio pill is wholly inside the card and the viewport without scrolling sideways",
  async ({ page, world }) => {
    const { card } = await runCard(page, world);
    const r = await readCard(card);
    // Nothing has scrolled sideways: the pane and the page sit at their
    // starting horizontal position, as a user arriving at the feed sees them.
    expect(r.paneScrollLeft, "the pane is not scrolled sideways").toBe(0);
    expect(r.pageScrollX, "the page is not scrolled sideways").toBe(0);
    expect(r.pillLeft, "the ratio pill starts inside the card").toBeGreaterThanOrEqual(r.cardLeft - TOL);
    expect(
      r.pillRight,
      `the ratio pill (right edge ${String(r.pillRight)}px) ends inside the card (right edge ${String(r.cardRight)}px)`,
    ).toBeLessThanOrEqual(r.cardRight + TOL);
    expect(r.pillLeft, "the ratio pill starts inside the viewport").toBeGreaterThanOrEqual(-TOL);
    expect(
      r.pillRight,
      `the ratio pill (right edge ${String(r.pillRight)}px) ends inside the viewport (${String(r.viewportWidth)}px wide)`,
    ).toBeLessThanOrEqual(r.viewportWidth + TOL);
    expect(
      r.pillRight,
      `the ratio pill (right edge ${String(r.pillRight)}px) ends inside the pane's visible box (right edge ${String(r.paneVisibleRight)}px)`,
    ).toBeLessThanOrEqual(r.paneVisibleRight + TOL);
    expect(r.pillLeft, "the ratio pill starts inside the pane's visible box").toBeGreaterThanOrEqual(
      r.paneLeft - TOL,
    );
    expect(r.pillTop, "the ratio pill is inside the pane's visible box vertically").toBeGreaterThanOrEqual(
      r.paneTop - TOL,
    );
    expect(r.pillBottom, "the ratio pill is inside the viewport vertically").toBeLessThanOrEqual(
      Math.min(r.paneVisibleBottom, r.viewportHeight) + TOL,
    );
  },
);
