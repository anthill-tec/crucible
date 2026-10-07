// The server accepts a client's abort of its own open run.
//
// Lineage: CR-CRU-017 §S2 designed `POST /api/v2/runs/<runId>/abort {reason}`
// and never built it — `handleV2` (src/v2.ts) routes /runs, /runs/start,
// /runs/parsed and /runs/compile and nothing else under /runs, so every call
// below 404s today ("unknown route: POST /api/v2/runs/<id>/abort", the
// catch-all in src/server.ts). This suite is written against the contract the
// spec and its lineage pin:
//
//   POST /api/v2/runs/<runId>/abort {projectKey, agentId, reason}
//     -> 2xx {ok:true, …}, settling the run by the SAME store path the
//        server's own auto-abort (`Store.abortRun`, driven by
//        `Store#sweepOpenRuns`) uses: one transaction writes the run row
//        (`state:"aborted"`, `abortReason`, `settledAt`) and ONE
//        `status:"aborted"` event carrying that `abortReason`, so the
//        timeline/live-stream read surface (`GET /api/v2/events`, pinned by
//        tests/run-lifecycle-read-surface.test.ts) shows it exactly as it
//        shows an agent-died/abandoned run, and `Store#onChange("events", …)`
//        fires for it.
//   Refused, with NOTHING changed (run row untouched, no event stored):
//     an unregistered caller, an unknown runId, a run another agent opened,
//     a run of another project, a run already filed (409) or already
//     aborted (409 — whether by a prior self-abort or by the sweep), and an
//     empty/missing reason.
//
// REAL TIMERS, DELIBERATELY: the sweep-aborted fixture's trigger (an agent
// tombstone) is wall-clock liveness, same exception tests/run-lifecycle.test.ts
// documents. The delay used is the smallest that reliably clears the
// configured tombstone deadline.
//
// SAFETY: every server binds port 0 (never the dog-food 3849/3850) and every
// store is ":memory:" — `data/crucible.db` is never opened.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { shippedLimits } from "../src/limits.ts";
import {
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
} from "./helpers/server-limits-fixture.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  restoreServerLimitsFixture();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function baseOf(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return fetch(`${baseOf(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseOf(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface LivenessOverride {
  staleAfterMs: number;
  tombstoneAfterMs: number;
  pruneAfterMs: number;
}

function seedProject(handle: ServerHandle, liveness?: LivenessOverride): string {
  const key = crypto.randomUUID();
  handle.store.addProject({
    key,
    name: "P",
    type: "backend",
    sutRoot: "/tmp/p",
    ...(liveness !== undefined ? { liveness } : {}),
  });
  return key;
}

// ORCHESTRATOR — the same exempt-role choice tests/run-lifecycle.test.ts
// makes: a bound TDD role is orthogonal to run-abort, and this keeps every
// fixture about the abort route and nothing else.
async function register(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
}

async function startRun(
  handle: ServerHandle,
  key: string,
  agentId: string,
): Promise<{ runId: string; startedAt: number }> {
  const res = await postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId });
  expect(res.status).toBe(202);
  return (await res.json()) as { runId: string; startedAt: number };
}

async function abortRun(
  handle: ServerHandle,
  runId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return postJson(handle, `/api/v2/runs/${runId}/abort`, body);
}

const PARSED_RUN = {
  summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 7 },
  tree: [
    { name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 7 }] },
  ],
};

/** The run (test/compile) events in a project — lifecycle (register/unregister) excluded. */
function runEvents(handle: ServerHandle, key: string): Record<string, unknown>[] {
  return handle.store
    .listEvents(key, 200)
    .filter((e) => e.kind !== "lifecycle") as unknown as Record<string, unknown>[];
}

function abortedEvents(handle: ServerHandle, key: string): Record<string, unknown>[] {
  return runEvents(handle, key).filter((e) => e.status === "aborted");
}

const openRunsOf = (body: Record<string, unknown>): unknown[] =>
  Array.isArray(body.openRuns) ? body.openRuns : [];

