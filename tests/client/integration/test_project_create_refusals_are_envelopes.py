"""Every way `project-create` fails is an `ok: false` envelope with an exit
code, never a bare exit or a traceback.

- No `--agent` -- on a `.env` with no key, and with no `.env` at all -- is the
  fleet's `agent-identity-required` hard stop, never the bare
  "CRUCIBLE_PROJECT_KEY not found" exit a keyless `.env` gives other verbs.
- An unreachable board, a refused create, a refused register or PATCH after a
  create (still carrying `projectKey` and honouring `--write-env`), and an
  `OSError` from `--write-env` (the fleet's escaped-failure envelope, with an
  empty context).
- Each refusal made before any request -- a `--project-dir` that is not a
  directory, an empty `--name`, a bad `--token` or `--acronym`, a lowercase
  `--set` key, `--set CRUCIBLE_PROJECT_KEY=…`, a `--set` of `PROJECT_TOKEN` or
  `PROJECT_ACRONYM` that differs from its flag -- reaches the board not once.
- Without `--project-dir` argparse refuses with exit 2.

Driven as a real subprocess against the recording board double, or a closed
port (`tests/client/project_create_harness.py`).

Fails today: no client has a `project-create` subcommand, so argparse refuses
the verb itself.
"""

import os
import shutil
import stat
import unittest

from tests.client.project_create_harness import (
    BoardDoubleMixin,
    ScratchFleet,
    closed_port_url,
    drive,
    key_for_token,
    make_project_dir,
    names_code,
)

TOKEN = "refusal-case"  # noqa: S105 -- a project token, not a secret


class _EnvelopeAssertions(unittest.TestCase):
    """The failure-envelope check the classes below share. Holds no test, so
    discovery collects nothing from it."""

    def assert_failure_envelope(self, result, axi, code: int | None = 1):
        self.assertTrue(axi, f"no envelope on stdout: stdout={result.stdout!r} "
                             f"stderr={result.stderr!r}")
        self.assertEqual(axi.get("verb"), "project-create")
        self.assertIs(axi.get("ok"), False)
        if code is None:
            self.assertNotEqual(result.returncode, 0)
        else:
            self.assertEqual(result.returncode, code, result.stderr)
        self.assertNotIn("Traceback", result.stderr)


class ProjectCreateWithoutAnAgentIsTheIdentityHardStopTest(
        _EnvelopeAssertions, BoardDoubleMixin, unittest.TestCase):

    def test_no_agent_on_a_env_with_no_key_is_agent_identity_required_and_posts_nothing(self):
        env = b"A=1\n"
        root = self.project_root(env)
        result, axi = self.run_verb(root, "--write-env", agent=None)

        self.assert_failure_envelope(result, axi, code=None)
        self.assertTrue(names_code(axi, "agent-identity-required"), axi)
        self.assertFalse(axi.get("context"), f"the context is empty: {axi.get('context')!r}")
        self.assertNotIn("CRUCIBLE_PROJECT_KEY not found", result.stderr)
        self.assertEqual(self.board.requests, [])
        self.assertEqual((root / ".env").read_bytes(), env)

    def test_no_agent_with_no_env_file_is_agent_identity_required_and_posts_nothing(self):
        root = self.project_root()
        result, axi = self.run_verb(root, "--write-env", agent=None)

        self.assert_failure_envelope(result, axi, code=None)
        self.assertTrue(names_code(axi, "agent-identity-required"), axi)
        self.assertFalse(axi.get("context"), f"the context is empty: {axi.get('context')!r}")
        self.assertNotIn("CRUCIBLE_PROJECT_KEY not found", result.stderr)
        self.assertEqual(self.board.requests, [])
        self.assertFalse((root / ".env").exists())


class ProjectCreateRefusesBeforeAnyRequestTest(
        _EnvelopeAssertions, BoardDoubleMixin, unittest.TestCase):
    """The step-one refusals: an envelope, exit 1, and no request at all."""

    def assert_refused_before_any_request(self, root, *extra, **kwargs):
        env = b"A=1\n"
        (root / ".env").write_bytes(env)
        result, axi = self.run_verb(root, *extra, **kwargs)
        self.assert_failure_envelope(result, axi)
        self.assertTrue(axi.get("error"), f"the refusal carries an error: {axi!r}")
        self.assertTrue(axi.get("help"), f"the refusal carries a help: {axi!r}")
        self.assertEqual(self.board.requests, [], "nothing reaches the board")
        self.assertEqual((root / ".env").read_bytes(), env)
        return axi

    def test_a_project_dir_that_is_a_file_is_refused(self):
        root = self.project_root()
        a_file = root / "not-a-dir"
        a_file.write_text("x")
        result, axi = self.run_verb(root, project_dir_arg=a_file)
        self.assert_failure_envelope(result, axi)
        self.assertTrue(axi.get("error"))
        self.assertTrue(axi.get("help"))
        self.assertEqual(self.board.requests, [])

    def test_a_project_dir_that_does_not_exist_is_refused(self):
        root = self.project_root()
        result, axi = self.run_verb(root, project_dir_arg=root / "missing")
        self.assert_failure_envelope(result, axi)
        self.assertTrue(axi.get("error"))
        self.assertEqual(self.board.requests, [])
        self.assertFalse((root / "missing").exists(), "the missing dir is not created")

    def test_an_empty_name_is_refused(self):
        self.assert_refused_before_any_request(self.project_root(), "--write-env", name="")

    def test_a_token_outside_lowercase_letters_digits_and_hyphens_is_refused(self):
        for token in ("Upper-Case", "under_score", "-leading", "has space", ""):
            with self.subTest(token=token):
                self.board.reset()
                self.assert_refused_before_any_request(
                    self.project_root(), "--write-env", token=token)

    def test_an_acronym_outside_an_uppercase_letter_then_uppercase_or_digits_is_refused(self):
        for acronym in ("wdg", "1AB", "AB-C", ""):
            with self.subTest(acronym=acronym):
                self.board.reset()
                self.assert_refused_before_any_request(
                    self.project_root(), "--write-env", "--acronym", acronym)

    def test_a_set_key_that_is_not_an_environment_variable_name_is_refused(self):
        for pair in ("lower=x", "Mixed=x", "1LEAD=x", "HAS-DASH=x"):
            with self.subTest(pair=pair):
                self.board.reset()
                self.assert_refused_before_any_request(
                    self.project_root(), "--write-env", "--set", pair)

    def test_a_set_of_the_project_key_is_refused(self):
        self.assert_refused_before_any_request(
            self.project_root(), "--write-env", "--set", "CRUCIBLE_PROJECT_KEY=x")

    def test_a_set_project_token_that_differs_from_the_token_is_refused(self):
        self.assert_refused_before_any_request(
            self.project_root(), "--write-env", "--set", "PROJECT_TOKEN=something-else",
            token=TOKEN)

    def test_a_set_project_acronym_that_differs_from_the_acronym_is_refused(self):
        self.assert_refused_before_any_request(
            self.project_root(), "--write-env", "--acronym", "ABC",
            "--set", "PROJECT_ACRONYM=XYZ")

    def test_without_project_dir_argparse_refuses_with_exit_two_naming_the_flag(self):
        root = self.project_root()
        result, _axi = self.run_verb(root, with_project_dir=False, cwd=root)

        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("the following arguments are required", result.stderr)
        self.assertIn("--project-dir", result.stderr)
        self.assertEqual(self.board.requests, [])


