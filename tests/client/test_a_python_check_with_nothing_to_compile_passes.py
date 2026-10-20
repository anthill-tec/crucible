"""A python check with nothing to compile passes, and says so.

`check`, and `pre-merge-gate`'s check step, compile whichever of their paths
exist -- the given `--paths`, or by default `app` and `tests`. When none of
them exists they compile nothing and pass: no compile record is filed, the
envelope carries a `check-compiled-nothing` warning naming the paths looked
for and `--paths`, and the gate goes on to run its suite. The compiler's own
usage text is never filed as a syntax error.

`NothingToCompilePassesTest`
    `check` on a project holding neither `app` nor `tests`, and `check --paths`
    naming paths that do not exist: exit 0, `ok: true`, one
    `check-compiled-nothing` warning naming the paths looked for and
    `--paths`, no compile record, and the compiler never invoked.

`OnlyTheDefaultPathThatExistsIsCompiledTest`
    Regression pins: where only one of `app`/`tests` exists, exactly that
    one's files are compiled, the check passes without the warning, and a
    syntax error there is still filed.

`TheGateOnTheUnmodifiedPytestFixtureRunsItsSuiteTest`
    `pre-merge-gate` on an unmodified scratch copy of the committed pytest
    fixture (no `app`, no `tests`) with pytest declared: it files no compile
    record, carries `check-compiled-nothing`, and goes on to run and file the
    fixture's three tests.

Every test drives the REAL `clients/python-crucible.py` as an OS subprocess
on a scratch project whose own `crucible.toml` points the client at a
`RecordingBoard` on loopback; no live board is ever touched. The `check`
proofs hand the client a recording interpreter that appends the argv of every
invocation to a log, then hands the call to this suite's interpreter, so what
was compiled is read from what the client asked the interpreter to do.

Invocation:
    python3 -m unittest tests.client.test_a_python_check_with_nothing_to_compile_passes -v
"""

import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import CLIENTS, scrubbed_env
from tests.client.pytest_project_harness import (
    AGENT,
    ScratchProject,
    counts,
    diag,
    envelope,
    require_pytest_and_coverage,
)

TIMEOUT = 180
COMPILED_NOTHING = "check-compiled-nothing"
PATHS_FLAG = "--paths"
CALLS_VAR = "CHECK_PROOF_CALLS"
CHECK_AGENT = "check-proof-agent"

# Variables that, inherited from the shell running this suite, would decide
# the client's interpreter or project.
_INHERITED_KEYS = ("PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR", "PYTEST_ADDOPTS",
                   "PYTEST_PLUGINS", "COVERAGE_RCFILE", "COVERAGE_PROCESS_START")

# The recording interpreter: `{real}` is the interpreter every call is handed
# to; the argv of every invocation is appended, one JSON list per line, to the
# file `$CHECK_PROOF_CALLS` names.
_RECORDING_INTERPRETER = '''#!{real}
import json
import os
import sys

log = os.environ.get("CHECK_PROOF_CALLS")
if log:
    with open(log, "a") as handle:
        handle.write(json.dumps(sys.argv[1:]) + "\\n")
os.execv({real!r}, [{real!r}, *sys.argv[1:]])
'''

_GOOD_MODULE = "VALUE = 1 + 1\n"
_BROKEN_MODULE = "def broken(:\n    return 1\n"


def _word(name):
    return re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])")


