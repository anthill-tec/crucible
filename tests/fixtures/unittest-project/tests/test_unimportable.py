"""A module that fails to load: it imports a module the package does not have.

unittest reports it as one failing case of ``unittest.loader._FailedTest``,
named after this module. The import is made through ``importlib`` so that a
static checker reads no unresolvable import statement; loading the module
still raises ``ModuleNotFoundError``, which is the point of this module.
"""
import importlib
import unittest

importlib.import_module("pkg.not_a_module")


class NeverLoadedTest(unittest.TestCase):

    def test_never_loads(self):
        self.fail("this module never loads")


if __name__ == "__main__":
    unittest.main()
