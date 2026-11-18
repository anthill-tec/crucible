"""The clients' `runs` and `run` read a lint record back as a lint: it stays
`kind: "compile"`, carries `lint` with its tool, and `run`'s line names `lint`
and the tool, never `compile`. A compile record reads exactly as before.

Harness: each client's real `main()`, driven in process with `sys.argv`
patched, against a scripted board -- the client's own `_request` transport
seam replaced by `ScriptedLintBoard.request`, which answers the board's own
wire shapes for a lint record (`eventBrief` and the detail event carry `lint`
beside `kind: "compile"`). Each fixture project's `crucible.toml` declares a
board nothing listens on, so a request that escaped the seam reaches nothing.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.test_runs_and_run_word_a_lint_record_as_lint
"""

import contextlib
import copy
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from tests.client.project_create_harness import decode_envelope
from tests.client.client_fleet_envelope_census_helpers import (
    declare_board,
    install_project_limits,
)
from tests.client import TEST_INSTALL_CLIENTS

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = TEST_INSTALL_CLIENTS
CLIENT_FILES = {client: CLIENTS_DIR / f"{client}-crucible.py"
                for client in ("python", "bun", "rust", "mvn", "arduino", "go")}

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

PROJECT_KEY = "lint-record-read-back"
UNREACHABLE_BOARD = "http://127.0.0.1:1"
CYCLE = 7
# Neither id holds the word `lint` or `compile`, so the wording read off a
# line is the verb's, never the id's.
LINT_EVENT = "evt-7001"
COMPILE_EVENT = "evt-7002"


def _brief(event_id, *, lint=None, errors, warnings):
    """One `eventBrief` row of a compile-kind record, as `handleEventsList`
    serves it; `lint` is absent on a record no linter filed."""
    row = {"id": event_id, "projectKey": PROJECT_KEY, "agentId": "agent-lint-7",
           "kind": "compile", "timestamp": 1_700_000_000, "total": 0, "passed": 0,
           "failed": 0, "pending": 0, "duration_ms": 12, "hasCoverage": False,
           "cycleId": CYCLE, "stack": "python", "errors": errors,
           "warnings": warnings}
    if lint is not None:
        row["lint"] = lint
    return row


def _event(event_id, *, lint=None, errors, warnings):
    """The detail event of a compile-kind record, as `handleEventGet` serves
    it; `lint` is absent on a record no linter filed."""
    event = {"id": event_id, "projectKey": PROJECT_KEY, "agentId": "agent-lint-7",
             "kind": "compile", "timestamp": 1_700_000_000, "cycleId": CYCLE,
             "stack": "python",
             "compile": {"errorCount": errors, "warningCount": warnings,
                         "diagnostics": [{"level": "error", "file": "app/a.py",
                                          "line": 1, "code": "F401",
                                          "message": "`os` imported but unused"}]}}
    if lint is not None:
        event["lint"] = lint
    return event


EVENTS = {
    LINT_EVENT: _event(LINT_EVENT, lint="ruff", errors=1, warnings=2),
    COMPILE_EVENT: _event(COMPILE_EVENT, errors=2, warnings=1),
}
CYCLE_LIST = [_brief(LINT_EVENT, lint="ruff", errors=1, warnings=2),
              _brief(COMPILE_EVENT, errors=2, warnings=1)]


class ScriptedLintBoard:
    """The board's two read routes, scripted for one lint and one compile
    record."""

    def request(self, method, path, payload=None, timeout=None):
        if method != "GET":
            return {"ok": False, "error": f"scripted board: {method} {path} is a write"}
        split = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(split.query)
        if split.path == "/api/v2/events":
            if query.get("cycleId") == [str(CYCLE)]:
                return {"ok": True, "events": copy.deepcopy(CYCLE_LIST)}
            return {"ok": True, "events": []}
        prefix = "/api/v2/events/"
        if split.path.startswith(prefix):
            event_id = urllib.parse.unquote(split.path[len(prefix):])
            if event_id in EVENTS:
                return {"ok": True, "event": copy.deepcopy(EVENTS[event_id])}
            return {"ok": False, "error": f'HTTP 404: event not found: {event_id}'}
        return {"ok": False, "error": f"scripted board: no route for {path!r}"}


