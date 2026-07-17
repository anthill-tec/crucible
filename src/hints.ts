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
  | "deletionNeedsApproval",
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
};
