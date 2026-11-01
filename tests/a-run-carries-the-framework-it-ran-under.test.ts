// A run carries the framework it ran under, stored beside its stack
// (CR-CRU-225 §S1, AC1; P4):
//  - the routes: `POST /api/v2/runs/start`, `/runs`, `/runs/parsed` and
//    `/runs/compile` take an optional `framework`, a non-empty string; an
//    empty or non-string value is a 400 that stores nothing (a start opens no
//    run, an ingest stores no event);
//  - the close (`resolveRunClose`): an ingest closing a run states the same
//    framework as its start, or none — a different one is a 400, as `stack`
//    is, and the run stays open; a close stating none inherits the start's;
//  - the answers: the event (`GET /api/v2/events/<id>` and the event brief on
//    `GET /api/v2/events`), the run brief (the run row `Store#getRun` maps)
//    and the open-run brief (`openRunBrief`, `openRuns[]`), each wherever it
//    answers `stack`, the key ABSENT when the run states none;
//  - the timeline: a read across a test run, a milestone and a gate still
//    answers all three (the record projections carry `NULL AS framework`);
//  - the schema: migration v23 adds a nullable `framework` to `events` and
//    `runs`, a brand-new store's columns equal a store migrated from v22,
//    and rows stored before it read unchanged with no framework. A store
//    migrated from v22 reaches the build's own schema version.
//
// Modelled on run-close-carries-stack-and-tier.test.ts (the stack rules this
// mirrors) and a-run-start-carries-the-total-its-live-state-reads.test.ts
// (the v22 migration this follows).
//
// The board is string-only (P1): it stores any non-empty framework and never
// checks it against a vocabulary — the bun client does that.
//
// SAFETY: every server binds port 0 on ":memory:"; a migrated store is a file
// under a fresh OS tmpdir, removed after each test.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerHandle } from "../src/server.ts";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  getJson,
  postJson,
  readyProject,
  sendBatch,
  utf8,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];
const scratchDirs: string[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

function boot(dbPath = ":memory:"): ServerHandle {
  const handle = bootOn(dbPath);
  handles.push(handle);
  return handle;
}

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

const AGENT = "framework-runner";

// ── The routes and their minimal bodies ─────────────────────────────────────

type IngestRoute = "/api/v2/runs" | "/api/v2/runs/parsed" | "/api/v2/runs/compile";

const INGEST_ROUTES: readonly IngestRoute[] = ["/api/v2/runs", "/api/v2/runs/parsed", "/api/v2/runs/compile"];

const JUNIT_ONE_PASS = ['<testsuite name="Suite" tests="1">', '<testcase name="t1" time="0.01"/>', "</testsuite>"].join(
  "\n",
);

const TSC_ONE_ERROR = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";

/** The route's own payload — no stack, no tier, no framework, no runId. */
function payloadFor(route: IngestRoute): Record<string, unknown> {
  switch (route) {
    case "/api/v2/runs":
      return { codec: "junit", data: JUNIT_ONE_PASS };
    case "/api/v2/runs/parsed":
      return {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
        tree: [{ name: "Suite", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 10 }] }],
      };
    case "/api/v2/runs/compile":
      return { format: "tsc", errors: TSC_ONE_ERROR };
    default:
      throw new Error(`no payload for route ${String(route)}`);
  }
}

function ingest(handle: ServerHandle, route: IngestRoute, key: string, extra: Record<string, unknown>) {
  return postJson(handle, route, { projectKey: key, agentId: AGENT, ...payloadFor(route), ...extra });
}

function start(handle: ServerHandle, key: string, extra: Record<string, unknown>) {
  return postJson(handle, "/api/v2/runs/start", { projectKey: key, agentId: AGENT, ...extra });
}

async function openWith(handle: ServerHandle, key: string, extra: Record<string, unknown>): Promise<string> {
  const res = await start(handle, key, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  expect(typeof res.body.runId).toBe("string");
  return res.body.runId as string;
}

// ── The board's own reads ───────────────────────────────────────────────────

type Wire = Record<string, unknown>;

async function eventDetail(handle: ServerHandle, eventId: unknown): Promise<Wire> {
  expect(typeof eventId, "the ingest must answer the event it stored").toBe("string");
  const body = await getJson(handle, `/api/v2/events/${eventId as string}`);
  return body.event as Wire;
}

async function eventsList(handle: ServerHandle, key: string): Promise<{ events: Wire[]; openRuns: Wire[] }> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return { events: body.events as Wire[], openRuns: body.openRuns as Wire[] };
}

