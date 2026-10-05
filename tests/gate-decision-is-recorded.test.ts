// CR-CRU-162 C1 (server) RED — a gate decision is its own record.
//
// Decisions made here (binding for C2/C3, stated in the RED report too):
//   - Route: POST /api/v2/gate-decisions, flat and top-level beside
//     POST /api/v2/gates (the "release-proposals" nested segment already
//     shows this codebase uses hyphenated path segments).
//   - Request body: {projectKey, agentId, context?, decision:{runId, action,
//     step?, findings?, addedFinding?, instructions?, reason?}} — `decision`
//     nests the no-mistakes-shaped fields exactly as `gate` nests the gate
//     snapshot on POST /api/v2/gates. `action` is the required enum
//     (approve|fix|skip); `runId` is required (G5 — it is the only thing
//     that ties a decision back to its gate). `findings` is an array of
//     finding ids; `addedFinding` is ONE JSON object (G2: "not free text,
//     not repeatable"), never an array/string/number.
//   - Response: {ok:true, changed:true, decision:<decision id>, ...attachEcho},
//     201 — a decision is not an event, so its id is never called one
//     (orchestrator ruling at C1 GREEN; not a CR-CRU-140 evidence route).
//   - Same caller/attach seam as /gates: requireRegisteredCaller (409 on an
//     unregistered poster) then resolveIngestAttach(..., validateUnbound:
//     false) — a bound agent's decision is cycle-stamped from its binding,
//     same as a gate snapshot.
//   - The no-mistakes run id rides INSIDE the posted gate object, nested at
//     `gate.run.id` (mirroring no-mistakes' own axi snapshot shape — G5:
//     "every axi snapshot has run.id"), and the server lifts it to a
//     first-class `runId` on the stored gate event. Absent when the posted
//     gate carries no such id (never fabricated).
//   - "The gate read" (AC6) is the event-DETAIL route, GET
//     /api/v2/events/:id: a gate event's response gains a `decisions` array
//     — that run's decisions, in the order they were posted — ONLY on the
//     single-event detail read, never on the brief list
//     (GET /api/v2/events), which stays one row per event with no per-event
//     join. The drill-in opens a brief card to request this detail.
//
// This file drives the REAL production server (startServer) — POST
// /api/v2/gate-decisions does not exist in src/v2.ts yet (every request
// below 404s through the catch-all), `gate.run.id` is not yet lifted onto
// the event, and GET /api/v2/events/:id never adds a `decisions` key — every
// assertion below fails against production as it stands.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer, type ServerHandle } from "../src/server.ts";

interface OkResponse {
  ok: true;
  changed?: boolean;
  event?: string;
  decision?: string;
  context?: { cycleId?: number };
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: string[];
  [key: string]: unknown;
}

interface DecisionWire {
  id?: string;
  agentId?: string;
  runId?: string;
  step?: string;
  action?: string;
  findings?: string[];
  addedFinding?: Record<string, unknown>;
  instructions?: string;
  reason?: string;
  context?: { cycleId?: number };
  [key: string]: unknown;
}

interface EventDetail {
  id: string;
  kind: string;
  runId?: string;
  decisions?: DecisionWire[];
  [key: string]: unknown;
}

interface EventDetailResponse {
  ok: true;
  event: unknown;
}

interface EventBrief {
  id: string;
  kind: string;
  decisions?: DecisionWire[];
  [key: string]: unknown;
}

interface EventsListResponse extends OkResponse {
  events: EventBrief[];
}

interface PlanCyclePayload {
  id: number;
  label: string;
  status: string;
}

interface PlanFileResponse {
  planId: number;
  cr: string;
  cycles: PlanCyclePayload[];
  [key: string]: unknown;
}

