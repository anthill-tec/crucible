"""A finished pytest run's outcome, the passing-subtest watch and a labelled
key's tier are each read once, in the code every client shares.

The run module (`clients/_crucible_run.py`, loaded and re-exported by the core
`clients/_crucible_axi.py`) holds:

  * `pytest_run_outcome(returncode, reports_dir)` -- the decision a client
    acts on once pytest has finished, one of three module constants:
      - `PYTEST_OUTCOME_FILE` (`"file"`): a JUnit report (`TEST-*.xml`) was
        produced, pytest did not fail as a runner, and the run ran something
        (`ran_nothing` over the report's case count is false);
      - `PYTEST_OUTCOME_RAN_NOTHING` (`"ran-nothing"`): a report was produced,
        pytest did not fail as a runner, the report holds no test case,
        `ran_nothing` says so, and no hermetic leak is pending -- with a leak
        pending the run is filed instead;
      - `PYTEST_OUTCOME_NO_RESULT` (`"no-result"`): pytest failed as a runner
        (exits 3 and 4), whatever JUnit it left, or no report was produced.
  * `PytestSubtestWatch(narrator=None)` -- passes every line it observes to
    the narrator (when there is one) and, once pytest reported a passing
    subtest, answers one `subtests-uncounted` warning carrying
    `PYTEST_SUBTESTS_UNCOUNTED_DETAIL`.

The core's `DeclaredTierSurface` takes an optional `labelled` field (default
False). `declared_target_tier` reads a labelled surface's `<tier>/<label>` key
as the part before the first `/` of what the template matched, so the gate's
declared suites put a labelled `e2e` entry under `e2e` and exclude it like
`e2e`. An unlabelled surface -- every shipped client's -- reads as before.

Everything here is in-process: JUnit reports are written into a temp dir the
test removes, and the hermetic leak a test needs is noted on the core's own
hermetic state and forgotten again when the test ends.

Invocation:
    .venv/bin/python clients/python-crucible.py test \\
        --tests tests.client.unit.test_the_pytest_outcome_subtest_watch_and_labelled_tier_are_shared
"""

import os
import shutil
import tempfile
import unittest

from tests.client import load_client

# The shipped clients whose tier declaration surface predates labelled keys.
UNLABELLED_CLIENTS = (
    "arduino-crucible.py",
    "bun-crucible.py",
    "go-crucible.py",
    "mvn-crucible.py",
    "python-crucible.py",
    "rust-crucible.py",
)

# A tripwire hit as the hermetic wrap records one (any endpoint and port).
A_LEAK = {"endpoint": "203.0.113.7", "port": 5432}

_JUNIT_WITH_CASES = """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="2" failures="1">
<testcase classname="tests.test_alpha" name="test_one" file="tests/test_alpha.py"/>
<testcase classname="tests.test_alpha" name="test_two" file="tests/test_alpha.py">
<failure message="assert 1 == 2">assert 1 == 2</failure></testcase>
</testsuite></testsuites>
"""

_JUNIT_WITHOUT_CASES = """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="0"/></testsuites>
"""

_PASSING_SUBTEST_LINE = ("tests/test_alpha.py::test_sub [case=1] SUBPASSED"
                         "                                [ 50%]\n")
_PASSING_SUBTESTS_SUMMARY = "=========== 1 passed, 2 subtests passed in 0.03s ===========\n"

_LOADED = {}


def _core():
    """The core every client loads, loaded once for the whole file."""
    if "core" not in _LOADED:
        _LOADED["core"] = load_client("_crucible_axi.py")
    return _LOADED["core"]


def _run_module():
    """The run module the core loaded."""
    return _core()._RUN


class _SharedNameTest(unittest.TestCase):

    def shared(self, name):
        """The run module's `name`, failing this test alone when it is absent."""
        run_module = _run_module()
        if not hasattr(run_module, name):
            self.fail(f"the shared run module does not define {name}")
        return getattr(run_module, name)


# ── the outcome of a finished pytest run ────────────────────────────────────

