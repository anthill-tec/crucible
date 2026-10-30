// The run detail of a run whose stream could not be trusted says so: its
// header states `incomplete — <reason>` in the fail colour, and for an aborted
// streamed run it stands beside the abort banner, which still leads the body.
// A run with no `incomplete` key shows no such statement.
//
// Drives the REAL public/app.js through tests/helpers/live-run-harness.ts (the
// harness tests/live-run-drill-in.test.ts uses): the event detail read is a
// stubbed read answering the stored event as `GET /api/v2/events/<id>` serves
// it, `incomplete` included.
//
// Testid this file names for the statement:
//   run-incomplete   the `incomplete — <reason>` statement in the run detail's
//                    header (`.app-drillin-head`, the band pinned above the pane)
// The colour is read through the harness's cascade over public/styles.css:
// the statement's `color` resolves to the fail colour, `var(--fail)`.
import { describe, test, expect, afterEach } from "bun:test";
import {
  cascaded,
  mountLive,
  unmountLive,
  type EventBriefFixture,
  type EventDetailFixture,
  type LiveMountOpts,
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-incomplete-detail";
const AGENT_ID = "CR-CRU-224-840-GREEN";

type IncompleteDetail = EventDetailFixture & { incomplete?: string };
type IncompleteBrief = EventBriefFixture & { incomplete?: string };

function settled(
  eventId: string,
  extra: { incomplete?: string; status?: "aborted"; abortReason?: string },
): { brief: IncompleteBrief; detail: IncompleteDetail } {
  const now = Date.now();
  const common = {
    id: eventId,
    projectKey: PROJECT_KEY,
    agentId: AGENT_ID,
    kind: "test" as const,
    tier: "unit",
    codec: "crucible-events",
    timestamp: now,
    ...extra,
  };
  return {
    brief: { ...common, total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 7 },
    detail: {
      ...common,
      summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 7 },
      tree: [
        {
          name: "StreamedSuite",
          status: "fail",
          children: [
            { name: "passLeaf", status: "pass", duration_ms: 3 },
            { name: "failLeaf", status: "fail", duration_ms: 4, failure: { message: "expected 1" } },
          ],
        },
      ],
    },
  };
}

function fixture(event: { brief: IncompleteBrief; detail: IncompleteDetail }): LiveMountOpts {
  return {
    pathname: `/run/${event.brief.id}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Incomplete Detail Project",
        type: "backend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: Date.now(),
        retention: 100,
      },
    ],
    agents: [{ agentId: AGENT_ID, projectKey: PROJECT_KEY, liveness: "online", lastSeen: Date.now() }],
    events: [event.brief],
    eventDetails: { [event.brief.id]: event.detail },
    openRuns: [],
    live: {},
  };
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The run detail's header: the band pinned above the pane. */
function header(): Element {
  const head = document.querySelector(".app-drillin-head");
  expect(head, "the run detail renders its header band").not.toBeNull();
  return head!;
}

function statements(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('[data-testid="run-incomplete"]'));
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the run detail's header states an incomplete stream's reason", () => {
  test("a streamed run flagged incomplete: the header states `incomplete — <reason>`, exactly once, in the fail colour", async () => {
    const event = settled("evt-incomplete-ended-1", { incomplete: "no run-end" });
    await mountLive(fixture(event));
    expect(text(document.querySelector('[data-testid="run-overlay"]'))).toContain("StreamedSuite");
    const found = statements(header());
    expect(found.length).toBe(1);
    expect(text(found[0]!)).toBe("incomplete — no run-end");
    expect(cascaded(found[0]!, "color")).toBe("var(--fail)");
  });

  test("every reason the stream holds is stated as stored, joined as the board joined them", async () => {
    const reason = "run-end states total 3, passed 3, failed 0, pending 0, the tests count total 2, passed 1, failed 1, pending 0; 1 undecodable line";
    const event = settled("evt-incomplete-ended-2", { incomplete: reason });
    await mountLive(fixture(event));
    const found = statements(header());
    expect(found.length).toBe(1);
    expect(text(found[0]!)).toBe(`incomplete — ${reason}`);
  });

  test("an aborted streamed run: the header states its incomplete reason beside the abort banner, which still names why it was aborted", async () => {
    const event = settled("evt-incomplete-aborted-1", {
      incomplete: "no run-end",
      status: "aborted",
      abortReason: "agent died",
    });
    await mountLive(fixture(event));
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(text(overlay?.querySelector('[data-testid="abort-reason"]') ?? null)).toBe("aborted — agent died");
    const found = statements(header());
    expect(found.length).toBe(1);
    expect(text(found[0]!)).toBe("incomplete — no run-end");
    expect(cascaded(found[0]!, "color")).toBe("var(--fail)");
    // The streamed tests the aborted run kept still render beneath the banner.
    expect(text(overlay)).toContain("StreamedSuite");
  });

  test("a run with no incomplete key shows no incomplete statement anywhere on the page", async () => {
    const event = settled("evt-complete-1", {});
    await mountLive(fixture(event));
    expect(text(document.querySelector('[data-testid="run-overlay"]'))).toContain("StreamedSuite");
    expect(statements(document)).toEqual([]);
    expect(text(header())).not.toContain("incomplete");
  });

  test("an aborted run that streamed nothing shows its abort banner and no incomplete statement", async () => {
    const event = settled("evt-aborted-quiet-1", { status: "aborted", abortReason: "runner crashed" });
    await mountLive(fixture(event));
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(text(overlay?.querySelector('[data-testid="abort-reason"]') ?? null)).toBe("aborted — runner crashed");
    expect(statements(document)).toEqual([]);
  });
});
