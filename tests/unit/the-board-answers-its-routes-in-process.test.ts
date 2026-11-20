// The board's request router, reached in process through `createBoard` in
// src/server.ts — no socket, no process, no wait on real time.
//
//   createBoard({ store, storeResolution, listener }) -> { fetch(req), stop() }
//
//   - `fetch(req)` is the router `startServer` serves: both health routes,
//     `/api/stream`, the v2 surface, the 404 JSON and the static shell;
//   - `listener` answers the bound listener, or `null` for a board with no
//     socket — and then both health routes say `listener: null`, every other
//     key as `startServer`'s health carries it;
//   - the factory resolves nothing: it answers from the store it was handed,
//     never from `CRUCIBLE_DB` or a `crucible.toml`;
//   - `stop()` disposes the store and closes every stream the board answered;
//   - the router runs on the native request classes even when a test has
//     installed happy-dom's globals, and a handler that throws answers a 500,
//     as `Bun.serve` does, rather than rejecting;
//   - routes read no origin, so `http://board.invalid` addresses the board.
//
// Every store is a scratch file opened with a manual scheduler, so a deferred
// live frame never arms a real timer; the stream's keep-alive interval is
// replaced by a recording fake while a stream test runs.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { codecNames } from "../../src/codecs/index.ts";
import { resolveLimit } from "../../src/limits.ts";
import * as server from "../../src/server.ts";
import type { ListenerResolution, StoreResolution } from "../../src/server.ts";
import { Store, type LiveFrameScheduler } from "../../src/store.ts";
import { GATE_MILESTONE_RECORD_FIELDS } from "../../src/v2.ts";

const createBoard = server.createBoard;

/** The origin every in-process request is addressed to. */
const ORIGIN = "http://board.invalid";

/** The native classes, captured before any test installs happy-dom's. */
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;

const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const SHELL_HTML = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

/** Every key the served board's health payload carries. */
const HEALTH_KEYS = [
  "codecs",
  "counts",
  "limits",
  "listener",
  "milestones",
  "ok",
  "status",
  "store",
  "uptime_s",
  "version",
];

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

async function getJson(
  board: { fetch(req: Request): Response | Promise<Response> },
  route: string,
  origin = ORIGIN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await board.fetch(new Request(`${origin}${route}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function projectKeys(body: Record<string, unknown>): string[] {
  return (body.projects as Array<{ key: string }>).map((p) => p.key);
}

/** The health payload a board over `fixture` with no socket must answer, bar uptime. */
function expectedHealth(fixture: Fixture, counts: { projects: number; agents: number; events: number }) {
  return {
    ok: true,
    status: "healthy",
    version: VERSION,
    counts,
    store: {
      path: fixture.storeResolution.path,
      rule: fixture.storeResolution.rule,
      schemaVersion: fixture.store.schemaVersion,
      migration: fixture.store.migration,
    },
    listener: null,
    codecs: codecNames(),
    milestones: { gate: [...GATE_MILESTONE_RECORD_FIELDS] },
    limits: { ingest_body_bytes: resolveLimit("ingest_body_bytes") },
  };
}

function withoutUptime(body: Record<string, unknown>): Record<string, unknown> {
  const { uptime_s: _uptime, ...rest } = body;
  return rest;
}

describe("an in-process board answers the board's routes", () => {
  test("GET /api/health answers the health payload with listener null and every other key", async () => {
    const { board, store, storeResolution, dbPath } = socketlessBoard();
    addProject(store, "health-project");

    const { status, body } = await getJson(board, "/api/health");

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(HEALTH_KEYS);
    expect(body.listener).toBeNull();
    expect(typeof body.uptime_s).toBe("number");
    expect(body.uptime_s as number).toBeGreaterThanOrEqual(0);
    expect(body.uptime_s as number).toBeLessThan(3600);
    expect(withoutUptime(body)).toEqual(
      expectedHealth({ store, storeResolution, dbPath }, { projects: 1, agents: 0, events: 0 }),
    );
  });

  test("GET /api/v2/health answers the same payload as /api/health, listener null", async () => {
    const { board, store, storeResolution, dbPath } = socketlessBoard();
    addProject(store, "v2-health-project");

    const v1 = await getJson(board, "/api/health");
    const v2 = await getJson(board, "/api/v2/health");

    expect(v2.status).toBe(200);
    expect(Object.keys(v2.body).sort()).toEqual(HEALTH_KEYS);
    expect(v2.body.listener).toBeNull();
    expect(withoutUptime(v2.body)).toEqual(withoutUptime(v1.body));
    expect(withoutUptime(v2.body)).toEqual(
      expectedHealth({ store, storeResolution, dbPath }, { projects: 1, agents: 0, events: 0 }),
    );
  });

  test("GET /api/v2/projects lists exactly the projects of the store it was given", async () => {
    const { board, store } = socketlessBoard();
    const first = addProject(store, "listed-one");
    const second = addProject(store, "listed-two");

    const { status, body } = await getJson(board, "/api/v2/projects");

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(projectKeys(body).sort()).toEqual([first, second].sort());
    const names = (body.projects as Array<{ name: string }>).map((p) => p.name).sort();
    expect(names).toEqual(["listed-one", "listed-two"]);
  });

  test("POST /api/v2/projects creates the project in the store it was given", async () => {
    const { board, store } = socketlessBoard();
    const key = crypto.randomUUID();

    const res = await board.fetch(
      new Request(`${ORIGIN}/api/v2/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, name: "created-in-process", type: "frontend", sutRoot: "/srv/sut" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean; project: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.project).toMatchObject({ key, name: "created-in-process", type: "frontend", sutRoot: "/srv/sut" });
    expect(store.getProject(key)).toMatchObject({ key, name: "created-in-process", type: "frontend" });
    expect(store.listProjects().map((p) => p.key)).toEqual([key]);
  });

  test("an unknown /api route answers the 404 JSON naming the method and path", async () => {
    const { board } = socketlessBoard();

    const get = await getJson(board, "/api/x");
    const res = await board.fetch(new Request(`${ORIGIN}/api/x`, { method: "DELETE" }));

    expect(get).toEqual({ status: 404, body: { ok: false, error: "unknown route: GET /api/x" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "unknown route: DELETE /api/x" });
  });

  test("a non-API GET answers the static shell and a non-API POST answers 404", async () => {
    const { board } = socketlessBoard();

    const shell = await board.fetch(new Request(`${ORIGIN}/p/some-project`));
    const post = await board.fetch(new Request(`${ORIGIN}/p/some-project`, { method: "POST" }));

    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await shell.text()).toBe(SHELL_HTML);
    expect(post.status).toBe(404);
    expect(await post.text()).toBe("Not Found");
  });
});

