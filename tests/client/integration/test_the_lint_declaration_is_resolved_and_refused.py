"""The `[lint]` declaration is resolved as `[gate]` is -- the project's own
`crucible.toml` first, then the install's, the first file that parses winning
-- and a malformed table is refused, naming its file, before any linter runs.

Every drive is a real subprocess of the python client from a scratch copy of
the fleet (`tests/client/lint_verb_harness.py`), whose own install
`crucible.toml` is the install file of the chain. The linter is a fake that
records every call, so "nothing ran" is read off its log.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.integration.test_the_lint_declaration_is_resolved_and_refused
"""

import unittest
from pathlib import Path

from tests.client.lint_verb_harness import (
    LintDriveMixin,
    append_table,
    lint_table,
)

RUFF = "lint-fixture-ruff"


class AMalformedLintTableIsRefusedBeforeAnythingRunsTest(LintDriveMixin, unittest.TestCase):

    def setUp(self):
        super().setUp()
        self.fake(RUFF)

    def assertRefusedNamingTheFile(self, table_text):
        root = self.project(table_text)
        result, axi = self.filed("python", root)
        config = str(Path(root) / "crucible.toml")
        self.assertEqual(
            (axi.get("verb"), axi.get("ok")), ("lint", False),
            f"a malformed [lint] is refused; stdout={result.stdout!r} "
            f"stderr={result.stderr[-2000:]}")
        self.assertIn(config, str(axi.get("error") or ""),
                      f"the refusal names the file that declares it; {axi!r}")
        self.assertNotEqual(result.returncode, 0, f"{axi!r}")
        self.assertEqual(self.calls(), [], "no linter ran")
        self.assertEqual(self.board.compile_posts(), [], "nothing was posted")

    def test_a_command_written_as_one_string_is_refused(self):
        self.assertRefusedNamingTheFile(
            '\n[lint]\ncommand = "lint-fixture-ruff check"\nformat = "ruff"\n')

    def test_an_empty_command_list_is_refused(self):
        self.assertRefusedNamingTheFile(lint_table([], format="ruff"))

    def test_a_command_holding_an_empty_entry_is_refused(self):
        self.assertRefusedNamingTheFile(lint_table([RUFF, "", "."], format="ruff"))

    def test_a_format_that_is_not_a_string_is_refused(self):
        self.assertRefusedNamingTheFile(
            f'\n[lint]\ncommand = ["{RUFF}", "check"]\nformat = 3\n')

    def test_a_name_that_is_not_a_string_is_refused(self):
        self.assertRefusedNamingTheFile(
            f'\n[lint]\ncommand = ["{RUFF}", "check"]\nformat = "ruff"\nname = 5\n')


class TheInstallsLintTableIsTheFallbackTest(LintDriveMixin, unittest.TestCase):
    """The scratch fleet's own install file declares a `[lint]`; each test
    adds it and takes it away again."""

    def setUp(self):
        super().setUp()
        self.fake(RUFF)
        self.install_config = self.fleet.root / "crucible.toml"
        original = self.install_config.read_text(encoding="utf-8")
        self.addCleanup(self.install_config.write_text, original, encoding="utf-8")
        append_table(self.install_config,
                     lint_table([RUFF, "check", "."], format="ruff"))

    def test_a_project_with_no_file_of_its_own_runs_the_installs_lint_and_names_the_install_file(self):
        root = self.project(with_config=False)
        result, axi = self.filed("python", root)
        self.assertEqual(
            (axi.get("verb"), axi.get("declared"), axi.get("linter")),
            ("lint", f"declared:{self.install_config}", "ruff"),
            f"stdout={result.stdout!r} stderr={result.stderr[-2000:]}")
        self.assertEqual([c["cwd"] for c in self.calls(RUFF)], [str(root)],
                         "the install's linter runs in the project directory")
        body = self.one_compile_post(result, axi)
        self.assertEqual(body.get("lint"), "ruff", f"{body!r}")

    def test_a_project_file_without_lint_hides_the_installs_and_the_run_is_skipped(self):
        root = self.project(None)
        result, axi = self.filed("python", root)
        self.assertEqual(
            (axi.get("verb"), axi.get("ok"), axi.get("skipped")),
            ("lint", True, "not-declared"),
            f"the first file that parses wins, and it declares no [lint]; "
            f"stdout={result.stdout!r} stderr={result.stderr[-2000:]}")
        self.assertEqual(self.calls(), [], "the install's linter never ran")
        self.assertEqual(self.board.compile_posts(), [], "nothing was posted")


if __name__ == "__main__":
    unittest.main()
