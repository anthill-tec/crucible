"""The Vitest fixture project stays out of this repo's own bun suite.

`tests/fixtures/vitest-project` is a real Vitest project the bun client's tests
run from a scratch copy. Its test files are named `*.vitest.ts`, outside every
pattern `bun test` discovers (`.test`, `_test_`, `.spec`, `_spec_`), so none of
them is collected by:

* `bun test` from the repo root -- which is what this repo's `test:regression`
  script and the bun client's own `regression` run: one bare discovery over
  the root;
* the tier runs, which are declared by path: CI's `test-bun` job runs
  `bun test --timeout 30000 ./tests/unit` (with the hermetic dependency
  preload) then `./tests/integration`, each through the hermetic wrapper
  (`scripts/hermetic/run.sh`, CR-CRU-263), and the
  `test:unit` / `test:integration` scripts run the same directories through
  `scripts/run-test-target.ts` (pinned by `pipeline-test-timeout-default`).
  Neither tier directory holds the fixture.

Proved from the discovery itself, cheaply: bun's own discovery is pointed at the
fixture directory (it searches the directory and runs nothing), and the tier
directories are read from the workflow's commands (`tests/client/ci_workflow_steps`).
No nested full-suite run.

Invocation:
    python3 -m unittest tests.client.integration.test_bun_vitest_fixture_stays_out_of_this_repos_suite -v
"""

import shutil
import subprocess
import unittest
from pathlib import Path

from tests.client.ci_workflow_steps import bun_test_steps, bun_tier_paths
from tests.client.live_run_harness import REPO_ROOT, new_scratch, scrubbed_env

FIXTURE_REL = "tests/fixtures/vitest-project"
FIXTURE = REPO_ROOT / FIXTURE_REL
TIMEOUT = 120


def _fixture_test_files():
    return sorted(p.name for p in FIXTURE.glob("*.vitest.ts"))


def _under(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
    except ValueError:
        return False
    return True


class TheVitestFixtureStaysOutOfThisReposSuiteTest(unittest.TestCase):

    def setUp(self):
        bun = shutil.which("bun")
        if bun is None:
            self.fail("this proof asks the real `bun` what it collects")
        self.bun: str = bun
        self.assertGreaterEqual(
            len(_fixture_test_files()), 3,
            f"the committed Vitest fixture must hold its test files: {FIXTURE}")

    def run_bun(self, args, cwd):
        return subprocess.run([self.bun, *args], cwd=cwd, env=scrubbed_env(None),
                              capture_output=True, text=True, timeout=TIMEOUT,
                              check=False)

    def test_bun_test_from_the_repo_root_collects_no_fixture_file(self):
        # The same discovery as a bare `bun test`, narrowed to the fixture
        # directory: bun searches it and finds no test file there.
        result = self.run_bun(["test", "--timeout", "30000", f"./{FIXTURE_REL}"],
                              REPO_ROOT)
        output = result.stdout + result.stderr
        self.assertIn(
            "did not match any test files", output,
            f"bun test must collect none of the fixture's files; "
            f"exit={result.returncode} output={output[-2000:]!r}")
        self.assertNotIn("Ran ", output, f"output={output[-2000:]!r}")
        self.assertNotEqual(result.returncode, 0, f"output={output[-2000:]!r}")

    def test_bun_test_in_a_copy_of_the_fixture_finds_no_test_but_would_find_a_dot_test_file(self):
        scratch = new_scratch("vitest-fixture-discovery-")
        try:
            copy = Path(scratch, "project")
            shutil.copytree(FIXTURE, copy)
            result = self.run_bun(["test", "--timeout", "30000"], copy)
            output = result.stdout + result.stderr
            self.assertIn("No tests found", output,
                          f"exit={result.returncode} output={output[-2000:]!r}")
            self.assertNotEqual(result.returncode, 0, f"output={output[-2000:]!r}")

            # The control: the same probe DOES see a file named the way bun
            # discovers, so the empty result above is the naming, not the probe.
            Path(copy, "control.test.ts").write_text(
                'import { expect, test } from "bun:test";\n'
                'test("control", () => { expect(1).toBe(1); });\n')
            control = self.run_bun(["test", "--timeout", "30000"], copy)
            control_output = control.stdout + control.stderr
            self.assertIn("Ran 1 test", control_output,
                          f"output={control_output[-2000:]!r}")
            self.assertEqual(control.returncode, 0, f"output={control_output[-2000:]!r}")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def test_the_unit_and_integration_tier_directories_hold_no_fixture_file(self):
        # The tiers are declared by path, so a tier run collects only the files
        # under its directory, and the fixture lies under neither.
        tiers = bun_tier_paths()
        self.assertEqual(tiers, [["./tests/unit"], ["./tests/integration"]],
                         f"CI's bun test steps must each run one tier directory: "
                         f"{bun_test_steps()!r}")
        for [directory] in tiers:
            self.assertFalse(_under(FIXTURE, REPO_ROOT / directory),
                             f"the tier directory {directory} holds the fixture {FIXTURE_REL}")

    def test_ci_runs_bun_test_over_the_unit_then_the_integration_directory(self):
        # CI's bun steps are the two tier directories, each on the declared
        # budget and each through the hermetic wrapper (CR-CRU-263), the unit
        # tier with its dependency preload; another path argument there would
        # be a different collection.
        steps = bun_test_steps()
        self.assertEqual(
            steps,
            [(True, "bun test --timeout 30000 --preload ./scripts/hermetic/hooks/bun-preload.ts "
                    "./tests/unit"),
             (True, "bun test --timeout 30000 ./tests/integration")],
            f"CI's bun test steps as (through the hermetic wrapper, command): {steps!r}")


if __name__ == "__main__":
    unittest.main()
