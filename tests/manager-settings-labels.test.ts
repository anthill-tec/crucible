// CR-CRU-032 §S5 — project-settings edit-form integrity: field labels + the
// run-deletion toggle label.
//
// Today (verified, public/app.js:1247-1307 — ManagerRowEdit) the manager's
// edit-in-place form renders EIGHT BARE inputs with NO labels at all:
//   manager-edit-name        (text input)
//   manager-edit-type        (select: backend/frontend)
//   manager-edit-sutroot     (text input)
//   manager-edit-t1          (number input, seconds)
//   manager-edit-t2          (number input, seconds)
//   manager-edit-t3          (number input, seconds)
//   manager-edit-retention   (number input, run count)
//   manager-edit-allow-deletion (checkbox — the CR-CRU-008 §S4 guarded
//                                run-deletion DANGER toggle)
// A user opening "edit" sees eight unlabelled controls and a bare checkbox
// with no indication of what it does. §S5 fixes this.
//
// ─────────────────────────────────────────────────────────────────────────
// ASSOCIATION MECHANISM PINNED (so GREEN implements exactly this — no
// "for"/"id" pairing, which would collide: every manager row renders the
// SAME field structure, and multiple projects can be mounted/edited in the
// same DOM, so a shared `id` would not be unique per row):
//
//   Each field's existing `data-testid="manager-edit-<field>"` control MUST
//   be WRAPPED inside a `<label data-testid="manager-edit-<field>-label">`
//   element whose visible text is the caption. Native HTML label-wrapping
//   (`<label>caption<input/></label>`) associates a label with its control
//   WITHOUT needing a `for`/`id` pair — exactly the mechanism this file
//   asserts via `label.contains(field)`.
//
//   Concretely (van.js hyperscript), GREEN adds `label` to the `van.tags`
//   destructure (public/app.js:14) and wraps each field, e.g.:
//     label({ "data-testid": "manager-edit-name-label" }, "Name",
//       input({ "data-testid": "manager-edit-name", ... }))
//
// Wording pinned (this file asserts these substrings, case-insensitively):
//   - retention label mentions the Runs-timeline WINDOW it governs (§S4,
//     public/app.js:158-175: "the workspace Runs window is governed by the
//     routed project's own `retention`") — e.g. "Retention (runs shown in
//     the timeline window)". Test regex: /window|timeline|runs shown/i.
//   - allow-deletion label names the destructive action AND reads as
//     agent run-deletion, guarded — e.g. "Allow agents to delete runs
//     (guarded — per-call approval)". Test asserts /delete|deletion/i AND
//     /agent/i AND /guard|approval/i all present.
//   - t1/t2/t3 labels are clearly liveness fields in SECONDS — e.g.
//     "T1 (seconds)" / "T2 (seconds)" / "T3 (seconds)". Test regex:
//     /t1|stale/i + /second/i (and similarly for t2/t3).
//
// RED phase: every test below is expected to FAIL against the CURRENT
// public/app.js — there are no `manager-edit-*-label` testids and no
// `<label>` wraps any of the eight fields today.
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

/** Same mountApp harness convention as tests/manager-edit-params.test.ts
 * and tests/shim-retirement.test.ts. Only the fetch mock's list/PATCH
 * responses matter here — this file never asserts PATCH argv, only DOM
 * labels, so the mock is intentionally minimal (Object.assign passthrough
 * is fine; no liveness wire translation needed). */
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
      throw new Error(`manager-settings-labels.test.ts mountApp: unexpected fetch ${method} ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?managerSettingsLabels=${cacheBust}`);

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

const FIELD_TESTIDS = [
  "manager-edit-name",
  "manager-edit-type",
  "manager-edit-sutroot",
  "manager-edit-t1",
  "manager-edit-t2",
  "manager-edit-t3",
  "manager-edit-retention",
  "manager-edit-allow-deletion",
] as const;

type FieldTestId = (typeof FIELD_TESTIDS)[number];

/** Opens edit mode for `key` and returns, for every field, both the
 * control element itself and its pinned `<label data-testid="…-label">`
 * (per the association mechanism pinned above). */
async function openEdit(
  key: string,
): Promise<Record<FieldTestId, { field: HTMLElement; label: HTMLElement | null }>> {
  const row = managerRow(key);
  const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
  expect(editTrigger).toBeDefined();
  editTrigger!.click();
  await settle();

  const scoped = managerRow(key);
  const result = {} as Record<FieldTestId, { field: HTMLElement; label: HTMLElement | null }>;
  for (const testid of FIELD_TESTIDS) {
    const field = scoped.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
    expect(field).not.toBeNull();
    const label = scoped.querySelector(`[data-testid="${testid}-label"]`) as HTMLElement | null;
    result[testid] = { field: field!, label };
  }
  return result;
}

