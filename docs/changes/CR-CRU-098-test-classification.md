# CR-CRU-098 — RED test classification (AC2, expanded 2026-09-24 per `9aeb048`)

Cycle C1, agent `CR-CRU-098-C1-RED`. AC2 now scopes by **what a test reaches**,
not by file name: "every behaviour of every test that reaches an AC10
symbol ... is classified ... into exactly one of ported / kept / retired."

## Census — every test file under `tests/` that reaches an AC10 symbol

AC10's removed-symbol list: `LANDED_STATUSES`, `QueueTrackFactUnpublished`,
`queue_tracks`, `_entry_seq`, `_is_actionable`, `_dead_entries`, `_dead_phrase`,
`_next_start_help`, `_hold_help`, `_drained_help`, `_next_trigger`,
`_lane_fields`, `_announced_fields`, `_next_answer`, `_drained_answer`,
`_wave_of_the_lane`, `_previous_published_wave`, `_next_published_wave`,
`_boundary_announcement`, `resolve_next`, `canonical_track` — plus `cmd_next`
(kept, not removed, but its TRANSPORT contract changes under AC8/AC9, so a
test driving it is equally in scope for classification).

Method: `grep` every AC10 symbol name (dotted-call form AND bare-word form)
across `tests/**/*.py` and `tests/**/*.ts`, then read each hit's surrounding
code to decide REACHES (a real call into the live symbol) vs NAMES (prose,
docstring, or a synthetic fixture string fed to an AST sweep — never executed
against the real symbol).

| File | Symbols matched | Reaches? | Disposition |
|---|---|---|---|
| `tests/client/test_cr092_next_decision_resolver.py` | all of AC10 + `cmd_next` | **Reaches** (85 tests) | Classified below (unchanged from the first RED pass). |
| `tests/client/test_cr095_next_consumes_published_order.py` | `resolve_next` | **Reaches** (6 tests) | Classified below (unchanged). |
| `tests/client/test_next_announces_the_wave_boundary.py` | `cmd_next` | **Reaches** (18 of 20 tests; 2 read `AXI.DRAINED_REASONS`/`AXI.HOLD_TRIGGER_KINDS`, which AC10 does NOT remove) | Classified below (NEW). |
| `tests/client/test_next_lane_carries_release_and_wave.py` | `cmd_next` | **Reaches** (13 of 20 tests reach `cmd_next` in-process; 5 never reach an AC10 symbol at all — argparse-only or subprocess help drives; 1 more, `NextsAnswerIsAPlanTheWriteSideAcceptsTest`, is a black-box subprocess E2E that never calls an AC10 symbol in-process either — see below) | Classified below (NEW). |
| `tests/client/test_plan_file_cycle_flag_help.py` | `_next_start_help` | **Reaches** (2 tests, `NextStartTemplateTeachesTheCanonicalFlagTest`; the rest of the file — `--help`-rendering tests — never touches an AC10 symbol) | Classified below (NEW). |
| `tests/client/test_plan_file_declares_each_cycle_kind.py` | `_next_start_help` | **Reaches** (2 of 3 tests in `SuggestedInvocationTemplatesTeachTheMandatedFormTest`; the third, `test_the_shared_refusal_template_files_a_plan_under_the_mandate`, uses only `AXI.CYCLE_FLAG_TEMPLATE`, not an AC10 symbol) | Classified below (NEW). |
| `tests/client/test_cr054_fleet_inventory.py` | `queue_tracks`, `resolve_next`, `canonical_track`, `cmd_next` | **Never reaches** | `queue_tracks`/`resolve_next` appear ONLY as literal source-text fixture strings (`_CR108_RETIRED_SHAPES`, `_CR108_SURVIVING_SHAPES`, e.g. `"def queue_tracks(entries):\n    return ..."`) fed to `_track_set_computations`, an AST sweep — never a call into the real symbol. `canonical_track` appears only in a comment explaining why the sweep is AST-shaped. `cmd_next` appears only as a STRING inside `CR092_NEXT_VERB_FUNCTIONS = frozenset({"cmd_next"})`, the census constant for "the delegator every client defines" — `cmd_next` itself is not removed by AC10, so this census is unaffected regardless. Not classified; not edited. |
| `tests/client/test_client_tier_surface.py` | `canonical_track` | **Never reaches** | Cited once in a docstring as an ANALOGY ("the pattern is the project's own: `canonical_track` ... mirrors `normalizeTrack`") — pure prose, no call. Not classified; not edited. |
| `tests/next-resolver.test.ts` (mine, this cycle) | all (via `pythonHelp` subprocess + prose) | N/A — my own RED file | Not census target. |
| `tests/project-namespace-tripwire.test.ts` | `resolve_next`, `queue_tracks`, `QueueTrackFactUnpublished` | **Never reaches** | All four hits are prose inside `PROSE_CITATIONS`-adjacent commentary about `clients/_crucible_axi.py` line-shift history — AC14's concern (citation re-pinning at close-out), not AC2's. No call. |
| `tests/queue-canonical-order.test.ts`, `tests/roadmap-wave-rollup.test.ts`, `tests/app-logic.test.ts` | `resolve_next`, `queue_tracks` | **Never reaches** | All prose: design-rationale comments explaining why the board/roadmap UI deliberately does NOT reimplement `resolve_next` in JS. No call. |

