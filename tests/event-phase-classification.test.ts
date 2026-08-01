// CR-CRU-057 §S2/§S3 — Classification reads the STORED EVENT phase only;
// the phaseRole(agentId) name-parsing fallback is swept from src/ public/
// cli/ entirely.
//
// Context: CR-CRU-044 made `phase` a required, enum-constrained
// REGISTRATION field, but stored it ONLY on the live `agents` row —
// `unregister` deletes that row, so the moment an agent finishes (the
// state most of the board is in, most of the time) classification fell
// back to `phaseRole(agentId)` NAME parsing. CR-CRU-057 §S1 (already
// landed — tests/event-phase-stamping.test.ts) closed that at the SERVER:
// every run/lifecycle event now carries the agent's declared `phase` (+
// `phaseInferred`) stamped at ingest time, through CR-CRU-056's existing
// `resolveIngestAttach` seam, surviving the posting agent's
// unregistration.
//
// This file is §S2 at the CLIENT: the UI's classification entry point —
// `eventRole(e)`, a local function in public/app.js (defined once at
// app.js:694, called from all three EventCard render sites) via
// `L.agentRole({ agentId, phase })` — must read the EVENT's own stored
// `phase` for the historical/unregistered-agent case (no matching
// `state.agents` record), never fall back to phaseRole(agentId) id-shape
// parsing. §S3 deletes phaseRole outright; test (2) below is the
// assertion that proves that deletion is safe (an id-shape that WOULD
// have parsed classifies null when nothing declares a phase for it).
//
// RED phase: `eventRole` (public/app.js:694-698) currently derives `phase`
// SOLELY from `state.agents.find((a) => a.agentId === e.agentId)?.phase` —
// a LIVE agent-record lookup. It never reads `e.phase` at all, and
// `agentRole`'s absent-phase branch still falls back to
// `phaseRole(agentId)` (CR-CRU-007 era). So every assertion below that
// depends on the EVENT's own stored phase winning, or on the fallback
// being GONE, fails today.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

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
  // CR-CRU-057 §S1 — stamped server-side at ingest; §S2 is the ONLY
  // classification input for the historical/no-live-agent-record case.
  phase?: string | null;
  phaseInferred?: boolean;
}

interface AgentFixture {
  agentId: string;
  projectKey: string;
  status?: "online" | "busy";
  liveness?: "online" | "stale" | "tombstoned";
  lastSeen?: number;
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

/** Same mountApp harness pattern as tests/agent-role.test.ts. */
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
    } else throw new Error(`event-phase-classification.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?eventPhaseClassification=${cacheBust}`);

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

function iconFor(agentId: string): Element {
  const cards = document.querySelectorAll('[data-testid="event-card"]');
  const card = Array.from(cards).find((c) => (c.textContent ?? "").includes(agentId));
  expect(card).toBeDefined();
  const icon = card!.querySelector('[data-testid="card-icon"]');
  expect(icon).not.toBeNull();
  return icon!;
}

function assertOnlyRole(agentId: string, expectedClass: string | null): void {
  const cls = iconFor(agentId).className;
  if (expectedClass !== null) {
    expect(cls).toMatch(new RegExp(`\\b${expectedClass}\\b`));
  }
  for (const roleClass of ROLE_CLASSES) {
    if (roleClass !== expectedClass) {
      expect(cls).not.toMatch(new RegExp(`\\b${roleClass}\\b`));
    }
  }
}

