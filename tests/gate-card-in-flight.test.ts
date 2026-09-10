// CR-CRU-117 §S1 — THE THIRD GATE READER: the timeline's own gate cards.
//
// Two readers were repaired in cycle 408 — `workflowLens`'s wave gating
// (`public/app-logic.mjs`) and `boundaryGate` (`public/app.js`) — and both
// EXCLUDE an in-flight gate from the verdict they derive. The feed's cards are
// the third reader, and they were left rendering one:
//
//   * `runFeed` dispatches every `kind === "gate"` row to `GateCardRow`
//     (workspace) or `GateCardCompact` (home) with no in-flight check;
//   * `gateCardText` writes `🛡 Wave N gate · no-mistakes checks-passed · …`,
//     the interim outcome the client is forced to send, with no qualification;
//   * the class stem comes from `gateOutcomeClass(outcome)`, which answers
//     `pass` for `checks-passed` — so the card is painted as a green SEAL;
//   * and `shortCommit(undefined)` renders the tail as a bare `pushed `, a
//     clause claiming a push that has not happened.
//
// Before this CR no interim gate could exist, so no card ever met one. Now a
// long run streams up to nine per run into the feed, which reproduces exactly
// the false green the CR's Context describes.
//
// THE RULING (orchestrator, cycle 412): LABEL the card, do not filter it. The
// feed is a HISTORY surface — hiding a real event from it is a worse lie than
// showing one, and the CR's objection is to a gate READING as a verdict, not
// to its existence. So an in-flight gate keeps its row, carries the mark in
// words, and takes a class stem of its own.
//
// EVERY ASSERTION HERE COMES IN A PAIR: the marked gate and its UNMARKED TWIN,
// the same run's seal, whose text and class stem are pinned BYTE-IDENTICAL to
// what production renders today. A change that qualified every gate card — or
// that dropped the `pushed` clause from a real seal — would satisfy the marked
// half and be caught by the twin.
//
// THE FIXTURES are the shape the client really posts, taken from the suite
// that pins the POST body
// (`tests/client/test_a_run_in_flight_streams_its_ladder.py`): nine rows from
// `no-mistakes` v1.70.1 (captured 2026-09-10), `review` still `running`, the
// six unrun steps `pending`, `outcome: "checks-passed"`, `inFlight: true`, and
// NO `push` — an in-flight gate has no commit to name.
//
// Tier: UNIT — happy-dom mount of the shipped `public/app.js`, no process, no
// socket, no live service, no wait on the clock.
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

// The mark, spelled as the client posts it and as the two repaired readers
// already test it — a key INSIDE the gate object (settled 2026-09-10,
// `docs/research/DN-crucible-wave-track-release.md` D3).
const IN_FLIGHT_KEY = "inFlight";

// The commit the sealing gate names, and the 7 characters the card shows of it.
const SEAL_COMMIT = "a5ad01346d028653be14854f1573562d8769d4b0";
const SEAL_SHORT_COMMIT = "a5ad013";

interface GateStepFixture {
  name: string;
  status: string;
  findings?: { total: number; autoFix: number; askUser: number; fixed: number };
}
interface GatePayloadFixture {
  intent: string;
  outcome: string;
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
  eventDetails?: Record<string, GateEventFixture>;
}

// The nine-row ladder mid-run: `intent` and `rebase` resolved, `review`
// running, the rest untouched. The statuses are the client's MAPPED ones (the
// gate payload's vocabulary), not axi's raw words.
function inFlightLadder(): GateStepFixture[] {
  return [
    { name: "intent", status: "passed" },
    { name: "rebase", status: "passed" },
    { name: "review", status: "running" },
    { name: "test", status: "pending" },
    { name: "document", status: "pending" },
    { name: "lint", status: "pending" },
    { name: "push", status: "pending" },
    { name: "pr", status: "pending" },
    { name: "ci", status: "pending" },
  ];
}

