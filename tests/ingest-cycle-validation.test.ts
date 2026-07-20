// CR-CRU-024 §S7 — Ingest cycle-reference validity (user ruling 2026-07-17).
//
// Spec (verbatim, docs/changes/CR-CRU-024-patch-cycle-activation-guards.md):
//
//   "It should infact be a validty check on the client side API request ...
//   Crucible should be the source of truth not a client agent request!" — a
//   run ingest carrying `context.cycleId` is VALIDATED against stored plan
//   state, never stored on trust:
//   1. A `cycleId` that matches no cycle in ANY of the project's plans ->
//      400 + AXI help[] naming the project's open plan and its cycle ids
//      (the ingest is refused -- an unlinkable reference must never enter
//      the timeline).
//   2. A `cycleId` referencing a TERMINAL (done/skipped/failed) cycle is
//      ACCEPTED (late ingests are legal) but the response help[] notes the
//      cycle is closed (the agent likely exported a stale
//      WORKFLOW_CYCLE_ID).
//   3. `context.cycle` (the label string) remains free-form display
//      metadata -- no validation.
//
// AC (verbatim):
//   - ingest with context.cycleId = 9999 (no such cycle) -> 400 whose error
//     names the unknown reference and help[] lists the open plan's cycle
//     ids; no event stored (GET events count unchanged).
//   - ingest with a terminal cycle's id -> 200, event stored and linked,
//     help[] mentions the closed cycle; ingest with the ACTIVE cycle's id ->
//     200 with no such note (happy path byte-unchanged apart from additive
//     help).
//   - (guard) a run ingest with NO context.cycleId at all -> unchanged 200,
//     no new validation error -- don't regress plain ingests.
//
// RED phase: NONE of this exists in production yet. src/v2.ts's
// handleRunsParsed (and handleRuns) pass `context` straight to
// store.recordTestEvent() via runMeta() with no cycleId lookup at all --
// types.ts even documents the CURRENT (pre-S7) contract at RunContext.cycleId
// as "Stored verbatim; unknown ids tolerated." Every assertion below that
// expects a 400 refusal or a closed-cycle note will fail against today's
// trust-it-verbatim behavior (an unknown or stale cycleId currently ingests
// 200 with no complaint).
//
// Harness: reuses the EXACT startServer/postJson/getJson/createProject/
// plansPath/filePlanAB/activate conventions from tests/plan-abort.test.ts,
// and the parsedRunBody shape from tests/axi-negotiation.test.ts.

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface PlanCyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanFileResponse {
  planId: number | string;
  cr: string;
  status: string;
  cycles: PlanCyclePayload[];
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanFileResponse[];
}

interface RunsPostResponse {
  ok: boolean;
  changed?: boolean;
  event?: string;
  verdict?: string;
  help?: string[];
  error?: string;
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: true;
  events: Array<{ id: string; context?: { cycleId?: number; cycle?: string }; [key: string]: unknown }>;
}

let servers: ServerHandle[] = [];

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  servers.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of servers) {
    handle.stop();
  }
  servers = [];
});

async function postJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, urlPath: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`);
}

async function createProject(handle: ServerHandle): Promise<string> {
  const res = await postJson(handle, "/api/v2/projects", { name: `ingest-cycle-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
  return body.project.key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
}

