"""RED — §S4/AC5–AC7: `project-meta`, a new verb in EACH of the five clients,
through one shared implementation.

A read (`project-meta`, no `--agent`) issues EXACTLY ONE `GET …/metadata` and
reports the map it answered. A write (`project-meta --set K=V [--set K=V …]
[--unset K …] --agent <id>`) issues EXACTLY ONE `PATCH …/metadata` whose body
carries `agentId`, `set` (each `--set` split on the FIRST `=`, so a value may
itself contain `=` and commas) and `unset` (the named keys). A malformed
`--set` — no `=` at all, or an empty key before the first `=` — is refused by
ARGUMENT PARSING, before any request reaches `_get`/`_patch`. A refused or
failed request (read or write) is `ok:false`, carrying the server's `help[]`,
with a non-zero exit — the map read is NOT the tolerant `status`/`landings`
degrade; §S4 says plainly "a refused or failed request is ok:false ... and a
non-zero exit". `--format json` writes the same object as one JSON object,
for a read and for a write (AC6). `--help` names the map's own readability
rule — anything that reaches the board may read it, and it holds non-secret
facts only (AC7).

RED today (confirmed by reading all five clients' argparse wiring): no
client defines a `project-meta` subcommand at all, so every drive below that
tries to run it fails argparse's own subcommand dispatch with
`SystemExit(2)` ("invalid choice: 'project-meta'") — never reaching `_get`/
`_patch` — which is why every assertion after the exit-code check fails for
the right reason (the verb does not exist yet), not a typo or a fixture bug.
The AC7 help-text check fails for the same underlying reason, surfaced as
"no add_parser('project-meta', ...) call exists yet" instead of a missing
substring.

Harness: the exact `_run_main`/`install_project_limits` idiom from
tests/client/test_landings_reads_the_closed_plans.py and
tests/client/test_status_speaks_json_to_programs.py — extended here to mock
BOTH `_get` and `_patch` on the same drive (a read only ever calls one, a
write only ever calls the other; each test asserts the OTHER stayed at zero
calls too, proving "exactly one read" / "exactly one write" rather than
merely "at least one").
"""
# pyright: reportAttributeAccessIssue=false, reportArgumentType=false, reportOptionalMemberAccess=false

import ast
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    declare_and_require_board, install_project_limits)
from tests.client.test_cr054_fleet_inventory import CLIENT_FILES

REPO_ROOT = Path(__file__).resolve().parents[2]

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

PROJECT_KEY = "project-meta-c2"

