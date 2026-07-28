// CR-CRU-044 C2 — the dashboard classifies an agent by its STORED phase
// (declared at registration, C1 §S1) instead of string-matching the
// agentId. `phaseRole(agentId)` (CR-CRU-007 §S1, tests/phase-role.test.ts)
// is retained ONLY as a fallback for historical records that carry no
// stored phase — that file stays green and UNMODIFIED (explicit AC).
//
// Contract this file defines for GREEN — a new pure helper on
// public/app-logic.mjs:
//
//   export function agentRole(agent: { agentId: string; phase?: string | null }): PhaseRole
//
//   - `agent.phase` present (a non-null, non-undefined string) -> the
//     declaration decides, full stop; `phaseRole(agent.agentId)` is NEVER
//     consulted in this branch, even if the mapped result is `null`.
//     Enum -> role mapping (server enum is
//     RED | GREEN | FIX | VERIFY | ORCHESTRATOR | report, exact case):
//       "RED"          -> "red"
//       "GREEN"        -> "green"
//       "FIX"          -> "fix"
//       "VERIFY"       -> "verify"
//       "ORCHESTRATOR" -> null   (no tint in the existing 4-role vocabulary
//                                  — renders neutral, same visual as roleless)
//       "report"       -> null   (same — neutral, no tint)
//       anything else (defensively, should never occur post-C1 validation)
//                      -> null, and still WITHOUT falling back to phaseRole
//                         (a present-but-unrecognized value is not "absent")
//   - `agent.phase` absent (`undefined`) OR explicitly `null` (both are how
//     a pre-CR-044 / historical row can read back, C1's `agent-phase.test.ts`
//     §S1(d) pins `null`/`undefined` for legacy rows) -> falls back to
//     `phaseRole(agent.agentId)` EXACTLY as today, unmodified contract.
//
// Callers to update in public/app.js (not tested directly here beyond the
// EventCard integration below — same call shape at all three sites):
//   public/app.js:709, :2165, :2201 currently call `L.phaseRole(e.agentId)`
//   directly on an EVENT, ignoring the owning agent's stored phase. GREEN
//   must look the agent up from `state.agents` by `e.agentId` and call
//   `L.agentRole({ agentId: e.agentId, phase: matchedAgent?.phase })`
//   instead.
//
// RED phase: `agentRole` does not exist yet on public/app-logic.mjs (same
// not-yet-exported-name convention as tests/phase-role.test.ts — a
// namespace import stays loadable, so `AppLogic.agentRole(...)` fails at
// CALL time with a TypeError, which IS the RED signal) and public/app.js's
// EventCard still classifies purely off `e.agentId` via `phaseRole`,
// ignoring any stored phase on the matching agent record.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

// ── Pure agentRole(agent) contract ──────────────────────────────────────

