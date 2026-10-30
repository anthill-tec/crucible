// The live drill-in: an open run's run detail at /run/<runId>, filling in as
// its tests finish (CR-CRU-223 §S3, AC2 + AC3; the drill-in's half of AC5).
// Storyboard F25, option A:
//
//   ← Run detail · live · 412/1280 · 409 ✓ 3 ✗
//   ✗ test_acks_each_batch          AssertionError: 3 != 4 : the board acknowledged 3 batches
//   ✗ test_close_sends_the_rest     AssertionError: offset 4096 never sent
//   ✗ test_run_end_totals           KeyError
//   ▸ 409 passed
//
// - Route: /run/<runId> (home) and /p/<key>/run/<runId> (workspace) open the
//   run detail in its live mode.
// - Rows: every failure from GET /api/v2/runs/<runId>/live, in order — name,
//   file, the first line of its message (its type without one), each on one
//   line — through the run detail's windowed virtualisation; then ONE passed
//   row with its count, which does not expand.
// - Refresh: each refresh reads /live?from=<n>, n the failures already shown,
//   and appends; an answer that arrives after the route moved is discarded.
// - Settle: /live answering ended|aborted replaces the history entry with
//   /run/<eventId>.
//
// Drives the REAL public/app.js through tests/helpers/live-run-harness.ts:
// /live is a stubbed read, and a change frame is a real `events` frame fired
// through the page's own stream handler.
//
// Testids this file names for the live drill-in's rows:
//   live-failure-row       one failure
//   live-failure-name      its test name
//   live-failure-message   the first line of its message, or its type
//   live-passed-row        the one passed row
// The header is the run detail's existing `.app-drillin-head`.
import { describe, test, expect, afterEach } from "bun:test";
import {
  liveFrom,
  liveReads,
  mountLive,
  settle,
  truncatesOnOneLine,
  unmountLive,
  VIRT_WINDOW,
  type EventBriefFixture,
  type EventDetailFixture,
  type LiveCounts,
  type LiveFailureFixture,
  type LiveMountOpts,
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-live-drill";
const AGENT_ID = "CR-CRU-224-830-GREEN";
const RUN_ID = "run-0190bbbb-live-drill-0001";

const F25_LIVE: LiveCounts = {
  completed: 412,
  total: 1280,
  passed: 409,
  failed: 3,
  pending: 0,
  currentFile: "test_relay.py",
};

const F25_FAILURES: LiveFailureFixture[] = [
  {
    id: "f-1",
    name: "test_acks_each_batch",
    suite: "test_relay.RelayTest",
    file: "test_relay.py",
    // Two lines: only the first is shown.
    message: "AssertionError: 3 != 4 : the board acknowledged 3 batches\nTraceback (most recent call last): the relay's ack loop",
  },
  {
    id: "f-2",
    name: "test_close_sends_the_rest",
    suite: "test_relay.RelayTest",
    file: "test_relay.py",
    message: "AssertionError: offset 4096 never sent",
  },
  {
    id: "f-3",
    name: "test_run_end_totals",
    suite: "test_stream.StreamTest",
    file: "test_stream.py",
    type: "KeyError",
  },
];

const FOURTH_FAILURE: LiveFailureFixture = {
  id: "f-4",
  name: "test_resume_after_restart",
  suite: "test_relay.RelayTest",
  file: "test_resume.py",
  message: "AssertionError: batch 7 sent twice",
};

function fixture(pathname: string): LiveMountOpts {
  return {
    pathname,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Live Drill Project",
        type: "backend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: Date.now(),
        retention: 100,
      },
    ],
    agents: [{ agentId: AGENT_ID, projectKey: PROJECT_KEY, liveness: "online", lastSeen: Date.now(), message: "running" }],
    events: [],
    eventDetails: {},
    openRuns: [
      {
        runId: RUN_ID,
        projectKey: PROJECT_KEY,
        agentId: AGENT_ID,
        startedAt: Date.now() - 41_000,
        tier: "unit",
        live: { ...F25_LIVE },
      },
    ],
    live: { [RUN_ID]: { state: "open", live: { ...F25_LIVE }, failures: [...F25_FAILURES] } },
  };
}

