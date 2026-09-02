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

`listQueue` orders by a **sort key**, not a pairwise comparator: **`(wave number, release version
with an undeclared release sorting LAST within its wave, seq)`**.

This reuses the comparator that already exists — `compareContainers` (`src/v2.ts:1927-1932`),
which orders a different release by `compareVersionLabels` and the same release by `waveNumber`.
CR-091's own comment on it warns that *"a second one would order them differently"*, so this CR
adds no comparator; it lifts the canonical one so the read that lacked it shares it.

**One correction to that comparator, found in RED and ruled 2026-09-02.** As it stands it reads
`a.release ?? ""`, and `compareVersionLabels("", "0.2.0")` is **negative** — a label with fewer
numeric components sorts first (`src/store.ts:365`). Applied verbatim, every release-less row
would sort *before* every declared release, and the reproduction would still fail: on the live
board **66 of 94 rows carry no release** — every shipped wave (1–4, which CR-091 §S6 correctly
refuses to plan), plus the deferred wave 6 — and `CR-CRU-015` would still lead.

**Second correction, also found in RED the same day: the rule must be a KEY, not a comparator.**
The first ruling was pairwise — *release when both declare, otherwise wave* — and the RED agent
proved it **intransitive**: `A = 0.3.0/5 seq 5004`, `B = undeclared/5 seq 5002`,
`C = 0.10.0/5 seq 5001` gives `A < C` (release), `C < B` (wave tie → seq), `B < A` (wave tie →
seq) — a strict cycle, and `Array.sort` then returns **three different orders across the six input
permutations**. The published order would depend on insertion order, not on the data. The
configuration needs two declared releases sharing a wave number (CR-091 §S4/§S8 explicitly
tolerate it) plus one undeclared row whose seq lands inside their block — unreachable today, one
row away from AC4's fixture.

**Release-first has no transitive extension to undeclared rows.** With release as the primary key
an undeclared row needs a sentinel: sentinel-first is the verbatim comparator (015 leads);
sentinel-last is the 15-false-warning rule below. The pairwise fallback was the attempt to avoid
both, and it is what breaks transitivity. **Wave-first does have one**: the queue has numbered
its waves monotonically across releases since CR-CRU-014 (*"Wave 5 (0.2.0)"* after 0.1.0's waves
1–4), which is the premise CR-091 §S4's seq-block arithmetic already rests on — so wave is the
system's own cross-release axis. Release then breaks ties between two releases sharing a wave
number (AC4), an undeclared release sorts last within its wave (declared work is scheduled;
undeclared is not), and seq orders within the container. One key, total order, 1 result across all
6 permutations. On any board that follows the wave convention this coincides with release-first
for every declared pair, so AC1's intent survives; a fixture that gives a *later* release a
*lower* wave number violates the convention and is not a valid AC1 fixture.

**Rejected: "every undeclared row sorts last" (globally).** It also fixes `next`, but the same key
decides `cross-wave-backwards` (`src/v2.ts:1987-2015`), and under that rule a 0.2.0 CR depending
on shipped wave-4 history reads as *"depends backwards"*. Measured against the live board: **15
false warnings** (e.g. `014(0.2.0/5) → 011(-/4)`, `068(0.2.0/5) → 066(-/4)`). The ruled key
produces **zero** (verified on the container key alone — the eight same-container `-/4 → -/4`
inversions it also surfaces are `out-of-order`, which fires today on the README's own positional
order and is not this CR's), while a genuine backwards dependency — a 0.2.0 row depending on an
undeclared wave-6 row — still warns, correctly.

**The fix is server-side — and the client must stop re-sorting.** An earlier draft had the client
sort by `(wave, seq)`, wrong three ways: a second comparator; ignoring `release` so two releases
sharing a wave number tie; and ordering in a reader, which **CR-091 AC18** outlawed. There is no
version comparator in `clients/_crucible_axi.py` and none is added.

But the gap analysis then claimed *"`resolve_next` needs no change at all"*, and RED proved that
wrong too: `resolve_next` does `sorted(lane, key=_lane_order)` (`clients/_crucible_axi.py:1510`),
and `_lane_order` returns `(0, seq)` (`:1301-1308`) — it **re-sorts by the seq value**, discarding
the position the server published. Run unchanged against a canonically ordered payload of the live
94 rows, its `actionable[0]` is still `CR-CRU-015` at seq 62. So the server fix alone leaves
`next` wrong, and AC6 as first written ("client unchanged") made AC7 unsatisfiable.

So `resolve_next` becomes a pure consumer: the seq re-sort is **deleted** and the lane is taken in
the order the server published — CR-091 AC18's principle applied to the client too, with **zero**
comparators in the client. `_lane_order`'s other job — sorting a seq-less row last — is vestigial:
CR-091 publishes `seq` on every row, and a missing one already raises the `missing-seq` warning,
which stays. This is a client change and gets its own cycle.

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

- **AC1** — `listQueue` publishes rows ordered by the sort key `(wave number, release version with
  an undeclared release last within its wave, seq)`. For any two declared rows on a board that
  follows the monotonic wave convention this equals release-then-wave order.
- **AC1a** — An undeclared row orders against a declared one by **wave number**: an undeclared
  wave-4 row precedes a `0.2.0`/wave-5 row; an undeclared wave-6 row follows it. Fixture: the live
  board's shape — shipped waves 1–4 undeclared, 0.2.0 at wave 5, deferred wave 6 undeclared —
  publishes waves 1–4, then 0.2.0, then wave 6.
- **AC1b** — `cross-wave-backwards` does **not** fire for a declared row depending on an undeclared
  row of a lower wave (shipped history). Fixture: the live board's 15 such edges (e.g.
  `CR-CRU-014 → CR-CRU-011`, `CR-CRU-068 → CR-CRU-066`) produce zero warnings.
