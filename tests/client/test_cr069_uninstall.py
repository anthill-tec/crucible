"""CR-CRU-069 C1 (RED) -- `crucible-axi uninstall` is the INVERSE of install.

`uninstall` appears zero times in `crucible_axi/cli.py` and
`crucible_axi/install.py`, so `uv tool uninstall crucible-axi` removes only the
Python CLI and orphans everything the install stages provisioned: the global
server package, its `crucible-server` symlink on PATH, and the client state.
These tests pin the inverse verb, one class per acceptance criterion.

The contract these tests pin (the surface GREEN must add):

* `crucible_axi.install.UNINSTALL_STAGE_ORDER` -- the stage sequence,
  `("server", "config", "store")`: DESTRUCTIVE-LAST, not a naive reverse of `STAGE_ORDER`
  (`("server", "manifest")`) with `manifest`'s inverse named `config` after the
  artifact it removes, and the store (which the SERVER creates at runtime, not
  an install stage) adjacent to its sibling data stage. `server` is the stage
  install runs FIRST, so uninstall runs it LAST.
* `crucible_axi.install.DEFAULT_UNINSTALL_STAGE_RUNNERS` -- the module-level,
  in-place-mutable stage table (`mock.patch.dict`-able), exactly as
  `DEFAULT_STAGE_RUNNERS` is for install.
* `crucible_axi.install.run_uninstall(target_dir, stage_runners=None,
  purge=False)` -> `(ok, stages, warnings)` -- the same triple, the same
  fail-fast semantics and the same `(target_dir, <switch>)` runner protocol as
  `run_install`.
* `crucible-axi uninstall [--target-dir DIR] [--purge]` -- a real subcommand
  emitting ONE TOON-AXI envelope with `verb: uninstall` and the same top-level
  envelope keys as `install`, exit 0 on ok / 1 on not-ok.
* Store resolution follows the server's own documented rule (CR-CRU-043 /
  RUNBOOK "Database path" rule 4): `$XDG_DATA_HOME/crucible`, falling back to
  `~/.local/share/crucible`. Every test below drives BOTH `$XDG_DATA_HOME` and
  `$HOME` at tmp paths, so neither resolution can reach the real store.

Isolation (no test may touch the operator's real machine):

* `$BUN_INSTALL` -> a tmp prefix. The `bun` inside it is a FAKE shell script
  whose removal branch rm's HARDCODED tmp paths, so it structurally cannot
  reach `~/.bun`, and `shutil.which` is stubbed so a bare `bun` token never
  resolves off the inherited PATH (plus `$PATH` itself points at an empty tmp
  dir). No real `bun add -g` / `bun remove -g` ever runs.
* `$XDG_DATA_HOME` and `$HOME` -> tmp dirs, so the store resolves inside tmp
  under either rule; the real `~/.local/share/crucible` is unreachable.
* `--target-dir` is ALWAYS passed explicitly, so the `~/.crucible` default is
  never used.
* AC1/AC4c/AC5 assert by FILESYSTEM STATE against the real removal path
  (the fake bun genuinely deletes), never by mocking the remover -- AC6.
  The subprocess seam is mocked only where the assertion is ABOUT the calls
  (AC3) or about envelope shape (AC2).
* No test binds a port or runs a real server.
"""

import contextlib
import importlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]

# The pin the fixtures force via `$CRUCIBLE_SERVER_VERSION`, so no test depends
# on the source-checkout `__version__` sentinel (CR-CRU-041 §S6).
PINNED_VERSION = "9.9.9"

SERVER_NPM_PACKAGE = "@anthill-tec/crucible-server"
SERVER_BIN_NAME = "crucible-server"
BUN_BIN_NAME = "bun"
BUN_GLOBAL_NODE_MODULES = ("install", "global", "node_modules")

MANIFEST_FILENAME = "crucible-clients.json"

# `$XDG_DATA_HOME/<STORE_DIR_NAME>` -- the store the installed server opens
# (RUNBOOK "Database path" rule 4).
STORE_DIR_NAME = "crucible"

# The stages the inverse owns, spec §"Design" (`[server]` on a plain run,
# `[config]` + `[store]` additionally under `--purge`), plus the `[unit]`
# teardown CR-CRU-070 prepended.
CONFIG_STAGE = "config"
STORE_STAGE = "store"
SERVER_STAGE = "server"
UNIT_STAGE = "unit"

BOOTSTRAP_NEEDLE = "bun.sh/install"

_SIZE_PATTERN = re.compile(
    r"\d[\d,._]*\s*(B|KB|KiB|MB|MiB|GB|GiB|bytes|byte)\b")


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(*module_names):
    """Import the named `crucible_axi` modules from the repo-root checkout,
    purging the whole package first so each test gets an independent import
    graph (and so `crucible_axi.cli` holds the same `crucible_axi.install`
    module object the `mock.patch` targets resolve to)."""
    _ensure_repo_root_on_path()
    for mod in list(sys.modules):
        if mod == "crucible_axi" or mod.startswith("crucible_axi."):
            del sys.modules[mod]
    return tuple(importlib.import_module(name) for name in module_names)


