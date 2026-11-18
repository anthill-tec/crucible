"""A coverage run's envelope names its least covered files.

The shared run emitter, `emit_run_axi`, states a run's kept coverage in the
envelope's `coverage` block when its caller asks (`coverage=True`). The block
keeps its percent keys, `lines` and `functions`. When the board's ingest
answer also carries the run's files (an integer `run.coverageFileCount` and a
list `run.coverageFiles`), the block gains, in order:

  * `event`: the answer's top-level `event`, the run that kept this coverage;
  * `fileCount`: the answer's `coverageFileCount`;
  * `moreFiles`: the files the block does not list, never below 0;
  * `files`: one row per answered file, in the answer's order. A row's keys,
    in order, are `file`, `linesPercent`, `linesCovered`, `linesTotal`,
    `functionsPercent`, `functionsCovered` and `functionsTotal`; `file` is
    the answer's `path`, whole, every figure is the answer's own number, and
    the three function keys are null for a file with no functions axis.

An answer that carries no files, or only half of them, gives the block its
percent keys alone; an answer that kept no coverage gives no block; a caller
that does not ask gets none.

Every stack asks. Each of the six client files holds exactly one call of the
shared emitter, in its run wrapper: `_emit_ingest_axi` (bun, python),
`_emit_run_axi` (maven, arduino, rust) and `_go_test_run` (go). Five pass
`coverage=True`; rust's wrapper passes its caller's `coverage`. The source
reading walks each client's syntax tree, never its text, and is proved on
synthetic sources before it is pointed at a real client.

The answers and the block they are stated as come from
`tests/client/kept_coverage_answer.py`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_a_coverage_runs_envelope_names_its_least_covered_files
"""

import ast
import textwrap
import unittest
from pathlib import Path

from tests.client.kept_coverage_answer import (
    EVENT,
    KEPT_COVERAGE,
    KEPT_LINES_ONLY,
    LEAST_COVERED,
    LEAST_COVERED_LINES_ONLY,
    answered_files,
    filed_answer,
    listed_rows,
    stated_block,
)
from tests.client.live_run_harness import load_client
from tests.client import CLIENT_SOURCE_DIR

REPO_ROOT = Path(__file__).resolve().parents[3]
CLIENTS = CLIENT_SOURCE_DIR

EMITTER = "emit_run_axi"

# Each client's run wrapper: the one function that calls the shared emitter.
WRAPPERS = {"bun-crucible.py": "_emit_ingest_axi",
            "python-crucible.py": "_emit_ingest_axi",
            "mvn-crucible.py": "_emit_run_axi",
            "arduino-crucible.py": "_emit_run_axi",
            "go-crucible.py": "_go_test_run",
            "rust-crucible.py": "_emit_run_axi"}

# What a wrapper hands the emitter as `coverage`, as `coverage_handed` words it.
ASKS = "True"
THE_CALLERS = "its caller's coverage"
ABSENT = "no coverage argument"

BLOCK_KEYS = ["lines", "functions", "event", "fileCount", "moreFiles", "files"]
BLOCK_KEYS_WITHOUT_FUNCTIONS = ["lines", "event", "fileCount", "moreFiles", "files"]
SEVEN_ROW_KEYS = ["file", "linesPercent", "linesCovered", "linesTotal",
                  "functionsPercent", "functionsCovered", "functionsTotal"]
PERCENT_KEYS_ALONE = {"lines": 61.46, "functions": 42.19}


# ── reading a wrapper's call of the shared emitter ──────────────────────────

def _is_emitter_call(node):
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return ((isinstance(func, ast.Attribute) and func.attr == EMITTER)
            or (isinstance(func, ast.Name) and func.id == EMITTER))


def emitter_calls(source):
    """`[(function, call)]` for every call of the shared emitter in `source`,
    in source order: the top-level function it sits in (`None` outside any)
    and the call."""
    tree = ast.parse(source)
    inside = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for inner in ast.walk(node):
                inside[id(inner)] = node
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _is_emitter_call(node):
            found.append((inside.get(id(node)), node))
    return sorted(found, key=lambda pair: (pair[1].lineno, pair[1].col_offset))


def _parameters(function):
    args = function.args
    return {arg.arg for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs)}


