// CR-CRU-007 — Integration AC (§nav table): "coverage meter click on a
// project card opens the drill-in of the event whose id equals the
// project's latest-green-coverage event." Two halves:
//
//  (A) SERVER — the v2 projects listing (GET /api/v2/projects) does not
//      today expose WHICH event backs `latestGreenCoverage` — only the
//      coverage payload itself (src/v2.ts handleProjectsList:
//      `latestGreenCoverage: greenCovered?.coverage ?? null`). Without an
//      id, the client has nothing to navigate to. This adds the missing
//      field: `latestCoverageEventId` — the id of that SAME `greenCovered`
//      event (§S4 CR-CRU-001 discard-on-fail: only a green/all-pass run's
//      coverage is ever stored, so "latest coverage event" and "latest
//      green-coverage event" are the same event) — present ONLY when a
//      green coverage run exists, ABSENT (not merely null) otherwise.
//
//  (B) CLIENT — the workspace Project pane's coverage meter
//      (public/app.js CoverageMeter(), rendered from ProjectPaneCard()) is
//      today a static, non-interactive div (no onclick, no data-testid —
//      confirmed by reading public/app.js:600-613). This pins the click
//      wiring: clicking the meter navigates to `/p/<key>/run/<id>` where
//      <id> is `project.latestCoverageEventId`, and opens the real drill-in
//      overlay. Home project badges (`ProjectBadge`, public/app.js:282-292)
//      keep their EXISTING drill-DOWN-to-workspace behaviour — a coverage
//      meter does not render on home at all, and a badge click must never
//      produce a `/run/<id>` route.
//
// RED phase: (A) is expected to fail — `latestCoverageEventId` does not
// exist anywhere in src/v2.ts today. (B) is expected to fail — CoverageMeter
// renders no `data-testid="coverage-meter"` and no onclick handler today.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";
import type { Store } from "../src/store.ts";
import type { Coverage } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────
// (A) SERVER — GET /api/v2/projects carries latestCoverageEventId
// ─────────────────────────────────────────────────────────────────────────

interface ProjectRollupWithCoverageId {
  key: string;
  latestGreenCoverage: unknown;
  latestCoverageEventId?: string;
}

interface ProjectsRollupResponse {
  ok: true;
  projects: ProjectRollupWithCoverageId[];
}

const GREEN: Coverage = { lines: { total: 10, covered: 8, percent: 80 } };

describe("GET /api/v2/projects — latestCoverageEventId (integration AC, §nav table)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function projectsList(): Promise<ProjectRollupWithCoverageId[]> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/projects`);
    const body = (await res.json()) as ProjectsRollupResponse;
    return body.projects;
  }

  test("a green (all-pass) run with coverage sets latestCoverageEventId to that event's id", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "cov-id-1", type: "backend", sutRoot: "/tmp/cov-id-1" });

    const ev = store.recordTestEvent(
      key,
      "agent-cov-1",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 100 },
        tree: [],
        coverage: GREEN,
      },
      { tier: "unit" },
    );

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.latestCoverageEventId).toBe(ev.id);
  });

  test("fresh project with no green-coverage run: latestCoverageEventId is ABSENT from the payload (not merely null)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "cov-id-2", type: "backend", sutRoot: "/tmp/cov-id-2" });

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.latestGreenCoverage).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(project, "latestCoverageEventId")).toBe(false);
  });

  test("two green-coverage runs: latestCoverageEventId matches the NEWEST event, not the first", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "cov-id-3", type: "backend", sutRoot: "/tmp/cov-id-3" });

    const first = store.recordTestEvent(
      key,
      "agent-cov-3a",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 100 },
        tree: [],
        coverage: { lines: { total: 10, covered: 5, percent: 50 } },
      },
      { tier: "unit" },
    );
    const second = store.recordTestEvent(
      key,
      "agent-cov-3b",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 100 },
        tree: [],
        coverage: { lines: { total: 10, covered: 9, percent: 90 } },
      },
      { tier: "unit" },
    );
    expect(first.id).not.toBe(second.id);

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.latestCoverageEventId).toBe(second.id);
    expect(project!.latestCoverageEventId).not.toBe(first.id);
  });

  test("a FAILING run carrying a coverage payload never sets latestCoverageEventId (§S4 discard-on-fail)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store: Store = handle.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "cov-id-4", type: "backend", sutRoot: "/tmp/cov-id-4" });

    store.recordTestEvent(
      key,
      "agent-cov-4",
      {
        summary: { total: 5, passed: 3, failed: 2, pending: 0, duration_ms: 100 },
        tree: [],
        coverage: GREEN,
      },
      { tier: "unit" },
    );

    const projects = await projectsList();
    const project = projects.find((p) => p.key === key);
    expect(project).toBeDefined();
    expect(project!.latestGreenCoverage).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(project, "latestCoverageEventId")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (B) CLIENT — workspace coverage meter is click-wired to the drill-in
// ─────────────────────────────────────────────────────────────────────────
//
// Boots the REAL public/app.js shell inside happy-dom, exactly the harness
// convention established by tests/shell-final-form.test.ts (real VanJS/
// VanX vendor bundles, real public/app-logic.mjs, real public/app.js —
// only `fetch` is scripted).

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  lastEvent?: unknown;
  latestGreenCoverage?: unknown;
  latestCoverageEventId?: string;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
}

