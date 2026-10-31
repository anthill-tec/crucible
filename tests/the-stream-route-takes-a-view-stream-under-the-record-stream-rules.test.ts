// `POST /api/v2/runs/<runId>/stream` takes a VIEW stream — codec
// `bun-console` — under exactly the rules it holds a record stream to
// (CR-CRU-201 §S1, AC1; the rules are CR-CRU-200's, unchanged):
//  - offsets: each batch answered `200 {ok, runId, held}`, `held` in UTF-8
//    bytes, a cut mid-line after a multibyte glyph included;
//  - overlap: a resend whose overlap matches appends only its tail; one whose
//    overlap differs is a 409 carrying `held`, nothing appended;
//  - gap: a `from` past the held length is a 409 carrying `held`;
//  - the size bound: a batch taking the stream past `ingest_body_bytes` is a
//    413 naming the limit and carrying `held` (the limit set through the
//    operator `crucible.toml`, as tests/run-stream-route-takes-batches.test.ts
//    sets it);
//  - one codec per run, fixed by its first batch: a view stream's run refuses
//    a `crucible-events` batch, and a record stream's run refuses a
//    `bun-console` batch, each a 400 naming the codec the first batch fixed;
//  - the quiet touch: a batch moves the agent's `lastSeen` and emits no
//    `agents` change;
//  - the throttled frames: a view batch that changes the live state emits the
//    project's `events` change at once, a second inside `LIVE_FRAME_MS` is
//    deferred to the window's end — driven on the Store's scheduler seam with
//    a hand-moved clock, as tests/live-frames-are-throttled-per-project.test.ts
//    drives it.
//
// The batches are cut from a real bun console capture
// (tests/fixtures/bun-console-live-captures.ts).
//
// SAFETY: every server binds port 0; every store is ":memory:".
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { resolveLimit, shippedLimits } from "../src/limits.ts";
import type { ServerHandle } from "../src/server.ts";
import { LIVE_FRAME_MS, Store, type ChangeKind } from "../src/store.ts";
import {
  boot as bootWithOperatorFile,
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
} from "./helpers/server-limits-fixture.ts";
import { bootOn, eventLine, openRun, readyProject, sendBatch, utf8, type Answer } from "./helpers/run-stream-harness.ts";
import { COLOURED_RUN, PLAIN_RUN } from "./fixtures/bun-console-live-captures.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  setSystemTime();
  while (handles.length > 0) handles.pop()?.stop();
  restoreServerLimitsFixture();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const VIEW_CODEC = "bun-console";

/** A refusal states that nothing was stored. */
const NOTHING_STORED = /\bnothing (?:was )?stored\b|\bnot stored\b/i;

interface Subject {
  handle: ServerHandle;
  key: string;
  agentId: string;
  runId: string;
}

async function subject(handle: ServerHandle = boot(), agentId = "viewer"): Promise<Subject> {
  const key = await readyProject(handle, [agentId], "view-stream-route");
  const runId = await openRun(handle, key, agentId, { stack: "bun", tier: "unit" });
  return { handle, key, agentId, runId };
}

function batch(s: Subject, from: unknown, data: unknown, codec: unknown = VIEW_CODEC): Promise<Answer> {
  return sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: s.agentId, from, data, codec });
}

function expectOk(res: Answer, s: Subject, held: number): void {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.runId).toBe(s.runId);
  expect(res.body.held).toBe(held);
}

function expectRefused(res: Answer, status: number): void {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.ok).toBe(false);
  expect(String(res.body.error)).toMatch(NOTHING_STORED);
}

