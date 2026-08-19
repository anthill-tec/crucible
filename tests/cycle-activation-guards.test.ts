// CR-CRU-024 §S1+§S2+§S4 — plan-cycle activation guards + AXI invalid-action
// responses. The legal-transition table (src/store.ts CYCLE_TRANSITIONS)
// validates per-cycle transitions ONLY — it has no cross-cycle rules, so
// activating cycle N while an EARLIER sibling is still pending, or while
// ANOTHER cycle in the same plan is active, currently succeeds silently.
// Both invalid shapes have occurred in real operation (cycles 16+18 running
// active simultaneously 2026-07-16; the plan-7 cycle-2-before-1
// mis-activation 2026-07-17). Per the AXI principle already embedded in
// this codebase (src/hints.ts), refusals must carry actionable `help[]`.
//
// RED phase: every test below is expected to FAIL against CURRENT
// production. §S1/§S2 guards do not exist at all — src/store.ts
// transitionCycle() (~1256) only consults CYCLE_TRANSITIONS[row.status],
// never looking at sibling cycles — so out-of-order and dual-active
// activations both currently return 200. §S4 is not implemented either:
// none of src/v2.ts's plan/cycle 400/404 paths (illegal transition ~745,
// closed-plan PATCH/append ~1234/~1323, unknown plan/cycle id ~712/~733/
// ~734/~758, malformed cycle input ~647/~716, duplicate open plan ~684)
// attach a `help` key today (confirmed by reading src/v2.ts + src/hints.ts
// — no cycle-guard hints exist in the hints.ts registry).
//
// Same harness pattern as tests/plans.test.ts (drives the REAL production
// server via startServer — no guard implementation is stubbed or mocked).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanFileResponse {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

