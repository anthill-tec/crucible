// A run holding a VIEW stream (codec `bun-console`) is closed and aborted
// exactly as a run that streamed nothing (CR-CRU-201 §S1, AC1; P4):
//  - the closes: the JUnit close (`POST /api/v2/runs`, codec junit), the
//    parsed close (`/runs/parsed`), the compile close (`/runs/compile`) and a
//    raw-report close (`POST /api/v2/runs`, codec playwright, the raw JSON
//    report as `data`) each store exactly what the same close stores for a
//    twin run that streamed nothing — the oracle is that twin, closed the same
//    way in the same test — and the run's batches, live state and failures
//    are deleted at settle;
//  - a run holding a RECORD stream (`crucible-events`) is still refused the
//    JUnit close (CR-CRU-200), beside a view-stream run that takes it;
//  - the abort: by the abort route, and by the sweep (`agent died` and
//    `abandoned`, `Store#sweepOpenRuns` driven with a `now` as
//    tests/an-aborted-streamed-run-keeps-its-tests.test.ts drives it), a
//    view-stream run's aborted event carries no tree, no summary and no
//    `incomplete`, and its held stream is deleted.
//
// "Exactly what it stores" compares the two stored events read back through
// the run detail read, every key but the event's own id, its timestamp and
// the run's own lifecycle stamp (`startedAt`, `runtimeMs`).
//
// The view stream is a real bun console capture
// (tests/fixtures/bun-console-live-captures.ts).
//
// SAFETY: every server binds port 0 on ":memory:".
import { describe, test, expect, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { shippedLimits } from "../src/limits.ts";
import { RUN_STREAM_TABLES } from "../src/run-stream.ts";
import type { ServerHandle } from "../src/server.ts";
import {
  bootOn,
  eventLine,
  getJson,
  openRun,
  postJson,
  register,
  sendBatch,
  storedEvent,
  utf8,
  type Answer,
} from "./helpers/run-stream-harness.ts";
import { PLAIN_RUN } from "./fixtures/bun-console-live-captures.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

const VIEW_CODEC = "bun-console";

// ── The subject ─────────────────────────────────────────────────────────────

interface Liveness {
  staleAfterMs: number;
  tombstoneAfterMs: number;
  pruneAfterMs: number;
}

interface Board {
  handle: ServerHandle;
  key: string;
  agentId: string;
}

async function board(agentId = "viewer", liveness?: Liveness): Promise<Board> {
  const handle = bootOn();
  handles.push(handle);
  const key = crypto.randomUUID();
  handle.store.addProject({
    key,
    name: "view-close",
    type: "backend",
    sutRoot: "/tmp/view-close",
    ...(liveness !== undefined ? { liveness } : {}),
  });
  await register(handle, key, agentId);
  return { handle, key, agentId };
}

function open(b: Board): Promise<string> {
  return openRun(b.handle, b.key, b.agentId, { stack: "bun", tier: "unit" });
}

/** The whole capture, sent as a view stream in two batches split before its first `(fail)` line. */
async function streamView(b: Board, runId: string): Promise<void> {
  const cut = PLAIN_RUN.indexOf("(fail)");
  for (const [from, data] of [
    [0, PLAIN_RUN.slice(0, cut)],
    [utf8(PLAIN_RUN.slice(0, cut)), PLAIN_RUN.slice(cut)],
  ] as const) {
    const res = await sendBatch(b.handle, runId, { projectKey: b.key, agentId: b.agentId, from, data, codec: VIEW_CODEC });
    expect(res.status, `the view stream batch: ${JSON.stringify(res.body)}`).toBe(200);
  }
  expect(b.handle.store.runLive(runId)?.completed).toBe(7);
}

/** One fixed count query per stream table — no table name is ever interpolated. */
const COUNT_ROWS: Record<(typeof RUN_STREAM_TABLES)[number], string> = {
  run_stream_batches: "SELECT COUNT(*) AS n FROM run_stream_batches WHERE run_id = ?",
  run_live: "SELECT COUNT(*) AS n FROM run_live WHERE run_id = ?",
  run_live_failures: "SELECT COUNT(*) AS n FROM run_live_failures WHERE run_id = ?",
};

function streamRows(b: Board, runId: string): Record<string, number> {
  const db = (b.handle.store as unknown as { db: Database }).db;
  const out: Record<string, number> = {};
  for (const table of RUN_STREAM_TABLES) {
    out[table] = db.query<{ n: number }, [string]>(COUNT_ROWS[table]).get(runId)!.n;
  }
  return out;
}

const NO_ROWS = Object.fromEntries(RUN_STREAM_TABLES.map((table) => [table, 0]));

/** A stored event as a record: every key but its id, its timestamp and the run's lifecycle stamp. */
function recordOf(event: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, timestamp: _timestamp, startedAt: _startedAt, runtimeMs: _runtimeMs, ...record } = event;
  return record;
}

