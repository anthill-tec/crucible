// CR-CRU-013 C3 — §S4 Workflow-tab CONTEXTUAL gate widget + §S6 wave `gated`
// state. RED tests only (no production code touched).
//
// Spec: docs/changes/CR-CRU-013-gate-events.md §S4 (+ the §S4/§S6
// Implementation Notes paragraph) and §S6. C1 (server: gate/milestone
// event-kind family) and C2 (timeline gate-card/drill-in/scoping) are LIVE on
// this branch (commits e79e43b/c1b57e6) — this file drives ONLY the
// Workflow-tab widget + the History lens's wave-boundary state, reusing the
// exact §S1 gate payload shape already round-tripped by
// tests/gate-milestone-server.test.ts and tests/gate-timeline.test.ts:
// `event.gate = {intent, outcome, steps:[{name,status,findings?,fixRounds?}],
// fixes?, push?, pr?}`, `outcome ∈ checks-passed|passed|failed|cancelled`.
//
// Current-code facts verified against public/app.js on this branch (2026-07-18):
//   - `WorkflowFeed()` (~app.js:2268) renders `.app-workflow-cols` containing
//     `() => WorkflowActive()` followed by `GatePane()` — GatePane is an
//     UNCONDITIONALLY mounted second column
//     (`data-testid="gate-pane"` static text "gate reporting lands in
//     CR-013", app.js ~L2042-2047) — it never varies with plan/event state.
//     Every test below that asserts on `gate-pane` presence/content is
//     expected to FAIL against this static placeholder.
//   - `WorkflowActive()` (~app.js:1999) renders the literal text
//     "no open plan — file one via POST /api/v2/projects/<key>/plans" when
//     `scopedPlans().filter(p => p.status === "open").length === 0` —
//     unconditionally, regardless of any gate event. §S4's "mutually
//     exclusive, never coexist" contract requires this filler text to
//     disappear once a boundary gate widget is live; current production has
//     no such branch, so the assertion pinning its absence is genuine RED.
//   - `public/app-logic.mjs`'s `workflowLens({plans, events})` (~L362) computes
//     `wave.state.label` purely from declared-plan status
//     (running / awaiting review / lanes complete · awaiting review /
//     superseded, ~L501-538) — it never inspects `events` for a `kind:"gate"`
//     entry at all, so no wave can ever read "gated" today. Every §S6 pin
//     below is genuine RED for that reason.
//
// RED-agent-defined decisions (documented, not silently guessed):
//   - The widget's container testid is PINNED AS THE SAME `gate-pane`
//     token AC145 itself uses ("the gate pane shows its outcome + step
//     ladder") — it replaces the always-mounted placeholder in place, it does
//     not introduce a new name. It is CONTEXTUAL: present only when the
//     boundary condition (§S6 lanes-complete: the wave's declared plans are
//     all closed/none open) holds AND a gate event exists for that wave;
//     absent otherwise (no persistent element, no empty state — spec text).
//   - Inside the widget, the outcome/step-ladder elements reuse the EXACT
//     `gate-outcome-banner` / `gate-step-row` testids the §S3 GateBody
//     drill-in already established (tests/gate-timeline.test.ts) — the §S3
//     addendum states the drill-in is reachable from BOTH the timeline seal
//     AND the Workflow-tab gate pane, implying one shared rendering body.
//     Scoped queries below look for these testids INSIDE the `gate-pane`
//     container specifically.
//   - "Latest wins" (AC145) and the wave `gated` transition (AC146) are
//     exercised via the SAME live-update technique already established
//     across this suite (tests/workflow-tab.test.ts's `waitForPollTick`,
//     tests/inpane-liveness.test.ts's `opts.events.push(...)`): happy-dom has
//     no real EventSource, so app.js's documented poll fallback (every
//     POLL_INTERVAL_MS) is what actually re-renders; the `document
//     .getElementById("app")` identity check before/after stands in for "no
//     reload".
//   - AC146's "grep asserts no wave-control route exists" clause is NOT
//     duplicated here — it is already pinned (and passing, since no such
//     route exists in production) by tests/workflow-lens.test.ts:566
//     ("no dedicated wave API route exists in src/ — wave state is inferred
//     from plans only"). Re-asserting a currently-true invariant here would
//     add a vacuously-passing test, which is out of place in a RED-only file;
//     that existing test already stands as this AC's evidence.
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

