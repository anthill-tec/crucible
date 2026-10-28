// The projects read (`handleProjectsList`, GET /api/v2/projects) reports, as
// each project's `lastEvent`, its newest TEST RUN or COMPILE RESULT: the
// newest events-table row that is not a registration (`lifecycle`). A
// milestone, a gate or a registration is never a run, so none of them is ever
// the project's last event — even when it is the project's newest event — and
// a project holding neither a run nor a compile result reports `null`.
//
// The project's ACTIVITY is a different question and keeps its own answer:
// `lastActivity` still counts every event (milestones, gates and
// registrations included), so a project whose only recent event is a
// milestone or an unregistration stays active by the same rule as before.
//
// Scope and cost are unchanged: an archived project's `lastEvent` stays
// `null` in the archived listing, the read is bounded (the rows it reads do
// not grow with the history behind it), and it touches no run_suites,
// run_cases or run_details row.
//
// Every expected brief is the events list's own brief of the same event
// (GET /api/v2/events), so `lastEvent` is checked byte-for-byte against the
// shape the feed serves — never against a mirror of `eventBrief`.
//
// Determinism: every event is recorded under a frozen clock, each at its own
// whole-second instant after a fixed epoch, and each test boots its own
// in-memory store.
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import type { Database, Statement } from "bun:sqlite";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { resolveLimit } from "../src/limits.ts";
import type { RunEvent, SuiteNode } from "../src/types.ts";
import type { CompileReport } from "../src/codecs/compile.ts";

let handle: ServerHandle | undefined;

afterEach(() => {
  setSystemTime();
  handle?.stop();
  handle = undefined;
});

/** 2025-01-01T00:00:00.000Z — the fixed epoch every fixture instant counts from. */
const EPOCH_MS = 1_735_689_600_000;

/** Freeze the clock `seconds` whole seconds after the fixed epoch. */
function clockAt(seconds: number): void {
  setSystemTime(EPOCH_MS + seconds * 1_000);
}

function boot(): ServerHandle {
  clockAt(0);
  handle = startServer({ port: 0, dbPath: ":memory:" });
  return handle;
}

function base(): string {
  return `http://127.0.0.1:${handle!.server.port}`;
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base()}${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A fixed project key: the routes take only a UUID-shaped one. */
function keyOf(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function addProject(key: string, name: string): void {
  handle!.store.addProject({ key, name, type: "backend", sutRoot: "/tmp/p", retention: 1_000_000 });
}

function sizedTree(): SuiteNode[] {
  return [1, 2].map((s) => ({
    name: `Suite${s}`,
    status: "pass" as const,
    children: [1, 2, 3].map((c) => ({ name: `case-${s}-${c}`, status: "pass" as const, duration_ms: 1 })),
  }));
}

/** A passing 5/5 test run, with a small tree and raw output. */
function passingRun(key: string, agentId = "run-agent"): RunEvent {
  return handle!.store.recordTestEvent(
    key,
    agentId,
    {
      summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 21 },
      tree: sizedTree(),
      raw: "the full captured run output",
    },
    {},
  );
}

const ONE_ERROR_TWO_WARNINGS: CompileReport = {
  format: "tsc",
  errorCount: 1,
  warningCount: 2,
  diagnostics: [
    { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
    { file: "src/b.ts", line: 2, col: 5, code: "TS6133", message: "'y' is declared but never used.", level: "warning" },
    { file: "src/c.ts", line: 3, col: 9, code: "TS6133", message: "'z' is declared but never used.", level: "warning" },
  ],
  raw: "tsc raw tail",
};

/** The project's whole feed as the events list briefs it, newest first. */
async function feed(key: string): Promise<Array<Record<string, unknown>>> {
  const body = await getJson(`/api/v2/events?project=${key}&limit=1000`);
  return (body.events as Array<Record<string, unknown>>).map((e) => {
    const { decisionSummary: _ignored, ...brief } = e;
    return brief;
  });
}

/** The events list's brief of one event of the project. */
async function feedBrief(key: string, id: string): Promise<Record<string, unknown>> {
  const brief = (await feed(key)).find((e) => e.id === id);
  expect(brief, `the events list holds no event ${id}`).toBeDefined();
  return brief!;
}

async function projectsListing(archived = false): Promise<Array<Record<string, unknown>>> {
  const body = await getJson(archived ? "/api/v2/projects?archived=true" : "/api/v2/projects");
  expect(body.ok).toBe(true);
  return body.projects as Array<Record<string, unknown>>;
}

async function projectOf(key: string, archived = false): Promise<Record<string, unknown>> {
  const project = (await projectsListing(archived)).find((p) => p.key === key);
  expect(project, `the projects listing holds no project ${key}`).toBeDefined();
  return project!;
}

/** Precondition: the project's newest feed row is the non-run named here, so
 *  the test really asks what it says it asks. */
async function expectNewestFeedRowKind(key: string, kind: string, id?: string): Promise<void> {
  const newest = (await feed(key))[0]!;
  expect(newest.kind).toBe(kind);
  if (id !== undefined) expect(newest.id).toBe(id);
}

interface QueryRecord {
  sql: string;
  rows: number;
}

/** Every query the store's own connection issues while `body` runs, with the
 *  rows `.all()`/`.values()`/`.get()` hand back — the same instrumentation
 *  the bounded-read and zero-detail-row tests use. Never timing. */
async function recordQueries(body: () => Promise<unknown>): Promise<QueryRecord[]> {
  const db = (handle!.store as unknown as { db: Database }).db;
  const query = db.query.bind(db);
  const records: QueryRecord[] = [];
  const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
    const stmt = query(sql) as Statement;
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "all" || prop === "values") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown[]).apply(target, args);
            records.push({ sql, rows: out.length });
            return out;
          };
        }
        if (prop === "get") {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            records.push({ sql, rows: out !== null && out !== undefined ? 1 : 0 });
            return out;
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  }) as typeof db.query);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return records;
}

