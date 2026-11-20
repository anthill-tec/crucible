// A tombstoned agent's runtime is measured from its LATEST registration: to its
// last run since that registration, else to its last seen — a run from before
// the registration is not its last run, and the runtime is never below 0.
//
// Unregistering deletes the agent's row (`handleAgentUnregister`, src/v2.ts)
// and registering again creates a new one with a new `firstSeen`
// (`Store.touchAgent`, src/store.ts). The agents read (`handleAgentsList`,
// src/v2.ts) seals a tombstoned agent's `runtime_ms` as
// `(last run, else last seen) − firstSeen`, where the last run is
// `Store.lastRunTimestamp` — the agent's newest run of ALL time. So an agent
// whose last run predates its latest registration reads a negative runtime.
//
// Drives the REAL router in process (`bootInProcess`) and its real routes — register,
// unregister, the agents read — the same harness as tests/integration/agent-lifecycle.test.ts.
// Timestamps are seeded with that file's raw-db backdating technique (the
// Store has no timestamp lever in its public API), purely to place the run,
// the registration and the last seen deterministically; every assertion goes
// through GET /api/v2/agents.
import { describe, test, expect, afterEach } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import type { Store } from "../../src/store.ts";
import { bootInProcess, send } from "../helpers/run-stream-harness.ts";

interface AgentBrief {
  agentId: string;
  projectKey: string;
  liveness: string;
  firstSeen?: number;
  runtime_ms?: number;
  [key: string]: unknown;
}

interface AgentsListResponse {
  ok: true;
  agents: AgentBrief[];
}

interface QueryHandle {
  run(...args: unknown[]): void;
}
interface RawDb {
  query(sql: string): QueryHandle;
}

let handle: BoardHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return send(handle!, `${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "Runtime From Registration", type: "backend", sutRoot: "/tmp/runtime-from-registration" });
  return key;
}

/** Backdate the agent row's first_seen / last_seen (see the file header). */
function setAgentTimestamps(store: Store, projectKey: string, agentId: string, firstSeen: number, lastSeen: number): void {
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE agents SET first_seen = ?, last_seen = ? WHERE project_key = ? AND agent_id = ?`)
    .run(firstSeen, lastSeen, projectKey, agentId);
}

/** Backdate one event's timestamp (see the file header). */
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
  const body = (await res.json()) as { ok?: boolean; changed?: boolean };
  expect(body).toEqual({ ok: true, changed: true });
}

/** The agent's one brief on the agents read. */
async function agentBrief(projectKey: string, agentId: string): Promise<AgentBrief> {
  const res = await send(handle!, `/api/v2/agents?project=${projectKey}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as AgentsListResponse;
  const mine = body.agents.filter((a) => a.agentId === agentId);
  expect(mine, `exactly one brief for ${agentId}`).toHaveLength(1);
  return mine[0] as AgentBrief;
}

// Silences past DEFAULT_LIVENESS's tombstone limit (300 s) and short of its
// prune limit (3600 s), so the agent row is read back tombstoned.
const BEFORE_REGISTRATION = 1_000_000;
const REGISTERED = 900_000;
const RUN_SINCE = 870_000;
const LAST_SEEN = 860_000;

describe("a tombstoned agent's runtime counts from its latest registration", () => {
  test("ran, unregistered, registered again and tombstoned with no run since: the runtime runs from that registration to its last seen (40 s), not back to the earlier run", async () => {
    handle = bootInProcess();
    const store = handle.store;
    const key = seedProject(store);
    const agentId = "re-registered-no-run-since";
    const now = Date.now();

    await register(key, agentId);
    runAt(store, key, agentId, now - BEFORE_REGISTRATION);
    await unregister(key, agentId);
    await register(key, agentId);
    setAgentTimestamps(store, key, agentId, now - REGISTERED, now - LAST_SEEN);

    const agent = await agentBrief(key, agentId);
    expect(agent.liveness).toBe("tombstoned");
    // The earlier run is 100 s BEFORE the registration: counting to it reads -100 s.
    expect(agent.runtime_ms).toBe(REGISTERED - LAST_SEEN);
    expect(agent.runtime_ms).toBeGreaterThanOrEqual(0);
  });

  test("ran, unregistered, registered again and tombstoned the moment it registered: the runtime is 0, never below", async () => {
    handle = bootInProcess();
    const store = handle.store;
    const key = seedProject(store);
    const agentId = "re-registered-never-seen-since";
    const now = Date.now();

    await register(key, agentId);
    runAt(store, key, agentId, now - BEFORE_REGISTRATION);
    await unregister(key, agentId);
    await register(key, agentId);
    setAgentTimestamps(store, key, agentId, now - REGISTERED, now - REGISTERED);

    const agent = await agentBrief(key, agentId);
    expect(agent.liveness).toBe("tombstoned");
    expect(agent.runtime_ms).toBe(0);
  });

  test("ran, unregistered, registered again, ran once more and tombstoned: the runtime runs from that registration to that run (30 s), not to its last seen", async () => {
    handle = bootInProcess();
    const store = handle.store;
    const key = seedProject(store);
    const agentId = "re-registered-ran-since";
    const now = Date.now();

    await register(key, agentId);
    runAt(store, key, agentId, now - BEFORE_REGISTRATION);
    await unregister(key, agentId);
    await register(key, agentId);
    runAt(store, key, agentId, now - RUN_SINCE);
    setAgentTimestamps(store, key, agentId, now - REGISTERED, now - LAST_SEEN);

    const agent = await agentBrief(key, agentId);
    expect(agent.liveness).toBe("tombstoned");
    // To that run — not to the last seen (40 s), not back to the earlier run (-100 s).
    expect(agent.runtime_ms).toBe(REGISTERED - RUN_SINCE);
  });

  test("never unregistered: a tombstoned agent's runtime still runs from its registration to its last run", async () => {
    handle = bootInProcess();
    const store = handle.store;
    const key = seedProject(store);
    const agentId = "registered-once";
    const now = Date.now();

    await register(key, agentId);
    runAt(store, key, agentId, now - RUN_SINCE);
    setAgentTimestamps(store, key, agentId, now - REGISTERED, now - LAST_SEEN);

    const agent = await agentBrief(key, agentId);
    expect(agent.liveness).toBe("tombstoned");
    expect(agent.runtime_ms).toBe(REGISTERED - RUN_SINCE);
  });
});
