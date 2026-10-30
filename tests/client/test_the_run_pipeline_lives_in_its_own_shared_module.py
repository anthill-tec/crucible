"""The run and ingest pipeline lives in its own shared module, and the split is
invisible to every client.

`clients/_crucible_run.py` holds the run pipeline (the wall-versus-CPU reading,
narration, the run lifecycle, the ingest, the abandon trap and the runner
group) and the one run emitter, `emit_run_axi`. `clients/_crucible_axi.py`, the
core every client loads, loads it by path from its own directory, eagerly, as
`f"{__name__}_run"`, binds it to a live view of its own namespace, and
re-exports its names. The gated-run bookkeeping stays in the core.

What is asserted here:

  * headroom: the core is at most `CORE_LINE_LIMIT` lines and the run module
    under `RUN_LINE_LIMIT`, by the citation guard's own count
    (`text.split("\\n")`);
  * the split is invisible: every top-level name the run module defines (its
    imports and its core view aside) is the same object on the loaded core;
    `RunAbandoned` is one class; no client reaches a run-module name except
    through `_axi()`; a patch of the core's `post_ingest` is reached by the
    moved `ingest_reports`; two clients loaded in one process each get a run
    module of their own; the installer's loader reaches the run module;
  * the gated-run bookkeeping is defined in the core and nowhere else;
  * both shared modules are clean under `ruff check --select F`, and the run
    module imports only the standard library;
  * one emitter: the run module defines `emit_run_axi`, it builds the
    envelope the four clients' emitters built, and each of those emitters is
    one `return _axi().emit_run_axi(...)` passing the context built with
    `cycle_id=_axi().echoed_cycle_id(resp)`.

A run-module function's globals are the run module's own namespace, so
`<core>.ingest_reports.__globals__` is how a test reaches the run module the
core loaded: its `__name__` and its `__file__` say which module it is and
where it was read from.

The census and the emitter-shape checker read syntax trees, never text, and
each is proved on synthetic sources before it is pointed at a real client.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_the_run_pipeline_lives_in_its_own_shared_module
"""

import ast
import contextlib
import io
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import get_answering_health, load_client

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = REPO_ROOT / "clients"
CORE_MODULE = CLIENTS / "_crucible_axi.py"
RUN_MODULE = CLIENTS / "_crucible_run.py"
SHARED_MODULES = (CORE_MODULE, RUN_MODULE)
CLIENT_FILES = ("bun-crucible.py", "python-crucible.py", "mvn-crucible.py",
                "rust-crucible.py", "arduino-crucible.py")

# The citation guard reads a five-digit number as a port, never a line, so no
# scanned file may reach ten thousand lines; the core keeps headroom below it.
CORE_LINE_LIMIT = 9_200
RUN_LINE_LIMIT = 10_000

# The names the run pipeline is made of, as the design enumerates them, and
# the one emitter lifted into it.
MOVED_NAMES = (
    "UNIT_RUN_WALL_EXCEEDS_CPU_CODE", "ChildRunTiming",
    "RunNarrator", "narration_poster", "close_narration",
    "open_run", "abort_run",
    "junit_testcase_count", "junit_non_skipped_count", "ingest_reports",
    "_print_ingest_line", "filed_run", "coverage_not_measured_warning",
    "ran_nothing", "runner_exit_code", "verb_exit", "filed_summary",
    "emit_ran_nothing",
    "RunAbandoned", "AbandonTrap", "abandon_trap", "_emit_abandoned",
    "emit_bracket_abandoned", "emit_run_abandoned",
    "run_streamed",
    "emit_run_axi",
)

# The gated-run bookkeeping: module state and every function that rebinds or
# reads it, kept beside `gated_run` in the core.
GATED_BOOKKEEPING = ("_gated_trap", "_gated_open_run", "_gated_held",
                     "_note_gated_run", "_settle_gated_run", "_abort_gated_run")

