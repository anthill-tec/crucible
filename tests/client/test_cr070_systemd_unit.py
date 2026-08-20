"""CR-CRU-070 C1 (RED) -- the systemd `--user` unit stage of `crucible-axi
install` / `uninstall`.

Today `crucible-axi` has NO systemd surface at all: `STAGE_ORDER` is
`("server", "manifest")`, `UNINSTALL_STAGE_ORDER` is
`("server", "config", "store")`, and the only persistent run is a foreground
`crucible-axi serve` in a terminal -- while three shipped comments
(`cli.py:130`, `install.py:83`, `install.py:397`) already promise the unit.
Every test in this file therefore fails on a MISSING contract, and each names
which one.

The contract these tests pin, deliberately kept to the SMALLEST invented
surface so the GREEN phase is free in everything else:

* `crucible_axi.install.STAGE_ORDER == ("server", "manifest", "unit")` -- the
  unit is provisioned only AFTER the launcher it points at exists.
* `crucible_axi.install.UNINSTALL_STAGE_ORDER ==
  ("unit", "server", "config", "store")` -- the unit is torn down FIRST (or
  systemd is left restarting a deleted binary), destructive-last preserved.
* `DEFAULT_STAGE_RUNNERS["unit"]` / `DEFAULT_UNINSTALL_STAGE_RUNNERS["unit"]`
  -- the same module-level, `mock.patch.dict`-able runner tables, the same
  `(target_dir, force)` / `(target_dir, purge)` runner protocol.
* the unit file itself: `ExecStart` DERIVED from
  `install.server_launch_argv()` (absolute, never a bare
  `crucible-server`/`bun`/`bunx` token -- a unit inherits no shell PATH),
  `Restart=on-failure`, `WantedBy=default.target`, and the `CRUCIBLE_*`
  knobs the unit cannot inherit forwarded explicitly.
* install: write -> `daemon-reload` -> `enable --now`, idempotent (unchanged
  unit not rewritten, active service not restarted).
* uninstall: `disable --now` -> remove the unit file -> `daemon-reload`,
  converging with NO systemctl call when the unit is already absent.
* absent systemd (no `systemctl`, or no user D-Bus) => the `[unit]` stage row
  carries `skipped: true` plus a non-empty `reason`, and the run still exits 0.
* `--no-service` (install flag, and `run_install(..., no_service=True)`) and
  `CRUCIBLE_NO_SERVICE=1` opt out explicitly, without so much as probing.
* `--user` only: every systemctl argv carries `--user`, and no code literal in
  `crucible_axi/{install,cli}.py` names `/etc/systemd/...`, `sudo`, `--system`
  or `--global`.

SYSTEMD ISOLATION -- nothing here touches the operator's user manager:

* `subprocess.run` is patched inside `crucible_axi.install` for every test that
  can reach the stage, by a recorder that NEVER spawns a process. No real
  `systemctl` is executed, so no unit is ever loaded, enabled, started or
  stopped.
* `shutil.which` is stubbed so `systemctl` resolves ONLY to a tmp
  never-executed stand-in (and to None where absence is being modelled), and a
  bare `bun` token never resolves the operator's real Bun.
* `$XDG_CONFIG_HOME`, `$HOME`, `$XDG_RUNTIME_DIR`, `$XDG_DATA_HOME`,
  `$BUN_INSTALL` and `$PATH` all point INSIDE one tmp root, so
  `~/.config/systemd/user` is unreachable by either resolution rule.
* stdin is non-interactive throughout, so no `uninstall` here can stall on
  CR-CRU-069's purge prompt when the suite is run from a terminal.
* `tearDown` ASSERTS the real `~/.config/systemd/user` gained/lost no
  crucible-named entry, so the claim is enforced rather than promised.
"""

import ast
import contextlib
import importlib
import importlib.util
import inspect
import io
import os
import shlex
import shutil
import sys
import tempfile
import time
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
BUNX_BIN_NAME = "bunx"
BUN_GLOBAL_NODE_MODULES = ("install", "global", "node_modules")

SYSTEMCTL_BIN_NAME = "systemctl"

# The stage names: the four the inverse owns, and the three install runs.
UNIT_STAGE = "unit"
SERVER_STAGE = "server"
MANIFEST_STAGE = "manifest"
CONFIG_STAGE = "config"
STORE_STAGE = "store"

# The explicit opt-out (spec AC4), flag + environment form.
NO_SERVICE_FLAG = "--no-service"
NO_SERVICE_ENV_VAR = "CRUCIBLE_NO_SERVICE"

# The server's own runtime knobs (RUNBOOK "Environment"): a `--user` unit
# inherits none of the operator's exports, so AC1 makes the unit carry them.
SERVER_HOST_ENV_VAR = "CRUCIBLE_HOST"
SERVER_PORT_ENV_VAR = "CRUCIBLE_PORT"
SERVER_DB_ENV_VAR = "CRUCIBLE_DB"

# Where a SYSTEM-scope unit would live, and the privilege-escalation tokens a
# `--user`-only install must never name (spec §Scope).
SYSTEM_UNIT_DIR = "/etc/systemd"
FORBIDDEN_ARGV_TOKENS = ("sudo", "pkexec", "doas", "--system", "--global")

# systemctl verbs that are PROBES (free to appear anywhere) versus the
# MUTATING ones whose exact sequence AC2 pins.
PROBE_VERBS = frozenset({
    "is-active", "is-enabled", "is-failed", "show", "cat", "status",
    "list-units", "list-unit-files", "get-default", "is-system-running",
    "show-environment",
})

# Restarting an already-active service is exactly what AC2's idempotence
# forbids.
RESTART_VERBS = frozenset({
    "restart", "try-restart", "reload-or-restart", "try-reload-or-restart",
    "reload", "force-reload", "stop", "kill",
})

# The real user-unit directory, only ever READ (and only for the isolation
# assertion in `tearDown`).
REAL_USER_UNIT_DIR = os.path.join(
    os.path.expanduser("~"), ".config", "systemd", "user")


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(*module_names):
    """Import the named `crucible_axi` modules from the repo-root checkout,
    purging the whole package first so each test gets an independent import
    graph (and so `crucible_axi.cli` holds the same `crucible_axi.install`
    module object the patch targets resolve to)."""
    _ensure_repo_root_on_path()
    for mod in list(sys.modules):
        if mod == "crucible_axi" or mod.startswith("crucible_axi."):
            del sys.modules[mod]
    return tuple(importlib.import_module(name) for name in module_names)


