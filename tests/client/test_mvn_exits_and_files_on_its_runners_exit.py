"""A maven runner that failed is never filed or exited as green.

Every maven body that runs a test runner — `_surefire_tier_run` (`unit`,
`module`, the declared profiles), `_failsafe_tier_run` (`integration`, `e2e`),
`cmd_regression` (`regression`, `pre-merge-gate`) and `_test_run` (`test`) —
sends the runner's exit as `runnerExit` on its ingest, on both the
junit-directory route (`/api/v2/runs`, the board decodes the reports) and the
parsed route (`/api/v2/runs/parsed`), builds its envelope's `run:` counts from
the ingest response's `run`, and exits non-zero whenever the runner exited
non-zero, the ingest was not `ok`, or the run it filed has a failure. A run
with no report exits non-zero when the runner did: the compile ingest's code
never decides it. The board, handed a non-zero `runnerExit` over a run that
records no failure, adds one failing case — suite `runner`, case `exit <n>`.

`MavenRunnerExitOnARealBoardTest`
    End to end against a REAL scratch board (`tests/client/real_board.py`):
    a fake `mvnw` whose build exits 1 over passing-only surefire/failsafe
    reports, through `unit` and `test` (the junit-directory route) and
    `module` over two report files, `integration`, `regression` and
    `pre-merge-gate` (the parsed route) — the stored run carries the
    `runner / exit 1` case, the envelope's `run` counts include it, and the
    verb exits non-zero. A build killed by SIGKILL files `exit 137`. A failing
    report makes `unit` and `module` exit non-zero even when maven itself
    exited 0. A clean build over a passing report is filed and exits exactly
    as before.

`MavenRunnerExitReachesTheIngestTest`
    Against a recording board: what the ingest body CARRIES as `runnerExit`,
    the exit of a clean build whose ingest was refused, and the exit of a
    build that exited non-zero and wrote no report.

Every run drives the real `clients/mvn-crucible.py` as a subprocess with a
fake `mvnw` wrapper in the project root, which writes its JUnit reports where
the client told surefire/failsafe to (`-D<plugin>.reportsDirectory=<dir>`) and
exits as the test asks.

Invocation:
    python3 -m unittest tests.client.test_mvn_exits_and_files_on_its_runners_exit -v
"""

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
)
from tests.client.real_board import RealBoard

TOON = load_toon()
MVN_CLIENT = CLIENTS / "mvn-crucible.py"
TIMEOUT = 120

RAW_INGEST = "/api/v2/runs"
PARSED_INGEST = "/api/v2/runs/parsed"

# Keys that would let the shell running this suite decide what the client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "MVN_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_MAVEN_DIR",
             "MVN_CRUCIBLE_COMPOSE_FILE")
_FAKE_KEYS = ("FAKE_EXIT", "FAKE_SIGNAL", "FAKE_REPORT", "FAKE_CLASSES",
              "FAKE_FAILING")

