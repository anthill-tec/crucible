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
//  - the hint after a lint post names lint, not the compile panel.
//
// Every lint post here uses a decoder that exists today (`rustc`, or a format
// that falls to detection), so no decoder output is pinned.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { hints } from "../src/hints.ts";

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
  "  Cause: TOML parse failed at line 3, column 1",
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
  test("a lint post with two errors writes `lint · 2 errors` onto the agent, never `compile`, and the idle line carries it", async () => {
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
    expect(agent.message.startsWith("lint · 2 errors")).toBe(true);
    expect(agent.message).not.toContain("compile");
    expect(agent.idleLine).toBeDefined();
    expect(agent.idleLine).toContain("last run lint · 2 errors");
    expect(agent.idleLine).not.toContain("compile");
  });

  test("a lint post with no error (warnings only, exit 0) writes `lint · clean` onto the agent", async () => {
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

    const agent = await agentById(handle, key, agentId);
    expect(agent.message.startsWith("lint · clean")).toBe(true);
    expect(agent.message).not.toContain("compile");
    expect(agent.message).not.toContain("errors");
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
