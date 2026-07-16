// CR-CRU-011 C2 — §S2 pane display (a live agent's runtime ticks; a
// tombstoned agent's runtime is sealed) + §S1/§S2 DRIFT-4 feed exclusion
// (lifecycle events never render cards / ratio pills on the Runs timeline,
// even though the server's GET /api/v2/events includes them as data).
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/inpane-liveness.test.ts (fetch scripted to
// read live `opts.*` fixtures so a poll-tick refetch observes an in-place
// mutation — the "SSE-simulated" liveness update).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

// The real poll interval is a hard-coded 5000ms (public/app.js:153).
const POLL_INTERVAL_MS = 5000;
const POLL_WAIT_MS = POLL_INTERVAL_MS + 700;
const POLL_TEST_TIMEOUT_MS = 15_000;

interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile" | "lifecycle";
  action?: "registered" | "unregistered";
  tier?: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
}
interface AgentFixture {
  agentId: string;
  projectKey: string;
  status?: "online" | "busy";
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
  message?: string;
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
  events: EventBriefFixture[];
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/inpane-liveness.test.ts. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: opts.agents };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`agent-runtime-pane.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?agentRuntimePane=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForPollTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS));
  await settle();
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
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

// ── §S2 — pane display: live ticks, tombstoned is sealed ────────────────────

describe("CR-CRU-011 C2 §S2 — Project pane agent runtime display", () => {
  test(
    "a LIVE agent sub-row's rendered runtime updates across a poll-tick refetch that reports an increased server-computed runtime_ms",
    async () => {
      const projectKey = "proj-runtime-live-1";
      const agentId = "live-runtime-agent";
      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Live Runtime Project" })],
        agents: [agent({ agentId, projectKey, liveness: "online", runtime_ms: 5_000 })],
        events: [],
      };
      await mountApp(opts);

      const projectPane = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      expect(projectPane).not.toBeNull();
      const rowBefore = findByText(projectPane, '[data-testid="agent-row"]', agentId);
      expect(rowBefore).toBeDefined();

      const runtimeElBefore = rowBefore!.querySelector('[data-testid="agent-runtime"]');
      expect(runtimeElBefore).not.toBeNull();
      const textBefore = (runtimeElBefore!.textContent ?? "").trim();
      // Renders an actual duration, not a placeholder.
      expect(textBefore).toMatch(/\d/);

      // Server-computed runtime_ms increases (the "now - firstSeen, ticking"
      // rule) — mutate the SAME fixture object the mocked fetch reads live.
      opts.agents[0]!.runtime_ms = 45_000;
      await waitForPollTick();

      const projectPaneAfter = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      const rowAfter = findByText(projectPaneAfter, '[data-testid="agent-row"]', agentId);
      expect(rowAfter).toBeDefined();
      const runtimeElAfter = rowAfter!.querySelector('[data-testid="agent-runtime"]');
      expect(runtimeElAfter).not.toBeNull();
      const textAfter = (runtimeElAfter!.textContent ?? "").trim();

      // Ticking — the displayed runtime reflects the newer server value.
      expect(textAfter).not.toBe(textBefore);
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test(
    "a TOMBSTONED agent sub-row's rendered runtime stays IDENTICAL across time — real wall-clock advances but the server-supplied (sealed) runtime_ms does not change",
    async () => {
      const projectKey = "proj-runtime-tomb-1";
      const agentId = "tombstoned-runtime-agent";
      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Tombstoned Runtime Project" })],
        agents: [
          agent({
            agentId,
            projectKey,
            liveness: "tombstoned",
            lastSeen: Date.now() - 400_000,
            runtime_ms: 60_000,
          }),
        ],
        events: [],
      };
      await mountApp(opts);

      const projectPane = document.querySelector('[data-testid="project-pane"]') as HTMLElement;
      const row = findByText(projectPane, '[data-testid="agent-row"]', agentId);
      expect(row).toBeDefined();
      const runtimeEl = row!.querySelector('[data-testid="agent-runtime"]');
      expect(runtimeEl).not.toBeNull();
      const textInitial = (runtimeEl!.textContent ?? "").trim();
      expect(textInitial).toMatch(/\d/);

      // Real wall-clock advances (short wait — would catch a naive
      // client-side setInterval ticker that ignores liveness). The fixture's
      // runtime_ms is UNCHANGED (simulating the server's sealed value).
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await settle();
      const rowAfterShortWait = findByText(
        document.querySelector('[data-testid="project-pane"]') as HTMLElement,
        '[data-testid="agent-row"]',
        agentId,
      );
      const textAfterShortWait = (
        rowAfterShortWait!.querySelector('[data-testid="agent-runtime"]')!.textContent ?? ""
      ).trim();
      expect(textAfterShortWait).toBe(textInitial);

      // A full poll-tick refetch also returns the SAME server runtime_ms —
      // the display must stay sealed even after a real re-fetch.
      await waitForPollTick();
      const rowAfterPoll = findByText(
        document.querySelector('[data-testid="project-pane"]') as HTMLElement,
        '[data-testid="agent-row"]',
        agentId,
      );
      const textAfterPoll = (
        rowAfterPoll!.querySelector('[data-testid="agent-runtime"]')!.textContent ?? ""
      ).trim();
      expect(textAfterPoll).toBe(textInitial);
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── §S1/§S2 DRIFT-4 — lifecycle events never render Runs-timeline cards ────

describe("CR-CRU-011 C2 §S1/§S2 DRIFT-4 — lifecycle events excluded from the Runs feed", () => {
  test(
    "register+unregister lifecycle events interleaved around two real run events render EXACTLY two event-cards (no lifecycle cards, no 0/0 ratio pills anywhere)",
    async () => {
      const projectKey = "proj-drift4-1";
      const agentId = "drift4-agent";
      const lifecycleAgentId = "drift4-lifecycle-agent";
      const now = Date.now();

      const events: EventBriefFixture[] = [
        // Newest first (server order), interleaved: unregister, run2, run1, register.
        {
          id: "evt-unreg-1",
          projectKey,
          agentId: lifecycleAgentId,
          kind: "lifecycle",
          action: "unregistered",
          timestamp: now,
        },
        {
          id: "evt-run-2",
          projectKey,
          agentId,
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now - 1_000,
          total: 2,
          passed: 2,
          failed: 0,
          pending: 0,
          duration_ms: 10,
          hasCoverage: false,
        },
        {
          id: "evt-run-1",
          projectKey,
          agentId,
          kind: "test",
          tier: "unit",
          codec: "junit",
          timestamp: now - 2_000,
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
          duration_ms: 8,
          hasCoverage: false,
        },
        {
          id: "evt-reg-1",
          projectKey,
          agentId: lifecycleAgentId,
          kind: "lifecycle",
          action: "registered",
          timestamp: now - 3_000,
        },
      ];

      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Drift4 Project" })],
        agents: [agent({ agentId, projectKey, liveness: "online" })],
        events,
      };
      await mountApp(opts);

      // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
      // defaults to the Workflow pane, not Runs (workspace default flips) —
      // this test's SUBJECT is the Runs feed's lifecycle-event filtering, so
      // it now selects the Runs tab EXPLICITLY after mount instead of
      // relying on Runs being the cold-load default. Was: no tab click,
      // relied on cold load already showing the Runs pane's event-cards.
      const runsTab = findByText(document, '[data-testid="workspace-tab"]', "Runs");
      expect(runsTab).toBeDefined();
      runsTab!.click();
      await settle();

      const cards = document.querySelectorAll('[data-testid="event-card"]');
      expect(cards.length).toBe(2);

      // No card renders a lifecycle event's agentId.
      const cardTexts = Array.from(cards).map((c) => c.textContent ?? "");
      expect(cardTexts.some((t) => t.includes(lifecycleAgentId))).toBe(false);
      for (const text of cardTexts) {
        expect(text).toContain(agentId);
      }

      // No stray "0/0" ratio pill anywhere on the page (the tell-tale sign
      // of a lifecycle event's empty summary rendering a real card).
      const pills = Array.from(document.querySelectorAll('[data-testid="ratio-pill"]'));
      expect(pills.length).toBe(2);
      expect(pills.some((p) => (p.textContent ?? "").trim() === "0/0")).toBe(false);
    },
  );

  test(
    "a project with ONLY lifecycle events (register+unregister, no real runs) renders zero event-cards and zero ratio pills — an all-lifecycle feed is not mistaken for real runs",
    async () => {
      const projectKey = "proj-drift4-2";
      const now = Date.now();
      const events: EventBriefFixture[] = [
        { id: "evt-unreg-2", projectKey, agentId: "a1", kind: "lifecycle", action: "unregistered", timestamp: now },
        { id: "evt-reg-2", projectKey, agentId: "a1", kind: "lifecycle", action: "registered", timestamp: now - 1_000 },
      ];
      const opts: MountOpts = {
        pathname: `/p/${projectKey}`,
        projects: [project({ key: projectKey, name: "Drift4 Data Project" })],
        agents: [],
        events,
      };
      await mountApp(opts);

      const cards = document.querySelectorAll('[data-testid="event-card"]');
      expect(cards.length).toBe(0);
      const pills = document.querySelectorAll('[data-testid="ratio-pill"]');
      expect(pills.length).toBe(0);
    },
  );
});
