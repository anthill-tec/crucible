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
  // CR-CRU-076 §S1 — "Roadmap" leads the fixed order (the origin document);
  // supersedes CR-CRU-021 §S1 AC1 (Workflow-first). "Roadmap" was missing
  // from this union — inherited CR-CRU-014 drift, fixed here (CR-076 F3).
  name: "Roadmap" | "Workflow" | "Runs" | "Coverage" | "Compile" | "BDD";
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

/** CR-CRU-091 §S1/AC3 — the one release-date formatter; epoch SECONDS in, ISO
 * `YYYY-MM-DD` out, empty string for an absent or unusable value. */
export declare function formatReleaseDate(epochSeconds: number | null | undefined): string;

/** CR-CRU-078 §S3 — the kind of gate the strip is resolving a date for. The
 *  caller declares it from the slice it iterated; it is never sniffed. */
export type ReleaseGateKind = "shipped" | "proposed";

export interface GateDateResult {
  kind: ReleaseGateKind;
  /** The one field consulted, or `null` for an unrecognised kind. */
  field: "releasedAt" | "targetAt" | null;
  /** `absent` is AC6's declared empty state; `unusable` is a data defect. */
  state: "dated" | "absent" | "unusable";
  /** `formatReleaseDate`'s answer for that field — `""` unless `dated`. */
  date: string;
}

/** CR-CRU-078 §S3/AC6/AC7 — the date ONE release gate carries, or its declared
 * absence. Pure; never forecasts, and never reads a proposal's `timestamp`. */
export declare function resolveGateDate(
  record: { releasedAt?: unknown; targetAt?: unknown } | null | undefined,
  kind: ReleaseGateKind,
): GateDateResult;

/** CR-CRU-078 §S2 — ONE gate of the release strip: which release, and the date
 *  it carries (or the state that says it has none). */
export interface ReleaseStripGate {
  /** A shipped row's `version`, a proposal's `label`; `""` when unlabelled. */
  version: string;
  kind: ReleaseGateKind;
  /** `resolveGateDate`'s answer — `""` unless `dateState` is `dated`. */
  date: string;
  dateState: GateDateResult["state"];
}

/** CR-CRU-078 §S2/AC4 — the strip's page window. `size` is the VISIBLE gate
 *  count (the last page of a non-multiple sequence is short); `earlier`/`later`
 *  are the hidden counts, and a zero is why a tag is absent, not disabled. */
export interface ReleaseStripPage {
  size: number;
  offset: number;
  earlier: number;
  later: number;
}

/** CR-CRU-078 §S9/AC28 — shipped as published, then proposals as published.
 *  Concatenation only: re-sorting either half fails AC28. */
export declare function releaseStripGates(
  releases: readonly unknown[] | null | undefined,
  proposals: readonly unknown[] | null | undefined,
): ReleaseStripGate[];

/** CR-CRU-078 §S2/AC5 + §S4/AC10 — the index of the FOCUSED gate: the version
 *  the user chose when it is still in the sequence, else the release in
 *  progress (the first live proposal, else the newest shipped tag); -1 for an
 *  empty sequence. The ONE notion of focus on this surface. */
export declare function releaseStripFocusIndex(
  gates: readonly ReleaseStripGate[],
  focusedVersion?: string,
): number;

/** CR-CRU-078 §S2/AC3 — how many WHOLE gates a MEASURED track holds. 0 when
 *  either measurement is unusable — never a fallback constant. */
export declare function stripWindowSize(
  availableWidth: number | null | undefined,
  gatePitch: number | null | undefined,
): number;

/** CR-CRU-078 §S2/AC4/AC5 — the page window: snapped to the page grid, clamped
 *  to the ends, landing on the page that CONTAINS `focusIndex`. */
export declare function releaseStripPage(input: {
  count: number;
  size: number;
  focusIndex?: number;
  offset?: number;
}): ReleaseStripPage;

/** CR-CRU-084 §S1 — one artifact a release delivered. */
export interface ReleasePackage {
  registry: string;
  name: string;
  version: string;
}

/** CR-CRU-078 §S4 — one wave CONTAINER of the focused release. `wave` is
 *  `null` for members declaring none: a real group, drawn without chrome.
 *  CR-CRU-096 §S1 — `active` is whether the wave belongs to the focused,
 *  IN-FLIGHT release (the view's `kind === "proposed"`), never whether some
 *  member is mid-run. */
