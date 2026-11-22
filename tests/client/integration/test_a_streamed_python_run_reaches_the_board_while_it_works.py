"""A streamed python run reaches the board while it works (CR-CRU-224 AC3),
and the fixture's stream is stored as its JUnit record (CR-CRU-224 AC2).

The feature this module keeps a live board for is the python crucible-events
run lifecycle end to end: a run opened, fed the runner's `crucible-events`
stream while it works, and closed from that stream on the board. No fake can
prove it, because what is asserted is the server's own decoding of the stream
into the open run's live view and into the stored record, compared with the
record the same board makes of the run's JUnit report.

`AStreamedPythonRunReachesTheBoardWhileItWorksTest`: the real `clients/python-crucible.py` runs the real runner
(`clients/subtest_runner.py`, under the repo's own interpreter) against a
scratch board (`RealBoard`: `bun run src/server.ts` over a throwaway store),
on a fixture suite whose tests wait on one another through the board: each
later test waits until the board's live view of the OPEN run
(`GET /api/v2/runs/<runId>/live`, `handleRunLive` in src/v2.ts) shows what
the earlier ones did, and this test lets it go on only once it has seen that.

- test 1 passes;
- test 2 waits until the board shows test 1 finished, then fails;
- test 3 waits until the board shows test 2's failure, then passes;
- test 4 waits until the board shows three finished tests.

So each finished test and each failure is shown before the run ends. A wait
that is never released gives up after `GATE_SECONDS`, so a run whose stream
never reaches the board still ends, and fails here.

`TheFixtureStreamIsStoredAsItsJunitRecordTest`: the binding comparison of
AC2. The stream the python runner writes for the committed fixture
`tests/fixtures/unittest-project`, sent to a real scratch board
(`tests/client/real_board.py`) the way the python client sends it --
`POST /api/v2/runs/start`, then the stream through
`POST /api/v2/runs/<runId>/stream`, then the close, `POST /api/v2/runs` with
the `runId`, `codec: "crucible-events"` and no `data` -- is stored as the run
`expected.json` freezes from xmlrunner 4.0.0's JUnit report of the same cases
read by the same board:
- the same tree: suite names (without xmlrunner's `-<timestamp>`), case
  names, statuses and failures (as their digest), durations excluded, order
  ignored;
- the same distinct-file count and summary;
- and no `incomplete`.

Needs the real `bun`, which boots the board; it FAILS, never skips, without.
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

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tests.client.live_run_harness import scrubbed_env
from tests.client.real_board import RealBoard
from tests.client import client_script
from tests.client.client_cadence_settings import SHORT_RELAY, launcher_command
from tests.client.unittest_project_fixture import (
    FixtureRun,
    digest,
    events_of,
    expected,
    normalise,
    stream_text,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
PYTHON_SCRIPT = client_script("python-crucible.py")
REAL_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"

AGENT = "python-live-stream-agent"
# The client runs through the test-only launcher with the relay and stream
# tick and the narrator throttle at 0.2 s (`SHORT_RELAY`), a tenth of
# production's 2 s; the waits below are scaled with it, so a relay that never
# wakes fails the drive within seconds.
GATE_SECONDS = 4
OBSERVE_SECONDS = 5
RUN_TIMEOUT = 30
RUN_STARTED = re.compile(r"^\[crucible\] run started: (\S+)$", re.MULTILINE)

FIRST = "test_1_passes"
SECOND = "test_2_fails_once_the_board_shows_the_first"
THIRD = "test_3_passes_once_the_board_shows_the_failure"
FOURTH = "test_4_ends_once_the_board_shows_three"
PLANTED = "planted live failure"

WAITING_SUITE = f'''\
import os
import time
import unittest


def wait_for(name):
    path = os.path.join(os.environ["LIVE_GATE_DIR"], name)
    deadline = time.monotonic() + {GATE_SECONDS}
    while time.monotonic() < deadline and not os.path.exists(path):
        time.sleep(0.05)


class WaitsOnTheBoardCase(unittest.TestCase):
    def {FIRST}(self):
        self.assertTrue(True)

    def {SECOND}(self):
        wait_for("seen-1")
        self.fail("{PLANTED}")

    def {THIRD}(self):
        wait_for("seen-2")

    def {FOURTH}(self):
        wait_for("seen-3")
'''


class AStreamedPythonRunReachesTheBoardWhileItWorksTest(unittest.TestCase):

    def setUp(self):
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "this test boots the real board with `bun`")
        self.assertTrue(REAL_VENV_PYTHON.exists(), f"needs {REAL_VENV_PYTHON}")
        assert bun is not None
        self.scratch = Path(tempfile.mkdtemp(prefix="python-live-stream-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.board = RealBoard(bun, "python-live-stream")
        self.addCleanup(self.board.close)
        self.project = self.scratch / "project"
        (self.project / "tests").mkdir(parents=True)
        (self.project / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (self.project / "tests" / "test_waits.py").write_text(WAITING_SUITE, encoding="utf-8")
        self.board.install(str(self.project))
        self.gates = self.scratch / "gates"
        self.gates.mkdir()

    def live(self, run_id):
        return self.board.http(f"/api/v2/runs/{run_id}/live")

    def observe(self, run_id, shown):
        """Poll the open run's live view until `shown(answer)`; answers that
        live view, or None when the board never showed it while the run was
        open."""
        deadline = time.monotonic() + OBSERVE_SECONDS
        while time.monotonic() < deadline:
            answer = self.live(run_id)
            if answer.get("state") == "open" and shown(answer):
                return answer
            time.sleep(0.1)
        return None

    def test_each_finished_test_and_each_failure_is_on_the_board_before_the_run_ends(self):
        stderr_path = self.scratch / "client-stderr.txt"
        env = scrubbed_env(LIVE_GATE_DIR=self.gates)
        env.pop("CRUCIBLE_STREAM", None)
        cmd = launcher_command(PYTHON_SCRIPT, "test",
                               "--python", str(REAL_VENV_PYTHON),
                               "--project-dir", str(self.project),
                               "--reports", str(self.scratch / "reports"), "--agent", AGENT,
                               **SHORT_RELAY)
        seen = {}
        with open(stderr_path, "w") as err:
            proc = subprocess.Popen(cmd, cwd=str(self.project), env=env,
                                    stdout=subprocess.PIPE, stderr=err, text=True)
            try:
                run_id = None
                deadline = time.monotonic() + 60
                while (run_id is None and time.monotonic() < deadline
                       and proc.poll() is None):
                    found = RUN_STARTED.search(stderr_path.read_text(errors="replace"))
                    run_id = found.group(1) if found else None
                    time.sleep(0.05)
                found = RUN_STARTED.search(stderr_path.read_text(errors="replace"))
                run_id = found.group(1) if found else None
                self.assertIsNotNone(run_id, stderr_path.read_text(errors="replace"))
                steps = (
                    ("seen-1", lambda a: (a.get("live") or {}).get("passed", 0) >= 1),
                    ("seen-2", lambda a: any(f.get("name") == SECOND
                                             for f in a.get("failures") or [])),
                    ("seen-3", lambda a: (a.get("live") or {}).get("completed", 0) >= 3),
                )
                for gate, shown in steps:
                    seen[gate] = self.observe(run_id, shown)
                    (self.gates / gate).write_text("go")
                proc.communicate(timeout=RUN_TIMEOUT)
            finally:
                for gate in ("seen-1", "seen-2", "seen-3"):
                    (self.gates / gate).write_text("go")
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        diag = f"exit={proc.returncode} stderr={stderr_path.read_text(errors='replace')[-3000:]!r}"
        self.assertIsNotNone(seen["seen-1"],
                             f"the first finished test is on the board while the run "
                             f"works; {diag}")
        first = seen["seen-1"] or {}
        self.assertEqual((first.get("live") or {}).get("failed"), 0, first)
        failure_view = seen["seen-2"]
        self.assertIsNotNone(failure_view, f"the failure is on the board while the run "
                                           f"works; {diag}")
        failures = [f for f in (failure_view or {}).get("failures") or []
                    if f.get("name") == SECOND]
        self.assertEqual(len(failures), 1, failure_view)
        self.assertIn(PLANTED, failures[0].get("message") or "", failures[0])
        self.assertEqual(failures[0].get("suite"), "test_waits.WaitsOnTheBoardCase")
        third = seen["seen-3"]
        self.assertIsNotNone(third, f"the third finished test is on the board while "
                                    f"the run works; {diag}")
        counts = (third or {}).get("live") or {}
        self.assertEqual((counts.get("completed"), counts.get("passed"), counts.get("failed")),
                         (3, 2, 1), third)
        self.assertEqual(counts.get("total"), 4, "run-start states countTestCases()")
        self.assertEqual(proc.returncode, 1, f"one test failed; {diag}")
        events = self.board.test_events(AGENT)
        self.assertEqual(len(events), 1, json.dumps(events)[:2000])
        summary = self.board.event(events[0]["id"]).get("summary") or {}
        self.assertEqual({k: summary.get(k) for k in ("total", "passed", "failed")},
                         {"total": 4, "passed": 3, "failed": 1})


FIXTURE_STREAM_AGENT = "unittest-project-stream"
CODEC = "crucible-events"


def _comparable_tree(tree, project):
    """A stored tree as `expected.json` keeps it: each failure digested, no
    durations, suites and cases sorted by name."""
    out = []
    for suite in tree:
        children = []
        for leaf in suite.get("children", []):
            child = {"name": leaf.get("name"), "status": leaf.get("status")}
            if leaf.get("failure") is not None:
                child["failure"] = digest(leaf["failure"], project)
            children.append(child)
        children.sort(key=lambda c: c["name"])
        out.append({"name": suite.get("name"), "status": suite.get("status"),
                    "children": children})
    out.sort(key=lambda s: s["name"])
    return out


class TheFixtureStreamIsStoredAsItsJunitRecordTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.expected = expected()
        cls.run_ = FixtureRun("unittest-runner-stream-board-")
        cls.text = stream_text(cls.run_.stream)
        bun = shutil.which("bun")
        cls.board = RealBoard(bun, "unittest-project-stream") if bun is not None else None

    @classmethod
    def tearDownClass(cls):
        if cls.board is not None:
            cls.board.close()

    def _streamed_close(self):
        self.assertIsNotNone(self.board, "this comparison boots the real board with `bun`")
        self.assertIsNotNone(
            self.text, f"the runner wrote no stream; exit={self.run_.result.returncode} "
                       f"output tail={self.run_.output[-800:]!r}")
        board, text = self.board, self.text
        assert board is not None and text is not None
        registered = board.http("/api/v2/agents/register",
                                {"projectKey": board.key, "agentId": FIXTURE_STREAM_AGENT,
                                 "role": "ORCHESTRATOR"})
        self.assertTrue(registered.get("ok"), registered)
        opened = board.http("/api/v2/runs/start", {"projectKey": board.key,
                                                   "agentId": FIXTURE_STREAM_AGENT,
                                                   "stack": "python"})
        run_id = opened.get("runId")
        self.assertIsInstance(run_id, str, opened)
        sent = board.http(f"/api/v2/runs/{run_id}/stream",
                          {"projectKey": board.key, "agentId": FIXTURE_STREAM_AGENT,
                           "codec": CODEC, "from": 0, "data": text})
        self.assertTrue(sent.get("ok"), sent)
        self.assertEqual(sent.get("held"), len(text.encode("utf-8")), sent)
        closed = board.http("/api/v2/runs", {"projectKey": board.key,
                                             "agentId": FIXTURE_STREAM_AGENT,
                                             "runId": run_id, "codec": CODEC})
        self.assertTrue(closed.get("ok"), closed)
        return closed, board.event(closed["event"])

    def test_the_stream_closed_on_the_board_stores_the_tree_files_and_summary_of_the_junit_record(self):
        closed, event = self._streamed_close()
        self.assertNotIn("incomplete", event, f"incomplete: {event.get('incomplete')!r}")
        codes = [w.get("code") for w in closed.get("warnings") or []]
        self.assertNotIn("stream-incomplete", codes, closed)
        self.assertEqual(_comparable_tree(event.get("tree") or [], self.run_.project),
                         self.expected["tree"])
        summary = event.get("summary") or {}
        self.assertEqual({k: summary.get(k) for k in ("total", "passed", "failed", "pending")},
                         self.expected["summary"])
        self.assertEqual((closed.get("run") or {}).get("files"), self.expected["fileCount"])

    def test_the_streams_distinct_files_are_the_junit_records_files(self):
        self.assertIsNotNone(self.text, f"the runner wrote no stream; "
                                        f"output tail={self.run_.output[-800:]!r}")
        assert self.text is not None
        files = {normalise(e.get("file"), self.run_.project)
                 for e in events_of(self.text) if e.get("event") == "test-end"}
        self.assertEqual(sorted(files, key=str), self.expected["files"])


if __name__ == "__main__":
    unittest.main()
