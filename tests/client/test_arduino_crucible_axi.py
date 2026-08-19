"""CR-CRU-030 C4 RED -- migrate `clients/arduino-crucible.py` to the shared
TOON-AXI envelope module `clients/_crucible_axi.py`, mirroring the
bun-crucible.py reference (CR-CRU-030 C1/C2) and the already-migrated
python/rust/mvn clients (C3 commit 9a2b29a; C4 mvn sibling
`test_mvn_crucible_axi.py`).

Contract pinned VERBATIM from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S2 -- "Apply CR-013's bun-client pattern ... to ... `arduino-crucible.py`:
  every AXI verb (register, unregister, plan-file, cycle-activate,
  cycle-done, cr-close, and the test/regression/auto-ingest ingest result,
  plus each stack's typecheck/compile gate) returns the §S1 envelope. The
  ingest-verb envelopes carry `context` (cycleId included)."

  §S4/§S6/§S7/§S8 -- the net-new verbs (`cycle-add`, `status`/`plans`,
  `checkpoint`/`stop`/`abort`, `gate-run`/`gate-report`) must also exist on
  every client and return the §S1 envelope.

  §S9 -- ingest verbs (and `register`) auto-attach to the open plan's
  ACTIVE cycle when `WORKFLOW_CYCLE_ID` is unset; no active cycle is a HARD
  ERROR (`ok:false`, non-zero exit, no POST), never a silent orphan.

RED phase: `clients/arduino-crucible.py` today (confirmed by reading the
source) prints ad-hoc plain-text lines (`print(f"[crucible] register: ...")`),
never references `_crucible_axi` anywhere, has no `_get`/`_patch` transport
seam at all (only `_post`), and has NO plan-file / cycle-activate /
cycle-done / cr-close / cycle-add / status / checkpoint / stop / abort /
gate-run / gate-report subcommands, nor `test`/`check` (today it's
`unit`/`compile`, the pre-migration toolchain-verb names; `test`/`check` are
the fleet-uniform post-migration names per the CR-CRU-030 C4 dispatch) --
`argparse` raises `SystemExit(2)` ("invalid choice") for every one of them.
Every test below therefore fails: either a decode of plain (non-TOON) stdout,
an `AttributeError` for a wrapper (`_emit_axi`/`_axi_context`/`_get`/`_patch`)
that does not exist yet, or `SystemExit(2)` from an unknown subcommand --
all valid RED per the sub-agent procedure (a missing-SUT-symbol/collection
error is not skipped).

This file is deliberately THIN per the CR-CRU-030 C4 dispatch: the AXI-CLI
conventions themselves (§S10-§S15) are already exhaustively tested against
the shared module + the bun reference; this file only proves
arduino-crucible.py is correctly WIRED to that shared behavior plus its own
toolchain -- the native HOST test harness is kept REAL (a tiny `make junit`
fixture, no actual g++/hardware compile needed, mirroring the "python: real
xmlrunner" precedent) while the heavy/not-always-installed `arduino-cli`
target compile is stubbed by a fake executable substituted via the
`ARDUINO_CLI` env var (mirroring the `gate-run` fake `no-mistakes` binary
technique already used against every client in this fleet's test suite).

Module-loading + HTTP-mocking convention copied verbatim from the sibling
python/rust/mvn test harnesses: load by file path via `importlib`, mock the
module's `_post`/`_get`/`_patch` HTTP transport seam so the live Crucible
server on :3849 is NEVER touched.

Invocation:
    python3 -m pytest tests/client/test_arduino_crucible_axi.py -q
Fallback:
    python3 tests/client/test_arduino_crucible_axi.py
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "arduino-crucible.py"
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"

PASS_NATIVE_JUNIT_XML = (
    '<?xml version="1.0"?>'
    '<testsuite name="native" tests="1" failures="0">'
    '<testcase name="test_passes" time="0.001"/>'
    '</testsuite>'
)

_RELAY_MARKER = "arduino-gate-axi-relay-marker-111"
_FINAL_SNAPSHOT = (
    'run:\n'
    '  id: "gate-axi-arduino-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: fe98cd7\n'
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
_INTERIM_RELAY_MARKER = "arduino-gate-axi-interim-relay-marker-555"
_INTERIM_SNAPSHOT_1 = (
    'run:\n'
    '  id: "gate-axi-arduino-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: cc33dd4\n'
    '  findings: 0\n'
    '  steps[3]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,100\n'
    '    rebase,completed,0,50\n'
    '    review,completed,1,200\n'
)
_INTERIM_SNAPSHOT_2 = (
    'run:\n'
    '  id: "gate-axi-arduino-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: cc33dd4\n'
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
    '  id: "gate-axi-arduino-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: running\n'
    '  head: cc33dd4\n'
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
    '  id: "gate-axi-arduino-interim-001"\n'
    f'  branch: {_INTERIM_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: cc33dd4\n'
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

# A fake `arduino-cli` substituted for the real (heavy, not always installed)
# toolchain: always fails compilation with a recognizable error line.
_FAKE_ARDUINO_CLI_BODY = '''#!/usr/bin/env python3
import sys
sys.stderr.write("error: expected ';' before '}' token\\n")
sys.exit(1)
'''


def _write_fake_executable(path, body):
    with open(path, "w") as f:
        f.write(f"#!{sys.executable}\n")
        f.write(body)
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _write_native_make_junit_fixture(project_dir, sub="tests/native"):
    """A REAL, fast `make junit` target -- no g++/hardware compile, just a
    tiny helper script writing a passing JUnit fixture -- so the native HOST
    test harness invocation itself is exercised for real (mirrors the
    "python: real xmlrunner" toolchain precedent)."""
    native_dir = os.path.join(project_dir, *sub.split("/"))
    os.makedirs(native_dir, exist_ok=True)
    with open(os.path.join(native_dir, "write_junit.py"), "w") as f:
        f.write(
            "import os\n"
            "os.makedirs('reports', exist_ok=True)\n"
            f"with open('reports/TEST-Fixture.xml', 'w') as fh:\n"
            f"    fh.write({PASS_NATIVE_JUNIT_XML!r})\n"
        )
    with open(os.path.join(native_dir, "Makefile"), "w") as f:
        f.write(f"junit:\n\t{sys.executable} write_junit.py\n")
    return native_dir


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "arduino_crucible_under_test_axi")


def _load_axi_module():
    return _load_module(AXI_MODULE_PATH, "crucible_axi_under_test_for_arduino")


def _load_toon_module():
    return _load_module(TOON_PATH, "toon_under_test_for_arduino_axi")


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, stdout, stderr).
    Only SystemExit is caught -- any OTHER exception propagates so unittest
    reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["arduino-crucible.py"] + argv
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


class _BaseArduinoAxiTest(unittest.TestCase):
    PROJECT_KEY = "test-key-arduino-axi"
    PROJECT_NAME = "fixture-firmware"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_client_module()
        self.toon = _load_toon_module()
        self.tmpdir = tempfile.mkdtemp(prefix="arduino-crucible-axi-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
            f.write(f"CRUCIBLE_PROJECT_NAME={self.PROJECT_NAME}\n")
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

    def _active_cycle_plans(self, active_id=1101):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": active_id, "status": "active"},
                        {"id": active_id - 1, "status": "done"}]},
        ])

    def _no_active_cycle_plans(self):
        return _open_plans_response([
            {"planId": "plan-quiet", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 60, "status": "pending"}, {"id": 61, "status": "done"}]},
        ])

    def _no_open_plans_at_all(self):
        """CR-CRU-036 §S1 tolerant case: no open plan exists at all (a
        lightweight project) — the guard must PROCEED, never withhold."""
        return _open_plans_response([])

    def _plans_fetch_failure(self):
        """CR-CRU-036 §S1 tolerant case: the plans GET itself fails (infra
        hiccup / a non-UUID project key 400ing server-side) — not proof of
        "no active cycle", so the guard must PROCEED, never withhold."""
        return {"ok": False, "error": "connection failed: mock plans-fetch failure"}


# ── §S1 wiring: arduino-crucible.py must delegate to the shared module ─────


class ArduinoCrucibleWiredToSharedAxiModuleTest(_BaseArduinoAxiTest):
    def test_source_references_the_shared_axi_module(self):
        source = SCRIPT_PATH.read_text()
        self.assertIn(
            "_crucible_axi", source,
            "arduino-crucible.py must import from the shared clients/_crucible_axi.py "
            "module (§S1) rather than keep a standalone duplicate envelope implementation",
        )

    def test_emit_axi_wrapper_produces_byte_identical_stdout_to_the_shared_emit_axi(self):
        axi_mod = _load_axi_module()
        call_args = ("register", True, {"agent": "CR-A-1"},
                     {"projectKey": "k1", "agentId": "CR-A-1"}, [])

        client_out = io.StringIO()
        with contextlib.redirect_stdout(client_out):
            self.module._emit_axi(*call_args)

        shared_out = io.StringIO()
        with contextlib.redirect_stdout(shared_out):
            axi_mod.emit_axi(*call_args)

        self.assertEqual(
            client_out.getvalue(), shared_out.getvalue(),
            "arduino-crucible.py's _emit_axi must produce BYTE-IDENTICAL stdout to "
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
            "arduino-crucible.py's _axi_context(project_dir, ...) must produce output "
            "IDENTICAL to the shared axi_context(project_key, ...) for the same "
            "resolved project_key",
        )


# ── Full verb-set envelope smoke test (one assertion set per verb) ─────────


class ArduinoCrucibleVerbEnvelopeTest(_BaseArduinoAxiTest):
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
            ["register", "--role", "report", "--agent", "CR-A-1", "--project-dir", self.tmpdir],
            get_return=self._active_cycle_plans())
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "register")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("context", {}).get("projectKey"), self.PROJECT_KEY)

    def test_unregister_prints_toon_envelope(self):
        code, out, _err, _p, _g, _pa = self._run(
            ["unregister", "--agent", "CR-A-1", "--project-dir", self.tmpdir])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "unregister")
        self.assertIs(axi.get("ok"), True)

    def test_plan_file_prints_toon_envelope_with_assigned_cycle_ids_and_context(self):
        os.environ["WORKFLOW_WAVE"] = "4"
        resp = {"ok": True, "planId": "plan-9", "cr": "CR-CRU-030",
                "cycles": [{"label": "a", "id": 1101}]}
        code, out, _err, _p, _g, _pa = self._run(
            ["plan-file", "--cr", "CR-CRU-030", "--cycles", "a",
             "--agent", "test-agent", "--project-dir", self.tmpdir], post_return=resp)
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "plan-file")
        self.assertIs(axi.get("ok"), True)
        cycles = axi.get("cycles")
        self.assertEqual(cycles[0].get("id"), 1101,
                          "the assigned numeric cycle id must stay machine-readable")
        context = axi.get("context", {})
        self.assertEqual(context.get("cr"), "CR-CRU-030")
        self.assertEqual(str(context.get("wave")), "4")

    def test_cycle_activate_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 1101, "status": "pending"}]},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cycle-activate", "1101", "--agent", "test-agent", "--project-dir", self.tmpdir],
            get_return=plans, patch_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-activate")
        self.assertIs(axi.get("ok"), True)

    def test_cycle_done_prints_toon_envelope(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 1101, "status": "active"}]},
        ])
        code, out, _err, _p, _g, _pa = self._run(
            ["cycle-done", "1101", "--agent", "test-agent", "--project-dir", self.tmpdir],
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
            ["cr-close", "--commit", "abc1234", "--agent", "test-agent", "--project-dir", self.tmpdir],
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
            ["cycle-add", "new-cycle", "--agent", "test-agent", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": True, "id": 1191})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-add")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("id"), 1191)

    def test_status_alias_plans_prints_toon_envelope_with_queue_table(self):
        plans = _open_plans_response([
            {"planId": "plan-9", "cr": "CR-CRU-030", "status": "open",
             "cycles": [{"id": 1101, "status": "active"}], "merge": None},
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
            ["checkpoint", "--agent", "test-agent", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": True})
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "checkpoint")
        self.assertIs(axi.get("ok"), True)

    def test_stop_prints_toon_envelope(self):
        code, out, _err, _p, _g, _pa = self._run(
            ["stop", "--agent", "test-agent", "--project-dir", self.tmpdir],
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
            ["abort", "--agent", "test-agent", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": False, "error": "409 userApproved required"})
        self.assertNotEqual(code, 0)
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "abort")
        self.assertIs(axi.get("ok"), False)

        code2, out2, _err2, _p2, _g2, _pa2 = self._run(
            ["abort", "--user-approved", "--agent", "test-agent", "--project-dir", self.tmpdir],
            get_return=plans, post_return={"ok": True})
        self.assertEqual(code2, 0, f"stdout={out2!r}")
        axi2 = self._decode_axi(out2)
        self.assertIs(axi2.get("ok"), True)

    def test_gate_report_prints_toon_envelope_with_prefer_gate_run_warning(self):
        code, out, err, _p, _g, _pa = self._run(
            ["gate-report", "--outcome", "passed", "--agent", "test-agent",
             "--project-dir", self.tmpdir],
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
        fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-arduino-")
        fake_path = os.path.join(fake_bin_dir, "no-mistakes")
        _write_fake_executable(fake_path, _FAKE_NO_MISTAKES_BODY)
        os.environ["PATH"] = fake_bin_dir + os.pathsep + saved_path
        try:
            code, out, _err, _p, _g, _pa = self._run(
                ["gate-run", "--intent", "verify the refactor", "--agent", "test-agent",
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
        arduino-crucible.py's `cmd_gate_run` already wires up (confirmed by
        reading the function body at arduino-crucible.py:868)."""
        saved_path = os.environ.get("PATH", "")
        fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-arduino-interim-")
        fake_path = os.path.join(fake_bin_dir, "no-mistakes")
        _write_fake_executable(fake_path, _FAKE_NO_MISTAKES_INTERIM_BODY)

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
                    "--agent", "test-agent", "--project-dir", self.tmpdir,
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


