# CR-CRU-013 — Wave-boundary gate events: no-mistakes ingestion + gate pane

**Status:** PENDING
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-008, CR-CRU-011
**Labels:** api, workflow, gates, ui
**Phase:** Wave 4 (after 011/008, before 009 — user-directed rounds 21–22, 2026-07-15)
**Design reference:** board register row "Wave-boundary GATE events" (round 21) + Workflow-tab arrangement (round 22); no-mistakes axi output structure as the payload/UI model

## Context
The user runs the **no-mistakes pipeline at wave boundaries**, with the push to
remote following the run — a no-mistakes push is categorically different from an
ordinary push. Crucible ingests that run as a first-class **gate event**: the
wave boundary becomes EVIDENCE on the timeline (round-20's "no wave API" holds —
wave state stays inferred, now sealable by a real artifact). The active gate
renders in the Workflow tab's **no-mistakes pane** (round 22).

## Scope

### §S1 Gate event (server, additive)
`POST /api/v2/gates` `{projectKey, agentId, context?{wave, track?}, gate:{intent,
outcome, steps:[{name, status, findings?{total, autoFix, askUser, fixed},
fixRounds?}], fixes?:[{id, file, description}], push?:{commit, remote}, pr?}}`.
`outcome` ∈ `checks-passed | passed | failed | cancelled`; step `name`s follow
the no-mistakes ladder (`intent, rebase, review, test, document, lint, push, pr,
ci`) but are stored verbatim (forward-tolerant). Missing `intent`/`outcome`/
`steps` → 400 naming the field. Stored as event `kind:"gate"`,
`codec:"no-mistakes"`; flows through retention; EXCLUDED from test-run rollups;
counts as implicit heartbeat; emits SSE.

### §S2 Timeline wave-boundary card
Gate events render as a **full-width boundary card** (distinct from run cards —
🛡 icon, outcome-colored edge): `🛡 Wave <n> gate — no-mistakes <OUTCOME> ·
<steps> steps · <findings fixed> · pushed <shortcommit>`. Never rendered as
"0/N tests". Click opens the drill-in (§S3).

### §S3 Gate drill-in body (codec-aware)
Mirrors the axi structure: outcome banner, the **step ladder** with per-step
status + findings counts + fix rounds, the **fixes table** (id, file,
description), and the push/PR line. Same slide-over surface, `← timeline` back
chip, no Detail/Density switch (single form, like compile).

### §S4 Workflow-tab gate pane
The Workflow tab's live section (CR-011 §S3) carries a **no-mistakes pane**:
the latest gate for the current wave, step ladder with statuses, updating over
SSE. Empty state: "no gate run this wave yet".

### §S5 Client verb
`gate-report` on the fleet clients: parses `no-mistakes axi status` TOON (or
accepts `--outcome/--steps/--commit` flags as fallback) → `POST /api/v2/gates`,
auto-attaching `context.wave` from `CRUCIBLE_WAVE` and `track` from
`CRUCIBLE_ORCHESTRATOR` (established pattern).

### §S6 Wave state integration
The lens wave state machine gains `gated`: `running → lanes complete · awaiting
review → gated (a passed/checks-passed gate event for that wave) → superseded`.
Still zero wave-control API — state remains inferred from plans + gate events.

## Acceptance criteria
- [ ] `POST /api/v2/gates` with the full §S1 shape → 201; the stored event has `kind:"gate"`, `codec:"no-mistakes"`; missing `outcome` → 400 naming `outcome`; test-run rollup counts are unchanged by gate ingestion.
- [ ] The timeline renders a gate event as a full-width `data-testid="gate-card"` containing the outcome and pushed short-commit; it never contains the string "0/" (no test-ratio leakage).
- [ ] Clicking the gate card opens the drill-in with the step ladder (one row per submitted step, status visible), the fixes table (row count equals submitted fixes), and no `drillin-mode` element.
- [ ] Workflow tab: with a gate ingested for wave 3, the gate pane shows its outcome + step ladder; ingesting a second wave-3 gate replaces the pane content (latest wins) — over SSE, no reload.
- [ ] Wave state: wave 3 with all plans closed + a `passed` gate event renders `gated` in the lens header (fixture also asserts `awaiting review` before the gate arrives); grep asserts no wave-control route exists.
- [ ] Client: `bun-crucible.py gate-report --outcome passed --commit abc1234 --steps "review:passed,test:passed"` posts a valid gate with `context.wave` from `CRUCIBLE_WAVE`; unset env → no wave key.
- [ ] E2E: `tests/e2e/gates.e2e.ts` — file plan → close cycles + plan → ingest gate via API → boundary card on timeline + `gated` wave header + populated gate pane; results ingested `tier:"e2e"`.

## Estimated size
M.

## Risk
Payload drift if no-mistakes' output evolves — mitigated by verbatim/tolerant
step storage and the flags fallback on `gate-report`.

## Non-goals
Driving no-mistakes FROM Crucible (report-only); wave-control API; gating
non-no-mistakes pipelines (structure is codec-shaped for future codecs).
