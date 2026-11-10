"""A go gate runs each declared tier as a suite of its own.

When a module declares a tier by build tag, the go `pre-merge-gate` composes
its declared suites through the shared composition:

  - `untagged` is the gate's whole run: the untagged `go test -json ./...` of
    every module, opened and closed under tier `regression`, holding only the
    untagged tests; its row is covered by that whole go suite;
  - each declared tier but `e2e` is a suite of its own, run by the go client
    under its own tier, holding only that tier's tests, with its own counts
    and outcome;
  - `e2e` is listed and excluded, as on every stack;
  - the gate milestone carries a result under each gated target, and a
    failing tier fails only its own row.

A scoped gate runs only the suites it names; a target go does not declare is
refused before anything runs, and so is a scoped gate with no `go` on PATH,
naming the toolchain. A project that declares no tier keeps today's gate, one
untagged run with no `suites[]`, except that its run now states tier
`regression`; every `--suites` is refused on it.

The module is the `tiers` fixture (untagged `TestUnit`, `integration`-tagged
`TestInteg`, `!integration`-tagged `TestNotInteg`) plus a `bdd`-tagged
`TestBdd` and an `e2e`-tagged `TestE2e`, written into the scratch copy. Each
case drives the real go client, the real `go` behind the recording shim,
against `GoGateBoard` (`tests/client/go_gate_harness.py`).

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_gate_runs_each_declared_tier_as_its_own_suite
"""

import re
import shutil
import tempfile
import unittest

from tests.client.go_client_harness import envelope, go_toolchain_gap, said
from tests.client.go_gate_harness import (
    BDD_TEST,
    E2E_EXCLUDED,
    E2E_TEST,
    GATE_VERB,
    GO_CLIENT_FILE,
    TIERS_PKG,
    WHOLE_GO_SUITE,
    closes_by_run,
    declare_bdd_and_e2e,
    declare_no_tier,
    describe,
    entries_by_target,
    fail_the_integration_test,
    gate_milestones,
    gate_project,
    held_tests,
    opened_runs,
    rows_by_suite,
    runs_by_tier,
)
from tests.client.go_tier_harness import go_test_calls

CYCLE = "7"
#: How a refusal names a project that declares no suites.
DECLARES_NO_SUITES = r"declares? no\b|no (declared |gate )*suites?"


class _GoGateCase(unittest.TestCase):
    maxDiff = 8000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def tier_module(self, failing_integration=False):
        p = gate_project(self)
        declare_bdd_and_e2e(p)
        if failing_integration:
            fail_the_integration_test(p)
        return p

    def gate(self, p, *argv, **env):
        return p.drive(*argv, verb=GATE_VERB, **env)

    def assert_refused_before_anything_ran(self, p, result):
        ctx = describe(p, result)
        self.assertNotEqual(result.returncode, 0, f"the gate is refused; {ctx}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {ctx}")
        self.assertEqual(result.stdout.count("axi:"), 1, f"exactly one envelope; {ctx}")
        self.assertEqual((axi or {}).get("verb"), GATE_VERB, ctx)
        self.assertIs((axi or {}).get("ok"), False, ctx)
        self.assertNotIn("Traceback", result.stderr, f"a refusal, never a traceback; {ctx}")
        self.assertEqual(opened_runs(p), [], f"no run is opened; {ctx}")
        self.assertEqual(go_test_calls(p), [], f"no `go test` runs; {ctx}")
        self.assertEqual(gate_milestones(p), [], f"no gate milestone is posted; {ctx}")
        return axi or {}


class _OneDrivePerClass(_GoGateCase):
    """One real gate drive per class, read by every test of the class."""

    FAILING_INTEGRATION = False
    ARGV: tuple = ()
    drives: list = []

    @classmethod
    def setUpClass(cls):
        cls.drives = []

    def setUp(self):
        super().setUp()
        if not type(self).drives:
            p = self.tier_module(self.FAILING_INTEGRATION)
            type(self).drives.append((p, self.gate(p, *self.ARGV)))
        self.p, self.result = type(self).drives[0]
        self.ctx = describe(self.p, self.result)
        self.axi = envelope(self.result.stdout) or {}


