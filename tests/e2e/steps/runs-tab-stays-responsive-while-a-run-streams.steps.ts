// runs-tab-stays-responsive-while-a-run-streams.feature — steps. A project with
// a long settled history, its Runs tab open, and a run streaming five batches
// through the real stream route: the page's main thread is watched through the
// browser's own long-task entries (a `PerformanceObserver` on `longtask`)
// while the batches land, and no task may exceed the bound.
//
// Nothing is doubled. The history is ingested through POST /api/v2/runs/parsed
// (a few agents, every run a one-leaf tree), the project's own retention is set
// through PATCH /api/v2/projects/<key> so the page's events read covers the
// whole history, and the run opens, streams and closes through the run-start,
// stream and runs routes. Every wait is on the page, bounded by a few of the
// board's frame cadences.
//
// The checks inside a watched window cost the page nothing measurable. Every
// Playwright locator, `expect` and `page.evaluate` runs work in the page's own
// main thread, and over 2,500 cards that work is itself a long task the watch
// would count against the page:
//   - a text or role locator walks the whole document, and every unmet
//     `expect` poll renders an aria snapshot (of the whole body when its
//     element is absent);
//   - the trace recorder (`trace: "retain-on-failure"` records every test)
//     serialises the whole DOM around each page action; after the close
//     re-renders the timeline that one serialisation is a multi-second task.
// So from the start of a watch to its read, the steps reach the page only
// through the browser's own protocol (`Runtime.evaluate` on a CDP session,
// which the trace recorder does not snapshot), and every check is a probe that
// finds its few elements by a CSS selector and reads their text or attributes,
// polled in the page until it reads what is expected or its time runs out.
// The probe's last reading is what the assertion compares, so a failure names
// what the page showed. Chromium only, as the long-task entries are.
//
// Reuses seeding.steps.ts (project, agent), workflow.steps.ts (the tab click),
// run-lifecycle.steps.ts (the run start), run-stream-live-page.steps.ts (the
// streaming agent, the close) and navigation.steps.ts (opening the workspace).
import { expect, type CDPSession, type Locator, type Page } from "@playwright/test";
import { Step } from "./world.ts";
import { registerAgent } from "./harness.ts";

const STREAM_CODEC = "crucible-events";
const BATCH_COUNT = 5;

const secondsToMs = (seconds: number): number => seconds * 1_000;

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

function testEnd(n: number): string {
  return line({
    event: "test-end",
    id: `steady-${String(n)}`,
    name: `holds batch ${String(n)}`,
    suite: "Steady",
    file: `src/batch-${String(n)}.test.ts`,
    status: "pass",
    duration_ms: 5,
  });
}

/** Five batches, one passing test each; the first opens the stream, the last ends it. */
const FIVE_BATCHES: readonly string[] = Array.from({ length: BATCH_COUNT }, (_, i) => {
  const n = i + 1;
  const head = n === 1 ? line({ event: "run-start", total: BATCH_COUNT }) : "";
  const tail =
    n === BATCH_COUNT
      ? line({ event: "run-end", total: BATCH_COUNT, passed: BATCH_COUNT, failed: 0, pending: 0, duration_ms: 25 })
      : "";
  return head + testEnd(n) + tail;
});

/** The agents the history is spread over; a RED and a GREEN of one stem pair into transition markers. */
const HISTORY_AGENTS = ["history-RED", "history-GREEN", "history-VERIFY", "history-regression"] as const;

/** Runs posted at once while seeding. */
const SEED_CONCURRENCY = 50;

const runsPane = (page: Page): Locator => page.getByTestId("workspace-runs");

/** How often a probe is re-read while a step waits on the page. */
const PROBE_POLL_MS = 100;

/** A flat record a probe reads off the page, compared key by key. */
type ProbeReading = Record<string, string | number | boolean | null>;

/** The reading as one string with its keys in order, so the page and the test compare it alike. */
function canonical(reading: ProbeReading): string {
  return JSON.stringify(reading, Object.keys(reading).sort());
}

/** One CDP session per page, opened on first use. */
const protocolSessions = new WeakMap<Page, CDPSession>();

async function protocolSession(page: Page): Promise<CDPSession> {
  const open = protocolSessions.get(page);
  if (open !== undefined) return open;
  const session = await page.context().newCDPSession(page);
  protocolSessions.set(page, session);
  return session;
}

