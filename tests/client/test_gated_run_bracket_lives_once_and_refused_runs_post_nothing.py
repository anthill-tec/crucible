"""The gated-run identity bracket is written ONCE, and a run refused before it
starts posts nothing.

(a) `BracketLivesOnceTest` — structural. Every gated run opens its identity
    (bound to `--cycle` when `--agent` is given), runs, and closes it only when
    this run created it. That bracket must be the ONE shared `gated_run` in
    `clients/_crucible_axi.py`, beside `GatedRunIdentity` /
    `open_gate_identity` / `close_gate_identity`: no client defines a private
    `_gated_run`, and each call site that used to carry its own copy (mvn's
    surefire/failsafe tiers and `cmd_test`; rust's `cmd_test`,
    `cmd_smoke_test` and `cmd_workspace_regression`; python's `cmd_test`;
    bun's `cmd_test` and `cmd_regression`; the regression brackets that run
    the cycle pre-flight inside the open: mvn `cmd_regression`, rust
    `cmd_regression_ingest`, python `cmd_regression`, arduino
    `_run_native_tests`) enters the shared one and no longer calls
    `_open_gate_identity` / `_close_gate_identity` itself.

(b) `RefusedRustRunPostsNothingTest` — behavioural, a real subprocess against
    a `RecordingBoard`. rust `smoke-test` refused by a held gate lock, or by
    its disk guard, must post NOTHING — the same as `workspace-regression`,
    which makes both checks before it opens any identity. `docker-e2e-gate`
    shares the smoke body and opens no identity of its own; its refusal posts
    nothing too (a guard, unchanged).

Invocation:
    python3 -m unittest tests.client.test_gated_run_bracket_lives_once_and_refused_runs_post_nothing -v
"""

import ast
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    scrubbed_env,
    write_fake_cargo,
)

AGENT = "refused-run-fixture"
PROJECT_KEY = "test-key-refused-run"

CLIENT_FILES = ("bun-crucible.py", "python-crucible.py", "rust-crucible.py",
                "mvn-crucible.py", "arduino-crucible.py")

# (client, function) — every call site that carried its own copy of the
# open/close bracket and must now enter the shared one.
SHARED_BRACKET_CALL_SITES = (
    ("mvn-crucible.py", "_run_surefire_tier"),
    ("mvn-crucible.py", "_run_failsafe_tier"),
    ("mvn-crucible.py", "cmd_test"),
    ("rust-crucible.py", "cmd_test"),
    ("rust-crucible.py", "cmd_smoke_test"),
    ("rust-crucible.py", "cmd_workspace_regression"),
    ("python-crucible.py", "cmd_test"),
    ("bun-crucible.py", "cmd_test"),
    ("bun-crucible.py", "cmd_regression"),
    ("mvn-crucible.py", "cmd_regression"),
    ("rust-crucible.py", "cmd_regression_ingest"),
    ("python-crucible.py", "cmd_regression"),
    ("arduino-crucible.py", "_run_native_tests"),
)

_HAND_ROLLED_BRACKET_CALLS = ("_open_gate_identity", "_close_gate_identity")


def _tree(name):
    return ast.parse((CLIENTS / name).read_text(), filename=name)


def _top_level_function(tree, name):
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def _called_names(node):
    """Every name a call inside `node` invokes — `f(...)` and `x.f(...)` alike."""
    names = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            func = sub.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


class BracketLivesOnceTest(unittest.TestCase):

    def test_the_shared_module_defines_the_one_bracket(self):
        tree = ast.parse((CLIENTS / "_crucible_axi.py").read_text())
        self.assertIsNotNone(
            _top_level_function(tree, "gated_run"),
            "clients/_crucible_axi.py must define the one shared `gated_run` "
            "bracket beside open_gate_identity / close_gate_identity")

    def test_no_client_defines_its_own_gated_run(self):
        offenders = [name for name in CLIENT_FILES
                     if _top_level_function(_tree(name), "_gated_run") is not None]
        self.assertEqual(
            offenders, [],
            f"a client-local `_gated_run` is a second copy of the shared "
            f"bracket; found in {offenders!r}")

    def test_every_listed_call_site_enters_the_shared_bracket(self):
        for client, function in SHARED_BRACKET_CALL_SITES:
            with self.subTest(client=client, function=function):
                node = _top_level_function(_tree(client), function)
                self.assertIsNotNone(node, f"{client} no longer defines {function}")
                called = _called_names(node)
                self.assertTrue(
                    "gated_run" in called,
                    f"{client}::{function} must enter the shared `gated_run` "
                    f"bracket")
                hand_rolled = sorted(set(_HAND_ROLLED_BRACKET_CALLS) & called)
                self.assertEqual(
                    hand_rolled, [],
                    f"{client}::{function} still opens/closes the identity by "
                    f"hand ({hand_rolled!r}) instead of through `gated_run`")


