"""A client's `regression` measures coverage only when `--coverage` is given:
the switch is declared once for the fleet, and a coverage-only flag given
without it is refused.

  * The help — bun's, python's and arduino's `regression --help` document
    `--coverage` with one shared sentence, which says the run is
    coverage-free without it; each still names its own stack's coverage tool.

  * The refusal — python's `regression --cov-source X` without `--coverage`
    is the typed `coverage-flag-refused` hard stop, the verb's first act: one
    `ok:false` envelope whose `error` names `--cov-source` and that it applies
    only with `--coverage`, whose `help[]` says to add `--coverage` or drop
    the flag, a non-zero exit, no request of any kind to the board, nothing
    written into the project, and the interpreter never launched. Each case
    runs with `--agent` and no `--cycle` against a board reporting an active
    cycle, so a check placed after the board is consulted would surface as a
    request, or as the unattributed-run refusal instead.

  * The guards — `regression --coverage --cov-source X` still runs under
    coverage.py measuring X and files its coverage; and bun's, python's and
    arduino's `regression` without `--coverage` file a `regression` run whose
    ingest body carries no `coverage` key.

Every case drives the real client as a subprocess over a scratch project in
the temp directory, steered only by that project's own `crucible.toml`
`[client] url` and `--project-dir`. The runners are stand-ins: a recording
python interpreter (every launch appends its argv to a record file), the
harness's fake `bun`, and a native Makefile running the harness's fake Unity
binaries.

Invocation:
    python3 -m unittest tests.client.test_regression_coverage_is_one_shared_opt_in_switch -v
"""

import http.server
import json
import os
import re
import stat
import subprocess
import sys
import threading
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    INGEST_PATHS,
    START,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
    write_fake_bun,
    write_fake_native,
)

TOON = load_toon()
TIMEOUT = 120

REFUSED_CODE = "coverage-flag-refused"
UNATTRIBUTED_CODE = "unattributed-run-refused"
COV_SOURCE = "pkg_under_measure"

# Keys that would let the shell running this suite identify or narrow the
# client's run.
_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "AGENT_ID",
             "TESTS", "TEST_NAME")

#: Each client whose `regression` already declares `--coverage`, and the
#: coverage tool its help names.
HELP_CLIENTS = (
    ("bun-crucible.py", "lcov"),
    ("python-crucible.py", "coverage.py"),
    ("arduino-crucible.py", "lcov"),
)

# The recording stand-in for the project's python interpreter. Every launch
# appends its argv to `interpreter_runs.jsonl` beside it; a suite run (`-o
# <reports dir>`) writes one passing JUnit case there; `coverage lcov -o
# <file>` writes a small lcov; everything else exits 0.
_RECORDING_PYTHON = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "interpreter_runs.jsonl"), "a") as handle:
    handle.write(json.dumps(argv) + "\n")
out = argv[argv.index("-o") + 1] if "-o" in argv[:-1] else None
if out and "lcov" in argv:
    with open(out, "w") as handle:
        handle.write("SF:pkg_under_measure/mod.py\nFNF:2\nFNH:1\n"
                     "LF:10\nLH:8\nend_of_record\n")
    sys.exit(0)
if out:
    sys.stderr.write("test_case_1 (fake_module.FakeCase.test_case_1) ... ok\n")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "TEST-fake_module.FakeCase.xml"), "w") as handle:
        handle.write('<?xml version="1.0" encoding="UTF-8"?>\n<testsuite '
                     'name="fake_module.FakeCase" tests="1" errors="0" '
                     'failures="0" skipped="0"><testcase '
                     'classname="fake_module.FakeCase" name="test_case_1" '
                     'time="0.001"></testcase></testsuite>\n')
