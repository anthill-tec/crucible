"""`project-create` creates a project on the board, or finds it, by its token.

A board that does not know the token's key gets exactly one
`POST /api/v2/projects` carrying `{key, name, type, sutRoot}`, the key being
the token's (`project_key_for_token`), and the envelope answers that key with
`created: true`, `source: token`. A second run with the same token answers the
same key with `created: false` and leaves one project. A UUID key already in
`.env` that the board knows is used as it stands, with no create; one the board
does not know, or holds archived, or a value that is no UUID at all, is refused
with nothing posted and `.env` untouched; so is a token whose project the board
holds archived. The create carries no agent.

Driven through the public surface only: a real `python-crucible.py
project-create` subprocess from a scratch copy of the fleet, against the
recording board double in `tests/client/project_create_harness.py`.

Fails today: no client has a `project-create` subcommand, so every drive is
argparse's "invalid choice" (exit 2, no envelope, no request).
"""

import os
import shutil
import unittest

from tests.client.project_create_harness import (
    ARCHIVED_PROJECT_HELP,
    ENVELOPE_HELP,
    BoardDouble,
    BoardDoubleMixin,
    ScratchFleet,
    closed_port_url,
    drive,
    empty_or_malformed_keys,
    key_for_token,
    make_project_dir,
    names_code,
)

TOKEN = "widget-works"  # noqa: S105 -- a project token, not a secret
OTHER_KEY = "0190a5c4-1111-7000-8000-00000000abcd"


class ProjectCreateCreatesTheTokensProjectTest(BoardDoubleMixin, unittest.TestCase):
    """A board that does not know the token: one create, its key answered."""

    def test_an_unknown_token_posts_exactly_one_create_with_the_tokens_key_name_type_and_absolute_root(self):
        root = self.project_root()
        key = key_for_token(TOKEN)
        # A relative --project-dir, run from its parent, so "made absolute"
        # is observable in the posted `sutRoot`.
        result, axi = self.run_verb(root, project_dir_arg=root.name,
                                    cwd=root.parent)

        self.assertEqual(result.returncode, 0,
                         f"exit 0 expected; stderr={result.stderr!r}")
        creates = self.board.creates()
        self.assertEqual(len(creates), 1,
                         f"exactly one POST /api/v2/projects; got {self.board.requests!r}")
        self.assertEqual(creates[0][2], {"key": key, "name": "Widget Works",
                                         "type": "backend",
                                         "sutRoot": os.path.abspath(root)})
        self.assertTrue(axi, f"no envelope on stdout: {result.stdout!r}")
        self.assertEqual(axi.get("verb"), "project-create")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("projectKey"), key)
        self.assertIs(axi.get("created"), True)
        self.assertEqual(axi.get("source"), "token")
        self.assertEqual(axi.get("name"), "Widget Works")
        self.assertEqual(axi.get("help"), ENVELOPE_HELP)

    def test_the_requests_run_in_the_specified_order_archived_check_create_agents_register_patch(self):
        root = self.project_root()
        key = key_for_token(TOKEN)
        result, _axi = self.run_verb(root)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            [(m, p) for m, p, _b in self.board.requests],
            [("GET", "/api/v2/projects?archived=true"),
             ("POST", "/api/v2/projects"),
             ("GET", f"/api/v2/agents?project={key}"),
             ("POST", "/api/v2/agents/register"),
             ("PATCH", f"/api/v2/projects/{key}/metadata")])
        self.assertEqual(empty_or_malformed_keys(self.board.requests), [])

    def test_type_frontend_posts_type_frontend(self):
        root = self.project_root()
        result, axi = self.run_verb(root, "--type", "frontend")

        self.assertEqual(result.returncode, 0, result.stderr)
        creates = self.board.creates()
        self.assertEqual(len(creates), 1, self.board.requests)
        self.assertEqual(creates[0][2].get("type"), "frontend")
        self.assertEqual(self.board.projects[key_for_token(TOKEN)]["type"], "frontend")
        self.assertIs(axi.get("ok"), True)

    def test_the_create_post_carries_no_agent_identity(self):
        root = self.project_root()
        result, _axi = self.run_verb(root)

        self.assertEqual(result.returncode, 0, result.stderr)
        creates = self.board.creates()
        self.assertEqual(len(creates), 1, self.board.requests)
        self.assertEqual(set(creates[0][2]), {"key", "name", "type", "sutRoot"},
                         "the create posts the four project fields and no agent")

    def test_a_board_with_no_agent_registered_anywhere_accepts_the_create(self):
        self.assertEqual(self.board.agents, [])
        root = self.project_root()
        result, axi = self.run_verb(root)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.board.project_rows(key_for_token(TOKEN))), 1)
        self.assertIs(axi.get("created"), True)

    def test_the_stderr_line_states_ok_key_and_created(self):
        root = self.project_root()
        key = key_for_token(TOKEN)
        result, _axi = self.run_verb(root)

        self.assertIn(f"project-create: ok=True key={key} created=True",
                      result.stderr)

    def test_without_write_env_no_env_file_is_created_and_env_written_is_not_asked(self):
        root = self.project_root()
        result, axi = self.run_verb(root)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((root / ".env").exists(),
                         "without --write-env the verb never writes .env")
        self.assertEqual(axi.get("envWritten"), "not-asked")


