// CR-CRU-006 §S6 — E2E harness seed (storyboard as contract — PRD §5) +
// revised §S3 layout (2026-07-15): two-column Mission Control home, timeline
// in the wide LEFT column, right rail stacking Projects ABOVE Agents, no
// left rail.
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

  test("F2: agents light up the rail", async ({ page, request }) => {
    const projectKey = await seedProject(request, "F2 Project");
    await registerAgent(request, projectKey, "agent-f2", "building the widget");

    await page.goto("/");

    // Agent row visible in the rail, carrying its message (Agent.message on
    // the wire — app.js currently reads `agent.msg`, which does not exist on
    // the API payload, so this assertion also pins down that field-name fix).
    const agentRow = page.getByTestId("agent-row").filter({ hasText: "agent-f2" });
    await expect(agentRow).toBeVisible();
    await expect(agentRow).toContainText("building the widget");

    // Revised §S3 — exactly ONE `.app-rail` as a direct child of `.app-main`:
    // today ProjectsRail() and AgentsRail() are two SEPARATE `.app-rail`
    // divs either side of the timeline (the old left rail). The revised
    // layout stacks both sections inside a single right rail.
    const rails = page.locator(".app-main > .app-rail");
    await expect(rails).toHaveCount(1);

    // Projects section precedes Agents section inside that one rail (DOM
    // order), per the revised §S3 stacking order.
    const sectionTitles = await rails.locator(".app-rail-title").allTextContents();
    expect(sectionTitles).toEqual(["projects", "agents"]);

    // Project card for the seeded project lives inside the same rail.
    await expect(rails.getByTestId("project-card")).toContainText("F2 Project");

    // Timeline (wide LEFT column) is wider than the right rail, and sits to
    // its left.
    const timelineBox = await page.getByTestId("timeline").boundingBox();
    const railBox = await rails.boundingBox();
    expect(timelineBox).not.toBeNull();
    expect(railBox).not.toBeNull();
    expect(timelineBox!.width).toBeGreaterThan(railBox!.width);
    expect(timelineBox!.x).toBeLessThan(railBox!.x);
  });

  test(
    "F9: liveness dots render (tombstone path unit-covered)",
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
      // reachable over HTTP (a live agent renders its liveness dot) and
      // tolerates zero tombstoned agents being present; the tombstone
      // rendering path itself stays covered by the `livenessGlyph` unit
      // tests (tests/app-logic.test.ts) + tests/liveness.test.ts.
      const projectKey = await seedProject(request, "F9 Project");
      await registerAgent(request, projectKey, "agent-f9", "still working");

      await page.goto("/");

      const agentRow = page.getByTestId("agent-row").filter({ hasText: "agent-f9" });
      await expect(agentRow).toBeVisible();
      await expect(agentRow.locator(".app-dot")).toHaveCount(1);
      await expect(agentRow.locator(".app-dot")).toHaveClass(/\b[gyr]\b/);

      const tombstoned = page.locator('[data-testid="agent-row"].tombstoned');
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

  test("Layout AC (revised §S3): two-column grid, projects above agents", async ({
    page,
  }) => {
    // Purely structural — independent of seeded data, so it does not rely on
    // test ordering relative to F2/F9 (though it will typically run after
    // them in this serial file).
    await page.goto("/");

    // DOM globals (getComputedStyle/HTMLElement/children) are typed via
    // `any` here — this project's tsconfig deliberately omits the "DOM" lib
    // (server-side package), so evaluate() callbacks that touch browser
    // globals stay untyped at the boundary; they still run for real inside
    // Chromium.
    const columns = await page.locator(".app-main").evaluate((el: any) => {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      return (style.gridTemplateColumns as string).trim().split(/\s+/).filter(Boolean);
    });
    expect(columns).toHaveLength(2);

    const rails = page.locator(".app-main > .app-rail");
    await expect(rails).toHaveCount(1);
    // No separate left rail: only one `.app-rail` child of `.app-main`
    // remains, and it is not the first child (timeline — the wide column —
    // comes first / left).
    const mainChildClasses = await page
      .locator(".app-main")
      .evaluate((el: any) => Array.from(el.children).map((c: any) => c.className as string));
    expect(mainChildClasses).toHaveLength(2);
    expect(mainChildClasses[0]).not.toContain("app-rail");

    const sectionTitles = await rails.locator(".app-rail-title").allTextContents();
    expect(sectionTitles).toEqual(["projects", "agents"]);
  });

  test("F2b: SSE pushes a new agent into the rail without reload", async ({
    page,
    request,
  }) => {
    // Load the shell FIRST — everything after must arrive over the live SSE
    // stream (AC: change frames repaint within 2s; no reload, no navigation).
    await page.goto("/");
    await expect(page.getByTestId("health-pill")).toBeVisible();

    const projectKey = await seedProject(request, "F2b Project");
    // NB: id must not prefix-collide with F2's "agent-f2" — hasText is a
    // substring match over the row ("agent-f2" + "building…" contains
    // "agent-f2b"), so a distinct stem keeps the locator strict-mode clean.
    await registerAgent(request, projectKey, "sse-agent", "hot off the stream");

    // The 2s budget starts once the register write has been acknowledged.
    const agentRow = page.getByTestId("agent-row").filter({ hasText: "sse-agent" });
    await expect(agentRow).toBeVisible({ timeout: 2_000 });
    await expect(agentRow).toContainText("hot off the stream");
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
