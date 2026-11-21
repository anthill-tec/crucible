// An open run's live counts reach the page from the FIRST answer that carries
// them — not only from the first answer the page ever saw.
//
// The board serves an open run WITHOUT `live` until its first stream batch
// lands, and with `live` from then on. The page holds every open run it is
// served in `state.openRuns` (filled by `refetchEvents`, public/app.js); the
// agent row (`AgentRow` → `agentLiveLine`) and the Runs tab's running card
// (`RunningCard`, built inside `runFeed`) read `run.live` from that slice.
// A binding that read `live` while the run had none must still re-run when a
// later answer fills it, so that:
//
//   - the agent row moves from the agent's message to
//     `running <done>/<total> · <current file>` and on with each later answer;
//   - a run that opens after a settled one did the same;
//   - the running card on screen turns into the live card — progress line,
//     counts, current file, clickable into the live drill-in;
//   - the row reads the same line on every workspace tab, and a later
//     answer's counts reach it on whichever tab is open;
//   - a run with no batch yet still reads the agent's message and a plain card.
//
// Every test FIRST serves the open run without `live`, and only a LATER
// answer — fetched through the page's own refetch, driven by an `events`
// frame on its live stream — carries it. The existing tests of the live line
// and the live card seed `live` from the first answer, which never exercises
// this transition.
//
// Drives the REAL public/app.js with the vendored van/van-x through
// tests/helpers/live-run-harness.ts at the workspace route `/p/<key>`.
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
  type ProjectFixture,
} from "../helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-open-run-live-slot";
const AGENT_ID = "gated-runner";
const MESSAGE = "gated test run starting";
const RUN_A = "run-0190-live-slot-a";
const RUN_B = "run-0190-live-slot-b";
const NOW = Date.now();

const WORKSPACE_TABS = ["Roadmap", "Runs", "Workflow", "Coverage", "BDD", "Compile"] as const;
type WorkspaceTabName = (typeof WORKSPACE_TABS)[number];

function counts(completed: number, total: number, currentFile: string, failed = 0): LiveCounts {
  return { completed, total, passed: completed - failed, failed, pending: 0, currentFile };
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

/** A frontend project with a coverage event, so all six workspace tabs are enabled. */
function workspace(openRuns: OpenRunFixture[]): LiveMountOpts {
  const project: ProjectFixture & { latestCoverageEventId: string } = {
    key: PROJECT_KEY,
    name: "Open Run Live Slot",
    type: "frontend",
    agentsOnline: 1,
    agentsTotal: 1,
    active: true,
    lastActivity: NOW,
    latestCoverageEventId: "evt-coverage-0001",
  };
  const agent: AgentFixture = {
    agentId: AGENT_ID,
    projectKey: PROJECT_KEY,
    liveness: "online",
    lastSeen: NOW,
    message: MESSAGE,
  };
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [project],
    agents: [agent],
    events: [],
    eventDetails: {},
    openRuns,
    live: {},
  };
}

/**
 * The board's next answer: the events feed now serves exactly `runs` (fresh
 * objects, as a new JSON answer would be), and an `events` frame on the
 * page's live stream makes the page fetch it.
 */
async function nextAnswer(page: LiveMounted, opts: LiveMountOpts, runs: OpenRunFixture[]): Promise<void> {
  opts.openRuns.splice(0, opts.openRuns.length, ...runs.map((r) => structuredClone(r)));
  const source = page.source();
  source.open();
  source.dispatch("events", PROJECT_KEY);
  await settle();
}

function squash(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The `.app-agent-msg` text of the agent's one row in the Project pane. */
function agentLine(): string {
  const pane = document.querySelector('[data-testid="project-pane"]');
  expect(pane, "the workspace renders its Project pane").not.toBeNull();
  const rows = Array.from(pane?.querySelectorAll('[data-testid="agent-row"]') ?? []).filter((row) =>
    (row.textContent ?? "").includes(AGENT_ID),
  );
  expect(rows).toHaveLength(1);
  const msg = rows[0]?.querySelector(".app-agent-msg");
  expect(msg, `the agent row for ${AGENT_ID} has its .app-agent-msg`).not.toBeNull();
  return squash(msg);
}

function workspaceTab(name: WorkspaceTabName): HTMLElement {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).filter(
    (t) => squash(t) === name,
  );
  expect(tabs, `exactly one ${name} workspace tab`).toHaveLength(1);
  return tabs[0] as HTMLElement;
}

async function selectTab(name: WorkspaceTabName): Promise<void> {
  const tab = workspaceTab(name);
  expect(tab.hasAttribute("disabled"), `the ${name} tab is enabled`).toBe(false);
  tab.click();
  await settle();
  expect(workspaceTab(name).className.split(/\s+/)).toContain("on");
}

function runningCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="running-card"]'));
}

