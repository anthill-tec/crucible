// The live state of an OPEN run, as the board serves it (CR-CRU-223 §S1/AC4):
//
//   Store#runLive(runId) -> RunLive | null        // null in this CR; CR-CRU-200 fills it
//   GET /api/v2/events -> openRuns[i].live         // {completed, total?, passed, failed,
//                                                  //  pending, currentFile?} — only those
//   GET /api/v2/runs/<runId>/live[?from=<n>] ->
//     open, live state held  {state: "open", live: {…}, failures: [...from n], failuresFrom: n}
//     settled                {state: "ended" | "aborted", eventId}
//     open, no live state    404
//     unknown run id         404
//
// The live state is filled by CR-CRU-200 from a test stream; this CR only
// reads it. Every test here therefore drives a REAL server and a REAL run
// (POST /api/v2/runs/start, a real ingest, a real abort) and STUBS the one
// read the stream would answer — `Store#runLive` on the server's own store
// instance — never a write path. The stub records the run ids it was asked
// for, so each answer is proved to come from the read, not from a constant.
//
// tests/run-lifecycle-read-surface.test.ts (no top-level counts on an open-run
// brief) is the companion contract and is deliberately left untouched.
//
// SAFETY: every server binds port 0 and every store is ":memory:".
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import type { RunLive, RunLiveFailure } from "../src/types.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

const base = (handle: ServerHandle): string => `http://127.0.0.1:${handle.server.port}`;

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function seedProject(handle: ServerHandle): string {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "Live", type: "backend", sutRoot: "/tmp/live" });
  return key;
}

async function register(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
}

async function startRun(handle: ServerHandle, key: string, agentId: string): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId, tier: "unit" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { runId: string };
  return body.runId;
}

const PARSED_RUN = {
  summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 7 },
  tree: [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 7 }] }],
};

// The F25 run: 412 of 1280 finished, three failures, the last in a file of
// its own and with no message — only its type.
const FAILURES: RunLiveFailure[] = [
  {
    id: "f-1",
    name: "test_acks_each_batch",
    suite: "test_relay.RelayTest",
    file: "test_relay.py",
    message: "AssertionError: 3 != 4 : the board acknowledged 3 batches",
  },
  {
    id: "f-2",
    name: "test_close_sends_the_rest",
    suite: "test_relay.RelayTest",
    file: "test_relay.py",
    message: "AssertionError: offset 4096 never sent",
  },
  {
    id: "f-3",
    name: "test_run_end_totals",
    suite: "test_stream.StreamTest",
    file: "test_stream.py",
    type: "KeyError",
  },
];

const LIVE: RunLive = {
  completed: 412,
  total: 1280,
  passed: 409,
  failed: 3,
  pending: 0,
  currentFile: "test_relay.py",
  failures: FAILURES,
};

/** §S1's six keys, exactly — what `live` carries on the brief and the route. */
const LIVE_COUNTS = {
  completed: 412,
  total: 1280,
  passed: 409,
  failed: 3,
  pending: 0,
  currentFile: "test_relay.py",
};

/**
 * Stub the live-state read on the server's own store: `answers` maps a run id
 * to its live state, every other id answers null (no live state held). The
 * returned array is every run id the read was asked for, in order.
 */
function stubRunLive(handle: ServerHandle, answers: Record<string, RunLive>): string[] {
  const asked: string[] = [];
  handle.store.runLive = (runId: string): RunLive | null => {
    asked.push(runId);
    return answers[runId] ?? null;
  };
  return asked;
}

/**
 * GET the live read and its JSON body. Every answer the route gives (the
 * 200s and the 404s alike) is a JSON object, so an answer that is not one
 * fails here with its status and its raw text, never quietly as a null body.
 */
