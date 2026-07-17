# DN — Crucible v1 API Reconstruction (Evidence Catalog)

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-07-14
**Status:** ACTIVE — normative input to PRD-crucible-v2 §4

The original Crucible server (Bun/TypeScript backend + VanJS/VanX UI) was lost to a folder
deletion. Its API contract survives in the clients that called it: the per-stack ingest
scripts (`~/.claude/scripts/*-crucible.py`), the reporting skills
(`~/.claude/skills/crucible-report-*`, `crucible-register`, `agent-protocol`), and the
RED/GREEN/VERIFY/FIX agent definitions. This DN catalogs that evidence so the v2 rebuild
can guarantee wire compatibility with every existing client, unmodified.

## 1 Service identity

| Fact | Value | Evidence |
|---|---|---|
| Base URL | `http://localhost:3849` (override: `CRUCIBLE_BASE`) | every script/skill; `arduino-crucible.py:21` |
| Content type | `application/json` both directions | all clients |
| Success shape | `{"ok": true, ...}` — clients branch on `resp.ok` | `rust-crucible.py:371,422` etc. |
| Error shape | `{"ok": false, "error": "<actionable message>"}` | `bun-crucible.py:294` prints `resp['error']`; skills: "Read error responses — they tell you exactly what's wrong" |
| Project key type | **UUID string, mandatory** — non-UUID rejected with HTTP 400 | crucible-report-java/bun Rules: "`projectKey` must be a valid UUID — string keys are rejected with 400" |
| Client env contract | `CRUCIBLE_PROJECT_KEY` (+ `CRUCIBLE_PROJECT_NAME` for arduino) read from the SUT project's `.env` | all scripts' `_project_key()`; `arduino-crucible.py:_load_env` |

## 2 Endpoint inventory

| # | Endpoint | Method | Purpose | Evidence |
|---|---|---|---|---|
| 1 | `/api/projects` | GET | List projects, optional `?name=` filter | all skill endpoint tables |
| 2 | `/api/projects/add` | POST | Register a project (idempotent for clients: duplicate key → 400, ignored) | `arduino-crucible.py:80` |
| 3 | `/api/agents/heartbeat` | POST | Register agent + heartbeat (same endpoint for both) | all clients |
| 4 | `/api/agents/remove` | POST | Unregister agent | all clients |
| 5 | `/api/agents` | GET | List agents, optional `?projectKey=` | skill tables |
| 6 | `/api/ingest` | POST | Raw ingest — server parses (format `junit`, `data` or `dataPath`) | `rust-crucible.py:401-443`, `mvn-crucible.py:353-365` |
| 7 | `/api/ingest/parsed` | POST | Pre-parsed ingest (summary + tree + optional coverage) | all clients |
| 8 | `/api/ingest/compile` | POST | Compile/import failure ingest (errors text, optional format) | all clients |
| 9 | `/api/ingest/clear` | POST | Clear ingested state for a project | skill tables |
| 10 | `/api/ingest/status` | GET | `?projectKey=X&type=unit\|bdd` — check ingest state | skill tables |
| 11 | `/api/events` | GET | List events; `?projectKey=`, `?limit=` (default 50), newest first | crucible-report-java §Event Management |
| 12 | `/api/events/delete` | POST | Delete one event (`eventId` + `projectKey`) | crucible-report-java §Event Management |
| 13 | `/api/events/clear` | POST | Clear all events for a project | crucible-report-java §Event Management |

## 3 Payload schemas (as sent by surviving clients)

### 3.1 `POST /api/projects/add`
```json
{"key": "<uuid>", "name": "<display name>", "sut_root": "/abs/path/to/project"}
```
- `sut_root` is snake_case (only snake_case field in the API — preserve verbatim).
- Duplicate key → HTTP 400; `arduino-crucible.py:_ensure_project` deliberately ignores it
  ("Idempotent self-registration; a pre-existing project returns 400 (ignored)").
- Projects are otherwise created in the dashboard (crucible-report-python: "there is no
  create endpoint — projects are made in the Crucible dashboard" — outdated w.r.t.
  `/api/projects/add`, but proves dashboard-side creation existed).
- Example key format: `019c9ff7-222f-7ae5-9121-2ae549e4d97a` (UUIDv7).

