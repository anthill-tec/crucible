"""CR-CRU-090 C6 (AC8) -- the INTEGRATION guard: the real `crucible-axi
install` entry point, end to end, on disk.

This file is deliberately its own module: it is the CR's NAMED integration
test, the one a merge sign-off cites, so it must be trivially findable rather
than buried among the fleet stage's unit contracts.

What separates it from every other CR-CRU-090 test: nothing here calls
`install.run_install`. Every assertion is driven through
`cli.main(["install", "--target-dir", <scratch>])` -- the production seam
`main` -> `_build_parser()` -> `cmd_install(args)` -> `run_install(...)` ->
printed TOON-AXI envelope -> exit code. The 0.1.2 defect was not a broken
stage; it was a call path that materialised nothing while a manifest published
six paths into the void. A stage tested in isolation cannot see that. Only the
entry point can.

The six guards, each an entry-point observation:

- The exit code plus the WIRING: `cli.main` returns 0 and the target dir it was
  ASKED for is the one that ends up holding both `clients/` and the manifest.
- AC2 through the entry point: `<target-dir>/clients/` holds EXACTLY the eight
  packaged files, each byte-identical to `manifest.source_clients_dir()`'s
  copy. Bytes, never sizes -- a truncated copy passes a size check.
- AC3 through the entry point: the manifest ACTUALLY WRITTEN at
  `<target-dir>/crucible-clients.json` publishes six paths that all exist, are
  readable, are non-empty, and are anchored under the requested target. This is
  the assertion that fails on 0.1.2, and it is the definitive proof of the call
  path: the file it reads exists only if `args.target_dir` reached
  `run_install`, and its contents resolve only if `fleet` ran before
  `manifest`.
- Ordering is proved from the OPERATOR-VISIBLE artifact: the envelope
  `cmd_install` prints names the `fleet` stage, and names it before `manifest`.
  The assertion is on the printed text's order, not on `run_install`'s return
  value -- what the operator sees is the contract.
- `--target-dir` is really honoured: `$HOME` is pinned to a scratch dir for the
  duration of every test, and the DEFAULT target (`~/.crucible`) must stay
  absent. The operator's real `~/.crucible` is never touched by this file.
- A second invocation converges, and `--force` re-copies. Note the shape of
  this one: `cmd_install` publishes only `{name, path}` (plus the `[server]`
  stage's `bun`) per stage row, so `converged` is NOT a field of the printed
  envelope. At the entry point convergence is therefore observable as the
  ABSENCE OF A REWRITE -- the eight files' mtimes survive the second run and
  move under `--force`. Backdating to a sentinel mtime first makes that
  independent of filesystem clock resolution. Kept light on purpose: cycle 264
  owns the deep convergence contract; this is only its entry-point echo.

The `[server]` stage is ALWAYS stubbed, via
`mock.patch.dict(install.DEFAULT_STAGE_RUNNERS, ...)`: the real one runs
`bun add -g` and provisions GLOBALLY. The `fleet` and `manifest` stages are
REAL -- that is the entire point of AC8.

Every test owns a `tempfile.mkdtemp` scratch target and a scratch `$HOME`,
both under `/tmp`, and removes them. Nothing is written inside the repo.
"""

import contextlib
import importlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]

# §S1 -- the packaged fleet, exactly. Five clients plus the two shared modules
# they load BY FILE PATH from their own directory plus the status contract the
# manifest publishes as `status`.
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

CLIENT_STACKS = ("bun", "python", "rust", "mvn", "arduino")

FLEET_STAGE_NAME = "fleet"
MANIFEST_STAGE_NAME = "manifest"
SERVER_STAGE_NAME = "server"
CLIENTS_DIRNAME = "clients"
MANIFEST_FILENAME = "crucible-clients.json"

# The default `--target-dir` the parser declares, relative to `$HOME`. Pinned
# `$HOME` makes it a scratch path; it must NEVER be created when the operator
# passed `--target-dir`.
DEFAULT_TARGET_BASENAME = ".crucible"