/** The settled run's brief + detail, for the run that was open. */
function settledEvent(
  eventId: string,
  aborted: boolean,
): { brief: EventBriefFixture; detail: EventDetailFixture } {
  const now = Date.now();
  const lifecycle = aborted ? { status: "aborted" as const, abortReason: "runner crashed" } : {};
  return {
    brief: {
      id: eventId,
      projectKey: PROJECT_KEY,
      agentId: AGENT_ID,
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
      duration_ms: 500,
      ...lifecycle,
    },
    detail: {
      id: eventId,
      projectKey: PROJECT_KEY,
      agentId: AGENT_ID,
      kind: "test",
      tier: "unit",
      codec: "junit",
      timestamp: now,
      ...lifecycle,
      summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 500 },
      tree: [
        {
          name: "SettledSuite",
          status: "fail",
          children: [
            { name: "passLeaf", status: "pass", duration_ms: 5 },
            { name: "failLeaf", status: "fail", duration_ms: 6, failure: { message: "expected true to be false" } },
          ],
        },
      ],
    },
  };
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function header(): string {
  const head = document.querySelector(".app-drillin-head");
  expect(head).not.toBeNull();
  return text(head);
}

function failureRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="live-failure-row"]')) as HTMLElement[];
}

function rowName(row: HTMLElement): string {
  return text(row.querySelector('[data-testid="live-failure-name"]'));
}

function rowMessage(row: HTMLElement): string {
  return text(row.querySelector('[data-testid="live-failure-message"]'));
}

function passedRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="live-passed-row"]')) as HTMLElement[];
}

/** The F25 header: `live · 412/1280 · 409 ✓ 3 ✗`, spacing-tolerant. */
const F25_HEADER = /live\s*·\s*412\/1280\s*·\s*409\s*✓\s*3\s*✗/;

