// The board's request router, reached in process through `createBoard` in
// src/server.ts, while a test has installed happy-dom's globals: the router
// still builds the native request and response classes, and a happy-dom
// request's body still reaches the route.
//
// These tests live here, not beside the rest of the in-process board's tests
// in tests/unit/the-board-answers-its-routes-in-process.test.ts, because
// happy-dom's own teardown (`GlobalRegistrator.unregister`) waits on a real
// timer before it settles — a wait on real time no unit test takes.
//
// Every store is a scratch file opened with a manual scheduler, so a deferred
// live frame never arms a real timer.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as server from "../../src/server.ts";
import type { StoreResolution } from "../../src/server.ts";
import { Store, type LiveFrameScheduler } from "../../src/store.ts";

const createBoard = server.createBoard;

/** The origin every in-process request is addressed to. */
const ORIGIN = "http://board.invalid";

/** The native classes, captured before any test installs happy-dom's. */
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;

/** A clock and a timer the test owns: nothing it arms ever fires on its own. */
class ManualScheduler implements LiveFrameScheduler {
  private nextHandle = 1;
  private readonly timers = new Map<number, () => void>();
  now = (): number => 1_800_000_000_000;
  setTimeout = (fn: () => void): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, fn);
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
}

const scratchDirs: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crucible-in-process-board-"));
  scratchDirs.push(dir);
  return dir;
}

interface Fixture {
  store: Store;
  storeResolution: StoreResolution;
  dbPath: string;
}

/** A scratch store on its own file, on a manual scheduler. */
function scratchStore(): Fixture {
  const dbPath = path.join(scratchDir(), "crucible.db");
  const store = Store.open(dbPath, { scheduler: new ManualScheduler() });
  return { store, dbPath, storeResolution: { path: dbPath, rule: "explicit" } };
}

/** A board with no socket over a fresh scratch store. `stop` stops it once;
 *  the test's teardown calls it too, so a board is never left running. */
function socketlessBoard(fixture: Fixture = scratchStore()) {
  const board = createBoard({
    store: fixture.store,
    storeResolution: fixture.storeResolution,
    listener: () => null,
  });
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    board.stop();
  };
  restores.push(stop);
  return { board, stop, ...fixture };
}

function addProject(store: Store, name: string): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name, type: "backend", sutRoot: `/tmp/${name}` });
  return key;
}

function projectKeys(body: Record<string, unknown>): string[] {
  return (body.projects as Array<{ key: string }>).map((p) => p.key);
}

describe("an in-process board runs on native classes and answers a throw", () => {
  test("with happy-dom's globals installed, a route still answers a native Response", async () => {
    const { board, store } = socketlessBoard();
    const key = addProject(store, "native-classes");
    const request = new NativeRequest(`${ORIGIN}/api/v2/projects`);

    GlobalRegistrator.register({ url: `${ORIGIN}/` });
    let res: Response;
    try {
      expect(globalThis.Response).not.toBe(NativeResponse);
      res = await board.fetch(request);
    } finally {
      await GlobalRegistrator.unregister();
    }

    expect(res instanceof NativeResponse).toBe(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(projectKeys(body)).toEqual([key]);
  });

  test("with happy-dom's globals installed, a happy-dom request's JSON body reaches the route", async () => {
    const { board, store } = socketlessBoard();
    const key = crypto.randomUUID();
    const payload = JSON.stringify({ key, name: "from-happy-dom", type: "backend", sutRoot: "/srv/dom" });

    GlobalRegistrator.register({ url: `${ORIGIN}/` });
    let res: Response;
    try {
      const request = new globalThis.Request(`${ORIGIN}/api/v2/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      expect(request instanceof NativeRequest).toBe(false);
      res = await board.fetch(request);
    } finally {
      await GlobalRegistrator.unregister();
    }

    expect(res instanceof NativeResponse).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true, project: { key, name: "from-happy-dom" } });
    expect(store.getProject(key)).toMatchObject({ key, name: "from-happy-dom", sutRoot: "/srv/dom" });
  });
});