def coverage_handed(source, function):
    """What top-level `function` hands the shared emitter as `coverage`, in
    words: `ASKS` for the literal `True`, `THE_CALLERS` for the function's
    own `coverage` parameter, `ABSENT` when the call names none, else the
    argument as written. A function that does not hold exactly one call of
    the emitter says how many it holds."""
    calls = [(node, call) for node, call in emitter_calls(source)
             if node is not None and node.name == function]
    if len(calls) != 1:
        return f"{len(calls)} calls of {EMITTER} in {function}"
    node, call = calls[0]
    handed = [keyword.value for keyword in call.keywords if keyword.arg == "coverage"]
    if not handed:
        return ABSENT
    value = handed[0]
    if isinstance(value, ast.Constant) and value.value is True:
        return ASKS
    if (isinstance(value, ast.Name) and value.id == "coverage"
            and "coverage" in _parameters(node)):
        return THE_CALLERS
    return ast.unparse(value)


def _client_source(client):
    return (CLIENTS / client).read_text(encoding="utf-8")


# ── the emitter, driven as a client's wrapper drives it ─────────────────────

class _RecordingEmit:
    """An emit function standing in for a client's `_emit_axi`: it records
    each envelope it is handed."""

    def __init__(self):
        self.calls = []

    def __call__(self, verb, ok, result_fields, context, warnings):
        self.calls.append({"verb": verb, "ok": ok, "fields": result_fields,
                           "context": context, "warnings": list(warnings)})


class _EmitterCase(unittest.TestCase):
    maxDiff = None
    CONTEXT = {"projectKey": "key-kept-coverage", "agentId": "agent-kept-coverage",
               "wave": None}

    def setUp(self):
        self.core = load_client("_crucible_axi.py")

    def fields(self, resp, **asked):
        """The result fields of the one envelope the emitter emits for `resp`."""
        recorder = _RecordingEmit()
        self.core.emit_run_axi("regression", resp, dict(self.CONTEXT), recorder,
                               fields={}, **asked)
        self.assertEqual(len(recorder.calls), 1,
                         f"one envelope is emitted; got {recorder.calls!r}")
        return recorder.calls[0]["fields"]

    def block(self, resp):
        """The `coverage` block a caller that asks gets for `resp`."""
        fields = self.fields(resp, coverage=True)
        self.assertIn("coverage", fields,
                      f"a kept coverage is stated; fields={fields!r}")
        return fields["coverage"]

    def rows(self, resp):
        """The block's `files` rows for `resp`."""
        block = self.block(resp)
        self.assertIn("files", block,
                      f"an answer that carries the run's files gives the block "
                      f"its `files` rows; block={block!r}")
        rows = block["files"]
        self.assertIsInstance(rows, list, f"block={block!r}")
        return rows

    def row_of(self, resp, name):
        """The one row of `resp`'s block whose `file` is `name`."""
        rows = self.rows(resp)
        found = [row for row in rows if isinstance(row, dict) and row.get("file") == name]
        self.assertEqual(len(found), 1,
                         f"one row names {name!r} as its `file`; rows={rows!r}")
        return found[0]


