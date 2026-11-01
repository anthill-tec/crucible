"""The streamed-run close is ONE function in `clients/_crucible_run.py`, called
by both `python-crucible.py` and `bun-crucible.py`, and neither keeps a copy.

The close is what follows a streamed run's runner exit: the count from the
stream, zero discovery, ran-nothing, the compile ingest when nothing was held
versus the stream close with its warning, and the unfiled answer. Python's
streamed run carried it in its own module (`_stream_counts`, `_emit_unfiled`
and the stream close at the end of `_streamed_run`); it moves into the shared
run module, and the bun client's stream target calls the same function.

A source check over the three modules' ASTs (comments and docstrings never
count):
- **the shared close exists:** `_crucible_run.py` defines `close_streamed_run`
  at top level, and it reaches the run's stream close (`close_stream`)
  directly or through the module's own functions -- an empty stand-in does
  not pass;
- **both clients call it:** each client module holds a call to
  `close_streamed_run` (`_axi().close_streamed_run(...)`, the way each reaches
  every other shared run helper);
- **neither keeps a copy:** a client module defines no function named
  `_stream_counts` or `_emit_unfiled`, compares nothing to the stream's
  event names (`"test-end"`, `"run-end"`: the stream is read in the shared
  module only), and calls `close_stream` nowhere (the stream close is reached
  only through the shared close).

The check is proved both ways on synthetic sources before it is applied to
the three real modules.

Python's existing streamed-run tests are the behavioural half of the shared
close: they must pass, unchanged, through the extracted close. No test here
repeats them.

Interface choice (the spec leaves the name and signature open; GREEN is asked
to use them): the shared close is

    close_streamed_run(verb, result, *, run_id, held, stream_path, stack,
                       framework, post_fn, project_key, agent_id, tier,
                       context, release, warnings, emit, emit_ingest,
                       ingest_compile, no_report_warning, zero_discovery=None,
                       collect_coverage=None, narrator=None, unfiled=None,
                       gate=False)

in `clients/_crucible_run.py`, re-exported through `_crucible_axi` like every
other run helper. Its client-specific facts arrive as the keyword hooks: its
envelope (`emit`, `emit_ingest`), its compile ingest (`ingest_compile`), its
runner's no-report warning (`no_report_warning`), and its runner's
zero-discovery reading (`zero_discovery`: python's unittest reading; None for
bun). `unfiled` is the cause when no run was opened, so the unfiled answer is
the shared close's too. It returns the verb's exit code. Only the NAME is
pinned below; the parameters are the proposal GREEN may refine.
"""

import ast
import textwrap
import unittest
from pathlib import Path

CLIENTS = Path(__file__).resolve().parents[2] / "clients"
SHARED_RUN_MODULE = CLIENTS / "_crucible_run.py"
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
BUN_CLIENT = CLIENTS / "bun-crucible.py"

SHARED_CLOSE = "close_streamed_run"
STREAM_CLOSE = "close_stream"
# The functions python's streamed run kept for itself, which move with the close.
MOVED_FUNCTIONS = ("_stream_counts", "_emit_unfiled")
# The stream's event names: reading a stream's events is the shared module's.
STREAM_EVENT_NAMES = ("test-end", "run-end")


def _called_name(call):
    func = call.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _calls_in(node):
    return {_called_name(n) for n in ast.walk(node) if isinstance(n, ast.Call)} - {None}


def shared_close_findings(source):
    """What keeps `source` (the shared run module) from holding the shared
    close: `[]` when it defines `close_streamed_run` at top level and that
    function reaches `close_stream`, directly or through the module's own
    top-level functions."""
    tree = ast.parse(source)
    functions = {node.name: node for node in tree.body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    if SHARED_CLOSE not in functions:
        return [f"no top-level `{SHARED_CLOSE}`"]
    seen, pending = set(), [SHARED_CLOSE]
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        called = _calls_in(functions[name])
        if STREAM_CLOSE in called:
            return []
        pending.extend(n for n in called if n in functions)
    return [f"`{SHARED_CLOSE}` never reaches `{STREAM_CLOSE}`"]


def calls_shared_close(source):
    """True when `source` (a client module) calls `close_streamed_run`."""
    return SHARED_CLOSE in _calls_in(ast.parse(source))


def copied_close_findings(source):
    """Every sign that `source` (a client module) keeps its own copy of the
    close, as `(kind, name)`, in source order."""
    findings = []
    for node in ast.walk(ast.parse(source)):
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name in MOVED_FUNCTIONS):
            findings.append((node.lineno, "defines", node.name))
        elif isinstance(node, ast.Compare):
            for operand in [node.left, *node.comparators]:
                if (isinstance(operand, ast.Constant)
                        and operand.value in STREAM_EVENT_NAMES):
                    findings.append((node.lineno, "compares to", operand.value))
        elif isinstance(node, ast.Call) and _called_name(node) == STREAM_CLOSE:
            findings.append((node.lineno, "calls", STREAM_CLOSE))
    return [(kind, name) for _line, kind, name in sorted(findings)]


# ── synthetic sources ───────────────────────────────────────────────────────

_CLEAN_CLIENT = textwrap.dedent('''
    """A client whose streamed run ends in the shared close. Its docstring
    may say `test-end` and `close_stream(...)`: prose is never code."""

    def _axi():
        return None

    def _streamed_run(verb, result, run_id, held, stream_path):
        # The stream's test-end lines are counted by the shared close.
        return _axi().close_streamed_run(verb, result, run_id=run_id, held=held,
                                         stream_path=stream_path)
''')

