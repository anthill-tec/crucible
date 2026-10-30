// The agent's row reads the live count of its streamed run (§S4, AC11):
// `AgentRow` (public/app.js) composes the agent's line in the browser from
// `state.openRuns` — the slice `events` frames already move and CR-CRU-223's
// open-run brief already serves.
//
//   - Which run: the NEWEST open run of that agent (by `startedAt`) carrying
//     `live`; a newer run without `live`, or another agent's run, is passed over.
//   - The line: `running <completed>/<total> · <currentFile>`, or
//     `running <completed> done · <currentFile>` without a total; the file part
//     is absent without a current file.
//   - No live run: the row reads the agent's own line as today
//     (`idleLine`, else `message`).
//   - The line moves when an `events` frame refreshes the open runs, without a
//     reload.
//
// Drives the REAL public/app.js through tests/helpers/live-run-harness.ts at
// the workspace route `/p/<key>`, where the Project pane renders the agent
// rows; each open run's `live` is fixture data on the events feed. The agents
// read serves no running field (§S4) — its server half is pinned in
// tests/a-stream-batch-is-atomic-and-keeps-its-agent-live.test.ts.
import { describe, test, expect, afterEach } from "bun:test";
import {
  mountLive,
  settle,
  unmountLive,
  type AgentFixture,
  type LiveCounts,
  type LiveMountOpts,
  type OpenRunFixture,
} from "./helpers/live-run-harness";

afterEach(async () => {
  await unmountLive();
});

const PROJECT_KEY = "proj-agent-live-line";
const AGENT_ID = "streaming-agent";
const OTHER_AGENT = "bystander-agent";
const MESSAGE = "running 7/10";

const LIVE: LiveCounts = { completed: 412, total: 1280, passed: 409, failed: 3, pending: 0, currentFile: "test_relay.py" };

function agent(agentId: string, message: string): AgentFixture {
  return { agentId, projectKey: PROJECT_KEY, liveness: "online", lastSeen: Date.now(), message };
}

function run(runId: string, agentId: string, startedAt: number, live?: LiveCounts): OpenRunFixture {
  return { runId, projectKey: PROJECT_KEY, agentId, startedAt, tier: "unit", ...(live !== undefined ? { live } : {}) };
}

function workspace(openRuns: OpenRunFixture[], agents: AgentFixture[] = [agent(AGENT_ID, MESSAGE)]): LiveMountOpts {
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Agent Live Line",
        type: "backend",
        agentsOnline: agents.length,
        agentsTotal: agents.length,
        active: true,
        lastActivity: Date.now(),
      },
    ],
    agents,
    events: [],
    eventDetails: {},
    openRuns,
    live: {},
  };
}

