"""The test-only launcher runs the exact client it is given, on the settings
it is given, as running that client directly would.

`tests/client/short_cadence_launcher.py` is loaded by path and its `main` is
called in process with a stand-in client written into a scratch directory:
a file that carries a settings instance behind `_axi()` and whose `main()`
records what it saw. The launcher:

  - loads exactly the path it is handed (a path through a linked directory
    stays that path), never under the name `__main__`;
  - sets `sys.argv` to `[client path, *verb args]` and `sys.path[0]` to the
    client's directory;
  - sets each value given as an attribute of the client's one settings
    instance, never rebinding it, and leaves every other attribute alone;
  - refuses a value below its safe minimum before loading the client, and a
    client with no settings instance, or no such attribute, loudly;
  - runs `main()` on the main thread, catching nothing (an exception and a
    `SystemExit` code reach its caller unchanged) and installing no signal
    handler.

Unit tier: no process and no socket. Each test restores `sys.argv`,
`sys.path` and `sys.modules`, and removes its scratch directory.
"""

import importlib.util
import os
import shutil
import signal
import sys
import tempfile
import unittest
from pathlib import Path

LAUNCHER_PATH = Path(__file__).resolve().parents[1] / "short_cadence_launcher.py"

FAKE_CLIENT = '''
import signal
import sys
import threading

class _Settings:
    def __init__(self):
        self.relay_seconds = 2.0
        self.narrator_seconds = 2.0
        self.gate_poll_cadence_seconds = 2.0
        self.gate_poll_tick_seconds = 0.4
        self.read_timeout_seconds = 10

SETTINGS = _Settings()
SETTINGS_AT_LOAD = SETTINGS

class _Core:
    pass

_Core.SETTINGS = SETTINGS

def _axi():
    return _Core

RECORD = {}
MAIN_RAN_AT_LOAD = __name__ == "__main__"

def main():
    RECORD["argv"] = list(sys.argv)
    RECORD["path0"] = sys.path[0]
    RECORD["main_thread"] = threading.current_thread() is threading.main_thread()
    RECORD["settings"] = dict(vars(_axi().SETTINGS))
    RECORD["same_instance"] = _axi().SETTINGS is SETTINGS_AT_LOAD
    RECORD["sigint"] = signal.getsignal(signal.SIGINT)
    RECORD["file"] = __file__
    RECORD["name"] = __name__
    BEHAVIOUR()

def BEHAVIOUR():
    return None
'''

RAISES = FAKE_CLIENT + '''
def BEHAVIOUR():
    raise RuntimeError("the client's own failure")
'''

EXITS = FAKE_CLIENT + '''
def BEHAVIOUR():
    sys.exit(130)
'''

NO_SETTINGS = '''
class _Core:
    pass

def _axi():
    return _Core

def main():
    raise AssertionError("main must not run without a settings instance")
'''


