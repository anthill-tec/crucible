"""The eda client reads each `SKIPPED` line of pytest's `-v` output as one
skipped test: its node id, and the reason inside the line's last
parenthesised group before the progress marker.

`_skipped_tests(output)` in `clients/eda-crucible.py` is driven in-process
on `-v` lines written here, the client loaded by path as the other client
unit tests load theirs:

- a node id holding spaces (`test_x[a b]`) is read whole, and never swallows
  the line's ` SKIPPED (`, even when the reason repeats it;
- a skip with no reason has `reason: None`, and an empty `()` the empty one;
- a reason holding `)` is read up to the last `)` before the marker;
- a progress marker of any width (`[  5%]`, `[ 50%]`, `[100%]`), or none, is
  never part of the reason;
- an `XFAIL` or `XPASS` line is no skip, and a `SKIPPED` line naming no
  `::` (a module, not a test) is not listed;
- a line ending in `\\r` is read as the same line without it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_an_eda_skip_line_names_its_test_and_reason
"""

import unittest

from tests.client.live_run_harness import load_client

_LOADED = {}

FILE = "tests/unit/check_board.py"


def _skipped_tests(output):
    """The eda client's `_skipped_tests`, its client loaded once."""
    if "eda" not in _LOADED:
        _LOADED["eda"] = load_client("eda-crucible.py")
    return _LOADED["eda"]._skipped_tests(output)


def skip(test, reason):
    return {"test": test, "reason": reason}


class ASkipLineNamesItsTestAndReasonTest(unittest.TestCase):

    def test_a_node_id_holding_spaces_is_read_whole(self):
        line = f"{FILE}::test_the_rail[5 V supply] SKIPPED (no rig)     [ 50%]"
        self.assertEqual(_skipped_tests(line),
                         [skip(f"{FILE}::test_the_rail[5 V supply]", "no rig")])

    def test_a_node_id_never_swallows_the_lines_skipped_marker(self):
        line = f"{FILE}::test_the_rail[a b] SKIPPED (was SKIPPED (twice)) [ 50%]"
        self.assertEqual(_skipped_tests(line),
                         [skip(f"{FILE}::test_the_rail[a b]", "was SKIPPED (twice)")])

    def test_a_skip_with_no_reason_has_reason_none(self):
        line = f"{FILE}::test_the_probe SKIPPED                          [100%]"
        self.assertEqual(_skipped_tests(line), [skip(f"{FILE}::test_the_probe", None)])

    def test_an_empty_reason_is_the_empty_string(self):
        line = f"{FILE}::test_the_probe SKIPPED ()   [ 10%]"
        self.assertEqual(_skipped_tests(line), [skip(f"{FILE}::test_the_probe", "")])

    def test_a_reason_holding_a_closing_parenthesis_is_read_to_the_last_one(self):
        line = f"{FILE}::test_the_rail SKIPPED (rail (5 V) not powered) [ 33%]"
        self.assertEqual(_skipped_tests(line),
                         [skip(f"{FILE}::test_the_rail", "rail (5 V) not powered")])

    def test_a_progress_marker_of_any_width_or_none_is_never_the_reason(self):
        lines = [f"{FILE}::test_a SKIPPED (r) [  5%]",
                 f"{FILE}::test_b SKIPPED (r)" + " " * 40 + "[ 50%]",
                 f"{FILE}::test_c SKIPPED (r) [100%]",
                 f"{FILE}::test_d SKIPPED (r)"]
        self.assertEqual(_skipped_tests("\n".join(lines)),
                         [skip(f"{FILE}::test_{name}", "r") for name in "abcd"])

    def test_an_xfail_or_xpass_line_is_no_skip(self):
        lines = [f"{FILE}::test_the_erc XFAIL (rule not written)  [ 50%]",
                 f"{FILE}::test_the_lvs XPASS (rule not written)   [100%]"]
        self.assertEqual(_skipped_tests("\n".join(lines)), [])

    def test_a_skipped_line_naming_no_test_is_not_listed(self):
        line = f"{FILE} SKIPPED (the probe library is absent)  [ 50%]"
        self.assertEqual(_skipped_tests(line), [])

    def test_a_line_ending_in_a_carriage_return_is_read_without_it(self):
        line = f"{FILE}::test_the_probe SKIPPED (no rig) [100%]\r"
        self.assertEqual(_skipped_tests(line), [skip(f"{FILE}::test_the_probe", "no rig")])

    def test_skips_are_listed_in_output_order_among_other_verdicts(self):
        output = "\n".join([
            f"{FILE}::test_one PASSED                     [ 25%]",
            f"{FILE}::test_two SKIPPED (second)           [ 50%]",
            f"{FILE}::test_three FAILED                   [ 75%]",
            f"{FILE}::test_four SKIPPED (fourth)          [100%]"])
        self.assertEqual(_skipped_tests(output),
                         [skip(f"{FILE}::test_two", "second"),
                          skip(f"{FILE}::test_four", "fourth")])


if __name__ == "__main__":
    unittest.main()
