"""The maven console declaration is written down where its readers look.

  - A "Stack declaration changes" subsection of the changelog has a maven
    part naming the declaration (`[targets.<tier>]`, `framework =
    "surefire"`, `console = "surefire-console"`) and the `surefire-console`
    view codec. Every release's subsection of that name is searched, so a
    later one never hides the one that records it.
  - The shipped `clients/crucible.toml` names the maven entry in a comment:
    its `[targets.<tier>]` key and its fields. It still declares no live
    `targets` table.
  - The maven client's root `--help` names the declaration.
  - The live-progress DN's console-only row names `surefire-console` for
    maven, beside `bun-console` for `bun test`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_maven_console_declaration_is_documented
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
from tests.client import CLIENT_SOURCE_DIR, client_script

REPO_ROOT = Path(__file__).resolve().parents[2]
MVN_CLIENT = client_script("mvn-crucible.py")
SHIPPED_TOML = CLIENT_SOURCE_DIR / "crucible.toml"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
DN = REPO_ROOT / "docs" / "research" / "DN-crucible-live-test-progress.md"

TABLE = "[targets.<tier>]"
ENTRY_FIELDS = (r'framework\s*=\s*"surefire"', r'console\s*=\s*"surefire-console"')
VIEW_CODEC = "surefire-console"


def _stack_declaration_sections(text):
    """Every `### Stack declaration changes` subsection of the changelog's
    release sections, newest first, each one release's own."""
    return re.findall(r"(?ms)^### Stack declaration changes\n(.*?)(?=^### |\Z)",
                      changelog_entries(text))


def _maven_part(section):
    """The section's paragraph(s) for the maven stack: from the line that
    introduces it to the next `For the <stack>` line."""
    found = re.search(r"(?ms)^For the (?:maven|mvn) stack.*?(?=^For the |\Z)", section)
    return found.group(0) if found else ""


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


class TheChangelogNamesTheMavenDeclarationTest(unittest.TestCase):

    def setUp(self):
        parts = map(_maven_part, _stack_declaration_sections(
            CHANGELOG.read_text(encoding="utf-8")))
        self.maven = "\n".join(part for part in parts if part)

    def test_the_stack_declaration_changes_have_a_maven_part(self):
        self.assertTrue(self.maven,
                        "the changelog's Stack declaration changes: For the maven stack")

    def test_the_maven_part_names_the_declaration(self):
        self.assertIn(TABLE, self.maven)
        for pattern in ENTRY_FIELDS:
            self.assertRegex(self.maven, pattern)

    def test_the_maven_part_names_the_surefire_console_view_codec(self):
        self.assertIn(f"`{VIEW_CODEC}`", self.maven)
        self.assertRegex(self.maven, r"(?i)view codec")


class TheShippedCrucibleTomlNamesTheMavenEntryTest(unittest.TestCase):

    def setUp(self):
        self.text = SHIPPED_TOML.read_text(encoding="utf-8")
        self.comments = "\n".join(line for line in self.text.splitlines()
                                  if line.lstrip().startswith("#"))

    def test_a_comment_shows_the_maven_key_and_its_fields(self):
        self.assertIn(TABLE, self.comments, "a commented [targets.<tier>]")
        for pattern in ENTRY_FIELDS:
            self.assertRegex(self.comments, pattern)

    def test_the_shipped_file_parses_and_declares_no_live_target(self):
        self.assertNotIn("targets", tomllib.loads(self.text))


class TheMavenClientsHelpNamesTheDeclarationTest(unittest.TestCase):

    def test_the_root_help_names_the_table_and_its_fields(self):
        help_text = _root_help()
        self.assertIn(TABLE, help_text)
        for pattern in ENTRY_FIELDS:
            self.assertRegex(help_text, pattern)


class TheDNsConsoleOnlyRowNamesSurefireConsoleTest(unittest.TestCase):

    def test_the_console_only_row_names_surefire_console_for_maven(self):
        rows = [line for line in DN.read_text(encoding="utf-8").splitlines()
                if re.match(r"^\|\s*Console only", line)]
        self.assertEqual(len(rows), 1, "the DN keeps one console-only row")
        row = rows[0] if rows else ""
        self.assertIn("maven", row)
        self.assertIn("bun-console", row, "bun's codec stays named")
        self.assertIn(VIEW_CODEC, row, "the console-only row names surefire-console")


if __name__ == "__main__":
    unittest.main()
