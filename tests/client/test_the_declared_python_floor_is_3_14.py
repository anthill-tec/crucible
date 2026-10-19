"""The python floor is 3.14 wherever the project declares it.

Python 3.14 is the adopted baseline, so the package metadata states it and
no comment in the shipped code or the tests reasons from an older floor:

* `pyproject.toml`'s `[project]` table declares `requires-python = ">=3.14"`
  and carries exactly two python classifiers -- `Programming Language ::
  Python :: 3` and `Programming Language :: Python :: 3.14`.
* No comment under `clients/`, `crucible_axi/` or `tests/` reasons from a
  floor below 3.14 -- a `requires-python` pin under it, or a "3.N floor"
  phrase naming one. A comment is a `#` comment or a docstring in a `.py`
  file, a `//` or `/* */` comment in a `.ts` file, and a `#` comment in a
  `.toml` file. A string literal that is not a docstring is data, not a
  comment, so fixtures that build old metadata on purpose are not flagged.

The scanner is proved on synthetic sources first (a stale claim is flagged,
a corrected one and plain data are not), then run over the tree.

The client PEP 723 headers are pinned by the PEP 723 metadata tests; this
file pins the package metadata and the comments.
"""

# pi-lens-ignore: I001 — pi-lens lints with its own ruff configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the declared floor
import ast  # noqa: I001
import io
import re
import textwrap
import tokenize
import tomllib
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"

THE_FLOOR = (3, 14)
EXPECTED_REQUIRES_PYTHON = ">=3.14"
EXPECTED_PYTHON_CLASSIFIERS = [
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.14",
]

SCANNED_ROOTS = ("clients", "crucible_axi", "tests")
SCANNED_SUFFIXES = (".py", ".ts", ".toml")
SKIPPED_DIRS = {"__pycache__", "node_modules", ".venv"}

# Each pattern captures the minor version of a python 3 floor the comment
# names. A floor under THE_FLOOR is a stale claim.
FLOOR_CLAIM_PATTERNS = (
    # a `requires-python` pin of `>=3.N`
    re.compile(r"requires-python\W{0,8}>=\s*3\.(\d+)", re.IGNORECASE),
    # "a 3.N floor"
    re.compile(r"\b3\.(\d+)\s+floor\b", re.IGNORECASE),
    # "a floor of 3.N", "the floor is python 3.N"
    re.compile(r"\bfloor\s+(?:of|is|at|was)\s+(?:python\s+)?3\.(\d+)\b",
               re.IGNORECASE),
)


def _merge_consecutive(line_comments):
    """Join comments on consecutive lines into one (first line, text) run,
    so a phrase wrapped across two comment lines is still read whole."""
    runs = []
    for line, text in line_comments:
        if runs and runs[-1][1] == line - 1:
            first, _, joined = runs[-1]
            runs[-1] = (first, line, f"{joined} {text}")
        else:
            runs.append((line, line, text))
    return [(first, joined) for first, _, joined in runs]


def _outside_pep723_blocks(line_comments):
    """Drop the comment lines of a `# /// script` ... `# ///` block: that
    block is the script's metadata declaration, pinned by the PEP 723
    metadata tests, not prose reasoning about a floor."""
    inside = False
    for line, text in line_comments:
        marker = text.strip()
        if not inside and marker == "/// script":
            inside = True
            continue
        if inside:
            if marker == "///":
                inside = False
            continue
        yield line, text


def _python_comments(source):
    """Yield (line, text) for every run of `#` comments and every
    docstring."""
    line_comments = [
        (tok.start[0], tok.string.lstrip("#"))
        for tok in tokenize.generate_tokens(io.StringIO(source).readline)
        if tok.type == tokenize.COMMENT
    ]
    yield from _merge_consecutive(_outside_pep723_blocks(line_comments))
    tree = ast.parse(source)
    owners = [tree] + [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef))
    ]
    for owner in owners:
        body = owner.body
        if (body and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)):
            yield body[0].lineno, body[0].value.value


