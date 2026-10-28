"""An arduino Makefile that ignored `TESTS` or `TEST_NAME` is named.

`arduino-crucible.py test` and `unit` hand a narrowed run to the project's
Makefile as `TESTS` (from `--tests`) and `TEST_NAME` (from `--name`). A
Makefile that does not honour one still runs, and its run is filed as it ran
— but the client names the variable it ignored, as it names an ignored
`REPORTS_DIR`:

  * `makefile-ignored-tests` — a case whose file stem is not among `--tests`;
    the warning names `TESTS` and the stems that were not asked for;
  * `makefile-ignored-test-name` — a case where no `--name` element (its part
    before `*`) appears in the case's name or its file stem; the warning names
    `TEST_NAME`, the elements and the first unmatched case.

A case's file stem is its `classname` (Unity's JUnit stylizer writes the file
stem there, the test function as `name`) or its `file`. A case is judged
against `--tests` only when that stem names a test source (`<stem>.c`, `.cpp`
or `.ino`) under `--dir`: a case whose file stem cannot be read, or whose
`classname` is a constant that names no test source (`native`,
`native.Fixture`), raises no `makefile-ignored-tests`. Unity's `-f` also matches
the source file's path, so a Makefile that honours `TEST_NAME` may run a whole
file whose stem contains an element — that is honoured, not ignored. Unity's
stylizer writes ONE combined report, so a combined report whose cases are all
asked for raises nothing.

The warnings ride the filed run's envelope and are printed to stderr too, so a
run without `--agent` — which files nothing and prints no envelope — still
shows them.

Every case drives the real `clients/arduino-crucible.py` as a subprocess over
a scratch firmware project (the narrowing suite's fixture) whose
`tests/native/Makefile` runs a python stand-in for the Unity binaries, beside
one `tests/native/test/<stem>.c` source per catalogue file. Here the stand-in
is told, per test, whether to honour `TESTS` and `TEST_NAME` and whether to
stamp the file stem (or a constant `classname`) on each case; it records what reached `make`
and writes one combined `TEST-native.xml`. The board is a recording stand-in
steered only by the scratch project's own `crucible.toml`.

Invocation:
    python3 -m unittest tests.client.test_an_arduino_makefile_that_ignored_tests_or_test_name_is_named -v
"""

import json
import re
import unittest
from pathlib import Path
from typing import TYPE_CHECKING

from tests.client.live_run_harness import (
    INGEST_PATHS,
    RecordingBoard,
    install_project,
)
from tests.client.test_an_arduino_run_narrowed_by_tests_and_name_reaches_make import (
    CATALOGUE,
    PARSED_INGEST,
    _diagnostics,
    _NarrowingProject,
)

IGNORED_TESTS_CODE = "makefile-ignored-tests"
IGNORED_TEST_NAME_CODE = "makefile-ignored-test-name"

#: Test files whose stem contains a `--name` element: Unity's `-f motor` runs
#: every test of `test_motor.c`, because the file's path matched.
MOTOR_CATALOGUE = (
    ("test_motor", "test_init"),
    ("test_motor", "test_limit"),
    ("test_pid", "test_gain"),
    ("test_pid", "test_windup"),
)

