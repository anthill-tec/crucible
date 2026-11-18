"""Every go and uv child the suite spawns uses the suite's own caches.

The suite's toolchain caches live under the git-ignored `<repo>/.cache/
test-suite/`, kept between runs; the operator's caches under `$HOME` are never
read:

  - every `go` child a go harness spawns (directly, or through the go client a
    harness drives) gets `GOCACHE` and `GOMODCACHE` under the suite cache, each
    in its own `go-*` directory, and `GOFLAGS=-modcacherw` (so the module
    cache stays removable);
  - every `uv` child `test_cr046_uv_env_gate` spawns gets `UV_CACHE_DIR` =
    `<repo>/.cache/test-suite/uv`;
  - none inherits the operator's value, which each test plants in the
    environment first, under a temp `HOME`;
  - `.gitignore` ignores `.cache/`.

Every test here is UNIT: the harness functions run in process with
`subprocess.run` and `shutil.which` faked, so no go, no uv, no board and no
socket is touched.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_go_and_uv_children_use_the_suites_own_caches
"""

import importlib
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import ModuleSpec
from pathlib import Path
from unittest import mock

# Imported so the suite's isolation in tests/client/__init__.py applies even when a run
# imports this module top-level (the gate's discovery without -t).
import tests.client  # noqa: F401

REPO_ROOT = Path(__file__).resolve().parents[3]
SUITE_CACHE_ROOT = REPO_ROOT / ".cache" / "test-suite"
SUITE_UV_CACHE = SUITE_CACHE_ROOT / "uv"
FAKE_GO = "/fake/bin/go"
FAKE_UV = "/fake/bin/uv"
WHEEL_MODULES = ("build", "hatchling", "hatch_vcs")
_REAL_FIND_SPEC = importlib.util.find_spec


class _OperatorEnvironment(unittest.TestCase):
    """Plants an operator's caches in `os.environ` under a temp `HOME`."""

    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="operator-home-"))
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.operator = {
            "HOME": str(self.home),
            "GOCACHE": str(self.home / ".cache" / "go-build"),
            "GOMODCACHE": str(self.home / "go" / "pkg" / "mod"),
            "GOFLAGS": "-mod=mod",
            "UV_CACHE_DIR": str(self.home / ".cache" / "uv"),
        }
        patcher = mock.patch.dict(os.environ, self.operator)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.calls = []

    def temp_dir(self, prefix):
        path = Path(tempfile.mkdtemp(prefix=prefix))
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        return path

    def child_env(self, call):
        """The environment a recorded child runs in: its `env`, else ours."""
        env = call["env"]
        return dict(os.environ) if env is None else dict(env)

    def assert_suite_go_caches(self, env, child):
        cache, modcache = env.get("GOCACHE"), env.get("GOMODCACHE")
        for name, value in (("GOCACHE", cache), ("GOMODCACHE", modcache)):
            self.assertIsNotNone(value, f"{child}: {name} is set")
            path = Path(value)
            self.assertEqual(path.parent, SUITE_CACHE_ROOT,
                             f"{child}: {name} lives directly under the suite cache "
                             f"{SUITE_CACHE_ROOT}: {value!r}")
            self.assertTrue(path.name.startswith("go-"),
                            f"{child}: {name} is a `go-*` directory: {value!r}")
            self.assertFalse(path.is_relative_to(self.home),
                             f"{child}: {name} is never under HOME: {value!r}")
            self.assertNotEqual(value, self.operator[name],
                                f"{child}: {name} is not the operator's")
        self.assertNotEqual(cache, modcache, f"{child}: the build and module caches differ")
        self.assertEqual(env.get("GOFLAGS"), "-modcacherw",
                         f"{child}: GOFLAGS keeps the module cache removable")


def _completed(argv, stdout=""):
    return subprocess.CompletedProcess(argv, 0, stdout, "")


