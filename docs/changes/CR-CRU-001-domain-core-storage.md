# CR-CRU-001 — Domain core + SQLite storage

**Status:** PENDING
**Type:** feature
**Priority:** P0
**Depends on:** —
**Labels:** core, storage
**Phase:** Wave 1
**Design reference:** docs/research/PRD-crucible-v2.md §2 (persistence), §3 (domain model), §4.7 (retention)

## Context
Everything else stands on the domain core: typed entities, the storage layer, agent
liveness, and retention. Storage is embedded SQLite via `bun:sqlite` (WAL) — the
skill-bundle deployment target forbids external daemons.

## Scope

### §S1 Domain types (`src/types.ts`)
Types exactly as PRD §3: `Project {key, name, type: "backend"|"frontend", sutRoot,
createdAt, liveness?}`, `LivenessConfig {staleAfterMs, tombstoneAfterMs, pruneAfterMs}`
with `DEFAULT_LIVENESS = {60_000, 300_000, 3_600_000}`, `Agent {agentId, projectKey,
status: "online"|"busy", message, identity {displayName?, source?, repoPath?},
firstSeen, lastSeen}`, `RunSummary {total, passed, failed, pending, duration_ms}`,
`TestLeaf {name, status: "pass"|"fail"|"pending", duration_ms, failure?: {message,
type?, trace?}}`, `SuiteNode {name, status, children: TestLeaf[]}`, `Coverage {lines,
functions?, branches?}` each axis `{total, covered, percent}`, `RunContext {git?:
{branch, commit}, wave?, orchestrator?}`, `RunEvent {id, projectKey, agentId, kind:
"test"|"compile", tier, stack?, codec?, context?, timestamp, name?, summary?, tree?,
coverage?, compile?}`, `Tier = "unit"|"module"|"integration"|"e2e"|"regression"|"bdd"`.

### §S2 SQLite store (`src/store.ts`)
Class `Store` backed by `bun:sqlite`, WAL mode, db path `data/crucible.db`
(constructor-injectable; `:memory:` for tests). Tables: `projects`, `agents`,
`events` (summary columns + JSON `tree`/`coverage`/`compile`/`context` blobs),
`rollups`. Index `events(project_key, timestamp)`. Public API: `addProject`,
`getProject`, `listProjects`, `touchAgent`, `removeAgent`, `listAgents`,
`recordTestEvent`, `recordCompileEvent`, `listEvents(projectKey?, limit=50)`
(newest-first), `getEvent(id)`, `deleteEvent(id, projectKey)`,
`clearEvents(projectKey)`, `onChange(fn)` (emits `"projects"|"agents"|"events"` +
projectKey).

### §S3 Liveness (computed, never stored)
`livenessOf(agent, now)` → half-open intervals throughout: `"online"` (silence < T1)
| `"stale"` ([T1, T2)) | `"tombstoned"` ([T2, T3)) | `"pruned"` (≥ T3). T1/T2/T3 from project `liveness`
override merged over `DEFAULT_LIVENESS`. `listAgents` lazily deletes pruned rows.
**Implicit heartbeat:** `recordTestEvent`/`recordCompileEvent` call `touchAgent`
(bump `lastSeen`) for their `agentId`. `touchAgent` upserts; identity fields merge —
a heartbeat without `identity` preserves previously stored identity.

### §S4 Retention + rollup
On event insert: if the project's full-fidelity events exceed 100 (per-project
override field `retention` allowed), fold the oldest overflow into `rollups` —
grouped by `context.wave` when present, else by UTC day — accumulating
`{runs, passed, failed, duration_ms, lastCoverage}` — then delete the raw rows.
`listRollups(projectKey)` returns them oldest-first.

### §S5 Boot safety
Opening a corrupt/unreadable db: rename it to `crucible.db.corrupt-<epoch>`,
start a fresh db, log one loud line. Boot must never fail because of a bad file.

### §S6 Minimal boot + health (the CR's production call path)
`src/server.ts`: `Bun.serve` on port 3849 (env `CRUCIBLE_PORT` override) serving
exactly one route, `GET /api/health` → `{ok: true, status: "healthy", version,
uptime_s, counts: {projects, agents, events}}` with counts read from the Store.
Everything else 404s. CR-CRU-003 extends this server with the shim routes.
Project scaffolding (package.json `{name: "crucible", version: "2.0.0-alpha.1",
engines.bun: ">=1.2"}`, tsconfig) is part of this section.

## Acceptance criteria
- [x] `DEFAULT_LIVENESS` equals `{staleAfterMs: 60000, tombstoneAfterMs: 300000, pruneAfterMs: 3600000}` (exact values).
- [x] `new Store(":memory:")` boots; `addProject({key: <uuid>, name: "x", type: "backend", sutRoot: "/tmp"})` then `getProject(key).name === "x"`; `type` defaults to `"backend"` when omitted.
- [x] `touchAgent(pk, "a1", {identity: {displayName: "A"}})` then `touchAgent(pk, "a1", {message: "m2"})` → `listAgents(pk)[0].identity.displayName === "A"` and `.message === "m2"` (identity preserved across identity-less heartbeats).
- [x] With project override `liveness: {staleAfterMs: 10}`, an agent last seen 20 ms ago reports `liveness === "stale"`; with defaults it reports `"online"`.
- [x] Agent with `lastSeen` older than T3 is absent from `listAgents()` after the call (lazy prune) and its row is deleted.
- [x] `recordTestEvent(pk, "a1", run)` bumps agent `a1`'s `lastSeen` (implicit heartbeat): `lastSeen` after > `lastSeen` before.
- [x] `recordTestEvent` with `run.summary.failed > 0` and `run.coverage` set stores the event with `coverage === null/undefined` (discard-on-fail).
- [x] Event ids match `/^evt-\d{13}-\d+$/`; `listEvents(pk, 2)` returns the 2 newest, newest first.
- [x] Inserting 105 events with `context.wave: "w1"` on the first 3: project retains exactly 100 raw events; `listRollups(pk)` contains a `"w1"` group with `runs === 3` (wave-aware rollup) — remainder in day buckets.
- [x] A garbage file at the db path: `Store.open(path)` succeeds, a sibling `*.corrupt-*` file exists, and the new db is empty.
- [x] `GET /api/health` on the booted server → 200 with `counts.projects` reflecting a project added through the Store (integration test drives the REAL server boot, not a hand-wired store).
- [x] Caller-existence: grep `new Store(`/`Store.open(` in `src/server.ts` returns ≥ 1 (the production boot constructs the Store).

## Estimated size
M — ~5 modules + test suite.

## Risk
bun:sqlite API drift across Bun versions — pin `engines.bun` in package.json.

## Non-goals
HTTP surface (CR-CRU-003/004), codecs (CR-CRU-002), any UI.
