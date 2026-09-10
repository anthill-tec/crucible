# CR-CRU-119 — a re-plan keeps the position it did not author

- **Type**: bugfix
- **Wave**: 6 (0.2.0)
- **Depends on**: 091, 095, 118
- **Status**: PENDING (0.2.0) — born mid-release by user ruling, 2026-09-10
- **Design reference**: `docs/research/DN-crucible-wave-track-release.md` — D4's "A CR can be BORN
  mid-release", and CR-CRU-091 §S2's division of labour between the two axes (`cr-plan` declares
  membership; `wave-sequence` authors order)

## Context

Found by running CR-CRU-118 §S3a's own historical backfill, 2026-09-10, one row in.

**The defect.** `cr-plan` declares a CR's release, wave and title. It carries no `seq` and no
`--seq`, because authoring order is `wave-sequence`'s job — that division is deliberate and correct.
But the route does not merely leave the position alone: on a **re-plan of an entry the board already
holds**, it DEFAULTS a new `seq`, discarding the one the entry was carrying. A verb that declares
membership silently reorders the board.

**Measured, and it cost real data.** CR-CRU-118 §S3a opened a door so a landed CR can be told which
shipped release it belonged to, and its Integration criteria schedule the 62-row backfill as a data
step "run through `cr-plan` once §S3a ships — not an AC, and never a direct database edit". Running
it:

- the 62 landed release-less rows carried seqs **0–60 plus 61** — contiguous, complete, one per row,
  the positional scale `queue-file` assigned when this project's history was imported;
- the first row through the door, `CR-CRU-090`, came back with its release correctly set to `0.1.3`
  and its seq changed from **61 to 81**, defaulted;
- the route said so, in the warning CR-CRU-091 §S2 built for exactly this — `defaulted-seq`, naming
  the CR and telling the caller to run `wave-sequence`. The warning was right. The write was still
  wrong.

The backfill was stopped after that one row. Had it continued, all 62 authored positions would have
been replaced by defaults, and the two seq scales CR-CRU-095 already documents would have interleaved
across the whole of shipped history.

**Why `--seq` is the wrong fix.** The obvious repair is to let `cr-plan` carry a seq. It is the wrong
one: it would give a second verb the power `wave-sequence` owns, and an orchestrator hand-authoring
one row's position is how the scales collided in the first place (CR-CRU-095). The right fix is
narrower — a re-plan should PRESERVE what it did not author.

**Surfaces:** `handleCrPlan` and `declareMembership` in `src/v2.ts`; `replaceQueue`'s seq resolution
and `defaultedSeqWarnings` in `src/store.ts` / `src/v2.ts`. No client change: `cr-plan`'s flag surface
is already correct and gains nothing.

## Scope

### §S1 A re-plan preserves the seq it did not author

Declaring membership for an entry the board already holds leaves that entry's `seq` exactly as it
stands. The rule is about PROVENANCE, not about values: `cr-plan` never authored the position, so it
may not replace it.

A genuinely NEW entry is unchanged — it has no held position to preserve, so it still receives a
defaulted seq and still earns the `defaulted-seq` warning. That path is CR-CRU-091 §S2's and this CR
does not touch it.

### §S2 The warning fires on an invention, never on a preservation

`defaulted-seq` says a position was invented. Once a re-plan preserves, a re-plan must not raise it —
a warning that fires when nothing was defaulted teaches a reader to ignore it, and this project has
already paid for one route that cried findings nobody could act on.

The warning's other trigger — a sibling on a different scale — is CR-CRU-095's subject and stays
exactly as it is.

### §S3 The one damaged row is repaired, or its loss is recorded

`CR-CRU-090` holds seq 81 where it held 61. Its membership (`0.1.3`) is correct and stays.