class GoHarnessChildrenUseTheSuiteCachesTest(_OperatorEnvironment):

    def fake_run(self, argv, *args, **kwargs):
        argv = [str(a) for a in argv]
        self.calls.append({"argv": argv, "env": kwargs.get("env"), "cwd": kwargs.get("cwd")})
        for arg in argv:
            if arg.startswith("-coverprofile="):
                Path(arg.split("=", 1)[1]).write_text("mode: set\n", encoding="utf-8")
        if argv[1:2] == ["version"]:
            return _completed(argv, "go version go1.24.1 linux/amd64\n")
        return _completed(argv)

    def patched(self):
        return (mock.patch("shutil.which",
                           side_effect=lambda name, *a, **k: FAKE_GO if name == "go" else None),
                mock.patch("subprocess.run", side_effect=self.fake_run))

    def test_the_toolchain_env_points_go_at_the_suite_caches_not_the_operators(self):
        harness = importlib.import_module("tests.client.go_client_harness")
        self.assert_suite_go_caches(harness.toolchain_env(), "toolchain_env()")

    def test_the_go_version_probe_runs_go_on_the_suite_caches(self):
        harness = importlib.import_module("tests.client.go_client_harness")
        which, run = self.patched()
        with which, run:
            gap = harness.go_toolchain_gap()
        self.assertIsNone(gap, "go 1.24.1 on PATH is no gap")
        go_calls = [c for c in self.calls if c["argv"][0] == FAKE_GO]
        self.assertEqual(len(go_calls), 1, f"one `go version` child: {self.calls!r}")
        self.assert_suite_go_caches(self.child_env(go_calls[0]), "`go version`")

    def test_the_go_json_oracle_runs_go_on_the_suite_caches(self):
        harness = importlib.import_module("tests.client.go_client_harness")
        module_dir = self.temp_dir("go-module-")
        which, run = self.patched()
        with which, run:
            harness.run_go_json(str(module_dir), "-run", "TestHello")
        self.assertEqual(len(self.calls), 1, f"one `go test -json` child: {self.calls!r}")
        self.assertEqual(self.calls[0]["argv"][:3], [FAKE_GO, "test", "-json"])
        self.assert_suite_go_caches(self.child_env(self.calls[0]), "`go test -json`")

    def test_the_go_client_a_project_drives_hands_go_the_suite_caches(self):
        harness = importlib.import_module("tests.client.go_client_harness")
        project = object.__new__(harness.GoProject)
        outside = self.temp_dir("go-shim-")
        project.bin_dir = str(outside / "bin")
        project.calls_path = str(outside / "go-calls.jsonl")
        which, _run = self.patched()
        with which:
            env = project.env()
        self.assert_suite_go_caches(env, "GoProject.env()")
        self.assertTrue(env["PATH"].startswith(project.bin_dir + os.pathsep),
                        "the recording shim stays first on PATH")

    def test_the_gates_coverage_oracle_runs_go_on_the_suite_caches(self):
        gate = importlib.import_module("tests.client.go_gate_harness")
        scratch = self.temp_dir("go-gate-scratch-")
        which, run = self.patched()
        with which, run:
            gate.oracle_profiles(str(scratch))
        go_calls = [c for c in self.calls if c["argv"][0] == FAKE_GO]
        self.assertEqual(len(go_calls), 2, f"two oracle `go test` children: {self.calls!r}")
        for call in go_calls:
            self.assert_suite_go_caches(self.child_env(call), " ".join(call["argv"][:3]))


class UvGateChildrenUseTheSuiteCacheTest(_OperatorEnvironment):

    def fake_find_spec(self, name, package=None):
        if name in WHEEL_MODULES:
            return ModuleSpec(name, None)
        return _REAL_FIND_SPEC(name, package)

    def fake_run(self, argv, *args, **kwargs):
        argv = [str(a) for a in argv]
        self.calls.append({"argv": argv, "env": kwargs.get("env"), "cwd": kwargs.get("cwd")})
        if argv[1:3] == ["-m", "build"] and "--outdir" in argv:
            outdir = Path(argv[argv.index("--outdir") + 1])
            outdir.mkdir(parents=True, exist_ok=True)
            (outdir / "crucible_axi-0.4.0-py3-none-any.whl").write_bytes(b"not a real wheel")
        if "-c" in argv:
            return _completed(argv, str(self.temp_dir("installed-crucible-axi-")) + "\n")
        return _completed(argv)

    def test_the_uv_run_environment_points_uv_at_the_suite_cache(self):
        gate = importlib.import_module("tests.client.cr046_uv_env_gate_helpers")
        env = gate._sanitized_env()
        self.assertEqual(env.get("UV_CACHE_DIR"), str(SUITE_UV_CACHE),
                         "`uv run` uses the suite's uv cache, not the operator's "
                         f"{self.operator['UV_CACHE_DIR']}")
        self.assertNotIn("PYTHONPATH", env)
        self.assertNotIn("VIRTUAL_ENV", env)

    def test_every_uv_child_of_the_gates_setup_uses_the_suite_cache(self):
        gate = importlib.import_module("tests.client.integration.test_cr046_uv_env_gate")
        probe = type("_UvGateSetupProbe", (gate.Cr046UvEnvironmentGateTest,), {})
        self.addCleanup(probe.tearDownClass)
        with (mock.patch.object(gate, "UV_BINARY", FAKE_UV),
              mock.patch("importlib.util.find_spec", side_effect=self.fake_find_spec),
              mock.patch("subprocess.run", side_effect=self.fake_run)):
            probe.setUpClass()
        uv_calls = [c for c in self.calls if c["argv"][0] == FAKE_UV]
        self.assertEqual([c["argv"][1] for c in uv_calls], ["venv", "pip"],
                         f"setup runs `uv venv` then `uv pip install`: {self.calls!r}")
        for call in uv_calls:
            env = self.child_env(call)
            self.assertEqual(env.get("UV_CACHE_DIR"), str(SUITE_UV_CACHE),
                             f"`uv {call['argv'][1]}` uses the suite's uv cache, not the "
                             f"operator's: {env.get('UV_CACHE_DIR')!r}")


class TheSuiteCacheIsIgnoredTest(unittest.TestCase):

    def test_gitignore_ignores_the_cache_directory(self):
        rules = [line.strip() for line in
                 (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()]
        self.assertTrue({".cache/", "/.cache/"} & set(rules),
                        f"`.gitignore` ignores `.cache/`; rules are {rules!r}")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
