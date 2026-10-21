"""The arduino client names its compile format on every compile ingest.

The arduino client's compile ingest (`_ingest_compile`) is the one path to
`/api/v2/runs/compile`, and it serves the `check` and `compile` verbs (through
`_compile_gate` -> `_compile_run`) and `pre-merge-gate`'s fail-fast compile
step (through `_compile_run` directly). arduino-cli's failures are gcc
diagnostics, so the body it sends states `"format": "gcc"`, as the rust client
states `"rustc"`, instead of leaving the board to guess.

Each entry point is driven through the client's own code: `_post` records every
body, `_get` answers as an offline board, and arduino-cli is replaced by a fake
`subprocess.run` that fails the way the real one does on the client's default
board (`tests/fixtures/arduino-cli/renesas-uno-minima-default.txt`, its
`Used platform` table on stdout and its diagnostics on stderr). No toolchain is
needed and no live board is touched.
"""

import argparse
import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    declare_board,
    install_project_limits,
)

REPO = Path(__file__).resolve().parents[2]
CLIENT_PATH = REPO / "clients" / "arduino-crucible.py"
FIXTURE = REPO / "tests" / "fixtures" / "arduino-cli" / "renesas-uno-minima-default.txt"

COMPILE = "/api/v2/runs/compile"
RUN_START = "/api/v2/runs/start"

AGENT = "arduino-compile-format-probe"
PROJECT_KEY = "arduino-compile-format-project-key"
UNREACHABLE_BOARD = "http://127.0.0.1:1"
FAKE_CLI = "/nonexistent/fake-arduino-cli"

INGEST_OK = {"ok": True, "event": "evt-arduino-compile-format"}
BOARD_OFFLINE = {"ok": False, "error": "connection failed: board offline"}

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE")

ANSI_RED = "\x1b[31m"
ANSI_RESET = "\x1b[0m"


def _split_fixture():
    """The fixture in terminal order, split back into the two streams
    arduino-cli wrote: the `Used platform` table went to stdout, the gcc
    diagnostics and the closing `Error during build` line to stderr. Returns
    `(stdout, stderr, expected_errors)`, where `expected_errors` is what the
    client sends: stdout then stderr, trimmed, with no colour codes."""
    text = FIXTURE.read_text(encoding="utf-8")
    diagnostics, tail = text.split("\n\n", 1)
    tail_lines = tail.rstrip("\n").split("\n")
    table = [line for line in tail_lines if not line.startswith("Error during build")]
    closing = [line for line in tail_lines if line.startswith("Error during build")]
    if len(table) != 2 or len(closing) != 1:
        raise AssertionError("the fixture no longer has its two-line platform "
                             "table and one `Error during build` line")
    stdout = "\n".join(table) + "\n"
    # Real arduino-cli colours its closing line; the client strips the codes.
    stderr = (diagnostics + "\n\n" + ANSI_RED + closing[0] + ANSI_RESET + "\n")
    expected = "\n".join(table) + "\n" + diagnostics + "\n\n" + closing[0]
    return stdout, stderr, expected


class _RecordingPost:
    """The client's `_post` seam: records every (path, body), answers `ok`."""

    def __init__(self):
        self.calls = []

    def __call__(self, path, payload=None, *_args, **_kwargs):
        self.calls.append((path, dict(payload or {})))
        return dict(INGEST_OK)

    def bodies(self, path):
        return [body for posted, body in self.calls if posted == path]

    def paths(self):
        return [posted for posted, _body in self.calls]


class _FakeArduinoCli:
    """A `subprocess.run` that answers the client's arduino-cli spawn with a
    failing compile and hands every other spawn to the real one."""

    def __init__(self, real_run, stdout, stderr, returncode=1):
        self.real_run = real_run
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode
        self.spawns = []

    def __call__(self, cmd, *args, **kwargs):
        if isinstance(cmd, (list, tuple)) and cmd and cmd[0] == FAKE_CLI:
            self.spawns.append((list(cmd), dict(kwargs)))
            return subprocess.CompletedProcess(cmd, self.returncode,
                                               stdout=self.stdout,
                                               stderr=self.stderr)
        return self.real_run(cmd, *args, **kwargs)


