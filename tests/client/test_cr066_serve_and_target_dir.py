"""CR-CRU-066 C3 (§S3 + §S1b, ACs 5 and 7) -- the two remaining install/CLI
surface defects: there is NO run command, and the install never creates the
directory it installs into.

RED, and why each test below fails against the current tree (read, not guessed):

§S3 / AC5 -- `crucible-axi serve`
  `crucible_axi/cli.py:_build_parser` registers exactly ONE subparser,
  `install` (`cli.py:53`), and `main` (`cli.py:104`) dispatches only
  `install`. So `parse_args(["serve"])` hits argparse's "invalid choice" and
  exits 2, and nothing in the package ever composes a server launch. Every
  `serve` test therefore fails today at the parser or on "no launch call was
  ever made".

  What the tests PIN (the contract §S3 states, plus the follow-up systemd
  `--user` unit's requirement of a minimal PATH):
    * `serve` is a registered subcommand of the single `crucible-axi` console
      script -- not a second console script.
    * the child is launched by ABSOLUTE path: argv[0] is
      `install._provisioned_server_bin_path()` (`$BUN_INSTALL/bin/crucible-server`)
      when that bin exists;
    * when the bin is ABSENT, argv[0] is the ABSOLUTE Bun path (resolved via the
      existing `install` helpers, never the bare `bun` token an inherited PATH
      may not resolve) and the argv carries the VERSION-PINNED
      `@anthill-tec/crucible-server@<version>` package spec;
    * `CRUCIBLE_HOST` / `CRUCIBLE_PORT` reach the child through an EXPLICIT
      `env` mapping on the launch call -- the same reason the paths are
      absolute: a systemd `--user` child cannot be assumed to inherit the
      operator's ambient environment, and an explicitly composed env is the
      only forwarding a unit test can assert without binding a port;
    * the child's exit code is RETURNED by the command (foreground/blocking is
      CORRECT for `serve` -- that is the whole point of splitting it out of
      `install`).

  NO test here starts a server or binds a port (§S3 Risk -- that is the
  original defect's failure mode). The launch is asserted as DATA through the
  `subprocess.run` seam, patched on the `subprocess` module itself so it holds
  wherever GREEN puts the launch (`crucible_axi.cli` or `crucible_axi.install`).
  Exit-code passthrough is what fixes that seam: `os.execv` never returns a
  code to return, so the launch must be a `subprocess.run`/`call`-shaped call
  whose `returncode` `serve` propagates.

§S1b / AC7 -- the install creates its target directory
  Nothing in `crucible_axi/` ever creates `target_dir` (no `makedirs`/`mkdir`
  anywhere in the package) and the default is `~/.crucible` (`cli.py:56`). So
  on a clean machine the server stage provisions and the [manifest] stage then
  dies `FileNotFoundError: .../crucible-clients.json`; `run_install` records it
  as `ok=False` and `crucible-axi install` exits 1. The tests below drive a
  target dir that does NOT exist (with the server stage stubbed to a fast
  provision -- no subprocess, no network) and assert the REAL outcome: the
  directory exists, the manifest was written inside it, and `ok is True` /
  exit 0. An unwritable target must still fail DEFINITIVELY, naming the target
  directory as a creation/permission failure -- not as a cryptic missing-file
  error about the manifest.
"""

import contextlib
import importlib
import io
import os
import re
import shutil
import stat
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

SERVER_PACKAGE = "@anthill-tec/crucible-server"
SERVER_BIN_NAME = "crucible-server"
BUN_BIN_NAME = "bun"

MANIFEST_FILENAME = "crucible-clients.json"

