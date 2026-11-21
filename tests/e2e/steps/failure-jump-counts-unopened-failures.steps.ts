// failure-jump-counts-unopened-failures.feature — steps. The run detail's
// failure jump (`[data-testid="failure-jump"]`) counts the failures the walk
// has not yet opened and walks them from the first; after each press exactly
// one failure box is open, on the failing leaf the label's place names.
//
// Every assertion reads the REAL served SPA against a REAL ingested JUnit
// run: the walk order is fixed by the fixture (failing suites in tree order,
// their failing leaves in order), and the open box is identified by its
// leaf row's `data-leaf-key` (`<suite>::<leaf>`), the same identity the jump
// targets.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { ingestJunit } from "./harness.ts";

/** The failing leaves in walk order — tree order of the failing suites, then
 *  each suite's failing leaves in order. FJ-Beta is all-pass and between
 *  them, so the walk must skip it. */
const WALK_ORDER = ["FJ-alpha-1", "FJ-alpha-2", "FJ-gamma-3"] as const;

function junitThreeFailuresAcrossTwoSuites(): string {
  const failing = (name: string): string =>
    `<testcase name="${name}" time="0.01"><failure message="${name} failed">${name} trace</failure></testcase>`;
  const passing = (name: string): string => `<testcase name="${name}" time="0.01"/>`;
  return [
    "<testsuites>",
    '<testsuite name="FJ-Alpha" tests="3" failures="2">',
    failing("FJ-alpha-1"),
    passing("FJ-alpha-ok"),
    failing("FJ-alpha-2"),
    "</testsuite>",
    '<testsuite name="FJ-Beta" tests="1">',
    passing("FJ-beta-ok"),
    "</testsuite>",
    '<testsuite name="FJ-Gamma" tests="1" failures="1">',
    failing("FJ-gamma-3"),
    "</testsuite>",
    "</testsuites>",
  ].join("\n");
}

Step(
  "a run with three failing leaves across two failing suites is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestJunit(request, world.projectKey as string, agentId, junitThreeFailuresAcrossTwoSuites(), "unit");
    world.eventId = res.event;
  },
);

/** The VISIBLE failure jump. On the cold `/run/<id>` route the visible header
 *  is the pinned band above the pane; the copy inside `run-overlay` is the
 *  hidden compat head. Both share one body state. */
function visibleJump(page: Page): Locator {
  return page.getByTestId("failure-jump").filter({ visible: true });
}

function failureBoxes(page: Page): Locator {
  return page.getByTestId("run-overlay").getByTestId("failure-box");
}

/** The leaf keys whose failure box is open in the run detail, in DOM order. */
async function openBoxLeafKeys(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="run-overlay"] [data-testid="failure-box"]')).map((box) => {
      const row = box.previousElementSibling;
      return row instanceof HTMLElement ? row.getAttribute("data-leaf-key") : null;
    }),
  );
}

/** The 1-based walk-order place a jump label names: "▸ failure k of N" names
 *  k; "▸ r more failure(s)" means the walk has opened N − r failures, the
 *  last of them the open one. Null for any other text. */
function placeNamedBy(label: string, total: number): number | null {
  const of = /^▸ failure (\d+) of (\d+)$/.exec(label);
  if (of !== null) return Number(of[1]);
  const more = /^▸ (\d+) more failures?$/.exec(label);
  if (more !== null) return total - Number(more[1]);
  return null;
}

Step("the failure jump reads {string}", async ({ page }, label: string) => {
  await expect(visibleJump(page)).toHaveCount(1);
  await expect(visibleJump(page)).toHaveText(label);
});

Step("no failure box is open in the run detail", async ({ page }) => {
  await expect(failureBoxes(page)).toHaveCount(0);
});

Step("I press the failure jump", async ({ page }) => {
  await visibleJump(page).click();
});

Step(
  "exactly one failure box is open, on the failing leaf the jump's place names in walk order",
  async ({ page }) => {
    const label = ((await visibleJump(page).textContent()) ?? "").trim();
    const place = placeNamedBy(label, WALK_ORDER.length);
    expect(place, `the jump label "${label}" names no place in the walk`).not.toBeNull();
    expect(place!).toBeGreaterThanOrEqual(1);
    expect(place!).toBeLessThanOrEqual(WALK_ORDER.length);
    const leaf = WALK_ORDER[place! - 1]!;
    await expect(failureBoxes(page)).toHaveCount(1);
    // The leaf name is the key's part after the suite separator.
    await expect
      .poll(async () => (await openBoxLeafKeys(page)).map((key) => key?.split("::").pop() ?? null), {
        message: `the open failure box should be ${leaf}'s`,
      })
      .toEqual([leaf]);
  },
);
