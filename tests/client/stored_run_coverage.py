"""A stored run that kept its coverage file by file, as a board answers it to
the `run` verb, and the fixture every client's `run` is driven from.

A board that keeps a run's coverage file by file answers three reads of one
event:

  * `?depth=suites`: the event with its per-suite tree, its stored `coverage`
    (the whole run's `lines` and `functions`, each `{total, covered,
    percent}`), and `coverageFileCount` when the run has files;
  * the plain read: the event with its whole tree, the leaves included;
  * `?depth=coverage[&files=<n>]`: the event without its tree and its raw
    output, with `coverageFileCount`, `coverageFiles` (every file in the kept
    order, or the first `n`) and `coverageRoot`. `files` is ASCII digits with
    a value of at least 1; anything else is answered 400.

`StoredCoverageBoard` scripts those three for `EVENT_WITH_FILES`, a test run
of twelve files, on top of the read routes `ScriptedBoard` already scripts
(a test run without files, compile runs, a gate and a milestone). The twelve
files are the ten of `kept_coverage_answer.LEAST_COVERED` and two more, in the
board's order.

`StoredCoverageCase` is the fixture: one scratch project per test, declared at
a board nothing listens on, with the client's request seam answered by the
scripted board. It binds to any client that has the `run` verb, the go client
included.

Not a test module: it holds no `TestCase`.
"""
# The fixture is a mixin: its assert methods are the `TestCase`'s it is bound to.
# pyright: reportAttributeAccessIssue=false

import copy
import os
import shutil
import tempfile
import urllib.parse
from unittest import mock

from tests.client.kept_coverage_answer import (
    KEPT_COVERAGE,
    LEAST_COVERED,
    answered_files,
    listed_rows,
)
from tests.client.live_run_harness import load_toon
from tests.client.test_client_fleet_envelope_census import (
    declare_board,
    install_project_limits,
)
from tests.client.test_runs_and_run_read_a_projects_stored_runs_back import (
    ENV_KEYS,
    EVENT_PATH_PREFIX,
    FULL_TEST_EVENT,
    PROJECT_KEY,
    SUITES_TEST_EVENT,
    UNREACHABLE_BOARD,
    ScriptedBoard,
    _load_module,
    _run_main,
)
from tests.client import TEST_INSTALL_CLIENTS

CLIENTS_DIR = TEST_INSTALL_CLIENTS

#: Every client that has the `run` verb.
RUN_VERB_CLIENTS = {stack: CLIENTS_DIR / f"{stack}-crucible.py"
                    for stack in ("python", "bun", "rust", "mvn", "arduino", "go")}

#: The stored test run that kept twelve coverage files.
EVENT_WITH_FILES = "evt-t-kept-files"
#: Stored runs `ScriptedBoard` already holds: a test run with a stored
#: coverage and no files, and a compile run.
EVENT_WITHOUT_FILES = "evt-t-new"
COMPILE_EVENT = "evt-c-7"

#: The two files the board holds beyond the ten least covered, in its order.
BEYOND_THE_TEN = (
    ("src/ready/almost there.ts", 19, 20, 95, 5, 6, 83.333),
    ("lib/fully_covered.py", 14, 14, 100, None, None, None),
)
#: The run's twelve files, in the board's order.
TWELVE_FILES = LEAST_COVERED + BEYOND_THE_TEN
FILE_COUNT = len(TWELVE_FILES)
COVERAGE_ROOT = "/work/project"

#: The block's keys, in order, for a run with a functions axis and files.
BLOCK_KEYS = ["lines", "functions", "event", "fileCount", "moreFiles", "files"]

SUITES_EVENT_WITH_FILES = {
    **SUITES_TEST_EVENT, "id": EVENT_WITH_FILES,
    "coverage": copy.deepcopy(KEPT_COVERAGE), "coverageFileCount": FILE_COUNT,
}
FULL_EVENT_WITH_FILES = {
    **FULL_TEST_EVENT, "id": EVENT_WITH_FILES,
    "coverage": copy.deepcopy(KEPT_COVERAGE),
}

