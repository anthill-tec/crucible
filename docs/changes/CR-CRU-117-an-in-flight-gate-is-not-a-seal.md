# CR-CRU-117 — an in-flight gate is not a seal

- **Type**: bugfix
- **Wave**: 6 (0.2.0)
- **Depends on**: 013, 115
- **Status**: PENDING (0.2.0) — declared into 0.2.0 wave 6 by user ruling, 2026-09-10
- **Design reference**: `docs/research/DN-crucible-wave-track-release.md` — the drift section's **D3**
  (the release's in-flight state already has a carrier: the gate). This CR is the half of that
  carrier the reader has to be able to tell apart from a verdict.

## Context

Split out of CR-CRU-115 §S2 at that CR's gap analysis (2026-09-10), because the fix it named cannot
be made in the client alone and, made as specified, would corrupt the roadmap.

**The fault, unchanged and still measured.** `cmd_gate_run` guards its streaming POST with
`if in_flight and 0 < nsteps < 9`, where `nsteps` is the row count of the decoded snapshot. The
intent was "a partial ladder, not a full snapshot masquerading as interim". But the real tool always
emits **nine** rows — verified on this machine 2026-09-10, `no-mistakes axi status` returning
`steps[9]` with unrun steps carrying `pending` — so the guard is `False` for every real snapshot and
**no interim gate has ever been posted by any client**. A 45-minute pipeline sent the board nothing.

**Why it is not a one-line guard fix.** Two measurements taken during CR-CRU-115's gap analysis:

1. `gate_from_axi(decoded, intent, final=False)` synthesises the interim outcome `checks-passed`.
2. `workflowLens` in `public/app-logic.mjs` flips a wave to `gated` when a gate event's outcome is
   `passed` **or** `checks-passed`, building a Set that nothing ever removes from.

So simply repairing the guard would mark a wave `gated` about two seconds into every run, from a
snapshot in which most steps are still `pending` — and a run that then FAILED could not undo it,
because a `failed` gate is not subtractive. The board would report a seal that never happened.

**And there is no legal value that means "in progress".** The accepted vocabulary is
`checks-passed, passed, failed, cancelled` (`src/v2.ts`); the two non-gating members both read as
verdicts of their own. The interim/seal distinction therefore has to exist somewhere a reader can
see, which is what this CR decides.

**Surfaces:** `cmd_gate_run`, `gate_from_axi`, `map_axi_step_status`, `_GATE_POLL_CADENCE_S` in
`clients/_crucible_axi.py`; `workflowLens`'s `gatedWaveLabels` derivation in `public/app-logic.mjs`;
the gate event's stored shape in `src/store.ts` and `POST /api/v2/gates` in `src/v2.ts` if the
distinction is carried server-side.

## Scope

### §S1 An in-flight gate is distinguishable from a seal

A gate posted while its run is still going is marked as such, and every reader that treats a gate as
a verdict — starting with `workflowLens`'s wave gating — ignores it. The mark is **explicit data on
the event**, never inferred from a heuristic like "has no `push.commit`" or "fewer than nine steps",
because both of those are properties this defect already proved unreliable.

Whether the mark rides the gate object, a top-level field beside `version`, or an outcome-vocabulary
member is the decision this CR makes; the design note is where it gets settled before any RED.

### §S2 The interim POST's guard tests terminality, not row count

A snapshot is non-terminal when it carries no resolved `outcome` and at least one step is still
`pending`, `running`, `fixing` or awaiting a decision. Under the existing cadence a run that takes
minutes posts interim gates throughout it, and the nine-row shape `axi status` always emits is no
longer read as "already resolved".

### §S3 The fixtures drive the real shape

The four per-client axi suites and bun's gates suite drive progressive snapshots of 3, 6 and 8 rows —
a shape the tool never produces, and the reason the guard's defect survived to a release. The
criteria here are driven from snapshots captured verbatim from a real run, so a fixture cannot agree
with the defect again.

## Acceptance criteria

**§S1 — an in-flight gate is not a verdict**

- [ ] A gate posted from a non-terminal snapshot carries an explicit in-flight mark, asserted on the
      POST body by key, not inferred from step count or the absence of `push`.
- [ ] `workflowLens` does not add a wave to `gatedWaveLabels` for an in-flight gate: asserted with a
      board holding exactly one in-flight gate on a wave, whose label must be absent from the gated
      set.
- [ ] A wave gated by a real seal is still gated — the narrowing changes no true positive.
- [ ] An in-flight gate followed by a `failed` seal leaves the wave un-gated: the sequence that would
      have produced a permanent false gate is asserted end to end.
- [ ] An in-flight gate carries **no** `version` — asserted by key absence on the interim POST body,
      with the same run's SEAL carrying it. Ruled 2026-09-10 at CR-CRU-115 cycle 403: a version-stamped
      gate is retention-protected (`LIVE_GATE`, `src/store.ts`), so stamping every interim snapshot
      would leave a run's worth of unprunable gates behind for one release, and the seal restates the
      release anyway. This criterion lives here because the interim POST is unreachable until this CR
      repairs the guard.

**§S2 — streaming**

- [ ] Given a snapshot with `steps[9]` where `review` is `running`, six steps are `pending` and there
      is no `outcome` key — the exact shape captured from a live run — `cmd_gate_run` posts an
      **interim** gate. Today's guard posts none; this is the reversal.
- [ ] Given a snapshot with `steps[9]` all `completed` and a resolved `outcome`, no interim gate is
      posted for it.
- [ ] The interim gate's `steps[]` carries all nine names with their mapped statuses, so `pending` is
      represented rather than dropped.
- [ ] Interim posts still obey the existing cadence: two snapshots within one cadence window produce
      one POST, asserted by counting POSTs.
- [ ] `gate-run`'s envelope reports `postedGate: interim` when the poll loop posted an in-flight gate
      and did not seal — asserted on the same nine-row-with-`pending` fixture the guard reversal uses.
      Added 2026-09-10 from CR-CRU-115 cycle 405's VERIFY, which found the handoff had not landed: 115
      narrowed the value out on the promise that this CR inherited it, and this CR's criteria did not
      mention the envelope at all. 115 now asserts the SHORT-snapshot path itself; this criterion
      covers the nine-row path the guard repair opens.
- [ ] **The HUMAN channel says it too.** On the interim-then-hold path the stderr/legacy report tells
      the caller an in-flight gate is already on the board. Today it says `NOT SEALED`, names the run's
      own error and the reattach move — all true, and all leaving the impression the board is silent,
      because only the machine-readable `postedGate` corrects it. Raised by CR-CRU-115 cycle 406's FIX
      and deliberately not fixed there: no finding authorised changing the hold's caller-facing text,
      and this CR rewrites that path anyway.
- [ ] The envelope's `outcome` field is unambiguous on that path. It currently reads `none` (its ruled
      contract is the SEALING outcome, and nothing was sealed) while a gate sits on the board — not
      false, but a reader who takes `none` to mean "nothing about this run reached the board" is relying
      on a second field to correct them. Same finding, same source.

