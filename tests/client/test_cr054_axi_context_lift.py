"""CR-CRU-054 C3 -- AXI/context-layer lift RED tests.

Pins this cycle's slice of the client-fleet lift
(docs/changes/CR-CRU-054-client-fleet-dry.md SS2) for the AXI/context helpers
named in the dispatch brief: `_emit_axi`, `_axi_context`, `_run_context`,
`_agent_id`, `_axi`, `_toon`, `_open_plans`, `_plans_path`,
`_resolve_plan_or_emit`.

Cross-checked against docs/research/DN-client-fleet-inventory.md SS1 before
writing anything (all 9 candidates ARE classified SHARED there -- none is
PARAMETERISED, GENUINELY_PER_CLIENT or DRIFTED, so nothing in this slice
needs excluding on classification grounds, unlike C2's `_project_key`
exclusion).

ESCALATION-style note (documented, not acted on unilaterally) -- THREE of the
nine candidates are EXCLUDED from this file because reading all five clients'
actual bodies shows they are ALREADY fully lifted, not merely "classified
SHARED":

  * `_axi_context`, `_emit_axi`, `_agent_id` each already have a THIN body in
    all five clients that does nothing but delegate --
    `_axi().axi_context(...)`, `_axi().emit_axi(...)`,
    `_axi().require_agent_id(args)` respectively -- and the real logic
    (`axi_context`, `emit_axi`, `require_agent_id`) already lives in
    `clients/_crucible_axi.py` (landed by CR-CRU-030/CR-CRU-044 SS5). Every
    one of the five client bodies was read in full for this cycle
    (bun/rust/mvn/python/arduino-crucible.py) and all five are
    byte-identical delegators today. There is no production gap left to pin
    as a failing test for these three -- a test asserting "the real logic
    lives in ONE locus" for them would PASS right now, which is not a valid
    RED signal (see the sub-agent RED discipline: a test that passes on
    first run is testing nothing new). Flagged for the orchestrator to
    confirm; not treated as a DN classification error (the SHARED bucket is
    correct for all three -- the classification says nothing about whether
    the lift already happened).

The other six DO carry real, independently-duplicated logic in all five
clients today (confirmed by reading each body -- exact line numbers in each
test class's docstring below), so this file pins:

  1. `_run_context` -- env + `subprocess.run` git lookup (CR-CRU-008 SS2).
  2. `_plans_path` -- the plans-collection URL template.
  3. `_open_plans` -- the status:"open" filter + hard-exit-on-GET-failure.
  4. `_resolve_plan_or_emit` -- the GET-plans / none-or-ambiguous
     legacy-message / ok:false-envelope prelude (the plan SELECTION itself,
     `resolve_single_plan`, is ALREADY shared and delegated to via
     `_axi().resolve_single_plan(...)` -- only the surrounding orchestration
     is still duplicated).
  5/6. `_axi`, `_toon` -- these CANNOT have their loader logic moved into
     `clients/_crucible_axi.py` itself (that would be `_axi()` loading the
     very file it is trying to load -- a bootstrap paradox this cycle is not
     asked to solve). DN SS1's own note names the ONLY change it asks for:
     the `importlib.util.spec_from_file_location(...)` cache-key string is
     TODAY a hand-typed per-client literal ("bun_crucible_axi_shared" /
     "rust_crucible_toon" / ...) -- "an internal loader-cache label never
     observed outside the function" that should stop being even a COSMETIC
     difference by deriving it from `__name__` instead of hardcoding it.

Test design note (matching C2's committed pattern in
test_cr054_http_core_lift.py) -- structural + functional assertions are
DELIBERATELY combined in one test per name rather than split into a "logic
moved" test plus a separate "still works" test: the latter would pass TODAY
(the current, unlifted implementation already behaves correctly -- it just
is not yet SHARED), which is not a valid RED signal. Combining them means the
test fails today for the real, structural reason, and once GREEN satisfies
that, the SAME test exercises the delegated call end-to-end -- so it also
serves as GREEN's regression guard against a lift that moves the code but
breaks the client-facing contract while doing so.

No production code was moved to write this file. No client, `.env`, or
project_dir filesystem state is touched: every functional assertion below
mocks `_get`/`_project_key`/`subprocess.run`/env vars at the module-attribute
level (the same technique C2's committed tests use for `_post`/`_get`), so
`_project_key`'s own GENUINELY-PER-CLIENT `.env` I/O never runs.

Invocation:
    python3 -m pytest tests/client/test_cr054_axi_context_lift.py -q
Fallback:
    python3 tests/client/test_cr054_axi_context_lift.py
"""

