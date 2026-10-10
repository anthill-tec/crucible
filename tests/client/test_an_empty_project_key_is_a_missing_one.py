"""RED — §S5/AC9: an empty project key is a missing one (Model B #1402;
user ruling 2026-09-26).

`modelb-axi init` now scaffolds `CRUCIBLE_PROJECT_KEY=` empty until a project
is registered. Four clients (bun, mvn, python, rust) share ONE `_project_key`/
`_read_env` implementation that checks only `"CRUCIBLE_PROJECT_KEY" not in
env` — so an EMPTY value (the key line present, nothing after `=`) or a
WHITESPACE-ONLY value (parsed down to the same empty string by `_read_env`'s
own `line.strip()`/`v.strip()`) both slip PAST that check, return `""` as the
"key", and let the verb proceed to build `/api/v2/projects//plans` and issue
a REAL request — exactly the defect §S5 names. This file drives `status` (a
verb that needs the key, no `--agent` required) with `_get`/`_post`/`_patch`
ALL mocked, so ANY of the three transport seams making a request is caught,
and asserts:

  1. a `.env` with NO `CRUCIBLE_PROJECT_KEY` line at all hard-stops with a
     non-zero exit and issues no request — the BASELINE, established fresh in
     each test (never a hard-coded string assumed in advance) by driving the
     same fixture-building path the other two cases use.
  2. a `.env` holding `CRUCIBLE_PROJECT_KEY=` (empty) must fail with the
     SAME error text and the SAME exit code as (1), and issue no request.
  3. a `.env` holding `CRUCIBLE_PROJECT_KEY=   ` (whitespace only) must fail
     the same way as (1), and issue no request.
  4. (arduino only) an EMPTY `.env` key with `CRUCIBLE_PROJECT_KEY` set in
     `os.environ` (the shell) must STILL fail the same way — no falling back
     to the shell when the project's own `.env` declares (however emptily)
     that it owns the key. Arduino's own `_load_env` explicitly ORs in
     `os.environ.get("CRUCIBLE_PROJECT_KEY")` when the `.env` value is falsy,
     which is precisely this fallback; the four other clients never read
     `os.environ` for the key at all, so this dimension is arduino-only.

RED today, confirmed by reading each client's own `_project_key`/`_read_env`
(python/bun/rust/mvn) and `_load_env` (arduino) source: for (2)/(3), the four
shared-implementation clients return `""` without exiting, so the mocked
`_get` records a call and the drive succeeds (exit 0) — failing the
"no request" and "non-zero exit" assertions for the right reason. Arduino's
own empty-key/whitespace-key cases (without a shell override) already
hard-stop correctly today (its `key = env.get(...) or os.environ.get(...)`
falls through to `None` when BOTH are empty), so tests (2)/(3) may PASS
against arduino unmodified — reported honestly below rather than forced red
— while arduino's dedicated shell-fallback test (4) is RED: with the shell
carrying a real key and the `.env` key empty, `"" or "shell-value"` returns
the truthy shell value, so arduino proceeds and succeeds instead of hard-
stopping.

Harness idiom: the exact `_load_module`/mocked-transport-drive shape from
`tests/client/test_project_meta_reads_and_writes_the_map.py`, extended with a
`_run_main` that preserves the RAW `SystemExit.code` a client's own
`sys.exit(<message string>)` was given (not just flattened to an int) — that
string is exactly what a REAL, un-caught process would write to stderr via
the interpreter's own top-level handler, so comparing it across fixtures
byte-for-byte is comparing the real user-facing error text, not a
transcription of it.

Invocation:
    python3 -m unittest tests.client.test_an_empty_project_key_is_a_missing_one
"""
# pyright: reportAttributeAccessIssue=false, reportArgumentType=false, reportOptionalMemberAccess=false

import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import install_project_limits
from tests.client.test_cr054_fleet_inventory import CLIENT_FILES

REPO_ROOT = Path(__file__).resolve().parents[2]

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

