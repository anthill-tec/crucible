// CR-CRU-165 §S2/R2 (AC3, AC4, AC10) — `PATCH …/plans/<planId>/cycles/<id>
// {status:"skipped", reason, cause, specRef}` is cycle-skip's route half:
// refused unless the cycle is PENDING (never active/done/failed — R2 drops
// active→skipped from the legal-transition table, so an active cycle now
// ends only `done`|`failed`), no run is filed against it, the plan keeps at
// least one cycle that is not skipped, all three fields are present and
// valid, and the caller is ORCHESTRATOR. Every refusal names its rule. The
// PATCH route enforces the SAME guards as the (client-side) `cycle-skip`
// verb — AC4 — so this file drives the route directly.
//
// RED phase: today CYCLE_TRANSITIONS (src/store.ts) still legalises
// active→skipped (R2 not yet applied); transitionCycle has NO notion of
// reason/cause/specRef, no run-filed check, no last-unskipped-cycle check,
// and handleCycleTransition's caller gate is requireRegisteredCaller (ANY
// role), never requireOrchestrator. Every refusal asserted below currently
// 200s (or silently ignores the extra fields); the stored-field assertions
// currently read undefined.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";

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
const RUNNER = "run-agent";

const VALID_FIELDS = {
  reason: "this cycle no longer applies after the spec's gap analysis",
  cause: "gap-analysis" as const,
  specRef: "CR-CRU-165 §G3",
};

