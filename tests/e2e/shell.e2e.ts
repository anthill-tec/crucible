// CR-CRU-006 §S6 — E2E harness seed (storyboard as contract — PRD §5) +
// §S3 layout as re-revised 2026-07-15: two-column Mission Control home, ONE
// LEFT rail stacking Projects ABOVE Agents, timeline in the wide RIGHT
// column.
//
// RED phase: this suite is expected to FAIL against the CURRENT UI (still a
// three-column grid: [projects rail] [timeline] [agents rail]) — that is the
// point. GREEN implements the layout change (+ the `agent.message` vs
// `agent.msg` field-name fix surfaced below) to turn these green.
//
// Structural assertions below deliberately reuse EXISTING selectors only
// (`.app-main`, `.app-rail`, `.app-rail-title`, and the `data-testid`s
// already in public/app.js: `health-pill`, `timeline`, `project-card`,
// `agent-row`) rather than inventing new testids GREEN would have to guess —
// the contract is: exactly one `.app-main > .app-rail` (no separate left
// rail), and within it the "projects" `.app-rail-title` precedes "agents".
import { test, expect, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "server.ts");

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

/** Poll a standalone server's /api/health until it answers ok, or throw. */
async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // connection refused while the server boots — keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// NOT `mode: "serial"` — that mode skips all remaining tests in the block
// after one failure, which would hide independent RED signal from later
// frames during this RED phase. `workers: 1` + `fullyParallel: false` in
// playwright.config.ts already guarantee definition-order execution (F1
// before F2's seeding) without that skip-on-failure behavior.
test.describe("CR-CRU-006 shell — storyboard frames", () => {
  test("F1: fresh forge — empty state", async ({ page }) => {
    // MUST run before any other test in this file seeds data — the shared
    // webServer boots against a scratch, empty database (see
    // playwright.config.ts).
    await page.goto("/");

    const pill = page.getByTestId("health-pill");
    await expect(pill).toBeVisible();
    await expect(pill).not.toHaveClass(/down/);
    // "green-ish" — the live dot carries the "g" liveness class, not "r".
    await expect(pill.locator(".app-dot")).toHaveClass(/\bg\b/);

    // Scope to the timeline's EmptyState() specifically — ProjectsRail()
    // and AgentsRail() render their OWN short "no projects registered" /
    // "no agents online" text using the same `.app-empty` class, so an
    // unscoped locator is ambiguous (strict-mode violation).
    await expect(page.getByTestId("timeline").locator(".app-empty")).toContainText(
      "no projects registered — register a project to light the forge",
    );
  });

  // CR-CRU-007 §S5 re-target (round 6/7 lock supersedes the CR-006 rail
  // layout this test originally asserted): registering a project lights its
  // projects-row BADGE on home — home renders ZERO agent rows anywhere by
  // design (agents nest under the workspace Project pane only, §S5.2).
  test("F2: a registered project lights its projects-row badge on home (zero agent rows by design)", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "F2 Project");
    await registerAgent(request, projectKey, "agent-f2", "building the widget");

    await page.goto("/");

    const badge = page.getByTestId("project-badge").filter({ hasText: "F2 Project" });
    await expect(badge).toBeVisible();
    // Canonical badge format: name + type badge.
    await expect(badge).toContainText("backend");

    // §S5.1 — home renders 0 agent rows anywhere, even with a live agent
    // registered on the seeded project.
    await expect(page.getByTestId("agent-row")).toHaveCount(0);
  });

  // CR-CRU-007 §S5.2 re-target: liveness dots (and the tombstone path, when
  // reachable) render on the WORKSPACE Project pane's agent sub-rows —
  // agents no longer have a home-page rail to render into at all.
  test(
    "F9: liveness dots render on the workspace Project pane's agent sub-rows (tombstone path unit-covered)",
    async ({ page, request }) => {
      // LIMITATION (flagged for the orchestrator): tombstoning requires
      // silence >= T2 (300_000ms, see tests/liveness.test.ts) computed
      // server-side from a real wall-clock lastSeen. Neither the v1
      // /api/projects/add shim nor v2 POST /api/v2/projects accepts a
      // liveness/lastSeen override, and there is no HTTP lever to fast-
      // forward server time. A real E2E tombstone frame therefore needs
      // either (a) a spec-approved test-only override endpoint/param, or
      // (b) a >=5-minute real-time wait, neither of which this RED agent is
      // authorized to invent. This test asserts the CONTRACT that IS
      // reachable over HTTP (a live agent renders its liveness dot on the
      // workspace Project pane) and tolerates zero tombstoned agents being
      // present; the tombstone rendering path itself stays covered by the
      // `livenessGlyph` unit tests (tests/app-logic.test.ts) +
      // tests/liveness.test.ts.
      const projectKey = await seedProject(request, "F9 Project");
      await registerAgent(request, projectKey, "agent-f9", "still working");

      // §S5.2 — the Project pane (and its ⌁-marked agent sub-rows) exists
      // ONLY inside the workspace — navigate there first.
      await page.goto(`/p/${projectKey}`);

      const pane = page.getByTestId("project-pane");
      await expect(pane).toBeVisible();
      const agentRow = pane.getByTestId("agent-row").filter({ hasText: "agent-f9" });
      await expect(agentRow).toBeVisible();
      await expect(agentRow.locator(".app-dot")).toHaveCount(1);
      await expect(agentRow.locator(".app-dot")).toHaveClass(/\b[gyr]\b/);

      const tombstoned = pane.locator('[data-testid="agent-row"].tombstoned');
      const tombstonedCount = await tombstoned.count();
      if (tombstonedCount > 0) {
        const row = tombstoned.first();
        await expect(row).toContainText("⚰");
        await expect(row).toContainText("died");
        await expect(row).toHaveCSS("opacity", "0.45");
      }
      // else: no tombstoned agent reachable via HTTP seeding within this
      // suite's runtime budget — see LIMITATION above.
    },
  );

  // CR-CRU-007 §S5 re-target (round 6/7 final-form lock): home is title bar
  // + projects row + a FULL-WIDTH timeline (no rail at all); the workspace
  // is a full-width horizontal tabs row directly under its own top bar, then
  // a body of [content | Project pane] with NO left rail anywhere.
  test("Layout AC (final form, round 6/7 lock): home = title bar + projects row + full-width timeline; workspace = full-width tabs row + [content | Project pane], no left rail", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    // HOME — no `.app-rail` survives anywhere on the page; the timeline
    // spans (effectively) the whole `.app-main` width, not a "wide column
    // beside a rail".
    await expect(page.locator(".app-rail")).toHaveCount(0);
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toBeVisible();
    const mainBox = await page.locator(".app-main").boundingBox();
    const timelineBox = await timeline.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(timelineBox).not.toBeNull();
    expect(timelineBox!.width).toBeGreaterThan(mainBox!.width * 0.9);

    // WORKSPACE
    const projectKey = await seedProject(request, "Layout Project");
    await page.goto(`/p/${projectKey}`);

    // DOM globals (getComputedStyle/HTMLElement/children) are typed via
    // `any` here — this project's tsconfig deliberately omits the "DOM" lib
    // (server-side package), so evaluate() callbacks that touch browser
    // globals stay untyped at the boundary; they still run for real inside
    // Chromium.
    const header = page.getByTestId("workspace-header");
    await expect(header).toBeVisible();
    const tabsRow = page.getByTestId("workspace-tabs");
    await expect(tabsRow).toBeVisible();

    // Tabs row is a full-width horizontal strip directly beneath the top
    // bar — not nested inside any rail/left-column wrapper.
    const tabsParentClass = await tabsRow.evaluate(
      (el: any) => (el.parentElement?.className as string) ?? "",
    );
    expect(tabsParentClass).not.toMatch(/rail/);
    const headerBox = await header.boundingBox();
    const tabsBox = await tabsRow.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(tabsBox).not.toBeNull();
    // "directly beneath": the tabs row's top sits at (or just past) the
    // header's bottom edge, well before the workspace body starts.
    expect(tabsBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
    const workspaceBox = await page.getByTestId("workspace").boundingBox();
    expect(workspaceBox).not.toBeNull();
    expect(tabsBox!.width).toBeGreaterThan(workspaceBox!.width * 0.9);

    // Body: exactly two columns — main content (Runs pane by default) and
    // the Project pane — with NO left rail anywhere in the workspace.
    await expect(page.locator('[data-testid="workspace"] .app-rail')).toHaveCount(0);
    const runsBox = await page.getByTestId("workspace-runs").boundingBox();
    const paneBox = await page.getByTestId("project-pane").boundingBox();
    expect(runsBox).not.toBeNull();
    expect(paneBox).not.toBeNull();
    // Project pane sits to the RIGHT of the main content column.
    expect(paneBox!.x).toBeGreaterThan(runsBox!.x);
  });

  // CR-CRU-007 §S5 re-target: the SAME live-SSE contract as before, but the
  // live artifact is now the project's projects-row BADGE (home renders no
  // agent rows at all).
  test("F2b: SSE pushes a new project's badge onto the projects-row without reload", async ({
    page,
    request,
  }) => {
    // Load the shell FIRST — everything after must arrive over the live SSE
    // stream (AC: change frames repaint within 2s; no reload, no navigation).
    await page.goto("/");
    await expect(page.getByTestId("health-pill")).toBeVisible();

    const projectKey = await seedProject(request, "F2b Project");
    await registerAgent(request, projectKey, "sse-agent", "hot off the stream");

    // The 2s budget starts once the register write has been acknowledged.
    const badge = page.getByTestId("project-badge").filter({ hasText: "F2b Project" });
    await expect(badge).toBeVisible({ timeout: 2_000 });
  });

  test("nav: Esc closes the run overlay and restores scroll", async ({
    page,
    request,
  }) => {
    const projectKey = await seedProject(request, "Esc Project");
    // The overlay route needs a real event id — seed one via parsed ingest.
    const res = await request.post("/api/v2/runs/parsed", {
      data: {
        projectKey,
        agentId: "agent-esc",
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
        tree: [],
        tier: "unit",
      },
    });
    expect(res.ok()).toBe(true);
    const eventId = (await res.json() as { event: string }).event;

    await page.goto(`/p/${projectKey}/run/${eventId}`);
    const overlay = page.getByTestId("run-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText(eventId);

    await page.keyboard.press("Escape");

    // AC 10b — Esc strips the /run/<id> suffix (underlying surface path) and
    // dismisses the overlay + scrim.
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId("run-overlay-scrim")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(`/p/${projectKey}`);
    await expect(page.getByTestId("workspace")).toBeVisible();

    // Direct-load open means the saved underlying scrollY was 0 — the restore
    // lands the surface back at the top (trivial but real: scrollTo(0, 0) ran).
    const scrollY = await page.evaluate(() => (globalThis as any).scrollY as number);
    expect(scrollY).toBe(0);
  });
});

