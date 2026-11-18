// An agent's card reads the idle line the board serves for it, even when that
// idle line is the only thing the agents read changed.
//
// Between runs the card (`AgentRow` → its `.app-agent-msg` binding,
// public/app.js) reads the agent's `idleLine`, else its own message. The page
// holds the agents in `state.agents`, whose one writer (`refetchAgents`)
// replaces the whole slice from each agents read. An agent record that held
// no `idleLine` and is then served one — with its message, liveness and last
// seen exactly as before — must still move the card to that idle line: the
// card's line is re-evaluated on every replacement of the page's agents,
// whatever it read when it last ran.
//
// Drives the REAL public/app.js with the vendored van/van-x through
// tests/helpers/live-run-harness.ts at the workspace route `/p/<key>`.
import { describe, test, expect, afterEach } from "bun:test";
import { mountLive, settle, unmountLive, type AgentFixture, type LiveMountOpts } from "../helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "[REDACTED:Generic long secret]";
const AGENT_ID = "idle-line-agent";
const MESSAGE = "gated test run starting";
const IDLE_LINE = "idle · RED · no cycle bound · last run 4 ✓ 1 ✗ · ingested, just now";
const NOW = Date.now();

const AGENT: AgentFixture = {
  agentId: AGENT_ID,
  projectKey: PROJECT_KEY,
  liveness: "online",
  lastSeen: NOW,
  message: MESSAGE,
};

function workspace(): LiveMountOpts {
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Idle Line On Its Own",
        type: "backend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: NOW,
      },
    ],
    agents: [{ ...AGENT }],
    events: [],
    eventDetails: {},
    openRuns: [],
    live: {},
  };
}

function squash(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function agentRows(): HTMLElement[] {
  const pane = document.querySelector('[data-testid="project-pane"]');
  expect(pane, "the workspace renders its Project pane").not.toBeNull();
  return Array.from(pane?.querySelectorAll<HTMLElement>('[data-testid="agent-row"]') ?? []).filter((row) =>
    (row.textContent ?? "").includes(AGENT_ID),
  );
}

function cardLine(): string {
  const rows = agentRows();
  expect(rows).toHaveLength(1);
  const msg = (rows[0] as HTMLElement).querySelector(".app-agent-msg");
  expect(msg, `the card of ${AGENT_ID} has its .app-agent-msg`).not.toBeNull();
  return squash(msg);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("an agent's card reads an idle line the agents read serves on its own", () => {
  test("a card reading its agent's message reads the idle line once an agents read serves one with every other field of the agent unchanged", async () => {
    const opts = workspace();
    const page = await mountLive(opts);
    expect(cardLine()).toBe(MESSAGE);
    page.source().open();
    await settle();
    expect(cardLine()).toBe(MESSAGE);

    // The board's next agents answer: the same agent, field for field, now
    // carrying an idle line it did not carry before.
    const agentsReads = (): number => page.fetchLog.filter((url) => url.includes("/api/v2/agents")).length;
    const readsBefore = agentsReads();
    const withIdleLine: AgentFixture & { idleLine: string } = { ...AGENT, idleLine: IDLE_LINE };
    opts.agents.splice(0, opts.agents.length, withIdleLine);
    page.source().dispatch("agents", PROJECT_KEY);
    await settle();

    // The page read the agents again, and the card is still the agent's one row.
    expect(agentsReads()).toBe(readsBefore + 1);
    expect(cardLine()).toBe(IDLE_LINE);
    expect(cardLine()).not.toContain(MESSAGE);
  });
});
