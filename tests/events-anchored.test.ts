// CR-CRU-032 §S1 — anchored events query: GET /api/v2/events?project=<k>&cycleId=<id>
// returns ONE cycle's linked runs + its declared "Cycle done" boundary, without
// pulling all project history. Additive, TOON-negotiable like sibling v2 GET
// routes; the existing `?limit=N` recent-feed behavior (no cycleId) is
// byte-unchanged. Unknown cycleId -> empty set (never a 4xx).
//
// RED phase: `handleEventsList` (src/v2.ts ~line 1260) has NO cycleId
// awareness at all today — it only reads `project`/`limit`. Every assertion
// below that expects cycleId-scoped filtering or the boundary payload will
// fail against current production (either the extra runs/other-cycle noise
// will still be present, or the boundary field will be `undefined`).
//
// Query param naming: the CR prose's Scope section uses "e.g. projectKey=<k>"
// as an illustrative example only; its Acceptance Criteria bullet for §S1
// does NOT pin the project param's name, and explicitly requires this route
// stay "TOON-negotiable like sibling v2 GET routes" — EVERY existing v2 GET
// route (handleEventsList itself, the activity feed, etc., see
// tests/axi-negotiation.test.ts, tests/ingest-cycle-validation.test.ts,
// tests/v2-brief-reshape.test.ts) scopes by `?project=<key>`, never
// `?projectKey=`. This file uses `project=<key>` to match that sibling
// convention rather than inventing a new, inconsistent param name.
// ESCALATION: the C1 dispatch prompt's illustrative examples said
// `projectKey=<k>`; flagging the substitution to `project=<key>` here since
// it is what every sibling v2 GET route (and the CR's own "like sibling v2
// GET routes" requirement) actually uses — confirm with GREEN before wiring.
//
// Boundary-row shape: neither the CR doc nor the dispatch pins the exact
// wire shape of "its declared `Cycle done` boundary row". Client-side
// (public/app-logic.mjs `timelineRows`), a declared marker is NEVER a raw
// event — it is derived purely by crossing a linked RunEvent against
// separately-fetched PlanCycle data (`{cycle, plan}` from
// GET /projects/:key/plans). There is no precedent anywhere in store.ts for
// a synthesized "boundary" RunEvent. Given the route must be self-sufficient
// (return the boundary WITHOUT a second /plans round trip) this file pins
// the boundary as an ADDITIVE top-level `cycle` field (sibling to `events`,
// not smuggled into the `events` array as a fake RunEvent) shaped exactly
// like the PlanCycle objects `Store#toPlan`/`editCycleLabel` already return
// to clients: `{ id, label, kind, status, activatedAt?, doneAt? }`. This is
// the RED agent's best-grounded interpretation of an underspecified AC —
// ESCALATION: confirm this shape (or swap for whatever GREEN actually
// implements) before merge; the important, unambiguous behavior this file
// locks down is that SOME distinguishable boundary descriptor for the
// requested cycle is present, resolved via `Store#findCycle` (CR-024 §S7),
// and that it is ABSENT for an unknown cycleId.
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

interface EventBrief {
  id: string;
  projectKey: string;
  timestamp: number;
  context?: { cycleId?: number; cycle?: string };
  [key: string]: unknown;
}

