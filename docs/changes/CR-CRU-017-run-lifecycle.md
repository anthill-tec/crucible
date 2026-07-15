# CR-CRU-017 — Run lifecycle: start/end events + the Aborted state

**Status:** PENDING (0.2.0 — user-filed during CR-007 execution)
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-008, CR-CRU-011
**Labels:** api, runs, lifecycle, ui
**Phase:** Wave 5 (0.2.0) — track-3 candidate (independent of CR-014/015; lane
allocation confirmed by mainline at 0.2.0 planning)
**Design reference:** board note 2026-07-15: "a test run is now multiple
events — a start test run and end test run with the real data… if a run fails
due to reasons other than the tests itself, like timeout, a third state
Aborted can be recorded… helps Crucible compute the run time accurately."

## Context
Today a run is one ingest event carrying the tool-reported `duration_ms`.
Crucible never sees the run START, so: wall-clock runtime is unknowable (queue
+ spawn + teardown time invisible), a hung/timed-out/killed run simply never
appears, and the timeline can't show "running now". This CR makes the run a
LIFECYCLE: start → end (with the real data) | aborted (with a reason).

## Scope

### §S1 Run-start + run-end (server, additive)
- `POST /api/v2/runs/start` `{projectKey, agentId, tier?, stack?, context?}` →
  202 `{runId, startedAt}` — records an OPEN run (implicit heartbeat, SSE).
- Every existing ingest path (`/runs`, `/runs/parsed`, `/runs/compile`) gains
  optional `runId` — closing the open run: the stored event carries
  `startedAt` + server-computed `runtime_ms = endedAt − startedAt` alongside
  the tool-reported `duration_ms`.
- **Graceful degradation is sacred:** single-shot ingests without a start keep
  working byte-identically (no runId → no lifecycle fields).
- An open run with neither end nor abort: auto-aborted when its agent
  tombstones (reason `agent died` — rides CR-011's lifecycle machinery) or
  after a configurable staleness timeout (`CRUCIBLE_RUN_ABANDON_MS`).

### §S2 The Aborted state (third terminal state)
`POST /api/v2/runs/<runId>/abort` `{reason}` — for timeouts, agent kills,
infrastructure failures: anything that ends a run for NON-TEST reasons. The
stored event has `status:"aborted"` + the reason — it is neither pass nor
fail and never pollutes pass/fail rollups, transition pairing (streaks ignore
aborted runs), or coverage. Distinct rendering: struck/grey card with the
reason (a fourth presentation state — outside the pass/fail/pending palette).

### §S3 UI
Timeline shows an OPEN run as a live "running…" card (pulsing, elapsed timer
off `startedAt`, SSE-updated) that resolves into the end event's card (or the
aborted card) in place. Drill-in of an aborted run shows the reason + whatever
partial context exists. Workflow tab: an active cycle's open span shows its
currently-running run live.

### §S4 Client verbs (fleet)
The upgraded scripts wrap execution automatically: `run-start` before spawning
the tool, end-with-runId on ingest, `run-abort --reason` on timeout/signal
(trap SIGINT/SIGTERM); `--no-lifecycle` opt-out preserves single-shot
behavior.

## Acceptance criteria
- [ ] `POST /runs/start` → 202 with runId; ingesting with that runId stores ONE event carrying `startedAt` + `runtime_ms` (= endedAt − startedAt, asserted against a fixture delay) alongside `duration_ms`; a single-shot ingest without runId stores an event with NO lifecycle fields (byte-identical regression guard).
- [ ] `POST /runs/<id>/abort {reason:"timeout"}` → the stored event has `status:"aborted"` + the reason; pass/fail rollups, streak pairing, and coverage are all unchanged by aborted runs (fixture asserts counts before/after).
- [ ] An open run whose agent tombstones is auto-aborted with reason `agent died`; an open run older than `CRUCIBLE_RUN_ABANDON_MS` is auto-aborted with reason `abandoned`.
- [ ] Timeline: an open run renders a `data-testid="running-card"` with a ticking elapsed timer; on end it resolves in place to the run card (SSE, no reload); an aborted run renders the distinct aborted presentation with the reason text.
- [ ] Client: the wrapped script emits start→end around a real run (runtime_ms > duration_ms asserted); killing the tool mid-run produces an aborted event with the signal reason; `--no-lifecycle` produces a single-shot event.
- [ ] BDD E2E: `run-lifecycle.feature` — start → running card visible → ingest → resolves; start → abort → aborted card with reason.

## Estimated size
M–L.

## Risk
Open-run state must survive server restarts (persist open runs in SQLite, not
memory); double-end/end-after-abort races → 409 semantics.

## Non-goals
Retrofitting lifecycle onto historical events; progress streaming DURING a run
(only start/end/abort); per-test live streaming.
