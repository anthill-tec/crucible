// A streamed run whose stream cannot be trusted is stored flagged
// `incomplete`, the reason stated — on a real server (`startServer`, port 0,
// ":memory:", or the operator `crucible.toml` for the size bound).
//
// One stream is closed for each reason the codec states, in its own words:
//  - no `run-end`                                  "no run-end"
//  - `run-end` totals that differ from the tests   "run-end states …, the tests count …"
//  - a test after `run-end`                        "a test after run-end"
//  - undecodable lines                             "2 undecodable lines"
//  - a stream cut at `ingest_body_bytes`           "cut at ingest_body_bytes"
//
// For each, the reason is:
//  - stored on the run's event as `incomplete`;
//  - answered at close as the warning `{code: "stream-incomplete", detail}`,
//    the detail stating it;
//  - served on the run detail read `GET /api/v2/events/<id>` and on the event
//    brief (`GET /api/v2/events?project=<key>`).
//
// A complete stream's run carries NO `incomplete` key on any of the three, and
// its close answers no `stream-incomplete` warning.
//
// The cut stream uses the operator-limit fixture the stream route's own size
// test uses (tests/helpers/server-limits-fixture.ts).
import { describe, test, expect, afterEach } from "bun:test";
import { shippedLimits } from "../src/limits.ts";
import type { ServerHandle } from "../src/server.ts";
import {
  boot as bootWithOperatorFile,
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
} from "./helpers/server-limits-fixture.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  getJson,
  openRun,
  readyProject,
  sendBatch,
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
const L_PASS_A = eventLine({ event: "test-end", id: "t1", name: "adds", suite: "math", status: "pass", duration_ms: 3 });
const L_PASS_B = eventLine({ event: "test-end", id: "t2", name: "subtracts", suite: "math", status: "pass", duration_ms: 4 });
const L_END_TWO = eventLine({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 });
const L_END_ONE = eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 3 });

/** Two lines the codec cannot read: one is not JSON, one is a test-end with no name. */
const UNDECODABLE = 'not a json line\n{"event":"test-end","status":"pass"}\n';

interface Case {
  label: string;
  stream: string;
  reason: string;
}

const CASES: readonly Case[] = [
  { label: "a stream with no run-end", stream: L_START + L_PASS_A + L_PASS_B, reason: "no run-end" },
  {
    label: "a stream whose run-end totals differ from its tests",
    stream: L_START + L_PASS_A + L_END_TWO,
    reason:
      "run-end states total 2, passed 2, failed 0, pending 0, the tests count total 1, passed 1, failed 0, pending 0",
  },
  {
    label: "a stream with a test after its run-end",
    // The run-end's counts are read against every test, the late one
    // included, so these agree and the late test is the only reason.
    stream: L_START + L_PASS_A + L_END_TWO + L_PASS_B,
    reason: "a test after run-end",
  },
  {
    label: "a stream whose run-end disagrees AND holds a test after it",
    stream: L_START + L_PASS_A + L_END_ONE + L_PASS_B,
    // Every reason is stated, in the codec's order, joined by "; ".
    reason:
      "run-end states total 1, passed 1, failed 0, pending 0, the tests count total 2, passed 2, failed 0, pending 0; a test after run-end",
  },
  {
    label: "a stream holding undecodable lines",
    stream: L_START + L_PASS_A + UNDECODABLE + L_PASS_B + L_END_TWO,
    reason: "2 undecodable lines",
  },
];

/** A complete stream: two passes and a run-end that agrees. */
const COMPLETE = L_START + L_PASS_A + L_PASS_B + L_END_TWO;

// ── The subject ─────────────────────────────────────────────────────────────

interface Closed {
  handle: ServerHandle;
  key: string;
  answer: Answer;
  eventId: string;
}

async function closeOne(stream: string, handle: ServerHandle = boot()): Promise<Closed> {
  const key = await readyProject(handle, ["flagger"]);
  const runId = await openRun(handle, key, "flagger", { stack: "bun", tier: "unit" });
  const sent = await sendBatch(handle, runId, { projectKey: key, agentId: "flagger", from: 0, data: stream });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const answer = await closeStream(handle, key, "flagger", runId);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(typeof answer.body.event).toBe("string");
  return { handle, key, answer, eventId: answer.body.event as string };
}

/** The run's brief on the events list the timeline reads. */
async function brief(c: Closed): Promise<Record<string, unknown>> {
  const list = await getJson(c.handle, `/api/v2/events?project=${c.key}`);
  const found = (list.events as Array<Record<string, unknown>>).filter((e) => e.id === c.eventId);
  expect(found.length, "the run's brief is listed exactly once").toBe(1);
  return found[0]!;
}

function incompleteWarnings(answer: Answer): Array<{ code: string; detail: string }> {
  const warnings = (answer.body.warnings ?? []) as Array<{ code: string; detail: string }>;
  return warnings.filter((w) => w.code === "stream-incomplete");
}

