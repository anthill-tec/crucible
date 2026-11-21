"""A bun runner that failed is never filed or exited as green.

Every bun body that runs a test runner (`cmd_test`, `cmd_regression`) sends
the runner's exit as `runnerExit` on its ingest, builds its envelope's `run:`
counts from the ingest response's `run`, and exits non-zero whenever the
runner exited non-zero or the run it filed has a failure. The board, handed a
non-zero `runnerExit` over a run that records no failure, adds one failing
case — suite `runner`, case `exit <n>` — before it stores the run.

`RunnerExitOnARealBoardTest`
    The client half, against a recording board answering in the server's
    shapes: a fake runner that exits 1 over a passing-only report (`test`,
    `regression`) — the one ingest carries the passing report and
    `runnerExit: 1`, the envelope's `run` counts are the board's answer (the
    runner case included), and the verb exits non-zero. A runner killed by
    SIGKILL sends `runnerExit: 137`. A runner exiting non-zero with no report
    exits non-zero. A clean runner over a passing report is filed and exits
    exactly as before. The board's half — the `runner / exit N` case it adds
    and counts — is held in bun by
    `tests/unit/run-ingest-runner-exit.test.ts`.

`RunnerExitReachesTheIngestTest`
    Against a recording board: what each route's ingest body CARRIES as
    `runnerExit`, and the exit of a clean runner whose ingest was refused.

Every run drives the real `clients/bun-crucible.py` as a subprocess, with a
fake `bun` that writes its reports where the client told it to and exits as
the test asks.

Invocation:
    python3 -m unittest tests.client.integration.test_bun_exits_and_files_on_its_runners_exit -v
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
    RecordingBoard,
    install_project,
    junit_sent,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 120

PARSED_INGEST = "/api/v2/runs/parsed"
RAW_INGEST = "/api/v2/runs"
COMPILE_INGEST = "/api/v2/runs/compile"

PASSING_CASE = "adds two numbers"
PASSING_FILE = "math.test.ts"

PLAIN_MANIFEST = {"name": "runner-exit-fixture", "private": True}

# Keys that would let the shell running this suite decide what the client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# A fake `bun`. It writes one passing JUnit case wherever `--reporter-outfile=`
# points — unless FAKE_REPORT=none — then exits FAKE_EXIT, or kills itself
# with FAKE_SIGNAL.
_FAKE_BUN = r'''
import os
import signal
import sys

CASE, FILE = ''' + repr((PASSING_CASE, PASSING_FILE)) + r'''


def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)


argv = sys.argv[1:]
junit = None
for arg in argv:
    if arg.startswith("--reporter-outfile="):
        junit = arg.split("=", 1)[1]
sys.stdout.write(FILE + ":\n(pass) " + CASE + " [0.02ms]\n\n 1 pass\n 0 fail\n")
sys.stdout.flush()
if os.environ.get("FAKE_REPORT") != "none":
    if junit:
        write(junit,
              '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="1" failures="0">'
              '<testsuite name="%s" file="%s" tests="1" failures="0">'
              '<testcase name="%s" classname="" time="0.00002" file="%s"/>'
              '</testsuite></testsuites>' % (FILE, FILE, CASE, FILE))
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


class _FakeRunnerProject:
    """A scratch package with a fake `bun`, driven through the real client."""

    def make_project(self, manifest):
        self.project = new_scratch("bun-runner-exit-")
        Path(self.project, "package.json").write_text(json.dumps(manifest, indent=2))
        self.fake_bun = os.path.join(self.project, "fake_bun.py")
        Path(self.fake_bun).write_text("#!" + sys.executable + "\n" + _FAKE_BUN)
        os.chmod(self.fake_bun,
                 os.stat(self.fake_bun).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def drive(self, verb, agent, **fake_env):
        env = scrubbed_env(None, **fake_env)
        for key in _SCRUBBED:
            if key not in fake_env:
                env.pop(key, None)
        cmd = [sys.executable, str(BUN_CLIENT), verb, "--agent", agent,
               "--project-dir", self.project, "--package-dir", self.project,
               "--bun", self.fake_bun, "--reports", "reports"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is not one TOON envelope; {_diagnostics(result)}")
        return envelope or {}


# ── The client half of the runner case, against a recording board ──────────

class RunnerExitOnARealBoardTest(_FakeRunnerProject, unittest.TestCase):
    """The run the client sends, the envelope it prints and its exit, for a
    runner whose exit disagrees with its report. The board answers the
    ingest with the `run` block the server answers for that report and exit
    (the runner case counted); the case itself is the server's, held in bun
    by `tests/unit/run-ingest-runner-exit.test.ts`."""

    PROJECT_KEY = "runner-exit-live-half-key"

    def setUp(self):
        self.board = RecordingBoard()
        self.make_project(PLAIN_MANIFEST)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive_filed(self, verb, agent, **fake_env):
        install_project(self.project, self.board.url, self.PROJECT_KEY,
                        "bun-runner-exit-e2e")
        if fake_env.get("FAKE_EXIT", "0") != "0" or "FAKE_SIGNAL" in fake_env:
            # The server's answer for a passing report and a non-zero exit:
            # the report's one pass and the `runner / exit N` case it adds.
            self.board.script_run(passed=1, failed=1)
        else:
            self.board.script_run(passed=1)
        return self.drive(verb, agent, **fake_env)

    def the_one_stored_run(self, agent, result):
        bodies = [b for p, b in self.board.posts() if p == RAW_INGEST]
        self.assertEqual(
            len(bodies), 1,
            f"exactly one test run is filed for this agent; "
            f"posts={self.board.posts()!r} {_diagnostics(result)}")
        body = bodies[0]
        self.assertEqual(body.get("agentId"), agent,
                         f"the run is filed under its agent; body agentId="
                         f"{body.get('agentId')!r}")
        return body

    def runner_suites(self, body):
        return [s for s in ((junit_sent(body) or {}).get("tree") or [])
                if s.get("name") == "runner"]

    def assert_report_sent(self, body, *, code, result):
        """The ingest carries the runner's own report, passing only and with
        no `runner` suite of its own, and the runner's exit as `runnerExit`
        — what the board turns into the `runner / exit N` case."""
        sent = junit_sent(body) or {}
        self.assertTrue(sent, f"the ingest is a junit report; "
                              f"body keys={sorted(body)!r} {_diagnostics(result)}")
        self.assertEqual(self.runner_suites(body), [],
                         f"the client adds no `runner` suite itself; "
                         f"tree={sent.get('tree')!r}")
        self.assert_counts(sent.get("summary") or {}, total=1, passed=1,
                           failed=0, where="the report sent's")
        self.assertEqual(body.get("runnerExit"), code,
                         f"runnerExit={body.get('runnerExit')!r}")
        self.assertIs(type(body.get("runnerExit")), int,
                      "runnerExit is sent as an integer")

    def assert_runner_case_filed(self, body, code, result):
        self.assert_report_sent(body, code=code, result=result)

    def assert_counts(self, counts, *, total, passed, failed, where):
        self.assertEqual(
            (counts.get("total"), counts.get("passed"), counts.get("failed")),
            (total, passed, failed),
            f"{where} counts (total, passed, failed); got {counts!r}")

    # -- the parsed route --------------------------------------------------

    def test_test_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        agent = "runner-exit-test-parsed"
        result = self.drive_filed("test", agent, FAKE_EXIT="1")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 1, result)
        envelope = self.envelope_of(result)
        self.assert_counts(envelope.get("run") or {}, total=2, passed=1,
                           failed=1, where="the envelope's run")

    def test_regression_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        agent = "runner-exit-regression-parsed"
        result = self.drive_filed("regression", agent, FAKE_EXIT="1")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 1, result)
        envelope = self.envelope_of(result)
        self.assert_counts(envelope.get("run") or {}, total=2, passed=1,
                           failed=1, where="the envelope's run")

    def test_a_runner_killed_by_sigkill_files_exit_137(self):
        agent = "runner-exit-test-sigkill"
        result = self.drive_filed("test", agent, FAKE_SIGNAL="KILL")
        self.assertNotEqual(result.returncode, 0,
                            f"a killed runner never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 137, result)

    # -- no report ----------------------------------------------------------

    def test_test_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        result = self.drive_filed("test", "runner-exit-test-no-report",
                                  FAKE_EXIT="1", FAKE_REPORT="none")
        self.assertNotEqual(
            result.returncode, 0,
            f"a runner that exited 1 and wrote no report exits non-zero — "
            f"the compile ingest's code never decides it; {_diagnostics(result)}")

    def test_regression_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        result = self.drive_filed("regression", "runner-exit-regression-no-report",
                                  FAKE_EXIT="1", FAKE_REPORT="none")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 and wrote no report exits "
                            f"non-zero; {_diagnostics(result)}")

    # -- nothing else changes ----------------------------------------------

    def test_a_clean_runner_over_a_passing_report_is_filed_green_and_exits_zero(self):
        agent = "runner-exit-test-clean"
        result = self.drive_filed("test", agent, FAKE_EXIT="0")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        event = self.the_one_stored_run(agent, result)
        self.assert_report_sent(event, code=0, result=result)
        envelope = self.envelope_of(result)
        self.assert_counts(envelope.get("run") or {}, total=1, passed=1,
                           failed=0, where="the envelope's run")


# ── What the ingest carries, against a recording board ─────────────────────

class RunnerExitReachesTheIngestTest(_FakeRunnerProject, unittest.TestCase):
    """The ingest body states the runner's exit on every route; a refused
    ingest after a clean runner exits non-zero."""

    PROJECT_KEY = "runner-exit-recording-key"

    def setUp(self):
        self.board = RecordingBoard()
        self.make_project(PLAIN_MANIFEST)
        self.point_at_recording_board()

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def point_at_recording_board(self):
        Path(self.project, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")

    def the_one_ingest(self, path, result):
        self.assertEqual([p for p, _b in self.board.posts() if p == PARSED_INGEST], [],
                         f"bun never posts to {PARSED_INGEST}; {_diagnostics(result)}")
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

    def test_a_clean_test_run_sends_runner_exit_0_on_the_runs_ingest(self):
        result = self.drive("test", "runner-exit-carry-clean", FAKE_EXIT="0")
        self.assert_runner_exit(self.the_one_ingest(RAW_INGEST, result), 0)

    def test_a_test_runner_exiting_1_sends_runner_exit_1_on_the_runs_ingest(self):
        result = self.drive("test", "runner-exit-carry-test", FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(RAW_INGEST, result), 1)

    def test_a_regression_runner_exiting_1_sends_runner_exit_1_on_the_runs_ingest(self):
        result = self.drive("regression", "runner-exit-carry-regression",
                            FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(RAW_INGEST, result), 1)

    def test_a_runner_killed_by_sigkill_sends_runner_exit_137(self):
        result = self.drive("test", "runner-exit-carry-sigkill",
                            FAKE_SIGNAL="KILL")
        self.assert_runner_exit(self.the_one_ingest(RAW_INGEST, result),
                                128 + int(signal.SIGKILL))

    def test_a_refused_ingest_after_a_clean_test_runner_exits_non_zero(self):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive("test", "runner-exit-refused-test", FAKE_EXIT="0")
        self.the_one_ingest(RAW_INGEST, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")

    def test_a_refused_ingest_after_a_clean_regression_runner_exits_non_zero(self):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive("regression", "runner-exit-refused-regression",
                            FAKE_EXIT="0")
        self.the_one_ingest(RAW_INGEST, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")


if __name__ == "__main__":
    unittest.main()
