// CR-CRU-165 §S1 (AC1, server route half) — `POST …/plans/<planId>/cycles`
// (cycle-add / append, no `before`) grows a filed plan in exactly ONE
// unconditional way: a `fix` cycle after the plan's VERIFY cycle is DONE.
// Appending a `fix` cycle before VERIFY is done is refused with the rule —
// §S1's "the plan grows only by FIX cycles" timing half carries NO bypass
// (unlike the KIND half below, which the orchestrator's 2026-10-03 revision
// of R1 turned into a guarded exception alongside insert-before/rename —
// see tests/cycle-insert-before.test.ts / tests/cycle-edit-label.test.ts for
// those, and tests/cycle-skip-guards.test.ts for cycle-skip itself).
//
// A non-`fix` kind is ALLOWED when the body carries `reason` (non-empty),
// `cause` (`spec-design` | `gap-analysis`) and `specRef` (non-empty) from an
// ORCHESTRATOR-role caller — covered here because it is the SAME `POST
// …/cycles` route AC1 names; the three-field contract itself (what each
// field means, the orchestrator-only gate) is the shared contract this file,
// cycle-insert-before.test.ts and cycle-edit-label.test.ts all exercise.
//
// RED phase: src/v2.ts's handleCycleAppend / src/store.ts's appendCycle have
// NO kind restriction and NO VERIFY-done gate at all today — any kind
// appends unconditionally to any open plan, so every refusal asserted below
// currently 201s instead, and the gated non-fix path currently succeeds
// with NO reason/cause/specRef at all (the fields are accepted and silently
// dropped, never stored, never round-tripped on GET).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  reason?: string;
  cause?: string;
  specRef?: string;
  changeKind?: string;
  [key: string]: unknown;
}

interface PlanFileResponse {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanFileResponse[];
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: unknown;
  [key: string]: unknown;
}

const ORCH = "fixture-orch";
const OTHER_ROLE = "reporter-1";

