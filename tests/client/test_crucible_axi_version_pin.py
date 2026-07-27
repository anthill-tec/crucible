"""CR-CRU-041 C1 -- composite release strategy: one repo, two artifacts, ONE
version (S6) + the S1 SERVER_NPM_PACKAGE / package.json cross-stack check.

Contract pinned from docs/changes/CR-CRU-041-release-mechanism.md:

    S6 -- `crucible_axi.__version__` resolves via
          `importlib.metadata.version("crucible-axi")` (never a hardcoded
          literal). The `[server]` stage's npx argv is VERSION-PINNED:
          `<SERVER_NPM_PACKAGE>@<crucible_axi.__version__>`, never a bare
          package name and never "latest". `CRUCIBLE_SERVER_VERSION`
          overrides the pin when set; unset means the pinned own-version,
          never "latest".
    S1 (cross-stack check, AC) -- `crucible_axi.install.SERVER_NPM_PACKAGE`
          equals the `name` field in the repo's package.json, so the two
          artifacts cannot silently drift apart again.

RED phase: `crucible_axi/__init__.py` has NO `__version__` attribute yet;
`crucible_axi/install.py`'s `SERVER_NPM_PACKAGE = "crucible-server"` (a
TODO(S4) placeholder) does not match `package.json`'s current `name` field
("crucible"), and the `[server]` stage's npx argv carries the bare
`SERVER_NPM_PACKAGE` with no version suffix at all -- always resolving to
`latest`. Every test below either fails a plain assertion or raises
AttributeError accessing the not-yet-existing `crucible_axi.__version__` --
a missing-SUT-symbol error, valid RED per the sub-agent procedure (never
skipped).

Invocation:
    python3 -m pytest tests/client/test_crucible_axi_version_pin.py -q
Fallback:
    python3 tests/client/test_crucible_axi_version_pin.py
"""

import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_JSON_PATH = REPO_ROOT / "package.json"


def _ensure_repo_root_on_path():
    root_str = str(REPO_ROOT)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def _import_fresh(module_name):
    """Import (or re-import) a `crucible_axi` module from the repo-root
    checkout, purging any stale cache entry first so each test gets an
    independent import attempt (same convention as
    test_crucible_axi_install.py / test_crucible_axi_stages.py's
    `_import_fresh`)."""
    _ensure_repo_root_on_path()
    for mod in list(sys.modules):
        if mod == module_name or mod.startswith(module_name + "."):
            del sys.modules[mod]
    return importlib.import_module(module_name)


def _call_command_text(call):
    """Flatten a `mock.call` to `subprocess.run(...)` into one searchable
    string, regardless of whether GREEN passes a list argv or a shell=True
    string command (same convention as test_crucible_axi_stages.py)."""
    args = call.args[0] if call.args else call.kwargs.get("args", "")
    if isinstance(args, (list, tuple)):
        return " ".join(str(a) for a in args)
    return str(args)


def _server_npx_argv(mock_run):
    """Return the raw argv LIST of the npx server-stage subprocess.run call
    (not flattened to text), or None if no npx call was recorded / it wasn't
    a list-form call. Gives a stronger token-level assertion than a
    substring check on flattened text (catches a bare package-name token
    sitting ALONGSIDE a correctly pinned one, which a substring check on
    joined text would miss)."""
    for call in mock_run.call_args_list:
        args = call.args[0] if call.args else call.kwargs.get("args")
        if isinstance(args, (list, tuple)) and any("npx" in str(a) for a in args):
            return list(args)
    return None


class CrucibleAxiVersionResolvesViaImportlibMetadataTest(unittest.TestCase):
    """S6 -- `crucible_axi.__version__` is DERIVED via
    `importlib.metadata.version("crucible-axi")`, never a hardcoded literal
    string in the package."""

    def test_version_attribute_exists_on_the_package(self):
        axi = _import_fresh("crucible_axi")
        self.assertTrue(
            hasattr(axi, "__version__"),
            "expected crucible_axi.__version__ to exist")

    def test_version_reflects_whatever_importlib_metadata_reports_not_a_hardcoded_literal(self):
        """Behavioural, not structural: mocks the metadata lookup to a
        sentinel value that is not any real project version, then asserts
        `__version__` reflects it -- would FAIL against a GREEN that just
        hardcodes `__version__ = "0.1.0"` (or any other literal) instead of
        actually calling importlib.metadata."""
        sentinel = "9.9.9.dev999+sentinel-not-a-real-version"
        with mock.patch("importlib.metadata.version",
                         return_value=sentinel) as mock_version:
            axi = _import_fresh("crucible_axi")
            self.assertEqual(
                axi.__version__, sentinel,
                "expected __version__ to reflect the mocked "
                "importlib.metadata.version() result, not a hardcoded "
                "literal")
        mock_version.assert_called_once_with("crucible-axi")


