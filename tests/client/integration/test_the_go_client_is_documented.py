"""The go client's own help names its build-tag tiers.

`go-crucible.py --help`, as printed, names every fact of go's build-tag
tiers, lists the tier verbs, and nowhere says go declares no tier.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_go_client_is_documented
"""

import re
import subprocess
import sys
import unittest

from tests.client import client_script

GO_CLIENT = "go-crucible.py"
GO_HELP_CLIENT = client_script(GO_CLIENT)
TIER_VERBS = ("unit", "module", "integration", "e2e", "bdd")


#: fact name -> the key words the help must carry, every one. A verb is
#: written bare (`unit, module, ...`), as argparse lists it.
GO_TIER_FACTS = {
    "the tier verbs": [re.compile(rf"\b{t}\b") for t in TIER_VERBS],
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


def _go_help():
    """`go-crucible.py --help`, as printed."""
    ran = subprocess.run([sys.executable, str(GO_HELP_CLIENT), "--help"],
                         capture_output=True, text=True, timeout=60, check=False)
    if ran.returncode != 0:
        raise AssertionError(f"--help exit={ran.returncode} err={ran.stderr[-600:]!r}")
    return ran.stdout


class TheGoHelpNamesItsTiersTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.help = _go_help()

    def test_names_every_fact_of_gos_build_tag_tiers(self):
        missing = [fact for fact, words in GO_TIER_FACTS.items()
                   if not all(w.search(self.help) for w in words)]
        self.assertEqual(missing, [], "the help does not name these facts")

    def test_nothing_says_go_declares_no_tier(self):
        found = [m.group() for pattern in GO_DECLARES_NO_TIER
                 for m in pattern.finditer(self.help)]
        self.assertEqual(found, [], "these say go declares no tier")

    def test_names_the_tier_verbs(self):
        listed = re.search(r"\{([^{}]*)\}", self.help)
        verbs = set((listed.group(1) if listed else "").split(","))
        self.assertEqual(sorted(set(TIER_VERBS) - verbs), [], f"the verbs: {sorted(verbs)}")


if __name__ == "__main__":
    unittest.main()
