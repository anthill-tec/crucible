// CR-CRU-006 §S3/§S4 — declarations for app-logic.mjs. Sibling .d.mts so the
// test import (`../public/app-logic.mjs`) typechecks via module resolution:
// public/ stays outside the tsconfig include set, and the ambient
// `declare module` in tests/app-logic.d.ts is inert for relative specifiers
// (TS ignores relative ambient module names). Mirrors that contract exactly.

export interface CrucibleEventBrief {
  id: string;
  projectKey: string;
  agentId: string;
  kind: string;
  tier?: string;
  codec?: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  hasCoverage: boolean;
  /** CR-CRU-007 §S5.2 (F8 vitals, additive) — the stored coverage's lines
   * percent; present ONLY on coverage-bearing events. */
  coverageLines?: number;
}

export interface EventFilters {
  projectKey?: string | null;
  agentId?: string | null;
}

export interface CrucibleAgentLike {
  agentId: string;
  projectKey: string;
  status?: "online" | "busy";
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
}

export interface LivenessGlyphResult {
  cls: string;
  tombstone: boolean;
  diedAgo?: string;
}

export interface RouteState {
  page: "home" | "workspace";
  projectKey?: string;
  overlay?: string;
  /** CR-CRU-012 §S2 — /manage: the Projects manager slide-over over home. */
  manage?: boolean;
}

export interface WorkspaceProjectLike {
  type: "backend" | "frontend";
  // CR-CRU-007 §S1 addendum — Coverage tab gating: same field names the
  // server already emits on the v2 projects listing (src/v2.ts
  // handleProjectsList: `latestGreenCoverage` + `latestCoverageEventId`,
  // ABSENT — not merely null — until a green regression run with coverage
  // exists).
  latestCoverageEventId?: string;
}

export interface WorkspaceTab {
  // CR-CRU-021 §S1 — "Workflow" leads the fixed order (primary tab).
  name: "Workflow" | "Runs" | "Coverage" | "Compile" | "BDD";
  disabled: boolean;
  /** RED-phase declaration only — present when `disabled` explains why
   * (Coverage: "coverage lands with the first green regression"). */
  hint?: string;
}

// CR-CRU-007 §S5.1 — activity rule + projects-row ordering (pure).
export interface ActivityAgentLike {
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
}

export interface ActivityProjectLike {
  lastEventAt: number | null;
  agents: ActivityAgentLike[];
}

export interface ProjectActivityResult {
  active: boolean;
  lastActivity: number;
}

export interface OrderableProjectLike {
  active: boolean;
  lastActivity: number;
}

export interface ProjectRollupLike {
  lastEvent?: {
    total: number;
    passed: number;
    failed: number;
    timestamp: number;
  } | null;
}

// CR-CRU-007 §S2 — RED→GREEN transition markers (= Cycles), pure pairing.
export interface TransitionEventLike {
  id: string;
  projectKey: string;
  agentId: string;
  kind: string;
  timestamp: number;
  failed: number;
}

export interface TransitionMarker<T extends TransitionEventLike = TransitionEventLike> {
  redEvent: T;
  greenEvent: T;
  projectKey: string;
  stem: string;
}

export interface EmptyStateInput {
  projects: unknown[];
  events: unknown[];
}

export interface EmptyStateResult {
  kind: "no-projects" | "no-runs";
}

export declare function filterEvents(
  events: CrucibleEventBrief[],
  filters: EventFilters,
): CrucibleEventBrief[];

export declare function relativeTime(ts: number, now: number): string;

export declare function livenessGlyph(agent: CrucibleAgentLike): LivenessGlyphResult;

export declare function routeParse(pathname: string): RouteState;

export declare function workspaceTabs(project: WorkspaceProjectLike): WorkspaceTab[];

export declare function projectRollupLabel(project: ProjectRollupLike): string;

export declare function projectActivity(
  project: ActivityProjectLike,
  now: number,
  inactiveMs: number,
): ProjectActivityResult;

export declare function orderProjects<T extends OrderableProjectLike>(projects: T[]): T[];

export declare function emptyStates(state: EmptyStateInput): EmptyStateResult | null;

export declare function pairTransitions<T extends TransitionEventLike>(
  events: T[],
): Array<TransitionMarker<T>>;

// CR-CRU-011 C4 — §S0b timeline plan integration + §S3 history lens (pure).
export interface LensRunLike {
  id: string;
  projectKey: string;
  agentId: string;
  kind: string;
  timestamp: number;
  failed: number;
  context?: {
    cycleId?: number;
    wave?: string | null;
    cycle?: string;
  };
}

export interface LensPlanCycleLike {
  id: number;
  label: string;
  kind?: string;
  status: string;
  activatedAt?: number;
  doneAt?: number;
}

export interface LensPlanLike {
  planId: number | string;
  // CR-CRU-026 §S3.3 — real server field (toPlan() stamps it); optional
  // ONLY for legacy undeclared-plan fixtures, which keep bare-cycleId
  // linkage semantics.
  projectKey?: string;
  cr: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  cycles: LensPlanCycleLike[];
  merge?: { commit: string };
  // CR-CRU-020 §S1.1 — real server field (Plan.closedAt), consumed by the
  // lens to order CR groups within a wave newest-first.
  closedAt?: number;
}

// CR-CRU-026 §S3.3 — keys are compound `<projectKey> <cycleId>` strings
// (space-separated, matching the pairTransitions convention; safe because
// UUID-shaped project keys cannot contain spaces and string keys cannot
// collide with the bare numeric legacy keys) for declared plans, bare
// numeric cycle ids for legacy undeclared ones.
export declare function planCycleIndex<
  P extends LensPlanLike,
