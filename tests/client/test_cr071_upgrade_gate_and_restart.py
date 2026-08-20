"""CR-CRU-071 C3 -- AC8 (the upgrade is GATED on a safe migration) and AC9 (an
upgrade RESTARTS the daemon), asserted through `crucible_axi`'s install stages.

Both ACs are the same code path seen from two ends, which is why one suite owns
them:

* AC9 -- `bun add -g` replaces the package on disk while the running unit still
  holds the OLD code in memory. The unit's `ExecStart` is a version-INDEPENDENT
  `$BUN_INSTALL/bin/crucible-server`, so the rendered unit is byte-identical on
  an upgrade and CR-CRU-070's `changed == False` path deliberately leaves an
  already-active service alone ("a restart drops every live SSE subscriber").
  Only the `[server]` stage knows it re-provisioned, so it must SAY so and the
  `[unit]` stage must restart on that signal ALONE -- never by re-reading the
  installed version or re-resolving the pin, because two sources of truth for
  "did the server advance?" is how this bug appeared.
* AC8 -- that restart is exactly WHERE the new build opens (and migrates) the
  store. A store the new build refuses to open (AC5, too-new schema) or a
  migration that threw (AC7) makes the start fail, and today the `[unit]`
  stage throws the manager's answer away: `_run_systemctl`'s
  `CompletedProcess` is ignored for `enable --now`, so a broken upgrade
  reports `ok: true`. The gate is: a START that fails FAILS THE RUN, with the
  server's own message -- which names the `<store>.pre-upgrade-<epoch>` backup
  -- surfaced rather than swallowed.

The rejected design is asserted too: no version substring may appear in
`ExecStart`. Embedding one would force a text change on every upgrade and break
CR-CRU-070's unchanged-unit-is-not-rewritten guarantee.

ISOLATION. Nothing here spawns a process, binds a port, or touches the
operator's real systemd, Bun, store or `~/.config/systemd/user`: the fixture
(copied from CR-CRU-070's, which is the systemd contract's fixture) gives the
install a tmp `$BUN_INSTALL`/`$XDG_CONFIG_HOME`/`$XDG_DATA_HOME`/
`$XDG_RUNTIME_DIR`/`$HOME`, a `shutil.which` that can only reach tmp
stand-ins, a `subprocess.run` that records instead of running, and a `tearDown`
that DIFFS the operator's real user-unit directory so a breach fails the test
rather than the machine.

The AC8 SEAM. The failure is modelled at the systemd boundary -- the recorder
answers the start verb with a non-zero returncode and the server's real message
-- rather than by booting the published server against a future-stamped store:
the installer never opens the store itself (the server does, at boot), so the
boundary the installer can observe IS the start outcome, and driving a real
`bun` would leave the sandbox this suite depends on. That the modelled text is
the REAL text is not assumed: `StoreRefusalTextIsTheServersOwnTest` reads
`src/store.ts` and pins the tokens the fixtures use.
"""

import contextlib
import importlib
import importlib.util
import inspect
import io
import os
import re
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
BUN_GLOBAL_NODE_MODULES = ("install", "global", "node_modules")

SYSTEMCTL_BIN_NAME = "systemctl"

SERVER_STAGE = "server"
MANIFEST_STAGE = "manifest"
UNIT_STAGE = "unit"

NO_SERVICE_ENV_VAR = "CRUCIBLE_NO_SERVICE"
SERVER_HOST_ENV_VAR = "CRUCIBLE_HOST"
SERVER_PORT_ENV_VAR = "CRUCIBLE_PORT"
SERVER_DB_ENV_VAR = "CRUCIBLE_DB"

# systemctl verbs that are PROBES (free to appear anywhere) versus the ones
# that RE-EXEC the service, which is what AC9 requires on an upgrade and
# CR-CRU-070's idempotence forbids everywhere else.
PROBE_VERBS = frozenset({
    "is-active", "is-enabled", "is-failed", "show", "cat", "status",
    "list-units", "list-unit-files", "get-default", "is-system-running",
    "show-environment",
})
RESTART_VERBS = frozenset({
    "restart", "try-restart", "reload-or-restart", "try-reload-or-restart",
})
# Verbs that STOP a service outright: never acceptable from an install, even an
# upgrade -- a restart re-execs, a stop just kills the daemon.
STOP_VERBS = frozenset({"stop", "kill"})

# The real user-unit directory, only ever READ (and only for the isolation
# assertion in `tearDown`).
REAL_USER_UNIT_DIR = os.path.join(
    os.path.expanduser("~"), ".config", "systemd", "user")

# The server's own store errors (`src/store.ts`), whose text the installer must
# SURFACE. Pinned against the real source by
# `StoreRefusalTextIsTheServersOwnTest` so these fixtures cannot drift into
# fiction.
REFUSAL_NEEDLE = "REFUSING TO OPEN"
MIGRATION_FAILURE_NEEDLE = "MIGRATION FAILED"
BACKUP_SUFFIX_NEEDLE = "pre-upgrade"

