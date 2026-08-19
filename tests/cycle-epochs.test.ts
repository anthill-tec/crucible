// CR-CRU-023 §S3 (a) — Active-timer restart semantics, "resume from the old
// setpoint": accumulate active time in server-up epochs (persist
// accumulated `activeMs` per active cycle; on service restart resume the
// count, excluding downtime). This file pins the SERVER/STORE side of that
// contract (cycle 22, RED):
//
//   1. An ACTIVE cycle's plans-GET payload carries an additive `activeMs`
//      (accumulated attention time). Within one server session it grows
//      with wall-clock: activeMs === now - activatedAt while there has been
//      no restart in the cycle's lifetime.
//   2. A SIMULATED SERVICE RESTART — a fresh Store constructed over the
//      SAME on-disk db file (same "store reopen" technique as
//      tests/boot-safety.test.ts's `Store.open(dbPath)`) — resumes the
//      accumulated value EXCLUDING any downtime gap. A naive
//      `now - activatedAt` implementation (ignoring the restart) would read
//      the full wall-clock-including-downtime span; this pins that GREEN
//      must NOT do that.
//   3. Sealed (done) cycles are UNCHANGED by this feature — their
//      `doneAt - activatedAt` span stays exactly as before.
//   4. Only LEGAL transitions are exercised (pending->active->done,
//      pending->skipped) — the store's transition table already forbids
//      reactivating a done cycle, so that path is not pinned here.
//
// Drives the REAL production server (startServer), same harness pattern as
// tests/plans.test.ts. `setSystemTime()` (bun:test) mocks `Date.now()`
// process-wide — including inside the in-process Bun.serve handler — so it
// deterministically controls both the server's activatedAt stamps and its
// activeMs computation; no real wall-clock waits are needed for the
// server-side pins (unlike the UI ticking pins in tests/cycle-timers.test.ts).

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
  // CR-CRU-023 §S3 (a) — additive: accumulated attention time in ms,
  // present once a cycle has ever been activated.
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
  // tests/boot-safety.test.ts's freshTmpDir()).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-epochs-test-"));
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
// (plan-file, cycle transitions) now refuses an unregistered caller (409) —
// merge a live-registered `agentId` into any JSON body that doesn't already
// declare one.
function withFixtureAgent(body: unknown): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
  }
  return body;
}

async function registerOrchestrator(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await fetch(`http://localhost:${handle.server.port}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
  });
  expect(res.status).toBe(200);
}

// This file drives `setSystemTime()` heavily (including multi-hour forward
// jumps to simulate downtime) — the fixture orchestrator registered at REAL
// wall-clock time would otherwise fall outside its lazy-prune liveness
// window the instant the mocked clock jumps ahead, spuriously 409ing every
// workflow verb that follows a time jump. Re-touch (re-register) it against
// the CURRENT (possibly mocked) clock immediately before every mutating
// call, keyed off the projectKey embedded in the request path.
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
  const res = await postJson(handle, "/api/v2/projects", { name: `epochs-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
  await registerOrchestrator(handle, body.project.key, "fixture-orch");
  return body.project.key;
}

function plansPath(key: string, suffix = ""): string {
  return `/api/v2/projects/${key}/plans${suffix}`;
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

// A fixed epoch anchor — arbitrary but constant, same convention as
// tests/cycle-timers.test.ts's ACTIVATED_AT.
const T0 = 1_800_000_000_000;

describe("§S3 (a) — active cycle's plans-GET payload carries additive activeMs (server/store, cycle 22)", () => {
  test("a pending cycle carries NO activeMs field (never a fabricated value pre-activation)", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    await fileSingleCycle(handle, key, "CR-EPOCH-PENDING");

    const cycle = await getCycle(handle, key, "CR-EPOCH-PENDING");
    expect(cycle.status).toBe("pending");
    expect(cycle.activeMs).toBeUndefined();
  });

  test("an active cycle: activeMs is 0 at the instant of activation, then grows with wall-clock within the SAME server session (no restart)", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, cycleId } = await fileSingleCycle(handle, key, "CR-EPOCH-GROW");

    setSystemTime(T0);
    const patched = await patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), {
      status: "active",
    });
    expect(patched.status).toBe(200);

    const atActivation = await getCycle(handle, key, "CR-EPOCH-GROW");
    expect(atActivation.status).toBe("active");
    expect(atActivation.activatedAt).toBe(T0);
    expect(atActivation.activeMs).toBe(0);

    // 5m03s later, SAME server process — pure wall-clock growth, no restart.
    setSystemTime(T0 + 303_000);
    const later = await getCycle(handle, key, "CR-EPOCH-GROW");
    expect(later.activeMs).toBe(303_000);

    // Sanity: with zero downtime/restart in this cycle's lifetime, activeMs
    // equals the plain wall-clock elapsed exactly (the "epoch" formula
    // collapses to `now - activatedAt` when there has been no restart).
    expect(later.activeMs).toBe(T0 + 303_000 - (later.activatedAt as number));
  });
});