# A sentinel mtime well in the past (2001-09-09T01:46:40Z). Convergence is
# decided on BYTES, so backdating cannot change the verdict -- it only makes
# "was this file rewritten?" answerable without depending on clock resolution.
SENTINEL_MTIME_NS = 1_000_000_000_000_000_000


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(*module_names):
    """Import the named `crucible_axi` modules from the repo-root checkout,
    dropping any already-imported copy first, so `STAGE_ORDER`,
    `DEFAULT_STAGE_RUNNERS` and `cli._COMMANDS` read here are THIS tree's and
    never an installed wheel's. `cli` is imported last so its module-level
    `from crucible_axi import install, manifest` binds the fresh pair."""
    _ensure_repo_root_on_path()
    for name in module_names:
        sys.modules.pop(name, None)
    return tuple(importlib.import_module(name) for name in module_names)


def _fast_provision_server_stage(target_dir, force):
    """A `[server]` stage double that PROVISIONS instantly: no subprocess, no
    network, no Bun, no global `bun add -g`. Matches the `(target_dir, force)`
    runner protocol, so `_stage_options` injects nothing extra."""
    return {"path": os.path.join(target_dir, "server"), "converged": False}


def _parse_stage_rows(stdout: str) -> list[tuple[str, str]]:
    """The `stages[N]{name,path}` rows of a printed TOON-AXI install envelope,
    IN PRINTED ORDER, as `(name, path)` pairs.

    Reads only what the operator reads. The tabular header declares the field
    order, and each row is `name,path` -- so the returned list's order IS the
    order the envelope presents the stages in.
    """
    lines = stdout.splitlines()
    header = next(
        (i for i, line in enumerate(lines)
         if line.strip().startswith("stages[")),
        None,
    )
    if header is None:
        return []
    rows = []
    for line in lines[header + 1:]:
        if not line.startswith("    "):  # dedent ends the tabular block
            break
        name, _, path = line.strip().partition(",")
        if not path:
            break
        rows.append((name, path))
    return rows


