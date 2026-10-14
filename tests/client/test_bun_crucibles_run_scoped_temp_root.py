"""§S2 client-paragraph RED — `bun-crucible.py` builds every runner's `env`
with a plain `os.environ.copy()` (`cmd_test`, `cmd_regression` — read
directly off this branch, every assignment to the local `env` right after
that copy) and never touches `TMPDIR` anywhere in either body. Bun 1.4.2
hands a child it spawns WITHOUT an explicit `env` the environment as it
stood when ITS OWN process started — so a `TMPDIR` the IN-PROCESS preload
might set too late never reaches such a child at all. The fix this CR asks
for is the CLIENT exporting a run-scoped `TMPDIR` (one directory per run,
under the system temp root) for every runner it spawns on a test-family verb
(`test`, `regression`, a declared script), removed on every exit path —
pass, failure, no-report, SIGTERM.

Empirically confirmed against the CURRENT fleet (not asserted from reading
alone): a fake `bun` that captures its own `TMPDIR` and the `TMPDIR` of a
child IT spawns with no explicit `env` (`FAKE_TMPDIR_CAPTURE_FILE`,
`tests/client/live_run_harness.py`), driven through bun's `test`,
`regression` and a declared `unit` target, shows `TMPDIR` is simply ABSENT
(empty) on the runner today — the client passes through whatever `TMPDIR`
(if any) the test process itself happened to have, never a fresh run-scoped
one — so every assertion below fails on the "must be non-empty, one
directory under the system temp root" assertion, never on an
import/fixture error.

Invocation:
    python3 -m unittest tests.client.test_bun_crucibles_run_scoped_temp_root -v
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    drive_and_signal,
    fresh_capture_path,
    install_project,
    new_scratch,
    read_tmpdir_capture,
    scrubbed_env,
    write_fake_bun,
)

AGENT = "bun-tmpdir-fixture"
PROJECT_KEY = "test-key-bun-tmpdir"
PROJECT_NAME = "bun-tmpdir-fixture-firmware"


def _system_temp_root():
    return os.path.realpath(tempfile.gettempdir())


class _BunTmpdirCase(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("bun-tmpdir-")
        self.scratch = new_scratch("bun-tmpdir-scratch-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)
        self.fake_bun = write_fake_bun(self.project, 3)

    def tearDown(self):
        self.board.close()
        for d in (self.project, self.scratch):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(None, FAKE_TOTAL=3, **extra)

    def _declare_unit_script(self):
        Path(self.project, "package.json").write_text(json.dumps(
            {"name": "bun-tmpdir-fixture", "scripts": {"test:unit": "bun test"}}))

    # ── the three test-family verbs the AC names ────────────────────────────

    def _test_cmd(self):
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
               "--bun", self.fake_bun, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports",
               "--agent", AGENT]

    def _regression_cmd(self):
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "regression",
               "--bun", self.fake_bun, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports",
               "--agent", AGENT]

    def _declared_unit_cmd(self):
        self._declare_unit_script()
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "unit",
               "--bun", self.fake_bun, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports",
               "--agent", AGENT]

    VERBS = (("test", "_test_cmd"), ("regression", "_regression_cmd"),
             ("unit (a declared script)", "_declared_unit_cmd"))

    # ── shared assertion: scoping, sharing with an un-enved child, cleanup ──

    def _assert_tmpdir_scoped_and_shared(self, label, capture_path, stdout, stderr):
        own, child, isdir = read_tmpdir_capture(capture_path)
        self.assertTrue(
            own,
            f"{label}: the spawned runner itself must see a non-empty "
            f"TMPDIR; stdout={stdout!r} stderr={stderr[-2000:]!r}")
        self.assertEqual(
            os.path.dirname(os.path.realpath(own)), _system_temp_root(),
            f"{label}: TMPDIR must be ONE directory directly under the "
            f"system temp root ({_system_temp_root()!r}); got {own!r}")
        self.assertEqual(
            isdir, "1",
            f"{label}: the directory named by TMPDIR must actually exist "
            f"while the runner is live; got TMPDIR={own!r} isdir={isdir!r}")
        self.assertEqual(
            child, own,
            f"{label}: a child the runner spawns WITHOUT an explicit `env` "
            f"must see the SAME TMPDIR the runner itself does; runner saw "
            f"{own!r}, the un-enved child saw {child!r}")
        return own

    def _assert_tmpdir_removed(self, label, tmpdir, stdout, stderr):
        self.assertFalse(
            os.path.exists(tmpdir),
            f"{label}: the run-scoped TMPDIR {tmpdir!r} must be gone once "
            f"the client has exited; stdout={stdout!r} "
            f"stderr={stderr[-2000:]!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC "The client scopes the run's temp root" — a PASSING run.
# ═══════════════════════════════════════════════════════════════════════════

class TheClientScopesTheTempRootOnAPassTest(_BunTmpdirCase):

    def test_every_test_family_verb_scopes_and_removes_tmpdir_on_a_pass(self):
        for verb, builder_name in self.VERBS:
            with self.subTest(verb=verb):
                capture = fresh_capture_path(self.scratch, "tmpdir-pass")
                cmd = getattr(self, builder_name)()
                result = subprocess.run(
                    cmd, cwd=self.project,
                    env=self.env(FAKE_TMPDIR_CAPTURE_FILE=capture),
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(
                    result.returncode, 0,
                    f"{verb}: a passing run exits 0; "
                    f"stdout={result.stdout!r} "
                    f"stderr={result.stderr[-2000:]!r}")
                own = self._assert_tmpdir_scoped_and_shared(
                    verb, capture, result.stdout, result.stderr)
                self._assert_tmpdir_removed(
                    verb, own, result.stdout, result.stderr)


# ═══════════════════════════════════════════════════════════════════════════
# AC "The client scopes the run's temp root" — a FAILING run (test failures).
# ═══════════════════════════════════════════════════════════════════════════

class TheClientScopesTheTempRootOnAFailureTest(_BunTmpdirCase):

    def test_every_test_family_verb_scopes_and_removes_tmpdir_on_a_failure(self):
        for verb, builder_name in self.VERBS:
            with self.subTest(verb=verb):
                capture = fresh_capture_path(self.scratch, "tmpdir-fail")
                cmd = getattr(self, builder_name)()
                result = subprocess.run(
                    cmd, cwd=self.project,
                    env=self.env(FAKE_TMPDIR_CAPTURE_FILE=capture,
                                 FAKE_FAIL_COUNT=1),
                    capture_output=True, text=True, timeout=30)
                self.assertNotEqual(
                    result.returncode, 0,
                    f"{verb}: a run with a planted failing test exits "
                    f"non-zero; stdout={result.stdout!r} "
                    f"stderr={result.stderr[-2000:]!r}")
                own = self._assert_tmpdir_scoped_and_shared(
                    verb, capture, result.stdout, result.stderr)
                self._assert_tmpdir_removed(
                    verb, own, result.stdout, result.stderr)


# ═══════════════════════════════════════════════════════════════════════════
# AC "The client scopes the run's temp root" — a runner with NO report.
# ═══════════════════════════════════════════════════════════════════════════

class TheClientScopesTheTempRootOnANoReportExitTest(_BunTmpdirCase):

    def test_every_test_family_verb_scopes_and_removes_tmpdir_with_no_report(self):
        for verb, builder_name in self.VERBS:
            with self.subTest(verb=verb):
                capture = fresh_capture_path(self.scratch, "tmpdir-noreport")
                cmd = getattr(self, builder_name)()
                result = subprocess.run(
                    cmd, cwd=self.project,
                    env=self.env(FAKE_TMPDIR_CAPTURE_FILE=capture,
                                 FAKE_NO_REPORT="1"),
                    capture_output=True, text=True, timeout=30)
                # The exit code for a no-report runner is PER-VERB existing
                # behaviour out of this AC's scope (`test` ingests a
                # synthetic compile failure and returns the INGEST's own
                # code, which is 0 on a board that accepted it; `regression`/
                # a declared script return 1) — pinned by the no-report
                # suite elsewhere. The envelope itself always says so.
                self.assertIn(
                    "no-test-reports", result.stdout,
                    f"{verb}: a runner that wrote no report must still be "
                    f"recognised as one (sanity check that FAKE_NO_REPORT "
                    f"actually took this exit's path); "
                    f"stdout={result.stdout!r} "
                    f"stderr={result.stderr[-2000:]!r}")
                own = self._assert_tmpdir_scoped_and_shared(
                    verb, capture, result.stdout, result.stderr)
                self._assert_tmpdir_removed(
                    verb, own, result.stdout, result.stderr)


# ═══════════════════════════════════════════════════════════════════════════
# AC "The client scopes the run's temp root" — SIGTERM mid-run.
# ═══════════════════════════════════════════════════════════════════════════

class TheClientScopesTheTempRootOnSigtermTest(_BunTmpdirCase):

    def test_every_test_family_verb_scopes_and_removes_tmpdir_on_sigterm(self):
        for verb, builder_name in self.VERBS:
            with self.subTest(verb=verb):
                self.board.close()
                self.board = RecordingBoard()
                install_project(self.project, self.board.url, PROJECT_KEY,
                                PROJECT_NAME)
                capture = fresh_capture_path(self.scratch, "tmpdir-sigterm")
                cmd = getattr(self, builder_name)()
                env = self.env(FAKE_TMPDIR_CAPTURE_FILE=capture)
                reached, code, stdout, stderr = drive_and_signal(
                    cmd, self.project, env, self.scratch, signal.SIGTERM)
                self.assertTrue(
                    reached,
                    f"{verb}: the runner never blocked mid-run; "
                    f"stderr={stderr[-2000:]!r}")
                self.assertEqual(
                    code, 143,
                    f"{verb}: a SIGTERM to the client exits 128+SIGTERM "
                    f"(143); got {code}; stdout={stdout!r} "
                    f"stderr={stderr[-2000:]!r}")
                own = self._assert_tmpdir_scoped_and_shared(
                    verb, capture, stdout, stderr)
                self._assert_tmpdir_removed(verb, own, stdout, stderr)


if __name__ == "__main__":
    unittest.main()