BOOTSTRAP_NEEDLE = "bun.sh/install"


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(*module_names):
    """Import the named `crucible_axi` modules from the repo-root checkout,
    purging the whole `crucible_axi` package first so each test gets an
    independent import graph (and so `crucible_axi.cli` holds the same
    `crucible_axi.install` module object the `mock.patch` targets resolve to).
    Returns the imported modules in the order requested."""
    _ensure_repo_root_on_path()
    for mod in list(sys.modules):
        if mod == "crucible_axi" or mod.startswith("crucible_axi."):
            del sys.modules[mod]
    return tuple(importlib.import_module(name) for name in module_names)


def _argv(call):
    """The list argv of a `subprocess.run`-shaped call, or None for a shell
    string."""
    args = call.args[0] if call.args else call.kwargs.get("args")
    return list(args) if isinstance(args, (list, tuple)) else None


def _command_text(call):
    """Flatten a call to one searchable string, list argv or shell string."""
    args = call.args[0] if call.args else call.kwargs.get("args", "")
    if isinstance(args, (list, tuple)):
        return " ".join(str(a) for a in args)
    return str(args)


def _launch_calls(mock_run):
    """The calls that LAUNCH the server -- either the provisioned
    `crucible-server` bin or the pinned `@anthill-tec/crucible-server` package
    through Bun.

    Deliberately excludes the two calls that are NOT a launch: the `bun add -g`
    provision (`serve` must not provision) and the remote Bun bootstrap. A
    `<bun> --version` verification probe carries no `crucible-server` token at
    all, so it never matches."""
    found = []
    for call in mock_run.call_args_list:
        text = _command_text(call)
        if SERVER_BIN_NAME not in text:
            continue
        if BOOTSTRAP_NEEDLE in text:
            continue
        argv = _argv(call)
        if argv and argv[1:3] == ["add", "-g"]:
            continue
        found.append(call)
    return found


def _run_result(returncode=0):
    return SimpleNamespace(returncode=returncode, stdout="", stderr="", args=None)


def _run_side_effect(returncode=0):
    """A `subprocess.run` stand-in: never spawns anything, never binds a port."""
    def _run(*args, **kwargs):
        return _run_result(returncode)
    return _run


def _which_never_finds_bare_names(*existing_absolute):
    """A `shutil.which` stand-in: bare names (an inherited-PATH lookup) NEVER
    resolve, absolute paths resolve iff they are real files.

    Keeps every `serve` test independent of whether the machine running the
    suite happens to have Bun on PATH -- the absolute-path resolution §S3
    requires is what is under test."""
    real = set(existing_absolute)

    def _which(cmd, mode=os.F_OK | os.X_OK, path=None):
        text = str(cmd)
        if os.path.isabs(text):
            return text if (text in real or os.path.isfile(text)) else None
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
    `(code, stdout, stderr)`; an argparse `SystemExit` is reported as its code
    (so a missing subcommand surfaces as an assertion about the CONTRACT, not
    as an opaque test error)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli.main(argv)
        except SystemExit as exc:
            code = 0 if exc.code is None else exc.code
    return code, out.getvalue(), err.getvalue()


class _ServeFixtureCase(unittest.TestCase):
    """Shared `serve` fixture: a tmp `$BUN_INSTALL` prefix whose `bin/` starts
    EMPTY, so each test decides whether the provisioned server bin and/or Bun
    itself is present."""

    def setUp(self):
        self.bun_root = tempfile.mkdtemp(prefix="cr066-serve-bun-root-")
        self.bun_bin_dir = os.path.join(self.bun_root, "bin")
        os.makedirs(self.bun_bin_dir, exist_ok=True)
        self.server_bin = os.path.join(self.bun_bin_dir, SERVER_BIN_NAME)
        self.bun_bin = os.path.join(self.bun_bin_dir, BUN_BIN_NAME)

    def tearDown(self):
        shutil.rmtree(self.bun_root, ignore_errors=True)

    def _make_executable(self, path, body="#!/bin/sh\nexit 0\n"):
        with open(path, "w") as handle:
            handle.write(body)
        os.chmod(path, 0o755)
        return path

    def _serve_env(self, **extra):
        env = {
            "BUN_INSTALL": self.bun_root,
            "CRUCIBLE_SERVER_VERSION": PINNED_VERSION,
            "CRUCIBLE_NO_BUN_BOOTSTRAP": None,
            "CRUCIBLE_HOST": None,
            "CRUCIBLE_PORT": None,
        }
        env.update(extra)
        return env


