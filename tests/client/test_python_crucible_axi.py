"""CR-CRU-030 C3 RED -- migrate `clients/python-crucible.py` to the shared
TOON-AXI envelope module `clients/_crucible_axi.py`, mirroring the
bun-crucible.py reference (CR-CRU-030 C1/C2, cycles 82-84).

Contract pinned VERBATIM from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S2 -- "Apply CR-013's bun-client pattern ... to `python-crucible.py`,
  `rust-crucible.py` ... every AXI verb (register, unregister, plan-file,
  cycle-activate, cycle-done, cr-close, and the test/regression/auto-ingest
  ingest result, plus each stack's typecheck/compile gate) returns the §S1
  envelope. The ingest-verb envelopes carry `context` (cycleId included)."

  §S4/§S6/§S7/§S8 -- the net-new verbs (`cycle-add`, `status`/`plans`,
  `checkpoint`/`stop`/`abort`, `gate-run`/`gate-report`) must also exist on
  every client and return the §S1 envelope.

  §S9 -- ingest verbs (and `register`) auto-attach to the open plan's
  ACTIVE cycle when `WORKFLOW_CYCLE_ID` is unset; no active cycle is a HARD
  ERROR (`ok:false`, non-zero exit, no POST), never a silent orphan.

RED phase: `clients/python-crucible.py` today (confirmed by reading the
source) prints ad-hoc plain-text lines (`print(f"register: ok={...}")`),
never references `_crucible_axi` anywhere, and has NO plan-file /
cycle-activate / cycle-done / cr-close / cycle-add / status / checkpoint /
stop / abort / gate-run / gate-report subcommands at all -- `argparse`
raises `SystemExit(2)` ("invalid choice") for every one of them. Every test
below therefore fails: either a decode of plain (non-TOON) stdout, an
`AttributeError` for a wrapper (`_emit_axi`/`_axi_context`/`_get`/`_patch`)
that does not exist yet, or `SystemExit(2)` from an unknown subcommand --
all valid RED per the sub-agent procedure (a missing-SUT-symbol/collection
error is not skipped).

This file is deliberately THIN per the CR-CRU-030 C3 dispatch: the AXI-CLI
conventions themselves (§S10-§S15 -- `--fields`, `--full`, `count`,
structured-errors/idempotency, the no-arg dashboard, `help[]`) are already
exhaustively tested against the shared module + the bun reference
(`test_crucible_axi_shared.py`, `test_bun_crucible_*`); this file only
proves python-crucible.py is correctly WIRED to that shared behavior plus
its own toolchain (xmlrunner / py_compile).

Module-loading + HTTP-mocking convention copied verbatim from the sibling
bun test harnesses (`test_bun_crucible_auto_attach.py`,
`test_bun_crucible_gate_axi.py`): load by file path via `importlib`, mock
the module's `_post`/`_get`/`_patch` HTTP transport seam so the live
Crucible server on :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_python_crucible_axi.py -q
Fallback:
    python3 tests/client/test_python_crucible_axi.py
"""

import contextlib
import importlib.util
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "python-crucible.py"
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"

FIXTURE_TEST_MODULE = """import unittest


class FixtureTest(unittest.TestCase):
    def test_passes(self):
        self.assertTrue(True)
"""