class ProjectCreateIsIdempotentByTokenTest(BoardDoubleMixin, unittest.TestCase):
    """The same token twice: one project, the same key, `created: false`."""

    def test_a_second_run_with_the_same_token_and_another_name_answers_the_same_key_not_created(self):
        key = key_for_token(TOKEN)
        first, first_axi = self.run_verb(self.project_root(), name="First Name")
        second, second_axi = self.run_verb(self.project_root(), name="Second Name")

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first_axi.get("projectKey"), key)
        self.assertIs(first_axi.get("created"), True)
        self.assertEqual(second_axi.get("projectKey"), key)
        self.assertIs(second_axi.get("created"), False)
        self.assertEqual(second_axi.get("source"), "token")
        self.assertEqual(len(self.board.projects), 1,
                         f"both runs together made one project: {self.board.projects!r}")
        self.assertEqual(self.board.projects[key]["name"], "First Name")

    def test_different_tokens_create_two_projects_under_two_keys(self):
        first, first_axi = self.run_verb(self.project_root(), token="alpha-one")  # noqa: S106
        second, second_axi = self.run_verb(self.project_root(), token="beta-two")  # noqa: S106

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first_axi.get("projectKey"), key_for_token("alpha-one"))
        self.assertEqual(second_axi.get("projectKey"), key_for_token("beta-two"))
        self.assertEqual(set(self.board.projects),
                         {key_for_token("alpha-one"), key_for_token("beta-two")})