def _load_toon_module():
    spec = importlib.util.spec_from_file_location(
        "crucible_toon_cr070", str(REPO_ROOT / "clients" / "toon.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _completed(returncode, stdout, argv):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr="",
                           args=argv)


def _which_stub(bun_bin_dir, fake_bun, systemctl_path):
    """A `shutil.which` stand-in with two independent guards:

    * `systemctl` resolves ONLY to the tmp stand-in this fixture created (or to
      `systemctl_path=None`, which is how "no systemd on this machine" is
      modelled) -- the operator's `/usr/bin/systemctl` is unreachable;
    * a BARE `bun` token never resolves, so no test can reach the operator's
      real Bun.
    """
    def _which(cmd, mode=os.F_OK | os.X_OK, path=None):
        text = str(cmd)
        base = os.path.basename(text)
        if base == SYSTEMCTL_BIN_NAME:
            return systemctl_path
        if os.path.isabs(text):
            return text if os.path.isfile(text) else None
        if base != BUN_BIN_NAME:
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
    so a MISSING flag surfaces as an assertion about the contract rather than
    an opaque test error."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli.main(argv)
        except SystemExit as exc:
            code = 0 if exc.code is None else exc.code
    return code, out.getvalue(), err.getvalue()


def _verb_of(argv):
    """The systemctl VERB in an argv -- the first non-flag token after the
    executable (`systemctl --user daemon-reload` -> `daemon-reload`)."""
    for token in argv[1:]:
        if not token.startswith("-"):
            return token
    return ""


def _code_string_literals(path):
    """Every string literal in a module that is NOT a docstring (and, because
    comments never reach the AST, never a comment either).

    The distinction matters: `install.py` already says "and no sudo" in a
    COMMENT, and prose about what the install does NOT do must not read as the
    install doing it. What this returns is what the module can actually
    execute or write."""
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    docstrings = set()
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                                 ast.AsyncFunctionDef)) or not body:
            continue
        head = body[0]
        if isinstance(head, ast.Expr) and isinstance(head.value, ast.Constant) \
                and isinstance(head.value.value, str):
            docstrings.add(id(head.value))
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in docstrings]


class _NonInteractiveStdin:
    """A stdin stand-in that is never a TTY.

    `cmd_uninstall`'s purge prompt (CR-CRU-069 AC4) fires only on an
    interactive stdin -- and a suite run from a terminal HAS one, so an
    uninstall test that leaves stdin alone would sit waiting for a human. The
    prompt is not this CR's contract, so every `uninstall` here runs the
    non-interactive path, exactly as CR-CRU-069's own fixtures do."""

    @staticmethod
    def isatty():
        return False

    @staticmethod
    def fileno():
        return 0

    @staticmethod
    def readline():
        return ""

    @staticmethod
    def read(*_args):
        return ""


@contextlib.contextmanager
def _non_interactive():
    """Neutralise the purge prompt for the block (both the `sys.stdin` and the
    `os.isatty` route into `cli._stdin_is_interactive`)."""
    with mock.patch("sys.stdin", new=_NonInteractiveStdin()), \
            mock.patch("os.isatty", return_value=False):
        yield


class _SystemctlRecorder:
    """A `subprocess.run` stand-in for `crucible_axi.install`.

    It NEVER spawns a process -- that is what keeps the operator's systemd
    untouched -- and records, per call, the flattened argv plus whether a unit
    file existed IN THE TMP TREE at that moment. That second field is what
    makes ORDER observable without hooking the file write: "was the unit
    already written when `daemon-reload` ran?" and "was it already removed when
    the teardown reloaded?" are then plain assertions.

    `active`/`enabled` answer the probe verbs (`is-active`, `is-enabled`,
    `show`) so an "already running service" is expressible; `bus_failure`
    models a machine with systemd but no user D-Bus session; `absent` models no
    `systemctl` binary at all, through the OTHER detection seam (an
    `exec`-time `FileNotFoundError`) so the stage is pinned on behaviour rather
    than on which probe it happens to use.
    """

    def __init__(self, case, active=False, enabled=False, bus_failure=False,
                 absent=False, returncode=0):
        self.case = case
        self.active = active
        self.enabled = enabled
        self.bus_failure = bus_failure
        self.absent = absent
        self.returncode = returncode
        self.calls = []

    def __call__(self, argv, *args, **kwargs):
        flat = [str(item) for item in
                (argv if isinstance(argv, (list, tuple)) else [argv])]
        self.calls.append((flat, bool(self.case._unit_files())))
        if not self._is_systemctl(flat):
            return _completed(0, "", flat)
        if self.absent:
            raise FileNotFoundError(
                2, "No such file or directory", flat[0] if flat else "")
        if self.bus_failure:
            return SimpleNamespace(
                returncode=1, stdout="",
                stderr="Failed to connect to bus: No medium found\n",
                args=flat)
        if "is-active" in flat:
            return _completed(0 if self.active else 3,
                              "active\n" if self.active else "inactive\n", flat)
        if "is-enabled" in flat:
            return _completed(0 if self.enabled else 1,
                              "enabled\n" if self.enabled else "disabled\n",
                              flat)
        if "show" in flat or "is-system-running" in flat:
            return _completed(
                0,
                f"ActiveState={'active' if self.active else 'inactive'}\n"
                f"UnitFileState={'enabled' if self.enabled else 'disabled'}\n",
                flat)
        return _completed(self.returncode, "", flat)

    @staticmethod
    def _is_systemctl(argv):
        return bool(argv) and os.path.basename(argv[0]) == SYSTEMCTL_BIN_NAME

    # -- observations -----------------------------------------------------

    def systemctl_calls(self):
        return [(argv, existed) for argv, existed in self.calls
                if self._is_systemctl(argv)]

    def systemctl_argvs(self):
        return [argv for argv, _ in self.systemctl_calls()]

    def mutating_verbs(self):
        return [_verb_of(argv) for argv in self.systemctl_argvs()
                if _verb_of(argv) and _verb_of(argv) not in PROBE_VERBS]

    def call_for_verb(self, verb):
        for argv, existed in self.systemctl_calls():
            if _verb_of(argv) == verb:
                return argv, existed
        return None, None


def _fast_install_stage(name):
    """An install stage double that provisions instantly: no subprocess, no
    network, no Bun. Matches the `(target_dir, force)` runner protocol."""
    def _runner(target_dir, force):
        return {"path": os.path.join(target_dir, name), "converged": False}
    return _runner


def _fast_uninstall_stage(name):
    """The `(target_dir, purge)` counterpart."""
    def _runner(target_dir, purge):
        return {"path": os.path.join(target_dir, name), "converged": False}
    return _runner


