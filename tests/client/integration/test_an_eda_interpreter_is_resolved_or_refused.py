"""An eda run's interpreter is the project's, never the client's own, and one
that cannot run pytest is refused before anything reaches the board.

The interpreter is, in this order: `--python` > `$EDA_CRUCIBLE_PYTHON` >
`[eda] python` in the project's `crucible.toml` (relative to the project dir)
> `<project-dir>/.venv/bin/python`. With none of them it is refused, naming
every candidate; the client's own `sys.executable` is never used. The chosen
interpreter must import pytest (the shared probe, `-c "import pytest"`, run
in a headless environment: `QT_QPA_PLATFORM=offscreen`, no `DISPLAY`, no
`WAYLAND_DISPLAY`). An interpreter that cannot is refused naming it and that
it needs pytest; one whose probe does not answer within
`pytest_probe_timeout()` is refused naming it and the timeout. An `[eda]
python` that is not an executable file is refused as a declaration naming
the table, the field and the file. Every refusal comes before anything is
posted, carries `ok: false` and exits 1.

Each candidate is a RECORDING interpreter of its own (see
`eda_project_harness`), so which one won is read from the argv the client
spawned: the winner's log holds the probe, spawned as the winner's path, and
every loser's log is empty. A candidate built with `answer_probe=1` answers
the probe "no pytest", so the run stops at the probe's refusal and opens no
run.

Driven as an OS subprocess, except the probe-timeout case: there the run
module's probe timeout is patched short in THIS process, so the client is
loaded and run in-process (its `main()` over a patched `sys.argv`) and the
patch is restored afterwards. Against a `RecordingBoard` throughout.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_interpreter_is_resolved_or_refused
"""

import contextlib
import io
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from tests.client import load_client
from tests.client.eda_project_harness import (
    AGENT,
    DECLARATION_REFUSED_CODE,
    EDA_CLIENT,
    PYTHON_VAR,
    WATCHED_ENV,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    envelope,
    pytestless_python,
    real_dir,
    said,
    scratch,
)

#: The `[eda] python` a test declares, relative to the project dir.
DECLARED_PYTHON = "tools/eda-python"
#: The probe timeout the run module is patched to (a value no scratch path
#: can contain, since a temp name holds no `.`), and how long the slow stub
#: interpreter sleeps: long enough to outlast it, short enough that a probe
#: which waited it out still returns in seconds.
PATCHED_PROBE_TIMEOUT_S = 1.5
SLOW_STUB_SLEEP_S = 6