/** The `.app-agent-msg` text of the agent's row in the Project pane. */
function agentLine(agentId: string): string {
  const pane = document.querySelector('[data-testid="project-pane"]');
  expect(pane, "the workspace renders its Project pane").not.toBeNull();
  const rows = Array.from(pane?.querySelectorAll('[data-testid="agent-row"]') ?? []).filter((row) =>
    (row.textContent ?? "").includes(agentId),
  );
  expect(rows).toHaveLength(1);
  const msg = rows[0]?.querySelector(".app-agent-msg");
  expect(msg, `agent-row for ${agentId} has its .app-agent-msg`).not.toBeNull();
  return (msg?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const NOW = Date.now();

// ═══════════════════════════════════════════════════════════════════════════

describe("AgentRow — an agent whose newest open run carries `live` reads §S4's running line", () => {
  test("with a total and a current file: `running 412/1280 · test_relay.py`", async () => {
    await mountLive(workspace([run("run-live-1", AGENT_ID, NOW - 41_000, LIVE)]));
    expect(agentLine(AGENT_ID)).toBe("running 412/1280 · test_relay.py");
  });

  test("without a total: `running 412 done · test_relay.py`", async () => {
    const { total: _total, ...noTotal } = LIVE;
    await mountLive(workspace([run("run-live-2", AGENT_ID, NOW - 41_000, noTotal)]));
    expect(agentLine(AGENT_ID)).toBe("running 412 done · test_relay.py");
  });

  test("without a current file the file part is absent: `running 412/1280`, and `running 412 done` without a total either", async () => {
    const { currentFile: _file, ...noFile } = LIVE;
    await mountLive(workspace([run("run-live-3", AGENT_ID, NOW - 41_000, noFile)]));
    expect(agentLine(AGENT_ID)).toBe("running 412/1280");
    await unmountLive();

    const { total: _total, ...bare } = noFile;
    await mountLive(workspace([run("run-live-4", AGENT_ID, NOW - 41_000, bare)]));
    expect(agentLine(AGENT_ID)).toBe("running 412 done");
  });

  test("with two open runs carrying `live`, the newest wins — whichever order the feed lists them in", async () => {
    const older = run("run-older", AGENT_ID, NOW - 90_000, { ...LIVE, completed: 12, currentFile: "test_old.py" });
    const newer = run("run-newer", AGENT_ID, NOW - 10_000, { ...LIVE, completed: 3, total: 40, currentFile: "test_new.py" });
    await mountLive(workspace([older, newer]));
    expect(agentLine(AGENT_ID)).toBe("running 3/40 · test_new.py");
    await unmountLive();

    await mountLive(workspace([newer, older]));
    expect(agentLine(AGENT_ID)).toBe("running 3/40 · test_new.py");
  });

  test("a newer open run WITHOUT `live` is passed over for the newest one that carries it", async () => {
    const streamed = run("run-streamed", AGENT_ID, NOW - 90_000, LIVE);
    const unstreamed = run("run-unstreamed", AGENT_ID, NOW - 5_000);
    await mountLive(workspace([unstreamed, streamed]));
    expect(agentLine(AGENT_ID)).toBe("running 412/1280 · test_relay.py");
  });

  test("another agent's live run moves only that agent's row", async () => {
    await mountLive(
      workspace(
        [run("run-bystander", OTHER_AGENT, NOW - 20_000, LIVE)],
        [agent(AGENT_ID, MESSAGE), agent(OTHER_AGENT, "bystander heartbeat")],
      ),
    );
    expect(agentLine(OTHER_AGENT)).toBe("running 412/1280 · test_relay.py");
    expect(agentLine(AGENT_ID)).toBe(MESSAGE);
  });
});

describe("AgentRow — without a live run the row reads the agent's line as today", () => {
  test("an open run with no `live`: the agent's own message", async () => {
    await mountLive(workspace([run("run-no-live", AGENT_ID, NOW - 41_000)]));
    expect(agentLine(AGENT_ID)).toBe(MESSAGE);
  });

  test("no open run at all: the server's idle line, else the message", async () => {
    const idle: AgentFixture & { idleLine: string } = {
      ...agent(AGENT_ID, "7 ✓ 0 ✗ · ingested"),
      idleLine: "idle · GREEN · cycle 2/5 · last run 7 ✓ 0 ✗ · ingested, just now",
    };
    await mountLive(workspace([], [idle]));
    expect(agentLine(AGENT_ID)).toBe("idle · GREEN · cycle 2/5 · last run 7 ✓ 0 ✗ · ingested, just now");
  });
});

describe("AgentRow — the line moves with an `events` frame, without a reload", () => {
  test("the open run's `live` grows and a frame arrives: the row reads the new count and file; the run settles and a frame arrives: the row reads the agent's message again", async () => {
    const opts = workspace([run("run-moving", AGENT_ID, NOW - 41_000, LIVE)]);
    const page = await mountLive(opts);
    expect(agentLine(AGENT_ID)).toBe("running 412/1280 · test_relay.py");
    // A witness a reload would destroy.
    (window as unknown as Record<string, unknown>).__agentLineNoReload = "sentinel";

    const moving = opts.openRuns[0];
    expect(moving).toBeDefined();
    if (moving !== undefined) moving.live = { ...LIVE, completed: 413, passed: 410, currentFile: "test_stream.py" };
    page.source().open();
    page.source().dispatch("events", PROJECT_KEY);
    await settle();
    expect(agentLine(AGENT_ID)).toBe("running 413/1280 · test_stream.py");

    opts.openRuns.splice(0, opts.openRuns.length);
    page.source().dispatch("events", PROJECT_KEY);
    await settle();
    expect(agentLine(AGENT_ID)).toBe(MESSAGE);
    // The same page throughout: no navigation, and the witness survives.
    expect(page.pushed).toEqual([]);
    expect((window as unknown as Record<string, unknown>).__agentLineNoReload).toBe("sentinel");
  });
});
