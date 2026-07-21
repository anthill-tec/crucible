"""CR-CRU-030 §S7 (cycle 83, C1 slice 2) -- the net-new `checkpoint` / `stop` /
`abort` client verbs, re-pointed from CR-008 at the real CR-CRU-024 server
routes.

Contract pinned verbatim from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S7 -- "CR-CRU-024 adds three server verbs -- `checkpoint`
  (`POST …/plans/<id>/checkpoint`), project `stop`
  (`POST …/projects/<key>/stop`), and `abort`
  (`POST …/plans/<id>/abort`, `userApproved`-gated) ... Add `checkpoint` /
  `stop` / `abort` verbs to the shared client verb set (all five clients),
  each returning the §S1 TOON-AXI envelope ... `abort` carries
  `--user-approved` (maps to the body's `userApproved:true`) so the
  discouraging 409 path stays reachable by default."

  AC (verbatim) -- "`checkpoint`, `stop`, `abort` (`--user-approved`) exist on
  all five clients, each POSTing the CR-024 server route and returning a
  `toon.py`-decodable envelope; `abort` without `--user-approved` surfaces the
  server's discouraging 409 (envelope `ok:false` + help), with it executes."

Server contract confirmed by reading src/v2.ts directly:
  - `handlePlanCheckpoint`: POST …/plans/<id>/checkpoint -> {ok:true, changed}
    (unknown plan -> 404).
  - `handlePlanAbort`: the approval gate is checked BEFORE plan existence --
    a body without `userApproved: true` -> 409 "aborting discards a declared
    workflow -- explicit user approval is required; refused" for ANY plan
    (even unknown); WITH `userApproved: true` -> {ok:true, changed:true, plan}
    (unknown plan -> 404 only reached past the gate).
  - `handleProjectStop`: POST …/projects/<key>/stop -> {ok:true, checkpointed}
    (a project-level verb -- no plan targeting at all).

`checkpoint`/`abort` target a single plan but the CR text gives no `<id>`
positional (ids are opaque -- "never guess ids", the plan-7 incident) and no
new flag beyond `--user-approved`. This file therefore mirrors the resolution
convention already established for `cr-close`/`cycle-activate` (see
`_open_plans` in `clients/bun-crucible.py`): resolve the single OPEN plan, or
disambiguate via the EXISTING `--cr` flag already wired on `cr-close` /
`plan-file` / `plan-backfill` -- consistent with the orchestrator's
`/shutdown` emergency-flow use case (checkpoint/stop the CURRENTLY open work,
never a numeric plan id the caller doesn't have).

Note on the `_request` HTTP-error path (`clients/bun-crucible.py` `_request`):
today a non-2xx response is surfaced as `{"ok": False, "error": "HTTP <code>:
<raw body text>"}` -- the JSON body (and any `help[]` it carries) is NOT
re-parsed out into a structured field. Turning that into a genuinely
structured `help[]` envelope entry is §S13/§S15 (AXI-CLI conventions,
explicitly a LATER slice per the CR's build sequence) -- this file mocks
`_post` directly at that same granularity (an opaque error string) and pins
only what THIS slice owns: `ok:false` + non-zero exit on the 409 refusal.

RED phase: `clients/bun-crucible.py` today has NO `checkpoint`/`stop`/`abort`
subcommands at all -- confirmed by reading the argparse wiring in `main()`.
Every invocation below fails at argparse's `parse_args()` with an "invalid
choice" `SystemExit(2)` -- a real RED, not a typo.

Module-loading + HTTP-mocking convention: copied verbatim from the sibling
harnesses in this directory.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_workflow_verbs.py -q
Fallback:
    python3 tests/client/test_bun_crucible_workflow_verbs.py
"""

import contextlib
import copy
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
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_workflow", SCRIPT_PATH)
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


def _open_plans_response(plans):
    return {"ok": True, "plans": plans}


class _BaseWorkflowVerbTest(unittest.TestCase):
    PROJECT_KEY = "test-key-override-me"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-workflow-")
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

    def _post_recorder(self, calls, ok=True, error=None, extra=None):
        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            resp = {"ok": ok}
            if ok and extra:
                resp.update(extra)
            if not ok:
                resp["error"] = error or "boom"
            return resp
        return fake_post


# ── checkpoint -- POST …/plans/<id>/checkpoint ──


