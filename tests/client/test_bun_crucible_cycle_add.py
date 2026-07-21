"""CR-CRU-030 §S4 (cycle 83, C1 slice 2) -- the net-new `cycle-add` client verb.

Contract pinned verbatim from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S4 -- "The server supports `POST …/plans/<planId>/cycles` (append a cycle
  to an open plan) but NO client exposes it ... Add a `cycle-add <label>` verb
  to the shared client verb set (all five), returning the §S1 envelope with
  the assigned id."

  AC (verbatim) -- "`cycle-add \"<label>\"` posts `POST …/plans/<planId>/cycles`
  and returns the assigned id in the envelope; appending to a CLOSED/absent
  plan → non-zero + an error envelope."

Server contract confirmed by reading src/v2.ts (`handleCycleAppend`) +
src/store.ts (`appendCycle`) directly: the route rejects a CLOSED plan
SERVER-SIDE (`plan.status !== "open"` -> 400 "plan <id> is closed -- cannot
append cycles"), and a successful append responds
`{ok:true, changed:true, id, label, kind, status}` (PlanCycle shape, `id`
numeric, project-unique). This is the SAME rejection shape `plan-backfill`
(CR-CRU-031 §S2) already established for its own PATCH -- so `cycle-add`'s
plan RESOLUTION mirrors `cmd_plan_backfill` exactly (see
test_bun_crucible_wave.py `PlanBackfillTest`): resolve against ALL plans
(open AND closed) filtered by an optional `--cr`, POST regardless of the
resolved plan's status, and let the SERVER be the authority on "closed ->
reject" -- never pre-filter client-side to only-open (that would make the
"CLOSED plan" half of the AC unreachable). Zero/ambiguous matches are a
client-side resolution failure (no POST at all) -- the "absent" half of the
AC.

RED phase: `clients/bun-crucible.py` today (as of the C1 slice-1 GREEN,
`_crucible_axi.py` shared module + §S9 auto-attach) has NO `cycle-add`
subcommand at all -- confirmed by reading the argparse wiring in `main()`
(register/unregister/test/regression/auto-ingest/check/pre-merge-gate/
plan-file/plan-backfill/cycle-activate/cycle-done/cr-close/gate-run/
gate-report/milestone exist; `cycle-add` does not). Every invocation below
therefore fails at argparse's `parse_args()` with an "invalid choice"
`SystemExit(2)` -- a real RED, not a typo.

Module-loading + HTTP-mocking convention: copied verbatim from the sibling
`test_bun_crucible_wave.py` / `test_bun_crucible_toon_envelope.py` harnesses
in this same directory -- REPO_ROOT-relative load of `clients/bun-crucible.py`
(the in-repo SOURCE OF TRUTH, CR-CRU-008 Risk section, reaffirmed by CR-CRU-030
§S5's ownership boundary), real `argparse` dispatch via `module.main()` with
`sys.argv` patched, and mocking the module's `_post`/`_get` HTTP transport
seams so the live server at :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_cycle_add.py -q
Fallback:
    python3 tests/client/test_bun_crucible_cycle_add.py
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
    """Load clients/bun-crucible.py by file path (hyphenated filename can't be
    `import`ed normally) -- pointed at the REPO copy (the SOURCE OF TRUTH)."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_cycleadd", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched to `argv`. Returns
    (exit_code, stdout, stderr). Only SystemExit is caught -- any OTHER
    exception propagates so unittest reports it as an ERROR (still a valid
    RED signal)."""
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


class _BaseCycleAddTest(unittest.TestCase):
    """Shared tmp-project-dir + WORKFLOW_* env isolation (matches the sibling
    harnesses in this directory)."""

    PROJECT_KEY = "test-key-override-me"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-cycleadd-")
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


class CycleAddClientVerbTest(_BaseCycleAddTest):
    PROJECT_KEY = "test-key-cycleadd"

    def test_single_open_plan_resolves_without_cr_and_posts_label(self):
        plans = _plans_response([
            {"planId": "plan-9", "cr": "CR-X", "status": "open", "cycles": []},
        ])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   post_calls, ok=True,
                                   extra={"changed": True, "id": 301,
                                          "label": "extra-review", "kind": "red-green",
                                          "status": "pending"})):
            code, out, err = _run_main(self.module, [
                "cycle-add", "extra-review", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(len(post_calls), 1, f"expected exactly ONE cycle POST, got {post_calls}")
        path, payload = post_calls[0]
        self.assertTrue(path.endswith("/plans/plan-9/cycles"),
                         f"POST must target the resolved plan's cycles route; got path={path!r}")
        self.assertEqual(payload, {"label": "extra-review"},
                          f"POST body must carry ONLY the label; got {payload!r}")

        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-add")
        self.assertIs(axi.get("ok"), True)
        # POSITIVE: the assigned (server-generated) numeric id stays
        # machine-readable in the envelope -- the "never guess ids" contract.
        self.assertEqual(axi.get("id"), 301)
        self.assertEqual(axi.get("plan"), "plan-9")

    def test_cr_flag_disambiguates_among_multiple_plans(self):
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   post_calls, ok=True,
                                   extra={"changed": True, "id": 55, "label": "rework"})):
            code, out, err = _run_main(self.module, [
                "cycle-add", "rework", "--cr", "CR-CRU-030", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertEqual(len(post_calls), 1)
        path, _payload = post_calls[0]
        # POSITIVE: the NAMED plan gets the cycle appended.
        self.assertTrue(path.endswith("/plans/plan-9/cycles"),
                         f"--cr CR-CRU-030 must resolve to plan-9, not the other plan; "
                         f"got path={path!r}")
        # NEGATIVE bound: the non-matching plan must never be touched.
        self.assertNotIn("plan-4", path)

    def test_closed_plan_target_reaches_server_and_surfaces_rejection_as_ok_false(self):
        """A CLOSED plan resolved via --cr must still reach the POST (the
        server, not the client, is the authority on "closed -> reject" --
        mirrors `plan-backfill`'s `test_closed_plan_is_a_valid_backfill_target`
        resolution pattern). The server's real 400 body for this route is
        "plan <id> is closed -- cannot append cycles" (src/store.ts
        `appendCycle`)."""
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
        ])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post",
                               side_effect=self._post_recorder(
                                   post_calls, ok=False,
                                   error="plan 4 is closed — cannot append cycles")):
            code, out, err = _run_main(self.module, [
                "cycle-add", "rework", "--cr", "CR-CRU-021", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(len(post_calls), 1,
                          "a CLOSED plan must still be POSTed to (server-side rejection, "
                          f"not a client-side pre-filter); got {post_calls}")
        self.assertNotEqual(code, 0, "a closed-plan rejection must surface as non-zero")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-add")
        self.assertIs(axi.get("ok"), False)

    def test_unknown_cr_returns_nonzero_without_posting(self):
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "open", "cycles": []},
        ])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post", side_effect=self._post_recorder(post_calls)):
            code, out, err = _run_main(self.module, [
                "cycle-add", "rework", "--cr", "CR-CRU-999-NOPE", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, "an unresolvable --cr must be non-zero")
        self.assertEqual(post_calls, [], "no POST when the target plan can't be resolved")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-add")
        self.assertIs(axi.get("ok"), False)

    def test_no_plans_at_all_returns_nonzero_without_posting(self):
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=_plans_response([])), \
             mock.patch.object(self.module, "_post", side_effect=self._post_recorder(post_calls)):
            code, out, err = _run_main(self.module, [
                "cycle-add", "rework", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, "no plan at all ('absent') must be non-zero")
        self.assertEqual(post_calls, [])
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-add")
        self.assertIs(axi.get("ok"), False)

    def test_ambiguous_multiple_plans_without_cr_returns_nonzero_without_posting(self):
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        post_calls = []
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_post", side_effect=self._post_recorder(post_calls)):
            code, out, err = _run_main(self.module, [
                "cycle-add", "rework", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, "ambiguous (2 plans, no --cr) must be non-zero, not a guess")
        self.assertEqual(post_calls, [])
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)


if __name__ == "__main__":
    unittest.main()
