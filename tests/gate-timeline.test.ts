// CR-CRU-013 §S2 (gate-card) + §S3 (gate drill-in body) — C2 RED tests.
//
// Spec: docs/changes/CR-CRU-013-gate-events.md §S2/§S3 (+ the Implementation
// Notes UI paragraph). §S1's server foundation (C1) is LIVE — gate events are
// stored `kind:"gate"`, `codec:"no-mistakes"`, `event.gate = {intent, outcome,
// steps:[{name,status,findings?{total,autoFix,askUser,fixed},fixRounds?}],
// fixes?:[{id,file,description}], push?:{commit,remote}, pr?}` (verbatim field
// names from tests/gate-milestone-server.test.ts's fixtures, which already
// round-trip against the real server).
//
// Current code facts (verified against public/app.js on this branch):
//   - runFeed() (app.js ~L749) only knows 4 timelineRows kinds (marker /
//     cycle-span-open / declared-marker / card) — a gate/milestone event
//     falls through `else rows.push(EventCard(row.event))`, so it renders as
//     an ordinary 🧪/🛠 RUN CARD today (RatioPill and all), not a gate-card.
//   - RunDetailBody's kind dispatch (app.js ~L2748) is
//     `d.kind === "compile" ? CompileBody(d) : TestBody(d)` — a gate event
//     (kind "gate") falls to TestBody, which has no gate-shaped rendering.
//   - There is no home-vs-workspace `surface` distinction anywhere in
//     runFeed/TimelineFeed/WorkspaceRunsFeed — both call
//     `runFeed(visibleEvents())` identically (Implementation Notes: "the
//     home-vs-workspace surface branch is NET-NEW").
// So every pin below is expected to FAIL against current production.
//
// RED-agent-defined contract notes (spec text/AC left these underspecified —
// documented as ESCALATIONs in the RED hand-off report, not silently
// invented):
//   - the gate-card's outcome-coloring CSS class token isn't named by the
//     spec (only "green passed/checks-passed · red failed · grey cancelled"
//     is prose) — pinned here via flexible /pass|fail|cancel/i class-name
//     regexes rather than one specific literal token, so GREEN keeps some
//     naming freedom on the exact class while the outcome-conditioned
//     behavior itself is still pinned.
//   - the "<findings fixed>" segment of the §S2 card template isn't defined
//     beyond the placeholder — pinned here as "the SUM of every step's
//     findings.fixed" (the only "fixed" figure the §S1 payload actually
//     carries), rendered "<n> findings fixed".
//   - §S3's prose step ladder promises "per-step status + findings counts +
//     fix rounds" — no "duration" field exists anywhere in the §S1 steps
//     shape ({name,status,findings?,fixRounds?}), so no duration assertion is
//     made (a dispatch-prompt item asking for step "duration visible" is not
//     backed by data and is NOT pinned here — see the RED hand-off report).
//   - a §S1 step's `findings` is a per-step AGGREGATE COUNT object
//     ({total,autoFix,askUser,fixed}), never an array of individual finding
//     records — there is no id/severity/file/description/action shape
//     anywhere in the payload. Only the FIXES table (id/file/description,
//     §S1's real `fixes` array) is pinned; no separate "findings table" is
//     invented.
//   - testids gate-detail-badge / gate-card-compact / gate-outcome-banner /
//     gate-step-row / gate-fix-row / gate-push-line are this RED agent's own
//     naming (the spec pins "gate-card" only) — GREEN should match them.
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
  eventDetails?: Record<string, GateEventFixture>;
}

let cacheBust = 0;

