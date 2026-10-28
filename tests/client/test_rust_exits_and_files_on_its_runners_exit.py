"""A rust runner that failed is never filed or exited as green.

Every rust body that runs a test runner — `_test_run` (reached through
`cmd_test`: `test`, `unit`, `integration`, `e2e` and the declared nextest
profiles), `_smoke_test` (`smoke-test`, `docker-e2e-gate`),
`_workspace_regression_run` (`workspace-regression`, `regression`,
`pre-merge-gate`) and `_regression_ingest_run` (`regression-ingest`) — sends
the runner's exit as `runnerExit` on its ingest, on both the `dataPath` route
(`/api/v2/runs`, the board decodes nextest's JUnit) and the parsed route
(`/api/v2/runs/parsed`), builds its envelope's `run:` counts from the ingest
response's `run`, and exits non-zero whenever the runner exited non-zero, the
ingest was not `ok`, or the run it filed has a failure. The board, handed a
non-zero `runnerExit` over a run that records no failure, adds one failing
case — suite `runner`, case `exit <n>`.

`RustRunnerExitOnARealBoardTest`
    End to end against a REAL scratch board (`tests/client/real_board.py`):
    a fake `cargo` whose nextest (or `llvm-cov nextest`) exits 1 over a
    passing-only JUnit report, through `test`, `unit` and `smoke-test` (the
    `dataPath` route) and `workspace-regression`, `regression-ingest` and
    `pre-merge-gate` (the parsed route) — the stored run carries the
    `runner / exit 1` case, the envelope's `run` counts include it, and the
    verb exits non-zero. A runner killed by SIGKILL files `exit 137`. A failing
    report makes `workspace-regression`, `regression-ingest` and the gate exit
    non-zero even when `llvm-cov` itself exited 0 (`--ignore-run-fail`). A
    clean runner over a passing report is filed and exits exactly as before.

`RustRunnerExitReachesTheIngestTest`
    Against a recording board: what the ingest body CARRIES as `runnerExit`,
    the exit of a clean runner whose ingest was refused, and the exit of a
    runner that exited non-zero and wrote no report.

Every run drives the real `clients/rust-crucible.py` as a subprocess, with a
fake `cargo` (and `docker`) first on `PATH`: the fake writes nextest's JUnit
at `target/nextest/<profile>/junit.xml` under the project, as nextest does,
and exits as the test asks.

Invocation:
    python3 -m unittest tests.client.test_rust_exits_and_files_on_its_runners_exit -v
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
RUST_CLIENT = CLIENTS / "rust-crucible.py"
TIMEOUT = 120

RAW_INGEST = "/api/v2/runs"
PARSED_INGEST = "/api/v2/runs/parsed"

# Keys that would let the shell running this suite decide what the client
# resolves or how it files: scrubbed from every drive.
_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "RUST_CRUCIBLE_PROJECT_DIR", "RUST_CRUCIBLE_COMPOSE_FILE")
_FAKE_KEYS = ("FAKE_EXIT", "FAKE_SIGNAL", "FAKE_REPORT", "FAKE_FAILING")

# Each verb's own flags beyond `--agent`/`--project-dir`: the crate a
# per-crate verb names, and the disk-guard floor and target reclaim that would
# otherwise measure (and `cargo clean`) the host.
_VERB_FLAGS = {
    "test": ("--crate", "demo"),
    "unit": (),
    "smoke-test": (),
    "docker-e2e-gate": ("--min-free-g", "0"),
    "workspace-regression": ("--min-free-g", "0", "--keep-target"),
    "regression-ingest": ("--crates", "demo"),
    "pre-merge-gate": ("--skip-clippy", "--min-free-g", "0", "--keep-target"),
}

# A fake `cargo`. `clean`, `check`, `cache` and `clippy` succeed silently. A
# `nextest run` — bare or under `llvm-cov` — writes one nextest JUnit report
# at `target/nextest/<-P profile>/junit.xml` under its cwd: one passing case,
# plus one failing case when FAKE_FAILING=1, none at all when
# FAKE_REPORT=none; then it exits FAKE_EXIT, or kills itself with FAKE_SIGNAL.
_FAKE_CARGO = r'''
import os
import signal
import sys

args = sys.argv[1:]
if not args or args[0] in ("clean", "check", "cache", "clippy"):
    sys.exit(0)
profile = "default"
for i, arg in enumerate(args):
    if arg == "-P" and i + 1 < len(args):
        profile = args[i + 1]
failing = os.environ.get("FAKE_FAILING") == "1"
cases = ['<testcase name="adds_two_numbers" classname="demo::runner_exit" '
         'time="0.001"></testcase>']
if failing:
    cases.append('<testcase name="planted_failure" classname="demo::runner_exit" '
                 'time="0.001"><failure message="planted">planted failure'
                 '</failure></testcase>')
sys.stdout.write("    Starting %d tests across 1 binary\n" % len(cases))
sys.stdout.flush()
if os.environ.get("FAKE_REPORT") != "none":
    junit_dir = os.path.join(os.getcwd(), "target", "nextest", profile)
    os.makedirs(junit_dir, exist_ok=True)
    with open(os.path.join(junit_dir, "junit.xml"), "w") as handle:
        handle.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                     '<testsuites name="nextest-run" tests="%d" failures="%d" '
                     'errors="0"><testsuite name="demo::runner_exit" tests="%d" '
                     'failures="%d" errors="0" disabled="0">%s</testsuite>'
                     '</testsuites>\n' % (len(cases), 1 if failing else 0,
                                          len(cases), 1 if failing else 0,
                                          "".join(cases)))
name = os.environ.get("FAKE_SIGNAL")
if name:
    os.kill(os.getpid(), getattr(signal, "SIG" + name))
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''

# A `docker` stand-in for the e2e gate's compose bring-up and teardown: it
# exits 0, so a test never reaches the host's real docker.
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


class _FakeCargoProject:
    """A scratch rust project with a fake `cargo` on `PATH`, driven through
    the real client."""

    def make_project(self):
        self.project = new_scratch("rust-runner-exit-")
        self.bin_dir = os.path.join(self.project, "fake-bin")
        os.makedirs(self.bin_dir)
        _write_script(os.path.join(self.bin_dir, "cargo"), _FAKE_CARGO)
        _write_script(os.path.join(self.bin_dir, "docker"), _FAKE_DOCKER)

    def drive(self, verb, agent, **fake_env):
        env = scrubbed_env(self.bin_dir, **fake_env)
        for key in _SCRUBBED:
            env.pop(key, None)
        for key in _FAKE_KEYS:
            if key not in fake_env:
                env.pop(key, None)
        cmd = [sys.executable, str(RUST_CLIENT), verb, "--agent", agent,
               "--project-dir", self.project, *_VERB_FLAGS[verb]]
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
    _BOARD = RealBoard(bun, "rust-runner-exit-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class RustRunnerExitOnARealBoardTest(_FakeCargoProject, unittest.TestCase):
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

    def assert_filed_red_with_the_runner_case(self, verb, agent):
        result = self.drive_filed(verb, agent, FAKE_EXIT="1")
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

    def assert_failing_report_exits_non_zero(self, verb, agent):
        # `llvm-cov --ignore-run-fail` exits 0 over failing tests: the filed
        # run's failure alone decides the exit.
        result = self.drive_filed(verb, agent, FAKE_EXIT="0", FAKE_FAILING="1")
        self.assertNotEqual(
            result.returncode, 0,
            f"a {verb} run whose report records a failure exits non-zero; "
            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assertEqual(self.runner_suites(event), [],
                         f"a run that already records a failure gets no "
                         f"`runner` case; tree={event.get('tree')!r}")
        self.assert_counts(event.get("summary") or {}, total=2, passed=1,
                           failed=1, where="the stored run's")
        self.assert_counts(self.envelope_of(result).get("run") or {}, total=2,
                           passed=1, failed=1, where="the envelope's run")

    # -- one verb per body and per ingest route -----------------------------

    def test_test_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        # The `dataPath` route: the board decodes nextest's JUnit.
        self.assert_filed_red_with_the_runner_case(
            "test", "rust-runner-exit-test-data-path")

    def test_unit_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "unit", "rust-runner-exit-unit-data-path")

    def test_smoke_test_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "smoke-test", "rust-runner-exit-smoke-data-path")

    def test_workspace_regression_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        # The parsed route: the client parses the JUnit and posts the tree.
        self.assert_filed_red_with_the_runner_case(
            "workspace-regression", "rust-runner-exit-workspace-parsed")

    def test_regression_ingest_whose_runner_exits_1_over_a_passing_report_files_the_runner_case(self):
        self.assert_filed_red_with_the_runner_case(
            "regression-ingest", "rust-runner-exit-regression-ingest-parsed")

    def test_pre_merge_gate_whose_runner_exits_1_over_a_passing_report_is_not_green(self):
        self.assert_filed_red_with_the_runner_case(
            "pre-merge-gate", "rust-runner-exit-gate-parsed")

    def test_a_runner_killed_by_sigkill_files_exit_137(self):
        agent = "rust-runner-exit-test-sigkill"
        result = self.drive_filed("test", agent, FAKE_SIGNAL="KILL")
        self.assertNotEqual(result.returncode, 0,
                            f"a killed runner never exits green; "
                            f"{_diagnostics(result)}")
        event = self.the_one_stored_run(agent, result)
        self.assert_runner_case_filed(event, 128 + int(signal.SIGKILL), result)

    # -- a failing report exits non-zero ------------------------------------

    def test_workspace_regression_over_a_failing_report_exits_non_zero(self):
        self.assert_failing_report_exits_non_zero(
            "workspace-regression", "rust-runner-exit-workspace-failing")

    def test_regression_ingest_over_a_failing_report_exits_non_zero(self):
        self.assert_failing_report_exits_non_zero(
            "regression-ingest", "rust-runner-exit-regression-ingest-failing")

    def test_pre_merge_gate_over_a_failing_report_is_not_green(self):
        self.assert_failing_report_exits_non_zero(
            "pre-merge-gate", "rust-runner-exit-gate-failing")

    # -- nothing else changes ----------------------------------------------

    def assert_clean_run_filed_green(self, verb, agent):
        result = self.drive_filed(verb, agent, FAKE_EXIT="0")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        event = self.the_one_stored_run(agent, result)
        self.assertEqual(self.runner_suites(event), [],
                         f"a clean runner adds no `runner` suite; "
                         f"tree={event.get('tree')!r}")
        self.assert_counts(event.get("summary") or {}, total=1, passed=1,
                           failed=0, where="the stored run's")
        self.assert_counts(self.envelope_of(result).get("run") or {}, total=1,
                           passed=1, failed=0, where="the envelope's run")

    def test_a_clean_test_runner_over_a_passing_report_is_filed_green_and_exits_zero(self):
        self.assert_clean_run_filed_green("test", "rust-runner-exit-test-clean")

    def test_a_clean_workspace_regression_over_a_passing_report_is_filed_green_and_exits_zero(self):
        self.assert_clean_run_filed_green("workspace-regression",
                                          "rust-runner-exit-workspace-clean")


# ── What the ingest carries, against a recording board ─────────────────────

class RustRunnerExitReachesTheIngestTest(_FakeCargoProject, unittest.TestCase):
    """The ingest body states the runner's exit; a refused ingest after a
    clean runner, and a runner that exited non-zero with no report, exit
    non-zero."""

    PROJECT_KEY = "rust-runner-exit-recording-key"

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
                      f"the ingest body states the runner's exit; "
                      f"keys={sorted(body)!r}")
        self.assertEqual(body["runnerExit"], code,
                         f"runnerExit={body['runnerExit']!r}")
        self.assertIs(type(body["runnerExit"]), int,
                      "runnerExit is sent as an integer, never a string or bool")

    def assert_carries(self, verb, agent, path, code, **fake_env):
        result = self.drive(verb, agent, **fake_env)
        self.assert_runner_exit(self.the_one_ingest(path, result), code)

    # -- runnerExit on the wire ---------------------------------------------

    def test_a_clean_test_runner_sends_runner_exit_0_on_the_data_path_ingest(self):
        self.assert_carries("test", "rust-carry-test-clean", RAW_INGEST, 0,
                            FAKE_EXIT="0")

    def test_a_test_runner_exiting_1_sends_runner_exit_1_on_the_data_path_ingest(self):
        self.assert_carries("test", "rust-carry-test", RAW_INGEST, 1,
                            FAKE_EXIT="1")

    def test_a_smoke_test_runner_exiting_1_sends_runner_exit_1_on_the_data_path_ingest(self):
        self.assert_carries("smoke-test", "rust-carry-smoke", RAW_INGEST, 1,
                            FAKE_EXIT="1")

    def test_a_docker_e2e_gate_runner_exiting_1_sends_runner_exit_1_on_the_data_path_ingest(self):
        self.assert_carries("docker-e2e-gate", "rust-carry-docker-e2e",
                            RAW_INGEST, 1, FAKE_EXIT="1")

    def test_a_workspace_regression_runner_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        self.assert_carries("workspace-regression", "rust-carry-workspace",
                            PARSED_INGEST, 1, FAKE_EXIT="1")

    def test_a_regression_ingest_runner_exiting_1_sends_runner_exit_1_on_the_parsed_ingest(self):
        self.assert_carries("regression-ingest", "rust-carry-regression-ingest",
                            PARSED_INGEST, 1, FAKE_EXIT="1")

    def test_a_test_runner_killed_by_sigkill_sends_runner_exit_137(self):
        self.assert_carries("test", "rust-carry-test-sigkill", RAW_INGEST,
                            128 + int(signal.SIGKILL), FAKE_SIGNAL="KILL")

    # -- a refused ingest after a clean runner -------------------------------

    def assert_refused_ingest_exits_non_zero(self, verb, agent, path):
        self.board.refuse_ingest_for("run-live-1")
        result = self.drive(verb, agent, FAKE_EXIT="0")
        self.the_one_ingest(path, result)
        self.assertNotEqual(result.returncode, 0,
                            f"a refused ingest never exits green; "
                            f"{_diagnostics(result)}")

    def test_a_refused_ingest_after_a_clean_test_runner_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "test", "rust-refused-test", RAW_INGEST)

    def test_a_refused_ingest_after_a_clean_smoke_test_runner_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "smoke-test", "rust-refused-smoke", RAW_INGEST)

    def test_a_refused_ingest_after_a_clean_workspace_regression_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "workspace-regression", "rust-refused-workspace", PARSED_INGEST)

    def test_a_refused_ingest_after_a_clean_regression_ingest_exits_non_zero(self):
        self.assert_refused_ingest_exits_non_zero(
            "regression-ingest", "rust-refused-regression-ingest", PARSED_INGEST)

    # -- no report, a runner that exited non-zero ---------------------------

    def assert_no_report_exits_non_zero(self, verb, agent):
        result = self.drive(verb, agent, FAKE_EXIT="1", FAKE_REPORT="none")
        self.assertNotEqual(
            result.returncode, 0,
            f"a runner that exited 1 and wrote no report exits non-zero; "
            f"{_diagnostics(result)}")
        test_ingests = [p for p, _ in self.board.posts()
                        if p in (RAW_INGEST, PARSED_INGEST)]
        self.assertEqual(test_ingests, [],
                         "a run with no report files no test result")

    def test_test_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("test", "rust-no-report-test")

    def test_smoke_test_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("smoke-test", "rust-no-report-smoke")

    def test_workspace_regression_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("workspace-regression",
                                             "rust-no-report-workspace")

    def test_regression_ingest_whose_runner_exits_1_with_no_report_exits_non_zero(self):
        self.assert_no_report_exits_non_zero("regression-ingest",
                                             "rust-no-report-regression-ingest")


if __name__ == "__main__":
    unittest.main()
