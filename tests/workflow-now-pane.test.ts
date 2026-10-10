// CR-CRU-172 §S2/§S3 — "Now shows what is running, and nothing else" (AC3,
// AC4, AC5). Spec: docs/changes/CR-CRU-172-the-workflow-tab-splits-into-now-
// and-history.md. Storyboard F21 (the gate view) / F22 (Now's three states)
// in .lavish/crucible-v2-design.html are the approved design this file
// drives against; where the spec text and the frame agree (they do here —
// release header, run line, step ladder, decisions, no push line for an
// in-flight run; "Nothing running → Roadmap" with nothing on the board) this
// file asserts the frame's exact wording.
//
// Current-code facts verified against public/app.js on this branch:
//   - `boundaryGate()` EXCLUDES every gate marked `inFlight === true`
//     (CR-CRU-117 §S1) and only ever considers the latest SEALED gate, so
//     with no open plan and ONLY an in-flight gate on the board, it returns
//     null and `WorkflowPrimary` falls back to `WorkflowActive()`'s "no open
//     plan — file one via POST …" filler. Every assertion below expecting a
//     gate view (header / run line / step ladder) for an in-flight gate is
//     therefore genuine RED: no such view exists today.
//   - `WorkflowPrimary` renders EITHER the live plan OR the gate widget,
//     NEVER both (`boundaryGate() !== null ? GateWidget(gate) : WorkflowActive()`),
//     so an open plan always suppresses any gate rendering today — the
//     "plan AND gate, plan first" pin is RED for that reason.
//   - `GateWidget`'s title is the static text "Gate" (no release, no run
//     id/branch/head line) — `gateBodyContent` never reads `event.gate.run`
//     or the event's top-level `version` at all today.
//   - `landingTab()` (and `roadmapTabFollows`'s settle path) treats "a gate
//     is running" as `scopedGateEvents().some(e => e.gate?.inFlight === true)`
//     — ANY in-flight snapshot, forever, even once a later seal of the SAME
//     run has landed. The AC4 "seal retires the run" pin is RED for that
//     reason: today's rule never turns a run "not running" once it has
//     shipped even one interim snapshot.
//   - `gateBodyContent` renders the `gate-push-line` div UNCONDITIONALLY,
//     even when `g.push` is undefined (DRIFT-5: "pushed  → " with nothing
//     pushed) — so an in-flight gate's drill-in renders a push line today;
//     the AC5 "no push line" pin is RED for that reason.
//
// RED-agent-defined decisions (documented, not silently guessed — the spec
// names the CONTENT, not the testids):
//   - Now's gate-view title (the header `Gate · release <X> · no-mistakes`)
//     gets its own testid `gate-view-header`, distinct from the existing
//     `gate-outcome-banner` (the colored pass/fail/in-flight pill `gate-
//     BodyContent` already renders) — F21's mock draws them as two separate
//     lines and only the header carries the release.
//   - The run line (`run <id> · branch <b> · head <h>`) is pinned as part of
//     the SHARED `gateBodyContent` (the same body the §S3 drill-in and Now's
//     gate view both render, per the existing §S4 comment on that function)
//     under testid `gate-run-line` — which is why AC5's drill-in pins below
//     expect to see it too, with no Now-specific wiring.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

const POLL_INTERVAL_MS = 5000;
const POLL_WAIT_MS = POLL_INTERVAL_MS + 700;
const POLL_TEST_TIMEOUT_MS = 15_000;

// ── Fixtures ─────────────────────────────────────────────────────────────

interface CycleFixture {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}
interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
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
interface GateRunFixture {
  id: string;
  branch?: string;
  head?: string;
}
interface GateStepFixture {
  name: string;
  status: string;
}
interface GatePayloadFixture {
  intent: string;
  outcome: "checks-passed" | "passed" | "failed" | "cancelled";
  steps: GateStepFixture[];
  push?: { commit: string; remote: string };
  run?: GateRunFixture;
  inFlight?: boolean;
}
interface GateDecisionFixture {
  id: string;
  agentId: string;
  runId: string;
  step?: string;
  action: "approve" | "fix" | "skip";
  reason?: string;
  timestamp: number;
}
interface GateEventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "gate";
  codec: "no-mistakes";
  timestamp: number;
  context?: { wave?: string };
  version?: string;
  gate: GatePayloadFixture;
  // Only ever present on a single-event DETAIL read, exactly like the real
  // server (tests/gate-decision-trail.test.ts's module comment).
  decisions?: GateDecisionFixture[];
}

// CR-CRU-176 §S1/AC1 — the liveness of the AGENT that posted a gate's newest
// snapshot, exactly the shape `GET /api/v2/agents` answers (src/types.ts
// `LiveAgent`): `liveness` is the server-computed "online" | "stale" |
// "tombstoned" the app already reads for agent cards (`agent.liveness ===
// "online"` in public/app.js `AgentRow`).
interface AgentFixture {
  agentId: string;
  projectKey?: string;
  status?: "online" | "busy";
  liveness: "online" | "stale" | "tombstoned";
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: GateEventFixture[];
  plans: PlanFixture[];
  eventDetails?: Record<string, GateEventFixture>;
  fetchLog?: string[];
  agents?: AgentFixture[];
  // CR-CRU-178 §S1 — force the `--band` token `readPhoneBand()` reads
  // (public/app.js), bypassing CSS media-query evaluation entirely: this
  // harness never loads public/styles.css, so without an override
  // `getComputedStyle(document.documentElement).getPropertyValue("--band")`
  // is always "" (not "phone"), i.e. every existing mount is implicitly
  // desktop band. Setting it as an INLINE style on `document.documentElement`
  // (the `:root` element itself) out-prioritizes any stylesheet rule by CSS
  // cascade, so this is sound whether or not media queries are evaluated.
  band?: "desktop" | "tablet" | "phone";
}

let cacheBust = 0;

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

