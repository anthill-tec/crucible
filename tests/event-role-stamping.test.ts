// CR-CRU-057 — §S1: role must survive the agent. CR-CRU-044 made `role` a
// required, enum-constrained registration field, but stored it ONLY on the
// live `agents` row — and `unregister` deletes that row. So the moment an
// agent finishes (the state most of the board is in, most of the time),
// there is nothing server-side left to classify its work by declared role.
//
// CR-CRU-056 already built the ONE stamping seam this CR extends:
// `resolveIngestAttach` (src/v2.ts) fetches the posting agent's row on
// EVERY ingest and stamps server-derived data (the bound cycle) onto the
// stored event; `attachEcho` echoes that stamped context back in the
// response. This CR rides that SAME seam to also carry the agent's
// DECLARED ROLE — never a parallel agent lookup, never a name-derived
// guess (the exact `phaseRole(agentId)` dependency CR-044 was meant to
// kill, still alive end-to-end until this ships).
//
// RED phase: NONE of this exists in production yet — `events` carries no
// `role` column at all, so every assertion on `event.role` /
// `role_inferred` / the response's `role` echo below fails today (the
// keys are simply absent from the stored row and from the JSON envelope).
//
// Harness: drives the REAL production server (startServer) + real HTTP,
// following tests/agent-cycle-binding.test.ts (fileAndActivate/register
// conventions) and tests/ingest-binding-attach.test.ts (parsedRunBody/
// eventsForProject/response-echo conventions) — no new mechanism invented.

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface RunsPostResponse {
  ok: boolean;
  changed?: boolean;
  event?: string;
  help?: string[];
  context?: { cycleId?: number };
  // CR-CRU-057 §S1 — the field NAME is this CR's to pick; the dispatch says
  // the echo reports "the role it stamped, alongside CR-056's
  // context.cycleId echo" (a top-level SIBLING to `context`, mirroring how
  // `role` itself is a top-level sibling of `context` on the Agent type)
  // — that placement is what the assertions below pin.
  role?: string;
  [key: string]: unknown;
}

interface EventBrief {
  id: string;
  agentId: string;
  kind: string;
  action?: string;
  context?: { cycleId?: number };
  role?: string | null;
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: true;
  events: EventBrief[];
}

interface PlanCyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanFileResponse {
  planId: number;
  cr: string;
  status: string;
  cycles: PlanCyclePayload[];
  [key: string]: unknown;
}

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

function boot(): ServerHandle {
  handle = startServer({ port: 0, dbPath: ":memory:" });
  return handle;
}

// CR-CRU-056 §S2b fixture-repair convention (agent-cycle-binding.test.ts /
// ingest-binding-attach.test.ts): mutating v2 workflow verbs refuse an
// unregistered caller — merge a live-registered agentId into any JSON body
// lacking one.
function withFixtureAgent(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !("agentId" in (body as Record<string, unknown>))
  ) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

