// CR-CRU-014 §S3 — roadmap-graph.feature steps: the exclusive table|graph
// toggle's GRAPH half, driven against the SPA over the real server. Reuses
// seeding.steps.ts (project/agent), roadmap.steps.ts ("a CR queue registering
// cr … is posted"), navigation.steps.ts ("I open the workspace for that
// project"), and workflow.steps.ts ("I click the {string} workspace tab") —
// only the graph-view toggle, node-count, on-node-tap, and tab-active
// assertions are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

// A test seam the graph render publishes: the mounted cytoscape instance,
// enough of its surface to fire a node `tap` programmatically (canvas nodes
// have no DOM element to click). GREEN assigns window.crucibleRoadmapCy when
// it mounts the graph.
interface RoadmapCyHandle {
  $id: (id: string) => { emit: (event: string) => void };
}

// The exclusive toggle's graph switch — the segmented control's graph option.
Step("I switch the roadmap view to graph", async ({ page }) => {
  const toGraph = page.getByTestId("roadmap-view-graph");
  await expect(toGraph).toBeVisible();
  await toGraph.click();
});

// The graph container renders and reports its builder-derived CR node count
// (canvas internals aren't selector-addressable — the count rides a data attr).
Step(
  "the roadmap graph container renders {int} CR nodes within {int} seconds",
  async ({ page }, count: number, seconds: number) => {
    const container = page.getByTestId("roadmap-graph");
    await expect(container).toBeVisible({ timeout: seconds * 1_000 });
    await expect(container).toHaveAttribute("data-cr-node-count", String(count), {
      timeout: seconds * 1_000,
    });
  },
);

// Exclusive toggle: switching to graph removed the table entirely.
Step("no roadmap table row is present", async ({ page }) => {
  await expect(page.getByTestId("roadmap-row")).toHaveCount(0);
});

// Fire the CR node's `tap` through the mounted cytoscape instance — the same
// event an on-canvas pointer fires — exercising the node→Workflow one-rule
// swap without a DOM node to click.
Step("I tap the roadmap graph node for {string}", async ({ page }, cr: string) => {
  await page.evaluate((id) => {
    const win = window as unknown as { crucibleRoadmapCy?: RoadmapCyHandle };
    const cy = win.crucibleRoadmapCy;
    if (cy === undefined) {
      throw new Error("window.crucibleRoadmapCy is not exposed — the graph did not mount");
    }
    cy.$id(id).emit("tap");
  }, cr);
});

// The one-rule swap: the named workspace tab carries the active `on` class.
Step(
  "the {string} workspace tab becomes active within {int} seconds",
  async ({ page }, label: string, seconds: number) => {
    const tab = page.getByTestId("workspace-tab").filter({ hasText: label });
    await expect(tab).toHaveClass(/\bon\b/, { timeout: seconds * 1_000 });
  },
);
