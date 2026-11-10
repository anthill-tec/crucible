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

import importlib.util
import re
import subprocess
import sys
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


# ── go's tiers: declared by build tag ──────────────────────────────────────────────────────────
#
# Each fact is pinned loosely, by key words, and in ONE block about Go
# (`_go_blocks`), so a doc may word it as it likes.

DN = RUNBOOK.parent / "research" / "DN-testing-tiers-in-crucible-projects.md"
GO_HELP_CLIENT = RUNBOOK.parent.parent / "clients" / GO_CLIENT
TIER_VERBS = ("unit", "module", "integration", "e2e", "bdd")


def _verb(name):
    """A verb in backticks, bare or after the client (`go-crucible.py unit`)."""
    return re.compile(rf"`(?:[\w./-]+ )?{name}\b[^`\n]*`")


#: fact name -> the key words ONE block about Go must carry, every one.
GO_TIER_FACTS = {
    "the tier verbs": [_verb(t) for t in TIER_VERBS],
    "the declaration rule (a `_test.go` file with `//go:build <tier>` that "
    "declares a test)": [re.compile(r"//go:build"), re.compile(r"_test\.go"),
                         re.compile(r"(?i)\bdeclar")],
    "that a tier runs only the tests its tag adds": [re.compile(
        r"(?is)\bonly\b[^.]{0,120}(?:\btag\w*\b[^.]{0,60}\badd|\btagged\b)"
        r"|\bnever\s+(?:runs|files)\b[^.]{0,60}\buntagged\b")],
    "the refused name clash": [re.compile(r"(?i)\brefus"), re.compile(
        r"(?i)\bclash|\bsame\s+name\b|\balso\s+declared\b"
        r"|\bcannot\s+be\s+(?:run|selected|separated)\b")],
    "the gate's per-tier rows, the `untagged` row filed under `regression`": [
        re.compile(r"(?i)\bgate\b|pre-merge-gate"),
        re.compile(r"(?i)\b(?:rows?|suites?)\b"),
        re.compile(r"(?is)\buntagged\b[^.]{0,160}\bregression\b")],
    "a tier verb's run filed under its tier": [re.compile(
        r"(?i)\b(?:filed|stated|ingested)\s+under\s+(?:its|the|that)\s+(?:own\s+)?tier\b"
        r"|\bunder\s+the\s+verb's\s+(?:own\s+)?tier\b")],
    "`regression` covering every declared tier": [re.compile(
        r"(?is)\bregression\b[^.]{0,200}\b(?:every|each|all)\b[^.]{0,30}\btiers?\b")],
}

#: What says go declares no tier, or offers no tier verb.
GO_DECLARES_NO_TIER = (
    re.compile(r"(?i)no target for it is declared on this stack"),
    re.compile(r"(?i)\bgo\b[^.\n]{0,40}\b(?:declares|has|offers|takes) no tiers?\b"),
    re.compile(r"(?i)\bgo\b[^.\n]{0,40}\b(?:has|offers) no tier verbs?\b"),
    re.compile(r"(?i)\bno tiers? (?:is|are|can be) declared (?:on|for|in) go\b"),
)


#: The same facts in the client's own help and docstring, where a verb is
#: written bare (`unit, module, ...`), as argparse and the docstring list it.
GO_TIER_FACTS_BARE = {**GO_TIER_FACTS, "the tier verbs": [
    re.compile(rf"\b{t}\b") for t in TIER_VERBS]}


def _missing_facts(blocks, facts=None):
    """The facts of `facts` (default `GO_TIER_FACTS`) no one block of
    `blocks` carries."""
    return [fact for fact, words in (facts or GO_TIER_FACTS).items()
            if not any(all(w.search(block) for w in words) for block in blocks)]


def _assert_none(found, what):
    """Fail naming `found` when it is not empty: the mixins below hold no
    `TestCase` assertions of their own."""
    if found:
        raise AssertionError(f"{what}: {found!r}")


def _says_go_declares_no_tier(text):
    return [m.group() for pattern in GO_DECLARES_NO_TIER for m in pattern.finditer(text)]


