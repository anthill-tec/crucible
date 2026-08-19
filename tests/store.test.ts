import { describe, test, expect } from "bun:test";
import { DEFAULT_LIVENESS, type Project, type Agent } from "../src/types.ts";
import { Store } from "../src/store.ts";

describe("DEFAULT_LIVENESS", () => {
  test("equals the exact spec values", () => {
    expect(DEFAULT_LIVENESS).toEqual({
      staleAfterMs: 60_000,
      tombstoneAfterMs: 300_000,
      pruneAfterMs: 3_600_000,
    });
  });
});

describe("Store — projects", () => {
  test("boots against :memory: and round-trips addProject/getProject", () => {
    const store = new Store(":memory:");
    const key = crypto.randomUUID();
    store.addProject({ key, name: "x", type: "backend", sutRoot: "/tmp" });

    const project = store.getProject(key);
    expect(project).not.toBeNull();
    expect(project?.name).toBe("x");
    expect(project?.key).toBe(key);
    expect(project?.sutRoot).toBe("/tmp");
  });

  test("addProject defaults type to backend when omitted", () => {
    const store = new Store(":memory:");
    const key = crypto.randomUUID();
    // @ts-expect-error — type intentionally omitted to exercise the default
    store.addProject({ key, name: "no-type", sutRoot: "/tmp" });

    const project = store.getProject(key);
    expect(project?.type).toBe("backend");
  });

  test("listProjects returns the added projects", () => {
    const store = new Store(":memory:");
    const key1 = crypto.randomUUID();
    const key2 = crypto.randomUUID();
    store.addProject({ key: key1, name: "p1", type: "backend", sutRoot: "/tmp/1" });
    store.addProject({ key: key2, name: "p2", type: "frontend", sutRoot: "/tmp/2" });

    const projects = store.listProjects();
    const keys = projects.map((p: Project) => p.key);
    expect(keys).toContain(key1);
    expect(keys).toContain(key2);
    expect(projects.find((p: Project) => p.key === key2)?.type).toBe("frontend");
  });
});

describe("Store — agents (touchAgent / listAgents / removeAgent)", () => {
  function seedProject(store: Store): string {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "proj", type: "backend", sutRoot: "/tmp" });
    return key;
  }

  test("touchAgent upserts and preserves identity across identity-less heartbeats", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    store.touchAgent(pk, "a1", { identity: { displayName: "A" } });
    store.touchAgent(pk, "a1", { message: "m2" });

    const agents = store.listAgents(pk);
    expect(agents.length).toBe(1);
    const agent = agents[0] as Agent;
    expect(agent.identity?.displayName).toBe("A");
    expect(agent.message).toBe("m2");
  });

  test("touchAgent sets firstSeen/lastSeen on create and bumps lastSeen on a later touch", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    store.touchAgent(pk, "a1", { message: "first" });
    const afterCreate = store.listAgents(pk)[0] as Agent;
    expect(typeof afterCreate.firstSeen).toBe("number");
    expect(typeof afterCreate.lastSeen).toBe("number");
    expect(afterCreate.lastSeen).toBe(afterCreate.firstSeen);

    Bun.sleepSync(5);
    store.touchAgent(pk, "a1", { message: "second" });
    const afterSecond = store.listAgents(pk)[0] as Agent;

    expect(afterSecond.firstSeen).toBe(afterCreate.firstSeen);
    expect(afterSecond.lastSeen).toBeGreaterThanOrEqual(afterCreate.lastSeen);
  });

  test("removeAgent(pk, agentId) removes the agent from that project only", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    store.touchAgent(pk, "a1", { message: "hi" });

    store.removeAgent(pk, "a1");

    const agents = store.listAgents(pk);
    expect(agents.find((a: Agent) => a.agentId === "a1")).toBeUndefined();
  });

  test("removeAgent(undefined, agentId) removes the agent from ALL projects", () => {
    const store = new Store(":memory:");
    const pk1 = seedProject(store);
    const pk2 = seedProject(store);
    store.touchAgent(pk1, "shared", { message: "hi" });
    store.touchAgent(pk2, "shared", { message: "hi" });

    store.removeAgent(undefined, "shared");

    expect(store.listAgents(pk1).find((a: Agent) => a.agentId === "shared")).toBeUndefined();
    expect(store.listAgents(pk2).find((a: Agent) => a.agentId === "shared")).toBeUndefined();
  });
});
