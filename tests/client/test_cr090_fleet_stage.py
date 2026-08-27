"""CR-CRU-090 C1 (§S1, ACs 1, 2 and 6) -- the `fleet` stage: the eight client
files land under `<target-dir>/clients/` BEFORE the manifest that names them.

Why these three assertions, and why they are the whole of this cycle:

At 0.1.2 `install.STAGE_ORDER` is `("server", "manifest")` and NO stage copies
the fleet. The wheel force-includes `clients` as `crucible_axi/clients`, so the
files exist only inside the installed package, while `manifest.build_manifest`
publishes `clients[stack] = <install_dir>/clients/<stack>-crucible.py` and
`status = <install_dir>/clients/STATUS-CONTRACT.md`. The manifest therefore
writes successfully, converges idempotently, and names SIX paths that do not
exist. `cli.py` hides the gap because it resolves the fleet from the package
for its own use (`_clients_dir()`), so no in-repo path exercises the
declaration `--target-dir` actually makes.

- AC1 pins the ORDER as data: `STAGE_ORDER == ("server", "fleet", "manifest")`,
  `fleet` strictly before `manifest`, a runner registered under that key, and a
  real `run_install` reporting a `fleet` stage whose `path` is the clients dir.
- AC2 pins the PAYLOAD as bytes: exactly the eight packaged files, no extras,
  each byte-identical to its source. Bytes, not sizes -- a truncated or
  rewritten copy is the failure a size check would pass. The five clients load
  `_crucible_axi.py` and `toon.py` BY FILE PATH from their own directory, so
  those two plus `STATUS-CONTRACT.md` are as load-bearing as the clients.
- AC6 proves the ordering is ENFORCED by `STAGE_ORDER`, not incidental: with
  the `fleet` stage raising, the fail-fast contract must stop `manifest` from
  running at all, so a manifest is never written naming paths that were never
  laid down. On 0.1.2 this fails loudly for the diagnostic reason -- `fleet` is
  not in `STAGE_ORDER`, so the stub is never reached and `manifest` writes
  anyway.

NOT this cycle (owned elsewhere in plan 89): convergence/`--force` (AC5), every
manifest path resolving (AC3), a copied client running (AC4), the
`manifest.source_clients_dir()` single resolver (§S2/AC7), the `cli.main()`
integration (AC8).

Every test owns a `tempfile.mkdtemp` scratch target under `/tmp` and removes
it; the `[server]` stage is always stubbed to a no-subprocess provision double,
because the real one runs `bun add -g` and provisions GLOBALLY. Nothing is
written inside the repo or into `~/.crucible`.
"""

import filecmp
import importlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]

# The SOURCE of truth for the copy: the repo checkout's own fleet directory,
# which is what `cli._clients_dir()` resolves to in a source checkout and what
# the wheel force-includes as `crucible_axi/clients`.
SOURCE_CLIENTS_DIR = REPO_ROOT / "clients"

# §S1 -- the packaged fleet, exactly. Five clients plus the two shared modules
# they load by file path plus the status contract the manifest publishes.
EXPECTED_FLEET_FILES = frozenset({
    "bun-crucible.py",
    "python-crucible.py",
    "rust-crucible.py",
    "mvn-crucible.py",
    "arduino-crucible.py",
    "_crucible_axi.py",
    "toon.py",
    "STATUS-CONTRACT.md",
})

EXPECTED_STAGE_ORDER = ("server", "fleet", "manifest")

FLEET_STAGE_NAME = "fleet"
MANIFEST_STAGE_NAME = "manifest"
CLIENTS_DIRNAME = "clients"
MANIFEST_FILENAME = "crucible-clients.json"

