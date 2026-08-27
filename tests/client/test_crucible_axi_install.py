"""CR-CRU-009 C1 -- the `crucible-axi` package + install-orchestrator
framework + discovery manifest.

Contract pinned from docs/changes/CR-CRU-009-release-0.1.0.md:

    Sec S1  -- a NEW `crucible-axi` PyPI package is the primary orchestrator;
               it ships the existing `clients/*.py` fleet as package data.
    Sec S2  -- `crucible-axi install` runs STAGED, idempotent sub-installers
               ([server], [skills], [manifest]) and reports a single
               TOON-AXI envelope (ok + each stage's `~`-abbreviated path).
    AC       -- "Staged idempotency: re-running `crucible-axi install`
               converges (no duplicate installs) and returns a TOON-AXI
               envelope with `ok` + each stage's installed path."
    AC       -- "Discovery manifest: `crucible-clients.json` exists with a
               stable schema mapping each stack to its installed client path
               (the Model-B pre-flight contract)."
    Implementation notes -- this cycle BUILDS the orchestrator framework
               (stage sequencing, idempotency, TOON-AXI stage envelopes) +
               the manifest, with `uv`/`npx`/`skills`/Bun and the network
               MOCKED/injected. The real sub-installer calls are C2.

RED phase: NEITHER `pyproject.toml` NOR the `crucible_axi/` package exist yet
(confirmed: `ls` at repo root). Every test below either fails a plain file
assertion (pyproject.toml missing) or raises ModuleNotFoundError importing
`crucible_axi.*` -- a missing-SUT-symbol/collection error, valid RED per the
sub-agent procedure (never skipped).

This RED slice pins the exact package layout + API GREEN must build:

    pyproject.toml (repo root)
        [build-system]
        requires = ["hatchling", "hatch-vcs"]   # (Sandesh house model:
        build-backend = "hatchling.build"        # ~/Documents/data_projects/
                                                  # sandesh/pyproject.toml)
        [project]
        name = "crucible-axi"
        dynamic = ["version"]                  # HATCH-VCS dynamic version
                                                # from git tags -- NO
                                                # hardcoded version = "..."
                                                # anywhere in [project]; 0.1.0
                                                # is a git TAG cut on the
                                                # release branch (S6), never a
                                                # literal in this file.
        [project.scripts]
        crucible-axi = "crucible_axi.cli:main"
        [tool.hatch.version]
        source = "vcs"
        raw-options = { local_scheme = "no-local-version" }  # Test PyPI-safe
                                                              # (no PEP 440
                                                              # +local segment)
        # package-data / include references BOTH "clients" (the fleet) and
        # "STATUS-CONTRACT.md".

    crucible_axi/cli.py
        main(argv=None) -> int                 # console-script entry point

    crucible_axi/install.py
        STAGE_ORDER = ("server", "fleet", "manifest")
        DEFAULT_STAGE_RUNNERS: dict[str, callable]   # module-level, mutable
                                                      # in place (tests patch
                                                      # it via mock.patch.dict)
        run_install(target_dir, stage_runners=None, force=False)
            -> (ok: bool, stages: list[dict], warnings: list[dict])
            Each stage dict: {"name": <stage>, "path": <~-abbreviated str>,
                              "converged": <bool>}.
            Stages run in STAGE_ORDER, each via
            stage_runners[name](target_dir, force) -> dict with at least a
            "path" key (installed path) and an optional "converged" bool.

    crucible_axi/manifest.py
        build_manifest(install_dir) -> dict
            {"version": <str>, "clients": {<stack>: <path>, ...},
             "status": <path ending in "STATUS-CONTRACT.md">}
            "clients" covers exactly {"bun","python","rust","mvn","arduino"}.
        write_manifest(target_dir, manifest_dict) -> str
            Writes "crucible-clients.json" (single JSON document, overwriting
            -- never appending) into target_dir; returns the written path.

Invocation:
    python3 -m pytest tests/client/test_crucible_axi_install.py -q
Fallback:
    python3 tests/client/test_crucible_axi_install.py
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
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"
STATUS_CONTRACT_PATH = REPO_ROOT / "clients" / "STATUS-CONTRACT.md"

EXPECTED_CLIENT_STACKS = {"bun", "python", "rust", "mvn", "arduino"}


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(module_name):
    """Import (or re-import) a `crucible_axi` module from the repo-root
    checkout, purging any stale cache entry first so each test gets an
    independent import attempt. Deliberately does NOT catch/skip -- during
    RED this raises ModuleNotFoundError (the package does not exist yet),
    which is the expected failure (same convention as the sibling
    `_load_axi_module()`/`_load_toon_module()` helpers in
    test_crucible_axi_shared.py, which load-by-path and let a missing-module
    error propagate as RED)."""
    _ensure_repo_root_on_path()
    for mod in list(sys.modules):
        if mod == module_name or mod.startswith(module_name + "."):
            del sys.modules[mod]
    return importlib.import_module(module_name)


def _load_toon_module():
    spec = importlib.util.spec_from_file_location(
        "toon_under_test_for_crucible_axi_install", TOON_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PyprojectPackageEntryPointTest(unittest.TestCase):
    """S1 -- a `pyproject.toml` declares the `crucible-axi` PyPI package, its
    console-script entry point, and ships the client fleet + STATUS-CONTRACT
    as package data. Version is a dev placeholder, NOT the 0.1.0 release
    version (S6 sets that on the release branch)."""

    def test_pyproject_toml_exists_at_repo_root(self):
        self.assertTrue(
            PYPROJECT_PATH.is_file(),
            f"expected a pyproject.toml at {PYPROJECT_PATH}")

    def test_pyproject_declares_the_crucible_axi_package_name(self):
        text = PYPROJECT_PATH.read_text()
        self.assertRegex(
            text, r'(?m)^name\s*=\s*"crucible-axi"\s*$',
            "expected name = \"crucible-axi\" under [project]")

    def test_pyproject_uses_hatch_vcs_dynamic_versioning_no_hardcoded_version(self):
        """House release model (Sandesh, ~/Documents/data_projects/sandesh/
        pyproject.toml): version comes from git tags via hatch-vcs, NEVER a
        hardcoded literal -- so 0.1.0 (S6) is a git tag cut on the release
        branch, not a string anyone edits in this file."""
        text = PYPROJECT_PATH.read_text()

        self.assertRegex(
            text, r'(?m)^\[build-system\]',
            "expected a [build-system] table")
        requires_match = re.search(
            r'(?ms)^\[build-system\].*?^requires\s*=\s*\[([^\]]*)\]', text)
        self.assertIsNotNone(
            requires_match, 'expected requires = [...] under [build-system]')
        requires_text = requires_match.group(1)
        self.assertIn("hatchling", requires_text)
        self.assertIn("hatch-vcs", requires_text)
        self.assertRegex(
            text, r'(?m)^build-backend\s*=\s*"hatchling\.build"\s*$',
            'expected build-backend = "hatchling.build"')

        self.assertRegex(
            text, r'(?m)^dynamic\s*=\s*\[\s*"version"\s*\]\s*$',
            'expected dynamic = ["version"] under [project]')
        self.assertNotRegex(
            text, r'(?m)^version\s*=\s*"[^"]+"\s*$',
            "no hardcoded version = \"...\" literal may appear anywhere -- "
            "hatch-vcs derives it from git tags")

        self.assertRegex(
            text, r'(?m)^\[tool\.hatch\.version\]',
            "expected a [tool.hatch.version] table")
        version_table_match = re.search(
            r'(?ms)^\[tool\.hatch\.version\](.*?)(?:^\[|\Z)', text)
        self.assertIsNotNone(version_table_match)
        version_table_text = version_table_match.group(1)
        self.assertRegex(
            version_table_text, r'(?m)^source\s*=\s*"vcs"\s*$',
            'expected source = "vcs" under [tool.hatch.version]')
        self.assertIn("local_scheme", version_table_text)
        self.assertIn("no-local-version", version_table_text)

    def test_pyproject_declares_console_script_entry_point(self):
        text = PYPROJECT_PATH.read_text()
        self.assertIn("[project.scripts]", text)
        self.assertRegex(
            text, r'(?m)^crucible-axi\s*=\s*"crucible_axi\.cli:main"\s*$',
            'expected crucible-axi = "crucible_axi.cli:main"')

    def test_pyproject_declares_client_fleet_as_package_data(self):
        """The clients/ fleet must be declared as package data. This checks the
        DECLARATION only -- deliberately NOT that STATUS-CONTRACT.md is named
        here. A separate force-include entry for it duplicated the archive path
        already covered by the clients/ tree and made `python -m build` fail with
        a duplicate-archive-path ValueError. What actually matters -- that
        crucible_axi/clients/STATUS-CONTRACT.md is PRESENT IN THE BUILT WHEEL --
        is asserted by tests/client/test_crucible_axi_wheel_packaging.py, which
        is strictly stronger than a substring match on this config file. Do not
        "restore" a STATUS-CONTRACT.md assertion here; it would re-encode the
        build break."""
        text = PYPROJECT_PATH.read_text()
        self.assertIn(
            "clients", text,
            "expected the pyproject.toml packaging config to reference the "
            "clients/ fleet as package data")

    def test_console_script_entry_point_target_resolves_to_a_real_callable(self):
        """Cross-check: the dotted target the entry point NAMES
        ("crucible_axi.cli:main") must be a real, importable, callable --
        not just a string in a config file. This fails against a pyproject
        with the right text but no actual crucible_axi/cli.py module."""
        text = PYPROJECT_PATH.read_text()
        m = re.search(r'(?m)^crucible-axi\s*=\s*"([^"]+)"\s*$', text)
        self.assertIsNotNone(m, "expected the crucible-axi script mapping")
        module_path, _, attr = m.group(1).partition(":")
        mod = _import_fresh(module_path)
        self.assertTrue(
            hasattr(mod, attr),
            f"expected {module_path} to define {attr!r}")
        self.assertTrue(
            callable(getattr(mod, attr)),
            f"expected {module_path}.{attr} to be callable")


class InstallOrchestratorFrameworkTest(unittest.TestCase):
    """S2 -- `run_install` sequences [server] -> [fleet] -> [manifest] via
    INJECTABLE stage callables (no real subprocess), aggregating results into
    one TOON-AXI envelope with ok + each stage's `~`-abbreviated path."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-install-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_run_install_executes_server_fleet_manifest_stages_in_order(self):
        install = _import_fresh("crucible_axi.install")
        call_order = []

        def make_fake(name):
            def _runner(target_dir, force):
                call_order.append(name)
                return {"path": os.path.join(target_dir, name), "converged": False}
            return _runner

        fakes = {name: make_fake(name)
                 for name in ("server", "fleet", "manifest")}
        ok, stages, warnings = install.run_install(self.tmp, stage_runners=fakes)

        self.assertEqual(
            call_order, ["server", "fleet", "manifest"],
            "stages must run in the exact S2 sequence")
        self.assertTrue(ok)
        self.assertEqual(
            [s["name"] for s in stages], ["server", "fleet", "manifest"])

    def test_run_install_stops_calling_further_stages_once_a_stage_raises(self):
        """Negative/bound path: a stage failure must NOT silently continue to
        later stages -- would fail if GREEN swallowed stage exceptions and
        kept going regardless."""
        install = _import_fresh("crucible_axi.install")
        call_order = []

        def failing_server(target_dir, force):
            call_order.append("server")
            raise RuntimeError("server stage boom")

        def fleet_runner(target_dir, force):
            call_order.append("fleet")
            return {"path": os.path.join(target_dir, "clients"),
                     "converged": False}

        def manifest_runner(target_dir, force):
            call_order.append("manifest")
            return {"path": os.path.join(target_dir, "crucible-clients.json"),
                     "converged": False}

        fakes = {"server": failing_server, "fleet": fleet_runner,
                 "manifest": manifest_runner}
        ok, stages, warnings = install.run_install(self.tmp, stage_runners=fakes)

        self.assertEqual(
            call_order, ["server"],
            "a failing [server] stage must not be followed by [fleet] or "
            "[manifest]")
        self.assertFalse(ok, "a stage failure must surface as ok:false")

    def test_run_install_stage_results_carry_tilde_abbreviated_installed_path(self):
        install = _import_fresh("crucible_axi.install")
        home = os.path.expanduser("~")
        fake_server_path = os.path.join(home, ".crucible", "server")
        fakes = {
            "server": lambda target_dir, force: {
                "path": fake_server_path, "converged": False},
            "fleet": lambda target_dir, force: {
                "path": os.path.join(target_dir, "clients"),
                "converged": False},
            "manifest": lambda target_dir, force: {
                "path": os.path.join(target_dir, "crucible-clients.json"),
                "converged": False},
        }
        ok, stages, warnings = install.run_install(self.tmp, stage_runners=fakes)
        server_stage = next(s for s in stages if s["name"] == "server")
        self.assertEqual(
            server_stage["path"], "~/.crucible/server",
            "a path under $HOME must be ~-abbreviated in the stage result")
        self.assertFalse(server_stage["path"].startswith(home))

    def test_run_install_terminates_because_server_stage_provisions_not_runs(self):
        """CR-CRU-066 §S5 -- highest-value guard. With the REAL default
        `_server_stage`, `run_install` must TERMINATE: it PROVISIONS the
        server (`bun add -g`) and returns `(ok, stages, warnings)`, never
        invoking the blocking `npx -y <server>` server-RUN that hung 0.1.1's
        install.

        Modelled as data (never a real port/subprocess): `subprocess.run` is
        stubbed to RAISE if asked to run the server via `npx`, so the retired
        behaviour surfaces here as ok:false (and would hang for real), while
        the provision path returns ok:true with both stages present."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")

        def _fail_if_npx_server_run(*args, **kwargs):
            command = args[0] if args else kwargs.get("args", "")
            text = " ".join(str(a) for a in command) if isinstance(
                command, (list, tuple)) else str(command)
            if "npx" in text:
                raise AssertionError(
                    "install invoked `npx` to RUN the server -- this blocks "
                    "forever (CR-CRU-066); the [server] stage must PROVISION "
                    "via `bun add -g` and exit")
            completed = mock.Mock()
            completed.returncode = 0
            return completed

        with mock.patch.object(axi, "__version__", "0.1.0"), \
                mock.patch("crucible_axi.install.subprocess.run",
                           side_effect=_fail_if_npx_server_run) as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            result = install.run_install(self.tmp)

        self.assertEqual(
            len(result), 3,
            "run_install must return the (ok, stages, warnings) triple")
        ok, stages, warnings = result
        self.assertTrue(
            ok,
            f"run_install must TERMINATE with ok:true via a PROVISIONING "
            f"server stage -- a `npx -y <server>` run would hang/fail here; "
            f"warnings={warnings}")
        self.assertEqual(
            [s["name"] for s in stages], ["server", "fleet", "manifest"],
            "all three stages must complete once the server stage "
            "provisions+exits")
        # argv[0] is matched by BASENAME: CR-CRU-066 §S2 provisions with the
        # RESOLVED ABSOLUTE bun path, never the bare `bun` token.
        provisioned = [
            c for c in mock_run.call_args_list
            if (c.args and isinstance(c.args[0], (list, tuple))
                and len(c.args[0]) >= 3
                and os.path.basename(str(list(c.args[0])[0])) == "bun"
                and list(c.args[0])[1:3] == ["add", "-g"])]
        self.assertTrue(
            provisioned,
            "the [server] stage must PROVISION via `bun add -g`, never run the "
            "server")

    def test_cli_install_emits_exactly_one_toon_axi_envelope_ok_true_exit_zero(self):
        """End-to-end (mocked externals): argv `install` drives the real
        cli.main -> cmd_install -> install.run_install wiring, using
        `install.DEFAULT_STAGE_RUNNERS` patched to injected fakes (no real
        npx/uv/skills/subprocess). Asserts the REAL observable outcome: one
        decodable TOON-AXI envelope on stdout, not merely a clean exit."""
        install = _import_fresh("crucible_axi.install")
        cli = _import_fresh("crucible_axi.cli")
        toon = _load_toon_module()

        def make_fake(name):
            def _runner(target_dir, force):
                return {"path": os.path.join(target_dir, name), "converged": False}
            return _runner

        fakes = {name: make_fake(name) for name in install.STAGE_ORDER}
        buf = io.StringIO()
        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS, fakes):
            with contextlib.redirect_stdout(buf):
                exit_code = cli.main(["install", "--target-dir", self.tmp])

        stdout_text = buf.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            stdout_text.count("axi:"), 1,
            "expected exactly ONE TOON-AXI envelope on stdout")
        decoded = toon.decode(stdout_text)
        axi = decoded["axi"]
        self.assertEqual(axi["verb"], "install")
        self.assertIs(axi["ok"], True)
        stage_names = [s["name"] for s in axi["stages"]]
        self.assertEqual(stage_names, ["server", "fleet", "manifest"])
        for stage in axi["stages"]:
            self.assertIn("path", stage)
            self.assertTrue(stage["path"])
        self.assertIn("warnings", axi)
        self.assertIn("help", axi)


class DiscoveryManifestTest(unittest.TestCase):
    """S2/Coordination -- `crucible-clients.json`: a stable schema mapping
    each of the 5 stacks to its installed client path, plus the
    STATUS-CONTRACT reference (the Model-B pre-flight contract)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-manifest-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_build_manifest_maps_all_five_client_stacks_to_installed_paths(self):
        manifest_mod = _import_fresh("crucible_axi.manifest")
        manifest = manifest_mod.build_manifest(self.tmp)
        self.assertEqual(set(manifest["clients"].keys()), EXPECTED_CLIENT_STACKS)
        for stack, path in manifest["clients"].items():
            self.assertTrue(
                str(path).startswith(self.tmp),
                f"{stack} client path {path!r} expected under install dir {self.tmp}")
            self.assertTrue(
                str(path).endswith(f"{stack}-crucible.py") if stack != "python"
                else str(path).endswith("python-crucible.py"),
                f"{stack} path {path!r} does not look like the {stack} client")

    def test_build_manifest_omits_stacks_outside_the_five_client_fleet(self):
        """Negative/bound path -- exactly 5 keys, no extra/unknown stack
        sneaks in (would fail if a runaway implementation added e.g. a
        6th/'vscode' entry, since vscode is clientless per the CR context)."""
        manifest_mod = _import_fresh("crucible_axi.manifest")
        manifest = manifest_mod.build_manifest(self.tmp)
        self.assertEqual(len(manifest["clients"]), 5)

    def test_build_manifest_carries_a_version_key_and_status_contract_reference(self):
        manifest_mod = _import_fresh("crucible_axi.manifest")
        manifest = manifest_mod.build_manifest(self.tmp)
        self.assertIn("version", manifest)
        self.assertIsInstance(manifest["version"], str)
        self.assertTrue(manifest["version"])
        self.assertIn("status", manifest)
        self.assertIn("STATUS-CONTRACT.md", manifest["status"])

    def test_write_manifest_persists_valid_json_with_the_stable_schema(self):
        manifest_mod = _import_fresh("crucible_axi.manifest")
        manifest = manifest_mod.build_manifest(self.tmp)
        written_path = manifest_mod.write_manifest(self.tmp, manifest)

        self.assertEqual(os.path.basename(written_path), "crucible-clients.json")
        with open(written_path) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk, manifest)
        self.assertEqual(set(on_disk.keys()), {"version", "clients", "status"})


