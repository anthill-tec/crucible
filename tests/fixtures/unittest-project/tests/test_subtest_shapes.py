"""Subtests in every shape CR-CRU-189's counting rule names.

* every subtest passes: each subtest is a case, the parent is not;
* one subtest fails: the failing one and the passing one are each a case;
* nested subtests: each innermost subtest is a case, the enclosing one is not;
* the parent's own body fails after its subtests pass: a case of its own;
* subtests under ``@expectedFailure``: the test is counted as a whole.
"""
import unittest

from pkg.arith import add


class SubtestShapesTest(unittest.TestCase):

    def test_body_fails_after_its_subtests_pass(self):
        for n in (1, 2):
            with self.subTest(n=n):
                self.assertEqual(add(n, 0), n)
        self.fail("the body failed after every subtest passed")

    def test_every_subtest_passes(self):
        for n in (1, 2, 3):
            with self.subTest(n=n):
                self.assertEqual(add(n, 0), n)

    @unittest.expectedFailure
    def test_expected_failure_with_subtests(self):
        for n in (1, 2):
            with self.subTest(n=n):
                self.assertEqual(n, 1)

    def test_nested_subtests(self):
        for group in ("even", "odd"):
            with self.subTest(group=group):
                for n in (1, 2):
                    with self.subTest(n=n):
                        self.assertFalse(group == "odd" and n == 2,
                                         "the odd group's second case failed")

    def test_one_subtest_fails(self):
        for n in (1, 2):
            with self.subTest(n=n):
                self.assertEqual(add(n, n), 4)


if __name__ == "__main__":
    unittest.main()
