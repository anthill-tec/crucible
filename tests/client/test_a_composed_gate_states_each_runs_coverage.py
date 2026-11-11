"""A composed gate states the coverage of each run it read.

A gate composed of several runs reads each run's own envelope: the whole-suite
run and a suite of another framework in the gate's own process, a suite
another stack owns from the envelope its dispatched client printed. A run that
kept coverage states a `coverage` block in that envelope.

The gate's envelope carries `coverageRuns`: one row per run whose envelope
carried a `coverage` block, in the order the runs ran. A row's keys, in order,
are `suite` (what the gate calls that run: its whole-suite label, or the
suite's target), `stack`, then the block's own keys in the block's order, the
block whole. The key is absent when no run carried a block.

A gate that is one run alone prints that run's envelope, so it carries the
run's `coverage` and no `coverageRuns`.

A dispatched run that printed no envelope, or one that cannot be decoded, has
no row and adds no error about coverage: the other runs' rows stand as they
are, and the gate says of that run what it says of any run that reported no
counts.

Each test drives the shared composition (`gate_regression`) as the clients
call it, with a stub declaration surface, stubs for the runs in the gate's own
process, and a real child process for each dispatched suite. Every envelope a
run prints is written by the shared run emitter from a board answer of
`tests/client/kept_coverage_answer.py`, so the block crosses the same encoding
a real run's does.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_composed_gate_states_each_runs_coverage
"""

import argparse
import contextlib
import io
import sys
import unittest

from tests.client.kept_coverage_answer import (
    KEPT_COVERAGE,
    KEPT_LINES_ONLY,
    LEAST_COVERED_LINES_ONLY,
    ROW_KEYS,
    filed_answer,
    stated_block,
)
from tests.client.live_run_harness import load_client, load_toon

AXI = load_client("_crucible_axi.py")
# The runs' envelopes are written by a core of their own, so writing them
# leaves nothing behind in the core that composes the gate.
RUN_CORE = load_client("_crucible_axi.py")
TOON = load_toon()

GATE = "pre-merge-gate"
RUN_CONTEXT = {"projectKey": "stub-key", "agentId": "stub-agent", "wave": None}

#: Two suites another stack owns: each is dispatched to that stack's client.
FIRST_DISPATCHED = "it-python"
SECOND_DISPATCHED = "client-python"
DISPATCHED_COMMANDS = {
    FIRST_DISPATCHED: "python3 -m unittest discover -s tests/it",
    SECOND_DISPATCHED: "python3 -m unittest discover -s tests/client",
}
#: A suite of the gate's own stack under a framework the whole-suite run does
#: not collect: it runs in the gate's own process, as a suite of its own.
OWN_FRAMEWORK_SUITE = "test:vitest"

#: A run that kept its files, a run that kept three files and no functions
#: axis, and a run whose answer carried its percents alone.
DISPATCHED_EVENT = "evt-dispatched-kept-2b"
WITH_FILES = filed_answer()
THREE_FILES_LINES_ONLY = filed_answer(
    coverage=KEPT_LINES_ONLY, event=DISPATCHED_EVENT, file_count=3,
    figures=LEAST_COVERED_LINES_ONLY[:3], passed=2)
PERCENTS_ALONE = {"ok": True, "changed": True, "event": "evt-percents-alone-9c",
                  "run": {"passed": 3, "failed": 0, "pending": 0, "total": 3,
                          "files": 1, "coverage": KEPT_COVERAGE}}
NO_COVERAGE = {"ok": True, "changed": True, "event": "evt-no-coverage-4d",
               "run": {"passed": 5, "failed": 0, "pending": 0, "total": 5,
                       "files": 2}}

BLOCK_WITH_FILES = stated_block()
BLOCK_OF_THREE_FILES = stated_block(
    coverage=KEPT_LINES_ONLY, event=DISPATCHED_EVENT, file_count=3,
    figures=LEAST_COVERED_LINES_ONLY[:3])
BLOCK_OF_PERCENTS = {"lines": 61.46, "functions": 42.19}


