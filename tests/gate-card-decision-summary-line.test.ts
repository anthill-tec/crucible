// CR-CRU-166 §S1 (C2 — board) — the sealed-gate decision summary LINE on the
// Runs-timeline 🛡 card.
//
// Spec: docs/changes/CR-CRU-166-a-sealed-gates-decisions-are-summarised-in-history.md
// §S1 + Counting rules + G4/G5/R2; AC1, AC2, AC3, AC7. Visual contract:
// .lavish/crucible-v2-design.html F21 panel d ("d · once the run finishes …"),
// the "Runs timeline — the 🛡 gate card (F8)" mock, APPROVED 2026-10-05:
//   🛡 no-mistakes passed · release 0.4.0
//   4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a reason
//
// C1 (539853d, merged) already makes the SERVER emit `decisionSummary` on a
// sealed gate's events-LIST brief — `{decisions, fixed, added, declined,
// approvedWithReason}` (verbatim field names, confirmed against
// tests/sealed-gate-events-carry-a-decision-summary.test.ts, which also
// reproduces the spec's own worked example: decisions:4 fixed:3 added:1
// declined:16 approvedWithReason:1 — the fixtures below reuse it verbatim
// rather than invent new numbers). C1 ALSO already changed `public/app.js`'s
// gate-step-row rendering (`gateBodyContent`) to read a step's `findings` as
// EITHER a plain number (the new client shape) OR the legacy `{total}`
// object — confirmed by reading the shipped code directly. This file's drill-
// in assertions (T6) therefore pin BEHAVIOUR that is already correct in
// production; they are folded into a test whose EARLIER assertions (the
// decision-summary line itself, and the click that opens the drill-in) are
// still missing and fail first, so the whole test is RED for the real defect
// (AC3 — no click target yet exists), while still proving the downstream
// step-row rendering holds once GREEN wires the click through.
//
// Fixture note — `runId` is DELIBERATELY absent from every event fixture
// here: reading `eventBrief` (src/v2.ts) directly shows it never forwards
// `runId` onto a list brief at all (only `decisionSummary` is computed
// server-side off the stored `runId` and spread onto the brief when present).
// The client's only observable signal that a gate carries decisions is the
// `decisionSummary` key itself — mirroring the real wire shape here, not an
// invented one.
//
// RED-agent-defined contract notes (spec text/AC left these underspecified —
// documented here, not silently invented):
//   - testids `gate-decision-summary` (the new line, nested inside the
//     existing `gate-card`) are this RED agent's own naming (the spec names
//     no testid) — GREEN should match it.
//   - ZERO-count wording (not stated by the spec beyond the single worked
//     example): `fixed <n>` NEVER grows a `+ <k> added` clause when
//     `added === 0` (mirrors the spec's own phrasing, "plus one per added
//     finding (SHOWN AS `fixed 3 + 1 added`)" — i.e. the `+ N added` clause
//     is itself conditional on there being an addition). Likewise `<n>
//     approved with a reason` is OMITTED wholesale when
//     `approvedWithReason === 0` (mirrors `gateDecisionCarried`'s own rule,
//     "Only the parts the decision actually carries are shown"). `declined
//     <n>` is the one clause that ALWAYS renders, including `declined 0` —
//     it is a core computed quantity (R1/R2), not an optional carried extra
//     like `added`/`approvedWithReason`. Full template:
//     `<n> decisions · fixed <f>[ + <a> added] · declined <d>[ · <r> approved
//     with a reason]`.
//   - no singular/plural grammar anywhere (`"1 decisions"`, not `"1
//     decision"`) — matches the codebase's existing convention of bare
//     pluralization with no singular branch (`${steps.length} steps` in
//     `gateCardText` never special-cases 1).
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
interface LegacyStepFindings {
  total: number;
  autoFix: number;
  askUser: number;
  fixed: number;
}
interface GateStepFixture {
  name: string;
  status: string;
  // C1 — a posted step now carries its findings count as a plain number; an
  // older stored event still carries the legacy `{total,...}` object.
  findings?: number | LegacyStepFindings;
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
  // ABSENT (never a zeroed object) unless the fixture states otherwise —
  // mirrors the server's "none" rule (sealed-gate-events-carry-a-decision-
  // summary.test.ts).
  decisionSummary?: DecisionSummaryFixture;
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
  eventDetails?: Record<string, { event: unknown }>;
}

