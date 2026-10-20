"""A pre-merge gate that runs pytest checks for pytest once.

With pytest chosen, the python client refuses an interpreter that cannot
import pytest before anything reaches the board. `pre-merge-gate` makes that
check once per gate: it is not repeated when the gate hands over to its
regression step.

The interpreter the client is handed is a recording wrapper: it appends the
argv of every invocation to a log, then hands the call to this suite's
interpreter. A pytest probe is any invocation that asks about pytest without
running the suite -- a `-c` program that names pytest, or `-m pytest` without
`--junitxml`; the suite's run is the invocation carrying `--junitxml`.

The project is a scratch copy of the committed pytest fixture with pytest
declared and an empty `app` package beside it, so the gate's check step has a
file to compile and the gate reaches its regression step whatever that step
does with a project holding nothing to compile.

The REAL `clients/python-crucible.py` is driven as an OS subprocess; it files
to a `RecordingBoard` on loopback named by the scratch project's own
`crucible.toml`, never the live board.

Invocation:
    python3 -m unittest tests.client.test_a_pytest_gate_probes_pytest_once -v
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import CLIENTS, scrubbed_env
from tests.client.pytest_project_harness import (
    ScratchProject,
    counts,
    diag,
    require_pytest_and_coverage,
)

TIMEOUT = 180
CALLS_VAR = "GATE_PROBE_CALLS"
GATE_AGENT = "gate-probe-proof-agent"

_INHERITED_KEYS = ("PY_CRUCIBLE_PYTHON", "PY_CRUCIBLE_PROJECT_DIR", "PYTEST_ADDOPTS",
                   "PYTEST_PLUGINS", "COVERAGE_RCFILE", "COVERAGE_PROCESS_START")

_RECORDING_INTERPRETER = '''#!{real}
import json
import os
import sys

log = os.environ.get("GATE_PROBE_CALLS")
if log:
    with open(log, "a") as handle:
        handle.write(json.dumps(sys.argv[1:]) + "\\n")
os.execv({real!r}, [{real!r}, *sys.argv[1:]])
'''


def _is_suite_run(argv):
    return any(a.startswith("--junitxml") for a in argv)


def _is_pytest_probe(argv):
    if _is_suite_run(argv):
        return False
    for i in range(len(argv) - 1):
        if argv[i] == "-c" and "pytest" in argv[i + 1]:
            return True
        if argv[i] == "-m" and argv[i + 1] == "pytest":
            return True
    return False


class AGateWithPytestChosenProbesPytestOnceTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        require_pytest_and_coverage()
        cls.project = ScratchProject("python-gate-probe-")
        cls.project.declare("pytest")
        cls.project.write("app/__init__.py", "")
        cls.calls_log = os.path.join(cls.project.root, "interpreter-calls.jsonl")
        python = os.path.join(cls.project.root, "recording_python")
        Path(python).write_text(_RECORDING_INTERPRETER.format(real=sys.executable))
        os.chmod(python, 0o700)
        env = scrubbed_env(None, **{CALLS_VAR: cls.calls_log})
        for key in _INHERITED_KEYS:
            env.pop(key, None)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), "pre-merge-gate",
               "--agent", GATE_AGENT, "--python", python,
               "--project-dir", cls.project.dir]
        cls.result = subprocess.run(cmd, cwd=cls.project.dir, env=env,
                                    capture_output=True, text=True,
                                    timeout=TIMEOUT, check=False)

    @classmethod
    def tearDownClass(cls):
        cls.project.close()

    def calls(self):
        if not os.path.exists(self.calls_log):
            return []
        with open(self.calls_log) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def why(self):
        return f"{diag(self.result)} calls={self.calls()!r}"

    def test_the_gate_runs_the_suite_under_pytest_once(self):
        runs = [c for c in self.calls() if _is_suite_run(c)]
        self.assertEqual(len(runs), 1,
                         f"the gate runs the suite exactly once; {self.why()}")
        self.assertTrue(any(runs[0][i:i + 2] == ["-m", "pytest"]
                            for i in range(len(runs[0]))),
                        f"the suite runs under pytest; {self.why()}")
        ingests = self.project.parsed_ingests()
        self.assertEqual(len(ingests), 1, self.why())
        self.assertEqual(counts(ingests[0]),
                         {"total": 3, "passed": 1, "failed": 1, "pending": 1},
                         self.why())

    def test_the_gate_probes_the_interpreter_for_pytest_exactly_once(self):
        probes = [c for c in self.calls() if _is_pytest_probe(c)]
        self.assertEqual(len(probes), 1,
                         f"one gate probes the interpreter for pytest once, not "
                         f"once per step; probes={probes!r}; {self.why()}")

    def test_the_probe_comes_before_the_check_step_and_the_suite_run(self):
        calls = self.calls()
        probe_at = [i for i, c in enumerate(calls) if _is_pytest_probe(c)]
        compile_at = [i for i, c in enumerate(calls)
                      if any(c[i2:i2 + 2] == ["-m", "py_compile"]
                             for i2 in range(len(c)))]
        run_at = [i for i, c in enumerate(calls) if _is_suite_run(c)]
        self.assertTrue(probe_at and compile_at and run_at,
                        f"the gate probes, compiles and runs; {self.why()}")
        self.assertLess(probe_at[0], compile_at[0],
                        f"the probe precedes the check step; {self.why()}")
        self.assertLess(probe_at[-1], run_at[0],
                        f"no probe follows the suite run's start; {self.why()}")


if __name__ == "__main__":
    unittest.main()
