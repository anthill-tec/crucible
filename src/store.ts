// CR-CRU-001 §S2 — SQLite store on bun:sqlite (C1: projects + agents, C3: events + retention)

import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { DEFAULT_LIVENESS } from "./types.ts";
import type {
  Agent,
  AgentIdentity,
  AgentRole,
  CommitBoundary,
  Coverage,
  CycleKind,
  CycleStatus,
  LivenessConfig,
  Plan,
  PlanCycle,
  Project,
  QueueEntry,
  QueueStatus,
  RunContext,
  RunEvent,
  RunSchema,
  SuiteNode,
  Tier,
} from "./types.ts";

export type Liveness = "online" | "stale" | "tombstoned" | "pruned";

/** Agent as surfaced by listAgents — pruned rows are deleted, never returned. */
export type LiveAgent = Agent & { liveness: Exclude<Liveness, "pruned"> };

/** CR-CRU-012 §S1 — the editable-parameter subset updateProject accepts. */
export interface ProjectPatch {
  name?: string;
  type?: Project["type"];
  sutRoot?: string;
  liveness?: Partial<LivenessConfig>;
  retention?: number;
  /** CR-CRU-008 §S4 — guarded run deletion config gate. */
  allowRunDeletion?: boolean;
}

/**
 * CR-CRU-052 §S1 — per-table row counts removed by deleteProjectCascade.
 * camelCase `planCycles` for the `plan_cycles` table, matching the wire
 * convention (the response returns this object verbatim).
 */
export interface ProjectDeleteCounts {
  events: number;
  agents: number;
  plans: number;
  planCycles: number;
  rollups: number;
}

interface ProjectRow {
  key: string;
  name: string;
  type: string;
  sut_root: string;
  created_at: number;
  liveness: string | null;
  retention: number | null;
  // CR-CRU-012 §S1b — archive timestamp; NULL = live (never deleted).
  archived_at: number | null;
  // CR-CRU-008 §S4 — guarded run deletion config gate; NULL = never set.
  allow_run_deletion: number | null;
}

interface AgentRow {
  project_key: string;
  agent_id: string;
  status: string;
  message: string;
  identity: string;
  first_seen: number;
  last_seen: number;
  // CR-CRU-044 §S1 — NULL for pre-CR-044 rows (retrofitted column).
  role: string | null;
  // CR-CRU-056 §S1 — NULL for unbound / pre-CR-056 rows (retrofitted column).
  bound_cycle_id: number | null;
}

export interface TouchAgentOpts {
  status?: Agent["status"];
  message?: string;
  identity?: AgentIdentity;
  /**
   * CR-CRU-044 §S1(b) — OPTIONAL here on purpose: touchAgent is the ingest
   * path (recordTestEvent et al call it with no options), so the *required*
   * role lives at the register route boundary, never in the store.
   */
  role?: AgentRole;
  /**
   * CR-CRU-056 §S1 — OPTIONAL for the same reason as `role`: validation
   * (cycle exists / plan open / cycle active) lives at the register route
   * boundary; the store only persists an already-validated binding. Omitting
   * it PRESERVES a stored binding (the CR-CRU-044 "touch never blanks"
   * contract, applied to bindings).
   */
  boundCycleId?: number;
}

interface EventRow {
  id: string;
  project_key: string;
  agent_id: string;
  kind: string;
  tier: string;
  stack: string | null;
  codec: string | null;
  timestamp: number;
  name: string | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  pending: number | null;
  duration_ms: number | null;
  tree: string | null;
  coverage: string | null;
  compile: string | null;
  context: string | null;
  // CR-CRU-011 §S1 — lifecycle events only (NULL on test/compile rows).
  action: string | null;
  first_seen: number | null;
  // CR-CRU-013 §S1+§S4b — generic JSON blob for gate/milestone kind-specific
  // fields (the gate object; milestone type/label/commit). NULL otherwise.
  payload: string | null;
  // CR-CRU-057 §S1 — the posting agent's declared role, stamped at write time
  // (retrofitted column; NULL on pre-057 rows and on undeclared writes).
  role: string | null;
  // CR-CRU-057 §S1 — 0 = declared, 1 = §S4 backfill-inferred. NULL when role is.
  role_inferred: number | null;
  // CR-CRU-017 §S0 — RUN lifecycle (never a plan's): the open run's start
  // instant, the SERVER-computed wall-clock runtime, and the run's exceptional
  // terminal state ('aborted'). All three NULL on a single-shot ingest and on
  // every pre-017 row (the §S0 chain step never retrofits history).
  started_at: number | null;
  runtime_ms: number | null;
  status: string | null;
  // CR-CRU-073 §S1 — the release-retirement marker (epoch ms). NULL = a live
  // gate (and NULL on every non-gate row); non-NULL once its release ships.
  retired_at: number | null;
}

/** CR-CRU-017 §S1 — one issued run: `runs` is the OPEN-run store, on disk. */
interface RunRow {
  run_id: string;
  project_key: string;
  agent_id: string;
  started_at: number;
  tier: string | null;
  stack: string | null;
  context: string | null;
  run_state: string;
  settled_at: number | null;
  abort_reason: string | null;
  event_id: string | null;
}

/**
 * CR-CRU-017 §S1 — a run's own lifecycle state. Named for the RUN entity: it
 * is NOT `Plan.status`, whose `"aborted"` means a user-discarded workflow
 * (CR-CRU-024 §S6). A run's `"aborted"` means it ended for non-test reasons.
 */
export type RunState = "open" | "ended" | "aborted";

/** CR-CRU-017 §S1 — an issued run as served by startRun / getRun. */
export interface RunRecord {
  runId: string;
  projectKey: string;
  agentId: string;
  startedAt: number;
  state: RunState;
  tier?: Tier;
  stack?: string;
  context?: RunContext;
  settledAt?: number;
  abortReason?: string;
  /** The event that settled this run (end or abort); absent while open. */
  eventId?: string;
}

interface RollupRow {
  project_key: string;
  bucket: string;
  runs: number;
  passed: number;
  failed: number;
  duration_ms: number;
  last_coverage: string | null;
}

/** §S4 — folded aggregate of expired raw events, one row per (project, bucket). */
export interface Rollup {
  projectKey: string;
  bucket: string;
  runs: number;
  passed: number;
  failed: number;
  duration_ms: number;
  lastCoverage?: Coverage;
}

interface PlanRow {
  plan_id: number;
  project_key: string;
  cr: string;
  title: string | null;
  orchestrator: string | null;
  wave: string | null;
  track: string | null;
  status: string;
  merge_commit: string | null;
  closed_at: number | null;
}

interface PlanCycleRow {
  project_key: string;
  cycle_id: number;
  plan_id: number;
  label: string;
  kind: string;
  status: string;
  // CR-CRU-011 §S0b — transition timestamps (nullable until stamped).
  activated_at: number | null;
  done_at: number | null;
  // CR-CRU-023 §S3 (a) — accumulated active-attention ms, checkpointed at
  // transition writes (0 on activation; sealed on leaving active).
  active_ms_accumulated: number | null;
  // CR-CRU-024 §S3.1 — display-order key (REAL so insert-before can land a
  // cycle strictly between two siblings via a fractional midpoint). Governs
  // cycles[] order AND the §S1 out-of-order guard — cycle_id no longer orders.
  seq: number;
}

/** CR-CRU-014 §S1 — one stored queue_entries row. */
interface QueueEntryRow {
  project_key: string;
  cr: string;
  title: string | null;
  wave: string;
  depends_on_json: string;
  size: string | null;
  filed_at: number;
  seq: number;
}

/** CR-CRU-014 §S1 — a validated queue entry as accepted by replaceQueue. */
export interface QueueEntryInput {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  size?: string;
}

/**
 * CR-CRU-011 §S0 — plan mutation failure. `notFound` distinguishes the 404
 * path (missing plan/cycle) from plain 400 validation; `openCycleIds` carries
 * the non-terminal cycles blocking a close.
 */
export interface PlanOpError {
  error: string;
  notFound?: boolean;
  openCycleIds?: number[];
  /**
   * CR-CRU-048 §S2 — the same blocking cycles as `openCycleIds`, carried with
   * their LABELS so the refusal tells an orchestrator WHAT it forgot, not just
   * a bare numeric id. Additive: `openCycleIds` stays the id-only contract.
   */
  openCycleRefs?: { id: number; label: string }[];
  /**
   * CR-CRU-024 §S4 — discriminator so the route attaches the matching help[]:
   * cross-cycle activation refusals ("out-of-order" / "already-active") and the
   * per-cycle illegal transition. `cycleRef` carries the sibling cycle the help
   * names (the earlier-pending cycle, or the already-active one).
   */
  code?:
    | "out-of-order"
    | "already-active"
    | "illegal-transition"
    | "locked"
    | "immutable-history"
    | "insert-before-active";
  cycleRef?: number;
}

/** CR-CRU-002 §S1 — recordTestEvent's run param adopts the canonical RunSchema. */
export type TestRun = RunSchema;

export interface RecordEventMeta {
  tier?: Tier;
  stack?: string;
  codec?: string;
  name?: string;
  context?: RunContext;
  /**
   * CR-CRU-057 §S1 — the posting agent's DECLARED role, resolved at the route
   * boundary from the agent row CR-CRU-056's ingest seam already fetched. The
   * store never looks a role up and never derives one: passing it stamps
   * `role` + `role_inferred = 0`; omitting it leaves both NULL.
   */
  role?: AgentRole;
  /**
   * CR-CRU-017 §S1 — the RUN lifecycle this event CLOSES: the open run's start
   * instant and the server-computed wall-clock runtime. Present only when the
   * ingest carried a `runId`; omitting it stores NULL in both columns, which is
   * the graceful-degradation path (a single-shot ingest is unchanged).
   */
  lifecycle?: { startedAt: number; runtimeMs: number };
}

export type ChangeKind = "projects" | "agents" | "events";
export type ChangeListener = (kind: ChangeKind, projectKey?: string) => void;

/** §S4 — default raw-event retention cap per project. */
const DEFAULT_RETENTION = 100;

/**
 * CR-CRU-017 §S1 — how long an OPEN run may live before the sweep abandons it.
 * Read per sweep, not cached: the deadline is operational configuration, and a
 * long-lived process must see a change without a restart.
 */
const DEFAULT_RUN_ABANDON_MS = 30 * 60_000;

function runAbandonAfterMs(): number {
  const raw = Number(process.env.CRUCIBLE_RUN_ABANDON_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUN_ABANDON_MS;
}

/** CR-CRU-002 §S4 — project keys are UUIDs; ingest routes validate against this. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ===========================================================================
// 🚨 THE ONLY AGENT-ID PARSE IN THE CODEBASE — MIGRATION ONLY, NEVER RUNTIME
// ===========================================================================
// CR-CRU-057 §S4 — this is a ONE-TIME MIGRATION parse, and the ONLY place in
// Crucible that may ever derive meaning from the SHAPE of an agent id.
//
// §S3 DELETED render-time parsing outright (the retired CR-CRU-007 name-role
// helper and every caller are gone from src/, public/ and cli/ — an AC greps
// for its name, which is why it is not spelled out here). Role is
// DECLARED data: agents declare it at registration and every new event stamps
// the declared value with `role_inferred = 0`. Nothing downstream is allowed
// to guess a role from a name, ever.
//
// This function exists solely to give pre-057 history — rows the §S1 ALTER
// created with a NULL role, written before the declaration existed — a
// best-effort, VISIBLY LABELED (`role_inferred = 1`) classification. It runs
// inside `migrate()` against `role IS NULL` rows and nowhere else.
//
// DO NOT: export it, call it from a request/ingest/render path, reuse it to
// "fix up" a row whose declaration is missing, or lift it into public/. If a
// new caller seems to need it, the answer is a DECLARED role, not a parse.
//
// The rules mirror the retired CR-CRU-007 name-role helper's suffix contract
// exactly: a trailing `-RED`/`-GREEN`/`-FIX`/`-VERIFY`, case-insensitive.
// Its documented negative cases stay negative — `redteam-agent`,
// `greenhouse-bot`, `fixture-agent`, `unverified-agent`, `verifying-agent`,
// `plain-agent-1` and `claude-sandesh` all parse to null (the token must be a
// trailing suffix, never a mid-word substring), so they keep a NULL role and
// render unclassified rather than carrying a fabricated guess.
const MIGRATION_ONLY_ROLE_SUFFIX_RE = /-(red|green|fix|verify)$/i;

function migrationOnlyRoleFromAgentIdSuffix(agentId: string): AgentRole | null {
  const match = MIGRATION_ONLY_ROLE_SUFFIX_RE.exec(agentId);
  if (match === null) return null;
  return match[1]!.toUpperCase() as AgentRole;
}

// ===========================================================================
// CR-CRU-071 §S1 — the VERSIONED migration chain
// ===========================================================================
// Every retrofit the pre-071 boot fired ad hoc now lives in one NUMBERED,
// TRANSACTED step, and `PRAGMA user_version` is stamped by the very
// transaction that earns it — so a store is never left at a version whose
// structure is absent (AC1), and this build can REFUSE a store written by a
// newer one (AC5) instead of writing to a schema it does not understand.
//
// 🚨 THE ORDER OF THIS ARRAY IS LOAD-BEARING, and so is the order INSIDE each
// step. `ALTER TABLE events RENAME COLUMN phase TO role` MUST run before the
// additive `ADD COLUMN role`: swap them and the rename is skipped, a fresh
// empty column shadows CR-CRU-057's backfilled values, and the §S4 backfill
// then re-derives them from the agent-id suffix — exactly the orphaning
// CR-CRU-059 §S0 forbids.
//
// ONE STEP PER TABLE BLOCK, in the pre-071 pass's own order: each block was a
// single `PRAGMA table_info` snapshot that the pass MUTATED mid-pass as its
// renames landed (`eventCols.delete("phase"); eventCols.add("role")`), and
// each step below keeps that snapshot and that mutation verbatim. A block is
// also the right atomic unit: a retrofit that throws rolls back its whole
// block instead of leaving half a table and a version that lies about it
// (AC7).

export interface MigrationStep {
  /** Version this step upgrades FROM ... */
  readonly from: number;
  /** ... and TO (always `from + 1`). */
  readonly to: number;
  readonly description?: string;
  /** Runs inside ONE transaction that also stamps `to` into user_version. */
  apply(db: Database): void;
  /**
   * AC2 — "is this retrofit already in the file?". Used ONLY to baseline a
   * pre-071 store (user_version = 0), which carries no version to trust. A
   * step WITHOUT this probe is never assumed applied, so an injected chain
   * always runs from the beginning.
   */
  satisfiedBy?(db: Database): boolean;
}

/** CR-CRU-071 §S1 — what one boot actually migrated. */
export interface StoreMigration {
  from: number;
  to: number;
  /** The `<path>.pre-upgrade-<epoch>` recovery point; null for `:memory:`. */
  backupPath: string | null;
}

export interface StoreOpenOpts {
  /**
   * CR-CRU-071 §S1 — REPLACES the default `MIGRATIONS` chain for this open.
   * The failure-injection seam (AC7): production callers, the server boot
   * included, always use the one-argument form.
   */
  migrations?: readonly MigrationStep[];
}

/**
 * CR-CRU-071 AC5 — the store is from the future. A NARROW, deliberate
 * exception to §S5's "boot must never fail because of a bad file": this file
 * is not bad, it is NEWER, and quarantining it would rename the user's live
 * data aside and boot empty. `Store.open` rethrows this instead.
 */
export class StoreVersionTooNewError extends Error {}

/** CR-CRU-071 AC7 — a migration step threw; its transaction was rolled back. */
export class StoreMigrationFailedError extends Error {}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table);
  return (row?.n ?? 0) > 0;
}

/** The pre-071 pass's per-block `PRAGMA table_info` snapshot, verbatim. */
function columnsOf(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((col) => col.name),
  );
}

