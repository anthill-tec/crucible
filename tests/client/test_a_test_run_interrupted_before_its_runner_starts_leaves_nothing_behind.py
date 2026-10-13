"""§S1 RED — the gated-run identity bracket (`gated_run`, shared by every
test-family verb: bun's `cmd_test`/`cmd_regression`, python's
`cmd_test`/`cmd_regression`, mvn's `_run_surefire_tier`/`_run_failsafe_tier`/
`cmd_regression`/`cmd_test`, rust's `cmd_regression_ingest`/`cmd_test`/
`cmd_smoke_test`/`cmd_workspace_regression`, and arduino's
`_run_native_tests`) must trap SIGINT/SIGTERM for its WHOLE body once
`--agent` is given — opening the identity INSIDE the trap's `held()` span —
exactly as `drive_axi_run`'s run-identity bracket already does for
`gate-run` (`abandon_trap(agent_id)` wraps `DrivenRunIdentity.poster_for`'s
own `trap.held()` opening). These tests drive the same held-reply seam that
proves that already-fixed sibling: `RecordingBoard.hold_next_reply` /
`release_held` (`tests/client/live_run_harness.py`).

Ground truth, read directly off `clients/_crucible_axi.py` on this branch:
`gated_run`'s `open_fn`/`close_fn` calls, and `open_run`'s own
`/api/v2/runs/start` POST, are made OUTSIDE any `abandon_trap` at all — every
test-family verb only ever wraps the RUNNER itself, via
`with ... abandon_trap(run_id):`, and that `with` is entered only AFTER
`_start_run`/`open_run` has already returned. So three windows are
untrapped today exactly as the CR's "spans" list says: the identity's
opening heartbeat, `/runs/start` itself, and (when `/runs/start` opened
nothing) the runner that follows it. A SIGTERM landing in any of them takes
its DEFAULT disposition and kills the process outright — no `finally` ever
runs, so nothing is removed and the exit code is the raw `-signum`, never
`128+signum`. A SIGINT raises an ordinary, UNCAUGHT `KeyboardInterrupt` (no
`clients/*.py` installs a handler for it anywhere outside `abandon_trap`
itself, and that trap is not yet installed this early) — CPython prints a
traceback to stderr and exits 1, never `128+signum`, and stdout carries no
`axi` envelope at all. Every assertion below fails against the CURRENT
fleet for exactly one of those two reasons, never an import/fixture error.

Driven the same way `test_a_gate_is_running_only_while_its_run_is_driven_or_held.py`
drives gate-run's OWN (already-fixed) identity bracket, and
`test_a_client_aborts_a_run_it_cannot_file.py` drives the runner-interrupt /
abort path this CR leaves untouched: a REAL client subprocess against a real
`RecordingBoard`, using its held-reply seam and each stack's fake runner.
§S2 ("the ingest is held") is the NEXT cycle's scope and is not covered
here.

Invocation:
    python3 -m unittest tests.client.test_a_test_run_interrupted_before_its_runner_starts_leaves_nothing_behind -v
"""

import shutil
import signal
import subprocess
import sys
import time
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

AGENT = "interrupted-opening-fixture"
PROJECT_KEY = "test-key-interrupted-opening"
PROJECT_NAME = "interrupted-opening-firmware"
HEARTBEAT_PATH = "/api/v2/agents/heartbeat"
UNREGISTER_PATH = "/api/v2/agents/unregister"
TOON = load_toon()


def _removals_for(posts, agent_id):
    return [b for p, b in posts if p == UNREGISTER_PATH
            and isinstance(b, dict) and b.get("agentId") == agent_id]