# Each client's run emitter, by the name it keeps.
RUN_EMITTERS = (("bun-crucible.py", "_emit_ingest_axi"),
                ("python-crucible.py", "_emit_ingest_axi"),
                ("mvn-crucible.py", "_emit_run_axi"),
                ("rust-crucible.py", "_emit_run_axi"))

COUNT_KEYS = ("passed", "failed", "pending", "total", "files")


def _source(path):
    return Path(path).read_text(encoding="utf-8")


def _target_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [name for element in target.elts for name in _target_names(element)]
    return []


def top_level_definitions(tree):
    """Every name `tree` binds at its top level by `def`, `class` or an
    assignment, in source order and with repeats: imports bind nothing here."""
    names = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                names += _target_names(target)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.append(node.target.id)
    return names


def _is_dunder(name):
    return name.startswith("__") and name.endswith("__")


def _is_axi_receiver(node):
    """`node` is the call `_axi()`."""
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "_axi" and not node.args and not node.keywords)


def _is_axi_call(node, attr):
    """`node` is `_axi().<attr>(...)`."""
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == attr and _is_axi_receiver(node.func.value))


def reaches_outside_axi(source, names):
    """`[(kind, text)]`: every place `source` reaches one of `names` other than
    as `_axi().<name>` — a bare name the module does not define itself, or an
    attribute of any receiver but `_axi()`."""
    tree = ast.parse(source)
    own = set(top_level_definitions(tree))
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in names and node.id not in own:
            found.append(("bare name", node.id))
        elif (isinstance(node, ast.Attribute) and node.attr in names
              and not _is_axi_receiver(node.value)):
            found.append(("other receiver", ast.unparse(node)))
    return sorted(set(found))


def _top_level_function(tree, name):
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def _body_past_docstring(function):
    body = list(function.body)
    if (body and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)):
        body = body[1:]
    return body


def _is_name(node, name):
    return isinstance(node, ast.Name) and node.id == name


def _is_echoed_context(node):
    """`node` is `_axi_context(...)` with `cycle_id=_axi().echoed_cycle_id(resp)`."""
    if not (isinstance(node, ast.Call) and _is_name(node.func, "_axi_context")):
        return False
    for keyword in node.keywords:
        if keyword.arg == "cycle_id":
            value = keyword.value
            return (_is_axi_call(value, "echoed_cycle_id")
                    and len(value.args) == 1 and _is_name(value.args[0], "resp")
                    and not value.keywords)
    return False


def run_emitter_findings(source, function):
    """`[]` when top-level `function`'s body, past an optional docstring, is
    the one statement `return _axi().emit_run_axi(verb, resp, <context>,
    _emit_axi, ...)` whose context is `_axi_context(...)` built with
    `cycle_id=_axi().echoed_cycle_id(resp)`; else what it holds instead."""
    node = _top_level_function(ast.parse(source), function)
    if node is None:
        return [f"<no {function}>"]
    body = _body_past_docstring(node)
    if len(body) != 1 or not isinstance(body[0], ast.Return):
        return [ast.unparse(stmt).splitlines()[0] for stmt in body]
    call = body[0].value
    if not _is_axi_call(call, "emit_run_axi"):
        return [ast.unparse(body[0]).splitlines()[0]]
    findings = []
    args = list(call.args)
    if len(args) < 4:
        findings.append(f"{len(args)} positional arguments, not verb, resp, "
                        f"context, _emit_axi")
        return findings
    if not (_is_name(args[0], "verb") and _is_name(args[1], "resp")):
        findings.append(f"first arguments {ast.unparse(args[0])}, "
                        f"{ast.unparse(args[1])}, not verb, resp")
    if not _is_echoed_context(args[2]):
        findings.append(f"context {ast.unparse(args[2])} is not built with "
                        f"cycle_id=_axi().echoed_cycle_id(resp)")
    if not _is_name(args[3], "_emit_axi"):
        findings.append(f"emit function {ast.unparse(args[3])}, not _emit_axi")
    return findings