_RELAY_MARKER = "python-gate-axi-relay-marker-777"
_FINAL_SNAPSHOT = (
    'run:\n'
    '  id: "gate-axi-py-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: def5678\n'
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

# ── C6 VERIFY-fix: §S8 interim-snapshot fixture (mirrors
# test_bun_crucible_gates.py::GateRunAxiProxyTest exactly) -- a PROGRESSIVE
# fake `no-mistakes` that writes 3 in-flight snapshots to a shared state file
# over ~3 real seconds (comfortably past the >=2s §S2b cadence) before the
# final resolved snapshot, so a correctly-throttled gate-run has exactly one
# legitimate window to POST an interim gate before the unconditional final
# seal.
_INTERIM_RELAY_MARKER = "python-gate-axi-interim-relay-marker-222"
_INTERIM_SNAPSHOT_1 = (
    'run:\n'
    '  id: "gate-axi-py-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: def9999\n'
    '  findings: 0\n'
    '  steps[3]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
)
_INTERIM_SNAPSHOT_2 = (
    'run:\n'
    '  id: "gate-axi-py-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: def9999\n'
    '  findings: 1\n'
    '  steps[6]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
    '    test,completed,0,300\n'
    '    document,completed,0,150\n'
    '    lint,completed,0,80\n'
)
_INTERIM_SNAPSHOT_3 = (
    'run:\n'
    '  id: "gate-axi-py-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: def9999\n'
    '  findings: 1\n'
    '  steps[8]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
    '    test,completed,0,300\n'
    '    document,completed,0,150\n'
    '    lint,completed,0,80\n'
    '    push,completed,0,40\n'
    '    pr,skipped,0,10\n'
)
_INTERIM_SNAPSHOT_FINAL = (
    'run:\n'
    '  id: "gate-axi-py-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: def9999\n'
    '  findings: 1\n'
    '  steps[9]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
    '    test,completed,0,300\n'
    '    document,completed,0,150\n'
    '    lint,completed,0,80\n'
    '    push,completed,0,40\n'
    '    pr,skipped,0,10\n'
    '    ci,skipped,0,10\n'
    'outcome: passed\n'
)
_FAKE_NO_MISTAKES_INTERIM_BODY = '''
import json
import os
import sys
import time

argv = sys.argv[1:]
state_file = os.environ.get("GATE_RUN_FAKE_STATE")


def _write_state(text):
    if state_file:
        with open(state_file, "w") as f:
            f.write(text)


if len(argv) >= 2 and argv[0] == "axi" and argv[1] == "run":
    argv_file = os.environ.get("GATE_RUN_FAKE_ARGV_FILE")
    if argv_file:
        with open(argv_file, "w") as f:
            json.dump(argv, f)
    _write_state({s1!r})
    time.sleep(1.0)
    _write_state({s2!r})
    time.sleep(1.5)
    _write_state({s3!r})
    time.sleep(0.8)
    _write_state({sf!r})
    sys.stdout.write({sf!r})
    sys.exit(0)
elif len(argv) >= 2 and argv[0] == "axi" and argv[1] == "status":
    content = ""
    if state_file and os.path.exists(state_file):
        with open(state_file) as f:
            content = f.read()
    sys.stdout.write(content or {s1!r})
    sys.exit(0)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''.format(s1=_INTERIM_SNAPSHOT_1, s2=_INTERIM_SNAPSHOT_2, s3=_INTERIM_SNAPSHOT_3, sf=_INTERIM_SNAPSHOT_FINAL)


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "python_crucible_under_test_axi")


def _load_axi_module():
    return _load_module(AXI_MODULE_PATH, "crucible_axi_under_test_for_python")


def _load_toon_module():
    return _load_module(TOON_PATH, "toon_under_test_for_python_axi")


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, stdout, stderr).
    Only SystemExit is caught -- any OTHER exception propagates so unittest
    reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["python-crucible.py"] + argv
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


class _BasePythonAxiTest(unittest.TestCase):
    PROJECT_KEY = "test-key-python-axi"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_client_module()
        self.toon = _load_toon_module()
        self.tmpdir = tempfile.mkdtemp(prefix="python-crucible-axi-")
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

    def _active_cycle_plans(self, active_id=707):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": active_id, "status": "active"},
                        {"id": active_id - 1, "status": "done"}]},
        ])

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-quiet", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 10, "status": "pending"}, {"id": 11, "status": "done"}]},
        ])

    def _no_open_plans_at_all(self):
        """CR-CRU-036 §S1 tolerant case: no open plan exists at all (a
        lightweight project) — the query is DEFINITIVE (ok:True, empty plans
        list), not a failure, but there is simply no open plan to carry an
        active cycle. The guard must PROCEED, never withhold."""
        return _open_plans_response([])

    def _plans_fetch_failure(self):
        """CR-CRU-036 §S1 tolerant case: the plans GET itself fails (infra
        hiccup / a non-UUID project key 400ing server-side) — NOT proof of
        "no active cycle", so the guard must PROCEED, never withhold."""
        return {"ok": False, "error": "connection failed: mock plans-fetch failure"}


# ── §S1 wiring: python-crucible.py must delegate to the shared module ──────


class PythonCrucibleWiredToSharedAxiModuleTest(_BasePythonAxiTest):
    def test_source_references_the_shared_axi_module(self):
        source = SCRIPT_PATH.read_text()
        self.assertIn(
            "_crucible_axi", source,
            "python-crucible.py must import from the shared clients/_crucible_axi.py "
            "module (§S1) rather than keep a standalone duplicate envelope implementation",
        )

    def test_emit_axi_wrapper_produces_byte_identical_stdout_to_the_shared_emit_axi(self):
        axi_mod = _load_axi_module()
        call_args = ("register", True, {"agent": "CR-X-1"},
                     {"projectKey": "k1", "agentId": "CR-X-1"}, [])

        client_out = io.StringIO()
        with contextlib.redirect_stdout(client_out):
            self.module._emit_axi(*call_args)

        shared_out = io.StringIO()
        with contextlib.redirect_stdout(shared_out):
            axi_mod.emit_axi(*call_args)

        self.assertEqual(
            client_out.getvalue(), shared_out.getvalue(),
            "python-crucible.py's _emit_axi must produce BYTE-IDENTICAL stdout to "
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
            "python-crucible.py's _axi_context(project_dir, ...) must produce output "
            "IDENTICAL to the shared axi_context(project_key, ...) for the same "
            "resolved project_key",
        )


# ── Full verb-set envelope smoke test (one assertion set per verb) ─────────


class PythonCrucibleVerbEnvelopeTest(_BasePythonAxiTest):
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
            ["register", "--agent", "CR-X-1", "--project-dir", self.tmpdir],
            get_return=self._active_cycle_plans())
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "register")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("context", {}).get("projectKey"), self.PROJECT_KEY)

    def test_unregister_prints_toon_envelope(self):
        code, out, _err, _p, _g, _pa = self._run(
            ["unregister", "--agent", "CR-X-1", "--project-dir", self.tmpdir])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "unregister")
        self.assertIs(axi.get("ok"), True)

    def test_plan_file_prints_toon_envelope_with_assigned_cycle_ids_and_context(self):
        os.environ["WORKFLOW_WAVE"] = "4"
        resp = {"ok": True, "planId": "plan-9", "cr": "CR-CRU-030",
                "cycles": [{"label": "a", "id": 501}]}
        code, out, _err, _p, _g, _pa = self._run(
            ["plan-file", "--cr", "CR-CRU-030", "--cycles", "a",
             "--project-dir", self.tmpdir], post_return=resp)
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-file")
        self.assertIs(axi.get("ok"), True)
        cycles = axi.get("cycles")
        self.assertEqual(cycles[0].get("id"), 501,
                          "the assigned numeric cycle id must stay machine-readable")
        context = axi.get("context", {})
        self.assertEqual(context.get("cr"), "CR-CRU-030")
        self.assertEqual(str(context.get("wave")), "4")

    def test_cycle_activate_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 501, "status": "pending"}]},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cycle-activate", "501", "--project-dir", self.tmpdir],
            get_return=plans, patch_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-activate")
        self.assertIs(axi.get("ok"), True)

    def test_cycle_done_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 501, "status": "active"}]},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cycle-done", "501", "--project-dir", self.tmpdir],
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
            get_return=plans, post_return={"ok": True, "id": 777})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-add")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("id"), 777)

    def test_status_alias_plans_prints_toon_envelope_with_queue_table(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 501, "status": "active"}], "merge": None},
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
        fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-py-")
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

    def test_gate_run_posts_interim_snapshot_before_final_sealed_gate(self):
        """§S8 (CR-CRU-030 AC line 270, C6 VERIFY-fix): `gate-run` must POST
        >=1 interim gate snapshot (from polling `axi status` while `axi run`
        is still in flight) BEFORE the final sealed gate -- mirrors
        test_bun_crucible_gates.py::GateRunAxiProxyTest.
        test_gate_run_polls_status_for_interim_gates_and_seals_final_from_run_outcome
        against the SAME `while proc.poll() is None:` polling loop
        python-crucible.py's `cmd_gate_run` already wires up (confirmed by
        reading the function body at python-crucible.py:1188)."""
        saved_path = os.environ.get("PATH", "")
        fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-py-interim-")
        fake_path = os.path.join(fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_INTERIM_BODY)
        st = os.stat(fake_path)
        os.chmod(fake_path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        state_file = os.path.join(self.tmpdir, "interim-state.toon")
        argv_file = os.path.join(self.tmpdir, "interim-argv.json")
        os.environ["PATH"] = fake_bin_dir + os.pathsep + saved_path
        os.environ["GATE_RUN_FAKE_STATE"] = state_file
        os.environ["GATE_RUN_FAKE_ARGV_FILE"] = argv_file

        calls = []

        def fake_post(path, payload):
            calls.append((path, dict(payload) if isinstance(payload, dict) else payload))
            return {"ok": True}

        try:
            with mock.patch.object(self.module, "_post", side_effect=fake_post, create=True):
                code, out, _err = _run_main(self.module, [
                    "gate-run", "--intent", "verify the interim polling path",
                    "--project-dir", self.tmpdir,
                ])
        finally:
            os.environ["PATH"] = saved_path
            os.environ.pop("GATE_RUN_FAKE_STATE", None)
            os.environ.pop("GATE_RUN_FAKE_ARGV_FILE", None)
            shutil.rmtree(fake_bin_dir, ignore_errors=True)

        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertIn(_INTERIM_RELAY_MARKER, out,
                      "gate-run must relay the no-mistakes axi detail to its own stdout")

        gate_calls = [c for c in calls if c[0] == "/api/v2/gates"]
        self.assertGreaterEqual(len(gate_calls), 2,
                                 f"expected >=1 interim + 1 final gate POST, got {calls}")
        self.assertEqual(calls, gate_calls,
                          "gate-run owns ALL Crucible plumbing -- no other endpoint "
                          "should ever be hit")

        *interim, final = gate_calls
        self.assertGreaterEqual(len(interim), 1,
                                 "gate-run must POST at least ONE interim snapshot "
                                 "before the final sealed gate")

        final_gate = final[1].get("gate", {})
        self.assertEqual(final_gate.get("outcome"), "passed",
                          "the final gate's outcome must match `axi run`'s resolved outcome")
        self.assertEqual(len(final_gate.get("steps", [])), 9)

        for _path, payload in interim:
            interim_gate = payload.get("gate", {})
            self.assertLess(len(interim_gate.get("steps", [])), 9,
                             f"an interim gate must be a PARTIAL snapshot, got {interim_gate}")
            self.assertIn(interim_gate.get("outcome"), ("checks-passed", "passed",
                                                          "failed", "cancelled"),
                           "gate.outcome is REQUIRED by the server even for an interim "
                           "snapshot")


# ── C6 VERIFY-fix: §S3 `no-wave` warning (CR-CRU-030 AC line 267) ──────────


class PythonCrucibleNoWaveWarningTest(_BasePythonAxiTest):
    """A `plan-file` with neither `--wave` nor `WORKFLOW_WAVE` resolvable must
    emit a `no-wave` warning (envelope `warnings[]` + stderr) naming the CR
    being filed; with either resolvable -> no `no-wave` warning, and the wave
    is still carried. `--wave` still overrides `WORKFLOW_WAVE`.

    RED: `cmd_plan_file` in python-crucible.py (confirmed by reading the
    function body) builds `warnings = []` (via the bare `[]` passed to
    `_emit_axi`) unconditionally -- there is no no-wave detection at all, so
    the warning-presence assertion below fails against the CURRENT baseline."""

    def test_neither_wave_nor_env_emits_no_wave_warning_naming_the_cr(self):
        resp = {"ok": True, "planId": "plan-90", "cr": "CR-CRU-090",
                "cycles": [{"label": "a", "id": 900}]}
        code, out, err, post_mock, _g, _pa = self._run_plan_file(resp)

        self.assertEqual(code, 0,
                          f"a wave-less plan-file must still file (no hard block); "
                          f"stdout={out!r} stderr={err!r}")
        payload = post_mock.call_args[0][1]
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
        resp = {"ok": True, "planId": "plan-91", "cr": "CR-CRU-091",
                "cycles": [{"label": "a", "id": 901}]}
        code, out, err, post_mock, _g, _pa = self._run_plan_file(resp, wave_flag="5")

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = post_mock.call_args[0][1]
        self.assertEqual(str(payload.get("wave")), "5")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-wave", codes,
                          f"--wave resolves the wave -- no no-wave warning should "
                          f"fire; got {axi!r}")
        self.assertNotIn("no-wave", err)

    def test_workflow_wave_env_present_omits_no_wave_warning(self):
        os.environ["WORKFLOW_WAVE"] = "4"
        resp = {"ok": True, "planId": "plan-92", "cr": "CR-CRU-092",
                "cycles": [{"label": "a", "id": 902}]}
        code, out, err, post_mock, _g, _pa = self._run_plan_file(resp)

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = post_mock.call_args[0][1]
        self.assertEqual(str(payload.get("wave")), "4")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-wave", codes,
                          f"WORKFLOW_WAVE resolves the wave -- no no-wave warning "
                          f"should fire; got {axi!r}")
        self.assertNotIn("no-wave", err)

    def test_wave_flag_overrides_env_and_still_omits_no_wave_warning(self):
        os.environ["WORKFLOW_WAVE"] = "9"
        resp = {"ok": True, "planId": "plan-93", "cr": "CR-CRU-093",
                "cycles": [{"label": "a", "id": 903}]}
        code, out, err, post_mock, _g, _pa = self._run_plan_file(resp, wave_flag="5")

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = post_mock.call_args[0][1]
        self.assertEqual(str(payload.get("wave")), "5", "--wave must win over WORKFLOW_WAVE")
        self.assertNotEqual(str(payload.get("wave")), "9")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-wave", codes)
        self.assertNotIn("no-wave", err)

    def _run_plan_file(self, post_return, wave_flag=None):
        argv = ["plan-file", "--cr", post_return["cr"], "--cycles", "a",
                "--project-dir", self.tmpdir]
        if wave_flag is not None:
            argv += ["--wave", wave_flag]
        with mock.patch.object(self.module, "_post", return_value=post_return,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=None, create=True) as get_mock, \
             mock.patch.object(self.module, "_patch", return_value=None, create=True) as patch_mock:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock, get_mock, patch_mock


# ── §S9 auto-attach + hard error ────────────────────────────────────────────


class PythonCrucibleAutoAttachTest(_BasePythonAxiTest):
    """CR-CRU-036 §S1 corrected §S9: `WORKFLOW_CYCLE_ID` is REMOVED entirely
    (no client reads it — setting it changes NOTHING); the active cycle to
    attach to is resolved SOLELY from the server. An open plan with NO active
    cycle WARNS + WITHHOLDS (ok:false, `warnings[]` `no-active-cycle`, no
    POST, non-zero exit) — never a silent orphan. No open plan at all, or a
    plans-fetch failure, is TOLERATED (the verb proceeds silently)."""

    def _write_auto_ingest_reports(self):
        reports_dir = os.path.join(self.tmpdir, "test-reports")
        os.makedirs(reports_dir, exist_ok=True)
        with open(os.path.join(reports_dir, "TEST-fixture.xml"), "w") as f:
            f.write(
                '<?xml version="1.0"?>'
                '<testsuite name="fixture" tests="1" failures="0">'
                '<testcase name="test_passes" time="0.001"/>'
                '</testsuite>'
            )
        return reports_dir

    def test_source_never_reads_workflow_cycle_id_env_var(self):
        occurrences = SCRIPT_PATH.read_text().count("WORKFLOW_CYCLE_ID")
        self.assertEqual(
            occurrences, 0,
            f"python-crucible.py must not reference WORKFLOW_CYCLE_ID anywhere "
            f"(CR-CRU-036 §S1 removes it -- the server's active cycle is the "
            f"single source of truth); found {occurrences} occurrence(s)",
        )

    def test_auto_ingest_verb_auto_attaches_run_to_the_single_active_cycle_when_env_unset(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        self._write_auto_ingest_reports()
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._active_cycle_plans(707),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-X-auto", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("context", {}).get("cycleId"), 707)
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), 707,
            "the SERVER-recorded run context must carry the resolved active cycle id",
        )

    def test_setting_workflow_cycle_id_env_has_no_effect_on_ingest_attachment(self):
        """CR-CRU-036 §S1: an explicit WORKFLOW_CYCLE_ID no longer overrides
        anything -- the server's active cycle (707) is attached even though
        the env var names a DIFFERENT id (51), proving the env is ignored."""
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        self._write_auto_ingest_reports()
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._active_cycle_plans(707),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-X-auto", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(
            axi.get("context", {}).get("cycleId"), 707,
            "WORKFLOW_CYCLE_ID=51 must NOT override the server-resolved active "
            "cycle (707) -- the env var is no longer read at all",
        )
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), 707,
            "the SERVER-recorded run context must carry the server-resolved "
            "cycle id, never the ignored env override",
        )

    def test_auto_ingest_verb_warns_and_withholds_when_open_plan_has_no_active_cycle(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        self._write_auto_ingest_reports()
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_active_cycle_plans(),
                                create=True):
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-X-auto", "--project-dir", self.tmpdir,
            ])
        self.assertNotEqual(code, 0, "no active cycle must withhold with a non-zero exit")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        warnings_list = axi.get("warnings", [])
        codes = [w.get("code") for w in warnings_list]
        self.assertIn("no-active-cycle", codes,
                       f"expected a no-active-cycle warning; got {warnings_list!r}")
        self.assertIn("no active cycle", err.lower())
        self.assertIsNone(
            _post_call_for_path(post_mock, "/api/v2/runs/parsed"),
            "the run must NEVER be POSTed as a silent cycleId=NONE orphan",
        )

    def test_auto_ingest_verb_proceeds_when_no_open_plan_at_all(self):
        """CR-CRU-036 §S1 tolerant path: a lightweight project with no open
        plan must NOT withhold -- it proceeds and posts the run normally."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        self._write_auto_ingest_reports()
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_open_plans_at_all(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-X-auto", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"no open plan at all must be TOLERATED; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-active-cycle", codes)
        self.assertIsNotNone(
            _post_call_for_path(post_mock, "/api/v2/runs/parsed"),
            "the tolerant path must still post the run",
        )

    def test_auto_ingest_verb_proceeds_when_plans_fetch_fails(self):
        """CR-CRU-036 §S1 tolerant path: a plans-fetch failure (infra hiccup /
        non-UUID key 400) is NOT proof of "no active cycle" -- proceeds."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        self._write_auto_ingest_reports()
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._plans_fetch_failure(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "auto-ingest", "--agent", "CR-X-auto", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"a plans-fetch failure must be TOLERATED; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-active-cycle", codes)
        self.assertIsNotNone(
            _post_call_for_path(post_mock, "/api/v2/runs/parsed"),
            "the tolerant path must still post the run",
        )

    def test_register_warns_and_withholds_when_open_plan_has_no_active_cycle(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_active_cycle_plans(),
                                create=True):
            code, out, err = _run_main(self.module, [
                "register", "--agent", "CR-X-reg", "--project-dir", self.tmpdir,
            ])
        self.assertNotEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn("no-active-cycle", codes)
        self.assertIn("no active cycle", err.lower())
        self.assertIsNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))

    def test_register_proceeds_when_no_open_plan_at_all(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_open_plans_at_all(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "register", "--agent", "CR-X-reg", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"no open plan at all must be TOLERATED; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        self.assertIsNotNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))

    def test_register_proceeds_when_plans_fetch_fails(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._plans_fetch_failure(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "register", "--agent", "CR-X-reg", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"a plans-fetch failure must be TOLERATED; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        self.assertIsNotNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))

    def test_setting_workflow_cycle_id_env_has_no_effect_on_register_withhold(self):
        """CR-CRU-036 §S1: WORKFLOW_CYCLE_ID=51 must NOT rescue a register
        against an open plan with no active cycle -- the env var is dead."""
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._no_active_cycle_plans(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "register", "--agent", "CR-X-reg", "--project-dir", self.tmpdir,
            ])
        self.assertNotEqual(
            code, 0,
            "WORKFLOW_CYCLE_ID must have NO effect -- the withhold still fires")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn("no-active-cycle", codes)
        self.assertIsNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))


# ── Toolchain-specific: real xmlrunner / py_compile still work ─────────────


class PythonCrucibleToolchainTest(_BasePythonAxiTest):
    # Deliberately NOT named "tests" -- the repo already has a top-level
    # `tests/` package (with no `test_fixture` module inside it). If a
    # subprocess's import path ever leaks the repo root ahead of the tmpdir
    # (e.g. an inherited PYTHONPATH), a fixture package literally named
    # `tests` silently resolves to the REPO's `tests/` instead of this
    # tmpdir's copy and the dotted import fails with a collection error that
    # looks like a hang/empty-output rather than a fixture bug. A collision-free
    # name makes that class of failure structurally impossible regardless of
    # what else is on the subprocess's sys.path.
    FIXTURE_PKG = "python_crucible_axi_toolchain_fixture_pkg"

    def _write_fixture_test_module(self):
        pkg_dir = os.path.join(self.tmpdir, self.FIXTURE_PKG)
        os.makedirs(pkg_dir, exist_ok=True)
        with open(os.path.join(pkg_dir, "__init__.py"), "w") as f:
            f.write("")
        with open(os.path.join(pkg_dir, "test_fixture.py"), "w") as f:
            f.write(FIXTURE_TEST_MODULE)

    def test_test_verb_runs_real_unittest_and_ingests_with_active_cycle_context(self):
        self._write_fixture_test_module()
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._active_cycle_plans(707),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--python", sys.executable,
                "--tests", f"{self.FIXTURE_PKG}.test_fixture", "--reports", "reports",
                "--agent", "CR-X-toolchain",
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "test")
        self.assertIs(axi.get("ok"), True)
        run = axi.get("run", {})
        self.assertEqual(run.get("passed"), 1)
        self.assertEqual(run.get("failed"), 0)
        self.assertEqual(axi.get("context", {}).get("cycleId"), 707)
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call)
        self.assertEqual(
            ingest_call[0][1].get("context", {}).get("cycleId"), 707,
            "the real unittest run's ingest payload must carry the auto-attached "
            "active cycle id",
        )

    def test_check_verb_runs_py_compile_and_ingests_compile_errors(self):
        app_dir = os.path.join(self.tmpdir, "app")
        os.makedirs(app_dir, exist_ok=True)
        with open(os.path.join(app_dir, "bad.py"), "w") as f:
            f.write("def bad(:\n    pass\n")
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "check", "--project-dir", self.tmpdir, "--python", sys.executable,
                "--paths", "app", "--agent", "CR-X-check",
            ])
        self.assertNotEqual(code, 0, "a real py_compile syntax error must exit non-zero")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "check")
        self.assertIs(axi.get("ok"), False)
        compile_call = _post_call_for_path(post_mock, "/api/v2/runs/compile")
        self.assertIsNotNone(compile_call, "a failing check must ingest the compile error")

    def test_setting_workflow_cycle_id_env_has_no_effect_on_check_verb_ingest(self):
        """CR-CRU-036 §S1: WORKFLOW_CYCLE_ID is REMOVED -- setting it must not
        make a cycleId appear in the compile-error ingest context."""
        app_dir = os.path.join(self.tmpdir, "app")
        os.makedirs(app_dir, exist_ok=True)
        with open(os.path.join(app_dir, "bad.py"), "w") as f:
            f.write("def bad(:\n    pass\n")
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "check", "--project-dir", self.tmpdir, "--python", sys.executable,
                "--paths", "app", "--agent", "CR-X-check",
            ])
        self.assertNotEqual(code, 0, "a real py_compile syntax error must exit non-zero")
        compile_call = _post_call_for_path(post_mock, "/api/v2/runs/compile")
        self.assertIsNotNone(compile_call, "a failing check must ingest the compile error")
        self.assertIsNone(
            (compile_call[0][1].get("context") or {}).get("cycleId"),
            "WORKFLOW_CYCLE_ID=51 must have NO EFFECT -- the env var is no "
            "longer read anywhere in the client",
        )


if __name__ == "__main__":
    unittest.main()
