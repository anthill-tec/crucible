// CR-CRU-001 §S2 — SQLite store on bun:sqlite (C1: projects + agents, C3: events + retention)

import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { DEFAULT_LIVENESS } from "./types.ts";
import type {
  Agent,
  AgentIdentity,
  CommitBoundary,
  Coverage,
  CycleKind,
  CycleStatus,
  LivenessConfig,
  Plan,
  PlanCycle,
  Project,
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
}

export interface TouchAgentOpts {
  status?: Agent["status"];
  message?: string;
  identity?: AgentIdentity;
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
}

export type ChangeKind = "projects" | "agents" | "events";
export type ChangeListener = (kind: ChangeKind, projectKey?: string) => void;

/** §S4 — default raw-event retention cap per project. */
const DEFAULT_RETENTION = 100;

/** CR-CRU-002 §S4 — project keys are UUIDs; ingest routes validate against this. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Store {
  private readonly db: Database;
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

  constructor(path: string) {
    this.bootedAt = Date.now();
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.createTables();
  }

  /**
   * §S5 boot safety — open a store at `path`, surviving a corrupt/unreadable db.
   * A bad file is renamed aside to `<path>.corrupt-<epoch>` and a fresh db is
   * opened at the original path. Boot must never fail because of a bad file.
   */
  static open(path: string): Store {
    try {
      const store = new Store(path);
      // bun:sqlite may defer failure past open — force it with a trivial query.
      store.db.query("PRAGMA schema_version").get();
      return store;
    } catch (error) {
      const corruptPath = `${path}.corrupt-${Date.now()}`;
      console.error(
        `[crucible] CORRUPT DATABASE at ${path} — moving it aside to ${corruptPath} and starting with a fresh db (${String(error)})`,
      );
      renameSync(path, corruptPath);
      return new Store(path);
    }
  }

  private createTables(): void {
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
        payload TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_project_timestamp
        ON events (project_key, timestamp);

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
    `);
    // CR-CRU-011 §S1 — additive columns for lifecycle events; pre-011 db
    // files lack them (CREATE TABLE IF NOT EXISTS never retrofits columns).
    const eventCols = new Set(
      this.db
        .query<{ name: string }, []>(`PRAGMA table_info(events)`)
        .all()
        .map((col) => col.name),
    );
    if (!eventCols.has("action")) {
      this.db.exec(`ALTER TABLE events ADD COLUMN action TEXT`);
    }
    if (!eventCols.has("first_seen")) {
      this.db.exec(`ALTER TABLE events ADD COLUMN first_seen INTEGER`);
    }
    // CR-CRU-013 §S1+§S4b — additive generic payload column for gate/milestone
    // kind-specific fields; pre-013 db files lack it (same PRAGMA-checked
    // retrofit pattern as action/first_seen above).
    if (!eventCols.has("payload")) {
      this.db.exec(`ALTER TABLE events ADD COLUMN payload TEXT`);
    }
    // CR-CRU-011 §S0b — additive cycle-timestamp columns; pre-C4 db files
    // lack them (same PRAGMA-checked retrofit pattern as events above).
    const cycleCols = new Set(
      this.db
        .query<{ name: string }, []>(`PRAGMA table_info(plan_cycles)`)
        .all()
        .map((col) => col.name),
    );
    if (!cycleCols.has("activated_at")) {
      this.db.exec(`ALTER TABLE plan_cycles ADD COLUMN activated_at INTEGER`);
    }
    if (!cycleCols.has("done_at")) {
      this.db.exec(`ALTER TABLE plan_cycles ADD COLUMN done_at INTEGER`);
    }
    // CR-CRU-023 §S3 (a) — additive accumulated-attention column; pre-023
    // db files lack it (same PRAGMA-checked retrofit pattern as above).
    if (!cycleCols.has("active_ms_accumulated")) {
      this.db.exec(`ALTER TABLE plan_cycles ADD COLUMN active_ms_accumulated INTEGER`);
    }
    // CR-CRU-024 §S3.1 — additive display-order column; pre-024 db files lack
    // it (same PRAGMA-checked retrofit pattern as above). Order-preserving
    // backfill: seq = cycle_id for existing rows so pre-insert-before plans
    // keep their historical (cycle_id-ascending) display order unchanged.
    if (!cycleCols.has("seq")) {
      this.db.exec(`ALTER TABLE plan_cycles ADD COLUMN seq REAL`);
      this.db.exec(`UPDATE plan_cycles SET seq = cycle_id WHERE seq IS NULL`);
    }
    // CR-CRU-021 §S6.11 — additive plan title column; pre-021 db files lack
    // it (same PRAGMA-checked retrofit pattern as events/plan_cycles above).
    const planCols = new Set(
      this.db
        .query<{ name: string }, []>(`PRAGMA table_info(plans)`)
        .all()
        .map((col) => col.name),
    );
    if (!planCols.has("title")) {
      this.db.exec(`ALTER TABLE plans ADD COLUMN title TEXT`);
    }
    // CR-CRU-021 §S6 re-baseline (cycle 19) — additive plan orchestrator
    // column; pre-cycle-19 db files lack it (same PRAGMA-checked pattern).
    if (!planCols.has("orchestrator")) {
      this.db.exec(`ALTER TABLE plans ADD COLUMN orchestrator TEXT`);
    }
    // CR-CRU-012 §S1b — additive archive-timestamp column; pre-012 db files
    // lack it (same PRAGMA-checked retrofit pattern as above).
    const projectCols = new Set(
      this.db
        .query<{ name: string }, []>(`PRAGMA table_info(projects)`)
        .all()
        .map((col) => col.name),
    );
    if (!projectCols.has("archived_at")) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN archived_at INTEGER`);
    }
    // CR-CRU-008 §S4 — additive guarded-deletion config column; pre-008 db
    // files lack it (same PRAGMA-checked retrofit pattern as above).
    if (!projectCols.has("allow_run_deletion")) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN allow_run_deletion INTEGER`);
    }
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
      };
      this.db
        .query(
          `INSERT INTO agents (project_key, agent_id, status, message, identity, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          agent.projectKey,
          agent.agentId,
          agent.status,
          agent.message,
          JSON.stringify(agent.identity),
          agent.firstSeen,
          agent.lastSeen,
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
    };
    this.db
      .query(
        `UPDATE agents SET status = ?, message = ?, identity = ?, last_seen = ?
         WHERE project_key = ? AND agent_id = ?`,
      )
      .run(agent.status, agent.message, JSON.stringify(agent.identity), agent.lastSeen, projectKey, agentId);
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
      ...(meta?.stack !== undefined ? { stack: meta.stack } : {}),
      ...(meta?.codec !== undefined ? { codec: meta.codec } : {}),
      ...(meta?.name !== undefined ? { name: meta.name } : {}),
      ...(meta?.context !== undefined ? { context: meta.context } : {}),
    };
    this.insertEvent(event);
    return event;
  }

  recordCompileEvent(
    projectKey: string,
    agentId: string,
    compile: unknown,
    meta?: Pick<RecordEventMeta, "tier" | "stack" | "context" | "codec">,
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
    };
    this.insertEvent(event);
    return event;
  }

  /**
   * CR-CRU-013 §S1 — append a gate event (a no-mistakes gate outcome). The
   * full gate object is stored verbatim in the generic payload column; codec
   * is fixed to "no-mistakes". Flows through retention like any event;
   * foldIntoRollup skips it (gate is not a rollup-eligible kind).
   */
  recordGateEvent(
    projectKey: string,
    agentId: string,
    gate: unknown,
    meta?: { context?: RunContext },
  ): RunEvent {
    this.touchAgent(projectKey, agentId);
    const event: RunEvent = {
      id: this.nextEventId(),
      projectKey,
      agentId,
      kind: "gate",
      tier: "unit",
      codec: "no-mistakes",
      timestamp: Date.now(),
      gate,
      ...(meta?.context !== undefined ? { context: meta.context } : {}),
    };
    this.insertEvent(event);
    return event;
  }

  /**
   * CR-CRU-013 §S4b/§S4c — append a milestone event. The flat type/label/
   * commit fields live in the generic payload column; context round-trips
   * verbatim. Rollup-excluded (not a rollup-eligible kind).
   */
  recordMilestoneEvent(
    projectKey: string,
    agentId: string,
    type: string,
    meta?: { label?: string; commit?: string; context?: RunContext },
  ): RunEvent {
    this.touchAgent(projectKey, agentId);
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
      ...(meta?.context !== undefined ? { context: meta.context } : {}),
    };
    this.insertEvent(event);
    return event;
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

  listEvents(projectKey?: string, limit = 50): RunEvent[] {
    // CR-CRU-012 §S1b — archived projects' events are excluded (not deleted).
    const rows =
      projectKey === undefined
        ? this.db
            .query<EventRow, [number]>(
              `SELECT * FROM events WHERE ${Store.NOT_ARCHIVED_SUBQUERY}
               ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
            )
            .all(limit)
        : this.db
            .query<EventRow, [string, number]>(
              `SELECT * FROM events WHERE project_key = ? AND ${Store.NOT_ARCHIVED_SUBQUERY}
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

  private insertEvent(event: RunEvent): void {
    // CR-CRU-013 §S1+§S4b — collect the kind-specific carrying fields into the
    // one generic payload column (NULL when the event carries none).
    const payloadObj: Record<string, unknown> = {
      ...(event.gate !== undefined ? { gate: event.gate } : {}),
      ...(event.type !== undefined ? { type: event.type } : {}),
      ...(event.label !== undefined ? { label: event.label } : {}),
      ...(event.commit !== undefined ? { commit: event.commit } : {}),
    };
    const payload = Object.keys(payloadObj).length > 0 ? JSON.stringify(payloadObj) : null;
    this.db
      .query(
        `INSERT INTO events (id, project_key, agent_id, kind, tier, stack, codec,
           timestamp, name, total, passed, failed, pending, duration_ms,
           tree, coverage, compile, context, action, first_seen, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const count = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events WHERE project_key = ?`,
      )
      .get(projectKey)!.n;
    const overflow = count - cap;
    if (overflow <= 0) {
      return;
    }
    const expired = this.db
      .query<EventRow, [string, number]>(
        `SELECT * FROM events WHERE project_key = ?
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
    const openCycleIds = this.listCycleRows(projectKey, planId)
      .filter((cycle) => !Store.CYCLE_TERMINAL.has(cycle.status))
      .map((cycle) => cycle.cycle_id);
    if (openCycleIds.length > 0) {
      return {
        error: `cannot close plan ${planId}: non-terminal cycles: ${openCycleIds.join(", ")}`,
        openCycleIds,
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
   * help[]: the cr and its known cycle ids so a mis-set WORKFLOW_CYCLE_ID can be
   * corrected to a real one. Returns null when the project has no open plan.
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
    };
  }
}
