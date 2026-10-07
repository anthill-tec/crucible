"""CR-CRU-170 \u00a7S2/AC2 RED \u2014 a client that opened a run (`POST
/api/v2/runs/start`) and then reaches an exit that files nothing for it
closes that run ITSELF, through `POST /api/v2/runs/<runId>/abort
{projectKey, agentId, reason}`, instead of leaving it to the server's own
auto-abort sweep.

\u00a7S2's table, and the coverage here:

    | Exit                              | Covered by                         |
    |------------------------------------|------------------------------------|
    | the runner wrote no report         | NoReportExitAbortsTheRunTest       |
    | SIGINT / SIGTERM mid-run           | SignalExitAbortsTheRunTest         |
    | the board refused the runId ingest | RefusedIngestAbortsTheRunTest      |

Each exit is driven twice per client: once where the board ANSWERS the
abort (the run settles `aborted`, no `run-left-open` warning), and once
where the board REFUSES it (`RecordingBoard.refuse_next_abort`) \u2014 the
fallback \u00a7S2 still requires, unchanged: the client posts the one abort it
always posts, the abort itself fails, and the envelope falls back to
`run-left-open` exactly as it always has.

-- The contract these tests pin (none of it exists yet) ---------------------

1. Exactly ONE `POST /api/v2/runs/<the opened runId>/abort` is made, body
   `{"projectKey": <project>, "agentId": <agent>, "reason": "<names the
   exit>"}` \u2014 asserted via the new `RecordingBoard.aborts()`.
2. When that POST answers `ok`, the envelope carries a NEW `run-aborted`
   warning (`{"code": "run-aborted", "detail": "...<runId>..."}`) and NO
   `run-left-open` warning. (`_crucible_axi.run_aborted_warning` does not
   exist yet \u2014 this is the symbol GREEN adds.)
3. When that POST answers non-ok (`RecordingBoard.refuse_next_abort`), the
   envelope carries the EXISTING `run-left-open` warning (unchanged shape)
   and no `run-aborted` warning \u2014 the one abort attempt was made and it
   failed, so the server's own sweep is still what settles the run.

RED today (confirmed by reading every call site of `no_report_left_open_warnings`/
`emit_run_abandoned` and every ingest call that carries `runId` in
`clients/_crucible_axi.py` and all five `clients/*-crucible.py`): none of them
POSTs anything to `.../abort` \u2014 `emit_run_abandoned`'s own docstring says so
("No POST of any kind is made here"), and the no-report/refused-ingest exits
only ever append `run_left_open_warning`. Every test below therefore fails
against the CURRENT fleet on the FIRST assertion that an abort was posted
(`RecordingBoard.aborts()` is always `[]` today), never on an import/fixture
error.

Fixtures reused verbatim from `test_every_opened_run_is_closed_or_disclosed.py`'s
own harness (`RecordingBoard`, the fake runners, `drive_and_signal`) \u2014 this
file adds no second mechanism, only the scripted-refusal hooks
(`RecordingBoard.refuse_next_abort`/`refuse_ingest_for`) and the abort-side
assertions.

Invocation:
    python3 -m unittest tests.client.test_a_client_aborts_a_run_it_cannot_file -v
"""

import signal
import subprocess
import sys
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
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

AGENT = "run-abort-fixture"
PROJECT_KEY = "test-key-run-abort"
PROJECT_NAME = "run-abort-fixture-firmware"
TOON = load_toon()
RUN_ID = "run-live-1"