function totalRows(records: QueryRecord[]): number {
  return records.reduce((sum, r) => sum + r.rows, 0);
}

function rowsFromTable(records: QueryRecord[], table: string): number {
  const re = new RegExp(`\\bFROM\\s+${table}\\b`, "i");
  return records.filter((r) => re.test(r.sql)).reduce((sum, r) => sum + r.rows, 0);
}

describe("a project's last event is its newest test run, never a newer milestone, gate or registration", () => {
  test("a project whose newest event is a pre-merge-gate milestone reports the newest test run as its last event", async () => {
    boot();
    const key = keyOf(1);
    addProject(key, "pre-merge-gate");
    clockAt(1);
    const run = passingRun(key);
    clockAt(2);
    const milestone = handle!.store.recordMilestoneEvent(key, "gate-orchestrator", "pre-merge-gate", {
      label: "pre-merge gate",
    }).event;
    clockAt(3);
    await expectNewestFeedRowKind(key, "milestone", milestone.id);

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(run.id);
    expect(lastEvent.kind).toBe("test");
    expect(lastEvent.total).toBe(5);
    expect(lastEvent.passed).toBe(5);
    expect(lastEvent).toEqual(await feedBrief(key, run.id));
    expect("type" in lastEvent).toBe(false);
  });

  test("a project whose newest event is a cr-merged milestone reports the newest test run as its last event", async () => {
    boot();
    const key = keyOf(2);
    addProject(key, "cr-merged");
    clockAt(1);
    const run = passingRun(key);
    clockAt(2);
    const milestone = handle!.store.recordMilestoneEvent(key, "close-orchestrator", "cr-merged", {
      label: "a merged change",
    }).event;
    clockAt(3);
    await expectNewestFeedRowKind(key, "milestone", milestone.id);

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(run.id);
    expect(lastEvent.kind).toBe("test");
    expect(lastEvent.passed).toBe(5);
    expect(lastEvent).toEqual(await feedBrief(key, run.id));
  });

  test("a project whose newest event is a gate reports the newest test run as its last event", async () => {
    boot();
    const key = keyOf(3);
    addProject(key, "gate");
    clockAt(1);
    const run = passingRun(key);
    clockAt(2);
    const gate = handle!.store.recordGateEvent(key, "gate-agent", { outcome: "pass", steps: [] });
    clockAt(3);
    await expectNewestFeedRowKind(key, "gate", gate.id);

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(run.id);
    expect(lastEvent.kind).toBe("test");
    expect(lastEvent).toEqual(await feedBrief(key, run.id));
    expect("gate" in lastEvent).toBe(false);
  });

  test("a project whose newest event is a fresh agent's registration reports the newest test run as its last event", async () => {
    boot();
    const key = keyOf(4);
    addProject(key, "registration");
    clockAt(1);
    const run = passingRun(key);
    clockAt(2);
    // A fresh id: only a registration that creates the agent row writes a
    // lifecycle event (a re-registration of a live id writes none).
    const registered = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId: "fresh-orchestrator",
      role: "ORCHESTRATOR",
    });
    expect(registered.ok).toBe(true);
    expect(registered.changed).toBe(true);
    clockAt(3);
    await expectNewestFeedRowKind(key, "lifecycle");

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(run.id);
    expect(lastEvent.kind).toBe("test");
    expect(lastEvent).toEqual(await feedBrief(key, run.id));
    expect("action" in lastEvent).toBe(false);
  });

  test("a project whose newest event is an agent's unregistration reports the newest test run as its last event", async () => {
    boot();
    const key = keyOf(5);
    addProject(key, "unregistration");
    clockAt(1);
    await postJson("/api/v2/agents/register", { projectKey: key, agentId: "leaving-orchestrator", role: "ORCHESTRATOR" });
    clockAt(2);
    const run = passingRun(key);
    clockAt(3);
    const unregistered = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId: "leaving-orchestrator" });
    expect(unregistered.changed).toBe(true);
    clockAt(4);
    await expectNewestFeedRowKind(key, "lifecycle");

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(run.id);
    expect(lastEvent.kind).toBe("test");
    expect(lastEvent).toEqual(await feedBrief(key, run.id));
  });

  test("a project whose newest test run was aborted, behind a newer milestone, reports the aborted run as its last event", async () => {
    boot();
    const key = keyOf(6);
    addProject(key, "aborted-run");
    clockAt(1);
    passingRun(key);
    clockAt(2);
    const open = handle!.store.startRun(key, "abort-agent");
    clockAt(3);
    const aborted = handle!.store.abortOpenRun(open.runId, "agent died");
    expect(aborted).not.toBeNull();
    clockAt(4);
    handle!.store.recordMilestoneEvent(key, "gate-orchestrator", "pre-merge-gate", { label: "pre-merge gate" });
    clockAt(5);
    await expectNewestFeedRowKind(key, "milestone");

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(aborted!.id);
    expect(lastEvent.kind).toBe("test");
    expect(lastEvent.status).toBe("aborted");
    expect(lastEvent.abortReason).toBe("agent died");
    expect(lastEvent).toEqual(await feedBrief(key, aborted!.id));
  });
});

