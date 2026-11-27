"""The python client's pytest path lives once, in the shared run module.

`clients/_crucible_run.py` (the run pipeline the core `clients/_crucible_axi.py`
loads and re-exports, so a client reaches each name as `_axi().<name>`)
holds every pytest-specific piece of a run, public and defined once:

  * `JUNIT_REPORT_GLOB` (`"TEST-*.xml"`) and `PYTEST_JUNIT_FILE`
    (`"TEST-pytest.xml"`);
  * `pytest_command(python, reports_dir, selection, *, pattern=None)` — the
    interpreter running pytest verbosely, writing one xunit1 JUnit report
    whose suite is named `pytest` into the reports dir, then
    `-o python_files=<pattern>` when a pattern is given, then the selection
    (node ids, or a start dir, or nothing);
  * `PytestProgress` — reads the selected total off the line that ends
    collection and recognises one verdict line per finished test;
  * `pytest_reports_passing_subtest(line)` and
    `PYTEST_SUBTESTS_UNCOUNTED_DETAIL` — the sign that a passing subtest went
    uncounted in pytest's JUnit, and the warning detail that says so;
  * `PYTEST_RUNNER_FAILURES` (exits 3 and 4) and
    `pytest_failed_as_runner(returncode)` — read from the exit alone;
  * `pytest_error_line(output)` — pytest's last own error line, or `None`;
  * `PYTEST_PROBE_TIMEOUT_S` and `pytest_importable(python, cwd)` — the
    import probe (its three answers spawn interpreters, so they are proved by
    the integration tier, not here);
  * `junit_report_paths`, `produced_junit`, `wipe_junit_reports` — the JUnit
    reports a run reads, whether there are any, and the stale-report wipe;
  * `PYTEST_NO_REPORT_TEXT` and `pytest_no_report_subject(verb)` — the
    no-report wording.

Each lifted piece behaves exactly as the python client's own copy did; the
expected values below are today's, pinned as literals. The python client's
pytest argv (`_suite_cmd`) is pinned as well, so the lift cannot move it.

The run module is reached the way the existing shared-module tests reach it:
the python client's core (`_axi()`), whose `ingest_reports.__globals__` is the
run module's namespace. Each test reads its name inside the test, so a name
not yet lifted fails that test alone.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_the_pytest_path_lives_in_the_run_module
"""

import os
import shutil
import tempfile
import unittest
from unittest import mock

from tests.client.live_run_harness import load_client

SHARED_NAMES = (
    "JUNIT_REPORT_GLOB",
    "PYTEST_JUNIT_FILE",
    "pytest_command",
    "PytestProgress",
    "pytest_reports_passing_subtest",
    "PYTEST_SUBTESTS_UNCOUNTED_DETAIL",
    "PYTEST_RUNNER_FAILURES",
    "pytest_failed_as_runner",
    "pytest_error_line",
    "PYTEST_PROBE_TIMEOUT_S",
    "pytest_importable",
    "junit_report_paths",
    "produced_junit",
    "wipe_junit_reports",
    "PYTEST_NO_REPORT_TEXT",
    "pytest_no_report_subject",
)

PYTHON = "/venv/bin/python"
REPORTS_DIR = "/scratch/agent/reports"
# The arguments every pytest run carries before what it selects.
PYTEST_PREFIX = [PYTHON, "-m", "pytest", "-v",
                 "-o", "junit_family=xunit1",
                 "-o", "junit_suite_name=pytest",
                 "--junitxml=/scratch/agent/reports/TEST-pytest.xml"]
NODE_IDS = ["tests/test_alpha.py::AlphaTest::test_one", "tests/test_beta.py"]

_LOADED = {}


def _python_client():
    """The python client, loaded once for the whole file."""
    if "python" not in _LOADED:
        _LOADED["python"] = load_client("python-crucible.py")
    return _LOADED["python"]


def _core():
    """The core the python client reaches as `_axi()`."""
    return _python_client()._axi()


def _run_module_namespace():
    """The run module's namespace, reached as the shared-module tests do."""
    return _core().ingest_reports.__globals__


