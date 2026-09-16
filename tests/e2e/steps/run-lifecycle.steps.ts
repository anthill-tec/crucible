// CR-CRU-017 §S3 — run-lifecycle step definitions: starting a run through the
// real /api/v2/runs/start route, and asserting the SPA's running / aborted card
// presentation against the DOM.
//
// Fixtures are the harness's, not this file's: `seedProject`/`registerAgent`/
// `ingestParsed` (via the shared seeding steps) own project + agent + ingest,
// and every request goes through Playwright's `request` fixture at the
// harness-owned E2E port, so the ephemeral-target guard applies here too.
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { Step } from "./world.ts";

const runningCard = (page: Page, agentId: string) =>
  page.getByTestId("running-card").filter({ hasText: agentId });

const abortedCard = (page: Page, agentId: string) =>
  page.getByTestId("aborted-card").filter({ hasText: agentId });

/**
 * A timer TICKS only if two reads separated by real time differ. Reading the
 * same text twice and calling it "live" is the failure mode this guards, so the
 * assertion is on the CHANGE — and it polls rather than sleeping a fixed span,
 * so it passes as soon as the first tick lands.
 */
async function expectTimerAdvances(timer: Locator, withinMs: number): Promise<void> {
  await expect(timer).toBeVisible();
  const first = ((await timer.textContent()) ?? "").trim();
  expect(first.length).toBeGreaterThan(0);
  await expect
    .poll(async () => ((await timer.textContent()) ?? "").trim(), { timeout: withinMs })
    .not.toBe(first);
}

/**
 * The 202 body of POST /api/v2/runs/start. An `as` on a route this suite owns
 * end to end: the server's own contract test pins the shape, and a wrong one
 * fails the `expect(res.status()).toBe(202)` above it, not this read.
 */
interface StartedRun {
  runId: string;
  startedAt: number;
}

Step(
  "a run is started for agent {string} on that project",
  async ({ request, world }, agentId: string) => {
    const res = await request.post("/api/v2/runs/start", {
      data: { projectKey: world.projectKey as string, agentId, tier: "unit" },
    });
    expect(res.status()).toBe(202);
    const body = (await res.json()) as StartedRun;
    world.runId = body.runId;
    world.runStartedAt = body.startedAt;
  },
);

Step(
  "a run linked to that cycle is started for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await request.post("/api/v2/runs/start", {
      data: {
        projectKey: world.projectKey as string,
        agentId,
        tier: "unit",
        context: { cycleId: world.cycleId as number },
      },
    });
    expect(res.status()).toBe(202);
    const body = (await res.json()) as StartedRun;
    world.runId = body.runId;
    world.runStartedAt = body.startedAt;
  },
);

Step(
  "a running card for {string} becomes visible within 2 seconds",
  async ({ page, world }, agentId: string) => {
    const card = runningCard(page, agentId);
    await expect(card).toBeVisible({ timeout: 2_000 });
    world.runningCard = card;
  },
);

Step("that running card's elapsed timer advances within 3 seconds", async ({ world }) => {
  const card = world.runningCard as Locator;
  await expectTimerAdvances(card.getByTestId("running-elapsed"), 3_000);
});

// The running card is NOT a run card wearing a badge: it has no counts to show,
// so a ratio pill on it would be a fabricated result.
Step("that running card shows no ratio pill at all", async ({ world }) => {
  const card = world.runningCard as Locator;
  await expect(card.getByTestId("ratio-pill")).toHaveCount(0);
});

// The user rule, asserted on the property the user actually sees: the CURSOR.
Step("that running card has the default cursor, not the pointer", async ({ world }) => {
  const card = world.runningCard as Locator;
  const cursor = await card.evaluate((el) => getComputedStyle(el).cursor);
  expect(cursor).not.toBe("pointer");
  expect(cursor).toBe("default");
});

Step("I click that running card", async ({ page, world }) => {
  const card = world.runningCard as Locator;
  world.urlBeforeClick = new URL(page.url()).pathname;
  await card.click();
  // Give a (wrongly) wired drill-in a real chance to navigate before asserting
  // nothing happened — otherwise this step would pass on latency alone.
  await expect(page.getByTestId("run-overlay")).toHaveCount(0, { timeout: 1_000 });
});

Step("no run overlay opens and the URL still has no run path", async ({ page, world }) => {
  await expect(page.getByTestId("run-overlay")).toHaveCount(0);
  const path = new URL(page.url()).pathname;
  expect(path).toBe(world.urlBeforeClick as string);
  expect(path).not.toContain("/run/");
});