async function eventBrief(handle: ServerHandle, key: string, eventId: unknown): Promise<Wire> {
  const brief = (await eventsList(handle, key)).events.find((e) => e.id === eventId);
  expect(brief, `event ${String(eventId)} is in the feed`).toBeDefined();
  return brief as Wire;
}

async function openRunBriefOf(handle: ServerHandle, key: string, runId: string): Promise<Wire> {
  const brief = (await eventsList(handle, key)).openRuns.find((r) => r.runId === runId);
  expect(brief, `run ${runId} is in openRuns`).toBeDefined();
  return brief as Wire;
}

async function eventIds(handle: ServerHandle, key: string): Promise<unknown[]> {
  return (await eventsList(handle, key)).events.map((e) => e.id);
}

async function openRunIds(handle: ServerHandle, key: string): Promise<unknown[]> {
  return (await eventsList(handle, key)).openRuns.map((r) => r.runId);
}

/** The run's `runs.framework` column, read off the store's own connection. */
function storedRunFramework(handle: ServerHandle, runId: string): string | null | undefined {
  return dbOf(handle.store)
    .query<{ framework: string | null }, [string]>("SELECT framework FROM runs WHERE run_id = ?")
    .get(runId)?.framework;
}

/** The event's `events.framework` column, read off the store's own connection. */
function storedEventFramework(handle: ServerHandle, eventId: string): string | null | undefined {
  return dbOf(handle.store)
    .query<{ framework: string | null }, [string]>("SELECT framework FROM events WHERE id = ?")
    .get(eventId)?.framework;
}

const NOT_A_WORD: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: "an empty string", value: "" },
  { label: "a number", value: 42 },
  { label: "an object", value: {} },
  { label: "a list", value: ["vitest"] },
];

// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/v2/runs/start takes an optional framework, a non-empty string", () => {
  test("a run started with framework vitest stores it on the run; the run brief and the open-run brief answer it beside the stack", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "framework-start");
    const runId = await openWith(handle, key, { stack: "bun", tier: "unit", framework: "vitest" });

    expect(storedRunFramework(handle, runId)).toBe("vitest");
    const run = handle.store.getRun(runId);
    expect(run).toHaveProperty("framework", "vitest");
    expect(run).toHaveProperty("stack", "bun");
    const brief = await openRunBriefOf(handle, key, runId);
    expect(brief.framework).toBe("vitest");
    expect(brief.stack).toBe("bun");
  });

  test("a run started with no framework stores NULL, and neither the run brief nor the open-run brief carries a framework key", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "framework-start-none");
    const runId = await openWith(handle, key, { stack: "bun", tier: "unit" });

    expect(storedRunFramework(handle, runId)).toBeNull();
    expect(handle.store.getRun(runId)).not.toHaveProperty("framework");
    const brief = await openRunBriefOf(handle, key, runId);
    expect(brief.stack).toBe("bun");
    expect(brief).not.toHaveProperty("framework");
  });

  for (const bad of NOT_A_WORD) {
    test(`a run start stating ${bad.label} as its framework is refused 400 stating nothing was started, and opens no run`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "framework-start-refused");
      const eventsBefore = await eventIds(handle, key);

      const res = await start(handle, key, { stack: "bun", framework: bad.value });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.runId).toBeUndefined();
      expect(String(res.body.error)).toContain("framework");
      expect(String(res.body.error)).toMatch(/\bnot started\b|\bnot stored\b|\bnothing (?:was )?(?:started|stored)\b/i);

      expect(await openRunIds(handle, key)).toEqual([]);
      expect(handle.store.listOpenRuns(key)).toEqual([]);
      expect(await eventIds(handle, key)).toEqual(eventsBefore);
    });
  }
});

