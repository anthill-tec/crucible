"""The separately coded suite-running verbs on the shared run path, each driven
as a genuine OS subprocess against a fake runner and the stand-in board
(`RecordingBoard`): bun `regression`; mvn `regression` and `test`; python
`regression`; rust `smoke-test`, `workspace-regression` and
`regression-ingest`.

Every verb here has its own body (not the `test`/`unit` body the sibling
live-run files drive), so each is pinned on its own: it opens its run before
the runner is spawned, streams the runner's output live (a marker printed
before a blocked test reaches the client's stderr — and `--log`, where the
verb takes one — while that test is still blocked), narrates in its stack's
shape, lands the final count, says `ingesting…`, and only then ingests,
carrying the run id it opened.
"""

import os
import shutil
import sys
import unittest

from tests.client.live_run_harness import (
    CLIENTS,
    START,
    RecordingBoard,
    drive_live,
    first_index,
    heartbeat_index,
    install_project,
    new_scratch,
    scrubbed_env,
    write_fake_bun,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_python,
)

AGENT = "live-run-verb-fixture"
PROJECT_KEY = "test-key-live-run-verbs"
TOTAL = 12
MARKER = "LIVE_RUN_VERB_MARKER_4411"


class _LiveVerbCase(unittest.TestCase):
    """One verb, one live drive, every lifecycle assertion."""

    def setUp(self):
        self.project = new_scratch("live-run-verb-")
        self.scratch = new_scratch("live-run-verb-scratch-")
        self.bin_dir = new_scratch("live-run-verb-bin-")
        self.board = RecordingBoard()
        install_project(self.project, self.board.url, PROJECT_KEY)
        self.stamp = os.path.join(self.scratch, "spawn-stamp")
        self.log_path = os.path.join(self.scratch, "run.log")

    def tearDown(self):
        self.board.close()
        for d in (self.project, self.scratch, self.bin_dir):
            shutil.rmtree(d, ignore_errors=True)

    def env(self, **extra):
        return scrubbed_env(self.bin_dir, FAKE_TOTAL=TOTAL,
                            FAKE_SPAWN_STAMP=self.stamp, **extra)

    def assert_live_lifecycle(self, drive, ingest_path, running_re, final,
                              with_log):
        posts = self.board.posts()
        paths = [p for p, _ in posts]
        messages = self.board.messages()
        self.assertEqual(
            drive.returncode, 0,
            f"a green run exits 0; stdout={drive.stdout!r} stderr={drive.stderr[-2000:]!r}")

        # The runner's output streamed live.
        self.assertTrue(
            drive.live_on_stderr,
            "the marker the runner printed before its blocked test must reach "
            "the client's stderr while that test is still blocked")
        if with_log:
            self.assertTrue(
                drive.live_in_log,
                "the marker must reach --log while the test is still blocked")

        # The run opened before the runner spawned, and before the ingest.
        start_idx = first_index(posts, lambda p, b: p == START)
        ingest_idx = first_index(posts, lambda p, b: p == ingest_path)
        self.assertIsNotNone(start_idx, f"no /runs/start; paths={paths!r}")
        self.assertIsNotNone(ingest_idx, f"no ingest to {ingest_path}; paths={paths!r}")
        assert start_idx is not None and ingest_idx is not None
        self.assertLess(start_idx, ingest_idx, f"paths={paths!r}")
        with open(self.stamp) as f:
            spawned_at = float(f.read())
        self.assertLess(self.board.received_at(start_idx), spawned_at,
                        "/runs/start must reach the board before the runner spawns")
        ingest_body = posts[ingest_idx][1]
        self.assertEqual(ingest_body.get("runId"), "run-live-1",
                         f"the ingest must CLOSE the run it opened; body={ingest_body!r}")

        # Narration in the stack's shape, while in flight.
        running = [m for m in messages
                   if isinstance(m, str) and m.startswith("running")]
        self.assertTrue(running, f"no running heartbeat; messages={messages!r}")
        for m in running:
            self.assertRegex(m, running_re)

        # The final count, then `ingesting…`, then the ingest.
        final_idx = heartbeat_index(posts, final)
        ingesting_idx = heartbeat_index(posts, "ingesting…")
        self.assertIsNotNone(final_idx, f"no {final!r}; messages={messages!r}")
        self.assertIsNotNone(ingesting_idx, f"no 'ingesting…'; messages={messages!r}")
        assert final_idx is not None and ingesting_idx is not None
        self.assertLess(final_idx, ingesting_idx)
        self.assertLess(ingesting_idx, ingest_idx)