describe("app-logic — agentRole(agent), pure (CR-CRU-044 §S2 stored-phase classification)", () => {
  test("the defect's regression case: a stored phase wins over a conflicting id suffix — id ends '-GREEN', stored phase 'RED' -> 'red', NEVER 'green'", () => {
    const result = AppLogic.agentRole({ agentId: "some-agent-suffix-GREEN", phase: "RED" });
    expect(result).toBe("red");
    expect(result).not.toBe("green");
  });

  test("a stored phase wins over the id even when the id does NOT match it: 'CR-CRU-041-C1-GREEN-bun' with stored phase 'GREEN' classifies GREEN (the id doesn't END in '-GREEN' so the old phaseRole fallback would have returned null here)", () => {
    // Sanity on the premise: phaseRole itself (unmodified) returns null for
    // this id, because the suffix regex requires the match at the very end
    // and this id ends in "-bun", not "-GREEN".
    expect(AppLogic.phaseRole("CR-CRU-041-C1-GREEN-bun")).toBeNull();
    expect(AppLogic.agentRole({ agentId: "CR-CRU-041-C1-GREEN-bun", phase: "GREEN" })).toBe("green");
  });

  test("stored phase 'FIX' wins over an id containing a 'verify' segment — never 'verify'", () => {
    const result = AppLogic.agentRole({ agentId: "agent-verify-runner", phase: "FIX" });
    expect(result).toBe("fix");
    expect(result).not.toBe("verify");
  });

  test("enum -> role mapping is pinned exactly: RED/GREEN/FIX/VERIFY map to the existing lowercase role vocabulary", () => {
    expect(AppLogic.agentRole({ agentId: "any-id", phase: "RED" })).toBe("red");
    expect(AppLogic.agentRole({ agentId: "any-id", phase: "GREEN" })).toBe("green");
    expect(AppLogic.agentRole({ agentId: "any-id", phase: "FIX" })).toBe("fix");
    expect(AppLogic.agentRole({ agentId: "any-id", phase: "VERIFY" })).toBe("verify");
  });

  test("enum -> role mapping is pinned exactly: 'ORCHESTRATOR' and 'report' render with NO role tint (null) — the existing 4-role vocabulary has no color for them", () => {
    expect(AppLogic.agentRole({ agentId: "any-id", phase: "ORCHESTRATOR" })).toBeNull();
    expect(AppLogic.agentRole({ agentId: "any-id", phase: "report" })).toBeNull();
    // NEGATIVE bound: an id-shape that WOULD resolve a role via the fallback
    // must NOT leak through — the stored (if unmapped) value still wins.
    expect(AppLogic.agentRole({ agentId: "some-agent-suffix-RED", phase: "ORCHESTRATOR" })).toBeNull();
    expect(AppLogic.agentRole({ agentId: "some-agent-suffix-RED", phase: "report" })).toBeNull();
  });

  test("precedence bound: a PRESENT but unrecognized stored phase value still does NOT fall back to phaseRole(agentId) — present beats absent, even when unmapped", () => {
    // A stored phase is only ever one of the server's validated enum values
    // in practice (C1 rejects anything else at registration), but the
    // precedence rule the spec pins ("phaseRole is consulted ONLY when the
    // stored phase is absent") must hold even for this defensive case: the
    // value is PRESENT, so the id-based fallback must never fire.
    const result = AppLogic.agentRole({ agentId: "some-agent-suffix-RED", phase: "banana" as unknown as string });
    expect(result).not.toBe("red");
    expect(result).toBeNull();
  });

  test("fallback: phase absent (key omitted, i.e. undefined) classifies via phaseRole(agentId) exactly as today", () => {
    expect(AppLogic.agentRole({ agentId: "CR-X-1-RED" })).toBe("red");
    expect(AppLogic.agentRole({ agentId: "CR-X-1-GREEN" })).toBe("green");
    expect(AppLogic.agentRole({ agentId: "CR-X-1-FIX" })).toBe("fix");
    expect(AppLogic.agentRole({ agentId: "verify-agent" })).toBe("verify");
    expect(AppLogic.agentRole({ agentId: "plain-agent-1" })).toBeNull();
  });

  test("fallback: phase explicitly null (the shape a legacy/pre-CR-044 row round-trips as, per agent-phase.test.ts §S1(d)) classifies via phaseRole(agentId) exactly as today", () => {
    expect(AppLogic.agentRole({ agentId: "CR-X-1-GREEN", phase: null })).toBe("green");
    expect(AppLogic.agentRole({ agentId: "plain-agent-1", phase: null })).toBeNull();
  });

  test("bound: fallback path is byte-for-byte phaseRole's own precise contract — a 'verify' SEGMENT match (not substring) still applies through agentRole when phase is absent", () => {
    expect(AppLogic.agentRole({ agentId: "unverified-agent" })).toBeNull();
    expect(AppLogic.agentRole({ agentId: "redteam-agent" })).toBeNull();
  });
});

