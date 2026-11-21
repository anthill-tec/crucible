"""The suite's wheels build offline, with the suite's own interpreter.

Three modules build the real `crucible-axi` wheel
(`test_crucible_axi_wheel_packaging`, `test_shipped_limits_ship_as_package_
data`, `test_cr046_uv_env_gate`). Each builds with

    [sys.executable, "-m", "build", "--wheel", "--no-isolation", ...]

so no isolated build environment downloads the build backend: the suite's
own interpreter carries `build`, `hatchling` and `hatch_vcs` through the
`dev` extra. No other interpreter is tried. Before the build, an in-process
probe (`importlib.util.find_spec`) checks the three modules; with one missing
the module FAILS, naming the missing module and the `dev` extra, and builds
nothing. `pyproject.toml`'s `dev` extra lists `hatchling` and `hatch-vcs`,
each with its entry in the comment block above it.

Every test here is UNIT: each module's `setUpClass` runs in process on a
throwaway subclass, with `subprocess.run` and the import probe faked, so no
build, no interpreter and no network is touched. The modules' own real builds
remain the integration proof.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_wheels_build_offline_with_the_suites_own_interpreter
"""

import contextlib
import importlib
import importlib.util
import re
import subprocess
import sys
import tomllib
import unittest
from importlib.machinery import ModuleSpec
from pathlib import Path
from unittest import mock

# Imported so the suite's isolation in tests/client/__init__.py applies even when a run
# imports this module top-level (the gate's discovery without -t).
import tests.client  # noqa: F401

REPO_ROOT = Path(__file__).resolve().parents[3]
PYPROJECT = REPO_ROOT / "pyproject.toml"
WHEEL_MODULES = ("build", "hatchling", "hatch_vcs")
OFFLINE_BUILD = [sys.executable, "-m", "build", "--wheel", "--no-isolation"]
FAKE_UV = "/fake/bin/uv"
_REAL_FIND_SPEC = importlib.util.find_spec

#: (module, the class whose setUpClass builds the wheel)
BUILDERS = (
    ("tests.client.integration.test_crucible_axi_wheel_packaging", "CrucibleAxiWheelPackagingTest"),
    ("tests.client.integration.test_shipped_limits_ship_as_package_data", "_StagedWheelCase"),
    ("tests.client.integration.test_cr046_uv_env_gate", "Cr046UvEnvironmentGateTest"),
)


def _names_the_dev_extra(message):
    return "[dev]" in message or "`dev` extra" in message or "dev extra" in message


class _InProcessBuild(unittest.TestCase):

    def setUp(self):
        self.calls = []

    def fake_run(self, argv, *args, **kwargs):
        argv = [str(a) for a in argv]
        self.calls.append({"argv": argv, "cwd": kwargs.get("cwd")})
        return subprocess.CompletedProcess(argv, 0, "", "")

    def fake_find_spec(self, missing):
        def find_spec(name, package=None):
            if name in missing:
                return None
            if name in WHEEL_MODULES:
                return ModuleSpec(name, None)
            return _REAL_FIND_SPEC(name, package)
        return find_spec

    def set_up_class(self, module_name, class_name, missing=()):
        """Run the builder's `setUpClass` on a throwaway subclass with the
        probe and every spawn faked. Answers the exception it raised, or
        None."""
        module = importlib.import_module(module_name)
        probe = type(f"_{class_name}SetupProbe", (getattr(module, class_name),), {})
        self.addCleanup(probe.tearDownClass)
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch("importlib.util.find_spec",
                                           side_effect=self.fake_find_spec(set(missing))))
            stack.enter_context(mock.patch("subprocess.run", side_effect=self.fake_run))
            if hasattr(module, "UV_BINARY"):
                stack.enter_context(mock.patch.object(module, "UV_BINARY", FAKE_UV))
            try:
                probe.setUpClass()
            except Exception as raised:  # the builder's own failure is the result
                return raised
        return None

    def build_calls(self):
        return [c for c in self.calls if c["argv"][1:3] == ["-m", "build"]]


class EachWheelBuildsOfflineWithTheSuitesInterpreterTest(_InProcessBuild):

    def test_each_module_builds_with_sys_executable_and_no_isolation(self):
        for module_name, class_name in BUILDERS:
            with self.subTest(module=module_name):
                self.calls = []
                raised = self.set_up_class(module_name, class_name)
                self.assertIsNone(raised, f"setup proceeds with all three present: {raised!r}")
                builds = self.build_calls()
                self.assertEqual(len(builds), 1, f"one wheel build: {self.calls!r}")
                self.assertEqual(builds[0]["argv"][:5], OFFLINE_BUILD,
                                 "the build runs offline on the suite's own interpreter")
                self.assertIn("--outdir", builds[0]["argv"])
                self.assertEqual(str(builds[0]["cwd"]), str(REPO_ROOT),
                                 "the checkout is what is built")

    def test_no_module_probes_another_interpreter(self):
        for module_name, class_name in BUILDERS:
            with self.subTest(module=module_name):
                self.calls = []
                self.set_up_class(module_name, class_name)
                probes = [c["argv"] for c in self.calls
                          if "-c" in c["argv"] and any("import build" in a for a in c["argv"])]
                self.assertEqual(probes, [], "no interpreter is spawned to probe for `build`")
                interpreters = {c["argv"][0] for c in self.build_calls()}
                self.assertEqual(interpreters, {sys.executable},
                                 "the wheel is built only by the suite's interpreter")


class AMissingBuildModuleFailsNamingTheDevExtraTest(_InProcessBuild):

    def test_each_module_fails_naming_the_missing_module_and_the_dev_extra(self):
        for module_name, class_name in BUILDERS:
            for missing in WHEEL_MODULES:
                with self.subTest(module=module_name, missing=missing):
                    self.calls = []
                    raised = self.set_up_class(module_name, class_name, missing=(missing,))
                    self.assertIsNotNone(raised, f"setup fails with `{missing}` missing")
                    message = str(raised)
                    self.assertIn(missing, message,
                                  f"the failure names the missing module: {message!r}")
                    self.assertTrue(_names_the_dev_extra(message),
                                    f"the failure names the `dev` extra: {message!r}")
                    self.assertEqual(self.build_calls(), [],
                                     "nothing is built when a build module is missing")


class TheDevExtraCarriesTheBuildBackendTest(unittest.TestCase):

    def dev(self):
        with open(PYPROJECT, "rb") as handle:
            return tomllib.load(handle)["project"]["optional-dependencies"]["dev"]

    def comment_block(self):
        text = PYPROJECT.read_text(encoding="utf-8")
        start = text.index("[project.optional-dependencies]")
        end = text.index("\ndev = [", start)
        return text[start:end].splitlines()

    def test_the_dev_extra_lists_hatchling_and_hatch_vcs_once_each(self):
        names = [re.split(r"[<>=!~;\[ ]", entry, maxsplit=1)[0].strip().lower()
                 for entry in self.dev()]
        for package in ("hatchling", "hatch-vcs"):
            self.assertEqual(names.count(package), 1,
                             f"exactly one `{package}` in the dev extra: {self.dev()!r}")

    def test_each_backend_package_has_its_comment_block_entry(self):
        block = self.comment_block()
        for package in ("hatchling", "hatch-vcs"):
            entries = [line for line in block
                       if re.match(rf"^#\s+{re.escape(package)}\s+—", line)]
            self.assertEqual(len(entries), 1,
                             f"the dev comment block explains `{package}` once: {block!r}")


if __name__ == "__main__":
    unittest.main()
