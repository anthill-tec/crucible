// CR-CRU-167 §S1 — RED (C1): POST /api/v2/runs/parsed validates the tree it
// is given against SuiteNode/TestLeaf and refuses with a 400 naming the
// first offending node; it no longer accepts any array.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardHandle } from "../../src/server.ts";
import { bootInProcess, send } from "../helpers/run-stream-harness.ts";

describe("POST /api/v2/runs/parsed refuses a tree holding a node that is not a SuiteNode/TestLeaf", () => {
  let handle: BoardHandle | undefined;
  let dirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  function boot(): BoardHandle {
    const dir = mkdtempSync(join(tmpdir(), "runs-parsed-tree-validation-"));
    dirs.push(dir);
    handle = bootInProcess(join(dir, "crucible.db"));
    return handle;
  }

  async function postJson(board: BoardHandle, path: string, body: unknown): Promise<Response> {
    return send(board, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProject(board: BoardHandle, name: string): Promise<string> {
    const res = await postJson(board, "/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    return body.project.key;
  }

  async function registerAgent(board: BoardHandle, key: string, agentId: string): Promise<void> {
    const res = await postJson(board, "/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  test("a leaf with no `status` → 400 naming the offending leaf, and nothing is stored", async () => {
    const board = boot();
    const key = await createProject(board, "tree-leaf-no-status");
    await registerAgent(board, key, "a1");
    const before = handle!.store.listEvents(key).length;

    const res = await postJson(board, "/api/v2/runs/parsed", {
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
    expect(handle!.store.listEvents(key).length).toBe(before);
  });

  test("a suite whose `children` is not an array → 400 naming the offending suite, and nothing is stored", async () => {
    const board = boot();
    const key = await createProject(board, "tree-non-array-children");
    await registerAgent(board, key, "a1");
    const before = handle!.store.listEvents(key).length;

    const res = await postJson(board, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "a1",
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [{ name: "suite-bad-children", status: "pass", children: "nope" }],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("suite-bad-children");
    expect(handle!.store.listEvents(key).length).toBe(before);
  });

  test("a suite whose `name` is not a string → 400, and nothing is stored", async () => {
    const board = boot();
    const key = await createProject(board, "tree-non-string-name");
    await registerAgent(board, key, "a1");
    const before = handle!.store.listEvents(key).length;

    const res = await postJson(board, "/api/v2/runs/parsed", {
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
    expect(handle!.store.listEvents(key).length).toBe(before);
  });

  test("a `tree` that IS an array but holds no SuiteNode-shaped elements is refused, not merely Array.isArray-checked", async () => {
    const board = boot();
    const key = await createProject(board, "tree-any-array-no-longer-accepted");
    await registerAgent(board, key, "a1");
    const before = handle!.store.listEvents(key).length;

    const res = await postJson(board, "/api/v2/runs/parsed", {
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
    expect(handle!.store.listEvents(key).length).toBe(before);
  });
});
