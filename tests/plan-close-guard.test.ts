// CR-CRU-048 §S2 — the SERVER refuses to close a plan with incomplete cycles.
//
// Gap-analysis (2026-07-28, recorded in the CR): PATCH …/plans/<planId>
// ALREADY refuses a close while any cycle is non-terminal (src/store.ts
// closePlan(), CYCLE_TERMINAL = done|skipped|failed) — that part predates
// this CR (CR-CRU-011 C1) and tests/plans.test.ts already pins the bare
// "400 listing its id" + "closes once every cycle is terminal" shapes.
// What CR-CRU-048 actually adds, per the ACs (verbatim):
//   - "the message NAMES the blocking cycle id(s) AND label(s)" — today only
//     the numeric id is named (src/store.ts:1528's template string, and the
//     `openCycles` field is id-only) — label is NOT surfaced anywhere in the
//     response. RED until GREEN adds it.
//   - "the refusal message should NAME abort as the remedy" (gap-analysis,
//     §S2) — today `hints.nonTerminalCycles` (src/hints.ts) tells the caller
//     to transition cycles or inspect them via GET, but never mentions
//     POST …/plans/<planId>/abort. RED until GREEN adds it.
//   - skipped/failed-don't-block and the untouched happy path are already
//     correct; those two tests below are RE-ASSERTED here (not merely
//     duplicated from plans.test.ts) as the guard's precision pin — a
//     regression to a naive "all cycles must be done" close guard, which
//     would strand every CR whose plan carries a deliberately-skipped or
//     failed cycle, must be caught by THIS CR's own test suite. They are
//     expected to PASS today; only the label-naming and abort-remedy tests
//     are expected to fail before GREEN.
//
// Harness: the exact boot/createProject/plansPath/postJson/patchJson/getJson
// convention already established in tests/plan-abort.test.ts (handle passed
// explicitly, no shared mutable module state) — same production server via
// startServer(), :memory: db, no live crucible.db ever touched.

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanRecord {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  merge?: { commit: string };
  [key: string]: unknown;
}

interface PlanFileResponse extends PlanRecord {}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: unknown;
  openCycles?: unknown;
  [key: string]: unknown;
}

let servers: ServerHandle[] = [];

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  servers.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of servers) {
    handle.stop();
  }
  servers = [];
});