describe("each ingest route takes an optional framework, a non-empty string", () => {
  for (const route of INGEST_ROUTES) {
    test(`a single-shot ingest on ${route} stating framework playwright stores it, and the event detail and the event brief answer it beside the stack`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "framework-ingest");

      const res = await ingest(handle, route, key, { stack: "bun", framework: "playwright" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const eventId = res.body.event as string;

      expect(storedEventFramework(handle, eventId)).toBe("playwright");
      const event = await eventDetail(handle, eventId);
      expect(event.framework).toBe("playwright");
      expect(event.stack).toBe("bun");
      const brief = await eventBrief(handle, key, eventId);
      expect(brief.framework).toBe("playwright");
      expect(brief.stack).toBe("bun");
    });

    test(`a single-shot ingest on ${route} stating no framework stores NULL, and neither the event detail nor the event brief carries a framework key`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "framework-ingest-none");

      const res = await ingest(handle, route, key, { stack: "bun" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const eventId = res.body.event as string;

      expect(storedEventFramework(handle, eventId)).toBeNull();
      expect(await eventDetail(handle, eventId)).not.toHaveProperty("framework");
      expect(await eventBrief(handle, key, eventId)).not.toHaveProperty("framework");
    });

    for (const bad of NOT_A_WORD) {
      test(`an ingest on ${route} stating ${bad.label} as its framework is refused 400 and stores no event`, async () => {
        const handle = boot();
        const key = await readyProject(handle, [AGENT], "framework-ingest-refused");
        const eventsBefore = await eventIds(handle, key);

        const res = await ingest(handle, route, key, { stack: "bun", framework: bad.value });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(res.body.event).toBeUndefined();
        expect(String(res.body.error)).toContain("framework");
        expect(String(res.body.error)).toMatch(/\bnot stored\b|\bnothing (?:was )?stored\b/i);

        expect(await eventIds(handle, key)).toEqual(eventsBefore);
      });
    }
  }
});

describe("an ingest that closes a run keeps the framework its start stated", () => {
  for (const route of INGEST_ROUTES) {
    test(`a run started with framework vitest, closed on ${route} by an ingest stating none, gets an event carrying vitest and its run is ended`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "framework-inherit");
      const runId = await openWith(handle, key, { stack: "bun", tier: "unit", framework: "vitest" });

      const res = await ingest(handle, route, key, { runId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const eventId = res.body.event as string;

      expect(storedEventFramework(handle, eventId)).toBe("vitest");
      const event = await eventDetail(handle, eventId);
      expect(event.framework).toBe("vitest");
      expect(event.stack).toBe("bun");
      expect((await eventBrief(handle, key, eventId)).framework).toBe("vitest");
      const run = handle.store.getRun(runId);
      expect(run?.state).toBe("ended");
      expect(run).toHaveProperty("framework", "vitest");
      expect(await openRunIds(handle, key)).not.toContain(runId);
    });

    test(`a closing ingest on ${route} stating the start's framework is accepted and its event carries it`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "framework-same");
      const runId = await openWith(handle, key, { stack: "bun", framework: "vitest" });

      const res = await ingest(handle, route, key, { runId, stack: "bun", framework: "vitest" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await eventDetail(handle, res.body.event)).framework).toBe("vitest");
      expect(await openRunIds(handle, key)).not.toContain(runId);
    });

    test(`a run started with no framework, closed on ${route} by an ingest stating bun-test, gets an event carrying bun-test`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "framework-late");
      const runId = await openWith(handle, key, { stack: "bun" });

      const res = await ingest(handle, route, key, { runId, framework: "bun-test" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await eventDetail(handle, res.body.event)).framework).toBe("bun-test");
      expect(await openRunIds(handle, key)).not.toContain(runId);
    });

    test(`a closing ingest on ${route} whose framework differs from its start's is refused 400 naming both, storing nothing and leaving the run open`, async () => {
      const handle = boot();
      const key = await readyProject(handle, [AGENT], "framework-change");
      const runId = await openWith(handle, key, { stack: "bun", tier: "unit", framework: "vitest" });
      const eventsBefore = await eventIds(handle, key);

      const res = await ingest(handle, route, key, { runId, stack: "bun", tier: "unit", framework: "bun-test" });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.event).toBeUndefined();
      const error = String(res.body.error);
      expect(error).toContain("framework");
      expect(error).toContain("vitest");
      expect(error).toContain("bun-test");

      expect(await eventIds(handle, key)).toEqual(eventsBefore);
      expect(handle.store.getRun(runId)?.state).toBe("open");
      expect(await openRunIds(handle, key)).toContain(runId);
      expect((await openRunBriefOf(handle, key, runId)).framework).toBe("vitest");
    });
  }

  test("a streamed run started with framework vitest and closed by its stream with no framework gets an event carrying vitest", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "framework-stream");
    const runId = await openWith(handle, key, { stack: "bun", tier: "unit", framework: "vitest" });
    const text =
      eventLine({ event: "run-start", total: 1 }) +
      eventLine({ event: "test-end", id: "f-1", name: "first", suite: "Frame", file: "src/frame.test.ts", status: "pass" }) +
      eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0 });
    const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    expect(batch.body.held).toBe(utf8(text));

    const closed = await closeStream(handle, key, AGENT, runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const event = await eventDetail(handle, closed.body.event);
    expect(event.framework).toBe("vitest");
    expect(event.stack).toBe("bun");
    expect(event.codec).toBe("crucible-events");
  });

  test("an aborted run's event keeps the framework its start stated", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "framework-abort");
    const runId = await openWith(handle, key, { stack: "bun", tier: "unit", framework: "vitest" });

    const res = await postJson(handle, `/api/v2/runs/${runId}/abort`, {
      projectKey: key,
      agentId: AGENT,
      reason: "the runner was interrupted",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("aborted");

    const aborted = (await eventsList(handle, key)).events.filter((e) => e.status === "aborted");
    expect(aborted.length).toBe(1);
    expect(aborted[0]?.framework).toBe("vitest");
    expect(aborted[0]?.stack).toBe("bun");
    expect((await eventDetail(handle, aborted[0]?.id)).framework).toBe("vitest");
  });
});