# ── CR-CRU-035 §S1: `status` is hook-safe -- tolerant + bounded ────────────


class ArduinoCrucibleStatusHookSafeTest(_BaseArduinoAxiTest):
    """CR-CRU-035 §S1 -- `status` must be safe for a session-start hook: a
    server-unreachable/plans-fetch-failure path must become a DEFINITIVE
    degraded data-state (`ok:true` + `warnings[]` `status-unavailable` +
    empty board + `help[]`), exiting 0 -- never today's `ok:false`/exit-1
    command-error path. The no-open-plan empty state (existing behavior)
    must stay DISTINCT from that degrade (AXI principle 5), and the
    underlying plans fetch must be bounded by a short `timeout=`.

    NOTE: `clients/arduino-crucible.py`'s `_request` already passes
    `timeout=10` to `urlopen` (confirmed by reading the source) -- unlike the
    other four clients, so the bounded-fetch test below is a PASSING
    characterization here, not new RED; it is still asserted so the fleet-wide
    §S1 guarantee is pinned uniformly across all five clients."""

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

    def test_status_tolerant_when_plans_fetch_fails_emits_ok_true_status_unavailable_and_exits_zero(self):
        code, out, _err, _p, _g, _pa = self._run(
            ["status", "--project-dir", self.tmpdir],
            get_return=self._plans_fetch_failure())

        self.assertEqual(
            code, 0,
            f"a server-unreachable status must exit 0 (hook-safe), not the "
            f"command-error path; stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "status")
        self.assertIs(
            axi.get("ok"), True,
            "the unreachable degrade is a DEFINITIVE DATA state (AXI principle "
            "5), not a command failure -- ok must be True")
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn("status-unavailable", codes,
                      f"must carry a structured status-unavailable warning; got {axi!r}")
        unavailable = next(w for w in axi.get("warnings", [])
                            if w.get("code") == "status-unavailable")
        self.assertTrue(unavailable.get("detail"),
                         "the status-unavailable warning must carry a non-empty detail")
        self.assertEqual(axi.get("plans"), [],
                          "the unavailable state must report an EMPTY board, never "
                          "fabricated/stale plan rows")
        self.assertIsNone(axi.get("lastRunCr"))
        help_steps = axi.get("help") or []
        self.assertTrue(help_steps, "the unavailable envelope must carry a help[] "
                                     "next-step hint (AXI principle 9)")
        self.assertTrue(
            any("server" in str(h).lower() or "crucible" in str(h).lower()
                for h in help_steps),
            f"the help[] hint must point at reaching/starting the Crucible "
            f"server; got {help_steps!r}")

    def test_status_no_open_plan_still_exits_zero_with_definitive_empty_state(self):
        """Characterization -- existing behavior preserved: a REACHABLE server
        with no open plan is the OTHER definitive empty state (`count:0`),
        and it must stay DISTINCT from the status-unavailable degrade above
        (AXI principle 5 -- never an ambiguous/conflated empty state)."""
        code, out, _err, _p, _g, _pa = self._run(
            ["status", "--project-dir", self.tmpdir],
            get_return=self._no_open_plans_at_all())

        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("plans"), [])
        self.assertEqual(axi.get("count"), 0)
        self.assertEqual(
            axi.get("warnings"), [],
            "the no-plan empty state must NOT carry the status-unavailable "
            "warning -- it is a DIFFERENT definitive state than the "
            "server-unreachable degrade")

    def test_status_plans_fetch_is_bounded_by_a_short_timeout(self):
        """§S1 bounded fetch -- the underlying urlopen call must pass a short
        `timeout=` so an unreachable/slow server can't hang a session-start
        hook forever. arduino-crucible.py's `_request` uses `with urlopen(...)
        as r:`, so the fake response must support the context-manager
        protocol."""
        fake_response = mock.MagicMock()
        fake_response.read.return_value = json.dumps({"ok": True, "plans": []}).encode()
        fake_response.__enter__ = mock.Mock(return_value=fake_response)
        fake_response.__exit__ = mock.Mock(return_value=False)

        with mock.patch("urllib.request.urlopen", return_value=fake_response) as urlopen_mock:
            result = self.module._get(self.module._plans_path(self.tmpdir))

        self.assertTrue(urlopen_mock.called,
                         "the fetch must go through urllib.request.urlopen")
        _args, kwargs = urlopen_mock.call_args
        timeout = kwargs.get("timeout")
        self.assertIsNotNone(
            timeout,
            "urlopen must be called WITH a timeout= kwarg (bounded fetch) -- an "
            "unbounded call can hang a session-start hook forever")
        self.assertIsInstance(timeout, (int, float))
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 15,
                              f"the fetch timeout must be SHORT (hook-safe), got {timeout}")
        self.assertTrue(result.get("ok"))


