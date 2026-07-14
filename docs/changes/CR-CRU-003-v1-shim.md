# CR-CRU-003 — v1 compatibility shim + contract tests

**Status:** PENDING
**Type:** feature
**Priority:** P0
**Depends on:** CR-CRU-001, CR-CRU-002
**Labels:** api, compat, shim
**Phase:** Wave 1
**Design reference:** docs/research/DN-crucible-api-reconstruction.md §1–§3 (the shim's contract, verbatim); PRD §4.1

## Context
The legacy fleet (5 `*-crucible.py` scripts + skills) must keep reporting, unmodified,
until the Wave-4 upgrade. This CR ships `Bun.serve` on **:3849** with the 13 legacy
endpoints translated onto the CR-CRU-001 core, plus the contract-test suite derived
line-by-line from the DN. From this CR on, a dev instance runs and every later CR's
runs are ingested into it (dog-food).

## Scope

### §S1 Server + routing (`src/server.ts`, `src/shim.ts`)
Extends the CR-CRU-001 `src/server.ts` (`Bun.serve` on 3849 + `/api/health` already
exist) with a dispatcher for the 13 v1 routes: POST
`/api/projects/add`, GET `/api/projects`, POST `/api/agents/heartbeat`, POST
`/api/agents/remove`, GET `/api/agents`, POST `/api/ingest`, POST
`/api/ingest/parsed`, POST `/api/ingest/compile`, POST `/api/ingest/clear`, GET
`/api/ingest/status`, GET `/api/events`, POST `/api/events/delete`, POST
`/api/events/clear`. Plus GET `/api/health` (v1-era parity, PRD §4.10).

### §S2 v1 behavioral quirks (shim-only, from the DN — MUST hold exactly)
- Non-UUID `projectKey` anywhere → HTTP 400 `{ok:false, error}`.
- `POST /api/projects/add` `{key, name, sut_root}` — duplicate key → HTTP 400;
  success → `{ok:true, …}`; `sut_root` stays snake_case on this path only.
- Heartbeat: top-level `displayName`/`source` accepted but IGNORED; only
  `identity {displayName, source, repoPath}` is honored, and identity persists
  across identity-less heartbeats. Unknown project → 404 with actionable error.
- `POST /api/ingest` `{projectKey, format: "junit", data|dataPath, agentId}` —
  `dataPath` file or directory; response `{ok:true, summary: {total, passed,
  failed, pending, duration_ms}}`.
- `/api/ingest/parsed` — accepts `{summary, tree, coverage?, name?}` as-is;
  coverage discarded when `summary.failed > 0` (core behavior, asserted here).
- `/api/ingest/compile` — `{errors, format?}`, format optional (mvn/arduino omit);
  response `{ok:true, summary: {failed: <errorCount>, pending: <warningCount>}}`.
- `GET /api/events` — `?projectKey`, `?limit` default 50, newest first.
- All errors carry actionable `error` strings.

### §S3 Contract-test suite (`tests/v1-contract.test.ts`)
One test block per DN §3 subsection, fixture payloads copied from the DN examples
(the exact shapes the surviving scripts send — rust/mvn/python/bun/arduino
variants). This suite is the permanent regression gate for the shim until the fleet
migrates.

## Acceptance criteria
- [ ] `bun run start` serves on 3849; `GET /api/health` → 200 `{ok:true, status:"healthy", version, uptime_s, counts:{projects,agents,events}}`.
- [ ] `POST /api/projects/add` twice with the same UUID key → first 200 `{ok:true}`, second **400**; with key `"not-a-uuid"` → 400 with error containing `"UUID"`.
- [ ] Heartbeat with top-level `"displayName":"X"` and no `identity` → subsequent `GET /api/agents?projectKey=` shows that agent with NO displayName `"X"` anywhere; heartbeat with `identity:{displayName:"Y"}` then a later identity-less heartbeat → displayName still `"Y"`.
- [ ] `POST /api/ingest` with `dataPath` = directory of 2 surefire `TEST-*.xml` fixtures → `{ok:true}` and `summary.total` equals the sum across both files; same endpoint with inline `data` XML string also succeeds.
- [ ] `POST /api/ingest/parsed` with `summary.failed: 2` + a `coverage` object → stored event has no coverage (verified via `GET /api/events`).
- [ ] `POST /api/ingest/compile` with the rustc fixture from CR-CRU-002 and NO `format` field → `{ok:true, summary:{failed:1, pending:1}}`.
- [ ] `GET /api/events?limit=1` returns exactly the newest event; ids match `evt-<ms>-<seq>`; `POST /api/events/delete` with a wrong `projectKey` does not delete.
- [ ] Every 4xx response body has `ok:false` and a non-empty `error` string.
- [ ] Contract suite covers all 13 endpoints (each route name appears in ≥ 1 test title) and passes.
- [ ] `Store.removeAgent` emits an `"agents"` change event ONLY when ≥ 1 row was actually deleted (deferred-register fold-in; no-op remove is silent).
- [ ] `parseJunit` handles NESTED `<testsuite>` elements recursively (DN §3.4 parity — clients use `.//testsuite`; bun's `--reporter=junit` nests suites): a real bun-generated JUnit file with N testcases ingests with `summary.total === N` and non-empty tree (dog-food finding 2026-07-15: current codec returns total 0 for bun output).
- [ ] Integration (live smoke, VERIFY runs it): with the dev server up, `python3 ~/.claude/scripts/bun-crucible.py register --agent smoke-cru --project-dir <repo>` against a freshly added project returns ok — an UNMODIFIED legacy client speaks to the shim.

## Estimated size
M/L.

## Risk
Quirk fidelity — anything the DN under-specifies gets resolved in favor of what the
surviving client code tolerates (they are the oracle; re-read them before RED).

## Non-goals
v2 routes, TOON, SSE (CR-CRU-004/005); UI.
