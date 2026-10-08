// §S2 — the gate drill-in and the Workflow-tab gate widget list a gate run's
// recorded decisions, in posting order, beneath the step rows (frame F21,
// approved 2026-10-05: panels a–c only — panel d, the closed-release history
// summary line, is out of this file's scope entirely).
//
// Server contract this file drives against (already live on this branch):
// `GET /api/v2/events/:id` answers a gate event's `decisions` array — that
// run's decisions, in the order they were POSTED — ONLY on the single-event
// DETAIL read. The brief list (`GET /api/v2/events`) carries no such key on
// ANY event, gate or otherwise (verified by reading the withGateDecisions
// helper and its own comment in src/v2.ts: "the brief list does no per-event
// join"). A decision wire object is `{id, agentId, runId, step?, action,
// findings?, addedFinding?, instructions?, reason?, timestamp, …}` (verbatim
// field names from tests/gate-decision-is-recorded.test.ts's own fixtures,
// already round-tripped against the real server).
//
// Current-code facts verified against public/app.js on this branch:
//   - `gateBodyContent(g)` (public/app.js) takes the GATE sub-object only
//     (`g.steps`, `g.fixes`, `g.push`) — it never sees the surrounding
//     event, so it never sees `event.decisions` as things stand. Both call
//     sites pass `d.gate`/`event.gate` straight in — a sibling key of the
//     event is simply not visible from inside the function today.
//   - The drill-in's `GateBody(d)` body is built from `detail.val`, itself
//     set from an ALREADY-FETCHED single-event detail read
//     (`fetch(`/api/v2/events/${eventId}?depth=suites`)`), so the raw
//     material for `decisions` is already in hand there — nothing new needs
//     fetching for the drill-in; `gateBodyContent` and/or its call site just
//     needs to use it.
//   - The Workflow-tab `GateWidget(event)` is built from `boundaryGate()`,
//     which reduces over `scopedGateEvents()` — itself a filter over
//     `state.events`, the BRIEF list. Per the server contract above, that
//     list item can never carry `decisions`. So unlike the drill-in, the
//     widget has NO decisions data available today by any path that reads
//     only the list: showing them there requires a NEW per-event detail
//     fetch this file's own fixtures are built to require (the list fixture
//     below never carries `decisions`; only the `eventDetails` fixture,
//     answering the single-event route, does) — stated here as the
//     documented finding this file's own assertions prove, not guessed.
// So every pin below is expected to FAIL against current production, for
// one of these two distinct reasons depending on the describe block.
//
// RED-agent-defined decisions (documented, not silently guessed):
//   - Container testid `gate-decisions-section` (presence pinned when a
//     decision exists, ABSENCE pinned when the gate carries none — the key
//     is simply missing on the fixture, matching the server's own "absent
//     when there is nothing to show" rule).
//   - Row testid `gate-decision-row`, one per decision, asserted in ARRAY
//     order (the fixture below is deliberately NOT chronological — see the
//     comment on `decisions` — so a row list produced by re-sorting on
//     timestamp instead of keeping posting order is caught).
//   - Row testid `gate-decision-action`, nested inside each row: its
//     TEXT is the literal wire action word (fix/approve/skip) and its own
//     `className` is where the fix/approve/skip visual distinction (F21:
//     "fix in the heat colour, approve green, skip dim") is pinned, via a
//     flexible per-action regex (same convention as the existing gate-card
//     outcome-coloring pins) rather than one guessed literal class name —
//     GREEN keeps naming freedom on the token, the row-to-row DISTINCTION
//     is what is pinned, bounded so a fix row's action element never also
//     carries the approve or skip token and vice versa.
//   - "Beneath the step rows" (scope item a) is pinned via DOM document
//     order: the decisions section must FOLLOW the last step row, never
//     precede it.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { relativeTime } from "../public/app-logic.mjs";

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

