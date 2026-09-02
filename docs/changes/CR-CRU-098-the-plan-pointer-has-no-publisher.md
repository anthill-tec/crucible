# CR-CRU-098 — the plan pointer has no publisher

- **Type**: feature
- **Wave**: 6 (post-0.2.0) — the pointer is correct and reaches its consumer today. This CR moves
  where it is computed. Release membership is the user's call.
- **Depends on**: 095 — the pointer walks `listQueue`'s published order, which 095 made the
  server's one canonical answer.
- **Status**: PENDING (post-0.2.0) — filed 2026-09-02
- **Found by**: CR-096's gap analysis (DRIFT-1) — its AC12 wanted to render which CR to take up
  next, and there is no way to READ that.

## Problem

The scheduling decision is **authored**: Mainline, with the user, sets the roadmap — wave,
release, `seq`, dependencies — and Crucible records it. `next` is the **pointer** into that
authored plan: it tells the executing orchestrator which CR to take up next. Crucible is the
reference to the plan.

The pointer is computed inside one client:

| symbol | location |
| --- | --- |
| `resolve_next` | `clients/_crucible_axi.py:1473` |
| `_next_trigger` | `:1392` |
| `_next_answer` | `:1450` |

The server publishes no pointer: `decision` occurs **zero** times in `src/v2.ts` and
`src/store.ts`, and there is no `next` route.

So the plan's own reference cannot hand out the pointer it holds. Any consumer that is not this
Python client must recompute it — a second implementation of a pointer into data the server
already owns, which is what CR-091 AC18 ruled out for `seq` and CR-095 §S1 deleted from the client
for ordering.

## Scope

### §S1 — the server resolves the pointer

The resolver moves to the store/API layer, over `listQueue`'s published order — the input it takes
today. Semantics are preserved exactly: `NEXT` with its CR, `HOLD` with its in-flight trigger,
`DRAINED` with its reason, every answer exiting 0.

Derived and read-only: no column, no cached answer. A stored pointer goes stale the moment a row
changes, and the board would then hold two.

### §S2 — a route publishes it

One route, per project and per track (the scoping the resolver already takes).

### §S3 — the client becomes a consumer

`resolve_next`, `_next_trigger` and `_next_answer` are deleted from the client, which reads the
published pointer and formats it. Output shape — human line, AXI envelope, exit code — unchanged.

## Acceptance criteria

- **AC1** — A route publishes the pointer for a project: `NEXT` with its CR, `HOLD` with its
  in-flight trigger, or `DRAINED` with its reason.
- **AC2** — It is resolved over `listQueue`'s published order; no other ordering rule exists in
  the resolver.
- **AC3** — Nothing is stored: no schema change, no cached answer. Two reads of an unchanged board
  agree; a read after a queue write reflects it.
- **AC4** — Every answer exits 0 (regression: the pointer never gates).
- **AC5** — Track scoping is preserved: a pointer requested for a track answers within that
  track's lane, and CR-CRU-092's multi-track refusal is unchanged.
- **AC6** — All 77 behaviours in `tests/client/test_cr092_next_decision_resolver.py` hold against
  the server resolver. Ported, not weakened; a behaviour that cannot be ported is reported.
- **AC7** — `resolve_next`, `_next_trigger` and `_next_answer` have no definition left in
  `clients/_crucible_axi.py`.
- **AC8** — The `next` verb's human line, AXI envelope and exit code are byte-identical for the
  same board.
- **AC9** — All fixtures are synthetic (CR-096 AC29).

## Non-goals

- **Changing what the pointer says.** Semantics are `resolve_next`'s current ones, exactly.
- **Renaming the published `decision` field.** It names the authored decision the pointer reads
  out, and it is accurate. An earlier draft of this CR proposed renaming it; the user corrected
  that on 2026-09-02 and the proposal is withdrawn.
- **Rendering it.** CR-096 draws no `HOLD`/`DRAINED`.
- **Fleet parity work.** Clients inherit the published pointer; anything beyond that belongs to
  CR-CRU-075.

## Notes

**Two mis-framings by me, both corrected by the user.** Filed first as "the scheduling decision has
no publisher" — treating the pointer as the decision. Then rewritten to call it a "reading" and to
rename the `decision` field — over-correcting into the opposite error, and bundling a fleet-wide
envelope rename, a vocabulary argument and the publisher into one CR. The decision is authored data
in the roadmap; `next` points at it; the only defect is that the pointer has no publisher. One
concern.