STAGE_FAILED_CODE = "stage-failed"


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(*module_names):
    """Import the named `crucible_axi` modules from the repo-root checkout,
    dropping any already-imported copy first so the module-level `STAGE_ORDER`
    and `DEFAULT_STAGE_RUNNERS` read here are this tree's, never an installed
    wheel's."""
    _ensure_repo_root_on_path()
    for name in module_names:
        sys.modules.pop(name, None)
    return tuple(importlib.import_module(name) for name in module_names)


def _fast_provision_server_stage(target_dir, force):
    """A [server] stage double that PROVISIONS instantly: no subprocess, no
    network, no Bun, no global `bun add -g`. Matches the `(target_dir, force)`
    runner protocol."""
    return {"path": os.path.join(target_dir, "server"), "converged": False}


class _ScratchInstallCase(unittest.TestCase):
    """Shared fixture: one throwaway target dir per test, under `/tmp`."""

    def setUp(self):
        self.target = tempfile.mkdtemp(prefix="cr090-fleet-target-")
        self.install, = _import_fresh("crucible_axi.install")

    def tearDown(self):
        shutil.rmtree(self.target, ignore_errors=True)

    def clients_dir(self):
        return os.path.join(self.target, CLIENTS_DIRNAME)

    def manifest_path(self):
        return os.path.join(self.target, MANIFEST_FILENAME)

    def run_install_with_stubbed_server(self, **kwargs):
        """`run_install` against the scratch target with ONLY the [server]
        stage stubbed -- the real `fleet` and `manifest` runners execute, which
        is the whole point of AC2."""
        with mock.patch.dict(self.install.DEFAULT_STAGE_RUNNERS,
                             {"server": _fast_provision_server_stage}):
            return self.install.run_install(self.target, **kwargs)


class FleetStageOrderContractTest(_ScratchInstallCase):
    """AC1 -- the stage exists, is registered, is ordered strictly BEFORE
    `manifest`, and reports the clients dir as its path."""

    def test_stage_order_is_exactly_server_fleet_manifest(self):
        self.assertEqual(
            self.install.STAGE_ORDER, EXPECTED_STAGE_ORDER,
            f"§S1/AC1 -- STAGE_ORDER must be exactly {EXPECTED_STAGE_ORDER!r} "
            f"so the manifest is written only AFTER the paths it names exist; "
            f"got {self.install.STAGE_ORDER!r}")

    def test_fleet_is_ordered_strictly_before_manifest(self):
        """The relation, asserted independently of the exact tuple: even if a
        future stage joins the order, `fleet` must precede `manifest`."""
        order = list(self.install.STAGE_ORDER)
        self.assertIn(
            FLEET_STAGE_NAME, order,
            f"§S1 -- no {FLEET_STAGE_NAME!r} stage in STAGE_ORDER={order!r}; "
            f"nothing materialises <target-dir>/clients/ today")
        self.assertIn(MANIFEST_STAGE_NAME, order)
        self.assertLess(
            order.index(FLEET_STAGE_NAME), order.index(MANIFEST_STAGE_NAME),
            f"AC1 -- {FLEET_STAGE_NAME!r} must run BEFORE "
            f"{MANIFEST_STAGE_NAME!r}, else the manifest names paths that do "
            f"not exist yet; order={order!r}")

    def test_default_stage_runners_registers_a_fleet_runner(self):
        runners = self.install.DEFAULT_STAGE_RUNNERS
        self.assertIn(
            FLEET_STAGE_NAME, runners,
            f"AC1 -- DEFAULT_STAGE_RUNNERS must carry a {FLEET_STAGE_NAME!r} "
            f"runner; keys={sorted(runners)}")
        self.assertTrue(
            callable(runners.get(FLEET_STAGE_NAME)),
            f"the {FLEET_STAGE_NAME!r} entry must be a callable stage runner; "
            f"got {runners.get(FLEET_STAGE_NAME)!r}")

    def test_run_install_reports_a_fleet_stage_pathed_at_the_clients_dir(self):
        ok, stages, warnings = self.run_install_with_stubbed_server()
        names = [s["name"] for s in stages]
        self.assertIn(
            FLEET_STAGE_NAME, names,
            f"AC1 -- run_install's envelope must report a "
            f"{FLEET_STAGE_NAME!r} stage; stages={stages} warnings={warnings}")
        fleet = next(s for s in stages if s["name"] == FLEET_STAGE_NAME)
        self.assertTrue(
            fleet["path"].endswith(os.sep + CLIENTS_DIRNAME),
            f"AC1 -- the {FLEET_STAGE_NAME!r} stage's path must end "
            f"{os.sep + CLIENTS_DIRNAME!r} (the laid-down fleet directory the "
            f"manifest anchors on); got {fleet['path']!r}")
        self.assertTrue(
            ok,
            f"an install whose only stub is [server] must be ok:true; "
            f"warnings={warnings}")


