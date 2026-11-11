"""`run <event-id>` lists a stored run's coverage files.

A board that keeps a run's coverage file by file answers how many files the
run has on the `?depth=suites` read (`event.coverageFileCount`), and the files
themselves on the `?depth=coverage` read. The `run` verb reads them:

  * `--files <n>|all`, default `10`. It is accepted as `all`, or as ASCII
    digits alone whose value is at least 1 (`03` is 3). Any other value is
    refused by the verb's own envelope, exit 2, before any request; the error
    names `--files` and the value given.
  * For a test run whose first answer carries an integer
    `event.coverageFileCount`, the verb sends one more request, after the two
    it sends today: `?depth=coverage&files=<n>`, or `?depth=coverage` alone
    for `all`.
  * The envelope states the run's `coverage` block after `failingTests` and
    before `help`: `lines` and `functions` (the percents of the first
    answer's stored coverage), `event` (the id asked for), `fileCount` and
    `files` (the coverage read's), and `moreFiles` (the count less the rows
    listed). The brief under `run` is unchanged.
  * A coverage read that fails (the board not reached, an HTTP error, or an
    answer without both a count and a list of files) refuses the verb, exit 1,
    with no run printed.
  * A run without files, and a compile run, send no coverage request and
    print as they do today, whatever `--files` says.

Every test is bound to each client that has the verb, the go client included,
through `tests/client/stored_run_coverage.py`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_run_lists_a_stored_runs_coverage_files
"""
# pyright: reportAttributeAccessIssue=false

import unittest

from tests.client.kept_coverage_answer import ROW_KEYS
from tests.client.stored_run_coverage import (
    BLOCK_KEYS,
    COMPILE_EVENT,
    EVENT_WITH_FILES,
    EVENT_WITHOUT_FILES,
    FILE_COUNT,
    HTTP_FAILURE,
    RUN_VERB_CLIENTS,
    SUITES_EVENT_WITH_FILES,
    TRANSPORT_FAILURE,
    TWELVE_FILES,
    StoredCoverageBoard,
    StoredCoverageCase,
    coverage_read_answer,
    event_path,
    stated_block,
)

#: Every value the verb refuses.
REFUSED_VALUES = ("0", "00", "-1", "x", "+3", "1_0", " 3 ", "", "ALL", "\u0663")

#: The stored run's brief, as the verb states it today.
BRIEF_OF_THE_RUN_WITH_FILES = {
    "event": EVENT_WITH_FILES, "kind": "test", "tier": "unit", "codec": "junit",
    "stack": "python", "passed": 4, "failed": 1, "pending": 0, "total": 5,
    "cycleId": 7, "release": None, "agent": "agent-green-7",
    "coverageLines": 61.46,
}

#: The two requests the verb sends today for a test run, in order.
def todays_requests(event_id):
    return [f"{event_path(event_id)}?depth=suites", event_path(event_id)]


def _without_event_keys(answer, *keys):
    event = {key: value for key, value in answer["event"].items()
             if key not in keys}
    return {**answer, "event": event}


def _with_event_keys(answer, **replaced):
    return {**answer, "event": {**answer["event"], **replaced}}


#: An `ok` answer that is not the run's files: each lacks a well-formed count,
#: a well-formed list, or both.
ANSWERS_WITHOUT_THE_FILES = {
    "neither key": _without_event_keys(
        coverage_read_answer(10), "coverageFileCount", "coverageFiles"),
    "the count alone": _without_event_keys(
        coverage_read_answer(10), "coverageFiles"),
    "the list alone": _without_event_keys(
        coverage_read_answer(10), "coverageFileCount"),
    "a count that is not an integer": _with_event_keys(
        coverage_read_answer(10), coverageFileCount="12"),
    "files that are not a list": _with_event_keys(
        coverage_read_answer(10), coverageFiles={"path": "src/types.ts"}),
    "no event at all": {"ok": True},
}


