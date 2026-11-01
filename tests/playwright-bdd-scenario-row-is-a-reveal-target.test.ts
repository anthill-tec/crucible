// A `playwright-bdd` run's scenario row is a reveal target: the heat-strip
// reveal and the header's failure jump reach it, exactly as they reach a leaf
// row of any other run.
//
// HARNESS — a real board (`startServer` through `bootOn`, port 0, ":memory:")
// holding a streamed `playwright-bdd` run, and the production shell mounted
// against it in happy-dom (tests/helpers/served-app.ts). Tier `e2e`, so the
// run detail draws in Density, with its heat strip.
//
// What this file pins:
//   - every scenario row of the scenario shape carries `data-suite-key` (the
//     key of the feature-and-browser suite it belongs to, the one its heat
//     cells are titled by) and `data-leaf-key` = `<suiteKey>::<scenario name>`;
//   - a heat-cell click on a failing scenario blinks that scenario's row
//     (`app-locate-blink`) and scrolls to it;
//   - the header's failure jump (`failure-jump`) scrolls to a failing
//     scenario's row, and a second jump moves to the other failing scenario.
//
// INTERFACE CHOICES: the scenario row stays a `[data-testid="suite-row"]` (the
// spec view's existing testid) and gains both keys; a heat cell is found by its
// title's ` › <scenario name>` tail and its status class, so no assertion here
// pins how a suite key is spelled — only that the row and the strip agree.
//
// SAFETY: every server binds port 0 on ":memory:".
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import {
  bddProject,
  failingStep,
  heatCellsOf,
  interceptScrollIntoView,
  overlay,
  passingStep,
  scenarioRow,
  streamBddRun,
  waitUntil,
  type BddScenario,
} from "./helpers/playwright-bdd-run.ts";
import { bootOn } from "./helpers/run-stream-harness.ts";
import { mountServedApp, restoreRealFetch, settleServedApp } from "./helpers/served-app.ts";

const handles: ServerHandle[] = [];

