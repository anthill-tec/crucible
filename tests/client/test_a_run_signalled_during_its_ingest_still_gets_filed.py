"""The ingest-held window of the gated-run identity bracket (`gated_run`,
shared by every test-family verb): once the runner has produced its report
and the client is posting it to the board, a SIGTERM landing while that
POST's reply is held must let the ingest FINISH and FILE the run — never
abort it. Drives the same held-reply seam the sibling opening-window file
proves (`RecordingBoard.hold_next_reply`/`release_held`,
`tests/client/live_run_harness.py`), but holds the INGEST endpoint instead
of the identity's opening heartbeat or `/runs/start`.

Ground truth, read directly off `clients/_crucible_axi.py` on this branch:
`gated_run` installs its trap for the whole bracket and opens the identity
inside `trap.held()` — but the ingest POST (`post_ingest`, called from every
client's own `_ingest_parsed`/`_ingest_junit_dir`/`_ingest_junit_axi`) is
made OUTSIDE any `held()` span. A SIGTERM landing while that POST is
blocked on its reply is therefore raised immediately by `AbandonTrap.handle`
(its `_holding` count is zero at that point), unwinding `post_fn` before it
returns. `gated_run`'s own `except RunAbandoned` handler then runs
`_abort_gated_run`, and — because `_settle_gated_run` is only reached once
`post_fn` RETURNS, which this interrupted call never does — the run `_gated_
open_run` still names is still considered unfiled, so it IS aborted. Every
test below therefore fails today on its "no abort was posted" assertion,
never on an import/fixture error: the board records exactly one `POST
.../abort` for the run each drive opened, where a correct implementation
(the ingest held so the deferred signal fires only once the run has already
been filed) posts none.

Driven the same way `test_a_test_run_interrupted_before_its_runner_starts_leaves_nothing_behind.py`
drives the identity-opening and run-opening windows of the very same
bracket: a REAL client subprocess against a real `RecordingBoard`, using its
held-reply seam and each stack's fake runner — but here the runner is left
to run to completion and write a real report, and only the INGEST reply is
withheld.

Invocation:
    python3 -m unittest tests.client.test_a_run_signalled_during_its_ingest_still_gets_filed -v
"""

import shutil
import signal
import subprocess
import sys
import time
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
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

AGENT = "ingest-held-signal-fixture"
PROJECT_KEY = "test-key-ingest-held-signal"
PROJECT_NAME = "ingest-held-signal-firmware"
UNREGISTER_PATH = "/api/v2/agents/unregister"
TOON = load_toon()


def _removals_for(posts, agent_id):
    return [b for p, b in posts if p == UNREGISTER_PATH
            and isinstance(b, dict) and b.get("agentId") == agent_id]