**§S3 — fixtures**

- [ ] At least one fixture per driven client is the real nine-row-with-`pending` shape, and the
      progressive 3/6/8-row fixtures no longer stand alone as the only in-flight shape any test sees.
- [ ] Every captured fixture NAMES the tool version it was captured from. The nine-row shape in
      CR-CRU-115's suites came from `no-mistakes` **v1.70.1** (2026-09-10; v1.72.0 was already
      published). Recorded because the coupling is now load-bearing in two files and this CR adds
      more: if the tool gains or loses a pipeline step, a nine-row assertion goes red for a
      tool-version reason with no defect behind it, and a reader needs to know which is which.

## Estimated size

Two cycles: the distinction (client + reader, and server if the mark is stored) and the streaming
guard with its fixtures.

## Risk

- **This CR changes a reader**, so a mistake here mislabels waves rather than losing a gate. The
  §S1 criteria assert both directions — a true seal still gates, an in-flight gate never does.
- The in-flight mark is new data on an existing event kind. Old gate events carry no mark and must
  keep reading exactly as they do today (they are seals, correctly).
- Turning the stream on multiplies gate events per run. Retention interacts with CR-CRU-073's live-gate
  rule, which exempts a gate carrying `version` from pruning: an in-flight gate must not become
  permanently retained by carrying a release stamp it will restate at the seal.
