"""The bun client sends its runner's reports and parses nothing.

Every bun verb that files a report (`test`, a `test` run through a declared
test script, `regression`, the declared tier verbs `unit`, `module`,
`integration`, `e2e` and `bdd`, `auto-ingest`, and the regression step
`pre-merge-gate` runs) files it through the shared ingest
(`ingest_reports`, clients/_crucible_run.py): the board's health is read
first, then ONE `POST /api/v2/runs` goes out carrying `codec` (`junit`), `data` (the report texts,
inline), `coverage: {codec: "lcov", data}` when the run measured coverage,
`raw` (the captured runner output, on every verb but `auto-ingest`) and
`runnerExit`. Nothing goes to `/api/v2/runs/parsed`, and no body carries a
`dataPath`.

Every figure the envelope reports is the board's: its `run:` block is the
response's `run` block, the stderr coverage line reads the response's
coverage, and the response's `warnings[]` join the envelope's. With no board
there are no figures. A board that cannot decode the run (no `codecs`), or
whose advertised `ingest_body_bytes` the body exceeds, is refused before
anything is sent, and the run the verb opened is aborted.

The client still decides two things locally, from the runner's exit and two
counts over its JUnit report: "ran nothing" (a non-zero runner over a report
with no `<testcase>`), and bun's filter check (a `-t` filter whose report
holds no non-skipped `<testcase>` ran nothing). The no-report exits are
unchanged: `test` with no `junit.xml` files its synthetic compile ingest,
`regression` with no report is aborted, and neither touches `/api/v2/runs`.

Every drive runs the real `clients/bun-crucible.py` with a fake `bun` that
writes the exact report texts below where the client tells it to. Most drive
it as a subprocess against a `RecordingBoard` whose `/api/v2/runs` answer the
test scripts; the two that need a board that cannot be reached at one route
drive `main()` in-process with that one route answered as the transport
answers an unreachable board.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.integration.test_bun_client_sends_its_runners_reports
"""

import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import (
    RecordingBoard,
    load_client,
)
from tests.client.bun_client_sends_its_runners_reports_helpers import (
    _BunProject,
    _envelope,
    HEALTH,
    JUNIT_TEXT,
    LCOV_TEXT,
    OUTPUT_MARKER,
    PARSED,
    RUNS,
)


COMPILE = "/api/v2/runs/compile"
FIRST_RUN = "run-live-1"


# The coverage the scripted board says it kept: not what the lcov above sums
# to, so a stderr line that reads the client's own sum is caught.
BOARD_COVERAGE = {"lines": {"total": 200, "covered": 123, "percent": 61.5},
                  "functions": {"total": 40, "covered": 17, "percent": 42.5}}

TIER_VERBS = ("unit", "module", "integration", "e2e", "bdd")

TIER_MANIFEST = {"name": "bun-sends-its-reports", "private": True,
                 "scripts": {f"test:{tier}": "bun test" for tier in TIER_VERBS}}
TEST_SCRIPT_MANIFEST = {"name": "bun-sends-its-reports", "private": True,
                        "scripts": {"test:all": "bun test"},
                        "crucible": {"targets": {"test:all": {
                            "framework": "bun-test", "junit": "flag", "test": True}}}}


def _codes(envelope):
    return [w.get("code") for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict)]


def _figures(envelope):
    """The integer figures an envelope's `run:` block states."""
    run = (envelope or {}).get("run")
    if not isinstance(run, dict):
        return {}
    return {k: run[k] for k in ("passed", "failed", "pending", "total", "files")
            if isinstance(run.get(k), int) and not isinstance(run.get(k), bool)}


# ── AC1 / AC10 — every report verb sends one /api/v2/runs, raw and exit ─────

