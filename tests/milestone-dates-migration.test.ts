// CR-CRU-130 §S1 — the migration that gives the record table CR-CRU-129
// created this morning its two date columns.
//
// ── What the step must do ─────────────────────────────────────────────────
//
//   * ADD the two filtered columns to `milestones`.
//   * DERIVE them for every row already there, from the payload the row
//     already carries: a proposal's `targetAt` survives as the target, and a
//     release's `releasedAt` — the delivered date under its old name — reads
//     as the delivered date.
//   * CHANGE NOTHING ELSE. A row's payload blob, its id, its timestamp and
//     its identity columns are byte-identical before and after, which is the
//     only form of "nothing was lost" that can be asserted rather than
//     eyeballed (the CR's own Risk section says so: CR-CRU-129 exists because
//     this history was already lost once).
//   * Be IDEMPOTENT: a second boot changes nothing.
//
// The step is found BY ITS DESCRIPTION, never by index and never by the
// chain's length — exactly as tests/milestone-record-migration.test.ts and
// tests/gate-retirement.test.ts find their own.
//
// ── Two spellings are assumed, and ONLY here + in
//    tests/milestone-dates-are-first-class.test.ts ───────────────────────────
// The COLUMN names, snake_case like `retired_at`/`cycle_id`. If GREEN spells
// them differently, these two constants move.
//
// 🚨 TABLE NAME PINNED: `milestones`. A migration is the one place where the
// destination IS the contract — "the columns landed" is unprovable without
// saying where. Same carve-out CR-CRU-129's migration suite states.
//
// ── Safety: the live store is READ, never written ─────────────────────────
// The real-scale case works on a `sqlite3 -readonly … .backup` REPLICA in an
// mkdtemp directory. The live `data/crucible.db` is opened read-only by the
// backup command and by nothing else; the test MEASURES its size and mtime
// before and after and fails if either moved. Every other case is a scratch
// file. Nothing here talks to the running board.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

/** THE TWO SPELLING DECISIONS, isolated — see the header. */
const TARGET_COLUMN = "target_at";
const DELIVERED_COLUMN = "delivered_at";

const ORCH = "cru130-c1-migration";

/** Epoch SECONDS, the unit `releasedAt`/`targetAt` already use. */
const SHIPPED_AT = 1_780_000_000;
const PROPOSED_FOR = 1_800_000_000;

interface ChainStep {
  readonly from: number;
  readonly to: number;
  readonly description?: string;
}

/** One record row, as it is STORED — the blob compared as a string. */
interface StoredRow {
  id: string;
  project_key: string;
  agent_id: string;
  tier: string;
  codec: string | null;
  timestamp: number;
  type: string | null;
  label: string | null;
  payload: string | null;
  context: string | null;
  role: string | null;
  role_inferred: number | null;
  retired_at: number | null;
  cycle_id: number | null;
}

interface DatedColumns {
  id: string;
  target_at: number | null;
  delivered_at: number | null;
}

interface WireRecord {
  id: string;
  type?: string;
  label?: string;
  targetAt?: number;
  deliveredAt?: number;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  milestones?: WireRecord[];
  project?: { key: string };
  [key: string]: unknown;
}

function migrationChain(): readonly ChainStep[] {
  const mod = storeModule as { MIGRATIONS?: unknown };
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error("CR-CRU-130 §S1: src/store.ts exports no MIGRATIONS chain");
  }
  return mod.MIGRATIONS as readonly ChainStep[];
}

/** The ONE step this CR owns, found by what it DECLARES — never by index. */
function datesStep(): ChainStep {
  const chain = migrationChain();
  const owned = chain.filter((step) => /CR-130|CR-CRU-130/.test(step.description ?? ""));
  if (owned.length !== 1) {
    throw new Error(
      `CR-CRU-130 §S1: expected exactly ONE step in the ${String(chain.length)}-step migration ` +
        `chain to declare the milestone date columns (its description must name CR-130), found ` +
        `${String(owned.length)}. Without it, every existing board keeps its dates locked inside ` +
        `the payload blob, where nothing can filter on them — so "what is outstanding" stays ` +
        `unanswerable on exactly the data that matters.`,
    );
  }
  return owned[0]!;
}

