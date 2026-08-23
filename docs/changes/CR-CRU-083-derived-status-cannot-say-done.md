# CR-CRU-083 — derived status conflates "never started" with "done before tracking existed"

- **Type**: bugfix
- **Wave**: 5
- **Depends on**: 014, 081
- **Status**: PENDING

## Problem

The roadmap derives a CR's status from plan records — `PENDING` (no plan filed), `IN_PROGRESS`
(open plan), `COMPLETED` (closed plan + merge). Deriving rather than reporting is the right
instinct: no extra input to keep in sync.

But `PENDING` carries two incompatible meanings, and the view cannot tell them apart:

1. this CR has not been started;
2. this CR **is finished**, but was executed before plan tracking existed, so no plan row exists.

On the live board that produced a visibly wrong roadmap: **`CR-CRU-001`–`007` and `010` all
rendered `PENDING`** while in reality they are long finished — the earliest work, done before the
plan mechanism was in place. Eight CRs of shipped work presented as not-yet-started, which is what
the user identified when calling the loaded roadmap fundamentally wrong.

It is self-contradictory, not merely untidy: those CRs are in `0.1.0`'s `crs`, so the same board
asserts both "never started" and "a release bundled and shipped it to users". Every consumer of
derived status — graph node styling, table badges, region counts — inherits the contradiction.

And it is **not** fixable by reloading. The queue stores no status by design, so clearing and
re-registering the same rows reproduces the same wrong answer.

## Gap analysis (2026-08-23, pre-RED) — READY (after the §AC correction below)

Run per the `gap-analysis` skill, all six dimensions, measured against the live store.

- **D3 — the ACs contradicted each other and the store.** As filed, AC1b and AC2 shared one
  predicate (no plan, no release membership) and demanded opposite answers (`unknown` vs
  `PENDING`); no derivation can satisfy both. AC1b's premise was also false: `0.1.0`'s `crs`
  carries **58** ids and **includes all nine** pre-tracking CRs, because `--repair-provenance`
  (CR-081 §S3) has never run against this store. **Settled by the user 2026-08-23: AC2.**
  `PENDING` means *Crucible holds no evidence*, AC1b is removed, and the post-repair consequence
  is accepted and recorded under Risk.
- **D2 — the derivation, read verbatim, is plan-only.** `Store.deriveQueueStatus`
  (`src/store.ts:3052`) reads `listPlans` alone: zero plans → `PENDING`. Release membership is
  never consulted, which is exactly why the nine render `PENDING` once the queue is registered.
  `crs` is already on the release record (`src/types.ts:217`, `crs?: string[]`) and served by
  `listReleases` (`src/store.ts:2111`), so §S1 consumes a mechanism that exists.
- **D2 — the defect is currently unobservable and the fix needs a registered queue.**
  `queue_entries` is **empty** in the live store, so the Roadmap paints `roadmap-empty` rather
  than wrong badges. Registering the queue is a precondition of the dog-food check and of AC6.
- **D4 — one further evidence source exists and is deliberately not consumed.** `cr-merged`
  milestones are a per-CR landing record (`{type:"cr-merged",label,commit}`, 8 for this project)
  already read by `scripts/release.sh:590`. Measured as a distinguishing class it is **empty** —
  every CR carrying one also has a plan — so consulting it would add a branch with no observable
  effect (Non-goals).
- **D6 — consumers of the status union enumerated.** `QueueStatus` (`src/types.ts:310`) is read
  by `deriveQueueStatus`/`listQueue` (`src/store.ts:3038-3070`), the roadmap badge
  (`public/app.js:2405`, class from `status.toLowerCase()`), the row click rule (`:2385`), the
  Cytoscape node styles (`:2534-2544`), the graph builder's `data.status`
  (`public/app-logic.mjs:808`), and the tests `queue-registration`, `roadmap-pane`,
  `roadmap-graph` plus `tests/e2e/features/roadmap.feature`. A fourth value that is not styled
  and asserted in each of those is a silent fall-through — AC7 exists for that.
- **D1 / D5 — no PRD conflict, nothing retired.** `DN-crucible-wave-track-release.md` makes `crs`
  the authoritative expression of release membership, and `DN-crucible-roadmap-view.md`'s row
  grammar carries a status; neither mandates the vocabulary. No symbol is removed — the union
  gains a member.

## Scope

### §S1 A shipped CR is never `PENDING`

Per `docs/research/DN-crucible-wave-track-release.md`, a release is a specific activity set that
always ships a package to users, and `crs` (CR-080) records the CRs it bundled. Membership is
therefore authoritative evidence of completion: derived status consults it alongside plan records,
and a CR with no plan but with a release can no longer render `PENDING`.

### §S2 Name the third state honestly

