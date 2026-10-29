"""CR-CRU-216 §S1/§S2/§S3 — every client reads its project's stored runs back:
`runs --cycle <id>` / `runs --release <label>` lists the test and compile runs,
`run <event-id>` shows one, each kind read honestly.

RED today: no client registers a `runs` or a `run` subcommand (all five
clients' argparse wiring and `clients/_crucible_axi.py` read directly — no
`cmd_runs`, no `cmd_run`, no registrar for either). Every drive below fails
argparse's own subcommand dispatch (`invalid choice: 'runs'`, exit 2, nothing
on stdout), so the envelope assertions fire on the missing verb, never on a
fixture.

Harness: each client's REAL `main()`, driven in process with `sys.argv`
patched, against a SCRIPTED board — the client's own `_request` transport seam
(`_request(method, path, payload=None, timeout=None)`, identical in all five
clients) replaced by `ScriptedBoard.request`, which answers the board's own
wire shapes (`eventBrief`, `handleEventsList`, `handleEventGet` in
`src/v2.ts`) and RECORDS every request it is sent. Patching `_request`, not
`_get`, is what lets AC4/AC6 see a write too: `_post`/`_patch`/`_get` all reach
it. Each fixture project's own `crucible.toml` declares the unreachable board
`http://127.0.0.1:1`, so a request that escaped the seam could never reach a
live board (CR-CRU-214), and the AC4 unreachable-board drive uses that same
declaration with the seam left in place.

── Decisions this file makes, binding for GREEN (the spec leaves the envelope
   field names open; RED's call, stated here rather than guessed at) ─────────

  * `runs` carries its row list under the verb's own name, `runs` (the fleet
    convention: `history` carries `history`, `landings` carries `landings`),
    and `totalCount` beside it (the roadmap verbs' own name for the true
    total, `cmd_wave_sequence`).
  * Each `runs` row carries EXACTLY the fourteen §S1 columns, in §S1's order:
    event, kind, tier, codec, stack, passed, failed, pending, total, errors,
    warnings, agent, cycleId, release.
  * "Empty" is null or "" — never 0 and never an omitted key. A compile row's
    four test counts and a test row's errors/warnings are empty (PRD §4.6).
  * `run` carries the record's brief as ONE nested object under `run` — never
    spread over the envelope's top level, where a compile record's `warnings`
    count would collide with the envelope's own `warnings[]` list. A test
    run adds `suites` (rows name, browser, passed, failed, pending) and
    `failingTests` (`suite > test` strings — the gate milestone's own field
    name for the same `_event_failing_tests` reading). A compile run adds
    `diagnostics` (rows level, file, line, code, message) and `totalCount`.
  * The coverage lines percent is asserted by VALUE among the brief's values
    (87.5), not by a key name the spec does not give.
  * A usage refusal's `error` names both flags, `--cycle` and `--release`.

Invocation:
    python3 -m unittest tests.client.test_runs_and_run_read_a_projects_stored_runs_back
"""
# pyright: reportAttributeAccessIssue=false, reportArgumentType=false, reportOptionalMemberAccess=false

import contextlib
import copy
import importlib.util
import io
import os
import re
import shutil
import sys
import tempfile
import tomllib
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    declare_board,
    install_project_limits,
)
from tests.client.test_cr054_fleet_inventory import CLIENT_FILES

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

PROJECT_KEY = "cr216-runs-read-back"
OTHER_PROJECT_KEY = "cr216-somebody-elses-project"
UNREACHABLE_BOARD = "http://127.0.0.1:1"
EVENTS_LIST_PATH = "/api/v2/events"
EVENT_PATH_PREFIX = "/api/v2/events/"

CYCLE = 7
OTHER_CYCLE = 8
LONG_CYCLE = 11
UNKNOWN_CYCLE = 99
RELEASE = "0.4.0"
UNKNOWN_RELEASE = "9.9.9-never-declared"

#: §S1's columns, in §S1's order.
RUN_COLUMNS = ("event", "kind", "tier", "codec", "stack", "passed", "failed",
               "pending", "total", "errors", "warnings", "agent", "cycleId",
               "release")
TEST_COUNT_COLUMNS = ("passed", "failed", "pending", "total")
COMPILE_COUNT_COLUMNS = ("errors", "warnings")
SUITE_COLUMNS = ("name", "browser", "passed", "failed", "pending")
DIAGNOSTIC_COLUMNS = ("level", "file", "line", "code", "message")

#: The lowered `roadmap_list_rows` the bounded-list tests declare (the
#: shipped declaration's own `min`).
LOWERED_LIST_ROWS = 5

EMPTY = (None, "")


# ── the board's own wire shapes (src/v2.ts `eventBrief`) ────────────────────

def _brief(event_id, kind, *, agent, cycle=None, release=None, tier=None,
           codec=None, stack=None, counts=(0, 0, 0, 0), extra=None):
    """One `eventBrief` row as `handleEventsList` serves it: every count a
    top-level scalar (0 on a compile/gate/milestone record), and each optional
    key ABSENT — never null — when the record carries none."""
    total, passed, failed, pending = counts
    row = {"id": event_id, "projectKey": PROJECT_KEY, "agentId": agent,
           "kind": kind, "timestamp": 1_700_000_000, "total": total,
           "passed": passed, "failed": failed, "pending": pending,
           "duration_ms": 12, "hasCoverage": False}
    for key, value in (("tier", tier), ("codec", codec), ("stack", stack),
                       ("cycleId", cycle), ("release", release)):
        if value is not None:
            row[key] = value
    row.update(extra or {})
    return row


T_NEW = _brief("evt-t-new", "test", agent="agent-green-7", cycle=CYCLE,
               tier="unit", codec="junit", stack="python", counts=(5, 4, 1, 0),
               extra={"hasCoverage": True, "coverageLines": 87.5})
GATE_7 = _brief("evt-gate-7", "gate", agent="orchestrator-7", cycle=CYCLE,
                extra={"gate": {"outcome": "pass", "steps": []}})
