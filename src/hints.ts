// CR-CRU-005 §S3 — contextual help[] hints, the single reviewable module.
// ALL v2 help[] wording lives HERE (src/v2.ts imports it) so the
// agent-facing next-step text is auditable in one place.

export const hints: Record<
  | "orientation"
  | "registered"
  | "roleRequired"
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
    "POST /api/v2/agents/register {projectKey, agentId, role} — register an agent (role: RED | GREEN | FIX | VERIFY | ORCHESTRATOR | report)",
    "GET /api/v2/health — service health",
  ],
  /** CR-CRU-044 §S1 — a registration that declared no usable role. */
  roleRequired: [
    "POST /api/v2/agents/register {projectKey, agentId, role} — role must be exactly one of RED | GREEN | FIX | VERIFY | ORCHESTRATOR | report",
    "role declares WHAT the agent is doing; it is never guessed from the agentId's shape",
    "POST /api/v2/agents/heartbeat {projectKey, agentId} — heartbeat needs no role; it never re-declares (or blanks) the registered one",
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
   * mis-set explicit cycleId can be corrected to a real one — or the caller
   * re-registered bound to it (CR-CRU-056: the server stamps the binding).
   */
  unknownCycle: (cr: string, cycleIds: number[]): string[] => [
    `context.cycleId matched no cycle in this project's plans — the open plan ${cr} has cycle ids: ${cycleIds.join(", ")}`,
    "register bound to the intended cycle (--cycle <id> from that list) and the server stamps the attachment for you, or send one of those ids as context.cycleId",
  ],
  /**
   * §S7 — an accepted ingest referenced a TERMINAL (done/skipped/failed) cycle:
   * late ingests are legal, but the explicit cycleId is almost certainly stale.
   * CR-CRU-056: the current mechanism is a registration BOUND to the ACTIVE
   * cycle, so the remedy is a re-registration, not an exported env var.
   */
  staleCycle: (cycleId: number): string[] => [
    `context.cycleId ${cycleId} references a CLOSED cycle — the run was stored, but the explicit cycleId you sent is likely stale`,
    "find the ACTIVE cycle (GET …/plans?cr=<cr>) and re-register bound to it (--cycle <id>) — the server then stamps the attachment on every ingest",
  ],
  /**
   * CR-CRU-056 §S1 — a register binding targeted a cycle that was never
   * activated; name the concrete transition that would make it bindable.
   */
  bindPendingCycle: (cycleId: number, planId: number): string[] => [
    `cycle ${cycleId} is pending — activate it first: PATCH …/plans/${planId}/cycles/${cycleId} {status: "active"}`,
    "then retry the registration with the same cycleId",
  ],
  /**
   * CR-CRU-056 §S1 — a register binding targeted a TERMINAL cycle; name its
   * actual status and point at the plan's live cycle instead.
   */
  bindTerminalCycle: (cycleId: number, status: string): string[] => [
    `cycle ${cycleId} is ${status} — a terminal cycle takes no new agents`,
    "bind to the plan's ACTIVE cycle instead (GET …/plans?cr=<cr> to find it), or activate the next cycle first",
  ],
  /**
   * CR-CRU-056 §S1 — a register binding targeted a cycle whose plan is no
   * longer open; name the plan and its status.
   */
  bindClosedPlan: (cr: string, planId: number, planStatus: string): string[] => [
    `plan ${cr} (id ${planId}) is ${planStatus} — its cycles take no new agents`,
    "bind to an ACTIVE cycle of an OPEN plan (GET …/plans to find one), or file a new plan first",
  ],
  /**
   * CR-CRU-056 §S2 — a TDD-role (RED/GREEN/FIX/VERIFY) registration arrived
   * UNBOUND. State-derived: name the project's actual ACTIVE cycle id(s) when
   * any exist; otherwise say to activate one first. Always names `--cycle`.
   */
  unboundTddRole: (role: string, activeCycleIds: number[]): string[] =>
    activeCycleIds.length > 0
      ? [
          `role ${role} must register bound to a cycle — this project's ACTIVE cycle id(s): ${activeCycleIds.join(", ")}`,
          `retry the registration with --cycle ${activeCycleIds[0]} (wire: register {cycleId})`,
        ]
      : [
          `role ${role} must register bound to a cycle — but NO cycle is active in this project`,
          'activate one first (PATCH …/plans/<planId>/cycles/<id> {status: "active"}), then register with --cycle <id>',
        ],
  /**
   * CR-CRU-056 §S3 — a BOUND agent's ingest carried an explicit
   * context.cycleId CONFLICTING with its registered binding; name BOTH ids.
   */
  bindingConflict: (boundCycleId: number, explicitCycleId: number): string[] => [
    `your registration is bound to cycle ${boundCycleId} but this ingest carried context.cycleId ${explicitCycleId} — the server stamps the binding, so a conflicting explicit id is refused`,
    `omit context.cycleId (the server attaches cycle ${boundCycleId} for you), or re-register bound to cycle ${explicitCycleId} if that is really where this run belongs`,
  ],
  /**
   * CR-CRU-056 §S3 — a BOUND agent ingested after its cycle left the active
   * state (done/skipped/failed, or its plan closed): refuse, never spill.
   */
  staleBinding: (cycleId: number, state: string): string[] => [
    `your bound cycle ${cycleId} is ${state} — the run was NOT stored (a stale binding never spills into another cycle)`,
    "re-register bound to the cycle this run belongs to (an ACTIVE cycle of an OPEN plan), then re-ingest",
  ],
};

/**
 * CR-CRU-059 §S1 — identity refusals. `identity.source` is optional, but a
 * DECLARED value outside `IDENTITY_SOURCES` is refused at the route boundary
 * (nothing stored). The help is state-derived: it names the RECEIVED value
 * verbatim alongside the whole accepted set, so the caller can see exactly
 * which of its own strings drifted (CR-CRU-054's `"openclaw"` was the case
 * that shipped for months).
 */
export const identityHints = {
  invalidSource: (received: unknown, sources: readonly string[]): string[] => [
    `identity.source ${JSON.stringify(received)} is not a known source — it must be exactly one of ${sources.join(" | ")}`,
    `re-register with --source <one of ${sources.join(" | ")}> (wire: register {identity:{source}}); nothing was stored`,
    "identity.source stays OPTIONAL — omit it entirely rather than inventing a value",
  ],
};

/**
 * CR-CRU-056 §S2b/§S3b — registered-caller refusals. Every mutating workflow
 * verb and every ingest surface requires a LIVE registered caller; the help
 * is state-derived (names the offending agentId when the request carried one)
 * and always names registration as the next step.
 */
export const authHints = {
  /** §S2b/§S3b — the request carried no agentId, or one with no live row. */
  unregisteredCaller: (agentId: string | undefined): string[] => [
    agentId === undefined
      ? "this verb requires a registered caller — send your agentId in the request body"
      : `agentId ${agentId} has no live registration in this project (never registered, unregistered, or pruned) — nothing was stored or changed`,
    "register first: POST /api/v2/agents/register {projectKey, agentId, role} (role: RED | GREEN | FIX | VERIFY | ORCHESTRATOR | report; TDD roles register bound with cycleId)",
    "then retry this call with that same agentId in the body",
  ],
};