Repairing it through `wave-sequence` means authoring the whole of wave 5, whose other members carry
the 5000-scale — so a repair of one cosmetic position would re-number shipped rows this CR has no
mandate to touch. The decision this CR takes: **record the loss, do not re-author wave 5.** The value
is one landed row's position among settled history, the scales in wave 5 already collide by
CR-CRU-095's own account, and rewriting five shipped rows to restore one is the worse trade.

Stated here rather than left in a commit message, because a future reader measuring the 0–61 run will
find 81 and deserve to know it was a defect and not an authored choice.

## Acceptance criteria

**§S1 — preservation**

- [ ] A `cr-plan` re-plan of an entry the board ALREADY holds leaves its `seq` byte-identical:
      asserted by reading the entry back from the store, not from the response, with the seq captured
      before the call and compared after.
- [ ] The same call still changes what it IS for — release, wave and title all take their new values
      in the same write, so preservation is not achieved by refusing the re-plan.
- [ ] A re-plan that changes the entry's WAVE still preserves the seq the entry carried. The position
      is the entry's, not the wave's — and a wave move is exactly when a defaulting route would look
      most justified in inventing one.
- [ ] A genuinely NEW entry still receives a defaulted seq and is unaffected: asserted on the same
      board in the same test, so the two paths are distinguished by evidence rather than by comment.
- [ ] The 62-row shape this was found on is driven directly: an entry holding a legacy positional seq
      (the 0–61 scale) is re-planned into a recorded release through §S3a's door and comes back
      carrying BOTH the release and its original seq.

**§S2 — the warning**

- [ ] A re-plan that preserves raises NO `defaulted-seq` warning, asserted by code over the whole
      `warnings[]` rather than by its absence from a filtered view.
- [ ] A new entry that IS defaulted still raises it, with the CR named in `crs[]` — CR-CRU-091 §S2's
      behaviour, unchanged.
- [ ] The different-scale trigger still fires where a scale collision is real: CR-CRU-095's case is
      untouched, asserted so this CR cannot quietly narrow it.

**§S3 — the recorded loss**

- [ ] `CR-CRU-090` carries release `0.1.3` and wave 5 on the live board — its membership backfill
      succeeded and must not be undone by this repair.
- [ ] No AC of this CR re-authors any wave's seq. Asserted as a boundary: wave 5's other members hold
      the seqs they hold now, before and after.

**Integration**

- [ ] With §S1 in place, the 61 remaining landed release-less rows are backfilled through `cr-plan`
      and every one keeps its original seq: run as a DATA step after this CR ships, and asserted as a
      census afterwards — no landed row's seq differs from the value it held before the backfill,
      `CR-CRU-090` excepted and named.
- [ ] `cr-plan`'s flag surface is UNCHANGED across all five clients — no `--seq` is added, asserted
      per client with the client count itself asserted (5). The fix is in the route's treatment of a
      held value, and a client surface that grew would mean the wrong fix was built.

## Estimated size

One cycle. The rule is one branch in the route's seq resolution; the warning follows from it; §S3 is
a recorded decision rather than work.

## Risk

- **This CR changes a write path every membership declaration goes through.** A mistake preserves a
  stale position where a new one was owed, or vice versa. The §S1 criteria assert both directions on
  one board.
- The backfill that found this defect is still outstanding for 61 rows and is blocked on it. Nothing
  else in the queue depends on this CR, so the blast radius is the backfill itself.
- `CR-CRU-090`'s position is already lost. This CR does not restore it and says so; a later CR that
  re-authors wave 5 onto one scale (CR-CRU-095's subject) is where that would belong.

## Non-goals

- Adding `--seq` to `cr-plan`, or any other way for a membership verb to author order.
  `wave-sequence` owns the ordered list, and that division is the design, not an accident.
- Re-authoring wave 5, or reconciling the two seq scales. That is CR-CRU-095.
- Changing the `defaulted-seq` warning's different-scale trigger, its wording, or its shape.
- Running the 61-row backfill. It is a data step, scheduled after this ships, and no AC performs it.
