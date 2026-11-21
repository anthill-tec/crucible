"""A bun package that still declares one of the keys `crucible.targets`
replaced is refused, by every verb that reads the package, before anything is
posted.

The three keys are `crucible.reportPath` (replaced by an entry's `junit`),
`crucible.rawReport` (replaced by an entry's `stream`) and
`crucible.testScript` (replaced by the table). A `package.json` declaring any
of them, with or without `crucible.targets` beside it, is refused by `test`,
`regression`, every tier verb (`unit`, `module`, `integration`, `e2e`, `bdd`)
and `pre-merge-gate`. The gate refuses it before its tsc step, because a
failing tsc step already files a compile result.

Every behavioural test drives the REAL `clients/bun-crucible.py` as an OS
subprocess against `TargetsBoard`, with `FAKE_TARGET_BUN` as the runner (both
in tests/client/bun_targets_harness.py). The fake records every spawn,
`x tsc` included, so "the runner never ran" and "tsc never ran" are read from
its spawn log.

What is pinned:
- each key x each verb family, with and without `crucible.targets`: a
  non-zero exit, no request to the board other than a read (no run start, no
  ingest, no compile, no heartbeat), the runner never spawned, and ONE
  `ok: false` envelope naming the declared key and `crucible.targets`;
- the gate's refusal comes before its tsc step: `x tsc` is never spawned, and
  `--skip-check` does not let the package through either;
- the refusal is manifest-wide: the old key here is keyed to a script no
  verb in these tests runs (`test:legacy`), and `regression` runs no script
  at all, so a refusal that only looked at the script being run would miss
  it;
- with `crucible.targets` beside the old key, the table is valid on its own,
  so the refusal cannot be the table's;
- the client keeps no reader of the old keys: `_declared_report_mechanism`,
  `RAW_REPORT_KEY`, `_declared_raw_report`, `_TEST_SCRIPT_DECLARATION`,
  `_declared_test_script` and `_emit_test_script_refused` are gone;
- this repo's own `package.json` and every fixture `package.json` declare no
  old key, and the Vitest fixture declares only `crucible.targets`, its
  `test:vitest` entry carrying framework `vitest` and the JUnit path its
  config reads (`junit: env:FIXTURE_JUNIT_PATH`, the declaration its
  `reportPath` made).

Interface choices (the spec leaves these open; GREEN is asked to use them):
- The refusal is said in the verb's envelope on stdout (`ok: false`, its
  `error` or its `warnings[]`); a `sys.exit` message on stderr alone does not
  satisfy these tests.
- The key is named by its full dotted name (`crucible.reportPath`,
  `crucible.rawReport`, `crucible.testScript`), as `crucible.targets` is.
"""

import importlib.util
import json
import os
import unittest
from pathlib import Path

