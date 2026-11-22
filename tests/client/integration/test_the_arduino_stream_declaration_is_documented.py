"""The arduino client's root `--help` states its stream make contract.

The make contract states `CRUCIBLE_STREAM` (the run's
`crucible-events.ndjson`), the `test-end` line's shape and its statuses
(`pass`, `fail`, `pending`), the append, one-write and flush rule, that the
harness writes no `run-start` and no `run-end`, and that an unset variable
means the harness writes nothing.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_arduino_stream_declaration_is_documented
"""

import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.client import client_script

ARDUINO_CLIENT = client_script("arduino-crucible.py")


def _plain(text):
    """Lower-cased, backticks dropped, whitespace runs collapsed."""
    return " ".join(text.replace("`", "").lower().split())


def _root_description():
    """The root `--help` up to its verb list: the description, make contract
    included."""
    scratch = tempfile.mkdtemp(prefix="arduino-stream-contract-help-", dir="/tmp")
    try:
        result = subprocess.run([sys.executable, str(ARDUINO_CLIENT), "--help"], cwd=scratch,
                                capture_output=True, text=True, timeout=60, check=False)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    if result.returncode != 0:
        raise AssertionError(f"--help exited {result.returncode}: {result.stderr[-800:]!r}")
    return result.stdout.split("positional arguments:", 1)[0]


class TheHelpsMakeContractStatesTheStreamTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        description = _root_description()
        start = description.find("CRUCIBLE_STREAM")
        cls.found = start >= 0
        cls.segment = description[start:] if start >= 0 else ""
        cls.plain = _plain(cls.segment)
        cls.squeezed = re.sub(r"\s+", "", cls.segment)

    def test_the_make_contract_names_crucible_stream_and_its_file(self):
        self.assertTrue(self.found, "the root --help names CRUCIBLE_STREAM")
        self.assertIn("crucible-events.ndjson", self.segment)

    def test_it_shows_the_test_end_line_shape(self):
        for key in ('"event":"test-end"', '"suite":', '"name":', '"status":',
                    '"duration_ms":', '"failure":{"message":'):
            self.assertIn(key, self.squeezed, f"the test-end line shows {key}")

    def test_it_names_the_three_statuses(self):
        for status in ("pass", "fail", "pending"):
            self.assertRegex(self.plain, rf"\b{status}\b", f"the statuses include {status}")

    def test_it_states_the_append_one_write_and_flush_rule(self):
        self.assertRegex(self.plain, r"\bappend")
        self.assertRegex(self.plain, r"\b(one|single) write\b")
        self.assertRegex(self.plain, r"\bflush")

    def test_it_says_the_harness_writes_no_run_start_and_no_run_end(self):
        self.assertRegex(self.plain, r"\b(no|never|neither)\b[^.]{0,40}run-start")
        self.assertIn("run-end", self.plain)

    def test_it_says_an_unset_variable_means_write_nothing(self):
        self.assertRegex(self.plain,
                         r"unset[^.]{0,80}\bwrites? nothing|\bwrites? nothing[^.]{0,80}unset")


if __name__ == "__main__":
    unittest.main()
