"""The plain helpers of `test_plan_file_names_the_release_it_plans.py`, lifted
out of that test module so a suite importing them does not import a test
module (CR-CRU-261).

Holds no test: the fleet's client scripts, the env keys a drive clears, a
by-path module loader, the in-process `main()` driver, and the wire-seam base
`_PlanFileWireTestBase` (a `TestCase` with no test of its own) that
`test_plan_file_names_the_release_it_plans_without_a_board` and
`test_plan_file_declares_each_cycle_kind` build on.
"""

import contextlib
import copy
import importlib.util
import io
import os
import sys
import unittest
from unittest import mock

from tests.client import TEST_INSTALL_CLIENTS
import ast
import json
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from tests.client import CLIENT_SOURCE_DIR, client_script
from tests.client.client_fleet_envelope_census_helpers import declare_and_require_board

CLIENTS_DIR = TEST_INSTALL_CLIENTS

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)

# The env keys the fleet's `context` block reads. Cleared in every drive so an
# ambient orchestrator session can never colour an envelope asserted on here.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")


def _load_module_by_path(path, module_name):
    """Load a hyphen-named client (or the shared module) by file path — the
    fleet harness idiom. A missing file raises rather than skipping."""
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Drive the REAL argparse dispatch of a client's `main()` with `sys.argv`
    patched → (exit code, stdout, stderr). Only SystemExit is caught, so an
    argparse refusal arrives as a normal non-zero exit while any OTHER
    exception still surfaces as an ERROR rather than being swallowed."""
    stdout, stderr = io.StringIO(), io.StringIO()
    # os.environ is restored on exit: arduino's main() exports $AGENT_ID from --agent for its
    # children, which would otherwise leak into every later test in this process.
    with mock.patch.object(sys, "argv", ["client.py"] + list(argv)), mock.patch.dict(os.environ):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


REPO_ROOT = Path(__file__).resolve().parents[2]

AXI_MODULE = client_script("_crucible_axi.py")

# The criterion asserts the flag PER CLIENT *and* asserts the count of clients
# it drove: a loop over a collection is satisfied by a collection of one, and a
# fleet-wide claim proven on one client is the exact defect this prevents.
EXPECTED_CLIENT_COUNT = 5

VERB = "plan-file"

PLANS_PATH_SUFFIX = "/plans"

# Nothing listens on port 1 without root — the fleet's help-drive idiom. A
# `--help` never reaches the wire, but a drive that somehow did must refuse
# instantly rather than touch a live board.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"

_PROJECT_DIR = None

_HELP_CACHE = {}


def setUpModule():
    global _PROJECT_DIR
    _PROJECT_DIR = tempfile.mkdtemp(prefix="plan-file-release-surface-")
    (Path(_PROJECT_DIR) / ".env").write_text(
        "CRUCIBLE_PROJECT_KEY=plan-file-release-surface-key\n"
        "CRUCIBLE_PROJECT_NAME=plan-file-release-surface-project\n")
    # CR-CRU-139 §S2 — the surface drives declare the unreachable board in
    # their own project file, which is where a client reads it now. A `--help`
    # never reaches the wire; one that somehow did refuses instantly instead
    # of touching a live board.
    declare_and_require_board(_PROJECT_DIR, _UNREACHABLE_CRUCIBLE_URL,
                              "a help drive")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


def _drive_plan_file_help(client):
    """A genuine subprocess dispatch of a real client script's own
    `plan-file --help`, cached per client for this process."""
    if client not in _HELP_CACHE:
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        # CR-CRU-139 §S2 — the board is DECLARED, never exported. A `--help`
        # drive reaches no board at all (argparse prints and exits before any
        # verb body runs), so the declaration `_PROJECT_DIR` already carries
        # from `setUpModule` is all this drive needs.
        # COLUMNS is PINNED (added 2026-09-13, CR-CRU-127 C2 FIX) so argparse's
        # wrap width is deterministic across terminals and CI. It is not
        # cosmetic: argparse wraps help through `textwrap` with
        # `break_on_hyphens=True`, so a hyphenated kind name (`red-green`) may
        # be split across a line boundary and read back as `red- green` once
        # the continuation lines are joined. The §S6 assertions below ask
        # whether the help NAMES each kind, and whitespace normalisation alone
        # cannot undo that split — while a `"- " -> "-"` rewrite would let a
        # genuine `red- green` regression pass. A wide, fixed terminal removes
        # the wrap instead of papering over it, which is the same defence the
        # fleet census already relies on.
        #
        # The hazard is MEASURED, not theoretical: at the 80-column fallback a
        # non-tty subprocess gets when COLUMNS is unset, this very help already
        # splits `cr-plan` into `cr-` / `plan` inside `--cr`'s entry. No
        # assertion reads that word today, which is the only reason it has
        # never been red — the split is one reworded sentence away from landing
        # on a kind name instead.
        env["COLUMNS"] = "200"
        _HELP_CACHE[client] = subprocess.run(
            [sys.executable, str(CLIENT_FILES[client]), VERB, "--help"],
            cwd=_PROJECT_DIR, env=env, capture_output=True, text=True,
            timeout=60)
    return _HELP_CACHE[client]


def _plan_file_parser_names(path):
    """The variable name(s) a client binds its `plan-file` subparser to."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Assign):
            continue
        call = node.value
        if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == "add_parser" and call.args
                and isinstance(call.args[0], ast.Constant)
                and call.args[0].value == VERB):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return names