class ThePytestOutcomesAreThreeNamedConstantsTest(_SharedNameTest):

    def test_the_three_outcomes_are_file_ran_nothing_and_no_result(self):
        self.assertEqual(
            (self.shared("PYTEST_OUTCOME_FILE"),
             self.shared("PYTEST_OUTCOME_RAN_NOTHING"),
             self.shared("PYTEST_OUTCOME_NO_RESULT")),
            ("file", "ran-nothing", "no-result"))

    def test_the_outcome_and_the_watch_are_the_run_modules_own_objects_on_the_core(self):
        names = ("pytest_run_outcome", "PytestSubtestWatch", "PYTEST_OUTCOME_FILE",
                 "PYTEST_OUTCOME_RAN_NOTHING", "PYTEST_OUTCOME_NO_RESULT")
        run_module = _run_module()
        missing = [name for name in names if not hasattr(run_module, name)]
        self.assertEqual(missing, [], "each is a top-level name of the run module")
        not_shared = [name for name in names
                      if getattr(_core(), name, None) is not getattr(run_module, name)]
        self.assertEqual(not_shared, [], "the core re-exports the run module's own object")


class _OutcomeTest(_SharedNameTest):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="pytest-outcome-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.reports_dir = os.path.join(self.root, "reports")
        os.makedirs(self.reports_dir)
        core = _core()
        self.assertEqual(core.pending_hermetic_run_leaks(), [],
                         "no test starts with a hermetic leak pending")
        self.addCleanup(core.forget_hermetic_leaks)
        self.FILE = self.shared("PYTEST_OUTCOME_FILE")
        self.RAN_NOTHING = self.shared("PYTEST_OUTCOME_RAN_NOTHING")
        self.NO_RESULT = self.shared("PYTEST_OUTCOME_NO_RESULT")

    def write_report(self, text, name="TEST-pytest.xml"):
        with open(os.path.join(self.reports_dir, name), "w", encoding="utf-8") as handle:
            handle.write(text)

    def pend_a_leak(self):
        """A hermetic leak pending on the core's own state, forgotten in cleanup."""
        _core().note_hermetic_leaks([dict(A_LEAK)])
        self.assertEqual(_core().pending_hermetic_run_leaks(), [A_LEAK])

    def outcome(self, returncode, reports_dir=None):
        pytest_run_outcome = self.shared("pytest_run_outcome")
        return pytest_run_outcome(returncode,
                                  self.reports_dir if reports_dir is None else reports_dir)


class APytestRunThatRanSomethingIsFiledTest(_OutcomeTest):

    def test_exits_zero_one_and_two_with_a_report_holding_cases_are_filed(self):
        self.write_report(_JUNIT_WITH_CASES)
        answers = {code: self.outcome(code) for code in (0, 1, 2)}
        self.assertEqual(answers, {0: "file", 1: "file", 2: "file"})

    def test_an_exit_zero_with_a_report_holding_no_case_is_filed_not_ran_nothing(self):
        # `ran_nothing` reads only a non-zero exit with zero results as
        # running nothing; an exit 0 with an empty report is filed as before.
        self.write_report(_JUNIT_WITHOUT_CASES)
        self.assertEqual(self.outcome(0), self.FILE)

    def test_a_report_whose_cases_cannot_be_counted_is_filed_as_it_stands(self):
        # An unparseable report has an unknown count, so nothing claims it
        # ran nothing: it goes to the board, whose decoder names the fault.
        self.write_report("<testsuite><testcase")
        self.assertEqual(self.outcome(1), self.FILE)


class APytestRunThatRanNothingIsAbortedTest(_OutcomeTest):

    def test_an_exit_five_with_a_report_holding_no_case_ran_nothing(self):
        self.write_report(_JUNIT_WITHOUT_CASES)
        self.assertEqual(self.outcome(5), "ran-nothing")

    def test_an_exit_one_with_a_report_holding_no_case_ran_nothing(self):
        self.write_report(_JUNIT_WITHOUT_CASES)
        self.assertEqual(self.outcome(1), self.RAN_NOTHING)

    def test_an_exit_five_with_no_case_is_filed_while_a_hermetic_leak_is_pending(self):
        self.write_report(_JUNIT_WITHOUT_CASES)
        self.pend_a_leak()
        self.assertEqual(self.outcome(5), self.FILE)
        self.assertEqual(_core().pending_hermetic_run_leaks(), [A_LEAK],
                         "reading the outcome leaves the leak for the filing to take")

    def test_the_same_run_ran_nothing_again_once_the_leak_is_forgotten(self):
        self.write_report(_JUNIT_WITHOUT_CASES)
        self.pend_a_leak()
        self.assertEqual(self.outcome(5), self.FILE)
        _core().forget_hermetic_leaks()
        self.assertEqual(self.outcome(5), self.RAN_NOTHING)


