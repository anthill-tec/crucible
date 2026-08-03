"""CR-CRU-044 C3 RED -- §S3 `--role` becomes required + enum-constrained on
`clients/bun-crucible.py`'s `register` verb; §S4 the client `--help` stops
implying the agentId carries the role.

Contract pinned verbatim from
docs/changes/CR-CRU-044-phase-as-first-class-data.md §S3/§S4 (as corrected
2026-07-28 -- see the table at line 91 of that doc, confirmed directly
against this file's source, NOT re-derived):

  bun `clients/bun-crucible.py:1856` already has `choices=[...]` (the enum is
  already correct) but ALSO `default="report"`, so `--role` is optional
  today. §S3's bun-specific work is "drop the default -> required". §S4
  wants the client `--help` to state the agentId is a free-form identifier
  (never a role channel) rather than only offering the id-template as an
  example.

RED phase: `clients/bun-crucible.py:1856` today reads
    r.add_argument("--role", default="report",
                   choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"])
so every test below fails for a real behavioural reason (confirmed by
running `python3 clients/bun-crucible.py register --agent x --role banana`
`... --project-dir /tmp` today -- omitting `--role` succeeds with code 0
(defaults to "report"); the `--help` usage line still wraps `--role` in
`[...]` (optional) and never says "free-form"), not a missing-import
accident.

Module-loading + HTTP-mocking convention copied verbatim from the sibling
`test_bun_crucible_toon_envelope.py` harness in this directory: load
`clients/bun-crucible.py` by file path via `importlib`, real `argparse`
dispatch via `module.main()` with `sys.argv` patched, mock the module's
`_post`/`_get` HTTP transport seam so the live Crucible server on :3849 is
NEVER touched. `NO_COLOR`/stripped-ANSI handling is needed because Python
3.13+'s argparse colourises `--help`/error output when `FORCE_COLOR` is set
in the environment (confirmed live: this shell exports `FORCE_COLOR=3`),
which would otherwise break plain substring assertions on the usage line.

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_role_flag_required.py -q
Fallback:
    python3 tests/client/test_bun_crucible_role_flag_required.py
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
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

ROLE_ENUM = ("RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report")
ROLE_ENUM_TEXT = "{" + ",".join(ROLE_ENUM) + "}"

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
    return _load_module(SCRIPT_PATH, "bun_crucible_under_test_role_flag")


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, stdout, stderr).
    Only SystemExit is caught -- any OTHER exception propagates so unittest
    reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["bun-crucible.py"] + argv
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


class _BaseRoleFlagTest(unittest.TestCase):
    PROJECT_KEY = "test-key-bun-role-flag"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
                "FORCE_COLOR", "NO_COLOR")

    def setUp(self):
        self.module = _load_client_module()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-role-flag-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        # Force plain (uncoloured) argparse output regardless of the host
        # shell's FORCE_COLOR, so --help/error assertions are deterministic.
        os.environ["NO_COLOR"] = "1"

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _active_cycle_plans(self, active_id=9001):
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


class RoleBecomesRequiredTest(_BaseRoleFlagTest):
    def test_omitting_role_now_required_but_valid_role_still_registers(self):
        # Missing --role: today (RED) this succeeds with the "report"
        # default -- code 0 -- so this assertion fails until GREEN drops the
        # default and adds required=True.
        code, out, err, post_mock = self._run_register(
            ["register", "--agent", "bun-role-1", "--project-dir", self.tmpdir])
        self.assertEqual(
            code, 2,
            f"omitting --role must fail ARGUMENT PARSING (argparse exit 2) once "
            f"--role is required; stdout={out!r} stderr={err!r}",
        )
        err_clean = _strip_ansi(err)
        self.assertIn("--role", err_clean)
        self.assertIn("required", err_clean.lower())
        for value in ROLE_ENUM:
            self.assertIn(
                value, err_clean,
                f"the accepted enumeration must be named in the error; missing {value!r} "
                f"in stderr={err_clean!r}",
            )
        self.assertIsNone(
            _post_call_for_path(post_mock, "/api/v2/agents/register"),
            "a rejected argument parse must never reach the register POST",
        )

        # A VALID --role must still work end-to-end (the C1 wire behaviour
        # must not regress) and post the EXACT declared role.
        code2, out2, _err2, post_mock2 = self._run_register(
            ["register", "--agent", "bun-role-1", "--role", "GREEN",
             "--project-dir", self.tmpdir])
        self.assertEqual(code2, 0, f"stdout={out2!r}")
        call = _post_call_for_path(post_mock2, "/api/v2/agents/register")
        self.assertIsNotNone(call, "a valid --role must reach POST /api/v2/agents/register")
        payload = call.args[1]
        self.assertEqual(payload.get("role"), "GREEN")


class RoleHelpSurfaceTest(_BaseRoleFlagTest):
    def test_register_help_lists_role_as_required_with_full_enum(self):
        code, out, _err, _pm = self._run_register(["register", "--help"])
        self.assertEqual(code, 0, f"--help must exit 0; stdout={out!r}")
        help_text = _strip_ansi(out)
        # The enum must be listed ...
        self.assertIn(
            f"--role {ROLE_ENUM_TEXT}", help_text,
            f"the full enum must appear in --help; got {help_text!r}",
        )
        # ... and --role must be REQUIRED (argparse renders a required
        # optional flag WITHOUT the enclosing usage brackets). Today it is
        # still optional, so this bracketed form is still present -- this
        # assertion fails until GREEN drops the default and sets required=True.
        self.assertNotIn(
            f"[--role {ROLE_ENUM_TEXT}]", help_text,
            "the usage synopsis must no longer show --role as OPTIONAL "
            "(wrapped in [...]) once it is required",
        )

    def test_register_help_documents_agentid_as_free_form_identifier(self):
        code, out, _err, _pm = self._run_register(["register", "--help"])
        self.assertEqual(code, 0, f"stdout={out!r}")
        help_text = _strip_ansi(out).lower()
        self.assertIn(
            "free-form", help_text,
            "§S4: the --agent help text must state the agentId is a free-form "
            "identifier (role is declared via --role, never inferred from "
            f"the agentId's shape); got help={out!r}",
        )


if __name__ == "__main__":
    unittest.main()