def _require_run_module(test):
    test.assertTrue(
        RUN_MODULE.is_file(),
        f"the run pipeline lives in {RUN_MODULE.relative_to(REPO_ROOT)}, which "
        f"does not exist: the core has not been split")


def run_namespace(test, core, expected_dir=CLIENTS):
    """The namespace of the run module `core` loaded, reached through the
    moved `ingest_reports`, after asserting it is that module: named
    `f"{core.__name__}_run"` and read from `expected_dir`."""
    _require_run_module(test)
    namespace = core.ingest_reports.__globals__
    test.assertEqual(
        namespace.get("__name__"), f"{core.__name__}_run",
        f"the core's `ingest_reports` runs in {namespace.get('__name__')!r}, not "
        f"in the run module the core loads as `{core.__name__}_run`")
    test.assertEqual(
        Path(namespace.get("__file__") or "").resolve(),
        (Path(expected_dir) / RUN_MODULE.name).resolve(),
        "the run module is read from the core's own directory")
    return namespace


def is_core_view(value, core):
    """`value` is the run module's view of `core`: the core itself, or an
    object or mapping through which `core.post_ingest` is reached."""
    if value is core:
        return True
    if getattr(value, "post_ingest", None) is core.post_ingest:
        return True
    getter = getattr(value, "get", None)
    if callable(getter):
        try:
            return getter("post_ingest") is core.post_ingest
        except (TypeError, AttributeError, KeyError):
            # A `get` that is not a mapping's (a class's unbound method, one
            # taking other arguments) is not a view of the core.
            return False
    return False


def reexport_misses(core, namespace, names):
    """`[(name, why)]` for each of `names` the core does not carry as the very
    object the run module defines."""
    misses = []
    for name in names:
        if not hasattr(core, name):
            misses.append((name, "absent from the core"))
        elif getattr(core, name) is not namespace.get(name):
            misses.append((name, "a different object on the core"))
    return misses


def _quiet_call(function, *args, **kwargs):
    with contextlib.redirect_stderr(io.StringIO()):
        return function(*args, **kwargs)


def _junit_report(directory):
    path = Path(directory) / "TEST-shared.xml"
    path.write_text('<?xml version="1.0"?><testsuite name="s" tests="1">'
                    '<testcase name="t" classname="s"/></testsuite>',
                    encoding="utf-8")
    return path


# ── headroom ────────────────────────────────────────────────────────────────

class TheSharedModulesHaveHeadroomUnderTheCitationGuardTest(unittest.TestCase):

    def test_the_core_is_no_longer_than_its_line_limit(self):
        lines = len(_source(CORE_MODULE).split("\n"))
        self.assertLessEqual(
            lines, CORE_LINE_LIMIT,
            f"clients/_crucible_axi.py is {lines} lines by the citation guard's "
            f"count, over {CORE_LINE_LIMIT}: the run pipeline still lives in it")

    def test_the_run_module_is_under_the_citation_guards_threshold(self):
        _require_run_module(self)
        lines = len(_source(RUN_MODULE).split("\n"))
        self.assertLess(
            lines, RUN_LINE_LIMIT,
            f"clients/_crucible_run.py is {lines} lines, at or over the "
            f"{RUN_LINE_LIMIT} the citation guard reads as a port")


# ── the move ────────────────────────────────────────────────────────────────

