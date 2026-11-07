// The Runs timeline's rows — run cards, aborted run cards, transition markers
// and milestone entries — let the browser skip their style and layout while
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
} from "./helpers/live-run-harness";

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

function workspace(): LiveMountOpts {
  return {
    pathname: `/p/${PROJECT_KEY}`,
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
    events: events(),
    eventDetails: {},
    openRuns: [],
    live: {},
  };
}

async function mountOnRuns(): Promise<void> {
  await mountLive(workspace());
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

  for (const [testid, drawn] of Object.entries(ROWS)) {
    test(`every ${testid} row on the Runs timeline carries content-visibility: auto with an intrinsic size`, async () => {
      await mountOnRuns();
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
