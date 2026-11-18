"""RED — CR-CRU-098 C1: AC12 pin — §S4's four classes retire with GREEN C3,
each leaving a comment naming this CR and the reason.

Spec: docs/changes/CR-CRU-098-the-plan-pointer-has-no-publisher.md §S4, AC12
Classification: docs/changes/CR-CRU-098-test-classification.md

Per the dispatch prompt's item 5: "leave the four retired classes in place for
now (GREEN C3 removes them with comments). Write a test asserting their
absence plus the presence of the retirement comment, so it goes red now."

This file therefore asserts the OPPOSITE of today's tree ON PURPOSE — it is
the RED PIN for a LATER cycle (GREEN C3), not this one. It stays red through
GREEN C1/C2 of this same CR and only turns green once §S4's boundary is
actually removed, matching the precedent `tests/project-namespace-tripwire.
test.ts`'s own dated-residue table sets for a deliberately-deferred cleanup.

RETIRED (§S4, tests/client/integration/test_cr092_next_decision_resolver.py):
    TrackCanonicalisationAgreesWithTheServerTest — "the client mirrors the
        server's track rule ... With one side, there is no mirror."
    PublishedTrackFactTest / PublishedTrackFactIsWiredTest — "the track fact
        could be unpublished ... On the server the resolver reads the
        declared tracks directly; the case cannot arise."
    NextBlockCitationsTest — "line citations into the client block."

RETIRED (dispatch prompt item 1, tests/client/test_cr095_next_consumes_
published_order.py — "anything ... that only asserts the client-side
resolve_next shape"):
    PublishedOrderIsConsumedTest.test_resolve_next_no_longer_orders_anything
        — an AST guard on the now-deleted client-side `resolve_next`.

RED expectation: every class/method below is STILL PRESENT today (this CR's
own C1 has not removed anything from either file), so every assertion below
fails by finding the class/method still defined and no retirement comment
naming CR-CRU-098 anywhere in the file.

Invocation:
    python3 -m pytest tests/client/unit/test_cr098_s4_boundary_retirement_pending.py -q
"""

import ast
import unittest
from pathlib import Path

# Imported so the suite's isolation in tests/client/__init__.py applies even when a run
# imports this module top-level (the gate's discovery without -t).
import tests.client  # noqa: F401

REPO_ROOT = Path(__file__).resolve().parents[3]
CR092_PATH = REPO_ROOT / "tests" / "client" / "integration" / "test_cr092_next_decision_resolver.py"
CENSUS_PATH = REPO_ROOT / "tests" / "client" / "integration" / "test_client_fleet_envelope_census.py"

# CR-CRU-098 §S4/AC12, corrected at C3 (spec a018e0f):
# `TrackCanonicalisationAgreesWithTheServerTest` is NOT retired — the client's
# `canonical_track` mirror survives, so its agreement test stays.
RETIRED_CLASSES_CR092 = (
    "PublishedTrackFactTest",
    "PublishedTrackFactIsWiredTest",
    "NextBlockCitationsTest",
)

def _class_names(path: Path) -> set:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return {node.name for node in tree.body if isinstance(node, ast.ClassDef)}


def _names_a_retirement_comment(path: Path) -> bool:
    """A comment naming BOTH this CR and the §S4 reason — the shape
    `test_cr108`'s own deletion note sets (the note just above
    `test_the_server_refuses_exactly_what_the_helper_refuses` in
    test_cr092_next_decision_resolver.py, "was deleted here ... its ... claim
    survives ... below")."""
    text = path.read_text(encoding="utf-8")
    return "CR-CRU-098" in text and (
        "§S4" in text or "retired" in text.lower())


class AC12TheFourRetiredClassesAreGoneTest(unittest.TestCase):
    """AC12 — TrackCanonicalisationAgreesWithTheServerTest, PublishedTrackFactTest,
    PublishedTrackFactIsWiredTest and NextBlockCitationsTest are REMOVED, each
    with a comment naming CR-CRU-098 and §S4's reason where it stood."""

    def test_none_of_the_four_classes_is_still_defined(self):
        present = sorted(name for name in RETIRED_CLASSES_CR092
                         if name in _class_names(CR092_PATH))
        self.assertEqual(
            present, [],
            f"AC12/§S4: these classes must be REMOVED from "
            f"test_cr092_next_decision_resolver.py (GREEN C3), each leaving "
            f"a comment naming this CR: {present!r}")

    def test_a_retirement_comment_naming_this_cr_and_s4_is_present(self):
        self.assertTrue(
            _names_a_retirement_comment(CR092_PATH),
            "AC12: a comment naming this CR and \u00a7S4's reason must stand "
            "where each retired class stood — none found yet")


class AC12CorrectedAtC3Test(unittest.TestCase):
    """AC12 as corrected at C3 (spec a018e0f): the census's
    `Cr108PublishedTrackFactTest` retires under §S4 like `PublishedTrackFactTest`,
    and `TrackCanonicalisationAgreesWithTheServerTest` is KEPT — the client's
    `canonical_track` mirror survives, so its agreement test must too."""

    def test_the_census_published_track_fact_class_is_retired_with_a_comment(self):
        self.assertNotIn("Cr108PublishedTrackFactTest", _class_names(CENSUS_PATH))
        self.assertTrue(
            _names_a_retirement_comment(CENSUS_PATH),
            "AC12: a comment naming this CR and \u00a7S4's reason must stand "
            "where Cr108PublishedTrackFactTest stood")

    def test_the_track_mirror_agreement_test_is_kept(self):
        self.assertIn("TrackCanonicalisationAgreesWithTheServerTest",
                      _class_names(CR092_PATH))


if __name__ == "__main__":
    unittest.main()