METADATA_PATH = f"/api/v2/projects/{PROJECT_KEY}/metadata"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched -> (code, stdout, stderr)."""
    full_argv = ["client"] + argv
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


def _project_meta_help_text(path):
    """§S4/AC7 — the help string `project-meta`'s own `add_parser(...)` call
    declares in `path`, via `ast` (never a running import, so this reads the
    SOURCE regardless of whether the verb parses yet). Returns None when no
    `add_parser("project-meta", ...)` call exists at all — today's state,
    reported as a failure below rather than a silently-passing vacuous
    check."""
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_parser"):
            continue
        if not node.args or not isinstance(node.args[0], ast.Constant):
            continue
        if node.args[0].value != "project-meta":
            continue
        for kw in node.keywords:
            if kw.arg == "help" and isinstance(kw.value, ast.Constant):
                return kw.value.value
    return None


# §S3/§S4 — a project's metadata map, as `GET …/metadata` answers it.
_READ_MAP = {"PROJECT_NAME": "widgets", "PROJECT_ACRONYM": "WDG"}
_READ_RESPONSE = {"ok": True, "metadata": _READ_MAP}

# §S2/§S4 — the map `PATCH …/metadata` answers AFTER a `set` + `unset` write:
# the whole map, plus `changed`.
_WRITE_MAP_AFTER = {"PROJECT_NAME": "widgets", "PROJECT_ACRONYM": "WDG",
                    "A": "x=1,2", "B": "y"}
_WRITE_RESPONSE = {"ok": True, "metadata": _WRITE_MAP_AFTER, "changed": True}

# §S2 — a server refusal: `400`/`409`, `help[]`, nothing written.
_REFUSAL_HELP = ["project-meta --set A=v1 --agent <agentId>"]
_REFUSAL_RESPONSE = {"ok": False, "error": "not an environment-variable name",
                    "help": list(_REFUSAL_HELP)}


class _ProjectMetaContractTestBase:
    """A plain MIXIN (no `unittest.TestCase` here) — only the five concrete
    per-client classes below inherit `unittest.TestCase`, so discovery never
    collects this abstract half on its own (the established fleet idiom)."""

    CLIENT = None

    def setUp(self):
        self.module = _load_module(CLIENT_FILES[self.CLIENT],
                                    f"project_meta_c2_{self.CLIENT}_under_test")
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix=f"project-meta-c2-{self.CLIENT}-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            fh.write(f"CRUCIBLE_PROJECT_NAME={PROJECT_KEY}\n")
        install_project_limits(self.tmpdir)
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, extra_argv, get_response=None, patch_response=None):
        """Drives `project-meta` with BOTH `_get` and `_patch` mocked,
        RETURNING both mocks so a test can assert not only what the one it
        cares about received, but that the OTHER one was never touched at
        all — the "exactly one read"/"exactly one write" half of AC5."""
        argv = ["project-meta"] + list(extra_argv) + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_get", return_value=get_response) as mock_get, \
                mock.patch.object(self.module, "_patch", return_value=patch_response) as mock_patch:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, mock_get, mock_patch

    def decode_toon_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"{self.CLIENT}: --format toon stdout must still TOON-decode as "
            f"an 'axi' envelope; got {stdout_text!r}")
        return decoded["axi"]


class ProjectMetaContractTests:
    """§S4/AC5 — the core per-client contract."""

    def test_read_issues_exactly_one_get_to_the_metadata_path_and_reports_the_map(self):
        code, out, err, mock_get, mock_patch = self.drive([], get_response=_READ_RESPONSE)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `project-meta` (no flags) must exist and "
            f"succeed against a reachable board; stdout={out!r} "
            f"stderr={err!r} (RED: the verb is not wired into argparse yet)")
        self.assertEqual(
            mock_get.call_count, 1,
            f"{self.CLIENT}: a bare `project-meta` must issue EXACTLY one "
            f"read; got {mock_get.call_args_list!r}")
        self.assertEqual(
            mock_patch.call_count, 0,
            f"{self.CLIENT}: a bare `project-meta` must issue NO write; got "
            f"{mock_patch.call_args_list!r}")
        called_path = mock_get.call_args[0][0]
        self.assertEqual(
            called_path, METADATA_PATH,
            f"{self.CLIENT}: the one read must target the metadata route "
            f"(§S3); got {called_path!r}")
        axi = self.decode_toon_axi(out)
        self.assertEqual(
            axi.get("metadata"), _READ_MAP,
            f"{self.CLIENT}: the envelope's `metadata` must be exactly the "
            f"map the server returned; got {axi.get('metadata')!r}")
        self.assertNotIn(
            "changed", axi,
            f"{self.CLIENT}: a READ envelope must carry no `changed` key "
            f"(§S4 — only writes carry it); got {axi!r}")

    def test_write_issues_exactly_one_patch_with_the_set_and_unset_body(self):
        code, out, err, mock_get, mock_patch = self.drive(
            ["--set", "A=x=1,2", "--set", "B=y", "--unset", "C",
             "--agent", "fixture-agent-one"],
            patch_response=_WRITE_RESPONSE)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: a well-formed write must succeed against a "
            f"reachable board; stdout={out!r} stderr={err!r} (RED: the "
            f"verb is not wired into argparse yet)")
        self.assertEqual(
            mock_patch.call_count, 1,
            f"{self.CLIENT}: this write must issue EXACTLY one PATCH; got "
            f"{mock_patch.call_args_list!r}")
        self.assertEqual(
            mock_get.call_count, 0,
            f"{self.CLIENT}: a write must issue NO read of its own; got "
            f"{mock_get.call_args_list!r}")
        called_path, called_body = mock_patch.call_args[0][0], mock_patch.call_args[0][1]
        self.assertEqual(
            called_path, METADATA_PATH,
            f"{self.CLIENT}: the one write must target the metadata route "
            f"(§S2); got {called_path!r}")
        self.assertEqual(
            called_body.get("set"), {"A": "x=1,2", "B": "y"},
            f"{self.CLIENT}: `--set A=x=1,2 --set B=y` must split each on "
            f"the FIRST '=' only, so a value may itself hold '=' and ','; "
            f"got {called_body.get('set')!r}")
        self.assertEqual(
            called_body.get("unset"), ["C"],
            f"{self.CLIENT}: `--unset C` must send unset:['C']; got "
            f"{called_body.get('unset')!r}")
        self.assertEqual(
            called_body.get("agentId"), "fixture-agent-one",
            f"{self.CLIENT}: the write body must carry the declared "
            f"--agent as agentId; got {called_body.get('agentId')!r}")
        axi = self.decode_toon_axi(out)
        self.assertEqual(
            axi.get("metadata"), _WRITE_MAP_AFTER,
            f"{self.CLIENT}: the envelope's `metadata` must be exactly the "
            f"whole map the server answered after the write; got "
            f"{axi.get('metadata')!r}")
        self.assertIs(
            axi.get("changed"), True,
            f"{self.CLIENT}: a write's envelope must carry `changed` from "
            f"the server's answer; got {axi.get('changed')!r}")

    def test_a_set_with_no_equals_sign_is_refused_before_any_request(self):
        code, out, err, mock_get, mock_patch = self.drive(
            ["--set", "NOEQUALSSIGN", "--agent", "fixture-agent-two"])
        self.assertEqual(
            code, 2,
            f"{self.CLIENT}: a `--set` with no '=' at all must be refused "
            f"by ARGUMENT PARSING (exit 2); stdout={out!r} stderr={err!r}")
        self.assertNotIn(
            "invalid choice: 'project-meta'", err,
            f"{self.CLIENT}: the refusal must come from VALIDATING the "
            f"malformed --set value itself, not from `project-meta` being "
            f"an unrecognised subcommand (RED: the verb does not exist "
            f"yet); stderr={err!r}")
        self.assertEqual(
            mock_get.call_count, 0,
            f"{self.CLIENT}: a malformed --set must issue NO read; got "
            f"{mock_get.call_args_list!r}")
        self.assertEqual(
            mock_patch.call_count, 0,
            f"{self.CLIENT}: a malformed --set must issue NO write — "
            f"refused BEFORE any request (§S4); got "
            f"{mock_patch.call_args_list!r}")

    def test_a_set_with_an_empty_key_is_refused_before_any_request(self):
        code, out, err, mock_get, mock_patch = self.drive(
            ["--set", "=novalueforakey", "--agent", "fixture-agent-three"])
        self.assertEqual(
            code, 2,
            f"{self.CLIENT}: a `--set` with an empty key (before the "
            f"first '=') must be refused by ARGUMENT PARSING (exit 2); "
            f"stdout={out!r} stderr={err!r}")
        self.assertNotIn(
            "invalid choice: 'project-meta'", err,
            f"{self.CLIENT}: the refusal must come from VALIDATING the "
            f"malformed --set value itself, not from `project-meta` being "
            f"an unrecognised subcommand (RED: the verb does not exist "
            f"yet); stderr={err!r}")
        self.assertEqual(
            mock_get.call_count, 0,
            f"{self.CLIENT}: a malformed --set must issue NO read; got "
            f"{mock_get.call_args_list!r}")
        self.assertEqual(
            mock_patch.call_count, 0,
            f"{self.CLIENT}: a malformed --set must issue NO write — "
            f"refused BEFORE any request (§S4); got "
            f"{mock_patch.call_args_list!r}")

    def test_a_server_refusal_on_write_is_ok_false_with_help_and_nonzero_exit(self):
        code, out, err, mock_get, mock_patch = self.drive(
            ["--set", "lowercase=nope", "--agent", "fixture-agent-four"],
            patch_response=_REFUSAL_RESPONSE)
        self.assertNotEqual(
            code, 0,
            f"{self.CLIENT}: a server-refused write must exit non-zero; "
            f"stdout={out!r} stderr={err!r}")
        axi = self.decode_toon_axi(out)
        self.assertIs(
            axi.get("ok"), False,
            f"{self.CLIENT}: a server-refused write's envelope must be "
            f"ok:false (§S4 — writes do NOT tolerantly degrade); got "
            f"{axi!r}")
        self.assertEqual(
            axi.get("help"), _REFUSAL_HELP,
            f"{self.CLIENT}: the refusal's `help[]` must be the server's "
            f"own, carried verbatim; got {axi.get('help')!r}")

    def test_a_server_refusal_on_read_is_ok_false_with_help_and_nonzero_exit(self):
        refusal = {"ok": False, "error": "unknown project",
                  "help": ["projects"]}
        code, out, err, mock_get, mock_patch = self.drive([], get_response=refusal)
        self.assertNotEqual(
            code, 0,
            f"{self.CLIENT}: a server-refused read must exit non-zero "
            f"(§S4 — unlike `status`/`landings`, a metadata read never "
            f"tolerantly degrades to ok:true); stdout={out!r} "
            f"stderr={err!r}")
        axi = self.decode_toon_axi(out)
        self.assertIs(
            axi.get("ok"), False,
            f"{self.CLIENT}: a server-refused read's envelope must be "
            f"ok:false; got {axi!r}")
        self.assertEqual(
            axi.get("help"), ["projects"],
            f"{self.CLIENT}: the refusal's `help[]` must be the server's "
            f"own, carried verbatim; got {axi.get('help')!r}")

    def test_format_json_for_a_read_writes_one_object_equal_to_the_toon_axi_object(self):
        toon_code, toon_out, toon_err, _tg, _tp = self.drive(
            ["--format", "toon"], get_response=_READ_RESPONSE)
        json_code, json_out, json_err, _jg, _jp = self.drive(
            ["--format", "json"], get_response=_READ_RESPONSE)

        self.assertEqual(
            toon_code, json_code,
            f"{self.CLIENT}: --format toon and --format json must exit "
            f"with the SAME code on a read; toon={toon_code} "
            f"json={json_code}")
        toon_axi = self.decode_toon_axi(toon_out)
        self.assertTrue(
            json_out.lstrip().startswith("{"),
            f"{self.CLIENT}: --format json must write a JSON OBJECT on "
            f"stdout; got {json_out!r}")
        json_obj = json.loads(json_out)
        self.assertIsInstance(
            json_obj, dict,
            f"{self.CLIENT}: the parsed JSON must be a single object; got "
            f"{json_obj!r}")
        self.assertEqual(
            json_obj, toon_axi,
            f"{self.CLIENT}: --format json must write ONE JSON object "
            f"whose keys and values equal the same read's --format toon "
            f"'axi' object; toon={toon_axi!r} json={json_obj!r}")
        self.assertNotIn(
            "axi", json_obj,
            f"{self.CLIENT}: the JSON object must be the UNWRAPPED axi "
            f"object, never re-wrapped under an 'axi' key; got {json_obj!r}")
        self.assertEqual(
            json_obj.get("metadata"), _READ_MAP,
            f"{self.CLIENT}: --format json's 'metadata' must equal the "
            f"server's map; got {json_obj!r}")

    def test_format_json_for_a_write_writes_one_object_equal_to_the_toon_axi_object(self):
        write_argv = ["--set", "A=x=1,2", "--set", "B=y", "--unset", "C",
                     "--agent", "fixture-agent-five"]
        toon_code, toon_out, toon_err, _tg, _tp = self.drive(
            ["--format", "toon"] + write_argv, patch_response=_WRITE_RESPONSE)
        json_code, json_out, json_err, _jg, _jp = self.drive(
            ["--format", "json"] + write_argv, patch_response=_WRITE_RESPONSE)

        self.assertEqual(
            toon_code, json_code,
            f"{self.CLIENT}: --format toon and --format json must exit "
            f"with the SAME code on a write; toon={toon_code} "
            f"json={json_code}")
        toon_axi = self.decode_toon_axi(toon_out)
        self.assertTrue(
            json_out.lstrip().startswith("{"),
            f"{self.CLIENT}: --format json must write a JSON OBJECT on "
            f"stdout; got {json_out!r}")
        json_obj = json.loads(json_out)
        self.assertIsInstance(
            json_obj, dict,
            f"{self.CLIENT}: the parsed JSON must be a single object; got "
            f"{json_obj!r}")
        self.assertEqual(
            json_obj, toon_axi,
            f"{self.CLIENT}: --format json must write ONE JSON object "
            f"whose keys and values equal the same write's --format toon "
            f"'axi' object; toon={toon_axi!r} json={json_obj!r}")
        self.assertNotIn(
            "axi", json_obj,
            f"{self.CLIENT}: the JSON object must be the UNWRAPPED axi "
            f"object, never re-wrapped under an 'axi' key; got {json_obj!r}")
        self.assertEqual(
            json_obj.get("metadata"), _WRITE_MAP_AFTER,
            f"{self.CLIENT}: --format json's 'metadata' must equal the "
            f"whole map after the write; got {json_obj!r}")
        self.assertIs(
            json_obj.get("changed"), True,
            f"{self.CLIENT}: --format json's 'changed' must survive from "
            f"the write's server answer; got {json_obj!r}")


class _AllProjectMetaTests(ProjectMetaContractTests, _ProjectMetaContractTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonProjectMetaTest(_AllProjectMetaTests, unittest.TestCase):
    CLIENT = "python"


class BunProjectMetaTest(_AllProjectMetaTests, unittest.TestCase):
    CLIENT = "bun"


class RustProjectMetaTest(_AllProjectMetaTests, unittest.TestCase):
    CLIENT = "rust"


class MvnProjectMetaTest(_AllProjectMetaTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoProjectMetaTest(_AllProjectMetaTests, unittest.TestCase):
    CLIENT = "arduino"


# ═══════════════════════════════════════════════════════════════════════════
# §S4/AC7 — `project-meta --help` names the map's own readability rule.
# ═══════════════════════════════════════════════════════════════════════════

class Ac7ProjectMetaHelpTest(unittest.TestCase):

    def test_every_client_help_states_the_map_is_openly_readable_and_non_secret_only(self):
        missing = {}
        wrong = {}
        for client, path in CLIENT_FILES.items():
            help_text = _project_meta_help_text(path)
            if help_text is None:
                missing[client] = None
                continue
            lowered = str(help_text).lower()
            if "reaches the board" not in lowered or "non-secret" not in lowered:
                wrong[client] = help_text
        self.assertEqual(
            missing, {},
            f"§S4/AC7 — no `project-meta` subcommand is registered yet in: "
            f"{sorted(missing)!r} (RED: the verb does not exist)")
        self.assertEqual(
            wrong, {},
            f"§S4/AC7 — `project-meta --help` must state that the map is "
            f"readable by anything that reaches the board and holds "
            f"non-secret facts only; offending help text: {wrong!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S4/AC7 (extended, VERIFY cycle 536) — `project-meta --agent`'s help says
# the flag is required for a WRITE, never for every call.
# ═══════════════════════════════════════════════════════════════════════════

def _help_kwarg_literal(node):
    """The LITERAL half of a `help=...` kwarg's value: a bare string constant
    returns itself; `<literal> + extra` (the base-text-plus-extra idiom
    `_add_workflow_agent_arg` uses) returns just the literal LEFT side,
    independent of whatever any one call site's `extra=` appends. Anything
    else (an f-string, a bare name) returns None rather than guessing."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add)
            and isinstance(node.left, ast.Constant) and isinstance(node.left.value, str)):
        return node.left.value
    return None


