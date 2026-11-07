"""A rust run streams its tests through nextest on every verb of the four
test-running bodies — `test`, `unit`, `integration`, `e2e`
(`_test_run`), `regression-ingest`, `smoke-test`, `docker-e2e-gate`,
`workspace-regression`, `regression` with and without `--coverage`, and
`pre-merge-gate` — driven on the shared fake cargo.

With an agent, each verb:
  - lists its tests (`cargo nextest list --message-format json`, the run's own
    profile and selection) and posts the list to the open run before the run
    starts, codec `nextest-list`;
  - runs `cargo nextest run --no-fail-fast --message-format libtest-json-plus
    --message-format-version 0.1` with NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1,
    whatever the environment holds, and relays the runner's stdout, and only
    its stdout, to the open run with codec `nextest`;
  - keeps the runner's stderr (nextest's human output) as the run's raw
    capture and its `--log`, never the stream;
  - states `framework: "nextest"` on the run's start and its close, and closes
    the run from its stream: no JUnit report is filed;
  - for a coverage verb, lists and runs under `cargo llvm-cov show-env`'s
    environment in its own target directory (`target/llvm-cov-target`),
    clears old profiles before the list, and files the lcov `cargo llvm-cov
    report --failure-mode all --lcov` writes, even when a test failed.

Each state: a compile error at the list, a list the board refuses or cannot
take, a run that ran nothing, a run with no stream line, the stream switch
set to 0, an interrupted run, a stream cut short, a failing run (fail-fast),
the closing narration, `--ignore-run-fail`, and a run without an agent.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_rust_run_streams_its_tests_through_nextest
"""

import os
import re
import signal
import subprocess
import unittest
from pathlib import Path

from tests.client.fake_nextest import DEFAULT_LCOV
from tests.client.rust_stream_harness import (
    AGENT_OPTIONAL_VERBS,
    COVERAGE_VERBS,
    IGNORE_RUN_FAIL_VERBS,
    RUN_ID,
    TIMEOUT,
    VERBS,
    StreamedRustProject,
    diagnostics,
    envelope,
    fake_list,
    results,
    selection,
    stream_lines,
    wait_until,
    warning_texts,
)

STREAM_FLAGS = ("--message-format", "libtest-json-plus")
FORMAT_VERSION = ("--message-format-version", "0.1")
COVERAGE_TARGET = os.path.join("target", "llvm-cov-target")
DISTINCT_LCOV = "SF:src/streamed.rs\nDA:7,1\nLF:1\nLH:1\nend_of_record\n"


def _flag_pair(argv, pair):
    flag, value = pair
    return any(argv[i] == flag and argv[i + 1] == value for i in range(len(argv) - 1))


def _effective_target(call):
    argv = call["argv"]
    for i, arg in enumerate(argv):
        if arg == "--target-dir" and i + 1 < len(argv):
            return argv[i + 1]
    return call["env"].get("CARGO_TARGET_DIR")


class _Streamed(unittest.TestCase):
    maxDiff = 4000

    def project(self, **options):
        return StreamedRustProject(self, **options)

    def index(self, found, where):
        """`found`, an index that must exist."""
        if found is None:
            self.fail(f"the call or post was never made; {where}")
        return int(found)

    def assert_streamed_close(self, p, result, where):
        closes = p.closes()
        self.assertEqual(len(closes), 1,
                         f"{where}: the run is closed by exactly one ingest; "
                         f"{diagnostics(result)}")
        close = closes[0]
        self.assertEqual(close.get("codec"), "nextest",
                         f"{where}: the run is closed from its nextest stream; "
                         f"close codec={close.get('codec')!r}")
        self.assertEqual(close.get("runId"), RUN_ID, f"{where}: the open run is closed")
        self.assertNotIn("data", close,
                         f"{where}: a stream close carries no report of its own")
        return close