C_7 = _brief("evt-c-7", "compile", agent="agent-red-7", cycle=CYCLE,
             stack="rust",
             extra={"errors": 2, "warnings": 1, "diagnostics": [
                 {"file": "src/lib.rs", "line": 3, "col": 5, "code": "E0425",
                  "message": "cannot find value x", "level": "error"},
                 {"file": "src/lib.rs", "line": 9, "code": "E0308",
                  "message": "mismatched types", "level": "error"}]})
MILESTONE_7 = _brief("evt-ms-7", "milestone", agent="orchestrator-7",
                     cycle=CYCLE,
                     extra={"type": "pre-merge-gate", "label": "CR-CRU-216"})
T_OLD = _brief("evt-t-old", "test", agent="agent-red-7", cycle=CYCLE,
               release=RELEASE, tier="unit", codec="junit", stack="python",
               counts=(4, 0, 3, 1))
T_8 = _brief("evt-t-8", "test", agent="agent-green-8", cycle=OTHER_CYCLE,
             tier="integration", codec="junit", stack="bun",
             counts=(2, 2, 0, 0))
T_REL = _brief("evt-t-rel", "test", agent="release-verifier",
               release=RELEASE, tier="regression", codec="junit", stack="bun",
               counts=(10, 10, 0, 0))
GATE_REL = _brief("evt-gate-rel", "gate", agent="orchestrator-rel",
                  release=RELEASE, extra={"gate": {"outcome": "fail"}})
C_REL = _brief("evt-c-rel", "compile", agent="release-verifier",
               release=RELEASE, stack="bun",
               extra={"errors": 0, "warnings": 3, "diagnostics": []})

#: A cycle's list, newest first, exactly as the board serves it: runs
#: interleaved with the cycle's gate and milestone rows.
CYCLE_7_EVENTS = [T_NEW, GATE_7, C_7, MILESTONE_7, T_OLD]
RELEASE_EVENTS = [T_REL, GATE_REL, C_REL, T_OLD]

#: Seven test runs and a milestone in one cycle — more runs than the
#: lowered `roadmap_list_rows`, and a non-run row the true count must not
#: include.
LONG_CYCLE_RUNS = [
    _brief(f"evt-long-{n}", "test", agent=f"agent-long-{n}", cycle=LONG_CYCLE,
           tier="unit", codec="junit", stack="python", counts=(n, n, 0, 0))
    for n in range(7, 0, -1)]
LONG_CYCLE_EVENTS = (LONG_CYCLE_RUNS[:3]
                     + [_brief("evt-long-ms", "milestone", agent="orch",
                               cycle=LONG_CYCLE,
                               extra={"type": "pre-merge-gate"})]
                     + LONG_CYCLE_RUNS[3:])

EXPECTED_CYCLE_7_ROWS = [
    {"event": "evt-t-new", "kind": "test", "tier": "unit", "codec": "junit",
     "stack": "python", "passed": 4, "failed": 1, "pending": 0, "total": 5,
     "errors": None, "warnings": None, "agent": "agent-green-7",
     "cycleId": CYCLE, "release": None},
    {"event": "evt-c-7", "kind": "compile", "tier": None, "codec": None,
     "stack": "rust", "passed": None, "failed": None, "pending": None,
     "total": None, "errors": 2, "warnings": 1, "agent": "agent-red-7",
     "cycleId": CYCLE, "release": None},
    {"event": "evt-t-old", "kind": "test", "tier": "unit", "codec": "junit",
     "stack": "python", "passed": 0, "failed": 3, "pending": 1, "total": 4,
     "errors": None, "warnings": None, "agent": "agent-red-7",
     "cycleId": CYCLE, "release": RELEASE},
]

EXPECTED_RELEASE_ROWS = [
    {"event": "evt-t-rel", "kind": "test", "tier": "regression",
     "codec": "junit", "stack": "bun", "passed": 10, "failed": 0,
     "pending": 0, "total": 10, "errors": None, "warnings": None,
     "agent": "release-verifier", "cycleId": None, "release": RELEASE},
    {"event": "evt-c-rel", "kind": "compile", "tier": None, "codec": None,
     "stack": "bun", "passed": None, "failed": None, "pending": None,
     "total": None, "errors": 0, "warnings": 3, "agent": "release-verifier",
     "cycleId": None, "release": RELEASE},
    EXPECTED_CYCLE_7_ROWS[2],
]


# ── one record (src/v2.ts `handleEventGet`) ─────────────────────────────────

FULL_TEST_EVENT = {
    "id": "evt-t-new", "projectKey": PROJECT_KEY, "agentId": "agent-green-7",
    "kind": "test", "tier": "unit", "codec": "junit", "stack": "python",
    "timestamp": 1_700_000_300, "cycleId": CYCLE,
    "summary": {"total": 5, "passed": 4, "failed": 1, "pending": 0,
                "duration_ms": 40},
    "coverage": {"lines": {"covered": 175, "total": 200, "percent": 87.5}},
    "tree": [
        {"name": "tests.test_orders.OrdersTest", "status": "fail",
         "counts": {"passed": 1, "failed": 1, "pending": 0},
         "children": [
             {"name": "test_totals_an_order", "status": "pass"},
             {"name": "test_refuses_a_negative_quantity", "status": "fail",
              "failure": {"message": "ValueError not raised"}}]},
        {"name": "checkout.feature", "browser": "chromium", "status": "pass",
         "counts": {"passed": 3, "failed": 0, "pending": 0},
         "children": [{"name": "pays by card", "status": "pass"},
                      {"name": "pays by voucher", "status": "pass"},
                      {"name": "abandons the cart", "status": "pass"}]},
    ],
    "raw": "Ran 5 tests\nFAILED (failures=1)\n",
}

SUITES_TEST_EVENT = {
    **{k: v for k, v in FULL_TEST_EVENT.items() if k != "raw"},
    "tree": [
        {"name": "tests.test_orders.OrdersTest", "status": "fail",
         "counts": {"passed": 1, "failed": 1, "pending": 0}},
        {"name": "checkout.feature", "browser": "chromium", "status": "pass",
         "counts": {"passed": 3, "failed": 0, "pending": 0}},
    ],
    "rawBytes": 34,
}

