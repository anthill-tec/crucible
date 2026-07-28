"""CR-CRU-009 C2 -- the CONCRETE `[server]` + `[skills]` sub-installer stage
delegation (§S2), pinned against C1's placeholder `_server_stage`/
`_skills_stage` in `crucible_axi/install.py`.

Contract pinned from docs/changes/CR-CRU-009-release-0.1.0.md §S2:

    - **[server]** `npx -y <crucible-server-npm-pkg>` fetches + runs the
      bun/node server; bootstrap Bun via
      `curl -fsSL https://bun.sh/install | bash` if absent.
    - **[skills]** `npx skills add <crucible-skills-source> --skill '*'
      --agent '*' -g -y` -- installs the Crucible skill set into every
      detected harness, global scope, non-interactive.
    - Idempotent + scope-parameterized.

RED phase: `_server_stage`/`_skills_stage` in `crucible_axi/install.py` are
C1 PLACEHOLDERS -- they never shell out. Every test below either fails a
plain assertion (no subprocess call recorded) or errors at `mock.patch(...)`
entry (`crucible_axi.install.subprocess`/`.shutil` do not exist as module
attributes yet, nor do `_server_already_installed`/`_skills_already_installed`
or the `SERVER_NPM_PACKAGE`/`SKILLS_CLI_SOURCE` constants) -- a
missing-SUT-symbol error, valid RED per the sub-agent procedure (never
skipped).

This RED slice PINS the exact stage-runner contract GREEN must build:

    crucible_axi/install.py
        import subprocess                      # module-level `import
        import shutil                          # subprocess`/`import shutil`
                                                # (NOT `from x import y`) --
                                                # tests patch
                                                # `crucible_axi.install.
                                                # subprocess.run` and
                                                # `...install.shutil.which`.

        SERVER_NPM_PACKAGE: str                 # placeholder npm package
                                                 # name for the bun/node
                                                 # server (GREEN wires the
                                                 # real published name).
        SKILLS_CLI_SOURCE: str                  # placeholder `skills add`
                                                 # source (owner/repo form;
                                                 # GREEN wires the real
                                                 # public source once S4/S6
                                                 # open-source the repo).

        _server_already_installed(target_dir) -> bool
        _skills_already_installed(target_dir) -> bool
            Idempotency detection seams -- tests patch these directly
            rather than pinning an on-disk marker layout.

        _server_stage(target_dir, force) -> {"path": str, "converged": bool}
            1. If not force and `_server_already_installed(...)`: return
               converged=True WITHOUT invoking subprocess at all.
            2. If `shutil.which("bun")` is None: run the Bun curl-installer
               FIRST (`curl -fsSL https://bun.sh/install | bash`, via
               subprocess.run, shell or `bash -c` form).
            3. Run `npx -y <SERVER_NPM_PACKAGE>` via subprocess.run.
            4. If the npx subprocess's `.returncode != 0`: raise
               RuntimeError with a message mentioning "server" and "npx"
               (structured, not swallowed) -- run_install's fail-fast then
               engages.
            5. Otherwise return {"path": ..., "converged": False}.

        _skills_stage(target_dir, force) -> {"path": str, "converged": bool}
            Same shape: already-installed short-circuit, else
            `npx skills add <SKILLS_CLI_SOURCE> --skill '*' --agent '*'
            -g -y` via subprocess.run; non-zero returncode raises
            RuntimeError mentioning "skills" and "npx".

    DEFAULT_STAGE_RUNNERS unchanged (`_server_stage`/`_skills_stage` are
    already wired in by name from C1) -- `run_install(target_dir)` with NO
    injected `stage_runners` must, with subprocess/shutil/already-installed
    all mocked to "fresh success", execute server -> skills -> manifest and
    return `ok=True` with all three stage names present.

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
    """§S2 [server] -- real `npx -y <SERVER_NPM_PACKAGE>` delegation, with a
    Bun curl-bootstrap fallback when Bun is absent from PATH."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-server-stage-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_server_stage_invokes_npx_with_server_package_when_bun_present(self):
        """Patches `crucible_axi.__version__` to a realistic installed-release
        value -- the live value in a source checkout is the
        `_SOURCE_CHECKOUT_VERSION` sentinel (CR-CRU-041 S6), which is a
        separate, dedicated fail-fast contract covered by
        ServerStageFailsFastOnUnresolvedVersionTest, not this stage-delegation
        test."""
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

        npx_calls = [c for c in mock_run.call_args_list
                     if "npx" in _call_command_text(c)]
        self.assertEqual(
            len(npx_calls), 1,
            f"expected exactly one npx invocation, got "
            f"calls={mock_run.call_args_list}")
        command_text = _call_command_text(npx_calls[0])
        self.assertIn("npx", command_text)
        self.assertIn("-y", command_text)
        self.assertIn(
            install.SERVER_NPM_PACKAGE, command_text,
            "expected the npx invocation to name the SERVER_NPM_PACKAGE "
            "constant")

        # Bun already present -- the curl bootstrap must NOT run.
        bun_install_calls = [c for c in mock_run.call_args_list
                              if "bun.sh/install" in _call_command_text(c)]
        self.assertEqual(
            bun_install_calls, [],
            "Bun is present on PATH -- the curl bootstrap must be skipped")

    def test_server_stage_bootstraps_bun_via_curl_installer_before_npx_when_bun_absent(self):
        """Patches `crucible_axi.__version__` to a realistic installed-release
        value -- the live value in a source checkout is the
        `_SOURCE_CHECKOUT_VERSION` sentinel (CR-CRU-041 S6), which is a
        separate, dedicated fail-fast contract covered by
        ServerStageFailsFastOnUnresolvedVersionTest, not this stage-delegation
        test."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        with mock.patch.object(axi, "__version__", "0.1.0"), \
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
            "expected both a bun-install call and an npx server call, got "
            f"calls={mock_run.call_args_list}")

        first_call_text = _call_command_text(mock_run.call_args_list[0])
        self.assertIn("curl", first_call_text)
        self.assertIn("bun.sh/install", first_call_text)
        self.assertIn("bash", first_call_text)

        npx_call_index = next(
            i for i, c in enumerate(mock_run.call_args_list)
            if "npx" in _call_command_text(c) and "-y" in _call_command_text(c))
        self.assertGreater(
            npx_call_index, 0,
            "the Bun curl-install bootstrap must run BEFORE the npx server "
            "step when Bun is absent")

    def test_server_stage_raises_when_npx_exits_nonzero(self):
        """Negative/error path -- a non-zero npx exit must surface as a
        raised, structured exception (so run_install's fail-fast + ok:false
        engages), never be swallowed.

        Patches `crucible_axi.__version__` to a realistic installed-release
        value -- the live value in a source checkout is the
        `_SOURCE_CHECKOUT_VERSION` sentinel (CR-CRU-041 S6), which is a
        separate, dedicated fail-fast contract covered by
        ServerStageFailsFastOnUnresolvedVersionTest, not this test (which
        must reach the npx call to exercise ITS OWN error path)."""
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
        self.assertIn("npx", message)

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
            "npx/bun subprocess call")


class SkillsStageTest(unittest.TestCase):
    """§S2 [skills] -- real `npx skills add <SKILLS_CLI_SOURCE> --skill '*'
    --agent '*' -g -y` delegation (Vercel Skills CLI, multi-harness fan-out)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-skills-stage-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_skills_stage_invokes_npx_skills_add_with_all_skills_all_agents_global_noninteractive_flags(self):
        install = _import_fresh("crucible_axi.install")
        with mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install._skills_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 0
            result = install._skills_stage(self.tmp, False)

        self.assertIn("path", result)
        self.assertFalse(
            result["converged"],
            "a fresh (non-already-installed) skills stage run must not "
            "report converged:True")

        self.assertEqual(
            mock_run.call_count, 1,
            f"expected exactly one subprocess call, got "
            f"calls={mock_run.call_args_list}")
        command_text = _call_command_text(mock_run.call_args_list[0])
        for token in ("npx", "skills", "add", install.SKILLS_CLI_SOURCE,
                      "-g", "-y", "--skill", "--agent"):
            self.assertIn(
                token, command_text,
                f"expected {token!r} in the skills-add invocation: "
                f"{command_text!r}")
        self.assertIn(
            "*", command_text,
            "expected the all-skills/all-agents wildcard in the invocation")

    def test_skills_stage_raises_when_npx_skills_exits_nonzero(self):
        install = _import_fresh("crucible_axi.install")
        with mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install._skills_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 1
            with self.assertRaises(RuntimeError) as ctx:
                install._skills_stage(self.tmp, False)

        message = str(ctx.exception).lower()
        self.assertIn("skills", message)
        self.assertIn("npx", message)

    def test_skills_stage_reports_converged_true_when_already_installed_without_invoking_subprocess(self):
        install = _import_fresh("crucible_axi.install")
        with mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install._skills_already_installed",
                           return_value=True):
            result = install._skills_stage(self.tmp, False)

        self.assertTrue(result["converged"])
        self.assertFalse(
            mock_run.called,
            "an already-installed skills stage must not re-invoke `npx "
            "skills add`")