#: What the request seam hands back for a board that could not be reached.
TRANSPORT_FAILURE = {"ok": False,
                     "error": "<urlopen error [Errno 111] Connection refused>"}
#: What it hands back for a board that answered an error.
HTTP_FAILURE = {"ok": False, "error": "HTTP 500: coverage read failed"}


def event_path(event_id):
    return f"{EVENT_PATH_PREFIX}{event_id}"


def stated_block(rows, event=EVENT_WITH_FILES, coverage=KEPT_COVERAGE,
                 file_count=FILE_COUNT, figures=TWELVE_FILES):
    """The `coverage` block `run` states for the stored run when the board
    answered the first `rows` of its files, its keys in the block's order."""
    listed = figures[:rows]
    block = {axis: coverage[axis]["percent"] for axis in ("lines", "functions")
             if axis in coverage}
    block.update({"event": event, "fileCount": file_count,
                  "moreFiles": max(file_count - len(listed), 0),
                  "files": listed_rows(listed)})
    return block


def coverage_read_answer(limit=None, *, coverage=KEPT_COVERAGE,
                         file_count=FILE_COUNT, figures=TWELVE_FILES):
    """The board's `?depth=coverage` answer for the stored run: every file,
    or the first `limit`."""
    event = {key: value for key, value in FULL_EVENT_WITH_FILES.items()
             if key not in ("tree", "raw")}
    event.update({"coverage": copy.deepcopy(coverage),
                  "coverageFileCount": file_count,
                  "coverageFiles": answered_files(
                      figures if limit is None else figures[:limit]),
                  "coverageRoot": COVERAGE_ROOT})
    return {"ok": True, "event": event}


def files_limit(text):
    """The board's reading of a `files` value: ASCII digits alone with a value
    of at least 1, else None."""
    if not text or any(char not in "0123456789" for char in text):
        return None
    return int(text) or None


class StoredCoverageBoard(ScriptedBoard):
    """`ScriptedBoard` plus the stored run of twelve files.

    `coverage_answer`, when given, is what every `?depth=coverage` read is
    answered with instead of the run's files (a failure, or a malformed
    answer). `suites_event`, when given, replaces the event the
    `?depth=suites` read of the stored run answers."""

    def __init__(self, *, coverage_answer=None, suites_event=None, **scripted):
        super().__init__(**scripted)
        self.coverage_answer = coverage_answer
        self.suites_event = suites_event

    def request(self, method, path, payload=None, timeout=None):
        split = urllib.parse.urlsplit(path)
        # Blank values are kept, so an empty `files=` is read as the board
        # reads it: a value it refuses.
        query = urllib.parse.parse_qs(split.query, keep_blank_values=True)
        if (method == "GET" and split.path.startswith(EVENT_PATH_PREFIX)
                and query.get("depth") == ["coverage"]):
            self.calls.append((method, path, copy.deepcopy(payload)))
            return self._coverage(
                urllib.parse.unquote(split.path[len(EVENT_PATH_PREFIX):]), query)
        return super().request(method, path, payload, timeout)

    def _one(self, event_id, query):
        if event_id != EVENT_WITH_FILES:
            return super()._one(event_id, query)
        if query.get("depth") == ["suites"]:
            self.suites_served.add(event_id)
            return {"ok": True, "event": copy.deepcopy(
                self.suites_event or SUITES_EVENT_WITH_FILES)}
        return {"ok": True, "event": copy.deepcopy(FULL_EVENT_WITH_FILES)}

    def _coverage(self, event_id, query):
        if self.coverage_answer is not None:
            return copy.deepcopy(self.coverage_answer)
        limit = None
        if "files" in query:
            given = query["files"][0]
            limit = files_limit(given)
            if limit is None:
                return {"ok": False,
                        "error": f'HTTP 400: {{"ok":false,"error":"files must '
                                 f'be a whole number of at least 1 (got '
                                 f'\\"{given}\\")"}}'}
        if event_id != EVENT_WITH_FILES:
            # A run that kept no files has none to answer.
            return {"ok": True, "event": {"id": event_id, "projectKey": PROJECT_KEY,
                                          "kind": "test", "coverageFileCount": 0,
                                          "coverageFiles": []}}
        return coverage_read_answer(limit)

    def coverage_reads(self):
        """Every `?depth=coverage` request sent, as `(path, query)` with the
        query parsed, blank values kept."""
        reads = []
        for path in self.gets():
            split = urllib.parse.urlsplit(path)
            query = urllib.parse.parse_qs(split.query, keep_blank_values=True)
            if query.get("depth") == ["coverage"]:
                reads.append((split.path, query))
        return reads


