"""§S3 RED — `run_streamed` (`clients/_crucible_axi.py`) starts the test
runner in the CLIENT's own process group and, on an interrupt, kills only
that ONE direct child (its `except BaseException: proc.kill(); proc.wait();
raise` in the teed `Popen` branch; nothing at all in the inherited-stdio
`subprocess.run` branch beyond `subprocess.run`'s own built-in
`except: process.kill()`). A runner that spawns its OWN child — exactly the
shape of the real incident (`bun run test:e2e` starting Playwright, which
starts its own test server) — keeps that descendant alive, re-parented, once
the direct child is reaped. The fix this CR asks for is a GROUP kill
(SIGTERM, then SIGKILL after a grace, across the runner's whole session);
today only the one process named in the `Popen`/`subprocess.run` call dies.

Ground truth, read directly off `clients/_crucible_axi.py` on this branch:
neither `subprocess.Popen` call in `run_streamed` passes
`start_new_session=True` or any `process_group=`, and neither exception path
signals anything beyond the ONE pid it already holds a handle to. A
descendant that pid spawned on its own is never addressed at all.

Empirically confirmed against the CURRENT fleet (not asserted from reading
alone): a fake runner that forks a long-lived grandchild and writes its pid
(`FAKE_GRANDCHILD_PIDFILE`, `tests/client/live_run_harness.py`), driven
through each of the five clients' `test` verb and interrupted mid-run via
`drive_and_signal`, already exits 128+signum today — CR-CRU-184's trap
already covers the DIRECT child correctly — but the grandchild is still
alive, by pid, after the client process has fully exited, for every one of
the five clients. That is the one new assertion every test below fails on;
none fails on an import/fixture error.

Invocation:
    python3 -m unittest tests.client.test_an_interrupted_runners_tree_is_taken_down_with_it -v
"""

import shutil
import signal
import subprocess
import sys
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    drive_and_signal,
    fresh_grandchild_pidfile,
    install_project,
    kill_pid_if_alive,
    new_scratch,
    pid_alive,
    scrubbed_env,
    wait_for_pid_gone,
    wait_for_pidfile,
    write_fake_bun,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_native,
    write_fake_python,
)

AGENT = "process-tree-fixture"
PROJECT_KEY = "test-key-process-tree"
PROJECT_NAME = "process-tree-fixture-firmware"


class _ProcessTreeCase(unittest.TestCase):
    """Shared fixtures: one project, one fake per stack, and a tracked list
    of every grandchild pid this test started — killed in `tearDown`
    REGARDLESS of whether the assertion on it passed, so a RED failure
    (today's bug: the grandchild survives) never leaks a sleeping process
    past this test, exactly as the dispatch's own constraint requires."""

    def setUp(self):
        self.project = new_scratch("process-tree-")
        self.scratch = new_scratch("process-tree-scratch-")
        self.bin_dir = new_scratch("process-tree-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)
        self.fake_bun = write_fake_bun(self.project, 3)
        self.fake_python = write_fake_python(self.project)
        write_fake_mvnw(self.project)
        write_fake_cargo(self.bin_dir)
        write_fake_native(self.project)
        self._grandchild_pids = []

    def tearDown(self):
        for pid in self._grandchild_pids:
            kill_pid_if_alive(pid)
        self.board.close()
        for d in (self.project, self.scratch, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=3, **extra)

    def _fresh_board(self):
        self.board.close()
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    # ── the five clients' `test` verb, one builder per client ──────────────

    def _bun_test_cmd(self):
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
               "--bun", self.fake_bun, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports",
               "--agent", AGENT]

    def _bun_test_cmd_no_agent(self):
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
               "--bun", self.fake_bun, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports"]

    def _python_test_cmd(self):
        return [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
               "--python", self.fake_python, "--project-dir", self.project,
               "--reports", "reports", "--agent", AGENT]

    def _mvn_test_cmd(self):
        return [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
               "--test", "LiveCase*", "--project-dir", self.project,
               "--reports", "reports", "--agent", AGENT]

    def _mvn_test_cmd_no_agent(self):
        return [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
               "--test", "LiveCase*", "--project-dir", self.project,
               "--reports", "reports"]

    def _rust_test_cmd(self):
        return [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
               "--crate", "fake-crate", "--project-dir", self.project,
               "--reports", "reports", "--agent", AGENT]

    def _arduino_test_cmd(self):
        return [sys.executable, str(CLIENTS / "arduino-crucible.py"), "test",
               "--dir", "tests/native", "--project-dir", self.project,
               "--reports", "reports", "--agent", AGENT]


