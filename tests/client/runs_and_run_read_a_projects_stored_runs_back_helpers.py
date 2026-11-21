"""The helpers of `test_runs_and_run_read_a_projects_stored_runs_back.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import contextlib
import copy
import importlib.util
import io
import sys
import urllib.parse
from unittest import mock


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

RELEASE = "0.4.0"


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