# Anything that looks like a version number: what `ExecStart` must NOT carry
# (AC9, rejected design).
_VERSION_LIKE = re.compile(r"\d+\.\d+\.\d+")


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
        "crucible_toon_cr071", str(REPO_ROOT / "clients" / "toon.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _completed(returncode, stdout, argv, stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr,
                           args=argv)


def _which_stub(bun_bin_dir, fake_bun, systemctl_path):
    """A `shutil.which` stand-in with two independent guards: `systemctl`
    resolves ONLY to the tmp stand-in (or to `None`, which is how "no systemd
    on this machine" is modelled), and a BARE `bun` token never resolves, so no
    test can reach the operator's real Bun."""
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


class _NonInteractiveStdin:
    """A stdin stand-in that is never a TTY, so nothing can stall on a
    prompt."""

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
    with mock.patch("sys.stdin", new=_NonInteractiveStdin()), \
            mock.patch("os.isatty", return_value=False):
        yield


class _SystemctlRecorder:
    """A `subprocess.run` stand-in for `crucible_axi.install`.

    It NEVER spawns a process -- that is what keeps the operator's systemd
    untouched -- and records, per call, the flattened argv plus whether a unit
    file existed IN THE TMP TREE at that moment.

    `active`/`enabled` answer the probe verbs so an "already running service"
    is expressible; `absent` models no `systemctl` binary at all through the
    `exec`-time `FileNotFoundError` seam.

    `failing_verb` is CR-CRU-071 AC8: the named verb answers non-zero, exactly
    as `systemctl` does when the unit it started died on boot, and any
    following `status` probe answers with `unit_log` -- which is where a real
    `systemctl --user status` puts the failed unit's own stderr, i.e. the
    server's store refusal or migration failure.
    """

    def __init__(self, case, active=False, enabled=False, absent=False,
                 failing_verb=None, failure_stderr="", unit_log=""):
        self.case = case
        self.active = active
        self.enabled = enabled
        self.absent = absent
        self.failing_verb = failing_verb
        self.failure_stderr = failure_stderr
        self.unit_log = unit_log
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
        verb = _verb_of(flat)
        if "is-active" in flat:
            return _completed(0 if self.active else 3,
                              "active\n" if self.active else "inactive\n", flat)
        if "is-enabled" in flat:
            return _completed(0 if self.enabled else 1,
                              "enabled\n" if self.enabled else "disabled\n",
                              flat)
        if verb == "status":
            return _completed(0 if self.active else 3, self.unit_log, flat)
        if "show" in flat or "is-system-running" in flat:
            return _completed(
                0,
                f"ActiveState={'active' if self.active else 'inactive'}\n"
                f"UnitFileState={'enabled' if self.enabled else 'disabled'}\n",
                flat)
        if self.failing_verb is not None and verb == self.failing_verb:
            return _completed(1, "", flat, stderr=self.failure_stderr)
        return _completed(0, "", flat)

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

    def restart_argvs(self):
        return [argv for argv in self.systemctl_argvs()
                if _verb_of(argv) in RESTART_VERBS]

    def stop_argvs(self):
        return [argv for argv in self.systemctl_argvs()
                if _verb_of(argv) in STOP_VERBS]

    def argvs_for_verb(self, verb):
        return [argv for argv in self.systemctl_argvs()
                if _verb_of(argv) == verb]


def _install_stage_double(name, **extra):
    """An install stage double that provisions instantly: no subprocess, no
    network, no Bun. `extra` is what the stage REPORTS -- which is how a
    `[server]` stage that ADVANCED (re-provisioned) is expressed, and how one
    that merely converged is."""
    def _runner(target_dir, force):
        result = {"path": os.path.join(target_dir, name), "converged": False}
        result.update(extra)
        return result
    return _runner


