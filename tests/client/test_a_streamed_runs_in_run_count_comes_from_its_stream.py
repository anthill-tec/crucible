"""A streamed run's in-run count comes from its stream, never its console.

A run whose record is its runner's `crucible-events` stream narrates its
in-run `running N[/M]` ticks from the STREAM's `test-end`s: a runner whose
console the client does not read (Vitest) still ticks. While the relay's last
batch was held, no in-run tick is posted (its batches keep the agent alive);
whenever the relay is not landing batches (a 503 throughout, a refusal, a
cut), the ticks ARE posted, counted from the stream. This lives in the shared
narration, so a python streamed run ticks the same way.

Every test drives a REAL client as an OS subprocess against a stand-in board,
with `STREAM_RUNNER` below as the runner: a small python program that writes
one `run-start` (its total), one passing `test-end` per case and one `run-end`
to the file `CRUCIBLE_STREAM` names, flushing each line, and prints only
plain text no console recogniser counts. It parks before each case a gate
names (`FAKE_GATES`, a JSON list of `[case, marker, release file]`): it prints
the marker and waits for the release file, so a test sees the board and the
client reach a state while the runner is still working, never by timing luck.

- the bun client runs it as a `crucible.targets` stream target (`--bun`,
  `bun run test:unit`), against `TargetsBoard` (tests/client/bun_targets_harness.py);
- the python client runs it as its interpreter (`--python`) on a streamed
  unittest run, against `RecordingBoard` (tests/client/live_run_harness.py).
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.client.bun_targets_harness import (
    AGENT as BUN_AGENT,
)
from tests.client.bun_targets_harness import (
    BUN_CLIENT,
    CLOSE,
    HEARTBEAT,
    RUN_ID,
    VITEST_STREAM_ENTRY,
    TargetsBoard,
    TargetsCase,
)
from tests.client.live_run_harness import (
    STREAM_CODEC,
    RecordingBoard,
    install_project,
    load_client,
    scrubbed_env,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_CLIENT = REPO_ROOT / "clients" / "python-crucible.py"

PYTHON_AGENT = "python-stream-count-agent"
PYTHON_PROJECT_KEY = "python-stream-count-key"
UNIT = "test:unit"

REFUSAL = "STREAM_UNAVAILABLE_FROM_THE_FIXTURE_BOARD"
# The status every stream batch is answered with on a board that never lands
# one (typed loosely: the base board's own answers are narrower literals).
UNAVAILABLE: Any = 503
MARKER = "STREAM_COUNT_GATE"
RUNNER_LINE = "stream fixture: wrote case "

# The cases before the first gate, between the two gates, and after the last.
BEFORE = 3
MIDDLE = 20
AFTER = 20
TOTAL = BEFORE + MIDDLE + AFTER

RUN_TIMEOUT = 120
MARKER_WAIT = 30
# The relay sends every RELAY_SECONDS (2 s): its first answer lands well
# inside this.
RELAY_WAIT = 10
# How long a parked runner waits for an in-run tick to reach the board.
TICK_WAIT = 20

# An in-run tick: `running <completed>` or `running <completed>/<total>`, a
# label maybe after it.
_RUNNING_TICK = re.compile(r"^running (\d+)(?:/(\d+))?")

STREAM_RUNNER = r'''
import json
import os
import sys
import time

def say(text):
    sys.stdout.write(text + "\n")
    sys.stdout.flush()

stream = os.environ.get("CRUCIBLE_STREAM")
if not stream:
    say("stream fixture: no stream to write")
    sys.exit(0)
total = int(os.environ.get("FAKE_STREAM_TOTAL", "3"))
gates = json.loads(os.environ.get("FAKE_GATES", "[]"))

def park(case):
    for gate_case, marker, release in gates:
        if gate_case == case:
            say(marker)
            deadline = time.time() + 60
            while not os.path.exists(release) and time.time() < deadline:
                time.sleep(0.02)

directory = os.path.dirname(stream)
if directory:
    os.makedirs(directory, exist_ok=True)
with open(stream, "w", encoding="utf-8") as handle:
    def emit(event):
        handle.write(json.dumps(event) + "\n")
        handle.flush()

    emit({"event": "run-start", "total": total})
    say("stream fixture: started %d cases" % total)
    for i in range(1, total + 1):
        park(i)
        emit({"event": "test-end", "id": "stream_fixture.case_%d" % i,
              "name": "case_%d" % i, "suite": "stream_fixture",
              "file": "stream_fixture.test.ts", "status": "pass", "duration_ms": 1})
        say("stream fixture: wrote case %d" % i)
    emit({"event": "run-end", "total": total, "passed": total, "failed": 0,
          "pending": 0, "duration_ms": 1})
say("stream fixture: finished")
sys.exit(0)
'''


def _read(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def write_stream_runner(directory):
    path = Path(directory) / "stream_runner.py"
    path.write_text(f"#!{sys.executable}\n" + STREAM_RUNNER, encoding="utf-8")
    path.chmod(0o755)
    return path


def in_run_ticks(board):
    """`[(wire index, completed, total)]` of every heartbeat whose message
    starts `running ` (`total` None when it carries no `/M`, both None when
    it carries no count)."""
    found = []
    for i, (path, body) in enumerate(board.posts()):
        message = str(body.get("message") or "") if isinstance(body, dict) else ""
        if path == HEARTBEAT and message.startswith("running "):
            count = _RUNNING_TICK.match(message)
            if count is None:
                found.append((i, None, None))
            else:
                total = count.group(2)
                found.append((i, int(count.group(1)), int(total) if total else None))
    return found


def held_test_ends(board, run_id=RUN_ID):
    return board.held_stream(run_id).count('"test-end"')


class GatedDrive:
    """One gated client run: its exit, its output, and each gate's cue (the
    state its step waited for was reached while the runner was parked)."""

    def __init__(self, returncode, stdout, stderr, cues):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.cues = cues

    def diag(self):
        return (f"cues={self.cues!r} exit={self.returncode} stdout={self.stdout!r} "
                f"stderr={self.stderr[-3000:]!r}")


def drive_through_gates(cmd, cwd, env, scratch, gates):
    """Run `cmd` with the stream runner parking at each of `gates`, a list of
    `(case, step)`: before that case the runner prints a marker and waits;
    the test calls `step(said)` (`said()` reads the client's stderr so far),
    which answers whether what the gate waits for was reached, and then
    releases the runner."""
    stderr_path = Path(scratch) / "client-stderr.txt"
    plan = [(case, f"{MARKER}_{n}", Path(scratch) / f"gate-{n}", step)
            for n, (case, step) in enumerate(gates, start=1)]
    env = {**env, "FAKE_GATES": json.dumps([[case, marker, str(release)]
                                            for case, marker, release, _step in plan])}

    def said():
        return _read(stderr_path)

    cues = []
    with open(stderr_path, "w", encoding="utf-8") as err:
        proc = subprocess.Popen(cmd, cwd=str(cwd), env=env, stdout=subprocess.PIPE,
                                stderr=err, text=True)
        try:
            for _case, marker, release, step in plan:
                parked = _wait_until(lambda m=marker: m in said(), MARKER_WAIT)
                cues.append(bool(parked and step(said)))
                release.write_text("go", encoding="utf-8")
            stdout, _ = proc.communicate(timeout=RUN_TIMEOUT)
        finally:
            for _case, _marker, release, _step in plan:
                release.write_text("go", encoding="utf-8")
            if proc.poll() is None:
                proc.kill()
                proc.wait()
    return GatedDrive(proc.returncode, stdout, said(), cues)


class StreamUnavailableTargetsBoard(TargetsBoard):
    """`TargetsBoard` whose stream route answers every batch 503 (`REFUSAL`,
    `held` 0): a board that is up but never lands a batch."""

    def _append_stream(self, run_id, body):
        return UNAVAILABLE, {"ok": False, "error": REFUSAL, "held": 0}


class StreamUnavailableRecordingBoard(RecordingBoard):
    """`RecordingBoard` whose stream route answers every batch 503
    (`REFUSAL`, `held` 0)."""

    def _append_stream(self, run_id, body):
        return UNAVAILABLE, {"ok": False, "error": REFUSAL, "held": 0}


def heard_a_503(said):
    """The relay has had a 503 answer and taken it in: it says the failure,
    naming the board's error, once it has applied the answer."""
    return _wait_until(lambda: REFUSAL in said(), RELAY_WAIT)


# ── bun: a stream target ────────────────────────────────────────────────────


class AStreamTargetsInRunCountComesFromItsStreamTest(TargetsCase):
    """A `crucible.targets` stream target whose runner prints nothing bun's
    console recogniser counts: its in-run ticks come from the stream."""

    def setUp(self):
        super().setUp()
        self.runner = write_stream_runner(self.scratch)
        self.bun = load_client("bun-crucible.py")
        self.declare_unit_target(VITEST_STREAM_ENTRY)

    def drive_gated(self, gates):
        cmd = [sys.executable, str(BUN_CLIENT), "unit", "--bun", str(self.runner),
               "--project-dir", str(self.project), "--package-dir", str(self.project),
               "--reports", str(self.reports), "--agent", BUN_AGENT]
        env = scrubbed_env(FAKE_STREAM_TOTAL=TOTAL)
        for key in ("BUN_CRUCIBLE_NO_LIFECYCLE", "BUN_CRUCIBLE_PACKAGE_DIR",
                    "BUN_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_BUN", "CRUCIBLE_AGENT_ID",
                    "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_STREAM", "CRUCIBLE_REPORTERS"):
            env.pop(key, None)
        return drive_through_gates(cmd, self.project, env, self.scratch, gates)

    def assert_the_console_counts_nothing(self):
        """The runner's console, as the client logged it, holds no line bun's
        recogniser counts: a tick is the stream's, never the console's."""
        console = _read(self.reports / "run.log")
        self.assertIn(f"{RUNNER_LINE}{TOTAL}", console,
                      "the run log holds the runner's console")
        counted = [line for line in console.splitlines()
                   if self.bun._recognise_completion(line)[0]]
        self.assertEqual(counted, [], "the runner prints nothing bun's console recogniser counts")

    def assert_filed_by_its_stream(self, drive):
        self.assertEqual(drive.returncode, 0, drive.diag())
        closes = self.posts_to(CLOSE)
        self.assertEqual(len(closes), 1, f"exactly one close; {drive.diag()}")
        close = closes[0] if isinstance(closes[0], dict) else {}
        self.assertEqual((close.get("codec"), close.get("runId"), close.get("framework")),
                         (STREAM_CODEC, RUN_ID, "vitest"),
                         f"the run is closed by its stream; close={close!r}")
        self.assertIn(f"ran {TOTAL}/{TOTAL}", self.board.messages(),
                      f"the closing count; messages={self.board.messages()!r}")

    def test_a_stream_answered_503_throughout_ticks_its_in_run_count_from_the_streams_test_ends(self):
        self.use_board(StreamUnavailableTargetsBoard())
        seen_while_parked = []

        def a_tick_reached_the_board(_said):
            reached = _wait_until(lambda: bool(in_run_ticks(self.board)), TICK_WAIT)
            seen_while_parked.extend(in_run_ticks(self.board))
            return reached

        drive = self.drive_gated([(BEFORE + 1, heard_a_503),
                                  (BEFORE + MIDDLE + 1, a_tick_reached_the_board)])
        self.assertTrue(drive.cues and drive.cues[0],
                        f"the relay heard a 503 while the runner was parked; {drive.diag()}")
        self.assertTrue(
            len(drive.cues) == 2 and drive.cues[1],
            f"an in-run `running N/{TOTAL}` tick reached the board while the runner was "
            f"parked after {BEFORE + MIDDLE} test-ends, every batch answered 503; "
            f"messages={self.board.messages()!r}; {drive.diag()}")
        self.assertEqual(
            [t for t in seen_while_parked
             if t[1] is None or not 1 <= t[1] <= BEFORE + MIDDLE or t[2] != TOTAL],
            [], f"each tick counts the stream's test-ends written so far, over the "
                f"run-start's {TOTAL}; ticks={seen_while_parked!r}")
        self.assertEqual(self.board.held_stream(RUN_ID), "",
                         "the board never held a batch: the relay was never landing")
        self.assert_the_console_counts_nothing()
        self.assert_filed_by_its_stream(drive)
        close_at = next(i for i, (p, _b) in enumerate(self.board.posts()) if p == CLOSE)
        self.assertEqual([t for t in in_run_ticks(self.board) if t[0] > close_at], [],
                         "no in-run tick after the close")

    def test_a_stream_the_board_holds_posts_no_in_run_tick(self):
        def holds(count):
            return lambda _said: _wait_until(
                lambda: held_test_ends(self.board) >= count, RELAY_WAIT)

        drive = self.drive_gated([(BEFORE + 1, holds(BEFORE)),
                                  (BEFORE + MIDDLE + 1, holds(BEFORE + MIDDLE))])
        self.assertEqual(drive.cues, [True, True],
                         f"the board held each stretch of the stream while the runner was "
                         f"parked; {drive.diag()}")
        self.assertEqual(held_test_ends(self.board), TOTAL, "the whole stream landed")
        self.assertEqual(in_run_ticks(self.board), [],
                         f"no in-run tick while the relay lands every batch; "
                         f"messages={self.board.messages()!r}")
        self.assert_the_console_counts_nothing()
        self.assert_filed_by_its_stream(drive)


# ── python: a streamed unittest run ─────────────────────────────────────────


class AStreamedPythonRunsInRunCountComesFromItsStreamTest(unittest.TestCase):
    """A python streamed run whose relay is answered 503 throughout ticks its
    in-run count from the stream's `test-end`s, as the shared narration does."""

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="python-stream-count-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.project = self.scratch / "project"
        self.project.mkdir()
        self.reports = self.scratch / "reports"
        self.runner_log = self.scratch / "runner.log"
        self.board = StreamUnavailableRecordingBoard()
        self.addCleanup(self.board.close)
        install_project(str(self.project), self.board.url, PYTHON_PROJECT_KEY)
        self.runner = write_stream_runner(self.scratch)
        self.python = load_client("python-crucible.py")

    def test_a_stream_answered_503_throughout_ticks_its_in_run_count_from_the_streams_test_ends(self):
        cmd = [sys.executable, str(PYTHON_CLIENT), "test", "--python", str(self.runner),
               "--project-dir", str(self.project), "--reports", str(self.reports),
               "--log", str(self.runner_log), "--agent", PYTHON_AGENT]
        env = scrubbed_env(FAKE_STREAM_TOTAL=TOTAL)
        env.pop("CRUCIBLE_STREAM", None)
        seen_while_parked = []

        def a_tick_reached_the_board(_said):
            reached = _wait_until(lambda: bool(in_run_ticks(self.board)), TICK_WAIT)
            seen_while_parked.extend(in_run_ticks(self.board))
            return reached

        drive = drive_through_gates(cmd, self.project, env, self.scratch,
                                    [(BEFORE + 1, heard_a_503),
                                     (BEFORE + MIDDLE + 1, a_tick_reached_the_board)])
        self.assertTrue(drive.cues and drive.cues[0],
                        f"the relay heard a 503 while the runner was parked; {drive.diag()}")
        self.assertTrue(
            len(drive.cues) == 2 and drive.cues[1],
            f"an in-run `running N` tick reached the board while the runner was parked "
            f"after {BEFORE + MIDDLE} test-ends, every batch answered 503; "
            f"messages={self.board.messages()!r}; {drive.diag()}")
        self.assertEqual(
            [t for t in seen_while_parked
             if t[1] is None or not 1 <= t[1] <= BEFORE + MIDDLE
             or t[2] not in (None, TOTAL)],
            [], f"each tick counts the stream's test-ends written so far; "
                f"ticks={seen_while_parked!r}")
        self.assertEqual(self.board.held_stream(RUN_ID), "",
                         "the board never held a batch: the relay was never landing")
        console = _read(self.runner_log)
        self.assertIn(f"{RUNNER_LINE}{TOTAL}", console, "the log holds the runner's console")
        self.assertEqual([line for line in console.splitlines()
                          if self.python._recognise_completion(line)], [],
                         "the runner prints nothing python's verdict recogniser counts")
        self.assertEqual(drive.returncode, 0, drive.diag())
        closes = [b for p, b in self.board.posts() if p == CLOSE]
        self.assertEqual(len(closes), 1, f"exactly one close; {drive.diag()}")
        close = closes[0] if isinstance(closes[0], dict) else {}
        self.assertEqual((close.get("codec"), close.get("runId")), (STREAM_CODEC, RUN_ID),
                         f"the run is closed by its stream; close={close!r}")
        self.assertIn(f"ran {TOTAL}/{TOTAL}", self.board.messages())


if __name__ == "__main__":
    unittest.main()
