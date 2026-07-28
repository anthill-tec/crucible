"""CR-CRU-030 §S8 (cycle 83, C1 slice 2) -- `gate-run` becomes the AXI
streaming standard; `gate-report` is discouraged via a `prefer-gate-run`
warning. Both must return the §S1 TOON-AXI envelope.

Contract pinned verbatim from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:

  §S8 -- "make `gate-run` the STANDARD and DISCOURAGE `gate-report`: on every
  client, `gate-report` emits a `prefer-gate-run` warning (envelope
  `warnings[]` + stderr) naming `gate-run` as the expected streaming use ...
  Both gate verbs return the §S1 envelope like every other verb."

  AC (verbatim) -- "`gate-run` and `gate-report` return the §S1 envelope on
  all five clients; `gate-report` additionally emits a `prefer-gate-run`
  warning (envelope `warnings[]` + stderr) naming `gate-run` as the streaming
  standard; `gate-run` emits no such warning."

RED phase: `clients/bun-crucible.py` today (`cmd_gate_report`/`cmd_gate_run`,
CR-CRU-013 §S4c/§S5) `print()` a single ad-hoc human-readable line to stdout
(`f"gate-report: ok={ok} outcome=..."` / `f"gate-run: ok={ok} outcome=..."`)
and never call `_emit_axi`/`clients/toon.py`'s `encode()` for either verb --
confirmed by reading `cmd_gate_report`/`cmd_gate_run` directly
(bun-crucible.py:1307-1401). Neither function references a `prefer-gate-run`
warning anywhere. Every envelope-decode assertion below therefore fails
(stdout is plain text, not TOON, or lacks a top-level "axi" key) -- real
behavioral RED, not a missing-symbol accident.

This file does NOT re-test `gate-run`'s interim-poll/throttling/relay
mechanics -- that is already covered exhaustively by the sibling
`test_bun_crucible_gates.py` (`GateRunAxiProxyTest`), unaffected by this
slice. It uses a MUCH simpler fake `no-mistakes` (a single immediate final
snapshot, no interim ladder) since this file's only new assertions are (a)
the §S1 envelope's presence in `gate-run`'s stdout alongside the relayed axi
detail, and (b) the ABSENCE of a `prefer-gate-run` warning there.

Module-loading + HTTP-mocking convention: copied verbatim from the sibling
`test_bun_crucible_gates.py` harness (REPO_ROOT-relative load, real argparse
dispatch via `module.main()`, mocking `_post`/`_get` so :3849 is never
touched).

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_gate_axi.py -q
Fallback:
    python3 tests/client/test_bun_crucible_gate_axi.py
"""

import contextlib
import copy
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
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

# A distinctive marker planted in the fake `no-mistakes`'s final snapshot --
# proves gate-run's relay behavior (already pinned by the sibling
# GateRunAxiProxyTest) is undisturbed by this slice's envelope addition.
_RELAY_MARKER = "gate-axi-relay-marker-xyz789"

_FINAL_SNAPSHOT = (
    'run:\n'
    '  id: "gate-axi-test-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
    'outcome: passed\n'
)

# A minimal fake `no-mistakes`: BOTH `axi run` and `axi status` return the
# SAME already-resolved final snapshot immediately (no sleep, no interim
# ladder) -- this file only needs a single resolved final gate, not the
# throttled-interim-polling mechanics (covered elsewhere).
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


def _load_bun_crucible_module():
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_gateaxi", SCRIPT_PATH)
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


class _BaseGateAxiTest(unittest.TestCase):
    PROJECT_KEY = "test-key-override-me"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-gateaxi-")
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

    def _post_recorder(self, calls, ok=True, error=None):
        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return {"ok": ok} if ok else {"ok": False, "error": error or "boom"}
        return fake_post


# ── gate-report -- must emit the §S1 envelope + a prefer-gate-run warning ──


