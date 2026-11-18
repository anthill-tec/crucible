// A clang-tidy run posted on the compile route as a lint record, decoded
// through gcc: whether its warnings-only output keeps its findings or falls to
// raw depends on whether the post states the linter's exit.
//
//  - A lint post that states its `runnerExit` (any value) turns gcc's
//    "no error means raw" fallback off, so the warnings keep their file, line,
//    column and bracketed check as code. A non-zero exit with no error finding
//    still gets the one synthetic error (no file, no code, naming the exit).
//  - A lint post with no `runnerExit` keeps the fallback: unreadable output is
//    never filed clean (a regression guard: passes today).
//
// The input is the real clang-tidy capture under tests/fixtures/lint/ (see its
// README). Everything is driven through the production HTTP surface
// (`startServer`, in-memory store) and read back through the event detail and
// the events list.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../src/server.ts";
import type { ServerHandle } from "../../src/server.ts";

const CLANG_TIDY_WARNINGS = readFileSync(
  join(import.meta.dir, "../fixtures", "lint", "clang-tidy-warnings.txt"),
  "utf8",
);
const BRACES = "readability-braces-around-statements";
const BRACES_MESSAGE = "statement should be inside braces";

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

interface Answered {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Answered> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const ORCHESTRATOR = "fixture-orch";

/** A project with its orchestrator registered (an ingest needs a live caller). */
async function seedProject(handle: ServerHandle): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: `clang-tidy-lint-${key}`, type: "backend", sutRoot: "/tmp/p" });
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
  await Bun.sleep(5);
  return key;
}

/** Post on the compile route as the orchestrator and expect it stored; returns the answer's body. */
async function postAccepted(
  handle: ServerHandle,
  key: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await postJson(handle, "/api/v2/runs/compile", { projectKey: key, agentId: ORCHESTRATOR, ...body });
  expect({ status: res.status, error: res.body.error }).toEqual({ status: 200, error: undefined });
  expect(res.body.event).toMatch(/^evt-/);
  return res.body;
}

interface StoredDiagnostic {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
  level: string;
}

interface StoredCompile {
  format: string;
  errorCount: number;
  warningCount: number;
  diagnostics: StoredDiagnostic[];
}

async function storedCompile(handle: ServerHandle, eventId: string): Promise<StoredCompile> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  const event = body.event as Record<string, unknown>;
  expect(event.id).toBe(eventId);
  expect(event.kind).toBe("compile");
  return event.compile as StoredCompile;
}

async function listedBrief(handle: ServerHandle, key: string, eventId: string): Promise<Record<string, unknown>> {
  const body = await getJson(handle, `/api/v2/events?project=${key}&limit=100`);
  const hits = (body.events as Record<string, unknown>[]).filter((e) => e.id === eventId);
  expect(hits.length).toBe(1);
  return hits[0]!;
}

describe("a clang-tidy lint post keeps its warnings when it states the linter's exit", () => {
  test("a lint post with format \"clang-tidy\", runnerExit 1 and warnings-only output keeps both warnings with their check as code, not raw, plus the one synthetic error: `LINT FAILED — 1 errors, 2 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "clang-tidy",
      format: "clang-tidy",
      runnerExit: 1,
      errors: CLANG_TIDY_WARNINGS,
    });

    expect(answer.verdict).toBe("LINT FAILED — 1 errors, 2 warnings");
    expect({ errors: answer.errors, warnings: answer.warnings }).toEqual({ errors: 1, warnings: 2 });

    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.format).toBe("gcc");
    expect({ errorCount: compile.errorCount, warningCount: compile.warningCount }).toEqual({
      errorCount: 1,
      warningCount: 2,
    });
    expect(compile.diagnostics).toHaveLength(3);

    const warnings = compile.diagnostics.filter((d) => d.level === "warning");
    expect(warnings).toStrictEqual([
      { file: "a.c", line: 2, col: 13, code: BRACES, message: BRACES_MESSAGE, level: "warning" },
      { file: "a.c", line: 4, col: 13, code: BRACES, message: BRACES_MESSAGE, level: "warning" },
    ]);

    const errors = compile.diagnostics.filter((d) => d.level === "error");
    expect(errors).toHaveLength(1);
    const synthetic = errors[0]!;
    expect(Object.hasOwn(synthetic, "file")).toBe(false);
    expect(Object.hasOwn(synthetic, "code")).toBe(false);
    expect(synthetic.message).toMatch(/\b1\b/);

    const brief = await listedBrief(handle, key, answer.event as string);
    expect({ errors: brief.errors, warnings: brief.warnings, lint: brief.lint }).toEqual({
      errors: 1,
      warnings: 2,
      lint: "clang-tidy",
    });
  });

  test("regression guard: a lint post with format \"clang-tidy\", no runnerExit and the same warnings-only output still falls back to raw with no findings", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "clang-tidy",
      format: "clang-tidy",
      errors: CLANG_TIDY_WARNINGS,
    });

    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.format).toBe("raw");
    expect(compile.diagnostics).toStrictEqual([]);
  });
});