class _UnitFixtureCase(unittest.TestCase):
    """One tmp root holding EVERY path the install can resolve: a tmp
    `$BUN_INSTALL` (with a fake `bun` and a fake provisioned `crucible-server`
    bin, so `server_launch_argv()` resolves without Bun), a tmp
    `$XDG_CONFIG_HOME` (where a `--user` unit belongs), a tmp `$XDG_DATA_HOME`,
    a tmp `$XDG_RUNTIME_DIR` carrying a fake `bus` socket path, a tmp `$HOME`
    (so even an impl that ignores `$XDG_CONFIG_HOME` and expands `~/.config`
    stays inside the sandbox), a tmp `--target-dir`, an EMPTY `$PATH` dir, and
    a never-executed `systemctl` stand-in."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cr070-unit-")
        self.bun_root = os.path.join(self.root, "bun")
        self.bun_bin_dir = os.path.join(self.bun_root, "bin")
        self.fake_bun = os.path.join(self.bun_bin_dir, BUN_BIN_NAME)
        self.server_bin = os.path.join(self.bun_bin_dir, SERVER_BIN_NAME)
        self.package_dir = os.path.join(
            self.bun_root, *BUN_GLOBAL_NODE_MODULES,
            *SERVER_NPM_PACKAGE.split("/"))

        self.xdg_config = os.path.join(self.root, "config")
        self.xdg_data = os.path.join(self.root, "data")
        self.runtime_dir = os.path.join(self.root, "runtime")
        self.bus_socket = os.path.join(self.runtime_dir, "bus")
        self.fake_home = os.path.join(self.root, "home")
        self.target_dir = os.path.join(self.root, "target")
        self.empty_path_dir = os.path.join(self.root, "empty-path")
        self.systemctl_dir = os.path.join(self.root, "systemd-bin")
        self.fake_systemctl = os.path.join(self.systemctl_dir,
                                           SYSTEMCTL_BIN_NAME)

        for directory in (self.bun_bin_dir, self.xdg_config, self.xdg_data,
                          self.runtime_dir, self.fake_home,
                          self.empty_path_dir, self.systemctl_dir):
            os.makedirs(directory, exist_ok=True)
        # A fake user D-Bus socket PATH: an impl that probes for a bus by path
        # finds one here, and never the operator's /run/user/<uid>/bus.
        Path(self.bus_socket).write_text("", encoding="utf-8")
        self._write_never_executed_systemctl()
        self._write_fake_bun()
        self._provision_server_bin()

        # The isolation ASSERTION baseline: crucible-named entries in the REAL
        # user-unit dir, which no test may add to or remove from.
        self._real_unit_entries = self._real_crucible_unit_entries()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        self.assertEqual(
            self._real_crucible_unit_entries(), self._real_unit_entries,
            f"ISOLATION BREACH: this test changed crucible-named entries in "
            f"the operator's REAL {REAL_USER_UNIT_DIR} -- the unit stage must "
            f"be exercised entirely inside the tmp $XDG_CONFIG_HOME/$HOME")

    # -- fixture builders -------------------------------------------------

    @staticmethod
    def _real_crucible_unit_entries():
        if not os.path.isdir(REAL_USER_UNIT_DIR):
            return None
        return sorted(name for name in os.listdir(REAL_USER_UNIT_DIR)
                      if "crucible" in name.lower())

    def _write_never_executed_systemctl(self):
        """A `systemctl` stand-in that exists ONLY so `shutil.which` can hand
        back an absolute path. `subprocess.run` is patched in every test that
        can reach it, so this is never executed; it exits non-zero without any
        side effect even if it somehow were."""
        Path(self.fake_systemctl).write_text(
            f"#!{sys.executable}\nimport sys\nsys.exit(97)\n",
            encoding="utf-8")
        os.chmod(self.fake_systemctl, 0o755)

    def _write_fake_bun(self):
        """An executable fake `$BUN_INSTALL/bin/bun` that only answers
        `--version`. Nothing in these tests provisions anything through it (the
        server bin is laid down directly), it exists so no resolution path can
        fall through to the operator's real Bun."""
        Path(self.fake_bun).write_text(
            f"#!{sys.executable}\nprint({PINNED_VERSION!r})\n",
            encoding="utf-8")
        os.chmod(self.fake_bun, 0o755)

    def _provision_server_bin(self):
        """The artifact `bun add -g` leaves behind, which is what makes
        `server_launch_argv()` return `[<abs>/bin/crucible-server]`."""
        os.makedirs(self.package_dir, exist_ok=True)
        Path(os.path.join(self.package_dir, "package.json")).write_text(
            f'{{"name": "{SERVER_NPM_PACKAGE}", '
            f'"version": "{PINNED_VERSION}"}}\n', encoding="utf-8")
        Path(self.server_bin).write_text(
            "#!/usr/bin/env bun\n", encoding="utf-8")
        os.chmod(self.server_bin, 0o755)
        return self.server_bin

    def _env(self, **extra):
        env = {
            "BUN_INSTALL": self.bun_root,
            "XDG_CONFIG_HOME": self.xdg_config,
            "XDG_DATA_HOME": self.xdg_data,
            "XDG_RUNTIME_DIR": self.runtime_dir,
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path={self.bus_socket}",
            "HOME": self.fake_home,
            "PATH": self.empty_path_dir,
            "CRUCIBLE_SERVER_VERSION": PINNED_VERSION,
            "CRUCIBLE_NO_BUN_BOOTSTRAP": "1",
            # Never inherit the operator's own knobs: each test sets exactly
            # the ones it asserts on.
            NO_SERVICE_ENV_VAR: None,
            SERVER_HOST_ENV_VAR: None,
            SERVER_PORT_ENV_VAR: None,
            SERVER_DB_ENV_VAR: None,
        }
        env.update(extra)
        return env

    @contextlib.contextmanager
    def _sandboxed(self, recorder, systemctl=True, **env_overrides):
        """Every guard at once: the tmp environment, a `shutil.which` that can
        only reach tmp stand-ins, a `subprocess.run` that never spawns, and a
        non-interactive stdin so no `uninstall` can stall on the purge
        prompt."""
        resolved = self.fake_systemctl if systemctl else None
        with _patched_env(**self._env(**env_overrides)), \
                _non_interactive(), \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_stub(self.bun_bin_dir,
                                                   self.fake_bun, resolved)), \
                mock.patch("crucible_axi.install.subprocess.run",
                           side_effect=recorder):
            yield

    @contextlib.contextmanager
    def _real_unit_stage_only(self, install, recorder, systemctl=True,
                              **env_overrides):
        """As `_sandboxed`, with `[server]`/`[manifest]`/`[config]`/`[store]`
        replaced by instant doubles so the ONLY real stage under test is
        `[unit]`."""
        install_fakes = {SERVER_STAGE: _fast_install_stage(SERVER_STAGE),
                         MANIFEST_STAGE: _fast_install_stage(MANIFEST_STAGE)}
        uninstall_fakes = {
            SERVER_STAGE: _fast_uninstall_stage(SERVER_STAGE),
            CONFIG_STAGE: _fast_uninstall_stage(CONFIG_STAGE),
            STORE_STAGE: _fast_uninstall_stage(STORE_STAGE),
        }
        with self._sandboxed(recorder, systemctl=systemctl, **env_overrides), \
                mock.patch.dict(install.DEFAULT_STAGE_RUNNERS,
                                install_fakes), \
                mock.patch.dict(install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                                uninstall_fakes):
            yield

    # -- observations -----------------------------------------------------

    def _unit_files(self):
        """Every `*.service` file anywhere in the tmp tree -- the unit is
        OBSERVED wherever the stage puts it, so no test has to guess a
        filename, and a unit written outside the sandbox simply is not found
        (and `tearDown` catches it)."""
        return sorted(str(path) for path in Path(self.root).rglob("*.service"))

    def _sole_unit_file(self, why):
        files = self._unit_files()
        self.assertEqual(
            len(files), 1,
            f"exactly ONE systemd unit file must exist under the sandbox -- "
            f"{why}; found {files!r}")
        return files[0]

    def _assert_user_scoped_location(self, unit_path):
        self.assertTrue(
            unit_path.startswith(self.root + os.sep),
            f"the unit must be written inside the sandboxed "
            f"$XDG_CONFIG_HOME/$HOME, never outside it; got {unit_path!r}")
        self.assertIn(
            os.path.join("systemd", "user"), unit_path,
            f"a `--user` unit belongs under `<config>/systemd/user` -- the "
            f"only directory `systemctl --user` reads (spec §Scope: no "
            f"{SYSTEM_UNIT_DIR}/system); got {unit_path!r}")
        self.assertTrue(
            os.path.basename(unit_path).endswith(".service"),
            f"the unit must be a `.service` unit; got {unit_path!r}")
        self.assertIn(
            "crucible", os.path.basename(unit_path).lower(),
            f"the unit must be identifiable as Crucible's; got {unit_path!r}")

    def _require(self, module, attr, why):
        self.assertTrue(
            hasattr(module, attr),
            f"{module.__name__}.{attr} is MISSING -- {why}")
        return getattr(module, attr)

    def _require_unit_runner(self, install, table_name, why):
        table = self._require(install, table_name, why)
        self.assertIn(
            UNIT_STAGE, table,
            f"{table_name} carries no {UNIT_STAGE!r} runner -- nothing "
            f"provisions or reverses the systemd `--user` unit; {why}; "
            f"keys={sorted(table)}")
        runner = table[UNIT_STAGE]
        self.assertTrue(callable(runner),
                        f"{table_name}[{UNIT_STAGE!r}] must be callable; "
                        f"got {runner!r}")
        return runner

    def _decode(self, stdout_text, toon, verb):
        self.assertEqual(
            stdout_text.count("axi:"), 1,
            f"`{verb}` must emit exactly ONE TOON-AXI envelope on stdout; "
            f"stdout={stdout_text!r}")
        axi = toon.decode(stdout_text)["axi"]
        self.assertEqual(axi["verb"], verb, f"envelope={axi!r}")
        return axi

    def _stage_rows(self, axi):
        return [row for row in axi.get("stages", []) if isinstance(row, dict)]

    def _unit_row(self, axi, why):
        rows = [row for row in self._stage_rows(axi)
                if row.get("name") == UNIT_STAGE]
        self.assertEqual(
            len(rows), 1,
            f"the [{UNIT_STAGE}] stage must be reported as its OWN stage row, "
            f"exactly as every other stage is -- {why}; "
            f"stages={axi.get('stages')!r}")
        return rows[0]

    def _states_skipped(self, row):
        """Whether a stage row SAYS it was skipped -- machine-readable
        `skipped: true`, or any string field saying so."""
        if row.get("skipped") is True:
            return True
        return any(isinstance(value, str) and "skip" in value.lower()
                   for value in row.values())

    def _skip_reason(self, row):
        reason = row.get("reason")
        if isinstance(reason, str) and reason.strip():
            return reason
        return ""

    def _assert_skipped_with_reason(self, row, expected_hints, why):
        self.assertTrue(
            self._states_skipped(row),
            f"the [{UNIT_STAGE}] stage row must SAY it was skipped "
            f"(`skipped: true`) -- {why} (AC4); row={row!r}")
        reason = self._skip_reason(row)
        self.assertTrue(
            reason,
            f"a skipped [{UNIT_STAGE}] stage must carry a non-empty `reason` "
            f"naming WHY -- {why}: 'skipped' with no reason leaves the "
            f"operator guessing whether their daemon exists (AC4); "
            f"row={row!r}")
        lowered = reason.lower()
        self.assertTrue(
            any(hint in lowered for hint in expected_hints),
            f"the skip reason must name the actual cause "
            f"(one of {list(expected_hints)}) -- {why}; reason={reason!r}")


