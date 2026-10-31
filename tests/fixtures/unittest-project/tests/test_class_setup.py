"""A class whose ``setUpClass`` raises, after a healthy class in the same module.

The healthy class sorts first, so it runs first: the ``setUpClass`` error is
reported by unittest as an error holder (``unittest.suite._ErrorHolder``), and
the test it guards never runs.
"""
import unittest

from pkg.arith import add


class AHealthyNeighbourTest(unittest.TestCase):

    def test_runs_before_the_broken_class(self):
        self.assertEqual(add(0, 0), 0)


class BrokenSetUpClassTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        raise ConnectionError("the shared fixture server never came up")

    def test_never_runs(self):
        self.fail("setUpClass failed, so this never runs")


if __name__ == "__main__":
    unittest.main()
