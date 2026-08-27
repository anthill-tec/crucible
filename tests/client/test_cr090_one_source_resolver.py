"""CR-CRU-090 C5 (§S2, AC7) -- ONE locus for the source clients directory.

§S2: "`cli.py` privately owns `_CLIENTS_CANDIDATES` / `_clients_dir()` (source
checkout first, installed package data second). Expose that resolution once as
`manifest.source_clients_dir()` and have BOTH `cli.py` and the new `fleet`
stage call it. No second copy of the candidate list."

Today there are TWO resolvers and no shared one:

- `crucible_axi/cli.py` -- `_HERE`, `_CLIENTS_CANDIDATES`, `_clients_dir()`,
  consumed by `_load_client_module()`;
- `crucible_axi/install.py` -- its own `_HERE`, `_CLIENTS_CANDIDATES`,
  `_source_clients_dir()`, consumed by `run_fleet_stage`. Its comment dates the
  duplication to this very step: `cli` imports `install`, so `install` cannot
  import `cli` back, and C1 mirrored the block rather than invert that edge.

`manifest` is the resolver's home precisely because it breaks that cycle:
`install` already imports `manifest`, and `cli` can, so neither has to import
the other.

WHY NOT AC7 AS LITERALLY WRITTEN. AC7 says `grep -c "installed package data"
crucible_axi/*.py` is 1. That check is unmeasurable and vacuous: `grep -c` over
a glob prints one count PER FILE (never a single number to compare), and that
comment string already occurs exactly once per file today, so the assertion
passes with both resolvers still in place and nothing moved. The BEHAVIOURAL
contract AC7 is reaching for is what this file encodes instead:

1. `manifest.source_clients_dir()` exists and is THE resolver;
2. BOTH consumers go through it -- proven by monkeypatching that one function
   and observing BOTH behaviours change, which a private copy cannot do;
3. neither `cli` nor `install` still defines a private candidate list or
   resolver (`hasattr` on the imported modules -- behaviourally meaningful,
   unlike a grep over source text: an attribute that is gone cannot be called);
4. the resolution ORDER survives the move -- repo checkout first, wheel package
   data second, falling back to the checkout path so a failure names the
   location an operator expects.

The two "gone" assertions and the two "routes through it" assertions are what
makes this a real refactor gate rather than an additive one: adding
`manifest.source_clients_dir()` while leaving either private copy wired up
still fails here.

NOT this cycle (owned elsewhere in plan 89): the `cli.main()` integration
(AC8, C6) and the fleet stage's copy/convergence behaviour (C1/C2, already
green in `test_cr090_fleet_stage.py`).

Nothing here touches the real `~/.crucible`, the repo's own `clients/`, or the
`[server]` stage -- `run_fleet_stage` is called directly, sourcing from and
landing in `tempfile.mkdtemp` scratch dirs only.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from crucible_axi import cli, install, manifest

# The two candidates §S2 preserves, derived from the PACKAGE's own location
# rather than from any module-private tuple -- so the assertion survives the
# private tuples being deleted, which is the point of the cycle.
_PACKAGE_DIR = os.path.dirname(os.path.abspath(manifest.__file__))
CHECKOUT_CANDIDATE = os.path.join(os.path.dirname(_PACKAGE_DIR), "clients")
PACKAGE_DATA_CANDIDATE = os.path.join(_PACKAGE_DIR, "clients")

_REAL_ISDIR = os.path.isdir


def _isdir_over(existing):
    """A drop-in `os.path.isdir` for which EXACTLY `existing` are directories.

    Scoped to the resolver's own two candidates; every other path defers to the
    real `os.path.isdir`, so patching it cannot disturb unrelated code that
    happens to run inside the `with` block.
    """
    wanted = {os.path.realpath(path) for path in existing}
    candidates = {os.path.realpath(CHECKOUT_CANDIDATE),
                  os.path.realpath(PACKAGE_DATA_CANDIDATE)}

    def fake_isdir(path):
        real = os.path.realpath(path)
        if real in candidates:
            return real in wanted
        return _REAL_ISDIR(path)

    return fake_isdir


class OneSourceResolverTest(unittest.TestCase):
    """§S2/AC7 -- `manifest.source_clients_dir()` is the single resolver, and
    both `cli` and the `fleet` stage go through it."""

    def setUp(self):
        self._scratch = []

    def tearDown(self):
        for path in self._scratch:
            shutil.rmtree(path, ignore_errors=True)

    def _mkdtemp(self, suffix):
        path = tempfile.mkdtemp(prefix="cr090-c5-", suffix=suffix)
        self._scratch.append(path)
        return path

    def _resolver(self):
        """The shared resolver, or a crisp failure naming what §S2 asks for.

        Guarded rather than patched blind: `mock.patch.object` on a missing
        attribute raises a bare `AttributeError`, which reads as a broken test
        instead of the unmet contract it actually is.
        """
        self.assertTrue(
            hasattr(manifest, "source_clients_dir"),
            "§S2/AC7: `crucible_axi.manifest` must expose `source_clients_dir()` "
            "as THE single source-clients-dir resolver; it has no such attribute, "
            "so `cli` and `install` each still resolve the fleet privately.")
        return manifest.source_clients_dir

    def _patched_resolver(self, directory):
        self._resolver()
        return mock.patch.object(
            manifest, "source_clients_dir", return_value=directory)

    # -- 1. the resolver exists and resolves ------------------------------

    def test_source_clients_dir_resolves_a_directory_holding_the_whole_fleet(self):
        """§S2: the one resolver returns a REAL directory with all eight files.

        Existence of the function is not the contract -- resolving to somewhere
        the `fleet` stage can actually copy the eight files FROM is.
        """
        resolver = self._resolver()
        resolved = resolver()

        self.assertTrue(
            os.path.isdir(resolved),
            f"§S2: `manifest.source_clients_dir()` must resolve an existing "
            f"source fleet directory; it returned {resolved!r}, which is not a "
            f"directory.")
        missing = sorted(name for name in install.FLEET_FILES
                         if not os.path.isfile(os.path.join(resolved, name)))
        self.assertEqual(
            missing, [],
            f"§S2: the resolved source dir {resolved!r} is missing packaged "
            f"fleet files {missing} -- the `fleet` stage copies FROM here, so a "
            f"gap makes the laydown impossible.")

    # -- 2. resolution ORDER is preserved by the move ----------------------

    def test_checkout_candidate_wins_when_both_candidates_exist(self):
        """§S2 "source checkout first, installed package data second".

        Driven by patching `os.path.isdir`, never by moving real directories:
        the repo's own `clients/` is production data for the rest of the suite.
        """
        resolver = self._resolver()
        with mock.patch("os.path.isdir",
                        side_effect=_isdir_over([CHECKOUT_CANDIDATE,
                                                 PACKAGE_DATA_CANDIDATE])):
            resolved = resolver()

        self.assertEqual(
            os.path.realpath(resolved), os.path.realpath(CHECKOUT_CANDIDATE),
            f"§S2: with BOTH candidates present the source checkout "
            f"{CHECKOUT_CANDIDATE!r} must win over the wheel's package data "
            f"{PACKAGE_DATA_CANDIDATE!r}; got {resolved!r}. A developer running "
            f"from a checkout must copy the checkout's fleet, not a stale "
            f"installed one.")

    def test_package_data_candidate_is_used_when_only_it_exists(self):
        """§S2: the second candidate is really consulted -- the installed-wheel
        case, where no repo checkout sits beside the package."""
        resolver = self._resolver()
        with mock.patch("os.path.isdir",
                        side_effect=_isdir_over([PACKAGE_DATA_CANDIDATE])):
            resolved = resolver()

        self.assertEqual(
            os.path.realpath(resolved),
            os.path.realpath(PACKAGE_DATA_CANDIDATE),
            f"§S2: with only the wheel's force-included package data present, "
            f"the resolver must return {PACKAGE_DATA_CANDIDATE!r}; got "
            f"{resolved!r}. Installed users have no checkout beside the package.")

    def test_falls_back_to_the_checkout_candidate_when_neither_exists(self):
        """§S2: with nothing on disk the resolver still names the checkout path
        -- so the resulting failure names the location an operator expects,
        rather than an opaque interpreter-internal package path."""
        resolver = self._resolver()
        with mock.patch("os.path.isdir", side_effect=_isdir_over([])):
            resolved = resolver()

        self.assertEqual(
            os.path.realpath(resolved), os.path.realpath(CHECKOUT_CANDIDATE),
            f"§S2: with NEITHER candidate present the resolver must fall back "
            f"to the source-checkout candidate {CHECKOUT_CANDIDATE!r} so the "
            f"error names where an operator expects the fleet; got {resolved!r}.")

    # -- 3. the `fleet` stage sources through it ---------------------------

    def test_fleet_stage_sources_through_the_shared_resolver(self):
        """§S2: `install.run_fleet_stage` must not resolve the source itself.

        Proven by redirecting ONLY `manifest.source_clients_dir` at a scratch
        dir of distinctively-contented stand-ins and reading the LANDED bytes:
        if the stage still consults a private candidate list, it copies the
        repo's real fleet and the stand-in bytes never appear.
        """
        source = self._mkdtemp("-src")
        target = self._mkdtemp("-dst")
        expected = {}
        for name in install.FLEET_FILES:
            body = f"CR-CRU-090 C5 stand-in for {name}\n".encode("utf-8")
            Path(source, name).write_bytes(body)
            expected[name] = body

        with self._patched_resolver(source):
            result = install.run_fleet_stage(target)

        landed_dir = Path(target, install.FLEET_DIRNAME)
        landed = {}
        for name in install.FLEET_FILES:
            path = landed_dir / name
            self.assertTrue(
                path.is_file(),
                f"§S2: `run_fleet_stage` did not lay {name} down from the "
                f"redirected source {source!r} -- result was {result!r}.")
            landed[name] = path.read_bytes()

        self.assertEqual(
            landed, expected,
            "§S2: the bytes `run_fleet_stage` landed are not the stand-ins' "
            f"from {source!r}, so the stage resolved the source clients dir "
            "ITSELF instead of calling `manifest.source_clients_dir()`.")

    # -- 4. `cli` loads clients through it ---------------------------------

    def test_cli_loads_client_modules_through_the_shared_resolver(self):
        """§S2: `cli`'s by-path client loading must go through the one resolver.

        The seam asserted on is `cli._load_client_module`, which is private but
        is the ONLY consumer of `cli._clients_dir()` and the exact call
        `cmd_install` makes (`_load_client_module("_crucible_axi")`) to get the
        envelope emitter. Driving `cmd_install` instead would prove the same
        thing while dragging a full `run_install` (and the GLOBAL `bun add -g`
        `[server]` stage) in with it, so the loader is exercised directly and
        the observable result -- WHICH file the loaded module came from -- is
        what is asserted.
        """
        source = self._mkdtemp("-cli-src")
        Path(source, "_crucible_axi.py").write_text(
            'MARKER = "cr090-c5-standin"\n', encoding="utf-8")

        with self._patched_resolver(source):
            module = cli._load_client_module("_crucible_axi")

        self.assertEqual(
            getattr(module, "MARKER", None), "cr090-c5-standin",
            f"§S2: `cli._load_client_module` did not load the stand-in from the "
            f"redirected {source!r} -- it still resolves the clients dir "
            f"privately instead of calling `manifest.source_clients_dir()`. "
            f"Loaded module came from {getattr(module, '__file__', None)!r}.")
        self.assertEqual(
            os.path.realpath(os.path.dirname(module.__file__)),
            os.path.realpath(source),
            f"§S2: `cli` loaded a client module from "
            f"{os.path.dirname(module.__file__)!r}, not from the resolver's "
            f"answer {source!r}.")

    # -- 5. the private duplicates are GONE --------------------------------

    def test_cli_holds_no_private_clients_resolver(self):
        """§S2 "No second copy of the candidate list" -- for `cli`.

        `hasattr` on the imported module, not a grep: an attribute that is gone
        cannot be called by anything, which is the property that matters.
        """
        for attribute in ("_CLIENTS_CANDIDATES", "_clients_dir"):
            self.assertFalse(
                hasattr(cli, attribute),
                f"§S2/AC7: `crucible_axi.cli` must hold no private candidate "
                f"list or resolver, but `cli.{attribute}` still exists -- the "
                f"resolution has been duplicated, not moved to "
                f"`manifest.source_clients_dir()`.")

    def test_install_holds_no_private_clients_resolver(self):
        """§S2 "No second copy of the candidate list" -- for `install`, whose
        own copy C1 added with a comment dating it to this step."""
        for attribute in ("_CLIENTS_CANDIDATES", "_source_clients_dir"):
            self.assertFalse(
                hasattr(install, attribute),
                f"§S2/AC7: `crucible_axi.install` must hold no private candidate "
                f"list or resolver, but `install.{attribute}` still exists -- "
                f"C1's deliberate mirror of `cli`'s block was to be retired into "
                f"`manifest.source_clients_dir()` here.")

    # -- 6. the move must not invert the import edge -----------------------

    def test_importing_install_alone_does_not_import_cli(self):
        """§S2's reason for putting the resolver in `manifest`: `cli` imports
        `install`, so `install` importing `cli` back would be circular.

        A fresh interpreter imports `install` FIRST and alone; `cli` must not
        be dragged in. This is the regression the lazy/inline-import shortcut
        would quietly reintroduce.
        """
        probe = (
            "import sys\n"
            "import crucible_axi.install\n"
            "print('crucible_axi.cli' in sys.modules)\n"
        )
        # The package's own parent dir -- where `crucible_axi` is importable
        # from -- forced onto the child's path so the probe cannot accidentally
        # import a DIFFERENT installed copy than the one under test.
        import_root = os.path.dirname(_PACKAGE_DIR)
        child_env = dict(os.environ)
        child_env["PYTHONPATH"] = os.pathsep.join(
            [import_root] + ([child_env["PYTHONPATH"]]
                             if child_env.get("PYTHONPATH") else []))
        completed = subprocess.run(
            [sys.executable, "-c", probe],
            cwd=import_root, env=child_env,
            capture_output=True, text=True, timeout=120)

        self.assertEqual(
            completed.returncode, 0,
            f"§S2: importing `crucible_axi.install` on its own failed "
            f"(rc={completed.returncode}); stderr:\n{completed.stderr}")
        self.assertEqual(
            completed.stdout.strip(), "False",
            f"§S2: a clean `import crucible_axi.install` pulled "
            f"`crucible_axi.cli` into `sys.modules` -- the resolver must live in "
            f"`manifest`, which `install` already imports, never behind an "
            f"import of `cli`. stdout={completed.stdout!r}")


if __name__ == "__main__":
    unittest.main()
