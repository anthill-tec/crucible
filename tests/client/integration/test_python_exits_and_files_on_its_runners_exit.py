"""A python runner that failed is never filed or exited as green.

Every python body that runs a test runner — `_test_run` (reached through
`cmd_test`: `test` and the declared tier verbs) and `_regression_run`
(reached through `cmd_regression`: `regression` and `pre-merge-gate`) — sends
the runner's exit as `runnerExit` on its ingest, builds its envelope's `run:`
counts from the ingest response's `run` (its own parse when the response
carries none), and exits non-zero whenever the runner exited non-zero, the
ingest was not `ok`, or the run it filed has a failure. The board, handed a
non-zero `runnerExit` over a run that records no failure, adds one failing
case — suite `runner`, case `exit <n>` — before it stores the run.

`PythonRunnerExitOnARealBoardTest`
    The client half, against a recording board answering in the server's
    shapes: a fake interpreter whose runner exits 1 over a passing-only
    stream, through `test`, `regression` and `pre-merge-gate` — the one close
    carries `runnerExit: 1` over a relayed stream that records no failure,
    the envelope's `run` counts are the board's answer (the runner case
    included), and the verb exits non-zero. A runner killed by SIGKILL sends
    `runnerExit: 137`. A runner exiting non-zero with no stream exits
    non-zero and closes no run as a test result. A clean runner over a
    passing stream is filed and exits exactly as before. The board's half —
    the `runner / exit N` case it adds and counts — is held in bun by
    `tests/integration/run-ingest-runner-exit.test.ts`.

`PythonRunnerExitReachesTheIngestTest`
    Against a recording board: what the ingest body CARRIES as `runnerExit`,
    and the exit of a clean runner whose ingest was refused.

Every run drives the real `clients/python-crucible.py` as a subprocess, with a
fake interpreter (`--python`) that writes its Crucible event stream to the
file the client names (`CRUCIBLE_STREAM`, CR-CRU-224) and exits as the test
asks; the run is closed from that stream (`codec: "crucible-events"`).

Invocation:
    python3 -m unittest tests.client.integration.test_python_exits_and_files_on_its_runners_exit -v
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
    load_toon,
    new_scratch,
    scrubbed_env,
    stream_sent,
)

TOON = load_toon()
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
TIMEOUT = 120

RUNS_INGEST = "/api/v2/runs"
COMPILE_INGEST = "/api/v2/runs/compile"

PASSING_CLASS = "fake_module.FakeCase"
PASSING_CASE = "test_adds_two_numbers"

# Keys that would let the shell running this suite decide what the client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("PY_CRUCIBLE_PYTHON", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "PYTHON_CRUCIBLE_PROJECT_DIR")

# A fake interpreter. Run as the suite (`<subtest_runner> ... -v`, bare or
# under `-m coverage run`), it writes one passing case as a Crucible event
# stream to the file `CRUCIBLE_STREAM` names (unless FAKE_REPORT=none), then
# exits FAKE_EXIT, or kills itself with FAKE_SIGNAL. A coverage.py probe
# (`-c <script>`) answers that the project declares its source; `-m coverage
# lcov` has no data to report.
_FAKE_PYTHON = r'''
import json
import os
import signal
import sys

CLASS, CASE = ''' + repr((PASSING_CLASS, PASSING_CASE)) + r'''

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
if argv[:2] == ["-m", "coverage"] and argv[2:3] != ["run"]:
    sys.exit(1)
stream_path = os.environ.pop("CRUCIBLE_STREAM", None)
sys.stderr.write("%s (%s.%s) ... ok\n" % (CASE, CLASS, CASE))
sys.stderr.write("\n----------------------------------------------------------------------\n"
                 "Ran 1 test in 0.001s\n\nOK\n")
sys.stderr.flush()
if stream_path and os.environ.get("FAKE_REPORT") != "none":
    with open(stream_path, "w", encoding="utf-8") as handle:
        for event in (dict(event="run-start", total=1),
                      dict(event="test-end", id=CLASS + "." + CASE, name=CASE,
                           suite=CLASS, file="fake_module.py", status="pass",
                           duration_ms=1),
                      dict(event="run-end", total=1, passed=1, failed=0, pending=0)):
            handle.write(json.dumps(event) + "\n")
            handle.flush()
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


class _FakeInterpreterProject:
    """A scratch project with a fake interpreter, driven through the real
    client."""

    def make_project(self):
        self.project = new_scratch("python-runner-exit-")
        Path(self.project, "tests").mkdir()
        self.fake_python = os.path.join(self.project, "fake_python.py")
        Path(self.fake_python).write_text("#!" + sys.executable + "\n" + _FAKE_PYTHON)
        os.chmod(self.fake_python,
                 os.stat(self.fake_python).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def drive(self, verb, agent, extra=(), **fake_env):
        env = scrubbed_env(None, **fake_env)
        for key in _SCRUBBED:
            env.pop(key, None)
        for key in ("FAKE_EXIT", "FAKE_SIGNAL", "FAKE_REPORT"):
            if key not in fake_env:
                env.pop(key, None)
        cmd = [sys.executable, str(PYTHON_CLIENT), verb, "--agent", agent,
               "--project-dir", self.project, "--python", self.fake_python,
               "--reports", "reports", *extra]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is not one TOON envelope; {_diagnostics(result)}")
        return envelope or {}


# ── The client half of the runner case, against a recording board ──────────

class PythonRunnerExitOnARealBoardTest(_FakeInterpreterProject, unittest.TestCase):
    """The run the client sends, the envelope it prints and its exit, for a
    runner whose exit disagrees with its report. The board answers the close
    with the `run` block the server answers for that stream and exit (the
    runner case counted); the case itself is the server's, held in bun by
    `tests/integration/run-ingest-runner-exit.test.ts`."""

    PROJECT_KEY = "py-runner-exit-live-half-key"

    def setUp(self):
        self.board = RecordingBoard()
        self.make_project()

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def drive_filed(self, verb, agent, extra=(), **fake_env):
        install_project(self.project, self.board.url, self.PROJECT_KEY,
                        "python-runner-exit-e2e")
        if fake_env.get("FAKE_EXIT", "0") != "0" or "FAKE_SIGNAL" in fake_env:
            # The server's answer for a passing stream and a non-zero exit:
            # the stream's one pass and the `runner / exit N` case it adds.
            self.board.script_run(passed=1, failed=1)
        else:
            self.board.script_run(passed=1)
        return self.drive(verb, agent, extra, **fake_env)

    def the_one_stored_run(self, agent, result):
        """The one close the client sent, `{"body", "held"}`: its body and
        the stream its run holds, read as the board's codec counts it."""
        bodies = [b for p, b in self.board.posts() if p == RUNS_INGEST]
        self.assertEqual(
            len(bodies), 1,
            f"exactly one test run is filed for this agent; "
            f"posts={[p for p, _ in self.board.posts()]!r} {_diagnostics(result)}")
        body = bodies[0]
        self.assertEqual(body.get("agentId"), agent,
                         f"the run is filed under its agent; "
                         f"agentId={body.get('agentId')!r}")
        self.assertEqual(body.get("codec"), "crucible-events",
                         "a unittest run is closed from its stream")
        return {"body": body,
                "held": stream_sent(self.board, body.get("runId") or "")}

    def runner_suites(self, sent):
        return [s for s in (sent["held"].get("tree") or [])
                if s.get("name") == "runner"]

    def assert_sent(self, sent, *, code):
        """The stream relayed holds the run's one pass and no `runner` case
        of the client's own, and the close states the runner's exit as
        `runnerExit` — from which the board adds the `runner / exit N` case."""
        self.assertEqual(self.runner_suites(sent), [],
                         f"the client adds no `runner` suite itself; "
                         f"tree={sent['held'].get('tree')!r}")
        self.assert_counts(sent["held"].get("summary") or {}, total=1,
                           passed=1, failed=0, where="the stream relayed")
        body = sent["body"]
        self.assertEqual(body.get("runnerExit"), code,
                         f"runnerExit={body.get('runnerExit')!r}")
        self.assertIs(type(body.get("runnerExit")), int,
                      "runnerExit is sent as an integer")

    def assert_runner_case_filed(self, sent, code, result):
        self.assert_sent(sent, code=code)

    def assert_counts(self, counts, *, total, passed, failed, where):
        self.assertEqual(
            (counts.get("total"), counts.get("passed"), counts.get("failed")),
            (total, passed, failed),
            f"{where} counts (total, passed, failed); got {counts!r}")

    def assert_no_test_result_filed(self, agent):
        # A run with no report keeps filing what it files today (a compile
        # record, or the opened run closed as aborted) — never a test result.
        filed = [b for p, b in self.board.posts() if p == RUNS_INGEST
                 and isinstance(b, dict) and b.get("agentId") == agent]
        self.assertEqual(filed, [], "a run with no report files no test result")

    def assert_filed_red_with_the_runner_case(self, verb, agent, extra=()):
        result = self.drive_filed(verb, agent, extra, FAKE_EXIT="1")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 1, result)
        envelope = self.envelope_of(result)
        self.assertEqual(envelope.get("verb"), verb,
                         f"the envelope speaks for the verb invoked; "
                         f"envelope={envelope!r}")
        self.assert_counts(envelope.get("run") or {}, total=2, passed=1,
                           failed=1, where="the envelope's run")

    # -- one verb per body --------------------------------------------------

    def test_test_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "test", "py-runner-exit-test-parsed")

    def test_regression_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "regression", "py-runner-exit-regression-parsed")

    def test_pre_merge_gate_whose_runner_exits_1_over_a_passing_report_is_not_green(self):
        self.assert_filed_red_with_the_runner_case(
            "pre-merge-gate", "py-runner-exit-gate-parsed", ("--skip-check",))

    def test_a_runner_killed_by_sigkill_files_exit_137(self):
        agent = "py-runner-exit-test-sigkill"
        result = self.drive_filed("test", agent, FAKE_SIGNAL="KILL")
        self.assertNotEqual(result.returncode, 0,
                            f"a killed runner never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 128 + int(signal.SIGKILL), result)

    # -- no report ----------------------------------------------------------

    def test_test_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        result = self.drive_filed("test", "py-runner-exit-test-no-report",
                                  FAKE_EXIT="1", FAKE_REPORT="none")
        self.assertNotEqual(
            result.returncode, 0,
            f"a runner that exited 1 and wrote no report exits non-zero — "
            f"the compile ingest's code never decides it; {_diagnostics(result)}")
        self.assert_no_test_result_filed("py-runner-exit-test-no-report")

    def test_regression_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        result = self.drive_filed("regression", "py-runner-exit-regression-no-report",
                                  FAKE_EXIT="1", FAKE_REPORT="none")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 and wrote no report exits "
                            f"non-zero; {_diagnostics(result)}")
        self.assert_no_test_result_filed("py-runner-exit-regression-no-report")

    # -- nothing else changes ----------------------------------------------

    def test_a_clean_runner_over_a_passing_report_is_filed_green_and_exits_zero(self):
        agent = "py-runner-exit-test-clean"
        result = self.drive_filed("test", agent, FAKE_EXIT="0")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        event = self.the_one_stored_run(agent, result)
        self.assert_sent(event, code=0)
        envelope = self.envelope_of(result)
        self.assert_counts(envelope.get("run") or {}, total=1, passed=1,
                           failed=0, where="the envelope's run")