describe("a project's last event is its newest compile result when that is newer than its newest test run", () => {
  test("a compile result behind a newer milestone is reported as the last event, carrying its errors and warnings", async () => {
    boot();
    const key = keyOf(7);
    addProject(key, "compile");
    clockAt(1);
    passingRun(key);
    clockAt(2);
    const compile = handle!.store.recordCompileEvent(key, "compile-agent", ONE_ERROR_TWO_WARNINGS, {});
    clockAt(3);
    handle!.store.recordMilestoneEvent(key, "gate-orchestrator", "pre-merge-gate", { label: "pre-merge gate" });
    clockAt(4);
    await expectNewestFeedRowKind(key, "milestone");

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(compile.id);
    expect(lastEvent.kind).toBe("compile");
    expect(lastEvent.errors).toBe(1);
    expect(lastEvent.warnings).toBe(2);
    expect(lastEvent.diagnostics).toEqual([
      { file: "src/a.ts", line: 1, col: 1, code: "TS2304", message: "Cannot find name 'x'.", level: "error" },
      { file: "src/b.ts", line: 2, col: 5, code: "TS6133", message: "'y' is declared but never used.", level: "warning" },
    ]);
    expect(lastEvent).toEqual(await feedBrief(key, compile.id));
  });

  test("a test run newer than a compile result, behind a newer gate and registration, is reported as the last event", async () => {
    boot();
    const key = keyOf(8);
    addProject(key, "run-after-compile");
    clockAt(1);
    handle!.store.recordCompileEvent(key, "compile-agent", ONE_ERROR_TWO_WARNINGS, {});
    clockAt(2);
    const run = passingRun(key);
    clockAt(3);
    handle!.store.recordGateEvent(key, "gate-agent", { outcome: "pass", steps: [] });
    clockAt(4);
    await postJson("/api/v2/agents/register", { projectKey: key, agentId: "late-orchestrator", role: "ORCHESTRATOR" });
    clockAt(5);
    await expectNewestFeedRowKind(key, "lifecycle");

    const lastEvent = (await projectOf(key)).lastEvent as Record<string, unknown>;

    expect(lastEvent.id).toBe(run.id);
    expect(lastEvent.kind).toBe("test");
    expect("errors" in lastEvent).toBe(false);
    expect(lastEvent).toEqual(await feedBrief(key, run.id));
  });
});

