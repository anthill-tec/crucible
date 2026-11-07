// The streaming agent card's running line keeps its text and names its file
// on hover. While an agent's run streams, its card in the Project pane reads
// `running <done>/<total> · <current file>` (`agentLiveLine`, public/app.js).
// A long file is cut on screen from its start, but the cut is visual only:
//
//   - the line's text stays `running N/M · <whole current file>`, for a file
//     that is cut and for one that fits, and a file that fits carries no `…`;
//   - the file part carries the whole current file as its hover title.
//
// How the cut is DRAWN (the count whole, the file's end visible, the leading
// `…`, one line inside the card, no pane overflow) is a layout claim only a
// real browser can measure: it lives in the e2e feature
// agent-card-keeps-a-long-running-file-inside-it.feature. This file pins the
// text and the title, which need no layout.
//
// Drives the REAL public/app.js through tests/helpers/live-run-harness.ts at
// the workspace route `/p/<key>`, where the Project pane renders the agent
// cards; the open run's `live` is fixture data on the events feed.
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

const PROJECT_KEY = "proj-agent-card-running-file";
const AGENT_ID = "long-file-runner";
const NOW = Date.now();

/** A test path far longer than any agent card is wide, with no break point. */
const LONG_FILE =
  "./tests/client/integration_suites/maven_runner_contracts/exit_code_propagation_and_file_reporting/" +
  "forked_surefire_processes/test_mvn_exits_and_files_on_its_runners_exit_code_when_the_forked_surefire_process_dies_mid_suite.py";

const SHORT_FILE = "src/short.test.ts";

function live(currentFile: string, completed: number, total: number): LiveCounts {
  return { completed, total, passed: completed, failed: 0, pending: 0, currentFile };
}

function workspace(currentFile: string, completed: number, total: number): LiveMountOpts {
  const agent: AgentFixture = {
    agentId: AGENT_ID,
    projectKey: PROJECT_KEY,
    liveness: "online",
    lastSeen: NOW,
    message: "suite starting",
  };
  const run: OpenRunFixture = {
    runId: "run-running-file",
    projectKey: PROJECT_KEY,
    agentId: AGENT_ID,
    startedAt: NOW - 30_000,
    tier: "unit",
    live: live(currentFile, completed, total),
  };
  return {
    pathname: `/p/${PROJECT_KEY}`,
    projects: [
      {
        key: PROJECT_KEY,
        name: "Agent Card Running File",
        type: "backend",
        agentsOnline: 1,
        agentsTotal: 1,
        active: true,
        lastActivity: NOW,
      },
    ],
    agents: [agent],
    events: [],
    eventDetails: {},
    openRuns: [run],
    live: {},
  };
}

/** The `.app-agent-msg` line of the agent's one card in the Project pane. */
function runningLine(): Element {
  const pane = document.querySelector('[data-testid="project-pane"]');
  expect(pane, "the workspace renders its Project pane").not.toBeNull();
  const cards = Array.from(pane?.querySelectorAll('[data-testid="agent-row"]') ?? []).filter((card) =>
    (card.textContent ?? "").includes(AGENT_ID),
  );
  expect(cards).toHaveLength(1);
  const line = cards[0]?.querySelector(".app-agent-msg") ?? null;
  expect(line, `the card for ${AGENT_ID} has its .app-agent-msg line`).not.toBeNull();
  if (line === null) throw new Error("unreachable: asserted above");
  return line;
}

/** Every element of the line that carries a hover title: its text and its title. */
function titledParts(line: Element): { text: string; title: string }[] {
  const titled = [line, ...Array.from(line.querySelectorAll("*"))].filter((el) => el.hasAttribute("title"));
  return titled.map((el) => ({ text: (el.textContent ?? "").trim(), title: el.getAttribute("title") ?? "" }));
}

describe("agent card running line — the cut is visual only, the text stays whole", () => {
  test("a file longer than the card: the line's text is `running N/M · <whole current file>`, the path's start included", async () => {
    await mountLive(workspace(LONG_FILE, 1516, 1943));
    const text = runningLine().textContent ?? "";
    expect(text).toBe(`running 1516/1943 · ${LONG_FILE}`);
    // The cut must not drop the path's start, nor put a `…` into the text.
    expect(text).toContain("./tests/client/");
    expect(text).not.toContain("…");
  });

  test("a file that fits: the line's text is `running N/M · <file>`, whole and with no `…`", async () => {
    await mountLive(workspace(SHORT_FILE, 2, 6));
    const text = runningLine().textContent ?? "";
    expect(text).toBe(`running 2/6 · ${SHORT_FILE}`);
    expect(text).not.toContain("…");
  });
});

describe("agent card running line — the whole path on hover", () => {
  test("a file longer than the card: the file part, and only it, carries the whole current file as its hover title", async () => {
    await mountLive(workspace(LONG_FILE, 1516, 1943));
    expect(titledParts(runningLine())).toEqual([{ text: LONG_FILE, title: LONG_FILE }]);
  });

  test("the hover title follows the current file when the run moves to another long file", async () => {
    const opts = workspace(LONG_FILE, 1516, 1943);
    const page = await mountLive(opts);
    expect(titledParts(runningLine())).toEqual([{ text: LONG_FILE, title: LONG_FILE }]);

    const next = LONG_FILE.replace("mid_suite.py", "after_the_last_report_is_written.py");
    const run = opts.openRuns[0];
    if (run === undefined) throw new Error("the fixture has its open run");
    run.live = live(next, 1517, 1943);
    page.source().open();
    page.source().dispatch("events", PROJECT_KEY);
    await settle();
    expect(runningLine().textContent).toBe(`running 1517/1943 · ${next}`);
    expect(titledParts(runningLine())).toEqual([{ text: next, title: next }]);
  });
});