class EveryBunReportVerbSendsOneRunsIngestTest(_BunProject, unittest.TestCase):
    """The route, the codec, the inline report text, `raw` and `runnerExit`
    for every bun verb that files a report."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def use_manifest(self, manifest):
        Path(self.project, "package.json").write_text(json.dumps(manifest, indent=2))

    def assert_junit_ingest_with_raw_and_exit(self, result, runner_exit=0):
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("codec"), "junit", f"body={body!r}")
        self.assertEqual(body.get("data"), [JUNIT_TEXT],
                         f"`data` is the runner's JUnit report text, inline and "
                         f"byte for byte; body={body!r}")
        self.assertIsInstance(body.get("raw"), str, f"body={body!r}")
        self.assertIn(OUTPUT_MARKER, body.get("raw") or "",
                      f"`raw` is the runner's captured output; body={body!r}")
        self.assertEqual(body.get("runnerExit"), runner_exit,
                         f"`runnerExit` is the runner's exit; body={body!r}")
        for key in ("summary", "tree"):
            self.assertNotIn(key, body,
                             f"the client sends no parse of its own; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        return body

    def test_test_sends_its_junit_text_inline_with_raw_and_the_runner_exit(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "sends-test")
        body = self.assert_junit_ingest_with_raw_and_exit(result)
        self.assertNotIn("tier", body, f"a `test` run claims no tier; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_failing_runner_sends_its_non_zero_exit_as_runner_exit(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "sends-test-exit-3", FAKE_EXIT="3")
        self.assert_junit_ingest_with_raw_and_exit(result, runner_exit=3)
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_test_through_a_declared_test_script_sends_one_runs_ingest(self):
        self.use_manifest(TEST_SCRIPT_MANIFEST)
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "sends-test-script")
        self.assert_junit_ingest_with_raw_and_exit(result)
        self.assertEqual(self.envelope_of(result).get("script"), "test:all",
                         self.diagnostics(result))

    def test_regression_sends_its_junit_text_inline_with_raw_and_the_runner_exit(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "sends-regression")
        body = self.assert_junit_ingest_with_raw_and_exit(result)
        self.assertEqual(body.get("tier"), "regression", f"body={body!r}")
        self.assertNotIn("coverage", body,
                         f"a run without --coverage sends no coverage; body={body!r}")
        self.assertNotIn("coverage-not-measured", _codes(self.envelope_of(result)),
                         f"nothing was asked, so nothing is missing; "
                         f"{self.diagnostics(result)}")

    def test_each_declared_tier_verb_sends_one_runs_ingest_under_its_tier(self):
        self.use_manifest(TIER_MANIFEST)
        self.board.script_run(passed=1, total=1, files=1)
        for tier in TIER_VERBS:
            with self.subTest(verb=tier):
                before = len(self.board.events)
                result = self.drive(tier, f"sends-{tier}")
                del self.board.events[:before]
                body = self.assert_junit_ingest_with_raw_and_exit(result)
                self.assertEqual(body.get("tier"), tier, f"body={body!r}")

    def test_auto_ingest_sends_the_junit_text_with_no_raw_and_no_runner_exit(self):
        reports = Path(self.project, "reports")
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "junit.xml").write_text(JUNIT_TEXT)
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("auto-ingest", "sends-auto-ingest")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("codec"), "junit", f"body={body!r}")
        self.assertEqual(body.get("data"), [JUNIT_TEXT], f"body={body!r}")
        self.assertNotIn("raw", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("runnerExit", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_the_pre_merge_gate_regression_step_sends_one_runs_ingest_with_lcov(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("pre-merge-gate", "sends-gate", "--skip-check")
        body = self.assert_junit_ingest_with_raw_and_exit(result)
        self.assertEqual(body.get("coverage"), {"codec": "lcov", "data": [LCOV_TEXT]},
                         f"the gate measures coverage and sends its lcov report; "
                         f"body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))


# ── AC2 — coverage travels as its report ────────────────────────────────────

class CoverageTravelsAsItsReportTest(_BunProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_regression_coverage_sends_the_lcov_text_as_the_coverage_block(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("regression", "coverage-sent", "--coverage")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("coverage"), {"codec": "lcov", "data": [LCOV_TEXT]},
                         f"body={body!r}")
        self.assertNotIn("coverage-not-measured", _codes(self.envelope_of(result)),
                         self.diagnostics(result))

    def test_the_stderr_coverage_line_reads_the_responses_coverage(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("regression", "coverage-line", "--coverage")
        self.assertIn("lines=61.5%", result.stderr,
                      f"the coverage line states the board's lines figure; "
                      f"{self.diagnostics(result)}")
        self.assertIn("funcs=42.5%", result.stderr,
                      f"the coverage line states the board's functions figure; "
                      f"{self.diagnostics(result)}")
        self.assertNotIn("lines=100.0%", result.stderr,
                         f"the client's own lcov sum is never reported; "
                         f"{self.diagnostics(result)}")

    def test_a_coverage_run_with_no_lcov_sends_no_coverage_and_warns_coverage_not_measured(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "coverage-missing", "--coverage",
                            FAKE_NO_LCOV="1")
        body = self.the_one_runs_ingest(result)
        self.assertNotIn("coverage", body, f"body={body!r}")
        codes = _codes(self.envelope_of(result))
        self.assertEqual(codes.count("coverage-not-measured"), 1,
                         f"the envelope says the asked-for coverage was not "
                         f"measured, once; {self.diagnostics(result)}")


# ── AC5 — the local decisions: ran nothing, the filter, the exit ────────────

class TheLocalDecisionsTest(_BunProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_aborted_and_nothing_filed(self, result):
        self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        aborts = self.board.aborts()
        self.assertEqual(len(aborts), 1, f"aborts={aborts!r} {self.diagnostics(result)}")
        self.assertIn(FIRST_RUN, aborts[0][0] if aborts else "", f"aborts={aborts!r}")
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_runner_exiting_non_zero_over_a_report_with_no_testcase_ran_nothing(self):
        result = self.drive("regression", "ran-nothing", FAKE_ZERO="1", FAKE_EXIT="1")
        self.assert_aborted_and_nothing_filed(result)

    def test_a_name_filter_whose_report_holds_only_skipped_cases_ran_nothing(self):
        result = self.drive("test", "filter-matched-nothing", "--name",
                            "zeta-matches-nothing", FAKE_EXIT="1")
        self.assert_aborted_and_nothing_filed(result)
        warnings = json.dumps(self.envelope_of(result).get("warnings") or [])
        self.assertIn("zeta-matches-nothing", warnings, self.diagnostics(result))

    def test_a_failure_the_board_reports_makes_the_verb_exit_non_zero(self):
        # The runner exits 0 over a passing report; the board's decoded run
        # holds a failure (a case the client cannot see), and the verb's exit
        # is `verb_exit` over the board's answer.
        self.board.script_run(passed=1, failed=1, total=2, files=1)
        result = self.drive("test", "board-failure")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 1, self.diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertEqual(_figures(envelope).get("failed"), 1,
                         f"envelope={envelope!r}")

    def test_a_run_the_board_reports_clean_exits_zero(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "board-clean")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))


# ── AC6 — the envelope reads the response ──────────────────────────────────

class TheEnvelopeReadsTheResponseTest(_BunProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_the_envelope_run_block_is_the_responses_five_counts(self):
        # The report holds one passing case in one file; the board says
        # otherwise, and the envelope states what the board said.
        self.board.script_run(passed=7, failed=2, pending=3, total=12, files=5)
        for verb in ("test", "regression"):
            with self.subTest(verb=verb):
                result = self.drive(verb, f"envelope-counts-{verb}")
                self.assertEqual(
                    _figures(self.envelope_of(result)),
                    {"passed": 7, "failed": 2, "pending": 3, "total": 12, "files": 5},
                    self.diagnostics(result))
                self.assertEqual(
                    [token for line in result.stderr.splitlines()
                     if line.startswith("ingest: ")
                     for token in line.split() if token.startswith("files=")],
                    ["files=5"],
                    "the one `ingest:` line carries the answer's files figure; "
                    + self.diagnostics(result))

    def test_a_board_report_skipped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "report-skipped",
                   "detail": "report 1 skipped: not a JUnit report"}
        self.board.script_run(passed=1, total=1, files=1, warnings=[warning])
        result = self.drive("regression", "envelope-report-skipped")
        self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                      self.diagnostics(result))

    def test_a_board_coverage_dropped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "coverage-dropped",
                   "detail": "lcov coverage dropped: no SF record"}
        self.board.script_run(passed=1, total=1, files=1, warnings=[warning])
        result = self.drive("regression", "envelope-coverage-dropped", "--coverage")
        self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                      self.diagnostics(result))


# ── AC8 / AC9 — an older board, a body too large ───────────────────────────

class ABoardThatCannotTakeTheRunIsRefusedBeforeSendingTest(_BunProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_refused_before_sending(self, result, *named):
        self.assertEqual(self.posts_to(RUNS), [],
                         f"nothing is sent to {RUNS}; {self.diagnostics(result)}")
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        aborts = self.board.aborts()
        self.assertEqual(len(aborts), 1,
                         f"the run the verb opened is aborted; aborts={aborts!r} "
                         f"{self.diagnostics(result)}")
        self.assertIn(FIRST_RUN, aborts[0][0] if aborts else "", f"aborts={aborts!r}")
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn("run-aborted", _codes(envelope), f"envelope={envelope!r}")
        self.assertEqual(_figures(envelope), {},
                         f"a run that was not filed carries no figures; "
                         f"envelope={envelope!r}")
        said = json.dumps(envelope)
        for text in named:
            self.assertIn(text, said, f"the refusal names {text!r}; envelope={envelope!r}")
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_health_with_no_codecs_is_refused_naming_the_version_and_the_floor(self):
        health = self.board.default_health()
        health.pop("codecs")
        health["version"] = "0.3.7"
        self.board.script_health(health)
        result = self.drive("test", "older-board")
        self.assert_refused_before_sending(result, "0.3.7", "0.4.0")

    def test_codecs_lacking_lcov_refuse_a_coverage_run(self):
        health = self.board.default_health()
        health["codecs"] = {"test": ["junit"], "coverage": ["jacoco"]}
        health["version"] = "0.3.9"
        self.board.script_health(health)
        result = self.drive("regression", "board-without-lcov", "--coverage")
        self.assert_refused_before_sending(result, "0.3.9", "0.4.0", "lcov")

    def test_health_that_cannot_be_read_is_refused_before_sending(self):
        self.board.fail_health(status=503, error="health unavailable")
        result = self.drive("regression", "health-unreadable")
        self.assert_refused_before_sending(result)

    def test_health_with_codecs_but_no_limits_still_sends(self):
        health = self.board.default_health()
        health.pop("limits")
        self.board.script_health(health)
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "board-without-limits")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_body_over_the_advertised_limit_is_refused_naming_ingest_body_bytes(self):
        self.board.close()
        self.make(board=RecordingBoard(ingest_body_bytes=64))
        result = self.drive("test", "body-too-large")
        self.assert_refused_before_sending(result, "ingest_body_bytes", "64")

    def test_a_report_the_client_cannot_read_is_refused_before_sending_and_the_run_aborted(self):
        # The runner exits 0 and leaves a directory where `junit.xml` should
        # be (`os.path.exists` holds for it): the report cannot be read, a
        # refusal before sending that settles the open run as every other
        # one does.
        result = self.drive("test", "report-is-a-directory", FAKE_REPORT="dir")
        for stream, text in (("stdout", result.stdout), ("stderr", result.stderr)):
            self.assertNotIn("Traceback (most recent call last)", text,
                             f"the verb settles the refusal, it does not crash "
                             f"({stream}); {self.diagnostics(result)}")
        self.assert_refused_before_sending(result, "junit.xml", "nothing was sent")
        error = self.envelope_of(result).get("error")
        self.assertIsInstance(error, str, self.diagnostics(result))
        self.assertIn(os.path.join("reports", ""), error or "",
                      f"the envelope's error names the report's path; "
                      f"{self.diagnostics(result)}")
        self.assertIn("junit.xml", error or "",
                      f"the envelope's error names the unreadable report; "
                      f"{self.diagnostics(result)}")
        aborts = self.board.aborts()
        self.assertIn("junit.xml",
                      (aborts[0][1] or {}).get("reason", "") if aborts else "",
                      f"the abort's reason is the refusal; aborts={aborts!r}")

    def test_a_413_from_the_board_is_reported_naming_ingest_body_bytes(self):
        self.board.refuse_ingest_for(FIRST_RUN, status=413)
        result = self.drive("test", "board-413")
        self.assertEqual(len(self.posts_to(RUNS)), 1, self.diagnostics(result))
        envelope = self.envelope_of(result)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertIn("ingest_body_bytes", str(envelope.get("error")),
                      f"envelope={envelope!r}")
        self.assertEqual(_figures(envelope), {}, f"envelope={envelope!r}")
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


# ── AC7 — no board, no figures ──────────────────────────────────────────────

_UNREACHABLE = {"ok": False, "error": "connection failed: [Errno 111] Connection "
                                      "refused (is Crucible running?)"}


class NoBoardNoFiguresTest(_BunProject, unittest.TestCase):
    """The client's own `main()`, in-process, with ONE route answered as the
    fleet transport answers a board it cannot reach; every other route
    reaches the recording board."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_in_process(self, argv, unreachable):
        module = load_client("bun-crucible.py")
        real_request = module._request

        def request(method, path, payload=None, timeout=None):
            if (method, path) in unreachable:
                return dict(_UNREACHABLE)
            return real_request(method, path, payload, timeout)

        out, err = io.StringIO(), io.StringIO()
        env = self.env()
        with mock.patch.object(module, "_request", request), \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(sys, "argv", ["bun-crucible.py", *argv]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                module.main()
                code = 0
            except SystemExit as exit_:
                code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def assert_no_figures_and_not_filed(self, code, stdout, stderr):
        where = f"exit={code} stdout={stdout!r} stderr={stderr[-2500:]!r}"
        envelope = _envelope(stdout)
        self.assertIsNotNone(envelope, where)
        envelope = envelope or {}
        self.assertIs(envelope.get("ok"), False, where)
        self.assertEqual(_figures(envelope), {},
                         f"with no board there are no figures; {where}")
        self.assertIsInstance(envelope.get("error"), str,
                              f"the envelope says why the run was not filed; {where}")
        self.assertNotEqual(code, 0, where)
        return envelope

    def test_an_ingest_that_cannot_reach_the_board_carries_no_figures(self):
        code, stdout, stderr = self.drive_in_process(
            self.argv("test", "ingest-unreachable"), {("POST", RUNS), ("POST", PARSED)})
        envelope = self.assert_no_figures_and_not_filed(code, stdout, stderr)
        self.assertIn("connection failed", envelope.get("error") or "", stdout)

    def test_a_health_read_that_cannot_reach_the_board_sends_nothing(self):
        code, stdout, stderr = self.drive_in_process(
            self.argv("regression", "health-unreachable"), {("GET", HEALTH)})
        self.assert_no_figures_and_not_filed(code, stdout, stderr)
        self.assertEqual(self.posts_to(RUNS), [], stdout)
        self.assertEqual(self.posts_to(PARSED), [], stdout)
        self.assertIn("run-aborted", _codes(_envelope(stdout)), stdout)

    def test_pre_merge_gate_reports_its_unfiled_suite_unreported_and_is_not_green(self):
        # A project declaring an own-stack suite: the gate composes, and its
        # whole-suite run is a suite whose outcome it must report.
        Path(self.project, "package.json").write_text(json.dumps(
            {"name": "bun-sends-its-reports", "private": True,
             "scripts": {"test:unit": "bun test"}}, indent=2))
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "gate-unreachable", "--skip-check"),
            {("POST", RUNS), ("POST", PARSED)})
        where = f"exit={code} stdout={stdout!r} stderr={stderr[-2500:]!r}"
        envelope = _envelope(stdout) or {}
        self.assertIs(envelope.get("ok"), False, where)
        self.assertIn("gate-suite-unreported", _codes(envelope),
                      f"the gate names the suite it could not file as "
                      f"unreported; {where}")
        self.assertNotIn("gate-suite-failed", _codes(envelope), where)
        self.assertNotEqual(code, 0, where)


# ── the no-report exits, unchanged ─────────────────────────────────────────

class TheNoReportExitsAreUnchangedTest(_BunProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_test_with_no_junit_files_its_synthetic_compile_ingest_and_no_run(self):
        result = self.drive("test", "no-junit", FAKE_REPORT="none", FAKE_EXIT="1")
        compiles = self.posts_to(COMPILE)
        self.assertEqual(len(compiles), 1, self.diagnostics(result))
        self.assertIn("TS0000", (compiles[0] or {}).get("errors", ""),
                      f"compile body={compiles[0]!r}")
        self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_regression_with_no_report_is_aborted_and_files_no_run(self):
        result = self.drive("regression", "no-report", FAKE_REPORT="none", FAKE_EXIT="1")
        self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(COMPILE), [], self.diagnostics(result))
        aborts = self.board.aborts()
        self.assertEqual(len(aborts), 1, f"aborts={aborts!r}")
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


if __name__ == "__main__":
    unittest.main()
