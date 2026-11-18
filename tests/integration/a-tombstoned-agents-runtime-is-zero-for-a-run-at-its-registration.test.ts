// A tombstoned agent whose last run lands at the very instant of its latest
// registration reads a runtime of 0: the run counts as its last run (it is not
// from before the registration), so the runtime is measured to that run — not
// on to the agent's last seen.
//
// The agents read (`handleAgentsList`, src/v2.ts) seals a tombstoned agent's
// `runtime_ms` from its latest registration (`firstSeen`) to its last run
// since that registration, else to its last seen.
//
// Drives the REAL server (startServer) and its real HTTP routes — register,
// unregister, the agents read — as the tombstoned-runtime file beside it does.
// Timestamps are placed with raw-db backdating (the Store has no timestamp
// lever in its public API), purely to put the run, the registration and the
// last seen at fixed instants; every assertion goes through GET /api/v2/agents.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../../src/server.ts";
import type { Store } from "../../src/store.ts";

interface AgentBrief {
  agentId: string;
  projectKey: string;
  liveness: string;
  runtime_ms?: number;
  [key: string]: unknown;
}

interface QueryHandle {
  run(...args: unknown[]): void;
}
interface RawDb {
  query(sql: string): QueryHandle;
}

let handle: ReturnType<typeof startServer> | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

function base(): string {
  if (handle === undefined) throw new Error("the server is not started");
  return `http://localhost:${handle.server.port}`;
}

async function postJson(route: string, body: unknown): Promise<Response> {
  return fetch(`${base()}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "Runtime At Registration", type: "backend", sutRoot: "/tmp/runtime-at-registration" });
  return key;
}

function setAgentTimestamps(store: Store, projectKey: string, agentId: string, firstSeen: number, lastSeen: number): void {
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE agents SET first_seen = ?, last_seen = ? WHERE project_key = ? AND agent_id = ?`)
    .run(firstSeen, lastSeen, projectKey, agentId);
}

function setEventTimestamp(store: Store, eventId: string, ts: number): void {
  (store as unknown as { db: RawDb }).db.query(`UPDATE events SET timestamp = ? WHERE id = ?`).run(ts, eventId);
}

/** One passing 1-test run for the agent, placed at `at`. */
function runAt(store: Store, projectKey: string, agentId: string, at: number): void {
  const event = store.recordTestEvent(
    projectKey,
    agentId,
    { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 4 }, tree: [] },
    { tier: "unit" },
  );
  setEventTimestamp(store, event.id, at);
}

async function register(projectKey: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey, agentId, role: "report" });
  expect(res.status).toBe(200);
}

async function unregister(projectKey: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/unregister", { projectKey, agentId });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, changed: true });
}

async function agentBrief(projectKey: string, agentId: string): Promise<AgentBrief> {
  const res = await fetch(`${base()}/api/v2/agents?project=${projectKey}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { agents: AgentBrief[] };
  const mine = body.agents.filter((a) => a.agentId === agentId);
  expect(mine, `exactly one brief for ${agentId}`).toHaveLength(1);
  return mine[0] as AgentBrief;
}

// Past the tombstone limit (300 s) and short of the prune limit (3600 s).
const BEFORE_REGISTRATION = 1_000_000;
const REGISTERED = 900_000;
const LAST_SEEN = 860_000;

describe("a tombstoned agent's runtime for a run at the instant of its latest registration", () => {
  test("ran, unregistered, registered again and ran at the very instant of that registration, then tombstoned: the runtime is 0, measured to that run rather than to its last seen 40 s later", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store = handle.store;
    const key = seedProject(store);
    const agentId = "ran-at-its-registration";
    const now = Date.now();

    await register(key, agentId);
    runAt(store, key, agentId, now - BEFORE_REGISTRATION);
    await unregister(key, agentId);
    await register(key, agentId);
    runAt(store, key, agentId, now - REGISTERED);
    setAgentTimestamps(store, key, agentId, now - REGISTERED, now - LAST_SEEN);

    const agent = await agentBrief(key, agentId);
    expect(agent.liveness).toBe("tombstoned");
    // To that run (0) — not to the last seen (40 s), not back to the earlier run (-100 s).
    expect(agent.runtime_ms).toBe(0);
  });
});
