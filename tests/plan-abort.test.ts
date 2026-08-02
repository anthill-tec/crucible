// CR-CRU-024 §S6 — Workflow abort — user-approval-gated (user ruling
// 2026-07-17).
//
// Spec (verbatim, docs/changes/CR-CRU-024-patch-cycle-activation-guards.md):
//
//   1. `POST …/plans/<planId>/abort` WITHOUT `userApproved: true` in the body
//      → 409 with a strongly discouraging AXI response: the error states
//      that aborting discards a declared workflow and REQUIRES explicit
//      user approval; `help[]` instructs the orchestrator to present the
//      abort to the user and retry with `userApproved: true` ONLY after the
//      user approves. Nothing changes state.
//   2. WITH `userApproved: true` → the abort executes: the ACTIVE cycle →
//      `failed` (abort noted), all PENDING cycles → `skipped`, the plan
//      status → `aborted` (new terminal plan state, additive alongside
//      open|closed). Aborted plans render with an `aborted` state (never a
//      merge pill); an aborted plan means the CR can file a NEW plan — the
//      one-open-plan-per-cr rule sees aborted as not-open.
//      Implementation note (gap analysis 2026-07-20): the derived-status
//      collapse in store.ts (`row.status === "closed" ? "closed" : "open"`,
//      which currently maps ANY non-closed status to "open") MUST preserve
//      "aborted" — otherwise an aborted plan is reported as open and the
//      history lens can never render it.
//   3. The timer state is checkpointed as part of the abort (sealed values
//      stay honest).
//
// AC (verbatim):
//   - abort unapproved: POST …/plans/<id>/abort (no flag) -> 409; error
//     states user approval is required; help[] instructs presenting to the
//     user + retrying with userApproved:true; plan/cycles unchanged.
//   - abort approved: with {userApproved:true} — active cycle -> failed,
//     pending cycles -> skipped, plan -> aborted; the history lens renders
//     the group with an aborted state and NO merge pill; filing a new plan
//     for the same cr afterwards succeeds (aborted != open); the aborted
//     cycle's timer sealed at its checkpointed value.
//
// RED phase: NONE of this exists in production yet. src/v2.ts's
// handlePlansRoute has no "abort" branch (segments.length===4 with
// segments[3]==="abort" falls through to the generic 404 catch-all — NOT
// the AXI-shaped 409/200 responses asserted here), src/store.ts has no
// abortPlan() method, and types.ts's PlanStatus union
// (`"open" | "closed"` on Plan.status) has no "aborted" member. Every
// request below either 404s via the catch-all or the plan never reaches an
// "aborted" status.
//
// Harness: reuses the EXACT postJson/patchJson/getJson + createProject +
// plansPath conventions from tests/cycle-activation-guards.test.ts, and the
// time-injection + store-reopen technique from tests/checkpoint-stop.test.ts
// (bun:test's setSystemTime() + a "restart" being a fresh startServer() over
// the SAME on-disk dbPath) for the sealed-timer assertions.

import { describe, test, expect, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/server.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  activatedAt?: number;
  doneAt?: number;
  activeMs?: number;
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
  [key: string]: unknown;
}

function freshTmpDbPath(): string {
  // NEVER inside the repo — a fresh OS tmpdir per test (same convention as
  // tests/boot-safety.test.ts / tests/checkpoint-stop.test.ts).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-abort-test-"));
  return path.join(dir, "crucible.db");
}

let servers: ServerHandle[] = [];

function boot(dbPath: string): ServerHandle {
  const handle = startServer({ port: 0, dbPath });
  servers.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of servers) {
    handle.stop();
  }
  servers = [];
  setSystemTime(); // reset the injected clock so it never leaks to other files
});