/** The board holds exactly `sent`: a resend of it from 0 appends nothing and answers its UTF-8 length. */
async function expectHolds(s: Subject, sent: string): Promise<void> {
  const res = await batch(s, 0, sent);
  expect(res.status, `probe: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.held).toBe(utf8(sent));
  expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
}

/** Just past the `✓` glyph (three UTF-8 bytes) of the coloured capture's first result line: a cut mid-line. */
const AFTER_GLYPH = COLOURED_RUN.indexOf("\u2713") + 1;

/** The plain capture up to its first `(fail)` line, and that line onward. */
const PLAIN_HEAD = PLAIN_RUN.slice(0, PLAIN_RUN.indexOf("(fail)"));
const PLAIN_TAIL = PLAIN_RUN.slice(PLAIN_HEAD.length);

// ═══════════════════════════════════════════════════════════════════════════

describe("a view stream's batches are answered with the UTF-8 bytes held", () => {
  test("each bun-console batch is answered 200 {ok, runId, held} — a cut mid-line just after a multibyte ✓ included — and stores no event", async () => {
    const s = await subject();
    const before = s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).length;
    const first = COLOURED_RUN.slice(0, AFTER_GLYPH);
    const second = COLOURED_RUN.slice(AFTER_GLYPH);
    expectOk(await batch(s, 0, first), s, utf8(first));
    expectOk(await batch(s, utf8(first), second), s, utf8(COLOURED_RUN));
    expect(utf8(first)).toBeGreaterThan(first.length);
    expect(s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).length).toBe(before);
    expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
  });
});

describe("a view stream's resends and gaps are held to the record stream's rules", () => {
  test("a resend whose overlap matches the held bytes appends only its tail", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, PLAIN_HEAD), s, utf8(PLAIN_HEAD));
    const from = utf8(PLAIN_HEAD) - 20;
    expectOk(await batch(s, from, PLAIN_RUN.slice(PLAIN_HEAD.length - 20)), s, utf8(PLAIN_RUN));
    await expectHolds(s, PLAIN_RUN);
  });

  test("a resend whose overlap differs from the held bytes is a 409 carrying held, nothing appended", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, PLAIN_HEAD), s, utf8(PLAIN_HEAD));
    // The capture is ASCII here, so 20 characters are 20 bytes; the first of them is changed.
    const differing = `#${PLAIN_HEAD.slice(-19)}${PLAIN_TAIL}`;
    expect(PLAIN_HEAD.slice(-20, -19)).not.toBe("#");
    const res = await batch(s, utf8(PLAIN_HEAD) - 20, differing);
    expectRefused(res, 409);
    expect(res.body.held).toBe(utf8(PLAIN_HEAD));
    await expectHolds(s, PLAIN_HEAD);
  });

  test("a batch whose from is past the held length is a gap: a 409 carrying held, nothing appended", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, PLAIN_HEAD), s, utf8(PLAIN_HEAD));
    const res = await batch(s, utf8(PLAIN_HEAD) + 1, PLAIN_TAIL);
    expectRefused(res, 409);
    expect(res.body.held).toBe(utf8(PLAIN_HEAD));
    await expectHolds(s, PLAIN_HEAD);
  });
});

describe("a run's stream codec is fixed by its first batch, a view codec as a record codec", () => {
  test("a run whose first batch was bun-console refuses a crucible-events batch: a 400 naming bun-console, nothing appended", async () => {
    const s = await subject();
    expectOk(await batch(s, 0, PLAIN_HEAD), s, utf8(PLAIN_HEAD));
    const res = await batch(s, utf8(PLAIN_HEAD), eventLine({ event: "run-start", total: 1 }), "crucible-events");
    expectRefused(res, 400);
    expect(String(res.body.error)).toContain(VIEW_CODEC);
    await expectHolds(s, PLAIN_HEAD);
  });

  test("a run whose first batch was crucible-events refuses a bun-console batch: a 400 naming crucible-events, nothing appended", async () => {
    const s = await subject();
    const start = eventLine({ event: "run-start", total: 1 });
    expectOk(await batch(s, 0, start, "crucible-events"), s, utf8(start));
    const res = await batch(s, utf8(start), PLAIN_HEAD, VIEW_CODEC);
    expectRefused(res, 400);
    expect(String(res.body.error)).toContain("differs from the stream codec crucible-events");
    const probe = await batch(s, 0, start, "crucible-events");
    expect(probe.body.held).toBe(utf8(start));
  });
});

// ── The size bound ──────────────────────────────────────────────────────────

/** A console line of exactly `bytes` UTF-8 bytes that no reading counts. */
function padLine(bytes: number): string {
  return `${"x".repeat(bytes - 1)}\n`;
}

const SLOW = 30_000;

