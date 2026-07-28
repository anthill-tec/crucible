// CR-CRU-005 §S3 — contextual help[] hints, the single reviewable module.
// ALL v2 help[] wording lives HERE (src/v2.ts imports it) so the
// agent-facing next-step text is auditable in one place.

export const hints: Record<
  | "orientation"
  | "registered"
  | "afterRed"
  | "afterCompile"
  | "unknownProject"
  | "archivedProject"
  | "coverageDropped"
  | "deletionDisabled"
  | "deletionNeedsApproval"
  | "abortNeedsApproval"
  | "gateFields"
  | "gateOutcomes"
  | "milestoneTypes"
  | "illegalCycleTransition"
  | "planCycleNotFound"
  | "planFileInput"
  | "cycleInput"
  | "cycleStatus"
  | "duplicateOpenPlan"
  | "closedPlan"
  | "nonTerminalCycles"
  | "malformedBody"
  | "cycleLocked"
  | "cycleImmutable"
  | "cycleOneMutation"
  | "unknownCycleNoPlan",
  string[]
> = {
  /** GET /api/v2 — orientation for a fresh agent. */
  orientation: [
    "POST /api/v2/projects {name, key?, type?, sutRoot?} — create a project (key auto-generated when omitted)",
    "GET /api/v2/projects — projects with rollups (agentsOnline, agentsTotal, lastEvent, latestGreenCoverage)",
    "POST /api/v2/agents/register {projectKey, agentId} — register an agent",
    "GET /api/v2/health — service health",
  ],
  /** After register (and heartbeat): ingest hint + implicit-heartbeat note + unregister reminder. */
  registered: [
    "POST /api/v2/runs {projectKey, agentId, codec, data} — ingest a test run",
    "every ingest POST implicitly refreshes liveness — an explicit POST /api/v2/agents/heartbeat {projectKey, agentId, status?, message?} is only needed while idle",
    "POST /api/v2/agents/unregister {projectKey, agentId} — remove the agent when done",
    "GET /api/v2/agents?project=<key> — list agents with computed liveness",
  ],
  /** After a RED ingest. */
  afterRed: [
    "After GREEN, re-ingest — the dashboard shows the transition",
    "GET /api/v2/events/<id> — full failure detail (?depth=suites for counts, ?suite=<name> to expand one suite)",
  ],
  /** After a compile ingest. */
  afterCompile: [
    "compile events route to the compile panel — ingest the next test run to update the run verdict",
  ],
  /** 404/400 unknown project — the call that fixes it. */
  unknownProject: [
    "GET /api/v2/projects — list registered projects and their keys",
    "POST /api/v2/projects {name} — register a new project (key auto-generated)",
  ],
  /** CR-CRU-012 §S1b — 404 on an agent call against an archived project. */
  archivedProject: [
    "this project is archived — agent calls are rejected and never resurrect it",
    "POST /api/v2/projects/<key>/unarchive — explicitly restore the project first",
    "GET /api/v2/projects?archived=true — list archived projects",
  ],
  /** Coverage arrived on a failing run and was discarded by the store. */
  coverageDropped: ["coverage DISCARDED — coverage from a failing run is meaningless"],
  /** CR-CRU-008 §S4 — DELETE refused: the project's config gate is off. */
  deletionDisabled: [
    "run deletion is DISABLED for this project — runs are an immutable audit log by default, and this refusal is final until a human changes that",
    "only a human can enable it: the allowRunDeletion toggle in the project manager's edit form (or PATCH /api/v2/projects/<key> {allowRunDeletion: true}) — do NOT flip it yourself to force a delete",
  ],
  /** CR-CRU-008 §S4 — DELETE refused: no explicit user approval on the call. */
  deletionNeedsApproval: [
    "deleting a run permanently destroys audit history — never retry this call on your own initiative",
    "present the deletion to the user first; retry with {userApproved: true} ONLY after the user has explicitly approved this specific deletion",
  ],
  /** CR-CRU-024 §S6 — abort refused: no explicit user approval on the call. */
  abortNeedsApproval: [
    "aborting discards a declared workflow and destroys its running plan — never retry this call on your own initiative",
    "present the abort to the user first; retry with {userApproved: true} ONLY after the user has explicitly approved this specific abort",
  ],
  /** CR-CRU-013 §S1 — a gate POST missing a required field. */
  gateFields: [
    "POST /api/v2/gates {projectKey, agentId, context?, gate:{intent, outcome, steps:[…], fixes?, push?, pr?}} — record a no-mistakes gate outcome",
    "gate.intent, gate.outcome, and gate.steps are all required",
  ],
  /** CR-CRU-013 §S1 — a gate POST with an out-of-set outcome. */
  gateOutcomes: [
    "gate.outcome must be one of: checks-passed, passed, failed, cancelled",
  ],
  /** CR-CRU-013 §S4b/§S4c — a milestone POST with an out-of-set type. */
  milestoneTypes: [
    "POST /api/v2/milestones {projectKey, agentId, type, label?, commit?, context?} — record a workflow milestone",
    "type must be one of: gap-analysis, design-review, stage-flip, custom, cr-merged",
  ],
  /** CR-CRU-024 §S4 — an illegal per-cycle transition (e.g. active→pending). */
  illegalCycleTransition: [
    "cycles never retreat — a done/skipped/failed cycle is final and an active cycle cannot return to pending",
    "append a new cycle for rework: POST …/plans/<planId>/cycles {label}",
  ],
  /** CR-CRU-024 §S4 — 404 on an unknown plan or cycle in a plan/cycle route. */
  planCycleNotFound: [
    "GET …/plans?cr=<cr> — list this project's plans with their cycle ids",
    "check the planId and cycleId in the PATCH path resolve to a real plan/cycle",
  ],
  /** CR-CRU-024 §S4 — a malformed POST …/plans body (cr / cycles shape). */
  planFileInput: [
    "POST …/plans {cr, cycles:[{label, kind?}], title?, orchestrator?, wave?, track?} — file a cycle plan",
    "cr must be a non-empty string and cycles a non-empty array",
  ],
  /** CR-CRU-024 §S4 — a malformed cycle object (missing label / bad kind). */
  cycleInput: [
    "each cycle needs a non-empty label; kind is optional and one of: red-green | verify | fix (defaults to red-green)",
  ],
  /** CR-CRU-024 §S4 — a cycle PATCH with an out-of-set status. */
  cycleStatus: [
    "status must be one of: pending | active | done | skipped | failed",
  ],
  /** CR-CRU-024 §S4 — a second open plan filed for a cr that already has one. */
  duplicateOpenPlan: [
    "one open plan per cr — close the existing open plan (PATCH …/plans/<planId> {status:\"closed\"}) before filing another",
    "or append cycles to the existing plan: POST …/plans/<planId>/cycles {label}",
  ],
  /** CR-CRU-024 §S4 — a mutation aimed at an already-closed plan. */
  closedPlan: [
    "this plan is closed — closed plans are immutable except retroactive wave backfill",
    "file a new plan for further work: POST …/plans {cr, cycles:[…]}",
  ],
  /**
   * CR-CRU-024 §S4 — a close blocked by cycles still non-terminal.
   * CR-CRU-048 §S2 — names abort as the sanctioned remedy: there is no --force,
   * so a plan whose remaining cycles will never run is abandoned via abort.
   */
  nonTerminalCycles: [
    "transition every listed cycle to a terminal state (done | skipped | failed) before closing the plan",
    "GET …/plans?cr=<cr> — inspect the cycles still open",
    "if the listed cycles will never run, abandon the plan instead: POST …/plans/<planId>/abort {userApproved: true} — present the abort to the user first and send it ONLY after explicit approval",
  ],
  /** CR-CRU-024 §S4 — an unparseable JSON request body on a plan/cycle route. */
  malformedBody: [
    "send a valid JSON body with content-type: application/json",
  ],
  /** CR-CRU-024 §S3.2 — a label edit aimed at the LOCKED active cycle. */
  cycleLocked: [
    "the active cycle is locked while it runs — confirm it (done) or fail it first, then edit",
    "or append a new cycle for the rename: POST …/plans/<planId>/cycles {label}",
  ],
  /** CR-CRU-024 §S3.2 — a label edit aimed at a terminal (history) cycle. */
  cycleImmutable: [
    "done/skipped/failed cycles are immutable history — their labels are frozen",
    "append a new cycle for rework instead: POST …/plans/<planId>/cycles {label}",
  ],
  /** CR-CRU-024 §S3.2 — a body carrying BOTH label and status. */
  cycleOneMutation: [
    "one mutation per call — send either {label} (rename) or {status} (transition), never both",
    "PATCH …/cycles/<id> {label} to rename, then PATCH …/cycles/<id> {status} to transition",
  ],
  /** CR-CRU-024 §S7 — an unknown cycleId ingest when the project has no open plan. */
  unknownCycleNoPlan: [
    "context.cycleId matched no cycle — this project has no open plan to link a run to",
    "file a plan first (POST …/plans {cr, cycles:[…]}) or omit context.cycleId",
  ],
};

