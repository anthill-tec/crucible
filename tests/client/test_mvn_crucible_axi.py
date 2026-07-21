"""CR-CRU-030 C4 RED -- migrate `clients/mvn-crucible.py` to the shared
TOON-AXI envelope module `clients/_crucible_axi.py`, mirroring the
bun-crucible.py reference (CR-CRU-030 C1/C2) and the already-migrated
python/rust clients (C3, commit 9a2b29a).

Contract pinned VERBATIM from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S2 -- "Apply CR-013's bun-client pattern ... to ... `mvn-crucible.py`,
  `arduino-crucible.py`: every AXI verb (register, unregister, plan-file,
  cycle-activate, cycle-done, cr-close, and the test/regression/auto-ingest
  ingest result, plus each stack's typecheck/compile gate) returns the §S1
  envelope. The ingest-verb envelopes carry `context` (cycleId included)."

  §S4/§S6/§S7/§S8 -- the net-new verbs (`cycle-add`, `status`/`plans`,
  `checkpoint`/`stop`/`abort`, `gate-run`/`gate-report`) must also exist on
  every client and return the §S1 envelope.

  §S9 -- ingest verbs (and `register`) auto-attach to the open plan's
  ACTIVE cycle when `WORKFLOW_CYCLE_ID` is unset; no active cycle is a HARD
  ERROR (`ok:false`, non-zero exit, no POST), never a silent orphan.

RED phase: `clients/mvn-crucible.py` today (confirmed by reading the source)
prints ad-hoc plain-text lines (`print(f"register: ok={...}")`), never
references `_crucible_axi` anywhere, and has NO plan-file / cycle-activate /
cycle-done / cr-close / cycle-add / status / checkpoint / stop / abort /
gate-run / gate-report / test / check subcommands at all -- `argparse` raises
`SystemExit(2)` ("invalid choice") for every one of them (the existing
`unit`/`module`/`compile`/`auto-ingest` verbs are the pre-migration toolchain
verbs; `test`/`check` are the fleet-uniform post-migration names per the
CR-CRU-030 C4 dispatch). Every test below therefore fails: either a decode of
plain (non-TOON) stdout, an `AttributeError` for a wrapper
(`_emit_axi`/`_axi_context`/`_get`/`_patch`) that does not exist yet, or
`SystemExit(2)` from an unknown subcommand -- all valid RED per the sub-agent
procedure (a missing-SUT-symbol/collection error is not skipped).

This file is deliberately THIN per the CR-CRU-030 C4 dispatch: the AXI-CLI
conventions themselves (§S10-§S15) are already exhaustively tested against the
shared module + the bun reference; this file only proves mvn-crucible.py is
correctly WIRED to that shared behavior plus its own toolchain (real Maven
Surefire JUnit via a fake `mvnw` wrapper substituted for the real `mvn`/Maven
Wrapper toolchain -- too heavy/not guaranteed installed in every CI sandbox --
so the ACTUAL maven binary invocation is stubbed by a tiny executable script
while everything downstream (report discovery, JUnit parsing, ingest,
envelope) is exercised for real, mirroring the rust `cargo nextest` stub).

Module-loading + HTTP-mocking convention copied verbatim from the sibling
python/rust test harnesses: load by file path via `importlib`, mock the
module's `_post`/`_get`/`_patch` HTTP transport seam so the live Crucible
server on :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_mvn_crucible_axi.py -q
Fallback:
    python3 tests/client/test_mvn_crucible_axi.py
"""

import contextlib
import importlib.util
import io
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "mvn-crucible.py"
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"

PASS_SUREFIRE_XML = (
    '<?xml version="1.0"?>'
    '<testsuite name="com.acme.FixtureTest" tests="1" failures="0">'
    '<testcase name="test_passes" time="0.001"/>'
    '</testsuite>'
)

_RELAY_MARKER = "mvn-gate-axi-relay-marker-999"
_FINAL_SNAPSHOT = (
    'run:\n'
    '  id: "gate-axi-mvn-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: ab12cd3\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
    'outcome: passed\n'
)
_FAKE_NO_MISTAKES_BODY = f'''
import sys

argv = sys.argv[1:]
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "status"):
    sys.stdout.write({_FINAL_SNAPSHOT!r})
    sys.exit(0)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''

# A fake `mvnw` substituted for the real Maven Wrapper: writes a Surefire
# JUnit report and exits 0, regardless of the goal it was invoked with --
# `_mvn_base()` prefers an executable `./mvnw` in the maven dir over `mvn`.
_FAKE_MVNW_TEST_BODY = '''#!/usr/bin/env python3
import os
os.makedirs(os.path.join("target", "surefire-reports"), exist_ok=True)
with open(os.path.join("target", "surefire-reports", "TEST-FixtureTest.xml"), "w") as f:
    f.write(%r)