# The stand-in for the native test binaries, told by `behaviour.json` whether
# it honours each narrowing variable and whether each case carries its file
# stem as `classname`. It always records what reached `make`, and writes one
# combined report (Unity's stylizer shape).
_CONFIGURABLE_NATIVE = r'''
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
target = sys.argv[1] if len(sys.argv) > 1 else "?"
tests = os.environ.get("TESTS")
names = os.environ.get("TEST_NAME")
with open(os.path.join(here, "make_runs.jsonl"), "a") as handle:
    handle.write(json.dumps({
        "target": target,
        "tests_present": "TESTS" in os.environ, "tests": tests,
        "test_name_present": "TEST_NAME" in os.environ, "test_name": names,
    }) + "\n")
with open(os.path.join(here, "catalogue.json")) as handle:
    catalogue = json.load(handle)
with open(os.path.join(here, "behaviour.json")) as handle:
    behaviour = json.load(handle)

selected = []
for stem, name in catalogue:
    if (behaviour["honour_tests"] and tests is not None
            and stem not in tests.split()):
        continue
    if behaviour["honour_test_name"] and names is not None:
        elements = [e.split("*", 1)[0] for e in names.split(",")]
        if not any(e in name or e in stem for e in elements):
            continue
    selected.append((stem, name))

for line, (stem, name) in enumerate(selected, start=10):
    sys.stdout.write("test/%s.c:%d:%s:PASS\n" % (stem, line, name))
sys.stdout.write("-----------------------\n%d Tests 0 Failures 0 Ignored\nOK\n"
                 % len(selected))
sys.stdout.flush()

reports_dir = os.environ.get("REPORTS_DIR") or "reports"
os.makedirs(reports_dir, exist_ok=True)
if behaviour["stamp_file_stem"]:
    suites = []
    for stem in sorted({s for s, _ in selected}):
        cases = [n for s, n in selected if s == stem]
        classname = behaviour.get("classname") or stem
        suites.append(
            '<testsuite name="%s" tests="%d" failures="0">%s</testsuite>'
            % (stem, len(cases), "".join(
                '<testcase classname="%s" name="%s" time="0.001"/>'
                % (classname, n) for n in cases)))
    body = "<testsuites>%s</testsuites>" % "".join(suites)
else:
    body = ('<testsuites><testsuite name="native" tests="%d" failures="0">%s'
            '</testsuite></testsuites>' % (len(selected), "".join(
                '<testcase name="%s" time="0.001"/>' % n for _, n in selected)))
with open(os.path.join(reports_dir, "TEST-native.xml"), "w") as handle:
    handle.write('<?xml version="1.0"?>' + body)
sys.exit(0)
'''


def _warning_text(warning):
    """Every string a warning carries, joined — what it names, wherever the
    client puts it."""
    if not isinstance(warning, dict):
        return str(warning)
    return " ".join(str(value) for value in warning.values())


def _stderr_lines_naming(stderr, variable):
    """The stderr lines that name `variable` as a whole word."""
    return [line for line in (stderr or "").splitlines()
            if re.search(r"(?<![A-Za-z0-9_])" + variable + r"(?![A-Za-z0-9_])",
                         line)]


# The mixins below are TestCases only once a concrete class mixes them in;
# a type checker is told so, the runtime collects only the concrete classes.
_TestCaseShape = unittest.TestCase if TYPE_CHECKING else object