class UnitStageIsOrderedInBothDirectionsTest(_UnitFixtureCase):
    """AC2/AC3 (order) -- the `[unit]` stage's POSITION is the contract, in
    both directions, asserted relative to the other stages rather than by mere
    membership."""

    def test_install_runs_the_unit_stage_after_the_server_it_launches(self):
        install, = _import_fresh("crucible_axi.install")
        order = tuple(install.STAGE_ORDER)
        self.assertIn(
            UNIT_STAGE, order,
            f"`STAGE_ORDER` has no [{UNIT_STAGE}] stage -- nothing provisions "
            f"the systemd `--user` unit, so the only persistent run is still a "
            f"foreground `serve` in a terminal (CR-CRU-070 AC1); got {order!r}")
        self.assertEqual(
            order, (SERVER_STAGE, MANIFEST_STAGE, UNIT_STAGE),
            f"install order must be (server, manifest, unit); got {order!r}")
        self.assertGreater(
            order.index(UNIT_STAGE), order.index(SERVER_STAGE),
            f"the [{UNIT_STAGE}] stage must run AFTER [{SERVER_STAGE}]: the "
            f"unit's ExecStart is the provisioned launcher, so enabling it "
            f"before the binary exists would `enable --now` a unit that cannot "
            f"start (AC1); got {order!r}")
        self.assertEqual(
            order.index(UNIT_STAGE), len(order) - 1,
            f"the [{UNIT_STAGE}] stage is the LAST install stage -- it is the "
            f"only one that hands work to another supervisor, so everything it "
            f"depends on must already be converged; got {order!r}")
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "the unit stage must be an injectable runner in the same "
            "module-level table every other install stage lives in (AC1)")

    def test_uninstall_tears_the_unit_down_first_and_keeps_purge_last(self):
        install, = _import_fresh("crucible_axi.install")
        order = tuple(install.UNINSTALL_STAGE_ORDER)
        self.assertIn(
            UNIT_STAGE, order,
            f"`UNINSTALL_STAGE_ORDER` has no [{UNIT_STAGE}] stage -- an "
            f"uninstall would remove the server package and LEAVE an enabled "
            f"unit pointing at the deleted binary (AC3); got {order!r}")
        self.assertEqual(
            order, (UNIT_STAGE, SERVER_STAGE, CONFIG_STAGE, STORE_STAGE),
            f"teardown order must be (unit, server, config, store); "
            f"got {order!r}")
        self.assertEqual(
            order[0], UNIT_STAGE,
            f"the [{UNIT_STAGE}] stage must be torn down FIRST -- stopping "
            f"the supervisor before removing what it supervises (AC3); "
            f"got {order!r}")
        self.assertLess(
            order.index(SERVER_STAGE), order.index(CONFIG_STAGE),
            f"destructive-last (CR-CRU-069) must survive this CR: the program "
            f"stages precede the purge stages; got {order!r}")
        self.assertLess(
            order.index(CONFIG_STAGE), order.index(STORE_STAGE),
            f"[{STORE_STAGE}] is the irreplaceable artifact and goes "
            f"absolutely last; got {order!r}")
        self.assertEqual(
            order[-1], STORE_STAGE,
            f"destructive-last: [{STORE_STAGE}] stays the final stage; "
            f"got {order!r}")
        self._require_unit_runner(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "the teardown needs the same injectable runner table the other "
            "inverse stages use (AC3)")