class ProjectCreateUsesAKeyAlreadyInEnvTest(BoardDoubleMixin, unittest.TestCase):
    """A UUID key in `.env`: used when the board knows it, refused otherwise."""

    def test_a_known_env_key_is_answered_with_no_create_and_source_env_even_when_it_differs_from_the_tokens(self):
        self.board.add_project(OTHER_KEY, name="made by hand")
        env = f"A=1\nCRUCIBLE_PROJECT_KEY={OTHER_KEY}\n".encode()
        root = self.project_root(env)
        result, axi = self.run_verb(root, "--write-env")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.board.creates(), [], "no create for a known .env key")
        self.assertEqual(self.board.sent("GET", path="/api/v2/projects?archived=true"), [],
                         "the create step, archived check included, is skipped")
        self.assertEqual(self.board.requests[0][:2],
                         ("GET", f"/api/v2/projects/{OTHER_KEY}/metadata"))
        self.assertEqual(axi.get("projectKey"), OTHER_KEY)
        self.assertNotEqual(OTHER_KEY, key_for_token(TOKEN))
        self.assertIs(axi.get("created"), False)
        self.assertEqual(axi.get("source"), "env")
        self.assertEqual((root / ".env").read_bytes(), env)
        self.assertEqual(axi.get("envWritten"), "already-set")

    def test_an_env_key_the_board_does_not_know_is_refused_naming_the_key_posting_nothing(self):
        env = f"# mine\nCRUCIBLE_PROJECT_KEY={OTHER_KEY}\nB=2\n".encode()
        root = self.project_root(env)
        result, axi = self.run_verb(root, "--write-env")

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(axi, f"no envelope: {result.stdout!r} {result.stderr!r}")
        self.assertIs(axi.get("ok"), False)
        self.assertTrue(names_code(axi, "project-key-unknown"), axi)
        self.assertIn(OTHER_KEY, str(axi.get("error")))
        self.assertTrue(axi.get("help"), "a refusal carries a help")
        self.assertEqual(self.board.writes(), [], "nothing is posted on the refusal")
        self.assertEqual([(m, p) for m, p, _b in self.board.requests],
                         [("GET", f"/api/v2/projects/{OTHER_KEY}/metadata")])
        self.assertEqual((root / ".env").read_bytes(), env)

    def test_an_env_key_whose_project_is_archived_is_refused_with_the_boards_help(self):
        self.board.add_project(OTHER_KEY, archived=True)
        env = f"CRUCIBLE_PROJECT_KEY={OTHER_KEY}\n".encode()
        root = self.project_root(env)
        result, axi = self.run_verb(root, "--write-env")

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(axi, result.stdout)
        self.assertIs(axi.get("ok"), False)
        self.assertTrue(names_code(axi, "project-key-archived"), axi)
        self.assertIn(OTHER_KEY, str(axi.get("error")))
        for step in ARCHIVED_PROJECT_HELP:
            self.assertIn(step, axi.get("help") or [],
                          "the board's own archived-project help is carried")
        self.assertEqual(self.board.writes(), [])
        self.assertEqual((root / ".env").read_bytes(), env)

    def test_a_non_uuid_env_key_is_refused_as_malformed_before_any_request(self):
        for value in ("not-a-uuid", f'"{OTHER_KEY}"', f"'{OTHER_KEY}'"):
            with self.subTest(value=value):
                self.board.reset()
                env = f"A=1\nCRUCIBLE_PROJECT_KEY={value}\n".encode()
                root = self.project_root(env)
                result, axi = self.run_verb(root, "--write-env")

                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertTrue(axi, result.stdout)
                self.assertIs(axi.get("ok"), False)
                self.assertTrue(names_code(axi, "project-key-malformed"), axi)
                self.assertIn(value, str(axi.get("error")),
                              "the refusal names the value as read")
                self.assertTrue(axi.get("help"))
                self.assertEqual(self.board.requests, [],
                                 "a malformed key is refused before any request")
                self.assertEqual((root / ".env").read_bytes(), env)


class ProjectCreateRefusesAnArchivedTokenProjectTest(BoardDoubleMixin, unittest.TestCase):
    """The token's key held by an archived project: refused, nothing posted."""

    def test_the_tokens_archived_project_is_refused_with_the_unarchive_step_and_no_create(self):
        key = key_for_token(TOKEN)
        self.board.add_project(key, archived=True)
        root = self.project_root()
        result, axi = self.run_verb(root, "--write-env")

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(axi, result.stdout)
        self.assertIs(axi.get("ok"), False)
        self.assertTrue(names_code(axi, "project-archived"), axi)
        self.assertTrue(any("unarchive" in str(step) for step in axi.get("help") or []),
                        f"the help carries the un-archive step: {axi.get('help')!r}")
        self.assertEqual([(m, p) for m, p, _b in self.board.requests],
                         [("GET", "/api/v2/projects?archived=true")])
        self.assertFalse((root / ".env").exists(), "nothing is written")