class FleetStageLandsTheEightFilesTest(_ScratchInstallCase):
    """AC2 -- after a real `run_install`, `<target-dir>/clients/` holds exactly
    the eight packaged files, each byte-identical to its source."""

    def setUp(self):
        super().setUp()
        self.ok, self.stages, self.warnings = \
            self.run_install_with_stubbed_server()

    def test_the_clients_directory_is_created_under_the_target_dir(self):
        self.assertTrue(
            os.path.isdir(self.clients_dir()),
            f"AC2 -- run_install must CREATE {self.clients_dir()!r}; nothing "
            f"in crucible_axi materialises it today, which is why all six "
            f"manifest paths dangle. ok={self.ok} stages={self.stages} "
            f"warnings={self.warnings}")

    def test_exactly_the_eight_packaged_files_land_with_no_extras(self):
        if not os.path.isdir(self.clients_dir()):
            self.fail(
                f"AC2 -- {self.clients_dir()!r} does not exist at all, so the "
                f"fleet never landed; ok={self.ok} stages={self.stages} "
                f"warnings={self.warnings}")
        landed = set(os.listdir(self.clients_dir()))
        self.assertEqual(
            landed, set(EXPECTED_FLEET_FILES),
            f"AC2 -- <target-dir>/clients/ must hold EXACTLY the eight "
            f"packaged files (five clients + the two shared modules they load "
            f"by path + STATUS-CONTRACT.md), no extras. "
            f"missing={sorted(set(EXPECTED_FLEET_FILES) - landed)} "
            f"unexpected={sorted(landed - set(EXPECTED_FLEET_FILES))}")

    def test_every_landed_file_is_byte_identical_to_its_source(self):
        """Bytes, not sizes: a truncated, re-encoded or template-substituted
        copy is exactly the corruption a size or existence check waves
        through."""
        if not os.path.isdir(self.clients_dir()):
            self.fail(
                f"AC2 -- {self.clients_dir()!r} does not exist, so there is "
                f"nothing to compare; warnings={self.warnings}")
        mismatched = []
        for name in sorted(EXPECTED_FLEET_FILES):
            source = SOURCE_CLIENTS_DIR / name
            self.assertTrue(
                source.is_file(),
                f"fixture invariant -- the source fleet file {source} must "
                f"exist in the repo checkout")
            landed = Path(self.clients_dir()) / name
            if not landed.is_file():
                mismatched.append(f"{name}: absent")
                continue
            if landed.read_bytes() != source.read_bytes():
                mismatched.append(
                    f"{name}: {len(landed.read_bytes())} bytes landed vs "
                    f"{len(source.read_bytes())} bytes at source")
        self.assertEqual(
            mismatched, [],
            f"AC2 -- every landed file must be BYTE-IDENTICAL to its source "
            f"under {SOURCE_CLIENTS_DIR}; offenders={mismatched}")

    def test_landed_clients_compare_equal_shallow_false_against_source(self):
        """The same guarantee through `filecmp` with `shallow=False`, so the
        comparison is content-based even where mtime/size coincide."""
        if not os.path.isdir(self.clients_dir()):
            self.fail(
                f"AC2 -- {self.clients_dir()!r} does not exist; "
                f"warnings={self.warnings}")
        match, mismatch, errors = filecmp.cmpfiles(
            str(SOURCE_CLIENTS_DIR), self.clients_dir(),
            sorted(EXPECTED_FLEET_FILES), shallow=False)
        self.assertEqual(
            (sorted(mismatch), sorted(errors)), ([], []),
            f"AC2 -- filecmp must report every one of the eight files as a "
            f"content MATCH; mismatch={sorted(mismatch)} "
            f"errors={sorted(errors)} matched={sorted(match)}")


