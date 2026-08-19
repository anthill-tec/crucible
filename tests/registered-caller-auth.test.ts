// CR-CRU-056 §S2b (C3, server) — "ONLY a registered agent communicates with
// the server — orchestrators included" (user ruling 2026-08-01). Every
// MUTATING v2 WORKFLOW surface (plan-file, plan close/backfill, cycle-add,
// cycle-activate/done/label, checkpoint, abort, project stop, milestone,
// gate ingest) carries the calling `agentId` and is REFUSED — 409,
// `ok:false`, non-empty state-derived `help[]` naming registration as the
// next step — unless that id is a LIVE REGISTERED agent. There are no
// anonymous verbs and no orchestrator exemption. UI-management routes
// (projects POST/PATCH/DELETE) and ALL GET reads stay authentication-free
// (§S2b: "Read surfaces ... remain open").
//
// RED phase: NONE of the routes below check agentId liveness today —
// src/v2.ts's handlePlanFile/handleCycleAppend/handleCycleTransition/
// handlePlanClose/handlePlanAbort/handleGates/handleMilestones never look at
// whether the posted agentId resolves to a live row, and
// handlePlanCheckpoint/handleProjectStop don't even read the request body
// (handlePlansRoute/handleV2 call them with no `req` argument at all) — every
// "refused" case below reads back its CURRENT success status (200/201)
// instead of 409. The boundary/regression pins (projects POST/PATCH, GET
// routes, and "a live registered caller succeeds") are already true today —
// each is labelled BORN GREEN at the test.
//
// Harness: drives the real production server (startServer) + real HTTP, the
// same pattern as tests/agent-cycle-binding.test.ts (register/heartbeat +
// the plans/cycles HTTP surface) and tests/checkpoint-stop.test.ts
// (checkpoint/stop routes) — no new mechanism invented here. State-unchanged
// assertions read back through `handle.store` directly, the same technique
// agent-cycle-binding.test.ts uses (store.hasAgent / store.listPlans).

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { Store } from "../src/store.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface ErrResponse {
  ok: false;
  error?: unknown;
  help?: unknown;
  [key: string]: unknown;
}

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  [key: string]: unknown;
}

