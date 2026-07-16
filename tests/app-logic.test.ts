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
// CR-CRU-007 §S5 — projectActivity/orderProjects do not exist yet (GREEN adds
// them). A namespace import stays loadable even for not-yet-exported names
// (only the named-binding `import { x }` form link-errors on a missing
// export) — so referencing `AppLogic.projectActivity`/`AppLogic.orderProjects`
// below fails at CALL time ("is not a function"), the missing-export RED
// signal, WITHOUT breaking this file's already-passing tests above.
import * as AppLogic from "../public/app-logic.mjs";

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
  hint?: string;
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

describe("workspaceTabs — Runs/Workflow/Coverage/Compile/BDD, Agents dropped (§S5 shell final form)", () => {
  // §S5.2 — agents nested under the workspace's Project pane everywhere;
  // `Agents` is removed from L.workspaceTabs for BOTH project types. This
  // REPLACES the CR-CRU-006 contract (which included an "Agents" tab) — the
  // old assertions currently pass against the CURRENT TAB_NAMES list, so this
  // update is the RED signal for the tab-removal AC (S5 AC2).
  //
  // SANCTIONED RE-TARGET (CR-CRU-011 §S3, dispatch-approved): the CR-007-era
  // four-tab expectation ["Runs","Coverage","Compile","BDD"] is updated to
  // the CR-011 five-tab list ["Runs","Workflow","Coverage","Compile","BDD"]
  // — Workflow is inserted right after Runs, per the spec's fixed order
  // "Runs · Workflow · Coverage · Compile · BDD", and is NEVER gated (bound:
  // unlike Coverage/BDD, Workflow has no `disabled`/`hint` semantics — it is
  // enabled for both project types, same as Runs/Compile).
  test("backend project: exactly [Runs, Workflow, Coverage, Compile, BDD(disabled)] — no Agents entry", () => {
    const tabs = workspaceTabs({ type: "backend" });

    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Runs",
      "Workflow",
      "Coverage",
      "Compile",
      "BDD",
    ]);
    expect(tabs.find((t: TabShape) => t.name === "BDD")).toEqual({ name: "BDD", disabled: true });
    // Modified per the §S1 addendum (Coverage tab gating, user-added during
    // execution): a project with NO `latestCoverageEventId` (this fixture
    // supplies none) now legitimately disables Coverage too — was: "bound:
    // none of the non-BDD tabs are disabled". Runs and Compile are still
    // NEVER gated.
    expect(tabs.find((t: TabShape) => t.name === "Runs")?.disabled).toBe(false);
    expect(tabs.find((t: TabShape) => t.name === "Compile")?.disabled).toBe(false);
    // Workflow is never gated (bound: not disabled even with no plans/coverage).
    expect(tabs.find((t: TabShape) => t.name === "Workflow")?.disabled).toBe(false);
    // bound: Agents is gone, not merely relabeled
    expect(tabs.find((t: TabShape) => t.name === "Agents")).toBeUndefined();
  });

  test("frontend project: same fixed order, BDD enabled, Workflow enabled, no Agents entry", () => {
    const tabs = workspaceTabs({ type: "frontend" });

    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Runs",
      "Workflow",
      "Coverage",
      "Compile",
      "BDD",
    ]);
    expect(tabs.find((t: TabShape) => t.name === "BDD")).toEqual({
      name: "BDD",
      disabled: false,
    });
    // bound: Workflow enabled identically for the frontend project type too.
    expect(tabs.find((t: TabShape) => t.name === "Workflow")?.disabled).toBe(false);
    expect(tabs.find((t: TabShape) => t.name === "Agents")).toBeUndefined();
  });
});

// §S1 addendum (user note, during execution): the Coverage tab gates like
// BDD does — disabled with a hint until the project has green-regression
// coverage data (`latestCoverageEventId` present, same field the server
// already emits — src/v2.ts's v2 projects listing), enabled once it exists.
describe("workspaceTabs — Coverage tab gating (§S1 addendum)", () => {
  test("no latestCoverageEventId: Coverage is disabled with a hint", () => {
    const tabs = workspaceTabs({ type: "backend" });
    const coverage = tabs.find((t: TabShape) => t.name === "Coverage");
    expect(coverage?.disabled).toBe(true);
    expect(coverage?.hint).toBe("coverage lands with the first green regression");
  });

  test("latestCoverageEventId present: Coverage is enabled (no hint)", () => {
    const tabs = workspaceTabs({ type: "backend", latestCoverageEventId: "evt-cov-1" });
    const coverage = tabs.find((t: TabShape) => t.name === "Coverage");
    expect(coverage?.disabled).toBe(false);
    expect(coverage?.hint).toBeUndefined();
  });

  test("gating applies identically to frontend projects", () => {
    const gated = workspaceTabs({ type: "frontend" });
    expect(gated.find((t: TabShape) => t.name === "Coverage")?.disabled).toBe(true);

    const ungated = workspaceTabs({ type: "frontend", latestCoverageEventId: "evt-cov-2" });
    expect(ungated.find((t: TabShape) => t.name === "Coverage")?.disabled).toBe(false);
  });
});

