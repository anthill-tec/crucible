// CR-CRU-014 §S3, as amended by CR-CRU-118 §S2 — roadmap.feature steps:
// registering a CR through the real per-CR membership route (POST
// /api/v2/projects/<key>/queue/plan, CR-CRU-105 §S1 — the bulk door this step
// used to post through is the migration door, and §S3 deprecates it), and
// asserting the workspace Roadmap tab's derived status badge against the SPA's
// DOM as a plan is filed and closed.
// Reuses seeding.steps.ts (project/agent), navigation.
// steps.ts ("I open the workspace for that project"), and workflow.steps.ts
// ("I click the {string} workspace tab", "a cycle plan is filed …", "the plan
// is closed with merge commit …") wherever they already say what is needed —
// only the queue-registration and roadmap-row assertion steps are new here.
import { expect } from "@playwright/test";
import { Step } from "./world.ts";

// CR-CRU-118 §S2 — this step used to register the CR through the bulk
// full-replace POST …/queue with no release at all. That door now refuses an
// INSERT it would have to invent membership for, and rightly: a row nobody
// declared into a release is a row no roadmap can place. §S3 deprecates the
// door outright, and roadmap-graph.feature already says in prose what our own
// scenarios do instead — propose the release, then declare the CR into it
// through `cr-plan` (POST …/queue/plan, CR-CRU-105 §S1). This step follows
// that idiom rather than inventing a second one.
//
// Membership is SCAFFOLDING here: this scenario's subject is the roadmap row's
// DERIVED status badge, and nothing it asserts reads the release or the
// orchestrator. So the Gherkin phrase keeps naming exactly what the scenario
// is about (cr, title, wave) and the step supplies the rest itself — the
// precedent roadmap-graph.steps.ts set for the mandatory `targetAt` (§S4a),
// which no scenario there draws either. A PROPOSED release is not a SHIPPED
// one, so `shipped` (store.ts's `crs`-of-a-recorded-release set) still does
// not name this CR and the row's first reading is PENDING exactly as before.
//
// Both posts still go straight through the `request` fixture at the
// harness-owned ephemeral port — the same primitive the harness helpers use,
// so the ephemeral-target discipline still holds.
Step(
  "a CR queue registering cr {string} titled {string} in wave {string} is posted for that project",
  async ({ request, world }, cr: string, title: string, wave: string) => {
    const projectKey = world.projectKey as string;
    // Declaring membership is ORCHESTRATOR work (`requireOrchestrator`), a role
    // the shared seeding step deliberately never hands out (`role: "report"`),
    // so the scaffolding registers its own.
    const orchestratorId = "rm-lifecycle-orch";
    const orchestrator = await request.post("/api/v2/agents/register", {
      data: {
        projectKey,
        agentId: orchestratorId,
        message: "CR-CRU-118 — e2e roadmap-row orchestrator",
        status: "online",
        role: "ORCHESTRATOR",
      },
    });
    expect(orchestrator.ok()).toBe(true);
    world.orchestratorId = orchestratorId;
    // A declared label must hold a LIVE proposal (CR-CRU-104 §S1), and a
    // proposal must name a target date (CR-CRU-118 §S4a).
    const release = "0.2.0";
    const proposal = await request.post(
      `/api/v2/projects/${projectKey}/release-proposals`,
      {
        data: {
          label: release,
          agentId: orchestratorId,
          targetAt: 1_788_220_800, // 2026-09-01T00:00:00Z
        },
      },
    );
    expect(proposal.ok()).toBe(true);
    world.release = release;
    const res = await request.post(`/api/v2/projects/${projectKey}/queue/plan`, {
      data: { agentId: orchestratorId, cr, title, release, wave },
    });
    expect(res.ok()).toBe(true);
  },
);

// The roadmap row's derived status badge, asserted live: the row is keyed by
// its CR id, and the status badge inside it must reach the expected value
// within the SSE-refetch window (no reload). CR-CRU-147 \u00a7S2 (cycle 526, C4)
// \u2014 card-aware: at the phone band the release table renders
// `roadmap-cr-card`s, not `roadmap-row`s (CR-CRU-018 AC8), so this step
// reuses `statusBadgeLocator` below (declared as a hoisted `function`, so the
// forward reference here is safe) rather than hard-coding the desktop-only
// `roadmap-row` selector \u2014 the same badge testid either shape renders.
Step(
  "the roadmap row for {string} shows status {string} within {int} seconds",
  async ({ page }, cr: string, status: string, seconds: number) => {
    const badge = statusBadgeLocator(page, cr);
    await expect(badge).toHaveText(status, { timeout: seconds * 1_000 });
  },
);

