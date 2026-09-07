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
  // CR-CRU-094 §S1/AC3 — the three EXPORTED functions that consume the
  // module-private composite-key helpers this CR must leave alone.
  planCycleIndex,
  timelineRows,
  workflowLens,
  type CrucibleEventBrief,
  // ... and the DECLARED shapes themselves (`public/app-logic.d.mts`), which
  // are AC3's third consumer: annotating the fixture with them means a
  // declaration that stopped carrying `context.cycleId` stops COMPILING here.
  type LensPlanLike,
  type LensRunLike,
} from "../public/app-logic.mjs";
// CR-CRU-007 §S5 — projectActivity/orderProjects do not exist yet (GREEN adds
// them). A namespace import stays loadable even for not-yet-exported names
// (only the named-binding `import { x }` form link-errors on a missing
// export) — so referencing `AppLogic.projectActivity`/`AppLogic.orderProjects`
// below fails at CALL time ("is not a function"), the missing-export RED
// signal, WITHOUT breaking this file's already-passing tests above.
import * as AppLogic from "../public/app-logic.mjs";
// CR-CRU-108 §S3/AC6 — the SERVER half of the cross-surface measurement below.
// `declaredTracks` (src/store.ts) is the ONE place the published rule is
// spelled (§S1/AC1), so the comparison imports it rather than restating it:
// a copy here could only prove this file agrees with itself.
import { declaredTracks } from "../src/store";

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