const eventsOf = (body: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : [];

const runEventsOf = (body: Record<string, unknown>): Record<string, unknown>[] =>
  eventsOf(body).filter((e) => e.kind !== "lifecycle");

/**
 * CR-CRU-131 §S1b — the abandon deadline is CONFIGURATION (the server's own
 * crucible.toml). Pushed far out below so the only trigger left that can
 * settle the sweep-aborted fixture's run is the agent's tombstone.
 */
function configureAbandonDeadline(ms: number): void {
  writeConfig(serverConfigDir(), {
    run_abandon_ms: declare(shippedLimits().run_abandon_ms!, ms, { min: ms }),
  });
}

/** Drive the real auto-abort sweep until it settles at least one run, or give up. */
async function sweepUntilAborted(
  handle: ServerHandle,
  budgetMs = 2_000,
): Promise<ReturnType<typeof handle.store.sweepOpenRuns>> {
  const deadline = Date.now() + budgetMs;
  do {
    const aborted = handle.store.sweepOpenRuns();
    if (aborted.length > 0) return aborted;
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v2/runs/<runId>/abort — the opening agent closes its own open run at once", () => {
  test("A aborts the run A opened, with a reason: 2xx; the run row is aborted with that reason and a settled time; exactly one status:aborted event carries the reason; the timeline read shows it like an auto-aborted run; and the store's change listener fires", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-a");
    const started = await startRun(handle, key, "abort-a");

    const changes: Array<["projects" | "agents" | "events", string | undefined]> = [];
    const unsubscribe = handle.store.onChange((kind, projectKey) => {
      changes.push([kind, projectKey]);
    });

    const res = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-a",
      reason: "fixture asked to stop",
    });
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const body: unknown = JSON.parse(text);
    expect(typeof body === "object" && body !== null && "ok" in body ? body.ok : undefined).toBe(
      true,
    );

    // The run row, read directly off the store (never re-derived from the
    // event): aborted, with the given reason, settled at a real timestamp.
    const run = handle.store.getRun(started.runId);
    expect(run?.state).toBe("aborted");
    expect(run?.abortReason).toBe("fixture asked to stop");
    expect(typeof run?.settledAt).toBe("number");

    // Exactly ONE status:"aborted" event, carrying the same reason.
    const aborted = abortedEvents(handle, key);
    expect(aborted.length).toBe(1);
    expect(aborted[0]?.abortReason).toBe("fixture asked to stop");
    expect(aborted[0]?.kind).toBe("test");
    unsubscribe();

    // The timeline/runs read (GET /api/v2/events) shows it exactly as it
    // shows an auto-aborted run: gone from openRuns, present in events with
    // status + abortReason, no residual open-run brief.
    const read = await getJson(handle, `/api/v2/events?project=${key}`);
    expect(openRunsOf(read)).toHaveLength(0);
    const briefs = runEventsOf(read);
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.status).toBe("aborted");
    expect(briefs[0]?.abortReason).toBe("fixture asked to stop");

    // The live stream's change listener fired for this project's events —
    // the same signal SSE subscribers (src/server.ts) ride.
    expect(changes).toContainEqual(["events", key]);
  });
});

