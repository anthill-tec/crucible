# CR-CRU-098 — `next` is a reading, not a decision

- **Type**: feature
- **Wave**: 6 (post-0.2.0) — the reading is correct today and reaches its one consumer (the CLI).
  This CR fixes what it CLAIMS to be and moves where it is computed. Release membership is the
  user's call.
- **Depends on**: 095 — the reading is resolved over the published canonical order
  (`compareQueueOrder`: wave, release, seq). 095 made that order the server's answer, so the
  resolver can move without carrying an ordering rule with it.
- **Status**: PENDING (post-0.2.0) — filed 2026-09-02
- **Found by**: CR-096's gap analysis (DRIFT-1) found the missing publisher. **The user then
  rejected the CR's framing** — this CR was first filed as "the scheduling decision has no
  publisher", which is wrong about who decides. Scheduling is the **Mainline orchestrator's act,
  in consultation with the user**: a track raises a request, Mainline disposes, the user approves.
  `next` reads the board and recommends. Checking that correction against the code found the
  product already encodes the error on the wire.

## Problem

Two defects, one root: `next` is treated as an authority instead of a reading.

### §S1 — the published field is called a `decision`

`clients/_crucible_axi.py` emits, as an AXI field every client publishes:

```
:1454   fields = {"decision": "NEXT", "cr": entry.get("cr")}
:1469   return {"decision": "DRAINED", "reason": reason, ...}
:1533   fields = {"decision": "HOLD", "cr": target.get("cr")}
```

**26 occurrences of `decision`** across the resolver and its envelope. Against that:
**zero** occurrences of `recommend`, `advis`, or `never a gate` anywhere in the client, and no
statement in the product that `next` is advisory.

So the one word the product uses for its own scheduling output claims the authority that belongs
to the orchestrator and the user, and nothing anywhere corrects it. This is not cosmetic: a verb
that says `decision` invites exactly the auto-scheduling the workflow forbids — *"never let tracks
self-schedule"*, *"Mainline surfaces the board and waits for the user's go"*, *"do not
auto-dispatch, auto-schedule, or merge"*. A future agent reading `decision: NEXT` has been told by
the tool that a decision exists. It does not. A recommendation exists.

The reading itself is right. `resolve_next` answers `NEXT` / `HOLD` / `DRAINED` with a CR and a
reason, **all exiting 0** — it is already built as an oracle and never gates anything. Only its
name lies.

### §S2 — the reading has no publisher, so only Python can see it

The resolver is client-side:

| symbol | location |
| --- | --- |
| `resolve_next` | `clients/_crucible_axi.py:1473` |
| `_next_trigger` | `:1392` |
| `_next_answer` | `:1450` |
| `_is_actionable` | `:1301` |

The server publishes nothing: `decision` occurs **zero** times in `src/v2.ts` and `src/store.ts`;
there is no `next` route. `refetchRoadmap` reads queue, releases and release-proposals.

Consequences:

1. **No other surface can show the reading.** A dashboard wanting it must reimplement
   `NEXT`/`HOLD`/`DRAINED` in JS — a second oracle in a second language, precisely what CR-091
   AC18 outlawed for `seq` and CR-095 §S1 spent five cycles deleting from the client. CR-096 was
   narrowed to a published-order projection on 2026-09-02 rather than grow one.
2. **Two readings already differ, with nothing saying which question each answers.** On 2026-09-02
   the CLI read `HOLD CR-CRU-096, trigger: in-flight CR-CRU-095` while the first actionable row in
   the published order was 096. Both are true; they answer different questions.
3. **Non-Python clients can only reach parity by reimplementing it** — the same shape as the
   `queue-file` parity gap CR-CRU-075 exists to close.

**Neither defect is in what the reading says.** `resolve_next` is correct and tested
(`tests/client/test_cr092_next_decision_resolver.py`, 77 tests), and CR-095 deliberately left it
unchanged (its AC6: it consumes the published order verbatim).

## Scope

### §S3 — the vocabulary tells the truth about authority

The published field stops claiming a decision. It becomes a **reading** of the board: what the
queue's state recommends, for a human to act on or overrule. The three values keep their meaning
and their names (`NEXT` / `HOLD` / `DRAINED`) — those describe the board, not an act of authority.
The help text states plainly that the verb recommends and that scheduling is the orchestrator's
call with the user.

