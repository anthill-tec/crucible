// CR-CRU-012 §S2 (cycle 28 — "archive UI + e2e feature") — the Projects
// manager's archive/unarchive half, deliberately excluded from cycle 27's
// tests/projects-manager.test.ts (list + edit-in-place + add).
//
// Spec (docs/changes/CR-CRU-012-projects-manager.md §S2 + the §S1b AC):
//   "Per-project archive action (with confirm) + an 'archived (N)' fold at
//   the bottom listing archived projects with an unarchive action."
//   AC: "the manager renders an archive action per project and an
//   `archived (N)` fold with an unarchive action; archiving from the
//   manager removes the badge from the home projects row without reload
//   (SSE)."
//
// Server-side (§S1b, already GREEN — cycles 25-26): POST
// /api/v2/projects/<key>/archive and .../unarchive reply `{ok:true}`;
// default GET /api/v2/projects EXCLUDES archived projects; GET
// /api/v2/projects?archived=true lists ONLY archived projects. This file's
// mock fetch mirrors that split-listing contract with two independent
// server-side arrays (`projectsState` / `archivedProjectsState`) so the
// manager's own fetch strategy (whenever/however GREEN chooses to pull the
// archived list) is exercised honestly rather than assumed.
//
// New testids this file DEFINES (GREEN must satisfy — none of these exist
// on the branch yet; every test below is expected to FAIL/error against
// the current public/app.js, which has no archive/unarchive UI at all):
//   `manager-archive`         — per-row archive trigger (first click).
//   `manager-archive-confirm` — per-row in-row confirm affordance that
//     appears after the first click; a SECOND click on THIS element fires
//     the archive POST. Only one row's confirm is pending at a time —
//     clicking another row's `manager-archive` resets any other row's
//     pending confirm.
//   `manager-archived-fold`   — the fold's clickable header; its
//     textContent is EXACTLY `archived (N)` (N = archived count). Absent
//     entirely when N=0 (no "archived (0)" ever rendered). Collapsed by
//     default; clicking it toggles the archived-row list open/shut.
//   `manager-archived-row` (+ `data-project-key`) — one row per archived
//     project inside the fold, rendered only while the fold is expanded;
//     shows the project's name and a `manager-unarchive` action.
//   `manager-unarchive`       — per-archived-row unarchive trigger.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  sutRoot?: string;
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  archivedProjects?: ProjectFixture[];
}

interface CapturedCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    sutRoot: `/tmp/${overrides.key}`,
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

let cacheBust = 0;
let projectsState: ProjectFixture[] = [];
let archivedProjectsState: ProjectFixture[] = [];
let archiveCalls: CapturedCall[] = [];
let unarchiveCalls: CapturedCall[] = [];

