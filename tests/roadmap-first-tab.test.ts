// CR-CRU-076 §S1/§S2 — Roadmap is FIRST in the workspace tab band.
//
// New coverage this CR owns, complementing the re-targeted order pins in
// tests/workflow-primary-tab.test.ts (AC1, pure tuple), tests/app-logic.test.ts
// (AC1, pure tuple) and tests/workflow-tab.test.ts (rendered strip):
//
//   • AC2 — the RENDERED strip's first tab is `Roadmap`, asserted against the
//     DOM rather than the tuple, so a data/render divergence is caught (the
//     tuple could be re-ordered while public/app.js renders a hand-written
//     band, or vice versa). One test asserts DOM-vs-`workspaceTabs()` PARITY
//     directly for exactly that failure mode.
//   • AC6 — the HAND-WRITTEN declaration public/app-logic.d.mts agrees with
//     the implementation: `WorkspaceTab.name` must be a union of ALL SIX tab
//     names in the new order. Today it is
//     `"Workflow" | "Runs" | "Coverage" | "Compile" | "BDD"` — `"Roadmap"` is
//     MISSING, inherited CR-CRU-014 drift (CR-076 gap analysis F3), unnoticed
//     because public/ sits outside the tsconfig include set and the order
//     tests use a local `TabShape` that bypasses the union.
//
// SUPERSESSION: CR-CRU-076 supersedes CR-CRU-021 §S1 AC1 (Workflow-first
// order), and ONLY that AC. The roadmap is the ORIGIN document — a project
// starts with roadmap creation, the CR backlog registered up front at design
// time (CR-CRU-014 §S2 `queue-file`) — and Workflow is the RUNTIME view of the
// activities tied to a roadmap CR as they execute, i.e. downstream of it.
// CR-CRU-021 predated the Roadmap tab entirely (CR-CRU-014 added it later, at
// position five), so its ordering was decided with no roadmap surface
// competing for first place.
//
// NOT superseded, and guarded here: CR-CRU-021 §S1 AC2 — entering a workspace
// still LANDS on the Workflow pane. The landing is hard-coded "Workflow"
// (public/app.js:119, 2386, 2563), never derived from TAB_NAMES[0] (gap
// analysis F1), so leading the band with Roadmap must NOT move the landing.
// The "leads the band but is not the landing" test below pins both halves in
// one place so a future re-order cannot silently drag the landing with it.
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/roadmap-pane.test.ts: real VanJS/VanX vendor
// bundles, real public/app-logic.mjs, real public/app.js; `fetch` is scripted.
//
// RED phase (CR-CRU-076): every test below fails against the CURRENT code —
// public/app-logic.mjs:75 TAB_NAMES is still
// ["Workflow","Runs","Coverage","Compile","Roadmap","BDD"] (Roadmap FIFTH),
// and public/app-logic.d.mts:65's `WorkspaceTab.name` union omits "Roadmap".
// The module-scope `DECLARED_ROADMAP_TAB` below is additionally a TYPECHECK
// RED: `bunx tsc --noEmit` rejects `name: "Roadmap"` against today's union,
// which is exactly the AC6 "declaration matches implementation, tsc clean"
// contract (bun does not typecheck, so the runtime assertions stand on their
// own).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceTabs } from "../public/app-logic.mjs";
import type { WorkspaceTab } from "../public/app-logic.mjs";

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
const APP_LOGIC_DECL_PATH = path.join(REPO_ROOT, "public/app-logic.d.mts");

/** AC1/AC2/AC6 — the one true band order this CR installs. */
const BAND_ORDER = ["Roadmap", "Workflow", "Runs", "Coverage", "Compile", "BDD"];

/**
 * AC6, typecheck arm: annotating a `"Roadmap"` tab with the PUBLISHED
 * declaration type is a `bunx tsc --noEmit` error until `WorkspaceTab.name`
 * gains the missing member. Referenced by the union test below so it is a live
 * part of the contract, not decoration.
 */
const DECLARED_ROADMAP_TAB: WorkspaceTab = { name: "Roadmap", disabled: false };

// ── Harness (same pattern as tests/roadmap-pane.test.ts) ───────────────────

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  latestCoverageEventId?: string;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
}

