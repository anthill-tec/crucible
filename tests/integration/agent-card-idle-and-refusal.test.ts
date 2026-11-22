// CR-CRU-157 AC6–AC8 (C3) — the card, not just the wire: `AgentRow` (public/
// app.js) renders the agent's own run message during a run; once the server
// says the agent is idle (the companion server file
// tests/unit/agent-idle-line-derived-at-read-time.test.ts pins the `idleLine`
// field's presence rule), the row shows THAT composed line instead of the
// raw message; and a refused ingest's refusal (the server file
// tests/unit/ingest-outcome-overwrites-agent-message.test.ts pins its exact text)
// stays visible on the row, never papered over by a stale `running N/M`.
//
// Today `AgentRow` renders `agent.message || "—"` unconditionally — it has
// NO branch for an `idleLine` field at all, so the moment a fixture's
// `idleLine` differs from its `message` (exactly what a real idle read
// looks like, since §S2 overwrites `message` with the OUTCOME text while
// §S3's idle line additionally wraps role/cycle/age around it), the row
// keeps showing the stale `message` text instead of the composed line.
//
// Harness: the real production `public/app.js` shell inside happy-dom, the
// same `mountApp`/poll-tick pattern tests/integration/agent-runtime-pane.test.ts and
// tests/integration/inpane-liveness.test.ts already use — fetch is scripted to read live
// fixture objects so a poll-tick refetch observes an in-place mutation.
import { describe, test, expect, afterEach } from "bun:test";
import { mountUi, SHORT_POLL, unmountUi, waitForPollTick, type UiIntervals } from "../helpers/ui-mount";

// The lifecycle test mounts with a SHORT poll (`SHORT_POLL`, its own mount
// only) and waits for each tick's read through the shared `waitForPollTick`
// (1 s deadline); the bound is sized to two short ticks, so a poll that never
// fires fails fast.
const POLL_TEST_TIMEOUT_MS = 5_000;

interface AgentFixture {
  agentId: string;
  projectKey: string;
  status?: "online" | "busy";
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
  message?: string;
  // CR-CRU-157 §S3 — additive: ABSENT means "has an open run", present means
  // "the server says idle" (this file's own subject).
  idleLine?: string;
  identity?: { displayName?: string };
  runtime_ms?: number;
}
interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  agents: AgentFixture[];
  /** Short intervals for this mount only; omitted = the production cadences. */
  intervals?: UiIntervals;
}

/** The shared UI mount, answered from this file's live fixture objects. */
async function mountApp(opts: MountOpts): Promise<void> {
  await mountUi({ pathname: opts.pathname ?? "/", intervals: opts.intervals, fetch: async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: opts.agents };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [], openRuns: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`agent-card-idle-and-refusal.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  } });
}

afterEach(async () => {
  await unmountUi();
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").includes(text),
  ) as HTMLElement | undefined;
}

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 1,
    agentsTotal: 1,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentFixture> & { agentId: string; projectKey: string }): AgentFixture {
  return {
    liveness: "online",
    lastSeen: Date.now(),
    message: "idle",
    runtime_ms: 0,
    ...overrides,
  };
}

function agentRowMessageText(projectPane: HTMLElement, agentId: string): string {
  const row = findByText(projectPane, '[data-testid="agent-row"]', agentId);
  if (row === undefined) throw new Error(`no agent-row found for ${agentId}`);
  const msgEl = row.querySelector(".app-agent-msg");
  if (msgEl === null) throw new Error(`agent-row for ${agentId} has no .app-agent-msg element`);
  return (msgEl.textContent ?? "").trim();
}

describe("CR-CRU-157 AC6–AC8 — AgentRow renders the running message, the server's idle line, or the refusal — never a stale running count", () => {
  test(
    "across a run's full lifecycle — running, then the server says idle, then a refused next ingest — the row shows the running message, then the EXACT idle line (not the raw outcome message), then the EXACT refusal (never the earlier running count or idle line)",
    async () => {
      const projectKey = "proj-idle-lifecycle-1";
      const agentId = "lifecycle-agent-1";
      const opts: MountOpts = {
        intervals: SHORT_POLL,
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Idle Lifecycle Project" })],
        agents: [
          agent({
            agentId,
            projectKey,
            message: "running 7/10",
            // No idleLine — a run is open.
          }),
        ],
      };
      await mountApp(opts);

      const paneInitial = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      expect(paneInitial).not.toBeNull();
      // State 1 — mid-run: the raw client heartbeat, verbatim.
      expect(agentRowMessageText(paneInitial, agentId)).toBe("running 7/10");

      // State 2 — the server says idle: §S2 has already overwritten `message`
      // with the outcome tally, and §S3 additionally serves `idleLine`. The
      // row must show the LATTER, not the former.
      opts.agents[0]!.message = "7 ✓ 0 ✗ · ingested";
      opts.agents[0]!.idleLine =
        "idle · GREEN · lifecycle-fixture · cycle 2/5 · last run 7 ✓ 0 ✗ · ingested, just now";
      await waitForPollTick();
      const paneIdle = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      const idleText = agentRowMessageText(paneIdle, agentId);
      // POSITIVE — the exact composed line.
      expect(idleText).toBe(
        "idle · GREEN · lifecycle-fixture · cycle 2/5 · last run 7 ✓ 0 ✗ · ingested, just now",
      );
      // NEGATIVE bound — not the bare outcome `message` the server ALSO
      // carries (a card that fell back to `message` would read this
      // instead, losing the role/cycle/age context §S3 requires).
      expect(idleText).not.toBe("7 ✓ 0 ✗ · ingested");
      expect(idleText).not.toContain("running 7/10");

      // State 3 — a second run opens, is refused mid-flight: the open run
      // means `idleLine` is withdrawn (absent, never stale) and `message`
      // carries the refusal.
      opts.agents[0]!.idleLine = undefined;
      opts.agents[0]!.message = "ingest refused — cycle 9 is done";
      await waitForPollTick();
      const paneRefused = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      const refusedText = agentRowMessageText(paneRefused, agentId);
      // POSITIVE — the exact refusal.
      expect(refusedText).toBe("ingest refused — cycle 9 is done");
      // NEGATIVE bound — never a stale running count or the superseded idle
      // line (the AC8 "never a stale running N/M" guard).
      expect(refusedText).not.toContain("running 7/10");
      expect(refusedText).not.toMatch(/running \d+\/\d+/);
      expect(refusedText).not.toContain("idle ·");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test("a static idle read: AgentRow prefers `idleLine` over `message` the moment the fixture carries one, on first mount (no poll-tick needed)", async () => {
    const projectKey = "proj-idle-static-1";
    const agentId = "static-idle-agent";
    const opts: MountOpts = {
      pathname: `/p/${projectKey}`,
      projects: [project({ key: projectKey, name: "Static Idle Project" })],
      agents: [
        agent({
          agentId,
          projectKey,
          message: "12 ✓ 1 ✗ · ingested",
          idleLine: "idle · VERIFY · static-fixture · cycle 3/4 · last run 12 ✓ 1 ✗ · ingested, 3m ago",
        }),
      ],
    };
    await mountApp(opts);

    const pane = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
    const text = agentRowMessageText(pane, agentId);
    expect(text).toBe("idle · VERIFY · static-fixture · cycle 3/4 · last run 12 ✓ 1 ✗ · ingested, 3m ago");
    expect(text).not.toBe("12 ✓ 1 ✗ · ingested");
  });
});
