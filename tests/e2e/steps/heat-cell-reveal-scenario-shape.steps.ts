// Heat-strip reveal steps for a playwright-bdd run in the scenario shape. The
// run is streamed to the board as the bun client streams a playwright-bdd
// target (open with `POST /api/v2/runs/start`, the `crucible-events` stream to
// `POST /api/v2/runs/<runId>/stream`, the close through `POST /api/v2/runs`).
// The overlay is opened with drillin.steps.ts's "I open the run overlay
// directly at its cold URL"; the project with seeding.steps.ts's "a project
// named {string} is registered".
//
// A scenario row is the spec view's `[data-testid="suite-row"]` carrying a
// `data-leaf-key`. A synthetic heat cell is titled by its suite alone (no
// ` › <scenario>` tail), so it is found by its feature's name at the start of
// its title, never by how the suite key is spelled.
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { Step } from "./world.ts";
import { registerAgent } from "./harness.ts";

interface ScenarioFixture {
  feature: string;
  name: string;
  status: "pass" | "fail";
  steps: Array<{ name: string; status: "pass" | "fail"; duration_ms: number; failure?: { message: string } }>;
  failure?: { message: string };
}

const pass = (name: string): ScenarioFixture["steps"][number] => ({ name, status: "pass", duration_ms: 5 });
const fail = (name: string, message: string): ScenarioFixture["steps"][number] => ({
  name,
  status: "fail",
  duration_ms: 5,
  failure: { message },
});

function greenScenario(feature: string, name: string): ScenarioFixture {
  return { feature, name, status: "pass", steps: [pass(`Given ${name} begins`), pass(`Then ${name} ends`)] };
}

const THREE_GREEN_FEATURES: ScenarioFixture[] = [
  greenScenario("Alpha", "Alpha opens the catalogue"),
  greenScenario("Alpha", "Alpha closes the catalogue"),
  greenScenario("Beta", "Beta weighs the parcel"),
  greenScenario("Beta", "Beta labels the parcel"),
  greenScenario("Gamma", "Gamma lists the shelves"),
  greenScenario("Gamma", "Gamma sorts the shelves"),
];

const FAILING_SECOND_FEATURE: ScenarioFixture[] = [
  greenScenario("Alpha", "Alpha opens the catalogue"),
  greenScenario("Beta", "Beta settles the bill"),
  {
    feature: "Beta",
    name: "Beta refunds the card",
    status: "fail",
    steps: [pass("Given a paid order"), fail("When I refund it", "refund refused")],
    failure: { message: "refund refused" },
  },
  {
    feature: "Beta",
    name: "Beta voids the order",
    status: "fail",
    steps: [fail("Given an open order", "order locked")],
    failure: { message: "order locked" },
  },
];

function streamOf(scenarios: ScenarioFixture[]): string {
  const line = (fields: Record<string, unknown>): string => `${JSON.stringify(fields)}\n`;
  const failed = scenarios.filter((s) => s.status === "fail").length;
  return (
    line({ event: "run-start", total: scenarios.length }) +
    scenarios
      .map((s, i) =>
        line({
          event: "test-end",
          id: `scenario-${i}-chromium`,
          name: s.name,
          suite: s.feature,
          file: `features/${s.feature.toLowerCase()}.feature`,
          browser: "chromium",
          status: s.status,
          duration_ms: 10,
          steps: s.steps,
          ...(s.failure !== undefined ? { failure: s.failure } : {}),
        }),
      )
      .join("") +
    line({
      event: "run-end",
      total: scenarios.length,
      passed: scenarios.length - failed,
      failed,
      pending: 0,
      duration_ms: 10 * scenarios.length,
    })
  );
}

async function streamRun(
  request: Parameters<typeof registerAgent>[0],
  projectKey: string,
  agentId: string,
  scenarios: ScenarioFixture[],
): Promise<string> {
  await registerAgent(request, projectKey, agentId, "heat reveal scenario shape — streams a playwright-bdd run");
  const start = await request.post("/api/v2/runs/start", {
    data: { projectKey, agentId, tier: "e2e", stack: "bun", framework: "playwright-bdd" },
  });
  expect(start.status()).toBe(202);
  const runId = ((await start.json()) as { runId: string }).runId;
  const batch = await request.post(`/api/v2/runs/${runId}/stream`, {
    data: { projectKey, agentId, codec: "crucible-events", from: 0, data: streamOf(scenarios) },
  });
  expect(batch.status()).toBe(200);
  const closed = await request.post("/api/v2/runs", {
    data: { projectKey, agentId, runId, codec: "crucible-events" },
  });
  expect(closed.status()).toBe(200);
  return ((await closed.json()) as { event: string }).event;
}

