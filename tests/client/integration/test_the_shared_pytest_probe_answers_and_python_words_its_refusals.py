"""The shared pytest probe answers on real interpreters, python words its
pytest refusals as it always has, and a unittest run's exit 3 or 4 is never
read as pytest failing as a runner.

The run module (`clients/_crucible_run.py`, reached through the core every
client loads) holds the one pytest import probe, `pytest_importable(python,
cwd)`: it runs `[python, "-c", "import pytest"]` in `cwd` and answers

* True for an interpreter that imports pytest (this suite's own, which has
  the `[dev]` extras);
* False for one that cannot (a scratch venv built `--without-pip`) or that
  cannot be started at all;
* None for one that does not answer within the run module's
  `PYTEST_PROBE_TIMEOUT_S` (a stub interpreter that sleeps past it; the
  timeout is patched small on the run module and restored afterwards).

The python client refuses a pytest choice it cannot run, before anything
reaches the board, in the words it has always used:

* an interpreter that cannot import pytest is refused naming the runner's
  source (`(from <source>)`), the interpreter, and the remedy;
* an interpreter whose probe does not answer in time is refused naming the
  interpreter and the timeout the probe actually used -- the run module's.

A unittest run whose runner exits 3 or 4 is filed as any other unittest run
that streamed its tests: the run is closed on `/api/v2/runs` from its
runner's `crucible-events` stream, with that exit as `runnerExit`, and no
compile record is filed. Exits 3 and 4 mean "failed as a runner" only to
pytest. Both running verbs are driven -- `test` and `regression`, each with
an agent (a unittest run without one files nothing).

The probe and the refusals are driven in-process on the client and core
loaded from the suite's test install; the unittest run drives the REAL
`clients/python-crucible.py` as an OS subprocess, filing to a
`RecordingBoard` on loopback named by its scratch project's own
`crucible.toml`. Every interpreter here is real: this suite's own, a scratch
venv, or an executable stub written into a temp dir the test removes.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_shared_pytest_probe_answers_and_python_words_its_refusals
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests.client import load_client
from tests.client.live_run_harness import CLIENTS, scrubbed_env
from tests.client.pytest_project_harness import (
    _INHERITED_KEYS,
    COMPILE,
    ScratchProject,
    diag,
    envelope,
    streamed_leaves,
)

# The probe timeout the run module is patched to, and how long the slow stub
# interpreter sleeps: long enough to outlast the patched timeout, short
# enough that a probe which waits it out still returns in seconds.
PATCHED_PROBE_TIMEOUT_S = 1
SLOW_STUB_SLEEP_S = 4

VENV_BUILD_TIMEOUT = 120
CLIENT_RUN_TIMEOUT = 120


def _scratch_dir(case, prefix):
    """A temp dir removed when `case` finishes."""
    path = tempfile.mkdtemp(prefix=prefix)
    case.addCleanup(shutil.rmtree, path, ignore_errors=True)
    return path


def _write_executable(path, text):
    Path(path).write_text(text, encoding="utf-8")
    os.chmod(path, 0o700)
    return str(path)


def _pytestless_python(case):
    """The interpreter of a scratch venv built `--without-pip`, which provably
    cannot import pytest; the venv is removed when `case` finishes."""
    root = _scratch_dir(case, "pytest-probe-bare-venv-")
    venv_dir = os.path.join(root, "venv")
    built = subprocess.run([sys.executable, "-m", "venv", "--without-pip", venv_dir],
                           capture_output=True, text=True,
                           timeout=VENV_BUILD_TIMEOUT, check=False)
    if built.returncode != 0:
        raise RuntimeError(f"could not build the pytest-less venv: "
                           f"{built.stderr[-1500:]!r}")
    return os.path.join(venv_dir, "bin", "python")


def _slow_python(case):
    """An executable stub interpreter that answers nothing for
    `SLOW_STUB_SLEEP_S` seconds, then exits 0 (which a probe that waited it
    out would read as "imports pytest")."""
    root = _scratch_dir(case, "pytest-probe-slow-stub-")
    return _write_executable(os.path.join(root, "slow_python"),
                             f"#!/bin/sh\nexec sleep {SLOW_STUB_SLEEP_S}\n")


_RECORDING_INTERPRETER = '''#!{real}
import json
import os
import sys

with open({log!r}, "w") as handle:
    json.dump({{"argv": sys.argv[1:], "cwd": os.getcwd()}}, handle)
os.execv({real!r}, [{real!r}, *sys.argv[1:]])
'''


def _run_module_of(core):
    """The run module `core` loaded (the one its pytest probe is defined in),
    asserted to be the module the core's `pytest_importable` comes from."""
    run_module = core._RUN
    if run_module.pytest_importable is not core.pytest_importable:
        raise AssertionError("the core's pytest_importable must be the run module's")
    return run_module


