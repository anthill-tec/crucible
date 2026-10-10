// The compile ingest is a run ingest like any other: the SERVER, which records
// it or refuses it, writes what happened onto the agent's message. A client
// whose run ends in `POST /api/v2/runs/compile` (a suite that produced no
// report and fell back to ingesting its build output, or a `compile`/`check`
// verb) must never leave the card on the `ingesting…` its narrator posted just
// before — nor on the running count before that.
//
// Driven through the real production HTTP surface (`startServer`), the same
// register / plan / cycle / run-lifecycle routes the sibling ingest-outcome
// tests use. The outcome is written in the style of `ingestOutcome` (the
// tally the test-ingest routes write): `compile · <n> errors · ingested`,
// singular for one error.
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

async function agentById(
  handle: ServerHandle,
  key: string,
  agentId: string,
): Promise<AgentBrief | undefined> {
  const body = await getJson(handle, `/api/v2/agents?project=${key}`);
  return (body.agents as AgentBrief[]).find((a) => a.agentId === agentId);
}

async function openRunIds(handle: ServerHandle, key: string): Promise<string[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return (body.openRuns as { runId: string }[]).map((r) => r.runId);
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

async function startRun(handle: ServerHandle, key: string, agentId: string): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId });
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

async function sayIngesting(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/heartbeat", {
    projectKey: key,
    agentId,
    message: "ingesting…",
  });
  expect(res.status).toBe(200);
}

const TWO_TSC_ERRORS = [
  "src/a.ts(1,1): error TS2304: Cannot find name 'x'.",
  "src/b.ts(2,5): error TS2304: Cannot find name 'y'.",
].join("\n");

describe("a compile ingest writes its outcome or its refusal onto the agent", () => {
  test("an ACCEPTED compile ingest that closes the agent's run writes `compile · <n> errors · ingested`, and the idle line carries it", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { cycleId } = await fileAndActivateCycle(handle, key, "compile-outcome-accept");
    const agentId = "green-compile-accept";
    await registerBound(handle, key, agentId, cycleId);
    const runId = await startRun(handle, key, agentId);
    await sayIngesting(handle, key, agentId);

    const res = await postJson(handle, "/api/v2/runs/compile", {
      projectKey: key,
      agentId,
      runId,
      format: "tsc",
      errors: TWO_TSC_ERRORS,
    });
    expect(res.status).toBe(200);

    // The compile ingest CLOSED the run it carried …
    expect(await openRunIds(handle, key)).not.toContain(runId);
    const agent = await agentById(handle, key, agentId);
    expect(agent).toBeDefined();
    // … and the server wrote its outcome over the client's last heartbeat.
    expect(agent!.message).toBe("compile · 2 errors · ingested");
    expect(agent!.message).not.toContain("ingesting");
    // The idle line (no open run any more) reads the compile outcome as the
    // last run's result — never `last run ingesting…`.
    expect(agent!.idleLine).toBeDefined();
    expect(agent!.idleLine).toContain("last run compile · 2 errors · ingested, ");
    expect(agent!.idleLine).not.toContain("ingesting…");
  });

  test("a clean compile reads `compile · 0 errors · ingested`; a single error reads `1 error`", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { cycleId } = await fileAndActivateCycle(handle, key, "compile-outcome-counts");
    const agentId = "green-compile-counts";
    await registerBound(handle, key, agentId, cycleId);

    const clean = await postJson(handle, "/api/v2/runs/compile", {
      projectKey: key,
      agentId,
      format: "tsc",
      errors: "no diagnostics",
    });
    expect(clean.status).toBe(200);
    expect((await agentById(handle, key, agentId))!.message).toBe("compile · 0 errors · ingested");

    const one = await postJson(handle, "/api/v2/runs/compile", {
      projectKey: key,
      agentId,
      format: "tsc",
      errors: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.",
    });
    expect(one.status).toBe(200);
    expect((await agentById(handle, key, agentId))!.message).toBe("compile · 1 error · ingested");
  });

  test("a REFUSED compile ingest (the bound cycle went done while the run was open) writes the refusal onto the agent, not `ingesting…`", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { planId, cycleId } = await fileAndActivateCycle(handle, key, "compile-outcome-refuse");
    const agentId = "green-compile-refuse";
    await registerBound(handle, key, agentId, cycleId);
    const runId = await startRun(handle, key, agentId);
    await sayIngesting(handle, key, agentId);

    const done = await patchJson(
      handle,
      `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`,
      { status: "done", agentId: FIXTURE_ORCH },
    );
    expect(done.status).toBe(200);

    const res = await postJson(handle, "/api/v2/runs/compile", {
      projectKey: key,
      agentId,
      runId,
      format: "tsc",
      errors: TWO_TSC_ERRORS,
    });
    expect(res.status).toBe(409);

    const agent = await agentById(handle, key, agentId);
    expect(agent).toBeDefined();
    expect(agent!.message).toBe(`ingest refused — cycle ${cycleId} is done`);
    expect(agent!.message).not.toContain("ingesting");
  });
});