>(plans: P[]): Map<number | string, { cycle: P["cycles"][number]; plan: P }>;

export type TimelineRow<
  E extends LensRunLike,
  P extends LensPlanLike,
> =
  | { kind: "marker"; marker: TransitionMarker<E & TransitionEventLike> }
  | { kind: "cycle-span-open"; cycle: P["cycles"][number]; plan: P }
  | { kind: "declared-marker"; cycle: P["cycles"][number]; plan: P }
  | { kind: "card"; event: E };

export declare function timelineRows<
  E extends LensRunLike & TransitionEventLike,
  P extends LensPlanLike,
>(events: E[], plans: P[]): Array<TimelineRow<E, P>>;

export interface LensCycleNode<E extends LensRunLike> {
  id?: number;
  label: string;
  status: string;
  runs: E[];
}

export interface LensCrNode<E extends LensRunLike> {
  cr: string;
  source: "declared" | "inferred";
  status?: "open" | "closed";
  track?: string;
  merge?: { commit: string };
  // CR-CRU-020 §S1.1 — passthrough of Plan.closedAt (declared nodes only).
  closedAt?: number;
  cycles: Array<LensCycleNode<E>>;
  rollup: { done: number; total: number };
  agents: string[];
}

export interface LensWaveNode<E extends LensRunLike> {
  wave: string;
  source: "declared" | "inferred";
  state: { label: string; chips: string[] } | null;
  tracks: Array<{ track: string; crs: Array<LensCrNode<E>> }> | null;
  crs: Array<LensCrNode<E>>;
}

export interface WorkflowLensResult<E extends LensRunLike> {
  waves: Array<LensWaveNode<E>>;
  ungrouped: E[];
}

export declare function workflowLens<E extends LensRunLike>(input: {
  plans: LensPlanLike[];
  events: E[];
}): WorkflowLensResult<E>;

// CR-CRU-007 §S4.0 (FINAL re-baseline) — purely tier-contextual presentation;
// the storage-key helper is gone with the removed mode switch.
export type DrillinMode = "Detail" | "Density";

export declare function drillinDefaultMode(tier: string): DrillinMode;

// CR-CRU-007 §S4 items 1 & 3 — Density-mode pure helpers.
export interface FoldSuiteLike {
  name: string;
  status: string;
}

export interface DigestLeafLike {
  name: string;
  status: string;
  failure?: { message: string } | undefined;
}

/**
 * One digest entry. `kind` discriminates at runtime: "leaf" entries carry
 * `leaf`; "group" entries carry `message`/`leaves`/`extraCount`. Declared
 * flat (all fields present) so call sites can read either side after a
 * runtime `kind` check without a type-guard dance.
 */
export interface DigestEntry<T extends DigestLeafLike> {
  kind: "leaf" | "group";
  /** the pass/pending/uniquely-failing leaf (kind "leaf") */
  leaf: T;
  /** the shared failure.message (kind "group") */
  message: string;
  /** the grouped leaves, input order (kind "group") */
  leaves: T[];
  /** leaves.length - 1 — the "+N identical" count (kind "group") */
  extraCount: number;
}

export declare function foldSuites(suites: FoldSuiteLike[]): string[];

export declare function digestFailures<T extends DigestLeafLike>(
  leaves: T[],
): Array<DigestEntry<T>>;

// CR-CRU-007 §S1 — phase-role icon tinting (pure).
export type PhaseRole = "red" | "green" | "verify" | "fix" | null;

export declare function phaseRole(agentId: string): PhaseRole;

// CR-CRU-044 §S2 — classification by the agent's STORED phase; `phaseRole`
// is the fallback only when `phase` is absent (undefined) or null.
export declare function agentRole(agent: {
  agentId: string;
  phase?: string | null;
}): PhaseRole;

// CR-CRU-028 §S1 — auto-coarsening level-colored coverage-trend buckets (pure).
export declare const COVERAGE_LEVEL_ORANGE_MAX: number;
export declare const COVERAGE_LEVEL_YELLOW_MAX: number;

export type CoverageLevelClass = "orange" | "yellow" | "green";

export declare function coverageLevelClass(percent: number): CoverageLevelClass;

export interface CoverageTrendPoint {
  day: string;
  percent: number;
}

export interface CoarsenedCoverageBucket {
  level: "day" | "week" | "month";
  bucketKey: string;
  day: string;
  percent: number;
  isLatest: boolean;
}

export declare function coarsenCoverageTrend(
  points: CoverageTrendPoint[],
): CoarsenedCoverageBucket[];

// CR-CRU-028 §S2 — drill-down accordion + per-run heat strip (pure).
export interface UnfoldedCoverageBar {
  level: "day" | "week";
  day: string;
  percent: number;
  /** The raw points this finer bar groups — carried so the drill-down can
   * CASCADE (re-scope onto them to unfold a revealed bar one level deeper). */
  members: CoverageTrendPoint[];
}

export declare function unfoldCoverageBucket(
  points: CoverageTrendPoint[],
  bucketKey: string,
  level: "day" | "week" | "month",
): UnfoldedCoverageBar[];

export declare function unfoldCoverageSubset(
  members: CoverageTrendPoint[],
  parentLevel: "day" | "week" | "month",
): UnfoldedCoverageBar[];

export interface CoverageHeatSliceLike {
  id: string;
  projectKey: string;
  tier: string;
  timestamp: number;
  coverageLines?: number;
}

export interface CoverageHeatSlice {
  eventId: string;
  percent: number;
  level: CoverageLevelClass;
}

export declare function coverageHeatSlices(
  events: CoverageHeatSliceLike[],
  projectKey: string,
  day: string,
): CoverageHeatSlice[];