def _load_toon_module():
    spec = importlib.util.spec_from_file_location(
        "crucible_toon_cr069", str(REPO_ROOT / "clients" / "toon.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_result(returncode=0):
    return SimpleNamespace(returncode=returncode, stdout=f"{PINNED_VERSION}\n",
                           stderr="", args=None)


def _run_side_effect(returncode=0):
    """A `subprocess.run` stand-in: never spawns anything, never removes
    anything, never binds a port."""
    def _run(*args, **kwargs):
        return _run_result(returncode)
    return _run


def _which_prefix_bun_only(bun_bin_dir, fake_bun):
    """A `shutil.which` stand-in: a BARE `bun` token (an inherited-PATH lookup)
    NEVER resolves, so no test can reach the operator's real Bun; an explicit
    lookup inside the tmp `$BUN_INSTALL/bin`, or an absolute path, resolves iff
    the file is really there."""
    def _which(cmd, mode=os.F_OK | os.X_OK, path=None):
        text = str(cmd)
        if os.path.isabs(text):
            return text if os.path.isfile(text) else None
        if os.path.basename(text) != BUN_BIN_NAME:
            return None
        if path and bun_bin_dir in str(path):
            return fake_bun if os.path.isfile(fake_bun) else None
        return None
    return _which


@contextlib.contextmanager
def _patched_env(**overrides):
    """Set/remove environment keys for the block (a None value removes the
    key). `mock.patch.dict` restores the whole mapping on exit."""
    with mock.patch.dict(os.environ, {}, clear=False):
        for key, value in overrides.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield


def _run_cli(cli, argv):
    """Drive `cli.main(argv)` with stdout/stderr captured. Returns
    `(code, stdout, stderr)`; an argparse `SystemExit` is reported as its code,
    so a MISSING subcommand surfaces as an assertion about the contract rather
    than an opaque test error."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli.main(argv)
        except SystemExit as exc:
            code = 0 if exc.code is None else exc.code
    return code, out.getvalue(), err.getvalue()


class _FakeStdin:
    """A stdin stand-in whose `isatty()` answer is fixture-controlled -- the
    interactive/non-interactive switch AC4 turns on."""

    def __init__(self, tty):
        self._tty = tty

    def isatty(self):
        return self._tty

    def fileno(self):
        return 0

    def readline(self):
        return ""

    def read(self, *_args):
        return ""


class _UninstallFixtureCase(unittest.TestCase):
    """Shared fixture: one tmp root holding a tmp `$BUN_INSTALL` prefix (with a
    FAKE `bun`), a tmp `$XDG_DATA_HOME`, a tmp `$HOME`, a tmp `--target-dir`,
    and a sentinel dir outside all of them.

    Nothing is provisioned by default: `_provision_server()`, `_write_config()`
    and `_write_store()` populate exactly what a test needs, so an
    already-clean machine is expressible (AC3)."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cr069-uninstall-")
        self.bun_root = os.path.join(self.root, "bun")
        self.bun_bin_dir = os.path.join(self.bun_root, "bin")
        self.fake_bun = os.path.join(self.bun_bin_dir, BUN_BIN_NAME)
        self.server_bin = os.path.join(self.bun_bin_dir, SERVER_BIN_NAME)
        self.package_dir = os.path.join(
            self.bun_root, *BUN_GLOBAL_NODE_MODULES,
            *SERVER_NPM_PACKAGE.split("/"))

        self.xdg_home = os.path.join(self.root, "xdg")
        self.store_dir = os.path.join(self.xdg_home, STORE_DIR_NAME)
        self.fake_home = os.path.join(self.root, "home")
        self.target_dir = os.path.join(self.root, "target")
        self.config_path = os.path.join(self.target_dir, MANIFEST_FILENAME)
        self.sentinel_dir = os.path.join(self.root, "sentinel")
        self.sentinel = os.path.join(self.sentinel_dir, "keep-me.txt")
        self.empty_path_dir = os.path.join(self.root, "empty-path")
        self.bun_log = os.path.join(self.root, "bun-calls.log")

        for directory in (self.bun_bin_dir, self.xdg_home, self.fake_home,
                          self.sentinel_dir, self.empty_path_dir):
            os.makedirs(directory, exist_ok=True)
        Path(self.sentinel).write_text("untouched\n", encoding="utf-8")
        self._write_fake_bun()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    # -- fixture builders -------------------------------------------------

    def _write_fake_bun(self):
        """Lay down an executable FAKE `$BUN_INSTALL/bin/bun`.

        It logs every invocation (so "was a subprocess spawned?" is answerable
        without mocking the remover) and implements `remove -g <server pkg>`
        with the real side effect Bun has: the package tree and the linked
        `crucible-server` bin both disappear. The paths it deletes are
        HARDCODED tmp paths, so this script structurally cannot touch the
        operator's `~/.bun`, and it NEVER deletes itself.

        It is a PYTHON script run through this interpreter's ABSOLUTE path,
        not a shell script: `$PATH` is deliberately emptied for these tests
        (so a bare `bun` token can never resolve the operator's real Bun), and
        a `/bin/sh` fake would then be unable to resolve `rm` and would
        silently remove nothing."""
        script = f"""#!{sys.executable}
import os
import shutil
import sys

args = sys.argv[1:]
with open({self.bun_log!r}, "a", encoding="utf-8") as handle:
    handle.write(" ".join(args) + "\\n")
if args[:1] == ["--version"]:
    print({PINNED_VERSION!r})
    sys.exit(0)
if args[:1] == ["remove"] and any("crucible-server" in a for a in args):
    shutil.rmtree({self.package_dir!r}, ignore_errors=True)
    if os.path.lexists({self.server_bin!r}):
        os.remove({self.server_bin!r})
sys.exit(0)
"""
        Path(self.fake_bun).write_text(script, encoding="utf-8")
        os.chmod(self.fake_bun, 0o755)
        return self.fake_bun

    def _provision_server(self):
        """The state a real `bun add -g <pkg>@<pin>` leaves behind: the package
        tree under `$BUN_INSTALL/install/global/node_modules/<pkg>` carrying its
        own `package.json`, plus the `crucible-server` symlink in
        `$BUN_INSTALL/bin`."""
        bin_dir = os.path.join(self.package_dir, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        Path(os.path.join(self.package_dir, "package.json")).write_text(
            json.dumps({"name": SERVER_NPM_PACKAGE,
                        "version": PINNED_VERSION}) + "\n",
            encoding="utf-8")
        entry = os.path.join(bin_dir, "server.js")
        Path(entry).write_text("#!/usr/bin/env bun\n", encoding="utf-8")
        os.chmod(entry, 0o755)
        if os.path.lexists(self.server_bin):
            os.remove(self.server_bin)
        os.symlink(entry, self.server_bin)
        return self.server_bin

    def _write_config(self):
        """`<target-dir>/crucible-clients.json` -- the client state the
        [manifest] install stage wrote."""
        os.makedirs(self.target_dir, exist_ok=True)
        Path(self.config_path).write_text(
            json.dumps({"version": PINNED_VERSION, "clients": {},
                        "status": "STATUS-CONTRACT.md"}, indent=2) + "\n",
            encoding="utf-8")
        return self.config_path

    def _write_store(self):
        """`$XDG_DATA_HOME/crucible/` -- the server's store, plus one
        `crucible-pre-*.db` backup (AC4 names those explicitly)."""
        os.makedirs(self.store_dir, exist_ok=True)
        Path(os.path.join(self.store_dir, "crucible.db")).write_bytes(
            b"\x00" * 4096)
        Path(os.path.join(self.store_dir,
                          "crucible-pre-overwrite-2026-08-20.db")).write_bytes(
            b"\x00" * 8192)
        return self.store_dir

    def _env(self, **extra):
        env = {
            "BUN_INSTALL": self.bun_root,
            "XDG_DATA_HOME": self.xdg_home,
            "HOME": self.fake_home,
            "PATH": self.empty_path_dir,
            "CRUCIBLE_SERVER_VERSION": PINNED_VERSION,
            # An UNINSTALL must never pipe a remote installer to a shell.
            "CRUCIBLE_NO_BUN_BOOTSTRAP": "1",
        }
        env.update(extra)
        return env

    # -- observations -----------------------------------------------------

    def _bun_invocations(self):
        """Every FAKE-bun invocation recorded so far, one flattened argv per
        line. Empty when no bun subprocess was spawned at all."""
        if not os.path.exists(self.bun_log):
            return []
        return [line for line in Path(self.bun_log).read_text(
            encoding="utf-8").splitlines() if line.strip()]

    def _removal_invocations(self):
        return [line for line in self._bun_invocations()
                if line.split()[:1] == ["remove"]]

    def _decode(self, stdout_text, toon):
        self.assertEqual(
            stdout_text.count("axi:"), 1,
            f"`uninstall` must emit exactly ONE TOON-AXI envelope on stdout, "
            f"exactly as `install` does; stdout={stdout_text!r}")
        return toon.decode(stdout_text)["axi"]

    def _stage_row(self, axi, name):
        rows = [row for row in axi.get("stages", [])
                if isinstance(row, dict) and row.get("name") == name]
        self.assertEqual(
            len(rows), 1,
            f"the `{name}` stage must be reported as its own stage row in the "
            f"uninstall envelope (AC2); stages={axi.get('stages')!r}")
        return rows[0]

    def _require(self, module, attr, why):
        self.assertTrue(
            hasattr(module, attr),
            f"{module.__name__}.{attr} is MISSING -- {why}")
        return getattr(module, attr)

    def _states_retained(self, row):
        """Whether a stage row SAYS the artifact was retained -- either a
        machine-readable `retained: true`, or any string field saying so."""
        if row.get("retained") is True:
            return True
        return any(isinstance(value, str) and "retain" in value.lower()
                   for value in row.values())

    @contextlib.contextmanager
    def _real_removal(self, stdin_tty=False):
        """Run against the REAL removal path (the fake bun genuinely deletes),
        with the two independent guards that keep the operator's real Bun
        unreachable: a stubbed `shutil.which` that never resolves a bare `bun`,
        and a `$PATH` pointing at an empty tmp dir."""
        with _patched_env(**self._env()), \
                mock.patch("sys.stdin", new=_FakeStdin(stdin_tty)), \
                mock.patch("os.isatty", return_value=stdin_tty), \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_prefix_bun_only(
                               self.bun_bin_dir, self.fake_bun)):
            yield


class PlainUninstallRemovesProgramArtifactsOnlyTest(_UninstallFixtureCase):
    """AC1 + AC6 -- a plain `crucible-axi uninstall` removes the PROGRAM
    artifacts (`bun remove -g <pkg>`, the inverse of the [server] stage's
    `bun add -g`, through the same absolute-Bun resolution) and NOTHING it did
    not provision: the store and the config both survive untouched.

    Asserted by FILESYSTEM STATE against a real removal, never by mocking the
    remover -- the whole defect is that nothing reverses the provision, and a
    mocked remover cannot tell a real inverse from a reported one."""

    def test_plain_uninstall_removes_package_and_symlink_and_keeps_store_and_config(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        toon = _load_toon_module()
        self._provision_server()
        self._write_config()
        self._write_store()

        # Fixture sanity -- everything the assertions are ABOUT is really there.
        self.assertTrue(os.path.isdir(self.package_dir))
        self.assertTrue(os.path.lexists(self.server_bin))
        self.assertTrue(os.path.isfile(self.config_path))
        self.assertTrue(os.path.isdir(self.store_dir))

        with self._real_removal():
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"a plain `uninstall` of a provisioned machine must exit 0 -- "
            f"`uninstall` is not a verb yet, so argparse rejects it "
            f"(AC1/AC2); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon)
        self.assertEqual(axi["verb"], "uninstall")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")

        self.assertFalse(
            os.path.exists(self.package_dir),
            f"the global server package must be GONE after `uninstall` -- it "
            f"is exactly what `uv tool uninstall crucible-axi` orphans "
            f"(AC1); still at {self.package_dir}")
        self.assertFalse(
            os.path.lexists(self.server_bin),
            f"the `{SERVER_BIN_NAME}` symlink must be GONE after `uninstall` "
            f"-- a live server on PATH after an uninstall is the defect "
            f"(AC1); still at {self.server_bin}")
        self.assertTrue(
            self._removal_invocations(),
            f"the removal must go through the resolved ABSOLUTE Bun "
            f"(`bun remove -g {SERVER_NPM_PACKAGE}`), never a bare `bun` off "
            f"PATH and never an ad-hoc rm (AC1); bun invocations="
            f"{self._bun_invocations()!r}")

        self.assertTrue(
            os.path.isfile(self.config_path),
            f"a PLAIN `uninstall` must leave the config UNTOUCHED -- only "
            f"`--purge` may delete it (AC1/AC4); {self.config_path} was "
            f"removed")
        self.assertTrue(
            os.path.isdir(self.store_dir),
            f"a PLAIN `uninstall` must leave the store UNTOUCHED -- a plain "
            f"uninstall destroys nothing and is reversible by reinstalling "
            f"(AC1/AC4); {self.store_dir} was removed")
        self.assertTrue(
            os.path.isfile(os.path.join(self.store_dir, "crucible.db")),
            "the store's database must survive a plain uninstall (AC1)")
        self.assertTrue(
            os.path.isfile(self.sentinel),
            "a plain uninstall must not remove anything it did not provision "
            "(AC1)")


class StageInversionAndInstallParityTest(_UninstallFixtureCase):
    """AC2 -- stage inversion is ORDERED and REPORTED: stages run in reverse
    install order, each as its own stage, fail-fast, with the same TOON-AXI
    envelope shape and exit-code contract as `install`. Parity is ASSERTED
    against a real `install` envelope produced in the same test, never
    assumed."""

    def _fakes(self, order, failing=None, recorder=None):
        def make(name):
            def _runner(target_dir, purge):
                if recorder is not None:
                    recorder.append(name)
                if name == failing:
                    raise RuntimeError(f"{name} stage boom")
                return {"path": os.path.join(target_dir, name),
                        "converged": False}
            return _runner
        return {name: make(name) for name in order}

    def test_uninstall_stage_order_puts_the_destructive_stages_last(self):
        """AC2 — order is ("unit", "server", "config", "store") since
        CR-CRU-070 prepended the unit teardown: the program artifacts first,
        the two DESTRUCTIVE stages last.

        Deliberately NOT a naive reverse of `STAGE_ORDER`. Install's order
        (`server`, `fleet`, `manifest`, `unit`) has no destructive step, so
        inverting it says nothing about where a purge belongs. Combined with
        fail-fast, destructive-last means data is destroyed only after every
        reversible step has already succeeded -- the inverse order would let a
        failing server stage leave the store and config GONE and the program
        still installed, the worst reachable outcome."""
        install, = _import_fresh("crucible_axi.install")
        order = self._require(
            install, "UNINSTALL_STAGE_ORDER",
            "uninstall must declare its stage sequence the way install "
            "declares STAGE_ORDER, so the order is inspectable (AC2)")
        # CR-CRU-070 gave the install order `[unit]` and CR-CRU-090's merge-back
        # gave it `[fleet]`, so the order this inverse relates to is FOUR
        # stages. `[fleet]` has no inverse here yet -- CR-CRU-090 §S1 defers the
        # uninstall counterpart to a follow-up CR, which is why this inverse
        # stays at four stages of its own without a `fleet` entry.
        self.assertEqual(
            install.STAGE_ORDER,
            (SERVER_STAGE, "fleet", "manifest", UNIT_STAGE),
            "fixture sanity: the install order this relates to")
        order = tuple(order)
        # CR-CRU-070 -- ("server", "config", "store") is superseded by
        # ("unit", "server", "config", "store"): the unit is torn down FIRST,
        # or systemd is left restarting a deleted binary.
        self.assertEqual(
            order, (UNIT_STAGE, SERVER_STAGE, CONFIG_STAGE, STORE_STAGE),
            f"the inverse owns exactly four stages, in that order -- "
            f"[{UNIT_STAGE}], [{SERVER_STAGE}], [{CONFIG_STAGE}] and "
            f"[{STORE_STAGE}] (spec AC2 + CR-CRU-070 AC3); got {order!r}")
        for name in (UNIT_STAGE, SERVER_STAGE, CONFIG_STAGE, STORE_STAGE):
            self.assertIn(
                name, order,
                f"[{name}] must be its own reported stage (AC2/AC4); "
                f"got {order!r}")
        # CR-CRU-070 -- [server] is no longer first, but it is still the last
        # NON-destructive stage: destructive-last is what this pins.
        self.assertLess(
            order.index(SERVER_STAGE), order.index(CONFIG_STAGE),
            f"the NON-destructive stages must precede every destructive one -- "
            f"destructive-last (AC2); got {order!r}")
        self.assertLess(
            order.index(CONFIG_STAGE), order.index(STORE_STAGE),
            f"among the destructive stages [{CONFIG_STAGE}] precedes "
            f"[{STORE_STAGE}] -- config is cheap state, the store is the "
            f"irreplaceable artifact and goes absolutely last (AC2); "
            f"got {order!r}")

    def test_uninstall_envelope_shape_and_exit_code_match_install(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        order = tuple(self._require(
            install, "UNINSTALL_STAGE_ORDER",
            "the reported stage sequence is what AC2 asserts parity on"))
        runners = self._require(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "uninstall needs the same module-level, mock.patch.dict-able stage "
            "table `DEFAULT_STAGE_RUNNERS` gives install (AC2)")

        install_fakes = {
            name: (lambda target_dir, force: {
                "path": os.path.join(target_dir, "x"), "converged": False})
            for name in install.STAGE_ORDER
        }
        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS, install_fakes):
            install_code, install_out, _ = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(install_code, 0, "fixture sanity: install envelope")
        install_axi = toon.decode(install_out)["axi"]

        recorder = []
        with _patched_env(**self._env()), \
                mock.patch.dict(runners, self._fakes(order,
                                                     recorder=recorder)):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"an all-converged `uninstall` exits 0, exactly as `install` "
            f"does (AC2); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon)
        self.assertEqual(axi["verb"], "uninstall")
        self.assertIs(axi["ok"], True)
        self.assertEqual(
            set(axi.keys()), set(install_axi.keys()),
            f"AC2 demands the SAME envelope shape as `install`: install keys="
            f"{sorted(install_axi)} uninstall keys={sorted(axi)}")
        self.assertEqual(
            recorder, list(order),
            f"every stage must run, in UNINSTALL_STAGE_ORDER (AC2); "
            f"ran {recorder!r}")
        self.assertEqual(
            [row["name"] for row in axi["stages"]], list(order),
            f"each inverted stage must be reported as its OWN stage row, in "
            f"order (AC2); stages={axi['stages']!r}")
        for row in axi["stages"]:
            self.assertIn(
                "path", row,
                f"parity: every install stage row carries the artifact `path`, "
                f"so every uninstall row must too (AC2); row={row!r}")
            self.assertTrue(row["path"], f"row={row!r}")

    def test_a_failing_stage_halts_the_sequence_and_maps_to_exit_one(self):
        """Fail-fast + the exit-code contract, the two halves of AC2 a
        happy-path test cannot see: a stage exception must halt the sequence
        (never silently continue into a later stage) and surface as `ok=False`
        plus exit 1 -- exactly what `run_install` does."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        order = tuple(self._require(
            install, "UNINSTALL_STAGE_ORDER",
            "fail-fast is asserted over the declared stage sequence (AC2)"))
        runners = self._require(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "the injectable stage table is how a stage failure is modelled "
            "without a real subprocess (AC2)")

        recorder = []
        fakes = self._fakes(order, failing=order[0], recorder=recorder)
        with _patched_env(**self._env()), \
                mock.patch.dict(runners, fakes):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        for later in order[1:]:
            self.assertNotIn(
                later, recorder,
                f"a failing [{order[0]}] stage must NOT be followed by "
                f"[{later}] -- uninstall is fail-fast, exactly as install is "
                f"(AC2); ran {recorder!r}")
        self.assertEqual(
            code, 1,
            f"a failed uninstall stage must map to exit 1 (AC2); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon)
        self.assertIs(
            axi["ok"], False,
            f"the failure must surface as ok:false in the envelope, never be "
            f"swallowed (AC2); envelope={axi!r}")
        self.assertTrue(
            axi["warnings"],
            f"the failing stage must be recorded VISIBLY as a warning, as "
            f"`run_install` records it (AC2); envelope={axi!r}")


class UninstallIsIdempotentTest(_UninstallFixtureCase):
    """AC3 -- running `uninstall` twice is indistinguishable from running it
    once: every stage converges, `ok=True`, exit 0, and NO subprocess is
    spawned for an artifact that is already absent."""

    def test_second_run_spawns_no_bun_subprocess_and_still_exits_zero(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        toon = _load_toon_module()
        self._provision_server()
        self._write_config()
        self._write_store()

        with self._real_removal():
            first_code, first_out, first_err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])
            self.assertEqual(
                first_code, 0,
                f"first `uninstall` must succeed before idempotence can be "
                f"asserted; stdout={first_out!r} stderr={first_err!r}")
            self.assertTrue(
                self._removal_invocations(),
                f"the first run must really remove the provisioned server; "
                f"bun invocations={self._bun_invocations()!r}")
            after_first = list(self._bun_invocations())

            second_code, second_out, second_err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            second_code, 0,
            f"a second `uninstall` must CONVERGE, never fail because the "
            f"artifact is already gone (AC3); stdout={second_out!r} "
            f"stderr={second_err!r}")
        axi = self._decode(second_out, toon)
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self.assertEqual(
            self._bun_invocations(), after_first,
            f"the second run must spawn NO subprocess for an artifact that is "
            f"already absent (AC3): the probe answers from the filesystem, "
            f"exactly as the [server] install stage short-circuits before "
            f"`_guarantee_bun`; new invocations="
            f"{self._bun_invocations()[len(after_first):]!r}")
        self.assertIs(
            self._stage_row(axi, SERVER_STAGE).get("converged"), True,
            f"an already-absent server must report converged:true (AC3); "
            f"envelope={axi!r}")
        self.assertTrue(
            os.path.isfile(self.config_path),
            "a second plain uninstall still must not touch the config (AC4)")
        self.assertTrue(
            os.path.isdir(self.store_dir),
            "a second plain uninstall still must not touch the store (AC4)")

    def test_already_clean_machine_converges_without_any_subprocess(self):
        """The already-clean machine AC3 names: nothing provisioned, no store,
        no config, not even a target dir. Every stage reports converged,
        `ok=True`, exit 0, and the recorded subprocess calls are EMPTY -- an
        implementation that shells out unconditionally fails here."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        order = tuple(self._require(
            install, "UNINSTALL_STAGE_ORDER",
            "convergence is asserted per declared stage (AC3)"))
        self.assertFalse(os.path.exists(self.package_dir))
        self.assertFalse(os.path.exists(self.target_dir))
        self.assertFalse(os.path.exists(self.store_dir))

        with _patched_env(**self._env()), \
                mock.patch("sys.stdin", new=_FakeStdin(False)), \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_prefix_bun_only(
                               self.bun_bin_dir, self.fake_bun)), \
                mock.patch("crucible_axi.install.subprocess.run",
                           side_effect=_run_side_effect()) as install_run, \
                mock.patch("crucible_axi.cli.subprocess.run",
                           side_effect=_run_side_effect()) as cli_run:
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"`uninstall` on an already-clean machine must exit 0 (AC3); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon)
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self.assertEqual(
            [row["name"] for row in axi["stages"]], list(order),
            f"a converged run still reports every stage (AC2/AC3); "
            f"stages={axi['stages']!r}")
        for row in axi["stages"]:
            self.assertIs(
                row.get("converged"), True,
                f"every stage must report converged:true on an already-clean "
                f"machine (AC3); row={row!r}")
        self.assertEqual(
            install_run.call_args_list, [],
            f"NO subprocess may be spawned for an artifact that is already "
            f"absent (AC3); calls={install_run.call_args_list!r}")
        self.assertEqual(
            cli_run.call_args_list, [],
            f"NO subprocess may be spawned from the CLI either (AC3); "
            f"calls={cli_run.call_args_list!r}")