class BunRegressionFollowsTheLiveRunLifecycleTest(_LiveVerbCase):

    def test_bun_regression(self):
        fake = write_fake_bun(self.project, TOTAL)
        cmd = [sys.executable, str(CLIENTS / "bun-crucible.py"), "regression",
               "--bun", fake, "--project-dir", self.project,
               "--package-dir", self.project, "--reports", "reports",
               "--agent", AGENT, "--log", self.log_path]
        drive = drive_live(cmd, self.project, self.env(), self.scratch, MARKER,
                           self.log_path)
        self.assert_live_lifecycle(
            drive, "/api/v2/runs/parsed",
            rf"^running \d+/{TOTAL} \u00b7 narration\.test\.ts$",
            f"ran {TOTAL}/{TOTAL}", with_log=True)


class MvnRegressionAndTestFollowTheLiveRunLifecycleTest(_LiveVerbCase):

    def setUp(self):
        super().setUp()
        write_fake_mvnw(self.project)

    def test_mvn_regression(self):
        cmd = [sys.executable, str(CLIENTS / "mvn-crucible.py"), "regression",
               "--project-dir", self.project, "--reports", "reports",
               "--agent", AGENT, "--log", self.log_path]
        drive = drive_live(cmd, self.project, self.env(), self.scratch, MARKER,
                           self.log_path)
        self.assert_live_lifecycle(
            drive, "/api/v2/runs/parsed", rf"^running \d+/{TOTAL} classes$",
            f"ran {TOTAL}/{TOTAL} classes", with_log=True)

    def test_mvn_test(self):
        cmd = [sys.executable, str(CLIENTS / "mvn-crucible.py"), "test",
               "--test", "LiveCase*", "--project-dir", self.project,
               "--reports", "reports", "--agent", AGENT, "--log", self.log_path]
        drive = drive_live(cmd, self.project, self.env(), self.scratch, MARKER,
                           self.log_path)
        self.assert_live_lifecycle(
            drive, "/api/v2/runs", rf"^running \d+/{TOTAL} classes$",
            f"ran {TOTAL}/{TOTAL} classes", with_log=True)


class PythonRegressionFollowsTheLiveRunLifecycleTest(_LiveVerbCase):

    def test_python_regression(self):
        fake = write_fake_python(self.project)
        cmd = [sys.executable, str(CLIENTS / "python-crucible.py"), "regression",
               "--python", fake, "--project-dir", self.project,
               "--reports", "reports", "--agent", AGENT, "--log", self.log_path]
        drive = drive_live(cmd, self.project, self.env(), self.scratch, MARKER,
                           self.log_path)
        # unittest states no total up front: `running N`, then `ran N/N`.
        self.assert_live_lifecycle(
            drive, "/api/v2/runs/parsed", r"^running \d+$",
            f"ran {TOTAL}/{TOTAL}", with_log=True)


class RustGateVerbsFollowTheLiveRunLifecycleTest(_LiveVerbCase):
    """These three take no --log: the live stream is pinned on stderr."""

    def setUp(self):
        super().setUp()
        write_fake_cargo(self.bin_dir)

    def _drive(self, verb, *extra):
        cmd = [sys.executable, str(CLIENTS / "rust-crucible.py"), verb,
               *extra, "--project-dir", self.project, "--reports", "reports",
               "--agent", AGENT]
        return drive_live(cmd, self.project, self.env(), self.scratch, MARKER)

    def test_rust_smoke_test(self):
        drive = self._drive("smoke-test")
        self.assert_live_lifecycle(drive, "/api/v2/runs",
                                   rf"^running \d+/{TOTAL}$",
                                   f"ran {TOTAL}/{TOTAL}", with_log=False)

    def test_rust_workspace_regression(self):
        drive = self._drive("workspace-regression", "--min-free-g", "0",
                            "--keep-target")
        self.assert_live_lifecycle(drive, "/api/v2/runs/parsed",
                                   rf"^running \d+/{TOTAL}$",
                                   f"ran {TOTAL}/{TOTAL}", with_log=False)

    def test_rust_regression_ingest(self):
        drive = self._drive("regression-ingest", "--crates", "fake-crate")
        self.assert_live_lifecycle(drive, "/api/v2/runs/parsed",
                                   rf"^running \d+/{TOTAL}$",
                                   f"ran {TOTAL}/{TOTAL}", with_log=False)


if __name__ == "__main__":
    unittest.main()