describe("PATCH …/cycles/<id> {status:'skipped'} — cycle-skip's guarded route (CR-CRU-165 §S2/R2, AC3/AC4/AC10)", () => {
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
    const res = await postJson("/api/v2/projects", { name: `cycle-skip-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerAgent(body.project.key, ORCH, "ORCHESTRATOR");
    await registerAgent(body.project.key, OTHER_ROLE, "report");
    await registerAgent(body.project.key, RUNNER, "report");
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  async function fileCycles(key: string, cr: string, labels: string[]): Promise<{ planId: number | string; ids: number[] }> {
    const res = await postJson(plansPath(key), { cr, cycles: labels.map((label) => ({ label })) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, ids: body.cycles.map((c) => c.id) };
  }

  async function transition(key: string, planId: number | string, cycleId: number, status: string): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
  }

  async function skip(key: string, planId: number | string, cycleId: number, fields: Record<string, unknown> = VALID_FIELDS): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "skipped", ...fields });
  }

  async function getCycle(key: string, cr: string, cycleId: number): Promise<CyclePayload> {
    const res = await getJson(plansPath(key, `?cr=${encodeURIComponent(cr)}`));
    const body = (await res.json()) as PlansListResponse;
    return body.plans.find((p) => p.cr === cr)!.cycles.find((c) => c.id === cycleId)!;
  }

  function helpOrErrorText(body: ErrResponse): string {
    const help = Array.isArray(body.help) ? (body.help as string[]).join(" | ") : "";
    return `${body.error} ${help}`.toLowerCase();
  }

  function parsedRunBody(projectKey: string, cycleId: number) {
    const summary: RunSummary = { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 };
    const tree: SuiteNode[] = [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 5 }] }];
    return { projectKey, agentId: RUNNER, summary, tree, context: { cycleId } };
  }

  // ── R2 — PENDING only: active/done/failed all refuse, even with valid fields ──

  test("ACTIVE cycle: {status:'skipped'} even WITH valid reason/cause/specRef is refused (400); the cycle stays active (R2 — active→skipped left the transition table)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-1", ["A", "B"]);
    const [a] = ids as [number, number];
    expect((await transition(key, planId, a, "active")).status).toBe(200);

    const res = await skip(key, planId, a);
    expect(res.status).toBe(400);

    const after = await getCycle(key, "CR-SKIP-1", a);
    expect(after.status).toBe("active");
  });

  test("an ACTIVE cycle still ends done|failed — the other two legal active transitions are unchanged by R2", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-1B", ["A"]);
    const [a] = ids as [number];
    expect((await transition(key, planId, a, "active")).status).toBe(200);

    expect((await transition(key, planId, a, "done")).status).toBe(200);
    const after = await getCycle(key, "CR-SKIP-1B", a);
    expect(after.status).toBe("done");
  });

  test("DONE cycle: {status:'skipped'} with valid fields is refused (400); cycle stays done", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-2", ["A", "B"]);
    const [a] = ids as [number, number];
    expect((await transition(key, planId, a, "active")).status).toBe(200);
    expect((await transition(key, planId, a, "done")).status).toBe(200);

    const res = await skip(key, planId, a);
    expect(res.status).toBe(400);

    const after = await getCycle(key, "CR-SKIP-2", a);
    expect(after.status).toBe("done");
  });

  test("FAILED cycle: {status:'skipped'} with valid fields is refused (400); cycle stays failed", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-3", ["A", "B"]);
    const [a] = ids as [number, number];
    expect((await transition(key, planId, a, "active")).status).toBe(200);
    expect((await transition(key, planId, a, "failed")).status).toBe(200);

    const res = await skip(key, planId, a);
    expect(res.status).toBe(400);

    const after = await getCycle(key, "CR-SKIP-3", a);
    expect(after.status).toBe("failed");
  });

  // ── a run filed against the (pending) cycle refuses the skip ──────────────

  test("a PENDING cycle with a run filed against it: {status:'skipped'} with valid fields is refused (400); cycle stays pending", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-4", ["A", "B"]);
    const [a] = ids as [number, number];

    const ingest = await fetch(`http://localhost:${handle!.server.port}/api/v2/runs/parsed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsedRunBody(key, a)),
    });
    expect(ingest.status).toBe(200);

    const res = await skip(key, planId, a);
    expect(res.status).toBe(400);

    const after = await getCycle(key, "CR-SKIP-4", a);
    expect(after.status).toBe("pending");
  });

  // ── the plan's last unskipped cycle refuses ────────────────────────────────

  test("the plan's LAST non-skipped cycle: {status:'skipped'} with valid fields is refused (400) — a plan must keep at least one non-skipped cycle", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-5", ["A", "B"]);
    const [a, b] = ids as [number, number];
    expect((await skip(key, planId, a)).status).toBe(200);

    const res = await skip(key, planId, b);
    expect(res.status).toBe(400);

    const after = await getCycle(key, "CR-SKIP-5", b);
    expect(after.status).toBe("pending");
  });

  // ── the three fields are mandatory and validated ──────────────────────────

  test("a skippable PENDING cycle with NO reason/cause/specRef at all: refused (400) naming reason", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-6", ["A", "B"]);
    const [a] = ids as [number, number];

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${a}`), { status: "skipped" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/reason/);

    const after = await getCycle(key, "CR-SKIP-6", a);
    expect(after.status).toBe("pending");
  });

  test("a skippable PENDING cycle with reason+specRef but an invalid `cause`: refused (400) naming cause", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-7", ["A", "B"]);
    const [a] = ids as [number, number];

    const res = await skip(key, planId, a, { reason: "x", cause: "whim", specRef: "ref" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/cause/);

    const after = await getCycle(key, "CR-SKIP-7", a);
    expect(after.status).toBe("pending");
  });

  // ── orchestrator-role only ─────────────────────────────────────────────────

  test("a skippable PENDING cycle, valid fields, but a NON-orchestrator caller: refused (409) naming ORCHESTRATOR; cycle stays pending", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-8", ["A", "B"]);
    const [a] = ids as [number, number];

    const res = await fetch(`http://localhost:${handle!.server.port}${plansPath(key, `/${planId}/cycles/${a}`)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "skipped", ...VALID_FIELDS, agentId: OTHER_ROLE }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.error).toContain("ORCHESTRATOR");

    const after = await getCycle(key, "CR-SKIP-8", a);
    expect(after.status).toBe("pending");
  });

  // ── every guard satisfied: the skip executes and stores the three fields ──

  test("a PENDING, not-last, no-run-filed cycle, valid fields, ORCHESTRATOR caller: 200 — skipped, stores reason/cause/specRef/changeKind:'skip', response carries the process-failure warning", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, ids } = await fileCycles(key, "CR-SKIP-9", ["A", "B"]);
    const [a] = ids as [number, number];

    const res = await skip(key, planId, a);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; changed: true; cycle: CyclePayload; warnings?: Array<{ message: string }> };
    expect(body.cycle.status).toBe("skipped");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings!.map((w) => w.message.toLowerCase()).join(" ")).toMatch(/spec|gap analysis/);

    const after = await getCycle(key, "CR-SKIP-9", a);
    expect(after.status).toBe("skipped");
    expect(after.reason).toBe(VALID_FIELDS.reason);
    expect(after.cause).toBe(VALID_FIELDS.cause);
    expect(after.specRef).toBe(VALID_FIELDS.specRef);
    expect(after.changeKind).toBe("skip");
  });
});