class TheBlockNamesTheFilesTest(_EmitterCase):
    """An answer with a kept coverage, twelve files counted and ten answered."""

    def test_twelve_files_ten_of_them_answered_state_the_count_two_more_and_ten_rows(self):
        block = self.block(filed_answer())
        self.assertEqual(
            (block.get("lines"), block.get("functions"), block.get("event"),
             block.get("fileCount"), block.get("moreFiles"),
             len(block.get("files") or [])),
            (61.46, 42.19, "evt-kept-coverage-7f3a", 12, 2, 10),
            f"the block states both percents, the run that kept them, its "
            f"twelve files, the two it does not list and ten rows; "
            f"block={block!r}")
        self.assertEqual(block, stated_block(),
                         "the block is the answer's coverage and its files, "
                         "and nothing else")

    def test_the_block_holds_its_percents_then_the_event_the_two_counts_and_the_files(self):
        block = self.block(filed_answer())
        self.assertEqual(list(block), BLOCK_KEYS,
                         f"the block's keys, in order; block={block!r}")

    def test_each_row_holds_the_seven_keys_in_order(self):
        rows = self.rows(filed_answer())
        self.assertEqual([list(row) for row in rows], [SEVEN_ROW_KEYS] * 10,
                         f"each of the ten rows holds the seven keys, in "
                         f"order; rows={rows!r}")

    def test_the_rows_keep_the_answers_order(self):
        answer = filed_answer()
        answered = [kept["path"] for kept in answer["run"]["coverageFiles"]]
        percents = [kept["lines"]["percent"] for kept in answer["run"]["coverageFiles"]]
        # The answer's order follows neither the names nor the percents, so a
        # block that sorts its rows again cannot reproduce it.
        self.assertNotEqual(answered, sorted(answered))
        self.assertNotEqual(percents, sorted(percents))
        rows = self.rows(answer)
        self.assertEqual([row.get("file") for row in rows], answered,
                         "the rows are the answer's files in the answer's "
                         "order, the board's least covered first")

    def test_a_rows_figures_are_the_answers_own_numbers(self):
        # The board says 7.5 for 3 lines of 41 and 16.667 for 1 function of 6:
        # a block that divides the counts again, or rounds the percent again,
        # states another number.
        row = self.row_of(filed_answer(), "src/ingest/decode.ts")
        self.assertEqual(
            row,
            {"file": "src/ingest/decode.ts", "linesPercent": 7.5,
             "linesCovered": 3, "linesTotal": 41, "functionsPercent": 16.667,
             "functionsCovered": 1, "functionsTotal": 6},
            "a row states the answer's percents and counts as the board gave "
            "them")

    def test_a_rows_file_is_the_answers_path_whole(self):
        path = "/work/project/src/drivers/motor controller, v2.cpp"
        rows = self.rows(filed_answer())
        self.assertEqual(rows[0].get("file") if rows else None, path,
                         f"the first row names the answer's first path whole: "
                         f"its directories, its spaces and its comma; "
                         f"rows={rows[:1]!r}")

    def test_the_event_is_the_answers_top_level_event(self):
        block = self.block(filed_answer(event="evt-another-run-91c2"))
        self.assertEqual(block.get("event"), "evt-another-run-91c2",
                         f"`event` is the id the answer carries at its top "
                         f"level; block={block!r}")

    def test_three_files_of_three_are_all_listed_and_none_remain(self):
        block = self.block(filed_answer(file_count=3, figures=LEAST_COVERED[:3]))
        self.assertEqual(
            (block.get("fileCount"), block.get("moreFiles"),
             len(block.get("files") or [])),
            (3, 0, 3),
            f"a run of three files, all three answered, lists the three and "
            f"states no more; block={block!r}")
        self.assertEqual(block.get("files"), listed_rows(LEAST_COVERED[:3]))

    def test_more_files_is_never_below_zero(self):
        # A count smaller than the rows answered: the count stays the
        # answer's, and the block never states a negative remainder.
        block = self.block(filed_answer(file_count=2, figures=LEAST_COVERED[:3]))
        self.assertEqual(
            (block.get("fileCount"), block.get("moreFiles"),
             len(block.get("files") or [])),
            (2, 0, 3),
            f"`moreFiles` is the count less the rows listed, and 0 when that "
            f"would be negative; block={block!r}")


class AFileWithoutFunctionsTest(_EmitterCase):
    """A file with no functions axis, and a run with none."""

    def test_a_file_with_no_functions_axis_has_null_for_its_three_function_keys(self):
        answer = filed_answer()
        for name in ("src/types.ts", "lib/plain_constants.py"):
            row = self.row_of(answer, name)
            self.assertEqual(
                list(row), SEVEN_ROW_KEYS,
                f"a file with no functions axis still holds the seven keys; "
                f"row={row!r}")
            self.assertEqual(
                [row["functionsPercent"], row["functionsCovered"],
                 row["functionsTotal"]],
                [None, None, None],
                f"{name} has no functions axis: its three function keys are "
                f"null; row={row!r}")
        self.assertEqual(
            {key: self.row_of(answer, "src/types.ts").get(key)
             for key in ("linesPercent", "linesCovered", "linesTotal")},
            {"linesPercent": 11.11, "linesCovered": 1, "linesTotal": 9},
            "its lines figures are still the answer's")

    def test_a_file_with_functions_keeps_them_beside_one_that_has_none(self):
        row = self.row_of(filed_answer(), "app/reports/summary.py")
        self.assertEqual(
            [row.get("functionsPercent"), row.get("functionsCovered"),
             row.get("functionsTotal")],
            [22.22, 2, 9],
            f"a file with a functions axis states it, whatever its "
            f"neighbours hold; row={row!r}")

    def test_a_run_with_no_functions_axis_has_no_functions_key_in_the_block(self):
        block = self.block(filed_answer(coverage=KEPT_LINES_ONLY,
                                        figures=LEAST_COVERED_LINES_ONLY))
        self.assertEqual(list(block), BLOCK_KEYS_WITHOUT_FUNCTIONS,
                         f"a run with no functions axis states no `functions` "
                         f"percent, and still names its files; block={block!r}")
        self.assertEqual(block, stated_block(coverage=KEPT_LINES_ONLY,
                                             figures=LEAST_COVERED_LINES_ONLY))

    def test_a_run_with_no_functions_axis_has_null_function_keys_on_every_row(self):
        rows = self.rows(filed_answer(coverage=KEPT_LINES_ONLY,
                                      figures=LEAST_COVERED_LINES_ONLY))
        self.assertEqual([list(row) for row in rows], [SEVEN_ROW_KEYS] * 10,
                         f"every row still holds the seven keys; rows={rows!r}")
        self.assertEqual(
            [[row["functionsPercent"], row["functionsCovered"], row["functionsTotal"]]
             for row in rows],
            [[None, None, None]] * 10,
            f"no file of the run has a functions axis: each row's three "
            f"function keys are null; rows={rows!r}")
        self.assertEqual(rows, listed_rows(LEAST_COVERED_LINES_ONLY))