_TS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
# `//` that does not belong to a URL scheme (`https://`) or a string-ish
# neighbour; good enough for the comment prose this scan is about.
_TS_LINE_COMMENT = re.compile(r"(?<![:\\/\"'`])//(.*)$", re.MULTILINE)


def _typescript_comments(source):
    """Yield (line, text) for every run of `//` comments and every
    `/* */` comment."""
    for match in _TS_BLOCK_COMMENT.finditer(source):
        yield source.count("\n", 0, match.start()) + 1, match.group(0)
    yield from _merge_consecutive(
        (source.count("\n", 0, match.start()) + 1, match.group(1))
        for match in _TS_LINE_COMMENT.finditer(source))


def _toml_comments(source):
    """Yield (line, text) for every run of `#` comment lines."""
    yield from _merge_consecutive(
        (number, line.lstrip().lstrip("#"))
        for number, line in enumerate(source.splitlines(), start=1)
        if line.lstrip().startswith("#"))


def _comments(source, suffix):
    if suffix == ".py":
        return _python_comments(source)
    if suffix == ".ts":
        return _typescript_comments(source)
    if suffix == ".toml":
        return _toml_comments(source)
    raise ValueError(f"no comment reader for {suffix!r}")


def stale_floor_claims(source, suffix):
    """Return [(line, claimed floor, comment excerpt)] for every comment in
    `source` that names a python floor below THE_FLOOR."""
    claims = []
    for line, text in _comments(source, suffix):
        for pattern in FLOOR_CLAIM_PATTERNS:
            for match in pattern.finditer(text):
                minor = int(match.group(1))
                if (3, minor) < THE_FLOOR:
                    excerpt = " ".join(text.split())[:160]
                    claims.append((line, f"3.{minor}", excerpt))
    return claims


def _scanned_files():
    for root in SCANNED_ROOTS:
        for path in sorted((REPO_ROOT / root).rglob("*")):
            if not path.is_file() or path.suffix not in SCANNED_SUFFIXES:
                continue
            if SKIPPED_DIRS.intersection(path.relative_to(REPO_ROOT).parts):
                continue
            yield path


def _load_pyproject():
    with open(PYPROJECT_PATH, "rb") as handle:
        return tomllib.load(handle)


class PyprojectDeclaresThePython314FloorTest(unittest.TestCase):
    """The package metadata names 3.14 as the floor and as the only
    supported python minor."""

    def test_requires_python_is_at_least_3_14(self):
        project = _load_pyproject()["project"]
        self.assertEqual(
            project.get("requires-python"), EXPECTED_REQUIRES_PYTHON,
            f"pyproject.toml [project] requires-python: expected "
            f"{EXPECTED_REQUIRES_PYTHON!r}, got "
            f"{project.get('requires-python')!r}")

    def test_python_classifiers_are_exactly_python_3_and_3_14(self):
        classifiers = _load_pyproject()["project"].get("classifiers", [])
        python_classifiers = [
            c for c in classifiers
            if c.startswith("Programming Language :: Python")
        ]
        self.assertEqual(
            sorted(python_classifiers), sorted(EXPECTED_PYTHON_CLASSIFIERS),
            f"pyproject.toml python classifiers: expected exactly "
            f"{EXPECTED_PYTHON_CLASSIFIERS!r}, got {python_classifiers!r}")

    def test_the_non_python_classifiers_are_kept(self):
        classifiers = _load_pyproject()["project"].get("classifiers", [])
        self.assertIn(
            "License :: OSI Approved :: GNU General Public License v3 (GPLv3)",
            classifiers)
        self.assertIn("Operating System :: POSIX", classifiers)