let cacheBust = 0;

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  // Unchecked cast, named with its reason: happy-dom's `globalThis` has a
  // real `fetch` we replace wholesale per mount, and the scripted stub is
  // narrower than the DOM lib's overloaded `fetch` type — runtime checking
  // would be meaningless here. Harness parity with tests/roadmap-pane.test.ts.
  const globalWithFetch = globalThis as unknown as { fetch: typeof fetch };
  const scriptedFetch = (async (url: string) => {
    let body: unknown;
    // Order matters: /queue, /releases and /plans all contain "/api/v2/projects".
    if (/\/api\/v2\/projects\/[^/]+\/queue/.test(url)) {
      body = { ok: true, entries: [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/releases/.test(url)) {
      body = { ok: true, releases: [] };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: [] };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`roadmap-first-tab.test.ts mountApp: unexpected fetch url ${url}`);
    }
    // Unchecked cast, named with its reason: the shell only ever reads `ok`,
    // `status` and `json()` off the response, and a full `Response` cannot be
    // constructed meaningfully inside happy-dom.
    const response = { ok: true, status: 200, json: async () => body } as Response;
    return response;
  }) as typeof fetch;
  globalWithFetch.fetch = scriptedFetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  // Dynamic import is REQUIRED here, not a preference: the specifier carries a
  // per-mount cache-busting query so each test re-evaluates the real
  // public/app-logic.mjs against a fresh happy-dom global (a static import
  // would bind one module instance across every mount).
  await import(`${APP_LOGIC_PATH}?roadmapFirstTab=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/**
 * Real macrotask ticks, deliberately: this harness drives the REAL VanJS/VanX
 * scheduler inside the production public/app.js, whose reactive flush is
 * scheduled on the platform clock. Fake timers would have to be installed
 * before app.js evaluates and would then control the framework's own
 * scheduling, so deterministic time control is not available here — same
 * mechanism as every sibling shell test (tests/roadmap-pane.test.ts).
 */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

/** The rendered band, in DOM order. */
function renderedTabNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).map((t) => (t.textContent ?? "").trim());
}

function tabButton(name: string): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
}

function tabIsOn(name: string): boolean {
  const tab = tabButton(name);
  return tab !== undefined && tab.classList.contains("on");
}

/**
 * AC6 — parse the HAND-WRITTEN `WorkspaceTab.name` union out of
 * public/app-logic.d.mts, in declaration order. The interface exists today, so
 * a parse failure here means the declaration was restructured, NOT that the
 * union is wrong — it throws loudly rather than degrading into a false pass.
 */
function declaredWorkspaceTabNames(): string[] {
  const src = readFileSync(APP_LOGIC_DECL_PATH, "utf8");
  const iface = /export interface WorkspaceTab \{([\s\S]*?)\n\}/.exec(src);
  if (iface === null) {
    throw new Error(
      `roadmap-first-tab.test.ts: no 'export interface WorkspaceTab' block found in ${APP_LOGIC_DECL_PATH}`,
    );
  }
  const nameMember = /^\s*name:\s*([^;]+);/m.exec(iface[1]!);
  if (nameMember === null) {
    throw new Error(
      `roadmap-first-tab.test.ts: no 'name:' member found in the WorkspaceTab interface of ${APP_LOGIC_DECL_PATH}`,
    );
  }
  return nameMember[1]!
    .split("|")
    .map((member) => member.trim().replace(/^"|"$/g, ""));
}

// ─────────────────────────────────────────────────────────────────────────
// AC2 — the RENDERED strip leads with Roadmap (DOM, not the tuple)
// ─────────────────────────────────────────────────────────────────────────

describe("§S1 AC2 — the rendered workspace tab strip leads with Roadmap", () => {
  test("backend project: the rendered band is exactly [Roadmap, Workflow, Runs, Coverage, Compile, BDD] and its FIRST button is Roadmap", async () => {
    const key = "roadmap-first-backend-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Roadmap First Backend", type: "backend" })],
    });

    const rendered = renderedTabNames();
    expect(rendered).toEqual(BAND_ORDER);
    expect(rendered[0]).toBe("Roadmap");
    // bound: the band is exactly six buttons — the re-order must not add,
    // drop or duplicate a tab.
    expect(rendered.length).toBe(6);
    // NEGATIVE: Workflow is no longer the first button in the band.
    expect(rendered.indexOf("Workflow")).toBe(1);
  });

  test("frontend project: the rendered band leads with Roadmap too (position is project-type-agnostic)", async () => {
    const key = "roadmap-first-frontend-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Roadmap First Frontend", type: "frontend" })],
    });

    const rendered = renderedTabNames();
    expect(rendered).toEqual(BAND_ORDER);
    expect(rendered[0]).toBe("Roadmap");
  });

  test("the rendered band matches workspaceTabs() exactly — no data/render divergence — and both lead with Roadmap", async () => {
    const key = "roadmap-first-parity-1";
    const fixture = project({ key, name: "Roadmap Parity", type: "frontend" });
    await mountApp({ pathname: `/p/${key}`, projects: [fixture] });

    const dataNames = workspaceTabs({ type: fixture.type }).map((t) => t.name);
    const rendered = renderedTabNames();

    // The divergence guard: the tuple could be re-ordered while the shell
    // renders its own order (or the reverse) — either way this fails.
    expect(rendered).toEqual(dataNames);
    expect(dataNames[0]).toBe("Roadmap");
    expect(rendered[0]).toBe("Roadmap");
  });

  test("Roadmap LEADS the band but is NOT the landing pane: cold /p/<key> still lands on Workflow (CR-CRU-021 §S1 AC2 stands)", async () => {
    const key = "roadmap-first-landing-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Roadmap First Landing" })],
    });

    // AC2 — Roadmap is first in the band…
    expect(renderedTabNames()[0]).toBe("Roadmap");
    // …AC4 — …and the landing pane is STILL Workflow, unmoved by the
    // re-order (the landing is hard-coded, never TAB_NAMES[0]).
    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);
    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();
    // NEGATIVE: leading the band did not mount the Roadmap pane on arrival.
    expect(document.querySelector('[data-testid="roadmap-empty"]')).toBeNull();
    expect(window.location.pathname).toBe(`/p/${key}`);
  });

  test("the leading Roadmap tab is enabled and activates its pane on click (position change did not gate it)", async () => {
    const key = "roadmap-first-click-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Roadmap First Click" })],
    });

    const first = tabButton("Roadmap");
    expect(renderedTabNames()[0]).toBe("Roadmap");
    expect(first).toBeDefined();
    expect(first!.hasAttribute("disabled")).toBe(false);

    first!.click();
    await settle();

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    expect(document.querySelector('[data-testid="roadmap-empty"]')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC6 — the hand-written declaration matches the implementation
// ─────────────────────────────────────────────────────────────────────────

describe("§S1 AC6 — public/app-logic.d.mts declares all six workspace tab names", () => {
  test("WorkspaceTab.name is the union of all six tab names in the new band order, including the missing 'Roadmap' (inherited CR-CRU-014 drift, F3)", () => {
    const declared = declaredWorkspaceTabNames();

    expect(declared).toEqual(BAND_ORDER);
    // The specific inherited-drift member, named so the failure reads as the
    // F3 gap rather than a generic mismatch.
    expect(declared).toContain("Roadmap");
    // The typecheck arm of this AC: the annotated value above cannot even be
    // written until the union carries the member.
    expect(declared).toContain(DECLARED_ROADMAP_TAB.name);
    expect(DECLARED_ROADMAP_TAB.disabled).toBe(false);
  });

  test("the declared name union round-trips against the implementation: workspaceTabs() emits exactly the declared names, in the declared order, for both project types", () => {
    const declared = declaredWorkspaceTabNames();

    // The map callbacks are annotated `: string` deliberately: the parsed
    // declaration is `string[]`, so comparing against the union-typed
    // `t.name` directly would leave `bunx tsc --noEmit` complaining about the
    // COMPARISON rather than about the missing union member — and AC6 wants
    // the union itself to be the only typecheck signal.
    expect(workspaceTabs({ type: "backend" }).map((t): string => t.name)).toEqual(declared);
    expect(workspaceTabs({ type: "frontend" }).map((t): string => t.name)).toEqual(declared);
  });
});