class _NamesGosTiers:
    """A document names, each in a block about Go, every fact of
    `GO_TIER_FACTS`, and nowhere says go declares no tier. A subclass states
    `text()` and is a `TestCase`."""

    def text(self):
        raise NotImplementedError

    def test_names_every_fact_of_gos_build_tag_tiers(self):
        _assert_none(_missing_facts(_go_blocks(self.text())),
                     "no one block about Go names these facts")

    def test_nothing_says_go_declares_no_tier(self):
        _assert_none(_says_go_declares_no_tier(self.text()),
                     "these say go declares no tier")


class TheChangelogNamesGosTiersTest(_NamesGosTiers, unittest.TestCase):

    def text(self):
        return _unreleased(CHANGELOG.read_text(encoding="utf-8"))

    def test_says_check_tests_compiles_each_declared_tier(self):
        stated = any(CHECK_TESTS.search(block) and re.search(r"(?i)\btiers?\b", block)
                     and re.search(r"(?i)\btag", block)
                     for block in _go_blocks(self.text()))
        self.assertTrue(stated, "a block about Go says `check --tests` compiles each "
                                "declared tier under its tag")


class TheReadmeNamesGosTiersTest(_NamesGosTiers, unittest.TestCase):

    def text(self):
        return README.read_text(encoding="utf-8")


class TheRunbookNamesGosTiersTest(_NamesGosTiers, unittest.TestCase):

    def text(self):
        return RUNBOOK.read_text(encoding="utf-8")


class TheTestingTiersDnHasTheGoNoteTest(unittest.TestCase):

    def test_a_go_note_says_the_gates_whole_run_is_untagged_and_its_tier_rows_make_the_union(self):
        text = DN.read_text(encoding="utf-8")
        noted = any(re.search(r"\bGo\b", block) and re.search(r"\buntagged\b", block)
                    and re.search(r"(?i)\bwhole run\b|\bgate\b", block)
                    and re.search(r"(?i)\b(?:rows?|suites?)\b", block)
                    and re.search(r"(?i)\bunion\b", block)
                    for block in _blocks(text))
        self.assertTrue(noted, "a block of the testing-tiers DN says that on Go the gate's "
                               "whole run is untagged only, and its per-tier rows make "
                               "the union")


def _go_help():
    """`go-crucible.py --help`, as printed."""
    ran = subprocess.run([sys.executable, str(GO_HELP_CLIENT), "--help"],
                         capture_output=True, text=True, timeout=60, check=False)
    if ran.returncode != 0:
        raise AssertionError(f"--help exit={ran.returncode} err={ran.stderr[-600:]!r}")
    return ran.stdout


def _go_docstring():
    spec = importlib.util.spec_from_file_location("go_client_documented", GO_HELP_CLIENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.__doc__ or ""


class _NamesGosTiersAsAWhole:
    """The client's own help and docstring: the facts may be spread over the
    whole text (a help is not written in paragraphs), but each must be there,
    and nothing may say go declares no tier."""

    def text(self):
        raise NotImplementedError

    def test_names_every_fact_of_gos_build_tag_tiers(self):
        _assert_none(_missing_facts([self.text()], GO_TIER_FACTS_BARE),
                     "the text does not name these facts")

    def test_nothing_says_go_declares_no_tier(self):
        _assert_none(_says_go_declares_no_tier(self.text()),
                     "these say go declares no tier")


class TheGoHelpNamesItsTiersTest(_NamesGosTiersAsAWhole, unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.help = _go_help()

    def text(self):
        return self.help

    def test_names_the_tier_verbs(self):
        listed = re.search(r"\{([^{}]*)\}", self.help)
        verbs = set((listed.group(1) if listed else "").split(","))
        self.assertEqual(sorted(set(TIER_VERBS) - verbs), [], f"the verbs: {sorted(verbs)}")


class TheGoDocstringNamesItsTiersTest(_NamesGosTiersAsAWhole, unittest.TestCase):

    def text(self):
        return _go_docstring()


class NothingInTheGoClientSaysGoDeclaresNoTierTest(unittest.TestCase):

    def test_the_client_source_says_nothing_of_the_kind(self):
        text = GO_HELP_CLIENT.read_text(encoding="utf-8")
        self.assertEqual(_says_go_declares_no_tier(text), [])


if __name__ == "__main__":
    unittest.main()