# A fake `mvnw`. `test-compile` (the client's compile fallback) is a clean
# build. Any other invocation is a test run: it writes FAKE_CLASSES (default
# 1) report files, one passing case each, into every reports directory the
# client handed it (`-Dsurefire.reportsDirectory=` / `-Dfailsafe...`, one
# write per distinct directory) — the last case failing when FAKE_FAILING=1,
# none at all when FAKE_REPORT=none — then exits FAKE_EXIT, or kills itself
# with FAKE_SIGNAL.
_FAKE_MVNW = r'''
import os
import signal
import sys

args = sys.argv[1:]
if "test-compile" in args:
    sys.stdout.write("[INFO] BUILD SUCCESS\n")
    sys.exit(0)
dirs = []
for arg in args:
    for flag in ("-Dsurefire.reportsDirectory=", "-Dfailsafe.reportsDirectory="):
        if arg.startswith(flag) and arg[len(flag):] not in dirs:
            dirs.append(arg[len(flag):])
dirs = dirs or [os.path.join("target", "surefire-reports")]
count = int(os.environ.get("FAKE_CLASSES", "1"))
failing = os.environ.get("FAKE_FAILING") == "1"
classes = ["com.acme.RunnerExit%dTest" % i for i in range(1, count + 1)]
for name in classes:
    sys.stdout.write("[INFO] Running %s\n" % name)
sys.stdout.flush()
if os.environ.get("FAKE_REPORT") != "none":
    for directory in dirs:
        os.makedirs(directory, exist_ok=True)
        for index, name in enumerate(classes, 1):
            fails = failing and index == count
            body = ('<failure message="planted">planted failure</failure>'
                    if fails else "")
            with open(os.path.join(directory, "TEST-%s.xml" % name), "w") as handle:
                handle.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                             '<testsuite name="%s" tests="1" failures="%d" '
                             'errors="0" skipped="0"><testcase name="adds" '
                             'classname="%s" time="0.001">%s</testcase>'
                             '</testsuite>\n' % (name, 1 if fails else 0, name, body))
name = os.environ.get("FAKE_SIGNAL")
if name:
    os.kill(os.getpid(), getattr(signal, "SIG" + name))
sys.stdout.write("[INFO] BUILD %s\n" % ("SUCCESS" if os.environ.get("FAKE_EXIT", "0") == "0"
                                         else "FAILURE"))
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''

# A `docker` stand-in for the gate's compose bring-up and teardown: it exits 0,
# so a test never reaches the host's real docker.
_FAKE_DOCKER = "import sys\nsys.exit(0)\n"


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout!r} "
            f"stderr={result.stderr[-2500:]!r}")


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


class _FakeMavenProject:
    """A scratch maven project with a fake `mvnw`, driven through the real
    client."""

    def make_project(self):
        self.project = new_scratch("mvn-runner-exit-")
        _write_script(os.path.join(self.project, "mvnw"), _FAKE_MVNW)
        self.bin_dir = os.path.join(self.project, "fake-bin")
        os.makedirs(self.bin_dir)
        _write_script(os.path.join(self.bin_dir, "docker"), _FAKE_DOCKER)

    def drive(self, verb, agent, extra=(), **fake_env):
        env = scrubbed_env(self.bin_dir, **fake_env)
        for key in _SCRUBBED:
            env.pop(key, None)
        for key in _FAKE_KEYS:
            if key not in fake_env:
                env.pop(key, None)
        cmd = [sys.executable, str(MVN_CLIENT), verb, "--agent", agent,
               "--project-dir", self.project, *extra]
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
    _BOARD = RealBoard(bun, "mvn-runner-exit-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class MavenRunnerExitOnARealBoardTest(_FakeMavenProject, unittest.TestCase):
    """The run the board stores, the envelope the client prints and the
    client's exit, for a build whose exit disagrees with its reports."""

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

    def assert_filed_red_with_the_runner_case(self, verb, agent, extra=(),
                                              classes=1):
        result = self.drive_filed(verb, agent, extra, FAKE_EXIT="1",
                                  FAKE_CLASSES=str(classes))
        self.assertNotEqual(result.returncode, 0,
                            f"a build that exited 1 never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 1, result)
        self.assert_counts(event.get("summary") or {}, total=classes + 1,
                           passed=classes, failed=1, where="the stored run's")
        envelope = self.envelope_of(result)
        self.assertEqual(envelope.get("verb"), verb,
                         f"the envelope speaks for the verb invoked; "
                         f"envelope={envelope!r}")
        self.assert_counts(envelope.get("run") or {}, total=classes + 1,
                           passed=classes, failed=1, where="the envelope's run")

    def assert_failing_report_exits_non_zero(self, verb, agent, classes):
        # Maven itself exits 0 over the failing report (a build that ignores
        # test failures): the filed run's failure alone decides the exit.
        result = self.drive_filed(verb, agent, FAKE_EXIT="0",
                                  FAKE_CLASSES=str(classes), FAKE_FAILING="1")
        self.assertNotEqual(
            result.returncode, 0,
            f"a {verb} run whose report records a failure exits non-zero; "
            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assertEqual(self.runner_suites(event), [],
                         f"a run that already records a failure gets no "
                         f"`runner` case; tree={event.get('tree')!r}")
        self.assert_counts(event.get("summary") or {}, total=classes,
                           passed=classes - 1, failed=1,
                           where="the stored run's")
        self.assert_counts(self.envelope_of(result).get("run") or {},
                           total=classes, passed=classes - 1, failed=1,
                           where="the envelope's run")

    # -- one verb per body and per ingest route -----------------------------

    def test_unit_whose_build_exits_1_over_a_passing_report_files_the_runner_case(self):
        # The junit-directory route: the board decodes the reports.
        self.assert_filed_red_with_the_runner_case(
            "unit", "mvn-runner-exit-unit-junit-dir")

    def test_test_whose_build_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "test", "mvn-runner-exit-test-junit-dir")

    def test_module_over_two_report_files_whose_build_exits_1_files_the_runner_case(self):
        # Two report files pooled in the run's own directory: the parsed route.
        self.assert_filed_red_with_the_runner_case(
            "module", "mvn-runner-exit-module-parsed", classes=2)

    def test_integration_whose_build_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "integration", "mvn-runner-exit-integration-parsed")

    def test_regression_whose_build_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "regression", "mvn-runner-exit-regression-parsed")

    def test_pre_merge_gate_whose_build_exits_1_over_a_passing_report_is_not_green(self):
        self.assert_filed_red_with_the_runner_case(
            "pre-merge-gate", "mvn-runner-exit-gate-parsed")

    def test_a_build_killed_by_sigkill_files_exit_137(self):
        agent = "mvn-runner-exit-unit-sigkill"
        result = self.drive_filed("unit", agent, FAKE_SIGNAL="KILL")
        self.assertNotEqual(result.returncode, 0,
                            f"a killed build never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 128 + int(signal.SIGKILL), result)

    # -- a failing report exits non-zero ------------------------------------

    def test_unit_over_a_failing_report_exits_non_zero(self):
        self.assert_failing_report_exits_non_zero(
            "unit", "mvn-runner-exit-unit-failing", classes=1)

    def test_module_over_a_failing_report_exits_non_zero(self):
        self.assert_failing_report_exits_non_zero(
            "module", "mvn-runner-exit-module-failing", classes=2)

    # -- nothing else changes ----------------------------------------------

    def test_a_clean_unit_build_over_a_passing_report_is_filed_green_and_exits_zero(self):
        agent = "mvn-runner-exit-unit-clean"
        result = self.drive_filed("unit", agent, FAKE_EXIT="0")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        event = self.the_one_stored_run(agent, result)
        self.assertEqual(self.runner_suites(event), [],
                         f"a clean build adds no `runner` suite; "
                         f"tree={event.get('tree')!r}")
        self.assert_counts(event.get("summary") or {}, total=1, passed=1,
                           failed=0, where="the stored run's")
        self.assert_counts(self.envelope_of(result).get("run") or {}, total=1,
                           passed=1, failed=0, where="the envelope's run")

    def test_a_clean_regression_build_over_a_passing_report_is_filed_green_and_exits_zero(self):
        agent = "mvn-runner-exit-regression-clean"
        result = self.drive_filed("regression", agent, FAKE_EXIT="0")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        event = self.the_one_stored_run(agent, result)
        self.assertEqual(self.runner_suites(event), [],
                         f"a clean build adds no `runner` suite; "
                         f"tree={event.get('tree')!r}")
        self.assert_counts(self.envelope_of(result).get("run") or {}, total=1,
                           passed=1, failed=0, where="the envelope's run")


# ── What the ingest carries, against a recording board ─────────────────────

class MavenRunnerExitReachesTheIngestTest(_FakeMavenProject, unittest.TestCase):
    """The ingest body states the build's exit; a refused ingest after a clean
    build, and a build that exited non-zero with no report, exit non-zero."""

    PROJECT_KEY = "mvn-runner-exit-recording-key"

    def setUp(self):
        self.board = RecordingBoard()
        self.make_project()
        install_project(self.project, self.board.url, self.PROJECT_KEY)

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
                      f"the ingest body states the build's exit; "
                      f"keys={sorted(body)!r}")
        self.assertEqual(body["runnerExit"], code,
                         f"runnerExit={body['runnerExit']!r}")
        self.assertIs(type(body["runnerExit"]), int,
                      "runnerExit is sent as an integer, never a string or bool")

    def assert_carries(self, verb, agent, path, code, classes=1, **fake_env):
        result = self.drive(verb, agent, FAKE_CLASSES=str(classes), **fake_env)
        self.assert_runner_exit(self.the_one_ingest(path, result), code)

    # -- runnerExit on the wire ---------------------------------------------

    def test_a_clean_unit_build_sends_runner_exit_0_on_the_junit_directory_ingest(self):
        self.assert_carries("unit", "mvn-carry-unit-clean", RAW_INGEST, 0,
                            FAKE_EXIT="0")

    def test_a_unit_build_exiting_1_sends_runner_exit_1_on_the_junit_directory_ingest(self):
        self.assert_carries("unit", "mvn-carry-unit", RAW_INGEST, 1,
                            FAKE_EXIT="1")

    def test_a_test_build_exiting_1_sends_runner_exit_1_on_the_junit_directory_ingest(self):
        self.assert_carries("test", "mvn-carry-test", RAW_INGEST, 1,
                            FAKE_EXIT="1")

    def test_a_module_build_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        self.assert_carries("module", "mvn-carry-module", PARSED_INGEST, 1,
                            classes=2, FAKE_EXIT="1")

    def test_an_integration_build_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        self.assert_carries("integration", "mvn-carry-integration",
                            PARSED_INGEST, 1, FAKE_EXIT="1")

    def test_a_regression_build_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        self.assert_carries("regression", "mvn-carry-regression",
                            PARSED_INGEST, 1, FAKE_EXIT="1")

    def test_a_test_build_killed_by_sigkill_sends_runner_exit_137(self):
        self.assert_carries("test", "mvn-carry-test-sigkill", RAW_INGEST,
                            128 + int(signal.SIGKILL), FAKE_SIGNAL="KILL")

    # -- a refused ingest after a clean build --------------------------------

    def assert_refused_ingest_exits_non_zero(self, verb, agent, path):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive(verb, agent, FAKE_EXIT="0")
        self.the_one_ingest(path, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")

    def test_a_refused_ingest_after_a_clean_unit_build_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "unit", "mvn-refused-unit", RAW_INGEST)

    def test_a_refused_ingest_after_a_clean_integration_build_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "integration", "mvn-refused-integration", PARSED_INGEST)

    def test_a_refused_ingest_after_a_clean_test_build_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "test", "mvn-refused-test", RAW_INGEST)

    def test_a_refused_ingest_after_a_clean_regression_build_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "regression", "mvn-refused-regression", PARSED_INGEST)

    # -- no report, a build that exited non-zero ----------------------------

    def assert_no_report_exits_non_zero(self, verb, agent):
        # The compile fallback's `test-compile` is a clean build, so its
        # compile ingest succeeds: only the build's own exit can decide it.
        result = self.drive(verb, agent, FAKE_EXIT="1", FAKE_REPORT="none")
        self.assertNotEqual(
            result.returncode, 0,
            f"a build that exited 1 and wrote no report exits non-zero — the "
            f"compile ingest's code never decides it; {_diagnostics(result)}")
        test_ingests = [p for p, _ in self.board.posts()
                        if p in (RAW_INGEST, PARSED_INGEST)]
        self.assertEqual(test_ingests, [],
                         "a run with no report files no test result")

    def test_unit_whose_build_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("unit", "mvn-no-report-unit")

    def test_module_whose_build_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("module", "mvn-no-report-module")

    def test_integration_whose_build_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("integration",
                                             "mvn-no-report-integration")

    def test_test_whose_build_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("test", "mvn-no-report-test")

    def test_regression_whose_build_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("regression",
                                             "mvn-no-report-regression")


if __name__ == "__main__":
    unittest.main()