class RunListsTheFiles:
    """A stored run of twelve files."""

    def test_run_lists_the_ten_least_covered_of_twelve_files_and_counts_two_more(self):
        block, _axi, _board = self.stated_coverage(["run", EVENT_WITH_FILES])
        self.assertEqual(
            block, stated_block(10),
            f"{self.CLIENT}: by default the block lists the board's first ten "
            f"files, in the board's order, each figure the board's own")
        self.assertEqual(
            (block.get("fileCount"), block.get("moreFiles"),
             len(block.get("files") or [])),
            (12, 2, 10), f"{self.CLIENT}: block={block!r}")

    def test_the_blocks_keys_and_each_rows_keys_stand_in_their_order(self):
        block, _axi, _board = self.stated_coverage(["run", EVENT_WITH_FILES])
        self.assertEqual(list(block), BLOCK_KEYS,
                         f"{self.CLIENT}: the block's keys, in order")
        rows = block.get("files") or []
        self.assertEqual(len(rows), 10, f"{self.CLIENT}: block={block!r}")
        for row in rows:
            self.assertEqual(list(row), list(ROW_KEYS),
                             f"{self.CLIENT}: a row's keys, in order; row={row!r}")

    def test_files_3_lists_three_rows_and_counts_nine_more(self):
        block, _axi, _board = self.stated_coverage(
            ["run", EVENT_WITH_FILES, "--files", "3"])
        self.assertEqual(block, stated_block(3),
                         f"{self.CLIENT}: `--files 3` lists the first three")
        self.assertEqual((block.get("fileCount"), block.get("moreFiles")), (12, 9),
                         f"{self.CLIENT}: block={block!r}")

    def test_files_all_lists_all_twelve_and_counts_none_more(self):
        block, _axi, _board = self.stated_coverage(
            ["run", EVENT_WITH_FILES, "--files", "all"])
        self.assertEqual(block, stated_block(12),
                         f"{self.CLIENT}: `--files all` lists every file")
        self.assertEqual(
            (block.get("fileCount"), block.get("moreFiles"),
             len(block.get("files") or [])),
            (12, 0, 12), f"{self.CLIENT}: block={block!r}")

    def test_a_number_above_the_runs_count_lists_every_file_and_counts_none_more(self):
        block, _axi, board = self.stated_coverage(
            ["run", EVENT_WITH_FILES, "--files", "500"])
        self.assertEqual(block, stated_block(12),
                         f"{self.CLIENT}: the board answers no more than it holds")
        self.assertEqual(
            board.coverage_reads(),
            [(event_path(EVENT_WITH_FILES), {"depth": ["coverage"], "files": ["500"]})],
            f"{self.CLIENT}: the number asked for is the number requested")

    def test_the_block_stands_after_the_failing_tests_and_before_help(self):
        _block, axi, _board = self.stated_coverage(["run", EVENT_WITH_FILES])
        keys = list(axi)
        for key in ("failingTests", "help"):
            self.assertIn(key, keys, f"{self.CLIENT}: envelope keys={keys!r}")
        self.assertEqual(
            keys[keys.index("failingTests"):keys.index("help") + 1],
            ["failingTests", "coverage", "help"],
            f"{self.CLIENT}: `coverage` stands between `failingTests` and "
            f"`help`; envelope keys={keys!r}")

    def test_the_percents_are_the_first_answers_and_the_count_and_files_the_coverage_reads(self):
        # The two answers disagree here, as a board's never do, so each
        # figure's source shows: the percents of the first read's stored
        # coverage, the count and the files of the coverage read.
        other = {"lines": {"total": 900, "covered": 891, "percent": 99},
                 "functions": {"total": 50, "covered": 49, "percent": 98}}
        board = StoredCoverageBoard(coverage_answer=coverage_read_answer(
            4, coverage=other, file_count=13))
        block, _axi, _board = self.stated_coverage(
            ["run", EVENT_WITH_FILES, "--files", "4"], board)
        self.assertEqual(
            block, stated_block(4, file_count=13),
            f"{self.CLIENT}: `lines` 61.46 and `functions` 42.19 are the first "
            f"answer's; `fileCount` 13, four rows and `moreFiles` 9 are the "
            f"coverage read's")

    def test_the_block_names_the_run_that_was_asked_for(self):
        block, _axi, _board = self.stated_coverage(["run", EVENT_WITH_FILES])
        self.assertEqual(block.get("event"), EVENT_WITH_FILES,
                         f"{self.CLIENT}: block={block!r}")


