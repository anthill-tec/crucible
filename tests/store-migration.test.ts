// CR-CRU-071 — in-place upgrade: versioned, backed-up, refusable DB migration.
//
// RED suite for cycle C1 (AC1-AC7). AC8 (upgrade gate) and AC9 (daemon restart)
// belong to cycle C2 and are NOT tested here.
//
// ── What is broken today ───────────────────────────────────────────────────
//
// `PRAGMA user_version` is 0 on EVERY store ever written, including the 9.2 MB
// live dog-food db. `Store.open` (src/store.ts:326) probes the file with
// `PRAGMA schema_version` for corruption and then calls `createTables()`, which
// retrofits schema by probing `PRAGMA table_info` and firing ~19 ad-hoc,
// un-transacted `ALTER TABLE`s (src/store.ts:438-574) plus an in-pass data
// backfill (`backfillInferredEventRoles`, src/store.ts:488/599). Nothing stamps
// a version, nothing copies the file first, and an OLDER binary opening a NEWER
// store passes every "does this column exist" probe and writes to a schema it
// does not understand.
//
// ── The seams GREEN must expose (this suite is written against them) ───────
//
//   // src/store.ts
//   export const SCHEMA_VERSION: number;          // the version THIS code writes
//
//   export interface MigrationStep {
//     readonly from: number;                      // version this step upgrades FROM
//     readonly to: number;                        // ... and TO (to === from + 1)
//     readonly description?: string;
//     apply(db: Database): void;                  // runs inside ONE transaction
//   }
//   export const MIGRATIONS: readonly MigrationStep[];   // ordered chain
//
//   export interface StoreMigration {             // what a boot actually did
//     from: number;
//     to: number;
//     backupPath: string | null;                  // null for :memory: / no-op
//   }
//
//   class Store {
//     readonly schemaVersion: number;             // === PRAGMA user_version after open
//     readonly migration: StoreMigration | null;  // null when nothing migrated
//     static open(path: string, opts?: { migrations?: readonly MigrationStep[] }): Store;
//   }
//
// 🚨 AC7 INJECTION SEAM (stated explicitly so GREEN honours it):
//    `Store.open(path, { migrations })` — the OPTIONAL second argument replaces
//    the default `MIGRATIONS` chain for that open. That is the ONLY way this
//    suite can make a step throw without a source edit. It must default to the
//    module's `MIGRATIONS` when omitted, and every other code path (server boot
//    included) must keep calling the one-argument form.
//
//   // src/server.ts — AC6, additive to CR-CRU-068's `store { path, rule }`
//   store: { path, rule, schemaVersion: number,
//            migration: null | { from: number; to: number; backupPath: string | null } }
//   on BOTH GET /api/health and GET /api/v2/health (the shared healthPayload()
//   closure, src/server.ts:226, so the two routes cannot drift). Startup
//   disclosure is asserted from the RETURNED handle (`handle.store`), never by
//   capturing console — same discipline as tests/store-disclosure.test.ts.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// Every store here is an mkdtempSync scratch file, a COPY of the committed
// fixture, or ":memory:". The live `data/crucible.db` is NEVER opened — the
// AC2 snapshots the live store at RUN TIME (never a committed fixture) via `sqlite3 .backup`
// snapshot of it, and is itself copied to a tmp path before any Store touches
// it. Every server binds port 0 (ephemeral) — NEVER the dog-food :3849.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import type { ServerHandle } from "../src/server.ts";
import * as serverModule from "../src/server.ts";

// ── the seam types this suite is written against ───────────────────────────

interface MigrationStep {
  readonly from: number;
  readonly to: number;
  readonly description?: string;
  apply(db: Database): void;
}

interface StoreMigration {
  from: number;
  to: number;
  backupPath: string | null;
}