async function filePlanAB(
  handle: ServerHandle,
  key: string,
  cr: string,
): Promise<{ planId: number | string; a: number; b: number }> {
  const res = await postJson(handle, plansPath(key), {
    cr,
    cycles: [{ label: "A" }, { label: "B" }],
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as PlanFileResponse;
  return { planId: body.planId, a: body.cycles[0]!.id, b: body.cycles[1]!.id };
}

async function transition(
  handle: ServerHandle,
  key: string,
  planId: number | string,
  cycleId: number,
  status: string,
): Promise<void> {
  const res = await patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
  expect(res.status).toBe(200);
}

/** Builds a passing-summary parsed-run body (never triggers the unrelated afterRed help). */
function parsedRunBody(overrides: {
  projectKey: string;
  agentId?: string;
  context?: Record<string, unknown>;
  summary?: Partial<RunSummary>;
}) {
  return {
    projectKey: overrides.projectKey,
    agentId: overrides.agentId ?? "ingest-cycle-agent",
    summary: {
      total: 3,
      passed: 3,
      failed: 0,
      pending: 0,
      duration_ms: 42,
      ...overrides.summary,
    },
    tree: [
      {
        name: "suite",
        status: "pass",
        children: [{ name: "t1", status: "pass", duration_ms: 10 }],
      },
    ] as SuiteNode[],
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
  };
}

async function postParsedRun(
  handle: ServerHandle,
  projectKey: string,
  context?: Record<string, unknown>,
): Promise<Response> {
  return postJson(handle, "/api/v2/runs/parsed", parsedRunBody({ projectKey, context }));
}

async function eventsForProject(handle: ServerHandle, key: string): Promise<EventsListResponse["events"]> {
  const res = await getJson(handle, `/api/v2/events?project=${key}`);
  const body = (await res.json()) as EventsListResponse;
  return body.events;
}

describe("§S7.1 — run ingest with an unknown context.cycleId is REFUSED (400), never stored on trust", () => {
  test("context.cycleId=9999 (no such cycle in any plan) -> 400, error names the unknown reference, help[] lists the open plan's cycle ids; no event stored", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { a, b } = await filePlanAB(handle, key, "CR-INGEST-CYCLE-UNKNOWN");

    const before = await eventsForProject(handle, key);
    expect(before.length).toBe(0);

    const res = await postParsedRun(handle, key, { cycleId: 9999 });

    expect(res.status).toBe(400);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(false);
    // "error names the unknown reference" — the refused cycleId itself.
    expect(body.error).toContain("9999");
    // "help[] lists the open plan's cycle ids" — both A and B.
    expect(Array.isArray(body.help)).toBe(true);
    const help = body.help as string[];
    expect(help.length).toBeGreaterThan(0);
    expect(help.some((h) => h.includes(String(a)))).toBe(true);
    expect(help.some((h) => h.includes(String(b)))).toBe(true);

    // "no event stored (GET events count unchanged)".
    const after = await eventsForProject(handle, key);
    expect(after.length).toBe(0);
  });

  test("context.cycleId that exists in a SIBLING project but not THIS one -> 400 (validation is per-project, not global)", async () => {
    // One server, two projects in the SAME store. Cycle ids are allocated
    // PER PROJECT (store.nextCycleId scopes MAX(cycle_id) by project_key), so
    // A and B both start at 1 and their id spaces overlap — two isolated
    // servers could therefore never prove scoping (any id absent in B is just
    // the unknown-id case). To actually prove the ingest lookup is scoped to
    // THIS project, give project A a cycle id that B never mints (A files a
    // SECOND plan -> ids 3,4), then ingest that A-only id into B: B owns only
    // [1,2], so the reference is unlinkable HERE even though it is a live
    // cycle in project A. This fails unless findCycle filters by project_key.
    const handle = boot();
    const keyA = await createProject(handle);
    await filePlanAB(handle, keyA, "CR-INGEST-CYCLE-SIBLING-A1"); // A: cycles 1,2
    const { a: aOnly } = await filePlanAB(handle, keyA, "CR-INGEST-CYCLE-SIBLING-A2"); // A: cycles 3,4 -> aOnly=3

    const keyB = await createProject(handle);
    await filePlanAB(handle, keyB, "CR-INGEST-CYCLE-SIBLING-B"); // B: cycles 1,2 (never 3)

    const res = await postParsedRun(handle, keyB, { cycleId: aOnly });
    expect(res.status).toBe(400);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(false);
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as string[]).length).toBeGreaterThan(0);

    const events = await eventsForProject(handle, keyB);
    expect(events.length).toBe(0);
  });
});

