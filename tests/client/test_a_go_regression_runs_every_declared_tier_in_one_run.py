"""A go `regression` runs every declared tier in ONE run under `regression`.

`regression` is one run, filed under tier `regression`, holding the untagged
tests of every module and then each declared tier's tests, `e2e` included,
each invoked as its tier verb invokes it. No test is in two of these sets, so
none runs twice, and the run's start total is their count.

With `--coverage`, every invocation's coverprofile is merged by the client into
ONE `go-coverprofile` text before the close: a block counts as covered when any
invocation covered it, and the `mode:` line is written once. So a package
profiled by its untagged run and again by its tier run is sent once, at the
union of the two.

Cases:
  - the `tiers` module plus a `bdd`-tagged `TestBdd` and an `e2e`-tagged
    `TestE2e` (`go_gate_harness.declare_bdd_and_e2e`);
  - `tests/fixtures/go-client/tier-coverage`: package `cov`, whose untagged
    `TestUnitCov` covers `Unit` and whose `integration`-tagged `TestIntegCov`
    covers `Integ`; `Never` is covered by neither. The expected union is
    computed here from the real `go`'s own profiles of the two invocations.

Each drives the real go client, the real `go` behind the recording shim,
against `GoGateBoard` (`tests/client/go_gate_harness.py`).

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_regression_runs_every_declared_tier_in_one_run
"""

import shutil
import tempfile
import unittest

from tests.client.go_client_harness import envelope, go_toolchain_gap
from tests.client.go_gate_harness import (
    BDD_TEST,
    COVERAGE_CODEC,
    COVERAGE_FIXTURE,
    COVERAGE_PKG,
    E2E_TEST,
    TIERS_PKG,
    closes_by_run,
    declare_bdd_and_e2e,
    describe,
    gate_project,
    held_tests,
    opened_runs,
    oracle_profiles,
    profile_blocks,
    statements,
    union_blocks,
)

#: Every test of the module declaring `integration`, `bdd` and `e2e`.
EVERY_TEST = sorted([(TIERS_PKG, "TestUnit", "pass"), (TIERS_PKG, "TestNotInteg", "pass"),
                     (TIERS_PKG, "TestInteg", "pass"), (TIERS_PKG, BDD_TEST, "pass"),
                     (TIERS_PKG, E2E_TEST, "pass")])


class _RegressionCase(unittest.TestCase):
    maxDiff = 8000
    drives: list = []

    @classmethod
    def setUpClass(cls):
        cls.drives = []

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")
        if not type(self).drives:
            type(self).drives.append(self.make_drive())
        self.p, self.result = type(self).drives[0]
        self.ctx = describe(self.p, self.result)
        self.axi = envelope(self.result.stdout) or {}

    def make_drive(self):
        raise NotImplementedError


class ARegressionHoldsEveryDeclaredTierInOneRunTest(_RegressionCase):

    def make_drive(self):
        p = gate_project(self)
        declare_bdd_and_e2e(p)
        return p, p.drive(verb="regression")

    def test_one_run_opens_under_regression_with_the_count_of_every_test(self):
        opened = opened_runs(self.p)
        self.assertEqual(len(opened), 1, f"exactly one run; {self.ctx}")
        start = opened[0][1] if opened else {}
        self.assertEqual(start.get("tier"), "regression", f"start={start!r}")
        self.assertEqual(start.get("total"), len(EVERY_TEST),
                         f"the untagged, integration, bdd and e2e tests; start={start!r}")

    def test_the_run_holds_every_test_of_every_tier_each_once(self):
        opened = opened_runs(self.p)
        run_id = opened[0][0] if opened else ""
        self.assertEqual(sorted(held_tests(self.p, run_id)), EVERY_TEST,
                         f"TestUnit, TestNotInteg, TestInteg, TestBdd and TestE2e, each "
                         f"once; {self.ctx}")

    def test_the_run_is_closed_once_under_regression_and_passes(self):
        opened = opened_runs(self.p)
        run_id = opened[0][0] if opened else ""
        self.assertEqual([c.get("tier") for c in closes_by_run(self.p).get(run_id) or []],
                         ["regression"], self.ctx)
        self.assertEqual(self.axi.get("verb"), "regression", self.ctx)
        self.assertIs(self.axi.get("ok"), True, self.ctx)
        self.assertEqual(self.result.returncode, 0, self.ctx)


class ARegressionCoverageSendsOneProfileAtTheUnionTest(_RegressionCase):
    #: The real `go`'s own profiles of the untagged and the integration
    #: invocation, written before the drive.
    oracle: tuple = ("", "")

    def make_drive(self):
        scratch = tempfile.mkdtemp(prefix="go-tier-coverage-oracle-")
        self.addClassCleanup(shutil.rmtree, scratch, True)
        type(self).oracle = oracle_profiles(scratch)
        p = gate_project(self, fixture=COVERAGE_FIXTURE)
        return p, p.drive("--coverage", verb="regression")

    def sent(self):
        closes = [b for bodies in closes_by_run(self.p).values() for b in bodies]
        self.assertEqual(len(closes), 1, f"the one run is closed once; {self.ctx}")
        coverage = (closes[0] if closes else {}).get("coverage") or {}
        self.assertEqual(coverage.get("codec"), COVERAGE_CODEC, f"{coverage!r} {self.ctx}")
        return coverage.get("data") or []

    def assert_the_fixture_runs_cover_different_statements(self):
        untagged, integration = (profile_blocks(text) for text in self.oracle)
        union = union_blocks(self.oracle)
        total, union_covered = statements(union)
        self.assertLess(statements(untagged)[1], union_covered,
                        "fixture sanity: the integration run covers what the untagged does not")
        self.assertLess(statements(integration)[1], union_covered,
                        "fixture sanity: the untagged run covers what the integration does not")
        self.assertLess(union_covered, total, "fixture sanity: `Never` is never covered")
        self.assertTrue(all(key.startswith(COVERAGE_PKG + "/") for key in union),
                        f"fixture sanity: the profiles are the cov package's; {sorted(union)}")

    def test_the_close_carries_one_text_the_block_wise_union_with_one_mode_line(self):
        self.assert_the_fixture_runs_cover_different_statements()
        data = self.sent()
        self.assertEqual(len(data), 1,
                         f"ONE go-coverprofile text, never one per invocation; data={data!r}")
        text = data[0] if data else ""
        lines = text.splitlines()
        self.assertTrue(lines and lines[0].startswith("mode: "), f"text={text!r}")
        self.assertEqual(sum(1 for line in lines if line.startswith("mode:")), 1,
                         f"the mode line is written once; text={text!r}")
        self.assertEqual(profile_blocks(text), union_blocks(self.oracle),
                         f"each block covered when either invocation covered it; "
                         f"text={text!r} {self.ctx}")

    def test_the_run_passes_holding_both_tests(self):
        opened = opened_runs(self.p)
        self.assertEqual([b.get("tier") for _r, b in opened], ["regression"], self.ctx)
        run_id = opened[0][0] if opened else ""
        self.assertEqual(sorted(test for _pkg, test, _a in held_tests(self.p, run_id)),
                         ["TestIntegCov", "TestUnitCov"], self.ctx)
        self.assertEqual(self.result.returncode, 0, self.ctx)


if __name__ == "__main__":
    unittest.main()
