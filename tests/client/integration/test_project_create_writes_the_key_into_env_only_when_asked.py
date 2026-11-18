"""`project-create --write-env` writes the project's key into `<root>/.env`,
keeping every other byte; without the flag `.env` is never written.

Each case drives a real `project-create` subprocess against the recording
board double (`tests/client/project_create_harness.py`) and compares the
whole file's bytes afterwards:

- an empty `CRUCIBLE_PROJECT_KEY=` line between other lines is replaced;
- no key line: the line is appended, after the file's first line ending;
- no `.env` at all: one is created holding the line and a `\\n` -- on every
  client, arduino included;
- a CRLF file keeps its endings, replaced or appended;
- a file with no final newline gets its ending before the appended line;
- of two empty key lines the last is replaced;
- a key already set is `already-set`, the file unchanged.

Fails today: no client has a `project-create` subcommand.
"""

import unittest

from tests.client.project_create_harness import (
    CLIENT_SCRIPTS,
    BoardDoubleMixin,
    key_for_token,
)

TOKEN = "env-writer"  # noqa: S105 -- a project token, not a secret


class ProjectCreateWritesTheKeyIntoEnvTest(BoardDoubleMixin, unittest.TestCase):

    def _write_env(self, before, client="python"):
        root = self.project_root(before)
        result, axi = self.run_verb(root, "--write-env", token=TOKEN, client=client)
        return root, result, axi

    def assert_written(self, before, expected, client="python"):
        root, result, axi = self._write_env(before, client)
        self.assertEqual(result.returncode, 0,
                         f"{client}: exit 0 expected; stderr={result.stderr!r}")
        self.assertEqual((root / ".env").read_bytes(), expected,
                         f"{client}: the whole .env afterwards")
        self.assertEqual(axi.get("envWritten"), "written", f"{client}: {axi!r}")
        return root

    def test_an_empty_key_line_between_other_lines_is_replaced_and_nothing_else_changes(self):
        key = key_for_token(TOKEN)
        self.assert_written(b"# project\nA=1\nCRUCIBLE_PROJECT_KEY=\nB=two words\n",
                            f"# project\nA=1\nCRUCIBLE_PROJECT_KEY={key}\nB=two words\n".encode())

    def test_with_no_key_line_the_line_is_appended_after_the_existing_ones(self):
        key = key_for_token(TOKEN)
        self.assert_written(b"A=1\nB=2\n",
                            f"A=1\nB=2\nCRUCIBLE_PROJECT_KEY={key}\n".encode())

    def test_with_no_env_file_one_is_created_holding_the_line_and_a_newline_on_every_client(self):
        key = key_for_token(TOKEN)
        for client in CLIENT_SCRIPTS:
            with self.subTest(client=client):
                self.board.reset()
                root, result, axi = self._write_env(None, client)
                self.assertEqual(result.returncode, 0,
                                 f"{client}: exit 0 expected; stderr={result.stderr!r}")
                self.assertEqual((root / ".env").read_bytes(),
                                 f"CRUCIBLE_PROJECT_KEY={key}\n".encode())
                self.assertEqual(axi.get("envWritten"), "written")
                self.assertEqual(axi.get("projectKey"), key)

    def test_a_crlf_file_keeps_its_endings_when_the_empty_key_line_is_replaced(self):
        key = key_for_token(TOKEN)
        self.assert_written(b"A=1\r\nCRUCIBLE_PROJECT_KEY=\r\nB=2\r\n",
                            f"A=1\r\nCRUCIBLE_PROJECT_KEY={key}\r\nB=2\r\n".encode())

    def test_a_crlf_file_with_no_key_line_gets_the_line_appended_with_a_crlf(self):
        key = key_for_token(TOKEN)
        self.assert_written(b"A=1\r\nB=2\r\n",
                            f"A=1\r\nB=2\r\nCRUCIBLE_PROJECT_KEY={key}\r\n".encode())

    def test_a_file_with_no_final_newline_gets_its_ending_before_the_appended_line(self):
        key = key_for_token(TOKEN)
        self.assert_written(b"A=1\nB=2",
                            f"A=1\nB=2\nCRUCIBLE_PROJECT_KEY={key}\n".encode())

    def test_of_two_empty_key_lines_only_the_last_is_replaced(self):
        key = key_for_token(TOKEN)
        self.assert_written(b"CRUCIBLE_PROJECT_KEY=\nA=1\nCRUCIBLE_PROJECT_KEY=\n",
                            f"CRUCIBLE_PROJECT_KEY=\nA=1\nCRUCIBLE_PROJECT_KEY={key}\n".encode())

    def test_a_key_already_set_is_already_set_and_the_file_is_byte_identical(self):
        existing = "0190a5c4-2222-7000-8000-0000000000ef"
        self.board.add_project(existing, name="by hand")
        before = f"# keep me\r\nA=1\nCRUCIBLE_PROJECT_KEY={existing}\nZ=9".encode()
        root, result, axi = self._write_env(before)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / ".env").read_bytes(), before)
        self.assertEqual(axi.get("envWritten"), "already-set")
        self.assertEqual(axi.get("projectKey"), existing)


class ProjectCreateWithoutWriteEnvNeverWritesTest(BoardDoubleMixin, unittest.TestCase):

    def test_an_empty_key_line_is_left_byte_identical_without_write_env(self):
        before = b"A=1\nCRUCIBLE_PROJECT_KEY=\n"
        root = self.project_root(before)
        result, axi = self.run_verb(root, token=TOKEN)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / ".env").read_bytes(), before)
        self.assertEqual(axi.get("envWritten"), "not-asked")
        self.assertEqual(axi.get("projectKey"), key_for_token(TOKEN))

    def test_a_missing_env_stays_missing_without_write_env(self):
        root = self.project_root()
        result, axi = self.run_verb(root, token=TOKEN)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((root / ".env").exists())
        self.assertEqual(axi.get("envWritten"), "not-asked")


if __name__ == "__main__":
    unittest.main()
