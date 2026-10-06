"""Every run a client OPENS is either closed by an ingest or disclosed — never
left silently open on the board.

Two paths reach a run that no ingest will close:

1. The runner produced no report (python's zero-test discovery; rust's
   `regression-ingest`, `smoke-test` and `workspace-regression` with no
   junit.xml; arduino's native body with no TEST-*.xml). Like bun's own
   `regression`, the client discloses it with the shared `run-left-open`
   warning naming the run id — no fabricated ingest — and the server settles
   the run with its own auto-abort.
2. SIGINT/SIGTERM mid-run. Every stack traps it the way bun does, through the
   one shared trap: the runner is reaped, no abort and no ingest is posted,
   and one ok:false envelope names the signal and the open run, exiting
   128+signum.

Each drive is a genuine OS subprocess against a fake runner and the stand-in
board (`RecordingBoard`).
"""

import shutil
import signal
import sys
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    INGEST_PATHS,
    SIGNALS,
    START,
    RecordingBoard,
    drive_and_signal,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
    write_fake_bun,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_native,
    write_fake_python,
)

AGENT = "run-left-open-fixture"
PROJECT_KEY = "test-key-run-left-open"
PROJECT_NAME = "run-left-open-fixture-firmware"
TOON = load_toon()


class _OpenRunCase(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("run-left-open-")
        self.scratch = new_scratch("run-left-open-scratch-")
        self.bin_dir = new_scratch("run-left-open-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    def tearDown(self):
        self.board.close()
        for d in (self.project, self.scratch, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=3, **extra)

    def axi(self, stdout):
        decoded = TOON.decode(stdout)
        self.assertIn("axi", decoded, f"stdout is not one TOON envelope: {stdout!r}")
        return decoded["axi"]

    def assert_disclosed(self, axi, verb, cause_fragment=None):
        """The envelope names the open run with the shared warning, and the
        board saw the run opened but never closed by any ingest."""
        paths = [p for p, _ in self.board.posts()]
        self.assertIn(START, paths, f"the run must have been opened; paths={paths!r}")
        self.assertEqual(
            [p for p in paths if p in INGEST_PATHS], [],
            f"nothing was produced, so nothing may be ingested; paths={paths!r}")
        self.assertEqual([p for p in paths if "abort" in p], [],
                         f"the client posts no abort; paths={paths!r}")
        self.assertEqual(axi.get("verb"), verb)
        self.assertIs(axi.get("ok"), False)
        left_open = [w for w in axi.get("warnings") or []
                     if w.get("code") == "run-left-open"]
        self.assertEqual(
            len(left_open), 1,
            f"exactly one run-left-open warning; warnings={axi.get('warnings')!r}")
        detail = left_open[0]["detail"]
        self.assertIn("run-live-1", detail, "the warning names the open run")
        self.assertIn("auto-abort", detail)
        self.assertIn("abandoned, not lost", detail)
        if cause_fragment:
            self.assertIn(cause_fragment, detail)
        return detail


class NoReportRunsAreDisclosedTest(_OpenRunCase):

    def _run(self, cmd, env):
        import subprocess
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=60)

    def test_python_regression_with_zero_tests_discovered(self):
        fake = write_fake_python(self.project)
        result = self._run(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "regression",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_DISCOVERY="1"))
        self.assertNotEqual(result.returncode, 0)
        axi = self.axi(result.stdout)
        # The definitive zero-discovery code is kept, beside the disclosure.
        codes = [w.get("code") for w in axi.get("warnings") or []]
        self.assertIn("no-tests-discovered", codes)
        self.assert_disclosed(axi, "regression")

    def _rust(self, verb, *extra):
        write_fake_cargo(self.bin_dir)
        result = self._run(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), verb, *extra,
             "--project-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        return self.axi(result.stdout)

    def test_rust_regression_ingest_without_junit(self):
        axi = self._rust("regression-ingest", "--crates", "fake-crate")
        self.assert_disclosed(axi, "regression-ingest", "junit.xml")

    def test_rust_smoke_test_without_junit(self):
        axi = self._rust("smoke-test")
        self.assert_disclosed(axi, "smoke-test", "junit.xml")

    def test_rust_workspace_regression_without_junit(self):
        axi = self._rust("workspace-regression", "--min-free-g", "0",
                         "--keep-target")
        self.assert_disclosed(axi, "workspace-regression", "junit.xml")

    def test_arduino_unit_without_a_report(self):
        write_fake_native(self.project)
        result = self._run(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        self.assert_disclosed(self.axi(result.stdout), "unit", "TEST-*.xml")


class AnInterruptedRunIsDisclosedByEveryStackTest(_OpenRunCase):
    """Interrupt parity: the same trap, the same envelope, on all five."""

    def _signal(self, verb, cmd, env, signum):
        reached, code, stdout, stderr = drive_and_signal(
            cmd, self.project, env, self.scratch, signum)
        self.assertTrue(reached, f"the runner never blocked; stderr={stderr[-2000:]!r}")
        signame = signal.Signals(signum).name
        self.assertEqual(
            code, 128 + signum,
            f"a signalled run exits 128+signum; stdout={stdout!r} "
            f"stderr={stderr[-2000:]!r}")
        axi = self.axi(stdout)
        detail = self.assert_disclosed(axi, verb)
        self.assertIn(signame, detail, "the warning names the signal")
        self.assertEqual(axi.get("signal"), signame)
        self.assertEqual(axi.get("runId"), "run-live-1")

    def _each_signal(self, verb, make_cmd, env):
        for signum in SIGNALS:
            with self.subTest(signal=signal.Signals(signum).name):
                self.board.close()
                self.board = RecordingBoard()
                install_project(self.project, self.board.url, PROJECT_KEY,
                                PROJECT_NAME)
                self._signal(verb, make_cmd(), env, signum)

    def test_bun_test(self):
        fake = write_fake_bun(self.project, 3)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
            "--bun", fake, "--project-dir", self.project,
            "--package-dir", self.project, "--reports", "reports",
            "--agent", AGENT], self.env())

    def test_mvn_unit(self):
        write_fake_mvnw(self.project)
        self._each_signal("unit", lambda: [
            sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
            "--test", "LiveCase*", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env())

    def test_python_test(self):
        fake = write_fake_python(self.project)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "python-crucible.py"), "test",
            "--python", fake, "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env())

    def test_rust_test(self):
        write_fake_cargo(self.bin_dir)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
            "--crate", "fake-crate", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env())

    def test_arduino_unit(self):
        write_fake_native(self.project)
        self._each_signal("unit", lambda: [
            sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
            "--dir", "tests/native", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env())


class TheTrapIsOneSharedImplementationTest(unittest.TestCase):
    """The five clients reach ONE trap, exception and envelope in the shared
    module — not five copies of bun's."""

    def test_the_shared_module_carries_the_trap(self):
        from tests.client.live_run_harness import load_client
        axi = load_client("_crucible_axi.py")
        for name in ("RunAbandoned", "abandon_trap", "emit_run_abandoned",
                     "run_left_open_warning"):
            self.assertTrue(hasattr(axi, name), f"_crucible_axi has no {name}")
        for client in ("bun-crucible.py", "mvn-crucible.py", "python-crucible.py",
                       "rust-crucible.py", "arduino-crucible.py"):
            text = (CLIENTS / client).read_text()
            self.assertNotIn("class _RunAbandoned", text,
                             f"{client} defines its own copy of the trap's exception")
            self.assertIn("abandon_trap", text, f"{client} never traps the run")


if __name__ == "__main__":
    unittest.main()