/** True for a file that holds no schema at all — a brand-new or `:memory:` db. */
function hasSchemaObjects(db: Database): boolean {
  const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM sqlite_master`).get();
  return (row?.n ?? 0) > 0;
}

function readUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version ?? 0;
}

/** Interpolated, not bound: sqlite never parameterizes a PRAGMA value. */
function stampUserVersion(db: Database, version: number): void {
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/**
 * The rows CR-CRU-057 §S4's backfill still has work for: `role IS NULL` AND an
 * agent id whose suffix parses. Empty means the backfill is DONE — which is
 * also how a pre-071 store proves that retrofit is already applied (AC2), so
 * baselining the live store never re-derives a single role.
 */
function pendingInferredEventRoles(db: Database): { id: string; role: AgentRole }[] {
  return db
    .query<{ id: string; agent_id: string }, []>(
      `SELECT id, agent_id FROM events WHERE role IS NULL`,
    )
    .all()
    .flatMap((row) => {
      const role = migrationOnlyRoleFromAgentIdSuffix(row.agent_id);
      // Unparseable ids stay NULL — no guessing, ever (§S4).
      return role === null ? [] : [{ id: row.id, role }];
    });
}

/**
 * CR-CRU-057 §S4 — the ONE-TIME LABELED backfill of `events.role` for
 * pre-057 history (user-decided 2026-08-01). CR-CRU-071 §S1 keeps it in the
 * SAME VERSION as the §S1 ALTER it populates, inside that step's transaction,
 * so a store can never stop between the column and the data. It runs nowhere
 * else, and never opens a transaction of its own.
 *
 * ADDITIVE: the `role IS NULL` predicate is the whole safety story. A row
 * whose agent DECLARED a role was written with a non-NULL `role` and
 * `role_inferred = 0` (the single event write path, `insertEvent`, always
 * writes the two columns together), so a declared row is invisible to this
 * UPDATE and can never be re-derived or flipped from its id's shape.
 *
 * IDEMPOTENT BY CONSTRUCTION: every row it touches leaves with a non-NULL
 * `role`, so a later scan no longer sees it — no "has it run" flag needed, and
 * `role_inferred` is SET to 1, never incremented. Rows whose id does not parse
 * are left NULL in BOTH columns (never 0 — that would read as "declared
 * nothing" rather than "never classified") and render unclassified, which is
 * also why re-running is harmless: they are simply re-examined and re-skipped.
 *
 * 🚨 The id parse it uses is migration-only — see the banner on
 * `migrationOnlyRoleFromAgentIdSuffix`. It must never reach a runtime path.
 */
function backfillInferredEventRoles(db: Database): void {
  const pending = pendingInferredEventRoles(db);
  if (pending.length === 0) return;
  const update = db.query<never, [string, string]>(
    `UPDATE events SET role = ?, role_inferred = 1 WHERE id = ? AND role IS NULL`,
  );
  for (const row of pending) {
    update.run(row.role, row.id);
  }
}

type MigrationBody = Omit<MigrationStep, "from" | "to">;

// A step whose table does not exist yet has NOTHING to retrofit: the base
// `CREATE TABLE IF NOT EXISTS` pass writes every table in its CURRENT shape,
// which is precisely why the pre-071 retrofits only ever fired for tables an
// older binary had already created.
const MIGRATION_BODIES: readonly MigrationBody[] = [
  {
    description:
      "events: CR-011 action/first_seen, CR-013 payload, CR-059 phase->role RENAME, CR-057 role columns + §S4 labeled backfill",
    apply(db) {
      if (!tableExists(db, "events")) return;
      // CR-CRU-011 §S1 — additive columns for lifecycle events; pre-011 db
      // files lack them (CREATE TABLE IF NOT EXISTS never retrofits columns).
      const eventCols = columnsOf(db, "events");
      if (!eventCols.has("action")) {
        db.exec(`ALTER TABLE events ADD COLUMN action TEXT`);
      }
      if (!eventCols.has("first_seen")) {
        db.exec(`ALTER TABLE events ADD COLUMN first_seen INTEGER`);
      }
      // CR-CRU-013 §S1+§S4b — additive generic payload column for gate/milestone
      // kind-specific fields; pre-013 db files lack it (same PRAGMA-checked
      // retrofit pattern as action/first_seen above).
      if (!eventCols.has("payload")) {
        db.exec(`ALTER TABLE events ADD COLUMN payload TEXT`);
      }
      // CR-CRU-059 §S0 — RENAME, never re-create. Every db written before that
      // CR carries the declared-role classification under the OLD column names
      // `phase`/`phase_inferred` — including CR-CRU-057's backfill (299 of 338
      // events on the live dog-food db). Adding fresh `role` columns and
      // leaving the old ones behind would silently orphan all of it, so the
      // columns are RENAMED IN PLACE (sqlite 3.25+), which moves every value
      // untouched. 🚨 BEFORE the additive add below, and the snapshot is
      // mutated so that add sees the renamed column, not a stale absence.
      if (eventCols.has("phase") && !eventCols.has("role")) {
        db.exec(`ALTER TABLE events RENAME COLUMN phase TO role`);
        eventCols.delete("phase");
        eventCols.add("role");
      }
      if (eventCols.has("phase_inferred") && !eventCols.has("role_inferred")) {
        db.exec(`ALTER TABLE events RENAME COLUMN phase_inferred TO role_inferred`);
        eventCols.delete("phase_inferred");
        eventCols.add("role_inferred");
      }
      // CR-CRU-057 §S1 — additive declared-role columns; pre-057 db files lack
      // them. The ALTER itself back-fills nothing — every historical row starts
      // NULL; §S4's labeled backfill below then classifies the subset whose id
      // suffix parses.
      if (!eventCols.has("role")) {
        db.exec(`ALTER TABLE events ADD COLUMN role TEXT`);
      }
      if (!eventCols.has("role_inferred")) {
        db.exec(`ALTER TABLE events ADD COLUMN role_inferred INTEGER`);
      }
      backfillInferredEventRoles(db);
    },
    satisfiedBy(db) {
      if (!tableExists(db, "events")) return true;
      const cols = columnsOf(db, "events");
      return (
        cols.has("action") &&
        cols.has("first_seen") &&
        cols.has("payload") &&
        cols.has("role") &&
        cols.has("role_inferred") &&
        !cols.has("phase") &&
        !cols.has("phase_inferred") &&
        // The §S4 data half of this version, not just its columns.
        pendingInferredEventRoles(db).length === 0
      );
    },
  },
  {
    description:
      "plan_cycles: CR-011 activated_at/done_at, CR-023 active_ms_accumulated, CR-024 seq + order-preserving backfill",
    apply(db) {
      if (!tableExists(db, "plan_cycles")) return;
      // CR-CRU-011 §S0b — additive cycle-timestamp columns; pre-C4 db files
      // lack them (same PRAGMA-checked retrofit pattern as events above).
      const cycleCols = columnsOf(db, "plan_cycles");
      if (!cycleCols.has("activated_at")) {
        db.exec(`ALTER TABLE plan_cycles ADD COLUMN activated_at INTEGER`);
      }
      if (!cycleCols.has("done_at")) {
        db.exec(`ALTER TABLE plan_cycles ADD COLUMN done_at INTEGER`);
      }
      // CR-CRU-023 §S3 (a) — additive accumulated-attention column; pre-023
      // db files lack it (same PRAGMA-checked retrofit pattern as above).
      if (!cycleCols.has("active_ms_accumulated")) {
        db.exec(`ALTER TABLE plan_cycles ADD COLUMN active_ms_accumulated INTEGER`);
      }
      // CR-CRU-024 §S3.1 — additive display-order column; pre-024 db files lack
      // it. Order-preserving backfill: seq = cycle_id for existing rows so
      // pre-insert-before plans keep their historical (cycle_id-ascending)
      // display order unchanged. Same version as the ALTER, so no store can
      // stop between the column and the values it needs.
      if (!cycleCols.has("seq")) {
        db.exec(`ALTER TABLE plan_cycles ADD COLUMN seq REAL`);
        db.exec(`UPDATE plan_cycles SET seq = cycle_id WHERE seq IS NULL`);
      }
    },
    satisfiedBy(db) {
      if (!tableExists(db, "plan_cycles")) return true;
      const cols = columnsOf(db, "plan_cycles");
      return (
        cols.has("activated_at") &&
        cols.has("done_at") &&
        cols.has("active_ms_accumulated") &&
        cols.has("seq")
      );
    },
  },
  {
    description: "plans: CR-021 §S6.11 title, CR-021 §S6 re-baseline orchestrator",
    apply(db) {
      if (!tableExists(db, "plans")) return;
      // CR-CRU-021 §S6.11 — additive plan title column; pre-021 db files lack
      // it (same PRAGMA-checked retrofit pattern as events/plan_cycles above).
      const planCols = columnsOf(db, "plans");
      if (!planCols.has("title")) {
        db.exec(`ALTER TABLE plans ADD COLUMN title TEXT`);
      }
      // CR-CRU-021 §S6 re-baseline (cycle 19) — additive plan orchestrator
      // column; pre-cycle-19 db files lack it (same PRAGMA-checked pattern).
      if (!planCols.has("orchestrator")) {
        db.exec(`ALTER TABLE plans ADD COLUMN orchestrator TEXT`);
      }
    },
    satisfiedBy(db) {
      if (!tableExists(db, "plans")) return true;
      const cols = columnsOf(db, "plans");
      return cols.has("title") && cols.has("orchestrator");
    },
  },
  {
    description: "projects: CR-012 §S1b archived_at, CR-008 §S4 allow_run_deletion",
    apply(db) {
      if (!tableExists(db, "projects")) return;
      // CR-CRU-012 §S1b — additive archive-timestamp column; pre-012 db files
      // lack it (same PRAGMA-checked retrofit pattern as above).
      const projectCols = columnsOf(db, "projects");
      if (!projectCols.has("archived_at")) {
        db.exec(`ALTER TABLE projects ADD COLUMN archived_at INTEGER`);
      }
      // CR-CRU-008 §S4 — additive guarded-deletion config column; pre-008 db
      // files lack it (same PRAGMA-checked retrofit pattern as above).
      if (!projectCols.has("allow_run_deletion")) {
        db.exec(`ALTER TABLE projects ADD COLUMN allow_run_deletion INTEGER`);
      }
    },
    satisfiedBy(db) {
      if (!tableExists(db, "projects")) return true;
      const cols = columnsOf(db, "projects");
      return cols.has("archived_at") && cols.has("allow_run_deletion");
    },
  },
  {
    description: "agents: CR-059 phase->role RENAME, CR-044 role, CR-056 bound_cycle_id",
    apply(db) {
      if (!tableExists(db, "agents")) return;
      const agentCols = columnsOf(db, "agents");
      // CR-CRU-059 §S0 — same RENAME-don't-re-create rule as events above: a
      // pre-059 db stores the declared role under `agents.phase`, and that
      // value is the agent's live classification. Rename it in place, then the
      // additive guard below sees `role` and does nothing.
      if (agentCols.has("phase") && !agentCols.has("role")) {
        db.exec(`ALTER TABLE agents RENAME COLUMN phase TO role`);
        agentCols.delete("phase");
        agentCols.add("role");
      }
      // CR-CRU-044 §S1(d) — additive declared-role column; pre-044 db files
      // lack it. No back-fill: historical rows keep a NULL role and read back
      // as absent.
      if (!agentCols.has("role")) {
        db.exec(`ALTER TABLE agents ADD COLUMN role TEXT`);
      }
      // CR-CRU-056 §S1 — additive cycle-binding column; pre-056 db files lack
      // it. No back-fill: historical rows keep a NULL binding.
      if (!agentCols.has("bound_cycle_id")) {
        db.exec(`ALTER TABLE agents ADD COLUMN bound_cycle_id INTEGER`);
      }
    },
    satisfiedBy(db) {
      if (!tableExists(db, "agents")) return true;
      const cols = columnsOf(db, "agents");
      return cols.has("role") && cols.has("bound_cycle_id") && !cols.has("phase");
    },
  },
  {
    description:
      "events: CR-017 §S0 run lifecycle — started_at / runtime_ms / status (RUN status, not a plan's)",
    apply(db) {
      if (!tableExists(db, "events")) return;
      // CR-CRU-017 §S0 — additive RUN-lifecycle columns; pre-017 db files lack
      // them. Purely structural: history is NOT retrofitted (the CR's non-goal),
      // so every existing row reads NULL for all three and keeps its
      // tool-reported duration_ms untouched.
      const eventCols = columnsOf(db, "events");
      if (!eventCols.has("started_at")) {
        db.exec(`ALTER TABLE events ADD COLUMN started_at INTEGER`);
      }
      if (!eventCols.has("runtime_ms")) {
        db.exec(`ALTER TABLE events ADD COLUMN runtime_ms INTEGER`);
      }
      if (!eventCols.has("status")) {
        db.exec(`ALTER TABLE events ADD COLUMN status TEXT`);
      }
    },
    satisfiedBy(db) {
      if (!tableExists(db, "events")) return true;
      const cols = columnsOf(db, "events");
      return cols.has("started_at") && cols.has("runtime_ms") && cols.has("status");
    },
  },
  {
    description:
      "events: CR-073 §S1 retired_at — release-retirement marker + one-time stamp of pre-column gates",
    apply(db) {
      if (!tableExists(db, "events")) return;
      // CR-CRU-073 §S1 — additive nullable marker; pre-073 db files lack it
      // (same PRAGMA-checked retrofit pattern as the columns above).
      const eventCols = columnsOf(db, "events");
      if (!eventCols.has("retired_at")) {
        db.exec(`ALTER TABLE events ADD COLUMN retired_at INTEGER`);
      }
      // The SAME step retires every gate that predates the column (the
      // versionless strays): a gate written before the marker existed can
      // never gain one from a future release (its version was never stored),
      // so it is stamped once here. Idempotent (only NULL rows) and lossless
      // (an UPDATE, never an insert/delete).
      db.query(`UPDATE events SET retired_at = ? WHERE kind = 'gate' AND retired_at IS NULL`).run(
        Date.now(),
      );
    },
    satisfiedBy(db) {
      if (!tableExists(db, "events")) return true;
      const cols = columnsOf(db, "events");
      if (!cols.has("retired_at")) return false;
      // The data half: no pre-column (live) gate may remain once this step ran.
      const pending = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM events WHERE kind = 'gate' AND retired_at IS NULL`,
        )
        .get()!.n;
      return pending === 0;
    },
  },
];

/** CR-CRU-071 §S1 — the ordered chain; positions ARE the version numbers. */
export const MIGRATIONS: readonly MigrationStep[] = MIGRATION_BODIES.map((body, index) => ({
  ...body,
  from: index,
  to: index + 1,
}));

/** The schema version THIS build writes — the end of the chain, by construction. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * CR-CRU-071 AC2 — a store at user_version 0 predates versioning entirely (the
 * live 9.2 MB dog-food db included), so its version cannot be read; it is
 * INSPECTED ONCE and matched to the schema it actually has. Every leading step
 * whose retrofit is demonstrably already in the file is skipped, so baselining
 * moves no data and re-runs no applied retrofit — it only stamps the truth.
 */
function baselineVersion(db: Database, chain: readonly MigrationStep[], from: number): number {
  let at = from;
  for (const step of chain) {
    if (step.from !== at) break;
    if (step.satisfiedBy?.(db) !== true) break;
    at = step.to;
  }
  return at;
}

/**
 * CR-CRU-071 AC4 — the recovery point, `<path>.pre-upgrade-<epoch>`, extending
 * §S5's `<path>.<kind>-<epoch>` convention (`<path>.corrupt-<epoch>`).
 *
 * VACUUM INTO, never a file copy: the store runs in WAL mode, so copying the
 * main file alone can land torn or stale (the committed tail lives in `-wal`).
 * VACUUM INTO reads ONE consistent snapshot through the pager and preserves
 * `user_version`, so the copy restores as the exact pre-migration store.
 */
function writePreUpgradeBackup(db: Database, dbPath: string): string {
  const backupPath = `${dbPath}.pre-upgrade-${Date.now()}`;
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  return backupPath;
}

