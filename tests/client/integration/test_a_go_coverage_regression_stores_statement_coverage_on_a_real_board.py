"""A go `regression --coverage` stores statement coverage on a REAL board.

The feature: go coverage merging — the statements of a run's coverprofiles
as the board stores them, a block listed more than once (overlap) or
written by two tier invocations (union) counted once. No fake can prove it:
the merge is the board's own coverage decoding and storage over what the
real `go` wrote, and a scripted board would only hand back the totals the
test gave it.

The real `clients/go-crucible.py`, the real `go` on PATH and a real board
(`bun run src/server.ts` on a free port with a throwaway store,
`tests/client/real_board.py`), shared by both classes (each reads its own
agent's run).

Overlap (`ARegressionCoverageRunStoresStatementCoverageTest`), against a copy
of `tests/fixtures/go-client/coverage-modules`: module `calc` (two packages,
some statements never covered) and module `types` (types and constants
only, its profile a bare `mode:` line).

One `regression --coverage` runs both modules into one run. The coverage the
board stores has no functions axis; its `lines` total and covered equal the
statements of the profiles the run wrote, counted as the board counts them:
each block weighted by its statement count, a block listed more than once
counted once, covered if any copy is.

Union (`ATierCoverageRegressionStoresTheUnionTest`, merged from
`test_a_go_regression_coverage_stores_the_union_of_its_tiers_on_a_real_board`),
against a copy of `tests/fixtures/go-client/tier-coverage`: package `cov`,
whose untagged `TestUnitCov` covers `Unit` and whose `integration`-tagged
`TestIntegCov` covers `Integ`. `regression --coverage` runs both invocations
into one run and merges their coverprofiles into ONE `go-coverprofile` text,
so the board stores the union: its `lines` total and covered equal the
statements of the two profiles the real `go` writes for those invocations,
each block counted once, covered when either profile covered it. Profiles
sent separately would be summed by the board, counting every statement twice.

A missing toolchain FAILS every test here, naming what is missing.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_go_coverage_regression_stores_statement_coverage_on_a_real_board
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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

AGENT = "go-e2e-coverage"
#: The fixture's tests: three in `calc`, one in `types`, all passing.
FIXTURE_TESTS = 4
_MODULE = {}

#: The union class's own agent and module state: the module's board, its own
#: scratch directory.
TIER_AGENT = "go-tier-coverage-e2e"
_TIER = {}


def setUpModule():
    gap = go_toolchain_gap(need_bun=True)
    if gap:
        _MODULE["gap"] = gap
        _TIER["gap"] = gap
        return
    _MODULE["board"] = RealBoard(shutil.which("bun"), "go-coverage-e2e")
    _MODULE["scratch"] = tempfile.mkdtemp(prefix="go-coverage-e2e-")
    _TIER["board"] = _MODULE["board"]
    _TIER["scratch"] = tempfile.mkdtemp(prefix="go-tier-coverage-e2e-")


def tearDownModule():
    _TIER.pop("board", None)
    board = _MODULE.pop("board", None)
    if board is not None:
        board.close()
    for state in (_MODULE, _TIER):
        scratch = state.pop("scratch", None)
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)


def statement_totals(profiles):
    """`(total, covered)` statements over every profile's blocks: each block
    (`file:start,end`) weighted by its statement count and counted once
    however many times it is listed, covered when any copy's count is not
    zero."""
    blocks = {}
    for text in profiles:
        for line in text.splitlines()[1:]:
            if not line.strip():
                continue
            key, statements, count = line.rsplit(" ", 2)
            weight, hit = blocks.get(key, (int(statements), False))
            blocks[key] = (weight, hit or int(count) > 0)
    total = sum(weight for weight, _hit in blocks.values())
    covered = sum(weight for weight, hit in blocks.values() if hit)
    return total, covered


class ARegressionCoverageRunStoresStatementCoverageTest(unittest.TestCase):
    maxDiff = 6000

    @classmethod
    def setUpClass(cls):
        cls.results = []

    def setUp(self):
        if _MODULE.get("gap"):
            self.fail(f"missing toolchain: {_MODULE['gap']}")
        self.board = _MODULE["board"]
        if not type(self).results:
            type(self).results.append(self._drive())
        self.project, self.result = type(self).results[0]
        self.where = diagnostics(self.result)

    def _drive(self):
        project = copy_fixture("coverage-modules", os.path.join(_MODULE["scratch"], "project"))
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
        return project, result

    def written_profiles(self):
        """Every coverprofile the run wrote in its own reports dir."""
        own = Path(self.project, "test-reports", AGENT)
        texts = []
        for path in sorted(own.rglob("*")) if own.is_dir() else []:
            if path.is_file():
                text = path.read_text(encoding="utf-8", errors="replace")
                if text.startswith("mode: "):
                    texts.append(text)
        return texts

    def stored(self):
        events = self.board.test_events(AGENT)
        self.assertEqual(len(events), 1, f"exactly one run is stored; {self.where}")
        return self.board.event(events[0]["id"]) if events else {}

    def test_the_stored_lines_equal_the_deduplicated_statements_of_the_written_profiles(self):
        profiles = self.written_profiles()
        self.assertEqual(len(profiles), 2, f"one profile per module; {self.where}")
        self.assertIn("mode: set", [p.strip() for p in profiles],
                      f"the types-only module wrote a bare mode line; {self.where}")
        total, covered = statement_totals(profiles)
        self.assertTrue(0 < covered < total,
                        f"fixture sanity: some, not all, statements covered ({covered}/{total})")
        event = self.stored()
        coverage = event.get("coverage") or {}
        where = f"coverage={json.dumps(event.get('coverage'))} {self.where}"
        lines = coverage.get("lines") or {}
        self.assertEqual((lines.get("total"), lines.get("covered")), (total, covered),
                         f"the stored lines are the profiles' statements; {where}")

    def test_the_stored_coverage_has_no_functions_axis(self):
        event = self.stored()
        coverage = event.get("coverage")
        self.assertIsInstance(coverage, dict, f"coverage was stored; {self.where}")
        self.assertIsNone((coverage or {}).get("functions"),
                          f"a coverprofile states no functions; coverage={coverage!r}")

    def test_the_run_is_green_with_every_fixture_test_passing(self):
        summary = self.stored().get("summary") or {}
        self.assertEqual((summary.get("passed"), summary.get("failed")), (FIXTURE_TESTS, 0),
                         f"summary={summary!r} {self.where}")
        self.assertEqual(self.result.returncode, 0, self.where)


class ATierCoverageRegressionStoresTheUnionTest(unittest.TestCase):
    maxDiff = 6000
    results: list = []

    @classmethod
    def setUpClass(cls):
        cls.results = []

    def setUp(self):
        if _TIER.get("gap"):
            self.fail(f"missing toolchain: {_TIER['gap']}")
        self.board = _TIER["board"]
        if not type(self).results:
            type(self).results.append(self._drive())
        self.oracle, self.result = type(self).results[0]
        self.where = diagnostics(self.result)

    def _drive(self):
        scratch = _TIER["scratch"]
        oracle = oracle_profiles(os.path.join(scratch, "oracle"))
        project = copy_fixture(COVERAGE_FIXTURE, os.path.join(scratch, "project"))
        self.board.install(project)
        registered = subprocess.run(
            [sys.executable, str(PYTHON_CLIENT), "register", "--agent", TIER_AGENT,
             "--role", "report", "--project-dir", project], cwd=project,
            env=toolchain_env(), capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(registered.returncode, 0, f"register: {diagnostics(registered)}")
        result = subprocess.run(
            [sys.executable, str(GO_CLIENT), "regression", "--coverage", "--agent", TIER_AGENT,
             "--project-dir", project], cwd=project, env=toolchain_env(),
            capture_output=True, text=True, timeout=TIMEOUT, check=False)
        return oracle, result

    def stored(self):
        events = self.board.test_events(TIER_AGENT)
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
