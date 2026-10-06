// CR-CRU-157 §S3/G5/R1 (C3) — "idle is the board's word": an agent with no
// OPEN run reads a composed idle line at GET /api/v2/agents read time — role,
// bound cycle, and the last run's outcome-or-refusal with its age — instead
// of whatever its message happened to be left at; an agent that DOES still
// have an open run keeps reading its own client heartbeat message, untouched.
//
// R1 (user ruling, cited in the CR's Gap analysis): "the server derives idle
// and composes the line." This file names the exact wire contract that
// ruling needs, since neither existed before this CR:
//
//   - a NEW, additive field on the GET /api/v2/agents payload — `idleLine`
//     — PRESENT only when the agent has no open run (the same absence
//     convention `boundCycleId`/`role` already use: never fabricated, never
//     null, just absent), so the raw `message` this CR's companion file
//     (tests/ingest-outcome-overwrites-agent-message.test.ts) pins is never
//     lost or overwritten by the derived view;
//   - its exact text, taken from storyboard F19's own states 5′/5 (the
//     `· ` middle-dot separator between segments, `, ` between the last-run
//     outcome and its age):
//       `idle · <ROLE> · cycle <cycleId> · last run <message>, <age>`
//     where `<message>` is exactly the text this CR's §S2 fix just wrote
//     onto the agent (so a 2936 ✓ 0 ✗ · ingested outcome or an `ingest
//     refused — …` refusal both carry through unchanged into the idle
//     line's own `last run` segment), and `<age>` is this codebase's one
//     existing relative-time convention (`relativeTime` in
//     public/app-logic.mjs: "just now" under 10s, else `Ns/Nm/Nh/Nd ago`) —
//     asserted below with a tolerant tail pattern rather than a guessed
//     exact duration, since the real elapsed time between actions in a test
//     process is not controllable to the second.
//
// Harness: the real production HTTP surface (`startServer`), the same
// register/plan/cycle + runs/start/parsed sequence as this file's §S2
// sibling — no new mechanism.
//
// RED phase: `idleLine` does not exist on the agent payload at all today, so
// every `.idleLine` assertion below is undefined — both tests fail.
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

/** This codebase's one existing relative-age convention (`relativeTime`,
 * public/app-logic.mjs): "just now" under 10s, else `Ns`/`Nm`/`Nh`/`Nd ago`. */
const AGE_TAIL = /(just now|\d+[smhd] ago)$/;

describe("CR-CRU-157 §S3/R1 — idle is derived on the server, at GET /api/v2/agents read time", () => {
  test("an agent whose accepted ingest just closed its run reads a composed idle line — `idle · <role> · cycle <id> · last run <outcome>, <age>` — carrying the SAME outcome text §S2 just wrote onto its message", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { cycleId } = await fileAndActivateCycle(handle, key, "idle-line-bound-outcome");
    const agentId = "green-idle-bound";
    await registerBound(handle, key, agentId, cycleId);
    const started = await startRun(handle, key, agentId, { context: { cycleId } });

    const res = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId,
      runId: started.runId,
      summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 12 },
      tree: [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 12 }] }],
    });
    expect(res.status).toBe(200);

    const agent = await agentByIdFrom(handle, key, agentId);
    expect(agent).toBeDefined();
    // The §S2 sibling's own contract: the message this idle line must carry.
    expect(agent!.message).toBe("5 ✓ 0 ✗ · ingested");
    expect(agent!.idleLine).toBeDefined();
    // POSITIVE — role, the EXACT bound cycle id, the EXACT outcome text, and
    // a well-formed age tail, in the separators F19's states 5/5′ use.
    expect(agent!.idleLine).toMatch(
      new RegExp(`^idle · GREEN · cycle ${cycleId} · last run 5 ✓ 0 ✗ · ingested, `),
    );
    expect(agent!.idleLine).toMatch(AGE_TAIL);
    // NEGATIVE bound — composing the line must never invent a DIFFERENT
    // cycle id or role than the ones actually stored.
    expect(agent!.idleLine).not.toContain("plan ");
    expect(agent!.idleLine).not.toContain("no cycle bound");
  });

  test("an agent with an OPEN run (its last heartbeat posted mid-run) carries NO idle line — GET /api/v2/agents reads its raw client message, unchanged, exactly as §S3 requires while a run is in flight", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { cycleId } = await fileAndActivateCycle(handle, key, "idle-line-open-run");
    const agentId = "green-idle-open";
    await registerBound(handle, key, agentId, cycleId);
    // This agent's FIRST run: accepted and closed, so a real idle line would
    // otherwise be derivable — proving the open-run check below is a real
    // gate, not just "no prior outcome to compose from".
    const firstRun = await startRun(handle, key, agentId, { context: { cycleId } });
    const firstIngest = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId,
      runId: firstRun.runId,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 3 },
      tree: [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 3 }] }],
    });
    expect(firstIngest.status).toBe(200);
    const idleAgent = await agentByIdFrom(handle, key, agentId);
    expect(idleAgent!.idleLine).toBeDefined();

    // A SECOND run opens — the agent is no longer idle.
    await startRun(handle, key, agentId, { context: { cycleId } });
    const heartbeat = await postJson(handle, "/api/v2/agents/heartbeat", {
      projectKey: key,
      agentId,
      message: "running 7/10",
    });
    expect(heartbeat.status).toBe(200);

    const agent = await agentByIdFrom(handle, key, agentId);
    expect(agent).toBeDefined();
    // POSITIVE — the raw heartbeat, verbatim.
    expect(agent!.message).toBe("running 7/10");
    // NEGATIVE bound — the idle line from the FIRST (now stale) idle window
    // must not still be served once a new run reopens it.
    expect(agent!.idleLine).toBeUndefined();
  });
});