def _wait_for_post(board, path, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(p == path for p, _ in board.posts()):
            return True
        time.sleep(0.02)
    return False


class _IngestHeldSignalCase(unittest.TestCase):
    """Shared fixtures: one project per test, a fresh `RecordingBoard` per
    drive (each drive needs its own `run-live-1` sequence), and every fake
    runner the five `test`-verb call sites need. Unlike the opening-window
    sibling, the runner here is NEVER told to block — it always runs to
    completion and writes a real report, so the ingest this file holds
    really does carry the runner's own results."""

    def setUp(self):
        self.project = new_scratch("ingest-held-")
        self.scratch = new_scratch("ingest-held-scratch-")
        self.bin_dir = new_scratch("ingest-held-bin-")
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
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=3, **extra)

    def _fresh_board(self):
        self.board.close()
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY, PROJECT_NAME)

    def _axi(self, stdout):
        decoded = TOON.decode(stdout)
        self.assertIn("axi", decoded, f"stdout is not one TOON envelope: {stdout!r}")
        return decoded["axi"]

    # ── the five `test`-verb call sites' own argv ───────────────────────────

    def _bun_test_cmd(self):
        return [sys.executable, str(CLIENTS / "bun-crucible.py"), "test",
                "--bun", self.fake_bun, "--project-dir", self.project,
                "--package-dir", self.project, "--reports", "reports",
                "--agent", AGENT]

    def _python_test_cmd(self):
        return [sys.executable, str(CLIENTS / "python-crucible.py"), "test",
                "--python", self.fake_python, "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _mvn_test_cmd(self):
        return [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
                "--test", "LiveCase*", "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _rust_test_cmd(self):
        return [sys.executable, str(CLIENTS / "rust-crucible.py"), "test",
                "--crate", "fake-crate", "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    def _arduino_test_cmd(self):
        return [sys.executable, str(CLIENTS / "arduino-crucible.py"), "test",
                "--dir", "tests/native", "--project-dir", self.project,
                "--reports", "reports", "--agent", AGENT]

    # ── the drive ────────────────────────────────────────────────────────

    def _drive_held_ingest_signal(self, cmd, ingest_path, signum):
        """Let the runner finish normally and the client start posting its
        report; hold THAT reply, wait for it to reach the board, signal the
        client, THEN release the reply."""
        self.board.hold_next_reply(ingest_path)
        proc = subprocess.Popen(cmd, cwd=self.project, env=self.env(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        try:
            self.assertTrue(
                _wait_for_post(self.board, ingest_path),
                f"the ingest POST to {ingest_path} never reached the board "
                f"at all (no POST within the wait window)")
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

    # ── the shared assertion ────────────────────────────────────────────

    def _assert_ingest_signal_filed_the_run(self, label, signum, code, stdout,
                                            stderr, ingest_path):
        signame = signal.Signals(signum).name
        run_ids = self.board.run_ids_opened()
        self.assertEqual(
            len(run_ids), 1,
            f"{label}: exactly one run must have been opened; got "
            f"{run_ids!r}; posts={self.board.posts()!r}")
        run_id = run_ids[0]
        ingest_posts = [b for p, b in self.board.posts() if p == ingest_path]
        self.assertEqual(
            len(ingest_posts), 1,
            f"{label}: exactly one ingest POST to {ingest_path}; got "
            f"{ingest_posts!r}; posts={self.board.posts()!r}")
        body = ingest_posts[0] or {}
        self.assertEqual(
            body.get("runId"), run_id,
            f"{label}: the ingest must carry the runId it closes; got "
            f"{body!r}")
        if "summary" in body:
            summary = body["summary"]
            self.assertEqual(
                summary.get("total"), 3,
                f"{label}: the filed run must carry the runner's own "
                f"results (3 cases); got summary={summary!r}")
            self.assertEqual(
                summary.get("failed"), 0,
                f"{label}: got summary={summary!r}")
        else:
            self.assertEqual(
                body.get("codec"), "junit",
                f"{label}: a junit-dir ingest must still name its codec; "
                f"got {body!r}")
            self.assertTrue(
                body.get("dataPath"),
                f"{label}: a junit-dir ingest must still name a real "
                f"reports path; got {body!r}")
        aborts = self.board.aborts()
        self.assertEqual(
            aborts, [],
            f"{label}: a {signame} landing while the ingest's reply was "
            f"held must let the ingest finish and file the run it opened, "
            f"NOT abort it; got {aborts!r}; all posts="
            f"{self.board.posts()!r}; exit={code}; stderr={stderr[-2000:]!r}")
        removals = _removals_for(self.board.posts(), AGENT)
        self.assertEqual(
            len(removals), 1,
            f"{label}: the identity must still be removed (one removal) "
            f"once the run is filed; got {len(removals)}: {removals!r}")
        self.assertIs(
            removals[0].get("silent"), True,
            f"{label}: removal must be silent=True; got {removals[0]!r}")
        self.assertEqual(
            code, 128 + signum,
            f"{label}: a {signame}'d ingest exits 128+signum; got {code}; "
            f"stdout={stdout!r} stderr={stderr[-2000:]!r}")
        axi = self._axi(stdout)
        self.assertIs(
            axi.get("ok"), False,
            f"{label}: an interrupted exit is still ok:false; got {axi!r}")
        self.assertEqual(
            axi.get("signal"), signame,
            f"{label}: the envelope must name {signame}; got {axi!r}")
        self.assertEqual(
            axi.get("runId"), run_id,
            f"{label}: the envelope must report the filed run's id; got "
            f"{axi!r}")


# The five `test`-verb call sites the AC names: (client, argv builder, the
# path the AC's own §S2 named as this client's `test`-verb ingest). Named by
# CLIENT in every subTest/assertion below, never by line number.
INGEST_HELD_SITES = (
    ("bun", "_bun_test_cmd", "/api/v2/runs/parsed"),
    ("python", "_python_test_cmd", "/api/v2/runs/parsed"),
    ("mvn", "_mvn_test_cmd", "/api/v2/runs"),
    ("rust", "_rust_test_cmd", "/api/v2/runs"),
    ("arduino", "_arduino_test_cmd", "/api/v2/runs/parsed"),
)


class IngestHeldSignalFilesTheRunInsteadOfAbortingItTest(_IngestHeldSignalCase):

    def test_the_call_site_table_names_exactly_five_clients(self):
        self.assertEqual(
            {key for key, *_rest in INGEST_HELD_SITES},
            {"bun", "python", "mvn", "rust", "arduino"},
            repr(INGEST_HELD_SITES))

    def test_every_clients_test_verb_files_the_run_on_sigterm_during_ingest(self):
        for key, builder_name, ingest_path in INGEST_HELD_SITES:
            with self.subTest(client=key):
                self._fresh_board()
                cmd = getattr(self, builder_name)()
                code, stdout, stderr = self._drive_held_ingest_signal(
                    cmd, ingest_path, signal.SIGTERM)
                self._assert_ingest_signal_filed_the_run(
                    f"{key} test", signal.SIGTERM, code, stdout, stderr,
                    ingest_path)


if __name__ == "__main__":
    unittest.main()