def _load(client):
    spec = importlib.util.spec_from_file_location(
        f"lint_record_read_{client}", CLIENT_FILES[client])
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["client"] + list(argv)), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
            code = 0
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


class RunsAndRunWordALintRecordAsLintTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="lint-record-read-")
        self.addCleanup(shutil.rmtree, self.tmpdir, True)
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            fh.write(f"CRUCIBLE_PROJECT_NAME={PROJECT_KEY}\n")
        declare_board(install_project_limits(self.tmpdir), UNREACHABLE_BOARD)
        saved = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)

        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.addCleanup(restore)

    def drive(self, client, argv):
        module = _load(client)
        board = ScriptedLintBoard()
        with mock.patch.object(module, "_request", board.request):
            code, out, err = _run_main(module, list(argv) + ["--project-dir", self.tmpdir])
        axi = decode_envelope(out) or {}
        self.assertEqual(code, 0, f"{client} {argv}: stdout={out!r} stderr={err[-1500:]!r}")
        return axi, err

    @staticmethod
    def run_line(err):
        lines = [line for line in err.splitlines() if line.startswith("run:")]
        return lines[-1] if lines else ""

    def test_run_of_a_lint_record_keeps_kind_compile_and_carries_lint(self):
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                axi, _err = self.drive(client, ["run", LINT_EVENT])
                brief = axi.get("run") or {}
                self.assertEqual(
                    (brief.get("kind"), brief.get("lint"), brief.get("errors"),
                     brief.get("warnings")),
                    ("compile", "ruff", 1, 2), f"{client}: {axi!r}")

    def test_run_of_a_lint_record_is_worded_lint_and_its_tool_never_compile(self):
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                _axi, err = self.drive(client, ["run", LINT_EVENT])
                line = self.run_line(err)
                self.assertRegex(line, r"\blint\b", f"{client}: {line!r}")
                self.assertRegex(line, r"\bruff\b", f"{client}: {line!r}")
                self.assertNotRegex(line, r"\bcompile\b",
                                    f"{client}: a lint run is never worded "
                                    f"compile; {line!r}")

    def test_run_of_a_compile_record_is_unchanged(self):
        """A guard: a compile record's brief and wording stay as they are."""
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                axi, err = self.drive(client, ["run", COMPILE_EVENT])
                brief = axi.get("run") or {}
                self.assertNotIn("lint", brief, f"{client}: {axi!r}")
                self.assertEqual((brief.get("kind"), brief.get("errors"),
                                  brief.get("warnings")), ("compile", 2, 1),
                                 f"{client}: {axi!r}")
                self.assertIn(f"run: ok=True {COMPILE_EVENT} compile errors=2 warnings=1",
                              err, f"{client}: {err[-800:]!r}")

    def test_runs_lists_a_lint_record_as_compile_carrying_lint_and_a_compile_record_without(self):
        for client in CLIENT_FILES:
            with self.subTest(client=client):
                axi, _err = self.drive(client, ["runs", "--cycle", str(CYCLE)])
                rows = {row.get("event"): row for row in axi.get("runs") or []}
                self.assertEqual(set(rows), {LINT_EVENT, COMPILE_EVENT},
                                 f"{client}: {axi!r}")
                self.assertEqual(
                    (rows[LINT_EVENT].get("kind"), rows[LINT_EVENT].get("lint")),
                    ("compile", "ruff"), f"{client}: {rows[LINT_EVENT]!r}")
                self.assertIn(rows[COMPILE_EVENT].get("lint"), (None, ""),
                              f"{client}: a compile row names no linter; "
                              f"{rows[COMPILE_EVENT]!r}")


if __name__ == "__main__":
    unittest.main()