class _IgnoredVariableProject(_NarrowingProject, _TestCaseShape):
    """The narrowing suite's scratch project with the configurable stand-in,
    against a recording board."""

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)

    def given_a_makefile(self, *, honour_tests, honour_test_name,
                         stamp_file_stem=True, classname=None,
                         catalogue=CATALOGUE):
        """The scratch project, with one test source `test/<stem>.c` per
        catalogue file under the native dir (a firmware project's own
        layout), and the stand-in told how to behave. `classname`, when
        given, is written on every case instead of its file stem."""
        self.make_project(catalogue=catalogue)
        sources = Path(self.native_dir, "test")
        sources.mkdir()
        for stem in sorted({stem for stem, _ in catalogue}):
            (sources / f"{stem}.c").write_text("void setUp(void) {}\n")
        Path(self.native_dir, "run_native.py").write_text(_CONFIGURABLE_NATIVE)
        Path(self.native_dir, "behaviour.json").write_text(json.dumps({
            "honour_tests": honour_tests,
            "honour_test_name": honour_test_name,
            "stamp_file_stem": stamp_file_stem,
            "classname": classname,
        }))
        install_project(self.project, self.board.url, "arduino-ignored-variable")

    def run_narrowed(self, case, *narrowing, with_agent=True):
        agent = f"ard-ignored-{self.VERB}-{case}" if with_agent else None
        return self.drive(self.VERB, *narrowing, agent=agent)

    # ── what the run did ────────────────────────────────────────────────────

    def warnings_coded(self, envelope, code):
        return [w for w in (envelope.get("warnings") or [])
                if isinstance(w, dict) and w.get("code") == code]

    def the_one_filed_total(self, result):
        """The one run filed, and the case count it was filed with."""
        ingests = [b for p, b in self.board.posts() if p == PARSED_INGEST]
        self.assertEqual(
            len(ingests), 1,
            f"the run is filed exactly once; {_diagnostics(result)}")
        summary = (ingests[0] or {}).get("summary") if ingests else {}
        return (summary or {}).get("total")

    def assert_filed_ok(self, result, total):
        self.assertEqual(result.returncode, 0,
                         f"the run is filed as it ran; {_diagnostics(result)}")
        self.assertEqual(
            self.the_one_filed_total(result), total,
            f"the run filed holds every case the Makefile ran; "
            f"{_diagnostics(result)}")
        envelope = self.envelope_of(result)
        self.assertEqual(
            (envelope.get("verb"), envelope.get("ok")), (self.VERB, True),
            f"envelope={envelope!r}")
        return envelope

    def assert_nothing_filed(self, result):
        self.assertEqual(result.returncode, 0,
                         _diagnostics(result))
        self.assertEqual(
            [p for p, _ in self.board.posts() if p in INGEST_PATHS], [],
            f"a run without --agent files nothing; {_diagnostics(result)}")

    def assert_reached_make(self, result, *, tests=None, test_name=None):
        """A precondition: the flag did reach `make`, so a missing warning is
        the judgment's absence and not a variable that never arrived."""
        record = self.the_one_make_run(result)
        self.assertEqual(
            (record.get("tests"), record.get("test_name")), (tests, test_name),
            f"`make` saw the narrowing the flags set; recorded={record!r} "
            f"{_diagnostics(result)}")

    def assert_names_ignored_tests_on_stderr(self, result, unasked):
        lines = _stderr_lines_naming(result.stderr, "TESTS")
        named = " ".join(lines)
        for stem in unasked:
            self.assertIn(
                stem, named,
                f"stderr names TESTS and the stem {stem!r} not asked for, so a "
                f"run without an envelope still shows it; lines naming "
                f"TESTS={lines!r} {_diagnostics(result)}")

    def assert_names_ignored_test_name_on_stderr(self, result, elements,
                                                 first_unmatched):
        lines = _stderr_lines_naming(result.stderr, "TEST_NAME")
        named = " ".join(lines)
        for word in (*elements, first_unmatched):
            self.assertIn(
                word, named,
                f"stderr names TEST_NAME, its elements and the first unmatched "
                f"case ({word!r} missing); lines naming TEST_NAME={lines!r} "
                f"{_diagnostics(result)}")

    def assert_no_ignored_warning_on_stderr(self, result, variable):
        flagged = [line for line in _stderr_lines_naming(result.stderr, variable)
                   if re.search(r"ignor", line, re.IGNORECASE)]
        self.assertEqual(
            flagged, [],
            f"nothing on stderr says the Makefile ignored {variable}; "
            f"{_diagnostics(result)}")


# ── a Makefile that ignored TESTS ───────────────────────────────────────────

