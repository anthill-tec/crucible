// The four brief-answered reads — the recent feed, a cycle's runs,
// `/status`, and the projects list's newest event — must stay byte-identical
// once a read stops hydrating each run's tree/raw. This file pins that
// contract as LITERAL JSON: every expected brief below is a hard-coded
// object, written out field by field from the fixture's own deterministic
// values. Nothing here re-derives a brief through code that mirrors
// `eventBrief` (src/v2.ts), so a drift in `eventBrief` — a field dropped,
// renamed, re-typed, or added — fails here instead of moving in lockstep
// with a mirror of itself.
//
// Determinism: the store stamps every event's `timestamp` and `id`
// (`evt-<Date.now()>-<per-store sequence>`) from the clock, so each event is
// recorded under a frozen clock (`setSystemTime`) at its own whole-second
// instant after a fixed epoch, and each test boots its own store so the
// sequence starts from 1. Project keys are fixed strings. No value in an
// expected brief is a placeholder.
//
// Each test also asserts the answer carries no `tree`/`raw` key anywhere a
// brief appears — the thing a later "optimization" that leaks a run's detail
// back into a list read would break.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import type { SuiteNode } from "../src/types.ts";
import type { CompileReport } from "../src/codecs/compile.ts";

let handle: ServerHandle | undefined;

afterEach(() => {
  setSystemTime();
  handle?.stop();
  handle = undefined;
});

/** 2025-01-01T00:00:00.000Z — the fixed epoch every fixture instant counts from. */
const EPOCH_MS = 1_735_689_600_000;

/** Freeze the clock `seconds` whole seconds after the fixed epoch. */
function clockAt(seconds: number): void {
  setSystemTime(EPOCH_MS + seconds * 1_000);
}

