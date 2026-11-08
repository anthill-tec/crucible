"""The go client is written down where its readers look.

  - The CHANGELOG's `[Unreleased]` "Stack declaration changes" names the
    declaration schema's version 2, the `go` stack and its `[go] module_dir`
    table, and states that a package's `TestMain` runs twice per run (the
    `go test -list` that counts the run's total builds and starts every test
    binary once more).
  - README and `docs/RUNBOOK.md` name the Go client, `go-crucible.py`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_go_client_is_documented
"""

import re
import unittest

from tests.client.test_the_declaration_schema_is_documented import (
    CHANGELOG,
    README,
    RUNBOOK,
    _blocks,
    _schema_part,
    _stack_part,
    _unreleased_stack_section,
)

GO_CLIENT = "go-crucible.py"
VERSION_STATED = re.compile(r'(?i)(?:\bversion`?\W{0,4}|"version":\s*)(\d+)\b')
TEST_MAIN_TWICE = re.compile(r"(?is)`TestMain`[^.]{0,160}\btwice\b|\btwice\b[^.]{0,160}`TestMain`")
GO_LIST = re.compile(r"`go test -list")


class TheChangelogNamesTheGoStackTest(unittest.TestCase):

    def setUp(self):
        self.section = _unreleased_stack_section(CHANGELOG.read_text(encoding="utf-8"))
        self.go = _stack_part(self.section, "go", "Go")

    def test_the_schema_part_states_version_two(self):
        stated = {int(n) for n in VERSION_STATED.findall(_schema_part(self.section))}
        self.assertIn(2, stated, f"the schema part states version 2; stated {sorted(stated)}")

    def test_the_section_keeps_a_go_part(self):
        self.assertTrue(self.go, "the section has a `For the go stack` part")

    def test_the_go_part_names_the_module_dir_table(self):
        self.assertIn("[go] module_dir", self.go,
                      "the go part names the `[go] module_dir` declaration")
        self.assertIn("go.mod", self.go,
                      "the go part says the module dir is a directory holding go.mod")

    def test_the_go_part_names_the_go_stack_joining_the_schema(self):
        joined = any("`go`" in block and re.search(r"(?i)\bstack\b", block)
                     and "crucible-declaration.schema.json" in block
                     for block in _blocks(self.section))
        self.assertTrue(joined or ("`go`" in _schema_part(self.section)),
                        "the schema part names the `go` stack it gains")

    def test_the_go_part_states_that_test_main_runs_twice_per_run(self):
        self.assertRegex(self.go, TEST_MAIN_TWICE)
        self.assertRegex(self.go, GO_LIST,
                         "the go part says the second run is `go test -list`'s")


class TheReadmeAndRunbookNameTheGoClientTest(unittest.TestCase):

    def test_the_readme_names_the_go_client(self):
        self.assertIn(GO_CLIENT, README.read_text(encoding="utf-8"))

    def test_the_runbook_names_the_go_client(self):
        self.assertIn(GO_CLIENT, RUNBOOK.read_text(encoding="utf-8"))

    def test_the_runbook_names_the_go_floor(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        self.assertTrue(re.search(r"(?i)\bgo 1\.24\b", text),
                        "the RUNBOOK names the Go floor, go 1.24")


if __name__ == "__main__":
    unittest.main()
