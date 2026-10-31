"""Every verdict one plain test can earn, and a test whose tearDown fails.

The test methods carry comments, never docstrings: unittest prints a test's
docstring beside its name, and the console must read the same in every run.
"""
import unittest

from pkg.arith import add, divide


class TearDownFailureTest(unittest.TestCase):

    def tearDown(self):
        raise RuntimeError("tearDown could not release the resource")

    def test_body_passes_but_teardown_fails(self):
        # The body passes; the tearDown error makes the case an error.
        self.assertEqual(add(1, 2), 3)


class VerdictsTest(unittest.TestCase):

    def test_adds_two_numbers(self):
        # Passes.
        self.assertEqual(add(2, 3), 5)

    def test_adds_with_a_wrong_expectation(self):
        # Fails: an assertion.
        self.assertEqual(add(2, 2), 5)

    def test_divides_by_zero(self):
        # Errors: an exception raised in the package under test.
        divide(1, 0)

    @unittest.skip("the platform lacks the feature")
    def test_is_skipped(self):
        self.fail("a skipped test never runs")

    @unittest.expectedFailure
    def test_is_expected_to_fail(self):
        # Fails as it is expected to: an expected failure.
        self.assertEqual(add(1, 1), 3)

    @unittest.expectedFailure
    def test_succeeds_unexpectedly(self):
        # Passes though it is expected to fail: an unexpected success.
        self.assertEqual(add(1, 1), 2)


if __name__ == "__main__":
    unittest.main()
