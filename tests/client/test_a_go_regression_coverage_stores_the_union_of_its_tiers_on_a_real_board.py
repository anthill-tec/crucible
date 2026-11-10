"""A go `regression --coverage` over a declared tier stores the union of the
untagged and tier coverage on a REAL board.

The real `clients/go-crucible.py`, the real `go` on PATH and a real board
(`bun run src/server.ts` on a free port over a throwaway store,
`tests/client/real_board.py`), against a copy of
`tests/fixtures/go-client/tier-coverage`: package `cov`, whose untagged
`TestUnitCov` covers `Unit` and whose `integration`-tagged `TestIntegCov`
covers `Integ`.

`regression --coverage` runs both invocations into one run and merges their
coverprofiles into ONE `go-coverprofile` text, so the board stores the union:
its `lines` total and covered equal the statements of the two profiles the
real `go` writes for those invocations, each block counted once, covered when
either profile covered it. Profiles sent separately would be summed by the
board, counting every statement twice.

A missing toolchain FAILS every test here, naming what is missing.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_regression_coverage_stores_the_union_of_its_tiers_on_a_real_board
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.client.go_client_harness import (
    GO_CLIENT,
    PYTHON_CLIENT,
    TIMEOUT,
    copy_fixture,
    diagnostics,
    go_toolchain_gap,
    toolchain_env,
)
from tests.client.go_gate_harness import (
    COVERAGE_FIXTURE,
    oracle_profiles,
    profile_blocks,
    statements,
    union_blocks,
)
from tests.client.real_board import RealBoard

AGENT = "go-tier-coverage-e2e"
_MODULE = {}


def setUpModule():
    gap = go_toolchain_gap(need_bun=True)
    if gap:
        _MODULE["gap"] = gap
        return
    _MODULE["board"] = RealBoard(shutil.which("bun"), "go-tier-coverage-e2e")
    _MODULE["scratch"] = tempfile.mkdtemp(prefix="go-tier-coverage-e2e-")


def tearDownModule():
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()
    scratch = _MODULE.pop("scratch", None)
    if scratch:
        shutil.rmtree(scratch, ignore_errors=True)


class ATierCoverageRegressionStoresTheUnionTest(unittest.TestCase):
    maxDiff = 6000
    results: list = []

    @classmethod
    def setUpClass(cls):
        cls.results = []

    def setUp(self):
        if _MODULE.get("gap"):
            self.fail(f"missing toolchain: {_MODULE['gap']}")
        self.board = _MODULE["board"]
        if not type(self).results:
            type(self).results.append(self._drive())
        self.oracle, self.result = type(self).results[0]
        self.where = diagnostics(self.result)

    def _drive(self):
        scratch = _MODULE["scratch"]
        oracle = oracle_profiles(os.path.join(scratch, "oracle"))
        project = copy_fixture(COVERAGE_FIXTURE, os.path.join(scratch, "project"))
        self.board.install(project)
        registered = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT), "register", "--agent", AGENT,
             "--role", "report", "--project-dir", project], cwd=project,
            env=toolchain_env(), capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(registered.returncode, 0, f"register: {diagnostics(registered)}")
        result = subprocess.run(
            [sys.executable, str(GO_CLIENT), "regression", "--coverage", "--agent", AGENT,
             "--project-dir", project], cwd=project, env=toolchain_env(),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)
        return oracle, result

    def stored(self):
        events = self.board.test_events(AGENT)
        self.assertEqual(len(events), 1, f"exactly one run is stored; {self.where}")
        return self.board.event(events[0]["id"]) if events else {}

    def test_the_stored_lines_are_the_union_of_the_untagged_and_integration_profiles(self):
        union = statements(union_blocks(self.oracle))
        untagged = statements(profile_blocks(self.oracle[0]))
        self.assertLess(untagged[1], union[1],
                        f"fixture sanity: the integration run adds covered statements "
                        f"({untagged} vs {union})")
        coverage = self.stored().get("coverage") or {}
        lines = coverage.get("lines") or {}
        self.assertEqual((lines.get("total"), lines.get("covered")), union,
                         f"the stored lines are the union, each statement once; "
                         f"coverage={json.dumps(coverage)} {self.where}")

    def test_the_run_is_green_with_both_tests_passing(self):
        summary = self.stored().get("summary") or {}
        self.assertEqual((summary.get("passed"), summary.get("failed")), (2, 0),
                         f"TestUnitCov and TestIntegCov; summary={summary!r} {self.where}")
        self.assertEqual(self.result.returncode, 0, self.where)


if __name__ == "__main__":
    unittest.main()