class NonInteractiveRetainsStoreAndConfigTest(_UninstallFixtureCase):
    """AC4 (non-interactive) -- no `--purge` and no TTY: RETAIN both, exit 0,
    and STATE in the envelope that the store and config were retained AND
    where they are. Automation must never silently lose a database, and it must
    never be left guessing where the data it kept now lives."""

    def test_non_tty_run_retains_both_and_names_both_paths_in_the_envelope(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        toon = _load_toon_module()
        self._provision_server()
        self._write_config()
        self._write_store()

        with self._real_removal(stdin_tty=False), \
                mock.patch("builtins.input",
                           side_effect=AssertionError(
                               "a NON-interactive uninstall must never "
                               "prompt: automation would hang (AC4)")):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"retaining data is the DEFAULT, not a failure -- exit 0 (AC4); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon)
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self.assertTrue(
            os.path.isdir(self.store_dir),
            f"the store must be RETAINED without `--purge` (AC4); "
            f"{self.store_dir} was removed")
        self.assertTrue(
            os.path.isfile(self.config_path),
            f"the config must be RETAINED without `--purge` (AC4); "
            f"{self.config_path} was removed")

        store_row = self._stage_row(axi, STORE_STAGE)
        config_row = self._stage_row(axi, CONFIG_STAGE)
        self.assertTrue(
            self._states_retained(store_row),
            f"the envelope must STATE that the store was retained (AC4); "
            f"row={store_row!r}")
        self.assertTrue(
            self._states_retained(config_row),
            f"the envelope must STATE that the config was retained (AC4); "
            f"row={config_row!r}")
        self.assertIn(
            self.store_dir, out,
            f"the envelope must say WHERE the retained store is (AC4); "
            f"stdout={out!r}")
        self.assertIn(
            self.config_path, out,
            f"the envelope must say WHERE the retained config is (AC4); "
            f"stdout={out!r}")


class InteractivePromptDefaultsToRetainTest(_UninstallFixtureCase):
    """AC4 (interactive) -- on a TTY, `uninstall` prompts ONCE, naming both
    paths and the store's size, and DEFAULTS TO RETAIN on empty input, on EOF
    and on interrupt. The prompt is a convenience; the default is the guard."""

    def _run_on_a_tty(self, cli, input_side_effect):
        with _patched_env(**self._env()), \
                mock.patch("sys.stdin", new=_FakeStdin(True)), \
                mock.patch("os.isatty", return_value=True), \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_prefix_bun_only(
                               self.bun_bin_dir, self.fake_bun)), \
                mock.patch("crucible_axi.install.subprocess.run",
                           side_effect=_run_side_effect()), \
                mock.patch("builtins.input",
                           side_effect=input_side_effect) as mock_input:
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])
        return code, out, err, mock_input

    def _assert_both_retained(self, answer, code, out, err):
        self.assertEqual(
            code, 0,
            f"a prompt answered {answer} RETAINS and exits 0 (AC4); "
            f"stdout={out!r} stderr={err!r}")
        self.assertTrue(
            os.path.isdir(self.store_dir),
            f"{answer} at the prompt must DEFAULT TO RETAIN -- the store must "
            f"survive (AC4); {self.store_dir} was removed")
        self.assertTrue(
            os.path.isfile(self.config_path),
            f"{answer} at the prompt must DEFAULT TO RETAIN -- the config must "
            f"survive (AC4); {self.config_path} was removed")

    def test_prompt_is_asked_once_naming_both_paths_and_the_store_size(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        self._provision_server()
        self._write_config()
        self._write_store()

        code, out, err, mock_input = self._run_on_a_tty(cli, [""])

        self.assertEqual(
            mock_input.call_count, 1,
            f"an interactive `uninstall` must prompt EXACTLY ONCE (AC4); "
            f"prompted {mock_input.call_count} times, stdout={out!r} "
            f"stderr={err!r}")
        prompt = " ".join(
            [str(a) for call in mock_input.call_args_list for a in call.args]
            + [out, err])
        self.assertIn(
            self.store_dir, prompt,
            f"the prompt must NAME the store path (AC4); prompt={prompt!r}")
        self.assertIn(
            self.config_path, prompt,
            f"the prompt must NAME the config path (AC4); prompt={prompt!r}")
        sized = prompt.replace(self.store_dir, " ").replace(
            self.config_path, " ").replace(self.root, " ")
        self.assertRegex(
            sized, _SIZE_PATTERN,
            f"the prompt must state the STORE'S SIZE, so the operator knows "
            f"what they are about to destroy (AC4); prompt={prompt!r}")
        self._assert_both_retained("empty input", code, out, err)

    def test_empty_input_retains_both(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        self._provision_server()
        self._write_config()
        self._write_store()
        code, out, err, _ = self._run_on_a_tty(cli, [""])
        self._assert_both_retained("empty input", code, out, err)

    def test_eof_retains_both(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        self._provision_server()
        self._write_config()
        self._write_store()
        code, out, err, _ = self._run_on_a_tty(cli, EOFError())
        self._assert_both_retained("EOF (closed stdin)", code, out, err)

    def test_interrupt_retains_both(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        self._provision_server()
        self._write_config()
        self._write_store()
        code, out, err, _ = self._run_on_a_tty(cli, KeyboardInterrupt())
        self._assert_both_retained("an interrupt (Ctrl-C)", code, out, err)


class PurgeIsTheOnlyDestructivePathTest(_UninstallFixtureCase):
    """AC4 (purge) + AC6 -- `--purge` is the ONLY path that deletes the store or
    the config; it removes exactly those two (plus the program artifacts a plain
    run removes) and nothing else, and it CONVERGES when they are already
    absent. Asserted by filesystem state."""

    def test_purge_removes_the_store_and_the_config_and_nothing_else(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        toon = _load_toon_module()
        self._provision_server()
        self._write_config()
        store = self._write_store()
        backup = os.path.join(store, "crucible-pre-overwrite-2026-08-20.db")
        self.assertTrue(os.path.isfile(backup), "fixture sanity")

        with self._real_removal():
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir,
                      "--purge"])

        self.assertEqual(
            code, 0,
            f"`--purge` on a provisioned machine must exit 0 (AC4); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon)
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self.assertFalse(
            os.path.exists(self.store_dir),
            f"`--purge` must remove the store, INCLUDING every "
            f"`crucible-pre-*.db` backup (AC4); {self.store_dir} survived")
        self.assertFalse(
            os.path.exists(self.config_path),
            f"`--purge` must remove the config/state (AC4); "
            f"{self.config_path} survived")
        self.assertTrue(
            os.path.isfile(self.sentinel),
            f"`--purge` deletes the store and the config and NOTHING ELSE "
            f"(AC4); {self.sentinel} was removed")
        self.assertTrue(
            os.path.isfile(self.fake_bun),
            f"`--purge` must never remove Bun (AC5); {self.fake_bun} was "
            f"removed")

    def test_purge_converges_when_the_store_and_config_are_already_absent(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        toon = _load_toon_module()
        self._provision_server()
        self.assertFalse(os.path.exists(self.store_dir), "fixture sanity")
        self.assertFalse(os.path.exists(self.config_path), "fixture sanity")

        with self._real_removal():
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir,
                      "--purge"])

        self.assertEqual(
            code, 0,
            f"`--purge` on an absent store/config must CONVERGE, never fail "
            f"(AC4); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon)
        self.assertIs(
            axi["ok"], True,
            f"`--purge` with nothing to purge is ok:true (AC4); "
            f"envelope={axi!r}")
        for name in (STORE_STAGE, CONFIG_STAGE):
            row = self._stage_row(axi, name)
            self.assertIs(
                row.get("converged"), True,
                f"an already-absent [{name}] artifact must report "
                f"converged:true under `--purge` (AC4); row={row!r}")


class BunIsNeverRemovedTest(_UninstallFixtureCase):
    """AC5 -- Bun is NEVER removed. Install only GUARANTEES Bun; it does not own
    it. A user's Bun may predate Crucible and serve other projects, so uninstall
    reverses what install PROVISIONED, never what it found or bootstrapped as a
    runtime. Asserted on both the plain and the `--purge` path."""

    def _assert_bun_intact(self, label):
        self.assertTrue(
            os.path.isdir(self.bun_root),
            f"{label}: Bun's install prefix must survive -- uninstall does not "
            f"own Bun (AC5); {self.bun_root} was removed")
        self.assertTrue(
            os.path.isfile(self.fake_bun),
            f"{label}: `$BUN_INSTALL/bin/{BUN_BIN_NAME}` must survive (AC5); "
            f"{self.fake_bun} was removed")
        offenders = [
            line for line in self._bun_invocations()
            if line.split()[:1] == ["remove"]
            and SERVER_NPM_PACKAGE not in line]
        self.assertEqual(
            offenders, [],
            f"{label}: the ONLY thing uninstall may remove through Bun is "
            f"{SERVER_NPM_PACKAGE} -- never Bun itself, never anything else "
            f"(AC5); offending invocations={offenders!r}")
        bootstraps = [line for line in self._bun_invocations()
                      if BOOTSTRAP_NEEDLE in line]
        self.assertEqual(
            bootstraps, [],
            f"{label}: an uninstall must never pipe the remote Bun installer "
            f"to a shell either (AC5); {bootstraps!r}")

    def test_bun_survives_a_plain_uninstall_and_a_purge(self):
        cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")[1]
        self._provision_server()
        self._write_config()
        self._write_store()

        with self._real_removal():
            plain_code, plain_out, plain_err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])
        self.assertEqual(
            plain_code, 0,
            f"plain uninstall must succeed before AC5 can be asserted; "
            f"stdout={plain_out!r} stderr={plain_err!r}")
        self._assert_bun_intact("after a plain uninstall")

        self._provision_server()
        self._write_config()
        self._write_store()
        with self._real_removal():
            purge_code, purge_out, purge_err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir,
                      "--purge"])
        self.assertEqual(
            purge_code, 0,
            f"`--purge` must succeed before AC5 can be asserted; "
            f"stdout={purge_out!r} stderr={purge_err!r}")
        self._assert_bun_intact("after a --purge uninstall")


if __name__ == "__main__":
    unittest.main()