describe("§S3 (a) — SIMULATED SERVICE RESTART: activeMs resumes from the persisted accumulated value, excluding downtime", () => {
  test("a cycle activated, then a restart with ZERO elapsed time before the crash (only the activation checkpoint exists): resumed activeMs stays near-zero across a 2-HOUR downtime gap — never wall-clock-since-activatedAt", async () => {
    const dbPath = freshTmpDbPath();

    const server1 = boot(dbPath);
    const key = await createProject(server1);
    const { planId, cycleId } = await fileSingleCycle(server1, key, "CR-EPOCH-RESTART-1");

    setSystemTime(T0);
    const patched = await patchJson(server1, plansPath(key, `/${planId}/cycles/${cycleId}`), {
      status: "active",
    });
    expect(patched.status).toBe(200);

    // "Crash" — stop the process WITHOUT any further elapsed time or writes
    // beyond the activation checkpoint itself.
    server1.stop();

    // Downtime: 2 real-world hours pass with nothing running.
    const restartAt = T0 + 2 * 60 * 60 * 1000;
    setSystemTime(restartAt);

    // Simulated restart: a NEW Store constructed over the SAME on-disk db
    // file (same "store reopen" technique as tests/boot-safety.test.ts).
    const server2 = boot(dbPath);
    const resumed = await getCycle(server2, key, "CR-EPOCH-RESTART-1");

    expect(resumed.status).toBe("active");
    expect(resumed.activatedAt).toBe(T0);
    expect(resumed.activeMs).toBeDefined();

    const wallClockSinceActivation = restartAt - T0; // 2h == 7_200_000ms
    // The CORE option-(a) contract: resumed activeMs excludes the 2h
    // downtime gap. A naive `now - activatedAt` implementation (ignoring
    // restart) would read ~7_200_000ms here — this must NOT.
    expect(resumed.activeMs as number).toBeLessThan(wallClockSinceActivation);
    // Tight bound: with only the activation checkpoint (accumulated=0) ever
    // persisted and zero elapsed time before the crash, the resumed value —
    // read essentially at the moment of restart — must be small (well under
    // a minute), not scaled to the downtime.
    expect(resumed.activeMs as number).toBeLessThan(60_000);
    expect(resumed.activeMs as number).toBeGreaterThanOrEqual(0);
  });

  test("a cycle with 3 minutes of live accumulation before a mid-epoch crash: resumed activeMs honors the CHECKPOINT CADENCE contract (>=120_000ms, <=180_000ms) — a hard crash loses AT MOST one <=60s checkpoint window, never the full epoch and never scaled to downtime", async () => {
    const dbPath = freshTmpDbPath();

    const server1 = boot(dbPath);
    const key = await createProject(server1);
    const { planId, cycleId } = await fileSingleCycle(server1, key, "CR-EPOCH-RESTART-2");

    setSystemTime(T0);
    await patchJson(server1, plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });

    // Live accumulation, SAME server session, BEFORE the crash: 3 minutes
    // (180_000ms). This GET at the 3-minute mark doubles as the fixture's
    // CHECKPOINT-DRIVE POINT: per CR-CRU-023 §S3 (a) the store MUST durably
    // persist `active_ms_accumulated` for an ACTIVE cycle at a cadence
    // <=60s — via a periodic interval and/or by piggybacking a checkpoint
    // write onto cycle-linked reads/ingest (e.g. this plans-GET). This
    // fixture cannot drive a real `setInterval`-based checkpoint directly:
    // `setSystemTime()` mocks `Date.now()` process-wide but does NOT
    // advance real wall-clock timers, so a 3-minute jump via setSystemTime
    // never fires a real 60s interval callback in-process. Driving a
    // plans-GET at the exact 3-minute mark is therefore the SAFE, mechanism
    // -agnostic way to pin the contract: it exercises a checkpoint write
    // regardless of whether GREEN implements it as an interval, or as a
    // synchronous checkpoint inside toPlan/plans-GET/ingest.
    const crashAt = T0 + 3 * 60 * 1000;
    setSystemTime(crashAt);
    const preCrash = await getCycle(server1, key, "CR-EPOCH-RESTART-2");
    expect(preCrash.activeMs).toBe(3 * 60 * 1000);

    // "Crash" — the process goes down immediately after that driven
    // checkpoint, with whatever was durably persisted up to this point.
    server1.stop();

    // Downtime: another 2 hours.
    const restartAt = crashAt + 2 * 60 * 60 * 1000;
    setSystemTime(restartAt);

    const server2 = boot(dbPath);
    const resumed = await getCycle(server2, key, "CR-EPOCH-RESTART-2");

    const wallClockIncludingDowntime = restartAt - T0; // ~2h03m
    expect(resumed.status).toBe("active");
    // CHECKPOINT CADENCE CONTRACT (recorded decision, not an accident): a
    // hard crash while ACTIVE may lose AT MOST one <=60s checkpoint window
    // of attention time. With 3 minutes (180_000ms) of live accumulation up
    // to the driven checkpoint immediately before the crash, resumed
    // activeMs MUST land in [180_000 - 60_000, 180_000] == [120_000, 180_000]:
    //   - >= 120_000 rules out the crash-loses-everything defect (current
    //     production resumes ~0, because active_ms_accumulated is only ever
    //     persisted on the transition OUT of `active` — a crash while still
    //     ACTIVE never writes the accumulated attention time at all).
    //   - <= 180_000 (with the downtime-exclusion check below) rules out the
    //     naive `now - activatedAt` defect that would scale with downtime.
    expect(resumed.activeMs as number).toBeGreaterThanOrEqual(120_000);
    expect(resumed.activeMs as number).toBeLessThanOrEqual(180_000);
    // Downtime EXCLUDED: resumed activeMs is nowhere near the full
    // wall-clock-including-downtime span — a naive `now - activatedAt`
    // implementation would read ~2h03m (7_380_000ms) here.
    expect(resumed.activeMs as number).toBeLessThan(wallClockIncludingDowntime);
  });
});

