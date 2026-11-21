// The board `createBoard` builds in process answers exactly as the board
// `startServer` serves over its socket: the same router, the same store.
//
// The one socket in the in-process board's tests: a `startServer` on port 0
// over a scratch store, and an in-process board over that SAME store and the
// listener that server bound, so both answers come from one data set. Each
// request goes once to the socket and once, in process, to
// `http://board.invalid`; status, content type and body must match (health's
// `uptime_s` aside — it is a clock, read at two different moments).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as server from "../../src/server.ts";
import { startServer } from "../../src/server.ts";

const createBoard = server.createBoard;

const ORIGIN = "http://board.invalid";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Answer {
  status: number;
  type: string | null;
  body: unknown;
}

async function read(res: Response): Promise<Answer> {
  const type = res.headers.get("content-type");
  const text = await res.text();
  const body: unknown = type !== null && type.startsWith("application/json") ? JSON.parse(text) : text;
  if (typeof body === "object" && body !== null && "uptime_s" in body) {
    delete (body as Record<string, unknown>).uptime_s;
  }
  return { status: res.status, type, body };
}

describe("the in-process board answers as the served board", () => {
  test("health, the v2 surface, the 404 JSON, the static shell and a throw answer alike in process and over the socket", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crucible-board-parity-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const handle = startServer({ port: 0, dbPath: path.join(dir, "crucible.db") });
    cleanups.push(() => handle.stop());
    const board = createBoard({
      store: handle.store,
      storeResolution: handle.storeResolution,
      listener: () => handle.listenerResolution,
    });
    cleanups.push(() => board.stop());
    const socket = `http://127.0.0.1:${handle.server.port}`;
    const key = crypto.randomUUID();
    handle.store.addProject({ key, name: "parity", type: "backend", sutRoot: "/tmp/parity" });

    const both = async (route: string): Promise<{ served: Answer; inProcess: Answer }> => ({
      served: await read(await fetch(`${socket}${route}`)),
      inProcess: await read(await board.fetch(new Request(`${ORIGIN}${route}`))),
    });

    const health = await both("/api/health");
    expect(health.served.status).toBe(200);
    expect((health.served.body as Record<string, unknown>).listener).toEqual(handle.listenerResolution);
    expect(health.inProcess).toEqual(health.served);

    const v2Health = await both("/api/v2/health");
    expect(v2Health.served.status).toBe(200);
    expect(v2Health.inProcess).toEqual(v2Health.served);

    const projects = await both("/api/v2/projects");
    expect(projects.served.status).toBe(200);
    expect(
      ((projects.served.body as { projects: Array<{ key: string }> }).projects).map((p) => p.key),
    ).toEqual([key]);
    expect(projects.inProcess).toEqual(projects.served);

    const unknown = await both("/api/x");
    expect(unknown.served).toEqual({
      status: 404,
      type: unknown.served.type,
      body: { ok: false, error: "unknown route: GET /api/x" },
    });
    expect(unknown.inProcess).toEqual(unknown.served);

    const shell = await both("/p/parity");
    expect(shell.served.status).toBe(200);
    expect(shell.served.type).toBe("text/html; charset=utf-8");
    expect(shell.inProcess).toEqual(shell.served);

    const listProjects = spyOn(handle.store, "listProjects").mockImplementation(() => {
      throw new Error("the store failed to list its projects");
    });
    cleanups.push(() => listProjects.mockRestore());
    const servedThrow = await fetch(`${socket}/api/v2/projects`);
    const inProcessThrow = await board.fetch(new Request(`${ORIGIN}/api/v2/projects`));
    expect(servedThrow.status).toBe(500);
    expect(inProcessThrow.status).toBe(servedThrow.status);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });
});
