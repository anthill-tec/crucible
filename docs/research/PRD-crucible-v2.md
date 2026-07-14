# PRD — Crucible v2: Agentic-TDD Test Dashboard

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-07-14
**Status:** DRAFT — kickoff design contract
**Design inputs:** [DN-crucible-api-reconstruction.md](DN-crucible-api-reconstruction.md)

## 1 Why

Crucible is the test-observability hub of the agentic-TDD platform (MDX: CodeForge,
Crucible, Velocity). Every RED/GREEN/VERIFY/FIX agent across every stack (Rust, Java/
Quarkus, Python, Bun/TS, VS Code ext, Arduino) registers with Crucible, heartbeats its
progress, and ingests every test cycle it runs — including compile failures, because in
TDD "the test doesn't compile yet" is itself a reportable RED state. Orchestrators and
the human watch one dashboard to see which agents are live, what they're running, and
whether the RED→GREEN transition actually happened.

Crucible v1 (Bun/TypeScript backend, VanJS/VanX UI, port 3849) was lost to an accidental
folder deletion. The client fleet survived intact. v2 rebuilds the server and dashboard
around two commitments:

1. **Wire compatibility** — every surviving client works unmodified, day one.
2. **A more usable UI** — v1's dashboard grew organically; v2 designs it deliberately.

## 2 System context

```
 rust-crucible.py ─┐
 mvn-crucible.py  ─┤   JSON/HTTP :3849            ┌─ Dashboard SPA (VanJS + VanX)
 python-crucible.py├──▶  Crucible server (Bun/TS) ─┤   served from /, live via SSE
 bun-crucible.py  ─┤   /api/*                     └─ REST consumers (orchestrators,
 arduino-crucible ─┘                                   status-report skill, curl)
 + crucible-report-* skills, heartbeat.sh
```

- Single-user, localhost developer tool. No auth, no TLS, no multi-tenant (non-goals §7).
- Server: Bun + TypeScript, zero runtime framework (Bun.serve router). Tests: `bun test`
  (this project eats its own dog food: it ingests its own runs via `bun-crucible.py`).
- UI: VanJS 1.5 + VanX 0.6 (vendored, no CDN/build step), single-page, served by the same
  process.
- Persistence: JSON snapshot on disk (`data/state.json`), debounce-written, loaded at
  boot. Good enough for a localhost tool; a real DB is out of scope (§7).

## 3 Domain model

### 3.1 Project
| Field | Type | Notes |
|---|---|---|
| `key` | UUID string | primary id; clients keep it in the SUT's `.env` as `CRUCIBLE_PROJECT_KEY` |
| `name` | string | display name |
| `type` | `"backend"` \| `"frontend"` | v2 (default `backend`). Backend = TDD only (unit/module/e2e/regression tiers). Frontend adds the BDD axis (Playwright/Vitest) later. |
| `sutRoot` | string | absolute path of the SUT repo (wire field: `sut_root`) |
| `createdAt` | epoch ms | |

### 3.2 Agent
Keyed by (`projectKey`, `agentId`). Fields: `agentId`, `projectKey`, `status`
(`online|busy`), `message` (current progress), `identity` (`displayName`, `source`,
`repoPath` — set once, preserved across heartbeats), `firstSeen`, `lastSeen`.

**Liveness state machine** (computed from `lastSeen` at read time; thresholds are v1
defaults from the agent-protocol skill and MUST stay configurable):
`online` (< 60 s) → `stale` (60–300 s) → `tombstoned` (300 s–1 h) → pruned (> 1 h).
Explicit `/api/agents/remove` (clean unregister) deletes immediately. An agent that
fails to unregister is NOT silently dropped: it is shown **tombstoned** (greyed, last
message + time-of-death preserved) so a crashed agent stays diagnosable, then pruned.
A heartbeat at any point resurrects it.

### 3.3 Run event
One ingest call = one immutable event on the project's timeline.

