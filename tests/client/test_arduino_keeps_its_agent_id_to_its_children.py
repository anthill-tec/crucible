"""The arduino client keeps its agent id out of its own process environment.

`--agent` is the only identity source. The child processes the arduino client
spawns -- the native test runner (`make <target>`) and the firmware compiler
(`arduino-cli compile`) -- receive `AGENT_ID` in THEIR environment when
`--agent` is given, but the client's own `os.environ` is never written: a
caller that runs `main()` in-process (as many tests do) must find its
environment exactly as it left it. And an `AGENT_ID` that is merely present in
the environment is never a request to file a run: with no `--agent`, a run is
unfiled -- it runs, posts nothing, and exits with its own outcome.

What is observed, and how:

  * the in-process tests load the real client by file path, drive `main()`
    with `sys.argv` patched, against a `RecordingBoard` HTTP stand-in the
    project's `crucible.toml` points at, and compare `os.environ` before and
    after -- by key NAME only. Every in-process test restores the environment
    itself
    (`mock.patch.dict`), so nothing leaks whatever the outcome;
  * the child-environment tests put a stub `make` on PATH (and point the
    client's compiler path at a stub `arduino-cli`); each stub records only
    which `AGENT_ID` it sees in its own environment -- the `--agent` value,
    the ambient one, none, or another -- never the value itself, and behaves
    as the real tool would (a JUnit report, or a compile exit code);
  * the unfiled-run tests drive the real client as a subprocess with
    `AGENT_ID` in its environment and no `--agent`, and read the board.

Invocation:
    python3 -m unittest tests.client.test_arduino_keeps_its_agent_id_to_its_children -v
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import unittest
from unittest import mock

from tests.client.live_run_harness import (
    CLIENTS,
    ENV_KEYS_TO_SCRUB,
    RecordingBoard,
    install_project,
    new_scratch,
    scrubbed_env,
)

ARDUINO_SCRIPT = CLIENTS / "arduino-crucible.py"
TIMEOUT = 60
AGENT = "arduino-env-agent-7"
AMBIENT_AGENT = "ambient-env-agent-3"
PROJECT_KEY = "arduino-env-key"
PROJECT_NAME = "arduino-env-firmware"
NATIVE_CASES = 3
COMPILE_EXIT = 3
COMPILE_ERROR = "sketch.ino:4:1: error: 'undeclared_thing' was not declared"

# What a stub child reports about the AGENT_ID in its own environment. The
# stub classifies the value against the two ids this file uses and records
# ONLY the class, so no environment value ever reaches a capture file, an
# assertion or a failure message.
_CLASSIFY_AGENT_ID = """
def _classify(value):
    if value is None:
        return "absent"
    if value == %(flag)r:
        return "flag"
    if value == %(ambient)r:
        return "ambient"
    return "other"
"""

# A stub `make`: records which AGENT_ID class its own environment holds, then
# writes a passing JUnit report where the client's `make` contract says
# (REPORTS_DIR, else the native dir's own `reports/`), as `make junit` would.
_FAKE_MAKE_BODY = """
import json
import os
import sys
%(classify)s
with open(%(capture)r, "w") as handle:
    json.dump({"agent_id": _classify(os.environ.get("AGENT_ID")),
               "argv": sys.argv[1:]}, handle)
total = %(total)d
reports_dir = os.environ.get("REPORTS_DIR") or "reports"
os.makedirs(reports_dir, exist_ok=True)
cases = "".join('<testcase name="test_case_%%d" classname="native" time="0.001"/>' %% i
                for i in range(1, total + 1))
for i in range(1, total + 1):
    sys.stdout.write("test/test_main.c:%%d:test_case_%%d:PASS\\n" %% (10 + i, i))
sys.stdout.write("%%d Tests 0 Failures 0 Ignored\\nOK\\n" %% total)
with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as handle:
    handle.write('<?xml version="1.0"?><testsuite name="native" tests="%%d" '
                 'failures="0">%%s</testsuite>' %% (total, cases))
