"""A pytest run narrates its completed tests and names the runner that ran.

On a project that declares `[python] runner = "pytest"`:

* the run's heartbeats count its COMPLETED tests -- the `-v` per-test verdict
  lines (`<nodeid> PASSED`, `FAILED`, `SKIPPED`, `ERROR`, `XFAIL`, `XPASS`),
  never a `SUB...` subtest line and never pytest's short summary
  (`FAILED <nodeid> - <message>`) -- against the SELECTED total pytest states
  when collection ends (`collected N items`, or
  `collected N items / D deselected / S selected`). The narrator throttles
  its in-run posts (these runs are too short to reach one), so the proof is
  its final `ran <completed>/<selected>` post;
* the printed text names pytest as the runner that ran: the stderr exit line
  (on the unittest path it names xmlrunner), and the `--python` help of every
  running verb (which today says only that the interpreter needs xmlrunner).

Every run drives the REAL `clients/python-crucible.py` as an OS subprocess on
a scratch copy of `tests/fixtures/pytest-project` with this suite's own
interpreter (which has pytest), filing to a recording board named by the
scratch project's own `crucible.toml`. Each run is driven ONCE per class.

Invocation:
    python3 -m unittest tests.client.test_a_pytest_run_narrates_and_names_its_runner -v
"""

import re
import unittest

from tests.client.pytest_project_harness import (
    AGENT,
    ScratchProject,
    diag,
    require_pytest_and_coverage,
)

_RAN = re.compile(r"^ran \d+/\d+")

# The fixture's own configuration, plus `addopts` that deselect the passing
# test (3 collected / 1 deselected / 2 selected) and stop at the first
# failure: the failing test is the first selected one, so ONE of the TWO
# selected tests completes.
_DESELECTING_EXITFIRST_INI = '''[pytest]
python_files = check_*.py
addopts = -x -k "not test_it_passes"
'''

# One unittest test with three passing `subTest` blocks and one pytest test
# with three passing native subtests: two tests, six subtests.
_SUBTESTS_FILE = '''"""Two tests, each with three passing subtests."""

import unittest

class UnittestSubTests(unittest.TestCase):

    def test_three_passing_subtests(self):
        for i in range(3):
            with self.subTest(i=i):
                self.assertLess(i, 3)

def test_three_passing_native_subtests(subtests):
    for i in range(3):
        with subtests.test(msg="native", i=i):
            assert i < 3
'''

class _OneNarratedPytestRun(unittest.TestCase):
    """Drive one verb once on a pytest-declared scratch project and read the
    heartbeat messages the board received."""

    ARGV: tuple[str, ...] = ("test", "--agent", AGENT)
    EXTRA_FILES: tuple[tuple[str, str], ...] = ()
    EXPECTED_FINAL = ""
    SELECTED = 0

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject(f"pyrun-narrate-{cls.__name__}-")
        cls.project.declare("pytest")
        for rel, text in cls.EXTRA_FILES:
            cls.project.write(rel, text)
        cls.result = cls.project.drive(list(cls.ARGV))
        cls.messages = [m for m in cls.project.board.messages() if isinstance(m, str)]

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def test_the_final_count_is_the_completed_tests_over_the_selected_total(self):
        finals = [m for m in self.messages if _RAN.match(m)]
        self.assertEqual(finals, [self.EXPECTED_FINAL],
                         f"exactly one final narration post, counting completed "
                         f"tests over the selected total; messages={self.messages!r} "
                         f"{diag(self.result)}")

class TheFixturesThreeVerdictsAreCountedTest(_OneNarratedPytestRun):
    """`collected 3 items`; one PASSED, one FAILED and one SKIPPED verdict
    line. pytest's short summary repeats the failure as `FAILED <nodeid> -
    ...`; that line is no completed test."""

    EXPECTED_FINAL = "ran 3/3"
    SELECTED = 3

    def test_the_exit_line_names_pytest(self):
        self.assertRegex(self.result.stderr, r"(?m)^\[crucible\] pytest exit=1\s*$",
                         f"the stderr exit line names the runner that ran; "
                         f"{diag(self.result)}")
        self.assertNotIn("xmlrunner exit=", self.result.stderr,
                         f"a pytest run's exit line never names xmlrunner; "
                         f"{diag(self.result)}")

class TheSelectedTotalExcludesDeselectedTestsTest(_OneNarratedPytestRun):
    """`collected 3 items / 1 deselected / 2 selected`, and `-x` stops the
    run at the first (failing) selected test: one of two selected tests
    completed -- `ran 1/2`, never over the 3 collected and never `1/1`."""

    EXTRA_FILES = (("pytest.ini", _DESELECTING_EXITFIRST_INI),)
    EXPECTED_FINAL = "ran 1/2"
    SELECTED = 2

class SubtestLinesAreNotCountedTest(_OneNarratedPytestRun):
    """Two tests with three passing subtests each: `collected 2 items`, two
    verdict lines, and `SUBPASSED` lines that are no completed test."""

    ARGV = ("test", "--agent", AGENT, "--tests", "check_two_tests_with_subtests.py")
    EXTRA_FILES = (("check_two_tests_with_subtests.py", _SUBTESTS_FILE),)
    EXPECTED_FINAL = "ran 2/2"
    SELECTED = 2

class RegressionsExitLineNamesPytestTest(unittest.TestCase):
    """`regression` prints its own exit line: on a pytest run it names
    pytest."""

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject("pyrun-narrate-regression-")
        cls.project.declare("pytest")
        cls.result = cls.project.drive(["regression", "--agent", AGENT])

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def test_the_exit_line_names_pytest(self):
        self.assertRegex(self.result.stderr, r"(?m)^\[crucible\] pytest exit=1\s*$",
                         f"the stderr exit line names the runner that ran; "
                         f"{diag(self.result)}")
        self.assertNotIn("xmlrunner exit=", self.result.stderr, diag(self.result))

def _python_help(help_text):
    """The `--python` option's help, from a verb's `--help` output, with its
    wrapping folded to single spaces."""
    lines = help_text.splitlines()
    start = next((i for i, line in enumerate(lines)
                  if line.lstrip().startswith("--python")), None)
    if start is None:
        return None
    block = [lines[start]]
    for line in lines[start + 1:]:
        if line.lstrip().startswith("-") or not line.strip():
            break
        block.append(line)
    return " ".join(" ".join(block).split())

class ThePythonHelpNamesPytestTest(unittest.TestCase):
    """Every running verb's `--python` help says what the interpreter must
    have under pytest, not only under unittest's xmlrunner."""

    def setUp(self):
        self.project = ScratchProject("pyrun-narrate-help-")
        self.addCleanup(self.project.close)

    def test_every_running_verbs_python_help_names_pytest(self):
        for verb in ("test", "regression", "integration", "pre-merge-gate"):
            with self.subTest(verb=verb):
                result = self.project.drive([verb, "--help"])
                self.assertEqual(result.returncode, 0, diag(result))
                text = _python_help(result.stdout)
                if text is None:
                    self.fail(f"{verb} --help must document --python; {diag(result)}")
                self.assertIn("pytest", text,
                              f"{verb}'s --python help names pytest; help={text!r}")

# The shared base drives no run of its own: out of the module's namespace, so
# unittest's loader collects only the concrete classes above.
del _OneNarratedPytestRun

if __name__ == "__main__":
    unittest.main()