class AnAnswerWithoutFilesTest(_EmitterCase):
    """An answer that carries no files, half of them, or no coverage at all:
    the block is what it was before a board answered files."""

    def kept_only(self, **run_keys):
        """A green answer that kept its coverage, with `run_keys` beside it in
        the `run` block and no other word of the run's files."""
        return {"ok": True, "changed": True, "event": EVENT,
                "run": {"passed": 7, "failed": 0, "pending": 0, "total": 7,
                        "files": 3, "coverage": KEPT_COVERAGE, **run_keys}}

    def assert_percent_keys_alone(self, resp, why):
        block = self.block(resp)
        self.assertEqual(block, PERCENT_KEYS_ALONE, f"{why}; block={block!r}")
        self.assertEqual(list(block), ["lines", "functions"], f"{why}; block={block!r}")

    def test_a_kept_coverage_with_no_file_keys_states_its_percent_keys_alone(self):
        self.assert_percent_keys_alone(
            self.kept_only(),
            "a board that answers no files gives the block its two percents "
            "and no `event`, no count and no rows")

    def test_an_answer_that_kept_no_coverage_states_no_block(self):
        fields = self.fields({"ok": True, "changed": True, "event": EVENT,
                              "run": {"passed": 6, "failed": 1, "pending": 0,
                                      "total": 7, "files": 3}},
                             coverage=True)
        self.assertNotIn("coverage", fields,
                         f"the board kept no coverage, so the envelope states "
                         f"none; fields={fields!r}")

    def test_a_file_count_with_no_file_list_states_the_percent_keys_alone(self):
        self.assert_percent_keys_alone(
            self.kept_only(coverageFileCount=12),
            "a count with no list is not the run's files")

    def test_a_file_list_with_no_file_count_states_the_percent_keys_alone(self):
        self.assert_percent_keys_alone(
            self.kept_only(coverageFiles=answered_files()),
            "a list with no count is not the run's files")

    def test_a_file_count_that_is_not_an_integer_states_the_percent_keys_alone(self):
        for count in ("12", 12.5, None, True):
            self.assert_percent_keys_alone(
                self.kept_only(coverageFileCount=count,
                               coverageFiles=answered_files()),
                f"a count of {count!r} is not an integer")

    def test_a_file_list_that_is_not_a_list_states_the_percent_keys_alone(self):
        for files in ({"0": answered_files()[0]}, "src/types.ts", None):
            self.assert_percent_keys_alone(
                self.kept_only(coverageFileCount=12, coverageFiles=files),
                f"files answered as {type(files).__name__} are not a list")

    def test_a_caller_that_does_not_ask_gets_no_block(self):
        answer = filed_answer()
        for asked in ({"coverage": False}, {}):
            fields = self.fields(answer, **asked)
            self.assertNotIn("coverage", fields,
                             f"a caller asking {asked!r} gets no block, "
                             f"whatever the answer carries; fields={fields!r}")


# ── every stack asks ────────────────────────────────────────────────────────

_WRAPPER = textwrap.dedent('''
    def _emit_run_axi(verb, resp, project_dir, agent, *, ok=None{parameter}):
        """Emit the run's envelope."""
        return _axi().emit_run_axi(
            verb, resp, _axi_context(project_dir, agent_id=agent),
            _emit_axi, ok=ok, fields={{}}{argument})
''')