describe("POST …/plans/<planId>/cycles — a plan grows only by FIX cycles (CR-CRU-165 §S1/AC1)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function withFixtureAgent(body: unknown): unknown {
    if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
      return { ...(body as Record<string, unknown>), agentId: ORCH };
    }
    return body;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function registerAgent(key: string, agentId: string, role: string): Promise<void> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId, role }),
    });
    expect(res.status).toBe(200);
  }

  async function createProject(): Promise<string> {
    const res = await postJson("/api/v2/projects", { name: `cycle-add-fix-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerAgent(body.project.key, ORCH, "ORCHESTRATOR");
    await registerAgent(body.project.key, OTHER_ROLE, "report");
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  async function transition(key: string, planId: number | string, cycleId: number, status: string): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
  }

  async function getPlan(key: string, cr: string): Promise<PlanFileResponse> {
    const res = await getJson(plansPath(key, `?cr=${encodeURIComponent(cr)}`));
    const body = (await res.json()) as PlansListResponse;
    return body.plans.find((p) => p.cr === cr)!;
  }

  function helpOrErrorText(body: ErrResponse): string {
    const help = Array.isArray(body.help) ? (body.help as string[]).join(" | ") : "";
    return `${body.error} ${help}`.toLowerCase();
  }

  // ── timing gate: the plan's VERIFY cycle must be DONE, no bypass ─────────

  test("a plan with NO verify cycle at all: appending a fix cycle is refused (400), naming verify", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), {
      cr: "CR-FIXONLY-1",
      cycles: [{ label: "RG", kind: "red-green" }],
    });
    const plan = (await filed.json()) as PlanFileResponse;

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), { label: "the fix", kind: "fix" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/verify/);

    const after = await getPlan(key, "CR-FIXONLY-1");
    expect(after.cycles.length).toBe(1);
  });

  test("VERIFY cycle still PENDING: appending a fix cycle is refused (400), naming verify; nothing appended", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), {
      cr: "CR-FIXONLY-2",
      cycles: [{ label: "RG", kind: "red-green" }, { label: "the verify", kind: "verify" }],
    });
    const plan = (await filed.json()) as PlanFileResponse;

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), { label: "the fix", kind: "fix" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/verify/);

    const after = await getPlan(key, "CR-FIXONLY-2");
    expect(after.cycles.length).toBe(2);
  });

  test("VERIFY cycle ACTIVE (not done): appending a fix cycle is refused (400)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), {
      cr: "CR-FIXONLY-3",
      cycles: [{ label: "the verify", kind: "verify" }],
    });
    const plan = (await filed.json()) as PlanFileResponse;
    expect((await transition(key, plan.planId, plan.cycles[0]!.id, "active")).status).toBe(200);

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), { label: "the fix", kind: "fix" });
    expect(res.status).toBe(400);
  });

  test("VERIFY cycle not done: a fix append carrying reason, cause AND specRef from the orchestrator is STILL refused (400) by the verify-not-done rule — the change record is no bypass for the timing gate; nothing appended", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "fix before verify, record supplied";
    const filed = await postJson(plansPath(key), {
      cr,
      cycles: [{ label: "RG", kind: "red-green" }, { label: "the verify", kind: "verify" }],
    });
    expect(filed.status).toBe(201);
    const plan = (await filed.json()) as PlanFileResponse;

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), {
      label: "the fix",
      kind: "fix",
      reason: "the findings cannot wait for VERIFY",
      cause: "spec-design",
      specRef: "the spec's scope, §S1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    // The wire carries no refusal code; the verify-not-done rule is identified
    // by its own words (a change-record refusal would name reason/cause instead).
    expect(body.error.toLowerCase()).toMatch(/verify cycle is not done/);
    expect(helpOrErrorText(body)).toMatch(/verify/);

    const after = await getPlan(key, cr);
    expect(after.cycles.length).toBe(2);
    expect(after.cycles.some((c) => c.kind === "fix")).toBe(false);
  });

  test("VERIFY cycle DONE: appending a fix cycle succeeds (201), lands with kind:fix, no reason/cause/specRef needed", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), {
      cr: "CR-FIXONLY-4",
      cycles: [{ label: "the verify", kind: "verify" }],
    });
    const plan = (await filed.json()) as PlanFileResponse;
    const verifyId = plan.cycles[0]!.id;
    expect((await transition(key, plan.planId, verifyId, "active")).status).toBe(200);
    expect((await transition(key, plan.planId, verifyId, "done")).status).toBe(200);

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), { label: "the fix", kind: "fix" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; id: number; label: string; kind: string };
    expect(body.kind).toBe("fix");

    const after = await getPlan(key, "CR-FIXONLY-4");
    expect(after.cycles.map((c) => c.id)).toContain(body.id);
    expect(after.cycles.length).toBe(2);
  });

  // ── kind gate: non-fix kind needs the three-field, orchestrator-only bypass ──

  test("non-fix kind with NO reason/cause/specRef: refused (400), naming reason; nothing appended", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), { cr: "CR-FIXONLY-5", cycles: [{ label: "solo" }] });
    const plan = (await filed.json()) as PlanFileResponse;

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), {
      label: "off-plan rework",
      kind: "red-green",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/reason/);

    const after = await getPlan(key, "CR-FIXONLY-5");
    expect(after.cycles.length).toBe(1);
  });

  test("non-fix kind with all three fields, ORCHESTRATOR caller: 201 — succeeds even with NO verify cycle in the plan at all, stores reason/cause/specRef on the cycle, and the response carries the process-failure warning", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), { cr: "CR-FIXONLY-6", cycles: [{ label: "solo" }] });
    const plan = (await filed.json()) as PlanFileResponse;

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), {
      label: "off-plan rework",
      kind: "red-green",
      reason: "the spec grew a new slice mid-cycle",
      cause: "gap-analysis",
      specRef: "the spec's gap analysis, §G1",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; id: number; warnings?: Array<{ message: string }> };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings!.map((w) => w.message.toLowerCase()).join(" ")).toMatch(/spec|gap analysis/);

    const after = await getPlan(key, "CR-FIXONLY-6");
    const added = after.cycles.find((c) => c.id === body.id)!;
    expect(added.kind).toBe("red-green");
    expect(added.reason).toBe("the spec grew a new slice mid-cycle");
    expect(added.cause).toBe("gap-analysis");
    expect(added.specRef).toBe("the spec's gap analysis, §G1");
  });

  test("non-fix kind with all three fields but an invalid `cause` value: refused (400), naming cause; nothing appended", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), { cr: "CR-FIXONLY-7", cycles: [{ label: "solo" }] });
    const plan = (await filed.json()) as PlanFileResponse;

    const res = await postJson(plansPath(key, `/${plan.planId}/cycles`), {
      label: "off-plan rework",
      kind: "red-green",
      reason: "x",
      cause: "because-i-felt-like-it",
      specRef: "ref",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/cause/);

    const after = await getPlan(key, "CR-FIXONLY-7");
    expect(after.cycles.length).toBe(1);
  });

  test("non-fix kind with all three fields but a NON-orchestrator caller: refused (409) naming ORCHESTRATOR; nothing appended", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), { cr: "CR-FIXONLY-8", cycles: [{ label: "solo" }] });
    const plan = (await filed.json()) as PlanFileResponse;

    const res = await fetch(`http://localhost:${handle!.server.port}${plansPath(key, `/${plan.planId}/cycles`)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "off-plan rework",
        kind: "red-green",
        reason: "x",
        cause: "gap-analysis",
        specRef: "ref",
        agentId: OTHER_ROLE,
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.error).toContain("ORCHESTRATOR");

    const after = await getPlan(key, "CR-FIXONLY-8");
    expect(after.cycles.length).toBe(1);
  });
});
