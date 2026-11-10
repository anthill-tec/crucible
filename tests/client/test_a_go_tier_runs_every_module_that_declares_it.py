"""A go tier verb runs every module under the project dir that declares the
tier, and only those.

Which modules a tier verb runs: every module under the project dir that
declares the tier, found as `regression` finds modules. `--module-dir`, new on
the tier verbs, narrows the run to that one module, and a module that does not
declare the tier is refused as undeclared. `GO_CRUCIBLE_MODULE_DIR` and
`crucible.toml [go] module_dir` do not narrow a tier verb, as they do not
narrow `regression`.

The project is `tests/fixtures/go-client/tier-two-modules`: module `a`
(`example.com/a`, untagged `TestA`) and module `b` (`example.com/b`, untagged
`TestB` and `integration`-tagged `TestBInteg`). Driven with the real go client
and the real `go` behind the recording shim of `go_client_harness`, against a
`RecordingBoard`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_go_tier_runs_every_module_that_declares_it
"""

import os
import unittest

from tests.client.go_client_harness import go_toolchain_gap
from tests.client.go_tier_harness import (
    UNDECLARED_CODE,
    drive_tier,
    envelope,
    go_test_calls,
    held_terminals,
    said,
    starts,
    tier_project,
    where,
)

B_ONLY = [("example.com/b", "TestBInteg", "pass")]


class _TwoModuleCase(unittest.TestCase):
    maxDiff = 4000

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")
        self.p = tier_project(self, "tier-two-modules")
        self.p.board.script_run(passed=1)

    def module_of(self, call):
        return os.path.relpath(os.path.realpath(call["cwd"]), os.path.realpath(self.p.dir))

    def assert_ran_b_only(self, result):
        ctx = where(self.p, result)
        opened = starts(self.p)
        self.assertEqual(len(opened), 1, f"one run; {ctx}")
        start = opened[0] if opened else {}
        self.assertEqual((start.get("tier"), start.get("total")), ("integration", 1),
                         f"one integration test, b's; {start!r}")
        self.assertEqual(held_terminals(self.p), B_ONLY,
                         f"only b's TestBInteg is filed — not TestA, not TestB; {ctx}")
        calls = go_test_calls(self.p)
        self.assertGreaterEqual(len(calls), 1, ctx)
        self.assertEqual({self.module_of(c) for c in calls}, {"b"},
                         f"`go test` runs in module b only; {ctx}")
        self.assertEqual(result.returncode, 0, ctx)


class AnIntegrationRunRunsOnlyTheModuleThatDeclaresItTest(_TwoModuleCase):

    def test_integration_runs_module_b_only(self):
        self.assert_ran_b_only(drive_tier(self.p, "integration"))

    def test_crucible_toml_module_dir_does_not_narrow_the_tier_verb(self):
        self.p.declare_module_dir("a")
        self.assert_ran_b_only(drive_tier(self.p, "integration"))

    def test_go_crucible_module_dir_does_not_narrow_the_tier_verb(self):
        self.assert_ran_b_only(drive_tier(self.p, "integration", GO_CRUCIBLE_MODULE_DIR="a"))


class ModuleDirNamingAModuleThatDoesNotDeclareTheTierIsRefusedTest(_TwoModuleCase):

    def test_integration_module_dir_a_is_refused_as_undeclared(self):
        result = drive_tier(self.p, "integration", "--module-dir", "a")
        ctx = where(self.p, result)
        self.assertNotEqual(result.returncode, 0, ctx)
        axi = envelope(result.stdout) or {}
        self.assertEqual(axi.get("verb"), "integration", ctx)
        self.assertIs(axi.get("ok"), False, ctx)
        self.assertIn(UNDECLARED_CODE, result.stderr, f"refused as undeclared; {ctx}")
        self.assertIn("//go:build integration", said(axi), ctx)
        self.assertEqual(go_test_calls(self.p), [], f"no `go test` runs; {ctx}")
        self.assertEqual(starts(self.p), [], f"no run opens; {ctx}")

    def test_integration_module_dir_b_runs_module_b(self):
        self.assert_ran_b_only(drive_tier(self.p, "integration", "--module-dir", "b"))


if __name__ == "__main__":
    unittest.main()
