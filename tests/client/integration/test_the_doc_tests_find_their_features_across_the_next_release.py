"""The python doc tests stay green across the next release: once a new
`## [Unreleased]` is written above the release that records their features,
holding none of its entries, every check that a feature IS recorded still
finds it in the real entries below.

The changelog these checks read is the repo's own `CHANGELOG.md` with this
section written above its first release heading:

    ## [Unreleased]

    ### Added

    - **A later feature.** Nothing from 0.4.0.

Each doc test is pointed at that text through `CHANGELOG`, the module-level
path every one of its changelog checks reads the changelog from, and its
checks run as they are written, through unittest; none is copied here.

  * Every RECORDED check passes on that text.
  * On a changelog that records nothing, every RECORDED check fails (so each
    one reads the changelog it is pointed at), and nothing fails that is not
    classified (so every check that reads the changelog is classified).
  * An ABSENT check reads only the section being written: stale wording in an
    older release's section never fails it, and stale wording in the section
    being written does.

The classification, check by check, is `tests/client/changelog_check_kinds.py`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_doc_tests_find_their_features_across_the_next_release
"""

import importlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.changelog_check_kinds import PYTHON_CHECKS

REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_CHANGELOG = REPO_ROOT / "CHANGELOG.md"

#: The module-level path each python doc test reads the changelog from.
SEAM = "CHANGELOG"

LATER_FEATURE = "- **A later feature.** Nothing from 0.4.0.\n"
LATER_RELEASE = (
    "## [Unreleased]\n"
    "\n"
    "### Added\n"
    "\n"
) + LATER_FEATURE + "\n"

#: A changelog with no release section at all.
RECORDS_NOTHING = "# Changelog\n"

#: Per module with an ABSENT check: a line of the stale wording it looks for.
STALE_WORDING = {
    "test_the_docs_say_regression_and_the_gate_read_the_marker":
        '- Only `test` reads the `"test": true` marker.\n',
    "test_the_go_client_is_documented":
        "- Go declares no tier.\n",
}


def _first_heading_at(lines):
    return next(i for i, line in enumerate(lines) if line.startswith("## ["))


def with_a_section_on_top(text, section):
    """`text` with `section` written above its first `## [` heading."""
    lines = text.splitlines(keepends=True)
    at = _first_heading_at(lines)
    return "".join(lines[:at]) + section + "".join(lines[at:])


def with_a_line_under_the_first_heading(text, line):
    """`text` with `line` as the first entry of its first `## [` section."""
    lines = text.splitlines(keepends=True)
    at = _first_heading_at(lines) + 1
    return "".join(lines[:at]) + "\n" + line + "".join(lines[at:])


def the_next_release(real=None):
    """The real changelog with the next release's `[Unreleased]` on top."""
    real = REAL_CHANGELOG.read_text(encoding="utf-8") if real is None else real
    return with_a_section_on_top(real, LATER_RELEASE)


def _dotted(module_name):
    """The dotted name of a doc test module, under the tier directory it lives in."""
    tier = next(t for t in ("unit", "integration")
                if (REPO_ROOT / "tests" / "client" / t / f"{module_name}.py").is_file())
    return f"tests.client.{tier}.{module_name}"


def _check_name(test, module_name):
    case = getattr(test, "test_case", test)
    test_id = case.id()
    prefix = f"{_dotted(module_name)}."
    return test_id[len(prefix):] if test_id.startswith(prefix) else test_id


def run_checks(module_name, text, checks=None):
    """Run a doc test's checks (all of them when `checks` is None) with its
    changelog pointed at `text`; answer {check: last line of its failure}."""
    module = importlib.import_module(_dotted(module_name))
    loader = unittest.TestLoader()
    if checks is None:
        suite = loader.loadTestsFromModule(module)
    else:
        suite = unittest.TestSuite(
            loader.loadTestsFromName(f"{module.__name__}.{check}") for check in checks)
    result = unittest.TestResult()
    with tempfile.TemporaryDirectory(prefix="doc-tests-next-release-") as scratch:
        changelog = Path(scratch) / "CHANGELOG.md"
        changelog.write_text(text, encoding="utf-8")
        with mock.patch.object(module, SEAM, changelog):
            suite.run(result)
    failing = {}
    for test, trace in result.failures + result.errors:
        failing.setdefault(_check_name(test, module_name),
                           trace.strip().splitlines()[-1])
    return failing


