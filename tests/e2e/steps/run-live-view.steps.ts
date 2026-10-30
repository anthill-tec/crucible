// CR-CRU-223 — an open run shows its tests as they finish: the running card's
// progress line and the live drill-in at /run/<runId>, on the page.
//
// The run is REAL (run-lifecycle.steps.ts opens it with POST
// /api/v2/runs/start, and settles it with a real ingest); only the two live
// reads are doubled, through run-live-mock.ts, because the live state they
// answer is filled by CR-CRU-200. A change frame is the server's own: a second
// agent opening a run in the same project emits the `events` frame every page
// on that project refreshes on.
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { Step } from "./world.ts";
import { f25LiveState, routeRunLive, type LiveStateFixture } from "./run-live-mock.ts";

const liveState = (world: Record<string, unknown>): LiveStateFixture => {
  const state = world.liveState as LiveStateFixture | undefined;
  expect(state, "no live state is held — run the 'the board holds a live state' step first").toBeDefined();
  return state as LiveStateFixture;
};

/** A header string, matched with any spacing between its parts. */
const spacingTolerant = (expected: string): RegExp =>
  new RegExp(
    expected
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
      .join("\\s*"),
  );

const failureRows = (page: Page): Locator => page.getByTestId("live-failure-row");

const liveHeader = (page: Page): Locator => page.locator(".app-drillin-head").first();

Step(
  "the board holds a live state for that run: {int} of {int} finished in {string} with {int} failures",
  async ({ page, world }, completed: number, total: number, file: string, failed: number) => {
    const state = f25LiveState(file);
    // The F25 numbers are the fixture's own; the step states them so a reader
    // sees them, and they must agree.
    expect(state.live.completed).toBe(completed);
    expect(state.live.total).toBe(total);
    expect(state.live.failed).toBe(failed);
    expect(state.failures).toHaveLength(failed);
    world.liveState = state;
    await routeRunLive(page, world.runId as string, state);
  },
);

Step(
  "that running card shows a progress bar at {int} percent, {string}, {string} and {string}",
  async ({ world }, percent: number, count: string, file: string, failures: string) => {
    const card = world.runningCard as Locator;
    const track = card.getByTestId("running-progress");
    const fill = card.getByTestId("running-progress-fill");
    await expect(track).toBeVisible();
    const ratio = await fill.evaluate((el) => {
      const trackBox = (el.parentElement as HTMLElement).getBoundingClientRect();
      return el.getBoundingClientRect().width / trackBox.width;
    });
    expect(Math.round(ratio * 100)).toBe(percent);
    await expect(card.getByTestId("running-count")).toHaveText(count);
    await expect(card.getByTestId("running-file")).toHaveText(file);
    await expect(card.getByTestId("running-failed")).toHaveText(failures);
  },
);

Step("that running card has the pointer cursor", async ({ world }) => {
  const card = world.runningCard as Locator;
  expect(await card.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
});

Step("I open that running card's live drill-in", async ({ world }) => {
  const card = world.runningCard as Locator;
  await card.click();
});

Step("I have opened the live drill-in of that run", async ({ page, world }) => {
  await page.goto(`/run/${world.runId as string}`);
});

Step("the URL is the live drill-in of that run", async ({ page, world }) => {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 2_000 }).toBe(`/run/${world.runId as string}`);
});

Step("the URL is the live drill-in of that run in the workspace", async ({ page, world }) => {
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 2_000 })
    .toBe(`/p/${world.projectKey as string}/run/${world.runId as string}`);
});

Step("the live drill-in's header reads {string}", async ({ page }, expected: string) => {
  await expect(liveHeader(page)).toHaveText(spacingTolerant(expected), { timeout: 3_000 });
});

Step(
  "the live drill-in lists the failures {string}, {string} and {string} in order",
  async ({ page }, first: string, second: string, third: string) => {
    await expect(failureRows(page)).toHaveCount(3, { timeout: 3_000 });
    await expect(failureRows(page).getByTestId("live-failure-name")).toHaveText([first, second, third]);
  },
);

