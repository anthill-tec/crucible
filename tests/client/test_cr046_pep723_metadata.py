"""CR-CRU-046 C1 -- PEP 723 inline script metadata on the client fleet
(pre-flip mechanism step, §S3 + §S3b).

Contract pinned from docs/changes/CR-CRU-046-toon-conformance.md §S3:

    Each of the five clients (`clients/bun-crucible.py`,
    `clients/python-crucible.py`, `clients/mvn-crucible.py`,
    `clients/rust-crucible.py`, `clients/arduino-crucible.py`) carries a
    `# /// script` PEP 723 inline metadata block declaring
    `requires-python = ">=3.10"` and
    `dependencies = ["toon-format>=0.1,<0.2"]`, so `uv run <client>.py`
    resolves the upcoming `toon-format` dependency without relying on
    whatever bare `python3` happens to be on hand. The block must sit in
    the leading comment region per PEP 723 (before the first non-comment,
    non-shebang, non-docstring statement).

    Separately, `pyproject.toml`'s `[project]` table must declare a
    runtime `dependencies` list containing `toon-format>=0.1,<0.2` (the
    server-side half of the §S2 dependency pin, on the Python side).

RED phase: none of the five clients carry a `# /// script` block yet (each
starts with a bare `#!/usr/bin/env python3` shebang and nothing else in the
leading comment region), and `pyproject.toml`'s `[project]` table has NO
`dependencies` key at all. Every test below fails a plain assertion against
that absence -- no collection/import errors expected, since this test file
only reads source text and TOML, it does not import any client module.

Invocation:
    python3 -m pytest tests/client/test_cr046_pep723_metadata.py -q
Fallback:
    python3 tests/client/test_cr046_pep723_metadata.py
"""

import re
import tomllib
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"

CLIENT_NAMES = [
    "bun-crucible.py",
    "python-crucible.py",
    "mvn-crucible.py",
    "rust-crucible.py",
    "arduino-crucible.py",
]

EXPECTED_DEPENDENCY = "toon-format>=0.1,<0.2"
EXPECTED_REQUIRES_PYTHON = ">=3.10"
MAX_BLOCK_START_LINE = 60

# PEP 723: a fenced comment block, opening tag `# /// TYPE`, closing tag
# `# ///`, each body line either bare `#` or `# ` + content.
PEP723_BLOCK_RE = re.compile(
    r"(?m)^# /// script\s*$\n((?:^#(?:| .*)$\n)*)^# ///\s*$", re.MULTILINE
)


def _client_path(name):
    return REPO_ROOT / "clients" / name


def _read_client_text(name):
    return _client_path(name).read_text(encoding="utf-8")


def _find_pep723_block(text):
    """Return (match, start_line_number) for the first PEP 723 `# ///
    script` ... `# ///` block in `text`, or (None, None) if absent. Mirrors
    the reference algorithm from PEP 723 itself: locate the fenced comment
    region, strip the `#`/`# ` prefixes, and hand the remainder to a TOML
    parser."""
    match = PEP723_BLOCK_RE.search(text)
    if match is None:
        return None, None
    start_line = text.count("\n", 0, match.start()) + 1
    return match, start_line


def _parse_pep723_block(match):
    """Strip the `# ` (or bare `#`) comment prefix from each body line and
    parse the remainder as TOML, per PEP 723's reference unpacking
    algorithm."""
    body_lines = match.group(1).splitlines()
    toml_lines = []
    for line in body_lines:
        if line == "#":
            toml_lines.append("")
        elif line.startswith("# "):
            toml_lines.append(line[2:])
        else:
            raise AssertionError(
                f"PEP 723 body line does not match the '#' or '# ' "
                f"comment-prefix convention: {line!r}")
    return tomllib.loads("\n".join(toml_lines))


class ClientCarriesPep723MetadataBlockTest(unittest.TestCase):
    """§S3 -- each of the five clients carries a `# /// script` ... `# ///`
    PEP 723 inline metadata block in its leading comment region."""

    def test_bun_crucible_has_pep723_block(self):
        self._assert_has_block("bun-crucible.py")

    def test_python_crucible_has_pep723_block(self):
        self._assert_has_block("python-crucible.py")

    def test_mvn_crucible_has_pep723_block(self):
        self._assert_has_block("mvn-crucible.py")

    def test_rust_crucible_has_pep723_block(self):
        self._assert_has_block("rust-crucible.py")

    def test_arduino_crucible_has_pep723_block(self):
        self._assert_has_block("arduino-crucible.py")

    def _assert_has_block(self, name):
        text = _read_client_text(name)
        match, _ = _find_pep723_block(text)
        self.assertIsNotNone(
            match,
            f"{name}: expected a PEP 723 '# /// script' ... '# ///' inline "
            f"metadata block, found none")


