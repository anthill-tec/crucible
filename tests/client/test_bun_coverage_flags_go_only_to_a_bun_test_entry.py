"""bun's coverage flags go only to a `bun-test` entry, and only on `--coverage`.

A declared script is handed bun's coverage flags (`--coverage`,
`--coverage-reporter=lcov`, `--coverage-dir=<dir>`) only when its
`crucible.targets` entry is `bun-test` with `junit: flag` (or it has no entry).
Any other declared script run with `--coverage` -- an entry of another
framework with `junit: flag`, an `env:<VAR>` entry, a `stream` entry -- is
handed none, files no coverage, and its envelope carries exactly one
`coverage-not-measured` warning naming the script. This holds on every verb
that runs a declared script: `regression` (through the marked entry), a tier
verb, and `test`.

Without `--coverage`, no coverage flag reaches any runner and nothing is filed
as coverage: on an unmarked project, and on each kind of marked entry.

Every case drives the REAL `clients/bun-crucible.py` as an OS subprocess, with
the stand-in `bun` of `bun_targets_harness` recording every argv it is spawned
with (and writing an lcov report only where it is handed `--coverage-dir=`),
against a stand-in board recording every POST.
"""

import os
import unittest

from tests.client.bun_targets_harness import (
    CLOSE,
    JUNIT_VAR,
    PLANTED_LCOV,
    VITEST_STREAM_ENTRY,
    TargetsCase,
)

UNIT = "test:unit"
VITEST = "test:vitest"
ENV_JUNIT = f"env:{JUNIT_VAR}"
NOT_MEASURED = "coverage-not-measured"

FLAG_BUN_TEST_ENTRY = {"framework": "bun-test", "junit": "flag"}
FLAG_VITEST_ENTRY = {"framework": "vitest", "junit": "flag"}
ENV_VITEST_ENTRY = {"framework": "vitest", "junit": ENV_JUNIT}


def marked(entry: dict) -> dict:
    return {**entry, "test": True}


def _not_measured(envelope):
    return [w for w in (envelope or {}).get("warnings") or []
            if isinstance(w, dict) and w.get("code") == NOT_MEASURED]


class _CoverageCase(TargetsCase):
    """Reading the one spawn, the one filing and the envelope of a run."""

    def only_spawn(self, drive):
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1,
                         f"the run spawns its runner exactly once; spawns={spawns!r}; "
                         f"{drive.diag()}")
        return spawns[0] if spawns else {"argv": [], "env": {}}

    def assert_ran_the_script(self, argv, script, drive):
        self.assertEqual(argv[:2], ["run", script],
                         f"the run goes through the declared script; argv={argv!r}; "
                         f"{drive.diag()}")

    def assert_handed_no_coverage_flag(self, argv, drive):
        handed = [arg for arg in argv if arg.startswith("--coverage")]
        self.assertEqual(handed, [],
                         f"no coverage flag reaches the runner; argv={argv!r}; "
                         f"{drive.diag()}")

    def assert_filed_without_coverage(self, drive):
        close = self.only(CLOSE, drive)
        self.assertNotIn("coverage", close,
                         f"nothing is filed as coverage; close={close!r}")

    def assert_no_not_measured_warning(self, drive):
        self.assertEqual(_not_measured(self.envelope(drive)), [],
                         f"no coverage was asked, so none is missing; {drive.diag()}")

    def assert_withheld(self, drive, script):
        """Handed no coverage flag, filed with no coverage, and exactly one
        `coverage-not-measured` warning naming the script."""
        argv = self.only_spawn(drive)["argv"]
        self.assert_ran_the_script(argv, script, drive)
        self.assert_handed_no_coverage_flag(argv, drive)
        self.assert_filed_without_coverage(drive)
        warnings = _not_measured(self.envelope(drive))
        self.assertEqual(len(warnings), 1,
                         f"exactly one {NOT_MEASURED} warning; {drive.diag()}")
        detail = str(warnings[0].get("detail")) if warnings else ""
        self.assertIn(script, detail,
                      f"the warning names the script; warning={warnings!r}")


# ── without --coverage, nothing is measured on any path ─────────────────────


