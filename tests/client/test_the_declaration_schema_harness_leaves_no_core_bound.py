"""A declaration-schema test leaves no shared core bound to its project.

`declaration_schema_harness.client(stack)` loads each client ONCE per
process, so the shared core behind it (`client(stack)._axi()`) outlives every
test that uses it. A test that drives a client function which resolves its
project (`_resolve_project_dir`, which binds the core) leaves that core bound
to the test's own `declaration-schema-*` project dir -- a directory its
cleanup deletes. The next test that reads the core then resolves its limits
and its board against a directory that no longer exists.

The harness restores each core's binding after a test. These tests run the
declaration-schema tests in process, each with every core bound to a
sentinel directory this test owns, and check the binding after it:

- the one test known to leave the bun core bound
  (`BunsKeyRulesHoldTest.test_the_gate_refuses_a_non_bun_test_entry_off_the_test_tier_template`,
  whose `_off_template_target` reads `_package_scripts` and `_targets_table`,
  both of which resolve the project dir);
- every test in the module, so no other one does it either.

No process, no socket, no board.
"""

import shutil
import tempfile
import unittest

from tests.client import declaration_schema_harness as harness
from tests.client import test_the_clients_agree_with_the_declaration_schema as agreement

THE_TEST_THAT_LEAVES_BUN_BOUND = (
    "BunsKeyRulesHoldTest."
    "test_the_gate_refuses_a_non_bun_test_entry_off_the_test_tier_template")


def _cores():
    """Every shared core behind the harness's six clients, by stack."""
    return {stack: harness.client(stack)._axi() for stack in harness.STACKS}


class _SentinelBindingCase(unittest.TestCase):

    def setUp(self):
        self.cores = _cores()
        self.sentinel = tempfile.mkdtemp(prefix="declaration-schema-sentinel-")
        for core in self.cores.values():
            self.addCleanup(core.bind_project_dir, core._PROJECT_DIR)
        self.addCleanup(self._remove_sentinel)

    def _remove_sentinel(self):
        shutil.rmtree(self.sentinel, ignore_errors=True)

    def bind_sentinel(self):
        for core in self.cores.values():
            core.bind_project_dir(self.sentinel)

    def run_in_process(self, test_id):
        """Run one test of the agreement module, every core bound to the
        sentinel first; answer `(result, {stack: binding after})`."""
        self.bind_sentinel()
        test = unittest.defaultTestLoader.loadTestsFromName(test_id, agreement)
        result = unittest.TestResult()
        test.run(result)
        return result, {stack: core._PROJECT_DIR for stack, core in self.cores.items()}

    def changed(self, after):
        return {stack: binding for stack, binding in after.items()
                if binding != self.sentinel}


class TheDeclarationSchemaHarnessLeavesNoCoreBoundTest(_SentinelBindingCase):

    def test_the_bun_gate_template_test_leaves_the_bun_core_as_it_found_it(self):
        result, after = self.run_in_process(THE_TEST_THAT_LEAVES_BUN_BOUND)

        self.assertEqual(result.testsRun, 1)
        self.assertEqual((result.failures, result.errors), ([], []),
                         "the driven test itself must pass")
        self.assertEqual(
            after["bun"], self.sentinel,
            f"{THE_TEST_THAT_LEAVES_BUN_BOUND} left the shared bun core bound to "
            f"{after['bun']!r}, its own deleted project dir, instead of the "
            f"binding it found ({self.sentinel!r})")
        self.assertEqual(self.changed(after), {})

    def test_no_declaration_schema_test_leaves_a_core_bound(self):
        suite = unittest.defaultTestLoader.loadTestsFromModule(agreement)
        test_ids = sorted(test.id() for test in _flatten(suite))
        self.assertGreater(len(test_ids), 40, "the agreement module was not loaded")
        leaks = []
        for test_id in test_ids:
            name = test_id.removeprefix(agreement.__name__ + ".")
            result, after = self.run_in_process(name)
            self.assertEqual((result.failures, result.errors), ([], []),
                             f"{name} itself failed when run alone")
            for stack, binding in sorted(self.changed(after).items()):
                leaks.append(f"{name}: the {stack} core left bound to {binding!r}")
        self.assertEqual(leaks, [], "\n" + "\n".join(leaks))


def _flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _flatten(item)
        else:
            yield item


if __name__ == "__main__":
    unittest.main()
