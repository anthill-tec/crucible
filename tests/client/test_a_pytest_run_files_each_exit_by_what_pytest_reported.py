"""A pytest run is filed by what pytest reported, on every way it can exit.

On a project that declares `[python] runner = "pytest"`, pytest's exit code
says what its JUnit report is:

* exit 0, 1 or 2 -- the report is the result. A module that cannot be
  imported (a collection error, exit 2) is ONE failed test, as a unittest
  import failure is;
* exit 5 -- nothing was collected: the run ran nothing. It is aborted with
  the `no-test-reports` warning and no compile record is filed;
* exit 4 (a node id that does not exist, a `conftest.py` that cannot be
  loaded) and exit 3 (an internal error, here a conftest hook that raises) --
  pytest failed as a runner. Whatever JUnit it wrote is NOT filed as tests:
  the captured output is filed as ONE compile record, and the envelope is the
  no-report one, whose `no-test-reports` warning carries pytest's own error
  line (`ERROR:` / `INTERNALERROR`) and names pytest as the runner that ran;
* a SIGTERM while pytest runs leaves the run aborted and prints one envelope.

Every run drives the REAL `clients/python-crucible.py` as an OS subprocess on
a scratch copy of `tests/fixtures/pytest-project` with this suite's own
interpreter (which has pytest), filing to a recording board named by the
scratch project's own `crucible.toml`. Each exit is driven ONCE per class
(`setUpClass`); the tests read what that one run filed.

Invocation:
    python3 -m unittest tests.client.test_a_pytest_run_files_each_exit_by_what_pytest_reported -v
"""

import os
import signal
import subprocess
import sys
import time
import unittest

from tests.client.live_run_harness import CLIENTS, scrubbed_env
from tests.client.pytest_project_harness import (
    _INHERITED_KEYS,
    AGENT,
    TIMEOUT,
    ScratchProject,
    counts,
    diag,
    envelope,
    require_pytest_and_coverage,
)

NO_TEST_REPORTS = "no-test-reports"
# The joiner `no_report_warning` puts between its own prefix and the runner's
# output line it carries: the prefix is the client's own text, so it is where
# the runner that ran must be named (a carried line may name anything).
CARRIED_LINE_JOINER = "; last output line: "

# A scratch test module that imports a module no interpreter has.
BROKEN_IMPORT_MODULE = "a_module_no_interpreter_has_7ab3"
_BROKEN_IMPORT = f'''"""A test module that cannot be imported."""

import {BROKEN_IMPORT_MODULE}

def test_never_collected():
    assert {BROKEN_IMPORT_MODULE}
'''

# A scratch conftest that cannot be loaded.
BROKEN_CONFTEST_MODULE = "a_conftest_dependency_nobody_has_5c19"
_BROKEN_CONFTEST = f'''"""A conftest that cannot be loaded."""

import {BROKEN_CONFTEST_MODULE}
'''

# A scratch conftest whose collection hook raises: pytest reports an
# INTERNALERROR and exits 3.
INTERNAL_ERROR_MARKER = "planted internal error 9d41"
_RAISING_HOOK_CONFTEST = f'''"""A conftest whose collection hook raises."""

def pytest_collection_modifyitems(items):
    raise RuntimeError({INTERNAL_ERROR_MARKER!r})
'''

# A node id inside an existing file that names no test.
MISSING_TEST = "test_there_is_no_such_test_e2c8"
MISSING_NODE_ID = f"check_outcomes.py::{MISSING_TEST}"

