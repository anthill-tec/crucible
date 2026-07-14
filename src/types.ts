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

export interface RunContext {
  git?: {
    branch: string;
    commit: string;
  };
  wave?: string;
  orchestrator?: string;
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
