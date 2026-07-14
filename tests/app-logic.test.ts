// CR-CRU-006 §S3 (Mission Control home) + §S4 (workspace) — pure app-logic
// functions the SPA UI binds to. app.js will consume `public/app-logic.mjs`
// via <script type="module"> that sets window.CrucibleLogic; these tests
// import the ES module directly. `public/app-logic.mjs` does not exist yet
// (GREEN creates it) — module-resolution failure is the RED signal here.
import { describe, test, expect } from "bun:test";
import {
  filterEvents,
  relativeTime,
  livenessGlyph,
  routeParse,
  workspaceTabs,
  projectRollupLabel,
  emptyStates,
  type CrucibleEventBrief,
} from "../public/app-logic.mjs";

// Local minimal shapes for lambda-parameter annotations below — kept
// independent of the (not-yet-existing) module's own ambient types so tsc
// stays clean on everything except the expected "cannot find module" RED
// signal itself.
interface EventBriefShape {
  projectKey: string;
  agentId: string;
}
interface TabShape {
  name: string;
  disabled: boolean;
}

function brief(overrides: Partial<CrucibleEventBrief> = {}): CrucibleEventBrief {
  return {
    id: "evt-1",
    projectKey: "proj-a",
    agentId: "agent-1",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: Date.now(),
    total: 10,
    passed: 10,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
    ...overrides,
  };
}

describe("filterEvents — chip filtering in place (§nav)", () => {
  test("no filter (empty filters object) returns all events unchanged", () => {
    const events = [
      brief({ id: "e1", projectKey: "proj-a", agentId: "a1" }),
      brief({ id: "e2", projectKey: "proj-b", agentId: "a2" }),
    ];

    expect(filterEvents(events, {})).toEqual(events);
  });

  test("projectKey filter keeps only that project's events", () => {
    const wanted = brief({ id: "e1", projectKey: "proj-a", agentId: "a1" });
    const other = brief({ id: "e2", projectKey: "proj-b", agentId: "a2" });

    const result = filterEvents([wanted, other], { projectKey: "proj-a" });

    expect(result).toEqual([wanted]);
    // bound: the other project's event must not leak through
    expect(result.find((e: EventBriefShape) => e.projectKey === "proj-b")).toBeUndefined();
  });

  test("agentId filter keeps only that agent's events (agent-row click)", () => {
    const wanted = brief({ id: "e1", projectKey: "proj-a", agentId: "a1" });
    const other = brief({ id: "e2", projectKey: "proj-a", agentId: "a2" });

    const result = filterEvents([wanted, other], { agentId: "a1" });

    expect(result).toEqual([wanted]);
    expect(result.find((e: EventBriefShape) => e.agentId === "a2")).toBeUndefined();
  });

  test("projectKey + agentId together apply as AND", () => {
    const wanted = brief({ id: "e1", projectKey: "proj-a", agentId: "a1" });
    const wrongAgent = brief({ id: "e2", projectKey: "proj-a", agentId: "a2" });
    const wrongProject = brief({ id: "e3", projectKey: "proj-b", agentId: "a1" });

    const result = filterEvents([wanted, wrongAgent, wrongProject], {
      projectKey: "proj-a",
      agentId: "a1",
    });

    expect(result).toEqual([wanted]);
  });
});

describe("relativeTime — storyboard card labels", () => {
  test("under 10s → 'just now'", () => {
    const now = Date.now();
    expect(relativeTime(now - 3_000, now)).toBe("just now");
  });

  test("at the 10s boundary → NOT 'just now' (closed lower bound on the next tier)", () => {
    const now = Date.now();
    expect(relativeTime(now - 10_000, now)).not.toBe("just now");
  });

  test("2 minutes → '2m ago'", () => {
    const now = Date.now();
    expect(relativeTime(now - 120_000, now)).toBe("2m ago");
  });

  test("2 hours → '2h ago'", () => {
    const now = Date.now();
    expect(relativeTime(now - 7_200_000, now)).toBe("2h ago");
  });

  test("2 days → '2d ago'", () => {
    const now = Date.now();
    expect(relativeTime(now - 172_800_000, now)).toBe("2d ago");
  });
});