/**
 * AC2's "prove it against the REAL dog-food store" fixture.
 *
 * DERIVED AT RUN TIME from `data/crucible.db`, never committed. Two reasons a
 * checked-in snapshot was rejected:
 *
 *   1. it is 8.8 MB against a 7.1 MB repo — more than doubling git history,
 *      permanently, for a file regenerable in one command;
 *   2. a live store GROWS. Literal expected counts drift within HOURS (this
 *      suite's first draft pinned `agents: 1`; by the time it ran, the live
 *      store said 2), so a pinned snapshot stops being "the real store" and
 *      starts being a stale copy that quietly weakens the AC.
 *
 * So the counts are measured FROM THE COPY, and the assertion is
 * before-vs-after EQUALITY — which is what AC2 actually demands ("no data
 * movement"), and is immune to the store growing. Absolute values would only
 * re-assert what sqlite already guarantees.
 *
 * When there is no live store (CI), the AC2 test SKIPS with a reason rather
 * than inventing a synthetic stand-in and calling it the real thing.
 */
const LIVE_STORE = path.join(import.meta.dir, "..", "data", "crucible.db");

const COUNTED_TABLES = ["projects", "plans", "plan_cycles", "events", "rollups",
                        "agents"] as const;

/** A WAL-safe snapshot of the live store into `dest`, or null when absent. */
function snapshotLiveStore(dest: string): string | null {
  if (!fs.existsSync(LIVE_STORE)) {
    return null;
  }
  // `.backup` (not copyFileSync): the live store is WAL-mode and may have a
  // hot -wal; a file copy can land torn or stale.
  const done = Bun.spawnSync({
    cmd: ["sqlite3", LIVE_STORE, `.backup '${dest}'`],
  });
  if (done.exitCode !== 0) {
    return null;
  }
  return dest;
}

const scratchDirs: string[] = [];
const handles: ServerHandle[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-cr071-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.stop();
  }
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

// ── seam accessors: every one fails with the MISSING CONTRACT, not a TypeError ─

function schemaVersion(): number {
  const mod: object = storeModule;
  if (!("SCHEMA_VERSION" in mod) || typeof mod.SCHEMA_VERSION !== "number") {
    throw new Error(
      "CR-CRU-071 AC1: src/store.ts exports no numeric `SCHEMA_VERSION` — the code has no " +
        "notion of which schema it writes, so no store can be stamped with or checked against one.",
    );
  }
  return mod.SCHEMA_VERSION;
}

function migrationChain(): readonly MigrationStep[] {
  const mod: object = storeModule;
  if (!("MIGRATIONS" in mod) || !Array.isArray(mod.MIGRATIONS)) {
    throw new Error(
      "CR-CRU-071 AC3: src/store.ts exports no ordered `MIGRATIONS` chain — the retrofits are " +
        "still ~19 un-numbered, un-transacted ALTERs inside createTables().",
    );
  }
  // Unchecked by necessity: this suite exists to pin that shape.
  return mod.MIGRATIONS as readonly MigrationStep[];
}

/** `Store.open(path, { migrations })` — the AC7 injection seam (absent until GREEN). */
function openWith(dbPath: string, migrations: readonly MigrationStep[]): Store {
  const open = Store.open as unknown as (
    p: string,
    opts?: { migrations?: readonly MigrationStep[] },
  ) => Store;
  return open(dbPath, { migrations });
}

/** AC6 — the version the opened store believes it is at. Absent until GREEN. */
function schemaVersionOf(store: Store): number {
  const s: object = store;
  if (!("schemaVersion" in s) || typeof s.schemaVersion !== "number") {
    throw new Error(
      "CR-CRU-071 AC6: the opened Store exposes no numeric `schemaVersion` — a boot cannot " +
        "disclose the store's schema version because it never learned one.",
    );
  }
  return s.schemaVersion;
}

/** AC6 — what this boot migrated (null when nothing did). Absent until GREEN. */
function migrationOf(store: Store): StoreMigration | null {
  const s: object = store;
  if (!("migration" in s)) {
    throw new Error(
      "CR-CRU-071 AC6: the opened Store exposes no `migration` report — a boot that rewrote " +
        "the store's schema says nothing about from-version, to-version or the backup it wrote.",
    );
  }
  return asMigration(s.migration);
}

