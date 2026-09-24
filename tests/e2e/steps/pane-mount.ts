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
//
// CR-CRU-022 §S6 — extended to every central pane a pane-scroll step can land
// on, each by a marker ONLY that pane renders (app.js):
//   - Home:      `timeline`, the home pane's own container (pane-scroll inside).
//   - Workflow:  `.app-workflow-cols`, the Workflow feed's column row, which
//                renders INSIDE its pane-scroll (WorkflowFeed).
//   - Coverage:  `coverage-panel`, inside its pane-scroll (CoveragePanelBody).
//   - Roadmap:   `roadmap-zones`, inside its pane-scroll (RoadmapPanel).
//   - BDD:       `workspace-bdd`, the BDD pane's own container (BddPanel).
//   - Analytics: `analytics-pane`, the Roadmap's analytics state (F14¾).
// And the measurement itself goes through `mountedPaneScrollGeometry`, which
// re-proves IN THE SAME JS TURN as the read that the node is attached, is the
// document's one pane-scroll, and still carries its pane's marker — so a pane
// swapped out between the wait and the read (a detached node measures 0 / 0,
// which is how "no pane scrolls horizontally" once passed silently) is never
// measured.
import { expect, type Locator, type Page } from "@playwright/test";
import type { World } from "./world.ts";

export type PaneTab =
  | "Home"
  | "Workflow"
  | "Runs"
  | "Coverage"
  | "Compile"
  | "Roadmap"
  | "BDD"
  | "Analytics";

/** How a pane-scroll proves which pane it belongs to, checkable in the page. */
interface PaneIdentity {
  /** A testid the pane-scroll sits INSIDE (the pane's own container). */
  within?: string;
  /** A selector that renders INSIDE the pane-scroll. */
  contains?: string;
  /** …whose text must match this pattern (source of a RegExp). */
  text?: string;
  /**
   * A testid the pane's OWN pane-scroll never sits inside: a run detail over
   * the pane (`run-overlay`) carries its own pane-scroll within the same
   * container. Checked by the geometry reader, which measures the tab's pane,
   * never a pane state over it; `mountedPaneScroll`'s wait is unchanged.
   */
  notWithin?: string;
}

const PANE_IDENTITY: Record<PaneTab, PaneIdentity> = {
  Home: { within: "timeline", notWithin: "run-overlay" },
  Workflow: { contains: ".app-workflow-cols" },
  Runs: { within: "workspace-runs", notWithin: "run-overlay" },
  Coverage: { contains: '[data-testid="coverage-panel"]' },
  Compile: { contains: ".app-rail-title", text: "^Compile — " },
  Roadmap: { contains: '[data-testid="roadmap-zones"]' },
  BDD: { within: "workspace-bdd" },
  Analytics: { within: "analytics-pane" },
};

export async function mountedPaneScroll(page: Page, tab: PaneTab): Promise<Locator> {
  const identity = PANE_IDENTITY[tab];
  if (identity.within !== undefined) {
    const container = page.getByTestId(identity.within);
    await expect(container).toBeVisible();
    return container.getByTestId("pane-scroll");
  }
  const marker =
    identity.text === undefined
      ? page.locator(identity.contains!)
      : page.locator(identity.contains!, { hasText: new RegExp(identity.text) });
  const pane = page.getByTestId("pane-scroll").filter({ has: marker });
  await expect(pane).toBeVisible();
  return pane;
}

export interface PaneScrollGeometry {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/**
 * The named tab's own pane-scroll, measured. The identity is re-proven in the
 * SAME JS turn as the read: attached, the document's one live pane-scroll, and
 * still its pane's. A read failing that is retried (the swap it lost to is
 * about to land) and never returned; one still failing at the timeout fails
 * the step.
 */
export async function mountedPaneScrollGeometry(page: Page, tab: PaneTab): Promise<PaneScrollGeometry> {
  const identity = PANE_IDENTITY[tab];
  let reading: PaneScrollGeometry | null = null;
  await expect(async () => {
    const pane = await mountedPaneScroll(page, tab);
    const m = await pane.evaluate((el, id) => {
      const all = document.querySelectorAll('[data-testid="pane-scroll"]');
      let own = true;
      if (id.within !== undefined) {
        own = el.closest(`[data-testid="${id.within}"]`) !== null;
      } else if (id.contains !== undefined) {
        const found = Array.from(el.querySelectorAll(id.contains));
        own = found.some((node) => id.text === undefined || new RegExp(id.text).test(node.textContent ?? ""));
      }
      if (id.notWithin !== undefined && el.closest(`[data-testid="${id.notWithin}"]`) !== null) {
        own = false;
      }
      const box = el as HTMLElement;
      return {
        connected: el.isConnected,
        live: all.length === 1 && all[0] === el,
        own,
        geometry: {
          scrollWidth: box.scrollWidth,
          clientWidth: box.clientWidth,
          scrollHeight: box.scrollHeight,
          clientHeight: box.clientHeight,
          scrollTop: box.scrollTop,
        },
      };
    }, identity);
    expect(m.connected, "the measured pane-scroll is detached from the document").toBe(true);
    expect(m.live, "the measured pane-scroll is not the document's one live pane-scroll").toBe(true);
    expect(m.own, `the measured pane-scroll is not the ${tab} pane's`).toBe(true);
    reading = m.geometry;
  }).toPass({ timeout: 5_000 });
  return reading!;
}

/**
 * The pane a parameterless step means by "the active pane": the one the TEST
 * last opened or selected, as the navigation steps record it in `world`
 * ("I open the home page" → Home, "I open the workspace for that project" →
 * Workflow, "I click the {string} workspace tab" → that tab). Never read off
 * the page: the expectation comes from the test, so a tab strip that lied
 * could not steer the step onto the wrong pane. No record fails loudly.
 */
export function recordedPaneTab(world: World): PaneTab {
  const tab = world.activeTab;
  const tabs: readonly string[] = Object.keys(PANE_IDENTITY);
  if (typeof tab !== "string" || !tabs.includes(tab)) {
    throw new Error(
      `no active pane is recorded in world (activeTab = ${JSON.stringify(tab)}): open a page or ` +
        "click a workspace tab through the recording navigation steps before measuring a pane-scroll",
    );
  }
  return tab as PaneTab;
}
