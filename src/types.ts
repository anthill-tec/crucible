// CR-CRU-001 §S1 — Domain types (PRD-crucible-v2 §3)

export interface LivenessConfig {
  staleAfterMs: number;
  tombstoneAfterMs: number;
  pruneAfterMs: number;
}

export const DEFAULT_LIVENESS: LivenessConfig = {
  staleAfterMs: 60_000,
  tombstoneAfterMs: 300_000,
  pruneAfterMs: 3_600_000,
};

export interface Project {
  key: string;
  name: string;
  type: "backend" | "frontend";
  sutRoot: string;
  createdAt: number;
  liveness?: Partial<LivenessConfig>;
  /** §S4 — per-project raw-event retention cap override (default 100). */
  retention?: number;
}

export interface AgentIdentity {
  displayName?: string;
  source?: string;
  repoPath?: string;
}

export interface Agent {
  agentId: string;
  projectKey: string;
  status: "online" | "busy";
  message: string;
  identity: AgentIdentity;
  firstSeen: number;
  lastSeen: number;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
}

export interface TestLeaf {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: {
    message: string;
    type?: string;
    trace?: string;
  };
}

export interface SuiteNode {
  name: string;
  status: "pass" | "fail" | "pending";
  children: TestLeaf[];
}

export interface CoverageAxis {
  total: number;
  covered: number;
  percent: number;
}

export interface Coverage {
  lines: CoverageAxis;
  functions?: CoverageAxis;
  branches?: CoverageAxis;
}

/** CR-CRU-002 §S1 — canonical normalized-run shape produced by every codec. */
export interface RunSchema {
  summary: RunSummary;
  tree: SuiteNode[];
  coverage?: Coverage;
}

export interface RunContext {
  git?: {
    branch: string;
    commit: string;
  };
  wave?: string;
  orchestrator?: string;
  // CR-CRU-007 §S2 (round 10, additive) — the orchestrator todo's description
  // labelling the RED→GREEN cycle this run belongs to.
  cycle?: string;
  // CR-CRU-011 §S0 (additive) — declared-plan linkage: the numeric id of the
  // plan cycle this run belongs to. Stored verbatim; unknown ids tolerated.
  cycleId?: number;
}

export type Tier = "unit" | "module" | "integration" | "e2e" | "regression" | "bdd";

export interface RunEvent {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: Tier;
  stack?: string;
  codec?: string;
  context?: RunContext;
  timestamp: number;
  name?: string;
  summary?: RunSummary;
  tree?: SuiteNode[];
  coverage?: Coverage;
  compile?: unknown;
}

// ── CR-CRU-011 §S0 — cycle plans (the orchestrator's declared todo list) ─────

export type CycleKind = "red-green" | "verify" | "fix";

export type CycleStatus = "pending" | "active" | "done" | "skipped" | "failed";

export interface PlanCycle {
  /** Unique numeric id per PROJECT (not per plan). */
  id: number;
  label: string;
  kind: CycleKind;
  status: CycleStatus;
}

/**
 * §S0 — derived read-only boundary on closed plans: merge commit + the
 * earliest/latest linked-run commits and branch from `context.git`.
 * Absent fields are OMITTED, never null.
 */
export interface CommitBoundary {
  mergeCommit: string;
  branch?: string;
  firstRunCommit?: string;
  lastRunCommit?: string;
  closedAt: number;
}

export interface Plan {
  planId: number;
  projectKey: string;
  /** Stored VERBATIM — the stable join key (round 24, binding). */
  cr: string;
  wave?: string;
  track?: string;
  status: "open" | "closed";
  cycles: PlanCycle[];
  merge?: { commit: string };
  closedAt?: number;
  commitBoundary?: CommitBoundary;
}