/** The event that settled the run, read back through the run detail read. */
async function settledEvent(b: Board, runId: string, state: "ended" | "aborted"): Promise<Record<string, unknown>> {
  const run = b.handle.store.getRun(runId);
  expect(run?.state).toBe(state);
  expect(typeof run?.eventId).toBe("string");
  return storedEvent(b.handle, run?.eventId);
}

type Close = (b: Board, runId: string) => Promise<Answer>;

/**
 * The view-stream run and its twin that streamed nothing are closed the same
 * way: both accepted, the two records equal, and the view run's batches, live
 * state and failures gone.
 */
async function expectClosesAsTheTwin(close: Close): Promise<Record<string, unknown>> {
  const b = await board();
  const twin = await open(b);
  const viewed = await open(b);
  await streamView(b, viewed);
  expect(streamRows(b, viewed).run_stream_batches).toBe(2);

  const twinRes = await close(b, twin);
  expect(twinRes.status, `the twin's close: ${JSON.stringify(twinRes.body)}`).toBe(200);
  const viewRes = await close(b, viewed);
  expect(viewRes.status, `the view run's close: ${JSON.stringify(viewRes.body)}`).toBe(200);
  expect(viewRes.body.ok).toBe(true);

  const twinEvent = await settledEvent(b, twin, "ended");
  const viewEvent = await settledEvent(b, viewed, "ended");
  expect(recordOf(viewEvent)).toEqual(recordOf(twinEvent));
  expect(Object.keys(viewEvent)).not.toContain("incomplete");

  expect(streamRows(b, viewed)).toEqual(NO_ROWS);
  expect(b.handle.store.runLive(viewed)).toBeNull();
  expect(await getJson(b.handle, `/api/v2/runs/${viewed}/live`)).toEqual({
    ok: true,
    state: "ended",
    eventId: viewEvent.id,
  });
  return viewEvent;
}

// ── The closes ──────────────────────────────────────────────────────────────

/** bun's JUnit report for the capture's math file: a pass and a type-only failure. */
const JUNIT_REPORT =
  '<testsuites><testsuite name="math.test.ts" tests="2" failures="1">' +
  '<testcase name="adds" classname="math" time="0.001"/>' +
  '<testcase name="divides" classname="math" time="0.002"><failure type="AssertionError"/></testcase>' +
  "</testsuite></testsuites>";

const PARSED_RUN = {
  summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 3 },
  tree: [
    {
      name: "math.test.ts",
      status: "fail",
      children: [
        { name: "adds", status: "pass", duration_ms: 1 },
        { name: "divides", status: "fail", duration_ms: 2, failure: { message: "expected 3" } },
      ],
    },
  ],
};

const TSC_ONE_ERROR = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";

