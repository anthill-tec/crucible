"""A real client spawned through the test-only launcher behaves as the same
client spawned directly.

Each test spawns `python-crucible.py` from the suite's test install twice —
once directly (`[python, client, *args]`) and once through
`tests/client/short_cadence_launcher.py` with every setting at its shortest —
and compares what a caller observes: the exit code, stdout and stderr.

  - `--help`: exit 0 and the same help text;
  - an unknown verb: the same argparse refusal and exit code 2;
  - `status` in a scratch project that names its key and declares no board:
    the same refusal,
    naming the TEST INSTALL's own `crucible.toml` (the launcher loaded the
    exact path it was handed, so the client took the test install, never the
    repository root, as its install).

Integration tier: each test spawns real processes. No board is declared and
none is contacted; every project directory is a scratch directory the test
removes.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.client import TEST_INSTALL_CONFIG, client_script
from tests.client.client_cadence_settings import SHORT, launcher_command
from tests.client.live_run_harness import scrubbed_env

CLIENT = client_script("python-crucible.py")
TIMEOUT = 30


class ALaunchedClientIsTheSameClientTest(unittest.TestCase):

    def setUp(self):
        self.project = tempfile.mkdtemp(prefix="short-cadence-launched-")
        self.addCleanup(shutil.rmtree, self.project, ignore_errors=True)
        with open(os.path.join(self.project, ".env"), "w", encoding="utf-8") as handle:
            handle.write("CRUCIBLE_PROJECT_KEY=short-cadence-launched-key\n")
        self.env = scrubbed_env()
        self.env["PY_CRUCIBLE_PROJECT_DIR"] = self.project

    def spawn(self, argv):
        return subprocess.run(argv, cwd=self.project, env=self.env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    def both(self, *args):
        direct = self.spawn([sys.executable, str(CLIENT), *args])
        launched = self.spawn(launcher_command(CLIENT, *args, **SHORT))
        return direct, launched

    def assert_same(self, direct, launched):
        self.assertEqual(
            (launched.returncode, launched.stdout, launched.stderr),
            (direct.returncode, direct.stdout, direct.stderr),
            f"launched stderr={launched.stderr[-1500:]!r}")

    def test_help_exits_zero_with_the_same_text(self):
        direct, launched = self.both("--help")
        self.assertEqual(direct.returncode, 0, direct.stderr)
        self.assertIn("usage:", direct.stdout)
        self.assert_same(direct, launched)

    def test_an_unknown_verb_is_refused_with_the_same_exit_code(self):
        direct, launched = self.both("no-such-verb")
        self.assertEqual(direct.returncode, 2, direct.stderr)
        self.assert_same(direct, launched)

    def test_a_project_with_no_board_is_refused_naming_the_test_installs_file(self):
        args = ("status", "--project-dir", self.project)
        direct, launched = self.both(*args)
        said = direct.stdout + direct.stderr
        self.assertNotEqual(direct.returncode, 0, said)
        self.assertIn(str(TEST_INSTALL_CONFIG), said,
                      f"the directly spawned client names its install's file: {said!r}")
        self.assertNotIn("Traceback", launched.stderr)
        self.assert_same(direct, launched)
        self.assertNotIn(os.path.join(str(CLIENT.parent.resolve().parent), "crucible.toml"),
                         launched.stdout,
                         "the launched client never takes the repository root as its install")


if __name__ == "__main__":
    unittest.main()
