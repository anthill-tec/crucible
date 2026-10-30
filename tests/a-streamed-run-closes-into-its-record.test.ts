// The close of a streamed run: `POST /api/v2/runs` with the `runId`,
// `codec: "crucible-events"` and no report decodes the run's held stream and
// stores it as the run's one event, through the route's whole pipeline — on a
// real server (`startServer`, port 0, ":memory:" unless an operator limit is
// set through the server's own `crucible.toml`).
//
// What is held here:
//  - the event: the coverage sent at close (dropped on a failing run, as
//    today), the raw output capped by `raw_output_chars`, the lifecycle stamp,
//    the attach context, the role and the release;
//  - the pipeline: a `runnerExit` above 0 over a green stream is filed red, a
//    changed `stack` or `tier` is a 400, and a bound agent whose cycle went
//    terminal is answered as `/runs` answers a report close today;
//  - after the close: the run's batches and live state are gone, and the live
//    read answers the settled state;
//  - the refusals, each a 400 that stores nothing and leaves the run open (it
//    is closed properly afterwards): a stream codec sent with `data` or
//    `dataPath`, a stream codec on a run that holds no stream, and a run that
//    holds a stream closed by another codec, by `/runs/parsed` or by
//    `/runs/compile`;
//  - a close with no test held: filed red and flagged `incomplete` when
//    `runnerExit` is above 0, a 400 that leaves the run open otherwise;
//  - a close resent after the run settled: a 409 carrying `state` and
//    `eventId`.
//
// "Nothing stored" compares the project's events after the refusal with the
// events held BEFORE it — a registration already records a lifecycle event.
import { describe, test, expect, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { RUN_STREAM_TABLES } from "../src/run-stream.ts";
import { shippedLimits } from "../src/limits.ts";
import type { ServerHandle } from "../src/server.ts";
import {
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
} from "./helpers/server-limits-fixture.ts";
import {
  base,
  bootOn,
  eventLine,
  getJson,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  STREAM_CODEC,
  storedEvent,
  utf8,
  type Answer,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  restoreServerLimitsFixture();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

// ── The streams ─────────────────────────────────────────────────────────────

const L_START = eventLine({ event: "run-start", total: 2 });
const L_PASS_A = eventLine({
  event: "test-end",
  id: "t1",
  name: "adds",
  suite: "math",
  file: "src/math.ts",
  status: "pass",
  duration_ms: 3,
});
const L_PASS_B = eventLine({
  event: "test-end",
  id: "t2",
  name: "subtracts",
  suite: "math",
  file: "src/math.ts",
  status: "pass",
  duration_ms: 4,
});
const L_FAIL = eventLine({
  event: "test-end",
  id: "t3",
  name: "divides",
  suite: "math",
  file: "src/math.ts",
  status: "fail",
  duration_ms: 5,
  failure: { message: "expected 1" },
});
const L_END_GREEN = eventLine({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 });
const L_END_RED = eventLine({ event: "run-end", total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 8 });

/** A complete green stream: two passes and a run-end that agrees. */
const GREEN_STREAM = L_START + L_PASS_A + L_PASS_B + L_END_GREEN;
/** A complete red stream: one pass, one failure and a run-end that agrees. */
const RED_STREAM = L_START + L_PASS_A + L_FAIL + L_END_RED;

const GREEN_REPORT = '<testsuite name="green" tests="1"><testcase name="passes" time="0"/></testsuite>';
const TSC_ONE_ERROR = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";

/** One lcov record, every line and function hit: lines {23, 23, 100}. */
const LCOV_ALL_HIT = ["SF:src/gamma.ts", "FNF:2", "FNH:2", "LF:23", "LH:23", "end_of_record", ""].join("\n");

// ── The subject ─────────────────────────────────────────────────────────────

interface Subject {
  handle: ServerHandle;
  key: string;
  agentId: string;
  runId: string;
}

async function subject(
  handle: ServerHandle = boot(),
  agentId = "closer",
  start: Record<string, unknown> = { stack: "bun", tier: "unit" },
): Promise<Subject> {
  const key = await readyProject(handle, [agentId]);
  const runId = await openRun(handle, key, agentId, start);
  return { handle, key, agentId, runId };
}

async function stream(s: Subject, text: string): Promise<void> {
  const res = await sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: s.agentId, from: 0, data: text });
  expect(res.status, `the stream batch: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.held).toBe(utf8(text));
}

/** The close, with whatever else the body states (`coverage`, `raw`, `runnerExit`, …). */
function close(s: Subject, extra: Record<string, unknown> = {}): Promise<Answer> {
  return postJson(s.handle, "/api/v2/runs", {
    projectKey: s.key,
    agentId: s.agentId,
    runId: s.runId,
    codec: STREAM_CODEC,
    ...extra,
  });
}

function eventIds(s: Subject): string[] {
  return s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).map((e) => e.id);
}

function expectAccepted(res: Answer): string {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(typeof res.body.event).toBe("string");
  return res.body.event as string;
}

/** One fixed count query per stream table — no table name is ever interpolated. */
const COUNT_ROWS: Record<(typeof RUN_STREAM_TABLES)[number], string> = {
  run_stream_batches: "SELECT COUNT(*) AS n FROM run_stream_batches WHERE run_id = ?",
  run_live: "SELECT COUNT(*) AS n FROM run_live WHERE run_id = ?",
  run_live_failures: "SELECT COUNT(*) AS n FROM run_live_failures WHERE run_id = ?",
};

/** The rows each stream table holds for the run, read off the store's own connection. */
function streamRows(s: Subject): Record<string, number> {
  const db = (s.handle.store as unknown as { db: Database }).db;
  const out: Record<string, number> = {};
  for (const table of RUN_STREAM_TABLES) {
    out[table] = db.query<{ n: number }, [string]>(COUNT_ROWS[table]).get(s.runId)!.n;
  }
  return out;
}

/** A 400 whose error tells the caller to close the run with the stream codec. */
function expectNamesTheStreamCodec(res: Answer): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(String(res.body.error)).toContain("crucible-events");
}

const NO_ROWS = Object.fromEntries(RUN_STREAM_TABLES.map((table) => [table, 0]));

/**
 * A refusal at the close: a 400 carrying an error, no event stored beside the
 * ones held before it, and the run still open — closed properly afterwards
 * into exactly one event decoded from its stream.
 */
async function expectRefusedAndStillOpen(
  s: Subject,
  res: Answer,
  before: string[],
  heldStream: string | null,
): Promise<void> {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.ok).toBe(false);
  expect(typeof res.body.error).toBe("string");
  expect(eventIds(s)).toEqual(before);
  expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
  if (heldStream === null) return;
  // The stream is still held whole, and the proper close takes it.
  const proper = await close(s);
  const eventId = expectAccepted(proper);
  expect(eventIds(s)).toEqual([eventId, ...before]);
  expect(s.handle.store.getRun(s.runId)?.state).toBe("ended");
  const stored = await storedEvent(s.handle, eventId);
  expect(stored.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 });
}

// ═══════════════════════════════════════════════════════════════════════════

describe("the close stores one event that carries what the close sent and what the run was opened with", () => {
  test("a green stream closed with coverage stores that coverage on the event, and the answer carries it", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const res = await close(s, { coverage: { codec: "lcov", data: LCOV_ALL_HIT } });
    const eventId = expectAccepted(res);
    const event = await storedEvent(s.handle, eventId);
    expect((event.coverage as { lines: unknown }).lines).toEqual({ total: 23, covered: 23, percent: 100 });
    expect((event.coverage as { functions: unknown }).functions).toEqual({ total: 2, covered: 2, percent: 100 });
    expect(((res.body.run as Record<string, unknown>).coverage as { lines: unknown }).lines).toEqual({
      total: 23,
      covered: 23,
      percent: 100,
    });
  });

  test("a failing stream closed with coverage stores no coverage, as a failing report close drops it today", async () => {
    const s = await subject();
    await stream(s, RED_STREAM);
    const eventId = expectAccepted(await close(s, { coverage: { codec: "lcov", data: LCOV_ALL_HIT } }));
    const event = await storedEvent(s.handle, eventId);
    expect(event.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 8 });
    expect(event.coverage).toBeUndefined();
  });

  test("the raw output sent at close is stored capped at raw_output_chars, its middle cut and the cut named", async () => {
    const raw = shippedLimits().raw_output_chars;
    expect(raw, "src/crucible.toml declares no [limits.raw_output_chars] table").toBeDefined();
    if (raw === undefined) return;
    const limit = raw.min;
    writeConfig(serverConfigDir(), { raw_output_chars: declare(raw, limit) });
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const head = "H".repeat(Math.floor(limit / 2));
    const tail = "T".repeat(Math.ceil(limit / 2));
    const eventId = expectAccepted(await close(s, { raw: `${head}0123456789${tail}` }));
    const event = await storedEvent(s.handle, eventId);
    expect(typeof event.raw).toBe("string");
    expect((event.raw as string).length).toBe(head.length + "\n… 10 characters cut …\n".length + tail.length);
    expect(event.raw === `${head}\n… 10 characters cut …\n${tail}`).toBe(true);
  });

  test("the event carries the run's lifecycle stamp, the codec, the stack and tier it was opened with, and the caller's role", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const startedAt = s.handle.store.getRun(s.runId)?.startedAt;
    expect(typeof startedAt).toBe("number");
    const eventId = expectAccepted(await close(s));
    const event = await storedEvent(s.handle, eventId);
    expect(event.startedAt).toBe(startedAt);
    expect(typeof event.runtimeMs).toBe("number");
    expect(event.runtimeMs as number).toBeGreaterThanOrEqual(0);
    expect(event.codec).toBe(STREAM_CODEC);
    expect(event.stack).toBe("bun");
    expect(event.tier).toBe("unit");
    expect(event.role).toBe("ORCHESTRATOR");
    expect(s.handle.store.getRun(s.runId)?.eventId).toBe(eventId);
  });

  test("a run filed under a declared release carries that release on its event", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["releaser"]);
    handle.store.recordReleaseProposal(key, "fixture-setup", {
      label: "4.2.0",
      targetAt: Math.floor(Date.now() / 1000) + 86_400,
    });
    const runId = await openRun(handle, key, "releaser", { stack: "bun", tier: "regression", release: "4.2.0" });
    const s: Subject = { handle, key, agentId: "releaser", runId };
    await stream(s, GREEN_STREAM);
    const eventId = expectAccepted(await close(s, { release: "4.2.0" }));
    const event = await storedEvent(handle, eventId);
    expect(event.release).toBe("4.2.0");
    expect(event.tier).toBe("regression");
  });

  test("a bound agent's close carries the attach context its binding stamps: the cycle it is bound to, and its role", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["planner"]);
    const { cycleId } = await fileAndActivate(handle, key, "CR-STREAM-ATTACH");
    await registerBound(handle, key, "attach-RED", "RED", cycleId);
    const runId = await openRun(handle, key, "attach-RED", { stack: "bun", tier: "unit" });
    const s: Subject = { handle, key, agentId: "attach-RED", runId };
    await stream(s, RED_STREAM);
    const eventId = expectAccepted(await close(s));
    const event = await storedEvent(handle, eventId);
    expect((event.context as { cycleId?: unknown } | undefined)?.cycleId).toBe(cycleId);
    expect(event.role).toBe("RED");
    expect(event.summary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 8 });
  });
});

describe("the close runs /runs' pipeline over the held stream", () => {
  test("a runnerExit above 0 over a green stream is filed red: a failing `runner` suite holding `exit 3`", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const res = await close(s, { runnerExit: 3 });
    const eventId = expectAccepted(res);
    expect(res.body.verdict).toBe("RED — 1 failing of 3");
    const event = await storedEvent(s.handle, eventId);
    expect(event.summary).toEqual({ total: 3, passed: 2, failed: 1, pending: 0, duration_ms: 7 });
    const tree = event.tree as Array<{ name: string; status: string; children: Array<{ name: string; status: string }> }>;
    expect(tree.map((n) => n.name)).toEqual(["math", "runner"]);
    expect(tree[1]!.status).toBe("fail");
    expect(tree[1]!.children.map((c) => [c.name, c.status])).toEqual([["exit 3", "fail"]]);
  });

  test("a close stating a stack other than the run's start is a 400, nothing stored, the run left open", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const before = eventIds(s);
    const res = await close(s, { stack: "mvn" });
    expect(String(res.body.error)).toContain("stack");
    await expectRefusedAndStillOpen(s, res, before, GREEN_STREAM);
  });

  test("a close stating a tier other than the run's start is a 400, nothing stored, the run left open", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const before = eventIds(s);
    const res = await close(s, { tier: "integration" });
    expect(String(res.body.error)).toContain("tier");
    await expectRefusedAndStillOpen(s, res, before, GREEN_STREAM);
  });

  test("a bound agent whose cycle went done is refused as /runs refuses a report close today: the same 409 and help, nothing stored", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["planner"]);
    const { planId, cycleId } = await fileAndActivate(handle, key, "CR-STREAM-TERMINAL");
    await registerBound(handle, key, "late-VERIFY", "VERIFY", cycleId);
    const streamed = await openRun(handle, key, "late-VERIFY", { stack: "bun", tier: "unit" });
    const reported = await openRun(handle, key, "late-VERIFY", { stack: "bun", tier: "unit" });
    const s: Subject = { handle, key, agentId: "late-VERIFY", runId: streamed };
    await stream(s, GREEN_STREAM);
    await transitionCycle(handle, key, planId, cycleId, "done");
    const before = eventIds(s);

    const viaReport = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "late-VERIFY",
      runId: reported,
      codec: "junit",
      data: GREEN_REPORT,
    });
    const viaStream = await close(s);

    expect(viaReport.status).toBe(409);
    expect(viaStream.status).toBe(viaReport.status);
    expect(viaStream.body.ok).toBe(false);
    expect(viaStream.body.error).toBe(viaReport.body.error);
    expect(viaStream.body.help).toEqual(viaReport.body.help);
    expect(eventIds(s)).toEqual(before);
    expect(handle.store.getRun(streamed)?.state).toBe("open");
  });
});

describe("after the close, the run holds no stream and no live state", () => {
  test("the batches and live state are deleted, runLive answers null, and the live read answers the settled state", async () => {
    const s = await subject();
    await stream(s, RED_STREAM);
    expect(s.handle.store.runLive(s.runId)?.completed).toBe(2);
    expect(streamRows(s).run_stream_batches).toBe(1);
    const eventId = expectAccepted(await close(s));
    expect(streamRows(s)).toEqual(NO_ROWS);
    expect(s.handle.store.runLive(s.runId)).toBeNull();
    const live = await getJson(s.handle, `/api/v2/runs/${s.runId}/live`);
    expect(live).toEqual({ ok: true, state: "ended", eventId });
  });
});

describe("a close the board cannot decode from the held stream is a 400 that stores nothing and leaves the run open", () => {
  test("a stream codec sent WITH a data report is a 400 — a stream codec is never a report", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const before = eventIds(s);
    const res = await close(s, { data: RED_STREAM });
    await expectRefusedAndStillOpen(s, res, before, GREEN_STREAM);
  });

  test("a stream codec sent WITH a dataPath is a 400", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const before = eventIds(s);
    const res = await close(s, { dataPath: "/tmp/stream-close-no-such-report.ndjson" });
    await expectRefusedAndStillOpen(s, res, before, GREEN_STREAM);
  });

  test("a stream codec sent with data and no runId is a 400 — single-shot use of a stream codec is refused, nothing stored", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["single-shot"]);
    const before = handle.store.listEvents(key, Number.MAX_SAFE_INTEGER).map((e) => e.id);
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "single-shot",
      codec: STREAM_CODEC,
      data: GREEN_STREAM,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(handle.store.listEvents(key, Number.MAX_SAFE_INTEGER).map((e) => e.id)).toEqual(before);
  });

  test("a stream codec on a run that holds no stream is a 400, and the run stays open", async () => {
    const s = await subject();
    const before = eventIds(s);
    const res = await close(s);
    await expectRefusedAndStillOpen(s, res, before, null);
    // Once it holds a stream, the same close takes it.
    await stream(s, GREEN_STREAM);
    const eventId = expectAccepted(await close(s));
    expect(eventIds(s)).toEqual([eventId, ...before]);
  });
});

describe("a run that streams its record is closed only with the stream codec", () => {
  test("closed by /runs naming codec junit with a report: a 400 naming crucible-events, nothing stored, the run open", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const before = eventIds(s);
    const res = await postJson(s.handle, "/api/v2/runs", {
      projectKey: s.key,
      agentId: s.agentId,
      runId: s.runId,
      codec: "junit",
      data: GREEN_REPORT,
    });
    expectNamesTheStreamCodec(res);
    await expectRefusedAndStillOpen(s, res, before, GREEN_STREAM);
  });

  test("closed by /runs/parsed: a 400 naming crucible-events, nothing stored, the run open", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const before = eventIds(s);
    const res = await postJson(s.handle, "/api/v2/runs/parsed", {
      projectKey: s.key,
      agentId: s.agentId,
      runId: s.runId,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
      tree: [{ name: "Suite", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 10 }] }],
    });
    expectNamesTheStreamCodec(res);
    await expectRefusedAndStillOpen(s, res, before, GREEN_STREAM);
  });

  test("closed by /runs/compile: a 400 naming crucible-events, nothing stored, the run open", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const before = eventIds(s);
    const res = await postJson(s.handle, "/api/v2/runs/compile", {
      projectKey: s.key,
      agentId: s.agentId,
      runId: s.runId,
      format: "tsc",
      errors: TSC_ONE_ERROR,
    });
    expectNamesTheStreamCodec(res);
    await expectRefusedAndStillOpen(s, res, before, GREEN_STREAM);
  });
});

describe("a close whose held stream holds no test", () => {
  test("with runnerExit above 0 it is filed red as fileRunnerExit files it, and flagged incomplete", async () => {
    const s = await subject();
    await stream(s, L_START);
    const res = await close(s, { runnerExit: 2 });
    const eventId = expectAccepted(res);
    const event = await storedEvent(s.handle, eventId);
    expect(event.summary).toEqual({ total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 0 });
    const tree = event.tree as Array<{ name: string; children: Array<{ name: string }> }>;
    expect(tree.map((n) => n.name)).toEqual(["runner"]);
    expect(tree[0]!.children.map((c) => c.name)).toEqual(["exit 2"]);
    expect(event.incomplete).toBe("no run-end");
  });

  test("with runnerExit above 0 over a stream whose run-end agrees there were no tests, it is still flagged incomplete", async () => {
    const s = await subject();
    await stream(s, L_START + eventLine({ event: "run-end", total: 0, passed: 0, failed: 0, pending: 0 }));
    const eventId = expectAccepted(await close(s, { runnerExit: 1 }));
    const event = await storedEvent(s.handle, eventId);
    expect(event.summary).toEqual({ total: 1, passed: 0, failed: 1, pending: 0, duration_ms: 0 });
    expect(typeof event.incomplete).toBe("string");
    expect((event.incomplete as string).length).toBeGreaterThan(0);
  });

  test("with runnerExit 0 it is a 400, nothing stored, the run left open", async () => {
    const s = await subject();
    await stream(s, L_START);
    const before = eventIds(s);
    const res = await close(s, { runnerExit: 0 });
    await expectRefusedAndStillOpen(s, res, before, null);
    expect(s.handle.store.runLive(s.runId)).not.toBeNull();
  });

  test("with no runnerExit it is a 400, nothing stored, the run left open", async () => {
    const s = await subject();
    await stream(s, L_START);
    const before = eventIds(s);
    const res = await close(s);
    await expectRefusedAndStillOpen(s, res, before, null);
    expect(s.handle.store.runLive(s.runId)).not.toBeNull();
  });
});

describe("a close resent after the run settled", () => {
  test("is a 409 carrying the run's state and the event that settled it, and stores nothing", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const eventId = expectAccepted(await close(s));
    const before = eventIds(s);
    const again = await close(s);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.ok).toBe(false);
    expect(again.body.state).toBe("ended");
    expect(again.body.eventId).toBe(eventId);
    expect(eventIds(s)).toEqual(before);
  });

  test("a report close resent after a streamed run was aborted is a 409 carrying state aborted and the abort's event", async () => {
    const s = await subject();
    await stream(s, GREEN_STREAM);
    const abort = await postJson(s.handle, `/api/v2/runs/${s.runId}/abort`, {
      projectKey: s.key,
      agentId: s.agentId,
      reason: "runner crashed",
    });
    expect(abort.status, JSON.stringify(abort.body)).toBe(200);
    const abortedEventId = s.handle.store.getRun(s.runId)?.eventId;
    expect(typeof abortedEventId).toBe("string");
    const again = await close(s);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.state).toBe("aborted");
    expect(again.body.eventId).toBe(abortedEventId);
  });
});

// ── Plans and bound agents ──────────────────────────────────────────────────

/** The unbound orchestrator that files and moves the plans a bound agent binds to. */
const PLANNER = "planner";

async function patchJson(handle: ServerHandle, route: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A one-cycle plan, filed and its cycle activated through the real plan routes. */
async function fileAndActivate(
  handle: ServerHandle,
  key: string,
  cr: string,
): Promise<{ planId: number; cycleId: number }> {
  const filed = await postJson(handle, `/api/v2/projects/${key}/plans`, {
    agentId: PLANNER,
    cr,
    cycles: [{ label: "solo" }],
  });
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const planId = filed.body.planId as number;
  const cycleId = (filed.body.cycles as Array<{ id: number }>)[0]!.id;
  await transitionCycle(handle, key, planId, cycleId, "active");
  return { planId, cycleId };
}

async function transitionCycle(
  handle: ServerHandle,
  key: string,
  planId: number,
  cycleId: number,
  status: string,
): Promise<void> {
  const res = await patchJson(handle, `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    agentId: PLANNER,
    status,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function registerBound(
  handle: ServerHandle,
  key: string,
  agentId: string,
  role: string,
  cycleId: number,
): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", { projectKey: key, agentId, role, cycleId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
