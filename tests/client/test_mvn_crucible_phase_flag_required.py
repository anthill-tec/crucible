"""CR-CRU-044 C3 RED -- §S3 `--phase` becomes required + enum-constrained on
`clients/mvn-crucible.py`'s `register` verb; §S4 the client `--help` stops
implying the agentId carries the phase.

Contract pinned verbatim from
docs/changes/CR-CRU-044-phase-as-first-class-data.md §S3/§S4 (as corrected
2026-07-28). `mvn-crucible.py:1744` has the correct enum already but ALSO
`default="report"`, so `--phase` is optional today. §S3's mvn-specific work
is "drop the default -> required".

RED phase: confirmed live (`python3 clients/mvn-crucible.py register --agent
x --project-dir /tmp` succeeds with code 0, no `--phase` supplied; `--help`'s
usage line still wraps `--phase {...}` in `[...]`) -- every test below fails
for a real behavioural reason, not a missing-import accident.

Module-loading + HTTP-mocking convention copied verbatim from the sibling
`test_mvn_crucible_axi.py` harness in this directory.

Invocation:
    python3 -m pytest tests/client/test_mvn_crucible_phase_flag_required.py -q
Fallback:
    python3 tests/client/test_mvn_crucible_phase_flag_required.py
"""

import contextlib
import importlib.util
import io
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "mvn-crucible.py"

PHASE_ENUM = ("RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report")
PHASE_ENUM_TEXT = "{" + ",".join(PHASE_ENUM) + "}"

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text):
    return _ANSI_RE.sub("", text)


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module():
    return _load_module(SCRIPT_PATH, "mvn_crucible_under_test_phase_flag")


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, stdout, stderr)."""
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


class _BasePhaseFlagTest(unittest.TestCase):
    PROJECT_KEY = "test-key-mvn-phase-flag"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
                "FORCE_COLOR", "NO_COLOR")

    def setUp(self):
        self.module = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="mvn-crucible-phase-flag-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        os.environ["NO_COLOR"] = "1"

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _active_cycle_plans(self, active_id=9003):
        return _open_plans_response([
            {"planId": "plan-active", "cr": "CR-CRU-044", "status": "open",
             "cycles": [{"id": active_id, "status": "active"},
                        {"id": active_id - 1, "status": "done"}]},
        ])

    def _run_register(self, argv, post_return=None, get_return=None):
        post_return = post_return if post_return is not None else {"ok": True}
        get_return = get_return if get_return is not None else self._active_cycle_plans()
        with mock.patch.object(self.module, "_post", return_value=post_return,
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=get_return,
                                create=True):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock


class PhaseBecomesRequiredTest(_BasePhaseFlagTest):
    def test_omitting_phase_now_required_but_valid_phase_still_registers(self):
        code, out, err, post_mock = self._run_register(
            ["register", "--agent", "mvn-phase-1", "--project-dir", self.tmpdir])
        self.assertEqual(
            code, 2,
            f"omitting --phase must fail ARGUMENT PARSING (argparse exit 2) once "
            f"--phase is required; stdout={out!r} stderr={err!r}",
        )
        err_clean = _strip_ansi(err)
        self.assertIn("--phase", err_clean)
        self.assertIn("required", err_clean.lower())
        for value in PHASE_ENUM:
            self.assertIn(value, err_clean)
        self.assertIsNone(_post_call_for_path(post_mock, "/api/v2/agents/register"))

        code2, out2, _err2, post_mock2 = self._run_register(
            ["register", "--agent", "mvn-phase-1", "--phase", "GREEN",
             "--project-dir", self.tmpdir])
        self.assertEqual(code2, 0, f"stdout={out2!r}")
        call = _post_call_for_path(post_mock2, "/api/v2/agents/register")
        self.assertIsNotNone(call, "a valid --phase must reach POST /api/v2/agents/register")
        payload = call.args[1]
        self.assertEqual(payload.get("phase"), "GREEN")


class PhaseHelpSurfaceTest(_BasePhaseFlagTest):
    def test_register_help_lists_phase_as_required_with_full_enum(self):
        code, out, _err, _pm = self._run_register(["register", "--help"])
        self.assertEqual(code, 0, f"--help must exit 0; stdout={out!r}")
        help_text = _strip_ansi(out)
        self.assertIn(f"--phase {PHASE_ENUM_TEXT}", help_text)
        self.assertNotIn(
            f"[--phase {PHASE_ENUM_TEXT}]", help_text,
            "the usage synopsis must no longer show --phase as OPTIONAL once required",
        )

    def test_register_help_documents_agentid_as_free_form_identifier(self):
        code, out, _err, _pm = self._run_register(["register", "--help"])
        self.assertEqual(code, 0, f"stdout={out!r}")
        help_text = _strip_ansi(out).lower()
        self.assertIn(
            "free-form", help_text,
            f"§S4: --help must state the agentId is a free-form identifier; got {out!r}",
        )


if __name__ == "__main__":
    unittest.main()
