"""The python client states its runner as the run's framework.

Every run the python client opens or files states `framework` = its runner,
`unittest` or `pytest`, beside `stack: "python"`:

- **`test`**, under unittest (the run it opens, then its stream's close) and
  under pytest (the run it opens, then its JUnit ingest), with the runner
  chosen by `--runner` or by the project's `[python] runner`; the declared
  tier verbs run the same body and state it too;
- **`regression`**, under each runner, its opened run and its close;
- **`pre-merge-gate`**, the one tier it runs (its whole-suite regression),
  under each runner, its opened run and its close;
- **`auto-ingest`**, which runs no runner, states the runner the project's own
  `crucible.toml` declares under `[python] runner`, else `unittest`, without
  probing for pytest (it runs nothing). A declared value that is neither
  runner is refused as the running verbs refuse it: an `ok: false` envelope
  naming the value and the file, exit 1, and nothing posted.

The board decides which `junit` reading applies from the framework, so a run
filed with none is read under neither.

Every drive runs the real `clients/python-crucible.py` against a
`RecordingBoard`, with the fake interpreter of
`test_python_client_sends_its_runners_reports` (it writes the stream and
the pytest JUnit report where the client tells it to).

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.integration.test_python_client_states_its_runner_as_the_framework
"""

import unittest
from pathlib import Path

from tests.client.python_client_sends_its_runners_reports_helpers import (
    BOARD_COVERAGE,
    JUNIT_TEXT,
    RUNS,
    START,
    STREAM_CODEC,
    TIER_VERBS,
    _PythonProject,
)

UNITTEST = "unittest"
PYTEST = "pytest"
# The codec each runner's run is filed with: unittest's stream, pytest's JUnit.
CODEC_OF = {UNITTEST: STREAM_CODEC, PYTEST: "junit"}
REFUSED_VALUE = "nose"
# An interpreter that does not exist: a pytest import probe made with it
# answers no, so a verb that probes is refused where one that runs nothing
# is not.
NO_INTERPRETER = "/nonexistent/python-that-cannot-import-pytest"


class _FrameworkCase(_PythonProject, unittest.TestCase):
    """A scratch project on a RecordingBoard, its runner declared or not.
    Defines no test of its own."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def declare_runner(self, value):
        """Declare `[python] runner = value` in the project's own crucible.toml,
        beside the board it already names."""
        toml = Path(self.project, "crucible.toml")
        toml.write_text(toml.read_text() + f'\n[python]\nrunner = "{value}"\n')

    def assert_opened_and_filed_under(self, result, runner, tier=None):
        """The verb opened exactly one run and filed exactly one, both stating
        `stack: "python"` and `framework` = `runner`; the filing closes the run
        it opened, with the codec that runner's record is written in."""
        diag = self.diagnostics(result)
        starts = self.posts_to(START)
        self.assertEqual(len(starts), 1, f"exactly one run is opened; {diag}")
        start = starts[0] if starts and isinstance(starts[0], dict) else {}
        self.assertEqual((start.get("stack"), start.get("framework")), ("python", runner),
                         f"the run opened states the runner as its framework; "
                         f"start={start!r} {diag}")
        if tier is not None:
            self.assertEqual(start.get("tier"), tier, f"start={start!r}")
        closes = self.posts_to(RUNS)
        self.assertEqual(len(closes), 1, f"exactly one run is filed; {diag}")
        close = closes[0] if closes and isinstance(closes[0], dict) else {}
        self.assertEqual(
            (close.get("stack"), close.get("framework"), close.get("codec")),
            ("python", runner, CODEC_OF[runner]),
            f"the run filed states the runner as its framework; close={close!r} {diag}")
        opened = self.board.run_ids_opened()
        self.assertEqual(close.get("runId"), opened[-1] if opened else None,
                         f"the filing closes the run the verb opened; close={close!r}")
        return start, close


# ── test, and the tier verbs that run its body ──────────────────────────────

