// CR-CRU-008 C7 — guarded run deletion + soak gate + shim retirement (§S4).
//
// Spec: docs/changes/CR-CRU-008-cli-fleet-upgrade.md §S4. This CR folds
// DOUBLE-GATED single-run deletion into v2 (per-project `allowRunDeletion`
// config gate + a per-call `userApproved` body gate) BEFORE the v1 shim
// retires, so retiring `/api/events/delete`/`clear` leaves no capability
// gap. It also adds a `silent` unregister verb so the clients' anti-ghost
// cleanup can stop riding the shim's `/api/agents/remove`.
//
// RED phase: NONE of this exists yet on the branch.
//   - The v1 shim routes are all still LIVE (server.ts ~L476-531) — every
//     GET/POST in the "shim retirement" describe below currently returns
//     200/400 from the real handler, never today's expected 404.
//   - `DELETE /api/v2/events/:id` (v2.ts handleEventDelete, ~L978) reads NO
//     body at all and has no config/approval gate — it deletes unconditionally
//     whenever the project+event resolve. Every "guarded deletion" test below
//     expects a 403/409 it does not yet produce.
//   - `allowRunDeletion` is not in PATCHABLE_FIELDS (v2.ts:756) — a PATCH
//     carrying it 400s as an unknown field today.
//   - `POST /api/v2/agents/unregister` (v2.ts handleAgentUnregister, ~L326)
//     ignores an extra `silent` key entirely and ALWAYS journals a
//     lifecycle "unregistered" event — every "silent unregister" test
//     expecting NO lifecycle entry fails against that today.
//   - `manager-edit-allow-deletion` does not exist in public/app.js's
//     ManagerRowEdit (~L1000) — no such testid is rendered yet.
//   - clients/bun-crucible.py's `_remove_agent_silent` (~L332) still POSTs
//     the shim's `/api/agents/remove` — the swap to
//     `/api/v2/agents/unregister {silent:true}` has not happened yet.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";

// ── shared API helpers (real startServer, plain fetch) ──────────────────────

async function createProject(baseUrl: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v2/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as { ok: boolean; project: { key: string } };
  return body.project.key;
}

async function getProjects(baseUrl: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${baseUrl}/api/v2/projects`);
  const body = (await res.json()) as { ok: boolean; projects: Array<Record<string, unknown>> };
  return body.projects;
}

async function patchProject(
  baseUrl: string,
  key: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v2/projects/${key}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function ingestParsed(
  baseUrl: string,
  opts: {
    projectKey: string;
    agentId?: string;
    passed?: number;
    failed?: number;
    duration_ms?: number;
  },
): Promise<string> {
  const passed = opts.passed ?? 1;
  const failed = opts.failed ?? 0;
  const res = await fetch(`${baseUrl}/api/v2/runs/parsed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectKey: opts.projectKey,
      agentId: opts.agentId ?? "agent-1",
      summary: {
        total: passed + failed,
        passed,
        failed,
        pending: 0,
        duration_ms: opts.duration_ms ?? 10,
      },
      tree: [],
    }),
  });
  const body = (await res.json()) as { ok: boolean; event: string };
  expect(body.ok).toBe(true);
  return body.event;
}