EXPECTED_TEST_BRIEF = {
    "kind": "test", "tier": "unit", "codec": "junit", "stack": "python",
    "passed": 4, "failed": 1, "pending": 0, "total": 5, "cycleId": CYCLE,
    "release": None, "agent": "agent-green-7",
}
EXPECTED_SUITE_ROWS = [
    {"name": "tests.test_orders.OrdersTest", "browser": None, "passed": 1,
     "failed": 1, "pending": 0},
    {"name": "checkout.feature", "browser": "chromium", "passed": 3,
     "failed": 0, "pending": 0},
]
EXPECTED_FAILING_TESTS = [
    "tests.test_orders.OrdersTest > test_refuses_a_negative_quantity"]

FULL_COMPILE_EVENT = {
    "id": "evt-c-7", "projectKey": PROJECT_KEY, "agentId": "agent-red-7",
    "kind": "compile", "stack": "rust", "timestamp": 1_700_000_200,
    "cycleId": CYCLE,
    "summary": {"total": 0, "passed": 0, "failed": 0, "pending": 0,
                "duration_ms": 0},
    "compile": {
        "format": "rustc", "errorCount": 2, "warningCount": 1,
        "diagnostics": [
            {"file": "src/lib.rs", "line": 3, "col": 5, "code": "E0425",
             "message": "cannot find value x", "level": "error"},
            {"file": "src/lib.rs", "line": 9, "code": "E0308",
             "message": "mismatched types", "level": "error"},
            {"message": "unused import", "level": "warning"},
        ],
        "raw": "error[E0425]: cannot find value x\n",
    },
}
EXPECTED_COMPILE_BRIEF = {
    "kind": "compile", "stack": "rust", "errors": 2, "warnings": 1,
    "cycleId": CYCLE, "agent": "agent-red-7",
}
EXPECTED_DIAGNOSTIC_ROWS = [
    {"level": "error", "file": "src/lib.rs", "line": 3, "code": "E0425",
     "message": "cannot find value x"},
    {"level": "error", "file": "src/lib.rs", "line": 9, "code": "E0308",
     "message": "mismatched types"},
    {"level": "warning", "file": None, "line": None, "code": None,
     "message": "unused import"},
]

MANY_DIAGNOSTICS = [
    {"file": f"src/m{n}.rs", "line": n, "code": f"E0{n:03d}",
     "message": f"diagnostic {n}", "level": "error"} for n in range(1, 8)]
FULL_COMPILE_MANY = {
    **{k: v for k, v in FULL_COMPILE_EVENT.items() if k != "compile"},
    "id": "evt-c-many",
    "compile": {"format": "rustc", "errorCount": 7, "warningCount": 0,
                "diagnostics": MANY_DIAGNOSTICS, "raw": ""},
}

FULL_GATE_EVENT = {"id": "evt-gate-7", "projectKey": PROJECT_KEY,
                   "agentId": "orchestrator-7", "kind": "gate",
                   "cycleId": CYCLE, "gate": {"outcome": "pass", "steps": []}}
FULL_MILESTONE_EVENT = {"id": "evt-ms-7", "projectKey": PROJECT_KEY,
                        "agentId": "orchestrator-7", "kind": "milestone",
                        "type": "pre-merge-gate", "label": "CR-CRU-216",
                        "cycleId": CYCLE}
FULL_FOREIGN_EVENT = {**FULL_TEST_EVENT, "id": "evt-foreign",
                      "projectKey": OTHER_PROJECT_KEY}
SUITES_FOREIGN_EVENT = {**SUITES_TEST_EVENT, "id": "evt-foreign",
                        "projectKey": OTHER_PROJECT_KEY}

FULL_EVENTS = {e["id"]: e for e in (FULL_TEST_EVENT, FULL_COMPILE_EVENT,
                                    FULL_COMPILE_MANY, FULL_GATE_EVENT,
                                    FULL_MILESTONE_EVENT, FULL_FOREIGN_EVENT)}
SUITES_EVENTS = {
    "evt-t-new": SUITES_TEST_EVENT,
    "evt-foreign": SUITES_FOREIGN_EVENT,
    # A record with no tree answers `?depth=suites` with the full read,
    # without the raw output (`handleEventGet`).
    "evt-c-7": {**FULL_COMPILE_EVENT},
    "evt-c-many": {**FULL_COMPILE_MANY},
    "evt-gate-7": FULL_GATE_EVENT,
    "evt-ms-7": FULL_MILESTONE_EVENT,
}

MISSING_EVENT = "evt-not-on-this-board"


def _not_found(event_id):
    """What `http_request` hands back for `handleEventGet`'s 404."""
    return {"ok": False,
            "error": f'HTTP 404: {{"ok":false,"error":"event not found: '
                     f'{event_id}"}}'}