class EveryVerbStreamsItsRunTest(_Streamed):
    """The run on every verb, a passing fake run of three tests."""

    def test_every_verb_relays_only_nextest_stream_batches_and_closes_from_the_stream(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                p.board.script_run(passed=3)
                result = p.drive(label, FAKE_TOTAL="3")
                where = f"{label}: {diagnostics(result)}"
                batches = p.board.stream_posts()
                self.assertGreaterEqual(len(batches), 1, f"no stream batch was relayed; {where}")
                self.assertEqual({b.get("codec") for _p, b in batches}, {"nextest"},
                                 f"every stream batch carries codec nextest; {where}")
                held = p.held()
                self.assertEqual([r["event"] for r in results(held)], ["ok", "ok", "ok"],
                                 f"the board holds the stream's three results; {where}")
                self.assertEqual(
                    [line for line in stream_lines(held) if not isinstance(line, dict)], [],
                    f"the stream holds the runner's stdout alone, no human line; {where}")
                self.assert_streamed_close(p, result, label)
                self.assertEqual(p.junit_ingests(), [],
                                 f"no JUnit report is filed; {where}")
                self.assertEqual(result.returncode, 0, f"a passing run exits 0; {where}")

    def test_every_verb_states_framework_nextest_on_its_start_and_its_close(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="2")
                starts = p.starts()
                self.assertEqual(len(starts), 1, f"{label}: one run opened; {diagnostics(result)}")
                self.assertEqual(starts[0].get("framework"), "nextest",
                                 f"{label}: the run start states framework nextest; "
                                 f"start={starts[0]!r}")
                close = self.assert_streamed_close(p, result, label)
                self.assertEqual(close.get("framework"), "nextest",
                                 f"{label}: the close states framework nextest")

    def test_every_verb_runs_nextest_with_no_fail_fast_the_stream_flags_and_the_variable_forced(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="2")
                runs = p.calls_of("nextest", "run")
                self.assertEqual(len(runs), 1,
                                 f"{label}: one nextest run; calls={[c['argv'] for c in p.calls()]!r} "
                                 f"{diagnostics(result)}")
                argv = runs[0]["argv"]
                self.assertIn("--no-fail-fast", argv, f"{label}: argv={argv!r}")
                self.assertTrue(_flag_pair(argv, STREAM_FLAGS), f"{label}: argv={argv!r}")
                self.assertTrue(_flag_pair(argv, FORMAT_VERSION), f"{label}: argv={argv!r}")
                self.assertNotIn("--ignore-run-fail", argv, f"{label}: argv={argv!r}")
                self.assertEqual(runs[0]["env"].get("NEXTEST_EXPERIMENTAL_LIBTEST_JSON"), "1",
                                 f"{label}: the stream variable the run saw")

    def test_every_verb_lists_its_tests_with_the_runs_own_selection_and_posts_the_list_first(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="3")
                where = f"{label}: calls={[c['argv'] for c in p.calls()]!r} {diagnostics(result)}"
                lists = p.calls_of("nextest", "list")
                runs = p.calls_of("nextest", "run")
                self.assertEqual((len(lists), len(runs)), (1, 1),
                                 f"one list and one run; {where}")
                self.assertTrue(_flag_pair(lists[0]["argv"], ("--message-format", "json")),
                                f"the list is nextest's json; {where}")
                self.assertLess(self.index(p.call_index("nextest", "list"), where),
                                self.index(p.call_index("nextest", "run"), where),
                                f"the list runs before the run; {where}")
                self.assertEqual(selection(lists[0]["argv"]), selection(runs[0]["argv"]),
                                 f"the list selects exactly what the run selects; {where}")
                posted = p.board.list_posts()
                self.assertEqual(len(posted), 1, f"one list posted; {where}")
                path, body = posted[0]
                self.assertEqual(path, f"/api/v2/runs/{RUN_ID}/tests", where)
                self.assertEqual(body.get("codec"), "nextest-list", where)
                self.assertEqual(body.get("data"), fake_list(3),
                                 f"the list is posted as nextest wrote it; {where}")
                list_at = p.first_post_index(lambda pth, _b: pth.endswith("/tests"))
                batch_at = p.first_post_index(lambda pth, _b: pth.endswith("/stream"))
                self.assertLess(self.index(list_at, where), self.index(batch_at, where), f"the list is posted before the first batch; {where}")

    def test_every_verb_keeps_the_runners_stderr_as_its_raw_capture_and_never_the_stream(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="2")
                close = self.assert_streamed_close(p, result, label)
                raw = close.get("raw") or ""
                self.assertIn("Starting 2 tests", raw,
                              f"{label}: the raw capture is nextest's human output")
                self.assertNotIn('"type":"test"', raw,
                                 f"{label}: the stream is not part of the raw capture")
                self.assertIn("Starting 2 tests", result.stderr,
                              f"{label}: the human output is echoed on stderr")
                self.assertNotIn('"type":"test"', result.stdout,
                                 f"{label}: stdout stays the envelope's channel")

    def test_the_log_of_a_streamed_run_holds_its_stderr_and_not_its_stream(self):
        for label in ("test", "unit", "integration", "e2e"):
            with self.subTest(verb=label):
                p = self.project()
                log = os.path.join(p.dir, "run.log")
                result = p.drive(label, "--log", log, FAKE_TOTAL="2")
                self.assertTrue(os.path.exists(log), f"{label}: {diagnostics(result)}")
                text = Path(log).read_text()
                self.assertIn("Starting 2 tests", text, f"{label}: the log holds the stderr")
                self.assertNotIn('"type":"test"', text, f"{label}: the log holds no stream line")


class CoverageVerbsRunInOneInstrumentedBuildTest(_Streamed):

    def test_a_coverage_verb_lists_and_runs_under_show_env_in_its_own_target_dir(self):
        for label in COVERAGE_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="2")
                where = f"{label}: calls={[c['argv'] for c in p.calls()]!r} {diagnostics(result)}"
                show = self.index(p.call_index("llvm-cov", "show-env"), where)
                listed = self.index(p.call_index("nextest", "list"), where)
                ran = self.index(p.call_index("nextest", "run"), where)
                report = self.index(p.call_index("llvm-cov", "report"), where)
                self.assertTrue(show < listed < ran < report,
                                f"show-env, then list, then run, then report; {where}")
                for call in (p.calls()[listed], p.calls()[ran]):
                    self.assertEqual(call["env"].get("CARGO_LLVM_COV"), "1",
                                     f"{call['argv'][:2]} runs under show-env's environment; {where}")
                    self.assertEqual(_effective_target(call),
                                     os.path.join(p.dir, COVERAGE_TARGET),
                                     f"{call['argv'][:2]} builds in the coverage target dir; {where}")
                self.assertEqual(p.calls_of("llvm-cov", "nextest"), [],
                                 f"no `cargo llvm-cov nextest` is run; {where}")

    def test_a_coverage_verb_files_the_lcov_report_writes_even_when_a_test_failed(self):
        for label in COVERAGE_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="2", FAKE_CARGO_VERDICT="FAIL",
                                 FAKE_LCOV=DISTINCT_LCOV)
                reports = p.calls_of("llvm-cov", "report")
                self.assertEqual(len(reports), 1, f"{label}: {diagnostics(result)}")
                argv = reports[0]["argv"]
                self.assertTrue(_flag_pair(argv, ("--failure-mode", "all")), f"argv={argv!r}")
                self.assertIn("--lcov", argv, f"argv={argv!r}")
                close = self.assert_streamed_close(p, result, label)
                coverage = close.get("coverage") or {}
                self.assertEqual(coverage.get("codec"), "lcov", f"{label}: close={close!r}")
                data = coverage.get("data")
                texts = data if isinstance(data, list) else [data]
                self.assertIn(DISTINCT_LCOV, texts, f"{label}: the report's lcov is filed")
                self.assertNotEqual(result.returncode, 0,
                                    f"{label}: the verb's exit follows the failing tests")

    def test_a_coverage_verb_clears_old_profiles_before_its_list(self):
        for label in COVERAGE_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                stale = Path(p.dir, COVERAGE_TARGET, "stale-run-1-0.profraw")
                stale.parent.mkdir(parents=True)
                stale.write_bytes(b"old profile")
                result = p.drive(label, FAKE_TOTAL="1")
                lists = p.calls_of("nextest", "list")
                self.assertEqual(len(lists), 1, f"{label}: {diagnostics(result)}")
                self.assertEqual(lists[0]["profraw"], [],
                                 f"{label}: no old profile is left when the list runs")

    def test_a_verb_without_coverage_runs_outside_the_coverage_environment(self):
        for label in [v for v in VERBS if v not in COVERAGE_VERBS]:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="1")
                self.assertEqual(p.calls_of("llvm-cov"), [], f"{label}: {diagnostics(result)}")
                for call in p.calls_of("nextest"):
                    self.assertIsNone(call["env"].get("CARGO_LLVM_COV"),
                                      f"{label}: {call['argv'][:2]} ran outside coverage")
                close = self.assert_streamed_close(p, result, label)
                self.assertNotIn("coverage", close, f"{label}: no coverage is filed")