function theRunningCard(runId: string): HTMLElement {
  const cards = runningCards();
  expect(cards, "exactly one running card").toHaveLength(1);
  const card = cards[0] as HTMLElement;
  expect(card.getAttribute("data-run-id")).toBe(runId);
  return card;
}

function part(card: HTMLElement, testid: string): HTMLElement | null {
  return card.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

/** A plain running card: not the live variant, no progress, `running…`. */
function expectPlainCard(card: HTMLElement): void {
  expect(card.className.split(/\s+/)).not.toContain("app-evt-running-live");
  expect(squash(part(card, "running-label"))).toBe("running…");
  expect(part(card, "running-count")).toBeNull();
  expect(part(card, "running-file")).toBeNull();
  expect(part(card, "running-progress")).toBeNull();
  expect(part(card, "running-open-hint")).toBeNull();
}

/** A witness a reload would destroy. */
function plantNoReloadWitness(): void {
  (window as unknown as Record<string, unknown>).__liveSlotNoReload = "sentinel";
}
function expectNoReload(): void {
  expect((window as unknown as Record<string, unknown>).__liveSlotNoReload).toBe("sentinel");
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the agent row follows an open run served without `live` from its first batch", () => {
  test("first answer without `live` reads the agent's message; the answer with 5 of 40 in a.py reads `running 5/40 · a.py`; the next, 12 of 40 in b.py, reads `running 12/40 · b.py` — no reload", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    expect(agentLine()).toBe(MESSAGE);
    plantNoReloadWitness();
    const pushedBefore = [...page.pushed];

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(5, 40, "a.py"))]);
    expect(agentLine()).toBe("running 5/40 · a.py");

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(12, 40, "b.py"))]);
    expect(agentLine()).toBe("running 12/40 · b.py");

    // The same page throughout: nothing navigated, nothing reloaded.
    expect(page.pushed).toEqual(pushedBefore);
    expectNoReload();
  });

  test("answers that keep serving the run without `live` keep the agent's message, then the first answer with `live` moves the row", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000)]);
    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000)]);
    expect(agentLine()).toBe(MESSAGE);

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(1, 40, "a.py"))]);
    expect(agentLine()).toBe("running 1/40 · a.py");
  });

  test("run A settles, run B opens without `live`, then B's `live` arrives: the row reads B's counts", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 60_000, counts(30, 40, "a_last.py"))]);
    const page = await mountLive(opts);
    expect(agentLine()).toBe("running 30/40 · a_last.py");

    // A settles: the board drops it from the open runs.
    await nextAnswer(page, opts, []);
    expect(agentLine()).toBe(MESSAGE);

    // B opens in the slot A held, with no batch yet.
    await nextAnswer(page, opts, [openRun(RUN_B, NOW - 1_000)]);
    expect(agentLine()).toBe(MESSAGE);

    await nextAnswer(page, opts, [openRun(RUN_B, NOW - 1_000, counts(7, 90, "b_first.py"))]);
    expect(agentLine()).toBe("running 7/90 · b_first.py");

    await nextAnswer(page, opts, [openRun(RUN_B, NOW - 1_000, counts(8, 90, "b_second.py"))]);
    expect(agentLine()).toBe("running 8/90 · b_second.py");
  });

  test("run B replaces settled run A in the same answer, without `live`, then B's `live` arrives: the row reads B's counts", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 60_000, counts(40, 40, "a_last.py"))]);
    const page = await mountLive(opts);
    expect(agentLine()).toBe("running 40/40 · a_last.py");

    await nextAnswer(page, opts, [openRun(RUN_B, NOW - 1_000)]);
    expect(agentLine()).toBe(MESSAGE);

    await nextAnswer(page, opts, [openRun(RUN_B, NOW - 1_000, counts(3, 17, "b_first.py"))]);
    expect(agentLine()).toBe("running 3/17 · b_first.py");
  });
});

