"""CR-CRU-066 C2 (§S2 + ACs 3/4/6) -- Bun is a GUARANTEED install dependency:
detect -> bootstrap -> RE-RESOLVE -> VERIFY -> or FAIL THE INSTALL DEFINITIVELY,
plus the `--no-bun-bootstrap` / `CRUCIBLE_NO_BUN_BOOTSTRAP=1` opt-out, plus the
resolved ABSOLUTE Bun path recorded as a stage output.

Lives in its own module (not appended to `test_crucible_axi_stages.py`) because
that file's docstring pins the SUPERSEDED C1 contract -- the fire-and-forget
`subprocess.run(_BUN_INSTALL_COMMAND, shell=True, check=False)` bootstrap whose
failure is swallowed. This module pins the guarantee-or-fail contract that
replaces the swallow, matching the per-CR file convention already used by
`test_cr051_*`, `test_cr054_*`, `test_cr061_*`.

Contract pinned from docs/changes/CR-CRU-066-install-provisions-not-runs-plus-serve.md
§S2 (ACs 3, 4) and §S1's stage-output line (AC6):

    crucible_axi/install.py

        Bun resolution (SEAM GREEN MUST SETTLE -- a helper such as
        `_resolve_bun_or_fail()` is the natural home):
          1. DETECT: `shutil.which("bun")` (PATH), AND the explicit
             `$BUN_INSTALL/bin/bun` (default `~/.bun/bin/bun`) -- a freshly
             bootstrapped Bun is NOT on the inherited PATH, so PATH alone
             cannot be the only probe (§S2 + Risk "Absolute-path resolution").
          2. BOOTSTRAP when absent (the DEFAULT): the curl installer
             (`curl -fsSL https://bun.sh/install | bash`), then RE-RESOLVE
             including `$BUN_INSTALL/bin`.
          3. VERIFY the resolved bun actually runs: `<abs-bun> --version`
             must exit 0.
          4. Unresolvable OR unverifiable => raise `RuntimeError` naming the
             remedy -- the message mentions "server" (so C1's stage-failure
             wording assertions still hold), installing Bun, and
             `https://bun.sh`. `run_install` then reports `ok=False` carrying
             that message in `warnings[]` -- NEVER a silent continue.
          5. OPT-OUT: `CRUCIBLE_NO_BUN_BOOTSTRAP=1` (env) and the
             `--no-bun-bootstrap` CLI flag => a missing Bun fails IMMEDIATELY
             with the same remedy and the curl bootstrap is NEVER invoked (no
             remote script piped to a shell).
          6. The provision runs the RESOLVED ABSOLUTE bun path (not the bare
             `bun` token, which depends on inherited PATH), and that absolute
             path is recorded as a stage output (`bun` key) so the install
             envelope reports it.

RECONCILIATION GREEN MUST SETTLE (impact set, matching the CR's "the C1 tests
encode the bug and must change with the fix" note):
`tests/client/test_crucible_axi_stages.py::ServerStageTest` pins the provision
argv as EXACTLY `["bun", "add", "-g", ...]` via matchers keyed on
`argv[:3] == ["bun", "add", "-g"]`. Under §S2 the provision argv[0] is the
resolved ABSOLUTE bun path, so those two matchers must be re-pointed to
`os.path.basename(argv[0]) == "bun" and argv[1:3] == ["add", "-g"]` (which
still pins the `bun add -g <pkg>@<pin>` provision), and its bun-absent test
must point `$BUN_INSTALL` at a fixture tree instead of relying on the
machine's real `~/.bun`. This module deliberately does not edit that file --
the reconciliation belongs to the GREEN half that changes the behaviour.

No test here runs the real Bun installer, shells to real bun, touches the
network, or binds a port: every side effect goes through the mockable seams
(`crucible_axi.install.shutil.which`, `...install.subprocess.run`,
`$BUN_INSTALL` pointed at a tmp fixture tree, `$CRUCIBLE_SERVER_VERSION` for
the pin).

Invocation:
    python3 -m pytest tests/client/test_cr066_bun_guarantee.py -q
Fallback:
    python3 tests/client/test_cr066_bun_guarantee.py
"""

