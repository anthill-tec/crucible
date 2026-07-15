// CR-CRU-007 — frame-mapped E2E (storyboard as contract, PRD §5): Playwright
// suite extending the CR-CRU-006 harness (tests/e2e/shell.e2e.ts) exactly —
// same webServer (playwright.config.ts), same seedProject/registerAgent
// conventions, same `workers: 1` / `fullyParallel: false` ordering guarantee
// (definition order within a file; files run in discovery order, so
// shell.e2e.ts's F1 empty-state assertion still runs before any project
// gets seeded by either file).
//
// Frames covered (dispatch mapping, each its own `test`):
//   F2   — registering a project via API lights its projects-row badge live
//          over SSE (no reload); active-first ordering holds against an
//          older project.
//   F3   — ingesting a failing junit run via the API makes a red run card
//          appear live with tier + codec badges.
//   F4   — clicking that card opens the drill-in; the failing test's
//          failure.message text is visible after expanding.
//   F4½  — a 60-test run with failures, switched to Density mode, renders
//          the heat-strip.
//   F5   — a compile ingest renders a 🛠 card with diagnostics preview and
//          NEVER the string "0/" (no test-ratio leakage).
//   F6   — fail-then-pass for the same agent stem renders the transition
//          marker text matching `RED 2/5 ➜ GREEN 5/5`.
//   F7   — a green regression run with coverage updates the workspace
//          Project-pane coverage meter (percentage text changes).
//   F8   — clicking a projects-row badge lands on the workspace: no Agents
//          tab, right Project pane shows ⌁ agent sub-rows, `← projects`
//          breadcrumb present.
//
// All pass headless against the real server; results are ingested with
// `tier: "e2e"` (per §nav table / bottom of AC list) — the ORCHESTRATOR's
// ingest step, not this file, tags the Crucible submission.
//
// RED phase: expected split — F2/F6/F8 exercise shell wiring already
// delivered by earlier CR-CRU-007 cycles (C1-C4) and may well PASS; F4/F4½
// exercise the existing drill-in tree/heat-strip machinery and may also
// PASS; F3/F5/F7 probe server deltas (`eventBrief` diagnostics passthrough
// for compile cards, live coverage-meter refresh) that may still be
// missing — see the RED agent's dispatch report for the exact split. A
// frame FAILING here is real signal for GREEN, not a test bug.
import { test, expect, type APIRequestContext } from "@playwright/test";

async function seedProject(request: APIRequestContext, name: string): Promise<string> {
  const key = crypto.randomUUID();
  const res = await request.post("/api/projects/add", {
    data: { key, name, sut_root: "/tmp/e2e" },
  });
  expect(res.ok()).toBe(true);
  return key;
}

async function registerAgent(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  message: string,
): Promise<void> {
  const res = await request.post("/api/v2/agents/register", {
    data: { projectKey, agentId, message, status: "online" },
  });
  expect(res.ok()).toBe(true);
}

interface RunSummaryInput {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
}

interface RunIngestResponse {
  event: string;
}