const POLL_INTERVAL_MS = 5000;
const POLL_WAIT_MS = POLL_INTERVAL_MS + 700;
// bun's default per-test timeout (5000ms) is shorter than POLL_WAIT_MS —
// any test calling waitForPollTick() needs this explicit override (same
// precedent as tests/workflow-tab.test.ts's POLL_TEST_TIMEOUT_MS).
const POLL_TEST_TIMEOUT_MS = 15_000;

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
  track?: string;
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
interface GateStepFixture {
  name: string;
  status: string;
  findings?: { total: number; autoFix: number; askUser: number; fixed: number };
  fixRounds?: number;
}
interface GateFixFixture {
  id: string;
  file: string;
  description: string;
}
interface GatePayloadFixture {
  intent: string;
  outcome: "checks-passed" | "passed" | "failed" | "cancelled";
  steps: GateStepFixture[];
  fixes?: GateFixFixture[];
  push?: { commit: string; remote: string };
  pr?: string;
}
interface GateEventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "gate";
  codec: "no-mistakes";
  timestamp: number;
  context?: { wave?: string; track?: string };
  gate: GatePayloadFixture;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: GateEventFixture[];
  plans: PlanFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
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
      throw new Error(`workflow-gate-widget.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowGateWidget=${cacheBust}`);

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
    (el.textContent ?? "").trim() === text,
  ) as HTMLElement | undefined;
}

async function openWorkflowTab(): Promise<HTMLElement> {
  const tab = findByText(document, '[data-testid="workspace-tab"]', "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
  return tab!;
}

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

function defaultGateSteps(): GateStepFixture[] {
  return [
    { name: "intent", status: "passed" },
    { name: "review", status: "passed", findings: { total: 1, autoFix: 1, askUser: 0, fixed: 1 } },
    { name: "test", status: "passed" },
    { name: "push", status: "passed" },
  ];
}

function gateEvent(
  overrides: Partial<GateEventFixture> & { id: string; projectKey: string; timestamp: number },
): GateEventFixture {
  return {
    agentId: "orchestrator-1",
    kind: "gate",
    codec: "no-mistakes",
    context: { wave: "3" },
    gate: {
      intent: "wave 3 no-mistakes gate",
      outcome: "passed",
      steps: defaultGateSteps(),
      push: { commit: "abc1234", remote: "origin/main" },
    },
    ...overrides,
  };
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ── §S4 — mutual exclusivity: the live plan wins over a live gate ─────────

describe("§S4 Workflow tab — the live plan and the gate widget are mutually exclusive", () => {
  test("with an OPEN plan (CR still active) for wave 3, the live-plan view renders and NO gate-pane element mounts, even though a gate event already exists for that same wave", async () => {
    const key = "wf-gatewidget-active";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 501,
      cr: "CR-GW-1",
      projectKey: key,
      status: "open",
      wave: "3",
      cycles: [{ id: 1, label: "C1", status: "active" }],
    };
    const gate = gateEvent({ id: "evt-gw-1", projectKey: key, timestamp: now });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Widget Active CR" })],
      events: [gate],
      plans: [plan],
    });
    await openWorkflowTab();

    // Live plan renders — the active CR is still the primary zone's content.
    const header = document.querySelector('[data-testid="workflow-active-header"]');
    expect(header).not.toBeNull();
    expect(textOf(header)).toContain("CR-GW-1");

    // No gate element anywhere — a CR is active, so the widget must not show
    // regardless of a gate event existing for the same wave.
    expect(document.querySelector('[data-testid="gate-pane"]')).toBeNull();
  });

  test("with no open plan anywhere and no gate event for any wave, no gate-pane element mounts either (the removed placeholder never re-appears as an empty state)", async () => {
    const key = "wf-gatewidget-empty";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Widget Empty" })],
      events: [],
      plans: [],
    });
    await openWorkflowTab();

    expect(document.querySelector('[data-testid="gate-pane"]')).toBeNull();
  });
});

// ── §S4 — the widget appears at the wave/release boundary, replacing the
//    live-plan zone (including its own empty-state filler) entirely ───────