class ScriptedBoard:
    """The board's read routes, scripted, and every request recorded.

    `fail_suites` names records whose `?depth=suites` read fails;
    `fail_full_after_suites` names records whose plain read fails once their
    `?depth=suites` read has been served — the failing-tests read failing
    AFTER the suites read succeeded (AC3), whatever reads came before."""

    def __init__(self, *, cycle_lists=None, release_lists=None,
                 list_failure=None, fail_suites=(), fail_full_after_suites=()):
        self.calls = []
        self.cycle_lists = {CYCLE: CYCLE_7_EVENTS,
                            OTHER_CYCLE: [T_8],
                            LONG_CYCLE: LONG_CYCLE_EVENTS}
        self.cycle_lists.update(cycle_lists or {})
        self.release_lists = {RELEASE: RELEASE_EVENTS}
        self.release_lists.update(release_lists or {})
        self.list_failure = list_failure
        self.fail_suites = set(fail_suites)
        self.fail_full_after_suites = set(fail_full_after_suites)
        self.suites_served = set()

    def request(self, method, path, payload=None, timeout=None):
        self.calls.append((method, path, copy.deepcopy(payload)))
        if method != "GET":
            return {"ok": False,
                    "error": f"scripted board: {method} {path} is a write"}
        split = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(split.query)
        if split.path == EVENTS_LIST_PATH:
            return self._list(query)
        if split.path.startswith(EVENT_PATH_PREFIX):
            event_id = urllib.parse.unquote(split.path[len(EVENT_PATH_PREFIX):])
            return self._one(event_id, query)
        return {"ok": False, "error": f"scripted board: no route for {path!r}"}

    def _list(self, query):
        if query.get("project") != [PROJECT_KEY]:
            return {"ok": False,
                    "error": f"scripted board: list read for project "
                             f"{query.get('project')!r}"}
        if self.list_failure is not None:
            return self.list_failure
        if "cycleId" in query:
            cycle = int(query["cycleId"][0])
            return {"ok": True,
                    "events": copy.deepcopy(self.cycle_lists.get(cycle, []))}
        if "release" in query:
            return {"ok": True, "events": copy.deepcopy(
                self.release_lists.get(query["release"][0], []))}
        return {"ok": False,
                "error": "scripted board: a list read with neither cycleId "
                         "nor release is the recent-N feed, not a run list"}

    def _one(self, event_id, query):
        if query.get("depth") == ["suites"]:
            if event_id in self.fail_suites:
                return {"ok": False, "error": "HTTP 500: suites read failed"}
            if event_id not in SUITES_EVENTS:
                return _not_found(event_id)
            self.suites_served.add(event_id)
            return {"ok": True, "event": copy.deepcopy(SUITES_EVENTS[event_id])}
        if (event_id in self.fail_full_after_suites
                and event_id in self.suites_served):
            return {"ok": False, "error": "HTTP 500: full read failed"}
        if event_id not in FULL_EVENTS:
            return _not_found(event_id)
        return {"ok": True, "event": copy.deepcopy(FULL_EVENTS[event_id])}

    def gets(self):
        return [path for method, path, _ in self.calls if method == "GET"]


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched -> (code, out, err)."""
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["client"] + list(argv)), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (
                0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


def lower_roadmap_list_rows(config_path, rows):
    """Declare `value = rows` in `[limits.roadmap_list_rows]` of a project's
    own `crucible.toml` — the operator's edit the shipped file documents —
    and prove it landed by parsing the file back."""
    path = Path(config_path)
    text = path.read_text(encoding="utf-8")
    table = re.search(r"(?ms)^\[limits\.roadmap_list_rows\].*?(?=^\[|\Z)", text)
    assert table is not None, f"no [limits.roadmap_list_rows] in {path}"
    block = table.group(0)
    edited = re.sub(r"(?m)^(max\s*=\s*\d+)\s*$", rf"\g<1>\nvalue = {rows}",
                    block, count=1)
    assert edited != block, "no `max = …` line to declare the value after"
    path.write_text(text[:table.start()] + edited + text[table.end():],
                    encoding="utf-8")
    with open(path, "rb") as handle:
        declared = tomllib.load(handle)["limits"]["roadmap_list_rows"]["value"]
    assert declared == rows, f"the edit did not land in {path}"


def _normalised(rows):
    """Rows with the two spellings of "empty" folded to None, so a test
    compares values rather than which empty a client chose."""
    return [{k: (None if v == "" else v) for k, v in row.items()}
            for row in rows]


class _RunReadTestBase:
    """A plain MIXIN (no `unittest.TestCase`), bound to one client by the
    five concrete classes at the bottom (the
    `test_history_verb_reads_a_projects_release_history.py` idiom)."""

    CLIENT = None

    def setUp(self):
        self.module = _load_module(
            CLIENT_FILES[self.CLIENT], f"cr216_run_read_{self.CLIENT}_under_test")
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix=f"cr216-run-read-{self.CLIENT}-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            fh.write(f"CRUCIBLE_PROJECT_NAME={PROJECT_KEY}\n")
        self.config = install_project_limits(self.tmpdir)
        # Nothing listens here: a request that escaped the scripted seam
        # reaches no board at all, and the AC4 drive relies on exactly that.
        declare_board(self.config, UNREACHABLE_BOARD)
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

    def drive(self, argv, board=None):
        """`<verb> … --project-dir <fixture>` through the client's real
        `main()`, every request answered and recorded by `board`."""
        board = board if board is not None else ScriptedBoard()
        full = list(argv) + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_request", board.request):
            code, out, err = _run_main(self.module, full)
        return code, out, err, board

    def envelope(self, out, err=""):
        """The ONE `axi` envelope on stdout."""
        heads = [line for line in out.splitlines() if line.startswith("axi:")]
        self.assertEqual(
            len(heads), 1,
            f"{self.CLIENT}: stdout must carry exactly one `axi:` envelope; "
            f"stdout={out!r} stderr={err[-1500:]!r}")
        decoded = self.toon.decode(out)
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        self.assertIsInstance(
            axi, dict,
            f"{self.CLIENT}: stdout must TOON-decode to an `axi` envelope; "
            f"stdout={out!r} stderr={err[-1500:]!r}")
        return axi

    def assertEmptyCell(self, row, key, why):
        self.assertIn(key, row, f"{self.CLIENT}: {why} — the column {key!r} "
                                f"is present (the table stays uniform); "
                                f"row={row!r}")
        self.assertIn(row[key], EMPTY,
                      f"{self.CLIENT}: {why} — {key!r} is empty (null or "
                      f"\"\"), never 0 or a value; row={row!r}")

    def ok_runs(self, argv, board=None):
        code, out, err, board = self.drive(["runs"] + list(argv), board)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `runs {' '.join(argv)}` must exist and succeed "
            f"against a reachable board (RED: the verb is not registered "
            f"yet); stdout={out!r} stderr={err[-1500:]!r}")
        axi = self.envelope(out, err)
        self.assertIs(axi.get("ok"), True, f"{self.CLIENT}: {axi!r}")
        rows = axi.get("runs")
        self.assertIsInstance(
            rows, list,
            f"{self.CLIENT}: the envelope carries its rows under `runs`; "
            f"got {axi!r}")
        return axi, rows, board

    def ok_run(self, event_id, extra=(), board=None):
        code, out, err, board = self.drive(["run", event_id] + list(extra),
                                           board)
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: `run {event_id}` must exist and succeed for a "
            f"stored run of this project (RED: the verb is not registered "
            f"yet); stdout={out!r} stderr={err[-1500:]!r}")
        axi = self.envelope(out, err)
        self.assertIs(axi.get("ok"), True, f"{self.CLIENT}: {axi!r}")
        brief = axi.get("run")
        self.assertIsInstance(
            brief, dict,
            f"{self.CLIENT}: the record's brief is one object under `run`; "
            f"got {axi!r}")
        return axi, brief, board

    def refused_run(self, event_id, board=None):
        code, out, err, board = self.drive(["run", event_id], board)
        axi = self.envelope(out, err)
        self.assertIs(
            axi.get("ok"), False,
            f"{self.CLIENT}: `run {event_id}` must be refused; got {axi!r}")
        self.assertEqual(
            code, 1,
            f"{self.CLIENT}: a refused `run` exits 1; stdout={out!r} "
            f"stderr={err[-1500:]!r}")
        self.assertNotIn("Traceback", out + err, f"{self.CLIENT}: {err!r}")
        return axi, board


# ── AC1 — `runs` ────────────────────────────────────────────────────────────

class RunsListsACyclesAndAReleasesRuns:

    def test_runs_for_a_cycle_lists_exactly_its_test_and_compile_runs_in_board_order(self):
        axi, rows, _board = self.ok_runs(["--cycle", str(CYCLE)])
        self.assertEqual(
            [row.get("event") for row in rows],
            ["evt-t-new", "evt-c-7", "evt-t-old"],
            f"{self.CLIENT}: exactly the cycle's test and compile runs, in "
            f"the board's newest-first order, and NO gate or milestone row; "
            f"got {rows!r}")
        self.assertEqual(
            axi.get("totalCount"), 3,
            f"{self.CLIENT}: totalCount is the number of RUNS (the gate and "
            f"the milestone are not runs); got {axi!r}")

    def test_every_runs_row_carries_every_column_in_the_specs_order(self):
        _axi, rows, _board = self.ok_runs(["--cycle", str(CYCLE)])
        self.assertEqual(len(rows), 3, f"{self.CLIENT}: {rows!r}")
        for row in rows:
            self.assertEqual(
                list(row.keys()), list(RUN_COLUMNS),
                f"{self.CLIENT}: every row carries exactly §S1's fourteen "
                f"columns, in order, whatever its kind; got "
                f"{list(row.keys())!r}")

    def test_each_cycle_row_carries_the_boards_values_event_from_id_and_agent_from_agent_id(self):
        _axi, rows, _board = self.ok_runs(["--cycle", str(CYCLE)])
        self.assertEqual(
            _normalised(rows), EXPECTED_CYCLE_7_ROWS,
            f"{self.CLIENT}: each row is the board's own values — `event` "
            f"from `id`, `agent` from `agentId`, a column the board lacks "
            f"empty, never invented; got {rows!r}")

    def test_a_compile_row_carries_errors_and_warnings_and_empty_test_counts(self):
        _axi, rows, _board = self.ok_runs(["--cycle", str(CYCLE)])
        compile_rows = [r for r in rows if r.get("kind") == "compile"]
        self.assertEqual(len(compile_rows), 1, f"{self.CLIENT}: {rows!r}")
        row = compile_rows[0]
        self.assertEqual((row.get("errors"), row.get("warnings")), (2, 1),
                         f"{self.CLIENT}: a compile row's numbers are its "
                         f"errors and warnings; row={row!r}")
        for key in TEST_COUNT_COLUMNS:
            self.assertEmptyCell(
                row, key, "a compile record stores no test counts (its "
                          "brief's 0s are not counts — PRD §4.6)")

    def test_a_test_row_carries_its_counts_and_empty_errors_and_warnings(self):
        _axi, rows, _board = self.ok_runs(["--cycle", str(CYCLE)])
        row = [r for r in rows if r.get("event") == "evt-t-new"][0]
        self.assertEqual(
            tuple(row.get(k) for k in TEST_COUNT_COLUMNS), (4, 1, 0, 5),
            f"{self.CLIENT}: a test row carries its own counts; row={row!r}")
        for key in COMPILE_COUNT_COLUMNS:
            self.assertEmptyCell(row, key,
                                 "a test record has no errors or warnings")

    def test_runs_reads_the_cycle_list_of_the_clients_own_project(self):
        _axi, _rows, board = self.ok_runs(["--cycle", str(CYCLE)])
        gets = board.gets()
        self.assertEqual(
            len(gets), 1,
            f"{self.CLIENT}: `runs` makes exactly one read; got {gets!r}")
        split = urllib.parse.urlsplit(gets[0])
        self.assertEqual(split.path, EVENTS_LIST_PATH, f"{gets!r}")
        self.assertEqual(
            urllib.parse.parse_qs(split.query),
            {"project": [PROJECT_KEY], "cycleId": [str(CYCLE)]},
            f"{self.CLIENT}: the read names the client's project and the "
            f"cycle asked for; got {gets[0]!r}")

    def test_runs_for_a_release_lists_exactly_that_releases_runs(self):
        axi, rows, board = self.ok_runs(["--release", RELEASE])
        self.assertEqual(
            _normalised(rows), EXPECTED_RELEASE_ROWS,
            f"{self.CLIENT}: exactly the release's test and compile runs, "
            f"in the board's order, with the board's values and no gate "
            f"row; got {rows!r}")
        self.assertEqual(axi.get("totalCount"), 3, f"{self.CLIENT}: {axi!r}")
        split = urllib.parse.urlsplit(board.gets()[0])
        self.assertEqual(
            urllib.parse.parse_qs(split.query),
            {"project": [PROJECT_KEY], "release": [RELEASE]},
            f"{self.CLIENT}: the read names the release asked for; got "
            f"{board.gets()!r}")

    def test_an_unknown_cycle_is_an_empty_table_whose_help_names_the_project_key(self):
        axi, rows, _board = self.ok_runs(["--cycle", str(UNKNOWN_CYCLE)])
        self.assertEqual(rows, [], f"{self.CLIENT}: {axi!r}")
        self.assertEqual(axi.get("totalCount"), 0, f"{self.CLIENT}: {axi!r}")
        help_steps = axi.get("help")
        self.assertIsInstance(help_steps, list, f"{self.CLIENT}: {axi!r}")
        self.assertTrue(
            any(PROJECT_KEY in str(step) for step in help_steps),
            f"{self.CLIENT}: an empty answer's help names the project key it "
            f"asked about, so a wrong project is visible; help={help_steps!r}")

    def test_an_unknown_release_is_an_empty_table_whose_help_names_the_project_key(self):
        axi, rows, _board = self.ok_runs(["--release", UNKNOWN_RELEASE])
        self.assertEqual(rows, [], f"{self.CLIENT}: {axi!r}")
        self.assertTrue(
            any(PROJECT_KEY in str(step) for step in axi.get("help") or []),
            f"{self.CLIENT}: help names the project key; got {axi!r}")

    def test_a_failed_list_read_is_refused_with_exit_1(self):
        board = ScriptedBoard(list_failure={"ok": False,
                                            "error": "HTTP 500: store locked"})
        code, out, err, _board = self.drive(["runs", "--cycle", str(CYCLE)],
                                            board)
        axi = self.envelope(out, err)
        self.assertIs(axi.get("ok"), False, f"{self.CLIENT}: {axi!r}")
        self.assertEqual(code, 1, f"{self.CLIENT}: stdout={out!r}")
        self.assertIsNone(
            axi.get("runs"),
            f"{self.CLIENT}: a failed read is no table, never an empty one "
            f"standing in for 'no runs'; got {axi!r}")


# ── AC2 — the list is bounded ───────────────────────────────────────────────

class RunsListIsBounded:

    def lower_the_limit(self):
        lower_roadmap_list_rows(self.config, LOWERED_LIST_ROWS)

    def test_past_the_limit_the_table_is_cut_and_total_count_is_the_true_number_of_runs(self):
        self.lower_the_limit()
        axi, rows, _board = self.ok_runs(["--cycle", str(LONG_CYCLE)])
        self.assertEqual(
            [r.get("event") for r in rows],
            [r["id"] for r in LONG_CYCLE_RUNS[:LOWERED_LIST_ROWS]],
            f"{self.CLIENT}: the table is cut at the project's "
            f"roadmap_list_rows ({LOWERED_LIST_ROWS}), keeping the newest; "
            f"got {rows!r}")
        self.assertEqual(
            axi.get("totalCount"), len(LONG_CYCLE_RUNS),
            f"{self.CLIENT}: totalCount is the TRUE number of runs (7 — the "
            f"milestone is not one); got {axi!r}")

    def test_full_prints_every_run(self):
        self.lower_the_limit()
        axi, rows, _board = self.ok_runs(["--cycle", str(LONG_CYCLE), "--full"])
        self.assertEqual(
            [r.get("event") for r in rows], [r["id"] for r in LONG_CYCLE_RUNS],
            f"{self.CLIENT}: --full prints every run; got {rows!r}")
        self.assertEqual(axi.get("totalCount"), len(LONG_CYCLE_RUNS))

    def test_fields_narrows_every_row_to_the_named_columns(self):
        axi, rows, _board = self.ok_runs(["--cycle", str(CYCLE),
                                          "--fields", "event,failed"])
        self.assertEqual(
            _normalised(rows),
            [{"event": "evt-t-new", "failed": 1},
             {"event": "evt-c-7", "failed": None},
             {"event": "evt-t-old", "failed": 3}],
            f"{self.CLIENT}: --fields narrows each row to exactly the named "
            f"columns; got {rows!r}")
        self.assertEqual(axi.get("totalCount"), 3, f"{self.CLIENT}: {axi!r}")


# ── AC3 — `run` ─────────────────────────────────────────────────────────────

class RunShowsOneStoredRun:

    def test_a_failing_test_run_prints_its_brief(self):
        _axi, brief, _board = self.ok_run("evt-t-new")
        for key, value in EXPECTED_TEST_BRIEF.items():
            self.assertIn(key, brief, f"{self.CLIENT}: the brief carries "
                                      f"{key!r}; brief={brief!r}")
            self.assertEqual(
                None if brief[key] == "" else brief[key], value,
                f"{self.CLIENT}: the brief's {key!r} is the stored value; "
                f"brief={brief!r}")
        self.assertIn(
            87.5, list(brief.values()),
            f"{self.CLIENT}: a run that stored coverage shows its lines "
            f"percent (87.5); brief={brief!r}")

    def test_a_failing_test_run_prints_its_per_suite_counts_with_browser(self):
        axi, _brief, board = self.ok_run("evt-t-new")
        suites = axi.get("suites")
        self.assertIsInstance(suites, list, f"{self.CLIENT}: {axi!r}")
        for row in suites:
            self.assertEqual(list(row.keys()), list(SUITE_COLUMNS),
                             f"{self.CLIENT}: suite rows are exactly "
                             f"{SUITE_COLUMNS}; got {row!r}")
        self.assertEqual(
            _normalised(suites), EXPECTED_SUITE_ROWS,
            f"{self.CLIENT}: the per-suite counts are the stored ones from "
            f"?depth=suites, `browser` included; got {suites!r}")
        self.assertIn(
            f"{EVENT_PATH_PREFIX}evt-t-new?depth=suites", board.gets(),
            f"{self.CLIENT}: the per-suite counts come from the board's "
            f"?depth=suites read; reads={board.gets()!r}")

    def test_a_failing_test_run_names_its_failing_tests_suite_then_test(self):
        axi, _brief, _board = self.ok_run("evt-t-new")
        self.assertEqual(
            axi.get("failingTests"), EXPECTED_FAILING_TESTS,
            f"{self.CLIENT}: the failing tests, named `suite > test`, read "
            f"from the stored record — and only the failing ones; got "
            f"{axi!r}")

    def test_a_failing_compile_run_prints_its_brief_with_errors_and_warnings(self):
        _axi, brief, _board = self.ok_run("evt-c-7")
        for key, value in EXPECTED_COMPILE_BRIEF.items():
            self.assertEqual(
                brief.get(key), value,
                f"{self.CLIENT}: the compile brief's {key!r} is the stored "
                f"value; brief={brief!r}")
        for key in TEST_COUNT_COLUMNS:
            self.assertIn(
                brief.get(key), EMPTY,
                f"{self.CLIENT}: a compile run never reads as test counts "
                f"(PRD §4.6) — {key!r} is empty or absent; brief={brief!r}")

    def test_a_failing_compile_run_prints_its_diagnostics_table(self):
        axi, _brief, _board = self.ok_run("evt-c-7")
        diagnostics = axi.get("diagnostics")
        self.assertIsInstance(diagnostics, list, f"{self.CLIENT}: {axi!r}")
        for row in diagnostics:
            self.assertEqual(list(row.keys()), list(DIAGNOSTIC_COLUMNS),
                             f"{self.CLIENT}: diagnostic rows are exactly "
                             f"{DIAGNOSTIC_COLUMNS}; got {row!r}")
        self.assertEqual(
            _normalised(diagnostics), EXPECTED_DIAGNOSTIC_ROWS,
            f"{self.CLIENT}: every stored diagnostic, in order, a missing "
            f"file/line/code empty; got {diagnostics!r}")
        self.assertEqual(axi.get("totalCount"), 3, f"{self.CLIENT}: {axi!r}")

    def test_a_compile_runs_diagnostics_are_cut_and_counted_as_the_list_is(self):
        lower_roadmap_list_rows(self.config, LOWERED_LIST_ROWS)
        axi, _brief, _board = self.ok_run("evt-c-many")
        self.assertEqual(
            [d.get("code") for d in axi.get("diagnostics") or []],
            [d["code"] for d in MANY_DIAGNOSTICS[:LOWERED_LIST_ROWS]],
            f"{self.CLIENT}: diagnostics are cut at roadmap_list_rows; got "
            f"{axi!r}")
        self.assertEqual(axi.get("totalCount"), len(MANY_DIAGNOSTICS),
                         f"{self.CLIENT}: totalCount is the true count; "
                         f"got {axi!r}")
        full, _brief, _board = self.ok_run("evt-c-many", extra=["--full"])
        self.assertEqual(len(full.get("diagnostics") or []),
                         len(MANY_DIAGNOSTICS),
                         f"{self.CLIENT}: --full prints every diagnostic; "
                         f"got {full!r}")

    def test_an_id_the_board_does_not_hold_is_refused_naming_it(self):
        axi, _board = self.refused_run(MISSING_EVENT)
        self.assertIn(MISSING_EVENT, str(axi.get("error")),
                      f"{self.CLIENT}: the refusal names the id; {axi!r}")
        self.assertIsNone(axi.get("run"), f"{self.CLIENT}: {axi!r}")

    def test_a_gate_id_is_refused_naming_its_kind(self):
        axi, _board = self.refused_run("evt-gate-7")
        self.assertIn("gate", str(axi.get("error")),
                      f"{self.CLIENT}: a gate record is not a run, and the "
                      f"refusal names its kind; {axi!r}")
        self.assertIsNone(axi.get("run"), f"{self.CLIENT}: {axi!r}")

    def test_a_milestone_id_is_refused_naming_its_kind(self):
        axi, _board = self.refused_run("evt-ms-7")
        self.assertIn("milestone", str(axi.get("error")),
                      f"{self.CLIENT}: a milestone is not a run, and the "
                      f"refusal names its kind; {axi!r}")
        self.assertIsNone(axi.get("run"), f"{self.CLIENT}: {axi!r}")

    def test_another_projects_run_is_refused_naming_both_keys(self):
        axi, _board = self.refused_run("evt-foreign")
        error = str(axi.get("error"))
        self.assertIn(OTHER_PROJECT_KEY, error,
                      f"{self.CLIENT}: names the record's project; {axi!r}")
        self.assertIn(PROJECT_KEY, error.replace(OTHER_PROJECT_KEY, ""),
                      f"{self.CLIENT}: and the client's own; {axi!r}")
        self.assertIsNone(axi.get("run"),
                          f"{self.CLIENT}: another project's run is never "
                          f"printed; {axi!r}")
        self.assertIsNone(axi.get("failingTests"), f"{self.CLIENT}: {axi!r}")

    def test_a_failing_tests_read_that_fails_after_the_suites_read_is_refused(self):
        board = ScriptedBoard(fail_full_after_suites={"evt-t-new"})
        axi, board = self.refused_run("evt-t-new", board)
        self.assertIn(
            "evt-t-new", board.suites_served,
            f"{self.CLIENT}: the suites read was served before the failure; "
            f"reads={board.gets()!r}")
        self.assertIsNone(
            axi.get("failingTests"),
            f"{self.CLIENT}: never a run printed with an empty failing list "
            f"when its failing tests could not be read; got {axi!r}")

    def test_a_suites_read_that_fails_is_refused(self):
        board = ScriptedBoard(fail_suites={"evt-t-new"})
        axi, _board = self.refused_run("evt-t-new", board)
        self.assertIsNone(
            axi.get("suites"),
            f"{self.CLIENT}: no suites table stands in for a failed read; "
            f"got {axi!r}")


# ── AC4 — usage, and the board's absence ────────────────────────────────────

class RunReadUsageAndAnAbsentBoard:

    USAGE_CASES = {
        "neither flag": [],
        "both flags": ["--cycle", str(CYCLE), "--release", RELEASE],
        "a non-integer cycle": ["--cycle", "abc"],
    }

    def test_a_runs_usage_error_is_an_enveloped_refusal_exit_2_with_no_request(self):
        for label, argv in self.USAGE_CASES.items():
            with self.subTest(case=label):
                code, out, err, board = self.drive(["runs"] + argv)
                axi = self.envelope(out, err)
                self.assertIs(axi.get("ok"), False,
                              f"{self.CLIENT} {label}: {axi!r}")
                error = str(axi.get("error"))
                self.assertIn("--cycle", error,
                              f"{self.CLIENT} {label}: the refusal names "
                              f"--cycle; {axi!r}")
                self.assertIn("--release", error,
                              f"{self.CLIENT} {label}: the refusal names "
                              f"--release; {axi!r}")
                self.assertEqual(
                    code, 2,
                    f"{self.CLIENT} {label}: a usage refusal exits 2 from the "
                    f"verb itself (the next/cr-depends precedent); "
                    f"stdout={out!r} stderr={err[-800:]!r}")
                self.assertEqual(
                    board.calls, [],
                    f"{self.CLIENT} {label}: refused before any request; "
                    f"sent {board.calls!r}")

    def drive_unreachable(self, argv):
        """The seam left in place: the fixture's `crucible.toml` declares
        `http://127.0.0.1:1`, where nothing listens."""
        return _run_main(self.module, list(argv) + ["--project-dir", self.tmpdir])

    def assertBoardAbsentRefusal(self, argv):
        code, out, err = self.drive_unreachable(argv)
        self.assertNotIn("Traceback", out + err,
                         f"{self.CLIENT} {argv}: no traceback; "
                         f"stderr={err[-1500:]!r}")
        axi = self.envelope(out, err)
        self.assertIs(axi.get("ok"), False, f"{self.CLIENT} {argv}: {axi!r}")
        self.assertIn(UNREACHABLE_BOARD, str(axi.get("error")),
                      f"{self.CLIENT} {argv}: the refusal names the board it "
                      f"could not reach; {axi!r}")
        self.assertEqual(code, 1, f"{self.CLIENT} {argv}: stdout={out!r}")

    def test_runs_against_an_unreachable_board_is_one_refusal_naming_it(self):
        self.assertBoardAbsentRefusal(["runs", "--cycle", "1"])

    def test_run_against_an_unreachable_board_is_one_refusal_naming_it(self):
        self.assertBoardAbsentRefusal(["run", "evt-t-new"])


# ── AC6 — read only ─────────────────────────────────────────────────────────

class RunReadSendsOnlyGets:

    def test_neither_verb_sends_anything_but_get_requests(self):
        board = ScriptedBoard()
        for argv in (["runs", "--cycle", str(CYCLE)],
                     ["runs", "--release", RELEASE],
                     ["run", "evt-t-new"],
                     ["run", "evt-c-7"]):
            code, out, err, board = self.drive(argv, board)
            self.assertEqual(code, 0, f"{self.CLIENT} {argv}: stdout={out!r} "
                                      f"stderr={err[-800:]!r}")
        methods = [method for method, _path, _payload in board.calls]
        self.assertGreaterEqual(
            len(methods), 4,
            f"{self.CLIENT}: the four drives reached the board; {board.calls!r}")
        self.assertEqual(
            set(methods), {"GET"},
            f"{self.CLIENT}: `runs` and `run` are read-only; sent "
            f"{board.calls!r}")
        self.assertTrue(all(payload is None for _m, _p, payload in board.calls),
                        f"{self.CLIENT}: no request carries a body; "
                        f"{board.calls!r}")


class _AllRunReadTests(RunsListsACyclesAndAReleasesRuns, RunsListIsBounded,
                       RunShowsOneStoredRun, RunReadUsageAndAnAbsentBoard,
                       RunReadSendsOnlyGets, _RunReadTestBase):
    """Every mixin above, bound to one client by the five subclasses below —
    AC5's "every client", proven behaviourally."""