describe("workspaceTabs — Roadmap/Workflow/Runs/Coverage/Compile/BDD, Agents dropped (§S5 shell final form)", () => {
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
  // SANCTIONED RE-TARGET (CR-CRU-021 §S1, dispatch-approved): the tab order
  // flips to Workflow-first ("Workflow · Runs · Coverage · Compile · BDD")
  // — user direction at the CR-020 gate review, "the Workflow should be the
  // primary view ... followed by runs". Was: ["Runs","Workflow",...].
  // SANCTIONED RE-TARGET (CR-CRU-014 §S3, dispatch-approved): the Roadmap
  // tab is inserted right BEFORE BDD ("Workflow · Runs · Coverage · Compile ·
  // Roadmap · BDD") — the roadmap is a first-class workspace tab (§S3, tab
  // elevation user-locked 2026-07-16). Roadmap is NEVER gated (enabled for
  // both project types, same as Workflow/Runs/Compile). Was:
  // ["Workflow","Runs","Coverage","Compile","BDD"].
  // SANCTIONED RE-TARGET (CR-CRU-076 §S1/§S2, AC1): Roadmap moves from fifth
  // to FIRST ("Roadmap · Workflow · Runs · Coverage · Compile · BDD"). This
  // SUPERSEDES CR-CRU-021 §S1 AC1 above, and only that AC — the roadmap is
  // the ORIGIN document (the CR backlog is registered at design time,
  // CR-CRU-014 §S2 `queue-file`) and Workflow is the runtime view downstream
  // of it; CR-CRU-021 predated the Roadmap tab entirely. CR-CRU-021 §S1 AC2
  // (the workspace LANDS on the Workflow pane) is untouched — the landing is
  // hard-coded, never TAB_NAMES[0]. Gating semantics are unchanged: the
  // assertions below this array are deliberately byte-identical. Was:
  // ["Workflow","Runs","Coverage","Compile","Roadmap","BDD"].
  test("backend project: exactly [Roadmap, Workflow, Runs, Coverage, Compile, BDD(disabled)] — no Agents entry", () => {
    const tabs = workspaceTabs({ type: "backend" });

    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Roadmap",
      "Workflow",
      "Runs",
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

  // SANCTIONED RE-TARGET (CR-CRU-021 §S1): same Workflow-first order flip,
  // frontend project type. SANCTIONED RE-TARGET (CR-CRU-014 §S3): Roadmap
  // inserted before BDD for the frontend project type too.
  // SANCTIONED RE-TARGET (CR-CRU-076 §S1/§S2, AC1): Roadmap-first for the
  // frontend project type too — the order is project-type-agnostic (same
  // supersession rationale as the backend case above). Was:
  // ["Workflow","Runs","Coverage","Compile","Roadmap","BDD"].
  test("frontend project: same fixed order (Roadmap-first), BDD enabled, Workflow enabled, no Agents entry", () => {
    const tabs = workspaceTabs({ type: "frontend" });

    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Roadmap",
      "Workflow",
      "Runs",
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

// ───────────────────────────────────────────────────────────────────────────
// CR-CRU-094 §S1/AC3 — the COMPOSITE-KEY CYCLE INDEX is unchanged.
//
// THESE PASS ON ARRIVAL, and that is the point. §S1 adds `events.cycle_id`
// beside `context.cycleId`, keeping the blob authoritative for the frontend;
// AC3 is the regression wall that says so. A wall is worth nothing if it is
// only built after the thing it guards has already moved, so it is built here,
// against today's behaviour, and re-run after.
//
// HOW THESE SITES WERE FOUND — worth writing down, because it is not
// reproducible with the obvious tool. `public/app-logic.mjs` holds five
// literal NUL bytes, and one of them IS this key's separator, so the file
// reads as BINARY: a pattern search for `cycleId` inside it returns NOTHING,
// silently. The six reads were enumerated by decoding the file's bytes in
// Python. `planCycleIndexKey` and `planCycleLookupKey` are module-private, so
// they are asserted through the three exported functions that consume them —
// `planCycleIndex`, `timelineRows` and `workflowLens` — which is also what a
// consumer can actually observe.
describe("CR-CRU-094 §S1/AC3 — app-logic's context.cycleId consumers, guarded before the column lands", () => {
  // The separator itself, named rather than inlined: a bare `\u0000` in the
  // middle of a template literal is exactly the character that made this key
  // invisible to search in the first place.
  const NUL = "\u0000";
  const DECLARED_CR = "CR-DECLARED-1";
  const LEGACY_CR = "CR-AUTH-2";

  // ONE fixture for all three assertions below, so "same events in, same runs
  // matched out" is a claim about one arrangement and not three.
  //
  // `status: "closed"` is load-bearing, not decoration: the lens is
  // closed-plans-only (CR-CRU-020 §S1.3 strips an OPEN plan's CR node), so an
  // open fixture would assert against an empty tree and prove nothing.
  const plans: LensPlanLike[] = [
    {
      planId: 1,
      projectKey: "proj-a",
      cr: DECLARED_CR,
      status: "closed",
      wave: "5",
      closedAt: 9000,
      cycles: [{ id: 41, label: "C1", status: "done" }],
    },
    // A LEGACY plan: no `projectKey`, so it keeps the pre-CR-CRU-026 bare-id
    // linkage the fallback exists to preserve.
    {
      planId: 2,
      cr: LEGACY_CR,
      status: "closed",
      wave: "5",
      closedAt: 8000,
      cycles: [{ id: 77, label: "L1", status: "done" }],
    },
  ];

  function run(id: string, projectKey: string, cycleId?: number): LensRunLike {
    return {
      id,
      projectKey,
      agentId: `agent-${id}`,
      kind: "test",
      timestamp: 1000,
      failed: 0,
      ...(cycleId !== undefined ? { context: { cycleId } } : {}),
    };
  }

  const events: Array<LensRunLike & { failed: number }> = [
    { ...run("e-bound", "proj-a", 41), timestamp: 1000 },
    // THE COLLISION the compound key exists to stop: another project's run
    // carrying the SAME cycle id. Cycle ids are per-project.
    { ...run("e-collision", "proj-b", 41), timestamp: 2000 },
    // Matched by the BARE-ID fallback, because its plan declares no project.
    { ...run("e-legacy", "proj-c", 77), timestamp: 3000 },
    { ...run("e-unlinked", "proj-a"), timestamp: 4000 },
  ];

  test("planCycleIndex keys a declared plan's cycle by `<projectKey>\\x00<cycleId>` and a legacy plan's by the bare id", () => {
    const index = planCycleIndex(plans);

    // The separator is a NUL, and the legacy key is a NUMBER, not the string
    // "77" — both halves of §S3.3's collision-safety argument, asserted as
    // values rather than described.
    expect([...index.keys()]).toEqual([`proj-a${NUL}41`, 77]);
    expect(index.get(`proj-a${NUL}41`)?.plan.cr).toBe(DECLARED_CR);
    expect(index.get(77)?.plan.cr).toBe(LEGACY_CR);
    // A bare id for a DECLARED plan is not a key: that is what stops the
    // cross-project collision the fixture plants.
    expect(index.has(41)).toBe(false);
  });

  test("timelineRows resolves an event against the index by compound key, with the bare-id fallback", () => {
    const rows = timelineRows(events, plans);

    // A `done` cycle's declared marker heads its linked run; the collision run
    // and the unlinked run render as plain cards with no boundary of their own.
    expect(rows.map((r) => r.kind)).toEqual([
      "declared-marker",
      "card",
      "card",
      "declared-marker",
      "card",
      "card",
    ]);
    const markers = rows.filter((r) => r.kind === "declared-marker");
    expect(markers.map((r) => (r as { cycle: { id: number } }).cycle.id)).toEqual([41, 77]);
    expect(markers.map((r) => (r as { plan: { cr: string } }).plan.cr)).toEqual([
      DECLARED_CR,
      LEGACY_CR,
    ]);
  });

  test("workflowLens attaches each run to the cycle its (projectKey, cycleId) names, and tails the rest", () => {
    const lens = workflowLens({ plans, events });

    const crs = lens.waves.flatMap((wave) => wave.crs);
    expect(crs.map((c) => c.cr).sort()).toEqual([LEGACY_CR, DECLARED_CR].sort());

    const declared = crs.find((c) => c.cr === DECLARED_CR)!;
    const legacy = crs.find((c) => c.cr === LEGACY_CR)!;
    // EXACTLY one run each — the collision run does NOT join cycle 41 despite
    // carrying its id, which is the whole behaviour the composite key buys.
    expect(declared.cycles[0]!.runs.map((r) => r.id)).toEqual(["e-bound"]);
    expect(legacy.cycles[0]!.runs.map((r) => r.id)).toEqual(["e-legacy"]);
    // Nothing is DROPPED: a run that matches no cycle lands in the tail.
    expect(lens.ungrouped.map((r) => r.id).sort()).toEqual(["e-collision", "e-unlinked"]);
  });
});

// ── CR-CRU-108 §S3/AC6 — ONE fixture, both track rules ─────────────────────
//
// WHY HERE: this file owns the browser's pure predicates. The SERVER's rule is
// imported (`declaredTracks`, src/store.ts) and the BROWSER's is reached the
// only way production reaches it — `declaredLabel`/`distinctLabels` are
// module-private, and `focusedReleaseView(...).tracks`
// (public/app-logic.mjs:1537) IS `distinctLabels(members, "track")`, the same
// call the wave lanes (:1482/:1487) and `roadmapTableColumns` (:1202) make.
// Exporting the private pair to test it would mint a surface AC6 does not ask
// for; driving the real consumer measures the real predicate.
//
// STATUS — declared PASS-ON-ARRIVAL guard, measured 2026-09-07 on
// `feature/CR-CRU-108` at 2783186. AC6 was filed when the third rule
// (`queue_tracks`, clients/_crucible_axi.py) still re-derived the answer and
// classified this very fixture as FOUR tracks (`['   ', ' track-2 ', '2',
// 'track-2']`) against the browser's two; §S1 (68b5a0a) and §S2 (c555faa,
// 2783186) deleted that copy, so both surviving surfaces now answer
// `['2', 'track-2']` for every one of the first seven cases. The divergence
// AC6 was written to catch is GONE, which is exactly why it must become a
// standing measurement instead of a coincidence.
//
// The EIGHTH case was NOT pass-on-arrival. SQLite is dynamically typed and the
// AC2 tests plant raw `track` columns directly, so a legacy row can hold a
// NON-string — and the two rules split on it: the browser answered `"2"`
// (`String(raw).trim()`) while the server THREW (`entry.track?.trim()` on a
// number is not a function), i.e. a 500 on the queue read for a value the
// browser draws as a lane. AC6's own sentence is that the two rules classify
// EVERY case identically, and a throw-vs-coerce split is a case where they do
// not, so `declaredTracks` now coerces exactly as `declaredLabel` does.
//
// WHAT IT CATCHES (verified by mutation, both directions):
//   • restore `declaredTracks`' `entry.track?.trim()` and the eighth case
//     throws where the browser answers `"2"` — this fails, and only this case
//     fails (measured 2026-09-07 on `feature/CR-CRU-108` at 423487d);
//   • drop the `.trim()` from `declaredTracks` and the server classifies
//     `"   "` and `" track-2 "` as lanes the browser does not — this fails,
//     naming the case and the value;
//   • swap `declaredLabel`'s blank test for a truthiness test, or its trim for
//     none, and the browser diverges the same way — this fails;
//   • change BOTH in step and the third assertion still fails, because each
//     case's expected classification is SPELLED in the fixture rather than
//     read off either implementation.
// The one difference the comparison deliberately tolerates is ORDER: the
// server publishes SORTED (AC1) and the browser keeps first-appearance order
// (its `distinctLabels` contract), so the whole-fixture arm compares SETS.
describe("CR-CRU-108 §S3/AC6 — the published rule and the browser predicate classify one fixture identically", () => {
  /** One stored `track` value and the lane it DECLARES — `null` for the
   *  values that declare none. The third field is the spec's answer (AC1:
   *  null, absent, empty and whitespace-only are excluded; identity is the
   *  TRIMMED value; a legacy `2` is never re-spelled), written here so a
   *  change made to BOTH rules at once still fails.
   *
   *  `stored.track` is `unknown`, not `string | null`: SQLite is dynamically
   *  typed, the column is what a row HOLDS rather than what the TS shape
   *  promises, and the non-string case below is only reachable at all because
   *  the fixture refuses to assume the promise. */
  interface TrackCase {
    readonly name: string;
    readonly stored: { track?: unknown };
    readonly declares: string | null;
  }

  const TRACK_FIXTURE: readonly TrackCase[] = [
    { name: "a null track", stored: { track: null }, declares: null },
    { name: "an absent track key", stored: {}, declares: null },
    { name: "an empty-string track", stored: { track: "" }, declares: null },
    { name: "a whitespace-only track", stored: { track: "   " }, declares: null },
    { name: "a padded ` track-2 `", stored: { track: " track-2 " }, declares: "track-2" },
    { name: "a legacy un-normalised `2`", stored: { track: "2" }, declares: "2" },
    { name: "a canonical `track-2`", stored: { track: "track-2" }, declares: "track-2" },
    // The non-string a dynamically typed column can hold. Both rules must read
    // it as the lane `"2"` — the browser already did; the server threw.
    { name: "a non-string legacy `2`", stored: { track: 2 }, declares: "2" },
  ];

  const RELEASE = "0.4.0";
  const GATE = { version: RELEASE, kind: "proposed" };

  const Browser = AppLogic as unknown as {
    focusedReleaseView: (
      gate: unknown,
      releases: unknown,
      entries: unknown,
    ) => { members: unknown[]; tracks: string[] };
    roadmapTableColumns: (entries: unknown) => string[];
  };

  /** The ONE fixture, rendered as the queue rows both surfaces read: the
   *  server over `entries` as `listQueue` published them, the browser over the
   *  same payload. Spreading `stored` is what keeps the ABSENT-key case
   *  absent — a `track: undefined` property would be a different case. */
  const rowsOf = (cases: readonly TrackCase[]): Array<Record<string, unknown>> =>
    cases.map((one, index) => ({
      cr: `CR-AC6-${index}`,
      title: `${one.name}`,
      wave: "5",
      dependsOn: [],
      status: "PENDING",
      seq: (index + 1) * 10,
      release: RELEASE,
      ...one.stored,
    }));

  const serverTracks = (cases: readonly TrackCase[]): string[] =>
    declaredTracks(rowsOf(cases) as unknown as ReadonlyArray<{ track?: string | null }>);

  const browserTracks = (cases: readonly TrackCase[]): string[] =>
    Browser.focusedReleaseView(GATE, [], rowsOf(cases)).tracks;

  const expected = (one: TrackCase): string[] => (one.declares === null ? [] : [one.declares]);

  test("every case classifies the same on both surfaces, and the same as the rule AC1 states", () => {
    const measured = TRACK_FIXTURE.map((one) => ({
      case: one.name,
      server: serverTracks([one]),
      browser: browserTracks([one]),
    }));

    // The two surfaces, case by case — a unilateral change names the case it
    // broke and the value it answered.
    expect(measured.map((row) => ({ case: row.case, tracks: row.browser }))).toEqual(
      measured.map((row) => ({ case: row.case, tracks: row.server })),
    );
    // …and both against the SPELLED classification, so a change made to both
    // rules in step is still a failure.
    expect(measured).toEqual(
      TRACK_FIXTURE.map((one) => ({
        case: one.name,
        server: expected(one),
        browser: expected(one),
      })),
    );
  });

  test("driven over the whole fixture at once, both surfaces answer the same two lanes — the four non-lanes add none and the padded value collapses", () => {
    const lanes = [
      ...new Set(TRACK_FIXTURE.map((one) => one.declares).filter((one) => one !== null)),
    ].sort();
    // Non-vacuity: the fixture really does carry two lanes across eight rows,
    // four of which declare no lane at all.
    expect(lanes).toEqual(["2", "track-2"]);

    const server = serverTracks(TRACK_FIXTURE);
    const browser = browserTracks(TRACK_FIXTURE);

    // POSITIVE — the server publishes them SORTED (AC1); the browser keeps
    // first-appearance order, so the shared fact is the SET.
    expect(server).toEqual(lanes);
    expect([...browser].sort()).toEqual(lanes);
    // BOUND — eight rows, two lanes: no third lane may appear on either side,
    // and the non-string row lands in the SAME lane as the string `"2"`.
    expect(server).toHaveLength(2);
    expect(browser).toHaveLength(2);
    expect(server).not.toContain(" track-2 ");
    expect(browser).not.toContain(" track-2 ");
    expect(server).not.toContain("   ");
    expect(browser).not.toContain("   ");

    // The READING both surfaces make of that list is `> 1` — multi-track — and
    // the table's column is where the browser states it.
    expect(server.length > 1).toBe(true);
    expect(Browser.roadmapTableColumns(rowsOf(TRACK_FIXTURE))).toContain("track");
  });

  test("the collapse is observable on BOTH surfaces: a padded ` track-2 ` beside `track-2` and a blank is ONE track, and the browser draws no `track` column for it", () => {
    const collapsing = TRACK_FIXTURE.filter(
      (one) => one.declares === "track-2" || one.stored.track === "   ",
    );
    // Non-vacuity: three rows go in — the padded one, the canonical one and a
    // whitespace-only one that must not count as the second lane.
    expect(collapsing).toHaveLength(3);

    expect(serverTracks(collapsing)).toEqual(["track-2"]);
    expect(browserTracks(collapsing)).toEqual(["track-2"]);
    // …so it is SINGLE-track, and the column that states "more than one" is
    // absent. A rule that kept the padding or counted the blank would publish
    // two lanes here and light this column up.
    expect(Browser.roadmapTableColumns(rowsOf(collapsing))).not.toContain("track");
    expect(Browser.roadmapTableColumns(rowsOf(collapsing))).toEqual([
      "cr",
      "title",
      "deps",
      "status",
    ]);
  });
});
