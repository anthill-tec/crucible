"""A pytest run whose subtests passed says they went uncounted.

pytest runs `unittest.subTest` blocks and its own native `subtests` fixture.
A failing subtest is written as a failure on its parent test case, but a
passing one is not written as a test case at all -- so the run's counts
cannot hold it. On a project that declares `[python] runner = "pytest"`, a
run whose output reports passing subtests carries ONE `subtests-uncounted`
warning whose detail names pytest and says passing subtests are not counted;
a run without subtests carries none.

Every run drives the REAL `clients/python-crucible.py` as an OS subprocess on
a scratch copy of `tests/fixtures/pytest-project` with this suite's own
interpreter (which has pytest), filing to a recording board named by the
scratch project's own `crucible.toml`. Each run is driven ONCE per class.

Invocation:
    python3 -m unittest tests.client.test_a_pytest_run_discloses_its_uncounted_subtests -v
"""

import re
import unittest

from tests.client.pytest_project_harness import (
    AGENT,
    ScratchProject,
    counts,
    diag,
    envelope,
    require_pytest_and_coverage,
)

SUBTESTS_UNCOUNTED = "subtests-uncounted"

# A unittest test case with three passing `subTest` blocks.
_UNITTEST_SUBTESTS = '''"""A unittest test with three passing subTest blocks."""

import unittest

class UnittestSubTests(unittest.TestCase):

    def test_three_passing_subtests(self):
        for i in range(3):
            with self.subTest(i=i):
                self.assertLess(i, 3)
'''

# A pytest test with three passing blocks of the native `subtests` fixture.
_NATIVE_SUBTESTS = '''"""A pytest test with three passing native subtests."""

def test_three_passing_native_subtests(subtests):
    for i in range(3):
        with subtests.test(msg="native", i=i):
            assert i < 3
'''

class _OneRunOnAPytestProject(unittest.TestCase):
    """Drive `test` once on a pytest-declared scratch project."""

    ARGV: tuple[str, ...] = ("test", "--agent", AGENT)
    EXTRA_FILES: tuple[tuple[str, str], ...] = ()

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject(f"pyrun-subtests-{cls.__name__}-")
        cls.project.declare("pytest")
        for rel, text in cls.EXTRA_FILES:
            cls.project.write(rel, text)
        cls.result = cls.project.drive(list(cls.ARGV))
        cls.axi = envelope(cls.result.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def uncounted_warnings(self):
        if self.axi is None:
            self.fail(f"stdout must be one AXI envelope; {diag(self.result)}")
        return [w for w in self.axi.get("warnings") or []
                if isinstance(w, dict) and w.get("code") == SUBTESTS_UNCOUNTED]

class _ARunWithPassingSubtests(_OneRunOnAPytestProject):
    """One test whose three subtests all pass: the run files that one test,
    and discloses that its passing subtests were not counted."""

    def test_the_run_files_the_one_parent_test(self):
        ingests = self.project.parsed_ingests()
        self.assertEqual(len(ingests), 1, diag(self.result))
        self.assertEqual(counts(ingests[0]),
                         {"total": 1, "passed": 1, "failed": 0, "pending": 0},
                         f"the scratch run must file its one parent test; "
                         f"{diag(self.result)}")

    def test_the_envelope_carries_one_subtests_uncounted_warning(self):
        self.assertEqual(len(self.uncounted_warnings()), 1,
                         f"a run whose subtests passed carries exactly one "
                         f"{SUBTESTS_UNCOUNTED} warning; {diag(self.result)}")

    def test_the_detail_names_pytest_and_says_passing_subtests_are_not_counted(self):
        found = self.uncounted_warnings()
        self.assertEqual(len(found), 1, diag(self.result))
        detail = found[0].get("detail")
        if not isinstance(detail, str):
            self.fail(f"the warning's detail must be a string; warning={found[0]!r}")
        self.assertIn("pytest", detail, f"the detail names pytest; detail={detail!r}")
        self.assertRegex(detail, re.compile(r"passing subtests.*not counted", re.IGNORECASE),
                         f"the detail says passing subtests are not counted; "
                         f"detail={detail!r}")
        self.assertNotIn("xmlrunner", detail,
                         f"the detail is pytest's, not the xmlrunner fallback's; "
                         f"detail={detail!r}")

class AUnittestSubTestRunCarriesTheWarningTest(_ARunWithPassingSubtests):
    ARGV = ("test", "--agent", AGENT, "--tests", "check_unittest_subtests.py")
    EXTRA_FILES = (("check_unittest_subtests.py", _UNITTEST_SUBTESTS),)

class ANativeSubtestsRunCarriesTheWarningTest(_ARunWithPassingSubtests):
    ARGV = ("test", "--agent", AGENT, "--tests", "check_native_subtests.py")
    EXTRA_FILES = (("check_native_subtests.py", _NATIVE_SUBTESTS),)

class ARunWithoutSubtestsCarriesNoWarningTest(_OneRunOnAPytestProject):
    """The plain fixture (one pass, one fail, one skip) has no subtests."""

    def test_the_run_files_the_fixtures_three_tests(self):
        ingests = self.project.parsed_ingests()
        self.assertEqual(len(ingests), 1, diag(self.result))
        self.assertEqual(counts(ingests[0])["total"], 3, diag(self.result))

    def test_the_envelope_carries_no_subtests_uncounted_warning(self):
        self.assertEqual(self.uncounted_warnings(), [],
                         f"a run without subtests carries no {SUBTESTS_UNCOUNTED} "
                         f"warning; {diag(self.result)}")

# The shared bases drive no run of their own: out of the module's namespace,
# so unittest's loader collects only the concrete classes above.
del _OneRunOnAPytestProject, _ARunWithPassingSubtests

if __name__ == "__main__":
    unittest.main()
