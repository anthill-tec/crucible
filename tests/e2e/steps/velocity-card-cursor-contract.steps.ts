// CR-CRU-174 §S2 — steps for velocity-card-cursor-contract.feature: the
// Velocity card and the Vitals cards (cycle-health-card, coverage-trend-card)
// take no pointer cursor; the day/week switch's two options do; a genuinely
// clickable `.app-card`-classed card elsewhere is unaffected (GUARD).
//
// Reuses seeding.steps.ts ("a project named … is registered" / "an online
// agent … is registered on that project"), roadmap.steps.ts ("a CR queue
// registering cr … is posted for that project"), navigation.steps.ts
// ("I open the workspace for that project" / "I open the home page").
//
// GUARD selector note: the dispatch brief for this cycle names ".app-card
// … also used by the projects list cards" as the sibling to protect. The
// real DOM has no component that is BOTH classed `.app-card` AND reachable
// from the home page as a clickable "project list" entry — `ProjectBadge`
// (`[data-testid="project-badge"]`, the home page's one clickable
// per-project control, `ProjectsRow`/`ProjectBadge` in public/app.js) is
// `.app-chip.app-badge`, not `.app-card`; `.app-card`-classed clickable
// elements that DO exist (`AgentRow`, `.app-agent-row.app-card
// .app-agent-subrow`) render only inside the workspace Project pane, never
// on the home page. `project-badge` is used here as the closest faithful
// match to "a clickable projects-list card on the home page" — reported to
// the orchestrator as a prompt/DOM mismatch rather than guessed past
// silently.
//
// Velocity needs a MOCKED velocity read (not the real timing-sensitive one)
// so the day/week switch is guaranteed to render regardless of real merge
// history — same reasoning burndown-analytics-mock.ts gives for mocking
// burndown/forecast, applied here to velocity instead.
import { expect, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";

async function routeVelocity(page: Page, projectKey: string): Promise<void> {
  await page.route(
    `**/api/v2/projects/${projectKey}/analytics/velocity*`,
    async (route) => {
      const url = new URL(route.request().url());
      const release = url.searchParams.get("release") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          release,
          startTs: Date.now() - 15 * 86_400_000,
          pointsPerDay: 2,
          days: Array.from({ length: 15 }, (_, i) => ({
            day: new Date(Date.now() - (14 - i) * 86_400_000).toISOString().slice(0, 10),
            points: [3, 1, 2, 4, 0, 2, 2, 2, 3, 1, 0, 4, 2, 2, 2][i],
          })),
          sampleDays: 15,
          flow: { execMsPerCycle: 1_000_000, gateMsPerCycle: 500_000, sampleCycles: 15 },
        }),
      });
    },
  );
}

Step("velocity reads for that project are mocked with a day or week switch fixture", async ({ page, world }) => {
  await routeVelocity(page, world.projectKey as string);
});

async function cursorOf(locator: Locator): Promise<string> {
  await expect(locator).toBeVisible({ timeout: 10_000 });
  return locator.evaluate((el) => getComputedStyle(el).cursor);
}

Step("the Velocity card shows no pointer cursor", async ({ page }) => {
  const cursor = await cursorOf(page.getByTestId("project-velocity"));
  expect(cursor, "the Velocity card still shows a pointer cursor").not.toBe("pointer");
});

Step("the cycle health card shows no pointer cursor", async ({ page }) => {
  const cursor = await cursorOf(page.getByTestId("cycle-health-card"));
  expect(cursor, "the cycle health Vitals card still shows a pointer cursor").not.toBe("pointer");
});

Step("the coverage trend card shows no pointer cursor", async ({ page }) => {
  const cursor = await cursorOf(page.getByTestId("coverage-trend-card"));
  expect(cursor, "the coverage trend Vitals card still shows a pointer cursor").not.toBe("pointer");
});

Step("the velocity view switch day option shows a pointer cursor", async ({ page }) => {
  const cursor = await cursorOf(page.getByTestId("velocity-view-day"));
  expect(cursor, "the switch's day option is not clickable").toBe("pointer");
});

Step("the velocity view switch week option shows a pointer cursor", async ({ page }) => {
  const cursor = await cursorOf(page.getByTestId("velocity-view-week"));
  expect(cursor, "the switch's week option is not clickable").toBe("pointer");
});

// A SECOND, more direct GUARD than `project-badge` below: an `agent-row` is
// genuinely `.app-card`-classed (`.app-agent-row.app-card.app-agent-subrow`,
// public/app.js `AgentRow`) AND genuinely clickable (its onclick filters the
// timeline), so it actually exercises the shared `.app-card { cursor:
// pointer }` rule the Velocity fix must NOT edit wholesale — a regression
// that turned `.app-card`'s own `cursor: pointer` into `default` (instead of
// a scoped `.app-velocity-card` override) would fail this step even though
// it would NOT fail the `project-badge` guard (a `.app-chip`/`.app-badge`
// element with its own, separate `cursor: pointer` rule).
Step("an agent row in the Project pane still shows a pointer cursor", async ({ page }) => {
  const cursor = await cursorOf(page.getByTestId("agent-row").first());
  expect(cursor, "a clickable .app-card agent row lost its pointer cursor").toBe("pointer");
});

// GUARD — see the file-header note: the home page's own clickable
// "projects list" entry is `ProjectBadge` (`project-badge`), not an
// `.app-card`-classed element. A regression that strips `cursor: pointer`
// from the SHARED rule those projects list cards also ride (rather than
// adding a scoped `cursor: default` to `.app-velocity-card` /
// `.app-vitals-card`) must fail THIS step.
Step("a projects list card on the home page shows a pointer cursor", async ({ page }) => {
  const cursor = await cursorOf(page.getByTestId("project-badge").first());
  expect(cursor, "a clickable projects list card on the home page lost its pointer cursor").toBe("pointer");
});