class AGateOverDeclaredTiersGivesOneRowPerSuiteTest(_OneDrivePerClass):
    """The full gate on the module declaring `integration`, `bdd` and `e2e`,
    every test passing."""

    def test_the_ok_envelope_has_rows_untagged_integration_bdd_and_e2e_exactly(self):
        self.assertEqual(sorted(rows_by_suite(self.axi)),
                         ["bdd", "e2e", "integration", "untagged"],
                         f"one row per declared suite; {self.ctx}")
        self.assertEqual(self.axi.get("verb"), GATE_VERB, self.ctx)
        self.assertIs(self.axi.get("ok"), True, self.ctx)
        self.assertEqual(self.result.stdout.count("axi:"), 1, self.ctx)
        self.assertEqual(self.result.returncode, 0, self.ctx)

    def test_the_untagged_row_is_covered_by_the_whole_go_suite_with_total_two(self):
        row = rows_by_suite(self.axi).get("untagged") or {}
        self.assertEqual(row.get("coveredBy"), WHOLE_GO_SUITE, f"row={row!r} {self.ctx}")
        self.assertEqual((row.get("total"), row.get("passed"), row.get("failed")),
                         (2, 2, 0), f"TestUnit and TestNotInteg; row={row!r}")
        self.assertEqual(row.get("outcome"), "pass", f"row={row!r}")
        self.assertNotIn("client", row, f"a covered row is no run of its own; row={row!r}")

    def test_the_integration_and_bdd_rows_are_go_client_runs_with_their_own_counts(self):
        rows = rows_by_suite(self.axi)
        for tier in ("integration", "bdd"):
            row = rows.get(tier) or {}
            self.assertEqual(row.get("client"), GO_CLIENT_FILE, f"{tier}: row={row!r} {self.ctx}")
            self.assertEqual((row.get("total"), row.get("passed"), row.get("failed")),
                             (1, 1, 0), f"{tier}: its one test, passing; row={row!r}")
            self.assertEqual(row.get("outcome"), "pass", f"{tier}: row={row!r}")
            self.assertNotIn("coveredBy", row,
                             f"{tier}: the whole run never collected it; row={row!r}")

    def test_the_e2e_row_is_listed_and_excluded(self):
        row = rows_by_suite(self.axi).get("e2e") or {}
        self.assertIs(row.get("gated"), False, f"row={row!r} {self.ctx}")
        self.assertEqual(row.get("excluded"), E2E_EXCLUDED, f"row={row!r}")
        self.assertNotIn("outcome", row, f"an excluded suite has no outcome; row={row!r}")

    def test_three_runs_open_one_under_each_of_regression_integration_and_bdd(self):
        by_tier = runs_by_tier(self.p)
        self.assertEqual({tier: len(ids) for tier, ids in by_tier.items()},
                         {"regression": 1, "integration": 1, "bdd": 1},
                         f"one run per gated suite, each under its own tier, and no "
                         f"e2e run; {self.ctx}")

    def test_the_whole_run_opens_and_closes_under_regression_and_holds_only_the_untagged_tests(self):
        run_id = (runs_by_tier(self.p).get("regression") or [""])[0]
        start = dict(opened_runs(self.p)).get(run_id) or {}
        self.assertEqual(start.get("total"), 2, f"start={start!r} {self.ctx}")
        closes = closes_by_run(self.p).get(run_id) or []
        self.assertEqual([c.get("tier") for c in closes], ["regression"],
                         f"closed once, under regression; {self.ctx}")
        self.assertEqual(sorted(held_tests(self.p, run_id)),
                         [(TIERS_PKG, "TestNotInteg", "pass"), (TIERS_PKG, "TestUnit", "pass")],
                         f"exactly TestUnit and TestNotInteg; {self.ctx}")

    def test_each_tier_run_holds_only_its_tags_test_and_closes_under_its_tier(self):
        by_tier = runs_by_tier(self.p)
        closes = closes_by_run(self.p)
        for tier, test in (("integration", "TestInteg"), ("bdd", BDD_TEST)):
            run_id = (by_tier.get(tier) or [""])[0]
            self.assertEqual(held_tests(self.p, run_id), [(TIERS_PKG, test, "pass")],
                             f"{tier}: only {test}; {self.ctx}")
            self.assertEqual([c.get("tier") for c in closes.get(run_id) or []], [tier],
                             f"{tier}: closed once, under its tier; {self.ctx}")
        held = [test for run_id, _b in opened_runs(self.p)
                for _pkg, test, _a in held_tests(self.p, run_id)]
        self.assertNotIn(E2E_TEST, held, f"e2e is excluded from the gate; {self.ctx}")

    def test_the_milestone_carries_a_passing_result_under_each_gated_target(self):
        milestones = gate_milestones(self.p)
        self.assertEqual(len(milestones), 1, f"one gate milestone; {self.ctx}")
        milestone = milestones[0] if milestones else {}
        self.assertEqual((milestone.get("outcome"), milestone.get("scope")), ("pass", "full"),
                         f"milestone={milestone!r}")
        entries = entries_by_target(milestone)
        self.assertEqual(sorted(entries), ["bdd", "integration", "untagged"],
                         f"one result per gated target; milestone={milestone!r}")
        self.assertEqual({t: (e.get("outcome"), e.get("passed"), e.get("failed"))
                          for t, e in entries.items()},
                         {"untagged": ("pass", 2, 0), "integration": ("pass", 1, 0),
                          "bdd": ("pass", 1, 0)}, f"milestone={milestone!r}")


