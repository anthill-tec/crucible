// The timeline's rendering draws settled history and nothing else: it takes
// no open runs at all, so no caller can make it read them. The running cards
// are drawn in their own container beside the timeline; a timeline that drew
// them too would be re-rendered by every streamed batch again.
//
// Why this drives the function itself rather than the page: every caller on
// the page today hands the timeline an empty list of open runs, so the page
// looks right whether or not the rendering still accepts them. What could
// bring the defect back is the rendering's own contract: a future caller that
// leaves the open runs out (and gets them read for it) or passes them in. So
// this test calls the page's REAL timeline rendering (`runFeed`,
// public/app.js), inside the REAL page mounted by
// tests/helpers/live-run-harness.ts, the two ways such a caller could, with a
// run open on the page, and checks what it draws. A source-text check would
// pin a spelling; this pins what the rendering does with its arguments.
import { describe, test, expect, afterEach } from "bun:test";
import {
  mountLive,
  unmountLive,
  type EventBriefFixture,
  type LiveMountOpts,
  type OpenRunFixture,
} from "../helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "3c1f7e2a-9b4d-4e6f-8a21-5d0c7b9e4f13";
const NOW = Date.now();

const SETTLED_ID = "evt-settled-only";
const SETTLED_AGENT = "settled-agent";
const OPEN_AGENT = "open-agent";

/** The page's own global the rewritten source hangs the timeline rendering on. */
const HOOK = "__timelineRenderingUnderTest";

type TimelineRendering = (...args: unknown[]) => Element[];

/**
 * public/app.js with one statement added just before the timeline rendering's
 * declaration: it hands the page's own `runFeed` (closure, state and all) to a
 * global, so the test calls exactly what the page calls.
 */
function exposeTimelineRendering(src: string): string {
  const decl = /\n([ \t]*)(?:function\s+runFeed\s*\(|(?:const|let)\s+runFeed\s*=)/g;
  const found = Array.from(src.matchAll(decl));
  if (found.length !== 1) {
    throw new Error(
      `public/app.js declares the timeline rendering runFeed ${String(found.length)} times; this test drives exactly one`,
    );
  }
  const at = found[0]!.index;
  const indent = found[0]![1] ?? "";
  return `${src.slice(0, at)}\n${indent}globalThis.${HOOK} = (...args) => runFeed(...args);${src.slice(at)}`;
}

function settled(): EventBriefFixture {
  return {
    id: SETTLED_ID,
    projectKey: PROJECT_KEY,
    agentId: SETTLED_AGENT,
    kind: "test",
    tier: "unit",
    timestamp: NOW - 60_000,
    total: 5,
    passed: 5,
    failed: 0,
    pending: 0,
    duration_ms: 700,
  };
}

function openRun(): OpenRunFixture {
  return {
    runId: "run-open-now",
    projectKey: PROJECT_KEY,
    agentId: OPEN_AGENT,
    startedAt: NOW - 5_000,
    tier: "unit",
    live: { completed: 3, total: 10, passed: 3, failed: 0, pending: 0 },
  };
}

function board(): LiveMountOpts {
  return {
    pathname: "/",
    projects: [
      {
        key: PROJECT_KEY,
        name: "Timeline Takes No Open Runs",
        type: "backend",
        agentsOnline: 2,
        agentsTotal: 2,
        active: true,
        lastActivity: NOW,
      },
    ],
    agents: [
      { agentId: OPEN_AGENT, projectKey: PROJECT_KEY, liveness: "online", lastSeen: NOW, message: "running" },
      { agentId: SETTLED_AGENT, projectKey: PROJECT_KEY, liveness: "online", lastSeen: NOW, message: "idle" },
    ],
    events: [settled()],
    eventDetails: {},
    openRuns: [openRun()],
    live: {},
    appSource: exposeTimelineRendering,
  };
}

/** Mount the board with a run open, and hand back the page's own timeline rendering. */
async function mountWithARunOpen(): Promise<TimelineRendering> {
  await mountLive(board());
  // The run really is open on the page: its running card is drawn (beside
  // the timeline), so a rendering that read the page's open runs would find it.
  const running = Array.from(document.querySelectorAll('[data-testid="running-card"]'));
  expect(running.length, "the page draws the open run's running card").toBe(1);
  expect(running[0]?.textContent ?? "", "the running card is the open run's").toContain(OPEN_AGENT);
  const rendering = (globalThis as unknown as Record<string, unknown>)[HOOK];
  expect(typeof rendering, "the page's timeline rendering is reachable").toBe("function");
  return rendering as TimelineRendering;
}

/** What each drawn row is, by its test id, and the run id an event card carries. */
function drawn(rows: Element[]): string[] {
  return rows.map((row) => {
    const testid = row.getAttribute("data-testid") ?? "(no test id)";
    const runId = row.getAttribute("data-run-id");
    return runId === null ? testid : `${testid}:${runId}`;
  });
}

/** How many running cards the rows hold, at any depth. */
function runningCardsIn(rows: Element[]): number {
  return rows.filter(
    (row) => row.getAttribute("data-testid") === "running-card" || row.querySelector('[data-testid="running-card"]') !== null,
  ).length;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the timeline's rendering takes no open runs", () => {
  for (const surface of ["workspace", "home"] as const) {
    test(`a ${surface} caller that leaves the open runs out gets the settled rows only, while a run is open on the page`, async () => {
      const rendering = await mountWithARunOpen();
      const rows = rendering([settled()], surface);
      expect(runningCardsIn(rows), "the timeline drew no running card").toBe(0);
      expect(drawn(rows)).toEqual([`event-card:${SETTLED_ID}`]);
    });

    test(`a ${surface} caller that passes open runs in gets the settled rows only`, async () => {
      const rendering = await mountWithARunOpen();
      const rows = rendering([settled()], surface, [openRun()]);
      expect(runningCardsIn(rows), "the timeline drew no running card").toBe(0);
      expect(drawn(rows)).toEqual([`event-card:${SETTLED_ID}`]);
    });
  }
});