describe("a timeline read across a test run, a milestone and a gate still answers", () => {
  test("GET /api/v2/events answers the test run carrying its framework, and the milestone and the gate with no framework key; each detail reads", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "framework-timeline");
    const runId = await openWith(handle, key, { stack: "bun", tier: "unit", framework: "vitest" });
    const closed = await ingest(handle, "/api/v2/runs", key, { runId });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const testId = closed.body.event as string;
    const milestoneId = handle.store.recordMilestoneEvent(key, AGENT, "pre-merge-gate", { label: "pre-merge gate" }).event.id;
    const gateId = handle.store.recordGateEvent(key, AGENT, { outcome: "pass", steps: [] }).id;

    // The caller's registration is a lifecycle row on the same feed; the read
    // under test is the run and the two records.
    const { events } = await eventsList(handle, key);
    const filed = events.filter((e) => e.kind !== "lifecycle");
    const byId = new Map(filed.map((e) => [e.id, e]));
    expect(filed.map((e) => e.kind).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "gate",
      "milestone",
      "test",
    ]);
    expect(byId.get(testId)?.kind).toBe("test");
    expect(byId.get(testId)?.framework).toBe("vitest");
    expect(byId.get(milestoneId)?.kind).toBe("milestone");
    expect(byId.get(milestoneId)).not.toHaveProperty("framework");
    expect(byId.get(gateId)?.kind).toBe("gate");
    expect(byId.get(gateId)).not.toHaveProperty("framework");

    expect((await eventDetail(handle, testId)).framework).toBe("vitest");
    expect(await eventDetail(handle, milestoneId)).not.toHaveProperty("framework");
    expect(await eventDetail(handle, gateId)).not.toHaveProperty("framework");
  });
});

// ── Migration v23 ───────────────────────────────────────────────────────────

const PRE_FRAMEWORK_VERSION = 22;
const FRAMEWORK_VERSION = 23;

function scratchDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-run-framework-v23-"));
  scratchDirs.push(dir);
  return path.join(dir, "crucible.db");
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnsOf(db: Database, table: "events" | "runs"): ColumnInfo[] {
  const sql = table === "events" ? "PRAGMA table_info(events)" : "PRAGMA table_info(runs)";
  return db
    .query<ColumnInfo & { cid: number }, []>(sql)
    .all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));
}

/** The table's columns by name — the comparison a new and a migrated store must agree on. */
function columnsByName(db: Database, table: "events" | "runs"): ColumnInfo[] {
  return columnsOf(db, table).sort((a, b) => a.name.localeCompare(b.name));
}

function rawUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
}

interface V22Store {
  dbPath: string;
  key: string;
  runId: string;
  eventId: string;
}

/**
 * A store from this build walked back to v22, holding one run and the event
 * that ended it, both with stack `bun`: `framework` dropped from `events` and
 * `runs` where present, `user_version` stamped 22.
 */
