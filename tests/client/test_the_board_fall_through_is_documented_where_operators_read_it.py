"""The board's fall-through is written where an operator reads it.

A client takes `[client] url` from the first `crucible.toml` that declares a
non-empty one -- the project's, then the install's -- and falls back to the
shipped declaration last. A file without one is passed over. And an envelope
names `context.board` only when the resolved board differs from the install's
declared `url`, or from the shipped one when the install declares none.

Two files carry that to an operator, and both are read here as files:

- the shipped `clients/crucible.toml`: the prose inside its `[client]` table
  states the fall-through, in the sentence the change gives it, and no longer
  says the install's file is not read;
- `docs/RUNBOOK.md`: its `[client]` section names the three steps in order and
  says a file without a `url` is passed over, and every paragraph naming
  `context.board` keys the rule off the install's declared board.
"""

import re
import unittest
from pathlib import Path

from tests.client.test_a_clients_board_is_its_projects_configuration import (
    CONFIG_NAME,
    _table_prose,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SHIPPED_CONFIG = REPO_ROOT / "clients" / CONFIG_NAME
RUNBOOK = REPO_ROOT / "docs" / "RUNBOOK.md"

#: The sentence the shipped `[client]` comment carries for the fall-through,
#: word for word as the change states it.
FALL_THROUGH_SENTENCE = (
    "A project file declaring no `url` here is passed over for the install's.")

#: The sentence it replaces, which states the old first-file-wins rule.
RETIRED_SENTENCE = "the install's is not read"

#: The three steps of the chain, in precedence order.
CHAIN_STEPS = ("project", "install", "shipped")

#: The words a RUNBOOK may use for a file being skipped for the next one.
PASS_OVER_WORDS = ("passed over", "falls through", "fall through")


def normalise(text):
    """Every run of whitespace is one space."""
    return re.sub(r"\s+", " ", text or "").strip()


def names_in_order(text, words):
    lowered = text.lower()
    position = -1
    for word in words:
        position = lowered.find(word, position + 1)
        if position < 0:
            return False
    return True


def runbook_client_section(text):
    """The RUNBOOK section whose heading names `[client]`: from that heading
    to the next heading of any level."""
    lines = text.split("\n")
    start = next((i for i, line in enumerate(lines)
                  if line.startswith("#") and "`[client]`" in line), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines))
                if lines[i].startswith("#")), len(lines))
    return "\n".join(lines[start:end])


def paragraphs_naming(text, needle):
    """Every blank-line-separated paragraph of `text` that contains `needle`."""
    return [normalise(p) for p in re.split(r"\n\s*\n", text) if needle in p]


class TheShippedClientCommentStatesTheFallThroughTest(unittest.TestCase):
    """The `[client]` table of the shipped `clients/crucible.toml`."""

    def setUp(self):
        self.prose = normalise(
            _table_prose(SHIPPED_CONFIG.read_text(encoding="utf-8"), "client"))

    def test_the_client_comment_says_a_project_file_naming_no_url_is_passed_over(self):
        """Fails today: the comment says the project file still wins."""
        self.assertIn(
            FALL_THROUGH_SENTENCE, self.prose,
            f"the `[client]` comment in {SHIPPED_CONFIG} must state the "
            f"fall-through as {FALL_THROUGH_SENTENCE!r}; its prose is "
            f"{self.prose!r}")

    def test_the_client_comment_no_longer_says_the_installs_file_is_not_read(self):
        """Fails today: the retired sentence is still there."""
        self.assertNotIn(
            RETIRED_SENTENCE, self.prose.lower(),
            f"the `[client]` comment must no longer say "
            f"{RETIRED_SENTENCE!r}; its prose is {self.prose!r}")


class TheRunbookDescribesTheChainAndTheContextBoardRuleTest(unittest.TestCase):
    """`docs/RUNBOOK.md`'s `[client]` section and its `context.board` text."""

    def setUp(self):
        self.text = RUNBOOK.read_text(encoding="utf-8")
        self.section = runbook_client_section(self.text)
        self.assertIsNotNone(
            self.section, f"{RUNBOOK} must keep a section headed with `[client]`")

    def test_the_client_section_names_project_then_install_then_shipped(self):
        """Fails today: the section never names the install's file."""
        section = normalise(self.section)
        self.assertTrue(
            names_in_order(section, CHAIN_STEPS),
            f"the RUNBOOK's `[client]` section must name the chain's three "
            f"steps in order -- the project's file, then the install's, then "
            f"the shipped one; it reads {section!r}")

    def test_the_client_section_says_a_file_without_a_url_is_passed_over(self):
        """Fails today: the section says nothing of a file being skipped."""
        section = normalise(self.section).lower()
        self.assertTrue(
            any(words in section for words in PASS_OVER_WORDS),
            f"the RUNBOOK's `[client]` section must say a file that declares "
            f"no `url` is passed over for the next one (one of "
            f"{PASS_OVER_WORDS!r}); it reads {section!r}")

    def test_every_context_board_paragraph_keys_off_the_installs_declared_board(self):
        """Fails today: the one paragraph naming `context.board` compares the
        board with the shipped one only."""
        paragraphs = paragraphs_naming(self.text, "context.board")
        self.assertNotEqual(paragraphs, [],
                            f"{RUNBOOK} must still describe `context.board`")
        offenders = [p for p in paragraphs
                     if "install" not in p.lower() or "shipped" not in p.lower()]
        self.assertEqual(
            offenders, [],
            "every RUNBOOK paragraph naming `context.board` must say it is "
            "named when the board differs from the install's declared `url`, "
            "or from the shipped one when the install declares none; these "
            f"do not: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
