"""The eda client's verdict on a run the board answered the filing of: a run
not filed with its counts is `fail`, never `pass`.

`_filed_verdict(resp)` in `clients/eda-crucible.py` is driven in-process on
board answers written here, the client loaded by path as the other client
unit tests load theirs:

- an `ok` answer with no `run` block, an empty one, or one without its
  passed or failed count is `fail`;
- an answer that is not `ok`, or none at all, is `fail`;
- a filed failure is `fail`, a run of skips alone is `skip`, and a run with
  a pass and no failure is `pass` (a missing pending count is no skip).

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_an_eda_run_filed_without_counts_is_a_fail
"""

import unittest

from tests.client.live_run_harness import load_client

_LOADED = {}


def _filed_verdict(resp):
    """The eda client's `_filed_verdict`, its client loaded once."""
    if "eda" not in _LOADED:
        _LOADED["eda"] = load_client("eda-crucible.py")
    return _LOADED["eda"]._filed_verdict(resp)


class ARunFiledWithoutCountsIsAFailTest(unittest.TestCase):

    def test_an_ok_answer_with_no_run_block_is_a_fail(self):
        self.assertEqual(_filed_verdict({"ok": True, "event": "evt-1"}), "fail")

    def test_an_ok_answer_with_an_empty_run_block_is_a_fail(self):
        self.assertEqual(_filed_verdict({"ok": True, "run": {}}), "fail")

    def test_an_ok_answer_without_its_passed_count_is_a_fail(self):
        self.assertEqual(_filed_verdict({"ok": True, "run": {"failed": 0, "pending": 3}}),
                         "fail")

    def test_an_ok_answer_without_its_failed_count_is_a_fail(self):
        self.assertEqual(_filed_verdict({"ok": True, "run": {"passed": 2, "pending": 0}}),
                         "fail")

    def test_an_ok_answer_whose_counts_are_not_numbers_is_a_fail(self):
        self.assertEqual(_filed_verdict({"ok": True, "run": {"passed": "2", "failed": None}}),
                         "fail")

    def test_an_answer_not_ok_or_none_is_a_fail(self):
        self.assertEqual(_filed_verdict({"ok": False, "error": "refused"}), "fail")
        self.assertEqual(_filed_verdict(None), "fail")


class ARunFiledWithCountsIsJudgedOnThemTest(unittest.TestCase):

    def test_a_filed_failure_is_a_fail(self):
        self.assertEqual(_filed_verdict(
            {"ok": True, "run": {"passed": 2, "failed": 1, "pending": 1}}), "fail")

    def test_a_run_of_skips_alone_is_a_skip(self):
        self.assertEqual(_filed_verdict(
            {"ok": True, "run": {"passed": 0, "failed": 0, "pending": 2}}), "skip")

    def test_a_run_with_a_pass_and_no_failure_is_a_pass(self):
        self.assertEqual(_filed_verdict(
            {"ok": True, "run": {"passed": 2, "failed": 0, "pending": 1}}), "pass")

    def test_a_missing_pending_count_is_no_skip(self):
        self.assertEqual(_filed_verdict({"ok": True, "run": {"passed": 0, "failed": 0}}),
                         "pass")


if __name__ == "__main__":
    unittest.main()