// ── DOM integration: EventCard classification reads the STORED agent phase ──

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
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
  liveness?: "online" | "stale" | "tombstoned";
  lastSeen?: number;
  message?: string;
  identity?: { displayName?: string };
  phase?: string | null;
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
  events: EventFixture[];
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/agent-runtime-pane.test.ts, extended
 * with an `agents` fixture list (phase-role.test.ts's harness hardcodes
 * `agents: []`, which cannot exercise the stored-phase lookup this file needs). */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: opts.agents };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: opts.events };
    else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`agent-role.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?agentRole=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const ROLE_CLASSES = ["app-role-red", "app-role-green", "app-role-verify", "app-role-fix"];

function baseEvent(id: string, agentId: string, projectKey: string, timestamp: number): EventFixture {
  return {
    id,
    projectKey,
    agentId,
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp,
    total: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
  };
}

function baseAgent(agentId: string, projectKey: string, phase: string | null | undefined): AgentFixture {
  return {
    agentId,
    projectKey,
    status: "online",
    liveness: "online",
    lastSeen: Date.now(),
    identity: { displayName: agentId },
    phase,
  };
}

function iconClassFor(agentId: string): string {
  const cards = document.querySelectorAll('[data-testid="event-card"]');
  const card = Array.from(cards).find((c) => (c.textContent ?? "").includes(agentId));
  expect(card).toBeDefined();
  const icon = card!.querySelector('[data-testid="card-icon"]');
  expect(icon).not.toBeNull();
  return icon!.className;
}

function assertOnlyRole(agentId: string, expectedClass: string | null): void {
  const cls = iconClassFor(agentId);
  if (expectedClass !== null) {
    expect(cls).toMatch(new RegExp(`\\b${expectedClass}\\b`));
  }
  for (const roleClass of ROLE_CLASSES) {
    if (roleClass !== expectedClass) {
      expect(cls).not.toMatch(new RegExp(`\\b${roleClass}\\b`));
    }
  }
}

describe("CR-CRU-044 §S2 — the event feed classifies by the agent's STORED phase, not the agentId shape", () => {
  test("the defect's regression test: an event whose owning agent is registered with '--phase GREEN' but an id NOT ending '-GREEN' renders app-role-green on the card icon", async () => {
    const now = Date.now();
    const projectKey = "proj-stored-phase-1";
    const agentId = "CR-CRU-041-C1-GREEN-bun";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Stored Phase", type: "backend", agentsOnline: 1, agentsTotal: 1, active: true, lastActivity: now },
      ],
      agents: [baseAgent(agentId, projectKey, "GREEN")],
      events: [baseEvent("evt-stored-1", agentId, projectKey, now)],
    });

    assertOnlyRole(agentId, "app-role-green");
  });

  test("the sharper regression case: an event whose owning agent's id ENDS in '-GREEN' but whose STORED phase is 'RED' renders app-role-red, NEVER app-role-green — the label must not override the declaration", async () => {
    const now = Date.now();
    const projectKey = "proj-stored-phase-2";
    const agentId = "some-agent-suffix-GREEN";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Stored Phase Override", type: "backend", agentsOnline: 1, agentsTotal: 1, active: true, lastActivity: now },
      ],
      agents: [baseAgent(agentId, projectKey, "RED")],
      events: [baseEvent("evt-stored-2", agentId, projectKey, now)],
    });

    assertOnlyRole(agentId, "app-role-red");
  });

  test("fallback for history: an agent record with NO stored phase (phase: null, the pre-CR-044 shape) still classifies via the phaseRole(agentId) suffix exactly as today — no visual regression, no back-fill", async () => {
    const now = Date.now();
    const projectKey = "proj-stored-phase-3";
    const agentId = "CR-X-1-RED";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Legacy Fallback", type: "backend", agentsOnline: 1, agentsTotal: 1, active: true, lastActivity: now },
      ],
      agents: [baseAgent(agentId, projectKey, null)],
      events: [baseEvent("evt-stored-3", agentId, projectKey, now)],
    });

    assertOnlyRole(agentId, "app-role-red");
  });

  test("fallback for an event whose agentId matches NO current agent record (e.g. a tombstoned/removed agent) still classifies via phaseRole(agentId) — an absent record is treated the same as an absent phase", async () => {
    const now = Date.now();
    const projectKey = "proj-stored-phase-4";
    const agentId = "CR-X-1-VERIFY";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "No Agent Record", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      agents: [],
      events: [baseEvent("evt-stored-4", agentId, projectKey, now)],
    });

    assertOnlyRole(agentId, "app-role-verify");
  });

  test("an agent stored with phase 'ORCHESTRATOR' renders with NO role class on its card icon (neutral), even though its id contains a '-VERIFY'-shaped segment nowhere — pins the no-tint decision at the DOM level too", async () => {
    const now = Date.now();
    const projectKey = "proj-stored-phase-5";
    const agentId = "orchestrator-agent-1";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Orchestrator Neutral", type: "backend", agentsOnline: 1, agentsTotal: 1, active: true, lastActivity: now },
      ],
      agents: [baseAgent(agentId, projectKey, "ORCHESTRATOR")],
      events: [baseEvent("evt-stored-5", agentId, projectKey, now)],
    });

    assertOnlyRole(agentId, null);
  });
});