let cacheBust = 0;

/** See tests/shell-final-form.test.ts for the full harness rationale. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: [] };
    else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`coverage-click.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?coverageClick=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("workspace Project pane — coverage meter click wiring (integration AC, §nav table)", () => {
  // Scoped to THIS describe block only — the server-side (A) tests above
  // never register happy-dom, so a file-level afterEach would try to
  // unregister a registration that never happened and mask their real
  // pass/fail result with a spurious "Happy DOM has not previously been
  // globally registered" error.
  afterEach(async () => {
    await GlobalRegistrator.unregister();
  });

  test("clicking the coverage meter navigates to /p/<key>/run/<id> and opens the real drill-in overlay", async () => {
    const projectKey = "cov-click-p1";
    const eventId = "evt-cov-click-1";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        {
          key: projectKey,
          name: "Coverage Click Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          active: true,
          lastActivity: now,
          lastEvent: null,
          latestGreenCoverage: { lines: { covered: 8, total: 10, percent: 80 } },
          latestCoverageEventId: eventId,
        },
      ],
    });

    const pane = document.querySelector('[data-testid="project-pane"]');
    expect(pane).not.toBeNull();
    const meter = pane!.querySelector('[data-testid="coverage-meter"]') as HTMLElement | null;
    expect(meter).not.toBeNull();

    meter!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}/run/${eventId}`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent ?? "").toContain(eventId);
  });

  test("with NO green-coverage event (latestCoverageEventId absent), the meter renders 'no coverage yet' and is NOT clickable", async () => {
    const projectKey = "cov-click-p2";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${projectKey}`,
      projects: [
        {
          key: projectKey,
          name: "No Coverage Project",
          type: "backend",
          agentsOnline: 1,
          agentsTotal: 1,
          active: true,
          lastActivity: now,
          lastEvent: null,
          latestGreenCoverage: null,
          // latestCoverageEventId intentionally absent — mirrors the server
          // contract asserted in describe block (A) above.
        },
      ],
    });

    const pane = document.querySelector('[data-testid="project-pane"]');
    expect(pane).not.toBeNull();
    const noCoverageEl = Array.from(pane!.querySelectorAll<HTMLElement>("div")).find(
      (el) => (el.textContent ?? "").trim() === "no coverage yet",
    );
    expect(noCoverageEl).toBeDefined();

    noCoverageEl!.click();
    await settle();

    // bound: no navigation into a (nonexistent) drill-in happened.
    expect(location.pathname).toBe(`/p/${projectKey}`);
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
  });

  test("home project-badge click still drills DOWN to the workspace (/p/<key>) — never straight to a run drill-in, even when the project has coverage", async () => {
    const projectKey = "cov-click-home-1";
    const eventId = "evt-cov-click-home-1";
    const now = Date.now();
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: projectKey,
          name: "Home Coverage Project",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: now,
          latestGreenCoverage: { lines: { covered: 8, total: 10, percent: 80 } },
          latestCoverageEventId: eventId,
        },
      ],
    });

    const badge = document.querySelector('[data-testid="project-badge"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    // bound: home renders no coverage meter at all (that's a workspace-only
    // Project pane element) — the badge is the only clickable surface.
    expect(document.querySelector('[data-testid="coverage-meter"]')).toBeNull();

    badge!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${projectKey}`);
    expect(location.pathname).not.toContain(`/run/${eventId}`);
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
  });
});