class ArduinoCompileIngestNamesTheGccFormatTest(unittest.TestCase):
    """One throwaway project per test, the client loaded fresh."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "arduino_crucible_under_compile_format", CLIENT_PATH)
        assert spec is not None and spec.loader is not None
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.project_dir = tempfile.mkdtemp(prefix="arduino-compile-format-")
        self.addCleanup(shutil.rmtree, self.project_dir, ignore_errors=True)
        with open(os.path.join(self.project_dir, ".env"), "w") as handle:
            handle.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        install_project_limits(self.project_dir)
        declare_board(Path(self.project_dir) / "crucible.toml", UNREACHABLE_BOARD)
        saved = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self.addCleanup(self._restore_env, saved)
        self.stdout, self.stderr, self.expected_errors = _split_fixture()

    @staticmethod
    def _restore_env(saved):
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _drive(self, body):
        """Run `body` with `_post` recording, `_get` offline and arduino-cli
        faked; returns `(recorder, fake_cli, exit_code)`."""
        recorder = _RecordingPost()
        fake_cli = _FakeArduinoCli(subprocess.run, self.stdout, self.stderr)
        result: dict = {"exit": None}
        with mock.patch.object(self.module, "_post", side_effect=recorder,
                               create=True), \
                mock.patch.object(self.module, "_get", return_value=BOARD_OFFLINE,
                                  create=True), \
                mock.patch.object(self.module, "ARDUINO_CLI", FAKE_CLI), \
                mock.patch.object(subprocess, "run", side_effect=fake_cli), \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            try:
                result["exit"] = body()
            except SystemExit as stop:
                result["exit"] = stop.code
        return recorder, fake_cli, result["exit"]

    def _the_compile_body(self, recorder, entry):
        bodies = recorder.bodies(COMPILE)
        self.assertEqual(
            len(bodies), 1,
            f"{entry}: exactly one body must reach {COMPILE}; posted to "
            f"{recorder.paths()!r}")
        return bodies[0]

    def _assert_names_gcc(self, body, entry):
        self.assertEqual(
            body.get("format"), "gcc",
            f"{entry}: the compile ingest must state the format of arduino-cli's "
            f"output; got format={body.get('format')!r} keys={sorted(body)!r}")

    def _assert_failing_compile_spawned_once(self, fake_cli, exit_code, entry):
        self.assertEqual(len(fake_cli.spawns), 1,
                         f"{entry}: arduino-cli must be spawned exactly once")
        argv, _kwargs = fake_cli.spawns[0]
        self.assertEqual(argv[1], "compile",
                         f"{entry}: the spawn must be `arduino-cli compile`")
        self.assertNotEqual(exit_code, 0,
                            f"{entry}: a failing compile must not exit 0")

    def _gate_args(self):
        return argparse.Namespace(agent=AGENT, project_dir=self.project_dir,
                                  cycle=None)

    # ── `_ingest_compile` called directly ─────────────────────────────────

    def test_a_direct_compile_ingest_states_the_gcc_format_beside_its_errors(self):
        errors = "probe.ino:1:1: error: boom"
        recorder, _fake_cli, _exit = self._drive(
            lambda: self.module._ingest_compile(self.project_dir, PROJECT_KEY,
                                                AGENT, errors, context={}))
        body = self._the_compile_body(recorder, "_ingest_compile")
        self._assert_names_gcc(body, "_ingest_compile")
        self.assertEqual(body.get("errors"), errors,
                         "the errors are sent exactly as given")
        self.assertEqual(
            (body.get("projectKey"), body.get("agentId"), body.get("stack")),
            (PROJECT_KEY, AGENT, "arduino"),
            "the rest of the compile body is unchanged")
        self.assertNotIn(RUN_START, recorder.paths(),
                         "a compile ingest opens no run")

    # ── through the gate path, arduino-cli failing for real ───────────────

    def test_a_failing_check_ingests_the_stripped_build_output_as_gcc(self):
        recorder, fake_cli, exit_code = self._drive(
            lambda: self.module.cmd_check(self._gate_args()))
        self._assert_failing_compile_spawned_once(fake_cli, exit_code, "check")
        body = self._the_compile_body(recorder, "check")
        self._assert_names_gcc(body, "check")
        self.assertEqual(
            body.get("errors"), self.expected_errors,
            "check: the errors are arduino-cli's stdout then stderr, trimmed "
            "and with the colour codes stripped")

    def test_a_failing_compile_verb_ingests_the_stripped_build_output_as_gcc(self):
        recorder, fake_cli, exit_code = self._drive(
            lambda: self.module.cmd_compile(self._gate_args()))
        self._assert_failing_compile_spawned_once(fake_cli, exit_code, "compile")
        body = self._the_compile_body(recorder, "compile")
        self._assert_names_gcc(body, "compile")
        self.assertEqual(
            body.get("errors"), self.expected_errors,
            "compile: the errors are arduino-cli's stdout then stderr, trimmed "
            "and with the colour codes stripped")

    def test_the_compile_step_run_directly_ingests_the_stripped_build_output_as_gcc(self):
        recorder, fake_cli, _exit = self._drive(
            lambda: self.module._compile_run(self._gate_args(), self.project_dir))
        self.assertEqual(len(fake_cli.spawns), 1,
                         "_compile_run: arduino-cli must be spawned exactly once")
        body = self._the_compile_body(recorder, "_compile_run")
        self._assert_names_gcc(body, "_compile_run")
        self.assertEqual(
            body.get("errors"), self.expected_errors,
            "_compile_run: the errors are arduino-cli's stdout then stderr, "
            "trimmed and with the colour codes stripped")

    def test_a_pre_merge_gate_failing_at_its_compile_step_ingests_gcc_and_skips_regression(self):
        args = argparse.Namespace(agent=AGENT, project_dir=self.project_dir,
                                  cycle=None, release=None, skip_check=False,
                                  dir=None)
        recorder, fake_cli, exit_code = self._drive(
            lambda: self.module.cmd_pre_merge_gate(args))
        self._assert_failing_compile_spawned_once(fake_cli, exit_code,
                                                  "pre-merge-gate")
        body = self._the_compile_body(recorder, "pre-merge-gate")
        self._assert_names_gcc(body, "pre-merge-gate")
        self.assertEqual(
            body.get("errors"), self.expected_errors,
            "pre-merge-gate: the errors are arduino-cli's stdout then stderr, "
            "trimmed and with the colour codes stripped")
        self.assertEqual(
            [path for path in recorder.paths() if path != COMPILE], [],
            "pre-merge-gate: a failing compile step posts only the compile "
            "result; the regression never runs")


if __name__ == "__main__":
    unittest.main()
