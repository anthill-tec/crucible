// The live state reaches the screen through the store's `events` change,
// throttled per project to one frame per `LIVE_FRAME_MS` (§S4):
//
//   - a batch that changes a live state emits the `events` change for its
//     project at once when no frame went out in the last `LIVE_FRAME_MS`;
//   - a change inside the window is deferred to the window's end, so the last
//     batch is always shown — and a window with no change after its frame
//     fires nothing at its end;
//   - each project has its own window;
//   - a refused batch changes no live state and emits nothing;
//   - a run's settling emits as it does today, at once, and when it is the
//     project's last streamed run the deferred timer is cleared;
//   - `Store#dispose()` clears a pending timer, so no frame fires after it;
//   - `LIVE_FRAME_MS` is one named constant (2000) exported from src/store.ts,
//     and it is not a server limit: the server's limits stay five.
//
// ── The scheduler seam (a test seam, not configuration) ────────────────────
//
// The Store takes an optional scheduler — the clock and the timer — as its
// open option `scheduler`:
//
//   Store.open(path, { scheduler: { now(), setTimeout(fn, ms), clearTimeout(handle) } })
//
//   now()              the clock the window is measured on, epoch ms
//   setTimeout(fn, ms) arms the window's end; answers an opaque handle the
//                      Store never calls a method on (the default scheduler,
//                      built on the global timers, `unref`s its own timer)
//   clearTimeout(h)    disarms the handle `setTimeout` answered
//
// Without the option the Store uses the real clock and timers. Every test
// below drives the window with `ManualScheduler`, so no test waits in real
// time; frames are read on `Store#onChange`, stamped with the scheduler's
// clock as they are heard.
//
// SAFETY: every Store is ":memory:".
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_LIMIT_NAMES, resolveLimit } from "../src/limits.ts";
import * as storeModule from "../src/store.ts";
import { Store, type ChangeKind } from "../src/store.ts";
import { eventLine, STREAM_CODEC, utf8 } from "./helpers/run-stream-harness.ts";

/** §S4's frame cadence, read off the module that owns it. */
const LIVE_FRAME_MS: number = storeModule.LIVE_FRAME_MS;

/** A clock and a timer the test moves by hand. */
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

  /** Timers armed and not yet fired or cleared. */
  pending(): number {
    return this.timers.size;
  }

  /** Move the clock to `t`, firing every timer due by then, earliest first. */
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

interface Frame {
  kind: ChangeKind;
  projectKey?: string;
  at: number;
}

interface Board {
  store: Store;
  clock: ManualScheduler;
  frames: Frame[];
  t0: number;
}

const T0 = 1_800_000_000_000;

/** A Store on the manual scheduler, its changes recorded from now on. */
function board(): Board {
  const clock = new ManualScheduler(T0);
  const store = Store.open(":memory:", { scheduler: clock });
  const frames: Frame[] = [];
  store.onChange((kind, projectKey) => {
    frames.push({ kind, ...(projectKey !== undefined ? { projectKey } : {}), at: clock.now() });
  });
  return { store, clock, frames, t0: T0 };
}

function project(b: Board, name: string): string {
  const key = crypto.randomUUID();
  b.store.addProject({ key, name, type: "backend", sutRoot: `/tmp/${name}` });
  return key;
}

/** An open run and the offset its next batch starts at. */
class StreamingRun {
  private held = 0;
  private sent = 0;
  readonly runId: string;

  constructor(
    private readonly b: Board,
    readonly projectKey: string,
    agentId: string,
  ) {
    this.runId = b.store.startRun(projectKey, agentId, { tier: "unit" }).runId;
  }

  /** One batch completing one more test line; answered `ok` with the bytes held. */
  batch(): void {
    this.sent += 1;
    const line = eventLine({ event: "test-end", name: `t${this.sent}`, suite: "Frames", file: "src/frames.test.ts", status: "pass" });
    const outcome = this.b.store.appendRunStream(this.runId, {
      codec: STREAM_CODEC,
      from: this.held,
      data: line,
      limit: resolveLimit("ingest_body_bytes"),
    });
    this.held += utf8(line);
    expect(outcome).toEqual({ ok: true, held: this.held });
  }

  /** A batch leaving a gap past the bytes held: refused, nothing appended. */
  gap(): void {
    const outcome = this.b.store.appendRunStream(this.runId, {
      codec: STREAM_CODEC,
      from: this.held + 5,
      data: eventLine({ event: "test-end", name: "gap", status: "pass" }),
      limit: resolveLimit("ingest_body_bytes"),
    });
    expect(outcome).toEqual({ ok: false, refused: "gap", held: this.held });
  }
}

/** The `events` frames heard for `projectKey` since `from` (an index into the record). */
function eventsFrames(b: Board, projectKey: string, from = 0): Frame[] {
  return b.frames.slice(from).filter((frame) => frame.kind === "events" && frame.projectKey === projectKey);
}

