// CR-CRU-014 §S3 — roadmap-graph.feature steps: the exclusive table|graph
// toggle's GRAPH half, driven against the SPA over the real server. Reuses
// seeding.steps.ts (project/agent), roadmap.steps.ts ("a CR queue registering
// cr … is posted"), navigation.steps.ts ("I open the workspace for that
// project"), and workflow.steps.ts ("I click the {string} workspace tab",
// "a cycle plan is filed for cr … with a cycle labelled …") — only the
// graph-view toggle, node-count, per-node status, on-node-tap, and
// tab-active assertions are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

// A test seam the graph render publishes: the mounted cytoscape instance,
// enough of its surface to fire a node `tap` programmatically and to read the
// node's own derived status (canvas nodes have no DOM element to click or
// query). GREEN assigns window.crucibleRoadmapCy when it mounts the graph.
interface RoadmapCyNode {
  emit: (event: string) => void;
  data: (key: string) => unknown;
}

interface RoadmapCyHandle {
  $id: (id: string) => RoadmapCyNode;
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

// CR-CRU-083 AC7 — the per-node derived status the tap gate reads, observed
// live through the same published instance. Two jobs, both real: it pins the
// graph's SSE status seam (public/app.js patches each CR node's `status` data
// in place as the live queue changes), and it makes the landable tap below
// DETERMINISTIC — the plan POST's status flip reaches the SPA over SSE, so a
// bare tap straight after filing would race the refetch and fire on a node
// still carrying PENDING. No DOM attribute exposes per-node status (the
// container's `data-cr-node-count` is a count, unchanged by a status flip),
// so the cytoscape handle is the only honest read.
Step(
  "the roadmap graph node for {string} carries status {string} within {int} seconds",
  async ({ page }, cr: string, status: string, seconds: number) => {
    await page.waitForFunction(
      ({ id, want }: { id: string; want: string }) => {
        const win = window as unknown as { crucibleRoadmapCy?: RoadmapCyHandle };
        return win.crucibleRoadmapCy?.$id(id).data("status") === want;
      },
      { id: cr, want: status },
      { timeout: seconds * 1_000 },
    );
  },
);

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

// CR-CRU-083 AC7 — the INERT half of the gate, asserted positively so it
// cannot pass vacuously. `cy.emit("tap")` runs the app's handler
// SYNCHRONOUSLY in-page, so by the time the step returns the swap decision is
// already made; only VanJS's next-tick class commit is outstanding. Settling
// for the named window and then asserting the ORIGINAL tab still carries `on`
// is therefore a real negative: the tab class is `state.workspaceTab === name`
// (app.js WorkspaceTabs), so exactly one tab is `on` at a time and "Roadmap is
// still on" is precisely "the tap did not swap to Workflow". A bare
// `not.toHaveClass` would have passed instantly and proved nothing.
Step(
  "the {string} workspace tab is still active {int} milliseconds later",
  async ({ page }, label: string, ms: number) => {
    await page.waitForTimeout(ms);
    const tab = page.getByTestId("workspace-tab").filter({ hasText: label });
    await expect(tab).toHaveClass(/\bon\b/);
  },
);
