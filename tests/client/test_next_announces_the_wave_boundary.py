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

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(CLIENTS_DIR / "_crucible_axi.py", "next_boundary_axi_under_test")


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
# The vocabulary bounds below never reached the resolver and are untouched.


class DecisionVocabularyIsUnchangedTest(unittest.TestCase):
    """§S2 adds a STATEMENT to the answer, never a fourth reason or a fifth
    trigger kind. Asserted by length AND by value, because a set comparison
    alone survives a new member arriving beside a deleted one. Passes today
    and must keep passing — this is the bound on the change."""

    def test_the_three_drained_reasons_are_still_the_whole_vocabulary(self):
        self.assertEqual(len(AXI.DRAINED_REASONS), 3)
        self.assertEqual(
            AXI.DRAINED_REASONS,
            ("wave-complete", "awaiting-assignment", "no-roadmap"))

    def test_the_four_hold_trigger_kinds_are_still_the_whole_vocabulary(self):
        self.assertEqual(len(AXI.HOLD_TRIGGER_KINDS), 4)
        self.assertEqual(
            AXI.HOLD_TRIGGER_KINDS,
            ("in-flight", "dead-dependency", "dependency",
             "unknown-dependency"))


if __name__ == "__main__":
    unittest.main()