// §S5.1 — activity rule (user-locked round 13): a project is `active` while
// it has >=1 live (online/stale) agent; with none left it turns `inactive`
// once now-lastActivity exceeds the configurable timeout. `lastActivity` is
// the max of the project's last event timestamp and its agents' last-seen.
// Not yet exported by app-logic.mjs — GREEN adds `projectActivity`.
describe("L.projectActivity — activity state rule (§S5 AC4, pure)", () => {
  interface ActivityAgent {
    liveness: "online" | "stale" | "tombstoned";
    lastSeen: number;
  }
  interface ActivityProject {
    lastEventAt: number | null;
    agents: ActivityAgent[];
  }

  test("project A: 1 online agent seen 5s ago -> active, regardless of timeout", () => {
    const now = Date.now();
    const project: ActivityProject = {
      lastEventAt: null,
      agents: [{ liveness: "online", lastSeen: now - 5_000 }],
    };

    const result = AppLogic.projectActivity(project, now, 3_600_000);

    expect(result.active).toBe(true);
    expect(result.lastActivity).toBe(now - 5_000);
  });

  test("project C: no live agents, last event 10 min ago, timeout 1h (3_600_000ms) -> active (within grace)", () => {
    const now = Date.now();
    const project: ActivityProject = {
      lastEventAt: now - 600_000,
      agents: [],
    };

    const result = AppLogic.projectActivity(project, now, 3_600_000);

    expect(result.active).toBe(true);
    expect(result.lastActivity).toBe(now - 600_000);
  });

  test("project B: no live agents, last activity 2h ago, timeout 1h (3_600_000ms) -> inactive (timeout elapsed)", () => {
    const now = Date.now();
    const project: ActivityProject = {
      lastEventAt: now - 7_200_000,
      agents: [],
    };

    const result = AppLogic.projectActivity(project, now, 3_600_000);

    expect(result.active).toBe(false);
    expect(result.lastActivity).toBe(now - 7_200_000);
  });

  test("boundary: now - lastActivity exactly equal to the timeout -> still active (only EXCEEDING flips it)", () => {
    const now = Date.now();
    const project: ActivityProject = {
      lastEventAt: now - 3_600_000,
      agents: [],
    };

    expect(AppLogic.projectActivity(project, now, 3_600_000).active).toBe(true);
  });

  test("boundary: 1ms past the timeout -> inactive", () => {
    const now = Date.now();
    const project: ActivityProject = {
      lastEventAt: now - 3_600_001,
      agents: [],
    };

    expect(AppLogic.projectActivity(project, now, 3_600_000).active).toBe(false);
  });

  test("a tombstoned-only agent roster does not count as live (falls back to the timeout grace rule)", () => {
    const now = Date.now();
    const project: ActivityProject = {
      lastEventAt: now - 600_000,
      agents: [{ liveness: "tombstoned", lastSeen: now - 600_000 }],
    };

    const result = AppLogic.projectActivity(project, now, 3_600_000);

    // no live (online/stale) agent -> falls to the event/lastSeen timeout
    // grace rule, same as project C above (10 min < 1h timeout -> active).
    expect(result.active).toBe(true);
  });

  test("lastActivity is the MAX of lastEventAt and agents' lastSeen, not just the event timestamp", () => {
    const now = Date.now();
    const project: ActivityProject = {
      lastEventAt: now - 7_200_000, // stale event
      agents: [{ liveness: "stale", lastSeen: now - 10_000 }], // fresher agent activity
    };

    const result = AppLogic.projectActivity(project, now, 3_600_000);

    expect(result.lastActivity).toBe(now - 10_000);
    expect(result.active).toBe(true); // has a live (stale) agent too
  });
});

// §S5.1 — projects-row ordering: "most-recently-active first, inactive
// last". Not yet exported by app-logic.mjs — GREEN adds `orderProjects`.
describe("L.orderProjects — projects-row badge ordering (§S5 AC4, pure)", () => {
  interface OrderableProject {
    key: string;
    active: boolean;
    lastActivity: number;
  }

  test("A (active, 5s ago), C (active, 10min ago), B (inactive, 2h ago) order as A, C, B", () => {
    const now = Date.now();
    // Deliberately shuffled input order to prove the function re-orders.
    const projects: OrderableProject[] = [
      { key: "B", active: false, lastActivity: now - 7_200_000 },
      { key: "A", active: true, lastActivity: now - 5_000 },
      { key: "C", active: true, lastActivity: now - 600_000 },
    ];

    const ordered = AppLogic.orderProjects(projects);

    expect(ordered.map((p: OrderableProject) => p.key)).toEqual(["A", "C", "B"]);
  });

  test("all-active group sorts by lastActivity descending (most recent first)", () => {
    const now = Date.now();
    const projects: OrderableProject[] = [
      { key: "old", active: true, lastActivity: now - 50_000 },
      { key: "newest", active: true, lastActivity: now - 1_000 },
      { key: "mid", active: true, lastActivity: now - 20_000 },
    ];

    expect(AppLogic.orderProjects(projects).map((p: OrderableProject) => p.key)).toEqual([
      "newest",
      "mid",
      "old",
    ]);
  });

  test("bound: an inactive project NEVER sorts before an active one, even with a fresher lastActivity value", () => {
    const now = Date.now();
    const projects: OrderableProject[] = [
      { key: "inactive-but-fresher", active: false, lastActivity: now - 1_000 },
      { key: "active-but-older", active: true, lastActivity: now - 500_000 },
    ];

    expect(AppLogic.orderProjects(projects).map((p: OrderableProject) => p.key)).toEqual([
      "active-but-older",
      "inactive-but-fresher",
    ]);
  });

  test("does not mutate the input array", () => {
    const now = Date.now();
    const projects: OrderableProject[] = [
      { key: "B", active: false, lastActivity: now - 7_200_000 },
      { key: "A", active: true, lastActivity: now - 5_000 },
    ];
    const original = [...projects];

    AppLogic.orderProjects(projects);

    expect(projects).toEqual(original);
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
