// CR-CRU-012 §S2 (cycle 27 — "manager slide-over: list + edit + add") — the
// Projects manager slide-over reached via the home ⚙ manage chip.
//
// Spec (docs/changes/CR-CRU-012-projects-manager.md §S2 + ACs 4-6):
//   AC4 — Home projects row renders `data-testid="manage-chip"`; clicking it
//     opens `data-testid="projects-manager"` and the URL becomes `/manage`;
//     cold-loading `/manage` renders the same manager; `← home`, Esc, and
//     scrim each close it back to `/`.
//   AC5 — Adding a project via the manager form (name/type/sutRoot) creates
//     it through `POST /api/v2/projects` and its badge appears in the
//     projects row without reload (SSE).
//   AC6 — Editing a project's name in the manager updates its badge text in
//     the projects row without reload; the key shown in the manager is
//     read-only in the DOM (no input element bound to it).
//
// §S2 narrative (list + parameters + edit-in-place + add — the archive UI
// half is cycle 28's scope and is DELIBERATELY excluded here): lists every
// project (canonical name + type badge) with its parameters (sutRoot,
// liveness T1/T2/T3 showing defaults vs overrides, retention, immutable
// key); per-project edit-in-place form (name, type, sutRoot) → PATCH; +
// Add project form (name, type, sutRoot) → POST /api/v2/projects.
//
// Slide-over machinery finding (read public/app.js + public/styles.css
// before writing this file): `data-testid="manage-chip"` ALREADY EXISTS on
// the home projects row (public/app.js ProjectsRow, ~line 349) but carries
// NO onclick handler yet — "the manager surface lands in CR-CRU-012".
// `routeParse()` (public/app-logic.mjs) has NO knowledge of `/manage` at
// all: parsing "/manage" today falls through to `{page:"home"}` (not "p",
// no `/run/<id>` suffix), so a cold-load of `/manage` renders plain home,
// unchanged. There is NO reusable scrim/slide-over machinery anywhere in
// the shell: the CR-CRU-016 in-pane refactor RETIRED the old
// `run-overlay-scrim` / `app-slideover-right` right-hand-sheet pattern for
// run detail, and public/styles.css even notes (line ~482) that "/manage
// and /roadmap overlays, when they land, are a separate contract" — i.e.
// this cycle's GREEN phase defines its own scrim/slide-over from scratch.
// There is also no "+ Register a project" form/modal anywhere yet (the home
// EmptyState is a static text line, public/app.js ~line 705) — so F1's
// "same surface" cross-reference is aspirational and out of THIS file's
// scope; only the manager's OWN add-project form is pinned here.
//
// This file therefore DEFINES the new testids GREEN must satisfy:
//   `projects-manager`   (AC4, exact string) — the slide-over container.
//   `manager-scrim`       — the click-to-close scrim.
//   `manager-project-row` (+ `data-project-key`) — one row per project.
//   `manager-add-form` / `manager-add-name` / `manager-add-type` /
//     `manager-add-sutroot` / `manager-add-submit`.
//   `manager-edit-name` / `manager-edit-type` / `manager-edit-sutroot` /
//     `manager-edit-save` — scoped inside a `manager-project-row` once its
//     "edit" trigger (any element whose text contains "edit") is clicked.
//
// Server-side context (already GREEN on this branch, b077961 + dc67a4c):
// POST /api/v2/projects replies `{ok:true, changed:true, project}` wired
// through handleProjectCreate (src/v2.ts:190); PATCH /api/v2/projects/<key>
// replies `{ok:true, changed}` WITHOUT echoing the updated project
// (src/v2.ts:764-836) — so the manager MUST refetch the list to observe its
// own edit, exactly like the "without reload (SSE)" wording implies. The
// stored `Project` shape (src/types.ts:15-24) carries `liveness` using the
// STORE's internal key names (staleAfterMs/tombstoneAfterMs/pruneAfterMs —
// NOT the PATCH wire names t1_ms/t2_ms/t3_ms) and OMITS `liveness`/
// `retention` entirely (not merely null) when unset — DEFAULT_LIVENESS
// (60s/300s/1h) and DEFAULT_RETENTION (100) are client-render-time facts
// this file pins against, matching storyboard frame F12's mock text
// verbatim ("liveness T1 60s / T2 300s / T3 1h (defaults)" / "retention 100
// runs").
//
// RED phase: every test below is expected to FAIL against the CURRENT
// public/app.js — there is no `/manage` route, no manager container, no
// add/edit form, and no wiring to POST/PATCH at all.
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

