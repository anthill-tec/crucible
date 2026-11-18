"""The fixture's stream is stored as its JUnit record (CR-CRU-224 AC2).

The binding comparison of AC2: the stream the python runner writes for the
committed fixture `tests/fixtures/unittest-project`, sent to a real scratch
board (`tests/client/real_board.py`) the way the python client sends it --
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

import shutil
import unittest

from tests.client.real_board import RealBoard
from tests.client.unittest_project_fixture import (
    FixtureRun,
    digest,
    events_of,
    expected,
    normalise,
    stream_text,
)

AGENT = "unittest-project-stream"
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
                                {"projectKey": board.key, "agentId": AGENT,
                                 "role": "ORCHESTRATOR"})
        self.assertTrue(registered.get("ok"), registered)
        opened = board.http("/api/v2/runs/start", {"projectKey": board.key, "agentId": AGENT,
                                                   "stack": "python"})
        run_id = opened.get("runId")
        self.assertIsInstance(run_id, str, opened)
        sent = board.http(f"/api/v2/runs/{run_id}/stream",
                          {"projectKey": board.key, "agentId": AGENT, "codec": CODEC,
                           "from": 0, "data": text})
        self.assertTrue(sent.get("ok"), sent)
        self.assertEqual(sent.get("held"), len(text.encode("utf-8")), sent)
        closed = board.http("/api/v2/runs", {"projectKey": board.key, "agentId": AGENT,
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
