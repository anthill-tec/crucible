// With no setting given, the board's shell runs today's intervals — each
// value OBSERVED on running production code, never read off its source text:
//
//   - the shell's timers: a `setInterval` spy installed once happy-dom has
//     registered and before app.js evaluates records, for a mount with no
//     override, the poll at 5000, the cycle tick at 10 000, the run-card tick
//     at 1000 and the watchdog at 5000;
//   - the reconnect: a stream that errors CLOSED schedules `connectStream`
//     at 5000;
//   - the silence window: with the clock pinned at T0 before the mount, the
//     watchdog reads nothing at T0 + 20 000 and reads `/api/v2/health` at
//     T0 + 20 001.
//
// WHY INTEGRATION: the shell mounts in happy-dom, and happy-dom itself arms a
// real 1 ms timer whenever a window is built and whenever it is torn down
// (its AsyncTaskManager's `resolveWhenComplete`, on a timer reference it
// captures privately when it loads). A unit test takes no wait on real time
// above 0 ms, so a happy-dom mount is integration. The stream's keep-alive
// needs no window and stays a unit test, in
// tests/unit/the-stream-runs-its-default-keep-alive.test.ts.
//
// In process: happy-dom in this process, no socket, no spawn. No timer the
// shell asks for ever runs: the interval spy only records, the timeout spy
// arms only the 0 ms render steps, and the watchdog is invoked by the test on
// a clock it moves itself.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mountUi, settleReads, uiFetchLog, unmountUi } from "../helpers/ui-mount";

const teardowns: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown();
  await unmountUi();
  setSystemTime();
});

type Recorded = { fn: (...args: unknown[]) => unknown; ms: number };

/** Replace the window's `setInterval` with a recorder: nothing it is handed ever runs. */
function recordIntervals(): Recorded[] {
  const recorded: Recorded[] = [];
  let handle = 0;
  const spy = spyOn(globalThis, "setInterval").mockImplementation(((fn: Recorded["fn"], ms: number) => {
    recorded.push({ fn, ms });
    handle += 1;
    return handle;
  }) as unknown as typeof setInterval);
  teardowns.push(() => spy.mockRestore());
  return recorded;
}

/** Record every `setTimeout` the window is asked for. Only a 0 ms one — a
 *  render step — is armed; a timer above 0 ms is recorded and never armed,
 *  so no real wait is taken and nothing it was handed ever runs. */
function recordTimeouts(): Recorded[] {
  const recorded: Recorded[] = [];
  const real = globalThis.setTimeout;
  let handle = 0;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: Recorded["fn"], ms?: number, ...rest: unknown[]) => {
    recorded.push({ fn, ms: ms ?? 0 });
    if (typeof ms === "number" && ms > 0) {
      handle += 1;
      return handle;
    }
    return real(fn as () => void, ms, ...rest);
  }) as unknown as typeof setTimeout);
  teardowns.push(() => spy.mockRestore());
  return recorded;
}

/** A body every read of the shell's boot accepts: an empty, healthy board. */
const EMPTY_BOARD = {
  ok: true,
  projects: [],
  agents: [],
  events: [],
  openRuns: [],
  plans: [],
  version: "2.0.0-test",
  counts: { projects: 0, agents: 0, events: 0 },
};

async function emptyBoardFetch(): Promise<Response> {
  return { ok: true, status: 200, json: async () => EMPTY_BOARD } as unknown as Response;
}

/** A stand-in for the browser's EventSource: it never connects on its own. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = 0;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed += 1;
  }
}

function installFakeEventSource(): void {
  FakeEventSource.instances = [];
  const scope = globalThis as Record<string, unknown>;
  const before = Object.getOwnPropertyDescriptor(scope, "EventSource");
  Object.defineProperty(scope, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
  teardowns.push(() => {
    if (before === undefined) delete scope.EventSource;
    else Object.defineProperty(scope, "EventSource", before);
  });
}

describe("the shell runs today's intervals when none is given", () => {
  test("a mount with no override arms the poll at 5000, the cycle tick at 10000, the run-card tick at 1000 and the watchdog at 5000", async () => {
    let recorded: Recorded[] = [];
    await mountUi({ fetch: emptyBoardFetch, beforeBoot: () => (recorded = recordIntervals()) });

    // Exactly four intervals, one per channel. The poll fallback (happy-dom
    // has no EventSource) and the watchdog are named functions; the cycle
    // tick and the run-card tick are the two module-level ticks, armed in
    // that order.
    expect(recorded.length).toBe(4);
    const byName = (name: string) => recorded.filter((call) => call.fn.name === name).map((call) => call.ms);
    expect(byName("refetch")).toEqual([5000]);
    expect(byName("watchdogTick")).toEqual([5000]);
    const ticks = recorded.filter((call) => call.fn.name !== "refetch" && call.fn.name !== "watchdogTick");
    expect(ticks.map((call) => call.ms)).toEqual([10_000, 1000]);
  });

  test("a stream that errors CLOSED schedules its reconnect at 5000", async () => {
    let timeouts: Recorded[] = [];
    await mountUi({
      fetch: emptyBoardFetch,
      beforeBoot: () => {
        installFakeEventSource();
        recordIntervals();
        timeouts = recordTimeouts();
      },
    });
    expect(FakeEventSource.instances.length).toBe(1);
    const stream = FakeEventSource.instances[0]!;
    expect(stream.url).toBe("/api/stream");
    // Nothing is scheduled to reconnect while the stream has not failed.
    expect(timeouts.filter((call) => call.fn.name === "connectStream")).toEqual([]);

    stream.readyState = FakeEventSource.CLOSED;
    stream.onerror!();

    const reconnects = timeouts.filter((call) => call.fn.name === "connectStream");
    expect(reconnects.map((call) => call.ms)).toEqual([5000]);
    expect(stream.closed).toBe(1);
  });

  test("the watchdog reads nothing at 20000 ms of silence and reads /api/v2/health at 20001 ms", async () => {
    const T0 = 1_800_000_000_000;
    setSystemTime(T0);
    let recorded: Recorded[] = [];
    await mountUi({ fetch: emptyBoardFetch, beforeBoot: () => (recorded = recordIntervals()) });
    await settleReads();

    const watchdogs = recorded.filter((call) => call.fn.name === "watchdogTick");
    expect(watchdogs.length).toBe(1);
    const watchdogTick = watchdogs[0]!.fn as () => Promise<void>;

    setSystemTime(T0 + 20_000);
    const atWindow = uiFetchLog.length;
    await watchdogTick();
    await settleReads();
    expect(uiFetchLog.slice(atWindow)).toEqual([]);

    setSystemTime(T0 + 20_001);
    const pastWindow = uiFetchLog.length;
    await watchdogTick();
    await settleReads();
    expect(uiFetchLog.slice(pastWindow)).toEqual(["/api/v2/health"]);
  });
});