test.describe("CR-CRU-006 shell — backend liveness (own server process)", () => {
  test("F10: backend down greys the UI", async ({ page }) => {
    test.setTimeout(90_000);

    const port = 39_878;
    const baseUrl = `http://localhost:${port}`;
    const scratchCwd = mkdtempSync(path.join(tmpdir(), "crucible-e2e-f10-"));
    const env = { ...process.env, CRUCIBLE_PORT: String(port) };

    function spawnServer(): ChildProcess {
      return spawn("bun", ["run", SERVER_ENTRY], {
        cwd: scratchCwd,
        env,
        stdio: "ignore",
      });
    }

    let child = spawnServer();
    try {
      await waitForHealth(baseUrl, 15_000);
      await page.goto(baseUrl);

      const pill = page.getByTestId("health-pill");
      await expect(pill).not.toContainText("unreachable");
      await expect(pill.locator(".app-dot")).toHaveClass(/\bg\b/);

      // Kill the server out from under the running page — no reload.
      child.kill();

      // AC: "within 25 s". The frontend's own worst-case math is exactly
      // 25s (20s silence threshold + up to a 5s watchdog tick alignment);
      // 28s gives a small margin for process-kill signal delivery and CI
      // scheduling jitter without weakening the logical contract — the
      // greyed-class flip below stays tight since it is reactive to the
      // SAME `backendUp` flag flip (same VanJS render pass).
      await expect(pill).toContainText("unreachable", { timeout: 28_000 });
      await expect(page.getByTestId("timeline")).toHaveClass(/greyed/, {
        timeout: 5_000,
      });

      // Restart on the SAME port (same scratch cwd/db) — the client must
      // recover on its own via SSE reconnect / poll fallback.
      child = spawnServer();
      await waitForHealth(baseUrl, 15_000);

      await expect(pill).not.toContainText("unreachable", { timeout: 10_000 });
      await expect(page.getByTestId("timeline")).not.toHaveClass(/greyed/, {
        timeout: 10_000,
      });
    } finally {
      child.kill();
    }
  });
});