def run_envelope_text(verb, answer):
    """The envelope a run prints for the board's `answer`, as the shared run
    emitter writes it for a client that asks for the coverage."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        RUN_CORE.emit_run_axi(
            verb, answer, dict(RUN_CONTEXT),
            lambda v, ok, fields, context, warnings: RUN_CORE.emit_axi(
                v, ok, fields, context, warnings),
            coverage=True)
    return out.getvalue()


def decoded(text):
    envelope = TOON.decode(text)
    axi = envelope.get("axi") if isinstance(envelope, dict) else None
    return axi if isinstance(axi, dict) else {}


def _surface(template, declared, suites):
    """A stub of one stack's declaration surface: its target template, the
    tier targets it declares, and the suites it enumerates beyond them."""
    names = {template.replace("<tier>", tier) for tier in declared}

    def read(_args, name):
        return name if name in names else None

    def enumerate_suites(args, surface):
        return tuple(AXI.template_declared_suites(args, surface)) + tuple(suites)

    return AXI.DeclaredTierSurface(target=template, names="a stub declaration",
                                   read=read, run=lambda *_a, **_k: 0,
                                   suites=enumerate_suites)


class _Runs:
    """The runs a gate reads, each printing the envelope of its board answer,
    and the order the gate ran them in."""

    def __init__(self, whole, own=None, dispatched=None):
        self.whole, self.own, self.dispatched = whole, own or {}, dispatched or {}
        self.ran = []

    def run_whole_suite(self):
        self.ran.append("whole suite")
        sys.stdout.write(run_envelope_text(GATE, self.whole))
        return 0

    def run_suite(self, suite):
        self.ran.append(suite.target)
        sys.stdout.write(run_envelope_text("test", self.own[suite.target]))
        return 0

    def dispatch(self, suite):
        self.ran.append(suite.target)
        text = run_envelope_text("regression", self.dispatched[suite.target])
        return [sys.executable, "-c", f"import sys; sys.stdout.write({text!r})"], None


class _ComposedGateCase(unittest.TestCase):
    maxDiff = None

    def compose(self, runs, surface, stack, **composition):
        """`gate_regression` called as a client calls it: the gate's exit and
        its envelope."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            code = AXI.gate_regression(
                argparse.Namespace(suites=None), surface=surface, stack=stack,
                verb=GATE, whole_suite=runs.run_whole_suite,
                dispatch=runs.dispatch, context={"projectKey": "stub-key"},
                crucible_url="http://127.0.0.1:1",
                whole_suite_alone=runs.run_whole_suite, **composition)
        text = out.getvalue()
        self.assertEqual(text.count("axi:"), 1,
                         f"the gate prints one envelope; stdout={text!r}")
        envelope = decoded(text)
        self.assertEqual(code, 0, f"every run passed; envelope={envelope!r}")
        self.assertIs(envelope.get("ok"), True, f"envelope={envelope!r}")
        return envelope

    def maven_gate(self, whole, first, second):
        """A maven gate of three runs: its whole-suite run in its own process,
        then two suites the python client is dispatched for."""
        runs = _Runs(whole, dispatched={FIRST_DISPATCHED: first,
                                        SECOND_DISPATCHED: second})
        surface = _surface("<tier>", ("unit", "integration"),
                           [(name, DISPATCHED_COMMANDS[name])
                            for name in (FIRST_DISPATCHED, SECOND_DISPATCHED)])
        envelope = self.compose(runs, surface, "mvn")
        self.assertEqual(runs.ran, ["whole suite", FIRST_DISPATCHED, SECOND_DISPATCHED],
                         "the gate ran three runs, in this order")
        return envelope

    def bun_gate(self, whole, own, dispatched):
        """A bun gate of three runs: its whole-suite run and a suite of
        another framework, both in its own process, then a dispatched suite."""
        runs = _Runs(whole, own={OWN_FRAMEWORK_SUITE: own},
                     dispatched={FIRST_DISPATCHED: dispatched})
        surface = _surface("test:<tier>", ("unit",), [
            (OWN_FRAMEWORK_SUITE, None, "vitest"),
            (FIRST_DISPATCHED, DISPATCHED_COMMANDS[FIRST_DISPATCHED])])
        envelope = self.compose(runs, surface, "bun", run_suite=runs.run_suite,
                                whole_framework="bun")
        self.assertEqual(runs.ran, ["whole suite", OWN_FRAMEWORK_SUITE, FIRST_DISPATCHED],
                         "the gate ran three runs, in this order")
        return envelope

    def coverage_runs(self, envelope):
        self.assertIn(
            "coverageRuns", envelope,
            f"a gate whose runs stated their coverage carries `coverageRuns`; "
            f"envelope keys={list(envelope)!r}")
        rows = envelope["coverageRuns"]
        self.assertIsInstance(rows, list, f"coverageRuns={rows!r}")
        return rows


