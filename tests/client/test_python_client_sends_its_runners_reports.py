"""The python client sends its runner's reports and parses nothing.

Every python verb that files a report (`test` under unittest and under
pytest, the declared tier verbs `unit`, `module`, `integration`, `e2e` and
`bdd`, `regression`, `auto-ingest`, and the regression step
`pre-merge-gate` runs) files it through the shared ingest (`ingest_reports`,
clients/_crucible_axi.py): the board's health is read first, then ONE
`POST /api/v2/runs` goes out carrying `codec: "junit"`, `data` (every
`TEST-*.xml` report's text, inline, in path order), `coverage: {codec:
"lcov", data}` when the run measured coverage (`coverage lcov`'s report),
`raw` (the captured runner output, on every verb but `auto-ingest`) and
`runnerExit`. Nothing goes to `/api/v2/runs/parsed`, and no body carries a
`dataPath`, a `summary` or a `tree`.

Every figure the envelope reports is the board's: its `run:` block is the
response's `run` block, the stderr coverage line reads the response's
coverage, and the response's `warnings[]` join the envelope's. With no board
there are no figures. A board that cannot decode the run (no `codecs`, or no
`lcov` for a coverage run), or whose advertised `ingest_body_bytes` the body
exceeds, is refused before anything is sent, and the run the verb opened is
aborted.

The client still decides "ran nothing" locally (`ran_nothing` over the
runner's exit and the report's `<testcase>` count), and its exit is
`verb_exit` over the runner's exit and the board's answer. The no-report
exits are unchanged: no JUnit at all, or a pytest that failed as a runner,
files the compile ingest; a discovery that found no test is
`no-tests-discovered`; none touches `/api/v2/runs`.

A pytest run is invoked with its JUnit suite name pinned to `pytest`
(`-o junit_suite_name=pytest`), so the board's grouping rule -- a suite named
`pytest` grouped by each case's `classname` -- holds whatever the project's
own pytest configuration names it.

Every drive runs the real `clients/python-crucible.py` with a fake
interpreter that writes the exact report texts below where the client tells
it to. Most drive it as a subprocess against a `RecordingBoard` whose
`/api/v2/runs` answer the test scripts; the ones that need a board that
cannot be reached at one route drive `main()` in-process with that one route
answered as the transport answers an unreachable board.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_python_client_sends_its_runners_reports
"""

import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
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
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
TIMEOUT = 120
PROJECT_KEY = "python-sends-its-reports-key"

RUNS = "/api/v2/runs"
PARSED = "/api/v2/runs/parsed"
COMPILE = "/api/v2/runs/compile"
HEALTH = "/api/health"
FIRST_RUN = "run-live-1"

# The report texts the fake interpreter writes, byte for byte: what the
# ingest's `data` and `coverage.data` must carry.
JUNIT_TEXT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuite name="fake_module.FakeCase" tests="1" errors="0" failures="0" '
    'skipped="0"><testcase classname="fake_module.FakeCase" '
    'name="test_adds_two_numbers" time="0.001" file="tests/test_fake.py">'
    '</testcase></testsuite>\n')
EMPTY_JUNIT_TEXT = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<testsuite name="fake_module.FakeCase" tests="0" errors="0" failures="0" '
    'skipped="0"></testsuite>\n')
PYTEST_JUNIT_TEXT = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" '
    'tests="1"><testcase classname="check_outcomes" name="test_it_passes" '
    'file="check_outcomes.py" time="0.001" /></testsuite></testsuites>\n')
# Ten lines and two functions, all covered: summed by a client, 100%.
LCOV_TEXT = ("TN:\nSF:app/math.py\nFN:1,add\nFN:5,sub\nFNDA:1,add\nFNDA:1,sub\n"
             "FNF:2\nFNH:2\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,1\nDA:6,1\n"
             "DA:7,1\nDA:8,1\nDA:9,1\nDA:10,1\nLF:10\nLH:10\nend_of_record\n")
# The line the fake prints on stdout: the captured output `raw` carries.
OUTPUT_MARKER = "fake-python-output-line-3e9a"

# The coverage the scripted board says it kept: not what the lcov above sums
# to, so a stderr line that reads the client's own sum is caught.
BOARD_COVERAGE = {"lines": {"total": 200, "covered": 123, "percent": 61.5},
                  "functions": {"total": 40, "covered": 17, "percent": 42.5}}

TIER_VERBS = ("unit", "module", "integration", "e2e", "bdd")