class RunSendsOneMoreRequest:
    """The requests the verb sends for a stored run of twelve files."""

    def assertRequests(self, extra, coverage_query):
        _axi, board = self.shown_run(["run", EVENT_WITH_FILES, *extra])
        gets = board.gets()
        self.assertEqual(
            len(gets), 3,
            f"{self.CLIENT}: one more request after the two the verb sends "
            f"today; sent {gets!r}")
        self.assertEqual(gets[:2], todays_requests(EVENT_WITH_FILES),
                         f"{self.CLIENT}: the first two are today's, in order")
        self.assertEqual(
            board.coverage_reads(),
            [(event_path(EVENT_WITH_FILES), coverage_query)],
            f"{self.CLIENT}: the third reads the run's coverage files; "
            f"sent {gets!r}")
        self.assertIn("depth=coverage", gets[2],
                      f"{self.CLIENT}: the coverage read is the last; sent {gets!r}")
        self.assertEqual({method for method, _path, _body in board.calls}, {"GET"},
                         f"{self.CLIENT}: the verb only reads; sent {board.calls!r}")
        return gets

    def test_the_default_requests_the_first_ten_files_after_todays_two_reads(self):
        self.assertRequests([], {"depth": ["coverage"], "files": ["10"]})

    def test_files_3_requests_the_first_three(self):
        self.assertRequests(["--files", "3"],
                            {"depth": ["coverage"], "files": ["3"]})

    def test_files_all_requests_the_coverage_read_with_no_files_parameter(self):
        gets = self.assertRequests(["--files", "all"], {"depth": ["coverage"]})
        self.assertNotIn("files=", gets[2],
                         f"{self.CLIENT}: `all` names no `files=`; sent {gets!r}")

    def test_files_03_requests_three_and_lists_three_rows(self):
        self.assertRequests(["--files", "03"],
                            {"depth": ["coverage"], "files": ["3"]})
        block, _axi, _board = self.stated_coverage(
            ["run", EVENT_WITH_FILES, "--files", "03"])
        self.assertEqual(block, stated_block(3),
                         f"{self.CLIENT}: `03` is 3")


class RunRefusesABadFilesValue:
    """A `--files` value that is neither `all` nor a whole number of at least
    1 is refused by the verb's own envelope before any request."""

    def assertRefusedBeforeAnyRequest(self, event_id, value):
        argv = ["run", event_id, "--files", value]
        code, out, err, board = self.drive(argv)
        where = f"{self.CLIENT}: `run {event_id} --files {value!r}`"
        self.assertFilesFlagIsKnown(argv, err)
        axi = self.envelope(out, err)
        self.assertIs(axi.get("ok"), False, f"{where} is refused; {axi!r}")
        self.assertEqual(code, 2, f"{where} exits 2; stdout={out!r} "
                                  f"stderr={err[-800:]!r}")
        self.assertEqual(axi.get("verb"), "run",
                         f"{where}: the envelope is the verb's own; {axi!r}")
        error = str(axi.get("error"))
        self.assertIn("--files", error, f"{where}: the error names the flag")
        self.assertIn(value, error, f"{where}: the error names the value given")
        self.assertEqual(board.calls, [],
                         f"{where}: refused before any request; sent {board.calls!r}")
        for key in ("run", "suites", "failingTests", "coverage"):
            self.assertNotIn(key, axi, f"{where}: no run is printed; {axi!r}")

    def test_each_value_that_is_not_all_or_a_whole_number_of_at_least_1_is_refused(self):
        for value in REFUSED_VALUES:
            with self.subTest(value=value):
                self.assertRefusedBeforeAnyRequest(EVENT_WITH_FILES, value)

    def test_a_bad_value_is_refused_for_a_run_that_has_no_files(self):
        for value in ("0", "x"):
            with self.subTest(value=value):
                self.assertRefusedBeforeAnyRequest(EVENT_WITHOUT_FILES, value)

    def test_a_bad_value_is_refused_for_a_compile_run(self):
        for value in ("0", "x"):
            with self.subTest(value=value):
                self.assertRefusedBeforeAnyRequest(COMPILE_EVENT, value)