class AGateOfThreeRunsTwoOfThemWithCoverageTest(_ComposedGateCase):
    """The whole-suite run and the second dispatched suite kept coverage; the
    first dispatched suite measured none."""

    def rows(self):
        return self.coverage_runs(self.maven_gate(
            WITH_FILES, NO_COVERAGE, THREE_FILES_LINES_ONLY))

    def test_the_gate_states_two_rows_in_the_order_the_runs_ran(self):
        rows = self.rows()
        self.assertEqual(
            [(row.get("suite"), row.get("stack")) for row in rows],
            [(AXI.whole_suite_label("mvn"), "mvn"), (SECOND_DISPATCHED, "python")],
            "one row per run that stated its coverage: the whole-suite run "
            "under its label, then the dispatched suite under its target; "
            "the run that measured none has no row")

    def test_each_row_carries_its_runs_block_whole(self):
        rows = self.rows()
        self.assertEqual(
            rows,
            [{"suite": AXI.whole_suite_label("mvn"), "stack": "mvn",
              **BLOCK_WITH_FILES},
             {"suite": SECOND_DISPATCHED, "stack": "python",
              **BLOCK_OF_THREE_FILES}],
            "each row is the run's own block, every key and every file row "
            "of it, whether the run ran in the gate's process or was read "
            "from a dispatched client's envelope")

    def test_a_rows_keys_are_suite_then_stack_then_the_blocks_own_in_order(self):
        rows = self.rows()
        self.assertEqual(
            [list(row) for row in rows],
            [["suite", "stack", "lines", "functions", "event", "fileCount",
              "moreFiles", "files"],
             ["suite", "stack", "lines", "event", "fileCount", "moreFiles",
              "files"]],
            "a run with no functions axis has no `functions` key in its row")
        for row in rows:
            for listed in row.get("files") or []:
                self.assertEqual(list(listed), list(ROW_KEYS), f"row={listed!r}")

    def test_the_gates_suites_and_counts_are_as_before_beside_the_rows(self):
        envelope = self.maven_gate(WITH_FILES, NO_COVERAGE, THREE_FILES_LINES_ONLY)
        self.coverage_runs(envelope)
        self.assertEqual(
            [(row.get("suite"), row.get("outcome")) for row in envelope.get("suites") or []],
            [("unit", "pass"), ("integration", "pass"), (FIRST_DISPATCHED, "pass"),
             (SECOND_DISPATCHED, "pass")], f"envelope={envelope!r}")
        self.assertEqual(envelope.get("run"),
                         {"passed": 14, "failed": 0, "pending": 0, "total": 14,
                          "files": 8}, f"envelope={envelope!r}")


class AGateThatRunsASuiteInItsOwnProcessTest(_ComposedGateCase):
    """The whole-suite run measured no coverage; a suite of another framework,
    run in the gate's own process, and a dispatched suite both kept theirs."""

    def test_a_suite_run_in_the_gates_process_and_a_dispatched_one_each_have_a_row(self):
        rows = self.coverage_runs(self.bun_gate(
            NO_COVERAGE, PERCENTS_ALONE, WITH_FILES))
        self.assertEqual(
            rows,
            [{"suite": OWN_FRAMEWORK_SUITE, "stack": "bun", **BLOCK_OF_PERCENTS},
             {"suite": FIRST_DISPATCHED, "stack": "python", **BLOCK_WITH_FILES}],
            "each suite's row is under its target and its own stack; a block "
            "of percents alone is stated as it is")
        self.assertEqual(
            [list(row) for row in rows],
            [["suite", "stack", "lines", "functions"],
             ["suite", "stack", "lines", "functions", "event", "fileCount",
              "moreFiles", "files"]])

    def test_all_three_runs_with_coverage_give_three_rows_in_run_order(self):
        rows = self.coverage_runs(self.bun_gate(
            THREE_FILES_LINES_ONLY, PERCENTS_ALONE, WITH_FILES))
        self.assertEqual(
            [(row.get("suite"), row.get("stack"), row.get("event")) for row in rows],
            [(AXI.whole_suite_label("bun"), "bun", DISPATCHED_EVENT),
             (OWN_FRAMEWORK_SUITE, "bun", None),
             (FIRST_DISPATCHED, "python", BLOCK_WITH_FILES["event"])])


