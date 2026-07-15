# CR-CRU-010 — Codec path-parsing interface + shim regression hardening

**Status:** PENDING
**Type:** maintenance
**Priority:** P2
**Depends on:** CR-CRU-006
**Labels:** codecs, api, tests
**Phase:** Wave 3 (interleaved after CR-CRU-006, before CR-CRU-007)
**Design reference:** DN-crucible-api-reconstruction §3.4 (dataPath semantics); CR-CRU-005 VERIFY suggestion; CR-CRU-004 AC9

## Context
Three small user-approved hardening items from the deferred register, bundled
(scheduling decision 2026-07-15 via the review board): the codec registry's missing
path-parse capability (currently `dataPath` bypasses the registry via a direct
`parseJunitPath` call inside the shared `parseRunBody` helper in
`src/codecs/index.ts` — an abstraction gap that turns into a bug the day a second
file-based codec arrives), a dedicated cross-surface regression test, and per-branch
validation assertions.

## Scope

### §S1 Path-capable Codec interface
`Codec` gains optional `parsePath?(path: string): Promise<RunSchema>`; the `junit`
registry entry registers `parseJunitPath`. Both ingest routes (v1 `POST /api/ingest`
and v2 `POST /api/v2/runs`) resolve `dataPath` THROUGH the registry entry — the
shared `parseRunBody` helper (`src/codecs/index.ts`, both routes' ingest core) calls
`codec.parsePath` instead of special-casing `parseJunitPath`; a codec without
`parsePath` + a `dataPath` request → 400 `{ok:false, error}` naming the codec.
No direct `parseJunitPath` call remains outside the registry registration.

### §S2 Cross-surface regression test
Dedicated request-pair test: `POST /api/ingest` (v1 shape) → `GET /api/v2/events`
shows the event as a flattened §S0 brief (and vice-versa sanity: v2 runs ingest →
v1 `GET /api/events` shows it with nested summary).

### §S3 Per-branch 400 assertions
One named assertion per missing-required-field validation branch across shim + v2:
`errors` (compile), `summary`/`tree` (parsed), `eventId` (events/delete), `agentId`
(heartbeat/register), missing `project` query param (status) — each asserting HTTP
400 and an `error` string naming the field.

## Acceptance criteria
- [ ] `codecs.get("junit")!.parsePath` is a function; `POST /api/v2/runs {codec:"junit", dataPath:<dir>}` and v1 `POST /api/ingest {format:"junit", dataPath}` both succeed with the SAME summaries as before (regression-guarded against existing dataPath tests).
- [ ] grep `parseJunitPath` in `src/server.ts` + `src/v2.ts` returns 0 AND its only occurrence in `src/codecs/index.ts` is the `junit` registry entry's `parsePath` registration — the `parseRunBody` helper body contains no `parseJunitPath` call (registry-only resolution).
- [ ] A registry entry stub without `parsePath` given a `dataPath` request → 400 with the codec name in `error`.
- [ ] Cross-surface pair test exists and passes both directions (v1→v2 flattened brief; v2→v1 nested summary).
- [ ] ≥ 6 named per-branch 400 assertions, each failing independently if its branch's validation is removed (verified by test names enumerating the field).

## Estimated size
S.

## Risk
None material — interface addition is optional-method, behavior-preserving for junit.

## Non-goals
New codecs (BDD wave); any UI.