describe("a project holding no test run and no compile result has no last event", () => {
  test("a project holding only milestones, a gate and registrations reports a null last event, beside a project whose runs are its own", async () => {
    boot();
    const quiet = keyOf(9);
    const busy = keyOf(10);
    addProject(quiet, "records-only");
    addProject(busy, "runs");
    clockAt(1);
    const busyRun = passingRun(busy);
    clockAt(2);
    handle!.store.recordMilestoneEvent(quiet, "gate-orchestrator", "pre-merge-gate", { label: "pre-merge gate" });
    clockAt(3);
    handle!.store.recordGateEvent(quiet, "gate-agent", { outcome: "pass", steps: [] });
    clockAt(4);
    await postJson("/api/v2/agents/register", { projectKey: quiet, agentId: "quiet-orchestrator", role: "ORCHESTRATOR" });
    clockAt(5);
    handle!.store.recordMilestoneEvent(quiet, "close-orchestrator", "cr-merged", { label: "a merged change" });
    clockAt(6);
    expect((await feed(quiet)).length).toBe(4);

    const listing = await projectsListing();
    const quietProject = listing.find((p) => p.key === quiet)!;
    const busyProject = listing.find((p) => p.key === busy)!;

    expect(quietProject.lastEvent).toBeNull();
    // Another project's run is never borrowed as this project's last event.
    expect((busyProject.lastEvent as Record<string, unknown>).id).toBe(busyRun.id);
  });

  test("a project holding no event at all reports a null last event", async () => {
    // GREEN-GUARD: holds today; pins that the new read keeps `null` for an
    // empty project.
    boot();
    const key = keyOf(11);
    addProject(key, "empty");
    clockAt(1);

    const project = await projectOf(key);

    expect(project.lastEvent).toBeNull();
    expect(project.lastActivity).toBe(0);
  });
});

describe("the last event keeps the projects read's scope", () => {
  test("an archived project's last event stays null in the archived listing, and it is absent from the live one", async () => {
    // GREEN-GUARD: holds today (the archived listing's newest-event read is
    // scoped to projects that are not archived); pins that the new read
    // keeps the same scope.
    boot();
    const key = keyOf(12);
    addProject(key, "archived");
    clockAt(1);
    passingRun(key);
    clockAt(2);
    handle!.store.recordCompileEvent(key, "compile-agent", ONE_ERROR_TWO_WARNINGS, {});
    clockAt(3);
    handle!.store.recordMilestoneEvent(key, "close-orchestrator", "cr-merged", { label: "a merged change" });
    clockAt(4);
    expect(handle!.store.archiveProject(key)).toBe(true);
    clockAt(5);

    const archived = await projectsListing(true);
    expect(archived.length).toBe(1);
    expect(archived[0]!.key).toBe(key);
    expect(archived[0]!.lastEvent).toBeNull();
    expect((await projectsListing()).some((p) => p.key === key)).toBe(false);
  });
});

describe("a project's activity still counts every event", () => {
  test("a project whose only recent event is a milestone stays active, its last activity that milestone's instant", async () => {
    // GREEN-GUARD: holds today; pins that the last-run read never replaces
    // the newest-event read that activity is measured from.
    boot();
    const inactiveMs = resolveLimit("project_inactive_ms");
    const key = keyOf(13);
    addProject(key, "milestone-activity");
    clockAt(1);
    const run = passingRun(key);
    // Long after the run, well past the inactivity timeout, a milestone —
    // whose agent then leaves, so no agent's last-seen carries the instant.
    const laterSeconds = 1 + Math.ceil((3 * inactiveMs) / 1_000);
    clockAt(laterSeconds);
    const milestone = handle!.store.recordMilestoneEvent(key, "close-orchestrator", "cr-merged", {
      label: "a merged change",
    }).event;
    handle!.store.removeAgent(key, "close-orchestrator");
    clockAt(laterSeconds + 1);

    const project = await projectOf(key);

    expect(project.lastActivity).toBe(milestone.timestamp);
    expect(project.lastActivity).not.toBe(run.timestamp);
    expect(project.active).toBe(true);
  });

  test("a project whose only recent event is an agent's unregistration stays active, its last activity that unregistration's instant", async () => {
    // GREEN-GUARD: holds today, as above.
    boot();
    const inactiveMs = resolveLimit("project_inactive_ms");
    const key = keyOf(14);
    addProject(key, "unregistration-activity");
    clockAt(1);
    passingRun(key);
    const laterSeconds = 1 + Math.ceil((3 * inactiveMs) / 1_000);
    clockAt(laterSeconds);
    await postJson("/api/v2/agents/register", { projectKey: key, agentId: "brief-orchestrator", role: "ORCHESTRATOR" });
    clockAt(laterSeconds + 1);
    const unregistered = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId: "brief-orchestrator" });
    expect(unregistered.changed).toBe(true);
    clockAt(laterSeconds + 2);

    const project = await projectOf(key);

    expect(project.lastActivity).toBe(EPOCH_MS + (laterSeconds + 1) * 1_000);
    expect(project.active).toBe(true);
  });
});