/** Same mountApp harness convention as tests/projects-manager.test.ts,
 * extended with a SEPARATE archived-projects "server" array + archive/
 * unarchive capture, mirroring the real server's split-listing contract
 * (default GET excludes archived; `?archived=true` lists ONLY archived). */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  projectsState = (opts.projects ?? []).map((p) => ({ ...p }));
  archivedProjectsState = (opts.archivedProjects ?? []).map((p) => ({ ...p }));
  archiveCalls = [];
  unarchiveCalls = [];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;

    const archiveMatch = /\/api\/v2\/projects\/([^/?]+)\/archive$/.exec(url);
    const unarchiveMatch = /\/api\/v2\/projects\/([^/?]+)\/unarchive$/.exec(url);
    const patchMatch = /\/api\/v2\/projects\/([^/?]+)$/.exec(url);

    const parsedBody = (): Record<string, unknown> =>
      init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};

    if (archiveMatch !== null && method === "POST") {
      const key = decodeURIComponent(archiveMatch[1]!);
      const parsed = parsedBody();
      archiveCalls.push({ url, method, body: parsed });
      const idx = projectsState.findIndex((p) => p.key === key);
      if (idx !== -1) {
        const [moved] = projectsState.splice(idx, 1);
        archivedProjectsState.push(moved!);
      }
      body = { ok: true };
    } else if (unarchiveMatch !== null && method === "POST") {
      const key = decodeURIComponent(unarchiveMatch[1]!);
      const parsed = parsedBody();
      unarchiveCalls.push({ url, method, body: parsed });
      const idx = archivedProjectsState.findIndex((p) => p.key === key);
      if (idx !== -1) {
        const [moved] = archivedProjectsState.splice(idx, 1);
        projectsState.push(moved!);
      }
      body = { ok: true };
    } else if (url.includes("/api/v2/projects") && url.includes("archived=true")) {
      body = { ok: true, projects: archivedProjectsState };
    } else if (url.includes("/api/v2/projects") && method === "POST") {
      const parsed = parsedBody();
      const created: ProjectFixture = {
        key: typeof parsed.key === "string" ? parsed.key : `generated-${projectsState.length + 1}`,
        name: typeof parsed.name === "string" ? parsed.name : "",
        type: parsed.type === "frontend" ? "frontend" : "backend",
        sutRoot: typeof parsed.sutRoot === "string" ? parsed.sutRoot : "",
        agentsOnline: 0,
        agentsTotal: 0,
        active: true,
        lastActivity: Date.now(),
      };
      projectsState.push(created);
      body = { ok: true, changed: true, project: created };
    } else if (patchMatch !== null && method === "PATCH") {
      const key = decodeURIComponent(patchMatch[1]!);
      const parsed = parsedBody();
      const target = projectsState.find((p) => p.key === key);
      if (target !== undefined) Object.assign(target, parsed);
      body = { ok: true, changed: true };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: projectsState };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`manager-archive.test.ts mountApp: unexpected fetch ${method} ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?managerArchive=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function manager(): HTMLElement {
  const el = document.querySelector('[data-testid="projects-manager"]') as HTMLElement | null;
  if (el === null) throw new Error("projects-manager container not found");
  return el;
}

function managerRow(key: string): HTMLElement {
  const el = document.querySelector(
    `[data-testid="manager-project-row"][data-project-key="${key}"]`,
  ) as HTMLElement | null;
  if (el === null) throw new Error(`manager-project-row not found for key ${key}`);
  return el;
}

function findManagerRow(key: string): HTMLElement | null {
  return document.querySelector(
    `[data-testid="manager-project-row"][data-project-key="${key}"]`,
  ) as HTMLElement | null;
}

function archivedRow(key: string): HTMLElement | null {
  return document.querySelector(
    `[data-testid="manager-archived-row"][data-project-key="${key}"]`,
  ) as HTMLElement | null;
}

function archivedFold(): HTMLElement | null {
  return document.querySelector('[data-testid="manager-archived-fold"]') as HTMLElement | null;
}

function homeBadgeTexts(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="project-badge"]')).map(
    (el) => el.textContent ?? "",
  );
}

function archiveTrigger(key: string): HTMLElement {
  const el = managerRow(key).querySelector('[data-testid="manager-archive"]') as HTMLElement | null;
  if (el === null) throw new Error(`manager-archive not found for key ${key}`);
  return el;
}

function archiveConfirm(key: string): HTMLElement | null {
  const row = findManagerRow(key);
  if (row === null) return null;
  return row.querySelector('[data-testid="manager-archive-confirm"]') as HTMLElement | null;
}

// ── per-row archive action + confirm gating ─────────────────────────────
describe("Projects manager — per-row archive action (§S1b AC)", () => {
  test("every manager-project-row renders a manager-archive trigger", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "arc-trigger-1", name: "Trigger Co" })],
    });

    expect(archiveConfirm("arc-trigger-1")).toBeNull();
    expect(archiveTrigger("arc-trigger-1")).toBeDefined();
  });

  test("a single unconfirmed click on manager-archive fires NO network call, and reveals manager-archive-confirm in-row", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "arc-unconfirmed-1", name: "Unconfirmed Co" })],
    });

    archiveTrigger("arc-unconfirmed-1").click();
    await settle();

    expect(archiveCalls).toHaveLength(0);
    expect(archiveConfirm("arc-unconfirmed-1")).not.toBeNull();
    // the row must still exist (not archived yet)
    expect(findManagerRow("arc-unconfirmed-1")).not.toBeNull();
  });

  test("a second click on manager-archive-confirm POSTs /api/v2/projects/<key>/archive with an empty body, then removes the row from the active list", async () => {
    const key = "arc-confirmed-1";
    await mountApp({ pathname: "/manage", projects: [project({ key, name: "Confirmed Co" })] });

    archiveTrigger(key).click();
    await settle();
    const confirmEl = archiveConfirm(key);
    expect(confirmEl).not.toBeNull();
    confirmEl!.click();
    await settle();

    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]!.method).toBe("POST");
    expect(archiveCalls[0]!.url).toContain(`/api/v2/projects/${key}/archive`);
    expect(archiveCalls[0]!.url).not.toContain("/unarchive");
    expect(archiveCalls[0]!.body).toEqual({});

    expect(findManagerRow(key)).toBeNull();
  });

  test("archiving one project removes ONLY its badge from the home projects row, live, without closing the manager (SSE-equivalent refetch)", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [
        project({ key: "arc-badge-1", name: "Badge Gone Co" }),
        project({ key: "arc-badge-2", name: "Badge Stays Co" }),
      ],
    });
    const appRoot = document.querySelector("#app") as HTMLElement | null;
    expect(appRoot).not.toBeNull();
    appRoot!.setAttribute("data-red-marker", "still-mounted");

    expect(homeBadgeTexts().some((t) => t.includes("Badge Gone Co"))).toBe(true);

    archiveTrigger("arc-badge-1").click();
    await settle();
    archiveConfirm("arc-badge-1")!.click();
    await settle();

    // home is mounted BENEATH the slide-over (§S2 level model) — the badge
    // disappears live, with the SAME #app root still mounted (no reload).
    const appRootAfter = document.querySelector("#app") as HTMLElement | null;
    expect(appRootAfter).toBe(appRoot);
    expect(appRootAfter!.getAttribute("data-red-marker")).toBe("still-mounted");

    const texts = homeBadgeTexts();
    expect(texts.some((t) => t.includes("Badge Gone Co"))).toBe(false);
    expect(texts.some((t) => t.includes("Badge Stays Co"))).toBe(true);
  });

  test("clicking a DIFFERENT row's manager-archive resets any other row's pending confirm — only one pending confirm at a time, and no archive call fires until an actual confirm click", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [
        project({ key: "arc-pending-a", name: "Pending A Co" }),
        project({ key: "arc-pending-b", name: "Pending B Co" }),
      ],
    });

    archiveTrigger("arc-pending-a").click();
    await settle();
    expect(archiveConfirm("arc-pending-a")).not.toBeNull();
    expect(archiveConfirm("arc-pending-b")).toBeNull();

    archiveTrigger("arc-pending-b").click();
    await settle();
    expect(archiveConfirm("arc-pending-b")).not.toBeNull();
    // row A's pending confirm was reset by clicking row B's trigger
    expect(archiveConfirm("arc-pending-a")).toBeNull();

    expect(archiveCalls).toHaveLength(0);
  });
});

// ── archived (N) fold ────────────────────────────────────────────────────
describe("Projects manager — archived (N) fold (§S1b AC)", () => {
  test("the archived fold is ABSENT when there are no archived projects (never renders 'archived (0)')", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "fold-empty-1", name: "No Archives Co" })],
      archivedProjects: [],
    });

    expect(archivedFold()).toBeNull();
  });

  test("the archived fold header reads exactly 'archived (N)' for the archived count, and is collapsed by default (no manager-archived-row rendered yet)", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "fold-count-active-1", name: "Still Active Co" })],
      archivedProjects: [
        project({ key: "fold-count-arch-1", name: "Archived One Co" }),
        project({ key: "fold-count-arch-2", name: "Archived Two Co" }),
      ],
    });

    const fold = archivedFold();
    expect(fold).not.toBeNull();
    expect((fold!.textContent ?? "").trim()).toBe("archived (2)");
    expect(document.querySelectorAll('[data-testid="manager-archived-row"]')).toHaveLength(0);
  });

  test("clicking the archived fold header expands it to reveal one manager-archived-row per archived project, each showing its name and a manager-unarchive action", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [],
      archivedProjects: [project({ key: "fold-expand-1", name: "Expandable Archived Co" })],
    });

    expect(document.querySelectorAll('[data-testid="manager-archived-row"]')).toHaveLength(0);

    archivedFold()!.click();
    await settle();

    const rows = document.querySelectorAll('[data-testid="manager-archived-row"]');
    expect(rows).toHaveLength(1);
    const row = archivedRow("fold-expand-1");
    expect(row).not.toBeNull();
    expect(row!.textContent ?? "").toContain("Expandable Archived Co");
    expect(row!.querySelector('[data-testid="manager-unarchive"]')).not.toBeNull();
  });
});

// ── unarchive round-trip ─────────────────────────────────────────────────
describe("Projects manager — unarchive action (§S1b AC)", () => {
  test("clicking manager-unarchive POSTs /api/v2/projects/<key>/unarchive with an empty body, moves the project back to the active manager list, and decrements the fold count", async () => {
    const key = "unarch-round-1";
    await mountApp({
      pathname: "/manage",
      projects: [],
      archivedProjects: [project({ key, name: "Round Trip Archived Co" })],
    });

    expect(findManagerRow(key)).toBeNull();
    archivedFold()!.click();
    await settle();

    const unarchiveBtn = archivedRow(key)!.querySelector(
      '[data-testid="manager-unarchive"]',
    ) as HTMLElement | null;
    expect(unarchiveBtn).not.toBeNull();
    unarchiveBtn!.click();
    await settle();

    expect(unarchiveCalls).toHaveLength(1);
    expect(unarchiveCalls[0]!.method).toBe("POST");
    expect(unarchiveCalls[0]!.url).toContain(`/api/v2/projects/${key}/unarchive`);
    expect(unarchiveCalls[0]!.url).not.toMatch(/\/archive$/);
    expect(unarchiveCalls[0]!.body).toEqual({});

    // project is back in the active manager list
    expect(findManagerRow(key)).not.toBeNull();
    expect(managerRow(key).textContent ?? "").toContain("Round Trip Archived Co");

    // the fold count decremented to 0 — the fold disappears entirely
    expect(archivedFold()).toBeNull();
    expect(document.querySelectorAll('[data-testid="manager-archived-row"]')).toHaveLength(0);
  });

  test("after unarchiving, the project's badge reappears in the home projects row without a page reload", async () => {
    const key = "unarch-badge-1";
    await mountApp({
      pathname: "/manage",
      projects: [],
      archivedProjects: [project({ key, name: "Badge Returns Co" })],
    });
    const appRoot = document.querySelector("#app") as HTMLElement | null;
    expect(appRoot).not.toBeNull();
    appRoot!.setAttribute("data-red-marker", "still-mounted");

    expect(homeBadgeTexts().some((t) => t.includes("Badge Returns Co"))).toBe(false);

    archivedFold()!.click();
    await settle();
    const unarchiveBtn = archivedRow(key)!.querySelector(
      '[data-testid="manager-unarchive"]',
    ) as HTMLElement | null;
    expect(unarchiveBtn).not.toBeNull();
    unarchiveBtn!.click();
    await settle();

    const appRootAfter = document.querySelector("#app") as HTMLElement | null;
    expect(appRootAfter).toBe(appRoot);
    expect(appRootAfter!.getAttribute("data-red-marker")).toBe("still-mounted");

    expect(homeBadgeTexts().some((t) => t.includes("Badge Returns Co"))).toBe(true);
  });

  test("unarchiving one of two archived projects leaves the other archived, with the fold count at 'archived (1)'", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [],
      archivedProjects: [
        project({ key: "unarch-multi-1", name: "Stays Archived Co" }),
        project({ key: "unarch-multi-2", name: "Leaves Archive Co" }),
      ],
    });

    archivedFold()!.click();
    await settle();

    const unarchiveBtn = archivedRow("unarch-multi-2")!.querySelector(
      '[data-testid="manager-unarchive"]',
    ) as HTMLElement | null;
    expect(unarchiveBtn).not.toBeNull();
    unarchiveBtn!.click();
    await settle();

    expect(unarchiveCalls).toHaveLength(1);
    expect(unarchiveCalls[0]!.url).toContain("unarch-multi-2/unarchive");

    expect(findManagerRow("unarch-multi-2")).not.toBeNull();
    expect(archivedRow("unarch-multi-1")).not.toBeNull();
    const fold = archivedFold();
    expect(fold).not.toBeNull();
    expect((fold!.textContent ?? "").trim()).toBe("archived (1)");
  });
});
