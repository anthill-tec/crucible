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

async function postJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, urlPath: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`);
}

async function createProject(handle: ServerHandle): Promise<string> {
  const res = await postJson(handle, "/api/v2/projects", { name: `epochs-${crypto.randomUUID()}` });
  const body = (await res.json()) as { ok: true; project: { key: string } };
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

  test("a cycle with SOME live accumulation before a mid-epoch crash: after restart+downtime, resumed activeMs stays BOUNDED (>= 0, strictly < the full wall-clock-including-downtime span) — downtime is excluded regardless of exact checkpoint cadence", async () => {
    const dbPath = freshTmpDbPath();

    const server1 = boot(dbPath);
    const key = await createProject(server1);
    const { planId, cycleId } = await fileSingleCycle(server1, key, "CR-EPOCH-RESTART-2");

    setSystemTime(T0);
    await patchJson(server1, plansPath(key, `/${planId}/cycles/${cycleId}`), { status: "active" });

    // Live accumulation, SAME server session, BEFORE the crash: 3 minutes.
    const crashAt = T0 + 3 * 60 * 1000;
    setSystemTime(crashAt);
    const preCrash = await getCycle(server1, key, "CR-EPOCH-RESTART-2");
    expect(preCrash.activeMs).toBe(3 * 60 * 1000);

    // "Crash" — the process goes down with whatever was durably persisted up
    // to this point. This test does NOT assume a specific checkpoint cadence
    // beyond the activation write (per the gap-analysis finding below).
    server1.stop();

    // Downtime: another 2 hours.
    const restartAt = crashAt + 2 * 60 * 60 * 1000;
    setSystemTime(restartAt);

    const server2 = boot(dbPath);
    const resumed = await getCycle(server2, key, "CR-EPOCH-RESTART-2");

    const wallClockIncludingDowntime = restartAt - T0; // ~2h03m
    expect(resumed.status).toBe("active");
    expect(resumed.activeMs as number).toBeGreaterThanOrEqual(0);
    // Downtime EXCLUDED: resumed activeMs is nowhere near the full
    // wall-clock-including-downtime span — a naive `now - activatedAt`
    // implementation would read ~2h03m (7_380_000ms) here.
    expect(resumed.activeMs as number).toBeLessThan(wallClockIncludingDowntime);
    expect(resumed.activeMs as number).toBeLessThan(10 * 60 * 1000); // well under 10 minutes, vs ~2h03m of naive wall-clock.
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