class UnitExecStartComesFromServerLaunchArgvTest(_UnitFixtureCase):
    """AC1 -- the unit RUNS the server the way `serve` does: `ExecStart` is the
    argv `install.server_launch_argv()` resolved, absolute, never a bare
    PATH-dependent token, with `Restart=on-failure` and
    `WantedBy=default.target`."""

    def _install_and_read_unit(self, install, cli, recorder, **env_overrides):
        with self._real_unit_stage_only(install, recorder, **env_overrides):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(
            code, 0,
            f"an install whose only real stage is [{UNIT_STAGE}] must exit 0; "
            f"stdout={out!r} stderr={err!r}")
        unit = self._sole_unit_file(
            f"the [{UNIT_STAGE}] stage must WRITE the unit file (AC1); "
            f"stdout={out!r} stderr={err!r}")
        self._assert_user_scoped_location(unit)
        return Path(unit).read_text(encoding="utf-8")

    def test_execstart_is_the_absolute_argv_server_launch_argv_resolved(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage to render an ExecStart from (AC1)")
        sentinel = [os.path.join(self.root, "sentinel-launcher",
                                 "crucible-server-sentinel"),
                    "--sentinel-flag"]
        recorder = _SystemctlRecorder(self)
        with mock.patch.object(install, "server_launch_argv",
                               return_value=list(sentinel)) as launch:
            text = self._install_and_read_unit(install, cli, recorder)

        self.assertTrue(
            launch.called,
            f"the unit's ExecStart must be DERIVED from "
            f"`install.server_launch_argv()` -- the function CR-CRU-066 built "
            f"for exactly this unit (absolute, never a bare token). It was "
            f"never called, so the ExecStart was hand-built; unit={text!r}")
        exec_lines = [line.strip() for line in text.splitlines()
                      if line.strip().startswith("ExecStart=")]
        self.assertEqual(
            len(exec_lines), 1,
            f"the unit must carry exactly one `ExecStart=`; unit={text!r}")
        value = exec_lines[0].split("=", 1)[1].strip().lstrip("-@+!")
        for token in sentinel:
            self.assertIn(
                token, value,
                f"`ExecStart=` must be the argv `server_launch_argv()` "
                f"returned, verbatim -- {token!r} is missing, so the unit runs "
                f"something else than `serve` does (AC1); "
                f"ExecStart={value!r}")
        argv0 = shlex.split(value)[0]
        self.assertTrue(
            os.path.isabs(argv0),
            f"`ExecStart` must be ABSOLUTE: a systemd `--user` unit inherits "
            f"no shell PATH, which is why CR-CRU-066 resolves absolutely "
            f"(AC1); got {argv0!r}")
        self.assertNotIn(
            argv0, (SERVER_BIN_NAME, BUN_BIN_NAME, BUNX_BIN_NAME),
            f"`ExecStart` must never be a BARE "
            f"`{SERVER_BIN_NAME}`/`{BUN_BIN_NAME}`/`{BUNX_BIN_NAME}` token -- "
            f"the unit's minimal PATH resolves none of them (AC1); "
            f"got {argv0!r}")

        stripped = [line.strip() for line in text.splitlines()]
        for section in ("[Unit]", "[Service]", "[Install]"):
            self.assertIn(
                section, stripped,
                f"the unit needs a {section} section -- without [Install] "
                f"there is nothing for `enable` to link (AC1); unit={text!r}")
        self.assertIn(
            "Restart=on-failure", stripped,
            f"AC1 requires `Restart=on-failure`: a crashed server must come "
            f"back, while a clean `systemctl --user stop` must not; "
            f"unit={text!r}")
        self.assertIn(
            "WantedBy=default.target", stripped,
            f"AC1 requires `WantedBy=default.target` -- the only way "
            f"`enable` makes the daemon come up on login; unit={text!r}")

    def test_the_unit_forwards_the_crucible_env_contract_it_cannot_inherit(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage to carry the CRUCIBLE_* contract (AC1)")
        db_path = os.path.join(self.xdg_data, "crucible", "crucible.db")
        expected = {
            SERVER_HOST_ENV_VAR: "127.0.0.5",
            SERVER_PORT_ENV_VAR: "4711",
            SERVER_DB_ENV_VAR: db_path,
        }
        recorder = _SystemctlRecorder(self)
        with mock.patch.object(install, "server_launch_argv",
                               return_value=[self.server_bin]):
            text = self._install_and_read_unit(install, cli, recorder,
                                               **expected)
        assignments = {}
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith("Environment="):
                continue
            payload = stripped.split("=", 1)[1].strip().strip('"').strip("'")
            if "=" not in payload:
                continue
            name, value = payload.split("=", 1)
            assignments[name.strip()] = value.strip().strip('"').strip("'")
        for name, value in expected.items():
            self.assertIn(
                name, assignments,
                f"the unit must forward ${name} explicitly: a `--user` unit "
                f"inherits neither the operator's PATH nor their exports, so "
                f"an un-forwarded knob silently reverts to the default (AC1); "
                f"Environment assignments={assignments!r}")
            self.assertEqual(
                assignments[name], value,
                f"${name} must be forwarded with the value the install saw "
                f"({value!r}); Environment assignments={assignments!r}")

        # The inverse: an UNSET knob must not become an empty assignment --
        # `Environment=CRUCIBLE_PORT=` would override the server's own default
        # with nothing.
        recorder2 = _SystemctlRecorder(self)
        shutil.rmtree(os.path.join(self.xdg_config, "systemd"),
                      ignore_errors=True)
        with mock.patch.object(install, "server_launch_argv",
                               return_value=[self.server_bin]):
            bare = self._install_and_read_unit(install, cli, recorder2)
        for name in expected:
            self.assertNotIn(
                f"Environment={name}=\n", bare + "\n",
                f"an UNSET ${name} must not be forwarded as an EMPTY "
                f"assignment -- that overrides the server's own default with "
                f"nothing (AC1); unit={bare!r}")


class UnitInstallStageWritesReloadsThenEnablesTest(_UnitFixtureCase):
    """AC2 (install half) -- the stage WRITES the unit, then `daemon-reload`s,
    then `enable --now`s: in that order, because reloading before the file
    exists tells systemd nothing and enabling before the reload enables the
    stale definition."""

    def test_the_unit_is_written_then_daemon_reloaded_then_enabled_now(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "nothing writes, reloads or enables a unit today (AC2)")
        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"the install must exit 0; stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self._unit_row(axi, "a provisioned daemon must be visible to the "
                            "operator, not silent (AC2)")
        unit = self._sole_unit_file(
            f"the [{UNIT_STAGE}] stage must WRITE the unit file (AC2); "
            f"stdout={out!r} stderr={err!r}")
        self._assert_user_scoped_location(unit)

        self.assertEqual(
            recorder.mutating_verbs(), ["daemon-reload", "enable"],
            f"the stage's MUTATING systemctl sequence must be exactly "
            f"`daemon-reload` then `enable` (AC2); "
            f"recorded={recorder.systemctl_argvs()!r}")
        reload_argv, unit_existed_at_reload = recorder.call_for_verb(
            "daemon-reload")
        self.assertIsNotNone(
            reload_argv,
            f"the stage must `daemon-reload` after writing the unit, or "
            f"systemd never learns the unit exists (AC2); "
            f"recorded={recorder.systemctl_argvs()!r}")
        self.assertTrue(
            unit_existed_at_reload,
            f"the unit file must be WRITTEN BEFORE `daemon-reload` -- "
            f"reloading first makes systemd re-read a directory that does not "
            f"yet contain the unit, and the following `enable` fails on an "
            f"unknown unit (AC2); recorded={recorder.systemctl_argvs()!r}")
        enable_argv, _ = recorder.call_for_verb("enable")
        self.assertIsNotNone(
            enable_argv,
            f"the stage must `enable` the unit -- an installed-but-disabled "
            f"unit is not a daemon (AC2); "
            f"recorded={recorder.systemctl_argvs()!r}")
        self.assertIn(
            "--now", enable_argv,
            f"`enable` must carry `--now`: AC2 says the install STARTS the "
            f"service, not merely arranges for it at next login; "
            f"argv={enable_argv!r}")
        self.assertTrue(
            any(os.path.basename(unit) in token for token in enable_argv),
            f"the `enable` invocation must name the unit it just wrote "
            f"({os.path.basename(unit)!r}); argv={enable_argv!r}")


class UnitInstallStageIsIdempotentTest(_UnitFixtureCase):
    """AC2 (idempotence) -- re-running CONVERGES: an unchanged unit is not
    rewritten and an already-active service is not restarted. Re-writing would
    churn the mtime every install; restarting would drop every live SSE
    subscriber for no reason."""

    def test_a_second_install_neither_rewrites_nor_restarts(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        unit_runner = self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage to converge (AC2)")

        first = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, first):
            code1, out1, err1 = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(
            code1, 0,
            f"fixture: the FIRST install must succeed; "
            f"stdout={out1!r} stderr={err1!r}")
        unit = self._sole_unit_file("the first install writes the unit (AC2)")

        # Age the file: any rewrite is then visible as a newer mtime, which is
        # exactly what "not rewritten" means on disk.
        aged = time.time() - 3600
        os.utime(unit, (aged, aged))
        before_stat = os.stat(unit)
        before_text = Path(unit).read_text(encoding="utf-8")

        # The second run meets a unit that is already ACTIVE and ENABLED.
        second = _SystemctlRecorder(self, active=True, enabled=True)
        with self._real_unit_stage_only(install, second):
            code2, out2, err2 = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])

        self.assertEqual(
            code2, 0,
            f"a re-run must exit 0 (AC2); stdout={out2!r} stderr={err2!r}")
        axi = self._decode(out2, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        after_stat = os.stat(unit)
        self.assertEqual(
            after_stat.st_mtime_ns, before_stat.st_mtime_ns,
            f"an UNCHANGED unit must not be rewritten -- its mtime moved from "
            f"{before_stat.st_mtime_ns} to {after_stat.st_mtime_ns} (AC2)")
        self.assertEqual(
            Path(unit).read_text(encoding="utf-8"), before_text,
            "a converged re-install must leave the unit byte-identical (AC2)")
        offending = [argv for argv in second.systemctl_argvs()
                     if _verb_of(argv) in RESTART_VERBS]
        self.assertEqual(
            offending, [],
            f"an ALREADY-ACTIVE service must not be restarted or stopped by a "
            f"re-install -- that drops every live SSE subscriber for nothing "
            f"(AC2); offending={offending!r}")

        # The runner's own answer: convergence must be REPORTED, not inferred.
        with self._sandboxed(_SystemctlRecorder(self, active=True,
                                                enabled=True)):
            result = unit_runner(self.target_dir, False)
        self.assertIs(
            result.get("converged"), True,
            f"the [{UNIT_STAGE}] runner must report `converged: True` when the "
            f"unit is unchanged and the service already active (AC2); "
            f"result={result!r}")
        self.assertEqual(
            os.stat(unit).st_mtime_ns, before_stat.st_mtime_ns,
            "the converged runner call must still not rewrite the unit (AC2)")


class UnitUninstallStageDisablesRemovesReloadsTest(_UnitFixtureCase):
    """AC2 (teardown half) -- `disable --now`, remove the unit file,
    `daemon-reload`: disabling last would leave systemd holding a unit whose
    file is gone, and skipping the reload leaves the removed unit loaded until
    the next login."""

    def _install_then(self, install, cli, second_argv, second_recorder,
                      **env_overrides):
        first = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, first, **env_overrides):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(
            code, 0,
            f"fixture: the install that provisions the unit must succeed; "
            f"stdout={out!r} stderr={err!r}")
        self._sole_unit_file("fixture: the install writes the unit")
        with self._real_unit_stage_only(install, second_recorder,
                                        **env_overrides):
            return _run_cli(cli, second_argv)

    def test_teardown_disables_now_removes_the_unit_then_daemon_reloads(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "nothing disables or removes the unit today (AC2/AC3)")
        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        code, out, err = self._install_then(
            install, cli, ["uninstall", "--target-dir", self.target_dir],
            recorder)

        self.assertEqual(
            code, 0,
            f"the uninstall must exit 0; stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "uninstall")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self._unit_row(axi, "the teardown of a daemon must be reported (AC2)")
        self.assertEqual(
            self._unit_files(), [],
            f"the [{UNIT_STAGE}] stage must REMOVE the unit file -- an "
            f"uninstall that leaves it behind leaves an enabled unit pointing "
            f"at a deleted binary (AC2/AC3)")
        self.assertEqual(
            recorder.mutating_verbs(), ["disable", "daemon-reload"],
            f"the teardown's MUTATING systemctl sequence must be exactly "
            f"`disable` then `daemon-reload` (AC2); "
            f"recorded={recorder.systemctl_argvs()!r}")
        disable_argv, existed_at_disable = recorder.call_for_verb("disable")
        self.assertIsNotNone(
            disable_argv,
            f"the teardown must `disable` the unit; "
            f"recorded={recorder.systemctl_argvs()!r}")
        self.assertIn(
            "--now", disable_argv,
            f"`disable` must carry `--now`: the running service has to STOP, "
            f"not merely be de-linked for the next login (AC2); "
            f"argv={disable_argv!r}")
        self.assertTrue(
            existed_at_disable,
            f"`disable --now` must run while the unit file is still PRESENT -- "
            f"disabling a unit whose file is already gone cannot stop the "
            f"running service (AC2); "
            f"recorded={recorder.systemctl_argvs()!r}")
        _, existed_at_reload = recorder.call_for_verb("daemon-reload")
        self.assertIs(
            existed_at_reload, False,
            f"the final `daemon-reload` must run AFTER the unit file is "
            f"removed, so systemd forgets the unit instead of keeping it "
            f"loaded (AC2); recorded={recorder.systemctl_argvs()!r}")

    def test_teardown_converges_with_no_systemctl_call_when_no_unit_exists(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "convergence on an absent unit is AC2's second half")
        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"an uninstall on a machine that never installed a unit must exit "
            f"0 (AC2); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "uninstall")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        row = self._unit_row(axi, "an already-absent unit still reports its "
                                  "stage (AC2)")
        self.assertIs(
            row.get("converged"), True,
            f"an already-absent unit must report `converged: true`, exactly as "
            f"the [{SERVER_STAGE}] inverse does (AC2); row={row!r}")
        self.assertEqual(
            recorder.systemctl_argvs(), [],
            f"an absent unit must converge from the FILESYSTEM, spawning no "
            f"systemctl at all -- the [{SERVER_STAGE}] inverse sets exactly "
            f"this precedent (CR-CRU-069 AC3); "
            f"recorded={recorder.systemctl_argvs()!r}")