function makeV22Store(): V22Store {
  const dbPath = scratchDbPath();
  const store = Store.open(dbPath);
  const key = crypto.randomUUID();
  store.addProject({ key, name: "pre-framework", type: "backend", sutRoot: "/tmp/pre-framework" });
  const runId = store.startRun(key, "pre-runner", { tier: "unit", stack: "bun" }).runId;
  const event = store.recordTestEvent(
    key,
    "pre-runner",
    {
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: [{ name: "Suite", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 1 }] }],
    },
    { tier: "unit", stack: "bun", codec: "junit" },
  );
  store.endRun(runId, event.id, Date.now());
  dbOf(store).close();

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    if (columnsOf(db, "events").some((c) => c.name === "framework")) {
      db.exec("ALTER TABLE events DROP COLUMN framework");
    }
    if (columnsOf(db, "runs").some((c) => c.name === "framework")) {
      db.exec("ALTER TABLE runs DROP COLUMN framework");
    }
    db.exec(`PRAGMA user_version = ${PRE_FRAMEWORK_VERSION}`);
  } finally {
    db.close();
  }
  return { dbPath, key, runId, eventId: event.id };
}

describe("migration v23 adds framework to events and runs", () => {
  test("the schema version this build declares reaches 23, the version that adds framework", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(FRAMEWORK_VERSION);
  });

  test("a v22 store is migrated from 22 to the build's schema version: events and runs each gain a nullable TEXT framework, and the store is stamped the build's version", () => {
    const v22 = makeV22Store();
    const before = new Database(v22.dbPath);
    try {
      expect(rawUserVersion(before)).toBe(PRE_FRAMEWORK_VERSION);
      expect(columnsOf(before, "events").map((c) => c.name)).not.toContain("framework");
      expect(columnsOf(before, "runs").map((c) => c.name)).not.toContain("framework");
    } finally {
      before.close();
    }

    const handle = boot(v22.dbPath);
    expect(handle.store.migration?.from).toBe(PRE_FRAMEWORK_VERSION);
    expect(handle.store.migration?.to).toBe(SCHEMA_VERSION);
    expect(handle.store.schemaVersion).toBe(SCHEMA_VERSION);
    const db = dbOf(handle.store);
    expect(rawUserVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of ["events", "runs"] as const) {
      expect(columnsOf(db, table).find((c) => c.name === "framework"), table).toEqual({
        name: "framework",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      });
    }
  });

  test("a brand-new store's events and runs columns equal a store migrated from v22, framework among them", () => {
    const fresh = Store.open(scratchDbPath());
    const freshDb = dbOf(fresh);
    const migrated = boot(makeV22Store().dbPath);
    const migratedDb = dbOf(migrated.store);
    try {
      for (const table of ["events", "runs"] as const) {
        expect(columnsByName(freshDb, table).map((c) => c.name), table).toContain("framework");
        expect(columnsByName(migratedDb, table), table).toEqual(columnsByName(freshDb, table));
      }
    } finally {
      freshDb.close();
    }
  });

  test("on the migrated store a run and its event stored before v23 read unchanged with no framework, and a new run stores one", async () => {
    const v22 = makeV22Store();
    const handle = boot(v22.dbPath);
    expect(handle.store.migration?.to).toBe(SCHEMA_VERSION);

    expect(storedRunFramework(handle, v22.runId)).toBeNull();
    expect(storedEventFramework(handle, v22.eventId)).toBeNull();
    const run = handle.store.getRun(v22.runId);
    expect(run?.state).toBe("ended");
    expect(run?.stack).toBe("bun");
    expect(run).not.toHaveProperty("framework");
    const event = await eventDetail(handle, v22.eventId);
    expect(event.stack).toBe("bun");
    expect(event).not.toHaveProperty("framework");

    const agent = "post-runner";
    const res = await postJson(handle, "/api/v2/agents/register", { projectKey: v22.key, agentId: agent, role: "ORCHESTRATOR" });
    expect(res.status).toBe(200);
    const opened = await postJson(handle, "/api/v2/runs/start", {
      projectKey: v22.key,
      agentId: agent,
      stack: "bun",
      framework: "vitest",
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(202);
    expect(storedRunFramework(handle, opened.body.runId as string)).toBe("vitest");
  });
});
