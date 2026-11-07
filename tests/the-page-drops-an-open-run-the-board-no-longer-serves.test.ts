// A page holding an open run the board no longer serves drops it on its next
// read: the agent's card reads its own line again, loses its streaming mark,
// and the Runs view shows no running card for that run.
//
// The page holds the open runs in `state.openRuns`, whose one writer
// (`refetchEvents`, public/app.js) replaces the whole slice from each events
// read. The card (`AgentRow` → `agentLiveLine`, `isStreamingAgent`) and the
// Runs view's running card (`RunningCard`, built inside `runFeed`) read that
// slice. A run the board stopped serving — settled, aborted or swept — must
// be gone from all three after the next events read, whether or not it ever
// carried live counts, and a newer run the board serves in its place is the
// only one shown.
//
// Drives the REAL public/app.js with the vendored van/van-x through
// tests/helpers/live-run-harness.ts at the workspace route `/p/<key>`, on the
// Runs tab so the running card and the card are both on screen.
import { describe, test, expect, afterEach } from "bun:test";
import {
  mountLive,
  settle,
  unmountLive,
  type AgentFixture,
  type EventBriefFixture,
  type LiveCounts,
  type LiveMounted,
  type LiveMountOpts,
  type OpenRunFixture,
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-drops-a-run-no-longer-served";
const AGENT_ID = "dropped-run-agent";
const MESSAGE = "gated test run starting";
const IDLE_LINE = "idle · RED · no cycle bound · last run 4 ✓ 1 ✗ · ingested, just now";
const RUN_ID = "run-no-longer-served";
const NOW = Date.now();

function counts(completed: number, total: number, currentFile: string): LiveCounts {
  return { completed, total, passed: completed, failed: 0, pending: 0, currentFile };
}

function openRun(runId: string, startedAt: number, live?: LiveCounts): OpenRunFixture {
  return {
    runId,
    projectKey: PROJECT_KEY,
    agentId: AGENT_ID,
    startedAt,
    tier: "unit",
    ...(live !== undefined ? { live: { ...live } } : {}),
  };
}

function workspace(openRuns: OpenRunFixture[]): LiveMountOpts {
  const agent: AgentFixture = { agentId: AGENT_ID, projectKey: PROJECT_KEY, liveness: "online", lastSeen: NOW, message: MESSAGE };
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Drops A Run",
        type: "backend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: NOW,
      },
    ],
    agents: [agent],
    events: [],
    eventDetails: {},
    openRuns,
    live: {},
  };
}

function squash(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function agentRow(): HTMLElement {
  const pane = document.querySelector('[data-testid="project-pane"]');
  expect(pane, "the workspace renders its Project pane").not.toBeNull();
  const rows = Array.from(pane?.querySelectorAll<HTMLElement>('[data-testid="agent-row"]') ?? []).filter((row) =>
    (row.textContent ?? "").includes(AGENT_ID),
  );
  expect(rows).toHaveLength(1);
  return rows[0] as HTMLElement;
}

function cardLine(): string {
  const msg = agentRow().querySelector(".app-agent-msg");
  expect(msg, `the card of ${AGENT_ID} has its .app-agent-msg`).not.toBeNull();
  return squash(msg);
}

function isStreamingMarked(): boolean {
  return agentRow().className.split(/\s+/).includes("app-agent-streaming");
}

/** The run ids of every running card on screen, in order. */
function runningCardIds(): (string | null)[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="running-card"]')).map((card) =>
    card.getAttribute("data-run-id"),
  );
}

function runsTab(): HTMLElement {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).filter(
    (t) => squash(t) === "Runs",
  );
  expect(tabs, "exactly one Runs workspace tab").toHaveLength(1);
  return tabs[0] as HTMLElement;
}

/** Mount the workspace and put the Runs view on screen beside the Project pane. */
async function mountOnRuns(opts: LiveMountOpts): Promise<LiveMounted> {
  const page = await mountLive(opts);
  expect(runsTab().hasAttribute("disabled"), "the Runs tab is enabled").toBe(false);
  runsTab().click();
  await settle();
  expect(runsTab().className.split(/\s+/)).toContain("on");
  return page;
}