class TheSharedPytestProbeAnswersOnRealInterpretersTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.core = load_client("_crucible_axi.py")
        cls.run_module = _run_module_of(cls.core)

    def setUp(self):
        self.cwd = _scratch_dir(self, "pytest-probe-cwd-")

    def test_the_probe_answers_true_for_the_interpreter_running_this_suite(self):
        self.assertIs(self.run_module.pytest_importable(sys.executable, self.cwd), True)

    def test_the_probe_answers_false_for_a_venv_built_without_pip(self):
        bare = _pytestless_python(self)
        self.assertIs(self.run_module.pytest_importable(bare, self.cwd), False)

    def test_the_probe_answers_false_for_an_interpreter_that_cannot_be_started(self):
        missing = os.path.join(self.cwd, "no_such_python")
        self.assertIs(self.run_module.pytest_importable(missing, self.cwd), False)

    def test_the_probe_answers_none_when_the_interpreter_outlasts_the_timeout(self):
        slow = _slow_python(self)
        shipped_timeout = self.run_module.PYTEST_PROBE_TIMEOUT_S
        with mock.patch.object(self.run_module, "PYTEST_PROBE_TIMEOUT_S",
                               PATCHED_PROBE_TIMEOUT_S):
            started = time.monotonic()
            answer = self.run_module.pytest_importable(slow, self.cwd)
            elapsed = time.monotonic() - started
        self.assertIsNone(answer)
        self.assertLess(elapsed, SLOW_STUB_SLEEP_S,
                        f"the probe gives up at the patched {PATCHED_PROBE_TIMEOUT_S}s "
                        f"timeout, never waiting out the stub's {SLOW_STUB_SLEEP_S}s; "
                        f"elapsed={elapsed:.2f}s")
        self.assertEqual(self.run_module.PYTEST_PROBE_TIMEOUT_S, shipped_timeout,
                         "the patched timeout is restored afterwards")

    def test_the_probe_asks_the_interpreter_to_import_pytest_in_the_given_directory(self):
        root = _scratch_dir(self, "pytest-probe-recorder-")
        log = os.path.join(root, "probe.json")
        recorder = _write_executable(
            os.path.join(root, "recording_python"),
            _RECORDING_INTERPRETER.format(real=sys.executable, log=log))
        self.assertIs(self.run_module.pytest_importable(recorder, self.cwd), True)
        with open(log, encoding="utf-8") as handle:
            seen = json.load(handle)
        self.assertEqual(seen["argv"], ["-c", "import pytest"])
        self.assertEqual(os.path.realpath(seen["cwd"]), os.path.realpath(self.cwd))


class PythonWordsItsPytestRefusalsAsBeforeTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = load_client("python-crucible.py")
        cls.run_module = _run_module_of(cls.client._axi())

    def setUp(self):
        self.project = _scratch_dir(self, "pytest-refusal-project-")
        self.toml = os.path.join(self.project, "crucible.toml")

    def declare_pytest(self):
        Path(self.toml).write_text('[python]\nrunner = "pytest"\n', encoding="utf-8")

    def refusal(self, args):
        with self.assertRaises(self.client.RunnerRefused) as caught:
            self.client._resolve_runner(args, self.project)
        return str(caught.exception)

    def test_a_declared_pytest_with_an_interpreter_that_cannot_import_it_is_refused_naming_the_file(self):
        self.declare_pytest()
        bare = _pytestless_python(self)
        message = self.refusal(SimpleNamespace(runner=None, python=bare))
        self.assertEqual(
            message,
            f"the runner is pytest (from `[python] runner` in {self.toml}), but the "
            f"interpreter {bare} cannot import pytest; install pytest into it, or "
            f"choose another interpreter with --python")

    def test_a_flag_pytest_with_an_interpreter_that_cannot_import_it_is_refused_naming_the_flag(self):
        bare = _pytestless_python(self)
        message = self.refusal(SimpleNamespace(runner="pytest", python=bare))
        self.assertEqual(
            message,
            f"the runner is pytest (from `--runner`), but the interpreter {bare} "
            f"cannot import pytest; install pytest into it, or choose another "
            f"interpreter with --python")

    def test_an_interpreter_that_does_not_answer_in_time_is_refused_naming_the_run_modules_timeout(self):
        self.declare_pytest()
        slow = _slow_python(self)
        with mock.patch.object(self.run_module, "PYTEST_PROBE_TIMEOUT_S",
                               PATCHED_PROBE_TIMEOUT_S):
            started = time.monotonic()
            message = self.refusal(SimpleNamespace(runner=None, python=slow))
            elapsed = time.monotonic() - started
        self.assertEqual(
            message,
            f"the runner is pytest, but the interpreter {slow} did not answer whether "
            f"it can import pytest within {PATCHED_PROBE_TIMEOUT_S}s; check that "
            f"interpreter, or choose another with --python")
        self.assertLess(elapsed, SLOW_STUB_SLEEP_S,
                        f"the refusal comes at the run module's patched "
                        f"{PATCHED_PROBE_TIMEOUT_S}s timeout; elapsed={elapsed:.2f}s")

    def test_an_interpreter_that_imports_pytest_is_not_refused(self):
        self.declare_pytest()
        runner = self.client._resolve_runner(
            SimpleNamespace(runner=None, python=sys.executable), self.project)
        self.assertEqual(runner, "pytest")