class CheckpointClientVerbTest(_BaseWorkflowVerbTest):
    PROJECT_KEY = "test-key-checkpoint"

    def test_checkpoint_resolves_single_open_plan_and_posts_to_checkpoint_route(self):
        plans = _open_plans_response([
            {"planId": "plan-7", "cr": "CR-Q", "status": "open", "cycles": []},
        ])
        calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(calls, ok=True,
                                                                extra={"changed": True})):
            code, out, err = _run_main(self.module, ["checkpoint", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(len(calls), 1)
        path, _payload = calls[0]
        self.assertTrue(path.endswith("/plans/plan-7/checkpoint"),
                         f"POST must target the resolved plan's checkpoint route; got {path!r}")

        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "checkpoint")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("plan"), "plan-7")
        self.assertIs(axi.get("changed"), True)

    def test_checkpoint_cr_flag_disambiguates_among_multiple_open_plans(self):
        plans = _open_plans_response([
            {"planId": "plan-7", "cr": "CR-Q", "status": "open", "cycles": []},
            {"planId": "plan-8", "cr": "CR-R", "status": "open", "cycles": []},
        ])
        calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(calls, ok=True,
                                                                extra={"changed": True})):
            code, out, err = _run_main(self.module, [
                "checkpoint", "--cr", "CR-R", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(len(calls), 1)
        path, _payload = calls[0]
        self.assertTrue(path.endswith("/plans/plan-8/checkpoint"),
                         f"--cr CR-R must resolve to plan-8, not the other plan; got {path!r}")
        self.assertNotIn("plan-7", path)

    def test_checkpoint_no_open_plan_returns_nonzero_without_posting(self):
        calls = []
        with mock.patch.object(self.module, "_get", return_value=_open_plans_response([])), \
             mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, ["checkpoint", "--project-dir", self.tmpdir])

        self.assertNotEqual(code, 0, "no open plan to checkpoint must be non-zero")
        self.assertEqual(calls, [])
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "checkpoint")
        self.assertIs(axi.get("ok"), False)

    def test_checkpoint_ambiguous_without_cr_returns_nonzero_without_posting(self):
        plans = _open_plans_response([
            {"planId": "plan-7", "cr": "CR-Q", "status": "open", "cycles": []},
            {"planId": "plan-8", "cr": "CR-R", "status": "open", "cycles": []},
        ])
        calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, ["checkpoint", "--project-dir", self.tmpdir])

        self.assertNotEqual(code, 0, "ambiguous (2 open plans, no --cr) must be non-zero")
        self.assertEqual(calls, [])
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)

    def test_checkpoint_server_failure_surfaces_as_nonzero(self):
        plans = _open_plans_response([
            {"planId": "plan-7", "cr": "CR-Q", "status": "open", "cycles": []},
        ])
        calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(calls, ok=False,
                                                                error="plan not found")):
            code, out, err = _run_main(self.module, ["checkpoint", "--project-dir", self.tmpdir])

        self.assertNotEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "checkpoint")
        self.assertIs(axi.get("ok"), False)


# ── stop -- POST …/projects/<key>/stop (project-level, no plan targeting) ──


class StopClientVerbTest(_BaseWorkflowVerbTest):
    PROJECT_KEY = "test-key-stop"

    def test_stop_posts_to_project_stop_route_and_returns_checkpointed_count(self):
        calls = []
        with mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(calls, ok=True,
                                                                extra={"checkpointed": 3})):
            code, out, err = _run_main(self.module, ["stop", "--project-dir", self.tmpdir])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(len(calls), 1)
        path, _payload = calls[0]
        self.assertEqual(path, f"/api/v2/projects/{self.PROJECT_KEY}/stop")

        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "stop")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("checkpointed"), 3)

    def test_stop_server_failure_surfaces_as_nonzero(self):
        calls = []
        with mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(calls, ok=False, error="boom")):
            code, out, err = _run_main(self.module, ["stop", "--project-dir", self.tmpdir])

        self.assertNotEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "stop")
        self.assertIs(axi.get("ok"), False)


# ── abort -- POST …/plans/<id>/abort ({userApproved}, --user-approved gated) ──


class AbortClientVerbTest(_BaseWorkflowVerbTest):
    PROJECT_KEY = "test-key-abort"

    def _single_open_plan(self):
        return _open_plans_response([
            {"planId": "plan-7", "cr": "CR-Q", "status": "open", "cycles": []},
        ])

    def test_abort_without_user_approved_flag_surfaces_409_refusal_as_ok_false(self):
        calls = []
        with mock.patch.object(self.module, "_get", return_value=self._single_open_plan()), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   calls, ok=False,
                                   error="HTTP 409: aborting discards a declared workflow — "
                                         "explicit user approval is required; refused")):
            code, out, err = _run_main(self.module, ["abort", "--project-dir", self.tmpdir])

        self.assertEqual(len(calls), 1, "abort must still POST (the 409 is a SERVER refusal)")
        path, payload = calls[0]
        self.assertTrue(path.endswith("/plans/plan-7/abort"))
        self.assertEqual(payload, {"userApproved": False},
                          "without --user-approved the body must NOT claim approval")

        self.assertNotEqual(code, 0, "the discouraging 409 must surface as non-zero")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "abort")
        self.assertIs(axi.get("ok"), False)

    def test_abort_with_user_approved_flag_executes_and_returns_ok_true(self):
        calls = []
        with mock.patch.object(self.module, "_get", return_value=self._single_open_plan()), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   calls, ok=True,
                                   extra={"changed": True,
                                          "plan": {"planId": "plan-7", "status": "aborted"}})):
            code, out, err = _run_main(self.module, [
                "abort", "--user-approved", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(len(calls), 1)
        path, payload = calls[0]
        self.assertTrue(path.endswith("/plans/plan-7/abort"))
        self.assertEqual(payload, {"userApproved": True},
                          "--user-approved must map to body userApproved:true")

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "abort")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("plan"), "plan-7")

    def test_abort_no_open_plan_returns_nonzero_without_posting(self):
        calls = []
        with mock.patch.object(self.module, "_get", return_value=_open_plans_response([])), \
             mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, [
                "abort", "--user-approved", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, "no open plan to abort must be non-zero")
        self.assertEqual(calls, [])
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)

    def test_abort_cr_flag_disambiguates_among_multiple_open_plans(self):
        plans = _open_plans_response([
            {"planId": "plan-7", "cr": "CR-Q", "status": "open", "cycles": []},
            {"planId": "plan-8", "cr": "CR-R", "status": "open", "cycles": []},
        ])
        calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(calls, ok=True,
                                                                extra={"changed": True})):
            code, out, err = _run_main(self.module, [
                "abort", "--user-approved", "--cr", "CR-R", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(len(calls), 1)
        path, _payload = calls[0]
        self.assertTrue(path.endswith("/plans/plan-8/abort"),
                         f"--cr CR-R must resolve to plan-8, not the other plan; got {path!r}")
        self.assertNotIn("plan-7", path)


if __name__ == "__main__":
    unittest.main()
