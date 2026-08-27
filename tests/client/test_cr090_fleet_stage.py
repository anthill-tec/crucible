"""CR-CRU-090 C1 (§S1, ACs 1, 2 and 6) + C2 (§S1 "Rules", AC5) -- the `fleet`
stage: the eight client files land under `<target-dir>/clients/` BEFORE the
manifest that names them, and land only when they are actually stale.

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

C2 (§S1's "Rules" block, AC5) pins the CONVERGENCE half of the same stage: a
destination file whose bytes already match its source is not rewritten, the
stage reports `converged: True` only when ALL eight already matched, `--force`
re-copies unconditionally and reports `converged: False`, and destination files
the install does not manage are never touched.

C3 (§S3, AC3) BACKFILLS the guard the whole CR exists for: after a real
`run_install`, every path the on-disk manifest publishes resolves -- readable,
non-empty, and anchored under `<target-dir>/clients/`.

NOT this cycle (owned elsewhere in plan 89): a copied client running (AC4),
the `manifest.source_clients_dir()` single resolver (§S2/AC7), the
`cli.main()` integration (AC8).

Every test owns a `tempfile.mkdtemp` scratch target under `/tmp` and removes
it; the `[server]` stage is always stubbed to a no-subprocess provision double,
because the real one runs `bun add -g` and provisions GLOBALLY. Nothing is
written inside the repo or into `~/.crucible`.
"""

import filecmp
import importlib
import json
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


# --- CR-CRU-090 C2 (§S1 "Rules", AC5) -- convergence and `--force` ---------

# A timestamp no filesystem clock can produce incidentally: epoch + 1,000,000 s
# (1970-01-12). Pinning each landed file to this EXACT value and re-asserting
# it after a second run turns "nothing was rewritten" into a byte-exact claim
# instead of a race against mtime granularity: `shutil.copyfile` stamps its
# destination with the current time, so one rewritten file is unmissable and a
# converged one is provably untouched.
PINNED_MTIME_NS = 1_000_000 * 1_000_000_000

# A destination file that is NOT one of the eight -- the install manages the
# fleet, never the directory.
UNMANAGED_FILENAME = "operator-note.txt"
UNMANAGED_CONTENT = b"operator's own note; the install does not manage me\n"

# The two halves of the fleet the all-or-nothing rule must hold for
# identically: a client entry point and a shared module the clients load by
# file path. A convergence check keyed off filename shape or extension would
# pass one and fail the other.
TAMPERED_CLIENT_FILE = "python-crucible.py"
TAMPERED_SHARED_MODULE = "_crucible_axi.py"


class _FleetConvergenceCase(_ScratchInstallCase):
    """Fixture for §S1's convergence rules: land the fleet, pin every landed
    file's mtime into the past, then observe what a SECOND run does."""

    def fleet_stage(self, stages):
        matches = [s for s in stages if s["name"] == FLEET_STAGE_NAME]
        self.assertEqual(
            len(matches), 1,
            f"AC5 -- run_install must report exactly one {FLEET_STAGE_NAME!r} "
            f"stage to read `converged` off; stages={stages}")
        return matches[0]

    def landed_path(self, name):
        return os.path.join(self.clients_dir(), name)

    def source_bytes(self, name):
        return (SOURCE_CLIENTS_DIR / name).read_bytes()

    def land_the_fleet(self):
        """First install: the eight land. Returns the reported fleet stage."""
        ok, stages, warnings = self.run_install_with_stubbed_server()
        self.assertTrue(
            ok,
            f"fixture invariant -- the first install (only [server] stubbed) "
            f"must succeed; stages={stages} warnings={warnings}")
        return self.fleet_stage(stages)

    def reach_convergence(self):
        """Land the fleet, then run again so the target is CONVERGED -- the
        precondition the `--force` and all-or-nothing rules are measured
        against, asserted explicitly rather than assumed. On an unconditional
        copy this baseline is the first thing to fail, and that IS the
        diagnostic: with no convergence detection there is no converged state
        for `--force` to override or for a tampered file to flip."""
        self.land_the_fleet()
        ok, stages, warnings = self.run_install_with_stubbed_server()
        stage = self.fleet_stage(stages)
        self.assertTrue(
            stage["converged"],
            f"AC5 baseline -- a second, unchanged run must leave the target "
            f"CONVERGED: all eight files already match their sources "
            f"byte-for-byte, so the {FLEET_STAGE_NAME!r} stage must report "
            f"converged:True. Got {stage!r}; ok={ok} warnings={warnings}")
        return stage

    def pin_landed_mtimes(self):
        """Stamp all eight landed files with PINNED_MTIME_NS."""
        for name in sorted(EXPECTED_FLEET_FILES):
            path = self.landed_path(name)
            self.assertTrue(
                os.path.isfile(path),
                f"fixture invariant -- {name} must have landed at {path!r} "
                f"before its mtime can be pinned")
            os.utime(path, ns=(PINNED_MTIME_NS, PINNED_MTIME_NS))

    def landed_mtimes(self):
        """name -> st_mtime_ns for every one of the eight present on disk."""
        return {
            name: os.stat(self.landed_path(name)).st_mtime_ns
            for name in sorted(EXPECTED_FLEET_FILES)
            if os.path.isfile(self.landed_path(name))
        }


