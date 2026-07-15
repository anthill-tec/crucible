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
}

export interface WorkspaceTab {
  name: "Runs" | "Coverage" | "Compile" | "BDD";
  disabled: boolean;
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
