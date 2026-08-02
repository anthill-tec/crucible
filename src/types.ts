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
  /** CR-CRU-008 §S4 — guarded run deletion config gate (default false:
   * the run journal is an immutable audit log unless a human enables this). */
  allowRunDeletion?: boolean;
}

/**
 * CR-CRU-059 §S1 — the enumeration an agent registration may declare its
 * identity SOURCE from (mirroring `AGENT_ROLES`, and the clients' own
 * `--source {claude-md,package-json,git-repo,manual}` argparse choices).
 * Typed as a union so the type stops lying: `source?: string` is what let
 * CR-CRU-054's hardcoded out-of-enum `"openclaw"` ship undetected.
 */
export const IDENTITY_SOURCES = ["claude-md", "package-json", "git-repo", "manual"] as const;

export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export interface AgentIdentity {
  displayName?: string;
  /** CR-CRU-059 §S1 — OPTIONAL (absent stays legal), but when present it must
   * be an `IDENTITY_SOURCES` member; validated at the route boundary. */
  source?: IdentitySource;
  repoPath?: string;
}

/**
 * CR-CRU-044 §S1 — the enumeration an agent registration must declare. Role
 * is WHAT the agent is doing (identity stays WHO it is), so it is its own
 * first-class field rather than a guess from the agentId's shape.
 */
export const AGENT_ROLES = ["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export interface Agent {
  agentId: string;
  projectKey: string;
  status: "online" | "busy";
  message: string;
  identity: AgentIdentity;
  firstSeen: number;
  lastSeen: number;
  /**
   * CR-CRU-044 §S1 — declared at registration. ABSENT for historical
   * (pre-CR-044) rows: no back-fill, never fabricated.
   */
  role?: AgentRole;
  /**
   * CR-CRU-056 §S1 — the cycle this agent registered bound to, validated at
   * the register route (exists, open plan, active). ABSENT when the agent
   * registered unbound: no back-fill, never fabricated.
   */
  boundCycleId?: number;
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
  // CR-CRU-038 §S2b — run-level captured runner output (stdout/stderr),
  // threaded codec→ingest→event so the frontend raw-toggle has real data.
  raw?: string;
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
  // plan cycle this run belongs to. CR-CRU-024 §S7 — VALIDATED on ingest against
  // stored plan state (Crucible is the source of truth): an id matching no cycle
  // in any of the project's plans is REFUSED (400, never stored); a terminal
  // (done/skipped/failed) cycle is accepted but flagged as a stale reference; an
  // active/pending cycle links silently.
  cycleId?: number;
}

export type Tier = "unit" | "module" | "integration" | "e2e" | "regression" | "bdd";

export interface RunEvent {
  id: string;
  projectKey: string;
  agentId: string;
  // CR-CRU-013 §S1+§S4b — gate/milestone join the event-kind family.
  kind: "test" | "compile" | "lifecycle" | "gate" | "milestone";
  tier: Tier;
  stack?: string;
  codec?: string;
  context?: RunContext;
  timestamp: number;
  // CR-CRU-011 §S1 (additive) — lifecycle events only: which transition this
  // event records, and (on "unregistered") the firstSeen snapshot taken
  // BEFORE the agents-row deletion so the final runtime survives it.
  action?: "registered" | "unregistered";
  firstSeen?: number;
  name?: string;
  summary?: RunSummary;
  tree?: SuiteNode[];
  coverage?: Coverage;
  // CR-CRU-038 §S2b — run-level captured runner output; persisted and served
  // verbatim, and (unlike coverage) retained even on a failing ingest.
  raw?: string;
  compile?: unknown;
  // CR-CRU-013 §S1 (gate) — the full no-mistakes gate object, stored verbatim
  // (forward-tolerant: fields outside the ladder round-trip untouched).
  gate?: unknown;
  /**
   * CR-CRU-057 §S1 — the posting agent's DECLARED role (CR-CRU-044), stamped
   * server-side at write time through CR-CRU-056's `resolveIngestAttach` seam
   * so classification survives the agent row's deletion at unregister. ABSENT
   * when no role was declared: no back-fill, never fabricated, and NEVER
   * derived from the agentId's shape.
   */
  role?: AgentRole;
  /**
   * CR-CRU-057 §S1 — provenance of `role`: `false` = declared by the agent at
   * registration (every write-time stamp); `true` is reserved for the §S4
   * one-time labeled backfill. Present exactly when `role` is.
   */
  roleInferred?: boolean;
  // CR-CRU-013 §S4b/§S4c (milestone) — flat carrying fields.
  type?: string;
  label?: string;
  commit?: string;
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
  // CR-CRU-011 §S0b (additive, mirrors Plan.closedAt) — transition
  // timestamps: stamped on pending→active and on reaching a terminal
  // state; the timeline's declared marker derives its active→done
  // duration from these. Absent (never null) until the transition lands.
  activatedAt?: number;
  doneAt?: number;
  // CR-CRU-023 §S3 (a) (additive) — accumulated attention time in ms:
  // active-in-server-up epochs only (restart resumes, downtime excluded).
  // Present on ACTIVE cycles; sealed rows keep `doneAt − activatedAt`.
  activeMs?: number;
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
  // CR-CRU-021 §S6.11 (additive, optional) — the CR's human title, captured
  // at plan filing; the Workflow CR-root renders `<cr> · <title>`. Absent
  // (never null) when the plan was filed without one.
  title?: string;
  // CR-CRU-021 §S6 re-baseline (2026-07-17, additive, optional) — the
  // confirming orchestrator's identity; the Workflow CR-root renders
  // `<cr> · <title> — <orchestrator>`. Accepted at filing (POST) or as a
  // one-field PATCH backfill on an OPEN plan. Absent (never null) when
  // unstamped.
  orchestrator?: string;
  wave?: string;
  track?: string;
  // CR-CRU-024 §S6 — `aborted` is an additive terminal plan state alongside
  // open|closed: a declared workflow explicitly discarded (user-approved). The
  // one-open-plan-per-cr rule treats it as not-open, so the cr can refile.
  status: "open" | "closed" | "aborted";
  cycles: PlanCycle[];
  merge?: { commit: string };
  closedAt?: number;
  commitBoundary?: CommitBoundary;
}