describe("an in-process board resolves nothing itself", () => {
  test("neither CRUCIBLE_DB nor the crucible.toml beside it is read for the store or the listener", async () => {
    // A store and a configuration the board must never use, named by the environment.
    const plantedDir = scratchDir();
    const plantedDb = path.join(plantedDir, "crucible.db");
    const planted = Store.open(plantedDb, { scheduler: new ManualScheduler() });
    const plantedKey = addProject(planted, "planted-project");
    planted.dispose();
    writeFileSync(
      path.join(plantedDir, "crucible.toml"),
      '[server]\nport = 1\nhost = "203.0.113.9"\n',
    );
    const savedDb = process.env.CRUCIBLE_DB;
    process.env.CRUCIBLE_DB = plantedDb;
    restores.push(() => {
      if (savedDb === undefined) delete process.env.CRUCIBLE_DB;
      else process.env.CRUCIBLE_DB = savedDb;
    });

    const { board, store, dbPath } = socketlessBoard();
    const ownKey = addProject(store, "own-project");

    const health = await getJson(board, "/api/health");
    const v2Health = await getJson(board, "/api/v2/health");
    const projects = await getJson(board, "/api/v2/projects");

    for (const answer of [health, v2Health]) {
      expect(answer.body.store).toEqual({
        path: dbPath,
        rule: "explicit",
        schemaVersion: store.schemaVersion,
        migration: store.migration,
      });
      expect(answer.body.listener).toBeNull();
      expect(answer.body.counts).toEqual({ projects: 1, agents: 0, events: 0 });
    }
    expect(projectKeys(projects.body)).toEqual([ownKey]);
    expect(projectKeys(projects.body)).not.toContain(plantedKey);
  });

  test("health discloses exactly the listener the caller supplies", async () => {
    const fixture = scratchStore();
    const bound: ListenerResolution = {
      port: 4711,
      host: "127.0.0.1",
      portRule: "explicit",
      hostRule: "shipped",
    };
    const listener = mock(() => bound);
    const board = createBoard({
      store: fixture.store,
      storeResolution: fixture.storeResolution,
      listener,
    });
    restores.push(() => board.stop());

    const health = await getJson(board, "/api/health");
    const v2Health = await getJson(board, "/api/v2/health");

    expect(health.body.listener).toEqual(bound);
    expect(v2Health.body.listener).toEqual(bound);
    expect(listener).toHaveBeenCalled();
  });
});

