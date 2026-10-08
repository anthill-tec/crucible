// CR-CRU-174 §S3 (issues 6 + 7) — the projects manager (`/manage`) redrawn
// per the approved storyboard frame F12, "Redrawn for CR-CRU-171 issues 6 +
// 7" (.lavish/crucible-v2-design.html, APPROVED 2026-10-08): each project
// card's facts render on their OWN lines (never one joined string), the
// liveness thresholds are grouped and named by what happens to the agent —
// "Agent liveness" (Shown as stale after / Tombstoned after / Removed
// after, each with its own one-line explanation) — retention sits apart as
// its own "Run history" group ("Keep the last" N runs), and "T1"/"T2"/"T3"
// never appear anywhere on the page.
//
// Today (verified, `livenessLabel`/`ManagerRowView`/`ManagerRowEdit` in
// public/app.js) the card's meta line is ONE joined string
// ("sutRoot: … · liveness T1 60s / T2 300s / T3 1h (defaults) · retention
// N runs · key … (immutable)") and the edit form's liveness captions read
// "Stale after (T1, seconds)" / "Tombstone after (T2, seconds)" / "Prune
// after (T3, seconds)" with no grouping at all — every test below is
// expected to FAIL against the CURRENT public/app.js.
//
// This file does NOT assert the exact unit-formatting algorithm (whether a
// duration prints as "300s" or "5m") — the dispatch for this cycle itself
// states the card's duration facts as generic `<x>`/`<y>`/`<z>` rather than
// quoting the frame's own illustrative numbers, so fixture values here are
// chosen to be unambiguous under either a seconds-only or a unit-aware
// formatter (no value divides evenly into a minute or an hour except where
// the test deliberately wants the "1h" boundary, which both formats agree
// on). See this agent's final report for the explicit note.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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
  allowRunDeletion?: boolean;
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
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