- **`cmd_gate_run`'s cognitive complexity is 53** (measured 2026-09-10, up from 34 when CR-CRU-115
  added the hold branch). The extraction belongs HERE, not there: every candidate helper boundary
  falls inside the poll loop this CR rewrites, so splitting it under CR-CRU-115 would have churned
  code this CR then re-shapes. Whoever implements §S2 owns the decomposition.

## Non-goals

- No change to the poll cadence, to `no-mistakes` itself, or to which pipeline steps a project skips.
- No retroactive relabelling of gates already on any board.
- Not the outcome-vocabulary question: whether `passed-with-skips` becomes a first-class outcome is a
  separate candidate CR, recorded in the queue notes.

## Gap analysis — 2026-09-10 (orchestrator-run, findings RECORDED not applied)

Verdict **SPEC_UPDATE_NEEDED**. Nine findings; **no acceptance criterion below has been changed**,
because two of them are design decisions this spec already defers to the design note and both were
still awaiting the user's ruling when the run ended. Recorded verbatim so the next run resumes from
measurement rather than re-deriving it. Baseline was NOT completed: `tsc --noEmit` exit 0, the bun
suite was aborted mid-run by an emergency shutdown, so **no pass/fail count exists for this CR yet
and the branch must not be cut until one is measured.**

| # | Dim | Finding | Fix | Blocking |
|---|---|---|---|---|
| 1 | 7+3 | Streaming at the unchanged 2s cadence ⇒ ~1350 gate events per 45-min run; Non-goals forbid touching the cadence | ruling | yes |
| 2 | 3 | A SECOND reader treats a gate as a verdict; no AC names it | SPEC_UPDATE | yes |
| 3 | 2 | §S1's AC2 is vacuously satisfiable today — it passes with no code change | SPEC_UPDATE | yes |
| 4 | 2 | §S3's nine-row AC is already satisfied by an existing fixture | SPEC_UPDATE | yes |
| 5 | 4 | CR-CRU-017's run lifecycle already models "still going" — reinvention unevaluated | ruling | no |
| 6 | 2 | §S1's three candidate shapes are presented as equal-cost; they are not | SPEC_UPDATE | no |
| 7 | 3 | CR-CRU-115's green bias survives one function above the one it fixed | SPEC_UPDATE | no |
| 8 | 5 | The DN's false-green gate is rendering on the live board right now | ruling | no |
| 9 | 2 | Six stale `path:line` citations in the DN's D3 | docs | no |

**DRIFT-1 — the volume this CR never computes.** `_GATE_POLL_CADENCE_S = 2.0`, the spec's own
evidence is a 45-minute pipeline, and Non-goals say "No change to the poll cadence": 45×60/2 =
**~1350 interim POSTs per run**, each a nine-step ladder, against **1842 events total** on the board
(measured 2026-09-10). Every one also becomes a `GateCardRow` in the timeline feed. Recommendation
put to the user, unanswered: **post on ladder CHANGE, not on cadence** — the ladder transitions at
most nine times, so ≤9 posts carry the same information and the cadence Non-goal survives verbatim
(the 2s poll is untouched; only the POST predicate changes).

**DRIFT-2 — the reader no AC names.** §S1's prose says "every reader that treats a gate as a verdict
— starting with `workflowLens`'s wave gating", and only that one reaches an AC. The second is
`boundaryGate` in `public/app.js`: it reduces the scoped gates to **max timestamp with no outcome
filter**, and `WorkflowPrimary` mounts that event's outcome banner and step ladder as the Workflow
tab's primary zone. An interim gate is by construction the newest, so streaming puts a mid-run
ladder on that surface. Fix: name BOTH readers in ACs (the multi-implementation rule — make the
reader count itself the assertion).

