// CR-CRU-017 — Run lifecycle: start/end events + the Aborted state.
//
// RED suite for cycle C1 — the SCHEMA + SERVER half ONLY: §S0 (the migration
// chain step) and §S1 (run-start, optional runId on every ingest path,
// graceful degradation, 409 double-end, auto-abort). §S2 (the abort ROUTE and
// its rollup/streak/coverage exclusion), §S3 (UI) and §S4 (clients) belong to
// later cycles and are NOT tested here.
//
// ── What is missing today ──────────────────────────────────────────────────
//
// `events` carries 23 columns (id … role_inferred) — there is NO `started_at`,
// NO `runtime_ms` and NO `status` (src/store.ts:874-898). `MIGRATIONS` ends at
// the agents step, so `SCHEMA_VERSION = MIGRATIONS.length` is one short of the
// version this CR must write (src/store.ts:631-638). `handleV2` routes
// /api/v2/runs, /runs/parsed and /runs/compile (src/v2.ts:1908-1916) and
// nothing else under /runs — `POST /api/v2/runs/start` 404s, no ingest path
// reads a `runId`, and an open run cannot exist, let alone be auto-aborted.
//
// ── The seams GREEN must expose (this suite is written against them) ───────
//
//   // src/store.ts — §S0
//   MIGRATIONS gains a step whose `apply` ALTERs `events` with the three
//   lifecycle columns, in the SAME transaction that stamps `user_version`.
//   `SCHEMA_VERSION` stays `MIGRATIONS.length` — DERIVED, never hand-edited,
//   which is why no assertion below spells a version literal.
//
//   // src/v2.ts — §S1
//   POST /api/v2/runs/start {projectKey, agentId, tier?, stack?, context?}
//     -> 202 { runId: string, startedAt: number }   // an OPEN run, in SQLITE
//   POST /api/v2/runs | /runs/parsed | /runs/compile gain an OPTIONAL `runId`:
//     with it, the ONE stored event carries the run's `startedAt` and the
//     SERVER-computed `runtime_ms = endedAt - startedAt`, alongside the
//     tool-reported `summary.duration_ms`; re-ending a closed run -> 409.
//   An open run is auto-aborted — stored event `status:"aborted"` + `reason` —
//     when its agent tombstones (`agent died`) or when it outlives
//     `CRUCIBLE_RUN_ABANDON_MS` (`abandoned`).
//
// SPELLING: the DB columns are pinned exactly (`started_at`, `runtime_ms`,
// `status` — §S0 names them). The SERVED event key is accepted in either the
// house camelCase (`runtimeMs`) or the spec's `runtime_ms`, because the CR
// text uses one and the codebase style the other; absence is the failure, not
// the choice. The §S1-3 degradation guard is naming-AGNOSTIC and therefore
// stays strict: it rejects ANY key outside the pre-CR event universe.
//
// REAL TIMERS, DELIBERATELY: §S1's whole subject is WALL-CLOCK time —
// `runtime_ms = endedAt - startedAt` measured by the SERVER's own clock, and
// two staleness deadlines it also reads off that clock. Fake timers would
// advance this process's clock, not the assertions' subject, so the AC
// ("asserted against a fixture delay") cannot be expressed without a genuine
// delay. Sleeps are the smallest that clear the deadlines they test, and the
// auto-abort tests await a CONDITION (polling) rather than a guessed duration.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// Every store is an mkdtempSync scratch file, ":memory:", or a `sqlite3
// .backup` snapshot of the live store COPIED to tmp — `data/crucible.db` is
// never opened by a Store. Every server binds port 0; NEVER the dog-food 3849.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { Store, MIGRATIONS, SCHEMA_VERSION } from "../src/store.ts";
import type { MigrationStep } from "../src/store.ts";
import type { RunEvent } from "../src/types.ts";

// ── the §S0 contract, spelled once ─────────────────────────────────────────

/** §S0 — the three columns the new chain step must add to `events`. */
const LIFECYCLE_COLUMNS = ["started_at", "runtime_ms", "status"] as const;

/** The `events` columns as they stand BEFORE this CR (src/store.ts:874-898). */
const PRE_CR_EVENT_COLUMNS: Record<string, "text" | "int" | "pk" | "notnull-text" | "notnull-int"> = {
  id: "pk",
  project_key: "notnull-text",
  agent_id: "notnull-text",
  kind: "notnull-text",
  tier: "notnull-text",
  stack: "text",
  codec: "text",
  timestamp: "notnull-int",
  name: "text",
  total: "int",
  passed: "int",
  failed: "int",
  pending: "int",
  duration_ms: "int",
  tree: "text",
  coverage: "text",
  compile: "text",
  context: "text",
  action: "text",
  first_seen: "int",
  payload: "text",
  role: "text",
  role_inferred: "int",
};

