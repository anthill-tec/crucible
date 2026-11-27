"""An eda project's declaration is read from its own `crucible.toml`, and what
it does not declare, or declares wrongly, is refused before any run.

An eda entry is a `[targets."<tier>"]` or `[targets."<tier>/<label>"]` table
whose `framework` is "eda-pytest"; its `paths` is a non-empty list of strings,
each a path relative to the project dir (optionally followed by
`::<node id>`) whose file or directory exists. What the client does with a
declaration:

* a tier verb whose tier holds no eda entry is refused with the shared
  tier-run-undeclared stop -- `ok: false`, a non-zero exit, help naming
  `[targets."<tier>"]` with framework "eda-pytest" -- and opens no run and
  runs no pytest; `regression` and `pre-merge-gate` on a project with no eda
  entry are refused the same way;
* another stack's entry -- one with no `framework` (rust's) or a framework
  another stack reserves -- is skipped: neither refused nor run;
* each of these is refused with the shared declaration-refused stop, naming
  the table, the field and the file: a framework no stack reserves; a key
  whose tier is not one of unit, module, integration, e2e, bdd; an empty
  label; a `paths` that is missing, empty or not a list of strings, or that
  names a missing file (also with `::<node id>`); a `crucible.toml` that does
  not parse;
* an absent `crucible.toml` declares nothing.

The faults are driven through `regression`, which reads every eda entry, so
the refusal cannot depend on which tier the fault sits in.

Every test drives the REAL client as an OS subprocess on a scratch copy of the
fixture, handed a recording interpreter that imports pytest, against a
`RecordingBoard`: "no run opened" is read from the board, "no pytest ran"
from the interpreter's log.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_declaration_is_read_or_refused
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client import TEST_INSTALL_MARKER, establish_test_install, pid_alive
from tests.client.client_fleet_envelope_census_helpers import declare_board
from tests.client.eda_project_harness import (
    DECLARATION_REFUSED_CODE,
    EDA_CLIENT,
    FRAMEWORK,
    TIER_RUN_UNDECLARED_CODE,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    envelope,
    raised_limits_table,
    said,
    scratch,
)


class _Declaration(unittest.TestCase):
    """A scratch copy of the fixture and an interpreter that imports pytest,
    built once per class."""

    maxDiff = 4000

    @classmethod
    def setUpClass(cls):
        root = scratch(cls, "eda-declaration-python-")
        cls.python = RecordingInterpreter(os.path.join(root, "bin", "eda-python"))

    def setUp(self):
        # Each test reads only the calls it caused.
        if os.path.exists(self.python.log):
            os.remove(self.python.log)
        self.project = EdaProject(self)

    def drive(self, verb, *argv, **kwargs):
        kwargs.setdefault("python", self.python.path)
        return self.project.drive(verb, *argv, **kwargs)

    def assert_nothing_ran(self, result, why):
        where = f"{why}; {diagnostics(result)}"
        self.assertEqual(self.project.run_route_posts(), [],
                         f"no run is opened; {where}")
        self.assertEqual(self.python.pytest_calls(), [],
                         f"no pytest runs; {where}")

    def assert_hard_stop(self, result, verb, why):
        """A refusal in the fleet's envelope: non-zero exit, `ok: false`,
        nothing run. Answers the envelope."""
        where = f"{why}; {diagnostics(result)}"
        self.assertNotEqual(result.returncode, 0, f"the verb is refused; {where}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        axi = axi or {}
        self.assertEqual(axi.get("verb"), verb, where)
        self.assertIs(axi.get("ok"), False, where)
        self.assert_nothing_ran(result, why)
        return axi

    def install_declaring(self, board_url):
        """An eda client of this test's own: a test install laid down by the
        suite's helper inside a parent this test owns, its `crucible.toml`
        declaring `board_url`. Answers the install's client."""
        parent = scratch(self, "eda-install-parent-")
        environ = {}
        with mock.patch.object(tempfile, "tempdir", parent):
            install = Path(establish_test_install(
                environ, pid=os.getpid(), pid_alive=pid_alive, at_exit=self.addCleanup))
        self.assertEqual(environ, {TEST_INSTALL_MARKER: str(install)})
        config = declare_board(install / "crucible.toml", board_url)
        with open(config, "a", encoding="utf-8") as handle:
            handle.write(raised_limits_table())
        return install / "clients" / EDA_CLIENT.name

    def assert_undeclared_tier(self, result, verb, tier, why):
        """The shared tier-run-undeclared stop, naming where an eda entry for
        `tier` goes; never a declaration refusal."""
        axi = self.assert_hard_stop(result, verb, why)
        words = said(axi)
        where = f"{why}; {diagnostics(result)}"
        self.assertIn(f"no {tier} target is declared", str(axi.get("error")), where)
        self.assertIn(f'[targets."{tier}"]', words, f"the help names the table; {where}")
        self.assertIn(FRAMEWORK, words, f"the help names the framework; {where}")
        self.assertIn(TIER_RUN_UNDECLARED_CODE, result.stderr, where)
        self.assertNotIn(DECLARATION_REFUSED_CODE, result.stderr + result.stdout,
                         f"an undeclared tier is not a refused declaration; {where}")

    def assert_declaration_refused(self, result, *named, verb="regression", why=""):
        """The shared declaration-refused stop, its words naming each of
        `named` (the table, the field, the file)."""
        axi = self.assert_hard_stop(result, verb, why)
        words = said(axi)
        where = f"{why}; {diagnostics(result)}"
        self.assertIn(DECLARATION_REFUSED_CODE, result.stderr,
                      f"the refusal is the shared declaration stop; {where}")
        for name in named:
            self.assertIn(name, words, f"the refusal names {name!r}; {where}")
        return words


