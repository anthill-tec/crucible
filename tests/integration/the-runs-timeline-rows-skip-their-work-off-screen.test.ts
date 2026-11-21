// The timeline's rows — every kind it draws: run cards, aborted run cards,
// transition markers, milestone entries, gate cards, merge markers, the open
// cycle-span row and declared markers, on the Runs tab and on home (home's
// compact gate and merge rows included) — let the browser skip their style and layout while
// they are off screen: each carries `content-visibility: auto` with an
// intrinsic size (`contain-intrinsic-size`), so a document-wide re-style (a
// run opening or closing, a settled run arriving) costs only what is in view.
//
// happy-dom never applies public/styles.css, so the rows are rendered by the
// REAL public/app.js through tests/helpers/live-run-harness.ts and each one is
// resolved against public/styles.css by the harness's own cascade
// (`cascaded`): the rule has to reach the rows the page really draws, not
// merely exist in the file.
//
// The rest of this guarantee is held in a real browser, where the property
// takes effect: the `→ Runs` jump still scrolls its boundary into view
// (tests/e2e/features/cycle-run-navigation.feature, the history row's
// "→ Runs" badge scenario) and the Runs pane keeps its scroll position across
// a detail (tests/e2e/features/drill-in.feature, the "← runs" chip scenario).
import { describe, test, expect, afterEach } from "bun:test";
import {
  cascaded,
  mountLive,
  settle,
  unmountLive,
  type EventBriefFixture,
  type LiveMountOpts,
} from "../helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "6a1d9e44-2c7b-4f0e-8d3a-rows-skip-work";
const NOW = Date.now();

function run(id: string, agentId: string, minutesAgo: number, failed: number, extra: Partial<EventBriefFixture> = {}): EventBriefFixture {
  return {
    id,
    projectKey: PROJECT_KEY,
    agentId,
    kind: "test",
    tier: "unit",
    timestamp: NOW - minutesAgo * 60_000,
    total: 5,
    passed: 5 - failed,
    failed,
    pending: 0,
    duration_ms: 700,
    ...extra,
  };
}

/** A milestone as the events read serves one (not a run, so cast past the run-shaped fixture). */
const MILESTONE = {
  id: "evt-milestone-proposed",
  projectKey: PROJECT_KEY,
  agentId: "orchestrator",
  kind: "milestone",
  type: "release-proposed",
  label: "0.9.0",
  timestamp: NOW - 2 * 60_000,
} as unknown as EventBriefFixture;

/** Newest first: a milestone, a RED→GREEN pair (one transition marker), an aborted run, a plain run. */
function events(): EventBriefFixture[] {
  return [
    MILESTONE,
    run("evt-pair-green", "pair-GREEN", 3, 0),
    run("evt-pair-red", "pair-RED", 4, 2),
    run("evt-aborted", "abort-agent", 5, 0, { status: "aborted", abortReason: "runner killed" }),
    run("evt-plain", "plain-agent", 6, 0),
  ];
}

/**
 * A planned project's history, newest first: a merge marker, a gate card, a
 * run in the active cycle (under the open cycle-span row) and a run in a done
 * cycle (under its declared marker). A project with plans narrates its cycles
 * only from them, so this history draws no transition marker: it is mounted
 * on its own.
 */
const ACTIVE_CYCLE = 101;
const DONE_CYCLE = 100;

const PLANS = [
  {
    planId: 7,
    projectKey: PROJECT_KEY,
    cr: "CR-ROWS-1",
    status: "open",
    cycles: [
      { id: DONE_CYCLE, label: "c1", status: "done", activatedAt: NOW - 60 * 60_000, doneAt: NOW - 30 * 60_000 },
      { id: ACTIVE_CYCLE, label: "c2", status: "active", activatedAt: NOW - 20 * 60_000 },
    ],
  },
];

function plannedEvents(): EventBriefFixture[] {
  const merge = {
    id: "evt-merge",
    projectKey: PROJECT_KEY,
    agentId: "orchestrator",
    kind: "milestone",
    type: "cr-merged",
    label: "CR-ROWS-0",
    commit: "abc1234def5678",
    timestamp: NOW - 60_000,
  } as unknown as EventBriefFixture;
  const gate = {
    id: "evt-gate",
    projectKey: PROJECT_KEY,
    agentId: "orchestrator",
    kind: "gate",
    codec: "no-mistakes",
    context: { wave: "3", track: "A" },
    gate: {
      intent: "wave 3 gate",
      outcome: "passed",
      steps: [
        { name: "intent", status: "passed" },
        { name: "test", status: "passed" },
        { name: "push", status: "passed", fixRounds: 0 },
      ],
      push: { commit: "abc1234", remote: "origin/main" },
    },
    timestamp: NOW - 2 * 60_000,
  } as unknown as EventBriefFixture;
  const inActive = { ...run("evt-active-cycle", "cycle-GREEN", 3, 0), context: { cycleId: ACTIVE_CYCLE } } as EventBriefFixture;
  const inDone = { ...run("evt-done-cycle", "cycle-RED", 40, 1), context: { cycleId: DONE_CYCLE } } as EventBriefFixture;
  return [merge, gate, inActive, inDone];
}