def _project_meta_agent_help_text(path):
    """§S4/AC7 (extended) — the FULL text `--agent` renders for THIS client's
    `project-meta` subparser specifically: the base text whichever function
    declares `--agent`'s help (`_add_workflow_agent_arg` in four clients, the
    shared `common` parser directly in arduino) PLUS the per-call `extra=`
    the project-meta wiring passes it, if any — read via `ast` (never a
    running import, and never argparse's own line-wrapped `--help`
    rendering, which could split a multi-word phrase like "every workflow
    verb" across two lines and hide a match by accident).

    Returns None when no `project-meta` subparser is registered at all — the
    AC7 test above already reports that as its own failure; this helper is
    never asked to invent a health check for it.
    """
    tree = ast.parse(path.read_text(), filename=str(path))

    pmv_name = None
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)):
            continue
        call = node.value
        if not (isinstance(call.func, ast.Attribute) and call.func.attr == "add_parser"):
            continue
        if not (call.args and isinstance(call.args[0], ast.Constant)
                and call.args[0].value == "project-meta"):
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name):
            pmv_name = target.id
        break
    if pmv_name is None:
        return None

    # The base text `_add_workflow_agent_arg` itself declares (four clients).
    base_text = None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_add_workflow_agent_arg":
            for inner in ast.walk(node):
                if not (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute)
                        and inner.func.attr == "add_argument"):
                    continue
                for kw in inner.keywords:
                    if kw.arg == "help":
                        base_text = _help_kwarg_literal(kw.value)
            break

    if base_text is not None:
        # The per-project-meta-call `extra=` THIS file's own wiring passes:
        # `_add_workflow_agent_arg(pmv, extra=...)`.
        extra_text = ""
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                    and node.func.id == "_add_workflow_agent_arg"):
                continue
            if not (node.args and isinstance(node.args[0], ast.Name)
                    and node.args[0].id == pmv_name):
                continue
            for kw in node.keywords:
                if kw.arg == "extra":
                    extra_text = _help_kwarg_literal(kw.value) or ""
            break
        return base_text + extra_text

    # arduino: `--agent` is declared directly on the shared `common` parser
    # (a parent of project-meta's own subparser), never through
    # `_add_workflow_agent_arg` at all.
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_argument"):
            continue
        if not (node.args and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == "--agent"):
            continue
        for kw in node.keywords:
            if kw.arg == "help":
                return _help_kwarg_literal(kw.value)
    return None


