// On the Runs tab, a streamed batch (an events read that changes only the open
// runs) touches only what is live: the timeline of settled runs is not
// re-rendered, the running cards sit in a container of their own that stays in
// place while a run opens, streams and closes, and no live update adds or
// removes a child of the pane's runway (`.app-pane-runway`, the wrapper
// `WorkspaceRunsFeed` in public/app.js puts the timeline in). The running card
// still follows each batch, and a run that settles leaves the running cards
// and joins the timeline in the same read.
//
// Drives the REAL public/app.js with the vendored van/van-x through
// tests/helpers/live-run-harness.ts at the workspace route `/p/<key>`, on the
// Runs tab. Each events read answers a fresh copy of the same settled history,
// as the board's JSON does, so a batch differs from the read before it only in
// its open runs.
//
// Node identity is compared with `===` and reported as a boolean: a page node
// is never handed to `expect` whole.
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

const PROJECT_KEY = "0f3c2a71-5d1e-4b8a-9c6f-runs-stay-put";
const STREAMING_AGENT = "streaming-agent";
const HISTORY_AGENT = "history-agent";
const RUN_ID = "run-streaming-over-history";
const SETTLED_ID = "evt-the-streamed-run-settled";
const HISTORY_SIZE = 30;
const BATCHES = 5;
const NOW = Date.now();

function counts(completed: number): LiveCounts {
  return {
    completed,
    total: BATCHES,
    passed: completed,
    failed: 0,
    pending: 0,
    currentFile: `src/batch-${String(completed)}.test.ts`,
  };
}

function openRun(live?: LiveCounts): OpenRunFixture {
  return {
    runId: RUN_ID,
    projectKey: PROJECT_KEY,
    agentId: STREAMING_AGENT,
    startedAt: NOW - 5_000,
    tier: "unit",
    ...(live !== undefined ? { live: { ...live } } : {}),
  };
}

function settledBrief(id: string, agentId: string, timestamp: number): EventBriefFixture {
  return {
    id,
    projectKey: PROJECT_KEY,
    agentId,
    kind: "test",
    tier: "unit",
    timestamp,
    total: 5,
    passed: 5,
    failed: 0,
    pending: 0,
    duration_ms: 800,
  };
}

/** The settled history, newest first, as the board serves it. */
function history(): EventBriefFixture[] {
  return Array.from({ length: HISTORY_SIZE }, (_, i) =>
    settledBrief(`evt-history-${String(i).padStart(2, "0")}`, HISTORY_AGENT, NOW - 60_000 * (i + 1)),
  );
}

function workspace(openRuns: OpenRunFixture[]): LiveMountOpts {
  const agents: AgentFixture[] = [
    { agentId: STREAMING_AGENT, projectKey: PROJECT_KEY, liveness: "online", lastSeen: NOW, message: "gated test run starting" },
    { agentId: HISTORY_AGENT, projectKey: PROJECT_KEY, liveness: "online", lastSeen: NOW, message: "between runs" },
  ];
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Runs Stay Put",
        type: "backend",
        agentsOnline: 2,
        agentsTotal: 2,
        active: true,
        lastActivity: NOW,
      },
    ],
    agents,
    events: history(),
    eventDetails: {},
    openRuns,
    live: {},
  };
}

function squash(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function runsTab(): HTMLElement {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).filter(
    (t) => squash(t) === "Runs",
  );
  expect(tabs, "exactly one Runs workspace tab").toHaveLength(1);
  return tabs[0] as HTMLElement;
}

/** Mount the workspace and put the Runs view on screen. */
async function mountOnRuns(opts: LiveMountOpts): Promise<LiveMounted> {
  const page = await mountLive(opts);
  expect(runsTab().hasAttribute("disabled"), "the Runs tab is enabled").toBe(false);
  runsTab().click();
  await settle();
  expect(runsTab().className.split(/\s+/)).toContain("on");
  page.source().open();
  return page;
}

