# CR-CRU-095 — two seq scales collide across containers, so `next` recommends deferred work

- **Type**: patch
- **Wave**: 5 (0.2.0) — filed into the release it actively misdirects. This defect makes the
  scheduling oracle wrong *during 0.2.0's own execution*. Release membership is the user's call.
- **Depends on**: 091, 092
- **Status**: PENDING (0.2.0) — filed 2026-08-29; spec corrected after gap analysis 2026-08-29
- **Found by**: dogfooding the CR-091/092 authoring verbs against a real board. Not found by any
  test: every gate passed (bun 1811/0, python 1272/0) because every fixture authored all rows or
  none, and the failure needs a MIXTURE — which is what a real board always is.

## Problem

`next` is the scheduling oracle: one read in, one decision out. On the live board it recommends
**deferred, out-of-release work ahead of the entire active release**, with **zero warnings**:

```
next -> decision: NEXT   cr: CR-CRU-015   seq: 62   wave: "6"   warnings: []
```

CR-CRU-015 is deferred post-0.2.0. At that moment the board held **26 authored 0.2.0 rows at seq
5001..5026**, five of them PENDING with every dependency satisfied. The oracle skipped all of them.

### The mechanism, and what CR-091 already knew

`seq` is written on two scales:

| writer | value | example |
| --- | --- | --- |
| `wave-sequence` (authored) | `waveSeqBase(wave) + index + 1` — wave `N` owns `[N×1000, N×1000+999]` (`src/store.ts:394-405`, `:3602`) | wave 5 → `5001..5026` |
| bulk queue post (defaulted) | `declaredSeq ?? index` — the array position (`src/store.ts:3424`) | wave 6 → `62`, `64`, `65` |

**CR-091 §S2/AC23 already named this phenomenon precisely.** `QueueSeqReport`'s contract
(`src/store.ts:290-303`) says `defaultedSeq` names *"every cr whose `seq` this write CHOSE while a
sibling in the same wave holds one on a DIFFERENT SCALE — the bulk post's array index beside a
carried `10, 20, 30`, or `cr-plan`'s wave-block offset beside either. That mix is deterministic but
not authored (the two scales interleave in an order nobody chose)"*, and `defaultedSeqWarnings`
(`src/v2.ts:1896-1908`) emits it with `wave-sequence` as the remedy.