class Ac7ProjectMetaAgentHelpTest(unittest.TestCase):
    """§S4/AC7 (extended, VERIFY cycle 536) — `project-meta`'s `--agent` help
    must say the flag is required for a WRITE (`--set`/`--unset`) and must
    NEVER claim it is required for every call. Today four clients (bun, mvn,
    python, rust) reuse `_add_workflow_agent_arg`'s base text verbatim —
    "REQUIRED (§S2b): every workflow verb posts as a live registered caller"
    — and merely APPEND "Required only for a write (--set/--unset)." rather
    than replacing the blanket claim, so the rendered help holds BOTH the
    correct qualifier and the wrong universal one at once. Arduino's own
    `--agent` help never mentions a write at all. RED against all five
    today, for two different reasons — reported per-client below."""

    def test_every_client_agent_help_requires_a_write_never_every_call(self):
        wrong_every_call = {}
        bare_required = {}
        missing_write_mention = {}
        missing_verb = {}
        for client, path in CLIENT_FILES.items():
            help_text = _project_meta_agent_help_text(path)
            if help_text is None:
                missing_verb[client] = None
                continue
            if "every workflow verb" in help_text:
                wrong_every_call[client] = help_text
            if "REQUIRED" in help_text:
                bare_required[client] = help_text
            if "--set" not in help_text and "write" not in help_text.lower():
                missing_write_mention[client] = help_text
        self.assertEqual(
            missing_verb, {},
            f"§S4/AC7 — no `project-meta` subcommand is registered yet in: "
            f"{sorted(missing_verb)!r}")
        self.assertEqual(
            missing_write_mention, {},
            f"§S4/AC7 (extended) — `project-meta --agent`'s help must say "
            f"the flag is required for a WRITE (--set/--unset); it is "
            f"silent about writing at all in: {missing_write_mention!r}")
        self.assertEqual(
            wrong_every_call, {},
            f"§S4/AC7 (extended) — `project-meta --agent`'s help must "
            f"never claim the flag is required for EVERY call ('every "
            f"workflow verb posts as a live registered caller' is the "
            f"generic per-verb --agent wording (shared by every OTHER "
            f"workflow verb), wrong here since a bare "
            f"`project-meta` read never carries --agent at all); offending: "
            f"{wrong_every_call!r}")
        self.assertEqual(
            bare_required, {},
            f"§S4/AC7 (extended) — `project-meta --agent`'s help must not "
            f"contain a bare, unqualified 'REQUIRED' (only the qualified "
            f"'Required ... for a write' is correct here); offending: "
            f"{bare_required!r}")


