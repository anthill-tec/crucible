"""The coverage a run's envelope states, `run --files` and a gate's
`coverageRuns` are documented, and the `run` verb's help names `--files`.

  * The changelog names every key of the `coverage` block and every key of
    one of its file rows, `run --files`, and `coverageRuns`, in whichever
    release section records them.
  * `README.md` and `docs/RUNBOOK.md` each name the `coverage` block,
    `--files` and `coverageRuns`.
  * `docs/research/PRD-crucible-v2.md` names `coverageRuns` in its bullet on
    the gate running every declared framework, which names the composed
    envelope's keys, and names every key of the block and of a file row.
  * The `run` verb's help names `--files`, in every client that has the verb.

Names are pinned, never sentences. A key counts as named when it stands as a
code span of its own.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_runs_coverage_files_are_documented
"""

import argparse
import re
import unittest
from pathlib import Path

from tests.client.changelog_section import changelog_entries, changelog_section
from tests.client.kept_coverage_answer import FILE_KEYS, ROW_KEYS
from tests.client.stored_run_coverage import RUN_VERB_CLIENTS
from tests.client.client_fleet_envelope_census_helpers import enumerate_verbs

REPO_ROOT = Path(__file__).resolve().parents[2]
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
README = REPO_ROOT / "README.md"
RUNBOOK = REPO_ROOT / "docs" / "RUNBOOK.md"
PRD = REPO_ROOT / "docs" / "research" / "PRD-crucible-v2.md"

#: Every key of the block, then every key of one of its file rows.
BLOCK_KEYS = ("lines", "functions", *FILE_KEYS)
GATE_KEY = "coverageRuns"
FLAG = "--files"
#: The bullet of the product document that names a composed gate's keys.
GATE_BULLET_HEAD = "**The gate runs every declared framework.**"


def gate_bullet(text):
    """The product document's bullet on the gate running every declared
    framework: from its head to the next bullet at its own indent."""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if GATE_BULLET_HEAD in line:
            indent = line[:len(line) - len(line.lstrip())]
            body = [line]
            for following in lines[index + 1:]:
                if following.startswith(indent + "- ") or (
                        following.strip() and not following.startswith(indent)):
                    break
                body.append(following)
            return "\n".join(body)
    return ""


def names_as_a_code_span(text, name):
    return f"`{name}`" in text


def names_run_with_the_flag(text):
    """`run … --files` in one code span: `run --files`, or the verb with its
    event id before the flag."""
    return re.search(r"`[^`\n]*\brun\b[^`\n]*--files[^`\n]*`", text) is not None


def not_named(text, names):
    return [name for name in names if not names_as_a_code_span(text, name)]


class TheReadersReadWhatTheyAreAskedTest(unittest.TestCase):
    """Proofs of the readers above, on text written here."""

    def test_the_section_is_the_body_under_the_topmost_heading_and_nothing_below(self):
        text = ("# Changelog\n\n## [0.4.0] - 2026-11-14\n\n- `fileCount` here\n\n"
                "## [0.3.0] - 2026-10-10\n\n- `moreFiles` there\n")
        body = changelog_section(text)
        self.assertIn("`fileCount`", body)
        self.assertNotIn("moreFiles", body)
        self.assertEqual(changelog_section("# Changelog\n\n- `fileCount` here\n"), "")
        entries = changelog_entries(text)
        self.assertIn("`fileCount`", entries)
        self.assertIn("`moreFiles`", entries)
        self.assertEqual(changelog_entries("# Changelog\n\n- `fileCount` here\n"), "")

    def test_the_gate_bullet_ends_at_the_next_bullet_of_its_indent(self):
        text = ("- outer\n"
                f"  - {GATE_BULLET_HEAD} its keys are `scope`\n"
                "    and `coverageRuns`.\n"
                "  - **Another bullet.** `moreFiles`\n")
        bullet = gate_bullet(text)
        self.assertIn("`coverageRuns`", bullet)
        self.assertNotIn("moreFiles", bullet)
        self.assertEqual(gate_bullet("- no such bullet\n"), "")

    def test_a_key_is_named_only_as_a_code_span_of_its_own(self):
        self.assertEqual(not_named("the `files` of `{path, lines}`", ("files", "lines")),
                         ["lines"])

    def test_run_with_the_flag_is_one_code_span(self):
        self.assertTrue(names_run_with_the_flag("see `run --files <n>|all`"))
        self.assertTrue(names_run_with_the_flag("`run <event-id> --files all` lists"))
        self.assertFalse(names_run_with_the_flag("`run` reads it; `--files` too"))
        self.assertFalse(names_run_with_the_flag("`runs --files`"))

    def test_the_documents_and_the_bullet_are_there_to_read(self):
        for path in (CHANGELOG, README, RUNBOOK, PRD):
            self.assertTrue(path.is_file(), f"{path} is a file")
        self.assertNotEqual(changelog_entries(CHANGELOG.read_text(encoding="utf-8")).strip(), "",
                            "the changelog has entries to read")
        self.assertIn(GATE_BULLET_HEAD,
                      gate_bullet(PRD.read_text(encoding="utf-8")),
                      "the product document has the gate's bullet")


