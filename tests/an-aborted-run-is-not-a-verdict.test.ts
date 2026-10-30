// An aborted run's counts are not a verdict. Now that an aborted streamed run
// carries the counts it streamed, every reader that reads a run as a verdict
// skips `status: "aborted"`:
//  - `pairTransitions` (public/app-logic.mjs): an aborted run opens no RED
//    streak and closes none;
//  - the inferred cycle status `workflowLens` gives a cycle with no declared
//    plan: an aborted run marks no cycle done, and reopens none;
//  - `foldIntoRollup` (src/store.ts): an aborted run folds into no rollup.
//
// Two aborted streamed runs are read: one whose stream held failures, one
// whose stream held only passes. The briefs are the shape `eventBrief`
// (src/v2.ts) serves for an aborted streamed run — its counts, `status` and
// `abortReason`, as tests/an-aborted-streamed-run-keeps-its-tests.test.ts
// asserts on the real events list. The rollup is read on a real server:
// a project with `retention: 0` folds every run into its day rollup the moment
// it is stored (the technique tests/coverage-trend.test.ts uses), read back
// through `Store#listRollups`.
import { describe, test, expect, afterEach } from "bun:test";
import * as AppLogic from "../public/app-logic.mjs";
import type { ServerHandle } from "../src/server.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  openRun,
  postJson,
  register,
  sendBatch,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

// ── The briefs ──────────────────────────────────────────────────────────────

interface Brief {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  status?: "aborted";
  abortReason?: string;
  context?: { wave?: string; cycle?: string };
}

const PROJECT = "proj-not-a-verdict";
const T0 = Date.UTC(2026, 9, 30, 9, 0, 0);
const MINUTE = 60_000;

function run(id: string, agentId: string, minute: number, counts: { passed: number; failed: number }): Brief {
  return {
    id,
    projectKey: PROJECT,
    agentId,
    kind: "test",
    tier: "unit",
    timestamp: T0 + minute * MINUTE,
    total: counts.passed + counts.failed,
    passed: counts.passed,
    failed: counts.failed,
    pending: 0,
    duration_ms: 10,
  };
}

function aborted(id: string, agentId: string, minute: number, counts: { passed: number; failed: number }): Brief {
  return { ...run(id, agentId, minute, counts), status: "aborted", abortReason: "agent died" };
}

const WITH_FAILURES = { passed: 1, failed: 2 };
const ONLY_PASSES = { passed: 3, failed: 0 };

interface Marker {
  redEvent: Brief;
  greenEvent: Brief;
  projectKey: string;
  stem: string;
}

const pairTransitions = (AppLogic as unknown as { pairTransitions: (events: Brief[]) => Marker[] }).pairTransitions;