class FleetStageConvergesOnASecondRunTest(_FleetConvergenceCase):
    """AC5, first half -- a second run with nothing changed converges and
    rewrites nothing."""

    def test_a_second_unchanged_run_reports_the_fleet_stage_converged(self):
        self.land_the_fleet()
        ok, stages, warnings = self.run_install_with_stubbed_server()
        stage = self.fleet_stage(stages)
        self.assertTrue(
            stage["converged"],
            f"AC5 -- the second run changes nothing, so the "
            f"{FLEET_STAGE_NAME!r} stage must report converged:True, "
            f"mirroring the [manifest] stage's contract. Today the copy is "
            f"unconditional and `converged` is hard-coded False, so an "
            f"operator can never tell a no-op install from a real laydown. "
            f"Got {stage!r}; ok={ok} warnings={warnings}")

    def test_a_converged_second_run_rewrites_not_one_of_the_eight_files(self):
        """The bytes-level rule behind `converged`: a destination file whose
        bytes already match its source is NOT rewritten. Measured against a
        pinned past mtime, so the assertion cannot pass by clock luck."""
        self.land_the_fleet()
        self.pin_landed_mtimes()
        before = self.landed_mtimes()
        self.assertEqual(
            sorted(before), sorted(EXPECTED_FLEET_FILES),
            f"fixture invariant -- all eight files must be on disk and pinned "
            f"before the second run; pinned={sorted(before)}")

        ok, stages, warnings = self.run_install_with_stubbed_server()
        after = self.landed_mtimes()
        rewritten = sorted(
            name for name, mtime in after.items()
            if mtime != PINNED_MTIME_NS)

        self.assertEqual(
            rewritten, [],
            f"AC5 -- a file already byte-identical to its source must NOT be "
            f"rewritten: every landed file's mtime must still be the pinned "
            f"{PINNED_MTIME_NS} ns. rewritten={rewritten} "
            f"stage={self.fleet_stage(stages) if stages else None} "
            f"ok={ok} warnings={warnings}")


class FleetForceRecopiesUnconditionallyTest(_FleetConvergenceCase):
    """AC5, second half -- `--force` re-copies unconditionally and reports
    `converged: False`, which is only a distinguishable behaviour once
    convergence exists to be overridden."""

    def test_force_reports_non_convergence_against_a_converged_target(self):
        self.reach_convergence()
        ok, stages, warnings = self.run_install_with_stubbed_server(force=True)
        stage = self.fleet_stage(stages)
        self.assertFalse(
            stage["converged"],
            f"AC5 -- `--force` re-copies unconditionally, so it must report "
            f"converged:False even on a target that converged a moment ago; "
            f"got {stage!r}; ok={ok} warnings={warnings}")

    def test_force_rewrites_all_eight_files_it_would_otherwise_skip(self):
        self.reach_convergence()
        self.pin_landed_mtimes()

        ok, stages, warnings = self.run_install_with_stubbed_server(force=True)
        after = self.landed_mtimes()
        self.assertEqual(
            sorted(after), sorted(EXPECTED_FLEET_FILES),
            f"fixture invariant -- all eight must still be on disk after a "
            f"forced run; present={sorted(after)}")
        skipped = sorted(
            name for name, mtime in after.items()
            if mtime == PINNED_MTIME_NS)

        self.assertEqual(
            skipped, [],
            f"AC5 -- `--force` must REWRITE all eight, so not one may still "
            f"carry the pinned mtime {PINNED_MTIME_NS} ns that convergence "
            f"would have preserved; skipped={skipped} "
            f"stage={self.fleet_stage(stages) if stages else None} "
            f"ok={ok} warnings={warnings}")
        for name in sorted(EXPECTED_FLEET_FILES):
            self.assertEqual(
                Path(self.landed_path(name)).read_bytes(),
                self.source_bytes(name),
                f"AC5 -- a forced re-copy must still land {name} "
                f"byte-identical to its source")


