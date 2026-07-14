// CR-CRU-005 §S3 — contextual help[] hints, the single reviewable module.
// ALL v2 help[] wording lives HERE (src/v2.ts imports it) so the
// agent-facing next-step text is auditable in one place.

export const hints: Record<
  "orientation" | "registered" | "afterRed" | "afterCompile" | "unknownProject" | "coverageDropped",
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
  /** Coverage arrived on a failing run and was discarded by the store. */
  coverageDropped: ["coverage DISCARDED — coverage from a failing run is meaningless"],
};