class TheTestVerbStatesItsRunnerTest(_FrameworkCase):

    def test_a_unittest_test_run_opens_and_closes_its_stream_under_framework_unittest(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-framework-test-unittest")
        self.assert_opened_and_filed_under(result, UNITTEST)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_pytest_test_run_opens_its_run_and_files_its_junit_under_framework_pytest(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-framework-test-pytest", "--runner", PYTEST)
        _start, close = self.assert_opened_and_filed_under(result, PYTEST)
        self.assertNotEqual(close.get("framework"), UNITTEST, f"close={close!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_test_run_of_a_project_declaring_pytest_states_framework_pytest(self):
        self.declare_runner(PYTEST)
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-framework-test-declared-pytest")
        self.assert_opened_and_filed_under(result, PYTEST)

    def test_runner_unittest_over_a_project_declaring_pytest_states_framework_unittest(self):
        self.declare_runner(PYTEST)
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-framework-test-flag-unittest", "--runner", UNITTEST)
        self.assert_opened_and_filed_under(result, UNITTEST)

    def test_each_declared_tier_verb_states_its_runner_under_its_tier(self):
        self.board.script_run(passed=1, total=1, files=1)
        for runner in (UNITTEST, PYTEST):
            for tier in TIER_VERBS:
                with self.subTest(runner=runner, verb=tier):
                    before = len(self.board.events)
                    result = self.drive(tier, f"py-framework-{tier}-{runner}",
                                        "--start-dir", "tests", "--runner", runner)
                    del self.board.events[:before]
                    self.assert_opened_and_filed_under(result, runner, tier=tier)


# ── regression ───────────────────────────────────────────────────────────────

class TheRegressionVerbStatesItsRunnerTest(_FrameworkCase):

    def test_a_unittest_regression_opens_and_closes_its_stream_under_framework_unittest(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "py-framework-regression-unittest")
        self.assert_opened_and_filed_under(result, UNITTEST, tier="regression")

    def test_a_pytest_regression_opens_its_run_and_files_its_junit_under_framework_pytest(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "py-framework-regression-pytest", "--runner", PYTEST)
        self.assert_opened_and_filed_under(result, PYTEST, tier="regression")

    def test_a_pytest_coverage_regression_states_framework_pytest_beside_its_coverage(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("regression", "py-framework-regression-pytest-cov",
                            "--runner", PYTEST, "--coverage")
        _start, close = self.assert_opened_and_filed_under(result, PYTEST, tier="regression")
        self.assertEqual((close.get("coverage") or {}).get("codec"), "lcov", f"close={close!r}")


# ── pre-merge-gate ───────────────────────────────────────────────────────────

class ThePreMergeGateStatesItsRunnerTest(_FrameworkCase):
    """The python gate runs one tier, its whole-suite regression: the run it
    opens and the run it files state the runner."""

    def test_a_unittest_gate_opens_and_closes_its_regression_under_framework_unittest(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("pre-merge-gate", "py-framework-gate-unittest", "--skip-check")
        self.assert_opened_and_filed_under(result, UNITTEST, tier="regression")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_pytest_gate_opens_its_regression_and_files_its_junit_under_framework_pytest(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("pre-merge-gate", "py-framework-gate-pytest", "--skip-check",
                            "--runner", PYTEST)
        self.assert_opened_and_filed_under(result, PYTEST, tier="regression")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_gate_of_a_project_declaring_pytest_states_framework_pytest(self):
        self.declare_runner(PYTEST)
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("pre-merge-gate", "py-framework-gate-declared-pytest", "--skip-check")
        self.assert_opened_and_filed_under(result, PYTEST, tier="regression")


# ── auto-ingest ──────────────────────────────────────────────────────────────

class AutoIngestStatesTheDeclaredRunnerTest(_FrameworkCase):
    """`auto-ingest` runs no runner: it states the one the project declares,
    else `unittest`, and refuses a declared value that is neither."""

    def setUp(self):
        super().setUp()
        reports = Path(self.project, "reports")
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "TEST-a.xml").write_text(JUNIT_TEXT)
        self.board.script_run(passed=1, total=1, files=1)

    def the_one_filing(self, result):
        diag = self.diagnostics(result)
        self.assertEqual(self.posts_to(START), [], f"auto-ingest opens no run; {diag}")
        filed = self.posts_to(RUNS)
        self.assertEqual(len(filed), 1, f"exactly one run is filed; {diag}")
        return filed[0] if filed and isinstance(filed[0], dict) else {}

    def test_a_project_declaring_pytest_files_its_reports_under_framework_pytest(self):
        self.declare_runner(PYTEST)
        result = self.drive("auto-ingest", "py-framework-auto-pytest")
        body = self.the_one_filing(result)
        self.assertEqual((body.get("stack"), body.get("framework"), body.get("codec")),
                         ("python", PYTEST, "junit"), f"body={body!r}")
        self.assertEqual(body.get("data"), [JUNIT_TEXT], f"body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_project_declaring_nothing_files_its_reports_under_framework_unittest(self):
        result = self.drive("auto-ingest", "py-framework-auto-undeclared")
        body = self.the_one_filing(result)
        self.assertEqual((body.get("stack"), body.get("framework")), ("python", UNITTEST),
                         f"body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_project_declaring_unittest_files_its_reports_under_framework_unittest(self):
        self.declare_runner(UNITTEST)
        result = self.drive("auto-ingest", "py-framework-auto-unittest")
        body = self.the_one_filing(result)
        self.assertEqual(body.get("framework"), UNITTEST, f"body={body!r}")

    def test_a_declared_pytest_is_stated_without_probing_for_pytest(self):
        """auto-ingest runs nothing, so no interpreter is asked whether it can
        import pytest: one that cannot is no refusal."""
        self.declare_runner(PYTEST)
        result = self.drive("auto-ingest", "py-framework-auto-no-probe",
                            PY_CRUCIBLE_PYTHON=NO_INTERPRETER)
        body = self.the_one_filing(result)
        self.assertEqual(body.get("framework"), PYTEST, f"body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))
        self.assertNotIn(NO_INTERPRETER, result.stdout, self.diagnostics(result))

    def test_a_declared_value_that_is_neither_runner_is_refused_and_nothing_is_posted(self):
        self.declare_runner(REFUSED_VALUE)
        result = self.drive("auto-ingest", "py-framework-auto-nose")
        diag = self.diagnostics(result)
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"the refusal is an ok:false envelope; {diag}")
        self.assertEqual(envelope.get("verb"), "auto-ingest", diag)
        for named in (REFUSED_VALUE, "crucible.toml"):
            self.assertIn(named, result.stdout,
                          f"the refusal names {named!r}, as the running verbs' does; {diag}")
        self.assertEqual(result.returncode, 1, diag)
        self.assertEqual(self.board.posts(), [], f"nothing is posted to the board; {diag}")


if __name__ == "__main__":
    unittest.main()