class AGateWhoseRunsStatedNoCoverageTest(_ComposedGateCase):
    """Guards: these hold today."""

    def test_a_gate_none_of_whose_runs_carried_a_block_has_no_coverage_runs(self):
        for label, envelope in (
                ("a maven gate", self.maven_gate(NO_COVERAGE, NO_COVERAGE, NO_COVERAGE)),
                ("a bun gate", self.bun_gate(NO_COVERAGE, NO_COVERAGE, NO_COVERAGE))):
            with self.subTest(gate=label):
                self.assertNotIn("coverageRuns", envelope,
                                 f"envelope keys={list(envelope)!r}")
                self.assertEqual(len(envelope.get("suites") or []), 4 if "maven" in label else 3)

    def test_a_gate_that_is_one_run_alone_prints_that_runs_envelope_with_its_coverage(self):
        runs = _Runs(WITH_FILES)
        surface = AXI.DeclaredTierSurface(
            target="tests/<tier>", names="a stub declaration",
            read=lambda _args, _name: None, run=lambda *_a, **_k: 0, suites=None)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = AXI.gate_regression(
                argparse.Namespace(suites=None), surface=surface, stack="python",
                verb=GATE, whole_suite=runs.run_whole_suite, dispatch=runs.dispatch,
                context={"projectKey": "stub-key"},
                crucible_url="http://127.0.0.1:1",
                whole_suite_alone=runs.run_whole_suite)
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue(), run_envelope_text(GATE, WITH_FILES),
                         "the gate's stdout is that run's own envelope alone")
        envelope = decoded(out.getvalue())
        self.assertEqual(envelope.get("coverage"), BLOCK_WITH_FILES)
        self.assertNotIn("coverageRuns", envelope)


#: What a dispatched client left on stdout when it printed no envelope.
STDOUT_WITHOUT_AN_ENVELOPE = {
    "nothing at all": "",
    "its runner's own lines alone": "Ran 4 tests in 0.012s\n\nOK\n",
}
#: How many rows of its ten-row file table the cut envelope still holds.
ROWS_BEFORE_THE_CUT = 3


def envelope_cut_inside_its_file_table():
    """The envelope of a run that kept its files, cut off three rows into its
    ten-row file table: its percents and its first rows are on stdout, and the
    document cannot be decoded, because the table says ten rows and holds
    three."""
    lines = run_envelope_text("regression", WITH_FILES).splitlines(keepends=True)
    table = next(index for index, line in enumerate(lines)
                 if line.strip().startswith("files["))
    return "".join(lines[:table + 1 + ROWS_BEFORE_THE_CUT])


class _RunsWithStagedStdout(_Runs):
    """`_Runs`, with the stdout of some dispatched suites staged as text
    instead of written from a board answer: `stdout` maps a suite's target to
    what its dispatched client prints."""

    def __init__(self, whole, own=None, dispatched=None, stdout=None):
        super().__init__(whole, own, dispatched)
        self.stdout = stdout or {}

    def dispatch(self, suite):
        if suite.target not in self.stdout:
            return super().dispatch(suite)
        self.ran.append(suite.target)
        text = self.stdout[suite.target]
        return [sys.executable, "-c", f"import sys; sys.stdout.write({text!r})"], None


