// CR-CRU-007 §S2 — RED→GREEN transition markers (= Cycles): same projectKey
// + same agent stem (agentId with a trailing -RED|-GREEN|-FIX suffix
// stripped, case-insensitive) — a failing test run followed by a passing
// test run within 24h renders one marker row above the pair; pass-then-pass,
// different stems, or >24h apart render none. Marker click opens the GREEN
// run's drill-in (route `/run/<greenEventId>`).
//
// Two layers: (1) `pairTransitions` as a pure function in app-logic.mjs
// (`pairTransitions` does not exist yet — GREEN adds it; a namespace import
// stays loadable for not-yet-exported names, so `AppLogic.pairTransitions`
// fails at CALL time, "is not a function" — the missing-export RED signal,
// same technique tests/app-logic.test.ts uses for projectActivity/
// orderProjects). (2) DOM render against the REAL public/app.js shell inside
// a happy-dom window — same mountApp harness pattern as
// tests/shell-final-form.test.ts (idempotent register since ec6fe6d).
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

interface TestEventLike {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

function testEvent(overrides: Partial<TestEventLike> & Pick<TestEventLike, "id" | "agentId" | "timestamp">): TestEventLike {
  return {
    projectKey: "proj-x",
    kind: "test",
    total: 5,
    passed: 5,
    failed: 0,
    pending: 0,
    ...overrides,
  };
}

describe("pairTransitions — pure pairing logic (§S2)", () => {
  test("same projectKey + same agent stem, fail(2/5) then pass(5/5) within 24h → exactly one marker", () => {
    const t0 = Date.now();
    const redEvt = testEvent({
      id: "e-red",
      agentId: "CR-X-1-RED",
      timestamp: t0,
      total: 5,
      passed: 3,
      failed: 2,
    });
    const greenEvt = testEvent({
      id: "e-green",
      agentId: "CR-X-1-GREEN",
      timestamp: t0 + 60 * 60 * 1000, // 1h later
      total: 5,
      passed: 5,
      failed: 0,
    });

    const markers = (AppLogic as unknown as {
      pairTransitions: (events: TestEventLike[]) => Array<{
        redEvent: TestEventLike;
        greenEvent: TestEventLike;
        projectKey: string;
        stem: string;
      }>;
    }).pairTransitions([redEvt, greenEvt]);

    expect(markers.length).toBe(1);
    expect(markers[0]!.redEvent.id).toBe("e-red");
    expect(markers[0]!.greenEvent.id).toBe("e-green");
    expect(markers[0]!.projectKey).toBe("proj-x");
    expect(markers[0]!.stem).toBe("CR-X-1");
  });

  test("pass-then-pass same stem → no marker", () => {
    const t0 = Date.now();
    const pass1 = testEvent({ id: "e-pass-1", agentId: "CR-Y-1-GREEN", timestamp: t0 });
    const pass2 = testEvent({ id: "e-pass-2", agentId: "CR-Y-1-GREEN", timestamp: t0 + 1000 });

    const markers = (AppLogic as unknown as {
      pairTransitions: (events: TestEventLike[]) => unknown[];
    }).pairTransitions([pass1, pass2]);

    expect(markers.length).toBe(0);
  });

  test("fail-then-pass with DIFFERENT stems → no marker", () => {
    const t0 = Date.now();
    const redEvt = testEvent({
      id: "e-diff-red",
      agentId: "CR-Y-1-RED",
      timestamp: t0,
      total: 4,
      passed: 2,
      failed: 2,
    });
    const greenEvt = testEvent({
      id: "e-diff-green",
      agentId: "CR-Z-1-GREEN",
      timestamp: t0 + 1000,
      total: 4,
      passed: 4,
      failed: 0,
    });

    const markers = (AppLogic as unknown as {
      pairTransitions: (events: TestEventLike[]) => unknown[];
    }).pairTransitions([redEvt, greenEvt]);

    expect(markers.length).toBe(0);
  });

  test(">24h apart → no marker", () => {
    const t0 = Date.now();
    const redEvt = testEvent({
      id: "e-stale-red",
      agentId: "CR-W-1-RED",
      timestamp: t0,
      total: 3,
      passed: 1,
      failed: 2,
    });
    const greenEvt = testEvent({
      id: "e-stale-green",
      agentId: "CR-W-1-GREEN",
      timestamp: t0 + 25 * 60 * 60 * 1000, // 25h later
      total: 3,
      passed: 3,
      failed: 0,
    });

    const markers = (AppLogic as unknown as {
      pairTransitions: (events: TestEventLike[]) => unknown[];
    }).pairTransitions([redEvt, greenEvt]);

    expect(markers.length).toBe(0);
  });

  test("agent-stem matching is case-insensitive", () => {
    const t0 = Date.now();
    const redEvt = testEvent({
      id: "e-ci-red",
      agentId: "cr-x-1-red",
      timestamp: t0,
      total: 5,
      passed: 3,
      failed: 2,
    });
    const greenEvt = testEvent({
      id: "e-ci-green",
      agentId: "CR-x-1-GREEN",
      timestamp: t0 + 1000,
      total: 5,
      passed: 5,
      failed: 0,
    });

    const markers = (AppLogic as unknown as {
      pairTransitions: (events: TestEventLike[]) => unknown[];
    }).pairTransitions([redEvt, greenEvt]);

    expect(markers.length).toBe(1);
  });
});

// ── DOM render (mountApp harness — same pattern as shell-final-form.test.ts) ─

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

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  context?: { cycle?: string };
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
  projects?: ProjectFixture[];
  events?: EventFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: opts.events ?? [] };
    else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`transition-markers.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?transitionMarkers=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  // Guarded: the pure-logic `describe` above never calls mountApp/registers
  // Happy DOM, so an unconditional unregister() would throw for those tests.
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

describe("§S2 AC2 — transition marker render + navigation", () => {
  test("fail(2/5) as CR-X-1-RED then pass(5/5) as CR-X-1-GREEN renders exactly one marker row 'RED 2/5 ➜ GREEN 5/5' with a duration; context.cycle adds a Cycle: segment; click navigates to /run/<greenEventId>", async () => {
    const t0 = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    const redId = "evt-cycle-red";
    const greenId = "evt-cycle-green";
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-cycle",
          name: "Cycle Proj",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: t0,
        },
      ],
      events: [
        {
          id: redId,
          projectKey: "proj-cycle",
          agentId: "CR-X-1-RED",
          kind: "test",
          tier: "unit",
          timestamp: t0,
          total: 5,
          passed: 3,
          failed: 2,
          pending: 0,
          duration_ms: 1000,
          hasCoverage: false,
        },
        {
          id: greenId,
          projectKey: "proj-cycle",
          agentId: "CR-X-1-GREEN",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 45_000, // 45s after RED
          total: 5,
          passed: 5,
          failed: 0,
          pending: 0,
          duration_ms: 1200,
          hasCoverage: false,
          context: { cycle: "checkpoint persistence" },
        },
      ],
    });

    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(1);

    const markerText = markers[0]!.textContent ?? "";
    expect(markerText).toContain("RED 2/5 ➜ GREEN 5/5");
    expect(markerText).toMatch(/closed in \d+s/);
    expect(markerText).toContain('Cycle: "checkpoint persistence"');

    (markers[0] as HTMLElement).click();
    await settle();

    expect(location.pathname).toBe(`/run/${greenId}`);
  });

  test("without context.cycle on the GREEN run, the marker renders no 'Cycle:' segment", async () => {
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    await mountApp({
      pathname: "/",
      projects: [
        {
          key: "proj-cycle-2",
          name: "Cycle Proj 2",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: t0,
        },
      ],
      events: [
        {
          id: "evt-nc-red",
          projectKey: "proj-cycle-2",
          agentId: "CR-Y-1-RED",
          kind: "test",
          tier: "unit",
          timestamp: t0,
          total: 4,
          passed: 2,
          failed: 2,
          pending: 0,
          duration_ms: 800,
          hasCoverage: false,
        },
        {
          id: "evt-nc-green",
          projectKey: "proj-cycle-2",
          agentId: "CR-Y-1-GREEN",
          kind: "test",
          tier: "unit",
          timestamp: t0 + 30_000,
          total: 4,
          passed: 4,
          failed: 0,
          pending: 0,
          duration_ms: 900,
          hasCoverage: false,
        },
      ],
    });

    const markers = document.querySelectorAll('[data-testid="transition-marker"]');
    expect(markers.length).toBe(1);
    expect(markers[0]!.textContent ?? "").not.toContain("Cycle:");
  });
});