describe("livenessGlyph — agent rail dots + tombstone marker", () => {
  test("online agent → {cls:'g', tombstone:false}, no diedAgo", () => {
    const agent = {
      agentId: "a1",
      projectKey: "proj-a",
      liveness: "online" as const,
      lastSeen: Date.now(),
    };

    expect(livenessGlyph(agent)).toEqual({ cls: "g", tombstone: false });
  });

  test("stale agent → {cls:'y', tombstone:false}, no diedAgo", () => {
    const agent = {
      agentId: "a1",
      projectKey: "proj-a",
      liveness: "stale" as const,
      lastSeen: Date.now(),
    };

    expect(livenessGlyph(agent)).toEqual({ cls: "y", tombstone: false });
  });

  test("tombstoned agent → {cls:'o', tombstone:true}, diedAgo from lastSeen", () => {
    const now = Date.now();
    const agent = {
      agentId: "a1",
      projectKey: "proj-a",
      liveness: "tombstoned" as const,
      lastSeen: now - 7_200_000, // died 2h ago
    };

    const glyph = livenessGlyph(agent);
    expect(glyph.cls).toBe("o");
    expect(glyph.tombstone).toBe(true);
    expect(glyph.diedAgo).toBe("2h ago");
  });
});

describe("routeParse — hash-free History routing (§S2)", () => {
  test("'/' → { page: 'home' }", () => {
    expect(routeParse("/")).toEqual({ page: "home" });
  });

  test("'/p/abc' → { page: 'workspace', projectKey: 'abc' }", () => {
    expect(routeParse("/p/abc")).toEqual({ page: "workspace", projectKey: "abc" });
  });

  test("'/p/abc/run/evt-1' → { page: 'workspace', projectKey: 'abc', overlay: 'evt-1' }", () => {
    expect(routeParse("/p/abc/run/evt-1")).toEqual({
      page: "workspace",
      projectKey: "abc",
      overlay: "evt-1",
    });
  });

  test("'/run/evt-2' → { page: 'home', overlay: 'evt-2' }", () => {
    expect(routeParse("/run/evt-2")).toEqual({ page: "home", overlay: "evt-2" });
  });

  test("unknown path → { page: 'home' }", () => {
    expect(routeParse("/some/unknown/path")).toEqual({ page: "home" });
  });
});

describe("workspaceTabs — Runs/Agents/Coverage/Compile/BDD (§S4)", () => {
  test("backend project: BDD tab disabled, all others enabled, fixed order", () => {
    const tabs = workspaceTabs({ type: "backend" });

    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Runs",
      "Agents",
      "Coverage",
      "Compile",
      "BDD",
    ]);
    expect(tabs.find((t: TabShape) => t.name === "BDD")).toEqual({ name: "BDD", disabled: true });
    // bound: none of the non-BDD tabs are disabled
    expect(
      tabs.filter((t: TabShape) => t.name !== "BDD").some((t: TabShape) => t.disabled),
    ).toBe(false);
  });

  test("frontend project: BDD tab enabled, same fixed order", () => {
    const tabs = workspaceTabs({ type: "frontend" });

    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Runs",
      "Agents",
      "Coverage",
      "Compile",
      "BDD",
    ]);
    expect(tabs.find((t: TabShape) => t.name === "BDD")).toEqual({
      name: "BDD",
      disabled: false,
    });
  });
});

describe("projectRollupLabel — card sub-labels", () => {
  test("no lastEvent → 'no runs yet'", () => {
    expect(projectRollupLabel({ lastEvent: null })).toBe("no runs yet");
  });

  test("lastEvent with failures → '✗ N failed of T · <rel>'", () => {
    const now = Date.now();
    const project = {
      lastEvent: { total: 5, passed: 2, failed: 3, timestamp: now - 7_200_000 },
    };

    expect(projectRollupLabel(project)).toBe("✗ 3 failed of 5 · 2h ago");
  });

  test("lastEvent all-green → '✓ green · P/T · <rel>'", () => {
    const now = Date.now();
    const project = {
      lastEvent: { total: 34, passed: 34, failed: 0, timestamp: now - 7_200_000 },
    };

    expect(projectRollupLabel(project)).toBe("✓ green · 34/34 · 2h ago");
  });
});

describe("emptyStates — storyboard F1 empty states", () => {
  test("zero projects → {kind:'no-projects'}, even if events is non-empty", () => {
    expect(emptyStates({ projects: [], events: [{ id: "e1" }] })).toEqual({
      kind: "no-projects",
    });
  });

  test("projects present but zero events → {kind:'no-runs'}", () => {
    expect(emptyStates({ projects: [{ key: "p1" }], events: [] })).toEqual({
      kind: "no-runs",
    });
  });

  test("projects and events both present → null", () => {
    expect(emptyStates({ projects: [{ key: "p1" }], events: [{ id: "e1" }] })).toBeNull();
  });
});