class _RunAbortCase(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("run-abort-")
        self.scratch = new_scratch("run-abort-scratch-")
        self.bin_dir = new_scratch("run-abort-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    def tearDown(self):
        self.board.close()
        import shutil
        for d in (self.project, self.scratch, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=3, **extra)

    def run_client(self, cmd, env):
        return subprocess.run(cmd, cwd=self.project, env=env,
                              capture_output=True, text=True, timeout=60)

    def axi(self, stdout):
        decoded = TOON.decode(stdout)
        self.assertIn("axi", decoded, f"stdout is not one TOON envelope: {stdout!r}")
        return decoded["axi"]

    def assert_one_abort(self, run_id, reason_fragment):
        """Exactly one abort POST, for the run this client itself opened,
        carrying the project/agent identity and a reason naming the exit."""
        aborts = self.board.aborts()
        self.assertEqual(
            len(aborts), 1,
            f"exactly one abort POST for the run it opened; got {aborts!r}; "
            f"all posts={self.board.posts()!r}")
        path, abort_body = aborts[0]
        self.assertEqual(
            path, f"/api/v2/runs/{run_id}/abort",
            f"the abort targets the run this client itself opened; got path={path!r}")
        self.assertIsInstance(abort_body, dict, f"got body={abort_body!r}")
        self.assertEqual(
            abort_body.get("projectKey"), PROJECT_KEY,
            f"the abort carries this client's own projectKey; got {abort_body!r}")
        self.assertEqual(
            abort_body.get("agentId"), AGENT,
            f"the abort carries this client's own agentId; got {abort_body!r}")
        reason = abort_body.get("reason") or ""
        self.assertIsInstance(reason, str, f"got {abort_body!r}")
        self.assertGreater(len(reason), 0, f"the reason must be non-empty; got {abort_body!r}")
        self.assertIn(
            reason_fragment, reason,
            f"the abort's reason must name the exit that triggered it "
            f"(expected a fragment like {reason_fragment!r}); got reason={reason!r}")
        return abort_body

    def assert_aborted_cleanly(self, axi, verb, run_id, reason_fragment):
        """The abort SUCCEEDED: one abort posted, the envelope discloses the
        run as ABORTED (a `run-aborted` warning naming the run), and carries
        NO `run-left-open` warning \u2014 the server no longer needs to sweep it."""
        paths = [p for p, _ in self.board.posts()]
        self.assertIn(START, paths, f"the run must have been opened; paths={paths!r}")
        self.assert_one_abort(run_id, reason_fragment)
        self.assertEqual(axi.get("verb"), verb)
        self.assertIs(axi.get("ok"), False, f"this exit still files nothing; got {axi!r}")
        warnings = axi.get("warnings") or []
        left_open = [w for w in warnings if w.get("code") == "run-left-open"]
        self.assertEqual(
            left_open, [],
            f"an abort that SUCCEEDED must carry NO run-left-open warning "
            f"(the server has nothing left to sweep); warnings={warnings!r}")
        aborted = [w for w in warnings if w.get("code") == "run-aborted"]
        self.assertEqual(
            len(aborted), 1,
            f"a successful abort must be disclosed by exactly one "
            f"run-aborted warning naming the run; warnings={warnings!r}")
        detail = aborted[0].get("detail") or ""
        self.assertIn(run_id, detail, f"the disclosure must name the aborted run; got {detail!r}")
        return detail

    def assert_left_open_after_refused_abort(self, axi, verb, run_id, reason_fragment):
        """The board REFUSED the abort: the client still made exactly the one
        attempt (naming the exit), but since it failed the envelope falls
        back to the EXISTING `run-left-open` warning \u2014 never a run-aborted
        one, since nothing was actually aborted."""
        self.assert_one_abort(run_id, reason_fragment)
        self.assertEqual(axi.get("verb"), verb)
        warnings = axi.get("warnings") or []
        aborted = [w for w in warnings if w.get("code") == "run-aborted"]
        self.assertEqual(
            aborted, [],
            f"a REFUSED abort must carry no run-aborted warning \u2014 nothing was "
            f"actually aborted; warnings={warnings!r}")
        left_open = [w for w in warnings if w.get("code") == "run-left-open"]
        self.assertEqual(
            len(left_open), 1,
            f"a REFUSED abort falls back to exactly one run-left-open "
            f"warning; warnings={warnings!r}")
        detail = left_open[0].get("detail") or ""
        self.assertIn(run_id, detail, f"the warning must name the open run; got {detail!r}")
        return detail


# ═══════════════════════════════════════════════════════════════════════════
# Exit 1 \u2014 the runner wrote no report
# ═══════════════════════════════════════════════════════════════════════════

class NoReportExitAbortsTheRunTest(_RunAbortCase):

    def test_bun_regression_with_no_junit_aborts_the_run(self):
        fake = write_fake_bun(self.project, 3)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "regression",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        axi = self.axi(result.stdout)
        self.assert_aborted_cleanly(axi, "regression", RUN_ID, "junit.xml")

    def test_bun_regression_with_no_junit_and_a_refused_abort_leaves_the_run_open(self):
        fake = write_fake_bun(self.project, 3)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "regression",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        axi = self.axi(result.stdout)
        self.assert_left_open_after_refused_abort(axi, "regression", RUN_ID, "junit.xml")

    def test_python_regression_with_zero_tests_discovered_aborts_the_run(self):
        fake = write_fake_python(self.project)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "regression",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_DISCOVERY="1"))
        self.assertNotEqual(result.returncode, 0)
        axi = self.axi(result.stdout)
        self.assert_aborted_cleanly(axi, "regression", RUN_ID, "TEST-*.xml")

    def test_python_regression_with_zero_tests_discovered_and_a_refused_abort_leaves_the_run_open(self):
        fake = write_fake_python(self.project)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "regression",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_ZERO_DISCOVERY="1"))
        self.assertNotEqual(result.returncode, 0)
        axi = self.axi(result.stdout)
        self.assert_left_open_after_refused_abort(axi, "regression", RUN_ID, "TEST-*.xml")

    def _rust(self, verb, *extra, refuse=False):
        write_fake_cargo(self.bin_dir)
        if refuse:
            self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), verb, *extra,
             "--project-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        return self.axi(result.stdout)

    def test_rust_regression_ingest_without_junit_aborts_the_run(self):
        axi = self._rust("regression-ingest", "--crates", "fake-crate")
        self.assert_aborted_cleanly(axi, "regression-ingest", RUN_ID, "junit.xml")

    def test_rust_regression_ingest_without_junit_and_a_refused_abort_leaves_the_run_open(self):
        axi = self._rust("regression-ingest", "--crates", "fake-crate", refuse=True)
        self.assert_left_open_after_refused_abort(axi, "regression-ingest", RUN_ID, "junit.xml")

    def test_rust_smoke_test_without_junit_aborts_the_run(self):
        axi = self._rust("smoke-test")
        self.assert_aborted_cleanly(axi, "smoke-test", RUN_ID, "junit.xml")

    def test_rust_smoke_test_without_junit_and_a_refused_abort_leaves_the_run_open(self):
        axi = self._rust("smoke-test", refuse=True)
        self.assert_left_open_after_refused_abort(axi, "smoke-test", RUN_ID, "junit.xml")

    def test_rust_workspace_regression_without_junit_aborts_the_run(self):
        axi = self._rust("workspace-regression", "--min-free-g", "0", "--keep-target")
        self.assert_aborted_cleanly(axi, "workspace-regression", RUN_ID, "junit.xml")

    def test_rust_workspace_regression_without_junit_and_a_refused_abort_leaves_the_run_open(self):
        axi = self._rust("workspace-regression", "--min-free-g", "0", "--keep-target", refuse=True)
        self.assert_left_open_after_refused_abort(axi, "workspace-regression", RUN_ID, "junit.xml")

    def test_arduino_unit_without_a_report_aborts_the_run(self):
        write_fake_native(self.project)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        self.assert_aborted_cleanly(self.axi(result.stdout), "unit", RUN_ID, "TEST-*.xml")

    def test_arduino_unit_without_a_report_and_a_refused_abort_leaves_the_run_open(self):
        write_fake_native(self.project)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        self.assert_left_open_after_refused_abort(self.axi(result.stdout), "unit", RUN_ID, "TEST-*.xml")


