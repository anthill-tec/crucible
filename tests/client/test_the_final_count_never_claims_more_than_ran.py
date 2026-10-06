"""The final count never claims more than ran.

`RunNarrator.finish()` posts `ran <counted>/<known M>`: the completions it
actually observed over the best-known total — never the declared total on
both sides of the slash, which is what a run that stopped short (a crash, a
runner that died, a prescan that over-counted) would otherwise claim. With no
known total it is `ran N/N`. A stack that counts something other than tests
names its unit after the count (mvn counts test classes: `running N/M
classes`, `ran N/M classes`).

And a verdict line that says a test ran is a completion, whatever the verdict:
nextest's SIGSEGV / TIMEOUT / ABORT lines and Unity's IGNORE lines are counted
by their stacks' recognisers like PASS and FAIL.
"""

import unittest

from tests.client.live_run_harness import load_client


def _always(_line):
    return True


class TheFinalCountIsWhatRanTest(unittest.TestCase):

    def setUp(self):
        self.axi = load_client("_crucible_axi.py")
        self.posted = []

    def _narrator(self, total, **kw):
        return self.axi.RunNarrator(self.posted.append, _always, total=total,
                                    min_seconds=999.0, min_completions=99, **kw)

    def test_a_run_that_stopped_short_reads_what_it_counted_over_the_known_total(self):
        narrator = self._narrator(5)
        for _ in range(3):
            narrator.observe("x\n")
        narrator.finish()
        self.assertEqual(self.posted, ["ran 3/5"])

    def test_a_dynamic_total_is_the_denominator_and_the_count_the_numerator(self):
        narrator = self._narrator(lambda: 9)
        for _ in range(4):
            narrator.observe("x\n")
        narrator.finish()
        self.assertEqual(self.posted, ["ran 4/9"])

    def test_an_unknown_total_reads_n_over_n(self):
        narrator = self._narrator(0)
        for _ in range(3):
            narrator.observe("x\n")
        narrator.finish()
        self.assertEqual(self.posted, ["ran 3/3"])

    def test_a_count_past_the_hint_never_reads_below_itself(self):
        narrator = self._narrator(2)
        for _ in range(3):
            narrator.observe("x\n")
        narrator.finish()
        self.assertEqual(self.posted, ["ran 3/3"])

    def test_a_named_unit_follows_the_count_in_flight_and_at_the_end(self):
        narrator = self.axi.RunNarrator(self.posted.append, _always, total=5,
                                        min_seconds=999.0, min_completions=2,
                                        unit="classes")
        for _ in range(3):
            narrator.observe("x\n")
        narrator.finish()
        self.assertEqual(self.posted, ["running 2/5 classes", "ran 3/5 classes"])


class EveryVerdictLineIsACompletionTest(unittest.TestCase):

    def test_nextest_counts_signal_timeout_and_abort_verdicts(self):
        rust = load_client("rust-crucible.py")
        progress = rust._NextestProgress()
        lines = [
            "    Starting 6 tests across 1 binary\n",
            "        PASS [   0.001s] crate tests::a\n",
            "        FAIL [   0.001s] crate tests::b\n",
            "     SIGSEGV [   0.002s] crate tests::c\n",
            "     TIMEOUT [  60.000s] crate tests::d\n",
            "       ABORT [   0.001s] crate tests::e\n",
            "     SIGABRT [   0.001s] crate tests::f\n",
            "------------\n",
            "     Summary [  60.010s] 6 tests run: 1 passed, 5 failed\n",
            "     SIGSEGV [   0.002s] crate tests::c\n",
            "     TIMEOUT [  60.000s] crate tests::d\n",
        ]
        counted = sum(1 for line in lines if progress.recognise(line))
        self.assertEqual(counted, 6, "every verdict before the summary is one test")
        self.assertEqual(progress.total, 6)

    def test_unity_counts_ignore_verdicts(self):
        arduino = load_client("arduino-crucible.py")
        recognise = arduino._recognise_completion
        self.assertTrue(recognise("test/test_main.c:12:test_a:PASS\n"))
        self.assertTrue(recognise("test/test_main.c:13:test_b:FAIL: expected 1\n"))
        self.assertTrue(recognise("test/test_main.c:14:test_c:IGNORE\n"))
        self.assertTrue(recognise("test/test_main.c:15:test_d:IGNORE: not yet\n"))
        self.assertFalse(recognise("3 Tests 1 Failures 1 Ignored\n"))


if __name__ == "__main__":
    unittest.main()