function asMigration(value: unknown): StoreMigration | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "object" ||
    !("from" in value) ||
    !("to" in value) ||
    !("backupPath" in value)
  ) {
    throw new Error(
      `CR-CRU-071 AC6: migration report is not { from, to, backupPath }: ${JSON.stringify(value)}`,
    );
  }
  const { from, to, backupPath } = value;
  if (typeof from !== "number" || typeof to !== "number") {
    throw new Error(
      `CR-CRU-071 AC6: migration from/to must be numbers: ${JSON.stringify(value)}`,
    );
  }
  if (backupPath !== null && typeof backupPath !== "string") {
    throw new Error(
      `CR-CRU-071 AC4: migration backupPath must be a string or null: ${JSON.stringify(value)}`,
    );
  }
  return { from, to, backupPath };
}

// ── raw-sqlite helpers (never a Store — these must not migrate anything) ───

function userVersion(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    return row?.user_version ?? -1;
  } finally {
    db.close();
  }
}

function stampUserVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    // DELETE journal mode so the stamp leaves no -wal/-shm siblings behind and
    // the AC5 "directory listing unchanged" assertion measures only the server.
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`PRAGMA user_version = ${version};`);
  } finally {
    db.close();
  }
}

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

function rowCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath);
  try {
    const counts: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      counts[table] =
        db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
    }
    return counts;
  } finally {
    db.close();
  }
}

function eventRoleCount(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return (
      db
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events WHERE role IS NOT NULL`)
        .get()?.n ?? -1
    );
  } finally {
    db.close();
  }
}

/** Sorted `sqlite_master` DDL — an exact structural fingerprint. */
function schemaFingerprint(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ sql: string | null }, []>(
        `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`,
      )
      .all()
      .map((r) => r.sql)
      .join("\n");
  } finally {
    db.close();
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function siblings(dir: string, pattern: RegExp): string[] {
  return fs.readdirSync(dir).filter((f) => pattern.test(f));
}

const PRE_UPGRADE_RE = /\.pre-upgrade-\d+$/;
const CORRUPT_RE = /\.corrupt-\d+$/;

// ── fixtures ───────────────────────────────────────────────────────────────

/**
 * A tmp snapshot of the live dog-food store, or null when there is none.
 * The live file is never opened by a Store — only read by `sqlite3 .backup`.
 */
/** Put a snapshot back into the pre-CR-071 condition: unstamped. */
function resetUserVersion(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA user_version = 0");
  } finally {
    db.close();
  }
}

function copyOfRealStore(): string | null {
  return snapshotLiveStore(path.join(tmpDir(), "crucible.db"));
}

/**
 * A store shaped exactly like a PRE-CR-CRU-059 db: `events` carries the
 * declared classification under the OLD column names `phase`/`phase_inferred`,
 * WITH VALUES IN THEM. Migrating this store is the load-bearing ordering case —
 * `RENAME COLUMN phase TO role` must run BEFORE the additive `ADD COLUMN role`,
 * or a fresh empty column shadows the values and CR-CRU-057's backfill then
 * re-derives them from the agent-id suffix (visibly wrong: `role_inferred = 1`).
 */
function makePreRenameStore(dir: string, extraSql = ""): string {
  const dbPath = path.join(dir, "crucible.db");
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tier TEXT NOT NULL,
        stack TEXT,
        codec TEXT,
        timestamp INTEGER NOT NULL,
        name TEXT,
        total INTEGER,
        passed INTEGER,
        failed INTEGER,
        pending INTEGER,
        duration_ms INTEGER,
        tree TEXT,
        coverage TEXT,
        compile TEXT,
        context TEXT,
        action TEXT,
        first_seen INTEGER,
        payload TEXT,
        phase TEXT,
        phase_inferred INTEGER
      );
    `);
    // A DECLARED row whose agent id suffix says something DIFFERENT from its
    // declared value: if the rename is skipped and the backfill fills a fresh
    // empty column, this reads back as RED/inferred instead of GREEN/declared.
    db.query(
      `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp, phase, phase_inferred)
       VALUES ('e-declared', 'p1', 'worker-RED', 'test', 'unit', 1000, 'GREEN', 0)`,
    ).run();
    // A pre-057 row the in-pass backfill is supposed to classify as FIX/inferred.
    db.query(
      `INSERT INTO events (id, project_key, agent_id, kind, tier, timestamp, phase, phase_inferred)
       VALUES ('e-null', 'p1', 'helper-FIX', 'test', 'unit', 2000, NULL, NULL)`,
    ).run();
    if (extraSql !== "") db.exec(extraSql);
  } finally {
    db.close();
  }
  return dbPath;
}