class AFailingIntegrationTestFailsOnlyItsOwnRowTest(_OneDrivePerClass):
    FAILING_INTEGRATION = True

    def test_only_the_integration_row_fails(self):
        rows = rows_by_suite(self.axi)
        self.assertEqual({suite: row.get("outcome") for suite, row in rows.items()
                          if suite != "e2e"},
                         {"untagged": "pass", "integration": "fail", "bdd": "pass"},
                         f"{self.ctx}")
        integration = rows.get("integration") or {}
        self.assertEqual((integration.get("passed"), integration.get("failed")), (0, 1),
                         f"row={integration!r}")

    def test_the_gate_is_not_ok_and_exits_non_zero(self):
        self.assertIs(self.axi.get("ok"), False, self.ctx)
        self.assertNotEqual(self.result.returncode, 0, self.ctx)
        self.assertTrue(re.search(r"`integration`", said(self.axi)),
                        f"a warning names the failing suite; {self.ctx}")

    def test_the_milestone_fails_on_the_integration_entry_alone(self):
        milestones = gate_milestones(self.p)
        self.assertEqual(len(milestones), 1, self.ctx)
        milestone = milestones[0] if milestones else {}
        self.assertEqual(milestone.get("outcome"), "fail", f"milestone={milestone!r}")
        self.assertEqual({t: e.get("outcome") for t, e in entries_by_target(milestone).items()},
                         {"untagged": "pass", "integration": "fail", "bdd": "pass"},
                         f"milestone={milestone!r}")


class AGateScopedToIntegrationRunsOnlyItTest(_OneDrivePerClass):
    ARGV = ("--suites", "integration", "--cycle", CYCLE)

    def test_only_the_integration_run_opens(self):
        self.assertEqual([b.get("tier") for _r, b in opened_runs(self.p)], ["integration"],
                         f"no untagged and no bdd run; {self.ctx}")
        run_id = opened_runs(self.p)[0][0] if opened_runs(self.p) else None
        self.assertEqual(held_tests(self.p, run_id), [(TIERS_PKG, "TestInteg", "pass")],
                         self.ctx)

    def test_the_envelope_has_the_integration_row_only(self):
        self.assertEqual(sorted(rows_by_suite(self.axi)), ["integration"], self.ctx)
        self.assertIs(self.axi.get("ok"), True, self.ctx)
        self.assertEqual(self.result.returncode, 0, self.ctx)

    def test_the_milestone_is_scoped_with_the_integration_result_only(self):
        milestones = gate_milestones(self.p)
        self.assertEqual(len(milestones), 1, self.ctx)
        milestone = milestones[0] if milestones else {}
        self.assertEqual(milestone.get("scope"), "scoped", f"milestone={milestone!r}")
        self.assertEqual(sorted(entries_by_target(milestone)), ["integration"],
                         f"milestone={milestone!r}")


