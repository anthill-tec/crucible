// The counts the board may leave out of an open run's `live` — its total and
// its current file — reach the page on the FIRST answer that carries them,
// even when the done count has not moved.
//
// The board's `live` (`liveCounts`, src/v2.ts) always carries the done, passed,
// failed and pending counts, but omits `total` when the runner gave none (or
// gave 0) and `currentFile` when it named none — a reader can name a file
// before any test in it finishes. The page holds each open run it is served in
// `state.openRuns` (filled by `refetchEvents`, public/app.js); the agent row
// (`AgentRow` → `agentLiveLine`) and the Runs tab's running card
// (`RunningCard`) read `live.total` and `live.currentFile` from that slice. A
// binding that read either while it was absent must still re-run when a later
// answer adds it, so that:
//
//   - an answer that adds the current file, the done count unchanged, moves
//     the row to `running <done>/<total> · <file>` and puts the file on the
//     card — on that answer, without a reload, without a further count change;
//   - an answer that adds the total, the done count unchanged, moves the row
//     from `running <done> done` to `running <done>/<total>` and gives the card
//     its done of total and its progress bar, the same way;
//   - a `live` whose total or current file is absent reads as it does today:
//     no file part on the row, no file on the card, `<done> done` and no bar
//     without a total — never an empty or `null` slot on screen.
//
// Drives the REAL public/app.js with the vendored van/van-x through
// tests/helpers/live-run-harness.ts at the workspace route `/p/<key>`; every
// later answer is fetched through the page's own refetch, driven by an
// `events` frame on its live stream.
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
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-open-run-optional-counts";
const AGENT_ID = "gated-runner";
const MESSAGE = "gated test run starting";
const RUN_A = "run-0190-optional-counts-a";
const NOW = Date.now();

const WORKSPACE_TABS = ["Roadmap", "Runs", "Workflow", "Coverage", "BDD", "Compile"] as const;
type WorkspaceTabName = (typeof WORKSPACE_TABS)[number];

/** A board `live` exactly as the board serves it: `total` and `currentFile`
 *  present only when given, absent (not null, not undefined-valued) otherwise. */
function liveOf(completed: number, extra: { total?: number; currentFile?: string } = {}): LiveCounts {
  return {
    completed,
    ...(extra.total !== undefined ? { total: extra.total } : {}),
    passed: completed,
    failed: 0,
    pending: 0,
    ...(extra.currentFile !== undefined ? { currentFile: extra.currentFile } : {}),
  };
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
    name: "Open Run Optional Counts",
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

function theRunningCard(runId: string): HTMLElement {
  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="running-card"]'));
  expect(cards, "exactly one running card").toHaveLength(1);
  const card = cards[0] as HTMLElement;
  expect(card.getAttribute("data-run-id")).toBe(runId);
  return card;
}

function part(card: HTMLElement, testid: string): HTMLElement | null {
  return card.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

/** The live card, whatever its optional parts: the live class and the open hint. */
function expectLiveCard(card: HTMLElement): void {
  expect(card.className.split(/\s+/)).toContain("app-evt-running-live");
  expect(squash(part(card, "running-open-hint"))).toBe("› open");
  expect(part(card, "running-label")).toBeNull();
}

/** Nothing on screen reads an absent count as a value. */
function expectNoEmptySlotText(text: string): void {
  expect(text).not.toContain("null");
  expect(text).not.toContain("undefined");
  expect(text).not.toContain("NaN");
}

/** A witness a reload would destroy. */
function plantNoReloadWitness(): void {
  (window as unknown as Record<string, unknown>).__optionalCountsNoReload = "sentinel";
}
function expectNoReload(): void {
  expect((window as unknown as Record<string, unknown>).__optionalCountsNoReload).toBe("sentinel");
}

// ═══════════════════════════════════════════════════════════════════════════

describe("an answer that adds the current file, the done count unchanged, reaches the row and the card on that answer", () => {
  test("with Runs on screen, `live` at 5 of 40 with no current file reads `running 5/40` and a card with no file; the next answer adds a.py at 5 of 40 and the row reads `running 5/40 · a.py` and the card shows a.py — no reload", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000, liveOf(5, { total: 40 }))]);
    const page = await mountLive(opts);
    await selectTab("Runs");
    plantNoReloadWitness();
    const pushedBefore = [...page.pushed];

    expect(agentLine()).toBe("running 5/40");
    const before = theRunningCard(RUN_A);
    expectLiveCard(before);
    expect(squash(part(before, "running-count"))).toBe("5/40");
    expect(part(before, "running-file")).toBeNull();

    // The same done count, the same total: only the current file is new.
    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(5, { total: 40, currentFile: "a.py" }))]);

    const card = theRunningCard(RUN_A);
    expectLiveCard(card);
    expect(squash(part(card, "running-count"))).toBe("5/40");
    expect(squash(part(card, "running-file"))).toBe("a.py");
    expect(card.querySelectorAll('[data-testid="running-file"]')).toHaveLength(1);
    expect(part(card, "running-progress-fill")?.style.width).toBe("12.5%");
    expect(agentLine()).toBe("running 5/40 · a.py");

    expect(page.pushed).toEqual(pushedBefore);
    expectNoReload();
  });

  test("on Roadmap, a run first served without `live`, then at 7 of 20 with no current file, reads `running 7/20`; the answer that adds b.py at 7 of 20 reads `running 7/20 · b.py`", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    expect(workspaceTab("Roadmap").className.split(/\s+/)).toContain("on");
    expect(agentLine()).toBe(MESSAGE);
    plantNoReloadWitness();

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(7, { total: 20 }))]);
    expect(agentLine()).toBe("running 7/20");

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(7, { total: 20, currentFile: "b.py" }))]);
    expect(agentLine()).toBe("running 7/20 · b.py");

    // And the file moves on with the count from there.
    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(8, { total: 20, currentFile: "c.py" }))]);
    expect(agentLine()).toBe("running 8/20 · c.py");
    expectNoReload();
  });
});