class StaleFloorClaimScannerTest(unittest.TestCase):
    """The scanner flags a comment that reasons from a floor under 3.14,
    and leaves a corrected comment and plain data alone."""

    def test_python_comment_costing_a_3_11_floor_is_flagged(self):
        one_line = "x = 1  # would cost a 3.11 floor (`python -P`) to defend\n"
        claims = stale_floor_claims(one_line, ".py")
        self.assertEqual([(line, floor) for line, floor, _ in claims],
                         [(1, "3.11")])

    def test_python_claim_wrapped_across_two_comment_lines_is_flagged(self):
        source = textwrap.dedent("""\
            def run():
                # inherent to `python -m coverage`, and would cost a 3.11
                # floor (`python -P`) to defend -- left unguarded.
                return 1
            """)
        claims = stale_floor_claims(source, ".py")
        self.assertEqual([(line, floor) for line, floor, _ in claims],
                         [(2, "3.11")])

    def test_python_docstring_pinning_an_old_requires_python_is_flagged(self):
        source = textwrap.dedent('''\
            def check():
                """Each header declares `requires-python = ">=3.10"`."""
                return None
            ''')
        claims = stale_floor_claims(source, ".py")
        self.assertEqual([(line, floor) for line, floor, _ in claims],
                         [(2, "3.10")])

    def test_pep723_metadata_block_is_not_read_as_prose(self):
        source = textwrap.dedent("""\
            #!/usr/bin/env python3
            # /// script
            # requires-python = ">=3.10"
            # dependencies = []
            # ///
            # and would cost a 3.11 floor to defend
            VALUE = 1
            """)
        claims = stale_floor_claims(source, ".py")
        self.assertEqual([(line, floor) for line, floor, _ in claims],
                         [(6, "3.11")])

    def test_python_string_data_that_is_not_a_docstring_is_not_flagged(self):
        source = textwrap.dedent('''\
            """Builds metadata fixtures."""
            OLD_HEADER = 'requires-python = ">=3.10"'
            NOTE = "a 3.11 floor"
            ''')
        self.assertEqual(stale_floor_claims(source, ".py"), [])

    def test_python_comment_naming_the_3_14_floor_is_not_flagged(self):
        source = textwrap.dedent("""\
            # `python -P` needs 3.11, which the 3.14 floor already gives;
            # requires-python = ">=3.14" is the declared floor.
            VALUE = 1
            """)
        self.assertEqual(stale_floor_claims(source, ".py"), [])

    def test_typescript_line_and_block_comments_are_flagged(self):
        source = (
            'const url = "https://example.test";\n'
            "// a scenario `requires-python = \">=3.10\"` does not support\n"
            "/*\n"
            " * and would cost a 3.11 floor to defend\n"
            " */\n"
            'const data = "a 3.12 floor";\n'
        )
        claims = stale_floor_claims(source, ".ts")
        self.assertEqual(sorted((line, floor) for line, floor, _ in claims),
                         [(2, "3.10"), (3, "3.11")])

    def test_toml_comment_is_flagged_and_toml_value_is_not(self):
        source = ('# the floor is 3.10 here\n'
                  'requires-python = ">=3.10"\n')
        claims = stale_floor_claims(source, ".toml")
        self.assertEqual([(line, floor) for line, floor, _ in claims],
                         [(1, "3.10")])


class NoCommentReasonsFromAFloorBelow314Test(unittest.TestCase):
    """Across `clients/`, `crucible_axi/` and `tests/`, no comment names a
    python floor below 3.14."""

    def test_scan_covers_the_three_roots(self):
        scanned = {p.relative_to(REPO_ROOT).parts[0] for p in _scanned_files()}
        self.assertEqual(scanned, set(SCANNED_ROOTS))

    def test_no_comment_reasons_from_a_floor_below_3_14(self):
        offenders = []
        for path in _scanned_files():
            source = path.read_text(encoding="utf-8")
            for line, floor, excerpt in stale_floor_claims(source, path.suffix):
                rel = path.relative_to(REPO_ROOT)
                offenders.append(f"{rel} line {line}: floor {floor}: {excerpt}")
        self.assertEqual(
            offenders, [],
            "comments reasoning from a python floor below 3.14:\n  "
            + "\n  ".join(offenders))


if __name__ == "__main__":
    unittest.main()