describe("a view stream's total is bounded by ingest_body_bytes", () => {
  test(
    "a view stream reaching the limit exactly is held; the batch taking it past is a 413 naming the limit and carrying held",
    async () => {
      const shipped = shippedLimits().ingest_body_bytes;
      expect(shipped, "src/crucible.toml declares no [limits.ingest_body_bytes] table").toBeDefined();
      if (shipped === undefined) return;
      const limit = shipped.min;
      writeConfig(serverConfigDir(), { ingest_body_bytes: declare(shipped, limit) });
      const handle = bootWithOperatorFile();
      handles.push(handle);
      const s = await subject(handle);
      const first = padLine(600_000);
      const second = padLine(limit - 600_000);
      expectOk(await batch(s, 0, first), s, 600_000);
      expectOk(await batch(s, 600_000, second), s, limit);

      const past = await batch(s, limit, "(pass) one too many\n");
      expect(past.status, JSON.stringify(past.body)).toBe(413);
      expect(String(past.body.error)).toContain("ingest_body_bytes");
      expect(String(past.body.error)).toContain(String(limit));
      expect(past.body.held).toBe(limit);
      expect(s.handle.store.runLive(s.runId)?.completed).toBe(0);
      expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
    },
    SLOW,
  );
});

// ── The quiet touch ─────────────────────────────────────────────────────────

describe("a view batch keeps its agent live without an agents change", () => {
  test("a bun-console batch over the route moves the agent's lastSeen and emits no `agents` change", async () => {
    const handle = boot();
    const agentId = "quiet-viewer";
    const key = await readyProject(handle, [agentId], "view-quiet");
    const runId = await openRun(handle, key, agentId, { stack: "bun", tier: "unit" });
    const seenBefore = handle.store.getAgent(key, agentId)?.lastSeen ?? Number.NaN;
    const later = seenBefore + 60_000;
    setSystemTime(later);
    const heard: ChangeKind[] = [];
    const off = handle.store.onChange((kind) => {
      heard.push(kind);
    });
    const res = await sendBatch(handle, runId, { projectKey: key, agentId, from: 0, data: PLAIN_HEAD, codec: VIEW_CODEC });
    off();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(heard.filter((kind) => kind === "agents")).toEqual([]);
    const seenAfter = handle.store.getAgent(key, agentId, later)?.lastSeen ?? Number.NaN;
    expect(seenAfter).toBeGreaterThanOrEqual(later);
    expect(seenAfter).toBeLessThan(later + 5_000);
  });
});

// ── The throttled frames ────────────────────────────────────────────────────

/** A clock and a timer the test moves by hand (the Store's `scheduler` seam). */
class ManualScheduler {
  private clock: number;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start: number) {
    this.clock = start;
  }

  readonly now = (): number => this.clock;

  readonly setTimeout = (fn: () => void, ms: number): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { at: this.clock + ms, fn });
    return handle;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  pending(): number {
    return this.timers.size;
  }

  advanceTo(t: number): void {
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= t && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.clock = Math.max(this.clock, due[1].at);
      due[1].fn();
    }
    this.clock = Math.max(this.clock, t);
  }
}

const T0 = 1_800_000_000_000;

describe("a view stream's live frames are throttled per project", () => {
  test("the first bun-console batch emits one `events` change at once; a second inside the window is deferred to its end, where exactly one more fires", () => {
    const clock = new ManualScheduler(T0);
    const store = Store.open(":memory:", { scheduler: clock });
    try {
      const key = crypto.randomUUID();
      store.addProject({ key, name: "view-frames", type: "backend", sutRoot: "/tmp/view-frames" });
      const runId = store.startRun(key, "frames-viewer", { tier: "unit" }).runId;
      const frames: number[] = [];
      store.onChange((kind, projectKey) => {
        if (kind === "events" && projectKey === key) frames.push(clock.now());
      });
      const limit = resolveLimit("ingest_body_bytes");
      const one = "a.test.ts:\n(pass) first\n";
      const two = "(pass) second\n";

      expect(store.appendRunStream(runId, { codec: VIEW_CODEC, from: 0, data: one, limit })).toEqual({
        ok: true,
        held: utf8(one),
      });
      expect(frames).toEqual([T0]);
      expect(store.runLive(runId)?.completed).toBe(1);

      clock.advanceTo(T0 + 500);
      expect(store.appendRunStream(runId, { codec: VIEW_CODEC, from: utf8(one), data: two, limit })).toEqual({
        ok: true,
        held: utf8(one + two),
      });
      expect(frames).toEqual([T0]);
      expect(clock.pending()).toBe(1);

      clock.advanceTo(T0 + LIVE_FRAME_MS);
      expect(frames).toEqual([T0, T0 + LIVE_FRAME_MS]);
      expect(store.runLive(runId)?.completed).toBe(2);
      expect(clock.pending()).toBe(0);
    } finally {
      store.dispose();
    }
  });
});
