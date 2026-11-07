// compile-card-keeps-its-diagnostic-line-inside-it.feature — steps. A compile
// card's diagnostic preview line holding a message far longer than the card
// is wide stays one line, ends in an ellipsis inside the card, and leaves the
// card no wider than the pane that holds it.
//
// The card is the one the page draws for the compile report this scenario
// ingested (its `data-run-id`), found inside the pane the test opened
// (pane-mount.ts's `mountedPaneScroll`, by the tab navigation recorded in
// `world`). Every measurement is read in one browser turn and returned as
// numbers and short strings only: a failure names the figures, never a node.
//
// Reuses pane-scroll.steps.ts (the viewport, "no pane scrolls horizontally"),
// seeding.steps.ts (the project), navigation.steps.ts and workflow.steps.ts
// (opening home, the workspace and its Runs tab) and harness.ts's compile
// ingest.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step, type World } from "./world.ts";
import { ingestCompile } from "./harness.ts";
import { mountedPaneScroll, recordedPaneTab } from "./pane-mount.ts";

/** Sub-pixel slack only. */
const TOL = 0.5;

/**
 * A compiler message of exactly `length` characters, worded as a real one
 * (spaces included: the line is kept to one line by its style, not by the
 * text having no break point).
 */
function longMessage(length: number): string {
  const words =
    "mismatched types expected struct `std::collections::HashMap<String, Vec<u8>>` found enum " +
    "`core::option::Option<std::sync::Arc<tokio::sync::RwLock<std::collections::BTreeMap<u64, String>>>>` ";
  let message = "";
  while (message.length < length) message += words;
  return message.slice(0, length).trimEnd().padEnd(length, "x");
}

Step(
  "a compile report whose first error carries a {int}-character message is ingested for agent {string}",
  async ({ request, world }, length: number, agentId: string) => {
    const message = longMessage(length);
    const errors = [`error[E0308]: ${message}`, " --> src/lib.rs:12:5"].join("\n");
    const res = await ingestCompile(request, world.projectKey as string, agentId, errors, "rustc");
    world.eventId = res.event;
    world.diagMessage = message;
  },
);

/** The compile card this scenario ingested, inside the pane the test opened. */
async function compileCard(page: Page, world: World): Promise<{ pane: Locator; card: Locator }> {
  const eventId = world.eventId;
  if (typeof eventId !== "string") throw new Error("no compile report was ingested in this scenario");
  const pane = await mountedPaneScroll(page, recordedPaneTab(world));
  const card = pane.locator(`[data-testid="event-card"][data-run-id="${eventId}"]`);
  await expect(card, "the pane draws the ingested compile card once").toHaveCount(1, { timeout: 10_000 });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId("diag-line").first()).toBeVisible();
  return { pane, card };
}

interface LineReading {
  text: string;
  lineCount: number;
  whiteSpace: string;
  overflowX: string;
  textOverflow: string;
  scrollWidth: number;
  clientWidth: number;
  lineLeft: number;
  lineRight: number;
  cardLeft: number;
  cardRight: number;
}

async function readLine(card: Locator): Promise<LineReading> {
  return card.getByTestId("diag-line").first().evaluate((line) => {
    const cardEl = line.closest('[data-testid="event-card"]');
    if (cardEl === null) throw new Error("the diagnostic line is not inside an event card");
    const cs = getComputedStyle(line);
    const lineRect = line.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const cardLeft = cardRect.left + cardEl.clientLeft;
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    return {
      text: line.textContent ?? "",
      lineCount: Math.round(lineRect.height / lineHeight),
      whiteSpace: cs.whiteSpace,
      overflowX: cs.overflowX,
      textOverflow: cs.textOverflow,
      scrollWidth: line.scrollWidth,
      clientWidth: line.clientWidth,
      lineLeft: lineRect.left,
      lineRight: lineRect.right,
      cardLeft,
      cardRight: cardLeft + cardEl.clientWidth,
    };
  });
}

Step("that compile card's first diagnostic line holds the whole message on one line", async ({ page, world }) => {
  const { card } = await compileCard(page, world);
  const message = world.diagMessage;
  if (typeof message !== "string") throw new Error("no compile message was recorded in this scenario");
  const r = await readLine(card);
  expect(r.text.includes(message), `the diagnostic line's text holds the whole ${String(message.length)}-character message`).toBe(
    true,
  );
  expect(r.lineCount, "the diagnostic line is drawn on one line").toBe(1);
});

Step("that compile card's first diagnostic line ends in an ellipsis inside the card", async ({ page, world }) => {
  const { card } = await compileCard(page, world);
  const r = await readLine(card);
  expect(r.textOverflow, "the diagnostic line's text-overflow").toBe("ellipsis");
  expect(r.whiteSpace, "the diagnostic line's white-space").toBe("nowrap");
  expect(r.overflowX, "the diagnostic line clips what overflows it").not.toBe("visible");
  expect(
    r.scrollWidth,
    `the message must overflow the line's box for its ellipsis to be drawn, but the line grew to hold it (scrollWidth ${String(r.scrollWidth)}, clientWidth ${String(r.clientWidth)})`,
  ).toBeGreaterThan(r.clientWidth);
  expect(r.lineLeft, "the diagnostic line starts inside the card").toBeGreaterThanOrEqual(r.cardLeft - TOL);
  expect(r.lineRight, "the diagnostic line ends inside the card").toBeLessThanOrEqual(r.cardRight + TOL);
});

Step("that compile card is no wider than its pane", async ({ page, world }) => {
  const { pane, card } = await compileCard(page, world);
  const paneWidth = await pane.evaluate((el) => (el as HTMLElement).clientWidth);
  const cardWidth = await card.evaluate((el) => el.getBoundingClientRect().width);
  expect(paneWidth, "the pane has a width").toBeGreaterThan(0);
  expect(cardWidth, `the compile card (${String(cardWidth)}px) is no wider than its pane (${String(paneWidth)}px)`).toBeLessThanOrEqual(
    paneWidth + TOL,
  );
});