_SHARED_MODULE = textwrap.dedent('''
    def close_stream(post_fn, **payload):
        return post_fn("/api/v2/runs", payload)

    def _close_by_the_stream(post_fn, run_id):
        return close_stream(post_fn, run_id=run_id)

    def close_streamed_run(verb, result, *, run_id, post_fn):
        return _close_by_the_stream(post_fn, run_id)
''')


class TheSourceCheckIsProvedOnSyntheticSourcesTest(unittest.TestCase):

    def test_a_client_that_calls_the_shared_close_and_copies_nothing_passes(self):
        self.assertTrue(calls_shared_close(_CLEAN_CLIENT))
        self.assertEqual(copied_close_findings(_CLEAN_CLIENT), [])

    def test_a_client_that_never_calls_the_shared_close_is_caught(self):
        source = _CLEAN_CLIENT.replace("close_streamed_run", "close_the_run_itself")
        self.assertFalse(calls_shared_close(source))

    def test_a_client_naming_the_shared_close_only_in_prose_is_caught(self):
        source = textwrap.dedent('''
            """It ends in `close_streamed_run(...)`, says this docstring."""

            def _streamed_run():
                # close_streamed_run() is mentioned here and never called.
                return None
        ''')
        self.assertFalse(calls_shared_close(source))

    def test_a_client_defining_its_own_stream_count_is_caught(self):
        source = _CLEAN_CLIENT + textwrap.dedent('''
            def _stream_counts(path):
                return 0, None
        ''')
        self.assertEqual(copied_close_findings(source), [("defines", "_stream_counts")])

    def test_a_client_defining_its_own_unfiled_answer_inside_another_function_is_caught(self):
        source = _CLEAN_CLIENT + textwrap.dedent('''
            def _verb():
                def _emit_unfiled(why):
                    return why
                return _emit_unfiled
        ''')
        self.assertEqual(copied_close_findings(source), [("defines", "_emit_unfiled")])

    def test_a_client_reading_the_streams_events_is_caught(self):
        source = _CLEAN_CLIENT + textwrap.dedent('''
            def _count(events):
                ends = sum(1 for e in events if e.get("event") == "test-end")
                closed = any("run-end" == e.get("event") for e in events)
                return ends, closed
        ''')
        self.assertEqual(copied_close_findings(source),
                         [("compares to", "test-end"), ("compares to", "run-end")])

    def test_a_client_calling_the_stream_close_itself_is_caught(self):
        source = _CLEAN_CLIENT + textwrap.dedent('''
            def _close(run_id):
                return _axi().close_stream(None, run_id=run_id)
        ''')
        self.assertEqual(copied_close_findings(source), [("calls", "close_stream")])

    def test_a_shared_module_whose_close_reaches_the_stream_close_passes(self):
        self.assertEqual(shared_close_findings(_SHARED_MODULE), [])

    def test_a_shared_module_with_no_shared_close_is_caught(self):
        source = _SHARED_MODULE.replace("def close_streamed_run", "def close_the_run")
        self.assertEqual(shared_close_findings(source), [f"no top-level `{SHARED_CLOSE}`"])

    def test_a_shared_close_that_is_an_empty_stand_in_is_caught(self):
        source = textwrap.dedent('''
            def close_stream(post_fn, **payload):
                return post_fn("/api/v2/runs", payload)

            def close_streamed_run(verb, result, *, run_id, post_fn):
                return 0
        ''')
        self.assertEqual(shared_close_findings(source),
                         [f"`{SHARED_CLOSE}` never reaches `{STREAM_CLOSE}`"])

    def test_a_shared_close_nested_in_a_class_is_not_top_level(self):
        source = textwrap.dedent('''
            def close_stream(post_fn, **payload):
                return post_fn("/api/v2/runs", payload)

            class Closer:
                def close_streamed_run(self, post_fn):
                    return close_stream(post_fn)
        ''')
        self.assertEqual(shared_close_findings(source), [f"no top-level `{SHARED_CLOSE}`"])


# ── the three real modules ──────────────────────────────────────────────────


class TheStreamedRunCloseIsSharedTest(unittest.TestCase):

    def test_the_shared_run_module_holds_the_streamed_run_close(self):
        findings = shared_close_findings(SHARED_RUN_MODULE.read_text(encoding="utf-8"))
        self.assertEqual(findings, [],
                         f"clients/_crucible_run.py holds the shared streamed-run close; "
                         f"found: {findings!r}")

    def test_the_python_client_calls_the_shared_close(self):
        self.assertTrue(calls_shared_close(PYTHON_CLIENT.read_text(encoding="utf-8")),
                        f"python-crucible.py's streamed run ends in `{SHARED_CLOSE}`")

    def test_the_python_client_keeps_no_copy_of_the_close(self):
        findings = copied_close_findings(PYTHON_CLIENT.read_text(encoding="utf-8"))
        self.assertEqual(findings, [],
                         f"python-crucible.py keeps its own copy of the close: {findings!r}")

    def test_the_bun_client_calls_the_shared_close(self):
        self.assertTrue(calls_shared_close(BUN_CLIENT.read_text(encoding="utf-8")),
                        f"bun-crucible.py's stream target ends in `{SHARED_CLOSE}`")

    def test_the_bun_client_keeps_no_copy_of_the_close(self):
        findings = copied_close_findings(BUN_CLIENT.read_text(encoding="utf-8"))
        self.assertEqual(findings, [],
                         f"bun-crucible.py keeps its own copy of the close: {findings!r}")


if __name__ == "__main__":
    unittest.main()