class _OneExitOfAPytestRun(unittest.TestCase):
    """Drive the `test` verb once on a pytest-declared scratch project."""

    ARGV: tuple[str, ...] = ("test", "--agent", AGENT)
    EXTRA_FILES: tuple[tuple[str, str], ...] = ()

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject(f"pyrun-exit-{cls.__name__}-")
        cls.project.declare("pytest")
        for rel, text in cls.EXTRA_FILES:
            cls.project.write(rel, text)
        cls.result = cls.project.drive(list(cls.ARGV))
        cls.axi = envelope(cls.result.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def the_envelope(self):
        if self.axi is None:
            self.fail(f"stdout must be one AXI envelope; {diag(self.result)}")
        return self.axi

    def warnings_coded(self, code):
        return [w for w in self.the_envelope().get("warnings") or []
                if isinstance(w, dict) and w.get("code") == code]

    def the_no_report_detail(self):
        found = self.warnings_coded(NO_TEST_REPORTS)
        self.assertEqual(len(found), 1,
                         f"exactly one {NO_TEST_REPORTS} warning; {diag(self.result)}")
        detail = found[0].get("detail")
        if not isinstance(detail, str):
            self.fail(f"the warning's detail must be a string; warning={found[0]!r}")
        return detail

    def assert_the_detail_names_pytest_as_the_runner(self):
        detail = self.the_no_report_detail()
        own_text = detail.split(CARRIED_LINE_JOINER, 1)[0]
        self.assertIn("pytest", own_text,
                      f"the no-report detail must name the runner that ran (pytest) "
                      f"in its own text, not only inside a carried output line; "
                      f"detail={detail!r}")

class _APytestRunnerFailure(_OneExitOfAPytestRun):
    """Exit 3 or 4: pytest failed as a runner, so nothing it wrote is a test
    result; its captured output is ONE compile record and the envelope is
    the no-report one."""

    EXIT_CODE = 0
    CARRIED = ""

    def test_pytest_exited_with_its_runner_failure_code(self):
        self.assertIn(f"exit={self.EXIT_CODE}", self.result.stderr,
                      f"the scratch project must make pytest exit {self.EXIT_CODE}; "
                      f"{diag(self.result)}")

    def test_no_test_is_filed(self):
        self.assertEqual(self.project.parsed_ingests(), [],
                         f"a runner failure files no tests, even where pytest wrote "
                         f"a JUnit file; {diag(self.result)}")

    def test_one_compile_record_carries_the_captured_output(self):
        records = self.project.compile_ingests()
        self.assertEqual(len(records), 1,
                         f"exactly one compile record; {diag(self.result)}")
        errors = records[0].get("errors") or ""
        self.assertIn(self.CARRIED, errors,
                      f"the compile record is pytest's captured output; "
                      f"record={records[0]!r}")
        self.assertEqual(records[0].get("runId"), self.project.board.run_ids_opened()[0],
                         f"the compile record closes the run this client opened; "
                         f"record={records[0]!r}")

    def test_the_envelope_is_the_no_report_one(self):
        axi = self.the_envelope()
        self.assertIs(axi.get("ok"), False, diag(self.result))
        help_lines = axi.get("help") or []
        self.assertTrue(any("produced no TEST-*.xml" in line for line in help_lines),
                        f"the no-report help; help={help_lines!r}")
        self.assertNotEqual(self.result.returncode, 0, diag(self.result))

    def test_the_warning_carries_pytests_own_error_line(self):
        detail = self.the_no_report_detail()
        self.assertIn(self.CARRIED, detail,
                      f"the {NO_TEST_REPORTS} warning must carry pytest's own error "
                      f"line; detail={detail!r} {diag(self.result)}")

    def test_the_no_report_detail_names_pytest(self):
        self.assert_the_detail_names_pytest_as_the_runner()

class ANonexistentNodeIdIsARunnerFailureTest(_APytestRunnerFailure):
    """`--tests` naming a test that is not in its file: pytest prints
    `ERROR: not found: ...` and exits 4, after writing a JUnit file that holds
    no test."""

    ARGV = ("test", "--agent", AGENT, "--tests", MISSING_NODE_ID)
    EXIT_CODE = 4
    CARRIED = "ERROR: not found:"

    def test_the_carried_error_line_names_the_missing_node(self):
        detail = self.the_no_report_detail()
        self.assertIn(MISSING_TEST, detail,
                      f"pytest's ERROR line names the node id it did not find; "
                      f"detail={detail!r}")

class AnInternalErrorIsARunnerFailureTest(_APytestRunnerFailure):
    """A conftest collection hook that raises: pytest prints `INTERNALERROR>`
    lines, exits 3 and writes a JUnit file with one test case named
    `internal` -- which must never be filed as a test."""

    EXTRA_FILES = (("conftest.py", _RAISING_HOOK_CONFTEST),)
    EXIT_CODE = 3
    CARRIED = "INTERNALERROR"

class ABrokenConftestIsARunnerFailureTest(_APytestRunnerFailure):
    """A `conftest.py` that cannot be imported: pytest exits 4 before any
    session starts. pytest 9 reports this case as `ImportError while loading
    conftest '<path>'.` followed by the import's own error, and no `ERROR:`
    prefixed line; the warning must carry that report."""

    EXTRA_FILES = (("conftest.py", _BROKEN_CONFTEST),)
    EXIT_CODE = 4
    CARRIED = BROKEN_CONFTEST_MODULE

    def test_the_warning_carries_pytests_own_error_line(self):
        detail = self.the_no_report_detail()
        self.assertTrue(
            "while loading conftest" in detail or BROKEN_CONFTEST_MODULE in detail,
            f"the {NO_TEST_REPORTS} warning must carry pytest's report of the "
            f"conftest it could not load; detail={detail!r} {diag(self.result)}")

class ACollectionErrorIsOneFailedTestTest(_OneExitOfAPytestRun):
    """A test module that cannot be imported: pytest exits 2 and its JUnit
    file holds one errored test case for that module -- filed as ONE failed
    test, as a unittest import failure is."""

    EXTRA_FILES = (("check_broken_import.py", _BROKEN_IMPORT),)

    def test_pytest_exited_2(self):
        self.assertIn("exit=2", self.result.stderr,
                      f"the scratch project must make pytest exit 2; {diag(self.result)}")

    def test_it_files_one_failed_test(self):
        ingests = self.project.parsed_ingests()
        self.assertEqual(len(ingests), 1,
                         f"exactly one parsed ingest; {diag(self.result)}")
        self.assertEqual(counts(ingests[0]),
                         {"total": 1, "passed": 0, "failed": 1, "pending": 0},
                         f"the collection error is one failed test; {diag(self.result)}")

    def test_it_files_no_compile_record(self):
        self.assertEqual(self.project.compile_ingests(), [],
                         f"a collection error is a test result, not a compile "
                         f"record; {diag(self.result)}")

    def test_the_run_exits_non_zero(self):
        self.assertNotEqual(self.result.returncode, 0, diag(self.result))

class NothingCollectedAbortsTheRunTest(_OneExitOfAPytestRun):
    """A `--pattern` no file matches: pytest collects nothing and exits 5.
    The run ran nothing: aborted with `no-test-reports`, no compile record."""

    ARGV = ("test", "--agent", AGENT, "--pattern", "matches_no_file_*.py")

    def test_pytest_exited_5(self):
        self.assertIn("exit=5", self.result.stderr,
                      f"the scratch project must make pytest exit 5; {diag(self.result)}")

    def test_the_run_is_aborted_with_no_test_reports(self):
        axi = self.the_envelope()
        self.assertIs(axi.get("ok"), False, diag(self.result))
        self.the_no_report_detail()
        aborts = self.project.board.aborts()
        run_id = self.project.board.run_ids_opened()[0]
        self.assertEqual([path for path, _ in aborts], [f"/api/v2/runs/{run_id}/abort"],
                         f"the opened run is aborted, once; {diag(self.result)}")
        self.assertEqual(len(self.warnings_coded("run-aborted")), 1, diag(self.result))

    def test_nothing_is_filed(self):
        self.assertEqual(self.project.compile_ingests(), [],
                         f"a run that collected nothing files no compile record; "
                         f"{diag(self.result)}")
        self.assertEqual(self.project.parsed_ingests(), [],
                         f"a run that collected nothing files no tests; {diag(self.result)}")
        self.assertNotEqual(self.result.returncode, 0, diag(self.result))

    def test_the_no_report_detail_names_pytest(self):
        self.assert_the_detail_names_pytest_as_the_runner()

# A scratch test that says it has started (a file the harness polls for)
# and then holds the run open until released, so a signal lands mid-run.
_BLOCKING_TEST = '''"""A test that holds the run open until released."""

import os
import time

STARTED = {started!r}
RELEASE = {release!r}

def test_it_holds_the_run_open():
    with open(STARTED, "w") as handle:
        handle.write("started")
    deadline = time.monotonic() + 60
    while not os.path.exists(RELEASE) and time.monotonic() < deadline:
        time.sleep(0.05)
'''

def _wait_for_file(path, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return True
        time.sleep(0.05)
    return False

class ASigtermDuringAPytestRunLeavesItAbortedTest(unittest.TestCase):
    """SIGTERM to the client while pytest is running a test: the run this
    client opened is aborted, nothing is filed, and stdout is ONE envelope."""

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject("pyrun-exit-sigterm-")
        cls.project.declare("pytest")
        started = os.path.join(cls.project.root, "started")
        release = os.path.join(cls.project.root, "release")
        cls.project.write("check_holds_the_run_open.py",
                          _BLOCKING_TEST.format(started=started, release=release))
        env = scrubbed_env(None)
        for key in _INHERITED_KEYS:
            env.pop(key, None)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
               "--agent", AGENT, "--tests", "check_holds_the_run_open.py",
               "--python", sys.executable, "--project-dir", cls.project.dir]
        proc = subprocess.Popen(cmd, cwd=cls.project.dir, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            cls.reached = _wait_for_file(started, 60)
            if cls.reached:
                proc.send_signal(signal.SIGTERM)
            cls.stdout, cls.stderr = proc.communicate(timeout=TIMEOUT)
        finally:
            with open(release, "w") as handle:
                handle.write("go")
            if proc.poll() is None:
                proc.kill()
                proc.communicate()
        cls.returncode = proc.returncode
        cls.axi = envelope(cls.stdout) or {}

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def diag(self):
        return (f"exit={self.returncode} stdout={self.stdout[-2000:]!r} "
                f"stderr={self.stderr[-3000:]!r}")

    def setUp(self):
        self.assertTrue(self.reached, f"pytest never started the test; {self.diag()}")

    def test_the_client_exits_on_the_signal(self):
        self.assertEqual(self.returncode, 128 + signal.SIGTERM, self.diag())

    def test_stdout_is_one_envelope(self):
        roots = [line for line in self.stdout.splitlines() if line.startswith("axi:")]
        self.assertEqual(len(roots), 1, f"exactly one envelope; {self.diag()}")
        self.assertNotEqual(self.axi, {}, f"stdout decodes to an envelope; {self.diag()}")
        self.assertIs(self.axi.get("ok"), False, self.diag())
        self.assertEqual(self.axi.get("signal"), "SIGTERM", self.diag())

    def test_the_opened_run_is_aborted_and_nothing_filed(self):
        board = self.project.board
        self.assertEqual(len(board.run_ids_opened()), 1, self.diag())
        run_id = board.run_ids_opened()[0]
        self.assertEqual([path for path, _ in board.aborts()],
                         [f"/api/v2/runs/{run_id}/abort"], self.diag())
        self.assertEqual(self.axi.get("runId"), run_id, self.diag())
        aborted = [w for w in self.axi.get("warnings") or []
                   if isinstance(w, dict) and w.get("code") == "run-aborted"]
        self.assertEqual(len(aborted), 1, self.diag())
        self.assertEqual(self.project.parsed_ingests(), [], self.diag())
        self.assertEqual(self.project.compile_ingests(), [], self.diag())

# The shared bases drive no run of their own: out of the module's namespace,
# so unittest's loader collects only the concrete classes above.
del _OneExitOfAPytestRun, _APytestRunnerFailure

if __name__ == "__main__":
    unittest.main()