interface PlanFileResponse {
  planId: number;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

/** Same helper as tests/agent-cycle-binding.test.ts's errorSurface. */
function errorSurface(body: ErrResponse): string {
  const help = Array.isArray(body.help) ? body.help.join(" ") : String(body.help ?? "");
  return `${String(body.error ?? "")} ${help}`.toLowerCase();
}

/** §S2b — the shared refusal shape: 409, ok:false, non-empty help[] naming
 * registration as the next step (whatever exact wording GREEN picks). */
function expectUnregisteredRefusal(res: Response, body: ErrResponse): void {
  expect(res.status).toBe(409);
  expect(body.ok).toBe(false);
  expect(Array.isArray(body.help)).toBe(true);
  expect((body.help as unknown[]).length).toBeGreaterThan(0);
  expect(errorSurface(body)).toContain("regist");
}

let handle: ServerHandle | undefined;

/** Project keys that already have the fixture orchestrator (below) live-registered
 * for the CURRENT server boot — reset every afterEach so it never leaks across
 * boots (each boot is a fresh :memory: store with no live agents). */
let fixtureOrchestratorKeys: Set<string> = new Set();

afterEach(() => {
  handle?.stop();
  handle = undefined;
  fixtureOrchestratorKeys = new Set();
});

function boot(): ServerHandle {
  handle = startServer({ port: 0, dbPath: ":memory:" });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function postJson(path_: string, body: unknown): Promise<Response> {
  return fetch(`${base()}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(path_: string, body: unknown): Promise<Response> {
  return fetch(`${base()}${path_}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

function projectPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}${suffix}`;
}

/** §S2b fixture-repair (C3): plan-file/cycle-activate/cycle-transition are
 * MUTATING v2 workflow verbs — §S2b requires them to refuse an unregistered
 * caller (409) exactly like every other route below. The shared setup
 * helpers below are fixtures, not assertions under test, so they must model
 * a CORRECTLY-registered caller: once per server boot (memoized per project
 * key — a fresh :memory: store per boot has no live agents), register a
 * dedicated `fixture-orch` ORCHESTRATOR via the real HTTP register route,
 * then pass its agentId on every fixture request. This does NOT touch the
 * §S2b anonymous/ghost/pruned assertions themselves — those construct their
 * own requests below and must keep failing-then-refused exactly as written. */
async function ensureFixtureOrchestrator(key: string): Promise<void> {
  if (fixtureOrchestratorKeys.has(key)) return;
  await registerOrchestrator(key, "fixture-orch");
  fixtureOrchestratorKeys.add(key);
}

async function fileOnly(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
  await ensureFixtureOrchestrator(key);
  const res = await postJson(plansPath(key), {
    cr,
    cycles: [{ label: "solo" }],
    agentId: "fixture-orch",
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as PlanFileResponse;
  return { planId: body.planId, cycleId: body.cycles[0]!.id };
}

async function fileAndActivate(key: string, cr: string): Promise<{ planId: number; cycleId: number }> {
  const { planId, cycleId } = await fileOnly(key, cr);
  await ensureFixtureOrchestrator(key);
  const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
    status: "active",
    agentId: "fixture-orch",
  });
  expect(res.status).toBe(200);
  return { planId, cycleId };
}

async function transitionCycle(key: string, planId: number, cycleId: number, status: string): Promise<void> {
  await ensureFixtureOrchestrator(key);
  const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
    status,
    agentId: "fixture-orch",
  });
  expect(res.status).toBe(200);
}

function findPlan(store: Store, key: string, cr: string) {
  return store.listPlans(key).find((p) => p.cr === cr);
}

async function registerOrchestrator(key: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
}

async function registerBound(
  key: string,
  agentId: string,
  role: string,
  cycleId: number,
): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role, cycleId });
  expect(res.status).toBe(200);
}

async function unregisterAgent(key: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
  expect(res.status).toBe(200);
}

// ── §S2b — POST .../plans (plan-file) ────────────────────────────────────

describe("§S2b — POST .../plans (plan-file) refuses an unregistered caller", () => {
  test("no agentId field, or an agentId with no live registered row -> 409 both times; NO plan created either time", async () => {
    const h = boot();
    const key = seedProject(h.store);

    const noAgent = await postJson(plansPath(key), { cr: "CR-NOAGENT-FILE-1", cycles: [{ label: "solo" }] });
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-NOAGENT-FILE-1")).toBeUndefined();

    const ghost = await postJson(plansPath(key), {
      cr: "CR-NOAGENT-FILE-2",
      cycles: [{ label: "solo" }],
      agentId: "ghost-orchestrator",
    });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-NOAGENT-FILE-2")).toBeUndefined();
  });

  test("a LIVE registered ORCHESTRATOR caller succeeds exactly as today (201, plan created) — BORN GREEN: today's route never reads agentId, so this already passes and must keep passing after GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-file-1");

    const res = await postJson(plansPath(key), {
      cr: "CR-LIVE-FILE-1",
      cycles: [{ label: "solo" }],
      agentId: "orch-file-1",
    });
    expect(res.status).toBe(201);
    expect(findPlan(h.store, key, "CR-LIVE-FILE-1")).toBeDefined();
  });

  test("a PRUNED caller (registered yesterday, unregistered today) is refused exactly like a never-registered one — 409, no plan created (the 2026-08-01 scenario)", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-file-pruned");
    await unregisterAgent(key, "orch-file-pruned");

    const res = await postJson(plansPath(key), {
      cr: "CR-PRUNED-FILE-1",
      cycles: [{ label: "solo" }],
      agentId: "orch-file-pruned",
    });
    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-PRUNED-FILE-1")).toBeUndefined();
  });
});

// ── §S2b — PATCH .../plans/<planId> (close / backfill) ───────────────────

describe("§S2b — PATCH .../plans/<planId> (close) refuses an unregistered caller; plan stays open", () => {
  test("no agentId, or a ghost agentId, on a plan whose only cycle is DONE -> 409 both times; plan.status stays 'open' (never flips to 'closed')", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileAndActivate(key, "CR-CLOSE-NOAGENT");
    await transitionCycle(key, planId, cycleId, "done");

    const noAgent = await patchJson(plansPath(key, `/${planId}`), { status: "closed" });
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-CLOSE-NOAGENT")!.status).toBe("open");

    const ghost = await patchJson(plansPath(key, `/${planId}`), { status: "closed", agentId: "ghost-orch" });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-CLOSE-NOAGENT")!.status).toBe("open");
  });

  test("a LIVE registered ORCHESTRATOR caller closes the plan exactly as today (200, status:'closed') — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileAndActivate(key, "CR-CLOSE-LIVE");
    await transitionCycle(key, planId, cycleId, "done");
    await registerOrchestrator(key, "orch-close-1");

    const res = await patchJson(plansPath(key, `/${planId}`), { status: "closed", agentId: "orch-close-1" });
    expect(res.status).toBe(200);
    expect(findPlan(h.store, key, "CR-CLOSE-LIVE")!.status).toBe("closed");
  });
});

describe("§S2b — PATCH .../plans/<planId> (wave backfill) refuses an unregistered caller; wave stays unstamped", () => {
  test("no agentId field -> 409; plan.wave stays undefined (no backfill applied)", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId } = await fileOnly(key, "CR-BACKFILL-NOAGENT");

    const res = await patchJson(plansPath(key, `/${planId}`), { wave: "4" });
    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-BACKFILL-NOAGENT")!.wave).toBeUndefined();
  });

  test("a LIVE registered ORCHESTRATOR caller backfills the wave exactly as today (200, wave:'4') — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId } = await fileOnly(key, "CR-BACKFILL-LIVE");
    await registerOrchestrator(key, "orch-backfill-1");

    const res = await patchJson(plansPath(key, `/${planId}`), { wave: "4", agentId: "orch-backfill-1" });
    expect(res.status).toBe(200);
    expect(findPlan(h.store, key, "CR-BACKFILL-LIVE")!.wave).toBe("4");
  });
});

// ── §S2b — POST .../plans/<planId>/cycles (cycle-add) ─────────────────────

describe("§S2b — POST .../plans/<planId>/cycles (cycle-add) refuses an unregistered caller; no cycle appended", () => {
  test("no agentId, or a ghost agentId -> 409 both times; the plan's cycle count stays at 1 (no new cycle appended)", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId } = await fileOnly(key, "CR-CYCLEADD-NOAGENT");

    const noAgent = await postJson(plansPath(key, `/${planId}/cycles`), { label: "rework" });
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-CYCLEADD-NOAGENT")!.cycles.length).toBe(1);

    const ghost = await postJson(plansPath(key, `/${planId}/cycles`), { label: "rework", agentId: "ghost-orch" });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-CYCLEADD-NOAGENT")!.cycles.length).toBe(1);
  });

  test("a LIVE registered ORCHESTRATOR caller appends the cycle exactly as today (201, cycle count becomes 2) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId } = await fileOnly(key, "CR-CYCLEADD-LIVE");
    await registerOrchestrator(key, "orch-cycleadd-1");

    const res = await postJson(plansPath(key, `/${planId}/cycles`), { label: "rework", agentId: "orch-cycleadd-1" });
    expect(res.status).toBe(201);
    expect(findPlan(h.store, key, "CR-CYCLEADD-LIVE")!.cycles.length).toBe(2);
  });
});

// ── §S2b — PATCH .../plans/<planId>/cycles/<id> (activate / done / label) ─

describe("§S2b — PATCH .../plans/<planId>/cycles/<id> (activate) refuses an unregistered caller; cycle stays pending", () => {
  test("no agentId, or a ghost agentId -> 409 both times; the cycle's status stays 'pending' (never flips to 'active')", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileOnly(key, "CR-ACTIVATE-NOAGENT");

    const noAgent = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-ACTIVATE-NOAGENT")!.cycles[0]!.status).toBe("pending");

    const ghost = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      status: "active",
      agentId: "ghost-orch",
    });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-ACTIVATE-NOAGENT")!.cycles[0]!.status).toBe("pending");
  });

  test("a LIVE registered ORCHESTRATOR caller activates the cycle exactly as today (200, status:'active') — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileOnly(key, "CR-ACTIVATE-LIVE");
    await registerOrchestrator(key, "orch-activate-1");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      status: "active",
      agentId: "orch-activate-1",
    });
    expect(res.status).toBe(200);
    expect(findPlan(h.store, key, "CR-ACTIVATE-LIVE")!.cycles[0]!.status).toBe("active");
  });
});

describe("§S2b — PATCH .../plans/<planId>/cycles/<id> (label rename) refuses an unregistered caller; label stays unchanged", () => {
  test("no agentId field -> 409; the cycle's label stays 'solo' (rename not applied)", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileOnly(key, "CR-LABEL-NOAGENT");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { label: "renamed" });
    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-LABEL-NOAGENT")!.cycles[0]!.label).toBe("solo");
  });

  test("a LIVE registered ORCHESTRATOR caller renames the cycle exactly as today (200, label:'renamed') — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileOnly(key, "CR-LABEL-LIVE");
    await registerOrchestrator(key, "orch-label-1");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      label: "renamed",
      agentId: "orch-label-1",
    });
    expect(res.status).toBe(200);
    expect(findPlan(h.store, key, "CR-LABEL-LIVE")!.cycles[0]!.label).toBe("renamed");
  });
});

// ── §S2b — POST .../plans/<planId>/checkpoint ─────────────────────────────

describe("§S2b — POST .../plans/<planId>/checkpoint refuses an unregistered caller", () => {
  test("no agentId, or a ghost agentId -> 409 both times (not the ordinary 200 {ok:true, changed:...} shape); the cycle's status is left untouched", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileAndActivate(key, "CR-CKPT-NOAGENT");

    const noAgent = await postJson(plansPath(key, `/${planId}/checkpoint`), {});
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-CKPT-NOAGENT")!.cycles.find((c) => c.id === cycleId)!.status).toBe(
      "active",
    );

    const ghost = await postJson(plansPath(key, `/${planId}/checkpoint`), { agentId: "ghost-orch" });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
  });

  test("a LIVE registered ORCHESTRATOR caller checkpoints exactly as today (200, {ok:true, changed:true}) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId } = await fileAndActivate(key, "CR-CKPT-LIVE");
    await registerOrchestrator(key, "orch-ckpt-1");

    const res = await postJson(plansPath(key, `/${planId}/checkpoint`), { agentId: "orch-ckpt-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean };
    expect(body).toEqual({ ok: true, changed: true });
  });

  test("a bound TDD-role (GREEN) registered caller is ALSO a valid checkpoint caller (not ORCHESTRATOR-exclusive) — 200, {ok:true, changed:true}; but once that same id is unregistered, the identical call is refused (409) — the yesterday-registered-today-gone case", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileAndActivate(key, "CR-CKPT-TDD-THEN-PRUNED");
    await registerBound(key, "green-ckpt-1", "GREEN", cycleId);

    const live = await postJson(plansPath(key, `/${planId}/checkpoint`), { agentId: "green-ckpt-1" });
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as { ok: boolean; changed: boolean };
    expect(liveBody).toEqual({ ok: true, changed: true });

    await unregisterAgent(key, "green-ckpt-1");

    const pruned = await postJson(plansPath(key, `/${planId}/checkpoint`), { agentId: "green-ckpt-1" });
    expectUnregisteredRefusal(pruned, (await pruned.json()) as ErrResponse);
  });
});

// ── §S2b — POST .../plans/<planId>/abort ──────────────────────────────────

describe("§S2b — POST .../plans/<planId>/abort refuses an unregistered caller even WITH userApproved:true; plan stays open", () => {
  test("no agentId, or a ghost agentId (both userApproved:true) -> 409 both times; plan.status stays 'open' (never flips to 'aborted')", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId } = await fileAndActivate(key, "CR-ABORT-NOAGENT");

    const noAgent = await postJson(plansPath(key, `/${planId}/abort`), { userApproved: true });
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-ABORT-NOAGENT")!.status).toBe("open");

    const ghost = await postJson(plansPath(key, `/${planId}/abort`), {
      userApproved: true,
      agentId: "ghost-orch",
    });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-ABORT-NOAGENT")!.status).toBe("open");
  });

  test("a LIVE registered ORCHESTRATOR caller with userApproved:true aborts exactly as today (200, status:'aborted') — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId } = await fileAndActivate(key, "CR-ABORT-LIVE");
    await registerOrchestrator(key, "orch-abort-1");

    const res = await postJson(plansPath(key, `/${planId}/abort`), {
      userApproved: true,
      agentId: "orch-abort-1",
    });
    expect(res.status).toBe(200);
    expect(findPlan(h.store, key, "CR-ABORT-LIVE")!.status).toBe("aborted");
  });
});

// ── §S2b — POST .../projects/<key>/stop ───────────────────────────────────

describe("§S2b — POST .../projects/<key>/stop refuses an unregistered caller", () => {
  test("no agentId, or a ghost agentId -> 409 both times (not the ordinary 200 {ok:true, checkpointed:...} shape); the active cycle stays active", async () => {
    const h = boot();
    const key = seedProject(h.store);
    const { planId, cycleId } = await fileAndActivate(key, "CR-STOP-NOAGENT");

    const noAgent = await postJson(projectPath(key, "/stop"), {});
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(findPlan(h.store, key, "CR-STOP-NOAGENT")!.cycles.find((c) => c.id === cycleId)!.status).toBe(
      "active",
    );

    const ghost = await postJson(projectPath(key, "/stop"), { agentId: "ghost-orch" });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
  });

  test("a LIVE registered ORCHESTRATOR caller stops exactly as today (200, {ok:true, checkpointed:1}) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await fileAndActivate(key, "CR-STOP-LIVE");
    await registerOrchestrator(key, "orch-stop-1");

    const res = await postJson(projectPath(key, "/stop"), { agentId: "orch-stop-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checkpointed: number };
    expect(body).toEqual({ ok: true, checkpointed: 1 });
  });
});

// ── §S2b — POST /api/v2/milestones ────────────────────────────────────────

describe("§S2b — POST /api/v2/milestones refuses an unregistered caller; no milestone event stored", () => {
  test("no agentId, or a ghost agentId -> 409 both times; NO milestone event is recorded", async () => {
    const h = boot();
    const key = seedProject(h.store);

    const noAgent = await postJson("/api/v2/milestones", { projectKey: key, type: "custom", label: "x" });
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "milestone").length).toBe(0);

    const ghost = await postJson("/api/v2/milestones", {
      projectKey: key,
      type: "custom",
      label: "x",
      agentId: "ghost-agent",
    });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "milestone").length).toBe(0);
  });

  test("a LIVE registered ORCHESTRATOR caller records the milestone exactly as today (201, ok:true) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-milestone-1");

    const res = await postJson("/api/v2/milestones", {
      projectKey: key,
      type: "custom",
      label: "x",
      agentId: "orch-milestone-1",
    });
    expect(res.status).toBe(201);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "milestone").length).toBe(1);
  });

  test("a PRUNED caller (registered yesterday, unregistered today) is refused exactly like a never-registered one — 409, no milestone stored (the 2026-08-01 scenario)", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-milestone-pruned");
    await unregisterAgent(key, "orch-milestone-pruned");

    const res = await postJson("/api/v2/milestones", {
      projectKey: key,
      type: "custom",
      label: "x",
      agentId: "orch-milestone-pruned",
    });
    expectUnregisteredRefusal(res, (await res.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "milestone").length).toBe(0);
  });
});

// ── §S2b — POST /api/v2/gates ─────────────────────────────────────────────

describe("§S2b — POST /api/v2/gates refuses an unregistered caller; no gate event stored", () => {
  const gate = { intent: "no-mistakes run", outcome: "passed", steps: ["test", "lint"] };

  test("no agentId, or a ghost agentId -> 409 both times; NO gate event is recorded", async () => {
    const h = boot();
    const key = seedProject(h.store);

    const noAgent = await postJson("/api/v2/gates", { projectKey: key, gate });
    expectUnregisteredRefusal(noAgent, (await noAgent.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "gate").length).toBe(0);

    const ghost = await postJson("/api/v2/gates", { projectKey: key, gate, agentId: "ghost-agent" });
    expectUnregisteredRefusal(ghost, (await ghost.json()) as ErrResponse);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "gate").length).toBe(0);
  });

  test("a LIVE registered ORCHESTRATOR caller records the gate exactly as today (201, ok:true) — BORN GREEN", async () => {
    const h = boot();
    const key = seedProject(h.store);
    await registerOrchestrator(key, "orch-gate-1");

    const res = await postJson("/api/v2/gates", { projectKey: key, gate, agentId: "orch-gate-1" });
    expect(res.status).toBe(201);
    expect(h.store.listEvents(key, 50).filter((e) => e.kind === "gate").length).toBe(1);
  });
});

// ── §S2b boundary pins — UI-management project routes + reads stay open ──

describe("§S2b boundary — POST/PATCH /api/v2/projects (the dashboard's management surface) stay authentication-free", () => {
  test("POST /api/v2/projects with NO agentId still creates the project (201-equivalent 200, ok:true, changed:true) — BORN GREEN, pinning the boundary", async () => {
    const h = boot();
    const res = await postJson("/api/v2/projects", { name: `boundary-${crypto.randomUUID()}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean; project: { key: string } };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(typeof body.project.key).toBe("string");
  });

  test("PATCH /api/v2/projects/<key> with NO agentId still applies the edit (200, ok:true, changed:true) — BORN GREEN, pinning the boundary", async () => {
    const h = boot();
    const key = seedProject(h.store);

    const res = await patchJson(projectPath(key), { name: "renamed-project" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean };
    expect(body).toEqual({ ok: true, changed: true });
    expect(h.store.getProject(key)!.name).toBe("renamed-project");
  });

  test("GET /api/v2/agents?project=<key> with NO agentId in the request is unaffected (200, ok:true) — BORN GREEN, one representative read-surface pin", async () => {
    const h = boot();
    const key = seedProject(h.store);

    const res = await getJson(`/api/v2/agents?project=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agents: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
  });
});