class FleetBeforeManifestIsEnforcedTest(_ScratchInstallCase):
    """AC6 -- ordering is enforced by `STAGE_ORDER` + the fail-fast contract,
    not incidental: a failing `fleet` stage must stop `manifest` from writing a
    manifest that names paths nothing laid down."""

    def test_a_raising_fleet_stage_prevents_the_manifest_stage_entirely(self):
        reached = []

        def exploding_fleet_stage(target_dir, force):
            reached.append(FLEET_STAGE_NAME)
            raise RuntimeError("fleet stage boom")

        with mock.patch.dict(
                self.install.DEFAULT_STAGE_RUNNERS,
                {"server": _fast_provision_server_stage,
                 FLEET_STAGE_NAME: exploding_fleet_stage}):
            ok, stages, warnings = self.install.run_install(self.target)

        names = [s["name"] for s in stages]

        self.assertNotIn(
            MANIFEST_STAGE_NAME, names,
            f"AC6 -- the {MANIFEST_STAGE_NAME!r} stage must NOT run after "
            f"{FLEET_STAGE_NAME!r} failed (fail-fast); stages={stages}")
        self.assertFalse(
            os.path.exists(self.manifest_path()),
            f"AC6 -- no {MANIFEST_FILENAME} may exist once "
            f"{FLEET_STAGE_NAME!r} failed: a manifest written here would name "
            f"six paths that were never laid down (the 0.1.2 defect, now "
            f"structural); found {self.manifest_path()!r}")
        self.assertFalse(
            ok,
            f"AC6 -- a failing {FLEET_STAGE_NAME!r} stage must surface as "
            f"ok:false; stages={stages} warnings={warnings}")
        self.assertEqual(
            reached, [FLEET_STAGE_NAME],
            f"AC6 -- the {FLEET_STAGE_NAME!r} runner must actually be invoked "
            f"by run_install (it is only reached when {FLEET_STAGE_NAME!r} is "
            f"in STAGE_ORDER={self.install.STAGE_ORDER!r}); reached={reached!r}")

    def test_the_stage_failed_warning_names_the_fleet_stage(self):
        def exploding_fleet_stage(target_dir, force):
            raise RuntimeError("fleet stage boom")

        with mock.patch.dict(
                self.install.DEFAULT_STAGE_RUNNERS,
                {"server": _fast_provision_server_stage,
                 FLEET_STAGE_NAME: exploding_fleet_stage}):
            ok, stages, warnings = self.install.run_install(self.target)

        stage_failures = [
            w for w in warnings if w.get("code") == STAGE_FAILED_CODE]
        self.assertTrue(
            stage_failures,
            f"AC6 -- the failure must be recorded VISIBLY as a "
            f"{STAGE_FAILED_CODE!r} warning, never swallowed; "
            f"warnings={warnings}")
        self.assertTrue(
            any(FLEET_STAGE_NAME in str(w.get("detail", ""))
                for w in stage_failures),
            f"AC6 -- a {STAGE_FAILED_CODE!r} warning must NAME the "
            f"{FLEET_STAGE_NAME!r} stage so the operator knows which stage "
            f"halted the install; warnings={warnings}")


if __name__ == "__main__":
    unittest.main()