export interface FocusedReleaseWave<Entry = unknown> {
  wave: string | null;
  active: boolean;
  entries: Entry[];
  /** CR-CRU-096 §S5 — the members this box DRAWS, in the server's published
   *  order. A window on `entries`, never a re-ordering of it. For a wave box
   *  that is the top of the scheduled queue (five by default) union every
   *  running member; for the `wave: null` LOOSE group it is ALL of `entries`,
   *  because AC18a leaves that group untrimmed. */
  rows: Entry[];
  /** CR-CRU-096 §S5.4 — the SCHEDULED remainder the `+N more` pointer states:
   *  actionable members minus actionable rows shown, so merged members
   *  (rolled up) are never counted here as well. `0` for the `wave: null`
   *  loose group, which hides nothing and has no header to anchor a pointer
   *  on (AC18a). */
  hiddenCount: number;
  /** CR-CRU-096 §S3/AC6 — merged members (`COMPLETED` or
   *  `COMPLETED_UNTRACKED`, AC6a) over the WHOLE wave, the count the roll-up
   *  states. Independent of the trim: `0` means the wave has none, and AC5a
   *  renders no roll-up then. */
  mergedCount: number;
}

/** CR-CRU-078 §S4/§S5 — everything zones 2 and 3 draw for ONE focused
 *  release: its membership in authored order, that membership grouped into
 *  waves, what it delivered, and the tracks it reports. */
export interface FocusedReleaseView<Entry = unknown> {
  version: string;
  kind: ReleaseGateKind;
  date: string;
  dateState: GateDateResult["state"];
  members: Entry[];
  waves: FocusedReleaseWave<Entry>[];
  /** CR-CRU-096 §S7/AC22 — the wave labels this release spans, compressed into
   *  runs by `compressWaveRuns`. The delivered summary joins them with `", "`;
   *  the label COUNT it states the noun from is `waves.length`, not this. */
  waveRuns: string[];
  /** CR-CRU-096 §S4/AC12b — the ONE row in the whole zone marked `next`: the
   *  first actionable member among the rows the zone draws, in the published
   *  order across every wave (the loose group included, AC12c). `null` when
   *  the focused release draws no actionable row. */
  nextCr: string | null;
  crCount: number;
  packages: ReleasePackage[] | undefined;
  /** `empty` (delivered none) and `absent` (pre-CR-CRU-084) stay distinct. */
  packagesState: "listed" | "empty" | "absent";
  tracks: string[];
}

export declare function focusedReleaseView<Entry = unknown>(
  gate: ReleaseStripGate | null | undefined,
  releases: readonly unknown[] | null | undefined,
  entries: readonly Entry[] | null | undefined,
): FocusedReleaseView<Entry>;

/** CR-CRU-096 §S7/AC22/AC22a/AC22b — a set of wave labels as the delivered
 *  summary states it: ascending by leading-integer reading, maximal
 *  consecutive runs compressed to `first–last` (U+2013), a label with no
 *  numeric reading joining no run and following in first-appearance order.
 *  Non-string and empty labels are dropped; the caller joins with `", "`. */
export declare function compressWaveRuns(
  labels: readonly (string | null | undefined)[] | null | undefined,
): string[];

/** CR-CRU-078 §S5/AC12 — the columns zone 3 shows for the rows it was given:
 *  `wave` only across waves, `track` only across reported tracks. */
export declare function roadmapTableColumns(entries: readonly unknown[] | null | undefined): string[];

/** CR-CRU-078 §S5/AC11 — the CR's own H1 without the leading id the row
 *  already carries; `""` for an absent title, and never truncated. */
export declare function briefCrTitle(
  title: string | null | undefined,
  cr: string | null | undefined,
): string;

/** CR-CRU-078 AC27 — CR-CRU-091's SECOND axis as one badge, or `null` when the
 *  entry declares none. Never replaces the derived `status`. */
export declare function lifecycleBadge(
  lifecycle: { state?: unknown; by?: unknown; reason?: unknown } | null | undefined,
): { state: "SUPERSEDED" | "VOID"; text: string } | null;

/** CR-CRU-078 §S4 — the terse status a flowchart node states as TEXT; `""` for
 *  an unrecognised value, which supports no claim. */
export declare function crStatusMark(status: string | null | undefined): string;

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

// CR-CRU-007 §S1 — agent-role icon tinting (pure). CR-CRU-059 §S0 renamed the
// type `PhaseRole` -> `AgentRole`; `agentRole()` was already correctly named.
export type AgentRole = "red" | "green" | "verify" | "fix" | null;

// CR-CRU-044 §S2 / CR-CRU-057 §S3 — classification by the STORED role only;
// an absent (undefined/null) role is unclassified, never id-derived.
export declare function agentRole(agent: {
  agentId: string;
  role?: string | null;
}): AgentRole;

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