No other file under `tests/` matched any AC10 symbol name (bare-word grep,
case-sensitive, across `*.py` and `*.ts`).

## Legend

- **ported** → a bun test of the pure server function (`tests/next-resolver.test.ts`)
  or the route (`tests/next-route.test.ts`).
- **kept** → a Python verb test, adapted to the new transport/mechanism where
  needed (`tests/client/test_cr098_next_verb_reads_the_route.py`,
  `tests/client/test_cr098_resolver_lands_on_the_server.py`,
  `tests/client/test_cr098_next_start_template_survives_the_move.py`), or
  unaffected and left exactly as-is (no new file — nothing changed for it).
- **retired** → exactly §S4's four classes, plus the one cr095 method that
  only asserts the now-deleted client-side `resolve_next`'s shape. Pinned red
  by `tests/client/test_cr098_s4_boundary_retirement_pending.py`.
- **out of AC2 scope** → the test never reaches an AC10 symbol at all (a
  different verb's flag surface, a subprocess `--help` drive, a black-box E2E
  through the compiled client). Not classified, not edited, not ported.

## tests/client/test_cr092_next_decision_resolver.py (85 tests) — unchanged from the first RED pass

| Class | Tests | Verdict | Where it lands |
|---|---|---|---|
| `CanonicalTrackTest` | 3 | ported | `tests/next-resolver.test.ts` |
| `TrackCanonicalisationAgreesWithTheServerTest` | 5 | retired (§S4) | — |
| `TrackScopingTest` | 9 | ported | `tests/next-resolver.test.ts` |
| `NextDecisionTest` | 7 | ported | `tests/next-resolver.test.ts` |
| `HoldDecisionTest` | 18 | ported | `tests/next-resolver.test.ts` |
| `DrainedDecisionTest` | 11 | ported | `tests/next-resolver.test.ts` |
| `NextVerbEnvelopeTest` | 15 | kept (adapted, AC8/AC9) | `tests/client/test_cr098_next_verb_reads_the_route.py` |
| `LaneOrderTest` | 2 | ported | `tests/next-resolver.test.ts` |
| `HarnessIsolationTest` | 1 | kept, unaffected | unedited |
| `ResolverLandsOnceTest` | 2 | kept (rewritten, AC10/AC11) | `tests/client/test_cr098_resolver_lands_on_the_server.py` |
| `NextBlockCitationsTest` | 2 | retired (§S4) | — |
| `PublishedTrackFactTest` | 9 | retired (§S4) | — |
| `PublishedTrackFactIsWiredTest` | 1 | retired (§S4) | — |

Subtotal: ported 50, kept 18, retired 17.

## tests/client/test_cr095_next_consumes_published_order.py (6 tests) — unchanged

