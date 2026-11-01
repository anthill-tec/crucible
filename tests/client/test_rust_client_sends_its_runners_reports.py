"""The rust client sends its runner's reports and parses nothing.

Every rust verb that files a report (`test`, `unit`, `smoke-test`,
`docker-e2e-gate`, `workspace-regression`, `regression`, `pre-merge-gate`,
`regression-ingest` and `auto-ingest`) files it through the shared ingest
(`ingest_reports`, clients/_crucible_run.py): the board's health is read
first, then ONE `POST /api/v2/runs` goes out carrying `codec: "junit"`,
`data` (the text of the nextest `junit.xml` the verb reads),
`coverage: {codec: "lcov", data}` on a run that measured coverage and found
its lcov (passing or failing), `raw` (the captured runner output, on every
verb but `auto-ingest`) and `runnerExit`. Nothing goes to
`/api/v2/runs/parsed`, and no body carries a `dataPath`.

Every figure the envelope reports is the board's: its `run:` block is the
answer's `run` block (`files` included, on every run verb), the regression
verbs' `coverage:` field is the answer's `run.coverage` percents (absent when
the board kept none), the one stderr `ingest:` line reads the answer, and the
answer's `warnings[]` join the envelope's. With no board there are no
figures. A board that cannot decode the run (no `codecs`, or no `lcov` for a
coverage run), or whose advertised `ingest_body_bytes` the body exceeds, is
refused before anything is sent, and the run the verb opened is aborted.

The client still decides locally whether a run "ran nothing" (a non-zero
runner over a report with no `<testcase>`, `junit_testcase_count`) — in
`regression-ingest` too — and its exit by `verb_exit` over the runner's exit
and the board's answer; `auto-ingest`, which runs no runner, exits 0 only on
an `ok` answer whose run records no failure. The no-report exit is unchanged:
a run that wrote no report files its rustc compile ingest and no run. The
shared `ingest:` line is the run's one ingest line (none of rust's own result
lines is left in the client), and the shared module does not grow past its
line budget.

Every drive runs the real `clients/rust-crucible.py` over a scratch project
(outside git, so no gate lock is taken; `--min-free-g 0` and `--keep-target`
keep the disk guard and the reclaim off the host) with a fake `cargo` and a
fake `docker` first on PATH. The fake `cargo` writes the exact report and lcov
texts below where nextest and llvm-cov write them. Most drive it as a
subprocess against a `RecordingBoard` whose `/api/v2/runs` answer the test
scripts; the ones that need a board that cannot be reached at one route drive
`main()` in-process with that one route answered as the transport answers an
unreachable board.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_rust_client_sends_its_runners_reports
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
RUST_CLIENT = CLIENTS / "rust-crucible.py"
TIMEOUT = 120
PROJECT_KEY = "rust-sends-its-reports-key"

RUNS = "/api/v2/runs"
PARSED = "/api/v2/runs/parsed"
COMPILE = "/api/v2/runs/compile"
HEALTH = "/api/health"
FIRST_RUN = "run-live-1"

# The line the fake prints on stdout: the captured output `raw` carries.
OUTPUT_MARKER = "fake-cargo-output-line-9c41"

_CASE = ('    <testcase name="{name}" classname="{classname}" time="0.001">'
         '{body}</testcase>\n')
_FAILURE = '<failure message="planted">planted failure</failure>'


def _junit(cases):
    """One nextest JUnit report, byte for byte: one `<testsuite>` per test
    binary, `cases` a list of `(binary, name, failing)`."""
    suites = {}
    for binary, name, failing in cases:
        suites.setdefault(binary, []).append(_CASE.format(
            name=name, classname=binary, body=_FAILURE if failing else ""))
    failures = sum(1 for _b, _n, failing in cases if failing)
    text = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<testsuites name="nextest-run" tests="{len(cases)}" '
            f'failures="{failures}" errors="0">\n')
    for binary, body in suites.items():
        text += (f'  <testsuite name="{binary}" tests="{len(body)}" '
                 f'disabled="0" errors="0" failures="0">\n'
                 + "".join(body) + '  </testsuite>\n')
    return text + '</testsuites>\n'


# The reports the fake writes: two passing cases over two test binaries
# (`pass`), the same with the second failing (`fail`), or a run that holds no
# case at all (`zero`).
JUNIT = {
    "pass": _junit([("demo", "adds", False), ("demo::parity", "evens", False)]),
    "fail": _junit([("demo", "adds", False), ("demo::parity", "evens", True)]),
    "zero": ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<testsuites name="nextest-run" tests="0" failures="0" '
             'errors="0">\n</testsuites>\n'),
}
# The lcov llvm-cov writes at `--output-path`, byte for byte (lines 8/10,
# functions 1/2): summed by a client, 80% and 50%.
LCOV = ("SF:/project/src/lib.rs\nFN:1,add\nFN:5,sub\nFNDA:3,add\nFNDA:0,sub\n"
        "FNF:2\nFNH:1\nDA:1,3\nDA:2,3\nDA:3,3\nDA:4,3\nDA:5,0\nDA:6,0\n"
        "DA:7,3\nDA:8,3\nDA:9,3\nDA:10,3\nLF:10\nLH:8\nend_of_record\n")

# The coverage the scripted board says it kept: not what the lcov above sums
# to, so an envelope or a line that reads the client's own sum is caught.
BOARD_COVERAGE = {"lines": {"total": 200, "covered": 123, "percent": 61.5},
                  "functions": {"total": 40, "covered": 17, "percent": 42.5}}
BOARD_COVERAGE_FIELD = {"lines": 61.5, "functions": 42.5}

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY",
             "RUST_CRUCIBLE_PROJECT_DIR", "RUST_CRUCIBLE_COMPOSE_FILE",
             "CARGO_TARGET_DIR")
_FAKE_KEYS = ("FAKE_EXIT", "FAKE_VARIANT", "FAKE_NO_LCOV")

# A fake `cargo`. `clean`, `cache` and `clippy` succeed silently; `check` (the
# client's compile fallback) prints one rustc error on stderr and exits 101.
# Any run naming `nextest` (plain `nextest run`, or `llvm-cov ... nextest`)
# prints OUTPUT_MARKER and nextest's start line on stdout, writes the
# FAKE_VARIANT report (`pass` by default; `fail`, `zero`, or `none` for no
# report) at `target/nextest/<-P profile>/junit.xml` under its cwd, and, when
# given `--output-path`, the lcov there unless FAKE_NO_LCOV=1. It exits
# FAKE_EXIT (default 0).
_FAKE_CARGO = r'''
import os
import sys

JUNIT, LCOV, MARKER = ''' + repr((JUNIT, LCOV, OUTPUT_MARKER)) + r'''

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

args = sys.argv[1:]
if not args or args[0] in ("clean", "cache", "clippy"):
    sys.exit(0)
if args[0] == "check":
    sys.stderr.write("error[E0425]: cannot find value `nope` in this scope\n")
    sys.exit(101)
if "nextest" not in args:
    sys.exit(0)
profile = "default"
lcov = None
for i, arg in enumerate(args):
    if arg == "-P" and i + 1 < len(args):
        profile = args[i + 1]
    if arg == "--output-path" and i + 1 < len(args):
        lcov = args[i + 1]
variant = os.environ.get("FAKE_VARIANT", "pass")
sys.stdout.write(MARKER + "\n")
sys.stdout.write("    Starting 2 tests across 2 binaries\n")
sys.stdout.flush()
if variant != "none":
    write(os.path.join(os.getcwd(), "target", "nextest", profile, "junit.xml"),
          JUNIT[variant])
if lcov and os.environ.get("FAKE_NO_LCOV") != "1":
    write(os.path.join(os.getcwd(), lcov), LCOV)
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''

# A `docker` stand-in for the e2e gate's compose bring-up and teardown: it
# exits 0 with no output, so the host's real docker is never reached.
_FAKE_DOCKER = "import sys\nsys.exit(0)\n"

# Each verb's own flags beyond `--agent`/`--project-dir`: the crate a
# per-crate verb names, and the disk-guard floor and target reclaim that would
# otherwise measure (and `cargo clean`) the host.
VERB_FLAGS = {
    "test": ("--crate", "demo"),
    "unit": (),
    "smoke-test": (),
    "docker-e2e-gate": ("--min-free-g", "0"),
    "workspace-regression": ("--min-free-g", "0", "--keep-target"),
    "regression": ("--min-free-g", "0"),
    "pre-merge-gate": ("--skip-clippy", "--min-free-g", "0", "--keep-target"),
    "regression-ingest": ("--crates", "demo"),
    "auto-ingest": ("--crate", "demo"),
}
# `regression` with coverage on, and its coverage-only flags.
COVERAGE_REGRESSION = ("--coverage", "--keep-target")

# The tier each verb's run is filed under.
TIERS = {"unit": "unit", "smoke-test": "integration", "docker-e2e-gate": "e2e",
         "workspace-regression": "regression", "regression": "regression",
         "pre-merge-gate": "regression", "regression-ingest": "regression"}


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


class _RustProject:
    """A scratch cargo project with the fake `cargo` and `docker` on PATH,
    filing to a RecordingBoard."""

    def make(self, board=None):
        self.project = new_scratch("rust-sends-its-reports-")
        self.bin_dir = new_scratch("rust-sends-its-reports-bin-")
        self.board = board or RecordingBoard()
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        self.point_at(self.board)
        _write_script(os.path.join(self.bin_dir, "cargo"), _FAKE_CARGO)
        _write_script(os.path.join(self.bin_dir, "docker"), _FAKE_DOCKER)

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

    def declare_tier_profile(self, tier):
        """A `.config/nextest.toml` declaring one tier profile, `<tier>`, with
        the junit sub-table that makes it a whole declaration."""
        config = Path(self.project, ".config", "nextest.toml")
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(f'[profile.{tier}]\n[profile.{tier}.junit]\n'
                          f'path = "junit.xml"\n')

    def env(self, **fake_env):
        env = scrubbed_env(self.bin_dir, **fake_env)
        for key in _SCRUBBED + _FAKE_KEYS:
            if key not in fake_env:
                env.pop(key, None)
        return env

    def argv(self, verb, agent, *extra):
        return [verb, "--agent", agent, "--project-dir", self.project,
                *VERB_FLAGS[verb], *extra]

    def drive(self, verb, agent, *extra, **fake_env):
        cmd = [sys.executable, str(RUST_CLIENT), *self.argv(verb, agent, *extra)]
        return subprocess.run(cmd, cwd=self.project, env=self.env(**fake_env),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def write_existing_report(self, variant="pass", profile="ci"):
        """The report a previous nextest run left under `target/`, for
        `auto-ingest` (which runs no nextest) to file."""
        path = Path(self.project, "target", "nextest", profile, "junit.xml")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(JUNIT[variant])

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
        to the parsed route and that its report travels inline."""
        self.assertEqual(  # type: ignore[attr-defined]
            self.posts_to(PARSED), [],
            f"the rust client never posts to {PARSED}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        ingests = self.posts_to(RUNS)
        self.assertEqual(  # type: ignore[attr-defined]
            len(ingests), 1,
            f"the run is filed as exactly one POST {RUNS}; posts="
            f"{[p for p, _ in self.board.posts()]!r} {self.diagnostics(result)}")
        body = ingests[0] if ingests else {}
        self.assertNotIn("dataPath", body,  # type: ignore[attr-defined]
                         f"reports travel inline, never as a path; body={body!r}")
        self.assertEqual(body.get("stack"), "rust",  # type: ignore[attr-defined]
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


# ── AC7 — every report verb sends one /api/v2/runs with raw and runnerExit ──

class EveryRustReportVerbSendsOneRunsIngestTest(_RustProject, unittest.TestCase):
    """The route, the codec, the inline report text, `raw` and `runnerExit`,
    for every rust verb that files a report."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def assert_report_inline_with_raw_and_exit(self, result, text=JUNIT["pass"],
                                               runner_exit=0):
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("data"), [text],
                         f"`data` is the junit.xml text the run wrote, inline, "
                         f"byte for byte; body={body!r}")
        self.assertIsInstance(body.get("raw"), str, f"body={body!r}")
        self.assertIn(OUTPUT_MARKER, body.get("raw") or "",
                      f"`raw` is the runner's captured output; body={body!r}")
        self.assertEqual(body.get("runnerExit"), runner_exit,
                         f"`runnerExit` is the runner's exit; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        return body

    def test_test_sends_its_junit_text_with_raw_and_the_runner_exit(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("test", "rust-sends-test")
        body = self.assert_report_inline_with_raw_and_exit(result)
        self.assertNotIn("tier", body, f"a `test` run claims no tier; body={body!r}")
        self.assertNotIn("coverage", body, f"`test` measures none; body={body!r}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_failing_runner_sends_its_non_zero_exit_as_runner_exit(self):
        self.board.script_run(passed=1, failed=1, total=2, files=2)
        result = self.drive("test", "rust-sends-test-exit-100",
                            FAKE_VARIANT="fail", FAKE_EXIT="100")
        self.assert_report_inline_with_raw_and_exit(result, JUNIT["fail"],
                                                    runner_exit=100)
        self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_unit_sends_its_junit_text_under_its_tier(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("unit", "rust-sends-unit")
        body = self.assert_report_inline_with_raw_and_exit(result)
        self.assertEqual(body.get("tier"), "unit", f"body={body!r}")

    def test_smoke_test_and_docker_e2e_gate_send_their_junit_text_under_their_tier(self):
        for verb in ("smoke-test", "docker-e2e-gate"):
            with self.subTest(verb=verb):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                result = self.drive(verb, f"rust-sends-{verb}")
                body = self.assert_report_inline_with_raw_and_exit(result)
                self.assertEqual(body.get("tier"), TIERS[verb], f"body={body!r}")
                self.assertNotIn("coverage", body,
                                 f"a smoke run measures none; body={body!r}")

    def test_the_regression_verbs_send_their_junit_text_as_a_regression(self):
        for verb, extra in (("workspace-regression", ()),
                            ("regression", ()),
                            ("regression", COVERAGE_REGRESSION),
                            ("pre-merge-gate", ()),
                            ("regression-ingest", ())):
            with self.subTest(verb=verb, extra=extra):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                result = self.drive(verb, f"rust-sends-{verb}", *extra)
                body = self.assert_report_inline_with_raw_and_exit(result)
                self.assertEqual(body.get("tier"), "regression", f"body={body!r}")
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_sends_the_report_a_previous_run_left_with_no_raw(self):
        self.write_existing_report()
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("auto-ingest", "rust-sends-auto-ingest")
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("data"), [JUNIT["pass"]],
                         f"`data` is the junit.xml text, inline; body={body!r}")
        self.assertNotIn("raw", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("runnerExit", body, f"auto-ingest runs nothing; body={body!r}")
        self.assertNotIn("tier", body, f"auto-ingest claims no tier; body={body!r}")
        self.assertNotIn("coverage", body, f"auto-ingest measures none; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))


# ── AC2 — coverage travels as its report ────────────────────────────────────

LCOV_BLOCK = {"codec": "lcov", "data": [LCOV]}


class CoverageTravelsAsItsReportTest(_RustProject, unittest.TestCase):
    """`regression-ingest`, and `workspace-regression`, `regression
    --coverage` and `pre-merge-gate` (coverage on), send the lcov text as
    their coverage report, passing or failing."""

    COVERAGE_VERBS = (("regression-ingest", ()),
                      ("workspace-regression", ()),
                      ("regression", COVERAGE_REGRESSION),
                      ("pre-merge-gate", ()))

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_a_passing_coverage_run_sends_the_lcov_text(self):
        for verb, extra in self.COVERAGE_VERBS:
            with self.subTest(verb=verb, extra=extra):
                self.fresh_board().script_run(passed=2, total=2, files=2,
                                              coverage=BOARD_COVERAGE)
                result = self.drive(verb, f"rust-coverage-green-{verb}", *extra)
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("coverage"), LCOV_BLOCK,
                                 f"the lcov llvm-cov wrote is sent inline as the "
                                 f"run's coverage report; body={body!r}")
                self.assertNotIn("coverage-not-measured",
                                 _codes(self.envelope_of(result)),
                                 self.diagnostics(result))
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_failing_coverage_run_still_sends_the_lcov_text(self):
        # The board discards a red run's coverage; the client sends it anyway.
        for verb, extra in self.COVERAGE_VERBS:
            with self.subTest(verb=verb, extra=extra):
                self.fresh_board().script_run(passed=1, failed=1, total=2, files=2)
                result = self.drive(verb, f"rust-coverage-red-{verb}", *extra,
                                    FAKE_VARIANT="fail")
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("data"), [JUNIT["fail"]], f"body={body!r}")
                self.assertEqual(body.get("coverage"), LCOV_BLOCK,
                                 f"coverage is sent whether or not the run "
                                 f"passed; body={body!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_a_coverage_run_with_no_lcov_sends_none_and_warns_coverage_not_measured(self):
        for verb, extra in self.COVERAGE_VERBS:
            with self.subTest(verb=verb, extra=extra):
                self.fresh_board().script_run(passed=2, total=2, files=2)
                result = self.drive(verb, f"rust-coverage-missing-{verb}", *extra,
                                    FAKE_NO_LCOV="1")
                body = self.the_one_runs_ingest(result)
                self.assertNotIn("coverage", body, f"body={body!r}")
                codes = _codes(self.envelope_of(result))
                self.assertEqual(codes.count("coverage-not-measured"), 1,
                                 f"the envelope says the coverage the run "
                                 f"measures was not measured, once; "
                                 f"{self.diagnostics(result)}")

    def test_a_run_with_coverage_off_sends_none_and_warns_nothing_missing(self):
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("regression", "rust-coverage-off")
        body = self.the_one_runs_ingest(result)
        self.assertNotIn("coverage", body,
                         f"a run without --coverage sends no coverage; body={body!r}")
        self.assertNotIn("coverage-not-measured", _codes(self.envelope_of(result)),
                         f"nothing was asked, so nothing is missing; "
                         f"{self.diagnostics(result)}")
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_the_stderr_ingest_line_reads_the_answers_coverage(self):
        self.board.script_run(passed=2, total=2, files=2, coverage=BOARD_COVERAGE)
        result = self.drive("regression-ingest", "rust-coverage-line")
        lines = [line for line in result.stderr.splitlines()
                 if line.startswith("ingest: ")]
        self.assertEqual(len(lines), 1,
                         f"the run has one `ingest:` line; {self.diagnostics(result)}")
        line = lines[0] if lines else ""
        self.assertIn("lines=61.5%", line,
                      f"the line states the board's lines figure; {line!r}")
        self.assertIn("funcs=42.5%", line,
                      f"the line states the board's functions figure; {line!r}")
        self.assertNotIn("lines=80.0%", result.stderr,
                         f"the client's own lcov sum is never reported; "
                         f"{self.diagnostics(result)}")

    def test_health_lacking_lcov_refuses_the_coverage_run(self):
        health = self.board.default_health()
        health["codecs"] = {"test": ["junit"], "coverage": ["jacoco"]}
        health["version"] = "0.3.9"
        self.board.script_health(health)
        for verb in ("regression-ingest", "workspace-regression"):
            with self.subTest(verb=verb):
                before = len(self.board.events)
                result = self.drive(verb, f"rust-board-without-lcov-{verb}")
                del self.board.events[:before]
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


# ── AC5 — the local decisions: ran nothing, and the exit ───────────────────

class TheLocalDecisionsTest(_RustProject, unittest.TestCase):

    VERBS = ("test", "smoke-test", "workspace-regression", "regression-ingest")

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

    def test_a_runner_exiting_non_zero_over_a_report_with_no_testcase_ran_nothing(self):
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-ran-nothing-{verb}",
                                          FAKE_VARIANT="zero", FAKE_EXIT="1")
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
                result = self.drive_fresh(verb, f"rust-failure-{verb}", scripted,
                                          FAKE_VARIANT="fail", FAKE_EXIT="100")
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("runnerExit"), 100, f"body={body!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))
                self.assertEqual(_figures(self.envelope_of(result)).get("failed"), 1,
                                 self.diagnostics(result))

    def test_a_failure_only_the_board_reports_makes_the_verb_exit_one(self):
        # The runner exits 0 over a passing report; the board's decoded run
        # holds a failure, and the verb's exit is `verb_exit` over its answer.
        scripted = {"passed": 1, "failed": 1, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-board-failure-{verb}", scripted)
                body = self.the_one_runs_ingest(result)
                self.assertEqual(body.get("runnerExit"), 0, f"body={body!r}")
                self.assertEqual(result.returncode, 1, self.diagnostics(result))

    def test_a_run_the_board_reports_clean_exits_zero(self):
        scripted = {"passed": 2, "total": 2, "files": 2}
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-board-clean-{verb}", scripted)
                self.the_one_runs_ingest(result)
                self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_exits_zero_on_an_ok_answer_with_no_failure(self):
        self.write_existing_report()
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("auto-ingest", "rust-auto-ingest-ok")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_auto_ingest_exits_one_on_an_ok_answer_whose_run_records_a_failure(self):
        # The report on disk passes; the board's decoded run says otherwise.
        self.write_existing_report()
        self.board.script_run(passed=1, failed=1, total=2, files=2)
        result = self.drive("auto-ingest", "rust-auto-ingest-failure")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 1,
                         f"auto-ingest exits 0 only when its run records no "
                         f"failure; {self.diagnostics(result)}")

    def test_auto_ingest_exits_one_on_an_answer_that_is_not_ok(self):
        self.write_existing_report()
        health = self.board.default_health()
        health.pop("codecs")
        self.board.script_health(health)
        result = self.drive("auto-ingest", "rust-auto-ingest-refused")
        self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
        self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
        self.assertEqual(result.returncode, 1, self.diagnostics(result))


# ── AC6 / AC8 — the envelope reads the answer ──────────────────────────────

class TheEnvelopeReadsTheAnswerTest(_RustProject, unittest.TestCase):

    RUN_VERBS = (("test", ()), ("smoke-test", ()), ("auto-ingest", ()),
                 ("workspace-regression", ()), ("regression-ingest", ()),
                 ("regression", ()), ("pre-merge-gate", ()))

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_fresh(self, verb, agent, *extra, **scripted):
        self.fresh_board().script_run(**scripted)
        if verb == "auto-ingest":
            self.write_existing_report()
        return self.drive(verb, agent, *extra)

    def test_the_envelope_run_block_is_the_answers_five_counts_files_included(self):
        # The report holds two passing cases over two binaries; the board says
        # otherwise, and the envelope states what the board said.
        for verb, extra in self.RUN_VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-envelope-counts-{verb}",
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
                self.assertEqual(
                    [line for line in lines if line.startswith("ingest junit:")],
                    [], "rust's own ingest line is gone; " + self.diagnostics(result))

    def test_the_regression_verbs_coverage_field_is_the_answers(self):
        for verb in ("regression-ingest", "workspace-regression"):
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-envelope-coverage-{verb}",
                                          passed=2, total=2, files=2,
                                          coverage=BOARD_COVERAGE)
                envelope = self.envelope_of(result)
                self.assertEqual(envelope.get("coverage"), BOARD_COVERAGE_FIELD,
                                 f"the coverage field is the answer's lines and "
                                 f"functions percents, never the client's own "
                                 f"lcov sum; envelope={envelope!r}")

    def test_the_regression_verbs_state_no_coverage_the_answer_does_not_carry(self):
        # The lcov is sent; the board kept no coverage (as it keeps none for a
        # red run), so the envelope states none.
        for verb in ("regression-ingest", "workspace-regression"):
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-envelope-no-coverage-{verb}",
                                          passed=2, total=2, files=2)
                envelope = self.envelope_of(result)
                self.assertNotIn("coverage", envelope,
                                 f"no coverage in the answer, none in the "
                                 f"envelope; envelope={envelope!r}")

    def test_the_other_run_verbs_never_carry_a_coverage_field(self):
        for verb in ("test", "smoke-test", "auto-ingest"):
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-envelope-no-coverage-{verb}",
                                          passed=2, total=2, files=2,
                                          coverage=BOARD_COVERAGE)
                envelope = self.envelope_of(result)
                self.assertNotIn("coverage", envelope, f"envelope={envelope!r}")
                self.assertEqual(_figures(envelope).get("files"), 2,
                                 f"envelope={envelope!r}")

    def test_a_board_report_skipped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "report-skipped",
                   "detail": "report 1 skipped: not a JUnit report"}
        for verb, extra in self.RUN_VERBS:
            with self.subTest(verb=verb):
                result = self.drive_fresh(verb, f"rust-envelope-skipped-{verb}",
                                          *extra, passed=2, total=2, files=2,
                                          warnings=[warning])
                self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                              self.diagnostics(result))

    def test_a_board_coverage_dropped_warning_joins_the_envelope_warnings(self):
        warning = {"code": "coverage-dropped",
                   "detail": "lcov coverage dropped: no LF records"}
        result = self.drive_fresh("regression-ingest", "rust-envelope-coverage-dropped",
                                  passed=2, total=2, files=2, warnings=[warning])
        self.assertIn(warning, self.envelope_of(result).get("warnings") or [],
                      self.diagnostics(result))


# ── AC6 — an older board, a body too large ─────────────────────────────────

class ABoardThatCannotTakeTheRunIsRefusedBeforeSendingTest(_RustProject,
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
        for verb in ("test", "smoke-test", "workspace-regression", "regression-ingest"):
            with self.subTest(verb=verb):
                self.fresh_board().script_health(health)
                result = self.drive(verb, f"rust-older-board-{verb}")
                self.assert_refused_before_sending(result, "0.3.7", "0.4.0")

    def test_health_that_cannot_be_read_is_refused_before_sending(self):
        self.board.fail_health(status=503, error="health unavailable")
        result = self.drive("regression-ingest", "rust-health-unreadable")
        self.assert_refused_before_sending(result)

    def test_health_with_codecs_but_no_limits_still_sends(self):
        health = self.board.default_health()
        health.pop("limits")
        self.board.script_health(health)
        self.board.script_run(passed=2, total=2, files=2)
        result = self.drive("test", "rust-board-without-limits")
        self.the_one_runs_ingest(result)
        self.assertEqual(result.returncode, 0, self.diagnostics(result))

    def test_a_body_over_the_advertised_limit_is_refused_naming_ingest_body_bytes(self):
        for verb in ("test", "regression-ingest"):
            with self.subTest(verb=verb):
                self.fresh_board(RecordingBoard(ingest_body_bytes=64))
                result = self.drive(verb, f"rust-body-too-large-{verb}")
                self.assert_refused_before_sending(result, "ingest_body_bytes", "64")

    def test_a_413_from_the_board_is_reported_naming_ingest_body_bytes(self):
        for verb in ("test", "workspace-regression"):
            with self.subTest(verb=verb):
                self.fresh_board().refuse_ingest_for(FIRST_RUN, status=413)
                result = self.drive(verb, f"rust-board-413-{verb}")
                self.assertEqual(len(self.posts_to(RUNS)), 1, self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                envelope = self.envelope_of(result)
                self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
                self.assertIn("ingest_body_bytes", str(envelope.get("error")),
                              f"envelope={envelope!r}")
                self.assertEqual(_figures(envelope), {}, f"envelope={envelope!r}")
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


# ── AC6 — no board, no figures ──────────────────────────────────────────────

_UNREACHABLE = {"ok": False, "error": "connection failed: [Errno 111] Connection "
                                      "refused (is Crucible running?)"}


class NoBoardNoFiguresTest(_RustProject, unittest.TestCase):
    """The client's own `main()`, in-process, with ONE route answered as the
    fleet transport answers a board it cannot reach; every other route
    reaches the recording board."""

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def drive_in_process(self, argv, unreachable):
        module = load_client("rust-crucible.py")
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
                    mock.patch.object(sys, "argv", ["rust-crucible.py", *argv]), \
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
        for verb in ("regression-ingest", "workspace-regression"):
            with self.subTest(verb=verb):
                code, stdout, stderr = self.drive_in_process(
                    self.argv(verb, f"rust-ingest-unreachable-{verb}"),
                    {("POST", RUNS), ("POST", PARSED)})
                envelope = self.assert_no_figures_and_not_filed(code, stdout, stderr)
                self.assertIn("connection failed", envelope.get("error") or "", stdout)

    def test_a_health_read_that_cannot_reach_the_board_sends_nothing(self):
        for verb in ("regression-ingest", "workspace-regression"):
            with self.subTest(verb=verb):
                self.fresh_board()
                code, stdout, stderr = self.drive_in_process(
                    self.argv(verb, f"rust-health-unreachable-{verb}"),
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
        # No declared profile: the gate's envelope is its whole-suite run's.
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "rust-gate-unreachable"),
            {("POST", RUNS), ("POST", PARSED)})
        envelope = self.assert_gate_unreported(code, stdout, stderr)
        self.assertEqual(_figures(envelope), {},
                         f"the gate states no figures for a suite it could not "
                         f"file; stdout={stdout!r}")

    def test_pre_merge_gate_whose_health_read_finds_no_board_reports_it_unreported(self):
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "rust-gate-health-unreachable"),
            {("GET", HEALTH)})
        envelope = self.assert_gate_unreported(code, stdout, stderr)
        self.assertEqual(_figures(envelope), {}, f"stdout={stdout!r}")

    def test_pre_merge_gate_composing_a_declared_profile_reports_it_unreported(self):
        # A declared `unit` profile: the gate composes, and its whole-suite
        # run, which covers it, is a suite whose outcome it must report.
        self.declare_tier_profile("unit")
        code, stdout, stderr = self.drive_in_process(
            self.argv("pre-merge-gate", "rust-gate-composed-unreachable"),
            {("POST", RUNS), ("POST", PARSED)})
        self.assert_gate_unreported(code, stdout, stderr)


# ── AC9 — one ingest line, and the shared module does not grow ─────────────

# Each shared module's line budget is that module's size (its newline count,
# as the test below counts it), so neither shared module grows unnoticed:
# `_crucible_axi.py`'s recorded when the run pipeline was split out of the core
# into its own module, `_crucible_run.py`'s re-recorded when the arduino
# client's move to the shared ingest grew it (`junit_case_sources` in,
# `filed_summary` out), and again when CR-CRU-224's python stream relay grew
# it (`StreamRelay` and `close_stream` in), and again at CR-CRU-225's close-out
# (the shared streamed-run close and the stream-counted narration in). The
# rust client's move to the shared ingest adds nothing to either. A change
# that grows a shared module re-records its budget here, in the same change.
SHARED_MODULE_LINE_BUDGETS = {"_crucible_axi.py": 9088, "_crucible_run.py": 1731}
_OWN_RESULT_LINES = ("ingest junit:", "regression: ok=",
                     "workspace regression: ok=", "smoke-test: ok=")


def own_result_line_literals(source):
    """Every string literal of `source` (an f-string's literal parts too)
    that begins one of rust's own result lines."""
    return sorted({node.value for node in ast.walk(ast.parse(source))
                   if isinstance(node, ast.Constant) and isinstance(node.value, str)
                   and node.value.startswith(_OWN_RESULT_LINES)})


class TheRustClientPrintsOnlyTheSharedIngestLineTest(unittest.TestCase):

    def test_the_scan_finds_an_own_result_line_in_a_plain_or_formatted_literal(self):
        source = textwrap.dedent('''
            import sys
            def _a(resp):
                print(f"ingest junit: ok={resp} passed=1", file=sys.stderr)
            def _b(resp):
                print("regression: ok=" + str(resp), file=sys.stderr)
            def _c(resp):
                print(f"workspace regression: ok={resp}", file=sys.stderr)
                print(f"smoke-test: ok={resp} passed=1", file=sys.stderr)
            def _d(verb, resp):
                print(f"ingest compile (check): ok={resp}", file=sys.stderr)
                print(f"ingest: ok={resp}", file=sys.stderr)
                print(f"{verb}: ok=False — gate-locked", file=sys.stderr)
        ''')
        self.assertEqual(own_result_line_literals(source),
                         ["ingest junit: ok=", "regression: ok=",
                          "smoke-test: ok=", "workspace regression: ok="])

    def test_the_rust_client_holds_none_of_its_own_result_line_literals(self):
        found = own_result_line_literals(RUST_CLIENT.read_text(encoding="utf-8"))
        self.assertEqual(found, [],
                         f"the shared `ingest:` line is the run's one ingest "
                         f"line; rust-crucible.py still prints {found!r}")

    def test_the_shared_module_is_no_longer_than_its_line_budget(self):
        for name, budget in SHARED_MODULE_LINE_BUDGETS.items():
            with self.subTest(module=name):
                path = CLIENTS / name
                self.assertTrue(path.is_file(), f"the shared module {name} exists")
                lines = path.read_text(encoding="utf-8").count("\n")
                self.assertLessEqual(
                    lines, budget,
                    f"clients/{name} is {lines} lines, over its budget of "
                    f"{budget}")


# ── the no-report exit, unchanged ──────────────────────────────────────────

class TheNoReportExitIsUnchangedTest(_RustProject, unittest.TestCase):

    def setUp(self):
        self.make()

    def tearDown(self):
        self.cleanup()

    def test_a_test_run_with_no_report_files_its_compile_ingest_and_no_run(self):
        for verb in ("test", "unit"):
            with self.subTest(verb=verb):
                self.fresh_board()
                result = self.drive(verb, f"rust-no-report-{verb}",
                                    FAKE_VARIANT="none", FAKE_EXIT="101")
                compiles = self.posts_to(COMPILE)
                self.assertEqual(len(compiles), 1, self.diagnostics(result))
                self.assertIn("cannot find value",
                              (compiles[0] or {}).get("errors", "") if compiles else "",
                              f"compiles={compiles!r}")
                self.assertEqual(self.posts_to(RUNS), [], self.diagnostics(result))
                self.assertEqual(self.posts_to(PARSED), [], self.diagnostics(result))
                self.assertNotEqual(result.returncode, 0, self.diagnostics(result))


if __name__ == "__main__":
    unittest.main()
