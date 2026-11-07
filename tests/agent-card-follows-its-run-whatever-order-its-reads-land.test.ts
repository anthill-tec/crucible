// An agent's card follows its streaming run batch by batch even when the card
// was built before the run reached the page, and the agent's own fields never
// change again — whichever of the agents and events reads lands first, and
// for a run whose first read carries no live state.
//
// The project pane builds the agent rows inside one binding, rebuilt only when
// an agent field it reads changes; the card's line (`agentLiveLine`) and its
// streaming mark (`isStreamingAgent`) are bindings over `state.openRuns`
// (public/app.js). A refresh reads the agents and the events in parallel
// (`runRefresh`), and each read replaces its slice as it lands. A line whose
// last evaluation read nothing a later replacement changes — a run list that
// did not yet hold the run, or a run with no live state — must still re-run on
// every later replacement of the open-run slice, or the card stays on the
// agent's message for the whole run.
//
// Each test mounts the page with NO open run, so the card is built reading
// the agent's message; the agent fixture never changes after that. The run
// then reaches the page in one refresh that reads BOTH slices (the stream's
// reconnect, which reads every slice), with the two reads held and released
// in a chosen order; every later batch arrives on an `events` frame, the
// page's own refetch. A page opened mid-run is covered too.
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
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-card-follows-its-run";
const AGENT_ID = "card-follower";
const MESSAGE = "gated test run starting";
const RUN_ID = "run-card-follows-its-run";
const NOW = Date.now();
const STARTED_AT = NOW - 3_000;

function counts(completed: number, total: number, currentFile: string): LiveCounts {
  return { completed, total, passed: completed, failed: 0, pending: 0, currentFile };
}

function openRun(live?: LiveCounts): OpenRunFixture {
  return {
    runId: RUN_ID,
    projectKey: PROJECT_KEY,
    agentId: AGENT_ID,
    startedAt: STARTED_AT,
    tier: "unit",
    ...(live !== undefined ? { live: { ...live } } : {}),
  };
}

/** The agent as every agents read serves it — the same fields every time. */
function theAgent(): AgentFixture {
  return { agentId: AGENT_ID, projectKey: PROJECT_KEY, liveness: "online", lastSeen: NOW, message: MESSAGE };
}

function workspace(openRuns: OpenRunFixture[]): LiveMountOpts {
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Card Follows Its Run",
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

/** The card's line: its `.app-agent-msg` text. */
function cardLine(): string {
  const msg = agentRow().querySelector(".app-agent-msg");
  expect(msg, `the card of ${AGENT_ID} has its .app-agent-msg`).not.toBeNull();
  return squash(msg);
}

function isStreamingMarked(): boolean {
  return agentRow().className.split(/\s+/).includes("app-agent-streaming");
}

/** The board now serves exactly `runs` (fresh objects, as a new JSON answer). */
function boardServes(opts: LiveMountOpts, runs: OpenRunFixture[]): void {
  opts.openRuns.splice(0, opts.openRuns.length, ...runs.map((r) => structuredClone(r)));
}

/** The board's next answer, fetched by the page on an `events` frame. */
async function nextEventsAnswer(page: LiveMounted, opts: LiveMountOpts, runs: OpenRunFixture[]): Promise<void> {
  boardServes(opts, runs);
  page.source().dispatch("events", PROJECT_KEY);
  await settle();
}

type Slice = "agents" | "events";

/**
 * Holds the page's agents and events reads until released. Wraps the
 * harness's scripted fetch; a read of any other URL passes straight through.
 */
function holdReads(): { release(slice: Slice): Promise<void>; held(slice: Slice): number; stop(): void } {
  const inner = globalThis.fetch;
  const waiting: Record<Slice, (() => void)[]> = { agents: [], events: [] };
  const sliceOf = (url: string): Slice | null => {
    if (url.includes("/api/v2/agents")) return "agents";
    if (url.includes("/api/v2/events?") || url.endsWith("/api/v2/events")) return "events";
    return null;
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string): Promise<Response> => {
    const slice = sliceOf(String(input));
    if (slice !== null) await new Promise<void>((resolve) => waiting[slice].push(resolve));
    return inner(input);
  }) as typeof fetch;
  return {
    async release(slice: Slice) {
      const held = waiting[slice].splice(0);
      expect(held.length, `the page's ${slice} read is held`).toBe(1);
      for (const resolve of held) resolve();
      await settle();
    },
    held: (slice: Slice) => waiting[slice].length,
    stop() {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = inner;
    },
  };
}

/**
 * The run reaches the page in ONE refresh that reads both slices — the
 * stream's reconnect reads every slice — with the agents and events reads
 * landing in `order`.
 */
async function runArrivesInOneRefresh(
  page: LiveMounted,
  opts: LiveMountOpts,
  run: OpenRunFixture,
  order: readonly [Slice, Slice],
): Promise<void> {
  boardServes(opts, [run]);
  const gate = holdReads();
  try {
    const source = page.source();
    source.dropAndRetry();
    source.open();
    await settle();
    expect(gate.held("agents"), "the refresh reads the agents").toBe(1);
    expect(gate.held("events"), "the refresh reads the events").toBe(1);
    await gate.release(order[0]);
    await gate.release(order[1]);
  } finally {
    gate.stop();
  }
  await settle();
}

/** A witness a reload would destroy. */
function plantNoReloadWitness(): void {
  (window as unknown as Record<string, unknown>).__cardFollowsNoReload = "sentinel";
}
function expectNoReload(): void {
  expect((window as unknown as Record<string, unknown>).__cardFollowsNoReload).toBe("sentinel");
}

