// `POST /api/v2/runs/<runId>/stream` takes an open run's test stream in
// batches `{projectKey, agentId, codec, from, data}` and answers how much of
// it the board holds — on a real server (`startServer`, port 0, ":memory:").
//
// What is held here:
//  - the answer: `200 {ok: true, runId, held}` after every batch, `held`
//    counted in UTF-8 bytes;
//  - resends and gaps: a resend whose overlap matches the held bytes appends
//    only its tail; one whose overlap differs, or a `from` past the held
//    length, is a 409 carrying `held` and appends nothing;
//  - codecs: a codec that is not a stream codec, or one differing from the
//    codec the run's first batch fixed, is a 400;
//  - the size bound: a batch taking the stream past `ingest_body_bytes` in
//    total is a 413 naming the limit and carrying `held`; a body over the
//    limit is a 413 (`readIngestBody`). The limit is set through the operator
//    `crucible.toml`, as tests/an-oversized-ingest-body-is-refused-with-a-json-413.test.ts
//    sets it (tests/helpers/server-limits-fixture.ts);
//  - shape: a `from` that is not a non-negative integer, or a `data` that is
//    missing, not a string or holds a lone surrogate, is a 400;
//  - projects, callers and runs: an unknown or archived project is a 404, an
//    unregistered caller is refused as every ingest refuses it, an unknown run
//    or another project's or agent's run is a 400 as `resolveRunClose`
//    refuses it, and a settled run is a 409 carrying `state` and `eventId`.
//
// "Nothing was stored" is asserted on the board, not only read in the answer:
// after each refusal a resend of exactly the bytes sent before it is answered
// with exactly their length — a refused batch that had appended anything would
// make it longer — and the project's events are unchanged. The route's own
// refusals (run, shape, codec, overlap, gap and size) also state it in their
// error, as every ingest refusal states "run NOT stored"; the project, caller
// and body-size refusals are the shared seams every ingest already answers
// with (`requireProject`, `requireRegisteredCaller`, `readIngestBody`), whose
// wording is asserted as it stands.
import { describe, test, expect, afterEach } from "bun:test";
import { codecs } from "../src/codecs/index.ts";
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
  eventLine,
  openRun,
  postJson,
  readyProject,
  register,
  sendBatch,
  streamRoute,
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

// ── The stream ──────────────────────────────────────────────────────────────

const L_START = eventLine({ event: "run-start", total: 2 });
const L_PASS = eventLine({
  event: "test-end",
  id: "t1",
  name: "adds — café",
  suite: "math",
  file: "src/math.test.ts",
  status: "pass",
  duration_ms: 3,
});
const L_FAIL = eventLine({
  event: "test-end",
  id: "t2",
  name: "divides 😀",
  suite: "math",
  file: "src/math.test.ts",
  status: "fail",
  duration_ms: 4,
  failure: { message: "expected 1" },
});
const L_END = eventLine({ event: "run-end", total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 7 });

/** The character index just past "café" in L_PASS: a cut there falls mid-line, after a two-byte character. */
const AFTER_CAFE = L_PASS.indexOf("café") + "café".length;

/** A refusal states that nothing was stored ("run NOT stored", "nothing stored", …). */
const NOTHING_STORED = /\bnothing (?:was )?stored\b|\bnot stored\b/i;

const GREEN_REPORT = '<testsuite name="green" tests="1"><testcase name="passes" time="0"/></testsuite>';

// ── The subject ─────────────────────────────────────────────────────────────

interface Subject {
  handle: ServerHandle;
  key: string;
  agentId: string;
  runId: string;
}

async function subject(handle: ServerHandle = boot(), agentId = "streamer"): Promise<Subject> {
  const key = await readyProject(handle, [agentId]);
  const runId = await openRun(handle, key, agentId, { stack: "bun", tier: "unit" });
  return { handle, key, agentId, runId };
}

function batch(s: Subject, from: unknown, data: unknown, codec?: unknown): Promise<Answer> {
  return sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: s.agentId, from, data, codec });
}

function eventIds(s: Subject, key = s.key): string[] {
  return s.handle.store.listEvents(key, Number.MAX_SAFE_INTEGER).map((e) => e.id);
}

/** A refusal: the status, `ok: false`, an error, and — for the route's own refusals — the statement that nothing was stored. */
function expectRefused(res: Answer, status: number, statesNothingStored = true): void {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.ok).toBe(false);
  expect(typeof res.body.error).toBe("string");
  if (statesNothingStored) expect(res.body.error as string).toMatch(NOTHING_STORED);
}