# ── (b) a refused rust run posts nothing ────────────────────────────────────

_FAKE_DF_LOW = """#!/bin/sh
echo "Filesystem 1G-blocks Used Available Use% Mounted on"
echo "/dev/fake 100G 99G 1G 99% /home"
"""


def _write_fake_df(bin_dir):
    path = os.path.join(bin_dir, "df")
    with open(path, "w") as f:
        f.write(_FAKE_DF_LOW)
    os.chmod(path, 0o755)


class RefusedRustRunPostsNothingTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="refused-run-")
        self.project_dir = os.path.join(self.tmpdir, "proj")
        self.bin_dir = os.path.join(self.tmpdir, "bin")
        os.makedirs(self.project_dir)
        os.makedirs(self.bin_dir)
        write_fake_cargo(self.bin_dir)
        self.board = RecordingBoard()
        install_project(self.project_dir, self.board.url, PROJECT_KEY)
        self.holder = None

    def tearDown(self):
        if self.holder is not None:
            self.holder.terminate()
            self.holder.wait(timeout=10)
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _hold_gate_lock(self):
        """A LIVE holder the client recognises as a gate runner: the project
        is a git repo (so the lock path resolves to its root) and the lock
        names a running process whose command line says `cargo`."""
        subprocess.run(["git", "init", "-q", self.project_dir], check=True,
                       capture_output=True)
        self.holder = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(120)", "cargo"])
        with open(os.path.join(self.project_dir, "nai-gate.lock"), "w") as f:
            f.write(f"owner=someone-else\ncr=\npid={self.holder.pid}\n"
                    f"epoch={int(time.time())}\n")

    def _run(self, verb, *extra):
        cmd = [sys.executable, str(CLIENTS / "rust-crucible.py"), verb,
               "--agent", AGENT, "--project-dir", self.project_dir, *extra]
        return subprocess.run(cmd, cwd=self.project_dir,
                              env=scrubbed_env(path_prefix=self.bin_dir,
                                               FAKE_TOTAL="1"),
                              capture_output=True, text=True, timeout=90)

    def _assert_refused_silently(self, result, rc, what):
        self.assertEqual(
            result.returncode, rc,
            f"{what} must be refused with exit {rc}; stdout={result.stdout!r} "
            f"stderr={result.stderr[-2000:]!r}")
        posts = self.board.posts()
        self.assertEqual(
            posts, [],
            f"{what} was refused before it ran, so it must post nothing to "
            f"the board (no opening heartbeat, no closing removal); got "
            f"{posts!r}")

    def test_smoke_test_refused_by_a_held_gate_lock_posts_nothing(self):
        self._hold_gate_lock()
        result = self._run("smoke-test", "--cycle", "7")
        self._assert_refused_silently(result, 75, "a gate-locked smoke-test")

    def test_smoke_test_refused_by_the_disk_guard_posts_nothing(self):
        _write_fake_df(self.bin_dir)
        result = self._run("smoke-test", "--all-features", "--cycle", "7")
        self._assert_refused_silently(result, 2, "a disk-guarded smoke-test")

    def test_workspace_regression_refused_by_the_disk_guard_posts_nothing(self):
        """Guard — the sibling verb smoke-test is being made to match."""
        result = self._run("workspace-regression", "--min-free-g", "999999999",
                           "--keep-target", "--cycle", "7")
        self._assert_refused_silently(result, 2,
                                      "a disk-guarded workspace-regression")

    def test_docker_e2e_gate_refused_by_the_disk_guard_posts_nothing(self):
        """Guard — the shared smoke body's other caller opens no identity, so
        its refusal posts nothing before and after."""
        _write_fake_df(self.bin_dir)
        result = self._run("docker-e2e-gate")
        self._assert_refused_silently(result, 2, "a disk-guarded docker-e2e-gate")


if __name__ == "__main__":
    unittest.main()