class ServeSubcommandExistsTest(_ServeFixtureCase):
    """AC5 (surface) -- `serve` is a real subcommand of the one `crucible-axi`
    console script."""

    def test_serve_is_a_registered_subcommand(self):
        cli, = _import_fresh("crucible_axi.cli")
        parser = cli._build_parser()
        try:
            args = parser.parse_args(["serve"])
        except SystemExit as exc:
            self.fail(
                f"`crucible-axi serve` must be a REGISTERED subcommand (§S3 "
                f"AC5) -- argparse rejected it with SystemExit({exc.code}); "
                f"only `install` is registered today")
        self.assertEqual(
            getattr(args, "command", None), "serve",
            "the `serve` subparser must set the same `command` dest `install` "
            "uses, so `main` can dispatch it")

    def test_serve_is_dispatched_by_main_not_rejected_or_helped(self):
        """`main(["serve"])` must reach the run command: not argparse's exit 2,
        and not the print-help-and-return-1 fall-through."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._make_executable(self.server_bin)
        with _patched_env(**self._serve_env()), \
                mock.patch("subprocess.run",
                           side_effect=_run_side_effect(0)) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names()):
            code, _out, err = _run_cli(cli, ["serve"])

        self.assertNotEqual(
            code, 2,
            f"`crucible-axi serve` must not be an argparse 'invalid choice' "
            f"(exit 2); stderr={err!r}")
        self.assertTrue(
            _launch_calls(mock_run),
            f"`main(['serve'])` must LAUNCH the server (§S3); no launch call "
            f"was composed. code={code} calls={mock_run.call_args_list}")
        self.assertEqual(
            code, 0,
            f"a child that exits 0 makes `serve` return 0; code={code} "
            f"stderr={err!r}")
        # Guard the contract boundary: `serve` runs, it does not provision.
        self.assertFalse(
            [c for c in mock_run.call_args_list
             if (_argv(c) or [])[1:3] == ["add", "-g"]],
            f"`serve` must not re-provision the server package (that is "
            f"`install`'s job -- §S1); calls={mock_run.call_args_list}")


class ServeAbsolutePathLaunchTest(_ServeFixtureCase):
    """AC5 (resolution) -- the launch is by ABSOLUTE path, because the follow-up
    systemd `--user` unit gets a minimal PATH (§S3 Risk)."""

    def test_serve_launches_the_provisioned_bin_by_absolute_path(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        server_bin = self._make_executable(self.server_bin)
        with _patched_env(**self._serve_env()), \
                mock.patch("subprocess.run",
                           side_effect=_run_side_effect(0)) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names()):
            expected = install._provisioned_server_bin_path()
            code, _out, err = _run_cli(cli, ["serve"])

        self.assertEqual(
            expected, server_bin,
            "fixture sanity: `$BUN_INSTALL/bin/crucible-server` is the "
            "provisioned bin path")
        launches = _launch_calls(mock_run)
        self.assertEqual(
            len(launches), 1,
            f"`serve` must launch the server EXACTLY once; code={code} "
            f"stderr={err!r} calls={mock_run.call_args_list}")
        argv = _argv(launches[0])
        self.assertIsNotNone(
            argv,
            f"the launch must be a list argv (no shell string -- no shell "
            f"quoting/PATH surprises); call={launches[0]}")
        self.assertEqual(
            argv[0], expected,
            f"argv[0] must be the ABSOLUTE provisioned bin path {expected!r}, "
            f"never a bare `{SERVER_BIN_NAME}` token an inherited PATH may not "
            f"resolve; argv={argv}")

    def test_serve_falls_back_to_the_absolute_bun_with_the_pinned_package(self):
        """The provisioned bin ABSENT -> launch via the ABSOLUTE Bun with the
        version-pinned package (§S3), not a bare `bunx`/`bun` token."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        bun_bin = self._make_executable(self.bun_bin)
        self.assertFalse(
            os.path.exists(self.server_bin),
            "fixture sanity: the provisioned server bin must be ABSENT here")
        with _patched_env(**self._serve_env()), \
                mock.patch("subprocess.run",
                           side_effect=_run_side_effect(0)) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names(bun_bin)):
            code, _out, err = _run_cli(cli, ["serve"])

        launches = _launch_calls(mock_run)
        self.assertTrue(
            launches,
            f"with no provisioned bin, `serve` must still launch the server "
            f"through Bun; code={code} stderr={err!r} "
            f"calls={mock_run.call_args_list}")
        argv = _argv(launches[-1])
        self.assertIsNotNone(
            argv, f"the fallback launch must be a list argv; call={launches[-1]}")
        self.assertEqual(
            argv[0], bun_bin,
            f"argv[0] must be the ABSOLUTE Bun path resolved through the "
            f"existing install helpers ({bun_bin!r}) -- never the bare `bun`/"
            f"`bunx` token (§S3 Risk: a minimal PATH must still work); "
            f"argv={argv}")
        pinned = f"{SERVER_PACKAGE}@{PINNED_VERSION}"
        self.assertTrue(
            any(pinned in str(token) for token in argv),
            f"the Bun fallback must be VERSION-PINNED with {pinned!r} (never "
            f"`latest`); argv={argv}")


