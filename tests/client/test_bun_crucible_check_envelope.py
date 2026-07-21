"""CR-CRU-030 C2 (cycle 84) -- §S2's "each stack's typecheck/compile gate"
half of the TOON-AXI conversion, applied to `clients/bun-crucible.py`'s
`check` verb.

Contract pinned verbatim from
docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md §S2:
    "Apply CR-013's bun-client pattern ... every AXI verb (`register`,
    `unregister`, `plan-file`, `cycle-activate`, `cycle-done`, `cr-close`,
    and the test/regression/auto-ingest ingest result, plus each stack's
    typecheck/compile gate) returns the §S1 envelope."

RED phase (C2 VERIFY finding, gap 2/SHOULD-FIX): `cmd_check`
(`clients/bun-crucible.py` ~L824) still `print()`s ad-hoc human-readable
lines straight to stdout ("[crucible] running: ...", "[crucible] tsc
exit=...") and never calls the shared `_emit_axi`/§S1 envelope builder at
all -- confirmed by reading the function directly. `toon.decode` on its
captured stdout therefore either raises (the text is not TOON at all) or
yields a dict with no top-level "axi" key -- a real behavioral RED, not a
missing-symbol accident.

Module-loading + mocking convention: copied from the sibling harnesses in
this directory (REPO_ROOT-relative load of `clients/bun-crucible.py`, real
`argparse` dispatch via `module.main()` with `sys.argv` patched). The live
server at :3849 is never touched (`check` issues no HTTP call of its own
without `--agent`); the `tsc` invocation itself is mocked directly via
`subprocess.run` so no real `bun`/`tsc` binary is required on the test host.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_check_envelope.py -q
Fallback:
    python3 tests/client/test_bun_crucible_check_envelope.py
"""

import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"


def _load_bun_crucible_module():
    """Load clients/bun-crucible.py by file path (hyphenated filename can't be
    `import`ed normally) -- pointed at the REPO copy (the SOURCE OF TRUTH,
    CR-CRU-008 Risk section)."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_checkenvelope", SCRIPT_PATH)
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


class CheckEnvelopeTest(unittest.TestCase):
    PROJECT_KEY = "test-key-check-envelope"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-check-envelope-")
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

    def _mock_tsc(self, returncode, stdout="", stderr=""):
        return subprocess.CompletedProcess(
            args=["bun", "x", "tsc", "--noEmit"], returncode=returncode,
            stdout=stdout, stderr=stderr,
        )

    def test_check_emits_toon_envelope_with_context_on_clean_compile(self):
        with mock.patch.object(self.module.subprocess, "run",
                                return_value=self._mock_tsc(0)):
            code, out, err = _run_main(self.module, [
                "check", "--project-dir", self.tmpdir, "--package-dir", self.tmpdir,
            ])

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "check")
        self.assertIs(axi.get("ok"), True)
        context = axi.get("context")
        self.assertIsInstance(context, dict)
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY)

    def test_check_emits_toon_envelope_with_context_on_compile_error(self):
        error_text = "src/foo.ts(1,1): error TS1234: bad type\n"
        with mock.patch.object(self.module.subprocess, "run",
                                return_value=self._mock_tsc(2, stdout=error_text)):
            code, out, err = _run_main(self.module, [
                "check", "--project-dir", self.tmpdir, "--package-dir", self.tmpdir,
            ])

        self.assertNotEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "check")
        self.assertIs(axi.get("ok"), False)
        context = axi.get("context")
        self.assertIsInstance(context, dict)
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY)


if __name__ == "__main__":
    unittest.main()