def _flags_declared_directly_on(path, parser_names):
    """Every flag a file declares by calling `<parser>.add_argument("--x", …)`
    on one of `parser_names` — the client's OWN declarations."""
    flags = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_argument"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in parser_names
                and node.args and isinstance(node.args[0], ast.Constant)):
            flags.add(node.args[0].value)
    return flags


def _called_function_names(node):
    """The callee names reachable from `node`, in either spelling a client
    uses: a bare `helper(...)` or the shared module's `_axi().helper(...)`."""
    names = set()
    for inner in ast.walk(node):
        if not isinstance(inner, ast.Call):
            continue
        if isinstance(inner.func, ast.Name):
            names.add(inner.func.id)
        elif isinstance(inner.func, ast.Attribute):
            names.add(inner.func.attr)
    return names


def _functions_handed_the_parser(path, parser_names):
    """The names of every function a file calls WITH its plan-file subparser as
    an argument — the argument-registration seam (`_add_project_dir_arg(pf)`),
    plus, one hop on, whatever those client-local helpers themselves call. One
    hop is what the fleet's own delegator idiom needs: a client helper whose
    body is `return _axi().add_x(...)`."""
    tree = ast.parse(path.read_text())
    direct = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        handed = any(isinstance(a, ast.Name) and a.id in parser_names for a in node.args)
        handed = handed or any(
            isinstance(kw.value, ast.Name) and kw.value.id in parser_names
            for kw in node.keywords)
        if not handed:
            continue
        if isinstance(node.func, ast.Name):
            direct.add(node.func.id)
        elif isinstance(node.func, ast.Attribute):
            direct.add(node.func.attr)
    reachable = set(direct)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in direct:
            reachable |= _called_function_names(node)
    return reachable


def _shared_functions_declaring(flag):
    """The top-level functions of the SHARED module whose body declares `flag`
    through an `add_argument(...)` call."""
    tree = ast.parse((CLIENT_SOURCE_DIR / AXI_MODULE.name).read_text())
    declaring = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for inner in ast.walk(node):
            if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute)
                    and inner.func.attr == "add_argument" and inner.args
                    and isinstance(inner.args[0], ast.Constant)
                    and inner.args[0].value == flag):
                declaring.add(node.name)
    return declaring


def _http(base, path, payload=None, method=None):
    """One JSON call against the scratch server. A non-2xx still carries the
    server's structured body, which IS the assertion subject for a refusal."""
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if data else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the wire: the declared release reaches the POST body
# ═══════════════════════════════════════════════════════════════════════════
#
# Recorded at the TRANSPORT seam (`_post`), never at the shared verb: the
# payload is composed inside `cmd_plan_file`, so a recorder above it would
# assert on the client's arguments rather than on the bytes the server gets.


class _PlanFileWireTestBase(unittest.TestCase):

    PROJECT_KEY = "plan-file-release-wire-key"
    AGENT = "plan-file-release-wire-agent"
    CR = "CR-121-WIRE"

    def setUp(self):
        self.module = _load_module_by_path(
            CLIENT_FILES["python"], "plan_file_release_client_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="plan-file-release-wire-")
        (Path(self.tmpdir) / ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
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

    def drive(self, *extra):
        """One client dispatch with the transport recorded → (code, stdout,
        stderr, the payloads that reached the plans route)."""
        posted = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            return {"ok": True, "planId": 1, "cr": self.CR,
                    "status": "open", "cycles": [{"label": "red-green", "id": 7}]}

        # CR-CRU-127 §S4 — a filed cycle declares its kind, so the fixture
        # call declares one. (The label happens to read `red-green` too; it is
        # this suite's original fixture label, kept so the release assertions
        # stay byte-comparable with what they pinned before.)
        argv = [VERB, "--cr", self.CR, "--title", "the wire under test",
                "--cycle", "red-green", "--cycle-kind", "red-green",
                "--wave", "6", "--agent", self.AGENT,
                "--project-dir", self.tmpdir] + list(extra)
        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, [p for path, p in posted
                                if path.endswith(PLANS_PATH_SUFFIX)]

    def the_one_plan_file_payload(self, *extra):
        """Drive and return the SINGLE payload that reached the plans route.
        The count is asserted, not assumed: a verb that refused its flags posts
        nothing, and a body read off an empty list would fail as an IndexError
        naming neither the verb nor its refusal."""
        code, _out, err, payloads = self.drive(*extra)
        self.assertEqual(
            len(payloads), 1,
            f"exactly ONE plan-file POST must reach the plans route for "
            f"{extra!r}; got {len(payloads)} (exit={code}, "
            f"stderr={err.strip()[:400]!r})")
        return payloads[0]
