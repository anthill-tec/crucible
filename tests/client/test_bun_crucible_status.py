"""CR-CRU-030 §S6 (cycle 83, C1 slice 2) -- the net-new `status` (alias
`plans`) READ client verb.

Contract pinned verbatim from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S6 -- "Add a READ verb to the shared client verb set (all five clients) --
  `status` (alias `plans`), no `--agent` -- that GETs the plans and returns a
  §S1 TOON-AXI envelope: the queue as a `plans[]` table (`cr`, `wave`,
  `status`, active-cycle id/label, `mergeCommit`) plus a `lastRunCr`
  convenience field (the plan with the latest `closedAt`). Read-only."

  Dispatch note: "Full `--fields`/`count` AXI-CLI polish is a later slice --
  this slice pins the core status verb + the empty-state." -- so this file
  does NOT assert a `count` field or `--fields` narrowing (§S10/§S12, out of
  scope here); it pins only the core `plans[]` table + `lastRunCr` + the
  explicit (never-empty-stdout) empty-queue case.

Server response shape confirmed by reading src/v2.ts (`handlePlansList`) +
src/types.ts (`Plan`) directly: `GET …/plans` -> `{ok:true, plans: Plan[]}`
where each `Plan` carries `planId, cr, wave?, status, cycles: PlanCycle[],
merge?: {commit}, closedAt?`. `PlanCycle` carries `id, label, kind, status`.
The queue table's `mergeCommit` therefore derives from `plan.merge.commit`
(present only on a closed plan that was closed with a commit); "active-cycle
id/label" derives from scanning `plan.cycles` for `status === "active"`.

RED phase: `clients/bun-crucible.py` today has NO `status`/`plans` subcommand
at all -- confirmed by reading the argparse wiring in `main()`. Every
invocation below fails at argparse's `parse_args()` with an "invalid choice"
`SystemExit(2)` -- a real RED, not a typo.

Module-loading + HTTP-mocking convention: copied verbatim from the sibling
harnesses in this directory -- REPO_ROOT-relative load of
`clients/bun-crucible.py`, real `argparse` dispatch via `module.main()` with
`sys.argv` patched, and mocking the module's `_get` HTTP transport seam so the
live server at :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_status.py -q
Fallback:
    python3 tests/client/test_bun_crucible_status.py
"""

import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"


def _load_bun_crucible_module():
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_status", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    full_argv = ["bun-crucible.py"] + argv
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", full_argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _plans_response(plans):
    return {"ok": True, "plans": plans}


class _BaseStatusTest(unittest.TestCase):
    PROJECT_KEY = "test-key-status"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-status-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got {decoded!r} from stdout={stdout_text!r}")
        return decoded["axi"]

    def _row_for_cr(self, rows, cr):
        matches = [r for r in rows if r.get("cr") == cr]
        self.assertEqual(len(matches), 1, f"expected exactly one row for cr={cr!r} in {rows!r}")
        return matches[0]


class StatusQueueTableTest(_BaseStatusTest):
    PROJECT_KEY = "test-key-status-table"

    def test_status_returns_queue_table_with_core_fields_per_plan(self):
        plans = _plans_response([
            {"planId": "plan-1", "cr": "CR-A", "wave": "3", "status": "open",
             "cycles": [{"id": 10, "label": "c1", "kind": "red-green", "status": "pending"},
                        {"id": 11, "label": "c2", "kind": "red-green", "status": "active"}]},
            {"planId": "plan-2", "cr": "CR-B", "wave": "2", "status": "closed",
             "cycles": [{"id": 20, "label": "c1", "kind": "red-green", "status": "done"}],
             "merge": {"commit": "deadbee"}, "closedAt": 1000},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "status")
        self.assertIs(axi.get("ok"), True)

        rows = axi.get("plans")
        self.assertIsInstance(rows, list)
        self.assertEqual(len(rows), 2)

        row_a = self._row_for_cr(rows, "CR-A")
        self.assertEqual(row_a.get("wave"), "3")
        self.assertEqual(row_a.get("status"), "open")
        self.assertEqual(row_a.get("activeCycle"), {"id": 11, "label": "c2"},
                          f"activeCycle must identify the plan's single ACTIVE cycle; got {row_a!r}")
        self.assertIsNone(row_a.get("mergeCommit"),
                           "an OPEN plan (never closed) must not fabricate a mergeCommit")

        row_b = self._row_for_cr(rows, "CR-B")
        self.assertEqual(row_b.get("status"), "closed")
        self.assertEqual(row_b.get("mergeCommit"), "deadbee")
        self.assertIsNone(row_b.get("activeCycle"),
                           "a CLOSED plan (all cycles terminal) must not report an activeCycle")

    def test_status_lastruncr_is_the_plan_with_latest_closedat(self):
        plans = _plans_response([
            {"planId": "plan-1", "cr": "CR-OLD", "status": "closed", "cycles": [],
             "merge": {"commit": "aaa"}, "closedAt": 1000},
            {"planId": "plan-2", "cr": "CR-NEW", "status": "closed", "cycles": [],
             "merge": {"commit": "bbb"}, "closedAt": 5000},
            {"planId": "plan-3", "cr": "CR-OPEN", "wave": "4", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("lastRunCr"), "CR-NEW",
                          "lastRunCr must be the plan with the LATEST closedAt, not the "
                          "highest planId or list order")

    def test_status_no_closed_plans_lastruncr_is_none(self):
        plans = _plans_response([
            {"planId": "plan-1", "cr": "CR-OPEN", "wave": "1", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertIsNone(axi.get("lastRunCr"),
                           "no closed plan exists yet -- lastRunCr must be explicit null, "
                           "never a fabricated guess")

    def test_status_empty_queue_is_explicit_ok_true_not_error(self):
        with mock.patch.object(self.module, "_get", return_value=_plans_response([])):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, "an empty queue is NOT an error -- must exit 0")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("plans"), [])
        combined = (out + err).lower()
        self.assertIn("no plan", combined,
                      f"an empty queue must carry a DEFINITIVE empty-state message "
                      f"(never bare empty stdout); got stdout={out!r} stderr={err!r}")

    def test_status_surfaces_get_failure_as_ok_false(self):
        with mock.patch.object(self.module, "_get",
                                return_value={"ok": False, "error": "connection failed"}):
            code, out, err = _run_main(self.module, ["status", "--project-dir", self.tmpdir])

        self.assertNotEqual(code, 0, "a failed GET must surface as a non-zero exit")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "status")
        self.assertIs(axi.get("ok"), False)

    def test_plans_alias_invokes_the_same_status_verb(self):
        plans = _plans_response([
            {"planId": "plan-1", "cr": "CR-A", "wave": "1", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans):
            code, out, err = _run_main(self.module, ["plans", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"the `plans` alias must dispatch identically to `status`; "
                                  f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "status",
                          "an alias invocation must still report the canonical verb identity")
        self.assertEqual(len(axi.get("plans", [])), 1)


if __name__ == "__main__":
    unittest.main()