AGENT = "unittest-exit-proof-agent"

# The scratch project's one unittest test, which passes: the runner's exit is
# then the run's only non-zero verdict.
STUB_TEST_NAME = "test_planted_passing_test_9f2e"
_STUB_TEST_MODULE = f'''"""One passing test."""

import unittest


class PlantedTest(unittest.TestCase):

    def {STUB_TEST_NAME}(self):
        self.assertEqual(1 + 1, 2)
'''

# A stub unittest interpreter: it hands its argv (the client's unittest
# runner and its arguments) to the real interpreter, so the run streams its
# tests as any unittest run does, then exits with the code under test.
_EXITING_INTERPRETER = '''#!{real}
import subprocess
import sys

subprocess.run([{real!r}, *sys.argv[1:]], check=False)
sys.exit({code})
'''


class _AUnittestRunExitingWithPytestsRunnerFailureCode(unittest.TestCase):
    """Drive `VERB` once with an agent under the unittest runner, whose
    interpreter runs the project's one passing test and exits `EXIT_CODE`."""

    VERB = ""
    EXIT_CODE = 0

    @classmethod
    def setUpClass(cls):
        cls.project = ScratchProject(f"unittest-exit-{cls.VERB}-{cls.EXIT_CODE}-",
                                     from_fixture=False)
        cls.project.declare()
        cls.project.write("tests/__init__.py", "")
        cls.project.write("tests/test_planted.py", _STUB_TEST_MODULE)
        python = _write_executable(
            os.path.join(cls.project.root, "exiting_python"),
            _EXITING_INTERPRETER.format(real=sys.executable, code=cls.EXIT_CODE))
        env = scrubbed_env(None)
        for key in (*_INHERITED_KEYS, "CRUCIBLE_STREAM"):
            env.pop(key, None)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), cls.VERB,
               "--agent", AGENT, "--python", python,
               "--reports", os.path.join(cls.project.root, "reports"),
               "--project-dir", cls.project.dir]
        cls.result = subprocess.run(cmd, cwd=cls.project.dir, env=env,
                                    capture_output=True, text=True,
                                    timeout=CLIENT_RUN_TIMEOUT, check=False)

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def test_the_unittest_runner_ran_and_exited_with_the_code(self):
        self.assertIn(f"unittest exit={self.EXIT_CODE}", self.result.stderr,
                      diag(self.result))

    def test_the_run_is_closed_from_its_stream_with_the_runners_exit(self):
        ingests = self.project.runs_ingests()
        self.assertEqual(len(ingests), 1,
                         f"the run is filed once, as the run's result; "
                         f"{diag(self.result)}")
        body = ingests[0]
        self.assertEqual(body.get("codec"), "crucible-events", body)
        self.assertEqual(body.get("framework"), "unittest", body)
        self.assertEqual(body.get("runnerExit"), self.EXIT_CODE, body)
        self.assertEqual(streamed_leaves(self.project.board, body),
                         [(STUB_TEST_NAME, "pass")], body)

    def test_no_compile_record_is_filed(self):
        self.assertEqual(self.project.compile_ingests(), [],
                         f"a unittest exit {self.EXIT_CODE} is not pytest failing "
                         f"as a runner; {diag(self.result)}")
        self.assertNotIn(COMPILE, [path for path, _b in self.project.board.posts()],
                         diag(self.result))

    def test_the_envelope_is_the_filed_run_and_the_verb_exits_1(self):
        axi = envelope(self.result.stdout)
        if axi is None:
            self.fail(f"stdout must be one AXI envelope; {diag(self.result)}")
        self.assertEqual(axi.get("verb"), self.VERB, diag(self.result))
        codes = [w.get("code") for w in axi.get("warnings") or [] if isinstance(w, dict)]
        self.assertNotIn("no-test-reports", codes, diag(self.result))
        self.assertEqual(self.result.returncode, 1,
                         f"a filed run whose runner exited non-zero exits 1; "
                         f"{diag(self.result)}")


class AUnittestTestRunExitingThreeIsFiledAsAUnittestRunTest(
        _AUnittestRunExitingWithPytestsRunnerFailureCode):
    VERB = "test"
    EXIT_CODE = 3


class AUnittestTestRunExitingFourIsFiledAsAUnittestRunTest(
        _AUnittestRunExitingWithPytestsRunnerFailureCode):
    VERB = "test"
    EXIT_CODE = 4


class AUnittestRegressionExitingThreeIsFiledAsAUnittestRunTest(
        _AUnittestRunExitingWithPytestsRunnerFailureCode):
    VERB = "regression"
    EXIT_CODE = 3


class AUnittestRegressionExitingFourIsFiledAsAUnittestRunTest(
        _AUnittestRunExitingWithPytestsRunnerFailureCode):
    VERB = "regression"
    EXIT_CODE = 4


# The shared base drives no run of its own: out of the module's namespace, so
# unittest's loader collects only the concrete classes above.
del _AUnittestRunExitingWithPytestsRunnerFailureCode

if __name__ == "__main__":
    unittest.main()