class FleetConvergenceIsAllOrNothingTest(_FleetConvergenceCase):
    """AC5 -- `converged: True` is claimed ONLY when every one of the eight
    already matched. One stale file flips the whole stage to False and is
    restored, for a client entry point and for a shared module alike."""

    def _tamper_and_rerun(self, name):
        """Converge, corrupt exactly ONE landed file, run again; return the
        reported fleet stage."""
        self.reach_convergence()
        victim = Path(self.landed_path(name))
        victim.write_bytes(
            self.source_bytes(name) + b"\n# tampered out of band\n")
        self.assertNotEqual(
            victim.read_bytes(), self.source_bytes(name),
            f"fixture invariant -- {name} must actually differ from its "
            f"source after tampering")
        self.pin_landed_mtimes()

        ok, stages, warnings = self.run_install_with_stubbed_server()
        return self.fleet_stage(stages), ok, warnings

    def _assert_one_stale_file_breaks_convergence(self, name):
        stage, ok, warnings = self._tamper_and_rerun(name)
        self.assertFalse(
            stage["converged"],
            f"AC5 -- convergence is ALL-OR-NOTHING: with {name} no longer "
            f"matching its source, the {FLEET_STAGE_NAME!r} stage must report "
            f"converged:False, never True because the other seven matched; "
            f"got {stage!r}; ok={ok} warnings={warnings}")
        self.assertEqual(
            Path(self.landed_path(name)).read_bytes(), self.source_bytes(name),
            f"AC5 -- the stale file {name} must be RE-COPIED, restoring it "
            f"byte-identical to {SOURCE_CLIENTS_DIR / name}; a convergence "
            f"check that skips it would leave a corrupt client installed")
        self.assertNotEqual(
            os.stat(self.landed_path(name)).st_mtime_ns, PINNED_MTIME_NS,
            f"AC5 -- {name} must have been rewritten, so its pinned mtime "
            f"{PINNED_MTIME_NS} ns must be gone")
        others = sorted(
            other for other, mtime in self.landed_mtimes().items()
            if other != name and mtime != PINNED_MTIME_NS)
        self.assertEqual(
            others, [],
            f"AC5 -- only the stale file is rewritten: the seven that still "
            f"match their sources must keep the pinned mtime; "
            f"rewritten={others}")

    def test_one_tampered_client_file_flips_the_stage_to_non_converged(self):
        self._assert_one_stale_file_breaks_convergence(TAMPERED_CLIENT_FILE)

    def test_one_tampered_shared_module_flips_the_stage_to_non_converged(self):
        """The same rule for a shared module the five clients load by file
        path -- so convergence is a property of the eight, not of whatever
        subset a `*-crucible.py` shaped check happens to notice."""
        self._assert_one_stale_file_breaks_convergence(TAMPERED_SHARED_MODULE)


