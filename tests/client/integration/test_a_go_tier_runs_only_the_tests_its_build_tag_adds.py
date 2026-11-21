"""A go tier verb runs only the tests its build tag adds, in ONE run filed
under the tier — and refuses, before any `go test`, a tier nothing declares or
a tier test that cannot be separated from an untagged one.

A Go project declares a tier with a build tag. For tier `<tier>` a package's
tier files are the test files `go list -tags <tier>` names and the untagged
`go list` does not; its tests are the top-level `Test*`, `Fuzz*` and
`Example*`-with-output functions those files declare, read from the source
(never a benchmark, never `TestMain`). Every package with a tier file is run as
`go test -json -tags <tier> -run '^(<names>)$' <package>`, a package whose
tier files declare no test with `-run '^$'`, all into the one run, whose start
total is the number of its tests.

Each case copies a module from `tests/fixtures/go-client/tier*` and drives the
real go client, the real `go` behind the recording shim of
`go_client_harness`, against a `RecordingBoard`:

  - `tiers`: untagged `TestUnit`, `integration`-tagged `TestInteg`,
    `!integration`-tagged `TestNotInteg`;
  - `tier-shared-name`: `TestX` in a `!integration` file (passing) and again,
    failing, in an `integration` file;
  - `tier-e2e-helper-only` / `-testmain-only` / `-benchmark-only`: an `e2e` tag
    that adds a helper, a `TestMain` or a benchmark, and no test;
  - `tier-name-clash`: untagged `TestY` in package `ledger`'s internal test
    package and an `integration`-tagged `TestY` in its external one;
  - `tier-broken`: an `integration` test file with a type error;
  - `tier-broken-helper`: one package's `integration` test, and another
    package whose `integration` file declares no test and does not compile.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_go_tier_runs_only_the_tests_its_build_tag_adds
"""

import unittest

from tests.client.go_client_harness import (
    PROJECT_KEY,
    RUNS,
    STREAM_CODEC,
    flag_value,
    go_toolchain_gap,
)
from tests.client.go_tier_harness import (
    UNDECLARED_CODE,
    drive_tier,
    envelope,
    go_test_calls,
    held_events,
    held_terminals,
    run_patterns,
    said,
    starts,
    tier_project,
    where,
)

TIERS_PKG = "example.com/tiers/tiers"
SHARED_PKG = "example.com/shared/shared"
BROKEN_PKG = "example.com/tierbroken/broken"
GOOD_PKG = "example.com/brokenhelper/good"
HELPER_PKG = "example.com/brokenhelper/brokenhelper"


class _GoTierCase(unittest.TestCase):
    maxDiff = 6000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def assert_refused_before_any_go_test(self, p, result, verb):
        ctx = where(p, result)
        self.assertNotEqual(result.returncode, 0, f"the verb is refused; {ctx}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {ctx}")
        self.assertEqual((axi or {}).get("verb"), verb, ctx)
        self.assertIs((axi or {}).get("ok"), False, ctx)
        self.assertEqual(result.stdout.count("axi:"), 1, f"exactly one envelope; {ctx}")
        self.assertNotIn("Traceback", result.stderr, f"a refusal, never a traceback; {ctx}")
        self.assertEqual(go_test_calls(p), [],
                         f"no `go test` runs (a `go list` probe may); {ctx}")
        self.assertEqual(starts(p), [], f"no run is opened; {ctx}")
        self.assertEqual([path for path, _b in p.posts() if path.startswith(RUNS)], [],
                         f"nothing is posted to the run routes; {ctx}")
        return axi


# ── a tier runs only its own tests ────────────────────────────────────


