"""CR-CRU-101 §S1 C1 RED -- the bun client must RECORD THE SCOPE of the junit
artifact it produces, at the one place that knows it.

Why the producer and nowhere else (settled by this CR's gap analysis, and by
the spec's own rejected option): bun's JUnit output records test counts, not a
file total and not how the runner was invoked, so the only artifact-INTERNAL
proxy for "this run was full" is "its file set equals the on-disk set" -- which
is the very conclusion `tests/suite-integrity.test.ts`'s corroboration draws
from it. A precondition identical to its conclusion can never fail. The scope
is known exactly once: `_bun_test_cmd(bun, targets, ...)` receives `targets`
(empty = whole-suite, non-empty = scoped) at the moment it builds the `bun
test` invocation, and `_wipe` has just deleted the previous artifact.

Contract pinned from docs/changes/CR-CRU-101-suite-integrity-contradicts-scoped-runs.md
Sec S1 plus the dispatch's Contract items 1-6:

  1. `_bun_test_cmd` stamps a scope record BESIDE the artifact it is about to
     produce, derived from the SAME `targets` argument the invocation branches
     on -- so the record cannot disagree with the command.
  2. `_wipe` removes the record TOGETHER WITH the artifact. A stale record
     surviving a wiped artifact is worse than no record at all: it would
     re-license the comparison it exists to gate.
  3. The record lives under the reports dir (gitignored -- .gitignore:7), so it
     is a local artifact and is never committed.
  4. Nothing else changes: the returned command, DEFAULT_JUNIT/_junit_path, the
     printed envelope's fields and the ingest payload are all untouched.

RED phase, all confirmed against the unpatched client before this file was
written: `_bun_test_cmd` writes no file at all (the reports dir holds only what
bun itself later writes), `_wipe` knows only `junit.xml`, and neither
`_scope_path` nor `_scope_record` exists (AttributeError).

Module-loading convention mirrored from the sibling
`tests/client/test_cr039_regression_discovery.py`: load the hyphen-named client
by file path via `importlib`. Nothing here touches the network -- every seam
exercised is a pure path/argv/file helper.
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"


def _load_client_module():
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_cr101", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ScopeRecordStampedByTheProducerTest(unittest.TestCase):
    """The invocation builder stamps what the artifact it is building will be."""

    def setUp(self):
        self.client = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="cr101-scope-")
        self.reports_dir = os.path.join(self.tmpdir, "test-reports")
        os.makedirs(self.reports_dir, exist_ok=True)
        self.junit_path = self.client._junit_path(self.reports_dir)
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)

    def _record(self):
        path = self.client._scope_path(self.reports_dir)
        self.assertTrue(
            os.path.exists(path),
            f"_bun_test_cmd left no scope record at {path} -- the corroboration "
            "in tests/suite-integrity.test.ts has nothing to read, so it can "
            "only either skip forever or assert against a run whose scope is "
            "unknown (the defect)")
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_scope_record_sits_beside_the_artifact(self):
        self.assertEqual(
            self.client._scope_path(self.reports_dir),
            os.path.join(self.reports_dir, "junit-scope.json"),
            "the record is the artifact's sibling under the reports dir, which "
            "is gitignored -- a local artifact, never a committed file")

    def test_whole_suite_invocation_is_stamped_full(self):
        self.client._bun_test_cmd("bun", None, self.junit_path, False, None)

        record = self._record()
        self.assertEqual(record["scope"], "full")
        self.assertEqual(record["targets"], [])
        self.assertEqual(record["artifact"], self.client.DEFAULT_JUNIT)

    def test_empty_target_list_is_whole_suite_too(self):
        # `_bun_test_cmd`'s own branch is `if targets:` -- an empty LIST and
        # None build the identical whole-suite command, so they must stamp the
        # identical scope. Reading the same value the command branches on is
        # what makes the record structurally unable to disagree with it.
        self.client._bun_test_cmd("bun", [], self.junit_path, False, None)

        self.assertEqual(self._record()["scope"], "full")

    def test_targeted_invocation_is_stamped_scoped_and_names_its_targets(self):
        self.client._bun_test_cmd(
            "bun", ["tests/boot-safety.test.ts", "tests/store.test.ts"],
            self.junit_path, False, None)

        record = self._record()
        self.assertEqual(record["scope"], "scoped")
        self.assertEqual(
            record["targets"],
            ["tests/boot-safety.test.ts", "tests/store.test.ts"],
            "the targets ride along so the skip REASON can name the scope the "
            "artifact actually had, rather than saying only 'not full'")

    def test_scope_record_is_a_pure_function_of_the_targets(self):
        # The mapping, asserted without touching disk: the record's content is
        # decided by `targets` alone.
        self.assertEqual(self.client._scope_record(None)["scope"], "full")
        self.assertEqual(self.client._scope_record([])["scope"], "full")
        self.assertEqual(self.client._scope_record(["a.test.ts"])["scope"], "scoped")

    def test_an_unwritable_reports_dir_never_breaks_the_run(self):
        # Safe direction: a record that could not be written is INDISTINGUISH-
        # ABLE from no record, and no record makes the corroboration skip. A
        # stamping failure must therefore never abort the test run itself.
        missing = os.path.join(self.tmpdir, "nope", "junit.xml")

        cmd = self.client._bun_test_cmd("bun", None, missing, False, None)

        self.assertEqual(cmd[:2], ["bun", "test"])


class WipeRemovesTheArtifactAndItsRecordTogetherTest(unittest.TestCase):
    """A stale record outliving its artifact would re-license the comparison."""

    def setUp(self):
        self.client = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="cr101-wipe-")
        self.reports_dir = os.path.join(self.tmpdir, "test-reports")
        os.makedirs(self.reports_dir, exist_ok=True)
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)

    def test_wipe_removes_both(self):
        junit = self.client._junit_path(self.reports_dir)
        scope = self.client._scope_path(self.reports_dir)
        with open(junit, "w", encoding="utf-8") as fh:
            fh.write("<testsuites/>")
        with open(scope, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"scope": "full", "targets": []}))

        self.client._wipe(self.reports_dir)

        self.assertFalse(os.path.exists(junit))
        self.assertFalse(
            os.path.exists(scope),
            "a scope record that survives the artifact it describes would "
            "certify the NEXT run's artifact -- exactly the stale-state defect "
            "this CR exists to remove")

    def test_wipe_tolerates_a_record_that_is_not_there(self):
        self.client._wipe(self.reports_dir)  # neither file present
        self.assertFalse(os.path.exists(self.client._scope_path(self.reports_dir)))


class ExistingClientBehaviourUnchangedTest(unittest.TestCase):
    """The regression half: the command, the artifact path and the constants
    the ingest/envelope paths depend on are untouched by the stamping."""

    def setUp(self):
        self.client = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="cr101-unchanged-")
        self.reports_dir = os.path.join(self.tmpdir, "test-reports")
        os.makedirs(self.reports_dir, exist_ok=True)
        self.junit_path = self.client._junit_path(self.reports_dir)
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)

    def test_whole_suite_command_is_byte_identical(self):
        self.assertEqual(
            self.client._bun_test_cmd("bun", None, self.junit_path, False, None),
            ["bun", "test", "--reporter=junit",
             f"--reporter-outfile={self.junit_path}"])

    def test_targeted_command_is_byte_identical(self):
        self.assertEqual(
            self.client._bun_test_cmd("bun", ["x.test.ts"], self.junit_path,
                                      False, None),
            ["bun", "test", "x.test.ts", "--reporter=junit",
             f"--reporter-outfile={self.junit_path}"])

    def test_coverage_command_is_byte_identical(self):
        cov = os.path.join(self.tmpdir, "coverage")
        self.assertEqual(
            self.client._bun_test_cmd("bun", None, self.junit_path, True, cov),
            ["bun", "test", "--reporter=junit",
             f"--reporter-outfile={self.junit_path}", "--coverage",
             "--coverage-reporter=lcov", f"--coverage-dir={cov}"])

    def test_artifact_name_and_path_helpers_are_unchanged(self):
        self.assertEqual(self.client.DEFAULT_JUNIT, "junit.xml")
        self.assertEqual(self.client.DEFAULT_REPORTS, "test-reports")
        self.assertEqual(self.client._junit_path("/r"), os.path.join("/r", "junit.xml"))

    def test_parse_junit_file_still_reads_a_real_artifact(self):
        # `_parse_junit_file` takes the junit path directly, so the sibling
        # record cannot reach it -- asserted rather than assumed, because the
        # ingest payload and the printed `files` count both come from here.
        with open(self.junit_path, "w", encoding="utf-8") as fh:
            fh.write('<?xml version="1.0"?><testsuites><testsuite name="s">'
                     '<testcase name="a" classname="s" file="tests/a.test.ts" '
                     'time="0.01"/><testcase name="b" classname="s" '
                     'file="tests/b.test.ts" time="0.02"/></testsuite></testsuites>')
        self.client._bun_test_cmd("bun", None, self.junit_path, False, None)

        summary, tree, files = self.client._parse_junit_file(self.junit_path)

        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(files, 2)
        self.assertTrue(tree)


if __name__ == "__main__":
    unittest.main()
