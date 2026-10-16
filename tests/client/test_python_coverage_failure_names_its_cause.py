"""When the python client's coverage housekeeping fails -- the read of the
project's coverage configuration, or the erase of an earlier run's data --
it says why on ONE stderr line: the cause (the error's type, or the first
line coverage.py printed), never the client's own probe source.

Every test drives the real `python-crucible.py` `main` in-process against
the `RecordingBoard` double over a scratch project built by
`python_coverage_project`, through both verbs that run a coverage run
(`regression --coverage` and `pre-merge-gate`) as subtests.

How each failure is made, without touching the client:

* A configuration read that times out. The run's interpreter is a real
  shim (`write_unanswering_python`) that hands every command to the repo's
  own interpreter except an inline `-c` probe that does not erase, which it
  never answers: it sleeps far past any budget. The client's own timeout
  then fires for real -- a real child, a real `subprocess.TimeoutExpired`
  from the standard library -- once the test has shortened the budget of
  every `subprocess.run` call that carries one (`shortened_timeouts`), so
  the test waits seconds rather than the client's full budget. Nothing else
  about the call changes.
* An erase that fails. An earlier run's "parallel data file" beside the data
  file is a DIRECTORY, so coverage.py's own erase raises `IsADirectoryError`
  removing it. The run is given `--cov-source`, so the erase is the only
  probe it makes.
"""

import contextlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.python_coverage_project import (  # noqa: E402
    REAL_VENV_PYTHON,
    UNDECLARED_CODE,
    VERBS,
    base_files,
    coverage_run_lines,
    drive,
    make_project,
    source_values,
    warnings_with_code,
)

# Fragments every inline coverage.py probe carries in its own source. None of
# them may reach stderr: the line names the cause, not the script.
PROBE_SOURCE_FRAGMENTS = ("import coverage", "coverage.Coverage(",
                          "CoverageData(", "json.dumps(")

# How long the shim leaves an unanswered probe hanging, and the budget the
# test gives every timed `subprocess.run` call instead of the client's own.
UNANSWERED_SLEEP_SECONDS = 30
SHORTENED_TIMEOUT_SECONDS = 2

def write_unanswering_python(test):
    """A real interpreter that never answers an inline `-c` probe unless the
    probe erases: it sleeps instead. Every other command -- the coverage run,
    the report, an erase -- is handed to the repo's own interpreter. Lives
    outside any scratch project, so it is never measured."""
    bin_dir = tempfile.mkdtemp(prefix="coverage-config-unanswering-")
    test.addCleanup(shutil.rmtree, bin_dir, ignore_errors=True)
    shim = Path(bin_dir, "unanswering-python")
    shim.write_text(
        f"#!{REAL_VENV_PYTHON}\n"
        "import os\n"
        "import sys\n"
        "import time\n"
        "args = sys.argv[1:]\n"
        "if len(args) >= 2 and args[0] == '-c' and 'erase' not in args[1]:\n"
        f"    time.sleep({UNANSWERED_SLEEP_SECONDS})\n"
        "    sys.exit(0)\n"
        "os.execv(sys.executable, [sys.executable] + args)\n",
        encoding="utf-8")
    shim.chmod(0o755)
    return str(shim)

@contextlib.contextmanager
def shortened_timeouts():
    """Every `subprocess.run` call made while this is active that carries a
    `timeout` runs with `SHORTENED_TIMEOUT_SECONDS` instead. Yields the list
    of timeouts that actually fired, as `(argv, exception)` pairs."""
    real_run = subprocess.run
    fired = []

    def _run(*args, **kwargs):
        if kwargs.get("timeout") is not None:
            kwargs["timeout"] = SHORTENED_TIMEOUT_SECONDS
        try:
            return real_run(*args, **kwargs)
        except subprocess.TimeoutExpired as exc:
            fired.append((args[0] if args else kwargs.get("args"), exc))
            raise

    with mock.patch.object(subprocess, "run", _run):
        yield fired

