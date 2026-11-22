"""Every flag of every client describes itself.

Each client's real argparse parser is built in process (`enumerate_verbs`,
which stops `main()` at its one `parse_args()` call, before any dispatch), and
every action of every verb, at any depth, is read off it. Each one but the
`help` action itself must carry a non-empty `help` string.
"""

import argparse
import unittest
from pathlib import Path

from tests.client import client_script
from tests.client.client_fleet_envelope_census_helpers import enumerate_verbs
from tests.client.client_tier_surface_helpers import CLIENT_FILES


def _undescribed(where, parser):
    """`where` + the name of every action of `parser`, and of the verbs under
    it, whose help is missing, empty or suppressed."""
    found = []
    for action in parser._actions:
        if isinstance(action, argparse._HelpAction):
            continue
        if isinstance(action, argparse._SubParsersAction):
            for verb, subparser in action.choices.items():
                found.extend(_undescribed(f"{where} {verb}", subparser))
            continue
        text = action.help
        if not isinstance(text, str) or text == argparse.SUPPRESS or not text.strip():
            name = "/".join(action.option_strings) or action.dest
            found.append(f"{where} {name}: help {text!r}")
    return found


class EveryFlagOfEveryClientHasHelpTextTest(unittest.TestCase):

    def test_every_action_of_every_verb_carries_a_help_string(self):
        undescribed = []
        verb_count = 0
        for client, path in sorted(CLIENT_FILES.items()):
            verbs = enumerate_verbs(client, client_script(Path(path).name))
            verb_count += len(verbs)
            for verb, subparser in sorted(verbs.items()):
                undescribed.extend(_undescribed(f"{client} {verb}", subparser))
        self.assertGreater(verb_count, len(CLIENT_FILES),
                           "the parsers were read: every client offers verbs")
        self.assertEqual([], undescribed,
                         "every flag describes itself:\n  " + "\n  ".join(undescribed))


if __name__ == "__main__":
    unittest.main()
