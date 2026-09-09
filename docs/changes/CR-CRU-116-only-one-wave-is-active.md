# CR-CRU-116 — only one wave is active, and Crucible refuses the alternative

- **Type**: feature
- **Wave**: 6 (0.2.0)
- **Depends on**: 091, 104
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-crucible-wave-track-release.md` — "The definition (final)"
  (a wave is a container of CRs and a synchronisation device for orchestrators) and the drift
  section's **D1**

## Context

**USER REQUIREMENT 2026-09-09: there can be only one active wave at any time, and that is a
constraint Crucible PLACES — not a convention orchestrators are trusted to keep.** Today nothing
refuses a second one. A plan may be opened for a CR in any wave, in any order, so two waves can hold
open work simultaneously and a later wave can be opened while an earlier one still has unfinished
CRs. The roadmap then has two boxes with equal claim to the `· active` marker, and `next`'s lane has
no single container to answer for.

The rule already exists **one container down**, and its two halves are exactly the two this CR
lifts. `Store.transitionCycle` refuses a second active sibling with `code: "already-active"`
(`src/store.ts:3241-3249`) and refuses activating ahead of a seq-earlier pending sibling with
`code: "out-of-order"` (`:3255-3263`), keyed on `seq` rather than id precisely so an insert-before
cannot smuggle an inversion past it. A wave is the same kind of object one level up: an ordered
container whose members must not run concurrently with a sibling container's.

**Surfaces (verified 2026-09-09):** `transitionCycle`'s two refusals and the `CycleTransitionError`
union (`src/store.ts:589-596`) which already names both codes; `listQueue` / `QueueEntry.wave` and
`deriveQueueStatus`; the plans POST (`handlePlans` in `src/v2.ts`) which is where a plan is opened
and which today asks nothing about waves; `hints.ts:183`'s existing ascending-order help line.

## Scope

### §S1 A wave is active when it holds open work, and only one may

A wave is **active** while it holds a CR the queue derives as `IN_PROGRESS`. That is ONE source, not
two: `deriveQueueStatus` (`src/store.ts:4098-4111`) already answers "is this CR in flight?" as
`plans.find((plan) => plan.status === "open")`, so "an open plan" and "an `IN_PROGRESS` CR" are the
same fact read twice. The guard consumes the existing derivation rather than restating it.

**`aborted` is not `open`.** Measured on this board 2026-09-09: 102 plans, `closed: 96`,
`aborted: 6`, **`open: 0`**. The six aborted plans sit on completed CRs in waves 4 and 5, and an
activeness rule keyed on "a plan exists that is not closed" would mark both of those waves active
forever. `plan.status` has three values and only `open` confers activeness.

**The guard reads the QUEUE's wave, never `plan.wave`.** A plan carries a `wave` its caller supplied,
and the two can disagree: plan `95` carries `wave: 6` while the queue declares `CR-CRU-092` in wave
**5** (measured 2026-09-09). Queue membership is the declared fact `cr-plan`/`wave-sequence` author;
`plan.wave` is a snapshot, so one mislabelled `plan-file` must not be able to poison the constraint.

Activeness stays DERIVED — no wave record, no state to set, no verb to forget — exactly as wave
completion does (ruled 2026-09-09). What this CR adds is the refusal that keeps the derivation
single-valued.

Opening a plan for a CR whose wave is not the active wave is **refused** while another wave is
active, with `code: "already-active"` naming the wave that holds the open work. The existing
per-plan single-active rule is untouched; this is its sibling one container up.

**Precedence when both conditions hold: `already-active` wins.** A single write can trip both rules
(the active wave is itself unfinished, and an earlier wave still has a pending CR).
`transitionCycle` checks `already-active` before `out-of-order` (`src/store.ts:3238-3264`) and the
wave scope mirrors that order rather than choosing its own.

**A CR with no declared wave is outside this constraint entirely.** An entry whose `wave` is empty,
and a CR the queue does not hold at all, are never blocked, never blocking, and never confer
activeness on any wave. Membership is declared; a guard that refused an undeclared CR would be
inventing the membership this project requires to be authored.

### §S2 Waves open in order

Opening a plan for a CR in wave W is **refused** while an earlier wave still holds an unfinished CR,
with `code: "out-of-order"` naming that wave and the CR that blocks it. Unfinished carries the
meaning the DN fixes and this project already uses: neither landed nor declared dead, so a wave whose
remainder is `VOID`/`SUPERSEDED` does not block its successor.

Wave order is `waveNumber(wave)` (`src/store.ts:450`) — the ONE ordering function the store already
publishes, which `waveSeqBase` and the queue's own sort key both rest on, so a wave's seq block and
its position cannot disagree about which lane it is. No second ordering rule is written, and no
order is re-derived from a `seq` VALUE (CR-CRU-095 AC6).

A digit-free label therefore numbers **0**, exactly as its seq block already does — `waveSeqBase`'s
own comment states "a wave without an integer takes block 0". An **empty** `wave` is the wire's way
of declaring none and is excluded by §S1 rather than ordered as wave 0.

### §S3 The refusal names the move that clears it

Each refusal carries `help[]` stating what would make the write legal: for `already-active`, closing
or aborting the open plan in the active wave; for `out-of-order`, the blocking CR and that it must
land or be declared dead. A refusal that only says no is a refusal the caller cannot act on.

**The status is `400`, stated as a number.** `handlePlanFile`'s only existing refusal is
`fail(400, plan.error, { help: hints.duplicateOpenPlan })`, and that IS "the plans route's existing
refusal shape". `409` is also 400-class and is NOT what this route answers.

### §S4 One wave carries the marker — and today the renderer gives it to all of them

The roadmap's `· active` marker is currently a **release-level** flag copied into every wave box
(`public/app-logic.mjs`): `const active = kind === "proposed"`, then each box is built as
`{ wave, active, … }`. Its own comment states that the `false` branch is "UNREACHABLE by
construction" — true while a release held one wave, false the moment it holds two. With 0.2.0
proposed and holding waves 5 and 6, **both boxes render `· active`**, which is the invariant violated
on screen rather than in data.

Activeness becomes a per-WAVE fact from the same derivation §S1 uses: the box whose wave holds an
`IN_PROGRESS` CR carries the marker, and no other box does. A release with no work in flight carries
no marker at all — the `false` branch stops being unreachable, so it is now a state to assert rather
than a comment to trust.

**This SUPERSEDES CR-CRU-096 AC1's release-level reading**, and its sibling suite says so out loud:
`tests/roadmap-wave-header.test.ts:482-483` asserts "a CR that is actually running is not what makes
the wave active: with one `IN_PROGRESS` in wave 1, wave 2 — which has none — is still active", with
the same premise at `:443-444`, `:498-499`, `:520-521`, and single-wave assumptions at `:571`,
`:599`. That was correct while `active` was a release fact. It is the rule the user's
single-active-wave requirement retires.

Those assertions are **rewritten to the new contract, or deleted where their only subject was the
superseded rule** — never re-pinned to whatever the implementation happens to produce. `:482-483` is
a deletion: its subject IS the retired rule, and the replacement behaviour is asserted in this CR's
own suite rather than by inverting a test whose point has gone.

**The retired premise reaches four suites, measured 2026-09-09.** Every case is the same sentence —
a wave holding nothing `IN_PROGRESS` is expected to be active — and each is treated by whether its
subject survives:

| suite | sites | subject | treatment |
|---|---|---|---|
| `roadmap-wave-header` | `:443`, `:482`, `:498`, `:520`, `:571`, `:599` | the header's marker itself | `:482-483` DELETED; the rest rewritten |
| `roadmap-track-lanes` (CR-CRU-085 AC8) | `:1034`, `:1041`, `:1049`, `:1058` | the track-count segment | ` · active` dropped from the expectations; the fixtures stay runner-less, because a track-count test is not about a marker |
| `queue-registration` (CR-CRU-099 AC2) | `:1325` | membership (`view.members`, `box.entries`, `box.rows`) | the one `active` line DELETED, not re-asserted as `false` — a membership test carrying a marker assertion is how this drift spread |
| `roadmap-visual-grammar` | `:3416`, AC25, the ember-word read | the marker's colour and wording | a NEW `/fixture-active` board carries a runner; both directions asserted (active box ember + ` · active`, sibling box neutral `--line`, no marker) — assertable for the first time |
| `roadmap-visual-grammar` | `:3454` | motion is reserved for `IN_PROGRESS` | keeps the runner-less `fixture-height` board unchanged; only its premise is reworded off "an active wave with NO running CR", which states the retired rule in the test's own name |
| `roadmap-visual-grammar` | AC27's two `/· active$/` lines | the retired marker inside a geometry comparison | DELETED with a dated §S4 note. Measured impossibility, not a preference: CR-CRU-096 AC11a makes a runner ADDITIVE (`scheduled = actionable.slice(0,5)`, then every `IN_PROGRESS` is appended), so a marked live board draws SIX rows against AC27's `rowCount === 5`. No fixture satisfies both. Every other comparison in that test survives untouched |

The design artifacts are **not edited**: they are tracked test fixtures and the approved design. Where
a comparison against an artifact panel fails, the live board is driven into the state the panel
depicts — the artifact is not adjusted to match the code.

**One panel can no longer be reached, and that is recorded rather than fixed here.** The artifact's
first wave-box panel (`.lavish/crucible-workflow-flowchart.html:175-184`) draws a marked wave with
five `cr pend` rows and no runner — the state this CR abolishes. It is not wrong about geometry, only
about the marker, and refreshing an approved design surface is the USER's decision. This CR leaves it
untouched and flags it; nothing here depends on it changing.

## Acceptance criteria

**§S1 — single active wave**

- [ ] With an open plan for a CR in wave 6, a plans POST for a CR in wave 7 is refused with
      `ok: false` and `code: "already-active"`, and the error names wave **6** and the CR whose plan is
      open.
- [ ] An **aborted** plan confers no activeness: with wave 4 holding an aborted plan and nothing
      open, a plans POST for a wave-6 CR succeeds. Asserted against the live shape — 6 aborted plans
      across waves 4 and 5, 0 open (measured 2026-09-09).
- [ ] The guard reads the wave from the QUEUE entry, not from the plan: a plan whose `wave` disagrees
      with its CR's queue entry (plan `95` says 6, the queue says 5) does not change which wave is
      active. Asserted with a fixture carrying exactly that disagreement.
- [ ] Activeness is computed from the same derivation the queue publishes — a census asserts the
      guard has no second in-flight rule of its own beside `deriveQueueStatus`.
- [ ] Both conditions at once (the active wave is unfinished AND an earlier wave holds a pending CR)
      answers `already-active`, not `out-of-order` — the same precedence `transitionCycle` uses.
- [ ] A plans POST for a CR the queue does not hold **succeeds** and changes no wave's activeness,
      asserted with the wave constraint otherwise armed (another wave active).
- [ ] A plans POST for a CR whose `wave` is empty **succeeds** while a numbered wave is active, and
      that CR's open plan does not then make any wave active — asserted both ways.
- [ ] A digit-free non-empty wave label orders as wave **0** via `waveNumber`, and the guard writes no
      ordering rule of its own — asserted by driving a `wave: "alpha"` entry against a numbered wave.
- [ ] With an open plan for a CR in wave 6, a plans POST for a **second CR in wave 6** SUCCEEDS —
      the constraint is one active WAVE, never one open plan.
- [ ] With no open plan and no `IN_PROGRESS` CR anywhere, a plans POST for a CR in the earliest
      unfinished wave succeeds.
- [ ] The refusal is the server's: asserted through `POST /api/v2/projects/<key>/plans`, not only
      through a store unit test.
- [ ] `CycleTransitionError`'s existing codes are reused verbatim — a census asserts the wave-scope
      refusals introduce **no new code strings** beyond `already-active` and `out-of-order`.

**§S2 — ascending waves**

- [ ] Wave 6 holding one `PENDING` CR, wave 7 holding one: a plans POST for the wave-7 CR is refused
      with `code: "out-of-order"`, naming wave 6 and its blocking CR.
- [ ] Wave 6 whose only unfinished entries are `VOID` and `SUPERSEDED`: a plans POST for a wave-7 CR
      **succeeds** — dead CRs do not block a successor wave.
- [ ] Wave 5 fully landed, wave 6 `PENDING`: a plans POST for a wave-6 CR succeeds. This is the live
      shape (wave 5's 46 entries are landed except `CR-CRU-113` and `CR-CRU-082`, both `VOID`,
      measured 2026-09-09).
- [ ] An entry whose `wave` is unset never blocks any wave and is never reported as one, asserted
      explicitly rather than left to coincidence.

**§S3 — actionable refusals**

- [ ] Both refusals carry a non-empty `help[]`; the `already-active` help names the plan-closing move
      and the `out-of-order` help names the blocking CR by id.
- [ ] Neither refusal is a 500, and both answer HTTP **`400`** exactly — not `409`, not any other
      400-class code — with `ok: false` and a non-empty error sentence, matching
      `handlePlanFile`'s existing `fail(400, …)` refusal.

**§S4 — one marker**

- [ ] Given a release holding two waves where one has open work, the roadmap's `· active` marker
      renders on exactly **one** wave box — asserted by counting marker nodes across both boxes, not
      by inspecting one. Today both carry it, because `active` is `kind === "proposed"`; this is a
      CODE FIX in `public/app-logic.mjs`, not an assertion over already-correct behaviour.
- [ ] Given a release holding two waves with no work in flight, **zero** markers render, and that is
      not an error — the branch the current comment calls "UNREACHABLE by construction".
- [ ] The header text is asserted whole for both boxes, so `Wave 5` reads without ` · active` while
      `Wave 6 · active` carries it, in the SAME render — the roadmap suite has no two-wave fixture
      today, so one is added.
- [ ] `data-active` on the non-active box is `"false"`, matching the attribute the renderer already
      publishes.
- [ ] `tests/roadmap-wave-header.test.ts` passes with its release-level activeness assertions
      REWRITTEN to the per-wave contract, and `:482-483` DELETED rather than inverted. A dated
      supersession comment names CR-CRU-116 §S4 and the CR-CRU-096 AC1 reading it retires.
- [ ] No assertion anywhere still reads activeness off `kind === "proposed"`: a check over `tests/`
      reports zero surviving sites, and the number of sites checked is itself asserted.
- [ ] All four affected suites pass with the treatments in the table above: `roadmap-wave-header`,
      `roadmap-track-lanes`, `queue-registration`, `roadmap-visual-grammar`. Every changed assertion's
      new expectation is derived from this spec, not from an observed run.
- [ ] `roadmap-visual-grammar` carries TWO fixtures where it carried one: an active-state fixture
      holding a runner (AC27's artifact comparison, the ember-word marker, AC25's greyscale read) and
      a runner-less one for "no motion without an `IN_PROGRESS` CR". No design artifact is edited.

**Integration**

- [ ] After this CR, the plans POST invokes the wave guard on the production path: a grep for the
      guard returns ≥1 non-test caller in `src/v2.ts`, and VERIFY runs that grep itself.
- [ ] An existing client flow proves it end to end: `plan-file` for a CR in a non-active wave returns
      the refusal through the client envelope, with the client's own non-zero exit.

## Estimated size

Two cycles — one for the refusals, one for the marker. `src/store.ts` (the wave guard beside
`transitionCycle`'s siblings), `src/v2.ts` (`handlePlanFile`, which `handlePlansRoute` dispatches at
`:2918-2928` and which today asks nothing about waves), `src/hints.ts` (the two help lines),
`public/app-logic.mjs` (§S4's per-wave `active`) and the `public/app.js` render site that reads
`box.active`; tests in `tests/` and `tests/client/`.

**Close-out step, planned once rather than escalated per cycle:** `PROSE_CITATIONS`
(`tests/project-namespace-tripwire.test.ts`) pins `src` head **563**, `public` head **435**,
`clients` head **785**. The head figure is re-recorded in the LAST prose-changing cycle, in the same
commit as that prose — cycle 394, since cycle 395 is read-only VERIFY.

Measured at that point: **both trees drift, as this step predicted.** `src` 563 → **573** and
`public` 435 → **436**; `clients` unchanged at 785. Per file:

| tree | file | citations | cycle |
|---|---|---|---|
| `src` | `store.ts` | 251 → 259 | 393 |
| `src` | `v2.ts` | 189 → 190 | 393 |
| `src` | `hints.ts` | 39 → 40 | 393 |
| `public` | `app-logic.mjs` | 85 → 86 | 394 |
| `public` | `app.js` | 225 → 225 | 394 |
| `public` | `app-logic.d.mts` | 53 → 53 | 394 |

The one moving `public` citation is where the retired `kind === "proposed"` comment cited one CR and
its replacement cites CR-CRU-116 §S4 **and** names the CR-CRU-096 AC1 reading it supersedes. Holding
the pin by dropping that second citation is REFUSED: the pin measures provenance, so provenance
growing is the pin working. Both figures are re-recorded in cycle 394's commit with this
decomposition, which is what makes a re-record auditable rather than a nudged constant.

Figures are the CLASSIFIER's (`extractCitableText`), never a raw whole-file grep — a raw count of
`store.ts` reads `257 → 265`, which has the same delta and is the wrong unit for a guard that
measures citable prose.

**Two guards live in files this CR never opened, and both went red.** `PROSE_CITATIONS`
(`tests/project-namespace-tripwire.test.ts`) counts citations per tree; `NextBlockCitationsTest`
(`tests/client/test_cr092_next_decision_resolver.py:1613`) asserts each `path:line` citation in the
client's `next` block still brackets the construct it names. Cycle 393 tripped both: it drifted the
`src` count, and extracting `deriveQueueStatus` moved it from `src/store.ts:4098` to `:4256`, which
staled the `LANDED_STATUSES` citation in `clients/_crucible_axi.py`.

So the blast-radius question has two halves, and this CR only asked the first: how many citations a
tree gains, AND which files pin LINE NUMBERS INTO the files being edited. A cycle that inserts into
`src/` is not done until both guards have been run — and one of them lives in the PYTHON suite, which
no bun-side run reaches.

**This is the only CR of wave 6 that touches `src/`.** CR-CRU-114 and CR-CRU-115 each assert an empty
`git diff --stat -- src public` at close; this one owns the server change, so those ACs stay honest.

## Risk

- **No migration case exists, and that was measured rather than assumed.** The board holds 0 open
  plans, 0 active cycles and 0 `IN_PROGRESS` CRs (2026-09-09), so no wave is active and the first
  refusal this ships cannot strand work already under way. The hazard was real only under an
  activeness rule that counted aborted plans, which §S1 now excludes by name.
- The guard reads the queue on a write path that today reads only plans. `GET …/plans` measured
  6-9 s at 102 plans, so the guard must not add a full queue scan per request — `deriveQueueStatus`
  is already per-CR, and the wave question needs the entries' `wave` and `status` only.
- **§S4 makes an "unreachable" branch reachable.** The renderer's `active === false` path has never
  executed, so nothing about it is proven — including whether the header, the roll-up and the
  annotation slot read correctly without the marker. That branch needs assertion, not inspection.

## Non-goals

- **No wave record, no `wave-activate` verb, no wave milestone.** Activeness and completion stay
  derived; only the refusal is added. Ruled 2026-09-09.
- No change to the per-plan single-active-cycle rule, or to `wave-sequence`, `cr-plan` or how `seq`
  is authored.
- No retroactive audit of historical plans that violated the rule before it existed.