So the phenomenon is known, documented and warned. **The gap is its SCOPE: that check is
same-wave.** Within wave 6 every row is positional — one scale, no siblings disagreeing — so the
warning is correctly silent, exactly as its contract says (*"A chosen position that agrees with
every sibling's scale is the ORDINARY case and is silent"*). The collision this CR reports is
**across containers**: wave 6's `62` against wave 5's `5001`.

And nothing orders across containers. `listQueue` is `ORDER BY seq ASC` (`src/store.ts:3465-3470`)
— one column, no container key — so a positional value from an unauthored wave sorts ahead of every
authored wave. `resolve_next` consumes that published order (`clients/_crucible_axi.py:1510`) and
takes `actionable[0]` (`:1530`), so the lowest positional seq wins the board.

### Why it is the steady state, not a migration artifact

"Author every wave" is impossible by design, and correctly so:

- **A shipped release is not a plannable target.** `wave-sequence --release 0.1.0` refuses with
  HTTP 404: *"release 0.1.0 has no live proposal … a release that has already SHIPPED is settled
  history"*. That refusal is right (CR-091 §S6) and stays. Waves 1–4 keep positional seq forever.
- **A deferred row has no release to author it into.** `wave-sequence` requires a live proposal;
  wave 6 has none, and inventing one would fabricate a release decision that belongs to the user.

So authored and defaulted scales permanently coexist on every real board.

## Scope

### §S1 — the SERVER publishes one canonical order; readers keep consuming it verbatim

`listQueue` orders by container first, then by the authored position within it: **release version,
then wave number, then `seq`**.

This reuses the comparator that already exists — `compareContainers` (`src/v2.ts:1927-1932`),
which orders a different release by `compareVersionLabels` and the same release by `waveNumber`.
CR-091's own comment on it warns that *"a second one would order them differently"*, so this CR
adds no comparator; it applies the canonical one in the read that lacked it.

**The fix is server-side, and deliberately not in `next`.** An earlier draft of this CR had the
client sort by `(wave, seq)`. That was wrong three ways: it would be the second comparator 091
warned against; it ignores `release`, so two releases sharing a wave number would tie — a
comparison 091 §S4 tolerates in storage precisely because *no read makes it*, and a client sort
would start making it; and it puts ordering back in a reader, which is exactly what **CR-091 AC18**
outlawed when `buildRoadmapGraph` was caught re-deriving `seq: index`. There is also no
version comparator in `clients/_crucible_axi.py`, so a client sort means a new Python twin of
`compareVersionLabels` — a second source of ordering truth.

Ordering server-side means `next`, the roadmap and the scoped table all inherit one order from one
place, and `resolve_next` needs no change at all.

### §S2 — EXTEND CR-091's existing warning across containers

`defaultedSeqWarnings` keeps its wording and its `defaulted-seq` code, and its scope widens from
"a sibling in the same wave" to "a sibling in any container the same read compares". A board whose
authored waves sit beside defaulted ones says so, once, naming the crs and `wave-sequence` as the
remedy — CR-091 §S3's warn-and-write rung, unchanged: the write is never refused, because a
backlog edit must not require re-authoring an order.

This is an extension of an existing mechanism, not a new detector. The client's `missing-seq`
warning (`clients/_crucible_axi.py:1517-1523`) is untouched and still fires for a genuinely absent
`seq`.

### §S3 — the bulk post defaults into the row's OWN wave block

`src/store.ts:3424` writes `declaredSeq ?? index`. The fallback becomes
`waveSeqBase(entry.wave) + <position within that wave>`, so a defaulted row lands inside its own
wave's block and is on the same scale as an authored one by construction.

**This does not retroactively fix an existing board, and must not claim to.** `declaredSeq` is
`entry.seq ?? snapshot?.seq` (`:3402`) — a **held** seq survives a re-import (CR-091's
carry-forward), so re-posting a board that already stores positional values preserves them. §S3
therefore governs rows with neither a declared nor a held seq: a fresh import, and every row added
later. Existing positional values are corrected by authoring the wave, or made harmless by §S1.

§S1 is the load-bearing fix; §S3 stops the board generating new mixtures.

### Non-goals

- **A second comparator, or ordering in a client.** §S1's whole point.
- **Making a shipped release plannable, or auto-proposing a release** for deferred rows.
- **Reordering by dependency.** Dependencies validate, never order — re-confirmed live: the board
  correctly warned `out-of-order` for `CR-CRU-073` against a real authored order (`src/v2.ts:1999`)
  rather than silently fixing it.
- **Backfilling existing positional seq.** See §S3.

## Acceptance criteria

- **AC1** — `listQueue` publishes rows ordered by release version, then wave number, then `seq`.
- **AC2** — It uses `compareContainers`' semantics; no second version/wave comparator is
  introduced, in TypeScript or Python.
- **AC3** — Within one container the authored `seq` order is preserved exactly; §S1 changes order
  only BETWEEN containers.
- **AC4** — Two releases sharing a wave number order by release version, never tie.
- **AC5** — A row whose wave carries no integer still orders deterministically (block 0, per
  `waveSeqBase`).
- **AC6** — `resolve_next` is UNCHANGED: it still sorts on published order and takes
  `actionable[0]`. No client-side container sort is added.
- **AC7** — With the live board's data — authored wave-5 rows at `5001+` and defaulted wave-6 rows
  below `100`, both PENDING with deps satisfied — `next` answers a **0.2.0** CR, not `CR-CRU-015`.
- **AC8** — The roadmap and the scoped table consume the same published order and require no
  ordering change of their own (CR-091 AC18 regression).
- **AC9** — `defaulted-seq` fires when a defaulted row sits beside an authored one in a container
  the read compares, naming the crs and `wave-sequence`; `ok: true`, exit `0`, write not refused.
- **AC10** — It stays silent when every compared row shares a scale.
- **AC11** — The existing same-wave behaviour of `defaulted-seq` is preserved; its `code` and
  message wording are reused, not replaced.
- **AC12** — A bulk post assigns a seq-less, snapshot-less row `waveSeqBase(wave) + position within
  its wave`; importing a fresh 94-row queue leaves every row inside its own wave's block.
- **AC13** — Carry-forward is preserved: a row with a held `seq` keeps it across a re-import, and
  §S3 does not overwrite it (CR-091 regression).
- **AC14** — A bulk post is idempotent: posting twice yields identical seq values.
- **AC15** — `wave-sequence` is unchanged, including its shipped-release refusal and its
  `(release, wave)` write scoping (CR-091 §S4/AC8).
- **AC16** — The client's `missing-seq` warning is unchanged and still fires for an absent `seq`.
- **AC17** — Regression: the reproduction in this CR's Problem section, replayed against the
  dogfood board, answers a 0.2.0 CR.

## Notes

The dogfood run that found this also confirmed three things working correctly against real data for
the first time, all previously fixture-only:

- **CR-078 §S9/AC28** — the shipped leg renders **ascending** (`0.1.0 → 0.1.1 → 0.1.2 → 0.1.3`)
  with the `0.2.0` proposal appended last, from a `listReleases` payload that is newest-first. The
  C6 FIX, proven against five real releases.
- **CR-078 C1c** — the rendered wave order matched the authored `seq` byte-for-byte: consumed
  verbatim, no client re-sort.
- **CR-091 §S6** — the shipped-release refusal and the `(release, wave)` scoping refusal both fired
  with precise `help[]` naming the exact remedial call.

**Gap analysis moved this CR's fix from the client to the server**, and the reason is worth keeping:
the first draft asserted that nothing in the system had any notion of an unauthored `seq`. That was
true of the client and false of the server, where CR-091 §S2/AC23 had named the exact phenomenon —
*different scale*, *"an order nobody chose"* — three weeks earlier. The real gap was never
detection; it was that the check is same-wave and the read is single-column. Writing a new
client-side sort would have duplicated a comparator that already existed and re-introduced the
reader-side derivation CR-091 AC18 had just deleted.
