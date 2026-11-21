"""Discover and run a python test directory, telling the dependency hook which
test is running.

    PYTHONPATH=scripts/hermetic/hooks HERMETIC_EVENTS=<abs path> \\
        .venv/bin/python scripts/hermetic/tagging_runner.py <start-dir>

Discovers <start-dir> with the repository root as top level (`-t .`; run it
from the root). Before each test it sets $HERMETIC_TEST to
`<test file>::<test id>` — inherited by every child process the test spawns —
and resets it to `-` after. Exits as `unittest` does: 0 when every test
passed, 1 otherwise.
"""

import inspect
import os
import sys
import unittest


def _charge(test: unittest.TestCase) -> str:
    try:
        path = os.path.relpath(inspect.getfile(type(test)))
    except TypeError:
        path = "-"
    return f"{path}::{test.id()}"


class TaggingResult(unittest.TextTestResult):
    """A text result that names the running test in the environment."""

    def startTest(self, test: unittest.TestCase) -> None:
        os.environ["HERMETIC_TEST"] = _charge(test)
        super().startTest(test)

    def stopTest(self, test: unittest.TestCase) -> None:
        super().stopTest(test)
        os.environ["HERMETIC_TEST"] = "-"


class TaggingRunner(unittest.TextTestRunner):
    """A text runner whose result is a TaggingResult."""

    def _makeResult(self) -> unittest.TextTestResult:
        return TaggingResult(self.stream, self.descriptions, self.verbosity)


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        sys.stderr.write("usage: tagging_runner.py <start-dir>\n")
        sys.exit(2)
    os.environ["HERMETIC_TEST"] = "-"
    unittest.main(module=None, argv=["tagging_runner", "discover", "-s", argv[1], "-t", "."],
                  testRunner=TaggingRunner)


if __name__ == "__main__":
    main(sys.argv)