import contextlib
import importlib
import io
import os
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


def _command_text(call):
    """Flatten a `mock.call` to `subprocess.run(...)` into one searchable
    string, whether GREEN passes a list argv or a shell=True string."""
    args = call.args[0] if call.args else call.kwargs.get("args", "")
    if isinstance(args, (list, tuple)):
        return " ".join(str(a) for a in args)
    return str(args)


def _argv(call):
    """The list argv of a `subprocess.run` call, or None for a shell string."""
    args = call.args[0] if call.args else call.kwargs.get("args")
    return list(args) if isinstance(args, (list, tuple)) else None


def _bootstrap_indices(mock_run):
    """Indices of the calls that pipe the remote Bun installer to a shell."""
    return [i for i, c in enumerate(mock_run.call_args_list)
            if BOOTSTRAP_NEEDLE in _command_text(c)]


def _provision_indices(mock_run):
    """Indices of the `<bun> add -g ...` provision calls, accepting either the
    bare `bun` token or a resolved absolute bun path as argv[0]."""
    found = []
    for i, c in enumerate(mock_run.call_args_list):
        argv = _argv(c)
        if argv and len(argv) >= 3 and argv[1:3] == ["add", "-g"] \
                and os.path.basename(str(argv[0])) == "bun":
            found.append(i)
    return found


def _verify_indices(mock_run):
    """Indices of the `<bun> --version` verification calls."""
    found = []
    for i, c in enumerate(mock_run.call_args_list):
        argv = _argv(c)
        if argv and len(argv) >= 2 and "--version" in argv[1:] \
                and os.path.basename(str(argv[0])) == "bun":
            found.append(i)
    return found


def _run_side_effect(failing_needles=()):
    """A `subprocess.run` stand-in: returncode 0 unless the flattened command
    contains one of `failing_needles`."""
    def _run(*args, **kwargs):
        call = SimpleNamespace(args=args, kwargs=kwargs)
        text = _command_text(call)
        returncode = 1 if any(n in text for n in failing_needles) else 0
        return SimpleNamespace(returncode=returncode,
                               stdout="1.1.34\n", stderr="",
                               args=args[0] if args else None)
    return _run


def _run_side_effect_bootstrap_installs_bun(install_bun, failing_needles=()):
    """Like `_run_side_effect`, but the BOOTSTRAP call carries the side effect
    the real `curl -fsSL https://bun.sh/install | bash` carries: it LAYS BUN
    DOWN at `$BUN_INSTALL/bin/bun`.

    Modelling that side effect is what lets a test distinguish "Bun was already
    there" from "the bootstrap put it there" -- a fixture that pre-creates the
    fake bun cannot tell those apart, and therefore cannot pin when a bootstrap
    is legitimate.
    """
    base = _run_side_effect(failing_needles)

    def _run(*args, **kwargs):
        call = SimpleNamespace(args=args, kwargs=kwargs)
        if BOOTSTRAP_NEEDLE in _command_text(call):
            install_bun()
        return base(*args, **kwargs)
    return _run


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


def _which_restricted_to(bun_bin_dir, fake_bun):
    """A `shutil.which` stand-in modelling "bun is NOT on the inherited PATH,
    but it DOES exist in `bun_bin_dir`".

    Mirrors real `shutil.which` semantics closely enough to accept either
    re-resolve implementation GREEN may choose: an explicit
    `which("bun", path=<bun bin dir>)`, or a direct absolute-path lookup of
    the fixture bun. A bare `which("bun")` with no explicit path -- i.e. the
    inherited PATH -- always misses."""
    def _which(cmd, mode=os.F_OK | os.X_OK, path=None):
        if os.path.isabs(str(cmd)):
            return str(cmd) if os.path.isfile(str(cmd)) else None
        if os.path.basename(str(cmd)) != "bun":
            return None
        if path and bun_bin_dir in str(path):
            return fake_bun
        return None
    return _which