// The run identity's liveness fixture: `online` (the run is being driven),
// `stale` (the identity went quiet — a dead/killed run) or `tombstoned`
// (long gone). Defaults carry no `role` and no other agent-card concerns —
// only the ONE field §S1's `runningGate` reads.
function agentFixture(agentId: string, liveness: AgentFixture["liveness"]): AgentFixture {
  return { agentId, status: "online", liveness };
}

function gateEvent(
  overrides: Partial<GateEventFixture> & { id: string; projectKey: string; timestamp: number },
): GateEventFixture {
  return {
    agentId: "orchestrator-1",
    kind: "gate",
    codec: "no-mistakes",
    context: { wave: "1" },
    gate: {
      intent: "release no-mistakes gate",
      outcome: "checks-passed",
      steps: [{ name: "intent", status: "passed" }],
      inFlight: true,
    },
    ...overrides,
  };
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';
  if (opts.band !== undefined) {
    document.documentElement.style.setProperty("--band", opts.band);
  }

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventDetailMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isEventsListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventDetailMatch !== null && !isEventsListEndpoint) {
      const id = decodeURIComponent(eventDetailMatch[1]!);
      opts.fetchLog?.push(id);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`workflow-now-pane.test.ts mountApp: no eventDetails fixture for id ${id}`);
      }
      body = { ok: true, event: detail };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: opts.agents ?? [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`workflow-now-pane.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowNowPane=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

async function waitForPollTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS));
  await settle();
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (el) => (el.textContent ?? "").trim() === text,
  );
}

async function openWorkflowTab(): Promise<void> {
  const tab = findByText(document, '[data-testid="workspace-tab"]', "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function tabButton(name: string): HTMLElement | undefined {
  return findByText(document, '[data-testid="workspace-tab"]', name);
}

function tabIsOn(name: string): boolean {
  const tab = tabButton(name);
  return tab !== undefined && tab.classList.contains("on");
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ── §S2/AC3 — the Now gate view's content ───────────────────────────────

describe("§S2/AC3 — the newest gate in flight renders F21's gate view in Now", () => {
  test("the newest gate in flight (no open plan) renders the release header, the run line, the step ladder, and no push line", async () => {
    const key = "now-pane-gate-inflight";
    const now = Date.now();
    const eventId = "evt-now-gate-1";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      version: "0.4.0",
      gate: {
        intent: "release 0.4.0 no-mistakes gate",
        outcome: "checks-passed",
        steps: [
          { name: "intent", status: "passed" },
          { name: "review", status: "running" },
        ],
        run: { id: "run-now-abc123", branch: "release/0.4.0", head: "66cda00c" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Now Pane Gate In Flight" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      // CR-CRU-176 §S1/AC1 re-pin (approved in advance) — a gate is
      // running only while the identity that posted it is online; this
      // fixture's gate is kept "running" by giving its posting identity
      // (brief.agentId) a live heartbeat, unchanged meaning otherwise.
      agents: [agentFixture(brief.agentId, "online")],
    });
    await openWorkflowTab();
    await settle();

    // POSITIVE — the header names the release and the codec.
    const header = document.querySelector('[data-testid="gate-view-header"]');
    expect(header).not.toBeNull();
    expect(textOf(header)).toBe("Gate · release 0.4.0 · no-mistakes");

    // POSITIVE — the run line names the run id, the branch and the head.
    const runLine = document.querySelector('[data-testid="gate-run-line"]');
    expect(runLine).not.toBeNull();
    expect(textOf(runLine)).toContain("run-now-abc123");
    expect(textOf(runLine)).toContain("release/0.4.0");
    expect(textOf(runLine)).toContain("66cda00c");

    // POSITIVE — the live step ladder.
    expect(document.querySelectorAll('[data-testid="gate-step-row"]').length).toBe(2);

    // NEGATIVE/bound — an in-flight gate has pushed nothing: no push line.
    expect(document.querySelector('[data-testid="gate-push-line"]')).toBeNull();

    // bound — something IS running, so Now never reads the empty-state line.
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(textOf(body)).not.toBe("Nothing running \u2192 Roadmap");
  });

  test("a release omitted on the snapshot omits the release segment of the header, exactly as the spec requires", async () => {
    const key = "now-pane-gate-inflight-norelease";
    const now = Date.now();
    const eventId = "evt-now-gate-norelease";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      gate: {
        intent: "no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-now-norelease-1" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Now Pane No Release" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      // CR-CRU-176 §S1/AC1 re-pin (approved in advance) — same reasoning
      // as the sibling test above: the gate stays "running" by giving its
      // posting identity a live heartbeat.
      agents: [agentFixture(brief.agentId, "online")],
    });
    await openWorkflowTab();
    await settle();

    const header = document.querySelector('[data-testid="gate-view-header"]');
    expect(header).not.toBeNull();
    expect(textOf(header)).toBe("Gate · no-mistakes");
    // bound — no stray "release" token when the snapshot names none.
    expect(textOf(header)).not.toContain("release");
  });

  test("an open plan and a newest gate in flight render TOGETHER in Now, the plan's cycles BEFORE the gate view (document order)", async () => {
    const key = "now-pane-both";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 9001,
      cr: "NOW-PLAN-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: 1, label: "C1", status: "active" }],
    };
    const eventId = "evt-now-gate-2";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      version: "0.5.0",
      gate: {
        intent: "release 0.5.0 no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-now-both-1" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Now Pane Both" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [plan],
      // CR-CRU-176 §S1/AC1 re-pin (approved in advance) — the gate half of
      // "plan AND gate together" stays running only with a live identity.
      agents: [agentFixture(brief.agentId, "online")],
    });
    await openWorkflowTab();
    await settle();

    const active = document.querySelector('[data-testid="workflow-active"]');
    expect(active).not.toBeNull();
    expect(textOf(active)).toContain("NOW-PLAN-1");

    const header = document.querySelector('[data-testid="gate-view-header"]');
    expect(header).not.toBeNull();

    // POSITIVE — document order: the plan's cycles come BEFORE the gate view.
    expect(!!(active!.compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
  });

  test("a newer in-flight snapshot of the SAME run re-reads its decisions from the NEW snapshot's id, never the old one's", async () => {
    const key = "now-pane-redecide";
    const now = Date.now();
    const firstId = "evt-now-redecide-1";
    const secondId = "evt-now-redecide-2";
    const firstBrief = gateEvent({
      id: firstId,
      projectKey: key,
      timestamp: now,
      version: "0.6.0",
      gate: {
        intent: "release 0.6.0 no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-redecide-1" },
        inFlight: true,
      },
    });
    const firstDecisions: GateDecisionFixture[] = [
      { id: "gd-first", agentId: "ci-bot", runId: "run-redecide-1", action: "approve", timestamp: now - 1000 },
    ];
    const secondDecisions: GateDecisionFixture[] = [
      ...firstDecisions,
      {
        id: "gd-second",
        agentId: "vidushi",
        runId: "run-redecide-1",
        step: "review",
        action: "fix",
        timestamp: now + 500,
      },
    ];

    const opts: MountOpts = {
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Now Pane Redecide" })],
      events: [firstBrief],
      eventDetails: { [firstId]: { ...firstBrief, decisions: firstDecisions } },
      plans: [],
      fetchLog: [],
      // CR-CRU-176 §S1/AC1 re-pin (approved in advance) — both snapshots
      // below are posted by the SAME run, so one live identity covers
      // both; the test keeps asserting the redecide behaviour, unchanged.
      agents: [agentFixture(firstBrief.agentId, "online")],
    };
    await mountApp(opts);
    await openWorkflowTab();
    await settle();

    // MOCK verification — the FIRST snapshot's id was fetched for decisions.
    expect(opts.fetchLog).toContain(firstId);
    expect(document.querySelectorAll('[data-testid="gate-decision-row"]').length).toBe(1);

    // A later snapshot of the SAME run arrives.
    const secondBrief = gateEvent({
      id: secondId,
      projectKey: key,
      timestamp: now + 5000,
      version: "0.6.0",
      gate: {
        intent: "release 0.6.0 no-mistakes gate",
        outcome: "checks-passed",
        steps: [
          { name: "intent", status: "passed" },
          { name: "review", status: "running" },
        ],
        run: { id: "run-redecide-1" },
        inFlight: true,
      },
    });
    opts.events.push(secondBrief);
    opts.eventDetails![secondId] = { ...secondBrief, decisions: secondDecisions };
    await waitForPollTick();

    // MOCK verification — the NEW snapshot id was fetched; decisions are
    // re-read, never held over from the OLD snapshot's id.
    expect(opts.fetchLog).toContain(secondId);
    expect(document.querySelectorAll('[data-testid="gate-decision-row"]').length).toBe(2);
  }, POLL_TEST_TIMEOUT_MS);

  test("with nothing running, clicking the → Roadmap link in 'Nothing running → Roadmap' selects the Roadmap tab", async () => {
    const key = "now-pane-roadmap-link";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Now Pane Roadmap Link" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    // Read on Now's own container (orchestrator-approved 2026-10-08) -- the
    // whole workspace-body also holds History and the Project pane.
    const nowPane = document.querySelector('[data-testid="workflow-now"]');
    expect(textOf(nowPane)).toBe("Nothing running \u2192 Roadmap");
    expect(tabIsOn("Workflow")).toBe(true);

    const link = findByText(document, 'a, button, span, [role="button"]', "\u2192 Roadmap");
    expect(link).toBeDefined();
    link!.click();
    await settle();

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
  });
});

// ── §S2/AC4 — "running" is the newest gate, never "any gate ever" ────────

describe("§S2/AC4 — \"running\" is the project's NEWEST gate event, never \"any in-flight gate ever\"", () => {
  function runSnapshots(key: string, runId: string, now: number, withSeal: boolean): GateEventFixture[] {
    const snaps: GateEventFixture[] = [];
    for (let i = 0; i < 4; i++) {
      snaps.push(
        gateEvent({
          id: `evt-ac4-interim-${i}`,
          projectKey: key,
          timestamp: now + i * 1000,
          version: "0.7.0",
          gate: {
            intent: "release 0.7.0 no-mistakes gate",
            outcome: "checks-passed",
            steps: [{ name: "intent", status: "passed" }],
            run: { id: runId },
            inFlight: true,
          },
        }),
      );
    }
    if (withSeal) {
      snaps.push(
        gateEvent({
          id: "evt-ac4-seal",
          projectKey: key,
          timestamp: now + 10_000,
          version: "0.7.0",
          gate: {
            intent: "release 0.7.0 no-mistakes gate",
            outcome: "passed",
            steps: [{ name: "intent", status: "passed" }],
            run: { id: runId },
            push: { commit: "ac4seal1", remote: "origin/main" },
          },
        }),
      );
    }
    return snaps;
  }

  test("four in-flight snapshots of a run FOLLOWED BY a seal of the SAME run: not running — Now reads exactly 'Nothing running → Roadmap' and the project lands on the Roadmap tab", async () => {
    const key = "now-pane-ac4-sealed";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "AC4 Sealed Run" })],
      events: runSnapshots(key, "run-ac4-sealed-1", now, true),
      plans: [],
    });

    // Landing — nothing is running on arrival, so the project lands on
    // Roadmap, not Workflow, even though FOUR in-flight snapshots exist.
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);

    await openWorkflowTab();
    // Read on Now's own container (orchestrator-approved 2026-10-08) -- the
    // whole workspace-body also holds History and the Project pane.
    const nowPane = document.querySelector('[data-testid="workflow-now"]');
    expect(textOf(nowPane)).toBe("Nothing running \u2192 Roadmap");
    expect(document.querySelector('[data-testid="gate-pane"]')).toBeNull();
  });

  test("the SAME four in-flight snapshots WITHOUT the seal (newest is still in flight): running — Now shows the gate view and the project lands on the Workflow tab", async () => {
    const key = "now-pane-ac4-unsealed";
    const now = Date.now();
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "AC4 Unsealed Run" })],
      events: runSnapshots(key, "run-ac4-unsealed-1", now, false),
      plans: [],
      // CR-CRU-176 §S1/AC1 re-pin (approved in advance) — `runSnapshots`'s
      // events all carry the default `gateEvent()` agentId ("orchestrator-1");
      // the newest (unsealed) one stays running with that identity online.
      agents: [agentFixture("orchestrator-1", "online")],
    });

    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);

    const header = document.querySelector('[data-testid="gate-view-header"]');
    expect(header).not.toBeNull();
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(textOf(body)).not.toBe("Nothing running \u2192 Roadmap");
  });
});

// ── §S1/AC1 (CR-CRU-176) — a gate is running only while its run is driven or
//    held for a decision: the newest in-flight gate alone is no longer
//    enough. "Running" now needs EITHER the posting identity online (the run
//    is being driven) OR a ladder step `awaiting_approval` (held for a
//    decision) — otherwise the run has died mid-step and Now drops it.
//
// RED today: `runningGate()` (public/app.js) returns the newest in-flight
// gate unconditionally — it reads neither `state.agents` nor any step's
// `status` — so every "stale identity, no held step" scenario below still
// shows the gate view and lands on Workflow, and the held-banner text this
// CR adds ("awaiting your decision") exists nowhere in `gateBodyContent`.
describe("§S1/AC1 — a gate is running only while its run is driven or held for a decision", () => {
  function heldGateEvent(key: string, id: string, timestamp: number, agentId: string): GateEventFixture {
    return gateEvent({
      id,
      projectKey: key,
      agentId,
      timestamp,
      gate: {
        intent: "release no-mistakes gate",
        outcome: "checks-passed",
        steps: [
          { name: "intent", status: "passed" },
          { name: "review", status: "awaiting_approval" },
        ],
        run: { id: "run-ac1-held-1" },
        inFlight: true,
      },
    });
  }

  test("a gate's run identity decides whether it is running: ONLINE → the gate view in Now and the Workflow tab; the otherwise-identical run with its identity STALE and no held step → NOT running, 'Nothing running → Roadmap', the Roadmap tab", async () => {
    const key = "now-pane-ac1-online";
    const now = Date.now();
    const eventId = "evt-ac1-online-1";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      agentId: "ac1-caller-1\u00b7gate",
      timestamp: now,
      gate: {
        intent: "release no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-ac1-online-1" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "AC1 Online Identity" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      agents: [agentFixture("ac1-caller-1\u00b7gate", "online")],
    });

    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);
    expect(document.querySelector('[data-testid="gate-pane"]')).not.toBeNull();
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(textOf(body)).not.toBe("Nothing running \u2192 Roadmap");

    // THE PIN — an otherwise-identical run (same shape, different id) whose
    // identity is STALE and whose ladder holds no `awaiting_approval` step is
    // NOT running: this half alone fails against today's production, which
    // reads only `gate.inFlight`, never `state.agents`.
    const staleKey = "now-pane-ac1-stale-no-hold";
    const staleEventId = "evt-ac1-stale-1";
    const staleBrief = gateEvent({
      id: staleEventId,
      projectKey: staleKey,
      agentId: "ac1-caller-2\u00b7gate",
      timestamp: now,
      gate: {
        intent: "release no-mistakes gate",
        outcome: "checks-passed",
        steps: [
          { name: "intent", status: "passed" },
          { name: "review", status: "running" },
        ],
        run: { id: "run-ac1-stale-1" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${staleKey}`,
      projects: [project({ key: staleKey, name: "AC1 Stale No Hold" })],
      events: [staleBrief],
      eventDetails: { [staleEventId]: { ...staleBrief, decisions: [] } },
      plans: [],
      agents: [agentFixture("ac1-caller-2\u00b7gate", "stale")],
    });

    // Landing — nothing is running on arrival.
    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);

    await openWorkflowTab();
    const nowPane = document.querySelector('[data-testid="workflow-now"]');
    expect(textOf(nowPane)).toBe("Nothing running \u2192 Roadmap");
    expect(document.querySelector('[data-testid="gate-pane"]')).toBeNull();
  });

  test("the newest gate in flight with its posting identity ABSENT (never seen) and no held step is NOT running, same as a stale one", async () => {
    const key = "now-pane-ac1-absent-no-hold";
    const now = Date.now();
    const eventId = "evt-ac1-absent-1";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      agentId: "ac1-caller-3\u00b7gate",
      timestamp: now,
      gate: {
        intent: "release no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-ac1-absent-1" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "AC1 Absent No Hold" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      // No `agents` fixture at all — the identity was NEVER seen (a crash
      // before its first heartbeat), distinct from the stale case above.
    });

    expect(tabIsOn("Roadmap")).toBe(true);
    expect(tabIsOn("Workflow")).toBe(false);
    await openWorkflowTab();
    expect(textOf(document.querySelector('[data-testid="workflow-now"]'))).toBe(
      "Nothing running \u2192 Roadmap",
    );
  });

  test("a held run (ladder step awaiting_approval) with its posting identity STALE is still running: Now shows the gate view, naming the held step as 'awaiting your decision'", async () => {
    const key = "now-pane-ac1-held";
    const now = Date.now();
    const eventId = "evt-ac1-held-1";
    const brief = heldGateEvent(key, eventId, now, "ac1-caller-4\u00b7gate");

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "AC1 Held For Decision" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      agents: [agentFixture("ac1-caller-4\u00b7gate", "stale")],
    });

    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);

    const banner = document.querySelector('[data-testid="gate-outcome-banner"]');
    expect(banner).not.toBeNull();
    // POSITIVE — the spec's exact phrase, naming the step actually held
    // ("review"), never a different step on the same ladder ("intent").
    expect(textOf(banner)).toContain("awaiting your decision");
    expect(textOf(banner)).toContain("review");
    const bannerWords = textOf(banner).toLowerCase();
    const reviewIdx = bannerWords.indexOf("review");
    const intentIdx = bannerWords.lastIndexOf("intent");
    // bound — "review" names the HELD step specifically; the completed
    // "intent" step is not what the decision-awaiting text points at.
    expect(reviewIdx).toBeGreaterThan(-1);
    if (intentIdx !== -1) expect(reviewIdx).not.toBe(intentIdx);
  });

  test("a held run with its posting identity ABSENT is still running, same as the stale case", async () => {
    const key = "now-pane-ac1-held-absent";
    const now = Date.now();
    const eventId = "evt-ac1-held-absent-1";
    const brief = heldGateEvent(key, eventId, now, "ac1-caller-5\u00b7gate");

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "AC1 Held Absent Identity" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      // No `agents` fixture — the identity was never seen, same as a dead run.
    });

    expect(tabIsOn("Workflow")).toBe(true);
    expect(document.querySelector('[data-testid="gate-pane"]')).not.toBeNull();
    const banner = document.querySelector('[data-testid="gate-outcome-banner"]');
    expect(textOf(banner)).toContain("awaiting your decision");
  });

  test("an open plan AND a live gate (posting identity online) render TOGETHER in Now, the plan BEFORE the gate view — plan + live gate is unchanged by this cycle", async () => {
    const key = "now-pane-ac1-plan-and-live-gate";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 9101,
      cr: "AC1-PLAN-1",
      projectKey: key,
      status: "open",
      cycles: [{ id: 1, label: "C1", status: "active" }],
    };
    const eventId = "evt-ac1-plan-gate-1";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      agentId: "ac1-caller-6\u00b7gate",
      timestamp: now,
      gate: {
        intent: "release no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-ac1-plan-gate-1" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "AC1 Plan And Live Gate" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [plan],
      agents: [agentFixture("ac1-caller-6\u00b7gate", "online")],
    });
    await openWorkflowTab();
    await settle();

    const active = document.querySelector('[data-testid="workflow-active"]');
    expect(active).not.toBeNull();
    expect(textOf(active)).toContain("AC1-PLAN-1");
    const header = document.querySelector('[data-testid="gate-view-header"]');
    expect(header).not.toBeNull();
    expect(!!(active!.compareDocumentPosition(header!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
  });
});

