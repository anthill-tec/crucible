// CR-CRU-024 §S5 — Emergency-stop timer checkpoint (user ruling 2026-07-17).
//
// Spec (verbatim, docs/changes/CR-CRU-024-patch-cycle-activation-guards.md):
//
//   1. Checkpoint verb: `POST /api/v2/projects/<key>/plans/<planId>/checkpoint`
//      — folds the current epoch of the plan's ACTIVE cycle into
//      `active_ms_accumulated` immediately and re-anchors (no-op
//      `changed:false` when no cycle is active). One verb per plan, not per
//      cycle — the caller shouldn't need the cycle id mid-emergency.
//   2. Graceful-signal checkpoint: the server itself checkpoints EVERY
//      active cycle (all plans, all projects) on SIGTERM/SIGINT before
//      exit — an orderly stop never loses timer state; only a hard power
//      cut falls back to the <=60s read-cadence tolerance (CR-023 §S3).
//   3. Project stop: `POST /api/v2/projects/<key>/stop` — checkpoints EVERY
//      active cycle's timer across the project's open plans (the §S5.1
//      fold, project-wide). Distinct from archive. Returns
//      `{ok, checkpointed: <n>}`.
//
// AC (verbatim):
//   - checkpoint verb: with an active cycle at 3 injected minutes since the
//     last durable write, POST .../checkpoint -> 200 {ok:true, changed:true};
//     an immediate store-reopen resumes activeMs at the checkpointed value
//     EXACTLY (no cadence-window loss); with no active cycle -> 200
//     {changed:false}; unknown plan -> 404 + help.
//   - signal checkpoint: sending SIGTERM to a test-spawned server process
//     with an active mid-epoch cycle persists the epoch before exit — a
//     fresh store over the same DB resumes the exact value (subprocess-based
//     test; if the harness cannot spawn a signal-able server process, pin
//     the shutdown-hook function directly and SAY so in a comment + report).
//   - project stop: with two open plans each holding an active mid-epoch
//     cycle, POST .../projects/<key>/stop -> 200 {ok:true, checkpointed:2};
//     store-reopen resumes both exactly; no active cycles -> {checkpointed:0}.
//
// RED phase: none of `/plans/<planId>/checkpoint`, `/projects/<key>/stop`, or
// a store-wide `checkpointAllActive()` fold exist yet in production
// (src/v2.ts's `handlePlansRoute` has no `checkpoint` branch, `handleV2`'s
// project-route block has no `stop` branch, and `src/store.ts` has no
// store-wide checkpoint method) — every request below either 404s via the
// generic catch-all (not the AXI-shaped response asserted here) or throws
// calling a method that doesn't exist.
//
// Harness: reuses the EXACT time-injection + store-reopen technique from
// tests/cycle-epochs.test.ts (bun:test's `setSystemTime()` mocks
// process-wide `Date.now()`; a "restart" is a fresh `startServer()` over the
// SAME on-disk dbPath) and tests/boot-safety.test.ts's tmp-dir convention —
// no new clock mechanism invented here.

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

interface PlanFileResponse {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: Array<{
    planId: number | string;
    cr: string;
    status: string;
    cycles: CyclePayload[];
    [key: string]: unknown;
  }>;
}

function freshTmpDbPath(): string {
  // NEVER inside the repo — a fresh OS tmpdir per test (same technique as
  // tests/boot-safety.test.ts's freshTmpDir() / tests/cycle-epochs.test.ts).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-checkpoint-test-"));
  return path.join(dir, "crucible.db");
}

let servers: ServerHandle[] = [];