class StoredCoverageCase:
    """A plain mixin (no `unittest.TestCase`), bound to one client by `CLIENT`:
    a scratch project of the scripted board's project, and the client's real
    `main()` driven with its request seam answered by the board."""

    CLIENT: str = ""
    maxDiff = None

    def setUp(self):
        self.module = _load_module(RUN_VERB_CLIENTS[self.CLIENT],
                                   f"stored_run_coverage_{self.CLIENT}_under_test")
        self.toon = load_toon()
        self.tmpdir = tempfile.mkdtemp(prefix=f"stored-run-coverage-{self.CLIENT}-")
        with open(os.path.join(self.tmpdir, ".env"), "w", encoding="utf-8") as handle:
            handle.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            handle.write(f"CRUCIBLE_PROJECT_NAME={PROJECT_KEY}\n")
        self.config = install_project_limits(self.tmpdir)
        # Nothing listens here: a request that escaped the scripted seam
        # reaches no board at all.
        declare_board(self.config, UNREACHABLE_BOARD)
        self._saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, argv, board=None):
        """`run … --project-dir <fixture>` through the client's real `main()`:
        `(exit code, stdout, stderr, board)`."""
        board = board if board is not None else StoredCoverageBoard()
        full = list(argv) + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_request", board.request):
            code, out, err = _run_main(self.module, full)
        return code, out, err, board

    def envelope(self, out, err=""):
        """The one `axi` envelope on stdout."""
        heads = [line for line in out.splitlines() if line.startswith("axi:")]
        self.assertEqual(
            len(heads), 1,
            f"{self.CLIENT}: stdout carries exactly one `axi:` envelope; "
            f"stdout={out!r} stderr={err[-1500:]!r}")
        decoded = self.toon.decode(out)
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        self.assertIsInstance(
            axi, dict,
            f"{self.CLIENT}: stdout decodes to an `axi` envelope; "
            f"stdout={out!r} stderr={err[-1500:]!r}")
        return axi if isinstance(axi, dict) else {}

    def assertFilesFlagIsKnown(self, argv, err):
        """The verb's parser takes `--files`: argparse did not turn it away."""
        self.assertNotIn(
            "unrecognized arguments", err,
            f"{self.CLIENT}: `{' '.join(argv)}` — the `run` verb takes "
            f"`--files`; stderr={err[-800:]!r}")

    def shown_run(self, argv, board=None):
        """Drive a `run` that must be shown: `(envelope, board)`."""
        code, out, err, board = self.drive(argv, board)
        self.assertFilesFlagIsKnown(argv, err)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `{' '.join(argv)}` shows the stored run; "
            f"stdout={out!r} stderr={err[-1500:]!r}")
        axi = self.envelope(out, err)
        self.assertIs(axi.get("ok"), True, f"{self.CLIENT}: {axi!r}")
        return axi, board

    def stated_coverage(self, argv, board=None):
        """Drive a `run` that must state its coverage block: `(block,
        envelope, board)`."""
        axi, board = self.shown_run(argv, board)
        self.assertIn(
            "coverage", axi,
            f"{self.CLIENT}: `{' '.join(argv)}` states the stored run's "
            f"`coverage` block; envelope keys={list(axi)!r} "
            f"requests={board.gets()!r}")
        return axi["coverage"], axi, board