import ast
import os
import unittest
import importlib.util
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)


def _load_module_by_path(path, cache_key):
    """Load a module by file path, mirroring the fleet's own `_axi()`/`_toon()`
    loader pattern -- the same convention every existing client/shared-module
    test in this directory uses (test_cr054_http_core_lift.py,
    test_crucible_axi_shared.py, test_python_crucible_axi.py)."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module(client):
    return _load_module_by_path(
        CLIENT_FILES[client], f"cr054_axi_context_{client}_under_test")


def _function_source_segment(path, name):
    """AST-extract the exact source text of a top-level `def <name>` in
    `path` (ast.parse, not grep/eyeball -- mirrors
    test_cr054_fleet_inventory.py's / test_cr054_http_core_lift.py's method).
    Returns None if not defined as a top-level function at all."""
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    for node in tree.body:
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == name):
            return ast.get_source_segment(text, node)
    return None


def _clients_with_marker_in_function(name, marker):
    """Every client whose own top-level `def <name>` still contains `marker`
    literally -- i.e. still carries the REAL logic, not a delegator."""
    offenders = []
    for client, path in CLIENT_FILES.items():
        body = _function_source_segment(path, name)
        if body is not None and marker in body:
            offenders.append(client)
    return offenders


def _spec_from_file_location_call(source_segment):
    """Return the AST `Call` node for
    `importlib.util.spec_from_file_location(...)` inside `source_segment` (a
    function body's source text), or None if not present."""
    tree = ast.parse(source_segment)
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "spec_from_file_location"):
            return node
    return None


class RunContextEnvGitLiftTest(unittest.TestCase):
    """`_run_context`'s real env-var + `subprocess.run` git-lookup logic
    (CR-CRU-008 SS2) is byte-identical across all five clients TODAY and NONE
    of them delegates it (confirmed: arduino-crucible.py:207,
    bun-crucible.py:704, mvn-crucible.py:265, python-crucible.py:235,
    rust-crucible.py:266 each carry the FULL implementation) -- unlike
    `_axi_context`/`_emit_axi`/`_agent_id`, which already delegate (see the
    module docstring's exclusion note). It must move to
    `clients/_crucible_axi.py` and become a thin per-client delegator."""

    MARKER = "subprocess.run("

    def test_env_and_git_logic_moves_out_of_every_client_and_still_works(self):
        offenders = _clients_with_marker_in_function("_run_context", self.MARKER)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _run_context's REAL "
            f"subprocess/git logic in their own source instead of delegating "
            f"to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            self.MARKER, axi_source,
            "clients/_crucible_axi.py must own the real subprocess.run git "
            "lookup after the §S2 lift -- not present yet")

        # Full context: cycle + wave + orchestrator + git, all resolved.
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.dict(
                        os.environ,
                        {"WORKFLOW_CYCLE": "cyc-42", "WORKFLOW_WAVE": "wave-3",
                         "WORKFLOW_ROLE": "track-2"}, clear=True), \
                        mock.patch("subprocess.run") as run_mock:
                    run_mock.side_effect = [
                        mock.Mock(stdout="feature/CR-CRU-054\n"),
                        mock.Mock(stdout="deadbeefcafe\n"),
                    ]
                    context = module._run_context()
                self.assertEqual(
                    context,
                    {"cycle": "cyc-42", "wave": "wave-3", "orchestrator": "track-2",
                     "git": {"branch": "feature/CR-CRU-054", "commit": "deadbeefcafe"}},
                    f"{client}-crucible.py's _run_context must still build "
                    f"the full env+git context dict after delegating")

        # No workflow env at all -> None (never a bare {}).
        for client in CLIENTS:
            with self.subTest(client=f"{client}-no-env"):
                module = _load_client_module(client)
                with mock.patch.dict(os.environ, {}, clear=True):
                    self.assertIsNone(
                        module._run_context(),
                        f"{client}-crucible.py's _run_context must still "
                        f"return None when no WORKFLOW_* env var is set")

        # Git subprocess failure is tolerated -- 'git' key omitted, not raised.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-git-failure-tolerant"):
                module = _load_client_module(client)
                with mock.patch.dict(
                        os.environ, {"WORKFLOW_CYCLE": "cyc-1"}, clear=True), \
                        mock.patch("subprocess.run",
                                   side_effect=OSError("git not found")):
                    context = module._run_context()
                self.assertEqual(
                    context, {"cycle": "cyc-1"},
                    f"{client}-crucible.py's _run_context must still omit "
                    f"'git' (never raise) when the git subprocess call fails")