interface LivenessFixture {
  staleAfterMs?: number;
  tombstoneAfterMs?: number;
  pruneAfterMs?: number;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  sutRoot?: string;
  liveness?: LivenessFixture;
  retention?: number;
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
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
let postCalls: CapturedCall[] = [];
let patchCalls: CapturedCall[] = [];

/** Same mountApp harness convention as tests/inpane-drill-in.test.ts /
 * tests/coverage-click.test.ts, extended with a mutable "server" project
 * list + POST/PATCH capture so the manager's add/edit round-trip can be
 * asserted against exact argv AND observed to update subsequent GETs
 * (mirrors the real server: POST/PATCH persist, the client refetches). */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  projectsState = (opts.projects ?? []).map((p) => ({ ...p }));
  postCalls = [];
  patchCalls = [];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;

    const patchMatch = /\/api\/v2\/projects\/([^/?]+)$/.exec(url);

    if (url.includes("/api/v2/projects") && method === "POST") {
      const parsed = (init?.body ? JSON.parse(init.body as string) : {}) as Record<
        string,
        unknown
      >;
      postCalls.push({ url, method, body: parsed });
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
      const parsed = (init?.body ? JSON.parse(init.body as string) : {}) as Record<
        string,
        unknown
      >;
      patchCalls.push({ url, method, body: parsed });
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
      throw new Error(`projects-manager.test.ts mountApp: unexpected fetch ${method} ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?projectsManager=${cacheBust}`);

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

/** Finds the first element matching `selector` under `root` whose trimmed,
 * lowercased textContent INCLUDES `needle` (case-insensitive substring —
 * mirrors the storyboard's "✎ edit" / "← home" chip labels without pinning
 * their exact glyph/markup). */
function findByText(root: ParentNode, selector: string, needle: string): HTMLElement | undefined {
  const lower = needle.toLowerCase();
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) =>
    (el.textContent ?? "").trim().toLowerCase().includes(lower),
  );
}

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

function homeBadgeTexts(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="project-badge"]')).map(
    (el) => el.textContent ?? "",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// AC4 — manage chip → /manage slide-over: open + all three close paths
