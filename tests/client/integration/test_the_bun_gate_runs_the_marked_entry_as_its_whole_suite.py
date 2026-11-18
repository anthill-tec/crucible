"""The bun gate's whole-suite step runs the entry marked `"test": true`.

A bun project marks ONE entry of `crucible.targets` with `"test": true`. The
gate (`pre-merge-gate`) runs what `regression` runs: on a marked project its
whole-suite step is `bun run <marked script>`, never `bun test`.

What is pinned:
- the whole-suite run is the marked script, spawned exactly once, and no
  `bun test` is spawned: with no declared suite, with declared suites
  alongside, and for a marked `vitest` entry keyed `test` whose only declared
  suite is a `playwright` `test:e2e` (the run is not skipped);
- an unmarked project's gate spawns the same `bun test` argv the client's own
  builder produces (a regression pin);
- only the marked script is covered by the whole-suite run: a marked
  `bun-test` `test:unit` is recorded as covered by it, while an unentried
  `test:integration` runs as its own suite with no coverage; a marked
  `vitest` entry keyed `test` runs once, and a `vitest` `test:unit` and a
  `playwright` `test:client` each run as their own suite;
- the marked entry is not refused as off-template, whatever its key; an
  unmarked non-`bun-test` entry keyed `build`, and one keyed `test:e2e` with
  no such script, are still refused before anything runs, with the detail
  the client gives today (taken from a run of today's client);
- a whole-suite run through an `env:<VAR>` marked entry, and one through a
  `vitest` `junit: flag` marked entry, are green with `ok: true`, exactly
  one `coverage-not-measured` warning and no coverage flag in any argv.

Every test drives the REAL `clients/bun-crucible.py` `pre-merge-gate` as an
OS subprocess with the stand-in `bun` of the gate-frameworks tests, which
records every argv it is spawned with, against a board recording every POST.

TIER: integration (a TCP listener and spawned client processes).
"""

import os
import unittest

from tests.client.bun_targets_harness import AGENT, JUNIT_VAR
from tests.client.bun_regression_runs_the_marked_target_helpers import _load_bun_client
from tests.client.integration.test_the_bun_gate_runs_every_declared_frameworks_suite import (
    _GateFrameworksCase,
)
from tests.client.the_bun_gate_runs_every_declared_frameworks_suite_helpers import (
    BUN_CLIENT_NAME,
    BUN_TEST_ENTRY,
    COVERAGE_NOT_MEASURED,
    GATE,
    SCRIPT_CASES,
    VITEST_JUNIT_ENV_ENTRY,
    VITEST_JUNIT_FLAG_ENTRY,
    WHOLE_SUITE_LABEL,
)

TARGET_REFUSED = "target-refused"
PLAYWRIGHT_JUNIT_ENV_ENTRY = {"framework": "playwright", "junit": f"env:{JUNIT_VAR}"}
BUN_TEST_ENV_ENTRY = {"framework": "bun-test", "junit": f"env:{JUNIT_VAR}"}

# The off-template refusal's detail as today's client gives it, copied from
# the envelope of a gate run on a package declaring only that entry.
BUILD_OFF_TEMPLATE_DETAIL = (
    "crucible.targets.build declares a framework other than 'bun-test' on a key "
    "that is not a `test:` script in package.json's `scripts`, so the gate cannot "
    "run it; nothing was run")
E2E_OFF_TEMPLATE_DETAIL = (
    "crucible.targets.test:e2e declares a framework other than 'bun-test' on a key "
    "that is not a `test:` script in package.json's `scripts`, so the gate cannot "
    "run it; nothing was run")


def marked(entry):
    """`entry` carrying the `test` marker."""
    return {**entry, "test": True}


class _MarkedGateCase(_GateFrameworksCase):
    """Reading what one marked project's gate spawned, filed and answered."""

    def coverage_args(self):
        """Every `--coverage*` argument of every spawn."""
        return [arg for spawn in self.spawns() for arg in spawn.get("argv") or []
                if str(arg).startswith("--coverage")]

    def codes(self, drive):
        return [w.get("code") for w in self.warnings(drive)]

    def assert_whole_suite_is_the_marked_script(self, drive, script):
        """`bun run <script>` exactly once, and no `bun test`."""
        self.assertEqual(self.whole_suite_spawns(), [],
                         f"a marked project's gate never runs `bun test`; "
                         f"spawns={self.spawns()!r}; {drive.diag()}")
        self.assert_ran_once_by_its_own_script(drive, script)

    def assert_green(self, drive):
        self.assertEqual(drive.returncode, 0, drive.diag())
        envelope = self.envelope(drive)
        self.assertEqual((envelope.get("verb"), envelope.get("ok")), (GATE, True),
                         drive.diag())
        self.assertNotIn(TARGET_REFUSED, self.codes(drive), drive.diag())

    def assert_own_suite_row(self, drive, suite):
        """`suite` ran as its own suite: its row is not covered by the
        whole-suite run, names the bun client, and carries its own run's
        counts and a `pass`."""
        row = self.row(drive, suite)
        self.assertNotIn("coveredBy", row, f"row={row!r}")
        self.assertEqual(row.get("client"), BUN_CLIENT_NAME, f"row={row!r}")
        self.assertEqual((row.get("passed"), row.get("failed"), row.get("total"),
                          row.get("outcome")),
                         (SCRIPT_CASES, 0, SCRIPT_CASES, "pass"), f"row={row!r}")

    def filed(self):
        return sorted((b.get("framework"), b.get("tier")) for b in self.ingests())


