// CR-CRU-012 §S2 — VERIFY fix round (Crucible cycle 29, "verify sweep"): the
// manager's edit-in-place form was shipped binding only name/type/sutRoot
// (tests/projects-manager.test.ts, cycle 27). The spec text (§S2) is
// explicit: "Per-project edit-in-place form (name, type, sutRoot, liveness
// overrides, retention) → PATCH" — liveness overrides and retention are
// missing from the shipped form entirely. This file pins the two missing
// field groups.
//
// Server-side contract (SHIPPED, cycles 25-26 — consumed here, not
// re-tested): `PATCH /api/v2/projects/<key>` accepts
// `{liveness:{t1_ms?,t2_ms?,t3_ms?}}` (partial merge onto existing
// overrides; validate-all-before-write) and `{retention:<number>}`
// (src/v2.ts:742-836). The manager row VIEW already renders
// `liveness T1 60s / T2 300s / T3 1h (defaults)` (or override values without
// the defaults label) and `retention N runs` (public/app.js
// MANAGER_LIVENESS_DEFAULTS/MANAGER_RETENTION_DEFAULT/livenessLabel,
// ~line 835-860; pinned F12-verbatim in tests/projects-manager.test.ts
// lines 369-424) — this file reuses that same view-text contract to assert
// the post-save flip.
//
// New testids this file DEFINES (none exist on the branch yet — GREEN must
// add them inside ManagerRowEdit, public/app.js ~line 960):
//   `manager-edit-t1` / `manager-edit-t2` / `manager-edit-t3` — three
//     liveness inputs, prefilled with the CURRENT EFFECTIVE value in
//     SECONDS (default 60/300/3600, or the override in seconds).
//   `manager-edit-retention` — one input, prefilled with the current
//     effective retention run count (default 100, or the override).
//
// Wire contract pinned: seconds (the input's displayed/edited unit) convert
// to milliseconds on the PATCH wire (`t1_ms = seconds * 1000`), one key per
// CHANGED liveness field only (server does the partial merge — the client
// must NOT resend unchanged siblings), never `name`/`type`/`sutRoot`/`key`/
// `projectKey` from this flow, and the SAME "empty-diff → no PATCH at all"
// no-op convention already shipped for name/type/sutRoot (public/app.js
// ManagerRowEdit.save: `if (Object.keys(body).length > 0) { ...fetch... }`).
//
// RED phase: every test below is expected to FAIL/error against the CURRENT
// public/app.js — there are no manager-edit-t1/t2/t3/retention testids and
// no liveness/retention keys are ever added to the PATCH body.
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

// Store-internal key names (public/app.js livenessLabel / MANAGER_LIVENESS_
// DEFAULTS) — NOT the PATCH wire names (t1_ms/t2_ms/t3_ms). Mirrors
// tests/projects-manager.test.ts's LivenessFixture exactly.
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

// PATCH wire name -> store-internal name (src/v2.ts:747-749, WIRE_TO_INTERNAL).
const WIRE_TO_INTERNAL: Record<string, keyof LivenessFixture> = {
  t1_ms: "staleAfterMs",
  t2_ms: "tombstoneAfterMs",
  t3_ms: "pruneAfterMs",
};

let cacheBust = 0;
let projectsState: ProjectFixture[] = [];
let patchCalls: CapturedCall[] = [];

