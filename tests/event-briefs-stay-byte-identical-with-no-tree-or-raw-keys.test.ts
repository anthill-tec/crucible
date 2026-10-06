// AC2 — every one of the four brief-answered reads (the recent feed, a
// cycle's runs, `/status`, the projects list's newest event) must stay
// byte-identical to today's answer once the fix stops hydrating each run's
// tree/raw. This file pins that CONTRACT, independent of the current build's
// output: each expected brief below is hand-built from the fixture's own
// stored `RunEvent` (returned by the `Store.record*Event` calls that seeded
// it), following `eventBrief`'s documented field list (src/v2.ts) — never by
// reading today's live answer back and asserting it equals itself, which
// would stay green through any regression. Each test additionally asserts
// the answer carries no `tree`/`raw` key anywhere a brief appears — true
// today (`eventBrief` never had either) and the thing a later "optimization"
// that leaks one back in would break.
//
// These assertions are NOT expected to fail against current production: the
// detail-skipping change this CR drives is a READ-COST fix, not a shape
// change, so today's `eventBrief` output already matches what is built here.
// They exist as the byte-identity regression pin the AC requires, proved
// (per the RED report) both to fail if the shape ever drifted and to pass
// against a correct implementation.
import { afterEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import type { RunEvent, SuiteNode } from "../src/types.ts";
import type { CompileReport } from "../src/codecs/compile.ts";

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

function boot(): ServerHandle {
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

/**
 * An independent re-derivation of `eventBrief`'s documented field list
 * (src/v2.ts), from the fixture's own stored `RunEvent` — not a call into
 * production `eventBrief`, so this is a genuine pin rather than a tautology.
 */
function expectedBrief(event: RunEvent): Record<string, unknown> {
  const compile = event.kind === "compile" ? (event.compile as CompileReport | undefined) : undefined;
  return {
    id: event.id,
    projectKey: event.projectKey,
    agentId: event.agentId,
    kind: event.kind,
    tier: event.tier,
    codec: event.codec,
    timestamp: event.timestamp,
    total: event.summary?.total ?? 0,
    passed: event.summary?.passed ?? 0,
    failed: event.summary?.failed ?? 0,
    pending: event.summary?.pending ?? 0,
    duration_ms: event.summary?.duration_ms ?? 0,
    hasCoverage: !!event.coverage,
    ...(typeof event.coverage?.lines?.percent === "number"
      ? { coverageLines: event.coverage.lines.percent }
      : {}),
    ...(event.action !== undefined ? { action: event.action } : {}),
    ...(event.firstSeen !== undefined ? { firstSeen: event.firstSeen } : {}),
    ...(event.context !== undefined ? { context: event.context } : {}),
    ...(event.cycleId !== undefined ? { cycleId: event.cycleId } : {}),
    ...(event.role !== undefined ? { role: event.role, roleInferred: event.roleInferred === true } : {}),
    ...(event.gate !== undefined ? { gate: event.gate } : {}),
    ...(event.version !== undefined ? { version: event.version } : {}),
    ...(event.retiredAt !== undefined ? { retiredAt: event.retiredAt } : {}),
    ...(event.type !== undefined ? { type: event.type } : {}),
    ...(event.label !== undefined ? { label: event.label } : {}),
    ...(event.commit !== undefined ? { commit: event.commit } : {}),
    ...(compile !== undefined
      ? { errors: compile.errorCount, warnings: compile.warningCount, diagnostics: compile.diagnostics.slice(0, 2) }
      : {}),
    ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
    ...(event.runtimeMs !== undefined ? { runtime_ms: event.runtimeMs } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.abortReason !== undefined ? { abortReason: event.abortReason } : {}),
  };
}

function expectNoDetailKeys(brief: Record<string, unknown>): void {
  expect("tree" in brief).toBe(false);
  expect("raw" in brief).toBe(false);
}

describe("the recent feed's briefs are byte-identical and carry no tree/raw key", () => {
  test("a test run, a compile run, a sealed gate with decisions, a milestone and lifecycle events all match the documented eventBrief contract", async () => {
    boot();
    const store = handle!.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "list-byte-identity", type: "backend", sutRoot: "/tmp/p" });

    const testEvt = store.recordTestEvent(
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
    const compileEvt = store.recordCompileEvent(key, "compile-agent", COMPILE_REPORT, {});
    const gate = { outcome: "passed", steps: [{ name: "review", status: "passed", findings: 5 }], run: { id: "run-byte-gate-1" } };
    const gateEvt = store.recordGateEvent(key, "gate-agent", gate, {});
    store.recordGateDecision(key, "gate-agent", {
      runId: "run-byte-gate-1",
      action: "fix",
      step: "review",
      findings: ["f1", "f2"],
    });
    store.recordGateDecision(key, "gate-agent", {
      runId: "run-byte-gate-1",
      action: "approve",
      step: "review",
      reason: "looks good",
    });
    const milestoneResult = store.recordMilestoneEvent(key, "milestone-agent", "narrative-milestone", {
      label: "Wave complete",
    });
    const milestoneEvt = milestoneResult.event;
    const registeredAt = Date.now();
    const registeredEvt = store.recordLifecycleEvent(key, "watcher-agent", "registered", registeredAt);
    const unregisteredEvt = store.recordLifecycleEvent(key, "watcher-agent", "unregistered", registeredAt);

    const body = await getJson(`/api/v2/events?project=${key}&limit=20`);
    const events = body.events as Array<Record<string, unknown>>;
    expect(events.length).toBe(6);

    const expectedGateBrief = {
      ...expectedBrief(gateEvt),
      decisionSummary: { decisions: 2, fixed: 2, added: 0, declined: 3, approvedWithReason: 1 },
    };

    // Newest-first, exactly the insertion order reversed.
    expect(events).toEqual([
      expectedBrief(unregisteredEvt),
      expectedBrief(registeredEvt),
      expectedBrief(milestoneEvt),
      expectedGateBrief,
      expectedBrief(compileEvt),
      expectedBrief(testEvt),
    ]);

    for (const brief of events) expectNoDetailKeys(brief);
  });
});

describe("a cycle's runs are byte-identical and carry no tree/raw key", () => {
  test("a tree+raw test run and a 3-diagnostic compile run bound to the same cycle match the documented contract", async () => {
    boot();
    const store = handle!.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "cycle-byte-identity", type: "backend", sutRoot: "/tmp/p" });
    const cycleId = 9009;

    const testEvt = store.getEvent(
      store.recordTestEvent(
        key,
        "test-agent",
        {
          summary: { total: 4, passed: 3, failed: 1, pending: 0, duration_ms: 77 },
          tree: smallTree(),
          raw: "full captured run tail",
        },
        { context: { cycleId } },
      ).id,
    )!;
    const compileEvt = store.getEvent(
      store.recordCompileEvent(key, "compile-agent", COMPILE_REPORT, {
        context: { cycleId },
      }).id,
    )!;

    const body = await getJson(`/api/v2/events?project=${key}&cycleId=${cycleId}`);
    const events = body.events as Array<Record<string, unknown>>;

    expect(events).toEqual([expectedBrief(compileEvt), expectedBrief(testEvt)]);
    for (const brief of events) expectNoDetailKeys(brief);
  });
});

