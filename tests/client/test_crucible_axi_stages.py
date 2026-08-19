"""CR-CRU-009 C2 -- the CONCRETE `[server]` sub-installer stage delegation
(§S2), pinned against C1's placeholder `_server_stage` in
`crucible_axi/install.py`.

CR-CRU-042 §S1/§S1b flipped this file's contract to the TWO-stage
installer: `STAGE_ORDER == ("server", "manifest")`. The `[skills]` stage
(`_skills_stage`, `_skills_already_installed`, `SKILLS_CLI_SOURCE`) is
Model-B's scope now (Sandesh 1337/1342) and is retired from this suite --
Crucible no longer ships an `npx skills` invocation, and no envelope this
suite exercises may carry a `skills` key.

Contract pinned from docs/changes/CR-CRU-066-install-provisions-not-runs-plus-serve.md
§S1/§S5 (CR-CRU-066 P0), superseding CR-CRU-009's npx-run contract:

    - **[server]** PROVISIONS the server package user-scoped via
      `bun add -g <crucible-server-npm-pkg>@<pin>` and RETURNS -- it NEVER
      runs/serves (the 0.1.1 bug: `npx -y <server>` blocked forever because
      that npm bin IS the server).
    - Idempotent via a REAL probe: the resolved `crucible-server` bin exists
      under Bun's global bin (`$BUN_INSTALL/bin`, default `~/.bun/bin`) -- not
      a fictional `<target_dir>/server` dir npx never creates.

This RED slice PINS the exact stage-runner contract GREEN must build:

    crucible_axi/install.py
        import subprocess                      # module-level `import
        import shutil                          # subprocess`/`import shutil`
                                                # (NOT `from x import y`) --
                                                # tests patch
                                                # `crucible_axi.install.
                                                # subprocess.run` and
                                                # `...install.shutil.which`.

        STAGE_ORDER: tuple                      # == ("server", "manifest")
                                                 # exactly (CR-CRU-042 §S1).

        SERVER_NPM_PACKAGE: str                 # published npm package name of
                                                 # the bun/node server.

        _server_already_installed(target_dir) -> bool
            REAL idempotency probe -- True when the resolved `crucible-server`
            bin exists under Bun's global bin (`$BUN_INSTALL/bin`, default
            `~/.bun/bin`). SEAM GREEN MUST SETTLE: Bun global-bin resolution
            honours `$BUN_INSTALL`.

        _server_stage(target_dir, force) -> {"path": str, "converged": bool}
            1. If not force and `_server_already_installed(...)`: return
               converged=True WITHOUT invoking subprocess at all.
            2. If `shutil.which("bun")` is None: run the Bun curl-installer
               FIRST (`curl -fsSL https://bun.sh/install | bash`, via
               subprocess.run, shell or `bash -c` form).
            3. PROVISION via subprocess.run(["bun", "add", "-g",
               f"{SERVER_NPM_PACKAGE}@{version}"]) -- and RETURN. NEVER `npx`,
               never a server-RUN command.
            4. If the provision subprocess's `.returncode != 0`: raise
               RuntimeError with a message naming "server" and the "bun"
               command (structured, not swallowed) -- run_install's fail-fast
               then engages.
            5. Otherwise return {"path": ..., "converged": False}.

    DEFAULT_STAGE_RUNNERS carries EXACTLY `{"server": ..., "manifest": ...}`
    -- no `"skills"` key -- so `run_install(target_dir)` with NO injected
    `stage_runners` must, with subprocess/shutil/already-installed all
    mocked to "fresh success", execute server -> manifest and return
    `ok=True` with exactly the two stage names present, and must never
    invoke `npx` at all.

Invocation:
    python3 -m pytest tests/client/test_crucible_axi_stages.py -q
Fallback:
    python3 tests/client/test_crucible_axi_stages.py
"""

import importlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(module_name):
    """Import (or re-import) a `crucible_axi` module from the repo-root
    checkout, purging any stale cache entry first so each test gets an
    independent import attempt (same convention as
    test_crucible_axi_install.py's `_import_fresh`)."""
    _ensure_repo_root_on_path()
    for mod in list(sys.modules):
        if mod == module_name or mod.startswith(module_name + "."):
            del sys.modules[mod]
    return importlib.import_module(module_name)


def _call_command_text(call):
    """Flatten a `mock.call` to `subprocess.run(...)` into one searchable
    string, regardless of whether GREEN passes a list argv or a shell=True
    string command."""
    args = call.args[0] if call.args else call.kwargs.get("args", "")
    if isinstance(args, (list, tuple)):
        return " ".join(str(a) for a in args)
    return str(args)