# ── C6 VERIFY-fix: §S3 `no-wave` warning (CR-CRU-030 AC line 267) ──────────


class ArduinoCrucibleNoWaveWarningTest(_BaseArduinoAxiTest):
    """A `plan-file` with neither `--wave` nor `WORKFLOW_WAVE` resolvable must
    emit a `no-wave` warning (envelope `warnings[]` + stderr) naming the CR
    being filed; with either resolvable -> no `no-wave` warning, and the wave
    is still carried. `--wave` still overrides `WORKFLOW_WAVE`.

    RED: `cmd_plan_file` in arduino-crucible.py (confirmed by reading the
    function body) builds `warnings = []` unconditionally -- there is no
    no-wave detection at all, so the warning-presence assertion below fails
    against the CURRENT baseline."""

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
                "--agent", "test-agent", "--project-dir", self.tmpdir]
        if wave_flag is not None:
            argv += ["--wave", wave_flag]
        with mock.patch.object(self.module, "_post", return_value=post_return,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=None, create=True) as get_mock, \
             mock.patch.object(self.module, "_patch", return_value=None, create=True) as patch_mock:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock, get_mock, patch_mock


# ── CR-CRU-037 §S2 -- `no-title` warning (mirrors §S3 `no-wave` guard) ─────


class ArduinoCrucibleNoTitleWarningTest(_BaseArduinoAxiTest):
    """CR-CRU-037 §S2: a `plan-file` invoked with NO `--title` must emit a
    `no-title` warning (envelope `warnings[]` + stderr) naming the CR being
    filed, mirroring `ArduinoCrucibleNoWaveWarningTest` above -- the plan
    STILL files (title is optional; the orchestrator is just warned). With
    `--title` supplied -> no `no-title` warning fires.

    RED: `cmd_plan_file` in arduino-crucible.py (confirmed by reading the
    function body) has no no-title detection at all, so the warning-presence
    assertion below fails against the CURRENT baseline."""

    def test_no_title_flag_emits_no_title_warning_naming_the_cr(self):
        resp = {"ok": True, "planId": "plan-94", "cr": "CR-CRU-094",
                "cycles": [{"label": "a", "id": 904}]}
        code, out, err, post_mock, _g, _pa = self._run_plan_file(resp)

        self.assertEqual(code, 0,
                          f"a title-less plan-file must still file (no hard block); "
                          f"stdout={out!r} stderr={err!r}")
        payload = post_mock.call_args[0][1]
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
        resp = {"ok": True, "planId": "plan-95", "cr": "CR-CRU-095",
                "cycles": [{"label": "a", "id": 905}]}
        code, out, err, post_mock, _g, _pa = self._run_plan_file(resp, title="Some Title")

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        payload = post_mock.call_args[0][1]
        self.assertEqual(payload.get("title"), "Some Title")
        axi = self._decode_axi(out)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("no-title", codes,
                          f"--title resolves the title -- no no-title warning "
                          f"should fire; got {axi!r}")
        self.assertNotIn("no-title", err)

    def _run_plan_file(self, post_return, title=None):
        argv = ["plan-file", "--cr", post_return["cr"], "--cycles", "a",
                "--agent", "test-agent", "--project-dir", self.tmpdir]
        if title is not None:
            argv += ["--title", title]
        with mock.patch.object(self.module, "_post", return_value=post_return,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=None, create=True) as get_mock, \
             mock.patch.object(self.module, "_patch", return_value=None, create=True) as patch_mock:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock, get_mock, patch_mock