describe("§S4 Workflow tab — gate widget at the boundary (all wave-3 plans closed, gate live)", () => {
  test("all of wave 3's plans closed (no CR active) + a gate event for wave 3 → the gate-pane shows the outcome + one step-row per submitted step; the 'no open plan' filler text is gone", async () => {
    const key = "wf-gatewidget-boundary";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 502,
      cr: "CR-GW-2",
      projectKey: key,
      status: "closed",
      wave: "3",
      merge: { commit: "def5678" },
      cycles: [{ id: 2, label: "C1", status: "done" }],
    };
    const gate = gateEvent({ id: "evt-gw-2", projectKey: key, timestamp: now });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Widget Boundary" })],
      events: [gate],
      plans: [plan],
    });
    await openWorkflowTab();

    const pane = document.querySelector<HTMLElement>('[data-testid="gate-pane"]');
    expect(pane).not.toBeNull();

    const banner = pane!.querySelector('[data-testid="gate-outcome-banner"]');
    expect(banner).not.toBeNull();
    expect(textOf(banner)).toContain("passed");

    const stepRows = pane!.querySelectorAll('[data-testid="gate-step-row"]');
    expect(stepRows.length).toBe(4);

    // Mutually exclusive: the pre-existing "no open plan" filler must not
    // coexist with a live gate widget.
    const body = document.querySelector('[data-testid="workspace-body"]');
    expect((body?.textContent ?? "").toLowerCase()).not.toContain("no open plan");

    // The removed CR-011 placeholder text must never resurface either.
    expect(textOf(pane)).not.toContain("gate reporting lands in CR-013");
  });
});

// ── §S4 AC145 — a second wave-3 gate REPLACES the pane content (latest
//    wins), over the poll/SSE cadence, no reload ──────────────────────────

describe("§S4 AC145 — ingesting a second wave-3 gate replaces the pane content, latest wins, no reload", () => {
  test(
    "interim checks-passed gate renders first; a later passed gate for the same wave fully replaces the ladder — the #app root node identity is unchanged (no reload)",
    async () => {
    const key = "wf-gatewidget-latest";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 503,
      cr: "CR-GW-3",
      projectKey: key,
      status: "closed",
      wave: "3",
      merge: { commit: "aaa0001" },
      cycles: [{ id: 3, label: "C1", status: "done" }],
    };
    const interimGate = gateEvent({
      id: "evt-gw-interim",
      projectKey: key,
      timestamp: now,
      gate: {
        intent: "wave 3 no-mistakes gate (interim)",
        outcome: "checks-passed",
        steps: [
          { name: "intent", status: "passed" },
          { name: "review", status: "passed" },
        ],
      },
    });

    const opts = {
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Widget Latest Wins" })],
      events: [interimGate] as GateEventFixture[],
      plans: [plan],
    };
    await mountApp(opts);
    await openWorkflowTab();

    const appRootBefore = document.getElementById("app");
    expect(appRootBefore).not.toBeNull();

    let pane = document.querySelector<HTMLElement>('[data-testid="gate-pane"]');
    expect(pane).not.toBeNull();
    expect(textOf(pane!.querySelector('[data-testid="gate-outcome-banner"]'))).toContain(
      "checks-passed",
    );
    expect(pane!.querySelectorAll('[data-testid="gate-step-row"]').length).toBe(2);

    // A second, later wave-3 gate arrives (simulating the SSE/poll cadence
    // this suite already uses elsewhere — happy-dom has no real
    // EventSource, so the documented poll fallback is what actually
    // re-renders; the #app identity check below stands in for "no reload").
    const finalGate = gateEvent({
      id: "evt-gw-final",
      projectKey: key,
      timestamp: now + 5000,
      gate: {
        intent: "wave 3 no-mistakes gate (final)",
        outcome: "passed",
        steps: defaultGateSteps(),
        push: { commit: "fff9999", remote: "origin/main" },
      },
    });
    opts.events.push(finalGate);
    await waitForPollTick();

    const appRootAfter = document.getElementById("app");
    expect(appRootAfter).not.toBeNull();
    expect(appRootAfter).toBe(appRootBefore); // no reload — same DOM node

    pane = document.querySelector<HTMLElement>('[data-testid="gate-pane"]');
    expect(pane).not.toBeNull();
    expect(textOf(pane!.querySelector('[data-testid="gate-outcome-banner"]'))).toContain("passed");
    expect(textOf(pane!.querySelector('[data-testid="gate-outcome-banner"]'))).not.toContain(
      "checks-passed",
    );
    // Latest wins — the interim's 2-step ladder is gone, replaced by the
    // final gate's 4-step ladder.
    expect(pane!.querySelectorAll('[data-testid="gate-step-row"]').length).toBe(4);
    },
    POLL_TEST_TIMEOUT_MS,
  );
});

// ── §S6 — the lens wave-header gains `gated` ──────────────────────────────

