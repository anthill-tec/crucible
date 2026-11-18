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
        --tests tests.client.integration.test_a_go_tier_runs_every_module_that_declares_it
"""

import os
import re
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
BOTH_MODULES_AND_B_TIER = [("example.com/a", "TestA", "pass"),
                           ("example.com/b", "TestB", "pass"),
                           ("example.com/b", "TestBInteg", "pass")]
#: The line a run of several invocations writes to stderr before each one (the
#: command it runs and the directory it runs in), and once for the whole run.
NARRATION = re.compile(r"^\[crucible\] running: (?P<cmd>.+) \(in (?P<cwd>.+)\)$",
                       re.MULTILINE)


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


class ARegressionHoldsBothModulesAndOnlyBsTierTest(unittest.TestCase):
    """`regression` on `tier-two-modules` is ONE run under tier `regression`
    holding both modules' untagged tests (`TestA`, `TestB`) and `b`'s
    `integration` test (`TestBInteg`), each once: `go test -json ./...` in
    `a`, then in `b`, then `b`'s tier invocation. Each invocation is narrated
    on stderr as the command it runs, in the module it runs in."""

    maxDiff = 4000
    drives: list = []

    @classmethod
    def setUpClass(cls):
        cls.drives = []

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")
        if not type(self).drives:
            p = tier_project(self, "tier-two-modules")
            p.board.script_run(passed=3)
            type(self).drives.append((p, drive_tier(p, "regression")))
        self.p, self.result = type(self).drives[0]
        self.ctx = where(self.p, self.result)

    def module_of(self, cwd):
        return os.path.relpath(os.path.realpath(cwd), os.path.realpath(self.p.dir))

    def narrated(self):
        """`(command, module)` of each invocation's `running:` line on stderr,
        in order: a line naming one directory. The run's own summary line,
        naming every module's directory at once, is not an invocation's."""
        return [(m.group("cmd"), self.module_of(m.group("cwd")))
                for m in NARRATION.finditer(self.result.stderr)
                if ", " not in m.group("cwd")]

    def test_one_run_opens_under_regression_with_start_total_three(self):
        opened = starts(self.p)
        self.assertEqual(len(opened), 1, f"exactly one run; {self.ctx}")
        start = opened[0] if opened else {}
        self.assertEqual((start.get("tier"), start.get("total")), ("regression", 3),
                         f"TestA, TestB and TestBInteg; start={start!r}")

    def test_go_test_runs_untagged_in_a_and_b_then_bs_integration_tier(self):
        ran = [(c["argv"], self.module_of(c["cwd"])) for c in self.p.run_calls()]
        self.assertEqual(ran, [
            (["test", "-json", "./..."], "a"),
            (["test", "-json", "./..."], "b"),
            (["test", "-json", "-tags", "integration", "-run", "^(TestBInteg)$",
              "example.com/b"], "b"),
        ], self.ctx)

    def test_each_test_of_both_modules_and_bs_tier_is_filed_once(self):
        self.assertEqual(sorted(held_terminals(self.p)), BOTH_MODULES_AND_B_TIER,
                         f"TestA, TestB and TestBInteg, each once; {self.ctx}")
        axi = envelope(self.result.stdout) or {}
        self.assertEqual((axi.get("verb"), axi.get("ok")), ("regression", True), self.ctx)
        self.assertEqual(self.result.returncode, 0, self.ctx)

    def test_an_untagged_invocation_is_narrated_as_exactly_go_test_json_dot_dot_dot(self):
        untagged = [n for n in self.narrated() if "-tags" not in n[0]]
        self.assertEqual(untagged, [("go test -json ./...", "a"), ("go test -json ./...", "b")],
                         f"each untagged invocation narrated once as the command it runs, "
                         f"never with `./...` twice; stderr={self.result.stderr[-1500:]!r}")

    def test_the_tier_invocation_is_narrated_with_its_tag_its_run_and_its_package(self):
        tagged = [n for n in self.narrated() if "-tags" in n[0]]
        self.assertEqual(len(tagged), 1,
                         f"one tier invocation narrated; stderr={self.result.stderr[-1500:]!r}")
        command, module = tagged[0] if tagged else ("", "")
        self.assertTrue(command.startswith("go test -json "), f"{command!r}")
        self.assertIn("-tags integration", command, f"the tier's tag; {command!r}")
        self.assertIn(" -run ", command, f"the `-run` that selects the tier's tests; "
                                         f"{command!r}")
        self.assertTrue(command.endswith(" example.com/b"), f"the package; {command!r}")
        self.assertEqual(module, "b", f"run in module b; {command!r}")


if __name__ == "__main__":
    unittest.main()
