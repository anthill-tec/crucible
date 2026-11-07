// Every part of an agent's card shows a field the board first leaves out and a
// later read then serves, even when nothing else about the agent or its run
// changes in that read.
//
// The page holds the agents in `state.agents` and the open runs in
// `state.openRuns`, and each read replaces its slice in place (`vanX.replace`
// in `refetchAgents` / `refetchEvents`, public/app.js): a field that arrives as
// a NEW key on a record the page already holds is added to that record, and a
// binding that read the key while it was absent subscribed to nothing that
// the addition changes. The card parts pinned here are:
//   - the agent's display name (`identity.displayName`, `AgentRow`'s id span),
//   - its runtime (`runtime_ms`, the `agent-runtime` meta),
//   - its last seen (`lastSeen`, the `seen …` meta),
//   - the running run the active cycle's span names (`run.context.cycleId`,
//     `runningRunsFor` → `OpenSpan` → `open-span-running-entry`).
// Each test mounts the page with the field absent, checks the card shows
// nothing for it, then has the board serve the same record with that one
// field added, through the page's own stream-triggered read.
//
// Drives the REAL public/app.js with the vendored van/van-x under happy-dom,
// a scripted `fetch` that reads the fixture at call time, and the shared
// fake EventSource, so a test fires a real `agents` / `events` frame.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { singleReleaseHistoryStub } from "./helpers/history-stub";
import { FakeEventSource, installEventSource, restoreEventSource } from "./helpers/stream-workspace-harness";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

const PROJECT_KEY = "proj-card-shows-late-fields";
const AGENT_ID = "late-field-agent";
const MESSAGE = "writing the tests";
const CYCLE_ID = 8801;
const RUN_ID = "run-late-cycle";

/** An agent as the agents read serves it; every field but the ids may be left out. */
interface AgentRecord {
  agentId: string;
  projectKey: string;
  liveness: "online" | "stale" | "tombstoned";
  message?: string;
  lastSeen?: number;
  runtime_ms?: number;
  identity?: { displayName?: string; source?: string };
}

interface OpenRunRecord {
  runId: string;
  projectKey: string;
  agentId: string;
  startedAt: number;
  tier: string;
  context?: { cycleId?: number };
}

interface PlanRecord {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  cycles: { id: number; label: string; status: "pending" | "active" | "done" }[];
}

interface Board {
  agents: AgentRecord[];
  openRuns: OpenRunRecord[];
  plans: PlanRecord[];
}

interface Page {
  readonly fetchLog: string[];
  source(): FakeEventSource;
}

let cacheBust = 0;

function respond(status: number, body: unknown): Response {
  // A fresh copy on every answer, as a new JSON body would be.
  const copy = structuredClone(body);
  return { ok: status < 400, status, json: async () => copy, text: async () => JSON.stringify(copy) } as Response;
}

