// CR-CRU-024 §S3.2 originally gave `PATCH …/plans/<planId>/cycles/<id>` an
// optional `{label}` body to rename a PENDING cycle, for any live-registered
// caller. CR-CRU-165's gap analysis (G1) flagged this as a second, ungated
// way to change a filed plan; the user's FIRST ruling (R1, 2026-10-03) was
// to retire it outright, then REVISED (same day) to gate it instead: rename
// now behaves like cycle-skip — allowed only when the body carries `reason`
// (non-empty), `cause` (`spec-design` | `gap-analysis`) and `specRef`
// (non-empty) from an ORCHESTRATOR-role caller, stores the three fields on
// the renamed cycle (with `changeKind: "rename"`), and the response carries
// the process-failure warning. Missing/invalid → 400 naming the rule. The
// existing `locked` (active cycle) / `immutable-history` (terminal cycle)
// refusals are UNCHANGED and fire regardless of the three fields; so is the
// `{label, status}` one-mutation-per-call refusal.
//
// This file REPLACES the superseded cycle-edit-label.test.ts, which pinned
// rename succeeding for ANY registered caller with NO reason/cause/specRef —
// exactly the ungated shape this CR revises.
//
// RED phase: today src/v2.ts's handleCycleTransition's `hasLabel` branch
// renames unconditionally for any registered caller — no reason/cause/
// specRef field exists on the wire, nothing is stored, no orchestrator-role
// check runs. Every gated-refusal assertion below currently 200s; every
// stored-field assertion currently reads undefined.
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

const VALID_FIELDS = {
  reason: "the spec's naming convention changed mid-cycle",
  cause: "spec-design" as const,
  specRef: "CR-CRU-165 §G1",
};

describe("PATCH …/cycles/<id> {label} — rename, gated like cycle-skip (CR-CRU-165 R1 revised)", () => {
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
    const res = await postJson("/api/v2/projects", { name: `cycle-edit-label-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerAgent(body.project.key, ORCH, "ORCHESTRATOR");
    await registerAgent(body.project.key, OTHER_ROLE, "report");
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  async function fileSolo(key: string, cr: string): Promise<{ planId: number | string; cycleId: number }> {
    const res = await postJson(plansPath(key), { cr, cycles: [{ label: "solo" }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, cycleId: body.cycles[0]!.id };
  }

  async function transition(key: string, planId: number | string, cycleId: number, status: string): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
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

  test("PENDING cycle, PATCH {label} with NO reason/cause/specRef: refused (400) naming reason; label unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-1");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { label: "renamed" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/reason/);

    const after = await getCycle(key, "CR-EDIT-1", cycleId);
    expect(after.label).toBe("solo");
  });

  test("PENDING cycle, PATCH {label} WITH all three fields from an ORCHESTRATOR caller: 200 — label changes, stores reason/cause/specRef/changeKind:'rename', response carries the process-failure warning", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-2");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      label: "renamed pending cycle",
      ...VALID_FIELDS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      changed: true;
      cycle: CyclePayload;
      warnings?: Array<{ message: string }>;
    };
    expect(body.cycle.label).toBe("renamed pending cycle");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings!.map((w) => w.message.toLowerCase()).join(" ")).toMatch(/spec|gap analysis/);

    const after = await getCycle(key, "CR-EDIT-2", cycleId);
    expect(after.label).toBe("renamed pending cycle");
    expect(after.reason).toBe(VALID_FIELDS.reason);
    expect(after.cause).toBe(VALID_FIELDS.cause);
    expect(after.specRef).toBe(VALID_FIELDS.specRef);
    expect(after.changeKind).toBe("rename");
  });

  test("PENDING cycle, PATCH {label} with all three fields but an invalid `cause`: refused (400) naming cause; label unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-3");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      label: "renamed",
      reason: "x",
      cause: "because",
      specRef: "ref",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/cause/);

    const after = await getCycle(key, "CR-EDIT-3", cycleId);
    expect(after.label).toBe("solo");
  });

  test("PENDING cycle, PATCH {label} with all three fields but a NON-orchestrator caller: refused (409) naming ORCHESTRATOR; label unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-4");

    const res = await fetch(`http://localhost:${handle!.server.port}${plansPath(key, `/${planId}/cycles/${cycleId}`)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "renamed", ...VALID_FIELDS, agentId: OTHER_ROLE }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.error).toContain("ORCHESTRATOR");

    const after = await getCycle(key, "CR-EDIT-4", cycleId);
    expect(after.label).toBe("solo");
  });

  test("ACTIVE cycle, PATCH {label} even WITH all three fields + orchestrator: still 400 'locked' — the active-cycle guard is unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-5");
    expect((await transition(key, planId, cycleId, "active")).status).toBe(200);

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      label: "sneaky rename",
      ...VALID_FIELDS,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.error).toBe("the active cycle is locked — confirm or fail it first");

    const after = await getCycle(key, "CR-EDIT-5", cycleId);
    expect(after.label).toBe("solo");
    expect(after.status).toBe("active");
  });

  test("DONE cycle, PATCH {label} even WITH all three fields + orchestrator: still 400 'immutable history' — the terminal-cycle guard is unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-6");
    expect((await transition(key, planId, cycleId, "active")).status).toBe(200);
    expect((await transition(key, planId, cycleId, "done")).status).toBe(200);

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      label: "sneaky rename",
      ...VALID_FIELDS,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.error).toBe("done/skipped/failed cycles are immutable history");

    const after = await getCycle(key, "CR-EDIT-6", cycleId);
    expect(after.label).toBe("solo");
  });

  test("label+status in one body, even WITH all three fields + orchestrator: still 400 'one mutation per call'; nothing changed", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-7");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      label: "combined mutation",
      status: "active",
      ...VALID_FIELDS,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/one mutation per call/);

    const after = await getCycle(key, "CR-EDIT-7", cycleId);
    expect(after.label).toBe("solo");
    expect(after.status).toBe("pending");
  });
});