### 3.2 `POST /api/agents/heartbeat`
```json
{
  "agentId": "CR-OA-002-A-RED",
  "projectKey": "<uuid>",
  "status": "online",
  "message": "RED: 3/5 tests failing",
  "identity": {
    "displayName": "CR-OA-002-A RED Agent",
    "source": "openclaw",
    "repoPath": "/abs/path"
  }
}
```
- `status` ∈ `online | busy` (agent-protocol skill).
- **`displayName` is honored ONLY inside `identity`** — top-level `displayName` is silently
  ignored (java/bun/vscode skill Rules; `mvn-crucible.py:218` comment). Older clients
  (`crucible-register` skill, `rust-crucible.py:360-369`) still send top-level
  `displayName`/`source` — v2 must keep tolerating (ignoring) them.
- `identity` is optional and **preserved across subsequent heartbeats** that omit it
  (agent-protocol: "send once, preserved across heartbeats").
- `identity.source` values seen: `openclaw`, `claude-code`, `claude-md`, `package-json`,
  `git-repo`, `manual`.
- Response: `{"ok": true}`.
- Liveness thresholds (server-side defaults, agent-protocol skill): online → **stale after
  60 s** → **offline after 300 s** → **removed after 1 h offline**.

### 3.3 `POST /api/agents/remove`
```json
{"agentId": "<id>", "projectKey": "<uuid>"}
```
- Skills say both fields required; `crucible-register` shows agentId-only (older). v2:
  require `agentId`, accept missing `projectKey` by removing the agent everywhere.

### 3.4 `POST /api/ingest` (raw, server-side parser)
```json
{"projectKey": "<uuid>", "format": "junit", "dataPath": "/abs/junit.xml|/abs/reports-dir", "agentId": "<id>"}
```
- `format`: only `junit` observed. `data` (inline XML string) is the alternative to
  `dataPath` (crucible-register table: "format + data or dataPath").
- `dataPath` may be a **file** or a **directory** — directory means all `TEST-*.xml` inside
  (crucible-report-java: "directory is preferred for surefire").
- Response: `{"ok": true, "summary": {"total": N, "passed": N, "failed": N, ...}}` —
  clients print `passed/failed/total` from it (`rust-crucible.py:417-421`).
- JUnit semantics (mirrors every client-side parser): testcase with `<failure>` or
  `<error>` → fail; `<skipped>` → pending; else pass. `time` attr (seconds) → duration_ms.
  Root may be `<testsuites>` or a bare `<testsuite>`.
- Historical parser quirk (python-crucible.py:268): "the server-side format=junit parser
  historically labeled leaves" with class-qualified names — v2 leaf name = testcase `name`
  attr, suite node = testsuite `name` attr.

### 3.5 `POST /api/ingest/parsed`
```json
{
  "projectKey": "<uuid>", "agentId": "<id>",
  "summary": {"total": 34, "passed": 34, "failed": 0, "pending": 0, "duration_ms": 5120},
  "tree": [
    {"name": "suite-name", "status": "pass|fail",
     "children": [{"name": "test-name", "status": "pass|fail|pending", "duration_ms": 12}]}
  ],
  "coverage": {
    "lines":     {"total": 1000, "covered": 900, "percent": 90.0},
    "functions": {"total": 200,  "covered": 180, "percent": 90.0},
    "branches":  {"total": 400,  "covered": 300, "percent": 75.0}
  }
}
```
- `coverage` optional; `branches` optional within it (rust/bun send lines+functions only;
  java/vscode add branches).
- `name` (run label) optional — arduino sends the project name (`arduino-crucible.py:133`).
- **Server safety net: coverage on a failing run is DISCARDED** — crucible-report-java:
  "Crucible's `recordEvent` discards coverage on failing runs as a safety net". (Client
  discipline: coverage only on full green regression.)

### 3.6 `POST /api/ingest/compile`
```json
{"projectKey": "<uuid>", "agentId": "<id>", "format": "rustc", "errors": "<raw compiler output>"}
```
- `format` values sent: `rustc` (rust), `python` (python), `typescript` (bun),
  **absent** (mvn, arduino, vscode) — so format is OPTIONAL; absent implies javac/generic.
- Server parses errors into structured per-file entries; raw text kept as fallback:
  - java: `[ERROR] /path/File.java:[line,col] message` (crucible-report-java §Compile Failure)
  - rustc: `error[EXXXX]:` blocks with ` --> path:line:col`
- Response summary convention (rust skill prints): `summary.failed` = error count,
  `summary.pending` = warning count.
- Routing discipline (all skills, MUST hold in v2 UI): compile errors → **compile panel**;
  test results → **test panel**; never cross. "Tests ran but all failed" is a TEST event,
  not a compile event.