/** The keep-alive's timer, replaced while a stream test runs: nothing fires. */
function fakeIntervals() {
  const handle = { keepAlive: true };
  const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
    (() => handle) as unknown as typeof setInterval,
  );
  const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
    (() => undefined) as typeof clearInterval,
  );
  restores.push(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
  const keepAliveCalls = () => setIntervalSpy.mock.calls.filter((call) => call[1] === 15_000);
  const clearedKeepAlive = () =>
    clearIntervalSpy.mock.calls.filter((call) => (call[0] as unknown) === handle);
  return { handle, keepAliveCalls, clearedKeepAlive };
}

/** Settles on the next macrotask, after every pending microtask has run. */
function nextTurn(): Promise<"still open"> {
  return new Promise((resolve) => setImmediate(() => resolve("still open")));
}

async function openStream(board: { fetch(req: Request): Response | Promise<Response> }) {
  const res = await board.fetch(new Request(`${ORIGIN}/api/stream`));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const hello = await reader.read();
  expect(hello.done).toBe(false);
  expect(new TextDecoder().decode(hello.value)).toBe(
    `data: ${JSON.stringify({ type: "hello", version: VERSION })}\n\n`,
  );
  return reader;
}

describe("stopping an in-process board", () => {
  test("stop closes an answered stream body the test never cancelled", async () => {
    fakeIntervals();
    const { board, stop } = socketlessBoard();
    const reader = await openStream(board);

    const beforeStop = await Promise.race([reader.read(), nextTurn()]);
    expect(beforeStop).toBe("still open");

    stop();
    const afterStop = await Promise.race([reader.read(), nextTurn()]);

    expect(afterStop).toEqual({ done: true, value: undefined });
  });

  test("stop clears the stream's keep-alive interval and drops its store subscription", async () => {
    const intervals = fakeIntervals();
    const { board, store, stop } = socketlessBoard();
    const unsubscribed = mock(() => undefined);
    const realOnChange = store.onChange.bind(store);
    spyOn(store, "onChange").mockImplementation((fn) => {
      const off = realOnChange(fn);
      return () => {
        unsubscribed();
        off();
      };
    });
    await openStream(board);

    expect(intervals.keepAliveCalls()).toHaveLength(1);
    expect(intervals.clearedKeepAlive()).toHaveLength(0);
    expect(unsubscribed).not.toHaveBeenCalled();

    stop();

    expect(intervals.clearedKeepAlive()).toHaveLength(1);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  test("stop disposes the store it was given, once", () => {
    const fixture = scratchStore();
    const dispose = spyOn(fixture.store, "dispose");
    const board = createBoard({
      store: fixture.store,
      storeResolution: fixture.storeResolution,
      listener: () => null,
    });

    expect(dispose).not.toHaveBeenCalled();
    board.stop();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

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

  test("a handler that throws answers a 500, never a rejected promise, and the board keeps answering", async () => {
    const { board, store } = socketlessBoard();
    const key = addProject(store, "survives-a-throw");
    const listProjects = spyOn(store, "listProjects").mockImplementation(() => {
      throw new Error("the store failed to list its projects");
    });

    let outcome: { answered: Response } | { rejected: unknown };
    try {
      outcome = { answered: await board.fetch(new Request(`${ORIGIN}/api/v2/projects`)) };
    } catch (error) {
      outcome = { rejected: error };
    }

    expect("rejected" in outcome ? `rejected: ${String(outcome.rejected)}` : "answered").toBe("answered");
    expect((outcome as { answered: Response }).answered.status).toBe(500);
    expect(listProjects).toHaveBeenCalledTimes(1);

    listProjects.mockRestore();
    const after = await getJson(board, "/api/v2/projects");
    expect(after.status).toBe(200);
    expect(projectKeys(after.body)).toEqual([key]);
  });
});

describe("an in-process board answers one origin as any other", () => {
  test("a request to http://board.invalid is answered like one to a loopback origin", async () => {
    const { board, store } = socketlessBoard();
    const key = addProject(store, "one-origin");

    const atInvalid = await getJson(board, "/api/v2/projects", "http://board.invalid");
    const atLoopback = await getJson(board, "/api/v2/projects", "http://127.0.0.1:4711");
    const missingAtInvalid = await getJson(board, "/api/x", "http://board.invalid");
    const missingAtLoopback = await getJson(board, "/api/x", "http://127.0.0.1:4711");

    expect(atInvalid.status).toBe(200);
    expect(projectKeys(atInvalid.body)).toEqual([key]);
    expect(atInvalid).toEqual(atLoopback);
    expect(missingAtInvalid).toEqual({ status: 404, body: { ok: false, error: "unknown route: GET /api/x" } });
    expect(missingAtInvalid).toEqual(missingAtLoopback);
  });
});
