"""A bun `test` run refuses a `--tests` entry that names no test.

`bun-crucible.py test --tests <entry> …` on a plain `bun test` run (no
`crucible.targets` entry marked `"test": true`) resolves each entry against
the resolved package directory -- unless it is absolute -- and refuses the
run when an entry:

- names nothing that exists: `tests-not-found`;
- names an existing FILE whose name carries none of bun's test-file markers
  (`.test`, `_test_`, `.spec`, `_spec_`): `tests-not-a-test-file`.

An existing directory passes. A refused run runs nothing, makes no board
request, leaves the reports directory as it found it, exits 1 and prints ONE
`ok: false` envelope: `error` lists every refused entry as given, `warnings`
holds one `{code, detail}` per refusal kind present (each detail naming its
entries), and `help[0]` names the directory the entries were resolved against.

A marked `test` script's entries are its runner's filters: they are neither
checked nor rewritten, and reach the script exactly as given. `test --help`
says all of this, in the verb's description and on its `--tests` line.

── Tier ──────────────────────────────────────────────────────────────────────

UNIT. The bun client is loaded IN PROCESS from the test install through
`run_client` (the in-process harness of
`test_a_client_with_no_board_declared_refuses`): its shared module's install
dir is patched to a scratch directory this module owns, the transport is a
recording fake of `urllib.request.urlopen` (no socket) and every spawn goes
through a recording fake of `subprocess.Popen` (no process). The scratch
project, its package and its reports directory are temp directories each test
creates and removes. No operator file is read.
"""

import json
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.client_fleet_envelope_census_helpers import declare_and_require_board
from tests.client.unit.test_a_client_with_no_board_declared_refuses import (
    PROJECT_BOARD,
    run_client,
    write_env,
)

AGENT = "tests-entry-check-agent"
CYCLE = "42"
#: The `--bun` the drives name: the recording spawn seam records it and
#: starts nothing, so it never has to exist.
FAKE_BUN = "recorded-bun"

NOT_FOUND = "tests-not-found"
NOT_A_TEST_FILE = "tests-not-a-test-file"
REFUSAL_CODES = (NOT_FOUND, NOT_A_TEST_FILE)

PRESENT = "present.test.ts"
ABSENT = "absent.test.ts"
ABSENT_TOO = "absent-too.test.ts"
NON_TEST_SOURCE = "helper.ts"
SENTINEL = "helper-ran.sentinel"
PROJECT_CONFIG = "# The scratch project's own configuration.\n"
PLANTED_JUNIT = '<?xml version="1.0"?><testsuites name="planted-before-the-run"/>\n'

_TEST_SOURCE = 'import { test } from "bun:test";\n\ntest("present", () => {});\n'


def _non_test_source(sentinel_path):
    """A source file that is not a test: its top-level code writes the
    sentinel, so any run that imported it leaves the sentinel behind."""
    return ('import { writeFileSync } from "node:fs";\n\n'
            f'writeFileSync({json.dumps(str(sentinel_path))}, "ran");\n'
            'export const helper = 1;\n')


