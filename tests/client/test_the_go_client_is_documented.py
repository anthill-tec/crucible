"""The go client is written down where its readers look.

  - The CHANGELOG's `[Unreleased]` "Stack declaration changes" names the
    declaration schema's version 2, the `go` stack and its `[go] module_dir`
    table, and states that a package's `TestMain` runs twice per run (the
    `go test -list` that counts the run's total builds and starts every test
    binary once more).
  - README names the Go client by its file, `go-crucible.py`.
  - `docs/RUNBOOK.md` names the Go client in words ("the Go client") and its
    floor, go 1.24, but never its file name: the RUNBOOK documents no
    `*-crucible.py` client invocation (a pin the bun suite holds for every
    client).

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

    def test_the_runbook_names_the_go_client_in_words(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        self.assertRegex(text, r"(?i)\bthe Go client\b",
                         "the RUNBOOK names the Go client")

    def test_the_runbook_never_names_the_go_clients_file(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        self.assertNotIn(GO_CLIENT, text,
                         "the RUNBOOK names no client file, the Go client's included")

    def test_the_runbook_names_the_go_floor(self):
        text = RUNBOOK.read_text(encoding="utf-8")
        self.assertTrue(re.search(r"(?i)\bgo 1\.24\b", text),
                        "the RUNBOOK names the Go floor, go 1.24")


PRD = RUNBOOK.parent / "research" / "PRD-crucible-v2.md"
#: A block about Go: the word `Go` (or the Go client's file name).
ABOUT_GO = re.compile(r"\bGo\b|go-crucible\.py")
CHECK = re.compile(r"`(?:[\w.-]+ )?check`")
CHECK_TESTS = re.compile(r"`(?:[\w.-]+ )?check --tests`")
COVERAGE_FLAG = re.compile(r"--coverage\b")


def _unreleased(text):
    """The CHANGELOG's `[Unreleased]` body, up to the next release heading."""
    parts = text.split("## [Unreleased]", 1)
    return re.split(r"(?m)^## \[", parts[1], maxsplit=1)[0] if len(parts) == 2 else ""


def _go_blocks(text):
    """The paragraphs and top-level bullets of `text` that are about Go."""
    return [block for block in _blocks(text) if ABOUT_GO.search(block)]


class _NamesGosCheckAndCoverage:
    """A document names, in a block about Go, `check`, `check --tests` and
    `--coverage`. A subclass states `text()` and is a `TestCase`."""

    def text(self):
        raise NotImplementedError

    def assert_a_go_block_matches(self, pattern, what):
        blocks = _go_blocks(self.text())
        if not any(pattern.search(block) for block in blocks):
            raise AssertionError(f"a block about Go names {what}")

    def test_names_gos_check(self):
        self.assert_a_go_block_matches(CHECK, "`check`")

    def test_names_gos_check_tests(self):
        self.assert_a_go_block_matches(CHECK_TESTS, "`check --tests`")

    def test_names_gos_coverage_flag(self):
        self.assert_a_go_block_matches(COVERAGE_FLAG, "`--coverage`")


class TheChangelogNamesGosCheckAndCoverageTest(_NamesGosCheckAndCoverage, unittest.TestCase):

    def text(self):
        return _unreleased(CHANGELOG.read_text(encoding="utf-8"))

    def test_states_go_coverage_is_statement_coverage_on_the_lines_axis(self):
        stated = any(re.search(r"(?i)\bstatement", block) and re.search(r"\blines\b", block)
                     for block in _go_blocks(self.text()))
        self.assertTrue(stated, "a block about Go says its coverage is statement coverage, "
                                "on the lines axis")

    def test_states_that_goflags_carries_coverpkg(self):
        stated = any("GOFLAGS" in block and "-coverpkg" in block
                     for block in _blocks(self.text()))
        self.assertTrue(stated, "a block says `GOFLAGS` carries `-coverpkg`")


class TheReadmeNamesGosCheckAndCoverageTest(_NamesGosCheckAndCoverage, unittest.TestCase):

    def text(self):
        return README.read_text(encoding="utf-8")


class TheRunbookNamesGosCheckAndCoverageTest(_NamesGosCheckAndCoverage, unittest.TestCase):

    def text(self):
        return RUNBOOK.read_text(encoding="utf-8")


class ThePrdCarriesTheGoCoverageAmendmentTest(unittest.TestCase):

    def setUp(self):
        self.text = PRD.read_text(encoding="utf-8")

    def test_the_run_schemas_coverage_row_makes_functions_optional(self):
        rows = [line for line in self.text.splitlines()
                if re.match(r"^\|\s*`coverage`\s*\|", line)]
        self.assertTrue(rows, "the run schema has a `coverage` row")
        optional = any(re.search(r"\bfunctions\?|(?i:functions\b[^|]{0,80}\boptional)", row)
                       for row in rows)
        self.assertTrue(optional, f"the coverage row makes functions optional; rows={rows}")

    def test_the_coverage_codec_list_names_go_coverprofile(self):
        listed = any(re.search(r"(?i)coverage codecs", block) and "go-coverprofile" in block
                     for block in _blocks(self.text))
        self.assertTrue(listed, "the coverage codec list names `go-coverprofile`")

    def test_go_statement_coverage_is_stated_on_lines(self):
        stated = any("go-coverprofile" in block and re.search(r"(?i)\bstatement", block)
                     and re.search(r"\blines\b", block) for block in _blocks(self.text))
        self.assertTrue(stated, "the PRD puts Go's statement coverage on `lines`")


if __name__ == "__main__":
    unittest.main()