describe("the live drill-in opens from the running card and shows the run so far", () => {
  test("clicking the live card on home opens /run/<runId>: header `live · 412/1280 · 409 ✓ 3 ✗`, the three failures in order, then a passed row reading 409", async () => {
    const page = await mountLive(fixture("/"));
    const card = document.querySelector('[data-testid="running-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    card!.click();
    await settle();

    expect(location.pathname).toBe(`/run/${RUN_ID}`);
    expect(page.pushed).toEqual([`/run/${RUN_ID}`]);
    expect(header()).toMatch(F25_HEADER);
    // The run detail's own container, in its live mode.
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();

    const rows = failureRows();
    expect(rows.map(rowName)).toEqual(["test_acks_each_batch", "test_close_sends_the_rest", "test_run_end_totals"]);
    // Each row carries its file…
    expect(text(rows[0]!)).toContain("test_relay.py");
    expect(text(rows[2]!)).toContain("test_stream.py");
    // …and the FIRST line of its message — never the second.
    expect(rowMessage(rows[0]!)).toBe("AssertionError: 3 != 4 : the board acknowledged 3 batches");
    expect(text(rows[0]!)).not.toContain("Traceback");
    expect(rowMessage(rows[1]!)).toBe("AssertionError: offset 4096 never sent");
    // A failure with no message shows its type.
    expect(rowMessage(rows[2]!)).toBe("KeyError");

    const passed = passedRows();
    expect(passed).toHaveLength(1);
    expect(text(passed[0]!)).toContain("409");
    // The passed row comes after every failure row.
    const after = rows[2]!.compareDocumentPosition(passed[0]!) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The view was filled from the live read for THIS run.
    expect(liveReads(page.fetchLog, RUN_ID).length).toBeGreaterThanOrEqual(1);
  });

  test("the passed row does not expand: clicking it adds no rows, no nodes and no read", async () => {
    const page = await mountLive(fixture(`/run/${RUN_ID}`));
    const passed = passedRows();
    expect(passed).toHaveLength(1);
    const nodesBefore = document.querySelectorAll("*").length;
    const readsBefore = page.fetchLog.length;

    passed[0]!.click();
    await settle();

    expect(failureRows()).toHaveLength(3);
    expect(passedRows()).toHaveLength(1);
    expect(document.querySelectorAll("*").length).toBe(nodesBefore);
    expect(page.fetchLog.length).toBe(readsBefore);
    expect(passedRows()[0]!.getAttribute("aria-expanded")).not.toBe("true");
  });

  test("a reload of /run/<runId> lands on the same live view, read from /live", async () => {
    const page = await mountLive(fixture(`/run/${RUN_ID}`));

    expect(location.pathname).toBe(`/run/${RUN_ID}`);
    expect(header()).toMatch(F25_HEADER);
    expect(failureRows().map(rowName)).toEqual([
      "test_acks_each_batch",
      "test_close_sends_the_rest",
      "test_run_end_totals",
    ]);
    expect(text(passedRows()[0] ?? null)).toContain("409");
    // An open run's id is not an event: the settled-run read is never asked.
    expect(page.fetchLog.some((u) => u.startsWith(`/api/v2/events/${RUN_ID}`))).toBe(false);
    expect(liveReads(page.fetchLog, RUN_ID).length).toBeGreaterThanOrEqual(1);
  });

  test("in the workspace the live card opens /p/<key>/run/<runId> with the same live header", async () => {
    const page = await mountLive(fixture(`/p/${PROJECT_KEY}`));
    const runsTab = Array.from(document.querySelectorAll('[data-testid="workspace-tab"]')).find((el) =>
      (el.textContent ?? "").includes("Runs"),
    ) as HTMLElement | undefined;
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();
    const card = document.querySelector('[data-testid="running-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();

    card!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${PROJECT_KEY}/run/${RUN_ID}`);
    expect(page.pushed.at(-1)).toBe(`/p/${PROJECT_KEY}/run/${RUN_ID}`);
    expect(header()).toMatch(F25_HEADER);
    expect(failureRows()).toHaveLength(3);
  });

  test("without a total the header reads `<completed> done`, and a pending count above zero shows as `<pending> ⏭`", async () => {
    const opts = fixture(`/run/${RUN_ID}`);
    const live: LiveCounts = { completed: 412, passed: 408, failed: 2, pending: 2, currentFile: "test_relay.py" };
    opts.live[RUN_ID] = { state: "open", live, failures: F25_FAILURES.slice(0, 2) };
    opts.openRuns[0]!.live = live;
    await mountLive(opts);

    expect(header()).toMatch(/live\s*·\s*412 done\s*·\s*408\s*✓\s*2\s*✗\s*2\s*⏭/);
    expect(header()).not.toContain("412/");
    expect(failureRows()).toHaveLength(2);
  });
});

describe("the live drill-in refreshes incrementally on a change frame", () => {
  test("after an `events` change frame the refresh reads /live?from=3 — and only from 3 — and a fourth failure is appended in place, the header following it", async () => {
    const opts = fixture(`/run/${RUN_ID}`);
    const page = await mountLive(opts);
    expect(failureRows()).toHaveLength(3);
    const readsBeforeFrame = page.fetchLog.length;

    // The board's live state moves on: one more test finished, and failed.
    const moved: LiveCounts = { ...F25_LIVE, completed: 413, failed: 4 };
    opts.live[RUN_ID] = { state: "open", live: moved, failures: [...F25_FAILURES, FOURTH_FAILURE] };
    opts.openRuns[0]!.live = moved;
    page.source().open();
    page.source().dispatch("events", PROJECT_KEY);
    await settle();

    const readsSinceFrame = liveReads(page.fetchLog.slice(readsBeforeFrame), RUN_ID);
    expect(readsSinceFrame.length).toBeGreaterThanOrEqual(1);
    expect(readsSinceFrame.map(liveFrom)).toEqual(readsSinceFrame.map(() => 3));
    expect(failureRows().map(rowName)).toEqual([
      "test_acks_each_batch",
      "test_close_sends_the_rest",
      "test_run_end_totals",
      "test_resume_after_restart",
    ]);
    expect(rowMessage(failureRows()[3]!)).toBe("AssertionError: batch 7 sent twice");
    expect(header()).toMatch(/live\s*·\s*413\/1280\s*·\s*409\s*✓\s*4\s*✗/);
    // No reload: still the same live route.
    expect(location.pathname).toBe(`/run/${RUN_ID}`);
  });

  test("an answer that arrives after the route has moved is discarded: a settled answer for a closed drill-in replaces nothing and opens nothing", async () => {
    const opts = fixture(`/run/${RUN_ID}`);
    let release: (() => void) | null = null;
    let holding = false;
    opts.holdLive = (url) => {
      if (!holding || liveFrom(url) !== 3) return null;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const page = await mountLive(opts);
    expect(failureRows()).toHaveLength(3);

    holding = true;
    page.source().open();
    page.source().dispatch("events", PROJECT_KEY);
    await settle();
    // The refresh's /live?from=3 read is in flight…
    expect(liveReads(page.fetchLog, RUN_ID).some((u) => liveFrom(u) === 3)).toBe(true);
    expect(release).not.toBeNull();

    // …the user leaves the drill-in…
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(location.pathname).toBe("/");

    // …and only then does the answer land — saying the run settled.
    const stale = settledEvent("evt-live-stale-1", false);
    opts.live[RUN_ID] = { state: "ended", eventId: stale.brief.id };
    opts.eventDetails[stale.brief.id] = stale.detail;
    (release as unknown as () => void)();
    await settle();

    expect(location.pathname).toBe("/");
    expect(page.replaced).not.toContain(`/run/${stale.brief.id}`);
    expect(page.fetchLog.some((u) => u.startsWith(`/api/v2/events/${stale.brief.id}`))).toBe(false);
    expect(document.querySelector('[data-testid="run-overlay"]')).toBeNull();
  });
});

describe("the live drill-in settles into the settled run's detail", () => {
  test("on /live answering `ended`, the drill-in REPLACES its history entry with /run/<eventId> and shows that run's detail — so Back leaves the run detail", async () => {
    const opts = fixture("/");
    const page = await mountLive(opts);
    (document.querySelector('[data-testid="running-card"]') as HTMLElement | null)?.click();
    await settle();
    expect(location.pathname).toBe(`/run/${RUN_ID}`);

    const settled = settledEvent("evt-live-ended-1", false);
    opts.live[RUN_ID] = { state: "ended", eventId: settled.brief.id };
    opts.openRuns.length = 0;
    opts.events.unshift(settled.brief);
    opts.eventDetails[settled.brief.id] = settled.detail;
    page.source().open();
    page.source().dispatch("events", PROJECT_KEY);
    await settle();

    expect(location.pathname).toBe(`/run/${settled.brief.id}`);
    expect(page.replaced).toContain(`/run/${settled.brief.id}`);
    // Replaced, never pushed: the entry behind it is still home, so Back
    // leaves the run detail instead of returning to a dead live view.
    expect(page.pushed).toEqual([`/run/${RUN_ID}`]);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    expect(text(overlay)).toContain("SettledSuite");
    expect(failureRows()).toHaveLength(0);
    expect(passedRows()).toHaveLength(0);
  });

  test("on /live answering `aborted`, the drill-in replaces its URL with /run/<eventId> and shows the aborted run's detail with its reason", async () => {
    const opts = fixture(`/run/${RUN_ID}`);
    const page = await mountLive(opts);
    expect(failureRows()).toHaveLength(3);

    const aborted = settledEvent("evt-live-aborted-1", true);
    opts.live[RUN_ID] = { state: "aborted", eventId: aborted.brief.id };
    opts.openRuns.length = 0;
    opts.events.unshift(aborted.brief);
    opts.eventDetails[aborted.brief.id] = aborted.detail;
    page.source().open();
    page.source().dispatch("events", PROJECT_KEY);
    await settle();

    expect(location.pathname).toBe(`/run/${aborted.brief.id}`);
    expect(page.replaced).toContain(`/run/${aborted.brief.id}`);
    expect(page.pushed).not.toContain(`/run/${aborted.brief.id}`);
    const overlay = document.querySelector('[data-testid="run-overlay"]');
    expect(overlay).not.toBeNull();
    expect(text(overlay?.querySelector('[data-testid="abort-reason"]') ?? null)).toBe("aborted — runner crashed");
    expect(failureRows()).toHaveLength(0);
  });
});

describe("the live drill-in is bounded", () => {
  test("a failure name and message longer than the row each truncate on one line (no wrap, clipped, ellipsis)", async () => {
    const opts = fixture(`/run/${RUN_ID}`);
    const longName = `test_${"an_extremely_long_parametrised_case_name_".repeat(6)}end`;
    const longMessage = `AssertionError: ${"expected the relay to acknowledge every batch it was sent ".repeat(6)}`;
    opts.live[RUN_ID] = {
      state: "open",
      live: { ...F25_LIVE, failed: 1, passed: 411 },
      failures: [{ id: "f-long", name: longName, suite: "S", file: "test_relay.py", message: longMessage }],
    };
    await mountLive(opts);

    const rows = failureRows();
    expect(rows).toHaveLength(1);
    const name = rows[0]!.querySelector('[data-testid="live-failure-name"]');
    const message = rows[0]!.querySelector('[data-testid="live-failure-message"]');
    expect(name).not.toBeNull();
    expect(message).not.toBeNull();
    expect(text(name)).toBe(longName);
    expect(text(message)).toBe(longMessage.trim());
    expect(truncatesOnOneLine(name!)).toBe(true);
    expect(truncatesOnOneLine(message!)).toBe(true);
  });

  test(`with 5,000 failures the drill-in mounts no more failure rows than the run detail's virtualisation window (${VIRT_WINDOW}), starting at the oldest`, async () => {
    const opts = fixture(`/run/${RUN_ID}`);
    const failures: LiveFailureFixture[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `f-${i}`,
      name: `test_case_${String(i).padStart(4, "0")}`,
      suite: "BulkSuite",
      file: "test_bulk.py",
      message: `AssertionError: case ${i}`,
    }));
    const live: LiveCounts = { completed: 6000, total: 6000, passed: 1000, failed: 5000, pending: 0, currentFile: "test_bulk.py" };
    opts.live[RUN_ID] = { state: "open", live, failures };
    opts.openRuns[0]!.live = live;
    await mountLive(opts);

    const rows = failureRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(VIRT_WINDOW);
    expect(rowName(rows[0]!)).toBe("test_case_0000");
    expect(header()).toMatch(/live\s*·\s*6000\/6000\s*·\s*1000\s*✓\s*5000\s*✗/);
  });
});
