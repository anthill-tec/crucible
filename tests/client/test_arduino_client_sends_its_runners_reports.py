"""The arduino client sends its runner's reports and parses nothing.

Every arduino verb that files a report (`test`, `unit`, `regression`, a
declared make target such as `integration`, `pre-merge-gate`'s whole suite,
and `auto-ingest`) files it through the shared ingest (`ingest_reports`,
clients/_crucible_run.py): the board's health is read first, then ONE
`POST /api/v2/runs` goes out carrying `codec: "junit"`, `data` (the text of
every `TEST-*.xml` the verb reads, sorted), `coverage: {codec: "lcov", data}`
on a coverage run that found its `lcov.info` (passing or failing), `raw` (the
captured `make` output, on every verb but `auto-ingest`) and `runnerExit`.
Nothing goes to `/api/v2/runs/parsed`, and no body carries a `dataPath`.

Every figure the envelope reports is the board's: its `run:` block is the
answer's `run` block (`files` included), each figure null when the run was
not filed; the one stderr `ingest:` line reads the answer, and the answer's
`warnings[]` join the envelope's. A run whose ingest was not `ok` carries the
answer's `error` and `ingest-failed`. With no board there are no figures, and
a `pre-merge-gate` that could not file its suite names it
`gate-suite-unreported` and is not green. A board that cannot decode the run
(no `codecs`, or no `lcov` for a coverage run), or whose advertised
`ingest_body_bytes` the body exceeds, is refused before anything is sent, and
the run the verb opened is aborted.

The client still decides locally whether a run "ran nothing" (a non-zero
`make` over reports with no `<testcase>`), and its exit by `verb_exit` over
`make`'s exit and the board's answer; `auto-ingest`, which runs no runner,
exits 0 only on an `ok` answer whose run records no failure. A run without
`--agent` files nothing, prints `ran <n> testcases (<m> not skipped); runner
exit <rc>` and exits with `make`'s exit. The client defines no report parser
and no emitter of its own figures, and the shared modules do not grow past
their line budget.

Every drive runs the real `clients/arduino-crucible.py` over a scratch
firmware project (outside git) with a fake `make` first on PATH, which
writes the exact report and lcov texts below into `$REPORTS_DIR` and
`$COVERAGE_DIR`. Most drive it as a subprocess against a `RecordingBoard`
whose `/api/v2/runs` answer the test scripts; the ones that need a board that
cannot be reached at one route drive `main()` in-process with that one route
answered as the transport answers an unreachable board.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_arduino_client_sends_its_runners_reports
"""

import ast
import contextlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    load_client,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
ARDUINO_CLIENT = CLIENTS / "arduino-crucible.py"
TIMEOUT = 120
PROJECT_KEY = "arduino-sends-its-reports-key"
NATIVE_DIR = "tests/native"

RUNS = "/api/v2/runs"
PARSED = "/api/v2/runs/parsed"
HEALTH = "/api/health"
FIRST_RUN = "run-live-1"

# The line the fake prints on stdout: the captured output `raw` carries.
OUTPUT_MARKER = "fake-make-output-line-4e17"

_CASE = ('    <testcase name="{name}" classname="{stem}" file="test/{stem}.cpp" '
         'line="12" time="0.000010">{body}</testcase>\n')
_BODIES = {"pass": "",
           "fail": ('<failure message="Expected 4 Was 8" type="assertion">'
                    'test/{stem}.cpp:21: Expected 4 Was 8</failure>'),
           "skip": '<skipped message="not on this board"/>'}


def _report(stem, cases):
    """One native-harness JUnit report, byte for byte: `<testsuites>` around
    one `<testsuite>` named for the test file, `cases` a list of
    `(name, outcome)` with outcome `pass`, `fail` or `skip`."""
    body = "".join(_CASE.format(name=name, stem=stem,
                                body=_BODIES[outcome].format(stem=stem))
                   for name, outcome in cases)
    failures = sum(1 for _n, outcome in cases if outcome == "fail")
    skipped = sum(1 for _n, outcome in cases if outcome == "skip")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n'
            f'  <testsuite name="{stem}" tests="{len(cases)}" '
            f'failures="{failures}" skipped="{skipped}" time="0.000020">\n'
            + body + '  </testsuite>\n</testsuites>\n')


# The reports the fake writes, `{file name: text}`: one passing case in each
# of two test files (`pass`), the same with the second failing (`fail`) or
# skipped (`skip`), or one report that holds no case at all (`zero`).
REPORTS = {
    "pass": {"TEST-test_motor.xml": _report("test_motor", [("test_spins_up", "pass")]),
             "TEST-test_pid.xml": _report("test_pid", [("test_tunes", "pass")])},
    "fail": {"TEST-test_motor.xml": _report("test_motor", [("test_spins_up", "pass")]),
             "TEST-test_pid.xml": _report("test_pid", [("test_tunes", "fail")])},
    "skip": {"TEST-test_motor.xml": _report("test_motor", [("test_spins_up", "pass")]),
             "TEST-test_pid.xml": _report("test_pid", [("test_tunes", "skip")])},
    "zero": {"TEST-test_motor.xml": ('<?xml version="1.0" encoding="UTF-8"?>\n'
                                     '<testsuites>\n  <testsuite name="test_motor" '
                                     'tests="0" failures="0"/>\n</testsuites>\n')},
}


def _sent(variant):
    """The `data` a run of `variant` sends: each report's text, sorted by
    path."""
    return [REPORTS[variant][name] for name in sorted(REPORTS[variant])]