function defaultGate(overrides: Partial<GatePayloadFixture> = {}): GatePayloadFixture {
  return {
    intent: "wave 7 no-mistakes gate",
    outcome: "passed",
    steps: [
      { name: "intent", status: "passed" },
      { name: "review", status: "passed", findings: 10 },
      { name: "test", status: "passed", findings: 9 },
      { name: "push", status: "passed" },
    ],
    push: { commit: "abc1234", remote: "origin/release/0.4.0" },
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
    context: { wave: "7" },
    gate: defaultGate(),
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
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(
          `gate-card-decision-summary-line.test.ts mountApp: no eventDetails fixture for id ${id}`,
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
        `gate-card-decision-summary-line.test.ts mountApp: unexpected fetch url ${url}`,
      );
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?gateCardDecisionSummary=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 8 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

async function openRunsTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Runs");
  if (tab === undefined) throw new Error('"Runs" workspace-tab not found');
  tab.click();
  await settle();
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function sealTextOf(card: Element): string {
  return textOf(card.querySelector('[data-testid="gate-seal"]'));
}

function summaryLineOf(card: Element): Element | null {
  return card.querySelector('[data-testid="gate-decision-summary"]');
}

// ── AC1 + AC7/R2 — the summary line and the corrected fixed clause ────────

describe("CR-CRU-166 §S1 AC1/AC7 — the gate card's decision-summary line and its decision-derived 'findings fixed' clause", () => {
  test("a sealed gate with a decisionSummary shows exactly ONE F21-worded decision-summary line, and the existing seal's 'findings fixed' clause reads decisionSummary.fixed (3) rather than the step sum (which is 0 once findings is a number)", async () => {
    const key = "gate-decision-summary-worked-example";
    const eventId = "evt-gate-decision-summary-1";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [
        gateEvent({
          id: eventId,
          projectKey: key,
          timestamp: now,
          decisionSummary: { decisions: 4, fixed: 3, added: 1, declined: 16, approvedWithReason: 1 },
        }),
      ],
    });
    await openRunsTab();

    const cards = document.querySelectorAll<HTMLElement>('[data-testid="gate-card"]');
    expect(cards.length).toBe(1);
    const card = cards[0]!;

    // AC7/R2 — the pre-existing seal clause, corrected.
    expect(sealTextOf(card)).toBe(
      "🛡 Wave 7 gate · no-mistakes passed · 4 steps · 3 findings fixed · pushed abc1234",
    );
    expect(sealTextOf(card)).not.toContain("0 findings fixed");

    // AC1 — exactly one summary line, the F21 wording verbatim.
    const lines = card.querySelectorAll('[data-testid="gate-decision-summary"]');
    expect(lines.length).toBe(1);
    expect(textOf(summaryLineOf(card))).toBe(
      "4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a reason",
    );
  });

  test("zero-count wording — added:0 drops the '+ N added' clause, approvedWithReason:0 drops the 'approved with a reason' clause, but declined:0 still renders as a bare count", async () => {
    const key = "gate-decision-summary-zero-counts";
    const eventId = "evt-gate-decision-summary-zero";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [
        gateEvent({
          id: eventId,
          projectKey: key,
          timestamp: now,
          decisionSummary: { decisions: 2, fixed: 1, added: 0, declined: 0, approvedWithReason: 0 },
        }),
      ],
    });
    await openRunsTab();

    const card = document.querySelector<HTMLElement>('[data-testid="gate-card"]')!;
    expect(textOf(summaryLineOf(card))).toBe("2 decisions · fixed 1 · declined 0");
    expect(textOf(summaryLineOf(card))).not.toContain("added");
    expect(textOf(summaryLineOf(card))).not.toContain("approved with a reason");
  });

  test("AC7 anti-ambiguity — a LARGE decisionSummary.fixed figure (12) renders verbatim, never the always-0 step-level sum", async () => {
    const key = "gate-decision-summary-fixed-figure";
    const eventId = "evt-gate-decision-summary-fixed";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [
        gateEvent({
          id: eventId,
          projectKey: key,
          timestamp: now,
          gate: defaultGate({
            steps: [
              { name: "intent", status: "passed" },
              { name: "review", status: "passed", findings: 50 },
              { name: "push", status: "passed" },
            ],
            push: { commit: "zzz9999", remote: "origin/release/0.4.0" },
          }),
          decisionSummary: { decisions: 5, fixed: 12, added: 0, declined: 8, approvedWithReason: 2 },
        }),
      ],
    });
    await openRunsTab();

    const card = document.querySelector<HTMLElement>('[data-testid="gate-card"]')!;
    expect(sealTextOf(card)).toContain("12 findings fixed");
    expect(sealTextOf(card)).not.toContain("0 findings fixed");
  });
});