export class Store {
  private readonly db: Database;
  /**
   * CR-CRU-071 §S1 — `PRAGMA user_version` as this open left it: the schema
   * version this store IS, not the one the code hopes for.
   */
  readonly schemaVersion: number;
  /** CR-CRU-071 §S1 — what THIS open migrated; null when nothing did. */
  readonly migration: StoreMigration | null;
  /** Monotonic per-store sequence for event ids. */
  private seq = 0;
  private readonly listeners = new Set<ChangeListener>();
  /**
   * CR-CRU-023 §S3 (a) — per-Store boot anchor: the live attention epoch of
   * an active cycle starts at max(activatedAt, bootedAt), so time the
   * service spent DOWN is never counted as attention.
   */
  private readonly bootedAt: number;
  /**
   * CR-CRU-023 §S3 (a) — durable mid-epoch checkpoints: a hard crash while a
   * cycle is ACTIVE may lose at most one <=60s window of attention time, so
   * `active_ms_accumulated` is checkpointed on cycle reads (toPlan) whenever
   * the live epoch exceeds this cadence — not only on the transition out of
   * `active`.
   */
  private static readonly ACTIVE_MS_CHECKPOINT_CADENCE_MS = 60_000;
  /**
   * In-memory epoch re-anchor per active cycle (keyed `${projectKey}:${cycleId}`):
   * a checkpoint write folds the live epoch into the persisted accumulated
   * value and moves the epoch start to the persist moment, so later reads and
   * the terminal transition never double-count. Deliberately NOT persisted —
   * on restart `bootedAt` re-anchors the epoch, which is what excludes
   * downtime.
   */
  private readonly epochCheckpointAt = new Map<string, number>();

  constructor(path: string, opts?: StoreOpenOpts) {
    this.bootedAt = Date.now();
    this.db = new Database(path, { create: true });
    // §S5 — bun:sqlite may defer an open failure past `new Database`; force it
    // NOW, before anything is written, so a genuinely unreadable file still
    // reaches open()'s quarantine path.
    this.db.query("PRAGMA schema_version").get();
    const chain = opts?.migrations ?? MIGRATIONS;
    const found = readUserVersion(this.db);
    // CR-CRU-071 AC5 — AFTER the corruption probe, BEFORE the chain and before
    // ANY write: a store from the future is REFUSED, untouched. The db is left
    // open on purpose — closing the last connection to a WAL store would
    // checkpoint it and mutate the very file we promised not to touch.
    if (found > SCHEMA_VERSION) {
      throw new StoreVersionTooNewError(
        `[crucible] REFUSING TO OPEN ${path}: the store is at schema version ${found}, but this ` +
          `build only understands version ${SCHEMA_VERSION} — a newer Crucible wrote it. Nothing ` +
          `was touched: no quarantine, no fresh db, no write. Remedy: upgrade this Crucible to ` +
          `the build that speaks version ${found}, or restore that build's ` +
          `<store>.pre-upgrade-<epoch> backup and re-run this one.`,
      );
    }
    const target = chain.length === 0 ? found : chain[chain.length - 1]!.to;
    if (!hasSchemaObjects(this.db)) {
      if (path !== ":memory:") {
        // WAL is adopted when Crucible CREATES the store. A store it did NOT
        // create keeps the journal mode its writer chose: switching that needs
        // exclusive access to a db someone else may be reading, it rewrites the
        // file header, and CR-CRU-071's refusal (AC5) and failure (AC7) paths
        // promise a byte-identical file.
        this.db.exec("PRAGMA journal_mode = WAL;");
      }
      // A brand-new store (or `:memory:`): the base schema IS `target`, so it
      // is created and stamped in ONE transaction (AC1). Nothing was migrated
      // and there is nothing to recover, so no backup and no report.
      const create = this.db.transaction(() => {
        this.createBaseTables();
        stampUserVersion(this.db, target);
      });
      create();
      this.migration = null;
    } else {
      this.migration = found < target ? this.migrateTo(path, chain, found, target) : null;
      // AFTER the chain, never before: a step that throws must leave the file
      // byte-identical (AC7). Tables a legacy store never had are written here
      // in their CURRENT shape, which is exactly why no retrofit fires for
      // them — and it always runs, so a crash between the last step and here
      // self-heals on the next open.
      this.createBaseTables();
    }
    this.schemaVersion = readUserVersion(this.db);
  }

  /**
   * §S5 boot safety — open a store at `path`, surviving a corrupt/unreadable db.
   * A bad file is renamed aside to `<path>.corrupt-<epoch>` and a fresh db is
   * opened at the original path. Boot must never fail because of a bad file.
   *
   * CR-CRU-071 §S1 — `opts.migrations` REPLACES the default chain for this open
   * (the AC7 failure-injection seam); production callers omit it.
   */
  static open(path: string, opts?: StoreOpenOpts): Store {
    try {
      return new Store(path, opts);
    } catch (error) {
      // CR-CRU-071 AC5/AC7 — a READABLE store this build must not write is a
      // REFUSAL, not a corruption: quarantining it would rename the user's live
      // data aside and boot empty. Only an unreadable file takes the §S5 path.
      if (error instanceof StoreVersionTooNewError || error instanceof StoreMigrationFailedError) {
        throw error;
      }
      const corruptPath = `${path}.corrupt-${Date.now()}`;
      console.error(
        `[crucible] CORRUPT DATABASE at ${path} — moving it aside to ${corruptPath} and starting with a fresh db (${String(error)})`,
      );
      renameSync(path, corruptPath);
      return new Store(path);
    }
  }

  /**
   * CR-CRU-071 §S1 — run the chain, one transaction per version, each stamping
   * the version it earned (AC1). A recovery point is written BEFORE the first
   * migrating write (AC4); a step that throws rolls its own transaction back,
   * leaves user_version at the last committed value, and aborts the boot with
   * an error naming that recovery point (AC7).
   */
  private migrateTo(
    path: string,
    chain: readonly MigrationStep[],
    found: number,
    target: number,
  ): StoreMigration {
    // `resume` is where the CHAIN restarts: for an unstamped store that is
    // already structurally current, that is its baselined version, so no
    // applied retrofit re-runs (AC2).
    const resume = found === 0 ? baselineVersion(this.db, chain, found) : found;
    const backupPath = path === ":memory:" ? null : writePreUpgradeBackup(this.db, path);
    for (const step of chain) {
      if (step.from < resume) continue;
      const run = this.db.transaction(() => {
        step.apply(this.db);
        stampUserVersion(this.db, step.to);
      });
      try {
        run();
      } catch (error) {
        throw new StoreMigrationFailedError(
          `[crucible] MIGRATION FAILED on ${path}: step ${step.from} -> ${step.to}` +
            `${step.description === undefined ? "" : ` (${step.description})`} threw, so its ` +
            `transaction was rolled back and the store still reads schema version ` +
            `${readUserVersion(this.db)}. It was NOT quarantined and NOT left half-migrated. ` +
            (backupPath === null
              ? `(in-memory store: no backup was needed.) `
              : `Restore the pre-upgrade backup at ${backupPath} if this store looks wrong. `) +
            `Cause: ${String(error)}`,
        );
      }
    }
    if (readUserVersion(this.db) !== target) {
      // A baseline with nothing left to apply still has to be STAMPED (AC2).
      const stamp = this.db.transaction(() => {
        stampUserVersion(this.db, target);
      });
      stamp();
    }
    // `from` is the version the store REPORTED before this open, not where the
    // chain resumed. A baseline moved user_version 0 -> target, so reporting
    // `resume` here printed the nonsense "migrated store schema v5 -> v5";
    // reporting the previous stamp keeps `from < to` true for every migrating
    // open and makes the disclosure (AC6) honest.
    return { from: found, to: target, backupPath };
  }

  /**
   * The base schema in its CURRENT shape. Every table here is created whole —
   * the numbered retrofits in `MIGRATIONS` exist only for tables an OLDER
   * binary already created, which is why this pass may safely run after them.
   */
  private createBaseTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
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