describe("§S3 (a) — sealed (done) cycles and never-activated cycles are UNCHANGED by the epochs feature", () => {
  test("a DONE cycle's sealed span is still exactly doneAt - activatedAt, coexisting with the epochs feature", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, cycleId } = await fileSingleCycle(handle, key, "CR-EPOCH-SEALED");

    setSystemTime(T0);
    await patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });

    setSystemTime(T0 + 760_000); // 12m40s later
    const donePatch = await patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), {
      status: "done",
    });
    expect(donePatch.status).toBe(200);

    // Sample well after doneAt — the sealed span must not drift with the
    // wall clock (nor with the epochs feature).
    setSystemTime(T0 + 760_000 + 5_000_000);
    const sealed = await getCycle(handle, key, "CR-EPOCH-SEALED");

    expect(sealed.status).toBe("done");
    expect(sealed.activatedAt).toBe(T0);
    expect(sealed.doneAt).toBe(T0 + 760_000);
    expect((sealed.doneAt as number) - (sealed.activatedAt as number)).toBe(760_000);
  });

  test("a pending cycle that transitions straight to skipped (never activated, the one legal pending shortcut) has NO activeMs and NO activatedAt", async () => {
    const handle = boot(":memory:");
    const key = await createProject(handle);
    const { planId, cycleId } = await fileSingleCycle(handle, key, "CR-EPOCH-SKIPPED");

    const skipped = await patchJson(handle, plansPath(key, `/${planId}/cycles/${cycleId}`), {
      status: "skipped",
    });
    expect(skipped.status).toBe(200);

    const cycle = await getCycle(handle, key, "CR-EPOCH-SKIPPED");
    expect(cycle.status).toBe("skipped");
    expect(cycle.activatedAt).toBeUndefined();
    expect(cycle.activeMs).toBeUndefined();
  });
});
