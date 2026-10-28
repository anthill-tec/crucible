"""The arduino client's printed help writes down the `make` contract a
project's Makefile must honour, and only `test` and `unit` narrow a run.

`arduino-crucible.py` hands a native run to the project's own Makefile through
four variables: `REPORTS_DIR` and `COVERAGE_DIR` (where to write), `TESTS` (the
test files to run, by stem) and `TEST_NAME` (Unity's `-f` name filter). That
contract is the client's to document, so its root `--help` carries a `make`
contract section, kept AS WRITTEN — the root parser uses argparse's
`RawDescriptionHelpFormatter`, as the bun, python and maven clients do, so the
section's line structure (one variable per line, a Makefile snippet) survives
instead of being reflowed into one paragraph. The section shows:

  * `TESTS ?=` — an environment variable loses to a plain `TESTS = ...`
    assignment in a Makefile, so the Makefile must default it with `?=`;
  * the quoted `-f "$(TEST_NAME)"` — unquoted, a `*` in a name fragment is
    expanded by the recipe shell as a file pattern;
  * the Unity runner requirement — `UNITY_USE_COMMAND_LINE_ARGS` alone is not
    enough, the generated runner must parse its options (the runner
    generator's `cmdline_args` option);
  * one `TEST-<stem>.xml` per test file.

The `--tests` and `--name` flags' own help points at that section.

Which verbs take the two narrowing flags is read off the PARSED options —
the client's root parser captured at its `parse_args` call, the seam
`_root_parser` in `tests/client/test_client_tier_verb_contract.py` uses — not
off help text, where a flag named in prose would read as present: `test` and
`unit` take both; `regression`, `pre-merge-gate`, `auto-ingest` and the
declared tier verbs (`module`, `integration`, `e2e`, `bdd`) take neither.

What each class pins:

  `MakeContractHelpSectionTest`               the root help carries the
                                              contract section, kept as
                                              written, with the points above.
  `NarrowingFlagHelpPointsToTheContractTest`  each narrowing flag's help
                                              points at that section.
  `NarrowingFlagsByParsedOptionsTest`         `test` and `unit` take both
                                              flags, and no other verb takes
                                              either.

The help is read from the REAL client run as a subprocess (`--help` needs no
board and resolves no project); the parser is captured in-process and no verb
is ever dispatched.

Invocation:
    python3 -m unittest tests.client.test_the_arduino_client_help_writes_down_its_make_contract -v
"""

import argparse
import contextlib
import importlib.util
import io
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
ARDUINO_CLIENT = REPO_ROOT / "clients" / "arduino-crucible.py"

CONTRACT_VARIABLES = ("REPORTS_DIR", "COVERAGE_DIR", "TESTS", "TEST_NAME")
NARROWING_FLAGS = ("--tests", "--name")
NARROWING_VERBS = ("test", "unit")
UNNARROWED_VERBS = ("regression", "pre-merge-gate", "auto-ingest",
                    "module", "integration", "e2e", "bdd")