class ATierWithNoEdaEntryIsRefusedTest(_Declaration):

    def test_module_with_no_module_entry_is_refused_naming_where_the_entry_goes(self):
        result = self.drive("module")
        self.assert_undeclared_tier(result, "module", "module",
                                    "the fixture declares no module entry")

    def test_regression_on_a_project_with_no_eda_entry_is_refused_naming_the_declaration(self):
        self.project.declare_only_the_board()
        result = self.drive("regression")
        axi = self.assert_hard_stop(result, "regression", "no eda entry is declared")
        words = said(axi)
        self.assertIn("[targets.", words, diagnostics(result))
        self.assertIn(FRAMEWORK, words, diagnostics(result))

    def test_the_gate_on_a_project_with_no_eda_entry_is_refused_naming_the_declaration(self):
        self.project.declare_only_the_board()
        result = self.drive("pre-merge-gate")
        axi = self.assert_hard_stop(result, "pre-merge-gate", "no eda entry is declared")
        words = said(axi)
        self.assertIn("[targets.", words, diagnostics(result))
        self.assertIn(FRAMEWORK, words, diagnostics(result))

    def test_an_absent_crucible_toml_declares_nothing(self):
        # With no project file the board comes from an install of this test's
        # own, which declares it.
        os.remove(self.project.toml)
        client = self.install_declaring(self.project.board.url)
        result = self.drive("unit", client=client)
        self.assert_undeclared_tier(result, "unit", "unit",
                                    "the project has no crucible.toml")


class AnotherStacksEntryIsSkippedTest(_Declaration):
    """Entries another stack owns carry no `paths` an eda entry could take:
    read as eda, each would be refused; skipped, each is invisible."""

    OTHER_STACKS_MODULE_ENTRIES = '''
[targets."module"]
command = "cargo nextest run --profile module"

[targets."module/java"]
framework = "surefire"
'''

    def test_module_entries_of_other_stacks_leave_the_module_tier_undeclared(self):
        self.project.declare(self.OTHER_STACKS_MODULE_ENTRIES)
        result = self.drive("module")
        self.assert_undeclared_tier(
            result, "module", "module",
            "the only module entries are rust's (no framework) and maven's (surefire)")

    def test_regression_over_only_other_stacks_entries_is_refused_as_declaring_no_eda_entry(self):
        self.project.declare_only_the_board()
        self.project.declare(self.OTHER_STACKS_MODULE_ENTRIES)
        result = self.drive("regression")
        axi = self.assert_hard_stop(result, "regression",
                                    "the only entries are other stacks'")
        self.assertNotIn(DECLARATION_REFUSED_CODE, result.stderr + result.stdout,
                         f"another stack's entry is skipped, not refused; "
                         f"{diagnostics(result)}")
        self.assertIn(FRAMEWORK, said(axi), diagnostics(result))