class PlansPathUrlTemplateLiftTest(unittest.TestCase):
    """`_plans_path`'s real URL-template logic is byte-identical across all
    five clients TODAY (confirmed: arduino-crucible.py:248,
    bun-crucible.py:1003, mvn-crucible.py:306, python-crucible.py:388,
    rust-crucible.py:307). `_project_key` itself stays per-client (DN SS3,
    GENUINELY PER-CLIENT, per C2's own committed ESCALATION) -- only the URL
    TEMPLATE built from an already-resolved key is SHARED."""

    MARKER = "/api/v2/projects/"

    def test_url_template_moves_out_of_every_client_and_still_works(self):
        offenders = _clients_with_marker_in_function("_plans_path", self.MARKER)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _plans_path's REAL URL "
            f"template in their own source instead of delegating to "
            f"clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            self.MARKER, axi_source,
            "clients/_crucible_axi.py must own the real plans-path URL "
            "template after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                with mock.patch.object(
                        module, "_project_key", return_value="proj-054-c3"):
                    path = module._plans_path("/fake/project/dir")
                self.assertEqual(
                    path, "/api/v2/projects/proj-054-c3/plans",
                    f"{client}-crucible.py's _plans_path must still build "
                    f"the plans-collection URL from the resolved project key "
                    f"after delegating")


class OpenPlansFilterLiftTest(unittest.TestCase):
    """`_open_plans`'s real open-status filter + hard-exit-on-GET-failure
    logic is byte-identical across all five clients TODAY (confirmed:
    arduino-crucible.py:252, bun-crucible.py:1007, mvn-crucible.py:310,
    python-crucible.py:392, rust-crucible.py:311)."""

    MARKER = '== "open"'

    def test_open_filter_and_hard_exit_moves_out_of_every_client_and_still_works(self):
        offenders = _clients_with_marker_in_function("_open_plans", self.MARKER)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _open_plans's REAL "
            f"open-status filter in their own source instead of delegating "
            f"to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            self.MARKER, axi_source,
            "clients/_crucible_axi.py must own the real open-status filter "
            "after the §S2 lift -- not present yet")

        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                plans_resp = {"ok": True, "plans": [
                    {"cr": "CR-CRU-001", "status": "open"},
                    {"cr": "CR-CRU-002", "status": "closed"},
                    {"cr": "CR-CRU-003", "status": "open"},
                ]}
                with mock.patch.object(module, "_project_key", return_value="k"), \
                        mock.patch.object(module, "_get", return_value=plans_resp):
                    open_plans = module._open_plans("/fake/dir")
                self.assertEqual(
                    open_plans,
                    [{"cr": "CR-CRU-001", "status": "open"},
                     {"cr": "CR-CRU-003", "status": "open"}],
                    f"{client}-crucible.py's _open_plans must still return "
                    f"ONLY status:open plans, in order, after delegating")

        for client in CLIENTS:
            with self.subTest(client=f"{client}-hard-exit-on-failure"):
                module = _load_client_module(client)
                with mock.patch.object(module, "_project_key", return_value="k"), \
                        mock.patch.object(
                            module, "_get",
                            return_value={"ok": False, "error": "server unreachable"}):
                    with self.assertRaises(SystemExit) as ctx:
                        module._open_plans("/fake/dir")
                self.assertIn(
                    "server unreachable", str(ctx.exception),
                    f"{client}-crucible.py's _open_plans must still hard-exit "
                    f"naming the server error when the plans GET fails")