class TheRunPipelineIsDefinedInTheRunModuleOnlyTest(unittest.TestCase):

    def test_each_pipeline_name_is_defined_once_in_the_run_module_and_not_in_the_core(self):
        _require_run_module(self)
        run_defs = top_level_definitions(ast.parse(_source(RUN_MODULE)))
        core_defs = top_level_definitions(ast.parse(_source(CORE_MODULE)))
        wrong = {name: (run_defs.count(name), core_defs.count(name))
                 for name in MOVED_NAMES
                 if (run_defs.count(name), core_defs.count(name)) != (1, 0)}
        self.assertEqual(
            wrong, {},
            "each name is defined once in clients/_crucible_run.py and never "
            "in clients/_crucible_axi.py, which re-exports it; "
            "{name: (run module, core)}: " + repr(wrong))

    def test_the_gated_run_bookkeeping_is_defined_in_the_core_and_nowhere_else(self):
        _require_run_module(self)
        counts = {}
        for path in sorted(CLIENTS.glob("*.py")):
            defs = top_level_definitions(ast.parse(_source(path)))
            for name in GATED_BOOKKEEPING:
                if name in defs:
                    counts.setdefault(name, {})[path.name] = defs.count(name)
        self.assertEqual(
            counts, {name: {CORE_MODULE.name: 1} for name in GATED_BOOKKEEPING},
            "the gated-run state and the four functions that read or rebind "
            "it stay beside `gated_run`, once, in clients/_crucible_axi.py")


# ── the split is invisible ──────────────────────────────────────────────────

class TheTopLevelNameScanIsProvedOnASyntheticSourceTest(unittest.TestCase):

    def test_definitions_are_read_and_imports_are_not(self):
        source = textwrap.dedent('''
            import json
            from os import path as ospath
            CODE = "x"
            LIMIT: int = 3
            A, (B, C) = 1, (2, 3)
            _core = None
            def run(): pass
            async def wait(): pass
            class Abandoned(BaseException): pass
            if True:
                HIDDEN = 1
        ''')
        self.assertEqual(
            top_level_definitions(ast.parse(source)),
            ["CODE", "LIMIT", "A", "B", "C", "_core", "run", "wait", "Abandoned"])

    def test_the_core_view_is_told_from_a_moved_name(self):
        core = mock.Mock(spec=["post_ingest"])
        self.assertTrue(is_core_view(core, core))
        self.assertTrue(is_core_view({"post_ingest": core.post_ingest}, core))
        self.assertTrue(is_core_view(mock.Mock(post_ingest=core.post_ingest), core))
        self.assertFalse(is_core_view("coverage-not-measured", core))
        self.assertFalse(is_core_view({"post_ingest": object()}, core))
        self.assertFalse(is_core_view(len, core))


class TheSplitIsInvisibleTest(unittest.TestCase):

    def setUp(self):
        self.core = load_client("_crucible_axi.py")

    def test_every_name_the_run_module_defines_is_the_same_object_on_the_core(self):
        namespace = run_namespace(self, self.core)
        names = [name for name in top_level_definitions(ast.parse(_source(RUN_MODULE)))
                 if not _is_dunder(name)
                 and not is_core_view(namespace.get(name), self.core)]
        self.assertIn("ingest_reports", names)
        self.assertGreaterEqual(len(names), len(MOVED_NAMES))
        misses = reexport_misses(self.core, namespace, names)
        self.assertEqual(
            misses, [],
            "every top-level name of the run module (its imports and its core "
            "view aside) is re-exported by the core as the same object, so "
            "`_axi().<name>` and a test's `axi.<name>` keep working")

    def test_run_abandoned_is_one_class_on_both_modules(self):
        namespace = run_namespace(self, self.core)
        self.assertIs(
            self.core.RunAbandoned, namespace.get("RunAbandoned"),
            "a `RunAbandoned` the run module raises is the one the core and its "
            "clients catch")
        self.assertTrue(issubclass(self.core.RunAbandoned, BaseException))
        self.assertFalse(issubclass(self.core.RunAbandoned, Exception))

    def test_a_patch_of_the_cores_post_ingest_is_reached_by_the_moved_ingest_reports(self):
        run_namespace(self, self.core)
        scratch = tempfile.mkdtemp(prefix="run-module-patch-")
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        report = _junit_report(scratch)
        answer = {"ok": True, "event": "evt-1",
                  "run": {"passed": 1, "failed": 0, "pending": 0, "total": 1}}
        post_fn = mock.Mock(name="post_fn")
        with mock.patch.object(self.core, "post_ingest",
                               return_value=answer) as patched:
            resp = _quiet_call(
                self.core.ingest_reports, post_fn, get_answering_health(),
                stack="python", project_key="key-1", agent_id="agent-1",
                codec="junit", report_paths=[str(report)])
        patched.assert_called_once_with(
            post_fn, "/api/v2/runs",
            {"projectKey": "key-1", "agentId": "agent-1", "codec": "junit",
             "data": [report.read_text(encoding="utf-8")]},
            stack="python", release=None)
        self.assertIs(resp, answer)
        post_fn.assert_not_called()


