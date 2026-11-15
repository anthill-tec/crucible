"""A symlinked install runs a project's tests (CR-CRU-260 AC11).

`python-crucible.py` runs the fleet's unittest runner, `subtest_runner.py`,
BY PATH. Run that way, Python puts the script's own directory first on
`sys.path` -- and it puts the REAL path there, the symlinks resolved. The
runner's `_restore_module_search_path` swaps that entry for the working
directory, which is what a dotted test target and a project-local import rely
on (`python -m` puts the working directory there).

The runner recognises "its own directory" from its `__file__`. Reached
through a symlinked `clients/` (the suite's test install, or an operator's
linked install) `__file__` is the LINK path while `sys.path[0]` is the real
one: compared as they are, the two never match, the working directory never
arrives, and the project's own modules do not import. AC11: the comparison is
made on real paths, on both sides.

Every test here is UNIT: the runner is loaded in process from a directory the
test owns (a `<tmp>/install/clients` symlink to the client source, or a copy
of the runner under `<tmp>/copied-install/clients`), `sys.path` is replaced
for the one call under `mock.patch.object` and restored by it, and the working
directory is a project directory the test owns, restored in a cleanup. No
process, no socket, no wait.

The integration proof is the 66 tests GREEN 961 saw fail on this defect
(sweep 9 `evt-1794777407866-187`, sweep 12 `evt-1794777882062-190`): a client
spawning the runner, and the runner spawned directly, from the test install.
They are the regression set and are not duplicated here.
"""

import importlib.util
import itertools
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from tests.client import CLIENT_SOURCE_DIR

#: The runner's file name, the same in the source and in every install.
RUNNER_NAME = "subtest_runner.py"

#: A directory that is neither the runner's nor the project's: a search path
#: entry the restore must keep where it is.
UNRELATED_ENTRY = os.path.join(os.sep, "unrelated", "site-packages")

_LOADS = itertools.count()


def _load_runner(path):
    """A fresh module object for the runner at `path`, never registered in
    `sys.modules`: its `__file__` is `path` exactly as given, a link left
    unresolved, which is how a script reached through a link sees itself."""
    spec = importlib.util.spec_from_file_location(
        f"tests_client_symlinked_runner_{next(_LOADS)}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load the runner {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _restored(runner, entries):
    """`sys.path` after `runner._restore_module_search_path()`, run with
    `sys.path` replaced by a list of `entries` (restored on return)."""
    search_path = list(entries)
    with mock.patch.object(sys, "path", search_path):
        runner._restore_module_search_path()
    return search_path


class ASymlinkedInstallRunsAProjectsTestsTest(unittest.TestCase):
    """The runner puts the working directory first however it was reached."""

    def setUp(self):
        root = tempfile.mkdtemp(prefix="crucible-symlinked-runner-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)

        # The project the runner is started in: a directory this test owns.
        project = os.path.join(root, "project")
        os.makedirs(project)

        # A linked install: `<tmp>/install/clients -> <client source>`.
        linked_install = os.path.join(root, "install")
        os.makedirs(linked_install)
        self.linked_clients = os.path.join(linked_install, "clients")
        os.symlink(CLIENT_SOURCE_DIR, self.linked_clients, target_is_directory=True)

        # A straight install: the runner copied into a real `clients/` dir.
        copied_install = os.path.join(root, "copied-install")
        self.copied_clients = os.path.join(copied_install, "clients")
        os.makedirs(self.copied_clients)
        shutil.copy2(os.path.join(CLIENT_SOURCE_DIR, RUNNER_NAME), self.copied_clients)

        # What Python puts first on `sys.path` for a script run by path: the
        # script's directory with every link resolved.
        self.linked_real = os.path.realpath(self.linked_clients)
        self.copied_real = os.path.realpath(self.copied_clients)

        previous = os.getcwd()
        os.chdir(project)
        self.addCleanup(os.chdir, previous)
        # The working directory as the runner reads it (`os.getcwd()`).
        self.project = os.getcwd()

        self.assertNotEqual(
            self.linked_clients, self.linked_real,
            "fixture: the linked install's `clients` must be a link whose "
            "real path differs from it")
        self.assertEqual(
            os.path.realpath(self.project), os.path.realpath(project),
            "fixture: the working directory must be the project this test owns")

    def linked_runner(self):
        runner = _load_runner(os.path.join(self.linked_clients, RUNNER_NAME))
        self.assertEqual(
            os.path.dirname(runner.__file__ or ""), self.linked_clients,
            "fixture: the runner must be reached through the link, its "
            "`__file__` the link path")
        return runner

    def copied_runner(self):
        runner = _load_runner(os.path.join(self.copied_clients, RUNNER_NAME))
        self.assertEqual(
            os.path.dirname(runner.__file__ or ""), self.copied_clients,
            "fixture: the runner must be loaded from the straight install")
        return runner

    def test_a_runner_reached_through_a_symlinked_clients_dir_puts_the_working_directory_first(self):
        runner = self.linked_runner()

        search_path = _restored(runner, [self.linked_real, UNRELATED_ENTRY])

        self.assertEqual(
            search_path[0], self.project,
            f"AC11: run through the linked install {self.linked_clients}, "
            f"Python puts the runner's REAL directory {self.linked_real} first "
            f"on sys.path; `_restore_module_search_path` must replace it with "
            f"the working directory {self.project} (real paths compared on "
            f"both sides). sys.path is now {search_path!r}")
        self.assertEqual(
            search_path[1:], [UNRELATED_ENTRY],
            f"only sys.path[0] is replaced; the rest stays as it was: {search_path!r}")

    def test_a_runner_loaded_straight_from_its_own_directory_still_puts_the_working_directory_first(self):
        runner = self.copied_runner()

        search_path = _restored(runner, [self.copied_real, UNRELATED_ENTRY])

        self.assertEqual(
            search_path, [self.project, UNRELATED_ENTRY],
            f"run straight from {self.copied_clients} (no link), the runner's "
            f"own directory first on sys.path must still become the working "
            f"directory {self.project}, the rest untouched: {search_path!r}")

    def test_a_search_path_led_by_another_directory_is_left_alone(self):
        for shape, runner, own_real in (
                ("linked", self.linked_runner(), self.linked_real),
                ("straight", self.copied_runner(), self.copied_real)):
            with self.subTest(install=shape):
                entries = [UNRELATED_ENTRY, own_real]

                search_path = _restored(runner, entries)

                self.assertEqual(
                    search_path, entries,
                    f"{shape}: sys.path[0] is not the runner's own directory "
                    f"(`-m`, or PYTHONSAFEPATH with a PYTHONPATH entry first), "
                    f"so nothing is replaced -- not even the runner's directory "
                    f"further down: {search_path!r}")

    def test_an_empty_search_path_is_left_empty(self):
        for shape, runner in (("linked", self.linked_runner()),
                              ("straight", self.copied_runner())):
            with self.subTest(install=shape):
                search_path = _restored(runner, [])

                self.assertEqual(
                    search_path, [],
                    f"{shape}: an empty sys.path has no first entry to replace, "
                    f"and nothing is added: {search_path!r}")


if __name__ == "__main__":
    unittest.main()
