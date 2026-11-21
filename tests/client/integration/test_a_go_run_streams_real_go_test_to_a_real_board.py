"""A go run streams REAL `go test -json` to a REAL board, end to end.

The feature this module keeps a live board for is the go test-json run
lifecycle end to end: a run opened with its listed total, fed `go-test`
batches and closed on the board. No fake can prove it, because what is
asserted is the server's own `go-test` decoding (the subtest rule, the
`incomplete` against the listed total) of what a real `go test -json` prints.

The real `clients/go-crucible.py`, the real `go` on PATH (1.24 or later) and a
real board (`bun run src/server.ts` on a free port with a throwaway store,
`tests/client/real_board.py`), against Go modules copied from
`tests/fixtures/go-client`:

  - `module`: passing, failing and skipped tests, subtests nested two deep
    (a parent failing through its subtests, a parent failing on its own after
    a passing subtest, a parent whose subtests all pass), a fuzz test's seed
    corpus, a passing and a failing example, an example with no `// Output:`
    (neither listed nor run), a benchmark, and a package with no test files;
  - `panicking`: a test that panics, so the test listed after it never runs.

What the board stores is compared with what a real `go test -json` of the
same module prints, run by this test: each terminal `pass` / `fail` / `skip`
event carrying a `Test`, less each parent the subtest rule drops, split the
same way into passed, failed and pending.

  - a `test` run on the module is stored decoded by `go-test`, with exactly
    those cases, and its envelope states the run the board filed;
  - a `--run` naming a subtest stores that subtest alone;
  - a `--run` matching nothing is refused before any run opens: the board
    holds no run of the agent's, stored, aborted or open;
  - a listed test that never reports leaves the run `incomplete`, naming the
    listed and reached counts: the run-start total reached the board.

A missing toolchain FAILS every test here, naming what is missing.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_go_run_streams_real_go_test_to_a_real_board
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from tests.client.go_client_harness import (
    CASES_PKG,
    GO_CLIENT,
    MODULE_SPLIT,
    PYTHON_CLIENT,
    TIMEOUT,
    copy_fixture,
    diagnostics,
    envelope,
    expected_cases,
    go_toolchain_gap,
    run_go_json,
    split,
    stored_cases,
    toolchain_env,
)
from tests.client.real_board import RealBoard

_MODULE = {}


def setUpModule():
    gap = go_toolchain_gap(need_bun=True)
    if gap:
        _MODULE["gap"] = gap
        return
    _MODULE["board"] = RealBoard(shutil.which("bun"), "go-client-e2e")
    _MODULE["scratch"] = tempfile.mkdtemp(prefix="go-client-e2e-")


def tearDownModule():
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()
    scratch = _MODULE.pop("scratch", None)
    if scratch:
        shutil.rmtree(scratch, ignore_errors=True)


class _RealGoRun(unittest.TestCase):
    maxDiff = 6000

    def setUp(self):
        if _MODULE.get("gap"):
            self.fail(f"missing toolchain: {_MODULE['gap']}")
        self.board = _MODULE["board"]

    def project(self, fixture, label):
        """A fresh copy of `fixture`, installed on the real board."""
        project = copy_fixture(fixture, os.path.join(_MODULE["scratch"], label))
        self.board.install(project)
        return project

    def register(self, agent, project):
        """Register `agent` through the fleet's python client, so the go run is
        an attributed run."""
        registered = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT), "register", "--agent", agent,
             "--role", "report", "--project-dir", project], cwd=project,
            env=toolchain_env(), capture_output=True, text=True, timeout=60,
            check=False)
        self.assertEqual(registered.returncode, 0,
                         f"register {agent}: {diagnostics(registered)}")

    def drive(self, project, agent, *argv):
        self.register(agent, project)
        return subprocess.run(
            [sys.executable, str(GO_CLIENT), "test", *argv, "--agent", agent,
             "--project-dir", project], cwd=project, env=toolchain_env(),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)

    def stored(self, agent, result):
        """The one run `agent` filed, read back from the board, tree included."""
        events = self.board.test_events(agent)
        self.assertEqual(len(events), 1,
                         f"exactly one run is stored; {diagnostics(result)}")
        return self.board.event(events[0]["id"])


class AGoRunReachesTheBoardTest(_RealGoRun):
    """A `test` run on the whole fixture module."""

    @classmethod
    def setUpClass(cls):
        if _MODULE.get("gap"):
            return
        board = _MODULE["board"]
        cls.agent = "go-e2e-module"
        cls.project_dir = copy_fixture("module", os.path.join(_MODULE["scratch"], "module"))
        board.install(cls.project_dir)
        oracle_dir = copy_fixture("module", os.path.join(_MODULE["scratch"], "module-oracle"))
        cls.oracle = run_go_json(oracle_dir)
        cls.results = []

    def run_once(self) -> subprocess.CompletedProcess:
        """The one client run every test of this class reads."""
        held = type(self).results
        if not held:
            held.append(self.drive(self.project_dir, self.agent))
        return held[0]

    def test_the_stored_cases_equal_the_terminal_events_of_go_test_json_less_dropped_parents(self):
        result = self.run_once()
        event = self.stored(self.agent, result)
        expected = expected_cases(self.oracle)
        self.assertEqual(stored_cases(event), expected,
                         f"the stored cases are go's own terminal events; {diagnostics(result)}")
        self.assertNotIn((CASES_PKG, "TestSubs", "fail"), stored_cases(event),
                         "a parent failing only through its subtests is dropped")
        self.assertIn((CASES_PKG, "TestParentFailsBeyond", "fail"), stored_cases(event),
                      "a parent failing on its own is its own failure")
        self.assertNotIn("ExampleNoOutput", [name for _s, name, _st in stored_cases(event)],
                         "an example with no Output comment is never run")

    def test_passed_failed_and_pending_split_as_go_test_json_splits_them(self):
        result = self.run_once()
        event = self.stored(self.agent, result)
        expected = split(expected_cases(self.oracle))
        self.assertEqual(expected, MODULE_SPLIT,
                         "the fixture module runs as its design states")
        summary = event.get("summary") or {}
        self.assertEqual(
            {k: summary.get(k) for k in ("total", "passed", "failed", "pending")},
            {"total": sum(expected.values()), "passed": expected["pass"],
             "failed": expected["fail"], "pending": expected["pending"]},
            f"the stored summary; {diagnostics(result)}")

    def test_the_run_is_stored_decoded_by_go_test_and_flagged_complete(self):
        result = self.run_once()
        event = self.stored(self.agent, result)
        self.assertEqual(event.get("framework"), "go-test",
                         f"the stored run names its codec; {diagnostics(result)}")
        self.assertNotIn("incomplete", event,
                         f"every listed test reported: {event.get('incomplete')!r}")

    def test_the_envelope_states_the_run_the_board_filed(self):
        result = self.run_once()
        event = self.stored(self.agent, result)
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {diagnostics(result)}")
        axi = axi or {}
        self.assertEqual(axi.get("verb"), "test")
        self.assertIs(axi.get("ok"), True,
                      f"a run that filed is ok, whatever its tests did; {diagnostics(result)}")
        summary = event.get("summary") or {}
        run = axi.get("run") or {}
        self.assertEqual({k: run.get(k) for k in ("passed", "failed", "pending")},
                         {k: summary.get(k) for k in ("passed", "failed", "pending")},
                         f"the envelope's run block; {diagnostics(result)}")
        context = axi.get("context") or {}
        self.assertEqual(context.get("agentId"), self.agent)
        self.assertEqual(context.get("board"), self.board.base)
        self.assertEqual(context.get("projectKey"), self.board.key)
        self.assertEqual(result.returncode, 1,
                         f"a run with failing tests exits 1; {diagnostics(result)}")


class OneSubtestByNameTest(_RealGoRun):

    def test_a_run_regex_naming_a_subtest_stores_that_subtest_alone(self):
        project = self.project("module", "module-subtest")
        agent = "go-e2e-subtest"
        result = self.drive(project, agent, "--run", "TestSubs/ok")
        event = self.stored(agent, result)
        self.assertEqual(stored_cases(event), [(CASES_PKG, "TestSubs/ok", "pass")],
                         f"only the named subtest runs and is stored; {diagnostics(result)}")
        self.assertEqual(result.returncode, 0, diagnostics(result))
        self.assertNotIn("incomplete", event,
                         f"the listed parent reported through its subtest: "
                         f"{event.get('incomplete')!r}")


class ARegexMatchingNothingIsRefusedTest(_RealGoRun):
    """A `--run` regex the list finds no test for, on a real board: refused
    before any run opens, so the board holds no run of the agent's at all —
    none filed, none aborted, none left open."""

    def board_runs_of(self, agent):
        """Every run row the board's store holds for `agent`, open or settled
        (`runs` keeps a row for each run ever started)."""
        store = os.path.join(self.board.tmpdir, "crucible.db")
        conn = sqlite3.connect(f"file:{store}?mode=ro", uri=True)
        try:
            return conn.execute(
                "SELECT run_id, run_state FROM runs WHERE project_key = ? AND agent_id = ?",
                (self.board.key, agent)).fetchall()
        finally:
            conn.close()

    def test_a_regex_matching_nothing_stores_no_run_and_aborts_none(self):
        project = self.project("module", "module-nomatch")
        agent = "go-e2e-nomatch"
        result = self.drive(project, agent, "--run", "TestNoSuchThing")
        where = diagnostics(result)
        self.assertNotEqual(result.returncode, 0, f"the run is refused; {where}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        axi = axi or {}
        self.assertEqual(axi.get("verb"), "test", where)
        self.assertIs(axi.get("ok"), False, where)
        self.assertIn("TestNoSuchThing", str(axi.get("error") or ""),
                      f"the refusal's error names the regex; {where}")
        self.assertEqual(self.board.test_events(agent), [],
                         f"no run is stored, filed or aborted; {where}")
        self.assertEqual(self.board_runs_of(agent), [],
                         f"no run was ever started on the board; {where}")


class AListedTestThatNeverReportsTest(_RealGoRun):

    def test_a_panic_that_stops_the_package_leaves_the_run_incomplete_against_its_listed_total(self):
        project = self.project("panicking", "panicking")
        agent = "go-e2e-panicking"
        result = self.drive(project, agent)
        event = self.stored(agent, result)
        self.assertEqual(
            stored_cases(event),
            [("example.com/gopanic/p", "TestBefore", "pass"),
             ("example.com/gopanic/p", "TestPanics", "fail")],
            f"the two tests that reported; {diagnostics(result)}")
        self.assertIn("the run listed 3 top-level tests, the stream reached 2",
                      event.get("incomplete") or "",
                      f"the run-start total is the list's three names; "
                      f"event={json.dumps(event)[:1500]} {diagnostics(result)}")


if __name__ == "__main__":
    unittest.main()
