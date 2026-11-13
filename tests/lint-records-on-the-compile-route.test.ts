// A lint run reaches the board on the compile route as a MARKED compile
// record: the post names its linter in `lint` and states the linter's exit in
// `runnerExit`. The record keeps `kind: "compile"`; the marker rides the
// event's payload and comes back as `lint` on the event and on every brief
// built from it, and is absent on every record posted without one.
//
// What is pinned here, all through the real production HTTP surface
// (`startServer`, in-memory store) and the board's own reads:
//  - the marker: accepted, stored, returned; refused (400, nothing stored)
//    when it is not a non-empty string; absent, byte-for-byte as before, on a
//    post without it;
//  - records written by a post that never names a linter read back as plain
//    compile records (a guard);
//  - the verdict: `LINT FAILED — N errors, M warnings` / `LINT OK — M warnings`;
//    a non-zero exit over output recording no error stores one synthetic
//    error naming the exit; a bad `runnerExit` is refused as `/api/v2/runs`
//    refuses it (`refuseBadRunnerExit`, src/v2.ts);
//  - a clean lint run with empty output is filed; an empty compile post is
//    still refused (a guard);
//  - the agent's last outcome says `lint · …`;
//  - the hint after a lint post names lint, not the compile panel;
//  - a lint post rides the run lifecycle as a compile post does: it closes the
//    open run whose `runId` it carries, it is refused on a run that streams
//    its record, and it stamps the release it names;
//  - a store holding compile rows written before the marker existed (payload
//    with no `lint` key, seeded straight into the store) opens and reads every
//    row back as a plain compile record.
//
// Every lint post here uses a decoder that exists today (`rustc`, or a format
// that falls to detection), so no decoder output is pinned.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { hints } from "../src/hints.ts";
import type { CompileReport } from "../src/codecs/compile.ts";
import { eventLine, sendBatch, STREAM_CODEC, utf8 } from "./helpers/run-stream-harness.ts";

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