class UnitTeardownPrecedesServerDeprovisionTest(_UnitFixtureCase):
    """AC3 -- the order is ENFORCED, not documented. This test is the one that
    fails if the `[unit]` and `[server]` teardown stages ever swap: the harm is
    concrete and observable -- systemd left restarting a deleted binary."""

    def test_the_unit_stage_must_run_before_the_server_binary_is_deleted(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        order = tuple(install.UNINSTALL_STAGE_ORDER)
        self.assertIn(
            UNIT_STAGE, order,
            f"there is no [{UNIT_STAGE}] teardown stage at all, so an "
            f"uninstall deletes `{SERVER_BIN_NAME}` and leaves systemd "
            f"restarting a deleted binary (AC3); got {order!r}")
        self.assertLess(
            order.index(UNIT_STAGE), order.index(SERVER_STAGE),
            f"[{UNIT_STAGE}] MUST precede [{SERVER_STAGE}] in "
            f"UNINSTALL_STAGE_ORDER. Inverted, `bun remove -g` deletes the "
            f"binary while the unit is still enabled with "
            f"`Restart=on-failure`: systemd is left restarting a DELETED "
            f"binary, failing in a loop with no operator on the terminal to "
            f"see it (AC3); got {order!r}")

        observed = []
        seen = {}

        def unit_runner(target_dir, purge):
            observed.append(UNIT_STAGE)
            seen["server_bin_present"] = os.path.isfile(self.server_bin)
            return {"path": os.path.join(target_dir, "unit.service"),
                    "converged": False}

        def server_runner(target_dir, purge):
            observed.append(SERVER_STAGE)
            # What `bun remove -g` really does: the launcher disappears.
            if os.path.lexists(self.server_bin):
                os.remove(self.server_bin)
            return {"path": self.server_bin, "converged": False}

        fakes = {
            UNIT_STAGE: unit_runner,
            SERVER_STAGE: server_runner,
            CONFIG_STAGE: _fast_uninstall_stage(CONFIG_STAGE),
            STORE_STAGE: _fast_uninstall_stage(STORE_STAGE),
        }
        with _patched_env(**self._env()), _non_interactive(), \
                mock.patch.dict(install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                                fakes):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"fixture: the doubled uninstall must exit 0; "
            f"stdout={out!r} stderr={err!r}")
        self.assertIn(
            UNIT_STAGE, observed,
            f"the [{UNIT_STAGE}] teardown stage never RAN: `run_uninstall` "
            f"iterates UNINSTALL_STAGE_ORDER, which does not contain it, so "
            f"the unit survives the uninstall entirely (AC3); "
            f"ran {observed!r}")
        self.assertLess(
            observed.index(UNIT_STAGE), observed.index(SERVER_STAGE),
            f"the [{UNIT_STAGE}] stage ran AFTER [{SERVER_STAGE}] -- systemd "
            f"is left restarting a deleted binary (AC3); ran {observed!r}")
        self.assertTrue(
            seen.get("server_bin_present"),
            f"when the [{UNIT_STAGE}] stage ran, the launcher its ExecStart "
            f"points at was ALREADY DELETED -- the exact harm AC3 exists to "
            f"prevent: systemd left restarting a deleted binary; "
            f"ran {observed!r}")


