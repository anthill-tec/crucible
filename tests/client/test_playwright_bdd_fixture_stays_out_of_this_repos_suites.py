"""The playwright-bdd fixture project stays out of this repo's own suites.

`tests/fixtures/playwright-bdd-project` is a real playwright-bdd project the
Playwright reporter's tests run from a scratch copy. None of its files is
collected by:

* `bun test` from the repo root -- its step files are plain `*.ts`, its
  features `*.feature`, outside every pattern `bun test` discovers -- nor by the
  `test:unit` / `test:integration` enumeration in `scripts/test-targets.ts`;
* this repo's own `playwright.config.ts` -- the features and steps its
  `defineBddConfig` declares match no fixture file, and the `testDir`
  Playwright discovers under (the generated output) does not hold the fixture.

Proved from the discovery itself, cheaply, each with a control showing the
probe does see what it is meant to see. No nested suite run.

Invocation:
    python3 -m unittest tests.client.test_playwright_bdd_fixture_stays_out_of_this_repos_suites -v
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.client.live_run_harness import REPO_ROOT, new_scratch, scrubbed_env
from tests.client.playwright_reporter_scratch import FIXTURE, FIXTURE_REL

TIMEOUT = 120

_TARGET_LISTING = (
    'import { enumerateTestFiles, partitionTestFiles } from "./scripts/test-targets";\n'
    "const all = await enumerateTestFiles();\n"
    "const partition = await partitionTestFiles(all);\n"
    "console.log(JSON.stringify({ all, unit: partition.unit, "
    "integration: partition.integration }));\n"
)

# This repo's Playwright config as Playwright loads it: its `testDir`, each
# project's own `testDir`, and the playwright-bdd configs `defineBddConfig`
# records for `bddgen` (PLAYWRIGHT_BDD_CONFIGS).
_CONFIG_LISTING = (
    'const config = (await import("./playwright.config.ts")).default;\n'
    'const bdd = JSON.parse(process.env["PLAYWRIGHT_BDD_CONFIGS"] ?? "{}");\n'
    "console.log(JSON.stringify({ testDir: config.testDir ?? null,\n"
    "  projectTestDirs: (config.projects ?? []).map((p) => p.testDir ?? null),\n"
    "  bdd: Object.values(bdd).map((c) => ({ configDir: c.configDir, outputDir: c.outputDir,\n"
    "    features: [c.features].flat(), steps: [c.steps].flat() })) }));\n"
)

def _fixture_files():
    return sorted(p.relative_to(FIXTURE).as_posix() for p in FIXTURE.rglob("*") if p.is_file())

def _under(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
    except ValueError:
        return False
    return True

class ThePlaywrightBddFixtureStaysOutOfThisReposSuitesTest(unittest.TestCase):

    def setUp(self):
        bun = shutil.which("bun")
        if bun is None:
            self.fail("this proof asks the real `bun` what it collects")
        self.bun: str = bun
        files = _fixture_files()
        self.assertTrue(
            {"playwright.config.ts", "steps/steps.ts"} <= set(files)
            and len([f for f in files if f.endswith(".feature")]) >= 3,
            f"the committed playwright-bdd fixture must hold its config, steps and "
            f"features: {FIXTURE} holds {files!r}")

    def run_bun(self, args, cwd, **env):
        return subprocess.run([self.bun, *args], cwd=cwd, env=scrubbed_env(None, **env),
                              capture_output=True, text=True, timeout=TIMEOUT, check=False)

    def test_bun_test_from_the_repo_root_collects_no_fixture_file(self):
        result = self.run_bun(["test", "--timeout", "30000", f"./{FIXTURE_REL}"], REPO_ROOT)
        output = result.stdout + result.stderr
        self.assertIn("did not match any test files", output,
                      f"bun test must collect none of the fixture's files; "
                      f"exit={result.returncode} output={output[-2000:]!r}")
        self.assertNotIn("Ran ", output, f"output={output[-2000:]!r}")
        self.assertNotEqual(result.returncode, 0, f"output={output[-2000:]!r}")

    def test_bun_test_in_a_copy_of_the_fixture_finds_no_test_but_would_find_a_dot_test_file(self):
        scratch = new_scratch("playwright-bdd-fixture-discovery-")
        try:
            copy = Path(scratch, "project")
            shutil.copytree(FIXTURE, copy)
            result = self.run_bun(["test", "--timeout", "30000"], copy)
            output = result.stdout + result.stderr
            self.assertIn("No tests found", output,
                          f"exit={result.returncode} output={output[-2000:]!r}")
            self.assertNotEqual(result.returncode, 0, f"output={output[-2000:]!r}")

            # The control: a step file named the way bun discovers IS collected,
            # so the empty result above is the naming, not the probe.
            Path(copy, "steps", "control.test.ts").write_text(
                'import { expect, test } from "bun:test";\n'
                'test("control", () => { expect(1).toBe(1); });\n')
            control = self.run_bun(["test", "--timeout", "30000"], copy)
            control_output = control.stdout + control.stderr
            self.assertIn("Ran 1 test", control_output, f"output={control_output[-2000:]!r}")
            self.assertEqual(control.returncode, 0, f"output={control_output[-2000:]!r}")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    def test_the_unit_and_integration_targets_enumerate_no_fixture_file(self):
        result = self.run_bun(["-e", _TARGET_LISTING], REPO_ROOT)
        self.assertEqual(result.returncode, 0, f"stderr={result.stderr[-2000:]!r}")
        listing = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertGreater(len(listing["all"]), 0, "the enumeration lists the suite")
        for target in ("all", "unit", "integration"):
            stray = [f for f in listing[target] if f.startswith(FIXTURE_REL)]
            self.assertEqual(stray, [],
                             f"the `{target}` listing collects a fixture file: {stray!r}")

    def test_this_repos_playwright_config_generates_and_collects_no_fixture_file(self):
        result = self.run_bun(["-e", _CONFIG_LISTING], REPO_ROOT)
        self.assertEqual(result.returncode, 0, f"stderr={result.stderr[-2000:]!r}")
        listing = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertGreater(len(listing["bdd"]), 0,
                           f"the repo config declares its BDD features: {listing!r}")
        for bdd in listing["bdd"]:
            config_dir = Path(bdd["configDir"])
            features = [p for pattern in bdd["features"] for p in config_dir.glob(pattern)]
            steps = [p for pattern in bdd["steps"] for p in config_dir.glob(pattern)]
            # The control: the globs do find this repo's own e2e features and steps.
            self.assertGreater(len(features), 0, f"features glob finds nothing: {bdd!r}")
            self.assertGreater(len(steps), 0, f"steps glob finds nothing: {bdd!r}")
            self.assertEqual([str(p) for p in features + steps if _under(p, FIXTURE)], [],
                             f"bddgen would generate from a fixture file: {bdd!r}")
            self.assertFalse(_under(FIXTURE, bdd["outputDir"]),
                             f"the generated output dir holds the fixture: {bdd!r}")
        test_dirs = [listing["testDir"], *[d for d in listing["projectTestDirs"] if d]]
        self.assertIsNotNone(listing["testDir"], f"{listing!r}")
        self.assertEqual([d for d in test_dirs if _under(FIXTURE, d)], [],
                         f"Playwright discovers under a testDir that holds the fixture: "
                         f"{test_dirs!r}")

if __name__ == "__main__":
    unittest.main()