// CR-CRU-056 §S2b fixture-repair (C3): mutating v2 workflow verbs
// (plan-file, cycle transitions, plan close) now refuse an unregistered
// caller (409) — merge a live-registered agentId into any JSON body lacking
// one.
function withFixtureAgent(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

async function postJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function patchJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function getJson(handle: ServerHandle, urlPath: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`);
}

async function registerOrchestrator(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", { projectKey: key, agentId, role: "ORCHESTRATOR" });
  expect(res.status).toBe(200);
}

async function createProject(handle: ServerHandle): Promise<string> {
  const res = await postJson(handle, "/api/v2/projects", { name: `close-guard-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
  await registerOrchestrator(handle, body.project.key, "fixture-orch");
  return body.project.key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
}

async function filePlan(
  handle: ServerHandle,
  key: string,
  cr: string,
  labels: string[],
): Promise<{ planId: number | string; cycleIds: number[] }> {
  const res = await postJson(handle, plansPath(key), {
    cr,
    cycles: labels.map((label) => ({ label })),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as PlanFileResponse;
  return { planId: body.planId, cycleIds: body.cycles.map((c) => c.id) };
}

async function transition(
  handle: ServerHandle,
  key: string,
  planId: number | string,
  cycleId: number,
  status: string,
): Promise<Response> {
  return patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
}

async function closePlan(
  handle: ServerHandle,
  key: string,
  planId: number | string,
  commit = "abc1234",
): Promise<Response> {
  return patchJson(handle, plansPath(key, `/${planId}`), {
    status: "closed",
    merge: { commit },
  });
}

async function getPlanByCr(handle: ServerHandle, key: string, cr: string): Promise<PlanRecord> {
  const res = await getJson(handle, plansPath(key, `?cr=${encodeURIComponent(cr)}`));
  const body = (await res.json()) as PlansListResponse;
  const plan = body.plans.find((p) => p.cr === cr);
  return plan!;
}

function cycleById(plan: PlanRecord, id: number): CyclePayload {
  return plan.cycles.find((c) => c.id === id)!;
}

describe("PATCH …/plans/<planId> close guard (CR-CRU-048 §S2)", () => {
  // ── The defect's regression test — pending/active MUST block, and name
  // both the id AND the label of every blocking cycle. ──────────────────────

  test("a PENDING cycle blocks close: 4xx, plan stays open, cycle stays pending, response names its id AND label", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, cycleIds } = await filePlan(handle, key, "CR-GUARD-PENDING", [
      "C1 RED-GREEN",
      "C2 VERIFY",
    ]);
    const [c1, c2] = cycleIds as [number, number];
    await transition(handle, key, planId, c1, "active");
    await transition(handle, key, planId, c1, "done");
    // c2 ("C2 VERIFY") is left pending — the exact CR-CRU-042 scenario.

    const res = await closePlan(handle, key, planId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const bodyRaw = await res.text();
    const body = JSON.parse(bodyRaw) as ErrResponse;
    expect(body.ok).toBe(false);
    // Names the blocking id...
    expect(bodyRaw).toContain(String(c2));
    // ...AND the blocking cycle's label — not just its numeric id. This is
    // the part that is genuinely new: today's error/openCycles carry only
    // the id, never "C2 VERIFY".
    expect(bodyRaw).toContain("C2 VERIFY");
    // Does NOT falsely name the already-done cycle as blocking.
    expect(bodyRaw).not.toContain("C1 RED-GREEN");

    // Nothing changed: plan remains open, c2 remains pending.
    const plan = await getPlanByCr(handle, key, "CR-GUARD-PENDING");
    expect(plan.status).toBe("open");
    expect(cycleById(plan, c2).status).toBe("pending");
    expect(plan.merge).toBeUndefined();
  });

  test("an ACTIVE cycle blocks close: 4xx, plan stays open, cycle stays active, response names its id AND label", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, cycleIds } = await filePlan(handle, key, "CR-GUARD-ACTIVE", [
      "C1 RED-GREEN",
      "C2 VERIFY",
    ]);
    const [c1, c2] = cycleIds as [number, number];
    await transition(handle, key, planId, c1, "active");
    await transition(handle, key, planId, c1, "done");
    await transition(handle, key, planId, c2, "active"); // C2 VERIFY is running.

    const res = await closePlan(handle, key, planId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const bodyRaw = await res.text();
    const body = JSON.parse(bodyRaw) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(bodyRaw).toContain(String(c2));
    expect(bodyRaw).toContain("C2 VERIFY");

    const plan = await getPlanByCr(handle, key, "CR-GUARD-ACTIVE");
    expect(plan.status).toBe("open");
    expect(cycleById(plan, c2).status).toBe("active");
  });

  // ── The guard's precision test — skipped/failed are TERMINAL and must NOT
  // block; a naive "every cycle must be done" implementation fails this. ────

  test("skipped and failed remaining cycles do NOT block close — both are terminal states", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, cycleIds } = await filePlan(handle, key, "CR-GUARD-TERMINAL-MIX", [
      "C1 RED-GREEN",
      "C2 SKIPPED-SCOPE",
      "C3 FIX",
    ]);
    const [c1, c2, c3] = cycleIds as [number, number, number];
    await transition(handle, key, planId, c1, "active");
    await transition(handle, key, planId, c1, "done");
    await transition(handle, key, planId, c2, "skipped"); // pending -> skipped shortcut
    await transition(handle, key, planId, c3, "active");
    await transition(handle, key, planId, c3, "failed");

    const res = await closePlan(handle, key, planId, "deadbee");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; changed: true; plan: PlanRecord };
    expect(body.ok).toBe(true);
    expect(body.plan.status).toBe("closed");

    const plan = await getPlanByCr(handle, key, "CR-GUARD-TERMINAL-MIX");
    expect(plan.status).toBe("closed");
    expect(cycleById(plan, c1).status).toBe("done");
    expect(cycleById(plan, c2).status).toBe("skipped");
    expect(cycleById(plan, c3).status).toBe("failed");
    expect(plan.merge?.commit).toBe("deadbee");
  });

  // ── The happy path — unchanged. (Already covered by tests/plans.test.ts;
  // re-asserted here so this CR's own suite pins it. Expected to PASS today
  // — this is NOT part of the RED delta, only the guard-rail.) ─────────────

  test("a plan whose every cycle is done closes exactly as today", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId, cycleIds } = await filePlan(handle, key, "CR-GUARD-HAPPY", ["solo"]);
    const [c1] = cycleIds as [number];
    await transition(handle, key, planId, c1, "active");
    await transition(handle, key, planId, c1, "done");

    const res = await closePlan(handle, key, planId, "cafefeed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; plan: PlanRecord };
    expect(body.plan.status).toBe("closed");
    expect(body.plan.merge?.commit).toBe("cafefeed");
  });

  // ── The remedy is discoverable — help[] must NAME abort, not merely
  // "transition your cycles" (there is no --force; abort IS the sanctioned
  // way to deliberately close out unrun cycles). ────────────────────────────

  test("the refusal's help[] names POST …/plans/<planId>/abort as the sanctioned remedy", async () => {
    const handle = boot();
    const key = await createProject(handle);
    const { planId } = await filePlan(handle, key, "CR-GUARD-REMEDY", ["C1 RED-GREEN", "C2 VERIFY"]);
    // Both cycles left pending — no need to touch either for this assertion.

    const res = await closePlan(handle, key, planId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as ErrResponse;
    expect(Array.isArray(body.help)).toBe(true);
    const help = (body.help as string[]).map((h) => h.toLowerCase());
    expect(help.length).toBeGreaterThan(0);
    // Names abort as the remedy — not just "transition your cycles" or
    // "GET to inspect them" (today's hints.nonTerminalCycles content).
    expect(help.some((h) => h.includes("abort"))).toBe(true);
    expect(help.some((h) => h.includes("userapproved"))).toBe(true);

    // Plan is untouched by the refusal.
    const plan = await getPlanByCr(handle, key, "CR-GUARD-REMEDY");
    expect(plan.status).toBe("open");
  });
});