class AbsentSystemdSkipsWithAReasonTest(_UnitFixtureCase):
    """AC4 -- absent systemd DEGRADES, never fails: no `systemctl` (a
    container, macOS) or no user D-Bus session means the `[unit]` stage reports
    skipped WITH a reason and the run still exits 0."""

    def test_install_skips_the_unit_stage_when_systemctl_is_absent(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage to skip gracefully (AC4)")
        recorder = _SystemctlRecorder(self, absent=True)
        with self._real_unit_stage_only(install, recorder, systemctl=False):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"an install on a machine with NO systemctl must still exit 0 -- "
            f"the base install has no systemd dependency (AC4); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(
            axi["ok"], True,
            f"a skipped [{UNIT_STAGE}] stage must never make the overall "
            f"install not-ok (AC4); envelope={axi!r}")
        row = self._unit_row(axi, "a skip has to be VISIBLE -- silently "
                                  "installing no daemon is the bug (AC4)")
        self._assert_skipped_with_reason(
            row, ("systemctl", "systemd", "not found", "absent",
                  "unavailable", "no user"),
            "no `systemctl` is resolvable on this machine")
        self.assertEqual(
            self._unit_files(), [],
            f"with no systemd there is nothing to read the unit, so the stage "
            f"must not leave a file behind (AC4); "
            f"found {self._unit_files()!r}")

    def test_uninstall_skips_the_unit_stage_when_systemctl_is_absent(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "the teardown must degrade the same way the install does (AC4)")
        recorder = _SystemctlRecorder(self, absent=True)
        with self._real_unit_stage_only(install, recorder, systemctl=False):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"an uninstall on a machine with NO systemctl must still exit 0 "
            f"(AC4); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "uninstall")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        row = self._unit_row(axi, "the skipped teardown stage is still "
                                  "reported (AC4)")
        self._assert_skipped_with_reason(
            row, ("systemctl", "systemd", "not found", "absent",
                  "unavailable", "no user"),
            "no `systemctl` is resolvable, so there is no unit to disable")

    def test_install_skips_the_unit_stage_with_no_user_dbus_session(self):
        """The second half of AC4: `systemctl` EXISTS but there is no user bus
        (an ssh session with no `systemd --user`, a CI container). Every
        invocation fails with `Failed to connect to bus`, which must degrade to
        a skip -- not to a failed install."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage to degrade without a user bus (AC4)")
        os.remove(self.bus_socket)
        recorder = _SystemctlRecorder(self, bus_failure=True)
        with self._real_unit_stage_only(install, recorder,
                                        XDG_RUNTIME_DIR=None,
                                        DBUS_SESSION_BUS_ADDRESS=None):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])

        self.assertEqual(
            code, 0,
            f"no user D-Bus session must degrade to a skip, never to a failed "
            f"install (AC4); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        row = self._unit_row(axi, "the bus-less skip is reported like any "
                                  "other stage (AC4)")
        self._assert_skipped_with_reason(
            row, ("bus", "dbus", "session", "systemd", "systemctl",
                  "unavailable"),
            "there is no user D-Bus session to talk to")
        self.assertEqual(
            [argv for argv in recorder.systemctl_argvs()
             if _verb_of(argv) in ("enable", "start", "daemon-reload")], [],
            f"without a bus the stage must not press on with `daemon-reload`/"
            f"`enable` -- every one of them fails and the install would report "
            f"a broken daemon (AC4); recorded={recorder.systemctl_argvs()!r}")


class ExplicitOptOutSkipsTheUnitStageTest(_UnitFixtureCase):
    """AC4 (opt-out) -- `--no-service` and `CRUCIBLE_NO_SERVICE=1` say "do not
    manage my systemd". An opt-out must not even PROBE: on a machine with a
    perfectly good user manager, the flag is the only reason nothing happens."""

    def test_the_no_service_flag_skips_the_unit_stage_and_exits_zero(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage to opt out of (AC4)")
        self.assertIn(
            "no_service", inspect.signature(install.run_install).parameters,
            f"`run_install` must take a `no_service` opt-out, threaded to the "
            f"[{UNIT_STAGE}] stage exactly as `no_bun_bootstrap` is threaded "
            f"to [{SERVER_STAGE}] (AC4); "
            f"signature={inspect.signature(install.run_install)}")
        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir,
                      NO_SERVICE_FLAG])

        self.assertNotIn(
            "unrecognized arguments", err,
            f"`install {NO_SERVICE_FLAG}` is not even a recognised flag -- AC4 "
            f"requires an explicit opt-out from the systemd stage; "
            f"stderr={err!r}")
        self.assertEqual(
            code, 0,
            f"`install {NO_SERVICE_FLAG}` must exit 0 (AC4); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        row = self._unit_row(axi, "an opt-out must be reported, so the "
                                  "operator sees WHY there is no daemon (AC4)")
        self._assert_skipped_with_reason(
            row, ("no-service", "no_service", "opt", NO_SERVICE_ENV_VAR.lower(),
                  "requested", "disabled"),
            f"`{NO_SERVICE_FLAG}` was passed explicitly")
        self.assertEqual(
            recorder.systemctl_argvs(), [],
            f"an explicit opt-out must not run systemctl AT ALL, not even a "
            f"probe (AC4); recorded={recorder.systemctl_argvs()!r}")
        self.assertEqual(
            self._unit_files(), [],
            f"`{NO_SERVICE_FLAG}` must write no unit; "
            f"found {self._unit_files()!r}")

    def test_the_no_service_env_var_skips_both_install_and_uninstall(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage for the env opt-out to skip (AC4)")
        self._require_unit_runner(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "the env opt-out must hold on the teardown side too (AC4)")

        # Install with the env opt-out set: nothing provisioned, exit 0.
        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder,
                                        **{NO_SERVICE_ENV_VAR: "1"}):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(
            code, 0,
            f"${NO_SERVICE_ENV_VAR}=1 must skip the unit stage and exit 0 "
            f"(AC4); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self._assert_skipped_with_reason(
            self._unit_row(axi, "the env opt-out is reported (AC4)"),
            ("no-service", "no_service", "opt", NO_SERVICE_ENV_VAR.lower(),
             "requested", "disabled", "environment"),
            f"${NO_SERVICE_ENV_VAR} is set")
        self.assertEqual(
            recorder.systemctl_argvs(), [],
            f"${NO_SERVICE_ENV_VAR}=1 must run no systemctl at all (AC4); "
            f"recorded={recorder.systemctl_argvs()!r}")
        self.assertEqual(self._unit_files(), [], "no unit may be written")

        # Now provision a unit for real, then uninstall WITH the opt-out: the
        # unit the operator manages themselves must be left exactly alone.
        provisioning = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, provisioning):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(
            code, 0,
            f"fixture: the provisioning install must succeed; "
            f"stdout={out!r} stderr={err!r}")
        unit = self._sole_unit_file("fixture: a unit to leave alone")
        before = Path(unit).read_text(encoding="utf-8")

        teardown = _SystemctlRecorder(self, active=True, enabled=True)
        with self._real_unit_stage_only(install, teardown,
                                        **{NO_SERVICE_ENV_VAR: "1"}):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])
        self.assertEqual(
            code, 0,
            f"an opted-out uninstall must exit 0 (AC4); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "uninstall")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self._assert_skipped_with_reason(
            self._unit_row(axi, "the opted-out teardown is reported (AC4)"),
            ("no-service", "no_service", "opt", NO_SERVICE_ENV_VAR.lower(),
             "requested", "disabled", "environment"),
            f"${NO_SERVICE_ENV_VAR} is set")
        self.assertTrue(
            os.path.isfile(unit),
            f"an opted-out teardown must LEAVE the unit file in place -- the "
            f"operator asked crucible-axi not to manage their systemd (AC4)")
        self.assertEqual(
            Path(unit).read_text(encoding="utf-8"), before,
            "the opted-out teardown must not modify the unit either (AC4)")
        self.assertEqual(
            teardown.systemctl_argvs(), [],
            f"an opted-out teardown must run no systemctl at all (AC4); "
            f"recorded={teardown.systemctl_argvs()!r}")


class UnitIsUserScopedOnlyTest(_UnitFixtureCase):
    """§Scope -- `--user` only: no root, no `sudo`, no `/etc/systemd/system`.
    Consistent with the user-scoped `bun add -g` install, and the reason the
    whole install needs no privilege escalation."""

    def test_every_systemctl_invocation_is_user_scoped(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no unit stage whose scope can be asserted (§Scope)")
        self._require_unit_runner(
            install, "DEFAULT_UNINSTALL_STAGE_RUNNERS",
            "there is no unit teardown whose scope can be asserted (§Scope)")

        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        teardown = _SystemctlRecorder(self, active=True, enabled=True)
        with self._real_unit_stage_only(install, teardown):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        recorded = recorder.systemctl_argvs() + teardown.systemctl_argvs()
        self.assertTrue(
            recorded,
            f"a full install+uninstall round trip invoked systemctl ZERO "
            f"times -- there is no systemd surface at all (AC1/AC2); "
            f"install={recorder.calls!r} uninstall={teardown.calls!r}")
        for argv in recorded:
            self.assertIn(
                "--user", argv,
                f"EVERY systemctl invocation must be `--user`-scoped: a "
                f"system-scope call would need root, which this install never "
                f"has (§Scope); argv={argv!r}")
            self.assertTrue(
                os.path.isabs(argv[0]),
                f"systemctl must be invoked by RESOLVED ABSOLUTE path, never "
                f"as a bare token off an inherited PATH (CR-CRU-066 §S2 "
                f"discipline); argv={argv!r}")
            for token in argv:
                self.assertNotIn(
                    token, FORBIDDEN_ARGV_TOKENS,
                    f"a `--user`-only install must never escalate privilege "
                    f"or address the system manager (§Scope); argv={argv!r}")
                self.assertNotIn(
                    SYSTEM_UNIT_DIR, token,
                    f"no invocation may name the SYSTEM unit directory "
                    f"(§Scope); argv={argv!r}")
        for argv, _ in recorder.calls + teardown.calls:
            self.assertNotIn(
                os.path.basename(argv[0]), FORBIDDEN_ARGV_TOKENS,
                f"no subprocess may be a privilege-escalation wrapper "
                f"(§Scope); argv={argv!r}")

    def test_no_code_literal_names_a_system_scope_target_or_sudo(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._require_unit_runner(
            install, "DEFAULT_STAGE_RUNNERS",
            "there is no systemd surface to scope-check yet (§Scope)")
        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        unit = self._sole_unit_file(
            "the scope of a unit can only be checked once one is written")
        self._assert_user_scoped_location(unit)
        text = Path(unit).read_text(encoding="utf-8")
        self.assertNotIn(
            SYSTEM_UNIT_DIR, text,
            f"the unit itself must not reference the system manager's "
            f"directory (§Scope); unit={text!r}")
        for token in FORBIDDEN_ARGV_TOKENS:
            self.assertNotIn(
                token, text,
                f"the unit must not name {token!r} -- a `--user` service runs "
                f"as the operator, with no escalation (§Scope); unit={text!r}")

        for module_path in (REPO_ROOT / "crucible_axi" / "install.py",
                            REPO_ROOT / "crucible_axi" / "cli.py"):
            for literal in _code_string_literals(str(module_path)):
                if SYSTEM_UNIT_DIR in literal and not any(
                        ch.isspace() for ch in literal):
                    self.fail(
                        f"{module_path.name} builds a SYSTEM-scope systemd "
                        f"path from {literal!r} -- the unit is `--user` only, "
                        f"no root, no {SYSTEM_UNIT_DIR}/system (§Scope)")
                self.assertNotIn(
                    literal, FORBIDDEN_ARGV_TOKENS,
                    f"{module_path.name} carries the executable literal "
                    f"{literal!r}: a `--user`-only install never escalates "
                    f"privilege nor addresses the system manager (§Scope)")


if __name__ == "__main__":
    unittest.main()
