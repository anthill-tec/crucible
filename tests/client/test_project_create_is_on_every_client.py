"""Every one of the six clients -- bun, python, mvn, rust, arduino, go -- has
`project-create`, with the same flags, the same help line and the same
envelope.

- The flags, read off each client's real argparse: `--project-dir`
  (required), `--name`, `--token`, `--agent`, `--acronym`, `--type`
  (`backend`|`frontend`), `--set` (repeatable) and `--write-env`.
- The help line, read with `ast` from each client's own
  `add_parser("project-create", help=…)` call, is exactly the spec's text.
- One end-to-end run per client against the recording board double gives the
  same envelope field set, holding `projectKey`, `created`, `source`, `name`,
  `metadata`, `envWritten` and `help`.

Fails today: no client registers `project-create`.
"""

import argparse
import ast
import unittest

from tests.client.project_create_harness import (
    CLIENT_SCRIPTS,
    CLIENTS_DIR,
    ENVELOPE_FIELDS,
    ENVELOPE_HELP,
    PROJECT_CREATE_HELP,
    VERB,
    BoardDoubleMixin,
    key_for_token,
)
from tests.client.client_fleet_envelope_census_helpers import enumerate_verbs


def _add_parser_help(path, verb):
    """The `help=` constant of `verb`'s own `add_parser(...)` call in the
    source at `path`, or None when there is no such call."""
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_parser"):
            continue
        if not node.args or not isinstance(node.args[0], ast.Constant):
            continue
        if node.args[0].value != verb:
            continue
        for kw in node.keywords:
            if kw.arg == "help" and isinstance(kw.value, ast.Constant):
                return kw.value.value
    return None


def _flags(subparser):
    """`{option string: action}` of a subparser."""
    return {opt: action for action in subparser._actions
            for opt in action.option_strings}


class ProjectCreateParsesOnEveryClientTest(unittest.TestCase):

    def test_every_client_declares_the_verbs_help_line_exactly(self):
        found = {client: _add_parser_help(CLIENTS_DIR / script, VERB)
                 for client, script in CLIENT_SCRIPTS.items()}
        self.assertEqual(found, dict.fromkeys(CLIENT_SCRIPTS, PROJECT_CREATE_HELP))

    def test_every_client_parses_the_verbs_flags(self):
        for client, script in CLIENT_SCRIPTS.items():
            with self.subTest(client=client):
                verbs = enumerate_verbs(client, CLIENTS_DIR / script)
                self.assertIn(VERB, verbs, f"{client} has no {VERB} subcommand")
                flags = _flags(verbs[VERB])
                for flag in ("--project-dir", "--name", "--token", "--agent",
                             "--acronym", "--type", "--set", "--write-env"):
                    self.assertIn(flag, flags, f"{client}: {flag}")
                self.assertTrue(flags["--project-dir"].required,
                                f"{client}: --project-dir is required")
                self.assertEqual(sorted(flags["--type"].choices or []),
                                 ["backend", "frontend"])
                self.assertIsInstance(flags["--set"], argparse._AppendAction)
                self.assertIsInstance(flags["--write-env"], argparse._StoreTrueAction)


class ProjectCreateEnvelopeIsTheSameOnEveryClientTest(BoardDoubleMixin, unittest.TestCase):

    def test_one_run_per_client_gives_the_same_envelope_field_set(self):
        envelopes = {}
        for client in CLIENT_SCRIPTS:
            token = f"fleet-{client}"
            root = self.project_root()
            result, axi = self.run_verb(root, client=client, token=token)
            with self.subTest(client=client):
                self.assertEqual(result.returncode, 0,
                                 f"{client}: stderr={result.stderr!r}")
                self.assertEqual(axi.get("verb"), VERB, f"{client}: {result.stdout!r}")
                self.assertIs(axi.get("ok"), True)
                self.assertEqual(axi.get("projectKey"), key_for_token(token))
                self.assertIs(axi.get("created"), True)
                self.assertEqual(axi.get("source"), "token")
                self.assertEqual(axi.get("name"), "Widget Works")
                self.assertEqual(axi.get("metadata"), {"PROJECT_TOKEN": token})
                self.assertEqual(axi.get("envWritten"), "not-asked")
                self.assertEqual(axi.get("help"), ENVELOPE_HELP)
                for field in ENVELOPE_FIELDS:
                    self.assertIn(field, axi, f"{client}: {field}")
            envelopes[client] = set(axi)
        self.assertEqual(len(envelopes), len(CLIENT_SCRIPTS))
        self.assertEqual(envelopes,
                         dict.fromkeys(CLIENT_SCRIPTS, envelopes["python"]),
                         "every client's envelope carries the same fields")


if __name__ == "__main__":
    unittest.main()