### 3.7 `POST /api/ingest/clear` / `GET /api/ingest/status`
- clear: `{"projectKey": "<uuid>"}`.
- status: `?projectKey=<uuid>&type=unit|bdd` — the `unit|bdd` axis is the TDD/BDD split
  (backend projects: unit only; frontend projects were to add BDD). Exact response shape
  UNKNOWN (no surviving reader) — v2 defines it, see PRD §4.9.

### 3.8 Events
- `GET /api/events?projectKey=<uuid>&limit=20` — default limit 50, newest first.
- Event id format: `evt-<epoch-ms>-<seq>` (example in skills: `evt-1772349499258-33`).
- `POST /api/events/delete` `{"eventId": "evt-…", "projectKey": "<uuid>"}`.
- `POST /api/events/clear` `{"projectKey": "<uuid>"}`.

## 4 Client inventory (what must keep working, unmodified)

| Client | Stack | Calls |
|---|---|---|
| `rust-crucible.py` | Rust/nextest/llvm-cov | heartbeat, remove, ingest (junit dataPath), ingest/compile (rustc), ingest/parsed (+coverage) |
| `mvn-crucible.py` | Java/surefire/failsafe/JaCoCo | heartbeat (identity), remove, ingest (junit dir dataPath), ingest/parsed (+branches coverage), ingest/compile (no format) |
| `python-crucible.py` | pytest/unittest/coverage.py | heartbeat, remove, ingest (junit), ingest/parsed, ingest/compile (python) |
| `bun-crucible.py` | bun test/lcov | heartbeat (identity+repoPath), remove, ingest/parsed, ingest/compile (typescript) |
| `arduino-crucible.py` | native g++/arduino-cli | **projects/add**, heartbeat, remove, ingest/parsed, ingest/compile (no format) |
| `hw-crucible.py` | (21-line shim) | delegates |
| skills `crucible-report-*` | all stacks | curl/urllib/fetch equivalents of the above + events delete/clear/list |
| skill `crucible-register` / `agent-protocol` / `heartbeat.sh` | lifecycle | heartbeat, remove |

## 5 Inferred (no surviving reader — v2 defines, flagged here for honesty)

1. `GET /api/projects` / `GET /api/agents` / `GET /api/events` **response shapes** — only
   the query params survive. v2: `{"ok": true, "projects|agents|events": [...]}`.
2. `/api/ingest/status` response shape (§3.7).
3. `/api/projects/add` success response — v2: `{"ok": true, "project": {...}}`.
4. Project record fields beyond `key/name/sut_root` — the UI showed a **frontend/backend
   type** (user recollection); v2 adds optional `type` on add, default `backend`.
5. Event retention policy — v2 caps at 1000 events/project (explicit `/api/events/clear`
   existed, so retention was manual in v1).

## 6 Retirement (2026-07-18 — CR-CRU-008 §S4, soak-gated)

The v1 shim catalogued above is **RETIRED** as of CR-CRU-008 (merged on
`feature/CR-CRU-008`, C7 commit `caed1aa`). The soak gate passed: one full
RED→GREEN→regression dog-food cycle of this repo executed end-to-end through
the UPGRADED clients (`clients/*-crucible.py`) against a server with the v1
routes removed — evidenced by the C7 full-suite run (819/819) ingested via
`clients/bun-crucible.py` on `/api/v2/*` only, and by
`tests/timeline-dogfood-linkage.test.ts`.

Removed from `src/server.ts`: every legacy `/api/*` route handler catalogued
in §2-§3 — `POST /api/ingest`, `/api/ingest/parsed`, `/api/ingest/compile`,
`/api/ingest/clear`, `GET /api/ingest/status`, `POST /api/agents/heartbeat`,
`/api/agents/remove`, `GET /api/agents`, `POST /api/projects/add`,
`GET /api/projects`, `GET /api/events`, `POST /api/events/delete`,
`/api/events/clear`. **`GET /api/health` and `GET /api/stream` are RETAINED**
(never v1-shim scope). Unknown `/api/*` now returns the generic 404 JSON.

The reconstructed v1 contract in §1-§5 is preserved as a **historical evidence
catalog** — it documented what the lost server did and gated the v2 rebuild's
wire-compatibility; that guarantee has now been intentionally released. The
v1-contract test suite is archived at `tests/archive/v1-contract.test.ts`
(excluded from `bun test` via `bunfig.toml`). The five `clients/*-crucible.py`
scripts are the v2-native source of truth; the live `~/.claude/scripts/`
copies sync via CR-CRU-009's install step. Bulk event clearing
(`/api/events/clear`) is deliberately NOT carried forward — v2's posture is an
immutable audit log with per-project, double-gated single-event deletion
(`DELETE /api/v2/events/<id>`, CR-CRU-008 §S4).
