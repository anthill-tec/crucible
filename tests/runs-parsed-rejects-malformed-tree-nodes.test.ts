// CR-CRU-167 §S1 — RED (C1): POST /api/v2/runs/parsed validates the tree it
// is given against SuiteNode/TestLeaf and refuses with a 400 naming the
// first offending node; it no longer accepts any array.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

describe("POST /api/v2/runs/parsed refuses a tree holding a node that is not a SuiteNode/TestLeaf", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let dirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  function boot(): number {
    const dir = mkdtempSync(join(tmpdir(), "runs-parsed-tree-validation-"));
    dirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle.server.port!;
  }

  async function postJson(port: number, path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProject(port: number, name: string): Promise<string> {
    const res = await postJson(port, "/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    return body.project.key;
  }

  async function registerAgent(port: number, key: string, agentId: string): Promise<void> {
    const res = await postJson(port, "/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  test("a leaf with no `status` → 400 naming the offending leaf, and nothing is stored", async () => {
    const port = boot();
    const key = await createProject(port, "tree-leaf-no-status");
    await registerAgent(port, key, "a1");

    const res = await postJson(port, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "a1",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [
        {
          name: "suite-ok",
          status: "pass",
          children: [{ name: "leaf-missing-status", duration_ms: 7 }],
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("leaf-missing-status");
    expect(handle!.store.listEvents(key).length).toBe(0);
  });

  test("a suite whose `children` is not an array → 400 naming the offending suite, and nothing is stored", async () => {
    const port = boot();
    const key = await createProject(port, "tree-non-array-children");
    await registerAgent(port, key, "a1");

    const res = await postJson(port, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "a1",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [{ name: "suite-bad-children", status: "pass", children: "nope" }],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("suite-bad-children");
    expect(handle!.store.listEvents(key).length).toBe(0);
  });

  test("a suite whose `name` is not a string → 400, and nothing is stored", async () => {
    const port = boot();
    const key = await createProject(port, "tree-non-string-name");
    await registerAgent(port, key, "a1");

    const res = await postJson(port, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "a1",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [{ name: 42, status: "pass", children: [] }],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(handle!.store.listEvents(key).length).toBe(0);
  });

  test("a `tree` that IS an array but holds no SuiteNode-shaped elements is refused, not merely Array.isArray-checked", async () => {
    const port = boot();
    const key = await createProject(port, "tree-any-array-no-longer-accepted");
    await registerAgent(port, key, "a1");

    const res = await postJson(port, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "a1",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [1, 2, 3],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(handle!.store.listEvents(key).length).toBe(0);
  });
});
