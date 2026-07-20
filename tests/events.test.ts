// CR-CRU-001 §S2 (events methods) + §S4 (retention + rollup) + §S1 (RunEvent shape)
import { describe, test, expect } from "bun:test";
import type { Coverage, Project, RunContext, RunSummary, SuiteNode } from "../src/types.ts";
import { Store } from "../src/store.ts";

function seedProject(store: Store, extra?: Partial<Project>): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "proj", type: "backend", sutRoot: "/tmp", ...(extra ?? {}) });
  return key;
}

function summary(overrides?: Partial<RunSummary>): RunSummary {
  return { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5, ...overrides };
}

const emptyTree: SuiteNode[] = [];

const sampleCoverage: Coverage = {
  lines: { total: 10, covered: 8, percent: 80 },
};

describe("Store#recordTestEvent", () => {
  test("returns a well-formed RunEvent, defaults tier to 'unit', and round-trips via getEvent", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    const event = store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });

    expect(event.id).toMatch(/^evt-\d{13}-\d+$/);
    expect(event.kind).toBe("test");
    expect(event.tier).toBe("unit");
    expect(event.projectKey).toBe(pk);
    expect(event.agentId).toBe("a1");
    expect(event.summary).toEqual(summary());
    expect(event.tree).toEqual(emptyTree);

    const fetched = store.getEvent(event.id);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(event);
  });
});

describe("Store#recordTestEvent — coverage discard-on-fail (§S4 semantics on the write path)", () => {
  test("discards coverage when summary.failed > 0", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    const event = store.recordTestEvent(pk, "a1", {
      summary: summary({ failed: 1, passed: 0 }),
      tree: emptyTree,
      coverage: sampleCoverage,
    });

    const fetched = store.getEvent(event.id);
    expect(fetched?.coverage === null || fetched?.coverage === undefined).toBe(true);
  });

  test("keeps coverage when summary.failed === 0", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    const event = store.recordTestEvent(pk, "a1", {
      summary: summary({ failed: 0 }),
      tree: emptyTree,
      coverage: sampleCoverage,
    });

    const fetched = store.getEvent(event.id);
    expect(fetched?.coverage).toEqual(sampleCoverage);
  });
});

describe("Store#recordTestEvent — implicit heartbeat", () => {
  test("bumps lastSeen for an already-touched agent", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const before = store.touchAgent(pk, "a1", { message: "hi" });

    Bun.sleepSync(5);
    store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });

    const after = store.listAgents(pk).find((a) => a.agentId === "a1");
    expect(after).toBeDefined();
    expect(after!.lastSeen).toBeGreaterThan(before.lastSeen);
  });

  test("creates the agent row for a never-touched agentId", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    store.recordTestEvent(pk, "brand-new", { summary: summary(), tree: emptyTree });

    const agents = store.listAgents(pk);
    expect(agents.find((a) => a.agentId === "brand-new")).toBeDefined();
  });
});

describe("Store#recordTestEvent — context", () => {
  test("stores meta.context verbatim and round-trips via getEvent", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const context: RunContext = {
      git: { branch: "develop", commit: "abc123" },
      wave: "w1",
      orchestrator: "track-2",
    };

    const event = store.recordTestEvent(
      pk,
      "a1",
      { summary: summary(), tree: emptyTree },
      { context },
    );

    const fetched = store.getEvent(event.id);
    expect(fetched?.context).toEqual(context);
  });

  test("an event recorded without context has no context key at all (no fabrication)", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    const event = store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });

    expect("context" in event).toBe(false);
    const fetched = store.getEvent(event.id);
    expect(fetched !== null && "context" in fetched).toBe(false);
  });
});

describe("Store#recordCompileEvent", () => {
  test("stores an opaque compile payload under kind 'compile' and round-trips via getEvent", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const compilePayload = { exitCode: 1, diagnostics: ["error TS2304: Cannot find name 'foo'."] };

    const event = store.recordCompileEvent(pk, "a1", compilePayload, { tier: "module", stack: "ts" });

    expect(event.id).toMatch(/^evt-\d{13}-\d+$/);
    expect(event.kind).toBe("compile");
    expect(event.tier).toBe("module");
    expect(event.compile).toEqual(compilePayload);

    const fetched = store.getEvent(event.id);
    expect(fetched?.kind).toBe("compile");
    expect(fetched?.compile).toEqual(compilePayload);
  });
});

describe("Store#listEvents", () => {
  test("returns the N newest events, newest first", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    const first = store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });
    Bun.sleepSync(2);
    const second = store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });
    Bun.sleepSync(2);
    const third = store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });

    const events = store.listEvents(pk, 2);
    expect(events.length).toBe(2);
    expect(events[0]?.id).toBe(third.id);
    expect(events[1]?.id).toBe(second.id);
    expect(events.find((e) => e.id === first.id)).toBeUndefined();
  });

  test("with no projectKey spans all projects", () => {
    const store = new Store(":memory:");
    const pk1 = seedProject(store);
    const pk2 = seedProject(store);

    const e1 = store.recordTestEvent(pk1, "a1", { summary: summary(), tree: emptyTree });
    const e2 = store.recordTestEvent(pk2, "a1", { summary: summary(), tree: emptyTree });

    const ids = store.listEvents().map((e) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).toContain(e2.id);
  });
});

