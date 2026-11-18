"""The shared run path carries a rust run's stdout stream without changing
any other stack's run.

The rust client asks `run_streamed` to split the runner's stdout into a
stream file and reads the stream's counts through its codec (`nextest`).
Every other caller — the bun, python, mvn and arduino clients — asks for no
split, and their streams are `crucible-events`. For them, these readings stay
exactly as they were:
  - `run_streamed` without a split echoes the runner's stdout AND stderr live
    on stderr, interleaved as written, and returns both in one capture, the
    log holding the same bytes;
  - `stream_counts` reads a `crucible-events` file exactly as before:
    `test-end`s, the `run-end` total, the `run-start` total, and the tests
    that ran.

Pins: they pass on today's shared module, and fail against a shared module
whose default became the split, or whose count stopped reading
`crucible-events` events.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_shared_run_path_reads_every_stack_as_before
"""

import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import load_client

AXI = load_client("_crucible_axi.py")

# A runner that writes its stdout and its stderr in turn, flushing each line.
_RUNNER = (
    "import sys\n"
    "for i in range(3):\n"
    "    sys.stdout.write(f'out-{i}\\n'); sys.stdout.flush()\n"
    "    sys.stderr.write(f'err-{i}\\n'); sys.stderr.flush()\n"
)

_EVENTS = (
    '{"event": "run-start", "total": 4}\n'
    '{"event": "test-end", "id": "a", "status": "pass"}\n'
    '{"event": "test-end", "id": "b", "status": "fail"}\n'
    '{"event": "test-end", "id": "c", "status": "skip"}\n'
    'not json at all\n'
    '{"event": "run-end", "total": 3}\n'
)


class AnUnsplitRunStillMergesItsRunnersOutputTest(unittest.TestCase):

    def setUp(self):
        self.scratch = tempfile.mkdtemp(prefix="shared-run-path-")
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)

    def test_an_unsplit_run_captures_and_logs_stdout_and_stderr_together(self):
        log = os.path.join(self.scratch, "run.log")
        echoed = io.StringIO()
        with contextlib.redirect_stderr(echoed):
            result = AXI.run_streamed([sys.executable, "-c", _RUNNER], self.scratch,
                                      dict(os.environ), log, None, capture=True)
        self.assertEqual(result.returncode, 0)
        lines = (result.stdout or "").splitlines()
        self.assertEqual(sorted(lines),
                         sorted([f"out-{i}" for i in range(3)] + [f"err-{i}" for i in range(3)]),
                         "the capture holds the runner's stdout and stderr, nothing else")
        self.assertEqual([x for x in lines if x.startswith("out-")], ["out-0", "out-1", "out-2"])
        self.assertEqual(Path(log).read_text(), result.stdout,
                         "the log holds exactly the capture")
        for line in lines:
            self.assertIn(line + "\n", echoed.getvalue(), "every line is echoed on stderr")


class ACrucibleEventsStreamCountsAsBeforeTest(unittest.TestCase):

    def test_stream_counts_reads_a_crucible_events_file_as_before(self):
        scratch = tempfile.mkdtemp(prefix="shared-run-counts-")
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        path = os.path.join(scratch, "crucible-events.ndjson")
        Path(path).write_text(_EVENTS)
        self.assertEqual(tuple(AXI.stream_counts(path)), (3, 3, 4, 2),
                         "(test-ends, run-end total, run-start total, ran)")

    def test_stream_counts_of_a_missing_file_holds_nothing(self):
        self.assertEqual(tuple(AXI.stream_counts("/nonexistent/crucible-events.ndjson")),
                         (0, None, None, 0))


if __name__ == "__main__":
    unittest.main()