/** A raw Playwright JSON report: one file, one feature, one passing scenario of two steps. */
const PLAYWRIGHT_REPORT = {
  config: { version: "1.61.1" },
  suites: [
    {
      title: "tests/e2e/features/view.feature.spec.js",
      file: "tests/e2e/features/view.feature.spec.js",
      column: 0,
      line: 0,
      specs: [],
      suites: [
        {
          title: "View Feature",
          file: "tests/e2e/features/view.feature.spec.js",
          line: 3,
          column: 6,
          specs: [
            {
              title: "Scenario passes",
              ok: true,
              tags: [],
              tests: [
                {
                  timeout: 30000,
                  annotations: [],
                  expectedStatus: "passed",
                  projectId: "chromium",
                  projectName: "chromium",
                  results: [
                    {
                      workerIndex: 0,
                      parallelIndex: 0,
                      status: "passed",
                      duration: 10,
                      errors: [],
                      stdout: [],
                      stderr: [],
                      retry: 0,
                      steps: [
                        { title: "Given a view stream", duration: 4 },
                        { title: "Then the report closes it", duration: 6 },
                      ],
                      startTime: "2026-07-15T00:00:00.000Z",
                      annotations: [],
                      attachments: [],
                    },
                  ],
                  status: "expected",
                },
              ],
              id: "spec-view",
              file: "tests/e2e/features/view.feature.spec.js",
              line: 6,
              column: 3,
            },
          ],
        },
      ],
    },
  ],
  errors: [],
  stats: { startTime: "2026-07-15T00:00:00.000Z", duration: 10, expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
};

describe("a run holding a view stream closes through its report as a run with no stream does", () => {
  test("the JUnit close, with the console as raw: stored exactly as the twin's, the batches, live state and failures deleted", async () => {
    const event = await expectClosesAsTheTwin((b, runId) =>
      postJson(b.handle, "/api/v2/runs", {
        projectKey: b.key,
        agentId: b.agentId,
        runId,
        codec: "junit",
        data: JUNIT_REPORT,
        raw: PLAIN_RUN,
      }),
    );
    expect(event.codec).toBe("junit");
    // The report's two cases, plus the load error the raw console names (broken.test.ts), as the record reads it.
    expect(event.summary).toMatchObject({ total: 3, passed: 1, failed: 2, pending: 0 });
  });

  test("the parsed close (/runs/parsed): stored exactly as the twin's, the held stream deleted", async () => {
    const event = await expectClosesAsTheTwin((b, runId) =>
      postJson(b.handle, "/api/v2/runs/parsed", { projectKey: b.key, agentId: b.agentId, runId, ...PARSED_RUN }),
    );
    expect(event.summary).toEqual(PARSED_RUN.summary);
  });

  test("the compile close (/runs/compile): stored exactly as the twin's, the held stream deleted", async () => {
    await expectClosesAsTheTwin((b, runId) =>
      postJson(b.handle, "/api/v2/runs/compile", {
        projectKey: b.key,
        agentId: b.agentId,
        runId,
        format: "tsc",
        errors: TSC_ONE_ERROR,
      }),
    );
  });

  test("a raw-report close (codec playwright, the raw JSON report as data): stored exactly as the twin's, the held stream deleted", async () => {
    const event = await expectClosesAsTheTwin((b, runId) =>
      postJson(b.handle, "/api/v2/runs", {
        projectKey: b.key,
        agentId: b.agentId,
        runId,
        codec: "playwright",
        data: JSON.stringify(PLAYWRIGHT_REPORT),
      }),
    );
    expect(event.codec).toBe("playwright");
    expect((event.summary as Record<string, unknown>).total).toBe(2);
  });

  test("beside a view-stream run that takes the JUnit close, a run holding a record stream is still refused it: a 400 naming crucible-events, the run left open", async () => {
    const b = await board();
    const viewed = await open(b);
    await streamView(b, viewed);
    const viewRes = await postJson(b.handle, "/api/v2/runs", {
      projectKey: b.key,
      agentId: b.agentId,
      runId: viewed,
      codec: "junit",
      data: JUNIT_REPORT,
    });
    expect(viewRes.status, JSON.stringify(viewRes.body)).toBe(200);

    const recorded = await open(b);
    const stream = eventLine({ event: "run-start", total: 1 }) + eventLine({ event: "test-end", name: "t", status: "pass" });
    const batch = await sendBatch(b.handle, recorded, { projectKey: b.key, agentId: b.agentId, from: 0, data: stream });
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    const refused = await postJson(b.handle, "/api/v2/runs", {
      projectKey: b.key,
      agentId: b.agentId,
      runId: recorded,
      codec: "junit",
      data: JUNIT_REPORT,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(String(refused.body.error)).toContain("crucible-events");
    expect(b.handle.store.getRun(recorded)?.state).toBe("open");
  });
});

// ── The abort ───────────────────────────────────────────────────────────────

const ABANDON_MS = shippedLimits().run_abandon_ms?.recommended ?? 3_600_000;

/** Liveness windows far past the abandon deadline: the sweep can only find the run abandoned. */
const NEVER_TOMBSTONED: Liveness = {
  staleAfterMs: ABANDON_MS * 10,
  tombstoneAfterMs: ABANDON_MS * 20,
  pruneAfterMs: ABANDON_MS * 40,
};

/** A short tombstone window and a far prune: the sweep finds the agent dead, its row still there. */
const TOMBSTONES_FAST: Liveness = { staleAfterMs: 1_000, tombstoneAfterMs: 2_000, pruneAfterMs: ABANDON_MS * 40 };

async function briefOf(b: Board, eventId: unknown): Promise<Record<string, unknown>> {
  const list = await getJson(b.handle, `/api/v2/events?project=${b.key}`);
  const found = (list.events as Array<Record<string, unknown>>).filter((e) => e.id === eventId);
  expect(found.length).toBe(1);
  return found[0]!;
}

/** A view-stream run's aborted event: as a run with no stream — no counts, no tree, no `incomplete` — its stream gone. */
async function expectAbortedAsNoStream(b: Board, runId: string, reason: string): Promise<void> {
  const event = await settledEvent(b, runId, "aborted");
  expect(event.status).toBe("aborted");
  expect(event.abortReason).toBe(reason);
  expect(event.summary).toBeUndefined();
  expect((event.tree as unknown[] | undefined) ?? []).toEqual([]);
  expect(Object.keys(event)).not.toContain("incomplete");
  const brief = await briefOf(b, event.id);
  expect(brief).toMatchObject({ status: "aborted", abortReason: reason, total: 0, passed: 0, failed: 0, pending: 0 });
  expect(Object.keys(brief)).not.toContain("incomplete");
  expect(streamRows(b, runId)).toEqual(NO_ROWS);
  expect(b.handle.store.runLive(runId)).toBeNull();
}

describe("a view-stream run is aborted exactly as a run with no stream", () => {
  test("by the abort route: no tree, no summary, no incomplete, and its held stream deleted", async () => {
    const b = await board("view-aborter");
    const runId = await open(b);
    await streamView(b, runId);
    const res = await postJson(b.handle, `/api/v2/runs/${runId}/abort`, {
      projectKey: b.key,
      agentId: b.agentId,
      reason: "runner crashed",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectAbortedAsNoStream(b, runId, "runner crashed");
  });

  test("by the sweep, agent died: no tree, no summary, no incomplete, and its held stream deleted", async () => {
    const b = await board("view-dier", TOMBSTONES_FAST);
    const runId = await open(b);
    await streamView(b, runId);
    const aborted = b.handle.store.sweepOpenRuns(Date.now() + TOMBSTONES_FAST.tombstoneAfterMs * 5);
    expect(aborted.map((e) => e.abortReason)).toEqual(["agent died"]);
    expect(aborted[0]!.summary).toBeUndefined();
    expect(Object.keys(aborted[0]!)).not.toContain("incomplete");
    await expectAbortedAsNoStream(b, runId, "agent died");
  });

  test("by the sweep, abandoned: no tree, no summary, no incomplete, and its held stream deleted", async () => {
    const b = await board("view-loser", NEVER_TOMBSTONED);
    const runId = await open(b);
    await streamView(b, runId);
    const startedAt = b.handle.store.getRun(runId)?.startedAt as number;
    const aborted = b.handle.store.sweepOpenRuns(startedAt + ABANDON_MS);
    expect(aborted.map((e) => e.abortReason)).toEqual(["abandoned"]);
    expect(aborted[0]!.summary).toBeUndefined();
    await expectAbortedAsNoStream(b, runId, "abandoned");
  });
});