sys.exit(0)
"""

# A stub `arduino-cli`: records which AGENT_ID class its own environment
# holds, then compiles cleanly or fails with a compiler error and a specific
# exit code.
_FAKE_ARDUINO_CLI_BODY = """
import json
import os
import sys
%(classify)s
with open(%(capture)r, "w") as handle:
    json.dump({"agent_id": _classify(os.environ.get("AGENT_ID")),
               "argv": sys.argv[1:]}, handle)
exit_code = %(exit_code)d
if exit_code:
    sys.stderr.write(%(error)r + "\\n")
sys.exit(exit_code)
"""


def _classifier():
    return _CLASSIFY_AGENT_ID % {"flag": AGENT, "ambient": AMBIENT_AGENT}


def _write_executable(path, text):
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IRUSR)
    return path


def _write_fake_make(bin_dir, capture):
    return _write_executable(
        os.path.join(bin_dir, "make"),
        "#!" + sys.executable + "\n"
        + _FAKE_MAKE_BODY % {"capture": capture, "total": NATIVE_CASES,
                             "classify": _classifier()})


def _write_fake_arduino_cli(bin_dir, capture, exit_code):
    return _write_executable(
        os.path.join(bin_dir, "arduino-cli"),
        "#!" + sys.executable + "\n"
        + _FAKE_ARDUINO_CLI_BODY % {"capture": capture, "exit_code": exit_code,
                                    "error": COMPILE_ERROR,
                                    "classify": _classifier()})


def _changed_keys(before, after):
    """The NAMES of the keys `main()` added, removed or re-valued -- names
    only, so a failure message never carries an environment value."""
    return sorted(key for key in set(before) | set(after)
                  if before.get(key) != after.get(key))


def _read_capture(path):
    with open(path) as handle:
        return json.load(handle)


def _load_client_module(cache_key):
    spec = importlib.util.spec_from_file_location(cache_key, ARDUINO_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _call_main(module, argv):
    """Run `module.main()` with `sys.argv` patched -> (code, stdout, stderr).
    Only `SystemExit` is caught; anything else propagates as a test ERROR."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", ["arduino-crucible.py"] + argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


class _ArduinoProjectCase(unittest.TestCase):
    """A scratch firmware project wired to a `RecordingBoard`, a scratch bin
    dir for the stub toolchain, and a capture file each stub writes to."""

    def setUp(self):
        self.board = RecordingBoard()
        self.project = new_scratch("arduino-env-project-")
        self.bin_dir = new_scratch("arduino-env-bin-")
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)
        os.makedirs(os.path.join(self.project, "tests", "native"), exist_ok=True)
        self.capture = os.path.join(self.bin_dir, "child-env.json")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.bin_dir, ignore_errors=True)

    def _post_paths(self):
        return [path for path, _body in self.board.posts()]

    def _posts_under(self, path, agent):
        return [body for p, body in self.board.posts()
                if p == path and isinstance(body, dict)
                and body.get("agentId") == agent]

    def _drive_in_process(self, argv, cache_key, patches=()):
        """Drive `main()` in-process with AGENT_ID (and the harness's scrubbed
        workflow keys) absent from the starting environment and the stub bin
        dir first on PATH. The environment is restored on exit whatever
        happens. Returns (code, out, err, changed_keys, agent_id_left_behind):
        key NAMES and a boolean only, never an environment value."""
        module = _load_client_module(cache_key)
        with mock.patch.dict(os.environ):
            os.environ.pop("AGENT_ID", None)
            for key in ENV_KEYS_TO_SCRUB:
                os.environ.pop(key, None)
            os.environ["PATH"] = self.bin_dir + os.pathsep + os.environ.get("PATH", "")
            with contextlib.ExitStack() as stack:
                for name, value in patches:
                    stack.enter_context(mock.patch.object(module, name, value))
                before = dict(os.environ)
                code, out, err = _call_main(module, argv)
                after = dict(os.environ)
        return (code, out, err, _changed_keys(before, after),
                "AGENT_ID" in after)


