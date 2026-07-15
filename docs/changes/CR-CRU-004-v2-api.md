# CR-CRU-004 — Clean v2 API + SSE

**Status:** COMPLETED (shipped 2026-07-15 on develop)
**Type:** feature
**Priority:** P0
**Depends on:** CR-CRU-003
**Labels:** api, v2, sse
**Phase:** Wave 2
**Design reference:** PRD §2 (API strategy), §3.3 (context), §4.2–§4.9, §4.10 (health), navigation/progressive-paging PRD §4.11

## Context
The primary contract: quirk-free v2 surface at `/api/v2/*`, shared core with the shim.
Adds run context, SSE live channel, and progressive event paging.

## Scope

### §S1 Routes (`src/v2.ts`)
GET `/api/v2` (orientation: service, version, projects, next-step hints); GET
`/api/v2/health` (same shape as `/api/health`); GET+POST `/api/v2/projects` (POST:
`{key?, name, type?, sutRoot?}` — key auto-generated UUIDv7 when omitted; duplicate
key → 200 `{ok:true, changed:false}` NOT 400); POST `/api/v2/agents/register`,
`/api/v2/agents/heartbeat` (same handler semantics), `/api/v2/agents/unregister`;
GET `/api/v2/agents?project=` (each agent carries computed `liveness`); POST
`/api/v2/runs` (raw, `{codec, data|dataPath}`; malformed `data` / unreadable
`dataPath` → 400 `{ok:false, error}`, never a plain-text 500), `/api/v2/runs/parsed`,
`/api/v2/runs/compile`; GET `/api/v2/events?project=&limit=`; GET+DELETE
`/api/v2/events/:id`; GET `/api/v2/status?project=`.

### §S2 Run context (graceful — hard requirement)
All three runs endpoints accept optional `context {git {branch, commit}, wave,
orchestrator}` + `tier` + `stack`; stored on the event verbatim; absent context is
never an error and never fabricated in responses.

### §S3 SSE (`GET /api/stream`)
`text/event-stream`; first frame `{type:"hello", version}`; on store change a frame
`{type: "projects"|"agents"|"events", projectKey}`; comment keep-alive every 15 s;
client disconnect unsubscribes (no leak).

### §S4 Progressive event detail
`GET /api/v2/events/:id?depth=suites` returns the event with each suite node reduced
to `{name, status, counts {passed, failed, pending}}` (no leaves); `?suite=<name>`
returns that suite's full leaves. Default (no params) = full tree (small runs).

### §S5 Writes report change
Every POST/DELETE response carries `changed: true|false` (idempotent re-runs safe).

## Acceptance criteria
- [x] `GET /api/v2` → 200 with `service: "crucible"`, a `projects` array, and a non-empty `help` array.
- [x] `POST /api/v2/projects {name:"X"}` (no key) → `{ok:true, changed:true}` and `project.key` matches UUID regex; repeat with that key → `{ok:true, changed:false}` (HTTP 200, unlike the shim's 400).
- [x] `POST /api/v2/agents/register` on an unknown project → 404 with `help` array present; on a valid one → `{ok:true, changed:true}`; second register of same agent → `changed:false`.
- [x] `POST /api/v2/runs` junit ingest returns `{ok:true, event: "evt-…", verdict}` where `verdict` starts `"RED"` when failed>0 and `"GREEN"` when failed=0.
- [x] `POST /api/v2/runs/parsed` with `context {git:{branch:"develop", commit:"abc123"}, wave:"w1", orchestrator:"track-2"}` → `GET /api/v2/events/:id` echoes that context verbatim; the same call with NO context succeeds and the stored event has no `context` key.
- [x] `GET /api/v2/events/:id?depth=suites` on a 3-suite run returns 3 suite nodes each WITHOUT `children` but WITH `counts.failed`; `?suite=<name>` returns that suite's leaves including `failure.message` on failed ones.
- [x] SSE: connecting client receives the `hello` frame, then an `events`-type frame within 1 s of an ingest; a `: keep-alive` comment arrives within 20 s of silence.
- [x] `DELETE /api/v2/events/:id?project=<key>` → `{ok:true, changed:true}`; repeating it → `changed:false` (or 404 with `ok:false` — spec: 404).
- [x] Integration: the v1 shim handlers and v2 handlers call the SAME store instance (grep: exactly one `new Store(` in server bootstrap); an event ingested via legacy `/api/ingest` is visible via `GET /api/v2/events`.

## Estimated size
L.

## Risk
Progressive paging shape must anticipate the CR-CRU-007 client — UI CR owner reviews
this spec's §S4 before RED.

## Non-goals
TOON/help-hint polish (CR-CRU-005 — plain JSON here), UI, BDD run harness.