/** Minimal mountApp — this file never asserts PATCH argv, only DOM wording
 * and structure, so the fetch mock is a passthrough (same convention as
 * tests/manager-settings-labels.test.ts). */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  projectsState = (opts.projects ?? []).map((p) => ({ ...p }));

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;

    const patchMatch = /\/api\/v2\/projects\/([^/?]+)$/.exec(url);

    if (patchMatch !== null && method === "PATCH") {
      const key = decodeURIComponent(patchMatch[1]!);
      const parsed = (init?.body ? JSON.parse(init.body as string) : {}) as Record<
        string,
        unknown
      >;
      const target = projectsState.find((p) => p.key === key);
      if (target !== undefined) Object.assign(target, parsed);
      body = { ok: true, changed: true };
    } else if (url.includes("/api/v2/projects") && url.includes("archived=true")) {
      body = { ok: true, projects: [] };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: projectsState };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`manager-drawer-grouped-liveness.test.ts mountApp: unexpected fetch ${method} ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?managerDrawerGroupedLiveness=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 10): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function findByText(root: ParentNode, selector: string, needle: string): HTMLElement | undefined {
  const lower = needle.toLowerCase();
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) =>
    (el.textContent ?? "").trim().toLowerCase().includes(lower),
  );
}

function managerRow(key: string): HTMLElement {
  const el = document.querySelector(
    `[data-testid="manager-project-row"][data-project-key="${key}"]`,
  ) as HTMLElement | null;
  if (el === null) throw new Error(`manager-project-row not found for key ${key}`);
  return el;
}

/** Every descendant element whose OWN (non-nested) trimmed textContent
 * equals `exact` — i.e. the fact lives on its own line/element, not merged
 * into a longer joined string. Matching on an element whose textContent
 * equals the target exactly (not merely `toContain`s it) is what proves
 * "own line": a joined single-string meta line would never produce an
 * element whose full text is ONLY the one fact. */
function elementWithExactText(root: ParentNode, exact: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).find(
    (el) => (el.textContent ?? "").trim() === exact,
  );
}

async function openEdit(key: string): Promise<HTMLElement> {
  const row = managerRow(key);
  const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
  expect(editTrigger).toBeDefined();
  editTrigger!.click();
  await settle();
  return managerRow(key);
}

// ─────────────────────────────────────────────────────────────────────────
// Card (view mode) — F12 redraw's per-line facts
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — card facts render on their own lines (F12 redraw, CR-CRU-174 §S3)", () => {
  test("sutRoot, agent liveness, run history and the immutable key each render as a SEPARATE line, worded exactly as F12 specifies", async () => {
    const key = "mgr-f12-card-lines-1";
    await mountApp({
      pathname: "/manage",
      projects: [
        project({
          key,
          name: "Grouped Liveness Co",
          sutRoot: "/srv/apps/example-root",
          // Non-round values: unambiguous under a seconds-only OR a
          // unit-aware ("5m"/"1h") formatter, since none divides evenly
          // into a minute or an hour.
          liveness: { staleAfterMs: 61_000, tombstoneAfterMs: 301_000, pruneAfterMs: 3_700_000 },
          retention: 42,
          allowRunDeletion: true,
        }),
      ],
    });

    const row = managerRow(key);

    const sutRootLine = elementWithExactText(row, "sutRoot /srv/apps/example-root");
    expect(sutRootLine).toBeDefined();

    const agentsLine = elementWithExactText(
      row,
      "agents: stale after 61s · tombstoned after 301s · removed after 3700s",
    );
    expect(agentsLine).toBeDefined();

    const runHistoryLine = elementWithExactText(
      row,
      "keeps the last 42 runs · agents may delete runs: on",
    );
    expect(runHistoryLine).toBeDefined();

    const keyLine = elementWithExactText(row, `key ${key} (immutable)`);
    expect(keyLine).toBeDefined();
  });

  test("run deletion OFF and the system defaults still use the same grouped wording, with no '(defaults)' marker and no T1/T2/T3 anywhere", async () => {
    const key = "mgr-f12-card-lines-defaults-1";
    await mountApp({
      pathname: "/manage",
      // No liveness/retention/allowRunDeletion override at all (the
      // server's own omit-when-unset contract).
      projects: [project({ key, name: "Defaults Grouped Co" })],
    });

    const row = managerRow(key);
    const text = row.textContent ?? "";

    expect(text).toMatch(/agents:\s*stale after\s+\S+\s*·\s*tombstoned after\s+\S+\s*·\s*removed after\s+\S+/i);
    expect(text).toMatch(/keeps the last 100 runs\s*·\s*agents may delete runs:\s*off/i);
    expect(text.toLowerCase()).not.toContain("(defaults)");
    expect(text).not.toMatch(/\bT1\b/);
    expect(text).not.toMatch(/\bT2\b/);
    expect(text).not.toMatch(/\bT3\b/);
  });

  test("a long sutRoot and a long key still render as their OWN isolated line element (not merged into the shared meta string) — real CSS wrap/no-scroll behaviour is proved in the browser suite", async () => {
    const key = "mgr-f12-card-wrap-1";
    const longSutRoot =
      "/home/dev/an/unusually/deeply/nested/directory/tree/that/exists/only/to/prove/the/card/wraps/instead/of/forcing/the/drawer/wider/crucible-project-root";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Wrap Co", sutRoot: longSutRoot })],
    });

    const row = managerRow(key);
    const sutRootLine = elementWithExactText(row, `sutRoot ${longSutRoot}`);
    expect(sutRootLine).toBeDefined();

    const keyLine = elementWithExactText(row, `key ${key} (immutable)`);
    expect(keyLine).toBeDefined();
    // The two facts stay on DIFFERENT elements even when both are long —
    // never re-joined into one shared string under stress.
    expect(sutRootLine).not.toBe(keyLine);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Edit form — three groups, in order, worded exactly as F12 specifies
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — edit-in-place form groups (F12 redraw, CR-CRU-174 §S3)", () => {
  test("the edit form renders Project, then Agent liveness (with its explanation), then Run history (with its explanation), in that order", async () => {
    const key = "mgr-f12-edit-groups-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Edit Groups Co" })],
    });

    const row = await openEdit(key);
    const text = row.textContent ?? "";

    const idxProject = text.indexOf("Project");
    const idxLiveness = text.indexOf("Agent liveness");
    const idxLivenessExplain = text.indexOf("how long an agent may stay silent");
    const idxRunHistory = text.indexOf("Run history");
    const idxRunHistoryExplain = text.indexOf("this one is about events, not agents");

    expect(idxProject).toBeGreaterThanOrEqual(0);
    expect(idxLiveness).toBeGreaterThan(idxProject);
    expect(idxLivenessExplain).toBeGreaterThan(idxLiveness);
    expect(idxRunHistory).toBeGreaterThan(idxLivenessExplain);
    expect(idxRunHistoryExplain).toBeGreaterThan(idxRunHistory);
  });

  test("the liveness rows are captioned 'Shown as stale after' / 'Tombstoned after' / 'Removed after', in order, each with its OWN one-line explanation of what happens to the agent", async () => {
    const key = "mgr-f12-edit-liveness-rows-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Liveness Rows Co" })],
    });

    const row = await openEdit(key);
    const text = row.textContent ?? "";

    const idxShown = text.indexOf("Shown as stale after");
    const idxAmber = text.indexOf("its card turns amber");
    const idxTomb = text.indexOf("Tombstoned after");
    const idxGreyed = text.indexOf("greyed; its open runs are aborted");
    const idxAgentDied = text.indexOf("agent died");
    const idxRemoved = text.indexOf("Removed after");
    const idxDropped = text.indexOf("dropped from the agents list");

    for (const idx of [idxShown, idxAmber, idxTomb, idxGreyed, idxAgentDied, idxRemoved, idxDropped]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(idxShown).toBeLessThan(idxAmber);
    expect(idxAmber).toBeLessThan(idxTomb);
    expect(idxTomb).toBeLessThan(idxGreyed);
    expect(idxGreyed).toBeLessThan(idxAgentDied);
    expect(idxAgentDied).toBeLessThan(idxRemoved);
    expect(idxRemoved).toBeLessThan(idxDropped);

    // The order-enforcement footnote, verbatim, after all three rows.
    const idxFootnote = text.indexOf(
      "each must be longer than the one before; leave a field empty to keep its current value (board defaults: 60 s · 300 s · 3600 s)",
    );
    expect(idxFootnote).toBeGreaterThan(idxDropped);

    // Never the old T1/T2/T3 naming.
    expect(text).not.toMatch(/\bT1\b/);
    expect(text).not.toMatch(/\bT2\b/);
    expect(text).not.toMatch(/\bT3\b/);

    // Still associated with their existing field testids (the label-wraps-
    // input mechanism pinned by tests/manager-settings-labels.test.ts is
    // unaffected by the wording move — only the caption text changes).
    const t1Label = row.querySelector('[data-testid="manager-edit-t1-label"]');
    const t2Label = row.querySelector('[data-testid="manager-edit-t2-label"]');
    const t3Label = row.querySelector('[data-testid="manager-edit-t3-label"]');
    expect((t1Label?.textContent ?? "")).toMatch(/shown as stale after/i);
    expect((t2Label?.textContent ?? "")).toMatch(/tombstoned after/i);
    expect((t3Label?.textContent ?? "")).toMatch(/removed after/i);
  });

  test("the retention row is captioned 'Keep the last', with its own 'older runs are evicted' explanation, inside the Run history group — never the old 'Retention (…)' wording", async () => {
    const key = "mgr-f12-edit-retention-row-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Retention Row Co" })],
    });

    const row = await openEdit(key);
    const text = row.textContent ?? "";

    const idxRunHistory = text.indexOf("Run history");
    const idxKeep = text.indexOf("Keep the last");
    const idxOlder = text.indexOf("older runs are evicted; the Runs timeline shows up to this many");

    expect(idxRunHistory).toBeGreaterThanOrEqual(0);
    expect(idxKeep).toBeGreaterThan(idxRunHistory);
    expect(idxOlder).toBeGreaterThan(idxKeep);

    expect(text).not.toContain("Retention (runs shown in the timeline window)");

    const retentionLabel = row.querySelector('[data-testid="manager-edit-retention-label"]');
    expect((retentionLabel?.textContent ?? "")).toMatch(/keep the last/i);
  });

  test("no 'T1'/'T2'/'T3' text appears anywhere in the manager — view mode, edit mode, or the add-project row", async () => {
    const key = "mgr-f12-no-t123-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "No T123 Co" })],
    });

    const manager = document.querySelector('[data-testid="projects-manager"]') as HTMLElement;
    expect(manager).not.toBeNull();
    const viewText = manager.textContent ?? "";
    expect(viewText).not.toMatch(/\bT1\b/);
    expect(viewText).not.toMatch(/\bT2\b/);
    expect(viewText).not.toMatch(/\bT3\b/);

    await openEdit(key);
    const editText = manager.textContent ?? "";
    expect(editText).not.toMatch(/\bT1\b/);
    expect(editText).not.toMatch(/\bT2\b/);
    expect(editText).not.toMatch(/\bT3\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Add-project row — stacks (name + type on one line, sutRoot below)
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — add-project row stacks (F12 redraw, CR-CRU-174 §S3)", () => {
  test("name and type share one row container; sutRoot sits in a separate row beneath them, never a third column of the same row", async () => {
    await mountApp({ pathname: "/manage", projects: [] });

    const nameInput = document.querySelector('[data-testid="manager-add-name"]') as HTMLElement | null;
    const typeInput = document.querySelector('[data-testid="manager-add-type"]') as HTMLElement | null;
    const sutRootInput = document.querySelector(
      '[data-testid="manager-add-sutroot"]',
    ) as HTMLElement | null;
    expect(nameInput).not.toBeNull();
    expect(typeInput).not.toBeNull();
    expect(sutRootInput).not.toBeNull();

    // "stacked": name + type are each other's siblings inside ONE row
    // container that does NOT also parent sutRoot — sutRoot's own parent is
    // a DIFFERENT element (the row beneath).
    expect(nameInput!.parentElement).toBe(typeInput!.parentElement);
    expect(nameInput!.parentElement).not.toBe(sutRootInput!.parentElement);

    // DOM order: the name+type row comes before the sutRoot row.
    const position = nameInput!.compareDocumentPosition(sutRootInput!);
    // Node.DOCUMENT_POSITION_FOLLOWING === 4 — sutRoot follows name in
    // document order (happy-dom implements the standard bitmask).
    expect((position & 4) !== 0).toBe(true);
  });
});
