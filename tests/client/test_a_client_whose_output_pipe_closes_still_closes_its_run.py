"""CR-CRU-175 \u00a7S3/AC3 RED \u2014 a client whose stdout OR stderr pipe closes still
closes its run: it either completes and files normally, or \u2014 when it truly
cannot continue \u2014 closes the run itself through `abort_run`, naming the
closed pipe. Gap analysis DRIFT-5 names the two death points fixed here:
`run_streamed`'s per-line echo to `sys.stderr` (closing it mid-run kills the
runner via the existing `except BaseException: proc.kill(); ...; raise`, and
nothing downstream ever closes the run that opened) and the final TOON
envelope / legacy-line writes (`emit_axi`'s `sys.stdout.write`/
`print(..., file=sys.stderr)`), which today crash UNCAUGHT once their pipe is
already gone.

Confirmed against the CURRENT (un-fixed) fleet, for every one of the five
clients, driven as a real subprocess against a `RecordingBoard`:

* STDOUT closed before the client ever gets to write its envelope (the read
  end is closed WITHOUT reading \u2014 exactly what is left behind once the
  reader side of `| head` has read what it wanted and exited): the suite
  itself still runs fine and the run DOES get filed (`run_streamed` only
  echoes to stderr, never stdout) \u2014 but CPython's own interpreter-
  finalization flush of the still-buffered envelope write then raises
  `BrokenPipeError`, which today is UNHANDLED: it prints "Exception ignored
  in: <stdout> ... BrokenPipeError" during shutdown and CPython sets the
  process's own exit status to its documented 120 ("could not flush a
  standard stream at exit") instead of the real suite outcome (0 \u2014 every
  fake case here passes). That mismatched exit code, and the unhandled-
  exception noise on the still-open stderr, is the "final envelope ...
  writes raising it again" DRIFT-5 names.

* STDERR closed WHILE the runner is still mid-suite (the client's own
  `[crucible] run started: ...` line, and the runner's first lines, have
  already reached it \u2014 the run is genuinely open and running \u2014 then the
  reader stops reading, exactly what `| head -N` leaves behind once its N
  lines are in): `run_streamed`'s echo loop hits `BrokenPipeError` on its
  very next write, its `except BaseException` kills the runner and
  re-raises, and NOTHING downstream of that point ever runs \u2014 no JUnit is
  parsed, no ingest POST is made, no `abort_run` is called. The board is left
  showing only `/api/v2/runs/start`: a run nothing is driving, the exact
  double-entry incident this CR describes.

RED today (confirmed by driving every one of the five clients' `test`/`unit`
verb as a real subprocess against a `RecordingBoard` with each pipe closed in
turn, both scenarios above reproduced on every client): the stdout scenario's
exit code is 120 on every client (never the real 0), and the stderr
scenario's board shows `/api/v2/runs/start` and NOTHING else \u2014 no filed
ingest, no abort \u2014 on every client. Every assertion below is checked
against the `RecordingBoard`'s own request log (never against the client's
own closed stdout), the one channel that stays observable whichever pipe
closed.

Invocation:
    python3 -m unittest tests.client.test_a_client_whose_output_pipe_closes_still_closes_its_run -v
"""

import shutil
import subprocess
import sys
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    drive_and_close_stderr,
    install_project,
    new_scratch,
    scrubbed_env,
    write_fake_bun,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_native,
    write_fake_python,
)

AGENT = "pipe-close-fixture"
PROJECT_KEY = "test-key-pipe-close"
PROJECT_NAME = "pipe-close-fixture-project"
RUN_ID = "run-live-1"

# The board's own ingest routes (mirrors `_crucible_axi.RUN_INGEST_PATHS` plus
# the compile route \u2014 every path an ingest that carries a `runId` can land
# on, across all five clients: `/api/v2/runs` (mvn/rust/arduino's raw JUnit
# ingest), `/api/v2/runs/parsed` (bun/python's parsed-tree ingest),
# `/api/v2/runs/compile` (the no-report compile fallback).
INGEST_PATHS = ("/api/v2/runs", "/api/v2/runs/parsed", "/api/v2/runs/compile")


