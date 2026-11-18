"""Every stack's coverage run states its coverage and names its least covered
files in its own envelope.

A bun, python, maven or arduino `regression --coverage` measures coverage and
sends its report with the run. When the run is green the board keeps the
coverage and answers it: in the answer's `run` block, `coverage` (the whole
run's percents), `coverageFileCount` and `coverageFiles` (its least covered
files), and the run's id at the answer's top-level `event`. The verb's
envelope then carries a `coverage` block: `lines`, `functions`, `event`,
`fileCount`, `moreFiles` and one `files` row per answered file, in the
answer's order.

A run that measured none prints as it did: a `regression` without
`--coverage`, whose answer keeps no coverage, and a failing
`regression --coverage`, whose coverage the board discards, carry no
`coverage` block.

Each stack is driven as a real subprocess of its client, through the stack's
own project fixture (its fake runner writes the reports a real one would)
against a `RecordingBoard` scripted to answer what a board that keeps a run's
files answers (`script_coverage_files`, tests/client/live_run_harness.py). The
answer and the block it is stated as come from
`tests/client/kept_coverage_answer.py`. The go client drives the real `go`
toolchain and has a module of its own.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_every_stacks_coverage_run_states_its_coverage_and_its_files
"""

import unittest

from tests.client.kept_coverage_answer import (
    EVENT,
    FILE_COUNT,
    KEPT_COVERAGE,
    answered_files,
    script_kept_files,
    stated_block,
)
from tests.client.live_run_harness import RecordingBoard, load_client, load_toon
from tests.client.integration.test_arduino_client_sends_its_runners_reports import _ArduinoProject
from tests.client.integration.test_bun_client_sends_its_runners_reports import _BunProject
from tests.client.integration.test_mvn_client_sends_its_runners_reports import _MavenProject
from tests.client.integration.test_python_client_sends_its_runners_reports import _PythonProject

TOON = load_toon()
RUNS = "/api/v2/runs"

BLOCK_KEYS = ["lines", "functions", "event", "fileCount", "moreFiles", "files"]
SEVEN_ROW_KEYS = ["file", "linesPercent", "linesCovered", "linesTotal",
                  "functionsPercent", "functionsCovered", "functionsTotal"]


# ── the fixtures themselves ─────────────────────────────────────────────────