interface PlanRecord {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
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

describe("plan-cycle activation guards + AXI help (CR-CRU-024 §S1+§S2+§S4)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  // CR-CRU-056 §S2b fixture-repair (C3): mutating v2 workflow verbs
  // (plan-file, cycle transitions, plan close) now refuse an unregistered
  // caller (409) — merge a live-registered agentId into any JSON body
  // lacking one.
  function withFixtureAgent(body: unknown): unknown {
    if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
      return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
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

  async function registerOrchestrator(key: string, agentId: string): Promise<void> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
    });
    expect(res.status).toBe(200);
  }

  async function createProject(): Promise<string> {
    const res = await postJson("/api/v2/projects", { name: `cycle-guards-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerOrchestrator(body.project.key, "fixture-orch");
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  async function filePlanAB(key: string, cr: string): Promise<{ planId: number | string; a: number; b: number }> {
    const res = await postJson(plansPath(key), {
      cr,
      cycles: [{ label: "A" }, { label: "B" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, a: body.cycles[0]!.id, b: body.cycles[1]!.id };
  }

  async function activate(key: string, planId: number | string, cycleId: number): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });
  }

  async function transition(
    key: string,
    planId: number | string,
    cycleId: number,
    status: string,
  ): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
  }

  async function getCycle(key: string, cr: string, cycleId: number): Promise<CyclePayload> {
    const res = await getJson(plansPath(key, `?cr=${encodeURIComponent(cr)}`));
    const body = (await res.json()) as PlansListResponse;
    const plan = body.plans.find((p) => p.cr === cr)!;
    return plan.cycles.find((c) => c.id === cycleId)!;
  }

  function helpText(body: ErrResponse): string {
    expect(Array.isArray(body.help)).toBe(true);
    const help = body.help as unknown[];
    expect(help.length).toBeGreaterThan(0);
    for (const line of help) {
      expect(typeof line).toBe("string");
      expect((line as string).length).toBeGreaterThan(0);
    }
    return (help as string[]).join(" | ");
  }

  // ── AC1 — §S1 out-of-order activation guard ──────────────────────────
  test("AC1: activating B while A is still pending -> 400 out-of-order naming A, help offers activate-A-first + skip-A paths, B stays pending (no partial state)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, a, b } = await filePlanAB(key, "CR-GUARD-1");

    const res = await activate(key, planId, b);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/out-of-order/i);
    expect(body.error).toContain(String(a));

    const help = helpText(body);
    expect(help).toMatch(/activate/i);
    expect(help).toContain(String(a));
    expect(help).toMatch(/skip/i);

    const bAfter = await getCycle(key, "CR-GUARD-1", b);
    expect(bAfter.status).toBe("pending");
  });

  // ── AC2 — the sanctioned swap: skip the earlier sibling, then activate ──
  test("AC2: after A -> skipped, activating B succeeds (200) — the sanctioned out-of-order swap", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, a, b } = await filePlanAB(key, "CR-GUARD-2");

    const skipA = await transition(key, planId, a, "skipped");
    expect(skipA.status).toBe(200);

    const activateB = await activate(key, planId, b);
    expect(activateB.status).toBe(200);

    const bAfter = await getCycle(key, "CR-GUARD-2", b);
    expect(bAfter.status).toBe("active");
  });

  // ── AC3 — §S2 single-active enforcement ──────────────────────────────
  test("AC3: activating B while A is active -> 400 naming A as active, help offers terminal-transition path; after A -> done, activating B succeeds (200)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, a, b } = await filePlanAB(key, "CR-GUARD-3");

    const activateA = await activate(key, planId, a);
    expect(activateA.status).toBe(200);

    const res = await activate(key, planId, b);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/already active/i);
    expect(body.error).toContain(String(a));

    const help = helpText(body);
    expect(help).toMatch(/terminal/i);
    expect(help).toContain(String(a));

    const doneA = await transition(key, planId, a, "done");
    expect(doneA.status).toBe(200);

    const activateB = await activate(key, planId, b);
    expect(activateB.status).toBe(200);

    const bAfter = await getCycle(key, "CR-GUARD-3", b);
    expect(bAfter.status).toBe("active");
  });

  // ── AC4 — regression guard: the whole legal sequential table still works ─
  test("AC4: sequential happy path unchanged — activate A, done A, activate B, done B all succeed", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, a, b } = await filePlanAB(key, "CR-GUARD-4");

    expect((await activate(key, planId, a)).status).toBe(200);
    expect((await transition(key, planId, a, "done")).status).toBe(200);
    expect((await activate(key, planId, b)).status).toBe(200);
    expect((await transition(key, planId, b, "done")).status).toBe(200);

    const bAfter = await getCycle(key, "CR-GUARD-4", b);
    expect(bAfter.status).toBe("done");
  });

  // ── AC6 — the orchestrator's own mis-activation replay (plan-7 incident) ─
  // Real incident shape: a 5-cycle plan, activation attempted on the SECOND
  // cycle while the first is still pending. "POST activate on cycle 2" in
  // the CR's acceptance criterion describes the ORCHESTRATOR action; the
  // actual wire call is PATCH …/cycles/<id> {status:"active"} — there is no
  // separate "activate" verb in this API (confirmed: src/v2.ts's only
  // cycle-status route is handleCycleTransition via PATCH).
  test("AC6: plan-7 replay — 5-cycle plan, activating cycle 2 while cycle 1 is pending -> 400 (the incident becomes impossible)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const filed = await postJson(plansPath(key), {
      cr: "CR-GUARD-6",
      cycles: [{ label: "c1" }, { label: "c2" }, { label: "c3" }, { label: "c4" }, { label: "c5" }],
    });
    expect(filed.status).toBe(201);
    const plan = (await filed.json()) as PlanFileResponse;
    expect(plan.cycles.length).toBe(5);
    const cycle1 = plan.cycles[0]!.id;
    const cycle2 = plan.cycles[1]!.id;

    const res = await activate(key, plan.planId, cycle2);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/out-of-order/i);
    expect(body.error).toContain(String(cycle1));

    const cycle2After = await getCycle(key, "CR-GUARD-6", cycle2);
    expect(cycle2After.status).toBe("pending");
  });

  // ── AC5 — §S4 sweep: every 4xx from plans/cycles carries non-empty help[] ─
  describe("AC5: every 4xx from plans/cycles routes carries a non-empty help[] naming a concrete next action", () => {
    test("illegal transition (active -> pending) -> 400, help mentions cycles never retreat + append-for-rework", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), { cr: "CR-GUARD-5A", cycles: [{ label: "solo" }] });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await activate(key, plan.planId, cycleId);

      const res = await transition(key, plan.planId, cycleId, "pending");
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      const help = helpText(body);
      expect(help).toMatch(/retreat/i);
      expect(help).toMatch(/append/i);
      expect(help).toMatch(/rework/i);
    });

    test("PATCH on a closed plan -> 400, non-empty help[]", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), { cr: "CR-GUARD-5B", cycles: [{ label: "solo" }] });
      const plan = (await filed.json()) as PlanFileResponse;
      const cycleId = plan.cycles[0]!.id;
      await activate(key, plan.planId, cycleId);
      await transition(key, plan.planId, cycleId, "done");
      const closeRes = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc0001" },
      });
      expect(closeRes.status).toBe(200);

      // A second close attempt on an already-closed plan -> 400.
      const res = await patchJson(plansPath(key, `/${plan.planId}`), {
        status: "closed",
        merge: { commit: "abc0002" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      helpText(body);
    });

    test("unknown planId -> 404, non-empty help[]", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await activate(key, 999999, 1);
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      helpText(body);
    });

    test("unknown cycleId -> 404, non-empty help[]", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const filed = await postJson(plansPath(key), { cr: "CR-GUARD-5D", cycles: [{ label: "solo" }] });
      const plan = (await filed.json()) as PlanFileResponse;

      const res = await activate(key, plan.planId, 999999);
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      helpText(body);
    });

    test("malformed cycle input (missing label) -> 400, non-empty help[]", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();

      const res = await postJson(plansPath(key), { cr: "CR-GUARD-5E", cycles: [{}] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      helpText(body);
    });

    test("duplicate open plan per cr -> 400, non-empty help[]", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject();
      const first = await postJson(plansPath(key), { cr: "CR-GUARD-5F", cycles: [{ label: "a" }] });
      expect(first.status).toBe(201);

      const res = await postJson(plansPath(key), { cr: "CR-GUARD-5F", cycles: [{ label: "b" }] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      helpText(body);
    });
  });
});