class _RunModuleTest(unittest.TestCase):

    def shared(self, name):
        """The run module's `name`, failing this test when it is not there."""
        namespace = _run_module_namespace()
        if name not in namespace:
            self.fail(f"the shared run module does not define {name}")
        return namespace[name]


class _ScratchDirTest(_RunModuleTest):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pytest-path-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def touch(self, *names):
        for name in names:
            with open(os.path.join(self.dir, name), "w", encoding="utf-8") as handle:
                handle.write("<testsuite/>\n" if name.endswith(".xml") else "x\n")

    def present(self):
        return sorted(os.listdir(self.dir))


# ── where the pytest path is defined ────────────────────────────────────────

class ThePytestPathIsDefinedOnceInTheRunModuleTest(unittest.TestCase):

    def test_every_pytest_piece_is_a_run_module_name_and_the_same_object_on_the_clients_core(self):
        namespace = _run_module_namespace()
        core = _core()
        missing = [name for name in SHARED_NAMES if name not in namespace]
        self.assertEqual(missing, [],
                         "every pytest piece is a top-level name of the run module")
        not_shared = [name for name in SHARED_NAMES
                      if getattr(core, name, None) is not namespace[name]]
        self.assertEqual(not_shared, [],
                         "the client's _axi().<name> is the run module's own object")


# ── the pytest argv ─────────────────────────────────────────────────────────

class ThePytestCommandIsBuiltOnceTest(_RunModuleTest):

    def test_node_ids_alone_follow_the_report_arguments(self):
        pytest_command = self.shared("pytest_command")
        self.assertEqual(
            pytest_command(PYTHON, REPORTS_DIR, NODE_IDS),
            PYTEST_PREFIX + ["tests/test_alpha.py::AlphaTest::test_one",
                             "tests/test_beta.py"])

    def test_a_start_dir_alone_is_the_path_pytest_is_given(self):
        pytest_command = self.shared("pytest_command")
        self.assertEqual(pytest_command(PYTHON, REPORTS_DIR, ["tests/unit"]),
                         PYTEST_PREFIX + ["tests/unit"])

    def test_a_pattern_becomes_python_files_ahead_of_the_start_dir(self):
        pytest_command = self.shared("pytest_command")
        self.assertEqual(
            pytest_command(PYTHON, REPORTS_DIR, ["tests/unit"], pattern="check_*.py"),
            PYTEST_PREFIX + ["-o", "python_files=check_*.py", "tests/unit"])

    def test_an_empty_selection_leaves_discovery_to_the_project(self):
        pytest_command = self.shared("pytest_command")
        self.assertEqual(pytest_command(PYTHON, REPORTS_DIR, []), PYTEST_PREFIX)

    def test_the_interpreter_stays_argv0_and_the_report_lands_in_the_reports_dir(self):
        pytest_command = self.shared("pytest_command")
        argv = pytest_command("/other/python3", "/elsewhere/reports", [])
        self.assertEqual(argv[0], "/other/python3")
        self.assertEqual(argv.count("--junitxml=/elsewhere/reports/TEST-pytest.xml"), 1)
        self.assertNotIn("--junitxml=/scratch/agent/reports/TEST-pytest.xml", argv)