/**
 * Runs `fn(...args)` in the page's main world through `Runtime.evaluate` and
 * returns its (awaited) value. `fn` is sent as source, so it must be
 * self-contained; every argument must survive JSON.
 */
async function inThePage<T>(page: Page, fn: (...args: never[]) => T | Promise<T>, ...args: readonly unknown[]): Promise<T> {
  const session = await protocolSession(page);
  const passed = args.map((a) => (typeof a === "function" ? `(${a.toString()})` : JSON.stringify(a))).join(", ");
  const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
    expression: `(${fn.toString()})(${passed})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails !== undefined) {
    throw new Error(`the page threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  }
  return result.value as T;
}

/** Re-reads `read(arg)` in the page until it reads `want` or `timeoutMs` passes; resolves to the last reading. */
function pollTheReading(
  read: (arg: string) => Record<string, unknown>,
  arg: string,
  want: string,
  timeoutMs: number,
  pollMs: number,
): Promise<Record<string, unknown>> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      const reading = read(arg);
      if (JSON.stringify(reading, Object.keys(reading).sort()) === want || performance.now() >= deadline) resolve(reading);
      else setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * Waits until `probe(arg)`, read in the page, reads `expected`, and asserts
 * its last reading, so a timeout fails naming what the page showed. The probe
 * must be self-contained and touch only the few elements it reads.
 */
async function untilThePageReads(
  page: Page,
  probe: (arg: string) => ProbeReading,
  arg: string,
  expected: ProbeReading,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const reading = await inThePage(page, pollTheReading, probe, arg, canonical(expected), timeoutMs, PROBE_POLL_MS);
  expect(reading, what).toEqual(expected);
}

/**
 * The running cards on the Runs tab that name the agent, and whether the one
 * card is on screen (rendered, with a box). Reads the running cards only.
 */
function runningCardOnTheRunsTab(agentId: string): ProbeReading {
  const cards = Array.from(
    document.querySelectorAll('[data-testid="workspace-runs"] [data-testid="running-card"]'),
  ).filter((card) => (card.textContent ?? "").includes(agentId));
  const card = cards.length === 1 ? (cards[0] as HTMLElement) : null;
  const box = card?.getBoundingClientRect();
  const visible = card !== null && card.checkVisibility() && box !== undefined && box.width > 0 && box.height > 0;
  return { cards: cards.length, visible };
}

/** The Runs tab's running cards that name the agent, and the one card's count and file, whitespace-normalised. */
function runningCardProgress(agentId: string): ProbeReading {
  const text = (el: Element | null | undefined): string | null =>
    el ? (el.textContent ?? "").replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " ") : null;
  const cards = Array.from(
    document.querySelectorAll('[data-testid="workspace-runs"] [data-testid="running-card"]'),
  ).filter((card) => (card.textContent ?? "").includes(agentId));
  const card = cards.length === 1 ? cards[0] : null;
  return {
    cards: cards.length,
    count: text(card?.querySelector('[data-testid="running-count"]')),
    file: text(card?.querySelector('[data-testid="running-file"]')),
  };
}

/** The project pane's rows that name the agent, and the one row's line, whitespace-normalised. */
function agentRowLine(agentId: string): ProbeReading {
  const text = (el: Element | null | undefined): string | null =>
    el ? (el.textContent ?? "").replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " ") : null;
  const rows = Array.from(
    document.querySelectorAll('[data-testid="project-pane"] [data-testid="agent-row"]'),
  ).filter((row) => (row.textContent ?? "").includes(agentId));
  const row = rows.length === 1 ? rows[0] : null;
  const lines = row ? row.querySelectorAll(".app-agent-msg") : [];
  return { rows: rows.length, lines: lines.length, line: text(lines.length === 1 ? lines[0] : null) };
}

/** The Runs timeline: its running cards, its settled cards, the run id heading it, and how many cards carry the given run id. */
function runsTimelineHead(eventId: string): ProbeReading {
  const pane = document.querySelector('[data-testid="workspace-runs"]');
  if (pane === null) return { running: null, cards: null, head: null, carrying: null };
  const cards = pane.querySelectorAll('[data-testid="event-card"]');
  return {
    running: pane.querySelectorAll('[data-testid="running-card"]').length,
    cards: cards.length,
    head: cards[0]?.getAttribute("data-run-id") ?? null,
    carrying: Array.from(cards).filter((card) => card.getAttribute("data-run-id") === eventId).length,
  };
}