function defaultGate(overrides: Partial<GatePayloadFixture> = {}): GatePayloadFixture {
  return {
    intent: "wave 3 no-mistakes gate",
    outcome: "passed",
    steps: [
      { name: "intent", status: "passed" },
      {
        name: "review",
        status: "passed",
        findings: { total: 2, autoFix: 1, askUser: 0, fixed: 2 },
      },
      { name: "test", status: "passed" },
      { name: "push", status: "passed", fixRounds: 0 },
    ],
    fixes: [{ id: "f1", file: "src/a.ts", description: "removed unused import" }],
    push: { commit: "abc1234", remote: "origin/main" },
    pr: "https://github.com/x/y/pull/1",
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
    context: { wave: "3", track: "A" },
    gate: defaultGate(),
    ...overrides,
  };
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
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`gate-timeline.test.ts mountApp: no eventDetails fixture for id ${id}`);
      }
      body = { ok: true, event: detail };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`gate-timeline.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?gateTimeline=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

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

// ── §S2 — gate-card, CYCLE-DONE MARKER design (workspace, full form) ────────

describe("§S2 gate-card — cycle-done marker design, exact text template, never '0/'", () => {
  test("workspace Runs tab renders exactly one full-width gate-card: app-transition-marker class, not a run card, exact §S2 text, no '0/' anywhere", async () => {
    const key = "gate-card-basic";
    const eventId = "evt-gate-basic-1";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Card Basic" })],
      events: [gateEvent({ id: eventId, projectKey: key, timestamp: now })],
    });
    await openRunsTab();

    const cards = document.querySelectorAll<HTMLElement>('[data-testid="gate-card"]');
    expect(cards.length).toBe(1);
    const card = cards[0]!;

    // Cycle-done marker design, NOT a run card.
    expect(card.className).toContain("app-transition-marker");
    expect(card.className).not.toContain("app-evt");
    expect(card.querySelector('[data-testid="ratio-pill"]')).toBeNull();

    // Exact §S2 text template: 🛡 Wave <n> gate · no-mistakes <outcome> ·
    // <N> steps · <findings fixed> · pushed <shortcommit>. 4 steps submitted;
    // only the "review" step carries findings.fixed (2) — the sum is 2.
    expect(textOf(card.querySelector('[data-testid="gate-seal"]'))).toBe(
      "🛡 Wave 3 gate · no-mistakes passed · 4 steps · 2 findings fixed · pushed abc1234",
    );

    // Bound — never test-ratio leakage.
    expect(textOf(card)).not.toContain("0/");
  });

  test("outcome-coloring: passed/checks-passed carry a pass-class (no fail-class); failed carries a fail-class (no pass-class); cancelled carries neither pass nor fail (a distinct grey/cancelled class)", async () => {
    const key = "gate-card-outcomes";
    const now = Date.now();
    const events: GateEventFixture[] = [
      gateEvent({
        id: "evt-gate-passed",
        projectKey: key,
        timestamp: now,
        gate: defaultGate({ outcome: "passed" }),
      }),
      gateEvent({
        id: "evt-gate-checks-passed",
        projectKey: key,
        timestamp: now + 1,
        gate: defaultGate({ outcome: "checks-passed" }),
      }),
      gateEvent({
        id: "evt-gate-failed",
        projectKey: key,
        timestamp: now + 2,
        gate: defaultGate({ outcome: "failed" }),
      }),
      gateEvent({
        id: "evt-gate-cancelled",
        projectKey: key,
        timestamp: now + 3,
        gate: defaultGate({ outcome: "cancelled" }),
      }),
    ];

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Card Outcomes" })],
      events,
    });
    await openRunsTab();

    const cards = document.querySelectorAll<HTMLElement>('[data-testid="gate-card"]');
    expect(cards.length).toBe(4);

    const byOutcomeText = (needle: string) =>
      Array.from(cards).find((c) => textOf(c).includes(needle));

    const passedCard = byOutcomeText("no-mistakes passed");
    expect(passedCard).toBeDefined();
    expect(passedCard!.className).toMatch(/pass/i);
    expect(passedCard!.className).not.toMatch(/fail/i);

    const checksPassedCard = byOutcomeText("no-mistakes checks-passed");
    expect(checksPassedCard).toBeDefined();
    expect(checksPassedCard!.className).toMatch(/pass/i);
    expect(checksPassedCard!.className).not.toMatch(/fail/i);

    const failedCard = byOutcomeText("no-mistakes failed");
    expect(failedCard).toBeDefined();
    expect(failedCard!.className).toMatch(/fail/i);
    expect(failedCard!.className).not.toMatch(/pass/i);

    const cancelledCard = byOutcomeText("no-mistakes cancelled");
    expect(cancelledCard).toBeDefined();
    expect(cancelledCard!.className).not.toMatch(/pass/i);
    expect(cancelledCard!.className).not.toMatch(/fail/i);
    expect(cancelledCard!.className).toMatch(/cancel|grey|gray/i);
  });
});

// ── §S2 — the trailing drill badge is the ONLY drill affordance ────────────

describe("§S2 gate-detail-badge — the badge (not the whole card body) opens the drill-in", () => {
  test("clicking the ⊙ Detail badge navigates to the gate's drill-in; clicking elsewhere on the card body does nothing", async () => {
    const key = "gate-badge-drill";
    const eventId = "evt-gate-badge-1";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Gate Badge Drill" })],
      events: [gateEvent({ id: eventId, projectKey: key, timestamp: now })],
      eventDetails: {
        [eventId]: gateEvent({ id: eventId, projectKey: key, timestamp: now }),
      },
    });
    await openRunsTab();

    const card = document.querySelector<HTMLElement>('[data-testid="gate-card"]');
    expect(card).not.toBeNull();

    // Bound — clicking the card body itself (not the badge) must not navigate.
    card!.click();
    await settle();
    expect(location.pathname).not.toContain(`/run/${eventId}`);

    const badge = card!.querySelector<HTMLElement>('[data-testid="gate-detail-badge"]');
    expect(badge).not.toBeNull();
    expect(textOf(badge)).toContain("⊙ Detail");

    badge!.click();
    await settle();
    expect(location.pathname).toBe(`/p/${key}/run/${eventId}`);
  });
});

// ── §S4b/§S4c wording — home compact one-line gate entry ───────────────────

describe("home vs workspace — gates render COMPACT on home, full on workspace", () => {
  test("the SAME gate fixture renders full gate-card on workspace and a distinct compact gate-card-compact (no full gate-card) on home", async () => {
    const key = "gate-home-compact";
    const eventId = "evt-gate-home-1";
    const now = Date.now();
    const events = [gateEvent({ id: eventId, projectKey: key, timestamp: now })];
    const projects = [project({ key, name: "Gate Home Compact" })];

    await mountApp({ pathname: `/p/${key}`, projects, events });
    await openRunsTab();
    expect(document.querySelectorAll('[data-testid="gate-card"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="gate-card-compact"]').length).toBe(0);

    await mountApp({ pathname: "/", projects, events });
    expect(document.querySelectorAll('[data-testid="gate-card"]').length).toBe(0);
    const compact = document.querySelectorAll<HTMLElement>('[data-testid="gate-card-compact"]');
    expect(compact.length).toBe(1);
    expect(textOf(compact[0]!)).toContain("🛡");
    expect(textOf(compact[0]!)).toContain("passed");
    expect(textOf(compact[0]!)).toContain("abc1234");
    expect(textOf(compact[0]!)).not.toContain("0/");
  });
});

// ── §S3 — GateBody drill-in (codec-aware, single form) ──────────────────────

describe("§S3 GateBody — outcome banner, step ladder, fixes table, push/PR line, no drillin-mode", () => {
  test("opening a gate's drill-in renders the outcome banner, one step-row per submitted step (name+status), the review step's findings count, a fixes-table row per submitted fix, and the push/PR line; no drillin-mode element; TestBody's suite/leaf rows never render", async () => {
    const key = "gate-drillin-1";
    const eventId = "evt-gate-drillin-1";
    const now = Date.now();
    const fixture = gateEvent({ id: eventId, projectKey: key, timestamp: now });

    await mountApp({
      pathname: `/p/${key}/run/${eventId}`,
      projects: [project({ key, name: "Gate Drillin" })],
      events: [fixture],
      eventDetails: { [eventId]: fixture },
    });

    const outcomeBanner = document.querySelector<HTMLElement>(
      '[data-testid="gate-outcome-banner"]',
    );
    expect(outcomeBanner).not.toBeNull();
    expect(textOf(outcomeBanner)).toContain("passed");

    const stepRows = document.querySelectorAll<HTMLElement>('[data-testid="gate-step-row"]');
    expect(stepRows.length).toBe(4);
    const stepTexts = Array.from(stepRows).map((r) => textOf(r));
    expect(stepTexts.some((t) => t.includes("intent") && t.includes("passed"))).toBe(true);
    expect(stepTexts.some((t) => t.includes("test") && t.includes("passed"))).toBe(true);
    expect(stepTexts.some((t) => t.includes("push") && t.includes("passed"))).toBe(true);
    const reviewRow = stepTexts.find((t) => t.includes("review"));
    expect(reviewRow).toBeDefined();
    expect(reviewRow!).toMatch(/findings/i);
    expect(reviewRow!).toContain("2");

    const fixRows = document.querySelectorAll<HTMLElement>('[data-testid="gate-fix-row"]');
    expect(fixRows.length).toBe(1);
    expect(textOf(fixRows[0]!)).toContain("f1");
    expect(textOf(fixRows[0]!)).toContain("src/a.ts");
    expect(textOf(fixRows[0]!)).toContain("removed unused import");

    const pushLine = document.querySelector<HTMLElement>('[data-testid="gate-push-line"]');
    expect(pushLine).not.toBeNull();
    expect(textOf(pushLine)).toContain("abc1234");
    expect(textOf(pushLine)).toContain("origin/main");
    expect(textOf(pushLine)).toContain("https://github.com/x/y/pull/1");

    // Single form, like compile — no Detail/Density switch anywhere.
    expect(document.querySelector('[data-testid="drillin-mode"]')).toBeNull();

    // Dispatch bound — a gate event must NOT fall through to TestBody's
    // suite/leaf anatomy (RunDetailBody must branch kind:"gate" to its own
    // body, not the test-run fallback).
    expect(document.querySelectorAll('[data-testid="suite-row"]').length).toBe(0);
    expect(document.querySelectorAll('[data-testid="leaf-row"]').length).toBe(0);
  });
});
