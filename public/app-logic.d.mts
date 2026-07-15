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
  name: "Runs" | "Coverage" | "Compile" | "BDD";
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