class RunRefusesWhenTheFilesCannotBeRead:
    """A coverage read that fails refuses the verb: a run is never printed
    with a file list it could not read."""

    def assertRefusedForAnUnreadFileList(self, answer, why):
        board = StoredCoverageBoard(coverage_answer=answer)
        code, out, err, board = self.drive(["run", EVENT_WITH_FILES], board)
        where = f"{self.CLIENT}: {why}"
        self.assertEqual(
            len(board.coverage_reads()), 1,
            f"{where}: the coverage read was sent once; sent {board.gets()!r}")
        axi = self.envelope(out, err)
        self.assertIs(axi.get("ok"), False,
                      f"{where}: the verb is refused; {axi!r}")
        self.assertEqual(code, 1, f"{where}: exit 1; stdout={out!r} "
                                  f"stderr={err[-800:]!r}")
        self.assertIn(
            f"could not read the coverage files of run {EVENT_WITH_FILES}",
            str(axi.get("error")), f"{where}: {axi!r}")
        for key in ("run", "suites", "failingTests", "coverage"):
            self.assertNotIn(key, axi, f"{where}: no run is printed; {axi!r}")
        self.assertNotIn("Traceback", out + err, f"{where}: stderr={err[-800:]!r}")

    def test_a_board_that_cannot_be_reached_for_the_files_refuses_the_verb(self):
        self.assertRefusedForAnUnreadFileList(
            TRANSPORT_FAILURE, "the board was not reached for the files")

    def test_an_http_error_on_the_coverage_read_refuses_the_verb(self):
        self.assertRefusedForAnUnreadFileList(
            HTTP_FAILURE, "the board answered the coverage read with an error")

    def test_an_answer_without_both_the_count_and_the_files_refuses_the_verb(self):
        for label, answer in ANSWERS_WITHOUT_THE_FILES.items():
            with self.subTest(answer=label):
                self.assertRefusedForAnUnreadFileList(
                    answer, f"an `ok` answer with {label}")


class ARunWithoutFilesReadsAsBefore:
    """A run whose first answer carries no file count, and a compile run."""

    def assertNoCoverageRead(self, board, where):
        self.assertEqual(board.coverage_reads(), [],
                         f"{where}: no coverage request; sent {board.gets()!r}")

    def test_a_run_without_files_sends_todays_two_requests_and_states_no_block(self):
        # A guard: this is what the verb does today.
        axi, board = self.shown_run(["run", EVENT_WITHOUT_FILES])
        where = f"{self.CLIENT}: a run without files"
        self.assertEqual(board.gets(), todays_requests(EVENT_WITHOUT_FILES), where)
        self.assertNotIn("coverage", axi, f"{where}: {axi!r}")
        self.assertEqual((axi.get("run") or {}).get("coverageLines"), 87.5,
                         f"{where}: its stored percent stays in the brief")

    def test_files_changes_nothing_for_a_run_without_files(self):
        plain, _board = self.shown_run(["run", EVENT_WITHOUT_FILES])
        for value in ("3", "all"):
            with self.subTest(files=value):
                axi, board = self.shown_run(
                    ["run", EVENT_WITHOUT_FILES, "--files", value])
                where = f"{self.CLIENT}: `--files {value}` on a run without files"
                self.assertEqual(board.gets(), todays_requests(EVENT_WITHOUT_FILES),
                                 where)
                self.assertEqual(axi, plain,
                                 f"{where}: the envelope is the one printed "
                                 f"without the flag")

    def test_files_changes_nothing_for_a_compile_run(self):
        plain, plain_board = self.shown_run(["run", COMPILE_EVENT])
        for value in ("3", "all"):
            with self.subTest(files=value):
                axi, board = self.shown_run(
                    ["run", COMPILE_EVENT, "--files", value])
                where = f"{self.CLIENT}: `--files {value}` on a compile run"
                self.assertNoCoverageRead(board, where)
                self.assertEqual(board.gets(), plain_board.gets(), where)
                self.assertEqual(axi, plain,
                                 f"{where}: the envelope is the one printed "
                                 f"without the flag")

    def test_a_file_count_that_is_not_an_integer_sends_no_coverage_request(self):
        # A guard: only an integer count says the run has files.
        for label, count in (("null", None), ("a string", "12"), ("a boolean", True)):
            with self.subTest(count=label):
                board = StoredCoverageBoard(suites_event={
                    **SUITES_EVENT_WITH_FILES, "coverageFileCount": count})
                axi, board = self.shown_run(["run", EVENT_WITH_FILES], board)
                where = f"{self.CLIENT}: a first answer whose count is {label}"
                self.assertNoCoverageRead(board, where)
                self.assertNotIn("coverage", axi, f"{where}: {axi!r}")


