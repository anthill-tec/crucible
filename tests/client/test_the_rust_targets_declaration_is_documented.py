"""The `[targets.<profile>]` declaration a rust run reads is documented
where its readers look.

  - The shipped `clients/crucible.toml` documents the table as the one
    vocabulary every stack uses: its fields (`framework`, `stream` with its
    `codec` and `path`), the rust entry (`framework = "nextest"`, `stream =
    { codec = "nextest", path = "stdout" }`), that only a project's own file
    declares, the default for an undeclared profile, that bun's
    `crucible.targets` uses the same vocabulary, and the standard rust
    profiles `default`, `ci` and `e2e` with what each selects.
  - The rust client's help names the table and the minimum nextest, 0.9.130.
  - A "Stack declaration changes" subsection of the changelog names, for
    rust: the table, the rust entry, the standard profiles, that undeclared
    profiles stream by default, the minimum nextest and the retirement of
    `--ignore-run-fail`. Every release's subsection of that name is searched,
    so a later one never hides the one that records it.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_rust_targets_declaration_is_documented
"""

import re
import subprocess
import sys
import unittest
from pathlib import Path

import tomllib

from tests.client.changelog_section import changelog_entries
from tests.client import CLIENT_SOURCE_DIR, client_script

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIPPED_TOML = CLIENT_SOURCE_DIR / "crucible.toml"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
RUST_CLIENT = client_script("rust-crucible.py")

TABLE = "[targets.<profile>]"
RUST_ENTRY = (r'framework\s*=\s*"nextest"', r'codec\s*=\s*"nextest"', r'path\s*=\s*"stdout"')


def _targets_section(text):
    """The shipped file's lines from the first that names the table to the
    next table that is not a `targets` one."""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if TABLE in line), None)
    if start is None:
        return ""
    end = next((i for i in range(start + 1, len(lines))
                if re.match(r"^\[(?!targets)", lines[i])), len(lines))
    return "\n".join(lines[start:end])


def _stack_declaration_sections(text):
    """Every `### Stack declaration changes` subsection of the changelog's
    release sections, newest first, each one release's own."""
    return re.findall(r"(?ms)^### Stack declaration changes\n(.*?)(?=^### |\Z)",
                      changelog_entries(text))


def _rust_part(section):
    """The section's paragraph(s) for the rust stack: from the line that
    introduces the rust stack to the next `For the <stack>` line."""
    found = re.search(r"(?ms)^For the rust stack.*?(?=^For the |\Z)", section)
    return found.group(0) if found else ""


class TheShippedCrucibleTomlDocumentsTheTargetsTableTest(unittest.TestCase):

    def setUp(self):
        self.text = SHIPPED_TOML.read_text(encoding="utf-8")
        self.section = _targets_section(self.text)

    def test_the_shipped_file_still_parses(self):
        tomllib.loads(self.text)

    def test_it_names_the_table_and_its_fields(self):
        self.assertIn(TABLE, self.text)
        for field in ("framework", "stream", "codec", "path", '"stdout"'):
            self.assertIn(field, self.section, f"the table's documentation names {field}")

    def test_it_documents_the_rust_entry(self):
        for pattern in RUST_ENTRY:
            self.assertRegex(self.section, pattern)

    def test_it_says_only_a_projects_own_file_declares(self):
        self.assertRegex(self.section, r"(?i)project'?s own")
        self.assertRegex(self.section, r"(?i)install")

    def test_it_documents_the_default_for_an_undeclared_profile(self):
        self.assertRegex(self.section, r"(?i)(no entry|undeclared|not declared)")

    def test_it_says_bun_uses_the_same_vocabulary(self):
        self.assertIn("crucible.targets", self.section)

    def test_it_names_the_standard_rust_profiles_and_what_each_selects(self):
        for profile in ("default", "ci", "e2e"):
            self.assertRegex(self.section, rf"\b{profile}\b", f"names the {profile} profile")
        self.assertRegex(self.section, r"(?i)docker",
                         "says which tier each standard profile selects or excludes")


class TheRustClientsHelpNamesTheTableTest(unittest.TestCase):

    def test_the_help_names_the_table_and_the_minimum_nextest(self):
        result = subprocess.run([sys.executable, str(RUST_CLIENT), "--help"],
                                capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        help_text = " ".join(result.stdout.split())
        self.assertIn(TABLE, help_text)
        self.assertIn("0.9.130", help_text)


class TheChangelogsStackDeclarationChangesNameTheRustTableTest(unittest.TestCase):

    def setUp(self):
        self.sections = _stack_declaration_sections(CHANGELOG.read_text(encoding="utf-8"))
        self.rust = "\n".join(part for part in map(_rust_part, self.sections) if part)

    def test_the_unreleased_entry_carries_the_section_with_a_rust_part(self):
        self.assertTrue(any(section.strip() for section in self.sections),
                        "the changelog has a Stack declaration changes section")
        self.assertTrue(self.rust, "the section has a part for the rust stack")

    def test_the_rust_part_names_the_table_and_the_rust_entry(self):
        self.assertIn(TABLE, self.rust)
        for pattern in RUST_ENTRY:
            self.assertRegex(self.rust, pattern)

    def test_the_rust_part_names_the_standard_profiles(self):
        for profile in ("default", "ci", "e2e"):
            self.assertRegex(self.rust, rf"`{profile}`")

    def test_the_rust_part_says_undeclared_profiles_stream_by_default(self):
        self.assertRegex(self.rust, r"(?i)(undeclared|no entry|not declared)")
        self.assertRegex(self.rust, r"(?i)stream")

    def test_the_rust_part_names_the_minimum_nextest(self):
        self.assertIn("0.9.130", self.rust)

    def test_the_rust_part_names_the_retirement_of_ignore_run_fail(self):
        self.assertIn("--ignore-run-fail", self.rust)


if __name__ == "__main__":
    unittest.main()
