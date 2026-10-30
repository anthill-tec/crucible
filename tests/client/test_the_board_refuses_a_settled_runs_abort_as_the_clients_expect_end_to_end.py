"""The board's refusal of a settled run's abort is the one the clients key on.

When an ingest's connection drops before its answer arrives, the client
aborts the run it opened; a board that already filed the run refuses that
abort with a 409 (`resolveRunClose`, src/v2.ts), and the client recognises
that refusal by its wording (`_SETTLED_ABORT_REFUSAL`, clients/_crucible_run.py)
to say the board may hold the run (`run-may-be-filed`). The pattern is prose
matched across a process boundary: if the board's sentence changes, nothing
breaks loudly; the warning silently degrades to `run-left-open`.

So this module asks a REAL board for that refusal, never a scripted copy of
it: a scratch board (`tests/client/real_board.py`: `bun run src/server.ts` on
an OS-assigned free port over a `mkdtemp` store, never a live board) opens a
run, files it through `POST /api/v2/runs`, and is then asked to abort it.
The answer goes through the clients' own transport (`http_request`, reached
through a client's `_axi()`), so the error text compared is the text
`abort_run` sees.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end
"""

import shutil
import unittest

from tests.client.live_run_harness import load_client
from tests.client.real_board import RealBoard

AGENT = "settled-abort-refusal-reporter"
STACK = "python"
ABORT_REASON = "the ingest's connection was lost before the board answered"
HTTP_409 = "HTTP 409: "

# One passing case: enough for the board to file the run, and so settle it.
_JUNIT = ('<?xml version="1.0" encoding="UTF-8"?>\n'
          '<testsuite name="settled_probe.SettledProbeCase" tests="1" '
          'errors="0" failures="0" skipped="0">'
          '<testcase classname="settled_probe.SettledProbeCase" '
          'name="test_the_run_is_filed" time="0.001"></testcase>'
          '</testsuite>\n')

_BOARD = None


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        # Not a skip: this module is the only guard on the board's wording,
        # and a guard that quietly stands down guards nothing.
        raise RuntimeError(
            "the refusal is read from a REAL board, and without `bun` there "
            "is none to boot")
    _BOARD = RealBoard(bun, "settled-abort-refusal")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class TheBoardRefusesASettledRunsAbortAsTheClientsExpectTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if _BOARD is None:
            raise AssertionError("the module's real board was never booted")
        cls.board = _BOARD
        reg = cls.board.http("/api/v2/agents/register",
                             {"projectKey": cls.board.key, "agentId": AGENT,
                              "role": "report"})
        assert reg.get("ok"), f"agent registration failed: {reg!r}"
        cls.core = load_client("python-crucible.py")._axi()

    # ── the board, through the clients' own transport ───────────────────────

    def post(self, path, payload):
        return self.core.http_request(self.board.base, "POST", path, payload)

    def open_run(self):
        started = self.post(self.core.RUN_START_PATH,
                            {"projectKey": self.board.key, "agentId": AGENT,
                             "stack": STACK})
        self.assertTrue(started.get("ok"), f"the run did not open: {started!r}")
        run_id = started.get("runId")
        self.assertIsInstance(run_id, str)
        return run_id

    def settled_run(self):
        """A run the board opened and then filed: settled, as a run is when
        its ingest reached the board and only the answer was lost."""
        run_id = self.open_run()
        filed = self.post("/api/v2/runs",
                          {"projectKey": self.board.key, "agentId": AGENT,
                           "stack": STACK, "codec": "junit", "data": [_JUNIT],
                           "runId": run_id})
        self.assertTrue(filed.get("ok"), f"the run was not filed: {filed!r}")
        self.assertEqual((filed.get("run") or {}).get("passed"), 1,
                         f"the board filed the one passing case: {filed!r}")
        return run_id

    def abort(self, run_id):
        return self.post(self.core.run_abort_path(run_id),
                         {"projectKey": self.board.key, "agentId": AGENT,
                          "reason": ABORT_REASON})

    # ── the refusal ─────────────────────────────────────────────────────────

    def test_the_boards_refusal_of_a_settled_runs_abort_matches_the_clients_pattern(self):
        run_id = self.settled_run()
        refused = self.abort(run_id)
        self.assertIs(refused.get("ok"), False,
                      f"the board refuses the abort of a filed run: {refused!r}")
        error = refused.get("error")
        self.assertIsInstance(error, str)
        self.assertTrue(error.startswith(HTTP_409),
                        f"a settled run's abort is refused 409: {error!r}")
        self.assertIn(f"run {run_id}", error)
        self.assertIsNotNone(
            self.core._SETTLED_ABORT_REFUSAL.search(error),
            f"the client's settled-abort pattern "
            f"{self.core._SETTLED_ABORT_REFUSAL.pattern!r} no longer matches "
            f"the board's refusal {error!r}, so a run the board may hold "
            f"would be reported left open")

    def test_a_lost_answer_whose_abort_finds_the_run_filed_says_the_board_may_hold_it(self):
        run_id = self.settled_run()
        warning = self.core.abort_run(self.post, self.board.key, AGENT, run_id,
                                      ABORT_REASON, answer_lost=True)
        self.assertEqual(warning.get("code"), self.core.RUN_MAY_BE_FILED_CODE,
                         f"the real board's refusal reads as a run it may "
                         f"hold: {warning!r}")
        self.assertNotEqual(warning.get("code"), self.core.RUN_LEFT_OPEN_CODE)
        self.assertIn(f"`run {run_id}`", warning.get("detail") or "")

    # ── what the pattern must not take for it ───────────────────────────────

    def test_the_boards_refusal_of_a_never_opened_runs_abort_does_not_match(self):
        refused = self.abort("run-never-opened")
        error = refused.get("error")
        self.assertIs(refused.get("ok"), False, f"{refused!r}")
        self.assertIsInstance(error, str)
        self.assertTrue(error.startswith("HTTP 400: "),
                        f"an unknown run's abort is refused 400: {error!r}")
        self.assertIsNone(self.core._SETTLED_ABORT_REFUSAL.search(error),
                          f"an unknown run is not a settled one: {error!r}")

    def test_the_abort_of_a_run_still_open_is_taken_not_refused(self):
        run_id = self.open_run()
        taken = self.abort(run_id)
        self.assertTrue(taken.get("ok"), f"an open run's abort is taken: {taken!r}")
        self.assertEqual(taken.get("status"), "aborted")
        self.assertEqual(taken.get("runId"), run_id)


if __name__ == "__main__":
    unittest.main()