/** Boots (or "restarts", when reusing a real dbPath) a production server. */
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
// (plan-file, cycle transitions, checkpoint, stop) now refuses an
// unregistered caller (409) — merge a live-registered agentId into any body
// that doesn't already declare one.
function withFixtureAgent(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

// This file drives `setSystemTime()` heavily (including multi-hour forward
// jumps to simulate downtime/crashes) — the fixture orchestrator registered
// at REAL wall-clock time would otherwise fall outside its lazy-prune
// liveness window the instant the mocked clock jumps ahead, spuriously
// 409ing every workflow verb that follows a time jump (same fix as
// tests/cycle-epochs.test.ts). Re-touch (re-register) it against the
// CURRENT (possibly mocked) clock immediately before every mutating call,
// keyed off the projectKey embedded in the request path.
async function touchFixtureAgent(handle: ServerHandle, urlPath: string): Promise<void> {
  const match = /^\/api\/v2\/projects\/([^/]+)\//.exec(urlPath);
  if (match === null) return;
  await fetch(`http://localhost:${handle.server.port}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: match[1], agentId: "fixture-orch", phase: "ORCHESTRATOR" }),
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
  const res = await postJson(handle, "/api/v2/projects", { name: `checkpoint-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
  return body.project.key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
}

function projectPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}${suffix}`;
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

async function getCycle(handle: ServerHandle, key: string, cr: string): Promise<CyclePayload> {
  const res = await getJson(handle, plansPath(key, `?cr=${encodeURIComponent(cr)}`));
  const body = (await res.json()) as PlansListResponse;
  const plan = body.plans.find((p) => p.cr === cr);
  return plan!.cycles[0]!;
}

async function activate(handle: ServerHandle, key: string, planId: number | string, cycleId: number): Promise<void> {
  const res = await patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });
  expect(res.status).toBe(200);
}

// A fixed epoch anchor — arbitrary but constant, same convention as
// tests/cycle-epochs.test.ts's T0.
const T0 = 1_800_000_000_000;
const THREE_MIN_MS = 3 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe("§S5.1 — plan checkpoint verb: POST /api/v2/projects/<key>/plans/<planId>/checkpoint", () => {
  test("active cycle at 3 injected minutes since the last durable write: checkpoint verb folds the epoch NOW — 200 {ok:true, changed:true} — and an immediate store-reopen resumes activeMs at the checkpointed value EXACTLY (no cadence-window loss)", async () => {
    const dbPath = freshTmpDbPath();

    const server1 = boot(dbPath);
    const key = await createProject(server1);
    const { planId, cycleId } = await fileSingleCycle(server1, key, "CR-CKPT-PLAN");

    setSystemTime(T0);
    await activate(server1, key, planId, cycleId);

    // 3 minutes later — NO intervening GET/read, so this POST is the FIRST
    // durable-write opportunity since activation; any persisted value can
    // only have come from the checkpoint verb itself, not an incidental
    // read-path fold (store.ts's deriveAndCheckpointActiveMs, CR-023 §S3).
    setSystemTime(T0 + THREE_MIN_MS);
    const res = await postJson(server1, plansPath(key, `/${planId}/checkpoint`), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean };
    expect(body).toEqual({ ok: true, changed: true });

    // "Crash" immediately after the checkpoint — no further live accumulation.
    server1.stop();

    // Downtime before the restart — proves the resumed value is the
    // CHECKPOINTED setpoint, not a naive wall-clock-since-activation figure.
    setSystemTime(T0 + THREE_MIN_MS + TWO_HOURS_MS);
    const server2 = boot(dbPath);
    const resumed = await getCycle(server2, key, "CR-CKPT-PLAN");

    expect(resumed.status).toBe("active");
    expect(resumed.activatedAt).toBe(T0);
    // EXACT — no cadence-window loss (this is the whole point of the verb:
    // the passive read-path checkpoint only fires ONCE >=60s have elapsed
    // AND a read happens to occur; the verb forces the fold synchronously).
    expect(resumed.activeMs).toBe(THREE_MIN_MS);
  });

  test("no active cycle in the plan: checkpoint verb is a no-op — 200 {ok:true, changed:false}", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId } = await fileSingleCycle(handle, key, "CR-CKPT-NOACTIVE"); // cycle stays pending

    const res = await postJson(handle, plansPath(key, `/${planId}/checkpoint`), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean };
    expect(body).toEqual({ ok: true, changed: false });
  });

  test("unknown planId: checkpoint verb 404s with a non-empty AXI help[] naming the missing plan", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);

    const res = await postJson(handle, plansPath(key, `/999999/checkpoint`), {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; help?: string[] };
    expect(body.error).toContain("999999");
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as string[]).length).toBeGreaterThan(0);
  });
});

describe("§S5.2 — graceful-signal checkpoint (server checkpoints EVERY active cycle, all plans, all projects, on SIGTERM/SIGINT before exit)", () => {
  // NOTE (RED phase, CR-CRU-024 §S5.2): a genuine OS-signal subprocess test
  // needs `startServer()` to be driveable against a CALLER-CHOSEN dbPath from
  // OUTSIDE the parent test process (spawn `bun src/server.ts` as a child,
  // send it SIGTERM, then reopen the SAME db file in-process). Today
  // src/server.ts's `if (import.meta.main)` boot path calls `startServer()`
  // with NO arguments — only `CRUCIBLE_PORT`/`CRUCIBLE_HOST` env vars are
  // read; there is no dbPath override (env or CLI). Spawning the real
  // module as-is would default to the real "data/crucible.db" relative to
  // whatever cwd the child inherits — unsafe (it risks touching this
  // project's live dev database) and not deterministic across sandboxes.
  // Adding that override is production wiring, which the RED agent must not
  // write. Per the dispatch brief's explicit fallback, this test PINS THE
  // SHUTDOWN-HOOK FUNCTION DIRECTLY: `store.checkpointAllActive()` is the
  // store-wide fold GREEN's SIGTERM/SIGINT handler (in src/server.ts) must
  // invoke on every active cycle, across every plan, across every project,
  // before the process exits. `ServerHandle.store` is already a public field
  // (see src/server.ts), so this calls it directly in-process instead of via
  // a real signal — the exact call the signal handler is required to make.
  test("checkpointAllActive() folds the live epoch of EVERY active cycle across ALL projects/plans in one call — the exact call the SIGTERM/SIGINT hook must make before exit — so a fresh store reopen resumes each cycle exactly", async () => {
    const dbPath = freshTmpDbPath();
    const server1 = boot(dbPath);

    // Two DIFFERENT projects, each with its own active cycle — proves the
    // fold is process-wide ("all plans, all projects"), not project-scoped
    // (that narrower shape is §S5.3's project stop, tested separately below).
    const keyA = await createProject(server1);
    const keyB = await createProject(server1);
    const { planId: planA, cycleId: cycleA } = await fileSingleCycle(server1, keyA, "CR-SIGTERM-A");
    const { planId: planB, cycleId: cycleB } = await fileSingleCycle(server1, keyB, "CR-SIGTERM-B");

    setSystemTime(T0);
    await activate(server1, keyA, planA, cycleA);
    await activate(server1, keyB, planB, cycleB);

    setSystemTime(T0 + THREE_MIN_MS);
    // Simulate the SIGTERM/SIGINT handler firing HERE, immediately before
    // the process would exit — no intervening reads, so any persisted value
    // can only have come from this call.
    const checkpointed = server1.store.checkpointAllActive();
    expect(checkpointed).toBe(2);

    server1.stop();
    setSystemTime(T0 + THREE_MIN_MS + TWO_HOURS_MS);
    const server2 = boot(dbPath);

    const resumedA = await getCycle(server2, keyA, "CR-SIGTERM-A");
    const resumedB = await getCycle(server2, keyB, "CR-SIGTERM-B");
    expect(resumedA.status).toBe("active");
    expect(resumedB.status).toBe("active");
    expect(resumedA.activeMs).toBe(THREE_MIN_MS);
    expect(resumedB.activeMs).toBe(THREE_MIN_MS);
  });

  test("checkpointAllActive() with no active cycles anywhere returns 0 and touches nothing", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    await fileSingleCycle(handle, key, "CR-SIGTERM-NONE"); // stays pending

    const checkpointed = handle.store.checkpointAllActive();
    expect(checkpointed).toBe(0);
  });
});

describe("§S5.3 — project stop: POST /api/v2/projects/<key>/stop", () => {
  test("two open plans each holding an active mid-epoch cycle: stop checkpoints both — 200 {ok:true, checkpointed:2}; store-reopen resumes both exactly", async () => {
    const dbPath = freshTmpDbPath();
    const server1 = boot(dbPath);
    const key = await createProject(server1);

    const { planId: planA, cycleId: cycleA } = await fileSingleCycle(server1, key, "CR-STOP-A");
    const { planId: planB, cycleId: cycleB } = await fileSingleCycle(server1, key, "CR-STOP-B");

    setSystemTime(T0);
    await activate(server1, key, planA, cycleA);
    await activate(server1, key, planB, cycleB);

    setSystemTime(T0 + THREE_MIN_MS);
    const res = await postJson(server1, projectPath(key, "/stop"), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checkpointed: number };
    expect(body).toEqual({ ok: true, checkpointed: 2 });

    server1.stop();
    setSystemTime(T0 + THREE_MIN_MS + TWO_HOURS_MS);
    const server2 = boot(dbPath);

    const resumedA = await getCycle(server2, key, "CR-STOP-A");
    const resumedB = await getCycle(server2, key, "CR-STOP-B");
    expect(resumedA.activeMs).toBe(THREE_MIN_MS);
    expect(resumedB.activeMs).toBe(THREE_MIN_MS);
  });

  test("no active cycles in the project: stop is a no-op — 200 {ok:true, checkpointed:0}", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    await fileSingleCycle(handle, key, "CR-STOP-NONE"); // stays pending

    const res = await postJson(handle, projectPath(key, "/stop"), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checkpointed: number };
    expect(body).toEqual({ ok: true, checkpointed: 0 });
  });
});