class AScopedGateItCannotRunIsRefusedBeforeAnythingRunsTest(_GoGateCase):

    def test_an_undeclared_target_is_refused_naming_the_declared_gated_targets(self):
        p = self.tier_module()
        result = self.gate(p, "--suites", "nosuch", "--cycle", CYCLE)
        axi = self.assert_refused_before_anything_ran(p, result)
        text = said(axi)
        ctx = describe(p, result)
        self.assertIn("`nosuch`", text, f"the refusal names the target; {ctx}")
        for target in ("untagged", "integration", "bdd"):
            self.assertIn(f"`{target}`", text,
                          f"the help names the declared gated target {target}; {ctx}")
        self.assertIsNone(re.search(DECLARES_NO_SUITES, text),
                          f"the project declares suites; {ctx}")

    def test_with_no_go_on_path_a_scoped_gate_is_refused_naming_the_toolchain(self):
        p = self.tier_module()
        empty_path = tempfile.mkdtemp(prefix="go-gate-no-go-")
        self.addCleanup(shutil.rmtree, empty_path, True)
        result = self.gate(p, "--suites", "integration", "--cycle", CYCLE, PATH=empty_path)
        axi = self.assert_refused_before_anything_ran(p, result)
        text = said(axi)
        ctx = describe(p, result)
        self.assertRegex(text, r"(?i)\bgo\b[^.;]*toolchain|toolchain[^.;]*\bgo\b",
                         f"the refusal names the missing go toolchain; {ctx}")
        self.assertIsNone(re.search(DECLARES_NO_SUITES, text),
                          f"the cause is the toolchain, never 'declares no suites'; {ctx}")


class AProjectThatDeclaresNoTierKeepsTodaysGateTest(_GoGateCase):
    """The `tiers` module without its `integration` file declares no tier."""

    drives: list = []

    @classmethod
    def setUpClass(cls):
        cls.drives = []

    def setUp(self):
        super().setUp()
        if not type(self).drives:
            p = gate_project(self)
            declare_no_tier(p)
            type(self).drives.append((p, self.gate(p)))
        self.p, self.result = type(self).drives[0]
        self.ctx = describe(self.p, self.result)
        self.axi = envelope(self.result.stdout) or {}

    def test_the_envelope_is_one_untagged_run_with_no_suites_rows(self):
        self.assertEqual(self.axi.get("verb"), GATE_VERB, self.ctx)
        self.assertIs(self.axi.get("ok"), True, self.ctx)
        self.assertNotIn("suites", self.axi, f"no composed rows; {self.ctx}")
        run = self.axi.get("run") or {}
        self.assertEqual((run.get("passed"), run.get("total")), (2, 2), f"run={run!r}")
        self.assertEqual(self.result.returncode, 0, self.ctx)

    def test_one_run_opens_and_closes_under_regression_holding_the_untagged_tests(self):
        opened = opened_runs(self.p)
        self.assertEqual([b.get("tier") for _r, b in opened], ["regression"],
                         f"the whole run states tier regression; {self.ctx}")
        run_id = opened[0][0] if opened else None
        self.assertEqual([c.get("tier") for c in closes_by_run(self.p).get(run_id) or []],
                         ["regression"], self.ctx)
        self.assertEqual(sorted(held_tests(self.p, run_id)),
                         [(TIERS_PKG, "TestNotInteg", "pass"), (TIERS_PKG, "TestUnit", "pass")],
                         self.ctx)

    def test_the_envelope_states_the_regression_tier(self):
        self.assertEqual(self.axi.get("tier"), "regression", self.ctx)

    def test_the_milestone_is_full_and_carries_no_suites(self):
        milestones = gate_milestones(self.p)
        self.assertEqual(len(milestones), 1, self.ctx)
        milestone = milestones[0] if milestones else {}
        self.assertEqual((milestone.get("outcome"), milestone.get("scope")), ("pass", "full"),
                         f"milestone={milestone!r}")
        self.assertNotIn("suites", milestone, f"milestone={milestone!r}")

    def test_suites_untagged_is_refused(self):
        p = gate_project(self)
        declare_no_tier(p)
        result = self.gate(p, "--suites", "untagged", "--cycle", CYCLE)
        self.assert_refused_before_anything_ran(p, result)


if __name__ == "__main__":
    unittest.main()