interface EventRoleRow {
  role: string | null;
  role_inferred: number | null;
}

function eventRole(dbPath: string, id: string): EventRoleRow {
  const db = new Database(dbPath);
  try {
    const row = db
      .query<EventRoleRow, [string]>(`SELECT role, role_inferred FROM events WHERE id = ?`)
      .get(id);
    if (row === null) throw new Error(`CR-CRU-071 AC3: event ${id} vanished from the store`);
    return row;
  } finally {
    db.close();
  }
}

/**
 * Returns the thrown error, or `undefined` when `fn` returned normally — a
 * plain `expect(...).toThrow()` cannot also assert on what the call left on
 * disk, and AC5/AC7 are as much about the untouched file as about the throw.
 */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function health(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${handle.server.port}${route}`, {
    headers: { accept: "application/json" },
  });
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (body === null || typeof body !== "object") {
    throw new Error(`CR-CRU-071: GET ${route} did not return a JSON object`);
  }
  return { ...body };
}

/** AC6 — the store block health must report, now carrying the schema version. */
function storeBlockOf(body: Record<string, unknown>, route: string): Record<string, unknown> {
  const block = body.store;
  if (block === null || block === undefined || typeof block !== "object") {
    throw new Error(`CR-CRU-071 AC6: GET ${route} reports no \`store\` block at all`);
  }
  return { ...block };
}

function healthSchemaVersion(body: Record<string, unknown>, route: string): number {
  const block = storeBlockOf(body, route);
  const version = block.schemaVersion;
  if (typeof version !== "number") {
    throw new Error(
      `CR-CRU-071 AC6: GET ${route} reports store ${JSON.stringify(block)} with no numeric ` +
        "`schemaVersion` — the store's schema version is invisible without shell forensics.",
    );
  }
  return version;
}

function healthMigration(body: Record<string, unknown>, route: string): StoreMigration | null {
  const block = storeBlockOf(body, route);
  if (!("migration" in block)) {
    throw new Error(
      `CR-CRU-071 AC6: GET ${route} reports store ${JSON.stringify(block)} with no \`migration\` ` +
        "key — a boot that migrated the store cannot say so.",
    );
  }
  return asMigration(block.migration);
}

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-071 AC1 — the store carries a schema version", () => {
  test("AC1 — a freshly opened store is stamped with SCHEMA_VERSION and structurally matches it", () => {
    const dbPath = path.join(tmpDir(), "crucible.db");

    const store = Store.open(dbPath);

    const expected = schemaVersion();
    expect(expected).toBeGreaterThan(0);
    expect(userVersion(dbPath)).toBe(expected);
    expect(schemaVersionOf(store)).toBe(expected);

    // "never left at a version it does not structurally match": every column
    // the current retrofits guarantee must be present at that version.
    expect(columnsOf(dbPath, "events")).toEqual(
      expect.arrayContaining(["action", "first_seen", "payload", "role", "role_inferred"]),
    );
    expect(columnsOf(dbPath, "plan_cycles")).toEqual(
      expect.arrayContaining(["activated_at", "done_at", "active_ms_accumulated", "seq"]),
    );
    expect(columnsOf(dbPath, "plans")).toEqual(expect.arrayContaining(["title", "orchestrator"]));
    expect(columnsOf(dbPath, "projects")).toEqual(
      expect.arrayContaining(["archived_at", "allow_run_deletion"]),
    );
    expect(columnsOf(dbPath, "agents")).toEqual(
      expect.arrayContaining(["role", "bound_cycle_id"]),
    );
    // ... and no legacy name may survive at the current version.
    expect(columnsOf(dbPath, "events")).not.toContain("phase");
    expect(columnsOf(dbPath, "agents")).not.toContain("phase");

    // A brand-new store had nothing to migrate, so it wrote no recovery point.
    expect(migrationOf(store)).toBeNull();
    expect(siblings(path.dirname(dbPath), PRE_UPGRADE_RE)).toEqual([]);
  });

  test("AC1 — the version and the structure it names advance together, never separately", () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);

    expect(userVersion(dbPath)).toBe(0);
    expect(columnsOf(dbPath, "events")).toContain("phase");

    Store.open(dbPath);

    // The stamp is written in the SAME transaction as the migration: either the
    // renamed columns are there AND the version says so, or neither is true.
    expect(userVersion(dbPath)).toBe(schemaVersion());
    expect(columnsOf(dbPath, "events")).toContain("role");
    expect(columnsOf(dbPath, "events")).not.toContain("phase");
  });
});