_FIXTURE_PROJECT_NAME = "fixture-project-empty-key-c536"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """`(exit_code, stdout, stderr, exit_message)`.

    `exit_message` is the RAW value `SystemExit.code` carries — a client's own
    `sys.exit(f"[crucible] ERROR: ...")` hands argparse/Python a STRING, which
    (uncaught, in a real process) is what the interpreter's own top-level
    handler prints to stderr before exiting 1. Capturing it here (rather than
    flattening straight to an int the way the fleet's simpler `_run_main`
    idiom does elsewhere) is what lets a test assert the missing/empty/
    whitespace fixtures fail with byte-identical TEXT, not merely the same
    numeric code."""
    full_argv = ["client"] + argv
    out, err = io.StringIO(), io.StringIO()
    exit_message = None
    with mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            exit_message = exc.code
            if exc.code is None:
                code = 0
            elif isinstance(exc.code, int):
                code = exc.code
            else:
                code = 1
    return code, out.getvalue(), err.getvalue(), exit_message


class _ProjectKeyContractTestBase:
    """A plain MIXIN (no `unittest.TestCase` here) — only the five concrete
    per-client classes below inherit `unittest.TestCase`, so discovery never
    collects this abstract half on its own (the established fleet idiom, see
    `test_project_meta_reads_and_writes_the_map.py`)."""

    CLIENT = None
    NEEDS_PROJECT_NAME = False  # arduino's `_load_env` also requires this.

    def setUp(self):
        self.module = _load_module(CLIENT_FILES[self.CLIENT],
                                    f"empty_project_key_c536_{self.CLIENT}_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix=f"empty-project-key-{self.CLIENT}-")
        install_project_limits(self.tmpdir)
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        self._saved_project_key_env = os.environ.get("CRUCIBLE_PROJECT_KEY")
        os.environ.pop("CRUCIBLE_PROJECT_KEY", None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if self._saved_project_key_env is None:
            os.environ.pop("CRUCIBLE_PROJECT_KEY", None)
        else:
            os.environ["CRUCIBLE_PROJECT_KEY"] = self._saved_project_key_env
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_env(self, key_line):
        """Lay the project `.env` down with `key_line` (a full line, e.g.
        `"CRUCIBLE_PROJECT_KEY=\\n"`, or `None` to omit the key entirely) and
        — for arduino, which also requires it — a `CRUCIBLE_PROJECT_NAME`
        line, so the KEY is what fails, never the name (§S5's own
        instruction: "give the arduino fixtures a name so the key is what
        fails")."""
        lines = []
        if key_line is not None:
            lines.append(key_line)
        if self.NEEDS_PROJECT_NAME:
            lines.append(f"CRUCIBLE_PROJECT_NAME={_FIXTURE_PROJECT_NAME}\n")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.writelines(lines)

    def drive(self):
        """Drive `status` (needs the key, no `--agent`) with ALL THREE
        transport seams (`_get`/`_post`/`_patch`) mocked, so a defect that
        slips the malformed key into ANY of them is caught, not just the one
        `status` happens to use today."""
        argv = ["status", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get",
                               return_value={"ok": True, "plans": []}) as mock_get, \
                mock.patch.object(self.module, "_post",
                                  return_value={"ok": True}) as mock_post, \
                mock.patch.object(self.module, "_patch",
                                   return_value={"ok": True}) as mock_patch:
            code, out, err, exit_message = _run_main(self.module, argv)
        return code, out, err, exit_message, mock_get, mock_post, mock_patch

    def _assert_no_request_made(self, mock_get, mock_post, mock_patch, label):
        self.assertEqual(
            mock_get.call_count, 0,
            f"{self.CLIENT}: {label} must issue NO request (GET); got "
            f"{mock_get.call_args_list!r}")
        self.assertEqual(
            mock_post.call_count, 0,
            f"{self.CLIENT}: {label} must issue NO request (POST); got "
            f"{mock_post.call_args_list!r}")
        self.assertEqual(
            mock_patch.call_count, 0,
            f"{self.CLIENT}: {label} must issue NO request (PATCH); got "
            f"{mock_patch.call_args_list!r}")

    def _missing_key_baseline(self):
        """Drives the MISSING-key fixture (no `CRUCIBLE_PROJECT_KEY` line at
        all) and returns `(code, exit_message)` — the baseline every other
        fixture in this file is compared against, established FRESH by an
        actual drive rather than assumed as a literal."""
        self._write_env(None)
        code, out, err, exit_message, mock_get, mock_post, mock_patch = self.drive()
        self._assert_no_request_made(mock_get, mock_post, mock_patch,
                                     "a missing key")
        self.assertNotEqual(
            code, 0,
            f"{self.CLIENT}: a missing key must hard-stop (non-zero exit); "
            f"stdout={out!r} stderr={err!r}")
        self.assertIsNotNone(
            exit_message,
            f"{self.CLIENT}: a missing key must `sys.exit` with a message "
            f"naming the missing key, not a bare `SystemExit()`")
        return code, exit_message


class ProjectKeyContractTests:
    """§S5/AC9 — the core per-client contract."""

    def test_missing_key_hard_stops_before_any_request(self):
        # Exercised again here (not merely as a helper call) so a missing
        # baseline is itself an independent, reportable assertion per client.
        self._missing_key_baseline()

    def test_empty_key_fails_exactly_as_the_missing_key_baseline_does(self):
        baseline_code, baseline_message = self._missing_key_baseline()

        self._write_env("CRUCIBLE_PROJECT_KEY=\n")
        code, out, err, exit_message, mock_get, mock_post, mock_patch = self.drive()
        self._assert_no_request_made(mock_get, mock_post, mock_patch,
                                     "an empty key")
        self.assertNotEqual(
            code, 0,
            f"{self.CLIENT}: an EMPTY key must still hard-stop (non-zero "
            f"exit), exactly as a missing key does; stdout={out!r} "
            f"stderr={err!r}")
        self.assertEqual(
            code, baseline_code,
            f"{self.CLIENT}: an EMPTY key must exit with the SAME code as "
            f"the missing-key baseline; empty={code} missing={baseline_code}")
        self.assertEqual(
            exit_message, baseline_message,
            f"{self.CLIENT}: an EMPTY key must fail with the SAME error "
            f"text as the missing-key baseline; empty={exit_message!r} "
            f"missing={baseline_message!r}")

    def test_whitespace_only_key_fails_exactly_as_the_missing_key_baseline_does(self):
        baseline_code, baseline_message = self._missing_key_baseline()

        self._write_env("CRUCIBLE_PROJECT_KEY=   \n")
        code, out, err, exit_message, mock_get, mock_post, mock_patch = self.drive()
        self._assert_no_request_made(mock_get, mock_post, mock_patch,
                                     "a whitespace-only key")
        self.assertNotEqual(
            code, 0,
            f"{self.CLIENT}: a WHITESPACE-ONLY key must still hard-stop "
            f"(non-zero exit), exactly as a missing key does; "
            f"stdout={out!r} stderr={err!r}")
        self.assertEqual(
            code, baseline_code,
            f"{self.CLIENT}: a whitespace-only key must exit with the SAME "
            f"code as the missing-key baseline; whitespace={code} "
            f"missing={baseline_code}")
        self.assertEqual(
            exit_message, baseline_message,
            f"{self.CLIENT}: a whitespace-only key must fail with the SAME "
            f"error text as the missing-key baseline; "
            f"whitespace={exit_message!r} missing={baseline_message!r}")


class _AllProjectKeyTests(ProjectKeyContractTests, _ProjectKeyContractTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonProjectKeyTest(_AllProjectKeyTests, unittest.TestCase):
    CLIENT = "python"


class BunProjectKeyTest(_AllProjectKeyTests, unittest.TestCase):
    CLIENT = "bun"


class RustProjectKeyTest(_AllProjectKeyTests, unittest.TestCase):
    CLIENT = "rust"


class MvnProjectKeyTest(_AllProjectKeyTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoProjectKeyTest(_AllProjectKeyTests, unittest.TestCase):
    CLIENT = "arduino"
    NEEDS_PROJECT_NAME = True


# ═══════════════════════════════════════════════════════════════════════════
# §S5 — arduino ALSO stops falling back to the shell's own
# CRUCIBLE_PROJECT_KEY when .env's is empty or absent, as the other four
# never did (they never read `os.environ` for the key at all).
# ═══════════════════════════════════════════════════════════════════════════

class ArduinoNoShellFallbackForAnEmptyEnvKeyTest(unittest.TestCase):
    """§S5 — arduino's `_load_env` today reads
    `env.get("CRUCIBLE_PROJECT_KEY") or os.environ.get("CRUCIBLE_PROJECT_KEY")`
    — an EMPTY (falsy) `.env` value falls through to the shell. §S5 requires
    the project's own (however emptily-declared) `.env` to be authoritative:
    an empty `.env` key must fail exactly as a missing one does, even with a
    live `CRUCIBLE_PROJECT_KEY` sitting in the calling shell's environment.

    RED today: with the shell carrying a real value, `"" or "shell-value"`
    evaluates to the truthy shell value, so arduino's `status` PROCEEDS and
    succeeds (exit 0, one GET) instead of hard-stopping — this test fails on
    both the exit-code and the no-request assertions for that reason."""

    CLIENT = "arduino"
    ENV_KEYS = ENV_KEYS

    def setUp(self):
        self.module = _load_module(
            CLIENT_FILES["arduino"],
            "empty_project_key_c536_arduino_shell_fallback_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="empty-project-key-arduino-shell-")
        install_project_limits(self.tmpdir)
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write("CRUCIBLE_PROJECT_KEY=\n")
            fh.write(f"CRUCIBLE_PROJECT_NAME={_FIXTURE_PROJECT_NAME}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        self._saved_project_key_env = os.environ.get("CRUCIBLE_PROJECT_KEY")
        os.environ["CRUCIBLE_PROJECT_KEY"] = "shell-fallback-must-be-refused-c536"

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if self._saved_project_key_env is None:
            os.environ.pop("CRUCIBLE_PROJECT_KEY", None)
        else:
            os.environ["CRUCIBLE_PROJECT_KEY"] = self._saved_project_key_env
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_empty_env_key_with_shell_env_set_still_hard_stops_with_no_request(self):
        argv = ["status", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get",
                               return_value={"ok": True, "plans": []}) as mock_get, \
                mock.patch.object(self.module, "_post",
                                  return_value={"ok": True}) as mock_post, \
                mock.patch.object(self.module, "_patch",
                                   return_value={"ok": True}) as mock_patch:
            code, out, err, exit_message = _run_main(self.module, argv)

        self.assertNotEqual(
            code, 0,
            f"arduino: an empty `.env` key must hard-stop EVEN WHEN the "
            f"shell carries its own CRUCIBLE_PROJECT_KEY (no shell "
            f"fallback, §S5); stdout={out!r} stderr={err!r}")
        self.assertEqual(
            mock_get.call_count, 0,
            f"arduino: an empty `.env` key with a shell fallback present "
            f"must still issue NO request; got {mock_get.call_args_list!r}")
        self.assertEqual(
            mock_post.call_count, 0,
            f"arduino: an empty `.env` key with a shell fallback present "
            f"must still issue NO request; got {mock_post.call_args_list!r}")
        self.assertEqual(
            mock_patch.call_count, 0,
            f"arduino: an empty `.env` key with a shell fallback present "
            f"must still issue NO request; got {mock_patch.call_args_list!r}")
        self.assertNotIn(
            "shell-fallback-must-be-refused-c536", out + err,
            f"arduino: the shell's own CRUCIBLE_PROJECT_KEY must never be "
            f"used as the project key at all; stdout={out!r} stderr={err!r}")


if __name__ == "__main__":
    unittest.main()
