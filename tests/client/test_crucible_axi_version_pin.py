"""CR-CRU-041 C1 -- composite release strategy: one repo, two artifacts, ONE
version (S6) + the S1 SERVER_NPM_PACKAGE / package.json cross-stack check.

Contract pinned from docs/changes/CR-CRU-041-release-mechanism.md:

    S6 -- `crucible_axi.__version__` resolves via
          `importlib.metadata.version("crucible-axi")` (never a hardcoded
          literal). The `[server]` stage's server argv is VERSION-PINNED:
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
("crucible"), and the `[server]` stage's server argv carries the bare
`SERVER_NPM_PACKAGE` with no version suffix at all -- always resolving to
`latest`. Every test below either fails a plain assertion or raises
AttributeError accessing the not-yet-existing `crucible_axi.__version__` --
a missing-SUT-symbol error, valid RED per the sub-agent procedure (never
skipped).

CR-CRU-066 §S1 supersedes the SHAPE of that argv, not the pin: the `[server]`
stage no longer RUNS the published bin via `npx` -- it PROVISIONS and returns
via `bun add -g <SERVER_NPM_PACKAGE>@<version>`. Every version-pin contract
asserted below is unchanged; only the argv the matcher looks for moved (the
CR-CRU-041 wording above is kept as the historical record).

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


def _server_provision_argv(mock_run):
    """Return the raw argv LIST of the [server] stage's PROVISION
    subprocess.run call -- the `bun add -g <pkg>@<version>` invocation
    (CR-CRU-066 §S1) -- or None if no such call was recorded / it wasn't a
    list-form call. Matching on the leading `bun add -g` tokens deliberately
    EXCLUDES the shell-form curl Bun-bootstrap call, so the bun-absent case
    still isolates the provision argv. Returning the token list (not
    flattened text) gives a stronger assertion than a substring check on
    flattened text (catches a bare package-name token sitting ALONGSIDE a
    correctly pinned one, which a substring check on joined text would
    miss)."""
    for call in mock_run.call_args_list:
        args = call.args[0] if call.args else call.kwargs.get("args")
        if not isinstance(args, (list, tuple)):
            continue
        if [str(a) for a in args[:3]] == ["bun", "add", "-g"]:
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


class ServerStageProvisionArgvVersionPinTest(unittest.TestCase):
    """S6 -- the [server] stage's provision argv is VERSION-PINNED to
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

    def test_server_stage_provision_argv_pins_to_own_version_when_override_unset(self):
        """Uses a realistic INSTALLED-RELEASE version (patched), not the live
        `crucible_axi.__version__` -- in a source checkout the live value IS
        the `_SOURCE_CHECKOUT_VERSION` sentinel, which is a separate,
        dedicated contract covered by
        ServerStageFailsFastOnUnresolvedVersionTest. This test's job is the
        own-version pin behaviour for a genuine installed release."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        with mock.patch.object(axi, "__version__", "0.1.0"):
            mock_run = self._run_server_stage(install)

        argv = _server_provision_argv(mock_run)
        self.assertIsNotNone(
            argv,
            f"expected a `bun add -g` provision argv list, "
            f"calls={mock_run.call_args_list}")
        expected_pin = f"{install.SERVER_NPM_PACKAGE}@0.1.0"
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

    def test_server_stage_provision_argv_uses_crucible_server_version_env_override_when_set(self):
        install = _import_fresh("crucible_axi.install")
        os.environ["CRUCIBLE_SERVER_VERSION"] = "3.4.5-override-test"
        mock_run = self._run_server_stage(install)

        argv = _server_provision_argv(mock_run)
        self.assertIsNotNone(
            argv,
            f"expected a `bun add -g` provision argv list, "
            f"calls={mock_run.call_args_list}")
        expected_pin = f"{install.SERVER_NPM_PACKAGE}@3.4.5-override-test"
        self.assertIn(
            expected_pin, argv,
            f"expected the CRUCIBLE_SERVER_VERSION override to win: "
            f"{expected_pin!r} not found in argv {argv}")
        self.assertFalse(
            any("latest" in str(token) for token in argv),
            f"argv must never resolve to 'latest': {argv}")


class ServerStageFailsFastOnUnresolvedVersionTest(unittest.TestCase):
    """S6 in-cycle addition -- the [server] stage FAILS FAST with a
    definitive, actionable error when the resolved version is the
    source-checkout fallback (`crucible_axi.__version__ ==
    _SOURCE_CHECKOUT_VERSION`, i.e. crucible-axi is not installed) AND
    `CRUCIBLE_SERVER_VERSION` is unset -- instead of shelling out to Bun
    with an unusable pin like `@anthill-tec/crucible-server@0.0.0.dev0+source`
    (not valid npm semver, so the provision fails with an opaque error).
    Mirrors CR-CRU-039's `no-tests-discovered` pattern: replace a
    silent/masked failure with a definitive error naming its own remedy.

    RED phase: `crucible_axi/install.py`'s `_server_stage` had no such guard
    yet, so it proceeded straight to the server subprocess regardless of
    whether the resolved version is usable -- `assertRaises` fails with
    "did not raise" and/or `mock_run.assert_not_called()` fails because the
    server call already happened.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="crucible-axi-version-guard-")
        self._saved_override = os.environ.get("CRUCIBLE_SERVER_VERSION")
        os.environ.pop("CRUCIBLE_SERVER_VERSION", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved_override is None:
            os.environ.pop("CRUCIBLE_SERVER_VERSION", None)
        else:
            os.environ["CRUCIBLE_SERVER_VERSION"] = self._saved_override

    def test_server_stage_raises_before_any_subprocess_call_when_version_unresolved_and_override_unset(self):
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")

        with mock.patch.object(axi, "__version__", axi._SOURCE_CHECKOUT_VERSION), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                            return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                            return_value=False):
            with self.assertRaises(RuntimeError):
                install._server_stage(self.tmp, False)
            mock_run.assert_not_called()

    def test_unresolved_version_error_message_names_crucible_server_version_as_the_remedy(self):
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")

        with mock.patch.object(axi, "__version__", axi._SOURCE_CHECKOUT_VERSION), \
                mock.patch("crucible_axi.install.subprocess.run"), \
                mock.patch("crucible_axi.install.shutil.which",
                            return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                            return_value=False):
            with self.assertRaises(RuntimeError) as ctx:
                install._server_stage(self.tmp, False)

        self.assertIn(
            "CRUCIBLE_SERVER_VERSION", str(ctx.exception),
            f"expected the remedy env var name in the error message, got: "
            f"{ctx.exception!r}")

    def test_server_stage_proceeds_when_override_set_despite_unresolved_source_checkout_version(self):
        """The guard must not block the documented escape hatch -- setting
        CRUCIBLE_SERVER_VERSION in the exact same source-checkout situation
        lets the stage proceed normally and pins the argv to the override."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")
        os.environ["CRUCIBLE_SERVER_VERSION"] = "7.8.9-escape-hatch-test"

        with mock.patch.object(axi, "__version__", axi._SOURCE_CHECKOUT_VERSION), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                            return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                            return_value=False):
            mock_run.return_value.returncode = 0
            install._server_stage(self.tmp, False)

        argv = _server_provision_argv(mock_run)
        self.assertIsNotNone(
            argv,
            f"expected a `bun add -g` provision argv list, "
            f"calls={mock_run.call_args_list}")
        expected_pin = f"{install.SERVER_NPM_PACKAGE}@7.8.9-escape-hatch-test"
        self.assertIn(
            expected_pin, argv,
            f"expected the escape hatch pin {expected_pin!r} in argv, got {argv}")

    def test_server_stage_proceeds_when_a_real_installed_version_is_resolved(self):
        """The guard must not fire for genuine releases -- a real installed
        __version__ (not the source-checkout sentinel) proceeds normally
        with no override needed."""
        install = _import_fresh("crucible_axi.install")
        axi = _import_fresh("crucible_axi")

        with mock.patch.object(axi, "__version__", "0.1.0"), \
                mock.patch("crucible_axi.install.subprocess.run") as mock_run, \
                mock.patch("crucible_axi.install.shutil.which",
                            return_value="/usr/bin/bun"), \
                mock.patch("crucible_axi.install._server_already_installed",
                            return_value=False):
            mock_run.return_value.returncode = 0
            install._server_stage(self.tmp, False)

        argv = _server_provision_argv(mock_run)
        self.assertIsNotNone(
            argv,
            f"expected a `bun add -g` provision argv list, "
            f"calls={mock_run.call_args_list}")
        expected_pin = f"{install.SERVER_NPM_PACKAGE}@0.1.0"
        self.assertIn(
            expected_pin, argv,
            f"expected {expected_pin!r} in argv, got {argv}")


if __name__ == "__main__":
    unittest.main()