// CR-CRU-147 \u00a7S2 (cycle 526, C4) \u2014 the REAL disposition write, through the
// route \u00a7S1's own server tests already drive (`POST
// \u2026/queue/<cr>/void`, `src/v2.ts` `handleCrLifecycle`). Reuses the
// orchestrator identity the queue-registration step above already opened
// (`world.orchestratorId`), the same caller CR-092/147 requires
// (`requireOrchestrator`).
Step(
  "cr {string} is voided with reason {string}",
  async ({ request, world }, cr: string, reason: string) => {
    const projectKey = world.projectKey as string;
    const orchestratorId = world.orchestratorId as string;
    const res = await request.post(
      `/api/v2/projects/${projectKey}/queue/${cr}/void`,
      { data: { agentId: orchestratorId, reason } },
    );
    expect(res.ok()).toBe(true);
  },
);

// CR-CRU-147 \u00a7S2 AC3 \u2014 reachability, both input modes. The badge locator
// matches EITHER the desktop table row or the phone-band card (\u00a7S2 is one
// contract, two DOM shapes \u2014 `public/app.js`'s `RoadmapRow` renders the same
// status badge testid in `card` mode, `ROADMAP_CARD_FIELD_TESTIDS` wraps it),
// so the SAME steps drive both roadmap.feature (desktop hover) and
// mobile-viewport-responsive.feature (phone tap).
function statusBadgeLocator(page: import("@playwright/test").Page, cr: string) {
  return page.locator(
    `[data-testid="roadmap-row"][data-cr="${cr}"] [data-testid="roadmap-status-badge"], ` +
      `[data-testid="roadmap-cr-card"][data-cr="${cr}"] [data-testid="roadmap-status-badge"]`,
  );
}

Step("I hover the status badge for {string}", async ({ page }, cr: string) => {
  await statusBadgeLocator(page, cr).hover();
});

Step("I tap the status badge for {string}", async ({ page }, cr: string) => {
  await statusBadgeLocator(page, cr).tap();
});

// Ruling 7 (2026-09-25, at VERIFY) \u2014 the same badge is reachable by
// keyboard: focusing it (Tab, or here a direct `.focus()` \u2014 Playwright has no
// portable "land exactly here" Tab sequence across the surrounding chrome)
// opens the tooltip the same way hover/tap already do.
Step("I focus the status badge for {string}", async ({ page }, cr: string) => {
  await statusBadgeLocator(page, cr).focus();
});

// "Moving focus away" \u2014 a direct `.blur()` on the badge itself, not a click
// elsewhere in the page that could ALSO open some other control's own tooltip
// or drill through a row and confound the assertion that follows.
Step("I move focus away from the status badge for {string}", async ({ page }, cr: string) => {
  await statusBadgeLocator(page, cr).evaluate((el) => (el as HTMLElement).blur());
});

// Ruling 7's own accessibility-tree requirement, read from the REAL browser's
// computed style (unlike the happy-dom unit half, a real engine's cascade
// answers this precisely): closed does not mean gone \u2014 no `hidden` attribute,
// no `display:none`, no `visibility:hidden`. The reason stays readable in the
// markup regardless.
Step(
  "the status badge for {string} keeps its lifecycle tooltip in the accessibility tree while closed",
  async ({ page }, cr: string) => {
    void cr;
    const tooltip = page.getByTestId("roadmap-status-tooltip");
    await expect(tooltip).toBeAttached();
    const state = await tooltip.evaluate((el) => ({
      hidden: el.hasAttribute("hidden"),
      display: getComputedStyle(el).display,
      visibility: getComputedStyle(el).visibility,
    }));
    expect(state.hidden, "the closed tooltip still carries a hidden attribute \u2014 ruling 7 forbids it").toBe(
      false,
    );
    expect(
      state.display,
      "the closed tooltip's computed display is \"none\" \u2014 ruling 7 forbids hiding it that way",
    ).not.toBe("none");
    expect(
      state.visibility,
      'the closed tooltip\'s computed visibility is "hidden" \u2014 ruling 7 forbids hiding it that way',
    ).not.toBe("hidden");
  },
);

// The tooltip's OWN visibility is the behavioural proof \u00a7S2 asks for \u2014 not
// merely present in the DOM (a static assertion a `display:none` bubble would
// still satisfy), but actually shown after the hover/tap that opened it, and
// carrying the untruncated reason text (\u00a7S2: "the full reason, wrapped").
Step(
  "its lifecycle tooltip states the reason {string}",
  async ({ page }, reason: string) => {
    const tooltip = page.getByTestId("roadmap-status-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(reason);
  },
);

// AC1/AC3 negative half \u2014 before any hover/tap, the tooltip is not shown, so
// the positive assertion above is proven to be caused by the interaction and
// not by an always-visible bubble.
Step(
  "the status badge for {string} shows no lifecycle tooltip yet",
  async ({ page }, cr: string) => {
    void cr;
    await expect(page.getByTestId("roadmap-status-tooltip")).toHaveCount(0);
  },
);
