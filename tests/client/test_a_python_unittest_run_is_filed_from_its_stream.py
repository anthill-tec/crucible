"""A python unittest run's record is its stream (CR-CRU-224 §S3, AC5–AC10).

Drives the REAL `clients/python-crucible.py` as an OS subprocess against the
shared stand-in board (`RecordingBoard`, which holds an open run's stream as
the real board's `appendRunStream` does) and the shared fake interpreter
(`write_fake_python`), which writes the Crucible event stream to the file
`CRUCIBLE_STREAM` names, as `clients/subtest_runner.py` does, and records the
`CRUCIBLE_STREAM` it was handed (`FAKE_ENV_CAPTURE`). The one exception is the
nested-run isolation test, which runs the real runner under the repo's own
interpreter.

What is pinned, by AC:
- AC5 — the close: `POST /api/v2/runs` with `runId`, `codec:
  "crucible-events"` and no `data`, after the relay's last batch; the ingest
  line and the envelope from the board's answer; `stream-incomplete` riding
  the envelope with a non-zero exit; a zero-test run caught first and aborted;
  a runner that wrote no stream ingested as a compile failure; a refused
  close followed by an abort.
- AC6 — a board whose health lists no `crucible-events` refuses before the run
  is opened or spawned; an unreachable board, or no `runId`, runs the suite and
  files nothing; no stream is set in either case.
- AC7 — interrupted after some tests, the relay's bounded `finish` delivers
  them before the abort; interrupted before the first test, the run is
  aborted as today.
- AC8 — no `running N`; `ran <test-end count>/<run-end total>` then
  `ingesting…`, both before the close.
- AC9 — a nested client run writes nothing into the outer stream; a stale
  stream file is wiped; no `CRUCIBLE_STREAM` reaches a child that is not
  streaming.
- AC10 — a pytest run and `auto-ingest` keep their JUnit record (pins of what
  is already true, beside the one new rule: no `CRUCIBLE_STREAM` reaches
  pytest).
"""

