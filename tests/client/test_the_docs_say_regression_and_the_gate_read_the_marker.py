"""The docs say that `test`, `regression` and the gate read the `"test": true`
marker, and nothing still says that only `test` reads it.

- No sentence saying only `test` reads the marker (or that the gate ignores
  it) remains in: the CHANGELOG's `[Unreleased]` section,
  `docs/research/DN-crucible-live-test-progress.md`, `clients/bun-crucible.py`,
  or the tests that pinned the old rule. `docs/changes/` is historical and is
  not read.
- The CHANGELOG `[Unreleased]`:
  - its marker bullet names `regression` and the gate as readers, and the
    tier verbs as ignoring it;
  - a `### Changed` bullet says a bun project's `regression` and the gate's
    whole-suite step run the entry marked `"test": true`, and that coverage
    flags go only to a `bun-test` entry;
  - a "Stack declaration changes" bullet names the shipped schema version and
    says it exempts the marked entry from the bun gate's key rule, naming its
    readers.
- DN-crucible-live-test-progress: the marker sentence and the refusal bullet
  after it name `regression` and the gate.

Key phrases are pinned by containment, so the wording stays the writer's.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_docs_say_regression_and_the_gate_read_the_marker
"""

import json
import re
import unittest
from pathlib import Path

from tests.client.changelog_section import changelog_section

REPO_ROOT = Path(__file__).resolve().parents[2]
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
DN = REPO_ROOT / "docs" / "research" / "DN-crucible-live-test-progress.md"
BUN_CLIENT = REPO_ROOT / "clients" / "bun-crucible.py"
SCHEMA = REPO_ROOT / "clients" / "crucible-declaration.schema.json"
# The tests rewritten when the gate began reading the marker.
REWRITTEN_TESTS = tuple(REPO_ROOT / "tests" / "client" / name for name in (
    "test_the_bun_gate_runs_every_declared_frameworks_suite.py",
    "test_the_declaration_schema_is_documented.py",
    "test_the_declaration_schema_states_every_stacks_declaration.py",
    "test_the_clients_agree_with_the_declaration_schema.py",
    "test_bun_test_runs_the_target_its_table_marks.py",
))

MARKER = '`"test": true`'
# The old rule, in each form it was written in.
OLD_RULE = (
    re.compile(r"(?is)\bonly\s+`?test`?\s+reads\b"),
    re.compile(r"(?is)\bread\s+only\s+by\s+`?test`?"),
    re.compile(r"(?is)\bthe\s+gate\s+ignores?\b"),
    re.compile(r"(?is)\band\s+the\s+gate\s+ignore\b"),
    re.compile(r"(?is)marker[^.]{0,80}?changes\s+nothing\s+in\s+the\s+gate"),
)
GATE = re.compile(r"(?i)\bgate\b|`pre-merge-gate`")
REGRESSION = "`regression`"


def _subsection(body, title):
    found = re.search(rf"(?ms)^### {re.escape(title)}\n(.*?)(?=^### |\Z)", body)
    return found.group(1) if found else ""


def _bullets(text):
    """Each top-level bullet (with its sub-bullets) as one string."""
    return [b for b in re.split(r"\n(?=- )", text) if b.lstrip().startswith("- ")]


def _old_rule_found(text):
    return [m.group(0) for pattern in OLD_RULE for m in pattern.finditer(text)]


class NothingStillSaysOnlyTestReadsTheMarkerTest(unittest.TestCase):

    def assert_clean(self, name, text):
        self.assertTrue(text.strip(), f"{name} was read and is not empty")
        self.assertEqual(_old_rule_found(text), [],
                         f"{name} still says only `test` reads the marker")

    def test_the_changelogs_unreleased_section(self):
        self.assert_clean("CHANGELOG [Unreleased]",
                          changelog_section(CHANGELOG.read_text(encoding="utf-8")))

    def test_the_live_test_progress_design_note(self):
        self.assert_clean(DN.name, DN.read_text(encoding="utf-8"))

    def test_the_bun_client(self):
        self.assert_clean(BUN_CLIENT.name, BUN_CLIENT.read_text(encoding="utf-8"))

    def test_the_rewritten_tests(self):
        for path in REWRITTEN_TESTS:
            with self.subTest(path.name):
                self.assert_clean(path.name, path.read_text(encoding="utf-8"))


