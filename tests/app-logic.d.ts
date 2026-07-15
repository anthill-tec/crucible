// CR-CRU-006 §S3/§S4 — ambient module declaration for the not-yet-existing
// `public/app-logic.mjs` pure-logic module. Test infra ONLY: keeps `tsc
// --noEmit` clean on the imported symbols' types while `public/app-logic.mjs`
// does not exist on disk yet — GREEN creates the real file (whose exports
// must satisfy this shape); `bun test` still RED at runtime (module not
// found) until then.

declare module "../public/app-logic.mjs" {
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
    name: "Runs" | "Agents" | "Coverage" | "Compile" | "BDD";
    disabled: boolean;
  }

  export interface ProjectRollupLike {
    lastEvent?: {
      total: number;
      passed: number;
      failed: number;
      timestamp: number;
    } | null;
  }

  export interface EmptyStateInput {
    projects: unknown[];
    events: unknown[];
  }

  export interface EmptyStateResult {
    kind: "no-projects" | "no-runs";
  }

  export function filterEvents(
    events: CrucibleEventBrief[],
    filters: EventFilters,
  ): CrucibleEventBrief[];

  export function relativeTime(ts: number, now: number): string;

  export function livenessGlyph(agent: CrucibleAgentLike): LivenessGlyphResult;

  export function routeParse(pathname: string): RouteState;

  export function workspaceTabs(project: WorkspaceProjectLike): WorkspaceTab[];

  export function projectRollupLabel(project: ProjectRollupLike): string;

  export function emptyStates(state: EmptyStateInput): EmptyStateResult | null;
}
