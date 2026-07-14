// CR-CRU-001 §S2 — SQLite store on bun:sqlite (C1: projects + agents, C3: events + retention)

import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { DEFAULT_LIVENESS } from "./types.ts";
import type {
  Agent,
  AgentIdentity,
  Coverage,
  LivenessConfig,
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
        context TEXT
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
    `);
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
    if (projectKey === undefined) {
      this.db.query(`DELETE FROM agents WHERE agent_id = ?`).run(agentId);
    } else {
      this.db
        .query(`DELETE FROM agents WHERE project_key = ? AND agent_id = ?`)
        .run(projectKey, agentId);
    }
    this.emit("agents", projectKey);
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
           tree, coverage, compile, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    this.enforceRetention(event.projectKey);
    this.emit("events", event.projectKey);
  }

  private static toEvent(row: EventRow): RunEvent {
    return {
      id: row.id,
      projectKey: row.project_key,
      agentId: row.agent_id,
      kind: row.kind === "compile" ? "compile" : "test",
      tier: row.tier as Tier,
      timestamp: row.timestamp,
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
    for (const row of expired) {
      this.foldIntoRollup(row);
      this.db.query(`DELETE FROM events WHERE id = ?`).run(row.id);
    }
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

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
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