async function deleteEventGuarded(
  baseUrl: string,
  eventId: string,
  projectKey: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v2/events/${eventId}?project=${projectKey}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// §S4 — shim retirement: legacy /api/* 404 sweep (health + stream stay)
// ─────────────────────────────────────────────────────────────────────────
describe("Shim retirement — legacy /api/* 404 sweep (§S4, soak-gated)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  beforeEach(() => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
  });
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function baseUrl(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function assertRetired(pathname: string): Promise<void> {
    const getRes = await fetch(`${baseUrl()}${pathname}`);
    expect(getRes.status).toBe(404);
    const getBody = (await getRes.json()) as { ok: boolean };
    expect(getBody.ok).toBe(false);

    const postRes = await fetch(`${baseUrl()}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(postRes.status).toBe(404);
    const postBody = (await postRes.json()) as { ok: boolean };
    expect(postBody.ok).toBe(false);
  }

  // Explicit checklist from the CR-008 §S4 retirement AC + the dispatch's
  // 404-sweep list — the full legacy shim surface minus health (stays) and
  // stream (not v1-shim scope; pinned separately below).
  const RETIRED_PATHS = [
    "/api/ingest",
    "/api/ingest/parsed",
    "/api/ingest/compile",
    "/api/agents/heartbeat",
    "/api/agents/remove",
    "/api/projects/add",
    "/api/events",
    "/api/events/delete",
    "/api/events/clear",
    "/api/ingest/status",
    "/api/ingest/clear",
  ];

  for (const p of RETIRED_PATHS) {
    test(`GET and POST ${p} → 404 JSON {ok:false} once the shim retires`, async () => {
      await assertRetired(p);
    });
  }

  test("/api/health still 200 after retirement", async () => {
    const res = await fetch(`${baseUrl()}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("healthy");
  });

  test("/api/stream still serves SSE after retirement (not v1-shim scope)", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl()}/api/stream`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S4 — guarded run deletion: config gate (allowRunDeletion)
// ─────────────────────────────────────────────────────────────────────────
describe("Guarded run deletion — config gate (§S4)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  test("fresh project: allowRunDeletion absent/false from GET /api/v2/projects", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "guard-fresh-1");

    const projects = await getProjects(baseUrl);
    const project = projects.find((p) => p.key === key)!;
    expect(project.allowRunDeletion === undefined || project.allowRunDeletion === false).toBe(
      true,
    );
  });

  test("DELETE with userApproved:true but allowRunDeletion unset → 403, help[] names the manager setting, event unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "guard-403-1");
    const eventId = await ingestParsed(baseUrl, { projectKey: key });

    const res = await deleteEventGuarded(baseUrl, eventId, key, { userApproved: true });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string; help?: string[] };
    expect(body.ok).toBe(false);
    expect(
      body.help?.some((h) => h.toLowerCase().includes("allowrundeletion")),
    ).toBe(true);

    // No state change.
    expect(handle.store.getEvent(eventId)).not.toBeNull();
  });

  test("PATCH {allowRunDeletion:true} → 200 changed:true, round-trips on GET projects; the DELETE then succeeds (200, event gone, count drops)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "guard-enable-1");
    const eventId = await ingestParsed(baseUrl, { projectKey: key });

    const patchRes = await patchProject(baseUrl, key, { allowRunDeletion: true });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { ok: boolean; changed: boolean };
    expect(patchBody.ok).toBe(true);
    expect(patchBody.changed).toBe(true);

    const projects = await getProjects(baseUrl);
    expect(projects.find((p) => p.key === key)?.allowRunDeletion).toBe(true);

    const beforeCount = handle.store.listEvents(key, 1000).length;
    const delRes = await deleteEventGuarded(baseUrl, eventId, key, { userApproved: true });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    const afterCount = handle.store.listEvents(key, 1000).length;
    expect(afterCount).toBe(beforeCount - 1);
    expect(handle.store.getEvent(eventId)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S4 — guarded run deletion: approval gate (userApproved)
// ─────────────────────────────────────────────────────────────────────────
describe("Guarded run deletion — approval gate (§S4)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  test("config ON, DELETE without userApproved:true → 409 discouraging error + help[] instructing present-then-retry; no state change", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "guard-409-1");
    await patchProject(baseUrl, key, { allowRunDeletion: true });
    const eventId = await ingestParsed(baseUrl, { projectKey: key });

    const res = await deleteEventGuarded(baseUrl, eventId, key, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string; help?: string[] };
    expect(body.ok).toBe(false);
    expect(body.error.toLowerCase()).toContain("approv");
    expect(body.help?.some((h) => h.toLowerCase().includes("userapproved"))).toBe(true);

    expect(handle.store.getEvent(eventId)).not.toBeNull();
  });

  test("config ON, DELETE with userApproved:false explicitly → still 409 (falsy is not approved), no state change", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "guard-409-false-1");
    await patchProject(baseUrl, key, { allowRunDeletion: true });
    const eventId = await ingestParsed(baseUrl, { projectKey: key });

    const res = await deleteEventGuarded(baseUrl, eventId, key, { userApproved: false });
    expect(res.status).toBe(409);
    expect(handle.store.getEvent(eventId)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S4 — guarded run deletion: a deleted event never re-enters a later
// retention-prune rollup fold (existing rollups are not retro-adjusted;
// the DELETED event specifically must never contribute).
// ─────────────────────────────────────────────────────────────────────────
describe("Guarded run deletion — retention prune excludes the deleted event (§S4)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  test("a deleted event's passed/failed/duration never folds into a later retention-prune rollup", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "guard-rollup-1");
    await patchProject(baseUrl, key, { allowRunDeletion: true });

    // e1, e2 (to be deleted), e3 — all within the default retention cap so
    // no auto-eviction happens yet.
    await ingestParsed(baseUrl, { projectKey: key, passed: 1, failed: 0, duration_ms: 10 });
    const e2 = await ingestParsed(baseUrl, {
      projectKey: key,
      passed: 2,
      failed: 0,
      duration_ms: 20,
    });
    await ingestParsed(baseUrl, { projectKey: key, passed: 3, failed: 1, duration_ms: 30 });

    const delRes = await deleteEventGuarded(baseUrl, e2, key, { userApproved: true });
    expect(delRes.status).toBe(200);
    expect(handle.store.getEvent(e2)).toBeNull();

    // Retention takes effect on the NEXT ingest only (never retroactively).
    const retentionRes = await patchProject(baseUrl, key, { retention: 1 });
    expect(retentionRes.status).toBe(200);
    await ingestParsed(baseUrl, { projectKey: key, passed: 4, failed: 0, duration_ms: 40 });

    // cap=1 forces the two oldest survivors (e1, e3) to fold+evict; e4 alone
    // remains raw. e2 can never appear here — it was already gone before
    // this prune ran.
    const remaining = handle.store.listEvents(key, 1000);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.summary?.passed).toBe(4);

    const rollups = handle.store.listRollups(key);
    const totals = rollups.reduce(
      (acc, r) => ({
        passed: acc.passed + r.passed,
        failed: acc.failed + r.failed,
        duration_ms: acc.duration_ms + r.duration_ms,
        runs: acc.runs + r.runs,
      }),
      { passed: 0, failed: 0, duration_ms: 0, runs: 0 },
    );
    // e1(passed:1,duration:10) + e3(passed:3,failed:1,duration:30) ONLY.
    // If the deleted e2 had wrongly been folded, passed would read 6 and
    // duration_ms 60 instead.
    expect(totals).toEqual({ passed: 4, failed: 1, duration_ms: 40, runs: 2 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S4 precondition 4 — v2 silent unregister (C2 GREEN finding)
// ─────────────────────────────────────────────────────────────────────────
describe("v2 silent unregister — §S4 precondition 4 (C2 GREEN finding)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function registerAgent(baseUrl: string, key: string, agentId: string): Promise<void> {
    await fetch(`${baseUrl}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId }),
    });
  }

  async function unregisterAgent(
    baseUrl: string,
    key: string,
    agentId: string,
    silent?: boolean,
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/v2/agents/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: key,
        agentId,
        ...(silent !== undefined ? { silent } : {}),
      }),
    });
  }

  test("silent:true removes the agent (GET agents omits it) AND the events journal gains NO lifecycle entry", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "silent-unreg-1");
    await registerAgent(baseUrl, key, "silent-agent");

    const res = await unregisterAgent(baseUrl, key, "silent-agent", true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);

    const agentsRes = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
    const agentsBody = (await agentsRes.json()) as { agents: Array<{ agentId: string }> };
    expect(agentsBody.agents.map((a) => a.agentId)).not.toContain("silent-agent");

    const events = handle.store.listEvents(key, 1000);
    const lifecycleEntries = events.filter(
      (e) => e.kind === "lifecycle" && e.agentId === "silent-agent" && e.action === "unregistered",
    );
    expect(lifecycleEntries).toHaveLength(0);
  });

  test("non-silent unregister still journals exactly as today (byte-unchanged): one lifecycle 'unregistered' entry", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "nonsilent-unreg-1");
    await registerAgent(baseUrl, key, "loud-agent");

    const res = await unregisterAgent(baseUrl, key, "loud-agent");
    expect(res.status).toBe(200);

    const events = handle.store.listEvents(key, 1000);
    const lifecycleEntries = events.filter(
      (e) => e.kind === "lifecycle" && e.agentId === "loud-agent" && e.action === "unregistered",
    );
    expect(lifecycleEntries).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S4 — manager UI: allowRunDeletion edit-in-place toggle