/** Every frame of `kind` heard since `from`. */
function framesOfKind(b: Board, kind: ChangeKind, from = 0): Frame[] {
  return b.frames.slice(from).filter((frame) => frame.kind === kind);
}

// ═══════════════════════════════════════════════════════════════════════════

describe("batches across a project's streamed runs inside one window", () => {
  test("the first batch emits one `events` change at once; the batches after it inside the window emit nothing until the window's end, where exactly one more fires", () => {
    const b = board();
    const key = project(b, "frames-one-window");
    const red = new StreamingRun(b, key, "frames-red");
    const green = new StreamingRun(b, key, "frames-green");
    const mark = b.frames.length;

    red.batch();
    expect(eventsFrames(b, key, mark)).toEqual([{ kind: "events", projectKey: key, at: T0 }]);

    b.clock.advanceTo(T0 + 500);
    green.batch();
    b.clock.advanceTo(T0 + 1500);
    red.batch();
    b.clock.advanceTo(T0 + LIVE_FRAME_MS - 1);
    expect(eventsFrames(b, key, mark)).toHaveLength(1);

    b.clock.advanceTo(T0 + LIVE_FRAME_MS);
    expect(eventsFrames(b, key, mark)).toEqual([
      { kind: "events", projectKey: key, at: T0 },
      { kind: "events", projectKey: key, at: T0 + LIVE_FRAME_MS },
    ]);

    b.clock.advanceTo(T0 + 5 * LIVE_FRAME_MS);
    expect(eventsFrames(b, key, mark)).toHaveLength(2);
    expect(framesOfKind(b, "agents", mark)).toEqual([]);
    expect(b.clock.pending()).toBe(0);
  });

  test("a window with no change after its frame fires nothing at its end, and the next batch after it emits at once", () => {
    const b = board();
    const key = project(b, "frames-quiet-window");
    const run = new StreamingRun(b, key, "frames-quiet");
    const mark = b.frames.length;

    run.batch();
    b.clock.advanceTo(T0 + 3 * LIVE_FRAME_MS);
    expect(eventsFrames(b, key, mark)).toEqual([{ kind: "events", projectKey: key, at: T0 }]);
    expect(b.clock.pending()).toBe(0);

    run.batch();
    expect(eventsFrames(b, key, mark)).toEqual([
      { kind: "events", projectKey: key, at: T0 },
      { kind: "events", projectKey: key, at: T0 + 3 * LIVE_FRAME_MS },
    ]);
  });

  test("forty batches a quarter-second apart: frames at least LIVE_FRAME_MS apart, and the last batch is always shown", () => {
    const b = board();
    const key = project(b, "frames-burst");
    const runs = [new StreamingRun(b, key, "burst-a"), new StreamingRun(b, key, "burst-b")];
    const mark = b.frames.length;
    let last = T0;
    for (let i = 0; i < 40; i += 1) {
      last = T0 + i * 250;
      b.clock.advanceTo(last);
      runs[i % 2]?.batch();
    }
    b.clock.advanceTo(last + 10 * LIVE_FRAME_MS);

    const at = eventsFrames(b, key, mark).map((frame) => frame.at);
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < at.length; i += 1) {
      expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(LIVE_FRAME_MS);
    }
    // A frame went out at or after the last batch, within one window of it.
    const final = at[at.length - 1] ?? 0;
    expect(final).toBeGreaterThanOrEqual(last);
    expect(final).toBeLessThanOrEqual(last + LIVE_FRAME_MS);
    expect(framesOfKind(b, "agents", mark)).toEqual([]);
    expect(b.clock.pending()).toBe(0);
  });
});

describe("each project has its own window", () => {
  test("a batch in a second project emits its own frame at once while the first project's window is open", () => {
    const b = board();
    const first = project(b, "frames-first");
    const second = project(b, "frames-second");
    const a = new StreamingRun(b, first, "first-runner");
    const c = new StreamingRun(b, second, "second-runner");
    const mark = b.frames.length;

    a.batch();
    b.clock.advanceTo(T0 + 100);
    c.batch();
    expect(eventsFrames(b, second, mark)).toEqual([{ kind: "events", projectKey: second, at: T0 + 100 }]);
    b.clock.advanceTo(T0 + 200);
    a.batch();
    expect(eventsFrames(b, first, mark)).toEqual([{ kind: "events", projectKey: first, at: T0 }]);

    b.clock.advanceTo(T0 + 5 * LIVE_FRAME_MS);
    expect(eventsFrames(b, first, mark)).toEqual([
      { kind: "events", projectKey: first, at: T0 },
      { kind: "events", projectKey: first, at: T0 + LIVE_FRAME_MS },
    ]);
    // The second project changed nothing after its own frame: no frame at its window's end.
    expect(eventsFrames(b, second, mark)).toHaveLength(1);
  });
});

