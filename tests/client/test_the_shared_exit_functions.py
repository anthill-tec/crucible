"""The two shared functions every client's exit is decided by.

`runner_exit_code(returncode)` turns a `subprocess` return code into the exit
a shell reports — a signal (a negative return code) becomes `128 + <signal>`,
so a runner killed by SIGKILL is `137` — and leaves every ordinary exit as it
is. `verb_exit(runner_exit, response)` is what a verb that ran a test runner
returns: non-zero when the runner exited non-zero, when the ingest response is
not `ok` (refused, unreachable, too large), or when the response's
`run.failed` is above 0; zero only when none of the three holds.

Both live in `clients/_crucible_axi.py`, loaded here by path the way every
client loads it.

Invocation:
    python3 -m unittest tests.client.test_the_shared_exit_functions -v
"""

import signal
import unittest

from tests.client.live_run_harness import load_client

AXI = load_client("_crucible_axi.py")

GREEN_RESPONSE = {"ok": True, "changed": True, "event": "evt-1",
                  "run": {"total": 3, "passed": 3, "failed": 0, "pending": 0}}


class RunnerExitCodeTest(unittest.TestCase):
    """`runner_exit_code` maps a subprocess return code to a shell's exit."""

    def test_an_ordinary_exit_is_returned_unchanged(self):
        for code in (0, 1, 100):
            with self.subTest(returncode=code):
                self.assertEqual(AXI.runner_exit_code(code), code)

    def test_a_runner_killed_by_sigkill_exits_137(self):
        self.assertEqual(AXI.runner_exit_code(-9), 137)

    def test_every_signal_becomes_128_plus_its_number(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGSEGV):
            with self.subTest(signal=signum.name):
                self.assertEqual(AXI.runner_exit_code(-int(signum)),
                                 128 + int(signum))

    def test_the_mapped_exit_is_never_negative(self):
        for code in (-1, -9, -15, 0, 2):
            with self.subTest(returncode=code):
                self.assertGreaterEqual(AXI.runner_exit_code(code), 0)


class VerbExitTest(unittest.TestCase):
    """`verb_exit` is non-zero exactly when the runner failed, the ingest was
    not `ok`, or the filed run records a failure."""

    def test_a_clean_runner_and_a_green_filed_run_exit_zero(self):
        self.assertEqual(AXI.verb_exit(0, GREEN_RESPONSE), 0)

    def test_an_ok_response_without_a_run_and_a_clean_runner_exit_zero(self):
        self.assertEqual(AXI.verb_exit(0, {"ok": True, "changed": True}), 0)

    def test_a_runner_that_exited_non_zero_over_a_green_run_is_non_zero(self):
        for code in (1, 2, 137):
            with self.subTest(runner_exit=code):
                self.assertNotEqual(AXI.verb_exit(code, GREEN_RESPONSE), 0)

    def test_a_refused_ingest_after_a_clean_runner_is_non_zero(self):
        refused = {"ok": False,
                   "error": "runnerExit must be a non-negative integer — run NOT stored"}
        self.assertNotEqual(AXI.verb_exit(0, refused), 0)

    def test_an_unreachable_board_after_a_clean_runner_is_non_zero(self):
        unreachable = {"ok": False, "error": "connection refused"}
        self.assertNotEqual(AXI.verb_exit(0, unreachable), 0)

    def test_a_too_large_ingest_after_a_clean_runner_is_non_zero(self):
        too_large = {"ok": False, "status": 413, "error": "payload too large"}
        self.assertNotEqual(AXI.verb_exit(0, too_large), 0)

    def test_a_filed_run_with_a_failure_after_a_clean_runner_is_non_zero(self):
        failed = {"ok": True, "changed": True,
                  "run": {"total": 3, "passed": 2, "failed": 1, "pending": 0}}
        self.assertNotEqual(AXI.verb_exit(0, failed), 0)

    def test_the_boards_added_runner_case_makes_the_verb_non_zero(self):
        # The board answered with the `runner / exit 1` case counted in.
        answered = {"ok": True, "changed": True,
                    "run": {"total": 4, "passed": 3, "failed": 1, "pending": 0}}
        self.assertNotEqual(AXI.verb_exit(1, answered), 0)

    def test_pending_cases_alone_do_not_make_the_verb_non_zero(self):
        pending = {"ok": True, "changed": True,
                   "run": {"total": 3, "passed": 1, "failed": 0, "pending": 2}}
        self.assertEqual(AXI.verb_exit(0, pending), 0)

    def test_the_exit_is_an_int(self):
        self.assertIsInstance(AXI.verb_exit(0, GREEN_RESPONSE), int)
        self.assertIsInstance(AXI.verb_exit(1, GREEN_RESPONSE), int)


if __name__ == "__main__":
    unittest.main()
