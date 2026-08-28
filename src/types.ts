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

/**
 * CR-CRU-084 §S1 — ONE artifact a `release` delivered: the registry it was
 * published to, the package NAME it carries there (which is registry-specific
 * and NOT the project name), and the version. Crucible never verifies that the
 * publish happened or that the package is reachable (spec Non-goals): this is
 * what the release ceremony DECLARED it shipped.
 */
export interface PackageRef {
  registry: string;
  name: string;
  version: string;
}

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
   * CR-CRU-073 §S1 — the release VERSION this gate gated (a bare SemVer),
   * stored first-class on the event, never parsed back out of the free-text
   * intent. ABSENT on a versionless gate and on every non-gate kind.
   */
  version?: string;
  /**
   * CR-CRU-073 §S1 — the release-retirement marker (epoch ms). Stamped when
   * the gate's release ships (or on insert for an already-released version);
   * a live gate has NO marker. ABSENT until retired.
   */
  retiredAt?: number;
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
  /**
   * CR-CRU-080 §S4 — a `release` milestone's SHIP instant: the tag's own
   * commit date in epoch SECONDS (`git log -1 --format=%ct <tag>`), computed
   * by the ceremony — the only actor standing in the repo with git. Distinct
   * from `timestamp`, which is when the release was RECORDED. ABSENT on a
   * release recorded before §S4 and on every non-release event.
   */
  releasedAt?: number;
  /**
   * CR-CRU-091 §S1 — a `release-proposal` milestone's DECLARED target date, in
   * epoch SECONDS — deliberately the SAME unit as `releasedAt` above, so one
   * formatter serves both and neither surface renders 1970. Optional and
   * revisable: a proposal with no declared target is a legitimate declared
   * intent. ABSENT on every other event type (a `release` carries
   * `releasedAt`, which is when it SHIPPED, not when it was aimed for).
   */
  targetAt?: number;
  /**
   * CR-CRU-080 §S4 — the CR ids a `release` shipped: the ceremony's tag-range
   * scan INTERSECTED with the project's registered queue at record time.
   * ABSENT on a pre-§S4 release; EMPTY when the queue knew none of the scanned
   * ids (a truthful "nothing registered", never a fallback to the raw scan).
   */
  crs?: string[];
  /**
   * CR-CRU-084 §S1 — the packages a `release` DELIVERED, in the order the
   * ceremony declared them. AC2: each entry's `version` IS the release tag's,
   * because the tag is what the publish jobs build from. ABSENT on a release
   * recorded before this CR and on every non-release event; EMPTY when the
   * ceremony looked and delivered none — a meaningful fact (§S3), and a
   * DIFFERENT one from absent (AC4), so the two are never collapsed.
   */
  packages?: PackageRef[];
  /**
   * CR-CRU-017 §S1 — the RUN's start instant, carried from the open run onto
   * the event that CLOSED it. Absent on a single-shot ingest (no `runId`, no
   * lifecycle) and on every pre-017 row.
   */
  startedAt?: number;
  /**
   * CR-CRU-017 §S1 — the SERVER-computed wall-clock runtime of the run
   * (`endedAt - startedAt`), which includes queue, spawn and teardown time the
   * tool-reported `summary.duration_ms` cannot see. The two are distinct
   * values and both are kept.
   */
  runtimeMs?: number;
  /**
   * CR-CRU-017 §S1/§S2 — the RUN's exceptional terminal state: `"aborted"`
   * means this run ended for NON-TEST reasons (timeout, kill, dead agent).
   * It is a property of a RUN and has nothing to do with `Plan.status`'s
   * `"aborted"` (a user-discarded workflow, CR-CRU-024 §S6) — nothing may
   * treat one as the other. Absent on a normally-ended run.
   */
  status?: "aborted";
  /** CR-CRU-017 §S1 — why the RUN was aborted; present exactly when `status` is. */
  abortReason?: string;
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

// ── CR-CRU-014 §S1 — the CR execution queue (project roadmap registration) ──

/**
 * CR-CRU-014 §S1 / CR-CRU-083 §S2 — a queued CR's derived lifecycle. Three of
 * the four values come from the cr's plans; `COMPLETED_UNTRACKED` is the
 * fourth, and the only one derived from release membership — a cr some release
 * SHIPPED but no plan ever tracked, which `PENDING` used to misreport as
 * "never started".
 */
export type QueueStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "COMPLETED_UNTRACKED";

/**
 * CR-CRU-091 §S2 — the SECOND AXIS: whether the declared work is still wanted.
 * `QueueStatus` above answers *what happened to the work* and stays derived
 * from plans and release membership; this one is AUTHORED and stored, and the
 * two are never collapsed — a `SUPERSEDED` cr whose plan is open still reads
 * `IN_PROGRESS`, because that is true. `SUPERSEDED` carries `by` (the
 * successor cr — the work still happens, elsewhere); `VOID` carries `reason`
 * (the work is not happening). `at` is epoch MILLISECONDS, the unit every
 * other stored server-side instant uses (`filed_at`, `retired_at`) —
 * `RunEvent.releasedAt`/`targetAt` are seconds because they are git's, not
 * ours. Neither axis is defaulted when absent.
 */
export interface QueueLifecycle {
  state: "SUPERSEDED" | "VOID";
  /** The successor cr. Present for SUPERSEDED. */
  by?: string;
  /** Why the work is not happening. Present for VOID. */
  reason?: string;
  at: number;
}

/**
 * CR-CRU-014 §S1 — one registered queue entry as served by GET …/queue. The
 * caller supplies {cr, title?, wave, dependsOn, size?}; `status` and `planId`
 * are DERIVED on read from the cr's plan (never stored), in this PRECEDENCE
 * order (CR-CRU-083 §S2): IN_PROGRESS = an open plan; COMPLETED = a plan
 * closed with a merge commit; COMPLETED_UNTRACKED = NO plan at all and the cr
 * named in some release's `crs`; PENDING = otherwise. `planId` is present only
 * when a plan exists, so a COMPLETED_UNTRACKED entry never carries one — the
 * key is omitted, and §S3/AC5 forbid inventing a plan to fill it.
 * `dependsOn` is a string[] of CR ids, stored and returned verbatim.
 *
 * CR-CRU-091 §S2 — the caller may also DECLARE `release`, `track`, `seq` and
 * `lifecycle` (see `QueueEntryInput`); those are stored, never derived, and
 * published back here — `seq` always, the other three only where declared.
 */
export interface QueueEntry {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  size?: string;
  status: QueueStatus;
  planId?: number;
  /**
   * CR-CRU-091 §S2 — the STORED sequence within its container, published on
   * EVERY entry and read verbatim from the column. Never re-derived from a
   * response index: `listQueue` is `ORDER BY seq`, so an index derivation
   * preserves authored ORDER while making `seq` mean two different numbers on
   * one surface (AC18) — the same failure class AC3 prevents for dates.
   */
  seq: number;
  /** §S2 — the declared target release label. Absent when undeclared. */
  release?: string;
  /**
   * §S2 — the declared track in the PRD's locked wire format `track-<n>`
   * (`normalizeTrack`). Absent when undeclared.
   */
  track?: string;
  /** §S2 — the second axis, parsed from `lifecycle_json`. Absent when none. */
  lifecycle?: QueueLifecycle;
}
