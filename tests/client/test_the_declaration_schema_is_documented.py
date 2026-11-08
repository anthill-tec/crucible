"""The shipped declaration schema is written down where its readers look.

  - The CHANGELOG's `[Unreleased]` "Stack declaration changes" names the schema
    file `crucible-declaration.schema.json`, its installed path
    (`<target-dir>/clients/crucible-declaration.schema.json`) and its version,
    which must equal the shipped file's own `version`.
  - The same section states the writer rule: a writer writes the stacks and
    fields it knows, warns on a newer schema version, never removes a field it
    does not know, and with no schema writes nothing it cannot check.
  - The rust part names rust's new skip of another stack's `[targets]` entry.
  - `go-test` joining the arduino and maven skip sets is named.
  - README and `docs/RUNBOOK.md` name the manifest's `declaration_schema` key.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_declaration_schema_is_documented
"""

import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
README = REPO_ROOT / "README.md"
RUNBOOK = REPO_ROOT / "docs" / "RUNBOOK.md"
SCHEMA_NAME = "crucible-declaration.schema.json"
SHIPPED_SCHEMA = REPO_ROOT / "clients" / SCHEMA_NAME
INSTALLED_PATH = re.compile(r"(?:<target-dir>|~/\.crucible)/clients/" + re.escape(SCHEMA_NAME))

def _phrase(words):
    """A phrase as a pattern that survives the CHANGELOG's line wrapping."""
    return r"\s+".join(re.escape(word) for word in words.split())


WRITER_RULE = (
    ("writes the stacks and fields it knows",
     rf"(?is)(?:{_phrase('stacks and fields it knows')}|{_phrase('known stacks and fields')})"),
    ("warns on a newer schema version",
     r"(?is)(?:newer[^.]{0,160}\bwarn|\bwarn[^.]{0,160}newer)"),
    ("never removes a field it does not know",
     rf"(?is)never\s+removes?\b[^.]{{0,40}}"
     rf"(?:fields?\s+{_phrase('it does not know')}|unknown\s+fields?)"),
    ("with no schema, writes nothing it cannot check",
     rf"(?is)(?:{_phrase('no schema')}[^.]{{0,200}}{_phrase('nothing it cannot check')}"
     rf"|{_phrase('nothing it cannot check')}[^.]{{0,200}}{_phrase('no schema')})"),
)

OTHER_STACK_SKIP = re.compile(
    r"(?is)(?:\b(?:another|other)\s+stack(?:'s|s'|s)?\b[^.]{0,120}\bskip"
    r"|\bskip\w*\b[^.]{0,120}\b(?:another|other)\s+stack)")


def _unreleased_stack_section(text):
    unreleased = text.split("## [Unreleased]", 1)
    if len(unreleased) < 2:
        return ""
    body = re.split(r"(?m)^## \[", unreleased[1], maxsplit=1)[0]
    found = re.search(r"(?ms)^### Stack declaration changes\n(.*?)(?=^### |\Z)", body)
    return found.group(1) if found else ""


def _stack_part(section, *names):
    """The paragraph(s) for one stack: from its `For the <stack> stack` line to
    the next `For the ` line."""
    alternatives = "|".join(re.escape(name) for name in names)
    found = re.search(rf"(?ms)^For the (?:{alternatives}) stack.*?(?=^For the |\Z)", section)
    return found.group(0) if found else ""


def _schema_part(section):
    """From the line that first names the schema file to the next `For the `
    line, or to the end of the section."""
    at = section.find(SCHEMA_NAME)
    if at < 0:
        return ""
    start = section.rfind("\n", 0, at) + 1
    following = re.compile(r"(?m)^For the ").search(section, at)
    return section[start:following.start() if following else len(section)]


def _blocks(text):
    """Paragraphs and top-level bullets, each as one string."""
    return [block for block in re.split(r"\n\s*\n|\n(?=- )", text) if block.strip()]


def _shipped_version():
    return json.loads(SHIPPED_SCHEMA.read_text(encoding="utf-8"))["version"]


class TheChangelogNamesTheDeclarationSchemaTest(unittest.TestCase):

    def setUp(self):
        self.section = _unreleased_stack_section(CHANGELOG.read_text(encoding="utf-8"))
        self.schema = _schema_part(self.section)

    def test_the_section_names_the_schema_file(self):
        self.assertIn(f"`{SCHEMA_NAME}`", self.section,
                      "[Unreleased] Stack declaration changes names the schema file")

    def test_the_section_names_the_schemas_installed_path(self):
        self.assertRegex(self.schema, INSTALLED_PATH)

    def test_the_section_names_the_shipped_schemas_version(self):
        stated = {int(number) for number in re.findall(
            r'(?i)(?:\bversion`?\W{0,4}|"version":\s*)(\d+)\b', self.schema)}
        self.assertIn(_shipped_version(), stated,
                      f"the schema part states version {_shipped_version()}; "
                      f"versions stated: {sorted(stated)}")

    def test_the_section_states_the_writer_rule(self):
        for clause, pattern in WRITER_RULE:
            with self.subTest(clause):
                self.assertRegex(self.section, pattern, clause)

    def test_the_rust_part_names_the_skip_of_another_stacks_entry(self):
        rust = _stack_part(self.section, "rust")
        self.assertTrue(rust, "the section keeps a rust part")
        self.assertRegex(rust, OTHER_STACK_SKIP)

    def test_go_test_joining_the_arduino_and_maven_skip_sets_is_named(self):
        arduino = _stack_part(self.section, "arduino")
        maven = _stack_part(self.section, "maven", "mvn")
        per_part = all("`go-test`" in part and re.search(r"(?i)skip", part)
                       for part in (arduino, maven))
        one_block = any("`go-test`" in block
                        and re.search(r"(?i)arduino", block)
                        and re.search(r"(?i)maven|mvn", block)
                        and re.search(r"(?i)skip", block)
                        for block in _blocks(self.section))
        self.assertTrue(per_part or one_block,
                        "`go-test` is named as skipped by arduino and by maven")


class TheReadmeAndRunbookNameTheManifestKeyTest(unittest.TestCase):

    def test_the_readme_names_the_declaration_schema_key(self):
        self.assertIn("`declaration_schema`", README.read_text(encoding="utf-8"))

    def test_the_runbook_names_the_declaration_schema_key(self):
        self.assertIn("`declaration_schema`", RUNBOOK.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
