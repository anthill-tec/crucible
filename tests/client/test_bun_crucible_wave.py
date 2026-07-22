"""CR-CRU-031 cycle 2 (cycle id 53) -- CLIENT contract: `plan-backfill` verb (S2)
and explicit `--wave` on `plan-file` (S3).

Contract pinned verbatim from
docs/changes/CR-CRU-031-wave-classification-fix.md:

  S2 -- "Add `plan-backfill --wave <n> [--cr <CR>]` to `bun-crucible.py`:
  resolves the target plan (single plan, or `--cr` to disambiguate) and
  PATCHes its wave via S1. Prints the assigned wave. `--cr` unresolvable /
  no plan -> non-zero + error."

  S3 -- "`plan-file` gains a `--wave <n>` flag; resolution is `--wave` >
  `WORKFLOW_WAVE` env. A `plan-file` with neither resolvable still files (no
  hard block) but is the prevention lever so the orchestrator can pass wave
  explicitly."

  AC2 -- "`bun-crucible.py plan-backfill --wave 4 --cr CR-CRU-021` PATCHes
  plan 4's wave; re-fetch shows `wave:"4"`; a no-resolvable-target call ->
  non-zero + error."

  AC3 -- "`plan-file --wave 5` files a plan with `wave:"5"` regardless of
  `WORKFLOW_WAVE`; `--wave` overrides the env when both set."

RED phase: as of this writing `clients/bun-crucible.py` has NO `plan-backfill`
subcommand at all (confirmed by reading the argparse wiring in `main()` --
only register/unregister/test/regression/auto-ingest/check/pre-merge-gate/
plan-file/cycle-activate/cycle-done/cr-close/gate-run/gate-report/milestone
exist), so every `plan-backfill` invocation below fails at argparse's
`parse_args()` with an "invalid choice" `SystemExit(2)` -- a real RED (the
verb does not exist yet), not a typo.

`cmd_plan_file`'s POST payload today is built as
`{"cr": args.cr, "cycles": [...]}` plus optional `title`/`track`/
`orchestrator` -- there is no `wave` key anywhere in the function body and no
`--wave` flag on the `plan-file` subparser, so every wave-resolution test
below fails on the payload assertion (`wave` key absent) even though the
command itself runs and exits 0 -- also a real behavioral RED.

Module-loading + HTTP-mocking convention: copied verbatim from the sibling
`test_bun_crucible_toon_envelope.py` / `test_bun_crucible_gates.py` harnesses
in this same directory -- REPO_ROOT-relative load of `clients/bun-crucible.py`
(the in-repo SOURCE OF TRUTH, CR-CRU-008 Risk section), real `argparse`
dispatch via `module.main()` with `sys.argv` patched, and mocking the
module's `_post`/`_get`/`_patch` HTTP transport seams -- this cycle's
constraint requires the live server at :3849 is NEVER touched (no dogfood
pollution).

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_wave.py -q
Fallback:
    python3 tests/client/test_bun_crucible_wave.py
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
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_wave", SCRIPT_PATH)
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


class _BaseWaveTest(unittest.TestCase):
    """Shared tmp-project-dir + WORKFLOW_* env isolation (matches the sibling
    envelope-test harness in this directory)."""

    PROJECT_KEY = "test-key-override-me"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-wave-")
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


# == S2: `plan-backfill --wave <n> [--cr <CR>]` ==============================


class PlanBackfillTest(_BaseWaveTest):
    PROJECT_KEY = "test-key-wave-backfill"

    def test_single_plan_resolves_without_cr_and_patches_wave_only(self):
        """Exactly one plan exists -- no --cr needed. The PATCH body must carry
        ONLY {"wave": ...}, never a `status` key (S1: a wave-only body is what
        makes the backfill closed-plan-safe)."""
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans) as mock_get, \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}) as mock_patch:
            code, out, err = _run_main(self.module, [
                "plan-backfill", "--wave", "4", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"expected success exit 0; stdout={out!r} stderr={err!r}")
        mock_get.assert_called_once()
        mock_patch.assert_called_once()
        (patch_path, patch_payload), _kwargs = mock_patch.call_args[0], mock_patch.call_args[1]
        self.assertTrue(patch_path.endswith("/plans/plan-4"),
                         f"PATCH must target the resolved plan's id; got path={patch_path!r}")
        self.assertEqual(set(patch_payload.keys()), {"wave"},
                          f"PATCH body must carry ONLY `wave`, never `status` "
                          f"(closed-plan-safe backfill); got {patch_payload!r}")
        self.assertEqual(str(patch_payload["wave"]), "4")

        # "Prints the assigned wave" -- the established stdout channel in this
        # file is the TOON AXI envelope; assert the assigned wave surfaces there.
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-backfill")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(str(axi.get("wave")), "4")

    def test_closed_plan_is_a_valid_backfill_target(self):
        """S1: PATCH wave-only is allowed on OPEN *and* CLOSED plans -- the
        whole point of a backfill is correcting an already-merged plan's
        wave (S4's CR-CRU-021 use case). A resolver that filters to
        status=="open" only (like `_open_plans`/cr-close) would find ZERO
        plans here and wrongly report a no-resolvable-target error."""
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}) as mock_patch:
            code, out, err = _run_main(self.module, [
                "plan-backfill", "--wave", "4", "--cr", "CR-CRU-021",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"a CLOSED plan must be a valid backfill target; "
                                  f"stdout={out!r} stderr={err!r}")
        mock_patch.assert_called_once()
        patch_path = mock_patch.call_args[0][0]
        self.assertTrue(patch_path.endswith("/plans/plan-4"))

    def test_cr_flag_disambiguates_among_multiple_plans(self):
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}) as mock_patch:
            code, out, err = _run_main(self.module, [
                "plan-backfill", "--wave", "4", "--cr", "CR-CRU-021",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        mock_patch.assert_called_once()
        patch_path, patch_payload = mock_patch.call_args[0]
        # POSITIVE: the NAMED plan gets patched.
        self.assertTrue(patch_path.endswith("/plans/plan-4"),
                         f"--cr CR-CRU-021 must resolve to plan-4, not the other plan; "
                         f"got path={patch_path!r}")
        self.assertEqual(str(patch_payload["wave"]), "4")
        # NEGATIVE bound: plan-9 (the other plan) must never be touched.
        for call in mock_patch.call_args_list:
            self.assertNotIn("plan-9", call[0][0],
                              "the non-matching plan must never be PATCHed")

    def test_unknown_cr_is_non_resolvable_and_returns_nonzero_with_error(self):
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}) as mock_patch:
            code, out, err = _run_main(self.module, [
                "plan-backfill", "--wave", "4", "--cr", "CR-CRU-999-NOPE",
                "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, "an unresolvable --cr must be non-zero")
        mock_patch.assert_not_called()
        combined = out + err
        self.assertTrue(
            "error" in combined.lower() or "CR-CRU-999-NOPE" in combined,
            f"an unresolvable --cr must surface SOME error signal; got stdout={out!r} "
            f"stderr={err!r}",
        )
        # An argparse-level "invalid choice" (the verb not existing at all)
        # would ALSO satisfy the two checks above -- pin the established
        # per-file convention (every verb, including its error paths, emits
        # an ok=False TOON AXI envelope on stdout; see register/unregister/
        # plan-file/cr-close) so this test actually discriminates "verb
        # missing" from "verb wired but errors correctly".
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-backfill")
        self.assertIs(axi.get("ok"), False)

    def test_no_plans_at_all_is_non_resolvable_and_returns_nonzero_with_error(self):
        with mock.patch.object(self.module, "_get", return_value=_plans_response([])), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}) as mock_patch:
            code, out, err = _run_main(self.module, [
                "plan-backfill", "--wave", "4", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, "no plan at all must be a non-resolvable-target error")
        mock_patch.assert_not_called()
        self.assertTrue(len(out) + len(err) > 0, "an error path must print SOMETHING")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-backfill")
        self.assertIs(axi.get("ok"), False)

    def test_ambiguous_multiple_plans_without_cr_returns_nonzero_and_does_not_patch(self):
        """Two plans, no --cr to disambiguate -- resolution can't pick a
        SINGLE target, so this must fail closed rather than guess."""
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_patch", return_value={"ok": True}) as mock_patch:
            code, out, err = _run_main(self.module, [
                "plan-backfill", "--wave", "4", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0,
                             "ambiguous (2 plans, no --cr) must be non-zero, not a guess")
        mock_patch.assert_not_called()
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-backfill")
        self.assertIs(axi.get("ok"), False)

    def test_backfill_failure_response_still_reports_nonzero(self):
        """The server PATCH itself can fail (e.g. unknown planId -> 404, S1) --
        the client must surface that as non-zero + an ok=False envelope, not
        silently succeed."""
        plans = _plans_response([
            {"planId": "plan-4", "cr": "CR-CRU-021", "status": "closed", "cycles": []},
        ])
        with mock.patch.object(self.module, "_get", return_value=plans), \
             mock.patch.object(self.module, "_patch",
                               return_value={"ok": False, "error": "plan not found"}):
            code, out, err = _run_main(self.module, [
                "plan-backfill", "--wave", "4", "--project-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-backfill")
        self.assertIs(axi.get("ok"), False)


# == S3: explicit `--wave` on `plan-file` ====================================


class PlanFileWaveTest(_BaseWaveTest):
    PROJECT_KEY = "test-key-wave-planfile"

    def _post_payload(self, mock_post):
        mock_post.assert_called_once()
        return mock_post.call_args[0][1]

    def test_wave_flag_files_plan_with_that_wave(self):
        server_resp = {"ok": True, "planId": "plan-77", "cr": "CR-X",
                        "cycles": [{"label": "a", "id": 101}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-X", "--cycles", "a", "--wave", "5",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = self._post_payload(mock_post)
        self.assertIn("wave", payload, "plan-file --wave 5 must SEND wave in the POST body")
        self.assertEqual(str(payload["wave"]), "5")

    def test_workflow_wave_env_used_when_flag_absent(self):
        os.environ["WORKFLOW_WAVE"] = "4"
        server_resp = {"ok": True, "planId": "plan-78", "cr": "CR-X",
                        "cycles": [{"label": "a", "id": 102}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-X", "--cycles", "a",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = self._post_payload(mock_post)
        self.assertIn("wave", payload,
                      "WORKFLOW_WAVE must backfill the wave when --wave is omitted")
        self.assertEqual(str(payload["wave"]), "4")

    def test_wave_flag_overrides_workflow_wave_env_when_both_set(self):
        os.environ["WORKFLOW_WAVE"] = "9"
        server_resp = {"ok": True, "planId": "plan-79", "cr": "CR-X",
                        "cycles": [{"label": "a", "id": 103}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-X", "--cycles", "a", "--wave", "5",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = self._post_payload(mock_post)
        self.assertEqual(str(payload["wave"]), "5",
                          "--wave must take precedence over WORKFLOW_WAVE when both are set")
        # NEGATIVE: the env value must not leak through instead.
        self.assertNotEqual(str(payload.get("wave")), "9")

    def test_neither_flag_nor_env_files_wave_less_without_a_hard_block(self):
        """S3: 'A plan-file with neither resolvable still files (no hard
        block)' -- the command must still succeed, just without a `wave`
        key in the payload at all (never a null/empty placeholder)."""
        server_resp = {"ok": True, "planId": "plan-80", "cr": "CR-X",
                        "cycles": [{"label": "a", "id": 104}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-X", "--cycles", "a",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0,
                          "a wave-less plan-file must still succeed (no hard block)")
        payload = self._post_payload(mock_post)
        self.assertNotIn("wave", payload,
                          f"neither --wave nor WORKFLOW_WAVE set -- payload must carry NO "
                          f"wave key at all; got {payload!r}")

    def test_wave_flag_does_not_disturb_existing_payload_fields(self):
        """Regression guard: adding `wave` must not clobber the pre-existing
        cr/cycles/title/track/orchestrator fields `cmd_plan_file` already
        sends."""
        os.environ["WORKFLOW_ROLE"] = "Track 2"
        server_resp = {"ok": True, "planId": "plan-81", "cr": "CR-Z",
                        "cycles": [{"label": "a", "id": 105}, {"label": "b", "id": 106}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-Z", "--cycles", "a,b",
                "--title", "Some Title", "--wave", "7",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = self._post_payload(mock_post)
        self.assertEqual(payload.get("cr"), "CR-Z")
        self.assertEqual(payload.get("cycles"), [{"label": "a"}, {"label": "b"}])
        self.assertEqual(payload.get("title"), "Some Title")
        self.assertEqual(payload.get("track"), "Track 2")
        self.assertEqual(str(payload.get("wave")), "7")


# == C6 VERIFY-fix: §S3 `no-wave` warning (CR-CRU-030 AC line 267) ===========


class PlanFileNoWaveWarningTest(_BaseWaveTest):
    """§S3 `no-wave` warning (CR-CRU-030 C6 VERIFY-fix, AC line 267): a
    `plan-file` with neither `--wave` nor `WORKFLOW_WAVE` resolvable must emit
    a `no-wave` warning (envelope `warnings[]` + stderr) naming the CR being
    filed; with either resolvable -> no `no-wave` warning fires, and the wave
    is still carried exactly as `PlanFileWaveTest` above already proves.

    RED: `cmd_plan_file` in bun-crucible.py (confirmed by reading the function
    body) builds `warnings = []` unconditionally and passes that empty list to
    `_emit_axi` on EVERY call -- there is no no-wave detection at all, so the
    warning-presence assertions below fail against the CURRENT baseline (an
    always-empty `warnings[]` and no matching stderr line)."""

    PROJECT_KEY = "test-key-wave-no-wave-warning"

    def test_neither_wave_nor_env_emits_no_wave_warning_naming_the_cr(self):
        server_resp = {"ok": True, "planId": "plan-90", "cr": "CR-CRU-090",
                        "cycles": [{"label": "a", "id": 900}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-CRU-090", "--cycles", "a",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0,
                          f"a wave-less plan-file must still file (no hard block); "
                          f"stdout={out!r} stderr={err!r}")
        mock_post.assert_called_once()
        payload = mock_post.call_args[0][1]
        self.assertNotIn("wave", payload,
                          "with neither --wave nor WORKFLOW_WAVE resolvable, the "
                          "payload must still carry NO wave key at all")

        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn("no-wave", codes,
                      f"plan-file with no resolvable wave must carry a `no-wave` "
                      f"warning; got {axi!r}")
        detail = " ".join(w.get("detail", "") for w in axi.get("warnings", [])
                           if w.get("code") == "no-wave")
        self.assertIn("CR-CRU-090", detail,
                      f"the no-wave warning must NAME the CR being filed; "
                      f"got detail={detail!r}")
        self.assertIn("no-wave", err, "the no-wave warning must also surface on stderr")
        self.assertIn("CR-CRU-090", err,
                       "stderr must name the CR being filed, not just the code")

    def test_wave_flag_present_omits_no_wave_warning(self):
        server_resp = {"ok": True, "planId": "plan-91", "cr": "CR-CRU-091",
                        "cycles": [{"label": "a", "id": 901}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-CRU-091", "--cycles", "a", "--wave", "5",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = mock_post.call_args[0][1]
        self.assertEqual(str(payload.get("wave")), "5")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-wave", codes,
                          f"--wave resolves the wave -- no no-wave warning should "
                          f"fire; got {axi!r}")
        self.assertNotIn("no-wave", err)

    def test_workflow_wave_env_present_omits_no_wave_warning(self):
        os.environ["WORKFLOW_WAVE"] = "4"
        server_resp = {"ok": True, "planId": "plan-92", "cr": "CR-CRU-092",
                        "cycles": [{"label": "a", "id": 902}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-CRU-092", "--cycles", "a",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = mock_post.call_args[0][1]
        self.assertEqual(str(payload.get("wave")), "4")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-wave", codes,
                          f"WORKFLOW_WAVE resolves the wave -- no no-wave warning "
                          f"should fire; got {axi!r}")
        self.assertNotIn("no-wave", err)

    def test_wave_flag_overrides_env_and_still_omits_no_wave_warning(self):
        os.environ["WORKFLOW_WAVE"] = "9"
        server_resp = {"ok": True, "planId": "plan-93", "cr": "CR-CRU-093",
                        "cycles": [{"label": "a", "id": 903}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-CRU-093", "--cycles", "a", "--wave", "5",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = mock_post.call_args[0][1]
        self.assertEqual(str(payload.get("wave")), "5", "--wave must win over WORKFLOW_WAVE")
        self.assertNotEqual(str(payload.get("wave")), "9")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-wave", codes)
        self.assertNotIn("no-wave", err)


# == CR-CRU-037 §S2 -- `no-title` warning (mirrors §S3 `no-wave` guard) ======


class PlanFileNoTitleWarningTest(_BaseWaveTest):
    """CR-CRU-037 §S2: a `plan-file` invoked with NO `--title` must emit a
    `no-title` warning (envelope `warnings[]` + stderr) naming the CR being
    filed, mirroring `PlanFileNoWaveWarningTest` above -- the plan STILL
    files (title is optional; the orchestrator is just warned). With
    `--title` supplied -> no `no-title` warning fires.

    RED: `cmd_plan_file` in bun-crucible.py (confirmed by reading the
    function body) builds `warnings = []` and only ever appends a `no-wave`
    entry -- there is no no-title detection at all, so the warning-presence
    assertion below fails against the CURRENT baseline (an empty/no-title-free
    `warnings[]` and no matching stderr line)."""

    PROJECT_KEY = "test-key-wave-no-title-warning"

    def test_no_title_flag_emits_no_title_warning_naming_the_cr(self):
        server_resp = {"ok": True, "planId": "plan-94", "cr": "CR-CRU-094",
                        "cycles": [{"label": "a", "id": 904}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-CRU-094", "--cycles", "a",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0,
                          f"a title-less plan-file must still file (no hard block); "
                          f"stdout={out!r} stderr={err!r}")
        payload = mock_post.call_args[0][1]
        self.assertNotIn("title", payload,
                          "with no --title, the payload must carry NO title key at all")

        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn("no-title", codes,
                      f"plan-file with no --title must carry a `no-title` "
                      f"warning; got {axi!r}")
        detail = " ".join(w.get("detail", "") for w in axi.get("warnings", [])
                           if w.get("code") == "no-title")
        self.assertIn("CR-CRU-094", detail,
                      f"the no-title warning must NAME the CR being filed; "
                      f"got detail={detail!r}")
        self.assertIn("no-title", err, "the no-title warning must also surface on stderr")
        self.assertIn("CR-CRU-094", err,
                       "stderr must name the CR being filed, not just the code")

    def test_title_flag_present_omits_no_title_warning(self):
        server_resp = {"ok": True, "planId": "plan-95", "cr": "CR-CRU-095",
                        "cycles": [{"label": "a", "id": 905}]}
        with mock.patch.object(self.module, "_post", return_value=server_resp) as mock_post:
            code, out, err = _run_main(self.module, [
                "plan-file", "--cr", "CR-CRU-095", "--cycles", "a",
                "--title", "Some Title", "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = mock_post.call_args[0][1]
        self.assertEqual(payload.get("title"), "Some Title")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-title", codes,
                          f"--title resolves the title -- no no-title warning "
                          f"should fire; got {axi!r}")
        self.assertNotIn("no-title", err)


if __name__ == "__main__":
    unittest.main()
