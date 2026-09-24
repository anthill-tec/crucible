# CR-CRU-098 — RED test classification (AC2)

Cycle C1, agent `CR-CRU-098-C1-RED`. Classifies every behaviour of
`tests/client/test_cr092_next_decision_resolver.py` (85 tests, measured at
`7f2a85c`) and `tests/client/test_cr095_next_consumes_published_order.py`
(6 tests) into exactly one of **ported** / **kept** / **retired**, per AC2.

Total: **91 tests** — **55 ported**, **18 kept**, **18 retired**. Every test
in both files is accounted for; none was found to belong in none of the
three buckets.

Neither source file is edited in this commit. GREEN performs the actual test
surgery: C1/C2 graduate the ported behaviours' production code, and GREEN C3
removes the retired classes with a comment naming this CR and the §S4 reason
(AC12 — pinned now by `tests/client/test_cr098_s4_boundary_retirement_pending.py`,
deliberately red until GREEN C3 lands).

## Legend

- **ported** → a bun test of the pure server function (`tests/next-resolver.test.ts`)
  or the route (`tests/next-route.test.ts`).
- **kept** → a Python verb test, adapted to AC8/AC9 where the transport
  changed (`tests/client/test_cr098_next_verb_reads_the_route.py`), or
  adapted to AC10/AC11's new symbol list
  (`tests/client/test_cr098_resolver_lands_on_the_server.py`), or unaffected
  and left exactly as-is (no new file — nothing changed for it).
- **retired** → exactly §S4's four classes, plus the one cr095 method that
  only asserts the now-deleted client-side `resolve_next`'s shape (dispatch
  prompt item 1's third criterion). Pinned red by
  `tests/client/test_cr098_s4_boundary_retirement_pending.py`.

## tests/client/test_cr092_next_decision_resolver.py (85 tests)

| Class | Tests | Verdict | Where it lands | Reason |
|---|---|---|---|---|
| `CanonicalTrackTest` | 3 | **ported** | `tests/next-resolver.test.ts` ("AC6 — every spelling…") | The spellings 091 accepts, re-expressed against the resolver's own `scope.track` surface — the standalone `canonical_track` helper is retired (AC10), so its behaviour is proved through the function that consumes it. |
| `TrackCanonicalisationAgreesWithTheServerTest` | 5 | **retired** | — (§S4) | "the client mirrors the server's track rule … With one side, there is no mirror." Exactly §S4's named class. |
| `TrackScopingTest` | 9 | **ported** | `tests/next-resolver.test.ts` ("AC6 — multi-track refusal…") | Pure resolver behaviour: refusal shape, `totalCount`, bare single-track/no-track answers, stored-vs-canonical spelling. Not ported weakened — every positive/negative/refusal assertion carries over. |
| `NextDecisionTest` | 7 | **ported** | `tests/next-resolver.test.ts` ("AC1/AC4 — NEXT…") | NEXT's field rules (verbatim, omitted-not-null, seq never substituted). `test_next_gets_no_entry_in_the_canned_help_table` folds into the AC5 help[] group (checked indirectly: `HELP_STEPS`/canned-table concept has no server-side analogue since `help[]` is derived per decision by construction — noted as a design continuation, not a literal port). |
| `HoldDecisionTest` | 18 | **ported** | `tests/next-resolver.test.ts` ("AC1/AC4 — HOLD's four trigger kinds") | All four trigger kinds, precedence, cross-track dependency resolution vs lane-scoped occupancy — semantics unchanged (Non-goals). |
| `DrainedDecisionTest` | 11 | **ported** | `tests/next-resolver.test.ts` ("AC1/AC4 — DRAINED's three reasons") | All three reasons, the dead-CR axis (AC16), the wave-complete corpse-naming help[]. |
| `NextVerbEnvelopeTest` | 15 | **kept** (adapted, AC8/AC9) | `tests/client/test_cr098_next_verb_reads_the_route.py` | Envelope/exit-code/refusal/failed-read/`--fields`/context/no-agent-identity tests survive as CLIENT tests, but the transport changed (one GET of `.../next` with query params, never `.../queue`) — every case is re-driven against that new contract. |
| `LaneOrderTest` | 2 | **ported** | `tests/next-resolver.test.ts` ("AC1 — resolveNext consumes the PUBLISHED order…") | AC1's "no sort, no seq comparison" — semantics preserved, re-proved against the new pure function. |
| `HarnessIsolationTest` | 1 | **kept**, unaffected | stays in `test_cr092_next_decision_resolver.py`, unedited | §S5's harness-DB isolation guard scans `clients/*.py` for forbidden tokens; nothing about this CR's move changes that surface. No new test written — there is nothing to change. |
| `ResolverLandsOnceTest` | 2 | **kept** (rewritten, AC10/AC11) | `tests/client/test_cr098_resolver_lands_on_the_server.py` | `test_the_shared_module_owns_every_resolver_symbol` asserted the OPPOSITE of AC10 (that `canonical_track`/`queue_tracks`/`resolve_next` ARE in the module) — superseded outright by `AC10SharedModuleShedsTheResolverTest`, never weakened in place. `test_no_client_defines_its_own_resolver`'s delegating-`cmd_next` shape carries over unchanged, widened to AC10's full symbol list, as `AC11NoClientDefinesItsOwnResolverTest`. |
| `NextBlockCitationsTest` | 2 | **retired** | — (§S4) | "line citations into the client block." Exactly §S4's named class — the citations die with the block. |
| `PublishedTrackFactTest` | 9 | **retired** | — (§S4) | "the track fact could be unpublished … On the server the resolver reads the declared tracks directly; the case cannot arise." Exactly §S4's named class. |
| `PublishedTrackFactIsWiredTest` | 1 | **retired** | — (§S4) | Same boundary as `PublishedTrackFactTest` — the wiring it proves (a non-test caller reads the published `tracks` field) has no subject once the client no longer reads a `tracks` fact off a `/queue` payload at all. |

