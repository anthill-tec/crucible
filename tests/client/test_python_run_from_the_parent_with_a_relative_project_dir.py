"""A real python `test` run and a real python `pre-merge-gate`, started from a
project's PARENT directory with a RELATIVE `--project-dir`, file the same pass
and fail counts as the same run given the absolute path, and no compile
failure.

Each run is the real `clients/python-crucible.py` as its own process, with the
repo's own interpreter (xmlrunner and coverage.py installed), over a tiny
scratch unittest project that holds three passing tests and one failing test,
its own `.env`, and a project `crucible.toml` whose `[client] url` names a
`RecordingBoard` on a free loopback port. Never the live board.

What the board recorded is the observable outcome: the `summary` of the
parsed ingest (`/api/v2/runs/parsed`) and the absence of any compile ingest
(`/api/v2/runs/compile`). A relative project dir that is kept relative sends
the runner's reports to a directory the client never reads, and the run is
filed as a compile failure; the gate's py_compile step fails the same way.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import (  # noqa: E402
    RecordingBoard,
    install_project,
    scrubbed_env,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"
CLIENT_PATH = REPO_ROOT / "clients" / "python-crucible.py"

AGENT = "relative-project-dir-agent"
PROJECT_KEY = "relative-project-dir-run-key"
PROJECT_NAME = "scratch-project"

PARSED = "/api/v2/runs/parsed"
COMPILE = "/api/v2/runs/compile"

EXPECTED_PASSED = 3
EXPECTED_FAILED = 1

COUNTS_TEST_SOURCE = textwrap.dedent('''\
    import unittest


    class CountsTest(unittest.TestCase):
        def test_first_passes(self):
            self.assertEqual(1 + 1, 2)

        def test_second_passes(self):
            self.assertEqual("a".upper(), "A")

        def test_third_passes(self):
            self.assertIn(2, [1, 2, 3])

        def test_fourth_fails_on_purpose(self):
            self.assertEqual(1, 2)
    ''')

# Settings that steer a run from outside the scratch project: the outer
# workflow, an outer coverage run, and every client's project-dir variable.
_EXTRA_ENV_TO_SCRUB = (
    "COVERAGE_RCFILE", "COVERAGE_FILE", "COVERAGE_PROCESS_START",
    "COVERAGE_PROCESS_CONFIG", "COVERAGE_CORE",
    "PY_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
    "MVN_CRUCIBLE_PROJECT_DIR", "RUST_CRUCIBLE_PROJECT_DIR",
    "ARDUINO_CRUCIBLE_PROJECT_DIR")

_TAIL = 3000


class _Run:
    def __init__(self, completed, board):
        self.code = completed.returncode
        self.out = completed.stdout
        self.err = completed.stderr
        self.board = board

    def describe(self):
        return (f"exit={self.code} stdout[-{_TAIL}:]={self.out[-_TAIL:]!r} "
                f"stderr[-{_TAIL}:]={self.err[-_TAIL:]!r}")

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def filed_counts(self):
        """`(passed, failed)` of every parsed ingest the board received."""
        return [((body or {}).get("summary") or {}).get("passed")
                for body in self.posts_to(PARSED)], \
               [((body or {}).get("summary") or {}).get("failed")
                for body in self.posts_to(PARSED)]


class RunFromTheParentWithARelativeProjectDirTest(unittest.TestCase):

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"these tests need the repo's interpreter with xmlrunner and "
            f"coverage.py installed, at {REAL_VENV_PYTHON}")

    def _make_project(self):
        """`(parent, project_dir, board)`: a fresh scratch project inside its
        own fresh parent directory, wired to a fresh recording board."""
        parent = tempfile.mkdtemp(prefix="relative-project-dir-run-")
        self.addCleanup(shutil.rmtree, parent, ignore_errors=True)
        project_dir = os.path.join(parent, PROJECT_NAME)
        os.mkdir(project_dir)
        board = RecordingBoard()
        self.addCleanup(board.close)
        install_project(project_dir, board.url, PROJECT_KEY)
        tests_dir = Path(project_dir, "tests")
        tests_dir.mkdir()
        (tests_dir / "__init__.py").write_text("")
        (tests_dir / "test_counts.py").write_text(COUNTS_TEST_SOURCE)
        return parent, project_dir, board

    def _drive(self, verb, project_dir_arg, cwd, board):
        env = scrubbed_env()
        for key in _EXTRA_ENV_TO_SCRUB:
            env.pop(key, None)
        cmd = [str(REAL_VENV_PYTHON), str(CLIENT_PATH), verb,
               "--start-dir", "tests", "--pattern", "test_*.py",
               "--project-dir", project_dir_arg, "--agent", AGENT,
               "--python", str(REAL_VENV_PYTHON)]
        completed = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True,
                                   text=True, timeout=180)
        return _Run(completed, board)

    def _assert_files_the_counts(self, label, run):
        self.assertEqual(
            run.posts_to(COMPILE), [],
            f"{label}: no compile failure may be filed; the board received "
            f"{run.posts_to(COMPILE)!r} ({run.describe()})")
        passed, failed = run.filed_counts()
        self.assertEqual(
            (passed, failed), ([EXPECTED_PASSED], [EXPECTED_FAILED]),
            f"{label}: exactly one parsed ingest of {EXPECTED_PASSED} passed "
            f"and {EXPECTED_FAILED} failed; got passed={passed!r} "
            f"failed={failed!r} ({run.describe()})")
        return passed, failed

    def _assert_relative_matches_absolute(self, verb):
        _, abs_project_dir, abs_board = self._make_project()
        absolute = self._drive(verb, abs_project_dir, cwd=abs_project_dir,
                               board=abs_board)
        abs_counts = self._assert_files_the_counts(
            f"{verb} with the absolute --project-dir (fixture)", absolute)

        parent, _, rel_board = self._make_project()
        relative = self._drive(verb, PROJECT_NAME, cwd=parent, board=rel_board)
        label = (f"{verb} started from the project's parent with "
                 f"--project-dir {PROJECT_NAME}")
        rel_counts = self._assert_files_the_counts(label, relative)
        self.assertEqual(
            rel_counts, abs_counts,
            f"{label}: must file the same pass and fail counts as the "
            f"absolute run")
        self.assertNotEqual(
            relative.code, 0,
            f"{label}: the scratch suite holds a failing test, so the run "
            f"exits non-zero ({relative.describe()})")

    def test_a_test_run_with_a_relative_project_dir_files_the_same_counts_as_the_absolute_path(self):
        self._assert_relative_matches_absolute("test")

    def test_a_pre_merge_gate_with_a_relative_project_dir_files_the_same_counts_as_the_absolute_path(self):
        self._assert_relative_matches_absolute("pre-merge-gate")


if __name__ == "__main__":
    unittest.main()
