"""The installer tests that fill an older install's connection run in a
throwaway home, never in the operator's.

These modules drive the REAL `[manifest]`, `[config]` and `[store]` stages,
which write beside `$HOME`, `$XDG_DATA_HOME` and `$XDG_CONFIG_HOME` and read
the provisioned server from `$BUN_INSTALL`. A sandbox that stopped pinning
one of them would install into the operator's own machine, beside a live
board, and every assertion would still pass.

So each module's sandbox is set up here and asked, the way the installed
deployment suite asks its own: is every one of those variables the sandbox's
OWN value, inside its own temporary root, and not the operator's real home?
And every test class in the module that installs anything is a sandbox
class: a class that drives an install without it fails here by name.
"""

import inspect
import os
import pwd
import tempfile
import unittest

from tests.client import (
    test_a_reinstall_fills_a_missing_url_and_port_keeping_the_live_port as fills,
)
from tests.client import (
    test_cr139_installer_writes_the_connection as connection,
)

#: The operator's real home, from the password database. Compared against
#: only; nothing under it is opened.
REAL_HOME = os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)

#: Each pinned variable, and the sandbox attribute that holds its value.
PINNED = {
    "HOME": "fake_home",
    "XDG_DATA_HOME": "xdg_data",
    "XDG_CONFIG_HOME": "xdg_config",
    "BUN_INSTALL": "bun_root",
}

#: What a test class calls to install or uninstall for real.
_INSTALLING_CALLS = ("install_once", "run_install", "run_uninstall",
                     "cli_install", "cli.main(")

#: The modules whose installer tests are held to the sandbox.
MODULES = (fills, connection)

#: The sandbox both modules build their installs on.
SANDBOX = connection._InstallerConnectionCase


def _test_classes(module):
    return [value for value in vars(module).values()
            if isinstance(value, type) and issubclass(value, unittest.TestCase)
            and value.__module__ == module.__name__
            and unittest.defaultTestLoader.getTestCaseNames(value)]


def _inside(root, path):
    root = os.path.realpath(root)
    return os.path.commonpath([root, os.path.realpath(path)]) == root


class EveryInstallerTestRunsInAThrowawayHomeTest(unittest.TestCase):

    def test_each_modules_sandbox_pins_home_and_the_xdg_dirs_inside_its_own_temp_root(self):
        for module in MODULES:
            classes = [cls for cls in _test_classes(module)
                       if issubclass(cls, SANDBOX)]
            self.assertTrue(
                classes, f"{module.__name__} has no sandboxed test class")
            for cls in classes:
                with self.subTest(module=module.__name__, case=cls.__name__):
                    name = unittest.defaultTestLoader.getTestCaseNames(cls)[0]
                    case = cls(name)
                    self.assertIsInstance(case, SANDBOX)
                    assert isinstance(case, SANDBOX)
                    before = os.environ.get("HOME")
                    case.setUp()
                    try:
                        root = case.root
                        self.assertTrue(
                            _inside(tempfile.gettempdir(), root),
                            f"{cls.__name__}'s root {root} must be a "
                            "temporary directory")
                        for variable, attribute in PINNED.items():
                            value = os.environ.get(variable)
                            self.assertEqual(
                                getattr(case, attribute), value,
                                f"{cls.__name__} must PIN ${variable} "
                                "itself, never inherit it")
                            self.assertTrue(
                                value is not None and _inside(root, value),
                                f"{cls.__name__}'s ${variable} ({value}) "
                                f"must be inside its own root {root}")
                        self.assertNotEqual(
                            REAL_HOME, os.path.realpath(os.environ["HOME"]),
                            f"{cls.__name__} must never install in the "
                            "operator's real home")
                        self.assertTrue(
                            _inside(root, case.install.store_dir()),
                            f"{cls.__name__}'s server store must be inside "
                            "its own root")
                    finally:
                        case.doCleanups()
                    self.assertEqual(
                        before, os.environ.get("HOME"),
                        f"{cls.__name__} must give $HOME back on teardown")

    def test_every_test_class_that_installs_is_a_sandbox_class(self):
        for module in MODULES:
            for cls in _test_classes(module):
                if issubclass(cls, SANDBOX):
                    continue
                source = inspect.getsource(cls)
                with self.subTest(module=module.__name__, case=cls.__name__):
                    for call in _INSTALLING_CALLS:
                        self.assertNotIn(
                            call, source,
                            f"{cls.__name__} installs ({call}) outside the "
                            "installer sandbox, so nothing pins its $HOME")


if __name__ == "__main__":
    unittest.main()