class ClientPep723BlockDeclaresRequiresPythonTest(unittest.TestCase):
    """§S3 -- the parsed block declares `requires-python = ">=3.10"`."""

    def test_bun_crucible_requires_python(self):
        self._assert_requires_python("bun-crucible.py")

    def test_python_crucible_requires_python(self):
        self._assert_requires_python("python-crucible.py")

    def test_mvn_crucible_requires_python(self):
        self._assert_requires_python("mvn-crucible.py")

    def test_rust_crucible_requires_python(self):
        self._assert_requires_python("rust-crucible.py")

    def test_arduino_crucible_requires_python(self):
        self._assert_requires_python("arduino-crucible.py")

    def _assert_requires_python(self, name):
        text = _read_client_text(name)
        match, _ = _find_pep723_block(text)
        self.assertIsNotNone(
            match, f"{name}: expected a PEP 723 block to parse, found none")
        parsed = _parse_pep723_block(match)
        self.assertEqual(
            parsed.get("requires-python"), EXPECTED_REQUIRES_PYTHON,
            f"{name}: expected requires-python == "
            f"{EXPECTED_REQUIRES_PYTHON!r}, got {parsed.get('requires-python')!r}")


class ClientPep723BlockDeclaresToonFormatDependencyTest(unittest.TestCase):
    """§S3 -- the block's `dependencies` list contains EXACTLY one entry
    matching `toon-format>=0.1,<0.2` -- not zero, not more than one, and
    not some other unrelated pin (guards against the near-miss PyPI
    package `toon`, per the CR's warning)."""

    def test_bun_crucible_dependency_pin(self):
        self._assert_dependency_pin("bun-crucible.py")

    def test_python_crucible_dependency_pin(self):
        self._assert_dependency_pin("python-crucible.py")

    def test_mvn_crucible_dependency_pin(self):
        self._assert_dependency_pin("mvn-crucible.py")

    def test_rust_crucible_dependency_pin(self):
        self._assert_dependency_pin("rust-crucible.py")

    def test_arduino_crucible_dependency_pin(self):
        self._assert_dependency_pin("arduino-crucible.py")

    def _assert_dependency_pin(self, name):
        text = _read_client_text(name)
        match, _ = _find_pep723_block(text)
        self.assertIsNotNone(
            match, f"{name}: expected a PEP 723 block to parse, found none")
        parsed = _parse_pep723_block(match)
        deps = parsed.get("dependencies", [])
        matching = [d for d in deps if d == EXPECTED_DEPENDENCY]
        self.assertEqual(
            len(matching), 1,
            f"{name}: expected exactly one dependency entry == "
            f"{EXPECTED_DEPENDENCY!r}, got dependencies={deps!r}")
        # Negative/bound: no unrelated near-miss package name (bare "toon")
        # smuggled in alongside the correct pin.
        self.assertNotIn(
            "toon", [d.split(">")[0].split("=")[0].split("<")[0].strip()
                     for d in deps if d != EXPECTED_DEPENDENCY],
            f"{name}: found an unrelated 'toon'-named dependency pin "
            f"alongside the correct one: {deps!r}")


class ClientPep723BlockSitsInLeadingCommentRegionTest(unittest.TestCase):
    """§S3 -- PEP 723 requires the block to appear before the first
    non-comment, non-shebang, non-docstring statement. As a concrete,
    checkable proxy: the block's opening `# /// script` line must start
    within the first 60 lines of the file."""

    def test_bun_crucible_block_starts_within_first_60_lines(self):
        self._assert_block_starts_early("bun-crucible.py")

    def test_python_crucible_block_starts_within_first_60_lines(self):
        self._assert_block_starts_early("python-crucible.py")

    def test_mvn_crucible_block_starts_within_first_60_lines(self):
        self._assert_block_starts_early("mvn-crucible.py")

    def test_rust_crucible_block_starts_within_first_60_lines(self):
        self._assert_block_starts_early("rust-crucible.py")

    def test_arduino_crucible_block_starts_within_first_60_lines(self):
        self._assert_block_starts_early("arduino-crucible.py")

    def _assert_block_starts_early(self, name):
        text = _read_client_text(name)
        match, start_line = _find_pep723_block(text)
        self.assertIsNotNone(
            match, f"{name}: expected a PEP 723 block to locate, found none")
        self.assertLessEqual(
            start_line, MAX_BLOCK_START_LINE,
            f"{name}: expected the PEP 723 block to start within the first "
            f"{MAX_BLOCK_START_LINE} lines, but it starts at line {start_line}")


class PyprojectDeclaresToonFormatRuntimeDependencyTest(unittest.TestCase):
    """§S3 -- pyproject.toml's [project] table declares a runtime
    `dependencies` list containing `toon-format>=0.1,<0.2`. Currently
    there is NO [project] dependencies key at all, so this must fail
    cleanly on that absence (KeyError-shaped, not an ambiguous parse
    error)."""

    def test_project_dependencies_key_exists(self):
        with open(PYPROJECT_PATH, "rb") as f:
            parsed = tomllib.load(f)
        project = parsed.get("project", {})
        self.assertIn(
            "dependencies", project,
            "expected pyproject.toml's [project] table to declare a "
            "'dependencies' key, found none")

    def test_project_dependencies_contains_toon_format_pin(self):
        with open(PYPROJECT_PATH, "rb") as f:
            parsed = tomllib.load(f)
        project = parsed.get("project", {})
        deps = project.get("dependencies", [])
        self.assertIn(
            EXPECTED_DEPENDENCY, deps,
            f"expected pyproject.toml's [project.dependencies] to contain "
            f"{EXPECTED_DEPENDENCY!r}, got {deps!r}")


if __name__ == "__main__":
    unittest.main()