class ThePythonClientsPytestArgvIsUnchangedTest(unittest.TestCase):
    """`_suite_cmd(python, "pytest", targets, start_dir, pattern, reports_dir)`."""

    def suite_cmd(self, targets, start_dir, pattern):
        return _python_client()._suite_cmd(PYTHON, "pytest", targets, start_dir,
                                           pattern, REPORTS_DIR)

    def test_node_ids_are_passed_alone(self):
        self.assertEqual(
            self.suite_cmd(NODE_IDS, None, None),
            [PYTHON, "-m", "pytest", "-v", "-o", "junit_family=xunit1",
             "-o", "junit_suite_name=pytest",
             "--junitxml=/scratch/agent/reports/TEST-pytest.xml",
             "tests/test_alpha.py::AlphaTest::test_one", "tests/test_beta.py"])

    def test_node_ids_drop_a_stated_start_dir_and_pattern(self):
        self.assertEqual(
            self.suite_cmd(NODE_IDS, "tests/unit", "check_*.py"),
            [PYTHON, "-m", "pytest", "-v", "-o", "junit_family=xunit1",
             "-o", "junit_suite_name=pytest",
             "--junitxml=/scratch/agent/reports/TEST-pytest.xml",
             "tests/test_alpha.py::AlphaTest::test_one", "tests/test_beta.py"])

    def test_a_start_dir_alone_is_the_last_argument(self):
        self.assertEqual(
            self.suite_cmd(None, "tests/unit", None),
            [PYTHON, "-m", "pytest", "-v", "-o", "junit_family=xunit1",
             "-o", "junit_suite_name=pytest",
             "--junitxml=/scratch/agent/reports/TEST-pytest.xml",
             "tests/unit"])

    def test_a_start_dir_with_a_pattern_sets_python_files_first(self):
        self.assertEqual(
            self.suite_cmd(None, "tests/unit", "check_*.py"),
            [PYTHON, "-m", "pytest", "-v", "-o", "junit_family=xunit1",
             "-o", "junit_suite_name=pytest",
             "--junitxml=/scratch/agent/reports/TEST-pytest.xml",
             "-o", "python_files=check_*.py", "tests/unit"])

    def test_neither_leaves_the_selection_to_the_project(self):
        self.assertEqual(
            self.suite_cmd(None, None, None),
            [PYTHON, "-m", "pytest", "-v", "-o", "junit_family=xunit1",
             "-o", "junit_suite_name=pytest",
             "--junitxml=/scratch/agent/reports/TEST-pytest.xml"])


# ── the narration ───────────────────────────────────────────────────────────

class ThePytestProgressReadsCollectionAndVerdictsTest(_RunModuleTest):

    def progress(self):
        return self.shared("PytestProgress")()

    def test_a_fresh_progress_has_selected_nothing(self):
        self.assertEqual(self.progress().selected, 0)

    def test_the_collected_line_sets_the_selected_total_and_is_no_finished_test(self):
        progress = self.progress()
        self.assertFalse(progress.recognise("collected 7 items\n"))
        self.assertEqual(progress.selected, 7)

    def test_a_deselection_makes_the_selected_count_the_total(self):
        progress = self.progress()
        self.assertFalse(progress.recognise(
            "collected 7 items / 3 deselected / 4 selected\n"))
        self.assertEqual(progress.selected, 4)

    def test_a_collected_line_after_collecting_and_a_single_item_are_read(self):
        for line, total in (("collecting ... collected 2 items\n", 2),
                            ("collected 1 item\r\n", 1)):
            with self.subTest(line=line):
                progress = self.progress()
                self.assertFalse(progress.recognise(line))
                self.assertEqual(progress.selected, total)

    def test_each_verdict_line_is_one_finished_test(self):
        for line in ("tests/test_alpha.py::AlphaTest::test_one PASSED [ 33%]\n",
                     "tests/test_alpha.py::AlphaTest::test_two FAILED [ 66%]\n",
                     "tests/test_alpha.py::test_three SKIPPED (no db) [100%]\n",
                     "tests/test_alpha.py::test_four ERROR\n",
                     "tests/test_alpha.py::test_five XFAIL [ 10%]\n",
                     "tests/test_alpha.py::test_six XPASS [ 20%]\n"):
            with self.subTest(line=line):
                progress = self.progress()
                self.assertTrue(progress.recognise(line))
                self.assertEqual(progress.selected, 0, "a verdict sets no total")

    def test_summary_subtest_and_banner_lines_are_no_finished_test(self):
        for line in ("FAILED tests/test_alpha.py::AlphaTest::test_two - AssertionError\n",
                     "tests/test_alpha.py::AlphaTest::test_one [case] (n=1) SUBPASSED [ 50%]\n",
                     "============ 3 passed in 0.12s ============\n",
                     "platform linux -- Python 3.12.3, pytest-8.3.3\n",
                     ""):
            with self.subTest(line=line):
                progress = self.progress()
                self.assertFalse(progress.recognise(line))
                self.assertEqual(progress.selected, 0)


# ── the passing-subtest watch ───────────────────────────────────────────────