interface GateStepFixture {
  name: string;
  status: string;
  findings?: { total: number; autoFix: number; askUser: number; fixed: number };
  fixRounds?: number;
}
interface GatePayloadFixture {
  intent: string;
  outcome: "checks-passed" | "passed" | "failed" | "cancelled";
  steps: GateStepFixture[];
  fixes?: { id: string; file: string; description: string }[];
  push?: { commit: string; remote: string };
  pr?: string;
  run?: { id: string };
  // CR-CRU-117 §S1 mark, reused here (re-pinned for §S2/AC3, approved) —
  // Now's gate view shows the project's NEWEST gate only while it is still
  // in flight; this file's Workflow-pane half now fixtures an in-flight run
  // rather than a sealed one at the old wave/release boundary.
  inFlight?: boolean;
}
interface GateDecisionFixture {
  id: string;
  agentId: string;
  runId: string;
  step?: string;
  action: "approve" | "fix" | "skip";
  findings?: string[];
  addedFinding?: Record<string, unknown>;
  instructions?: string;
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
  context?: { wave?: string; track?: string };
  gate: GatePayloadFixture;
  runId?: string;
  decisions?: GateDecisionFixture[];
}
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

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: GateEventFixture[];
  plans?: PlanFixture[];
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

function defaultGateSteps(): GateStepFixture[] {
  return [
    { name: "review", status: "passed" },
    { name: "test", status: "passed" },
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
      run: { id: "run-decision-trail-1" },
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
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      opts.fetchLog?.push(id);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`gate-decision-trail.test.ts mountApp: no eventDetails fixture for id ${id}`);
      }
      body = { ok: true, event: detail };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans ?? [] };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`gate-decision-trail.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?gateDecisionTrail=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

async function openWorkflowTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Workflow");
  if (tab === undefined) throw new Error('"Workflow" workspace-tab not found');
  tab.click();
  await settle();
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function expectActionDistinctClass(el: Element, action: "fix" | "approve" | "skip"): void {
  const cls = el.className;
  const patterns: Record<string, RegExp> = {
    fix: /fix/i,
    approve: /approve/i,
    skip: /skip/i,
  };
  expect(cls).toMatch(patterns[action]!);
  for (const other of ["fix", "approve", "skip"] as const) {
    if (other === action) continue;
    expect(cls).not.toMatch(patterns[other]!);
  }
}

// A decision row's time: the clock time, then the relative age
// (`14:02 · 3m ago`). The clock is the board's UTC clock, the same one its
// dated values use; a decision from another UTC day than now carries that
// day ahead of the clock (`2026-10-04 23:58 · 2h ago`). Built here from the
// raw ISO string, independently of the render's own formatter.
function decisionTime(ts: number, now: number): string {
  const iso = new Date(ts).toISOString();
  const clock = iso.slice(11, 16);
  const day = iso.slice(0, 10);
  const shown = day === new Date(now).toISOString().slice(0, 10) ? clock : `${day} ${clock}`;
  return `${shown} · ${relativeTime(ts, now)}`;
}

// Deliberately NOT chronological — see the module comment on row-ORDER
// pinning: 3m ago, then 2h ago, then 45m ago, then 10m ago. A render that
// re-sorts by timestamp instead of keeping posting order fails every
// index-based assertion below.
function decisionTrailFixture(now: number): GateDecisionFixture[] {
  return [
    {
      id: "gd-1",
      agentId: "ci-bot",
      runId: "run-decision-trail-1",
      step: "pr",
      action: "skip",
      timestamp: now - 3 * 60 * 1000,
    },
    {
      id: "gd-2",
      agentId: "vidushi",
      runId: "run-decision-trail-1",
      step: "review",
      action: "fix",
      findings: ["f-03", "f-07", "f-11"],
      instructions: "keep the public API unchanged",
      timestamp: now - 2 * 3600 * 1000,
    },
    {
      id: "gd-3",
      agentId: "vidushi",
      runId: "run-decision-trail-1",
      step: "review",
      action: "fix",
      addedFinding: {
        id: "fx-9",
        file: "src/release-notes.md",
        description: "the release notes omit a change",
      },
      timestamp: now - 45 * 60 * 1000,
    },
    {
      id: "gd-4",
      agentId: "vidushi",
      runId: "run-decision-trail-1",
      step: "test",
      action: "approve",
      reason: "flaky e2e retried green twice",
      timestamp: now - 10 * 60 * 1000,
    },
  ];
}

// ── §S2/F21 panels a–c — the drill-in's DECISIONS section ──────────────────

describe("gate drill-in — the DECISIONS section beneath the step rows", () => {
  test("a gate run with NO recorded decisions shows no DECISIONS section at all (the key is simply absent, matching the server's own contract); the SAME gate, once it carries decisions, then shows one row per decision in POSTING order (not re-sorted by time), beneath the step rows, each row carrying time · agent · step · action · what it carried", async () => {
    const key = "gate-decisions-drillin";

    // ── Part 1 — no decisions recorded yet: no section at all ────────────
    const bareEventId = "evt-no-decisions-drillin-1";
    const bareNow = Date.now();
    const bareFixture = gateEvent({ id: bareEventId, projectKey: key, timestamp: bareNow });

    await mountApp({
      pathname: `/p/${key}/run/${bareEventId}`,
      projects: [project({ key, name: "Gate Decisions Drillin" })],
      events: [bareFixture],
      eventDetails: { [bareEventId]: bareFixture },
    });

    // Sanity — the drill-in itself did open (step ladder renders).
    expect(document.querySelectorAll('[data-testid="gate-step-row"]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="gate-decisions-section"]')).toBeNull();

    // ── Part 2 — the same run, now carrying decisions ─────────────────────
    const eventId = "evt-decisions-drillin-1";
    const now = Date.now();
    const decisions = decisionTrailFixture(now);
    const fixture = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      runId: "run-decision-trail-1",
      decisions,
    });
    const briefListFixture = gateEvent({ id: eventId, projectKey: key, timestamp: now });

    await mountApp({
      pathname: `/p/${key}/run/${eventId}`,
      projects: [project({ key, name: "Gate Decisions Drillin" })],
      events: [briefListFixture],
      eventDetails: { [eventId]: fixture },
    });

    const section = document.querySelector<HTMLElement>('[data-testid="gate-decisions-section"]');
    expect(section).not.toBeNull();

    const rows = section!.querySelectorAll<HTMLElement>('[data-testid="gate-decision-row"]');
    expect(rows.length).toBe(4);

    // "Beneath the step rows" — document order, not just presence.
    const stepRows = document.querySelectorAll<HTMLElement>('[data-testid="gate-step-row"]');
    expect(stepRows.length).toBeGreaterThan(0);
    const lastStepRow = stepRows[stepRows.length - 1]!;
    expect(
      !!(lastStepRow.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    const nowAtAssert = Date.now();

    // Row 0 — skip, "pr", no findings/instructions/reason.
    const row0 = rows[0]!;
    expect(textOf(row0)).toContain("pr");
    const action0 = row0.querySelector<HTMLElement>('[data-testid="gate-decision-action"]');
    expect(action0).not.toBeNull();
    expect(textOf(action0)).toBe("skip");
    expectActionDistinctClass(action0!, "skip");
    expect(textOf(row0)).toContain("ci-bot");
    expect(textOf(row0)).toContain(decisionTime(decisions[0]!.timestamp, nowAtAssert));

    // Row 1 — fix, "review", finding ids + instructions.
    const row1 = rows[1]!;
    expect(textOf(row1)).toContain("review");
    const action1 = row1.querySelector<HTMLElement>('[data-testid="gate-decision-action"]');
    expect(textOf(action1)).toBe("fix");
    expectActionDistinctClass(action1!, "fix");
    expect(textOf(row1)).toContain("f-03");
    expect(textOf(row1)).toContain("f-07");
    expect(textOf(row1)).toContain("f-11");
    expect(textOf(row1)).toContain("keep the public API unchanged");
    expect(textOf(row1)).toContain("vidushi");
    expect(textOf(row1)).toContain(decisionTime(decisions[1]!.timestamp, nowAtAssert));

    // Row 2 — fix, "review", an ADDED finding (never a finding id).
    const row2 = rows[2]!;
    expect(textOf(row2)).toContain("review");
    const action2 = row2.querySelector<HTMLElement>('[data-testid="gate-decision-action"]');
    expect(textOf(action2)).toBe("fix");
    expectActionDistinctClass(action2!, "fix");
    expect(textOf(row2)).toContain("the release notes omit a change");
    expect(textOf(row2)).toContain(decisionTime(decisions[2]!.timestamp, nowAtAssert));

    // Row 3 — approve, "test", a reason (a Test-step exception).
    const row3 = rows[3]!;
    expect(textOf(row3)).toContain("test");
    const action3 = row3.querySelector<HTMLElement>('[data-testid="gate-decision-action"]');
    expect(textOf(action3)).toBe("approve");
    expectActionDistinctClass(action3!, "approve");
    expect(textOf(row3)).toContain("flaky e2e retried green twice");
    expect(textOf(row3)).toContain(decisionTime(decisions[3]!.timestamp, nowAtAssert));

    // Bound — no row leaks another row's distinguishing content.
    expect(textOf(row0)).not.toContain("f-03");
    expect(textOf(row1)).not.toContain("flaky e2e retried green twice");
    expect(textOf(row3)).not.toContain("keep the public API unchanged");
  });
});

// ── §S2/F21 — the Workflow-tab gate widget's DECISIONS section ─────────────

describe("Now's gate view (\u00a7S2/AC3) \u2014 the DECISIONS section, sourced off a per-event detail fetch the BRIEF list cannot supply", () => {
  test("an in-flight gate with NO recorded decisions shows no DECISIONS section in Now's gate view; the SAME run, once it carries decisions, then shows the same DECISIONS rows the drill-in shows, fetched via the single-event detail route (never read off the brief list, which carries no `decisions` key at all)", async () => {
    const key = "gate-decisions-widget";

    // \u2500\u2500 Part 1 \u2014 no decisions recorded yet: no section at all \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const bareEventId = "evt-no-decisions-widget-1";
    const bareNow = Date.now();
    const bareGatePayload = {
      intent: "release no-mistakes gate (in flight)",
      outcome: "checks-passed" as const,
      steps: defaultGateSteps(),
      run: { id: "run-decision-trail-bare" },
      inFlight: true,
    };
    const bareListFixture = gateEvent({
      id: bareEventId,
      projectKey: key,
      timestamp: bareNow,
      gate: bareGatePayload,
    });
    const bareDetailFixture = gateEvent({
      id: bareEventId,
      projectKey: key,
      timestamp: bareNow,
      gate: bareGatePayload,
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Decisions Widget" })],
      events: [bareListFixture],
      plans: [],
      eventDetails: { [bareEventId]: bareDetailFixture },
    });
    await openWorkflowTab();
    await settle();

    const barePane = document.querySelector<HTMLElement>('[data-testid="gate-pane"]');
    expect(barePane).not.toBeNull();
    expect(barePane!.querySelectorAll('[data-testid="gate-step-row"]').length).toBeGreaterThan(0);
    expect(barePane!.querySelector('[data-testid="gate-decisions-section"]')).toBeNull();

    // \u2500\u2500 Part 2 \u2014 the same run, now carrying decisions \u2500\u2500
    const eventId = "evt-decisions-widget-1";
    const now = Date.now();
    const decisions = decisionTrailFixture(now);
    const gatePayload = {
      intent: "release no-mistakes gate (in flight)",
      outcome: "checks-passed" as const,
      steps: defaultGateSteps(),
      run: { id: "run-decision-trail-1" },
      inFlight: true,
    };
    // The LIST item — exactly what `GET /api/v2/events` really answers: no
    // `decisions` key anywhere on it.
    const listFixture = gateEvent({ id: eventId, projectKey: key, timestamp: now, gate: gatePayload });
    // The DETAIL item — exactly what `GET /api/v2/events/:id` really
    // answers for this same gate: the `decisions` array, posting order.
    const detailFixture = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      gate: gatePayload,
      runId: "run-decision-trail-1",
      decisions,
    });
    const fetchLog: string[] = [];

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Decisions Widget" })],
      events: [listFixture],
      plans: [],
      eventDetails: { [eventId]: detailFixture },
      fetchLog,
    });
    await openWorkflowTab();
    // One more settle: the widget's own decisions fetch (new behaviour, not
    // the mount-time plans/events fetch) resolves on its own microtask/0ms
    // chain, same mechanism the drill-in's existing fetch already relies on.
    await settle();

    const pane = document.querySelector<HTMLElement>('[data-testid="gate-pane"]');
    expect(pane).not.toBeNull();

    // MOCK verification — the widget actually went to the single-event
    // detail route for this gate's id; it did not invent the data.
    expect(fetchLog).toContain(eventId);

    const section = pane!.querySelector<HTMLElement>('[data-testid="gate-decisions-section"]');
    expect(section).not.toBeNull();

    const rows = section!.querySelectorAll<HTMLElement>('[data-testid="gate-decision-row"]');
    expect(rows.length).toBe(4);

    const nowAtAssert = Date.now();
    const action0 = rows[0]!.querySelector<HTMLElement>('[data-testid="gate-decision-action"]');
    expect(textOf(action0)).toBe("skip");
    expectActionDistinctClass(action0!, "skip");
    expect(textOf(rows[0])).toContain("ci-bot");
    expect(textOf(rows[0])).toContain(decisionTime(decisions[0]!.timestamp, nowAtAssert));

    const action1 = rows[1]!.querySelector<HTMLElement>('[data-testid="gate-decision-action"]');
    expect(textOf(action1)).toBe("fix");
    expectActionDistinctClass(action1!, "fix");
    expect(textOf(rows[1])).toContain("f-03");
    expect(textOf(rows[1])).toContain("keep the public API unchanged");

    const action3 = rows[3]!.querySelector<HTMLElement>('[data-testid="gate-decision-action"]');
    expect(textOf(action3)).toBe("approve");
    expectActionDistinctClass(action3!, "approve");
    expect(textOf(rows[3])).toContain("flaky e2e retried green twice");

    // "Beneath the step rows" holds in the widget too.
    const stepRows = pane!.querySelectorAll<HTMLElement>('[data-testid="gate-step-row"]');
    expect(stepRows.length).toBeGreaterThan(0);
    const lastStepRow = stepRows[stepRows.length - 1]!;
    expect(
      !!(lastStepRow.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });
});

// The widget's detail read is held per gate id: the Workflow primary zone
// re-renders on every poll, and each re-render must reuse the one read
// rather than issue another. The poll fallback is the app's real
// `setInterval(refetch, 5000)` (happy-dom has no EventSource), so each tick is
// awaited in real time, the same way the sibling widget suites do it.
const POLL_WAIT_MS = 5000 + 700;
const POLL_TEST_TIMEOUT_MS = 30_000;

async function waitForPollTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, POLL_WAIT_MS);
  await promise;
  await settle();
}

describe("Now's gate view (§S2/AC3) — one detail read per gate, and a failed read degrades to the bare step ladder", () => {
  test(
    "across repeated poll re-renders of the SAME in-flight run (each visibly re-rendering the gate view), the gate's single-event detail read is issued exactly once, and its DECISIONS rows stay on screen",
    async () => {
      const key = "gate-decisions-widget-fetch-once";
      const eventId = "evt-decisions-widget-fetch-once";
      const now = Date.now();
      const decisions = decisionTrailFixture(now);
      const listGate = (outcome: GatePayloadFixture["outcome"]): GateEventFixture =>
        gateEvent({
          id: eventId,
          projectKey: key,
          timestamp: now,
          gate: {
            intent: "wave 3 no-mistakes gate",
            outcome,
            steps: defaultGateSteps(),
            run: { id: "run-decision-trail-1" },
            inFlight: true,
          },
        });
      const events: GateEventFixture[] = [listGate("checks-passed")];
      const fetchLog: string[] = [];

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Gate Decisions Fetch Once" })],
        events,
        plans: [],
        eventDetails: {
          [eventId]: gateEvent({
            id: eventId,
            projectKey: key,
            timestamp: now,
            gate: {
              intent: "wave 3 no-mistakes gate",
              outcome: "checks-passed",
              steps: defaultGateSteps(),
              run: { id: "run-decision-trail-1" },
              inFlight: true,
            },
            runId: "run-decision-trail-1",
            decisions,
          }),
        },
        fetchLog,
      });
      await openWorkflowTab();
      await settle();

      const banner = (): string =>
        textOf(document.querySelector('[data-testid="gate-pane"] [data-testid="gate-outcome-banner"]'));
      const decisionRows = (): number =>
        document.querySelectorAll(
          '[data-testid="gate-pane"] [data-testid="gate-decisions-section"] [data-testid="gate-decision-row"]',
        ).length;
      const detailReads = (): number => fetchLog.filter((id) => id === eventId).length;

      expect(banner()).toContain("checks-passed");
      expect(decisionRows()).toBe(4);
      expect(detailReads()).toBe(1);

      // Poll 1 — the brief list answers the same gate id with a new outcome,
      // so the widget re-renders (the banner proves it did).
      events.splice(0, events.length, listGate("passed"));
      await waitForPollTick();
      expect(banner()).toContain("passed");
      expect(banner()).not.toContain("checks-passed");
      expect(decisionRows()).toBe(4);
      expect(detailReads()).toBe(1);

      // Poll 2 — and again.
      events.splice(0, events.length, listGate("failed"));
      await waitForPollTick();
      expect(banner()).toContain("failed");
      expect(decisionRows()).toBe(4);
      expect(detailReads()).toBe(1);
    },
    POLL_TEST_TIMEOUT_MS,
  );

  test("a detail read that fails leaves the widget's step ladder in place with NO DECISIONS section, and raises no unhandled error", async () => {
    const key = "gate-decisions-widget-fetch-fails";
    const eventId = "evt-decisions-widget-fetch-fails";
    const fetchLog: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // No `eventDetails` entry for the gate: the mock fetch REJECTS that read.
      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Gate Decisions Fetch Fails" })],
        events: [
          gateEvent({
            id: eventId,
            projectKey: key,
            timestamp: Date.now(),
            gate: {
              intent: "wave 3 no-mistakes gate",
              outcome: "checks-passed",
              steps: defaultGateSteps(),
              run: { id: "run-decision-trail-fails" },
              inFlight: true,
            },
          }),
        ],
        plans: [],
        eventDetails: {},
        fetchLog,
      });
      const windowErrors: unknown[] = [];
      window.addEventListener("error", (e) => windowErrors.push(e));
      window.addEventListener("unhandledrejection", (e) => windowErrors.push(e));
      await openWorkflowTab();
      await settle();

      // The read WAS attempted (and failed) — not merely never issued.
      expect(fetchLog).toContain(eventId);

      const pane = document.querySelector<HTMLElement>('[data-testid="gate-pane"]');
      expect(pane).not.toBeNull();
      expect(pane!.querySelectorAll('[data-testid="gate-step-row"]').length).toBe(2);
      expect(pane!.querySelector('[data-testid="gate-decisions-section"]')).toBeNull();
      expect(windowErrors).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