class EachStateOnEveryVerbTest(_Streamed):

    def test_a_compile_error_at_the_list_files_a_compile_failure_closing_the_run(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="2", FAKE_LIST_COMPILE_ERROR="1")
                where = f"{label}: {diagnostics(result)}"
                compiles = p.compiles()
                self.assertEqual(len(compiles), 1, f"one compile failure is filed; {where}")
                self.assertEqual(compiles[0].get("runId"), RUN_ID,
                                 f"the compile failure closes the open run; {where}")
                self.assertIn("error[E0425]", compiles[0].get("errors") or "",
                              f"the list's rustc errors are filed; {where}")
                self.assertEqual(p.calls_of("nextest", "run"), [], f"no run step follows; {where}")
                self.assertEqual(p.board.stream_posts(), [], where)
                self.assertEqual(p.board.list_posts(), [], where)
                self.assertEqual(p.closes(), [], where)
                self.assertNotEqual(result.returncode, 0, where)
                self.assertIs((envelope(result.stdout) or {}).get("ok"), False, where)

    def test_a_list_the_board_refuses_lets_the_run_stream_on_with_a_warning_naming_it(self):
        for status in (400, 409, 413):
            for label in VERBS:
                with self.subTest(verb=label, status=status):
                    p = self.project()
                    p.board.refuse_next_list(status, f"list refused with marker-{status}")
                    p.board.script_run(passed=2)
                    result = p.drive(label, FAKE_TOTAL="2")
                    where = f"{label}: {diagnostics(result)}"
                    self.assertEqual(len(results(p.held(), "ok")), 2,
                                     f"the run streamed on; {where}")
                    self.assert_streamed_close(p, result, label)
                    named = [w for w in warning_texts(envelope(result.stdout))
                             if "list" in w.lower()
                             and (str(status) in w or f"marker-{status}" in w)]
                    self.assertEqual(len(named), 1,
                                     f"one warning names the refused list and why; {where}")

    def test_a_list_the_board_cannot_be_reached_for_lets_the_run_stream_on_with_a_warning(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                p.board.drop_next(f"/api/v2/runs/{RUN_ID}/tests", "reset")
                p.board.script_run(passed=2)
                result = p.drive(label, FAKE_TOTAL="2")
                where = f"{label}: {diagnostics(result)}"
                self.assertEqual(len(results(p.held(), "ok")), 2, f"the run streamed on; {where}")
                self.assert_streamed_close(p, result, label)
                named = [w for w in warning_texts(envelope(result.stdout)) if "list" in w.lower()]
                self.assertGreaterEqual(len(named), 1, f"a warning names the untaken list; {where}")
                self.assertLessEqual(len(named), 1, where)

    def test_a_list_with_no_match_and_a_stream_with_no_result_ran_nothing(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="0")
                where = f"{label}: {diagnostics(result)}"
                self.assertEqual(len(p.board.list_posts()), 1, f"the empty list is posted; {where}")
                self.assertEqual([b.get("runId") for _p, b in p.board.aborts()], [RUN_ID],
                                 f"the run that ran nothing is aborted; {where}")
                self.assertEqual(p.closes(), [], f"nothing is filed; {where}")
                self.assertEqual(p.compiles(), [], where)
                self.assertNotEqual(result.returncode, 0, where)
                self.assertIs((envelope(result.stdout) or {}).get("ok"), False, where)

    def test_a_run_exiting_non_zero_with_no_stream_line_is_a_no_report_failure_not_a_compile_one(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="2", FAKE_STREAM_SILENT="1")
                where = f"{label}: {diagnostics(result)}"
                self.assertEqual(len(p.board.list_posts()), 1, f"the list succeeded; {where}")
                self.assertEqual(p.compiles(), [], f"never a compile failure; {where}")
                axi = envelope(result.stdout) or {}
                self.assertIs(axi.get("ok"), False, where)
                codes = [w.get("code") for w in axi.get("warnings") or [] if isinstance(w, dict)]
                self.assertIn("no-test-reports", codes, f"a no-report failure; {where}")
                self.assertNotEqual(result.returncode, 0, where)

    def test_the_stream_variable_set_to_zero_in_the_environment_still_streams(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                p.board.script_run(passed=2)
                result = p.drive(label, FAKE_TOTAL="2", NEXTEST_EXPERIMENTAL_LIBTEST_JSON="0")
                where = f"{label}: {diagnostics(result)}"
                runs = p.calls_of("nextest", "run")
                self.assertEqual(len(runs), 1, where)
                self.assertEqual(runs[0]["env"].get("NEXTEST_EXPERIMENTAL_LIBTEST_JSON"), "1", where)
                self.assertEqual(len(results(p.held(), "ok")), 2, f"the run streamed; {where}")
                self.assertEqual(result.returncode, 0, where)

    def test_an_interrupted_run_is_aborted_keeping_the_stream_it_relayed(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                marker = "STREAM_INTERRUPT_MARKER"
                release = os.path.join(p.dir, "release-the-runner")
                err_path = os.path.join(p.dir, "client-stderr.txt")
                env = p.env(FAKE_TOTAL="3", FAKE_BLOCK_AFTER_INDEX="3",
                            FAKE_MARKER_LINE=marker, FAKE_RELEASE_FILE=release)
                with open(err_path, "w") as err:
                    proc = subprocess.Popen(p.argv(label), cwd=p.dir, env=env,
                                            stdout=subprocess.PIPE, stderr=err, text=True)
                    try:
                        relayed = wait_until(lambda: len(results(p.held(), "ok")) == 2, 8)
                        if relayed:
                            proc.send_signal(signal.SIGTERM)
                        stdout, _ = proc.communicate(timeout=TIMEOUT)
                    finally:
                        Path(release).write_text("go")
                        if proc.poll() is None:
                            proc.kill()
                            proc.wait()
                where = f"{label}: exit={proc.returncode} stderr={Path(err_path).read_text()[-1500:]!r}"
                self.assertTrue(relayed, f"the two results before the block were relayed; {where}")
                self.assertEqual([b.get("runId") for _p, b in p.board.aborts()], [RUN_ID],
                                 f"the interrupted run is aborted; {where}")
                self.assertEqual(p.closes(), [], f"no close follows an abort; {where}")
                self.assertEqual(len(results(p.held(), "ok")), 2,
                                 f"the board keeps the stream it was sent; {where}")
                self.assertNotEqual(proc.returncode, 0, where)

    def test_a_stream_cut_after_a_started_line_is_closed_from_its_stream_and_never_green(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                p.board.script_run(passed=1, warnings=[{
                    "code": "stream-incomplete",
                    "detail": "the stream was cut: a test started with no result"}])
                result = p.drive(label, FAKE_TOTAL="3", FAKE_STREAM_CUT_AFTER="2")
                where = f"{label}: {diagnostics(result)}"
                lines = [x for x in stream_lines(p.held()) if isinstance(x, dict)] or [{}]
                self.assertEqual((lines[-1].get("type"), lines[-1].get("event")),
                                 ("test", "started"),
                                 f"the held stream ends on the cut test's started line; {where}")
                self.assert_streamed_close(p, result, label)
                self.assertEqual(p.board.aborts(), [], f"a cut run is stored, not aborted; {where}")
                self.assertEqual(p.compiles(), [], where)
                codes = [w.get("code") for w in (envelope(result.stdout) or {}).get("warnings") or []
                         if isinstance(w, dict)]
                self.assertIn("stream-incomplete", codes, where)
                self.assertNotEqual(result.returncode, 0, where)

    def test_a_failing_run_runs_every_listed_test_despite_the_failure(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                p.board.script_run(failed=3)
                result = p.drive(label, FAKE_TOTAL="3", FAKE_CARGO_VERDICT="FAIL")
                where = f"{label}: {diagnostics(result)}"
                self.assertEqual([r["event"] for r in results(p.held())],
                                 ["failed", "failed", "failed"],
                                 f"every listed test ran despite the first failure; {where}")
                self.assert_streamed_close(p, result, label)
                self.assertNotEqual(result.returncode, 0, where)

    def test_the_closing_narration_counts_the_streams_results_against_the_boards_listed_total(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                p.board.script_list_total(5)
                result = p.drive(label, FAKE_TOTAL="3", FAKE_HUMAN_TOTAL="99")
                messages = p.board.messages()
                closing = [m for m in messages if re.match(r"^ran \d+/\d+", m)]
                self.assertEqual(closing, ["ran 3/5"],
                                 f"{label}: messages={messages!r} {diagnostics(result)}")
                self.assertEqual([m for m in messages if "/99" in m], [],
                                 f"{label}: nextest's human total is never narrated")

    def test_ignore_run_fail_is_refused_on_each_verb_that_accepted_it(self):
        for label, verb_argv in IGNORE_RUN_FAIL_VERBS.items():
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, "--ignore-run-fail", verb_argv=verb_argv, FAKE_TOTAL="1")
                where = f"{label}: {diagnostics(result)}"
                self.assertNotEqual(result.returncode, 0, where)
                axi = envelope(result.stdout) or {}
                self.assertIs(axi.get("ok"), False, f"one refusal envelope; {where}")
                said = " ".join([str(axi.get("error") or "")] + warning_texts(axi))
                self.assertIn("--ignore-run-fail", said, where)
                self.assertIn("lcov", said, f"the refusal says the lcov is always written; {where}")
                self.assertEqual(p.starts(), [], f"no run is opened; {where}")
                self.assertEqual(p.calls_of("nextest"), [], f"nothing is run; {where}")
                self.assertEqual(p.calls_of("llvm-cov"), [], where)

    def test_a_run_without_an_agent_posts_nothing_lists_nothing_and_runs_without_the_stream(self):
        for label in AGENT_OPTIONAL_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, agent=None, FAKE_TOTAL="2")
                where = f"{label}: calls={[c['argv'] for c in p.calls()]!r} {diagnostics(result)}"
                self.assertEqual(p.posts(), [], f"nothing is posted; {where}")
                self.assertEqual(p.calls_of("nextest", "list"), [], f"nothing is listed; {where}")
                runs = p.calls_of("nextest", "run")
                self.assertEqual(len(runs), 1, where)
                self.assertNotIn("--message-format", runs[0]["argv"], where)
                self.assertIn("PASS [", result.stdout + result.stderr,
                              f"nextest's human output reaches the terminal; {where}")
                self.assertEqual(result.returncode, 0, where)


if __name__ == "__main__":
    unittest.main()