// ── §S3/AC5 — the drill-in's shared gateBodyContent: run line always, push
//    line only for a SEALED gate ──────────────────────────────────────────

describe("§S3/AC5 — the run drill-in (shared gateBodyContent) carries the run line, and the push line ONLY for a sealed gate", () => {
  test("a sealed gate's drill-in renders the run line AND the push line", async () => {
    const key = "now-pane-drillin-sealed";
    const eventId = "evt-drillin-sealed-1";
    const now = Date.now();
    const fixture = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      version: "0.8.0",
      gate: {
        intent: "release 0.8.0 no-mistakes gate",
        outcome: "passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-drillin-sealed-1", branch: "release/0.8.0", head: "deadbeef" },
        push: { commit: "feed1234", remote: "origin/main" },
      },
    });

    await mountApp({
      pathname: `/p/${key}/run/${eventId}`,
      projects: [project({ key, name: "AC5 Drillin Sealed" })],
      events: [fixture],
      eventDetails: { [eventId]: { ...fixture, decisions: [] } },
      plans: [],
    });

    const runLine = document.querySelector('[data-testid="gate-run-line"]');
    expect(runLine).not.toBeNull();
    expect(textOf(runLine)).toContain("run-drillin-sealed-1");
    expect(textOf(runLine)).toContain("release/0.8.0");
    expect(textOf(runLine)).toContain("deadbeef");

    const pushLine = document.querySelector('[data-testid="gate-push-line"]');
    expect(pushLine).not.toBeNull();
    expect(textOf(pushLine)).toContain("feed123");
  });

  test("an in-flight gate's drill-in renders the run line and NO push line", async () => {
    const key = "now-pane-drillin-inflight";
    const eventId = "evt-drillin-inflight-1";
    const now = Date.now();
    const fixture = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      version: "0.8.0",
      gate: {
        intent: "release 0.8.0 no-mistakes gate",
        outcome: "checks-passed",
        steps: [
          { name: "intent", status: "passed" },
          { name: "review", status: "running" },
        ],
        run: { id: "run-drillin-inflight-1", branch: "release/0.8.0", head: "cafef00d" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}/run/${eventId}`,
      projects: [project({ key, name: "AC5 Drillin Inflight" })],
      events: [fixture],
      eventDetails: { [eventId]: { ...fixture, decisions: [] } },
      plans: [],
    });

    const runLine = document.querySelector('[data-testid="gate-run-line"]');
    expect(runLine).not.toBeNull();
    expect(textOf(runLine)).toContain("run-drillin-inflight-1");
    expect(textOf(runLine)).toContain("release/0.8.0");
    expect(textOf(runLine)).toContain("cafef00d");

    // NEGATIVE — an in-flight gate has pushed nothing: no push line at all.
    expect(document.querySelector('[data-testid="gate-push-line"]')).toBeNull();
  });
});

// ── §S1/F21 — the run line sits INSIDE the outcome banner's own box, in
//    BOTH places gateBodyContent renders (Now's gate view and the run
//    drill-in share the one function) ───────────────────────────────────

describe("F21 — the run line renders INSIDE the outcome banner's box, not as a sibling line beneath it", () => {
  test("Now's gate view AND the run drill-in both nest gate-run-line inside gate-outcome-banner, exactly once each", async () => {
    const key = "now-pane-run-line-in-banner";
    const now = Date.now();
    const eventId = "evt-now-run-line-in-banner-1";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      version: "0.9.0",
      gate: {
        intent: "release 0.9.0 no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-banner-nest-1", branch: "release/0.9.0", head: "deadbee0" },
        inFlight: true,
      },
    });

    // ── Now's gate view (F21 badge: "also Now's view of a running release
    // workflow") ────────────────────────────────────────────────────────
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Now Pane Run Line In Banner" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      // CR-CRU-176 §S1/AC1 re-pin (approved in advance) — Now's gate view
      // (this half only — the drill-in below reads one event directly and
      // is unaffected) stays running with its posting identity online.
      agents: [agentFixture(brief.agentId, "online")],
    });
    await openWorkflowTab();
    await settle();

    const nowPane = document.querySelector('[data-testid="gate-pane"]');
    expect(nowPane).not.toBeNull();
    const nowBanner = nowPane!.querySelector('[data-testid="gate-outcome-banner"]');
    expect(nowBanner).not.toBeNull();

    // bound — exactly one run line renders at all (never a stray duplicate
    // once GREEN moves it inside the banner).
    const nowRunLines = nowPane!.querySelectorAll('[data-testid="gate-run-line"]');
    expect(nowRunLines.length).toBe(1);
    // THE PIN — the run line is a DESCENDANT of the banner box, not its
    // sibling (today's layout: gateBodyContent returns the banner and the
    // run line as two array entries at the SAME level, so the banner never
    // contains it).
    expect(nowBanner!.contains(nowRunLines[0]!)).toBe(true);
    expect(textOf(nowRunLines[0]!)).toContain("run-banner-nest-1");

    // ── the run drill-in (F8½) — the SAME gateBodyContent function ──────
    await mountApp({
      pathname: `/p/${key}/run/${eventId}`,
      projects: [project({ key, name: "Now Pane Run Line In Banner" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
    });
    await settle();

    const drillBanner = document.querySelector('[data-testid="gate-outcome-banner"]');
    expect(drillBanner).not.toBeNull();
    const drillRunLines = document.querySelectorAll('[data-testid="gate-run-line"]');
    expect(drillRunLines.length).toBe(1);
    expect(drillBanner!.contains(drillRunLines[0]!)).toBe(true);
    expect(textOf(drillRunLines[0]!)).toContain("run-banner-nest-1");
  });
});

// ── §S1/AC2 — each pane carries its own title, OUTSIDE its scrolling box,
// on the desktop band (storyboard F22: "Now … its own scroll" / "History …
// its own scroll", each drawn with its own `m-h` heading ABOVE the box) ────
//
// RED-agent-defined decision (the spec names the CONTENT — "Now" and
// "History", nothing else — not the testid): the title carries its own
// testid, `workflow-now-title` / `workflow-history-title`, distinct from the
// existing `workflow-now` / `workflow-history` box testids, because the AC
// requires the title to sit OUTSIDE the box it names — reusing the box's own
// testid for both could never express that distinction.
//
// Current-code fact verified against public/app.js on this branch: neither
// testid is rendered anywhere — `WorkflowFeed` mounts `WorkflowNow()` and
// `WorkflowHistory()` directly with no heading between them (the module
// comment at `WorkflowHistory` reads "no standalone 'History' title row").
// Every assertion below is therefore genuine RED: no such element exists
// today, under any testid.
describe("§S1/AC2 — Now's and History's titles render outside their own scrolling boxes (desktop band)", () => {
  test("a title reading exactly 'Now' sits above and outside Now's box; a title reading exactly 'History' sits above and outside History's box; Now's own box text is unchanged", async () => {
    const key = "now-pane-titles-desktop";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Pane Titles Desktop" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    const nowBox = document.querySelector('[data-testid="workflow-now"]');
    const historyBox = document.querySelector('[data-testid="workflow-history"]');
    expect(nowBox).not.toBeNull();
    expect(historyBox).not.toBeNull();
    // AC3's own pin, unmoved by this cycle's title addition.
    expect(textOf(nowBox)).toBe("Nothing running \u2192 Roadmap");

    const nowTitle = findByText(document, '[data-testid="workflow-now-title"]', "Now");
    const historyTitle = findByText(document, '[data-testid="workflow-history-title"]', "History");
    expect(nowTitle, "no element reading exactly 'Now' renders under workflow-now-title").toBeDefined();
    expect(
      historyTitle,
      "no element reading exactly 'History' renders under workflow-history-title",
    ).toBeDefined();

    // OUTSIDE — a title nested INSIDE its own box would not be above it.
    expect(nowBox!.contains(nowTitle!)).toBe(false);
    expect(historyBox!.contains(historyTitle!)).toBe(false);

    // ABOVE — the title precedes its own box in document order.
    expect(
      Boolean(nowTitle!.compareDocumentPosition(nowBox!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(
        historyTitle!.compareDocumentPosition(historyBox!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  test("each title renders exactly once, never duplicated across a poll re-render", async () => {
    const key = "now-pane-titles-no-duplicate";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Pane Titles No Duplicate" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    expect(document.querySelectorAll('[data-testid="workflow-now-title"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-history-title"]').length).toBe(1);

    await waitForPollTick();

    expect(document.querySelectorAll('[data-testid="workflow-now-title"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-history-title"]').length).toBe(1);
  }, POLL_TEST_TIMEOUT_MS);
});

// ── CR-CRU-178 \u00a7S1 \u2014 "Now and History read as two panes" (F24, option B,
// APPROVED 2026-10-09). Spec:
// docs/changes/CR-CRU-178-now-and-history-read-as-two-panes.md. Storyboard
// F24 (.lavish/crucible-v2-design.html), option B, is the approved design
// this file drives against; where it disagrees with the spec prose the frame
// wins. Its literal markup is the source of the subtitle wording pinned
// below \u2014 the description span's OWN text node is "\u00b7 what is running" /
// "\u00b7 only what is past" (the frame embeds the middot INSIDE the text, not
// as a CSS pseudo-element), and of the composition: one card
// (`background:var(--bg-1)`) holding Now's raised band (`background:var(--bg-2)`,
// header bar then content), a hatched divider, then History's header bar
// then content.
//
// Current-code facts verified against public/app.js on this branch: NEITHER
// a header bar, NOR a divider, NOR a live dot, NOR a split card exists
// anywhere today \u2014 `WorkflowFeed` mounts `WorkflowPaneTitle("Now")` /
// `WorkflowPaneTitle("History")` (the small CR-CRU-172 \u00a7S1 titles) directly
// against `WorkflowNow()` / `WorkflowHistory()`, with nothing between them
// and no wrapping card. Every assertion below is therefore genuine RED.
//
// RED-agent-defined testids (the spec names the CONTENT and the frame names
// the COMPOSITION, neither names a testid beyond the two the gap analysis
// keeps \u2014 `workflow-now-title` / `workflow-history-title`, spec-given, and
// their siblings `workflow-now-subtitle` / `workflow-history-subtitle`, also
// spec-given):
//   - `workflow-panes-card` \u2014 the ONE card holding both panes (AC1 "one
//     card"), needed so the header bars, the divider and both boxes can be
//     asserted as nesting inside a SINGLE shared container rather than two.
//   - `workflow-now-band` \u2014 Now's raised-background band, wrapping its
//     header bar AND its content box (F24\u00b7B: the raised background spans
//     both, not the header alone) \u2014 needed because `background-color` is
//     not an inherited CSS property: only the element that actually carries
//     `background:var(--bg-2)` reads back that color from `getComputedStyle`,
//     so AC1's "Now's band has a different background" needs its own testid
//     to query (asserted by computed style in the e2e layer; this file only
//     pins that the band exists and nests the header bar + box it names).
//   - `workflow-now-header` / `workflow-history-header` \u2014 the header BAR
//     container (dot/glyph + name + subtitle), distinct from the name
//     element alone, needed because AC1 requires "a header bar on each" as
//     an independently assertable unit (present on desktop, absent on the
//     phone band) \u2014 the existing title/subtitle testids alone cannot
//     express "is there a BAR wrapping them".
//   - `workflow-now-dot` \u2014 the live dot inside Now's header bar, exposing
//     its lit/dim state as `data-live="true"|"false"` \u2014 a plain behavioural
//     attribute, decoupled from the exact CSS (color, glow) the e2e layer
//     measures separately by computed style.
//   - `workflow-panes-divider` \u2014 the hatched divider between Now and
//     History, needed because the spec gives it no testid and AC1 requires
//     it independently assertable (present on desktop, absent on the phone
//     band).
describe("CR-CRU-178 \u00a7S1/AC1 \u2014 a header bar (name + subtitle) renders above each pane, inside the one split card, on the desktop band \u2014 and gates off entirely on the phone band", () => {
  test("Now's header bar names 'Now' with its 'what is running' line and sits inside Now's raised band; History's header bar names 'History' with its 'only what is past' line; both sit outside their own box and inside the one split card (desktop); on the phone band neither header bar renders \u2014 the sub-tab rows are the titles", async () => {
    const key = "two-panes-headers-desktop";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Two Panes Headers Desktop" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    const card = document.querySelector('[data-testid="workflow-panes-card"]');
    expect(card, "no workflow-panes-card renders").not.toBeNull();

    const nowBand = document.querySelector('[data-testid="workflow-now-band"]');
    expect(nowBand, "no workflow-now-band renders").not.toBeNull();

    const nowHeader = document.querySelector('[data-testid="workflow-now-header"]');
    const historyHeader = document.querySelector('[data-testid="workflow-history-header"]');
    expect(nowHeader, "no workflow-now-header renders").not.toBeNull();
    expect(historyHeader, "no workflow-history-header renders").not.toBeNull();

    const nowBox = document.querySelector('[data-testid="workflow-now"]');
    const historyBox = document.querySelector('[data-testid="workflow-history"]');
    expect(nowBox).not.toBeNull();
    expect(historyBox).not.toBeNull();

    // OUTSIDE \u2014 a header bar nested INSIDE its own box would not be above it.
    expect(nowBox!.contains(nowHeader!)).toBe(false);
    expect(historyBox!.contains(historyHeader!)).toBe(false);

    // ABOVE \u2014 the header bar precedes its own box in document order.
    expect(
      Boolean(nowHeader!.compareDocumentPosition(nowBox!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(
        historyHeader!.compareDocumentPosition(historyBox!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // Now's band wraps its OWN header bar and its OWN box (F24\u00b7B: the raised
    // background spans both, not the header alone).
    expect(nowBand!.contains(nowHeader!)).toBe(true);
    expect(nowBand!.contains(nowBox!)).toBe(true);

    // INSIDE the one card \u2014 both panes and their bars nest under the SAME
    // split card, not two separate containers.
    expect(card!.contains(nowBand!)).toBe(true);
    expect(card!.contains(historyHeader!)).toBe(true);
    expect(card!.contains(historyBox!)).toBe(true);

    // The name elements keep their EXISTING testid and exact text (gap
    // analysis: "none of them needs a re-pin").
    const nowTitle = findByText(nowHeader!, '[data-testid="workflow-now-title"]', "Now");
    const historyTitle = findByText(
      historyHeader!,
      '[data-testid="workflow-history-title"]',
      "History",
    );
    expect(nowTitle, "no 'Now' title renders inside workflow-now-header").toBeDefined();
    expect(
      historyTitle,
      "no 'History' title renders inside workflow-history-header",
    ).toBeDefined();

    // The subtitle \u2014 a SIBLING of the title (settled ruling), F24\u00b7B's literal
    // wording (frame wins).
    const nowSubtitle = nowHeader!.querySelector('[data-testid="workflow-now-subtitle"]');
    const historySubtitle = historyHeader!.querySelector(
      '[data-testid="workflow-history-subtitle"]',
    );
    expect(nowSubtitle, "no workflow-now-subtitle renders").not.toBeNull();
    expect(historySubtitle, "no workflow-history-subtitle renders").not.toBeNull();
    expect(textOf(nowSubtitle)).toBe("\u00b7 what is running");
    expect(textOf(historySubtitle)).toBe("\u00b7 only what is past");
    // Siblings, not nested one inside the other.
    expect(nowTitle!.contains(nowSubtitle!)).toBe(false);
    expect(nowSubtitle!.contains(nowTitle!)).toBe(false);

    // AC1's own pin, unmoved by this cycle's header-bar wrapping.
    expect(textOf(nowBox)).toBe("Nothing running \u2192 Roadmap");

    // \u2500\u2500 the phone band (settled ruling): no header bar renders at all \u2500\u2500
    const phoneKey = "two-panes-headers-phone";
    await mountApp({
      pathname: `/p/${phoneKey}`,
      projects: [project({ key: phoneKey, name: "Two Panes Headers Phone" })],
      events: [],
      plans: [],
      band: "phone",
    });
    await openWorkflowTab();

    // The sub-tabs render instead (F15d, unchanged by this cycle) \u2014 the
    // sub-tab ROWS are the titles there, per the settled ruling.
    expect(document.querySelectorAll('[data-testid="workflow-subtab"]').length).toBe(2);

    expect(document.querySelector('[data-testid="workflow-panes-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="workflow-now-band"]')).toBeNull();
    expect(document.querySelector('[data-testid="workflow-now-header"]')).toBeNull();
    expect(document.querySelector('[data-testid="workflow-history-header"]')).toBeNull();
  });

  test("each header bar and Now's band render exactly once, never duplicated across a poll re-render", async () => {
    const key = "two-panes-headers-no-duplicate";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Two Panes Headers No Duplicate" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    expect(document.querySelectorAll('[data-testid="workflow-panes-card"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-now-band"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-now-header"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-history-header"]').length).toBe(1);

    await waitForPollTick();

    expect(document.querySelectorAll('[data-testid="workflow-panes-card"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-now-band"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-now-header"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="workflow-history-header"]').length).toBe(1);
  }, POLL_TEST_TIMEOUT_MS);
});

// \u2500\u2500 \u00a7S1/"Settled at gap analysis" \u2014 the live dot is lit ONLY while Now holds
// an open plan or a running gate, dim when Now reads "Nothing running \u2192
// Roadmap" \u2500\u2500
describe("CR-CRU-178 \u00a7S1/AC1 \u2014 the live dot in Now's header bar is lit only while something runs", () => {
  test('an open plan with no running gate: the dot is lit (data-live="true")', async () => {
    const key = "two-panes-dot-open-plan";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Dot Open Plan" })],
      events: [],
      plans: [
        {
          planId: 1,
          cr: "CR-DOT-OPEN-1",
          projectKey: key,
          status: "open",
          wave: "1",
          cycles: [{ id: 1, label: "cycle 1", status: "active" }],
        },
      ],
    });
    await openWorkflowTab();

    // bound \u2014 the open-plan branch really is what's rendering.
    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();

    const dot = document.querySelector('[data-testid="workflow-now-dot"]');
    expect(dot, "no workflow-now-dot renders").not.toBeNull();
    expect(dot!.getAttribute("data-live")).toBe("true");
  });

  test('a running gate with no open plan: the dot is lit (data-live="true")', async () => {
    const key = "two-panes-dot-running-gate";
    const now = Date.now();
    const eventId = "evt-two-panes-dot-gate-1";
    const brief = gateEvent({
      id: eventId,
      projectKey: key,
      agentId: "two-panes-dot-caller-1\u00b7gate",
      timestamp: now,
      gate: {
        intent: "release no-mistakes gate",
        outcome: "checks-passed",
        steps: [{ name: "intent", status: "passed" }],
        run: { id: "run-two-panes-dot-1" },
        inFlight: true,
      },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Dot Running Gate" })],
      events: [brief],
      eventDetails: { [eventId]: { ...brief, decisions: [] } },
      plans: [],
      agents: [agentFixture("two-panes-dot-caller-1\u00b7gate", "online")],
    });

    // bound \u2014 the running-gate branch really is what's rendering.
    expect(document.querySelector('[data-testid="gate-pane"]')).not.toBeNull();

    const dot = document.querySelector('[data-testid="workflow-now-dot"]');
    expect(dot, "no workflow-now-dot renders").not.toBeNull();
    expect(dot!.getAttribute("data-live")).toBe("true");
  });

  test('nothing running (Now reads exactly "Nothing running \u2192 Roadmap"): the dot is dim (data-live="false")', async () => {
    const key = "two-panes-dot-nothing-running";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Dot Nothing Running" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    // bound \u2014 nothing else is rendering in Now.
    expect(textOf(document.querySelector('[data-testid="workflow-now"]'))).toBe(
      "Nothing running \u2192 Roadmap",
    );

    const dot = document.querySelector('[data-testid="workflow-now-dot"]');
    expect(dot, "no workflow-now-dot renders").not.toBeNull();
    expect(dot!.getAttribute("data-live")).toBe("false");
  });
});

describe("CR-CRU-178 \u00a7S1/AC1 \u2014 the hatched divider sits between Now and History on the desktop band, and gates off entirely on the phone band", () => {
  test("desktop band: the divider sits between Now's box and History's header bar, inside the one split card; on the phone band no divider renders", async () => {
    const key = "two-panes-divider-desktop";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Divider Desktop" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    const divider = document.querySelector('[data-testid="workflow-panes-divider"]');
    expect(divider, "no workflow-panes-divider renders on the desktop band").not.toBeNull();

    const card = document.querySelector('[data-testid="workflow-panes-card"]');
    expect(card!.contains(divider!)).toBe(true);

    const nowBox = document.querySelector('[data-testid="workflow-now"]');
    const historyHeader = document.querySelector('[data-testid="workflow-history-header"]');
    // BETWEEN \u2014 the divider follows Now's box and precedes History's header
    // bar in document order (F24\u00b7B: "Now \u2026 a hatched divider \u2026 History").
    expect(
      Boolean(nowBox!.compareDocumentPosition(divider!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(
        divider!.compareDocumentPosition(historyHeader!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // \u2500\u2500 the phone band (settled ruling): no divider renders at all \u2500\u2500
    const phoneKey = "two-panes-divider-phone";
    await mountApp({
      pathname: `/p/${phoneKey}`,
      projects: [project({ key: phoneKey, name: "Divider Phone" })],
      events: [],
      plans: [],
      band: "phone",
    });
    await openWorkflowTab();

    expect(document.querySelectorAll('[data-testid="workflow-subtab"]').length).toBe(2);
    expect(document.querySelector('[data-testid="workflow-panes-divider"]')).toBeNull();
  });
});
