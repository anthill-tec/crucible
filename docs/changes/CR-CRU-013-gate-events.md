# CR-CRU-013 — Workflow events: gates (no-mistakes) + milestones

**Status:** IN_PROGRESS (2026-07-18 — gap analysis + design review DONE; C1 server foundation merged-into-branch & sealed; gate UX/mechanism locked across storyboard F8/F8½/F8¾/F13; C2 next)
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
Gate events render on the timeline using the SAME MARKER DESIGN as the
declared ⟲ Cycle-done boundary (user consistency ruling 2026-07-18) — the
`.app-transition-marker`/cycmark dashed-pill form, outcome-colored border
(green passed/checks-passed · red failed · grey cancelled), with a trailing
DRILL-DOWN BADGE (`⊙ Detail`, matching the CR-025 `⚑ Cycle` badge
pattern) that opens the drill-in (§S3). Content:
`🛡 Wave <n> gate · no-mistakes <OUTCOME> · <steps> steps · <findings fixed> ·
pushed <shortcommit>`. NEVER rendered as "0/N tests". `data-testid="gate-card"`.
The badge (not the whole body) is the drill affordance, consistent with the
cycle marker's badge-drill convention. Storyboard F8 is the visual contract.

### §S3 Gate drill-in body (codec-aware)
Mirrors the axi structure: outcome banner, the **step ladder** with per-step
status + findings counts + fix rounds, the **fixes table** (id, file,
description), and the push/PR line. Same slide-over surface, `← timeline` back
chip, no Detail/Density switch (single form, like compile).