function overlayOf(page: Page): Locator {
  return page.getByTestId("run-overlay");
}

function scenarioRowOf(page: Page, name: string): Locator {
  return overlayOf(page).locator('[data-testid="suite-row"][data-leaf-key]').filter({ hasText: name });
}

function syntheticCellOf(page: Page, feature: string, status: "pass" | "fail"): Locator {
  return overlayOf(page)
    .getByTestId("heat-strip")
    .locator(`.app-heat-${status}[title^="${feature}"]:not([title*=" › "])`)
    .first();
}

// ── Given — the runs ───────────────────────────────────────────────────────

Step(
  "a playwright-bdd run is streamed for agent {string} with three all-green features of two scenarios each",
  async ({ request, world }, agentId: string) => {
    world.eventId = await streamRun(request, world.projectKey as string, agentId, THREE_GREEN_FEATURES);
  },
);

Step(
  "a playwright-bdd run is streamed for agent {string} with a green feature and a feature {string} whose first scenario passes and next two fail",
  async ({ request, world }, agentId: string, feature: string) => {
    expect(feature).toBe("Beta");
    world.eventId = await streamRun(request, world.projectKey as string, agentId, FAILING_SECOND_FEATURE);
  },
);

// A suite whose first read is held keeps its synthetic cells while the run
// detail is open: the hold stands in for a slow network. Every later read of
// it, the cell click's own included, is answered at once.
Step("the board holds its first read of the feature {string}", async ({ page }, feature: string) => {
  let held = false;
  await page.route(
    (url) => url.pathname.startsWith("/api/v2/events/") && url.searchParams.get("suite") === feature,
    async (route: Route) => {
      if (held) {
        await route.continue();
        return;
      }
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await route.continue().catch(() => undefined);
    },
  );
});

// ── When — the clicks ──────────────────────────────────────────────────────

Step("I click the heat cell of the scenario {string}", async ({ page }, name: string) => {
  const cell = overlayOf(page).getByTestId("heat-strip").locator(`[title$=" › ${name}"]`);
  await expect(cell).toHaveCount(1);
  await cell.click();
});

Step("I click a passing synthetic heat cell of the feature {string}", async ({ page }, feature: string) => {
  const cell = syntheticCellOf(page, feature, "pass");
  await expect(cell).toBeVisible();
  await cell.click();
});

Step("I click a failing synthetic heat cell of the feature {string}", async ({ page }, feature: string) => {
  const cell = syntheticCellOf(page, feature, "fail");
  await expect(cell).toBeVisible();
  await cell.click();
});

// ── Then — the located row ─────────────────────────────────────────────────

Step("the scenario row {string} carries the locate-blink class", async ({ page }, name: string) => {
  const row = scenarioRowOf(page, name);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/app-locate-blink/);
});

Step("the scenario row {string} does not carry the locate-blink class", async ({ page }, name: string) => {
  const row = scenarioRowOf(page, name);
  await expect(row).toHaveCount(1);
  await expect(row).not.toHaveClass(/app-locate-blink/);
});

Step("exactly one row in the overlay carries the locate-blink class", async ({ page }) => {
  await expect(overlayOf(page).locator(".app-locate-blink")).toHaveCount(1);
});

Step(
  "the scenario row {string} is scrolled within the pane-scroll's visible area",
  async ({ page }, name: string) => {
    const overlay = overlayOf(page);
    const pane = overlay.getByTestId("pane-scroll");
    const row = scenarioRowOf(page, name);
    await expect(row).toHaveCount(1);
    await expect(async () => {
      const [paneBox, rowBox] = await Promise.all([pane.boundingBox(), row.boundingBox()]);
      expect(paneBox, `could not measure the pane-scroll for "${name}"`).not.toBeNull();
      expect(rowBox, `could not measure the scenario row "${name}"`).not.toBeNull();
      expect(rowBox!.y).toBeGreaterThanOrEqual(paneBox!.y - 1);
      expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(paneBox!.y + paneBox!.height + 1);
    }).toPass({ timeout: 5_000 });
  },
);