interface AnchoredEventsResponse {
  ok: true;
  events: EventBrief[];
  cycle?: {
    id: number;
    label: string;
    kind: string;
    status: string;
    activatedAt?: number;
    doneAt?: number;
  };
  [key: string]: unknown;
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

// CR-CRU-056 §S2b fixture-repair (C3): mutating v2 workflow verbs
// (plan-file, cycle transitions) now refuse an unregistered caller (409) —
// merge a live-registered agentId into any JSON body lacking one.
function withFixtureAgent(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

async function postJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function patchJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function getRaw(handle: ServerHandle, urlPath: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`);
}

async function registerAgent(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", { projectKey: key, agentId, role: "ORCHESTRATOR" });
  expect(res.status).toBe(200);
}

async function createProject(handle: ServerHandle): Promise<string> {
  const res = await postJson(handle, "/api/v2/projects", { name: `anchor-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
  await registerAgent(handle, body.project.key, "fixture-orch");
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

function parsedRunBody(overrides: {
  projectKey: string;
  agentId?: string;
  context?: Record<string, unknown>;
  summary?: Partial<RunSummary>;
}) {
  return {
    projectKey: overrides.projectKey,
    agentId: overrides.agentId ?? "anchor-agent",
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
  agentId: string,
  context?: Record<string, unknown>,
): Promise<{ status: number; id: string }> {
  const res = await postJson(
    handle,
    "/api/v2/runs/parsed",
    parsedRunBody({ projectKey, agentId, context }),
  );
  const body = (await res.json()) as { ok: boolean; event?: string };
  return { status: res.status, id: body.event ?? "" };
}

async function getAnchoredEvents(
  handle: ServerHandle,
  key: string,
  cycleId: number,
): Promise<{ status: number; body: AnchoredEventsResponse }> {
  const res = await getRaw(handle, `/api/v2/events?project=${key}&cycleId=${cycleId}`);
  const body = (await res.json()) as AnchoredEventsResponse;
  return { status: res.status, body };
}

describe("§S1 — GET /api/v2/events?project=<k>&cycleId=<id> (anchored fetch)", () => {
  test("returns ONLY the requested cycle's linked runs + its Cycle done boundary — other-cycle and unlinked runs excluded", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a, b } = await filePlanAB(handle, key, "CR-ANCHOR-HAPPY");

    // Cycle A: activate then close — this is the anchored target, "done".
    await transition(handle, key, planId, a, "active");
    await transition(handle, key, planId, a, "done");
    // Cycle B stays pending/active — its own run must NOT show up under A's anchor.
    await transition(handle, key, planId, b, "active");

    await registerAgent(handle, key, "agent-a");
    await registerAgent(handle, key, "agent-b");
    await registerAgent(handle, key, "agent-unlinked");
    const linkedToA = await postParsedRun(handle, key, "agent-a", { cycleId: a });
    const linkedToB = await postParsedRun(handle, key, "agent-b", { cycleId: b });
    const unlinked = await postParsedRun(handle, key, "agent-unlinked");

    expect(linkedToA.status).toBe(200);
    expect(linkedToB.status).toBe(200);
    expect(unlinked.status).toBe(200);

    const { status, body } = await getAnchoredEvents(handle, key, a);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    // Exactly the linked run for A — B's run and the unlinked run are absent.
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain(linkedToA.id);
    expect(ids).not.toContain(linkedToB.id);
    expect(ids).not.toContain(unlinked.id);
    expect(body.events.every((e) => e.context?.cycleId === a)).toBe(true);
    expect(body.events.length).toBe(1);

    // The cycle's declared "Cycle done" boundary is present and identifies
    // cycle A specifically (resolved via Store#findCycle, CR-024 §S7).
    expect(body.cycle).toBeDefined();
    expect(body.cycle!.id).toBe(a);
    expect(body.cycle!.label).toBe("A");
    expect(body.cycle!.status).toBe("done");
    expect(typeof body.cycle!.doneAt).toBe("number");
  });

  test("unknown cycleId (no such cycle in any plan) -> 200 with an EMPTY set, never a 4xx", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a } = await filePlanAB(handle, key, "CR-ANCHOR-UNKNOWN");
    await transition(handle, key, planId, a, "active");
    await transition(handle, key, planId, a, "done");
    await registerAgent(handle, key, "agent-a");
    await postParsedRun(handle, key, "agent-a", { cycleId: a });

    const { status, body } = await getAnchoredEvents(handle, key, 999999);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.events).toEqual([]);
    expect(body.cycle).toBeUndefined();
  });

  test("?fmt=toon on the anchored route negotiates the same TOON contract as sibling v2 GET routes", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a } = await filePlanAB(handle, key, "CR-ANCHOR-TOON");
    await transition(handle, key, planId, a, "active");
    await transition(handle, key, planId, a, "done");
    await registerAgent(handle, key, "agent-a");
    await postParsedRun(handle, key, "agent-a", { cycleId: a });

    const res = await getRaw(handle, `/api/v2/events?project=${key}&cycleId=${a}&fmt=toon`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/toon; charset=utf-8");
    const text = await res.text();
    const firstLine = text.split("\n")[0] ?? "";
    expect(firstLine).toBe("ok: true");
  });

  test("regression: GET /api/v2/events?project=<k>&limit=N (no cycleId) is byte-unchanged — the recent-N feed still works", async () => {
    const handle = boot();
    const key = await createProject(handle);

    // Five unlinked runs, no plan/cycleId involved at all. Register all
    // agents UP FRONT (each registration's own "lifecycle" event lands
    // before any of the 5 test events) so the 5 real runs are the 5 NEWEST
    // events — `limit=2` below fetches exactly the 2 newest of THOSE.
    for (let i = 0; i < 5; i += 1) {
      await registerAgent(handle, key, `agent-${i}`);
    }
    for (let i = 0; i < 5; i += 1) {
      await postParsedRun(handle, key, `agent-${i}`);
    }

    const res = await getRaw(handle, `/api/v2/events?project=${key}&limit=2`);
    const body = (await res.json()) as AnchoredEventsResponse;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The pre-existing recent-N behavior: exactly `limit` events, newest first.
    expect(body.events.length).toBe(2);
    // No cycleId was requested — the additive `cycle` boundary field must be
    // absent, proving §S1 is purely additive and doesn't leak into the plain
    // recent-feed path.
    expect(body.cycle).toBeUndefined();
  });
});