class StagedInstallEndToEndMockedTest(unittest.TestCase):
    """§S2 end-to-end (mocked externals) -- `run_install` with NO injected
    `stage_runners` (i.e. `DEFAULT_STAGE_RUNNERS`) must drive the REAL
    `_server_stage`/`_skills_stage` -> `manifest.run_manifest_stage` chain
    and aggregate `ok:True`, complementing C1's injected-stub coverage by
    exercising the DEFAULT runners with subprocess/Bun mocked."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-stages-e2e-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_run_install_default_runners_server_skills_manifest_all_ok_true_with_subprocess_mocked(self):
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
                           return_value=False), \
                mock.patch("crucible_axi.install._skills_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 0
            ok, stages, warnings = install.run_install(self.tmp)

        self.assertTrue(
            ok, f"expected ok:True with every sub-installer mocked to "
                f"success, warnings={warnings}")
        self.assertEqual(
            [s["name"] for s in stages], ["server", "skills", "manifest"])
        for stage in stages:
            self.assertTrue(stage["path"], f"empty path for stage {stage}")
        self.assertEqual(warnings, [])

        # server + skills each drove exactly one real subprocess.run() call
        # via the (unmocked-except-for-subprocess) DEFAULT_STAGE_RUNNERS.
        self.assertGreaterEqual(mock_run.call_count, 2)

        # manifest ran for real (not mocked) -- the file lands on disk.
        manifest_path = os.path.join(self.tmp, "crucible-clients.json")
        self.assertTrue(
            os.path.exists(manifest_path),
            "the real manifest stage must still write crucible-clients.json")


if __name__ == "__main__":
    unittest.main()