function baseProject(key: string): ProjectFixture {
  return project({ key, name: "Labelled Co" });
}

// ─────────────────────────────────────────────────────────────────────────
// §S5.1 — every one of the 8 manager-edit fields has an associated,
// visible, non-empty label.
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — edit-in-place field labels (§S5.1)", () => {
  for (const testid of FIELD_TESTIDS) {
    test(`${testid} has an associated visible non-empty label`, async () => {
      const key = `mgr-label-${testid}`;
      await mountApp({ pathname: "/manage", projects: [baseProject(key)] });

      const fields = await openEdit(key);
      const { field, label } = fields[testid];

      expect(label).not.toBeNull();
      const text = (label!.textContent ?? "").trim();
      expect(text.length).toBeGreaterThan(0);

      // Association: the pinned mechanism is a WRAPPING <label> — the
      // field must be a descendant of its label (native HTML label
      // association, no for/id pairing needed across repeated rows).
      expect(label!.contains(field)).toBe(true);
    });
  }

  test("t1/t2/t3 liveness labels are clearly marked as seconds-based liveness fields", async () => {
    const key = "mgr-label-liveness-seconds";
    await mountApp({ pathname: "/manage", projects: [baseProject(key)] });

    const fields = await openEdit(key);
    const t1Text = (fields["manager-edit-t1"].label!.textContent ?? "").toLowerCase();
    const t2Text = (fields["manager-edit-t2"].label!.textContent ?? "").toLowerCase();
    const t3Text = (fields["manager-edit-t3"].label!.textContent ?? "").toLowerCase();

    expect(t1Text).toMatch(/t1|stale/i);
    expect(t1Text).toMatch(/second/i);
    expect(t2Text).toMatch(/t2|tombstone/i);
    expect(t2Text).toMatch(/second/i);
    expect(t3Text).toMatch(/t3|prune/i);
    expect(t3Text).toMatch(/second/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S5.1 (AC2) — the retention field's label states it governs the
// Runs-timeline window (per §S4, public/app.js:158-175).
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — retention label wording (§S5.1 AC2)", () => {
  test("retention label mentions the runs/timeline window it governs", async () => {
    const key = "mgr-label-retention-wording";
    await mountApp({ pathname: "/manage", projects: [baseProject(key)] });

    const fields = await openEdit(key);
    const retentionLabelText = (fields["manager-edit-retention"].label!.textContent ?? "").trim();

    expect(retentionLabelText.length).toBeGreaterThan(0);
    // Pinned wording contract: mentions the Runs-timeline window (e.g.
    // "Retention (runs shown in the timeline window)").
    expect(retentionLabelText).toMatch(/window|timeline|runs shown/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S5.2 (AC3) — the allow-deletion toggle's label names the destructive
// action and reads as agent run-deletion, guarded.
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — allow-deletion toggle label wording (§S5.2 AC3)", () => {
  test("allow-deletion label names the destructive action as agent run-deletion, guarded", async () => {
    const key = "mgr-label-allow-deletion-wording";
    await mountApp({ pathname: "/manage", projects: [baseProject(key)] });

    const fields = await openEdit(key);
    const toggleLabelText = (fields["manager-edit-allow-deletion"].label!.textContent ?? "").trim();

    expect(toggleLabelText.length).toBeGreaterThan(0);
    // Names the destructive action.
    expect(toggleLabelText).toMatch(/delete|deletion/i);
    // Reads as AGENT run-deletion (not e.g. an admin/user action).
    expect(toggleLabelText).toMatch(/agent/i);
    // Reads as GUARDED (per-call approval), matching the §S4 contract
    // (docs/changes CR-CRU-008 §S4 — DELETE requires userApproved:true
    // in addition to this gate).
    expect(toggleLabelText).toMatch(/guard|approval/i);
  });

  test("allow-deletion toggle field itself is unchanged by labelling — still the danger-styled checkbox", async () => {
    const key = "mgr-label-allow-deletion-checkbox-unchanged";
    await mountApp({ pathname: "/manage", projects: [baseProject(key)] });

    const fields = await openEdit(key);
    const toggle = fields["manager-edit-allow-deletion"].field as HTMLInputElement;

    expect(toggle.type).toBe("checkbox");
    expect(toggle.className.toLowerCase()).toContain("danger");
  });
});