async function sendJson(
  handle: ServerHandle,
  method: "POST" | "PATCH",
  route: string,
  body: unknown,
): Promise<Answered> {
  const res = await fetch(`${base(handle)}${route}`, {
    method,
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

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORCHESTRATOR = "fixture-orch";
const COMPILE_ROUTE = "/api/v2/runs/compile";

/** A project with its orchestrator registered (an ingest needs a live caller). */
async function seedProject(handle: ServerHandle): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: `lint-route-${key}`, type: "backend", sutRoot: "/tmp/p" });
  const res = await sendJson(handle, "POST", "/api/v2/agents/register", {
    projectKey: key,
    agentId: ORCHESTRATOR,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
  // Let the clock move past the registration's own lifecycle row.
  await Bun.sleep(5);
  return key;
}

/** Post on the compile route as the orchestrator. */
async function postCompile(
  handle: ServerHandle,
  key: string,
  body: Record<string, unknown>,
): Promise<Answered> {
  return sendJson(handle, "POST", COMPILE_ROUTE, { projectKey: key, agentId: ORCHESTRATOR, ...body });
}

/** Post and expect it stored; returns the answer's body. */
async function postAccepted(
  handle: ServerHandle,
  key: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await postCompile(handle, key, body);
  expect({ status: res.status, error: res.body.error }).toEqual({ status: 200, error: undefined });
  expect(res.body.event).toMatch(/^evt-/);
  return res.body;
}

/** Two rustc errors and one rustc warning, each with its location line. */
const RUSTC_TWO_ERRORS_ONE_WARNING = [
  "error: this comparison involving the minimum or maximum element is always true",
  " --> src/lib.rs:3:5",
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused variable: `x`",
  " --> src/main.rs:2:9",
].join("\n");

/** One rustc error, nothing else. */
const RUSTC_ONE_ERROR = ["error[E0308]: mismatched types", " --> src/lib.rs:12:5"].join("\n");

/** One rustc warning, nothing else. */
const RUSTC_ONE_WARNING = ["warning: unused variable: `x`", " --> src/main.rs:2:9"].join("\n");

/** A linter that failed on its own configuration: no finding line at all. */
const LINTER_FAILED_NO_FINDING = [
  "ruff failed",
  "  Cause: Failed to parse /p/pyproject.toml",
  "  Cause: TOML parse failed",
].join("\n");

/** One tsc error — a plain compile post, as the sibling compile tests post. */
const TSC_ONE_ERROR = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";

type Brief = Record<string, unknown> & { id: string };

/** Every stored event of the project, as briefs, from the events list. */
async function listedEvents(handle: ServerHandle, key: string): Promise<Brief[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}&limit=100`);
  return body.events as Brief[];
}

/** How many compile-kind events the project holds (lint records are compile-kind). */
async function compileEventCount(handle: ServerHandle, key: string): Promise<number> {
  return (await listedEvents(handle, key)).filter((e) => e.kind === "compile").length;
}

/** The ONE events-list brief carrying `eventId` (exactly one, never more). */
async function fromList(handle: ServerHandle, key: string, eventId: string): Promise<Brief> {
  const hits = (await listedEvents(handle, key)).filter((e) => e.id === eventId);
  expect(hits.length).toBe(1);
  return hits[0]!;
}

async function fromDetail(handle: ServerHandle, eventId: string): Promise<Brief> {
  const body = await getJson(handle, `/api/v2/events/${eventId}`);
  const event = body.event as Brief;
  expect(event.id).toBe(eventId);
  return event;
}

async function statusOf(handle: ServerHandle, key: string): Promise<Record<string, Brief | null>> {
  const body = await getJson(handle, `/api/v2/status?project=${key}`);
  return body.status as Record<string, Brief | null>;
}

async function fromProjectLastEvent(handle: ServerHandle, key: string, eventId: string): Promise<Brief> {
  const body = await getJson(handle, "/api/v2/projects");
  const projects = (body.projects as { key: string; lastEvent: Brief | null }[]).filter((p) => p.key === key);
  expect(projects.length).toBe(1);
  const lastEvent = projects[0]!.lastEvent;
  expect(lastEvent).not.toBeNull();
  expect(lastEvent!.id).toBe(eventId);
  return lastEvent!;
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

/** The compile report the detail read serves for `eventId`. */
async function storedCompile(handle: ServerHandle, eventId: string): Promise<StoredCompile> {
  const event = await fromDetail(handle, eventId);
  expect(event.kind).toBe("compile");
  return event.compile as StoredCompile;
}

function hasKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

// ── The marker is accepted, stored and returned ─────────────────────────────

describe("a lint post's marker is stored and returned on the event and on every brief", () => {
  test("a post with lint \"ruff\" stores a compile-kind record whose detail event carries lint \"ruff\"", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "ruff",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });

    const event = await fromDetail(handle, answer.event as string);
    expect(event.kind).toBe("compile");
    expect(event.lint).toBe("ruff");
  });

  test("a post with lint \"ruff\" carries lint \"ruff\" on its events-list brief, its projects-list lastEvent and status lastLint", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "ruff",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });
    const eventId = answer.event as string;

    const listed = await fromList(handle, key, eventId);
    expect({ kind: listed.kind, lint: listed.lint }).toEqual({ kind: "compile", lint: "ruff" });

    const lastEvent = await fromProjectLastEvent(handle, key, eventId);
    expect(lastEvent.lint).toBe("ruff");

    const status = await statusOf(handle, key);
    expect(status.lastLint).not.toBeUndefined();
    expect(status.lastLint).not.toBeNull();
    expect({ id: status.lastLint!.id, lint: status.lastLint!.lint }).toEqual({ id: eventId, lint: "ruff" });
  });

  test("the marker is stored as given: lint \"go vet\" reads back \"go vet\", never a normalised name", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "go vet",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });
    const eventId = answer.event as string;

    expect((await fromDetail(handle, eventId)).lint).toBe("go vet");
    expect((await fromList(handle, key, eventId)).lint).toBe("go vet");
  });

  test("regression guard: a post without lint stores a record whose events-list brief is byte-identical to today's, with no lint key", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, { format: "tsc", errors: TSC_ONE_ERROR });
    const eventId = answer.event as string;

    const brief = await fromList(handle, key, eventId);
    expect(hasKey(brief, "lint")).toBe(false);
    // Today's brief, written out key by key in eventBrief's own order; only
    // the id and the timestamp are taken from the stored record.
    const expected = {
      id: eventId,
      projectKey: key,
      agentId: ORCHESTRATOR,
      kind: "compile",
      tier: "unit",
      codec: "tsc",
      timestamp: brief.timestamp,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      duration_ms: 0,
      hasCoverage: false,
      role: "ORCHESTRATOR",
      roleInferred: false,
      errors: 1,
      warnings: 0,
      diagnostics: [
        { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
      ],
    };
    expect(typeof brief.timestamp).toBe("number");
    expect(JSON.stringify(brief)).toBe(JSON.stringify(expected));
  });

  test("regression guard: a post without lint stores a record whose detail event, status lastCompile and projects lastEvent carry no lint key", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, { format: "tsc", errors: TSC_ONE_ERROR });
    const eventId = answer.event as string;

    const event = await fromDetail(handle, eventId);
    expect(hasKey(event, "lint")).toBe(false);
    expect(Object.keys(event).sort()).toEqual(
      ["agentId", "codec", "compile", "id", "kind", "projectKey", "role", "roleInferred", "tier", "timestamp"],
    );
    expect(hasKey(event.compile as Record<string, unknown>, "lint")).toBe(false);

    const status = await statusOf(handle, key);
    expect(status.lastCompile).not.toBeNull();
    expect(status.lastCompile!.id).toBe(eventId);
    expect(hasKey(status.lastCompile!, "lint")).toBe(false);

    const lastEvent = await fromProjectLastEvent(handle, key, eventId);
    expect(hasKey(lastEvent, "lint")).toBe(false);
  });

  for (const [label, lint] of [
    ["an empty string", ""],
    ["a number (5)", 5],
    ["null", null],
  ] as const) {
    test(`a lint of ${label} is refused with 400 naming lint, and nothing is stored`, async () => {
      const handle = boot();
      const key = await seedProject(handle);
      const before = await compileEventCount(handle, key);
      expect(before).toBe(0);

      const res = await postCompile(handle, key, {
        lint,
        format: "rustc",
        runnerExit: 1,
        errors: RUSTC_ONE_ERROR,
      });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/\blint\b/);
      expect(res.body.event).toBeUndefined();
      expect(await compileEventCount(handle, key)).toBe(0);
    });
  }
});

// ── Records posted without a marker read back as compile records ────────────

describe("compile records written without a marker read back as compile records", () => {
  test("regression guard: compile records posted through today's route (tsc, rustc, raw) read back on the list, detail and status with no lint and their counts unchanged", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const tsc = (await postAccepted(handle, key, { format: "tsc", errors: TSC_ONE_ERROR })).event as string;
    await Bun.sleep(5);
    const rustc = (await postAccepted(handle, key, { format: "rustc", errors: RUSTC_TWO_ERRORS_ONE_WARNING }))
      .event as string;
    await Bun.sleep(5);
    const raw = (await postAccepted(handle, key, { format: "raw", errors: "build broke: error in step 3" }))
      .event as string;

    const expectedCounts: Record<string, { codec: string; errors: number; warnings: number }> = {
      [tsc]: { codec: "tsc", errors: 1, warnings: 0 },
      [rustc]: { codec: "rustc", errors: 2, warnings: 1 },
      [raw]: { codec: "raw", errors: 1, warnings: 0 },
    };

    const listed = (await listedEvents(handle, key)).filter((e) => e.kind === "compile");
    expect(listed.map((e) => e.id).sort()).toEqual([tsc, rustc, raw].sort());
    for (const brief of listed) {
      expect({ id: brief.id, hasLint: hasKey(brief, "lint") }).toEqual({ id: brief.id, hasLint: false });
      expect({ codec: brief.codec, errors: brief.errors, warnings: brief.warnings }).toEqual(
        expectedCounts[brief.id]!,
      );
    }

    for (const id of [tsc, rustc, raw]) {
      const event = await fromDetail(handle, id);
      expect({ id, hasLint: hasKey(event, "lint") }).toEqual({ id, hasLint: false });
      const compile = event.compile as StoredCompile;
      expect({ errors: compile.errorCount, warnings: compile.warningCount }).toEqual({
        errors: expectedCounts[id]!.errors,
        warnings: expectedCounts[id]!.warnings,
      });
    }

    const status = await statusOf(handle, key);
    expect(status.lastCompile).not.toBeNull();
    expect(status.lastCompile!.id).toBe(raw);
    expect(hasKey(status.lastCompile!, "lint")).toBe(false);
  });
});

// ── The verdict follows the linter ─────────────────────────────────────────

describe("a lint post's verdict follows the linter", () => {
  test("a lint post with two errors and one warning answers `LINT FAILED — 2 errors, 1 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "clippy",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_TWO_ERRORS_ONE_WARNING,
    });

    expect(answer.verdict).toBe("LINT FAILED — 2 errors, 1 warnings");
    expect({ errors: answer.errors, warnings: answer.warnings }).toEqual({ errors: 2, warnings: 1 });
  });

  test("a lint post with one warning and exit 0 answers `LINT OK — 1 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "clippy",
      format: "rustc",
      runnerExit: 0,
      errors: RUSTC_ONE_WARNING,
    });

    expect(answer.verdict).toBe("LINT OK — 1 warnings");
    expect({ errors: answer.errors, warnings: answer.warnings }).toEqual({ errors: 0, warnings: 1 });
  });

  test("regression guard: a compile post with the same output keeps `COMPILE FAILED — 2 errors, 1 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, { format: "rustc", errors: RUSTC_TWO_ERRORS_ONE_WARNING });

    expect(answer.verdict).toBe("COMPILE FAILED — 2 errors, 1 warnings");
  });

  test("regression guard: a clean compile post keeps `COMPILE OK — 1 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, { format: "rustc", errors: RUSTC_ONE_WARNING });

    expect(answer.verdict).toBe("COMPILE OK — 1 warnings");
  });

  test("a lint post with runnerExit 2 over output holding no finding stores exactly one synthetic error naming exit 2, and answers `LINT FAILED`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "ruff",
      format: "rustc",
      runnerExit: 2,
      errors: LINTER_FAILED_NO_FINDING,
    });

    expect(answer.verdict).toBe("LINT FAILED — 1 errors, 0 warnings");
    expect({ errors: answer.errors, warnings: answer.warnings }).toEqual({ errors: 1, warnings: 0 });

    const compile = await storedCompile(handle, answer.event as string);
    expect({ errorCount: compile.errorCount, warningCount: compile.warningCount }).toEqual({
      errorCount: 1,
      warningCount: 0,
    });
    expect(compile.diagnostics).toHaveLength(1);
    const synthetic = compile.diagnostics[0]!;
    expect(synthetic.level).toBe("error");
    expect(hasKey(synthetic as unknown as Record<string, unknown>, "file")).toBe(false);
    expect(hasKey(synthetic as unknown as Record<string, unknown>, "code")).toBe(false);
    expect(synthetic.message).toMatch(/\b2\b/);

    // The brief agrees with the stored record.
    const brief = await fromList(handle, key, answer.event as string);
    expect({ errors: brief.errors, warnings: brief.warnings, lint: brief.lint }).toEqual({
      errors: 1,
      warnings: 0,
      lint: "ruff",
    });
  });

  test("the synthetic error names the exit it was given: runnerExit 7 over output with no finding names 7", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "ruff",
      format: "rustc",
      runnerExit: 7,
      errors: LINTER_FAILED_NO_FINDING,
    });

    expect(answer.verdict).toBe("LINT FAILED — 1 errors, 0 warnings");
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.diagnostics).toHaveLength(1);
    expect(compile.diagnostics[0]!.message).toMatch(/\b7\b/);
    expect(compile.diagnostics[0]!.message).not.toMatch(/\b2\b/);
  });

  test("a lint post with runnerExit 2 over warnings only stores one synthetic error beside the warning, and answers `LINT FAILED — 1 errors, 1 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "clippy",
      format: "rustc",
      runnerExit: 2,
      errors: RUSTC_ONE_WARNING,
    });

    expect(answer.verdict).toBe("LINT FAILED — 1 errors, 1 warnings");
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.diagnostics).toHaveLength(2);
    const errors = compile.diagnostics.filter((d) => d.level === "error");
    expect(errors).toHaveLength(1);
    expect(hasKey(errors[0] as unknown as Record<string, unknown>, "file")).toBe(false);
    expect(errors[0]!.message).toMatch(/\b2\b/);
  });

  test("a lint post with a non-zero exit over output that already records an error stores only the decoded findings, no synthetic error", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "clippy",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });

    expect(answer.verdict).toBe("LINT FAILED — 1 errors, 0 warnings");
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.diagnostics).toHaveLength(1);
    expect(compile.diagnostics[0]).toEqual({
      file: "src/lib.rs",
      line: 12,
      col: 5,
      code: "E0308",
      message: "mismatched types",
      level: "error",
    });
  });

  test("a lint post with no runnerExit over output holding no finding takes its verdict from the decoded counts alone: `LINT OK — 0 warnings`, no synthetic error", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "ruff",
      format: "rustc",
      errors: LINTER_FAILED_NO_FINDING,
    });

    expect(answer.verdict).toBe("LINT OK — 0 warnings");
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.errorCount).toBe(0);
    expect(compile.diagnostics).toHaveLength(0);
  });

  test("regression guard: a compile post (no lint) with runnerExit 2 over output holding no finding keeps today's verdict and stores no synthetic error", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      format: "rustc",
      runnerExit: 2,
      errors: LINTER_FAILED_NO_FINDING,
    });

    expect(answer.verdict).toBe("COMPILE OK — 0 warnings");
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.diagnostics).toHaveLength(0);
  });

  test("regression guard: a compile post (no lint) with runnerExit -1 is still accepted as today: the exit is neither validated nor used", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      format: "rustc",
      runnerExit: -1,
      errors: RUSTC_ONE_ERROR,
    });

    expect(answer.verdict).toBe("COMPILE FAILED — 1 errors, 0 warnings");
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.diagnostics).toHaveLength(1);
    expect(await compileEventCount(handle, key)).toBe(1);
  });

  test("a lint post with runnerExit 0 whose output decodes an error is never overridden by the exit: `LINT FAILED — 1 errors, 0 warnings`, only the decoded finding", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "clippy",
      format: "rustc",
      runnerExit: 0,
      errors: RUSTC_ONE_ERROR,
    });

    expect(answer.verdict).toBe("LINT FAILED — 1 errors, 0 warnings");
    expect({ errors: answer.errors, warnings: answer.warnings }).toEqual({ errors: 1, warnings: 0 });
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.errorCount).toBe(1);
    expect(compile.diagnostics).toEqual([
      { file: "src/lib.rs", line: 12, col: 5, code: "E0308", message: "mismatched types", level: "error" },
    ]);
  });

  for (const [label, runnerExit] of [
    ["-1", -1],
    ['"x"', "x"],
    ["1.5", 1.5],
  ] as const) {
    test(`a lint post with runnerExit ${label} is refused with /api/v2/runs's 400, and nothing is stored`, async () => {
      const handle = boot();
      const key = await seedProject(handle);

      const res = await postCompile(handle, key, {
        lint: "ruff",
        format: "rustc",
        runnerExit,
        errors: RUSTC_ONE_ERROR,
      });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe("runnerExit must be a non-negative integer — run NOT stored");
      expect(await compileEventCount(handle, key)).toBe(0);
    });
  }
});