def _load_launcher():
    spec = importlib.util.spec_from_file_location("short_cadence_launcher_under_test",
                                                  LAUNCHER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LauncherCase(unittest.TestCase):

    def setUp(self):
        self.launcher = _load_launcher()
        self.scratch = Path(tempfile.mkdtemp(prefix="short-cadence-launcher-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        saved_argv, saved_path = list(sys.argv), list(sys.path)
        name = self.launcher.CLIENT_MODULE_NAME
        saved_module = sys.modules.get(name)

        def restore():
            sys.argv = saved_argv
            sys.path[:] = saved_path
            if saved_module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved_module

        self.addCleanup(restore)
        self.sigint_before = signal.getsignal(signal.SIGINT)

    def write_client(self, text, directory="install/clients", name="python-crucible.py"):
        folder = self.scratch / directory
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / name
        path.write_text(text, encoding="utf-8")
        return path

    def loaded(self):
        return sys.modules[self.launcher.CLIENT_MODULE_NAME]


class TheLauncherRunsTheClientAsItWouldRunTest(LauncherCase):

    def test_the_client_sees_its_own_path_and_verb_args_as_argv(self):
        client = self.write_client(FAKE_CLIENT)
        self.launcher.main([str(client), "test", "--agent", "a-1", "--", "x"])
        record = self.loaded().RECORD
        self.assertEqual(record["argv"], [str(client), "test", "--agent", "a-1", "--", "x"])
        self.assertEqual(record["path0"], str(client.parent))
        self.assertTrue(record["main_thread"], "main() runs on the main thread")
        self.assertEqual(record["name"], self.launcher.CLIENT_MODULE_NAME)
        self.assertFalse(self.loaded().MAIN_RAN_AT_LOAD,
                         "the client is never loaded as __main__")

    def test_a_relative_client_path_is_made_absolute(self):
        client = self.write_client(FAKE_CLIENT)
        relative = os.path.relpath(client)
        self.launcher.main([relative, "status"])
        self.assertEqual(self.loaded().RECORD["argv"], [str(client), "status"])

    def test_a_client_reached_through_a_linked_directory_keeps_the_linked_path(self):
        real = self.write_client(FAKE_CLIENT, directory="source/clients")
        install = self.scratch / "install"
        install.mkdir()
        os.symlink(real.parent, install / "clients", target_is_directory=True)
        linked = install / "clients" / real.name
        self.launcher.main([str(linked), "status"])
        record = self.loaded().RECORD
        self.assertEqual(record["file"], str(linked),
                         "the client is loaded from the path it was handed, links kept")
        self.assertEqual(record["path0"], str(install / "clients"))
        self.assertEqual(record["argv"][0], str(linked))

    def test_no_signal_handler_is_installed(self):
        client = self.write_client(FAKE_CLIENT)
        self.launcher.main([str(client), "status"])
        self.assertIs(self.loaded().RECORD["sigint"], self.sigint_before)
        self.assertIs(signal.getsignal(signal.SIGINT), self.sigint_before)


class TheLauncherSetsTheSettingsItIsGivenTest(LauncherCase):

    def test_each_value_given_is_set_on_the_one_instance_and_the_rest_kept(self):
        client = self.write_client(FAKE_CLIENT)
        self.launcher.main(["--relay-seconds", "0.2", "--gate-poll-tick-seconds", "0.05",
                            "--read-timeout-seconds", "1", str(client), "test"])
        record = self.loaded().RECORD
        self.assertTrue(record["same_instance"], "the instance is never rebound")
        self.assertEqual(record["settings"],
                         {"relay_seconds": 0.2, "narrator_seconds": 2.0,
                          "gate_poll_cadence_seconds": 2.0,
                          "gate_poll_tick_seconds": 0.05,
                          "read_timeout_seconds": 1.0})
        self.assertEqual(record["argv"], [str(client), "test"])

    def test_every_setting_has_a_flag(self):
        client = self.write_client(FAKE_CLIENT)
        self.launcher.main(["--relay-seconds", "0.2", "--narrator-seconds", "0.3",
                            "--gate-poll-cadence-seconds", "0.4",
                            "--gate-poll-tick-seconds", "0.06",
                            "--read-timeout-seconds", "1.5", str(client)])
        self.assertEqual(self.loaded().RECORD["settings"],
                         {"relay_seconds": 0.2, "narrator_seconds": 0.3,
                          "gate_poll_cadence_seconds": 0.4,
                          "gate_poll_tick_seconds": 0.06,
                          "read_timeout_seconds": 1.5})

    def test_a_value_below_its_safe_minimum_is_refused_before_the_client_loads(self):
        client = self.write_client(FAKE_CLIENT)
        for flag, value in (("--relay-seconds", "0.1"), ("--narrator-seconds", "0.19"),
                            ("--gate-poll-cadence-seconds", "0.2"),
                            ("--gate-poll-tick-seconds", "0.04"),
                            ("--read-timeout-seconds", "0.9")):
            with self.subTest(flag=flag):
                self.assert_refused(flag, value, client)

    def assert_refused(self, flag, value, client):
        with self.assertRaises(SystemExit) as refused:
            self.launcher.main([flag, value, str(client), "status"])
        self.assertEqual(refused.exception.code, 2)
        self.assertNotIn(self.launcher.CLIENT_MODULE_NAME, sys.modules)

    def test_a_client_with_no_settings_instance_fails_loudly(self):
        client = self.write_client(NO_SETTINGS)
        with self.assertRaises(AttributeError) as failed:
            self.launcher.main(["--relay-seconds", "0.2", str(client), "status"])
        self.assertIn("SETTINGS", str(failed.exception))

    def test_a_settings_instance_without_the_attribute_fails_loudly(self):
        client = self.write_client(FAKE_CLIENT.replace(
            "        self.narrator_seconds = 2.0\n", ""))
        with self.assertRaises(AttributeError) as failed:
            self.launcher.main(["--narrator-seconds", "0.2", str(client), "status"])
        self.assertIn("narrator_seconds", str(failed.exception))
        self.assertEqual(self.loaded().RECORD, {}, "main() never ran")


class TheLauncherCatchesNothingTest(LauncherCase):

    def test_the_clients_exception_reaches_the_caller_unchanged(self):
        client = self.write_client(RAISES)
        with self.assertRaises(RuntimeError) as failed:
            self.launcher.main([str(client), "status"])
        self.assertEqual(str(failed.exception), "the client's own failure")

    def test_the_clients_exit_code_reaches_the_caller_unchanged(self):
        client = self.write_client(EXITS)
        with self.assertRaises(SystemExit) as exited:
            self.launcher.main(["--relay-seconds", "0.2", str(client), "test"])
        self.assertEqual(exited.exception.code, 130)


if __name__ == "__main__":
    unittest.main()