class _Interpreter(unittest.TestCase):

    maxDiff = 4000

    def setUp(self):
        self.project = EdaProject(self)
        self.outside = scratch(self, "eda-interpreters-")

    def candidate(self, path, answer_probe: int | None = 1):
        return RecordingInterpreter(path, answer_probe=answer_probe)

    def assert_refused_before_any_post(self, result, why):
        """`ok: false`, exit 1, and nothing posted. Answers the envelope's words."""
        where = f"{why}; {diagnostics(result)}"
        self.assertEqual(result.returncode, 1, f"the run is refused with exit 1; {where}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        self.assertIs((axi or {}).get("ok"), False, where)
        self.assertEqual(self.project.posts(), [],
                         f"nothing is posted to the board; {where}")
        return said(axi)


class EachInterpreterSourceWinsInTurnTest(_Interpreter):
    """Every candidate answers the probe "no pytest", so the winner is the
    one interpreter the probe was spawned as, and the run stops there."""

    def assert_won(self, result, winner, losers, why, named=None):
        """`named` is how the refusal names the winner: its path by default;
        a declared relative path may be named as declared or joined."""
        where = f"{why}; {diagnostics(result)}"
        words = self.assert_refused_before_any_post(result, why)
        probes = winner.probe_calls()
        self.assertEqual(len(probes), 1, f"the winner is probed once; {where}")
        self.assertEqual(winner.spawned_as(probes[0]), real_dir(winner.path),
                         f"the probe's argv[0] is the winner; {where}")
        for call in winner.calls():
            self.assertNotIn(sys.executable, call["argv"],
                             f"the client's own interpreter is never spawned; {where}")
        for loser in losers:
            self.assertEqual(loser.calls(), [],
                             f"{loser.path} lost and is never spawned; {where}")
        self.assertIn(named or winner.path, words,
                      f"the refusal names the interpreter; {where}")
        self.assertIn("pytest", words, where)

    def venv(self):
        return self.candidate(self.project.path(".venv/bin/python"))

    def declared(self):
        self.project.declare(f'[eda]\npython = "{DECLARED_PYTHON}"\n')
        return self.candidate(self.project.path(DECLARED_PYTHON))

    def from_env(self):
        return self.candidate(os.path.join(self.outside, "env-python"))

    def from_flag(self):
        return self.candidate(os.path.join(self.outside, "flag-python"))

    def test_the_project_venv_is_used_when_nothing_else_is_named(self):
        venv = self.venv()
        result = self.project.drive("unit")
        self.assert_won(result, venv, [], "only .venv/bin/python exists")

    def test_the_declared_eda_python_wins_over_the_venv(self):
        venv, declared = self.venv(), self.declared()
        result = self.project.drive("unit")
        self.assert_won(result, declared, [venv], "[eda] python beside a .venv",
                        named=DECLARED_PYTHON)

    def test_the_environment_variable_wins_over_the_declaration_and_the_venv(self):
        venv, declared, env = self.venv(), self.declared(), self.from_env()
        result = self.project.drive("unit", env=self.project.env(**{PYTHON_VAR: env.path}))
        self.assert_won(result, env, [declared, venv],
                        "EDA_CRUCIBLE_PYTHON beside [eda] python and a .venv")

    def test_the_flag_wins_over_every_other_source(self):
        venv, declared, env, flag = (self.venv(), self.declared(), self.from_env(),
                                     self.from_flag())
        result = self.project.drive("unit", python=flag.path,
                                    env=self.project.env(**{PYTHON_VAR: env.path}))
        self.assert_won(result, flag, [env, declared, venv],
                        "--python beside EDA_CRUCIBLE_PYTHON, [eda] python and a .venv")


class TheClientsOwnInterpreterIsNeverUsedTest(_Interpreter):

    def test_nothing_resolving_is_refused_naming_every_candidate(self):
        result = self.project.drive("unit")
        words = self.assert_refused_before_any_post(
            result, "no --python, no EDA_CRUCIBLE_PYTHON, no [eda] python, no .venv")
        for candidate in ("--python", PYTHON_VAR, "[eda] python", ".venv/bin/python"):
            self.assertIn(candidate, words,
                          f"the refusal names {candidate}; {diagnostics(result)}")

    def test_every_argv_the_client_spawns_starts_with_the_projects_interpreter(self):
        venv = self.candidate(self.project.path(".venv/bin/python"), answer_probe=None)
        result = self.project.drive("unit")
        where = diagnostics(result)
        calls = venv.calls()
        self.assertEqual(len(venv.probe_calls()), 1,
                         f"the project's interpreter is probed once; calls={calls!r} {where}")
        for call in calls:
            self.assertEqual(venv.spawned_as(call), real_dir(venv.path), where)
            self.assertNotIn(sys.executable, call["argv"],
                             f"the client's own interpreter is in no argv; {where}")
            self.assertNotIn(real_dir(sys.executable), call["argv"], where)


class AnInterpreterThatCannotRunPytestIsRefusedTest(_Interpreter):

    @classmethod
    def setUpClass(cls):
        cls.bare = pytestless_python(cls)

    def test_an_interpreter_without_pytest_is_refused_naming_it(self):
        result = self.project.drive("unit", python=self.bare)
        words = self.assert_refused_before_any_post(result, "a venv built --without-pip")
        self.assertIn(self.bare, words, diagnostics(result))
        self.assertIn("pytest", words.replace(self.bare, ""),
                      f"the refusal says the interpreter needs pytest; {diagnostics(result)}")

    def test_the_probe_runs_headless_whatever_the_clients_own_display(self):
        python = self.candidate(os.path.join(self.outside, "headless-python"))
        env = self.project.env(DISPLAY=":77", WAYLAND_DISPLAY="wayland-77",
                               QT_QPA_PLATFORM="xcb")
        result = self.project.drive("unit", python=python.path, env=env)
        where = diagnostics(result)
        probes = python.probe_calls()
        self.assertEqual(len(probes), 1, f"the interpreter is probed once; {where}")
        self.assertEqual(probes[0]["env"]["QT_QPA_PLATFORM"], "offscreen", where)
        self.assertEqual({name: probes[0]["set"][name] for name in WATCHED_ENV},
                         {"QT_QPA_PLATFORM": True, "DISPLAY": False,
                          "WAYLAND_DISPLAY": False},
                         f"the probe's environment is headless; {where}")

    def test_a_declared_eda_python_that_is_not_executable_is_refused_as_a_declaration(self):
        Path(self.project.path("tools")).mkdir()
        Path(self.project.path(DECLARED_PYTHON)).write_text("#!/bin/sh\nexit 0\n")
        self.project.declare(f'[eda]\npython = "{DECLARED_PYTHON}"\n')
        result = self.project.drive("unit")
        words = self.assert_refused_before_any_post(result, "[eda] python lacks the exec bit")
        for name in ("[eda]", "python", self.project.toml):
            self.assertIn(name, words, f"the refusal names {name!r}; {diagnostics(result)}")
        self.assertIn(DECLARATION_REFUSED_CODE, result.stderr, diagnostics(result))

    def test_a_declared_eda_python_that_does_not_exist_is_refused_as_a_declaration(self):
        self.project.declare(f'[eda]\npython = "{DECLARED_PYTHON}"\n')
        result = self.project.drive("unit")
        words = self.assert_refused_before_any_post(result, "[eda] python names no file")
        for name in ("[eda]", "python", self.project.toml):
            self.assertIn(name, words, f"the refusal names {name!r}; {diagnostics(result)}")
        self.assertIn(DECLARATION_REFUSED_CODE, result.stderr, diagnostics(result))


class AnInterpreterThatDoesNotAnswerInTimeIsRefusedTest(unittest.TestCase):
    """The client is run in-process so the run module it reaches through the
    core can have its probe timeout patched short."""

    maxDiff = 4000

    def setUp(self):
        self.project = EdaProject(self)
        root = scratch(self, "eda-slow-python-")
        self.slow = os.path.join(root, "slow-python")
        Path(self.slow).write_text(f"#!/bin/sh\nexec sleep {SLOW_STUB_SLEEP_S}\n")
        os.chmod(self.slow, 0o700)

    def run_in_process(self, client, argv):
        """`client.main()` over `argv`: (exit code, stdout, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with mock.patch.object(sys, "argv", [str(EDA_CLIENT), *argv]), \
                mock.patch.dict(os.environ, self.project.env(), clear=True), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = client.main()
            except SystemExit as stop:
                code = stop.code if isinstance(stop.code, int) else 1
        return code, out.getvalue(), err.getvalue()

    def test_a_probe_that_outlasts_the_timeout_is_refused_naming_the_interpreter_and_timeout(self):
        client = load_client(EDA_CLIENT.name)
        core = client._axi()
        run_module = core._RUN
        self.assertIs(run_module.pytest_importable, core.pytest_importable,
                      "the core's probe is the run module's")
        shipped = run_module.PYTEST_PROBE_TIMEOUT_S
        with mock.patch.object(run_module, "PYTEST_PROBE_TIMEOUT_S", PATCHED_PROBE_TIMEOUT_S):
            started = time.monotonic()
            code, out, err = self.run_in_process(
                client, ["unit", "--agent", AGENT, "--project-dir", self.project.dir,
                         "--python", self.slow])
            elapsed = time.monotonic() - started
        where = f"exit={code} stdout={out[-2000:]!r} stderr={err[-2000:]!r}"
        self.assertEqual(run_module.PYTEST_PROBE_TIMEOUT_S, shipped,
                         "the patched timeout is restored")
        self.assertEqual(code, 1, f"the run is refused with exit 1; {where}")
        axi = envelope(out)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        self.assertIs((axi or {}).get("ok"), False, where)
        words = said(axi)
        self.assertIn(self.slow, words, f"the refusal names the interpreter; {where}")
        self.assertIn(str(PATCHED_PROBE_TIMEOUT_S), words,
                      f"the refusal names the probe's timeout; {where}")
        self.assertLess(elapsed, SLOW_STUB_SLEEP_S,
                        f"the refusal comes at the patched timeout; elapsed={elapsed:.2f}s")
        self.assertEqual(self.project.posts(), [], f"nothing is posted; {where}")


if __name__ == "__main__":
    unittest.main()