class ArduinoMainNeverWritesItsOwnEnvironmentTest(_ArduinoProjectCase):
    """`main()` run in-process with `--agent` leaves `os.environ` holding no
    `AGENT_ID` -- and, more strictly, exactly as it found it."""

    def test_register_with_agent_leaves_no_agent_id_in_the_process_environment(self):
        code, out, err, changed, left_behind = self._drive_in_process(
            ["register", "--agent", AGENT, "--role", "report",
             "--project-dir", self.project],
            "arduino_env_register")

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        registrations = self._posts_under("/api/v2/agents/register", AGENT)
        self.assertEqual(
            len(registrations), 1,
            f"register --agent must post exactly one registration under "
            f"{AGENT!r}; posted paths: {self._post_paths()!r}")
        self.assertFalse(
            left_behind,
            "main() wrote AGENT_ID into its own process environment; --agent "
            "is handed to children, never exported into the caller's "
            "os.environ")
        self.assertEqual(
            changed, [],
            "main() must never write os.environ -- these keys differ after a "
            "register run")

    def test_test_run_with_agent_hands_the_runner_its_agent_id_and_leaves_none_behind(self):
        _write_fake_make(self.bin_dir, self.capture)
        code, out, err, changed, left_behind = self._drive_in_process(
            ["test", "--agent", AGENT, "--project-dir", self.project,
             "--dir", "tests/native"],
            "arduino_env_test_run")

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err[-1500:]!r}")
        seen = _read_capture(self.capture)
        self.assertEqual(seen["argv"], ["junit"],
                         "the client must spawn `make junit`")
        self.assertEqual(
            seen["agent_id"], "flag",
            "the native runner arduino spawned must see AGENT_ID set to the "
            "--agent value in its own environment (class seen shown)")
        ingests = self._posts_under("/api/v2/runs/parsed", AGENT)
        self.assertEqual(len(ingests), 1,
                         f"a filed run ingests exactly once under {AGENT!r}; "
                         f"posted paths: {self._post_paths()!r}")
        self.assertEqual(ingests[0]["summary"]["total"], NATIVE_CASES)
        self.assertEqual(ingests[0]["summary"]["passed"], NATIVE_CASES)
        self.assertFalse(
            left_behind,
            "main() wrote AGENT_ID into its own process environment while "
            "handing it to its runner")
        self.assertEqual(changed, [],
                         "main() must never write os.environ -- these keys "
                         "differ after a test run")

    def test_check_with_agent_hands_the_compiler_its_agent_id_and_leaves_none_behind(self):
        fake_cli = _write_fake_arduino_cli(self.bin_dir, self.capture, 0)
        code, out, err, changed, left_behind = self._drive_in_process(
            ["check", "--agent", AGENT, "--project-dir", self.project],
            "arduino_env_check",
            patches=(("ARDUINO_CLI", fake_cli),))

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err[-1500:]!r}")
        seen = _read_capture(self.capture)
        self.assertEqual(seen["argv"][:1], ["compile"],
                         "the client must spawn `arduino-cli compile`")
        self.assertEqual(
            seen["agent_id"], "flag",
            "the compiler arduino spawned must see AGENT_ID set to the "
            "--agent value in its own environment (class seen shown)")
        self.assertFalse(
            left_behind,
            "main() wrote AGENT_ID into its own process environment while "
            "handing it to the compiler")
        self.assertEqual(changed, [],
                         "main() must never write os.environ -- these keys "
                         "differ after a check")


