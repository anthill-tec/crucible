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

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: GateEventFixture[];
  plans: PlanFixture[];
  eventDetails?: Record<string, GateEventFixture>;
  fetchLog?: string[];
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
      body = { ok: true, agents: [] };
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
    });

    expect(tabIsOn("Workflow")).toBe(true);
    expect(tabIsOn("Roadmap")).toBe(false);

    const header = document.querySelector('[data-testid="gate-view-header"]');
    expect(header).not.toBeNull();
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect(textOf(body)).not.toBe("Nothing running \u2192 Roadmap");
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