class ServeEnvironmentForwardingTest(_ServeFixtureCase):
    """AC5 (env) -- `CRUCIBLE_HOST`/`CRUCIBLE_PORT` are forwarded to the child
    through an EXPLICIT env mapping on the launch call."""

    def test_serve_forwards_crucible_host_and_port_to_the_child_env(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._make_executable(self.server_bin)
        host, port = "127.0.0.9", "4871"
        with _patched_env(**self._serve_env(CRUCIBLE_HOST=host,
                                            CRUCIBLE_PORT=port)), \
                mock.patch("subprocess.run",
                           side_effect=_run_side_effect(0)) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names()):
            code, _out, err = _run_cli(cli, ["serve"])

        launches = _launch_calls(mock_run)
        self.assertTrue(
            launches,
            f"no launch call to inspect; code={code} stderr={err!r} "
            f"calls={mock_run.call_args_list}")
        child_env = launches[-1].kwargs.get("env")
        self.assertIsInstance(
            child_env, dict,
            f"`serve` must compose the child's environment EXPLICITLY (an "
            f"`env=` mapping) rather than relying on ambient inheritance -- "
            f"the systemd `--user` follow-up this CR delivers `serve` for gets "
            f"neither the operator's PATH nor their exports; call="
            f"{launches[-1]}")
        self.assertEqual(
            child_env.get("CRUCIBLE_HOST"), host,
            f"CRUCIBLE_HOST must reach the child (§S3 AC5); env keys="
            f"{sorted(child_env)}")
        self.assertEqual(
            child_env.get("CRUCIBLE_PORT"), port,
            f"CRUCIBLE_PORT must reach the child (§S3 AC5); env keys="
            f"{sorted(child_env)}")