/** The board's next events answer: a fresh copy of `events`, and `runs` open. */
async function nextEventsAnswer(
  page: LiveMounted,
  opts: LiveMountOpts,
  runs: OpenRunFixture[],
  events: EventBriefFixture[] = history(),
): Promise<void> {
  opts.openRuns.splice(0, opts.openRuns.length, ...runs.map((r) => structuredClone(r)));
  opts.events.splice(0, opts.events.length, ...events.map((e) => structuredClone(e)));
  page.source().dispatch("events", PROJECT_KEY);
  await settle();
}

/** The Runs pane's runway: the wrapper the timeline sits in. */
function runway(): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>('[data-testid="workspace-runs"] .app-pane-runway');
  expect(found.length, "the Runs pane has exactly one runway").toBe(1);
  return found[0] as HTMLElement;
}

/** The newest settled card in the timeline. */
function firstCard(): HTMLElement {
  const card = runway().querySelector<HTMLElement>('[data-testid="event-card"]');
  expect(card !== null, "the timeline shows a settled card").toBe(true);
  return card as HTMLElement;
}

/** The timeline's element: the one that holds the settled cards. */
function timeline(): HTMLElement {
  const parent = firstCard().parentElement;
  expect(parent !== null, "the first settled card sits in an element").toBe(true);
  return parent as HTMLElement;
}

function runningCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="running-card"]'));
}

function runningCardIds(): (string | null)[] {
  return runningCards().map((card) => card.getAttribute("data-run-id"));
}

/** The one running card's done-of-total. */
function runningCount(): string {
  const cards = runningCards();
  expect(cards.length, "exactly one running card").toBe(1);
  return squash(cards[0]?.querySelector('[data-testid="running-count"]'));
}

function settledCardIds(): (string | null)[] {
  return Array.from(runway().querySelectorAll<HTMLElement>('[data-testid="event-card"]')).map((card) =>
    card.getAttribute("data-run-id"),
  );
}

/**
 * The running cards' container: the nearest ancestor of the running card,
 * inside the runway, that was already in the page before the run opened and
 * holds no settled card. Null when the running card has no such ancestor.
 */
function runningContainer(card: HTMLElement, before: ReadonlySet<Element>): HTMLElement | null {
  const pane = runway();
  let node = card.parentElement;
  while (node !== null && node !== pane) {
    if (before.has(node) && node.querySelector('[data-testid="event-card"]') === null) return node;
    node = node.parentElement;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a streamed batch leaves the Runs timeline's nodes in place", () => {
  test("batches that change only the open run keep the timeline and its first card the same nodes while the running card's count follows, and the settled run then joins the timeline", async () => {
    const opts = workspace([openRun(counts(1))]);
    const page = await mountOnRuns(opts);
    expect(runningCount()).toBe(`1/${String(BATCHES)}`);
    const timelineBefore = timeline();
    const firstBefore = firstCard();
    expect(firstBefore.getAttribute("data-run-id")).toBe("evt-history-00");

    for (let n = 2; n <= BATCHES; n += 1) {
      await nextEventsAnswer(page, opts, [openRun(counts(n))]);
      expect(runningCount()).toBe(`${String(n)}/${String(BATCHES)}`);
      expect(timeline() === timelineBefore, `after batch ${String(n)} the timeline is the same node`).toBe(true);
      expect(firstCard() === firstBefore, `after batch ${String(n)} the first card is the same node`).toBe(true);
    }

    await nextEventsAnswer(page, opts, [], [settledBrief(SETTLED_ID, STREAMING_AGENT, NOW + 1_000), ...history()]);
    expect(runningCardIds()).toEqual([]);
    const settled = settledCardIds();
    expect(settled).toHaveLength(HISTORY_SIZE + 1);
    expect(settled[0]).toBe(SETTLED_ID);
    expect(settled.filter((id) => id === SETTLED_ID)).toHaveLength(1);
  });

  test("the read that opens a run and every batch after it keep the timeline and its first card the same nodes", async () => {
    const opts = workspace([]);
    const page = await mountOnRuns(opts);
    expect(runningCardIds()).toEqual([]);
    const timelineBefore = timeline();
    const firstBefore = firstCard();

    await nextEventsAnswer(page, opts, [openRun()]);
    expect(runningCardIds()).toEqual([RUN_ID]);
    expect(timeline() === timelineBefore, "after the run opens the timeline is the same node").toBe(true);
    expect(firstCard() === firstBefore, "after the run opens the first card is the same node").toBe(true);

    for (let n = 1; n <= BATCHES; n += 1) {
      await nextEventsAnswer(page, opts, [openRun(counts(n))]);
      expect(runningCount()).toBe(`${String(n)}/${String(BATCHES)}`);
      expect(timeline() === timelineBefore, `after batch ${String(n)} the timeline is the same node`).toBe(true);
      expect(firstCard() === firstBefore, `after batch ${String(n)} the first card is the same node`).toBe(true);
    }
  });
});