class ProjectCreateBoardFailuresAreEnvelopesTest(
        _EnvelopeAssertions, BoardDoubleMixin, unittest.TestCase):

    def test_a_refused_create_is_ok_false_carrying_the_boards_error(self):
        self.board.refuse("create", 400, {"ok": False, "error": "name is required"})
        root = self.project_root()
        result, axi = self.run_verb(root, token=TOKEN)

        self.assert_failure_envelope(result, axi)
        self.assertIn("name is required", str(axi.get("error")))
        self.assertTrue(axi.get("help"))
        self.assertEqual(len(self.board.creates()), 1, self.board.requests)

    def test_a_refused_register_after_the_create_still_carries_the_key_and_writes_env(self):
        key = key_for_token(TOKEN)
        self.board.refuse("register", 404, {
            "ok": False, "error": f"project is archived: {key}",
            "help": ["POST /api/v2/projects/<key>/unarchive — explicitly restore the project first"]})
        root = self.project_root()
        result, axi = self.run_verb(root, "--write-env", token=TOKEN)

        self.assert_failure_envelope(result, axi)
        self.assertTrue(axi.get("error"))
        self.assertTrue(axi.get("help"))
        self.assertEqual(axi.get("projectKey"), key)
        self.assertIs(axi.get("created"), True)
        self.assertEqual((root / ".env").read_bytes(),
                         f"CRUCIBLE_PROJECT_KEY={key}\n".encode())
        self.assertEqual(axi.get("envWritten"), "written")

    def test_a_refused_patch_after_the_create_still_carries_the_key_and_writes_env(self):
        key = key_for_token(TOKEN)
        self.board.refuse("patch", 409, {
            "ok": False,
            "error": "agent orch-1 carries role report — a project metadata write requires ORCHESTRATOR"})
        root = self.project_root(b"A=1\nCRUCIBLE_PROJECT_KEY=\n")
        result, axi = self.run_verb(root, "--write-env", token=TOKEN)

        self.assert_failure_envelope(result, axi)
        self.assertIn("a project metadata write requires ORCHESTRATOR", str(axi.get("error")))
        self.assertTrue(axi.get("help"))
        self.assertEqual(axi.get("projectKey"), key)
        self.assertIs(axi.get("created"), True)
        self.assertEqual((root / ".env").read_bytes(),
                         f"A=1\nCRUCIBLE_PROJECT_KEY={key}\n".encode())

    def test_an_oserror_from_write_env_is_the_escaped_failure_envelope_with_an_empty_context(self):
        root = self.project_root()
        os.chmod(root, stat.S_IRUSR | stat.S_IXUSR)
        self.addCleanup(os.chmod, root, stat.S_IRWXU)
        result, axi = self.run_verb(root, "--write-env", token=TOKEN)

        self.assert_failure_envelope(result, axi)
        self.assertTrue(str(axi.get("error")).startswith("PermissionError:"), axi)
        self.assertEqual(axi.get("help"),
                         ["fix the cause this error names, then re-run the verb"])
        self.assertFalse(axi.get("context"), f"the context is empty: {axi.get('context')!r}")
        self.assertEqual(len(self.board.creates()), 1, self.board.requests)


class ProjectCreateAgainstAnUnreachableBoardTest(_EnvelopeAssertions, unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.url = closed_port_url()
        cls.fleet = ScratchFleet(cls.url)

    @classmethod
    def tearDownClass(cls):
        cls.fleet.close()

    def test_an_unreachable_board_is_ok_false_with_an_error_and_a_help(self):
        root = make_project_dir(self.url)
        self.addCleanup(shutil.rmtree, root, True)
        result, axi = drive(self.fleet, root, token=TOKEN)

        self.assert_failure_envelope(result, axi)
        self.assertTrue(axi.get("error"), axi)
        self.assertTrue(axi.get("help"), axi)


if __name__ == "__main__":
    unittest.main()