/** Every key a served `RunEvent` may carry BEFORE this CR (src/types.ts:146-191). */
const PRE_CR_EVENT_KEYS: Record<string, true> = {
  id: true, projectKey: true, agentId: true, kind: true, tier: true, stack: true,
  codec: true, context: true, timestamp: true, action: true, firstSeen: true,
  name: true, summary: true, tree: true, coverage: true, raw: true, compile: true,
  gate: true, role: true, roleInferred: true, type: true, label: true, commit: true,
};

// ── scratch + handle bookkeeping ───────────────────────────────────────────

const scratchDirs: string[] = [];
const handles: ServerHandle[] = [];
const envBackup = new Map<string, string | undefined>();

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-cr017-"));
  scratchDirs.push(dir);
  return dir;
}

function setEnv(key: string, value: string): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.stop();
  }
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
});

// ── raw sqlite helpers (a second connection; never a Store) ────────────────

function columnsOf(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version ?? -1;
  } finally {
    db.close();
  }
}

function stampUserVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`PRAGMA user_version = ${version};`);
  } finally {
    db.close();
  }
}

function countRows(dbPath: string, table: string): number {
  const db = new Database(dbPath);
  try {
    const exists = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table);
    if ((exists?.n ?? 0) === 0) return -1;
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
  } finally {
    db.close();
  }
}

function eventRows(dbPath: string): Record<string, unknown>[] {
  const db = new Database(dbPath);
  try {
    return db.query<Record<string, unknown>, []>(`SELECT * FROM events ORDER BY rowid ASC`).all();
  } finally {
    db.close();
  }
}

/** Which of §S0's three columns `events` still lacks — [] once the step lands. */
function missingLifecycleColumns(dbPath: string): string[] {
  const present = new Set(columnsOf(dbPath, "events"));
  return LIFECYCLE_COLUMNS.filter((c) => !present.has(c));
}

/** The pre-CR `events` DDL column list, shared by the fixture and the by-effect probe. */
function preCrEventColumnDdl(): string {
  return Object.entries(PRE_CR_EVENT_COLUMNS)
    .map(([name, kind]) => {
      if (kind === "pk") return `${name} TEXT PRIMARY KEY`;
      if (kind === "notnull-text") return `${name} TEXT NOT NULL`;
      if (kind === "notnull-int") return `${name} INTEGER NOT NULL`;
      return `${name} ${kind === "int" ? "INTEGER" : "TEXT"}`;
    })
    .join(",\n        ");
}

/** Whether an in-memory probe's `events` table already carries all three lifecycle columns. */
function lifecycleColumnsPresent(db: Database): boolean {
  const cols = new Set<string>(
    db.query<{ name: string }, []>(`PRAGMA table_info(events)`).all().map((r) => r.name),
  );
  return LIFECYCLE_COLUMNS.every((c) => cols.has(c));
}

/**
 * §S0 — the migration step identified BY EFFECT, never by chain position: the
 * one step whose `apply`, run against an events table that still LACKS the
 * three lifecycle columns, makes all three exist. Each candidate is applied in
 * ISOLATION on a fresh pre-CR events table, so the identification cannot depend
 * on where the step sits in the chain (nor assume it is the last/terminal
 * step). Re-aims itself the day another CR appends more steps after it.
 */
function lifecycleStep(): MigrationStep {
  const columnDdl = preCrEventColumnDdl();
  for (const step of MIGRATIONS) {
    const probe = new Database(":memory:");
    try {
      probe.exec(`CREATE TABLE events (${columnDdl});`);
      if (lifecycleColumnsPresent(probe)) continue;
      try {
        step.apply(probe);
      } catch {
        continue;
      }
      if (lifecycleColumnsPresent(probe)) return step;
    } finally {
      probe.close();
    }
  }
  throw new Error("no MIGRATIONS step adds the lifecycle columns started_at/runtime_ms/status");
}

// ── §S0 fixture: a store at the version JUST BEFORE this CR's step ─────────

interface PreLifecycleStore {
  dbPath: string;
  counts: { projects: number; agents: number; events: number };
}

/**
 * A file-backed store whose `events` table has exactly the pre-CR columns and
 * whose `user_version` is the lifecycle step's `.from` — the version JUST
 * BEFORE the step that adds the lifecycle columns, identified BY EFFECT (not by
 * chain position). Derived, so it re-aims itself the day another CR appends
 * steps around it. Rows are pre-seeded so the upgrade has real data to lose.
 */