# ── §S9 auto-attach + hard error (via the `test` verb -- arduino has no ────
# separate `auto-ingest` verb; the CR's non-goals explicitly forbid adding
# NEW verbs beyond cycle-add/status/checkpoint/stop/abort, so `test` itself
# carries the §S9 auto-attach contract for this client) ─────────────────────


class ArduinoCrucibleCycleBindingTest(_BaseArduinoAxiTest):
    """CR-CRU-056 §S3/§S3c — the CR-CRU-036-era client-side active-cycle
    resolver (`resolve_attach_cycle`/`resolve_active_cycle_id`) and its
    warn+withhold flow are DELETED: a bound TDD agent cannot hit "no active
    cycle" (registration validates the binding up front), and ingest
    attachment is now the SERVER's job, stamped from the agent's registered
    `--cycle` binding. This class supersedes the CR-CRU-036-era
    ArduinoCrucibleAutoAttachTest: the withhold-wording pins it carried have
    no surviving purpose -- the client-side plans lookup they exercised no
    longer exists at all (`_get` is never even called by register/ingest any
    more) -- so they are retired here, not edited."""

    def test_source_never_reads_workflow_cycle_id_env_var(self):
        occurrences = SCRIPT_PATH.read_text().count("WORKFLOW_CYCLE_ID")
        self.assertEqual(
            occurrences, 0,
            f"arduino-crucible.py must not reference WORKFLOW_CYCLE_ID anywhere "
            f"(CR-CRU-036 §S1 removes it -- the server's active cycle is the "
            f"single source of truth); found {occurrences} occurrence(s)",
        )

    def test_source_contains_no_client_side_cycle_resolver_references(self):
        """CR-CRU-056 §S3/§S3c AC: `resolve_attach_cycle`/
        `resolve_active_cycle_id` must be gone from every client
        (grep-sweep-asserted)."""
        text = SCRIPT_PATH.read_text()
        for banned in ("resolve_attach_cycle", "resolve_active_cycle_id"):
            self.assertNotIn(
                banned, text,
                f"arduino-crucible.py must not reference {banned} -- CR-CRU-056 "
                f"§S3 deletes the client-side attach resolver entirely "
                f"(attachment is server-stamped from the register binding)")

    def test_register_cycle_flag_sends_cycleid_in_register_payload(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "register", "--role", "RED", "--agent", "CR-A-bound",
                "--cycle", "149", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNotNone(register_call, "register must actually POST")
        self.assertEqual(
            register_call[0][1].get("cycleId"), 149,
            "the --cycle flag must ride the register body as cycleId verbatim")

    def test_register_without_cycle_flag_omits_cycleid_key(self):
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "register", "--role", "report", "--agent", "CR-A-unbound",
                "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        register_call = _post_call_for_path(post_mock, "/api/v2/agents/register")
        self.assertIsNotNone(register_call)
        self.assertNotIn(
            "cycleId", register_call[0][1],
            "no --cycle supplied -- the client must not fabricate a cycleId key")

    def test_register_409_refusal_envelope_surfaced_faithfully(self):
        server_message = "role RED requires a cycle binding — register with --cycle <cycleId>"
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": False, "error": server_message},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "register", "--role", "RED", "--agent", "CR-A-refused",
                "--project-dir", self.tmpdir,
            ])
        self.assertNotEqual(code, 0, "a 409 refusal must exit non-zero")
        axi = self._decode_axi(out)
        self.assertIs(axi.get("ok"), False)
        self.assertEqual(
            axi.get("error"), server_message,
            "the server's refusal message must be passed through faithfully")
        self.assertIsNotNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))

    def test_ingest_verb_never_calls_get_and_sends_no_resolved_cycle_in_context(self):
        _write_native_make_junit_fixture(self.tmpdir)
        with mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", create=True) as get_mock:
            code, out, _err = _run_main(self.module, [
                "test", "--agent", "CR-A-auto", "--project-dir", self.tmpdir,
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        get_mock.assert_not_called()
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        self.assertNotIn(
            "cycleId", ingest_call[0][1].get("context", {}),
            "the client must send NO client-resolved cycleId -- attachment "
            "is stamped server-side from the agent's registered binding")
        axi = self._decode_axi(out)
        self.assertNotIn("cycleId", axi.get("context", {}))


# ── Toolchain-specific: `test` runs real native `make junit`; `check` runs ──
# a fake `arduino-cli` compile (the real toolchain substituted, per the
# C4 dispatch: "arduino -> native host tests + arduino-cli compile") ────────


class ArduinoCrucibleToolchainTest(_BaseArduinoAxiTest):
    def test_test_verb_runs_real_native_make_junit_and_ingests_with_run_summary(self):
        """CR-CRU-056 §S3 retarget: attachment is server-stamped now, not
        client-resolved -- keeps proving the real native make-junit wiring
        still ingests correctly, dropping the dead active-cycle fixture."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        _write_native_make_junit_fixture(self.tmpdir)
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": True,
                                               "run": {"passed": 1, "failed": 0, "total": 1}},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--agent", "CR-A-toolchain",
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "test")
        self.assertIs(axi.get("ok"), True)
        run = axi.get("run", {})
        self.assertEqual(run.get("passed"), 1)
        self.assertEqual(run.get("failed"), 0)
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the real native make-junit run must actually be POSTed")
        self.assertNotIn(
            "cycleId", ingest_call[0][1].get("context", {}),
            "the real native test run's ingest payload must send no "
            "client-resolved cycleId -- attachment is server-stamped",
        )

    def test_test_verb_includes_captured_runner_output_as_raw_in_parsed_payload(self):
        """CR-CRU-038 §S2b -- `_run_native_tests_body` captures `make junit`'s
        combined output via `capture_output=True` (`run.stdout + run.stderr`,
        already used for the no-reports error path); that captured output
        must ALSO flow into the /api/v2/runs/parsed payload as `raw` for a
        successful run. Fails today -- the payload built there has no `raw`
        key at all."""
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        marker = "ARDUINO_RAW_CAPTURE_MARKER_3390"
        native_dir = os.path.join(self.tmpdir, "tests", "native")
        os.makedirs(native_dir, exist_ok=True)
        with open(os.path.join(native_dir, "write_junit.py"), "w") as f:
            f.write(
                "import os\n"
                "os.makedirs('reports', exist_ok=True)\n"
                "with open('reports/TEST-Fixture.xml', 'w') as fh:\n"
                f"    fh.write({PASS_NATIVE_JUNIT_XML!r})\n"
            )
        with open(os.path.join(native_dir, "Makefile"), "w") as f:
            f.write(f"junit:\n\t@echo {marker}\n\t{sys.executable} write_junit.py\n")
        with mock.patch.object(self.module, "_post",
                                return_value={"ok": True,
                                               "run": {"passed": 1, "failed": 0, "total": 1}},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get",
                                return_value=self._active_cycle_plans(51),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--agent", "CR-A-raw",
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the native make-junit run must actually be POSTed")
        payload = ingest_call[0][1]
        self.assertIn(
            marker, payload.get("raw") or "",
            f"the real captured native make-junit runner output must flow "
            f"into the parsed ingest payload's `raw` field; got payload "
            f"keys={sorted(payload)!r}",
        )

    def test_check_verb_runs_arduino_cli_compile_and_ingests_compile_errors(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        fake_cli_dir = tempfile.mkdtemp(prefix="fake-arduino-cli-")
        fake_cli_path = os.path.join(fake_cli_dir, "arduino-cli")
        _write_fake_executable(fake_cli_path, _FAKE_ARDUINO_CLI_BODY)
        with mock.patch.object(self.module, "ARDUINO_CLI", fake_cli_path), \
             mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            try:
                code, out, _err = _run_main(self.module, [
                    "check", "--project-dir", self.tmpdir, "--agent", "CR-A-check",
                ])
            finally:
                shutil.rmtree(fake_cli_dir, ignore_errors=True)
        self.assertNotEqual(code, 0, "a failing arduino-cli compile must exit non-zero")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "check")
        self.assertIs(axi.get("ok"), False)
        compile_call = _post_call_for_path(post_mock, "/api/v2/runs/compile")
        self.assertIsNotNone(compile_call, "a failing check must ingest the compile error")
        self.assertIn("expected ';'", compile_call[0][1].get("errors", ""))

    def test_setting_workflow_cycle_id_env_has_no_effect_on_check_verb_ingest(self):
        """CR-CRU-036 §S1: WORKFLOW_CYCLE_ID is REMOVED -- setting it must not
        make a cycleId appear in the compile-error ingest context."""
        os.environ["WORKFLOW_CYCLE_ID"] = "51"
        fake_cli_dir = tempfile.mkdtemp(prefix="fake-arduino-cli-")
        fake_cli_path = os.path.join(fake_cli_dir, "arduino-cli")
        _write_fake_executable(fake_cli_path, _FAKE_ARDUINO_CLI_BODY)
        with mock.patch.object(self.module, "ARDUINO_CLI", fake_cli_path), \
             mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            try:
                code, out, _err = _run_main(self.module, [
                    "check", "--project-dir", self.tmpdir, "--agent", "CR-A-check",
                ])
            finally:
                shutil.rmtree(fake_cli_dir, ignore_errors=True)
        self.assertNotEqual(code, 0, "a failing arduino-cli compile must exit non-zero")
        compile_call = _post_call_for_path(post_mock, "/api/v2/runs/compile")
        self.assertIsNotNone(compile_call, "a failing check must ingest the compile error")
        self.assertIsNone(
            (compile_call[0][1].get("context") or {}).get("cycleId"),
            "WORKFLOW_CYCLE_ID=51 must have NO EFFECT -- the env var is no "
            "longer read anywhere in the client",
        )


if __name__ == "__main__":
    unittest.main()