class ThePassingSubtestSignIsSharedTest(_RunModuleTest):

    def test_a_subpassed_verdict_or_a_subtests_passed_summary_is_the_sign(self):
        reports = self.shared("pytest_reports_passing_subtest")
        for line in ("tests/test_alpha.py::AlphaTest::test_one [case] (n=1) SUBPASSED [ 50%]\n",
                     "======= 1 passed, 3 subtests passed in 0.10s =======\n",
                     "1 subtest passed\n",
                     "12 subtests passed\n"):
            with self.subTest(line=line):
                self.assertTrue(reports(line))

    def test_an_unrelated_line_is_not_the_sign(self):
        reports = self.shared("pytest_reports_passing_subtest")
        for line in ("tests/test_alpha.py::AlphaTest::test_one PASSED [100%]\n",
                     "======= 3 passed in 0.10s =======\n",
                     "0 subtests passed\n",
                     "2 subtests failed\n",
                     ""):
            with self.subTest(line=line):
                self.assertFalse(reports(line))

    def test_the_uncounted_detail_reads_as_today(self):
        self.assertEqual(
            self.shared("PYTEST_SUBTESTS_UNCOUNTED_DETAIL"),
            "pytest writes no test case for a passing subtest in its JUnit "
            "report, so passing subtests were not counted")


# ── the exit classification ─────────────────────────────────────────────────

class APytestRunnerFailureIsReadFromTheExitTest(_RunModuleTest):

    def test_the_runner_failures_are_exits_three_and_four(self):
        self.assertEqual(self.shared("PYTEST_RUNNER_FAILURES"), (3, 4))

    def test_exits_three_and_four_are_a_runner_failure(self):
        failed = self.shared("pytest_failed_as_runner")
        for code in (3, 4):
            with self.subTest(returncode=code):
                self.assertTrue(failed(code))

    def test_a_result_exit_or_a_signal_is_no_runner_failure(self):
        failed = self.shared("pytest_failed_as_runner")
        for code in (0, 1, 2, 5, -9):
            with self.subTest(returncode=code):
                self.assertFalse(failed(code))


class PytestsOwnErrorLineIsTheLastOneTest(_RunModuleTest):

    def test_the_last_of_several_error_lines_is_answered(self):
        error_line = self.shared("pytest_error_line")
        output = ("collecting ... \n"
                  "ERROR: file or directory not found: tests/nope.py\n"
                  "\n"
                  "INTERNALERROR> Traceback (most recent call last):\n"
                  "ImportError while loading conftest '/p/tests/conftest.py'.\n"
                  "E   ModuleNotFoundError: No module named 'missing'\n")
        self.assertEqual(error_line(output),
                         "ImportError while loading conftest '/p/tests/conftest.py'.")

    def test_an_internalerror_after_an_error_is_the_answer(self):
        error_line = self.shared("pytest_error_line")
        output = ("ERROR: usage: pytest [options]\n"
                  "INTERNALERROR> KeyError: 'plugin'\n"
                  "========== no tests ran in 0.01s ==========\n")
        self.assertEqual(error_line(output), "INTERNALERROR> KeyError: 'plugin'")

    def test_an_error_after_the_collecting_prefix_drops_the_prefix(self):
        error_line = self.shared("pytest_error_line")
        output = ("============ test session starts ============\n"
                  "collecting ... ERROR: not found: /p/tests/test_alpha.py::AlphaTest::test_gone   \n"
                  "(no match in any of [<Module test_alpha.py>])\n")
        self.assertEqual(error_line(output),
                         "ERROR: not found: /p/tests/test_alpha.py::AlphaTest::test_gone")

    def test_no_error_line_answers_none(self):
        error_line = self.shared("pytest_error_line")
        for output in ("tests/test_alpha.py::test_one PASSED [100%]\n"
                       "E   ERROR: an indented line is no pytest error\n"
                       "=========== 1 passed in 0.01s ===========\n",
                       "",
                       None):
            with self.subTest(output=output):
                self.assertIsNone(error_line(output))


# ── the JUnit reports a run reads and wipes ─────────────────────────────────

