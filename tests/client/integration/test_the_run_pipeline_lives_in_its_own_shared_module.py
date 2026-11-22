"""The run and ingest pipeline lives in its own shared module, and the split is
invisible to every client.

`clients/_crucible_run.py` holds the run pipeline (the wall-versus-CPU reading,
narration, the run lifecycle, the ingest, the abandon trap and the runner
group) and the one run emitter, `emit_run_axi`. `clients/_crucible_axi.py`, the
core every client loads, loads it by path from its own directory, eagerly, as
`f"{__name__}_run"`, binds it to a live view of its own namespace, and
re-exports its names. The gated-run bookkeeping stays in the core.

What is asserted here:

  * the split is invisible: every top-level name the run module defines (its
    imports and its core view aside) is the same object on the loaded core;
    `RunAbandoned` is one class; a patch of the core's `post_ingest` is
    reached by the moved `ingest_reports`; two clients loaded in one process
    each get a run module of their own; the installer's loader reaches the
    run module;
  * one emitter: the run module's `emit_run_axi` builds the envelope the
    clients' own emitters built.

A run-module function's globals are the run module's own namespace, so
`<core>.ingest_reports.__globals__` is how a test reaches the run module the
core loaded: its `__name__` and its `__file__` say which module it is and
where it was read from.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.integration.test_the_run_pipeline_lives_in_its_own_shared_module
"""

import ast
import contextlib
import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.live_run_harness import get_answering_health, load_client
from tests.client import install_clients_candidates
from tests.client.the_run_pipeline_lives_in_its_own_shared_module_helpers import (
    CLIENTS,
    is_core_view,
    top_level_definitions,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
RUN_MODULE = CLIENTS / "_crucible_run.py"

# The names the run pipeline is made of, as the design enumerates them, and
# the one emitter lifted into it.
MOVED_NAMES = (
    "UNIT_RUN_WALL_EXCEEDS_CPU_CODE", "ChildRunTiming",
    "RunNarrator", "narration_poster", "close_narration",
    "open_run", "abort_run",
    "junit_testcase_count", "junit_non_skipped_count", "ingest_reports",
    "_print_ingest_line", "filed_run", "coverage_not_measured_warning",
    "ran_nothing", "runner_exit_code", "verb_exit",
    "emit_ran_nothing",
    "RunAbandoned", "AbandonTrap", "abandon_trap", "_emit_abandoned",
    "emit_bracket_abandoned", "emit_run_abandoned",
    "run_streamed",
    "emit_run_axi",
)

COUNT_KEYS = ("passed", "failed", "pending", "total", "files")


def _source(path):
    return Path(path).read_text(encoding="utf-8")


def _is_dunder(name):
    return name.startswith("__") and name.endswith("__")


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
        with mock.patch.object(manifest, "_CLIENTS_CANDIDATES",
                               install_clients_candidates(manifest)):
            core = cli._load_client_module("_crucible_axi")
            source_dir = Path(manifest.source_clients_dir())
        run_namespace(self, core, expected_dir=source_dir)
        self.assertIs(core.RunAbandoned,
                      core.ingest_reports.__globals__.get("RunAbandoned"))


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