class _AnIgnoredTestsVariableIsNamed(_IgnoredVariableProject):

    def test_a_makefile_that_ignores_tests_is_named_in_the_filed_runs_envelope(self):
        self.given_a_makefile(honour_tests=False, honour_test_name=True)
        result = self.run_narrowed("tests-ignored", "--tests", "test_a")
        self.assert_reached_make(result, tests="test_a")
        envelope = self.assert_filed_ok(result, len(CATALOGUE))
        ignored = self.warnings_coded(envelope, IGNORED_TESTS_CODE)
        self.assertEqual(
            len(ignored), 1,
            f"exactly one {IGNORED_TESTS_CODE} warning for a Makefile that ran "
            f"test_b's and test_c's cases under --tests test_a; "
            f"warnings={envelope.get('warnings')!r}")
        text = _warning_text(ignored[0]) if ignored else ""
        for word in ("TESTS", "test_b", "test_c"):
            self.assertIn(word, text,
                          f"the warning names TESTS and the stems not asked "
                          f"for ({word!r} missing); warning={ignored!r}")
        self.assertEqual(
            self.warnings_coded(envelope, IGNORED_TEST_NAME_CODE), [],
            f"no --name was given, so nothing names TEST_NAME; "
            f"warnings={envelope.get('warnings')!r}")
        self.assert_names_ignored_tests_on_stderr(result, ("test_b", "test_c"))

    def test_a_makefile_that_ignores_tests_is_named_on_stderr_without_an_agent(self):
        self.given_a_makefile(honour_tests=False, honour_test_name=True)
        result = self.run_narrowed("tests-ignored-no-agent", "--tests", "test_a",
                                   with_agent=False)
        self.assert_reached_make(result, tests="test_a")
        self.assert_nothing_filed(result)
        self.assert_names_ignored_tests_on_stderr(result, ("test_b", "test_c"))

    def test_guard_a_makefile_honouring_tests_with_one_combined_report_raises_no_warning(self):
        """GUARD — the Makefile honours TESTS and writes one combined
        `TEST-native.xml` holding only test_a's cases: the report's own name
        (`native`) is not a stem, so nothing is named."""
        self.given_a_makefile(honour_tests=True, honour_test_name=True)
        result = self.run_narrowed("tests-honoured", "--tests", "test_a")
        self.assert_reached_make(result, tests="test_a")
        envelope = self.assert_filed_ok(result, 2)
        self.assertEqual(
            self.warnings_coded(envelope, IGNORED_TESTS_CODE), [],
            f"warnings={envelope.get('warnings')!r}")
        self.assert_no_ignored_warning_on_stderr(result, "TESTS")

    def test_guard_a_case_whose_file_stem_cannot_be_read_raises_no_ignored_tests_warning(self):
        """GUARD — the Makefile ignores TESTS, but its cases carry neither a
        `classname` nor a `file` (they sit in a suite named `native`): no file
        stem can be read, so nothing is named."""
        self.given_a_makefile(honour_tests=False, honour_test_name=True,
                              stamp_file_stem=False)
        result = self.run_narrowed("tests-no-stem", "--tests", "test_a")
        self.assert_reached_make(result, tests="test_a")
        envelope = self.assert_filed_ok(result, len(CATALOGUE))
        self.assertEqual(
            self.warnings_coded(envelope, IGNORED_TESTS_CODE), [],
            f"warnings={envelope.get('warnings')!r}")
        self.assert_no_ignored_warning_on_stderr(result, "TESTS")

    def assert_a_constant_classname_is_not_judged(self, case, classname):
        self.given_a_makefile(honour_tests=True, honour_test_name=True,
                              classname=classname)
        result = self.run_narrowed(case, "--tests", "test_a")
        self.assert_reached_make(result, tests="test_a")
        envelope = self.assert_filed_ok(result, 2)
        self.assertEqual(
            self.warnings_coded(envelope, IGNORED_TESTS_CODE), [],
            f"a Makefile that honoured TESTS but wrote the classname "
            f"{classname!r} on every case, which names no test source under "
            f"--dir, is not judged; warnings={envelope.get('warnings')!r}")
        self.assert_no_ignored_warning_on_stderr(result, "TESTS")

    def test_a_constant_classname_that_names_no_test_source_is_not_judged(self):
        self.assert_a_constant_classname_is_not_judged("tests-constant", "native")

    def test_a_dotted_constant_classname_that_names_no_test_source_is_not_judged(self):
        self.assert_a_constant_classname_is_not_judged("tests-dotted-constant",
                                                       "native.Fixture")

    def test_guard_an_unnarrowed_run_raises_neither_ignored_warning(self):
        """GUARD — without a narrowing flag there is nothing to ignore."""
        self.given_a_makefile(honour_tests=False, honour_test_name=False)
        result = self.run_narrowed("unnarrowed")
        self.assert_reached_make(result)
        envelope = self.assert_filed_ok(result, len(CATALOGUE))
        self.assertEqual(
            [w for w in (envelope.get("warnings") or [])
             if isinstance(w, dict) and w.get("code") in
             (IGNORED_TESTS_CODE, IGNORED_TEST_NAME_CODE)], [],
            f"warnings={envelope.get('warnings')!r}")


class TestVerbIgnoredTestsIsNamedTest(_AnIgnoredTestsVariableIsNamed,
                                      unittest.TestCase):
    VERB = "test"


class UnitVerbIgnoredTestsIsNamedTest(_AnIgnoredTestsVariableIsNamed,
                                      unittest.TestCase):
    VERB = "unit"


# ── a Makefile that ignored TEST_NAME ───────────────────────────────────────

