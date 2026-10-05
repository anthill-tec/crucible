// CR-CRU-166 §S1 (C2 — board) — the sealed-gate decision summary LINE on the
// gated wave's row in Workflow History.
//
// Spec: docs/changes/CR-CRU-166-a-sealed-gates-decisions-are-summarised-in-history.md
// §S1 + Counting rules + G4/G5; AC1, AC2, AC3. Visual contract:
// .lavish/crucible-v2-design.html F21 panel d, the "Workflow › History — the
// gated wave's row (F13)" mock, APPROVED 2026-10-05:
//   ▸ wave 7 · release 0.4.0 · gate passed
//   4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a reason
//
// G4 (gap analysis): "The wave header today says `gated`, not F21's `gate
// passed`; the summary line sits BENEATH that header and the header's
// WORDING IS UNCHANGED." So this file asserts the header still reads `gated`
// (production's existing word, `workflowLens`'s `gatedWaveLabels` ->
// `{label: "gated"}`) — the mock's "gate passed" phrasing is the visual
// DIRECTION approved for the summary line's presence/placement, not a literal
// header-text requirement the spec text itself overrides.
//
// G4 also rules which gate a multi-sealed-gate wave's row summarises: "the
// wave's latest sealed gate, the same 'latest wins' rule as the Workflow gate
// widget (`boundaryGate`)" — `boundaryGate` (public/app.js) explicitly drops
// any `gate.inFlight === true` event before applying 'latest wins'. This file
// pins both halves: latest-among-several, and in-flight-is-never-a-candidate.
//
// Harness: same production-shell-in-happy-dom pattern as
// tests/workflow-history-refinements.test.ts (`plans` + `events` fixtures,
// `findBackChip` reused verbatim), extended with an `eventDetails` map for
// the AC3 click test's single-event fetch (`/api/v2/events/<id>?depth=suites`
// — same pattern as tests/gate-timeline.test.ts).
//
// RED-agent-defined contract notes:
//   - testid `wave-decision-summary` (nested inside the existing
//     `wave-header`/`wave-group`) is this RED agent's own naming — GREEN
//     should match it.
//   - zero-count wording and the exact decisions/fixed/added/declined/
//     approvedWithReason template are shared with
//     tests/gate-card-decision-summary-line.test.ts (see that file's header
//     comment for the full rule) — AC1 requires "the same words in both
//     places", so this file's cross-surface test (T1) reads BOTH the History
//     row and the Runs-timeline card off the SAME mounted app instance and
//     asserts the two strings are byte-identical, the strongest form of that
//     requirement.
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

interface DecisionSummaryFixture {
  decisions: number;
  fixed: number;
  added: number;
  declined: number;
  approvedWithReason: number;
}
interface GateStepFixture {
  name: string;
  status: string;
  findings?: number;
}
interface GatePayloadFixture {
  intent: string;
  outcome: "checks-passed" | "passed" | "failed" | "cancelled";
  steps: GateStepFixture[];
  push?: { commit: string; remote: string };
  inFlight?: boolean;
}
interface GateEventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "gate";
  codec: "no-mistakes";
  timestamp: number;
  context?: { wave?: string };
  gate: GatePayloadFixture;
  decisionSummary?: DecisionSummaryFixture;
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
  status: "open" | "closed" | "aborted";
  wave?: string;
  track?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
  closedAt?: number;
}
interface ProjectFixture {
  key: string;
  name: string;
  type: "backend";
  agentsOnline: number;
  agentsTotal: number;
  active: boolean;
  lastActivity: number;
}
interface MountOpts {
  pathname: string;
  projects: ProjectFixture[];
  events: GateEventFixture[];
  plans: PlanFixture[];
  eventDetails?: Record<string, { event: unknown }>;
}

function gateEvent(
  overrides: Partial<GateEventFixture> & { id: string; projectKey: string; timestamp: number },
): GateEventFixture {
  return {
    agentId: "orchestrator-1",
    kind: "gate",
    codec: "no-mistakes",
    context: { wave: "7" },
    gate: {
      intent: "wave 7 no-mistakes gate",
      outcome: "passed",
      steps: [
        { name: "intent", status: "passed" },
        { name: "review", status: "passed", findings: 10 },
        { name: "test", status: "passed", findings: 9 },
        { name: "push", status: "passed" },
      ],
      push: { commit: "abc1234", remote: "origin/release/0.4.0" },
    },
    ...overrides,
  };
}

function plan(overrides: Partial<PlanFixture> & { planId: number; cr: string; projectKey: string }): PlanFixture {
  return {
    status: "closed",
    wave: "7",
    cycles: [{ id: 1, label: "c", status: "done" }],
    closedAt: Date.now() - 1000,
    merge: { commit: "deadbee" },
    ...overrides,
  };
}