// ── AC2 — no line without decisionSummary / for an in-flight gate ─────────
//
// NOTE — these two bound/negative pins legitimately PASS against current
// production already (nothing renders `gate-decision-summary` yet at all, in
// any state). Kept anyway, per this CR's own C1 server-side RED file's
// precedent (tests/sealed-gate-events-carry-a-decision-summary.test.ts:
// "kept to catch a later implementation that fabricates the key where the
// spec forbids it") — they guard against a GREEN that shows a line
// unconditionally instead of gating it on `decisionSummary`'s presence.

describe("CR-CRU-166 §S1 AC2 — no decision-summary line when there is nothing to summarise", () => {
  test("a sealed gate with NO decisionSummary key (zero recorded decisions) shows no decision-summary line", async () => {
    const key = "gate-decision-summary-absent";
    const eventId = "evt-gate-decision-summary-absent";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [gateEvent({ id: eventId, projectKey: key, timestamp: now })], // no decisionSummary
    });
    await openRunsTab();

    const card = document.querySelector<HTMLElement>('[data-testid="gate-card"]')!;
    expect(summaryLineOf(card)).toBeNull();
  });

  test("an in-flight gate shows no decision-summary line (the real server never attaches one to an in-flight gate either)", async () => {
    const key = "gate-decision-summary-inflight";
    const eventId = "evt-gate-decision-summary-inflight";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [
        gateEvent({
          id: eventId,
          projectKey: key,
          timestamp: now,
          gate: defaultGate({
            outcome: "checks-passed",
            inFlight: true,
            steps: [
              { name: "intent", status: "passed" },
              { name: "review", status: "running" },
            ],
            push: undefined,
          }),
        }),
      ],
    });
    await openRunsTab();

    const card = document.querySelector<HTMLElement>('[data-testid="gate-card"]')!;
    expect(summaryLineOf(card)).toBeNull();
  });
});

// ── AC3 — a click opens the drill-in; the drill-in step row shapes ────────

describe("CR-CRU-166 §S1 AC3 — a click on the decision-summary line opens the gate's drill-in", () => {
  test("clicking the decision-summary line navigates to the gate's drill-in (clicking the seal text elsewhere does nothing); the opened drill-in's step rows read BOTH a numeric findings count and the legacy {total} object", async () => {
    const key = "gate-decision-summary-click";
    const eventId = "evt-gate-decision-summary-click";
    const now = Date.now();

    const fixture = gateEvent({
      id: eventId,
      projectKey: key,
      timestamp: now,
      context: { wave: "9" },
      gate: defaultGate({
        steps: [
          { name: "intent", status: "passed" },
          // C1's new shape — a plain number.
          { name: "review", status: "passed", findings: 8 },
          // the legacy shape — an older stored event's {total,...} object.
          { name: "audit", status: "passed", findings: { total: 6, autoFix: 4, askUser: 0, fixed: 2 } },
          { name: "push", status: "passed" },
        ],
      }),
      decisionSummary: { decisions: 4, fixed: 3, added: 1, declined: 16, approvedWithReason: 1 },
    });

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [fixture],
      eventDetails: { [eventId]: { event: fixture } },
    });
    await openRunsTab();

    const card = document.querySelector<HTMLElement>('[data-testid="gate-card"]')!;

    // NEGATIVE bound — clicking the seal text (not the summary line) must not
    // navigate.
    card.querySelector<HTMLElement>('[data-testid="gate-seal"]')!.click();
    await settle();
    expect(location.pathname).not.toContain(`/run/${eventId}`);

    const line = summaryLineOf(card);
    expect(line).not.toBeNull();
    (line as HTMLElement).click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}/run/${eventId}`);

    const stepRows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="gate-step-row"]'));
    const reviewRow = stepRows.find((r) => textOf(r).startsWith("review"));
    const auditRow = stepRows.find((r) => textOf(r).startsWith("audit"));
    expect(reviewRow).toBeDefined();
    expect(auditRow).toBeDefined();
    expect(textOf(reviewRow!)).toContain("8 findings");
    expect(textOf(auditRow!)).toContain("6 findings");
  });
});