class ResolvePlanOrEmitOrchestrationLiftTest(unittest.TestCase):
    """`_resolve_plan_or_emit`'s real orchestration logic -- GET the plans,
    build the none/ambiguous legacy messages, and emit the ok:false envelope
    on any failure -- is byte-identical across all five clients TODAY
    (confirmed: arduino-crucible.py:845, bun-crucible.py:1234,
    mvn-crucible.py:1386, python-crucible.py:1047, rust-crucible.py:1712).
    The plan SELECTION itself (`resolve_single_plan`) is ALREADY shared
    (every client already calls `_axi().resolve_single_plan(...)`); what
    remains duplicated is the surrounding prelude, evidenced by the identical
    'ambiguous' legacy-message text appearing in all five bodies today."""

    MARKER = "ambiguous"

    def test_orchestration_prelude_moves_out_of_every_client_and_still_works(self):
        offenders = _clients_with_marker_in_function("_resolve_plan_or_emit", self.MARKER)
        self.assertEqual(
            offenders, [],
            f"the following clients still carry _resolve_plan_or_emit's REAL "
            f"ambiguous/none message-building in their own source instead of "
            f"delegating to clients/_crucible_axi.py: {offenders!r}")
        axi_source = AXI_MODULE_PATH.read_text()
        self.assertIn(
            self.MARKER, axi_source,
            "clients/_crucible_axi.py must own the real ambiguous-plan "
            "message-building after the §S2 lift -- not present yet")

        # -- unique match: plan resolved, NO _emit_axi call, rc is None.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-unique-match"):
                module = _load_client_module(client)
                plans_resp = {"ok": True, "plans": [
                    {"cr": "CR-CRU-054", "planId": 7, "status": "open"}]}
                with mock.patch.object(module, "_project_key", return_value="k"), \
                        mock.patch.object(module, "_get", return_value=plans_resp), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    plan, rc = module._resolve_plan_or_emit(
                        "checkpoint", "/fake/dir", "CR-CRU-054", {}, open_only=True)
                self.assertEqual(
                    plan, {"cr": "CR-CRU-054", "planId": 7, "status": "open"},
                    f"{client}-crucible.py's _resolve_plan_or_emit must still "
                    f"return the uniquely-matched plan")
                self.assertIsNone(rc)
                emit_mock.assert_not_called()

        # -- no candidates: ok:false envelope, (None, 1); mock-verified args.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-no-candidates"):
                module = _load_client_module(client)
                with mock.patch.object(module, "_project_key", return_value="k"), \
                        mock.patch.object(
                            module, "_get",
                            return_value={"ok": True, "plans": []}), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    plan, rc = module._resolve_plan_or_emit(
                        "checkpoint", "/fake/dir", "CR-CRU-999",
                        {"help": ["status"]}, open_only=True)
                self.assertIsNone(plan)
                self.assertEqual(rc, 1)
                emit_mock.assert_called_once()
                call_args = emit_mock.call_args
                self.assertEqual(
                    call_args.args[0], "checkpoint",
                    f"{client}-crucible.py's _resolve_plan_or_emit must emit "
                    f"the verb it was called with")
                self.assertEqual(call_args.args[1], False)
                self.assertEqual(call_args.args[2], {"help": ["status"]})
                legacy_line = call_args.args[5]
                self.assertIn(
                    "no open plan to checkpoint for cr=CR-CRU-999", legacy_line,
                    f"{client}-crucible.py's _resolve_plan_or_emit must still "
                    f"name the verb + cr in the 'no candidates' legacy line")

        # -- ambiguous: multiple candidates, ok:false envelope naming both CRs.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-ambiguous"):
                module = _load_client_module(client)
                plans_resp = {"ok": True, "plans": [
                    {"cr": "CR-CRU-A", "planId": 1, "status": "open"},
                    {"cr": "CR-CRU-B", "planId": 2, "status": "open"},
                ]}
                with mock.patch.object(module, "_project_key", return_value="k"), \
                        mock.patch.object(module, "_get", return_value=plans_resp), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    plan, rc = module._resolve_plan_or_emit(
                        "cycle-add", "/fake/dir", None, {}, open_only=False)
                self.assertIsNone(plan)
                self.assertEqual(rc, 1)
                emit_mock.assert_called_once()
                legacy_line = emit_mock.call_args.args[5]
                self.assertIn("CR-CRU-A", legacy_line)
                self.assertIn("CR-CRU-B", legacy_line)
                self.assertIn(
                    "ambiguous cycle-add", legacy_line,
                    f"{client}-crucible.py's _resolve_plan_or_emit must still "
                    f"name the verb in the ambiguous legacy line")

        # -- GET itself fails: ok:false envelope naming the server error.
        for client in CLIENTS:
            with self.subTest(client=f"{client}-get-fails"):
                module = _load_client_module(client)
                with mock.patch.object(module, "_project_key", return_value="k"), \
                        mock.patch.object(
                            module, "_get",
                            return_value={"ok": False, "error": "boom"}), \
                        mock.patch.object(module, "_emit_axi") as emit_mock:
                    plan, rc = module._resolve_plan_or_emit(
                        "abort", "/fake/dir", None, {}, open_only=True)
                self.assertIsNone(plan)
                self.assertEqual(rc, 1)
                emit_mock.assert_called_once()
                legacy_line = emit_mock.call_args.args[5]
                self.assertIn("boom", legacy_line)


