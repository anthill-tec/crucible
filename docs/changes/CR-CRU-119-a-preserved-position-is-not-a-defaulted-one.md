# CR-CRU-119 — a preserved position is not a defaulted one

- **Type**: bugfix
- **Wave**: 6 (0.2.0)
- **Depends on**: 091, 095
- **Status**: PENDING (0.2.0) — born mid-release by user ruling, 2026-09-10
- **Design reference**: `docs/research/DN-crucible-wave-track-release.md` — D4's "A CR can be BORN
  mid-release"; CR-CRU-091 §S2 (the `defaulted-seq` finding) and CR-CRU-095 §S2 (the scale-mixture
  widening) are the two contracts this CR reconciles

## Context

Found while running CR-CRU-118 §S3a's historical backfill, 2026-09-10 — and found the expensive way,
which is why the measurement is recorded here in full.

**One sentence serves two different causes, and for one of them it is false.**
`defaultedSeqWarnings` (`src/v2.ts`) builds a single hard-coded message:

> `seq was defaulted for <crs> while a sibling in the same wave or release carries one on a
> DIFFERENT SCALE — …`

Its trigger in `upsertQueueEntry` (`src/store.ts`) is `(moved || !scale) && <a sibling on the other
scale>`, which is two distinct facts:

| | cause | is a seq defaulted? |
|---|---|---|
| a | `moved` — a new entry, or one whose wave changed, so this write CHOSE a position | yes |
| b | `!scale` — the entry KEPT a position that sits outside its wave's block, and a sibling is in-block | **no** |

In case (b) the write preserved the held seq — `const seq = moved ? nextFreeSlot(…) : held!.seq` —
and the warning still announces that one was defaulted. The finding is real (CR-CRU-095's scale
mixture is genuinely present); the sentence describing it is not.

**What it cost.** Backfilling `CR-CRU-090` into `0.1.3` raised this warning. Reading it literally —
"seq was defaulted for CR-CRU-090" — the orchestrator concluded that `cr-plan` clobbers positions on
re-plan, stopped the 62-row backfill after one row, and authored a CR to add seq preservation to a
route that has preserved correctly since CR-CRU-095 §S2. The premise was falsified by two
measurements that should have come first:

- `CR-CRU-001` re-planned into `0.1.0` at the same wave: `seq=0` before, `seq=0` after, and **no
  warning at all**. Preservation works.
- `CR-CRU-090`'s seq was **already 81** before the backfill touched it. The inference that it "held
  61" came from assuming the 62 landed rows ran 0–61 contiguously; they run 0–60 **plus 81**, and 81
  is exactly the out-of-block value that trips case (b) in wave 5 beside `CR-CRU-091`'s 5019.

No data was lost. The warning's wording was the whole of the defect, and it was costly out of
proportion to its size — which is the argument for fixing it rather than filing it as a nit.

**Surfaces:** `defaultedSeqWarnings` and the `QueueWarning` union in `src/v2.ts`; the report
`upsertQueueEntry` returns in `src/store.ts` (today a bare `defaultedSeq: string[]`, which cannot
distinguish the two causes).

## Scope

### §S1 The warning names the cause it actually found

A finding that says what happened. Two causes, two truthful statements:

- a position this write **invented** (`moved`) — the existing sentence, unchanged, because for this
  cause it was always correct;
- a position the entry **already held** that collides in scale with a sibling — a sentence that says
  so, and does not claim a defaulting.

Both keep `wave-sequence` as the remedy they name, because for both it is the remedy.

Whether the two arrive as one code with two messages or as a second `QueueWarning` code is this CR's
decision; the constraint is that a machine reader can tell the causes apart without parsing prose
(§S9), which today it cannot — `crs[]` is identical in both cases.

### §S2 The trigger set does not move

CR-CRU-095 §S2 widened this finding deliberately, and its coverage is not narrowed here: every input
that raises a warning today raises one afterwards. This CR changes what the warning SAYS and what a
machine can tell from it, never when it fires.

