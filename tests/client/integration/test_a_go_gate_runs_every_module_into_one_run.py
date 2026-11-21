"""A go gate runs every module under the project dir into ONE run.

`go test ./...` cannot span two modules, so `regression` and `pre-merge-gate`
find every `go.mod` under the project dir, skipping `vendor`, `testdata`,
`node_modules` and hidden dirs, and run each module's `./...` into the one
streamed run. The run's start total is the sum of each module's
`go test -list` count.

The project is `tests/fixtures/go-client/two-modules` (`api`: package
`example.com/api`, one test; `worker`: packages `example.com/worker` and
`example.com/worker/sub`, one test each), plus a module in each skipped dir
holding a FAILING test, so a skipped module that ran would show on the board
and fail the run.

Driven with the real `go` through the recording shim (`go_client_harness`)
against a `RecordingBoard`: one `regression` (every test passing) and one
`pre-merge-gate` (a worker test failing).

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_go_gate_runs_every_module_into_one_run
"""

import os
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.go_client_harness import (
    GO_CLIENT,
    PROJECT_KEY,
    RUNS,
    STREAM_CODEC,
    TIMEOUT,
    GoProject,
    diagnostics,
    envelope,
    flag_value,
    go_events,
    go_toolchain_gap,
    terminal_events,
    toolchain_env,
)

MILESTONES = "/api/v2/milestones"
API = {"example.com/api"}
WORKER = {"example.com/worker", "example.com/worker/sub"}
#: The dirs a gate never looks in for a module, each holding one here.
SKIPPED_DIRS = ("vendor/skipped", "testdata/skipped", "node_modules/skipped",
                ".hidden/skipped", "worker/testdata/skipped")
SKIPPED_TEST = "TestASkippedModuleMustNeverRun"
FAILING_WORKER_TEST = "TestWorkerGateFixtureFails"


def _write_module(directory, module, test_body):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "go.mod").write_text(f"module {module}\n\ngo 1.24\n", encoding="utf-8")
    package = module.rsplit("/", 1)[-1].replace("-", "")
    (directory / f"{package}_test.go").write_text(
        f'package {package}\n\nimport "testing"\n\n{test_body}\n', encoding="utf-8")


def _two_module_project(case, failing_worker=False):
    """The two-module fixture on its own board, a failing module in each
    skipped dir, and (with `failing_worker`) a failing test in `worker`."""
    p = GoProject(case, fixture="two-modules")
    root = Path(p.dir)
    for index, skipped in enumerate(SKIPPED_DIRS):
        _write_module(root / skipped, f"example.com/skipped{index}",
                      f'func {SKIPPED_TEST}(t *testing.T) {{ t.Fatal("skipped dir ran") }}')
    if failing_worker:
        (root / "worker" / "fails_test.go").write_text(
            'package worker\n\nimport "testing"\n\n'
            f'func {FAILING_WORKER_TEST}(t *testing.T) {{ t.Fatal("gate fixture") }}\n',
            encoding="utf-8")
    return p


def _listed(module_dir):
    """The real `go test -list . -json ./...` count of `module_dir`'s tests."""
    ran = subprocess.run(["go", "test", "-list", ".", "-json", "./..."],
                         cwd=module_dir, env=toolchain_env(), capture_output=True,
                         text=True, check=False, timeout=TIMEOUT)
    return sum(1 for event in go_events(ran.stdout)
               if event.get("Action") == "output"
               and (event.get("Output") or "").startswith(("Test", "Fuzz", "Example")))


def _drive(p, verb):
    cmd = [sys.executable, str(GO_CLIENT), verb, "--agent", "go-gate-runner",
           "--project-dir", p.dir]
    return subprocess.run(cmd, cwd=p.dir, env=p.env(), capture_output=True,
                          text=True, timeout=TIMEOUT, check=False)


class _GateRun(unittest.TestCase):
    """One real gate drive per class, read by every test of the class."""

    maxDiff = 6000
    VERB = ""
    FAILING_WORKER = False

    @classmethod
    def setUpClass(cls):
        cls.gap = go_toolchain_gap()
        cls.drives = []

    def setUp(self):
        if self.gap:
            self.fail(f"missing toolchain: {self.gap}")
        if not type(self).drives:
            p = _two_module_project(self, self.FAILING_WORKER)
            p.board.script_run(passed=3, failed=1 if self.FAILING_WORKER else 0)
            type(self).drives.append((p, _drive(p, self.VERB)))
        self.p, self.result = type(self).drives[0]
        self.where = diagnostics(self.result)

    @property
    def root(self):
        return os.path.realpath(self.p.dir)

    def module_cwds(self, calls):
        return sorted(os.path.relpath(os.path.realpath(c["cwd"]), self.root)
                      for c in calls)

    def assert_one_run_over_both_modules(self):
        starts = self.p.starts()
        self.assertEqual(len(starts), 1, f"{self.VERB}: exactly one run opened; {self.where}")
        start = starts[0] if starts else {}
        self.assertEqual((start.get("stack"), start.get("framework")), ("go", STREAM_CODEC),
                         f"{self.VERB}: the run is go's, decoded by go-test; {start!r}")
        closes = [b for p, b in self.p.posts() if p == RUNS]
        self.assertEqual([b.get("codec") for b in closes], [STREAM_CODEC],
                         f"{self.VERB}: the one run is closed once from its stream; {self.where}")
        self.assertEqual(self.p.packages_run(), API | WORKER,
                         f"{self.VERB}: both modules' packages reached the one run, and "
                         f"no skipped dir's; {self.where}")