class PythonRunReadTest(_AllRunReadTests, unittest.TestCase):
    CLIENT = "python"


class BunRunReadTest(_AllRunReadTests, unittest.TestCase):
    CLIENT = "bun"


class RustRunReadTest(_AllRunReadTests, unittest.TestCase):
    CLIENT = "rust"


class MvnRunReadTest(_AllRunReadTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoRunReadTest(_AllRunReadTests, unittest.TestCase):
    CLIENT = "arduino"


# ── AC5 — one implementation: the five envelopes are the same ──────────────

class EveryClientPrintsTheSameRunReadEnvelopeTest(unittest.TestCase):
    """AC5 — `runs --cycle 1` and `run <id>`, driven through all five
    clients against the same scripted board, print the same envelope: one
    implementation, so nothing but the envelope's `context` may differ."""

    def drive_every_client(self, argv, board_factory):
        envelopes = {}
        for client in CLIENT_FILES:
            case = _EnvelopeProbe(client)
            case.setUp()
            try:
                code, out, err, _board = case.drive(argv, board_factory())
                envelopes[client] = (code, case.envelope(out, err))
            finally:
                case.tearDown()
        return envelopes

    def assertSameEnvelope(self, argv, board_factory):
        envelopes = self.drive_every_client(argv, board_factory)
        reference_code, reference = envelopes["python"]
        self.assertEqual(reference_code, 0,
                         f"python {argv}: {reference!r} (RED: no such verb)")
        reference = {k: v for k, v in reference.items() if k != "context"}
        for client, (code, axi) in envelopes.items():
            with self.subTest(client=client):
                self.assertEqual(code, reference_code, f"{client} {argv}")
                self.assertEqual(
                    {k: v for k, v in axi.items() if k != "context"},
                    reference,
                    f"{client} {argv}: the envelope differs from python's — "
                    f"the verb is implemented more than once")

    def test_runs_for_cycle_1_prints_the_same_envelope_from_every_client(self):
        self.assertSameEnvelope(
            ["runs", "--cycle", "1"],
            lambda: ScriptedBoard(cycle_lists={1: CYCLE_7_EVENTS}))

    def test_run_prints_the_same_envelope_from_every_client(self):
        self.assertSameEnvelope(["run", "evt-t-new"], ScriptedBoard)


class _EnvelopeProbe(_RunReadTestBase, unittest.TestCase):
    """A one-client fixture the parity test drives by hand; it defines no
    test of its own, so discovery collects nothing from it."""

    def __init__(self, client):
        super().__init__()
        self.CLIENT = client


if __name__ == "__main__":
    unittest.main()