function makePreLifecycleStore(rows = 3): PreLifecycleStore {
  const dbPath = path.join(tmpDir(), "crucible.db");
  const columnDdl = preCrEventColumnDdl();
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`
      CREATE TABLE projects (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sut_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        liveness TEXT,
        retention INTEGER,
        archived_at INTEGER,
        allow_run_deletion INTEGER
      );
      CREATE TABLE agents (
        project_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        identity TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        role TEXT,
        bound_cycle_id INTEGER,
        PRIMARY KEY (project_key, agent_id)
      );
      CREATE TABLE events (
        ${columnDdl}
      );
    `);
    const now = Date.now();
    db.query(
      `INSERT INTO projects (key, name, type, sut_root, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("proj-legacy", "Legacy", "backend", "/tmp/legacy", now);
    db.query(
      `INSERT INTO agents (project_key, agent_id, status, message, identity, first_seen, last_seen, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("proj-legacy", "legacy-1", "online", "", "{}", now, now, "RED");
    const insert = db.query(
      `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp, total, passed,
         failed, pending, duration_ms, role, role_inferred)
       VALUES (?, ?, ?, 'test', 'unit', ?, 3, 3, 0, 0, 42, 'RED', 0)`,
    );
    for (let i = 0; i < rows; i++) {
      insert.run(`legacy-evt-${i}`, "proj-legacy", "legacy-1", now - i);
    }
  } finally {
    db.close();
  }
  // DERIVED, never a literal: the version JUST BEFORE the lifecycle step, found
  // by effect — so its events table provably still lacks all three columns.
  stampUserVersion(dbPath, lifecycleStep().from);
  return {
    dbPath,
    counts: {
      projects: countRows(dbPath, "projects"),
      agents: countRows(dbPath, "agents"),
      events: countRows(dbPath, "events"),
    },
  };
}

const LIVE_STORE = path.join(import.meta.dir, "..", "data", "crucible.db");

/** A WAL-safe `sqlite3 .backup` snapshot of the live store into tmp, or null. */
function snapshotLiveStore(): string | null {
  if (!fs.existsSync(LIVE_STORE)) return null;
  const dest = path.join(tmpDir(), "crucible.db");
  const done = Bun.spawnSync({ cmd: ["sqlite3", LIVE_STORE, `.backup '${dest}'`] });
  return done.exitCode === 0 ? dest : null;
}

// ── server harness ─────────────────────────────────────────────────────────

function boot(dbPath = ":memory:"): ServerHandle {
  // port 0 — an ephemeral port, NEVER the dog-food dashboard's 3849.
  const handle = startServer({ port: 0, dbPath });
  handles.push(handle);
  return handle;
}