class GateReportAxiEnvelopeTest(_BaseGateAxiTest):
    PROJECT_KEY = "test-key-gatereport-axi"

    def _base_argv(self):
        return ["gate-report", "--outcome", "passed", "--commit", "abc1234",
                "--steps", "review:passed,test:passed", "--agent", "test-agent",
                "--project-dir", self.tmpdir]

    def test_gate_report_envelope_decodes_with_verb_ok_and_outcome(self):
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._base_argv())

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        decoded = self.toon.decode(out)
        self.assertIn("axi", decoded,
                      f"gate-report stdout must decode to a §S1 envelope; got out={out!r}")
        axi = decoded["axi"]
        self.assertEqual(axi.get("verb"), "gate-report")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("outcome"), "passed")

    def test_gate_report_emits_prefer_gate_run_warning_in_envelope_and_stderr_on_success(self):
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._base_argv())

        self.assertEqual(code, 0)
        decoded = self.toon.decode(out)
        self.assertIn("axi", decoded,
                      f"gate-report stdout must decode to a §S1 envelope; got out={out!r}")
        axi = decoded["axi"]
        warnings_list = axi.get("warnings", [])
        codes = [w.get("code") for w in warnings_list]
        self.assertIn("prefer-gate-run", codes,
                       f"gate-report must warn to prefer gate-run; got warnings={warnings_list!r}")
        matching = [w for w in warnings_list if w.get("code") == "prefer-gate-run"]
        self.assertIn("gate-run", matching[0].get("detail", ""),
                      "the warning detail must NAME gate-run as the streaming standard")
        self.assertIn("prefer-gate-run", err,
                      "the prefer-gate-run warning must ALSO surface on stderr")

    def test_gate_report_emits_prefer_gate_run_warning_even_when_server_rejects(self):
        """The discouragement is a PROPERTY of using gate-report at all, not
        conditioned on the underlying POST succeeding -- a bare 'warns on
        success' assertion would leave the failure path unguarded."""
        calls = []
        with mock.patch.object(self.module, "_post",
                                side_effect=self._post_recorder(
                                    calls, ok=False, error="gate.outcome must be one of: ...")):
            code, out, err = _run_main(self.module, self._base_argv())

        self.assertNotEqual(code, 0)
        decoded = self.toon.decode(out)
        self.assertIn("axi", decoded,
                      f"gate-report stdout must decode to a §S1 envelope even on failure; "
                      f"got out={out!r}")
        axi = decoded["axi"]
        self.assertIs(axi.get("ok"), False)
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertIn("prefer-gate-run", codes,
                       f"the warning must fire regardless of POST outcome; got {axi!r}")


# ── gate-run -- must emit the §S1 envelope; must NOT warn ──


class GateRunAxiEnvelopeTest(_BaseGateAxiTest):
    PROJECT_KEY = "test-key-gaterun-axi"

    def setUp(self):
        super().setUp()
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-axi-bin-")
        fake_path = os.path.join(self.fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        st = os.stat(fake_path)
        os.chmod(fake_path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

    def tearDown(self):
        os.environ["PATH"] = self._saved_path
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        super().tearDown()

    def test_gate_run_stdout_contains_a_decodable_axi_envelope_alongside_the_relay(self):
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, [
                "gate-run", "--intent", "verify the refactor", "--agent", "test-agent",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        # The underlying axi run detail is still relayed to the caller's own
        # stdout (proxy role, pre-existing contract -- unaffected here).
        self.assertIn(_RELAY_MARKER, out,
                       "gate-run must still relay the no-mistakes axi detail to its own stdout")
        # NEW in this slice: gate-run's OWN §S1 envelope must also be present
        # and decodable on stdout.
        decoded = self.toon.decode(out)
        self.assertIn("axi", decoded,
                      f"gate-run stdout must ALSO carry a decodable §S1 envelope; got out={out!r}")
        axi = decoded["axi"]
        self.assertEqual(axi.get("verb"), "gate-run")
        self.assertIs(axi.get("ok"), True)

    def test_gate_run_emits_no_prefer_gate_run_warning(self):
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, [
                "gate-run", "--intent", "verify the refactor", "--agent", "test-agent",
                "--project-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertNotIn("prefer-gate-run", out,
                          "gate-run is itself the streaming standard -- it must never "
                          "warn to prefer itself")
        self.assertNotIn("prefer-gate-run", err)
        decoded = self.toon.decode(out)
        # A bare "no warning" check would ALSO pass vacuously today (gate-run
        # emits no §S1 envelope AT ALL yet, so obviously no warning inside
        # one) -- require the envelope to genuinely exist first, so this test
        # actually discriminates "correctly un-warned" from "not built yet".
        self.assertIn("axi", decoded,
                      f"gate-run stdout must carry a decodable §S1 envelope (with an empty "
                      f"warnings[]) for this absence check to mean anything; got out={out!r}")
        axi = decoded["axi"]
        codes = [w.get("code") for w in axi.get("warnings", [])]
        self.assertNotIn("prefer-gate-run", codes)


if __name__ == "__main__":
    unittest.main()
