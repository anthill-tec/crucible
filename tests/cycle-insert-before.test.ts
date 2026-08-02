// CR-CRU-024 §S3.1 — INSERT a cycle at a position. `POST …/plans/<planId>/cycles`
// gains an optional `before: <cycleId>` — the new cycle lands immediately
// before that sibling. Constraint: the insertion point must be AFTER the
// active cycle (inserting a pending cycle before the active one would
// instantly violate the §S1/§S2 order invariant) — violating inserts → 400 +
// AXI help naming the active cycle. Plain append (no `before`) stays as-is.
//
// Ordering mechanism (resolved at gap analysis 2026-07-20, spec lines 51-58):
// cycle DISPLAY ORDER moves off `cycle_id` onto a new `seq` column on
// `plan_cycles` — `cycle_id` stays the stable per-project PK. `listCycleRows`
// / `Plan.cycles` order by `seq ASC`; append sets `seq = MAX(seq)+1`;
// insert-before sets the new cycle's `seq` strictly between the target and
// its predecessor. So EVERY order assertion below reads the `cycles[]` array
// order from the GET response — NEVER `cycle_id` — per the explicit
// instruction that cycle_id must NOT be used as an ordering proxy once
// insert-before exists.
//
// RED phase: every test below is expected to FAIL against CURRENT production.
// Confirmed by reading:
//   - src/v2.ts handleCycleAppend (~703-726): parseCycleInput/CycleInput never
//     look at `body.before` at all — the field is silently ignored, so a POST
//     with `before` behaves exactly like a plain append (lands last).
//   - src/store.ts appendCycle (~1237) always calls insertCycle, which always
//     assigns `id = nextCycleId(projectKey)` (project-wide MAX(cycle_id)+1)
//     and INSERTs unconditionally at the end of iteration order — there is no
//     insertCycle-before-a-target code path at all.
//   - src/store.ts listCycleRows (~1160) orders `ORDER BY cycle_id ASC` — no
//     `seq` column exists on `plan_cycles` (CREATE TABLE at ~329 has no such
//     column), so display order is indistinguishable from cycle_id order
//     today; the moment insert-before lands a cycle out of cycle_id order,
//     this ORDER BY clause returns the WRONG sequence.
//   - src/store.ts transitionCycle's §S1 out-of-order guard (~1305-1315)
//     compares `c.cycle_id < cycleId` — again cycle_id, not seq — so it does
//     not (yet) recompute against a post-insert seq order.
//
// Same harness pattern as tests/cycle-activation-guards.test.ts and
// tests/cycle-edit-label.test.ts — drives the REAL production server via
// startServer, no guard/insert implementation is stubbed or mocked.
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