/**
 * The board holds exactly `sent`: a resend of it from 0 matches the whole
 * overlap, appends nothing, and is answered with its UTF-8 length. A refused
 * batch that had appended anything would leave the held length longer.
 */
async function expectHolds(s: Subject, sent: string): Promise<void> {
  const res = await batch(s, 0, sent);
  expect(res.status, `probe: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.held).toBe(utf8(sent));
  expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
}

function expectOk(res: Answer, s: Subject, held: number): void {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.runId).toBe(s.runId);
  expect(res.body.held).toBe(held);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v2/runs/<runId>/stream answers how much of the stream the board holds", () => {
  test("each batch is answered 200 {ok: true, runId, held}, held the UTF-8 bytes held so far — a cut mid-line after a multibyte character included", async () => {
    const s = await subject();
    const before = eventIds(s);
    const first = L_START + L_PASS.slice(0, AFTER_CAFE);
    const second = L_PASS.slice(AFTER_CAFE) + L_FAIL;
    expectOk(await batch(s, 0, first), s, utf8(first));
    expectOk(await batch(s, utf8(first), second), s, utf8(first + second));
    expectOk(await batch(s, utf8(first + second), L_END), s, utf8(first + second + L_END));
    // Bytes, not UTF-16 units: the stream holds "—", "é" and "😀".
    expect(utf8(first + second + L_END)).toBeGreaterThan((first + second + L_END).length);
    expect(eventIds(s)).toEqual(before);
  });

  test("a batch stores no event and leaves the run open — the stream is not the close", async () => {
    const s = await subject();
    const before = eventIds(s);
    expectOk(await batch(s, 0, L_START + L_PASS + L_FAIL + L_END), s, utf8(L_START + L_PASS + L_FAIL + L_END));
    expect(eventIds(s)).toEqual(before);
    expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
  });
});

describe("a resend appends only what the board does not hold; a differing overlap or a gap appends nothing", () => {
  test("a resend whose overlap matches the held bytes, from mid-line after a multibyte character, appends only its tail", async () => {
    const s = await subject();
    const held = L_START + L_PASS;
    expectOk(await batch(s, 0, held), s, utf8(held));
    const from = utf8(L_START + L_PASS.slice(0, AFTER_CAFE));
    expectOk(await batch(s, from, L_PASS.slice(AFTER_CAFE) + L_FAIL), s, utf8(held + L_FAIL));
    await expectHolds(s, held + L_FAIL);
  });

  test("a resend of exactly the held bytes appends nothing and answers the same held", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, L_START + L_PASS), s, utf8(L_START + L_PASS));
    expectOk(await batch(s, utf8(L_START), L_PASS), s, utf8(L_START + L_PASS));
    await expectHolds(s, L_START + L_PASS);
  });

  test("a resend whose overlap differs from the held bytes is a 409 carrying held, and appends nothing", async () => {
    const s = await subject();
    const held = L_START + L_PASS;
    expectOk(await batch(s, 0, held), s, utf8(held));
    const differing = L_PASS.replace('"pass"', '"fail"') + L_FAIL;
    const res = await batch(s, utf8(L_START), differing);
    expectRefused(res, 409);
    expect(res.body.held).toBe(utf8(held));
    await expectHolds(s, held);
  });

  test("a batch whose from is past the held length is a gap: a 409 carrying held, and nothing appended", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    const res = await batch(s, utf8(L_START) + 1, L_PASS);
    expectRefused(res, 409);
    expect(res.body.held).toBe(utf8(L_START));
    await expectHolds(s, L_START);
  });

  test("a first batch from past 0 is a gap: a 409 carrying held 0", async () => {
    const s = await subject();
    const res = await batch(s, 5, L_START);
    expectRefused(res, 409);
    expect(res.body.held).toBe(0);
    await expectHolds(s, "");
  });
});

describe("a batch names a stream codec, the same one for the whole run", () => {
  test("a codec that is not a stream codec — junit, playwright, or one the board does not know — is a 400, nothing stored", async () => {
    const s = await subject();
    for (const codec of ["junit", "playwright", "no-such-codec"]) {
      expectRefused(await batch(s, 0, L_START, codec), 400);
    }
    expectRefused(await batch(s, 0, L_START, 42), 400);
    await expectHolds(s, "");
    // The refused batches fixed no codec: the stream codec is still taken.
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
  });

  test("a codec differing from the stream codec the run's first batch fixed is a 400, nothing stored", async () => {
    const probe = "probe-stream-codec";
    codecs.set(probe, { parse: () => ({ summary: { total: 0, passed: 0, failed: 0, pending: 0, duration_ms: 0 }, tree: [] }), stream: true });
    try {
      const handle = boot();
      // The probe codec IS a stream codec the route takes as a run's first.
      const control = await subject(handle, "control");
      expectOk(await batch(control, 0, L_START, probe), control, utf8(L_START));

      const s = await subject(handle, "streamer");
      expectOk(await batch(s, 0, L_START), s, utf8(L_START));
      const res = await batch(s, utf8(L_START), L_PASS, probe);
      expectRefused(res, 400);
      await expectHolds(s, L_START);
    } finally {
      codecs.delete(probe);
    }
  });
});

// ── The size bound ──────────────────────────────────────────────────────────

/** A stream line of exactly `bytes` UTF-8 bytes, of a kind no codec knows. */
function padLine(bytes: number): string {
  const head = '{"event":"pad","fill":"';
  const tail = '"}\n';
  return `${head}${"a".repeat(bytes - head.length - tail.length)}${tail}`;
}

function bodyLimitAt(limit: number): void {
  const shipped = shippedLimits().ingest_body_bytes;
  expect(shipped, "src/crucible.toml declares no [limits.ingest_body_bytes] table").toBeDefined();
  if (shipped === undefined) return;
  writeConfig(serverConfigDir(), { ingest_body_bytes: declare(shipped, limit) });
}

const SLOW = 30_000;

describe("a stream's total is bounded by ingest_body_bytes", () => {
  test(
    "a stream reaching the limit exactly is held; the batch taking it past is a 413 naming the limit and carrying held, nothing appended",
    async () => {
      const limit = shippedLimits().ingest_body_bytes?.min ?? 1048576;
      bodyLimitAt(limit);
      const s = await subject(bootWithOperatorFile());
      const before = eventIds(s);
      const first = padLine(600_000);
      const second = padLine(limit - 600_000);
      expectOk(await batch(s, 0, first), s, 600_000);
      expectOk(await batch(s, 600_000, second), s, limit);

      const past = await batch(s, limit, L_START);
      expectRefused(past, 413);
      expect(past.body.error as string).toContain("ingest_body_bytes");
      expect(past.body.error as string).toContain(String(limit));
      expect(past.body.held).toBe(limit);

      // Nothing was appended: the same batch is refused again at the same held.
      const again = await batch(s, limit, L_START);
      expectRefused(again, 413);
      expect(again.body.held).toBe(limit);
      expect(eventIds(s)).toEqual(before);
      expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
    },
    SLOW,
  );

  test(
    "a request body over ingest_body_bytes is a 413 naming the limit, and nothing is stored",
    async () => {
      const limit = shippedLimits().ingest_body_bytes?.min ?? 1048576;
      bodyLimitAt(limit);
      const s = await subject(bootWithOperatorFile());
      const valid = JSON.stringify({ projectKey: s.key, agentId: s.agentId, codec: "crucible-events", from: 0, data: L_START });
      const res = await postJson(s.handle, streamRoute(s.runId), valid + " ".repeat(limit + 4096 - valid.length));
      expectRefused(res, 413, false);
      expect(res.body.error as string).toContain("ingest_body_bytes");
      expect(res.body.error as string).toContain(String(limit));
      await expectHolds(s, "");
      expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    },
    SLOW,
  );
});

// ── Shape ───────────────────────────────────────────────────────────────────

describe("a batch's from and data are checked before anything is stored", () => {
  test("a from that is not a non-negative integer — negative, fractional, a string, null or missing — is a 400, nothing stored", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    for (const from of [-1, 1.5, String(utf8(L_START)), null, undefined]) {
      const res = await batch(s, from, L_PASS);
      expectRefused(res, 400);
    }
    await expectHolds(s, L_START);
  });

  test("a data that is missing, not a string, or holds a lone surrogate is a 400, nothing stored", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    const loneHigh = `{"event":"test-end","name":"x${String.fromCharCode(0xd800)}","status":"pass"}\n`;
    const loneLow = `${String.fromCharCode(0xdc00)}\n`;
    for (const data of [undefined, 42, [L_PASS], loneHigh, loneLow]) {
      const res = await batch(s, utf8(L_START), data);
      expectRefused(res, 400);
    }
    await expectHolds(s, L_START);
  });
});

// ── Projects, callers and runs ──────────────────────────────────────────────

describe("a batch is refused for a project, caller or run the route cannot take it for", () => {
  test("an unknown project is a 404 'unknown project: <key>', and the run's stream is untouched", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    const unknown = crypto.randomUUID();
    const res = await sendBatch(s.handle, s.runId, { projectKey: unknown, agentId: s.agentId, from: utf8(L_START), data: L_PASS });
    expectRefused(res, 404, false);
    expect(res.body.error).toBe(`unknown project: ${unknown}`);
    await expectHolds(s, L_START);
  });

  test("an archived project is a 404 'project is archived: <key>', and nothing is appended", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    s.handle.store.archiveProject(s.key);
    const res = await batch(s, utf8(L_START), L_PASS);
    expectRefused(res, 404, false);
    expect(res.body.error).toBe(`project is archived: ${s.key}`);
    expect(Array.isArray(res.body.help)).toBe(true);
    s.handle.store.unarchiveProject(s.key);
    await expectHolds(s, L_START);
  });

  test("an unregistered caller is refused as every ingest refuses it — a 409 naming the agent — and nothing is appended", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    const res = await sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: "never-registered", from: utf8(L_START), data: L_PASS });
    expectRefused(res, 409, false);
    expect(res.body.error).toBe("agent never-registered is not registered with this project — refused");
    await expectHolds(s, L_START);
  });

  test("an unknown run is a 400 naming it, and nothing is stored", async () => {
    const s = await subject();
    const before = eventIds(s);
    const res = await sendBatch(s.handle, "no-such-run", { projectKey: s.key, agentId: s.agentId, from: 0, data: L_START });
    expectRefused(res, 400);
    expect(res.body.error as string).toContain("unknown runId: no-such-run");
    expect(eventIds(s)).toEqual(before);
    await expectHolds(s, "");
  });

  test("another agent's run is a 400 naming its owner, and nothing is appended", async () => {
    const s = await subject();
    await register(s.handle, s.key, "intruder");
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    const res = await sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: "intruder", from: utf8(L_START), data: L_PASS });
    expectRefused(res, 400);
    expect(res.body.error as string).toContain(`belongs to agent ${s.agentId}`);
    await expectHolds(s, L_START);
  });

  test("another project's run is a 400, and nothing is appended", async () => {
    const s = await subject();
    const otherKey = await readyProject(s.handle, [s.agentId], "other-project");
    const before = eventIds(s, otherKey);
    expectOk(await batch(s, 0, L_START), s, utf8(L_START));
    const res = await sendBatch(s.handle, s.runId, { projectKey: otherKey, agentId: s.agentId, from: utf8(L_START), data: L_PASS });
    expectRefused(res, 400);
    expect(res.body.error as string).toContain(`runId ${s.runId}`);
    expect(eventIds(s, otherKey)).toEqual(before);
    await expectHolds(s, L_START);
  });

  test("a run closed by its ingest is a 409 carrying state 'ended' and the event that closed it, and nothing is stored", async () => {
    const s = await subject();
    const closed = await postJson(s.handle, "/api/v2/runs", {
      projectKey: s.key,
      agentId: s.agentId,
      runId: s.runId,
      codec: "junit",
      data: GREEN_REPORT,
    });
    expect(closed.status).toBe(200);
    const before = eventIds(s);
    const res = await batch(s, 0, L_START);
    expectRefused(res, 409);
    expect(res.body.state).toBe("ended");
    expect(res.body.eventId).toBe(closed.body.event);
    expect(eventIds(s)).toEqual(before);
    expect(s.handle.store.getRun(s.runId)?.state).toBe("ended");
  });

  test("an aborted run is a 409 carrying state 'aborted' and its aborted event, and nothing is stored", async () => {
    const s = await subject();
    const aborted = await postJson(s.handle, `/api/v2/runs/${s.runId}/abort`, {
      projectKey: s.key,
      agentId: s.agentId,
      reason: "runner killed",
    });
    expect(aborted.status).toBe(200);
    const eventId = s.handle.store.getRun(s.runId)?.eventId;
    expect(typeof eventId).toBe("string");
    const before = eventIds(s);
    const res = await batch(s, 0, L_START);
    expectRefused(res, 409);
    expect(res.body.state).toBe("aborted");
    expect(res.body.eventId).toBe(eventId);
    expect(eventIds(s)).toEqual(before);
  });
});