import json
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import ClassVar

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.live_run_harness import (
    START,
    STREAM_ROUTE,
    RecordingBoard,
    heartbeat_index,
    install_project,
    load_toon,
    scrubbed_env,
    write_fake_python,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_SCRIPT = REPO_ROOT / "clients" / "python-crucible.py"
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"
TOON = load_toon()

AGENT = "python-stream-close-agent"
PROJECT_KEY = "python-stream-close-key"
RUN_ID = "run-live-1"
STREAM_FILE = "crucible-events.ndjson"
CLOSE = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"
RUN_TIMEOUT = 90
SIGNAL_MARKER = "STREAMED_RUN_SIGNAL_MARKER"


def envelope(stdout):
    """The AXI envelope on stdout, `{}` when there is none."""
    decoded = TOON.decode(stdout) if stdout.strip() else None
    axi = decoded.get("axi") if isinstance(decoded, dict) else None
    return axi if isinstance(axi, dict) else {}


def warning_codes(axi):
    return [w.get("code") for w in (axi or {}).get("warnings") or []
            if isinstance(w, dict)]


def stream_events(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def kinds(events):
    return [event.get("event") for event in events]


def closed_port_url():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"http://127.0.0.1:{port}"


class StreamedRunCase(unittest.TestCase):
    """A scratch project pointed at a stream-capable `RecordingBoard`, with the
    shared fake interpreter and an explicit reports dir."""

    BOARD_OPTIONS: ClassVar[dict] = {}

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="python-stream-close-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.project = self.scratch / "project"
        self.project.mkdir()
        self.reports = self.scratch / "reports"
        self.capture = self.scratch / "env-capture.json"
        self.stamp = self.scratch / "spawn-stamp"
        self.board = RecordingBoard(**self.BOARD_OPTIONS)
        self.addCleanup(self.board.close)
        install_project(str(self.project), self.board.url, PROJECT_KEY)
        self.fake = write_fake_python(str(self.project))

    def command(self, verb="test", *extra, agent=True, python=None):
        cmd = [sys.executable, str(PYTHON_SCRIPT), verb,
               "--python", python or self.fake,
               "--project-dir", str(self.project),
               "--reports", str(self.reports), *extra]
        return cmd + (["--agent", AGENT] if agent else [])

    def environment(self, inherit_stream=None, **extra):
        env = scrubbed_env(FAKE_ENV_CAPTURE=self.capture,
                           FAKE_SPAWN_STAMP=self.stamp, **extra)
        env.pop("CRUCIBLE_STREAM", None)
        if inherit_stream is not None:
            env["CRUCIBLE_STREAM"] = str(inherit_stream)
        return env

    def drive(self, verb="test", *extra, agent=True, inherit_stream=None, **fake_env):
        return subprocess.run(
            self.command(verb, *extra, agent=agent),
            cwd=str(self.project), env=self.environment(inherit_stream, **fake_env),
            capture_output=True, text=True, timeout=RUN_TIMEOUT, check=False)

    def stream_seen(self):
        """The `CRUCIBLE_STREAM` the runner was handed (None: none), or a
        failure when the runner never ran."""
        self.assertTrue(self.capture.is_file(), "the runner was never spawned")
        return json.loads(self.capture.read_text(encoding="utf-8"))["stream"]

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def data_batches(self):
        return [body for _p, body in self.board.stream_posts()
                if isinstance(body, dict) and body.get("data")]

    def index_of(self, predicate):
        """The first matching POST's index in wire order, -1 when none."""
        for i, (path, body) in enumerate(self.board.posts()):
            if predicate(path, body):
                return i
        return -1

    def expected_stream_path(self):
        return str(self.reports / STREAM_FILE)

    @staticmethod
    def diag(result):
        return f"exit={result.returncode} stdout={result.stdout!r} stderr={result.stderr[-3000:]!r}"


class AStreamedUnittestRunClosesThroughItsStreamTest(StreamedRunCase):
    """AC5 — the close itself, the client's output, `stream-incomplete`, and a
    refused close."""

    def test_a_green_run_relays_its_stream_and_closes_with_the_stream_codec(self):
        self.board.script_run(passed=3, total=3, files=1)
        result = self.drive(FAKE_TOTAL=3)
        self.assertEqual(result.returncode, 0, self.diag(result))
        self.assertEqual(self.stream_seen(), self.expected_stream_path(),
                         "the runner is told to write <reports>/crucible-events.ndjson")
        streamed = self.board.stream_posts()
        self.assertTrue(streamed, f"the relay posts the stream; {self.diag(result)}")
        self.assertEqual({p for p, _b in streamed}, {f"/api/v2/runs/{RUN_ID}/stream"})
        held = self.board.held_stream(RUN_ID)
        self.assertEqual(kinds(stream_events(held)),
                         ["run-start", "test-end", "test-end", "test-end", "run-end"],
                         "the board holds the runner's stream, as written")
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, f"one close; posts={self.board.posts()!r}")
        body = closes[0]
        self.assertEqual(body.get("codec"), "crucible-events")
        self.assertEqual(body.get("runId"), RUN_ID)
        self.assertNotIn("data", body, "a stream close sends no data")
        self.assertNotIn("dataPath", body)
        self.assertEqual(body.get("runnerExit"), 0)
        self.assertEqual(body.get("stack"), "python")
        self.assertNotIn("tier", body, "an untiered `test` run states no tier")
        self.assertIn("test_case_1 (fake_module.FakeCase.test_case_1) ... ok",
                      body.get("raw") or "", "the close carries the captured output as raw")
        self.assertEqual(self.posts_to(COMPILE), [])
        close_at = self.index_of(lambda p, _b: p == CLOSE)
        last_batch_at = max(i for i, (p, _b) in enumerate(self.board.posts())
                            if STREAM_ROUTE.match(p))
        self.assertGreaterEqual(close_at, 0, f"no close; posts={self.board.posts()!r}")
        self.assertLess(last_batch_at, close_at, "the relay finishes before the close")
        confirm = self.board.posts()[last_batch_at][1]
        self.assertEqual((confirm.get("from"), confirm.get("data")),
                         (len(held.encode("utf-8")), ""),
                         "finish confirms the board's held with an empty batch")
        self.assertIn("ingest: ok=True codec=crucible-events passed=3 failed=0 "
                      "pending=0 total=3 files=1", result.stderr)
        axi = envelope(result.stdout)
        self.assertTrue(axi, result.stdout)
        self.assertTrue(axi.get("ok"), axi)
        self.assertEqual(axi.get("run", {}).get("passed"), 3, "the envelope is the board's answer")

    def test_a_failing_run_closes_with_the_runners_exit_and_exits_non_zero(self):
        self.board.script_run(passed=2, failed=1)
        result = self.drive(FAKE_TOTAL=3, FAKE_FAIL_COUNT=1)
        self.assertEqual(result.returncode, 1, self.diag(result))
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, self.diag(result))
        self.assertEqual(closes[0].get("codec"), "crucible-events")
        self.assertEqual(closes[0].get("runnerExit"), 1)
        failures = [e for e in stream_events(self.board.held_stream(RUN_ID))
                    if e.get("status") == "fail"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["failure"]["message"], "planted failure")

    def test_a_release_run_closes_carrying_its_release(self):
        self.board.script_run(passed=1)
        result = self.drive("test", "--release", "0.4.0", FAKE_TOTAL=1)
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, self.diag(result))
        self.assertEqual(closes[0].get("codec"), "crucible-events")
        self.assertEqual(closes[0].get("release"), "0.4.0")

    def test_a_stream_the_board_flags_incomplete_rides_the_envelope_and_exits_non_zero(self):
        self.board.script_run(passed=3, warnings=[{
            "code": "stream-incomplete",
            "detail": "the stream cannot be trusted: no run-end — the run is stored "
                      "flagged incomplete"}])
        result = self.drive(FAKE_TOTAL=3, FAKE_NO_RUN_END="1")
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, self.diag(result))
        self.assertEqual(closes[0].get("codec"), "crucible-events")
        axi = envelope(result.stdout)
        self.assertIn("stream-incomplete", warning_codes(axi),
                      f"the board's warning rides the envelope; {axi!r}")
        self.assertNotEqual(result.returncode, 0,
                            "a record the board flags incomplete never exits green")

    def test_a_close_the_board_refuses_is_followed_by_an_abort(self):
        self.board.refuse_ingest_for(RUN_ID, status=400)
        result = self.drive(FAKE_TOTAL=2)
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, self.diag(result))
        self.assertEqual(closes[0].get("codec"), "crucible-events")
        aborts = self.board.aborts()
        self.assertEqual([p for p, _b in aborts], [f"/api/v2/runs/{RUN_ID}/abort"],
                         self.diag(result))
        self.assertIn("ingest refused", aborts[0][1].get("reason") or "",
                      "the refusal is the abort's reason")
        self.assertLess(self.index_of(lambda p, _b: p == CLOSE),
                        self.index_of(lambda p, _b: p.endswith("/abort")))
        self.assertIn("run-aborted", warning_codes(envelope(result.stdout)))
        self.assertNotEqual(result.returncode, 0)