describe("/api/v2/status's briefs are byte-identical and carry no tree/raw key", () => {
  test("the newest test run and the newest compile run match the documented contract", async () => {
    boot();
    const store = handle!.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "status-byte-identity", type: "backend", sutRoot: "/tmp/p" });

    const testEvt = store.recordTestEvent(
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
    const compileEvt = store.recordCompileEvent(key, "compile-agent", COMPILE_REPORT, {});

    const body = await getJson(`/api/v2/status?project=${key}`);
    const status = body.status as { hasData: boolean; lastTest: unknown; lastCompile: unknown };

    expect(status.hasData).toBe(true);
    expect(status.lastTest).toEqual(expectedBrief(testEvt));
    expect(status.lastCompile).toEqual(expectedBrief(compileEvt));
    expectNoDetailKeys(status.lastTest as Record<string, unknown>);
    expectNoDetailKeys(status.lastCompile as Record<string, unknown>);
  });
});

describe("the projects list's lastEvent brief is byte-identical and carries no tree/raw key", () => {
  test("a project whose newest event is a milestone, behind an earlier tree+raw+coverage test run, matches the documented contract", async () => {
    boot();
    const store = handle!.store;
    const key = crypto.randomUUID();
    store.addProject({ key, name: "projects-byte-identity", type: "backend", sutRoot: "/tmp/p" });

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
    const milestoneResult = store.recordMilestoneEvent(key, "milestone-agent", "narrative-milestone", {
      label: "Wave complete",
    });
    const milestoneEvt = milestoneResult.event;

    const body = await getJson(`/api/v2/projects`);
    const projects = body.projects as Array<Record<string, unknown>>;
    const project = projects.find((p) => p.key === key)!;

    expect(project.lastEvent).toEqual(expectedBrief(milestoneEvt));
    expectNoDetailKeys(project.lastEvent as Record<string, unknown>);
  });
});