class AnIntegrationRunHoldsOnlyTheTestsItsTagAddsTest(_GoTierCase):
    """`integration` on the `tiers` module: one run under tier `integration`,
    start total 1, holding exactly `TestInteg` — never the untagged `TestUnit`
    nor the `!integration` `TestNotInteg`."""

    drives = []

    def drive(self):
        if not type(self).drives:
            p = tier_project(self, "tiers")
            p.board.script_run(passed=1)
            type(self).drives.append((p, drive_tier(p, "integration")))
        return type(self).drives[0]

    def test_one_run_opens_under_tier_integration_with_start_total_one(self):
        p, result = self.drive()
        opened = starts(p)
        self.assertEqual(len(opened), 1, f"exactly one run; {where(p, result)}")
        start = opened[0] if opened else {}
        self.assertEqual(start.get("tier"), "integration",
                         f"the run is filed under its tier; {start!r}")
        self.assertEqual(start.get("total"), 1,
                         f"its start total is the one test the tag adds; {start!r}")
        self.assertEqual((start.get("stack"), start.get("framework")), ("go", STREAM_CODEC),
                         f"a go run decoded by go-test; {start!r}")

    def test_the_stream_files_exactly_the_tagged_test_and_no_untagged_one(self):
        p, result = self.drive()
        self.assertEqual(sorted(held_terminals(p)), [(TIERS_PKG, "TestInteg", "pass")],
                         f"exactly TestInteg reaches the board; {where(p, result)}")

    def test_every_go_test_call_carries_the_tag_and_selects_only_the_tagged_name(self):
        p, result = self.drive()
        calls = go_test_calls(p)
        self.assertGreaterEqual(len(calls), 1, f"go test ran; {where(p, result)}")
        self.assertLessEqual(len(calls), 1,
                             f"one package with one test needs one invocation; "
                             f"{where(p, result)}")
        for call in calls:
            self.assertEqual(flag_value(call["argv"], "-tags"), "integration", call["argv"])
            self.assertIn("-json", call["argv"])
        self.assertEqual(run_patterns(p), ["^(TestInteg)$"],
                         f"the run selects the tier's name; {where(p, result)}")

    def test_the_run_is_closed_once_and_the_envelope_states_the_tier(self):
        p, result = self.drive()
        closes = p.closes()
        self.assertEqual([b.get("codec") for b in closes], [STREAM_CODEC],
                         f"one close from the go-test stream; {where(p, result)}")
        axi = envelope(result.stdout) or {}
        self.assertEqual(axi.get("verb"), "integration", where(p, result))
        self.assertIs(axi.get("ok"), True, where(p, result))
        self.assertEqual(axi.get("tier"), "integration",
                         f"the envelope names the tier it ingested; {axi!r}")
        self.assertEqual((axi.get("context") or {}).get("projectKey"), PROJECT_KEY)
        self.assertEqual(result.returncode, 0, where(p, result))


class ATaggedTestSharingANotTaggedNameIsRunAndFiledTest(_GoTierCase):
    """`TestX` in a `!integration` file and again, failing, in an `integration`
    file: the `integration` run files that tagged `TestX` as failed."""

    def test_the_tagged_test_x_is_filed_as_failed(self):
        p = tier_project(self, "tier-shared-name")
        p.board.script_run(failed=1)
        result = drive_tier(p, "integration")
        ctx = where(p, result)
        opened = starts(p)
        self.assertEqual(len(opened), 1, f"one run opens; {ctx}")
        self.assertEqual((opened[0] if opened else {}).get("tier"), "integration", ctx)
        self.assertEqual((opened[0] if opened else {}).get("total"), 1,
                         f"the tag adds one test, TestX; {ctx}")
        self.assertEqual(held_terminals(p), [(SHARED_PKG, "TestX", "fail")],
                         f"the integration TestX ran and failed, filed once; {ctx}")
        self.assertNotEqual(result.returncode, 0, f"a failing tier run exits non-zero; {ctx}")


# ── an undeclared tier is refused before any test runs ────────────────


class AnUndeclaredTierIsRefusedBeforeAnyTestRunsTest(_GoTierCase):
    """`e2e` with no `e2e` tier test is refused: `ok: false`, a non-zero exit,
    help naming `//go:build e2e` in a `_test.go` file, no run opened and no
    `go test` run. A tag that adds only a helper, only a `TestMain` or only a
    benchmark declares nothing either."""

    def assert_e2e_refused_as_undeclared(self, fixture):
        p = tier_project(self, fixture)
        result = drive_tier(p, "e2e")
        axi = self.assert_refused_before_any_go_test(p, result, "e2e")
        ctx = where(p, result)
        words = said(axi)
        self.assertIn("//go:build e2e", words,
                      f"the help names the declaration; {words!r}")
        self.assertIn("_test.go", words, f"the help names where it goes; {words!r}")
        self.assertIn(UNDECLARED_CODE, result.stderr,
                      f"refused as an undeclared tier; {ctx}")

    def test_a_module_with_no_e2e_tier_file_is_refused(self):
        self.assert_e2e_refused_as_undeclared("tiers")

    def test_an_e2e_tag_adding_only_a_helper_declares_nothing(self):
        self.assert_e2e_refused_as_undeclared("tier-e2e-helper-only")

    def test_an_e2e_tag_adding_only_a_test_main_declares_nothing(self):
        self.assert_e2e_refused_as_undeclared("tier-e2e-testmain-only")

    def test_an_e2e_tag_adding_only_a_benchmark_declares_nothing(self):
        self.assert_e2e_refused_as_undeclared("tier-e2e-benchmark-only")


