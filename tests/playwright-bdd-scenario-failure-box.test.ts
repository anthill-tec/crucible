// A `playwright-bdd` scenario that failed with no failing step (a Before hook)
// shows its failure in a box that follows the shipped failure-box rules a leaf
// row's box follows (`LeafRows`, public/app.js):
//   - the one-box focus model (`failureBoxVisible`): once a failure is
//     focused — a leaf or scenario row clicked, a heat cell clicked — only the
//     focused failure's box shows; another scenario's box closes;
//   - the degradation: a failure with no message reads its type, else
//     `test failed`, and then carries the dim note
//     "no failure detail captured by the reporter"; a failure with a message
//     carries no note.
//
// HARNESS — a real board (`bootOn`, port 0, ":memory:") holding a streamed
// `playwright-bdd` run, the production shell mounted against it in happy-dom
// (tests/helpers/served-app.ts).
//
// INTERFACE CHOICES:
//   - a scenario's own box is a `[data-testid="failure-box"]` in the
//     scenario's group (or on its row) and inside no step row
//     (`ownFailureBoxes`);
//   - clicking a scenario row focuses that scenario, as clicking a leaf row
//     focuses its leaf;
//   - the Detail cases run at tier `integration`; the heat-cell case runs at
//     tier `e2e` (Density, where the heat strip draws). Nothing here asserts
//     what a Density scenario box shows before any focus.
//
// SAFETY: every server binds port 0 on ":memory:".
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import {
  bddProject,
  failingStep,
  heatCellsOf,
  ownFailureBoxes,
  passingStep,
  scenarioRow,
  streamBddRun,
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

const NO_DETAIL_NOTE = "no failure detail captured by the reporter";
const SEED_MISSING = "Before hook failed: seed data missing";
const INDEX_DOWN = "Before hook failed: search index unreachable";
const AUTHOR_UNKNOWN = "no author by that name";

const SEARCH = "Search";
const BY_TITLE = "Find a book by title";
const BY_ISBN = "Find a book by ISBN";
const BY_AUTHOR = "Find a book by author";
const AUTHOR_STEP = "Then I see the author's books";

/** Search: two scenarios failing in their Before hook (each with a message),
 *  and one failing at a step. */
function focusRun(): BddScenario[] {
  return [
    { feature: SEARCH, browser: "chromium", name: BY_TITLE, status: "fail", steps: [], failure: { message: SEED_MISSING } },
    { feature: SEARCH, browser: "chromium", name: BY_ISBN, status: "fail", steps: [], failure: { message: INDEX_DOWN } },
    {
      feature: SEARCH,
      browser: "chromium",
      name: BY_AUTHOR,
      status: "fail",
      steps: [passingStep("Given an author's name"), failingStep(AUTHOR_STEP, AUTHOR_UNKNOWN)],
      failure: { message: AUTHOR_UNKNOWN },
    },
  ];
}

const PROFILE = "Profile";
const NO_FAILURE = "Upload an avatar";
const TYPE_ONLY = "Rename my account";
const WITH_MESSAGE = "Change my email";

/** Profile: hook-failed scenarios stated with no failure, a type-only one, and
 *  one with a message. */
function degradeRun(): BddScenario[] {
  return [
    { feature: PROFILE, browser: "chromium", name: NO_FAILURE, status: "fail", steps: [] },
    { feature: PROFILE, browser: "chromium", name: TYPE_ONLY, status: "fail", steps: [], failure: { type: "TimeoutError" } },
    { feature: PROFILE, browser: "chromium", name: WITH_MESSAGE, status: "fail", steps: [], failure: { message: "mail server refused" } },
  ];
}

async function openRun(name: string, scenarios: BddScenario[], tier: string): Promise<void> {
  const handle = boot();
  const key = await bddProject(handle, name);
  const eventId = await streamBddRun(handle, key, scenarios, tier);
  await mountServedApp(handle, `/p/${key}/run/${eventId}`);
}

function ownBoxText(feature: string, name: string): string[] {
  return ownFailureBoxes(scenarioRow(feature, name)).map((box) => (box.textContent ?? "").trim());
}

function stepRow(scenario: HTMLElement, step: string): HTMLElement {
  const rows = Array.from(scenario.parentElement?.querySelectorAll<HTMLElement>('[data-testid="leaf-row"]') ?? []);
  const found = rows.find((r) => (r.textContent ?? "").includes(step));
  if (found === undefined) throw new Error(`no step row "${step}"`);
  return found;
}

function onlyFailCell(name: string): HTMLElement {
  const cells = heatCellsOf(name, "fail");
  expect(cells.length, `one failing heat cell of "${name}"`).toBe(1);
  const [cell] = cells;
  if (cell === undefined) throw new Error(`no failing heat cell of "${name}"`);
  return cell;
}

describe("a hook-failed scenario's failure box degrades as a leaf's box does", () => {
  test("a scenario failing with no failure object reads `test failed` and the reporter note, and draws no trace", async () => {
    await openRun("scenario-box-no-failure", degradeRun(), "integration");

    const texts = ownBoxText(PROFILE, NO_FAILURE);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("test failed");
    expect(texts[0]).toContain(NO_DETAIL_NOTE);
    const [box] = ownFailureBoxes(scenarioRow(PROFILE, NO_FAILURE));
    expect(box?.querySelector(".app-failure-trace")).toBeNull();
    expect(texts[0]).not.toContain("undefined");
  });

  test("a scenario failing with only a type reads the type and the reporter note", async () => {
    await openRun("scenario-box-type-only", degradeRun(), "integration");

    const texts = ownBoxText(PROFILE, TYPE_ONLY);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("TimeoutError");
    expect(texts[0]).toContain(NO_DETAIL_NOTE);
    // NEGATIVE — a type is detail of a kind: it is shown, not replaced.
    expect(texts[0]).not.toContain("test failed");
  });

  test("a scenario failing with a message reads it and carries no reporter note", async () => {
    await openRun("scenario-box-with-message", degradeRun(), "integration");

    const texts = ownBoxText(PROFILE, WITH_MESSAGE);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("mail server refused");
    expect(texts[0]).not.toContain(NO_DETAIL_NOTE);
  });
});

describe("a hook-failed scenario's failure box follows the one-box focus model", () => {
  test("in Detail, focusing a failing step closes every hook-failed scenario's box, and focusing a scenario opens its box alone", async () => {
    await openRun("scenario-box-focus-detail", focusRun(), "integration");

    // Before any focus, Detail shows every failure inline.
    expect(ownBoxText(SEARCH, BY_TITLE)).toEqual([expect.stringContaining(SEED_MISSING)]);
    expect(ownBoxText(SEARCH, BY_ISBN)).toEqual([expect.stringContaining(INDEX_DOWN)]);

    // Focus the failing step of another scenario.
    stepRow(scenarioRow(SEARCH, BY_AUTHOR), AUTHOR_STEP).click();
    await settleServedApp();
    expect(ownBoxText(SEARCH, BY_TITLE)).toEqual([]);
    expect(ownBoxText(SEARCH, BY_ISBN)).toEqual([]);

    // Focus the first hook-failed scenario: its box alone opens.
    scenarioRow(SEARCH, BY_TITLE).click();
    await settleServedApp();
    expect(ownBoxText(SEARCH, BY_TITLE)).toEqual([expect.stringContaining(SEED_MISSING)]);
    expect(ownBoxText(SEARCH, BY_ISBN)).toEqual([]);

    // Focus the second: the box moves, it never accumulates.
    scenarioRow(SEARCH, BY_ISBN).click();
    await settleServedApp();
    expect(ownBoxText(SEARCH, BY_ISBN)).toEqual([expect.stringContaining(INDEX_DOWN)]);
    expect(ownBoxText(SEARCH, BY_TITLE)).toEqual([]);
  });

  test("in Density, a heat-cell click focuses its scenario: the clicked hook-failed scenario's box shows, the other's does not", async () => {
    await openRun("scenario-box-focus-density", focusRun(), "e2e");

    onlyFailCell(BY_TITLE).click();
    await settleServedApp();
    expect(ownBoxText(SEARCH, BY_TITLE)).toEqual([expect.stringContaining(SEED_MISSING)]);
    expect(ownBoxText(SEARCH, BY_ISBN)).toEqual([]);

    onlyFailCell(BY_ISBN).click();
    await settleServedApp();
    expect(ownBoxText(SEARCH, BY_ISBN)).toEqual([expect.stringContaining(INDEX_DOWN)]);
    expect(ownBoxText(SEARCH, BY_TITLE)).toEqual([]);

    // A step-failed scenario's cell moves the focus off both hook boxes.
    onlyFailCell(BY_AUTHOR).click();
    await settleServedApp();
    expect(ownBoxText(SEARCH, BY_TITLE)).toEqual([]);
    expect(ownBoxText(SEARCH, BY_ISBN)).toEqual([]);
  });
});