class ARunThatRanNothingOrWroteNoStreamTest(StreamedRunCase):
    """AC5 — a zero-test run is caught first, from the local count, and
    aborted; a runner that wrote no stream is ingested as a compile failure;
    a runner that wrote a `run-start` and died is closed as a stream."""

    def test_a_zero_test_discovery_keeps_no_tests_discovered_and_is_aborted_unclosed(self):
        for verb in ("test", "regression"):
            with self.subTest(verb=verb):
                self.board.events.clear()
                result = self.drive(verb, FAKE_ZERO_DISCOVERY="1")
                self.assertEqual(self.stream_seen(), self.expected_stream_path(),
                                 "the run was streaming")
                codes = warning_codes(envelope(result.stdout))
                self.assertIn("no-tests-discovered", codes, self.diag(result))
                self.assertIn("run-aborted", codes)
                self.assertEqual(self.posts_to(CLOSE), [], "nothing is closed")
                self.assertEqual(self.posts_to(COMPILE), [], "nor ingested as a compile")
                self.assertNotEqual(result.returncode, 0)

    def test_a_stream_holding_no_test_with_a_failed_exit_is_aborted_unclosed(self):
        result = self.drive(FAKE_ZERO_REPORT="1", FAKE_EXIT_CODE="1")
        self.assertEqual(self.stream_seen(), self.expected_stream_path())
        self.assertIn("run-aborted", warning_codes(envelope(result.stdout)), self.diag(result))
        self.assertEqual(self.posts_to(CLOSE), [])
        self.assertEqual(self.posts_to(COMPILE), [])
        self.assertEqual(result.returncode, 1)

    def test_a_runner_that_wrote_no_stream_is_ingested_as_a_compile_failure(self):
        result = self.drive(FAKE_NO_REPORT="1", FAKE_TOTAL=1, FAKE_FAIL_COUNT=1)
        self.assertEqual(self.stream_seen(), self.expected_stream_path(),
                         "the runner was handed the stream it then never wrote")
        compiles = self.posts_to(COMPILE)
        self.assertEqual(len(compiles), 1, self.diag(result))
        self.assertEqual(compiles[0].get("runId"), RUN_ID)
        self.assertIn("test_case_1 (fake_module.FakeCase.test_case_1) ... FAIL",
                      compiles[0].get("errors") or "")
        self.assertEqual(self.posts_to(CLOSE), [], "no stream close for a run with no stream")
        self.assertEqual(self.data_batches(), [])
        self.assertNotEqual(result.returncode, 0)

    def test_a_runner_that_dies_after_its_run_start_is_closed_as_a_stream_not_a_compile(self):
        # The no-stream compile path needs all three: no `test-end` in the
        # local stream, a confirmed `held` of 0, and a non-zero exit. A
        # runner that wrote its `run-start` has a stream the board holds, so
        # its run is closed as a stream the board flags incomplete.
        self.board.script_run(warnings=[{
            "code": "stream-incomplete",
            "detail": "the stream cannot be trusted: no run-end — the run is stored "
                      "flagged incomplete"}])
        result = self.drive(FAKE_TOTAL=2, FAKE_DIE_AFTER_RUN_START="1")
        self.assertEqual(self.stream_seen(), self.expected_stream_path(), self.diag(result))
        self.assertEqual(kinds(stream_events(self.board.held_stream(RUN_ID))), ["run-start"],
                         f"the board holds the run-start the runner wrote; {self.diag(result)}")
        self.assertEqual(self.posts_to(COMPILE), [],
                         f"a stream the board holds is never filed as a compile failure; "
                         f"{self.diag(result)}")
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, self.diag(result))
        body = closes[0]
        self.assertEqual(body.get("codec"), "crucible-events")
        self.assertEqual(body.get("runId"), RUN_ID)
        self.assertNotIn("data", body, "a stream close sends no data")
        self.assertEqual(body.get("runnerExit"), 1)
        self.assertIn("stream-incomplete", warning_codes(envelope(result.stdout)),
                      self.diag(result))
        self.assertNotEqual(result.returncode, 0, self.diag(result))