print("[fake-mvnw] wrote surefire report")
''' % PASS_SUREFIRE_XML

# A fake `mvnw` that always fails compilation, regardless of goal.
_FAKE_MVNW_CHECK_BODY = '''#!/usr/bin/env python3
import sys
sys.stderr.write("[ERROR] /src/main/java/Bad.java:[3,1] ';' expected\\n")
sys.exit(1)
'''


def _write_fake_mvnw(maven_dir, body):
    path = os.path.join(maven_dir, "mvnw")
    with open(path, "w") as f:
        f.write(f"#!{sys.executable}\n")
        f.write(body)
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "mvn_crucible_under_test_axi")


def _load_axi_module():
    return _load_module(AXI_MODULE_PATH, "crucible_axi_under_test_for_mvn")


def _load_toon_module():
    return _load_module(TOON_PATH, "toon_under_test_for_mvn_axi")


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, stdout, stderr).
    Only SystemExit is caught -- any OTHER exception propagates so unittest
    reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["mvn-crucible.py"] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
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


def _post_call_for_path(post_mock, path):
    for call in post_mock.call_args_list:
        args, kwargs = call
        call_path = args[0] if args else kwargs.get("path")
        if call_path == path:
            return call
    return None


class _BaseMvnAxiTest(unittest.TestCase):
    PROJECT_KEY = "test-key-mvn-axi"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_client_module()
        self.toon = _load_toon_module()
        self.tmpdir = tempfile.mkdtemp(prefix="mvn-crucible-axi-")
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
                      f"'axi' key; got stdout={stdout_text!r}")
        return decoded["axi"]

    def _active_cycle_plans(self, active_id=901):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": active_id, "status": "active"},
                        {"id": active_id - 1, "status": "done"}]},
        ])

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-quiet", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 40, "status": "pending"}, {"id": 41, "status": "done"}]},
        ])


# ── §S1 wiring: mvn-crucible.py must delegate to the shared module ─────────


class MvnCrucibleWiredToSharedAxiModuleTest(_BaseMvnAxiTest):
    def test_source_references_the_shared_axi_module(self):
        source = SCRIPT_PATH.read_text()
        self.assertIn(
            "_crucible_axi", source,
            "mvn-crucible.py must import from the shared clients/_crucible_axi.py "
            "module (§S1) rather than keep a standalone duplicate envelope implementation",
        )

    def test_emit_axi_wrapper_produces_byte_identical_stdout_to_the_shared_emit_axi(self):
        axi_mod = _load_axi_module()
        call_args = ("register", True, {"agent": "CR-M-1"},
                     {"projectKey": "k1", "agentId": "CR-M-1"}, [])

        client_out = io.StringIO()
        with contextlib.redirect_stdout(client_out):
            self.module._emit_axi(*call_args)

        shared_out = io.StringIO()
        with contextlib.redirect_stdout(shared_out):
            axi_mod.emit_axi(*call_args)

        self.assertEqual(
            client_out.getvalue(), shared_out.getvalue(),
            "mvn-crucible.py's _emit_axi must produce BYTE-IDENTICAL stdout to "
            "the shared clients/_crucible_axi.py emit_axi()",
        )

    def test_axi_context_wrapper_produces_identical_output_to_the_shared_axi_context(self):
        axi_mod = _load_axi_module()
        os.environ["WORKFLOW_WAVE"] = "4"
        client_ctx = self.module._axi_context(
            self.tmpdir, agent_id="A1", cr="CR-Z", cycle_id=99)
        shared_ctx = axi_mod.axi_context(
            self.PROJECT_KEY, agent_id="A1", cr="CR-Z", cycle_id=99)
        self.assertEqual(
            client_ctx, shared_ctx,
            "mvn-crucible.py's _axi_context(project_dir, ...) must produce output "
            "IDENTICAL to the shared axi_context(project_key, ...) for the same "
            "resolved project_key",
        )


# ── Full verb-set envelope smoke test (one assertion set per verb) ─────────


class MvnCrucibleVerbEnvelopeTest(_BaseMvnAxiTest):
    def _run(self, argv, post_return=None, get_return=None, patch_return=None):
        post_return = post_return if post_return is not None else {"ok": True}
        with mock.patch.object(self.module, "_post", return_value=post_return,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=get_return,
                                create=True) as get_mock, \
             mock.patch.object(self.module, "_patch", return_value=patch_return,
                                create=True) as patch_mock:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock, get_mock, patch_mock

    def test_register_prints_toon_envelope(self):
        code, out, _err, _p, _g, _pa = self._run(
            ["register", "--agent", "CR-M-1", "--project-dir", self.tmpdir],
            get_return=self._active_cycle_plans())
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "register")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("context", {}).get("projectKey"), self.PROJECT_KEY)

    def test_unregister_prints_toon_envelope(self):
        code, out, _err, _p, _g, _pa = self._run(
            ["unregister", "--agent", "CR-M-1", "--project-dir", self.tmpdir])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "unregister")
        self.assertIs(axi.get("ok"), True)

    def test_plan_file_prints_toon_envelope_with_assigned_cycle_ids_and_context(self):
        os.environ["WORKFLOW_WAVE"] = "4"
        resp = {"ok": True, "planId": "plan-9", "cr": "CR-CRU-030",
                "cycles": [{"label": "a", "id": 901}]}
        code, out, _err, _p, _g, _pa = self._run(
            ["plan-file", "--cr", "CR-CRU-030", "--cycles", "a",
             "--project-dir", self.tmpdir], post_return=resp)
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-file")
        self.assertIs(axi.get("ok"), True)
        cycles = axi.get("cycles")
        self.assertEqual(cycles[0].get("id"), 901,
                          "the assigned numeric cycle id must stay machine-readable")
        context = axi.get("context", {})
        self.assertEqual(context.get("cr"), "CR-CRU-030")
        self.assertEqual(str(context.get("wave")), "4")

    def test_cycle_activate_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 901, "status": "pending"}]},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cycle-activate", "901", "--project-dir", self.tmpdir],
            get_return=plans, patch_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-activate")
        self.assertIs(axi.get("ok"), True)

    def test_cycle_done_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 901, "status": "active"}]},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cycle-done", "901", "--project-dir", self.tmpdir],
            get_return=plans, patch_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-done")
        self.assertIs(axi.get("ok"), True)

    def test_cr_close_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cr-close", "--commit", "abc1234", "--project-dir", self.tmpdir],
            get_return=plans, patch_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cr-close")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("context", {}).get("cr"), "CR-CRU-030")

    def test_cycle_add_prints_toon_envelope_with_assigned_id(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cycle-add", "new-cycle", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": True, "id": 991})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-add")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("id"), 991)

    def test_status_alias_plans_prints_toon_envelope_with_queue_table(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 901, "status": "active"}], "merge": None},
        ])
        for verb in ("status", "plans"):
            with self.subTest(verb=verb):
                code, out, _err, _p, _g, _pa = self._run(
                    [verb, "--project-dir", self.tmpdir], get_return=plans)
                self.assertEqual(code, 0, f"stdout={out!r}")
                axi = self._decode_axi(out)
                self.assertEqual(axi.get("verb"), "status",
                                  "the `plans` alias must still report verb=status")
                self.assertIs(axi.get("ok"), True)
                rows = axi.get("plans")
                self.assertEqual(rows[0].get("cr"), "CR-CRU-030")

    def test_checkpoint_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["checkpoint", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "checkpoint")
        self.assertIs(axi.get("ok"), True)

    def test_stop_prints_toon_envelope(self):
        code, out, _err, _p, _g, _pa = self._run(
            ["stop", "--project-dir", self.tmpdir],
            post_return={"ok": True, "checkpointed": 2})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "stop")
        self.assertIs(axi.get("ok"), True)

    def test_abort_requires_user_approved_flag_else_409_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open", "cycles": []},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["abort", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": False, "error": "409 userApproved required"})
        self.assertNotEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "abort")
        self.assertIs(axi.get("ok"), False)

        code2, out2, _err2, _p2, _g2, _pa2 = self._run(
            ["abort", "--user-approved", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": True})
        self.assertEqual(code2, 0, f"stdout={out2!r}")
        axi2 = self._decode_axi(out2)
        self.assertIs(axi2.get("ok"), True)

    def test_gate_report_prints_toon_envelope_with_prefer_gate_run_warning(self):
        code, out, err, _p, _g, _pa = self._run(
            ["gate-report", "--outcome", "passed", "--project-dir", self.tmpdir],
            post_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "gate-report")
        self.assertIs(axi.get("ok"), True)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn("prefer-gate-run", codes,
                      f"gate-report must warn to prefer gate-run; got {axi!r}")
        self.assertIn("prefer-gate-run", err)

    def test_gate_run_prints_toon_envelope_with_no_prefer_gate_run_warning(self):
        saved_path = os.environ.get("PATH", "")
        fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-mvn-")
        fake_path = os.path.join(fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        st = os.stat(fake_path)
        os.chmod(fake_path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.environ["PATH"] = fake_bin_dir + os.pathsep + saved_path
        try:
            code, out, _err, _p, _g, _pa = self._run(
                ["gate-run", "--intent", "verify the refactor",
                 "--project-dir", self.tmpdir], post_return={"ok": True})
        finally:
            os.environ["PATH"] = saved_path
            shutil.rmtree(fake_bin_dir, ignore_errors=True)

        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertIn(_RELAY_MARKER, out,
                      "gate-run must relay the no-mistakes axi detail to its own stdout")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "gate-run")
        self.assertIs(axi.get("ok"), True)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("prefer-gate-run", codes,
                          "gate-run is itself the streaming standard -- it must never "
                          "carry the prefer-gate-run discouragement")


# ── §S9 auto-attach + hard error (via the existing `auto-ingest` verb) ─────


class MvnCrucibleAutoAttachTest(_BaseMvnAxiTest):
    def _write_surefire_report(self):
        reports_dir = os.path.join(self.tmpdir, "target", "surefire-reports")
        os.makedirs(reports_dir, exist_ok=True)
        with open(os.path.join(reports_dir, "TEST-FixtureTest.xml"), "w") as f:
            f.write(PASS_SUREFIRE_XML)
        return reports_dir

    def test_auto_ingest_verb_auto_attaches_run_to_the_single_active_cycle_when_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        self._write_surefire_report()
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._active_cycle_plans(901),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-M-auto", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("context", {}).get("cycleId"), 901)
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), 901,
            "the SERVER-recorded run context must carry the resolved active cycle id",
        )

    def test_auto_ingest_verb_hard_errors_when_no_active_cycle_and_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        self._write_surefire_report()
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_active_cycle_plans(),
                                create=True):
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-M-auto", "--project-dir", self.tmpdir,
            ])
        self.assertNotEqual(code, 0, "no active cycle must hard-error non-zero")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        detail = " ".join(w.get("detail", "") for w in axi.get("warnings", [])).lower()
        self.assertIn("no active cycle", detail)
        self.assertIn("no active cycle", err.lower())
        self.assertIsNone(
            _post_call_for_path(post_mock, "/api/v2/runs"),
            "the run must NEVER be POSTed as a silent cycleId=NONE orphan",
        )

    def test_register_hard_errors_when_no_active_cycle_and_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_active_cycle_plans(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "register", "--agent", "CR-M-reg", "--project-dir", self.tmpdir,
            ])
        self.assertNotEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        self.assertIsNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))

    def test_register_succeeds_with_explicit_workflow_cycle_id_override(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_active_cycle_plans(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "register", "--agent", "CR-M-reg", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        self.assertIsNotNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))


# ── Toolchain-specific: `test`/`check` really invoke Maven (via a fake mvnw) ─


class MvnCrucibleToolchainTest(_BaseMvnAxiTest):
    def test_test_verb_runs_real_maven_surefire_and_ingests_with_explicit_cycle_id_context(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        _write_fake_mvnw(self.tmpdir, _FAKE_MVNW_TEST_BODY)
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": True,
                                               "run": {"passed": 1, "failed": 0, "total": 1}},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--agent", "CR-M-toolchain",
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "test")
        self.assertIs(axi.get("ok"), True)
        run = axi.get("run", {})
        self.assertEqual(run.get("passed"), 1)
        self.assertEqual(run.get("failed"), 0)
        self.assertEqual(axi.get("context", {}).get("cycleId"), 51)
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the real surefire run must actually be POSTed")
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), 51,
            "the real maven surefire run's ingest payload must carry the resolved cycle id",
        )

    def test_check_verb_runs_real_maven_compile_and_ingests_compile_errors_with_cycle_id_context(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        _write_fake_mvnw(self.tmpdir, _FAKE_MVNW_CHECK_BODY)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "check", "--project-dir", self.tmpdir, "--agent", "CR-M-check",
            ])
        self.assertNotEqual(code, 0, "a real maven compile failure must exit non-zero")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "check")
        self.assertIs(axi.get("ok"), False)
        compile_call = _post_call_for_path(post_mock, "/api/v2/runs/compile")
        self.assertIsNotNone(compile_call, "a failing check must ingest the compile error")
        self.assertIn("[ERROR]", compile_call[0][1].get("errors", ""))
        self.assertEqual(compile_call[0][1].get("context", {}).get("cycleId"), 51)


if __name__ == "__main__":
    unittest.main()
