"""The board's fall-through is written where an operator reads it.

A client takes `[client] url` from the first `crucible.toml` that declares a
non-empty one -- the project's, then the install's. A file without one is
passed over, and with no file declaring one the client refuses: there is no
shipped last resort. An envelope names `context.board` only when the resolved
board differs from the install's declared `url` (always, when the install
declares none).

Two files carry that to an operator, and both are read here as files:

- the shipped `clients/crucible.toml`: its board section -- a commented
  `[client]` table, since the file declares no board -- states the
  fall-through, in the sentence the change gives it, and no longer says the
  install's file is not read;
- `docs/RUNBOOK.md`: its `[client]` section names the two steps in order, says
  a file without a `url` is passed over and a client with none refuses, and
  every paragraph naming `context.board` keys the rule off the install's
  declared board with no shipped one.
"""

import re
import unittest
from pathlib import Path

from tests.client.a_clients_board_is_its_projects_configuration_helpers import CONFIG_NAME
from tests.client import CLIENT_SOURCE_DIR

REPO_ROOT = Path(__file__).resolve().parents[3]
SHIPPED_CONFIG = CLIENT_SOURCE_DIR / CONFIG_NAME
RUNBOOK = REPO_ROOT / "docs" / "RUNBOOK.md"

#: The sentence the shipped `[client]` comment carries for the fall-through,
#: word for word as the change states it.
FALL_THROUGH_SENTENCE = (
    "A project file declaring no `url` here is passed over for the install's.")

#: The sentence it replaces, which states the old first-file-wins rule.
RETIRED_SENTENCE = "the install's is not read"

#: The two steps of the chain, in precedence order, then the refusal.
CHAIN_STEPS = ("project", "install", "refus")

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


def commented_client_section(text):
    """The shipped file's board section: from the `# ──` banner that precedes
    its `[client]` header (live or commented out) to the next live table
    header, or the end of the file. None when no `[client]` header is found."""
    lines = text.split("\n")
    header = next((i for i, line in enumerate(lines)
                   if re.match(r"^\s*#?\s*\[client\]\s*(#.*)?$", line)), None)
    if header is None:
        return None
    start = header
    for i in range(header - 1, -1, -1):
        if lines[i].lstrip().startswith("# ──"):
            start = i
            break
        if re.match(r"^\s*\[", lines[i]):
            break
    end = next((i for i in range(header + 1, len(lines))
                if re.match(r"^\s*\[[^\]]+\]\s*(#.*)?$", lines[i])), len(lines))
    return "\n".join(re.sub(r"^\s*#\s?", "", line) for line in lines[start:end])


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
    """The board section of the shipped `clients/crucible.toml`, whose
    `[client]` table is commented out."""

    def setUp(self):
        section = commented_client_section(SHIPPED_CONFIG.read_text(encoding="utf-8"))
        self.assertIsNotNone(
            section, f"{SHIPPED_CONFIG} must keep a (commented) `[client]` section")
        self.prose = normalise(section)

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

    def test_the_client_section_names_project_then_install_then_the_refusal(self):
        """The chain's two steps in order, then the refusal; no shipped step."""
        section = normalise(self.section)
        self.assertTrue(
            names_in_order(section, CHAIN_STEPS),
            f"the RUNBOOK's `[client]` section must name the chain's two "
            f"steps in order -- the project's file, then the install's -- and "
            f"then say a client with neither refuses; it reads {section!r}")
        self.assertNotIn(
            "then the shipped", section.lower(),
            f"the chain has no shipped step; it reads {section!r}")

    def test_the_client_section_says_a_file_without_a_url_is_passed_over(self):
        """Fails today: the section says nothing of a file being skipped."""
        section = normalise(self.section).lower()
        self.assertTrue(
            any(words in section for words in PASS_OVER_WORDS),
            f"the RUNBOOK's `[client]` section must say a file that declares "
            f"no `url` is passed over for the next one (one of "
            f"{PASS_OVER_WORDS!r}); it reads {section!r}")

    def test_every_context_board_paragraph_keys_off_the_installs_declared_board(self):
        """Each paragraph naming `context.board` compares the board with the
        install's declared `url` and names no shipped one."""
        paragraphs = paragraphs_naming(self.text, "context.board")
        self.assertNotEqual(paragraphs, [],
                            f"{RUNBOOK} must still describe `context.board`")
        offenders = [p for p in paragraphs
                     if "install" not in p.lower() or "shipped" in p.lower()]
        self.assertEqual(
            offenders, [],
            "every RUNBOOK paragraph naming `context.board` must say it is "
            "named when the board differs from the install's declared `url`, "
            f"and name no shipped board; these do not: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
