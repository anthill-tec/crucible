"""An arduino runner that failed is never filed or exited as green.

The arduino body that runs a test runner — `_run_native_tests` (`test`,
`unit`, `regression`, the declared make targets, `pre-merge-gate`) — sends the
runner's exit (`make`'s, the process whose report it files) as `runnerExit` on
its ingest, builds its envelope's `run:` counts from the ingest response's
`run` (its own parse when the response carries none), and exits non-zero
whenever the runner exited non-zero, the ingest was not `ok`, or the run it
filed has a failure. A run without `--agent` files nothing and exits non-zero
when the runner did or its report records a failure.

`ArduinoRunnerExitOnARealBoardTest`
    End to end against a REAL scratch board (`tests/client/real_board.py`):
    a fake `make` that exits 1 over a passing-only JUnit report, through
    `unit` and `pre-merge-gate` — the stored run carries the `runner / exit 1`
    case, the envelope's `run` counts include it, and the verb exits non-zero.
    A `make` killed by SIGKILL files `exit 137`. A runner exiting non-zero
    with no report exits non-zero. A clean runner over a passing report is
    filed and exits exactly as before.

`ArduinoRunnerExitReachesTheIngestTest`
    Against a recording board: what the ingest body CARRIES as `runnerExit`,
    and the exit of a clean runner whose ingest was refused.

`ArduinoRunWithoutAgentExitsOnItsRunnerTest`
    No `--agent`: nothing is filed, and the exit is non-zero when the runner
    exited non-zero over a clean report or exited 0 over a failing one; a
    clean runner over a clean report exits 0.

Every run drives the real `clients/arduino-crucible.py` as a subprocess, with a
fake `make` first on PATH that writes its JUnit report into `REPORTS_DIR`
(else `reports/` under `--dir`) and exits as the test asks.

Invocation:
    python3 -m unittest tests.client.test_arduino_exits_and_files_on_its_runners_exit -v
"""

import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    INGEST_PATHS,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.real_board import RealBoard

TOON = load_toon()
ARDUINO_CLIENT = CLIENTS / "arduino-crucible.py"
TIMEOUT = 120
NATIVE_DIR = "tests/native"

PARSED_INGEST = "/api/v2/runs/parsed"

# Keys that would let the shell running this suite decide what the client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "AGENT_ID")
_FAKE_KEYS = ("FAKE_EXIT", "FAKE_SIGNAL", "FAKE_REPORT")

