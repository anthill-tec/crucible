"""xmlrunner has left the python client.

- the python client's help for a unittest run names no xmlrunner;
- the unittest `subtests-uncounted` warning is gone (pytest's warning stays).
"""

import subprocess
import sys
import unittest
from pathlib import Path
from tests.client import TEST_INSTALL_CLIENTS

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from tests.client.live_run_harness import load_client

CLIENTS = TEST_INSTALL_CLIENTS


class TheClientsHelpAndWarningsDropXmlrunnerTest(unittest.TestCase):

    VERBS = ("test", "unit", "regression", "pre-merge-gate")

    def test_the_help_of_every_unittest_running_verb_names_no_xmlrunner(self):
        for verb in self.VERBS:
            with self.subTest(verb=verb):
                result = subprocess.run(
                    [sys.executable, str(CLIENTS / "python-crucible.py"), verb, "--help"],
                    capture_output=True, text=True, timeout=60, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("xmlrunner", result.stdout.lower(), result.stdout)

    def test_a_unittest_run_no_longer_warns_subtests_uncounted(self):
        client = load_client("python-crucible.py")
        fallback_line = ("[subtest-runner] subtests-uncounted: xmlrunner offers no "
                         "result class to extend (xmlrunner version: 4.0.0)\n")
        watch = client._FallbackWatch(None, client._UNITTEST)
        watch.observe(fallback_line)
        watch.observe("test_one (tests.test_x.Case.test_one) ... ok\n")
        self.assertEqual(watch.warnings(), [],
                         "the unittest subtests-uncounted warning is removed")

    def test_a_pytest_run_still_warns_subtests_uncounted(self):
        client = load_client("python-crucible.py")
        watch = client._FallbackWatch(None, client._PYTEST)
        watch.observe("tests/test_x.py::test_loop [i=0] SUBPASSED\n")
        self.assertEqual([w["code"] for w in watch.warnings()], ["subtests-uncounted"])


if __name__ == "__main__":
    unittest.main()