describe("CR-CRU-071 AC2 — existing stores are baselined without loss", () => {
  test("AC2 — a copy of the REAL dog-food store is stamped from 0 with identical row counts", () => {
    const dbPath = copyOfRealStore();
    if (dbPath === null) {
      // No live store here (CI). SKIPPED rather than substituting a synthetic
      // db and calling it "the real dog-food store" — AC2's whole point is
      // that the proof runs against the highest-value database in the project
      // (CR-CRU-043), not against something shaped like it.
      console.log("[cr071] AC2 skipped: no data/crucible.db to snapshot");
      return;
    }

    // Counts are MEASURED from the copy, never pinned as literals: the live
    // store grows, and the assertion AC2 actually demands is before-vs-after
    // EQUALITY ("no data movement"), which absolute numbers would not add to.
    // The live store is STAMPED once this CR has shipped and actually run
    // against it, so asserting it arrives unstamped would make this test
    // self-invalidating — it would pass only until the feature worked. (It
    // did: the dog-food store went to v5 the day CR-071 merged.) The AC is
    // "an UNSTAMPED store is baselined losslessly", so the copy is put back
    // into that condition explicitly. Legitimate because this is a throwaway
    // snapshot, never the live file.
    resetUserVersion(dbPath);

    const before = rowCounts(dbPath);
    const rolesBefore = eventRoleCount(dbPath);
    expect(userVersion(dbPath)).toBe(0);
    // Guard against a vacuous pass on an empty db: the real store has rows.
    expect(before.events).toBeGreaterThan(0);
    expect(before.plans).toBeGreaterThan(0);

    const store = Store.open(dbPath);

    // No data movement.
    expect(rowCounts(dbPath)).toEqual(before);
    // No retrofit re-ran destructively: CR-CRU-057's backfilled roles survive.
    expect(eventRoleCount(dbPath)).toBe(rolesBefore);
    // ... and the store now knows what shape it is.
    expect(userVersion(dbPath)).toBe(schemaVersion());
    expect(schemaVersionOf(store)).toBe(schemaVersion());
  });
});

