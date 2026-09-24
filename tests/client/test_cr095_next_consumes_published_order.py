"""RED — CR-CRU-095 C1 (client half): `resolve_next` consumes the PUBLISHED order.

Spec: docs/changes/CR-CRU-095-seq-scales-collide.md §S1, AC6/AC6a/AC6b
Server half of the same cycle: tests/queue-canonical-order.test.ts

WHAT THIS FILE COVERS. §S1 makes the SERVER publish one canonical order —
the sort key `(wave number, release version with an undeclared release last
within its wave, seq)`. That fix alone does not fix `next`, and this file is
the proof-shaped statement of why.

    `resolve_next` does `lane = sorted(lane, key=_lane_order)`
    (clients/_crucible_axi.py:1510), and `_lane_order` returns `(0, seq)`
    (:1301-1308).

It RE-SORTS BY THE SEQ VALUE, discarding the position the server published. Run
unchanged against a canonically ordered payload of the live board's 94 rows, its
`actionable[0]` is still `CR-CRU-015` at seq 62 — AC7's forbidden answer. So the
CR's original claim that "`resolve_next` needs no change at all" was wrong, and
AC6 as first written ("the client stays UNCHANGED") made AC7 unsatisfiable. Both
were amended: the re-sort is DELETED and the lane is taken in the order the
server published — CR-091 AC18's principle ("a reader does not re-derive order")
applied to the client, with zero comparators in the client.

Covered here: AC6 (published-order consumption, no ordering left in the client)
and AC6a (a seq-less row keeps its published position AND still warns).
Deliberately NOT here: the server key (the bun file above), `queue_tracks`,
track scoping §S3, and the HOLD/DRAINED logic — AC6 keeps all of those
unchanged, so this file asserts on the ORDER ONLY and re-asserts nothing that
tests/client/test_cr092_next_decision_resolver.py already owns.

AC6b — the regression list, MEASURED not guessed. Modelling the GREEN (patching
`_lane_order` to a constant key, so Python's stable sort preserves the published
order) and running the whole CR-092 suite leaves 75 of 77 tests passing. Exactly
two assert the seq re-sort itself, and GREEN amends them:

    LaneOrderTest.test_the_lane_is_ordered_by_the_published_seq
        (tests/client/test_cr092_next_decision_resolver.py:1324) — feeds a
        deliberately SCRAMBLED response [seq 30, 10, 20] and asserts the pick is
        the seq-10 row. Its subject becomes "the lane arrives ordered and the
        resolver consumes position 0"; its §S4 intent ("`next` never re-orders
        the lane") is what AC6 finally makes true.

    LaneOrderTest.test_an_entry_with_no_seq_is_surfaced_rather_than_positioned
        (:1336) — publishes the seq-less row FIRST and asserts the pick is the
        seq-10 row, i.e. that the seq-less row was moved LAST. AC6a inverts the
        pick half (the row keeps its published position) and keeps the warning
        half verbatim: `missing-seq` still fires and still names the cr.

Neither is modified here — naming them is this cycle's contract (AC6b).

RED expectation: every test below fails on the ORDER — the resolver answers the
low-seq row where the published order named another. No test here touches
`clients/`; the module is loaded read-only, exactly as the CR-092 suite loads it.

Invocation:
    python3 -m pytest tests/client/test_cr095_next_consumes_published_order.py -q
"""


# CR-CRU-098 C3 — every test that stood in this file was deleted
# (docs/changes/CR-CRU-098-test-classification.md), with the fixtures and harness
# only they used. The file stays as the record of where they went.
#
# PORTED to tests/next-resolver.test.ts ("resolveNext consumes the PUBLISHED
# order, never re-sorts by seq value" group), against the server resolver that
# replaced the client one:
#   PublishedOrderIsConsumedTest.test_the_live_boards_canonical_payload_answers_a_020_cr_not_cru_015
#   PublishedOrderIsConsumedTest.test_the_lane_is_taken_in_published_position_not_seq_value_order
#   PublishedOrderIsConsumedTest.test_a_non_actionable_row_is_skipped_without_reordering_the_lane
#   SeqlessRowKeepsItsPublishedPositionTest.test_a_row_published_without_seq_keeps_its_published_position
#   SeqlessRowKeepsItsPublishedPositionTest.test_the_missing_seq_warning_still_fires_and_names_the_cr
#     (the last two combined into one bun test, as this file's own note said the
#     two halves are inseparable).
#
# RETIRED under CR-CRU-098 §S4:
#   PublishedOrderIsConsumedTest.test_resolve_next_no_longer_orders_anything — an
#   AST guard on the client-side `resolve_next`, which AC10 deletes: once the
#   pointer lives on the server there is no client resolver left to hold to "no
#   comparator". Its principle is re-proved against src/next.ts by the bun test
#   "`src/next.ts` contains no comparator" in tests/next-resolver.test.ts.
