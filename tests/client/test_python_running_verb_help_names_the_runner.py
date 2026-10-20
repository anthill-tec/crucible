"""Every running verb's printed help says how the runner is chosen.

The python client runs `unittest` by default and `pytest` when the project
declares `[python] runner = "pytest"` in its own `crucible.toml` or the caller
passes `--runner pytest`. A user who reads `<verb> --help` must be able to
learn that from the help alone:

`EveryRunningVerbHelpNamesTheRunnerChoiceTest`
    On every running verb -- `test`, `pre-merge-gate` and every tier verb,
    enumerated from the client's own argparse rather than a hand list -- the
    printed `--runner` entry names `--runner`'s two values, the
    `[python] runner` declaration in `crucible.toml`, that `unittest` is the
    default, and that the interpreter needs pytest for it.

`TheTestsSelectorNamesPytestNodeIdsTest`
    `test --help`'s `--tests` entry says that under pytest it takes node ids.

`DiscoveryFlagsNameThePytestRuleTest`
    `--pattern` on every running verb, and `--start-dir` on every running verb
    whose start dir has a default (`test`, the full-suite tier verb and
    `pre-merge-gate`), say that under pytest the project's own configuration
    decides unless the flag is given -- while still naming the `unittest`
    defaults, which do not change.

Everything is read from the REAL client driven as a subprocess (the fleet
census's `drive_verb`), verbs enumerated by its `enumerate_verbs`. Wording is
pinned only as far as the requirement fixes it: words and names, never a
full-text snapshot; whitespace is normalised because argparse re-wraps help.
The declared tier cells' `--start-dir` is deliberately left unpinned here: on
those verbs the start dir IS the tier's declaration and has no default, so the
"configuration decides unless given" rule cannot describe it.

`check` and `auto-ingest` take no `--runner`; that is pinned beside the
runner's declaration (`CheckAndAutoIngestTakeNoRunnerTest` in
`tests.client.test_python_runner_is_declared_by_the_project`) and not repeated
here.

Invocation:
    python3 -m unittest tests.client.test_python_running_verb_help_names_the_runner -v
"""

import importlib.util
import re
import shutil
import unittest

from tests.client.test_bun_client_printed_help_names_no_project import option_help
from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    CLIENTS_DIR,
    _build_fake_bin_dir,
    _make_project_dir,
    drive_verb,
    enumerate_verbs,
)

PYTHON_CLIENT = CLIENT_FILES["python"]

_HELP_ENV = {"COLUMNS": "200", "NO_COLOR": "1", "PYTHON_COLORS": "0"}

RUNNER_FLAG = "--runner"
TESTS_FLAG = "--tests"
START_DIR_FLAG = "--start-dir"
PATTERN_FLAG = "--pattern"

#: The declaration that chooses the runner, and the file it lives in.
RUNNER_DECLARATION = "[python] runner"
PROJECT_CONFIG_FILE = "crucible.toml"

#: The two runner names.
UNITTEST = "unittest"
PYTEST = "pytest"

#: The verbs that run tests but are not tier verbs.
NON_TIER_RUNNING_VERBS = ("test", "pre-merge-gate")

#: The tier verb whose discovery is the full suite and keeps the `unittest`
#: start-dir default; every other tier verb is a declared cell whose start dir
#: is its declaration.
FULL_SUITE_TIER = "regression"

#: The `unittest` discovery defaults the help keeps naming.
UNITTEST_START_DIR = "tests"
UNITTEST_PATTERN = "test_*.py"

# Word rules, matched case-insensitively against a normalised entry. Each
# clause is bounded by a sentence break so two words in unrelated sentences
# do not satisfy it.
_UNITTEST_IS_DEFAULT = re.compile(
    r"\bunittest\b[^.;]*\bdefault\b|\bdefault\b[^.;]*\bunittest\b", re.I)
_INTERPRETER_NEEDS_PYTEST = re.compile(
    r"\binterpreter\b[^.;]*\bpytest\b|\bpytest\b[^.;]*\binterpreter\b", re.I)
_NODE_IDS = re.compile(r"\bnode[ -]?ids?\b", re.I)
_PROJECT_CONFIG_DECIDES = re.compile(
    r"\bproject\b[^.;]*\bconfig(uration)?\b", re.I)
_UNITTEST_START_DIR_DEFAULT = re.compile(
    rf"\bdefault\b[^.;]*\b{UNITTEST_START_DIR}\b"
    rf"|\b{UNITTEST_START_DIR}\b[^.;]*\bdefault\b", re.I)