async function ingestJunit(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  xml: string,
  tier?: string,
): Promise<RunIngestResponse> {
  const res = await request.post("/api/v2/runs", {
    data: {
      projectKey,
      agentId,
      codec: "junit",
      data: xml,
      ...(tier !== undefined ? { tier } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as RunIngestResponse;
}

async function ingestParsed(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  summary: RunSummaryInput,
  opts?: { coverage?: unknown; tier?: string },
): Promise<RunIngestResponse> {
  const status = summary.failed > 0 ? "fail" : "pass";
  const res = await request.post("/api/v2/runs/parsed", {
    data: {
      projectKey,
      agentId,
      summary,
      tree: [{ name: "s", status, children: [{ name: "t1", status, duration_ms: 5 }] }],
      ...(opts?.coverage !== undefined ? { coverage: opts.coverage } : {}),
      ...(opts?.tier !== undefined ? { tier: opts.tier } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as RunIngestResponse;
}

interface CompileIngestResponse {
  event: string;
  errors: number;
  warnings: number;
}

async function ingestCompile(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  errors: string,
  format = "rustc",
): Promise<CompileIngestResponse> {
  const res = await request.post("/api/v2/runs/compile", {
    data: { projectKey, agentId, errors, format },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as CompileIngestResponse;
}

// 3-case junit: 2 pass + 1 fail w/ message="boom" (mirrors the fixture
// already used in tests/v2-runs-events.test.ts / tests/ingest-routes.test.ts).
const JUNIT_3CASE_1FAIL = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

/** 60-case single-suite junit fixture, `failCount` failing with a shared message. */
function junit60(failCount = 3): string {
  const cases: string[] = [];
  for (let i = 1; i <= 60; i++) {
    if (i <= failCount) {
      cases.push(
        `<testcase name="t${i}" time="0.01"><failure message="boom-60">trace-${i}</failure></testcase>`,
      );
    } else {
      cases.push(`<testcase name="t${i}" time="0.01"/>`);
    }
  }
  return [`<testsuite name="Suite60" tests="60">`, ...cases, "</testsuite>"].join("\n");
}

// rustc fixture per CR §S2 AC4: 1 error[E0308] block + 1 plain warning block
// (same fixture shape as tests/v2-runs-events.test.ts / ingest-routes.test.ts).
const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

test.describe("CR-CRU-007 timeline — storyboard frames F2-F8", () => {
  test("F2: registering a project via API lights its projects-row badge live over SSE; active-first ordering holds against an older project", async ({
    page,
    request,
  }) => {
    // Older project, made active NOW (agent registered) so it has a real
    // (if slightly earlier) lastActivity — the ordering assertion below
    // needs both projects genuinely `active`, sorted by lastActivity DESC.
    const olderKey = await seedProject(request, "F2 Older");
    await registerAgent(request, olderKey, "agent-f2-older", "older project agent");

    await page.goto("/");
    const olderBadge = page.getByTestId("project-badge").filter({ hasText: "F2 Older" });
    await expect(olderBadge).toBeVisible();

    // New project registered AFTER the page has already loaded — its badge
    // must appear over the live stream, no reload/navigation.
    const newKey = await seedProject(request, "F2 New");
    await registerAgent(request, newKey, "agent-f2-new", "new project agent");

    const newBadge = page.getByTestId("project-badge").filter({ hasText: "F2 New" });
    await expect(newBadge).toBeVisible({ timeout: 2_000 });

    // Active-first ordering: the just-activated (freshest lastActivity)
    // project sorts BEFORE the older-but-still-active one.
    const badgeTexts = await page.getByTestId("project-badge").allTextContents();
    const newIndex = badgeTexts.findIndex((t) => t.includes("F2 New"));
    const olderIndex = badgeTexts.findIndex((t) => t.includes("F2 Older"));
    expect(newIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeLessThan(olderIndex);
  });

  test("F3: ingesting a failing junit run via the API makes a red run card appear live with tier + codec badges", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F3 Project");
    await page.goto("/");

    await ingestJunit(request, projectKey, "agent-f3", JUNIT_3CASE_1FAIL, "unit");

    const card = page.getByTestId("event-card").filter({ hasText: "agent-f3" });
    await expect(card).toBeVisible({ timeout: 2_000 });
    await expect(card.getByTestId("card-icon")).toHaveText("🧪");
    await expect(card.getByTestId("tier-badge")).toHaveText("unit");
    await expect(card.getByTestId("codec-badge")).toHaveText("junit");
    // 1 failing of 3 total — the red ratio pill shape.
    await expect(card.getByTestId("ratio-pill")).toContainText("1");
    await expect(card.getByTestId("ratio-pill")).toContainText("3");
  });

  test("F4: clicking a run card opens the drill-in; the failing test's failure.message is visible after expanding", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F4 Project");
    await ingestJunit(request, projectKey, "agent-f4", JUNIT_3CASE_1FAIL, "unit");

    await page.goto("/");
    const card = page.getByTestId("event-card").filter({ hasText: "agent-f4" });
    await expect(card).toBeVisible();
    await card.click();

    const overlay = page.getByTestId("run-overlay");
    await expect(overlay).toBeVisible();

    // unit-tier default mode is Detail (§S4.0) — suites are NOT
    // auto-expanded; expand "Suite1" to load its leaves.
    const suiteRow = overlay.getByTestId("suite-row").filter({ hasText: "Suite1" });
    await expect(suiteRow).toBeVisible();
    await suiteRow.click();

    const leafRows = overlay.getByTestId("leaf-row");
    await expect(leafRows).toHaveCount(3);

    // t3 is the failing leaf (class "fail" per LeafRows) — click it to
    // expand the failure box.
    const failingLeaf = overlay.locator('[data-testid="leaf-row"].fail');
    await expect(failingLeaf).toHaveCount(1);
    await failingLeaf.click();

    const failureBox = overlay.getByTestId("failure-box");
    await expect(failureBox).toBeVisible();
    await expect(failureBox).toContainText("boom");
  });

  test("F4½: a 60-test run with failures, switched to Density mode, renders the heat-strip", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F4.5 Project");
    const { event: eventId } = await ingestJunit(
      request,
      projectKey,
      "agent-f4half",
      junit60(3),
      "unit",
    );

    // Open the drill-in directly at its cold URL (matches the existing
    // "opened cold" AC — also exercised by shell.e2e.ts's Esc/nav test).
    await page.goto(`/run/${eventId}`);
    const overlay = page.getByTestId("run-overlay");
    await expect(overlay).toBeVisible();

    // Detail is the tier default — no heat-strip yet.
    await expect(overlay.getByTestId("heat-strip")).toHaveCount(0);

    const modeSwitch = overlay.getByTestId("drillin-mode");
    await expect(modeSwitch).toBeVisible();
    await expect(modeSwitch).toHaveAttribute("data-mode", "Detail");
    await modeSwitch.click();
    await expect(modeSwitch).toHaveAttribute("data-mode", "Density");

    const heatStrip = overlay.getByTestId("heat-strip");
    await expect(heatStrip).toBeVisible();
    await expect(heatStrip.getByTestId("heat-cell")).toHaveCount(60);

    // Clicking the first red cell expands that test's failure box.
    const firstFailCell = heatStrip.locator(".app-heat-fail").first();
    await expect(firstFailCell).toBeVisible();
    await firstFailCell.click();

    const failureBox = overlay.getByTestId("failure-box").first();
    await expect(failureBox).toBeVisible();
    await expect(failureBox).toContainText("boom-60");
  });

  test('F5: a compile ingest renders a 🛠 card with diagnostics preview and NEVER the string "0/"', async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F5 Project");
    await page.goto("/");

    await ingestCompile(request, projectKey, "agent-f5", RUSTC_ERRORS, "rustc");

    const card = page.getByTestId("event-card").filter({ hasText: "agent-f5" });
    await expect(card).toBeVisible({ timeout: 2_000 });
    await expect(card.getByTestId("card-icon")).toHaveText("🛠");

    // Compile cards render an error-count ratio pill, never a test ratio.
    const ratioPill = card.getByTestId("ratio-pill");
    await expect(ratioPill).toContainText("errors");

    // Diagnostics preview: first 2 diagnostics inline (`file:line — message`).
    const diagPreview = card.getByTestId("diag-preview");
    await expect(diagPreview).toBeVisible();
    await expect(diagPreview.getByTestId("diag-line").first()).toContainText("src/lib.rs");

    // Bound: no test-ratio leakage ("0/N") anywhere on the card, in EITHER
    // the ratio pill or the rest of the card body.
    const cardText = (await card.textContent()) ?? "";
    expect(cardText).not.toContain("0/");
  });

  test("F6: fail-then-pass for the same agent stem renders the transition marker text matching RED 2/5 ➜ GREEN 5/5", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F6 Project");

    await ingestParsed(request, projectKey, "CR-F6-1-RED", {
      total: 5,
      passed: 3,
      failed: 2,
      pending: 0,
      duration_ms: 40,
    });
    await ingestParsed(request, projectKey, "CR-F6-1-GREEN", {
      total: 5,
      passed: 5,
      failed: 0,
      pending: 0,
      duration_ms: 60,
    });

    await page.goto("/");
    const marker = page.getByTestId("transition-marker");
    await expect(marker).toBeVisible();
    await expect(marker).toContainText(/RED 2\/5 ➜ GREEN 5\/5/);
  });

  test("F7: a green regression run with coverage updates the workspace Project-pane coverage meter (percentage text changes)", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F7 Project");
    await registerAgent(request, projectKey, "agent-f7", "regression agent");

    await ingestParsed(
      request,
      projectKey,
      "agent-f7",
      { total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500 },
      { tier: "regression", coverage: { lines: { total: 10, covered: 5, percent: 50 } } },
    );

    await page.goto(`/p/${projectKey}`);
    const pane = page.getByTestId("project-pane");
    await expect(pane).toContainText("50%");

    // A SECOND green run with a different coverage figure, ingested while
    // the workspace stays open — the percentage text must change live, no
    // reload/navigation.
    await ingestParsed(
      request,
      projectKey,
      "agent-f7",
      { total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500 },
      { tier: "regression", coverage: { lines: { total: 10, covered: 9, percent: 90 } } },
    );

    await expect(pane).toContainText("90%", { timeout: 2_000 });
    await expect(pane).not.toContainText("coverage 50%");
  });

  test("F8: clicking a projects-row badge lands on the workspace: no Agents tab, right Project pane with ⌁ agents, ← projects breadcrumb present", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F8 Project");
    await registerAgent(request, projectKey, "agent-f8", "workspace-bound agent");

    await page.goto("/");
    const badge = page.getByTestId("project-badge").filter({ hasText: "F8 Project" });
    await expect(badge).toBeVisible();
    await badge.click();

    await expect(page).toHaveURL(new RegExp(`/p/${projectKey}$`));
    const header = page.getByTestId("workspace-header");
    await expect(header).toBeVisible();
    await expect(header).toContainText("← projects");

    // No "Agents" tab anywhere in the workspace tabs row.
    const tabTexts = await page.getByTestId("workspace-tab").allTextContents();
    expect(tabTexts).not.toContain("Agents");
    expect(tabTexts.some((t) => t.includes("Agents"))).toBe(false);

    // Right Project pane renders the agent as a ⌁-marked sub-row.
    const pane = page.getByTestId("project-pane");
    const agentRow = pane.getByTestId("agent-row").filter({ hasText: "agent-f8" });
    await expect(agentRow).toBeVisible();
    await expect(agentRow).toContainText("⌁");
  });
});