# ── What the ingest carries, against a recording board ─────────────────────

class PythonRunnerExitReachesTheIngestTest(_FakeInterpreterProject, unittest.TestCase):
    """The ingest body states the runner's exit; a refused ingest after a
    clean runner exits non-zero."""

    PROJECT_KEY = "py-runner-exit-recording-key"

    def setUp(self):
        self.board = RecordingBoard()
        self.make_project()
        Path(self.project, ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def the_one_ingest(self, path, result):
        bodies = [b for p, b in self.board.posts() if p == path]
        self.assertEqual(len(bodies), 1,
                         f"exactly one {path} ingest; posts={self.board.posts()!r} "
                         f"{_diagnostics(result)}")
        if path == RUNS_INGEST:
            self.assertEqual(bodies[0].get("codec"), "crucible-events",
                             "a unittest run is closed from its stream")
            self.assertNotIn("data", bodies[0])
        return bodies[0]

    def assert_runner_exit(self, body, code):
        self.assertIn("runnerExit", body,
                      f"the ingest body states the runner's exit; "
                      f"keys={sorted(body)!r}")
        self.assertEqual(body["runnerExit"], code,
                         f"runnerExit={body['runnerExit']!r}")
        self.assertIs(type(body["runnerExit"]), int,
                      "runnerExit is sent as an integer, never a string or bool")

    def test_a_clean_test_run_sends_runner_exit_0_on_its_runs_ingest(self):
        result = self.drive("test", "py-runner-exit-carry-clean", FAKE_EXIT="0")
        self.assert_runner_exit(self.the_one_ingest(RUNS_INGEST, result), 0)

    def test_a_test_runner_exiting_1_sends_runner_exit_1_on_its_runs_ingest(self):
        result = self.drive("test", "py-runner-exit-carry-test", FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(RUNS_INGEST, result), 1)

    def test_a_regression_runner_exiting_1_sends_runner_exit_1_on_its_runs_ingest(self):
        result = self.drive("regression", "py-runner-exit-carry-regression",
                            FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(RUNS_INGEST, result), 1)

    def test_a_runner_killed_by_sigkill_sends_runner_exit_137(self):
        result = self.drive("test", "py-runner-exit-carry-sigkill",
                            FAKE_SIGNAL="KILL")
        self.assert_runner_exit(self.the_one_ingest(RUNS_INGEST, result),
                                128 + int(signal.SIGKILL))

    def test_a_refused_ingest_after_a_clean_test_runner_exits_non_zero(self):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive("test", "py-runner-exit-refused-test", FAKE_EXIT="0")
        self.the_one_ingest(RUNS_INGEST, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")

    def test_a_refused_ingest_after_a_clean_regression_runner_exits_non_zero(self):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive("regression", "py-runner-exit-refused-regression",
                            FAKE_EXIT="0")
        self.the_one_ingest(RUNS_INGEST, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")


if __name__ == "__main__":
    unittest.main()