// (manager-edit-params.test.ts harness convention reused: real app.js/
// app-logic.mjs, happy-dom, a scripted PATCH-capturing fetch mock.)
// ─────────────────────────────────────────────────────────────────────────
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
let patchCalls: CapturedCall[] = [];

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
        Object.assign(target, parsed);
      }
      body = { ok: true, changed: true };
    } else if (url.includes("/api/v2/projects") && url.includes("archived=true")) {
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
      throw new Error(`shim-retirement.test.ts mountApp: unexpected fetch ${method} ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?shimRetirement=${cacheBust}`);

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

/** New testid this file DEFINES (does not exist on the branch yet — GREEN
 * must add it inside ManagerRowEdit, public/app.js ~line 1000):
 *   `manager-edit-allow-deletion` — a checkbox, danger-styled (className
 *   containing "danger"), prefilled `.checked` from the project's current
 *   effective `allowRunDeletion` (default false/absent). */
async function openEditAllowDeletion(key: string): Promise<{
  toggle: HTMLInputElement;
  save: HTMLElement;
}> {
  const row = managerRow(key);
  const editTrigger = findByText(row, "button, [role='button'], span, a", "edit");
  expect(editTrigger).toBeDefined();
  editTrigger!.click();
  await settle();

  const scoped = managerRow(key);
  const toggle = scoped.querySelector(
    '[data-testid="manager-edit-allow-deletion"]',
  ) as HTMLInputElement | null;
  const save = scoped.querySelector('[data-testid="manager-edit-save"]') as HTMLElement | null;
  expect(toggle).not.toBeNull();
  expect(save).not.toBeNull();
  return { toggle: toggle!, save: save! };
}

describe("Manager UI — allowRunDeletion edit-in-place toggle (§S4)", () => {
  test("edit mode renders manager-edit-allow-deletion, a danger-styled checkbox, unchecked by default", async () => {
    const key = "mgr-allow-del-default-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Default Deletion Co" })],
    });

    const { toggle } = await openEditAllowDeletion(key);
    expect(toggle.type).toBe("checkbox");
    expect(toggle.checked).toBe(false);
    expect(toggle.className.toLowerCase()).toContain("danger");
  });

  test("with allowRunDeletion already true, edit mode prefills the toggle CHECKED", async () => {
    const key = "mgr-allow-del-prefill-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Prefilled Deletion Co", allowRunDeletion: true })],
    });

    const { toggle } = await openEditAllowDeletion(key);
    expect(toggle.checked).toBe(true);
  });

  test("toggling on and saving PATCHes exactly {allowRunDeletion:true} — no other fields", async () => {
    const key = "mgr-allow-del-toggle-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Toggle Deletion Co" })],
    });

    const { toggle, save } = await openEditAllowDeletion(key);
    toggle.click();
    expect(toggle.checked).toBe(true);
    save.click();
    await settle();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.url).toContain(`/api/v2/projects/${key}`);
    expect(patchCalls[0]!.body).toEqual({ allowRunDeletion: true });
  });

  test("after enabling + saving, the row view surfaces the enabled state ('run deletion: enabled'); a fresh row shows no such text", async () => {
    const key = "mgr-allow-del-viewflip-1";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "View Flip Deletion Co" })],
    });

    const beforeText = (managerRow(key).textContent ?? "").toLowerCase();
    expect(beforeText).not.toMatch(/run deletion:\s*enabled/);

    const { toggle, save } = await openEditAllowDeletion(key);
    toggle.click();
    save.click();
    await settle();

    const afterText = (managerRow(key).textContent ?? "").toLowerCase();
    expect(afterText).toMatch(/run deletion:\s*enabled/);
  });

  test("the project key remains read-only through the new toggle too — no input anywhere in the manager is bound to it", async () => {
    const key = "mgr-allow-del-key-readonly-777";
    await mountApp({
      pathname: "/manage",
      projects: [project({ key, name: "Key Readonly Deletion Co" })],
    });

    await openEditAllowDeletion(key);

    const boundInputs = Array.from(manager().querySelectorAll<HTMLInputElement>("input")).filter(
      (input) => input.value === key,
    );
    expect(boundInputs).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S4 precondition 4 — clients/bun-crucible.py silent-cleanup swap
// (reuses tests/clients-bun-crucible.test.ts's proven spawn + capturing-
// proxy technique; the proxy here ALSO captures the parsed JSON body so the
// exact {silent:true} argv can be pinned, not just the URL.)
// ─────────────────────────────────────────────────────────────────────────
const SCRIPT_PATH = join(import.meta.dir, "..", "clients", "bun-crucible.py");
const RUST_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "rust-crucible.py");
const MVN_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "mvn-crucible.py");
const PYTHON_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "python-crucible.py");
const ARDUINO_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "arduino-crucible.py");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Generic spawn for any `clients/*.py` script — `scriptPath` defaults to
 * bun-crucible.py (this file's original client) so existing call sites keep
 * working unchanged; the four-client silent-cleanup pins below pass their
 * own script path explicitly. */
async function runScript(
  args: string[],
  opts: {
    cwd: string;
    crucibleUrl: string;
    env?: Record<string, string | undefined>;
    scriptPath?: string;
  },
): Promise<RunResult> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  const proc = Bun.spawn({
    cmd: ["python3", opts.scriptPath ?? SCRIPT_PATH, ...args],
    cwd: opts.cwd,
    env: { ...baseEnv, CRUCIBLE_URL: opts.crucibleUrl, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

interface ProxyCall {
  method: string;
  path: string;
  body?: unknown;
}

function startCapturingProxy(targetBaseUrl: string): {
  url: string;
  calls: ProxyCall[];
  stop(): void;
} {
  const calls: ProxyCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const buf = hasBody ? await req.arrayBuffer() : undefined;
      let parsedBody: unknown;
      if (buf !== undefined) {
        try {
          parsedBody = JSON.parse(new TextDecoder().decode(buf));
        } catch {
          parsedBody = undefined;
        }
      }
      calls.push({ method: req.method, path: url.pathname, body: parsedBody });
      const target = new URL(url.pathname + url.search, targetBaseUrl);
      const headers = new Headers(req.headers);
      headers.delete("host");
      const init: RequestInit = { method: req.method, headers };
      if (buf !== undefined) init.body = buf;
      const upstream = await fetch(target, init);
      const respBody = await upstream.arrayBuffer();
      return new Response(respBody, { status: upstream.status, headers: upstream.headers });
    },
  });
  return { url: `http://localhost:${server.port}`, calls, stop: () => server.stop(true) };
}

function writeFixtureBunProject(dir: string, projectKey: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "shim-retirement-fixture", version: "0.0.0", private: true }),
  );
  writeFileSync(
    join(dir, "sample.test.ts"),
    `import { test, expect } from "bun:test";\n\ntest("passes", () => {\n  expect(1 + 1).toBe(2);\n});\n`,
  );
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
}