function project(key: string): ProjectFixture {
  return {
    key,
    name: key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: Date.now(),
  };
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${opts.pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(
          `workflow-history-gate-decision-summary.test.ts mountApp: no eventDetails fixture for id ${id}`,
        );
      }
      body = { ok: true, event: detail.event };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(
        `workflow-history-gate-decision-summary.test.ts mountApp: unexpected fetch url ${url}`,
      );
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowHistoryDecisionSummary=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function openWorkflowTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

async function openRunsTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Runs");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function history(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(el).not.toBeNull();
  return el!;
}

function waveGroup(waveLabel: string): HTMLElement {
  const el = history().querySelector<HTMLElement>(
    `[data-testid="wave-group"][data-wave="${waveLabel}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

function waveHeaderOf(wave: HTMLElement): HTMLElement {
  const el = wave.querySelector<HTMLElement>('[data-testid="wave-header"]');
  expect(el).not.toBeNull();
  return el!;
}

function summaryLineOf(wave: HTMLElement): Element | null {
  return wave.querySelector('[data-testid="wave-decision-summary"]');
}

function findBackChip(): HTMLElement {
  const chip = Array.from(document.querySelectorAll<HTMLElement>("button, a")).find(
    (el) => (el.textContent ?? "").trim() === "← workflow",
  );
  expect(chip).toBeDefined();
  return chip!;
}

// ── AC1 — identical text in both places, header wording unchanged ─────────

describe("CR-CRU-166 §S1 AC1 — the History wave row carries the SAME summary line as the Runs-timeline card", () => {
  test("the gated wave's header still reads 'gated' (unchanged); the new summary line beneath it is byte-identical to the SAME gate's line on its Runs-timeline card", async () => {
    const key = "wave-decision-summary-cross-surface";
    const eventId = "evt-wave-decision-summary-1";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      plans: [plan({ planId: 1, cr: "CR-WAVE-7", projectKey: key, wave: "7" })],
      events: [
        gateEvent({
          id: eventId,
          projectKey: key,
          timestamp: now,
          decisionSummary: { decisions: 4, fixed: 3, added: 1, declined: 16, approvedWithReason: 1 },
        }),
      ],
    });
    await openWorkflowTab();

    const wave = waveGroup("7");
    // G4 — header wording UNCHANGED, never the mock's "gate passed" literal.
    expect(textOf(waveHeaderOf(wave))).toContain("gated");
    expect(textOf(waveHeaderOf(wave))).not.toContain("gate passed");

    const historyText = textOf(summaryLineOf(wave));
    expect(historyText).toBe(
      "4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a reason",
    );

    await openRunsTab();
    const card = document.querySelector<HTMLElement>('[data-testid="gate-card"]')!;
    const cardText = textOf(card.querySelector('[data-testid="gate-decision-summary"]'));

    expect(cardText).toBe(historyText);
  });
});

// 
// NOTE \u2014 this bound/negative pin legitimately PASSES against current
// production already (nothing renders `wave-decision-summary` yet at all).
// Kept anyway, per this CR's own C1 server-side RED file's precedent
// (tests/sealed-gate-events-carry-a-decision-summary.test.ts: "kept to catch
// a later implementation that fabricates the key where the spec forbids
// it") \u2014 it guards against a GREEN that shows a line unconditionally
// instead of gating it on the summarised gate's own `decisionSummary`.
// ── AC2 — no line when there is nothing to summarise ───────────────────────

describe("CR-CRU-166 §S1 AC2 — the History row carries no summary line when the wave's gate has no recorded decisions", () => {
  test("a wave whose sealed gate has ZERO recorded decisions (no decisionSummary key) still reads 'gated', but shows no summary line", async () => {
    const key = "wave-decision-summary-zero-decisions";
    const eventId = "evt-wave-decision-summary-zero";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      plans: [plan({ planId: 2, cr: "CR-WAVE-7-ZERO", projectKey: key, wave: "7" })],
      events: [gateEvent({ id: eventId, projectKey: key, timestamp: now })], // no decisionSummary
    });
    await openWorkflowTab();

    const wave = waveGroup("7");
    expect(textOf(waveHeaderOf(wave))).toContain("gated");
    expect(summaryLineOf(wave)).toBeNull();
  });

  test("a wave that was NEVER gated renders its History row (header + CR group) with no summary line, beside a gated wave whose line still renders", async () => {
    const key = "wave-decision-summary-never-gated";
    const now = Date.now();
    const events = [
      gateEvent({
        id: "evt-wave-decision-summary-gated-neighbour",
        projectKey: key,
        timestamp: now,
        decisionSummary: { decisions: 4, fixed: 3, added: 1, declined: 16, approvedWithReason: 1 },
      }),
    ];

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      plans: [
        plan({ planId: 6, cr: "CR-GATED", projectKey: key, wave: "7" }),
        plan({ planId: 7, cr: "CR-NOGATE", projectKey: key, wave: "8" }),
      ],
      events,
    });
    await openWorkflowTab();

    // `waveLatestSealedGate` has nothing to pick for the never-gated wave.
    const logic = (await import(`${APP_LOGIC_PATH}?workflowHistoryDecisionSummary=${cacheBust}`)) as {
      waveLatestSealedGate: (events: unknown[], wave: string) => unknown;
    };
    expect(logic.waveLatestSealedGate(events, "8")).toBeNull();

    const neverGated = waveGroup("8");
    expect(textOf(waveHeaderOf(neverGated))).toContain("Wave 8");
    expect(textOf(neverGated)).toContain("CR-NOGATE");
    expect(summaryLineOf(neverGated)).toBeNull();
    expect(neverGated.querySelector('[data-testid="gate-decision-summary"]')).toBeNull();

    expect(textOf(summaryLineOf(waveGroup("7")))).toBe(
      "4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a reason",
    );
  });
});

// ── G4 — the wave's LATEST sealed gate, in-flight never a candidate ───────

describe("CR-CRU-166 G4 — the History row summarises the wave's latest SEALED gate", () => {
  test("a wave gated twice (a re-run) shows the LATER sealed gate's summary line, never the earlier one's", async () => {
    const key = "wave-decision-summary-latest-wins";
    const now = Date.now();
    const earlierId = "evt-wave-decision-summary-earlier";
    const laterId = "evt-wave-decision-summary-later";

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      plans: [plan({ planId: 3, cr: "CR-WAVE-7-RERUN", projectKey: key, wave: "7" })],
      events: [
        gateEvent({
          id: earlierId,
          projectKey: key,
          timestamp: now - 10_000,
          decisionSummary: { decisions: 2, fixed: 1, added: 0, declined: 0, approvedWithReason: 0 },
        }),
        gateEvent({
          id: laterId,
          projectKey: key,
          timestamp: now,
          decisionSummary: { decisions: 4, fixed: 3, added: 1, declined: 16, approvedWithReason: 1 },
        }),
      ],
    });
    await openWorkflowTab();

    const wave = waveGroup("7");
    expect(textOf(summaryLineOf(wave))).toBe(
      "4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a reason",
    );
    expect(textOf(summaryLineOf(wave))).not.toBe("2 decisions · fixed 1");
  });

  test("a LATER in-flight gate (a re-run still going) is never a candidate — the row keeps showing the earlier SEALED gate's line, not blank and not the in-flight one", async () => {
    const key = "wave-decision-summary-inflight-ignored";
    const now = Date.now();
    const sealedId = "evt-wave-decision-summary-sealed";
    const inFlightId = "evt-wave-decision-summary-inflight";

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      plans: [plan({ planId: 4, cr: "CR-WAVE-7-INFLIGHT", projectKey: key, wave: "7" })],
      events: [
        gateEvent({
          id: sealedId,
          projectKey: key,
          timestamp: now - 10_000,
          decisionSummary: { decisions: 4, fixed: 3, added: 1, declined: 16, approvedWithReason: 1 },
        }),
        gateEvent({
          id: inFlightId,
          projectKey: key,
          timestamp: now,
          gate: {
            intent: "wave 7 no-mistakes gate (re-run)",
            outcome: "checks-passed",
            inFlight: true,
            steps: [{ name: "intent", status: "passed" }, { name: "review", status: "running" }],
          },
          // no decisionSummary — the real server never attaches one to an
          // in-flight gate.
        }),
      ],
    });
    await openWorkflowTab();

    const wave = waveGroup("7");
    expect(summaryLineOf(wave)).not.toBeNull();
    expect(textOf(summaryLineOf(wave))).toBe(
      "4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a reason",
    );
  });
});

// ── AC3 — a click opens the summarised gate's drill-in ─────────────────────

describe("CR-CRU-166 §S1 AC3 — a click on the History summary line opens that gate's drill-in", () => {
  test("clicking the summary line on a twice-gated wave opens the LATEST sealed gate's drill-in (never the earlier one's); the back chip reads '← workflow'", async () => {
    const key = "wave-decision-summary-click";
    const now = Date.now();
    const earlierId = "evt-wave-decision-summary-click-earlier";
    const laterId = "evt-wave-decision-summary-click-later";

    const laterFixture = gateEvent({
      id: laterId,
      projectKey: key,
      timestamp: now,
      decisionSummary: { decisions: 4, fixed: 3, added: 1, declined: 16, approvedWithReason: 1 },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      plans: [plan({ planId: 5, cr: "CR-WAVE-7-CLICK", projectKey: key, wave: "7" })],
      events: [
        gateEvent({
          id: earlierId,
          projectKey: key,
          timestamp: now - 10_000,
          decisionSummary: { decisions: 2, fixed: 1, added: 0, declined: 0, approvedWithReason: 0 },
        }),
        laterFixture,
      ],
      eventDetails: { [laterId]: { event: laterFixture } },
    });
    await openWorkflowTab();

    const wave = waveGroup("7");
    const line = summaryLineOf(wave);
    expect(line).not.toBeNull();
    (line as HTMLElement).click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/${laterId}`);
    expect(location.pathname).not.toBe(`/p/${key}/run/${earlierId}`);

    expect(findBackChip()).toBeDefined();
  });
});