class AGateWhoseDispatchedRunPrintedNoReadableEnvelopeTest(unittest.TestCase):
    """Guards: these hold today. A maven gate of three runs whose first
    dispatched suite's client exited 0 and left no envelope the gate can
    read."""

    maxDiff = None

    def gate(self, whole, first_stdout, second):
        """The gate's exit and its envelope, its first dispatched suite
        printing `first_stdout` and its two other runs the envelopes of their
        board answers."""
        runs = _RunsWithStagedStdout(whole, dispatched={SECOND_DISPATCHED: second},
                                     stdout={FIRST_DISPATCHED: first_stdout})
        surface = _surface("<tier>", ("unit", "integration"),
                           [(name, DISPATCHED_COMMANDS[name])
                            for name in (FIRST_DISPATCHED, SECOND_DISPATCHED)])
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            code = AXI.gate_regression(
                argparse.Namespace(suites=None), surface=surface, stack="mvn",
                verb=GATE, whole_suite=runs.run_whole_suite,
                dispatch=runs.dispatch, context={"projectKey": "stub-key"},
                crucible_url="http://127.0.0.1:1",
                whole_suite_alone=runs.run_whole_suite)
        text = out.getvalue()
        self.assertEqual(
            [line for line in text.splitlines() if line.startswith("axi:")],
            ["axi:"], f"the gate prints one envelope; stdout={text!r}")
        envelope = decoded(text)
        self.assertEqual(runs.ran, ["whole suite", FIRST_DISPATCHED, SECOND_DISPATCHED],
                         "the gate ran three runs, in this order")
        return code, envelope

    def assertTheUnreadRunIsOnlyARunWithoutCounts(self, code, envelope):
        """The gate says of the unread run what it says of any run that
        reported no counts, and nothing about coverage."""
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        self.assertNotEqual(code, 0, f"envelope={envelope!r}")
        self.assertEqual(
            [(row.get("suite"), row.get("outcome")) for row in envelope.get("suites") or []],
            [("unit", "pass"), ("integration", "pass"), (FIRST_DISPATCHED, "fail"),
             (SECOND_DISPATCHED, "pass")], f"envelope={envelope!r}")
        warnings = envelope.get("warnings")
        self.assertEqual(
            [warning.get("code") for warning in warnings or []],
            [AXI.GATE_SUITE_UNREPORTED_CODE],
            f"one warning, the one a run that reported no counts has; "
            f"warnings={warnings!r}")
        self.assertIn(f"`{FIRST_DISPATCHED}`", warnings[0].get("detail"),
                      f"the warning names the unread run; warnings={warnings!r}")
        self.assertNotIn("coverage", str(warnings).lower(),
                         f"no warning is about coverage; warnings={warnings!r}")
        self.assertNotIn("error", envelope,
                         f"the envelope states no error; envelope={envelope!r}")
        self.assertEqual(
            [key for key in envelope if "coverage" in key.lower()],
            ["coverageRuns"] if "coverageRuns" in envelope else [],
            f"`coverageRuns` is the envelope's one key about coverage; "
            f"keys={list(envelope)!r}")

    def assertTheOtherRunsRowsStandAlone(self, envelope, why):
        self.assertEqual(
            envelope.get("coverageRuns"),
            [{"suite": AXI.whole_suite_label("mvn"), "stack": "mvn",
              **BLOCK_WITH_FILES},
             {"suite": SECOND_DISPATCHED, "stack": "python",
              **BLOCK_OF_THREE_FILES}],
            f"{why}: the rows are the two other runs' own blocks, whole and "
            f"in run order, and the unread run has none")

    def test_a_dispatched_run_that_printed_no_envelope_leaves_the_other_runs_rows_alone(self):
        for label, stdout in STDOUT_WITHOUT_AN_ENVELOPE.items():
            with self.subTest(stdout=label):
                code, envelope = self.gate(WITH_FILES, stdout,
                                           THREE_FILES_LINES_ONLY)
                self.assertTheOtherRunsRowsStandAlone(
                    envelope, f"a dispatched run that printed {label}")
                self.assertTheUnreadRunIsOnlyARunWithoutCounts(code, envelope)

    def test_a_dispatched_run_whose_envelope_cannot_be_decoded_leaves_the_other_runs_rows_alone(self):
        code, envelope = self.gate(
            WITH_FILES, envelope_cut_inside_its_file_table(), THREE_FILES_LINES_ONLY)
        self.assertTheOtherRunsRowsStandAlone(
            envelope, "a dispatched run whose envelope cannot be decoded")
        self.assertTheUnreadRunIsOnlyARunWithoutCounts(code, envelope)

    def test_a_gate_whose_only_coverage_stood_in_an_undecodable_envelope_has_no_coverage_runs(self):
        # The cut envelope still shows its percents and three file rows: none
        # of it is read into a row.
        code, envelope = self.gate(
            NO_COVERAGE, envelope_cut_inside_its_file_table(), NO_COVERAGE)
        self.assertNotIn(
            "coverageRuns", envelope,
            f"no run's envelope carried a block the gate could read; "
            f"coverageRuns={envelope.get('coverageRuns')!r}")
        self.assertTheUnreadRunIsOnlyARunWithoutCounts(code, envelope)

    def test_a_gate_whose_other_runs_measured_none_and_one_printed_no_envelope_has_no_coverage_runs(self):
        for label, stdout in STDOUT_WITHOUT_AN_ENVELOPE.items():
            with self.subTest(stdout=label):
                code, envelope = self.gate(NO_COVERAGE, stdout, NO_COVERAGE)
                self.assertNotIn(
                    "coverageRuns", envelope,
                    f"a dispatched run that printed {label} has no row; "
                    f"coverageRuns={envelope.get('coverageRuns')!r}")
                self.assertTheUnreadRunIsOnlyARunWithoutCounts(code, envelope)