class ServerStageTest(unittest.TestCase):
    """§S1 [server] -- PROVISIONS the server user-scoped via
    `bun add -g <SERVER_NPM_PACKAGE>@<pin>` and RETURNS (never runs/serves),
    with a Bun curl-bootstrap fallback when Bun is absent from PATH."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-server-stage-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def _provision_calls(mock_run):
        """The `subprocess.run` calls whose argv is a `bun add -g ...` list.

        argv[0] is matched by BASENAME: CR-CRU-066 §S2 provisions with the
        RESOLVED ABSOLUTE bun path, never the bare `bun` token."""
        found = []
        for c in mock_run.call_args_list:
            argv = c.args[0] if c.args else c.kwargs.get("args")
            if not isinstance(argv, (list, tuple)):
                continue
            argv = list(argv)
            if len(argv) >= 3 and os.path.basename(str(argv[0])) == "bun" \
                    and argv[1:3] == ["add", "-g"]:
                found.append(argv)
        return found

    def test_server_stage_provisions_via_bun_add_g_with_pinned_package_when_bun_present(self):
        """The [server] stage PROVISIONS via `bun add -g
        <SERVER_NPM_PACKAGE>@<version>` and returns -- it must NEVER shell out
        to `npx` (that RUNS the server and hangs the install -- CR-CRU-066).

        Patches `crucible_axi.__version__` to a realistic installed-release
        value -- the live value in a source checkout is the
        `_SOURCE_CHECKOUT_VERSION` sentinel (CR-CRU-041 S6), a separate
        fail-fast contract covered by ServerStageFailsFastOnUnresolvedVersionTest,
        not this stage-delegation test."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        with mock.patch.object(axi, "__version__", "0.1.0"), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 0
            result = install._server_stage(self.tmp, False)

        self.assertIn("path", result)
        self.assertIn("converged", result)
        self.assertFalse(
            result["converged"],
            "a fresh (non-already-installed) server stage run must not "
            "report converged:True")

        provisions = self._provision_calls(mock_run)
        self.assertEqual(
            len(provisions), 1,
            f"expected exactly one `bun add -g` provision call, got "
            f"calls={mock_run.call_args_list}")
        self.assertEqual(
            os.path.basename(provisions[0][0]), "bun",
            f"argv[0] must be a bun executable -- CR-CRU-066 §S2 runs the "
            f"RESOLVED ABSOLUTE bun path there; got {provisions[0]}")
        self.assertEqual(
            provisions[0][1:],
            ["add", "-g", f"{install.SERVER_NPM_PACKAGE}@0.1.0"],
            "the server stage must provision the version-pinned package "
            "user-scoped via `bun add -g <SERVER_NPM_PACKAGE>@<version>`")

        # NEVER `npx` -- that bin IS the server and blocks forever (the 0.1.1
        # bug this CR fixes).
        npx_calls = [c for c in mock_run.call_args_list
                     if "npx" in _call_command_text(c)]
        self.assertEqual(
            npx_calls, [],
            f"the server stage must NEVER invoke `npx` (it RUNS the server and "
            f"hangs the install -- CR-CRU-066); found calls={npx_calls}")

        # Bun already present -- the curl bootstrap must NOT run.
        bun_install_calls = [c for c in mock_run.call_args_list
                              if "bun.sh/install" in _call_command_text(c)]
        self.assertEqual(
            bun_install_calls, [],
            "Bun is present on PATH -- the curl bootstrap must be skipped")

    def test_server_stage_bootstraps_bun_via_curl_installer_before_provision_when_bun_absent(self):
        """When Bun is absent the curl bootstrap runs FIRST, then the
        `bun add -g` provision -- and still NEVER `npx`.

        Patches `crucible_axi.__version__` to a realistic installed-release
        value (see the sibling test's note on the source-checkout sentinel).

        `$BUN_INSTALL` points at a tmp fixture tree holding an executable
        `bin/bun` -- what the curl bootstrap leaves behind. Under CR-CRU-066
        §S2 the stage RE-RESOLVES Bun there after bootstrapping (a freshly
        installed Bun is not on the PATH this process inherited) and VERIFIES
        it, so the fixture keeps this test machine-independent instead of
        leaning on the developer's real `~/.bun`."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        bun_root = tempfile.mkdtemp(prefix="crucible-axi-bun-root-")
        self.addCleanup(shutil.rmtree, bun_root, ignore_errors=True)
        os.makedirs(os.path.join(bun_root, "bin"), exist_ok=True)
        fake_bun = os.path.join(bun_root, "bin", "bun")
        with open(fake_bun, "w") as handle:
            handle.write("#!/bin/sh\necho 1.1.34\n")
        os.chmod(fake_bun, 0o755)
        with mock.patch.dict(os.environ, {"BUN_INSTALL": bun_root}), \
                mock.patch.object(axi, "__version__", "0.1.0"), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value=None), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 0
            result = install._server_stage(self.tmp, False)

        self.assertFalse(result["converged"])
        self.assertGreaterEqual(
            len(mock_run.call_args_list), 2,
            "expected both a bun-install call and a `bun add -g` provision "
            f"call, got calls={mock_run.call_args_list}")

        first_call_text = _call_command_text(mock_run.call_args_list[0])
        self.assertIn("curl", first_call_text)
        self.assertIn("bun.sh/install", first_call_text)
        self.assertIn("bash", first_call_text)

        provision_indices = [
            i for i, c in enumerate(mock_run.call_args_list)
            if (c.args and isinstance(c.args[0], (list, tuple))
                and len(c.args[0]) >= 3
                and os.path.basename(str(list(c.args[0])[0])) == "bun"
                and list(c.args[0])[1:3] == ["add", "-g"])]
        self.assertTrue(
            provision_indices,
            "expected a `bun add -g` provision call after the Bun bootstrap")
        self.assertGreater(
            provision_indices[0], 0,
            "the Bun curl-install bootstrap must run BEFORE the `bun add -g` "
            "provision step when Bun is absent")

        npx_calls = [c for c in mock_run.call_args_list
                     if "npx" in _call_command_text(c)]
        self.assertEqual(
            npx_calls, [],
            f"the server stage must NEVER invoke `npx`; found calls={npx_calls}")

    def test_server_stage_raises_naming_bun_command_when_provision_exits_nonzero(self):
        """Negative/error path -- a non-zero `bun add -g` exit must surface as
        a raised, structured exception (so run_install's fail-fast + ok:false
        engages), never be swallowed. The message names "server" and the
        "bun" command it ran -- NOT "npx" (the retired 0.1.1 wording).

        Patches `crucible_axi.__version__` to a realistic installed-release
        value (see the first test's note on the source-checkout sentinel)."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        with mock.patch.object(axi, "__version__", "0.1.0"), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 1
            with self.assertRaises(RuntimeError) as ctx:
                install._server_stage(self.tmp, False)

        message = str(ctx.exception).lower()
        self.assertIn("server", message)
        self.assertIn(
            "bun", message,
            "the failure message must name the `bun` provision command")
        self.assertNotIn(
            "npx", message,
            "the server stage no longer shells out to npx -- the failure "
            "message must not mention it (CR-CRU-066)")

    def test_server_stage_reports_converged_true_when_already_installed_without_invoking_subprocess(self):
        install = _import_fresh("crucible_axi.install")
        with mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=True):
            result = install._server_stage(self.tmp, False)

        self.assertTrue(result["converged"])
        self.assertFalse(
            mock_run.called,
            "an already-installed server stage must not re-invoke any "
            "provisioning subprocess call")