describe("the running card on the Runs tab follows an open run served without `live` from its first batch", () => {
  test("first rendered without `live` the card is plain and a click opens nothing; when `live` arrives it shows the progress line with the counts and a click opens the live drill-in", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    await selectTab("Runs");
    plantNoReloadWitness();

    const plain = theRunningCard(RUN_A);
    expectPlainCard(plain);
    const pathBefore = location.pathname;
    const pushedBefore = [...page.pushed];
    plain.click();
    await settle();
    expect(location.pathname).toBe(pathBefore);
    expect(page.pushed).toEqual(pushedBefore);

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(10, 40, "a.py", 2))]);
    const card = theRunningCard(RUN_A);
    expect(card.className.split(/\s+/)).toContain("app-evt-running-live");
    expect(squash(part(card, "running-count"))).toBe("10/40");
    expect(squash(part(card, "running-file"))).toBe("a.py");
    expect(squash(part(card, "running-failed"))).toBe("2 ✗");
    expect(part(card, "running-progress")).not.toBeNull();
    expect(part(card, "running-progress-fill")?.style.width).toBe("25%");
    expect(squash(part(card, "running-open-hint"))).toBe("› open");
    expect(part(card, "running-label")).toBeNull();
    expectNoReload();

    card.click();
    await settle();
    expect(location.pathname).toBe(`/p/${PROJECT_KEY}/run/${RUN_A}`);
    expect(page.pushed).toEqual([...pushedBefore, `/p/${PROJECT_KEY}/run/${RUN_A}`]);
  });

  test("the live card moves with each later answer: 10 of 40 in a.py, then 12 of 40 in b.py", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    await selectTab("Runs");
    expectPlainCard(theRunningCard(RUN_A));

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(10, 40, "a.py"))]);
    expect(squash(part(theRunningCard(RUN_A), "running-count"))).toBe("10/40");

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(12, 40, "b.py"))]);
    const card = theRunningCard(RUN_A);
    expect(squash(part(card, "running-count"))).toBe("12/40");
    expect(squash(part(card, "running-file"))).toBe("b.py");
  });

  test("with Runs on screen, a second run opens without `live` after the first settles; its first batch turns the card live and the row follows it", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 60_000, counts(40, 40, "a_last.py"))]);
    const page = await mountLive(opts);
    await selectTab("Runs");
    expect(theRunningCard(RUN_A).className.split(/\s+/)).toContain("app-evt-running-live");

    await nextAnswer(page, opts, []);
    expect(runningCards()).toHaveLength(0);

    await nextAnswer(page, opts, [openRun(RUN_B, NOW - 1_000)]);
    expectPlainCard(theRunningCard(RUN_B));
    expect(agentLine()).toBe(MESSAGE);

    await nextAnswer(page, opts, [openRun(RUN_B, NOW - 1_000, counts(4, 20, "b_first.py"))]);
    const card = theRunningCard(RUN_B);
    expect(card.className.split(/\s+/)).toContain("app-evt-running-live");
    expect(squash(part(card, "running-count"))).toBe("4/20");
    expect(squash(part(card, "running-file"))).toBe("b_first.py");
    expect(agentLine()).toBe("running 4/20 · b_first.py");
  });
});

describe("the agent row reads its run's live line on every workspace tab", () => {
  for (const tab of WORKSPACE_TABS) {
    test(`with ${tab} on screen before the run's first batch, the answer that carries \`live\` moves the row to \`running 6/30 · c.py\` on ${tab}`, async () => {
      const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
      const page = await mountLive(opts);
      if (tab !== "Roadmap") await selectTab(tab);
      else expect(workspaceTab("Roadmap").className.split(/\s+/)).toContain("on");
      expect(agentLine()).toBe(MESSAGE);

      await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(6, 30, "c.py"))]);
      expect(workspaceTab(tab).className.split(/\s+/)).toContain("on");
      expect(agentLine()).toBe("running 6/30 · c.py");
    });
  }

  test("with `live` landed on Roadmap, the row reads the line on each tab and back again, and a later answer's counts reach it on the tab that is open", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    expect(workspaceTab("Roadmap").className.split(/\s+/)).toContain("on");

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(6, 30, "c.py"))]);
    expect(agentLine()).toBe("running 6/30 · c.py");

    // Across every tab and back: the line never goes away or comes back.
    for (const tab of [...WORKSPACE_TABS.slice(1), ...WORKSPACE_TABS.slice(0, -1).reverse()]) {
      await selectTab(tab);
      expect(agentLine(), `the row on ${tab}`).toBe("running 6/30 · c.py");
    }
    expect(workspaceTab("Roadmap").className.split(/\s+/)).toContain("on");

    // A later answer on Roadmap, with no tab switch.
    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(9, 30, "d.py"))]);
    expect(agentLine()).toBe("running 9/30 · d.py");

    // And one on Workflow.
    await selectTab("Workflow");
    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, counts(11, 30, "e.py"))]);
    expect(agentLine()).toBe("running 11/30 · e.py");
  });
});

describe("a run with no batch yet reads as it does today", () => {
  test("served without `live` answer after answer, the row reads the agent's message and the running card stays plain and opens nothing", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    await selectTab("Runs");

    for (let i = 0; i < 3; i += 1) {
      await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000)]);
      expect(agentLine()).toBe(MESSAGE);
      expectPlainCard(theRunningCard(RUN_A));
    }
    expect(agentLine()).not.toContain("running");
    expect(agentLine()).not.toContain("null");

    const pathBefore = location.pathname;
    const pushedBefore = [...page.pushed];
    theRunningCard(RUN_A).click();
    await settle();
    expect(location.pathname).toBe(pathBefore);
    expect(page.pushed).toEqual(pushedBefore);
  });

  test("on Roadmap, served without `live` answer after answer, the row reads the agent's message", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    for (let i = 0; i < 3; i += 1) {
      await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000)]);
      expect(agentLine()).toBe(MESSAGE);
    }
  });
});
