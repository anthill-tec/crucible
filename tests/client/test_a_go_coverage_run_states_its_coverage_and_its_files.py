"""A go coverage run states its coverage and names its least covered files in
its own envelope.

`test --coverage` and `regression --coverage` send the run's coverprofile with
its close. When the run is green the board keeps the coverage and answers it:
in the answer's `run` block, `coverage` (the whole run's percents),
`coverageFileCount` and `coverageFiles` (its least covered files), and the
run's id at the answer's top-level `event`. The verb's envelope then carries a
`coverage` block: `lines`, `functions`, `event`, `fileCount`, `moreFiles` and
one `files` row per answered file, in the answer's order.

A run that measured none prints as it did: a `test` or a `regression` without
`--coverage`, whose answer keeps no coverage, and a failing
`regression --coverage`, whose coverage the board discards, carry no
`coverage` block.

Driven with the real `go` through the recording shim (`go_client_harness`)
over `tests/fixtures/go-client/coverage-modules`, against a `RecordingBoard`
whose health lists `go-coverprofile` and which is scripted to answer what a
board that keeps a run's files answers (`script_coverage_files`,
tests/client/live_run_harness.py). The answer and the block it is stated as
come from `tests/client/kept_coverage_answer.py`. The board decodes nothing:
a failing run is one whose scripted answer records a failure.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_coverage_run_states_its_coverage_and_its_files
"""

import unittest

from tests.client.go_client_harness import (
    GoProject,
    diagnostics,
    envelope,
    go_toolchain_gap,
)
from tests.client.kept_coverage_answer import EVENT, script_kept_files, stated_block

COVERAGE_CODEC = "go-coverprofile"
FIXTURE = "coverage-modules"
#: The tests `go test -list` names in each fixture module.
CALC_LISTED = 3
TYPES_LISTED = 1

BLOCK_KEYS = ["lines", "functions", "event", "fileCount", "moreFiles", "files"]
SEVEN_ROW_KEYS = ["file", "linesPercent", "linesCovered", "linesTotal",
                  "functionsPercent", "functionsCovered", "functionsTotal"]


class _GoCoverageCase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")
        self.p = GoProject(self, fixture=FIXTURE)
        health = self.p.board.default_health()
        health["codecs"]["coverage"] = [*health["codecs"]["coverage"], COVERAGE_CODEC]
        self.p.board.script_health(health)

    def the_one_close(self, where):
        closes = self.p.closes()
        self.assertEqual(len(closes), 1, f"the run is closed once; {where}")
        return closes[0]

    def envelope_of(self, result):
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"stdout is one envelope; {diagnostics(result)}")
        return axi or {}

    def assert_the_block_with_its_files(self, result, verb):
        where = diagnostics(result)
        close = self.the_one_close(where)
        self.assertEqual((close.get("coverage") or {}).get("codec"), COVERAGE_CODEC,
                         f"the run measured coverage and sent its profile; {where}")
        axi = self.envelope_of(result)
        self.assertEqual((result.returncode, axi.get("ok"), axi.get("events")),
                         (0, True, [EVENT]),
                         f"a green run, filed as the event the board answered; {where}")
        block = axi.get("coverage")
        self.assertEqual(
            block, stated_block(),
            f"the go client's `{verb} --coverage` envelope states the coverage "
            f"the board kept and names its least covered files; {where}")
        self.assertEqual(
            (block["event"], block["fileCount"], block["moreFiles"],
             len(block["files"])),
            ("evt-kept-coverage-7f3a", 12, 2, 10), where)
        self.assertEqual(list(block), BLOCK_KEYS, where)
        self.assertEqual([list(row) for row in block["files"]],
                         [SEVEN_ROW_KEYS] * 10, where)

    def assert_no_coverage_block(self, result, why):
        where = diagnostics(result)
        self.the_one_close(where)
        axi = self.envelope_of(result)
        self.assertNotIn("coverage", axi, f"{why}; {where}")
        return axi


class AGreenGoCoverageRunPrintsTheBlockWithItsFilesTest(_GoCoverageCase):

    def test_a_green_coverage_regression_prints_the_block_with_its_files(self):
        script_kept_files(self.p.board, passed=CALC_LISTED + TYPES_LISTED)
        result = self.p.drive("--coverage", verb="regression")
        self.assert_the_block_with_its_files(result, "regression")

    def test_a_green_coverage_test_run_prints_the_block_with_its_files(self):
        script_kept_files(self.p.board, passed=CALC_LISTED)
        result = self.p.drive("--coverage", "--module-dir", "calc")
        self.assert_the_block_with_its_files(result, "test")


class AGoRunThatMeasuredNoCoverageIsUnchangedTest(_GoCoverageCase):

    def test_a_regression_without_coverage_prints_no_coverage_block(self):
        self.p.board.script_run(passed=CALC_LISTED + TYPES_LISTED)
        result = self.p.drive(verb="regression")
        where = diagnostics(result)
        axi = self.assert_no_coverage_block(
            result, "a run that measured no coverage prints no `coverage` block")
        self.assertNotIn("coverage", self.the_one_close(where),
                         f"the run measured none and sent none; {where}")
        self.assertEqual((result.returncode, axi.get("ok")), (0, True), where)

    def test_a_test_run_without_coverage_prints_no_coverage_block(self):
        self.p.board.script_run(passed=CALC_LISTED)
        result = self.p.drive("--module-dir", "calc")
        where = diagnostics(result)
        axi = self.assert_no_coverage_block(
            result, "a run that measured no coverage prints no `coverage` block")
        self.assertNotIn("coverage", self.the_one_close(where),
                         f"the run measured none and sent none; {where}")
        self.assertEqual((result.returncode, axi.get("ok")), (0, True), where)

    def test_a_failing_coverage_regression_prints_no_coverage_block(self):
        # The board discards a red run's coverage: its answer keeps none.
        self.p.board.script_run(passed=CALC_LISTED, failed=1)
        result = self.p.drive("--coverage", verb="regression")
        where = diagnostics(result)
        axi = self.assert_no_coverage_block(
            result, "the board kept no coverage for the failing run, so its "
                    "envelope prints no `coverage` block")
        self.assertEqual((axi.get("run") or {}).get("failed"), 1, where)
        self.assertNotEqual(result.returncode, 0,
                            f"a failing run does not exit 0; {where}")


if __name__ == "__main__":
    unittest.main()
