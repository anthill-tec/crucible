"""Every suite-running verb on python-crucible.py -- `test`, the five tier
verbs (`unit`, `module`, `integration`, `e2e`, `bdd`), `regression`, and
`pre-merge-gate` -- spawns its suite through the client's own runner module
(`subtest_runner.py`, shipped beside `toon.py`) with the runner's own command
line (`discover -s <dir> -p <pattern> -v`, no `-o`), and files the run from
the Crucible event stream that runner writes (CR-CRU-224 §S1, §S3).

This file drives each verb against the repo's own interpreter, a fixture
with no subtests at all, and a stand-in board that holds an open run's stream
as the real board does (`RecordingBoard`). It inspects the spawned command
line the client prints on its own `[crucible] running: ...` stderr line, the
stream the board holds for the run, and the close (`POST /api/v2/runs` with
`runId`, `codec: "crucible-events"` and no `data`).

Fixture names are chosen for this file alone."""

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
from tests.client.live_run_harness import (
    RecordingBoard,
    install_project,
    load_client,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

AGENT = "every-verb-runner-fixture-agent"
PROJECT_KEY = "every-verb-runner-fixture-key"
RUN_ID = "run-live-1"

RUNNER_MODULE_FILENAME = "subtest_runner.py"

# A plain fixture with no `subTest` at all.
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

# The tier each verb's close states (`test` states none).
TIERS = {"test": None, "unit": "unit", "module": "module",
         "integration": "integration", "e2e": "e2e", "bdd": "bdd",
         "regression": "regression", "pre-merge-gate": "regression"}


def _run_main(module, argv):
    full_argv = ["python-crucible.py"] + list(argv)
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
            mock.patch.dict(os.environ, {}, clear=False), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        os.environ.pop("CRUCIBLE_STREAM", None)
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
    excluding `pre-merge-gate`'s separate py_compile check-step line."""
    candidates = [line for line in RUNNING_LINE_RE.findall(stderr_text)
                  if "py_compile" not in line]
    assert candidates, (
        f"no suite-spawning '[crucible] running: ...' line found; "
        f"stderr={stderr_text!r}")
    return candidates[-1]


class EveryVerbRunsThroughItsOwnRunnerModuleTest(unittest.TestCase):
    """Each suite-running verb spawns the client's own runner with the
    runner's command line, and closes its run from the stream it wrote: a
    run with no subtests reports 2 passing, 0 failing."""

    def setUp(self):
        self.assertTrue(REAL_VENV_PYTHON.exists(),
                        f"this file needs the repo's interpreter at {REAL_VENV_PYTHON}")

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
        code, _out, err = _run_main(load_client("python-crucible.py"), argv)
        return code, err, board

    def test_every_suite_running_verb_spawns_its_own_runner_and_closes_from_its_stream(self):
        for verb in VERBS:
            with self.subTest(verb=verb):
                code, err, board = self._run_verb(verb)
                tokens = _suite_running_line(err).split()
                self.assertTrue(
                    any(tok.endswith(RUNNER_MODULE_FILENAME) for tok in tokens),
                    f"{verb}: the suite runs through {RUNNER_MODULE_FILENAME!r}; "
                    f"got {tokens!r}")
                self.assertNotIn("xmlrunner", " ".join(tokens).lower(), tokens)
                self.assertNotIn("-o", tokens,
                                 f"{verb}: the runner writes no report dir (`-o` is gone)")
                self.assertEqual(tokens[-1], "-v", tokens)
                held = board.held_stream(RUN_ID)
                test_ends = [line for line in held.splitlines() if '"test-end"' in line]
                self.assertEqual(len(test_ends), 2,
                                 f"{verb}: the board holds the run's two cases; "
                                 f"held={held!r} stderr={err[-2000:]!r}")
                self.assertEqual(sum('"pass"' in line for line in test_ends), 2, held)
                closes = [body for path, body in board.posts() if path == "/api/v2/runs"]
                self.assertEqual(len(closes), 1, f"{verb}: posts={board.posts()!r}")
                close = closes[0]
                self.assertEqual(close.get("codec"), "crucible-events", close)
                self.assertEqual(close.get("runId"), RUN_ID)
                self.assertNotIn("data", close)
                self.assertEqual(close.get("runnerExit"), 0)
                self.assertEqual(close.get("tier"), TIERS[verb], close)
                if verb == "pre-merge-gate":
                    coverage = close.get("coverage") or {}
                    self.assertEqual(coverage.get("codec"), "lcov",
                                     "the gate's coverage travels with the close")
                self.assertEqual(code, 0, f"{verb}: stderr={err[-2000:]!r}")

    def test_the_gate_exits_non_zero_when_the_board_flags_the_stream_incomplete(self):
        project_dir = tempfile.mkdtemp(prefix="every-verb-incomplete-")
        self.addCleanup(shutil.rmtree, project_dir, ignore_errors=True)
        board = RecordingBoard()
        self.addCleanup(board.close)
        board.script_run(passed=2, warnings=[{
            "code": "stream-incomplete",
            "detail": "the stream cannot be trusted: no run-end — the run is stored "
                      "flagged incomplete"}])
        install_project(project_dir, board.url, PROJECT_KEY)
        os.makedirs(os.path.join(project_dir, "tests"))
        Path(project_dir, "tests", "__init__.py").write_text("", encoding="utf-8")
        Path(project_dir, "tests", "fixture_plain.py").write_text(
            NO_SUBTEST_FIXTURE_SOURCE, encoding="utf-8")
        code, out, err = _run_main(
            load_client("python-crucible.py"),
            ["pre-merge-gate", "--start-dir", "tests", "--pattern", "fixture_plain.py",
             "--project-dir", project_dir, "--agent", AGENT,
             "--python", str(REAL_VENV_PYTHON)])
        closes = [body for path, body in board.posts() if path == "/api/v2/runs"]
        self.assertEqual([c.get("codec") for c in closes], ["crucible-events"],
                         f"stderr={err[-2000:]!r}")
        self.assertIn("stream-incomplete", out)
        self.assertNotEqual(code, 0, "an incomplete stream never passes the gate")


if __name__ == "__main__":
    unittest.main()