/** The board's next events answer, read by the page on an `events` frame. */
async function nextEventsAnswer(
  page: LiveMounted,
  opts: LiveMountOpts,
  runs: OpenRunFixture[],
  events: EventBriefFixture[] = opts.events,
): Promise<void> {
  opts.openRuns.splice(0, opts.openRuns.length, ...runs.map((r) => structuredClone(r)));
  opts.events.splice(0, opts.events.length, ...events);
  page.source().dispatch("events", PROJECT_KEY);
  await settle();
}

function settledBrief(id: string): EventBriefFixture {
  return {
    id,
    projectKey: PROJECT_KEY,
    agentId: AGENT_ID,
    kind: "test",
    tier: "unit",
    timestamp: NOW,
    total: 5,
    passed: 4,
    failed: 1,
    pending: 0,
    duration_ms: 900,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a page drops an open run the board no longer serves on its next read", () => {
  test("a streaming run the board settles: the next events read leaves the card on its message, unmarked, and the Runs view with no running card", async () => {
    const opts = workspace([openRun(RUN_ID, NOW - 5_000, counts(4, 5, "d.ts"))]);
    const page = await mountOnRuns(opts);
    expect(cardLine()).toBe("running 4/5 · d.ts");
    expect(isStreamingMarked()).toBe(true);
    expect(runningCardIds()).toEqual([RUN_ID]);
    page.source().open();

    await nextEventsAnswer(page, opts, [], [settledBrief("evt-settled-run")]);
    expect(cardLine()).toBe(MESSAGE);
    expect(isStreamingMarked()).toBe(false);
    expect(runningCardIds()).toEqual([]);
  });

  test("a run the board stops serving before its first batch: the next events read drops the plain running card and the streaming mark", async () => {
    const opts = workspace([openRun(RUN_ID, NOW - 5_000)]);
    const page = await mountOnRuns(opts);
    expect(cardLine()).toBe(MESSAGE);
    expect(isStreamingMarked()).toBe(true);
    expect(runningCardIds()).toEqual([RUN_ID]);
    page.source().open();

    await nextEventsAnswer(page, opts, []);
    expect(isStreamingMarked()).toBe(false);
    expect(cardLine()).toBe(MESSAGE);
    expect(runningCardIds()).toEqual([]);
  });

  test("the board settles the run and serves the agent's idle line: once both reads land the card reads that idle line, not the run's", async () => {
    const opts = workspace([openRun(RUN_ID, NOW - 5_000, counts(4, 5, "d.ts"))]);
    const page = await mountOnRuns(opts);
    expect(cardLine()).toBe("running 4/5 · d.ts");
    page.source().open();

    await nextEventsAnswer(page, opts, [], [settledBrief("evt-settled-idle")]);
    // As the board serves the agent after the closing ingest touched it: the
    // ingest's tally as its message, a newer last seen, and its idle line.
    const settledAgent: AgentFixture & { idleLine: string } = {
      agentId: AGENT_ID,
      projectKey: PROJECT_KEY,
      liveness: "online",
      lastSeen: NOW + 1_000,
      message: "4 ✓ 1 ✗ · ingested",
      idleLine: IDLE_LINE,
    };
    opts.agents.splice(0, opts.agents.length, settledAgent);
    page.source().dispatch("agents", PROJECT_KEY);
    await settle();

    expect(cardLine()).toBe(IDLE_LINE);
    expect(isStreamingMarked()).toBe(false);
    expect(runningCardIds()).toEqual([]);
  });

  test("the board serves a newer run of the agent in the old one's place: the page holds only the newer run — one running card, and the card reads the newer run's line", async () => {
    const opts = workspace([openRun(RUN_ID, NOW - 9_000, counts(4, 5, "d.ts"))]);
    const page = await mountOnRuns(opts);
    expect(runningCardIds()).toEqual([RUN_ID]);
    page.source().open();

    await nextEventsAnswer(page, opts, [openRun(`${RUN_ID}-newer`, NOW - 1_000, counts(1, 8, "a.ts"))], [
      settledBrief("evt-settled-older"),
    ]);
    expect(runningCardIds()).toEqual([`${RUN_ID}-newer`]);
    expect(cardLine()).toBe("running 1/8 · a.ts");
    expect(isStreamingMarked()).toBe(true);
  });
});
