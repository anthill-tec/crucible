"""The helpers of `test_the_bun_gate_runs_every_declared_frameworks_suite.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""


from tests.client.bun_targets_harness import (
    JUNIT_VAR,
    STREAM_PATH_DECLARATION,
)
from tests.client.live_run_harness import STREAM_CODEC


GATE = "pre-merge-gate"


BUN_CLIENT_NAME = "bun-crucible.py"

WHOLE_SUITE_LABEL = "the whole bun suite this gate ran"

COVERAGE_NOT_MEASURED = "coverage-not-measured"


SCRIPT_CASES = 2

VITEST_JUNIT_ENV_ENTRY = {"framework": "vitest", "junit": f"env:{JUNIT_VAR}"}

VITEST_JUNIT_FLAG_ENTRY = {"framework": "vitest", "junit": "flag"}

VITEST_STREAM_ENTRY = {"framework": "vitest",
                       "stream": {"codec": STREAM_CODEC,
                                  "path": STREAM_PATH_DECLARATION}}

BUN_TEST_ENTRY = {"framework": "bun-test", "junit": "flag"}


TARGET_REFUSED = "target-refused"


def assert_gate_refused_before_its_tsc_step(case, drive, *named):
    """A gate refused on its `crucible.targets` before its tsc step: a
    non-zero exit, nothing posted, nothing spawned (the tsc step included),
    and ONE `ok: false` envelope under `pre-merge-gate` carrying exactly one
    `target-refused` warning whose detail names each of `named`. Returns that
    detail."""
    case.assertNotEqual(drive.returncode, 0, f"a refused gate exits non-zero; {drive.diag()}")
    case.assertEqual(case.spawns(), [],
                     f"the refusal comes before the tsc step, so nothing is spawned; "
                     f"{drive.diag()}")
    case.assertEqual(case.board.posts(), [],
                     f"a refused gate posts nothing; {drive.diag()}")
    envelope = case.envelope(drive)
    case.assertEqual((envelope.get("verb"), envelope.get("ok")), (GATE, False),
                     f"the refusal is the gate's own ok:false envelope; envelope={envelope!r}")
    refused = [w for w in envelope.get("warnings") or []
               if isinstance(w, dict) and w.get("code") == TARGET_REFUSED]
    case.assertEqual(len(refused), 1,
                     f"exactly one {TARGET_REFUSED} warning; envelope={envelope!r}")
    detail = str((refused or [{}])[0].get("detail"))
    for name in named:
        case.assertIn(name, detail, f"the refusal names {name!r}; detail={detail!r}")
    return detail


def assert_gate_refused_with_tests_detail(case, drive, *named):
    """A gate refused on its marker before its tsc step (as above), whose
    `target-refused` detail EQUALS the one `test` gives for the same
    package."""
    gate_detail = assert_gate_refused_before_its_tsc_step(case, drive, *named)
    test_drive = case.drive("test")
    case.assertNotEqual(test_drive.returncode, 0, test_drive.diag())
    envelope = case.envelope(test_drive)
    case.assertEqual((envelope.get("verb"), envelope.get("ok")), ("test", False),
                     f"envelope={envelope!r}")
    refused = [w.get("detail") for w in envelope.get("warnings") or []
               if isinstance(w, dict) and w.get("code") == TARGET_REFUSED]
    case.assertEqual(len(refused), 1,
                     f"`test` gives one {TARGET_REFUSED} warning; envelope={envelope!r}")
    case.assertEqual(gate_detail, (refused or [None])[0],
                     f"the gate refuses with test's detail for the same package; "
                     f"gate={drive.diag()} test={test_drive.diag()}")