class AFaultyEdaDeclarationIsRefusedTest(_Declaration):

    def refused(self, tables, *named, why):
        self.project.declare(tables)
        result = self.drive("regression")
        return self.assert_declaration_refused(result, *named, self.project.toml,
                                               why=why)

    def test_a_framework_no_stack_reserves_is_refused_naming_table_field_and_file(self):
        self.refused('[targets."unit/erc"]\nframework = "kicad-erc"\npaths = ["tests/unit"]\n',
                     '[targets."unit/erc"]', "framework",
                     why="framework kicad-erc is reserved by no stack")

    def test_a_key_whose_tier_is_not_one_of_the_five_is_refused(self):
        self.refused(f'[targets."smoke"]\nframework = "{FRAMEWORK}"\npaths = ["tests/unit"]\n',
                     '[targets."smoke"]', why="smoke is no tier")

    def test_a_key_naming_the_regression_tier_is_refused(self):
        self.refused(f'[targets."regression"]\nframework = "{FRAMEWORK}"\n'
                     'paths = ["tests/unit"]\n',
                     '[targets."regression"]',
                     why="regression is not one of unit, module, integration, e2e, bdd")

    def test_a_labelled_key_whose_tier_is_not_one_of_the_five_is_refused(self):
        self.refused(f'[targets."smoke/net"]\nframework = "{FRAMEWORK}"\n'
                     'paths = ["tests/integ"]\n',
                     '[targets."smoke/net"]', why="smoke/net's tier is no tier")

    def test_an_empty_label_is_refused(self):
        self.refused(f'[targets."integration/"]\nframework = "{FRAMEWORK}"\n'
                     'paths = ["tests/integ"]\n',
                     '[targets."integration/"]', why="the label after the slash is empty")

    def test_a_missing_paths_is_refused_naming_the_field(self):
        self.refused(f'[targets."unit/power"]\nframework = "{FRAMEWORK}"\n',
                     '[targets."unit/power"]', "paths", why="the entry has no paths")

    def test_an_empty_paths_is_refused_naming_the_field(self):
        self.refused(f'[targets."unit/power"]\nframework = "{FRAMEWORK}"\npaths = []\n',
                     '[targets."unit/power"]', "paths", why="paths is empty")

    def test_a_paths_that_is_a_string_not_a_list_is_refused_naming_the_field(self):
        self.refused(f'[targets."unit/power"]\nframework = "{FRAMEWORK}"\n'
                     'paths = "tests/unit"\n',
                     '[targets."unit/power"]', "paths", why="paths is a string")

    def test_a_paths_holding_a_non_string_is_refused_naming_the_field(self):
        self.refused(f'[targets."unit/power"]\nframework = "{FRAMEWORK}"\npaths = [7]\n',
                     '[targets."unit/power"]', "paths", why="paths holds an integer")

    def test_a_path_naming_a_missing_directory_is_refused_naming_it(self):
        self.refused(f'[targets."unit/power"]\nframework = "{FRAMEWORK}"\n'
                     'paths = ["tests/unit", "tests/power"]\n',
                     '[targets."unit/power"]', "paths",
                     why="tests/power does not exist")

    def test_a_node_id_on_a_missing_file_is_refused_naming_the_file(self):
        self.refused(f'[targets."unit/power"]\nframework = "{FRAMEWORK}"\n'
                     'paths = ["tests/unit/check_power.py::test_the_rail_holds"]\n',
                     '[targets."unit/power"]', "paths",
                     why="the node id's file does not exist")

    def test_a_node_id_on_an_existing_file_is_not_the_fault_refused(self):
        # Two entries, in key order: `unit/one` names a node id in a file that
        # exists (valid), `unit/zz` has no paths (the fault). Only the fault is
        # named; a reader that took the whole `<file>::<node id>` for a path
        # would refuse `unit/one` too.
        self.project.declare(
            f'[targets."unit/one"]\nframework = "{FRAMEWORK}"\n'
            'paths = ["tests/unit/check_board.py::test_the_netlist_names_every_part"]\n\n'
            f'[targets."unit/zz"]\nframework = "{FRAMEWORK}"\n')
        result = self.drive("regression")
        words = self.assert_declaration_refused(
            result, '[targets."unit/zz"]', "paths", self.project.toml,
            why="unit/zz has no paths beside a valid node-id entry")
        self.assertNotIn('[targets."unit/one"]', words,
                         f"a node id on an existing file is valid; {diagnostics(result)}")

    def test_a_fault_in_the_verbs_own_tier_refuses_that_tier_verb_too(self):
        self.project.declare(f'[targets."unit/power"]\nframework = "{FRAMEWORK}"\n'
                             'paths = ["tests/power"]\n')
        result = self.drive("unit")
        self.assert_declaration_refused(result, '[targets."unit/power"]', "paths",
                                        self.project.toml, verb="unit",
                                        why="the unit tier's own entry names a missing dir")

    def test_a_crucible_toml_that_does_not_parse_is_refused_naming_the_file(self):
        with open(self.project.toml, "a", encoding="utf-8") as handle:
            handle.write('\n[targets."unit/broken"\nframework = \n')
        # The project file no longer parses, so it declares no board either:
        # the board comes from an install of this test's own.
        client = self.install_declaring(self.project.board.url)
        result = self.drive("regression", client=client)
        self.assert_declaration_refused(result, self.project.toml,
                                        why="the project's crucible.toml does not parse")


if __name__ == "__main__":
    unittest.main()