**DRIFT-3 — AC2 passes today, unchanged.** `context.wave` is set ONLY from `$WORKFLOW_WAVE` by
`fleet_context`, and `resolveIngestAttach` stamps **`cycleId` only** — the server never adds a wave.
`$WORKFLOW_WAVE` occurs nowhere outside tests, is unset in the orchestrator's own shell, and the
live board's single gate carries no wave. So "an in-flight gate's label is absent from
`gatedWaveLabels`" is true for the WRONG reason. Fix: the fixture must carry `context.wave`, plus
the anti-vacuity twin — the same gate WITHOUT the in-flight mark must appear in the gated set, so
the exclusion is attributable to the mark.

**DRIFT-4 — the nine-row fixture already exists.** All four per-client axi suites drive
`steps[1,3,6,8,9]`; the nine-row one is `_INTERIM_SNAPSHOT_FINAL`, `status: completed` — a SEALING
snapshot. Fix: the AC must demand nine rows driven as NON-TERMINAL (`status: running`, no `outcome`,
≥1 `pending`). Note also `_FINAL_SNAPSHOT` is `steps[1]`: the fixture fiction runs both ways.

**DRIFT-5/6 — the shape decision, costed.** `recordGateEvent(gate: unknown)` stores the gate object
VERBATIM and `handleGates` validates only `intent`, `outcome` and steps-is-an-array. So: a field
inside `gate` costs **no server change** and touches 2 readers; a top-level field beside `version`
costs a v2.ts carry plus a store field; a new `outcome` member costs both `GATE_OUTCOMES` sets,
every enumerating reader and five clients' fixtures. Separately, CR-CRU-017's run lifecycle already
means "unsettled" (`visibleOpenRuns` → `RunningCard`), but `resolveRunClose` closes on ANY ingest
carrying a `runId`, so a stream would need carry-without-close on a seam three routes share.
Recommendation: the in-gate field, with the lifecycle evaluation RECORDED — the DN's own rule is
that a second mechanism for an already-assigned job is a defect, so declining it needs a reason on
paper.

**DRIFT-7 — the same green bias, one function up.** `map_axi_step_status` ends
`.get(status, status or "passed")`: an unknown or empty step status becomes **`passed`**. CR-CRU-115
killed this exact bias in `sealed_outcome`, immediately below it. §S2 covers `pending` and says
nothing about unrecognised or absent.

**DRIFT-8 — a live artifact with no owner.** `evt-1788925414091-197` is the false green D3 cites:
`outcome: passed`, `steps: []`, no `version`, no `context.wave`. With 105 plans and **0 open**,
`boundaryGate` returns it, so the Workflow tab renders it as the release boundary gate. This CR's
Non-goals correctly refuse retroactive relabelling, which leaves it ownerless — a data action, not
code. Awaiting the user's ruling: retire the event, or leave it and let §S1's work make it harmless.

**DRIFT-9 + inverse blast radius.** D3 cites `_crucible_axi.py:4801`, `:1315`, `:1306-1310`,
`:4811-4819`, `:4647` and `src/store.ts:2013-2016`; after CR-CRU-115 the real loci are
`cmd_gate_run`'s guard, `map_axi_step_status`, `sealed_outcome`, `post_gate` and `LIVE_GATE` — six
stale citations, to be re-recorded as SYMBOLS. And this CR's own edits to `clients/`, `public/` and
possibly `src/` will move the `PROSE_CITATIONS` heads (clients 789, public 436, src 573), so the
tripwire suite plus the python line-number guard need ONE re-record planned as a close-out step,
not per-cycle escalations.

**Size:** the spec estimates two cycles; with the second reader, the mapper bias and the fixture
rework this reads as **three**.
