"""The three `I001` suppressions stay, and say why they are needed.

`clients/_crucible_axi.py`, `clients/rust-crucible.py` and
`crucible_axi/install.py` each suppress ruff's `I001` twice: a
`# pi-lens-ignore: I001 ...` comment on the line above the first import,
and a `# noqa: I001` on that import. Both stay.

The pi-lens comment's reason names the real cause: pi-lens lints with its
own ruff configuration, which sets no target version, so ruff files
`tomllib` as third-party whatever the declared floor. It does not blame
the declared floor.

pi-lens reads a suppression from one line and applies it to that line and
the next, splitting the payload into a rule list and a trailing reason at
the first ` -- `, ` \u2014 ` or `: ` separator. So the reason is read from
the comment's own line, and the comment must sit directly above the
import it covers.
"""

import ast
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SUPPRESSION_SITES = (
    "clients/_crucible_axi.py",
    "clients/rust-crucible.py",
    "crucible_axi/install.py",
)

# pi-lens's own inline-suppression grammar.
PI_LENS_IGNORE = re.compile(r"(?:\/\/|#)\s*pi-lens-ignore:\s*(.+)")
PI_LENS_REASON_SEPARATOR = re.compile(r"(?:\s+--\s+|\s+\u2014\s+|:\s+)")
NOQA_I001 = re.compile(r"#\s*noqa:\s*[A-Z0-9, ]*\bI001\b")

# What the reason must name: pi-lens's ruff configuration having no target
# version, and the stdlib module it misfiles.
REQUIRED_CAUSE = {
    "pi-lens": re.compile(r"pi-lens", re.IGNORECASE),
    "ruff": re.compile(r"\bruff\b", re.IGNORECASE),
    "its ruff configuration": re.compile(r"\bconfig(?:uration)?\b",
                                         re.IGNORECASE),
    "no target version": re.compile(r"\bno\s+`?target[-\s]version`?",
                                    re.IGNORECASE),
    "tomllib": re.compile(r"\btomllib\b"),
}
# The old reason blamed a 3.10 target / floor.
BLAMES_THE_OLD_FLOOR = re.compile(r"\b3\.10\b")


def _split_payload(payload):
    """Return (rule ids, trailing reason) as pi-lens splits them."""
    separator = PI_LENS_REASON_SEPARATOR.search(payload)
    if separator is None:
        rules, reason = payload, ""
    else:
        rules, reason = payload[:separator.start()], payload[separator.end():]
    return [r.strip() for r in rules.split(",") if r.strip()], reason.strip()


def _i001_suppressions(lines):
    """Return [(1-based line, reason)] for each pi-lens-ignore naming I001."""
    found = []
    for index, line in enumerate(lines):
        match = PI_LENS_IGNORE.search(line)
        if match is None:
            continue
        rules, reason = _split_payload(match.group(1))
        if "I001" in rules:
            found.append((index + 1, rules, reason))
    return found


def _first_import_line(source):
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return node.lineno
    raise AssertionError("module has no top-level import")


class _SuppressionSiteChecks(unittest.TestCase):
    """The checks every site runs; bound to a site by a subclass below and
    removed from the module afterwards so discovery runs the subclasses
    only."""

    site = ""

    def _load(self):
        source = (REPO_ROOT / self.site).read_text(encoding="utf-8")
        return source, source.splitlines()

    def _the_suppression(self):
        _, lines = self._load()
        found = _i001_suppressions(lines)
        self.assertEqual(
            len(found), 1,
            f"{self.site}: expected exactly one `# pi-lens-ignore: I001` "
            f"comment, found {len(found)}: {found!r}")
        return found[0]

    def test_pi_lens_ignore_sits_directly_above_the_first_import(self):
        source, _ = self._load()
        line, rules, _ = self._the_suppression()
        self.assertEqual(rules, ["I001"],
                         f"{self.site}: pi-lens reads rule ids {rules!r}")
        self.assertEqual(
            _first_import_line(source), line + 1,
            f"{self.site}: the pi-lens-ignore comment on line {line} must sit "
            f"on the line directly above the module's first import")

    def test_first_import_keeps_its_noqa_i001(self):
        source, lines = self._load()
        first_import = _first_import_line(source)
        import_line = lines[first_import - 1]
        self.assertRegex(
            import_line, NOQA_I001,
            f"{self.site}: the first import must keep `# noqa: I001`, got "
            f"{import_line!r}")

    def test_reason_names_pi_lens_ruff_configuration_without_a_target_version(self):
        _, _, reason = self._the_suppression()
        missing = [name for name, pattern in REQUIRED_CAUSE.items()
                   if not pattern.search(reason)]
        self.assertEqual(
            missing, [],
            f"{self.site}: the I001 reason must name pi-lens's own ruff "
            f"configuration setting no target version as the cause; it "
            f"lacks {missing!r}. Reason: {reason!r}")

    def test_reason_does_not_blame_the_old_floor(self):
        _, _, reason = self._the_suppression()
        self.assertNotRegex(
            reason, BLAMES_THE_OLD_FLOOR,
            f"{self.site}: the I001 reason still blames a 3.10 floor/target: "
            f"{reason!r}")


class SharedAxiModuleI001SuppressionTest(_SuppressionSiteChecks):
    site = "clients/_crucible_axi.py"


class RustClientI001SuppressionTest(_SuppressionSiteChecks):
    site = "clients/rust-crucible.py"


class InstallerI001SuppressionTest(_SuppressionSiteChecks):
    site = "crucible_axi/install.py"


del _SuppressionSiteChecks


class SuppressionReaderTest(unittest.TestCase):
    """The reader splits a payload as pi-lens does, so a reason is judged
    on exactly the text pi-lens carries."""

    def test_em_dash_reason_is_split_from_the_rule_list(self):
        found = _i001_suppressions(
            ["# pi-lens-ignore: I001 \u2014 pi-lens's ruff config sets no "
             "target version, so ruff files tomllib as third-party",
             "import argparse  # noqa: I001"])
        self.assertEqual(len(found), 1)
        line, rules, reason = found[0]
        self.assertEqual((line, rules), (1, ["I001"]))
        self.assertTrue(reason.startswith("pi-lens's ruff config"), reason)
        self.assertEqual(
            [n for n, p in REQUIRED_CAUSE.items() if not p.search(reason)], [])

    def test_old_reason_lacks_the_cause_and_blames_the_floor(self):
        found = _i001_suppressions(
            ["# pi-lens-ignore: I001 \u2014 tomllib is stdlib (3.11+); ruff's "
             "default 3.10 target misfiles it as third-party"])
        _, _, reason = found[0]
        missing = [n for n, p in REQUIRED_CAUSE.items() if not p.search(reason)]
        self.assertEqual(missing,
                         ["pi-lens", "its ruff configuration",
                          "no target version"])
        self.assertRegex(reason, BLAMES_THE_OLD_FLOOR)

    def test_other_rules_are_not_read_as_i001(self):
        self.assertEqual(
            _i001_suppressions(["x = 1  # pi-lens-ignore: S314 -- parsed"]),
            [])

    def test_every_site_is_a_tracked_python_file(self):
        for site in SUPPRESSION_SITES:
            self.assertTrue((REPO_ROOT / site).is_file(), site)


if __name__ == "__main__":
    unittest.main()
