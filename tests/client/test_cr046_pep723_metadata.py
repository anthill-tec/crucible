"""CR-CRU-046 C2 (second pass) -- PEP 723 inline script metadata on the
client fleet, RE-POINTED after the §S2 stub finding (docs/changes/
CR-CRU-046-toon-conformance.md §S2/§S3, user decision 2026-08-01, Option A).

Original C1 contract (now SUPERSEDED): each block pinned
`dependencies = ["toon-format>=0.1,<0.2"]`. That pin has been proven to
point at a stub -- PyPI `toon-format` 0.1.0 (the only release ever
published) has `encode`/`decode` that both `raise NotImplementedError`.
Pinning it would install a landmine that silently shadows any future real
module a client script might resolve by name.

REVISED contract pinned from §S3's revision note:

    Each of the five clients (`clients/bun-crucible.py`,
    `clients/python-crucible.py`, `clients/mvn-crucible.py`,
    `clients/rust-crucible.py`, `clients/arduino-crucible.py`) still carries
    a `# /// script` PEP 723 inline metadata block declaring
    `requires-python = ">=3.10"`, but its `dependencies` list is now EMPTY
    (`dependencies = []`) -- the mechanism (PEP 723 + `uv run`) stays wired
    and proven, harmless while empty, and the eventual real-library re-add
    becomes a one-line change per file (the §S2 revisit pin). The block
    must still sit in the leading comment region per PEP 723 (before the
    first non-comment, non-shebang, non-docstring statement).

    Separately, `pyproject.toml`'s `[project]` table must carry NO
    `toon-format` runtime dependency at all -- the stub-landmine guard
    applies there too; the C1 pin is REVERTED, not merely left as one
    dependency among others.

RED phase: today (C1's GREEN state) all five clients still carry
`dependencies = ["toon-format>=0.1,<0.2"]` and `pyproject.toml`'s
`[project]` table still declares that same pin. The presence tests (block
exists / requires-python / leading-comment position) still pass unchanged
-- only the dependency-shape assertions below are the RED surface for C2:
they fail because the pin is still THERE, where the revised contract now
requires it ABSENT. No collection/import errors expected -- this file only
reads source text and TOML, it does not import any client module.

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

EXPECTED_REQUIRES_PYTHON = ">=3.10"
MAX_BLOCK_START_LINE = 60
TOON_STUB_PIN = "toon-format>=0.1,<0.2"


def _toon_like_entries(entries):
    """Return the subset of `entries` whose package name (the part before
    any version specifier) is `toon-format` or the near-miss bare `toon` --
    the stub-landmine guard: neither may sneak back in under any pin."""
    return [
        d for d in entries
        if d.split(">")[0].split("=")[0].split("<")[0].strip() in ("toon-format", "toon")
    ]

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


class ClientPep723BlockDeclaresEmptyDependenciesTest(unittest.TestCase):
    """§S3 REVISED -- with no adoptable Python TOON library (the §S2 stub
    finding), each block's `dependencies` list must be EMPTY (`[]`). The C1
    `toon-format` pin is REVERTED everywhere it landed -- pinning a stub
    would install a landmine that shadows any future real module. Fails
    today: all five clients still carry `dependencies = ["toon-format>=0.1,<0.2"]`."""

    def test_bun_crucible_dependencies_are_empty(self):
        self._assert_dependencies_empty("bun-crucible.py")

    def test_python_crucible_dependencies_are_empty(self):
        self._assert_dependencies_empty("python-crucible.py")

    def test_mvn_crucible_dependencies_are_empty(self):
        self._assert_dependencies_empty("mvn-crucible.py")

    def test_rust_crucible_dependencies_are_empty(self):
        self._assert_dependencies_empty("rust-crucible.py")

    def test_arduino_crucible_dependencies_are_empty(self):
        self._assert_dependencies_empty("arduino-crucible.py")

    def _assert_dependencies_empty(self, name):
        text = _read_client_text(name)
        match, _ = _find_pep723_block(text)
        self.assertIsNotNone(
            match, f"{name}: expected a PEP 723 block to parse, found none")
        parsed = _parse_pep723_block(match)
        deps = parsed.get("dependencies", None)
        self.assertEqual(
            deps, [],
            f"{name}: expected an EMPTY dependencies list ([]) -- the "
            f"stub-landmine guard -- got dependencies={deps!r}")


class ClientPep723BlockHasNoToonNearMissDependencyTest(unittest.TestCase):
    """Negative/bound guard, kept from C1 -- even under the empty-list
    contract, no stray `toon-format` or bare `toon` entry may sneak back in
    under a differently-formatted specifier."""

    def test_bun_crucible_no_toon_dependency(self):
        self._assert_no_toon_dependency("bun-crucible.py")

    def test_python_crucible_no_toon_dependency(self):
        self._assert_no_toon_dependency("python-crucible.py")

    def test_mvn_crucible_no_toon_dependency(self):
        self._assert_no_toon_dependency("mvn-crucible.py")

    def test_rust_crucible_no_toon_dependency(self):
        self._assert_no_toon_dependency("rust-crucible.py")

    def test_arduino_crucible_no_toon_dependency(self):
        self._assert_no_toon_dependency("arduino-crucible.py")

    def _assert_no_toon_dependency(self, name):
        text = _read_client_text(name)
        match, _ = _find_pep723_block(text)
        self.assertIsNotNone(
            match, f"{name}: expected a PEP 723 block to parse, found none")
        parsed = _parse_pep723_block(match)
        deps = parsed.get("dependencies", [])
        found = _toon_like_entries(deps)
        self.assertEqual(
            found, [],
            f"{name}: found a toon-related dependency entry where none is "
            f"allowed: {found!r} (full dependencies={deps!r})")


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


class PyprojectHasNoToonFormatRuntimeDependencyTest(unittest.TestCase):
    """§S3 REVISED -- pyproject.toml's [project] table must NOT list any
    `toon-format` (or near-miss bare `toon`) runtime dependency -- the
    stub-landmine guard applies server-side (Python packaging) too, not
    just to the five PEP 723 blocks. Fails today: the C1 pin
    `dependencies = ["toon-format>=0.1,<0.2"]` is still present."""

    def test_project_dependencies_do_not_contain_toon_format_pin(self):
        with open(PYPROJECT_PATH, "rb") as f:
            parsed = tomllib.load(f)
        project = parsed.get("project", {})
        deps = project.get("dependencies", [])
        self.assertNotIn(
            TOON_STUB_PIN, deps,
            f"expected pyproject.toml's [project.dependencies] to NOT "
            f"contain the stub pin {TOON_STUB_PIN!r} (reverted per §S3), "
            f"got {deps!r}")

    def test_project_dependencies_contain_no_toon_named_entry_at_all(self):
        with open(PYPROJECT_PATH, "rb") as f:
            parsed = tomllib.load(f)
        project = parsed.get("project", {})
        deps = project.get("dependencies", [])
        found = _toon_like_entries(deps)
        self.assertEqual(
            found, [],
            f"expected NO toon-format/toon-named entry in pyproject.toml's "
            f"[project.dependencies], found {found!r} (full deps={deps!r})")


if __name__ == "__main__":
    unittest.main()