class ServerAlreadyInstalledProbeTest(unittest.TestCase):
    """§S1 REAL idempotency probe -- `_server_already_installed` is True iff the
    resolved `crucible-server` bin exists under Bun's global bin
    (`$BUN_INSTALL/bin`, default `~/.bun/bin`), NOT a fictional
    `<target_dir>/server` dir `npx` never creates (the 0.1.1 bug).

    SEAM GREEN MUST SETTLE: Bun global-bin resolution honours `$BUN_INSTALL`."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-probe-target-")
        self.bun_root = tempfile.mkdtemp(prefix="crucible-axi-bun-root-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        shutil.rmtree(self.bun_root, ignore_errors=True)

    def test_probe_true_when_crucible_server_bin_present_under_bun_global_bin(self):
        install = _import_fresh("crucible_axi.install")
        bin_dir = os.path.join(self.bun_root, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        bin_path = os.path.join(bin_dir, "crucible-server")
        with open(bin_path, "w") as f:
            f.write("#!/usr/bin/env bun\n")
        os.chmod(bin_path, 0o755)

        # target_dir deliberately has NO `server/` subdir -- the retired probe
        # would (wrongly) report not-installed here.
        with mock.patch.dict(os.environ, {"BUN_INSTALL": self.bun_root}):
            self.assertTrue(
                install._server_already_installed(self.tmp),
                "a `crucible-server` bin present under Bun's global bin means "
                "the server is provisioned -- the probe must report installed")

    def test_probe_false_when_bin_absent_even_if_target_dir_server_exists(self):
        install = _import_fresh("crucible_axi.install")
        os.makedirs(os.path.join(self.bun_root, "bin"), exist_ok=True)
        # A `<target_dir>/server` dir must NOT fool the probe -- only the bin
        # under Bun's global bin is the truth.
        os.makedirs(os.path.join(self.tmp, "server"), exist_ok=True)

        with mock.patch.dict(os.environ, {"BUN_INSTALL": self.bun_root}):
            self.assertFalse(
                install._server_already_installed(self.tmp),
                "no `crucible-server` bin under Bun's global bin => the server "
                "is not provisioned, regardless of any `<target_dir>/server`")


class StageOrderContractTest(unittest.TestCase):
    """CR-CRU-042 §S1 -- `STAGE_ORDER` is exactly the two surviving stages,
    in order. The `[skills]` stage is retired (Model-B scope now)."""

    def test_stage_order_is_exactly_server_then_manifest(self):
        install = _import_fresh("crucible_axi.install")
        self.assertEqual(
            install.STAGE_ORDER, ("server", "manifest"),
            "STAGE_ORDER must be exactly the two-stage (server, manifest) "
            "order -- the [skills] stage is Model-B's scope now "
            "(CR-CRU-042)")


class StagedInstallEndToEndMockedTest(unittest.TestCase):
    """§S2 end-to-end (mocked externals) -- `run_install` with NO injected
    `stage_runners` (i.e. `DEFAULT_STAGE_RUNNERS`) must drive the REAL
    `_server_stage` -> `manifest.run_manifest_stage` chain and aggregate
    `ok:True`, complementing C1's injected-stub coverage by exercising the
    DEFAULT runners with subprocess/Bun mocked.

    CR-CRU-042 narrows this to the two-stage contract: no `skills` key in
    the envelope, and no invoked command may contain `npx skills` -- the
    anti-regression assertion the CR requires, checked against the actual
    captured command set so a re-introduction of the skills stage fails
    this suite."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-stages-e2e-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_run_install_default_runners_server_manifest_all_ok_true_with_subprocess_mocked(self):
        """Patches `crucible_axi.__version__` to a realistic installed-release
        value -- the live value in a source checkout is the
        `_SOURCE_CHECKOUT_VERSION` sentinel (CR-CRU-041 S6), which is a
        separate, dedicated fail-fast contract covered by
        ServerStageFailsFastOnUnresolvedVersionTest, not this end-to-end
        stage-sequencing test."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        with mock.patch.object(axi, "__version__", "0.1.0"), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 0
            ok, stages, warnings = install.run_install(self.tmp)

        self.assertTrue(
            ok, f"expected ok:True with every sub-installer mocked to "
                f"success, warnings={warnings}")
        self.assertEqual(
            [s["name"] for s in stages], ["server", "manifest"],
            "expected exactly the two surviving stages, in order -- no "
            "'skills' key anywhere in the envelope")
        for stage in stages:
            self.assertTrue(stage["path"], f"empty path for stage {stage}")
        self.assertEqual(warnings, [])

        # server drove at least one real subprocess.run() call via the
        # (unmocked-except-for-subprocess) DEFAULT_STAGE_RUNNERS.
        self.assertGreaterEqual(mock_run.call_count, 1)

        # Anti-regression: no invoked command may shell out to `npx
        # skills` -- a re-introduction of the retired [skills] stage must
        # fail this suite, not silently pass.
        skills_calls = [c for c in mock_run.call_args_list
                        if "npx skills" in _call_command_text(c)]
        self.assertEqual(
            skills_calls, [],
            f"no invoked command may contain 'npx skills' -- the [skills] "
            f"stage is retired (CR-CRU-042); found calls={skills_calls}")

        # manifest ran for real (not mocked) -- the file lands on disk.
        manifest_path = os.path.join(self.tmp, "crucible-clients.json")
        self.assertTrue(
            os.path.exists(manifest_path),
            "the real manifest stage must still write crucible-clients.json")

    def test_run_install_default_runners_never_invoke_npx_skills_even_when_stage_already_installed(self):
        """Idempotent re-run path: with the server stage reporting
        already-installed (converged:True, no subprocess call), the
        installer must still never touch `npx skills` -- covering the
        converged branch of the anti-regression contract, not just the
        fresh-install branch above."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        with mock.patch.object(axi, "__version__", "0.1.0"), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=True):
            mock_run.return_value.returncode = 0
            ok, stages, warnings = install.run_install(self.tmp)

        self.assertTrue(ok, f"expected ok:True on the converged re-run, "
                             f"warnings={warnings}")
        self.assertEqual([s["name"] for s in stages], ["server", "manifest"])

        skills_calls = [c for c in mock_run.call_args_list
                        if "npx skills" in _call_command_text(c)]
        self.assertEqual(
            skills_calls, [],
            f"no invoked command may contain 'npx skills' on the "
            f"already-installed/idempotent path either; found "
            f"calls={skills_calls}")


if __name__ == "__main__":
    unittest.main()