class TheRecordingBoardAnswersTheFilesItIsScriptedToKeepTest(unittest.TestCase):
    """`RecordingBoard.script_coverage_files`: what a scripted board answers,
    and that an unscripted one answers what it always did."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.core = load_client("_crucible_axi.py")

    def filed(self):
        return self.core.http_request(self.board.url, "POST", RUNS,
                                      {"stack": "python", "codec": "junit"}, 10)

    def test_an_unscripted_board_answers_no_event_and_no_files(self):
        self.board.script_run(passed=2, total=2, files=1, coverage=KEPT_COVERAGE)
        self.assertEqual(
            self.filed(),
            {"ok": True, "changed": True,
             "run": {"passed": 2, "failed": 0, "pending": 0, "total": 2,
                     "files": 1, "coverage": KEPT_COVERAGE}},
            "a board no test scripted files for answers the `run` block "
            "`script_run` scripted, and nothing more")

    def test_a_scripted_board_answers_the_runs_id_its_file_count_and_its_files(self):
        script_kept_files(self.board, passed=2, total=2, files=1)
        answer = self.filed()
        self.assertEqual(
            answer,
            {"ok": True, "changed": True, "event": EVENT,
             "run": {"passed": 2, "failed": 0, "pending": 0, "total": 2,
                     "files": 1, "coverage": KEPT_COVERAGE,
                     "coverageFileCount": FILE_COUNT,
                     "coverageFiles": answered_files()}})
        self.assertEqual((answer["run"]["coverageFileCount"],
                          len(answer["run"]["coverageFiles"])), (12, 10))

    def test_the_files_stay_scripted_when_the_run_block_is_scripted_again(self):
        script_kept_files(self.board, passed=2, total=2, files=1)
        self.board.script_run(passed=5, total=5, files=2, coverage=KEPT_COVERAGE)
        answer = self.filed()
        self.assertEqual((answer.get("event"), answer["run"].get("passed"),
                          answer["run"].get("coverageFileCount"),
                          answer["run"].get("coverageFiles")),
                         (EVENT, 5, FILE_COUNT, answered_files()))


class TheStatedBlockSurvivesTheEnvelopesEncodingTest(unittest.TestCase):
    """The block is read back from a client's stdout, which is TOON: what is
    asserted of a decoded envelope below is what the encoding gives back."""

    def test_the_block_decodes_to_the_same_keys_values_and_order(self):
        block = stated_block()
        text = TOON.encode({"axi": {"verb": "regression", "ok": True,
                                    "coverage": block, "warnings": []}})
        decoded = TOON.decode(text)["axi"]["coverage"]
        self.assertEqual(decoded, block)
        self.assertEqual(list(decoded), BLOCK_KEYS)
        self.assertEqual([list(row) for row in decoded["files"]],
                         [SEVEN_ROW_KEYS] * 10)
        self.assertEqual(decoded["files"][0]["file"],
                         "/work/project/src/drivers/motor controller, v2.cpp")
        self.assertEqual(
            [decoded["files"][2][key] for key in SEVEN_ROW_KEYS[4:]],
            [None, None, None],
            "a null function figure is read back as null")


# ── each stack, through its own client ──────────────────────────────────────

class _CoverageRunCase:
    """What each stack's case states of its own runner, and the three runs
    every stack is put through.

    `GREEN` is the `run` block a green run of the stack's fixture is answered
    with, `RED` a failing one's, and `RED_ENV` what makes the stack's fake
    runner fail."""

    STACK = ""
    GREEN = {}
    RED = {}
    RED_ENV = {}
    maxDiff = None

    def setUp(self):
        self.make()  # type: ignore[attr-defined]

    def tearDown(self):
        self.cleanup()  # type: ignore[attr-defined]

    def regression(self, agent, *extra, **fake_env):
        return self.drive(  # type: ignore[attr-defined]
            "regression", f"{self.STACK}-{agent}", *extra, **fake_env)

    def filed_envelope(self, result):
        """The envelope of a run that was filed as one ingest."""
        self.the_one_runs_ingest(result)  # type: ignore[attr-defined]
        return self.envelope_of(result)  # type: ignore[attr-defined]

    def test_a_green_coverage_regression_prints_the_block_with_its_files(self):
        script_kept_files(self.board, **self.GREEN)  # type: ignore[attr-defined]
        result = self.regression("coverage-names-its-files", "--coverage")
        where = self.diagnostics(result)  # type: ignore[attr-defined]
        body = self.the_one_runs_ingest(result)  # type: ignore[attr-defined]
        self.assertIsInstance(  # type: ignore[attr-defined]
            body.get("coverage"), dict,
            f"the run measured coverage and sent its report; body={body!r}")
        envelope = self.envelope_of(result)  # type: ignore[attr-defined]
        self.assertEqual(  # type: ignore[attr-defined]
            (result.returncode, envelope.get("ok"), envelope.get("events")),
            (0, True, [EVENT]),
            f"a green run, filed as the event the board answered; {where}")
        block = envelope.get("coverage")
        self.assertEqual(  # type: ignore[attr-defined]
            block, stated_block(),
            f"the {self.STACK} client's `regression --coverage` envelope "
            f"states the coverage the board kept and names its least covered "
            f"files; {where}")
        self.assertEqual(  # type: ignore[attr-defined]
            (block["event"], block["fileCount"], block["moreFiles"],
             len(block["files"])),
            ("evt-kept-coverage-7f3a", 12, 2, 10), where)
        self.assertEqual(list(block), BLOCK_KEYS, where)  # type: ignore[attr-defined]
        self.assertEqual(  # type: ignore[attr-defined]
            [list(row) for row in block["files"]], [SEVEN_ROW_KEYS] * 10, where)

    def test_a_regression_without_coverage_prints_no_coverage_block(self):
        self.board.script_run(**self.GREEN)  # type: ignore[attr-defined]
        result = self.regression("no-coverage-asked")
        where = self.diagnostics(result)  # type: ignore[attr-defined]
        body = self.the_one_runs_ingest(result)  # type: ignore[attr-defined]
        self.assertNotIn(  # type: ignore[attr-defined]
            "coverage", body, f"the run measured none and sent none; body={body!r}")
        envelope = self.envelope_of(result)  # type: ignore[attr-defined]
        self.assertEqual(  # type: ignore[attr-defined]
            (result.returncode, envelope.get("ok"),
             (envelope.get("run") or {}).get("passed")),
            (0, True, self.GREEN["passed"]), where)
        self.assertNotIn(  # type: ignore[attr-defined]
            "coverage", envelope,
            f"a run that measured no coverage prints no `coverage` block; {where}")

    def test_a_failing_coverage_regression_prints_no_coverage_block(self):
        # The board discards a red run's coverage: its answer keeps none.
        self.board.script_run(**self.RED)  # type: ignore[attr-defined]
        result = self.regression("coverage-run-fails", "--coverage", **self.RED_ENV)
        where = self.diagnostics(result)  # type: ignore[attr-defined]
        envelope = self.filed_envelope(result)
        self.assertNotEqual(  # type: ignore[attr-defined]
            result.returncode, 0, f"a failing run does not exit 0; {where}")
        self.assertEqual(  # type: ignore[attr-defined]
            (envelope.get("run") or {}).get("failed"), self.RED["failed"], where)
        self.assertNotIn(  # type: ignore[attr-defined]
            "coverage", envelope,
            f"the board kept no coverage for the failing run, so its envelope "
            f"prints no `coverage` block; {where}")


class ABunCoverageRunTest(_CoverageRunCase, _BunProject, unittest.TestCase):
    STACK = "bun"
    GREEN = {"passed": 1, "total": 1, "files": 1}
    RED = {"passed": 0, "failed": 1, "total": 1, "files": 1}
    RED_ENV = {"FAKE_EXIT": "1"}


class APythonCoverageRunTest(_CoverageRunCase, _PythonProject, unittest.TestCase):
    STACK = "python"
    GREEN = {"passed": 1, "total": 1, "files": 1}
    RED = {"passed": 0, "failed": 1, "total": 1, "files": 1}
    RED_ENV = {"FAKE_EXIT": "1"}


class AMavenCoverageRunTest(_CoverageRunCase, _MavenProject, unittest.TestCase):
    STACK = "mvn"
    GREEN = {"passed": 4, "total": 4, "files": 4}
    RED = {"passed": 3, "failed": 1, "total": 4, "files": 4}
    RED_ENV = {"FAKE_FAIL": "1"}


class AnArduinoCoverageRunTest(_CoverageRunCase, _ArduinoProject, unittest.TestCase):
    STACK = "arduino"
    GREEN = {"passed": 2, "total": 2, "files": 2}
    RED = {"passed": 1, "failed": 1, "total": 2, "files": 2}
    RED_ENV = {"FAKE_VARIANT": "fail", "FAKE_EXIT": "2"}


if __name__ == "__main__":
    unittest.main()
