// With no setting given, the board's stream runs today's keep-alive — the
// value OBSERVED on running production code, never read off its source text:
// an in-process `createBoard` answering `/api/stream` arms its keep-alive at
// 15 000.
//
// In process: the board's router through its own `fetch`, no socket, no
// spawn, no window. No timer the stream arms ever runs: the interval spy only
// records, and the store's clock and timer are the test's own.
//
// The shell's default intervals need a happy-dom window, and happy-dom arms a
// real timer of its own, so they are observed in
// tests/integration/the-shell-runs-its-default-intervals.test.ts.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createBoard } from "../../src/server.ts";
import { Store, type LiveFrameScheduler } from "../../src/store.ts";

const teardowns: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown();
});

type Recorded = { fn: (...args: unknown[]) => unknown; ms: number };

/** Replace `setInterval` with a recorder: nothing it is handed ever runs. */
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

/** A clock and a timer the test owns: nothing it arms ever fires on its own. */
class ManualScheduler implements LiveFrameScheduler {
  now = (): number => 1_800_000_000_000;
  setTimeout = (): number => 1;
  clearTimeout = (): void => undefined;
}

describe("the board's stream runs today's keep-alive when none is given", () => {
  test("an in-process board answering /api/stream arms its keep-alive at 15000", async () => {
    const store = Store.open(":memory:", { scheduler: new ManualScheduler() });
    const board = createBoard({
      store,
      storeResolution: { path: ":memory:", rule: "explicit" },
      listener: () => null,
    });
    teardowns.push(() => board.stop());
    const recorded = recordIntervals();
    spyOn(globalThis, "clearInterval").mockImplementation((() => undefined) as typeof clearInterval);
    teardowns.push(() => (globalThis.clearInterval as unknown as { mockRestore(): void }).mockRestore());

    const res = await board.fetch(new Request("http://board.invalid/api/stream"));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.startsWith('data: {"type":"hello"')).toBe(true);

    expect(recorded.map((call) => call.ms)).toEqual([15_000]);
    await reader.cancel();
  });
});