from tests.client.bun_targets_harness import (
    BUN_CLIENT,
    JUNIT_VAR,
    TABLE,
    TargetsCase,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures"
VITEST_FIXTURE_MANIFEST = FIXTURES / "vitest-project" / "package.json"

TIER_VERBS = ("unit", "module", "integration", "e2e", "bdd")
LEGACY = "test:legacy"
OLD_KEYS = ("reportPath", "rawReport", "testScript")

# Each old key as a project declared it, keyed to a script no verb here runs.
OLD_DECLARATIONS = {
    "reportPath": {LEGACY: f"env:{JUNIT_VAR}"},
    "rawReport": {LEGACY: {"codec": "playwright", "file": "results.json",
                           "path": "env:FIXTURE_RAW_PATH"}},
    "testScript": LEGACY,
}

# A script for every tier verb and the one the old keys name.
SCRIPTS = {**{f"test:{tier}": "bun test" for tier in TIER_VERBS},
           LEGACY: "bun test"}

# A valid table entry for every tier script: nothing in it is refused.
VALID_TABLE = {f"test:{tier}": {"framework": "bun-test", "junit": "flag"}
               for tier in TIER_VERBS}

# The symbols that read the old keys, each gone with the key it read.
OLD_READERS = ("_declared_report_mechanism", "RAW_REPORT_KEY",
               "_declared_raw_report", "_TEST_SCRIPT_DECLARATION",
               "_declared_test_script", "_emit_test_script_refused")


class _OldKeyCase(TargetsCase):
    """A scratch package declaring one old key, driven through one verb."""

    def declare_old_key(self, key, with_targets):
        crucible = {key: OLD_DECLARATIONS[key]}
        if with_targets:
            crucible[TABLE.split(".", 1)[1]] = VALID_TABLE
        self.declare(dict(SCRIPTS), crucible)

    def writes_to_board(self):
        """Every request the board heard that was not a read."""
        with self.board._lock:
            return [(method, path) for _t, method, path, _b in self.board.events
                    if method != "GET"]

    def assert_refused_naming(self, drive, key):
        """The refusal: a non-zero exit, nothing filed, the runner never
        spawned, and ONE `ok: false` envelope naming the key and
        `crucible.targets`."""
        self.assertNotEqual(drive.returncode, 0,
                            f"a refused package exits non-zero; {drive.diag()}")
        self.assertEqual(self.writes_to_board(), [],
                         f"a refused package files nothing; {drive.diag()}")
        self.assertEqual(self.spawns(), [],
                         f"a refused package never spawns bun; {drive.diag()}")
        envelope = self.envelope(drive)
        self.assertIs(envelope.get("ok"), False, f"envelope={envelope!r}")
        said = json.dumps(envelope)
        for name in (f"crucible.{key}", TABLE):
            self.assertIn(name, said,
                          f"the refusal names {name!r}; envelope={envelope!r}")


# ── test ────────────────────────────────────────────────────────────────────


class TestRefusesAPackageDeclaringAnOldKeyTest(_OldKeyCase):

    def refused(self, key, with_targets):
        self.declare_old_key(key, with_targets)
        self.assert_refused_naming(self.drive("test"), key)

    def test_report_path_without_targets_is_refused(self):
        self.refused("reportPath", with_targets=False)

    def test_report_path_beside_targets_is_refused(self):
        self.refused("reportPath", with_targets=True)

    def test_raw_report_without_targets_is_refused(self):
        self.refused("rawReport", with_targets=False)

    def test_raw_report_beside_targets_is_refused(self):
        self.refused("rawReport", with_targets=True)

    def test_test_script_without_targets_is_refused(self):
        self.refused("testScript", with_targets=False)

    def test_test_script_beside_targets_is_refused(self):
        self.refused("testScript", with_targets=True)


# ── regression ──────────────────────────────────────────────────────────────


class RegressionRefusesAPackageDeclaringAnOldKeyTest(_OldKeyCase):

    def refused(self, key, with_targets):
        self.declare_old_key(key, with_targets)
        self.assert_refused_naming(self.drive("regression"), key)

    def test_report_path_without_targets_is_refused(self):
        self.refused("reportPath", with_targets=False)

    def test_report_path_beside_targets_is_refused(self):
        self.refused("reportPath", with_targets=True)

    def test_raw_report_without_targets_is_refused(self):
        self.refused("rawReport", with_targets=False)

    def test_raw_report_beside_targets_is_refused(self):
        self.refused("rawReport", with_targets=True)

    def test_test_script_without_targets_is_refused(self):
        self.refused("testScript", with_targets=False)

    def test_test_script_beside_targets_is_refused(self):
        self.refused("testScript", with_targets=True)


# ── every tier verb ─────────────────────────────────────────────────────────


class EveryTierVerbRefusesAPackageDeclaringAnOldKeyTest(_OldKeyCase):
    """Each tier verb on a package declaring its `test:<tier>` script, so
    that the verb would otherwise run it."""

    def refused(self, key, with_targets):
        for tier in TIER_VERBS:
            with self.subTest(verb=tier):
                self.declare_old_key(key, with_targets)
                self.spawn_log.unlink(missing_ok=True)
                with self.board._lock:
                    self.board.events.clear()
                self.assert_refused_naming(self.drive(tier), key)

    def test_report_path_without_targets_is_refused(self):
        self.refused("reportPath", with_targets=False)

    def test_report_path_beside_targets_is_refused(self):
        self.refused("reportPath", with_targets=True)

    def test_raw_report_without_targets_is_refused(self):
        self.refused("rawReport", with_targets=False)

    def test_raw_report_beside_targets_is_refused(self):
        self.refused("rawReport", with_targets=True)

    def test_test_script_without_targets_is_refused(self):
        self.refused("testScript", with_targets=False)

    def test_test_script_beside_targets_is_refused(self):
        self.refused("testScript", with_targets=True)


# ── pre-merge-gate, before its tsc step ─────────────────────────────────────


class PreMergeGateRefusesAnOldKeyBeforeItsTscStepTest(_OldKeyCase):

    def refused(self, key, with_targets, *flags):
        self.declare_old_key(key, with_targets)
        drive = self.drive("pre-merge-gate", *flags)
        tsc = [s for s in self.spawns() if s.get("argv", [])[:2] == ["x", "tsc"]]
        self.assertEqual(tsc, [],
                         f"the gate refuses before its tsc step; {drive.diag()}")
        self.assert_refused_naming(drive, key)

    def test_report_path_without_targets_is_refused_before_tsc(self):
        self.refused("reportPath", False)

    def test_report_path_beside_targets_is_refused_before_tsc(self):
        self.refused("reportPath", True)

    def test_raw_report_without_targets_is_refused_before_tsc(self):
        self.refused("rawReport", False)

    def test_raw_report_beside_targets_is_refused_before_tsc(self):
        self.refused("rawReport", True)

    def test_test_script_without_targets_is_refused_before_tsc(self):
        self.refused("testScript", False)

    def test_test_script_beside_targets_is_refused_before_tsc(self):
        self.refused("testScript", True)

    def test_a_gate_skipping_its_tsc_step_still_refuses_an_old_key(self):
        self.refused("reportPath", True, "--skip-check")


# ── the readers go ──────────────────────────────────────────────────────────


def _load_bun_client():
    spec = importlib.util.spec_from_file_location("bun_crucible_old_key_readers",
                                                  BUN_CLIENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TheClientKeepsNoReaderOfAnOldKeyTest(unittest.TestCase):

    def test_no_reader_of_an_old_key_remains_in_the_bun_client(self):
        client = _load_bun_client()
        remaining = [name for name in OLD_READERS if hasattr(client, name)]
        self.assertEqual(remaining, [],
                         f"the readers of the old keys are removed; "
                         f"still defined: {remaining!r}")


# ── dog-food: no old key in this repo or its fixtures ───────────────────────


def _manifests():
    """This repo's own `package.json` and every fixture's, outside any
    installed `node_modules`."""
    found = [REPO_ROOT / "package.json"]
    for root, dirs, files in os.walk(FIXTURES):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        if "package.json" in files:
            found.append(Path(root) / "package.json")
    return found


class NoManifestInThisRepoDeclaresAnOldKeyTest(unittest.TestCase):

    def test_no_package_json_in_the_repo_or_its_fixtures_declares_an_old_key(self):
        manifests = _manifests()
        self.assertIn(VITEST_FIXTURE_MANIFEST, manifests,
                      "the walk reaches the Vitest fixture's manifest")
        declaring = []
        for path in manifests:
            crucible = json.loads(path.read_text(encoding="utf-8")).get("crucible") or {}
            declaring += [f"{path.relative_to(REPO_ROOT)}: crucible.{key}"
                          for key in OLD_KEYS if key in crucible]
        self.assertEqual(declaring, [],
                         f"no manifest declares an old key; found {declaring!r}")

    def test_the_vitest_fixture_declares_only_crucible_targets(self):
        manifest = json.loads(VITEST_FIXTURE_MANIFEST.read_text(encoding="utf-8"))
        crucible = manifest.get("crucible") or {}
        self.assertEqual(sorted(crucible), ["targets"],
                         f"the fixture's crucible block is its table alone; "
                         f"crucible={crucible!r}")
        declared = (crucible.get("targets") or {}).get("test:vitest")
        self.assertIsInstance(declared, dict,
                              f"test:vitest has a table entry; crucible={crucible!r}")
        entry = declared if isinstance(declared, dict) else {}
        self.assertEqual(entry.get("framework"), "vitest", f"entry={entry!r}")
        self.assertEqual(entry.get("junit"), f"env:{JUNIT_VAR}",
                         f"the JUnit path arrives the way the fixture's config "
                         f"reads it; entry={entry!r}")


if __name__ == "__main__":
    unittest.main()
