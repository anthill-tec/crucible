// A Go compile report posted to `POST /api/v2/runs/compile` with
// `format: "go"` is decoded by the board and stored as a compile record of
// format `go`: the record names the format and carries the diagnostics, and a
// failure with no positioned diagnostic (an import cycle) is stored as a
// failed compile with one error — never `COMPILE OK`.
//
// Driven through the real production HTTP surface (`startServer`, an
// in-memory store), the register and compile routes a client uses; the stored
// record is read back through `GET /api/v2/events/<id>`. The inputs are the
// real Go 1.27.3 captures under tests/fixtures/go-build/ (see its README).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "go-build");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

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

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedProject(handle: ServerHandle): string {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "go-module", type: "backend", sutRoot: "/tmp/go-module" });
  return key;
}

async function registerAgent(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
}

interface CompileAnswer {
  ok: boolean;
  event: string;
  errors: number;
  warnings: number;
  verdict: string;
}

interface StoredCompile {
  kind: string;
  codec?: string;
  compile: {
    format: string;
    errorCount: number;
    warningCount: number;
    diagnostics: Array<Record<string, unknown>>;
    raw: string;
  };
}

async function postGoCompile(
  handle: ServerHandle,
  key: string,
  agentId: string,
  errors: string,
): Promise<{ answer: CompileAnswer; stored: StoredCompile }> {
  const res = await postJson(handle, "/api/v2/runs/compile", {
    projectKey: key,
    agentId,
    format: "go",
    errors,
  });
  expect(res.status).toBe(200);
  const answer = (await res.json()) as CompileAnswer;
  const read = await fetch(`${base(handle)}/api/v2/events/${answer.event}`);
  expect(read.status).toBe(200);
  const stored = ((await read.json()) as { event: StoredCompile }).event;
  return { answer, stored };
}

describe("a go compile report posted to the compile route is stored as format go", () => {
  test("a go build capture is stored as a compile record of format `go` carrying its diagnostics", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await registerAgent(handle, key, "go-compiler");
    const errors = fixture("build-multi-package-too-many-errors.txt");

    const { answer, stored } = await postGoCompile(handle, key, "go-compiler", errors);

    expect(answer.errors).toBe(14);
    expect(answer.warnings).toBe(0);
    expect(answer.verdict.startsWith("COMPILE FAILED")).toBe(true);

    expect(stored.kind).toBe("compile");
    expect(stored.codec).toBe("go");
    expect(stored.compile.format).toBe("go");
    expect(stored.compile.errorCount).toBe(14);
    expect(stored.compile.warningCount).toBe(0);
    expect(stored.compile.diagnostics).toHaveLength(14);
    // The first and last records survive the store round trip field for field.
    expect(stored.compile.diagnostics[0]).toStrictEqual({
      file: "api/api.go",
      line: 4,
      col: 6,
      message: "declared and not used: code",
      level: "error",
    });
    expect(stored.compile.diagnostics[13]).toStrictEqual({
      file: "./main.go",
      line: 6,
      col: 14,
      message: "undefined: total",
      level: "error",
    });
    expect(
      stored.compile.diagnostics.filter((d) => String(d.message).includes("too many errors")),
    ).toEqual([]);
    expect(stored.compile.raw).toBe(errors);
  });

  test("an import-cycle capture is stored as a failed compile with one error, not `COMPILE OK`", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await registerAgent(handle, key, "go-compiler");

    const { answer, stored } = await postGoCompile(
      handle,
      key,
      "go-compiler",
      fixture("build-import-cycle.txt"),
    );

    expect(answer.errors).toBe(1);
    expect(answer.verdict.startsWith("COMPILE FAILED")).toBe(true);
    expect(answer.verdict).not.toContain("COMPILE OK");

    expect(stored.compile.format).toBe("go");
    expect(stored.codec).toBe("go");
    expect(stored.compile.errorCount).toBe(1);
    expect(stored.compile.warningCount).toBe(0);
    expect(stored.compile.diagnostics).toHaveLength(1);
    const only = stored.compile.diagnostics[0] ?? {};
    expect(only.level).toBe("error");
    expect("file" in only).toBe(false);
    expect(String(only.message).replace(/\s+/g, " ").trim()).toBe(
      "package example.com/cycle/billing " +
        "imports example.com/cycle/orders from billing.go " +
        "imports example.com/cycle/billing from orders.go: import cycle not allowed",
    );
  });
});