sys.exit(0)
'''


def _envelope_count(stdout):
    return len(re.findall(r"(?m)^axi:", stdout or ""))


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def _diagnostics(result):
    return (f"exit={result.returncode} stdout={(result.stdout or '')[:1500]!r} "
            f"stderr={(result.stderr or '')[-2000:]!r}")


def _plain(text):
    """Lower-cased, backticks dropped, whitespace collapsed."""
    return " ".join(str(text).replace("`", "").lower().split())


def _client_env(**extra):
    env = scrubbed_env(**extra)
    for key in _SCRUBBED:
        env.pop(key, None)
    return env


def _tree(project):
    """Every path under the project, relative to it."""
    return sorted(str(p.relative_to(project)) for p in Path(project).rglob("*"))


class ActiveCycleBoard:
    """A loopback stand-in board that records EVERY request (GET and POST)
    and answers that the project has one active cycle while the agent asking
    is bound to none — the board state that makes an unbound run with no
    `--cycle` the unattributed-run refusal."""

    ACTIVE_CYCLE_ID = 4242

    def __init__(self):
        self.requests = []
        self._lock = threading.Lock()
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _reply(self, payload):
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                with board._lock:
                    board.requests.append(("GET", self.path))
                if "/plans" in self.path:
                    self._reply({"ok": True, "plans": [{
                        "id": 1, "status": "open",
                        "cycles": [{"id": board.ACTIVE_CYCLE_ID,
                                    "status": "active"}]}]})
                elif "/agents" in self.path:
                    self._reply({"ok": True, "agents": []})
                else:
                    self._reply({"ok": True})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                with board._lock:
                    board.requests.append(("POST", self.path))
                if self.path == START:
                    self._reply({"ok": True, "changed": True,
                                 "runId": "run-active-cycle-1"})
                else:
                    self._reply({"ok": True, "changed": True})

            def do_PATCH(self):
                self.do_POST()

            def log_message(self, format, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    def seen(self):
        with self._lock:
            return list(self.requests)

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


class _PythonProject:
    """A scratch python project whose interpreter is the recording stand-in,
    driven through the real `python-crucible.py`."""

    def make_project(self, board_url, project_key):
        self.project = new_scratch("regression-coverage-python-")
        Path(self.project, "fake_python.py").write_text(
            f"#!{sys.executable}\n" + _RECORDING_PYTHON)
        os.chmod(Path(self.project, "fake_python.py"),
                 stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
        install_project(self.project, board_url, project_key)

    def drive(self, *extra, agent):
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), "regression",
               "--agent", agent, "--project-dir", self.project,
               "--python", str(Path(self.project, "fake_python.py")), *extra]
        return subprocess.run(cmd, cwd=self.project, env=_client_env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def interpreter_runs(self):
        """Every argv the recording interpreter was launched with, in order."""
        path = Path(self.project, "interpreter_runs.jsonl")
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()
                if line.strip()]


# ── the shared `--coverage` sentence ────────────────────────────────────────

def _coverage_help(client):
    """The `--coverage` option's help text in `<client> regression --help`,
    whitespace-collapsed, or None when the option is not listed."""
    project = new_scratch("regression-coverage-help-")
    result = subprocess.run(
        [sys.executable, str(CLIENTS / client), "regression", "--help"],
        cwd=project, env=_client_env(COLUMNS="200", NO_COLOR="1",
                                     PYTHON_COLORS="0"),
        capture_output=True, text=True, timeout=TIMEOUT, check=False)
    lines = (result.stdout or "").splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^\s{2,}--coverage(?=\s|$)(.*)$", line)
        if not match:
            continue
        text = [match.group(1)]
        for follow in lines[index + 1:]:
            if not follow.strip() or re.match(r"^\s{2,6}-", follow):
                break
            text.append(follow)
        return result, " ".join(" ".join(text).split())
    return result, None


def _coverage_free_clause(help_text):
    """The clause of a help text that says the run is coverage-free — the
    text between clause separators that holds `coverage-free`."""
    for clause in re.split(r"[.;:,\u2014()]", help_text or ""):
        if "coverage-free" in clause.lower():
            return " ".join(clause.split())
    return None


class RegressionCoverageHelpIsOneSharedSentenceTest(unittest.TestCase):
    """bun's, python's and arduino's `regression --help` list `--coverage`
    with the fleet's one sentence."""

    @classmethod
    def setUpClass(cls):
        cls.helps = {client: _coverage_help(client) for client, _ in HELP_CLIENTS}

    def test_each_regression_help_lists_coverage_saying_the_run_is_coverage_free_without_it(self):
        for client, _ in HELP_CLIENTS:
            with self.subTest(client=client):
                result, text = self.helps[client]
                self.assertEqual(result.returncode, 0, _diagnostics(result))
                self.assertIsNotNone(
                    text, f"{client} regression --help lists --coverage; "
                          f"{_diagnostics(result)}")
                self.assertIn(
                    "coverage-free", (text or "").lower(),
                    f"{client}'s --coverage help says the run is coverage-free "
                    f"without it; help={text!r}")
                self.assertIn(
                    "without it", (text or "").lower(),
                    f"{client}'s --coverage help says what the run is without "
                    f"it; help={text!r}")

    def test_bun_python_and_arduino_regression_share_one_coverage_sentence(self):
        clauses = {client: _coverage_free_clause(self.helps[client][1])
                   for client, _ in HELP_CLIENTS}
        self.assertNotIn(
            None, clauses.values(),
            f"each client's --coverage help carries the coverage-free sentence; "
            f"helps={ {c: self.helps[c][1] for c, _ in HELP_CLIENTS}!r}")
        self.assertEqual(
            len(set(clauses.values())), 1,
            f"the three clients state the coverage-free sentence identically, "
            f"from one shared declaration; clauses={clauses!r}")

    def test_guard_each_regression_coverage_help_names_its_stacks_coverage_tool(self):
        """GUARD — holds today: the shared sentence comes with the stack's own
        coverage tool named."""
        for client, tool in HELP_CLIENTS:
            with self.subTest(client=client):
                result, text = self.helps[client]
                self.assertIn(
                    tool, text or "",
                    f"{client}'s --coverage help names {tool}; "
                    f"{_diagnostics(result)}")


# ── python's `--cov-source` without `--coverage` is refused ─────────────────

class PythonCovSourceWithoutCoverageIsRefusedTest(_PythonProject,
                                                   unittest.TestCase):
    """`regression --cov-source X` without `--coverage` is the typed
    `coverage-flag-refused` hard stop, decided before anything else."""

    def setUp(self):
        self.board = ActiveCycleBoard()
        self.addCleanup(self.board.close)
        # The project key must not spell the refusal's code: the envelope's
        # context carries it, and the code is looked for in both streams.
        self.make_project(self.board.url, "python-cov-source-alone")

    def test_cov_source_without_coverage_is_refused_before_anything_runs(self):
        before = _tree(self.project)
        result = self.drive("--cov-source", COV_SOURCE,
                            agent="py-cov-source-refused")
        streams = (result.stdout or "") + (result.stderr or "")
        self.assertIn(
            REFUSED_CODE, streams,
            f"--cov-source without --coverage is the typed {REFUSED_CODE} hard "
            f"stop; {_diagnostics(result)}")
        self.assertNotIn(
            UNATTRIBUTED_CODE, streams,
            f"the coverage-flag refusal is the verb's first act, ahead of the "
            f"unattributed-run refusal; {_diagnostics(result)}")
        self.assertEqual(_envelope_count(result.stdout), 1,
                         f"exactly one envelope; {_diagnostics(result)}")
        envelope = _envelope(result.stdout) or {}
        self.assertEqual(
            (envelope.get("verb"), envelope.get("ok")), ("regression", False),
            f"an ok:false regression envelope; envelope={envelope!r}")
        error = _plain(envelope.get("error") or "")
        self.assertIn("--cov-source", error,
                      f"error names the refused flag; envelope={envelope!r}")
        self.assertIn("only with --coverage", error,
                      f"error says the flag applies only with --coverage; "
                      f"envelope={envelope!r}")
        help_steps = envelope.get("help")
        self.assertIsInstance(help_steps, list,
                              f"the refusal states help[]; envelope={envelope!r}")
        help_text = _plain(" ".join(str(h) for h in (help_steps or [])))
        self.assertIn("add --coverage", help_text,
                      f"help[] says to add --coverage; help={help_steps!r}")
        self.assertIn("drop", help_text,
                      f"help[] says to drop the flag; help={help_steps!r}")
        self.assertNotEqual(result.returncode, 0,
                            f"a refusal exits non-zero; {_diagnostics(result)}")
        self.assertEqual(
            self.board.seen(), [],
            f"refused before anything reaches the board — no GET, no "
            f"heartbeat, no run start, no ingest; {_diagnostics(result)}")
        self.assertEqual(
            self.interpreter_runs(), [],
            f"the interpreter is never launched; {_diagnostics(result)}")
        self.assertEqual(
            _tree(self.project), before,
            f"nothing is written into the project — no lock, no reports; "
            f"{_diagnostics(result)}")

    def test_guard_a_plain_regression_on_this_board_is_the_unattributed_refusal(self):
        """GUARD — the stand-in's active cycle is what makes the refusal
        ordering observable: a `regression` with no `--cycle` against it is
        the unattributed-run refusal, and the interpreter never runs."""
        result = self.drive(agent="py-cov-source-guard")
        self.assertIn(UNATTRIBUTED_CODE, result.stderr,
                      f"an unbound run with no --cycle while cycle "
                      f"{ActiveCycleBoard.ACTIVE_CYCLE_ID} is active is "
                      f"refused; {_diagnostics(result)}")
        self.assertNotEqual(result.returncode, 0, _diagnostics(result))
        self.assertEqual(self.interpreter_runs(), [], _diagnostics(result))


def _the_one_ingest(testcase, board, result):
    ingests = [(p, b) for p, b in board.posts() if p in INGEST_PATHS]
    testcase.assertEqual(
        len(ingests), 1,
        f"exactly one ingest; paths={[p for p, _ in board.posts()]!r} "
        f"{_diagnostics(result)}")
    return ingests[0] if ingests else (None, {})


class PythonCovSourceWithCoverageRunsTest(_PythonProject, unittest.TestCase):
    """GUARD — `regression --coverage --cov-source X` runs under coverage.py
    measuring X and files the run's coverage."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.make_project(self.board.url, "python-coverage-with-source")

    def test_guard_cov_source_with_coverage_measures_that_source_and_files_coverage(self):
        result = self.drive("--coverage", "--cov-source", COV_SOURCE,
                            agent="py-cov-source-with-coverage")
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        self.assertNotIn(REFUSED_CODE, (result.stdout or "") + (result.stderr or ""),
                         _diagnostics(result))
        suite_runs = [argv for argv in self.interpreter_runs()
                      if argv[:3] == ["-m", "coverage", "run"]]
        self.assertEqual(
            len(suite_runs), 1,
            f"the suite runs once under `coverage run`; "
            f"runs={self.interpreter_runs()!r} {_diagnostics(result)}")
        self.assertEqual(
            (suite_runs[0][3:5] if suite_runs else None),
            ["--source", COV_SOURCE],
            f"coverage measures the --cov-source given; runs={suite_runs!r}")
        path, body = _the_one_ingest(self, self.board, result)
        self.assertEqual(path, "/api/v2/runs/parsed", _diagnostics(result))
        coverage = (body or {}).get("coverage") or {}
        self.assertEqual(
            (coverage.get("lines") or {}).get("total"), 10,
            f"the ingest carries the run's lcov coverage; body={body!r}")
        self.assertEqual((body or {}).get("tier"), "regression",
                         f"body={body!r}")


# ── `regression` without `--coverage` files no coverage ─────────────────────

class RegressionWithoutCoverageFilesNoCoverageTest(unittest.TestCase):
    """GUARD — holds today: bun's, python's and arduino's `regression` without
    `--coverage` file a `regression` run whose ingest body has no `coverage`
    key."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)

    def _assert_no_coverage(self, result):
        self.assertEqual(result.returncode, 0, _diagnostics(result))
        _, body = _the_one_ingest(self, self.board, result)
        body = body or {}
        self.assertEqual(body.get("tier"), "regression",
                         f"a regression run is filed; body={body!r}")
        self.assertNotIn("coverage", body,
                         f"no coverage without --coverage; body={body!r}")

    def test_guard_bun_regression_without_coverage_files_no_coverage(self):
        project = new_scratch("regression-coverage-bun-")
        install_project(project, self.board.url, "bun-regression-no-coverage")
        fake = write_fake_bun(project, 1)
        result = subprocess.run(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "regression",
             "--agent", "bun-regression-no-coverage", "--bun", fake,
             "--project-dir", project, "--package-dir", project,
             "--reports", "reports"],
            cwd=project, env=_client_env(FAKE_TOTAL="1"),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)
        self._assert_no_coverage(result)

    def test_guard_python_regression_without_coverage_files_no_coverage(self):
        driver = _PythonProject()
        driver.make_project(self.board.url, "python-regression-no-coverage")
        result = driver.drive(agent="py-regression-no-coverage")
        self._assert_no_coverage(result)
        self.assertFalse(
            any(argv[:2] == ["-m", "coverage"] for argv in driver.interpreter_runs()),
            f"coverage.py never runs; runs={driver.interpreter_runs()!r}")

    def test_guard_arduino_regression_without_coverage_files_no_coverage(self):
        project = new_scratch("regression-coverage-arduino-")
        install_project(project, self.board.url, "arduino-regression-no-coverage",
                        "arduino-regression-no-coverage-project")
        write_fake_native(project)
        result = subprocess.run(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "regression",
             "--agent", "ard-regression-no-coverage", "--dir", "tests/native",
             "--project-dir", project, "--reports", "reports"],
            cwd=project, env=_client_env(FAKE_TOTAL="1"),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)
        self._assert_no_coverage(result)


if __name__ == "__main__":
    unittest.main()
