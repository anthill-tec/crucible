"""No request `project-create` makes carries an empty or non-UUID project key.

`project-create` is the one verb that runs where `.env` may hold no key, so it
never reads the key the way the other verbs do. Across every path it takes --
a new project, the same token again, a known key in `.env`, an unknown or
archived one, an archived token project, a role conflict, a refused register
or PATCH, an empty key line written with `--write-env` -- every key a request
carries, in its path (`/api/v2/projects/<key>/…`), its query (`project=`) or
its body (`key`, `projectKey`), is a UUID.

Each scenario must also have reached the board (its envelope names the verb,
and the double recorded a request), so the check is never satisfied by a verb
that sent nothing.

Fails today: no client has a `project-create` subcommand, so no scenario
reaches the board.
"""

import unittest

from tests.client.project_create_harness import (
    BoardDoubleMixin,
    empty_or_malformed_keys,
    key_for_token,
)

TOKEN = "keyed-paths"  # noqa: S105 -- a project token, not a secret
HAND_KEY = "0190a5c4-3333-7000-8000-000000000123"
AGENT = "orch-1"


def _new_project(board):
    return None


def _zero_byte_env(board):
    return b""


def _same_token_again(board):
    board.add_project(key_for_token(TOKEN), name="earlier run")
    return None


def _known_env_key(board):
    board.add_project(HAND_KEY, name="by hand")
    return f"CRUCIBLE_PROJECT_KEY={HAND_KEY}\n".encode()


def _unknown_env_key(board):
    return f"CRUCIBLE_PROJECT_KEY={HAND_KEY}\n".encode()


def _archived_env_key(board):
    board.add_project(HAND_KEY, archived=True)
    return f"CRUCIBLE_PROJECT_KEY={HAND_KEY}\n".encode()


def _archived_token_project(board):
    board.add_project(key_for_token(TOKEN), archived=True)
    return None


def _role_conflict(board):
    board.add_project(key_for_token(TOKEN))
    board.add_agent(key_for_token(TOKEN), AGENT, "ORCHESTRATOR", bound_cycle_id=3)
    return None


def _refused_register(board):
    board.refuse("register", 404, {"ok": False, "error": "project is archived: x"})
    return None


def _refused_patch(board):
    board.refuse("patch", 409, {"ok": False, "error": "refused"})
    return None


def _empty_key_line(board):
    return b"A=1\nCRUCIBLE_PROJECT_KEY=\n"


def _whitespace_key_line(board):
    return b"CRUCIBLE_PROJECT_KEY=   \n"


SCENARIOS = (
    ("a new project", _new_project),
    ("a zero-byte .env", _zero_byte_env),
    ("the same token again", _same_token_again),
    ("a known key in .env", _known_env_key),
    ("an unknown key in .env", _unknown_env_key),
    ("an archived key in .env", _archived_env_key),
    ("the token's project archived", _archived_token_project),
    ("an agent role conflict", _role_conflict),
    ("a refused register", _refused_register),
    ("a refused patch", _refused_patch),
    ("an empty key line", _empty_key_line),
    ("a whitespace-only key line", _whitespace_key_line),
)


class ProjectCreateNeverSendsAnEmptyProjectKeyTest(BoardDoubleMixin, unittest.TestCase):

    def test_every_request_on_every_path_carries_a_uuid_project_key(self):
        for label, arrange in SCENARIOS:
            with self.subTest(scenario=label):
                self.board.reset()
                env = arrange(self.board)
                root = self.project_root(env)
                result, axi = self.run_verb(root, "--write-env", token=TOKEN, agent=AGENT)

                self.assertEqual(axi.get("verb"), "project-create",
                                 f"{label}: the verb ran; stderr={result.stderr!r}")
                self.assertTrue(self.board.requests,
                                f"{label}: the scenario reached the board")
                self.assertEqual(empty_or_malformed_keys(self.board.requests), [],
                                 f"{label}: {self.board.requests!r}")


if __name__ == "__main__":
    unittest.main()