class _UpgradeFixtureCase(unittest.TestCase):
    """One tmp root holding EVERY path the install can resolve: a tmp
    `$BUN_INSTALL` (with a fake `bun` and a fake provisioned `crucible-server`
    bin, so `server_launch_argv()` resolves without Bun), a tmp
    `$XDG_CONFIG_HOME` (where a `--user` unit belongs), a tmp `$XDG_DATA_HOME`
    (the store the AC8 gate names), a tmp `$XDG_RUNTIME_DIR` with a fake `bus`,
    a tmp `$HOME`, a tmp `--target-dir`, an EMPTY `$PATH` dir, and a
    never-executed `systemctl` stand-in."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cr071-upgrade-")
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
        back an absolute path; `subprocess.run` is patched in every test that
        can reach it, and it exits non-zero without side effect regardless."""
        Path(self.fake_systemctl).write_text(
            f"#!{sys.executable}\nimport sys\nsys.exit(97)\n",
            encoding="utf-8")
        os.chmod(self.fake_systemctl, 0o755)

    def _write_fake_bun(self):
        Path(self.fake_bun).write_text(
            f"#!{sys.executable}\nprint({PINNED_VERSION!r})\n",
            encoding="utf-8")
        os.chmod(self.fake_bun, 0o755)

    def _provision_server_bin(self):
        """The artifact `bun add -g` leaves behind, which is what makes
        `server_launch_argv()` return `[<abs>/bin/crucible-server]` -- the
        version-INDEPENDENT path AC9 is about."""
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
        non-interactive stdin."""
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
    def _real_unit_stage_only(self, install, recorder, server_stage=None,
                              systemctl=True, **env_overrides):
        """As `_sandboxed`, with `[server]` and `[manifest]` replaced by instant
        doubles so the ONLY real stage under test is `[unit]`. `server_stage`
        is the `[server]` double whose REPORT drives AC9 -- an advancing one,
        or a converged one."""
        fakes = {
            SERVER_STAGE: (server_stage if server_stage is not None
                           else _install_stage_double(SERVER_STAGE)),
            MANIFEST_STAGE: _install_stage_double(MANIFEST_STAGE),
        }
        with self._sandboxed(recorder, systemctl=systemctl, **env_overrides), \
                mock.patch.dict(install.DEFAULT_STAGE_RUNNERS, fakes):
            yield

    # -- observations -----------------------------------------------------

    def _unit_files(self):
        return sorted(str(path) for path in Path(self.root).rglob("*.service"))

    def _sole_unit_file(self, why):
        files = self._unit_files()
        self.assertEqual(
            len(files), 1,
            f"exactly ONE systemd unit file must exist under the sandbox -- "
            f"{why}; found {files!r}")
        return files[0]

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
            f"the [{UNIT_STAGE}] stage must be reported as its OWN stage row "
            f"-- {why}; stages={axi.get('stages')!r}")
        return rows[0]

    def _warning_text(self, axi):
        return " ".join(str(row) for row in axi.get("warnings", []))

    def _install(self, cli, *extra_argv):
        return _run_cli(cli, ["install", "--target-dir", self.target_dir,
                              *extra_argv])

    def _write_the_unit_first(self, install, cli):
        """Bring the sandbox to the PRE-UPGRADE state: the unit on disk, its
        text exactly what the stage renders, aged so any rewrite is visible as
        a newer mtime. Returns `(unit_path, stat, text)`."""
        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder):
            code, out, err = self._install(cli)
        self.assertEqual(
            code, 0,
            f"fixture: the FIRST install must succeed; "
            f"stdout={out!r} stderr={err!r}")
        unit = self._sole_unit_file("the first install writes the unit")
        aged = time.time() - 3600
        os.utime(unit, (aged, aged))
        return unit, os.stat(unit), Path(unit).read_text(encoding="utf-8")

    def _assert_unit_untouched(self, unit, before_stat, before_text, why):
        after_stat = os.stat(unit)
        self.assertEqual(
            after_stat.st_mtime_ns, before_stat.st_mtime_ns,
            f"an UNCHANGED unit must not be rewritten -- {why}; its mtime "
            f"moved from {before_stat.st_mtime_ns} to "
            f"{after_stat.st_mtime_ns} (CR-CRU-070 AC2, unweakened by AC9)")
        self.assertEqual(
            Path(unit).read_text(encoding="utf-8"), before_text,
            f"the unit must stay byte-identical -- {why}")

    def _assert_user_scoped(self, argv, why):
        self.assertIn(
            "--user", argv,
            f"EVERY systemctl invocation must be `--user`-scoped -- {why}: a "
            f"system-scope call would need root, which this install never has "
            f"(CR-CRU-070 §Scope); argv={argv!r}")
        self.assertTrue(
            os.path.isabs(argv[0]),
            f"systemctl must be invoked by RESOLVED ABSOLUTE path -- {why}; "
            f"argv={argv!r}")


class UpgradeRestartsTheActiveServiceTest(_UpgradeFixtureCase):
    """AC9 -- the `[server]` stage ADVANCED, so the running daemon is the OLD
    code and must be re-exec'd. The unit text is byte-identical (the whole
    point: `ExecStart` is version-independent), so the restart cannot come from
    a text diff -- it comes from the stage sequence."""

    def test_an_advanced_server_stage_restarts_the_active_unit(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        unit, before_stat, before_text = self._write_the_unit_first(
            install, cli)

        # The upgrade: the [server] stage re-provisioned, and the service is
        # ALREADY running the old code.
        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   advanced=True)):
            code, out, err = self._install(cli)

        self.assertEqual(
            code, 0,
            f"an upgrade that restarts must still exit 0 (AC9); "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")

        restarts = recorder.restart_argvs()
        self.assertTrue(
            restarts,
            f"the [{UNIT_STAGE}] stage must RESTART the service when the "
            f"[{SERVER_STAGE}] stage advanced in this run -- `bun add -g` "
            f"replaced the package on disk while the running process still "
            f"holds the old code, and `ExecStart` is version-independent so "
            f"the unit text cannot signal it (AC9); "
            f"recorded={recorder.systemctl_argvs()!r}")
        for argv in restarts:
            self._assert_user_scoped(argv, "the restart of an upgraded unit")
            self.assertTrue(
                any(os.path.basename(unit) in token for token in argv),
                f"the restart must name the unit it just upgraded "
                f"({os.path.basename(unit)!r}) (AC9); argv={argv!r}")
        self.assertEqual(
            recorder.stop_argvs(), [],
            f"an upgrade RE-EXECS the service, it never merely stops it -- a "
            f"bare `stop` would leave the operator with no daemon (AC9); "
            f"recorded={recorder.systemctl_argvs()!r}")
        self._assert_unit_untouched(
            unit, before_stat, before_text,
            "an upgrade changes the PACKAGE, never the unit text (AC9)")

        row = self._unit_row(axi, "the restart must be DISCLOSED, not silent: "
                                  "an operator watching an upgrade has to see "
                                  "that their live subscribers were dropped "
                                  "on purpose (AC9)")
        self.assertIs(
            row.get("restarted"), True,
            f"the [{UNIT_STAGE}] stage row must report `restarted: true` when "
            f"it re-exec'd the service (AC9); row={row!r}")

    def test_the_runner_reports_the_restart_it_performed(self):
        """The stage's OWN answer: `restarted` is reported by the runner, so
        `run_install` never has to infer it."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._write_the_unit_first(install, cli)
        runner = install.DEFAULT_STAGE_RUNNERS[UNIT_STAGE]

        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._sandboxed(recorder):
            result = runner(self.target_dir, False, server_advanced=True)
        self.assertIs(
            result.get("restarted"), True,
            f"the [{UNIT_STAGE}] runner must REPORT the restart it performed "
            f"(AC9); result={result!r}")
        self.assertTrue(
            recorder.restart_argvs(),
            f"...and must actually have performed one; "
            f"recorded={recorder.systemctl_argvs()!r}")


