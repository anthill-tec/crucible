// CR-CRU-097 §S1/§S4 (cycle 315) — the BDD pane's empty state must not teach
// ANY project's CR namespace or a release version.
//
// AC1: "The BDD empty state names no CR and no release version; it states the
// capability and that the dedicated surface does not exist yet."
// AC3: "No user-visible string in `public/` contains a `CR-CRU-` literal.
// (Comments exempt.)"
//
// Harness: the SAME idiom as tests/roadmap-pane.test.ts / tests/workflow-tab.test.ts
// — real VanJS/VanX vendor bundles, real public/app-logic.mjs, real
// public/app.js inside a happy-dom window, with `fetch` scripted. The
// assertion runs on the RENDERED DOM text, never on app.js source, so a
// comment reference (378 of them survive by AC8) cannot fail it and a
// re-worded string cannot pass it by moving the literal into a variable.
//
// RED phase: fails against TODAY's tree, where public/app.js:2353-2354 renders
// "BDD run results already stream into the Runs timeline — the dedicated BDD
// surface lands in CR-CRU-015 (0.2.0)" — a CR id AND a release version.
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

/** Any real project's CR id shape — `CR-<NAMESPACE>-<n>` (§S2: the rule is
 * stated per-NAMESPACE, so `CR-NAI-203` is as much a defect as `CR-CRU-015`). */
const ANY_PROJECT_CR = /CR-[A-Z]{2,}-\d+/;
/** A release-version literal, `0.2.0` / `0.2` — the second half of AC1. */
const RELEASE_VERSION = /\b\d+\.\d+(?:\.\d+)?\b/;

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

let cacheBust = 0;

async function mountApp(opts: {
  pathname?: string;
  projects: ProjectFixture[];
}): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    // Order matters: the sub-collection routes all contain "/api/v2/projects".
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
      // The BDD pane renders no data of its own; any other endpoint the shell
      // polls is answered emptily rather than thrown, so this file fails only
      // on the string it is about.
      body = { ok: true };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Dynamic import with a cache-bust query is REQUIRED here (and is the
  // sibling harnesses' idiom): each mount must evaluate a FRESH
  // public/app-logic.mjs against the freshly registered happy-dom globals,
  // which a static import (evaluated once, before any window exists) cannot
  // do. The specifier is runtime-selected by construction.
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?projectIndependence=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

// Real timers, deliberately: the production shell schedules its renders
// through VanJS's own microtask/rAF pipeline inside happy-dom. Fake timers
// would have to drive a vendored bundle's internal scheduler, which the
// sibling harnesses (roadmap-pane, workflow-tab) also decline to do — they
// tick the real clock exactly as below.
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

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").trim() === text,
  ) as HTMLElement | undefined;
}

function tabButton(name: string): HTMLElement | undefined {
  return findByText(document, '[data-testid="workspace-tab"]', name);
}

function tabIsOn(name: string): boolean {
  const tab = tabButton(name);
  return tab !== undefined && tab.classList.contains("on");
}

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: Date.now(),
    ...overrides,
  };
}

/** The BDD pane's empty state, as the user sees it. */
function bddEmptyText(): string {
  const pane = document.querySelector<HTMLElement>('[data-testid="pane-scroll"] .app-empty')
    ?? document.querySelector<HTMLElement>(".app-empty");
  return (pane?.textContent ?? "").trim();
}

/**
 * Open the workspace on the BDD tab (one-rule tab swap, CR-CRU-016).
 * The project MUST be `frontend`: `workspaceTabs()` disables the BDD tab on
 * any other project type, so a `backend` fixture would never mount the pane
 * whose copy this file is about.
 */
async function mountBddTab(key: string): Promise<void> {
  await mountApp({
    pathname: `/p/${key}`,
    projects: [project({ key, name: "BDD Empty State Project", type: "frontend" })],
  });
  const tab = tabButton("BDD");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

describe("CR-CRU-097 §S4/AC1 — the BDD empty state is project-independent", () => {
  test("the rendered empty state names no project's CR id and no release version", async () => {
    await mountBddTab("bdd-empty-independent");

    // NON-VACUITY FIRST: the pane really rendered. Without this, both
    // "contains no CR id" assertions below would pass on an empty string —
    // i.e. pass because nothing was found rather than because the copy is
    // clean.
    expect(tabIsOn("BDD")).toBe(true);
    const text = bddEmptyText();
    expect(text.length).toBeGreaterThan(0);

    expect(text).not.toMatch(ANY_PROJECT_CR);
    expect(text).not.toMatch(RELEASE_VERSION);
  });

  test("the empty state still states the capability and that no dedicated surface exists yet", async () => {
    await mountBddTab("bdd-empty-capability");

    const text = bddEmptyText();
    expect(text.length).toBeGreaterThan(0);
    // AC1's positive half: the capability (results already stream into the
    // Runs timeline) and the absence (no dedicated surface yet).
    expect(text).toContain("Runs timeline");
    expect(text.toLowerCase()).toContain("does not exist yet");
  });
});
