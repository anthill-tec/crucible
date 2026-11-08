"""The installer ships the declaration schema beside the clients and lists it.

`clients/crucible-declaration.schema.json` is the machine-readable statement of
every stack's Crucible declaration. A writer outside the clients finds it
through the install, so the install owes three things:

  - LAY-DOWN. The `[fleet]` stage lays the packaged file down at
    `<target-dir>/clients/crucible-declaration.schema.json`, byte-equal to the
    packaged copy. A re-install over an older or different copy overwrites it.
    An uninstall leaves it, like every fleet file: uninstall has no fleet stage.
  - MANIFEST. `crucible-clients.json` lists it as
    `declaration_schema: {"path": <that path>, "version": <int>}`. The version
    is read from the PACKAGED SOURCE copy (`manifest.source_clients_dir()`, the
    one `[fleet]` copies), so `build_manifest(<empty dir>)` still works with no
    installed fleet.
  - FAIL-FAST. A packaged schema that is missing, is not JSON, or has no integer
    `version` fails the install, naming the packaged path. Which stage fails is
    pinned by where the file is first needed:
      * missing: the `[fleet]` stage, because the schema is a packaged fleet
        file and `[fleet]` already refuses a missing source by naming it;
      * not JSON, or no integer `version`: the `[manifest]` stage, because it is
        the stage that READS the version (`build_manifest`). `[fleet]` copies
        bytes and has no reason to parse them.
    In neither case is `crucible-clients.json` written.

Every test owns a scratch root under `/tmp` holding `$HOME`, `$XDG_DATA_HOME`,
`$BUN_INSTALL` and `--target-dir`. The `[server]` and `[unit]` stages are
stubbed in both directions; `[fleet]`, `[manifest]`, `[config]` and `[store]`
are real. A bad schema is only ever a stand-in packaged dir in the scratch root;
the repo's own file is never edited.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_installer_ships_the_declaration_schema
"""

import contextlib
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
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

SCHEMA_NAME = "crucible-declaration.schema.json"
PACKAGED_SCHEMA = REPO_ROOT / "clients" / SCHEMA_NAME
MANIFEST_KEY = "declaration_schema"
STAGE_FAILED_CODE = "stage-failed"


def _stub_stage(name):
    """A stage runner that does nothing and reports a converged row."""

    def _runner(target_dir, _switch=False, **_kwargs):
        return {"path": os.path.join(target_dir, name), "converged": True}

    return _runner


@contextlib.contextmanager
def _patched_env(**overrides):
    with mock.patch.dict(os.environ, {}, clear=False):
        for key, value in overrides.items():
            os.environ[key] = value
        yield


def _packaged_version():
    return json.loads(PACKAGED_SCHEMA.read_text(encoding="utf-8"))["version"]