class TheChangelogNamesTheBlockTheFlagAndTheGatesRowsTest(unittest.TestCase):

    def setUp(self):
        self.body = changelog_entries(CHANGELOG.read_text(encoding="utf-8"))

    def test_unreleased_names_every_key_of_the_block(self):
        self.assertEqual(not_named(self.body, BLOCK_KEYS), [],
                         "the changelog names each key of the "
                         "`coverage` block as a code span")

    def test_unreleased_names_every_key_of_a_file_row(self):
        self.assertEqual(not_named(self.body, ROW_KEYS), [],
                         "the changelog names each key of a file "
                         "row as a code span")

    def test_unreleased_names_run_with_its_files_flag(self):
        self.assertTrue(names_run_with_the_flag(self.body),
                        "the changelog names `run --files`")

    def test_unreleased_names_the_gates_coverage_runs(self):
        self.assertEqual(not_named(self.body, (GATE_KEY,)), [],
                         "the changelog names `coverageRuns`")


class TheReadmeAndTheRunbookNameThemTest(unittest.TestCase):

    def assertNamesTheThree(self, path):
        text = path.read_text(encoding="utf-8")
        missing = not_named(text, ("coverage", GATE_KEY))
        if FLAG not in text:
            missing.append(FLAG)
        self.assertEqual(missing, [],
                         f"{path.relative_to(REPO_ROOT)} names the `coverage` "
                         f"block, `--files` and `coverageRuns`")

    def test_the_readme_names_the_block_the_flag_and_the_gates_rows(self):
        self.assertNamesTheThree(README)

    def test_the_runbook_names_the_block_the_flag_and_the_gates_rows(self):
        self.assertNamesTheThree(RUNBOOK)


class TheProductDocumentNamesThemTest(unittest.TestCase):

    def setUp(self):
        self.text = PRD.read_text(encoding="utf-8")

    def test_the_bullet_on_the_gate_names_coverage_runs(self):
        self.assertEqual(not_named(gate_bullet(self.text), (GATE_KEY,)), [],
                         "the bullet on the gate running every declared "
                         "framework names `coverageRuns` among the composed "
                         "envelope's keys")

    def test_the_product_document_names_every_key_of_the_block_and_of_a_file_row(self):
        self.assertEqual(not_named(self.text, (*BLOCK_KEYS, *ROW_KEYS)), [],
                         "docs/research/PRD-crucible-v2.md names each key of "
                         "the `coverage` block and of a file row as a code span")


class TheRunVerbsHelpNamesTheFlagTest(unittest.TestCase):

    def run_parser(self, client):
        verbs = enumerate_verbs(f"documented_{client}", RUN_VERB_CLIENTS[client])
        self.assertIn("run", verbs, f"{client}: the client has the `run` verb")
        return verbs["run"]

    def test_every_client_that_has_the_verb_is_read(self):
        # A guard: the six clients each register `run`.
        self.assertEqual(sorted(RUN_VERB_CLIENTS),
                         ["arduino", "bun", "go", "mvn", "python", "rust"])
        for client in RUN_VERB_CLIENTS:
            with self.subTest(client=client):
                self.assertIn("event-id", self.run_parser(client).format_help())

    def test_the_run_verbs_help_names_files_in_every_client(self):
        for client in sorted(RUN_VERB_CLIENTS):
            with self.subTest(client=client):
                self.assertIn(FLAG, self.run_parser(client).format_help(),
                              f"{client}: `run --help` names `--files`")

    def test_the_files_flag_describes_itself_in_every_client(self):
        for client in sorted(RUN_VERB_CLIENTS):
            with self.subTest(client=client):
                described = [action.help for action in self.run_parser(client)._actions
                             if FLAG in action.option_strings]
                self.assertEqual(len(described), 1,
                                 f"{client}: `run` takes one `--files`")
                text = described[0]
                self.assertIsInstance(text, str, f"{client}: help={text!r}")
                self.assertNotEqual(text, argparse.SUPPRESS, client)
                self.assertIn("all", text,
                              f"{client}: the flag's help names `all`; help={text!r}")


if __name__ == "__main__":
    unittest.main()
