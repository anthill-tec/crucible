"""Shared fixtures for the python client's coverage-source and stale-data
tests: a scratch project with a real package, a second package its tests
import but never declare, its own tests, and a vendored module inside a
virtual environment under the project root; a driver that runs the REAL
`python-crucible.py` `main` in-process against the `RecordingBoard` double
with the repo's own interpreter and its real coverage.py; and the readers
the assertions need -- the coverage object the board stored, the envelope's
warnings, and the coverage run's command as the client printed it on stderr.

Every scratch project, board and environment change is undone by the
caller's `addCleanup`, so nothing leaks from one drive into the next.

Statement counts below were read off coverage.py's own `lcov` report of
these exact sources: a `def` line counts once, executed at import; its body
counts once per statement.
"""

import contextlib
import io
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import (  # noqa: E402
    RecordingBoard,
    install_project,
    load_client,
    load_toon,
    scrubbed_env,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"
CLIENT_PATH = REPO_ROOT / "clients" / "python-crucible.py"

AGENT = "coverage-config-fixture-agent"
PROJECT_KEY = "coverage-config-fixture-key"

UNDECLARED_CODE = "coverage-source-undeclared"
NO_REPORT_CODE = "no-test-reports"
ZERO_DISCOVERY_CODE = "no-tests-discovered"
LCOV_UNAVAILABLE = "coverage lcov unavailable"

# Environment variables that steer coverage.py from outside the project. A
# drive scrubs them, so the scratch project's own files are the only
# configuration in play (and an outer coverage run measuring THIS repo never
# leaks its own settings into the scratch run).
COVERAGE_ENV_KEYS = ("COVERAGE_RCFILE", "COVERAGE_FILE", "COVERAGE_PROCESS_START",
                     "COVERAGE_PROCESS_CONFIG", "COVERAGE_CORE", "PY_CRUCIBLE_PYTHON",
                     "WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                     "WORKFLOW_CYCLE", "REPORTS_DIR", "COVERAGE_DIR")

# The two verbs that run a coverage run, each with its own argv head.
VERBS = (
    ("regression --coverage", ("regression", "--coverage")),
    ("pre-merge-gate", ("pre-merge-gate",)),
)

# ── the scratch project's sources ──────────────────────────────────────────

# `double` is called by the tests, `triple` never is: four statements, three
# executed (both `def` lines and `double`'s body).
CORE_SOURCE = textwrap.dedent('''\
    def double(x):
        return x * 2


    def triple(x):
        return x * 3
    ''')
CORE_TOTAL, CORE_COVERED = 4, 3

# Imported and partly run by the tests, never declared as a source: five
# statements, three executed (both `def` lines and `helper`'s body).
EXTRA_SOURCE = textwrap.dedent('''\
    def helper(x):
        return x + 1


    def unused(x):
        y = x - 1
        return y
    ''')
EXTRA_TOTAL, EXTRA_COVERED = 5, 3

# Third-party code the tests import from a virtual environment that lives
# inside the project root: two statements, never to be measured.
VENDORED_SOURCE = textwrap.dedent('''\
    def shout(text):
        return text.upper()
    ''')

# The project's own tests: fifteen statements, every one executed.
TESTS_SOURCE = textwrap.dedent('''\
    import os
    import sys
    import unittest

    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, os.path.join(ROOT, "venv", "lib", "site-packages"))

    import vendored_helper  # noqa: E402
    from mypkg.core import double  # noqa: E402
    from otherpkg.extra import helper  # noqa: E402


    class CoreTest(unittest.TestCase):
        def test_double(self):
            self.assertEqual(double(2), 4)

        def test_helper(self):
            self.assertEqual(helper(1), 2)

        def test_vendored(self):
            self.assertEqual(vendored_helper.shout("a"), "A")
    ''')
TESTS_TOTAL = TESTS_COVERED = 15

FAILING_TEST_SOURCE = textwrap.dedent('''\
    import unittest


    class DeliberateFailureTest(unittest.TestCase):
        def test_fails_on_purpose(self):
            self.assertEqual(1, 2)
    ''')

# A script the tests run as a SUBPROCESS: four statements, every one executed
# in the child process, none in the test process itself.
TOOL_SOURCE = textwrap.dedent('''\
    import sys


    def main():
        sys.stdout.write("tool ran\\n")


    main()
    ''')
TOOL_TOTAL = TOOL_COVERED = 4

TOOL_TEST_SOURCE = textwrap.dedent('''\
    import os
    import subprocess
    import sys
    import unittest

    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


    class ToolTest(unittest.TestCase):
        def test_tool_runs_as_a_subprocess(self):
            result = subprocess.run(
                [sys.executable, os.path.join(ROOT, "scripts", "tool.py")],
                cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.stdout, "tool ran\\n", result.stderr)
    ''')


# A suite whose runner dies mid-test before writing any report: no JUnit XML,
# no "Ran 0 tests", no traceback -- the no-report shape.
DIES_TEST_SOURCE = textwrap.dedent('''\
    import os
    import unittest

    class DiesMidRunTest(unittest.TestCase):
        def test_the_runner_dies_before_any_report(self):
            os._exit(3)
    ''')

# A suite whose runner leaves a report holding zero results and exits
# non-zero -- the ran-nothing shape. The report goes where the runner was
# told to write its reports (`-o`).
RAN_NOTHING_TEST_SOURCE = textwrap.dedent('''\
    import os
    import sys
    import unittest

    def _reports_dir():
        argv = sys.argv
        for i, arg in enumerate(argv):
            if arg == "-o" and i + 1 < len(argv):
                return argv[i + 1]
        raise RuntimeError("no -o reports dir on " + repr(argv))

    class LeavesAnEmptyReportTest(unittest.TestCase):
        def test_the_runner_leaves_an_empty_report_and_exits_non_zero(self):
            path = os.path.join(_reports_dir(), "TEST-ran_nothing.Empty.xml")
            with open(path, "w") as f:
                f.write('<?xml version="1.0"?><testsuite name="ran_nothing.Empty" '
                        'tests="0" errors="0" failures="0" skipped="0">'
                        '</testsuite>')
            os._exit(3)
    ''')

# A suite that says it has started (by writing the file the environment
# names) and then blocks until the run is interrupted.
BLOCKING_TEST_SOURCE = textwrap.dedent('''\
    import os
    import time
    import unittest

    class BlocksUntilInterruptedTest(unittest.TestCase):
        def test_blocks_until_the_run_is_interrupted(self):
            with open(os.environ["COVERAGE_FIXTURE_STARTED"], "w") as f:
                f.write("started")
            time.sleep(60)
    ''')

def base_files():
    """The scratch project's sources, keyed by path relative to its root."""
    return {
        "mypkg/__init__.py": "",
        "mypkg/core.py": CORE_SOURCE,
        "otherpkg/__init__.py": "",
        "otherpkg/extra.py": EXTRA_SOURCE,
        "venv/pyvenv.cfg": "home = /usr/bin\ninclude-system-site-packages = false\n",
        "venv/lib/site-packages/vendored_helper.py": VENDORED_SOURCE,
        "tests/__init__.py": "",
        "tests/test_core.py": TESTS_SOURCE,
    }


def subprocess_files():
    """`base_files` plus a measured script the tests run as a subprocess."""
    files = base_files()
    files["scripts/tool.py"] = TOOL_SOURCE
    files["tests/test_tool.py"] = TOOL_TEST_SOURCE
    return files


# ── building and driving a project ─────────────────────────────────────────


def make_project(test, files, extra_files=None):
    """A fresh scratch project wired to a fresh `RecordingBoard`. `files` and
    `extra_files` map a root-relative path to its text. Returns
    `(project_dir, board)`; both are torn down by the test's cleanups."""
    project_dir = tempfile.mkdtemp(prefix="coverage-config-")
    test.addCleanup(shutil.rmtree, project_dir, ignore_errors=True)
    board = RecordingBoard()
    test.addCleanup(board.close)
    install_project(project_dir, board.url, PROJECT_KEY)
    for rel, text in {**files, **(extra_files or {})}.items():
        path = Path(project_dir, rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return project_dir, board


@contextlib.contextmanager
def scrubbed_coverage_env(extra=None):
    """`os.environ` without the outside coverage.py settings, plus `extra`,
    restored on exit -- the client copies `os.environ` for its runs."""
    saved = {key: os.environ.get(key) for key in COVERAGE_ENV_KEYS}
    saved.update({key: os.environ.get(key) for key in (extra or {})})
    try:
        for key in COVERAGE_ENV_KEYS:
            os.environ.pop(key, None)
        for key, value in (extra or {}).items():
            os.environ[key] = value
        yield
    finally:
        for key, old in saved.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old


class Drive:
    """One in-process `main()` run: exit code, stdout, stderr, the decoded
    envelope (None when stdout carried none) and the board it posted to."""

    def __init__(self, code, out, err, axi, board):
        self.code, self.out, self.err, self.axi, self.board = code, out, err, axi, board

    def describe(self):
        return f"exit={self.code} stdout={self.out!r} stderr={self.err!r}"


def drive(project_dir, board, verb_argv, *, start_dir="tests", python=None,
          extra_argv=(), env=None):
    """Run the real client's `main` for `verb_argv` against `project_dir`,
    with the repo's interpreter unless `python` names another."""
    module = load_client("python-crucible.py")
    toon = load_toon()
    argv = ["python-crucible.py", *verb_argv,
            "--start-dir", start_dir, "--pattern", "test_*.py",
            "--project-dir", project_dir, "--agent", AGENT,
            "--python", str(python or REAL_VENV_PYTHON), *extra_argv]
    stdout, stderr = io.StringIO(), io.StringIO()
    with scrubbed_coverage_env(env), mock.patch.object(sys, "argv", argv), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return Drive(code, stdout.getvalue(), stderr.getvalue(),
                 _decode_envelope(toon, stdout.getvalue()), board)

def _decode_envelope(toon, out):
    try:
        return toon.decode(out).get("axi") if out.strip() else None
    except Exception:  # an undecodable stdout is reported by the assertion that reads it
        return None

def drive_interrupted(test, project_dir, board, verb_argv, *, start_dir,
                      signum=signal.SIGTERM, start_timeout=60):
    """Run the real client as its OWN process for `verb_argv` against
    `project_dir`, whose suite under `start_dir` blocks once it has started
    (`BLOCKING_TEST_SOURCE`); send `signum` to the client once the suite says
    it has started, and collect what the client printed. Returns a `Drive`;
    `code` is the client's exit status."""
    scratch = tempfile.mkdtemp(prefix="coverage-config-interrupt-")
    test.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
    started = os.path.join(scratch, "started")
    with scrubbed_coverage_env():
        env = scrubbed_env(COVERAGE_FIXTURE_STARTED=started)
    cmd = [str(REAL_VENV_PYTHON), str(CLIENT_PATH), *verb_argv,
           "--start-dir", start_dir, "--pattern", "test_*.py",
           "--project-dir", project_dir, "--agent", AGENT,
           "--python", str(REAL_VENV_PYTHON)]
    err_path = os.path.join(scratch, "stderr")
    with open(err_path, "w") as err_file:
        proc = subprocess.Popen(cmd, cwd=project_dir, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=err_file)
        try:
            deadline = time.monotonic() + start_timeout
            while (not os.path.exists(started) and proc.poll() is None
                   and time.monotonic() < deadline):
                time.sleep(0.05)
            if os.path.exists(started) and proc.poll() is None:
                proc.send_signal(signum)
            try:
                out, _ = proc.communicate(timeout=60)
            except subprocess.TimeoutExpired:
                proc.kill()
                out, _ = proc.communicate(timeout=10)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
    err = Path(err_path).read_text(encoding="utf-8", errors="replace")
    if not os.path.exists(started):
        err = "[fixture] the blocking suite never started\n" + err
    return Drive(proc.returncode, out or "", err,
                 _decode_envelope(load_toon(), out or ""), board)


# ── readers ────────────────────────────────────────────────────────────────


def coverage_run_lines(err):
    """Every `[crucible] running:` line on stderr that is not the gate's
    py_compile step -- the suite's own command, and anything else the client
    announced as running."""
    return [line for line in err.splitlines()
            if line.startswith("[crucible] running:")
            and not line.startswith("[crucible] running: py_compile")]


def source_values(command_line):
    """Every `--source` value the printed command carries, in either the
    `--source X` or the `--source=X` spelling."""
    words = command_line.split()
    values = []
    for i, word in enumerate(words):
        if word == "--source" and i + 1 < len(words):
            values.append(words[i + 1])
        elif word.startswith("--source="):
            values.append(word[len("--source="):])
    return values


def ingested_coverage(board):
    """The coverage object of the last `/api/v2/runs/parsed` ingest, or None
    when the run ingested none (or never reached the parsed ingest)."""
    parsed = [body for path, body in board.posts() if path == "/api/v2/runs/parsed"]
    if not parsed or not isinstance(parsed[-1], dict):
        return None
    return parsed[-1].get("coverage")


def line_counts(coverage):
    """`(total, covered)` of a stored coverage object's lines, or None."""
    if not isinstance(coverage, dict):
        return None
    lines = coverage.get("lines") or {}
    return lines.get("total"), lines.get("covered")


def warnings_with_code(axi, code):
    return [w for w in ((axi or {}).get("warnings") or [])
            if isinstance(w, dict) and w.get("code") == code]


def write_starved_python(test):
    """A real interpreter that cannot import coverage.py: the repo's own
    interpreter re-exec'd with `-S -E`, so site-packages never reaches
    `sys.path`. Lives outside any scratch project, so it is never measured."""
    bin_dir = tempfile.mkdtemp(prefix="coverage-config-starved-")
    test.addCleanup(shutil.rmtree, bin_dir, ignore_errors=True)
    shim = Path(bin_dir, "starved-python")
    shim.write_text(
        f"#!{REAL_VENV_PYTHON}\n"
        "import os\n"
        "import sys\n"
        "os.execv(sys.executable, [sys.executable, '-S', '-E'] + sys.argv[1:])\n",
        encoding="utf-8")
    shim.chmod(0o755)
    return str(shim)


# ── an earlier run's parallel data ─────────────────────────────────────────

_PLANT_SCRIPT = textwrap.dedent('''\
    import importlib
    import sys

    import coverage

    data_file, root, module_name, func_name = sys.argv[1:5]
    sys.path.insert(0, root)
    cov = coverage.Coverage(data_file=data_file, data_suffix=True,
                            config_file=False, source=[root])
    cov.start()
    module = importlib.import_module(module_name)
    getattr(module, func_name)(1)
    cov.stop()
    cov.save()
    ''')


def plant_earlier_parallel_data(test, project_dir, data_file):
    """Leave the suffixed parallel data files an EARLIER coverage run would
    have left beside `data_file`: real coverage.py data, written by two
    separate processes measuring the project root, one running `triple` and
    one running `otherpkg.extra.unused` -- lines the second run never
    executes. Returns the planted paths."""
    script_dir = tempfile.mkdtemp(prefix="coverage-config-plant-")
    test.addCleanup(shutil.rmtree, script_dir, ignore_errors=True)
    script = Path(script_dir, "plant.py")
    script.write_text(_PLANT_SCRIPT, encoding="utf-8")
    os.makedirs(os.path.dirname(data_file), exist_ok=True)
    before = set(_parallel_files(data_file))
    with scrubbed_coverage_env():
        env = os.environ.copy()
    for module_name, func_name in (("mypkg.core", "triple"),
                                   ("otherpkg.extra", "unused")):
        result = subprocess.run(
            [str(REAL_VENV_PYTHON), str(script), data_file, project_dir,
             module_name, func_name],
            cwd=project_dir, env=env, capture_output=True, text=True)
        test.assertEqual(
            result.returncode, 0,
            f"fixture: planting an earlier run's parallel data failed: "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")
    planted = sorted(set(_parallel_files(data_file)) - before)
    test.assertEqual(
        len(planted), 2,
        f"fixture: expected two suffixed parallel data files beside "
        f"{data_file}; found {planted!r}")
    return planted


def _parallel_files(data_file):
    directory, base = os.path.split(data_file)
    if not os.path.isdir(directory):
        return []
    return [os.path.join(directory, name) for name in os.listdir(directory)
            if name.startswith(base + ".")]