class _SchemaInstallCase(unittest.TestCase):

    def setUp(self):
        self.install = importlib.import_module("crucible_axi.install")
        self.manifest = self.install.manifest
        self.root = tempfile.mkdtemp(prefix="declaration-schema-install-", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.target_dir = os.path.join(self.root, "target")
        self.env = {
            "HOME": os.path.join(self.root, "home"),
            "XDG_DATA_HOME": os.path.join(self.root, "xdg"),
            "BUN_INSTALL": os.path.join(self.root, "bun"),
            "CRUCIBLE_NO_SERVICE": "1",
            "CRUCIBLE_NO_BUN_BOOTSTRAP": "1",
        }
        for key in ("HOME", "XDG_DATA_HOME", "BUN_INSTALL"):
            os.makedirs(self.env[key], exist_ok=True)
        self.installed_schema = os.path.join(self.target_dir, "clients", SCHEMA_NAME)
        self.manifest_file = os.path.join(self.target_dir, self.manifest.MANIFEST_FILENAME)

    def _stubs(self, table):
        return {name: _stub_stage(name) for name in ("server", "unit") if name in table}

    def run_install(self, force=False):
        with _patched_env(**self.env), mock.patch.dict(
                self.install.DEFAULT_STAGE_RUNNERS,
                self._stubs(self.install.DEFAULT_STAGE_RUNNERS)):
            return self.install.run_install(self.target_dir, force=force, no_service=True,
                                            no_bun_bootstrap=True)

    def install_once(self, force=False):
        ok, stages, warnings = self.run_install(force=force)
        self.assertTrue(ok, f"the install must succeed; warnings={warnings} stages={stages}")
        return stages

    def uninstall_once(self, purge):
        with _patched_env(**self.env), mock.patch.dict(
                self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                self._stubs(self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS)):
            ok, stages, warnings = self.install.run_uninstall(self.target_dir, purge=purge)
        self.assertTrue(ok, f"the uninstall must complete; warnings={warnings} stages={stages}")
        return stages

    def stand_in_packaged_dir(self, schema_text=None):
        """A copy of the packaged fleet under the scratch root. `schema_text`
        replaces the schema's bytes; `None` removes the schema altogether."""
        packaged = os.path.join(self.root, "packaged")
        shutil.copytree(self.manifest.source_clients_dir(), packaged,
                        ignore=shutil.ignore_patterns("__pycache__"))
        schema = os.path.join(packaged, SCHEMA_NAME)
        if schema_text is None:
            if os.path.exists(schema):
                os.remove(schema)
        else:
            Path(schema).write_text(schema_text, encoding="utf-8")
        return packaged

    def assert_installed_schema_is_the_packaged_one(self, why):
        self.assertTrue(os.path.isfile(self.installed_schema),
                        f"{why}: no schema at {self.installed_schema}; clients/ holds "
                        f"{sorted(os.listdir(os.path.dirname(self.installed_schema))) if os.path.isdir(os.path.dirname(self.installed_schema)) else None}")
        self.assertEqual(PACKAGED_SCHEMA.read_bytes(), Path(self.installed_schema).read_bytes(),
                         f"{why}: the installed schema must be byte-equal to the packaged file")


class TheInstallLaysTheSchemaDownTest(_SchemaInstallCase):

    def test_an_install_lays_the_schema_down_beside_the_clients_byte_equal_to_the_packaged_file(self):
        self.install_once()
        self.assert_installed_schema_is_the_packaged_one("an install")
        self.assertEqual(
            os.path.join(self.target_dir, "clients", "python-crucible.py"),
            os.path.join(os.path.dirname(self.installed_schema), "python-crucible.py"),
            "the schema sits in the same directory as the clients")

    def test_the_fleet_stage_owns_the_schema_as_a_packaged_fleet_file(self):
        self.assertIn(SCHEMA_NAME, self.install.FLEET_FILES)
        self.assertEqual(1, list(self.install.FLEET_FILES).count(SCHEMA_NAME))

    def test_an_upgrade_overwrites_an_older_installed_schema(self):
        self.install_once()
        older = json.dumps({"version": 0, "stacks": {}}) + "\n"
        Path(self.installed_schema).write_text(older, encoding="utf-8")
        stages = self.install_once()
        self.assert_installed_schema_is_the_packaged_one("a re-install over an older copy")
        fleet = [row for row in stages if row["name"] == "fleet"]
        self.assertEqual(1, len(fleet), f"stages={stages}")
        self.assertFalse(fleet[0]["converged"],
                         "replacing a stale schema is a change, so [fleet] is not converged")

    def test_a_plain_uninstall_leaves_the_installed_schema(self):
        self.install_once()
        self.uninstall_once(purge=False)
        self.assert_installed_schema_is_the_packaged_one("after a plain uninstall")

    def test_a_purge_uninstall_leaves_the_installed_schema(self):
        self.install_once()
        self.uninstall_once(purge=True)
        self.assertFalse(os.path.exists(self.manifest_file),
                         "fixture check: the purge ran its real [config] stage")
        self.assert_installed_schema_is_the_packaged_one(
            "after a purge uninstall (uninstall has no fleet stage)")


class TheManifestListsTheSchemaTest(_SchemaInstallCase):

    def test_the_installed_manifest_lists_the_schema_path_and_its_integer_version(self):
        self.install_once()
        document = json.loads(Path(self.manifest_file).read_text(encoding="utf-8"))
        self.assertIn(MANIFEST_KEY, document, f"manifest keys={sorted(document)}")
        listed = document[MANIFEST_KEY]
        self.assertEqual({"path": self.installed_schema, "version": _packaged_version()}, listed)
        self.assertIs(type(listed["version"]), int)

    def test_the_listed_path_round_trips_to_the_listed_version(self):
        self.install_once()
        listed = json.loads(Path(self.manifest_file).read_text(encoding="utf-8")).get(MANIFEST_KEY)
        self.assertIsInstance(listed, dict, f"declaration_schema={listed!r}")
        on_disk = json.loads(Path(listed["path"]).read_text(encoding="utf-8"))
        self.assertEqual(on_disk["version"], listed["version"])

    def test_build_manifest_reads_the_version_with_no_installed_fleet(self):
        empty = os.path.join(self.root, "empty")
        os.makedirs(empty)
        document = self.manifest.build_manifest(empty)
        self.assertEqual(
            {"path": os.path.join(empty, "clients", SCHEMA_NAME), "version": _packaged_version()},
            document.get(MANIFEST_KEY))
        self.assertEqual([], os.listdir(empty), "build_manifest writes nothing")

    def test_the_version_comes_from_the_packaged_copy_not_a_constant(self):
        packaged = self.stand_in_packaged_dir(json.dumps({"version": 7, "stacks": {}}))
        empty = os.path.join(self.root, "empty")
        os.makedirs(empty)
        with mock.patch.object(self.manifest, "source_clients_dir", return_value=packaged):
            document = self.manifest.build_manifest(empty)
        self.assertEqual(7, (document.get(MANIFEST_KEY) or {}).get("version"),
                         f"declaration_schema={document.get(MANIFEST_KEY)!r}")

    def test_the_version_comes_from_the_packaged_copy_not_the_installed_one(self):
        os.makedirs(os.path.dirname(self.installed_schema))
        Path(self.installed_schema).write_text(json.dumps({"version": 99}), encoding="utf-8")
        document = self.manifest.build_manifest(self.target_dir)
        self.assertEqual(_packaged_version(), (document.get(MANIFEST_KEY) or {}).get("version"),
                         f"declaration_schema={document.get(MANIFEST_KEY)!r}")


class AMalformedPackagedSchemaFailsFastTest(_SchemaInstallCase):

    MALFORMED = (
        ("not JSON", '{"version": 1,'),
        ("no version", json.dumps({"stacks": {}})),
        ("a string version", json.dumps({"version": "1", "stacks": {}})),
        ("a fractional version", json.dumps({"version": 1.5, "stacks": {}})),
        ("a boolean version", json.dumps({"version": True, "stacks": {}})),
        ("not an object", json.dumps([1])),
    )

    def build_manifest_with(self, packaged):
        empty = os.path.join(self.root, "empty")
        os.makedirs(empty, exist_ok=True)
        with mock.patch.object(self.manifest, "source_clients_dir", return_value=packaged):
            return self.manifest.build_manifest(empty)

    def test_build_manifest_refuses_a_missing_packaged_schema_naming_its_path(self):
        packaged = self.stand_in_packaged_dir(None)
        with self.assertRaises(Exception) as caught:
            self.build_manifest_with(packaged)
        self.assertIn(os.path.join(packaged, SCHEMA_NAME), str(caught.exception))

    def test_build_manifest_refuses_a_malformed_packaged_schema_naming_its_path(self):
        for label, text in self.MALFORMED:
            with self.subTest(label):
                shutil.rmtree(os.path.join(self.root, "packaged"), ignore_errors=True)
                packaged = self.stand_in_packaged_dir(text)
                with self.assertRaises(Exception) as caught:
                    self.build_manifest_with(packaged)
                self.assertIn(os.path.join(packaged, SCHEMA_NAME), str(caught.exception))

    def install_against(self, packaged):
        with mock.patch.object(self.manifest, "source_clients_dir", return_value=packaged):
            return self.run_install()

    def assert_failed_in(self, stage, packaged, ok, stages, warnings):
        self.assertFalse(ok, f"stages={stages} warnings={warnings}")
        failures = [w for w in warnings if w.get("code") == STAGE_FAILED_CODE]
        self.assertEqual(1, len(failures), f"warnings={warnings}")
        detail = failures[0]["detail"]
        self.assertTrue(detail.startswith(f"{stage} stage failed"), detail)
        self.assertIn(os.path.join(packaged, SCHEMA_NAME), detail)
        self.assertNotIn("manifest", [row["name"] for row in stages])
        self.assertFalse(os.path.exists(self.manifest_file),
                         "no manifest is written over a bad packaged schema")

    def test_a_missing_packaged_schema_fails_the_fleet_stage_naming_its_path(self):
        packaged = self.stand_in_packaged_dir(None)
        ok, stages, warnings = self.install_against(packaged)
        self.assert_failed_in("fleet", packaged, ok, stages, warnings)

    def test_a_packaged_schema_that_is_not_json_fails_the_manifest_stage_naming_its_path(self):
        packaged = self.stand_in_packaged_dir('{"version": 1,')
        ok, stages, warnings = self.install_against(packaged)
        self.assert_failed_in("manifest", packaged, ok, stages, warnings)
        self.assertIn("fleet", [row["name"] for row in stages])

    def test_a_packaged_schema_with_no_integer_version_fails_the_manifest_stage(self):
        packaged = self.stand_in_packaged_dir(json.dumps({"version": "1", "stacks": {}}))
        ok, stages, warnings = self.install_against(packaged)
        self.assert_failed_in("manifest", packaged, ok, stages, warnings)


if __name__ == "__main__":
    unittest.main()
