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

A wave is **active** while it holds an open plan or an `IN_PROGRESS` CR. Activeness stays DERIVED —
no wave record, no state to set, no verb to forget — exactly as wave completion does (ruled
2026-09-09). What this CR adds is the refusal that keeps the derivation single-valued.

Opening a plan for a CR whose wave is not the active wave is **refused** while another wave is
active, with `code: "already-active"` naming the wave that holds the open work. The existing
per-plan single-active rule is untouched; this is its sibling one container up.

### §S2 Waves open in order

Opening a plan for a CR in wave W is **refused** while an earlier wave still holds an unfinished CR,
with `code: "out-of-order"` naming that wave and the CR that blocks it. Unfinished carries the
meaning the DN fixes and this project already uses: neither landed nor declared dead, so a wave whose
remainder is `VOID`/`SUPERSEDED` does not block its successor.

Wave order is the queue's declared order of waves, taken from the same published data `next` reads —
never re-derived from a `seq` value, which CR-CRU-095 AC6 settled for the reader and which holds here
for the same reason.

### §S3 The refusal names the move that clears it

Each refusal carries `help[]` stating what would make the write legal: for `already-active`, closing
or aborting the open plan in the active wave; for `out-of-order`, the blocking CR and that it must
land or be declared dead. A refusal that only says no is a refusal the caller cannot act on.

### §S4 One wave carries the marker

With the constraint enforced, at most one wave can satisfy "holds open work", so the roadmap's
`· active` marker has exactly one candidate by construction. The renderer's marker rule is asserted
against a two-wave release — the shape 0.2.0 now has — so a second marker cannot appear.

## Acceptance criteria

**§S1 — single active wave**

- [ ] With an open plan for a CR in wave 6, a plans POST for a CR in wave 7 is refused with
      `ok: false` and `code: "already-active"`, and the error names wave **6** and the CR whose plan is
      open.
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
- [ ] Neither refusal is a 500: both are `400`-class envelopes with `ok: false`, matching the plans
      route's existing refusal shape.

**§S4 — one marker**

- [ ] Given a release holding two waves where one has open work, the roadmap's `· active` marker
      renders on exactly **one** wave box — asserted by counting marker nodes across both boxes, not
      by inspecting one.
- [ ] Given a release holding two waves with no open work, **zero** markers render, and that is not
      an error.

**Integration**

- [ ] After this CR, the plans POST invokes the wave guard on the production path: a grep for the
      guard returns ≥1 non-test caller in `src/v2.ts`, and VERIFY runs that grep itself.
- [ ] An existing client flow proves it end to end: `plan-file` for a CR in a non-active wave returns
      the refusal through the client envelope, with the client's own non-zero exit.

## Estimated size

One to two cycles. `src/store.ts` (the wave guard beside `transitionCycle`'s siblings),
`src/v2.ts` (the plans route), `src/hints.ts` (the two help lines), `public/app.js` only if §S4's
marker count is not already single-valued; tests in `tests/` and `tests/client/`.

**This is the only CR of wave 6 that touches `src/`.** CR-CRU-114 and CR-CRU-115 each assert an empty
`git diff --stat -- src public` at close; this one owns the server change, so those ACs stay honest.

## Risk

- **A constraint that refuses writes can strand an orchestrator mid-flight.** If two waves already
  hold open work when this ships, the first refusal it issues may be for work already under way. The
  ACs must include the migration case: an existing second-wave open plan is reported, never
  silently closed, and the CR states which of the two is treated as active (the earlier wave).
- The guard reads the queue on a write path that today reads only plans. Cost is one extra read per
  plan creation; `GET …/plans` already measured 6-9 s at 102 open plans, so the guard must not add a
  second full queue scan per request.
- Activeness derived from "an open plan or an `IN_PROGRESS` CR" has two sources. If they can
  disagree — a plan open on a CR the queue calls `COMPLETED` — the CR must state which wins rather
  than let the answer depend on evaluation order.

## Non-goals

- **No wave record, no `wave-activate` verb, no wave milestone.** Activeness and completion stay
  derived; only the refusal is added. Ruled 2026-09-09.
- No change to the per-plan single-active-cycle rule, or to `wave-sequence`, `cr-plan` or how `seq`
  is authored.
- No retroactive audit of historical plans that violated the rule before it existed.
