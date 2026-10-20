"""The bun client's printed help names no project.

`clients/bun-crucible.py` is tool-specific, never project-specific, but two of
its printed help lines still taught one project's layout: the `--package-dir`
help named the `integrations/pi` fallback (a step the resolution no longer
takes), and the `--tests` example was one project's own test file. And the
`test` verb's help did not say that a project can route `test` through a
declared `package.json` script.

What this file pins, by driving the REAL client as a subprocess (the fleet
census's `drive_verb`) for its top-level `--help` and for EVERY verb's
`--help`, the verbs enumerated from the client's own argparse
(`enumerate_verbs`) rather than from a hand list:

`TestVerbHelpStatesTheDeclaredScriptAndTheNameFilterTest`
    `test --help` names the declaration a project routes `test` through --
    `crucible.testScript` in `package.json` -- and the name filter, `--name`,
    passed on as `-t`.

`PackageDirHelpStatesTheDeclaredResolutionTest`
    On every verb that takes `--package-dir`, that option's printed help names
    the variable, then the project's `[bun] package_dir` in `crucible.toml`,
    then the project root, says a relative value resolves against the project
    root, and names no `integrations/pi`.

`NoPrintedHelpNamesAProjectTest`
    No printed help -- top level or any verb's -- names `integrations/pi`, the
    Sandesh project, one of its tests or one of its agents.

The module docstring is not printed and is the design record; nothing here
reads it. Wording is pinned only as far as the requirement fixes it (the
declaration's key, the flag names, the variable, the config key and file, the
order); whitespace is normalised because argparse re-wraps help text.
"""

import argparse
import re
import shutil
import unittest

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _make_project_dir,
    drive_verb,
    enumerate_verbs,
)

BUN_CLIENT = CLIENT_FILES["bun"]

_HELP_ENV = {"COLUMNS": "200", "NO_COLOR": "1", "PYTHON_COLORS": "0"}

#: The `package.json` key a project declares the script `test` runs through.
TEST_SCRIPT_KEY = "crucible.testScript"

#: The package-dir variable, the config key and the file that holds it.
PACKAGE_DIR_VARIABLE = "BUN_CRUCIBLE_PACKAGE_DIR"
PACKAGE_DIR_TABLE = "[bun]"
PACKAGE_DIR_KEY = "package_dir"
PROJECT_CONFIG_FILE = "crucible.toml"

#: The layout step the resolution no longer takes.
REMOVED_FALLBACK = "integrations/pi"

#: Terms no printed help may carry, matched case-insensitively: the project's
#: own name (which also covers agent names built on it), its test file the old
#: `--tests` example used, and the CR-id prefix its agents are named under.
FOREIGN_PROJECT_TERMS = ("integrations/pi", "sandesh", "send.test", "cr-san-")

#: Ways the printed help may name the project root as the last step.
PROJECT_ROOT_SPELLINGS = ("project root", "<project>")


def normalise(text):
    """Whitespace-insensitive help text: every run of whitespace is one space
    and a hyphen argparse broke a line on is re-joined."""
    collapsed = re.sub(r"\s+", " ", text or "")
    return re.sub(r"-\s+", "-", collapsed).strip()


def option_help(help_text, option):
    """The printed help entry of `option` in an argparse help: from the line
    that introduces it to the next line that introduces another option or a
    section, normalised. Empty when the option is not printed."""
    lines = help_text.splitlines()
    start = None
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if start is None:
            if re.match(rf"{re.escape(option)}(\s|,|$)", stripped):
                start = index
            continue
        if stripped.startswith("-") and line.startswith("  ") and not line.startswith(" " * 6):
            return normalise("\n".join(lines[start:index]))
        if line and not line.startswith(" "):
            return normalise("\n".join(lines[start:index]))
    return normalise("\n".join(lines[start:])) if start is not None else ""


def _subparsers_of(parser):
    return [a for a in parser._actions if isinstance(a, argparse._SubParsersAction)]


def _verb_paths(verbs, prefix=()):
    """Every verb path `(verb,)` / `(verb, sub)` with its parser, recursing
    into any verb that carries subcommands of its own."""
    for name, parser in verbs.items():
        path = prefix + (name,)
        yield path, parser
        for action in _subparsers_of(parser):
            yield from _verb_paths(dict(action.choices), path)


_CENSUS = None


def _help_census():
    """`{verb_path: (completed_process, takes_package_dir)}` for the top level
    (path `()`) and every verb, driven once per test run."""
    global _CENSUS
    if _CENSUS is not None:
        return _CENSUS
    verbs = enumerate_verbs("bun", BUN_CLIENT)
    paths = [((), None)] + list(_verb_paths(verbs))
    fake_bin_dir = _build_fake_bin_dir()
    project_dir = _make_project_dir("bun")
    census = {}
    try:
        for path, parser in paths:
            completed = drive_verb(BUN_CLIENT, list(path) + ["--help"],
                                   project_dir, fake_bin_dir,
                                   extra_env=_HELP_ENV)
            takes = (parser is not None
                     and "--package-dir" in parser._option_string_actions)
            census[path] = (completed, takes)
    finally:
        shutil.rmtree(project_dir, ignore_errors=True)
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _CENSUS = census
    return census


def _label(path):
    return " ".join(path) + " --help" if path else "--help"