describe("POST …/cycles insert-before-a-position (CR-CRU-024 §S3.1)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  // CR-CRU-056 §S2b fixture-repair (C3): mutating v2 workflow verbs
  // (plan-file, cycle-add/insert, cycle transitions) now refuse an
  // unregistered caller (409) — merge a live-registered agentId into any
  // JSON body lacking one.
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
    const res = await postJson("/api/v2/projects", { name: `cycle-insert-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    await registerOrchestrator(body.project.key, "fixture-orch");
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  /** Files a plan with N pending cycles in order; returns their ids in that order. */
  async function fileCycles(
    key: string,
    cr: string,
    labels: string[],
  ): Promise<{ planId: number | string; ids: number[] }> {
    const res = await postJson(plansPath(key), {
      cr,
      cycles: labels.map((label) => ({ label })),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, ids: body.cycles.map((c) => c.id) };
  }

  async function transition(
    key: string,
    planId: number | string,
    cycleId: number,
    status: string,
  ): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
  }

  /** GET the plan's current cycles[] IN DISPLAY ORDER (never sorted client-side). */
  async function getCycles(key: string, cr: string): Promise<CyclePayload[]> {
    const res = await getJson(plansPath(key, `?cr=${encodeURIComponent(cr)}`));
    const body = (await res.json()) as PlansListResponse;
    const plan = body.plans.find((p) => p.cr === cr)!;
    return plan.cycles;
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

  /** Common fixture: A(skipped) B(active) C(pending) D(pending), in that seq order. */
  async function fileActiveFixture(
    key: string,
    cr: string,
  ): Promise<{ planId: number | string; a: number; b: number; c: number; d: number }> {
    const { planId, ids } = await fileCycles(key, cr, ["A", "B", "C", "D"]);
    const [a, b, c, d] = ids as [number, number, number, number];
    // A: pending -> skipped directly (legal shortcut per CYCLE_TRANSITIONS).
    expect((await transition(key, planId, a, "skipped")).status).toBe(200);
    // B: pending -> active (legal: A is no longer pending, so §S1 permits it).
    expect((await transition(key, planId, b, "active")).status).toBe(200);
    return { planId, a, b, c, d };
  }

  /**
   * Fixture with NO active cycle: A(skipped) B(done) C(pending) D(pending).
   * Used by the §S1-interplay tests below so the follow-up activation is
   * refused SOLELY by the out-of-order (earlier-pending-sibling) guard —
   * with B still `active`, §S2's "another cycle is already active" guard
   * would fire first and mask the out-of-order check this test targets.
   */
  async function fileClosedFixture(
    key: string,
    cr: string,
  ): Promise<{ planId: number | string; a: number; b: number; c: number; d: number }> {
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);
    expect((await transition(key, planId, b, "done")).status).toBe(200);
    return { planId, a, b, c, d };
  }

  test("insert-before a later PENDING sibling: 201 + the new cycle lands immediately before it in GET cycles[] order", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-1";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await postJson(plansPath(key, `/${planId}/cycles`), { label: "E", before: c });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; changed: true } & CyclePayload;
    expect(body.ok).toBe(true);
    expect(body.label).toBe("E");
    const e = body.id;

    const cycles = await getCycles(key, cr);
    // Order asserted by the GET cycles[] array position, NOT by cycle_id —
    // E's cycle_id is the highest ever allocated (project-wide MAX+1) yet it
    // must appear at index 2, immediately before C.
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, e, c, d]);
    expect(cycles.map((cy) => cy.label)).toEqual(["A", "B", "E", "C", "D"]);
  });

  test("before pointing at the ACTIVE cycle: 400 + help names the active cycle, no cycle inserted", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-2";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await postJson(plansPath(key, `/${planId}/cycles`), { label: "F", before: b });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/active/i);
    expect(body.error).toContain(String(b));

    const help = helpText(body);
    expect(help).toMatch(/active/i);
    expect(help).toContain(String(b));

    // No partial state: the sibling set is untouched.
    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, c, d]);
    expect(cycles.some((cy) => cy.label === "F")).toBe(false);
  });

  test("before pointing at an earlier (already-terminal) sibling: 400 + help names the active cycle, not the terminal one", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-3";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    // A sits BEFORE the active cycle B — inserting there would land a new
    // pending cycle ahead of the active one, which is exactly the invariant
    // §S1/§S2 forbid. The AC requires the 400 name the ACTIVE cycle (B), not A.
    const res = await postJson(plansPath(key, `/${planId}/cycles`), { label: "G", before: a });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/active/i);
    expect(body.error).toContain(String(b));

    const help = helpText(body);
    expect(help).toMatch(/active/i);
    expect(help).toContain(String(b));

    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, c, d]);
    expect(cycles.some((cy) => cy.label === "G")).toBe(false);
  });

  test("plain append (no before) is unchanged: 201, new cycle lands LAST in GET cycles[] order", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-4";
    const { planId, a, b, c, d } = await fileActiveFixture(key, cr);

    const res = await postJson(plansPath(key, `/${planId}/cycles`), { label: "H" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; changed: true } & CyclePayload;
    expect(body.ok).toBe(true);
    const h = body.id;

    const cycles = await getCycles(key, cr);
    expect(cycles.map((cy) => cy.id)).toEqual([a, b, c, d, h]);
    expect(cycles.map((cy) => cy.label)).toEqual(["A", "B", "C", "D", "H"]);
  });

  test("§S1 interplay: the newly-inserted cycle still obeys out-of-order — activating it while its new earlier PENDING sibling is pending -> 400", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-5";
    // No active cycle here (B is `done`) so the follow-up activation below is
    // refused SOLELY by §S1 out-of-order — not masked by §S2 already-active.
    const { planId, a, b, c, d } = await fileClosedFixture(key, cr);

    // Insert E between C and D: seq order becomes A, B, C, E, D. C (pending)
    // is now E's immediate earlier sibling.
    const insertRes = await postJson(plansPath(key, `/${planId}/cycles`), { label: "E", before: d });
    expect(insertRes.status).toBe(201);
    const inserted = (await insertRes.json()) as { id: number };
    const e = inserted.id;

    const cyclesAfterInsert = await getCycles(key, cr);
    expect(cyclesAfterInsert.map((cy) => cy.id)).toEqual([a, b, c, e, d]);

    // Activating E while C (its seq-earlier pending sibling) is still pending
    // must be refused exactly like any other §S1 out-of-order activation.
    const res = await transition(key, planId, e, "active");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/out-of-order/i);
    expect(body.error).toContain(String(c));

    const eAfter = (await getCycles(key, cr)).find((cy) => cy.id === e)!;
    expect(eAfter.status).toBe("pending");
  });

  test("§S1 interplay: seq order beats cycle_id order — a seq-earlier pending insert (higher cycle_id) blocks a seq-later sibling (lower cycle_id)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const cr = "CR-INS-6";
    // No active cycle here (B is `done`) so the follow-up activation below is
    // refused SOLELY by §S1 out-of-order — not masked by §S2 already-active.
    const { planId, a, b, c, d } = await fileClosedFixture(key, cr);

    // Insert E before C: seq order becomes A, B, E, C, D. E's cycle_id is the
    // project-wide highest (allocated last) even though it now sits BEFORE C
    // (a lower cycle_id) in display order.
    const insertRes = await postJson(plansPath(key, `/${planId}/cycles`), { label: "E", before: c });
    expect(insertRes.status).toBe(201);
    const inserted = (await insertRes.json()) as { id: number };
    const e = inserted.id;
    expect(e).toBeGreaterThan(c);

    const cyclesAfterInsert = await getCycles(key, cr);
    expect(cyclesAfterInsert.map((cy) => cy.id)).toEqual([a, b, e, c, d]);

    // Activating C must be refused: E is pending and seq-earlier than C, even
    // though cycle_id(E) > cycle_id(C) — a legacy `ORDER BY cycle_id` guard
    // would wrongly allow this (no sibling with a SMALLER cycle_id than C is
    // pending), so this failing exactly this way proves seq must govern.
    const res = await transition(key, planId, c, "active");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/out-of-order/i);
    expect(body.error).toContain(String(e));

    const cAfter = (await getCycles(key, cr)).find((cy) => cy.id === c)!;
    expect(cAfter.status).toBe("pending");
  });
});