# ═══════════════════════════════════════════════════════════════════════════
# Exit 2 \u2014 SIGINT / SIGTERM mid-run, every run-opening verb family the
# existing five-client harness already drives.
# ═══════════════════════════════════════════════════════════════════════════

class SignalExitAbortsTheRunTest(_RunAbortCase):
    """Interrupt parity, extended: the same trap, but now the client's own
    `finally` posts the abort before the envelope is built."""

    def _signal(self, verb, cmd, env, signum, refuse):
        if refuse:
            self.board.refuse_next_abort()
        reached, code, stdout, stderr = drive_and_signal(
            cmd, self.project, env, self.scratch, signum)
        self.assertTrue(reached, f"the runner never blocked; stderr={stderr[-2000:]!r}")
        signame = signal.Signals(signum).name
        self.assertEqual(
            code, 128 + signum,
            f"a signalled run exits 128+signum; stdout={stdout!r} "
            f"stderr={stderr[-2000:]!r}")
        axi = self.axi(stdout)
        if refuse:
            detail = self.assert_left_open_after_refused_abort(axi, verb, RUN_ID, signame)
        else:
            detail = self.assert_aborted_cleanly(axi, verb, RUN_ID, signame)
        self.assertIn(signame, detail, "the disclosure names the signal")
        self.assertEqual(axi.get("signal"), signame)
        self.assertEqual(axi.get("runId"), RUN_ID)

    def _each_signal(self, verb, make_cmd, env, refuse):
        for signum in SIGNALS:
            with self.subTest(signal=signal.Signals(signum).name, refuse=refuse):
                self.board.close()
                self.board = RecordingBoard()
                install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)
                self._signal(verb, make_cmd(), env, signum, refuse)

    def test_bun_test(self):
        fake = write_fake_bun(self.project, 3)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
            "--bun", fake, "--project-dir", self.project,
            "--package-dir", self.project, "--reports", "reports",
            "--agent", AGENT], self.env(), refuse=False)

    def test_bun_test_refused_abort_leaves_the_run_open(self):
        fake = write_fake_bun(self.project, 3)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
            "--bun", fake, "--project-dir", self.project,
            "--package-dir", self.project, "--reports", "reports",
            "--agent", AGENT], self.env(), refuse=True)

    def test_mvn_unit(self):
        write_fake_mvnw(self.project)
        self._each_signal("unit", lambda: [
            sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
            "--test", "LiveCase*", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=False)

    def test_mvn_unit_refused_abort_leaves_the_run_open(self):
        write_fake_mvnw(self.project)
        self._each_signal("unit", lambda: [
            sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
            "--test", "LiveCase*", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=True)

    def test_python_test(self):
        fake = write_fake_python(self.project)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "python-crucible.py"), "test",
            "--python", fake, "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=False)

    def test_python_test_refused_abort_leaves_the_run_open(self):
        fake = write_fake_python(self.project)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "python-crucible.py"), "test",
            "--python", fake, "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=True)

    def test_rust_test(self):
        write_fake_cargo(self.bin_dir)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
            "--crate", "fake-crate", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=False)

    def test_rust_test_refused_abort_leaves_the_run_open(self):
        write_fake_cargo(self.bin_dir)
        self._each_signal("test", lambda: [
            sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
            "--crate", "fake-crate", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=True)

    def test_arduino_unit(self):
        write_fake_native(self.project)
        self._each_signal("unit", lambda: [
            sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
            "--dir", "tests/native", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=False)

    def test_arduino_unit_refused_abort_leaves_the_run_open(self):
        write_fake_native(self.project)
        self._each_signal("unit", lambda: [
            sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
            "--dir", "tests/native", "--project-dir", self.project,
            "--reports", "reports", "--agent", AGENT], self.env(), refuse=True)


# ═══════════════════════════════════════════════════════════════════════════
# Exit 3 \u2014 the board refused the ingest that carried the runId, for each
# client's main suite verb.
# ═══════════════════════════════════════════════════════════════════════════

class RefusedIngestAbortsTheRunTest(_RunAbortCase):
    """The runner succeeded and wrote a real report \u2014 only the BOARD refuses
    the ingest that would have closed the run it opened. Unlike the other two
    exits, the client has something to show for the run; the abort reason
    must say the ingest itself was refused, not that nothing was produced."""

    def test_bun_test_ingest_refused_aborts_the_run(self):
        fake = write_fake_bun(self.project, 3)
        self.board.refuse_ingest_for(RUN_ID)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_aborted_cleanly(self.axi(result.stdout), "test", RUN_ID, "refused")

    def test_bun_test_ingest_and_abort_both_refused_leaves_the_run_open(self):
        fake = write_fake_bun(self.project, 3)
        self.board.refuse_ingest_for(RUN_ID)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_left_open_after_refused_abort(self.axi(result.stdout), "test", RUN_ID, "refused")

    def test_mvn_unit_ingest_refused_aborts_the_run(self):
        write_fake_mvnw(self.project)
        self.board.refuse_ingest_for(RUN_ID)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
             "--test", "LiveCase*", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        # mvn's `unit`/`module` body (`_run_surefire_tier`) returns 0 whenever
        # an ingest was ATTEMPTED, regardless of whether it succeeded (it never
        # reads `resp.get("ok")` for its exit code \u2014 unlike every other main
        # suite verb here) \u2014 so the exit code is not asserted for this client;
        # the envelope's own `ok: false` (checked inside the helper below) is.
        self.assert_aborted_cleanly(self.axi(result.stdout), "unit", RUN_ID, "refused")

    def test_mvn_unit_ingest_and_abort_both_refused_leaves_the_run_open(self):
        write_fake_mvnw(self.project)
        self.board.refuse_ingest_for(RUN_ID)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
             "--test", "LiveCase*", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assert_left_open_after_refused_abort(self.axi(result.stdout), "unit", RUN_ID, "refused")

    def test_python_test_ingest_refused_aborts_the_run(self):
        fake = write_fake_python(self.project)
        self.board.refuse_ingest_for(RUN_ID)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_aborted_cleanly(self.axi(result.stdout), "test", RUN_ID, "refused")

    def test_python_test_ingest_and_abort_both_refused_leaves_the_run_open(self):
        fake = write_fake_python(self.project)
        self.board.refuse_ingest_for(RUN_ID)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_left_open_after_refused_abort(self.axi(result.stdout), "test", RUN_ID, "refused")

    def test_rust_test_ingest_refused_aborts_the_run(self):
        write_fake_cargo(self.bin_dir)
        self.board.refuse_ingest_for(RUN_ID)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
             "--crate", "fake-crate", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_aborted_cleanly(self.axi(result.stdout), "test", RUN_ID, "refused")

    def test_rust_test_ingest_and_abort_both_refused_leaves_the_run_open(self):
        write_fake_cargo(self.bin_dir)
        self.board.refuse_ingest_for(RUN_ID)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
             "--crate", "fake-crate", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_left_open_after_refused_abort(self.axi(result.stdout), "test", RUN_ID, "refused")

    def test_arduino_unit_ingest_refused_aborts_the_run(self):
        write_fake_native(self.project)
        self.board.refuse_ingest_for(RUN_ID)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_aborted_cleanly(self.axi(result.stdout), "unit", RUN_ID, "refused")

    def test_arduino_unit_ingest_and_abort_both_refused_leaves_the_run_open(self):
        write_fake_native(self.project)
        self.board.refuse_ingest_for(RUN_ID)
        self.board.refuse_next_abort()
        result = self.run_client(
            [sys.executable, str(CLIENTS / "arduino-crucible.py"), "unit",
             "--dir", "tests/native", "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT], self.env())
        self.assertNotEqual(result.returncode, 0)
        self.assert_left_open_after_refused_abort(self.axi(result.stdout), "unit", RUN_ID, "refused")


# ═══════════════════════════════════════════════════════════════════════════
# An exit that already files something (a compile event carrying the runId)
# stays UNCHANGED \u2014 it closes the run by filing, and needs no abort.
# ═══════════════════════════════════════════════════════════════════════════

class ExitsThatAlreadyFileSomethingStayUnchangedTest(_RunAbortCase):
    """NOT a RED test by construction \u2014 a stability PIN for behaviour \u00a7S2
    explicitly leaves untouched. It passes today (no abort route is called
    anywhere yet, so `aborts() == []` trivially) and must keep passing once
    GREEN lands the abort-posting paths above: a GREEN that posted an abort
    on EVERY exit that files nothing \u2014 rather than only the ones with
    nothing filed at all \u2014 would send a needless abort for a run the
    compile ingest below has ALREADY closed, and this test would then catch
    that over-reach (the compile ingest closes the run server-side via its
    own `runId`, so a trailing abort would 409 \u2014 \"run already settled\" \u2014
    which is exactly the race \u00a7S1's refusal table exists to catch)."""

    def test_bun_test_with_no_junit_still_files_its_compile_event_and_posts_no_abort(self):
        fake = write_fake_bun(self.project, 3)
        result = self.run_client(
            [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
             "--bun", fake, "--project-dir", self.project,
             "--package-dir", self.project, "--reports", "reports",
             "--agent", AGENT],
            self.env(FAKE_NO_REPORT="1"))
        self.assertNotEqual(result.returncode, 0)
        compile_posts = [b for p, b in self.board.posts() if p == "/api/v2/runs/compile"]
        self.assertEqual(
            len(compile_posts), 1,
            f"a collection/compile failure must still file ONE compile "
            f"event; posts={self.board.posts()!r}")
        self.assertEqual(
            compile_posts[0].get("runId"), RUN_ID,
            f"the compile event must carry the runId it closes; got "
            f"{compile_posts[0]!r}")
        self.assertEqual(
            self.board.aborts(), [],
            f"a run already closed by its own compile event needs no "
            f"abort; posts={self.board.posts()!r}")


if __name__ == "__main__":
    unittest.main()
