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

interface ProjectRow {
  key: string;
  name: string;
  type: string;
  sut_root: string;
  created_at: number;
  liveness: string | null;
  retention: number | null;
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

  constructor(path: string) {
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
        retention INTEGER
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
        first_seen INTEGER
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
  }

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

  listProjects(): Project[] {
    const rows = this.db
      .query<ProjectRow, []>(`SELECT * FROM projects ORDER BY created_at ASC`)
      .all();
    return rows.map(Store.toProject);
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
    const rows =
      projectKey === undefined
        ? this.db.query<AgentRow, []>(`SELECT * FROM agents ORDER BY last_seen DESC`).all()
        : this.db
            .query<AgentRow, [string]>(
              `SELECT * FROM agents WHERE project_key = ? ORDER BY last_seen DESC`,
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
    const rows =
      projectKey === undefined
        ? this.db
            .query<EventRow, [number]>(
              `SELECT * FROM events ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
            )
            .all(limit)
        : this.db
            .query<EventRow, [string, number]>(
              `SELECT * FROM events WHERE project_key = ?
               ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
            )
            .all(projectKey, limit);
    return rows.map(Store.toEvent);
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
    this.db
      .query(
        `INSERT INTO events (id, project_key, agent_id, kind, tier, stack, codec,
           timestamp, name, total, passed, failed, pending, duration_ms,
           tree, coverage, compile, context, action, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    this.enforceRetention(event.projectKey);
    this.emit("events", event.projectKey);
  }

  private static toEvent(row: EventRow): RunEvent {
    return {
      id: row.id,
      projectKey: row.project_key,
      agentId: row.agent_id,
      kind: row.kind === "compile" ? "compile" : row.kind === "lifecycle" ? "lifecycle" : "test",
      tier: row.tier as Tier,
      timestamp: row.timestamp,
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
        `SELECT * FROM rollups WHERE project_key = ? ORDER BY rowid ASC`,
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
        // CR-CRU-011 §S1 — lifecycle events flow through retention like any
        // event but contribute NOTHING to the test-run rollup folds.
        if (row.kind !== "lifecycle") {
          this.foldIntoRollup(row);
        }
        this.db.query(`DELETE FROM events WHERE id = ?`).run(row.id);
      }
    })();
  }

  private foldIntoRollup(row: EventRow): void {
    const context =
      row.context !== null ? (JSON.parse(row.context) as RunContext) : undefined;
    // Bucket key: context.wave when present, else the UTC day of the event.
    const bucket = context?.wave ?? new Date(row.timestamp).toISOString().slice(0, 10);
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
    return this.db
      .query<PlanCycleRow, [string, number]>(
        `SELECT * FROM plan_cycles WHERE project_key = ? AND plan_id = ?
         ORDER BY cycle_id ASC`,
      )
      .all(projectKey, planId);
  }

  private insertCycle(
    projectKey: string,
    planId: number,
    label: string,
    kind: CycleKind,
  ): PlanCycle {
    const id = this.nextCycleId(projectKey);
    this.db
      .query(
        `INSERT INTO plan_cycles (project_key, cycle_id, plan_id, label, kind, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      )
      .run(projectKey, id, planId, label, kind);
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
      this.insertCycle(projectKey, planId, cycle.label, cycle.kind),
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

  /** §S0 — append a cycle to an OPEN plan; returns the new project-unique id. */
  appendCycle(
    projectKey: string,
    planId: number,
    cycle: { label: string; kind: CycleKind },
  ): PlanCycle | PlanOpError {
    const plan = this.getPlanRow(projectKey, planId);
    if (plan === null) {
      return { error: `plan not found: ${planId}`, notFound: true };
    }
    if (plan.status !== "open") {
      return { error: `plan ${planId} is closed — cannot append cycles` };
    }
    const appended = this.insertCycle(projectKey, planId, cycle.label, cycle.kind);
    this.emit("events", projectKey);
    return appended;
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
      return { error: `illegal cycle transition: ${row.status} -> ${to}` };
    }
    // §S0b — stamp the transition timestamps (mirrors Plan.closedAt):
    // pending→active stamps activated_at; reaching a terminal state stamps
    // done_at. The timeline's declared marker derives active→done from them.
    const now = Date.now();
    const activatedAt = to === "active" ? now : row.activated_at;
    const doneAt = Store.CYCLE_TERMINAL.has(to) ? now : row.done_at;
    this.db
      .query(
        `UPDATE plan_cycles SET status = ?, activated_at = ?, done_at = ?
         WHERE project_key = ? AND cycle_id = ?`,
      )
      .run(to, activatedAt, doneAt, projectKey, cycleId);
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
      status: row.status === "closed" ? "closed" : "open",
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