describe("CR-CRU-071 AC3 — migrations are an ordered, idempotent chain", () => {
  test("AC3 — MIGRATIONS is a contiguous ordered chain ending at SCHEMA_VERSION", () => {
    const chain = migrationChain();
    expect(chain.length).toBeGreaterThan(0);

    for (const step of chain) {
      expect(typeof step.from).toBe("number");
      expect(typeof step.to).toBe("number");
      expect(step.to).toBe(step.from + 1);
      expect(typeof step.apply).toBe("function");
    }
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.from).toBe(chain[i - 1]!.to);
    }
    expect(chain[chain.length - 1]!.to).toBe(schemaVersion());
  });

  test("AC3 — rename-before-add: pre-059 phase VALUES survive as role, they are not re-derived", () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);

    Store.open(dbPath);

    // The declared value moved across with the column. If a step ever runs
    // `ADD COLUMN role` before `RENAME COLUMN phase TO role`, this row reads
    // back as { role: "RED", role_inferred: 1 } — the agent-id suffix guess —
    // which is exactly the orphaning CR-CRU-059 §S0 forbids.
    expect(eventRole(dbPath, "e-declared")).toEqual({ role: "GREEN", role_inferred: 0 });
    // The in-pass backfill belongs to the SAME version as the ALTER, so a store
    // reporting that version already has the classified data.
    expect(eventRole(dbPath, "e-null")).toEqual({ role: "FIX", role_inferred: 1 });
    expect(columnsOf(dbPath, "events")).not.toContain("phase_inferred");
    expect(userVersion(dbPath)).toBe(schemaVersion());
  });

  test("AC3 — re-opening a migrated store converges: no further migration, no new backup", () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);

    Store.open(dbPath);
    const version = userVersion(dbPath);
    const fingerprint = schemaFingerprint(dbPath);
    const roles = eventRole(dbPath, "e-declared");
    const backupsAfterFirst = siblings(dir, PRE_UPGRADE_RE).length;
    expect(backupsAfterFirst).toBe(1);

    const second = Store.open(dbPath);

    expect(userVersion(dbPath)).toBe(version);
    expect(schemaFingerprint(dbPath)).toBe(fingerprint);
    expect(eventRole(dbPath, "e-declared")).toEqual(roles);
    expect(migrationOf(second)).toBeNull();
    // An already-current store performs no migrating write, so it needs no
    // recovery point — otherwise every boot litters a 9 MB sibling.
    expect(siblings(dir, PRE_UPGRADE_RE).length).toBe(backupsAfterFirst);
  });
});

describe("CR-CRU-071 AC4 — a recovery point exists before any mutation", () => {
  test("AC4 — a migrating open writes <path>.pre-upgrade-<epoch> holding the PRE-migration state", () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);
    const fingerprintBefore = schemaFingerprint(dbPath);

    const store = Store.open(dbPath);

    const found = siblings(dir, PRE_UPGRADE_RE);
    expect(found.length).toBe(1);
    const backupPath = path.join(dir, found[0]!);
    // Same shape as CR-CRU-001 §S5's `<path>.corrupt-<epoch>` sibling — one
    // convention, one cleanup rule (AC4), not a competing scheme.
    expect(found[0]).toMatch(/^crucible\.db\.pre-upgrade-\d+$/);

    // It is a readable SQLite copy of the store BEFORE the migration ran.
    expect(userVersion(backupPath)).toBe(0);
    expect(columnsOf(backupPath, "events")).toContain("phase");
    expect(columnsOf(backupPath, "events")).not.toContain("role");
    expect(schemaFingerprint(backupPath)).toBe(fingerprintBefore);
    expect(eventRole(dbPath, "e-declared").role).toBe("GREEN");

    // The boot names the backup it wrote.
    const migration = migrationOf(store);
    expect(migration).not.toBeNull();
    expect(migration?.backupPath).toBe(backupPath);
    expect(migration?.to).toBe(schemaVersion());
    expect(migration?.from).toBeLessThan(schemaVersion());
  });

  test("AC4 — :memory: is exempt: no backup path, no sibling anywhere", () => {
    const before = siblings(process.cwd(), PRE_UPGRADE_RE);

    const store = Store.open(":memory:");

    expect(schemaVersionOf(store)).toBe(schemaVersion());
    expect(migrationOf(store)?.backupPath ?? null).toBeNull();
    expect(siblings(process.cwd(), PRE_UPGRADE_RE)).toEqual(before);
  });
});