# The lcov the native harness writes at `$COVERAGE_DIR/lcov.info`, byte for
# byte (lines 8/10, functions 1/2): summed by a client, 80% and 50%.
LCOV = ("TN:\nSF:/project/src/motor.cpp\nFN:1,motor_spin\nFN:5,motor_stop\n"
        "FNDA:3,motor_spin\nFNDA:0,motor_stop\nFNF:2\nFNH:1\nDA:1,3\nDA:2,3\n"
        "DA:3,3\nDA:4,3\nDA:5,0\nDA:6,0\nDA:7,3\nDA:8,3\nDA:9,3\nDA:10,3\n"
        "LF:10\nLH:8\nend_of_record\n")
LCOV_BLOCK = {"codec": "lcov", "data": [LCOV]}

_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "AGENT_ID", "TESTS", "TEST_NAME")
_FAKE_KEYS = ("FAKE_EXIT", "FAKE_VARIANT", "FAKE_NO_LCOV")

# A fake `make`. Whatever the target, it prints OUTPUT_MARKER and Unity's
# verdict line on stdout, writes the FAKE_VARIANT reports (`pass` by default;
# `fail`, `skip`, `zero`, or `none` for no report) into REPORTS_DIR (else
# `reports/` under its cwd), and, when COVERAGE_DIR is set, the lcov there as
# `lcov.info` unless FAKE_NO_LCOV=1. It exits FAKE_EXIT (default 0).
_FAKE_MAKE = r'''
import os
import sys

REPORTS, LCOV, MARKER = ''' + repr((REPORTS, LCOV, OUTPUT_MARKER)) + r'''

def write(directory, name, text):
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, name), "w") as handle:
        handle.write(text)

variant = os.environ.get("FAKE_VARIANT", "pass")
sys.stdout.write(MARKER + "\n")
sys.stdout.write("test/test_motor.cpp:12:test_spins_up:PASS\n")
sys.stdout.flush()
if variant != "none":
    for name, text in REPORTS[variant].items():
        write(os.environ.get("REPORTS_DIR") or "reports", name, text)
coverage_dir = os.environ.get("COVERAGE_DIR")
if coverage_dir and os.environ.get("FAKE_NO_LCOV") != "1":
    write(coverage_dir, "lcov.info", LCOV)
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''

# Each verb's own flags beyond `--agent`/`--project-dir`.
VERB_FLAGS = {
    "test": (),
    "unit": (),
    "regression": (),
    "integration": (),
    "pre-merge-gate": ("--skip-check",),
    "auto-ingest": (),
}
COVERAGE_REGRESSION = ("--coverage",)

# The tier each verb's run is filed under; `test` and `auto-ingest` claim none.
TIERS = {"unit": "unit", "regression": "regression", "integration": "integration",
         "pre-merge-gate": "regression"}

# The old result lines: `[crucible] <verb> -> '<key>': <p>/<t> passed, ...`.
_OWN_LINE = re.compile(r"-> '[^']*': \d+/\d+ passed, ")


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _envelope_count(stdout):
    return len(re.findall(r"(?m)^axi:", stdout or ""))


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


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


class _ArduinoProject:
    """A scratch firmware project with the fake `make` on PATH, filing to a
    RecordingBoard."""

    def make(self, board=None):
        self.project = new_scratch("arduino-sends-its-reports-")
        self.bin_dir = new_scratch("arduino-sends-its-reports-bin-")
        self.native_dir = os.path.join(self.project, *NATIVE_DIR.split("/"))
        os.makedirs(self.native_dir)
        self.board = board or RecordingBoard()
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        self.point_at(self.board)
        _write_script(os.path.join(self.bin_dir, "make"), _FAKE_MAKE)

    def point_at(self, board):
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(board.url)}\n")

    def fresh_board(self, board=None):
        """Swap in a board whose record holds only what comes next."""
        self.board.close()
        self.board = board or RecordingBoard()
        self.point_at(self.board)
        return self.board

    def cleanup(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.bin_dir, ignore_errors=True)

    def declare_make_target(self, *tiers):
        """A Makefile under the native dir declaring `junit-<tier>` for each
        of `tiers` beside the `junit` target."""
        rules = "".join(f"junit-{tier}:\n\t@echo {tier}\n" for tier in tiers)
        Path(self.native_dir, "Makefile").write_text("junit:\n\t@echo junit\n" + rules)

    def env(self, **fake_env):
        env = scrubbed_env(self.bin_dir, **fake_env)
        for key in _SCRUBBED + _FAKE_KEYS:
            if key not in fake_env:
                env.pop(key, None)
        return env

    def argv(self, verb, agent, *extra):
        return [verb, *(("--agent", agent) if agent else ()),
                "--project-dir", self.project, *VERB_FLAGS[verb], *extra]

    def drive(self, verb, agent, *extra, **fake_env):
        cmd = [sys.executable, str(ARDUINO_CLIENT), *self.argv(verb, agent, *extra)]
        return subprocess.run(cmd, cwd=self.project, env=self.env(**fake_env),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def write_existing_reports(self, variant="pass"):
        """The reports a previous `make` left under `<native_dir>/reports`,
        for `auto-ingest` (which runs no `make`) to file."""
        for name, text in REPORTS[variant].items():
            path = Path(self.native_dir, "reports", name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    @staticmethod
    def diagnostics(result):
        return (f"exit={result.returncode} stdout={result.stdout!r} "
                f"stderr={result.stderr[-2500:]!r}")

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def envelope_of(self, result):
        envelope = _envelope(result.stdout)
        self.assertIsNotNone(  # type: ignore[attr-defined]
            envelope, f"stdout is not one TOON envelope; {self.diagnostics(result)}")
        return envelope or {}

    def the_one_runs_ingest(self, result):
        """The run's one `POST /api/v2/runs`, after asserting that nothing went
        to the parsed route and that its reports travel inline."""
        self.assertEqual(  # type: ignore[attr-defined]
            self.posts_to(PARSED), [],
            f"the arduino client never posts to {PARSED}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        ingests = self.posts_to(RUNS)
        self.assertEqual(  # type: ignore[attr-defined]
            len(ingests), 1,
            f"the run is filed as exactly one POST {RUNS}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        body = ingests[0] if ingests else {}
        self.assertNotIn("dataPath", body,  # type: ignore[attr-defined]
                         f"reports travel inline, never as a path; body={body!r}")
        self.assertEqual(body.get("stack"), "arduino",  # type: ignore[attr-defined]
                         f"body={body!r}")
        self.assertEqual(body.get("codec"), "junit",  # type: ignore[attr-defined]
                         f"body={body!r}")
        for key in ("summary", "tree"):
            self.assertNotIn(key, body,  # type: ignore[attr-defined]
                             f"the client sends no parse of its own; body={body!r}")
        return body

    def assert_health_read_before_the_ingest(self, result):
        events = [(m, p) for _t, m, p, _b in self.board.events]
        health = [i for i, (m, p) in enumerate(events)
                  if m == "GET" and p in (HEALTH, "/api/v2/health")]
        ingest = [i for i, (m, p) in enumerate(events) if m == "POST" and p == RUNS]
        self.assertTrue(  # type: ignore[attr-defined]
            health and ingest and health[0] < ingest[0],
            f"the board's health is read before the ingest is sent; "
            f"events={events!r} {self.diagnostics(result)}")

    def ingest_lines(self, result):
        return [line for line in result.stderr.splitlines()
                if line.startswith("ingest")]

    def own_result_lines(self, result):
        return [line for line in result.stderr.splitlines()
                if _OWN_LINE.search(line)]


# ── AC1 / AC8 — every report verb sends one /api/v2/runs, raw and runnerExit ─

class EveryArduinoReportVerbSendsOneRunsIngestTest(_ArduinoProject, unittest.TestCase):
    """The route, the codec, the inline report texts, `raw` and `runnerExit`,
    for every arduino verb that files a report."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_reports_inline_with_raw_and_exit(self, result, variant="pass",
                                                runner_exit=0):
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("data"), _sent(variant),
                         f"`data` is the text of every TEST-*.xml the run wrote, "
                         f"inline, byte for byte, sorted; body={body!r}")
        self.assertIsInstance(body.get("raw"), str, f"body={body!r}")
        self.assertIn(OUTPUT_MARKER, body.get("raw") or "",
                      f"`raw` is make's captured output; body={body!r}")
        self.assertEqual(body.get("runnerExit"), runner_exit,
                         f"`runnerExit` is make's exit; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        return body

    def test_test_sends_its_reports_texts_with_raw_and_the_runner_exit(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("test", "arduino-sends-test")
        body = self.assert_reports_inline_with_raw_and_exit(result)
        self.assertNotIn("tier", body, f"a `test` run claims no tier; body={body!r}")
        self.assertNotIn("coverage", body, f"`test` measures none; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_failing_make_sends_its_non_zero_exit_as_runner_exit(self):
        self.board.script_run(passed=1, failed=1, total=2, files=2)
        result = self.drive("test", "arduino-sends-test-exit-2",
                            FAKE_VARIANT="fail", FAKE_EXIT="2")
        self.assert_reports_inline_with_raw_and_exit(result, "fail", runner_exit=2)
        self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_unit_sends_its_reports_texts_under_its_tier(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("unit", "arduino-sends-unit")
        body = self.assert_reports_inline_with_raw_and_exit(result)
        self.assertEqual(body.get("tier"), "unit", f"body={body!r}")
        self.assertNotIn("coverage", body, f"`unit` measures none; body={body!r}")

    def test_regression_sends_its_reports_texts_as_a_regression(self):
        for extra in ((), COVERAGE_REGRESSION):
            with self.subTest(extra=extra):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                result = self.drive("regression", "arduino-sends-regression", *extra)
                body = self.assert_reports_inline_with_raw_and_exit(result)
                self.assertEqual(body.get("tier"), "regression", f"body={body!r}")
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_declared_make_target_sends_its_reports_texts_under_its_tier(self):
        self.declare_make_target("integration")
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("integration", "arduino-sends-integration")
        body = self.assert_reports_inline_with_raw_and_exit(result)
        self.assertEqual(body.get("tier"), "integration", f"body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_the_pre_merge_gate_whole_suite_sends_one_runs_ingest_as_a_regression(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("pre-merge-gate", "arduino-sends-gate")
        body = self.assert_reports_inline_with_raw_and_exit(result)
        self.assertEqual(body.get("tier"), "regression", f"body={body!r}")
        self.assertEqual(body.get("coverage"), LCOV_BLOCK,
                         f"the gate's whole suite measures coverage and sends "
                         f"its lcov; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_sends_the_reports_a_previous_run_left_with_no_raw(self):
        self.write_existing_reports()
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("auto-ingest", "arduino-sends-auto-ingest")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("data"), _sent("pass"),
                         f"`data` is every TEST-*.xml text, inline, sorted; "
                         f"body={body!r}")
        self.assertNotIn("raw", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("runnerExit", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("tier", body, f"auto-ingest claims no tier; body={body!r}")
        self.assertNotIn("coverage", body, f"auto-ingest measures none; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))


# ── AC2 — coverage travels as its report ────────────────────────────────────

class CoverageTravelsAsItsReportTest(_ArduinoProject, unittest.TestCase):
    """`regression --coverage` and `pre-merge-gate` (coverage on) send the
    lcov text as their coverage report, passing or failing."""

    COVERAGE_VERBS = (("regression", COVERAGE_REGRESSION), ("pre-merge-gate", ()))

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_a_passing_coverage_run_sends_the_lcov_text(self):
        for verb, extra in self.COVERAGE_VERBS:
            with self.subTest(verb=verb):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                result = self.drive(verb, f"arduino-coverage-green-{verb}", *extra)
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("coverage"), LCOV_BLOCK,
                                 f"the lcov the harness wrote is sent inline as "
                                 f"the run's coverage report; body={body!r}")
                self.assertNotIn("coverage-not-measured",
                                 _codes(self.envelope_of(result)),
                                 self.diagnostics(result))
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_failing_coverage_run_still_sends_the_lcov_text(self):
        # The board discards a red run's coverage; the client sends it anyway.
        for verb, extra in self.COVERAGE_VERBS:
            with self.subTest(verb=verb):
                self.fresh_board().script_run(passed=1, failed=1, total=2, files=2)
                result = self.drive(verb, f"arduino-coverage-red-{verb}", *extra,
                                    FAKE_VARIANT="fail", FAKE_EXIT="2")
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("data"), _sent("fail"), f"body={body!r}")
                self.assertEqual(body.get("coverage"), LCOV_BLOCK,
                                 f"coverage is sent whether or not the run "
                                 f"passed; body={body!r}")
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_coverage_run_with_no_lcov_sends_none_and_warns_coverage_not_measured(self):
        for verb, extra in self.COVERAGE_VERBS:
            with self.subTest(verb=verb):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                result = self.drive(verb, f"arduino-coverage-missing-{verb}", *extra,
                                    FAKE_NO_LCOV="1")
                body = self.the_one_runs_ingest(result)
                self.assertNotIn("coverage", body, f"body={body!r}")
                codes = _codes(self.envelope_of(result))
                self.assertEqual(codes.count("coverage-not-measured"), 1,
                                 f"the envelope says the coverage the run "
                                 f"measures was not measured, once; "
                                 f"{self.diagnostics(result)}")

    def test_a_run_with_coverage_off_sends_none_and_warns_nothing_missing(self):
        for verb in ("regression", "unit", "test"):
            with self.subTest(verb=verb):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                result = self.drive(verb, f"arduino-coverage-off-{verb}")
                body = self.the_one_runs_ingest(result)
                self.assertNotIn("coverage", body,
                                 f"a run without --coverage sends no coverage; "
                                 f"body={body!r}")
                self.assertNotIn("coverage-not-measured",
                                 _codes(self.envelope_of(result)),
                                 f"nothing was asked, so nothing is missing; "
                                 f"{self.diagnostics(result)}")
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_health_lacking_lcov_refuses_the_coverage_run(self):
        health = self.board.default_health()
        health["codecs"] = {"test": ["junit"], "coverage": ["jacoco"]}
        health["version"] = "0.3.9"
        for verb, extra in self.COVERAGE_VERBS:
            with self.subTest(verb=verb):
                self.fresh_board().script_health(health)
                result = self.drive(verb, f"arduino-board-without-lcov-{verb}", *extra)
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                self.assertEqual(len(self.board.aborts()), 1,
                                 f"the run the verb opened is aborted; "
                                 f"{self.diagnostics(result)}")
                envelope = self.envelope_of(result)
                said = json.dumps(envelope)
                for text in ("0.3.9", "0.4.0", "lcov"):
                    self.assertIn(text, said, f"envelope={envelope!r}")
                self.assertEqual(_figures(envelope), {}, f"envelope={envelope!r}")
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


# ── AC6 — the local decisions: ran nothing, the exit, the no-agent run ──────

class TheLocalDecisionsTest(_ArduinoProject, unittest.TestCase):

    VERBS = ("test", "unit", "regression")

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_fresh(self, verb, agent, scripted=None, **fake_env):
        """One drive on a board whose record holds only this drive."""
        board = self.fresh_board()
        if scripted is not None:
            board.script_run(**scripted)
        return self.drive(verb, agent, **fake_env)

    def test_a_make_exiting_non_zero_over_reports_with_no_testcase_ran_nothing(self):
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"arduino-ran-nothing-{verb}",
                                          FAKE_VARIANT="zero", FAKE_EXIT="2")
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [],
                                 f"a run that ran nothing files nothing; "
                                 f"{self.diagnostics(result)}")
                aborts = self.board.aborts()
                self.assertEqual(len(aborts), 1,
                                 f"aborts={aborts!r} {self.diagnostics(result)}")
                self.assertIn(FIRST_RUN, aborts[0][0] if aborts else "",
                              f"aborts={aborts!r}")
                self.assertEqual(_figures(self.envelope_of(result)), {},
                                 self.diagnostics(result))
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_run_with_a_failure_is_filed_and_exits_one(self):
        scripted = {"passed": 1, "failed": 1, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"arduino-failure-{verb}", scripted,
                                          FAKE_VARIANT="fail", FAKE_EXIT="2")
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("runnerExit"), 2, f"body={body!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))
                self.assertEqual(_figures(self.envelope_of(result)).get("failed"), 1,
                                 self.diagnostics(result))

    def test_a_failure_only_the_board_reports_makes_the_verb_exit_one(self):
        # `make` exits 0 over passing reports; the board's decoded run holds a
        # failure, and the verb's exit is `verb_exit` over its answer.
        scripted = {"passed": 1, "failed": 1, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"arduino-board-failure-{verb}",
                                          scripted)
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("runnerExit"), 0, f"body={body!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_a_run_the_board_reports_clean_exits_zero_over_a_failing_report(self):
        # The reports hold a failure; the board's answer is clean and `make`
        # exited 0, so nothing the verb's exit reads records a failure.
        scripted = {"passed": 2, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"arduino-board-clean-{verb}",
                                          scripted, FAKE_VARIANT="fail")
                self.the_one_runs_ingest(result)
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_exits_zero_on_an_ok_answer_with_no_failure(self):
        # The reports on disk hold a failure; the board's answer is the run.
        self.write_existing_reports("fail")
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("auto-ingest", "arduino-auto-ingest-ok")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_exits_one_on_an_ok_answer_whose_run_records_a_failure(self):
        # The reports on disk pass; the board's decoded run says otherwise.
        self.write_existing_reports()
        self.board.script_run(passed=1, failed=1, total=2, files=2)
        result = self.drive("auto-ingest", "arduino-auto-ingest-failure")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 1,
                         f"auto-ingest exits 0 only when its run records no "
                         f"failure; {self.diagnostics(result)}")

    def test_auto_ingest_exits_one_on_an_answer_that_is_not_ok(self):
        self.write_existing_reports()
        health = self.board.default_health()
        health.pop("codecs")
        self.board.script_health(health)
        result = self.drive("auto-ingest", "arduino-auto-ingest-refused")
        self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        self.assertEqual(result.returncode, 1, self.diagnostics(result))


class ARunWithoutAgentExitsWithItsRunnersExitTest(_ArduinoProject, unittest.TestCase):
    """No `--agent`: nothing is filed; the run prints how many testcases it
    ran and `make`'s exit, and exits with that exit."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_nothing_filed(self, result):
        posts = [p for p, _ in self.board.posts()
                 if p in (RUNS, PARSED, "/api/v2/runs/compile")]
        self.assertEqual(posts, [], f"a run without --agent files nothing; "
                                    f"{self.diagnostics(result)}")

    def the_run_line(self, result, expected):
        lines = [line for line in result.stderr.splitlines() if expected in line]
        self.assertEqual(len(lines), 1,
                         f"the run prints {expected!r} once; "
                         f"{self.diagnostics(result)}")
        self.assertEqual(self.own_result_lines(result), [],
                         f"arduino's own `<p>/<t> passed` line is gone; "
                         f"{self.diagnostics(result)}")

    def test_a_clean_make_over_a_failing_report_exits_zero(self):
        result = self.drive("test", None, FAKE_VARIANT="fail", FAKE_EXIT="0")
        self.the_run_line(result, "ran 2 testcases (2 not skipped); runner exit 0")
        self.assertEqual(result.returncode, 0,
                         f"the run files nothing and exits with make's exit; "
                         f"{self.diagnostics(result)}")
        self.assert_nothing_filed(result)

    def test_a_make_exiting_two_exits_two(self):
        result = self.drive("unit", None, FAKE_VARIANT="fail", FAKE_EXIT="2")
        self.the_run_line(result, "ran 2 testcases (2 not skipped); runner exit 2")
        self.assertEqual(result.returncode, 2, self.diagnostics(result))
        self.assert_nothing_filed(result)

    def test_the_line_counts_the_testcases_not_skipped(self):
        result = self.drive("test", None, FAKE_VARIANT="skip", FAKE_EXIT="0")
        self.the_run_line(result, "ran 2 testcases (1 not skipped); runner exit 0")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))
        self.assert_nothing_filed(result)


# ── AC7 — the envelope reads the answer ─────────────────────────────────────

class TheEnvelopeReadsTheAnswerTest(_ArduinoProject, unittest.TestCase):

    RUN_VERBS = (("test", ()), ("unit", ()), ("regression", ()),
                 ("regression", COVERAGE_REGRESSION), ("auto-ingest", ()),
                 ("pre-merge-gate", ()))

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_fresh(self, verb, agent, *extra, **scripted):
        self.fresh_board().script_run(**scripted)
        if verb == "auto-ingest":
            self.write_existing_reports()
        return self.drive(verb, agent, *extra)

    def test_the_envelope_run_block_is_the_answers_five_counts_files_included(self):
        # The reports hold two passing cases over two files; the board says
        # otherwise, and the envelope states what the board said.
        for verb, extra in self.RUN_VERBS:
            with self.subTest(verb=verb, extra=extra):
                result = self.drive_fresh(verb, f"arduino-envelope-counts-{verb}",
                                          *extra, passed=7, failed=2, pending=3,
                                          total=12, files=5)
                self.assertEqual(
                    _figures(self.envelope_of(result)),
                    {"passed": 7, "failed": 2, "pending": 3, "total": 12, "files": 5},
                    self.diagnostics(result))
                lines = self.ingest_lines(result)
                self.assertEqual(
                    [token for line in lines if line.startswith("ingest: ")
                     for token in line.split() if token.startswith("files=")],
                    ["files=5"],
                    "the one `ingest:` line carries the answer's files figure; "
                    + self.diagnostics(result))
                self.assertEqual(self.own_result_lines(result), [],
                                 "arduino's own result line is gone; "
                                 + self.diagnostics(result))

    def test_a_board_report_skipped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "report-skipped",
                   "detail": "report 1 skipped: not a JUnit report"}
        for verb, extra in self.RUN_VERBS:
            with self.subTest(verb=verb, extra=extra):
                result = self.drive_fresh(verb, f"arduino-envelope-skipped-{verb}",
                                          *extra, passed=2, total=2, files=2,
                                          warnings=[warning])
                self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                              self.diagnostics(result))

    def test_a_board_coverage_dropped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "coverage-dropped",
                   "detail": "lcov coverage dropped: no LF records"}
        result = self.drive_fresh("regression", "arduino-envelope-coverage-dropped",
                                  *COVERAGE_REGRESSION, passed=2, total=2, files=2,
                                  warnings=[warning])
        self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                      self.diagnostics(result))

    def test_an_answer_that_is_not_ok_carries_its_error_and_ingest_failed(self):
        for verb, extra in self.RUN_VERBS:
            with self.subTest(verb=verb, extra=extra):
                self.fresh_board().refuse_ingest_for(FIRST_RUN, status=409)
                if verb == "auto-ingest":
                    # auto-ingest opens no run, so its refused ingest carries
                    # no run id: the older board refuses it instead.
                    health = self.board.default_health()
                    health.pop("codecs")
                    self.board.script_health(health)
                    self.write_existing_reports()
                result = self.drive(verb, f"arduino-envelope-refused-{verb}", *extra)
                envelope = self.envelope_of(result)
                self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
                self.assertIsInstance(envelope.get("error"), str,
                                      f"the envelope carries the answer's error; "
                                      f"envelope={envelope!r}")
                self.assertEqual(_codes(envelope).count("ingest-failed"), 1,
                                 f"a run whose ingest was not ok says so once; "
                                 f"envelope={envelope!r}")
                self.assertEqual(_figures(envelope), {}, f"envelope={envelope!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_an_ok_answer_carries_no_ingest_failed(self):
        for verb, extra in self.RUN_VERBS:
            with self.subTest(verb=verb, extra=extra):
                result = self.drive_fresh(verb, f"arduino-envelope-ok-{verb}",
                                          *extra, passed=2, total=2, files=2)
                envelope = self.envelope_of(result)
                self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
                self.assertNotIn("ingest-failed", _codes(envelope),
                                 f"envelope={envelope!r}")


# ── AC7 — an older board, a body too large ──────────────────────────────────

class ABoardThatCannotTakeTheRunIsRefusedBeforeSendingTest(_ArduinoProject,
                                                           unittest.TestCase):

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
        for verb in ("test", "unit", "regression"):
            with self.subTest(verb=verb):
                self.fresh_board().script_health(health)
                result = self.drive(verb, f"arduino-older-board-{verb}")
                self.assert_refused_before_sending(result, "0.3.7", "0.4.0")

    def test_health_that_cannot_be_read_is_refused_before_sending(self):
        self.board.fail_health(status=503, error="health unavailable")
        result = self.drive("unit", "arduino-health-unreadable")
        self.assert_refused_before_sending(result)

    def test_health_with_codecs_but_no_limits_still_sends(self):
        health = self.board.default_health()
        health.pop("limits")
        self.board.script_health(health)
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("test", "arduino-board-without-limits")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_body_over_the_advertised_limit_is_refused_naming_ingest_body_bytes(self):
        for verb in ("test", "regression"):
            with self.subTest(verb=verb):
                self.fresh_board(RecordingBoard(ingest_body_bytes=64))
                result = self.drive(verb, f"arduino-body-too-large-{verb}")
                self.assert_refused_before_sending(result, "ingest_body_bytes", "64")

    def test_a_413_from_the_board_is_reported_naming_ingest_body_bytes(self):
        for verb in ("test", "unit"):
            with self.subTest(verb=verb):
                self.fresh_board().refuse_ingest_for(FIRST_RUN, status=413)
                result = self.drive(verb, f"arduino-board-413-{verb}")
                self.assertEqual(len(self.posts_to(RUNS)), 1, self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                envelope = self.envelope_of(result)
                self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
                self.assertIn("ingest_body_bytes", str(envelope.get("error")),
                              f"envelope={envelope!r}")
                self.assertEqual(_figures(envelope), {}, f"envelope={envelope!r}")
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


# ── AC7 — no board, no figures ──────────────────────────────────────────────

_UNREACHABLE = {"ok": False, "error": "connection failed: [Errno 111] Connection "
                                      "refused (is Crucible running?)"}


class NoBoardNoFiguresTest(_ArduinoProject, unittest.TestCase):
    """The client's own `main()`, in-process, with ONE route answered as the
    fleet transport answers a board it cannot reach; every other route
    reaches the recording board."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_in_process(self, argv, unreachable):
        module = load_client("arduino-crucible.py")
        real_request = module._request

        def request(method, path, payload=None, timeout=None):
            if (method, path) in unreachable:
                return dict(_UNREACHABLE)
            return real_request(method, path, payload, timeout)

        # Real files, not StringIO: the runner's stream is handed a file
        # descriptor.
        with tempfile.TemporaryFile("w+") as out, \
                tempfile.TemporaryFile("w+") as err:
            with mock.patch.object(module, "_request", request), \
                    mock.patch.dict(os.environ, self.env(), clear=True), \
                    mock.patch.object(sys, "argv", ["arduino-crucible.py", *argv]), \
                    contextlib.chdir(self.project), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = module.main()
                except SystemExit as exit_:
                    code = exit_.code
            out.seek(0)
            err.seek(0)
            return code, out.read(), err.read()

    def assert_no_figures_and_not_filed(self, code, stdout, stderr):
        where = f"exit={code} stdout={stdout!r} stderr={stderr[-2500:]!r}"
        self.assertEqual(_envelope_count(stdout), 1,
                         f"the run prints one envelope; {where}")
        envelope = _envelope(stdout)
        self.assertIsNotNone(envelope, where)
        envelope = envelope or {}
        self.assertIs(envelope.get("ok"), False, where)
        self.assertEqual(_figures(envelope), {},
                         f"with no board there are no figures; {where}")
        self.assertIsInstance(envelope.get("error"), str,
                              f"the envelope says why the run was not filed; {where}")
        self.assertNotIn("Traceback", stderr, f"no traceback; {where}")
        self.assertEqual(code, 1, where)
        return envelope

    def test_an_ingest_that_cannot_reach_the_board_carries_no_figures(self):
        for verb in ("unit", "regression"):
            with self.subTest(verb=verb):
                code, stdout, stderr = self.drive_in_process(
                    self.argv(verb, f"arduino-ingest-unreachable-{verb}"),
                    {("POST", RUNS), ("POST", PARSED)})
                envelope = self.assert_no_figures_and_not_filed(code, stdout, stderr)
                self.assertIn("connection failed", envelope.get("error") or "", stdout)
                self.assertIn("ingest-failed", _codes(envelope), stdout)

    def test_a_health_read_that_cannot_reach_the_board_sends_nothing(self):
        for verb in ("unit", "regression"):
            with self.subTest(verb=verb):
                self.fresh_board()
                code, stdout, stderr = self.drive_in_process(
                    self.argv(verb, f"arduino-health-unreachable-{verb}"),
                    {("GET", HEALTH)})
                self.assert_no_figures_and_not_filed(code, stdout, stderr)
                self.assertEqual(self.posts_to(RUNS), [], stdout)
                self.assertEqual(self.posts_to(PARSED), [], stdout)
                self.assertIn("run-aborted", _codes(_envelope(stdout)), stdout)

    def assert_gate_unreported(self, code, stdout, stderr):
        where = f"exit={code} stdout={stdout!r} stderr={stderr[-2500:]!r}"
        envelope = _envelope(stdout) or {}
        self.assertIs(envelope.get("ok"), False, where)
        self.assertIn("gate-suite-unreported", _codes(envelope),
                      f"the gate names the suite it could not file as "
                      f"unreported; {where}")
        self.assertNotIn("gate-suite-failed", _codes(envelope), where)
        self.assertNotIn("Traceback", stderr, f"no traceback; {where}")
        self.assertNotEqual(code, 0, where)
        return envelope

    def test_pre_merge_gate_reports_its_unfiled_whole_suite_unreported_and_is_not_green(self):
        # No declared target: the gate's envelope is its whole-suite run's.
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "arduino-gate-unreachable"),
            {("POST", RUNS), ("POST", PARSED)})
        envelope = self.assert_gate_unreported(code, stdout, stderr)
        self.assertEqual(_figures(envelope), {},
                         f"the gate states no figures for a suite it could not "
                         f"file; stdout={stdout!r}")

    def test_pre_merge_gate_whose_health_read_finds_no_board_reports_it_unreported(self):
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "arduino-gate-health-unreachable"),
            {("GET", HEALTH)})
        envelope = self.assert_gate_unreported(code, stdout, stderr)
        self.assertEqual(_figures(envelope), {}, f"stdout={stdout!r}")

    def test_pre_merge_gate_composing_a_declared_target_reports_it_unreported(self):
        # A declared `junit-unit` target: the gate composes, and its whole
        # suite, which covers it, is a suite whose outcome it must report.
        self.declare_make_target("unit")
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "arduino-gate-composed-unreachable"),
            {("POST", RUNS), ("POST", PARSED)})
        self.assert_gate_unreported(code, stdout, stderr)


# ── AC8 / AC9 — one emitter, no parser, one ingest line, the budget ─────────

# Each shared module's line budget is that module's size (its newline count,
# as the test below counts it), the same pin maven's and rust's send-reports
# tests hold, so neither shared module grows unnoticed. A change that grows a
# shared module re-records its budget here, in the same change.
SHARED_MODULE_LINE_BUDGETS = {"_crucible_axi.py": 9088, "_crucible_run.py": 1123}

# Names the arduino client's move to the shared ingest retires: its own
# parsers and its own figures' emitter from the client, and the client-figure
# fallback from the run module.
RETIRED_EVERYWHERE = ("_emit_ingest_summary_axi", "filed_summary")
RETIRED_FROM_ARDUINO = ("_parse_junit", "_collect_lcov", "_file_stem")

# The two halves of arduino's old result line, which `ingest_reports`' one
# `ingest:` line replaces.
_OLD_LINE_PARTS = (" passed, ", "files (ingest ok=")


def defined_names(source):
    """Every name `source` defines at any depth: a function or class, or an
    assignment target."""
    found = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.add(node.name)
        elif isinstance(node, ast.Assign):
            found |= {t.id for t in node.targets if isinstance(t, ast.Name)}
    return found


def old_result_line_literals(source):
    """Every string literal of `source` that carries arduino's old result
    line: a plain string, or an f-string whose literal parts, joined, hold
    both halves of it."""
    tree = ast.parse(source)
    in_joined = {id(part) for node in ast.walk(tree)
                 if isinstance(node, ast.JoinedStr) for part in node.values}
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            text = "".join(part.value for part in node.values
                           if isinstance(part, ast.Constant)
                           and isinstance(part.value, str))
        elif (isinstance(node, ast.Constant) and isinstance(node.value, str)
              and id(node) not in in_joined):
            text = node.value
        else:
            continue
        if all(part in text for part in _OLD_LINE_PARTS):
            found.append(text)
    return sorted(found)


class TheLiteralScanIsProvedOnSyntheticSourcesTest(unittest.TestCase):

    def test_the_old_result_line_is_found_plain_or_formatted(self):
        source = textwrap.dedent('''
            import sys
            def _a(verb, key, s, files, resp):
                print(f"[crucible] {verb} -> '{key}': {s['passed']}/{s['total']} passed, "
                      f"{s['failed']} failed, {files} files (ingest ok={resp.get('ok')})",
                      file=sys.stderr)
            def _b():
                return "1/1 passed, 0 failed, 1 files (ingest ok=True)"
            def _c(n, m, rc):
                print(f"[crucible] ran {n} testcases ({m} not skipped); runner exit {rc}",
                      file=sys.stderr)
                print(f"ingest: ok=True passed={n} files={m}", file=sys.stderr)
        ''')
        self.assertEqual(
            old_result_line_literals(source),
            ["1/1 passed, 0 failed, 1 files (ingest ok=True)",
             "[crucible]  -> '': / passed,  failed,  files (ingest ok=)"])

    def test_the_definition_scan_reads_functions_classes_and_assignments(self):
        source = textwrap.dedent('''
            filed_summary = None
            class _emit_ingest_summary_axi:
                pass
            def outer():
                def _parse_junit(path):
                    return path
                return _parse_junit
            def junit_case_sources(paths):
                return [p for p in paths]
        ''')
        self.assertEqual(defined_names(source),
                         {"filed_summary", "_emit_ingest_summary_axi", "outer",
                          "_parse_junit", "junit_case_sources"})


class TheArduinoClientDefinesNoParserAndNoEmitterOfItsOwnTest(unittest.TestCase):

    def test_no_client_module_defines_the_retired_emitter_or_summary(self):
        found = {path.name: sorted(defined_names(path.read_text(encoding="utf-8"))
                                   & set(RETIRED_EVERYWHERE))
                 for path in sorted(CLIENTS.glob("*.py"))}
        found = {name: names for name, names in found.items() if names}
        self.assertEqual(
            found, {},
            "`_emit_ingest_summary_axi` and `filed_summary` are defined nowhere: "
            "every figure a run envelope states is the board's")

    def test_the_arduino_client_defines_none_of_its_parsers(self):
        defined = defined_names(ARDUINO_CLIENT.read_text(encoding="utf-8"))
        self.assertEqual(sorted(defined & set(RETIRED_FROM_ARDUINO)), [],
                         "the arduino client parses none of its reports")

    def test_the_arduino_client_imports_no_xml_parser(self):
        tree = ast.parse(ARDUINO_CLIENT.read_text(encoding="utf-8"))
        imported = sorted(
            {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import)
             for alias in node.names}
            | {node.module or "" for node in ast.walk(tree)
               if isinstance(node, ast.ImportFrom)})
        self.assertEqual([name for name in imported if name.startswith("xml")], [],
                         f"the arduino client imports no XML parser; "
                         f"imports={imported!r}")

    def test_the_arduino_client_holds_no_literal_of_its_old_result_line(self):
        found = old_result_line_literals(ARDUINO_CLIENT.read_text(encoding="utf-8"))
        self.assertEqual(found, [],
                         f"the shared `ingest:` line is the run's one ingest "
                         f"line; arduino-crucible.py still prints {found!r}")

    def test_the_shared_modules_are_no_longer_than_their_line_budget(self):
        for name, budget in SHARED_MODULE_LINE_BUDGETS.items():
            with self.subTest(module=name):
                path = CLIENTS / name
                self.assertTrue(path.is_file(), f"the shared module {name} exists")
                lines = path.read_text(encoding="utf-8").count("\n")
                self.assertLessEqual(
                    lines, budget,
                    f"clients/{name} is {lines} lines, over its budget of "
                    f"{budget}")


class TheFilingRunPrintsOneIngestLineTest(_ArduinoProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_a_filed_run_prints_the_shared_ingest_line_and_no_line_of_its_own(self):
        for verb in ("test", "unit", "auto-ingest"):
            with self.subTest(verb=verb):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                if verb == "auto-ingest":
                    self.write_existing_reports()
                result = self.drive(verb, f"arduino-one-ingest-line-{verb}")
                lines = [line for line in result.stderr.splitlines()
                         if line.startswith("ingest: ")]
                self.assertEqual(len(lines), 1,
                                 f"the run has one `ingest:` line; "
                                 f"{self.diagnostics(result)}")
                self.assertIn("codec=junit", lines[0] if lines else "",
                              self.diagnostics(result))
                self.assertEqual(self.own_result_lines(result), [],
                                 self.diagnostics(result))
                self.assertNotIn("(ingest ok=", result.stderr,
                                 self.diagnostics(result))


if __name__ == "__main__":
    unittest.main()