class _AnIgnoredTestNameVariableIsNamed(_IgnoredVariableProject):

    # `--name stall,reset` over the whole catalogue: test_a's
    # `test_stall_detected` matches, its `test_init` is the first case whose
    # name and file stem contain neither element.
    ELEMENTS = ("stall", "reset")
    FIRST_UNMATCHED = "test_init"

    def test_a_makefile_that_ignores_test_name_is_named_in_the_filed_runs_envelope(self):
        self.given_a_makefile(honour_tests=True, honour_test_name=False)
        result = self.run_narrowed("name-ignored", "--name", ",".join(self.ELEMENTS))
        self.assert_reached_make(result, test_name="stall,reset")
        envelope = self.assert_filed_ok(result, len(CATALOGUE))
        ignored = self.warnings_coded(envelope, IGNORED_TEST_NAME_CODE)
        self.assertEqual(
            len(ignored), 1,
            f"exactly one {IGNORED_TEST_NAME_CODE} warning for a Makefile that "
            f"ran every case under --name stall,reset; "
            f"warnings={envelope.get('warnings')!r}")
        text = _warning_text(ignored[0]) if ignored else ""
        for word in ("TEST_NAME", *self.ELEMENTS, self.FIRST_UNMATCHED):
            self.assertIn(word, text,
                          f"the warning names TEST_NAME, the elements and the "
                          f"first unmatched case ({word!r} missing); "
                          f"warning={ignored!r}")
        self.assertEqual(
            self.warnings_coded(envelope, IGNORED_TESTS_CODE), [],
            f"no --tests was given, so nothing names TESTS; "
            f"warnings={envelope.get('warnings')!r}")
        self.assert_names_ignored_test_name_on_stderr(result, self.ELEMENTS,
                                                      self.FIRST_UNMATCHED)

    def test_a_makefile_that_ignores_test_name_is_named_on_stderr_without_an_agent(self):
        self.given_a_makefile(honour_tests=True, honour_test_name=False)
        result = self.run_narrowed("name-ignored-no-agent", "--name",
                                   ",".join(self.ELEMENTS), with_agent=False)
        self.assert_reached_make(result, test_name="stall,reset")
        self.assert_nothing_filed(result)
        self.assert_names_ignored_test_name_on_stderr(result, self.ELEMENTS,
                                                      self.FIRST_UNMATCHED)

    def test_a_makefile_that_ignores_both_variables_is_named_for_each(self):
        self.given_a_makefile(honour_tests=False, honour_test_name=False)
        result = self.run_narrowed("both-ignored", "--tests", "test_a",
                                   "--name", "stall")
        self.assert_reached_make(result, tests="test_a", test_name="stall")
        envelope = self.assert_filed_ok(result, len(CATALOGUE))
        self.assertEqual(
            (len(self.warnings_coded(envelope, IGNORED_TESTS_CODE)),
             len(self.warnings_coded(envelope, IGNORED_TEST_NAME_CODE))),
            (1, 1),
            f"one warning per ignored variable; "
            f"warnings={envelope.get('warnings')!r}")

    def test_guard_a_whole_file_run_because_its_stem_matched_raises_no_warning(self):
        """GUARD — `--name motor`: Unity's `-f` matched `test_motor.c`'s path,
        so the Makefile honoured TEST_NAME by running that whole file
        (`test_init`, `test_limit`); `motor` is in each case's file stem."""
        self.given_a_makefile(honour_tests=True, honour_test_name=True,
                              catalogue=MOTOR_CATALOGUE)
        result = self.run_narrowed("name-file-match", "--name", "motor")
        self.assert_reached_make(result, test_name="motor")
        envelope = self.assert_filed_ok(result, 2)
        self.assertEqual(
            self.warnings_coded(envelope, IGNORED_TEST_NAME_CODE), [],
            f"warnings={envelope.get('warnings')!r}")
        self.assert_no_ignored_warning_on_stderr(result, "TEST_NAME")

    def test_guard_a_trailing_star_element_matches_by_its_part_before_the_star(self):
        """GUARD — `--name stall*` is judged by `stall`: `test_stall_detected`
        and `test_stall_recovery` are matched cases, not ignored ones."""
        self.given_a_makefile(honour_tests=True, honour_test_name=True)
        result = self.run_narrowed("name-star", "--name", "stall*")
        self.assert_reached_make(result, test_name="stall*")
        envelope = self.assert_filed_ok(result, 2)
        self.assertEqual(
            self.warnings_coded(envelope, IGNORED_TEST_NAME_CODE), [],
            f"warnings={envelope.get('warnings')!r}")
        self.assert_no_ignored_warning_on_stderr(result, "TEST_NAME")


class TestVerbIgnoredTestNameIsNamedTest(_AnIgnoredTestNameVariableIsNamed,
                                         unittest.TestCase):
    VERB = "test"


class UnitVerbIgnoredTestNameIsNamedTest(_AnIgnoredTestNameVariableIsNamed,
                                         unittest.TestCase):
    VERB = "unit"


if __name__ == "__main__":
    unittest.main()
