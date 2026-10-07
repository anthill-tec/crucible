"""CR-CRU-170 \u00a7S2 (re-pinned) \u2014 every run a client OPENS is either closed
by an ingest, closed by the client's OWN abort, or disclosed as left open
for the server to sweep \u2014 never silently open on the board with nothing
said about it.

Two paths reach a run that no ingest will close (a third, the board
refusing the runId-carrying ingest itself, is covered in
`test_a_client_aborts_a_run_it_cannot_file.py` beside the abort-refused
fallback for these same two):

1. The runner produced no report (python's zero-test discovery; rust's
   `regression-ingest`, `smoke-test` and `workspace-regression` with no
   junit.xml; arduino's native body with no TEST-*.xml). The client now
   closes the run itself: ONE `POST /api/v2/runs/<id>/abort` naming the
   exit, and the envelope reports the run ABORTED \u2014 no `run-left-open`
   warning, since the server has nothing left to sweep.
2. SIGINT/SIGTERM mid-run. Every stack traps it the way bun does, through
   the one shared trap: the runner is reaped, then \u2014 beside the existing
   gated-identity teardown \u2014 the SAME one abort is posted for the run this
   signalled invocation opened, before the ok:false envelope (naming the
   signal and the run) is emitted, exiting 128+signum.

Each drive is a genuine OS subprocess against a fake runner and the stand-in
board (`RecordingBoard`), which answers every abort POST `ok` here \u2014 the
abort-REFUSED fallback (`run-left-open` stays exactly as it read before this
CR) is pinned in `test_a_client_aborts_a_run_it_cannot_file.py`, not here.

RE-PIN NOTE (CR-CRU-170 \u00a7S2): this file used to pin "the client posts no
abort" \u2014 the behaviour CR-CRU-017 \u00a7S2 left unbuilt. \u00a7S1 built the route
(`POST /api/v2/runs/<runId>/abort`, cycle `C1`) and \u00a7S2 wires every exit
here to call it; `assert_disclosed` below is migrated to the new contract,
every other assertion's MEANING (the run was opened, nothing was ingested,
the envelope is ok:false and names the signal/runId where it always did)
is unchanged.
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
        """CR-CRU-170 \u00a7S2 (re-pinned) \u2014 the board saw the run opened and then
        closed by EXACTLY ONE abort this client posted itself (carrying this
        fixture's own project/agent identity and a reason naming the exit),
        never by a fabricated ingest; the envelope reports the run as
        ABORTED and carries NO `run-left-open` warning (the server has
        nothing left to sweep \u2014 this client already closed it)."""
        paths = [p for p, _ in self.board.posts()]
        self.assertIn(START, paths, f"the run must have been opened; paths={paths!r}")
        self.assertEqual(
            [p for p in paths if p in INGEST_PATHS], [],
            f"nothing was produced, so nothing may be ingested; paths={paths!r}")
        aborts = self.board.aborts()
        self.assertEqual(
            len(aborts), 1,
            f"the client must close the run IT opened with exactly one "
            f"abort; paths={paths!r}")
        abort_path, abort_body = aborts[0]
        self.assertEqual(
            abort_path, "/api/v2/runs/run-live-1/abort",
            f"the abort must target the run this client itself opened; got "
            f"path={abort_path!r}")
        self.assertEqual(abort_body.get("projectKey"), PROJECT_KEY, f"got {abort_body!r}")
        self.assertEqual(abort_body.get("agentId"), AGENT, f"got {abort_body!r}")
        self.assertEqual(axi.get("verb"), verb)
        self.assertIs(axi.get("ok"), False)
        warnings = axi.get("warnings") or []
        left_open = [w for w in warnings if w.get("code") == "run-left-open"]
        self.assertEqual(
            left_open, [],
            f"an abort that SUCCEEDED carries NO run-left-open warning \u2014 "
            f"the server has nothing left to sweep; warnings={warnings!r}")
        aborted = [w for w in warnings if w.get("code") == "run-aborted"]
        self.assertEqual(
            len(aborted), 1,
            f"exactly one run-aborted warning disclosing the close; "
            f"warnings={warnings!r}")
        detail = aborted[0]["detail"]
        self.assertIn("run-live-1", detail, "the warning names the aborted run")
        if cause_fragment:
            self.assertIn(
                cause_fragment, abort_body.get("reason") or "",
                "the abort's own reason must name the exit that triggered it")
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