class APytestRunWithNoResultIsAnsweredNoResultTest(_OutcomeTest):

    def test_exits_three_and_four_with_a_report_holding_cases_have_no_result(self):
        self.write_report(_JUNIT_WITH_CASES)
        answers = {code: self.outcome(code) for code in (3, 4)}
        self.assertEqual(answers, {3: "no-result", 4: "no-result"})

    def test_an_exit_four_with_a_report_holding_no_case_has_no_result_not_ran_nothing(self):
        self.write_report(_JUNIT_WITHOUT_CASES)
        self.assertEqual(self.outcome(4), self.NO_RESULT)

    def test_a_runner_failure_has_no_result_even_while_a_hermetic_leak_is_pending(self):
        # The caller's own leak check comes after this answer, not inside it.
        self.write_report(_JUNIT_WITH_CASES)
        self.pend_a_leak()
        self.assertEqual(self.outcome(3), self.NO_RESULT)

    def test_any_exit_with_no_report_has_no_result(self):
        answers = {code: self.outcome(code) for code in (0, 1, 2, 3, 4, 5, -15, -9)}
        self.assertEqual(answers, dict.fromkeys((0, 1, 2, 3, 4, 5, -15, -9), "no-result"))

    def test_a_reports_dir_holding_only_other_files_has_no_result(self):
        self.write_report(_JUNIT_WITH_CASES, name="pytest-junit.xml")
        self.write_report("not a report", name="coverage.xml")
        self.assertEqual(self.outcome(1), self.NO_RESULT)

    def test_a_reports_dir_that_does_not_exist_has_no_result(self):
        missing = os.path.join(self.root, "never-made")
        self.assertEqual(self.outcome(0, missing), self.NO_RESULT)
        self.assertFalse(os.path.exists(missing), "reading the outcome creates nothing")


# ── the passing-subtest watch ───────────────────────────────────────────────

class _RecordingNarrator:
    """A narrator that records every line it is given, in order."""

    def __init__(self):
        self.lines = []

    def observe(self, line):
        self.lines.append(line)


class ThePassingSubtestWatchTest(_SharedNameTest):

    def watch(self, narrator=None):
        watch_class = self.shared("PytestSubtestWatch")
        return watch_class() if narrator is None else watch_class(narrator=narrator)

    def expected_warning(self):
        return [{"code": "subtests-uncounted",
                 "detail": self.shared("PYTEST_SUBTESTS_UNCOUNTED_DETAIL")}]

    def test_a_watch_with_no_narrator_observes_and_warns_on_a_passing_subtest(self):
        watch = self.watch()
        self.assertEqual(watch.warnings(), [])
        watch.observe(_PASSING_SUBTEST_LINE)
        self.assertEqual(watch.warnings(), self.expected_warning())

    def test_output_with_no_passing_subtest_gives_no_warning(self):
        narrator = _RecordingNarrator()
        watch = self.watch(narrator)
        lines = ["collecting ... collected 2 items\n",
                 "tests/test_alpha.py::test_one PASSED                         [ 50%]\n",
                 "tests/test_alpha.py::test_sub [case=1] SUBFAILED              [ 75%]\n",
                 "tests/test_alpha.py::test_two FAILED                         [100%]\n",
                 "======= 1 failed, 1 passed, 0 subtests passed in 0.02s =======\n"]
        for line in lines:
            watch.observe(line)
        self.assertEqual(watch.warnings(), [])
        self.assertEqual(narrator.lines, lines)

    def test_two_passing_subtest_lines_give_exactly_one_warning_with_the_shared_detail(self):
        watch = self.watch(_RecordingNarrator())
        watch.observe(_PASSING_SUBTEST_LINE)
        watch.observe(_PASSING_SUBTESTS_SUMMARY)
        self.assertEqual(watch.warnings(), self.expected_warning())
        self.assertEqual(watch.warnings(), self.expected_warning(),
                         "asking again gives the same single warning")

    def test_the_narrator_receives_every_line_in_order_before_and_after_a_passing_subtest(self):
        narrator = _RecordingNarrator()
        watch = self.watch(narrator)
        lines = ["collecting ... collected 1 item\n",
                 _PASSING_SUBTEST_LINE,
                 "tests/test_alpha.py::test_sub PASSED                         [100%]\n",
                 _PASSING_SUBTESTS_SUMMARY]
        for line in lines:
            watch.observe(line)
        self.assertEqual(narrator.lines, lines)
        self.assertEqual(watch.warnings(), self.expected_warning())

    def test_a_watch_that_saw_nothing_warns_nothing(self):
        self.assertEqual(self.watch(_RecordingNarrator()).warnings(), [])