### §S4 Workflow-tab gate widget — CONTEXTUAL (user ruling 2026-07-18: "This need not appear in the Workspace all the time … a contextual widget that appears only when no-mistakes is running")
The gate is NOT a persistent pane. The CR-011 `GatePane` placeholder
(app.js — currently an always-mounted `data-testid="gate-pane"` column in
`app-workflow-cols` reading "gate reporting lands in CR-013") is REMOVED, not
populated. In its place, a CONTEXTUAL gate widget appears in the Workflow tab
ONLY when a no-mistakes gate is LIVE for the current wave — i.e. at the
wave/release boundary, when the wave's CRs are all done and no CR is active
(§S6 lanes-complete → gating/gated). During normal CR execution the Workflow
tab shows ONLY the active-CR view — no gate element, no empty "no gate yet"
state, no clutter. When no-mistakes runs, the widget REUSES THE ACTIVE-WORKFLOW ZONE — the same
space the live plan (active CR's cycle todo) occupies during execution (user
ruling 2026-07-18: "since this wont be active at the time of no-mistakes run,
this area can be reused for no-mistakes run display"). So the Workflow tab's
primary zone is contextual, showing exactly ONE of: the LIVE PLAN (active CR,
mid-execution) OR the NO-MISTAKES RUN (the live 9-step ladder, at the
wave/release boundary) — the two are mutually exclusive and never coexist,
matching the F13 title "the live plan + no-mistakes pane". The widget streams
over SSE (interim snapshots → final seal); once the wave advances it recedes,
the durable record living on as the timeline 🛡 seal (§S2) + history. No
persistent element, no empty state — the zone simply shows whatever is active
now.

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
Two client verbs (user refinement 2026-07-18 — "build the parsing and
streaming within the python client layer; the orchestrator is just a consumer
of the output … can save some tokens"):

- **`gate-run` — the axi-PROXY wrapper (primary path; user model 2026-07-18:
  "the Python client acts like an axi proxy to the orchestrator while also
  serving crucible").** The client sits BETWEEN the orchestrator and
  no-mistakes and plays TWO roles at once: (a) it PROXIES the no-mistakes axi
  interface to the orchestrator — relaying the TOON (findings, gates, step
  detail) up so the orchestrator can make decisions, and passing the
  orchestrator's `respond`/intent down — because the orchestrator is the
  decision-maker no-mistakes' axi is designed to be driven by; AND (b) it
  simultaneously FORKS that same TOON stream, decodes each step via
  `clients/toon.py` (C4), and streams gate events to Crucible (throttled
  interim snapshots per the §S2b cadence + a final sealing
  `POST /api/v2/gates`). One client, two consumers: the orchestrator gets the
  detail it needs to decide; Crucible gets the parsed gate timeline. The
  efficiency is that the client owns the Crucible-side PLUMBING (TOON→gate
  event POSTs) so the orchestrator never re-formats or re-posts — not that the
  detail is hidden (it isn't; the orchestrator needs it). `--yes` lets the
  client auto-resolve mechanical findings without a proxy round-trip; genuine
  ask-user findings surface to the orchestrator through the proxy.
- **`gate-report` — the lighter report-only verb (retained).** Parses a
  pre-existing `no-mistakes axi status` TOON (or `--outcome/--steps/--commit`
  flags) → `POST /api/v2/gates` — for when no-mistakes was already run
  separately and you only want to report the sealed result.

Both auto-attach `context.wave` from `WORKFLOW_WAVE` and `track` from
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
- [ ] Client `gate-run` (axi proxy + Crucible reporter): with a fake `no-mistakes` on PATH emitting a scripted TOON stream (steps completing over a few seconds), `bun-crucible.py gate-run --intent "…"` (a) posts ≥1 INTERIM gate to `/api/v2/gates` before the final sealing post (throttled per §S2b) and (b) a final gate whose outcome matches the stream — WITHOUT the caller issuing any POST itself (the client owns the Crucible plumbing); (c) the no-mistakes axi detail is still RELAYED to the caller (proxy role) so the orchestrator can decide — assert the verb surfaces the stream/findings to its caller, not swallows them.
- [ ] §S4b: `POST /api/v2/milestones {type:"gap-analysis", label:"…"}` → 201 `kind:"milestone"`; `type:"deploy"` → 400 naming `type`; rollups unchanged; the WORKSPACE timeline renders a `data-testid="milestone-entry"` slim row with the ◇ glyph + type + label, while the HOME timeline renders zero milestone entries for the same fixture (workspace-scoped assertion).
- [ ] E2E: `tests/e2e/gates.e2e.ts` — file plan → milestone gap-analysis → close cycles + plan → ingest gate via API → workspace timeline shows the milestone entry AND the boundary card, home shows the compact gate entry but no milestone, `gated` wave header + populated gate pane; results ingested `tier:"e2e"`.

### §S3 addendum — drill-in origin (LOCKED 2026-07-18, user design review)
A gate is a wave-boundary MARKER, not a run (same class as the RED→GREEN
transition marker / ⟲ Cycle-done boundary). The gate drill-in (§S3) is
reachable from BOTH surfaces where the gate appears: the Runs-timeline 🛡
boundary card (§S2) and the Workflow-tab gate pane (§S4). Per CR-016's
one-rule, the drill-in is a pane state of WHICHEVER pane opened it — the back
chip names the origin (`← runs` from the timeline seal, `← workflow` from the
gate pane); tabs hide; the Project pane stays live; single form (no density
switch). Storyboard F8½ is the visual contract.

## Estimated size
M.

## Risk
Payload drift if no-mistakes' output evolves — mitigated by verbatim/tolerant
step storage and the flags fallback on `gate-report`.

## Non-goals
Driving no-mistakes FROM Crucible (report-only); wave-control API; gating
non-no-mistakes pipelines (structure is codec-shaped for future codecs).

## Implementation Notes (gap analysis 2026-07-18 — decisions before RED)
- **Substrate first (C1):** gates/milestones/cr-merged are a NEW event-kind
  family. Blockers found: `store.toEvent` collapses any non-compile/lifecycle
  kind to "test"; `RunEvent.kind` is a 3-value union; no generic payload
  column; rollup exclusion is the single `kind !== "lifecycle"`. C1 widens
  the union + toEvent passthrough, adds a dedicated `payload` JSON column
  (additive PRAGMA-retrofit, as with archived_at/allow_run_deletion), and
  inverts rollup exclusion to a rollup-eligible set {test, compile}.
- **Endpoints:** POST /api/v2/gates + /api/v2/milestones — projectKey in body
  (runs convention), 201 response (plans convention), GATE_OUTCOMES /
  MILESTONE_TYPES enum sets (TIERS precedent), verbatim payload, flat
  top-level dispatch (not under /projects/). SSE is generic (insertEvent
  emits).
- **UI (C2):** timelineRows is already a generic row union — add gate-card /
  merge-marker / milestone-entry kinds; runFeed renderers + testids. The
  home-vs-workspace surface branch is NET-NEW (both surfaces share one
  unscoped feed today) — thread a `surface` arg through timelineRows/runFeed
  so milestones render workspace-only and gates+merges render compact on
  home. Gate drill-in reuses the CompileBody single-form (no density switch).
- **Gate pane (C3):** the F13 `data-testid="gate-pane"` placeholder already
  exists ("gate reporting lands in CR-013") — replace it. Wave `gated` state:
  pass gate events into workflowLens; branch on a passed/checks-passed gate
  matching the wave.
- **§S5 TOON — RESOLVED (user rulings 2026-07-18):** `no-mistakes axi status`
  emits token-efficient TOON with NO JSON mode (verified — installed at
  ~/.local/bin/no-mistakes). A real captured sample
  (tests/fixtures/no-mistakes-axi-status.toon) confirms it is exactly the
  4-construct subset src/toon.ts encodes. User directed: "Use the Typescript
  variant and write a decoder/encoder for Python we have use for it." →
  **C4 ports the MIT `@toon-format/toon` TS reference into a reusable Python
  module `clients/toon.py` (encode + decode)** — pinned against @toon-format's
  own test vectors (pull via opensrc) + the real no-mistakes sample +
  round-trip against src/toon.ts toToon output. gate-report (C5) consumes it;
  the flag fallback (--outcome/--steps/--commit) remains. The Python module is
  fleet-shared (syncs to ~/.claude via CR-009), useful for any client
  reading/writing TOON.
- **cr-merged sender (C5):** wire the cr-merged milestone POST into the
  `cr-close` verb (CR-008) after a successful close — plan + commit already in
  scope; joins plans.cr (commitBoundary key).
- **Cycle plan (M→ grew to 7 with the TOON lib cycle):** C1 server foundation
  + endpoints · C2 timeline UI + scoping + drill-in · C3 gate pane + wave
  gated · C4 Python TOON module (clients/toon.py) · C5 fleet verbs
  (gate-report/milestone) + cr-close cr-merged hook · C6 E2E round-trip ·
  C7 verify sweep.
