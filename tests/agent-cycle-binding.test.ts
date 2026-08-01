// CR-CRU-056 — §S1 (C1, GREEN and merged): POST /api/v2/agents/register
// accepts an OPTIONAL `cycleId` binding, validates it against stored plan
// state, and stores it on the agent row. GET /api/v2/agents exposes the
// stored binding as `boundCycleId`.
//
// C2 (server) RE-POINT (per dispatch — sanctioned): C1's own baseline pins
// ("register with no cycleId still succeeds for every phase, today") are
// flipped HERE into §S2's real contract: RED/GREEN/FIX/VERIFY registration
// with no `cycleId` is now REFUSED (409); ORCHESTRATOR/report unbound
// registration is UNCHANGED (still 200) — a real regression pin, not a RED
// case. §S3 ingest-attach stamping is covered separately in
// tests/ingest-binding-attach.test.ts, not here. No caller-auth on other
// mutating verbs (§S2b/§S3b) — still out of scope for this cycle.
//
// RED phase: handleAgentTouch (src/v2.ts) has NO per-phase cycleId
// requirement yet — every RED/GREEN/FIX/VERIFY unbound-register case below
// reads back 200 today (the C1 baseline this CR is deliberately flipping);
// the ORCHESTRATOR/report block is expected to PASS today AND after GREEN.
//
// Harness: drives the REAL production server (startServer) + real HTTP, the
// same pattern as tests/agent-phase.test.ts (register/heartbeat/GET agents)
// and tests/checkpoint-stop.test.ts (the plans/cycles HTTP surface: POST
// .../plans to file, PATCH .../plans/<planId>/cycles/<id> to transition,
// PATCH .../plans/<planId> to close) — no new mechanism invented here.

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

interface OkResponse {
  ok: true;
  changed?: boolean;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error?: unknown;
  help?: unknown;
  [key: string]: unknown;
}

interface AgentBrief {
  agentId: string;
  projectKey: string;
  liveness: string;
  phase?: string | null;
  // CR-CRU-056 §S1 — the exact field name is this CR's to name; the dispatch
  // suggests `boundCycleId`, so that is what the assertions below pin.
  boundCycleId?: number | null;
  [key: string]: unknown;
}

interface AgentsListResponse {
  ok: true;
  agents: AgentBrief[];
}

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  activatedAt?: number;
  doneAt?: number;
}

interface PlanFileResponse {
  planId: number;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

/** Same helper as tests/agent-phase.test.ts's errorSurface — concatenate
 * every string-ish field an AXI error could carry the named state in, so
 * the assertion survives whatever exact wording GREEN picks while still
 * requiring the actual state (unknown / pending / done / closed-plan) to be
 * NAMED, per §S1's "409 definitive AXI error naming the actual state". */
function errorSurface(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? body.help.join(" ") : String(body.help ?? "");
  return `${String(body.error ?? "")} ${help}`.toLowerCase();
}

const PHASE_ENUM = ["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"] as const;

describe("CR-CRU-056 C1 — agent registration binds an explicit cycle (server, additive)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  // CR-CRU-056 §S2b fixture-repair (C3): plan-file/cycle-transition/plan-
  // close are mutating v2 workflow verbs and now refuse an unregistered
  // caller (409) — merge a live-registered agentId into any JSON body
  // lacking one.
  function withFixtureAgent(body: unknown): unknown {
    if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
      return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
    }
    return body;
  }

  async function postJson(path_: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path_}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function patchJson(path_: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path_}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function getJson(path_: string): Promise<Response> {
    return fetch(`${base()}${path_}`);
  }