async function liveOf(
  handle: ServerHandle,
  runId: string,
  query = "",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = `/api/v2/runs/${encodeURIComponent(runId)}/live${query}`;
  const res = await fetch(`${base(handle)}${path}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`GET ${path} answered ${res.status} with a body that is not JSON: ${JSON.stringify(text)}`, {
      cause: err,
    });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`GET ${path} answered ${res.status} with JSON that is not an object: ${text}`);
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

interface OpenRunBriefWire {
  runId: string;
  [key: string]: unknown;
}

function openRunsOf(body: Record<string, unknown>): OpenRunBriefWire[] {
  expect(Array.isArray(body.openRuns)).toBe(true);
  return body.openRuns as OpenRunBriefWire[];
}

describe("GET /api/v2/runs/<runId>/live — an OPEN run with a live state answers its counts and its failures", () => {
  test("answers state open, §S1's six counts, every failure oldest first, and failuresFrom 0 — read from Store#runLive for that run", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "live-a");
    const runId = await startRun(handle, key, "live-a");
    const asked = stubRunLive(handle, { [runId]: LIVE });

    const { status, body } = await liveOf(handle, runId);

    expect(status).toBe(200);
    expect(body?.state).toBe("open");
    expect(body?.live).toEqual(LIVE_COUNTS);
    // The failures ride beside the counts, never inside them.
    expect(body?.live as Record<string, unknown>).not.toHaveProperty("failures");
    expect(body?.failures).toEqual(FAILURES);
    expect(body?.failuresFrom).toBe(0);
    // A settled-run key on an open answer would let the view settle a run
    // that is still running.
    expect(body).not.toHaveProperty("eventId");
    expect(asked).toContain(runId);
  });

  test("`?from=2` answers the failures from index 2 only, with failuresFrom 2; `?from=3` answers none, with failuresFrom 3", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "live-b");
    const runId = await startRun(handle, key, "live-b");
    stubRunLive(handle, { [runId]: LIVE });

    const fromTwo = await liveOf(handle, runId, "?from=2");
    expect(fromTwo.status).toBe(200);
    expect(fromTwo.body?.state).toBe("open");
    expect(fromTwo.body?.failures).toEqual([FAILURES[2]]);
    expect(fromTwo.body?.failuresFrom).toBe(2);
    // `from` narrows the failures, never the counts.
    expect(fromTwo.body?.live).toEqual(LIVE_COUNTS);

    const fromThree = await liveOf(handle, runId, "?from=3");
    expect(fromThree.status).toBe(200);
    expect(fromThree.body?.failures).toEqual([]);
    expect(fromThree.body?.failuresFrom).toBe(3);

    const fromZero = await liveOf(handle, runId, "?from=0");
    expect(fromZero.body?.failures).toEqual(FAILURES);
    expect(fromZero.body?.failuresFrom).toBe(0);
  });

  test("a live state with no total and no current file answers `live` WITHOUT those keys — absent, never null", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "live-c");
    const runId = await startRun(handle, key, "live-c");
    stubRunLive(handle, {
      [runId]: { completed: 412, passed: 410, failed: 2, pending: 0, failures: FAILURES.slice(0, 2) },
    });

    const { status, body } = await liveOf(handle, runId);

    expect(status).toBe(200);
    expect(body?.live).toEqual({ completed: 412, passed: 410, failed: 2, pending: 0 });
    expect(body?.live as Record<string, unknown>).not.toHaveProperty("total");
    expect(body?.live as Record<string, unknown>).not.toHaveProperty("currentFile");
    expect(body?.failures).toEqual(FAILURES.slice(0, 2));
  });
});

describe("GET /api/v2/runs/<runId>/live — a SETTLED run answers its state and the event that settled it", () => {
  test("a run its ingest ended answers {state: ended, eventId} naming the run's own event — and no live counts, even if a live state is still held", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "live-d");
    const runId = await startRun(handle, key, "live-d");
    // A live state still held for the run must not outrank its settlement.
    stubRunLive(handle, { [runId]: LIVE });
    const ingest = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "live-d",
      runId,
      ...PARSED_RUN,
    });
    expect(ingest.status).toBe(200);
    const eventId = handle.store.getRun(runId)?.eventId;
    expect(typeof eventId).toBe("string");

    const { status, body } = await liveOf(handle, runId);

    expect(status).toBe(200);
    expect(body?.state).toBe("ended");
    expect(body?.eventId).toBe(eventId as string);
    // An event id never carries the open run's `run-` prefix — the view
    // tells a live drill-in from a settled one by it.
    expect(String(body?.eventId).startsWith("run-")).toBe(false);
    expect(body).not.toHaveProperty("live");
    expect(body).not.toHaveProperty("failures");
  });

  test("a run its agent aborted answers {state: aborted, eventId} naming the aborted run's event", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "live-e");
    const runId = await startRun(handle, key, "live-e");
    const abort = await postJson(handle, `/api/v2/runs/${runId}/abort`, {
      projectKey: key,
      agentId: "live-e",
      reason: "runner crashed",
    });
    expect(abort.status).toBe(200);
    const eventId = handle.store.getRun(runId)?.eventId;
    expect(typeof eventId).toBe("string");

    const { status, body } = await liveOf(handle, runId);

    expect(status).toBe(200);
    expect(body?.state).toBe("aborted");
    expect(body?.eventId).toBe(eventId as string);
    expect(body).not.toHaveProperty("live");
  });
});

describe("GET /api/v2/runs/<runId>/live — 404 when there is nothing live to show", () => {
  test("an OPEN run whose board holds no live state is a 404, and Store#runLive answers null for it in this CR", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "live-f");
    const runId = await startRun(handle, key, "live-f");

    // No stub: the store's own read, which this CR ships answering nothing.
    expect(handle.store.runLive(runId)).toBeNull();
    const { status, body } = await liveOf(handle, runId);

    expect(status).toBe(404);
    expect(body?.state).toBeUndefined();
  });

  test("an unknown run id is a 404, and an unknown id the stub holds nothing for is never answered as open", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "live-g");
    const runId = await startRun(handle, key, "live-g");
    stubRunLive(handle, { [runId]: LIVE });

    const unknown = await liveOf(handle, "run-00000000-0000-7000-8000-000000000000");
    expect(unknown.status).toBe(404);
    expect(unknown.body?.state).toBeUndefined();

    // Non-vacuity: the same board answers the known run, so the 404 above is
    // about the id and not a route that answers nothing.
    const known = await liveOf(handle, runId);
    expect(known.status).toBe(200);
    expect(known.body?.state).toBe("open");
  });
});

describe("the open-run brief's `live` (openRuns[] on GET /api/v2/events) — §S1's keys only, and only when a live state is held", () => {
  test("a run with a live state carries `live` holding exactly §S1's six keys — no failure list — and every other brief key is unchanged; a run without one carries no `live`", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "brief-live");
    await register(handle, key, "brief-plain");
    const liveRun = await startRun(handle, key, "brief-live");
    const plainRun = await startRun(handle, key, "brief-plain");
    const asked = stubRunLive(handle, { [liveRun]: LIVE });

    const open = openRunsOf(await getJson(handle, `/api/v2/events?project=${key}`));
    expect(open).toHaveLength(2);
    const withLive = open.find((r) => r.runId === liveRun);
    const without = open.find((r) => r.runId === plainRun);
    expect(withLive).toBeDefined();
    expect(without).toBeDefined();

    expect(withLive?.live).toEqual(LIVE_COUNTS);
    expect(Object.keys(withLive?.live as Record<string, unknown>).sort()).toEqual(
      ["completed", "currentFile", "failed", "passed", "pending", "total"],
    );
    expect(without).not.toHaveProperty("live");
    // "No other key of the brief changes": the live brief's keys are the
    // plain brief's keys plus `live`, and no count leaks to the top level.
    const keysOf = (r: OpenRunBriefWire | undefined): string[] => Object.keys(r ?? {}).sort();
    expect(keysOf(withLive).filter((k) => k !== "live")).toEqual(keysOf(without));
    for (const forbidden of ["completed", "total", "passed", "failed", "pending", "failures"]) {
      expect(withLive as Record<string, unknown>).not.toHaveProperty(forbidden);
    }
    // The brief was read from the store's live state for that run.
    expect(asked).toContain(liveRun);
  });

  test("a live state whose runner gave no total, or a total of 0, serves `live` with no `total` key at all", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "brief-nototal");
    await register(handle, key, "brief-zerototal");
    const noTotal = await startRun(handle, key, "brief-nototal");
    const zeroTotal = await startRun(handle, key, "brief-zerototal");
    stubRunLive(handle, {
      [noTotal]: { completed: 412, passed: 409, failed: 3, pending: 0, currentFile: "test_relay.py", failures: FAILURES },
      [zeroTotal]: {
        completed: 412,
        total: 0,
        passed: 409,
        failed: 3,
        pending: 0,
        currentFile: "test_relay.py",
        failures: FAILURES,
      },
    });

    const open = openRunsOf(await getJson(handle, `/api/v2/events?project=${key}`));
    const expected = { completed: 412, passed: 409, failed: 3, pending: 0, currentFile: "test_relay.py" };
    expect(open.find((r) => r.runId === noTotal)?.live).toEqual(expected);
    expect(open.find((r) => r.runId === zeroTotal)?.live).toEqual(expected);
  });

  test("with the store's own read (no live state held in this CR) no open-run brief carries `live`", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "brief-none");
    const runId = await startRun(handle, key, "brief-none");

    expect(handle.store.runLive(runId)).toBeNull();
    const open = openRunsOf(await getJson(handle, `/api/v2/events?project=${key}`));
    expect(open).toHaveLength(1);
    expect(open[0]?.runId).toBe(runId);
    expect(open[0]).not.toHaveProperty("live");
  });
});