class ServerNpmPackageMatchesPackageJsonNameTest(unittest.TestCase):
    """S1 cross-stack check (AC) -- `crucible_axi.install.SERVER_NPM_PACKAGE`
    equals the `name` field read from the repo's package.json, so the two
    stacks cannot silently drift apart again."""

    def test_server_npm_package_constant_equals_package_json_name_field(self):
        install = _import_fresh("crucible_axi.install")
        with open(PACKAGE_JSON_PATH, encoding="utf-8") as f:
            package_json = json.load(f)

        self.assertEqual(
            install.SERVER_NPM_PACKAGE, package_json["name"],
            f"crucible_axi.install.SERVER_NPM_PACKAGE "
            f"({install.SERVER_NPM_PACKAGE!r}) must equal package.json's "
            f"\"name\" field ({package_json['name']!r})")

    def test_server_npm_package_constant_is_no_longer_the_todo_s4_placeholder(self):
        """Negative/bound path -- the old TODO(S4) placeholder value must be
        gone; guards against a GREEN that leaves the stale constant in place
        while satisfying the equality check some other, unintended way."""
        install = _import_fresh("crucible_axi.install")
        self.assertNotEqual(install.SERVER_NPM_PACKAGE, "crucible-server")


class ServerStageNpxArgvVersionPinTest(unittest.TestCase):
    """S6 -- the [server] stage's npx argv is VERSION-PINNED to
    `<SERVER_NPM_PACKAGE>@<crucible_axi.__version__>` by default, and to
    `<SERVER_NPM_PACKAGE>@<CRUCIBLE_SERVER_VERSION>` when that env var is
    set -- never a bare package name, never "latest"."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-version-pin-")
        self._saved_override = os.environ.get("CRUCIBLE_SERVER_VERSION")
        os.environ.pop("CRUCIBLE_SERVER_VERSION", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved_override is None:
            os.environ.pop("CRUCIBLE_SERVER_VERSION", None)
        else:
            os.environ["CRUCIBLE_SERVER_VERSION"] = self._saved_override

    def _run_server_stage(self, install):
        with mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                           return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                           return_value=False):
            mock_run.return_value.returncode = 0
            install._server_stage(self.tmp, False)
        return mock_run

    def test_server_stage_npx_argv_pins_to_own_version_when_override_unset(self):
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        mock_run = self._run_server_stage(install)

        argv = _server_npx_argv(mock_run)
        self.assertIsNotNone(
            argv, f"expected an npx argv list, calls={mock_run.call_args_list}")
        expected_pin = f"{install.SERVER_NPM_PACKAGE}@{axi.__version__}"
        self.assertIn(
            expected_pin, argv,
            f"expected {expected_pin!r} as a single argv token, got {argv}")
        self.assertNotIn(
            install.SERVER_NPM_PACKAGE, argv,
            "the bare, unpinned package name must not appear as a "
            "standalone argv token")
        self.assertFalse(
            any("latest" in str(token) for token in argv),
            f"argv must never resolve to 'latest': {argv}")

    def test_server_stage_npx_argv_uses_crucible_server_version_env_override_when_set(self):
        install = _import_fresh("crucible_axi.install")
        os.environ["CRUCIBLE_SERVER_VERSION"] = "3.4.5-override-test"
        mock_run = self._run_server_stage(install)

        argv = _server_npx_argv(mock_run)
        self.assertIsNotNone(
            argv, f"expected an npx argv list, calls={mock_run.call_args_list}")
        expected_pin = f"{install.SERVER_NPM_PACKAGE}@3.4.5-override-test"
        self.assertIn(
            expected_pin, argv,
            f"expected the CRUCIBLE_SERVER_VERSION override to win: "
            f"{expected_pin!r} not found in argv {argv}")
        self.assertFalse(
            any("latest" in str(token) for token in argv),
            f"argv must never resolve to 'latest': {argv}")


if __name__ == "__main__":
    unittest.main()