function boot(): ServerHandle {
  clockAt(0);
  handle = startServer({ port: 0, dbPath: ":memory:" });
  return handle;
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${handle!.server.port}${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function smallTree(): SuiteNode[] {
  return [{ name: "OnlySuite", status: "pass", children: [{ name: "c1", status: "pass", duration_ms: 3 }] }];
}

const COMPILE_REPORT: CompileReport = {
  format: "tsc",
  errorCount: 2,
  warningCount: 1,
  diagnostics: [
    { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
    { file: "src/b.ts", line: 2, col: 5, code: "TS2304", message: "Cannot find name 'y'.", level: "error" },
    {
      file: "src/c.ts",
      line: 3,
      col: 9,
      code: "TS6133",
      message: "'z' is declared but never used.",
      level: "warning",
    },
  ],
  raw: "tsc raw tail",
};

function expectNoDetailKeys(brief: Record<string, unknown>): void {
  expect("tree" in brief).toBe(false);
  expect("raw" in brief).toBe(false);
}

describe("the recent feed's briefs are byte-identical and carry no tree/raw key", () => {
  test("a test run, a compile run, a sealed gate with decisions, a milestone and lifecycle events each answer their literal brief", async () => {
    boot();
    const store = handle!.store;
    const key = "recent-feed-project";
    store.addProject({ key, name: "list-byte-identity", type: "backend", sutRoot: "/tmp/p" });

    clockAt(1);
    store.recordTestEvent(
      key,
      "test-agent",
      {
        summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 321 },
        tree: smallTree(),
        raw: "full captured run tail",
        coverage: { lines: { total: 300, covered: 225, percent: 75 } },
      },
      {},
    );
    clockAt(2);
    store.recordCompileEvent(key, "compile-agent", COMPILE_REPORT, {});
    clockAt(3);
    const gate = { outcome: "passed", steps: [{ name: "review", status: "passed", findings: 5 }], run: { id: "run-byte-gate-1" } };
    store.recordGateEvent(key, "gate-agent", gate, {});
    // The two decisions take sequence numbers 4 and 5 but are not feed rows.
    clockAt(4);
    store.recordGateDecision(key, "gate-agent", {
      runId: "run-byte-gate-1",
      action: "fix",
      step: "review",
      findings: ["f1", "f2"],
    });
    clockAt(5);
    store.recordGateDecision(key, "gate-agent", {
      runId: "run-byte-gate-1",
      action: "approve",
      step: "review",
      reason: "looks good",
    });
    clockAt(6);
    store.recordMilestoneEvent(key, "milestone-agent", "narrative-milestone", { label: "Wave complete" });
    clockAt(7);
    store.recordLifecycleEvent(key, "watcher-agent", "registered", 1_735_689_607_000);
    clockAt(8);
    store.recordLifecycleEvent(key, "watcher-agent", "unregistered", 1_735_689_607_000);
    clockAt(9);

    const body = await getJson(`/api/v2/events?project=${key}&limit=20`);
    const events = body.events as Array<Record<string, unknown>>;

    // Newest-first, exactly the recording order reversed.
    expect(events).toEqual([
      {
        id: "evt-1735689608000-8",
        projectKey: "recent-feed-project",
        agentId: "watcher-agent",
        kind: "lifecycle",
        tier: "unit",
        timestamp: 1_735_689_608_000,
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        duration_ms: 0,
        hasCoverage: false,
        action: "unregistered",
        firstSeen: 1_735_689_607_000,
      },
      {
        id: "evt-1735689607000-7",
        projectKey: "recent-feed-project",
        agentId: "watcher-agent",
        kind: "lifecycle",
        tier: "unit",
        timestamp: 1_735_689_607_000,
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        duration_ms: 0,
        hasCoverage: false,
        action: "registered",
        firstSeen: 1_735_689_607_000,
      },
      {
        id: "evt-1735689606000-6",
        projectKey: "recent-feed-project",
        agentId: "milestone-agent",
        kind: "milestone",
        tier: "unit",
        timestamp: 1_735_689_606_000,
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        duration_ms: 0,
        hasCoverage: false,
        type: "narrative-milestone",
        label: "Wave complete",
      },
      {
        id: "evt-1735689603000-3",
        projectKey: "recent-feed-project",
        agentId: "gate-agent",
        kind: "gate",
        tier: "unit",
        codec: "no-mistakes",
        timestamp: 1_735_689_603_000,
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        duration_ms: 0,
        hasCoverage: false,
        gate: {
          outcome: "passed",
          steps: [{ name: "review", status: "passed", findings: 5 }],
          run: { id: "run-byte-gate-1" },
        },
        // 2 decisions; f1+f2 fixed; none added; the approved step's 5
        // findings less the 2 fixed = 3 declined; 1 approve with a reason.
        decisionSummary: { decisions: 2, fixed: 2, added: 0, declined: 3, approvedWithReason: 1 },
      },
      {
        id: "evt-1735689602000-2",
        projectKey: "recent-feed-project",
        agentId: "compile-agent",
        kind: "compile",
        tier: "unit",
        timestamp: 1_735_689_602_000,
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        duration_ms: 0,
        hasCoverage: false,
        errors: 2,
        warnings: 1,
        diagnostics: [
          { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
          { file: "src/b.ts", line: 2, col: 5, code: "TS2304", message: "Cannot find name 'y'.", level: "error" },
        ],
      },
      {
        id: "evt-1735689601000-1",
        projectKey: "recent-feed-project",
        agentId: "test-agent",
        kind: "test",
        tier: "unit",
        timestamp: 1_735_689_601_000,
        total: 5,
        passed: 5,
        failed: 0,
        pending: 0,
        duration_ms: 321,
        hasCoverage: true,
        coverageLines: 75,
      },
    ]);

    for (const brief of events) expectNoDetailKeys(brief);
  });
});

describe("a cycle's runs are byte-identical and carry no tree/raw key", () => {
  test("a tree+raw test run and a 3-diagnostic compile run bound to the same cycle each answer their literal brief", async () => {
    boot();
    const store = handle!.store;
    const key = "cycle-runs-project";
    store.addProject({ key, name: "cycle-byte-identity", type: "backend", sutRoot: "/tmp/p" });
    const cycleId = 9009;

    clockAt(10);
    store.recordTestEvent(
      key,
      "test-agent",
      {
        summary: { total: 4, passed: 3, failed: 1, pending: 0, duration_ms: 77 },
        tree: smallTree(),
        raw: "full captured run tail",
      },
      { context: { cycleId } },
    );
    clockAt(11);
    store.recordCompileEvent(key, "compile-agent", COMPILE_REPORT, { context: { cycleId } });
    clockAt(12);

    const body = await getJson(`/api/v2/events?project=${key}&cycleId=${cycleId}`);
    const events = body.events as Array<Record<string, unknown>>;

    expect(events).toEqual([
      {
        id: "evt-1735689611000-2",
        projectKey: "cycle-runs-project",
        agentId: "compile-agent",
        kind: "compile",
        tier: "unit",
        timestamp: 1_735_689_611_000,
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        duration_ms: 0,
        hasCoverage: false,
        context: { cycleId: 9009 },
        cycleId: 9009,
        errors: 2,
        warnings: 1,
        diagnostics: [
          { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
          { file: "src/b.ts", line: 2, col: 5, code: "TS2304", message: "Cannot find name 'y'.", level: "error" },
        ],
      },
      {
        id: "evt-1735689610000-1",
        projectKey: "cycle-runs-project",
        agentId: "test-agent",
        kind: "test",
        tier: "unit",
        timestamp: 1_735_689_610_000,
        total: 4,
        passed: 3,
        failed: 1,
        pending: 0,
        duration_ms: 77,
        hasCoverage: false,
        context: { cycleId: 9009 },
        cycleId: 9009,
      },
    ]);
    for (const brief of events) expectNoDetailKeys(brief);
  });
});

describe("/api/v2/status's briefs are byte-identical and carry no tree/raw key", () => {
  test("the newest test run and the newest compile run each answer their literal brief", async () => {
    boot();
    const store = handle!.store;
    const key = "status-project";
    store.addProject({ key, name: "status-byte-identity", type: "backend", sutRoot: "/tmp/p" });

    clockAt(13);
    store.recordTestEvent(
      key,
      "test-agent",
      {
        summary: { total: 8, passed: 8, failed: 0, pending: 0, duration_ms: 55 },
        tree: smallTree(),
        raw: "full captured run tail",
        coverage: { lines: { total: 100, covered: 90, percent: 90 } },
      },
      {},
    );
    clockAt(14);
    store.recordCompileEvent(key, "compile-agent", COMPILE_REPORT, {});
    clockAt(15);

    const body = await getJson(`/api/v2/status?project=${key}`);
    const status = body.status as { hasData: boolean; lastTest: unknown; lastCompile: unknown };

    expect(status.hasData).toBe(true);
    expect(status.lastTest).toEqual({
      id: "evt-1735689613000-1",
      projectKey: "status-project",
      agentId: "test-agent",
      kind: "test",
      tier: "unit",
      timestamp: 1_735_689_613_000,
      total: 8,
      passed: 8,
      failed: 0,
      pending: 0,
      duration_ms: 55,
      hasCoverage: true,
      coverageLines: 90,
    });
    expect(status.lastCompile).toEqual({
      id: "evt-1735689614000-2",
      projectKey: "status-project",
      agentId: "compile-agent",
      kind: "compile",
      tier: "unit",
      timestamp: 1_735_689_614_000,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      duration_ms: 0,
      hasCoverage: false,
      errors: 2,
      warnings: 1,
      diagnostics: [
        { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
        { file: "src/b.ts", line: 2, col: 5, code: "TS2304", message: "Cannot find name 'y'.", level: "error" },
      ],
    });
    expectNoDetailKeys(status.lastTest as Record<string, unknown>);
    expectNoDetailKeys(status.lastCompile as Record<string, unknown>);
  });
});

describe("the projects list's lastEvent brief is byte-identical and carries no tree/raw key", () => {
  test("a project whose newest event is a milestone, behind an earlier tree+raw+coverage test run, answers the milestone's literal brief", async () => {
    boot();
    const store = handle!.store;
    const key = "projects-list-project";
    store.addProject({ key, name: "projects-byte-identity", type: "backend", sutRoot: "/tmp/p" });

    clockAt(16);
    store.recordTestEvent(
      key,
      "test-agent",
      {
        summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 12 },
        tree: smallTree(),
        raw: "full captured run tail",
        coverage: { lines: { total: 40, covered: 20, percent: 50 } },
      },
      {},
    );
    clockAt(17);
    store.recordMilestoneEvent(key, "milestone-agent", "narrative-milestone", { label: "Wave complete" });
    clockAt(18);

    const body = await getJson(`/api/v2/projects`);
    const projects = body.projects as Array<Record<string, unknown>>;
    const project = projects.find((p) => p.key === key)!;

    expect(project.lastEvent).toEqual({
      id: "evt-1735689617000-2",
      projectKey: "projects-list-project",
      agentId: "milestone-agent",
      kind: "milestone",
      tier: "unit",
      timestamp: 1_735_689_617_000,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      duration_ms: 0,
      hasCoverage: false,
      type: "narrative-milestone",
      label: "Wave complete",
    });
    expectNoDetailKeys(project.lastEvent as Record<string, unknown>);
  });
});