# A fake `make`. Given any target, it prints Unity's verdict line and writes
# one JUnit case into REPORTS_DIR (else `reports/` under its cwd): passing, or
# failing when FAKE_REPORT=failing, or nothing when FAKE_REPORT=none — then
# exits FAKE_EXIT, or kills itself with FAKE_SIGNAL.
_FAKE_MAKE = r'''
import os
import signal
import sys

report = os.environ.get("FAKE_REPORT", "passing")
reports_dir = os.environ.get("REPORTS_DIR") or "reports"
verdict = "FAIL" if report == "failing" else "PASS"
sys.stdout.write("test_native.c:11:test_native_case_1:%s\n" % verdict)
sys.stdout.write("-----------------------\n1 Tests %d Failures 0 Ignored\n"
                 % (1 if report == "failing" else 0))
sys.stdout.flush()
if report != "none":
    os.makedirs(reports_dir, exist_ok=True)
    body = ('<failure message="planted">expected 1 to be 2</failure>'
            if report == "failing" else "")
    with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as handle:
        handle.write('<?xml version="1.0"?><testsuite name="native" tests="1" '
                     'failures="%d"><testcase classname="native" '
                     'name="test_native_case_1" time="0.001">%s</testcase>'
                     '</testsuite>' % (1 if body else 0, body))
name = os.environ.get("FAKE_SIGNAL")
if name:
    os.kill(os.getpid(), getattr(signal, "SIG" + name))
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout!r} "
            f"stderr={result.stderr[-2500:]!r}")


class _FakeMakeProject:
    """A scratch firmware project with a fake `make` on PATH, driven through
    the real client."""

    def make_project(self):
        self.project = new_scratch("arduino-runner-exit-")
        self.native_dir = os.path.join(self.project, *NATIVE_DIR.split("/"))
        os.makedirs(self.native_dir)
        self.bin_dir = os.path.join(self.project, "bin")
        os.makedirs(self.bin_dir)
        fake_make = os.path.join(self.bin_dir, "make")
        Path(fake_make).write_text("#!" + sys.executable + "\n" + _FAKE_MAKE)
        os.chmod(fake_make, os.stat(fake_make).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def drive(self, verb, agent=None, extra=(), **fake_env):
        env = scrubbed_env(self.bin_dir, **fake_env)
        for key in _SCRUBBED:
            env.pop(key, None)
        for key in _FAKE_KEYS:
            if key not in fake_env:
                env.pop(key, None)
        cmd = [sys.executable, str(ARDUINO_CLIENT), verb,
               "--project-dir", self.project, "--dir", NATIVE_DIR,
               *(["--agent", agent] if agent else []), *extra]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is not one TOON envelope; {_diagnostics(result)}")
        return envelope or {}


def _point_at_recording_board(project, board, key):
    Path(project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={key}\n")
    Path(project, "crucible.toml").write_text(
        f"[client]\nurl = {json.dumps(board.url)}\n")


# ── End to end, against a real board ────────────────────────────────────────

_BOARD: RealBoard | None = None


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        raise unittest.SkipTest(
            "the board that adds the runner's case is a REAL server, and "
            "without `bun` there is none to boot — a missing toolchain, not "
            "a passing assertion")
    _BOARD = RealBoard(bun, "arduino-runner-exit-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class ArduinoRunnerExitOnARealBoardTest(_FakeMakeProject, unittest.TestCase):
    """The run the board stores, the envelope the client prints and the
    client's exit, for a runner whose exit disagrees with its report."""

    def setUp(self):
        board = _BOARD
        if board is None:
            self.fail("the module's real board was never booted")
        self.board = board
        self.make_project()

    def tearDown(self):
        shutil.rmtree(self.project, ignore_errors=True)

    def drive_filed(self, verb, agent, extra=(), **fake_env):
        self.board.install(self.project)
        return self.drive(verb, agent, extra, **fake_env)

    def the_one_stored_run(self, agent, result):
        events = self.board.test_events(agent)
        self.assertEqual(
            len(events), 1,
            f"exactly one test run is filed for this agent; events={events!r} "
            f"{_diagnostics(result)}")
        return self.board.event(events[0]["id"])

    def runner_suites(self, event):
        return [s for s in (event.get("tree") or []) if s.get("name") == "runner"]

    def assert_runner_case_filed(self, event, code, result):
        runner = self.runner_suites(event)
        self.assertEqual(
            len(runner), 1,
            f"the stored run holds exactly one `runner` suite; "
            f"tree={event.get('tree')!r} {_diagnostics(result)}")
        children = runner[0].get("children") or []
        self.assertEqual(len(children), 1, f"runner suite={runner[0]!r}")
        case = children[0]
        self.assertEqual(case.get("name"), f"exit {code}", f"case={case!r}")
        self.assertEqual(case.get("status"), "fail", f"case={case!r}")
        self.assertEqual(
            (case.get("failure") or {}).get("message"),
            f"the runner exited {code} but its report records no failure",
            f"case={case!r}")

    def assert_counts(self, counts, *, total, passed, failed, where):
        self.assertEqual(
            (counts.get("total"), counts.get("passed"), counts.get("failed")),
            (total, passed, failed),
            f"{where} counts (total, passed, failed); got {counts!r}")

    def assert_filed_red_with_the_runner_case(self, verb, agent, extra=()):
        result = self.drive_filed(verb, agent, extra, FAKE_EXIT="1")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 1, result)
        self.assert_counts(event.get("summary") or {}, total=2, passed=1,
                           failed=1, where="the stored run's")
        envelope = self.envelope_of(result)
        self.assertEqual(envelope.get("verb"), verb,
                         f"the envelope speaks for the verb invoked; "
                         f"envelope={envelope!r}")
        self.assert_counts(envelope.get("run") or {}, total=2, passed=1,
                           failed=1, where="the envelope's run")

    def test_unit_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "unit", "ard-runner-exit-unit-parsed", ("--reports", "reports"))

    def test_pre_merge_gate_whose_runner_exits_1_over_a_passing_report_is_not_green(self):
        self.assert_filed_red_with_the_runner_case(
            "pre-merge-gate", "ard-runner-exit-gate-parsed", ("--skip-check",))

    def test_a_runner_killed_by_sigkill_files_exit_137(self):
        agent = "ard-runner-exit-test-sigkill"
        result = self.drive_filed("test", agent, ("--reports", "reports"),
                                  FAKE_SIGNAL="KILL")
        self.assertNotEqual(result.returncode, 0,
                            f"a killed runner never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 128 + int(signal.SIGKILL), result)

    def test_unit_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        agent = "ard-runner-exit-unit-no-report"
        result = self.drive_filed("unit", agent, ("--reports", "reports"),
                                  FAKE_EXIT="1", FAKE_REPORT="none")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 and wrote no report exits "
                            f"non-zero; {_diagnostics(result)}")
        # The run opened before `make` is closed as aborted, as today; no
        # test run is ever filed as a result.
        filed = [e for e in self.board.test_events(agent)
                 if e.get("status") != "aborted"]
        self.assertEqual(filed, [], "a run with no report files no test result")

    def test_a_clean_runner_over_a_passing_report_is_filed_green_and_exits_zero(self):
        agent = "ard-runner-exit-unit-clean"
        result = self.drive_filed("unit", agent, ("--reports", "reports"),
                                  FAKE_EXIT="0")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        event = self.the_one_stored_run(agent, result)
        self.assertEqual(self.runner_suites(event), [],
                         f"a clean runner adds no `runner` suite; "
                         f"tree={event.get('tree')!r}")
        self.assert_counts(event.get("summary") or {}, total=1, passed=1,
                           failed=0, where="the stored run's")
        envelope = self.envelope_of(result)
        self.assert_counts(envelope.get("run") or {}, total=1, passed=1,
                           failed=0, where="the envelope's run")


# ── What the ingest carries, against a recording board ─────────────────────

class ArduinoRunnerExitReachesTheIngestTest(_FakeMakeProject, unittest.TestCase):
    """The ingest body states the runner's exit; a refused ingest after a
    clean runner exits non-zero."""

    PROJECT_KEY = "ard-runner-exit-recording-key"

    def setUp(self):
        self.board = RecordingBoard()
        self.make_project()
        _point_at_recording_board(self.project, self.board, self.PROJECT_KEY)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def the_one_ingest(self, path, result):
        bodies = [b for p, b in self.board.posts() if p == path]
        self.assertEqual(len(bodies), 1,
                         f"exactly one {path} ingest; posts={self.board.posts()!r} "
                         f"{_diagnostics(result)}")
        return bodies[0]

    def assert_runner_exit(self, body, code):
        self.assertIn("runnerExit", body,
                      f"the ingest body states the runner's exit; "
                      f"keys={sorted(body)!r}")
        self.assertEqual(body["runnerExit"], code,
                         f"runnerExit={body['runnerExit']!r}")
        self.assertIs(type(body["runnerExit"]), int,
                      "runnerExit is sent as an integer, never a string or bool")

    def drive_reported(self, verb, agent, **fake_env):
        return self.drive(verb, agent, ("--reports", "reports"), **fake_env)

    def test_a_clean_test_run_sends_runner_exit_0_on_the_parsed_ingest(self):
        result = self.drive_reported("test", "ard-runner-exit-carry-clean",
                                     FAKE_EXIT="0")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result), 0)

    def test_a_test_runner_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        result = self.drive_reported("test", "ard-runner-exit-carry-test",
                                     FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result), 1)

    def test_a_regression_runner_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        result = self.drive_reported("regression", "ard-runner-exit-carry-regression",
                                     FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result), 1)

    def test_a_runner_killed_by_sigkill_sends_runner_exit_137(self):
        result = self.drive_reported("test", "ard-runner-exit-carry-sigkill",
                                     FAKE_SIGNAL="KILL")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result),
                                128 + int(signal.SIGKILL))

    def test_a_refused_ingest_after_a_clean_test_runner_exits_non_zero(self):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive_reported("test", "ard-runner-exit-refused-test",
                                     FAKE_EXIT="0")
        self.the_one_ingest(PARSED_INGEST, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")


# ── No `--agent`: nothing filed, the exit is the runner's and the report's ──

class ArduinoRunWithoutAgentExitsOnItsRunnerTest(_FakeMakeProject, unittest.TestCase):
    """A run without `--agent` files nothing; it exits non-zero when the
    runner did or its report records a failure."""

    PROJECT_KEY = "ard-runner-exit-no-agent-key"

    def setUp(self):
        self.board = RecordingBoard()
        self.make_project()
        _point_at_recording_board(self.project, self.board, self.PROJECT_KEY)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def assert_nothing_filed(self, result):
        ingests = [p for p, _ in self.board.posts() if p in INGEST_PATHS]
        self.assertEqual(ingests, [],
                         f"a run without --agent files nothing; "
                         f"{_diagnostics(result)}")

    def test_a_runner_exiting_0_over_a_failing_report_exits_non_zero(self):
        result = self.drive("test", FAKE_EXIT="0", FAKE_REPORT="failing")
        self.assertNotEqual(result.returncode, 0,
                            f"a report recording a failure never exits green; "
                            f"{_diagnostics(result)}")
        self.assert_nothing_filed(result)

    def test_a_runner_exiting_1_over_a_clean_report_exits_non_zero(self):
        result = self.drive("test", FAKE_EXIT="1", FAKE_REPORT="passing")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 never exits green, whatever "
                            f"its report says; {_diagnostics(result)}")
        self.assert_nothing_filed(result)

    def test_a_clean_runner_over_a_clean_report_exits_zero(self):
        result = self.drive("test", FAKE_EXIT="0", FAKE_REPORT="passing")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        self.assert_nothing_filed(result)


if __name__ == "__main__":
    unittest.main()