class _ScratchPackageCase(unittest.TestCase):
    """A scratch project that is its own bun package (no `crucible.targets`
    entry marked `"test": true`), a scratch install, and a reports directory
    holding a `junit.xml` planted before the run."""

    def setUp(self):
        self.project = Path(tempfile.mkdtemp(prefix="tests-entry-check-project-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.install = Path(tempfile.mkdtemp(prefix="tests-entry-check-install-"))
        self.addCleanup(shutil.rmtree, self.install, True)
        write_env(self.project)
        # The project's own configuration, readable and declaring nothing.
        (self.project / "crucible.toml").write_text(PROJECT_CONFIG, encoding="utf-8")
        self.package = self.project
        self.write_package(self.package)
        (self.package / PRESENT).write_text(_TEST_SOURCE, encoding="utf-8")
        self.reports = self.package / "reports"
        self.reports.mkdir()
        self.junit = self.reports / "junit.xml"
        self.junit.write_text(PLANTED_JUNIT, encoding="utf-8")

    @staticmethod
    def write_package(directory, manifest=None):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "package.json").write_text(
            json.dumps(manifest or {"name": "tests-entry-check-fixture"}),
            encoding="utf-8")

    def drive(self, *tests, extra=()):
        return run_client(
            "bun",
            ["test", "--project-dir", str(self.project), "--bun", FAKE_BUN,
             "--reports", "reports", *extra, "--tests", *tests],
            self.install)

    # ── what a refusal looks like ──────────────────────────────────────────

    def assert_refused(self, drive, refused, kept=(), help_dir=None):
        """`drive` refused the run: `refused` maps each refusal code present
        to the entries it names (exactly as given); `kept` are entries that
        were not refused and must not be named."""
        diagnostics = drive.summary()
        self.assertIsNone(drive.escaped, f"nothing may escape main(): {diagnostics}")
        self.assertEqual(drive.envelope_count, 1, f"exactly one envelope: {diagnostics}")
        axi = drive.axi()
        self.assertIsInstance(axi, dict, diagnostics)
        warnings = [w for w in axi.get("warnings") or []
                    if isinstance(w, dict) and w.get("code") in REFUSAL_CODES]
        codes = sorted(str(w.get("code")) for w in warnings)
        self.assertEqual(
            codes, sorted(refused),
            f"one warning per refusal kind present, {sorted(refused)}: {diagnostics}")
        for warning in warnings:
            code, detail = warning.get("code"), str(warning.get("detail") or "")
            for entry in refused.get(code, ()):
                self.assertIn(entry, detail,
                              f"the {code} detail names {entry!r}: {warning!r}")
            others = [e for c, entries in refused.items() if c != code
                      for e in entries]
            for entry in [*kept, *others]:
                self.assertNotIn(entry, detail,
                                 f"the {code} detail names only its own entries, "
                                 f"never {entry!r}: {warning!r}")
        self.assertIs(axi.get("ok"), False, diagnostics)
        error = axi.get("error")
        error_text = error if isinstance(error, str) else json.dumps(error)
        for entries in refused.values():
            for entry in entries:
                self.assertIn(entry, error_text,
                              f"`error` lists every refused entry: {diagnostics}")
        for entry in kept:
            self.assertNotIn(entry, error_text,
                             f"`error` lists only the refused entries: {diagnostics}")
        help_lines = axi.get("help") or []
        self.assertTrue(help_lines, f"the refusal carries help: {diagnostics}")
        directory = help_dir or self.package
        self.assertTrue(
            any(form in str(help_lines[0])
                for form in (str(directory), os.path.realpath(directory))),
            f"help[0] names the directory the entries were resolved against, "
            f"{directory}: {help_lines!r}")
        self.assertEqual(drive.spawns.work(), [],
                         f"a refused run spawns no runner: {diagnostics}")
        self.assertEqual(drive.transport.requests, [],
                         f"a refused run makes no board request: {diagnostics}")
        self.assertEqual(drive.code, 1, f"a refused run exits 1: {diagnostics}")
        self.assertTrue(self.junit.is_file(),
                        f"the reports directory is left as it was: the planted "
                        f"junit.xml is still there: {diagnostics}")
        self.assertEqual(self.junit.read_text(encoding="utf-8"), PLANTED_JUNIT,
                         f"the planted junit.xml is untouched: {diagnostics}")

    def assert_not_refused(self, drive, entry):
        """`drive` was not refused: the run reached `bun test` once, with
        `entry` among its arguments (as given or in its `./` path form), and
        no refusal code was printed."""
        diagnostics = drive.summary()
        for code in REFUSAL_CODES:
            self.assertNotIn(code, drive.out, f"nothing is refused: {diagnostics}")
        work = drive.spawns.work()
        self.assertEqual(len(work), 1, f"the run spawns bun once: {diagnostics}")
        argv = work[0] if work else []
        self.assertEqual(argv[:2], [FAKE_BUN, "test"], diagnostics)
        forms = {entry, entry if entry.startswith(("./", "../", "/")) else f"./{entry}"}
        self.assertTrue(forms & set(argv),
                        f"the entry reaches bun as {sorted(forms)}: {diagnostics}")


class AMissingEntryRefusesTheRunTest(_ScratchPackageCase):
    """`test --tests <existing> <missing>`: nothing runs, the run is refused
    under `tests-not-found` naming the missing entry and only it."""

    def setUp(self):
        super().setUp()
        declare_and_require_board(self.project, PROJECT_BOARD,
                                  label="the bun client in process")

    def test_a_missing_entry_beside_an_existing_one_is_refused_without_an_agent(self):
        drive = self.drive(PRESENT, ABSENT)
        self.assert_refused(drive, {NOT_FOUND: [ABSENT]}, kept=[PRESENT])

    def test_a_missing_entry_beside_an_existing_one_is_refused_with_an_agent(self):
        drive = self.drive(PRESENT, ABSENT, extra=("--agent", AGENT))
        self.assert_refused(drive, {NOT_FOUND: [ABSENT]}, kept=[PRESENT])

    def test_a_missing_entry_beside_an_existing_one_is_refused_with_an_agent_and_a_cycle(self):
        drive = self.drive(PRESENT, ABSENT, extra=("--agent", AGENT, "--cycle", CYCLE))
        self.assert_refused(drive, {NOT_FOUND: [ABSENT]}, kept=[PRESENT])

    def test_a_run_whose_every_entry_is_missing_is_refused_naming_each(self):
        drive = self.drive(ABSENT, ABSENT_TOO, extra=("--agent", AGENT))
        self.assert_refused(drive, {NOT_FOUND: [ABSENT, ABSENT_TOO]})

    def test_a_missing_directory_entry_is_refused(self):
        drive = self.drive("no-such-dir/", PRESENT)
        self.assert_refused(drive, {NOT_FOUND: ["no-such-dir/"]}, kept=[PRESENT])


class AnExistingFileThatIsNotATestRefusesTheRunTest(_ScratchPackageCase):
    """An existing file whose name carries no bun test-file marker is refused
    under `tests-not-a-test-file`, and its top-level code never runs. An
    existing directory, and a file carrying any of the four markers, pass."""

    def setUp(self):
        super().setUp()
        self.sentinel = self.project / SENTINEL
        (self.package / NON_TEST_SOURCE).write_text(
            _non_test_source(self.sentinel), encoding="utf-8")

    def test_an_existing_non_test_source_is_refused_and_never_imported(self):
        drive = self.drive(NON_TEST_SOURCE)
        self.assert_refused(drive, {NOT_A_TEST_FILE: [NON_TEST_SOURCE]})
        self.assertFalse(self.sentinel.exists(),
                         f"the non-test source's top-level code never ran: "
                         f"{drive.summary()}")

    def test_a_missing_entry_and_a_non_test_source_are_refused_under_one_warning_each(self):
        drive = self.drive(PRESENT, ABSENT, NON_TEST_SOURCE)
        self.assert_refused(drive, {NOT_FOUND: [ABSENT],
                                    NOT_A_TEST_FILE: [NON_TEST_SOURCE]},
                            kept=[PRESENT])
        self.assertFalse(self.sentinel.exists(), drive.summary())

    def test_an_existing_directory_entry_is_not_refused(self):
        suite = self.package / "suite"
        suite.mkdir()
        (suite / "inner.test.ts").write_text(_TEST_SOURCE, encoding="utf-8")
        drive = self.drive("suite/")
        self.assert_not_refused(drive, "suite/")

    def test_a_file_carrying_any_bun_test_file_marker_is_not_refused(self):
        for name in ("dotted.test.ts", "dotted.spec.ts", "under_test_score.ts",
                     "under_spec_score.ts"):
            with self.subTest(entry=name):
                (self.package / name).write_text(_TEST_SOURCE, encoding="utf-8")
                drive = self.drive(name)
                self.assert_not_refused(drive, name)


class EntriesResolveAgainstThePackageDirectoryTest(_ScratchPackageCase):
    """With `[bun] package_dir` declared in the project's own
    `crucible.toml`, an entry is resolved against the package directory, not
    the project root, and `help[0]` names the package directory."""

    def setUp(self):
        super().setUp()
        self.package = self.project / "pkg"
        self.write_package(self.package)
        (self.package / "inner.test.ts").write_text(_TEST_SOURCE, encoding="utf-8")
        self.reports = self.package / "reports"
        self.reports.mkdir()
        self.junit = self.reports / "junit.xml"
        self.junit.write_text(PLANTED_JUNIT, encoding="utf-8")
        (self.project / "crucible.toml").write_text(
            PROJECT_CONFIG + '\n[bun]\npackage_dir = "pkg"\n', encoding="utf-8")

    def test_an_entry_written_from_the_project_root_is_refused_naming_the_package_dir(self):
        # `pkg/inner.test.ts` exists from the project root, but not under the
        # package directory, where `bun test` runs.
        entry = "pkg/inner.test.ts"
        self.assertTrue((self.project / entry).is_file(), "fixture: the file exists")
        drive = self.drive(entry)
        self.assert_refused(drive, {NOT_FOUND: [entry]}, help_dir=self.package)


class ADeclaredScriptsEntriesPassUnchangedTest(_ScratchPackageCase):
    """With a marked `test` script, the entries are its runner's filters:
    nothing is checked or rewritten, and they reach the script as given."""

    SCRIPT = "test:vitest"

    def setUp(self):
        super().setUp()
        self.write_package(self.package, {
            "name": "tests-entry-check-fixture",
            "scripts": {self.SCRIPT: "vitest run"},
            "crucible": {"targets": {self.SCRIPT: {
                "framework": "vitest", "junit": "env:VITEST_JUNIT", "test": True}}},
        })

    def test_a_missing_entry_and_an_existing_relative_file_reach_the_script_as_given(self):
        entries = [ABSENT, PRESENT]
        drive = self.drive(*entries)
        diagnostics = drive.summary()
        for code in REFUSAL_CODES:
            self.assertNotIn(code, drive.out, f"nothing is refused: {diagnostics}")
        work = drive.spawns.work()
        self.assertEqual(len(work), 1, f"the script runs once: {diagnostics}")
        argv = work[0] if work else []
        self.assertEqual(argv[:3], [FAKE_BUN, "run", self.SCRIPT], diagnostics)
        self.assertEqual(argv[-len(entries):], entries,
                         f"the entries reach the script exactly as given: {diagnostics}")
        for entry in entries:
            self.assertNotIn(f"./{entry}", argv,
                             f"no `./` is added to a script's filter: {diagnostics}")


class TheTestVerbsHelpSaysHowItsEntriesAreReadTest(unittest.TestCase):
    """`test --help`: the description and the `--tests` line each say that
    `bun test` reads the entries as paths relative to the package directory,
    that a missing entry or a file that is not a test is refused, and that a
    declared script receives them unchanged as its runner's filters."""

    @classmethod
    def setUpClass(cls):
        install = Path(tempfile.mkdtemp(prefix="tests-entry-check-help-"))
        try:
            with mock.patch.dict(os.environ, {"COLUMNS": "10000", "NO_COLOR": "1"}):
                os.environ.pop("FORCE_COLOR", None)
                drive = run_client("bun", ["test", "--help"], install)
        finally:
            shutil.rmtree(install, ignore_errors=True)
        cls.drive = drive
        cls.description, cls.tests_line = cls.split_help(drive.out)

    @staticmethod
    def split_help(text):
        """The verb's description (between the usage and the options) and the
        `--tests` option's help (up to the next option)."""
        head, _sep, options = text.partition("\noptions:\n")
        paragraphs = [p for p in re.split(r"\n\s*\n", head) if p.strip()]
        description = " ".join(paragraphs[1:])
        tests_line, collecting = [], False
        for line in options.splitlines():
            if re.match(r"^\s{2}-", line):
                collecting = line.lstrip().startswith("--tests")
            if collecting:
                tests_line.append(line)
        return (" ".join(description.split()), " ".join(" ".join(tests_line).split()))

    def assert_says_the_three_things(self, where, text):
        diagnostics = f"{where}={text!r}; help={self.drive.out!r}"
        self.assertEqual(self.drive.code, 0, self.drive.summary())
        self.assertTrue(text, f"the {where} is present in `test --help`: {diagnostics}")
        self.assertRegex(text, re.compile(r"relative to[^.]{0,40}package[ _-]?dir",
                                          re.IGNORECASE),
                         f"the {where} says the entries are paths relative to the "
                         f"package directory: {diagnostics}")
        self.assertRegex(text, re.compile(r"refus", re.IGNORECASE),
                         f"the {where} says an entry is refused: {diagnostics}")
        self.assertRegex(text, re.compile(
            r"missing|not exist|n't exist|nonexistent|names nothing|no such",
            re.IGNORECASE),
                         f"the {where} says a missing entry is refused: {diagnostics}")
        self.assertRegex(text, re.compile(r"not a test|non-test", re.IGNORECASE),
                         f"the {where} says a file that is not a test is refused: "
                         f"{diagnostics}")
        self.assertRegex(text, re.compile(
            r"(declar|mark)\w*[^.]{0,80}script|script[^.]{0,40}(declar|mark)",
            re.IGNORECASE),
                         f"the {where} names the declared script: {diagnostics}")
        self.assertRegex(text, re.compile(r"unchanged|as given|as written|verbatim",
                                          re.IGNORECASE),
                         f"the {where} says a declared script receives the entries "
                         f"unchanged: {diagnostics}")
        self.assertRegex(text, re.compile(r"filters?\b", re.IGNORECASE),
                         f"the {where} says they are the script runner's filters: "
                         f"{diagnostics}")

    def test_the_description_says_how_the_entries_are_read(self):
        self.assert_says_the_three_things("description", self.description)

    def test_the_tests_line_says_how_the_entries_are_read(self):
        self.assert_says_the_three_things("--tests line", self.tests_line)


if __name__ == "__main__":
    unittest.main()