# ═══════════════════════════════════════════════════════════════════════════
# TEST GAP (a), VERIFY cycle 536 — `project-meta` against an UNREACHABLE
# board (a real connection-refused, never a stubbed transport).
# ═══════════════════════════════════════════════════════════════════════════

class ProjectMetaUnreachableBoardTest(unittest.TestCase):
    """TEST GAP (a), VERIFY cycle 536 — `project-meta` (read form) against a
    board nothing is listening on: a REAL connection-refused through the
    real client transport (`_get`, never mocked). Driven against
    `python-crucible.py` as the reference client for the ONE shared
    implementation §S4 describes (`cmd_project_meta`/`project_meta_refusal_
    fields` in `clients/_crucible_axi.py`, which every client's own
    `cmd_project_meta` delegates to identically).

    TEST-ONLY gap: this MAY ALREADY PASS. `project-meta`'s read explicitly
    does NOT tolerantly degrade (§S4: "a refused or failed request is
    ok:false ... and a non-zero exit" — unlike `status`/`landings`), so an
    unreachable board should already surface as `ok:false` through the same
    error-shaping every other non-degrading verb uses; reported honestly
    either way in the RED report rather than assumed."""

    def test_project_meta_read_against_an_unreachable_board_is_ok_false_nonzero_exit_with_a_server_check_help(self):
        module = _load_module(CLIENT_FILES["python"],
                              "project_meta_c2_python_unreachable_board_under_test")
        tmpdir = tempfile.mkdtemp(prefix="project-meta-c2-unreachable-")
        saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        try:
            with open(os.path.join(tmpdir, ".env"), "w") as fh:
                fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            install_project_limits(tmpdir)
            # §S2 — the unreachable board is DECLARED in this
            # project's own file (never a stub, never a mocked `_get`): a
            # real socket connect to a closed local port.
            declare_and_require_board(tmpdir, "http://127.0.0.1:1", "python-crucible.py")
            for k in ENV_KEYS:
                os.environ.pop(k, None)
            code, out, err = _run_main(module, ["project-meta", "--project-dir", tmpdir])
        finally:
            for k, v in saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            shutil.rmtree(tmpdir, ignore_errors=True)

        self.assertNotEqual(
            code, 0,
            f"python: `project-meta` against an unreachable board must "
            f"exit non-zero (a metadata read never tolerantly degrades); "
            f"stdout={out!r} stderr={err!r}")
        toon = module._toon()
        decoded = toon.decode(out)
        self.assertIn(
            "axi", decoded,
            f"stdout must still decode as a TOON envelope; got {out!r}")
        axi = decoded["axi"]
        self.assertIs(
            axi.get("ok"), False,
            f"python: an unreachable board must answer ok:false; got {axi!r}")
        help_ = axi.get("help") or []
        self.assertTrue(
            any("board" in str(h).lower() or "server" in str(h).lower()
                or "reach" in str(h).lower() for h in help_),
            f"python: the refusal's help[] must name the SERVER-reachability "
            f"check as the next step; got {help_!r}")

