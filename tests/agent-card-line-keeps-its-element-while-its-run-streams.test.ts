// While an agent's run streams, its card's `running …` line keeps its element
// as long as its text is unchanged: a read that serves the same live state
// leaves the line's element in place (the same DOM node), so its hover title
// and a selection in it survive the frame. A read that changes the live state
// moves the line's text.
//
// The card's line (`AgentRow`'s `.app-agent-msg` binding → `agentLiveLine`,
// public/app.js) is re-evaluated on every replacement of the page's open runs
// and of its agents; each evaluation builds a fresh `.app-agent-live` element.
// A re-evaluation whose text is the same must not swap that element out.
//
// Drives the REAL public/app.js with the vendored van/van-x through
// tests/helpers/live-run-harness.ts at the workspace route `/p/<key>`, the
// page opened mid-run, every later read fired by a real stream frame.
import { describe, test, expect, afterEach } from "bun:test";
import {
  mountLive,
  settle,
  unmountLive,
  type AgentFixture,
  type LiveCounts,
  type LiveMounted,
  type LiveMountOpts,
  type OpenRunFixture,
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-card-line-keeps-its-element";
const AGENT_ID = "line-keeper";
const MESSAGE = "gated test run starting";
const RUN_ID = "run-line-keeps-its-element";
const FIRST_FILE = "tests/a-long/path/to/the-first.test.ts";
const NEXT_FILE = "tests/a-long/path/to/the-next.test.ts";
const NOW = Date.now();

function counts(completed: number, total: number, currentFile: string): LiveCounts {
  return { completed, total, passed: completed, failed: 0, pending: 0, currentFile };
}

function openRun(live: LiveCounts): OpenRunFixture {
  return {
    runId: RUN_ID,
    projectKey: PROJECT_KEY,
    agentId: AGENT_ID,
    startedAt: NOW - 3_000,
    tier: "unit",
    live: { ...live },
  };
}

function theAgent(): AgentFixture {
  return { agentId: AGENT_ID, projectKey: PROJECT_KEY, liveness: "online", lastSeen: NOW, message: MESSAGE };
}

function workspace(live: LiveCounts): LiveMountOpts {
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Card Line Keeps Its Element",
        type: "backend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: NOW,
      },
    ],
    agents: [theAgent()],
    events: [],
    eventDetails: {},
    openRuns: [openRun(live)],
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

/** The card's `running …` line element (`.app-agent-live` inside `.app-agent-msg`). */
function lineElement(): HTMLElement {
  const lines = agentRow().querySelectorAll<HTMLElement>(".app-agent-msg .app-agent-live");
  expect(lines, "the card holds exactly one running line").toHaveLength(1);
  return lines[0] as HTMLElement;
}

/** The line's file part, which carries the whole path as its hover title. */
function fileElement(): HTMLElement {
  const files = lineElement().querySelectorAll<HTMLElement>(".app-agent-live-file");
  expect(files).toHaveLength(1);
  return files[0] as HTMLElement;
}

function readsOf(page: LiveMounted, fragment: string): number {
  return page.fetchLog.filter((url) => url.includes(fragment)).length;
}

/** The board's next events answer (a fresh copy of `runs`), read on an `events` frame. */
async function nextEventsAnswer(page: LiveMounted, opts: LiveMountOpts, runs: OpenRunFixture[]): Promise<void> {
  const before = readsOf(page, "/api/v2/events?");
  opts.openRuns.splice(0, opts.openRuns.length, ...runs.map((r) => structuredClone(r)));
  page.source().dispatch("events", PROJECT_KEY);
  await settle();
  expect(readsOf(page, "/api/v2/events?"), "the frame made the page read the events again").toBeGreaterThan(before);
}

/** The board's next agents answer (the same agent, a fresh copy), read on an `agents` frame. */
async function nextAgentsAnswer(page: LiveMounted, opts: LiveMountOpts): Promise<void> {
  const before = readsOf(page, "/api/v2/agents");
  opts.agents.splice(0, opts.agents.length, theAgent());
  page.source().dispatch("agents", PROJECT_KEY);
  await settle();
  expect(readsOf(page, "/api/v2/agents"), "the frame made the page read the agents again").toBe(before + 1);
}

async function openMidRun(live: LiveCounts): Promise<{ page: LiveMounted; opts: LiveMountOpts }> {
  const opts = workspace(live);
  const page = await mountLive(opts);
  page.source().open();
  await settle();
  return { page, opts };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("an agent's card keeps its running line's element while the line's text is unchanged", () => {
  test("an events read serving the same live state leaves the card's running line the same element, its file title intact", async () => {
    const live = counts(3, 9, FIRST_FILE);
    const { page, opts } = await openMidRun(live);
    const line = lineElement();
    const file = fileElement();
    expect(squash(line)).toBe(`running 3/9 · ${FIRST_FILE}`);
    expect(file.getAttribute("title")).toBe(FIRST_FILE);

    await nextEventsAnswer(page, opts, [openRun(live)]);

    expect(lineElement() === line, "the card still holds the same running-line element").toBe(true);
    expect(line.isConnected).toBe(true);
    expect(fileElement() === file, "the line still holds the same file element").toBe(true);
    expect(file.getAttribute("title")).toBe(FIRST_FILE);
    expect(squash(line)).toBe(`running 3/9 · ${FIRST_FILE}`);

    // And again: a second unchanged frame keeps it too.
    await nextEventsAnswer(page, opts, [openRun(live)]);
    expect(lineElement() === line, "the card still holds the same running-line element").toBe(true);
  });

  test("an agents read serving the same agent mid-run leaves the card's running line the same element", async () => {
    const live = counts(4, 9, FIRST_FILE);
    const { page, opts } = await openMidRun(live);
    const line = lineElement();
    expect(squash(line)).toBe(`running 4/9 · ${FIRST_FILE}`);

    await nextAgentsAnswer(page, opts);

    expect(lineElement() === line, "the card still holds the same running-line element").toBe(true);
    expect(line.isConnected).toBe(true);
    expect(squash(line)).toBe(`running 4/9 · ${FIRST_FILE}`);
  });

  test("an events read that moves the live state moves the line's text, and the next unchanged read keeps that new line's element", async () => {
    const { page, opts } = await openMidRun(counts(3, 9, FIRST_FILE));
    expect(squash(lineElement())).toBe(`running 3/9 · ${FIRST_FILE}`);

    await nextEventsAnswer(page, opts, [openRun(counts(5, 9, NEXT_FILE))]);

    const moved = lineElement();
    expect(squash(moved)).toBe(`running 5/9 · ${NEXT_FILE}`);
    expect(squash(moved)).not.toContain(FIRST_FILE);
    expect(fileElement().getAttribute("title")).toBe(NEXT_FILE);

    await nextEventsAnswer(page, opts, [openRun(counts(5, 9, NEXT_FILE))]);

    expect(lineElement() === moved, "the card still holds the moved line's element").toBe(true);
    expect(squash(moved)).toBe(`running 5/9 · ${NEXT_FILE}`);
  });
});