describe("the last-event read is bounded and reads no suite, case or detail row", () => {
  test("the rows the projects read reads do not grow with the runs, milestones, gates and registrations behind the last run", async () => {
    // GREEN-GUARD: holds today (the newest-event read is bounded); pins that
    // the last-run read is bounded too — no scan past the registrations,
    // milestones and gates newer than the run, and none of the runs behind it.
    boot();
    const store = handle!.store;
    const key = keyOf(15);
    addProject(key, "bounded");
    let second = 1;
    for (let i = 0; i < 10; i++) {
      clockAt(second++);
      passingRun(key);
    }
    clockAt(second++);
    store.recordGateEvent(key, "run-agent", { outcome: "pass", steps: [] });
    clockAt(second++);
    store.recordMilestoneEvent(key, "run-agent", "pre-merge-gate", { label: "pre-merge gate" });
    clockAt(second++);
    const before = await recordQueries(() => getJson("/api/v2/projects"));

    // 200 more runs, older than every record above, then 50 registrations,
    // 50 milestones and 50 gates newer than every run.
    const NEXT = second;
    for (let i = 0; i < 200; i++) {
      setSystemTime(EPOCH_MS + 500 + i);
      passingRun(key);
    }
    second = NEXT;
    for (let i = 0; i < 50; i++) {
      clockAt(second++);
      store.recordLifecycleEvent(key, `fleeting-agent-${i}`, "registered");
      clockAt(second++);
      store.recordMilestoneEvent(key, "run-agent", "pre-merge-gate", { label: `pre-merge gate ${i}` });
      clockAt(second++);
      store.recordGateEvent(key, "run-agent", { outcome: "pass", steps: [] });
    }
    clockAt(second++);
    const after = await recordQueries(() => getJson("/api/v2/projects"));

    expect(totalRows(before)).toBeGreaterThan(0);
    expect(
      totalRows(after),
      `the projects read read ${totalRows(after) - totalRows(before)} more rows after 350 more events`,
    ).toBe(totalRows(before));
  });

  test("the last test run and the last compile result are briefed without a run_suites, run_cases or run_details row", async () => {
    boot();
    const store = handle!.store;
    const runKey = keyOf(16);
    const compileKey = keyOf(17);
    addProject(runKey, "detail-free-run");
    addProject(compileKey, "detail-free-compile");
    clockAt(1);
    const run = passingRun(runKey);
    clockAt(2);
    store.recordMilestoneEvent(runKey, "gate-orchestrator", "pre-merge-gate", { label: "pre-merge gate" });
    clockAt(3);
    const compile = store.recordCompileEvent(compileKey, "compile-agent", ONE_ERROR_TWO_WARNINGS, {});
    clockAt(4);
    store.recordGateEvent(compileKey, "gate-agent", { outcome: "pass", steps: [] });
    clockAt(5);

    let projects!: Array<Record<string, unknown>>;
    const records = await recordQueries(async () => {
      projects = (await getJson("/api/v2/projects")).projects as Array<Record<string, unknown>>;
    });

    const runBrief = projects.find((p) => p.key === runKey)!.lastEvent as Record<string, unknown>;
    const compileBrief = projects.find((p) => p.key === compileKey)!.lastEvent as Record<string, unknown>;
    expect(runBrief.id).toBe(run.id);
    expect(runBrief.total).toBe(5);
    expect("tree" in runBrief).toBe(false);
    expect("raw" in runBrief).toBe(false);
    expect(compileBrief.id).toBe(compile.id);
    expect(compileBrief.errors).toBe(1);
    expect(compileBrief.warnings).toBe(2);
    expect("raw" in compileBrief).toBe(false);

    expect(rowsFromTable(records, "run_suites")).toBe(0);
    expect(rowsFromTable(records, "run_cases")).toBe(0);
    expect(rowsFromTable(records, "run_details")).toBe(0);
    // The compile result's counts and diagnostics are read — the read is not
    // kept clean by reading nothing.
    expect(rowsFromTable(records, "run_compiles")).toBeGreaterThan(0);
    expect(rowsFromTable(records, "run_diagnostics")).toBeGreaterThan(0);
  });
});