class _HelpCensusCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.census = _help_census()

    def printed(self, path):
        completed, _ = self.census[path]
        self.assertEqual(completed.returncode, 0,
                         f"bun-crucible {_label(path)} must exit 0")
        self.assertIn("usage:", completed.stdout,
                      f"bun-crucible {_label(path)} printed no usage")
        return completed.stdout


class TestVerbHelpStatesTheDeclaredScriptAndTheNameFilterTest(_HelpCensusCase):

    def test_test_help_names_the_declared_test_script_key_in_package_json(self):
        text = normalise(self.printed(("test",)))
        self.assertIn(
            TEST_SCRIPT_KEY, text,
            f"`test --help` must name `{TEST_SCRIPT_KEY}`, the package.json "
            "declaration a project routes `test` through")
        self.assertIn(
            "package.json", text,
            "`test --help` must say the declared test script lives in "
            "package.json")

    def test_test_help_states_the_name_filter_beside_the_declared_script(self):
        printed = self.printed(("test",))
        text = normalise(printed)
        name_entry = option_help(printed, "--name")
        self.assertIn("-t", name_entry,
                      "`test --help` must say `--name` is passed on as `-t`")
        self.assertIn(
            TEST_SCRIPT_KEY, text,
            "`test --help` must state the name filter AND the declared test "
            f"script `{TEST_SCRIPT_KEY}` it reaches")


class PackageDirHelpStatesTheDeclaredResolutionTest(_HelpCensusCase):

    def package_dir_verbs(self):
        verbs = sorted(path for path, (_, takes) in self.census.items() if takes)
        for expected in ("test", "check", "regression", "auto-ingest",
                         "pre-merge-gate"):
            self.assertIn((expected,), verbs,
                          f"`{expected}` must take --package-dir; the census "
                          "found no such option on it")
        return verbs

    def entries(self):
        return {path: option_help(self.printed(path), "--package-dir")
                for path in self.package_dir_verbs()}

    def test_every_package_dir_help_names_the_variable_then_the_declared_key_then_the_project_root(self):
        offenders = {}
        for path, entry in self.entries().items():
            lowered = entry.lower()
            variable_at = entry.find(PACKAGE_DIR_VARIABLE)
            key_at = entry.find(PACKAGE_DIR_KEY, max(variable_at, 0))
            root_at = max((lowered.find(s, max(key_at, 0))
                           for s in PROJECT_ROOT_SPELLINGS), default=-1)
            if (variable_at < 0 or key_at < 0 or root_at < 0
                    or PACKAGE_DIR_TABLE not in entry
                    or PROJECT_CONFIG_FILE not in entry):
                offenders[_label(path)] = entry
        self.assertEqual(
            offenders, {},
            "every --package-dir help must state the resolution: the flag, "
            f"then ${PACKAGE_DIR_VARIABLE}, then the project's "
            f"`{PACKAGE_DIR_TABLE} {PACKAGE_DIR_KEY}` in {PROJECT_CONFIG_FILE}, "
            f"then the project root; it does not on: {offenders!r}")

    def test_every_package_dir_help_says_a_relative_value_resolves_against_the_project_root(self):
        offenders = {}
        for path, entry in self.entries().items():
            lowered = entry.lower()
            relative_at = lowered.find("relative")
            if relative_at < 0 or not any(
                    s in lowered[relative_at:] for s in PROJECT_ROOT_SPELLINGS):
                offenders[_label(path)] = entry
        self.assertEqual(
            offenders, {},
            "every --package-dir help must say a relative value resolves "
            f"against the project root; it does not on: {offenders!r}")

    def test_no_package_dir_help_names_the_removed_layout_fallback(self):
        offenders = sorted(_label(path) for path, entry in self.entries().items()
                           if REMOVED_FALLBACK in entry)
        self.assertEqual(
            offenders, [],
            f"the --package-dir help must not name `{REMOVED_FALLBACK}`, a "
            f"step the resolution no longer takes; named on: {offenders!r}")


class NoPrintedHelpNamesAProjectTest(_HelpCensusCase):

    def test_the_census_covers_the_top_level_and_every_verb(self):
        self.assertIn((), self.census, "the top-level --help must be driven")
        for verb in ("test", "register", "regression", "check", "auto-ingest",
                     "pre-merge-gate", "plan-file"):
            self.assertIn((verb,), self.census,
                          f"`{verb}` must be among the enumerated verbs")
        self.assertGreater(len(self.census), 20,
                           "the census must drive every verb's help, not a few")
        for path in self.census:
            self.printed(path)

    def test_no_printed_help_names_integrations_pi(self):
        offenders = sorted(_label(path) for path in self.census
                           if REMOVED_FALLBACK in normalise(self.printed(path)))
        self.assertEqual(
            offenders, [],
            f"no printed help may name `{REMOVED_FALLBACK}`; named by: "
            f"{offenders!r}")

    def test_no_printed_help_names_sandesh_or_one_of_its_tests_or_agents(self):
        offenders = {}
        for path in self.census:
            lowered = normalise(self.printed(path)).lower()
            found = [term for term in FOREIGN_PROJECT_TERMS if term in lowered]
            if found:
                offenders[_label(path)] = found
        self.assertEqual(
            offenders, {},
            "no printed help or example may name a project, its tests or its "
            f"agents; terms found per help: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