describe("POST /api/v2/runs/<runId>/abort — refused, and NOTHING changes: the run row and the event count stay exactly as before", () => {
  test("an UNREGISTERED caller is refused (409); the run stays open and no event is stored", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-owner");
    const started = await startRun(handle, key, "abort-owner");

    const res = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "never-registered",
      reason: "should not land",
    });
    expect(res.status).toBe(409);

    const run = handle.store.getRun(started.runId);
    expect(run?.state).toBe("open");
    expect(run?.abortReason).toBeUndefined();
    expect(runEvents(handle, key)).toHaveLength(0);
  });

  test("an UNKNOWN runId is refused (400); no run row exists and nothing is stored", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-ghost");

    const res = await abortRun(handle, "run-never-issued-by-this-server", {
      projectKey: key,
      agentId: "abort-ghost",
      reason: "no such run",
    });
    expect(res.status).toBe(400);

    expect(handle.store.getRun("run-never-issued-by-this-server")).toBeNull();
    expect(runEvents(handle, key)).toHaveLength(0);
  });

  test("a run ANOTHER AGENT opened is refused (400); the owning agent's run stays open and untouched", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-owner-2");
    await register(handle, key, "abort-outsider");
    const started = await startRun(handle, key, "abort-owner-2");

    const res = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-outsider",
      reason: "not mine to abort",
    });
    expect(res.status).toBe(400);

    const run = handle.store.getRun(started.runId);
    expect(run?.state).toBe("open");
    expect(run?.agentId).toBe("abort-owner-2");
    expect(run?.abortReason).toBeUndefined();
    expect(runEvents(handle, key)).toHaveLength(0);
  });

  test("a run of ANOTHER PROJECT is refused (400) — isolated from the agent-identity check by reusing the SAME agentId, registered in both projects", async () => {
    const handle = boot();
    const home = seedProject(handle);
    const elsewhere = seedProject(handle);
    await register(handle, home, "cross-project-agent");
    await register(handle, elsewhere, "cross-project-agent");
    const started = await startRun(handle, home, "cross-project-agent");

    const res = await abortRun(handle, started.runId, {
      projectKey: elsewhere,
      agentId: "cross-project-agent",
      reason: "wrong project context",
    });
    expect(res.status).toBe(400);

    const run = handle.store.getRun(started.runId);
    expect(run?.state).toBe("open");
    expect(run?.projectKey).toBe(home);
    expect(run?.abortReason).toBeUndefined();
    expect(runEvents(handle, home)).toHaveLength(0);
    expect(runEvents(handle, elsewhere)).toHaveLength(0);
  });

  test("an EMPTY reason is refused (400); the run stays open and no event is stored", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-empty-reason");
    const started = await startRun(handle, key, "abort-empty-reason");

    const res = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-empty-reason",
      reason: "",
    });
    expect(res.status).toBe(400);

    const run = handle.store.getRun(started.runId);
    expect(run?.state).toBe("open");
    expect(run?.abortReason).toBeUndefined();
    expect(runEvents(handle, key)).toHaveLength(0);
  });

  test("a MISSING reason is refused (400); the run stays open and no event is stored", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-missing-reason");
    const started = await startRun(handle, key, "abort-missing-reason");

    const res = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-missing-reason",
    });
    expect(res.status).toBe(400);

    const run = handle.store.getRun(started.runId);
    expect(run?.state).toBe("open");
    expect(run?.abortReason).toBeUndefined();
    expect(runEvents(handle, key)).toHaveLength(0);
  });

  test("a run already FILED (closed by an ingest carrying its runId) is refused (409); the ended run row and its one event are byte-unchanged", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-filed");
    const started = await startRun(handle, key, "abort-filed");

    const ingest = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "abort-filed",
      runId: started.runId,
      ...PARSED_RUN,
    });
    expect(ingest.status).toBe(200);
    const runBefore = handle.store.getRun(started.runId);
    const eventsBefore = runEvents(handle, key);
    expect(runBefore?.state).toBe("ended");

    const res = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-filed",
      reason: "too late, already filed",
    });
    expect(res.status).toBe(409);

    const runAfter = handle.store.getRun(started.runId);
    expect(runAfter).toEqual(runBefore);
    expect(runAfter?.state).toBe("ended");
    expect(runAfter?.abortReason).toBeUndefined();
    const eventsAfter = runEvents(handle, key);
    expect(eventsAfter).toHaveLength(1);
    expect(eventsAfter).toEqual(eventsBefore);
    expect(abortedEvents(handle, key)).toHaveLength(0);
  });

  test("a run already ABORTED BY THE SWEEP (agent died) is refused (409); the sweep's own reason is kept, and no second event is stored", async () => {
    configureAbandonDeadline(3_600_000);
    const handle = boot();
    const key = seedProject(handle, {
      staleAfterMs: 5,
      tombstoneAfterMs: 10,
      pruneAfterMs: 3_600_000,
    });
    await register(handle, key, "abort-swept");
    const started = await startRun(handle, key, "abort-swept");

    await Bun.sleep(80);
    const swept = await sweepUntilAborted(handle);
    expect(swept.length).toBe(1);
    const runBefore = handle.store.getRun(started.runId);
    expect(runBefore?.state).toBe("aborted");
    expect(runBefore?.abortReason).toBe("agent died");
    const eventsBefore = runEvents(handle, key);
    expect(eventsBefore).toHaveLength(1);

    // Re-registering lets this request authenticate as a live caller again —
    // the refusal under test is the run's SETTLED state, not the caller.
    await register(handle, key, "abort-swept");
    const res = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-swept",
      reason: "I would rather it said this",
    });
    expect(res.status).toBe(409);

    const runAfter = handle.store.getRun(started.runId);
    expect(runAfter?.state).toBe("aborted");
    // The sweep's reason survives untouched — a later self-abort can never
    // overwrite WHY a settled run ended.
    expect(runAfter?.abortReason).toBe("agent died");
    const eventsAfter = runEvents(handle, key);
    expect(eventsAfter).toHaveLength(1);
    expect(eventsAfter).toEqual(eventsBefore);
  });
});

describe("POST /api/v2/runs/<runId>/abort — a SECOND abort after a successful one", () => {
  test("is refused, and stores no second event: the run keeps the FIRST reason, and exactly one status:aborted event exists", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "abort-twice");
    const started = await startRun(handle, key, "abort-twice");

    const first = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-twice",
      reason: "first and only reason that should stick",
    });
    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);

    const runAfterFirst = handle.store.getRun(started.runId);
    expect(runAfterFirst?.state).toBe("aborted");
    const eventsAfterFirst = runEvents(handle, key);
    expect(eventsAfterFirst).toHaveLength(1);

    const second = await abortRun(handle, started.runId, {
      projectKey: key,
      agentId: "abort-twice",
      reason: "a second, different reason",
    });
    expect(second.status).toBe(409);

    const runAfterSecond = handle.store.getRun(started.runId);
    expect(runAfterSecond?.state).toBe("aborted");
    expect(runAfterSecond?.abortReason).toBe("first and only reason that should stick");
    expect(runAfterSecond?.settledAt).toBe(runAfterFirst?.settledAt);
    const eventsAfterSecond = runEvents(handle, key);
    expect(eventsAfterSecond).toHaveLength(1);
    expect(eventsAfterSecond).toEqual(eventsAfterFirst);
    expect(abortedEvents(handle, key)).toHaveLength(1);
  });
});