describe("the running cards keep one container and the runway keeps its children", () => {
  test("the running cards' container is the same node from before the run opens to after it closes", async () => {
    const opts = workspace([]);
    const page = await mountOnRuns(opts);
    const before = new Set<Element>(runway().querySelectorAll("*"));

    await nextEventsAnswer(page, opts, [openRun()]);
    const opened = runningCards();
    expect(opened.length, "the opened run shows one running card").toBe(1);
    const container = runningContainer(opened[0] as HTMLElement, before);
    expect(container !== null, "the running card sits in a container that was in the page before the run opened").toBe(
      true,
    );

    for (let n = 1; n <= BATCHES; n += 1) {
      await nextEventsAnswer(page, opts, [openRun(counts(n))]);
      const cards = runningCards();
      expect(cards.length, `batch ${String(n)} shows one running card`).toBe(1);
      expect(container?.contains(cards[0] as HTMLElement) === true, `batch ${String(n)}'s running card is in the same container`).toBe(
        true,
      );
    }

    await nextEventsAnswer(page, opts, [], [settledBrief(SETTLED_ID, STREAMING_AGENT, NOW + 1_000), ...history()]);
    expect(runningCardIds()).toEqual([]);
    expect(container?.isConnected === true, "the container is still in the page after the run closes").toBe(true);
    expect(runway().contains(container as HTMLElement), "the container is still inside the runway").toBe(true);
    expect(container?.querySelector('[data-testid="event-card"]') === null, "the container holds no settled card").toBe(true);
  });

  test("neither the read that opens a run nor any of its batches adds or removes a child of the pane's runway", async () => {
    const opts = workspace([]);
    const page = await mountOnRuns(opts);
    const pane = runway();
    const childrenBefore = Array.from(pane.children);
    let added = 0;
    let removed = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        added += r.addedNodes.length;
        removed += r.removedNodes.length;
      }
    });
    observer.observe(pane, { childList: true });

    await nextEventsAnswer(page, opts, [openRun()]);
    expect(runningCardIds()).toEqual([RUN_ID]);
    for (let n = 1; n <= BATCHES; n += 1) {
      await nextEventsAnswer(page, opts, [openRun(counts(n))]);
      expect(runningCount()).toBe(`${String(n)}/${String(BATCHES)}`);
    }
    for (const r of observer.takeRecords()) {
      added += r.addedNodes.length;
      removed += r.removedNodes.length;
    }
    observer.disconnect();

    expect({ added, removed }).toEqual({ added: 0, removed: 0 });
    const childrenAfter = Array.from(pane.children);
    expect(childrenAfter.length).toBe(childrenBefore.length);
    expect(
      childrenAfter.every((child, i) => child === childrenBefore[i]),
      "the runway holds the same children, in the same order",
    ).toBe(true);
  });
});
