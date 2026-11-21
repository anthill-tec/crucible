"""The helpers of `test_python_client_sends_its_runners_reports.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import os
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

PYTHON_CLIENT = CLIENTS / "python-crucible.py"

TIMEOUT = 120

PROJECT_KEY = "python-sends-its-reports-key"

RUNS = "/api/v2/runs"

PARSED = "/api/v2/runs/parsed"

HEALTH = "/api/health"

START = "/api/v2/runs/start"

STREAM_CODEC = "crucible-events"

STREAM_FILE = "crucible-events.ndjson"

# The one case a unittest suite run's stream holds, as the runner's
# `test-end` states it.
TEST_END = {"event": "test-end",
            "id": "fake_module.FakeCase.test_adds_two_numbers",
            "name": "test_adds_two_numbers", "suite": "fake_module.FakeCase",
            "file": "tests/test_fake.py", "status": "pass", "duration_ms": 1}

# The report texts `auto-ingest` and the fake pytest file, byte for byte:
# what the ingest's `data` and `coverage.data` must carry.
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
#   * a suite run, bare or under `-m coverage run`, appends the
#     `CRUCIBLE_STREAM` it was handed to `streams.jsonl` beside it (taking it
#     out of its own environment, as `clients/subtest_runner.py` does),
#     prints OUTPUT_MARKER and exits FAKE_EXIT. Under pytest (`-m pytest ...
#     --junitxml=<file>`) it writes PYTEST_JUNIT_TEXT there (EMPTY_JUNIT_TEXT
#     under FAKE_ZERO=1, nothing under FAKE_REPORT=none, a directory where
#     the report should be under FAKE_REPORT=dir). Any other suite run is
#     unittest's runner: it writes no JUnit, and writes the stream to the
#     file `CRUCIBLE_STREAM` names -- one `run-start`, TEST_END, one
#     `run-end` (no `test-end` under FAKE_ZERO=1, nothing at all under
#     FAKE_REPORT=none). FAKE_ZERO_DISCOVERY=1 prints unittest's "Ran 0
#     tests", writes a stream with no `test-end` and exits 5.
_FAKE_PYTHON = r'''
import json
import os
import sys

EMPTY, PYTEST_JUNIT, LCOV, MARKER, TEST_END = ''' + repr((
    EMPTY_JUNIT_TEXT, PYTEST_JUNIT_TEXT, LCOV_TEXT, OUTPUT_MARKER, TEST_END)) + r'''
HERE = os.path.dirname(os.path.abspath(__file__))

def write(path, text):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)

def write_stream(path, cases):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for event in ([dict(event="run-start", total=len(cases))] + cases
                      + [dict(event="run-end", total=len(cases), passed=len(cases),
                              failed=0, pending=0, duration_ms=1)]):
            handle.write(json.dumps(event) + "\n")
            handle.flush()

argv = sys.argv[1:]
with open(os.path.join(HERE, "argv.jsonl"), "a") as handle:
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
handed = os.environ.pop("CRUCIBLE_STREAM", None)
with open(os.path.join(HERE, "streams.jsonl"), "a") as handle:
    handle.write(json.dumps({"runner": "pytest" if pytest else "unittest",
                             "stream": handed}) + "\n")
writes = os.environ.get("FAKE_REPORT") != "none"
stream = handed if (handed and not pytest and writes) else None
target = None
for arg in argv:
    if pytest and arg.startswith("--junitxml="):
        target = arg.split("=", 1)[1]
sys.stdout.write(MARKER + "\n")
sys.stdout.flush()
if os.environ.get("FAKE_ZERO_DISCOVERY") == "1":
    if stream:
        write_stream(stream, [])
    sys.stderr.write("\n" + "-" * 70 + "\nRan 0 tests in 0.000s\n\nNO TESTS RAN\n")
    sys.exit(5)
sys.stderr.write("test_adds_two_numbers (fake_module.FakeCase.test_adds_two_numbers)"
                 " ... ok\n")
if stream:
    write_stream(stream, [] if os.environ.get("FAKE_ZERO") == "1" else [TEST_END])
if target and os.environ.get("FAKE_REPORT") == "dir":
    os.makedirs(target, exist_ok=True)
elif target and writes:
    write(target, EMPTY if os.environ.get("FAKE_ZERO") == "1" else PYTEST_JUNIT)
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
'''


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


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

    def suite_runs(self, runner="unittest"):
        """The `CRUCIBLE_STREAM` each `runner` suite run was handed (None:
        none), in run order."""
        path = Path(self.project, "streams.jsonl")
        if not path.exists():
            return []
        return [entry["stream"] for entry in
                (json.loads(line) for line in path.read_text().splitlines() if line)
                if entry["runner"] == runner]

    def expected_stream(self):
        return os.path.realpath(os.path.join(self.project, "reports", STREAM_FILE))

    def assert_last_suite_run_was_handed_the_stream(self, result):
        """The last unittest suite run was told to write
        `<reports dir>/crucible-events.ndjson`."""
        runs = self.suite_runs()
        self.assertTrue(runs, f"a unittest suite ran; {self.diagnostics(result)}")  # type: ignore[attr-defined]
        handed = runs[-1] if runs else None
        self.assertEqual(  # type: ignore[attr-defined]
            os.path.realpath(os.path.join(self.project, handed)) if handed else None,
            self.expected_stream(),
            f"the runner is handed CRUCIBLE_STREAM=<reports dir>/{STREAM_FILE}; "
            f"{self.diagnostics(result)}")

    def data_batches(self):
        """Every stream batch that carried text."""
        return [body for _p, body in self.board.stream_posts()
                if isinstance(body, dict) and body.get("data")]

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


    def assert_stream_close_with_raw_and_exit(self, result, runner_exit=0):
        """A unittest run's one `POST /api/v2/runs` is its stream's close: the
        open run's `runId`, `codec: "crucible-events"`, no `data`, `raw` and
        `runnerExit`, after the relay sent the runner's stream to that run."""
        body = self.the_one_runs_ingest(result)
        self.assertEqual(body.get("codec"), STREAM_CODEC,  # type: ignore[attr-defined]
                         f"a unittest run closes its stream; body={body!r}")
        run_id = body.get("runId")
        self.assertIn(run_id, self.board.run_ids_opened(),  # type: ignore[attr-defined]
                      f"the close names the run the verb opened; body={body!r}")
        self.assertNotIn("data", body,  # type: ignore[attr-defined]
                         f"a stream close carries no report; body={body!r}")
        self.assertIn(OUTPUT_MARKER, body.get("raw") or "",  # type: ignore[attr-defined]
                      f"`raw` is the runner's captured output; body={body!r}")
        self.assertEqual(body.get("runnerExit"), runner_exit,  # type: ignore[attr-defined]
                         f"`runnerExit` is the runner's exit; body={body!r}")
        for key in ("summary", "tree"):
            self.assertNotIn(key, body,  # type: ignore[attr-defined]
                             f"the client sends no parse of its own; body={body!r}")
        self.assert_health_read_before_the_ingest(result)
        self.assert_last_suite_run_was_handed_the_stream(result)
        held = [json.loads(line) for line in
                self.board.held_stream(run_id).splitlines() if line.strip()]
        self.assertEqual(  # type: ignore[attr-defined]
            [event.get("event") for event in held], ["run-start", "test-end", "run-end"],
            f"the board holds the runner's stream, as written; held={held!r}")
        self.assertEqual([e for e in held if e.get("event") == "test-end"],  # type: ignore[attr-defined]
                         [TEST_END], f"held={held!r}")
        return body
