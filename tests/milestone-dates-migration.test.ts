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
const DAY = 86_400;

/**
 * A READ-ONLY replica of the live store, or the STATED reason there is none.
 *
 * The live file is opened by `sqlite3 -readonly … .backup` and by nothing
 * else, and the caller asserts its size and mtime are unmoved afterwards.
 *
 * A replica is the OPERATOR'S disk, not the project's: a clean checkout and CI
 * have no live store and may have no `sqlite3`, and a case that THREW there
 * would report a missing file as a broken invariant. The repo's own idiom for
 * a live subject applies instead (`tests/queue-release-membership-mandatory
 * .test.ts`'s `liveBoardQueue`): the reason is returned, the case STATES it and
 * returns, and what is lost is the proof's REACH — a real population grown over
 * months — never the proof, which the synthetic population always runs.
 */
function liveStoreReplica(
  dir: string,
): { live: string; replica: string; sizeBefore: number; mtimeBefore: number } | { skip: string } {
  const live = join(process.cwd(), "data", "crucible.db");
  if (!existsSync(live)) {
    return { skip: `there is no live store at ${live}, and its data is never committed` };
  }
  const replica = join(dir, "replica.db");
  const before = statSync(live);
  try {
    const backup = Bun.spawnSync(["sqlite3", "-readonly", live, `.backup '${replica}'`]);
    if (backup.exitCode !== 0) {
      return {
        skip:
          `sqlite3 could not take a read-only replica of ${live} — exit ` +
          `${String(backup.exitCode)}: ${backup.stderr.toString().trim()}`,
      };
    }
  } catch (failure) {
    const said = failure instanceof Error ? failure.message : String(failure);
    return { skip: `\`sqlite3\`, which takes the read-only replica, is not runnable here (${said})` };
  }
  return { live, replica, sizeBefore: before.size, mtimeBefore: before.mtimeMs };
}

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
      const wasStored = new Map(storedRows(before).map((row) => [row.id, row]));
      // The dates really are inside the blob today — that is what makes the
      // migration a DERIVATION rather than an invention.
      expect(payloadOf(wasStored.get(shipped)!).releasedAt).toBe(SHIPPED_AT);
      expect(payloadOf(wasStored.get(proposed)!).targetAt).toBe(PROPOSED_FOR);
      expect(payloadOf(wasStored.get(merged)!).releasedAt).toBeUndefined();
      before.close();
      openDbs.splice(openDbs.indexOf(before), 1);

      downgrade(dbPath, datesStep().from);

      // ── PRE-STATE, the half that only holds BELOW the downgrade ────────
      // Asserted here rather than above it: an ordinary `Store` open creates
      // the table WITH the columns once the migration exists, which is exactly
      // what `downgrade` undoes, so a store that lacks them is what this CR's
      // step really upgrades FROM.
      const downgraded = raw(dbPath);
      expect(columnsOf(downgraded, "milestones")).not.toContain(TARGET_COLUMN);
      expect(columnsOf(downgraded, "milestones")).not.toContain(DELIVERED_COLUMN);
      downgraded.close();
      openDbs.splice(openDbs.indexOf(downgraded), 1);

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

  // ── AC — the whole proof, over whatever population it is handed ─────────

  /**
   * Migrate the store at `dbPath` from the step BEFORE this CR's to the end of
   * the chain, and prove the three things the migration promises:
   *
   *   1. NOTHING WAS LOST AND NOTHING WAS REWRITTEN — every stored column, the
   *      payload blob included, compared as stored.
   *   2. THE COLUMNS ARE DERIVED, row by row, from that untouched payload.
   *   3. THE WIRE answers the same record it always did, plus the two new
   *      fields and nothing else.
   *
   * Shared by the synthetic population below — which ALWAYS runs — and by the
   * live replica, so an absent replica costs the proof's REACH (a real
   * population, grown over months, with shapes no fixture would think to
   * write) and never the proof itself.
   */
  async function proveMigration(
    dbPath: string,
  ): Promise<{ rowsBefore: StoredRow[]; compared: number; comparedWithDates: number }> {
    // ── PRE-STATE, measured rather than assumed ───────────────────────────
    const before = raw(dbPath);
    const wasStored = storedRows(before);
    const wasById = new Map(wasStored.map((row) => [row.id, row]));
    before.close();
    openDbs.splice(openDbs.indexOf(before), 1);

    downgrade(dbPath, datesStep().from);

    // The store really is at the state this CR's step upgrades FROM — asserted
    // AFTER the downgrade, because an ordinary `Store` open creates the table
    // WITH the columns once the migration exists, which is the very thing
    // `downgrade` is here to undo.
    const downgraded = raw(dbPath);
    expect(columnsOf(downgraded, "milestones")).not.toContain(TARGET_COLUMN);
    expect(columnsOf(downgraded, "milestones")).not.toContain(DELIVERED_COLUMN);
    expect(storedRows(downgraded)).toEqual(wasStored);
    downgraded.close();
    openDbs.splice(openDbs.indexOf(downgraded), 1);

    const handle = boot(dbPath);
    const after = raw(dbPath);

    // 1. NOTHING WAS LOST, AND NOTHING WAS REWRITTEN.
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
    //    The "identity" keys a record's wire row carries whatever its type are
    //    DERIVED, not enumerated: records written through the ordinary path in
    //    a throwaway store publish exactly them. So a new field appearing on
    //    the wire shows up here as an unexpected key rather than being quietly
    //    folded into a hand-kept list.
    //
    //    A key is an IDENTITY key exactly when the record serves it WITHOUT its
    //    payload carrying it — that is what "column-backed" means, and it is
    //    computed from the control's own stored payload rather than assumed.
    //    One control record is not enough to derive that set: any column-backed
    //    field the control happens not to carry reproduces this comparison's
    //    worst failure mode, reporting an untouched field on every row as a
    //    field this CR had added. So the controls between them carry every
    //    column-backed field the production door can put on a milestone —
    //    `context` and the `cycle_id` derived from it, and `retired_at`, which
    //    a shipped release stamps on the proposal it consumes — and the set is
    //    then asserted to CONTAIN them BY NAME, so a control that stops being
    //    representative fails here, loudly, instead of downstream.
    const controlPath = join(scratch("cru130-wire-control-"), "control.db");
    const control = boot(controlPath);
    const controlKey = crypto.randomUUID();
    control.store.addProject({
      key: controlKey,
      name: "cru130-wire-control",
      type: "backend",
      sutRoot: "/tmp",
    });
    control.store.recordMilestoneEvent(controlKey, ORCH, "custom", {
      label: "control",
      context: { cycleId: 7 },
    });
    control.store.recordReleaseProposal(controlKey, ORCH, {
      label: "9.9.9",
      targetAt: PROPOSED_FOR,
    });
    // Shipping the release CONSUMES that proposal, stamping `retired_at` on it.
    control.store.recordMilestoneEvent(controlKey, ORCH, "release", {
      label: "9.9.9",
      commit: "ddd4444",
      releasedAt: SHIPPED_AT,
    });
    const controlDb = raw(controlPath);
    const controlPayloads = new Map(storedRows(controlDb).map((row) => [row.id, payloadOf(row)]));
    const controlServed = [
      ...(await recordsOfType(control, controlKey, "custom")),
      ...(await recordsOfType(control, controlKey, "release-proposal")),
      ...(await recordsOfType(control, controlKey, "release")),
    ];
    const identityKeys = new Set(
      controlServed.flatMap((row) =>
        Object.keys(row).filter((key) => !(key in controlPayloads.get(row.id)!)),
      ),
    );
    expect(identityKeys.size).toBeGreaterThan(3);
    // The derivation's own completeness, checked: every column-backed key the
    // schema can serve is in the set. `type`/`label` are absent by
    // construction (they ARE payload fields as well as columns), and so are
    // `targetAt`/`deliveredAt` — which is what keeps the two-new-fields check
    // below meaningful.
    for (const key of ["id", "projectKey", "agentId", "kind", "tier", "timestamp", "context", "cycleId", "retiredAt"]) {
      expect([...identityKeys]).toContain(key);
    }
    for (const key of ["type", "label", "targetAt", "deliveredAt"]) {
      expect([...identityKeys]).not.toContain(key);
    }

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
          const unexpected = added.filter((key) => key !== "targetAt" && key !== "deliveredAt");
          if (unexpected.length > 0) {
            wireFaults.push(`${served.id}: unexpected new wire field(s) ${unexpected.join(", ")}`);
          }
          if (added.length > 0) comparedWithDates += 1;
        }
      }
    }
    expect(wireFaults).toEqual([]);
    return { rowsBefore: wasStored, compared, comparedWithDates };
  }

  // ── AC — the invariant, on a population this suite writes itself ─────────

  test(
    "across a population of many types carrying every combination of the two dates, every record " +
      "survives the migration byte-identically except for the two fields it adds",
    async () => {
      const dbPath = join(scratch("cru130-synthetic-scale-"), "crucible.db");
      const store = Store.open(dbPath);
      // TWO projects, so the wire comparison really walks the (project, type)
      // pairs rather than one project's worth of rows.
      const keys = [crypto.randomUUID(), crypto.randomUUID()];
      for (const [index, key] of keys.entries()) {
        store.addProject({
          key,
          name: `cru130-synthetic-${String(index)}`,
          type: "backend",
          sutRoot: "/tmp",
        });
      }
      // Every shape the derivation has to tell apart, written through the
      // ordinary path: delivered under the OLD spelling (`releasedAt`),
      // delivered under the new one, targeted only, both, neither — across the
      // built-in types AND a type the server has never heard of.
      for (const [index, key] of keys.entries()) {
        const offset = index * 7 * DAY;
        store.recordMilestoneEvent(key, ORCH, "release", {
          label: `9.7.${String(index)}`,
          commit: `aaa111${String(index)}`,
          releasedAt: SHIPPED_AT + offset,
          crs: ["CR-SHIPPED-1", "CR-SHIPPED-2"],
          context: { cycleId: 400 + index },
        });
        store.recordReleaseProposal(key, ORCH, {
          label: `9.8.${String(index)}`,
          targetAt: PROPOSED_FOR + offset,
        });
        store.recordMilestoneEvent(key, ORCH, "cr-merged", {
          label: `CR-SHIPPED-${String(index)}`,
          commit: `bbb222${String(index)}`,
        });
        store.recordMilestoneEvent(key, ORCH, "custom", {
          label: `both-${String(index)}`,
          targetAt: PROPOSED_FOR + offset,
          deliveredAt: SHIPPED_AT + offset,
        });
        store.recordMilestoneEvent(key, ORCH, "stage-flip", {
          label: `outstanding-${String(index)}`,
          targetAt: PROPOSED_FOR + DAY + offset,
        });
        store.recordMilestoneEvent(key, ORCH, "design-review", { label: `undated-${String(index)}` });
        store.recordMilestoneEvent(key, ORCH, "roadmap-review", {
          label: `project-defined-${String(index)}`,
          deliveredAt: SHIPPED_AT + DAY + offset,
        });
      }
      closeStore(store);

      // AGE THE HISTORY. A store this build wrote spells a release's delivery
      // BOTH ways; a store written before this CR spells it `releasedAt` and
      // nothing else, and that is the shape the migration exists to read. So
      // the release rows are put back into it — the ONE thing a fixture has to
      // do that the production door cannot, because the door no longer writes
      // pre-CR-130 records. `json_remove` touches only that key: every other
      // byte of the blob, and every other column, is exactly what the store
      // wrote, which is what keeps the byte-identity proof below honest.
      const aging = raw(dbPath);
      aging.exec(
        `UPDATE milestones SET payload = json_remove(payload, '$.deliveredAt')
          WHERE type = 'release' AND json_extract(payload, '$.releasedAt') IS NOT NULL`,
      );
      const aged = aging
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM milestones
            WHERE json_extract(payload, '$.releasedAt') IS NOT NULL
              AND json_extract(payload, '$.deliveredAt') IS NULL`,
        )
        .get()!.n;
      aging.close();
      openDbs.splice(openDbs.indexOf(aging), 1);
      // The ageing really produced the pre-CR-130 shape, so the fallback the
      // migration has to apply is really exercised below.
      expect(aged).toBe(keys.length);

      const proof = await proveMigration(dbPath);

      // NON-VACUITY — the population really held both shapes the migration
      // derives from, and the wire walk really compared it.
      const payloads = proof.rowsBefore.map(payloadOf);
      expect(payloads.filter((p) => p.releasedAt !== undefined).length).toBeGreaterThan(0);
      expect(payloads.filter((p) => p.deliveredAt !== undefined).length).toBeGreaterThan(0);
      expect(payloads.filter((p) => p.targetAt !== undefined).length).toBeGreaterThan(0);
      expect(proof.compared).toBe(proof.rowsBefore.length);
      expect(proof.comparedWithDates).toBeGreaterThan(0);
      // …and the undated ones really came back undated: a migration that
      // defaulted to 0 or to the row's timestamp would fail here.
      expect(proof.compared).toBeGreaterThan(proof.comparedWithDates);
    },
  );

  // ── AC — and at REAL scale, against a replica of the live store ──────────

  test(
    "at this project's real population, every record survives the migration byte-identically " +
      "except for the two fields it adds",
    async () => {
      const taken = liveStoreReplica(scratch("cru130-live-replica-"));
      if ("skip" in taken) {
        console.log(`[CR-CRU-130] §S1 real-scale migration NOT RUN: ${taken.skip}`);
        return;
      }

      const proof = await proveMigration(taken.replica);

      // REAL SCALE, and the two shapes the migration derives from are really
      // present. Every expectation is derived from the rows the replica held;
      // no count is pinned, because the live population grows every day.
      const payloads = proof.rowsBefore.map(payloadOf);
      expect(proof.rowsBefore.length).toBeGreaterThan(10);
      expect(payloads.filter((p) => p.releasedAt !== undefined).length).toBeGreaterThan(0);
      expect(payloads.filter((p) => p.targetAt !== undefined).length).toBeGreaterThan(0);
      // The wire walk really compared the population, and really saw rows that
      // GAINED a date (otherwise "nothing changed except the two fields" would
      // be satisfied by a migration that added nothing at all).
      expect(proof.compared).toBeGreaterThan(10);
      expect(proof.comparedWithDates).toBeGreaterThan(0);

      // THE LIVE STORE WAS NEVER WRITTEN.
      const liveAfter = statSync(taken.live);
      expect(liveAfter.size).toBe(taken.sizeBefore);
      expect(liveAfter.mtimeMs).toBe(taken.mtimeBefore);
    },
  );
});