describe("a refused batch changes no live state", () => {
  test("a gap refused — on a fresh run, and after a window closed — emits no frame and arms no timer", () => {
    const b = board();
    const key = project(b, "frames-refused");
    const fresh = new StreamingRun(b, key, "refused-fresh");
    const mark = b.frames.length;

    fresh.gap();
    expect(eventsFrames(b, key, mark)).toEqual([]);
    expect(b.clock.pending()).toBe(0);

    fresh.batch();
    b.clock.advanceTo(T0 + 3 * LIVE_FRAME_MS);
    fresh.gap();
    b.clock.advanceTo(T0 + 6 * LIVE_FRAME_MS);
    expect(eventsFrames(b, key, mark)).toEqual([{ kind: "events", projectKey: key, at: T0 }]);
    expect(b.clock.pending()).toBe(0);
  });
});

describe("a run's settling emits as today", () => {
  test("an abort inside the window emits its `events` change at once; as the project's last streamed run it clears the deferred timer", () => {
    const b = board();
    const key = project(b, "frames-settle");
    const run = new StreamingRun(b, key, "settling-runner");
    const mark = b.frames.length;

    run.batch();
    b.clock.advanceTo(T0 + 100);
    run.batch();
    expect(b.clock.pending()).toBe(1);

    b.clock.advanceTo(T0 + 200);
    const aborted = b.store.abortOpenRun(run.runId, "runner killed", b.clock.now());
    expect(aborted?.status).toBe("aborted");
    expect(eventsFrames(b, key, mark)).toEqual([
      { kind: "events", projectKey: key, at: T0 },
      { kind: "events", projectKey: key, at: T0 + 200 },
    ]);
    expect(b.clock.pending()).toBe(0);

    b.clock.advanceTo(T0 + 5 * LIVE_FRAME_MS);
    expect(eventsFrames(b, key, mark)).toHaveLength(2);
  });

  test("the sweep settling a streamed run emits its `events` change at once", () => {
    const b = board();
    const key = project(b, "frames-sweep");
    const run = new StreamingRun(b, key, "swept-runner");
    const mark = b.frames.length;

    run.batch();
    const swept = b.store.sweepOpenRuns(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(swept.map((event) => event.agentId)).toEqual(["swept-runner"]);
    expect(eventsFrames(b, key, mark)).toHaveLength(2);
    expect(b.clock.pending()).toBe(0);
  });
});

describe("Store#dispose()", () => {
  test("clears a pending timer, so no frame fires after it", () => {
    const b = board();
    const key = project(b, "frames-dispose");
    const run = new StreamingRun(b, key, "disposed-runner");
    const mark = b.frames.length;

    run.batch();
    b.clock.advanceTo(T0 + 100);
    run.batch();
    expect(b.clock.pending()).toBe(1);

    b.store.dispose();
    expect(b.clock.pending()).toBe(0);
    b.clock.advanceTo(T0 + 5 * LIVE_FRAME_MS);
    expect(eventsFrames(b, key, mark)).toEqual([{ kind: "events", projectKey: key, at: T0 }]);
  });

  test("without a scheduler the Store uses the real clock: a batch emits its `events` change at once, and dispose leaves nothing armed", () => {
    const store = Store.open(":memory:");
    const key = crypto.randomUUID();
    store.addProject({ key, name: "frames-real-clock", type: "backend", sutRoot: "/tmp/frames-real-clock" });
    const runId = store.startRun(key, "real-clock-runner", { tier: "unit" }).runId;
    const heard: Array<{ kind: ChangeKind; projectKey?: string }> = [];
    store.onChange((kind, projectKey) => {
      heard.push({ kind, ...(projectKey !== undefined ? { projectKey } : {}) });
    });
    const line = eventLine({ event: "test-end", name: "real", suite: "Frames", status: "pass" });
    const outcome = store.appendRunStream(runId, {
      codec: STREAM_CODEC,
      from: 0,
      data: line,
      limit: resolveLimit("ingest_body_bytes"),
    });
    expect(outcome).toEqual({ ok: true, held: utf8(line) });
    expect(heard).toEqual([{ kind: "events", projectKey: key }]);
    store.dispose();
  });
});

describe("the cadence is one named constant, not a limit", () => {
  test("LIVE_FRAME_MS is exported from src/store.ts as 2000", () => {
    expect(LIVE_FRAME_MS).toBe(2000);
  });

  // Pin: a sixth server limit (a configurable frame cadence) is a non-goal.
  test("the server's limits stay five, and none of them is a frame cadence", () => {
    expect(SERVER_LIMIT_NAMES).toHaveLength(5);
    expect(SERVER_LIMIT_NAMES.filter((name) => /frame/i.test(name))).toEqual([]);
    const shipped = Bun.TOML.parse(readFileSync(join(import.meta.dir, "..", "src", "crucible.toml"), "utf8")) as {
      limits?: Record<string, unknown>;
    };
    expect(Object.keys(shipped.limits ?? {}).sort()).toEqual([...SERVER_LIMIT_NAMES].sort());
  });
});