| Field | Type | Notes |
|---|---|---|
| `id` | `evt-<epoch-ms>-<seq>` | v1 format preserved |
| `projectKey`, `agentId` | | who ran it |
| `kind` | `"test"` \| `"compile"` | strict panel routing (§4.6) |
| `tier` | `"unit"` \| `"module"` \| `"e2e"` \| `"regression"` \| `"bdd"` | v2, optional on ingest, default `unit` |
| `timestamp` | epoch ms | |
| `summary` | `{total, passed, failed, pending, duration_ms}` | test events |
| `tree` | suite→test nodes (`name`, `status: pass|fail|pending`, `duration_ms`) | test events |
| `coverage` | `{lines, functions, branches?}` each `{total, covered, percent}` | only on fully-green runs — server discards otherwise (v1 safety net) |
| `compile` | `{format, errorCount, warningCount, errors: [{file?, line?, col?, code?, message, level}], raw}` | compile events |
| `name` | string? | optional run label |

### 3.4 Ingest state
Per (`projectKey`, `type ∈ unit|bdd`): pointer to the latest test event + latest compile
event — what `/api/ingest/status` reports and `/api/ingest/clear` resets.

## 4 Functional requirements

### 4.1 v1-compatible API (normative — the compatibility contract)
All 13 endpoints, payloads, response shapes, and behavioral invariants cataloged in
[DN-crucible-api-reconstruction.md](DN-crucible-api-reconstruction.md) §2–§3 are
requirements verbatim. Highlights that are easy to get wrong:

- `projectKey` must be a valid UUID → HTTP 400 `{ok:false, error}` otherwise.
- `POST /api/projects/add` with an existing key → HTTP 400 (clients rely on this for
  idempotent self-registration).
- Heartbeat `identity` is optional and preserved when omitted; **top-level `displayName`/
  `source` are tolerated but ignored**.
- `/api/ingest` `dataPath` accepts a file OR a directory (all `TEST-*.xml` inside).
- Coverage arriving with `summary.failed > 0` is discarded server-side.
- `/api/ingest/compile` `format` is optional (`rustc|java|python|typescript`, absent ⇒
  auto-detect, fall back to raw).
- Every mutating response is `{ok:true,…}`; every error carries an actionable `error`
  string (clients print it).

### 4.2 Project registration
- `POST /api/projects/add` — v1 fields + optional `type` (§3.1); key optional in v2
  (server generates UUIDv7 and returns it) for dashboard-driven creation.
- Dashboard can create, rename, and re-type projects.
- `GET /api/projects` returns `{ok, projects:[…]}` with per-project rollups (agent count,
  last event, latest green coverage) so the dashboard renders from one call.

### 4.3 Agent lifecycle
- Heartbeat upserts the agent, bumps `lastSeen`, applies §3.2 identity semantics.
- Liveness computed per §3.2; pruning is lazy (on read) — no background timer needed.
- `GET /api/agents?projectKey=` returns computed `liveness` alongside stored fields.

### 4.4 Test ingest
- Raw path: server-side JUnit XML parser with exactly the client parsers' semantics
  (failure/error → fail, skipped → pending, `time`s → duration_ms, `testsuites` or bare
  `testsuite` root, file-or-directory `dataPath`, inline `data` alternative).
