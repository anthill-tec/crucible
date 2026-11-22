"""The rust client's help names the `[targets.<profile>]` declaration a rust
run reads, and the minimum nextest, 0.9.130.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_rust_targets_declaration_is_documented
"""

import subprocess
import sys
import unittest

from tests.client import client_script

RUST_CLIENT = client_script("rust-crucible.py")

TABLE = "[targets.<profile>]"


class TheRustClientsHelpNamesTheTableTest(unittest.TestCase):

    def test_the_help_names_the_table_and_the_minimum_nextest(self):
        result = subprocess.run([sys.executable, str(RUST_CLIENT), "--help"],
                                capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        help_text = " ".join(result.stdout.split())
        self.assertIn(TABLE, help_text)
        self.assertIn("0.9.130", help_text)


if __name__ == "__main__":
    unittest.main()