/** Same mountApp harness convention as tests/projects-manager.test.ts, with
 * a PATCH mock that performs the SAME wire-to-internal liveness translation
 * + partial merge the real server does (src/v2.ts:799-816) — a naive
 * Object.assign(target, patchBody) would silently corrupt the liveness
 * shape (wire keys t1_ms/t2_ms/t3_ms are not the store's staleAfterMs/
 * tombstoneAfterMs/pruneAfterMs field names), which would make the
 * post-save view-text assertions fail for the wrong reason. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  projectsState = (opts.projects ?? []).map((p) => ({ ...p }));
  patchCalls = [];

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
      patchCalls.push({ url, method, body: parsed });
      const target = projectsState.find((p) => p.key === key);
      if (target !== undefined) {
        const { liveness, retention, ...rest } = parsed as {
          liveness?: Record<string, unknown>;
          retention?: unknown;
          [k: string]: unknown;
        };
        Object.assign(target, rest);
        if (liveness !== undefined && typeof liveness === "object" && liveness !== null) {
          const merged: LivenessFixture = { ...(target.liveness ?? {}) };
          for (const [wire, value] of Object.entries(liveness)) {
            const internal = WIRE_TO_INTERNAL[wire];
            if (internal !== undefined && typeof value === "number") {
              merged[internal] = value;
            }
          }
          target.liveness = merged;
        }
        if (typeof retention === "number") target.retention = retention;
      }
      body = { ok: true, changed: true };
    } else if (url.includes("/api/v2/projects") && url.includes("archived=true")) {
      // ProjectsManager() pulls the archived slice on every mount
      // (public/app.js ~line 1133) — none of this file's fixtures are
      // archived, so an empty list keeps the fold at "archived (0)"
      // (rendered as absent per §S1b convention) and out of scope here.
      body = { ok: true, projects: [] };
    } else if (url.includes("/api/v2/projects") && method === "POST") {
      const parsed = (init?.body ? JSON.parse(init.body as string) : {}) as Record<
        string,
        unknown
      >;
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
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: projectsState };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`manager-edit-params.test.ts mountApp: unexpected fetch ${method} ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?managerEditParams=${cacheBust}`);

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

/** Clicks the row's "edit" trigger and returns the four new field inputs,
 * scoped inside that row (mirrors tests/projects-manager.test.ts's
 * manager-edit-name lookup pattern). */
async function openEdit(key: string): Promise<{
  t1: HTMLInputElement;
  t2: HTMLInputElement;
  t3: HTMLInputElement;
  retention: HTMLInputElement;
  save: HTMLElement;
}> {
  const row = managerRow(key);
  const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
  expect(editTrigger).toBeDefined();
  editTrigger!.click();
  await settle();

  const scoped = managerRow(key);
  const t1 = scoped.querySelector('[data-testid="manager-edit-t1"]') as HTMLInputElement | null;
  const t2 = scoped.querySelector('[data-testid="manager-edit-t2"]') as HTMLInputElement | null;
  const t3 = scoped.querySelector('[data-testid="manager-edit-t3"]') as HTMLInputElement | null;
  const retention = scoped.querySelector(
    '[data-testid="manager-edit-retention"]',
  ) as HTMLInputElement | null;
  const save = scoped.querySelector('[data-testid="manager-edit-save"]') as HTMLElement | null;
  expect(t1).not.toBeNull();
  expect(t2).not.toBeNull();
  expect(t3).not.toBeNull();
  expect(retention).not.toBeNull();
  expect(save).not.toBeNull();
  return { t1: t1!, t2: t2!, t3: t3!, retention: retention!, save: save! };
}

function setValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ─────────────────────────────────────────────────────────────────────────
// Prefill — effective values in SECONDS (defaults, then overrides)
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — edit-in-place liveness + retention prefill (§S2 gap)", () => {
  test("with no override, edit-in-place prefills t1/t2/t3/retention with the system defaults in seconds (60/300/3600/100)", async () => {
    const key = "mgr-editparams-defaults-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Defaults Co" })],
    });

    const { t1, t2, t3, retention } = await openEdit(key);
    expect(t1.value).toBe("60");
    expect(t2.value).toBe("300");
    expect(t3.value).toBe("3600");
    expect(retention.value).toBe("100");
  });

  test("with overrides set, edit-in-place prefills t1/t2/t3/retention with the CURRENT EFFECTIVE override values in seconds, never the defaults", async () => {
    const key = "mgr-editparams-overrides-1";
    await mountApp({
      pathname: "/manage",
      projects: [
        project({
          key,
          name: "Overrides Co",
          liveness: { staleAfterMs: 120_000, tombstoneAfterMs: 600_000, pruneAfterMs: 7_200_000 },
          retention: 50,
        }),
      ],
    });

    const { t1, t2, t3, retention } = await openEdit(key);
    expect(t1.value).toBe("120");
    expect(t2.value).toBe("600");
    expect(t3.value).toBe("7200");
    expect(retention.value).toBe("50");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH argv — exact partial bodies, seconds→ms conversion, no cross-talk
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — edit-in-place liveness + retention PATCH argv (§S2 gap)", () => {
  test("changing ONLY t1 (60s -> 120s) and saving PATCHes exactly {liveness:{t1_ms:120000}} — t2/t3 omitted, no name/type/sutRoot, never projectKey/key", async () => {
    const key = "mgr-editparams-t1only-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "T1 Only Co" })],
    });

    const { t1, save } = await openEdit(key);
    setValue(t1, "120");
    save.click();
    await settle();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.url).toContain(`/api/v2/projects/${key}`);
    expect(patchCalls[0]!.body).toEqual({ liveness: { t1_ms: 120_000 } });
  });

  test("changing ONLY retention (100 -> 50) and saving PATCHes exactly {retention:50}", async () => {
    const key = "mgr-editparams-retentiononly-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Retention Only Co", retention: 100 })],
    });

    const { retention, save } = await openEdit(key);
    setValue(retention, "50");
    save.click();
    await settle();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.body).toEqual({ retention: 50 });
  });

  test("changing t2 AND retention together fires ONE PATCH carrying both {liveness:{t2_ms:...}, retention:...}", async () => {
    const key = "mgr-editparams-t2plusretention-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "T2 Plus Retention Co", retention: 100 })],
    });

    const { t2, retention, save } = await openEdit(key);
    setValue(t2, "600");
    setValue(retention, "25");
    save.click();
    await settle();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.body).toEqual({ liveness: { t2_ms: 600_000 }, retention: 25 });
  });

  test("touching nothing and saving fires NO PATCH at all (same empty-diff no-op convention as the shipped name/type/sutRoot form)", async () => {
    const key = "mgr-editparams-noop-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Noop Co", retention: 100 })],
    });

    const { save } = await openEdit(key);
    save.click();
    await settle();

    expect(patchCalls).toHaveLength(0);
  });

  test("non-numeric text in t1 does not fire a PATCH for that field", async () => {
    const key = "mgr-editparams-t1-nonnumeric-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "T1 Guard Co" })],
    });

    const { t1, save } = await openEdit(key);
    setValue(t1, "abc");
    save.click();
    await settle();

    expect(patchCalls).toHaveLength(0);
  });

  test("non-numeric text in retention does not fire a PATCH for that field", async () => {
    const key = "mgr-editparams-retention-nonnumeric-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Retention Guard Co", retention: 100 })],
    });

    const { retention, save } = await openEdit(key);
    setValue(retention, "abc");
    save.click();
    await settle();

    expect(patchCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Post-save view text — reuses the F12-verbatim contract already pinned in
// tests/projects-manager.test.ts (lines 369-424): "(defaults)" drops once an
// override exists, "retention N runs" tracks the new value.
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — edit-in-place liveness + retention view-text flip (§S2 gap)", () => {
  test("after a liveness save, the row view drops '(defaults)' and shows the override value", async () => {
    const key = "mgr-editparams-viewflip-liveness-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "View Flip Liveness Co" })],
    });

    const beforeText = managerRow(key).textContent ?? "";
    expect(beforeText.toLowerCase()).toContain("default");

    const { t1, save } = await openEdit(key);
    setValue(t1, "90");
    save.click();
    await settle();

    const afterText = managerRow(key).textContent ?? "";
    expect(afterText).toMatch(/T1[^0-9]{0,6}90s/);
    expect(afterText.toLowerCase()).not.toContain("default");
  });

  test("after a retention save, the row view shows the new 'N runs' value, never the old one", async () => {
    const key = "mgr-editparams-viewflip-retention-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "View Flip Retention Co", retention: 100 })],
    });

    const beforeText = managerRow(key).textContent ?? "";
    expect(beforeText).toMatch(/100\s*runs?/i);

    const { retention, save } = await openEdit(key);
    setValue(retention, "30");
    save.click();
    await settle();

    const afterText = managerRow(key).textContent ?? "";
    expect(afterText).toMatch(/30\s*runs?/i);
    expect(afterText).not.toMatch(/100\s*runs?/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Negative — the immutable key stays text-only through the new fields too
// ─────────────────────────────────────────────────────────────────────────
describe("Projects manager — edit-in-place liveness + retention negative bounds (§S2 gap)", () => {
  test("the project key remains read-only — no input anywhere in the manager (including the new t1/t2/t3/retention fields) is bound to it", async () => {
    const key = "mgr-editparams-key-readonly-777";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Key Readonly Co" })],
    });

    await openEdit(key);

    const boundInputs = Array.from(manager().querySelectorAll<HTMLInputElement>("input")).filter(
      (input) => input.value === key,
    );
    expect(boundInputs).toHaveLength(0);
  });
});
