// The board's shutdown disposes its store (CR-CRU-200 §S4): `Store#dispose()`
// disarms every deferred live frame, and the server's own stop — the
// `stop()` of the handle `startServer` answers — is what calls it, so no
// frame fires after the board has stopped.
//
// Held here, on a real server (`startServer`, port 0, ":memory:"):
//  - the handle's `stop()` calls `store.dispose()` exactly once;
//  - a live frame deferred by a batch inside `LIVE_FRAME_MS` (src/store.ts)
//    never fires once `stop()` has returned: the store's `events` change is
//    not heard after it, waited for past the window's end on the real clock.
//
// `gracefulStop` (src/server.ts) is reached only when the module runs as the
// process's main and takes SIGTERM or SIGINT; it calls the handle's `stop()`
// and then `process.exit(0)`, so it disposes the store through the `stop()`
// held here. Its own effect cannot be observed from outside: the process
// exits at once, and every timer it held dies with it whether or not it was
// disarmed.
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { LIVE_FRAME_MS, type ChangeKind } from "../src/store.ts";
import type { ServerHandle } from "../src/server.ts";
import { bootOn, eventLine, openRun, readyProject, sendBatch, utf8 } from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

/** Stop a handle the test drives itself, and forget it so `afterEach` does not stop it again. */
function stopNow(handle: ServerHandle): void {
  handles.splice(handles.indexOf(handle), 1);
  handle.stop();
}

function testLine(n: number): string {
  return eventLine({ event: "test-end", id: `t${n}`, name: `test ${n}`, suite: "Shutdown", file: "src/shutdown.ts", status: "pass" });
}

describe("the server's stop disposes its store", () => {
  test("the handle's stop() calls store.dispose() exactly once", () => {
    const handle = boot();
    const dispose = spyOn(handle.store, "dispose");
    try {
      expect(dispose).not.toHaveBeenCalled();
      stopNow(handle);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledWith();
    } finally {
      dispose.mockRestore();
    }
  });

  test(
    "a live frame deferred inside LIVE_FRAME_MS never fires after stop(): no `events` change is heard past the window's end",
    async () => {
      const handle = boot();
      const agentId = "shutdown-streamer";
      const key = await readyProject(handle, [agentId], "shutdown-subject");
      const runId = await openRun(handle, key, agentId, { stack: "bun", tier: "unit" });

      const heard: Array<{ kind: ChangeKind; projectKey?: string }> = [];
      handle.store.onChange((kind, projectKey) => {
        heard.push({ kind, ...(projectKey !== undefined ? { projectKey } : {}) });
      });
      const eventsFrames = (): number => heard.filter((f) => f.kind === "events" && f.projectKey === key).length;

      // The first batch emits its frame at once; the second, inside the
      // window, is deferred to the window's end.
      const first = testLine(1);
      const one = await sendBatch(handle, runId, { projectKey: key, agentId, from: 0, data: first });
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(eventsFrames()).toBe(1);
      const two = await sendBatch(handle, runId, { projectKey: key, agentId, from: utf8(first), data: testLine(2) });
      expect(two.status, JSON.stringify(two.body)).toBe(200);
      expect(eventsFrames()).toBe(1);

      stopNow(handle);
      const afterStop = heard.length;
      await Bun.sleep(LIVE_FRAME_MS + 500);
      expect(heard.slice(afterStop)).toEqual([]);
    },
    LIVE_FRAME_MS * 5,
  );
});
