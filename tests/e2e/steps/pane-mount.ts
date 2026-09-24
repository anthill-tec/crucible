// The ONE answer to "wait for the tab's own pane" (CR-CRU-029, extracted by
// CR-CRU-148).
//
// A tab click (workflow.steps.ts's "I click the {string} workspace tab") flips
// `state.workspaceTab` synchronously, but VanJS's reactive class/child
// bindings commit on the NEXT tick, not within the click's own event-handler
// turn. `[data-testid="pane-scroll"]` exists on EVERY central pane, so a bare
// page-level lookup right after the click can resolve the PREVIOUS tab's
// still-mounted pane-scroll. `toHaveCount(1)` alone doesn't catch this, since
// the count stays 1 across the swap.
//
// CR-CRU-148 measured the cost of that on the phone band. The Compile step
// resolved the outgoing Workflow pane's pane-scroll, VanJS then swapped it
// out, and the step evaluated a DETACHED node: `isConnected === false`,
// `scrollHeight === clientHeight === 0`. That read as a "collapsed" pane while
// the live Compile pane measured 831 / 571.
//
// The mechanism is to wait, with an auto-retrying `expect`, on something that
// exists ONLY once the named tab's own pane is mounted, and to hand back the
// pane-scroll scoped to that pane. A wrong-tab pane can never satisfy the
// wait, so the step times out on it rather than measuring it.
//   - Runs:    `workspace-runs`, the Runs pane's (or its run-detail's) own
//              container. pane-scroll sits inside it.
//   - Compile: the pane carries no testid of its own (app.js CompilePanel), so
//              its identity is its own visible heading, "Compile — <project>"
//              (app.js CompileFeed), which renders INSIDE its pane-scroll.
import { expect, type Locator, type Page } from "@playwright/test";

export type PaneTab = "Runs" | "Compile";

export async function mountedPaneScroll(page: Page, tab: PaneTab): Promise<Locator> {
  if (tab === "Runs") {
    const runs = page.getByTestId("workspace-runs");
    await expect(runs).toBeVisible();
    return runs.getByTestId("pane-scroll");
  }
  const compile = page
    .getByTestId("pane-scroll")
    .filter({ has: page.locator(".app-rail-title", { hasText: /^Compile — / }) });
  await expect(compile).toBeVisible();
  return compile;
}