class TheChangelogSaysRegressionAndTheGateReadTheMarkerTest(unittest.TestCase):

    def setUp(self):
        self.unreleased = changelog_section(CHANGELOG.read_text(encoding="utf-8"))

    def test_the_marker_bullet_names_regression_and_the_gate_and_the_tier_verbs_ignoring_it(self):
        stack = _subsection(self.unreleased, "Stack declaration changes")
        bullets = [b for b in _bullets(stack) if MARKER in b and "tier verbs" in b]
        self.assertEqual(len(bullets), 1,
                         f"one bullet states the marker's readers; bullets={_bullets(stack)!r}")
        bullet = bullets[0] if bullets else ""
        self.assertIn(REGRESSION, bullet, bullet)
        self.assertRegex(bullet, GATE, bullet)
        self.assertRegex(bullet, r"(?i)tier\s+verbs\s+ignore", bullet)

    def test_a_changed_bullet_says_regression_and_the_gate_run_the_marked_entry_and_coverage_goes_only_to_bun_test(self):
        changed = _subsection(self.unreleased, "Changed")
        found = [b for b in _bullets(changed)
                 if REGRESSION in b and GATE.search(b) and MARKER in b
                 and "`bun-test`" in b and re.search(r"(?i)coverage", b)]
        self.assertEqual(len(found), 1,
                         f"one `### Changed` bullet names `regression`, the gate, the "
                         f"marked entry and coverage flags only to a `bun-test` entry; "
                         f"bullets={_bullets(changed)!r}")

    def test_a_version_bullet_names_the_marked_entrys_gate_exemption_and_its_readers(self):
        version = json.loads(SCHEMA.read_text(encoding="utf-8"))["version"]
        stack = _subsection(self.unreleased, "Stack declaration changes")
        found = [b for b in _bullets(stack)
                 if re.search(rf"(?i)\bversion\s+{version}\b", b)
                 and re.search(r"(?i)\bexempt", b)
                 and (MARKER in b or re.search(r"(?i)\bmarked\b", b))
                 and REGRESSION in b and GATE.search(b)]
        self.assertEqual(len(found), 1,
                         f"one bullet says version {version} exempts the marked entry "
                         f"from the gate's key rule and names its readers; "
                         f"bullets={_bullets(stack)!r}")

    def test_version_two_adding_the_go_stack_is_still_named(self):
        stack = _subsection(self.unreleased, "Stack declaration changes")
        self.assertIn("Version 2 adds the `go` stack", stack)


class TheDesignNoteSaysRegressionAndTheGateReadTheMarkerTest(unittest.TestCase):

    def setUp(self):
        self.text = DN.read_text(encoding="utf-8")

    def test_the_marker_sentence_names_regression_and_the_gate(self):
        sentences = [s for s in re.split(r"(?<=\.)\s+", self.text)
                     if re.search(r"(?i)\bread\w*\b[^.]{0,40}\bmarker\b", s)]
        naming = [s for s in sentences if REGRESSION in s and GATE.search(s)]
        self.assertTrue(naming,
                        f"a sentence saying who reads the marker names `regression` and "
                        f"the gate; candidates={sentences!r}")

    def test_the_refusal_bullet_names_regression_and_the_gate(self):
        bullets = [line for line in re.split(r"\n(?=\s*- )", self.text)
                   if "two marked entries" in line]
        self.assertEqual(len(bullets), 1, f"bullets={bullets!r}")
        bullet = bullets[0] if bullets else ""
        self.assertIn(REGRESSION, bullet, bullet)
        self.assertRegex(bullet, GATE, bullet)


if __name__ == "__main__":
    unittest.main()
