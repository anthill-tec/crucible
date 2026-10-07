// CR-CRU-164 §S2 (UI half) / AC4 (UI half) — e2e steps for the roadmap
// release band's verified-runs chip and its Runs-tab filter.
//
// Reuses `roadmap.steps.ts`'s "a CR queue registering cr … is posted for
// that project" step for the release declaration (it proposes a live
// release labelled "0.2.0", declares the named CR into it, and records
// `world.release`) — this file adds only the run-filing step and the
// chip/filtered-Runs assertions.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";
import { registerAgent } from "./harness.ts";

// A minimal ONE-CASE PASSING junit report — distinct from harness.ts's
// `JUNIT_3CASE_1FAIL` (which carries a failure), so a scenario asserting
// "N runs" never also has to reason about pass/fail counts.
const PASSING_JUNIT = ['<testsuite name="VerifySuite" tests="1">', '<testcase name="t1" time="0.01"/>', "</testsuite>"].join(
  "\n",
);

// §S1's real server-side contract (`src/v2.ts` `resolveRunRelease`, posted
// through `POST /api/v2/runs`): a top-level `release` field on the ingest
// body, refused unless the label is declared AND the posting agent carries
// no bound cycle — both already true of a freshly `registerAgent`-ed id
// ("role: report", no `boundCycleId`) filing against the release
// `roadmap.steps.ts`'s registration step already declared.
Step(
  "{int} passing runs are filed under that release",
  async ({ request, world }, count: number) => {
    const projectKey = world.projectKey as string;
    const release = world.release as string;
    for (let i = 0; i < count; i++) {
      const agentId = `verify-chip-runner-${i}`;
      await registerAgent(request, projectKey, agentId, "verifying the release");
      const res = await request.post("/api/v2/runs", {
        data: { projectKey, agentId, codec: "junit", data: PASSING_JUNIT, release },
      });
      expect(res.ok()).toBe(true);
    }
  },
);

Step(
  "the roadmap release band shows the verified-runs chip reading {string}",
  async ({ page }, text: string) => {
    const band = page.getByTestId("roadmap-progress");
    await expect(band).toBeVisible();
    const chip = band.getByTestId("roadmap-verified-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(text);
  },
);

Step("the roadmap release band does not show the verified-runs chip", async ({ page }) => {
  const band = page.getByTestId("roadmap-progress");
  await expect(band).toBeVisible();
  await expect(band.getByTestId("roadmap-verified-chip")).toHaveCount(0);
});

Step(
  "the analytics pane shows the verified-runs chip reading {string}",
  async ({ page }, text: string) => {
    const pane = page.getByTestId("analytics-pane");
    await expect(pane).toBeVisible();
    const chip = pane.getByTestId("roadmap-verified-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(text);
  },
);

Step("I click the roadmap verified-runs chip", async ({ page }) => {
  await page.getByTestId("roadmap-progress").getByTestId("roadmap-verified-chip").click();
});

Step("the {string} workspace tab is active", async ({ page }, label: string) => {
  const tab = page.getByTestId("workspace-tab").filter({ hasText: label });
  await expect(tab).toHaveClass(/\bon\b/);
});

// Scoped to `workspace-runs` (the Runs pane's own container, same identity
// `pane-mount.ts`'s `PANE_IDENTITY.Runs` uses) so Playwright's own
// auto-retrying locator — not a bare post-click snapshot — is what resolves
// the race `pane-mount.ts` documents (a tab swap that has not yet landed):
// a `workspace-runs` that still belongs to the outgoing tab's DOM subtree
// cannot satisfy `getByTestId` scoped inside it, so the step keeps polling
// until the real Runs pane (and, inside it, its event cards) exists.
Step(
  "the Runs pane shows exactly the {int} runs filed under that release",
  async ({ page }, count: number) => {
    const runsPane = page.getByTestId("workspace-runs");
    await expect(runsPane).toBeVisible();
    await expect(runsPane.getByTestId("event-card")).toHaveCount(count);
  },
);

Step(
  "the Runs pane states it is filtered to that release with a way back to the unfiltered list",
  async ({ page, world }) => {
    const release = world.release as string;
    const banner = page.getByTestId("workspace-runs").getByTestId("runs-release-filter");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(release);
    const clear = page.getByTestId("workspace-runs").getByTestId("runs-release-filter-clear");
    await expect(clear).toBeVisible();
  },
);
