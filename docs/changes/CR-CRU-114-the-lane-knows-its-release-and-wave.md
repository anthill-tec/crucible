# CR-CRU-114 — the lane knows its release and wave

- **Type**: feature
- **Wave**: 6 (0.2.0)
- **Depends on**: 091, 092
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-crucible-wave-track-release.md` — "Reading the lane during
  execution — the `next` decision vocabulary" (the three answers, the `DRAINED` reasons, the reader
  is an oracle not a scheduler) and the drift section's **D1** (a wave is a container; a track is
  scheduling) and **D2** (what shipped instead)

## Context

The DN states a lane is a `(release, wave, track)` slice. `resolve_next` filters by **track only**
and then answers the wave question from that track-filtered set:

```python
lane = entries if wanted is None else [
    e for e in entries if canonical_track(e.get("track")) == wanted]   # a SCHEDULING filter
...
if not actionable:
    return (True, 0, _drained_answer("wave-complete", lane), warnings)  # a MEMBERSHIP claim
```

One category error, two faces. In a single-track project the set is the whole queue, so
`wave-complete` fires only when nothing anywhere is actionable: measured 2026-09-09, with wave 5
fully landed, `next` answered `NEXT cr=CR-CRU-015 seq=62 wave 6` — it crossed a wave boundary
silently, and the orchestrator learns a wave ended only by noticing the answer names a different
wave. In a multi-track project the same line makes a **false** claim: a track whose entries have all
landed would report the wave complete while a sibling track still holds actionable CRs.

**Surfaces (verified 2026-09-09):** `resolve_next(entries, track=None, tracks=None)`,
`_drained_answer`, `_next_answer`, `_next_trigger`, `_drained_help`, `DRAINED_REASONS` and
`_next_legacy_line` in `clients/_crucible_axi.py`; `add_next_verb` (the flag surface, `--track` and
`--fields` only); `cmd_next` in each of the five clients. Every queue entry already publishes its
`wave` (`src/types.ts`, `QueueEntry`) and its `release` when declared, and the resolver's contract is
already "ONE read (`GET …/queue`) in, ONE decision out".

## Scope

### §S1 The lane carries all three dimensions, and only the wave answers a wave question

`next` gains `--release` and `--wave` alongside `--track`. All three NARROW the lane; none is
required, and none is inferred when a narrower answer is impossible — the verb writes nothing, so
each is canonicalised client-side exactly as `--track` already is.

The wave predicate reads `wave` and nothing else. A CR's track never participates: not as a filter,
not as a union of per-track slices, not as a special case for one lane or many. A wave is a
container of CRs; a track is how they are ordered and scheduled.

### §S2 `next` announces a wave boundary instead of walking through it

**Only one wave is active at any time** (user requirement 2026-09-09). CR-CRU-116 makes Crucible
refuse the alternative on the write path; this CR is the READ side of the same rule, and it may
therefore resolve exactly one wave and answer for that wave alone.

The lane's wave is resolved as the wave of the first **actionable** entry **in the order the server
published** — never re-derived from the `seq` value, which is CR-CRU-095 AC6's shipped rule and
CR-CRU-091 AC18's prohibition. An explicit `--wave` overrides that resolution. No actionable entry
anywhere ⇒ the last wave in the published order. The resolver names ONE wave on every answer and
never merges two, so a project whose data violates the single-active rule reads as its earliest
unfinished wave rather than as an ambiguous union.

**A boundary is announced, and the announcement expires by itself.** A wave is complete when every
one of its entries is landed or declared dead. When the resolved wave's predecessor is complete AND
the resolved wave holds no landed entry yet, the crossing has just happened, and the answer says so
alongside its decision — one read, one decision, plus the fact that read already proves. It stops
being said the moment the new wave's first CR lands, so it cannot become permanent noise, and it
needs no state on either side.

**This is what makes `wave-complete` reachable.** Resolving the wave from the first actionable entry
alone would skip a finished wave entirely — measured on this board 2026-09-09: wave 5's 46 entries
are all landed except `CR-CRU-113` and `CR-CRU-082`, both `VOID`, so wave 5 is complete, and the
first actionable entry in published order is `CR-CRU-114` in wave 6. A rule that only ever names the
wave of the next actionable CR would answer `NEXT` and never mention that wave 5 closed — the exact
silent crossing this CR exists to end.

Within that wave the three answers are unchanged: `NEXT` names the front actionable CR, `HOLD` names
the front CR and its cause, `DRAINED` names its reason. What changes is that the reader **stops at
the boundary and says so**: when the resolved wave holds no actionable CR, the answer is
`DRAINED / wave-complete` for that wave, and its `help[]` names the move that opens the next one.
The reader still validates the declared sequence and never scans past a blocked front CR — stopping
at a boundary it reports is not the reader choosing an order.

### §S3 A drained lane is not a complete wave

With `--track` supplied, a track that holds no actionable CR inside a wave that is **not** complete
answers `DRAINED / awaiting-assignment` — the reason that already means "this lane has nothing
scheduled". `wave-complete` is reserved for the wave itself being finished, independent of how many
tracks it was scheduled across. No new reason is added: `DRAINED_REASONS` stays
`("wave-complete", "awaiting-assignment", "no-roadmap")`.

### §S4 The answer states which container it answered for

The envelope names the lane it resolved — its release when one is in scope, its wave, and its track
when the project declares more than one — so a reader can tell which container an answer is about
rather than inferring it from the CR that came back.

## Acceptance criteria

**§S1 — the flags and the predicate**

- [ ] `next --help` lists `--release`, `--wave` and `--track`; `add_next_verb` declares all three and
      the verb still writes nothing (no `--agent`).
- [ ] All five clients (`bun`, `python`, `mvn`, `rust`, `arduino`) expose `--release` and `--wave` on
      `next`, asserted per client, and the count of clients asserted is itself asserted (5).
- [ ] `resolve_next` computes the wave predicate from entries' `wave` alone: with a fixture whose
      wave-6 entries are split across `track-1` and `track-2`, the predicate's result is byte-identical
      for `--track 1`, `--track 2` and no track.
- [ ] `--wave 6` with a queue holding waves 5, 6 and 7 answers only about wave 6; `--release 0.2.0`
      narrows to the waves declared in that release and excludes an entry whose `release` is unset.
      This case is LIVE, not hypothetical: wave 6 currently holds two entries declared into 0.2.0 and
      four whose `release` is unset (measured 2026-09-09).
- [ ] Neither flag is coerced: `--wave` and `--release` are matched verbatim against the entry's own
      `wave` / `release` strings — no integer parse, no label normalisation — mirroring
      `declareMembership`'s "nothing is COERCED on the way in". `--track` keeps its existing
      `canonical_track` digit rule, which is a mirror of a server-side write rule and stays.
- [ ] No assertion depends on `seq` being unique within a wave: the live board holds `CR-CRU-114` and
      `CR-CRU-098` both at `6001` (the authoring verb keys on `(release, wave)` while the seq block
      keys on `wave` alone), so a fixture that assumed uniqueness would pass for the wrong reason.

**§S2 — the boundary is an answer**

- [ ] `next --wave 5` against a wave whose every entry is landed or dead returns `decision: DRAINED`,
      `reason: wave-complete`, naming wave **5** — deterministic, and the only way to ask the
      question directly. Today the same call cannot be made at all.
- [ ] `next` with no flags, against the live shape (wave 5 complete, wave 6 holding actionable CRs and
      no landed entry) returns `NEXT` on wave 6's front CR **and states that wave 5 completed**. Today
      it returns `NEXT` and says nothing — this is the reversal.
- [ ] That announcement EXPIRES: with one wave-6 entry `COMPLETED`, the same call returns `NEXT`
      without the completed-wave statement. Asserted both ways in one fixture pair.
- [ ] `DRAINED`'s `help[]` names the move that opens the next wave and carries the next wave's number
      as data, not prose ("6"), and exit code is 0 — `DRAINED` is an answer, never an error.
- [ ] A wave holding one `VOID` and one `SUPERSEDED` CR and no `PENDING` CR answers
      `wave-complete` — dead CRs are finished for this predicate.
- [ ] A wave whose front CR is `PENDING` with an unmerged `dependsOn` still answers `HOLD` on THAT
      CR with cause `dependency`; the resolver does not scan into the next wave for something startable.
- [ ] With `--wave` supplied explicitly, the resolved wave is that wave even when an earlier wave
      still holds actionable CRs.

**§S3 — lane vs wave**

- [ ] Two-track fixture, wave incomplete, `track-1` fully landed: `next --track 1` returns
      `DRAINED / awaiting-assignment`, and NOT `wave-complete`.
- [ ] The same fixture with `--track 2` returns `NEXT` on track-2's front CR, proving the wave was
      genuinely incomplete when track-1 reported drained.
- [ ] `DRAINED_REASONS` still has exactly 3 members, asserted by length and by value.

**§S4 — the envelope**

- [ ] Every `next` answer — `NEXT`, `HOLD`, `DRAINED` — carries the resolved `wave`; carries
      `release` when one was in scope; carries `track` only when the project declares more than one.
- [ ] The one-line legacy summary (`_next_legacy_line`) states the wave for all three decisions.

**Integration**

- [ ] After this CR, `cmd_next` in each of the five clients passes the resolved release and wave into
      `resolve_next` — a grep for the new parameters returns ≥1 non-test caller per client, and VERIFY
      runs that grep itself.
- [ ] `GET …/queue` is still read exactly once per invocation: the assertion counts requests, so the
      new dimensions cost no extra round-trip.

## Estimated size

One cycle. `clients/_crucible_axi.py` (`resolve_next`, `_drained_answer`, `_drained_help`,
`add_next_verb`, `_next_legacy_line`) plus the five `cmd_next` wrappers; tests under `tests/client/`.
No server change: `git diff --stat -- src public` is empty at close.

**Close-out step, planned once rather than escalated per cycle:** this CR adds prose to
`clients/_crucible_axi.py`, and `PROSE_CITATIONS.clients.head` in
`tests/project-namespace-tripwire.test.ts` is pinned at **785** (measured 2026-09-09). The head
figure is re-recorded in the CR's final cycle, in the same commit as the last prose change.

## Risk

- **This reverses an answer.** Any test that pins today's silent crossing (a `NEXT` on the following
  wave while the current one is drained) states the defect as the contract and must be replaced by the
  §S2 shape, not re-pinned around it.
- The wave-resolution rule reads `seq`. An entry without one is already a declared roadmap defect
  surfaced as the `missing-seq` warning; this CR must keep surfacing it rather than filling a position
  of its own.
- Waves are strings on the wire. Ordering "the next wave" must not assume a bare integer without
  saying so, and `waveNumber`'s existing parse is the only interpreter.

## Non-goals

- **No wave-completion record.** Wave completion stays a derived ANSWER — no milestone type, no event,
  no verb. Ruled 2026-09-09.
- **No roadmap backlog zone.** A wave with no release stays deliberately invisible on the roadmap;
  membership is declared, never inferred. Ruled 2026-09-09.
- No change to what a track means, to `wave-sequence`, or to how `seq` is authored.
- No server route, schema or migration.