# ── the whole-suite run is the marked script ────────────────────────────────


class TheGatesWholeSuiteRunIsTheMarkedScriptTest(_MarkedGateCase):

    def test_a_marked_vitest_entry_keyed_test_with_no_declared_suite_is_the_whole_run(self):
        """Only `test` (Vitest, marked): `bun run test` once, filed under
        `regression` as `vitest`, and the gate is green."""
        self.declare({"test": "vitest run"},
                     {"targets": {"test": marked(VITEST_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test")
        self.assertEqual(self.filed(), [("vitest", "regression")], drive.diag())
        self.assert_green(drive)

    def test_a_marked_bun_test_entry_keyed_test_with_no_declared_suite_is_the_whole_run(self):
        """Only `test` (`bun-test`, marked): `bun run test` once rather than
        the client's own `bun test`, filed under `regression`."""
        self.declare({"test": "bun test"},
                     {"targets": {"test": marked(BUN_TEST_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test")
        self.assertEqual(self.filed(), [("bun-test", "regression")], drive.diag())
        self.assert_green(drive)

    def test_a_marked_entry_keyed_test_beside_declared_suites_is_the_whole_run(self):
        """`test` (`bun-test`, marked) beside an unentried `test:client` and a
        Vitest `test:vitest`: `bun run test` once, and each declared suite
        once by its own script."""
        self.declare({"test": "bun test", "test:client": "bun test tests",
                      "test:vitest": "vitest run"},
                     {"targets": {"test": marked(BUN_TEST_ENTRY),
                                  "test:vitest": dict(VITEST_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test")
        self.assert_ran_once_by_its_own_script(drive, "test:client")
        self.assert_ran_once_by_its_own_script(drive, "test:vitest")
        self.assert_own_suite_row(drive, "test:client")
        self.assert_own_suite_row(drive, "test:vitest")
        self.assert_green(drive)

    def test_a_marked_vitest_test_entry_whose_only_suite_is_an_e2e_playwright_one_is_not_skipped(self):
        """`test` (Vitest, marked) beside a Playwright `test:e2e`, the only
        declared suite: `bun run test` still runs once (the envelope names no
        skipped whole suite), and `test:e2e` stays excluded and never runs."""
        self.declare({"test": "vitest run", "test:e2e": "playwright test"},
                     {"targets": {"test": marked(VITEST_JUNIT_ENV_ENTRY),
                                  "test:e2e": dict(PLAYWRIGHT_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test")
        envelope = self.envelope(drive)
        self.assertNotIn("wholeSuite", envelope,
                         f"the whole-suite run is not skipped; envelope={envelope!r}")
        self.assertEqual(self.script_spawns("test:e2e"), [],
                         f"the e2e suite is never run; spawns={self.spawns()!r}")
        e2e = self.row(drive, "test:e2e")
        self.assertIs(e2e.get("gated"), False, f"row={e2e!r}")
        self.assertTrue(e2e.get("excluded"), f"row={e2e!r}")
        self.assertEqual(self.filed(), [("vitest", "regression")], drive.diag())
        self.assert_green(drive)


class AnUnmarkedGateSpawnsTheClientsOwnBunTestTest(_MarkedGateCase):
    """Regression pin: an unmarked project's whole-suite run is unchanged."""

    def test_an_unmarked_project_spawns_exactly_the_clients_own_bun_test_argv(self):
        """No table: the gate's one spawn is the argv the client's own
        `bun test` builder produces for a coverage run into the gate's
        reports dir."""
        self.declare({"test:client": "bun test tests"})
        drive = self.gate()
        spawns = self.spawns()
        self.assertEqual(len(spawns), 1, f"spawns={spawns!r}; {drive.diag()}")
        client = _load_bun_client()
        junit_path = client._junit_path(
            client._reports_dir(str(self.project), str(self.reports), AGENT))
        expected = client._bun_test_cmd(str(self.fake), None, junit_path, True,
                                        os.path.join(str(self.project), "coverage"))
        self.assertEqual((spawns or [{}])[0].get("argv"), expected[1:],
                         f"the same `bun test` argv the client's builder produces; "
                         f"{drive.diag()}")
        self.assertEqual(self.row(drive, "test:client").get("coveredBy"),
                         WHOLE_SUITE_LABEL, drive.diag())


# ── only the marked script is covered ───────────────────────────────────────


class OnlyTheMarkedScriptIsCoveredByTheWholeSuiteRunTest(_MarkedGateCase):

    def test_a_marked_bun_test_unit_is_covered_and_an_unentried_integration_runs_on_its_own(self):
        """`test:unit` (`bun-test`, marked, body `bun test tests/unit`) beside
        an unentried `test:integration`: `test:unit` is the whole-suite run,
        handed bun's coverage flags and recorded as covered by it;
        `test:integration` runs once on its own, handed no coverage flag and
        filed with no coverage."""
        self.declare({"test:unit": "bun test tests/unit",
                      "test:integration": "bun test tests/integration"},
                     {"targets": {"test:unit": marked(BUN_TEST_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test:unit")
        unit_argv = (self.script_spawns("test:unit") or [{}])[0].get("argv") or []
        self.assertIn("--coverage", unit_argv,
                      f"the whole-suite run keeps its coverage; argv={unit_argv!r}")
        unit = self.row(drive, "test:unit")
        self.assertIsInstance(unit.get("coveredBy"), str, f"row={unit!r}")
        self.assertEqual((unit.get("passed"), unit.get("total"), unit.get("outcome")),
                         (SCRIPT_CASES, SCRIPT_CASES, "pass"), f"row={unit!r}")
        self.assert_ran_once_by_its_own_script(drive, "test:integration")
        integration_argv = (self.script_spawns("test:integration") or [{}])[0].get("argv") or []
        self.assertEqual([a for a in integration_argv if a.startswith("--coverage")], [],
                         f"a suite run on its own measures no coverage; "
                         f"argv={integration_argv!r}")
        self.assert_own_suite_row(drive, "test:integration")
        by_tier = {str(b.get("tier")): b for b in self.ingests()}
        self.assertEqual(sorted(by_tier), ["integration", "regression"],
                         f"ingests={self.ingests()!r}; {drive.diag()}")
        self.assertEqual(len(self.ingests()), 2, f"ingests={self.ingests()!r}")
        self.assertNotIn("coverage", by_tier.get("integration") or {},
                         f"ingests={self.ingests()!r}")
        self.assertEqual(((by_tier.get("regression") or {}).get("coverage") or {}).get("codec"),
                         "lcov", f"ingests={self.ingests()!r}")
        run = self.envelope(drive).get("run") or {}
        self.assertEqual((run.get("passed"), run.get("total")),
                         (2 * SCRIPT_CASES, 2 * SCRIPT_CASES), f"run={run!r}")
        self.assert_green(drive)

    def test_a_marked_vitest_test_runs_once_and_a_vitest_unit_and_a_playwright_client_each_run_on_their_own(self):
        """`test` (Vitest, marked) beside a Vitest `test:unit` and a
        Playwright `test:client`: `bun run test` once as the whole-suite run;
        `test:unit` and `test:client` each once, by their own script, each
        row their own."""
        self.declare({"test": "vitest run", "test:unit": "vitest run unit",
                      "test:client": "playwright test"},
                     {"targets": {"test": marked(VITEST_JUNIT_ENV_ENTRY),
                                  "test:unit": dict(VITEST_JUNIT_ENV_ENTRY),
                                  "test:client": dict(PLAYWRIGHT_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test")
        self.assert_ran_once_by_its_own_script(drive, "test:unit")
        self.assert_ran_once_by_its_own_script(drive, "test:client")
        self.assertEqual(len(self.spawns()), 3, f"spawns={self.spawns()!r}")
        self.assert_own_suite_row(drive, "test:unit")
        self.assert_own_suite_row(drive, "test:client")
        run = self.envelope(drive).get("run") or {}
        self.assertEqual((run.get("passed"), run.get("total")),
                         (3 * SCRIPT_CASES, 3 * SCRIPT_CASES), f"run={run!r}")
        self.assert_green(drive)


# ── the off-template refusal ────────────────────────────────────────────────


class TheMarkedEntryIsNotRefusedAsOffTemplateTest(_MarkedGateCase):

    def assert_off_template_refused(self, drive, detail):
        """Refused before anything runs (nothing spawned, no run filed), with
        exactly `detail`."""
        self.assertNotEqual(drive.returncode, 0, drive.diag())
        self.assertEqual(self.spawns(), [], f"spawns={self.spawns()!r}; {drive.diag()}")
        self.assertEqual(self.ingests(), [], drive.diag())
        envelope = self.envelope(drive)
        self.assertEqual((envelope.get("verb"), envelope.get("ok")), (GATE, False),
                         drive.diag())
        refused = [w.get("detail") for w in self.warnings(drive)
                   if w.get("code") == TARGET_REFUSED]
        self.assertEqual(refused, [detail], f"envelope={envelope!r}")

    def test_a_marked_vitest_entry_keyed_test_runs_the_gate_past_the_refusal(self):
        """`test` (Vitest, marked) beside an unentried `test:client`: the gate
        is not refused and runs both."""
        self.declare({"test": "vitest run", "test:client": "bun test tests"},
                     {"targets": {"test": marked(VITEST_JUNIT_ENV_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test")
        self.assert_ran_once_by_its_own_script(drive, "test:client")
        self.assert_green(drive)

    def test_an_unmarked_vitest_entry_keyed_build_is_refused_with_todays_detail(self):
        """Regression pin: `build` alone (Vitest, unmarked)."""
        self.declare({"build": "vitest run"},
                     {"targets": {"build": dict(VITEST_JUNIT_ENV_ENTRY)}})
        self.assert_off_template_refused(self.gate(), BUILD_OFF_TEMPLATE_DETAIL)

    def test_an_unmarked_vitest_entry_keyed_test_e2e_with_no_script_is_refused_with_todays_detail(self):
        """Regression pin: `test:e2e` (Vitest, unmarked) with no `test:e2e`
        script."""
        self.declare({"test:client": "bun test tests"},
                     {"targets": {"test:e2e": dict(VITEST_JUNIT_ENV_ENTRY)}})
        self.assert_off_template_refused(self.gate(), E2E_OFF_TEMPLATE_DETAIL)

    def test_an_unmarked_build_entry_beside_a_marked_test_entry_is_still_refused_naming_build(self):
        """`test` (Vitest, marked) declared first, then `build` (Vitest,
        unmarked): the refusal passes over the marked entry and names
        `build`, with today's detail."""
        self.declare({"test": "vitest run", "build": "vitest run"},
                     {"targets": {"test": marked(VITEST_JUNIT_ENV_ENTRY),
                                  "build": dict(VITEST_JUNIT_ENV_ENTRY)}})
        self.assert_off_template_refused(self.gate(), BUILD_OFF_TEMPLATE_DETAIL)

    def test_an_unmarked_test_e2e_entry_with_no_script_beside_a_marked_test_entry_is_still_refused(self):
        """`test` (Vitest, marked) declared first, then `test:e2e` (Vitest,
        unmarked) with no such script: refused naming `test:e2e`, with
        today's detail."""
        self.declare({"test": "vitest run"},
                     {"targets": {"test": marked(VITEST_JUNIT_ENV_ENTRY),
                                  "test:e2e": dict(VITEST_JUNIT_ENV_ENTRY)}})
        self.assert_off_template_refused(self.gate(), E2E_OFF_TEMPLATE_DETAIL)


# ── coverage in the gate ────────────────────────────────────────────────────


class AMarkedWholeSuiteRunThatMeasuresNoCoverageSaysSoTest(_MarkedGateCase):

    def assert_green_with_one_coverage_not_measured_warning(self, drive):
        self.assert_green(drive)
        named = [c for c in self.codes(drive) if c == COVERAGE_NOT_MEASURED]
        self.assertEqual(len(named), 1,
                         f"exactly one {COVERAGE_NOT_MEASURED} warning; "
                         f"warnings={self.warnings(drive)!r}")
        self.assertEqual(self.coverage_args(), [],
                         f"no coverage flag is spawned; spawns={self.spawns()!r}")

    def test_an_env_reporting_marked_entry_is_green_with_one_coverage_not_measured_warning(self):
        """`test:unit` (`bun-test`, `junit: env:<VAR>`, marked): the
        whole-suite run is told its report path in the variable and handed no
        coverage flag."""
        self.declare({"test:unit": "bun test tests/unit"},
                     {"targets": {"test:unit": marked(BUN_TEST_ENV_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test:unit")
        self.assert_green_with_one_coverage_not_measured_warning(drive)

    def test_a_flag_reporting_vitest_marked_entry_is_green_with_one_coverage_not_measured_warning(self):
        """`test` (Vitest, `junit: flag`, marked): the whole-suite run takes
        the report flags but no coverage flag."""
        self.declare({"test": "vitest run"},
                     {"targets": {"test": marked(VITEST_JUNIT_FLAG_ENTRY)}})
        drive = self.gate()
        self.assert_whole_suite_is_the_marked_script(drive, "test")
        self.assert_green_with_one_coverage_not_measured_warning(drive)


if __name__ == "__main__":
    unittest.main()