- Parsed path: accept summary/tree/coverage as-is (validate shape, don't recompute).
- Both record a `kind:"test"` event and return `{ok, summary}`.

### 4.5 Compile ingest
- Structured parsers per format: `rustc` (`error[EXXXX]` + `--> file:line:col`), java/
  maven (`[ERROR] /File.java:[line,col] msg`), `python` (traceback / SyntaxError),
  `typescript` (`file.ts(line,col): error TSxxxx`). Unknown/absent format → best-effort
  detect → raw fallback (never reject).
- Records a `kind:"compile"` event; response `summary.failed` = errors, `.pending` =
  warnings (v1 client convention).

### 4.6 Panel routing (invariant)
Compile events and test events are separate streams in the UI — a compile failure never
renders as "0/N tests" and an all-fail test run never renders as a compile error. (This
discipline is hammered into every skill; the server enforces it by `kind`.)

### 4.7 Events API
As v1 (list newest-first/limit 50, delete-one, clear-project) + retention cap 1000
events/project (oldest dropped).

### 4.8 Live updates
`GET /api/stream` — SSE channel broadcasting `{type: "projects"|"agents"|"events", projectKey}`
change hints; the SPA refetches affected slices. Poll fallback every 5 s when SSE drops.

### 4.9 Ingest status (v2 defined shape)
`GET /api/ingest/status?projectKey&type=` →
`{ok, status: {hasData, lastTest: <event summary+id+ts>|null, lastCompile: …|null}}`.
Omitted `type` ⇒ `unit`.

### 4.10 Service health (v1 parity — the backend is monitored too)
`GET /api/health` → `{ok, status:"healthy", version, uptime_s, counts:{projects, agents,
events}, snapshot:{lastWriteAt, ok}}`. The SSE channel emits keep-alive frames every
15 s. The dashboard pins a server-health pill (healthy / unreachable) and visibly greys
all live data when keep-alives stop and a health probe fails — the frontend must never
present stale data as live. Orchestrators may gate wave dispatch on `/api/health`.

### 4.11 Dashboard (v2 UX)
- **Project switcher** — chips/rail with per-project health at a glance (type badge,
  online-agent count, last-run pass/fail, latest coverage). "All projects" default.
- **Agent rail** — live agents with liveness dot (🟢 online / 🟡 stale / ⚪ offline),
  display name, current `message`, relative last-seen. This is the "who is working right
  now" view.
- **Run timeline** — newest-first event cards: agent, tier, pass ratio (`34/34` green /
  `3 failed of 5` red / pending count), duration, expandable suite→test tree with per-test
  status; compile cards show error/warning counts and per-file structured errors.
- **RED→GREEN transition marker** — when an agent's failing run is followed by its passing
  run, the timeline surfaces the transition explicitly (the core TDD story v1 told).
- **Coverage** — line/function/branch meters on green regression events; latest-green
  coverage shown at project level.
- Localhost tool aesthetics: fast, dense, dark-friendly, zero build step.

## 5 Quality requirements
- Full TDD via the project's own tooling: `bun test`, JUnit reporter, lcov coverage,
  ingested to Crucible itself via `bun-crucible.py` / `crucible-report-bun`.
- Server start < 1 s; ingest of a 1000-case JUnit directory < 500 ms.
- State survives restart (snapshot load); a corrupt snapshot must not prevent boot
  (rename aside, start fresh, log loudly).
- No external network at runtime; all UI assets vendored.

## 6 Rollout
1. Walking skeleton (this kickoff): compatible API core + minimal live dashboard, enough
   to re-point real agent traffic at port 3849.
2. Hardening waves via the CR queue (`docs/changes/README.md`): parser edge cases,
   ingest-status/clear semantics, dashboard depth (tree drill-down, RED→GREEN, coverage
   trends), BDD/Playwright axis for frontend projects.

## 7 Non-goals (v2.0)
- Auth/multi-user/remote hosting; Crucible stays a localhost single-developer tool.
- A database server — JSON snapshot persistence only.
- Historical analytics beyond the capped per-project event log (trend charts over
  retained events are in scope; unbounded history is not).
- CodeForge/Velocity integration beyond sharing the agent-protocol conventions.

## 8 Open questions
- Should `tier` be inferred from the ingesting script's subcommand (unit/module/e2e/
  regression) and sent explicitly by upgraded clients? (Legacy clients keep default
  `unit`.)
- Frontend-project BDD ingest format: Playwright JUnit XML suffices, or a dedicated
  `format:"playwright"` with trace links?
- Should events store the SUT git branch/commit (clients could send it; great for the
  timeline, needs client updates)?