This is a breaking change to the AXI envelope, which is why it rides WITH §S4 rather than shipping
separately: moving the resolver already re-cuts that envelope across the fleet, and doing the
rename in the same cut costs one fleet migration instead of two.

### §S4 — the server publishes the reading

The resolver moves to the store/API layer, over `listQueue`'s published order — the input it
already takes. Semantics are preserved exactly, including every answer exiting 0.

The reading is **derived and read-only**: no column, no cached verdict. A stored reading would go
stale the moment a row changed and the board would then hold two answers.

A route publishes it per project (and per track, which the resolver already scopes by), and the
roadmap payload carries it, so a render cannot show a reading from a different moment than the
rows drawn beside it.

### §S5 — the Python client becomes a consumer

`resolve_next`, `_next_trigger` and `_next_answer` are DELETED from the client, which reads the
published reading and formats it — the clean cutover CR-095 §S1 established for ordering.
`_is_actionable` may stay for a client's own filtering; the reading no longer calls it locally.

### §S6 — the fleet inherits it

Every client gets `next` by reading it. The verb surface stays identical across all of them (the
CR-CRU-075 census contract) and no client carries scheduling logic.

## Acceptance criteria

- **AC1** — The published envelope names the answer a **reading/recommendation**, not a
  `decision`; no published field, help line or human line calls it a decision.
- **AC2** — The verb's help states that it recommends and that scheduling is the orchestrator's
  call in consultation with the user.
- **AC3** — All five clients publish the renamed field identically (the CR-075 census contract);
  no client retains the old key, including as an alias.
- **AC4** — `NEXT` / `HOLD` / `DRAINED` keep their meanings, and **every** answer still exits 0 —
  the oracle never gates (regression).
- **AC5** — A route publishes the reading for a project.
- **AC6** — The reading is resolved over `listQueue`'s published order, and no other ordering rule
  exists in the resolver.
- **AC7** — Nothing is stored: no schema change and no cached verdict; two reads of an unchanged
  board agree, and a read after a queue write reflects it.
- **AC8** — Every one of the 77 behaviours in `tests/client/test_cr092_next_decision_resolver.py`
  holds against the server resolver. Ported, not weakened; a behaviour that cannot be ported is
  reported, not dropped.
- **AC9** — `resolve_next`, `_next_trigger` and `_next_answer` have no definition left in
  `clients/_crucible_axi.py`.
- **AC10** — The `next` verb's human line and exit code are unchanged for the same board, apart
  from the AC1 rename.
- **AC11** — The roadmap payload carries the reading, so one read serves rows and reading.
- **AC12** — Track scoping is preserved: a reading requested for a track answers within that
  track's lane, and the multi-track refusal (CR-CRU-092) is unchanged.
- **AC13** — All fixtures are synthetic (CR-096 AC29): no AC here names a real CR of the project
  running Crucible.

## Non-goals

- **Changing what the reading says.** Semantics are `resolve_next`'s current ones, exactly.
- **Making `next` a gate, or letting anything schedule from it.** It recommends. Mainline
  schedules, the user approves. AC4 pins the exit code.
- **Storing the reading.** §S4 forbids it.
- **Rendering it.** CR-096 explicitly does not draw `HOLD`/`DRAINED`; a surface for the reading is
  a later CR once there is something to read.
- **Renaming `NEXT`/`HOLD`/`DRAINED`.** They describe board state and are accurate.

## Notes

**The user rejected this CR's original framing, and the framing was the finding.** Filed as "the
scheduling decision has no publisher", it treated the oracle's output as a decision needing
distribution. The correction — scheduling is Mainline's act with the user — is what sent me back
to the code, where the same error turned out to be shipped in 26 places as a published field name.
A CR title that got the authority model wrong was reproducing, in a document, a defect already in
the product.

**A rule applied to one field is a rule not yet generalised.** CR-091 AC18 and CR-095 §S1 both
ruled: one canonical answer, published once, consumed verbatim. `seq` got the rule. The board's
readiness reading did not — because nobody had yet asked a second consumer to read it.

**Vocabulary is a contract.** The codebase already knows this: CR-091 §S2 keeps `lifecycle`
outside `QueueStatus` because they are different axes, and CR-095 §S3 renamed nothing but spent a
whole cycle on what "defaulted" means. A field called `decision` is a design statement about who
is in charge, and it was never argued for — it was typed.