  function seedProject(store: Store): string {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
    return key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  // `seedProject` creates the project directly via the store, bypassing the
  // HTTP layer, so "fixture-orch" is never live-registered for it. Register
  // it once per project key, memoized, right before the first
  // workflow-verb HTTP call each fixture helper below makes.
  const fixtureOrchestratorProjects = new Set<string>();

  async function ensureFixtureOrchestrator(key: string): Promise<void> {
    if (fixtureOrchestratorProjects.has(key)) return;
    const res = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId: "fixture-orch",
      phase: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
    fixtureOrchestratorProjects.add(key);
  }

  async function agentByIdFrom(key: string, agentId: string): Promise<AgentBrief | undefined> {
    const listRes = await getJson(`/api/v2/agents?project=${key}`);
    const listBody = (await listRes.json()) as AgentsListResponse;
    return listBody.agents.find((a) => a.agentId === agentId);
  }

  /** Files a ONE-cycle plan through the real plans API (never store.filePlan
   * directly) and returns its ids, WITHOUT activating the cycle — it stays
   * `pending`. */
  async function fileOnly(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
    await ensureFixtureOrchestrator(key);
    const res = await postJson(plansPath(key), { cr, cycles: [{ label: "solo" }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, cycleId: body.cycles[0]!.id };
  }

  /** Files a one-cycle plan and activates it via the real PATCH transition
   * route (CR-CRU-024 §S0), so the cycle is `active` and the plan `open`. */
  async function fileAndActivate(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
    const { planId, cycleId } = await fileOnly(key, cr);
    const activateRes = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      status: "active",
    });
    expect(activateRes.status).toBe(200);
    return { planId, cycleId };
  }

  /** Transitions a cycle to a terminal status via the real PATCH route. */
  async function transitionCycle(
    key: string,
    planId: number,
    cycleId: number,
    status: string,
  ): Promise<void> {
    await ensureFixtureOrchestrator(key);
    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
    expect(res.status).toBe(200);
  }

  /** Closes a plan via the real PATCH route (requires every cycle terminal). */
  async function closePlan(key: string, planId: number): Promise<void> {
    await ensureFixtureOrchestrator(key);
    const res = await patchJson(plansPath(key, `/${planId}`), { status: "closed" });
    expect(res.status).toBe(200);
  }

  // ── §S1 — valid binding: stored + exposed ──────────────────────────────

  describe("§S1 register with a VALID cycle binding", () => {
    test("registering bound to an ACTIVE cycle of an OPEN plan succeeds (200, ok:true) and GET /api/v2/agents exposes the EXACT bound cycle id as boundCycleId", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-056-T1");
      const agentId = "cycle-bound-1";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);

      const agent = await agentByIdFrom(key, agentId);
      expect(agent).toBeDefined();
      // POSITIVE — the EXACT declared cycle id round-trips, not just "some
      // truthy value" (a validator that accepts but discards it would still
      // pass the 200/ok checks above but fail here).
      expect(agent!.boundCycleId).toBe(cycleId);
    });
  });

  // ── §S1 — validation: one refused state per scenario ───────────────────

  describe("§S1 validation — refused bindings (409, ok:false, non-empty help[] naming the actual state)", () => {
    test("register bound to an UNKNOWN cycleId (no such cycle in ANY of this project's plans) is REFUSED — 409, error/help names 'unknown', agent NOT registered", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "cycle-unknown-1";
      const unknownCycleId = 987_654_321;

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId: unknownCycleId,
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as unknown[]).length).toBeGreaterThan(0);
      expect(errorSurface(body)).toContain("unknown");
      // NEGATIVE — no partial write: the refused registration must not
      // create the agent row at all.
      expect(store.hasAgent(key, agentId)).toBe(false);
    });

    test("register bound to a cycle that is still PENDING (never activated) is REFUSED — 409, error/help names 'pending', agent NOT registered", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { cycleId } = await fileOnly(key, "CR-CRU-056-T2-pending");
      const agentId = "cycle-pending-1";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId,
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as unknown[]).length).toBeGreaterThan(0);
      expect(errorSurface(body)).toContain("pending");
      expect(store.hasAgent(key, agentId)).toBe(false);
    });

    test("register bound to a cycle already DONE (plan still open) is REFUSED — 409, error/help names 'done', agent NOT registered", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { planId, cycleId } = await fileAndActivate(key, "CR-CRU-056-T2-done");
      await transitionCycle(key, planId, cycleId, "done");
      const agentId = "cycle-done-1";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId,
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as unknown[]).length).toBeGreaterThan(0);
      expect(errorSurface(body)).toContain("done");
      expect(store.hasAgent(key, agentId)).toBe(false);
    });

    test("register bound to a cycle whose PLAN is now CLOSED is REFUSED — 409, error/help names 'closed', agent NOT registered", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { planId, cycleId } = await fileAndActivate(key, "CR-CRU-056-T2-closed");
      await transitionCycle(key, planId, cycleId, "done");
      await closePlan(key, planId);
      const agentId = "cycle-closed-plan-1";

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId,
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect((body.help as unknown[]).length).toBeGreaterThan(0);
      expect(errorSurface(body)).toContain("closed");
      expect(store.hasAgent(key, agentId)).toBe(false);
    });
  });

  // ── heartbeat must never blank a stored binding ────────────────────────

  describe("heartbeat never blanks a stored cycle binding (mirrors CR-CRU-044's phase contract)", () => {
    test("POST /api/v2/agents/heartbeat with no cycleId field on an already-bound agent still succeeds AND does NOT blank the stored boundCycleId", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-056-T3");
      const agentId = "cycle-heartbeat-1";

      const regRes = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "GREEN",
        cycleId,
      });
      expect(regRes.status).toBe(200);

      const hbRes = await postJson("/api/v2/agents/heartbeat", {
        projectKey: key,
        agentId,
        message: "still working",
      });
      expect(hbRes.status).toBe(200);
      const hbBody = (await hbRes.json()) as OkResponse;
      expect(hbBody.ok).toBe(true);

      const agent = await agentByIdFrom(key, agentId);
      expect(agent).toBeDefined();
      // POSITIVE — still exactly the bound cycle.
      expect(agent!.boundCycleId).toBe(cycleId);
      // NEGATIVE bound — the phase-less/cycle-less touch must never have
      // written null/undefined over the stored binding.
      expect(agent!.boundCycleId).not.toBeNull();
      expect(agent!.boundCycleId).not.toBeUndefined();
    });
  });

  // ── §S2 — TDD phases MUST register bound; ORCHESTRATOR/report unaffected ──
  //
  // CR-CRU-056 C2 — SANCTIONED RE-POINT of this CR's own C1 baseline pins
  // (per dispatch: these six tests were written as "today's baseline" to be
  // consciously flipped by exactly this step). RED phase: handleAgentTouch
  // has NO per-phase cycleId requirement yet — every RED/GREEN/FIX/VERIFY
  // case below reads back 200 (unbound accepted) today; the flip to 409 is
  // what C2 GREEN must build. The ORCHESTRATOR/report block is unchanged
  // (still expected to PASS today AND after GREEN — a real regression pin).
  const TDD_PHASES = PHASE_ENUM.filter(
    (p): p is "RED" | "GREEN" | "FIX" | "VERIFY" => p !== "ORCHESTRATOR" && p !== "report",
  );
  const UNBOUND_OK_PHASES = PHASE_ENUM.filter(
    (p): p is "ORCHESTRATOR" | "report" => p === "ORCHESTRATOR" || p === "report",
  );

  describe("§S2 register with NO cycleId — TDD phases (RED/GREEN/FIX/VERIFY) are REFUSED (409)", () => {
    for (const phase of TDD_PHASES) {
      test(`register with phase:"${phase}" and no cycleId field at all is REFUSED — 409, ok:false, non-empty help[] telling the caller to register with --cycle; agent row NOT created`, async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = `cycle-unbound-${phase}`;

        const res = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          phase,
        });

        expect(res.status).toBe(409);
        const body = (await res.json()) as ErrResponse;
        expect(body.ok).toBe(false);
        expect(Array.isArray(body.help)).toBe(true);
        expect((body.help as unknown[]).length).toBeGreaterThan(0);
        // POSITIVE — the help[] tells the caller HOW to fix it: register
        // with the client's --cycle flag (§S4's fleet surface).
        expect(errorSurface(body)).toContain("--cycle");
        // NEGATIVE — a refused TDD-phase registration must not create a row.
        expect(store.hasAgent(key, agentId)).toBe(false);
      });
    }
  });

  describe("§S2 refusal help[] NAMES the project's actual active cycle when one exists (CR-024 help convention)", () => {
    for (const phase of TDD_PHASES) {
      test(`register with phase:"${phase}", no cycleId, project HAS an active cycle → 409 whose help[] names that ACTUAL active cycle id (not a generic platitude)`, async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const { cycleId: activeCycleId } = await fileAndActivate(
          key,
          `CR-CRU-056-C2-active-${phase}`,
        );
        const agentId = `cycle-unbound-active-${phase}`;

        const res = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          phase,
        });

        expect(res.status).toBe(409);
        const body = (await res.json()) as ErrResponse;
        expect(body.ok).toBe(false);
        // POSITIVE — state-derived: names THIS project's real active cycle id.
        expect(errorSurface(body)).toContain(String(activeCycleId));
        expect(store.hasAgent(key, agentId)).toBe(false);
      });
    }
  });

  describe("§S2 regression — register with NO cycleId still succeeds for ORCHESTRATOR/report (unchanged)", () => {
    for (const phase of UNBOUND_OK_PHASES) {
      test(`register with phase:"${phase}" and no cycleId field at all still succeeds (200, ok:true) and no boundCycleId is fabricated`, async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = `cycle-unbound-${phase}`;

        const res = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          phase,
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as OkResponse;
        expect(body.ok).toBe(true);
        expect(store.hasAgent(key, agentId)).toBe(true);

        const agent = await agentByIdFrom(key, agentId);
        expect(agent).toBeDefined();
        // NEGATIVE — no binding fabricated when none was declared.
        expect(agent!.boundCycleId === undefined || agent!.boundCycleId === null).toBe(true);
      });
    }
  });

  // ── re-registration rebinds explicitly ─────────────────────────────────

  describe("re-registration rebinds explicitly; a refused rebind never mutates the stored binding", () => {
    test("re-registering the SAME agent id with a DIFFERENT valid cycle binding updates the stored boundCycleId to the NEW value", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { cycleId: cycleA } = await fileAndActivate(key, "CR-CRU-056-T5-rebind-A");
      const { cycleId: cycleB } = await fileAndActivate(key, "CR-CRU-056-T5-rebind-B");
      const agentId = "cycle-rebind-1";

      const first = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId: cycleA,
      });
      expect(first.status).toBe(200);

      const second = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId: cycleB,
      });
      expect(second.status).toBe(200);

      const agent = await agentByIdFrom(key, agentId);
      expect(agent).toBeDefined();
      expect(agent!.boundCycleId).toBe(cycleB);
      // NEGATIVE — the OLD binding must not linger alongside/instead of the new one.
      expect(agent!.boundCycleId).not.toBe(cycleA);
    });

    test("re-registering the SAME agent id with an INVALID cycle binding is REFUSED (409) AND the previously stored boundCycleId is UNCHANGED", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { cycleId: validCycle } = await fileAndActivate(key, "CR-CRU-056-T5-refused-rebind");
      const agentId = "cycle-rebind-2";

      const first = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId: validCycle,
      });
      expect(first.status).toBe(200);

      const bogusCycleId = 123_456_789;
      const second = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId: bogusCycleId,
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as ErrResponse;
      expect(body.ok).toBe(false);

      const agent = await agentByIdFrom(key, agentId);
      expect(agent).toBeDefined();
      // POSITIVE — the refused rebind must not have overwritten the valid one.
      expect(agent!.boundCycleId).toBe(validCycle);
      // NEGATIVE bound — must not have picked up the bogus id either.
      expect(agent!.boundCycleId).not.toBe(bogusCycleId);
    });
  });

  // ── unregister leaves no binding to leak ───────────────────────────────

  describe("unregister removes the row as today — no binding leaks into a fresh registration of the same id", () => {
    // CR-CRU-056 C2 final sweep (orchestrator decision): §S2 now REQUIRES a
    // TDD-phase (GREEN) registration to be bound, so the re-registration
    // below must supply a FRESH cycle binding — but the test's actual
    // purpose (a leak check, not the auth model) is unchanged: the OLD
    // binding must never resurface on the fresh row. Asserted here as "the
    // NEW binding is exposed exactly, and it is NOT the old one" instead of
    // "no binding at all".
    test("unregister deletes the bound agent row; re-registering the SAME agent id afterward with a NEW cycleId does not inherit the OLD boundCycleId", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const { cycleId } = await fileAndActivate(key, "CR-CRU-056-T6");
      const agentId = "cycle-unregister-1";

      const regRes = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "RED",
        cycleId,
      });
      expect(regRes.status).toBe(200);
      expect(store.hasAgent(key, agentId)).toBe(true);

      const unregRes = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
      expect(unregRes.status).toBe(200);
      const unregBody = (await unregRes.json()) as OkResponse;
      expect(unregBody.changed).toBe(true);
      expect(store.hasAgent(key, agentId)).toBe(false);

      const { cycleId: freshCycleId } = await fileAndActivate(key, "CR-CRU-056-T6-rebind-after-unregister");
      const reregRes = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId,
        phase: "GREEN",
        cycleId: freshCycleId,
      });
      expect(reregRes.status).toBe(200);

      const agent = await agentByIdFrom(key, agentId);
      expect(agent).toBeDefined();
      // POSITIVE — the NEW binding is exposed exactly.
      expect(agent!.boundCycleId).toBe(freshCycleId);
      // NEGATIVE bound — the old binding from the deleted row must never
      // resurface on/leak into the fresh row.
      expect(agent!.boundCycleId).not.toBe(cycleId);
    });
  });
});
