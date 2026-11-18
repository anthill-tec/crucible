"""Every wording the board can refuse a settled run's abort with is one the
client's pattern recognises — read from the board's source, with no board.

The board has TWO ways to refuse the abort of a settled run: the run-close
check every ingest shares (`resolveRunClose`, src/v2.ts: the run "is already
<state>"), and the abort's own (`handleRunAbort`, src/v2.ts: the run "settled
before it could be aborted"), which a board that files the run while the
connection drops answers when the abort races the ingest's settlement. A
scratch board cannot be made to lose that race on demand, so each wording is
read from the board's source, rendered with a sample run id as the client's
transport reports it, and the client's pattern (`_SETTLED_ABORT_REFUSAL`,
clients/_crucible_run.py) must match each. The rendering is anchored on the
real board's own refusal, byte for byte, in the live-board module
`test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end`.

Unit: a source read and an in-process client load; no process, no socket.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.unit.test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end_without_a_board
"""

import unittest

from tests.client.live_run_harness import load_client
from tests.client.the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end_helpers import (
    SAMPLE_RUN_ID,
    _settled_states,
    rendered_settled_run_refusals,
    settled_run_refusal_templates,
)


class EverySettledRunRefusalOfAnAbortIsRecognisedTest(unittest.TestCase):
    """Each wording the board can refuse a settled run's abort with, read
    from its source, is one the client's pattern recognises."""

    @classmethod
    def setUpClass(cls):
        cls.core = load_client("python-crucible.py")._axi()

    def test_each_abort_refuser_holds_exactly_one_settled_run_refusal(self):
        counts = {name: len(templates)
                  for name, templates in settled_run_refusal_templates().items()}
        self.assertEqual(counts, {"resolveRunClose": 1, "handleRunAbort": 1},
                         "a 409 added to or removed from the abort route must "
                         "be classified here as a settled-run refusal or not")

    def test_each_settled_run_refusal_the_board_can_give_an_abort_matches_the_clients_pattern(self):
        refusals = rendered_settled_run_refusals()
        self.assertEqual([label for label, _ in refusals],
                         [f"resolveRunClose, run {state}" for state in _settled_states()]
                         + ["handleRunAbort"],
                         f"each refusal, once per state it names: {refusals!r}")
        for label, error in refusals:
            with self.subTest(refusal=label):
                self.assertIn(f"run {SAMPLE_RUN_ID}", error)
                self.assertIsNotNone(
                    self.core._SETTLED_ABORT_REFUSAL.search(error),
                    f"the client's settled-abort pattern "
                    f"{self.core._SETTLED_ABORT_REFUSAL.pattern!r} does not "
                    f"match the board's refusal {error!r}, so a run the board "
                    f"may hold would be reported left open")


if __name__ == "__main__":
    unittest.main()
