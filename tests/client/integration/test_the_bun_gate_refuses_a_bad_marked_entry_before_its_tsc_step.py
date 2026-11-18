"""The bun gate refuses a marked entry it cannot run before its tsc step.

`pre-merge-gate` reads the entry marked `"test": true` where it reads the old
keys, before its tsc step. Each of these refuses the gate: a non-zero exit,
ONE `target-refused` envelope under `pre-merge-gate`, no `tsc` spawned (no
spawn at all) and nothing posted:

- a marker `test` refuses: a marker of `"true"` or `1`; a marked script
  missing from `scripts`; a marked script whose body is empty (two marked
  entries and a marker of `false` are pinned beside the gate-frameworks
  tests). Here the gate's detail EQUALS the one `test` gives for the same
  package;
- a marked entry whose own table entry is refused: `junit: "file"`; both
  `stream` and `junit`;
- a marked entry keyed `test:e2e`, a tier the gate excludes: the detail
  names `test:e2e`, the `e2e` tier, and that `regression` runs it, while
  `regression` on the same package does run it.

Every test drives the REAL `clients/bun-crucible.py` as an OS subprocess, the
gate WITHOUT `--skip-check`, with the stand-in `bun` of the gate-frameworks
tests (which answers `x tsc` with a clean typecheck and records every spawn).

TIER: integration (a TCP listener and spawned client processes).
"""

import re
import unittest

from tests.client.bun_targets_harness import TABLE
from tests.client.integration.test_the_bun_gate_runs_every_declared_frameworks_suite import (
    _GateFrameworksCase,
)
from tests.client.live_run_harness import STREAM_CODEC
from tests.client.the_bun_gate_runs_every_declared_frameworks_suite_helpers import (
    BUN_TEST_ENTRY,
    GATE,
    VITEST_JUNIT_ENV_ENTRY,
    VITEST_STREAM_ENTRY,
    assert_gate_refused_before_its_tsc_step,
    assert_gate_refused_with_tests_detail,
)

UNIT = "test:unit"
E2E = "test:e2e"
# The `e2e` tier named on its own, not only inside the key `test:e2e`.
E2E_TIER = re.compile(r"(?<![:\w])e2e\b")


def marked(entry: dict, marker: object = True) -> dict:
    """`entry` carrying the `test` marker `marker` (any JSON value)."""
    return {**entry, "test": marker}


class ARefusedMarkerRefusesTheGateBeforeItsTscStepTest(_GateFrameworksCase):

    def refused_gate(self, scripts, targets, *named):
        """Refused before the tsc step, with `test`'s detail."""
        self.declare(scripts, {"targets": targets})
        drive = self.drive(GATE)
        assert_gate_refused_with_tests_detail(self, drive, TABLE, *named)

    def test_a_marker_that_is_the_string_true_refuses_the_gate(self):
        self.refused_gate({UNIT: "bun test tests/unit"},
                          {UNIT: marked(BUN_TEST_ENTRY, "true")}, UNIT)

    def test_a_marker_that_is_the_number_one_refuses_the_gate(self):
        self.refused_gate({UNIT: "bun test tests/unit"},
                          {UNIT: marked(BUN_TEST_ENTRY, 1)}, UNIT)

    def test_a_marked_script_missing_from_scripts_refuses_the_gate(self):
        self.refused_gate({UNIT: "bun test tests/unit"},
                          {"test:absent": marked(BUN_TEST_ENTRY)}, "test:absent")

    def test_a_marked_script_with_an_empty_body_refuses_the_gate(self):
        self.refused_gate({UNIT: "bun test tests/unit", "test:empty": ""},
                          {"test:empty": marked(BUN_TEST_ENTRY)}, "test:empty")


class ARefusedMarkedEntryRefusesTheGateBeforeItsTscStepTest(_GateFrameworksCase):

    def test_a_marked_entry_whose_junit_is_file_refuses_the_gate(self):
        """`junit: "file"` is neither `flag` nor `env:<VAR>`."""
        self.declare({UNIT: "vitest run"},
                     {"targets": {UNIT: marked({"framework": "vitest", "junit": "file"})}})
        drive = self.drive(GATE)
        detail = assert_gate_refused_before_its_tsc_step(self, drive, TABLE, UNIT)
        self.assertIn("junit", detail, f"the refusal names the field at fault; detail={detail!r}")

    def test_a_marked_entry_declaring_both_stream_and_junit_refuses_the_gate(self):
        entry = {**VITEST_STREAM_ENTRY, "junit": "flag"}
        self.assertEqual(entry["stream"]["codec"], STREAM_CODEC)
        self.declare({UNIT: "vitest run"}, {"targets": {UNIT: marked(entry)}})
        drive = self.drive(GATE)
        detail = assert_gate_refused_before_its_tsc_step(self, drive, TABLE, UNIT)
        for field in ("stream", "junit"):
            self.assertIn(field, detail, f"detail={detail!r}")


class AMarkedEntryTheGateExcludesRefusesTheGateTest(_GateFrameworksCase):

    def setUp(self):
        super().setUp()
        self.declare({E2E: "vitest run e2e"},
                     {"targets": {E2E: marked(VITEST_JUNIT_ENV_ENTRY)}})

    def test_a_marked_test_e2e_entry_refuses_the_gate_naming_the_key_the_tier_and_regression(self):
        """The gate refuses before its tsc step; the detail names `test:e2e`,
        the `e2e` tier and `regression`."""
        drive = self.drive(GATE)
        detail = assert_gate_refused_before_its_tsc_step(self, drive, E2E, "regression")
        self.assertRegex(detail, E2E_TIER,
                         f"the refusal names the `e2e` tier itself; detail={detail!r}")

    def test_regression_on_the_same_package_runs_the_marked_test_e2e_script(self):
        """`regression` still runs it: `bun run test:e2e` once, green."""
        drive = self.drive("regression")
        self.assert_ran_once_by_its_own_script(drive, E2E)
        self.assertEqual(self.whole_suite_spawns(), [], f"spawns={self.spawns()!r}")
        self.assertEqual(drive.returncode, 0, drive.diag())
        self.assertIs(self.envelope(drive).get("ok"), True, drive.diag())


if __name__ == "__main__":
    unittest.main()