const ORDERS: readonly { name: string; order: readonly [Slice, Slice] }[] = [
  { name: "the agents read lands before the events read", order: ["agents", "events"] },
  { name: "the events read lands before the agents read", order: ["events", "agents"] },
];

// ═══════════════════════════════════════════════════════════════════════════

describe("a card built before its run reached the page follows the run's batches", () => {
  for (const { name, order } of ORDERS) {
    test(`${name}, the run's first read carrying 2 of 6 in a.ts: the card reads \`running 2/6 · a.ts\`, then \`running 4/6 · b.ts\` and \`running 6/6 · c.ts\`, then its message once the run settles — no reload`, async () => {
      const opts = workspace([]);
      const page = await mountLive(opts);
      expect(cardLine()).toBe(MESSAGE);
      expect(isStreamingMarked()).toBe(false);
      plantNoReloadWitness();
      const pushedBefore = [...page.pushed];

      await runArrivesInOneRefresh(page, opts, openRun(counts(2, 6, "a.ts")), order);
      expect(cardLine()).toBe("running 2/6 · a.ts");
      expect(isStreamingMarked()).toBe(true);

      await nextEventsAnswer(page, opts, [openRun(counts(4, 6, "b.ts"))]);
      expect(cardLine()).toBe("running 4/6 · b.ts");

      await nextEventsAnswer(page, opts, [openRun(counts(6, 6, "c.ts"))]);
      expect(cardLine()).toBe("running 6/6 · c.ts");

      await nextEventsAnswer(page, opts, []);
      expect(cardLine()).toBe(MESSAGE);
      expect(isStreamingMarked()).toBe(false);

      expect(page.pushed).toEqual(pushedBefore);
      expectNoReload();
    });

    test(`${name}, the run's first read carrying no live state: the card is marked streaming and reads its message, then follows \`running 1/5 · a.ts\` and \`running 3/5 · b.ts\`, then its message once the run settles`, async () => {
      const opts = workspace([]);
      const page = await mountLive(opts);
      expect(cardLine()).toBe(MESSAGE);
      expect(isStreamingMarked()).toBe(false);
      plantNoReloadWitness();

      await runArrivesInOneRefresh(page, opts, openRun(), order);
      expect(isStreamingMarked()).toBe(true);
      expect(cardLine()).toBe(MESSAGE);

      await nextEventsAnswer(page, opts, [openRun(counts(1, 5, "a.ts"))]);
      expect(cardLine()).toBe("running 1/5 · a.ts");
      expect(isStreamingMarked()).toBe(true);

      await nextEventsAnswer(page, opts, [openRun(counts(3, 5, "b.ts"))]);
      expect(cardLine()).toBe("running 3/5 · b.ts");

      await nextEventsAnswer(page, opts, []);
      expect(cardLine()).toBe(MESSAGE);
      expect(isStreamingMarked()).toBe(false);
      expectNoReload();
    });
  }

  test("the run arrives on an events frame alone, with no agents read after it: the card follows each batch, then reads its message once the run settles", async () => {
    const opts = workspace([]);
    const page = await mountLive(opts);
    expect(cardLine()).toBe(MESSAGE);
    page.source().open();

    await nextEventsAnswer(page, opts, [openRun()]);
    expect(isStreamingMarked()).toBe(true);
    expect(cardLine()).toBe(MESSAGE);

    await nextEventsAnswer(page, opts, [openRun(counts(2, 7, "a.ts"))]);
    expect(cardLine()).toBe("running 2/7 · a.ts");

    await nextEventsAnswer(page, opts, [openRun(counts(5, 7, "b.ts"))]);
    expect(cardLine()).toBe("running 5/7 · b.ts");

    await nextEventsAnswer(page, opts, []);
    expect(cardLine()).toBe(MESSAGE);
    expect(isStreamingMarked()).toBe(false);
  });

  test("a run that opens after a settled one, on the same page: the card follows the second run's batches as it followed the first's", async () => {
    const opts = workspace([]);
    const page = await mountLive(opts);
    page.source().open();

    await nextEventsAnswer(page, opts, [openRun(counts(1, 2, "a.ts"))]);
    expect(cardLine()).toBe("running 1/2 · a.ts");
    await nextEventsAnswer(page, opts, []);
    expect(cardLine()).toBe(MESSAGE);

    const second = (live?: LiveCounts): OpenRunFixture => ({ ...openRun(live), runId: `${RUN_ID}-next`, startedAt: NOW });
    await nextEventsAnswer(page, opts, [second()]);
    expect(isStreamingMarked()).toBe(true);
    expect(cardLine()).toBe(MESSAGE);
    await nextEventsAnswer(page, opts, [second(counts(3, 9, "c.ts"))]);
    expect(cardLine()).toBe("running 3/9 · c.ts");
    await nextEventsAnswer(page, opts, [second(counts(8, 9, "d.ts"))]);
    expect(cardLine()).toBe("running 8/9 · d.ts");
  });

  test("a page opened mid-run, as after a reload: the card reads the run's line at once, then follows each batch, then reads its message once the run settles", async () => {
    const opts = workspace([openRun(counts(3, 9, "c.ts"))]);
    const page = await mountLive(opts);
    expect(cardLine()).toBe("running 3/9 · c.ts");
    expect(isStreamingMarked()).toBe(true);
    page.source().open();

    await nextEventsAnswer(page, opts, [openRun(counts(5, 9, "d.ts"))]);
    expect(cardLine()).toBe("running 5/9 · d.ts");

    await nextEventsAnswer(page, opts, [openRun(counts(9, 9, "e.ts"))]);
    expect(cardLine()).toBe("running 9/9 · e.ts");

    await nextEventsAnswer(page, opts, []);
    expect(cardLine()).toBe(MESSAGE);
    expect(isStreamingMarked()).toBe(false);
  });
});