class WithoutCoverageNoRunIsHandedCoverageFlagsTest(_CoverageCase):
    """`regression` without `--coverage` hands no coverage flag to its runner
    and files no coverage, unmarked and on each kind of marked entry."""

    def test_an_unmarked_regression_is_handed_no_coverage_flag_and_files_none(self):
        self.declare({UNIT: "bun test tests/unit"}, {"targets": {UNIT: FLAG_BUN_TEST_ENTRY}})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        self.assertEqual(argv[:1], ["test"], f"the client's own bun test; argv={argv!r}")
        self.assert_handed_no_coverage_flag(argv, drive)
        self.assert_filed_without_coverage(drive)
        self.assert_no_not_measured_warning(drive)

    def test_a_marked_bun_test_flag_entry_is_handed_no_coverage_flag_and_files_none(self):
        self.declare({UNIT: "bun test tests/unit"},
                     {"targets": {UNIT: marked(FLAG_BUN_TEST_ENTRY)}})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        self.assert_ran_the_script(argv, UNIT, drive)
        self.assert_handed_no_coverage_flag(argv, drive)
        self.assert_filed_without_coverage(drive)
        self.assert_no_not_measured_warning(drive)

    def test_a_marked_vitest_flag_entry_is_handed_no_coverage_flag_and_files_none(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(FLAG_VITEST_ENTRY)}})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        self.assert_ran_the_script(argv, VITEST, drive)
        self.assert_handed_no_coverage_flag(argv, drive)
        self.assert_filed_without_coverage(drive)
        self.assert_no_not_measured_warning(drive)

    def test_a_marked_env_entry_is_handed_no_coverage_flag_and_files_none(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(ENV_VITEST_ENTRY)}})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        self.assert_ran_the_script(argv, VITEST, drive)
        self.assert_handed_no_coverage_flag(argv, drive)
        self.assert_filed_without_coverage(drive)
        self.assert_no_not_measured_warning(drive)

    def test_a_marked_stream_entry_is_handed_no_coverage_flag_and_files_none(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(VITEST_STREAM_ENTRY)}})
        drive = self.drive("regression")
        argv = self.only_spawn(drive)["argv"]
        self.assert_ran_the_script(argv, VITEST, drive)
        self.assert_handed_no_coverage_flag(argv, drive)
        self.assert_filed_without_coverage(drive)
        self.assert_no_not_measured_warning(drive)


# ── with --coverage, a bun-test flag entry is handed bun's flags ────────────


class CoverageFlagsGoToAMarkedBunTestFlagEntryTest(_CoverageCase):

    def test_a_marked_bun_test_flag_entry_is_handed_bun_coverage_flags_and_files_its_lcov(self):
        self.declare({UNIT: "bun test tests/unit"},
                     {"targets": {UNIT: marked(FLAG_BUN_TEST_ENTRY)}})
        drive = self.drive("regression", "--coverage")
        argv = self.only_spawn(drive)["argv"]
        self.assert_ran_the_script(argv, UNIT, drive)
        coverage_dir = os.path.join(str(self.project), "coverage")
        self.assertEqual(argv[2:3], ["--reporter=junit"], f"argv={argv!r}")
        self.assertRegex(argv[3] if len(argv) > 3 else "",
                         r"^--reporter-outfile=.+junit\.xml$", f"argv={argv!r}")
        self.assertEqual(argv[4:], ["--coverage", "--coverage-reporter=lcov",
                                    f"--coverage-dir={coverage_dir}"],
                         f"bun's coverage flags follow the report flags; argv={argv!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        close = self.only(CLOSE, drive)
        self.assertEqual(close.get("coverage"), {"codec": "lcov", "data": [PLANTED_LCOV]},
                         f"the run's lcov is filed with it; close={close!r}")
        self.assertEqual(_not_measured(self.envelope(drive)), [],
                         f"coverage was measured; {drive.diag()}")


# ── with --coverage, every other entry is handed none and says so once ─────


class CoverageIsWithheldFromEveryOtherEntryTest(_CoverageCase):
    """`--coverage` on a declared script that is not a `bun-test` flag entry:
    no coverage flag, no coverage filed, one `coverage-not-measured`."""

    def test_regression_on_a_marked_vitest_flag_entry_is_handed_no_coverage_flag(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(FLAG_VITEST_ENTRY)}})
        drive = self.drive("regression", "--coverage")
        self.assert_withheld(drive, VITEST)

    def test_regression_on_a_marked_env_entry_is_handed_no_coverage_flag(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(ENV_VITEST_ENTRY)}})
        drive = self.drive("regression", "--coverage")
        self.assert_withheld(drive, VITEST)

    def test_regression_on_a_marked_stream_entry_is_handed_no_coverage_flag(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(VITEST_STREAM_ENTRY)}})
        drive = self.drive("regression", "--coverage")
        self.assert_withheld(drive, VITEST)

    def test_a_tier_verb_on_a_declared_vitest_flag_entry_is_handed_no_coverage_flag(self):
        self.declare({UNIT: "vitest run"}, {"targets": {UNIT: FLAG_VITEST_ENTRY}})
        drive = self.drive("unit", "--coverage")
        self.assert_withheld(drive, UNIT)

    def test_test_on_a_marked_vitest_flag_entry_is_handed_no_coverage_flag(self):
        self.declare({VITEST: "vitest run"}, {"targets": {VITEST: marked(FLAG_VITEST_ENTRY)}})
        drive = self.drive("test", "--coverage")
        self.assert_withheld(drive, VITEST)


if __name__ == "__main__":
    unittest.main()
