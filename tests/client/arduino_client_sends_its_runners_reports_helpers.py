"""The helpers of `test_arduino_client_sends_its_runners_reports.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
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
# skipped (`skip`), one report that holds no case at all (`zero`), or the
# passing first report beside a second that is not well-formed XML
# (`malformed`), whose results cannot be counted.
MALFORMED_REPORT = "TEST-test_pid.xml"

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
    "malformed": {"TEST-test_motor.xml": _report("test_motor", [("test_spins_up", "pass")]),
                  MALFORMED_REPORT: ('<?xml version="1.0" encoding="UTF-8"?>\n'
                                     '<testsuites>\n  <testsuite name="test_pid"\n')},
}

# The lcov the native harness writes at `$COVERAGE_DIR/lcov.info`, byte for
# byte (lines 8/10, functions 1/2): summed by a client, 80% and 50%.
LCOV = ("TN:\nSF:/project/src/motor.cpp\nFN:1,motor_spin\nFN:5,motor_stop\n"
        "FNDA:3,motor_spin\nFNDA:0,motor_stop\nFNF:2\nFNH:1\nDA:1,3\nDA:2,3\n"
        "DA:3,3\nDA:4,3\nDA:5,0\nDA:6,0\nDA:7,3\nDA:8,3\nDA:9,3\nDA:10,3\n"
        "LF:10\nLH:8\nend_of_record\n")

_SCRUBBED = ("ARDUINO_CRUCIBLE_PROJECT_DIR", "CRUCIBLE_AGENT_ID",
             "CRUCIBLE_PROJECT_KEY", "AGENT_ID", "TESTS", "TEST_NAME")

_FAKE_KEYS = ("FAKE_EXIT", "FAKE_VARIANT", "FAKE_NO_LCOV", "FAKE_OWN_COVERAGE")

# A fake `make`. Whatever the target, it prints OUTPUT_MARKER and Unity's
# verdict line on stdout, writes the FAKE_VARIANT reports (`pass` by default;
# `fail`, `skip`, `zero`, `malformed`, or `none` for no report) into
# REPORTS_DIR (else `reports/` under its cwd), and, when COVERAGE_DIR is set,
# the lcov there as `lcov.info` unless FAKE_NO_LCOV=1; with COVERAGE_DIR unset
# and FAKE_OWN_COVERAGE=1 it writes the lcov to its own `coverage/` under its
# cwd, as a Makefile given no directory does. It exits FAKE_EXIT (default 0).
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
if not coverage_dir and os.environ.get("FAKE_OWN_COVERAGE") == "1":
    coverage_dir = "coverage"
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

# The old result lines: `[crucible] <verb> -> '<key>': <p>/<t> passed, ...`.
_OWN_LINE = re.compile(r"-> '[^']*': \d+/\d+ passed, ")


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


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
