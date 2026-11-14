"""The doc tests that check the changelog read the section being written
through their language's one reader, never by looking `[Unreleased]` up by
name.

On a release branch the section being written is `## [X.Y.Z] - YYYY-MM-DD`,
and on `master` there is no `[Unreleased]` at all, so a test that finds its
section by that name can pass only between releases. Each doc test below
reads the changelog through the shared reader of its language instead:

  * python: `changelog_section` from `tests/client/changelog_section.py`;
  * TypeScript: `changelogSection` from `tests/helpers/changelog-section.ts`.

The rule for "looks `[Unreleased]` up by name": a code literal — a string,
a template or a regular expression; never a docstring or a comment — whose
text, once its escapes, a leading inline-flag group, a leading `^` and
leading whitespace are set aside, BEGINS with a `## [Unreleased` heading.
That is the shape of every lookup key (`"## [Unreleased]"`,
`/^## \\[Unreleased\\]/`, `r"(?m)^## \\[Unreleased\\]"`), and also of a
constant holding one for a later lookup. It leaves alone the words a test
prints when it fails ("the changelog has an [Unreleased] body") and an
inline changelog written as a reader's own fixture, which begins with its
title, not with the heading.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_doc_tests_read_the_changelog_through_one_reader
"""

import ast
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

#: The python doc tests that check the changelog, under tests/client/.
PYTHON_DOC_TESTS = (
    "test_a_runs_coverage_files_are_documented",
    "test_project_create_is_documented",
    "test_the_arduino_stream_declaration_is_documented",
    "test_the_declaration_schema_is_documented",
    "test_the_docs_say_regression_and_the_gate_read_the_marker",
    "test_the_go_client_is_documented",
    "test_the_lint_verb_and_gate_stage_are_documented_where_operators_read_them",
    "test_the_maven_console_declaration_is_documented",
    "test_the_rust_targets_declaration_is_documented",
)

#: The bun doc tests that check the changelog, under tests/.
BUN_DOC_TESTS = (
    "docs-describe-lint-records",
    "coverage-file-table-docs",
    "coverage-outside-the-runs-tree-docs",
    "release-flow-names-the-release-notes-verb",
)

PYTHON_READER_MODULE = "tests.client.changelog_section"
PYTHON_READER = "changelog_section"
TS_READER = "changelogSection"
TS_READER_IMPORT = re.compile(
    r"import\s*\{[^}]*\b" + TS_READER + r"\b[^}]*\}\s*from\s*"
    r"""["']\./helpers/changelog-section(?:\.ts)?["']""")

_INLINE_FLAGS = re.compile(r"^\(\?[a-zA-Z]+\)")
_UNRELEASED_HEADING = re.compile(r"#{1,6}\s*\[Unreleased")


def python_path(name):
    return REPO_ROOT / "tests" / "client" / f"{name}.py"


def bun_path(name):
    return REPO_ROOT / "tests" / f"{name}.test.ts"


def is_unreleased_lookup(text):
    """Whether a literal's text is a lookup key for the `[Unreleased]`
    heading: it begins with the heading once escapes, inline flags, a `^`
    and leading whitespace are set aside."""
    text = re.sub(r"\\[nrt]", " ", text).replace("\\", "")
    while True:
        stripped = _INLINE_FLAGS.sub("", text.lstrip()).lstrip("^")
        if stripped == text:
            break
        text = stripped
    return _UNRELEASED_HEADING.match(text) is not None


def python_docstring_nodes(tree):
    nodes = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            body = node.body
            if (body and isinstance(body[0], ast.Expr)
                    and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                nodes.add(id(body[0].value))
    return nodes


def python_code_literals(source):
    """Every string literal of the source that is not a docstring; comments
    never reach the tree."""
    tree = ast.parse(source)
    docstrings = python_docstring_nodes(tree)
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
            and id(node) not in docstrings]


_REGEX_PRECEDERS = set("(,=:[!&|?{};+-*%<>~^")
_REGEX_KEYWORDS = {"return", "typeof", "case", "of", "in", "void", "yield", "await"}