/** Mount the workspace at `/p/<key>`; every read answers from `board` at call time. */
async function mountPage(board: Board): Promise<Page> {
  const fetchLog: string[] = [];
  let stream: FakeEventSource | null = null;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${PROJECT_KEY}` });
  document.body.innerHTML = '<div id="app"></div>';
  const now = Date.now();

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string): Promise<Response> => {
    const url = String(input);
    fetchLog.push(url);
    if (/\/api\/v2\/projects\/[^/?]+\/history/.test(url)) return respond(200, singleReleaseHistoryStub(board.plans));
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) return respond(200, { ok: true, plans: board.plans });
    if (/\/api\/v2\/projects\/[^/?]+\/release-proposals/.test(url)) {
      return respond(200, { ok: true, proposals: [], totalCount: 0 });
    }
    if (/\/api\/v2\/projects\/[^/?]+\/releases/.test(url)) return respond(200, { ok: true, releases: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) return respond(200, { ok: true, entries: [] });
    if (url.startsWith("/api/v2/projects")) {
      return respond(200, {
        ok: true,
        projects: [
          {
            key: PROJECT_KEY,
            name: "Card Shows Late Fields",
            type: "backend",
            agentsOnline: 1,
            agentsTotal: 1,
            active: true,
            lastActivity: now,
          },
        ],
      });
    }
    if (url.includes("/api/v2/agents")) return respond(200, { ok: true, agents: board.agents });
    if (url.includes("/api/v2/events?") || url.endsWith("/api/v2/events")) {
      return respond(200, { ok: true, events: [], openRuns: board.openRuns });
    }
    if (url.includes("/api/v2/health")) return respond(200, { ok: true, version: "2.0.0-test", counts: { events: 0 } });
    return respond(404, { ok: false, error: `unscripted url ${url}` });
  }) as typeof fetch;

  installEventSource(
    class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        stream = this;
      }
    },
  );

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?cardShowsLateFields=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 12 });

  return {
    fetchLog,
    source: () => {
      if (stream === null) throw new Error("the page opened no stream");
      return stream;
    },
  };
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  restoreEventSource();
});

function squash(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The project pane's one agent card. */
function theCard(): HTMLElement {
  const pane = document.querySelector('[data-testid="project-pane"]');
  expect(pane, "the workspace renders its Project pane").not.toBeNull();
  const rows = Array.from(pane?.querySelectorAll<HTMLElement>('[data-testid="agent-row"]') ?? []);
  expect(rows, "the pane holds exactly the one agent's card").toHaveLength(1);
  return rows[0] as HTMLElement;
}

/** The text of every meta line on the card that is not its runtime. */
function seenMetas(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll<HTMLElement>(".app-card-meta"))
    .filter((el) => el.getAttribute("data-testid") !== "agent-runtime")
    .map((el) => squash(el));
}

function readsOf(page: Page, fragment: string): number {
  return page.fetchLog.filter((url) => url.includes(fragment)).length;
}

/** The board now serves `agent` (and only it); the page reads it on an `agents` frame. */
async function nextAgentsAnswer(page: Page, board: Board, agent: AgentRecord): Promise<void> {
  const before = readsOf(page, "/api/v2/agents");
  board.agents.splice(0, board.agents.length, agent);
  page.source().dispatch("agents", PROJECT_KEY);
  await settleDom({ ticks: 12 });
  expect(readsOf(page, "/api/v2/agents"), "the frame made the page read the agents again").toBe(before + 1);
}

/** The board now serves exactly `runs`; the page reads them on an `events` frame. */
async function nextEventsAnswer(page: Page, board: Board, runs: OpenRunRecord[]): Promise<void> {
  const before = readsOf(page, "/api/v2/events?");
  board.openRuns.splice(0, board.openRuns.length, ...runs);
  page.source().dispatch("events", PROJECT_KEY);
  await settleDom({ ticks: 12 });
  expect(readsOf(page, "/api/v2/events?"), "the frame made the page read the events again").toBeGreaterThan(before);
}

function boardWith(agent: AgentRecord): Board {
  return { agents: [agent], openRuns: [], plans: [] };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("an agent's card shows a field a later agents read serves with nothing else changed", () => {
  test("the card names the agent by its display name once an agents read serves one, where it named it by its id", async () => {
    const lastSeen = Date.now();
    const agent: AgentRecord = {
      agentId: AGENT_ID,
      projectKey: PROJECT_KEY,
      liveness: "online",
      lastSeen,
      message: MESSAGE,
      runtime_ms: 65_000,
    };
    const board = boardWith({ ...agent });
    const page = await mountPage(board);
    page.source().open();
    await settleDom({ ticks: 12 });
    const idSpan = (): string => squash(theCard().querySelector(".app-agent-id"));
    expect(idSpan()).toBe(`⌁ ${AGENT_ID}`);

    await nextAgentsAnswer(page, board, { ...agent, identity: { displayName: "Test Writer", source: "manual" } });

    expect(idSpan()).toBe("⌁ Test Writer");
    expect(idSpan()).not.toContain(AGENT_ID);
    // The rest of the card is as it was.
    expect(squash(theCard().querySelector(".app-agent-msg"))).toBe(MESSAGE);
    expect(squash(theCard().querySelector('[data-testid="agent-runtime"]'))).toBe("1m 5s");
  });

  test("the card shows the agent's runtime once an agents read serves one, where it showed none", async () => {
    const agent: AgentRecord = {
      agentId: AGENT_ID,
      projectKey: PROJECT_KEY,
      liveness: "online",
      lastSeen: Date.now(),
      message: MESSAGE,
    };
    const board = boardWith({ ...agent });
    const page = await mountPage(board);
    page.source().open();
    await settleDom({ ticks: 12 });
    expect(theCard().querySelectorAll('[data-testid="agent-runtime"]')).toHaveLength(0);

    await nextAgentsAnswer(page, board, { ...agent, runtime_ms: 125_000 });

    const runtime = theCard().querySelectorAll('[data-testid="agent-runtime"]');
    expect(runtime).toHaveLength(1);
    expect(squash(runtime[0])).toBe("2m 5s");
    expect(squash(theCard().querySelector(".app-agent-msg"))).toBe(MESSAGE);
  });

  test("the card shows when the agent was last seen once an agents read serves it, where it showed no last seen", async () => {
    const agent: AgentRecord = {
      agentId: AGENT_ID,
      projectKey: PROJECT_KEY,
      liveness: "online",
      message: MESSAGE,
      runtime_ms: 65_000,
    };
    const board = boardWith({ ...agent });
    const page = await mountPage(board);
    page.source().open();
    await settleDom({ ticks: 12 });
    expect(seenMetas(theCard())).toEqual([]);

    // Five minutes ago, so the relative time reads the same however long the test takes.
    await nextAgentsAnswer(page, board, { ...agent, lastSeen: Date.now() - 300_000 });

    expect(seenMetas(theCard())).toEqual(["seen 5m ago"]);
    expect(squash(theCard().querySelector('[data-testid="agent-runtime"]'))).toBe("1m 5s");
  });
});

describe("the active cycle's span names a running run once an events read serves the run's cycle", () => {
  test("a running run first served with no cycle, then served with the active cycle's id and nothing else changed, shows as that cycle's running entry", async () => {
    const startedAt = Date.now() - 2_000;
    const run: OpenRunRecord = {
      runId: RUN_ID,
      projectKey: PROJECT_KEY,
      agentId: AGENT_ID,
      startedAt,
      tier: "unit",
    };
    const board: Board = {
      agents: [{ agentId: AGENT_ID, projectKey: PROJECT_KEY, liveness: "online", lastSeen: Date.now(), message: MESSAGE }],
      openRuns: [{ ...run }],
      plans: [
        {
          planId: 88,
          cr: "CR-LATE-CYCLE",
          projectKey: PROJECT_KEY,
          status: "open",
          wave: "1",
          cycles: [{ id: CYCLE_ID, label: "late cycle", status: "active" }],
        },
      ],
    };
    const page = await mountPage(board);
    page.source().open();
    await settleDom({ ticks: 12 });

    const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).find(
      (t) => (t.textContent ?? "").trim() === "Workflow",
    );
    expect(tab, "the workspace has its Workflow tab").toBeDefined();
    tab?.click();
    await settleDom({ ticks: 12 });

    const activeRow = (): HTMLElement => {
      const rows = document.querySelectorAll<HTMLElement>(
        `[data-testid="workflow-active"] [data-testid="cycle-row"][data-cycle-id="${CYCLE_ID}"]`,
      );
      expect(rows, "the active plan draws its one active cycle").toHaveLength(1);
      const row = rows[0] as HTMLElement;
      expect(row.getAttribute("data-status")).toBe("active");
      return row;
    };
    // The run names no cycle yet: the active cycle has nothing to show.
    expect(activeRow().querySelectorAll('[data-testid="open-span"]')).toHaveLength(0);

    await nextEventsAnswer(page, board, [{ ...run, context: { cycleId: CYCLE_ID } }]);

    const spans = activeRow().querySelectorAll<HTMLElement>('[data-testid="open-span"]');
    expect(spans).toHaveLength(1);
    const running = (spans[0] as HTMLElement).querySelectorAll<HTMLElement>('[data-testid="open-span-running-entry"]');
    expect(running).toHaveLength(1);
    expect((running[0] as HTMLElement).getAttribute("data-run-id")).toBe(RUN_ID);
    expect(squash((running[0] as HTMLElement).querySelector(".app-agent-id"))).toBe(AGENT_ID);
  });
});