class EachClientGetsARunModuleOfItsOwnTest(unittest.TestCase):

    def test_two_clients_in_one_process_each_load_their_own_run_module(self):
        python_core = load_client("python-crucible.py")._axi()
        bun_core = load_client("bun-crucible.py")._axi()
        self.assertIsNot(python_core, bun_core)
        python_run = run_namespace(self, python_core)
        bun_run = run_namespace(self, bun_core)
        self.assertIsNot(python_run, bun_run,
                         "each core loads a run module of its own")
        self.assertIsNot(python_core.ingest_reports, bun_core.ingest_reports)
        self.assertIsNot(python_core.RunAbandoned, bun_core.RunAbandoned)

    def test_a_patch_of_one_clients_core_is_not_reached_by_the_other_clients_run_module(self):
        python_core = load_client("python-crucible.py")._axi()
        bun_core = load_client("bun-crucible.py")._axi()
        run_namespace(self, bun_core)
        scratch = tempfile.mkdtemp(prefix="run-module-isolation-")
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        report = _junit_report(scratch)
        board_answer = {"ok": True, "event": "evt-2",
                        "run": {"passed": 1, "failed": 0, "pending": 0, "total": 1}}
        post_fn = mock.Mock(name="post_fn", return_value=board_answer)
        with mock.patch.object(python_core, "post_ingest") as python_patched:
            resp = _quiet_call(
                bun_core.ingest_reports, post_fn, get_answering_health(),
                stack="bun", project_key="key-2", agent_id="agent-2",
                codec="junit", report_paths=[str(report)])
        python_patched.assert_not_called()
        post_fn.assert_called_once()
        path, payload = post_fn.call_args.args
        self.assertEqual(path, "/api/v2/runs")
        self.assertEqual(payload.get("stack"), "bun")
        self.assertEqual(resp, board_answer)


class TheInstallersLoaderReachesTheRunModuleTest(unittest.TestCase):

    def test_the_cli_loader_loads_the_core_and_its_run_module_from_the_source_clients(self):
        from crucible_axi import cli, manifest
        core = cli._load_client_module("_crucible_axi")
        source_dir = Path(manifest.source_clients_dir())
        run_namespace(self, core, expected_dir=source_dir)
        self.assertIs(core.RunAbandoned,
                      core.ingest_reports.__globals__.get("RunAbandoned"))


# ── the census: no client reaches the run module but through _axi() ─────────

class TheRunModuleCensusIsProvedOnSyntheticSourcesTest(unittest.TestCase):

    NAMES = frozenset({"ingest_reports", "abort_run", "RunAbandoned"})

    def test_a_client_reaching_the_run_module_only_through_axi_has_no_finding(self):
        source = textwrap.dedent('''
            def _file_reports():
                return _axi().ingest_reports(_post, _get)
            def cmd_test(args):
                try:
                    _file_reports()
                except _axi().RunAbandoned as abandoned:
                    return _axi().abort_run(_post, "k", "a", "r", "why")
        ''')
        self.assertEqual(reaches_outside_axi(source, self.NAMES), [])

    def test_bare_names_and_other_receivers_are_found(self):
        source = textwrap.dedent('''
            def cmd_test(args):
                ingest_reports(_post, _get)
                _AXI_MOD.abort_run(_post)
                _axi()._run.ingest_reports(_post)
                raise RunAbandoned(2)
        ''')
        self.assertEqual(
            reaches_outside_axi(source, self.NAMES),
            [("bare name", "RunAbandoned"), ("bare name", "ingest_reports"),
             ("other receiver", "_AXI_MOD.abort_run"),
             ("other receiver", "_axi()._run.ingest_reports")])

    def test_a_name_the_client_defines_itself_is_its_own(self):
        source = textwrap.dedent('''
            def abort_run(reason):
                return reason
            def cmd_test(args):
                return abort_run("why")
        ''')
        self.assertEqual(reaches_outside_axi(source, self.NAMES), [])