class _BunFixtureCase(unittest.TestCase):
    """Shared fixture: a tmp install target, plus a tmp `$BUN_INSTALL` root
    that starts EMPTY (`_make_fake_bun` populates it when a test wants Bun to
    resolve after the bootstrap)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cr066-bun-target-")
        self.bun_root = tempfile.mkdtemp(prefix="cr066-bun-root-")
        self.bun_bin_dir = os.path.join(self.bun_root, "bin")
        os.makedirs(self.bun_bin_dir, exist_ok=True)
        self.fake_bun = os.path.join(self.bun_bin_dir, "bun")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        shutil.rmtree(self.bun_root, ignore_errors=True)

    def _make_fake_bun(self):
        """Lay down an executable `$BUN_INSTALL/bin/bun` -- what the curl
        bootstrap would leave behind (and what PATH does NOT know about)."""
        with open(self.fake_bun, "w") as handle:
            handle.write("#!/bin/sh\necho 1.1.34\n")
        os.chmod(self.fake_bun, 0o755)
        return self.fake_bun

    def _bun_env(self, **extra):
        env = {
            "BUN_INSTALL": self.bun_root,
            "CRUCIBLE_SERVER_VERSION": PINNED_VERSION,
            "CRUCIBLE_NO_BUN_BOOTSTRAP": None,
        }
        env.update(extra)
        return env


class BunBootstrapReResolveVerifyTest(_BunFixtureCase):
    """AC3 + §S2 -- Bun is detected at BOTH locations FIRST (PATH and the
    explicit `$BUN_INSTALL/bin/bun`); the bootstrap runs ONLY when Bun is
    genuinely absent from both, and is then followed by RE-RESOLVE, VERIFY
    `bun --version`, and the provision, using the resolved ABSOLUTE bun path.

    RETARGETED at VERIFY (CR-CRU-066 FIX round): the ordering test here used to
    pre-create the fake `$BUN_INSTALL/bin/bun` and still demand exactly one
    bootstrap. That pinned the WRONG contract -- and the implementation was bent
    to satisfy it by probing PATH only, so the state this CR's own install
    creates (Bun under `~/.bun`, shell PATH not re-sourced) re-piped the remote
    installer on every `--force`/re-provision. The fixture now models the
    bootstrap's real side effect (it writes the bun) instead of pre-creating it,
    so "bootstrap" and "Bun was already present" are distinguishable and the
    tests can pin the detect-both-first contract the RED module always stated.
    """

    def test_bun_only_at_the_bun_install_prefix_is_used_without_any_bootstrap(self):
        """Bun present at `$BUN_INSTALL/bin/bun` but NOT on PATH -- exactly the
        state this CR's own install leaves behind before the operator re-sources
        their shell. That Bun is perfectly usable, so ZERO bootstraps may run
        and the provision must proceed with its absolute path."""
        install, = _import_fresh("crucible_axi.install")
        bun_path = self._make_fake_bun()
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            bun_path)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect_bootstrap_installs_bun(
                self._make_fake_bun)
            result = install._server_stage(self.tmp, False)

        calls = mock_run.call_args_list
        self.assertEqual(
            _bootstrap_indices(mock_run), [],
            f"a Bun already at $BUN_INSTALL/bin must be DETECTED, never "
            f"re-fetched: piping the remote installer to a shell here is both "
            f"wasteful and the very behaviour the opt-out exists to avoid "
            f"(§S2); calls={calls}")
        provisions = _provision_indices(mock_run)
        self.assertTrue(
            provisions,
            f"the provision must still run with the prefix Bun; calls={calls}")
        self.assertEqual(
            _argv(calls[provisions[0]])[0], bun_path,
            f"the provision must use the ABSOLUTE $BUN_INSTALL/bin/bun that was "
            f"already there; calls={calls}")
        self.assertEqual(result.get("bun"), bun_path)

    def test_bootstrap_then_reresolve_then_verify_then_provision_in_order(self):
        """Bun absent from BOTH locations -- the only state that justifies the
        bootstrap. Exactly one runs, and the bun it lays down is then
        re-resolved, verified and used."""
        install, = _import_fresh("crucible_axi.install")
        self.assertFalse(
            os.path.exists(self.fake_bun),
            "fixture sanity: Bun must be absent from BOTH locations here -- the "
            "bootstrap is what creates it")
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            self.fake_bun)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect_bootstrap_installs_bun(
                self._make_fake_bun)
            result = install._server_stage(self.tmp, False)

        bootstraps = _bootstrap_indices(mock_run)
        verifies = _verify_indices(mock_run)
        provisions = _provision_indices(mock_run)
        calls = mock_run.call_args_list

        self.assertEqual(
            len(bootstraps), 1,
            f"Bun absent from PATH AND from $BUN_INSTALL/bin => exactly one "
            f"curl bootstrap, got calls={calls}")
        self.assertTrue(
            verifies,
            f"the re-resolved Bun must be VERIFIED with a `<abs-bun> "
            f"--version` run before the install trusts it (§S2) -- no such "
            f"call in calls={calls}")
        self.assertTrue(
            provisions,
            f"the provision must still proceed once Bun is guaranteed, got "
            f"calls={calls}")
        self.assertLess(
            bootstraps[0], verifies[0],
            "the curl bootstrap must run BEFORE the version verification")
        self.assertLess(
            verifies[0], provisions[0],
            "the `bun --version` verification must run BEFORE the "
            "`bun add -g` provision -- an unverified Bun must never reach the "
            "provision step")

        # RE-RESOLVE: the verification (and the provision below) address the
        # bun the installer just laid down under `$BUN_INSTALL/bin`, NOT the
        # bare token the inherited PATH cannot resolve.
        self.assertEqual(
            _argv(calls[verifies[0]])[0], self.fake_bun,
            "the verification must run the RE-RESOLVED absolute Bun path from "
            "`$BUN_INSTALL/bin` (a freshly bootstrapped Bun is not on the "
            "inherited PATH)")
        self.assertFalse(
            result.get("converged", False),
            "a fresh provision must not report converged:True")

    def test_provision_argv0_is_the_resolved_absolute_bun_path(self):
        """The provision must not rely on inherited PATH: argv[0] is the
        resolved ABSOLUTE bun path, never the bare `bun` token (§S2 Risk:
        absolute-path resolution must survive a minimal PATH)."""
        install, = _import_fresh("crucible_axi.install")
        bun_path = self._make_fake_bun()
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            bun_path)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            install._server_stage(self.tmp, False)

        provisions = _provision_indices(mock_run)
        self.assertTrue(
            provisions,
            f"expected a `bun add -g` provision call, got "
            f"calls={mock_run.call_args_list}")
        argv = _argv(mock_run.call_args_list[provisions[0]])
        self.assertEqual(
            argv,
            [bun_path, "add", "-g",
             f"{install.SERVER_NPM_PACKAGE}@{PINNED_VERSION}"],
            "the provision must invoke the RESOLVED ABSOLUTE bun path with the "
            "version-pinned package -- not the bare string `bun`")

    def test_unresolvable_bun_after_bootstrap_raises_runtime_error_naming_remedy(self):
        """Bootstrap ran but Bun still cannot be resolved => a definitive
        RuntimeError naming the remedy, and NO provision attempt (the current
        `check=False` swallow that limps on to a cryptic failure is the bug
        this closes)."""
        install, = _import_fresh("crucible_axi.install")
        # `$BUN_INSTALL/bin` stays EMPTY -- the bootstrap "failed".
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            self.fake_bun)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            with self.assertRaises(RuntimeError) as ctx:
                install._server_stage(self.tmp, False)

        message = str(ctx.exception)
        lowered = message.lower()
        self.assertIn("bun", lowered,
                      f"the remedy must name Bun; message={message!r}")
        self.assertIn("install", lowered,
                      f"the remedy must tell the operator to INSTALL Bun; "
                      f"message={message!r}")
        self.assertIn("https://bun.sh", message,
                      f"the remedy must carry the https://bun.sh source; "
                      f"message={message!r}")
        self.assertIn(
            "server", lowered,
            f"the failure must stay attributable to the [server] stage (C1's "
            f"stage-failure wording); message={message!r}")
        self.assertEqual(
            _provision_indices(mock_run), [],
            f"an unguaranteed Bun must NEVER reach the `bun add -g` provision; "
            f"calls={mock_run.call_args_list}")

    def test_run_install_surfaces_unresolvable_bun_as_ok_false_with_remedy(self):
        """`run_install` must report the failure -- ok=False plus the remedy in
        `warnings[]` -- never a silent continue (AC3)."""
        install, = _import_fresh("crucible_axi.install")
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            self.fake_bun)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            ok, stages, warnings = install.run_install(self.tmp)

        self.assertFalse(
            ok, f"an unguaranteed Bun must fail the whole install; "
                f"stages={stages} warnings={warnings}")
        details = " ".join(str(w.get("detail", "")) for w in warnings)
        self.assertIn(
            "https://bun.sh", details,
            f"the install envelope must carry the Bun remedy so the operator "
            f"knows what to do; warnings={warnings}")
        self.assertEqual(
            [s["name"] for s in stages], [],
            f"fail-fast: no stage may be reported as completed when the "
            f"[server] stage could not guarantee Bun; stages={stages}")
        self.assertFalse(
            os.path.exists(os.path.join(self.tmp, "crucible-clients.json")),
            "the [manifest] stage must be skipped by fail-fast")

    def test_verification_failure_fails_definitively_without_provisioning(self):
        """A resolvable bun whose `bun --version` exits non-zero is NOT usable
        -- same definitive failure with the remedy, and no provision (AC3
        'then verify `bun --version` actually runs')."""
        install, = _import_fresh("crucible_axi.install")
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect(
                failing_needles=("--version",))
            with self.assertRaises(RuntimeError) as ctx:
                install._server_stage(self.tmp, False)

        message = str(ctx.exception)
        self.assertIn("https://bun.sh", message,
                      f"a failed `bun --version` must fail with the same named "
                      f"remedy; message={message!r}")
        self.assertIn("bun", message.lower())
        self.assertEqual(
            _provision_indices(mock_run), [],
            f"a Bun that fails verification must NEVER reach the provision -- "
            f"no silent continue; calls={mock_run.call_args_list}")


class BunBootstrapOptOutTest(_BunFixtureCase):
    """AC4 -- `CRUCIBLE_NO_BUN_BOOTSTRAP=1` / `--no-bun-bootstrap`: a missing
    Bun fails IMMEDIATELY with the remedy, and the remote installer is NEVER
    piped to a shell."""

    def test_env_opt_out_fails_immediately_and_never_invokes_curl_bootstrap(self):
        install, = _import_fresh("crucible_axi.install")
        with _patched_env(**self._bun_env(CRUCIBLE_NO_BUN_BOOTSTRAP="1")), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            self.fake_bun)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            with self.assertRaises(RuntimeError) as ctx:
                install._server_stage(self.tmp, False)

        message = str(ctx.exception)
        self.assertIn("https://bun.sh", message,
                      f"the opt-out path must fail with the SAME named "
                      f"remedy; message={message!r}")
        self.assertEqual(
            _bootstrap_indices(mock_run), [],
            f"CRUCIBLE_NO_BUN_BOOTSTRAP=1 must never pipe the remote Bun "
            f"installer to a shell; calls={mock_run.call_args_list}")
        self.assertEqual(
            _provision_indices(mock_run), [],
            f"the opt-out failure is definitive -- no provision; "
            f"calls={mock_run.call_args_list}")

    def test_env_opt_out_with_bun_already_present_still_provisions(self):
        """The opt-out suppresses only the BOOTSTRAP -- an already-present Bun
        must still verify and provision normally."""
        install, = _import_fresh("crucible_axi.install")
        with _patched_env(**self._bun_env(CRUCIBLE_NO_BUN_BOOTSTRAP="1")), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            result = install._server_stage(self.tmp, False)

        self.assertEqual(_bootstrap_indices(mock_run), [])
        provisions = _provision_indices(mock_run)
        self.assertTrue(
            provisions,
            f"an already-present Bun must still provision under the opt-out; "
            f"calls={mock_run.call_args_list}")
        self.assertEqual(
            _argv(mock_run.call_args_list[provisions[0]])[0], "/usr/bin/bun",
            "the provision must use the resolved absolute Bun path")
        self.assertEqual(result.get("bun"), "/usr/bin/bun")

    def test_cli_parser_accepts_no_bun_bootstrap_flag(self):
        cli, = _import_fresh("crucible_axi.cli")
        args = cli._build_parser().parse_args(
            ["install", "--no-bun-bootstrap", "--target-dir", self.tmp])
        self.assertTrue(
            getattr(args, "no_bun_bootstrap", False),
            "`crucible-axi install --no-bun-bootstrap` must parse into a "
            "truthy `no_bun_bootstrap` flag (AC4)")

    def test_cli_no_bun_bootstrap_flag_fails_install_without_invoking_bootstrap(self):
        """The flag must THREAD from argparse into the [server] stage: a
        missing Bun fails the install (exit 1, envelope carries the remedy)
        and the curl bootstrap is never invoked.

        SEAM GREEN MUST SETTLE: how the flag reaches `_server_stage` --
        normalising it onto `CRUCIBLE_NO_BUN_BOOTSTRAP` in `cmd_install`, or
        threading an explicit argument through `run_install` into the stage
        runners. This test pins the BEHAVIOUR, not the plumbing."""
        cli, install = _import_fresh("crucible_axi.cli", "crucible_axi.install")
        stdout = io.StringIO()
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            self.fake_bun)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            with contextlib.redirect_stdout(stdout):
                code = cli.main(["install", "--target-dir", self.tmp,
                                 "--no-bun-bootstrap"])

        envelope = stdout.getvalue()
        self.assertEqual(
            code, 1,
            f"a missing Bun under --no-bun-bootstrap must fail the install; "
            f"envelope={envelope!r}")
        self.assertEqual(
            _bootstrap_indices(mock_run), [],
            f"--no-bun-bootstrap must never pipe the remote Bun installer to "
            f"a shell; calls={mock_run.call_args_list}")
        self.assertIn(
            "bun.sh", envelope,
            f"the emitted install envelope must carry the Bun remedy; "
            f"envelope={envelope!r}")

    def test_cli_install_bootstraps_by_default_when_flag_absent(self):
        """Auto-bootstrap is the DEFAULT (README intent, AC4): without the flag
        (and without the env opt-out) a GENUINELY missing Bun IS bootstrapped,
        and the install then succeeds.

        Same VERIFY retarget as the ordering test above: Bun must be absent from
        BOTH PATH and `$BUN_INSTALL/bin` for a bootstrap to be legitimate, so
        the fixture lets the mocked bootstrap lay the bun down as its side
        effect rather than pre-creating it."""
        cli, install = _import_fresh("crucible_axi.cli", "crucible_axi.install")
        self.assertFalse(
            os.path.exists(self.fake_bun),
            "fixture sanity: Bun must be genuinely absent before the install")
        stdout = io.StringIO()
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            self.fake_bun)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect_bootstrap_installs_bun(
                self._make_fake_bun)
            with contextlib.redirect_stdout(stdout):
                code = cli.main(["install", "--target-dir", self.tmp])

        envelope = stdout.getvalue()
        self.assertEqual(
            code, 0,
            f"the default auto-bootstrap path must guarantee Bun and complete "
            f"the install; envelope={envelope!r}")
        self.assertEqual(
            len(_bootstrap_indices(mock_run)), 1,
            f"the default path must bootstrap the missing Bun exactly once; "
            f"calls={mock_run.call_args_list}")


class ResolvedBunPathIsAStageOutputTest(_BunFixtureCase):
    """AC6 -- the resolved ABSOLUTE Bun path is recorded as a stage output so
    the install envelope reports it."""

    def test_server_stage_records_resolved_bun_path_when_bun_on_path(self):
        install, = _import_fresh("crucible_axi.install")
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            result = install._server_stage(self.tmp, False)

        self.assertEqual(
            result.get("bun"), "/usr/bin/bun",
            f"the [server] stage must record the resolved ABSOLUTE Bun path as "
            f"a stage output (§S2); result={result}")

    def test_server_stage_records_bootstrapped_bun_path(self):
        install, = _import_fresh("crucible_axi.install")
        bun_path = self._make_fake_bun()
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            bun_path)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            result = install._server_stage(self.tmp, False)

        self.assertEqual(
            result.get("bun"), bun_path,
            f"the recorded Bun path must be the RE-RESOLVED "
            f"`$BUN_INSTALL/bin/bun`, absolute; result={result}")

    def test_run_install_envelope_carries_the_server_stage_bun_path(self):
        install, = _import_fresh("crucible_axi.install")
        bun_path = self._make_fake_bun()
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            bun_path)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            ok, stages, warnings = install.run_install(self.tmp)

        self.assertTrue(ok, f"warnings={warnings}")
        server_stages = [s for s in stages if s["name"] == "server"]
        self.assertTrue(server_stages, f"stages={stages}")
        self.assertEqual(
            server_stages[0].get("bun"), bun_path,
            f"`run_install` must carry the [server] stage's resolved Bun path "
            f"through to the install envelope (§S2); stage={server_stages[0]}")


class BunPresentNoBootstrapGuardTest(_BunFixtureCase):
    """Happy-path regression guard -- Bun already on PATH means the remote
    installer is never fetched (and the provision still runs, verified)."""

    def test_bun_present_on_path_never_invokes_curl_bootstrap(self):
        install, = _import_fresh("crucible_axi.install")
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.side_effect = _run_side_effect()
            result = install._server_stage(self.tmp, False)

        self.assertEqual(
            _bootstrap_indices(mock_run), [],
            f"Bun present on PATH => no curl bootstrap; "
            f"calls={mock_run.call_args_list}")
        provisions = _provision_indices(mock_run)
        self.assertTrue(provisions, f"calls={mock_run.call_args_list}")
        self.assertEqual(
            _argv(mock_run.call_args_list[provisions[0]]),
            ["/usr/bin/bun", "add", "-g",
             f"{install.SERVER_NPM_PACKAGE}@{PINNED_VERSION}"],
            "the provision must run the resolved absolute Bun path with the "
            "pinned package")
        self.assertFalse(result.get("converged", False))

    def test_already_provisioned_server_skips_bun_guarantee_entirely(self):
        """The converged short-circuit must stay side-effect free: no
        bootstrap, no verification, no provision (C1 §S1 idempotency, kept
        intact by the Bun guarantee)."""
        install, = _import_fresh("crucible_axi.install")
        with _patched_env(**self._bun_env()), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           side_effect=_which_restricted_to(self.bun_bin_dir,
                                                            self.fake_bun)), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=True):
            mock_run.side_effect = _run_side_effect()
            result = install._server_stage(self.tmp, False)

        self.assertTrue(result["converged"])
        self.assertFalse(
            mock_run.called,
            f"an already-provisioned server must not bootstrap, verify or "
            f"provision; calls={mock_run.call_args_list}")


if __name__ == "__main__":
    unittest.main()
