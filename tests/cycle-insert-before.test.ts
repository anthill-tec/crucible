// CR-CRU-024 §S3.1 originally gave `POST …/plans/<planId>/cycles` an
// optional `before: <cycleId>` to insert a cycle at a position. CR-CRU-165's
// gap analysis (G1) flagged this as a second, ungated way to change a filed
// plan; the user's FIRST ruling (R1, 2026-10-03) was to retire it outright,
// then REVISED (same day) to gate it instead: insert-before now behaves like
// cycle-skip — allowed only when the body carries `reason` (non-empty),
// `cause` (`spec-design` | `gap-analysis`) and `specRef` (non-empty) from an
// ORCHESTRATOR-role caller, stores the three fields on the inserted cycle
// (with `changeKind: "insert"`), and the response carries the process-
// failure warning. Missing/invalid → 400 naming the rule. The existing
// insert-before-active guard (a new cycle must land after the active one)
// is UNCHANGED and fires regardless of the three fields.
//
// This file REPLACES the superseded cycle-insert-before.test.ts, which
// pinned insert-before succeeding UNCONDITIONALLY (no reason/cause/specRef,
// no orchestrator-role check) — exactly the ungated shape this CR revises.
//
// RED phase: today src/v2.ts's handleCycleAppend reads `before` and inserts
// unconditionally for ANY registered caller — no reason/cause/specRef field
// exists anywhere on the wire, nothing is stored, no orchestrator-role check
// runs. Every gated-refusal assertion below currently 201s; every
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
  reason: "the planned order no longer fits what the spec now asks",
  cause: "spec-design" as const,
  specRef: "CR-CRU-165 §G1",
};

describe("POST …/cycles `before:` — insert-before, gated like cycle-skip (CR-CRU-165 R1 revised)", () => {
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
    const res = await postJson("/api/v2/projects", { name: `cycle-insert-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerAgent(body.project.key, ORCH, "ORCHESTRATOR");
    await registerAgent(body.project.key, OTHER_ROLE, "report");
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

  async function getCycles(key: string, cr: string): Promise<CyclePayload[]> {
    const res = await getJson(plansPath(key, `?cr=${encodeURIComponent(cr)}`));
    const body = (await res.json()) as PlansListResponse;
    return body.plans.find((p) => p.cr === cr)!.cycles;
  }

  function helpOrErrorText(body: ErrResponse): string {
    const help = Array.isArray(body.help) ? (body.help as string[]).join(" | ") : "";
    return `${body.error} ${help}`.toLowerCase();
  }

  /** A(skipped) B(active) C(pending) D(pending), in seq order — matches the
   *  superseded file's fixture so the active-cycle guard proof stays comparable. */
  async function fileActiveFixture(
    key: string,
    cr: string,
  ): Promise<{ planId: number | string; a: number; b: number; c: number; d: number }> {
    const { planId, ids } = await fileCycles(key, cr, ["A", "B", "C", "D"]);
    const [a, b, c, d] = ids as [number, number, number, number];
    expect((await transition(key, planId, a, "skipped")).status).toBe(200);
    expect((await transition(key, planId, b, "active")).status).toBe(200);
    return { planId, a, b, c, d };
  }

  test("`before:` a later PENDING sibling, NO reason/cause/specRef: refused (400) naming reason; sibling set untouched", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-1";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await postJson(plansPath(key, `/${planId}/cycles`), { label: "E", before: c });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/reason/);

    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, c, d]);
  });

  test("`before:` a later PENDING sibling, WITH all three fields from an ORCHESTRATOR caller: 201 — lands immediately before the target in GET order, stores reason/cause/specRef/changeKind:'insert', response carries the process-failure warning", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-2";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await postJson(plansPath(key, `/${planId}/cycles`), {
      label: "E",
      before: c,
      ...VALID_FIELDS,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; id: number; warnings?: Array<{ message: string }> };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings!.map((w) => w.message.toLowerCase()).join(" ")).toMatch(/spec|gap analysis/);
    const e = body.id;

    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, e, c, d]);
    const inserted = cycles.find((cy) => cy.id === e)!;
    expect(inserted.reason).toBe(VALID_FIELDS.reason);
    expect(inserted.cause).toBe(VALID_FIELDS.cause);
    expect(inserted.specRef).toBe(VALID_FIELDS.specRef);
    expect(inserted.changeKind).toBe("insert");
  });

  test("`before:` with all three fields but an invalid `cause`: refused (400) naming cause; nothing inserted", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-3";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await postJson(plansPath(key, `/${planId}/cycles`), {
      label: "E",
      before: c,
      reason: "x",
      cause: "vibes",
      specRef: "ref",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(helpOrErrorText(body)).toMatch(/cause/);

    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, c, d]);
  });

  test("`before:` with all three fields but a NON-orchestrator caller: refused (409) naming ORCHESTRATOR; nothing inserted", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-4";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await fetch(`http://localhost:${handle!.server.port}${plansPath(key, `/${planId}/cycles`)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "E", before: c, ...VALID_FIELDS, agentId: OTHER_ROLE }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.error).toContain("ORCHESTRATOR");

    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, c, d]);
  });

  test("`before:` pointing at the ACTIVE cycle, even WITH all three fields + orchestrator: still 400 naming the active cycle — the insert-before-active guard is unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-5";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await postJson(plansPath(key, `/${planId}/cycles`), { label: "F", before: b, ...VALID_FIELDS });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.error).toMatch(/active/i);
    expect(body.error).toContain(String(b));

    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, c, d]);
  });
});