describe("CR-CRU-071 AC5 — a newer store is REFUSED, and refusal is NOT quarantine", () => {
  test("AC5 — a future user_version is refused: both versions named, file byte-identical, no sibling", () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);
    // Bring it to the current shape first, so the refusal cannot be confused
    // with "this file is unreadable".
    Store.open(dbPath);
    for (const stale of siblings(dir, PRE_UPGRADE_RE)) {
      fs.rmSync(path.join(dir, stale));
    }
    const future = schemaVersion() + 1;
    stampUserVersion(dbPath, future);

    const hashBefore = sha256(dbPath);
    const listingBefore = fs.readdirSync(dir).sort();

    const error = captureThrow(() => Store.open(dbPath));
    expect(error).toBeDefined();
    const message = messageOf(error);
    // Both versions and the remedy.
    expect(message).toContain(String(future));
    expect(message).toContain(String(schemaVersion()));
    expect(message).toMatch(/upgrade/i);
    expect(message).toMatch(/restore|backup/i);

    // NOTHING touched: no rename, no fresh db, no writes.
    expect(sha256(dbPath)).toBe(hashBefore);
    expect(fs.readdirSync(dir).sort()).toEqual(listingBefore);
    expect(siblings(dir, CORRUPT_RE)).toEqual([]);
    expect(siblings(dir, PRE_UPGRADE_RE)).toEqual([]);
    expect(userVersion(dbPath)).toBe(future);
  });

  test("AC5 — the server refuses to boot on a future store and abandons no data", () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);
    Store.open(dbPath);
    for (const stale of siblings(dir, PRE_UPGRADE_RE)) {
      fs.rmSync(path.join(dir, stale));
    }
    stampUserVersion(dbPath, schemaVersion() + 1);
    const hashBefore = sha256(dbPath);

    let handle: ServerHandle | undefined;
    const error = captureThrow(() => {
      handle = serverModule.startServer({ port: 0, dbPath });
      return handle;
    });
    if (handle !== undefined) handles.push(handle);

    expect(handle).toBeUndefined();
    expect(error).toBeDefined();
    expect(messageOf(error)).toMatch(/upgrade/i);
    expect(sha256(dbPath)).toBe(hashBefore);
    expect(siblings(dir, CORRUPT_RE)).toEqual([]);
  });

  test("AC5 boundary — an UNREADABLE store still quarantines and boots (CR-CRU-001 §S5, unchanged)", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "crucible.db");
    fs.writeFileSync(dbPath, "this is not sqlite");

    // Refusal must never leak onto the corruption path: boot still survives.
    const store = Store.open(dbPath);

    expect(store.listProjects().length).toBe(0);
    expect(siblings(dir, CORRUPT_RE).length).toBe(1);
    const key = crypto.randomUUID();
    store.addProject({ key, name: "recovered", type: "backend", sutRoot: "/tmp" });
    expect(store.getProject(key)?.name).toBe("recovered");
    // A fresh db created by the quarantine path is itself versioned.
    expect(userVersion(dbPath)).toBe(schemaVersion());
  });
});

describe("CR-CRU-071 AC6 — migration outcome is disclosed, not silent", () => {
  test("AC6 — both health routes report the schema version beside CR-CRU-068's { path, rule }", async () => {
    const dbPath = path.join(tmpDir(), "crucible.db");
    const handle = serverModule.startServer({ port: 0, dbPath });
    handles.push(handle);

    for (const route of ["/api/health", "/api/v2/health"]) {
      const body = await health(handle, route);
      const block = storeBlockOf(body, route);
      // CR-CRU-068's disclosure is untouched.
      expect(block.path).toBe(dbPath);
      expect(block.rule).toBe("explicit");
      expect(healthSchemaVersion(body, route)).toBe(schemaVersion());
      expect(healthMigration(body, route)).toBeNull();
    }
    // Startup disclosure, taken from the handle (never from console).
    expect(schemaVersionOf(handle.store)).toBe(schemaVersion());
    expect(migrationOf(handle.store)).toBeNull();
  });

  test("AC6 — a boot that migrated names from -> to and the backup it wrote, on both routes", async () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);

    const handle = serverModule.startServer({ port: 0, dbPath });
    handles.push(handle);

    const backup = path.join(dir, siblings(dir, PRE_UPGRADE_RE)[0] ?? "MISSING");
    const booted = migrationOf(handle.store);
    expect(booted).not.toBeNull();
    expect(booted?.to).toBe(schemaVersion());
    expect(booted?.from).toBeLessThan(schemaVersion());
    expect(booted?.backupPath).toBe(backup);

    for (const route of ["/api/health", "/api/v2/health"]) {
      const body = await health(handle, route);
      expect(healthSchemaVersion(body, route)).toBe(schemaVersion());
      expect(healthMigration(body, route)).toEqual(booted);
    }
  });
});

