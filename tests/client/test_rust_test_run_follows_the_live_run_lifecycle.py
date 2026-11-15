"""Rust's suite-running verb on the ONE shared run path (the narrator and
the run-opening/live-streaming helpers the CR asks `_crucible_axi.py` to
carry — a `RunNarrator` instance and an `open_run`/`run_streamed` call,
referred to here only by symbol, never by file:line).

Drives the REAL `clients/rust-crucible.py` `test` verb as a genuine OS
subprocess, against a real (but fake) `cargo` executable placed first on
`PATH`, and the shared stand-in HTTP board (`RecordingBoard`) as the
sibling bun/mvn/python run-lifecycle tests -- never the live :3849/:3850
Crucible server, and never a real `cargo`/`nextest` toolchain run.

── What is pinned, and why it fails today (read from clients/rust-crucible.py
   at HEAD of this branch) ──

AC1 ("`/runs/start` before the suite starts") -- grepping `cmd_test` for
"runs/start" has NO hit: rust opens no run, ever (the CR's own census
agrees: rust's START column is "no"). This assertion fails for the most
direct reason possible: the request is simply never made.

AC3/AC5 ("narration through the ONE shared path, total KNOWN from the
runner's own start line") -- `cmd_test` has NO narrator at all (the CR's
census: rust's NARRATE column is "no") -- no `running N/M` heartbeat is ever
posted. §S0's own G3 finding is why this stack is the ONE of the three where
a correct fix narrates a KNOWN denominator from the very first line: unlike
python/arduino, `cargo nextest run`'s own human-reporter STARTS by printing
its total before any test completes. This file's fake `cargo` prints that
same shape -- `"    Starting N tests across 1 binary (run ID: ..., nextest
profile: ...)"` -- followed by nextest's own per-test completion line shape,
`"        PASS [   0.001s] <crate> <test::name>"` (both confirmed against
the public cargo-nextest human-reporter format: a start line stating the
total test count up front, then one PASS/FAIL line per completed test).

AC2 ("a line printed before a blocking test is visible on stderr and in
--log before that test ends") -- rust's `_run_logged` (clients/rust-crucible.py)
has the SAME batched-write shape as bun's and python's: with a `--log` path
it collects the ENTIRE combined output via `subprocess.run(..., stdout=PIPE,
stderr=STDOUT)`, waits for the child to exit, and only THEN writes `--log`
and echoes stderr in one shot (its own doc comment even names
`python-crucible.py`'s `_run_logged` as "the reference" it copies). Proven
the same way as the sibling tests: a marker line printed before a
deliberately-blocked test must be invisible on both channels within a
bounded poll, because nothing is written until the whole `cargo` process
exits.

The `ingesting…` ordering assertion is new behaviour too -- no client posts
that literal message today.

Both proofs (RED-for-the-right-reason, and a correct implementation of the
CR's scope CAN pass): every assertion below names the exact string/ordering
missing today, and a client that opens the run first, streams live, narrates
the KNOWN `running N/M` shape from nextest's own start line, posts the final
`ran M/M` unconditionally, then `ingesting…`, then ingests, satisfies every
assertion here with room to spare.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    RecordingBoard,
    project_toml_declaring,
    write_fake_cargo,
)
from tests.client import client_script

REPO_ROOT = Path(__file__).resolve().parents[2]
RUST_SCRIPT = client_script("rust-crucible.py")

AGENT = "rust-run-lifecycle-fixture"
PROJECT_KEY = "test-key-rust-run-lifecycle"

ENV_KEYS_TO_SCRUB = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                     "WORKFLOW_CYCLE")

# The shared fake `cargo` (`live_run_harness.FAKE_CARGO`), resolved via
# PATH (the client spawns the literal string "cargo"): it answers a streamed
# run's version read and list, then streams FAKE_TOTAL passing tests as
# nextest's `libtest-json-plus` on stdout and its human output on stderr, and
# -- only when told to -- blocks after a named test until a release file
# appears, its marker line on stderr. The board is the shared
# `RecordingBoard`, which takes the list and holds the stream.


def _first_matching_index(posts, predicate):
    for i, (path, body) in enumerate(posts):
        if predicate(path, body):
            return i
    return None


def _is_heartbeat_message(path, body, message):
    return (path.endswith("/agents/heartbeat")
            and isinstance(body, dict) and body.get("message") == message)


def _install_project(project_dir, board_url):
    with open(os.path.join(project_dir, ".env"), "w") as f:
        f.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
    with open(os.path.join(project_dir, "crucible.toml"), "w") as f:
        f.write(project_toml_declaring(board_url))


def _scrubbed_env(fake_bin_dir):
    env = os.environ.copy()
    for k in ENV_KEYS_TO_SCRUB:
        env.pop(k, None)
    env["PATH"] = fake_bin_dir + os.pathsep + env.get("PATH", "")
    return env


class NarratedRustTestRunFinalizesThroughTheSharedPathTest(unittest.TestCase):
    """AC1 + AC3/AC5 (known total) + the `ingesting…` ordering, rust's `test`
    verb."""

    TOTAL = 12

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="rust-run-lifecycle-")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="rust-run-lifecycle-bin-")
        self.board = RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        write_fake_cargo(self.fake_bin_dir)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)

    def test_run_opens_before_the_suite_narrates_known_total_and_lands_its_final_count_before_ingesting(self):
        spawn_stamp = os.path.join(self.tmpdir, "spawn-stamp")
        log_path = os.path.join(self.tmpdir, "run.log")
        env = _scrubbed_env(self.fake_bin_dir)
        env["FAKE_TOTAL"] = str(self.TOTAL)
        env["FAKE_SPAWN_STAMP"] = spawn_stamp
        cmd = [sys.executable, str(RUST_SCRIPT), "test",
               "--crate", "fake-crate",
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT,
               "--log", log_path]
        result = subprocess.run(cmd, cwd=self.tmpdir, env=env,
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(
            result.returncode, 0,
            f"a green wrapped rust test run exits 0; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        posts = self.board.posts()
        paths = [p for p, _ in posts]
        all_messages = [b.get("message") for _p, b in posts if isinstance(b, dict)]

        # -- AC1: run opens before the suite, in request order --------------
        start_idx = _first_matching_index(posts, lambda p, b: p == "/api/v2/runs/start")
        ingest_idx = _first_matching_index(posts, lambda p, b: p == "/api/v2/runs")
        self.assertIsNotNone(
            start_idx, f"AC1: must POST /api/v2/runs/start; got paths={paths!r}")
        self.assertIsNotNone(
            ingest_idx, f"AC1: the run must still ingest; got paths={paths!r}")
        assert start_idx is not None and ingest_idx is not None
        self.assertLess(
            start_idx, ingest_idx,
            f"AC1: the run must be OPENED before it is closed by the ingest; "
            f"paths={paths!r}")
        with open(spawn_stamp) as f:
            spawned_at = float(f.read())
        self.assertLess(
            self.board.received_at(start_idx), spawned_at,
            "AC1: /api/v2/runs/start must reach the board BEFORE the fake "
            "cargo process (the suite) is even spawned")

        # -- AC3/AC5: narration is the stream's count against the board's
        # listed total. The run is streamed, so while its relay lands no
        # in-run tick is posted (the board shows the stream's own count);
        # any tick that is posted reads 'running N/<listed total>'.
        running_msgs = []
        for _path, b in posts:
            msg = b.get("message") if isinstance(b, dict) else None
            if isinstance(msg, str) and msg.startswith("running"):
                running_msgs.append(msg)
        for m in running_msgs:
            self.assertRegex(
                m, rf"^running \d+/{self.TOTAL}$",
                f"AC3/AC5: the total is the board's listed one, so any "
                f"in-run narration reads 'running N/{self.TOTAL}'; got {m!r}")
            n = int(m.split()[1].split("/")[0])
            self.assertTrue(
                1 <= n <= self.TOTAL,
                f"narrated count must be within the run's real range; got {m!r}")
        self.assertEqual(
            [b.get("codec") for p, b in posts if p.endswith("/stream")][:1], ["nextest"],
            f"the run's results reach the board as nextest's stream; "
            f"posted paths={paths!r}")

        # -- §S1 + §S2: the final count lands unconditionally, BEFORE
        # 'ingesting…', which precedes the ingest.
        final_message = f"ran {self.TOTAL}/{self.TOTAL}"
        final_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, final_message))
        self.assertIsNotNone(
            final_idx,
            f"§S1: the run must end with the board holding the FINAL count "
            f"{final_message!r} -- rust's cmd_test has no finish()/final "
            f"post at all today. posted messages={all_messages!r}")

        ingesting_idx = _first_matching_index(
            posts, lambda p, b: _is_heartbeat_message(p, b, "ingesting…"))
        self.assertIsNotNone(
            ingesting_idx,
            f"§S2: the message must follow the run to its end -- "
            f"'ingesting…' must be posted while the result is being "
            f"recorded; posted messages={all_messages!r}")
        assert final_idx is not None and ingesting_idx is not None and ingest_idx is not None
        self.assertLess(
            final_idx, ingesting_idx,
            "the final count must land BEFORE 'ingesting…' replaces it on "
            "the board -- never the reverse")
        self.assertLess(
            ingesting_idx, ingest_idx,
            "'ingesting…' must be posted BEFORE the ingest POST itself (§S2)")


class RustTestRunnerOutputReachesStderrAndLogWhileTheSuiteIsStillRunningTest(unittest.TestCase):
    """AC2 — rust's `test` verb, with a fake `cargo` that blocks mid-suite."""

    MARKER = "RUST_LIVE_STREAM_MARKER_9142"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="rust-run-live-stream-")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="rust-run-live-stream-bin-")
        self.board = RecordingBoard()
        _install_project(self.tmpdir, self.board.url)
        write_fake_cargo(self.fake_bin_dir)
        self.release_file = os.path.join(self.tmpdir, "release")
        self.log_path = os.path.join(self.tmpdir, "run.log")
        self.stderr_path = os.path.join(self.tmpdir, "stderr.txt")

    def tearDown(self):
        self.board.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)

    def test_a_line_printed_before_a_blocking_test_is_visible_before_that_test_ends(self):
        env = _scrubbed_env(self.fake_bin_dir)
        env.update({
            "FAKE_TOTAL": "2",
            "FAKE_BLOCK_AFTER_INDEX": "1",
            "FAKE_RELEASE_FILE": self.release_file,
            "FAKE_MARKER_LINE": self.MARKER,
        })
        cmd = [sys.executable, str(RUST_SCRIPT), "test",
               "--crate", "fake-crate",
               "--project-dir", self.tmpdir,
               "--reports", "reports",
               "--agent", AGENT, "--log", self.log_path]
        with open(self.stderr_path, "wb") as stderr_file:
            proc = subprocess.Popen(cmd, cwd=self.tmpdir, env=env,
                                     stdout=subprocess.DEVNULL, stderr=stderr_file)
        visible_before_release = False
        try:
            deadline = time.time() + 3.0
            while time.time() < deadline:
                if self._marker_visible():
                    visible_before_release = True
                    break
                time.sleep(0.05)
        finally:
            open(self.release_file, "w").close()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

        stderr_so_far = self._read(self.stderr_path)
        log_so_far = self._read(self.log_path)
        self.assertTrue(
            visible_before_release,
            f"AC2: a line the fake cargo printed BEFORE its second "
            f"(blocking) test finished must already be visible on stderr "
            f"AND in --log WHILE that test is still running -- not only "
            f"after the whole run exits. §S0 requires the runner's output "
            f"to stream live; clients/rust-crucible.py's `_run_logged` "
            f"collects every line and writes stderr/--log only once AFTER "
            f"the child exits, exactly like python's and bun's. "
            f"stderr so far={stderr_so_far!r} log so far={log_so_far!r}")
        self.assertEqual(
            proc.returncode, 0,
            f"the wrapped run must still finish cleanly once released; "
            f"stderr={self._read(self.stderr_path)!r}")

    def _marker_visible(self):
        return (self.MARKER in self._read(self.stderr_path)
                and self.MARKER in self._read(self.log_path))

    @staticmethod
    def _read(path):
        if not os.path.exists(path):
            return ""
        with open(path, errors="replace") as f:
            return f.read()


if __name__ == "__main__":
    unittest.main()