class WhenTheBoardCannotStreamTest(StreamedRunCase):
    """AC6 — the board's health decides before the run opens; an unreachable
    board or no `runId` runs the suite and files nothing; no stream is set."""

    def test_a_board_that_decodes_no_crucible_events_refuses_before_the_run_opens(self):
        board = RecordingBoard(stream_codec=False)
        self.addCleanup(board.close)
        health = board.default_health()
        health["version"] = "0.3.9"
        board.script_health(health)
        install_project(str(self.project), board.url, PROJECT_KEY)
        result = self.drive(FAKE_TOTAL=2)
        self.assertEqual(result.returncode, 1, self.diag(result))
        self.assertTrue(board.health_reads(), "health is read")
        paths = [p for p, _b in board.posts()]
        self.assertNotIn(START, paths, "refused before open_run: no run is left open")
        self.assertFalse(self.stamp.exists(), "refused before the suite is spawned")
        self.assertFalse([p for p in paths if p.startswith("/api/v2/runs")], paths)
        axi = envelope(result.stdout)
        self.assertTrue(axi, result.stdout)
        self.assertIs(axi.get("ok"), False)
        self.assertIn("0.3.9", result.stdout, "the envelope names the board's version")
        self.assertIn("0.4.0", result.stdout, "and the version floor")
        self.assertIn("crucible-events", result.stdout)

    def test_a_board_with_no_stream_route_is_said_once(self):
        board = RecordingBoard(stream_route=False)
        self.addCleanup(board.close)
        install_project(str(self.project), board.url, PROJECT_KEY)
        result = self.drive(FAKE_TOTAL=3)
        said = [line for line in result.stderr.splitlines()
                if f"no route: /api/v2/runs/{RUN_ID}/stream" in line]
        self.assertEqual(len(said), 1, f"the relay's 404 is said once; {self.diag(result)}")

    def test_an_unreachable_board_runs_the_suite_and_files_nothing(self):
        install_project(str(self.project), closed_port_url(), PROJECT_KEY)
        result = self.drive(FAKE_TOTAL=2)
        self.assertTrue(self.stamp.exists(), "the suite still runs")
        self.assertIsNone(self.stream_seen(), "no stream is set")
        self.assertFalse((self.reports / STREAM_FILE).exists())
        axi = envelope(result.stdout)
        self.assertTrue(axi, result.stdout)
        self.assertIs(axi.get("ok"), False)
        self.assertNotEqual(result.returncode, 0)

    def test_a_board_that_opens_no_run_runs_the_suite_and_files_nothing(self):
        self.board.refuse_next_start()
        result = self.drive(FAKE_TOTAL=2, inherit_stream=self.scratch / "outer.ndjson")
        self.assertTrue(self.stamp.exists(), "the suite still runs")
        self.assertIsNone(self.stream_seen(),
                          "no stream is set, not even one inherited from the caller")
        self.assertEqual(self.posts_to(CLOSE), [], "nothing is filed")
        self.assertEqual(self.posts_to(COMPILE), [], "nothing is filed")
        self.assertEqual(self.board.stream_posts(), [])
        axi = envelope(result.stdout)
        self.assertTrue(axi, result.stdout)
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(result.returncode, 1, "the suite passed, the run was not filed")


