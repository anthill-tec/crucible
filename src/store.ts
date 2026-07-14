// CR-CRU-001 §S2 — SQLite store on bun:sqlite (C1: projects + agents)

import { Database } from "bun:sqlite";
import { DEFAULT_LIVENESS } from "./types.ts";
import type { Agent, AgentIdentity, LivenessConfig, Project } from "./types.ts";

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

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        sut_root TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        liveness TEXT
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
    };
    this.db
      .query(
        `INSERT INTO projects (key, name, type, sut_root, created_at, liveness)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.key,
        stored.name,
        stored.type,
        stored.sutRoot,
        stored.createdAt,
        stored.liveness !== undefined ? JSON.stringify(stored.liveness) : null,
      );
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