describe("clients/bun-crucible.py — silent-cleanup swap (§S4 precondition 4)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  test("a gated regression run's cleanup POSTs /api/v2/agents/unregister with {silent:true} and NEVER /api/agents/remove", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    proxy = startCapturingProxy(baseUrl);
    const key = await createProject(baseUrl, "silent-cleanup-swap-1");
    const dir = scratchDir("bun-crucible-silent-cleanup-");
    writeFixtureBunProject(dir, key);

    await runScript(
      ["regression", "--agent", "gated-agent", "--project-dir", dir, "--package-dir", dir],
      { cwd: dir, crucibleUrl: proxy.url },
    );

    const unregisterCalls = proxy.calls.filter(
      (c) => c.method === "POST" && c.path === "/api/v2/agents/unregister",
    );
    expect(unregisterCalls).toHaveLength(1);
    expect(unregisterCalls[0]!.body).toMatchObject({
      agentId: "gated-agent",
      projectKey: key,
      silent: true,
    });

    expect(proxy.calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §S4 precondition 4 addendum (2026-07-17 orchestrator ruling) — the
// silent-cleanup requirement generalizes from clients/bun-crucible.py (C2's
// finding) to the FOUR remaining clients: a gated run (implicit
// registration via ingest, no explicit register call) must ALSO clean up
// silently — POST /api/v2/agents/unregister {agentId, projectKey,
// silent:true} — and never touch the retiring /api/agents/remove shim.
//
// TODAY none of these four clients make ANY post-run agent-cleanup call at
// all (verified by reading each script: no "/api/agents/remove" reference,
// no register/unregister pairing around a gated test/regression run — the
// agent row is simply left to the liveness TTL). So every assertion below
// is RED against an ABSENT call, not a wrong-endpoint call — GREEN must add
// the silent-unregister call site to each script's gated-run path.
//
// TOOLCHAIN-FREE FIXTURE STRATEGY reused verbatim from
// tests/clients-rust-mvn-crucible.test.ts / tests/clients-python-arduino-
// crucible.test.ts (their header comments document why each is safe: a
// no-op `cargo`/`mvnw`/`make` stub on PATH, or fake `xmlrunner`/`coverage`
// python packages on PYTHONPATH, so pre-placed report fixtures are read
// without any real toolchain invocation).
// ─────────────────────────────────────────────────────────────────────────
const NOOP_SCRIPT = "#!/bin/sh\nexit 0\n";

function writeExecutable(filePath: string, script: string): void {
  writeFileSync(filePath, script);
  chmodSync(filePath, 0o755);
}

function junitXmlString(suiteName: string, cases: Array<{ name: string; fail?: boolean }>): string {
  const testcases = cases
    .map((c) =>
      c.fail
        ? `<testcase name="${c.name}" time="0.01"><failure message="boom">boom</failure></testcase>`
        : `<testcase name="${c.name}" time="0.01"/>`,
    )
    .join("");
  return `<?xml version="1.0"?><testsuite name="${suiteName}" tests="${cases.length}">${testcases}</testsuite>`;
}

function writeJunitXmlFile(
  filePath: string,
  suiteName: string,
  cases: Array<{ name: string; fail?: boolean }>,
): void {
  writeFileSync(filePath, junitXmlString(suiteName, cases));
}

/** Two FAKE python packages (`xmlrunner`, `coverage`) — verbatim technique
 * from tests/clients-python-arduino-crucible.test.ts's writeFakePyModules. */
function writeFakePyModules(rootDir: string): string {
  const xmlrunnerDir = join(rootDir, "xmlrunner");
  mkdirSync(xmlrunnerDir, { recursive: true });
  writeFileSync(join(xmlrunnerDir, "__init__.py"), "");
  writeFileSync(
    join(xmlrunnerDir, "__main__.py"),
    `import os, sys
reports_dir = None
argv = sys.argv[1:]
for i, a in enumerate(argv):
    if a == "-o" and i + 1 < len(argv):
        reports_dir = argv[i + 1]
if reports_dir:
    os.makedirs(reports_dir, exist_ok=True)
    content = os.environ.get("FAKE_XMLRUNNER_JUNIT_XML")
    if content:
        with open(os.path.join(reports_dir, "TEST-fake_fixture.xml"), "w") as f:
            f.write(content)
sys.exit(int(os.environ.get("FAKE_XMLRUNNER_EXIT_CODE", "0")))
`,
  );
  return rootDir;
}

describe("clients/{rust,mvn,python,arduino}-crucible.py — silent-cleanup swap (§S4 precondition 4 addendum)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof startCapturingProxy> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    proxy?.stop();
    proxy = undefined;
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function assertSilentCleanup(
    calls: Array<{ method: string; path: string; body?: unknown }>,
    agentId: string,
    projectKey: string,
  ): void {
    const unregisterCalls = calls.filter(
      (c) => c.method === "POST" && c.path === "/api/v2/agents/unregister",
    );
    expect(unregisterCalls).toHaveLength(1);
    expect(unregisterCalls[0]!.body).toMatchObject({ agentId, projectKey, silent: true });
    expect(calls.some((c) => c.path === "/api/agents/remove")).toBe(false);
  }

  test("rust-crucible.py: regression-ingest's gated-run cleanup POSTs /api/v2/agents/unregister {silent:true} and never /api/agents/remove", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    proxy = startCapturingProxy(baseUrl);
    const key = await createProject(baseUrl, "silent-cleanup-rust-1");
    const dir = scratchDir("rust-crucible-silent-cleanup-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    const junitDir = join(dir, "target", "nextest", "ci");
    mkdirSync(junitDir, { recursive: true });
    writeJunitXmlFile(join(junitDir, "junit.xml"), "regression_fixture", [{ name: "alpha" }]);
    const binDir = scratchDir("fake-cargo-bin-");
    writeExecutable(join(binDir, "cargo"), NOOP_SCRIPT);

    await runScript(
      ["regression-ingest", "--agent", "rust-gated-agent", "--crates", "demo-crate", "--project-dir", dir],
      {
        cwd: dir,
        crucibleUrl: proxy.url,
        scriptPath: RUST_SCRIPT_PATH,
        env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      },
    );

    assertSilentCleanup(proxy.calls, "rust-gated-agent", key);
  });

  test("mvn-crucible.py: regression's gated-run cleanup POSTs /api/v2/agents/unregister {silent:true} and never /api/agents/remove", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    proxy = startCapturingProxy(baseUrl);
    const key = await createProject(baseUrl, "silent-cleanup-mvn-1");
    const dir = scratchDir("mvn-crucible-silent-cleanup-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    writeExecutable(join(dir, "mvnw"), NOOP_SCRIPT);
    const surefireDir = join(dir, "target", "surefire-reports");
    mkdirSync(surefireDir, { recursive: true });
    writeJunitXmlFile(join(surefireDir, "TEST-FooTest.xml"), "FooTest", [{ name: "testOne" }]);

    await runScript(["regression", "--agent", "mvn-gated-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      scriptPath: MVN_SCRIPT_PATH,
    });

    assertSilentCleanup(proxy.calls, "mvn-gated-agent", key);
  });

  test("python-crucible.py: regression's gated-run cleanup POSTs /api/v2/agents/unregister {silent:true} and never /api/agents/remove", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    proxy = startCapturingProxy(baseUrl);
    const key = await createProject(baseUrl, "silent-cleanup-python-1");
    const dir = scratchDir("python-crucible-silent-cleanup-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    const pythonPath = writeFakePyModules(scratchDir("python-crucible-fakepy-"));

    await runScript(["regression", "--agent", "python-gated-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      scriptPath: PYTHON_SCRIPT_PATH,
      env: {
        PYTHONPATH: pythonPath,
        FAKE_XMLRUNNER_JUNIT_XML: junitXmlString("regression_fixture", [{ name: "alpha" }]),
        FAKE_XMLRUNNER_EXIT_CODE: "0",
      },
    });

    assertSilentCleanup(proxy.calls, "python-gated-agent", key);
  });

  test("arduino-crucible.py: unit's gated-run cleanup POSTs /api/v2/agents/unregister {silent:true} and never /api/agents/remove", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    proxy = startCapturingProxy(baseUrl);
    const key = await createProject(baseUrl, "silent-cleanup-arduino-1");
    const dir = scratchDir("arduino-crucible-silent-cleanup-");
    writeFileSync(
      join(dir, ".env"),
      `CRUCIBLE_PROJECT_KEY=${key}\nCRUCIBLE_PROJECT_NAME=silent-cleanup-arduino-1\n`,
    );
    const reportsDir = join(dir, "tests", "native", "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeJunitXmlFile(join(reportsDir, "TEST-native_fixture.xml"), "native_fixture", [
      { name: "led_on" },
    ]);
    const binDir = scratchDir("fake-make-bin-");
    writeExecutable(join(binDir, "make"), NOOP_SCRIPT);

    await runScript(["unit", "--agent", "arduino-gated-agent", "--project-dir", dir], {
      cwd: dir,
      crucibleUrl: proxy.url,
      scriptPath: ARDUINO_SCRIPT_PATH,
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    assertSilentCleanup(proxy.calls, "arduino-gated-agent", key);
  });
});