def _wait_for_any_post(board, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if board.posts():
            return True
        time.sleep(0.02)
    return False


def _wait_for_post(board, path, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(p == path for p, _ in board.posts()):
            return True
        time.sleep(0.02)
    return False


class _OpeningSignalCase(unittest.TestCase):
    """Shared fixtures: one project per test, a fresh `RecordingBoard` per
    drive (each drive needs its own `run-live-1` sequence), and every fake
    runner the 13 call sites between them need. The runner never actually
    spawns in any case this file drives — the signal always lands before it
    would — so one instance of each fake, built once in `setUp`, serves
    every call site."""

    def setUp(self):
        self.project = new_scratch("opening-signal-")
        self.scratch = new_scratch("opening-signal-scratch-")
        self.bin_dir = new_scratch("opening-signal-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)
        self.fake_bun = write_fake_bun(self.project, 3)
        self.fake_python = write_fake_python(self.project)
        write_fake_mvnw(self.project)
        write_fake_cargo(self.bin_dir)
        write_fake_native(self.project)

    def tearDown(self):
        self.board.close()
        for d in (self.project, self.scratch, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, **extra)

    def _fresh_board(self):
        self.board.close()
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    def _axi(self, stdout):
        decoded = TOON.decode(stdout)
        self.assertIn("axi", decoded, f"stdout is not one TOON envelope: {stdout!r}")
        return decoded["axi"]

    # ── the 13 call sites' own argv, one builder per site ───────────────────

    def _bun_test_cmd(self):
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
                "--bun", self.fake_bun, "--project-dir", self.project,
                "--package-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _bun_regression_cmd(self):
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "regression",
                "--bun", self.fake_bun, "--project-dir", self.project,
                "--package-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _python_test_cmd(self):
        return [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
                "--python", self.fake_python, "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _python_regression_cmd(self):
        return [sys.executable, str(CLIENTS / "python-crucible.py"), "regression",
                "--python", self.fake_python, "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _mvn_unit_cmd(self):
        return [sys.executable, str(CLIENTS / "mvn-crucible.py"), "unit",
                "--test", "LiveCase*", "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _mvn_integration_cmd(self):
        return [sys.executable, str(CLIENTS / "mvn-crucible.py"), "integration",
                "--project-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _mvn_regression_cmd(self):
        return [sys.executable, str(CLIENTS / "mvn-crucible.py"), "regression",
                "--project-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _mvn_test_cmd(self):
        return [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
                "--test", "LiveCase*", "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _rust_regression_ingest_cmd(self):
        return [sys.executable, str(CLIENTS / "rust-crucible.py"),
                "regression-ingest", "--crates", "fake-crate",
                "--project-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _rust_test_cmd(self):
        return [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
                "--crate", "fake-crate", "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _rust_smoke_test_cmd(self):
        return [sys.executable, str(CLIENTS / "rust-crucible.py"), "smoke-test",
                "--project-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _rust_workspace_regression_cmd(self):
        return [sys.executable, str(CLIENTS / "rust-crucible.py"),
                "workspace-regression", "--min-free-g", "0", "--keep-target",
                "--project-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _arduino_test_cmd(self):
        return [sys.executable, str(CLIENTS / "arduino-crucible.py"), "test",
                "--dir", "tests/native", "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    # ── drives ────────────────────────────────────────────────────────────

    def _drive_held_heartbeat_signal(self, cmd, signum):
        """Hold the identity's OPENING heartbeat's reply, wait for it to
        reach the board, signal the client, THEN release the reply — the
        window gate-run's own identity bracket already closed for its own
        identity."""
        self.board.hold_next_reply(HEARTBEAT_PATH)
        proc = subprocess.Popen(cmd, cwd=self.project, env=self.env(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        try:
            self.assertTrue(
                _wait_for_any_post(self.board),
                "the run never reached the board at all (no POST within the "
                "wait window)")
            first_path, first_body = self.board.posts()[0]
            self.assertEqual(
                (first_path, first_body.get("agentId")),
                (HEARTBEAT_PATH, AGENT),
                f"the first POST must be the identity's opening heartbeat; "
                f"got {self.board.posts()!r}")
            proc.send_signal(signum)
            self.board.release_held()
            try:
                stdout, stderr = proc.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate(timeout=10)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        return proc.returncode, stdout, stderr

    def _drive_held_start_signal(self, cmd, signum):
        """Let the identity open normally, then hold `/runs/start`'s reply,
        wait for that POST to reach the board, signal the client, THEN
        release it."""
        self.board.hold_next_reply(START)
        proc = subprocess.Popen(cmd, cwd=self.project, env=self.env(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        try:
            self.assertTrue(
                _wait_for_post(self.board, START),
                "/runs/start never reached the board at all")
            proc.send_signal(signum)
            self.board.release_held()
            try:
                stdout, stderr = proc.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate(timeout=10)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        return proc.returncode, stdout, stderr

    # ── shared assertions ────────────────────────────────────────────────

    def _assert_opening_signal_removed_the_identity(self, label, signum, code,
                                                     stdout, stderr):
        signame = signal.Signals(signum).name
        removals = _removals_for(self.board.posts(), AGENT)
        self.assertEqual(
            len(removals), 1,
            f"{label}: a {signame} landing while the identity's opening "
            f"heartbeat was held must still remove it (one removal); got "
            f"{len(removals)}: {removals!r}; all posts="
            f"{self.board.posts()!r}; exit={code}; stderr={stderr[-2000:]!r}")
        self.assertIs(
            removals[0].get("silent"), True,
            f"{label}: removal must be silent=True; got {removals[0]!r}")
        paths = [p for p, _ in self.board.posts()]
        self.assertNotIn(
            START, paths,
            f"{label}: no run must be left open when the signal landed "
            f"before /runs/start was ever reached; paths={paths!r}")
        self.assertEqual(
            code, 128 + signum,
            f"{label}: a signalled opening exits 128+signum; got {code}; "
            f"stdout={stdout!r} stderr={stderr[-2000:]!r}")
        axi = self._axi(stdout)
        self.assertEqual(
            axi.get("signal"), signame,
            f"{label}: the envelope must name {signame}; got {axi!r}")

    def _assert_run_opening_signal_aborted_the_run(self, label, signum, code,
                                                    stdout, stderr):
        signame = signal.Signals(signum).name
        run_ids = self.board.run_ids_opened()
        self.assertEqual(
            len(run_ids), 1,
            f"{label}: exactly one run must have been opened; got "
            f"{run_ids!r}; posts={self.board.posts()!r}")
        run_id = run_ids[0]
        aborts = self.board.aborts()
        self.assertEqual(
            len(aborts), 1,
            f"{label}: a {signame} landing while /runs/start's reply was "
            f"held must still abort the run it opened (one abort); got "
            f"{len(aborts)}: {aborts!r}; all posts={self.board.posts()!r}; "
            f"exit={code}; stderr={stderr[-2000:]!r}")
        path, body = aborts[0]
        self.assertEqual(
            path, f"/api/v2/runs/{run_id}/abort",
            f"{label}: the abort must target the run this drive opened; "
            f"got path={path!r}")
        reason = (body or {}).get("reason") or ""
        self.assertIn(
            signame, reason,
            f"{label}: the abort's reason must name the signal; got "
            f"reason={reason!r}")
        removals = _removals_for(self.board.posts(), AGENT)
        self.assertEqual(
            len(removals), 1,
            f"{label}: the identity must still be removed; got "
            f"{len(removals)}: {removals!r}")
        self.assertEqual(
            code, 128 + signum,
            f"{label}: exit is 128+signum; got {code}; "
            f"stderr={stderr[-2000:]!r}")


# The call-site table the spec names: (client, call site, the ONE verb this
# file drives it through, the argv builder above for that verb). Named by
# VERB in every subTest/assertion below, never by line number.
CALL_SITES = (
    ("bun", "cmd_test", "test", "_bun_test_cmd"),
    ("bun", "cmd_regression", "regression", "_bun_regression_cmd"),
    ("python", "cmd_test", "test", "_python_test_cmd"),
    ("python", "cmd_regression", "regression", "_python_regression_cmd"),
    ("mvn", "_run_surefire_tier", "unit", "_mvn_unit_cmd"),
    ("mvn", "_run_failsafe_tier", "integration", "_mvn_integration_cmd"),
    ("mvn", "cmd_regression", "regression", "_mvn_regression_cmd"),
    ("mvn", "cmd_test", "test", "_mvn_test_cmd"),
    ("rust", "cmd_regression_ingest", "regression-ingest",
     "_rust_regression_ingest_cmd"),
    ("rust", "cmd_test", "test", "_rust_test_cmd"),
    ("rust", "cmd_smoke_test", "smoke-test", "_rust_smoke_test_cmd"),
    ("rust", "cmd_workspace_regression", "workspace-regression",
     "_rust_workspace_regression_cmd"),
    ("arduino", "_run_native_tests", "test", "_arduino_test_cmd"),
)

# AC "Opening, both signals" / "Run opening" / "No run opened" each name
# "EACH of the five clients (its `test` verb)" — the subset of the table
# above whose verb is `test`.
TEST_VERB_SITES = tuple(site for site in CALL_SITES if site[2] == "test")


# ═══════════════════════════════════════════════════════════════════════════
# AC "Opening, every call site" — SIGTERM, one per call site.
# ═══════════════════════════════════════════════════════════════════════════

class OpeningEveryCallSiteRemovesTheIdentityTest(_OpeningSignalCase):

    def test_the_call_site_table_names_exactly_thirteen_sites(self):
        self.assertEqual(
            len(CALL_SITES), 13,
            f"the spec's call-site table names 13 call sites; got "
            f"{len(CALL_SITES)}: {CALL_SITES!r}")

    def test_every_call_site_removes_the_identity_and_leaves_no_run_open_on_sigterm(self):
        for key, site, verb, builder_name in CALL_SITES:
            with self.subTest(client=key, call_site=site, verb=verb):
                self._fresh_board()
                cmd = getattr(self, builder_name)()
                code, stdout, stderr = self._drive_held_heartbeat_signal(
                    cmd, signal.SIGTERM)
                self._assert_opening_signal_removed_the_identity(
                    f"{key} {site} ({verb})", signal.SIGTERM, code, stdout,
                    stderr)


# ═══════════════════════════════════════════════════════════════════════════
# AC "Opening, both signals" — SIGINT and SIGTERM, the `test` verb, 5 clients.
# ═══════════════════════════════════════════════════════════════════════════

class OpeningBothSignalsRemoveTheIdentityTest(_OpeningSignalCase):

    def test_the_test_verbs_call_sites_cover_exactly_five_clients(self):
        self.assertEqual(
            {key for key, *_rest in TEST_VERB_SITES},
            {"bun", "python", "mvn", "rust", "arduino"},
            repr(TEST_VERB_SITES))

    def test_every_clients_test_verb_removes_the_identity_on_either_signal(self):
        for key, _site, _verb, builder_name in TEST_VERB_SITES:
            for signum in SIGNALS:
                with self.subTest(client=key, signal=signal.Signals(signum).name):
                    self._fresh_board()
                    cmd = getattr(self, builder_name)()
                    code, stdout, stderr = self._drive_held_heartbeat_signal(
                        cmd, signum)
                    self._assert_opening_signal_removed_the_identity(
                        f"{key} test", signum, code, stdout, stderr)


# ═══════════════════════════════════════════════════════════════════════════
# AC "Run opening" — SIGINT and SIGTERM while `/runs/start`'s reply is held.
# ═══════════════════════════════════════════════════════════════════════════

class RunOpeningAbortsTheRunAndRemovesTheIdentityTest(_OpeningSignalCase):

    def test_every_clients_test_verb_aborts_the_run_it_was_opening_when_held(self):
        for key, _site, _verb, builder_name in TEST_VERB_SITES:
            for signum in SIGNALS:
                with self.subTest(client=key, signal=signal.Signals(signum).name):
                    self._fresh_board()
                    cmd = getattr(self, builder_name)()
                    code, stdout, stderr = self._drive_held_start_signal(
                        cmd, signum)
                    self._assert_run_opening_signal_aborted_the_run(
                        f"{key} test", signum, code, stdout, stderr)


# ═══════════════════════════════════════════════════════════════════════════
# AC "No run opened" — the board REFUSES `/runs/start`; SIGTERM mid-runner.
# ═══════════════════════════════════════════════════════════════════════════

class NoRunOpenedRemovesTheIdentityOnRunnerSignalTest(_OpeningSignalCase):
    """`/runs/start` degrades to single-shot (`open_run`'s existing refusal
    fallback — unchanged by this CR), so `run_id` is None and
    `abandon_trap(None)` is today INERT for the runner span (its own
    documented early return). A SIGTERM mid-runner then takes its default
    disposition exactly as the untrapped identity-opening window does, even
    though the identity's opening heartbeat itself succeeded moments
    earlier and the board already holds it."""

    def test_every_clients_test_verb_removes_the_identity_on_sigterm_mid_runner(self):
        for key, _site, _verb, builder_name in TEST_VERB_SITES:
            with self.subTest(client=key):
                self._fresh_board()
                self.board.refuse_next_start()
                cmd = getattr(self, builder_name)()
                reached, code, stdout, stderr = drive_and_signal(
                    cmd, self.project, self.env(), self.scratch, signal.SIGTERM)
                self.assertTrue(
                    reached,
                    f"{key}: the runner never blocked; "
                    f"stderr={stderr[-2000:]!r}")
                paths = [p for p, _ in self.board.posts()]
                self.assertIn(
                    START, paths,
                    f"{key}: /runs/start must have been attempted; "
                    f"paths={paths!r}")
                removals = _removals_for(self.board.posts(), AGENT)
                self.assertEqual(
                    len(removals), 1,
                    f"{key}: a SIGTERM mid-runner, with no run ever opened "
                    f"(the board refused /runs/start), must still remove "
                    f"the identity (one removal); got {len(removals)}: "
                    f"{removals!r}; posts={self.board.posts()!r}; "
                    f"exit={code}; stderr={stderr[-2000:]!r}")
                self.assertIs(
                    removals[0].get("silent"), True,
                    f"{key}: removal must be silent=True; got "
                    f"{removals[0]!r}")
                self.assertEqual(
                    code, 143,
                    f"{key}: a SIGTERM'd run exits 143; got {code}; "
                    f"stdout={stdout!r} stderr={stderr[-2000:]!r}")


# ═══════════════════════════════════════════════════════════════════════════
# "Runner unchanged" pin — stability, NOT RED by construction: the one span
# `abandon_trap` already wraps today (the runner, once `/runs/start` has
# already returned a real run id) is untouched by this change and must keep
# behaving exactly as the runner-interrupt abort the clients already have
# does today. A representative single case; the fleet-wide sweep of this span
# already lives in
# `test_a_client_aborts_a_run_it_cannot_file.py` and is not duplicated here.
# ═══════════════════════════════════════════════════════════════════════════

class RunnerSignalAbortBehaviorStaysUnchangedTest(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("runner-unchanged-")
        self.scratch = new_scratch("runner-unchanged-scratch-")
        self.bin_dir = new_scratch("runner-unchanged-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    def tearDown(self):
        self.board.close()
        for d in (self.project, self.scratch, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=3, **extra)

    def _axi(self, stdout):
        decoded = TOON.decode(stdout)
        self.assertIn("axi", decoded, f"stdout is not one TOON envelope: {stdout!r}")
        return decoded["axi"]

    def test_python_test_signal_mid_runner_still_aborts_the_opened_run(self):
        fake = write_fake_python(self.project)
        reached, code, stdout, stderr = drive_and_signal(
            [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
             "--python", fake, "--project-dir", self.project,
             "--reports", "reports", "--agent", AGENT],
            self.project, self.env(), self.scratch, signal.SIGTERM)
        self.assertTrue(
            reached, f"the runner never blocked; stderr={stderr[-2000:]!r}")
        self.assertEqual(
            code, 128 + signal.SIGTERM,
            f"got {code}; stdout={stdout!r} stderr={stderr[-2000:]!r}")
        axi = self._axi(stdout)
        self.assertEqual(axi.get("signal"), "SIGTERM")
        aborts = self.board.aborts()
        self.assertEqual(
            len(aborts), 1,
            f"the run the runner had already opened must still be "
            f"aborted exactly once; got {aborts!r}")
        removals = _removals_for(self.board.posts(), AGENT)
        self.assertEqual(
            len(removals), 1,
            f"the identity must still be removed; got {removals!r}")


if __name__ == "__main__":
    unittest.main()