// "In place, no reload" needs a witness that a reload would destroy: a value
// set on the live `window`. If the SPA re-navigates, this is gone.
Step("I mark the page so a reload would be detectable", async ({ page }) => {
  await page.evaluate(() => {
    // A well-known DOM global the compiler has no declaration for; nothing to
    // validate at runtime, so a named cast is the honest form.
    const w = window as unknown as Record<string, unknown>;
    w.__cr017NoReload = "sentinel";
  });
});

Step("the page was never reloaded", async ({ page }) => {
  const sentinel = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return w.__cr017NoReload;
  });
  expect(sentinel).toBe("sentinel");
});

Step(
  "the started run is ingested as a passing 1-test run for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await request.post("/api/v2/runs/parsed", {
      data: {
        projectKey: world.projectKey as string,
        agentId,
        runId: world.runId as string,
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
        tree: [
          {
            name: "Suite1",
            status: "pass",
            children: [{ name: "t1", status: "pass", duration_ms: 5 }],
          },
        ],
      },
    });
    expect(res.ok()).toBe(true);
    const ingested = (await res.json()) as { event: string };
    world.eventId = ingested.event;
  },
);

Step(
  "the running card for {string} disappears within 3 seconds",
  async ({ page }, agentId: string) => {
    await expect(runningCard(page, agentId)).toHaveCount(0, { timeout: 3_000 });
  },
);

Step(
  "the event card for {string} has the pointer cursor",
  async ({ page }, agentId: string) => {
    const card = page.getByTestId("event-card").filter({ hasText: agentId });
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  },
);

/**
 * The §S1 auto-abort trigger, driven the only way this cycle exposes: shrink the
 * project's liveness thresholds so its agent tombstones, which is precisely the
 * "agent died" case the sweep already implements. No §S2 abort route is called.
 */
Step(
  "that project's agents are configured to tombstone almost immediately",
  async ({ request, world }) => {
    const res = await request.patch(`/api/v2/projects/${world.projectKey as string}`, {
      data: { liveness: { t1_ms: 1, t2_ms: 2 } },
    });
    expect(res.ok()).toBe(true);
  },
);

// The sweep lives in the read handlers (§S1), so a plain read settles the run —
// and the abort it stores emits the change the SPA is already listening for.
Step("the server settles that project's dead open runs", async ({ request, world }) => {
  const res = await request.get(`/api/v2/agents?project=${world.projectKey as string}`);
  expect(res.ok()).toBe(true);
});

Step(
  "an aborted run card for {string} becomes visible within 5 seconds showing reason {string}",
  async ({ page, world }, agentId: string, reason: string) => {
    const card = abortedCard(page, agentId);
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.getByTestId("abort-reason")).toContainText(reason);
    world.abortedCard = card;
  },
);

// A FOURTH presentation state: struck + grey, and explicitly NOT borrowing the
// pass/fail/pending palette (§S2 — an abort is neither pass nor fail).
Step(
  "that aborted card is struck through and greyed, and carries none of the pass, fail or pending classes",
  async ({ world }) => {
    const card = world.abortedCard as Locator;
    const style = await card.evaluate((el) => {
      const computed = getComputedStyle(el);
      return { decoration: computed.textDecorationLine, opacity: Number(computed.opacity) };
    });
    expect(style.decoration).toContain("line-through");
    expect(style.opacity).toBeLessThan(1);
    const cls = (await card.getAttribute("class")) ?? "";
    for (const forbidden of ["app-ratio-pass", "app-ratio-fail", "app-evt-pending"]) {
      expect(cls).not.toContain(forbidden);
    }
    await expect(card.getByTestId("ratio-pill")).toHaveCount(0);
  },
);

Step("that aborted card has the pointer cursor", async ({ world }) => {
  const card = world.abortedCard as Locator;
  expect(await card.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
});

Step("I click the aborted run card for {string}", async ({ page }, agentId: string) => {
  const card = abortedCard(page, agentId);
  await expect(card).toBeVisible();
  await card.click();
});

Step("the run overlay shows the abort reason {string}", async ({ page }, reason: string) => {
  const overlay = page.getByTestId("run-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.getByTestId("abort-reason")).toContainText(reason, { timeout: 3_000 });
});

Step(
  "the active cycle's open span shows a running entry for {string} within 3 seconds",
  async ({ page, world }, agentId: string) => {
    const entry = page
      .getByTestId("open-span")
      .getByTestId("open-span-running-entry")
      .filter({ hasText: agentId });
    await expect(entry).toBeVisible({ timeout: 3_000 });
    world.openSpanRunning = entry;
  },
);

Step("that open-span running entry's elapsed timer advances within 3 seconds", async ({ world }) => {
  const entry = world.openSpanRunning as Locator;
  await expectTimerAdvances(entry.getByTestId("running-elapsed"), 3_000);
});
