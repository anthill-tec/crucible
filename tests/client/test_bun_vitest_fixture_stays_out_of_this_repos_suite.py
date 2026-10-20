"""The Vitest fixture project stays out of this repo's own bun suite.

`tests/fixtures/vitest-project` is a real Vitest project the bun client's tests
run from a scratch copy. Its test files are named `*.vitest.ts`, outside every
pattern `bun test` discovers (`.test`, `_test_`, `.spec`, `_spec_`), so none of
them is collected by:

* `bun test` from the repo root -- which is also what CI's
  `bun test --timeout 30000`, this repo's `test:regression` script and the bun
  client's own `regression` run: one bare discovery over the root;
* this repo's `test:unit` and `test:integration` scripts, which name the files
  `scripts/test-targets.ts` enumerates and partitions.

Proved from the discovery itself, cheaply: bun's own discovery is pointed at the
fixture directory (it searches the directory and runs nothing), and the target
enumeration is asked for its file list. No nested full-suite run.

Invocation:
    python3 -m unittest tests.client.test_bun_vitest_fixture_stays_out_of_this_repos_suite -v
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.client.live_run_harness import REPO_ROOT, new_scratch, scrubbed_env

FIXTURE_REL = "tests/fixtures/vitest-project"
FIXTURE = REPO_ROOT / FIXTURE_REL
TIMEOUT = 120
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"

_TARGET_LISTING = (
    'import { enumerateTestFiles, partitionTestFiles } from "./scripts/test-targets";\n'
    "const all = await enumerateTestFiles();\n"
    "const partition = await partitionTestFiles(all);\n"
    "console.log(JSON.stringify({ all, unit: partition.unit, "
    "integration: partition.integration }));\n"
)


def _fixture_test_files():
    return sorted(p.name for p in FIXTURE.glob("*.vitest.ts"))


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

    def test_the_unit_and_integration_targets_enumerate_no_fixture_file(self):
        result = self.run_bun(["-e", _TARGET_LISTING], REPO_ROOT)
        self.assertEqual(result.returncode, 0,
                         f"stderr={result.stderr[-2000:]!r}")
        listing = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertGreater(len(listing["all"]), 0, "the enumeration lists the suite")
        for target in ("all", "unit", "integration"):
            stray = [f for f in listing[target] if f.startswith(FIXTURE_REL)]
            self.assertEqual(stray, [],
                             f"the `{target}` listing collects a fixture file: {stray!r}")

    def test_ci_runs_the_bare_bun_test_discovery(self):
        # CI's bun step is the root discovery the probe above proves; a path
        # argument added there would be a different collection.
        steps = [line.strip() for line in CI_WORKFLOW.read_text().splitlines()
                 if line.strip().startswith("run: bun test")]
        self.assertEqual(steps, ["run: bun test --timeout 30000"],
                         f"CI's bun test steps: {steps!r}")


if __name__ == "__main__":
    unittest.main()
