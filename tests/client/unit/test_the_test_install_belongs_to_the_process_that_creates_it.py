"""The test install belongs to the process that creates it.

The `tests.client` package lays down a test install once per run. Only the
process that CREATES it removes it, at exit; a child that finds it through
the marker variable reuses it and never removes it. Its name carries a fixed
prefix and the creating PID, so a run that was killed before its exit leaves
an install the NEXT creation sweeps: any prefixed install whose PID is dead.

The rules are driven here as functions over a directory the test owns, with
the PID-liveness check and the exit hook passed in as recording fakes: no
process is spawned, no process is killed, nothing waits on real time.

The package's surface, as these tests use it:

- `TEST_INSTALL_PREFIX`            the fixed name prefix
- `TEST_INSTALL_MARKER`            the variable naming the install
- `CLIENT_SOURCE_DIR`              the checkout's client source
- `install_owner_pid(name)`        the creating PID a name carries, or None
- `sweep_dead_installs(directory, pid_alive)`
                                   removes every prefixed install in
                                   `directory` whose PID is dead; answers the
                                   removed paths, sorted
- `establish_test_install(environ, pid, pid_alive, at_exit)`
                                   the install the marker in `environ` names
                                   when it exists (nothing registered at
                                   exit); else a new one under
                                   `tempfile.gettempdir()` named
                                   `<prefix><pid>-...`, after sweeping that
                                   directory, with its removal registered
                                   through `at_exit` and the marker set in
                                   `environ`
- `pid_alive(pid)`                 the real liveness check
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests import client as suite

#: PIDs no live process carries on this machine's default pid_max; the
#: liveness seam decides, so they are never signalled.
DEAD_PID = 999_999_901
LIVE_PID = 999_999_902
CREATOR_PID = 999_999_903

MISSING_SURFACE = ("the tests.client package exposes no `{name}`: the suite has "
                   "no test install ownership rules yet")


def surface(case, name):
    if not hasattr(suite, name):
        case.fail(MISSING_SURFACE.format(name=name))
    return getattr(suite, name)


class _alive_only:
    """A recording liveness seam: alive for `pids`, dead otherwise; `asked`
    holds every PID it was asked about."""

    def __init__(self, *pids):
        self.pids = set(pids)
        self.asked = []

    def __call__(self, pid):
        self.asked.append(pid)
        return pid in self.pids


class _ExitHook:
    """Records what `establish_test_install` registers to run at exit."""

    def __init__(self):
        self.calls = []

    def __call__(self, function, *args, **kwargs):
        self.calls.append((function, args, kwargs))

    def run(self):
        for function, args, kwargs in self.calls:
            function(*args, **kwargs)


class _ScratchParentCase(unittest.TestCase):

    def setUp(self):
        self.parent = tempfile.mkdtemp(prefix="test-install-ownership-")
        self.addCleanup(shutil.rmtree, self.parent, ignore_errors=True)

    def plant_install(self, pid, suffix="planted"):
        """A prefixed install, holding a `clients` symlink to a canary
        directory this test owns: removing the install must not follow it."""
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        install = Path(self.parent, f"{prefix}{pid}-{suffix}")
        install.mkdir()
        canary = Path(self.parent, f"canary-{pid}-{suffix}")
        canary.mkdir()
        (canary / "kept.py").write_text("# canary\n", encoding="utf-8")
        (install / "clients").symlink_to(canary, target_is_directory=True)
        (install / "crucible.toml").write_text("", encoding="utf-8")
        return install, canary

    def prefixed_entries(self):
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        return sorted(name for name in os.listdir(self.parent) if name.startswith(prefix))


class AnInstallNameCarriesItsCreatorTest(_ScratchParentCase):

    def test_the_owner_pid_is_read_back_from_a_prefixed_name(self):
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        install_owner_pid = surface(self, "install_owner_pid")
        self.assertEqual(install_owner_pid(f"{prefix}{DEAD_PID}-abc123"), DEAD_PID)
        self.assertEqual(install_owner_pid(os.path.join(self.parent, f"{prefix}42-x")), 42)

    def test_a_name_without_the_prefix_or_a_pid_has_no_owner(self):
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        install_owner_pid = surface(self, "install_owner_pid")
        self.assertIsNone(install_owner_pid(f"other-{DEAD_PID}-abc"))
        self.assertIsNone(install_owner_pid(f"{prefix}notapid-abc"))
        self.assertIsNone(install_owner_pid(f"{prefix}"))

    def test_this_runs_install_is_named_for_its_creator(self):
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        install_owner_pid = surface(self, "install_owner_pid")
        root = surface(self, "TEST_INSTALL_DIR")
        name = os.path.basename(os.path.abspath(str(root)))
        owner = install_owner_pid(name)
        self.assertIsInstance(owner, int)
        self.assertTrue(name.startswith(f"{prefix}{owner}-"), name)


class TheSweepRemovesOnlyDeadInstallsTest(_ScratchParentCase):

    def test_an_install_whose_pid_is_dead_is_removed_and_one_whose_pid_is_alive_is_kept(self):
        sweep = surface(self, "sweep_dead_installs")
        dead, dead_canary = self.plant_install(DEAD_PID)
        live, live_canary = self.plant_install(LIVE_PID)
        pid_alive = _alive_only(LIVE_PID)

        removed = sweep(self.parent, pid_alive)

        self.assertEqual([os.path.abspath(str(p)) for p in removed], [str(dead)])
        self.assertFalse(os.path.lexists(dead), "the dead run's install was left behind")
        self.assertTrue(live.is_dir(), "the live run's install was removed")
        self.assertTrue((live / "clients").is_symlink())
        self.assertEqual(sorted(set(pid_alive.asked)), sorted([DEAD_PID, LIVE_PID]))
        # Removing the install never follows its `clients` link.
        self.assertTrue((dead_canary / "kept.py").is_file())
        self.assertTrue((live_canary / "kept.py").is_file())

    def test_the_sweep_leaves_what_it_cannot_attribute(self):
        sweep = surface(self, "sweep_dead_installs")
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        unattributed = Path(self.parent, f"{prefix}notapid-x")
        unattributed.mkdir()
        foreign = Path(self.parent, f"someone-elses-{DEAD_PID}-x")
        foreign.mkdir()
        pid_alive = _alive_only()

        removed = sweep(self.parent, pid_alive)

        self.assertEqual(list(removed), [])
        self.assertTrue(unattributed.is_dir())
        self.assertTrue(foreign.is_dir())

    def test_the_real_liveness_check_answers_alive_for_this_process(self):
        pid_alive = surface(self, "pid_alive")
        self.assertIs(pid_alive(os.getpid()), True)


class CreatingAnInstallSweepsAndRegistersItsRemovalTest(_ScratchParentCase):

    def establish(self, environ, pid_alive, at_exit):
        establish = surface(self, "establish_test_install")
        with mock.patch.object(tempfile, "tempdir", self.parent):
            return establish(environ, pid=CREATOR_PID, pid_alive=pid_alive, at_exit=at_exit)

    def test_a_process_with_no_marker_creates_an_install_named_for_itself(self):
        prefix = surface(self, "TEST_INSTALL_PREFIX")
        marker = surface(self, "TEST_INSTALL_MARKER")
        source = surface(self, "CLIENT_SOURCE_DIR")
        before = os.environ.get(marker)
        environ, at_exit = {}, _ExitHook()

        install = self.establish(environ, _alive_only(), at_exit)

        self.assertEqual(os.path.dirname(os.path.abspath(str(install))),
                         os.path.abspath(self.parent),
                         "the install must be created under tempfile.gettempdir()")
        self.assertTrue(os.path.basename(str(install)).startswith(f"{prefix}{CREATOR_PID}-"))
        self.assertTrue(os.path.islink(os.path.join(install, "clients")))
        self.assertEqual(os.path.realpath(os.path.join(install, "clients")),
                         os.path.realpath(str(source)))
        self.assertTrue(os.path.isfile(os.path.join(install, "crucible.toml")))
        self.assertEqual(environ, {marker: str(install)})
        self.assertEqual(os.environ.get(marker), before,
                         "the process environment changed: only the given one may")
        self.assertEqual(len(at_exit.calls), 1, "exactly one removal is registered")

    def test_the_registered_removal_takes_the_install_and_never_the_client_source(self):
        source = surface(self, "CLIENT_SOURCE_DIR")
        at_exit = _ExitHook()
        install = self.establish({}, _alive_only(), at_exit)

        at_exit.run()

        self.assertFalse(os.path.lexists(install), "the creator's exit left its install")
        self.assertEqual(self.prefixed_entries(), [])
        self.assertTrue(os.path.isfile(os.path.join(str(source), "_crucible_axi.py")),
                        "removing the install followed its link into the client source")

    def test_creating_an_install_sweeps_a_killed_runs_and_keeps_a_live_runs(self):
        dead, _ = self.plant_install(DEAD_PID)
        live, _ = self.plant_install(LIVE_PID)
        at_exit = _ExitHook()

        install = self.establish({}, _alive_only(LIVE_PID, CREATOR_PID), at_exit)

        self.assertFalse(os.path.lexists(dead), "the killed run's install was not swept")
        self.assertTrue(live.is_dir(), "a live run's install was swept")
        self.assertEqual(
            self.prefixed_entries(),
            sorted([live.name, os.path.basename(str(install))]))

    def test_a_marker_naming_a_removed_install_creates_a_new_one(self):
        marker = surface(self, "TEST_INSTALL_MARKER")
        gone = os.path.join(self.parent, "an-install-that-is-gone")
        environ, at_exit = {marker: gone}, _ExitHook()

        install = self.establish(environ, _alive_only(), at_exit)

        self.assertNotEqual(os.path.abspath(str(install)), gone)
        self.assertTrue(os.path.isdir(install))
        self.assertEqual(environ[marker], str(install))
        self.assertEqual(len(at_exit.calls), 1)


class AReusingProcessNeverRemovesItsParentsInstallTest(_ScratchParentCase):

    def test_a_process_with_the_marker_reuses_the_install_and_registers_no_removal(self):
        marker = surface(self, "TEST_INSTALL_MARKER")
        establish = surface(self, "establish_test_install")
        parents, _ = self.plant_install(LIVE_PID, "parents")
        environ, at_exit = {marker: str(parents)}, _ExitHook()

        with mock.patch.object(tempfile, "tempdir", self.parent):
            install = establish(environ, pid=CREATOR_PID,
                                pid_alive=_alive_only(LIVE_PID), at_exit=at_exit)
        at_exit.run()

        self.assertEqual(os.path.abspath(str(install)), str(parents))
        self.assertEqual(at_exit.calls, [], "a reusing process registered a removal")
        self.assertTrue(parents.is_dir(), "the reusing process removed its parent's install")
        self.assertEqual(self.prefixed_entries(), [parents.name],
                         "a reusing process created an install of its own")
        self.assertEqual(environ, {marker: str(parents)})


if __name__ == "__main__":
    unittest.main()
