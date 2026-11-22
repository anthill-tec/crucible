"""The maven client's root `--help` names the maven console declaration:
`[targets.<tier>]`, `framework = "surefire"` and
`console = "surefire-console"`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_maven_console_declaration_is_documented
"""

import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.client import client_script

MVN_CLIENT = client_script("mvn-crucible.py")

TABLE = "[targets.<tier>]"
ENTRY_FIELDS = (r'framework\s*=\s*"surefire"', r'console\s*=\s*"surefire-console"')


def _root_help():
    scratch = tempfile.mkdtemp(prefix="mvn-console-declaration-help-", dir="/tmp")
    try:
        result = subprocess.run([sys.executable, str(MVN_CLIENT), "--help"], cwd=scratch,
                                capture_output=True, text=True, timeout=60, check=False)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    if result.returncode != 0:
        raise AssertionError(f"--help exited {result.returncode}: {result.stderr[-800:]!r}")
    return " ".join(result.stdout.split())


class TheMavenClientsHelpNamesTheDeclarationTest(unittest.TestCase):

    def test_the_root_help_names_the_table_and_its_fields(self):
        help_text = _root_help()
        self.assertIn(TABLE, help_text)
        for pattern in ENTRY_FIELDS:
            self.assertRegex(help_text, pattern)


if __name__ == "__main__":
    unittest.main()
