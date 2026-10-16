"""Every suite-running verb on python-crucible.py -- `test`, the five tier
verbs (`unit`, `module`, `integration`, `e2e`, `bdd`), `regression`, and
`pre-merge-gate` -- builds its suite invocation through `_xmlrunner_cmd`,
which spawns the suite as `[<python>, "-m", "xmlrunner", ...]` (optionally
wrapped in `coverage run` for `pre-merge-gate`). None of them spawns a runner
module of this client's own; the bare `-m xmlrunner` invocation is the one
`python-crucible.py` builds today for every one of these verbs.

This file drives each verb against a real interpreter and a fixture with NO
subtests at all, and inspects the ACTUAL spawned command line the client
printed on its own `[crucible] running: ...` stderr line (the same line
`_test_run`/`_regression_run` already print before the suite is spawned) --
not an internal mock. Each verb must spawn its suite through a runner module
of the client's own (chosen here as `subtest_runner.py`, landed beside
`toon.py`), never the bare `-m xmlrunner` module invocation, and a run with
no subtests must still report the same totals it does today.

Fixture names and the runner module's name are chosen for this file alone."""

import contextlib
import io
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import RecordingBoard, install_project, load_client

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

AGENT = "every-verb-runner-fixture-agent"
PROJECT_KEY = "every-verb-runner-fixture-key"

# Chosen for this file: the name a runner module of this client's own would
# carry once it ships beside toon.py. Nothing in `python-crucible.py` spawns
# a file by this name today -- every verb spawns the bare `-m xmlrunner`
# module invocation instead.
RUNNER_MODULE_FILENAME = "subtest_runner.py"

# A plain fixture with no `subTest` at all -- the "unchanged where there are
# no subtests" case, checked alongside the spawned-command assertion below.
NO_SUBTEST_FIXTURE_SOURCE = '''\
import unittest


class PlainOnlyCase(unittest.TestCase):
    def test_one(self):
        self.assertEqual(1 + 1, 2)

    def test_two(self):
        self.assertTrue("a" in "abc")
'''

RUNNING_LINE_RE = re.compile(r"^\[crucible\] running: (.+)$", re.MULTILINE)

# Every suite-running verb, with the flags each needs: the five tier cells
# are DECLARED cells on this stack and refuse without `--start-dir`;
# `regression`/`pre-merge-gate` require `--agent`, already supplied below.
VERBS = (
    "test", "unit", "module", "integration", "e2e", "bdd",
    "regression", "pre-merge-gate",
)


def _run_main(module, argv):
    full_argv = ["python-crucible.py"] + list(argv)
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            if exc.code is None:
                code = 0
            elif isinstance(exc.code, int):
                code = exc.code
            else:
                code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _suite_running_line(stderr_text):
    """The ONE `[crucible] running: ...` line that spawns the SUITE itself --
    excluding `pre-merge-gate`'s separate py_compile check-step line, which
    carries the same prefix but names no xmlrunner/runner invocation at
    all."""
    candidates = [line for line in RUNNING_LINE_RE.findall(stderr_text)
                  if "py_compile" not in line]
    assert candidates, (
        f"no suite-spawning '[crucible] running: ...' line found; "
        f"stderr={stderr_text!r}")
    return candidates[-1]


def _last_parsed_payload(board):
    parsed = [body for path, body in board.posts() if path == "/api/v2/runs/parsed"]
    assert parsed, f"no /api/v2/runs/parsed POST observed; posts={board.posts()!r}"
    return parsed[-1]


class EveryVerbRunsThroughItsOwnRunnerModuleTest(unittest.TestCase):
    """`test`, every tier verb, `regression` and `pre-merge-gate` must spawn
    the suite through a runner module of this client's own, never the bare
    `-m xmlrunner` module invocation -- shown by each verb's own spawned
    command line. A run with no subtests at all must still report the
    totals it does today (2 passing, 0 failing)."""

    def setUp(self):
        self.assertTrue(
            REAL_VENV_PYTHON.exists(),
            f"this file needs a real interpreter with unittest-xml-reporting "
            f"4.0.0 installed; expected one at {REAL_VENV_PYTHON}")

    def _run_verb(self, verb):
        project_dir = tempfile.mkdtemp(prefix=f"every-verb-{verb}-")
        self.addCleanup(shutil.rmtree, project_dir, ignore_errors=True)
        board = RecordingBoard()
        self.addCleanup(board.close)
        install_project(project_dir, board.url, PROJECT_KEY)
        tests_dir = os.path.join(project_dir, "tests")
        os.makedirs(tests_dir, exist_ok=True)
        Path(os.path.join(tests_dir, "__init__.py")).write_text("", encoding="utf-8")
        Path(os.path.join(tests_dir, "fixture_plain.py")).write_text(
            NO_SUBTEST_FIXTURE_SOURCE, encoding="utf-8")
        argv = [verb, "--start-dir", "tests", "--pattern", "fixture_plain.py",
                "--project-dir", project_dir, "--agent", AGENT,
                "--python", str(REAL_VENV_PYTHON)]
        _code, _out, err = _run_main(load_client("python-crucible.py"), argv)
        return err, board

    def test_every_suite_running_verb_spawns_its_own_runner_module_not_bare_xmlrunner(self):
        for verb in VERBS:
            with self.subTest(verb=verb):
                err, board = self._run_verb(verb)
                cmd_line = _suite_running_line(err)
                tokens = cmd_line.split()
                self.assertNotIn(
                    "xmlrunner", tokens,
                    f"{verb}: must spawn its suite through a runner module "
                    f"of this client's own, never the bare `-m xmlrunner` "
                    f"module invocation `_xmlrunner_cmd` still builds for "
                    f"every verb today; got cmd={cmd_line!r}")
                self.assertTrue(
                    any(tok.endswith(RUNNER_MODULE_FILENAME) for tok in tokens),
                    f"{verb}: expected the suite to run through "
                    f"{RUNNER_MODULE_FILENAME!r} (shipped beside toon.py), "
                    f"named on the verb's own spawned command line; "
                    f"got cmd={cmd_line!r}")
                payload = _last_parsed_payload(board)
                summary = payload["summary"]
                self.assertEqual(
                    summary["total"], 2,
                    f"{verb}: a fixture with no subtests at all must still "
                    f"report the SAME totals it does today (2 passing "
                    f"tests, 0 failing); got summary={summary!r}")
                self.assertEqual(summary["passed"], 2, f"{verb}: {summary!r}")
                self.assertEqual(summary["failed"], 0, f"{verb}: {summary!r}")


if __name__ == "__main__":
    unittest.main()