CLIENT_TEST_CMDS = (
    ("bun", "_bun_test_cmd"),
    ("python", "_python_test_cmd"),
    ("mvn", "_mvn_test_cmd"),
    ("rust", "_rust_test_cmd"),
    ("arduino", "_arduino_test_cmd"),
)


# ═══════════════════════════════════════════════════════════════════════════
# AC "The runner's tree is killed" — SIGTERM mid-run, 5 clients' `test` verb.
# ═══════════════════════════════════════════════════════════════════════════

class SigtermTakesTheWholeRunnerTreeDownTest(_ProcessTreeCase):

    def test_every_clients_test_verb_covers_exactly_five_clients(self):
        self.assertEqual(
            {key for key, _builder in CLIENT_TEST_CMDS},
            {"bun", "python", "mvn", "rust", "arduino"},
            repr(CLIENT_TEST_CMDS))

    def test_sigterm_mid_run_leaves_no_grandchild_alive_and_exits_143(self):
        for key, builder_name in CLIENT_TEST_CMDS:
            with self.subTest(client=key):
                self._fresh_board()
                pidfile = fresh_grandchild_pidfile(self.scratch)
                cmd = getattr(self, builder_name)()
                env = dict(self.env(), FAKE_GRANDCHILD_PIDFILE=pidfile)
                reached, code, stdout, stderr = drive_and_signal(
                    cmd, self.project, env, self.scratch, signal.SIGTERM)
                self.assertTrue(
                    reached,
                    f"{key}: the runner never blocked mid-run; "
                    f"stderr={stderr[-2000:]!r}")
                pid = wait_for_pidfile(pidfile, timeout=10)
                self.assertIsNotNone(
                    pid,
                    f"{key}: fixture failure — the grandchild never wrote "
                    f"its own pidfile; stderr={stderr[-2000:]!r}")
                self._grandchild_pids.append(pid)
                self.assertTrue(
                    pid_alive(pid),
                    f"{key}: fixture failure — the grandchild must be alive "
                    f"right after it reported its pid")
                self.assertEqual(
                    code, 143,
                    f"{key}: a SIGTERM to the client during the runner "
                    f"exits 128+SIGTERM (143); got {code}; "
                    f"stdout={stdout!r} stderr={stderr[-2000:]!r}")
                gone = wait_for_pid_gone(pid, timeout=10)
                self.assertTrue(
                    gone,
                    f"{key}: the runner's GRANDCHILD (pid {pid}) must be "
                    f"dead once the client has exited — a SIGTERM to the "
                    f"client must take its whole descendant tree down, not "
                    f"only the direct child runner it holds a Popen handle "
                    f"to; stdout={stdout!r} stderr={stderr[-2000:]!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC "...A runner that exits on its own leaves its normal exit unchanged."
# ═══════════════════════════════════════════════════════════════════════════

class ARunnerThatExitsOnItsOwnKeepsItsNormalExitTest(_ProcessTreeCase):
    """NOT a RED test by construction — a stability pin. No grandchild, no
    signal: every one of the five clients' `test` verb already exits 0 on a
    green run today, and the group-kill fix must not touch that path at
    all."""

    def test_every_clients_test_verb_still_exits_zero_on_a_green_run(self):
        for key, builder_name in CLIENT_TEST_CMDS:
            with self.subTest(client=key):
                self._fresh_board()
                cmd = getattr(self, builder_name)()
                result = subprocess.run(cmd, cwd=self.project, env=self.env(),
                                        capture_output=True, text=True,
                                        timeout=30)
                self.assertEqual(
                    result.returncode, 0,
                    f"{key}: an UNinterrupted green run must still exit 0; "
                    f"stdout={result.stdout!r} "
                    f"stderr={result.stderr[-1500:]!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC "Both branches, and Ctrl-C without an agent."
# ═══════════════════════════════════════════════════════════════════════════

def _drive_no_agent_signal(cmd, cwd, env, scratch, signum, pidfile, timeout=30):
    """Drive `cmd` with NO `--agent` (so `abandon_trap` installs nothing and
    `run_streamed` is reached with neither a log, a narrator nor `capture`
    — its inherited-stdio `subprocess.run` branch) until the fake runner's
    grandchild has written its own pidfile — a readiness proxy that fires
    right at runner start, well before the runner's own mid-case block —
    then signal the CLIENT process and wait for it to exit."""
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    pid = None
    try:
        pid = wait_for_pidfile(pidfile, timeout=15)
        if pid is not None:
            proc.send_signal(signum)
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate(timeout=10)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    return pid, proc.returncode, stdout, stderr


class BothRunStreamedBranchesAreGroupKilledTest(_ProcessTreeCase):
    """`run_streamed`'s inherited-stdio branch (no log, no narrator, no
    capture) is reached ONLY without `--agent` for bun's and mvn's `test`
    verb (confirmed by reading `cmd_test`/`_run_surefire_tier`: WITH
    `--agent` a log path is always set). The same omission also means no
    `abandon_trap` is ever installed — "no trap" — so a Ctrl-C (SIGINT) here
    takes Python's own default, uncaught-`KeyboardInterrupt` path, covering
    the spec's second half at the same time."""

    def _no_agent_grandchild_survives_sigint(self, key, cmd_without_agent):
        pidfile = fresh_grandchild_pidfile(self.scratch)
        release = f"{pidfile}.release"
        env = dict(self.env(), FAKE_GRANDCHILD_PIDFILE=pidfile,
                   FAKE_BLOCK_AFTER_INDEX="1", FAKE_RELEASE_FILE=release)
        pid, code, stdout, stderr = _drive_no_agent_signal(
            cmd_without_agent, self.project, env, self.scratch,
            signal.SIGINT, pidfile)
        self.assertIsNotNone(
            pid,
            f"{key}: fixture failure — the grandchild never wrote its own "
            f"pidfile; stdout={stdout!r} stderr={stderr[-2000:]!r}")
        self._grandchild_pids.append(pid)
        self.assertTrue(
            pid_alive(pid),
            f"{key}: fixture failure — the grandchild must be alive right "
            f"after it reported its pid")
        self.assertNotEqual(
            code, 0,
            f"{key}: a SIGINT delivered while the inherited-stdio runner "
            f"was live must not let the client exit as if nothing "
            f"happened; stdout={stdout!r} stderr={stderr[-2000:]!r}")
        gone = wait_for_pid_gone(pid, timeout=10)
        self.assertTrue(
            gone,
            f"{key}: the grandchild (pid {pid}) must be dead once the "
            f"no-`--agent` client has exited from a Ctrl-C — "
            f"run_streamed's inherited-stdio branch owes its runner's "
            f"whole tree the same group kill the teed branch owes it; "
            f"stdout={stdout!r} stderr={stderr[-2000:]!r}")

    def test_bun_test_without_agent_sigint(self):
        self._no_agent_grandchild_survives_sigint(
            "bun", self._bun_test_cmd_no_agent())

    def test_mvn_test_without_agent_sigint(self):
        self._no_agent_grandchild_survives_sigint(
            "mvn", self._mvn_test_cmd_no_agent())


if __name__ == "__main__":
    unittest.main()
