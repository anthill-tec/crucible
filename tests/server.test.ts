// CR-CRU-001 §S6 — Minimal boot + health (integration: drives the REAL production
// boot via startServer, not a hand-wired store).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface HealthResponse {
  ok: boolean;
  status: string;
  version: string;
  uptime_s: number;
  counts: { projects: number; agents: number; events: number };
}

describe("startServer — production boot + /api/health", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  test("GET /api/health returns 200 with the exact shape on a fresh db", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const res = await fetch(`http://localhost:${handle.server.port}/api/health`);

    expect(res.status).toBe(200);
    const raw = await res.json();
    const body = raw as HealthResponse;

    expect(Object.keys(raw as object).sort()).toEqual(
      ["counts", "ok", "status", "uptime_s", "version"].sort(),
    );
    expect(body.ok).toBe(true);
    expect(body.status).toBe("healthy");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime_s).toBe("number");
    expect(Object.keys(body.counts).sort()).toEqual(["agents", "events", "projects"].sort());
    expect(body.counts).toEqual({ projects: 0, agents: 0, events: 0 });
  });

  test("counts.projects reflects a project added through the returned store", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = crypto.randomUUID();
    handle.store.addProject({ key, name: "x", type: "backend", sutRoot: "/tmp" });

    const res = await fetch(`http://localhost:${handle.server.port}/api/health`);
    const body = (await res.json()) as HealthResponse;

    expect(body.counts.projects).toBe(1);
  });

  test("unknown routes 404", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });

    const nope = await fetch(`http://localhost:${handle.server.port}/api/nope`);
    expect(nope.status).toBe(404);

    // CR-CRU-006 §S1 supersedes CR-CRU-001's "everything else 404s" — `/` is
    // now released to the SPA. Rescoped to an unknown API-shaped path so the
    // test still asserts the surviving contract: unknown API routes 404.
    const definitelyNotARoute = await fetch(
      `http://localhost:${handle.server.port}/api/definitely-not-a-route`,
    );
    expect(definitelyNotARoute.status).toBe(404);
    const body = (await definitelyNotARoute.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("stop() closes the server so a subsequent fetch rejects", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const port = handle.server.port;
    handle.stop();
    handle = undefined; // already stopped — don't double-stop in afterEach

    await expect(fetch(`http://localhost:${port}/api/health`)).rejects.toThrow();
  });
});
