"""Python's `test` verb on the ONE shared run path, streamed (CR-CRU-224).

Drives the REAL `clients/python-crucible.py` `test` verb as a genuine OS
subprocess, against the shared fake interpreter (`write_fake_python`, which
writes the Crucible event stream to the file `CRUCIBLE_STREAM` names, as the
client's own runner does) and the shared stand-in board (`RecordingBoard`,
which holds an open run's stream as the real board does) -- never the live
:3849/:3850 Crucible server.

What is pinned:

- the run opens (`/api/v2/runs/start`) before the suite is spawned, and is
  closed (`/api/v2/runs`) after it;
- a streamed run posts no in-run `running N` count (the board shows the
  stream's own count); its closing message is `ran <test-end count>/<run-end
  total>`, then `ingesting…`, both before the close (CR-CRU-224 §S3, AC8);
- a line the runner printed before a still-blocked test is on stderr and in
  `--log` while that test is still running.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    RecordingBoard,
    first_index,
    heartbeat_index,
    install_project,
    scrubbed_env,
    write_fake_python,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_SCRIPT = REPO_ROOT / "clients" / "python-crucible.py"

AGENT = "python-run-lifecycle-fixture"
PROJECT_KEY = "test-key-python-run-lifecycle"


def _environment(**fake):
    env = scrubbed_env(None, **fake)
    env.pop("CRUCIBLE_STREAM", None)
    return env


class NarratedPythonTestRunFinalizesThroughTheSharedPathTest(unittest.TestCase):
    """The run opens before the suite, narrates no in-run count, and lands its
    closing count and `ingesting…` before the close."""

    TOTAL = 12

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="python-run-lifecycle-")
        self.board = RecordingBoard()
        install_project(self.tmpdir, self.board.url, PROJECT_KEY)
        self.fake_python = write_fake_python(self.tmpdir)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_run_opens_before_the_suite_narrates_no_in_run_count_and_lands_its_final_count_before_the_close(self):
        spawn_stamp = os.path.join(self.tmpdir, "spawn-stamp")
        log_path = os.path.join(self.tmpdir, "run.log")
        env = _environment(FAKE_TOTAL=self.TOTAL, FAKE_SPAWN_STAMP=spawn_stamp)
        cmd = [sys.executable, str(PYTHON_SCRIPT), "test",
               "--python", self.fake_python,
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT,
               "--log", log_path]
        result = subprocess.run(cmd, cwd=self.tmpdir, env=env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(
            result.returncode, 0,
            f"a green wrapped python run exits 0; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        posts = self.board.posts()
        paths = [p for p, _ in posts]
        messages = self.board.messages()

        start_idx = first_index(posts, lambda p, b: p == "/api/v2/runs/start")
        close_idx = first_index(posts, lambda p, b: p == "/api/v2/runs")
        self.assertIsNotNone(start_idx, f"must POST /api/v2/runs/start; paths={paths!r}")
        self.assertIsNotNone(close_idx, f"the run must be closed; paths={paths!r}")
        assert start_idx is not None and close_idx is not None
        self.assertLess(start_idx, close_idx,
                        f"the run is OPENED before it is closed; paths={paths!r}")
        self.assertEqual(posts[close_idx][1].get("codec"), "crucible-events",
                         "the run is closed from its stream")
        with open(spawn_stamp) as f:
            spawned_at = float(f.read())
        self.assertLess(
            self.board.received_at(start_idx), spawned_at,
            "/api/v2/runs/start reaches the board BEFORE the suite is spawned")

        self.assertEqual(
            [m for m in messages if str(m).startswith("running")], [],
            f"a streamed run posts no in-run count -- the board shows the "
            f"stream's own; messages={messages!r}")

        final_message = f"ran {self.TOTAL}/{self.TOTAL}"
        final_idx = heartbeat_index(posts, final_message)
        self.assertIsNotNone(
            final_idx,
            f"the run ends with the closing count {final_message!r}, the "
            f"stream's test-end count over its run-end total; messages={messages!r}")
        ingesting_idx = heartbeat_index(posts, "ingesting…")
        self.assertIsNotNone(ingesting_idx, f"messages={messages!r}")
        assert final_idx is not None and ingesting_idx is not None
        self.assertLess(final_idx, ingesting_idx,
                        "the closing count lands BEFORE 'ingesting…' replaces it")
        self.assertLess(ingesting_idx, close_idx,
                        "'ingesting…' is posted BEFORE the close")


class PythonTestRunnerOutputReachesStderrAndLogWhileTheSuiteIsStillRunningTest(unittest.TestCase):
    """Python's `test` verb, with a fake interpreter that blocks mid-suite."""

    MARKER = "PYTHON_LIVE_STREAM_MARKER_4471"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="python-run-live-stream-")
        self.board = RecordingBoard()
        install_project(self.tmpdir, self.board.url, PROJECT_KEY)
        self.fake_python = write_fake_python(self.tmpdir)
        self.release_file = os.path.join(self.tmpdir, "release")
        self.log_path = os.path.join(self.tmpdir, "run.log")
        self.stderr_path = os.path.join(self.tmpdir, "stderr.txt")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_a_line_printed_before_a_blocking_test_is_visible_before_that_test_ends(self):
        env = _environment(FAKE_TOTAL=2, FAKE_BLOCK_AFTER_INDEX=1,
                           FAKE_RELEASE_FILE=self.release_file,
                           FAKE_MARKER_LINE=self.MARKER)
        cmd = [sys.executable, str(PYTHON_SCRIPT), "test",
               "--python", self.fake_python, "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT, "--log", self.log_path]
        with open(self.stderr_path, "wb") as stderr_file:
            proc = subprocess.Popen(cmd, cwd=self.tmpdir, env=env,
                                    stdout=subprocess.DEVNULL, stderr=stderr_file)
        visible_before_release = False
        try:
            deadline = time.time() + 5.0
            while time.time() < deadline:
                if self._marker_visible():
                    visible_before_release = True
                    break
                time.sleep(0.05)
        finally:
            open(self.release_file, "w").close()
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

        self.assertTrue(
            visible_before_release,
            f"a line the runner printed BEFORE its blocking test finished is on "
            f"stderr AND in --log while that test is still running; "
            f"stderr so far={self._read(self.stderr_path)!r} "
            f"log so far={self._read(self.log_path)!r}")
        self.assertEqual(
            proc.returncode, 0,
            f"the wrapped run still finishes cleanly once released; "
            f"stderr={self._read(self.stderr_path)!r}")

    def _marker_visible(self):
        return (self.MARKER in self._read(self.stderr_path)
                and self.MARKER in self._read(self.log_path))

    @staticmethod
    def _read(path):
        if not os.path.exists(path):
            return ""
        with open(path, errors="replace") as f:
            return f.read()


if __name__ == "__main__":
    unittest.main()