// CR-CRU-056 §S2b fixture-repair (C3): every mutating v2 WORKFLOW verb
// (plan-file, cycle transitions, abort) now refuses an unregistered caller
// (409) — merge a live-registered agentId into any body lacking one.
function withFixtureAgent(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

// This file drives `setSystemTime()` (including a 2h forward jump to
// simulate downtime) — the fixture orchestrator registered at REAL
// wall-clock time would otherwise fall outside its lazy-prune liveness
// window the instant the mocked clock jumps ahead, spuriously 409ing every
// workflow verb that follows a time jump (same fix as
// tests/cycle-epochs.test.ts / tests/checkpoint-stop.test.ts). Re-touch
// (re-register) it against the CURRENT (possibly mocked) clock immediately
// before every mutating call, keyed off the projectKey in the request path.
async function touchFixtureAgent(handle: ServerHandle, urlPath: string): Promise<void> {
  const match = /^\/api\/v2\/projects\/([^/]+)\//.exec(urlPath);
  if (match === null) return;
  await fetch(`http://localhost:${handle.server.port}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: match[1], agentId: "fixture-orch", role: "ORCHESTRATOR" }),
  });
}

async function postJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  await touchFixtureAgent(handle, urlPath);
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function patchJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  await touchFixtureAgent(handle, urlPath);
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withFixtureAgent(body)),
  });
}

async function getJson(handle: ServerHandle, urlPath: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`);
}

async function createProject(handle: ServerHandle): Promise<string> {
  const res = await postJson(handle, "/api/v2/projects", { name: `abort-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
  return body.project.key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
}

async function filePlanAB(
  handle: ServerHandle,
  key: string,
  cr: string,
): Promise<{ planId: number | string; a: number; b: number }> {
  const res = await postJson(handle, plansPath(key), {
    cr,
    cycles: [{ label: "A" }, { label: "B" }],
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as PlanFileResponse;
  return { planId: body.planId, a: body.cycles[0]!.id, b: body.cycles[1]!.id };
}

async function fileSingleCycle(
  handle: ServerHandle,
  key: string,
  cr: string,
): Promise<{ planId: number | string; cycleId: number }> {
  const res = await postJson(handle, plansPath(key), { cr, cycles: [{ label: "solo" }] });
  const body = (await res.json()) as PlanFileResponse;
  return { planId: body.planId, cycleId: body.cycles[0]!.id };
}

async function activate(
  handle: ServerHandle,
  key: string,
  planId: number | string,
  cycleId: number,
): Promise<void> {
  const res = await patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), {
    status: "active",
  });
  expect(res.status).toBe(200);
}

/** Fetches the plan record via GET …/plans?cr=<cr> (the plans-list read path). */
async function getPlanByCr(handle: ServerHandle, key: string, cr: string): Promise<PlanRecord> {
  const res = await getJson(handle, plansPath(key, `?cr=${encodeURIComponent(cr)}`));
  const body = (await res.json()) as PlansListResponse;
  const plan = body.plans.find((p) => p.cr === cr);
  return plan!;
}

/** Fetches ALL of a project's plans via the plain GET …/plans (no filter) — listPlans(). */
async function listAllPlans(handle: ServerHandle, key: string): Promise<PlanRecord[]> {
  const res = await getJson(handle, plansPath(key));
  const body = (await res.json()) as PlansListResponse;
  return body.plans;
}

function cycleById(plan: PlanRecord, id: number): CyclePayload {
  return plan.cycles.find((c) => c.id === id)!;
}

async function abort(
  handle: ServerHandle,
  key: string,
  planId: number | string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return postJson(handle, plansPath(key, `/${planId}/abort`), body);
}

const T0 = 1_800_000_000_000;
const THREE_MIN_MS = 3 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe("§S6.1 — POST …/plans/<planId>/abort WITHOUT userApproved:true -> 409, nothing changes", () => {
  test("no userApproved flag at all: 409, error requires user approval, help[] instructs present-then-retry-with-userApproved:true; plan+cycles unchanged", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, a, b } = await filePlanAB(handle, key, "CR-ABORT-UNAPPROVED-1");
    await activate(handle, key, planId, a);

    const res = await abort(handle, key, planId, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    // "the error states that aborting discards a declared workflow and
    // REQUIRES explicit user approval" — same assertion convention already
    // established in this codebase for the analogous guarded-run-deletion
    // approval gate (tests/shim-retirement.test.ts §S4).
    expect(body.error.toLowerCase()).toContain("approv");
    expect(Array.isArray(body.help)).toBe(true);
    const help = (body.help as string[]).map((h) => h.toLowerCase());
    expect(help.length).toBeGreaterThan(0);
    expect(help.some((h) => h.includes("userapproved"))).toBe(true);
    // help instructs presenting the abort to the USER before any retry.
    expect(help.some((h) => h.includes("user"))).toBe(true);

    // Nothing changed: plan stays open, A stays active, B stays pending.
    const plan = await getPlanByCr(handle, key, "CR-ABORT-UNAPPROVED-1");
    expect(plan.status).toBe("open");
    expect(cycleById(plan, a).status).toBe("active");
    expect(cycleById(plan, b).status).toBe("pending");
  });

  test("userApproved:false explicitly -> still 409 (falsy is not approved); nothing changes", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, a, b } = await filePlanAB(handle, key, "CR-ABORT-UNAPPROVED-2");

    const res = await abort(handle, key, planId, { userApproved: false });
    expect(res.status).toBe(409);

    const plan = await getPlanByCr(handle, key, "CR-ABORT-UNAPPROVED-2");
    expect(plan.status).toBe("open");
    expect(cycleById(plan, a).status).toBe("pending");
    expect(cycleById(plan, b).status).toBe("pending");
  });

  test("unknown planId, no userApproved: still 409 (the approval gate is checked before existence) — no crash, no 500", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);

    const res = await abort(handle, key, 999999, {});
    // The approval gate is the FIRST refusal on this route — an unknown
    // plan without approval must never leak past it as a 404/500.
    expect(res.status).toBe(409);
  });
});

describe("§S6.2 — POST …/plans/<planId>/abort WITH {userApproved:true} -> executes the abort", () => {
  test("active cycle -> failed, pending cycle -> skipped, plan -> aborted (verified via GET); no merge (no merge pill)", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, a, b } = await filePlanAB(handle, key, "CR-ABORT-APPROVED-1");
    await activate(handle, key, planId, a);

    const res = await abort(handle, key, planId, { userApproved: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const plan = await getPlanByCr(handle, key, "CR-ABORT-APPROVED-1");
    expect(plan.status).toBe("aborted");
    expect(cycleById(plan, a).status).toBe("failed");
    expect(cycleById(plan, b).status).toBe("skipped");
    // "never a merge pill" — an aborted plan never runs closePlan's merge
    // path, so the server-side proxy for "no merge pill" is an absent merge.
    expect(plan.merge).toBeUndefined();
  });

  test("multiple PENDING cycles all transition to skipped, only the ACTIVE one becomes failed", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const res = await postJson(handle, plansPath(key), {
      cr: "CR-ABORT-APPROVED-MULTI",
      cycles: [{ label: "c1" }, { label: "c2" }, { label: "c3" }],
    });
    expect(res.status).toBe(201);
    const filed = (await res.json()) as PlanFileResponse;
    const [c1, c2, c3] = filed.cycles.map((c) => c.id) as [number, number, number];
    await activate(handle, key, filed.planId, c1);

    const abortRes = await abort(handle, key, filed.planId, { userApproved: true });
    expect(abortRes.status).toBe(200);

    const plan = await getPlanByCr(handle, key, "CR-ABORT-APPROVED-MULTI");
    expect(plan.status).toBe("aborted");
    expect(cycleById(plan, c1).status).toBe("failed");
    expect(cycleById(plan, c2).status).toBe("skipped");
    expect(cycleById(plan, c3).status).toBe("skipped");
  });

  // IMPORTANT — pins the store.ts derived-status collapse hazard directly:
  // `row.status === "closed" ? "closed" : "open"` currently maps ANY
  // non-closed status (including a freshly-introduced "aborted") to "open".
  // GET …/plans (listPlans — the SAME code path the history lens reads) must
  // report the real "aborted" state, never coerce it back to "open".
  test("GET …/plans (listPlans) reports status:\"aborted\" after an approved abort — NOT coerced to \"open\"", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, cycleId } = await fileSingleCycle(handle, key, "CR-ABORT-HAZARD");
    await activate(handle, key, planId, cycleId);

    const abortRes = await abort(handle, key, planId, { userApproved: true });
    expect(abortRes.status).toBe(200);

    const plans = await listAllPlans(handle, key);
    const plan = plans.find((p) => p.cr === "CR-ABORT-HAZARD");
    expect(plan).toBeDefined();
    // The precise hazard assertion: status must be "aborted", and — to make
    // the failure mode explicit if the collapse bug regresses — it must NOT
    // be the coerced "open".
    expect(plan!.status).toBe("aborted");
    expect(plan!.status).not.toBe("open");
  });

  test("filing a NEW plan for the same cr after an approved abort succeeds — aborted != open (one-open-plan-per-cr sees it as not-open)", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, cycleId } = await fileSingleCycle(handle, key, "CR-ABORT-REFILE");
    await activate(handle, key, planId, cycleId);

    const abortRes = await abort(handle, key, planId, { userApproved: true });
    expect(abortRes.status).toBe(200);

    // Before the fix this cr's plan is (buggy-)reported as "open", so a
    // re-file would 400 as a duplicate-open-plan; after the fix the aborted
    // plan is not-open and filing succeeds.
    const refileRes = await postJson(handle, plansPath(key), {
      cr: "CR-ABORT-REFILE",
      cycles: [{ label: "retry" }],
    });
    expect(refileRes.status).toBe(201);
    const refiled = (await refileRes.json()) as PlanFileResponse;
    expect(refiled.status).toBe("open");
    expect(refiled.planId).not.toBe(planId);
  });

  test("unknown planId with userApproved:true -> 404 + non-empty help[] (approval alone doesn't skip existence checks)", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);

    const res = await abort(handle, key, 999999, { userApproved: true });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrResponse;
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as string[]).length).toBeGreaterThan(0);
  });
});

describe("§S6.3 — the abort checkpoints/seals the active cycle's timer (sealed values stay honest)", () => {
  test("active cycle at 3 injected minutes since activation: abort seals activatedAt/doneAt at EXACTLY that span — a store-reopen after a 2h downtime resumes the SAME sealed values (never recomputed live from wall-clock)", async () => {
    const dbPath = freshTmpDbPath();
    const server1 = boot(dbPath);
    const key = await createProject(server1);
    const { planId, cycleId } = await fileSingleCycle(server1, key, "CR-ABORT-SEALED");

    setSystemTime(T0);
    await activate(server1, key, planId, cycleId);

    // 3 minutes later — no intervening reads/checkpoints, so any persisted
    // seal value can only have come from the abort call itself.
    setSystemTime(T0 + THREE_MIN_MS);
    const abortRes = await abort(server1, key, planId, { userApproved: true });
    expect(abortRes.status).toBe(200);

    const planNow = await getPlanByCr(server1, key, "CR-ABORT-SEALED");
    const cycleNow = cycleById(planNow, cycleId);
    expect(cycleNow.status).toBe("failed");
    expect(cycleNow.activatedAt).toBe(T0);
    expect(cycleNow.doneAt).toBe(T0 + THREE_MIN_MS);

    // "Crash" immediately after the abort — no further live accumulation.
    server1.stop();

    // Large downtime + restart: a naive live-derivation (recomputing from
    // wall-clock at read time) would drift by ~2 hours; a genuinely sealed
    // value must resume EXACTLY as persisted.
    setSystemTime(T0 + THREE_MIN_MS + TWO_HOURS_MS);
    const server2 = boot(dbPath);
    const planResumed = await getPlanByCr(server2, key, "CR-ABORT-SEALED");
    const cycleResumed = cycleById(planResumed, cycleId);
    expect(cycleResumed.status).toBe("failed");
    expect(cycleResumed.activatedAt).toBe(T0);
    expect(cycleResumed.doneAt).toBe(T0 + THREE_MIN_MS);
    // Terminal cycles never carry a live `activeMs` (only ACTIVE ones do —
    // see src/store.ts toPlan()); the sealed span is activatedAt/doneAt.
    expect(cycleResumed.activeMs).toBeUndefined();
  });
});