Step("that project keeps its newest {int} runs", async ({ request, world }, retention: number) => {
  const res = await request.patch(`/api/v2/projects/${world.projectKey as string}`, { data: { retention } });
  expect(res.status(), await res.text()).toBe(200);
});

Step(
  "{int} settled runs are ingested on that project through the parsed runs route",
  async ({ request, world, $testInfo }, count: number) => {
    // Seeding a long history is the slow part of this scenario; the page
    // under test is not open yet.
    $testInfo.setTimeout(240_000);
    const projectKey = world.projectKey as string;
    for (const agentId of HISTORY_AGENTS) {
      await registerAgent(request, projectKey, agentId, "seeding the history");
    }
    const started = Date.now();
    const post = async (i: number): Promise<void> => {
      const agentId = HISTORY_AGENTS[i % HISTORY_AGENTS.length] as string;
      const failed = agentId.endsWith("-RED") ? 1 : 0;
      const status = failed > 0 ? "fail" : "pass";
      const res = await request.post("/api/v2/runs/parsed", {
        data: {
          projectKey,
          agentId,
          tier: "unit",
          summary: { total: 3, passed: 3 - failed, failed, pending: 0, duration_ms: 40 + (i % 7) },
          tree: [{ name: "history", status, children: [{ name: `run ${String(i)}`, status, duration_ms: 5 }] }],
        },
      });
      expect(res.ok(), `history run ${String(i)}: ${String(res.status())}`).toBe(true);
    };
    for (let from = 0; from < count; from += SEED_CONCURRENCY) {
      const batch: Promise<void>[] = [];
      for (let i = from; i < Math.min(count, from + SEED_CONCURRENCY); i += 1) batch.push(post(i));
      await Promise.all(batch);
    }
    $testInfo.annotations.push({
      type: "seeded history",
      description: `${String(count)} runs in ${String(Date.now() - started)} ms`,
    });
  },
);

Step(
  "the Runs timeline shows {int} settled run cards within {int} seconds",
  async ({ page }, count: number, seconds: number) => {
    await expect(runsPane(page).getByTestId("event-card")).toHaveCount(count, { timeout: secondsToMs(seconds) });
  },
);

Step(
  "the running card for {string} is on the Runs tab within {int} seconds",
  async ({ page }, agentId: string, seconds: number) => {
    await untilThePageReads(
      page,
      runningCardOnTheRunsTab,
      agentId,
      { cards: 1, visible: true },
      secondsToMs(seconds),
      `one running card for ${agentId}, on screen, on the Runs tab`,
    );
  },
);

Step(
  "the Runs tab's running card for {string} reads {string} in {string} within {int} seconds",
  async ({ page }, agentId: string, count: string, file: string, seconds: number) => {
    await untilThePageReads(
      page,
      runningCardProgress,
      agentId,
      { cards: 1, count, file },
      secondsToMs(seconds),
      `the running card for ${agentId} reads ${count} in ${file}`,
    );
  },
);

Step(
  "the project pane's row for agent {string} reads {string} within {int} seconds",
  async ({ page }, agentId: string, line: string, seconds: number) => {
    await untilThePageReads(
      page,
      agentRowLine,
      agentId,
      { rows: 1, lines: 1, line },
      secondsToMs(seconds),
      `the project pane's row for ${agentId} reads "${line}"`,
    );
  },
);

Step(
  "the run streams batch {int} of its five-batch stream through the stream route",
  async ({ request, world }, n: number) => {
    const data = FIVE_BATCHES[n - 1];
    expect(data, `the stream has ${String(FIVE_BATCHES.length)} batches`).toBeDefined();
    const from = FIVE_BATCHES.slice(0, n - 1).reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0);
    const res = await request.post(`/api/v2/runs/${world.runId as string}/stream`, {
      data: {
        projectKey: world.projectKey as string,
        agentId: world.streamingAgent as string,
        codec: STREAM_CODEC,
        from,
        data,
      },
    });
    const body = (await res.json()) as { ok?: boolean; held?: number };
    expect(res.status(), JSON.stringify(body)).toBe(200);
    expect(body.held).toBe(from + Buffer.byteLength(data ?? "", "utf8"));
  },
);

interface WatchedTask {
  startTime: number;
  duration: number;
}

interface TaskWatch {
  since: number;
  tasks: WatchedTask[];
  observer: PerformanceObserver;
}