class _PipeCloseCase(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("pipe-close-")
        self.scratch = new_scratch("pipe-close-scratch-")
        self.bin_dir = new_scratch("pipe-close-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    def tearDown(self):
        self.board.close()
        for d in (self.project, self.scratch, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=3, **extra)

    # -- shared board-side facts -----------------------------------------

    def filed_posts(self, run_id):
        return [(p, b) for p, b in self.board.posts()
                if p in INGEST_PATHS and isinstance(b, dict)
                and b.get("runId") == run_id]

    def aborts_for(self, run_id):
        return [(p, b) for p, b in self.board.aborts()
                if isinstance(b, dict) and b.get("runId") == run_id]

    def assert_run_opened(self, run_id=RUN_ID):
        paths = [p for p, _ in self.board.posts()]
        self.assertIn(
            "/api/v2/runs/start", paths,
            f"the run must have been opened before the pipe closed; "
            f"posts={self.board.posts()!r}")

    def assert_run_settled(self, pipe_name, run_id=RUN_ID):
        """AC3 \u2014 a run whose `pipe_name` pipe closed must leave nothing for
        the board's own sweep to find: it was FILED (an ingest POST carrying
        its runId) or ABORTED (exactly one `.../abort` POST naming the closed
        pipe) \u2014 never neither, never both. Returns whether it was FILED."""
        filed = self.filed_posts(run_id)
        aborts = self.aborts_for(run_id)
        self.assertTrue(
            filed or aborts,
            f"a run whose {pipe_name} pipe closed mid-flight must settle \u2014 "
            f"filed OR aborted \u2014 but the board shows NEITHER today; "
            f"posts={self.board.posts()!r}")
        self.assertFalse(
            bool(filed) and bool(aborts),
            f"a settled run is filed XOR aborted, never both; "
            f"filed={filed!r} aborts={aborts!r}")
        if aborts:
            self.assertEqual(len(aborts), 1, f"exactly one abort; got {aborts!r}")
            reason = (aborts[0][1].get("reason") or "").lower()
            self.assertIn(
                pipe_name, reason,
                f"an abort closing a run whose {pipe_name} pipe closed must "
                f"name it in its reason; got reason={reason!r}")
        return bool(filed)


# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
# STDOUT closes before the client ever writes to it
# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550


class StdoutClosedTest(_PipeCloseCase):
    """The reader of the client's stdout is gone before the client ever gets
    to write its one envelope line (exactly what is left behind once `| head`
    has read what it wanted and exited): nothing but that one final write
    ever touches stdout (`run_streamed` echoes to stderr ONLY), so the suite
    still completes and the run still files \u2014 but the exit code must still
    report the REAL suite outcome (0 \u2014 every fake case here passes) rather
    than CPython's generic "could not flush a stream at exit" 120, and the
    still-open stderr must carry no unhandled-exception noise."""

    def drive(self, cmd, env):
        proc = subprocess.Popen(cmd, cwd=self.project, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        assert proc.stdout is not None and proc.stderr is not None
        proc.stdout.close()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        stderr = proc.stderr.read()
        return proc.returncode, stderr

    def assert_clean_exit_despite_closed_stdout(self, returncode, stderr):
        self.assert_run_opened()
        filed = self.assert_run_settled("stdout")
        self.assertTrue(
            filed,
            f"nothing here ever blocks completion (only stdout, never "
            f"stderr, closed) \u2014 the run must be FILED, not aborted; "
            f"posts={self.board.posts()!r}")
        self.assertEqual(
            returncode, 0,
            f"every fake case here passes \u2014 the exit code must say so, "
            f"not carry CPython's generic stream-flush-failure code (120); "
            f"stderr tail={stderr[-2000:]!r}")
        self.assertNotIn(
            "BrokenPipeError", stderr,
            f"the closed stdout pipe must be swallowed, not surfaced as an "
            f"unhandled exception on the still-open stderr; "
            f"stderr tail={stderr[-2000:]!r}")

    def test_bun_test_with_stdout_closed(self):
        fake = write_fake_bun(self.project, 3)
        rc, err = self.drive(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT], self.env())
        self.assert_clean_exit_despite_closed_stdout(rc, err)

    def test_mvn_unit_with_stdout_closed(self):
        write_fake_mvnw(self.project)
        rc, err = self.drive(
            [sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
             "--test", "LiveCase*", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_clean_exit_despite_closed_stdout(rc, err)

    def test_python_test_with_stdout_closed(self):
        fake = write_fake_python(self.project)
        rc, err = self.drive(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_clean_exit_despite_closed_stdout(rc, err)

    def test_rust_test_with_stdout_closed(self):
        write_fake_cargo(self.bin_dir)
        rc, err = self.drive(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
             "--crate", "fake-crate", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_clean_exit_despite_closed_stdout(rc, err)

    def test_arduino_unit_with_stdout_closed(self):
        write_fake_native(self.project)
        rc, err = self.drive(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_clean_exit_despite_closed_stdout(rc, err)


# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
# STDERR closes WHILE the runner is still mid-suite
# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550


class StderrClosedTest(_PipeCloseCase):
    """The reader of the client's stderr is gone WHILE the suite is still
    running (the client's own "run started" line, and the fake runner's
    first line, have already reached it \u2014 the run is genuinely open \u2014 then
    the reader stops reading, exactly what `| head -N` leaves behind once its
    N lines are in): `run_streamed`'s per-line echo must stop teeing into the
    dead pipe WITHOUT losing the run it is driving \u2014 the suite still
    completes and the run still settles, filed or (if the client truly cannot
    continue) aborted with a reason naming the closed stderr."""

    def drive(self, cmd, env):
        reached, returncode, stdout, pre_close_lines = drive_and_close_stderr(
            cmd, self.project, env, self.scratch)
        self.assertTrue(
            reached,
            f"the runner never blocked \u2014 the marker never reached stderr "
            f"before it was closed; lines={pre_close_lines!r}")
        return returncode, stdout

    def test_bun_test_with_stderr_closed_mid_run(self):
        fake = write_fake_bun(self.project, 3)
        self.drive(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT], self.env())
        self.assert_run_opened()
        self.assert_run_settled("stderr")

    def test_mvn_unit_with_stderr_closed_mid_run(self):
        write_fake_mvnw(self.project)
        self.drive(
            [sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
             "--test", "LiveCase*", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_run_opened()
        self.assert_run_settled("stderr")

    def test_python_test_with_stderr_closed_mid_run(self):
        fake = write_fake_python(self.project)
        self.drive(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_run_opened()
        self.assert_run_settled("stderr")

    def test_rust_test_with_stderr_closed_mid_run(self):
        write_fake_cargo(self.bin_dir)
        self.drive(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
             "--crate", "fake-crate", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_run_opened()
        self.assert_run_settled("stderr")

    def test_arduino_unit_with_stderr_closed_mid_run(self):
        write_fake_native(self.project)
        self.drive(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_run_opened()
        self.assert_run_settled("stderr")


if __name__ == "__main__":
    unittest.main()
