"""The shared pytest import probe runs its child in the environment it is
given, and in the client's own when it is given none.

The run module (`clients/_crucible_run.py`, reached through the core every
client loads) holds the one probe, `pytest_importable(python, cwd, env=None)`:
it runs `[python, "-c", "import pytest"]` in `cwd`. With `env`, the child runs
with exactly that environment -- nothing of the client's own is added, which
is what lets a client make the probe headless. Without it (or with
`env=None`), the child inherits the client's environment, as it always has.

Each test spawns a real child: a recording stub interpreter, an executable
script written into a temp dir the test removes, which records its argv,
working directory and environment into a file beside it and exits 0 (so the
probe answers True). The client's own environment is marked for the test's
duration (`mock.patch.dict` on `os.environ`, restored when it ends).

Invocation:
    .venv/bin/python clients/python-crucible.py test \\
        --tests tests.client.integration.test_the_pytest_probe_runs_in_the_environment_it_is_given
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client import load_client

# A variable only the client's own environment holds during a test.
CLIENT_ONLY = "CRUCIBLE_PROBE_CLIENT_ONLY"
CLIENT_ONLY_VALUE = "from-the-client"
# A variable only the environment the probe is given holds.
GIVEN_ONLY = "CRUCIBLE_PROBE_GIVEN_ONLY"
GIVEN_ONLY_VALUE = "from-the-caller"
# A display the client's environment carries, which a headless probe must not.
CLIENT_DISPLAY = ":97"

_RECORDING_INTERPRETER = '''#!{real}
import json
import os
import sys

with open({log!r}, "w", encoding="utf-8") as handle:
    json.dump({{"argv": sys.argv[1:], "cwd": os.getcwd(),
               "env": dict(os.environ)}}, handle)
sys.exit(0)
'''


def _scratch_dir(case, prefix):
    """A temp dir removed when `case` finishes."""
    path = tempfile.mkdtemp(prefix=prefix)
    case.addCleanup(shutil.rmtree, path, ignore_errors=True)
    return path


class ThePytestProbeRunsInTheEnvironmentItIsGivenTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.core = load_client("_crucible_axi.py")
        cls.run_module = cls.core._RUN

    def setUp(self):
        self.cwd = os.path.realpath(_scratch_dir(self, "pytest-probe-env-cwd-"))
        stub_dir = _scratch_dir(self, "pytest-probe-env-stub-")
        self.record = os.path.join(stub_dir, "recorded.json")
        self.python = os.path.join(stub_dir, "recording_python")
        Path(self.python).write_text(
            _RECORDING_INTERPRETER.format(real=sys.executable, log=self.record),
            encoding="utf-8")
        os.chmod(self.python, 0o700)
        client_env = mock.patch.dict(os.environ, {CLIENT_ONLY: CLIENT_ONLY_VALUE,
                                                  "DISPLAY": CLIENT_DISPLAY})
        client_env.start()
        self.addCleanup(client_env.stop)

    def recorded(self):
        self.assertTrue(os.path.exists(self.record), "the probe spawned the interpreter")
        with open(self.record, encoding="utf-8") as handle:
            return json.load(handle)

    def test_a_given_environment_is_the_probes_and_none_of_the_clients_is_added(self):
        given = {GIVEN_ONLY: GIVEN_ONLY_VALUE, "QT_QPA_PLATFORM": "offscreen"}
        answer = self.run_module.pytest_importable(self.python, self.cwd, env=given)
        self.assertIs(answer, True)
        seen = self.recorded()
        self.assertEqual(seen["argv"], ["-c", "import pytest"])
        self.assertEqual(seen["cwd"], self.cwd)
        self.assertEqual(seen["env"].get(GIVEN_ONLY), GIVEN_ONLY_VALUE)
        self.assertEqual(seen["env"].get("QT_QPA_PLATFORM"), "offscreen")
        self.assertNotIn(CLIENT_ONLY, seen["env"])
        self.assertNotIn("DISPLAY", seen["env"])
        self.assertEqual(given, {GIVEN_ONLY: GIVEN_ONLY_VALUE,
                                 "QT_QPA_PLATFORM": "offscreen"},
                         "the probe leaves the caller's environment as it was")

    def test_an_empty_given_environment_is_still_the_probes_own(self):
        answer = self.run_module.pytest_importable(self.python, self.cwd, env={})
        self.assertIs(answer, True)
        seen = self.recorded()
        self.assertNotIn(CLIENT_ONLY, seen["env"])
        self.assertNotIn("DISPLAY", seen["env"])

    def test_a_probe_given_no_environment_inherits_the_clients(self):
        answer = self.run_module.pytest_importable(self.python, self.cwd)
        self.assertIs(answer, True)
        seen = self.recorded()
        self.assertEqual(seen["argv"], ["-c", "import pytest"])
        self.assertEqual(seen["cwd"], self.cwd)
        self.assertEqual(seen["env"].get(CLIENT_ONLY), CLIENT_ONLY_VALUE)
        self.assertEqual(seen["env"].get("DISPLAY"), CLIENT_DISPLAY)
        self.assertNotIn(GIVEN_ONLY, seen["env"])

    def test_a_probe_given_none_for_its_environment_inherits_the_clients(self):
        answer = self.run_module.pytest_importable(self.python, self.cwd, env=None)
        self.assertIs(answer, True)
        seen = self.recorded()
        self.assertEqual(seen["env"].get(CLIENT_ONLY), CLIENT_ONLY_VALUE)
        self.assertEqual(seen["env"].get("DISPLAY"), CLIENT_DISPLAY)

    def test_an_interpreter_that_cannot_be_started_is_false_with_an_environment_given(self):
        missing = os.path.join(self.cwd, "no_such_python")
        answer = self.run_module.pytest_importable(
            missing, self.cwd, env={GIVEN_ONLY: GIVEN_ONLY_VALUE})
        self.assertIs(answer, False)
        self.assertFalse(os.path.exists(self.record), "no interpreter ran")


if __name__ == "__main__":
    unittest.main()