// The history's first render is done before the watch begins, so the window
// from the run's opening to its last batch counts only what the run costs.
Step(
  "the page's main thread has been quiet for {int} ms within {int} seconds",
  async ({ page }, quietMs: number, seconds: number) => {
    const quiet = await page.evaluate(
      ({ quietFor, within }) =>
        new Promise<boolean>((resolve) => {
          let timer = setTimeout(() => finish(true), quietFor);
          const deadline = setTimeout(() => finish(false), within);
          const observer = new PerformanceObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(true), quietFor);
          });
          function finish(ok: boolean): void {
            clearTimeout(timer);
            clearTimeout(deadline);
            observer.disconnect();
            resolve(ok);
          }
          observer.observe({ type: "longtask" });
        }),
      { quietFor: quietMs, within: secondsToMs(seconds) },
    );
    expect(quiet, `the main thread ran no long task for ${String(quietMs)} ms`).toBe(true);
  },
);

Step("I start watching the page's main-thread tasks", async ({ page }) => {
  await inThePage(page, () => {
    const watch = {
      since: performance.now(),
      tasks: [] as { startTime: number; duration: number }[],
      observer: null as PerformanceObserver | null,
    };
    watch.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) watch.tasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    watch.observer.observe({ type: "longtask" });
    (window as unknown as { __mainThreadWatch: typeof watch }).__mainThreadWatch = watch;
  });
});

/** The long tasks the current watch saw (start ms after it began, duration ms); the watch then stops. */
async function watchedTasks(page: Page): Promise<WatchedTask[]> {
  // Let the last frame's work finish and its entries be delivered.
  await inThePage(
    page,
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(), 300))),
  );
  const tasks = await inThePage(page, (): WatchedTask[] | null => {
      const watch = (window as unknown as { __mainThreadWatch?: TaskWatch }).__mainThreadWatch;
      if (watch === undefined) return null;
      for (const entry of watch.observer.takeRecords()) {
        watch.tasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
      watch.observer.disconnect();
      return watch.tasks
        .filter((t) => t.startTime >= watch.since)
        .map((t) => ({ startTime: Math.round(t.startTime - watch.since), duration: Math.round(t.duration) }));
  });
  expect(tasks, "the page's main-thread tasks were being watched").not.toBeNull();
  return tasks ?? [];
}

function summarise(watched: readonly WatchedTask[]): { longest: number; summary: string } {
  const longest = watched.reduce((max, t) => Math.max(max, t.duration), 0);
  const total = watched.reduce((sum, t) => sum + t.duration, 0);
  return { longest, summary: `${String(watched.length)} long tasks, ${String(total)} ms in all, the longest ${String(longest)} ms` };
}

Step(
  "no main-thread task the page ran from the run's opening through its last batch took longer than {int} ms",
  async ({ page, $testInfo }, boundMs: number) => {
    const watched = await watchedTasks(page);
    const { summary } = summarise(watched);
    $testInfo.annotations.push({ type: "main-thread long tasks from the run's opening through its last batch", description: summary });
    console.log(`[runs-tab responsiveness] opening through the last batch: ${summary}`);
    const over = watched.filter((t) => t.duration > boundMs);
    expect(over, `${summary}; tasks over ${String(boundMs)} ms (start ms after watching began, duration ms)`).toEqual([]);
  },
);

// The close is measured, never bounded: the read that closes a run changes the
// settled history and may rebuild the timeline once.
Step("the longest main-thread task the page ran while the run closed is reported", async ({ page, $testInfo }) => {
  const watched = await watchedTasks(page);
  const { longest, summary } = summarise(watched);
  $testInfo.annotations.push({ type: "main-thread long tasks while the run closed", description: summary });
  console.log(`[runs-tab responsiveness] the close: ${summary}`);
  expect(Number.isFinite(longest) && longest >= 0, `the close's longest task was measured: ${summary}`).toBe(true);
});

Step(
  "the closed run's card heads the Runs timeline of {int} settled run cards and no running card is left within {int} seconds",
  async ({ page, world }, count: number, seconds: number) => {
    const eventId = world.eventId as string;
    await untilThePageReads(
      page,
      runsTimelineHead,
      eventId,
      { running: 0, cards: count, head: eventId, carrying: 1 },
      secondsToMs(seconds),
      `the Runs timeline holds no running card and ${String(count)} settled cards, headed by the closed run ${eventId} and carrying it once`,
    );
  },
);