// The SAME nine rows once the run resolved, with the review round's two fixed
// findings — the sum the card's `<n> findings fixed` segment reports.
function sealedLadder(): GateStepFixture[] {
  return inFlightLadder().map((s) =>
    s.name === "review"
      ? {
          name: "review",
          status: "passed",
          findings: { total: 2, autoFix: 2, askUser: 0, fixed: 2 },
        }
      : { name: s.name, status: "passed" },
  );
}

function inFlightGate(): GatePayloadFixture {
  return {
    intent: "release 0.2.0 no-mistakes gate",
    outcome: "checks-passed",
    steps: inFlightLadder(),
    [IN_FLIGHT_KEY]: true,
  };
}

function sealGate(): GatePayloadFixture {
  return {
    intent: "release 0.2.0 no-mistakes gate",
    outcome: "passed",
    steps: sealedLadder(),
    push: { commit: SEAL_COMMIT, remote: "origin/release/0.2.0" },
  };
}

function gateEvent(
  id: string,
  projectKey: string,
  timestamp: number,
  gate: GatePayloadFixture,
): GateEventFixture {
  return {
    id,
    projectKey,
    agentId: "orchestrator-1",
    kind: "gate",
    codec: "no-mistakes",
    timestamp,
    context: { wave: "6" },
    gate,
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
          `gate-card-in-flight.test.ts mountApp: no eventDetails fixture for id ${id}`,
        );
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
      throw new Error(`gate-card-in-flight.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?gateCardInFlight=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 8 });
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
  await settleDom({ ticks: 8 });
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The card's seal string, read off its own testid child so the ⊙ Detail badge
 *  never leaks into the text under test. */
function sealTextOf(card: Element): string {
  return textOf(card.querySelector('[data-testid="gate-seal"]'));
}

// ── the workspace card ─────────────────────────────────────────────────────

describe("CR-CRU-117 §S1 — the workspace gate-card marks an in-flight gate instead of sealing it", () => {
  test("an in-flight gate's seal text QUALIFIES its outcome and claims no push, and its class stem is neither pass nor fail", async () => {
    const key = "gate-card-in-flight-ws";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [gateEvent("evt-gate-in-flight", key, Date.now(), inFlightGate())],
    });
    await openRunsTab();

    // The row is STILL THERE — the ruling is to label, never to filter: the
    // feed is history, and a real event dropped from it is the worse lie.
    const cards = document.querySelectorAll<HTMLElement>('[data-testid="gate-card"]');
    expect(cards.length).toBe(1);
    const card = cards[0]!;

    expect(sealTextOf(card)).toBe(
      "🛡 Wave 6 gate · no-mistakes checks-passed · in flight · 9 steps · 0 findings fixed",
    );

    // Named separately from the exact string above, because THIS is the
    // reading the CR exists to prevent: `checks-passed` standing alone as a
    // verdict, and a `pushed` clause naming a commit that does not exist.
    expect(sealTextOf(card)).toContain("in flight");
    expect(sealTextOf(card)).not.toContain("pushed");

    // The paint is the other half of the reading. `gateOutcomeClass` answers
    // `pass` for `checks-passed`, so an unrepaired card is GREEN.
    expect(card.className).toContain("app-gate-inflight");
    expect(card.className).not.toContain("app-gate-pass");
    expect(card.className).not.toContain("app-gate-fail");
  });

  test("ANTI-VACUITY TWIN — the same run's SEAL renders byte-identically to today: unqualified outcome, its pushed clause, the pass stem", async () => {
    const key = "gate-card-in-flight-ws-twin";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project(key)],
      events: [gateEvent("evt-gate-seal", key, Date.now(), sealGate())],
    });
    await openRunsTab();

    const cards = document.querySelectorAll<HTMLElement>('[data-testid="gate-card"]');
    expect(cards.length).toBe(1);
    const card = cards[0]!;

    // The §S2 template, unchanged, character for character. A repair that
    // qualified EVERY gate card — or that dropped `pushed` wholesale — passes
    // the marked half of this pair and fails here.
    expect(sealTextOf(card)).toBe(
      `🛡 Wave 6 gate · no-mistakes passed · 9 steps · 2 findings fixed · pushed ${SEAL_SHORT_COMMIT}`,
    );
    expect(sealTextOf(card)).not.toContain("in flight");

    expect(card.className).toContain("app-gate-pass");
    expect(card.className).not.toContain("app-gate-inflight");
  });
});

// ── the home compact card ──────────────────────────────────────────────────

describe("CR-CRU-117 §S1 — the home compact gate row marks an in-flight gate too", () => {
  test("the compact one-liner carries the mark and omits the empty commit; its twin is byte-identical to today", async () => {
    const key = "gate-card-in-flight-home";
    const inFlight = gateEvent("evt-gate-in-flight", key, Date.now(), inFlightGate());
    const seal = gateEvent("evt-gate-seal", key, Date.now(), sealGate());

    await mountApp({ pathname: "/", projects: [project(key)], events: [inFlight] });
    const marked = document.querySelectorAll<HTMLElement>(
      '[data-testid="gate-card-compact"]',
    );
    expect(marked.length).toBe(1);
    expect(textOf(marked[0]!)).toBe("🛡 no-mistakes checks-passed · in flight");
    expect(marked[0]!.className).toContain("app-gate-inflight");
    expect(marked[0]!.className).not.toContain("app-gate-pass");

    // ANTI-VACUITY TWIN — the sealed row on the same surface.
    await mountApp({ pathname: "/", projects: [project(key)], events: [seal] });
    const sealed = document.querySelectorAll<HTMLElement>(
      '[data-testid="gate-card-compact"]',
    );
    expect(sealed.length).toBe(1);
    expect(textOf(sealed[0]!)).toBe(`🛡 no-mistakes passed · ${SEAL_SHORT_COMMIT}`);
    expect(sealed[0]!.className).toContain("app-gate-pass");
    expect(sealed[0]!.className).not.toContain("app-gate-inflight");
  });
});

// ── the drill-in body ──────────────────────────────────────────────────────

describe("CR-CRU-117 §S1 — the gate drill-in's outcome banner is qualified for an in-flight gate", () => {
  test("drilling into an in-flight gate shows a marked, non-pass banner over the live ladder", async () => {
    const key = "gate-card-in-flight-drillin";
    const eventId = "evt-gate-in-flight";
    const fixture = gateEvent(eventId, key, Date.now(), inFlightGate());

    await mountApp({
      pathname: `/p/${key}/run/${eventId}`,
      projects: [project(key)],
      events: [fixture],
      eventDetails: { [eventId]: fixture },
    });

    const banner = document.querySelector<HTMLElement>('[data-testid="gate-outcome-banner"]');
    expect(banner).not.toBeNull();
    expect(textOf(banner)).toBe("no-mistakes checks-passed · in flight");
    expect(banner!.className).toContain("app-gate-inflight");
    expect(banner!.className).not.toContain("app-gate-pass");

    // The ladder underneath is the point of drilling in and stays whole —
    // labelling the verdict must not cost the reader the nine rows.
    expect(document.querySelectorAll('[data-testid="gate-step-row"]').length).toBe(9);
  });

  test("ANTI-VACUITY TWIN — a sealed gate's banner still reads exactly `no-mistakes passed` with the pass stem", async () => {
    const key = "gate-card-in-flight-drillin-twin";
    const eventId = "evt-gate-seal";
    const fixture = gateEvent(eventId, key, Date.now(), sealGate());

    await mountApp({
      pathname: `/p/${key}/run/${eventId}`,
      projects: [project(key)],
      events: [fixture],
      eventDetails: { [eventId]: fixture },
    });

    const banner = document.querySelector<HTMLElement>('[data-testid="gate-outcome-banner"]');
    expect(banner).not.toBeNull();
    expect(textOf(banner)).toBe("no-mistakes passed");
    expect(banner!.className).toContain("app-gate-pass");
    expect(banner!.className).not.toContain("app-gate-inflight");
  });
});