# ── a name that cannot be separated is refused ────────────────────────


class ATierTestThatCannotBeSeparatedIsRefusedTest(_GoTierCase):
    """Untagged `TestY` in `ledger`'s internal test package and an
    `integration`-tagged `TestY` in its external one: `-run '^(TestY)$'` would
    run both, so `integration` is refused before any run opens, naming the
    package and `TestY`."""

    def test_the_clash_is_refused_naming_the_package_and_the_test(self):
        p = tier_project(self, "tier-name-clash")
        result = drive_tier(p, "integration")
        axi = self.assert_refused_before_any_go_test(p, result, "integration")
        words = said(axi)
        self.assertIn("TestY", words, f"the refusal names the test; {words!r}")
        self.assertIn("ledger", words, f"the refusal names the package; {words!r}")
        self.assertNotIn(UNDECLARED_CODE, result.stderr,
                         f"the tier IS declared (TestZ, TestY): this is the clash, "
                         f"not an undeclared tier; {where(p, result)}")


# ── a tier file that does not compile fails its run ───────────────────


class ATierFileThatDoesNotCompileFailsItsRunTest(_GoTierCase):
    """A tier file with a type error opens the run, fails it and files the
    build failure; it is never refused and never passes — also when the
    package's tier files declare no test."""

    def assert_run_opened_and_failed_on_the_build(self, p, result, broken_pkg):
        ctx = where(p, result)
        opened = starts(p)
        self.assertEqual(len(opened), 1, f"the run opens (not refused); {ctx}")
        self.assertEqual((opened[0] if opened else {}).get("tier"), "integration", ctx)
        self.assertNotIn(UNDECLARED_CODE, result.stderr, ctx)
        build_fails = [e for e in held_events(p) if e.get("Action") == "build-fail"
                       and str(e.get("ImportPath", "")).startswith(broken_pkg)]
        self.assertEqual(len(build_fails), 1,
                         f"the stream carries {broken_pkg}'s build failure once; {ctx}")
        failed_builds = [e for e in held_events(p) if e.get("Action") == "fail"
                         and e.get("Package") == broken_pkg and e.get("FailedBuild")]
        self.assertEqual(len(failed_builds), 1,
                         f"{broken_pkg} fails as a failed build; {ctx}")
        closes = p.closes()
        self.assertEqual(len(closes), 1, f"the run is closed once; {ctx}")
        self.assertNotIn((closes[0] if closes else {}).get("runnerExit"), (None, 0),
                         f"the close carries go's failing exit; {closes!r}")
        self.assertNotEqual(result.returncode, 0, f"the run does not pass; {ctx}")

    def test_an_integration_test_file_with_a_type_error_fails_the_run(self):
        p = tier_project(self, "tier-broken")
        p.board.script_run(failed=1)
        result = drive_tier(p, "integration")
        self.assert_run_opened_and_failed_on_the_build(p, result, BROKEN_PKG)
        start = starts(p)[0] if starts(p) else {}
        self.assertEqual(start.get("total"), 1,
                         f"the broken file's test is read from the source; {start!r}")

    def test_a_package_whose_broken_tier_file_declares_no_test_still_fails_the_run(self):
        p = tier_project(self, "tier-broken-helper")
        p.board.script_run(passed=1, failed=1)
        result = drive_tier(p, "integration")
        self.assert_run_opened_and_failed_on_the_build(p, result, HELPER_PKG)
        ctx = where(p, result)
        start = starts(p)[0] if starts(p) else {}
        self.assertEqual(start.get("total"), 1,
                         f"only TestGoodInteg is a tier test; {start!r}")
        self.assertIn((GOOD_PKG, "TestGoodInteg", "pass"), held_terminals(p), ctx)
        self.assertNotIn("TestHelperUntagged",
                         [test for _pkg, test, _a in held_terminals(p)],
                         f"the untagged test of the broken package never runs; {ctx}")
        self.assertEqual(run_patterns(p).count("^$"), 1,
                         f"the package with no tier test runs with -run '^$' so its "
                         f"build is checked; {ctx}")


if __name__ == "__main__":
    unittest.main()
