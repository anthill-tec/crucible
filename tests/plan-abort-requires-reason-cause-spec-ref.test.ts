// CR-CRU-165 §S2b/R3 (AC11, server half) — `abort` records a failure too.
// `POST …/plans/<planId>/abort` already requires `{userApproved:true}`
// (CR-CRU-024 §S6, unchanged). R3 ADDS a second, independent requirement:
// `reason` (non-empty), `cause` (`spec-design`|`gap-analysis`) and
// `specRef` (non-empty) — missing/invalid refuses (400), present stores all
// three ON THE PLAN, stamps them onto every PENDING cycle the abort skips
// (so "every skipped cycle on the board says why" — §S2b), and the response
// carries the same process-failure warning cycle-skip's does.
//
// RED phase: today src/v2.ts's handlePlanAbort / src/store.ts's abortPlan
// read no reason/cause/specRef at all — `{userApproved:true}` alone aborts.
// Every refusal asserted below currently 200s; the stored-field assertions
// on the plan and on its newly-skipped cycles currently read undefined.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  reason?: string;
  cause?: string;
  specRef?: string;
  [key: string]: unknown;
}

interface PlanRecord {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  reason?: string;
  cause?: string;
  specRef?: string;
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: unknown;
  [key: string]: unknown;
}

const VALID_FIELDS = {
  reason: "the spec's gap analysis found this plan obsolete mid-cycle",
  cause: "gap-analysis" as const,
  specRef: "CR-CRU-165 §G3",
};

let servers: ServerHandle[] = [];

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  servers.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of servers) handle.stop();
  servers = [];
});

function withFixtureAgent(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

async function postJson(handle: ServerHandle, path: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function getJson(handle: ServerHandle, path: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${path}`);
}

async function registerOrchestrator(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", { projectKey: key, agentId, role: "ORCHESTRATOR" });
  expect(res.status).toBe(200);
}

async function createProject(handle: ServerHandle): Promise<string> {
  const res = await postJson(handle, "/api/v2/projects", { name: `abort-reason-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
  await registerOrchestrator(handle, body.project.key, "fixture-orch");
  return body.project.key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
}

async function filePlanAB(handle: ServerHandle, key: string, cr: string): Promise<{ planId: number | string; a: number; b: number }> {
  const res = await postJson(handle, plansPath(key), { cr, cycles: [{ label: "A" }, { label: "B" }] });
  expect(res.status).toBe(201);
  const body = (await res.json()) as PlanRecord;
  return { planId: body.planId, a: body.cycles[0]!.id, b: body.cycles[1]!.id };
}

async function abort(handle: ServerHandle, key: string, planId: number | string, body: Record<string, unknown>): Promise<Response> {
  return postJson(handle, plansPath(key, `/${planId}/abort`), body);
}

async function getPlanByCr(handle: ServerHandle, key: string, cr: string): Promise<PlanRecord> {
  const res = await getJson(handle, plansPath(key, `?cr=${encodeURIComponent(cr)}`));
  const body = (await res.json()) as PlansListResponse;
  return body.plans.find((p) => p.cr === cr)!;
}

function helpOrErrorText(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? (body.help as string[]).join(" | ") : "";
  return `${body.error} ${help}`.toLowerCase();
}

describe("POST …/plans/<planId>/abort — abort records a failure too (CR-CRU-165 §S2b/R3, AC11 server half)", () => {
  test("userApproved:true but NO reason/cause/specRef: refused (400) naming reason; plan stays open, cycles untouched", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a, b } = await filePlanAB(handle, key, "CR-ABORT-REASON-1");

    const res = await abort(handle, key, planId, { userApproved: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/reason/);

    const plan = await getPlanByCr(handle, key, "CR-ABORT-REASON-1");
    expect(plan.status).toBe("open");
    expect(plan.cycles.find((c) => c.id === a)!.status).toBe("pending");
    expect(plan.cycles.find((c) => c.id === b)!.status).toBe("pending");
  });

  test("userApproved:true, reason+specRef given, but an invalid `cause`: refused (400) naming cause; plan stays open", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId } = await filePlanAB(handle, key, "CR-ABORT-REASON-2");

    const res = await abort(handle, key, planId, { userApproved: true, reason: "x", cause: "shrug", specRef: "ref" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/cause/);

    const plan = await getPlanByCr(handle, key, "CR-ABORT-REASON-2");
    expect(plan.status).toBe("open");
  });

  test("userApproved:true + all three fields valid: 200 — plan -> aborted, STORES reason/cause/specRef on the plan, the response carries the process-failure warning", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId } = await filePlanAB(handle, key, "CR-ABORT-REASON-3");

    const res = await abort(handle, key, planId, { userApproved: true, ...VALID_FIELDS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; plan: PlanRecord; warnings?: Array<{ message: string }> };
    expect(body.plan.status).toBe("aborted");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings!.map((w) => w.message.toLowerCase()).join(" ")).toMatch(/spec|gap analysis/);

    const plan = await getPlanByCr(handle, key, "CR-ABORT-REASON-3");
    expect(plan.reason).toBe(VALID_FIELDS.reason);
    expect(plan.cause).toBe(VALID_FIELDS.cause);
    expect(plan.specRef).toBe(VALID_FIELDS.specRef);
  });

  test("an aborted plan's PENDING cycles that the abort skipped show the SAME reason/cause/specRef the plan stored — every skipped cycle on the board says why", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, a, b } = await filePlanAB(handle, key, "CR-ABORT-REASON-4");
    // Activate A so the fixture also covers the active→failed leg of abort.
    const activateRes = await postJson(handle, plansPath(key, `/${planId}/cycles/${a}/`.replace(/\/$/, "")), {});
    void activateRes; // not used — activation below uses PATCH, kept for clarity of intent only
    const patchActive = await fetch(`http://localhost:${handle.server.port}${plansPath(key, `/${planId}/cycles/${a}`)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent({ status: "active" })),
    });
    expect(patchActive.status).toBe(200);

    const res = await abort(handle, key, planId, { userApproved: true, ...VALID_FIELDS });
    expect(res.status).toBe(200);

    const plan = await getPlanByCr(handle, key, "CR-ABORT-REASON-4");
    const cycleA = plan.cycles.find((c) => c.id === a)!;
    const cycleB = plan.cycles.find((c) => c.id === b)!;
    expect(cycleA.status).toBe("failed");
    expect(cycleB.status).toBe("skipped");
    expect(cycleB.reason).toBe(VALID_FIELDS.reason);
    expect(cycleB.cause).toBe(VALID_FIELDS.cause);
    expect(cycleB.specRef).toBe(VALID_FIELDS.specRef);
  });

  test("unknown planId, userApproved:true + all three valid fields: still 404 — fields alone don't skip existence checks", async () => {
    const handle = boot();
    const key = await createProject(handle);

    const res = await abort(handle, key, 999999, { userApproved: true, ...VALID_FIELDS });
    expect(res.status).toBe(404);
  });
});