_SCRUBBED = ("PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR",
             "PYTHON_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "PYTEST_ADDOPTS", "COVERAGE_RCFILE",
             "COVERAGE_PROCESS_START")
_FAKE_KEYS = ("FAKE_EXIT", "FAKE_REPORT", "FAKE_ZERO", "FAKE_NO_LCOV",
              "FAKE_ZERO_DISCOVERY")

# A fake interpreter. It appends its argv to `argv.jsonl` beside it.
#   * `-c <probe>` (pytest's import probe, coverage.py's config and erase
#     probes) answers `true` and exits 0;
#   * `-m coverage lcov ... -o <file>` writes LCOV_TEXT there (exits 1 under
#     FAKE_NO_LCOV=1, writing nothing);
#   * a suite run -- the subtest runner (`... -o <dir> -v`) or `-m pytest
#     ... --junitxml=<file>`, bare or under `-m coverage run` -- prints
#     OUTPUT_MARKER, writes JUNIT_TEXT (PYTEST_JUNIT_TEXT under pytest,
#     EMPTY_JUNIT_TEXT under FAKE_ZERO=1, nothing under FAKE_REPORT=none, a
#     directory where the report should be under FAKE_REPORT=dir) and
#     exits FAKE_EXIT. FAKE_ZERO_DISCOVERY=1 prints unittest's "Ran 0 tests"
#     and writes nothing.
_FAKE_PYTHON = r'''
import json
import os
import sys

JUNIT, EMPTY, PYTEST_JUNIT, LCOV, MARKER = ''' + repr((
    JUNIT_TEXT, EMPTY_JUNIT_TEXT, PYTEST_JUNIT_TEXT, LCOV_TEXT, OUTPUT_MARKER)) + r'''

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

argv = sys.argv[1:]
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "argv.jsonl"),
          "a") as handle:
    handle.write(json.dumps(argv) + "\n")
if argv[:1] == ["-c"]:
    sys.stdout.write("true\n")
    sys.exit(0)
if argv[:3] == ["-m", "coverage", "lcov"]:
    if os.environ.get("FAKE_NO_LCOV") == "1":
        sys.stderr.write("No data to report.\n")
        sys.exit(1)
    write(argv[argv.index("-o") + 1], LCOV)
    sys.exit(0)
pytest = "pytest" in argv
target = None
for i, arg in enumerate(argv):
    if pytest and arg.startswith("--junitxml="):
        target = arg.split("=", 1)[1]
    if not pytest and arg == "-o" and i + 1 < len(argv):
        target = os.path.join(argv[i + 1], "TEST-fake_module.FakeCase.xml")
sys.stdout.write(MARKER + "\n")
sys.stdout.flush()
if os.environ.get("FAKE_ZERO_DISCOVERY") == "1":
    sys.stderr.write("\n" + "-" * 70 + "\nRan 0 tests in 0.000s\n\nNO TESTS RAN\n")
    sys.exit(5)
sys.stderr.write("test_adds_two_numbers (fake_module.FakeCase.test_adds_two_numbers)"
                 " ... ok\n")
if target and os.environ.get("FAKE_REPORT") == "dir":
    os.makedirs(target, exist_ok=True)
elif target and os.environ.get("FAKE_REPORT") != "none":
    if os.environ.get("FAKE_ZERO") == "1":
        write(target, EMPTY)
    else:
        write(target, PYTEST_JUNIT if pytest else JUNIT)
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


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


class _PythonProject:
    """A scratch project with the fake interpreter, filing to a RecordingBoard."""

    def make(self, board=None):
        self.project = new_scratch("python-sends-its-reports-")
        self.board = board or RecordingBoard()
        Path(self.project, "tests").mkdir()
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n")
        self.fake_python = os.path.join(self.project, "fake_python.py")
        Path(self.fake_python).write_text("#!" + sys.executable + "\n" + _FAKE_PYTHON)
        os.chmod(self.fake_python,
                 os.stat(self.fake_python).st_mode | stat.S_IXUSR | stat.S_IRUSR)

    def cleanup(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)

    def env(self, **fake_env):
        env = scrubbed_env(None, **fake_env)
        for key in _SCRUBBED + _FAKE_KEYS:
            if key not in fake_env:
                env.pop(key, None)
        return env

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--project-dir", self.project,
                "--reports", "reports",
                *(() if verb == "auto-ingest" else ("--python", self.fake_python)),
                *extra]

    def drive(self, verb, agent, *extra, **fake_env):
        cmd = [sys.executable, str(PYTHON_CLIENT), *self.argv(verb, agent, *extra)]
        return subprocess.run(cmd, cwd=self.project, env=self.env(**fake_env),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def interpreter_runs(self):
        path = Path(self.project, "argv.jsonl")
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line]

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
        to the parsed route."""
        self.assertEqual(  # type: ignore[attr-defined]
            self.posts_to(PARSED), [],
            f"the python client never posts to {PARSED}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        ingests = self.posts_to(RUNS)
        self.assertEqual(  # type: ignore[attr-defined]
            len(ingests), 1,
            f"the run is filed as exactly one POST {RUNS}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        body = ingests[0] if ingests else {}
        self.assertNotIn("dataPath", body,  # type: ignore[attr-defined]
                         f"reports travel inline, never as a path; body={body!r}")
        self.assertEqual(body.get("stack"), "python",  # type: ignore[attr-defined]
                         f"body={body!r}")
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


# ── AC1 / AC10 — every report verb sends one /api/v2/runs, raw and exit ─────

class EveryPythonReportVerbSendsOneRunsIngestTest(_PythonProject, unittest.TestCase):
    """The route, the codec, the inline report text, `raw` and `runnerExit`
    for every python verb that files a report."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_junit_ingest_with_raw_and_exit(self, result, runner_exit=0,
                                              report=JUNIT_TEXT):
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("codec"), "junit", f"body={body!r}")
        self.assertEqual(body.get("data"), [report],
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
        result = self.drive("test", "py-sends-test")
        body = self.assert_junit_ingest_with_raw_and_exit(result)
        self.assertNotIn("tier", body, f"a `test` run claims no tier; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_failing_runner_sends_its_non_zero_exit_as_runner_exit(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-sends-test-exit-3", FAKE_EXIT="3")
        self.assert_junit_ingest_with_raw_and_exit(result, runner_exit=3)
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_test_under_pytest_sends_pytests_junit_text_inline(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-sends-pytest", "--runner", "pytest")
        self.assert_junit_ingest_with_raw_and_exit(result, report=PYTEST_JUNIT_TEXT)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_regression_sends_its_junit_text_inline_with_raw_and_the_runner_exit(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "py-sends-regression")
        body = self.assert_junit_ingest_with_raw_and_exit(result)
        self.assertEqual(body.get("tier"), "regression", f"body={body!r}")
        self.assertNotIn("coverage", body,
                         f"a run without --coverage sends no coverage; body={body!r}")
        self.assertNotIn("coverage-not-measured", _codes(self.envelope_of(result)),
                         f"nothing was asked, so nothing is missing; "
                         f"{self.diagnostics(result)}")

    def test_each_declared_tier_verb_sends_one_runs_ingest_under_its_tier(self):
        self.board.script_run(passed=1, total=1, files=1)
        for tier in TIER_VERBS:
            with self.subTest(verb=tier):
                before = len(self.board.events)
                result = self.drive(tier, f"py-sends-{tier}", "--start-dir", "tests")
                del self.board.events[:before]
                body = self.assert_junit_ingest_with_raw_and_exit(result)
                self.assertEqual(body.get("tier"), tier, f"body={body!r}")

    def test_auto_ingest_sends_the_junit_text_with_no_raw_and_no_runner_exit(self):
        reports = Path(self.project, "reports")
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "TEST-b.xml").write_text(EMPTY_JUNIT_TEXT)
        (reports / "TEST-a.xml").write_text(JUNIT_TEXT)
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("auto-ingest", "py-sends-auto-ingest")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("codec"), "junit", f"body={body!r}")
        self.assertEqual(body.get("data"), [JUNIT_TEXT, EMPTY_JUNIT_TEXT],
                         f"every TEST-*.xml report's text, in sorted path order; "
                         f"body={body!r}")
        self.assertNotIn("raw", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("runnerExit", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_the_pre_merge_gate_regression_step_sends_one_runs_ingest_with_lcov(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("pre-merge-gate", "py-sends-gate", "--skip-check")
        body = self.assert_junit_ingest_with_raw_and_exit(result)
        self.assertEqual(body.get("coverage"), {"codec": "lcov", "data": [LCOV_TEXT]},
                         f"the gate measures coverage and sends its lcov report; "
                         f"body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))


# ── AC11 — pytest's suite name ─────────────────────────────────────────────

class APytestRunPinsItsSuiteNameTest(_PythonProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def pytest_runs(self):
        return [argv for argv in self.interpreter_runs() if "pytest" in argv
                and argv[:1] != ["-c"]]

    def test_a_pytest_test_run_is_invoked_with_its_junit_suite_name_pinned_to_pytest(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-suite-name", "--runner", "pytest")
        runs = self.pytest_runs()
        self.assertEqual(len(runs), 1, f"runs={runs!r} {self.diagnostics(result)}")
        junitxml = os.path.join(self.project, "reports", "TEST-pytest.xml")
        self.assertEqual(
            runs[0] if runs else None,
            ["-m", "pytest", "-v", "-o", "junit_family=xunit1",
             "-o", "junit_suite_name=pytest", f"--junitxml={junitxml}"],
            f"pytest is invoked with its JUnit suite name pinned to `pytest`; "
            f"{self.diagnostics(result)}")

    def test_a_pytest_coverage_regression_pins_the_suite_name_too(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "py-suite-name-cov", "--runner", "pytest",
                            "--coverage")
        runs = [argv for argv in self.pytest_runs() if argv[:3] == ["-m", "coverage", "run"]]
        self.assertEqual(len(runs), 1, f"runs={self.pytest_runs()!r} "
                                       f"{self.diagnostics(result)}")
        argv = runs[0] if runs else []
        pairs = list(zip(argv[:-1], argv[1:], strict=True))
        self.assertIn(("-o", "junit_suite_name=pytest"), pairs,
                      f"argv={argv!r} {self.diagnostics(result)}")
        self.assertEqual(pairs.count(("-o", "junit_suite_name=pytest")), 1,
                         f"argv={argv!r}")


# ── AC2 — coverage travels as its report ────────────────────────────────────

class CoverageTravelsAsItsReportTest(_PythonProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_regression_coverage_sends_the_lcov_text_as_the_coverage_block(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("regression", "py-coverage-sent", "--coverage")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("coverage"), {"codec": "lcov", "data": [LCOV_TEXT]},
                         f"body={body!r}")
        self.assertNotIn("coverage-not-measured", _codes(self.envelope_of(result)),
                         self.diagnostics(result))

    def test_the_stderr_coverage_line_reads_the_responses_coverage(self):
        self.board.script_run(passed=1, total=1, files=1, coverage=BOARD_COVERAGE)
        result = self.drive("regression", "py-coverage-line", "--coverage")
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
        result = self.drive("regression", "py-coverage-missing", "--coverage",
                            FAKE_NO_LCOV="1")
        body = self.the_one_runs_ingest(result)
        self.assertNotIn("coverage", body, f"body={body!r}")
        codes = _codes(self.envelope_of(result))
        self.assertEqual(codes.count("coverage-not-measured"), 1,
                         f"the envelope says the asked-for coverage was not "
                         f"measured, once; {self.diagnostics(result)}")


# ── AC5 — the local decisions: ran nothing, the exit ────────────────────────

class TheLocalDecisionsTest(_PythonProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_a_runner_exiting_non_zero_over_a_report_with_no_testcase_ran_nothing(self):
        for verb in ("test", "regression"):
            with self.subTest(verb=verb):
                before = len(self.board.events)
                result = self.drive(verb, f"py-ran-nothing-{verb}", FAKE_ZERO="1",
                                    FAKE_EXIT="1")
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                aborts = [(p, b) for _t, m, p, b in self.board.events[before:]
                          if m == "POST" and p.endswith("/abort")]
                self.assertEqual(len(aborts), 1,
                                 f"aborts={aborts!r} {self.diagnostics(result)}")
                self.assertIn("run-aborted", _codes(self.envelope_of(result)),
                              self.diagnostics(result))
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))
                del self.board.events[:]

    def test_a_runner_exiting_zero_over_a_report_with_no_testcase_is_filed(self):
        # `ran_nothing` needs a non-zero exit: a clean runner's empty report
        # is sent as it stands, and the board's answer decides the exit.
        result = self.drive("test", "py-zero-clean", FAKE_ZERO="1")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("data"), [EMPTY_JUNIT_TEXT], f"body={body!r}")

    def test_a_failure_the_board_reports_makes_the_verb_exit_non_zero(self):
        # The runner exits 0 over a passing report; the board's decoded run
        # holds a failure (a case the client cannot see), and the verb's exit
        # is `verb_exit` over the board's answer.
        self.board.script_run(passed=1, failed=1, total=2, files=1)
        for verb in ("test", "regression"):
            with self.subTest(verb=verb):
                result = self.drive(verb, f"py-board-failure-{verb}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))
                self.assertEqual(_figures(self.envelope_of(result)).get("failed"), 1,
                                 self.diagnostics(result))

    def test_a_run_the_board_reports_clean_exits_zero(self):
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("regression", "py-board-clean")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))


# ── AC6 — the envelope reads the response ──────────────────────────────────

class TheEnvelopeReadsTheResponseTest(_PythonProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_the_envelope_run_block_is_the_responses_five_counts(self):
        # The report holds one passing case in one file; the board says
        # otherwise, and the envelope states what the board said.
        self.board.script_run(passed=7, failed=2, pending=3, total=12, files=5)
        for verb, extra in (("test", ()), ("regression", ()),
                            ("test", ("--runner", "pytest"))):
            with self.subTest(verb=verb, extra=extra):
                result = self.drive(verb, f"py-envelope-counts-{verb}", *extra)
                self.assertEqual(
                    _figures(self.envelope_of(result)),
                    {"passed": 7, "failed": 2, "pending": 3, "total": 12, "files": 5},
                    self.diagnostics(result))

    def test_a_board_report_skipped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "report-skipped",
                   "detail": "report 1 skipped: not a JUnit report"}
        self.board.script_run(passed=1, total=1, files=1, warnings=[warning])
        result = self.drive("regression", "py-envelope-report-skipped")
        self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                      self.diagnostics(result))

    def test_a_board_coverage_dropped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "coverage-dropped",
                   "detail": "lcov coverage dropped: no SF record"}
        self.board.script_run(passed=1, total=1, files=1, warnings=[warning])
        result = self.drive("regression", "py-envelope-coverage-dropped", "--coverage")
        self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                      self.diagnostics(result))


# ── AC8 / AC9 — an older board, a body too large ───────────────────────────

class ABoardThatCannotTakeTheRunIsRefusedBeforeSendingTest(_PythonProject,
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
        self.board.script_health(health)
        result = self.drive("test", "py-older-board")
        self.assert_refused_before_sending(result, "0.3.7", "0.4.0")

    def test_codecs_lacking_lcov_refuse_a_coverage_run(self):
        health = self.board.default_health()
        health["codecs"] = {"test": ["junit"], "coverage": ["jacoco"]}
        health["version"] = "0.3.9"
        self.board.script_health(health)
        result = self.drive("regression", "py-board-without-lcov", "--coverage")
        self.assert_refused_before_sending(result, "0.3.9", "0.4.0", "lcov")

    def test_health_that_cannot_be_read_is_refused_before_sending(self):
        self.board.fail_health(status=503, error="health unavailable")
        result = self.drive("regression", "py-health-unreadable")
        self.assert_refused_before_sending(result)

    def test_health_with_codecs_but_no_limits_still_sends(self):
        health = self.board.default_health()
        health.pop("limits")
        self.board.script_health(health)
        self.board.script_run(passed=1, total=1, files=1)
        result = self.drive("test", "py-board-without-limits")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_body_over_the_advertised_limit_is_refused_naming_ingest_body_bytes(self):
        self.board.close()
        self.make(board=RecordingBoard(ingest_body_bytes=64))
        result = self.drive("test", "py-body-too-large")
        self.assert_refused_before_sending(result, "ingest_body_bytes", "64")

    def test_a_report_the_client_cannot_read_is_refused_before_sending_and_the_run_aborted(self):
        # The runner exits 0 and leaves a directory where its JUnit report
        # should be: the report exists but cannot be read, a refusal before
        # sending that settles the open run as every other one does.
        result = self.drive("test", "py-report-is-a-directory", FAKE_REPORT="dir")
        for stream, text in (("stdout", result.stdout), ("stderr", result.stderr)):
            self.assertNotIn("Traceback (most recent call last)", text,
                             f"the verb settles the refusal, it does not crash "
                             f"({stream}); {self.diagnostics(result)}")
        self.assert_refused_before_sending(result, "TEST-fake_module.FakeCase.xml",
                                           "nothing was sent")
        error = self.envelope_of(result).get("error")
        self.assertIsInstance(error, str, self.diagnostics(result))
        self.assertIn("TEST-fake_module.FakeCase.xml", error or "",
                      f"the envelope's error names the unreadable report; "
                      f"{self.diagnostics(result)}")
        aborts = self.board.aborts()
        self.assertIn("TEST-fake_module.FakeCase.xml",
                      (aborts[0][1] or {}).get("reason", "") if aborts else "",
                      f"the abort's reason is the refusal; aborts={aborts!r}")

    def test_a_413_from_the_board_is_reported_naming_ingest_body_bytes(self):
        self.board.refuse_ingest_for(FIRST_RUN, status=413)
        result = self.drive("test", "py-board-413")
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


class NoBoardNoFiguresTest(_PythonProject, unittest.TestCase):
    """The client's own `main()`, in-process, with ONE route answered as the
    fleet transport answers a board it cannot reach; every other route
    reaches the recording board."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_in_process(self, argv, unreachable):
        module = load_client("python-crucible.py")
        real_request = module._request

        def request(method, path, payload=None, timeout=None):
            if (method, path) in unreachable:
                return dict(_UNREACHABLE)
            return real_request(method, path, payload, timeout)

        out, err = io.StringIO(), io.StringIO()
        env = self.env()
        with mock.patch.object(module, "_request", request), \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(sys, "argv", ["python-crucible.py", *argv]), \
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
            self.argv("test", "py-ingest-unreachable"),
            {("POST", RUNS), ("POST", PARSED)})
        envelope = self.assert_no_figures_and_not_filed(code, stdout, stderr)
        self.assertIn("connection failed", envelope.get("error") or "", stdout)

    def test_a_health_read_that_cannot_reach_the_board_sends_nothing(self):
        code, stdout, stderr = self.drive_in_process(
            self.argv("regression", "py-health-unreachable"), {("GET", HEALTH)})
        self.assert_no_figures_and_not_filed(code, stdout, stderr)
        self.assertEqual(self.posts_to(RUNS), [], stdout)
        self.assertEqual(self.posts_to(PARSED), [], stdout)
        self.assertIn("run-aborted", _codes(_envelope(stdout)), stdout)

    def test_pre_merge_gate_reports_its_unfiled_suite_unreported_and_is_not_green(self):
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "py-gate-unreachable", "--skip-check"),
            {("POST", RUNS), ("POST", PARSED)})
        where = f"exit={code} stdout={stdout!r} stderr={stderr[-2500:]!r}"
        envelope = _envelope(stdout) or {}
        self.assertIs(envelope.get("ok"), False, where)
        self.assertEqual(_figures(envelope), {},
                         f"the gate states no figures for a suite it could not "
                         f"file; {where}")
        self.assertIn("gate-suite-unreported", _codes(envelope),
                      f"the gate names the suite it could not file as "
                      f"unreported; {where}")
        self.assertNotIn("gate-suite-failed", _codes(envelope), where)
        self.assertNotEqual(code, 0, where)


# ── the no-report exits, unchanged ─────────────────────────────────────────

class TheNoReportExitsAreUnchangedTest(_PythonProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_a_run_with_no_junit_files_its_compile_ingest_and_no_run(self):
        for verb in ("test", "regression"):
            with self.subTest(verb=verb):
                result = self.drive(verb, f"py-no-junit-{verb}", FAKE_REPORT="none",
                                    FAKE_EXIT="1")
                self.assertEqual(len(self.posts_to(COMPILE)), 1,
                                 self.diagnostics(result))
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))
                del self.board.events[:]

    def test_a_pytest_that_failed_as_a_runner_files_a_compile_ingest_and_discards_its_junit(self):
        result = self.drive("test", "py-pytest-runner-failure", "--runner", "pytest",
                            FAKE_EXIT="4")
        self.assertTrue(Path(self.project, "reports", "TEST-pytest.xml").exists(),
                        f"fixture -- pytest left a JUnit behind; "
                        f"{self.diagnostics(result)}")
        self.assertEqual(len(self.posts_to(COMPILE)), 1, self.diagnostics(result))
        self.assertEqual(self.posts_to(RUNS), [],
                         f"the JUnit a failed pytest left is no result to send; "
                         f"{self.diagnostics(result)}")
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_discovery_that_found_no_test_is_no_tests_discovered_and_sends_nothing(self):
        result = self.drive("regression", "py-zero-discovery", FAKE_ZERO_DISCOVERY="1")
        self.assertIn("no-tests-discovered", _codes(self.envelope_of(result)),
                      self.diagnostics(result))
        self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(COMPILE), [], self.diagnostics(result))
        self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


if __name__ == "__main__":
    unittest.main()