class ConvergedServerNeitherRewritesNorRestartsTest(_UpgradeFixtureCase):
    """AC9 -- CR-CRU-070's idempotence, now under the new signal: the server
    CONVERGED (same version, nothing re-provisioned) and the unit text is
    unchanged, so the run performs NO write and NO restart. Restarting here
    would drop every live SSE subscriber for nothing."""

    def test_a_converged_server_leaves_the_active_service_alone(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        unit, before_stat, before_text = self._write_the_unit_first(
            install, cli)

        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   converged=True)):
            code, out, err = self._install(cli)

        self.assertEqual(
            code, 0,
            f"a fully converged re-run must exit 0; "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self._assert_unit_untouched(
            unit, before_stat, before_text,
            "nothing advanced, so there is nothing to converge")
        self.assertEqual(
            recorder.mutating_verbs(), [],
            f"a run where the server CONVERGED and the unit text is unchanged "
            f"must perform NO write and NO mutating systemctl call at all -- "
            f"AC9's restart is gated on a REAL version change, so "
            f"CR-CRU-070's idempotence holds everywhere else; "
            f"recorded={recorder.systemctl_argvs()!r}")
        row = self._unit_row(axi, "the converged stage is still reported")
        self.assertIsNot(
            row.get("restarted"), True,
            f"a converged run must not claim it restarted anything; "
            f"row={row!r}")

    def test_the_runner_reports_converged_and_no_restart(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._write_the_unit_first(install, cli)
        runner = install.DEFAULT_STAGE_RUNNERS[UNIT_STAGE]

        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._sandboxed(recorder):
            result = runner(self.target_dir, False, server_advanced=False)
        self.assertIs(
            result.get("converged"), True,
            f"an unchanged unit with an already-active service is CONVERGED "
            f"(CR-CRU-070 AC2); result={result!r}")
        self.assertIsNot(
            result.get("restarted"), True,
            f"...and nothing was restarted; result={result!r}")
        self.assertEqual(
            recorder.mutating_verbs(), [],
            f"nor mutated in any way; recorded={recorder.systemctl_argvs()!r}")


class NoRestartWithoutAnActiveServiceTest(_UpgradeFixtureCase):
    """AC9 -- an absent or INACTIVE unit means no restart, and the run still
    converges (`ok: true`, exit 0). There is nothing holding stale code in
    memory, so `enable --now` (which STARTS it) is the whole job."""

    def test_an_inactive_unit_is_started_but_never_restarted(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        unit, before_stat, before_text = self._write_the_unit_first(
            install, cli)

        recorder = _SystemctlRecorder(self, active=False, enabled=False)
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   advanced=True)):
            code, out, err = self._install(cli)

        self.assertEqual(
            code, 0,
            f"an upgrade whose service is not running must still exit 0 "
            f"(AC9); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self.assertEqual(
            recorder.restart_argvs(), [],
            f"there is no running process holding the old code, so an "
            f"INACTIVE unit must not be restarted -- `enable --now` starts it "
            f"(AC9); recorded={recorder.systemctl_argvs()!r}")
        self.assertTrue(
            recorder.argvs_for_verb("enable"),
            f"an inactive unit must still be enabled and started, exactly as "
            f"CR-CRU-070 AC2 has it; "
            f"recorded={recorder.systemctl_argvs()!r}")
        self._assert_unit_untouched(
            unit, before_stat, before_text,
            "the unit text is unchanged by an upgrade (AC9)")

    def test_a_missing_unit_is_written_and_started_never_restarted(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()

        recorder = _SystemctlRecorder(self, active=False, enabled=False)
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   advanced=True)):
            code, out, err = self._install(cli)

        self.assertEqual(
            code, 0,
            f"a first install alongside an advancing server must exit 0 "
            f"(AC9); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self._sole_unit_file("the first install writes the unit (AC9)")
        self.assertEqual(
            recorder.restart_argvs(), [],
            f"a unit that did not exist cannot be holding stale code: it is "
            f"written, reloaded and `enable --now`d, never restarted (AC9); "
            f"recorded={recorder.systemctl_argvs()!r}")
        self.assertEqual(
            recorder.mutating_verbs(), ["daemon-reload", "enable"],
            f"the first-install sequence is unchanged by AC9 (CR-CRU-070 "
            f"AC2); recorded={recorder.systemctl_argvs()!r}")


class AbsentSystemdStillSkipsOnAnUpgradeTest(_UpgradeFixtureCase):
    """AC9 -- absent systemd still skips WITH a reason and exits 0, even when
    the server advanced. An upgrade on a machine with no user manager is a
    package upgrade, not a failure."""

    def test_an_advanced_server_with_no_systemctl_skips_with_a_reason(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()

        recorder = _SystemctlRecorder(self, absent=True)
        with self._real_unit_stage_only(
                install, recorder, systemctl=False,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   advanced=True)):
            code, out, err = self._install(cli)

        self.assertEqual(
            code, 0,
            f"an upgrade on a machine with NO systemctl must still exit 0 -- "
            f"the base install has no systemd dependency (AC9/CR-CRU-070 "
            f"AC4); stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(
            axi["ok"], True,
            f"a skipped [{UNIT_STAGE}] stage must never make the overall "
            f"install not-ok, advanced server or not; envelope={axi!r}")
        row = self._unit_row(axi, "the skip has to be VISIBLE (AC9)")
        self.assertIs(
            row.get("skipped"), True,
            f"the [{UNIT_STAGE}] row must SAY it was skipped; row={row!r}")
        reason = str(row.get("reason", ""))
        self.assertTrue(
            reason.strip(),
            f"a skipped [{UNIT_STAGE}] stage must carry a non-empty `reason` "
            f"naming WHY -- 'skipped' with no reason leaves the operator "
            f"guessing whether their daemon exists (AC9); row={row!r}")
        self.assertTrue(
            any(hint in reason.lower()
                for hint in ("systemctl", "systemd", "no user", "absent",
                             "unavailable", "not found")),
            f"the skip reason must name the actual cause; reason={reason!r}")
        self.assertIsNot(
            row.get("restarted"), True,
            f"nothing can have been restarted with no service manager; "
            f"row={row!r}")
        self.assertEqual(
            self._unit_files(), [],
            f"with no systemd there is nothing to read the unit, so the stage "
            f"must not leave a file behind; found {self._unit_files()!r}")


class ForceStillRestartsAnActiveServiceTest(_UpgradeFixtureCase):
    """AC9 -- `--force` stays the "make it match whatever the state" escape
    hatch: it restarts an ACTIVE service regardless of the server signal, and
    still does not rewrite identical bytes."""

    def test_force_restarts_even_when_the_server_converged(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        unit, before_stat, before_text = self._write_the_unit_first(
            install, cli)

        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   converged=True)):
            code, out, err = self._install(cli, "--force")

        self.assertEqual(
            code, 0,
            f"`--force` must exit 0; stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self.assertTrue(
            recorder.restart_argvs(),
            f"`--force` must RESTART an active service -- it is the escape "
            f"hatch that re-asserts state whatever the signals say, so an "
            f"operator who suspects a stale process has a way out (AC9); "
            f"recorded={recorder.systemctl_argvs()!r}")
        for argv in recorder.restart_argvs():
            self._assert_user_scoped(argv, "the forced restart")
        self._assert_unit_untouched(
            unit, before_stat, before_text,
            "`--force` re-asserts MANAGER state, it does not rewrite "
            "identical bytes (CR-CRU-070 AC2)")