function baseOf(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Response> {
  return fetch(`${baseOf(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface LivenessOverride {
  staleAfterMs: number;
  tombstoneAfterMs: number;
  pruneAfterMs: number;
}

function seedProject(handle: ServerHandle, liveness?: LivenessOverride): string {
  const key = crypto.randomUUID();
  handle.store.addProject({
    key,
    name: "P",
    type: "backend",
    sutRoot: "/tmp/p",
    ...(liveness !== undefined ? { liveness } : {}),
  });
  return key;
}

/**
 * ORCHESTRATOR, not RED: CR-CRU-056 §S2 refuses an unbound TDD role at the
 * route boundary (409), and a cycle binding is orthogonal to run lifecycle —
 * the exempt role keeps these fixtures about §S1 and nothing else.
 */
async function register(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
}

const PARSED_RUN = {
  summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 7 },
  tree: [
    { name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 7 }] },
  ],
};

const JUNIT_1CASE = [
  '<testsuite name="Suite1" tests="1">',
  '<testcase name="t1" time="0.005"/>',
  "</testsuite>",
].join("\n");

const RUSTC_ERRORS = ["error[E0308]: mismatched types", " --> src/lib.rs:1:1", ""].join("\n");

// ── §S1 seam accessors: each names the MISSING CONTRACT, not a TypeError ───

interface StartedRun {
  runId: string;
  startedAt: number;
}

async function startRun(
  handle: ServerHandle,
  key: string,
  agentId: string,
  extra: Record<string, unknown> = {},
): Promise<StartedRun> {
  const res = await postJson(handle, "/api/v2/runs/start", {
    projectKey: key,
    agentId,
    ...extra,
  });
  const text = await res.text();
  if (res.status !== 202) {
    throw new Error(
      "CR-CRU-017 §S1-1: POST /api/v2/runs/start must answer 202 {runId, startedAt} — got " +
        `${res.status} ${text}. The run-start route does not exist (src/v2.ts:1908-1916 routes ` +
        "/runs, /runs/parsed and /runs/compile and nothing else), so a run has no START and " +
        "wall-clock runtime can never be computed.",
    );
  }
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null || !("runId" in body) || !("startedAt" in body)) {
    throw new Error(`CR-CRU-017 §S1-1: /runs/start answered 202 without {runId, startedAt}: ${text}`);
  }
  const { runId, startedAt } = body;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error(`CR-CRU-017 §S1-1: /runs/start answered 202 without a string runId: ${text}`);
  }
  if (typeof startedAt !== "number") {
    throw new Error(
      `CR-CRU-017 §S1-1: /runs/start answered 202 without a numeric startedAt: ${text}`,
    );
  }
  return { runId, startedAt };
}

/** The server-computed wall-clock runtime on a served event — either spelling. */
function runtimeMsOf(event: RunEvent): number {
  const e: object = event;
  const value = "runtimeMs" in e ? e.runtimeMs : "runtime_ms" in e ? e.runtime_ms : undefined;
  if (typeof value !== "number") {
    throw new Error(
      "CR-CRU-017 §S1-2: the event closing a started run carries no server-computed runtime " +
        "(`runtimeMs` / `runtime_ms`) — Crucible still only knows the tool-reported " +
        `duration_ms, so queue + spawn + teardown time stays invisible. Event: ${JSON.stringify(event)}`,
    );
  }
  return value;
}

/** The run's start instant, carried onto the event that closed it. */
function startedAtOf(event: RunEvent): number {
  const e: object = event;
  const value = "startedAt" in e ? e.startedAt : "started_at" in e ? e.started_at : undefined;
  if (typeof value !== "number") {
    throw new Error(
      "CR-CRU-017 §S1-2: the event closing a started run carries no `startedAt` — the run's " +
        `start instant was not persisted onto the end event. Event: ${JSON.stringify(event)}`,
    );
  }
  return value;
}

function statusOf(event: RunEvent): string | undefined {
  const e: object = event;
  if (!("status" in e)) return undefined;
  return typeof e.status === "string" ? e.status : undefined;
}

function abortReasonOf(event: RunEvent): string {
  const e: object = event;
  const value = "reason" in e ? e.reason : "abortReason" in e ? e.abortReason : undefined;
  if (typeof value !== "string") {
    throw new Error(
      "CR-CRU-017 §S1-5: the auto-aborted run's event carries no `reason` — an abort with no " +
        `reason is indistinguishable from every other abort. Event: ${JSON.stringify(event)}`,
    );
  }
  return value;
}

function abortedEvents(handle: ServerHandle, key: string): RunEvent[] {
  return handle.store.listEvents(key, 200).filter((e) => statusOf(e) === "aborted");
}

/**
 * Let the server notice an open run has died, then return the aborted events.
 *
 * The CR does not pin HOW the sweep is driven (a Store method, a boot timer, a
 * read-path hook), so this accepts any of them: it calls a `sweepOpenRuns()`
 * seam when one exists, and otherwise polls the live read routes — which is
 * what a dashboard does. It awaits the CONDITION, not a guessed duration, and
 * pins the OUTCOME, not the mechanism.
 */
async function settleOpenRuns(
  handle: ServerHandle,
  key: string,
  budgetMs = 2_000,
): Promise<RunEvent[]> {
  const deadline = Date.now() + budgetMs;
  const store: object = handle.store;
  const sweep = "sweepOpenRuns" in store ? store.sweepOpenRuns : undefined;
  do {
    if (typeof sweep === "function") sweep.call(handle.store);
    await fetch(`${baseOf(handle)}/api/v2/agents?project=${key}`);
    await fetch(`${baseOf(handle)}/api/v2/events?project=${key}`);
    const aborted = abortedEvents(handle, key);
    if (aborted.length > 0) return aborted;
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  return abortedEvents(handle, key);
}

// ═══════════════════════════════════════════════════════════════════════════
// §S0 — the schema change goes through the migration chain
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-017 §S0-1 — the lifecycle columns arrive as a NUMBERED CHAIN STEP, and SCHEMA_VERSION derives itself", () => {
  test("the chain is contiguous, SCHEMA_VERSION is still MIGRATIONS.length (never a hand-edited literal), and the LIFECYCLE step — identified by effect, not by chain position — is the one that ALTERs `events` with started_at/runtime_ms/status", () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    MIGRATIONS.forEach((step, index) => {
      expect(step.from).toBe(index);
      expect(step.to).toBe(index + 1);
    });
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.to).toBe(SCHEMA_VERSION);

    // The lifecycle step, found BY EFFECT (never by index/'last'): a store
    // stamped at the version JUST BEFORE it still lacks all three columns, and
    // running the chain from there adds exactly them — provably that step's
    // work, never an inline ALTER in createTables nor the base CREATE TABLE.
    const step = lifecycleStep();
    const { dbPath } = makePreLifecycleStore();
    expect(userVersion(dbPath)).toBe(step.from);
    expect(missingLifecycleColumns(dbPath)).toEqual([...LIFECYCLE_COLUMNS]);

    expect(Store.open(dbPath).schemaVersion).toBe(SCHEMA_VERSION);

    expect(missingLifecycleColumns(dbPath)).toEqual([]);
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
  });

  test("a BRAND-NEW store is created at SCHEMA_VERSION already carrying the lifecycle columns — the base schema and the end of the chain agree", () => {
    const dbPath = path.join(tmpDir(), "fresh.db");

    expect(Store.open(dbPath).schemaVersion).toBe(SCHEMA_VERSION);

    expect(missingLifecycleColumns(dbPath)).toEqual([]);
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
  });
});

describe("CR-CRU-017 §S0-2 — the ALTERs and the user_version stamp are ONE transaction: a store can never report a version whose shape is not yet true", () => {
  test("no observable state has user_version === SCHEMA_VERSION while a lifecycle column is missing — proven on a store that already carries a STRAY `status` column (the half-applied case)", () => {
    const { dbPath } = makePreLifecycleStore();
    // A store that someone — or a crashed half-step — already gave ONE of the
    // three columns. Either the step copes and finishes, or it fails; what it
    // may NEVER do is leave a version that lies about the shape.
    const db = new Database(dbPath);
    db.exec(`ALTER TABLE events ADD COLUMN status TEXT`);
    db.close();

    let opened = true;
    try {
      Store.open(dbPath);
    } catch {
      opened = false;
    }

    const missing = missingLifecycleColumns(dbPath);
    const version = userVersion(dbPath);
    if (version === SCHEMA_VERSION) {
      expect({ opened, version, missing }).toEqual({
        opened: true,
        version: SCHEMA_VERSION,
        missing: [],
      });
    } else {
      // Refused / rolled back: it must not have kept any of the step's work.
      expect(version).toBeLessThan(SCHEMA_VERSION);
      expect(missing.length).toBeGreaterThan(0);
    }
  });
  test("when the lifecycle step THROWS, its ALTERs roll back WITH the stamp — the same fixture that gains all three columns on a clean run keeps none of them and stays at the old version", () => {
    const step = lifecycleStep();
    const stepIndex = MIGRATIONS.indexOf(step);

    // (a) clean run — the lifecycle step really is what adds the columns.
    const clean = makePreLifecycleStore();
    expect(Store.open(clean.dbPath).schemaVersion).toBe(SCHEMA_VERSION);
    expect(missingLifecycleColumns(clean.dbPath)).toEqual([]);
    expect(userVersion(clean.dbPath)).toBe(SCHEMA_VERSION);

    // (b) same fixture, same chain, the LIFECYCLE step (by effect, not by
    // position) wrapped to apply-then-throw (CR-CRU-071 AC7's injection seam is
    // the only way to fail a step without editing source).
    const poisoned = makePreLifecycleStore();
    const chain: MigrationStep[] = MIGRATIONS.map((s, i) =>
      i === stepIndex
        ? {
            from: step.from,
            to: step.to,
            description: `${step.description ?? ""} (CR-CRU-017 RED: apply-then-throw)`,
            apply(db) {
              step.apply(db);
              throw new Error("CR-CRU-017 RED: injected failure AFTER the step's writes");
            },
            ...(step.satisfiedBy !== undefined
              ? { satisfiedBy: (db: Database) => step.satisfiedBy!(db) }
              : {}),
          }
        : s,
    );

    expect(() => Store.open(poisoned.dbPath, { migrations: chain })).toThrow();

    expect(missingLifecycleColumns(poisoned.dbPath)).toEqual([...LIFECYCLE_COLUMNS]);
    expect(userVersion(poisoned.dbPath)).toBe(step.from);
  });
});

describe("CR-CRU-017 §S0-3 — the upgrade is LOSSLESS: every pre-existing row survives, and history is not retrofitted", () => {
  test("a populated pre-step store migrates with identical row counts, and every pre-existing event row reads NULL for all three lifecycle columns (the CR's 'no retrofitting lifecycle onto historical events' non-goal)", () => {
    const { dbPath, counts } = makePreLifecycleStore(5);
    const before = eventRows(dbPath).map((r) => r.id);

    expect(Store.open(dbPath).schemaVersion).toBe(SCHEMA_VERSION);

    expect(countRows(dbPath, "projects")).toBe(counts.projects);
    expect(countRows(dbPath, "agents")).toBe(counts.agents);
    expect(countRows(dbPath, "events")).toBe(counts.events);
    expect(eventRows(dbPath).map((r) => r.id)).toEqual(before);

    expect(missingLifecycleColumns(dbPath)).toEqual([]);
    for (const row of eventRows(dbPath)) {
      for (const col of LIFECYCLE_COLUMNS) {
        expect(row[col] ?? null).toBeNull();
      }
      // The pre-existing tool-reported duration is untouched by the upgrade.
      expect(row.duration_ms).toBe(42);
    }
  });

  test("the REAL dog-food store (read-only `.backup` snapshot, copied to tmp) migrates to SCHEMA_VERSION with identical counts and gains the lifecycle columns", () => {
    const snapshot = snapshotLiveStore();
    if (snapshot === null) {
      // No live store here (CI) — the synthetic fixture above already carries
      // the contract; inventing a stand-in and calling it "the real store"
      // would only weaken it.
      return;
    }
    const tables = ["projects", "agents", "events", "rollups", "plans", "plan_cycles"] as const;
    const before = tables.map((t) => [t, countRows(snapshot, t)] as const);

    expect(Store.open(snapshot).schemaVersion).toBe(SCHEMA_VERSION);

    expect(tables.map((t) => [t, countRows(snapshot, t)] as const)).toEqual(before);
    expect(missingLifecycleColumns(snapshot)).toEqual([]);
    expect(userVersion(snapshot)).toBe(SCHEMA_VERSION);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1 — run-start + run-end (server, additive)
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-017 §S1-1 — POST /api/v2/runs/start opens a run, and the open run lives in SQLITE, not memory", () => {
  test("{projectKey, agentId} -> 202 {runId, startedAt}, startedAt at the wall clock, and no run event yet", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "cr017-a");

    const before = Date.now();
    const started = await startRun(handle, key, "cr017-a", { tier: "unit", stack: "bun" });
    const after = Date.now();

    expect(started.startedAt).toBeGreaterThanOrEqual(before);
    expect(started.startedAt).toBeLessThanOrEqual(after);
    // A start is not an end: nothing lands on the timeline as a run yet.
    expect(handle.store.listEvents(key, 50).filter((e) => e.kind === "test")).toEqual([]);
  });

  test("the open run SURVIVES A SERVER RESTART — the same runId still closes a run after the handle is stopped and a NEW server opens the SAME store file (CR Risk: 'persist open runs in SQLite, not memory')", async () => {
    const dbPath = path.join(tmpDir(), "crucible.db");
    const first = boot(dbPath);
    const key = seedProject(first);
    await register(first, key, "cr017-restart");
    const started = await startRun(first, key, "cr017-restart");

    // On DISK before the server dies — an in-memory map would not be there.
    const persisted = [dbPath, `${dbPath}-wal`]
      .filter((p) => fs.existsSync(p))
      .some((p) => fs.readFileSync(p).includes(started.runId));
    expect(persisted).toBe(true);

    first.stop();
    handles.pop();

    const second = boot(dbPath);
    // Real delay: runtime_ms is measured off the server's clock, so the
    // restarted server must still see a run that started before it booted.
    await Bun.sleep(60);
    const res = await postJson(second, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cr017-restart",
      runId: started.runId,
      ...PARSED_RUN,
    });
    expect(res.status).toBe(200);

    const events = second.store.listEvents(key, 50).filter((e) => e.kind === "test");
    expect(events.length).toBe(1);
    expect(startedAtOf(events[0]!)).toBe(started.startedAt);
    expect(runtimeMsOf(events[0]!)).toBeGreaterThanOrEqual(60);
  });

  test("a runId the server never issued is REFUSED and nothing is stored — so 'the restart kept it' cannot be an accident of accepting any string", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "cr017-b");

    const res = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cr017-b",
      runId: "run-never-issued",
      ...PARSED_RUN,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(handle.store.listEvents(key, 50).filter((e) => e.kind === "test")).toEqual([]);
  });
});

describe("CR-CRU-017 §S1-2 — an ingest carrying runId stores ONE event with startedAt + SERVER-computed runtime_ms alongside the tool-reported duration_ms", () => {
  test("/runs/parsed: runtime_ms tracks a REAL fixture delay, equals at most endedAt - startedAt, and is distinct from summary.duration_ms", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "cr017-parsed");
    const started = await startRun(handle, key, "cr017-parsed");

    // The AC's "fixture delay": the wall-clock gap runtime_ms must capture and
    // duration_ms (7ms, tool-reported) cannot.
    const delayMs = 150;
    await Bun.sleep(delayMs);
    const res = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cr017-parsed",
      runId: started.runId,
      ...PARSED_RUN,
    });
    const endedAt = Date.now();
    expect(res.status).toBe(200);

    const events = handle.store.listEvents(key, 50).filter((e) => e.kind === "test");
    expect(events.length).toBe(1);
    const event = events[0]!;

    expect(startedAtOf(event)).toBe(started.startedAt);
    const runtime = runtimeMsOf(event);
    expect(runtime).toBeGreaterThanOrEqual(delayMs);
    expect(runtime).toBeLessThanOrEqual(endedAt - started.startedAt);
    // The tool-reported duration survives untouched, and is NOT the runtime.
    expect(event.summary?.duration_ms).toBe(PARSED_RUN.summary.duration_ms);
    expect(runtime).not.toBe(PARSED_RUN.summary.duration_ms);
  });

  test("/runs (junit codec) accepts the optional runId on the same terms", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "cr017-junit");
    const started = await startRun(handle, key, "cr017-junit");

    await Bun.sleep(120);
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: "cr017-junit",
      codec: "junit",
      data: JUNIT_1CASE,
      runId: started.runId,
    });
    expect(res.status).toBe(200);

    const events = handle.store.listEvents(key, 50).filter((e) => e.kind === "test");
    expect(events.length).toBe(1);
    expect(startedAtOf(events[0]!)).toBe(started.startedAt);
    expect(runtimeMsOf(events[0]!)).toBeGreaterThanOrEqual(120);
    expect(runtimeMsOf(events[0]!)).not.toBe(events[0]!.summary?.duration_ms);
  });

  test("/runs/compile accepts the optional runId on the same terms", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "cr017-compile");
    const started = await startRun(handle, key, "cr017-compile");

    await Bun.sleep(120);
    const res = await postJson(handle, "/api/v2/runs/compile", {
      projectKey: key,
      agentId: "cr017-compile",
      errors: RUSTC_ERRORS,
      format: "rustc",
      runId: started.runId,
    });
    expect(res.status).toBe(200);

    const events = handle.store.listEvents(key, 50).filter((e) => e.kind === "compile");
    expect(events.length).toBe(1);
    expect(startedAtOf(events[0]!)).toBe(started.startedAt);
    expect(runtimeMsOf(events[0]!)).toBeGreaterThanOrEqual(120);
  });
});

describe("CR-CRU-017 §S1-3 — GRACEFUL DEGRADATION: a single-shot ingest with NO runId is byte-identical to today", () => {
  test("REGRESSION GUARD (green before AND after): no-runId ingests on all three routes store events whose served keys are all pre-CR keys, and whose new DB columns are ALL NULL", async () => {
    const dbPath = path.join(tmpDir(), "crucible.db");
    const handle = boot(dbPath);
    const key = seedProject(handle);
    await register(handle, key, "cr017-plain");

    const singleShots: [string, Record<string, unknown>][] = [
      ["/api/v2/runs/parsed", { ...PARSED_RUN }],
      ["/api/v2/runs", { codec: "junit", data: JUNIT_1CASE }],
      ["/api/v2/runs/compile", { errors: RUSTC_ERRORS, format: "rustc" }],
    ];
    for (const [route, body] of singleShots) {
      const res = await postJson(handle, route, {
        projectKey: key,
        agentId: "cr017-plain",
        ...body,
      });
      expect(res.status).toBe(200);
    }

    const events = handle.store.listEvents(key, 50).filter((e) => e.kind !== "lifecycle");
    expect(events.length).toBe(3);
    for (const event of events) {
      // Naming-AGNOSTIC and therefore strict: any key this CR adds is caught,
      // whatever it ends up being called.
      expect(Object.keys(event).filter((k) => PRE_CR_EVENT_KEYS[k] !== true)).toEqual([]);
      expect(statusOf(event)).toBeUndefined();
    }

    // And on disk: every column outside the pre-CR set is NULL on these rows.
    for (const row of eventRows(dbPath)) {
      for (const [col, value] of Object.entries(row)) {
        if (PRE_CR_EVENT_COLUMNS[col] === undefined) {
          expect({ col, value: value ?? null }).toEqual({ col, value: null });
        }
      }
    }
  });

  test("DISCRIMINATOR: in ONE project the runId ingest carries lifecycle fields while the no-runId ingest carries none — degradation is a real branch, not the absence of the feature", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "cr017-mixed");

    const plain = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cr017-mixed",
      name: "plain",
      ...PARSED_RUN,
    });
    expect(plain.status).toBe(200);

    const started = await startRun(handle, key, "cr017-mixed");
    await Bun.sleep(80);
    const wrapped = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cr017-mixed",
      name: "wrapped",
      runId: started.runId,
      ...PARSED_RUN,
    });
    expect(wrapped.status).toBe(200);

    const byName = new Map(
      handle.store
        .listEvents(key, 50)
        .filter((e) => e.kind === "test")
        .map((e) => [e.name, e]),
    );
    const plainEvent = byName.get("plain")!;
    const wrappedEvent = byName.get("wrapped")!;

    expect(Object.keys(plainEvent).filter((k) => PRE_CR_EVENT_KEYS[k] !== true)).toEqual([]);
    expect(startedAtOf(wrappedEvent)).toBe(started.startedAt);
    expect(runtimeMsOf(wrappedEvent)).toBeGreaterThanOrEqual(80);
  });
});

describe("CR-CRU-017 §S1-4 — double-end is a 409: a closed run cannot be closed twice (CR Risk: end/end and end-after-abort races)", () => {
  test("ending the SAME runId twice -> first 200, second 409 with ok:false, and only ONE event exists", async () => {
    const handle = boot();
    const key = seedProject(handle);
    await register(handle, key, "cr017-race");
    const started = await startRun(handle, key, "cr017-race");

    const first = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cr017-race",
      runId: started.runId,
      ...PARSED_RUN,
    });
    expect(first.status).toBe(200);

    const second = await postJson(handle, "/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "cr017-race",
      runId: started.runId,
      ...PARSED_RUN,
    });
    expect(second.status).toBe(409);
    const body: unknown = await second.json();
    expect(typeof body === "object" && body !== null && "ok" in body ? body.ok : undefined).toBe(
      false,
    );

    expect(handle.store.listEvents(key, 50).filter((e) => e.kind === "test").length).toBe(1);
  });
});

describe("CR-CRU-017 §S1-5 — an open run with neither end nor abort is AUTO-ABORTED, with the reason naming which trigger fired", () => {
  test("its agent TOMBSTONES -> the run is aborted with reason exactly `agent died`", async () => {
    // Staleness is ruled out, so the reason can only be the tombstone.
    setEnv("CRUCIBLE_RUN_ABANDON_MS", "3600000");
    const handle = boot();
    const key = seedProject(handle, {
      staleAfterMs: 10,
      tombstoneAfterMs: 40,
      pruneAfterMs: 3_600_000,
    });
    await register(handle, key, "cr017-dead");
    await startRun(handle, key, "cr017-dead");

    // Real delay: CR-011 liveness is computed against the wall clock.
    await Bun.sleep(120);
    const aborted = await settleOpenRuns(handle, key);

    expect(aborted.length).toBe(1);
    expect(statusOf(aborted[0]!)).toBe("aborted");
    expect(abortReasonOf(aborted[0]!)).toBe("agent died");
    expect(aborted[0]!.agentId).toBe("cr017-dead");
  });

  test("it outlives CRUCIBLE_RUN_ABANDON_MS -> the run is aborted with reason exactly `abandoned`", async () => {
    // Tombstoning is ruled out, so the reason can only be the staleness timeout.
    setEnv("CRUCIBLE_RUN_ABANDON_MS", "60");
    const handle = boot();
    const key = seedProject(handle, {
      staleAfterMs: 3_600_000,
      tombstoneAfterMs: 3_600_000,
      pruneAfterMs: 7_200_000,
    });
    await register(handle, key, "cr017-lost");
    await startRun(handle, key, "cr017-lost");

    // Real delay: the abandonment deadline is wall-clock, read by the server.
    await Bun.sleep(200);
    const aborted = await settleOpenRuns(handle, key);

    expect(aborted.length).toBe(1);
    expect(statusOf(aborted[0]!)).toBe("aborted");
    expect(abortReasonOf(aborted[0]!)).toBe("abandoned");
    expect(aborted[0]!.agentId).toBe("cr017-lost");
  });
});