class TheJUnitReportNamesAreSharedTest(_RunModuleTest):

    def test_the_report_glob_and_pytests_report_file(self):
        self.assertEqual(self.shared("JUNIT_REPORT_GLOB"), "TEST-*.xml")
        self.assertEqual(self.shared("PYTEST_JUNIT_FILE"), "TEST-pytest.xml")


class TheJUnitReportPathsAreSortedTest(_ScratchDirTest):

    def test_only_the_test_reports_are_answered_in_sorted_order(self):
        junit_report_paths = self.shared("junit_report_paths")
        self.touch("TEST-b.xml", "TEST-a.xml", "notes.txt", "crucible-events.ndjson")
        self.assertEqual(junit_report_paths(self.dir),
                         [os.path.join(self.dir, "TEST-a.xml"),
                          os.path.join(self.dir, "TEST-b.xml")])

    def test_a_missing_dir_holds_no_reports(self):
        junit_report_paths = self.shared("junit_report_paths")
        self.assertEqual(junit_report_paths(os.path.join(self.dir, "missing")), [])


class AProducedJUnitReportIsDetectedTest(_ScratchDirTest):

    def test_a_missing_dir_produced_nothing(self):
        produced_junit = self.shared("produced_junit")
        self.assertFalse(produced_junit(os.path.join(self.dir, "missing")))

    def test_an_empty_dir_produced_nothing(self):
        produced_junit = self.shared("produced_junit")
        self.assertFalse(produced_junit(self.dir))

    def test_a_dir_of_unrelated_files_produced_nothing(self):
        produced_junit = self.shared("produced_junit")
        self.touch("notes.txt", "crucible-events.ndjson", "TEST-a.txt")
        self.assertFalse(produced_junit(self.dir))

    def test_a_dir_holding_a_test_report_produced_one(self):
        produced_junit = self.shared("produced_junit")
        self.touch("notes.txt", "TEST-pytest.xml")
        self.assertTrue(produced_junit(self.dir))


class TheStaleJUnitWipeRemovesOnlyReportsTest(_ScratchDirTest):

    def test_only_the_test_reports_are_removed(self):
        wipe = self.shared("wipe_junit_reports")
        self.touch("TEST-a.xml", "TEST-pytest.xml", "notes.txt",
                   "crucible-events.ndjson", "TEST-a.txt")
        wipe(self.dir)
        self.assertEqual(self.present(),
                         ["TEST-a.txt", "crucible-events.ndjson", "notes.txt"])

    def test_a_missing_dir_is_left_alone(self):
        wipe = self.shared("wipe_junit_reports")
        missing = os.path.join(self.dir, "missing")
        wipe(missing)
        self.assertFalse(os.path.exists(missing))


# ── the no-report wording and the probe's timeout ───────────────────────────

class TheNoReportWordingReadsAsTodayTest(_RunModuleTest):

    def test_the_subject_names_the_verb_under_pytest(self):
        subject = self.shared("pytest_no_report_subject")
        self.assertEqual(subject("regression"), "regression under pytest")
        self.assertEqual(subject("test"), "test under pytest")

    def test_the_fallback_text_when_pytest_wrote_and_printed_nothing(self):
        self.assertEqual(
            self.shared("PYTEST_NO_REPORT_TEXT"),
            "pytest produced no JUnit XML (collection/usage failure, no output captured)")


class ThePytestProbeTimeoutIsSharedTest(_RunModuleTest):

    def test_the_probe_waits_sixty_seconds(self):
        self.assertEqual(self.shared("PYTEST_PROBE_TIMEOUT_S"), 60)

    def test_the_clients_core_answers_the_probes_current_timeout(self):
        namespace = _run_module_namespace()
        shipped = self.shared("PYTEST_PROBE_TIMEOUT_S")
        with mock.patch.dict(namespace, {"PYTEST_PROBE_TIMEOUT_S": 7}):
            self.assertEqual(_core().pytest_probe_timeout(), 7,
                             "the core answers the timeout the probe would use now")
        self.assertEqual(namespace["PYTEST_PROBE_TIMEOUT_S"], shipped,
                         "the patched timeout is restored afterwards")
        self.assertEqual(_core().pytest_probe_timeout(), shipped)


if __name__ == "__main__":
    unittest.main()