/** Every surface states `reason`: the stored event, the close's warning, the detail read and the brief. */
async function expectFlagged(c: Closed, reason: string): Promise<void> {
  const event = await storedEvent(c.handle, c.eventId);
  expect(event.incomplete).toBe(reason);
  const warnings = incompleteWarnings(c.answer);
  expect(warnings.length, JSON.stringify(c.answer.body.warnings)).toBe(1);
  expect(warnings[0]!.detail).toContain(reason);
  expect((await brief(c)).incomplete).toBe(reason);
  const stored = c.handle.store.listEvents(c.key, Number.MAX_SAFE_INTEGER).find((e) => e.id === c.eventId);
  expect((stored as { incomplete?: unknown } | undefined)?.incomplete).toBe(reason);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a stream the board cannot trust is stored flagged incomplete, the reason on every surface", () => {
  for (const c of CASES) {
    test(`${c.label}: incomplete is "${c.reason}" on the event, the close's stream-incomplete warning, the detail read and the brief`, async () => {
      await expectFlagged(await closeOne(c.stream), c.reason);
    });
  }

  test("the record of a flagged stream is still its tests: the counts come from the leaves, nothing dropped", async () => {
    const closed = await closeOne(L_START + L_PASS_A + UNDECODABLE + L_PASS_B + L_END_TWO);
    const event = await storedEvent(closed.handle, closed.eventId);
    expect(event.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 });
    expect(event.incomplete).toBe("2 undecodable lines");
  });
});

// ── The size bound ──────────────────────────────────────────────────────────

/** A stream line of exactly `bytes` UTF-8 bytes, of a kind no codec knows. */
function padLine(bytes: number): string {
  const head = '{"event":"pad","fill":"';
  const tail = '"}\n';
  return `${head}${"a".repeat(bytes - head.length - tail.length)}${tail}`;
}

const SLOW = 30_000;

describe("a stream cut at ingest_body_bytes is stored flagged incomplete", () => {
  test(
    'a complete stream whose next batch was refused at the size bound is flagged "cut at ingest_body_bytes" on every surface',
    async () => {
      const shipped = shippedLimits().ingest_body_bytes;
      expect(shipped, "src/crucible.toml declares no [limits.ingest_body_bytes] table").toBeDefined();
      if (shipped === undefined) return;
      const limit = shipped.min;
      writeConfig(serverConfigDir(), { ingest_body_bytes: declare(shipped, limit) });
      const handle = bootWithOperatorFile();
      const key = await readyProject(handle, ["cutter"]);
      const runId = await openRun(handle, key, "cutter", { stack: "bun", tier: "unit" });

      // The whole stream, padded to exactly the limit, is held…
      const pad = padLine(limit - utf8(COMPLETE));
      const first = await sendBatch(handle, runId, { projectKey: key, agentId: "cutter", from: 0, data: COMPLETE });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const second = await sendBatch(handle, runId, {
        projectKey: key,
        agentId: "cutter",
        from: utf8(COMPLETE),
        data: pad,
      });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.held).toBe(limit);
      // …and the batch past it is refused, which cuts the stream.
      const past = await sendBatch(handle, runId, { projectKey: key, agentId: "cutter", from: limit, data: L_PASS_A });
      expect(past.status, JSON.stringify(past.body)).toBe(413);

      const answer = await closeStream(handle, key, "cutter", runId);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const closed: Closed = { handle, key, answer, eventId: answer.body.event as string };
      const event = await storedEvent(handle, closed.eventId);
      expect(event.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 });
      await expectFlagged(closed, "cut at ingest_body_bytes");
    },
    SLOW,
  );
});

// ── A complete stream ───────────────────────────────────────────────────────

describe("a complete stream's run carries no incomplete key", () => {
  test("not on the stored event, the detail read or the brief, and its close answers no stream-incomplete warning", async () => {
    const closed = await closeOne(COMPLETE);
    const event = await storedEvent(closed.handle, closed.eventId);
    expect(event.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 7 });
    expect(Object.keys(event)).not.toContain("incomplete");
    expect(Object.keys(await brief(closed))).not.toContain("incomplete");
    const stored = closed.handle.store.listEvents(closed.key, Number.MAX_SAFE_INTEGER).find((e) => e.id === closed.eventId);
    expect(stored).toBeDefined();
    expect(Object.keys(stored!)).not.toContain("incomplete");
    expect(incompleteWarnings(closed.answer)).toEqual([]);
  });

  test("a junit report closing a run (no stream at all) carries no incomplete key", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["reporter"]);
    const runId = await openRun(handle, key, "reporter", { stack: "bun", tier: "unit" });
    const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/v2/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: key,
        agentId: "reporter",
        runId,
        codec: "junit",
        data: '<testsuite name="s" tests="1"><testcase name="t" time="0"/></testsuite>',
      }),
    });
    expect(res.status).toBe(200);
    const eventId = ((await res.json()) as { event: string }).event;
    const event = await storedEvent(handle, eventId);
    expect(Object.keys(event)).not.toContain("incomplete");
  });
});