async function postJson(path_: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function patchJson(path_: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${path_}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function getJson(path_: string): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${path_}`);
}

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
  return key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
}

const fixtureOrchestratorProjects = new Set<string>();

async function ensureFixtureOrchestrator(key: string): Promise<void> {
  if (fixtureOrchestratorProjects.has(key)) return;
  const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId: "fixture-orch", role: "ORCHESTRATOR" }),
  });
  expect(res.status).toBe(200);
  fixtureOrchestratorProjects.add(key);
}

/** Files a one-cycle plan and activates it via the real PATCH transition route. */
async function fileAndActivate(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
  await ensureFixtureOrchestrator(key);
  const res = await postJson(plansPath(key), { cr, cycles: [{ label: "solo" }] });
  expect(res.status).toBe(201);
  const body = (await res.json()) as PlanFileResponse;
  const planId = body.planId;
  const cycleId = body.cycles[0]!.id;
  const activateRes = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
    status: "active",
  });
  expect(activateRes.status).toBe(200);
  return { planId, cycleId };
}

async function registerBound(
  key: string,
  agentId: string,
  role: string,
  cycleId: number,
): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role, cycleId });
  expect(res.status).toBe(200);
}

async function registerUnbound(key: string, agentId: string, role: string): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role });
  expect(res.status).toBe(200);
}

async function unregisterAgent(key: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
  expect(res.status).toBe(200);
}

/** Builds a passing-summary parsed-run body (never triggers the unrelated afterRed help). */
function parsedRunBody(overrides: { projectKey: string; agentId: string }) {
  return {
    projectKey: overrides.projectKey,
    agentId: overrides.agentId,
    summary: {
      total: 3,
      passed: 3,
      failed: 0,
      pending: 0,
      duration_ms: 42,
    } as RunSummary,
    tree: [
      {
        name: "suite",
        status: "pass",
        children: [{ name: "t1", status: "pass", duration_ms: 10 }],
      },
    ] as SuiteNode[],
  };
}

async function postParsedRun(key: string, agentId: string): Promise<Response> {
  return postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key, agentId }));
}

async function postCompile(key: string, agentId: string): Promise<Response> {
  return postJson("/api/v2/runs/compile", {
    projectKey: key,
    agentId,
    errors: "src/thing.ts(1,1): error TS1234: something is wrong",
    format: "tsc",
  });
}

async function postGate(key: string, agentId: string): Promise<Response> {
  return postJson("/api/v2/gates", {
    projectKey: key,
    agentId,
    gate: { intent: "verify", outcome: "passed", steps: [] },
  });
}

async function eventsForProject(key: string): Promise<EventBrief[]> {
  const res = await getJson(`/api/v2/events?project=${key}`);
  const body = (await res.json()) as EventsListResponse;
  return body.events;
}

async function testEventsForProject(key: string): Promise<EventBrief[]> {
  return (await eventsForProject(key)).filter((e) => e.kind === "test");
}

async function lifecycleEventsForProject(key: string): Promise<EventBrief[]> {
  return (await eventsForProject(key)).filter((e) => e.kind === "lifecycle");
}

/**
 * The exact `role_inferred` field NAME is this CR's to pick. The CR spec
 * names the SQL column `events.role_inferred`; every prior CR-044/CR-056
 * domain/JSON pair camelCases the equivalent (bound_cycle_id/boundCycleId,
 * first_seen/firstSeen), so `roleInferred` is the expected JSON key — read
 * defensively under either spelling so a legitimate naming choice on either
 * side of that DB/JSON split isn't what fails this test.
 */
function roleInferredOf(e: EventBrief): unknown {
  const rec = e as unknown as Record<string, unknown>;
  return "roleInferred" in rec ? rec.roleInferred : rec.role_inferred;
}

/** True only for an EXPLICIT false/0 — absence (undefined) must NOT pass. */
function isDeclaredNotInferred(v: unknown): boolean {
  return v === false || v === 0;
}

const TDD_ROLES = ["RED", "GREEN", "VERIFY"] as const;

describe("CR-CRU-057 §S1 — role survives the agent (event-level stamping)", () => {
  describe("stamping — a bound TDD-role agent's run ingest stamps its declared role onto the stored event", () => {
    for (const role of TDD_ROLES) {
      test(`registered role:"${role}" (bound) -> run ingest's STORED event carries role:"${role}" and role_inferred false/0 (declared, not inferred)`, async () => {
        boot();
        const store = handle!.store;
        const key = seedProject(store);
        const { cycleId } = await fileAndActivate(key, `CR-CRU-057-stamp-${role}`);
        const agentId = `stamp-${role}-1`;
        await registerBound(key, agentId, role, cycleId);

        const res = await postParsedRun(key, agentId);
        expect(res.status).toBe(200);

        const events = await testEventsForProject(key);
        expect(events.length).toBe(1);
        // POSITIVE — the exact declared role, not a guess.
        expect(events[0]!.role).toBe(role);
        // POSITIVE (declared, not backfilled) — explicit false/0, not absence.
        expect(isDeclaredNotInferred(roleInferredOf(events[0]!))).toBe(true);
      });
    }
  });

  describe("the wound this CR closes — a stored event's role survives the posting agent's unregistration", () => {
    test('RED-role agent\'s run event still reports role:"RED" via the events API AFTER the agent unregisters (its row is deleted)', async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-057-wound");
      const agentId = "wound-red-1";
      await registerBound(key, agentId, "RED", cycleId);

      const ingestRes = await postParsedRun(key, agentId);
      expect(ingestRes.status).toBe(200);

      // The wound: unregister hard-deletes the agent row entirely.
      await unregisterAgent(key, agentId);
      expect(store.hasAgent(key, agentId)).toBe(false);

      const events = await testEventsForProject(key);
      expect(events.length).toBe(1);
      // POSITIVE — role read back from the STORED EVENT; the agent row is
      // long gone by the time this assertion runs.
      expect(events[0]!.role).toBe("RED");
    });
  });

  describe("lifecycle events carry the role too", () => {
    test("the 'registered' lifecycle event stamps the agent's declared role at registration", async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-057-lifecycle-registered");
      const agentId = "lifecycle-verify-1";
      await registerBound(key, agentId, "VERIFY", cycleId);

      const lifecycle = await lifecycleEventsForProject(key);
      const registered = lifecycle.find((e) => e.agentId === agentId && e.action === "registered");
      expect(registered).toBeDefined();
      // POSITIVE — the registration event names the declared role exactly.
      expect(registered!.role).toBe("VERIFY");
    });

    test("the 'unregistered' lifecycle event stamps the SAME role the agent had, even though its row is already deleted by the time the event is queried", async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-057-lifecycle-unregistered");
      const agentId = "lifecycle-fix-1";
      await registerBound(key, agentId, "FIX", cycleId);

      await unregisterAgent(key, agentId);
      expect(store.hasAgent(key, agentId)).toBe(false);

      const lifecycle = await lifecycleEventsForProject(key);
      const unregistered = lifecycle.find((e) => e.agentId === agentId && e.action === "unregistered");
      expect(unregistered).toBeDefined();
      // POSITIVE — the unregistration event carries the role captured
      // BEFORE the row was deleted, not a blank/null value.
      expect(unregistered!.role).toBe("FIX");
    });
  });

  describe("compile and gate ingests stamp role on the same footing as run ingests", () => {
    test('compile ingest from a registered GREEN-role agent -> the STORED compile event carries role:"GREEN"', async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-057-compile-stamp");
      const agentId = "compile-green-1";
      await registerBound(key, agentId, "GREEN", cycleId);

      const res = await postCompile(key, agentId);
      expect(res.status).toBe(200);

      const events = await eventsForProject(key);
      const compileEvent = events.find((e) => e.kind === "compile");
      expect(compileEvent).toBeDefined();
      expect(compileEvent!.role).toBe("GREEN");
    });

    test('gate ingest from a registered VERIFY-role agent -> the STORED gate event carries role:"VERIFY"', async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-057-gate-stamp");
      const agentId = "gate-verify-1";
      await registerBound(key, agentId, "VERIFY", cycleId);

      const res = await postGate(key, agentId);
      expect(res.status).toBe(201);

      const events = await eventsForProject(key);
      const gateEvent = events.find((e) => e.kind === "gate");
      expect(gateEvent).toBeDefined();
      expect(gateEvent!.role).toBe("VERIFY");
    });
  });

  describe("response echo — the ingest response reports the stamped role alongside CR-056's context.cycleId echo", () => {
    test("run ingest response carries role alongside context.cycleId, matching the stored event exactly", async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-057-echo-runs");
      const agentId = "echo-red-1";
      await registerBound(key, agentId, "RED", cycleId);

      const res = await postParsedRun(key, agentId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.ok).toBe(true);
      // POSITIVE — the response NAMES the role it stamped, alongside the
      // already-established context.cycleId echo.
      expect(body.context?.cycleId).toBe(cycleId);
      expect(body.role).toBe("RED");

      const events = await testEventsForProject(key);
      expect(events.length).toBe(1);
      // The echo must agree with what actually landed in the feed — never
      // an independent guess.
      expect(body.role).toBe(events[0]!.role as string);
    });

    test("gate ingest response ALSO carries role alongside context.cycleId (the second stamped surface answers identically)", async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-057-echo-gates");
      const agentId = "echo-fix-1";
      await registerBound(key, agentId, "FIX", cycleId);

      const res = await postGate(key, agentId);
      expect(res.status).toBe(201);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.ok).toBe(true);
      expect(body.context?.cycleId).toBe(cycleId);
      expect(body.role).toBe("FIX");
    });
  });

  describe("no fabrication — nothing derives role from the agent id string", () => {
    test("an agent id ENDING '-RED' but registered role:\"report\" stamps report verbatim, never a name-derived RED", async () => {
      boot();
      const store = handle!.store;
      const key = seedProject(store);
      // Deliberately shaped like a TDD-role id (the exact CR-CRU-046 stray
      // `-baseline`/`-RED` failure mode this CR closes) but DECLARED report.
      const agentId = "widget-99-bun-RED";
      await registerUnbound(key, agentId, "report");

      const res = await postParsedRun(key, agentId);
      expect(res.status).toBe(200);

      const events = await testEventsForProject(key);
      expect(events.length).toBe(1);
      // POSITIVE — the declared role, verbatim.
      expect(events[0]!.role).toBe("report");
      // NEGATIVE — never the name-shaped guess the id would suggest.
      expect(events[0]!.role).not.toBe("RED");
    });
  });
});