| Class.method | Verdict | Where it lands |
|---|---|---|
| `PublishedOrderIsConsumedTest.test_the_live_boards_canonical_payload_answers_a_020_cr_not_cru_015` | ported | `tests/next-resolver.test.ts` |
| `PublishedOrderIsConsumedTest.test_the_lane_is_taken_in_published_position_not_seq_value_order` | ported | `tests/next-resolver.test.ts` |
| `PublishedOrderIsConsumedTest.test_a_non_actionable_row_is_skipped_without_reordering_the_lane` | ported | `tests/next-resolver.test.ts` |
| `PublishedOrderIsConsumedTest.test_resolve_next_no_longer_orders_anything` | retired | — (AC1's no-sort principle is independently re-proved against `src/next.ts` by a new bun test in the same file) |
| `SeqlessRowKeepsItsPublishedPositionTest.test_a_row_published_without_seq_keeps_its_published_position` | ported | `tests/next-resolver.test.ts` |
| `SeqlessRowKeepsItsPublishedPositionTest.test_the_missing_seq_warning_still_fires_and_names_the_cr` | ported | `tests/next-resolver.test.ts` (combined with the position test, as the original file's own note says the two halves are inseparable) |

Subtotal: ported 5, retired 1.

## tests/client/test_next_announces_the_wave_boundary.py (20 tests) — NEW

| Class | Tests | Verdict | Where it lands |
|---|---|---|---|
| `BoundaryAnnouncementTest` | 3 | ported | `tests/next-resolver.test.ts` §S2/AC4 waveCompleted group |
| `PredecessorIsThePreviousPublishedLabelTest` | 2 | ported | same |
| `AnnouncementRidesEveryDecisionTest` | 2 | ported | same |
| `DrainedHelpCarriesTheNextWaveLabelTest` | 2 | ported | same |
| `TheFirstWaveHasNoPredecessorTest` | 1 | ported | same |
| `TheAnnouncementIsScopedToTheContainerAskedAboutTest` | 2 | ported | same |
| `AskingAboutACompleteWaveTest` | 2 | ported | same |
| `ABlockedFrontCrHoldsItsOwnWaveTest` | 2 | ported | same |
| `EmptyDeclaredContainerTest` | 2 | ported | same |
| `DecisionVocabularyIsUnchangedTest` | 2 | **out of AC2 scope** | reads `AXI.DRAINED_REASONS`/`AXI.HOLD_TRIGGER_KINDS` only — AC10 does not remove either constant, so this class never reaches a removed symbol. Not edited. |

Subtotal: ported 18, out of scope 2. This closes RED report finding 4 —
`waveCompleted` is now covered by `tests/next-resolver.test.ts` (pure
function) and `tests/next-route.test.ts` (route-level, one representative
crossing test).

## tests/client/test_next_lane_carries_release_and_wave.py (20 tests) — NEW

| Class | Tests | Verdict | Where it lands |
|---|---|---|---|
| `NextFlagSurfaceTest` | 3 | out of AC2 scope | argparse-only (`add_next_verb`'s own subparser); never calls `cmd_next`/`resolve_next`. |
| `FleetNextFlagSurfaceTest` | 1 | out of AC2 scope | drives `next --help` as a subprocess; help never reaches the wire, never calls an AC10 symbol in-process. |
| `WavePredicateIgnoresTrackTest` | 1 | ported | `tests/next-resolver.test.ts` §S1/AC1/AC4/AC6 lane-details group |
| `LaneFlagsNarrowTheAnswerTest` | 2 | ported | same |
| `LaneFlagsAreNotCoercedTest` | 2 | ported | same |
| `DuplicateSeqWithinAWaveTest` | 1 | ported | same |
| `DrainedLaneIsNotACompleteWaveTest` | 2 | ported | same |
| `EnvelopeNamesTheResolvedContainerTest` | 4 | ported | same |
| `LegacyLineStatesTheWaveTest` | 1 | kept | `tests/client/test_cr098_next_verb_reads_the_route.py` (`_next_legacy_line` stays client-side, §S3) |
| `BothNewDimensionsRideTheOneReadTest` | 1 | kept (adapted, AC8) | `tests/client/test_cr098_next_verb_reads_the_route.py` |
| `WavelessEntryNeverResolvesTheWaveTest` | 1 | ported | `tests/next-resolver.test.ts` |
| `NextsAnswerIsAPlanTheWriteSideAcceptsTest` | 1 | out of AC2 scope | black-box E2E: spawns a real server AND drives the compiled `bun-crucible.py` CLIENT as a subprocess (never an in-process call to `cmd_next`/`resolve_next`). Observably behaviour-only, so it is robust to the internal refactor by construction and needs no change. |

Subtotal: ported 13, kept 2, out of scope 5.

## tests/client/test_plan_file_cycle_flag_help.py (2 of its tests) — NEW

| Class.method | Verdict | Where it lands |
|---|---|---|
| `NextStartTemplateTeachesTheCanonicalFlagTest.test_the_start_template_hands_back_the_repeatable_flag_and_no_comma_split_one` | ported | `tests/next-resolver.test.ts` AC5 group, strengthened with an explicit `--cycle`/no-`--cycles` assertion |
| `NextStartTemplateTeachesTheCanonicalFlagTest.test_the_start_template_shows_the_flag_repeated_with_its_own_label` | ported | same (repeated 2-3 times) |

The rest of the file (`RepeatableFlagOutranksTheLegacyOneInHelpTest` and
similar — CR-107's `plan-file --help` rendering) never touches an AC10 symbol
and is unaffected.

## tests/client/test_plan_file_declares_each_cycle_kind.py (2 of its tests) — NEW

| Class.method | Verdict | Where it lands |
|---|---|---|
| `SuggestedInvocationTemplatesTeachTheMandatedFormTest.test_the_next_start_template_files_a_plan_under_the_mandate` | kept (adapted) | `tests/client/test_cr098_next_start_template_survives_the_move.py` |
| `SuggestedInvocationTemplatesTeachTheMandatedFormTest.test_both_templates_teach_the_same_form` | kept (adapted) | same |

`.test_the_shared_refusal_template_files_a_plan_under_the_mandate` (the same
class's third test) uses only `AXI.CYCLE_FLAG_TEMPLATE`, never an AC10 symbol
— out of AC2 scope, unedited. The adapted file sources the START template from
a LOCAL literal reconstruction (documented as matching `_next_start_help`'s
current output) instead of calling the function AC10 deletes; one of its three
tests is a REGRESSION PIN cross-checking that reconstruction against today's
real `_next_start_help` output — GREEN must delete that ONE test (not the
file) when the function is removed, since its own subject disappears. The
other two survive unedited.

## Grand total (this file + the first RED pass, combined)

| Verdict | Count |
|---|---|
| Ported | 55 (pass 1) + 18 + 13 + 2 = **88** |
| Kept | 18 (pass 1) + 2 + 2 + 2 = **24** |
| Retired | 18 (unchanged) |
| Out of AC2 scope (never reaches an AC10 symbol) | 2 + 5 = **7** |

130 tests examined across 7 files that matched an AC10 symbol by name; 123 of
them actually reach one and are classified ported/kept/retired above; 7 do
not and are explicitly left alone. Plus the two files scanned and found to
reach NOTHING (`test_cr054_fleet_inventory.py`'s synthetic fixtures,
`test_client_tier_surface.py`'s prose citation) and the four files whose only
hits are prose/citation commentary — all recorded in the census table, none
requiring action this cycle.

## RED report finding 4 — closed

AC4's `waveCompleted` field is now covered: `tests/next-resolver.test.ts`
carries the full pure-function port of `test_next_announces_the_wave_
boundary.py`'s 18 in-scope tests, and `tests/next-route.test.ts` adds one
route-level crossing test proving the field survives the HTTP boundary.

## RED report finding 3 — closed

`tests/client/test_cr098_next_verb_reads_the_route.py`'s AC8 assertions now
parse the request (`urlsplit` + `parse_qsl`) and compare the BASE PATH and the
PARAMS AS A DICT, never a literal ordered query string. See
`assertNextRequest` and the module docstring's "QUERY-STRING SHAPE" section.

## RED report finding 1 — no action

The user's ruling stands: bun baseline is 2663/0 at `7f2a85c`, measured
2026-09-24 15:51. VERIFY re-measures.

## Deliberately-passing tests in this RED submission (precedented, not vacuous)

Four tests across the whole submission pass immediately, by design, matching
the CR-092 suite's own precedent for fixture/invariant guards that "prove
facts about the FIXTURES and the tree" rather than about the not-yet-built
SUT:

- `tests/next-route.test.ts`: `SCHEMA_VERSION` pin (AC3 — no migration).
- `tests/client/test_cr098_next_start_template_survives_the_move.py`: all
  three tests — the DRIVE-through-`plan-file` behaviour they assert is
  genuinely UNCHANGED by this CR (Non-goals: "changing what the pointer
  says"); only the MECHANISM of sourcing the template string changes, which
  is exactly the kind of migration Mode 2 (fix broken test compilation)
  describes. One of the three (`test_the_reconstruction_matches_next_start_
  help_today`) is explicitly flagged for deletion by GREEN once its own
  subject (`_next_start_help`) is removed.

Every other new/adapted test in this submission fails now for the reason
stated in the RED report.