/**
 * CR-CRU-024 §S1+§S2 — activation-guard help[] parameterized by the sibling
 * cycle the refusal names. Kept here so ALL agent-facing next-step wording
 * stays auditable in this one module.
 */
export const cycleHints = {
  /** §S1 — an earlier sibling is still pending; offer activate-first or skip. */
  outOfOrder: (earlier: number): string[] => [
    `activate cycle ${earlier} first — cycles activate in ascending order`,
    `or transition cycle ${earlier} pending→skipped, then retry this activation`,
  ],
  /** §S2 — another cycle is already active; offer the terminal-transition path. */
  alreadyActive: (active: number): string[] => [
    `cycle ${active} is already active — a plan runs one cycle at a time`,
    `transition cycle ${active} to a terminal state (done | skipped | failed) first, then retry`,
  ],
  /**
   * §S3.1 — insert-before targeted the active cycle (or a seq-earlier sibling);
   * a new pending cycle must land AFTER the active one to keep the order invariant.
   */
  insertBeforeActive: (active: number): string[] => [
    `cycle ${active} is active — insert the new cycle after it, not before`,
    `target a cycle that sits after the active cycle ${active} in the plan order`,
  ],
  /**
   * §S7 — a run ingest's context.cycleId matched no cycle in any of the
   * project's plans; name the open plan (cr) and its known cycle ids so a
   * mis-set WORKFLOW_CYCLE_ID can be corrected to a real one.
   */
  unknownCycle: (cr: string, cycleIds: number[]): string[] => [
    `context.cycleId matched no cycle in this project's plans — the open plan ${cr} has cycle ids: ${cycleIds.join(", ")}`,
    "export a WORKFLOW_CYCLE_ID that resolves to one of those cycles, or omit context.cycleId",
  ],
  /**
   * §S7 — an accepted ingest referenced a TERMINAL (done/skipped/failed) cycle:
   * late ingests are legal, but the WORKFLOW_CYCLE_ID is almost certainly stale.
   */
  staleCycle: (cycleId: number): string[] => [
    `context.cycleId ${cycleId} references a CLOSED cycle — the run was stored, but your WORKFLOW_CYCLE_ID is likely stale`,
    "confirm the active cycle (GET …/plans?cr=<cr>) and export its id before the next ingest",
  ],
};