The `moved` computation and the seq resolution in `upsertQueueEntry` are untouched. They are correct.

### §S3 The corrected measurement is recorded where the next reader will look

`CR-CRU-090` carries wave 5 with seq 81 — outside wave 5's block, beside siblings on the 5000-scale.
That is a pre-existing scale collision of exactly the kind CR-CRU-095 documents, not damage, and not
this CR's to repair. Recorded because a reader measuring the landed rows' 0–60 run will find 81 and
should not spend the afternoon the orchestrator spent.

## Acceptance criteria

**§S1 — the message tells the truth**

- [ ] A write that INVENTED a position (a new entry, or one whose wave changed) raises a finding whose
      message says a seq was defaulted — today's sentence, asserted verbatim so this CR cannot
      regress the case that was already right.
- [ ] A write that PRESERVED an out-of-block position beside an in-block sibling raises a finding
      whose message does NOT claim a seq was defaulted, and which states the scale collision it
      actually found.
- [ ] The two causes are distinguishable by a machine reader from the envelope alone — by `code`, or
      by a field beside `crs[]` — asserted by driving both on one board and comparing the structured
      values, never by substring-matching the prose.
- [ ] Both findings still name `wave-sequence` as the remedy, with the release and wave that make the
      command runnable.
- [ ] The reproduction is driven from the real shape: an entry holding a legacy positional seq
      (`CR-CRU-090`'s 81 in wave 5) beside a wave-block sibling (`5019`), re-planned at the same wave,
      raises the PRESERVED-cause finding and not the defaulted one.

**§S2 — the trigger is unchanged**

- [ ] Every input that raises a `defaulted-seq` finding today raises a finding afterwards: asserted as
      a table over the trigger's cases — new entry, wave move, preserved out-of-block seq beside an
      in-block sibling, and the release-axis sibling — so a narrowing fails.
- [ ] A same-wave re-plan of an entry whose seq is IN its wave's block still raises nothing, and its
      seq is unchanged: the silent case CR-CRU-095 §S2 chose deliberately (`AC11a`), asserted so this
      CR does not make it noisy.
- [ ] `upsertQueueEntry`'s seq resolution is untouched: a same-wave re-plan preserves the held seq,
      asserted by reading the entry back — the regression pin for the behaviour this CR was
      mistakenly filed against, so the next reader finds a test instead of an argument.

**§S3 — the record**

- [ ] No AC re-authors any wave's seq, and `CR-CRU-090` still holds wave 5 seq 81 and release `0.1.3`
      afterwards. The collision is CR-CRU-095's; this CR only stops the warning lying about it.

**Integration**

- [ ] The finding reaches all five clients unchanged in shape, asserted per client with the client
      count itself asserted (5) — the fleet renders findings and decides nothing (§S9), so a second
      cause must not need a client to learn anything new.
- [ ] With §S1 in place, the remaining 61 landed release-less rows are backfilled through `cr-plan`
      as a DATA step, and the run's findings are read as scale collisions rather than as defaultings.
      Not an AC — recorded so the backfill is not re-litigated a third time.

## Estimated size

One cycle. The fix is a message and a discriminator; the value is entirely in the ACs that pin the
trigger set and the preservation behaviour, so a future reader cannot repeat the misreading.

## Risk

- **This CR touches a warning, not a write.** The danger is not data loss but coverage: narrowing the
  trigger while rewording it would silently drop CR-CRU-095's widening. §S2 exists to make that fail.
- The finding is consumed by five clients as prose plus `crs[]`. Adding a discriminator is additive;
  a client that ignores it renders exactly what it renders today.

## Non-goals

- Changing when the finding fires, or the `moved` / seq-resolution logic in `upsertQueueEntry`.
- Reconciling the two seq scales, or re-authoring wave 5. That is CR-CRU-095.
- Adding `--seq` to `cr-plan`. Authoring order is `wave-sequence`'s, and the division is the design.
- Running the 61-row backfill. A data step, after this ships, performed by no AC here.