class TheStagedStdoutIsWhatItIsNamedTest(unittest.TestCase):
    """Proofs of the fixture: what the unread dispatched runs printed."""

    def test_the_stdout_without_an_envelope_holds_no_envelope_line(self):
        self.assertEqual(len(STDOUT_WITHOUT_AN_ENVELOPE), 2)
        for label, stdout in STDOUT_WITHOUT_AN_ENVELOPE.items():
            with self.subTest(stdout=label):
                self.assertEqual(
                    [line for line in stdout.splitlines() if line.startswith("axi:")], [])

    def test_the_cut_envelope_shows_its_coverage_and_cannot_be_decoded(self):
        text = envelope_cut_inside_its_file_table()
        lines = text.splitlines()
        self.assertEqual([line for line in lines if line.startswith("axi:")], ["axi:"])
        self.assertEqual(
            [line.strip() for line in lines if line.strip().startswith("coverage:")],
            ["coverage:"], "the cut envelope holds a coverage block")
        self.assertIn(f"lines: {BLOCK_WITH_FILES['lines']}", text)
        self.assertTrue(lines[-1 - ROWS_BEFORE_THE_CUT].strip().startswith("files[10]"),
                        f"the table says ten rows; its header={lines[-1 - ROWS_BEFORE_THE_CUT]!r}")
        with self.assertRaises(TOON.ToonDecodeError) as refused:
            TOON.decode(text)
        self.assertIn("10", str(refused.exception),
                      "it is refused for the ten rows it says and does not hold")

    def test_the_same_envelope_whole_decodes_to_its_block(self):
        envelope = decoded(run_envelope_text("regression", WITH_FILES))
        self.assertEqual(envelope.get("coverage"), BLOCK_WITH_FILES)


class TheRunsEnvelopesAreWhatARunPrintsTest(unittest.TestCase):
    """Proofs of the fixture: the envelopes the gates above read."""

    def test_each_runs_envelope_states_the_block_of_its_board_answer(self):
        for label, answer, block in (
                ("ten of twelve files", WITH_FILES, BLOCK_WITH_FILES),
                ("three files, no functions axis", THREE_FILES_LINES_ONLY,
                 BLOCK_OF_THREE_FILES),
                ("the percents alone", PERCENTS_ALONE, BLOCK_OF_PERCENTS)):
            with self.subTest(run=label):
                envelope = decoded(run_envelope_text("regression", answer))
                self.assertEqual(envelope.get("coverage"), block)
                self.assertEqual(list(envelope.get("coverage") or {}), list(block))

    def test_a_run_that_measured_none_prints_no_block_and_its_counts(self):
        envelope = decoded(run_envelope_text("regression", NO_COVERAGE))
        self.assertNotIn("coverage", envelope)
        self.assertEqual(envelope.get("run"), {"passed": 5, "failed": 0,
                                               "pending": 0, "total": 5, "files": 2})

    def test_the_two_blocks_with_files_name_different_runs(self):
        self.assertNotEqual(BLOCK_WITH_FILES["event"], BLOCK_OF_THREE_FILES["event"])
        self.assertEqual((BLOCK_WITH_FILES["fileCount"], BLOCK_WITH_FILES["moreFiles"],
                          len(BLOCK_WITH_FILES["files"])), (12, 2, 10))
        self.assertEqual((BLOCK_OF_THREE_FILES["fileCount"],
                          BLOCK_OF_THREE_FILES["moreFiles"],
                          len(BLOCK_OF_THREE_FILES["files"])), (3, 0, 3))


if __name__ == "__main__":
    unittest.main()
