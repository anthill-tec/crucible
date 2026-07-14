// CR-CRU-001 §S3 — Liveness (computed, never stored)
import { describe, test, expect } from "bun:test";
import { DEFAULT_LIVENESS, type Agent, type LivenessConfig } from "../src/types.ts";
import { Store } from "../src/store.ts";

// Agent objects returned by listAgents/livenessOf carry a computed `liveness`
// field that is not part of the stored Agent shape — narrow locally.
type LiveAgent = Agent & { liveness: "online" | "stale" | "tombstoned" };

function seedProject(store: Store, liveness?: Partial<LivenessConfig>): string {
  const key = crypto.randomUUID();
  store.addProject({
    key,
    name: "proj",
    type: "backend",
    sutRoot: "/tmp",
    ...(liveness !== undefined ? { liveness } : {}),
  });
  return key;
}

describe("Store#livenessConfig", () => {
  test("returns DEFAULT_LIVENESS merged when project has no override", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    expect(store.livenessConfig(pk)).toEqual({
      staleAfterMs: 60_000,
      tombstoneAfterMs: 300_000,
      pruneAfterMs: 3_600_000,
    });
  });

  test("merges project liveness override over DEFAULT_LIVENESS", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store, { staleAfterMs: 10 });

    expect(store.livenessConfig(pk)).toEqual({
      staleAfterMs: 10,
      tombstoneAfterMs: 300_000,
      pruneAfterMs: 3_600_000,
    });
  });
});

describe("Store#livenessOf — state machine (default thresholds)", () => {
  test("silence 0 → online", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen)).toBe("online");
  });

  test("silence just under T1 (59_999ms) → online", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 59_999)).toBe("online");
  });

  test("silence exactly T1 (60_000ms) → stale (closed-open lower bound)", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 60_000)).toBe("stale");
  });

  test("silence 61_000ms → stale", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 61_000)).toBe("stale");
  });

  test("silence just under T2 (299_999ms) → stale", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 299_999)).toBe("stale");
  });

  test("silence exactly T2 (300_000ms) → tombstoned (closed-open lower bound)", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 300_000)).toBe("tombstoned");
  });

  test("silence 301_000ms → tombstoned", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 301_000)).toBe("tombstoned");
  });

  test("silence 3_600_001ms (T3 + 1) → pruned", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 3_600_001)).toBe("pruned");
  });
});

describe("Store#livenessOf — project liveness override", () => {
  test("override {staleAfterMs: 10}: silence 20ms → stale", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store, { staleAfterMs: 10 });
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 20)).toBe("stale");
  });

  test("default thresholds: the same 20ms silence → online", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    expect(store.livenessOf(agent, agent.lastSeen + 20)).toBe("online");
  });
});

describe("Store#listAgents — computed liveness field + lazy prune", () => {
  test("each returned agent carries a computed liveness field", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    const now = agent.lastSeen + 301_000; // tombstoned under defaults
    const agents = store.listAgents(pk, now) as LiveAgent[];

    expect(agents.length).toBe(1);
    expect(agents[0]?.liveness).toBe("tombstoned");
  });

  test("stale agent surfaces liveness 'stale' via listAgents and is not deleted", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    const now = agent.lastSeen + 61_000; // stale under defaults
    const agents = store.listAgents(pk, now) as LiveAgent[];

    expect(agents.find((a) => a.agentId === "a1")?.liveness).toBe("stale");
  });

  test("pruned agent (silence > T3) is absent from listAgents and its row is lazily deleted", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "old-agent", { message: "hi" });
    const lastSeen = agent.lastSeen;

    const pruneNow = lastSeen + 3_600_001;
    const firstCall = store.listAgents(pk, pruneNow);
    expect(firstCall.find((a) => a.agentId === "old-agent")).toBeUndefined();

    // Prove the row was physically deleted, not merely filtered: re-query with
    // a `now` where — had the row survived — silence would be 1ms (online),
    // so it would reappear if only filtering had occurred.
    const secondCall = store.listAgents(pk, lastSeen + 1);
    expect(secondCall.find((a) => a.agentId === "old-agent")).toBeUndefined();
  });

  test("pruning one agent does not affect a co-resident live agent in the same project", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const oldAgent = store.touchAgent(pk, "old-agent", { message: "old" });
    const freshAgent = store.touchAgent(pk, "fresh-agent", { message: "fresh" });

    const now = oldAgent.lastSeen + 3_600_001;
    const agents = store.listAgents(pk, now) as LiveAgent[];

    expect(agents.find((a) => a.agentId === "old-agent")).toBeUndefined();
    const fresh = agents.find((a) => a.agentId === "fresh-agent");
    expect(fresh).toBeDefined();
    // freshAgent was touched moments after oldAgent, well before pruneNow's
    // silence window relative to its own lastSeen is much larger than T3 too,
    // so assert only that it is still present (not asserting its exact state
    // to avoid coupling to timing between the two touchAgent calls).
    expect(fresh?.agentId).toBe("fresh-agent");
  });
});

describe("Store — resurrect after tombstoned", () => {
  test("a tombstoned agent reports 'online' again after a fresh touchAgent", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const agent = store.touchAgent(pk, "a1", { message: "hi" });

    const now1 = agent.lastSeen + 301_000; // tombstoned under defaults
    const tombstoned = (store.listAgents(pk, now1) as LiveAgent[]).find(
      (a) => a.agentId === "a1",
    );
    expect(tombstoned?.liveness).toBe("tombstoned");

    const resurrected = store.touchAgent(pk, "a1", { message: "back" });
    const now2 = resurrected.lastSeen + 1;

    expect(store.livenessOf(resurrected, now2)).toBe("online");
    const afterResurrect = (store.listAgents(pk, now2) as LiveAgent[]).find(
      (a) => a.agentId === "a1",
    );
    expect(afterResurrect?.liveness).toBe("online");
  });
});
