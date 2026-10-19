"""Every client resolves its project dir to an ABSOLUTE path the moment it is
resolved, and binds that absolute path into the shared module.

Each of the five clients (arduino, bun, mvn, python, rust) is loaded fresh by
path and its own project-dir resolution is called -- `_resolve_project_dir`
for bun, mvn, python and rust, `_project_dir(args)` for arduino -- from the
project's PARENT directory with a RELATIVE value, given once as the
`--project-dir` flag and once as the client's own environment variable.

What is asserted, per client and per source:
- the returned dir is `os.path.abspath` of the relative value, taken in the
  directory the client was started from;
- the shared module holds that same absolute dir as its bound project dir,
  and the project `crucible.toml` it consults first sits beside it;
- once the process has moved to another directory, the resolved dir and the
  bound dir still name the project (its `.env` is still found there) -- a
  relative dir would now point at nothing.

Arduino already makes its dir absolute, so its cases hold today and pin it.
"""

import argparse
import importlib.util
import itertools
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

#: Each client's file and the environment variable its resolution reads.
CLIENT_PROJECT_DIR_ENV = {
    "arduino": ("arduino-crucible.py", "ARDUINO_CRUCIBLE_PROJECT_DIR"),
    "bun": ("bun-crucible.py", "BUN_CRUCIBLE_PROJECT_DIR"),
    "mvn": ("mvn-crucible.py", "MVN_CRUCIBLE_PROJECT_DIR"),
    "python": ("python-crucible.py", "PY_CRUCIBLE_PROJECT_DIR"),
    "rust": ("rust-crucible.py", "RUST_CRUCIBLE_PROJECT_DIR"),
}

PROJECT_NAME = "relative-project"
PROJECT_KEY = "relative-project-dir-key"

_COUNTER = itertools.count()


def _load_client(client_key):
    """A FRESH module object per call, so one case's bound dir never leaks
    into the next."""
    filename, _ = CLIENT_PROJECT_DIR_ENV[client_key]
    spec = importlib.util.spec_from_file_location(
        f"relative_project_dir_{client_key}_{next(_COUNTER)}",
        CLIENTS_DIR / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _resolve(module, client_key, flag_value):
    """Call the client's OWN project-dir resolution with `flag_value` as the
    `--project-dir` flag (None: the flag is absent)."""
    if client_key == "arduino":
        return module._project_dir(argparse.Namespace(project_dir=flag_value))
    return module._resolve_project_dir(flag_value)


class RelativeProjectDirResolvesAbsoluteTest(unittest.TestCase):

    def setUp(self):
        self.assertEqual(
            len(CLIENT_PROJECT_DIR_ENV), 5,
            "the fleet has five clients; a client dropped from this table "
            "would silently drop out of every case below")
        self.addCleanup(os.chdir, os.getcwd())
        self.parent = tempfile.mkdtemp(prefix="relative-project-dir-parent-")
        self.addCleanup(shutil.rmtree, self.parent, ignore_errors=True)
        self.elsewhere = tempfile.mkdtemp(prefix="relative-project-dir-elsewhere-")
        self.addCleanup(shutil.rmtree, self.elsewhere, ignore_errors=True)
        project = Path(self.parent, PROJECT_NAME)
        project.mkdir()
        (project / ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n"
            f"CRUCIBLE_PROJECT_NAME={PROJECT_NAME}\n")
        env_patch = mock.patch.dict(os.environ)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        for _, env_var in CLIENT_PROJECT_DIR_ENV.values():
            os.environ.pop(env_var, None)
        os.chdir(self.parent)
        # The spec's own definition, taken where the client was started.
        self.expected = os.path.abspath(PROJECT_NAME)

    def _assert_resolved_absolute_and_bound(self, client_key, source):
        module = _load_client(client_key)
        _, env_var = CLIENT_PROJECT_DIR_ENV[client_key]
        if source == "flag":
            resolved = _resolve(module, client_key, PROJECT_NAME)
            label = f"{client_key} (--project-dir {PROJECT_NAME})"
        else:
            os.environ[env_var] = PROJECT_NAME
            resolved = _resolve(module, client_key, None)
            label = f"{client_key} ({env_var}={PROJECT_NAME})"

        self.assertTrue(
            os.path.isabs(resolved),
            f"{label}: a relative project dir must resolve to an absolute "
            f"path; got {resolved!r}")
        self.assertEqual(
            resolved, self.expected,
            f"{label}: the resolved dir must be os.path.abspath of the "
            f"relative value; got {resolved!r}")

        axi = module._axi()
        self.assertEqual(
            axi._PROJECT_DIR, self.expected,
            f"{label}: the shared module must be bound to the absolute dir; "
            f"it holds {axi._PROJECT_DIR!r}")
        candidates = axi._project_config_candidates()
        self.assertEqual(
            candidates[0], os.path.join(self.expected, "crucible.toml"),
            f"{label}: the project crucible.toml the shared module consults "
            f"first must sit in the absolute dir; got {candidates!r}")

        os.chdir(self.elsewhere)
        self.assertTrue(
            os.path.isfile(os.path.join(resolved, ".env")),
            f"{label}: after the process moves to another directory the "
            f"resolved dir must still name the project; {resolved!r} holds "
            f"no .env from {os.getcwd()!r}")
        self.assertTrue(
            os.path.isfile(os.path.join(axi._PROJECT_DIR, ".env")),
            f"{label}: after the process moves to another directory the "
            f"bound dir must still name the project; {axi._PROJECT_DIR!r} "
            f"holds no .env from {os.getcwd()!r}")

    # -- arduino (already absolute: these pin it) ---------------------------

    def test_arduino_relative_flag_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("arduino", "flag")

    def test_arduino_relative_env_value_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("arduino", "env")

    # -- bun ----------------------------------------------------------------

    def test_bun_relative_flag_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("bun", "flag")

    def test_bun_relative_env_value_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("bun", "env")

    # -- mvn ----------------------------------------------------------------

    def test_mvn_relative_flag_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("mvn", "flag")

    def test_mvn_relative_env_value_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("mvn", "env")

    # -- python -------------------------------------------------------------

    def test_python_relative_flag_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("python", "flag")

    def test_python_relative_env_value_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("python", "env")

    # -- rust ---------------------------------------------------------------

    def test_rust_relative_flag_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("rust", "flag")

    def test_rust_relative_env_value_resolves_to_its_absolute_path_and_binds_it(self):
        self._assert_resolved_absolute_and_bound("rust", "env")


if __name__ == "__main__":
    unittest.main()