class ArduinoChildProcessSeesTheAgentIdTest(_ArduinoProjectCase):
    """The real client, run as a subprocess with `--agent`, hands the native
    runner it spawns `AGENT_ID` set to that `--agent` -- including over an
    unrelated `AGENT_ID` already in the client's environment."""

    def _drive(self, extra_env):
        _write_fake_make(self.bin_dir, self.capture)
        env = scrubbed_env(self.bin_dir)
        env.pop("AGENT_ID", None)
        env.update(extra_env)
        cmd = [sys.executable, str(ARDUINO_SCRIPT), "test", "--agent", AGENT,
               "--project-dir", self.project, "--dir", "tests/native"]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def test_native_runner_of_a_filed_test_run_sees_the_agent_id(self):
        result = self._drive({})
        self.assertEqual(result.returncode, 0,
                         f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}")
        seen = _read_capture(self.capture)
        self.assertEqual(
            seen["agent_id"], "flag",
            "the native runner must see AGENT_ID set to the --agent value "
            "(class seen shown)")
        self.assertEqual(len(self._posts_under("/api/v2/runs/parsed", AGENT)), 1,
                         f"posted paths: {self._post_paths()!r}")

    def test_native_runner_sees_the_agent_flag_over_an_ambient_agent_id(self):
        result = self._drive({"AGENT_ID": AMBIENT_AGENT})
        self.assertEqual(result.returncode, 0,
                         f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}")
        seen = _read_capture(self.capture)
        self.assertEqual(
            seen["agent_id"], "flag",
            "--agent decides the child's AGENT_ID, never an ambient one "
            "(class seen shown)")
        self.assertEqual(len(self._posts_under("/api/v2/runs/parsed", AGENT)), 1,
                         f"posted paths: {self._post_paths()!r}")
        self.assertEqual(self._posts_under("/api/v2/runs/parsed", AMBIENT_AGENT), [],
                         "nothing may be filed under the ambient AGENT_ID")


class AnAmbientAgentIdIsNotARequestToFileTest(_ArduinoProjectCase):
    """With `AGENT_ID` in the environment and NO `--agent`, a run is unfiled:
    the suite (or compile) runs, nothing is posted to the board, and the
    client exits with the run's own outcome -- never the identity hard stop."""

    def _run_client(self, argv, path_prefix=None, **extra_env):
        env = scrubbed_env(path_prefix, AGENT_ID=AMBIENT_AGENT, **extra_env)
        cmd = [sys.executable, str(ARDUINO_SCRIPT), *argv,
               "--project-dir", self.project]
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def test_test_run_with_ambient_agent_id_and_no_agent_runs_the_suite_and_posts_nothing(self):
        _write_fake_make(self.bin_dir, self.capture)
        result = self._run_client(["test", "--dir", "tests/native"],
                                  path_prefix=self.bin_dir)

        self.assertTrue(os.path.exists(self.capture),
                        f"the suite must run; stderr={result.stderr[-1500:]!r}")
        self.assertNotIn(
            "agent-identity-required", result.stdout + result.stderr,
            "an ambient AGENT_ID with no --agent was read as a request to "
            "file the run, which then hit the identity hard stop")
        self.assertEqual(
            result.returncode, 0,
            f"an unfiled run with no failures exits 0; got "
            f"{result.returncode}; stdout={result.stdout!r} "
            f"stderr={result.stderr[-1500:]!r}")
        self.assertIn(f"{NATIVE_CASES}/{NATIVE_CASES} passed", result.stderr,
                      "the unfiled run reports its own outcome")
        self.assertEqual(self._post_paths(), [],
                         "an unfiled run posts nothing to the board")

    def test_failing_check_with_ambient_agent_id_and_no_agent_files_nothing(self):
        fake_cli = _write_fake_arduino_cli(self.bin_dir, self.capture, COMPILE_EXIT)
        result = self._run_client(["check"], ARDUINO_CLI=fake_cli)

        self.assertTrue(os.path.exists(self.capture),
                        f"the compile must run; stderr={result.stderr[-1500:]!r}")
        self.assertNotIn(
            "agent-identity-required", result.stdout + result.stderr,
            "an ambient AGENT_ID with no --agent was read as a request to "
            "file the compile failure, which then hit the identity hard stop")
        self.assertEqual(
            result.returncode, COMPILE_EXIT,
            f"an unfiled failing compile exits with the compiler's own code "
            f"({COMPILE_EXIT}); got {result.returncode}; "
            f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}")
        self.assertIn(COMPILE_ERROR, result.stderr,
                      "an unfiled compile failure is written to stderr, not filed")
        self.assertEqual(self._post_paths(), [],
                         "an unfiled compile failure posts nothing to the board")


if __name__ == "__main__":
    unittest.main()