class ARegressionRunsEveryModuleIntoOneRunTest(_GateRun):
    VERB = "regression"

    def test_one_run_holds_both_modules_and_no_skipped_dirs_module(self):
        self.assert_one_run_over_both_modules()
        held = [test for _pkg, test, _a in terminal_events(self.p.held())]
        self.assertNotIn(SKIPPED_TEST, held, f"a skipped dir's module never runs; {self.where}")

    def test_the_start_total_is_the_sum_of_each_modules_list(self):
        api = _listed(os.path.join(self.p.dir, "api"))
        worker = _listed(os.path.join(self.p.dir, "worker"))
        self.assertEqual((api, worker), (1, 2), "the fixture lists as its design states")
        starts = self.p.starts()
        self.assertEqual([s.get("total") for s in starts], [api + worker],
                         f"the run-start total is the two lists' sum; {self.where}")

    def test_go_test_runs_once_in_each_module_and_never_in_a_skipped_dir(self):
        runs = self.p.run_calls()
        lists = self.p.list_calls()
        self.assertEqual(self.module_cwds(runs), ["api", "worker"],
                         f"one `go test -json ./...` per module; {self.where}")
        for call in runs:
            self.assertIn("-json", call["argv"])
            self.assertEqual(call["argv"][-1], "./...", call["argv"])
        self.assertEqual(self.module_cwds(lists), ["api", "worker"],
                         f"one `go test -list` per module; {self.where}")
        for call in lists:
            self.assertEqual(flag_value(call["argv"], "-list"), ".", call["argv"])

    def test_the_envelope_is_regressions_own_and_the_run_passed(self):
        axi = envelope(self.result.stdout) or {}
        self.assertEqual(axi.get("verb"), "regression", self.where)
        self.assertIs(axi.get("ok"), True, self.where)
        self.assertEqual((axi.get("context") or {}).get("projectKey"), PROJECT_KEY)
        self.assertEqual(self.result.returncode, 0, self.where)


class APreMergeGateRunsEveryModuleAndRecordsItsOutcomeTest(_GateRun):
    VERB = "pre-merge-gate"
    FAILING_WORKER = True

    def test_one_run_holds_both_modules_and_no_skipped_dirs_module(self):
        self.assert_one_run_over_both_modules()

    def test_a_failing_module_does_not_stop_the_other_from_running(self):
        held = {(pkg, test, action) for pkg, test, action in terminal_events(self.p.held())}
        self.assertIn(("example.com/worker", FAILING_WORKER_TEST, "fail"), held, self.where)
        self.assertIn(("example.com/api", "TestApi", "pass"), held, self.where)

    def test_the_gate_records_one_failing_pre_merge_gate_milestone(self):
        milestones = [b for p, b in self.p.posts() if p == MILESTONES]
        self.assertEqual([m.get("type") for m in milestones], ["pre-merge-gate"],
                         f"exactly one gate milestone; {self.where}")
        milestone = milestones[0] if milestones else {}
        self.assertEqual(milestone.get("outcome"), "fail", f"{milestone!r}")
        # The counts are the board's close answer for the one run (this
        # board's scripted 3 passed, 1 failed): one run, so one answer. The
        # failing test's name is read back from a real board's stored run,
        # which the gate-outcome suite asserts for every client.
        self.assertEqual((milestone.get("passed"), milestone.get("failed")), (3, 1),
                         f"{milestone!r}")
        self.assertEqual(milestone.get("scope"), "full", f"{milestone!r}")

    def test_the_envelope_is_the_gates_own_and_the_exit_is_non_zero(self):
        axi = envelope(self.result.stdout) or {}
        self.assertEqual(axi.get("verb"), "pre-merge-gate", self.where)
        self.assertEqual(self.result.stdout.count("axi:"), 1,
                         f"one envelope on stdout; {self.where}")
        self.assertNotEqual(self.result.returncode, 0, self.where)


if __name__ == "__main__":
    unittest.main()