class _FailureCauseCase(unittest.TestCase):

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"these tests need the repo's interpreter with coverage.py and "
            f"unittest-xml-reporting installed, at {REAL_VENV_PYTHON}")

    def _assert_no_probe_source(self, label, err):
        leaked = [line for line in err.splitlines()
                  if any(fragment in line for fragment in PROBE_SOURCE_FRAGMENTS)]
        self.assertEqual(
            leaked, [],
            f"{label}: a failed coverage probe names its cause, never the "
            f"client's own probe source; these stderr lines carry it: "
            f"{leaked!r}")

class AConfigurationReadThatTimesOutNamesItsCauseTest(_FailureCauseCase):

    def test_a_timed_out_configuration_read_prints_one_line_naming_the_timeout_and_not_the_probe(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(self, base_files())
                unanswering = write_unanswering_python(self)
                with shortened_timeouts() as fired:
                    result = drive(project_dir, board, verb, python=unanswering)
                timed_out = [argv for argv, _exc in fired
                             if isinstance(argv, (list, tuple)) and "-c" in argv]
                self.assertEqual(
                    len(timed_out), 1,
                    f"{label}: fixture -- exactly the configuration read times "
                    f"out; timeouts fired for {[argv for argv, _ in fired]!r} "
                    f"({result.describe()})")
                self._assert_no_probe_source(label, result.err)
                naming = [line for line in result.err.splitlines()
                          if "timed out" in line.lower()
                          or "TimeoutExpired" in line]
                self.assertEqual(
                    len(naming), 1,
                    f"{label}: one stderr line names the timeout as the "
                    f"cause; got {naming!r} in stderr={result.err!r}")
                # The read failed, so the run goes ahead as if a source were
                # declared: no --source, no undeclared warning.
                lines = coverage_run_lines(result.err)
                self.assertEqual(
                    [source_values(line) for line in lines], [[]],
                    f"{label}: an unread configuration passes no --source; got "
                    f"{lines!r}")
                self.assertEqual(
                    warnings_with_code(result.axi, UNDECLARED_CODE), [],
                    f"{label}: an unread configuration carries no "
                    f"{UNDECLARED_CODE!r} warning; {result.describe()}")

class AFailedEraseNamesItsCauseTest(_FailureCauseCase):

    def test_a_failed_erase_prints_one_line_naming_its_cause_and_the_run_goes_ahead(self):
        for label, verb in VERBS:
            with self.subTest(verb=label):
                project_dir, board = make_project(self, base_files())
                # An earlier "parallel data file" coverage.py cannot remove.
                blocker = Path(project_dir, ".coverage.earlier-run")
                blocker.mkdir()
                Path(blocker, "kept").write_text("", encoding="utf-8")
                result = drive(project_dir, board, verb,
                               extra_argv=("--cov-source", "mypkg",
                                           "--reports", "test-reports/explicit"))
                self.assertTrue(
                    blocker.is_dir(),
                    f"{label}: fixture -- the erase could not remove the "
                    f"directory; {result.describe()}")
                self._assert_no_probe_source(label, result.err)
                erase_lines = [line for line in result.err.splitlines()
                               if "erase" in line.lower()]
                self.assertEqual(
                    len(erase_lines), 1,
                    f"{label}: a failed erase prints exactly one stderr line; "
                    f"got {erase_lines!r} in stderr={result.err!r}")
                self.assertTrue(
                    "IsADirectoryError" in erase_lines[0]
                    or "Is a directory" in erase_lines[0],
                    f"{label}: the erase's line names its cause, coverage.py's "
                    f"IsADirectoryError; got {erase_lines[0]!r}")
                run = (result.axi or {}).get("run") or {}
                self.assertEqual(
                    (run.get("total"), run.get("failed")), (3, 0),
                    f"{label}: a failed erase never fails the run; "
                    f"{result.describe()}")

if __name__ == "__main__":
    unittest.main()