- **AC1c** — `cross-wave-backwards` **does** fire for a declared row depending on an undeclared row
  of a higher wave (a genuine backwards dependency on deferred work).
- **AC1d** — The order is a **total order**: `A = 0.3.0/5 seq 5004`, `B = undeclared/5 seq 5002`,
  `C = 0.10.0/5 seq 5001` publish as `A, C, B` from **every** one of the six insertion
  permutations. (The pairwise rule this replaced returned three different orders.)
- **AC1e** — Within one wave, every declared row precedes every undeclared row regardless of
  `seq`: an undeclared `-/5` row at seq 6000 and one at seq 75 both follow the whole `0.2.0/5`
  block, and order between themselves by seq.
- **AC2** — Exactly **one** key function decides container order, shared by `listQueue` and by
  `dependencyWarnings`' container verdict; no second version/wave comparator is introduced, in
  TypeScript or Python. Assert behaviourally: for distinct containers, `cross-wave-backwards` fires
  **iff** the dependant precedes its dependency in `listQueue`.
- **AC3** — Within one container the authored `seq` order is preserved exactly; §S1 changes order
  only BETWEEN containers.
- **AC4** — Two releases sharing a wave number order by release version, never tie.
- **AC5** — A row whose wave carries no integer still orders deterministically (block 0, per
  `waveSeqBase`).
- **AC6** — `resolve_next` consumes the published order **verbatim**: the `sorted(lane,
  key=_lane_order)` re-sort by seq value is deleted, `actionable[0]` is the first actionable row in
  the order the server published, and the client contains **zero** comparators. `queue_tracks`,
  track scoping (§S3) and the `HOLD`/`DRAINED` logic are unchanged.
- **AC6a** — The `missing-seq` warning still fires for a row published without `seq`, and such a
  row keeps its published position rather than being moved last.
- **AC6b** — Regression on `tests/client/test_cr092_next_decision_resolver.py`: every existing
  test still passes, except any that asserted the seq re-sort itself, which is amended to assert
  published-order consumption and named in the cycle's report.
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

**RED caught the spec being wrong a second time.** §S1 originally said to apply `compareContainers`
*as it stands*. The C1 RED agent proved that verbatim reuse cannot pass the CR's own reproduction:
`compareVersionLabels("", "0.2.0")` is negative, so every one of the live board's 66 undeclared
rows would sort first and `CR-CRU-015` would still lead. The agent pinned "undeclared last" and
flagged it for ratification instead of shipping it silently — the right call, because measured
against the live dependency graph that rule emits **15 false `cross-wave-backwards` warnings** on
shipped history. The ruled wave-fallback emits none. The lesson is the same one twice over: a rule
stated from the spec is a hypothesis until it is run against the real board.

**A board-data defect surfaced while testing the ruling, and was fixed.** `CR-CRU-082` is `VOID`
in the queue README but the board held `lifecycle: null, status: PENDING` — so it read as
actionable and the simulated oracle answered it. VOID is a lifecycle disposition recorded by
`cr-void`, not a status `queue-file` imports; when the board was cleared and repopulated via
`queue-file` on 2026-08-29 the disposition was lost. Recorded again via `cr-void` on 2026-09-02;
no other README VOID lacked a board lifecycle. **Deferred, not this CR:** `queue-file` silently
drops lifecycle dispositions on import, so a repopulated board resurrects voided work as pending.
That is a candidate patch CR and belongs in the register, not folded here.