class TheBriefIsUnchanged:
    """What the verb prints today for the stored run stays as it is."""

    def test_the_brief_the_suites_and_the_failing_tests_of_a_run_with_files_are_todays(self):
        # A guard: the block is added beside these, and changes none of them.
        axi, _board = self.shown_run(["run", EVENT_WITH_FILES])
        brief = {key: (None if value == "" else value)
                 for key, value in (axi.get("run") or {}).items()}
        self.assertEqual(brief, BRIEF_OF_THE_RUN_WITH_FILES,
                         f"{self.CLIENT}: the brief, its stored lines percent included")
        self.assertEqual(
            axi.get("failingTests"),
            ["tests.test_orders.OrdersTest > test_refuses_a_negative_quantity"],
            f"{self.CLIENT}: {axi!r}")
        self.assertEqual([row.get("name") for row in axi.get("suites") or []],
                         ["tests.test_orders.OrdersTest", "checkout.feature"],
                         f"{self.CLIENT}: {axi!r}")


class _EveryRunFilesTest(RunListsTheFiles, RunSendsOneMoreRequest,
                         RunRefusesABadFilesValue,
                         RunRefusesWhenTheFilesCannotBeRead,
                         ARunWithoutFilesReadsAsBefore, TheBriefIsUnchanged,
                         StoredCoverageCase):
    """Every mixin above, bound to one client by the classes below."""


class PythonRunFilesTest(_EveryRunFilesTest, unittest.TestCase):
    CLIENT = "python"


class BunRunFilesTest(_EveryRunFilesTest, unittest.TestCase):
    CLIENT = "bun"


class RustRunFilesTest(_EveryRunFilesTest, unittest.TestCase):
    CLIENT = "rust"


class MvnRunFilesTest(_EveryRunFilesTest, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoRunFilesTest(_EveryRunFilesTest, unittest.TestCase):
    CLIENT = "arduino"


class GoRunFilesTest(_EveryRunFilesTest, unittest.TestCase):
    CLIENT = "go"


class TheFixtureBoardAnswersAsABoardDoesTest(unittest.TestCase):
    """Proofs of the scripted board: what the tests above are read against."""

    def read(self, suffix):
        board = StoredCoverageBoard()
        return board.request("GET", f"{event_path(EVENT_WITH_FILES)}{suffix}")

    def test_the_fixture_is_bound_to_every_client_that_has_the_verb(self):
        bound = {case.CLIENT for case in _EveryRunFilesTest.__subclasses__()}
        self.assertEqual(bound, set(RUN_VERB_CLIENTS))
        for path in RUN_VERB_CLIENTS.values():
            self.assertTrue(path.is_file(), f"{path} is a client file")

    def test_the_stored_run_holds_twelve_files_named_once_each(self):
        self.assertEqual(FILE_COUNT, 12)
        self.assertEqual(len({figures[0] for figures in TWELVE_FILES}), 12)

    def test_the_suites_read_carries_the_count_and_the_coverage_read_the_files(self):
        self.assertEqual(self.read("?depth=suites")["event"]["coverageFileCount"], 12)
        for suffix, rows in (("?depth=coverage", 12), ("?depth=coverage&files=10", 10),
                             ("?depth=coverage&files=03", 3),
                             ("?depth=coverage&files=500", 12)):
            with self.subTest(read=suffix):
                event = self.read(suffix)["event"]
                self.assertEqual(event["coverageFileCount"], 12)
                self.assertEqual([kept["path"] for kept in event["coverageFiles"]],
                                 [figures[0] for figures in TWELVE_FILES[:rows]])
                self.assertNotIn("tree", event)

    def test_the_coverage_read_answers_400_to_a_files_value_the_board_refuses(self):
        for value in ("0", "00", "-1", "x", "%2B3", "1_0", ""):
            with self.subTest(files=value):
                answer = self.read(f"?depth=coverage&files={value}")
                self.assertIs(answer["ok"], False)
                self.assertTrue(answer["error"].startswith("HTTP 400"), answer)


if __name__ == "__main__":
    unittest.main()