def _wrapper(argument="", parameter=""):
    return _WRAPPER.format(argument=argument, parameter=parameter)


class TheCoverageArgumentReadingIsProvedOnSyntheticSourcesTest(unittest.TestCase):

    def test_a_wrapper_passing_true_asks(self):
        self.assertEqual(coverage_handed(_wrapper(", coverage=True"), "_emit_run_axi"),
                         ASKS)

    def test_a_wrapper_passing_false_or_nothing_does_not_ask(self):
        self.assertEqual(coverage_handed(_wrapper(", coverage=False"), "_emit_run_axi"),
                         "False")
        self.assertEqual(coverage_handed(_wrapper(), "_emit_run_axi"), ABSENT)

    def test_a_wrapper_passing_its_own_coverage_parameter_passes_its_callers(self):
        source = _wrapper(", coverage=coverage", ", coverage=False")
        self.assertEqual(coverage_handed(source, "_emit_run_axi"), THE_CALLERS)

    def test_a_name_that_is_not_the_wrappers_parameter_is_not_its_callers(self):
        self.assertEqual(coverage_handed(_wrapper(", coverage=coverage"), "_emit_run_axi"),
                         "coverage")
        self.assertEqual(
            coverage_handed(_wrapper(", coverage=measured", ", measured=False"),
                            "_emit_run_axi"),
            "measured")

    def test_every_call_is_counted_with_the_function_it_sits_in(self):
        source = _wrapper(", coverage=True") + textwrap.dedent('''
            def cmd_test(args):
                def close():
                    return _axi().emit_run_axi("test", {}, {}, _emit_axi)
                return close()

            emit_run_axi("auto-ingest", {}, {}, print)
        ''')
        self.assertEqual(
            [node.name if node is not None else None
             for node, _call in emitter_calls(source)],
            ["_emit_run_axi", "cmd_test", None],
            "a call is found wherever it sits: in a wrapper, nested in "
            "another function, or at the top level")
        self.assertEqual(coverage_handed(source, "cmd_test"), ABSENT)
        self.assertEqual(coverage_handed(source, "cmd_regression"),
                         "0 calls of emit_run_axi in cmd_regression")


class EveryStacksRunWrapperAsksForCoverageTest(unittest.TestCase):
    """The six clients' own sources."""

    def assert_asks(self, client):
        function = WRAPPERS[client]
        self.assertEqual(
            coverage_handed(_client_source(client), function), ASKS,
            f"clients/{client}: `{function}` passes `coverage=True` to "
            f"`{EMITTER}`, so the stack's run envelope states the coverage "
            f"the board kept")

    def test_each_client_file_holds_exactly_one_call_of_the_shared_emitter(self):
        counts = {client: len(emitter_calls(_client_source(client)))
                  for client in WRAPPERS}
        self.assertEqual(counts, dict.fromkeys(WRAPPERS, 1),
                         f"each client emits a run's envelope through one "
                         f"call of `{EMITTER}`")

    def test_each_clients_one_call_sits_in_its_run_wrapper(self):
        found = {client: [node.name if node is not None else None
                          for node, _call in emitter_calls(_client_source(client))]
                 for client in WRAPPERS}
        self.assertEqual(found, {client: [function]
                                 for client, function in WRAPPERS.items()})

    def test_the_bun_wrapper_asks_for_coverage(self):
        self.assert_asks("bun-crucible.py")

    def test_the_python_wrapper_asks_for_coverage(self):
        self.assert_asks("python-crucible.py")

    def test_the_maven_wrapper_asks_for_coverage(self):
        self.assert_asks("mvn-crucible.py")

    def test_the_arduino_wrapper_asks_for_coverage(self):
        self.assert_asks("arduino-crucible.py")

    def test_the_go_run_asks_for_coverage(self):
        self.assert_asks("go-crucible.py")

    def test_the_rust_wrapper_passes_its_callers_coverage(self):
        self.assertEqual(
            coverage_handed(_client_source("rust-crucible.py"),
                            WRAPPERS["rust-crucible.py"]),
            THE_CALLERS,
            "clients/rust-crucible.py: `_emit_run_axi` hands the emitter the "
            "`coverage` its caller passed: a rust run asks only when it "
            "measured coverage")


if __name__ == "__main__":
    unittest.main()