describe("CR-CRU-057 §S2 — event classification reads the STORED event.phase, no agent record required", () => {
  test("an event carrying a stored phase classifies by THAT phase with NO agent record at all (the historical/unregistered case) — id says '-GREEN', event.phase says 'RED' -> renders red, never green", async () => {
    const now = Date.now();
    const projectKey = "proj-event-phase-1";
    // Id shape WOULD parse to "green" via the (dying) name-based fallback.
    const agentId = "some-agent-suffix-GREEN";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Event Phase 1", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      agents: [], // no agent record whatsoever — the agent is long gone
      events: [{ ...baseEvent("evt-ephase-1", agentId, projectKey, now), phase: "RED" }],
    });

    assertOnlyRole(agentId, "app-role-red");
  });

  // The assertion that kills the fallback: an id-shape that WOULD have
  // parsed under the old phaseRole contract must NOT leak through once
  // there is simply no declared phase to classify by.
  test("an event with NO stored phase and NO agent record classifies UNCLASSIFIED (null) — it must NOT fall back to parsing the id, even when the id WOULD have parsed: 'CR-X-1-RED'", async () => {
    const now = Date.now();
    const projectKey = "proj-event-phase-2";
    const agentId = "CR-X-1-RED";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Event Phase 2", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      agents: [],
      events: [baseEvent("evt-ephase-2", agentId, projectKey, now)], // no `phase` key at all
    });

    assertOnlyRole(agentId, null);
  });

  test("a stored phase that DISAGREES with the id wins: id ends '-RED', stored phase is 'report' -> neutral (no role tint, matching the existing report->null mapping), never app-role-red", async () => {
    const now = Date.now();
    const projectKey = "proj-event-phase-3";
    // Shaped exactly like the CR-CRU-046 stray-id failure mode this CR closes.
    const agentId = "widget-99-bun-RED";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Event Phase 3", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      agents: [],
      events: [{ ...baseEvent("evt-ephase-3", agentId, projectKey, now), phase: "report" }],
    });

    assertOnlyRole(agentId, null);
  });

  test('phaseInferred:true events classify by their stored phase but are DOM-distinguishable as inferred (§S4 backfill marker) — data-phase-inferred="true" on the tinted icon, alongside the normal role class', async () => {
    const now = Date.now();
    const projectKey = "proj-event-phase-4";
    // Does not parse via id shape at all — proves the classification came
    // from the stored (inferred) phase, not a name-derived guess.
    const agentId = "backfilled-history-1";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Event Phase 4", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      agents: [],
      events: [{ ...baseEvent("evt-ephase-4", agentId, projectKey, now), phase: "GREEN", phaseInferred: true }],
    });

    assertOnlyRole(agentId, "app-role-green");
    const icon = iconFor(agentId);
    // POSITIVE — the inferred marker is present and reads exactly "true".
    expect(icon.getAttribute("data-phase-inferred")).toBe("true");
  });

  test('bound: a DECLARED (non-inferred) event does NOT carry data-phase-inferred="true" — the marker is exclusive to backfilled rows, never leaking onto declared data', async () => {
    const now = Date.now();
    const projectKey = "proj-event-phase-5";
    const agentId = "declared-history-1";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Event Phase 5", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      agents: [],
      events: [{ ...baseEvent("evt-ephase-5", agentId, projectKey, now), phase: "VERIFY", phaseInferred: false }],
    });

    assertOnlyRole(agentId, "app-role-verify");
    const icon = iconFor(agentId);
    // NEGATIVE bound — explicit false must not render as the marker string.
    expect(icon.getAttribute("data-phase-inferred")).not.toBe("true");
  });
});

// CR-CRU-057 §S3 — DELETE phaseRole(agentId): the function and every
// reference to it are removed from src/, public/, and cli/ (tests may keep
// retirement-assertion references only — the CR-CRU-056 BANNED_NAMES
// sweep style: "grep -rn 'phaseRole' src/ public/ cli/ finds nothing").
describe("CR-CRU-057 §S3 — phaseRole is swept from src/ public/ cli/ entirely (sweep, CR-CRU-056 BANNED_NAMES style)", () => {
  const SWEEP_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
  const SWEEP_SKIP_DIRS = new Set(["node_modules", "vendor", "coverage", ".git"]);
  const BANNED_NAMES = ["phaseRole"];

  function collectFiles(dir: string): string[] {
    const out: string[] = [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SWEEP_SKIP_DIRS.has(entry.name)) continue;
        out.push(...collectFiles(full));
      } else if (SWEEP_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
    return out;
  }

  test("no file under src/, public/, or cli/ contains the string 'phaseRole' anywhere — the retired name-parsing fallback cannot return", () => {
    const roots = ["src", "public", "cli"].map((d) => path.join(REPO_ROOT, d));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of collectFiles(root)) {
        const src = readFileSync(file, "utf8");
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          for (const banned of BANNED_NAMES) {
            if (lines[i]!.includes(banned)) {
              offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}`);
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