afterEach(async () => {
  await restoreRealFetch();
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const LOCATE_BLINK = "app-locate-blink";
const RECEIPT_MISSING = "receipt missing";
const SEED_MISSING = "Before hook failed: seed data missing";
const CARD_STEPS = ["Given a cart holding one book", "When I pay by card", "Then I see a receipt"];

/** Checkout run in two projects (failing at a step in firefox), Search failing
 *  in its Before hook, and a green feature. */
function revealRun(): BddScenario[] {
  return [
    {
      feature: "Wishlist",
      browser: "chromium",
      name: "Save a book for later",
      status: "pass",
      steps: ["Given a book page", "When I save it", "Then it is on my wishlist"].map(passingStep),
    },
    { feature: "Checkout", browser: "chromium", name: "Pay by card", status: "pass", steps: CARD_STEPS.map(passingStep) },
    {
      feature: "Checkout",
      browser: "firefox",
      name: "Pay by card",
      status: "fail",
      steps: [passingStep(CARD_STEPS[0] ?? ""), passingStep(CARD_STEPS[1] ?? ""), failingStep(CARD_STEPS[2] ?? "", RECEIPT_MISSING)],
      failure: { message: RECEIPT_MISSING },
    },
    {
      feature: "Checkout",
      browser: "chromium",
      name: "Pay by voucher",
      status: "pass",
      steps: ["Given a voucher worth ten", "When I redeem it"].map(passingStep),
    },
    {
      feature: "Search",
      browser: "chromium",
      name: "Find a book by title",
      status: "fail",
      steps: [],
      failure: { message: SEED_MISSING },
    },
  ];
}

async function openRevealRun(name: string): Promise<void> {
  const handle = boot();
  const key = await bddProject(handle, name);
  const eventId = await streamBddRun(handle, key, revealRun(), "e2e");
  await mountServedApp(handle, `/p/${key}/run/${eventId}`);
}

/** The suite key a heat cell of `name` is titled by: its title without ` › <name>`. */
function suiteKeyOfCell(cell: HTMLElement, name: string): string {
  const title = cell.getAttribute("title") ?? "";
  return title.slice(0, title.length - ` › ${name}`.length);
}

function onlyCell(name: string, status: "fail" | "pass"): HTMLElement {
  const cells = heatCellsOf(name, status);
  expect(cells.length, `one ${status} heat cell of "${name}"`).toBe(1);
  const [cell] = cells;
  if (cell === undefined) throw new Error(`no ${status} heat cell of "${name}"`);
  return cell;
}

describe("a scenario row carries its suite key and its leaf key", () => {
  test("each scenario row's data-leaf-key is <data-suite-key>::<scenario name>, and its data-suite-key is the suite key its heat cell is titled by", async () => {
    await openRevealRun("scenario-row-keys");

    const firefoxCard = scenarioRow("Checkout", "Pay by card", "firefox");
    const chromiumCard = scenarioRow("Checkout", "Pay by card", "chromium");
    const voucher = scenarioRow("Checkout", "Pay by voucher", "chromium");
    const hook = scenarioRow("Search", "Find a book by title");

    const firefoxKey = suiteKeyOfCell(onlyCell("Pay by card", "fail"), "Pay by card");
    const hookKey = suiteKeyOfCell(onlyCell("Find a book by title", "fail"), "Find a book by title");

    // POSITIVE — the row and the strip name the same suite.
    expect(firefoxCard.getAttribute("data-suite-key")).toBe(firefoxKey);
    expect(firefoxCard.getAttribute("data-leaf-key")).toBe(`${firefoxKey}::Pay by card`);
    expect(hook.getAttribute("data-suite-key")).toBe(hookKey);
    expect(hook.getAttribute("data-leaf-key")).toBe(`${hookKey}::Find a book by title`);

    // Every scenario row carries both keys, its leaf key built from its own suite key.
    for (const [row, name] of [
      [chromiumCard, "Pay by card"],
      [voucher, "Pay by voucher"],
    ] as const) {
      const suiteKey = row.getAttribute("data-suite-key");
      expect(suiteKey, `data-suite-key on "${name}"`).not.toBeNull();
      expect(row.getAttribute("data-leaf-key")).toBe(`${suiteKey ?? ""}::${name}`);
    }

    // NEGATIVE — one scenario under two browsers is two reveal targets.
    expect(chromiumCard.getAttribute("data-suite-key")).not.toBe(firefoxCard.getAttribute("data-suite-key"));
    expect(chromiumCard.getAttribute("data-leaf-key")).not.toBe(firefoxCard.getAttribute("data-leaf-key"));
    // BOUND — a leaf key names exactly one row in the whole run detail.
    const sameKey = overlay().querySelectorAll(`[data-leaf-key="${firefoxKey}::Pay by card"]`);
    expect(sameKey.length).toBe(1);
  });
});

describe("the heat-strip reveal reaches a scenario row", () => {
  test("clicking a failing scenario's heat cell scrolls to that scenario's row and blinks it, and blinks no other scenario row", async () => {
    await openRevealRun("scenario-row-heat-reveal");
    const cell = onlyCell("Pay by card", "fail");

    const scroll = interceptScrollIntoView();
    try {
      cell.click();
      await settleServedApp();
      const row = (): HTMLElement => scenarioRow("Checkout", "Pay by card", "firefox");
      await waitUntil(() => row().classList.contains(LOCATE_BLINK) && scroll.calls.includes(row()));

      expect(row().classList.contains(LOCATE_BLINK)).toBe(true);
      expect(scroll.calls).toContain(row());
      // NEGATIVE — the same scenario's chromium row, and the other failing
      // scenario, are not the target.
      expect(scenarioRow("Checkout", "Pay by card", "chromium").classList.contains(LOCATE_BLINK)).toBe(false);
      expect(scenarioRow("Search", "Find a book by title").classList.contains(LOCATE_BLINK)).toBe(false);
    } finally {
      scroll.restore();
    }
  });

  test("clicking a hook-failed scenario's heat cell scrolls to and blinks its row", async () => {
    await openRevealRun("scenario-row-heat-reveal-hook");
    const cell = onlyCell("Find a book by title", "fail");

    const scroll = interceptScrollIntoView();
    try {
      cell.click();
      await settleServedApp();
      const row = (): HTMLElement => scenarioRow("Search", "Find a book by title");
      await waitUntil(() => row().classList.contains(LOCATE_BLINK) && scroll.calls.includes(row()));

      expect(row().classList.contains(LOCATE_BLINK)).toBe(true);
      expect(scroll.calls).toContain(row());
      expect(scenarioRow("Checkout", "Pay by card", "firefox").classList.contains(LOCATE_BLINK)).toBe(false);
    } finally {
      scroll.restore();
    }
  });
});

describe("the header's failure jump reaches a scenario row", () => {
  test("each jump scrolls to a failing scenario's row, and two jumps visit the two failing scenarios", async () => {
    await openRevealRun("scenario-row-failure-jump");
    const failingRows = (): HTMLElement[] => [
      scenarioRow("Checkout", "Pay by card", "firefox"),
      scenarioRow("Search", "Find a book by title"),
    ];
    const failingKeys = (): Array<string | null> => failingRows().map((r) => r.getAttribute("data-leaf-key"));
    const jump = document.querySelector<HTMLElement>('[data-testid="failure-jump"]');
    expect(jump).not.toBeNull();

    const scroll = interceptScrollIntoView();
    try {
      const reached: Array<string | null> = [];
      for (let i = 0; i < 2; i++) {
        const before = scroll.calls.length;
        jump?.click();
        await settleServedApp();
        await waitUntil(() =>
          scroll.calls.slice(before).some((el) => el.getAttribute("data-testid") === "suite-row"),
        );
        const target = scroll.calls.slice(before).find((el) => el.getAttribute("data-testid") === "suite-row");
        expect(target, `jump ${i + 1} scrolled to no scenario row`).toBeDefined();
        // The row scrolled to is a failing scenario's own row, mounted now.
        expect(failingRows()).toContain(target as HTMLElement);
        reached.push(target?.getAttribute("data-leaf-key") ?? null);
      }

      // POSITIVE — both failing scenarios, once each; NEGATIVE — no keyless row.
      expect(reached).not.toContain(null);
      expect(reached.length).toBe(2);
      expect(new Set(reached)).toEqual(new Set(failingKeys()));
    } finally {
      scroll.restore();
    }
  });
});