class ProjectCreateRefusesAnEnvKeyWhoseStoredTokenDiffersTest(BoardDoubleMixin, unittest.TestCase):
    """A UUID key in `.env` whose project stores a `PROJECT_TOKEN` other than
    `--token`: refused as `project-token-mismatch`, naming both tokens, after
    the one metadata read and before anything is registered, patched or
    written. A project storing the same token, or none, proceeds."""

    STORED_TOKEN = "first-owner"  # noqa: S105 -- a project token, not a secret
    ENV = f"A=1\nCRUCIBLE_PROJECT_KEY={OTHER_KEY}\nB=2\n".encode()

    def test_a_stored_token_other_than_the_flags_is_refused_naming_both_after_only_the_metadata_read(self):
        for extra in ((), ("--write-env",)):
            with self.subTest(flags=extra):
                self.board.reset()
                stored = {"PROJECT_TOKEN": self.STORED_TOKEN, "KEPT": "yes"}
                self.board.add_project(OTHER_KEY, name="made by hand",
                                       metadata=stored)
                root = self.project_root(self.ENV)
                result, axi = self.run_verb(root, *extra, token=TOKEN)

                self.assertEqual(result.returncode, 1,
                                 f"exit 1 expected; stderr={result.stderr!r}")
                self.assertTrue(axi, f"no envelope: {result.stdout!r} {result.stderr!r}")
                self.assertIs(axi.get("ok"), False)
                error = str(axi.get("error"))
                self.assertIn(self.STORED_TOKEN, error,
                              "the refusal names the project's stored token")
                self.assertIn(TOKEN, error, "the refusal names --token")
                mismatches = [w for w in axi.get("warnings") or []
                              if isinstance(w, dict)
                              and w.get("code") == "project-token-mismatch"]
                self.assertEqual(len(mismatches), 1,
                                 f"one project-token-mismatch warning: {axi.get('warnings')!r}")
                self.assertEqual(mismatches[0].get("detail"), axi.get("error"),
                                 "the warning carries the refusal's own detail")
                self.assertEqual(
                    [(m, p) for m, p, _b in self.board.requests],
                    [("GET", f"/api/v2/projects/{OTHER_KEY}/metadata")],
                    "only the metadata read: no agents read, no register, no PATCH")
                self.assertEqual(self.board.registers(), [])
                self.assertEqual(self.board.patches(), [])
                self.assertEqual(self.board.projects[OTHER_KEY]["metadata"], stored,
                                 "the stored token is never overwritten")
                self.assertEqual((root / ".env").read_bytes(), self.ENV,
                                 ".env is byte-identical")

    def _assert_proceeds(self, root, result, axi):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(axi.get("ok"), True, axi)
        self.assertEqual(axi.get("projectKey"), OTHER_KEY)
        self.assertEqual(axi.get("source"), "env")
        self.assertIs(axi.get("created"), False)
        self.assertFalse(names_code(axi, "project-token-mismatch"), axi)
        self.assertEqual(
            [(m, p) for m, p, _b in self.board.requests],
            [("GET", f"/api/v2/projects/{OTHER_KEY}/metadata"),
             ("GET", f"/api/v2/agents?project={OTHER_KEY}"),
             ("POST", "/api/v2/agents/register"),
             ("PATCH", f"/api/v2/projects/{OTHER_KEY}/metadata")])
        self.assertEqual(self.board.patches()[0][2].get("set"), {"PROJECT_TOKEN": TOKEN})
        self.assertEqual((root / ".env").read_bytes(), self.ENV)
        self.assertEqual(axi.get("envWritten"), "already-set")

    def test_a_stored_token_equal_to_the_flags_proceeds_to_register_and_patch(self):
        self.board.add_project(OTHER_KEY, name="made by hand",
                               metadata={"PROJECT_TOKEN": TOKEN})
        root = self.project_root(self.ENV)
        result, axi = self.run_verb(root, "--write-env", token=TOKEN)

        self._assert_proceeds(root, result, axi)
        self.assertEqual(axi.get("metadata"), {"PROJECT_TOKEN": TOKEN})

    def test_a_project_with_no_stored_token_proceeds_to_register_and_patch(self):
        self.board.add_project(OTHER_KEY, name="made by hand",
                               metadata={"KEPT": "yes"})
        root = self.project_root(self.ENV)
        result, axi = self.run_verb(root, "--write-env", token=TOKEN)

        self._assert_proceeds(root, result, axi)
        self.assertEqual(axi.get("metadata"), {"KEPT": "yes", "PROJECT_TOKEN": TOKEN})


