"""A bun runner that failed is never filed or exited as green.

Every bun body that runs a test runner (`cmd_test`, `cmd_regression`) sends
the runner's exit as `runnerExit` on its ingest, builds its envelope's `run:`
counts from the ingest response's `run`, and exits non-zero whenever the
runner exited non-zero or the run it filed has a failure. The board, handed a
non-zero `runnerExit` over a run that records no failure, adds one failing
case — suite `runner`, case `exit <n>` — before it stores the run.

`RunnerExitOnARealBoardTest`
    End to end against a REAL scratch board (`tests/client/real_board.py`):
    a fake runner that exits 1 over a passing-only report, on the parsed route
    (`test`, `regression`) and on the Playwright raw-report route (a declared
    `test:e2e` whose report the board decodes) — the stored run carries the
    `runner / exit 1` case, the envelope's `run` counts include it, and the
    verb exits non-zero. A runner killed by SIGKILL files `exit 137`. A runner
    exiting non-zero with no report exits non-zero. A clean runner over a
    passing report is filed and exits exactly as before.

`RunnerExitReachesTheIngestTest`
    Against a recording board: what each route's ingest body CARRIES as
    `runnerExit`, and the exit of a clean runner whose ingest was refused.

Every run drives the real `clients/bun-crucible.py` as a subprocess, with a
fake `bun` that writes its reports where the client told it to and exits as
the test asks.

Invocation:
    python3 -m unittest tests.client.test_bun_exits_and_files_on_its_runners_exit -v
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
    load_toon,
    new_scratch,
    scrubbed_env,
)
from tests.client.real_board import RealBoard

TOON = load_toon()
BUN_CLIENT = CLIENTS / "bun-crucible.py"
TIMEOUT = 120

PARSED_INGEST = "/api/v2/runs/parsed"
RAW_INGEST = "/api/v2/runs"
COMPILE_INGEST = "/api/v2/runs/compile"

PASSING_CASE = "adds two numbers"
PASSING_FILE = "math.test.ts"
SCENARIO = "a visitor signs in"

# The declared `test:e2e` target's report variables: its JUnit path and the
# Playwright report the board decodes.
JUNIT_VAR = "FAKE_RUNNER_JUNIT_PATH"
RAW_VAR = "FAKE_RUNNER_PLAYWRIGHT_PATH"

E2E_MANIFEST = {
    "name": "runner-exit-fixture", "private": True,
    "scripts": {"test:e2e": "playwright test"},
    "crucible": {
        "reportPath": {"test:e2e": f"env:{JUNIT_VAR}"},
        "rawReport": {"test:e2e": {"codec": "playwright",
                                   "file": "playwright.json",
                                   "path": f"env:{RAW_VAR}"}},
    },
}
PLAIN_MANIFEST = {"name": "runner-exit-fixture", "private": True}

# Keys that would let the shell running this suite decide what the client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
             "BUN_CRUCIBLE_BUN", "BUN_CRUCIBLE_NO_LIFECYCLE",
             "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", JUNIT_VAR, RAW_VAR)

# A fake `bun`. It writes one passing JUnit case wherever `--reporter-outfile=`
# or the declared JUnit variable points, and a one-scenario passing
# Playwright report wherever the declared raw variable points — unless
# FAKE_REPORT=none — then exits FAKE_EXIT, or kills itself with FAKE_SIGNAL.
_FAKE_BUN = r'''
import json
import os
import signal
import sys

JUNIT_VAR, RAW_VAR = ''' + repr((JUNIT_VAR, RAW_VAR)) + r'''
CASE, FILE, SCENARIO = ''' + repr((PASSING_CASE, PASSING_FILE, SCENARIO)) + r'''


def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)


argv = sys.argv[1:]
junit = os.environ.get(JUNIT_VAR)
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
    if RAW_VAR in os.environ:
        write(os.environ[RAW_VAR], json.dumps({"suites": [{
            "title": "Sign-in", "specs": [{
                "title": SCENARIO, "file": "sign-in.feature",
                "tests": [{"projectName": "chromium", "results": [{
                    "status": "passed", "duration": 4,
                    "steps": [{"title": "Given a registered visitor",
                               "duration": 2}]}]}]}]}]}))
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
    _BOARD = RealBoard(bun, "bun-runner-exit-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class RunnerExitOnARealBoardTest(_FakeRunnerProject, unittest.TestCase):
    """The run the board stores, the envelope the client prints and the
    client's exit, for a runner whose exit disagrees with its report."""

    def setUp(self):
        board = _BOARD
        if board is None:
            self.fail("the module's real board was never booted")
        self.board = board
        self.make_project(PLAIN_MANIFEST)

    def tearDown(self):
        shutil.rmtree(self.project, ignore_errors=True)

    def use_manifest(self, manifest):
        Path(self.project, "package.json").write_text(json.dumps(manifest, indent=2))

    def drive_filed(self, verb, agent, **fake_env):
        self.board.install(self.project)
        return self.drive(verb, agent, **fake_env)

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

    # -- the parsed route --------------------------------------------------

    def test_test_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        agent = "runner-exit-test-parsed"
        result = self.drive_filed("test", agent, FAKE_EXIT="1")
        self.assertNotEqual(result.returncode, 0,
                            f"a runner that exited 1 never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 1, result)
        self.assert_counts(event.get("summary") or {}, total=2, passed=1,
                           failed=1, where="the stored run's")
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
        self.assert_counts(event.get("summary") or {}, total=2, passed=1,
                           failed=1, where="the stored run's")
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

    # -- the Playwright raw-report route -----------------------------------

    def test_a_declared_e2e_target_exiting_1_over_a_passing_playwright_report_files_the_runner_case(self):
        self.use_manifest(E2E_MANIFEST)
        agent = "runner-exit-e2e-raw"
        result = self.drive_filed("e2e", agent, FAKE_EXIT="1")
        self.assertNotEqual(result.returncode, 0,
                            f"a declared target that exited 1 never exits "
                            f"green; {_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assertEqual(event.get("codec"), "playwright",
                         f"fixture guard: the run went the raw route; "
                         f"event codec={event.get('codec')!r}")
        self.assert_runner_case_filed(event, 1, result)
        self.assert_counts(event.get("summary") or {}, total=2, passed=1,
                           failed=1, where="the stored run's")
        envelope = self.envelope_of(result)
        self.assert_counts(envelope.get("run") or {}, total=2, passed=1,
                           failed=1, where="the envelope's run")

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
        self.assertEqual(self.runner_suites(event), [],
                         f"a clean runner adds no `runner` suite; "
                         f"tree={event.get('tree')!r}")
        self.assert_counts(event.get("summary") or {}, total=1, passed=1,
                           failed=0, where="the stored run's")
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

    def test_a_clean_test_run_sends_runner_exit_0_on_the_parsed_ingest(self):
        result = self.drive("test", "runner-exit-carry-clean", FAKE_EXIT="0")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result), 0)

    def test_a_test_runner_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        result = self.drive("test", "runner-exit-carry-test", FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result), 1)

    def test_a_regression_runner_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        result = self.drive("regression", "runner-exit-carry-regression",
                            FAKE_EXIT="1")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result), 1)

    def test_a_runner_killed_by_sigkill_sends_runner_exit_137(self):
        result = self.drive("test", "runner-exit-carry-sigkill",
                            FAKE_SIGNAL="KILL")
        self.assert_runner_exit(self.the_one_ingest(PARSED_INGEST, result),
                                128 + int(signal.SIGKILL))

    def test_a_declared_e2e_target_exiting_1_sends_runner_exit_1_on_the_raw_ingest(self):
        Path(self.project, "package.json").write_text(json.dumps(E2E_MANIFEST, indent=2))
        result = self.drive("e2e", "runner-exit-carry-e2e", FAKE_EXIT="1")
        body = self.the_one_ingest(RAW_INGEST, result)
        self.assertEqual(body.get("codec"), "playwright",
                         f"fixture guard: the raw route; body={body!r}")
        self.assert_runner_exit(body, 1)

    def test_a_refused_ingest_after_a_clean_test_runner_exits_non_zero(self):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive("test", "runner-exit-refused-test", FAKE_EXIT="0")
        self.the_one_ingest(PARSED_INGEST, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")

    def test_a_refused_ingest_after_a_clean_regression_runner_exits_non_zero(self):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive("regression", "runner-exit-refused-regression",
                            FAKE_EXIT="0")
        self.the_one_ingest(PARSED_INGEST, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")


if __name__ == "__main__":
    unittest.main()