class RestartSignalIsNeverReDerivedTest(_UpgradeFixtureCase):
    """AC9 -- the `[unit]` stage learns "the server advanced" from the STAGE
    SEQUENCE alone. Re-reading the installed version or re-resolving the pin
    would give the answer a SECOND source of truth, which is precisely how this
    bug appeared: the unit stage compared unit TEXT, the server stage compared
    VERSIONS, and neither told the other.

    Asserted by making every version-reading helper EXPLODE for the duration of
    the unit stage."""

    _VERSION_HELPERS = ("_installed_server_version",
                        "_read_installed_server_version",
                        "_server_already_installed",
                        "_resolve_server_version",
                        "_resolved_server_version_or_fail")

    @contextlib.contextmanager
    def _version_helpers_explode(self, install):
        def _explode(*args, **kwargs):
            raise AssertionError(
                "the [unit] stage re-derived 'did the server advance?' by "
                "reading a VERSION -- AC9 requires it to learn that from the "
                "stage sequence ALONE, because two sources of truth for that "
                "question is how the missing-restart bug appeared")
        with contextlib.ExitStack() as stack:
            for name in self._VERSION_HELPERS:
                self.assertTrue(
                    hasattr(install, name),
                    f"crucible_axi.install.{name} is MISSING -- the helper "
                    f"this test forbids the unit stage from calling must "
                    f"exist for the assertion to mean anything")
                stack.enter_context(
                    mock.patch.object(install, name, side_effect=_explode))
            yield

    def test_the_unit_stage_reads_no_version_to_decide_to_restart(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._write_the_unit_first(install, cli)
        runner = install.DEFAULT_STAGE_RUNNERS[UNIT_STAGE]

        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._sandboxed(recorder), self._version_helpers_explode(install):
            result = runner(self.target_dir, False, server_advanced=True)

        self.assertTrue(
            recorder.restart_argvs(),
            f"the restart must happen off the THREADED signal alone (AC9); "
            f"result={result!r} recorded={recorder.systemctl_argvs()!r}")

    def test_no_version_read_can_conjure_a_restart_the_sequence_denies(self):
        """The converse: with the signal FALSE, the stage must not go looking
        for a version to change its mind with."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._write_the_unit_first(install, cli)
        runner = install.DEFAULT_STAGE_RUNNERS[UNIT_STAGE]

        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._sandboxed(recorder), self._version_helpers_explode(install):
            runner(self.target_dir, False, server_advanced=False)

        self.assertEqual(
            recorder.restart_argvs(), [],
            f"with the sequence saying nothing advanced there is nothing to "
            f"restart (AC9); recorded={recorder.systemctl_argvs()!r}")

    def test_the_unit_runner_accepts_the_signal_as_a_declared_parameter(self):
        """The signal travels by the EXISTING `_stage_options` mechanism -- a
        declared parameter -- not by module globals or a side channel."""
        install, = _import_fresh("crucible_axi.install")
        runner = install.DEFAULT_STAGE_RUNNERS[UNIT_STAGE]
        parameters = inspect.signature(runner).parameters
        self.assertIn(
            "server_advanced", parameters,
            f"the [{UNIT_STAGE}] runner must OPT IN to the server-advanced "
            f"signal by declaring it, which is how `_stage_options` threads "
            f"every optional stage input (CR-CRU-066 §S2 / CR-CRU-070 AC4); "
            f"parameters={sorted(parameters)}")
        self.assertIs(
            parameters["server_advanced"].default, False,
            f"the signal must DEFAULT to false, so an injected double that "
            f"provisions nothing never triggers a restart; "
            f"parameter={parameters['server_advanced']!r}")

        options = install._stage_options(runner, False, False, True)
        self.assertEqual(
            options.get("server_advanced"), True,
            f"`_stage_options` must thread the signal to a runner that "
            f"declares it; options={options!r}")
        two_arg = _install_stage_double(SERVER_STAGE)
        self.assertNotIn(
            "server_advanced", install._stage_options(two_arg, False, False,
                                                      True),
            "a `(target_dir, force)` double declares no options, so it must be "
            "called exactly as before -- the runner protocol is unchanged")

    def test_the_server_stage_is_what_reports_the_advance(self):
        """Only the `[server]` stage can know: it is the one that
        re-provisioned. A converged one reports no advance."""
        install, = _import_fresh("crucible_axi.install")
        server_runner = install.DEFAULT_STAGE_RUNNERS[SERVER_STAGE]

        recorder = _SystemctlRecorder(self)
        with self._sandboxed(recorder):
            converged = server_runner(self.target_dir, False)
        self.assertIs(
            converged.get("converged"), True,
            f"fixture: the provisioned bin is AT the pin, so the server stage "
            f"converges; result={converged!r}")
        self.assertIsNot(
            converged.get("advanced"), True,
            f"a CONVERGED [{SERVER_STAGE}] stage must not claim it advanced -- "
            f"that is what keeps CR-CRU-070's idempotence intact (AC9); "
            f"result={converged!r}")

        # Now the upgrade: the installed version no longer matches the pin, so
        # the stage re-provisions (through the recorded `bun add -g`).
        Path(os.path.join(self.package_dir, "package.json")).write_text(
            f'{{"name": "{SERVER_NPM_PACKAGE}", "version": "0.0.1"}}\n',
            encoding="utf-8")
        with self._sandboxed(recorder):
            advanced = server_runner(self.target_dir, False)
        self.assertIs(
            advanced.get("converged"), False,
            f"an installed version other than the pin is NOT converged "
            f"(CR-CRU-066); result={advanced!r}")
        self.assertIs(
            advanced.get("advanced"), True,
            f"a [{SERVER_STAGE}] stage that RE-PROVISIONED must report that it "
            f"advanced -- it is the only stage that can know, and the "
            f"[{UNIT_STAGE}] stage restarts on that signal alone (AC9); "
            f"result={advanced!r}")


class ExecStartCarriesNoVersionTest(_UpgradeFixtureCase):
    """AC9 (rejected design) -- embedding a version in `ExecStart` to force a
    text change is REJECTED: it would rewrite the unit on EVERY upgrade and
    break CR-CRU-070's unchanged-unit-is-not-rewritten guarantee. So an upgrade
    cannot smuggle a text change in, and the restart signal has nowhere to hide
    but the stage sequence."""

    def test_the_provisioned_units_execstart_names_no_version(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        recorder = _SystemctlRecorder(self)
        with self._real_unit_stage_only(install, recorder):
            code, out, err = self._install(cli)
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        unit = self._sole_unit_file("the unit text is what carries ExecStart")
        text = Path(unit).read_text(encoding="utf-8")

        exec_lines = [line for line in text.splitlines()
                      if line.startswith("ExecStart=")]
        self.assertEqual(
            len(exec_lines), 1,
            f"the unit must carry exactly one `ExecStart`; unit={text!r}")
        exec_start = exec_lines[0]
        self.assertIn(
            SERVER_BIN_NAME, exec_start,
            f"`ExecStart` must run the PROVISIONED bin -- the "
            f"version-independent path (CR-CRU-066 §S3); "
            f"line={exec_start!r}")
        self.assertNotIn(
            PINNED_VERSION, exec_start,
            f"`ExecStart` must carry NO version: a version there would make "
            f"the unit text change on every upgrade, rewriting a unit that "
            f"CR-CRU-070 AC2 guarantees is left alone -- and it is the "
            f"REJECTED way to signal a restart (AC9); line={exec_start!r}")
        found = _VERSION_LIKE.search(exec_start)
        self.assertIsNone(
            found,
            f"`ExecStart` must carry no version-like token at all (AC9, "
            f"rejected design); found "
            f"{(found.group(0) if found else None)!r} in {exec_start!r}")

    def test_an_upgrade_renders_byte_identical_unit_text(self):
        """The consequence, asserted directly: the same sandbox at two
        different PINS renders the same unit, which is exactly why the text
        diff cannot be the restart signal."""
        install, = _import_fresh("crucible_axi.install")
        recorder = _SystemctlRecorder(self)
        with self._sandboxed(recorder):
            before = install._render_user_unit()
        with self._sandboxed(recorder, CRUCIBLE_SERVER_VERSION="10.0.0"):
            after = install._render_user_unit()
        self.assertEqual(
            before, after,
            "the rendered unit must be byte-identical across a version bump "
            "-- that is WHY the [unit] stage cannot learn about an upgrade "
            "from its own text and must be told by the [server] stage (AC9)")


class UpgradeIsGatedOnASafeMigrationTest(_UpgradeFixtureCase):
    """AC8 -- the upgrade proceeds ONLY if the migration succeeds.

    The restart AC9 introduces is where the new build opens the store and runs
    the migration chain, so it is also the gate: a store the build REFUSES to
    open (AC5, too-new schema) or a migration that THREW (AC7) makes the start
    fail. Today that answer is thrown away -- `_run_systemctl`'s
    `CompletedProcess` is ignored for `enable --now` -- so a broken upgrade
    reports `ok: true` and leaves a new binary pointed at a store it cannot
    open. It must fail the run, with the server's own message (which names the
    `<store>.pre-upgrade-<epoch>` backup) surfaced."""

    def _refusal_log(self, store_path):
        """What `systemctl --user status` shows for a unit whose server refused
        the store -- the real message shape from `src/store.ts`."""
        return (
            f"× {'crucible-server.service'} - Crucible test-reporting server\n"
            f"     Active: failed (Result: exit-code)\n"
            f"crucible-server[1234]: [crucible] {REFUSAL_NEEDLE} "
            f"{store_path}: the store is at schema version 9, but this build "
            f"only understands version 5 — a newer Crucible wrote it. Nothing "
            f"was touched: no quarantine, no fresh db, no write. Remedy: "
            f"upgrade this Crucible to the build that speaks version 9, or "
            f"restore that build's {store_path}.{BACKUP_SUFFIX_NEEDLE}-<epoch> "
            f"backup and re-run this one.\n")

    def _migration_failure_log(self, store_path, backup_path):
        return (
            f"× crucible-server.service - Crucible test-reporting server\n"
            f"     Active: failed (Result: exit-code)\n"
            f"crucible-server[1234]: [crucible] {MIGRATION_FAILURE_NEEDLE} on "
            f"{store_path}: step 4 -> 5 (agent roles) threw, so its "
            f"transaction was rolled back and the store still reads schema "
            f"version 4. Restore the {BACKUP_SUFFIX_NEEDLE} backup at "
            f"{backup_path} if this store looks wrong. Cause: Error: no such "
            f"column: role\n")

    _START_FAILED_STDERR = (
        "Job for crucible-server.service failed because the control process "
        "exited with error code.\n"
        "See \"systemctl --user status crucible-server.service\" and "
        "\"journalctl --user -xeu crucible-server.service\" for details.\n")

    def test_a_refused_store_fails_the_upgrade_and_names_the_backup(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._write_the_unit_first(install, cli)
        with self._sandboxed(_SystemctlRecorder(self)):
            store_path = os.path.join(install.store_dir(), "crucible.db")

        # The upgrade restarts (AC9) -- and the new build refuses the store.
        recorder = _SystemctlRecorder(
            self, active=True, enabled=True, failing_verb="restart",
            failure_stderr=self._START_FAILED_STDERR,
            unit_log=self._refusal_log(store_path))
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   advanced=True)):
            code, out, err = self._install(cli)

        self.assertTrue(
            recorder.restart_argvs(),
            f"fixture: the upgrade must have attempted the restart that runs "
            f"the migration; recorded={recorder.systemctl_argvs()!r}")
        self.assertNotEqual(
            code, 0,
            f"a store the new build REFUSES to open must FAIL the upgrade -- "
            f"exiting 0 leaves a new binary pointed at a store it cannot "
            f"open, which is exactly what AC8 forbids; "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(
            axi["ok"], False,
            f"the envelope must report the upgrade as NOT ok (AC8); "
            f"envelope={axi!r}")
        detail = self._warning_text(axi)
        self.assertIn(
            REFUSAL_NEEDLE, detail,
            f"the server's own REFUSAL must be SURFACED, not swallowed -- an "
            f"operator must not have to go digging in the journal to learn "
            f"why their upgrade did nothing (AC8); warnings={detail!r}")
        self.assertIn(
            BACKUP_SUFFIX_NEEDLE, detail,
            f"the failure must NAME the backup/recovery point (AC8); "
            f"warnings={detail!r}")
        self.assertIn(
            store_path, detail,
            f"the failure must name the STORE it could not open (AC8); "
            f"warnings={detail!r}")
        unit_rows = [row for row in self._stage_rows(axi)
                     if row.get("name") == UNIT_STAGE]
        self.assertEqual(
            unit_rows, [],
            f"a gated-out upgrade must not report the [{UNIT_STAGE}] stage as "
            f"a completed stage -- the run FAILED there (AC8); "
            f"stages={axi.get('stages')!r}")

    def test_a_failed_migration_fails_the_upgrade_and_names_the_backup(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        with self._sandboxed(_SystemctlRecorder(self)):
            store_path = os.path.join(install.store_dir(), "crucible.db")
        backup_path = f"{store_path}.{BACKUP_SUFFIX_NEEDLE}-1770000000000"

        # A FIRST install this time: the start verb is `enable --now`, and the
        # migration the new build runs at boot throws.
        recorder = _SystemctlRecorder(
            self, active=False, enabled=False, failing_verb="enable",
            failure_stderr=self._START_FAILED_STDERR,
            unit_log=self._migration_failure_log(store_path, backup_path))
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   advanced=True)):
            code, out, err = self._install(cli)

        self.assertNotEqual(
            code, 0,
            f"a migration that THREW must fail the upgrade (AC7/AC8) -- the "
            f"server does not begin serving on a half-migrated store, so the "
            f"install must not claim success; stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], False, f"envelope={axi!r}")
        detail = self._warning_text(axi)
        self.assertIn(
            MIGRATION_FAILURE_NEEDLE, detail,
            f"the migration failure must be SURFACED verbatim (AC8); "
            f"warnings={detail!r}")
        self.assertIn(
            backup_path, detail,
            f"the failure must name the PRE-UPGRADE BACKUP to restore from -- "
            f"'restore the backup' is the only reversal this CR offers, so "
            f"the path is not optional (AC4/AC8); warnings={detail!r}")

    def test_a_start_that_succeeds_is_not_reported_as_a_failure(self):
        """The gate must be a GATE, not a tripwire: a start that works keeps
        the run green and adds no diagnostic probe to the happy path."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        self._write_the_unit_first(install, cli)

        recorder = _SystemctlRecorder(self, active=True, enabled=True)
        with self._real_unit_stage_only(
                install, recorder,
                server_stage=_install_stage_double(SERVER_STAGE,
                                                   advanced=True)):
            code, out, err = self._install(cli)

        self.assertEqual(
            code, 0,
            f"a successful restart must keep the run green; "
            f"stdout={out!r} stderr={err!r}")
        axi = self._decode(out, toon, "install")
        self.assertIs(axi["ok"], True, f"envelope={axi!r}")
        self.assertEqual(
            recorder.argvs_for_verb("status"), [],
            f"the failure diagnostic must be fetched ONLY on failure -- a "
            f"`status` probe on every install is chatter the happy path does "
            f"not need; recorded={recorder.systemctl_argvs()!r}")