// ─────────────────────────────────────────────────────────────────────────
describe("Home ⚙ manage chip → /manage slide-over (AC4)", () => {
  test("clicking the manage-chip navigates to /manage and renders the projects-manager", async () => {
    await mountApp({ pathname: "/", projects: [project({ key: "mgr-open-1", name: "Open Co" })] });

    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="projects-manager"]')).toBeNull();

    const chip = document.querySelector('[data-testid="manage-chip"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    chip!.click();
    await settle();

    expect(location.pathname).toBe("/manage");
    expect(document.querySelector('[data-testid="projects-manager"]')).not.toBeNull();
  });

  test("cold-loading /manage directly renders the same projects-manager", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-cold-1", name: "Cold Co" })],
    });

    expect(location.pathname).toBe("/manage");
    const mgr = document.querySelector('[data-testid="projects-manager"]');
    expect(mgr).not.toBeNull();
    expect(mgr!.textContent ?? "").toContain("Cold Co");
  });

  test("the '← home' chip inside the manager closes it back to / without a page reload", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-close-back-1", name: "Back Co" })],
    });
    const appRoot = document.querySelector("#app") as HTMLElement | null;
    expect(appRoot).not.toBeNull();
    appRoot!.setAttribute("data-red-marker", "still-mounted");

    const backChip = findByText(manager(), "button, [role='button'], span, a", "← home");
    expect(backChip).toBeDefined();
    backChip!.click();
    await settle();

    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="projects-manager"]')).toBeNull();
    // "no page reload" — the SAME #app root node survived the close (a real
    // navigation/reload would tear down and recreate the document).
    const appRootAfter = document.querySelector("#app") as HTMLElement | null;
    expect(appRootAfter).toBe(appRoot);
    expect(appRootAfter!.getAttribute("data-red-marker")).toBe("still-mounted");
  });

  test("pressing Escape while the manager is open closes it back to /", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-close-esc-1", name: "Esc Co" })],
    });
    expect(document.querySelector('[data-testid="projects-manager"]')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();

    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="projects-manager"]')).toBeNull();
  });

  test("clicking the scrim closes the manager back to /", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-close-scrim-1", name: "Scrim Co" })],
    });
    const scrim = document.querySelector('[data-testid="manager-scrim"]') as HTMLElement | null;
    expect(scrim).not.toBeNull();

    scrim!.click();
    await settle();

    expect(location.pathname).toBe("/");
    expect(document.querySelector('[data-testid="projects-manager"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S2 list rendering — canonical name + type badge + parameters
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — project list rendering (§S2)", () => {
  test("lists every registered project with its canonical name and type badge", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [
        project({ key: "mgr-list-be", name: "Backend Co", type: "backend" }),
        project({ key: "mgr-list-fe", name: "Frontend Co", type: "frontend" }),
      ],
    });

    const beRow = managerRow("mgr-list-be");
    expect(beRow.textContent ?? "").toContain("Backend Co");
    expect(beRow.textContent ?? "").toContain("backend");

    const feRow = managerRow("mgr-list-fe");
    expect(feRow.textContent ?? "").toContain("Frontend Co");
    expect(feRow.textContent ?? "").toContain("frontend");
  });

  test("shows each project's sutRoot", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-sutroot-1", name: "Root Co", sutRoot: "/home/dev/root-co" })],
    });

    expect(managerRow("mgr-sutroot-1").textContent ?? "").toContain("/home/dev/root-co");
  });

  test("shows liveness T1/T2/T3 as the system defaults (60s/300s/1h) with a defaults label when no override is set", async () => {
    await mountApp({
      pathname: "/manage",
      // No `liveness` key at all — mirrors the server's own omit-when-unset
      // contract (src/types.ts Project.liveness is optional; absent, not a
      // zeroed object).
      projects: [project({ key: "mgr-liveness-default-1", name: "Default Liveness Co" })],
    });

    const text = managerRow("mgr-liveness-default-1").textContent ?? "";
    expect(text).toMatch(/T1[^0-9]{0,6}60s/);
    expect(text).toMatch(/T2[^0-9]{0,6}300s/);
    expect(text).toMatch(/T3[^0-9]{0,6}1h/);
    expect(text.toLowerCase()).toContain("default");
  });

  test("shows overridden liveness T1/T2 values, with NO defaults label, when overrides are set", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [
        project({
          key: "mgr-liveness-override-1",
          name: "Override Liveness Co",
          liveness: { staleAfterMs: 120_000, tombstoneAfterMs: 600_000 },
        }),
      ],
    });

    const text = managerRow("mgr-liveness-override-1").textContent ?? "";
    expect(text).toMatch(/T1[^0-9]{0,6}120s/);
    expect(text).toMatch(/T2[^0-9]{0,6}600s/);
    expect(text.toLowerCase()).not.toContain("default");
  });

  test("shows the retention cap: the system default (100 runs) when unset", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-retention-default-1", name: "Retention Default Co" })],
    });

    const text = managerRow("mgr-retention-default-1").textContent ?? "";
    expect(text).toMatch(/100\s*runs?/i);
  });

  test("shows the retention cap: the override value (200 runs) when set, never the default", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [
        project({ key: "mgr-retention-override-1", name: "Retention Override Co", retention: 200 }),
      ],
    });

    const text = managerRow("mgr-retention-override-1").textContent ?? "";
    expect(text).toMatch(/200\s*runs?/i);
    expect(text).not.toMatch(/100\s*runs?/i);
  });

  test("renders the project key as read-only text — no input element anywhere in the manager is bound to it", async () => {
    const key = "mgr-immutable-key-777";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Immutable Key Co" })],
    });

    const row = managerRow(key);
    expect(row.textContent ?? "").toContain(key);

    const boundInputs = Array.from(manager().querySelectorAll<HTMLInputElement>("input")).filter(
      (input) => input.value === key,
    );
    expect(boundInputs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC5 — + Add project form → POST /api/v2/projects, badge appears live
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — add project (AC5)", () => {
  test("the add-project form exposes exactly name/type/sutRoot fields (no key field)", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-addform-fields-1", name: "Existing Co" })],
    });

    const addForm = document.querySelector('[data-testid="manager-add-form"]') as HTMLElement | null;
    expect(addForm).not.toBeNull();

    const fieldTestIds = Array.from(addForm!.querySelectorAll<HTMLElement>("input, select"))
      .map((el) => el.getAttribute("data-testid"))
      .sort();
    expect(fieldTestIds).toEqual(["manager-add-name", "manager-add-sutroot", "manager-add-type"]);
  });

  test("submitting the add-project form POSTs exactly {name,type,sutRoot} to /api/v2/projects", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-addform-post-1", name: "Existing Co" })],
    });

    const nameInput = document.querySelector(
      '[data-testid="manager-add-name"]',
    ) as HTMLInputElement | null;
    const typeSelect = document.querySelector(
      '[data-testid="manager-add-type"]',
    ) as HTMLSelectElement | null;
    const sutRootInput = document.querySelector(
      '[data-testid="manager-add-sutroot"]',
    ) as HTMLInputElement | null;
    const submit = document.querySelector(
      '[data-testid="manager-add-submit"]',
    ) as HTMLElement | null;
    expect(nameInput).not.toBeNull();
    expect(typeSelect).not.toBeNull();
    expect(sutRootInput).not.toBeNull();
    expect(submit).not.toBeNull();

    nameInput!.value = "New Proj";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    typeSelect!.value = "frontend";
    typeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    sutRootInput!.value = "/tmp/new-proj";
    sutRootInput!.dispatchEvent(new Event("input", { bubbles: true }));

    submit!.click();
    await settle();

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.url).toContain("/api/v2/projects");
    expect(postCalls[0]!.body).toEqual({
      name: "New Proj",
      type: "frontend",
      sutRoot: "/tmp/new-proj",
    });
  });

  test("after a successful add, the new project's badge appears in the home projects row without a page reload", async () => {
    await mountApp({
      pathname: "/manage",
      projects: [project({ key: "mgr-addform-live-1", name: "Existing Co" })],
    });
    const appRoot = document.querySelector("#app") as HTMLElement | null;
    expect(appRoot).not.toBeNull();
    appRoot!.setAttribute("data-red-marker", "still-mounted");

    const nameInput = document.querySelector(
      '[data-testid="manager-add-name"]',
    ) as HTMLInputElement | null;
    const typeSelect = document.querySelector(
      '[data-testid="manager-add-type"]',
    ) as HTMLSelectElement | null;
    const sutRootInput = document.querySelector(
      '[data-testid="manager-add-sutroot"]',
    ) as HTMLInputElement | null;
    const submit = document.querySelector(
      '[data-testid="manager-add-submit"]',
    ) as HTMLElement | null;
    expect(nameInput).not.toBeNull();
    expect(typeSelect).not.toBeNull();
    expect(sutRootInput).not.toBeNull();
    expect(submit).not.toBeNull();

    nameInput!.value = "Live Badge Co";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    typeSelect!.value = "backend";
    typeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    sutRootInput!.value = "/tmp/live-badge-co";
    sutRootInput!.dispatchEvent(new Event("input", { bubbles: true }));

    submit!.click();
    await settle();
    expect(postCalls).toHaveLength(1);

    // Close back to home (§S2 level model) — same document throughout.
    const backChip = findByText(manager(), "button, [role='button'], span, a", "← home");
    expect(backChip).toBeDefined();
    backChip!.click();
    await settle();

    expect(location.pathname).toBe("/");
    const appRootAfter = document.querySelector("#app") as HTMLElement | null;
    expect(appRootAfter).toBe(appRoot);
    expect(appRootAfter!.getAttribute("data-red-marker")).toBe("still-mounted");

    const texts = homeBadgeTexts();
    expect(texts.some((t) => t.includes("Live Badge Co"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC6 — edit-in-place → PATCH /api/v2/projects/<key>, badge updates live,
// immutable key stays read-only even while editing
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — edit-in-place (AC6)", () => {
  test("opening edit-in-place for a project reveals a name input pre-filled with its current name", async () => {
    const key = "mgr-edit-open-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Edit Me" })],
    });

    const row = managerRow(key);
    const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
    expect(editTrigger).toBeDefined();
    editTrigger!.click();
    await settle();

    const nameInput = managerRow(key).querySelector(
      '[data-testid="manager-edit-name"]',
    ) as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(nameInput!.value).toBe("Edit Me");
  });

  test("saving an edited name PATCHes /api/v2/projects/<key> with {name:...} and never sends the immutable key", async () => {
    const key = "mgr-edit-patch-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Before Name" })],
    });

    const row = managerRow(key);
    const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
    expect(editTrigger).toBeDefined();
    editTrigger!.click();
    await settle();

    const nameInput = managerRow(key).querySelector(
      '[data-testid="manager-edit-name"]',
    ) as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    nameInput!.value = "NAI-2";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const saveButton = managerRow(key).querySelector(
      '[data-testid="manager-edit-save"]',
    ) as HTMLElement | null;
    expect(saveButton).not.toBeNull();
    saveButton!.click();
    await settle();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.url).toContain(`/api/v2/projects/${key}`);
    expect(patchCalls[0]!.body.name).toBe("NAI-2");
    // bound (§S1 contract, src/v2.ts:771-773): the immutable key is NEVER
    // part of a PATCH body — a manager that echoed it back would 400 for
    // real against the live server.
    expect(Object.prototype.hasOwnProperty.call(patchCalls[0]!.body, "projectKey")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(patchCalls[0]!.body, "key")).toBe(false);
  });

  test("after a successful name edit, the badge text in the home projects row updates without a page reload", async () => {
    const key = "mgr-edit-live-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Old Badge Name" })],
    });
    const appRoot = document.querySelector("#app") as HTMLElement | null;
    expect(appRoot).not.toBeNull();
    appRoot!.setAttribute("data-red-marker", "still-mounted");

    const row = managerRow(key);
    const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
    expect(editTrigger).toBeDefined();
    editTrigger!.click();
    await settle();

    const nameInput = managerRow(key).querySelector(
      '[data-testid="manager-edit-name"]',
    ) as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    nameInput!.value = "New Badge Name";
    nameInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const saveButton = managerRow(key).querySelector(
      '[data-testid="manager-edit-save"]',
    ) as HTMLElement | null;
    expect(saveButton).not.toBeNull();
    saveButton!.click();
    await settle();
    expect(patchCalls).toHaveLength(1);

    const backChip = findByText(manager(), "button, [role='button'], span, a", "← home");
    expect(backChip).toBeDefined();
    backChip!.click();
    await settle();

    expect(location.pathname).toBe("/");
    const appRootAfter = document.querySelector("#app") as HTMLElement | null;
    expect(appRootAfter).toBe(appRoot);
    expect(appRootAfter!.getAttribute("data-red-marker")).toBe("still-mounted");

    const texts = homeBadgeTexts();
    expect(texts.some((t) => t.includes("New Badge Name"))).toBe(true);
    expect(texts.some((t) => t.includes("Old Badge Name"))).toBe(false);
  });

  test("the project key remains read-only (no bound input) even while edit-in-place is open", async () => {
    const key = "mgr-edit-key-readonly-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Readonly While Editing Co" })],
    });

    const row = managerRow(key);
    const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
    expect(editTrigger).toBeDefined();
    editTrigger!.click();
    await settle();

    const boundInputs = Array.from(manager().querySelectorAll<HTMLInputElement>("input")).filter(
      (input) => input.value === key,
    );
    expect(boundInputs).toHaveLength(0);
  });
});
