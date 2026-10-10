// The idle line's choices, each pinned through the real production HTTP
// surface (`startServer`) and — for the refusal — through the real card
// (`AgentRow` in the production SPA shell, mounted in happy-dom and fed the
// server's own `GET /api/v2/agents` payload):
//
//   - an agent that never ran reads `· seen <age>` in place of `last run …`;
//   - an agent with no declared role omits the role segment entirely;
//   - a tombstoned agent carries no idle line at all;
//   - a REFUSED ingest leaves the run OPEN (the server settles it, the
//     refusal does not close it) and the refusal is what the card shows.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { settleDom } from "./helpers/dom-settle";

const REAL_FETCH = globalThis.fetch;
const handles: ServerHandle[] = [];

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  globalThis.fetch = REAL_FETCH;
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
  return REAL_FETCH(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return REAL_FETCH(`${base(handle)}${route}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await REAL_FETCH(`${base(handle)}${route}`);
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
  projectKey: string;
  message: string;
  liveness: string;
  idleLine?: string;
  [key: string]: unknown;
}

async function agentsOf(handle: ServerHandle, key: string): Promise<AgentBrief[]> {
  const body = await getJson(handle, `/api/v2/agents?project=${key}`);
  return body.agents as AgentBrief[];
}

async function agentById(
  handle: ServerHandle,
  key: string,
  agentId: string,
): Promise<AgentBrief | undefined> {
  return (await agentsOf(handle, key)).find((a) => a.agentId === agentId);
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

// ── the real card, fed the server's own payload ─────────────────────────────

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");
let cacheBust = 0;

/** Mounts the production shell on the project's page, answering its reads
 * with the payloads the real server served (captured before the mount). */
async function mountCardWith(key: string, agents: AgentBrief[]): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${key}` });
  document.body.innerHTML = '<div id="app"></div>';
  const projects = [
    {
      key,
      name: key,
      type: "backend",
      agentsOnline: agents.length,
      agentsTotal: agents.length,
      active: true,
      lastActivity: Date.now(),
    },
  ];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: [], openRuns: [] };
    else if (url.includes("/api/v2/health")) body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    else throw new Error(`unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?agentIdleLineChoices=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 8 });
}

function cardMessage(agentId: string): string {
  const row = Array.from(document.querySelectorAll('[data-testid="agent-row"]')).find((el) =>
    (el.textContent ?? "").includes(agentId),
  );
  if (row === undefined) throw new Error(`no agent-row for ${agentId}`);
  const msg = row.querySelector(".app-agent-msg");
  if (msg === null) throw new Error(`agent-row for ${agentId} has no .app-agent-msg`);
  return (msg.textContent ?? "").trim();
}

describe("the idle line's choices", () => {
  test("an agent that never ran reads `· seen <age>` and no `last run`", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const { cycleId } = await fileAndActivateCycle(handle, key, "idle-never-ran");
    await registerBound(handle, key, "green-never-ran", cycleId);

    const agent = await agentById(handle, key, "green-never-ran");
    expect(agent?.idleLine).toBe(`idle · GREEN · cycle ${cycleId} · seen just now`);
    expect(agent!.idleLine).not.toContain("last run");
  });

  test("an agent with no declared role omits the role segment — never a placeholder", async () => {
    const handle = boot();
    const key = seedProject(handle);
    const res = await postJson(handle, "/api/v2/agents/heartbeat", {
      projectKey: key,
      agentId: "roleless-agent",
      message: "hello",
    });
    expect(res.status).toBe(200);

    const agent = await agentById(handle, key, "roleless-agent");
    expect(agent?.role).toBeUndefined();
    expect(agent?.idleLine).toBe("idle · no cycle bound · seen just now");
  });

  test("a tombstoned agent carries no idle line", async () => {
    const handle = boot();
    // A project whose liveness tombstones an agent after 20ms of silence.
    const key = crypto.randomUUID();
    handle.store.addProject({
      key,
      name: "P",
      type: "backend",
      sutRoot: "/tmp/p",
      liveness: { staleAfterMs: 10, tombstoneAfterMs: 20, pruneAfterMs: 3_600_000 },
    });
    const reg = await postJson(handle, "/api/v2/agents/register", {
      projectKey: key,
      agentId: "orch-tombstoned",
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);
    expect((await agentById(handle, key, "orch-tombstoned"))?.idleLine).toBeDefined();

    await Bun.sleep(60);

    const agent = await agentById(handle, key, "orch-tombstoned");
    expect(agent).toBeDefined();
    expect(agent!.liveness).toBe("tombstoned");
    expect(agent!.idleLine).toBeUndefined();
  });

  test(
    "a REFUSED ingest leaves the run open and the refusal on the card, never the stale count",
    async () => {
      const handle = boot();
      const key = seedProject(handle);
      const { planId, cycleId } = await fileAndActivateCycle(handle, key, "idle-refused");
      const agentId = "green-refused";
      await registerBound(handle, key, agentId, cycleId);
      const started = await postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId });
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      const count = await postJson(handle, "/api/v2/agents/heartbeat", {
        projectKey: key,
        agentId,
        message: "running 7/7",
      });
      expect(count.status).toBe(200);
      const done = await patchJson(
        handle,
        `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`,
        { status: "done", agentId: FIXTURE_ORCH },
      );
      expect(done.status).toBe(200);

      const refused = await postJson(handle, "/api/v2/runs/parsed", {
        projectKey: key,
        agentId,
        runId,
        summary: { total: 7, passed: 7, failed: 0, pending: 0, duration_ms: 5 },
        tree: [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 5 }] }],
      });
      expect(refused.status).toBe(409);

      // The refusal did not close the run: it is still open on the board.
      const events = await getJson(handle, `/api/v2/events?project=${key}`);
      expect((events.openRuns as { runId: string }[]).map((r) => r.runId)).toContain(runId);

      // With the run open the server serves no idle line, and the message is
      // the refusal the server wrote.
      const agents = await agentsOf(handle, key);
      const agent = agents.find((a) => a.agentId === agentId)!;
      expect(agent.idleLine).toBeUndefined();
      expect(agent.message).toBe(`ingest refused — cycle ${cycleId} is done`);

      // The real card, fed that payload, shows the refusal — not `running 7/7`.
      await mountCardWith(key, agents);
      const shown = cardMessage(agentId);
      expect(shown).toBe(`ingest refused — cycle ${cycleId} is done`);
      expect(shown).not.toContain("running");
    },
    15_000,
  );
});
