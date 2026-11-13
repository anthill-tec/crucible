// `GET /api/v2/status` answers the newest compile record and the newest lint
// record apart: `lastCompile` is the newest compile-kind record that carries
// no `lint` marker, and `lastLint` is the newest one that does, or null. The
// status shape is `{hasData, lastTest, lastCompile, lastLint}`.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store): records are posted on `/api/v2/runs/compile` — a lint record is a
// post naming its linter in `lint` — and read back through `/api/v2/status`.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

async function postJson(
  handle: ServerHandle,
  route: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ORCHESTRATOR = "fixture-orch";

async function seedProject(handle: ServerHandle): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: `lint-status-${key}`, type: "backend", sutRoot: "/tmp/p" });
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
  await Bun.sleep(5);
  return key;
}

const RUSTC_ONE_ERROR = ["error[E0308]: mismatched types", " --> src/lib.rs:12:5"].join("\n");
const TSC_ONE_ERROR = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";

/** A plain compile record; returns its event id. Waits so the next post is newer. */
async function postCompileRecord(handle: ServerHandle, key: string): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs/compile", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    format: "tsc",
    errors: TSC_ONE_ERROR,
  });
  expect(res.status).toBe(200);
  await Bun.sleep(5);
  return res.body.event as string;
}

/** A lint record naming `lint`; returns its event id. Waits so the next post is newer. */
async function postLintRecord(handle: ServerHandle, key: string, lint: string): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs/compile", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    lint,
    format: "rustc",
    runnerExit: 1,
    errors: RUSTC_ONE_ERROR,
  });
  expect({ status: res.status, error: res.body.error }).toEqual({ status: 200, error: undefined });
  await Bun.sleep(5);
  return res.body.event as string;
}

type Brief = Record<string, unknown> & { id: string };

async function statusOf(handle: ServerHandle, key: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}/api/v2/status?project=${key}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; status: Record<string, unknown> };
  expect(body.ok).toBe(true);
  return body.status;
}

describe("the status read keeps the newest compile record and the newest lint record apart", () => {
  test("a compile record followed by a newer lint record: lastCompile is the compile record and lastLint the lint record", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const compileId = await postCompileRecord(handle, key);
    const lintId = await postLintRecord(handle, key, "ruff");

    const status = await statusOf(handle, key);
    const lastCompile = status.lastCompile as Brief | null;
    const lastLint = status.lastLint as Brief | null | undefined;

    expect(lastCompile).not.toBeNull();
    expect(lastCompile!.id).toBe(compileId);
    expect(Object.hasOwn(lastCompile!, "lint")).toBe(false);

    expect(lastLint).toBeDefined();
    expect(lastLint).not.toBeNull();
    expect({ id: lastLint!.id, kind: lastLint!.kind, lint: lastLint!.lint }).toEqual({
      id: lintId,
      kind: "compile",
      lint: "ruff",
    });
  });

  test("a lint record followed by a newer compile record: each still answers its own field", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const lintId = await postLintRecord(handle, key, "clippy");
    const compileId = await postCompileRecord(handle, key);

    const status = await statusOf(handle, key);
    expect((status.lastCompile as Brief).id).toBe(compileId);
    expect(status.lastLint).not.toBeUndefined();
    expect(status.lastLint).not.toBeNull();
    expect((status.lastLint as Brief).id).toBe(lintId);
  });

  test("two lint records: lastLint is the newer one", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    await postLintRecord(handle, key, "ruff");
    const newer = await postLintRecord(handle, key, "clippy");

    const status = await statusOf(handle, key);
    expect(status.lastLint).not.toBeUndefined();
    expect(status.lastLint).not.toBeNull();
    expect({ id: (status.lastLint as Brief).id, lint: (status.lastLint as Brief).lint }).toEqual({
      id: newer,
      lint: "clippy",
    });
  });

  test("with only a lint record, lastCompile is null and lastLint is the lint record", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const lintId = await postLintRecord(handle, key, "ruff");

    const status = await statusOf(handle, key);
    expect(status.lastCompile).toBeNull();
    expect(status.lastLint).not.toBeUndefined();
    expect(status.lastLint).not.toBeNull();
    expect((status.lastLint as Brief).id).toBe(lintId);
  });

  test("with no lint record, lastLint is present and null, and lastCompile is the compile record", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const compileId = await postCompileRecord(handle, key);

    const status = await statusOf(handle, key);
    expect(Object.hasOwn(status, "lastLint")).toBe(true);
    expect(status.lastLint).toBeNull();
    expect((status.lastCompile as Brief).id).toBe(compileId);
  });

  test("the status answers exactly hasData, lastTest, lastCompile and lastLint", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    await postCompileRecord(handle, key);

    const status = await statusOf(handle, key);
    expect(Object.keys(status).sort()).toEqual(["hasData", "lastCompile", "lastLint", "lastTest"]);
  });
});