A CR finished without plan tracking is not the same as one tracked from RED through merge. It must
not borrow the fully-tracked `COMPLETED` presentation as though its cycles had been observed — that
claims evidence the store does not hold.

The state is named **`COMPLETED_UNTRACKED`** on the wire and reads **`completed · tracking absent`**
in the badge. It is named here, not left to the RED phase, because both are contract surface: a
public value of `GET …/queue` and a rendered string. Like `PENDING` the row is click-inert — there
is no plan to land on in the Workflow view. Same discipline as the omitted release-date row and the
empty `crs`: state the truth rather than fabricate the richer answer.

### §S3 Absent tracking is a first-class answer

Neither state is an error. A pre-tracking CR is legitimate history and renders without warnings or
empty states, and **no** synthetic plan or cycle rows are created to make the derivation look tidy.

## Acceptance criteria

- **AC1** — a CR present in some release's `crs` with **no** plan record derives
  `COMPLETED_UNTRACKED`, never `PENDING`. Measured example: `CR-CRU-001`–`007`, `010`, `016` — nine
  plan-less CRs that `0.1.0`'s `crs` (58 ids) carries today.
- **AC2** — a CR with **no plan and no release membership** derives `PENDING`. This is the settled
  resolution of the two-meaning problem: `PENDING` carries exactly one meaning — *Crucible holds no
  evidence for this CR* — so the genuinely unstarted case is unchanged. Measured class:
  `CR-CRU-015`, `018`, `022`, `075`, `077`, `078`, `079`, `082`, `083`, `084`, `085`.
- **AC3** — a CR completed with full plan tracking is distinguishable from one completed without it:
  `COMPLETED` and `COMPLETED_UNTRACKED` are distinct wire values with distinct badges; the two never
  collapse into one.
- **AC4** — existing derivations are untouched where plans exist: open plan → `IN_PROGRESS`, closed
  plan + merge → `COMPLETED`. A plan record always outranks release membership.
- **AC5** — no synthetic plan or cycle row is created to satisfy any of the above.
- **AC6** — re-registering the queue changes no derived status (status is not queue data), so the
  fix survives a full replace.
- **AC7** — every consumer of derived status handles the new value explicitly — the table badge, the
  row's click behaviour (inert), and the graph node's style — so none falls through to a default
  that renders it as `PENDING` or `COMPLETED`.
- **AC8** — tracking records attach **after** the CR exists, and derived status follows them with no
  queue re-registration: a `PENDING` CR that gains a plan reads `IN_PROGRESS`, then `COMPLETED` when
  that plan closes with a merge; a `PENDING` CR that gains release membership reads
  `COMPLETED_UNTRACKED`. Status is a live derivation over the records that exist at read time.
- **AC9** — the editable window **closes at implementation**. Once a CR is implemented — a plan
  closed with a merge (`COMPLETED`), or membership in a shipped release (`COMPLETED_UNTRACKED`) —
  its tracking records are settled fact and no derivation, repair or re-registration may rewrite or
  drop them (`DN-crucible-wave-track-release.md`: *a shipped CR's release membership is settled
  fact*). Asserted as a derivation invariant: the two implemented states never move backwards to
  `PENDING`.

## Estimated size

S — one derivation reading one additional source, plus the presentation split.

## Risk

Derived status is consumed in several places, so this visibly moves numbers on the board. That is
the intent — the current numbers are wrong — but expect the shift rather than reading it as a
regression.

**Bounded editability (user direction, 2026-08-23).** A plan and a release are both attachable
*after* a CR is created — `plan-file` files a plan for any registered CR, and
`milestone --type release --repair-provenance --crs …` amends a recorded release's membership
without touching its version, commit or row (CR-081 §S3, guarded by CR-086 §S1/§S2). **But once a
CR is implemented it cannot be edited**, which is AC9 and is already the governing DN's rule.

That exposes a hazard this CR does **not** own: CR-086 §S3 still permits the 58→51 shrink, and those
nine CRs are *shipped*, so dropping their membership edits settled fact and would read them back as
`PENDING`. Under AC9 that shrink is a defect in the repair, not a state this derivation should model
— recorded in the deferred register for the next SCRUM rather than absorbed here. `crs` is correct
today (measured: 58 ids including all nine), so CR-083 lands on sound evidence, and persisting
CR-081's unplaceable tally stays declined.

## Non-goals

- Back-filling plan records for historical CRs — explicitly refused (§S3, AC5).
- Changing what the queue stores; status stays derived, never registered.
- Roadmap ordering and grouping — CR-078.
- Provenance completeness — CR-081.
- Consuming `cr-merged` milestones as a completion source — measured empty as a distinguishing
  class (every CR carrying one already has a plan), so it would add a branch with no effect.
- Persisting CR-081's unplaceable tally — declined above; see Risk.