class _CliInstallCase(unittest.TestCase):
    """Shared fixture: a throwaway target dir, a pinned throwaway `$HOME`, the
    `[server]` stage stubbed, and every invocation made through `cli.main`."""

    def setUp(self):
        self.install, self.manifest, self.cli = _import_fresh(
            "crucible_axi.install", "crucible_axi.manifest", "crucible_axi.cli")
        self.target = tempfile.mkdtemp(prefix="cr090-cli-target-")
        self.addCleanup(shutil.rmtree, self.target, ignore_errors=True)
        # Pin $HOME so the parser's `~/.crucible` default resolves inside the
        # scratch, never the operator's real home. Held for the whole test.
        self.home = tempfile.mkdtemp(prefix="cr090-cli-home-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        home_patch = mock.patch.dict(os.environ, {"HOME": self.home})
        home_patch.start()
        self.addCleanup(home_patch.stop)

    def clients_dir(self) -> str:
        return os.path.join(self.target, CLIENTS_DIRNAME)

    def manifest_path(self) -> str:
        return os.path.join(self.target, MANIFEST_FILENAME)

    def default_target(self) -> str:
        """The `--target-dir` default the parser declares, under pinned $HOME."""
        return os.path.join(self.home, DEFAULT_TARGET_BASENAME)

    def source_clients_dir(self) -> str:
        return self.manifest.source_clients_dir()

    def run_cli_install(self, *extra_argv) -> tuple[int, str]:
        """Drive the PRODUCTION entry point and return `(exit_code, stdout)`.

        Only the `[server]` stage is stubbed -- `fleet` and `manifest` are the
        real runners. Stdout is captured so the envelope does not pollute the
        test runner's output and can be quoted in failure messages.
        """
        argv = ["install", "--target-dir", self.target, *extra_argv]
        buffer = io.StringIO()
        with mock.patch.dict(self.install.DEFAULT_STAGE_RUNNERS,
                             {SERVER_STAGE_NAME: _fast_provision_server_stage}):
            with contextlib.redirect_stdout(buffer):
                code = self.cli.main(argv)
        return code, buffer.getvalue()

    def assertFleetLanded(self, stdout):
        """The eight files are on disk under the REQUESTED target -- asserted
        as a precondition wherever a later step would otherwise crash on a
        missing path, so the failure names the defect instead of raising
        FileNotFoundError."""
        clients_dir = self.clients_dir()
        self.assertTrue(
            os.path.isdir(clients_dir),
            f"AC2/AC8 -- {clients_dir} does not exist: `cli.main install "
            f"--target-dir` laid NO fleet down under the target it was given. "
            f"envelope:\n{stdout}")
        landed = set(os.listdir(clients_dir))
        self.assertEqual(
            EXPECTED_FLEET_FILES, landed,
            f"AC2/AC8 -- <target-dir>/clients/ must hold EXACTLY the eight "
            f"packaged fleet files after `cli.main install`. "
            f"missing={sorted(EXPECTED_FLEET_FILES - landed)} "
            f"unexpected={sorted(landed - EXPECTED_FLEET_FILES)}. "
            f"envelope:\n{stdout}")

    def fleet_mtimes(self) -> dict[str, int]:
        return {
            name: os.stat(os.path.join(self.clients_dir(), name)).st_mtime_ns
            for name in sorted(EXPECTED_FLEET_FILES)
        }

    def backdate_fleet(self):
        """Stamp every laid-down file with the sentinel mtime, so a rewrite on
        the next run is detectable regardless of filesystem clock resolution."""
        for name in EXPECTED_FLEET_FILES:
            os.utime(os.path.join(self.clients_dir(), name),
                     ns=(SENTINEL_MTIME_NS, SENTINEL_MTIME_NS))

    def assertCliOk(self, code, stdout, argv_note=""):
        self.assertEqual(
            0, code,
            f"AC8 -- `crucible-axi install --target-dir <scratch>"
            f"{argv_note}` must exit 0 through cli.main with only the "
            f"[server] stage stubbed; got {code}. envelope:\n{stdout}")


class CliMainInstallWiringTest(_CliInstallCase):
    """AC8 -- the CALL PATH: `cli.main` returns 0 and the target dir it was
    asked for is the one that ends up populated."""

    def test_cli_main_install_returns_zero_and_populates_the_requested_target(self):
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        self.assertTrue(
            os.path.isdir(self.clients_dir()),
            f"AC8 -- cli.main must lay the fleet down under the "
            f"--target-dir it was GIVEN; {self.clients_dir()} is absent, so "
            f"args.target_dir never reached run_install (or no stage "
            f"materialises it). envelope:\n{stdout}")
        self.assertTrue(
            os.path.isfile(self.manifest_path()),
            f"AC8 -- the manifest must be written into the GIVEN "
            f"--target-dir; {self.manifest_path()} is absent. "
            f"envelope:\n{stdout}")

    def test_cli_main_install_emits_exactly_one_ok_install_envelope(self):
        """The operator-visible contract of the entry point: one envelope, verb
        `install`, `ok: true` -- the only thing a caller of the console script
        can observe besides the exit code."""
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        self.assertEqual(
            1, stdout.count("verb: install"),
            f"AC8 -- cmd_install must emit EXACTLY ONE `install` envelope on "
            f"stdout; envelope:\n{stdout}")
        self.assertIn(
            "ok: true", stdout,
            f"AC8 -- the printed envelope must report ok: true when every "
            f"stage ran; envelope:\n{stdout}")


class CliMainInstallFleetBytesTest(_CliInstallCase):
    """AC2, through the entry point -- exactly the eight packaged files land
    under `<target-dir>/clients/`, byte-identical to their source."""

    def test_cli_main_install_lands_exactly_the_eight_fleet_files(self):
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        self.assertFleetLanded(stdout)

    def test_cli_main_install_lands_each_fleet_file_byte_identical(self):
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        source_dir = self.source_clients_dir()
        for name in sorted(EXPECTED_FLEET_FILES):
            source = Path(source_dir) / name
            landed = Path(self.clients_dir()) / name
            self.assertTrue(
                landed.is_file(),
                f"AC2/AC8 -- {name} did not land at {landed}. "
                f"envelope:\n{stdout}")
            self.assertEqual(
                source.read_bytes(), landed.read_bytes(),
                f"AC2/AC8 -- {name} must be BYTE-IDENTICAL to its source "
                f"{source}; a size- or mtime-based copy would pass a "
                f"truncated file. source={source.stat().st_size}B "
                f"landed={landed.stat().st_size}B. envelope:\n{stdout}")


class CliMainInstallManifestResolvesTest(_CliInstallCase):
    """AC3, through the entry point -- THE definitive call-path proof.

    The manifest read here is the one `cmd_install` actually caused to be
    written, at the target dir the CLI was actually given, and every path it
    publishes must resolve. It is the assertion that fails on 0.1.2, and it
    cannot pass unless: `args.target_dir` reached `run_install`, the `fleet`
    stage ran, and it ran BEFORE `manifest`.
    """

    def test_cli_main_install_publishes_a_manifest_whose_six_paths_all_resolve(self):
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        self.assertTrue(
            os.path.isfile(self.manifest_path()),
            f"AC3/AC8 -- no manifest at {self.manifest_path()}; the CLI "
            f"either ignored --target-dir or never ran [manifest]. "
            f"envelope:\n{stdout}")
        document = json.loads(
            Path(self.manifest_path()).read_text(encoding="utf-8"))
        clients = document.get("clients", {})
        self.assertEqual(
            set(CLIENT_STACKS), set(clients),
            f"AC3/AC8 -- the manifest must publish all five stacks; "
            f"got {sorted(clients)}. envelope:\n{stdout}")
        published = [clients[stack] for stack in CLIENT_STACKS]
        published.append(document.get("status"))
        self.assertEqual(
            6, len(published),
            f"AC3/AC8 -- six published paths expected (five clients + "
            f"status); got {published!r}. envelope:\n{stdout}")
        anchor = self.clients_dir() + os.sep
        for path in published:
            self.assertTrue(
                isinstance(path, str) and path.startswith(anchor),
                f"AC3/AC8 -- every published path must be anchored under the "
                f"REQUESTED target's clients dir {anchor!r}; got {path!r}. "
                f"A path elsewhere means the CLI installed somewhere other "
                f"than the --target-dir it was given. envelope:\n{stdout}")
            self.assertTrue(
                os.path.exists(path),
                f"AC3/AC8 -- the manifest publishes {path!r}, which does NOT "
                f"exist: the 0.1.2 defect, now seen from the production entry "
                f"point. envelope:\n{stdout}")
            self.assertTrue(
                os.path.isfile(path),
                f"AC3/AC8 -- published path {path!r} is not a regular file. "
                f"envelope:\n{stdout}")
            self.assertGreater(
                os.path.getsize(path), 0,
                f"AC3/AC8 -- published path {path!r} is EMPTY; an existing "
                f"but empty file is as dead a feed as a missing one. "
                f"envelope:\n{stdout}")
            self.assertTrue(
                os.access(path, os.R_OK),
                f"AC3/AC8 -- published path {path!r} is not readable. "
                f"envelope:\n{stdout}")


class CliMainInstallEnvelopeOrderTest(_CliInstallCase):
    """AC1/AC8 -- the ordering the OPERATOR sees. Asserted on the printed
    envelope's stage rows, never on `run_install`'s return value."""

    def test_printed_envelope_names_the_fleet_stage_with_the_clients_path(self):
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        rows = dict(_parse_stage_rows(stdout))
        self.assertIn(
            FLEET_STAGE_NAME, rows,
            f"AC1/AC8 -- the printed envelope must name a {FLEET_STAGE_NAME!r} "
            f"stage; rows={sorted(rows)}. envelope:\n{stdout}")
        self.assertTrue(
            rows[FLEET_STAGE_NAME].endswith("/" + CLIENTS_DIRNAME),
            f"AC1/AC8 -- the printed {FLEET_STAGE_NAME!r} row's path must end "
            f"/{CLIENTS_DIRNAME}; got {rows[FLEET_STAGE_NAME]!r}. "
            f"envelope:\n{stdout}")

    def test_printed_envelope_names_fleet_before_manifest(self):
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        names = [name for name, _ in _parse_stage_rows(stdout)]
        self.assertIn(
            FLEET_STAGE_NAME, names,
            f"AC1/AC8 -- printed stage rows carry no {FLEET_STAGE_NAME!r}; "
            f"names={names}. envelope:\n{stdout}")
        self.assertIn(MANIFEST_STAGE_NAME, names)
        self.assertLess(
            names.index(FLEET_STAGE_NAME), names.index(MANIFEST_STAGE_NAME),
            f"AC1/AC8 -- the envelope the operator reads must present "
            f"{FLEET_STAGE_NAME!r} BEFORE {MANIFEST_STAGE_NAME!r}: the paths "
            f"are laid down before they are published. names={names}. "
            f"envelope:\n{stdout}")


class CliMainInstallTargetDirHonouredTest(_CliInstallCase):
    """AC8 -- `--target-dir` is really honoured: the DEFAULT target
    (`~/.crucible`, resolved under a pinned scratch `$HOME`) stays absent."""

    def test_default_home_crucible_target_is_never_created(self):
        self.assertFalse(
            os.path.exists(self.default_target()),
            "fixture -- the scratch $HOME must start without .crucible")
        code, stdout = self.run_cli_install()
        self.assertCliOk(code, stdout)
        self.assertFalse(
            os.path.exists(self.default_target()),
            f"AC8 -- `install --target-dir <scratch>` must write NOTHING to "
            f"the parser's default target; {self.default_target()} was "
            f"created, which on an operator's machine is their real "
            f"~/.crucible. envelope:\n{stdout}")
        self.assertTrue(
            os.path.isdir(self.clients_dir()),
            f"AC8 -- and the fleet must have landed under the requested "
            f"target instead. envelope:\n{stdout}")


class CliMainInstallSecondRunTest(_CliInstallCase):
    """AC5/AC8 -- the entry-point echo of convergence. `cmd_install` prints
    only `{name, path}` per stage, so `converged` is not an envelope field;
    at this level convergence IS the absence of a rewrite."""

    def test_second_cli_main_install_rewrites_nothing(self):
        first_code, first_stdout = self.run_cli_install()
        self.assertCliOk(first_code, first_stdout)
        self.assertFleetLanded(first_stdout)
        self.backdate_fleet()
        before = self.fleet_mtimes()

        second_code, second_stdout = self.run_cli_install()
        self.assertCliOk(second_code, second_stdout, argv_note=" (2nd run)")
        self.assertIn(
            FLEET_STAGE_NAME, dict(_parse_stage_rows(second_stdout)),
            f"AC8 -- the second invocation must still report the "
            f"{FLEET_STAGE_NAME!r} stage. envelope:\n{second_stdout}")
        self.assertEqual(
            before, self.fleet_mtimes(),
            f"AC5/AC8 -- a second `cli.main install` over an unchanged target "
            f"must CONVERGE: bytes already match, so not one of the eight "
            f"files is rewritten. envelope:\n{second_stdout}")

    def test_force_re_copies_all_eight_through_the_entry_point(self):
        first_code, first_stdout = self.run_cli_install()
        self.assertCliOk(first_code, first_stdout)
        self.assertFleetLanded(first_stdout)
        self.backdate_fleet()
        before = self.fleet_mtimes()

        force_code, force_stdout = self.run_cli_install("--force")
        self.assertCliOk(force_code, force_stdout, argv_note=" --force")
        after = self.fleet_mtimes()
        unchanged = sorted(name for name in before if before[name] == after[name])
        self.assertEqual(
            [], unchanged,
            f"AC5/AC8 -- `--force` through the entry point must re-copy ALL "
            f"eight files unconditionally; these were left alone: "
            f"{unchanged}. envelope:\n{force_stdout}")


if __name__ == "__main__":
    unittest.main()