Step("the live drill-in's passed row reads {string}", async ({ page }, count: string) => {
  const passed = page.getByTestId("live-passed-row");
  await expect(passed).toHaveCount(1);
  await expect(passed).toContainText(count);
});

Step("I reload the page", async ({ page }) => {
  await page.reload();
});

Step(
  "the board's live state for that run gains the failure {string}",
  async ({ world }, name: string) => {
    const state = liveState(world);
    state.failures.push({
      id: `f-${state.failures.length + 1}`,
      name,
      suite: "test_relay.RelayTest",
      file: "test_resume.py",
      message: "AssertionError: batch 7 sent twice",
    });
    state.live.completed += 1;
    state.live.failed += 1;
    world.liveReadsBeforeFrame = state.reads.length;
  },
);

Step(
  "a change frame reaches the page when agent {string} opens a run on that project",
  async ({ request, world }, agentId: string) => {
    const res = await request.post("/api/v2/runs/start", {
      data: { projectKey: world.projectKey as string, agentId, tier: "unit" },
    });
    expect(res.status()).toBe(202);
  },
);

Step(
  "the live drill-in lists {string} as its fourth failure within 3 seconds",
  async ({ page }, name: string) => {
    await expect(failureRows(page)).toHaveCount(4, { timeout: 3_000 });
    await expect(failureRows(page).nth(3).getByTestId("live-failure-name")).toHaveText(name);
  },
);

Step("the refresh read only the failures after the first {int}", async ({ world }, shown: number) => {
  const state = liveState(world);
  const since = state.reads.slice(world.liveReadsBeforeFrame as number);
  expect(since.length).toBeGreaterThanOrEqual(1);
  for (const url of since) {
    expect(new URL(url, "http://localhost").searchParams.get("from")).toBe(String(shown));
  }
});

Step("the URL becomes the settled run's drill-in within 3 seconds", async ({ page, world }) => {
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 3_000 })
    .toBe(`/run/${world.eventId as string}`);
});

Step("the live drill-in's rows are gone", async ({ page }) => {
  await expect(failureRows(page)).toHaveCount(0);
  await expect(page.getByTestId("live-passed-row")).toHaveCount(0);
});

Step("I go back in the browser", async ({ page }) => {
  await page.goBack();
});

Step("the URL is the home page with no run path", async ({ page }) => {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 2_000 }).toBe("/");
  await expect(page.getByTestId("run-overlay")).toHaveCount(0);
});

// ── the phone band ────────────────────────────────────────────────────────

Step("that running card's failure count and timer stay inside the card", async ({ world }) => {
  const card = world.runningCard as Locator;
  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  for (const testid of ["running-failed", "running-elapsed"]) {
    const part = card.getByTestId(testid);
    await expect(part).toBeVisible();
    const box = await part.boundingBox();
    expect(box, `${testid} has no box`).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(cardBox!.x - 0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
  }
});

Step("that running card's file truncates on one line beside its count", async ({ world }) => {
  const card = world.runningCard as Locator;
  const file = card.getByTestId("running-file");
  await expect(file).toBeVisible();
  const shape = await file.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      clipped: el.scrollWidth > el.clientWidth,
    };
  });
  expect(shape.whiteSpace).toBe("nowrap");
  expect(shape.textOverflow).toBe("ellipsis");
  expect(shape.clipped).toBe(true);
  // One line: the count and the file share it.
  const countBox = await card.getByTestId("running-count").boundingBox();
  const fileBox = await file.boundingBox();
  expect(countBox).not.toBeNull();
  expect(fileBox).not.toBeNull();
  expect(Math.abs(countBox!.y - fileBox!.y)).toBeLessThan(4);
});

Step("that running card is at least 44px tall", async ({ world }) => {
  const card = world.runningCard as Locator;
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