class UnmanagedDestinationFilesSurviveTest(_FleetConvergenceCase):
    """AC5/§S1 -- "files present in the destination but not in the source set
    are left untouched": the install never removes what it does not manage,
    and an unmanaged file is not evidence of divergence either."""

    def setUp(self):
        super().setUp()
        os.makedirs(self.clients_dir(), exist_ok=True)
        self.unmanaged = Path(
            os.path.join(self.clients_dir(), UNMANAGED_FILENAME))
        self.unmanaged.write_bytes(UNMANAGED_CONTENT)

    def test_an_unmanaged_file_survives_the_laydown_with_its_bytes_intact(self):
        self.land_the_fleet()
        self.assertTrue(
            self.unmanaged.is_file(),
            f"§S1 -- {UNMANAGED_FILENAME!r} is not one of the eight, so the "
            f"[fleet] stage must leave it alone; it is gone from "
            f"{self.clients_dir()!r} (contents="
            f"{sorted(os.listdir(self.clients_dir()))})")
        self.assertEqual(
            self.unmanaged.read_bytes(), UNMANAGED_CONTENT,
            f"§S1 -- an unmanaged destination file must keep its own bytes")

    def test_an_unmanaged_file_does_not_defeat_convergence(self):
        """The eight all match, so the stage converges -- the extra file is
        not in the source set and therefore cannot be 'divergent'."""
        self.land_the_fleet()
        self.pin_landed_mtimes()
        os.utime(self.unmanaged, ns=(PINNED_MTIME_NS, PINNED_MTIME_NS))

        ok, stages, warnings = self.run_install_with_stubbed_server()
        stage = self.fleet_stage(stages)
        self.assertTrue(
            stage["converged"],
            f"AC5 -- an unmanaged {UNMANAGED_FILENAME!r} sitting beside the "
            f"eight must not make the {FLEET_STAGE_NAME!r} stage claim "
            f"non-convergence: convergence is decided over the eight source "
            f"files only. Got {stage!r}; ok={ok} warnings={warnings}")
        self.assertEqual(
            self.unmanaged.read_bytes(), UNMANAGED_CONTENT,
            f"§S1 -- {UNMANAGED_FILENAME!r} must still hold its own bytes "
            f"after a converged run")
        self.assertEqual(
            os.stat(self.unmanaged).st_mtime_ns, PINNED_MTIME_NS,
            f"§S1 -- an unmanaged file must not even be touched by a "
            f"converged run")


# --- CR-CRU-090 C3 (§S3, AC3) -- every path the manifest publishes resolves --

# BACKFILL, not RED: the `fleet` stage (C1/C2) already lays the eight files
# down, so this guard passes on its first execution. Its worth was proved by
# MUTATION instead: with `"fleet"` removed from `install.STAGE_ORDER`, or with
# the stage skipping `STATUS-CONTRACT.md`, or with `build_manifest` publishing
# the package-internal location, or with an extra top-level manifest key, the
# class fails. That is exactly the 0.1.2 defect this CR exists for.

# §S3 -- the manifest's shape is UNCHANGED by this CR, so the guard pins it:
# these three top-level keys, no more, and exactly the five client stacks.
EXPECTED_MANIFEST_KEYS = frozenset({"version", "clients", "status"})
EXPECTED_CLIENT_STACKS = frozenset({
    "bun", "python", "rust", "mvn", "arduino",
})

# The `status` entry is published at top level, not inside `clients`; the guard
# treats it as a sixth published path with identical obligations.
STATUS_MANIFEST_KEY = "status"