def ts_code_literals_and_code(source):
    """The TypeScript source's literals (strings, templates and regular
    expressions, each as its raw text) and its code with every comment
    dropped."""
    literals, code = [], []
    i, n = 0, len(source)
    prev, prev_word = "", ""
    while i < n:
        c = source[i]
        if source.startswith("//", i):
            end = source.find("\n", i)
            i = n if end == -1 else end
            continue
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        if c in "'\"`":
            j = i + 1
            while j < n and source[j] != c:
                if source[j] == "\\":
                    j += 2
                    continue
                if c != "`" and source[j] == "\n":
                    break
                j += 1
            literals.append(source[i + 1:j])
            code.append(source[i:j + 1])
            i, prev, prev_word = j + 1, c, ""
            continue
        if c == "/" and (prev == "" or prev in _REGEX_PRECEDERS
                         or (prev_word in _REGEX_KEYWORDS and prev.isalnum())):
            j, in_class = i + 1, False
            while j < n and source[j] != "\n":
                ch = source[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    break
                j += 1
            k = j + 1
            while k < n and source[k].isalpha():
                k += 1
            literals.append(source[i + 1:j])
            code.append(source[i:k])
            i, prev, prev_word = k, "/", ""
            continue
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (source[j].isalnum() or source[j] in "_$"):
                j += 1
            prev_word = source[i:j]
            prev = prev_word[-1]
            code.append(prev_word)
            i = j
            continue
        if not c.isspace():
            prev, prev_word = c, ""
        code.append(c)
        i += 1
    return literals, "".join(code)


def python_lookups(source):
    return [text for text in python_code_literals(source) if is_unreleased_lookup(text)]


def ts_lookups(source):
    literals, _ = ts_code_literals_and_code(source)
    return [text for text in literals if is_unreleased_lookup(text)]


def python_reads_through_the_reader(source):
    """The module imports the python reader from its module and calls it."""
    tree = ast.parse(source)
    local_names = {alias.asname or alias.name
                   for node in ast.walk(tree)
                   if isinstance(node, ast.ImportFrom) and node.module == PYTHON_READER_MODULE
                   for alias in node.names if alias.name == PYTHON_READER}
    called = any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                 and node.func.id in local_names
                 for node in ast.walk(tree))
    return bool(local_names) and called


def ts_reads_through_the_reader(source):
    """The module imports the TypeScript reader from tests/helpers/ and calls it."""
    _, code = ts_code_literals_and_code(source)
    return (TS_READER_IMPORT.search(code) is not None
            and re.search(r"\b" + TS_READER + r"\s*\(", code) is not None)


