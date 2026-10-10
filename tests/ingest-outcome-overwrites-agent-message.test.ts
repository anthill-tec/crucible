// CR-CRU-157 §S2 (C3) — "the message follows the run to its end": after the
// tests finish, the SERVER — not the client — writes what happened onto the
// agent's record. Today `recordTestEvent` calls `Store#touchAgent` with no
// `message` option, so `touchAgent`'s PRESERVE-on-update path (see its own
// doc comment) leaves whatever the client's last heartbeat said — typically
// the `ingesting…` the narrator posts right before the ingest — in place
// forever, through a RED (refused) or a GREEN (accepted) outcome alike.
//
// These two tests pin the fix at the ONE place that can prove it: a plain
// `GET /api/v2/agents` read, driven through the real production HTTP surface
// (`startServer`), exactly like tests/agent-cycle-binding.test.ts drives
// register/plan/cycle routes and tests/run-lifecycle-read-surface.test.ts
// drives `/runs/start` + `/runs/parsed`. No mechanism here is new: this file
// composes the SAME two existing helpers (a fixture ORCHESTRATOR files and
// activates a one-cycle plan; a TDD role registers bound to it) with the
// run-lifecycle start/close sequence those files already exercise.
//
// RED phase: `touchAgent`'s PRESERVE path makes BOTH assertions below false
// today — the agent's `message` stays the pre-ingest heartbeat text in both
// the accepted and the refused case.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return fetch(`${base(handle)}${route}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function seedProject(handle: ServerHandle): string {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
  return key;
}

interface AgentBrief {
  agentId: string;
  message: string;
  idleLine?: string;
  [key: string]: unknown;
}

async function agentByIdFrom(
  handle: ServerHandle,
  key: string,
  agentId: string,
): Promise<AgentBrief | undefined> {
  const body = await getJson(handle, `/api/v2/agents?project=${key}`);
  const agents = body.agents as AgentBrief[];
  return agents.find((a) => a.agentId === agentId);
}

const FIXTURE_ORCH = "fixture-orch";

/** Files a one-cycle plan and activates it, the same real-route pattern
 * tests/agent-cycle-binding.test.ts's `fileAndActivate` uses. */
async function fileAndActivateCycle(
  handle: ServerHandle,
  key: string,
  cr: string,
): Promise<{ planId: number; cycleId: number }> {
  const reg = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId: FIXTURE_ORCH,
    role: "ORCHESTRATOR",
  });
  expect(reg.status).toBe(200);
  const filed = await postJson(handle, `/api/v2/projects/${key}/plans`, {
    cr,
    agentId: FIXTURE_ORCH,
    cycles: [{ label: "solo" }],
  });
  expect(filed.status).toBe(201);
  const plan = (await filed.json()) as { planId: number; cycles: { id: number }[] };
  const cycleId = plan.cycles[0]!.id;
  const activated = await patchJson(
    handle,
    `/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`,
    { status: "active", agentId: FIXTURE_ORCH },
  );
  expect(activated.status).toBe(200);
  return { planId: plan.planId, cycleId };
}

async function transitionCycle(
  handle: ServerHandle,
  key: string,
  planId: number,
  cycleId: number,
  status: string,
): Promise<void> {
  const res = await patchJson(
    handle,
    `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`,
    { status, agentId: FIXTURE_ORCH },
  );
  expect(res.status).toBe(200);
}

async function registerBound(
  handle: ServerHandle,
  key: string,
  agentId: string,
  cycleId: number,
): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "GREEN",
    cycleId,
  });
  expect(res.status).toBe(200);
}

async function startRun(
  handle: ServerHandle,
  key: string,
  agentId: string,
  extra: Record<string, unknown> = {},
): Promise<{ runId: string; startedAt: number }> {
  const res = await postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId, ...extra });
  expect(res.status).toBe(202);
  return (await res.json()) as { runId: string; startedAt: number };
}

describe("CR-CRU-157 §S2 — an ingest's outcome or refusal overwrites the agent's heartbeat message", () => {
  test("an ACCEPTED ingest overwrites the agent's message with the exact pass/fail tally and 'ingested', not the 'ingesting…' heartbeat it replaces", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { cycleId } = await fileAndActivateCycle(handle, key, "ingest-outcome-accept");
    const agentId = "green-outcome-accept";
    await registerBound(handle, key, agentId, cycleId);
    const started = await startRun(handle, key, agentId, { context: { cycleId } });
    const heartbeat = await postJson(handle, "/api/v2/agents/heartbeat", {
      projectKey: key,
      agentId,
      message: "ingesting…",
    });
    expect(heartbeat.status).toBe(200);

    const res = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId,
      runId: started.runId,
      summary: { total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 42 },
      tree: [
        {
          name: "suite",
          status: "fail",
          children: [
            { name: "t1", status: "pass", duration_ms: 10 },
            { name: "t2", status: "pass", duration_ms: 10 },
            { name: "t3", status: "fail", duration_ms: 22 },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    const agent = await agentByIdFrom(handle, key, agentId);
    expect(agent).toBeDefined();
    // POSITIVE — the exact tally the spec's own example names the shape of
    // (`2936 ✓ 0 ✗ · ingested`), server-composed from the stored summary,
    // never left at whatever the client's last heartbeat said.
    expect(agent!.message).toBe("2 ✓ 1 ✗ · ingested");
    // NEGATIVE — the pre-ingest heartbeat's own wording is gone.
    expect(agent!.message).not.toContain("ingesting");
  });

  test("a REFUSED ingest (the agent's bound cycle went DONE while its run was open) overwrites the agent's message with the refusal, not the 'ingesting…' heartbeat it replaces", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { planId, cycleId } = await fileAndActivateCycle(handle, key, "ingest-outcome-refuse");
    const agentId = "green-outcome-refuse";
    await registerBound(handle, key, agentId, cycleId);
    const started = await startRun(handle, key, agentId, { context: { cycleId } });
    const heartbeat = await postJson(handle, "/api/v2/agents/heartbeat", {
      projectKey: key,
      agentId,
      message: "ingesting…",
    });
    expect(heartbeat.status).toBe(200);

    // The bound cycle completes out from under the in-flight run — the exact
    // `resolveIngestAttach` stale-binding path the spec's own example
    // (`ingest refused — cycle 546 is done`) illustrates.
    await transitionCycle(handle, key, planId, cycleId, "done");

    const res = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId,
      runId: started.runId,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
      tree: [{ name: "suite", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] }],
    });
    expect(res.status).toBe(409);
    const errBody = (await res.json()) as { ok: boolean };
    expect(errBody.ok).toBe(false);

    const agent = await agentByIdFrom(handle, key, agentId);
    expect(agent).toBeDefined();
    // POSITIVE — the refusal, in the spec's own wording shape.
    expect(agent!.message).toBe(`ingest refused — cycle ${cycleId} is done`);
    // NEGATIVE — the pre-refusal heartbeat's own wording is gone; a refused
    // ingest must never leave the card reading a stale "ingesting…" (the
    // defect the Problem section describes).
    expect(agent!.message).not.toContain("ingesting");
  });
});