class ProjectCreatePostsToTheBoardItsProjectDeclaresTest(unittest.TestCase):
    """The fleet's own and install `crucible.toml` name a dead port; only the
    project dir's own `crucible.toml` names the double. Every request landing
    on the double, with the run `ok: true`, shows the project's own
    configuration chose the board -- a verb that never bound `--project-dir`
    would resolve the dead port and reach nothing."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.board = BoardDouble()
        cls.dead_board = closed_port_url()
        try:
            cls.fleet = ScratchFleet(cls.board.base_url,
                                     install_board_url=cls.dead_board)
        except BaseException:
            cls.board.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.fleet.close()
        cls.board.close()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.board.reset()

    def _project_root(self, env_bytes=None):
        root = make_project_dir(self.board.base_url, env_bytes)
        self.addCleanup(shutil.rmtree, root, True)
        # The fixture itself: the fleet alone resolves the dead port, and only
        # the project dir bound leads it to the double.
        self.assertEqual(self.fleet.resolves(None), self.dead_board)
        self.assertEqual(self.fleet.resolves(root), self.board.base_url)
        return root

    def test_a_create_whose_fleet_names_a_dead_board_reaches_the_double_its_project_declares(self):
        root = self._project_root()
        key = key_for_token(TOKEN)
        result, axi = drive(self.fleet, root, "--write-env", token=TOKEN)

        self.assertEqual(result.returncode, 0,
                         f"exit 0 expected; stderr={result.stderr!r}")
        self.assertIs(axi.get("ok"), True, axi)
        self.assertEqual(
            [(m, p) for m, p, _b in self.board.requests],
            [("GET", "/api/v2/projects?archived=true"),
             ("POST", "/api/v2/projects"),
             ("GET", f"/api/v2/agents?project={key}"),
             ("POST", "/api/v2/agents/register"),
             ("PATCH", f"/api/v2/projects/{key}/metadata")],
            "every request lands on the double the project declares")
        self.assertEqual((axi.get("context") or {}).get("board"), self.board.base_url,
                         "the envelope names the project's board")
        self.assertEqual(axi.get("projectKey"), key)
        self.assertIs(axi.get("created"), True)
        self.assertEqual(len(self.board.project_rows(key)), 1)
        self.assertEqual((root / ".env").read_bytes(),
                         f"CRUCIBLE_PROJECT_KEY={key}\n".encode())

    def test_an_env_key_whose_fleet_names_a_dead_board_is_read_from_the_double_its_project_declares(self):
        self.board.add_project(OTHER_KEY, name="made by hand")
        env = f"CRUCIBLE_PROJECT_KEY={OTHER_KEY}\n".encode()
        root = self._project_root(env)
        result, axi = drive(self.fleet, root, token=TOKEN)

        self.assertEqual(result.returncode, 0,
                         f"exit 0 expected; stderr={result.stderr!r}")
        self.assertIs(axi.get("ok"), True, axi)
        self.assertEqual(axi.get("source"), "env")
        self.assertEqual(self.board.requests[0][:2],
                         ("GET", f"/api/v2/projects/{OTHER_KEY}/metadata"),
                         "the .env key's project is read on the project's board")
        self.assertEqual(len(self.board.patches()), 1, self.board.requests)
        self.assertEqual((axi.get("context") or {}).get("board"), self.board.base_url)


if __name__ == "__main__":
    unittest.main()