class TheRuleReadsWhatItIsAskedTest(unittest.TestCase):
    """Proofs of the rule and the readers above, on sources written here."""

    def test_a_heading_key_is_a_lookup_in_each_of_its_shapes(self):
        for text in ("## [Unreleased]", "^## \\[Unreleased\\]",
                     "(?m)^## \\[Unreleased\\]", "\\n## [Unreleased]"):
            with self.subTest(text=text):
                self.assertTrue(is_unreleased_lookup(text))

    def test_a_failure_message_and_a_fixture_changelog_are_not_lookups(self):
        for text in ("the changelog has an [Unreleased] body",
                     "[Unreleased] Stack declaration changes: For the maven stack",
                     "CHANGELOG.md has no [Unreleased] section",
                     "# Changelog\n\n## [Unreleased]\n\n- `fileCount` here\n",
                     "## [0.4.0] - 2026-11-14", "\n## ["):
            with self.subTest(text=text):
                self.assertFalse(is_unreleased_lookup(text))

    def test_python_docstrings_and_comments_are_not_read_but_code_strings_are(self):
        source = ('"""Reads the `## [Unreleased]` section."""\n'
                  '# text.split("## [Unreleased]")\n'
                  'def body(text):\n'
                  '    """## [Unreleased] body."""\n'
                  '    return text.split("## [Unreleased]", 1)\n'
                  'MESSAGE = "the changelog has an [Unreleased] body"\n')
        self.assertEqual(python_lookups(source), ["## [Unreleased]"])
        self.assertEqual(python_lookups('"""## [Unreleased]"""\nX = 1\n'), [])

    def test_ts_comments_are_not_read_but_strings_and_regular_expressions_are(self):
        source = ('// changelog.indexOf("## [Unreleased]")\n'
                  '/** The `## [Unreleased]` section. */\n'
                  'const url = "https://example.invalid/a//b";\n'
                  'const at = changelog.indexOf("## [Unreleased]");\n'
                  'const sec = section(CHANGELOG, /^## \\[Unreleased\\]/);\n'
                  'const ratio = a / b / c;\n'
                  'throw new Error("CHANGELOG.md has no [Unreleased] section");\n')
        self.assertEqual(ts_lookups(source), ["## [Unreleased]", "^## \\[Unreleased\\]"])

    def test_reading_through_the_reader_needs_the_import_and_a_call(self):
        self.assertTrue(python_reads_through_the_reader(
            "from tests.client.changelog_section import changelog_section\n"
            "BODY = changelog_section(TEXT)\n"))
        self.assertFalse(python_reads_through_the_reader(
            "from tests.client.changelog_section import changelog_section\n"))
        self.assertFalse(python_reads_through_the_reader(
            "def changelog_section(text):\n    return text\n"
            "BODY = changelog_section(TEXT)\n"))
        self.assertTrue(ts_reads_through_the_reader(
            'import { changelogSection } from "./helpers/changelog-section.ts";\n'
            "const body = changelogSection(CHANGELOG);\n"))
        self.assertFalse(ts_reads_through_the_reader(
            '// import { changelogSection } from "./helpers/changelog-section.ts";\n'
            "const body = changelogSection(CHANGELOG);\n"))

    def test_every_listed_doc_test_is_there_to_read(self):
        self.assertEqual(len(PYTHON_DOC_TESTS) + len(BUN_DOC_TESTS), 13)
        for path in [*map(python_path, PYTHON_DOC_TESTS), *map(bun_path, BUN_DOC_TESTS)]:
            with self.subTest(path=path.name):
                self.assertTrue(path.is_file(), f"{path} is a file")


class NoDocTestLooksTheSectionUpByNameTest(unittest.TestCase):

    maxDiff = None

    def test_no_python_doc_test_looks_unreleased_up_by_name(self):
        found = {name: python_lookups(python_path(name).read_text(encoding="utf-8"))
                 for name in PYTHON_DOC_TESTS}
        self.assertEqual({name: keys for name, keys in found.items() if keys}, {},
                         "a python doc test looks the `[Unreleased]` heading up by name")

    def test_no_bun_doc_test_looks_unreleased_up_by_name(self):
        found = {name: ts_lookups(bun_path(name).read_text(encoding="utf-8"))
                 for name in BUN_DOC_TESTS}
        self.assertEqual({name: keys for name, keys in found.items() if keys}, {},
                         "a bun doc test looks the `[Unreleased]` heading up by name")


class EveryDocTestReadsThroughItsLanguagesReaderTest(unittest.TestCase):

    maxDiff = None

    def test_every_python_doc_test_reads_the_section_through_the_python_reader(self):
        missing = [name for name in PYTHON_DOC_TESTS
                   if not python_reads_through_the_reader(
                       python_path(name).read_text(encoding="utf-8"))]
        self.assertEqual(missing, [],
                         "each python doc test imports `changelog_section` from "
                         "tests/client/changelog_section.py and calls it")

    def test_every_bun_doc_test_reads_the_section_through_the_typescript_reader(self):
        missing = [name for name in BUN_DOC_TESTS
                   if not ts_reads_through_the_reader(
                       bun_path(name).read_text(encoding="utf-8"))]
        self.assertEqual(missing, [],
                         "each bun doc test imports `changelogSection` from "
                         "tests/helpers/changelog-section.ts and calls it")


if __name__ == "__main__":
    unittest.main()
