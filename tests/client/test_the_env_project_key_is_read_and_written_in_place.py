"""A project's `.env` key is read, and written in place, by one reader and
one writer.

The project module defines `read_env_project_key(root)` and
`write_env_project_key(root, key)`, reached here through the core, which
re-exports them. `root` is the project directory; the file is `<root>/.env`.

Reading:

  * the file is split into lines on `\\n`; a trailing `\\r` is not part of a
    line's text;
  * a `CRUCIBLE_PROJECT_KEY=` line's value is the text after the first `=`,
    stripped of whitespace; with several such lines the last one counts;
  * an empty value, no such line, or no file at all is no key (`None`);
    quotes are kept.

Writing:

  * `CRUCIBLE_PROJECT_KEY=<key>` replaces the last such line when its value is
    empty, keeping that line's own ending; otherwise, when there is no such
    line, it is appended with the file's first line ending, after adding one
    if the file does not end in a line ending; a missing `.env` is created
    holding that one line and a `\\n`. The writer answers `"written"`;
  * a key already set is never written: the writer answers `"already-set"`
    and the file is unchanged;
  * every other byte is kept: other lines, comments, order and line endings.

Each case compares the whole file's bytes afterwards.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_the_env_project_key_is_read_and_written_in_place
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import load_client

KEY = "3b0c5e1a-7f2d-5a9e-8c4b-6d1e2f3a4b5c"
OTHER_KEY = "9d8c7b6a-5f4e-5d3c-8b2a-1f0e9d8c7b6a"
LINE = f"CRUCIBLE_PROJECT_KEY={KEY}".encode()


class _EnvFileCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.core = load_client("_crucible_axi.py")

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="env-project-key-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.env = Path(self.root) / ".env"

    def function(self, name):
        if not hasattr(self.core, name):
            self.fail(f"the core carries no `{name}`: the project module that "
                      f"defines it is not loaded and re-exported yet")
        return getattr(self.core, name)

    def given(self, content):
        self.env.write_bytes(content)

    def read_key(self):
        return self.function("read_env_project_key")(self.root)

    def write_key(self, key=KEY):
        return self.function("write_env_project_key")(self.root, key)

    def assert_file(self, expected):
        self.assertTrue(self.env.is_file(), f"{self.env} exists")
        self.assertEqual(self.env.read_bytes(), expected)


class TheWriterPutsTheKeyInPlaceTest(_EnvFileCase):

    def test_an_empty_key_line_between_other_lines_is_replaced(self):
        self.given(b"A=1\nCRUCIBLE_PROJECT_KEY=\nB=2\n")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"A=1\n" + LINE + b"\nB=2\n")

    def test_a_key_line_holding_only_whitespace_is_replaced_whole(self):
        self.given(b"A=1\nCRUCIBLE_PROJECT_KEY=   \nB=2\n")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"A=1\n" + LINE + b"\nB=2\n")

    def test_with_no_key_line_the_line_is_appended_after_everything_else(self):
        self.given(b"# the project's facts\nA=1\n\nB=two words\n")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"# the project's facts\nA=1\n\nB=two words\n" + LINE + b"\n")

    def test_with_no_env_file_one_is_created_holding_the_line_and_a_newline(self):
        self.assertFalse(self.env.exists())
        self.assertEqual(self.write_key(), "written")
        self.assert_file(LINE + b"\n")

    def test_a_crlf_files_replaced_line_keeps_its_crlf(self):
        self.given(b"A=1\r\nCRUCIBLE_PROJECT_KEY=\r\nB=2\r\n")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"A=1\r\n" + LINE + b"\r\nB=2\r\n")

    def test_a_crlf_files_appended_line_ends_in_crlf(self):
        self.given(b"A=1\r\nB=2\r\n")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"A=1\r\nB=2\r\n" + LINE + b"\r\n")

    def test_the_appended_line_takes_the_files_first_line_ending(self):
        self.given(b"A=1\r\nB=2\n")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"A=1\r\nB=2\n" + LINE + b"\r\n")

    def test_a_file_with_no_final_newline_gains_one_before_the_appended_line(self):
        self.given(b"A=1\nB=2")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"A=1\nB=2\n" + LINE + b"\n")

    def test_a_replaced_last_line_with_no_line_ending_keeps_having_none(self):
        self.given(b"A=1\nCRUCIBLE_PROJECT_KEY=")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"A=1\n" + LINE)

    def test_of_two_empty_key_lines_only_the_last_is_replaced(self):
        self.given(b"CRUCIBLE_PROJECT_KEY=\nA=1\nCRUCIBLE_PROJECT_KEY=\nB=2\n")
        self.assertEqual(self.write_key(), "written")
        self.assert_file(b"CRUCIBLE_PROJECT_KEY=\nA=1\n" + LINE + b"\nB=2\n")

    def test_a_key_already_set_is_never_written_and_the_file_is_unchanged(self):
        original = f"A=1\nCRUCIBLE_PROJECT_KEY={OTHER_KEY}\nB=2\n".encode()
        self.given(original)
        self.assertEqual(self.write_key(), "already-set")
        self.assert_file(original)

    def test_a_crlf_file_with_a_key_already_set_is_unchanged(self):
        original = f"A=1\r\nCRUCIBLE_PROJECT_KEY={OTHER_KEY}\r\n".encode()
        self.given(original)
        self.assertEqual(self.write_key(), "already-set")
        self.assert_file(original)

    def test_the_written_key_is_the_one_the_reader_then_reads(self):
        self.given(b"A=1\r\nCRUCIBLE_PROJECT_KEY=\r\n")
        self.assertEqual(self.write_key(), "written")
        self.assertEqual(self.read_key(), KEY)
        self.assertEqual(self.write_key(OTHER_KEY), "already-set")
        self.assertEqual(self.read_key(), KEY)
        self.assert_file(b"A=1\r\n" + LINE + b"\r\n")


class TheReaderReadsTheLastKeyLineTest(_EnvFileCase):

    def assert_read(self, content, expected):
        self.given(content)
        self.assertEqual(self.read_key(), expected)
        self.assertEqual(self.env.read_bytes(), content,
                         "reading never changes the file")

    def test_a_set_key_between_other_lines_is_read(self):
        self.assert_read(f"A=1\nCRUCIBLE_PROJECT_KEY={KEY}\nB=2\n".encode(), KEY)

    def test_an_empty_key_line_is_no_key(self):
        self.assert_read(b"A=1\nCRUCIBLE_PROJECT_KEY=\nB=2\n", None)

    def test_a_whitespace_only_value_is_no_key(self):
        self.assert_read(b"A=1\nCRUCIBLE_PROJECT_KEY=  \t \nB=2\n", None)

    def test_no_key_line_is_no_key(self):
        self.assert_read(b"A=1\nB=2\n", None)

    def test_no_env_file_is_no_key_and_creates_none(self):
        self.assertIsNone(self.read_key())
        self.assertFalse(self.env.exists(), "reading never creates `.env`")

    def test_a_crlf_files_key_is_read_without_its_carriage_return(self):
        self.assert_read(f"A=1\r\nCRUCIBLE_PROJECT_KEY={KEY}\r\nB=2\r\n".encode(), KEY)

    def test_a_crlf_files_empty_key_line_is_no_key(self):
        self.assert_read(b"A=1\r\nCRUCIBLE_PROJECT_KEY=\r\nB=2\r\n", None)

    def test_a_key_on_a_last_line_with_no_final_newline_is_read(self):
        self.assert_read(f"A=1\nCRUCIBLE_PROJECT_KEY={KEY}".encode(), KEY)

    def test_two_empty_key_lines_are_no_key(self):
        self.assert_read(b"CRUCIBLE_PROJECT_KEY=\nA=1\nCRUCIBLE_PROJECT_KEY=\n", None)

    def test_the_value_is_stripped_of_surrounding_whitespace(self):
        self.assert_read(f"CRUCIBLE_PROJECT_KEY=  {KEY} \t\n".encode(), KEY)

    def test_the_value_is_everything_after_the_first_equals_sign(self):
        self.assert_read(b"CRUCIBLE_PROJECT_KEY=a=b=c\n", "a=b=c")

    def test_a_double_quoted_value_is_read_with_its_quotes(self):
        self.assert_read(f'CRUCIBLE_PROJECT_KEY="{KEY}"\n'.encode(), f'"{KEY}"')

    def test_a_single_quoted_value_is_read_with_its_quotes(self):
        self.assert_read(f"CRUCIBLE_PROJECT_KEY='{KEY}'\n".encode(), f"'{KEY}'")

    def test_of_two_set_key_lines_the_last_wins(self):
        self.assert_read(
            f"CRUCIBLE_PROJECT_KEY={OTHER_KEY}\nA=1\nCRUCIBLE_PROJECT_KEY={KEY}\n".encode(),
            KEY)

    def test_a_set_key_followed_by_an_empty_key_line_is_no_key(self):
        self.assert_read(
            f"CRUCIBLE_PROJECT_KEY={KEY}\nA=1\nCRUCIBLE_PROJECT_KEY=\n".encode(), None)


if __name__ == "__main__":
    unittest.main()