def _load_axi():
    """The fleet's own loader idiom for the shared module."""
    spec = importlib.util.spec_from_file_location(
        "_crucible_axi_running_verb_help", CLIENTS_DIR / "_crucible_axi.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_CENSUS = None


def _help_census():
    """`{verb: (completed_process, parser)}` for every top-level verb of the
    python client, its `--help` driven once per test run."""
    global _CENSUS
    if _CENSUS is not None:
        return _CENSUS
    verbs = enumerate_verbs("python", PYTHON_CLIENT)
    fake_bin_dir = _build_fake_bin_dir()
    project_dir = _make_project_dir("python")
    census = {}
    try:
        for name, parser in verbs.items():
            completed = drive_verb(PYTHON_CLIENT, [name, "--help"],
                                   project_dir, fake_bin_dir,
                                   extra_env=_HELP_ENV)
            census[name] = (completed, parser)
    finally:
        shutil.rmtree(project_dir, ignore_errors=True)
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _CENSUS = census
    return census


def _takes(parser, flag):
    return flag in parser._option_string_actions


class _RunningVerbHelpCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.census = _help_census()
        cls.tier_verbs = tuple(_load_axi().TIER_MEANINGS)

    def running_verbs(self):
        """Every verb that selects tests to run -- the ones taking a discovery
        start dir or a test selector -- in census order."""
        return [name for name, (_, parser) in self.census.items()
                if _takes(parser, START_DIR_FLAG) or _takes(parser, TESTS_FLAG)]

    def printed(self, verb):
        completed, _ = self.census[verb]
        self.assertEqual(completed.returncode, 0,
                         f"python-crucible {verb} --help must exit 0, "
                         f"exited {completed.returncode}")
        self.assertIn("usage:", completed.stdout,
                      f"python-crucible {verb} --help printed no usage")
        return completed.stdout

    def entry(self, verb, flag):
        text = option_help(self.printed(verb), flag)
        self.assertNotEqual(text, "",
                            f"`{verb} --help` must print a `{flag}` entry")
        return text


class EveryRunningVerbHelpNamesTheRunnerChoiceTest(_RunningVerbHelpCase):

    def test_the_running_verbs_are_test_pre_merge_gate_and_every_tier_verb(self):
        expected = sorted({*NON_TIER_RUNNING_VERBS, *self.tier_verbs})
        self.assertEqual(sorted(self.running_verbs()), expected,
                         "the verbs that run tests must be exactly `test`, "
                         "`pre-merge-gate` and every tier verb")

    def test_every_running_verb_help_prints_a_runner_entry(self):
        missing = [verb for verb in self.running_verbs()
                   if option_help(self.printed(verb), RUNNER_FLAG) == ""]
        self.assertEqual(missing, [],
                         f"every running verb's help must print `{RUNNER_FLAG}`; "
                         f"missing on: {missing!r}")

    def test_every_runner_entry_names_both_runners(self):
        for verb in self.running_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, RUNNER_FLAG)
                self.assertIn(UNITTEST, text, f"`{verb}` {RUNNER_FLAG}: {text!r}")
                self.assertIn(PYTEST, text, f"`{verb}` {RUNNER_FLAG}: {text!r}")

    def test_every_runner_entry_names_the_python_runner_declaration_in_crucible_toml(self):
        for verb in self.running_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, RUNNER_FLAG)
                self.assertIn(RUNNER_DECLARATION, text,
                              f"`{verb}` {RUNNER_FLAG}: {text!r}")
                self.assertIn(PROJECT_CONFIG_FILE, text,
                              f"`{verb}` {RUNNER_FLAG}: {text!r}")

    def test_every_runner_entry_names_unittest_as_the_default(self):
        for verb in self.running_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, RUNNER_FLAG)
                self.assertRegex(text, _UNITTEST_IS_DEFAULT,
                                 f"`{verb}` {RUNNER_FLAG} must say {UNITTEST} "
                                 f"is the default: {text!r}")

    def test_every_runner_entry_says_the_interpreter_needs_pytest(self):
        for verb in self.running_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, RUNNER_FLAG)
                self.assertRegex(text, _INTERPRETER_NEEDS_PYTEST,
                                 f"`{verb}` {RUNNER_FLAG} must say the "
                                 f"interpreter needs pytest: {text!r}")


class TheTestsSelectorNamesPytestNodeIdsTest(_RunningVerbHelpCase):

    def test_tests_entry_says_it_takes_node_ids_under_pytest(self):
        text = self.entry("test", TESTS_FLAG)
        self.assertIn(PYTEST, text,
                      f"`test` {TESTS_FLAG} must name pytest: {text!r}")
        self.assertRegex(text, _NODE_IDS,
                         f"`test` {TESTS_FLAG} must say it takes node ids "
                         f"under pytest: {text!r}")


class DiscoveryFlagsNameThePytestRuleTest(_RunningVerbHelpCase):

    def defaulted_start_dir_verbs(self):
        return [*NON_TIER_RUNNING_VERBS, FULL_SUITE_TIER]

    def test_every_pattern_entry_says_the_projects_config_decides_under_pytest(self):
        for verb in self.running_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, PATTERN_FLAG)
                self.assertIn(PYTEST, text,
                              f"`{verb}` {PATTERN_FLAG} must name pytest: {text!r}")
                self.assertRegex(text, _PROJECT_CONFIG_DECIDES,
                                 f"`{verb}` {PATTERN_FLAG} must say the project's "
                                 f"configuration decides under pytest: {text!r}")

    def test_every_defaulted_start_dir_entry_says_the_projects_config_decides_under_pytest(self):
        for verb in self.defaulted_start_dir_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, START_DIR_FLAG)
                self.assertIn(PYTEST, text,
                              f"`{verb}` {START_DIR_FLAG} must name pytest: {text!r}")
                self.assertRegex(text, _PROJECT_CONFIG_DECIDES,
                                 f"`{verb}` {START_DIR_FLAG} must say the project's "
                                 f"configuration decides under pytest: {text!r}")

    def test_every_pattern_entry_still_names_the_unittest_default_pattern(self):
        for verb in self.running_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, PATTERN_FLAG)
                self.assertIn(UNITTEST_PATTERN, text,
                              f"`{verb}` {PATTERN_FLAG}: {text!r}")

    def test_every_defaulted_start_dir_entry_still_names_the_unittest_default(self):
        for verb in self.defaulted_start_dir_verbs():
            with self.subTest(verb=verb):
                text = self.entry(verb, START_DIR_FLAG)
                self.assertRegex(text, _UNITTEST_START_DIR_DEFAULT,
                                 f"`{verb}` {START_DIR_FLAG} must still name "
                                 f"`{UNITTEST_START_DIR}` as the default: {text!r}")


if __name__ == "__main__":
    unittest.main()