class NoClientReachesTheRunModuleButThroughAxiTest(unittest.TestCase):

    def test_each_client_calls_the_run_modules_names_only_through_axi(self):
        _require_run_module(self)
        names = frozenset(name for name in top_level_definitions(
            ast.parse(_source(RUN_MODULE))) if not _is_dunder(name))
        self.assertIn("ingest_reports", names)
        findings = {client: reaches_outside_axi(_source(CLIENTS / client), names)
                    for client in CLIENT_FILES}
        findings = {client: found for client, found in findings.items() if found}
        self.assertEqual(
            findings, {},
            "a client reaches the run pipeline as `_axi().<name>`, through the "
            "core's re-export, and never loads or names the run module itself")


# ── clean ───────────────────────────────────────────────────────────────────

def _ruff():
    found = shutil.which("ruff")
    if found:
        return found
    sibling = Path(sys.executable).with_name("ruff")
    return str(sibling) if sibling.is_file() else None


class TheSharedModulesAreCleanTest(unittest.TestCase):

    def test_ruff_finds_nothing_in_either_shared_module(self):
        ruff = _ruff()
        if ruff is None:
            self.skipTest("ruff is not installed on this machine")
        _require_run_module(self)
        completed = subprocess.run(
            [ruff, "check", "--no-cache", "--select", "F",
             *(str(path) for path in SHARED_MODULES)],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=120,
            check=False)
        self.assertEqual(
            completed.returncode, 0,
            f"`ruff check --select F` on both shared modules:\n"
            f"{completed.stdout}{completed.stderr}")

    def test_the_run_module_imports_only_the_standard_library(self):
        _require_run_module(self)
        tree = ast.parse(_source(RUN_MODULE))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add("." if node.level else (node.module or "").split(".")[0])
        foreign = sorted(name for name in imported
                         if name not in sys.stdlib_module_names
                         and name != "__future__")
        self.assertEqual(foreign, [],
                         "clients/_crucible_run.py imports only the standard "
                         "library; it reaches the core through its bound view")
        self.assertIn("json", imported)


# ── one run emitter ─────────────────────────────────────────────────────────

_DELEGATING_EMITTER = textwrap.dedent('''
    def _emit_ingest_axi(verb, resp, project_dir, agent, help_steps=None,
                         warnings=None):
        """Emit the run envelope through the shared emitter."""
        return _axi().emit_run_axi(
            verb, resp,
            _axi_context(project_dir, agent_id=agent,
                         cycle_id=_axi().echoed_cycle_id(resp)),
            _emit_axi, ok=None, help_steps=help_steps, warnings=warnings,
            fields={}, coverage=False)
''')

_DELEGATING_EMITTER_WITHOUT_THE_ECHO = textwrap.dedent('''
    def _emit_ingest_axi(verb, resp, project_dir, agent):
        return _axi().emit_run_axi(verb, resp,
                                   _axi_context(project_dir, agent_id=agent),
                                   _emit_axi, fields={})
''')

_EMITTER_WRITTEN_OUT = textwrap.dedent('''
    def _emit_ingest_axi(verb, resp, project_dir, agent):
        filed = _axi().filed_run(resp)
        context = _axi_context(project_dir, agent_id=agent,
                               cycle_id=_axi().echoed_cycle_id(resp))
        _emit_axi(verb, bool(resp.get("ok")), {"run": filed}, context, [])
''')


