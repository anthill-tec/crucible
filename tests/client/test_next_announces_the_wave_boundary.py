"""RED — `next` ANNOUNCES the wave boundary it just crossed, and the
announcement expires by itself.

Covers §S2 alone. §S1's flag surface, §S3's lane-vs-wave split and §S4's
envelope are asserted by the sibling suite
(`test_next_lane_carries_release_and_wave.py`) and nothing here re-states them;
the two vocabulary bounds are the deliberate exception, because THIS cycle adds
a statement to the answer and a statement that arrived as a fourth reason or a
fifth trigger kind would be a different change.

WHAT IS DRIVEN. Every behavioural assertion runs the real `cmd_next` over a
real queue payload through the real emitter — the sibling suite's idiom — so an
assertion fails only when the BEHAVIOUR is absent, never because the resolver's
internal parameter names moved.

THE KEY THE ANNOUNCEMENT RIDES, named once here because the spec fixes the FACT
and not its spelling. §S2 says the answer "says so alongside its decision", so
the statement is a FIELD of the answer, not prose in the human line: a reader
parsing the envelope must be able to act on it without reading English. This
file fixes that field as `waveCompleted`, carrying the PREDECESSOR's label
verbatim, and asserts its ABSENCE by key rather than by string search so an
expired announcement cannot hide inside a help step.

THE FIRST WAVE HAS NO PREDECESSOR, and the spec does not say what a crossing
means there. "The predecessor is complete" is read as a claim about a
predecessor that EXISTS: a resolved wave that is first in the published order
has none, so nothing completed and nothing is announced. That reading is
asserted below rather than left implicit — the alternative (announcing over an
empty predecessor) would state a completion no read proves.

FIXTURE IDS carry a namespace no project owns and none matches the tripwire's
CR-literal shape, so no assertion here names a real board row.
"""


# CR-CRU-098 C3 — the eighteen in-process `cmd_next` tests that stood here were
# deleted (docs/changes/CR-CRU-098-test-classification.md), with the fixtures and
# the `cmd_next` harness only they used. The resolver they drove moved to the
# server, and every one is PORTED to tests/next-resolver.test.ts ("waveCompleted:
# the crossing is announced and expires" group, plus one route-level crossing in
# tests/next-route.test.ts):
#   BoundaryAnnouncementTest (3), PredecessorIsThePreviousPublishedLabelTest (2),
#   AnnouncementRidesEveryDecisionTest (2), DrainedHelpCarriesTheNextWaveLabelTest
#   (2), TheFirstWaveHasNoPredecessorTest (1),
#   TheAnnouncementIsScopedToTheContainerAskedAboutTest (2),
#   AskingAboutACompleteWaveTest (2), ABlockedFrontCrHoldsItsOwnWaveTest (2),
#   EmptyDeclaredContainerTest (2).
#
# DecisionVocabularyIsUnchangedTest (2) — RETIRED at CR-CRU-098 C3: it read
# the client copies of `DRAINED_REASONS` / `HOLD_TRIGGER_KINDS`, which nothing
# in `clients/` read any more and which were deleted as a second source of
# truth. The vocabulary lives in `src/next.ts`'s exports, pinned exactly (members
# AND order) by tests/next-resolver.test.ts "the decision vocabulary is exactly
# the four HOLD trigger kinds and the three DRAINED reasons, in their declared
# order (ported from DecisionVocabularyIsUnchangedTest)".