class ServeExitCodePassthroughTest(_ServeFixtureCase):
    """AC5 (exit code) -- `serve` RETURNS the child's exit code, so the shell
    (and a later systemd unit) sees the real failure."""

    def test_serve_returns_the_childs_exit_code(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._make_executable(self.server_bin)
        with _patched_env(**self._serve_env()), \
                mock.patch("subprocess.run",
                           side_effect=_run_side_effect(3)) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names()):
            code, _out, err = _run_cli(cli, ["serve"])

        self.assertTrue(
            _launch_calls(mock_run),
            f"no launch call was composed, so no exit code could be "
            f"propagated; code={code} stderr={err!r}")
        self.assertEqual(
            code, 3,
            f"`serve` must RETURN the child's exit code verbatim (3), not a "
            f"normalized 0/1 -- got {code}; stderr={err!r}")

    def test_serve_returns_zero_when_the_child_exits_zero(self):
        """The zero case is not the same code path as the signal translation
        below -- pinned so the `128 - returncode` arithmetic can never leak into
        a clean shutdown."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._make_executable(self.server_bin)
        with _patched_env(**self._serve_env()), \
                mock.patch("subprocess.run",
                           side_effect=_run_side_effect(0)) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names()):
            code, _out, err = _run_cli(cli, ["serve"])

        self.assertTrue(_launch_calls(mock_run), f"stderr={err!r}")
        self.assertEqual(
            code, 0,
            f"a child that exits 0 makes `serve` return 0, untranslated; "
            f"got {code}; stderr={err!r}")


class ServeCtrlCExitsCleanlyTest(_ServeFixtureCase):
    """AC5a -- Ctrl-C stops `serve` cleanly: exit 130, NO traceback.

    `docs/RUNBOOK.md` documents Ctrl-C as THE stop gesture, and a foreground
    SIGINT is delivered by the shell to the whole PROCESS GROUP -- so the PARENT
    raises `KeyboardInterrupt` out of `subprocess.run`, not just the child.
    Unhandled, the console script prints a Python stack trace at an operator who
    did exactly what the runbook told them to; that is the same unpolished
    failure the 0.1.1 install hang produced, and the reason the
    resolution-failure path already forbids tracebacks.

    Driven at the seam -- the stubbed `subprocess.run` RAISES
    `KeyboardInterrupt` -- so no port is bound and no server is spawned. The
    real end-to-end SIGINT is covered by this CR's no-mock smoke.
    """

    def _serve_interrupted(self):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._make_executable(self.server_bin)
        out, err = io.StringIO(), io.StringIO()
        with _patched_env(**self._serve_env()), \
                mock.patch("subprocess.run",
                           side_effect=KeyboardInterrupt()) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names()):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    code = cli.main(["serve"])
                except KeyboardInterrupt:
                    self.fail(
                        "a Ctrl-C must NOT escape `crucible-axi serve` as a "
                        "`KeyboardInterrupt` -- an escaped one is exactly the "
                        "stack trace the console script prints at the operator "
                        "(AC5a)")
        return code, out.getvalue(), err.getvalue(), mock_run

    def test_ctrl_c_returns_130_without_a_traceback(self):
        code, out, err, mock_run = self._serve_interrupted()

        self.assertTrue(
            _launch_calls(mock_run),
            f"the interrupt must be raised from the LAUNCH wait, so a launch "
            f"call must have been composed; calls={mock_run.call_args_list}")
        self.assertEqual(
            code, 130,
            f"a SIGINT'd foreground `serve` must exit 130 (the SIGINT "
            f"convention, 128+2); got {code}; stderr={err!r}")
        for stream_name, text in (("stdout", out), ("stderr", err)):
            self.assertNotIn(
                "Traceback", text,
                f"Ctrl-C must print NO Python traceback on {stream_name}; "
                f"{stream_name}={text!r}")
            self.assertNotIn(
                "KeyboardInterrupt", text,
                f"Ctrl-C must not name the Python exception on {stream_name}; "
                f"{stream_name}={text!r}")


class ServeSignalledChildReportsOneTwentyEightPlusNTest(_ServeFixtureCase):
    """AC5b -- a signal-terminated server reports `128+N`, never a masked
    negative.

    `CompletedProcess.returncode` is NEGATIVE when the child is signalled
    (`-15` SIGTERM, `-9` SIGKILL), and the console script's `sys.exit(-15)`
    masks to OS status 241 -- so a supervisor, including the systemd `--user`
    unit this CR delivers `serve` for, cannot tell the process was signalled.
    `serve` translates it to the conventional `128 - returncode`.
    """

    def _serve_with_returncode(self, returncode):
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        self._make_executable(self.server_bin)
        with _patched_env(**self._serve_env()), \
                mock.patch("subprocess.run",
                           side_effect=_run_side_effect(returncode)) as mock_run, \
                mock.patch("shutil.which",
                           side_effect=_which_never_finds_bare_names()):
            code, _out, err = _run_cli(cli, ["serve"])
        self.assertTrue(
            _launch_calls(mock_run),
            f"no launch call was composed, so no exit code could be "
            f"translated; code={code} stderr={err!r}")
        return code, err

    def test_sigterm_reports_143_not_the_masked_241(self):
        code, err = self._serve_with_returncode(-15)
        self.assertEqual(
            code, 143,
            f"a SIGTERM'd child (returncode -15) must be reported as 143 "
            f"(128+15); got {code} -- and `sys.exit(-15)` would reach the OS as "
            f"241, which tells a supervisor nothing; stderr={err!r}")

    def test_sigkill_reports_137(self):
        code, err = self._serve_with_returncode(-9)
        self.assertEqual(
            code, 137,
            f"a SIGKILL'd child (returncode -9) must be reported as 137 "
            f"(128+9); got {code}; stderr={err!r}")

    def test_a_positive_child_code_is_not_translated(self):
        """The translation applies ONLY to the negative signalled codes -- a
        real non-zero exit status still passes through verbatim (AC5)."""
        code, err = self._serve_with_returncode(3)
        self.assertEqual(
            code, 3,
            f"a positive exit status must pass through unchanged; got {code}; "
            f"stderr={err!r}")


def _fast_provision_server_stage(target_dir, force):
    """A [server] stage double that PROVISIONS instantly: no subprocess, no
    network, no Bun. Matches the `(target_dir, force)` runner protocol."""
    return {"path": os.path.join(target_dir, "server"), "converged": False}


class InstallCreatesItsTargetDirTest(unittest.TestCase):
    """AC7 / §S1b -- `run_install` creates `target_dir` before any stage runs,
    so a first install on a clean machine writes its manifest and exits 0."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="cr066-target-root-")
        # The decisive fixture: a target dir that does NOT exist, exactly as on
        # a fresh machine with no `~/.crucible`.
        self.target = os.path.join(self.root, "clean-machine", ".crucible")
        self.assertFalse(os.path.exists(self.target))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _manifest_path(self):
        return os.path.join(self.target, MANIFEST_FILENAME)

    def test_run_install_creates_a_missing_target_dir_and_writes_the_manifest(self):
        install, = _import_fresh("crucible_axi.install")
        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS,
                             {"server": _fast_provision_server_stage}):
            ok, stages, warnings = install.run_install(self.target)

        self.assertTrue(
            os.path.isdir(self.target),
            f"`run_install` must CREATE its target directory before running "
            f"any stage (§S1b) -- {self.target!r} does not exist; nothing in "
            f"crucible_axi ever calls makedirs today")
        self.assertTrue(
            os.path.isfile(self._manifest_path()),
            f"the [manifest] stage must have written {MANIFEST_FILENAME} "
            f"INSIDE the freshly created target dir; warnings={warnings}")
        self.assertTrue(
            ok, f"a first install against a non-existent target dir must be "
                f"ok:true (AC7) -- it dies FileNotFoundError today; "
                f"warnings={warnings}")
        self.assertEqual(
            [s["name"] for s in stages], ["server", "fleet", "manifest"],
            f"all three stages must have run to completion; stages={stages}")

    def test_run_install_twice_on_a_missing_target_dir_is_idempotent(self):
        """`exist_ok=True`: the second run neither raises on the now-existing
        directory nor rewrites a different manifest (AC7 idempotency)."""
        install, = _import_fresh("crucible_axi.install")
        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS,
                             {"server": _fast_provision_server_stage}):
            ok1, stages1, warnings1 = install.run_install(self.target)
            first = Path(self._manifest_path()).read_text(encoding="utf-8") \
                if os.path.isfile(self._manifest_path()) else None
            ok2, stages2, warnings2 = install.run_install(self.target)
            second = Path(self._manifest_path()).read_text(encoding="utf-8") \
                if os.path.isfile(self._manifest_path()) else None

        self.assertTrue(
            ok1, f"first run must be ok:true; warnings={warnings1}")
        self.assertTrue(
            ok2,
            f"a target dir that ALREADY exists must be fine -- the creation is "
            f"`exist_ok=True`, never a raise; warnings={warnings2}")
        self.assertIsNotNone(first, "first run must have written the manifest")
        self.assertEqual(
            first, second,
            "the second run must converge on the SAME manifest document, not "
            "clobber the created target dir")
        manifest2 = next(s for s in stages2 if s["name"] == "manifest")
        self.assertTrue(
            manifest2["converged"],
            f"the second run's [manifest] stage must report converged:true; "
            f"stages={stages2}")

    def test_cli_install_exits_zero_against_a_nonexistent_target_dir(self):
        """AC7 end to end -- the exact smoke that exposed §S1b: drive the real
        `cli.main(['install', '--target-dir', <missing>])` (server stage stubbed
        to a fast provision) and require exit 0 plus a manifest on disk."""
        install, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS,
                             {"server": _fast_provision_server_stage}):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target])

        self.assertTrue(
            os.path.isfile(self._manifest_path()),
            f"`crucible-axi install` must write {MANIFEST_FILENAME} into the "
            f"target dir it creates; stdout={out!r} stderr={err!r}")
        self.assertEqual(
            code, 0,
            f"`crucible-axi install` must exit 0 on a clean machine (AC7) -- "
            f"it exits 1 today because the target dir is never created; "
            f"stdout={out!r} stderr={err!r}")