// ── A clean lint run is filed ──────────────────────────────────────────────

describe("a clean lint run with empty output is filed", () => {
  test("a lint post with format \"go vet\", runnerExit 0 and empty errors stores a clean lint record with zero findings, answering `LINT OK — 0 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "go vet",
      format: "go vet",
      runnerExit: 0,
      errors: "",
    });

    expect(answer.verdict).toBe("LINT OK — 0 warnings");
    expect({ errors: answer.errors, warnings: answer.warnings }).toEqual({ errors: 0, warnings: 0 });

    const eventId = answer.event as string;
    const event = await fromDetail(handle, eventId);
    expect(event.lint).toBe("go vet");
    const compile = event.compile as StoredCompile;
    expect({ errorCount: compile.errorCount, warningCount: compile.warningCount }).toEqual({
      errorCount: 0,
      warningCount: 0,
    });
    expect(compile.diagnostics).toHaveLength(0);
    expect(await compileEventCount(handle, key)).toBe(1);
  });

  test("a lint post naming the go decoder, runnerExit 0 and empty errors is clean: go's never-clean guard does not apply", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "go vet",
      format: "go",
      runnerExit: 0,
      errors: "",
    });

    expect(answer.verdict).toBe("LINT OK — 0 warnings");
    const compile = await storedCompile(handle, answer.event as string);
    expect(compile.errorCount).toBe(0);
    expect(compile.diagnostics).toHaveLength(0);
  });

  test("a lint post with empty errors and runnerExit 2 is stored with exactly one synthetic error naming exit 2, and answers `LINT FAILED — 1 errors, 0 warnings`", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "ruff",
      format: "rustc",
      runnerExit: 2,
      errors: "",
    });

    expect(answer.verdict).toBe("LINT FAILED — 1 errors, 0 warnings");
    const event = await fromDetail(handle, answer.event as string);
    expect(event.lint).toBe("ruff");
    const compile = event.compile as StoredCompile;
    expect({ errorCount: compile.errorCount, warningCount: compile.warningCount }).toEqual({
      errorCount: 1,
      warningCount: 0,
    });
    expect(compile.diagnostics).toHaveLength(1);
    const synthetic = compile.diagnostics[0]!;
    expect(synthetic.level).toBe("error");
    expect(hasKey(synthetic as unknown as Record<string, unknown>, "file")).toBe(false);
    expect(hasKey(synthetic as unknown as Record<string, unknown>, "code")).toBe(false);
    expect(synthetic.message).toMatch(/\b2\b/);
    expect(await compileEventCount(handle, key)).toBe(1);
  });

  test("a lint post with empty errors and no runnerExit is refused as a compile post is (400), and nothing is stored", async () => {
    const handle = boot();
    const key = await seedProject(handle);

    const res = await postCompile(handle, key, { lint: "ruff", format: "rustc", errors: "" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("errors must be a non-empty string");
    expect(await compileEventCount(handle, key)).toBe(0);
  });

  test("regression guard: a compile post (no lint) with empty errors is still refused, and nothing is stored", async () => {
    const handle = boot();
    const key = await seedProject(handle);

    const res = await postCompile(handle, key, { format: "go", errors: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("errors must be a non-empty string");
    expect(await compileEventCount(handle, key)).toBe(0);
  });

  test("regression guard: a compile post (no lint) with runnerExit 0 and empty errors is still refused, and nothing is stored", async () => {
    const handle = boot();
    const key = await seedProject(handle);

    const res = await postCompile(handle, key, { format: "go", runnerExit: 0, errors: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("errors must be a non-empty string");
    expect(await compileEventCount(handle, key)).toBe(0);
  });
});

// ── The hint after a lint post ─────────────────────────────────────────────

describe("the hint after a lint post names lint, not the compile panel", () => {
  test("a lint post's help names lint and does not carry the compile-panel hint", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, {
      lint: "ruff",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });

    const help = answer.help as string[];
    expect(Array.isArray(help)).toBe(true);
    expect(help.filter((entry) => /\blint\b/i.test(entry)).length).toBeGreaterThanOrEqual(1);
    expect(help).not.toContain(hints.afterCompile[0]!);
    expect(help.filter((entry) => entry.includes("compile panel"))).toEqual([]);
  });

  test("regression guard: a compile post's help still carries the compile-panel hint and names no lint", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const answer = await postAccepted(handle, key, { format: "tsc", errors: TSC_ONE_ERROR });

    const help = answer.help as string[];
    expect(help).toContain(hints.afterCompile[0]!);
    expect(help.filter((entry) => /\blint\b/i.test(entry))).toEqual([]);
  });
});

// ── The agent's last outcome says lint ──────────────────────────────────────

interface AgentBrief {
  agentId: string;
  message: string;
  idleLine?: string;
  [key: string]: unknown;
}

async function agentById(handle: ServerHandle, key: string, agentId: string): Promise<AgentBrief> {
  const body = await getJson(handle, `/api/v2/agents?project=${key}`);
  const agent = (body.agents as AgentBrief[]).find((a) => a.agentId === agentId);
  expect(agent).toBeDefined();
  return agent!;
}

/** File a one-cycle plan, activate it, and register `agentId` bound to it. */
async function registerBoundAgent(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const filed = await sendJson(handle, "POST", `/api/v2/projects/${key}/plans`, {
    cr: "lint-outcome",
    agentId: ORCHESTRATOR,
    cycles: [{ label: "solo" }],
  });
  expect(filed.status).toBe(201);
  const planId = filed.body.planId as number;
  const cycleId = (filed.body.cycles as { id: number }[])[0]!.id;
  const activated = await sendJson(handle, "PATCH", `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    status: "active",
    agentId: ORCHESTRATOR,
  });
  expect(activated.status).toBe(200);
  const reg = await sendJson(handle, "POST", "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "GREEN",
    cycleId,
  });
  expect(reg.status).toBe(200);
}

describe("the agent's last outcome after a lint post says lint", () => {
  test("a lint post with two errors writes exactly `lint · 2 errors · ingested` onto the agent, and the idle line carries it", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const agentId = "green-lint-outcome";
    await registerBoundAgent(handle, key, agentId);

    const res = await sendJson(handle, "POST", COMPILE_ROUTE, {
      projectKey: key,
      agentId,
      lint: "clippy",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_TWO_ERRORS_ONE_WARNING,
    });
    expect(res.status).toBe(200);

    const agent = await agentById(handle, key, agentId);
    expect(agent.message).toBe("lint · 2 errors · ingested");
    expect(agent.idleLine).toBeDefined();
    expect(agent.idleLine).toContain("last run lint · 2 errors · ingested, ");
    expect(agent.idleLine).not.toContain("compile");
  });

  test("a lint post with one error writes exactly `lint · 1 error · ingested` onto the agent (singular)", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const agentId = "green-lint-one";
    await registerBoundAgent(handle, key, agentId);

    const res = await sendJson(handle, "POST", COMPILE_ROUTE, {
      projectKey: key,
      agentId,
      lint: "clippy",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });
    expect(res.status).toBe(200);

    expect((await agentById(handle, key, agentId)).message).toBe("lint · 1 error · ingested");
  });

  test("a lint post with no error (warnings only, exit 0) writes exactly `lint · clean · ingested` onto the agent", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const agentId = "green-lint-clean";
    await registerBoundAgent(handle, key, agentId);

    const res = await sendJson(handle, "POST", COMPILE_ROUTE, {
      projectKey: key,
      agentId,
      lint: "clippy",
      format: "rustc",
      runnerExit: 0,
      errors: RUSTC_ONE_WARNING,
    });
    expect(res.status).toBe(200);

    expect((await agentById(handle, key, agentId)).message).toBe("lint · clean · ingested");
  });

  test("regression guard: a compile post (no lint) still writes `compile · 1 error · ingested` onto the agent", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const agentId = "green-compile-still";
    await registerBoundAgent(handle, key, agentId);

    const res = await sendJson(handle, "POST", COMPILE_ROUTE, {
      projectKey: key,
      agentId,
      format: "rustc",
      errors: RUSTC_ONE_ERROR,
    });
    expect(res.status).toBe(200);

    expect((await agentById(handle, key, agentId)).message).toBe("compile · 1 error · ingested");
  });
});

// ── A lint post rides the run lifecycle as a compile post does ──────────────

/** Opens a run for the orchestrator with `POST /api/v2/runs/start`; answers its runId. */
async function openRun(handle: ServerHandle, key: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await sendJson(handle, "POST", "/api/v2/runs/start", { projectKey: key, agentId: ORCHESTRATOR, ...extra });
  expect(res.status).toBe(202);
  expect(typeof res.body.runId).toBe("string");
  return res.body.runId as string;
}

async function openRunIds(handle: ServerHandle, key: string): Promise<string[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return (body.openRuns as { runId: string }[]).map((r) => r.runId);
}

/** Every stored event id of the project, read off the store (a registration's lifecycle row included). */
function storedEventIds(handle: ServerHandle, key: string): string[] {
  return handle.store.listEvents(key, Number.MAX_SAFE_INTEGER).map((e) => e.id);
}

/** A complete green stream of one passing test, as a streamed run sends it. */
const ONE_PASS_STREAM =
  eventLine({ event: "run-start", total: 1 }) +
  eventLine({
    event: "test-end",
    id: "t1",
    name: "adds",
    suite: "math",
    file: "src/math.ts",
    status: "pass",
    duration_ms: 3,
  }) +
  eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 3 });

describe("a lint post rides the run lifecycle as a compile post does", () => {
  test("regression guard: a lint post carrying the runId of an open run closes that run — the run reads ended, settled by the lint record, which carries the lint marker", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const runId = await openRun(handle, key);
    expect(await openRunIds(handle, key)).toContain(runId);

    const answer = await postAccepted(handle, key, {
      runId,
      lint: "clippy",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });
    const eventId = answer.event as string;

    expect(await openRunIds(handle, key)).not.toContain(runId);
    const run = handle.store.getRun(runId);
    expect({ state: run?.state, eventId: run?.eventId }).toEqual({ state: "ended", eventId });
    const event = await fromDetail(handle, eventId);
    expect({ kind: event.kind, lint: event.lint }).toEqual({ kind: "compile", lint: "clippy" });
    // The closed run's lifecycle rides the record, as it does on a compile close.
    expect(typeof event.startedAt).toBe("number");
    // Exactly one compile-kind record: the close stored nothing beside it.
    expect(await compileEventCount(handle, key)).toBe(1);
  });

  test("regression guard: a lint post naming a streamed run's runId is refused (400 naming crucible-events), stores nothing and leaves the run open for its stream close", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    const runId = await openRun(handle, key, { stack: "bun", tier: "unit" });
    const batch = await sendBatch(handle, runId, { projectKey: key, agentId: ORCHESTRATOR, from: 0, data: ONE_PASS_STREAM });
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    expect(batch.body.held).toBe(utf8(ONE_PASS_STREAM));
    const before = storedEventIds(handle, key);

    const res = await postCompile(handle, key, {
      runId,
      lint: "clippy",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toContain("crucible-events");
    expect(res.body.event).toBeUndefined();
    expect(storedEventIds(handle, key)).toEqual(before);
    expect(handle.store.getRun(runId)?.state).toBe("open");

    // The stream is still held whole, and the proper close takes it.
    const proper = await sendJson(handle, "POST", "/api/v2/runs", {
      projectKey: key,
      agentId: ORCHESTRATOR,
      runId,
      codec: STREAM_CODEC,
    });
    expect(proper.status, JSON.stringify(proper.body)).toBe(200);
    expect(storedEventIds(handle, key)).toEqual([proper.body.event as string, ...before]);
    expect(handle.store.getRun(runId)?.state).toBe("ended");
  });

  test("regression guard: a lint post naming a declared release stamps that release on its record, beside its lint marker, as a compile post does", async () => {
    const handle = boot();
    const key = await seedProject(handle);
    handle.store.upsertQueueEntry(
      key,
      { cr: "CR-FX-4.5.0", release: "4.5.0", wave: "1", title: "Fixture CR" },
      "fixture-setup",
    );

    const answer = await postAccepted(handle, key, {
      lint: "clippy",
      format: "rustc",
      runnerExit: 1,
      errors: RUSTC_ONE_ERROR,
      release: "4.5.0",
    });
    const eventId = answer.event as string;

    const event = await fromDetail(handle, eventId);
    expect({ lint: event.lint, release: event.release }).toEqual({ lint: "clippy", release: "4.5.0" });
    // The release is stamped in its own column, read off the store's connection.
    const db = (handle.store as unknown as { db: Database }).db;
    const column = db.query<{ release: unknown }, [string]>("SELECT release FROM events WHERE id = ?").get(eventId);
    expect(column?.release).toBe("4.5.0");
  });
});

// ── A store written before the marker existed reads back as compile records ──

/** A compile report as the store kept it; no linter ever named. */
function keptReport(format: string, errors: number, warnings: number): CompileReport {
  const diagnostics: CompileReport["diagnostics"] = [
    ...Array.from({ length: errors }, (_, i) => ({
      file: "src/lib.rs",
      line: 10 + i,
      col: 5,
      code: "E0308",
      message: "mismatched types",
      level: "error" as const,
    })),
    ...Array.from({ length: warnings }, (_, i) => ({
      file: "src/main.rs",
      line: 20 + i,
      col: 9,
      message: "unused variable: `x`",
      level: "warning" as const,
    })),
  ];
  return { format, errorCount: errors, warningCount: warnings, diagnostics, raw: `${format} output` };
}

describe("a store holding compile rows written before the marker existed", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("regression guard: compile rows seeded with no lint in their payload read back on the events list and on status with no lint, their counts unchanged, and lastLint null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-route-old-store-"));
    dirs.push(dir);
    const dbPath = join(dir, "crucible.db");

    // Seed: the store's own lower-level writer, then each row's payload
    // rewritten by SQL to the shape a store wrote before the marker: no `lint`.
    const seeder = startServer({ port: 0, dbPath });
    const key = crypto.randomUUID();
    let older: string;
    let newer: string;
    try {
      seeder.store.addProject({ key, name: `lint-route-old-${key}`, type: "backend", sutRoot: "/tmp/p" });
      older = seeder.store.recordCompileEvent(key, ORCHESTRATOR, keptReport("rustc", 2, 1), { codec: "rustc" }).id;
      await Bun.sleep(5);
      newer = seeder.store.recordCompileEvent(key, ORCHESTRATOR, keptReport("tsc", 1, 0), { codec: "tsc" }).id;
    } finally {
      seeder.stop();
    }
    const raw = new Database(dbPath);
    try {
      raw.query("UPDATE events SET payload = NULL WHERE id = ?").run(older);
      raw.query("UPDATE events SET payload = ? WHERE id = ?").run(JSON.stringify({ incomplete: "legacy" }), newer);
      const lintKeys = raw
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM events WHERE project_key = ? AND kind = 'compile' AND json_extract(payload, '$.lint') IS NOT NULL",
        )
        .get(key);
      expect(lintKeys?.n).toBe(0);
    } finally {
      raw.close();
    }

    // Open it, and read every record back.
    const handle = startServer({ port: 0, dbPath });
    handles.push(handle);

    const expected: Record<string, { codec: string; errors: number; warnings: number }> = {
      [older]: { codec: "rustc", errors: 2, warnings: 1 },
      [newer]: { codec: "tsc", errors: 1, warnings: 0 },
    };
    const listed = (await listedEvents(handle, key)).filter((e) => e.kind === "compile");
    expect(listed.map((e) => e.id).sort()).toEqual([older, newer].sort());
    for (const brief of listed) {
      expect({ id: brief.id, hasLint: hasKey(brief, "lint") }).toEqual({ id: brief.id, hasLint: false });
      expect({ codec: brief.codec, errors: brief.errors, warnings: brief.warnings }).toEqual(expected[brief.id]!);
    }

    const status = await statusOf(handle, key);
    expect(status.lastCompile).not.toBeNull();
    expect(status.lastCompile!.id).toBe(newer);
    expect(hasKey(status.lastCompile!, "lint")).toBe(false);
    expect(status.lastLint).toBeNull();
  });
});