describe("§S6 History lens — wave state gains `gated` (a passed/checks-passed gate event for that wave)", () => {
  test(
    "wave 3, all plans closed: header reads 'awaiting review' before any gate arrives; a passed gate for wave 3 flips it to 'gated' live (no reload)",
    async () => {
    const key = "wf-gatewidget-gated";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 504,
      cr: "CR-GW-4",
      projectKey: key,
      status: "closed",
      wave: "3",
      merge: { commit: "bbb0002" },
      cycles: [{ id: 4, label: "C1", status: "done" }],
    };

    const opts = {
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Widget Gated" })],
      events: [] as GateEventFixture[],
      plans: [plan],
    };
    await mountApp(opts);
    await openWorkflowTab();

    const wave3Before = document.querySelector<HTMLElement>(
      '[data-testid="wave-group"][data-wave="3"]',
    );
    expect(wave3Before).not.toBeNull();
    const headerBefore = wave3Before!.querySelector('[data-testid="wave-header"]');
    expect(textOf(headerBefore)).toContain("awaiting review");
    expect(textOf(headerBefore)).not.toContain("gated");

    const gate = gateEvent({
      id: "evt-gw-gated",
      projectKey: key,
      timestamp: now,
      gate: { intent: "wave 3 no-mistakes gate", outcome: "passed", steps: defaultGateSteps() },
    });
    opts.events.push(gate);
    await waitForPollTick();

    const wave3After = document.querySelector<HTMLElement>(
      '[data-testid="wave-group"][data-wave="3"]',
    );
    expect(wave3After).not.toBeNull();
    const headerAfter = wave3After!.querySelector('[data-testid="wave-header"]');
    expect(textOf(headerAfter)).toContain("gated");
    expect(textOf(headerAfter)).not.toContain("lanes complete · awaiting review");
    },
    POLL_TEST_TIMEOUT_MS,
  );

  // NOTE — each outcome gets its OWN project/mount, not one shared project
  // with 3 waves: workflowLens's PRE-EXISTING superseded-detection
  // (public/app-logic.mjs ~L529, unrelated to this CR) marks a wave
  // superseded the instant ANY higher-numbered wave holds a declared plan —
  // filing waves 6/7/8 together in one project would make waves 6 and 7
  // read "superseded" for that unrelated reason, contaminating the
  // qualifying/disqualifying-outcome assertion this test actually targets.
  // A separate single-wave project per outcome sidesteps that entirely.
  async function gatedOutcomeCase(
    key: string,
    wave: string,
    outcome: GatePayloadFixture["outcome"],
  ): Promise<string> {
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 900,
      cr: `CR-GW-${wave}`,
      projectKey: key,
      status: "closed",
      wave,
      merge: { commit: "fff0000" },
      cycles: [{ id: 9, label: "C1", status: "done" }],
    };
    const gate = gateEvent({
      id: `evt-gw-${wave}`,
      projectKey: key,
      timestamp: now,
      context: { wave },
      gate: { intent: `wave ${wave} gate`, outcome, steps: defaultGateSteps() },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: `Gate Widget Outcome ${outcome}` })],
      events: [gate],
      plans: [plan],
    });
    await openWorkflowTab();

    const group = document.querySelector<HTMLElement>(
      `[data-testid="wave-group"][data-wave="${wave}"]`,
    );
    expect(group).not.toBeNull();
    return textOf(group!.querySelector('[data-testid="wave-header"]'));
  }

  // Bundled as ONE test, negative bounds FIRST: `failed`/`cancelled` gates
  // must NOT flip the wave to "gated" (the boundary-pause label survives) —
  // this already holds against CURRENT production (workflowLens ignores gate
  // events entirely, so nothing is ever "gated"), so these two sub-checks are
  // not themselves new RED signal; they are asserted anyway (as a bound,
  // Assertion Quality Rule #2) with the genuine new pin — `checks-passed`
  // DOES qualify — placed LAST, so it is the assertion that actually fails
  // against current production (the earlier bound assertions still execute
  // and hold; bun aborts the test at the first throwing expect, which is
  // this final one).
  test("a `failed`/`cancelled` gate does NOT flip the wave to gated (bound); a `checks-passed` gate DOES (the genuine new pin)", async () => {
    const failedHeader = await gatedOutcomeCase("wf-gated-failed", "7", "failed");
    expect(failedHeader).not.toContain("gated");
    expect(failedHeader).toContain("lanes complete · awaiting review");

    const cancelledHeader = await gatedOutcomeCase("wf-gated-cancelled", "8", "cancelled");
    expect(cancelledHeader).not.toContain("gated");
    expect(cancelledHeader).toContain("lanes complete · awaiting review");

    const checksPassedHeader = await gatedOutcomeCase(
      "wf-gated-checks-passed",
      "6",
      "checks-passed",
    );
    expect(checksPassedHeader).toContain("gated");
  });
});