function workspace(planned = false, pathname = `/p/${PROJECT_KEY}`): LiveMountOpts {
  return {
    ...(planned ? { plans: structuredClone(PLANS) } : {}),
    pathname,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Rows Skip Work",
        type: "backend",
        agentsOnline: 0,
        agentsTotal: 0,
        active: true,
        lastActivity: NOW,
      },
    ],
    agents: [],
    events: planned ? plannedEvents() : events(),
    eventDetails: {},
    openRuns: [],
    live: {},
  };
}

async function mountOnRuns(planned = false): Promise<void> {
  await mountLive(workspace(planned));
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).filter(
    (t) => (t.textContent ?? "").trim() === "Runs",
  );
  expect(tabs, "exactly one Runs workspace tab").toHaveLength(1);
  tabs[0]?.click();
  await settle();
}

function rowsOf(testid: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="workspace-runs"] [data-testid="${testid}"]`),
  );
}

/** Home: the all-projects timeline, drawn with home's compact gate and merge rows. */
async function mountOnHome(planned = false): Promise<void> {
  await mountLive(workspace(planned, "/"));
  expect(document.querySelectorAll('[data-testid="timeline"]').length, "home draws its one timeline").toBe(1);
}

function homeRowsOf(testid: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="timeline"] [data-testid="${testid}"]`));
}

/**
 * A `contain-intrinsic-size` that stands a skipped row in at a real size: one
 * positive length for both axes, or a width then a height, each optionally
 * remembered (`auto`) once the row has been drawn.
 */
const INTRINSIC_SIZE = /^(?:auto\s+)?[1-9]\d*(?:\.\d+)?px(?:\s+(?:auto\s+)?[1-9]\d*(?:\.\d+)?px)?$/;

// ═══════════════════════════════════════════════════════════════════════════

describe("the Runs timeline's rows are skipped by the browser while off screen", () => {
  // How many of each row the fixture's history draws.
  const ROWS: Record<string, number> = {
    "event-card": 3,
    "aborted-card": 1,
    "transition-marker": 1,
    "milestone-entry": 1,
  };

  // How many of each row the planned project's history draws.
  const PLANNED_ROWS: Record<string, number> = {
    "gate-card": 1,
    "merge-marker": 1,
    "cycle-span-open": 1,
    "declared-marker": 1,
  };

  const cases: [string, number, boolean][] = [
    ...Object.entries(ROWS).map(([t, n]): [string, number, boolean] => [t, n, false]),
    ...Object.entries(PLANNED_ROWS).map(([t, n]): [string, number, boolean] => [t, n, true]),
  ];

  for (const [testid, drawn, planned] of cases) {
    test(`every ${testid} row on the Runs timeline carries content-visibility: auto with an intrinsic size`, async () => {
      await mountOnRuns(planned);
      const rows = rowsOf(testid);
      expect(rows.length, `the Runs timeline draws its ${testid} rows`).toBe(drawn);
      for (const row of rows) {
        expect(cascaded(row, "content-visibility")).toBe("auto");
        const size = cascaded(row, "contain-intrinsic-size");
        expect(INTRINSIC_SIZE.test(size), `contain-intrinsic-size "${size}" is a positive px size`).toBe(true);
      }
    });
  }
});

describe("the home timeline's rows are skipped by the browser while off screen", () => {
  // How many of each row home draws from the fixture's history. Home draws no
  // milestone entry (those are the workspace's only).
  const HOME_ROWS: Record<string, number> = {
    "event-card": 3,
    "aborted-card": 1,
    "transition-marker": 1,
  };

  // How many of each row home draws from the planned project's history: its
  // gate and merge rows are home's own compact ones.
  const HOME_PLANNED_ROWS: Record<string, number> = {
    "gate-card-compact": 1,
    "merge-marker-compact": 1,
    "cycle-span-open": 1,
    "declared-marker": 1,
  };

  const cases: [string, number, boolean][] = [
    ...Object.entries(HOME_ROWS).map(([t, n]): [string, number, boolean] => [t, n, false]),
    ...Object.entries(HOME_PLANNED_ROWS).map(([t, n]): [string, number, boolean] => [t, n, true]),
  ];

  for (const [testid, drawn, planned] of cases) {
    test(`every ${testid} row on the home timeline carries content-visibility: auto with an intrinsic size`, async () => {
      await mountOnHome(planned);
      const rows = homeRowsOf(testid);
      expect(rows.length, `the home timeline draws its ${testid} rows`).toBe(drawn);
      for (const row of rows) {
        expect(cascaded(row, "content-visibility")).toBe("auto");
        const size = cascaded(row, "contain-intrinsic-size");
        expect(INTRINSIC_SIZE.test(size), `contain-intrinsic-size "${size}" is a positive px size`).toBe(true);
      }
    });
  }
});