class _CheckCase(unittest.TestCase):
    """An empty scratch project (its `.env` and a `crucible.toml` naming the
    recording board) and the recording interpreter the client is handed."""

    def setUp(self):
        self.project = ScratchProject("python-check-nothing-", from_fixture=False)
        self.addCleanup(self.project.close)
        self.project.declare()
        self.calls_log = os.path.join(self.project.root, "interpreter-calls.jsonl")
        self.python = os.path.join(self.project.root, "recording_python")
        Path(self.python).write_text(_RECORDING_INTERPRETER.format(real=sys.executable))
        os.chmod(self.python, 0o700)

    def check(self, *extra):
        env = scrubbed_env(None, **{CALLS_VAR: self.calls_log})
        for key in _INHERITED_KEYS:
            env.pop(key, None)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), "check",
               "--agent", CHECK_AGENT, *extra,
               "--python", self.python, "--project-dir", self.project.dir]
        return subprocess.run(cmd, cwd=self.project.dir, env=env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    def calls(self):
        if not os.path.exists(self.calls_log):
            return []
        with open(self.calls_log) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def compiler_calls(self):
        return [c for c in self.calls()
                if any(c[i:i + 2] == ["-m", "py_compile"] for i in range(len(c)))]

    def the_envelope(self, result):
        axi = envelope(result.stdout)
        if axi is None:
            self.fail(f"stdout must be one AXI envelope; {diag(result)}")
        return axi

    def compiled_nothing_warnings(self, axi):
        return [w for w in axi.get("warnings") or []
                if isinstance(w, dict) and w.get("code") == COMPILED_NOTHING]


class NothingToCompilePassesTest(_CheckCase):

    def assert_passed_compiling_nothing(self, result, looked_for):
        why = f"{diag(result)} calls={self.calls()!r}"
        axi = self.the_envelope(result)
        self.assertEqual(result.returncode, 0,
                         f"a check with nothing to compile passes, exit 0; {why}")
        self.assertIs(axi.get("ok"), True, f"the check envelope is ok: true; {why}")
        self.assertEqual(self.project.compile_ingests(), [],
                         f"nothing compiled, so no compile record is filed; {why}")
        self.assertEqual(self.compiler_calls(), [],
                         f"with no path to compile the compiler is never invoked; {why}")
        found = self.compiled_nothing_warnings(axi)
        self.assertEqual(len(found), 1,
                         f"exactly one {COMPILED_NOTHING} warning; {why}")
        detail = found[0].get("detail")
        if not isinstance(detail, str):
            self.fail(f"the warning carries a detail; {why}")
        for name in (*looked_for, PATHS_FLAG):
            self.assertRegex(detail, _word(name),
                             f"the {COMPILED_NOTHING} detail must name {name!r}; "
                             f"detail={detail!r}")

    def test_check_on_a_project_with_neither_app_nor_tests_passes_and_says_so(self):
        for absent in ("app", "tests"):
            self.assertFalse(os.path.exists(os.path.join(self.project.dir, absent)),
                             f"fixture: the project must hold no {absent!r}")
        result = self.check()
        self.assert_passed_compiling_nothing(result, ("app", "tests"))

    def test_check_with_given_paths_that_do_not_exist_passes_and_names_them(self):
        result = self.check(PATHS_FLAG, "lib", "scripts")
        self.assert_passed_compiling_nothing(result, ("lib", "scripts"))


class OnlyTheDefaultPathThatExistsIsCompiledTest(_CheckCase):

    def assert_compiled_exactly(self, result, rel):
        why = f"{diag(result)} calls={self.calls()!r}"
        axi = self.the_envelope(result)
        self.assertEqual(result.returncode, 0, why)
        self.assertIs(axi.get("ok"), True, why)
        self.assertEqual(self.compiled_nothing_warnings(axi), [],
                         f"a check that compiled a file carries no "
                         f"{COMPILED_NOTHING} warning; {why}")
        self.assertEqual(self.project.compile_ingests(), [], why)
        compiled = self.compiler_calls()
        self.assertEqual(len(compiled), 1, f"one compiler invocation; {why}")
        files = [a for a in compiled[0] if a.endswith(".py")]
        self.assertEqual(files, [os.path.join(self.project.dir, rel)],
                         f"exactly the existing path's file is compiled; {why}")

    def test_only_tests_existing_compiles_only_its_files(self):
        self.project.write("tests/test_good.py", _GOOD_MODULE)
        self.assert_compiled_exactly(self.check(), "tests/test_good.py")

    def test_only_app_existing_compiles_only_its_files(self):
        self.project.write("app/good.py", _GOOD_MODULE)
        self.assert_compiled_exactly(self.check(), "app/good.py")

    def test_a_syntax_error_in_the_one_existing_path_is_still_filed(self):
        self.project.write("tests/test_broken.py", _BROKEN_MODULE)
        result = self.check()
        why = f"{diag(result)} calls={self.calls()!r}"
        axi = self.the_envelope(result)
        self.assertNotEqual(result.returncode, 0, why)
        self.assertIs(axi.get("ok"), False, why)
        self.assertEqual(self.compiled_nothing_warnings(axi), [], why)
        compiled = self.project.compile_ingests()
        self.assertEqual(len(compiled), 1, f"one compile record is filed; {why}")
        self.assertIn("test_broken.py", compiled[0].get("errors") or "",
                      f"the record names the file that does not compile; "
                      f"record={compiled[0]!r}")


class TheGateOnTheUnmodifiedPytestFixtureRunsItsSuiteTest(unittest.TestCase):
    """One gate run, on a scratch copy of the committed pytest fixture exactly
    as committed (no `app` added), with pytest declared."""

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject("python-gate-nothing-to-compile-")
        cls.project.declare("pytest")
        for absent in ("app", "tests"):
            if os.path.exists(os.path.join(cls.project.dir, absent)):
                raise AssertionError(f"fixture: the pytest fixture holds no {absent!r}")
        cls.result = cls.project.drive(["pre-merge-gate", "--agent", AGENT])
        cls.axi = envelope(cls.result.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def the_envelope(self):
        if self.axi is None:
            self.fail(f"stdout must be one AXI envelope; {diag(self.result)}")
        return self.axi

    def test_the_gate_files_no_compile_record(self):
        self.assertEqual(self.project.compile_ingests(), [],
                         f"a check step that compiled nothing files no compile "
                         f"record; {diag(self.result)}")

    def test_the_gate_goes_on_to_run_and_file_the_fixtures_suite(self):
        ingests = self.project.parsed_ingests()
        self.assertEqual(len(ingests), 1,
                         f"the gate's regression step runs and files exactly once; "
                         f"{diag(self.result)}")
        self.assertEqual(counts(ingests[0]),
                         {"total": 3, "passed": 1, "failed": 1, "pending": 1},
                         diag(self.result))
        self.assertEqual(ingests[0].get("tier"), "regression", diag(self.result))
        axi = self.the_envelope()
        self.assertEqual(axi.get("verb"), "pre-merge-gate", diag(self.result))
        self.assertNotEqual(axi.get("stage"), "check",
                            f"the gate must not stop at its check step; "
                            f"{diag(self.result)}")
        self.assertEqual(self.result.returncode, 1,
                         f"the fixture's failing test fails the gate, exit 1; "
                         f"{diag(self.result)}")

    def test_the_gate_envelope_carries_one_compiled_nothing_warning(self):
        axi = self.the_envelope()
        found = [w for w in axi.get("warnings") or []
                 if isinstance(w, dict) and w.get("code") == COMPILED_NOTHING]
        self.assertEqual(len(found), 1,
                         f"the gate carries exactly one {COMPILED_NOTHING} warning; "
                         f"{diag(self.result)}")
        detail = found[0].get("detail") or ""
        for name in ("app", "tests", PATHS_FLAG):
            self.assertRegex(detail, _word(name),
                             f"the {COMPILED_NOTHING} detail must name {name!r}; "
                             f"detail={detail!r}")


if __name__ == "__main__":
    unittest.main()