class TheEmitterShapeCheckIsProvedOnSyntheticSourcesTest(unittest.TestCase):

    def test_a_one_call_delegator_has_no_finding(self):
        self.assertEqual(run_emitter_findings(_DELEGATING_EMITTER, "_emit_ingest_axi"), [])

    def test_an_emitter_written_out_names_each_statement(self):
        self.assertEqual(
            run_emitter_findings(_EMITTER_WRITTEN_OUT, "_emit_ingest_axi"),
            ["filed = _axi().filed_run(resp)",
             "context = _axi_context(project_dir, agent_id=agent, "
             "cycle_id=_axi().echoed_cycle_id(resp))",
             "_emit_axi(verb, bool(resp.get('ok')), {'run': filed}, context, [])"])

    def test_a_delegator_without_the_cycle_echo_is_a_finding(self):
        self.assertEqual(
            run_emitter_findings(_DELEGATING_EMITTER_WITHOUT_THE_ECHO,
                                 "_emit_ingest_axi"),
            ["context _axi_context(project_dir, agent_id=agent) is not built "
             "with cycle_id=_axi().echoed_cycle_id(resp)"])

    def test_a_delegator_through_another_receiver_or_without_return_is_a_finding(self):
        other = _DELEGATING_EMITTER.replace("return _axi().emit_run_axi(",
                                            "return helpers.emit_run_axi(")
        self.assertEqual(len(run_emitter_findings(other, "_emit_ingest_axi")), 1)
        bare = _DELEGATING_EMITTER.replace("return _axi().emit_run_axi(",
                                           "_axi().emit_run_axi(")
        self.assertEqual(len(run_emitter_findings(bare, "_emit_ingest_axi")), 1)
        self.assertEqual(run_emitter_findings("x = 1\n", "_emit_ingest_axi"),
                         ["<no _emit_ingest_axi>"])


class EachClientsRunEmitterIsOneSharedCallTest(unittest.TestCase):

    def test_each_run_emitter_returns_the_shared_emitter_with_the_echoed_context(self):
        findings = {f"{client} {function}": run_emitter_findings(
                        _source(CLIENTS / client), function)
                    for client, function in RUN_EMITTERS}
        findings = {where: found for where, found in findings.items() if found}
        self.assertEqual(
            findings, {},
            "each client's run emitter is `return _axi().emit_run_axi(verb, "
            "resp, _axi_context(..., cycle_id=_axi().echoed_cycle_id(resp)), "
            "_emit_axi, ...)` and nothing else")


class _RecordingEmit:
    """An emit function standing in for a client's `_emit_axi`: it records
    each envelope it is handed."""

    def __init__(self):
        self.calls = []

    def __call__(self, verb, ok, result_fields, context, warnings):
        self.calls.append({"verb": verb, "ok": ok, "fields": result_fields,
                           "context": context, "warnings": list(warnings)})