class AxiLoaderCacheKeyDerivationTest(unittest.TestCase):
    """`_axi`/`_toon` cannot have their REAL loader logic moved INTO
    `clients/_crucible_axi.py` (that would be `_axi()` loading the very file
    it is trying to load -- a bootstrap paradox this cycle is not asked to
    solve; DN SS1's own note is explicit about this). What DN SS1 DOES ask
    this cycle to fix: the `importlib.util.spec_from_file_location(...)`
    cache-key string each client's loader passes is TODAY a hand-typed
    per-client literal ("bun_crucible_axi_shared" / "rust_crucible_toon" /
    ...) -- 'an internal loader-cache label never observed outside the
    function' that should stop being even a COSMETIC difference by deriving
    it from `__name__` instead of hardcoding it."""

    OLD_AXI_KEYS = {
        "bun": "bun_crucible_axi_shared", "rust": "rust_crucible_axi_shared",
        "mvn": "mvn_crucible_axi_shared", "python": "python_crucible_axi_shared",
        "arduino": "arduino_crucible_axi_shared",
    }
    OLD_TOON_KEYS = {
        "bun": "bun_crucible_toon", "rust": "rust_crucible_toon",
        "mvn": "mvn_crucible_toon", "python": "python_crucible_toon",
        "arduino": "arduino_crucible_toon",
    }

    def _assert_key_not_hardcoded(self, func_name, old_keys):
        offenders_literal = []
        offenders_ast = []
        for client, path in CLIENT_FILES.items():
            body = _function_source_segment(path, func_name)
            self.assertIsNotNone(
                body, f"{client}-crucible.py must still define {func_name}")
            if old_keys[client] in body:
                offenders_literal.append(client)
            call = _spec_from_file_location_call(body)
            self.assertIsNotNone(
                call, f"{client}-crucible.py's {func_name} must still call "
                      f"importlib.util.spec_from_file_location")
            if call.args and isinstance(call.args[0], ast.Constant) \
                    and isinstance(call.args[0].value, str):
                offenders_ast.append(client)
        self.assertEqual(
            offenders_literal, [],
            f"the following clients' {func_name} still hardcode their OLD "
            f"per-client cache-key literal instead of deriving it from "
            f"__name__: {offenders_literal!r}")
        self.assertEqual(
            offenders_ast, [],
            f"the following clients' {func_name} still pass a hardcoded "
            f"string constant as the spec_from_file_location cache key "
            f"instead of deriving it from __name__ (DN §1): {offenders_ast!r}")

    def test_axi_loader_cache_key_no_longer_hardcoded_and_still_works(self):
        self._assert_key_not_hardcoded("_axi", self.OLD_AXI_KEYS)
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                axi_mod = module._axi()
                self.assertIs(
                    axi_mod, module._axi(),
                    f"{client}-crucible.py's _axi() must still cache the "
                    f"loaded module (same object on a second call) after "
                    f"the cache-key fix")
                self.assertTrue(
                    hasattr(axi_mod, "AXI_UNSET"),
                    f"{client}-crucible.py's _axi() must still load the "
                    f"real shared _crucible_axi module (AXI_UNSET attribute) "
                    f"after the cache-key fix")

    def test_toon_loader_cache_key_no_longer_hardcoded_and_still_works(self):
        self._assert_key_not_hardcoded("_toon", self.OLD_TOON_KEYS)
        for client in CLIENTS:
            with self.subTest(client=client):
                module = _load_client_module(client)
                toon_mod = module._toon()
                self.assertIs(
                    toon_mod, module._toon(),
                    f"{client}-crucible.py's _toon() must still cache the "
                    f"loaded module (same object on a second call) after "
                    f"the cache-key fix")
                self.assertTrue(
                    callable(getattr(toon_mod, "encode", None)),
                    f"{client}-crucible.py's _toon() must still load the "
                    f"real toon.py codec (callable encode()) after the "
                    f"cache-key fix")


if __name__ == "__main__":
    unittest.main()