function pairs(events: Brief[]): Array<[string, string]> {
  return pairTransitions(events).map((m) => [m.redEvent.id, m.greenEvent.id]);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("pairTransitions: an aborted run opens no RED streak and closes none", () => {
  test("an aborted run with failures, then a pass: no marker — the aborted run opened no streak", () => {
    const events = [
      aborted("a-fail", "CR-X-1-RED", 0, WITH_FAILURES),
      run("green", "CR-X-1-GREEN", 10, ONLY_PASSES),
    ];
    expect(pairs(events)).toEqual([]);
  });

  test("an aborted run with failures, a real failure, then a pass: one marker whose RED run is the real failure", () => {
    const events = [
      aborted("a-fail", "CR-X-1-RED", 0, WITH_FAILURES),
      run("red", "CR-X-1-RED", 5, { passed: 1, failed: 1 }),
      run("green", "CR-X-1-GREEN", 10, ONLY_PASSES),
    ];
    expect(pairs(events)).toEqual([["red", "green"]]);
  });

  test("a failure, then an aborted run with only passes: no marker — the aborted run closed no streak", () => {
    const events = [
      run("red", "CR-X-1-RED", 0, { passed: 1, failed: 1 }),
      aborted("a-pass", "CR-X-1-GREEN", 5, ONLY_PASSES),
    ];
    expect(pairs(events)).toEqual([]);
  });

  test("a failure, an aborted run with only passes, then a real pass: one marker whose GREEN run is the real pass", () => {
    const events = [
      run("red", "CR-X-1-RED", 0, { passed: 1, failed: 1 }),
      aborted("a-pass", "CR-X-1-GREEN", 5, ONLY_PASSES),
      run("green", "CR-X-1-GREEN", 10, ONLY_PASSES),
    ];
    expect(pairs(events)).toEqual([["red", "green"]]);
  });

  test("control: the same runs with no abort among them pair as today", () => {
    const events = [
      run("red", "CR-X-1-RED", 0, { passed: 1, failed: 1 }),
      run("green", "CR-X-1-GREEN", 10, ONLY_PASSES),
    ];
    expect(pairs(events)).toEqual([["red", "green"]]);
  });
});

// ── The inferred cycle status ───────────────────────────────────────────────

interface LensCycle {
  label: string;
  status: string;
  runs: Brief[];
}

interface Lens {
  waves: Array<{ wave: string; crs: Array<{ cr: string; source: string; cycles: LensCycle[] }> }>;
}

const workflowLens = (AppLogic as unknown as { workflowLens: (input: { plans: unknown[]; events: Brief[] }) => Lens })
  .workflowLens;

/** The runs filed under wave 8, cycle `red-green`, with no plan declaring them: the inferred fallback. */
function inCycle(...events: Brief[]): Brief[] {
  return events.map((e) => ({ ...e, context: { wave: "8", cycle: "red-green" } }));
}

function inferredStatus(events: Brief[]): string {
  const lens = workflowLens({ plans: [], events });
  const cr = lens.waves.find((w) => w.wave === "8")?.crs.find((c) => c.cr === "CR-X-2");
  expect(cr?.source).toBe("inferred");
  const cycle = cr?.cycles.find((c) => c.label === "red-green");
  expect(cycle).toBeDefined();
  return cycle!.status;
}

describe("the inferred cycle status: an aborted run marks no cycle done", () => {
  test("a failure, then an aborted run with only passes: the cycle stays active", () => {
    expect(
      inferredStatus(
        inCycle(run("red", "CR-X-2-RED", 0, { passed: 1, failed: 1 }), aborted("a-pass", "CR-X-2-GREEN", 5, ONLY_PASSES)),
      ),
    ).toBe("active");
  });

  test("a cycle whose only run is an aborted run with only passes stays active", () => {
    expect(inferredStatus(inCycle(aborted("a-pass", "CR-X-2-GREEN", 0, ONLY_PASSES)))).toBe("active");
  });

  test("a cycle whose only run is an aborted run with failures stays active", () => {
    expect(inferredStatus(inCycle(aborted("a-fail", "CR-X-2-RED", 0, WITH_FAILURES)))).toBe("active");
  });

  test("a pass, then an aborted run with failures: the cycle stays done — the aborted run reopens nothing", () => {
    expect(
      inferredStatus(
        inCycle(run("green", "CR-X-2-GREEN", 0, ONLY_PASSES), aborted("a-fail", "CR-X-2-RED", 5, WITH_FAILURES)),
      ),
    ).toBe("done");
  });

  test("control: a failure then a real pass marks the cycle done, as today", () => {
    expect(
      inferredStatus(
        inCycle(run("red", "CR-X-2-RED", 0, { passed: 1, failed: 1 }), run("green", "CR-X-2-GREEN", 5, ONLY_PASSES)),
      ),
    ).toBe("done");
  });
});

// ── The rollup ──────────────────────────────────────────────────────────────

const L_START = eventLine({ event: "run-start", total: 3 });
const L_PASS = eventLine({ event: "test-end", id: "p1", name: "adds", suite: "math", status: "pass", duration_ms: 3 });
const L_PASS_2 = eventLine({ event: "test-end", id: "p2", name: "subtracts", suite: "math", status: "pass", duration_ms: 4 });
const L_FAIL = eventLine({
  event: "test-end",
  id: "f1",
  name: "divides",
  suite: "math",
  status: "fail",
  duration_ms: 5,
  failure: { message: "expected 1" },
});

/** A project whose every stored run folds straight into its day rollup (retention 0). */
async function foldingProject(handle: ServerHandle, agentId: string): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "folds-at-once", type: "backend", sutRoot: "/tmp/folds-at-once", retention: 0 });
  await register(handle, key, agentId);
  return key;
}

async function streamThenAbort(handle: ServerHandle, key: string, agentId: string, text: string): Promise<void> {
  const runId = await openRun(handle, key, agentId, { stack: "bun", tier: "unit" });
  const sent = await sendBatch(handle, runId, { projectKey: key, agentId, from: 0, data: text });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const res = await postJson(handle, `/api/v2/runs/${runId}/abort`, { projectKey: key, agentId, reason: "runner crashed" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(handle.store.getRun(runId)?.state).toBe("aborted");
}

describe("foldIntoRollup: an aborted run folds into no rollup", () => {
  test("an aborted streamed run with failures folds into no rollup bucket", async () => {
    const handle = boot();
    const key = await foldingProject(handle, "folder");
    await streamThenAbort(handle, key, "folder", L_START + L_PASS + L_FAIL);
    expect(handle.store.listRollups(key)).toEqual([]);
  });

  test("an aborted streamed run with only passes folds into no rollup bucket", async () => {
    const handle = boot();
    const key = await foldingProject(handle, "folder");
    await streamThenAbort(handle, key, "folder", L_START + L_PASS + L_PASS_2);
    expect(handle.store.listRollups(key)).toEqual([]);
  });

  test("beside a closed streamed run, the rollup counts that run alone: one run, its passes, its failures", async () => {
    const handle = boot();
    const key = await foldingProject(handle, "folder");
    await streamThenAbort(handle, key, "folder", L_START + L_PASS + L_FAIL);
    const runId = await openRun(handle, key, "folder", { stack: "bun", tier: "unit" });
    const closed = L_START + L_PASS + L_PASS_2 + eventLine({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 });
    const sent = await sendBatch(handle, runId, { projectKey: key, agentId: "folder", from: 0, data: closed });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const res = await closeStream(handle, key, "folder", runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rollups = handle.store.listRollups(key);
    expect(rollups.length).toBe(1);
    expect(rollups[0]).toMatchObject({ runs: 1, passed: 2, failed: 0, duration_ms: 7 });
  });
});