def _load_client_module():
    spec = importlib.util.spec_from_file_location(
        "arduino_crucible_under_test_make_contract_help", ARDUINO_CLIENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_PARSER_CACHE = {}


def _root_parser():
    """The client's ROOT argparse parser, captured at the moment it parses.

    Mirrors `_root_parser` in `test_client_tier_verb_contract`: `main()` builds
    the parser inline, so `parse_args` is spied on, the bound `self` kept, and
    `SystemExit` raised before any verb is dispatched."""
    if "root" in _PARSER_CACHE:
        return _PARSER_CACHE["root"]
    module = _load_client_module()
    captured = {}

    def spy(self, args=None, namespace=None):
        captured.setdefault("root", self)
        raise SystemExit(0)

    with mock.patch.object(argparse.ArgumentParser, "parse_args", spy), \
            mock.patch.object(sys, "argv", ["arduino-crucible.py", "status"]), \
            contextlib.redirect_stdout(io.StringIO()), \
            contextlib.redirect_stderr(io.StringIO()), \
            contextlib.suppress(SystemExit):
        module.main()
    root = captured.get("root")
    assert root is not None, "arduino-crucible.py never parsed its arguments"
    _PARSER_CACHE["root"] = root
    return root


def _verb_parsers():
    for action in _root_parser()._actions:
        if isinstance(action, argparse._SubParsersAction):
            return action.choices
    return {}


def _option_strings(verb):
    parser = _verb_parsers().get(verb)
    assert parser is not None, f"the root parser carries no {verb!r} verb"
    return {s for action in parser._actions for s in action.option_strings}


def _flag_help(verb, flag):
    parser = _verb_parsers().get(verb)
    assert parser is not None, f"the root parser carries no {verb!r} verb"
    for action in parser._actions:
        if flag in action.option_strings:
            return action.help or ""
    raise AssertionError(f"{verb!r} carries no {flag} option")


def _plain(text):
    """Lower-cased, backticks dropped, whitespace runs collapsed — so a phrase
    is found whether or not it was typeset or wrapped."""
    return " ".join(text.replace("`", "").lower().split())


_HELP_CACHE = {}


def _root_help():
    """`arduino-crucible.py --help` as the real client prints it."""
    if "root" in _HELP_CACHE:
        return _HELP_CACHE["root"]
    scratch = tempfile.mkdtemp(prefix="arduino-make-contract-help-", dir="/tmp")
    try:
        result = subprocess.run(
            [sys.executable, str(ARDUINO_CLIENT), "--help"],
            cwd=scratch, capture_output=True, text=True, timeout=60,
            check=False)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    assert result.returncode == 0, (
        f"`arduino-crucible.py --help` exited {result.returncode}; "
        f"stderr={result.stderr[-2000:]!r}")
    _HELP_CACHE["root"] = result.stdout
    return result.stdout


def _variable_starts_a_line(help_text, variable):
    """True when some help line BEGINS with `variable` (after indentation, an
    optional list bullet and an optional backtick) — the shape a
    one-variable-per-line list or a Makefile snippet keeps only when the
    section is printed as written."""
    pattern = re.compile(
        r"^[ \t]*(?:[-*\u2022][ \t]+)?`?" + re.escape(variable) + r"(?![A-Za-z0-9_])",
        re.MULTILINE)
    return pattern.search(help_text) is not None


class MakeContractHelpSectionTest(unittest.TestCase):
    """The root `--help` carries the `make` contract section, kept as written."""

    def test_root_parser_keeps_its_help_text_as_written(self):
        formatter = _root_parser().formatter_class
        self.assertTrue(
            isinstance(formatter, type)
            and issubclass(formatter, argparse.RawDescriptionHelpFormatter),
            "the root parser must print its description/epilog as written "
            "(RawDescriptionHelpFormatter, as bun, python and maven do); "
            f"it uses {getattr(formatter, '__name__', formatter)!r}")

    def test_root_help_has_a_section_titled_make_contract(self):
        self.assertTrue("make contract" in _plain(_root_help()),
                        "the root --help carries no `make` contract section")

    def test_root_help_names_each_contract_variable_on_its_own_line(self):
        help_text = _root_help()
        missing = [v for v in CONTRACT_VARIABLES
                   if not _variable_starts_a_line(help_text, v)]
        self.assertEqual(
            missing, [],
            "each make-contract variable starts its own line of the root "
            f"--help (the section kept as written); none does for {missing!r}")

    def test_root_help_shows_tests_defaulted_with_conditional_assignment(self):
        help_text = _root_help()
        self.assertTrue("TESTS ?=" in help_text,
                        "the contract shows `TESTS ?=` — an environment "
                        "variable loses to a plain assignment in the Makefile")
        self.assertTrue(
            re.search(r"^[ \t]*(?:[-*\u2022][ \t]+)?`?TESTS \?=", help_text,
                      re.MULTILINE),
            "`TESTS ?=` begins its own line, as a Makefile line does")

    def test_root_help_shows_test_name_quoted_as_unitys_name_filter(self):
        help_text = _root_help()
        self.assertTrue('-f "$(TEST_NAME)"' in help_text,
                        'the contract shows the quoted `-f "$(TEST_NAME)"`')
        self.assertIsNone(re.search(r"-f \$\(TEST_NAME\)", help_text),
                          "TEST_NAME is never shown unquoted after -f")

    def test_root_help_states_the_unity_runner_requirement(self):
        help_text = _root_help()
        self.assertTrue("UNITY_USE_COMMAND_LINE_ARGS" in help_text,
                        "the contract names UNITY_USE_COMMAND_LINE_ARGS")
        self.assertTrue("cmdline_args" in help_text,
                        "the contract names the runner generator's "
                        "cmdline_args option, so the runner parses its own "
                        "options")

    def test_root_help_recommends_one_report_per_test_file(self):
        self.assertTrue("TEST-<stem>.xml" in _root_help(),
                        "the contract recommends one TEST-<stem>.xml per test "
                        "file")


class NarrowingFlagHelpPointsToTheContractTest(unittest.TestCase):
    """`--tests` and `--name`'s own help points to the root help's section."""

    def _assert_points_to_contract(self, verb, flag):
        text = _plain(_flag_help(verb, flag))
        self.assertIn("make contract", text,
                      f"`{verb} {flag}`'s help points to the root --help's "
                      f"make contract section; it reads {text!r}")

    def test_tests_flag_help_on_test_points_to_the_make_contract(self):
        self._assert_points_to_contract("test", "--tests")

    def test_name_flag_help_on_test_points_to_the_make_contract(self):
        self._assert_points_to_contract("test", "--name")

    def test_tests_flag_help_on_unit_points_to_the_make_contract(self):
        self._assert_points_to_contract("unit", "--tests")

    def test_name_flag_help_on_unit_points_to_the_make_contract(self):
        self._assert_points_to_contract("unit", "--name")


class NarrowingFlagsByParsedOptionsTest(unittest.TestCase):
    """GREEN-GUARD — by parsed options, only `test` and `unit` narrow."""

    def test_test_and_unit_take_both_narrowing_flags(self):
        for verb in NARROWING_VERBS:
            with self.subTest(verb=verb):
                options = _option_strings(verb)
                self.assertEqual(
                    sorted(f for f in NARROWING_FLAGS if f in options),
                    sorted(NARROWING_FLAGS),
                    f"{verb!r} takes --tests and --name")

    def test_unnarrowed_verbs_take_neither_narrowing_flag(self):
        for verb in UNNARROWED_VERBS:
            with self.subTest(verb=verb):
                options = _option_strings(verb)
                self.assertEqual(
                    sorted(f for f in NARROWING_FLAGS if f in options), [],
                    f"{verb!r} never narrows a run, so takes neither "
                    "--tests nor --name")


if __name__ == "__main__":
    unittest.main()