Subtotal: ported 50, kept 18, retired 17. (85 total.)

## tests/client/test_cr095_next_consumes_published_order.py (6 tests)

| Class.method | Verdict | Where it lands | Reason |
|---|---|---|---|
| `PublishedOrderIsConsumedTest.test_the_live_boards_canonical_payload_answers_a_020_cr_not_cru_015` | **ported** | `tests/next-resolver.test.ts` ("published order beats seq VALUE order…") | AC6's reproduction fixture, re-expressed for the new resolver. |
| `PublishedOrderIsConsumedTest.test_the_lane_is_taken_in_published_position_not_seq_value_order` | **ported** | `tests/next-resolver.test.ts` ("a deliberately scrambled input…") | Same. |
| `PublishedOrderIsConsumedTest.test_a_non_actionable_row_is_skipped_without_reordering_the_lane` | **ported** | `tests/next-resolver.test.ts` ("a non-actionable row published first…") | Same. |
| `PublishedOrderIsConsumedTest.test_resolve_next_no_longer_orders_anything` | **retired** | — | AST-scans the CLIENT-SIDE `clients/_crucible_axi.py`'s `resolve_next` function body for `sorted(`/`.sort(` calls. That function is deleted from the client entirely (AC10) — the guard has no subject. AC1's equivalent requirement ("no sort, no seq comparison") is independently re-proved against `src/next.ts` by a NEW bun test in the same describe block ("`src/next.ts` contains no comparator…") — not a port of this specific test, a fresh assertion of the same PRINCIPLE against the new location. |
| `SeqlessRowKeepsItsPublishedPositionTest.test_a_row_published_without_seq_keeps_its_published_position` | **ported** | `tests/next-resolver.test.ts` ("an entry published without a seq keeps its PUBLISHED POSITION…") | AC6a, unchanged semantics. |
| `SeqlessRowKeepsItsPublishedPositionTest.test_the_missing_seq_warning_still_fires_and_names_the_cr` | **ported** | Same test as above (combined — both the position AND the warning half are asserted together in one bun test, matching the ORIGINAL cr095 file's own note that the two halves are inseparable: "the WARNING half is unchanged and re-asserted here"). | Same. |

Subtotal: ported 5, retired 1. (6 total.)

## Grand total

| Verdict | Count |
|---|---|
| Ported | 55 |
| Kept | 18 |
| Retired | 18 |
| Unclassifiable | 0 |

## Notes on AC4's `waveCompleted` field and boundary-announcement behaviour

Neither of the two AC2-scoped files exercises `waveCompleted`/the predecessor-
completed announcement — that lives entirely in
`tests/client/test_next_announces_the_wave_boundary.py`, which is NOT named by
AC2 and is therefore outside this classification's scope. AC4 nonetheless
REQUIRES the route to publish `waveCompleted` "when a crossing is proven", so
`tests/next-route.test.ts`/`tests/next-resolver.test.ts` are not exhaustive on
that one field — a small independent gap the RED report calls out (see the
final report's "gaps and escalations" section) rather than silently leaving
unaddressed or over-claiming as a port.

## Files NOT covered by AC2 but touching the same symbols (flagged, not ported)

`tests/client/test_next_announces_the_wave_boundary.py` and
`tests/client/test_next_lane_carries_release_and_wave.py` both call
`AXI.resolve_next`/`AXI.cmd_next` directly and will fail to even IMPORT once
GREEN deletes those symbols (AC10). Neither file is named by AC2, so neither
is classified or edited here — flagged for the GREEN/orchestrator's planning,
not silently left as a surprise (see the RED report).