describe("Store#getEvent", () => {
  test("returns null for an id that does not exist", () => {
    const store = new Store(":memory:");
    expect(store.getEvent("evt-0000000000000-9999")).toBeNull();
  });
});

describe("Store#deleteEvent", () => {
  test("wrong projectKey returns false and does not delete", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const otherPk = crypto.randomUUID();
    const event = store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });

    const result = store.deleteEvent(event.id, otherPk);

    expect(result).toBe(false);
    expect(store.getEvent(event.id)).not.toBeNull();
  });

  test("correct projectKey returns true and removes the event", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);
    const event = store.recordTestEvent(pk, "a1", { summary: summary(), tree: emptyTree });

    const result = store.deleteEvent(event.id, pk);

    expect(result).toBe(true);
    expect(store.getEvent(event.id)).toBeNull();
  });
});

describe("Store#clearEvents", () => {
  test("returns the number removed and leaves other projects' events intact", () => {
    const store = new Store(":memory:");
    const pk1 = seedProject(store);
    const pk2 = seedProject(store);

    store.recordTestEvent(pk1, "a1", { summary: summary(), tree: emptyTree });
    store.recordTestEvent(pk1, "a1", { summary: summary(), tree: emptyTree });
    const untouched = store.recordTestEvent(pk2, "a1", { summary: summary(), tree: emptyTree });

    const removed = store.clearEvents(pk1);

    expect(removed).toBe(2);
    expect(store.listEvents(pk1).length).toBe(0);
    expect(store.getEvent(untouched.id)).not.toBeNull();
  });
});

describe("Store#onChange", () => {
  test("fires for projects/agents/events and stops after unsubscribe", () => {
    const store = new Store(":memory:");
    const calls: Array<["projects" | "agents" | "events", string | undefined]> = [];
    const unsubscribe = store.onChange((kind, projectKey) => {
      calls.push([kind, projectKey]);
    });

    const key = crypto.randomUUID();
    store.addProject({ key, name: "proj", type: "backend", sutRoot: "/tmp" });
    expect(calls).toContainEqual(["projects", key]);

    store.touchAgent(key, "a1", { message: "hi" });
    expect(calls).toContainEqual(["agents", key]);

    store.recordTestEvent(key, "a1", { summary: summary(), tree: emptyTree });
    expect(calls).toContainEqual(["events", key]);

    const callCountBeforeUnsub = calls.length;
    unsubscribe();

    store.touchAgent(key, "a1", { message: "again" });
    expect(calls.length).toBe(callCountBeforeUnsub);
  });
});

describe("Store — retention + rollup (§S4)", () => {
  test("105 inserts: all 5 expired same-day events (3 wave-tagged + 2 untagged) fold into ONE UTC-day rollup — context.wave no longer splits the bucket (CR-CRU-033 §S1), 100 raw remain", () => {
    const store = new Store(":memory:");
    const pk = seedProject(store);

    for (let i = 0; i < 105; i++) {
      store.recordTestEvent(
        pk,
        "a1",
        { summary: summary(), tree: emptyTree },
        // The first 3 still carry context.wave — §S1 means this tag is now
        // irrelevant to bucketing, it no longer splits the rollup.
        i < 3 ? { context: { wave: "w1" } } : undefined,
      );
    }

    const events = store.listEvents(pk, 1000);
    expect(events.length).toBe(100);

    const rollups = store.listRollups(pk);
    // §S1: bucket key is always the event's UTC day, so ALL 5 expired
    // same-day events (wave-tagged or not) fold into a single rollup.
    expect(rollups.length).toBe(1);
    expect(rollups[0]!.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rollups[0]).toMatchObject({ runs: 5, passed: 5, failed: 0, duration_ms: 25 });
  });
});

describe("Store — per-project retention override (§S4)", () => {
  test("project with retention: 5 keeps only 5 raw events after 7 inserts, 2 rolled up", () => {
    const store = new Store(":memory:");
    const key = crypto.randomUUID();
    store.addProject({ key, name: "small-retention", type: "backend", sutRoot: "/tmp", retention: 5 });

    for (let i = 0; i < 7; i++) {
      store.recordTestEvent(key, "a1", { summary: summary(), tree: emptyTree });
    }

    const events = store.listEvents(key, 1000);
    expect(events.length).toBe(5);

    const rollups = store.listRollups(key);
    const totalRolledUp = rollups.reduce((sum, r) => sum + r.runs, 0);
    expect(totalRolledUp).toBe(2);
  });
});