class InstallIdempotencyTest(unittest.TestCase):
    """AC -- re-running `crucible-axi install` converges: the manifest is
    REWRITTEN (not duplicated) and stages report already-installed/converged,
    `ok:true` both times."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-idempotent-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _patched_server_fakes(self):
        """[server] and [fleet] stay mocked (no real npx/uv/subprocess, no
        real fleet copy); the REAL default [manifest] stage runs both times so
        idempotency of the actual manifest-writing code path is exercised, not
        a fake's own bookkeeping."""
        calls = {"server": 0, "fleet": 0}

        def make(name):
            def _runner(target_dir, force):
                calls[name] += 1
                return {"path": os.path.join(target_dir, name),
                        "converged": calls[name] > 1}
            return _runner

        return {"server": make("server"), "fleet": make("fleet")}

    def test_running_install_twice_does_not_duplicate_the_manifest_file(self):
        install = _import_fresh("crucible_axi.install")
        fakes = self._patched_server_fakes()
        manifest_path = os.path.join(self.tmp, "crucible-clients.json")

        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS, fakes):
            ok1, _stages1, _w1 = install.run_install(self.tmp)
            with open(manifest_path) as f:
                first_content = f.read()

            ok2, _stages2, _w2 = install.run_install(self.tmp)
            with open(manifest_path) as f:
                second_content = f.read()

        self.assertTrue(ok1)
        self.assertTrue(ok2)
        self.assertEqual(
            first_content, second_content,
            "a second install run must rewrite the SAME manifest, not append")
        # A naive append-instead-of-overwrite bug produces two concatenated
        # JSON documents, which json.loads rejects -- this must stay a single
        # parseable document.
        reparsed = json.loads(second_content)
        self.assertEqual(set(reparsed.keys()), {"version", "clients", "status"})

    def test_running_install_twice_reports_manifest_stage_converged_on_second_run(self):
        install = _import_fresh("crucible_axi.install")
        fakes = self._patched_server_fakes()

        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS, fakes):
            ok1, stages1, _w1 = install.run_install(self.tmp)
            manifest_result_1 = next(s for s in stages1 if s["name"] == "manifest")

            ok2, stages2, _w2 = install.run_install(self.tmp)
            manifest_result_2 = next(s for s in stages2 if s["name"] == "manifest")

        self.assertTrue(ok1)
        self.assertTrue(ok2)
        self.assertFalse(
            manifest_result_1["converged"],
            "first run writes a fresh manifest -- not yet converged")
        self.assertTrue(
            manifest_result_2["converged"],
            "second run finds an identical manifest already on disk -- converged")

    def test_running_install_twice_both_runs_are_ok_true_for_every_stage(self):
        install = _import_fresh("crucible_axi.install")
        fakes = self._patched_server_fakes()

        with mock.patch.dict(install.DEFAULT_STAGE_RUNNERS, fakes):
            ok1, stages1, _w1 = install.run_install(self.tmp)
            ok2, stages2, _w2 = install.run_install(self.tmp)

        self.assertTrue(ok1)
        self.assertTrue(ok2)
        self.assertEqual(len(stages1), 3)
        self.assertEqual(len(stages2), 3)


if __name__ == "__main__":
    unittest.main()