class StoreRefusalTextIsTheServersOwnTest(unittest.TestCase):
    """AC8 -- the tokens the gate's fixtures model are the REAL ones
    `src/store.ts` throws, so the modelled systemd output above cannot drift
    into fiction while the suite stays green."""

    def test_the_server_really_throws_the_text_the_installer_surfaces(self):
        store_ts = (REPO_ROOT / "src" / "store.ts").read_text(encoding="utf-8")
        for needle, why in (
            (REFUSAL_NEEDLE,
             "a too-new store is REFUSED with this banner (AC5)"),
            (MIGRATION_FAILURE_NEEDLE,
             "a migration step that threw says so with this banner (AC7)"),
            (BACKUP_SUFFIX_NEEDLE,
             "both messages point at the `<store>.pre-upgrade-<epoch>` "
             "recovery point, which is the path AC8 requires the failed "
             "upgrade to name"),
        ):
            self.assertIn(
                needle, store_ts,
                f"src/store.ts no longer contains {needle!r} -- {why}; the "
                f"installer-side gate surfaces the server's message verbatim, "
                f"so this suite's fixtures must model the REAL text")
        for error_class in ("StoreVersionTooNewError",
                           "StoreMigrationFailedError"):
            self.assertIn(
                f"class {error_class}", store_ts,
                f"src/store.ts must still define {error_class} -- it is the "
                f"refusal/failure the installer's upgrade gate exists to "
                f"surface (AC8)")


if __name__ == "__main__":
    unittest.main()