# ── a labelled key's tier ───────────────────────────────────────────────────

def _never_read(_args, _target):
    return None


def _never_run(_args, _tier, _declared):
    return 0


def _surface(target="<tier>", suites=None, **labelled):
    return _core().DeclaredTierSurface(
        target=target, names="a test entry `<target>`",
        read=_never_read, run=_never_run, suites=suites, **labelled)


class ALabelledKeysTierIsItsFirstSegmentTest(unittest.TestCase):

    def test_a_labelled_surface_reads_the_tier_before_the_first_slash(self):
        surface = _surface(labelled=True)
        tier_of = _core().declared_target_tier
        self.assertIs(surface.labelled, True)
        self.assertEqual(
            {name: tier_of(surface, name)
             for name in ("e2e/bench", "unit", "integration/net", "e2e/bench/rig")},
            {"e2e/bench": "e2e", "unit": "unit", "integration/net": "integration",
             "e2e/bench/rig": "e2e"})

    def test_a_labelled_surface_reads_the_first_segment_of_what_its_template_matched(self):
        surface = _surface(target="test:<tier>", labelled=True)
        tier_of = _core().declared_target_tier
        self.assertEqual(tier_of(surface, "test:e2e/bench"), "e2e")
        self.assertEqual(tier_of(surface, "test:unit"), "unit")
        self.assertIsNone(tier_of(surface, "lint"),
                          "a name its template does not fit names no tier")

    def test_a_default_surface_is_unlabelled_and_reads_the_whole_slot(self):
        surface = _surface()
        tier_of = _core().declared_target_tier
        self.assertIs(surface.labelled, False)
        self.assertEqual(
            {name: tier_of(surface, name)
             for name in ("e2e/bench", "unit", "integration/net")},
            {"e2e/bench": "e2e/bench", "unit": "unit",
             "integration/net": "integration/net"})

    def test_every_shipped_clients_surface_stays_unlabelled_and_reads_as_before(self):
        core_names = {}
        for client in UNLABELLED_CLIENTS:
            module = load_client(client)
            surface = module._TIER_DECLARATION_SURFACE
            labelled_entry = module._axi().declared_target_name(surface, "e2e") + "/bench"
            core_names[client] = (surface.labelled,
                                  module._axi().declared_target_tier(surface, labelled_entry))
        self.assertEqual(core_names,
                         dict.fromkeys(UNLABELLED_CLIENTS, (False, "e2e/bench")))


class ALabelledE2eEntryIsExcludedFromTheGateLikeE2eTest(unittest.TestCase):

    DECLARED = (("unit", None), ("e2e/bench", None), ("integration/net", None))

    def declared(self, **labelled):
        surface = _surface(suites=lambda _args, _surface: self.DECLARED, **labelled)
        return _core().declared_gate_suites(object(), surface, "eda")

    def test_a_labelled_surfaces_suites_take_their_tier_from_the_first_segment(self):
        core = _core()
        self.assertEqual(
            list(self.declared(labelled=True)),
            [core.GateSuite(target="unit", stack="eda", tier="unit", command=None,
                            gated=True, excluded=None),
             core.GateSuite(target="e2e/bench", stack="eda", tier="e2e", command=None,
                            gated=False, excluded=core.GATE_UNCOVERED_TIERS["e2e"]),
             core.GateSuite(target="integration/net", stack="eda", tier="integration",
                            command=None, gated=True, excluded=None)])

    def test_an_unlabelled_surface_reads_a_slashed_name_as_no_tier_as_before(self):
        core = _core()
        suites = self.declared(labelled=False)
        self.assertEqual(
            [(suite.target, suite.tier, suite.gated) for suite in suites],
            [("unit", "unit", True), ("e2e/bench", None, True),
             ("integration/net", None, True)])
        self.assertNotIn(core.GATE_UNCOVERED_TIERS["e2e"],
                         [suite.excluded for suite in suites])


if __name__ == "__main__":
    unittest.main()