function closeStore(store: Store): void {
  (store as unknown as { db: Database }).db.close();
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function storedRows(db: Database): StoredRow[] {
  return db
    .query<StoredRow, []>(
      `SELECT id, project_key, agent_id, tier, codec, timestamp, type, label, payload, context,
              role, role_inferred, retired_at, cycle_id
         FROM milestones ORDER BY id`,
    )
    .all();
}

function datedColumns(db: Database): Map<string, DatedColumns> {
  return new Map(
    db
      .query<DatedColumns, []>(
        `SELECT id, ${TARGET_COLUMN}, ${DELIVERED_COLUMN} FROM milestones ORDER BY id`,
      )
      .all()
      .map((row) => [row.id, row]),
  );
}

function payloadOf(row: StoredRow): Record<string, unknown> {
  return JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
}

/**
 * Turn a store into the shape a PRE-CR-130 board really has: the two columns
 * gone, the chain stamped back to the step before this CR's.
 *
 * Built this way rather than by hand-writing the old DDL so it keeps working
 * after GREEN, when an ordinary `Store` open creates the table WITH the
 * columns — a fixture that could only be built by a pre-GREEN build would
 * stop testing the migration the moment the migration existed.
 */
function downgrade(dbPath: string, toVersion: number): void {
  const db = new Database(dbPath);
  try {
    // DELETE journal mode so the rewrite leaves no -wal/-shm siblings behind.
    db.exec("PRAGMA journal_mode = DELETE;");
    for (const index of db
      .query<{ name: string; sql: string | null }, []>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'milestones'`,
      )
      .all()) {
      const sql = index.sql ?? "";
      if (sql.includes(TARGET_COLUMN) || sql.includes(DELIVERED_COLUMN)) {
        db.exec(`DROP INDEX IF EXISTS "${index.name}"`);
      }
    }
    const present = columnsOf(db, "milestones");
    for (const column of [TARGET_COLUMN, DELIVERED_COLUMN]) {
      if (present.includes(column)) db.exec(`ALTER TABLE milestones DROP COLUMN "${column}"`);
    }
    db.exec(`PRAGMA user_version = ${String(toVersion)};`);
  } finally {
    db.close();
  }
}

describe("the dates a milestone already held become columns, and history keeps everything else", () => {
  const scratchDirs: string[] = [];
  const openDbs: Database[] = [];
  const handles: ServerHandle[] = [];

  afterEach(() => {
    while (handles.length > 0) handles.pop()?.stop();
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  /**
   * A direct handle on a SCRATCH file — a replica or a throwaway store, never
   * the live database (which is read only by `sqlite3 -readonly`, once, to
   * take the replica). Not opened read-only, because a WAL store with no
   * companion `-shm` cannot be opened that way; a replica is ours to open
   * however we like.
   */
  function raw(dbPath: string): Database {
    const db = new Database(dbPath);
    openDbs.push(db);
    return db;
  }

  function boot(dbPath: string): ServerHandle {
    const handle = startServer({ port: 0, dbPath });
    handles.push(handle);
    return handle;
  }

  async function get(handle: ServerHandle, path: string): Promise<AnyBody> {
    const res = await fetch(`http://localhost:${String(handle.server.port)}${path}`);
    return (await res.json()) as AnyBody;
  }

  async function recordsOfType(
    handle: ServerHandle,
    key: string,
    type: string,
  ): Promise<WireRecord[]> {
    const body = await get(
      handle,
      `/api/v2/projects/${key}/milestones?type=${encodeURIComponent(type)}`,
    );
    return body.milestones ?? [];
  }

  // ── AC — the step exists, and it is a step ───────────────────────────────

  test(
    "exactly ONE migration step declares the date columns, and it is the end of the chain the " +
      "build writes",
    () => {
      const step = datesStep();

      // The chain's positions ARE the version numbers (CR-CRU-071 §S1), so a
      // step that does not end the chain means this build writes a version it
      // does not produce.
      expect(step.to).toBe(SCHEMA_VERSION);
      expect(step.from).toBe(SCHEMA_VERSION - 1);
      expect(SCHEMA_VERSION).toBe(migrationChain().length);
    },
  );

  // ── AC — payload dates become columns; releasedAt IS the delivered date ──

  test(
    "an existing board's rows keep their payload dates and GAIN the columns: a release's " +
      "`releasedAt` reads as its delivered date and a proposal's `targetAt` survives",
    async () => {
      const dbPath = join(scratch("cru130-migrate-"), "crucible.db");
      const store = Store.open(dbPath);
      const key = crypto.randomUUID();
      store.addProject({ key, name: "cru130-migration", type: "backend", sutRoot: "/tmp" });
      const shipped = store.recordMilestoneEvent(key, ORCH, "release", {
        label: "9.7.0",
        commit: "aaa1111",
        releasedAt: SHIPPED_AT,
        crs: ["CR-SHIPPED-1", "CR-SHIPPED-2"],
      }).event.id;
      const proposed = store.recordReleaseProposal(key, ORCH, {
        label: "9.8.0",
        targetAt: PROPOSED_FOR,
      }).event.id;
      const merged = store.recordMilestoneEvent(key, ORCH, "cr-merged", {
        label: "CR-SHIPPED-1",
        commit: "bbb2222",
      }).event.id;
      closeStore(store);

      // ── PRE-STATE, proved before anything is migrated ──────────────────
      const before = raw(dbPath);
      expect(columnsOf(before, "milestones")).not.toContain(TARGET_COLUMN);
      expect(columnsOf(before, "milestones")).not.toContain(DELIVERED_COLUMN);
      const wasStored = new Map(storedRows(before).map((row) => [row.id, row]));
      // The dates really are inside the blob today — that is what makes the
      // migration a DERIVATION rather than an invention.
      expect(payloadOf(wasStored.get(shipped)!).releasedAt).toBe(SHIPPED_AT);
      expect(payloadOf(wasStored.get(proposed)!).targetAt).toBe(PROPOSED_FOR);
      expect(payloadOf(wasStored.get(merged)!).releasedAt).toBeUndefined();
      before.close();
      openDbs.splice(openDbs.indexOf(before), 1);

      downgrade(dbPath, datesStep().from);

      // ── the migration, on an ORDINARY BOOT ─────────────────────────────
      const handle = boot(dbPath);

      const after = raw(dbPath);
      expect(columnsOf(after, "milestones")).toContain(TARGET_COLUMN);
      expect(columnsOf(after, "milestones")).toContain(DELIVERED_COLUMN);
      const columns = datedColumns(after);

      // POSITIVE — `releasedAt` IS the delivered date under its old name.
      expect(columns.get(shipped)![DELIVERED_COLUMN]).toBe(SHIPPED_AT);
      // …and a proposal's declared target survives as the target.
      expect(columns.get(proposed)![TARGET_COLUMN]).toBe(PROPOSED_FOR);
      // NEGATIVE — nothing was invented: a release was aimed at no declared
      // target, and a `cr-merged` record has neither date. A migration that
      // defaulted to 0 or to the row's timestamp fails here.
      expect(columns.get(shipped)![TARGET_COLUMN]).toBeNull();
      expect(columns.get(merged)![TARGET_COLUMN]).toBeNull();
      expect(columns.get(merged)![DELIVERED_COLUMN]).toBeNull();

      // Nothing else moved: every stored column, the payload blob included,
      // byte-identical to the pre-state.
      for (const row of storedRows(after)) {
        const was = wasStored.get(row.id)!;
        expect(row.payload).toBe(was.payload);
        expect({ ...row }).toEqual({ ...was });
      }
      expect(storedRows(after).map((row) => row.id)).toEqual([...wasStored.keys()].sort());

      // And the wire serves the delivered date the migration derived.
      const releases = await recordsOfType(handle, key, "release");
      expect(releases.map((row) => row.id)).toEqual([shipped]);
      expect(releases[0]!.deliveredAt).toBe(SHIPPED_AT);
      expect(releases[0]!.releasedAt).toBe(SHIPPED_AT);
    },
  );

  test("re-running the migration changes nothing — a second boot is a no-op", async () => {
    const dbPath = join(scratch("cru130-idempotent-"), "crucible.db");
    const store = Store.open(dbPath);
    const key = crypto.randomUUID();
    store.addProject({ key, name: "cru130-idempotent", type: "backend", sutRoot: "/tmp" });
    store.recordMilestoneEvent(key, ORCH, "release", {
      label: "9.7.1",
      commit: "ccc3333",
      releasedAt: SHIPPED_AT,
    });
    store.recordReleaseProposal(key, ORCH, { label: "9.8.1", targetAt: PROPOSED_FOR });
    closeStore(store);

    downgrade(dbPath, datesStep().from);

    const first = boot(dbPath);
    const afterFirst = raw(dbPath);
    const rowsAfterFirst = storedRows(afterFirst);
    const datesAfterFirst = datedColumns(afterFirst);
    // NON-VACUITY — the first pass really did derive something, so "unchanged"
    // below is not two empty answers agreeing.
    expect([...datesAfterFirst.values()].filter((row) => row[DELIVERED_COLUMN] !== null)).toHaveLength(1);
    expect([...datesAfterFirst.values()].filter((row) => row[TARGET_COLUMN] !== null)).toHaveLength(1);
    afterFirst.close();
    openDbs.splice(openDbs.indexOf(afterFirst), 1);
    first.stop();
    handles.splice(handles.indexOf(first), 1);

    const second = boot(dbPath);
    const afterSecond = raw(dbPath);

    expect(storedRows(afterSecond)).toEqual(rowsAfterFirst);
    expect([...datedColumns(afterSecond).entries()]).toEqual([...datesAfterFirst.entries()]);
    expect(
      afterSecond.query<{ user_version: number }, []>(`PRAGMA user_version`).get()!.user_version,
    ).toBe(SCHEMA_VERSION);
    // The second boot still answers, rather than refusing an already-migrated
    // store — the failure mode a non-idempotent ALTER would produce.
    expect((await get(second, `/api/v2/projects/${key}/milestones?type=release`)).ok).toBe(true);
  });

  // ── AC — at REAL scale, against a replica of the live store ──────────────

  test(
    "at this project's real population, every record survives the migration byte-identically " +
      "except for the two fields it adds",
    async () => {
      const live = join(process.cwd(), "data", "crucible.db");
      if (!existsSync(live)) {
        throw new Error(
          `CR-CRU-130 §S1: this case verifies the migration at real scale and needs a replica of ` +
            `the live store at ${live}, which does not exist here. It is READ-ONLY: the replica ` +
            `is taken with \`sqlite3 -readonly … .backup\` and the live file's size and mtime are ` +
            `asserted unchanged afterwards.`,
        );
      }
      const liveBefore = statSync(live);

      const dir = scratch("cru130-live-replica-");
      const replica = join(dir, "replica.db");
      expect(replica).not.toBe(live);
      const backup = Bun.spawnSync(["sqlite3", "-readonly", live, `.backup '${replica}'`]);
      if (backup.exitCode !== 0) {
        throw new Error(
          `CR-CRU-130 §S1: could not take a read-only replica of the live store — sqlite3 exited ` +
            `${String(backup.exitCode)}: ${backup.stderr.toString()}`,
        );
      }

      // ── PRE-STATE on the replica, measured rather than assumed ─────────
      const before = raw(replica);
      const wasStored = storedRows(before);
      const wasById = new Map(wasStored.map((row) => [row.id, row]));
      const withDelivered = wasStored.filter(
        (row) => payloadOf(row).releasedAt !== undefined,
      );
      const withTarget = wasStored.filter((row) => payloadOf(row).targetAt !== undefined);
      // REAL SCALE, and the two shapes the migration derives from are really
      // present. Every expectation below is derived from these rows; no count
      // is pinned, because the live population grows every day.
      expect(wasStored.length).toBeGreaterThan(10);
      expect(withDelivered.length).toBeGreaterThan(0);
      expect(withTarget.length).toBeGreaterThan(0);
      expect(columnsOf(before, "milestones")).not.toContain(TARGET_COLUMN);
      expect(columnsOf(before, "milestones")).not.toContain(DELIVERED_COLUMN);
      before.close();
      openDbs.splice(openDbs.indexOf(before), 1);

      downgrade(replica, datesStep().from);

      const handle = boot(replica);
      const after = raw(replica);

      // 1. NOTHING WAS LOST, AND NOTHING WAS REWRITTEN — the stored form,
      //    payload blob included, compared as stored.
      const nowStored = storedRows(after);
      expect(nowStored.map((row) => row.id)).toEqual(wasStored.map((row) => row.id));
      for (const row of nowStored) {
        const was = wasById.get(row.id)!;
        expect(row.payload).toBe(was.payload);
        expect({ ...row }).toEqual({ ...was });
      }

      // 2. THE COLUMNS ARE DERIVED, ROW BY ROW, FROM THAT UNTOUCHED PAYLOAD.
      const columns = datedColumns(after);
      const derivationFaults = nowStored.flatMap((row) => {
        const payload = payloadOf(row);
        const expectedTarget = (payload.targetAt as number | undefined) ?? null;
        const expectedDelivered =
          (payload.deliveredAt as number | undefined) ??
          (payload.releasedAt as number | undefined) ??
          null;
        const found = columns.get(row.id)!;
        const faults: string[] = [];
        if (found[TARGET_COLUMN] !== expectedTarget) {
          faults.push(
            `${row.id} (${String(row.type)}): ${TARGET_COLUMN}=${String(found[TARGET_COLUMN])} expected ${String(expectedTarget)}`,
          );
        }
        if (found[DELIVERED_COLUMN] !== expectedDelivered) {
          faults.push(
            `${row.id} (${String(row.type)}): ${DELIVERED_COLUMN}=${String(found[DELIVERED_COLUMN])} expected ${String(expectedDelivered)}`,
          );
        }
        return faults;
      });
      expect(derivationFaults).toEqual([]);

      // 3. THE WIRE ANSWERS THE SAME RECORD IT ALWAYS DID, PLUS THE TWO NEW
      //    FIELDS AND NOTHING ELSE.
      //
      //    The "identity" keys a record's wire row carries whatever its type
      //    are DERIVED, not enumerated: one dateless milestone written through
      //    the ordinary path in a throwaway store publishes exactly them. So a
      //    new field appearing on the wire shows up here as an unexpected key
      //    rather than being quietly folded into a hand-kept list.
      const control = boot(":memory:");
      const controlKey = crypto.randomUUID();
      control.store.addProject({
        key: controlKey,
        name: "cru130-wire-control",
        type: "backend",
        sutRoot: "/tmp",
      });
      control.store.recordMilestoneEvent(controlKey, ORCH, "custom", { label: "control" });
      const controlRow = (await recordsOfType(control, controlKey, "custom"))[0]!;
      const identityKeys = new Set(
        Object.keys(controlRow).filter((key) => key !== "type" && key !== "label"),
      );
      expect(identityKeys.size).toBeGreaterThan(3);

      const pairs = new Map<string, Set<string>>();
      for (const row of nowStored) {
        if (row.type === null) continue;
        const types = pairs.get(row.project_key) ?? new Set<string>();
        types.add(row.type);
        pairs.set(row.project_key, types);
      }
      const wireFaults: string[] = [];
      let compared = 0;
      let comparedWithDates = 0;
      for (const [projectKey, types] of pairs) {
        for (const type of types) {
          for (const served of await recordsOfType(handle, projectKey, type)) {
            const was = wasById.get(served.id);
            if (was === undefined) {
              wireFaults.push(`${served.id}: served by the wire but absent before the migration`);
              continue;
            }
            compared += 1;
            const payload = payloadOf(was);
            // Every field the payload carried comes back with the value it
            // carried — a renamed or re-typed field is caught here.
            for (const [field, value] of Object.entries(payload)) {
              if (JSON.stringify(served[field]) !== JSON.stringify(value)) {
                wireFaults.push(
                  `${served.id}: ${field} was ${JSON.stringify(value)}, is now ${JSON.stringify(served[field])}`,
                );
              }
            }
            if (served.id !== was.id || (was.timestamp as number) !== served.timestamp) {
              wireFaults.push(`${served.id}: identity moved`);
            }
            const added = Object.keys(served).filter(
              (key) => !identityKeys.has(key) && !(key in payload),
            );
            const unexpected = added.filter(
              (key) => key !== "targetAt" && key !== "deliveredAt",
            );
            if (unexpected.length > 0) {
              wireFaults.push(`${served.id}: unexpected new wire field(s) ${unexpected.join(", ")}`);
            }
            if (added.length > 0) comparedWithDates += 1;
          }
        }
      }
      expect(wireFaults).toEqual([]);
      // NON-VACUITY — the loop really compared the population, and really saw
      // rows that GAINED a date (otherwise "nothing changed except the two
      // fields" would be satisfied by a migration that added nothing at all).
      expect(compared).toBeGreaterThan(10);
      expect(comparedWithDates).toBeGreaterThan(0);

      // 4. THE LIVE STORE WAS NEVER WRITTEN.
      const liveAfter = statSync(live);
      expect(liveAfter.size).toBe(liveBefore.size);
      expect(liveAfter.mtimeMs).toBe(liveBefore.mtimeMs);
    },
  );
});