class InstallUnwritableTargetFailsDefinitivelyTest(unittest.TestCase):
    """AC7 (negative) -- a genuinely unwritable target still fails
    DEFINITIVELY, naming the target directory as a creation/permission failure.
    Never swallowed, and never a cryptic downstream missing-file error."""

    def setUp(self):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root ignores directory permissions")
        self.root = tempfile.mkdtemp(prefix="cr066-unwritable-root-")
        self.target = os.path.join(self.root, "crucible")
        os.chmod(self.root, stat.S_IRUSR | stat.S_IXUSR)  # 0o500 -- no write

    def tearDown(self):
        os.chmod(self.root, 0o700)
        shutil.rmtree(self.root, ignore_errors=True)

    def test_unwritable_target_fails_definitively_naming_the_path(self):
        install, = _import_fresh("crucible_axi.install")
        raised = None
        ok, warnings = None, []
        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS,
                             {"server": _fast_provision_server_stage}):
            try:
                ok, _stages, warnings = install.run_install(self.target)
            except OSError as exc:  # a propagated makedirs failure is definitive too
                raised = exc

        text = f"{type(raised).__name__}: {raised}" if raised else \
            " ".join(str(w.get("detail", w)) for w in warnings)

        self.assertFalse(
            ok,
            f"an unwritable target must NOT report ok:true; "
            f"warnings={warnings}")
        self.assertIn(
            self.target, text,
            f"the failure must NAME the target directory (§S1b); text={text!r}")
        self.assertTrue(
            re.search(r"permission|denied|errno 13|creat", text, re.I),
            f"the failure must identify the target directory as unwritable / "
            f"uncreatable -- not surface as a cryptic missing-file error about "
            f"{MANIFEST_FILENAME}; text={text!r}")


if __name__ == "__main__":
    unittest.main()