describe("an answer that adds the total, the done count unchanged, reaches the row and the card on that answer", () => {
  test("with Runs on screen, `live` at 10 done in a.py with no total reads `running 10 done · a.py` and a card with no bar; the next answer adds 40 at 10 done and the row reads `running 10/40 · a.py` and the card shows 10/40 and its bar at 25% — no reload", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000, liveOf(10, { currentFile: "a.py" }))]);
    const page = await mountLive(opts);
    await selectTab("Runs");
    plantNoReloadWitness();
    const pushedBefore = [...page.pushed];

    expect(agentLine()).toBe("running 10 done · a.py");
    const before = theRunningCard(RUN_A);
    expectLiveCard(before);
    expect(squash(part(before, "running-count"))).toBe("10 done");
    expect(squash(part(before, "running-file"))).toBe("a.py");
    expect(part(before, "running-progress")).toBeNull();

    // The same done count, the same file: only the total is new.
    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(10, { total: 40, currentFile: "a.py" }))]);

    const card = theRunningCard(RUN_A);
    expectLiveCard(card);
    expect(squash(part(card, "running-count"))).toBe("10/40");
    expect(squash(part(card, "running-file"))).toBe("a.py");
    expect(part(card, "running-progress")).not.toBeNull();
    expect(part(card, "running-progress-fill")?.style.width).toBe("25%");
    expect(agentLine()).toBe("running 10/40 · a.py");

    expect(page.pushed).toEqual(pushedBefore);
    expectNoReload();
  });

  test("on Roadmap, a run first served without `live`, then at 3 done in d.py with no total, reads `running 3 done · d.py`; the answer that adds 12 at 3 done reads `running 3/12 · d.py`", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    expect(workspaceTab("Roadmap").className.split(/\s+/)).toContain("on");
    expect(agentLine()).toBe(MESSAGE);
    plantNoReloadWitness();

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(3, { currentFile: "d.py" }))]);
    expect(agentLine()).toBe("running 3 done · d.py");

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(3, { total: 12, currentFile: "d.py" }))]);
    expect(agentLine()).toBe("running 3/12 · d.py");
    expectNoReload();
  });
});

describe("a `live` whose total or current file is absent reads as it does today", () => {
  test("with no current file, answer after answer, the row reads `running <done>/<total>` with no file part and the card carries no file", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000, liveOf(5, { total: 40 }))]);
    const page = await mountLive(opts);
    await selectTab("Runs");

    for (const done of [5, 5, 6]) {
      await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(done, { total: 40 }))]);
      expect(agentLine()).toBe(`running ${done}/40`);
      const card = theRunningCard(RUN_A);
      expectLiveCard(card);
      expect(squash(part(card, "running-count"))).toBe(`${done}/40`);
      expect(part(card, "running-file")).toBeNull();
      expectNoEmptySlotText(squash(card));
    }
    expect(agentLine()).not.toContain("·");
    expectNoEmptySlotText(agentLine());
  });

  test("with no total, answer after answer, the row reads `running <done> done · <file>` and the card reads `<done> done` with no progress bar", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000, liveOf(5, { currentFile: "a.py" }))]);
    const page = await mountLive(opts);
    await selectTab("Runs");

    for (const done of [5, 5, 6]) {
      await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(done, { currentFile: "a.py" }))]);
      expect(agentLine()).toBe(`running ${done} done · a.py`);
      const card = theRunningCard(RUN_A);
      expectLiveCard(card);
      expect(squash(part(card, "running-count"))).toBe(`${done} done`);
      expect(squash(part(card, "running-file"))).toBe("a.py");
      expect(part(card, "running-progress")).toBeNull();
      expect(part(card, "running-progress-fill")).toBeNull();
      expectNoEmptySlotText(squash(card));
    }
    expectNoEmptySlotText(agentLine());
  });

  test("with neither a total nor a current file, the row reads `running <done> done` and the card reads `<done> done` with no file and no bar", async () => {
    const opts = workspace([openRun(RUN_A, NOW - 2_000)]);
    const page = await mountLive(opts);
    await selectTab("Runs");

    await nextAnswer(page, opts, [openRun(RUN_A, NOW - 2_000, liveOf(4))]);
    expect(agentLine()).toBe("running 4 done");
    const card = theRunningCard(RUN_A);
    expectLiveCard(card);
    expect(squash(part(card, "running-count"))).toBe("4 done");
    expect(part(card, "running-file")).toBeNull();
    expect(part(card, "running-progress")).toBeNull();
    expectNoEmptySlotText(squash(card));
    expectNoEmptySlotText(agentLine());
  });
});