class EveryRecordedCheckFindsItsFeatureAcrossTheNextReleaseTest(unittest.TestCase):

    maxDiff = None

    def assertRecordedChecksPass(self, module_name):
        failing = run_checks(module_name, the_next_release(),
                             PYTHON_CHECKS[module_name]["recorded"])
        self.assertEqual(failing, {},
                         f"{module_name}: a check that a feature is recorded fails once the "
                         f"next release's section is written above the release recording it")

    def test_the_runs_coverage_files_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass("test_a_runs_coverage_files_are_documented")

    def test_the_project_create_check_finds_its_entry_below_the_next_release(self):
        self.assertRecordedChecksPass("test_project_create_is_documented")

    def test_the_arduino_stream_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass("test_the_arduino_stream_declaration_is_documented")

    def test_the_declaration_schema_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass("test_the_declaration_schema_is_documented")

    def test_the_marker_readers_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass("test_the_docs_say_regression_and_the_gate_read_the_marker")

    def test_the_go_client_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass("test_the_go_client_is_documented")

    def test_the_lint_verb_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass(
            "test_the_lint_verb_and_gate_stage_are_documented_where_operators_read_them")

    def test_the_maven_console_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass("test_the_maven_console_declaration_is_documented")

    def test_the_rust_targets_checks_find_their_entries_below_the_next_release(self):
        self.assertRecordedChecksPass("test_the_rust_targets_declaration_is_documented")


class OnAChangelogThatRecordsNothingOnlyTheClassifiedChecksFailTest(unittest.TestCase):
    """Each doc test, whole, against a changelog with no release section: a
    RECORDED check that still passes is not reading the changelog it is
    pointed at; a check that fails and is not classified reads the changelog
    unclassified."""

    maxDiff = None

    def test_every_recorded_check_reads_the_changelog_it_is_pointed_at(self):
        for module_name, kinds in PYTHON_CHECKS.items():
            with self.subTest(module=module_name):
                failing = run_checks(module_name, RECORDS_NOTHING)
                self.assertEqual(sorted(set(kinds["recorded"]) - set(failing)), [],
                                 "these RECORDED checks pass on a changelog that records "
                                 "nothing, so they do not read `CHANGELOG`")
                unclassified = {name: line for name, line in failing.items()
                                if name not in kinds["recorded"] and name not in kinds["absent"]}
                self.assertEqual(unclassified, {},
                                 "these checks fail on a changelog that records nothing "
                                 "and are not classified RECORDED or ABSENT")


class TheAbsentChecksReadOnlyTheSectionBeingWrittenTest(unittest.TestCase):

    maxDiff = None

    def test_every_absent_check_has_a_sample_of_its_stale_wording(self):
        self.assertEqual(sorted(STALE_WORDING),
                         sorted(name for name, kinds in PYTHON_CHECKS.items() if kinds["absent"]))

    def test_stale_wording_in_an_older_releases_section_never_fails_an_absent_check(self):
        real = REAL_CHANGELOG.read_text(encoding="utf-8")
        for module_name, stale in STALE_WORDING.items():
            with self.subTest(module=module_name):
                text = the_next_release(with_a_line_under_the_first_heading(real, stale))
                self.assertIn(stale, text)
                self.assertEqual(run_checks(module_name, text,
                                            PYTHON_CHECKS[module_name]["absent"]), {},
                                 "an old release's record of its day fails a check that "
                                 "reads only the section being written")

    def test_stale_wording_in_the_section_being_written_fails_its_absent_check(self):
        real = REAL_CHANGELOG.read_text(encoding="utf-8")
        for module_name, stale in STALE_WORDING.items():
            with self.subTest(module=module_name):
                text = with_a_section_on_top(real, LATER_RELEASE + stale + "\n")
                self.assertEqual(sorted(run_checks(module_name, text,
                                                   PYTHON_CHECKS[module_name]["absent"])),
                                 sorted(PYTHON_CHECKS[module_name]["absent"]))


if __name__ == "__main__":
    unittest.main()