class ManifestPublishedPathsResolveTest(_ScratchInstallCase):
    """AC3/§S3 -- after a REAL `run_install` (only `[server]` stubbed; `fleet`
    and `manifest` both real), every path the manifest document on disk
    publishes must be a readable, non-empty file anchored under
    `<target-dir>/clients/`.

    Read from `<target-dir>/crucible-clients.json` -- the artefact a consumer
    actually consumes -- never from `build_manifest`'s return value, which
    would only re-assert the builder against itself.

    CR-CRU-009's acceptance asked only that the manifest "exists with a stable
    schema"; that is satisfiable while all six paths dangle, which is how this
    defect shipped in 0.1.0 and survived two releases. So existence alone is
    not enough here: each path is opened and read.
    """

    def setUp(self):
        super().setUp()
        self.ok, self.stages, self.warnings = \
            self.run_install_with_stubbed_server()
        manifest_file = Path(self.manifest_path())
        self.assertTrue(
            manifest_file.exists(),
            f"AC3 -- no manifest at {manifest_file}; ok={self.ok} "
            f"stages={self.stages} warnings={self.warnings}")
        self.document = json.loads(manifest_file.read_text(encoding="utf-8"))

    def published_paths(self):
        """The six published paths, keyed by the manifest key that publishes
        each -- so a failure names the offending key, not just a path."""
        published = {
            f"clients.{stack}": path
            for stack, path in self.document.get("clients", {}).items()
        }
        published[STATUS_MANIFEST_KEY] = self.document.get(STATUS_MANIFEST_KEY)
        return published

    def test_all_six_published_paths_are_present_and_exist_on_disk(self):
        """AC3 -- the five `clients[stack]` values and `status` are present as
        manifest keys AND `os.path.exists()`. This is the assertion that fails
        on 0.1.2, where all six name package-external paths nothing created."""
        self.assertEqual(
            set(self.document.get("clients", {})), EXPECTED_CLIENT_STACKS,
            f"AC3 -- the manifest must publish exactly the five client stacks "
            f"{sorted(EXPECTED_CLIENT_STACKS)}; got "
            f"{sorted(self.document.get('clients', {}))}")
        published = self.published_paths()
        self.assertIsNotNone(
            published[STATUS_MANIFEST_KEY],
            f"AC3 -- the manifest must publish a {STATUS_MANIFEST_KEY!r} "
            f"path; document keys={sorted(self.document)}")
        missing = sorted(
            f"{key} -> {path}"
            for key, path in published.items()
            if not os.path.exists(path))
        self.assertEqual(
            [], missing,
            f"AC3 -- every path the manifest publishes must exist on disk; "
            f"{len(missing)} of {len(published)} dangle: {missing}. A "
            f"consumer reading {self.manifest_path()!r} gets a dead feed.")

    def test_every_published_path_is_a_readable_non_empty_file(self):
        """AC3 -- "exist and be readable". Existence alone was the weak
        CR-CRU-009 acceptance; a directory, an unreadable file or an empty
        stub all satisfy `exists` and are all useless to a consumer, so each
        path is stat'd, access-checked and actually read."""
        broken = []
        for key, path in sorted(self.published_paths().items()):
            if not os.path.isfile(path):
                broken.append(f"{key} -> {path}: not a regular file")
                continue
            if not os.access(path, os.R_OK):
                broken.append(f"{key} -> {path}: not readable (R_OK)")
                continue
            try:
                content = Path(path).read_bytes()
            except OSError as exc:
                broken.append(f"{key} -> {path}: unreadable ({exc})")
                continue
            if not content:
                broken.append(f"{key} -> {path}: readable but EMPTY")
        self.assertEqual(
            [], broken,
            f"AC3/§S3 -- every published path must be a readable, non-empty "
            f"file: {broken}")

    def test_every_published_path_is_anchored_under_the_target_clients_dir(self):
        """§S3 -- "consumers anchor on `<target-dir>/clients/`, never on the
        package's internal location, which moves with the interpreter". A
        manifest publishing `.../site-packages/crucible_axi/clients/...` could
        satisfy exists+readable on the build machine and still be the very
        defect this CR fixes, so the anchor is pinned separately."""
        expected_dir = os.path.realpath(self.clients_dir())
        stray = sorted(
            f"{key} -> {path}"
            for key, path in self.published_paths().items()
            if os.path.dirname(os.path.realpath(path)) != expected_dir)
        self.assertEqual(
            [], stray,
            f"§S3 -- every published path must sit directly in "
            f"{expected_dir!r} (the declared `--target-dir` anchor); "
            f"off-anchor: {stray}")

    def test_the_manifest_shape_is_unchanged_by_this_cr(self):
        """§S3 -- `build_manifest` "keeps its signature and its keys": the
        contract is tightened by TEST, not by shape. So the guard also pins
        that nothing was ADDED -- exactly `{version, clients, status}` at top
        level, `clients` a five-entry mapping of stack to string path, and a
        non-empty `version`."""
        self.assertEqual(
            EXPECTED_MANIFEST_KEYS, set(self.document),
            f"§S3 -- the manifest's top-level keys must stay exactly "
            f"{sorted(EXPECTED_MANIFEST_KEYS)} (the consumer contract is "
            f"byte-compatible; only the values become real); got "
            f"{sorted(self.document)}")
        clients = self.document["clients"]
        self.assertEqual(
            EXPECTED_CLIENT_STACKS, set(clients),
            f"§S3 -- `clients` must map exactly the five stacks; got "
            f"{sorted(clients)}")
        non_strings = sorted(
            f"clients.{stack} -> {value!r}"
            for stack, value in clients.items()
            if not isinstance(value, str))
        self.assertEqual(
            [], non_strings,
            f"§S3 -- every `clients[stack]` value must be a path string; "
            f"got {non_strings}")
        self.assertIsInstance(self.document[STATUS_MANIFEST_KEY], str)
        self.assertTrue(
            self.document["version"],
            f"§S3 -- the manifest must carry a non-empty `version`; got "
            f"{self.document['version']!r}")


if __name__ == "__main__":
    unittest.main()