      CREATE TABLE IF NOT EXISTS agents (
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

      CREATE TABLE IF NOT EXISTS events (
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
        role TEXT,
        role_inferred INTEGER,
        -- CR-CRU-017 §S0 — the RUN-lifecycle trio, in the base schema so a
        -- brand-new store and the end of the chain agree.
        started_at INTEGER,
        runtime_ms INTEGER,
        status TEXT,
        -- CR-CRU-073 §S1 — the release-retirement marker, in the base schema
        -- so a brand-new store and the end of the chain agree.
        retired_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_events_project_timestamp
        ON events (project_key, timestamp);

      -- CR-CRU-017 §S1 — OPEN and settled RUNS. A new table, never a retrofit:
      -- the base pass creates it whole for every store, old or new (which is
      -- why the §S0 chain step only touches the events table).
      --
      -- One row per issued runId, kept AFTER the run settles (run_state
      -- 'open' -> 'ended' | 'aborted') so the server can tell an unknown runId
      -- (400) from a re-close of a settled one (409) — the CR's end/end and
      -- end-after-abort race. run_state is spelled for the RUN entity: it is
      -- not, and never maps onto, plans.status.
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        tier TEXT,
        stack TEXT,
        context TEXT,
        run_state TEXT NOT NULL,
        settled_at INTEGER,
        abort_reason TEXT,
        event_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_open
        ON runs (run_state, started_at);

      CREATE TABLE IF NOT EXISTS rollups (
        project_key TEXT NOT NULL,
        bucket TEXT NOT NULL,
        runs INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        last_coverage TEXT,
        PRIMARY KEY (project_key, bucket)
      );

      CREATE TABLE IF NOT EXISTS plans (
        plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_key TEXT NOT NULL,
        cr TEXT NOT NULL,
        title TEXT,
        orchestrator TEXT,
        wave TEXT,
        track TEXT,
        status TEXT NOT NULL,
        merge_commit TEXT,
        closed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_plans_project_cr
        ON plans (project_key, cr);

      CREATE TABLE IF NOT EXISTS plan_cycles (
        project_key TEXT NOT NULL,
        cycle_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        activated_at INTEGER,
        done_at INTEGER,
        active_ms_accumulated INTEGER,
        seq REAL,
        PRIMARY KEY (project_key, cycle_id)
      );

      -- CR-CRU-014 §S1 — the CR execution queue (project roadmap). ADDITIVE
      -- (CREATE TABLE IF NOT EXISTS, no migration chain step): SCHEMA_VERSION
      -- stays 7. A full-replace POST rewrites a project's rows wholesale, so
      -- (project_key, cr) is the natural key; seq preserves post order for a
      -- stable read; depends_on_json holds the verbatim CR-id string list.
      CREATE TABLE IF NOT EXISTS queue_entries (
        project_key TEXT NOT NULL,
        cr TEXT NOT NULL,
        title TEXT,
        wave TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        size TEXT,
        filed_at INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (project_key, cr)
      );
    `);
  }

  /**
   * CR-CRU-012 §S1b — the archived-project exclusion every hot listing query
   * appends: rows belonging to an archived project (archived_at IS NOT NULL)
   * are filtered out; the rows themselves are never deleted.
   */
  private static readonly NOT_ARCHIVED_SUBQUERY =
    `project_key NOT IN (SELECT key FROM projects WHERE archived_at IS NOT NULL)`;

  // ── Projects ──────────────────────────────────────────────────────────

  addProject(project: Omit<Project, "createdAt">): Project {
    const stored: Project = {
      key: project.key,
      name: project.name,
      type: project.type ?? "backend",
      sutRoot: project.sutRoot,
      createdAt: Date.now(),
      ...(project.liveness !== undefined ? { liveness: project.liveness } : {}),
      ...(project.retention !== undefined ? { retention: project.retention } : {}),
    };
    this.db
      .query(
        `INSERT INTO projects (key, name, type, sut_root, created_at, liveness, retention)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.key,
        stored.name,
        stored.type,
        stored.sutRoot,
        stored.createdAt,
        stored.liveness !== undefined ? JSON.stringify(stored.liveness) : null,
        stored.retention ?? null,
      );
    this.emit("projects", stored.key);
    return stored;
  }

  getProject(key: string): Project | null {
    const row = this.db
      .query<ProjectRow, [string]>(`SELECT * FROM projects WHERE key = ?`)
      .get(key);
    return row ? Store.toProject(row) : null;
  }

  /**
   * CR-CRU-012 §S1b — the DEFAULT listing excludes archived projects;
   * `archived: true` is the manager-only view listing ONLY archived ones.
   */
  listProjects(archived = false): Project[] {
    const rows = this.db
      .query<ProjectRow, []>(
        `SELECT * FROM projects
         WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"}
         ORDER BY created_at ASC`,
      )
      .all();
    return rows.map(Store.toProject);
  }

  /** CR-CRU-012 §S1b — is the project currently archived? (false if unknown). */
  isArchived(key: string): boolean {
    const row = this.db
      .query<{ archived_at: number | null }, [string]>(
        `SELECT archived_at FROM projects WHERE key = ?`,
      )
      .get(key);
    return row !== null && row.archived_at !== null;
  }

  /**
   * CR-CRU-012 §S1b — archive a project (sets archived_at; records are never
   * deleted). Idempotent: returns whether the state actually changed.
   */
  archiveProject(key: string): boolean {
    const result = this.db
      .query(`UPDATE projects SET archived_at = ? WHERE key = ? AND archived_at IS NULL`)
      .run(Date.now(), key);
    if (result.changes > 0) {
      this.emit("projects", key);
      return true;
    }
    return false;
  }

  /**
   * CR-CRU-012 §S1 — apply a PATCH of editable project parameters in ONE
   * UPDATE. `liveness` is a PARTIAL override MERGED over any existing stored
   * partial (a t1-only patch never blows away a stored t2/t3 override, and
   * unspecified thresholds keep falling through to DEFAULT_LIVENESS in
   * livenessConfig). Returns whether anything actually changed — an identical
   * patch is a no-op with no row churn and no SSE emit. Retention is
   * non-retroactive by design: enforcement runs on the NEXT ingest
   * (recordTestEvent → enforceRetention), never here.
   */
  updateProject(key: string, patch: ProjectPatch): boolean {
    const existing = this.getProject(key);
    if (existing === null) return false;
    const nextLiveness =
      patch.liveness !== undefined
        ? { ...existing.liveness, ...patch.liveness }
        : existing.liveness;
    const existingAllow =
      existing.allowRunDeletion !== undefined ? (existing.allowRunDeletion ? 1 : 0) : null;
    const next = {
      name: patch.name ?? existing.name,
      type: patch.type ?? existing.type,
      sutRoot: patch.sutRoot ?? existing.sutRoot,
      livenessJson: nextLiveness !== undefined ? JSON.stringify(nextLiveness) : null,
      retention: patch.retention ?? existing.retention ?? null,
      // CR-CRU-008 §S4 — guarded-deletion config gate (1/0; NULL = never set).
      allowRunDeletion:
        patch.allowRunDeletion !== undefined ? (patch.allowRunDeletion ? 1 : 0) : existingAllow,
    };
    const unchanged =
      next.name === existing.name &&
      next.type === existing.type &&
      next.sutRoot === existing.sutRoot &&
      next.livenessJson ===
        (existing.liveness !== undefined ? JSON.stringify(existing.liveness) : null) &&
      next.retention === (existing.retention ?? null) &&
      next.allowRunDeletion === existingAllow;
    if (unchanged) return false;
    this.db
      .query(
        `UPDATE projects SET name = ?, type = ?, sut_root = ?, liveness = ?, retention = ?,
                             allow_run_deletion = ?
         WHERE key = ?`,
      )
      .run(
        next.name,
        next.type,
        next.sutRoot,
        next.livenessJson,
        next.retention,
        next.allowRunDeletion,
        key,
      );
    this.emit("projects", key);
    return true;
  }

  /** CR-CRU-012 §S1b — unarchive: restores full visibility. Idempotent. */
  unarchiveProject(key: string): boolean {
    const result = this.db
      .query(`UPDATE projects SET archived_at = NULL WHERE key = ? AND archived_at IS NOT NULL`)
      .run(key);
    if (result.changes > 0) {
      this.emit("projects", key);
      return true;
    }
    return false;
  }

  /**
   * CR-CRU-052 §S1 — irreversible project teardown: remove the project row
   * and EVERY row keyed to it (events, agents, plans, plan_cycles, rollups)
   * in ONE transaction, so a mid-cascade failure leaves NOTHING partially
   * removed (same fold+delete atomicity guarantee as enforceRetention). Both
   * §S1 gates — archived-first and userApproved — live at the route boundary;
   * reaching this method means the deletion is already authorized.
   *
   * One `DELETE FROM <table> WHERE project_key = ?` per dependent table, the
   * established style (clearEvents / enforceRetention), dependents before the
   * parent row. Returns the per-table deleted counts so a caller can ASSERT
   * the cascade rather than assume it.
   */
  deleteProjectCascade(key: string): ProjectDeleteCounts {
    const counts: ProjectDeleteCounts = {
      events: 0,
      agents: 0,
      plans: 0,
      planCycles: 0,
      rollups: 0,
    };
    this.db.transaction(() => {
      counts.events = this.db.query(`DELETE FROM events WHERE project_key = ?`).run(key).changes;
      counts.agents = this.db.query(`DELETE FROM agents WHERE project_key = ?`).run(key).changes;
      counts.plans = this.db.query(`DELETE FROM plans WHERE project_key = ?`).run(key).changes;
      counts.planCycles = this.db
        .query(`DELETE FROM plan_cycles WHERE project_key = ?`)
        .run(key).changes;
      counts.rollups = this.db.query(`DELETE FROM rollups WHERE project_key = ?`).run(key).changes;
      // CR-CRU-017 §S1 — issued runs die with their project. Not a reported
      // count: `ProjectDeleteCounts` is the CR-CRU-052 wire shape and stays it.
      this.db.query(`DELETE FROM runs WHERE project_key = ?`).run(key);
      this.db.query(`DELETE FROM projects WHERE key = ?`).run(key);
    })();
    // Emitted only after the transaction COMMITS — a rolled-back teardown
    // must never tell the dashboard something changed.
    this.emit("projects", key);
    this.emit("agents", key);
    this.emit("events", key);
    return counts;
  }

  private static toProject(row: ProjectRow): Project {
    return {
      key: row.key,
      name: row.name,
      type: row.type === "frontend" ? "frontend" : "backend",
      sutRoot: row.sut_root,
      createdAt: row.created_at,
      ...(row.liveness !== null ? { liveness: JSON.parse(row.liveness) } : {}),
      ...(row.retention !== null ? { retention: row.retention } : {}),
      // CR-CRU-008 §S4 — key ABSENT when never set (fresh projects stay
      // absent/false on the wire, matching the AC).
      ...(row.allow_run_deletion !== null
        ? { allowRunDeletion: row.allow_run_deletion === 1 }
        : {}),
    };
  }

  // ── Agents ────────────────────────────────────────────────────────────

  touchAgent(projectKey: string, agentId: string, opts?: TouchAgentOpts): Agent {
    const now = Date.now();
    const existing = this.db
      .query<AgentRow, [string, string]>(
        `SELECT * FROM agents WHERE project_key = ? AND agent_id = ?`,
      )
      .get(projectKey, agentId);

    if (existing === null) {
      const agent: Agent = {
        agentId,
        projectKey,
        status: opts?.status ?? "online",
        message: opts?.message ?? "",
        identity: opts?.identity ?? {},
        firstSeen: now,
        lastSeen: now,
        // CR-CRU-044 §S1 — key ABSENT when never declared (a role-less
        // ingest that creates the row must not fabricate one).
        ...(opts?.role !== undefined ? { role: opts.role } : {}),
        // CR-CRU-056 §S1 — same contract for the cycle binding: ABSENT when
        // the creating touch declared none.
        ...(opts?.boundCycleId !== undefined ? { boundCycleId: opts.boundCycleId } : {}),
      };
      this.db
        .query(
          `INSERT INTO agents (project_key, agent_id, status, message, identity, first_seen, last_seen, role, bound_cycle_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          agent.projectKey,
          agent.agentId,
          agent.status,
          agent.message,
          JSON.stringify(agent.identity),
          agent.firstSeen,
          agent.lastSeen,
          agent.role ?? null,
          agent.boundCycleId ?? null,
        );
      this.emit("agents", projectKey);
      return agent;
    }

    const storedIdentity = JSON.parse(existing.identity) as AgentIdentity;
    const agent: Agent = {
      agentId,
      projectKey,
      status: opts?.status ?? (existing.status === "busy" ? "busy" : "online"),
      message: opts?.message ?? existing.message,
      identity: opts?.identity !== undefined ? { ...storedIdentity, ...opts.identity } : storedIdentity,
      firstSeen: existing.first_seen,
      lastSeen: now,
      // CR-CRU-044 §S1(c) — PRESERVE on update (same precedent as identity
      // above): a role-less touch (every ingest, every heartbeat) must never
      // blank the role the agent declared at registration.
      ...(opts?.role !== undefined
        ? { role: opts.role }
        : existing.role !== null && existing.role !== undefined
          ? { role: existing.role as AgentRole }
          : {}),
      // CR-CRU-056 §S1 — PRESERVE on update (same contract as role above):
      // a binding-less touch (every ingest, every heartbeat) must never blank
      // the cycle the agent bound at registration.
      ...(opts?.boundCycleId !== undefined
        ? { boundCycleId: opts.boundCycleId }
        : existing.bound_cycle_id !== null && existing.bound_cycle_id !== undefined
          ? { boundCycleId: existing.bound_cycle_id }
          : {}),
    };
    this.db
      .query(
        `UPDATE agents SET status = ?, message = ?, identity = ?, last_seen = ?, role = ?, bound_cycle_id = ?
         WHERE project_key = ? AND agent_id = ?`,
      )
      .run(
        agent.status,
        agent.message,
        JSON.stringify(agent.identity),
        agent.lastSeen,
        agent.role ?? null,
        agent.boundCycleId ?? null,
        projectKey,
        agentId,
      );
    this.emit("agents", projectKey);
    return agent;
  }

  removeAgent(projectKey: string | undefined, agentId: string): void {
    const result =
      projectKey === undefined
        ? this.db.query(`DELETE FROM agents WHERE agent_id = ?`).run(agentId)
        : this.db
            .query(`DELETE FROM agents WHERE project_key = ? AND agent_id = ?`)
            .run(projectKey, agentId);
    // CR-CRU-003 §7 — emit only when the DELETE actually removed ≥ 1 row.
    if (result.changes > 0) {
      this.emit("agents", projectKey);
    }
  }

  /**
   * Single-row lookup with the same lazy-prune semantics as listAgents:
   * a row past its prune window is deleted and reported absent (null).
   * CR-CRU-011 §S1 — lets the unregister handler snapshot firstSeen
   * BEFORE removeAgent hard-deletes the row.
   */
  getAgent(projectKey: string, agentId: string, now: number = Date.now()): Agent | null {
    const row = this.db
      .query<AgentRow, [string, string]>(
        `SELECT * FROM agents WHERE project_key = ? AND agent_id = ?`,
      )
      .get(projectKey, agentId);
    if (row === null) return null;
    const agent = Store.toAgent(row);
    if (this.livenessOf(agent, now) === "pruned") {
      this.removeAgent(projectKey, agentId);
      return null;
    }
    return agent;
  }

  /**
   * Single-row existence check with the same lazy-prune semantics as
   * listAgents: a row past its prune window is deleted and reported absent.
   */
  hasAgent(projectKey: string, agentId: string, now: number = Date.now()): boolean {
    return this.getAgent(projectKey, agentId, now) !== null;
  }

  listAgents(projectKey?: string, now: number = Date.now()): LiveAgent[] {
    // CR-CRU-012 §S1b — archived projects' agents are excluded (not deleted).
    const rows =
      projectKey === undefined
        ? this.db
            .query<AgentRow, []>(
              `SELECT * FROM agents WHERE ${Store.NOT_ARCHIVED_SUBQUERY}
               ORDER BY last_seen DESC`,
            )
            .all()
        : this.db
            .query<AgentRow, [string]>(
              `SELECT * FROM agents WHERE project_key = ? AND ${Store.NOT_ARCHIVED_SUBQUERY}
               ORDER BY last_seen DESC`,
            )
            .all(projectKey);

    const live: LiveAgent[] = [];
    for (const row of rows) {
      const agent = Store.toAgent(row);
      const liveness = this.livenessOf(agent, now);
      if (liveness === "pruned") {
        // §S3 lazy prune — physically delete the row, exclude from results.
        this.removeAgent(agent.projectKey, agent.agentId);
        continue;
      }
      live.push({ ...agent, liveness });
    }
    return live;
  }

  // ── Events (§S2) ──────────────────────────────────────────

  recordTestEvent(
    projectKey: string,
    agentId: string,
    run: TestRun,
    meta?: RecordEventMeta,
  ): RunEvent {
    // §S3 implicit heartbeat — creates the agent row if new, bumps lastSeen.
    this.touchAgent(projectKey, agentId);
    const event: RunEvent = {
      id: this.nextEventId(),
      projectKey,
      agentId,
      kind: "test",
      tier: meta?.tier ?? "unit",
      timestamp: Date.now(),
      summary: run.summary,
      tree: run.tree,
      // §S4 discard-on-fail: coverage from a failing run is meaningless.
      ...(run.coverage !== undefined && run.summary.failed === 0
        ? { coverage: run.coverage }
        : {}),
      // CR-CRU-038 §S2b — run-level raw output; UNLIKE coverage, retained even
      // on a failing ingest (failure diagnostics matter most on red runs).
      ...(run.raw !== undefined ? { raw: run.raw } : {}),
      ...(meta?.stack !== undefined ? { stack: meta.stack } : {}),
      ...(meta?.codec !== undefined ? { codec: meta.codec } : {}),
      ...(meta?.name !== undefined ? { name: meta.name } : {}),
      ...(meta?.context !== undefined ? { context: meta.context } : {}),
      // CR-CRU-057 §S1 — a stamped role is DECLARED data by construction.
      ...(meta?.role !== undefined ? { role: meta.role, roleInferred: false } : {}),
      // CR-CRU-017 §S1 — the closed run's lifecycle; absent on a single-shot.
      ...(meta?.lifecycle !== undefined
        ? { startedAt: meta.lifecycle.startedAt, runtimeMs: meta.lifecycle.runtimeMs }
        : {}),
    };
    this.insertEvent(event);
    return event;
  }

  recordCompileEvent(
    projectKey: string,
    agentId: string,
    compile: unknown,
    meta?: Pick<RecordEventMeta, "tier" | "stack" | "context" | "codec" | "role" | "lifecycle">,
  ): RunEvent {
    // §S3 implicit heartbeat — creates the agent row if new, bumps lastSeen.
    this.touchAgent(projectKey, agentId);
    const event: RunEvent = {
      id: this.nextEventId(),
      projectKey,
      agentId,
      kind: "compile",
      tier: meta?.tier ?? "unit",
      timestamp: Date.now(),
      compile,
      ...(meta?.codec !== undefined ? { codec: meta.codec } : {}),
      ...(meta?.stack !== undefined ? { stack: meta.stack } : {}),
      ...(meta?.context !== undefined ? { context: meta.context } : {}),
      // CR-CRU-057 §S1 — a stamped role is DECLARED data by construction.
      ...(meta?.role !== undefined ? { role: meta.role, roleInferred: false } : {}),
      // CR-CRU-017 §S1 — the closed run's lifecycle; absent on a single-shot.
      ...(meta?.lifecycle !== undefined
        ? { startedAt: meta.lifecycle.startedAt, runtimeMs: meta.lifecycle.runtimeMs }
        : {}),
    };
    this.insertEvent(event);
    return event;
  }

  /**
   * CR-CRU-011 §S1 — append a lifecycle event (real registration or
   * unregistration; never heartbeats-on-existing). Flows through retention
   * like any event; foldIntoRollup skips it (contributes zero runs).
   */
  recordLifecycleEvent(
    projectKey: string,
    agentId: string,
    action: "registered" | "unregistered",
    firstSeen?: number,
    role?: AgentRole,
  ): RunEvent {
    const event: RunEvent = {
      id: this.nextEventId(),
      projectKey,
      agentId,
      kind: "lifecycle",
      tier: "unit",
      timestamp: Date.now(),
      action,
      ...(firstSeen !== undefined ? { firstSeen } : {}),
      // CR-CRU-057 §S1 — the declared role, captured by the route BEFORE the
      // agents row is deleted (the same survives-deletion contract firstSeen
      // has carried since CR-CRU-011 §S1). Declared, so never inferred.
      ...(role !== undefined ? { role, roleInferred: false } : {}),
    };
    this.insertEvent(event);
    return event;
  }

  /**
   * CR-CRU-013 §S1 — append a gate event (a no-mistakes gate outcome). The
   * full gate object is stored verbatim in the generic payload column; codec
   * is fixed to "no-mistakes". Flows through retention like any event;
   * foldIntoRollup skips it (gate is not a rollup-eligible kind).
   *
   * CR-CRU-073 §S1 — `version` (the release the gate gated) is stored
   * first-class on the event, never parsed back out of the free-text intent.
   * A gate arriving for an ALREADY-released version is retired on insert
   * (the release stamp already ran; this closes the late-arrival window).
   */
  recordGateEvent(
    projectKey: string,
    agentId: string,
    gate: unknown,
    meta?: { context?: RunContext; role?: AgentRole; version?: string },
  ): RunEvent {
    this.touchAgent(projectKey, agentId);
    const version = meta?.version;
    const alreadyReleased =
      version !== undefined && this.listReleases(projectKey).some((r) => r.label === version);
    const event: RunEvent = {
      id: this.nextEventId(),
      projectKey,
      agentId,
      kind: "gate",
      tier: "unit",
      codec: "no-mistakes",
      timestamp: Date.now(),
      gate,
      ...(version !== undefined ? { version } : {}),
      ...(alreadyReleased ? { retiredAt: Date.now() } : {}),
      ...(meta?.context !== undefined ? { context: meta.context } : {}),
      // CR-CRU-057 §S1 — a stamped role is DECLARED data by construction.
      ...(meta?.role !== undefined ? { role: meta.role, roleInferred: false } : {}),
    };
    this.insertEvent(event);
    return event;
  }

  /**
   * CR-CRU-013 §S4b/§S4c — append a milestone event. The flat type/label/
   * commit fields live in the generic payload column; context round-trips
   * verbatim. Rollup-excluded (not a rollup-eligible kind).
   *
   * CR-CRU-073 §S1 — a `release` milestone RETIRES its gates: in the SAME
   * transaction that inserts the release, every gate whose `version` equals
   * the release's `label` is stamped `retired_at`. A release with no matching
   * gate still records; a gate arriving afterwards is retired on insert.
   *
   * CR-CRU-080 §S3 — a release is IDENTIFIED by (type, label, commit), so a
   * repeat of one already held is a replay, not a second release: the held
   * event is returned with `changed:false` and nothing is inserted. Recording
   * a release is therefore idempotent for EVERY caller, which is the point of
   * putting it here rather than in the one ceremony that noticed — replaying
   * `release.sh backfill-releases` used to duplicate every release. The
   * caller is still touched on the agent rail: it did report, truthfully. A
   * replay keeps the provenance the FIRST recording captured, since nothing
   * is re-computed or overwritten.
   *
   * CR-CRU-080 §S4 — a release also records WHEN it shipped (`releasedAt`,
   * the tag's commit date) and WHAT it shipped (`crs`). Both ride the generic
   * payload column, so there is no column and no migration.
   *
   * CR-CRU-081 §S3 — the ONE correction path through that immutability, and
   * it is opt-in: `repairProvenance` must be asked for EXPLICITLY, in the
   * call itself. With it, a held release keeps its identity — the same row,
   * id, ingest timestamp, `label` and `commit` — and only the provenance
   * fields the caller actually re-derived are written over. Without it the
   * dedup replay is untouched, so no ordinary re-post can rewrite a release.
   */
  recordMilestoneEvent(
    projectKey: string,
    agentId: string,
    type: string,
    meta?: {
      label?: string;
      commit?: string;
      context?: RunContext;
      releasedAt?: number;
      crs?: string[];
      repairProvenance?: boolean;
    },
  ): { event: RunEvent; changed: boolean } {
    this.touchAgent(projectKey, agentId);
    if (type === "release" && meta?.label !== undefined && meta.commit !== undefined) {
      const held = this.listReleases(projectKey).find(
        (r) => r.label === meta.label && r.commit === meta.commit,
      );
      if (held !== undefined) {
        // CR-CRU-081 §S3 — the ONE way a held release changes: the caller
        // asked for it, in this call, on purpose. Everything else replays.
        return meta.repairProvenance === true
          ? this.repairReleaseProvenance(held, meta.releasedAt, meta.crs)
          : { event: held, changed: false };
      }
    }
    // CR-CRU-080 §S4 — provenance belongs to a release and nothing else, and
    // it is stored VERBATIM: both halves are facts about a repo the server
    // cannot see, so it carries them rather than re-deriving them. The tag
    // range comes from git and the intersection with the registered queue is
    // done by the reporter before it posts (the client's `release_crs`), which
    // keeps git out of the server's path entirely. A stored set is therefore a
    // SNAPSHOT of what the queue knew when the release was recorded: a CR
    // registered afterwards does not retroactively join a release it was never
    // part of.
    const releasedAt = type === "release" ? meta?.releasedAt : undefined;
    const crs = type === "release" ? meta?.crs : undefined;
    const event: RunEvent = {
      id: this.nextEventId(),
      projectKey,
      agentId,
      kind: "milestone",
      tier: "unit",
      timestamp: Date.now(),
      type,
      ...(meta?.label !== undefined ? { label: meta.label } : {}),
      ...(meta?.commit !== undefined ? { commit: meta.commit } : {}),
      ...(releasedAt !== undefined ? { releasedAt } : {}),
      ...(crs !== undefined ? { crs } : {}),
      ...(meta?.context !== undefined ? { context: meta.context } : {}),
    };
    const version = type === "release" ? meta?.label : undefined;
    if (version !== undefined) {
      this.db.transaction(() => {
        this.insertEvent(event);
        this.stampGatesRetired(projectKey, version, Date.now());
      })();
    } else {
      this.insertEvent(event);
    }
    return { event, changed: true };
  }

  /**
   * CR-CRU-081 §S3 — re-derive a HELD release's provenance IN PLACE.
   *
   * A correction, never a second recording: the row is UPDATEd, so the
   * release keeps its id, its ingest timestamp, its `label` and its `commit`,
   * and no tag ever gains a second release row. Only the fields the reporter
   * actually computed move — an absent `releasedAt`/`crs` means git could not
   * answer, which leaves the stored value alone rather than erasing it.
   *
   * Idempotent by construction: the repaired payload is built through the
   * SAME projection the insert uses, so an unchanged answer is byte-identical
   * to the stored one and the repair writes nothing and reports
   * `changed:false`.
   *
   * Gates are deliberately untouched (CR-CRU-073 §S1): the release already
   * exists, so its gates were retired when it was first recorded, and a gate
   * arriving later is retired on insert. Re-deriving what a release shipped
   * says nothing new about what gated it.
   */
  private repairReleaseProvenance(
    held: RunEvent,
    releasedAt: number | undefined,
    crs: string[] | undefined,
  ): { event: RunEvent; changed: boolean } {
    const repaired: RunEvent = {
      ...held,
      ...(releasedAt !== undefined ? { releasedAt } : {}),
      ...(crs !== undefined ? { crs } : {}),
    };
    const payload = Store.payloadColumn(repaired);
    if (payload === Store.payloadColumn(held)) return { event: held, changed: false };
    this.db.query(`UPDATE events SET payload = ? WHERE id = ?`).run(payload, held.id);
    return { event: repaired, changed: true };
  }

  /**
   * CR-CRU-073 §S1 — stamp `retired_at` on every LIVE gate whose stored
   * `version` equals `version`. The version rides the generic payload blob, so
   * the match is done on the parsed value (same JS-parse pattern as
   * listReleases / listEventsForCycle rather than a JSON SQL predicate).
   */
  private stampGatesRetired(projectKey: string, version: string, at: number): void {
    const rows = this.db
      .query<{ id: string; payload: string | null }, [string]>(
        `SELECT id, payload FROM events
         WHERE project_key = ? AND kind = 'gate' AND retired_at IS NULL`,
      )
      .all(projectKey);
    const update = this.db.query(`UPDATE events SET retired_at = ? WHERE id = ?`);
    for (const row of rows) {
      if (row.payload === null) continue;
      const parsed = JSON.parse(row.payload) as { version?: unknown };
      if (parsed.version === version) update.run(at, row.id);
    }
  }

  /**
   * CR-CRU-011 §S2 — the newest run (test/compile) timestamp for an agent;
   * lifecycle events excluded. Seals a tombstoned agent's runtime.
   */
  lastRunTimestamp(projectKey: string, agentId: string): number | null {
    const row = this.db
      .query<{ timestamp: number }, [string, string]>(
        `SELECT timestamp FROM events
         WHERE project_key = ? AND agent_id = ? AND kind != 'lifecycle'
         ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
      )
      .get(projectKey, agentId);
    return row?.timestamp ?? null;
  }

  // ── Runs (CR-CRU-017 §S1 — the run LIFECYCLE) ─────────────────────────

  /**
   * §S1 — open a run and PERSIST it (SQLite, never a module-level Map: the CR's
   * Risk section requires an open run to survive a server restart). Implicit
   * heartbeat, like every other ingest surface. No event is stored: a start is
   * not an end, so nothing lands on the timeline as a run yet.
   */
  startRun(
    projectKey: string,
    agentId: string,
    opts?: { tier?: Tier; stack?: string; context?: RunContext },
  ): RunRecord {
    this.touchAgent(projectKey, agentId);
    const run: RunRecord = {
      runId: `run-${crypto.randomUUID()}`,
      projectKey,
      agentId,
      startedAt: Date.now(),
      state: "open",
      ...(opts?.tier !== undefined ? { tier: opts.tier } : {}),
      ...(opts?.stack !== undefined ? { stack: opts.stack } : {}),
      ...(opts?.context !== undefined ? { context: opts.context } : {}),
    };
    this.db
      .query(
        `INSERT INTO runs (run_id, project_key, agent_id, started_at, tier, stack, context,
           run_state, settled_at, abort_reason, event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL)`,
      )
      .run(
        run.runId,
        run.projectKey,
        run.agentId,
        run.startedAt,
        run.tier ?? null,
        run.stack ?? null,
        run.context !== undefined ? JSON.stringify(run.context) : null,
      );
    // The dashboard's live "running…" card is driven off the same feed the
    // events stream already refreshes.
    this.emit("events", projectKey);
    return run;
  }

  /** §S1 — the issued run behind a runId, settled or not; null when never issued. */
  getRun(runId: string): RunRecord | null {
    const row = this.db
      .query<RunRow, [string]>(`SELECT * FROM runs WHERE run_id = ?`)
      .get(runId);
    return row === null ? null : Store.toRun(row);
  }

  /**
   * CR-CRU-017 §S1/§S3 — the OPEN runs a dashboard must paint as "running…",
   * newest first, optionally scoped to one project. Read-only: the caller
   * sweeps (`sweepOpenRuns`) BEFORE reading, so a dead run is already settled
   * and never served here as still-running. Archived projects are excluded on
   * the same grounds `listEvents` excludes them (CR-CRU-012 §S1b): an archived
   * project contributes nothing to any live surface.
   */
  listOpenRuns(projectKey?: string): RunRecord[] {
    const rows =
      projectKey === undefined
        ? this.db
            .query<RunRow, []>(
              `SELECT * FROM runs WHERE run_state = 'open' AND ${Store.NOT_ARCHIVED_SUBQUERY}
               ORDER BY started_at DESC`,
            )
            .all()
        : this.db
            .query<RunRow, [string]>(
              `SELECT * FROM runs
               WHERE run_state = 'open' AND project_key = ? AND ${Store.NOT_ARCHIVED_SUBQUERY}
               ORDER BY started_at DESC`,
            )
            .all(projectKey);
    return rows.map((row) => Store.toRun(row));
  }

  /**
   * §S1 — mark an OPEN run ENDED by the event that closed it. Guarded on
   * `run_state = 'open'`, so a lost end/end race changes nothing (the caller
   * has already refused the second close with a 409).
   */
  endRun(runId: string, eventId: string, endedAt: number): boolean {
    const { changes } = this.db
      .query(
        `UPDATE runs SET run_state = 'ended', settled_at = ?, event_id = ?
         WHERE run_id = ? AND run_state = 'open'`,
      )
      .run(endedAt, eventId, runId);
    return changes > 0;
  }

  /**
   * §S1 — the auto-abort sweep, riding CR-CRU-011's liveness machinery rather
   * than a second staleness clock: an open run whose agent has TOMBSTONED (or
   * whose agent row is gone) is aborted `agent died`; one that has outlived
   * `CRUCIBLE_RUN_ABANDON_MS` is aborted `abandoned`. Idempotent — an aborted
   * run leaves `run_state = 'aborted'` and is never swept again.
   */
  sweepOpenRuns(now: number = Date.now()): RunEvent[] {
    const abandonAfterMs = runAbandonAfterMs();
    const open = this.db
      .query<RunRow, []>(`SELECT * FROM runs WHERE run_state = 'open' ORDER BY started_at ASC`)
      .all();
    const aborted: RunEvent[] = [];
    for (const row of open) {
      const run = Store.toRun(row);
      const agent = this.getAgent(run.projectKey, run.agentId, now);
      // A pruned/deleted agent row is a dead agent too — CR-011 already
      // reports it as gone, and a run cannot outlive its runner.
      const reason =
        agent === null || this.livenessOf(agent, now) === "tombstoned"
          ? "agent died"
          : now - run.startedAt >= abandonAfterMs
            ? "abandoned"
            : null;
      if (reason === null) continue;
      aborted.push(this.abortRun(run, reason, now, agent?.role));
    }
    return aborted;
  }

  /**
   * §S1 — settle an open run as ABORTED and store the event that records it,
   * in ONE transaction: the run row and its event can never disagree, and a
   * second sweep can never emit a duplicate abort.
   *
   * The event stays `kind: "test"` — an aborted run is still a run (§S2's
   * rollup guard is what will read `status`, by VALUE, in a later cycle).
   */
  private abortRun(
    run: RunRecord,
    reason: string,
    at: number,
    role?: AgentRole,
  ): RunEvent {
    const event: RunEvent = {
      id: this.nextEventId(),
      projectKey: run.projectKey,
      agentId: run.agentId,
      kind: "test",
      tier: run.tier ?? "unit",
      timestamp: at,
      startedAt: run.startedAt,
      runtimeMs: at - run.startedAt,
      status: "aborted",
      abortReason: reason,
      ...(run.stack !== undefined ? { stack: run.stack } : {}),
      ...(run.context !== undefined ? { context: run.context } : {}),
      // CR-CRU-057 §S1 — the declared role off the agent row, when it survives.
      ...(role !== undefined ? { role, roleInferred: false } : {}),
    };
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE runs SET run_state = 'aborted', settled_at = ?, abort_reason = ?, event_id = ?
           WHERE run_id = ? AND run_state = 'open'`,
        )
        .run(at, reason, event.id, run.runId);
      this.insertEvent(event);
    })();
    return event;
  }

  private static toRun(row: RunRow): RunRecord {
    return {
      runId: row.run_id,
      projectKey: row.project_key,
      agentId: row.agent_id,
      startedAt: row.started_at,
      state: row.run_state === "ended" || row.run_state === "aborted" ? row.run_state : "open",
      ...(row.tier !== null ? { tier: row.tier as Tier } : {}),
      ...(row.stack !== null ? { stack: row.stack } : {}),
      ...(row.context !== null ? { context: JSON.parse(row.context) as RunContext } : {}),
      ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
      ...(row.abort_reason !== null ? { abortReason: row.abort_reason } : {}),
      ...(row.event_id !== null ? { eventId: row.event_id } : {}),
    };
  }

  listEvents(projectKey?: string, limit = 50): RunEvent[] {
    // CR-CRU-012 §S1b — archived projects' events are excluded (not deleted).
    // CR-CRU-073 §S1 — the pane/timeline feed EXCLUDES retired gates
    // (retired_at IS NOT NULL); getEvent still serves them for audit.
    const rows =
      projectKey === undefined
        ? this.db
            .query<EventRow, [number]>(
              `SELECT * FROM events WHERE ${Store.NOT_ARCHIVED_SUBQUERY} AND retired_at IS NULL
               ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
            )
            .all(limit)
        : this.db
            .query<EventRow, [string, number]>(
              `SELECT * FROM events WHERE project_key = ? AND ${Store.NOT_ARCHIVED_SUBQUERY}
               AND retired_at IS NULL
               ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
            )
            .all(projectKey, limit);
    return rows.map(Store.toEvent);
  }

  /**
   * CR-CRU-032 §S1 — anchored fetch: exactly the runs linked to one cycle,
   * i.e. whose parsed `context.cycleId` equals `cycleId`. Newest-first, like
   * listEvents; archived projects excluded. Unlinked runs (no context) and
   * other cycles' runs are filtered out. `context` is JSON in the column, so
   * the match is done on the parsed value (same pattern as
   * deriveCommitBoundary).
   */
  listEventsForCycle(projectKey: string, cycleId: number): RunEvent[] {
    const rows = this.db
      .query<EventRow, [string]>(
        `SELECT * FROM events WHERE project_key = ? AND context IS NOT NULL
         AND ${Store.NOT_ARCHIVED_SUBQUERY}
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(projectKey);
    return rows
      .filter((row) => {
        const context = JSON.parse(row.context!) as RunContext;
        return context.cycleId === cycleId;
      })
      .map(Store.toEvent);
  }

  /**
   * CR-CRU-074 §S3 — the releases a project has recorded, newest-first: the
   * milestone events of type `release`, whose `label` carries the version and
   * `commit` the tagged sha. Archived projects are excluded through the same
   * subquery `listAgents`/`listEvents`/`listOpenRuns` use (CR-CRU-012 §S1b) —
   * an archived project contributes nothing to any live surface, and nothing
   * is deleted, so unarchiving restores its history. `type` is JSON in the
   * payload column, so the match is done on the parsed value (same pattern as
   * listEventsForCycle above); no other milestone type can leak in.
   *
   * CR-CRU-080 §S4/AC9 — "newest-first" means newest SHIPPED, not newest
   * ingested: the order is by `releasedAt` (the tag's own date), which the
   * backfill's ingest minute could never reproduce. A release recorded before
   * §S4 carries none, so its ingest instant stands in for its ship instant —
   * that keeps the pre-§S4 rows in exactly the newest-ingest-first order they
   * have always had, instead of sinking them behind an invented zero. The SQL
   * order is the tiebreaker: `Array#sort` is stable.
   */
  listReleases(projectKey: string): RunEvent[] {
    const rows = this.db
      .query<EventRow, [string]>(
        `SELECT * FROM events WHERE project_key = ? AND kind = 'milestone'
         AND ${Store.NOT_ARCHIVED_SUBQUERY}
         ORDER BY timestamp DESC, rowid DESC`,
      )
      .all(projectKey);
    return rows
      .map(Store.toEvent)
      .filter((event) => event.type === "release")
      .sort((a, b) => {
        // `releasedAt` is epoch SECONDS (git's `%ct`); the ingest `timestamp`
        // is epoch MS and stands in for a release that carries no ship date.
        const shippedA = a.releasedAt !== undefined ? a.releasedAt * 1000 : a.timestamp;
        const shippedB = b.releasedAt !== undefined ? b.releasedAt * 1000 : b.timestamp;
        return shippedB - shippedA;
      });
  }

  /** Cheap SQL count of raw (non-rolled-up) events, optionally scoped to a project. */
  countEvents(projectKey?: string): number {
    if (projectKey === undefined) {
      return this.db
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events`)
        .get()!.n;
    }
    return this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events WHERE project_key = ?`,
      )
      .get(projectKey)!.n;
  }

  getEvent(id: string): RunEvent | null {
    const row = this.db
      .query<EventRow, [string]>(`SELECT * FROM events WHERE id = ?`)
      .get(id);
    return row ? Store.toEvent(row) : null;
  }

  deleteEvent(id: string, projectKey: string): boolean {
    const row = this.db
      .query<{ project_key: string }, [string]>(
        `SELECT project_key FROM events WHERE id = ?`,
      )
      .get(id);
    if (row === null || row.project_key !== projectKey) {
      return false;
    }
    this.db.query(`DELETE FROM events WHERE id = ?`).run(id);
    this.emit("events", projectKey);
    return true;
  }

  clearEvents(projectKey: string): number {
    const { changes } = this.db
      .query(`DELETE FROM events WHERE project_key = ?`)
      .run(projectKey);
    this.emit("events", projectKey);
    return changes;
  }

  private nextEventId(): string {
    return `evt-${Date.now()}-${++this.seq}`;
  }

  /**
   * CR-CRU-013 §S1+§S4b — the kind-specific carrying fields an event stores in
   * the ONE generic payload column (NULL when it carries none).
   *
   * CR-CRU-081 §S3 — a single projection, shared by the INSERT below and by
   * the in-place provenance repair, so a repaired row's payload is identical
   * in shape and key order to a freshly inserted one (which is what lets the
   * repair decide "nothing changed" by comparing the two strings).
   */
  private static payloadColumn(event: RunEvent): string | null {
    const payloadObj: Record<string, unknown> = {
      ...(event.gate !== undefined ? { gate: event.gate } : {}),
      ...(event.type !== undefined ? { type: event.type } : {}),
      ...(event.label !== undefined ? { label: event.label } : {}),
      ...(event.commit !== undefined ? { commit: event.commit } : {}),
      // CR-CRU-017 §S1 — the RUN-abort reason rides the generic payload blob
      // (no fourth column: §S0 pins exactly three).
      ...(event.abortReason !== undefined ? { abortReason: event.abortReason } : {}),
      // CR-CRU-038 §S2b — run-level raw output rides the generic payload blob.
      ...(event.raw !== undefined ? { raw: event.raw } : {}),
      // CR-CRU-073 §S1 — the gated release version rides the generic payload
      // blob (first-class on the event, never inside the gate object).
      ...(event.version !== undefined ? { version: event.version } : {}),
      // CR-CRU-080 §S4 — release provenance (the tag's ship date and the CR
      // ids the release shipped) rides the SAME generic payload blob, which is
      // why §S4 needs no column and no migration (SCHEMA_VERSION stays 7).
      ...(event.releasedAt !== undefined ? { releasedAt: event.releasedAt } : {}),
      ...(event.crs !== undefined ? { crs: event.crs } : {}),
    };
    return Object.keys(payloadObj).length > 0 ? JSON.stringify(payloadObj) : null;
  }

  private insertEvent(event: RunEvent): void {
    const payload = Store.payloadColumn(event);
    this.db
      .query(
        `INSERT INTO events (id, project_key, agent_id, kind, tier, stack, codec,
           timestamp, name, total, passed, failed, pending, duration_ms,
           tree, coverage, compile, context, action, first_seen, payload,
           role, role_inferred, started_at, runtime_ms, status, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.projectKey,
        event.agentId,
        event.kind,
        event.tier,
        event.stack ?? null,
        event.codec ?? null,
        event.timestamp,
        event.name ?? null,
        event.summary?.total ?? null,
        event.summary?.passed ?? null,
        event.summary?.failed ?? null,
        event.summary?.pending ?? null,
        event.summary?.duration_ms ?? null,
        event.tree !== undefined ? JSON.stringify(event.tree) : null,
        event.coverage !== undefined ? JSON.stringify(event.coverage) : null,
        event.compile !== undefined ? JSON.stringify(event.compile) : null,
        event.context !== undefined ? JSON.stringify(event.context) : null,
        event.action ?? null,
        event.firstSeen ?? null,
        payload,
        // CR-CRU-057 §S1 — role and its provenance move together: an event
        // with no declared role stores NULL in BOTH columns (never a 0 that
        // would read as "declared nothing").
        event.role ?? null,
        event.role !== undefined ? (event.roleInferred === true ? 1 : 0) : null,
        // CR-CRU-017 §S1 — the RUN lifecycle, NULL on every single-shot ingest
        // (graceful degradation: no runId, no lifecycle).
        event.startedAt ?? null,
        event.runtimeMs ?? null,
        event.status ?? null,
        // CR-CRU-073 §S1 — the release-retirement marker; NULL for a live gate
        // and for every non-gate row.
        event.retiredAt ?? null,
      );
    this.enforceRetention(event.projectKey);
    this.emit("events", event.projectKey);
  }

  private static toEvent(row: EventRow): RunEvent {
    // CR-CRU-013 §S1+§S4b — pass the kind through for the whole known family
    // (no longer collapse gate/milestone to "test"); hydrate their fields
    // from the generic payload column.
    const kind: RunEvent["kind"] =
      row.kind === "compile" ||
      row.kind === "lifecycle" ||
      row.kind === "gate" ||
      row.kind === "milestone"
        ? row.kind
        : "test";
    const payload =
      row.payload !== null ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
    return {
      id: row.id,
      projectKey: row.project_key,
      agentId: row.agent_id,
      kind,
      tier: row.tier as Tier,
      timestamp: row.timestamp,
      ...(payload.gate !== undefined ? { gate: payload.gate } : {}),
      ...(typeof payload.type === "string" ? { type: payload.type } : {}),
      ...(typeof payload.label === "string" ? { label: payload.label } : {}),
      ...(typeof payload.commit === "string" ? { commit: payload.commit } : {}),
      // CR-CRU-080 §S4 — release provenance, served from the payload blob it
      // was stored in; a pre-§S4 release row simply has neither key.
      ...(typeof payload.releasedAt === "number" ? { releasedAt: payload.releasedAt } : {}),
      ...(Array.isArray(payload.crs) ? { crs: payload.crs as string[] } : {}),
      // CR-CRU-038 §S2b — run-level raw output served verbatim from the payload.
      ...(typeof payload.raw === "string" ? { raw: payload.raw } : {}),
      ...(row.action !== null ? { action: row.action as "registered" | "unregistered" } : {}),
      ...(row.first_seen !== null ? { firstSeen: row.first_seen } : {}),
      ...(row.stack !== null ? { stack: row.stack } : {}),
      ...(row.codec !== null ? { codec: row.codec } : {}),
      ...(row.name !== null ? { name: row.name } : {}),
      ...(row.total !== null
        ? {
            summary: {
              total: row.total,
              passed: row.passed ?? 0,
              failed: row.failed ?? 0,
              pending: row.pending ?? 0,
              duration_ms: row.duration_ms ?? 0,
            },
          }
        : {}),
      ...(row.tree !== null ? { tree: JSON.parse(row.tree) as SuiteNode[] } : {}),
      ...(row.coverage !== null ? { coverage: JSON.parse(row.coverage) as Coverage } : {}),
      ...(row.compile !== null ? { compile: JSON.parse(row.compile) as unknown } : {}),
      ...(row.context !== null ? { context: JSON.parse(row.context) as RunContext } : {}),
      // CR-CRU-057 §S1 — the stamped role and its provenance; BOTH keys are
      // absent on a role-less row (never fabricated into a null or a guess).
      ...(row.role !== null
        ? { role: row.role as AgentRole, roleInferred: row.role_inferred === 1 }
        : {}),
      // CR-CRU-017 §S1 — the RUN lifecycle: present exactly when the run was
      // opened through /runs/start. A single-shot ingest's row is NULL in all
      // three columns and therefore serves NONE of these keys (absence, never
      // a fabricated null). `status` is the RUN's terminal state — unrelated to
      // `Plan.status`, which lives on a different entity.
      ...((row.started_at ?? null) !== null ? { startedAt: row.started_at! } : {}),
      ...((row.runtime_ms ?? null) !== null ? { runtimeMs: row.runtime_ms! } : {}),
      ...((row.status ?? null) !== null ? { status: row.status as RunEvent["status"] } : {}),
      ...(typeof payload.abortReason === "string"
        ? { abortReason: payload.abortReason }
        : {}),
      // CR-CRU-073 §S1 — the gated version (payload) and the retirement marker
      // (column); each ABSENT when its stored value is (never fabricated).
      ...(typeof payload.version === "string" ? { version: payload.version } : {}),
      ...((row.retired_at ?? null) !== null ? { retiredAt: row.retired_at! } : {}),
    };
  }

  // ── Retention + rollup (§S4) ──────────────────────────────

  listRollups(projectKey: string): Rollup[] {
    const rows = this.db
      .query<RollupRow, [string]>(
        // CR-CRU-012 §S1b — archived projects' rollups are excluded (not deleted).
        `SELECT * FROM rollups WHERE project_key = ? AND ${Store.NOT_ARCHIVED_SUBQUERY}
         ORDER BY rowid ASC`,
      )
      .all(projectKey);
    return rows.map((row) => ({
      projectKey: row.project_key,
      bucket: row.bucket,
      runs: row.runs,
      passed: row.passed,
      failed: row.failed,
      duration_ms: row.duration_ms,
      ...(row.last_coverage !== null
        ? { lastCoverage: JSON.parse(row.last_coverage) as Coverage }
        : {}),
    }));
  }

  // CR-CRU-013 §S1 — the ONLY kinds whose expired events fold into test-run
  // rollups; every other kind (lifecycle, gate, milestone) is excluded.
  private static readonly ROLLUP_ELIGIBLE_KINDS: ReadonlySet<string> = new Set([
    "test",
    "compile",
  ]);

  private enforceRetention(projectKey: string): void {
    const cap = this.getProject(projectKey)?.retention ?? DEFAULT_RETENTION;
    // CR-CRU-073 §S1 — a LIVE gate AWAITING its release (retired_at IS NULL
    // AND a stored version) is EXEMPT from the count cap: it survives until
    // its release ships and retires it, after which it prunes like any event.
    // A VERSIONLESS gate is NOT exempt — it can never be retired, so exempting
    // it would leak forever (the migration retires the pre-column strays for
    // the same reason). `version` rides the payload blob, matched via
    // json_extract (NULL payload / absent key → NOT NULL is false → prunable).
    const LIVE_GATE = `(kind = 'gate' AND retired_at IS NULL AND json_extract(payload, '$.version') IS NOT NULL)`;
    const count = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events WHERE project_key = ? AND NOT ${LIVE_GATE}`,
      )
      .get(projectKey)!.n;
    const overflow = count - cap;
    if (overflow <= 0) {
      return;
    }
    const expired = this.db
      .query<EventRow, [string, number]>(
        `SELECT * FROM events WHERE project_key = ? AND NOT ${LIVE_GATE}
         ORDER BY timestamp ASC, rowid ASC LIMIT ?`,
      )
      .all(projectKey, overflow);
    // Fold + delete atomically so a crash can never leave an expired event
    // both counted in rollups and still present for a later re-fold.
    this.db.transaction(() => {
      for (const row of expired) {
        // CR-CRU-013 §S1 — invert the single lifecycle-exclusion into a
        // rollup-ELIGIBLE set {test, compile}: gate/milestone (like lifecycle)
        // flow through retention but contribute NOTHING to test-run rollups.
        if (Store.ROLLUP_ELIGIBLE_KINDS.has(row.kind)) {
          this.foldIntoRollup(row);
        }
        this.db.query(`DELETE FROM events WHERE id = ?`).run(row.id);
      }
    })();
  }

  private foldIntoRollup(row: EventRow): void {
    // Bucket key: ALWAYS the event's UTC day (CR-033 §S1 / DN §6 — the wave key
    // served no consumer and broke date bucketing).
    const bucket = new Date(row.timestamp).toISOString().slice(0, 10);
    this.db
      .query(
        `INSERT INTO rollups (project_key, bucket, runs, passed, failed, duration_ms, last_coverage)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (project_key, bucket) DO UPDATE SET
           runs = runs + 1,
           passed = passed + excluded.passed,
           failed = failed + excluded.failed,
           duration_ms = duration_ms + excluded.duration_ms,
           last_coverage = COALESCE(excluded.last_coverage, last_coverage)`,
      )
      .run(
        row.project_key,
        bucket,
        row.passed ?? 0,
        row.failed ?? 0,
        row.duration_ms ?? 0,
        row.coverage,
      );
  }

  // ── Change notifications (§S2 onChange) ───────────────────

  // ── CR-CRU-011 §S0 — cycle plans (NOT events: no event rows, no rollups) ──
  //
  // Plan mutations notify through the SAME onChange listener path SSE
  // consumes, under the existing "events" kind: §S0b renders plan state
  // (markers/spans) inline on the events timeline, so the events surface IS
  // the affected consumer surface. (A dedicated "plans" ChangeKind would
  // widen the union pinned by tests/events.test.ts — deferred to a
  // sanctioned re-target if a later cycle needs kind-discriminated pushes.)

  /** Terminal cycle statuses — a plan closes only when every cycle is here. */
  private static readonly CYCLE_TERMINAL: ReadonlySet<string> = new Set([
    "done",
    "skipped",
    "failed",
  ]);

  /**
   * §S0 legal transition table: pending→active, active→done|skipped|failed,
   * plus the ONE shortcut pending→skipped (a never-started cycle can be
   * cancelled outright). Everything else rejects naming both states.
   */
  private static readonly CYCLE_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
    pending: new Set(["active", "skipped"]),
    active: new Set(["done", "skipped", "failed"]),
  };

  /** §S0 — cycle ids are unique per PROJECT, not per plan. */
  private nextCycleId(projectKey: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT COALESCE(MAX(cycle_id), 0) AS n FROM plan_cycles WHERE project_key = ?`,
      )
      .get(projectKey)!;
    return row.n + 1;
  }

  private getPlanRow(projectKey: string, planId: number): PlanRow | null {
    return this.db
      .query<PlanRow, [string, number]>(
        `SELECT * FROM plans WHERE project_key = ? AND plan_id = ?`,
      )
      .get(projectKey, planId);
  }

  private listCycleRows(projectKey: string, planId: number): PlanCycleRow[] {
    // CR-CRU-024 §S3.1 — display order is `seq`, not `cycle_id`; the cycle_id
    // tiebreaker keeps a stable order for any legacy rows sharing a seq.
    return this.db
      .query<PlanCycleRow, [string, number]>(
        `SELECT * FROM plan_cycles WHERE project_key = ? AND plan_id = ?
         ORDER BY seq ASC, cycle_id ASC`,
      )
      .all(projectKey, planId);
  }

  /** CR-CRU-024 §S3.1 — next append `seq` for a plan: MAX(seq)+1 (lands last). */
  private nextSeq(projectKey: string, planId: number): number {
    const row = this.db
      .query<{ n: number }, [string, number]>(
        `SELECT COALESCE(MAX(seq), 0) AS n FROM plan_cycles
         WHERE project_key = ? AND plan_id = ?`,
      )
      .get(projectKey, planId)!;
    return row.n + 1;
  }

  private insertCycle(
    projectKey: string,
    planId: number,
    label: string,
    kind: CycleKind,
    seq: number,
  ): PlanCycle {
    const id = this.nextCycleId(projectKey);
    this.db
      .query(
        `INSERT INTO plan_cycles (project_key, cycle_id, plan_id, label, kind, status, seq)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(projectKey, id, planId, label, kind, seq);
    return { id, label, kind, status: "pending" };
  }

  /** §S0 — file the orchestrator's cycle plan. ONE open plan per cr. */
  filePlan(
    projectKey: string,
    input: {
      cr: string;
      title?: string;
      orchestrator?: string;
      wave?: string;
      track?: string;
      cycles: Array<{ label: string; kind: CycleKind }>;
    },
  ): Plan | PlanOpError {
    const open = this.db
      .query<PlanRow, [string, string]>(
        `SELECT * FROM plans WHERE project_key = ? AND cr = ? AND status = 'open'`,
      )
      .get(projectKey, input.cr);
    if (open !== null) {
      return { error: `an open plan already exists for cr: ${input.cr}` };
    }
    const inserted = this.db
      .query(
        `INSERT INTO plans (project_key, cr, title, orchestrator, wave, track, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(
        projectKey,
        input.cr,
        input.title ?? null,
        input.orchestrator ?? null,
        input.wave ?? null,
        input.track ?? null,
      );
    const planId = Number(inserted.lastInsertRowid);
    const cycles = input.cycles.map((cycle) =>
      this.insertCycle(
        projectKey,
        planId,
        cycle.label,
        cycle.kind,
        this.nextSeq(projectKey, planId),
      ),
    );
    this.emit("events", projectKey);
    return {
      planId,
      projectKey,
      cr: input.cr,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.orchestrator !== undefined ? { orchestrator: input.orchestrator } : {}),
      ...(input.wave !== undefined ? { wave: input.wave } : {}),
      ...(input.track !== undefined ? { track: input.track } : {}),
      status: "open",
      cycles,
    };
  }

  /**
   * §S0 — append a cycle to an OPEN plan; returns the new project-unique id.
   * CR-CRU-024 §S3.1 — with `before`, INSERT the new cycle immediately before
   * that sibling in `seq` order (fractional midpoint). The insertion point must
   * sit AFTER the active cycle: targeting the active cycle or any seq-earlier
   * sibling would land a pending cycle ahead of the active one (violating the
   * §S1/§S2 order invariant) → refused, naming the active cycle.
   */
  appendCycle(
    projectKey: string,
    planId: number,
    cycle: { label: string; kind: CycleKind },
    before?: number,
  ): PlanCycle | PlanOpError {
    const plan = this.getPlanRow(projectKey, planId);
    if (plan === null) {
      return { error: `plan not found: ${planId}`, notFound: true };
    }
    if (plan.status !== "open") {
      return { error: `plan ${planId} is closed — cannot append cycles` };
    }
    if (before !== undefined) {
      const siblings = this.listCycleRows(projectKey, planId); // seq-ordered
      const target = siblings.find((c) => c.cycle_id === before);
      if (target === undefined) {
        return { error: `cycle not found in plan ${planId}: ${before}`, notFound: true };
      }
      const active = siblings.find((c) => c.status === "active");
      if (active !== undefined && target.seq <= active.seq) {
        return {
          error: `cannot insert before cycle ${before}: cycle ${active.cycle_id} is active — new cycles must land after the active cycle`,
          code: "insert-before-active",
          cycleRef: active.cycle_id,
        };
      }
      // Predecessor = the seq-immediately-before sibling (siblings are
      // seq-ordered, so the last one below target). Midpoint keeps the new
      // cycle strictly between predecessor and target in display order.
      const earlier = siblings.filter((c) => c.seq < target.seq);
      const pred = earlier.length > 0 ? earlier[earlier.length - 1] : undefined;
      const newSeq = pred !== undefined ? (pred.seq + target.seq) / 2 : target.seq - 1;
      const inserted = this.insertCycle(projectKey, planId, cycle.label, cycle.kind, newSeq);
      this.emit("events", projectKey);
      return inserted;
    }
    const appended = this.insertCycle(
      projectKey,
      planId,
      cycle.label,
      cycle.kind,
      this.nextSeq(projectKey, planId),
    );
    this.emit("events", projectKey);
    return appended;
  }

  private epochKey(projectKey: string, cycleId: number): string {
    return `${projectKey}:${cycleId}`;
  }

  /**
   * CR-CRU-023 §S3 (a) — the live attention epoch of an ACTIVE cycle starts
   * at max(activatedAt, bootedAt, last checkpoint), so downtime is excluded
   * and a mid-epoch checkpoint is never counted twice.
   */
  private epochStart(projectKey: string, cycleId: number, activatedAt: number): number {
    const checkpointAt = this.epochCheckpointAt.get(this.epochKey(projectKey, cycleId)) ?? 0;
    return Math.max(activatedAt, this.bootedAt, checkpointAt);
  }

  /** §S0 — transition a cycle per the legal table; illegal moves name both states. */
  transitionCycle(
    projectKey: string,
    planId: number,
    cycleId: number,
    to: CycleStatus,
  ): PlanCycle | PlanOpError {
    const row = this.db
      .query<PlanCycleRow, [string, number, number]>(
        `SELECT * FROM plan_cycles WHERE project_key = ? AND plan_id = ? AND cycle_id = ?`,
      )
      .get(projectKey, planId, cycleId);
    if (row === null) {
      return { error: `cycle not found in plan ${planId}: ${cycleId}`, notFound: true };
    }
    if (!(Store.CYCLE_TRANSITIONS[row.status]?.has(to) ?? false)) {
      return {
        error: `illegal cycle transition: ${row.status} -> ${to}`,
        code: "illegal-transition",
      };
    }
    // CR-CRU-024 §S1+§S2 — cross-cycle activation guards. CYCLE_TRANSITIONS is
    // per-cycle only, so activating a cycle while a sibling blocks it currently
    // succeeds silently. Guard both invalid shapes on the pending→active edge.
    if (to === "active") {
      const siblings = this.listCycleRows(projectKey, planId);
      // §S2 single-active: another cycle in this plan is already active.
      const active = siblings.find(
        (c) => c.cycle_id !== cycleId && c.status === "active",
      );
      if (active !== undefined) {
        return {
          error: `cycle ${active.cycle_id} is already active`,
          code: "already-active",
          cycleRef: active.cycle_id,
        };
      }
      // §S1 out-of-order: an EARLIER sibling (lower `seq`, i.e. earlier in
      // display order) is still pending. CR-CRU-024 §S3.1 — keyed off `seq`,
      // NOT cycle_id: after an insert-before, a seq-earlier pending sibling can
      // carry a HIGHER cycle_id yet must still block this activation.
      const earlier = siblings.find(
        (c) => c.seq < row.seq && c.status === "pending",
      );
      if (earlier !== undefined) {
        return {
          error: `out-of-order activation: cycle ${earlier.cycle_id} is still pending`,
          code: "out-of-order",
          cycleRef: earlier.cycle_id,
        };
      }
    }
    // §S0b — stamp the transition timestamps (mirrors Plan.closedAt):
    // pending→active stamps activated_at; reaching a terminal state stamps
    // done_at. The timeline's declared marker derives active→done from them.
    const now = Date.now();
    const activatedAt = to === "active" ? now : row.activated_at;
    const doneAt = Store.CYCLE_TERMINAL.has(to) ? now : row.done_at;
    // CR-CRU-023 §S3 (a) — attention-epoch checkpoints at transition writes:
    // activation opens an epoch with an explicit 0 checkpoint; leaving
    // `active` (the terminal transition) seals the open epoch — accumulated
    // += now − max(activatedAt, bootedAt) — so restarts resume from the
    // persisted setpoint, excluding downtime.
    let activeMsAccumulated = row.active_ms_accumulated;
    if (to === "active") {
      activeMsAccumulated = 0;
      this.epochCheckpointAt.delete(this.epochKey(projectKey, cycleId));
    } else if (row.status === "active" && row.activated_at !== null) {
      const epochStart = this.epochStart(projectKey, cycleId, row.activated_at);
      activeMsAccumulated =
        (row.active_ms_accumulated ?? 0) + Math.max(0, now - epochStart);
      this.epochCheckpointAt.delete(this.epochKey(projectKey, cycleId));
    }
    this.db
      .query(
        `UPDATE plan_cycles SET status = ?, activated_at = ?, done_at = ?,
           active_ms_accumulated = ?
         WHERE project_key = ? AND cycle_id = ?`,
      )
      .run(to, activatedAt, doneAt, activeMsAccumulated, projectKey, cycleId);
    this.emit("events", projectKey);
    return {
      id: row.cycle_id,
      label: row.label,
      kind: row.kind as CycleKind,
      status: to,
      ...(activatedAt !== null ? { activatedAt } : {}),
      ...(doneAt !== null ? { doneAt } : {}),
    };
  }

  /**
   * CR-CRU-024 §S3.2 — edit a cycle's label. Legal ONLY while the cycle is
   * `pending`: the active cycle is LOCKED and terminal cycles are immutable
   * HISTORY. Mirrors transitionCycle's row-lookup + guard structure; returns
   * distinct codes so the route maps the matching help[]. No partial state —
   * a refusal leaves the label untouched.
   */
  editCycleLabel(
    projectKey: string,
    planId: number,
    cycleId: number,
    label: string,
  ): PlanCycle | PlanOpError {
    const row = this.db
      .query<PlanCycleRow, [string, number, number]>(
        `SELECT * FROM plan_cycles WHERE project_key = ? AND plan_id = ? AND cycle_id = ?`,
      )
      .get(projectKey, planId, cycleId);
    if (row === null) {
      return { error: `cycle not found in plan ${planId}: ${cycleId}`, notFound: true };
    }
    if (row.status === "active") {
      return {
        error: "the active cycle is locked — confirm or fail it first",
        code: "locked",
      };
    }
    if (row.status !== "pending") {
      return {
        error: "done/skipped/failed cycles are immutable history",
        code: "immutable-history",
      };
    }
    this.db
      .query(
        `UPDATE plan_cycles SET label = ? WHERE project_key = ? AND plan_id = ? AND cycle_id = ?`,
      )
      .run(label, projectKey, planId, cycleId);
    this.emit("events", projectKey);
    return {
      id: row.cycle_id,
      label,
      kind: row.kind as CycleKind,
      status: row.status as CycleStatus,
      ...(row.activated_at !== null ? { activatedAt: row.activated_at } : {}),
      ...(row.done_at !== null ? { doneAt: row.done_at } : {}),
    };
  }

  /** §S0 — the CR close (feature merge). Rejects while any cycle is non-terminal. */
  closePlan(
    projectKey: string,
    planId: number,
    merge?: { commit: string },
  ): Plan | PlanOpError {
    const row = this.getPlanRow(projectKey, planId);
    if (row === null) {
      return { error: `plan not found: ${planId}`, notFound: true };
    }
    if (row.status === "closed") {
      return { error: `plan ${planId} is already closed` };
    }
    // CR-CRU-048 §S2 — the filtering (CYCLE_TERMINAL = done|skipped|failed) is
    // unchanged; only the REPORTING gains each blocking cycle's label.
    const openCycleRefs = this.listCycleRows(projectKey, planId)
      .filter((cycle) => !Store.CYCLE_TERMINAL.has(cycle.status))
      .map((cycle) => ({ id: cycle.cycle_id, label: cycle.label }));
    if (openCycleRefs.length > 0) {
      const named = openCycleRefs.map((c) => `${c.id} ("${c.label}")`).join(", ");
      return {
        error: `cannot close plan ${planId}: non-terminal cycles: ${named}`,
        openCycleIds: openCycleRefs.map((c) => c.id),
        openCycleRefs,
      };
    }
    const closedAt = Date.now();
    this.db
      .query(`UPDATE plans SET status = 'closed', merge_commit = ?, closed_at = ? WHERE plan_id = ?`)
      .run(merge?.commit ?? null, closedAt, planId);
    this.emit("events", projectKey);
    return this.toPlan({
      ...row,
      status: "closed",
      merge_commit: merge?.commit ?? null,
      closed_at: closedAt,
    });
  }

  /**
   * CR-CRU-024 §S6 — abort an OPEN plan (user-approved at the route). The
   * ACTIVE cycle → `failed` with its timer SEALED honestly (the same epoch-fold
   * transitionCycle applies on leaving `active`: accumulated += now −
   * max(activatedAt, bootedAt, lastCheckpoint), then the epoch checkpoint is
   * dropped so a store-reopen resumes the sealed value exactly, never drifting
   * with downtime); every PENDING cycle → `skipped`; the plan status →
   * `aborted`. Closed/aborted/unknown plans reject (only an open plan aborts).
   */
  abortPlan(projectKey: string, planId: number): Plan | PlanOpError {
    const row = this.getPlanRow(projectKey, planId);
    if (row === null) {
      return { error: `plan not found: ${planId}`, notFound: true };
    }
    if (row.status !== "open") {
      return { error: `plan ${planId} is ${row.status} — only an open plan can be aborted` };
    }
    const now = Date.now();
    for (const cycle of this.listCycleRows(projectKey, planId)) {
      if (cycle.status === "active") {
        // Seal the timer: fold the live epoch into accumulated (like
        // transitionCycle on leaving active) and stamp done_at NOW, so the
        // sealed activatedAt/doneAt span stays honest across a restart.
        const epochStart = this.epochStart(projectKey, cycle.cycle_id, cycle.activated_at ?? now);
        const activeMsAccumulated =
          (cycle.active_ms_accumulated ?? 0) + Math.max(0, now - epochStart);
        this.epochCheckpointAt.delete(this.epochKey(projectKey, cycle.cycle_id));
        this.db
          .query(
            `UPDATE plan_cycles SET status = 'failed', done_at = ?, active_ms_accumulated = ?
             WHERE project_key = ? AND cycle_id = ?`,
          )
          .run(now, activeMsAccumulated, projectKey, cycle.cycle_id);
      } else if (cycle.status === "pending") {
        this.db
          .query(
            `UPDATE plan_cycles SET status = 'skipped', done_at = ?
             WHERE project_key = ? AND cycle_id = ?`,
          )
          .run(now, projectKey, cycle.cycle_id);
      }
    }
    this.db.query(`UPDATE plans SET status = 'aborted' WHERE plan_id = ?`).run(planId);
    this.emit("events", projectKey);
    return this.toPlan({ ...row, status: "aborted" });
  }

  /**
   * §S6 re-baseline (cycle 19) — one-field orchestrator backfill on an OPEN
   * plan (stamping the executing plan); closed plans reject.
   */
  stampOrchestrator(
    projectKey: string,
    planId: number,
    orchestrator: string,
  ): Plan | PlanOpError {
    const row = this.getPlanRow(projectKey, planId);
    if (row === null) {
      return { error: `plan not found: ${planId}`, notFound: true };
    }
    if (row.status !== "open") {
      return { error: `plan ${planId} is closed — orchestrator backfill applies to open plans only` };
    }
    this.db
      .query(`UPDATE plans SET orchestrator = ? WHERE plan_id = ?`)
      .run(orchestrator, planId);
    this.emit("events", projectKey);
    return this.toPlan({ ...row, orchestrator });
  }

  /**
   * CR-CRU-031 §S1 — one-field `wave` backfill. Unlike stampOrchestrator this
   * stamps OPEN and CLOSED plans alike (waves are assigned retroactively). No
   * events/rollup change beyond the plans-list refresh. Caller coerces the
   * value to its decimal string, matching the POST /plans path.
   */
  stampWave(projectKey: string, planId: number, wave: string): Plan | PlanOpError {
    const row = this.getPlanRow(projectKey, planId);
    if (row === null) {
      return { error: `plan not found: ${planId}`, notFound: true };
    }
    this.db.query(`UPDATE plans SET wave = ? WHERE plan_id = ?`).run(wave, planId);
    this.emit("events", projectKey);
    return this.toPlan({ ...row, wave });
  }

  /**
   * CR-CRU-024 §S7 — resolve a run ingest's context.cycleId against stored plan
   * state (Crucible is the source of truth, not the client). Scans EVERY plan of
   * THIS project — scoping is strictly per-project, so a cycle id minted in
   * another project never resolves here. Returns the cycle's status and a
   * `terminal` flag (done/skipped/failed), or null when no plan carries the id.
   */
  findCycle(
    projectKey: string,
    cycleId: number,
  ): { cycleId: number; planId: number; status: string; terminal: boolean } | null {
    const row = this.db
      .query<PlanCycleRow, [string, number]>(
        `SELECT * FROM plan_cycles WHERE project_key = ? AND cycle_id = ?`,
      )
      .get(projectKey, cycleId);
    if (row === null) return null;
    return {
      cycleId: row.cycle_id,
      planId: row.plan_id,
      status: row.status,
      terminal: Store.CYCLE_TERMINAL.has(row.status),
    };
  }

  /**
   * CR-CRU-032 §S1 — resolve a cycle's declared boundary as a full PlanCycle
   * (`{id, label, kind, status, activatedAt?, doneAt?}`), shaped exactly like
   * the entries `toPlan` returns to clients. Reuses findCycle's row lookup;
   * returns null for an unknown cycleId so the route can OMIT the field.
   */
  findCyclePlanEntry(projectKey: string, cycleId: number): PlanCycle | null {
    const row = this.db
      .query<PlanCycleRow, [string, number]>(
        `SELECT * FROM plan_cycles WHERE project_key = ? AND cycle_id = ?`,
      )
      .get(projectKey, cycleId);
    if (row === null) return null;
    return {
      id: row.cycle_id,
      label: row.label,
      kind: row.kind as CycleKind,
      status: row.status as CycleStatus,
      ...(row.activated_at !== null ? { activatedAt: row.activated_at } : {}),
      ...(row.done_at !== null ? { doneAt: row.done_at } : {}),
    };
  }

  /**
   * CR-CRU-024 §S7 — summarize the project's open plan for the unknown-cycle
   * help[]: the cr and its known cycle ids so a mis-set explicit context.cycleId
   * can be corrected to a real one — or the caller re-registered bound to that
   * cycle (CR-CRU-056). Returns null when the project has no open plan.
   */
  openPlanCycleSummary(projectKey: string): { cr: string; planId: number; cycleIds: number[] } | null {
    const row = this.db
      .query<PlanRow, [string]>(
        `SELECT * FROM plans WHERE project_key = ? AND status = 'open' ORDER BY plan_id ASC`,
      )
      .get(projectKey);
    if (row === null) return null;
    const cycleIds = this.listCycleRows(projectKey, row.plan_id).map((c) => c.cycle_id);
    return { cr: row.cr, planId: row.plan_id, cycleIds };
  }

  /** §S0 — list a project's plans, optionally filtered by cr / track. */
  listPlans(projectKey: string, filter?: { cr?: string; track?: string }): Plan[] {
    const rows = this.db
      .query<PlanRow, [string]>(
        `SELECT * FROM plans WHERE project_key = ? ORDER BY plan_id ASC`,
      )
      .all(projectKey);
    return rows
      .filter(
        (row) =>
          (filter?.cr === undefined || row.cr === filter.cr) &&
          (filter?.track === undefined || row.track === filter.track),
      )
      .map((row) => this.toPlan(row));
  }

  // ── CR-CRU-014 §S1 — the CR execution queue ─────────────────────────────

  /**
   * CR-CRU-014 §S1 — FULL-REPLACE a project's queue in one transaction: the
   * prior rows are deleted and the posted set inserted wholesale, so absent
   * entries vanish, re-posted entries carry no duplicates, and an edited wave
   * takes effect. Notifies through the SAME onChange path SSE consumes (the
   * existing "events" kind — the roadmap renders on that surface).
   */
  replaceQueue(projectKey: string, entries: QueueEntryInput[]): void {
    const now = Date.now();
    const replace = this.db.transaction(() => {
      this.db.query(`DELETE FROM queue_entries WHERE project_key = ?`).run(projectKey);
      entries.forEach((entry, index) => {
        this.db
          .query(
            `INSERT INTO queue_entries
               (project_key, cr, title, wave, depends_on_json, size, filed_at, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            projectKey,
            entry.cr,
            entry.title ?? null,
            entry.wave,
            JSON.stringify(entry.dependsOn),
            entry.size ?? null,
            now,
            index,
          );
      });
    });
    replace();
    this.emit("events", projectKey);
  }

  /**
   * CR-CRU-014 §S1 — the project's queue with each entry's DERIVED status
   * (never stored): PENDING when no plan exists for the cr, IN_PROGRESS when
   * an open plan does, COMPLETED when a plan is closed WITH a merge commit.
   * `planId` is the linked plan's id, present only when a plan exists.
   * Archived projects are excluded via the shared NOT_ARCHIVED subquery
   * (rows survive; unarchive restores them) — the listReleases precedent.
   */
  listQueue(projectKey: string): QueueEntry[] {
    const rows = this.db
      .query<QueueEntryRow, [string]>(
        `SELECT * FROM queue_entries WHERE project_key = ? AND ${Store.NOT_ARCHIVED_SUBQUERY}
         ORDER BY seq ASC`,
      )
      .all(projectKey);
    return rows.map((row) => {
      const derived = this.deriveQueueStatus(projectKey, row.cr);
      return {
        cr: row.cr,
        ...(row.title !== null ? { title: row.title } : {}),
        wave: row.wave,
        dependsOn: JSON.parse(row.depends_on_json) as string[],
        ...(row.size !== null ? { size: row.size } : {}),
        status: derived.status,
        ...(derived.planId !== undefined ? { planId: derived.planId } : {}),
      };
    });
  }

  /** CR-CRU-014 §S1 — derive a cr's queue status + plan link from its plans. */
  private deriveQueueStatus(
    projectKey: string,
    cr: string,
  ): { status: QueueStatus; planId?: number } {
    const plans = this.listPlans(projectKey, { cr });
    if (plans.length === 0) {
      return { status: "PENDING" };
    }
    const open = plans.find((plan) => plan.status === "open");
    if (open !== undefined) {
      return { status: "IN_PROGRESS", planId: open.planId };
    }
    const completed = plans.find(
      (plan) => plan.status === "closed" && plan.merge !== undefined,
    );
    if (completed !== undefined) {
      return { status: "COMPLETED", planId: completed.planId };
    }
    return { status: "PENDING", planId: plans[plans.length - 1]!.planId };
  }

  /**
   * CR-CRU-023 §S3 (a) — derive an ACTIVE cycle's accumulated attention time
   * and, when the live epoch has run >=60s past the last durable write, fold
   * it into `active_ms_accumulated` synchronously (one UPDATE) and re-anchor
   * the epoch at the persist moment. The cadence bounds write frequency under
   * constant UI polling; no change event is emitted (the value is derived on
   * every read anyway). Restart resumes from the persisted setpoint, losing
   * at most one <=60s window — never the full epoch, never scaled to downtime.
   */
  private deriveAndCheckpointActiveMs(cycle: PlanCycleRow, activatedAt: number): number {
    const now = Date.now();
    const epochStart = this.epochStart(cycle.project_key, cycle.cycle_id, activatedAt);
    const liveEpochMs = Math.max(0, now - epochStart);
    const activeMs = (cycle.active_ms_accumulated ?? 0) + liveEpochMs;
    if (liveEpochMs >= Store.ACTIVE_MS_CHECKPOINT_CADENCE_MS) {
      this.db
        .query(
          `UPDATE plan_cycles SET active_ms_accumulated = ?
           WHERE project_key = ? AND cycle_id = ?`,
        )
        .run(activeMs, cycle.project_key, cycle.cycle_id);
      this.epochCheckpointAt.set(this.epochKey(cycle.project_key, cycle.cycle_id), now);
    }
    return activeMs;
  }

  /**
   * CR-CRU-024 §S5.1 — force-fold an ACTIVE cycle row's live epoch into the
   * persisted `active_ms_accumulated` and re-anchor the epoch at NOW. Mirrors
   * deriveAndCheckpointActiveMs's epoch math WITHOUT the >=60s cadence gate —
   * the fold fires synchronously — so a store-reopen resumes the checkpointed
   * value EXACTLY (bootedAt re-anchoring on restart excludes downtime, and the
   * re-anchored checkpoint means the folded window is never counted twice).
   */
  private foldActiveEpoch(cycle: PlanCycleRow): void {
    const now = Date.now();
    const epochStart = this.epochStart(cycle.project_key, cycle.cycle_id, cycle.activated_at ?? 0);
    const activeMs = (cycle.active_ms_accumulated ?? 0) + Math.max(0, now - epochStart);
    this.db
      .query(
        `UPDATE plan_cycles SET active_ms_accumulated = ?
         WHERE project_key = ? AND cycle_id = ?`,
      )
      .run(activeMs, cycle.project_key, cycle.cycle_id);
    this.epochCheckpointAt.set(this.epochKey(cycle.project_key, cycle.cycle_id), now);
  }

  /**
   * CR-CRU-024 §S5.1 — the plan checkpoint verb: fold the plan's ACTIVE
   * cycle's epoch NOW (one durable write) and re-anchor. A no-op when no cycle
   * is active (`changed:false`); an unknown plan is a notFound error the route
   * maps to 404.
   */
  checkpointPlan(projectKey: string, planId: number): { changed: boolean } | PlanOpError {
    if (this.getPlanRow(projectKey, planId) === null) {
      return { error: `plan not found: ${planId}`, notFound: true };
    }
    const active = this.listCycleRows(projectKey, planId).find((c) => c.status === "active");
    if (active === undefined) {
      return { changed: false };
    }
    this.foldActiveEpoch(active);
    this.emit("events", projectKey);
    return { changed: true };
  }

  /**
   * CR-CRU-024 §S5.2 — store-wide graceful-stop fold: checkpoint EVERY active
   * cycle across ALL plans and ALL projects in one call and return the count.
   * This is the exact call the server's SIGTERM/SIGINT handler makes before
   * exit so an orderly stop never loses timer state.
   */
  checkpointAllActive(): number {
    const active = this.db
      .query<PlanCycleRow, []>(`SELECT * FROM plan_cycles WHERE status = 'active'`)
      .all();
    for (const cycle of active) {
      this.foldActiveEpoch(cycle);
    }
    return active.length;
  }

  /**
   * CR-CRU-024 §S5.3 — project stop: checkpoint every active cycle across the
   * project's OPEN plans (the §S5.1 fold, project-wide) and return the count.
   * Distinct from archive — it only folds timers, never changes plan status.
   */
  stopProject(projectKey: string): number {
    const active = this.db
      .query<PlanCycleRow, [string]>(
        `SELECT c.* FROM plan_cycles c
         JOIN plans p ON p.project_key = c.project_key AND p.plan_id = c.plan_id
         WHERE c.project_key = ? AND c.status = 'active' AND p.status = 'open'`,
      )
      .all(projectKey);
    for (const cycle of active) {
      this.foldActiveEpoch(cycle);
    }
    if (active.length > 0) {
      this.emit("events", projectKey);
    }
    return active.length;
  }

  private toPlan(row: PlanRow): Plan {
    const cycles: PlanCycle[] = this.listCycleRows(row.project_key, row.plan_id).map(
      (cycle) => ({
        id: cycle.cycle_id,
        label: cycle.label,
        kind: cycle.kind as CycleKind,
        status: cycle.status as CycleStatus,
        // §S0b — transition timestamps surface on plan reads (omitted, not
        // null, until stamped — same convention as Plan.closedAt).
        ...(cycle.activated_at !== null ? { activatedAt: cycle.activated_at } : {}),
        ...(cycle.done_at !== null ? { doneAt: cycle.done_at } : {}),
        // CR-CRU-023 §S3 (a) — ACTIVE cycles carry the derived accumulated
        // attention time: persisted checkpoint + the live epoch anchored at
        // max(activatedAt, bootedAt, last checkpoint). Deriving it also
        // checkpoints it durably at a <=60s cadence (the designed read-path
        // piggyback — a crash loses at most one checkpoint window, never the
        // whole epoch). Sealed/pending rows are untouched.
        ...(cycle.status === "active" && cycle.activated_at !== null
          ? { activeMs: this.deriveAndCheckpointActiveMs(cycle, cycle.activated_at) }
          : {}),
      }),
    );
    const plan: Plan = {
      planId: row.plan_id,
      projectKey: row.project_key,
      cr: row.cr,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.orchestrator !== null ? { orchestrator: row.orchestrator } : {}),
      ...(row.wave !== null ? { wave: row.wave } : {}),
      ...(row.track !== null ? { track: row.track } : {}),
      // CR-CRU-024 §S6 — preserve the real terminal status. The prior collapse
      // (`row.status === "closed" ? "closed" : "open"`) mapped ANY non-closed
      // status (including the new "aborted") to "open", which hid aborted plans
      // from the history lens and let the one-open-plan-per-cr rule mis-see
      // them as open. "open"/"closed" behaviour is unchanged.
      status:
        row.status === "closed" ? "closed" : row.status === "aborted" ? "aborted" : "open",
      cycles,
      ...(row.merge_commit !== null ? { merge: { commit: row.merge_commit } } : {}),
      ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
    };
    const boundary = this.deriveCommitBoundary(plan);
    return boundary !== undefined ? { ...plan, commitBoundary: boundary } : plan;
  }

  /**
   * §S0 commit boundary — derived read-only on CLOSED plans: branch + the
   * earliest/latest linked-run commits from the runs' `context.git`, linked
   * via `context.cycleId`. Absent fields are OMITTED (never null).
   */
  private deriveCommitBoundary(plan: Plan): CommitBoundary | undefined {
    if (plan.status !== "closed" || plan.merge === undefined || plan.closedAt === undefined) {
      return undefined;
    }
    const cycleIds = new Set(plan.cycles.map((cycle) => cycle.id));
    const rows = this.db
      .query<EventRow, [string]>(
        `SELECT * FROM events WHERE project_key = ? AND context IS NOT NULL
         ORDER BY timestamp ASC, rowid ASC`,
      )
      .all(plan.projectKey);
    let branch: string | undefined;
    let firstRunCommit: string | undefined;
    let lastRunCommit: string | undefined;
    for (const row of rows) {
      const context = JSON.parse(row.context!) as RunContext;
      if (typeof context.cycleId !== "number" || !cycleIds.has(context.cycleId)) {
        continue;
      }
      if (context.git === undefined) {
        continue;
      }
      branch ??= context.git.branch;
      firstRunCommit ??= context.git.commit;
      lastRunCommit = context.git.commit;
    }
    return {
      mergeCommit: plan.merge.commit,
      ...(branch !== undefined ? { branch } : {}),
      ...(firstRunCommit !== undefined ? { firstRunCommit } : {}),
      ...(lastRunCommit !== undefined ? { lastRunCommit } : {}),
      closedAt: plan.closedAt,
    };
  }


  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** CR-CRU-004 §S3 — current onChange subscriber count (leak detection). */
  listenerCount(): number {
    return this.listeners.size;
  }

  private emit(kind: ChangeKind, projectKey?: string): void {
    for (const listener of this.listeners) {
      listener(kind, projectKey);
    }
  }

  // ── Liveness (§S3 — computed, never stored) ───────────────────────────

  livenessConfig(projectKey: string): LivenessConfig {
    const project = this.getProject(projectKey);
    return { ...DEFAULT_LIVENESS, ...project?.liveness };
  }

  livenessOf(agent: Agent, now: number = Date.now()): Liveness {
    const { staleAfterMs, tombstoneAfterMs, pruneAfterMs } = this.livenessConfig(
      agent.projectKey,
    );
    const silence = now - agent.lastSeen;
    if (silence >= pruneAfterMs) return "pruned";
    if (silence >= tombstoneAfterMs) return "tombstoned";
    if (silence >= staleAfterMs) return "stale";
    return "online";
  }

  private static toAgent(row: AgentRow): Agent {
    return {
      agentId: row.agent_id,
      projectKey: row.project_key,
      status: row.status === "busy" ? "busy" : "online",
      message: row.message,
      identity: JSON.parse(row.identity) as AgentIdentity,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      // CR-CRU-044 §S1(d) — absent for historical rows (NULL column), never
      // back-filled or fabricated.
      ...(row.role !== null && row.role !== undefined
        ? { role: row.role as AgentRole }
        : {}),
      // CR-CRU-056 §S1 — absent for unbound / historical rows (NULL column).
      ...(row.bound_cycle_id !== null && row.bound_cycle_id !== undefined
        ? { boundCycleId: row.bound_cycle_id }
        : {}),
    };
  }
}