describe("CR-CRU-071 AC7 — a failed migration fails the upgrade", () => {
  test("AC7 — a throwing step aborts: user_version stays at the pre-step value and the error names the backup", () => {
    const dir = tmpDir();
    const dbPath = makePreRenameStore(dir);

    // 🚨 SEAM: Store.open(path, { migrations }) — see the header. The chain
    // below advances the store one version, then throws on the next step.
    const applied: number[] = [];
    const chain: MigrationStep[] = [
      {
        from: 0,
        to: 1,
        description: "cr071-red: harmless marker step",
        apply(db) {
          db.exec("CREATE TABLE IF NOT EXISTS cr071_marker (id INTEGER PRIMARY KEY)");
          applied.push(1);
        },
      },
      {
        from: 1,
        to: 2,
        description: "cr071-red: the step that throws",
        apply(db) {
          db.exec("CREATE TABLE IF NOT EXISTS cr071_half_written (id INTEGER PRIMARY KEY)");
          applied.push(2);
          throw new Error("cr071-red: injected migration failure");
        },
      },
    ];

    const error = captureThrow(() => openWith(dbPath, chain));

    expect(error).toBeDefined();
    expect(applied).toEqual([1, 2]);
    // Aborted transaction: the failing step left NOTHING behind ...
    expect(schemaFingerprint(dbPath)).not.toContain("cr071_half_written");
    expect(schemaFingerprint(dbPath)).toContain("cr071_marker");
    // ... and no partial version stamp: the store still reads the value the
    // last SUCCESSFUL step committed.
    expect(userVersion(dbPath)).toBe(1);

    // The failure points at the recovery point it made before touching anything.
    const found = siblings(dir, PRE_UPGRADE_RE);
    expect(found.length).toBe(1);
    const backupPath = path.join(dir, found[0]!);
    expect(messageOf(error)).toContain(backupPath);
    expect(userVersion(backupPath)).toBe(0);
    expect(columnsOf(backupPath, "events")).toContain("phase");
  });

  test("AC7 — the server does not begin serving on a half-migrated store", () => {
    const dir = tmpDir();
    // A genuinely failing retrofit, no injection: a view over a missing table
    // makes `ALTER TABLE events RENAME COLUMN phase TO role` throw
    // ("error in view cr071_broken_view: no such table: main.ghost_table").
    // Today Store.open swallows that into the §S5 quarantine path and renames
    // a PERFECTLY GOOD database aside; AC5/AC7 say a migration failure must
    // abort loudly instead.
    const dbPath = makePreRenameStore(
      dir,
      "CREATE VIEW cr071_broken_view AS SELECT phase FROM ghost_table;",
    );
    const hashBefore = sha256(dbPath);

    let handle: ServerHandle | undefined;
    const error = captureThrow(() => {
      handle = serverModule.startServer({ port: 0, dbPath });
      return handle;
    });
    if (handle !== undefined) handles.push(handle);

    expect(handle).toBeUndefined();
    expect(error).toBeDefined();
    // Not quarantine: the user's data stays exactly where it was.
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(siblings(dir, CORRUPT_RE)).toEqual([]);
    expect(sha256(dbPath)).toBe(hashBefore);
    // ... and the failure names the recovery point.
    const found = siblings(dir, PRE_UPGRADE_RE);
    expect(found.length).toBe(1);
    expect(messageOf(error)).toContain(path.join(dir, found[0]!));
  });
});