describe("§S7.2 — run ingest with a TERMINAL cycle's id is accepted (late ingests are legal) but flagged", () => {
  test("cycleId of a DONE cycle -> 200, event stored and linked, help[] mentions the closed cycle", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a } = await filePlanAB(handle, key, "CR-INGEST-CYCLE-TERMINAL");
    await transition(handle, key, planId, a, "active");
    await transition(handle, key, planId, a, "done");

    const res = await postParsedRun(handle, key, { cycleId: a });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(typeof body.event).toBe("string");

    // "help[] notes the cycle is closed" — must reference the DONE cycle's id.
    expect(Array.isArray(body.help)).toBe(true);
    const help = (body.help as string[]).map((h) => h.toLowerCase());
    expect(help.length).toBeGreaterThan(0);
    expect(help.some((h) => h.includes(String(a)))).toBe(true);

    // "event stored and linked" — the event round-trips with context.cycleId.
    const events = await eventsForProject(handle, key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycleId).toBe(a);
  });

  test("cycleId of a SKIPPED cycle -> 200, event stored and linked, help[] mentions the closed cycle", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a } = await filePlanAB(handle, key, "CR-INGEST-CYCLE-SKIPPED");
    // pending -> skipped is the one sanctioned shortcut transition.
    await transition(handle, key, planId, a, "skipped");

    const res = await postParsedRun(handle, key, { cycleId: a });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as string[]).some((h) => h.includes(String(a)))).toBe(true);

    const events = await eventsForProject(handle, key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycleId).toBe(a);
  });

  test("cycleId of a FAILED cycle -> 200, event stored and linked, help[] mentions the closed cycle", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a } = await filePlanAB(handle, key, "CR-INGEST-CYCLE-FAILED");
    await transition(handle, key, planId, a, "active");
    await transition(handle, key, planId, a, "failed");

    const res = await postParsedRun(handle, key, { cycleId: a });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as string[]).some((h) => h.includes(String(a)))).toBe(true);

    const events = await eventsForProject(handle, key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycleId).toBe(a);
  });
});

describe("§S7 — happy path with the ACTIVE cycle's id stays byte-unchanged apart from additive help", () => {
  test("cycleId of the ACTIVE cycle -> 200, event stored and linked, NO closed-cycle note (help absent, same as pre-S7 behavior for a passing run)", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a, b } = await filePlanAB(handle, key, "CR-INGEST-CYCLE-ACTIVE");
    await transition(handle, key, planId, a, "active");
    await transition(handle, key, planId, a, "done");
    await transition(handle, key, planId, b, "active");

    const res = await postParsedRun(handle, key, { cycleId: b });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(typeof body.event).toBe("string");
    // A passing run against a valid, non-terminal cycle carries no help at
    // all (runResponse only attaches `help` when non-empty) — the S7 closed-
    // cycle note must NOT appear for the currently-active cycle.
    expect(body.help).toBeUndefined();

    const events = await eventsForProject(handle, key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycleId).toBe(b);
  });
});

describe("§S7.3 — context.cycle (the free-form label) is NEVER validated; cycleId absence is a no-op guard", () => {
  test("guard: a run ingest with NO context.cycleId at all -> unchanged 200, no new validation error, no help added by S7", async () => {
    const handle = boot();
    const key = await createProject(handle);
    // No plan filed at all for this project — proves the absence of ANY
    // cycle data never trips the new validation for a context-less ingest.
    const res = await postParsedRun(handle, key, undefined);

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.help).toBeUndefined();

    const events = await eventsForProject(handle, key);
    expect(events.length).toBe(1);
  });

  test("guard: context.cycle (free-form label string) with no cycleId, referencing a project that HAS a plan -> unchanged 200, label stored verbatim, no S7 validation error", async () => {
    const handle = boot();
    const key = await createProject(handle);
    await filePlanAB(handle, key, "CR-INGEST-CYCLE-LABEL-ONLY");

    // "totally-made-up-label" resolves to no real cycle id anywhere — if this
    // were validated like cycleId, it would 400. It must not.
    const res = await postParsedRun(handle, key, { cycle: "totally-made-up-label" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RunsPostResponse;
    expect(body.ok).toBe(true);
    expect(body.help).toBeUndefined();

    const events = await eventsForProject(handle, key);
    expect(events.length).toBe(1);
    expect(events[0]!.context?.cycle).toBe("totally-made-up-label");
  });
});