describe("POST /api/v2/gate-decisions — a gate decision is its own record (CR-CRU-162 C1)", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    await registerAgent(body.project.key, "orchestrator-1");
    return body.project.key;
  }

  async function registerAgent(key: string, agentId: string, role = "ORCHESTRATOR"): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role });
    expect(res.status).toBe(200);
  }

  async function registerBound(key: string, agentId: string, role: string, cycleId: number): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role, cycleId });
    expect(res.status).toBe(200);
  }

  async function fileAndActivate(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
    const res = await postJson(`/api/v2/projects/${key}/plans`, {
      cr,
      cycles: [{ label: "solo" }],
      agentId: "orchestrator-1",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    const planId = body.planId;
    const cycleId = body.cycles[0]!.id;
    const activateRes = await patchJson(`/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
      status: "active",
      agentId: "orchestrator-1",
    });
    expect(activateRes.status).toBe(200);
    return { planId, cycleId };
  }

  function defaultGate(overrides: Record<string, unknown> = {}) {
    return {
      intent: "wave 7 no-mistakes gate",
      outcome: "passed",
      steps: [{ name: "review", status: "passed" }],
      ...overrides,
    };
  }

  async function postGate(key: string, agentId: string, gateOverrides: Record<string, unknown> = {}): Promise<string> {
    const res = await postJson("/api/v2/gates", {
      projectKey: key,
      agentId,
      gate: defaultGate(gateOverrides),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResponse;
    return body.event as string;
  }

  async function getEventDetail(id: string): Promise<EventDetail> {
    const res = await getJson(`/api/v2/events/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventDetailResponse;
    return body.event as EventDetail;
  }

  function decisionBody(
    key: string,
    agentId: string,
    decisionOverrides: Record<string, unknown> = {},
    topOverrides: Record<string, unknown> = {},
  ) {
    return {
      projectKey: key,
      agentId,
      decision: {
        runId: "run-162-default",
        action: "fix",
        step: "review",
        findings: ["F1", "F2"],
        addedFinding: { id: "F3", file: "src/a.ts", description: "late catch" },
        instructions: "fix F1 and F2 only",
        reason: "F2 is a flake, fixed instead of declined",
        ...decisionOverrides,
      },
      ...topOverrides,
    };
  }

  // ── AC6 server half (a) — gate events carry the no-mistakes runId ───────

  describe("gate events carry the no-mistakes runId (G5), from gate.run.id", () => {
    test("POST /api/v2/gates with gate.run.id -> GET /api/v2/events/:id answers event.runId with that EXACT id; a SIBLING gate with no run id, or run present but no id, carries NO runId key at all (never fabricated)", async () => {
      boot();
      const key = await createProject("gate-run-id-present");
      const withId = await postGate(key, "orchestrator-1", { run: { id: "run-162-abc123" } });
      const withoutRun = await postGate(key, "orchestrator-1");
      const runNoId = await postGate(key, "orchestrator-1", { run: { head: "abc1234" } });

      const eventWithId = await getEventDetail(withId);
      expect(eventWithId.runId).toBe("run-162-abc123");

      const eventWithoutRun = await getEventDetail(withoutRun);
      expect("runId" in eventWithoutRun).toBe(false);

      const eventRunNoId = await getEventDetail(runNoId);
      expect("runId" in eventRunNoId).toBe(false);
    });
  });

  // ── AC2 server half — recording one decision ─────────────────────────────

  describe("POST /api/v2/gate-decisions — one call records one decision", () => {
    test("full decision payload -> 201, ok:true, changed:true, event:<id>; the GATE event's detail read then carries it, verbatim, inside decisions[]", async () => {
      boot();
      const key = await createProject("decision-full-payload");
      const gateEventId = await postGate(key, "orchestrator-1", { run: { id: "run-162-full" } });

      const res = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { runId: "run-162-full" }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);
      expect(typeof body.decision).toBe("string");

      const event = await getEventDetail(gateEventId);
      expect(event.decisions).toBeDefined();
      expect(event.decisions).toHaveLength(1);
      const decision = event.decisions![0]!;
      expect(decision.id).toBe(body.decision);
      expect(decision.agentId).toBe("orchestrator-1");
      expect(decision.runId).toBe("run-162-full");
      expect(decision.step).toBe("review");
      expect(decision.action).toBe("fix");
      expect(decision.findings).toEqual(["F1", "F2"]);
      expect(decision.addedFinding).toEqual({ id: "F3", file: "src/a.ts", description: "late catch" });
      expect(decision.instructions).toBe("fix F1 and F2 only");
      expect(decision.reason).toBe("F2 is a flake, fixed instead of declined");
    });

    test("each of the three actions (approve, fix, skip) is accepted -> 201", async () => {
      boot();
      const key = await createProject("decision-action-values");
      for (const action of ["approve", "fix", "skip"]) {
        const res = await postJson(
          "/api/v2/gate-decisions",
          decisionBody(key, "orchestrator-1", { runId: `run-${action}`, action }),
        );
        expect(res.status).toBe(201);
      }
    });

    test("a decision with NO addedFinding/instructions/reason/step still records -> 201, and the read carries none of those keys (never fabricated empties)", async () => {
      boot();
      const key = await createProject("decision-minimal-payload");
      const gateEventId = await postGate(key, "orchestrator-1", { run: { id: "run-162-minimal" } });

      const res = await postJson("/api/v2/gate-decisions", {
        projectKey: key,
        agentId: "orchestrator-1",
        decision: { runId: "run-162-minimal", action: "approve" },
      });
      expect(res.status).toBe(201);

      const event = await getEventDetail(gateEventId);
      const decision = event.decisions![0]!;
      expect(decision.action).toBe("approve");
      expect("step" in decision).toBe(false);
      expect("addedFinding" in decision).toBe(false);
      expect("instructions" in decision).toBe(false);
      expect("reason" in decision).toBe(false);
      expect("findings" in decision).toBe(false);
    });
  });

  // ── validation — refuse with a 400 naming the field ──────────────────────

  describe("POST /api/v2/gate-decisions — validation refuses with a 400 naming the field", () => {
    test("missing decision -> 400 naming decision", async () => {
      boot();
      const key = await createProject("decision-missing-object");
      const res = await postJson("/api/v2/gate-decisions", { projectKey: key, agentId: "orchestrator-1" });
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.ok).toBe(false);
      expect(err.error.toLowerCase()).toContain("decision");
    });

    test("decision.action missing -> 400 naming action", async () => {
      boot();
      const key = await createProject("decision-missing-action");
      const d = decisionBody(key, "orchestrator-1") as { decision: Record<string, unknown> };
      delete d.decision.action;
      const res = await postJson("/api/v2/gate-decisions", d);
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("action");
    });

    test("decision.action not in {approve, fix, skip} -> 400 naming action, and NOTHING recorded (the gate's decisions read stays empty)", async () => {
      boot();
      const key = await createProject("decision-bad-action");
      const gateEventId = await postGate(key, "orchestrator-1", { run: { id: "run-162-bad-action" } });

      const res = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { runId: "run-162-bad-action", action: "approved-ish" }),
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("action");

      const event = await getEventDetail(gateEventId);
      expect(event.decisions ?? []).toHaveLength(0);
    });

    test("decision.runId missing -> 400 naming runId", async () => {
      boot();
      const key = await createProject("decision-missing-run-id");
      const d = decisionBody(key, "orchestrator-1") as { decision: Record<string, unknown> };
      delete d.decision.runId;
      const res = await postJson("/api/v2/gate-decisions", d);
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("runid");
    });

    test("decision.addedFinding is a STRING, not a JSON object (G2: ONE object, not free text) -> 400 naming addedFinding", async () => {
      boot();
      const key = await createProject("decision-bad-added-finding");
      const res = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { addedFinding: "just fix it somehow" }),
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("addedfinding");
    });

    test("decision.addedFinding is an ARRAY, not ONE JSON object (G2: not repeatable) -> 400 naming addedFinding", async () => {
      boot();
      const key = await createProject("decision-array-added-finding");
      const res = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { addedFinding: [{ id: "F3" }, { id: "F4" }] }),
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("addedfinding");
    });

    test("decision.findings is a STRING, not an array of finding ids -> 400 naming findings", async () => {
      boot();
      const key = await createProject("decision-bad-findings");
      const res = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { findings: "F1,F2" }),
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("findings");
    });

    test("unknown projectKey -> 404 FROM THE ROUTE's OWN project check, not the server's generic unmatched-route 404", async () => {
      boot();
      const res = await postJson("/api/v2/gate-decisions", decisionBody(crypto.randomUUID(), "orchestrator-1"));
      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrResponse;
      // Distinguishes a REAL "unknown project" refusal (requireProject) from
      // the server's catch-all "unknown route" 404 a not-yet-wired path also
      // answers with — the latter would otherwise pass this test for the
      // wrong reason before the route exists at all.
      expect(err.error.toLowerCase()).toContain("project");
      expect(err.error.toLowerCase()).not.toContain("unknown route");
    });
  });

  // ── same registered-caller + cycle-stamping rules as /gates ─────────────

  describe("POST /api/v2/gate-decisions — the same registered-caller and cycle-stamping rules as /gates", () => {
    test("an unregistered agentId -> 409, ok:false, and the gate's decisions read stays empty", async () => {
      boot();
      const key = await createProject("decision-unregistered-caller");
      const gateEventId = await postGate(key, "orchestrator-1", { run: { id: "run-162-unreg" } });

      const res = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "never-registered-1", { runId: "run-162-unreg" }),
      );
      expect(res.status).toBe(409);
      const err = (await res.json()) as ErrResponse;
      expect(err.ok).toBe(false);

      const event = await getEventDetail(gateEventId);
      expect(event.decisions ?? []).toHaveLength(0);
    });

    test("a BOUND agent's decision with no explicit context -> 201, the response echoes context.cycleId === the binding, and the STORED decision (read back via the gate's event detail) carries the SAME cycleId", async () => {
      boot();
      const key = await createProject("decision-bound-stamping");
      const { cycleId } = await fileAndActivate(key, "CR-CRU-162-C1-decision-bound");
      const agentId = "stamp-bound-decision-1";
      await registerBound(key, agentId, "FIX", cycleId);
      const gateEventId = await postGate(key, agentId, { run: { id: "run-162-bound" } });

      const res = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, agentId, { runId: "run-162-bound" }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as OkResponse;
      expect(body.context?.cycleId).toBe(cycleId);

      const event = await getEventDetail(gateEventId);
      expect(event.decisions![0]!.context?.cycleId).toBe(cycleId);
    });
  });

  // ── AC6 server half (b) — the gate read returns the run's decisions, in order ─

  describe("GET /api/v2/events/:id — the gate read returns that run's decisions, in order", () => {
    test("three decisions posted in sequence for the SAME runId come back in POSTING order, not reversed and not re-sorted by action", async () => {
      boot();
      const key = await createProject("decision-ordering");
      const gateEventId = await postGate(key, "orchestrator-1", { run: { id: "run-162-ordering" } });

      const sequence: Array<Record<string, unknown>> = [
        { action: "fix", instructions: "first pass", findings: ["F1"] },
        { action: "fix", instructions: "second pass", findings: ["F2"] },
        { action: "approve", instructions: "ship it", findings: [] },
      ];
      for (const overrides of sequence) {
        const res = await postJson(
          "/api/v2/gate-decisions",
          decisionBody(key, "orchestrator-1", { runId: "run-162-ordering", ...overrides }),
        );
        expect(res.status).toBe(201);
      }

      const event = await getEventDetail(gateEventId);
      expect(event.decisions).toHaveLength(3);
      expect(event.decisions!.map((d) => d.instructions)).toEqual(["first pass", "second pass", "ship it"]);
      expect(event.decisions!.map((d) => d.action)).toEqual(["fix", "fix", "approve"]);
    });

    test("a decision recorded under a DIFFERENT runId never appears on this gate's read (bound: exactly the matching run's decisions, never more), and a gate that never posted gate.run.id reads with NO decisions key at all (nothing to join, never an empty array fabricated from nothing)", async () => {
      boot();
      const key = await createProject("decision-run-id-isolation");
      const gateEventId = await postGate(key, "orchestrator-1", { run: { id: "run-162-mine" } });
      const runIdLessGateEventId = await postGate(key, "orchestrator-1");

      const mine = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { runId: "run-162-mine", instructions: "belongs here" }),
      );
      expect(mine.status).toBe(201);
      const other = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { runId: "run-162-someone-elses", instructions: "does NOT belong here" }),
      );
      expect(other.status).toBe(201);

      const event = await getEventDetail(gateEventId);
      expect(event.decisions).toHaveLength(1);
      expect(event.decisions![0]!.instructions).toBe("belongs here");

      const runIdLessEvent = await getEventDetail(runIdLessGateEventId);
      expect("decisions" in runIdLessEvent).toBe(false);
    });

    test("the BRIEF list (GET /api/v2/events) never carries a decisions key — only the single-event detail read does", async () => {
      boot();
      const key = await createProject("decision-not-on-brief-list");
      await postGate(key, "orchestrator-1", { run: { id: "run-162-brief" } });
      const decisionRes = await postJson(
        "/api/v2/gate-decisions",
        decisionBody(key, "orchestrator-1", { runId: "run-162-brief" }),
      );
      expect(decisionRes.status).toBe(201);

      const res = await getJson(`/api/v2/events?project=${key}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as EventsListResponse;
      const gateBrief = body.events.find((e) => e.kind === "gate");
      expect(gateBrief).toBeDefined();
      expect("decisions" in gateBrief!).toBe(false);
    });
  });
});