class AnInterruptedStreamedRunTest(StreamedRunCase):
    """AC7 — interrupted after some tests, the bounded `finish` delivers what
    was written before the run is aborted; before the first test, the run is
    aborted as today. The client exits either way, its relay stopped."""

    def interrupt(self, block_after, total):
        release = self.scratch / "release"
        stderr_path = self.scratch / "client-stderr.txt"
        env = self.environment(FAKE_TOTAL=total, FAKE_BLOCK_AFTER_INDEX=block_after,
                               FAKE_RELEASE_FILE=release, FAKE_MARKER_LINE=SIGNAL_MARKER)
        with open(stderr_path, "w") as err:
            proc = subprocess.Popen(self.command(), cwd=str(self.project), env=env,
                                    stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if SIGNAL_MARKER in stderr_path.read_text(errors="replace"):
                        break
                    time.sleep(0.02)
                proc.send_signal(signal.SIGINT)
                stdout, _ = proc.communicate(timeout=RUN_TIMEOUT)
            finally:
                release.write_text("go")
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        return proc.returncode, stdout, stderr_path.read_text(errors="replace")

    def test_interrupted_after_some_tests_the_finish_delivers_them_before_the_abort(self):
        code, stdout, stderr = self.interrupt(block_after=4, total=5)
        self.assertEqual(code, 128 + signal.SIGINT, f"stdout={stdout!r} stderr={stderr!r}")
        aborts = self.board.aborts()
        self.assertEqual([p for p, _b in aborts], [f"/api/v2/runs/{RUN_ID}/abort"])
        test_ends = [e for e in stream_events(self.board.held_stream(RUN_ID))
                     if e.get("event") == "test-end"]
        self.assertEqual(len(test_ends), 3,
                         "the three tests written before the signal reach the board")
        abort_at = self.index_of(lambda p, _b: p.endswith("/abort"))
        batches_at = [i for i, (p, _b) in enumerate(self.board.posts()) if STREAM_ROUTE.match(p)]
        self.assertTrue(batches_at and 0 <= max(batches_at) < abort_at,
                        "finish delivers them BEFORE the run is aborted")
        self.assertEqual(self.posts_to(CLOSE), [])

    def test_interrupted_before_its_first_test_the_run_is_aborted(self):
        code, stdout, stderr = self.interrupt(block_after=1, total=3)
        self.assertEqual(code, 128 + signal.SIGINT, f"stdout={stdout!r} stderr={stderr!r}")
        self.assertEqual([p for p, _b in self.board.aborts()],
                         [f"/api/v2/runs/{RUN_ID}/abort"])
        self.assertEqual([e for e in stream_events(self.board.held_stream(RUN_ID))
                          if e.get("event") == "test-end"], [])
        self.assertEqual(self.posts_to(CLOSE), [])
        self.assertEqual(self.posts_to(COMPILE), [])


class AStreamedRunsNarrationTest(StreamedRunCase):
    """AC8 — no in-run count; the closing `ran <test-end count>/<run-end
    total>`, then `ingesting…`, both before the close."""

    def assert_closing_narration(self, final_message):
        messages = self.board.messages()
        self.assertEqual([m for m in messages if str(m).startswith("running")], [],
                         f"a streamed run posts no in-run count; messages={messages!r}")
        posts = self.board.posts()
        final_at = heartbeat_index(posts, final_message)
        ingesting_at = heartbeat_index(posts, "ingesting…")
        close_at = self.index_of(lambda p, _b: p == CLOSE)
        self.assertIsNotNone(final_at, f"{final_message!r} not posted; messages={messages!r}")
        self.assertIsNotNone(ingesting_at, f"messages={messages!r}")
        self.assertGreaterEqual(close_at, 0, "the run is closed")
        assert final_at is not None and ingesting_at is not None
        self.assertLess(final_at, ingesting_at)
        self.assertLess(ingesting_at, close_at)

    def test_a_suite_with_subtests_closes_with_the_streams_count(self):
        result = self.drive(FAKE_TOTAL=12, FAKE_SUBTESTS=2)
        self.assertEqual(result.returncode, 0, self.diag(result))
        self.assert_closing_narration("ran 24/24")

    def test_the_closing_count_reads_the_run_ends_total(self):
        result = self.drive(FAKE_TOTAL=6, FAKE_RUN_END_TOTAL=7)
        self.assertEqual(len(self.posts_to(CLOSE)), 1, self.diag(result))
        self.assert_closing_narration("ran 6/7")

    def test_without_a_run_end_the_closing_count_falls_back_to_the_count(self):
        result = self.drive(FAKE_TOTAL=6, FAKE_SUBTESTS=2, FAKE_NO_RUN_END="1")
        self.assertEqual(len(self.posts_to(CLOSE)), 1, self.diag(result))
        self.assert_closing_narration("ran 12/12")


NESTED_OUTER_TEST = '''\
import os
import subprocess
import sys
import unittest


class OuterCase(unittest.TestCase):
    def test_outer_plain(self):
        self.assertEqual(1 + 1, 2)

    def test_outer_runs_a_nested_client(self):
        result = subprocess.run(
            [sys.executable, os.environ["NESTED_CLIENT"], "test",
             "--python", sys.executable,
             "--project-dir", os.environ["NESTED_PROJECT"],
             "--reports", os.environ["NESTED_REPORTS"],
             "--agent", "nested-client-agent"],
            capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
'''

NESTED_INNER_TEST = '''\
import unittest


class InnerCase(unittest.TestCase):
    def test_inner_only(self):
        self.assertTrue(True)
'''


class AStreamedRunIsIsolatedTest(StreamedRunCase):
    """AC9 — isolation."""

    def test_a_stale_stream_file_is_wiped_never_relayed_or_counted(self):
        self.reports.mkdir()
        stale = self.reports / STREAM_FILE
        stale.write_text(
            json.dumps({"event": "run-start", "total": 1}) + "\n"
            + json.dumps({"event": "test-end", "id": "stale.Case.test_stale",
                          "name": "test_stale", "status": "pass"}) + "\n"
            + json.dumps({"event": "run-end", "total": 1, "passed": 1, "failed": 0,
                          "pending": 0}) + "\n", encoding="utf-8")
        result = self.drive(FAKE_NO_REPORT="1", FAKE_TOTAL=1, FAKE_FAIL_COUNT=1)
        self.assertFalse(stale.exists(), "the wipe removes an earlier run's stream file")
        sent = json.dumps(self.board.posts())
        self.assertNotIn("test_stale", sent, "the stale stream is never relayed")
        self.assertEqual(self.posts_to(CLOSE), [], "nor counted as this run's stream")
        self.assertEqual(len(self.posts_to(COMPILE)), 1, self.diag(result))

    def test_a_run_without_agent_hands_its_runner_no_stream(self):
        result = self.drive(agent=False, inherit_stream=self.scratch / "outer.ndjson",
                            FAKE_TOTAL=1)
        self.assertEqual(result.returncode, 0, self.diag(result))
        self.assertIsNone(self.stream_seen(),
                          "an inherited CRUCIBLE_STREAM never reaches the runner")
        self.assertEqual([p for p, _b in self.board.posts()
                          if p.startswith("/api/v2/runs")], [])

    def test_a_nested_client_run_writes_nothing_into_the_outer_stream(self):
        self.assertTrue(REAL_VENV_PYTHON.exists(), f"needs {REAL_VENV_PYTHON}")
        outer_tests = self.project / "tests"
        outer_tests.mkdir()
        (outer_tests / "__init__.py").write_text("", encoding="utf-8")
        (outer_tests / "test_outer.py").write_text(NESTED_OUTER_TEST, encoding="utf-8")
        inner = self.scratch / "inner"
        (inner / "tests").mkdir(parents=True)
        (inner / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (inner / "tests" / "test_inner.py").write_text(NESTED_INNER_TEST, encoding="utf-8")
        install_project(str(inner), self.board.url, PROJECT_KEY)
        env = self.environment(NESTED_CLIENT=PYTHON_SCRIPT, NESTED_PROJECT=inner,
                               NESTED_REPORTS=self.scratch / "inner-reports")
        result = subprocess.run(
            self.command("test", python=str(REAL_VENV_PYTHON)), cwd=str(self.project),
            env=env, capture_output=True, text=True, timeout=240, check=False)
        self.assertEqual(result.returncode, 0, self.diag(result))
        outer_ids = [e.get("id") for e in stream_events(self.board.held_stream(RUN_ID))
                     if e.get("event") == "test-end"]
        self.assertEqual(sorted(outer_ids),
                         ["test_outer.OuterCase.test_outer_plain",
                          "test_outer.OuterCase.test_outer_runs_a_nested_client"],
                         "the outer stream holds the outer tests alone; "
                         + self.diag(result))
        outer_file = (self.reports / STREAM_FILE).read_text(encoding="utf-8")
        self.assertNotIn("test_inner_only", outer_file,
                         "the nested run wrote nothing into the outer stream file")
        inner_ids = [e.get("id") for e in stream_events(self.board.held_stream("run-live-2"))
                     if e.get("event") == "test-end"]
        self.assertEqual(inner_ids, ["test_inner.InnerCase.test_inner_only"],
                         "the nested run streams its own record to its own run")


# A stand-in interpreter that records, per launch, its argv and the
# `CRUCIBLE_STREAM` it was handed, to `interpreter_runs.jsonl` beside it. A
# suite run (the client's `subtest_runner.py`) writes one passing case as a
# Crucible event stream to the file that variable names; `coverage lcov -o
# <file>` writes a small lcov; anything else exits 0.
ENV_RECORDING_PYTHON = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
with open(os.path.join(here, "interpreter_runs.jsonl"), "a") as handle:
    handle.write(json.dumps({"argv": argv,
                             "stream": os.environ.get("CRUCIBLE_STREAM")}) + "\n")
if "lcov" in argv and "-o" in argv[:-1]:
    with open(argv[argv.index("-o") + 1], "w") as handle:
        handle.write("SF:pkg_under_measure/mod.py\nLF:1\nLH:1\nend_of_record\n")
    sys.exit(0)
stream = os.environ.pop("CRUCIBLE_STREAM", None)
if any(os.path.basename(arg) == "subtest_runner.py" for arg in argv):
    sys.stderr.write("test_case_1 (fake_module.FakeCase.test_case_1) ... ok\n")
    if stream:
        with open(stream, "w", encoding="utf-8") as handle:
            for event in (dict(event="run-start", total=1),
                          dict(event="test-end", id="fake_module.FakeCase.test_case_1",
                               name="test_case_1", suite="fake_module.FakeCase",
                               file="fake_module.py", status="pass", duration_ms=1),
                          dict(event="run-end", total=1, passed=1, failed=0,
                               pending=0, duration_ms=1)):
                handle.write(json.dumps(event) + "\n")
                handle.flush()
sys.exit(0)
'''


class OnlyTheRunnerIsHandedTheStreamTest(StreamedRunCase):
    """AC9 — `CRUCIBLE_STREAM` is set in the runner's environment alone:
    the `coverage lcov` child a `regression --coverage` run starts once the
    runner has exited is handed none."""

    def interpreter_runs(self):
        path = self.project / "interpreter_runs.jsonl"
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()]

    def test_the_coverage_lcov_child_of_a_streamed_regression_inherits_no_stream(self):
        fake = self.project / "recording_python.py"
        fake.write_text(f"#!{sys.executable}\n" + ENV_RECORDING_PYTHON, encoding="utf-8")
        fake.chmod(0o755)
        result = subprocess.run(
            self.command("regression", "--coverage", "--cov-source", "pkg_under_measure",
                         python=str(fake)),
            cwd=str(self.project), env=self.environment(), capture_output=True,
            text=True, timeout=RUN_TIMEOUT, check=False)
        runs = self.interpreter_runs()
        suite_runs = [r for r in runs if r["argv"][:3] == ["-m", "coverage", "run"]]
        lcov_runs = [r for r in runs if r["argv"][:3] == ["-m", "coverage", "lcov"]]
        self.assertEqual(len(suite_runs), 1, f"runs={runs!r} {self.diag(result)}")
        self.assertEqual(suite_runs[0]["stream"], self.expected_stream_path(),
                         "the runner, under `coverage run`, is handed the stream")
        self.assertEqual(len(lcov_runs), 1, f"runs={runs!r} {self.diag(result)}")
        self.assertIsNone(lcov_runs[0]["stream"],
                          f"the `coverage lcov` child is handed no CRUCIBLE_STREAM; "
                          f"runs={runs!r}")
        self.assertEqual([r["argv"][:3] for r in runs if r["stream"] is not None],
                         [["-m", "coverage", "run"]],
                         f"only the runner's launch carries the stream; runs={runs!r}")
        self.assertEqual(result.returncode, 0, self.diag(result))


class PytestAndAutoIngestKeepTheirJunitRecordTest(StreamedRunCase):
    """AC10 — a pytest run is filed from its JUnit report and `auto-ingest`
    files a JUnit dir, as today (pins); no `CRUCIBLE_STREAM` reaches pytest
    (new)."""

    def test_a_pytest_run_is_filed_from_its_junit_report_and_streams_nothing(self):
        result = self.drive("test", "--runner", "pytest", FAKE_TOTAL=2)
        self.assertEqual(result.returncode, 0, self.diag(result))
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, self.diag(result))
        self.assertEqual(closes[0].get("codec"), "junit")
        data = closes[0].get("data") or []
        self.assertEqual(len(data), 1)
        self.assertIn('name="test_case_2"', data[0])
        self.assertEqual(self.board.stream_posts(), [])

    def test_a_pytest_run_hands_its_runner_no_stream(self):
        result = self.drive("test", "--runner", "pytest",
                            inherit_stream=self.scratch / "outer.ndjson", FAKE_TOTAL=1)
        self.assertEqual(result.returncode, 0, self.diag(result))
        self.assertIsNone(self.stream_seen(), "pytest is never handed a stream")

    def test_auto_ingest_files_a_junit_dir_as_it_did(self):
        self.reports.mkdir()
        report = ('<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="a.B" tests="1">'
                  '<testcase classname="a.B" name="test_x" time="0.001"/></testsuite>\n')
        (self.reports / "TEST-a.B.xml").write_text(report, encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(PYTHON_SCRIPT), "auto-ingest",
             "--project-dir", str(self.project), "--reports", str(self.reports),
             "--agent", AGENT],
            cwd=str(self.project), env=self.environment(), capture_output=True,
            text=True, timeout=RUN_TIMEOUT, check=False)
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, self.diag(result))
        self.assertEqual(closes[0].get("codec"), "junit")
        self.assertEqual(closes[0].get("data"), [report])
        self.assertEqual(self.board.stream_posts(), [])


if __name__ == "__main__":
    unittest.main()
