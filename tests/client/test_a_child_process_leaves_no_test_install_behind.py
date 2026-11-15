"""A child process that imports the suite's package leaves no test install.

Tier: integration. This is the one leg of the test install's ownership that
needs a real process: a `sys.executable` child that imports `tests.client`
and exits. Its temp root is a directory this test owns (`TMPDIR`), its
working directory is that directory, it reaches no board and opens no socket.

- With no marker, the child CREATES an install named for its own PID, and
  its exit removes it: the temp root holds no prefixed entry afterwards.
- With the parent's marker, the child REUSES the parent's install and its
  exit leaves it in place.

The ownership rules themselves (the sweep, the liveness check, the exit
hook) are proved in process, without a child, beside this module.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests import client as suite

REPO_ROOT = Path(__file__).resolve().parents[2]

#: What the child prints: its PID, the install it took, and what it found
#: there while it was alive.
CHILD_PROGRAM = (
    "import json, os\n"
    "import tests.client as c\n"
    "root = str(c.TEST_INSTALL_DIR)\n"
    "print(json.dumps({'pid': os.getpid(), 'root': root,\n"
    "                  'clients_is_link': os.path.islink(os.path.join(root, 'clients')),\n"
    "                  'has_config': os.path.isfile(os.path.join(root, 'crucible.toml'))}))\n"
)

CHILD_TIMEOUT_SECONDS = 60

MISSING_SURFACE = ("the tests.client package exposes no `{name}`: the suite has "
                   "no test install helper yet")


def surface(case, name):
    if not hasattr(suite, name):
        case.fail(MISSING_SURFACE.format(name=name))
    return getattr(suite, name)


class AChildProcessLeavesNoTestInstallBehindTest(unittest.TestCase):

    def setUp(self):
        self.temp_root = tempfile.mkdtemp(prefix="test-install-child-")
        self.addCleanup(shutil.rmtree, self.temp_root, ignore_errors=True)

    def run_child(self, environ):
        environ = {**environ, "TMPDIR": self.temp_root,
                   "PYTHONPATH": str(REPO_ROOT), "PYTHONDONTWRITEBYTECODE": "1"}
        completed = subprocess.run(
            [sys.executable, "-c", CHILD_PROGRAM], cwd=self.temp_root, env=environ,
            capture_output=True, text=True, timeout=CHILD_TIMEOUT_SECONDS)
        self.assertEqual(completed.returncode, 0,
                         f"the child failed:\n{completed.stderr[-2000:]}")
        lines = completed.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, f"the child printed {completed.stdout!r}")
        return json.loads(lines[0])

    def prefixed_entries(self):
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        return sorted(name for name in os.listdir(self.temp_root) if name.startswith(prefix))

    def test_a_child_with_no_marker_creates_its_own_install_and_its_exit_removes_it(self):
        marker = surface(self, "TEST_INSTALL_MARKER")
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        environ = {key: value for key, value in os.environ.items() if key != marker}

        seen = self.run_child(environ)

        self.assertEqual(os.path.dirname(seen["root"]), os.path.abspath(self.temp_root),
                         "the child's install was not created under its own temp root")
        self.assertTrue(os.path.basename(seen["root"]).startswith(f"{prefix}{seen['pid']}-"),
                        f"the child's install {seen['root']} is not named for its PID")
        self.assertTrue(seen["clients_is_link"])
        self.assertTrue(seen["has_config"])
        self.assertFalse(os.path.lexists(seen["root"]), "the child's exit left its install")
        self.assertEqual(self.prefixed_entries(), [])

    def test_a_child_with_the_marker_reuses_the_parents_install_and_leaves_it(self):
        marker = surface(self, "TEST_INSTALL_MARKER")
        parents = surface(self, "TEST_INSTALL_DIR")
        environ = {**os.environ, marker: str(parents)}

        seen = self.run_child(environ)

        self.assertEqual(seen["root"], str(parents))
        self.assertTrue(os.path.isdir(parents), "the child removed its parent's install")
        self.assertTrue(os.path.islink(os.path.join(str(parents), "clients")))
        self.assertTrue(os.path.isfile(os.path.join(str(parents), "crucible.toml")))
        self.assertEqual(self.prefixed_entries(), [],
                         "the reusing child created an install of its own")


if __name__ == "__main__":
    unittest.main()
