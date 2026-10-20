"""The python client's runner is a declaration of the PROJECT.

`[python] runner = "pytest"` (or `"unittest"`) in the project's own
`crucible.toml` chooses the runner. It is read from the project's file only:
an install-level `crucible.toml` is never consulted for it, and a project file
that is absent or does not parse declares nothing. `--runner <name>` on a
running verb overrides the declaration for that call. With neither, the runner
is `unittest`.

A value that is neither name -- given by `--runner` or declared in
`crucible.toml` -- is refused, and with `pytest` chosen an interpreter that
cannot import pytest is refused: each before anything is posted to the board
(before the run's opening heartbeat, and before the gate's check step), with
`ok: false`, exit 1, and a refusal naming the value and its source, or the
interpreter and that it needs pytest. `check` and `auto-ingest` take no
`--runner`. The shipped `crucible.toml` documents the key and declares no
value.

Every test drives the REAL entry point -- `clients/python-crucible.py` as an
OS subprocess -- against a scratch project whose own `crucible.toml` points
the client at a `RecordingBoard` on loopback; no live board is ever touched.
The interpreter the client is handed is a recording wrapper: it appends the
argv of every invocation to a log, then hands the call to a real interpreter.
The scratch project's one test writes, when its module is imported, which
runner imported it (`pytest` when pytest's own modules are loaded, else
`unittest`). So "unittest was chosen" is read from the test having run under
unittest through the client's unittest runner, and "pytest was chosen" from
the client having invoked the interpreter's `-m pytest` -- never from the
shape of pytest's full invocation.

Runner choice proofs need pytest importable by this suite's interpreter (it is
in the `[dev]` extras), and FAIL, never skip, when it is not. The interpreter
that cannot import pytest is a throwaway venv built in this module's own
setup, from the standard library's `venv` with no packages and no network.

Invocation:
    python3 -m unittest tests.client.test_python_runner_is_declared_by_the_project -v
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    SHIPPED_TOML,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
TIMEOUT = 120
AGENT = "runner-choice-fixture-agent"
PROJECT_KEY = "runner-choice-fixture-key"
BAD_VALUE = "nose2"
CALLS_VAR = "RUNNER_PROOF_CALLS"
MARKER_VAR = "RUNNER_PROOF_MARKER"
SUBTEST_RUNNER = "subtest_runner.py"

# The client's own resolution variables: a value inherited from the shell
# running this suite would silently decide the interpreter or the project.
_CLIENT_RESOLUTION_KEYS = ("PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR")

# The recording interpreter. `{real}` is the interpreter it hands every call
# to; the argv of every invocation is appended, one JSON list per line, to the
# file `$RUNNER_PROOF_CALLS` names.
_RECORDING_INTERPRETER = '''#!{real}
import json
import os
import sys

log = os.environ.get("RUNNER_PROOF_CALLS")
if log:
    with open(log, "a") as handle:
        handle.write(json.dumps(sys.argv[1:]) + "\\n")
os.execv({real!r}, [{real!r}, *sys.argv[1:]])
'''

# The scratch project's one test, collectable by both runners. Importing it
# records which runner imported it in the file `$RUNNER_PROOF_MARKER` names.
_PROBE_TEST = '''import os
import sys
import unittest

_marker = os.environ.get("RUNNER_PROOF_MARKER")
if _marker:
    with open(_marker, "a") as handle:
        handle.write(("pytest" if "_pytest" in sys.modules else "unittest") + "\\n")


class ProbeTest(unittest.TestCase):

    def test_probe_passes(self):
        self.assertEqual(1 + 1, 2)
'''


def _toml_string(value):
    # A JSON string literal is a valid TOML basic string for a plain value.
    return json.dumps(value)


def _config_text(board_url, runner=None, extra=""):
    """A whole `crucible.toml`, never a copy of the shipped file, so a
    `[python]` table the shipped file grows can never be duplicated here. The
    display limit is raised so a refusal naming a long scratch path is not cut
    before the words under test."""
    text = (f"[client]\nurl = {_toml_string(board_url)}\n\n"
            "[limits.truncate_field_chars]\nvalue = 4000\n")
    if runner is not None:
        text += f"\n[python]\nrunner = {_toml_string(runner)}\n"
    return text + extra


def _write_recording_interpreter(path, real):
    Path(path).write_text(_RECORDING_INTERPRETER.format(real=real))
    os.chmod(path, 0o700)
    return path


def _pytest_importable(python):
    probe = subprocess.run(
        [python, "-c",
         "import importlib.util, sys; "
         "sys.exit(0 if importlib.util.find_spec('pytest') else 3)"],
        capture_output=True, text=True, timeout=TIMEOUT, check=False)
    return probe.returncode == 0


class _RunnerCase(unittest.TestCase):
    """A scratch root holding the project (its `.env`, a `tests/` dir with the
    probe test), the recording interpreter, and the two logs it is read from."""

    def setUp(self):
        if importlib.util.find_spec("pytest") is None:
            self.fail("pytest must be importable by this suite's interpreter "
                      "(it is in the [dev] extras); these proofs need it")
        self.root = new_scratch("python-runner-choice-")
        self.project = os.path.join(self.root, "project")
        os.makedirs(os.path.join(self.project, "tests"))
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        Path(self.project, "tests", "test_probe.py").write_text(_PROBE_TEST)
        self.calls_log = os.path.join(self.root, "interpreter-calls.jsonl")
        self.marker = os.path.join(self.root, "imported-by.txt")
        self.python = _write_recording_interpreter(
            os.path.join(self.root, "recording_python"), sys.executable)
        self.board = RecordingBoard()

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def declare(self, runner=None, extra=""):
        Path(self.project, "crucible.toml").write_text(
            _config_text(self.board.url, runner, extra))

    def env(self):
        env = scrubbed_env(None, **{CALLS_VAR: self.calls_log, MARKER_VAR: self.marker})
        for key in _CLIENT_RESOLUTION_KEYS:
            env.pop(key, None)
        return env

    def drive(self, argv, client=None):
        cmd = [sys.executable, str(client or CLIENTS / "python-crucible.py"), *argv]
        return subprocess.run(cmd, cwd=self.project, env=self.env(),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def reset_logs(self):
        for path in (self.calls_log, self.marker):
            if os.path.exists(path):
                os.remove(path)

    def calls(self):
        if not os.path.exists(self.calls_log):
            return []
        with open(self.calls_log) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def imported_by(self):
        if not os.path.exists(self.marker):
            return []
        with open(self.marker) as handle:
            return [line.strip() for line in handle if line.strip()]

    @staticmethod
    def diag(result):
        return (f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
                f"stderr={result.stderr[-1500:]!r}")

    @staticmethod
    def envelope(stdout):
        try:
            decoded = TOON.decode(stdout)
        except ValueError:
            return None
        return decoded.get("axi") if isinstance(decoded, dict) else None

    def unittest_runs(self):
        return [c for c in self.calls()
                if any(os.path.basename(a) == SUBTEST_RUNNER for a in c)]

    def pytest_runs(self):
        return [c for c in self.calls()
                if any(c[i:i + 2] == ["-m", "pytest"] for i in range(len(c)))]

    def assert_unittest_chosen(self, result, label):
        diag = f"{label}: {self.diag(result)} calls={self.calls()!r}"
        self.assertEqual(len(self.unittest_runs()), 1,
                         f"exactly one run of the client's unittest runner; {diag}")
        self.assertEqual(self.pytest_runs(), [],
                         f"pytest must not run when unittest is chosen; {diag}")
        self.assertEqual(self.imported_by(), ["unittest"],
                         f"the project's test must run once, under unittest; {diag}")
        self.assertEqual(result.returncode, 0, diag)

    def assert_pytest_chosen(self, result, label):
        diag = f"{label}: {self.diag(result)} calls={self.calls()!r}"
        self.assertGreaterEqual(len(self.pytest_runs()), 1,
                                f"the interpreter must be invoked as `-m pytest`; {diag}")
        self.assertEqual(self.unittest_runs(), [],
                         f"the client's unittest runner must not run when pytest is "
                         f"chosen; {diag}")
        self.assertNotIn("unittest", self.imported_by(),
                         f"the project's test must not run under unittest; {diag}")


class TheProjectsDeclarationChoosesTheRunnerTest(_RunnerCase):

    def test_a_project_declaring_pytest_runs_pytest(self):
        self.declare("pytest")
        result = self.drive(["test", "--python", self.python,
                             "--project-dir", self.project])
        self.assert_pytest_chosen(result, "declared pytest")

    def test_a_project_declaring_unittest_runs_unittest(self):
        self.declare("unittest")
        result = self.drive(["test", "--python", self.python,
                             "--project-dir", self.project])
        self.assert_unittest_chosen(result, "declared unittest")

    def test_a_project_declaring_nothing_runs_unittest(self):
        self.declare()
        result = self.drive(["test", "--python", self.python,
                             "--project-dir", self.project])
        self.assert_unittest_chosen(result, "nothing declared")

    def test_a_project_file_that_does_not_parse_declares_nothing(self):
        """The board comes from an install copy this test owns, since the
        project's own file reads as nothing at all; its `[python]` table, written
        before the break, must not be half-read."""
        install = os.path.join(self.root, "install")
        shutil.copytree(CLIENTS, os.path.join(install, "clients"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        Path(install, "crucible.toml").write_text(_config_text(self.board.url))
        Path(self.project, "crucible.toml").write_text(
            '[python]\nrunner = "pytest"\n\nthis line is not toml\n')
        with (open(Path(self.project, "crucible.toml"), "rb") as handle,
              self.assertRaises(tomllib.TOMLDecodeError)):
            tomllib.load(handle)
        result = self.drive(["test", "--python", self.python,
                             "--project-dir", self.project],
                            client=os.path.join(install, "clients", "python-crucible.py"))
        self.assert_unittest_chosen(result, "unparseable project file")


class AnInstallLevelRunnerIsNeverReadTest(_RunnerCase):
    """The install's `crucible.toml` is the chain's fallback for `[client]`
    and `[limits]` when the project has no file of its own; `[python] runner`
    is read from the project's own file only. Driven from a copied install so
    the install-level file is one this test owns."""

    def _drive_from_install(self, install_runner, *extra_argv):
        install = os.path.join(self.root, "install")
        shutil.copytree(CLIENTS, os.path.join(install, "clients"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        Path(install, "crucible.toml").write_text(
            _config_text(self.board.url, install_runner))
        self.assertFalse(os.path.exists(os.path.join(self.project, "crucible.toml")),
                         "fixture: the project must declare nothing of its own")
        return self.drive(["test", "--python", self.python,
                           "--project-dir", self.project, *extra_argv],
                          client=os.path.join(install, "clients", "python-crucible.py"))

    def test_an_install_declaring_pytest_leaves_an_undeclared_project_on_unittest(self):
        result = self._drive_from_install("pytest")
        self.assert_unittest_chosen(result, "install-level pytest")

    def test_an_install_declaring_a_bad_value_is_neither_obeyed_nor_refused(self):
        result = self._drive_from_install(BAD_VALUE)
        self.assert_unittest_chosen(result, "install-level bad value")
        self.assertNotIn(BAD_VALUE, result.stdout,
                         f"an install-level value is never read: {self.diag(result)}")

    def test_the_flag_still_chooses_pytest_under_an_install_declaring_unittest(self):
        result = self._drive_from_install("unittest", "--runner", "pytest")
        self.assert_pytest_chosen(result, "flag pytest under install-level unittest")


class TheFlagOverridesTheDeclarationTest(_RunnerCase):

    def test_runner_unittest_on_a_pytest_declared_project_runs_unittest(self):
        self.declare("pytest")
        result = self.drive(["test", "--runner", "unittest", "--python", self.python,
                             "--project-dir", self.project])
        self.assert_unittest_chosen(result, "--runner unittest over declared pytest")

    def test_runner_pytest_on_an_undeclared_project_runs_pytest(self):
        self.declare()
        result = self.drive(["test", "--runner", "pytest", "--python", self.python,
                             "--project-dir", self.project])
        self.assert_pytest_chosen(result, "--runner pytest, nothing declared")

    def test_runner_pytest_on_a_unittest_declared_project_runs_pytest(self):
        self.declare("unittest")
        result = self.drive(["test", "--runner", "pytest", "--python", self.python,
                             "--project-dir", self.project])
        self.assert_pytest_chosen(result, "--runner pytest over declared unittest")

    def test_regression_runner_unittest_on_a_pytest_declared_project_runs_unittest(self):
        self.declare("pytest")
        result = self.drive(["regression", "--agent", AGENT, "--runner", "unittest",
                             "--python", self.python, "--project-dir", self.project,
                             "--reports", "reports"])
        self.assert_unittest_chosen(result, "regression --runner unittest over declared pytest")


class _RefusalCase(_RunnerCase):
    """Each verb that refuses, as one argv per verb. `--agent` is given on
    every one, so a refusal that came after the run's opening heartbeat or its
    identity would show on the board."""

    def verbs(self, python, *extra):
        common = ["--agent", AGENT, "--python", python,
                  "--project-dir", self.project, "--reports", "reports", *extra]
        return {
            "test": ["test", *common],
            "regression": ["regression", *common],
            "pre-merge-gate": ["pre-merge-gate", *common],
        }

    def assert_refused(self, result, names, label, posts_before=0):
        out = result.stdout
        diag = f"{label}: {self.diag(result)} calls={self.calls()!r}"
        for name in names:
            self.assertIn(name, out, f"{label}: the refusal must name {name!r}; {diag}")
        axi = self.envelope(out)
        if axi is None:
            self.fail(f"{label}: stdout must be one AXI envelope; {diag}")
        self.assertIs(axi.get("ok"), False, diag)
        self.assertEqual(result.returncode, 1, diag)
        posts = self.board.posts()[posts_before:]
        self.assertEqual(posts, [],
                         f"{label}: nothing may be posted to the board; got {posts!r}")
        self.assertEqual(self.imported_by(), [],
                         f"{label}: no test may run; {diag}")
        self.assertEqual(self.unittest_runs(), [],
                         f"{label}: the unittest runner must never start; {diag}")
        compiles = [c for c in self.calls() if "py_compile" in c]
        self.assertEqual(compiles, [],
                         f"{label}: the gate's check step must not run; {diag}")

    def refuse_on_every_verb(self, python, names, *extra):
        for verb, argv in self.verbs(python, *extra).items():
            with self.subTest(verb=verb):
                self.reset_logs()
                before = len(self.board.posts())
                result = self.drive(argv)
                self.assert_refused(result, names, verb, posts_before=before)


class ARunnerThatIsNeitherNameIsRefusedBeforeTheBoardTest(_RefusalCase):

    def test_a_flag_value_that_is_neither_name_is_refused_naming_it_and_the_flag(self):
        self.declare()
        self.refuse_on_every_verb(self.python, [BAD_VALUE, "--runner"],
                                  "--runner", BAD_VALUE)

    def test_a_flag_value_that_is_neither_name_is_refused_over_a_valid_declaration(self):
        self.declare("pytest")
        self.refuse_on_every_verb(self.python, [BAD_VALUE, "--runner"],
                                  "--runner", BAD_VALUE)

    def test_a_declared_value_that_is_neither_name_is_refused_naming_it_and_the_file(self):
        self.declare(BAD_VALUE)
        self.refuse_on_every_verb(self.python, [BAD_VALUE, "crucible.toml"])


class AnInterpreterWithoutPytestIsRefusedBeforeTheBoardTest(_RefusalCase):
    """A throwaway venv, built from the standard library's `venv` with no
    packages, is an interpreter that provably cannot import pytest. The client
    is handed a recording wrapper around it, so the refusal names the
    interpreter the client was given."""

    @classmethod
    def setUpClass(cls):
        cls.venv_root = new_scratch("python-runner-no-pytest-venv-")
        built = subprocess.run(
            [sys.executable, "-m", "venv", "--without-pip",
             os.path.join(cls.venv_root, "venv")],
            capture_output=True, text=True, timeout=TIMEOUT, check=False)
        if built.returncode != 0:
            raise RuntimeError(f"could not build the pytest-less venv: {built.stderr[-1500:]!r}")
        cls.bare_python = os.path.join(cls.venv_root, "venv", "bin", "python")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.venv_root, ignore_errors=True)

    def setUp(self):
        super().setUp()
        self.assertFalse(_pytest_importable(self.bare_python),
                         "fixture: the throwaway venv must not import pytest")
        self.no_pytest_python = _write_recording_interpreter(
            os.path.join(self.root, "no_pytest_python"), self.bare_python)
        self.assertFalse(_pytest_importable(self.no_pytest_python),
                         "fixture: the recording wrapper must not import pytest")

    def test_a_declared_pytest_with_an_interpreter_that_cannot_import_it_is_refused(self):
        self.declare("pytest")
        self.refuse_on_every_verb(self.no_pytest_python,
                                  [self.no_pytest_python, "pytest"])

    def test_a_flag_pytest_with_an_interpreter_that_cannot_import_it_is_refused(self):
        self.declare()
        self.refuse_on_every_verb(self.no_pytest_python,
                                  [self.no_pytest_python, "pytest"],
                                  "--runner", "pytest")

    def test_the_same_interpreter_is_not_refused_when_unittest_is_chosen(self):
        """Only a pytest choice needs pytest: with `--runner unittest` the same
        pytest-less interpreter is handed the unittest runner, never refused."""
        self.declare("pytest")
        result = self.drive(["test", "--runner", "unittest", "--python",
                             self.no_pytest_python, "--project-dir", self.project])
        self.assertEqual(len(self.unittest_runs()), 1,
                         f"the unittest runner must start; {self.diag(result)} "
                         f"calls={self.calls()!r}")


class CheckAndAutoIngestTakeNoRunnerTest(_RunnerCase):

    def test_check_and_auto_ingest_reject_a_runner_flag(self):
        self.declare()
        for verb, argv in (("check", ["check", "--python", self.python]),
                           ("auto-ingest", ["auto-ingest", "--agent", AGENT])):
            with self.subTest(verb=verb):
                result = self.drive([*argv, "--runner", "pytest",
                                     "--project-dir", self.project])
                self.assertEqual(result.returncode, 2, self.diag(result))
                self.assertIn("unrecognized arguments: --runner", result.stderr,
                              self.diag(result))
                self.assertEqual(self.board.posts(), [], self.diag(result))

    def test_check_and_auto_ingest_help_name_no_runner(self):
        for verb in ("check", "auto-ingest"):
            with self.subTest(verb=verb):
                result = self.drive([verb, "--help"])
                self.assertEqual(result.returncode, 0, self.diag(result))
                self.assertIn("--project-dir", result.stdout, self.diag(result))
                self.assertNotIn("--runner", result.stdout, self.diag(result))


class TheShippedConfigDocumentsTheRunnerKeyTest(unittest.TestCase):
    """The shipped `crucible.toml` documents `[python] runner` and declares no
    value, so an install that copies it makes no runner anyone's default."""

    def test_the_shipped_file_carries_a_python_table_that_declares_no_runner(self):
        with open(SHIPPED_TOML, "rb") as handle:
            parsed = tomllib.load(handle)
        self.assertIsInstance(parsed.get("python"), dict,
                              "the shipped crucible.toml must carry a [python] table")
        self.assertNotIn("runner", parsed["python"],
                         "the shipped crucible.toml must declare no runner value")

    def test_the_shipped_file_documents_the_runner_key_in_a_comment(self):
        documented = [line for line in SHIPPED_TOML.read_text().splitlines()
                      if line.lstrip().startswith("#") and "runner" in line
                      and "pytest" in line]
        self.assertGreaterEqual(
            len(documented), 1,
            "the shipped crucible.toml must document `runner` with `pytest` in a comment")


if __name__ == "__main__":
    unittest.main()
