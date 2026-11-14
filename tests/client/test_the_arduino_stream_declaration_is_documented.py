"""The arduino stream declaration and its make contract are written down
where their readers look.

  - The arduino client's root `--help` make contract states `CRUCIBLE_STREAM`
    (the run's `crucible-events.ndjson`), the `test-end` line's shape and its
    statuses (`pass`, `fail`, `pending`), the append, one-write and flush rule,
    that the harness writes no `run-start` and no `run-end`, and that an unset
    variable means the harness writes nothing.
  - The shipped `clients/crucible.toml` names the arduino entry in a comment:
    its `[targets."<dir>/<target>"]` key (native dir and make target) and its
    fields, `framework = "arduino-native"` and `stream = { codec =
    "crucible-events", path = "env:CRUCIBLE_STREAM" }`. It declares no live
    `targets` table.
  - The live-progress DN no longer calls arduino's runner one Crucible owns:
    it is the project's own harness, writing `crucible-events` under the
    `CRUCIBLE_STREAM` make contract.
  - A "Stack declaration changes" subsection of the changelog has an arduino
    part naming the declaration and the `CRUCIBLE_STREAM` make contract.
    Every release's subsection of that name is searched, so a later one never
    hides the one that records it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_arduino_stream_declaration_is_documented
"""

import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import tomllib

from tests.client.changelog_section import changelog_entries

REPO_ROOT = Path(__file__).resolve().parents[2]
ARDUINO_CLIENT = REPO_ROOT / "clients" / "arduino-crucible.py"
SHIPPED_TOML = REPO_ROOT / "clients" / "crucible.toml"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
DN = REPO_ROOT / "docs" / "research" / "DN-crucible-live-test-progress.md"

ENTRY_FIELDS = (r'framework\s*=\s*"arduino-native"', r'codec\s*=\s*"crucible-events"',
                r'path\s*=\s*"env:CRUCIBLE_STREAM"')
ENTRY_KEY = r'\[targets\."[^"\s]+/[^"\s]+"\]'


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


def _stack_declaration_sections(text):
    """Every `### Stack declaration changes` subsection of the changelog's
    release sections, newest first, each one release's own."""
    return re.findall(r"(?ms)^### Stack declaration changes\n(.*?)(?=^### |\Z)",
                      changelog_entries(text))


def _arduino_part(section):
    found = re.search(r"(?ms)^For the arduino stack.*?(?=^For the |\Z)", section)
    return found.group(0) if found else ""


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


class TheShippedCrucibleTomlNamesTheArduinoEntryTest(unittest.TestCase):

    def setUp(self):
        self.text = SHIPPED_TOML.read_text(encoding="utf-8")
        self.comments = "\n".join(line for line in self.text.splitlines()
                                  if line.lstrip().startswith("#"))

    def test_a_comment_shows_the_arduino_key_and_its_fields(self):
        self.assertRegex(self.comments, ENTRY_KEY, "a commented [targets.\"<dir>/<target>\"]")
        for pattern in ENTRY_FIELDS:
            self.assertRegex(self.comments, pattern)

    def test_the_comment_says_the_key_is_the_native_dir_and_make_target(self):
        at = self.comments.find("arduino-native")
        self.assertGreaterEqual(at, 0, "a comment names arduino-native")
        arduino = self.comments[max(at - 1500, 0):]
        self.assertRegex(_plain(arduino), r"make target")
        self.assertRegex(_plain(arduino), r"native dir")

    def test_the_shipped_file_parses_and_declares_no_live_target(self):
        self.assertNotIn("targets", tomllib.loads(self.text))


class TheDNSaysArduinosRunnerIsTheProjectsOwnTest(unittest.TestCase):

    def setUp(self):
        self.lines = DN.read_text(encoding="utf-8").splitlines()

    def test_no_line_calls_the_arduino_runner_crucibles_own(self):
        rows = [line for line in self.lines if re.match(r"^\|\s*arduino\s*\|", line)]
        self.assertEqual(len(rows), 1, "the DN's per-stack table keeps an arduino row")
        self.assertNotIn("ours", rows[0].lower(), "the arduino row no longer says ours to emit")
        owned = [line for line in self.lines
                 if re.search(r"(?i)arduino runners?\s+crucible owns", line)]
        self.assertEqual(owned, [], "no line lists arduino among the runners Crucible owns")

    def test_it_says_arduinos_runner_is_the_projects_own_harness_under_crucible_stream(self):
        said = [line for line in self.lines if "arduino" in line.lower()
                and re.search(r"project['\u2019]s own", line)]
        self.assertTrue(said, "a DN line says arduino's runner is the project's own")
        self.assertTrue(any("CRUCIBLE_STREAM" in line for line in self.lines),
                        "the DN names the CRUCIBLE_STREAM make contract")


class TheChangelogNamesTheArduinoDeclarationTest(unittest.TestCase):

    def setUp(self):
        parts = map(_arduino_part, _stack_declaration_sections(
            CHANGELOG.read_text(encoding="utf-8")))
        self.arduino = "\n".join(part for part in parts if part)

    def test_the_stack_declaration_changes_have_an_arduino_part(self):
        self.assertTrue(self.arduino,
                        "the changelog's Stack declaration changes: For the arduino stack")

    def test_the_arduino_part_names_the_declaration(self):
        self.assertRegex(self.arduino, ENTRY_KEY)
        for pattern in ENTRY_FIELDS:
            self.assertRegex(self.arduino, pattern)

    def test_the_arduino_part_names_the_crucible_stream_make_contract(self):
        self.assertRegex(self.arduino, r"`CRUCIBLE_STREAM`")
        self.assertIn("test-end", self.arduino)


if __name__ == "__main__":
    unittest.main()