class TheSharedRunEmitterBuildsTheRunEnvelopeTest(unittest.TestCase):
    """`emit_run_axi(verb, resp, context, emit_fn, *, ok, help_steps,
    warnings, fields, coverage)` emits through `emit_fn` the envelope the
    four clients' emitters built."""

    CONTEXT = {"projectKey": "key-3", "agentId": "agent-3", "wave": None}

    def setUp(self):
        self.core = load_client("_crucible_axi.py")
        self.assertTrue(callable(getattr(self.core, "emit_run_axi", None)),
                        "the core re-exports the run module's `emit_run_axi`")

    def emit(self, verb, resp, *, ok=None, help_steps=None, warnings=(),
             fields=None, coverage=False):
        recorder = _RecordingEmit()
        self.core.emit_run_axi(verb, resp, dict(self.CONTEXT), recorder, ok=ok,
                               help_steps=help_steps, warnings=list(warnings),
                               fields=dict(fields or {}), coverage=coverage)
        self.assertEqual(len(recorder.calls), 1,
                         f"one envelope is emitted; got {recorder.calls!r}")
        return recorder.calls[0]

    def test_a_filed_run_states_its_five_figures_its_verbs_help_and_both_warnings(self):
        block = {"passed": 3, "failed": 0, "pending": 1, "total": 4, "files": 2}
        caller = {"code": "caller-warning", "detail": "said by the client"}
        board = {"code": "board-warning", "detail": "said by the board"}
        sent = self.emit("test", {"ok": True, "event": "evt-3", "run": block,
                                  "warnings": [board, "not a warning"]},
                         warnings=[caller])
        self.assertEqual(sent["verb"], "test")
        self.assertIs(sent["ok"], True)
        self.assertEqual(sent["fields"],
                         {"run": block,
                          "help": self.core.HELP_STEPS.get("test", ["status"])})
        self.assertEqual(list(sent["fields"]), ["run", "help"])
        self.assertEqual(sent["context"], self.CONTEXT)
        self.assertEqual(sent["warnings"], [caller, board],
                         "the caller's warnings, then the answer's own, and "
                         "nothing that is not a warning")

    def test_an_unfiled_run_states_null_figures_beside_the_answers_error(self):
        error = "connection lost: RemoteDisconnected('gone')"
        sent = self.emit("regression", {"ok": False, "error": error})
        self.assertIs(sent["ok"], False)
        self.assertEqual(sent["fields"]["run"], dict.fromkeys(COUNT_KEYS))
        self.assertEqual(sent["fields"]["error"], error)
        self.assertEqual(list(sent["fields"]), ["run", "help", "error"])
        self.assertEqual(sent["warnings"], [])

    def test_a_figure_that_is_not_an_integer_is_null(self):
        sent = self.emit("test", {"ok": True, "run": {
            "passed": True, "failed": "1", "pending": 0, "total": 1}})
        self.assertEqual(sent["fields"]["run"],
                         {"passed": None, "failed": None, "pending": 0,
                          "total": 1, "files": None})

    def test_the_callers_verdict_help_and_fields_are_kept_in_order(self):
        sent = self.emit(
            "pre-merge-gate",
            {"ok": True, "run": {"passed": 1, "failed": 2, "pending": 0,
                                 "total": 3, "files": 1},
             "error": "two failed"},
            ok=False, help_steps=["fix the two failures"],
            fields={"runId": "run-7", "name": "only_this", "script": "test:unit"})
        self.assertIs(sent["ok"], False, "the caller's verdict overrides the answer's")
        self.assertEqual(sent["fields"]["help"], ["fix the two failures"])
        self.assertEqual(list(sent["fields"]),
                         ["run", "help", "runId", "name", "script", "error"])
        self.assertEqual(
            {key: sent["fields"][key] for key in ("runId", "name", "script")},
            {"runId": "run-7", "name": "only_this", "script": "test:unit"})

    def test_coverage_states_the_lines_and_functions_percents_only_when_asked(self):
        resp = {"ok": True, "run": {
            "passed": 1, "failed": 0, "pending": 0, "total": 1, "files": 1,
            "coverage": {"lines": {"percent": 81.5}, "functions": {"percent": 60},
                         "branches": {"percent": 10}}}}
        asked = self.emit("regression", resp, coverage=True)
        self.assertEqual(asked["fields"]["coverage"], {"lines": 81.5, "functions": 60})
        self.assertEqual(list(asked["fields"]), ["run", "help", "coverage"])
        self.assertNotIn("coverage", self.emit("regression", resp)["fields"])

    def test_coverage_asked_of_a_run_that_kept_none_states_no_coverage(self):
        sent = self.emit("regression", {"ok": True, "run": {
            "passed": 0, "failed": 1, "pending": 0, "total": 1}}, coverage=True)
        self.assertNotIn("coverage", sent["fields"])


if __name__ == "__main__":
    unittest.main()
