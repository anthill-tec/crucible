# CR-CRU-095 — two seq scales collide, so `next` recommends deferred work

- **Type**: patch
- **Wave**: 5 (0.2.0) — filed into the release it actively misdirects. This defect makes the
  scheduling oracle wrong *during 0.2.0's own execution*, which is why the conservative
  post-0.2.0 default is not appropriate here. Release membership remains the user's call.
- **Depends on**: 091, 092
- **Status**: PENDING (0.2.0) — filed 2026-08-29
- **Found by**: dogfooding the CR-091/092 authoring verbs against a real board, 2026-08-29. Not
  found by any test: every unit and integration gate passed (bun 1811/0, python 1272/0). The
  defect only appears when a board holds BOTH authored and unauthored rows, which no fixture did.

## Problem

`next` is the scheduling oracle: one read in, one decision out, `NEXT | HOLD | DRAINED`. On a
normally-populated board it recommends **deferred, out-of-release work ahead of the entire active
release**, with **zero warnings**.

Reproduced live on the dogfood board:

```
next -> decision: NEXT   cr: CR-CRU-015   seq: 62   wave: "6"   warnings: []
```

CR-CRU-015 is deferred post-0.2.0. At that moment the board held **26 authored 0.2.0 rows at seq
5001..5026**, five of them PENDING with every dependency satisfied. The oracle skipped all of them.

### Why — one column, two incompatible scales

`seq` is written by two paths that do not share a numbering scheme:

| writer | value | example |
| --- | --- | --- |
| `wave-sequence` (authored) | `waveSeqBase(wave) + index + 1` — wave `N` owns block `[N×1000, N×1000+999]` (`src/store.ts:394-405`, `:3602`) | wave 5 → `5001..5026` |
| `queue-file` (import) | the row's **position in the Markdown table** | wave 6 → `62`, `64`, `65` |

Positional values (observed range `0..87`) are numerically far below every authored block, so an
unauthored row **always** outranks an authored one. `resolve_next` sorts the lane on that single
column (`clients/_crucible_axi.py:1510`) and takes `actionable[0]` (`:1530`), so the lowest
positional seq wins the whole board.

### Why it is not self-healing

The obvious answer — "then author every wave" — is **impossible by design**, and correctly so:

- **A shipped release is not a plannable target.** `wave-sequence --release 0.1.0` refuses with
  HTTP 404: *"release 0.1.0 has no live proposal — it is not a plannable target … a release that
  has already SHIPPED is settled history"*. That refusal is right (CR-091 §S6) and must stay. So
  waves 1–4 keep positional seq permanently.
- **A deferred row has no release to author it into.** `wave-sequence` requires `--release` with a
  live proposal. Wave 6 (post-0.2.0) has none, and inventing one to satisfy the sequencer would
  fabricate a release decision that belongs to the user.

So the mixed state is not a transient migration artifact. It is the **steady state** of every real
board: shipped waves and deferred waves are permanently unauthored, and the active release is
authored. The two scales will always coexist.

### Why no test caught it

Every fixture authored either all rows or none. The failure needs a *mixture*, and the mixture is
what production data always looks like. `resolve_next` already warns when a row has **no** seq at
all (`missing-seq`, `clients/_crucible_axi.py:1517-1523`) — it has no notion of a seq that exists
but was never *authored*, so the one signal that could have surfaced this stays silent.

## Scope

### §S1 — `next` orders by `(wave, seq)`, not `seq` alone

`_lane_order` gains the wave as its primary key, the existing seq as its secondary. Both values are
already on every published row, so this needs no schema change, no new write path, and no
migration. Wave ordering is exactly the release-progression order the roadmap already draws, so an
authored wave 5 row precedes an unauthored wave 6 row regardless of scale.

Completed rows are already excluded by `_is_actionable`, so shipped waves 1–4 cannot win the sort
whatever their seq.

### §S2 — a mixed lane is reported, never silent

A new warning alongside `missing-seq`: when the actionable lane contains rows whose seq falls
**outside their own wave's block**, `next` names them and says the ordering across the two groups
is not authored. Warn-and-answer on CR-091 §S5's severity ladder — the decision is still returned,
because a positional seq is a legitimate import artifact and not an error.

### §S3 — `queue-file` imports into the row's own wave block

`queue-file` computes `waveSeqBase(wave) + position-within-wave` instead of a global position, so
an imported row lands inside its wave's block and is ordered coherently with authored rows by
construction. This makes §S1 belt-and-braces rather than load-bearing, and it means a freshly
imported board is correctly ordered before any `wave-sequence` call.

This is an ordering change only. It does not mark imported rows as authored, and `wave-sequence`
remains the only way to *declare* an order.

### Non-goals

- **Making a shipped release plannable.** The 404 is correct and stays.
- **Auto-proposing a release for deferred rows.** Release membership is the user's decision.
- **Reordering by dependency.** Dependencies validate, never order (established by CR-014 and
  re-confirmed here: the roadmap correctly flagged `CR-CRU-073 · before its dependency` against a
  real authored order rather than silently fixing it).

## Acceptance criteria

- **AC1** — With a board holding authored wave-5 rows (seq `5001+`, PENDING, deps satisfied) and
  unauthored wave-6 rows (positional seq `< 100`, PENDING), `next` answers a **wave-5** CR.
- **AC2** — `_lane_order` sorts on `(wave, seq)`. A row whose wave carries no integer still orders
  deterministically (block 0, per `waveSeqBase`'s existing contract).
- **AC3** — Within one wave, the authored seq order is preserved exactly; §S1 changes ordering
  only *between* waves.
- **AC4** — A lane mixing in-block and out-of-block seq emits the §S2 warning naming the
  out-of-block crs, and still returns its decision with `ok: true`, exit `0`.
- **AC5** — A fully authored lane emits **no** §S2 warning. The warning fires on mixture, not on
  the mere presence of positional values.
- **AC6** — `queue-file` assigns each imported row `waveSeqBase(wave) + position-within-wave`;
  importing the live 92-row queue leaves every row inside its own wave's block.
- **AC7** — `queue-file` remains idempotent: importing twice yields identical seq values.
- **AC8** — `wave-sequence` behaviour is unchanged, including its refusal for a shipped release and
  its `(release, wave)` write scoping (CR-091 §S4/AC8).
- **AC9** — The existing `missing-seq` warning is unchanged and still fires for a genuinely absent
  seq; §S2's warning is additive and distinctly coded.
- **AC10** — Regression: the reproduction in this CR's Problem section, replayed against the
  dogfood board, answers a 0.2.0 CR instead of `CR-CRU-015`.

## Notes

The dogfood run that found this also confirmed three things working correctly against real data for
the first time, all worth recording because they were previously fixture-only:

- **CR-078 §S9 / AC28** — the shipped leg renders **ascending** (`0.1.0 → 0.1.1 → 0.1.2 → 0.1.3`)
  with the `0.2.0` proposal appended last, from a `listReleases` payload that is newest-first. This
  is the C6 FIX, proven against five real releases.
- **CR-078 C1c** — the rendered wave order matched the authored `seq` byte-for-byte, confirming
  `seq` is consumed verbatim with no client-side re-sort.
- **CR-091 §S6** — the shipped-release refusal and the `(release, wave)` scoping refusal both fired
  with precise, actionable `help[]` naming the exact remedial call.
