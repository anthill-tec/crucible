# CR-CRU-013 — Workflow events: gates (no-mistakes) + milestones

**Status:** IN_PROGRESS (2026-07-18 — gap analysis underway)
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

### §S4b Milestone events (round-24 fold-in — WORKSPACE timeline only)
Lightweight siblings of gates, one workflow-event family:
`POST /api/v2/milestones` `{projectKey, agentId, type, label?, context?{cr,
wave, track}}` with `type` ∈ `gap-analysis | design-review | stage-flip |
custom` (unknown type → 400 naming `type`). Stored `kind:"milestone"`; excluded
from test rollups; implicit heartbeat; SSE. UI: a **slim entry row** (◇ glyph,
type + label + CR badge + relative time) on the **project workspace timeline
ONLY** — the home collective feed omits milestones (user-scoped round 24: the
workflow journal is project-scoped; home stays a cross-project run feed). The
gate boundary card (§S2) renders on the workspace timeline; home shows a
compact one-line gate entry (a wave seal is significant enough to surface
cross-project).

### §S4c CR-merge markers (user-filed 2026-07-16, from the CR-016 gate review)
User (annotating the F13 gate row): "There should be an entry similar to this
to mark the end of a feature merge. It brings a break in the timeline just
like the RED GREEN barrier as well as demarcates the end of a CR's
implementation. This will have to be sent as a marker event by the
orchestrator or the script tool responsible for the close out!"
A third workflow-event sibling: `type:"cr-merged"` on the milestone family
(`POST /api/v2/milestones` `{type:"cr-merged", label:<CR id>, context:{cr,
wave, track}, commit}` — `commit` = the merge sha). UI: a full-width BREAK
row on the timeline (same structural weight as the RED→GREEN transition
marker, distinct glyph — e.g. ⚑):
`⚑ <CR-id> merged · <n> cycles · <branch>@<shortsha> · <relative time>` —
rendered on the WORKSPACE timeline and (like gates) as a compact one-line
entry on home (a CR merge is significant enough to surface cross-project).
Sender: the close-out path — the fleet `cr-close` verb (CR-CRU-008 / plan
close in CR-CRU-011) emits it automatically on merge; until the fleet verb
exists the orchestrator sends it manually at close-out. Once CR-CRU-011
plans exist, the marker links `plans.cr` (the commitBoundary join key).
`gate-report` on the fleet clients: parses `no-mistakes axi status` TOON (or
accepts `--outcome/--steps/--commit` flags as fallback) → `POST /api/v2/gates`,
auto-attaching `context.wave` from `WORKFLOW_WAVE` and `track` from
`WORKFLOW_ROLE` (established pattern). Sibling `milestone` verb:
`milestone --type gap-analysis --label "CR-NAI-043 gap-analysis" [--cr …]` →
`POST /api/v2/milestones` with the same env auto-context.

### §S6 Wave state integration
The lens wave state machine gains `gated`: `running → lanes complete · awaiting
review → gated (a passed/checks-passed gate event for that wave) → superseded`.
Still zero wave-control API — state remains inferred from plans + gate events.

## Acceptance criteria
- [ ] §S4c CR-merge marker: `POST /api/v2/milestones` with `type:"cr-merged", label:"CR-NAI-042", commit:"abc1234", context:{cr:"CR-NAI-042", wave:1}` → 201 stored as a milestone; the WORKSPACE timeline renders a full-width `data-testid="merge-marker"` break row whose text matches `⚑ CR-NAI-042 merged · … abc1234` (same structural weight/placement rules as transition markers); home renders the compact one-line entry; test rollups unchanged; `type:"cr-merged"` joins the §S4b valid-type set.
- [ ] `POST /api/v2/gates` with the full §S1 shape → 201; the stored event has `kind:"gate"`, `codec:"no-mistakes"`; missing `outcome` → 400 naming `outcome`; test-run rollup counts are unchanged by gate ingestion.
- [ ] The timeline renders a gate event as a full-width `data-testid="gate-card"` containing the outcome and pushed short-commit; it never contains the string "0/" (no test-ratio leakage).
- [ ] Clicking the gate card opens the drill-in with the step ladder (one row per submitted step, status visible), the fixes table (row count equals submitted fixes), and no `drillin-mode` element.
- [ ] Workflow tab: with a gate ingested for wave 3, the gate pane shows its outcome + step ladder; ingesting a second wave-3 gate replaces the pane content (latest wins) — over SSE, no reload.
- [ ] Wave state: wave 3 with all plans closed + a `passed` gate event renders `gated` in the lens header (fixture also asserts `awaiting review` before the gate arrives); grep asserts no wave-control route exists.
- [ ] Client: `bun-crucible.py gate-report --outcome passed --commit abc1234 --steps "review:passed,test:passed"` posts a valid gate with `context.wave` from `WORKFLOW_WAVE`; unset env → no wave key.
- [ ] §S4b: `POST /api/v2/milestones {type:"gap-analysis", label:"…"}` → 201 `kind:"milestone"`; `type:"deploy"` → 400 naming `type`; rollups unchanged; the WORKSPACE timeline renders a `data-testid="milestone-entry"` slim row with the ◇ glyph + type + label, while the HOME timeline renders zero milestone entries for the same fixture (workspace-scoped assertion).
- [ ] E2E: `tests/e2e/gates.e2e.ts` — file plan → milestone gap-analysis → close cycles + plan → ingest gate via API → workspace timeline shows the milestone entry AND the boundary card, home shows the compact gate entry but no milestone, `gated` wave header + populated gate pane; results ingested `tier:"e2e"`.

## Estimated size
M.

## Risk
Payload drift if no-mistakes' output evolves — mitigated by verbatim/tolerant
step storage and the flags fallback on `gate-report`.

## Non-goals
Driving no-mistakes FROM Crucible (report-only); wave-control API; gating
non-no-mistakes pipelines (structure is codec-shaped for future codecs).
